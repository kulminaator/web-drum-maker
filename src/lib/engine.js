// Patch renderer: the engine entry point that turns a plain-object patch
// into a rendered hit — a Float32Array of exactly
// round(duration · sampleRate) samples (GUIDELINES §3: pure, deterministic,
// no module-level state; the same patch always renders byte-identically).
// Also exports isolateLayer, a pure single-layer copy of a patch for the
// UI's per-layer waveform views (ui-refresh.md §8 step 3).
//
// Patch schema (plain objects, no classes):
//
//   patch = {
//     layers: [
//       { type: 'fm',
//         carrier:    { freq, shape? },        // base carrier frequency (Hz);
//                                              // shape: wave shape of the
//                                              // operator's sample (osc.js
//                                              // shapeSample) — 'sine' |
//                                              // 'square' | 'saw' | 'triangle',
//                                              // default 'sine'
//         pitchEnv:   points,                  // carrier Hz(t); optional —
//                                              // constant `freq` if omitted
//         modulators: [{ freq, index,          // at most 4 (src/lib/fm.js)
//                        indexEnv: points,     // index(t); optional —
//                                              // constant `index` if omitted
//                        feedback?, ring?, modulates?,
//                        shape? }],            // wave shape of the operator's
//                                              // sample (osc.js shapeSample);
//                                              // when omitted the operator is
//                                              // a sine — every pre-existing
//                                              // patch renders byte-identically
//         gain,                                // layer level in the mix; default 1
//         levelEnv: points,                    // one-shot level envelope;
//                                              // optional — unity if omitted
//         effects: [fx, ...] },                // applied after levelEnv, in order
//       { type: 'noise',
//         seed, cutoff, decay,                 // filteredNoiseBurst (src/lib/noise.js)
//         gain, levelEnv: points, effects: [fx, ...] },
//     ],
//     masterEffects: [fx, ...],                // applied to the mix, in order
//   }
//
//   fx = { type: 'saturate', drive }
//      | { type: 'highpass', cutoff }          // cutoff in Hz
//      | { type: 'resonate', freq, q }         // freq in Hz
//      | { type: 'compress', threshold, ratio,
//          attack, release, makeup }           // attack/release in SECONDS —
//                                              // converted to samples here,
//                                              // since src/lib/effects.js works
//                                              // in samples (step 8 note)
//
//   `points` is a sorted [{t, v}] array in seconds from src/lib/envelopes.js
//   (levelEnvelope / pitchEnvelope / fmDepthEnvelope constructors).
//
// Signal path:
//   per layer:  source (renderFmLayer / filteredNoiseBurst)
//               → layer level envelope (sample-varying gain)
//               → layer effect chain, in order
//   then:       mixLayers with per-layer gains (pattern 1, no interaction)
//               → masterEffects, in order
//               → final hard clamp to ±1
//
// The final clamp is the one stage that guarantees |out| ≤ 1 for every
// patch: legitimate effects can exceed it on their own (resonator peak
// gain = Q, high-pass gain rises toward Nyquist, compress makeup > 1),
// and the bounded-output test relies on this backstop. A non-finite
// sample at that point means a bad parameter slipped through, so it
// throws instead of shipping NaN/Infinity.

import { envelopeValue } from './envelopes.js';
import { renderFmLayer } from './fm.js';
import { WAVE_SHAPES } from './osc.js';
import { filteredNoiseBurst } from './noise.js';
import { mixLayers } from './layer.js';
import { compress, highpass, resonate, saturate } from './effects.js';

// Compressor timing defaults for patches that omit them (e.g. the snare
// voice specifies only threshold/ratio/makeup): 10 ms attack / 100 ms
// release. The attack must track the crest of a drum hit without smearing
// it (step 8: slow followers invert the PAR reduction), and the release
// must fill the gaps between a low carrier's cycles; at 8 kHz these are
// 80 / 800 samples.
const COMPRESS_DEFAULTS = { attack: 0.01, release: 0.1, makeup: 1 };

// Descriptive parameter validation: a bad patch value must fail loudly
// here (or at the final finiteness backstop), never as silent NaN audio.
const requireNumber = (value, what, positive = false) => {
  const ok = Number.isFinite(value) && (!positive || value > 0);
  if (!ok)
    throw new Error(
      `renderPatch: ${what} must be ${positive ? 'a positive' : 'a finite'} number, got ${value}`,
    );
};

// requireShape: absent (undefined) is legal — the operator defaults to a
// sine and every pre-existing patch renders byte-identically. A present
// value must be in the closed WAVE_SHAPES enum (osc.js), or it fails
// loudly the same way requireNumber does.
const requireShape = (value, what) => {
  if (value === undefined) return;
  if (!WAVE_SHAPES.includes(value))
    throw new Error(
      `renderPatch: ${what} must be one of sine / square / saw / triangle, got ${JSON.stringify(value)}`,
    );
};

// Dispatch one effect object (see schema above) onto a buffer.
const applyEffect = (buffer, fx, sampleRate) => {
  switch (fx?.type) {
    case 'saturate':
      requireNumber(fx.drive, 'saturate drive', true);
      return saturate(buffer, fx.drive);
    case 'highpass':
      requireNumber(fx.cutoff, 'highpass cutoff', true);
      if (fx.cutoff >= sampleRate / 2)
        throw new Error(
          `renderPatch: highpass cutoff ${fx.cutoff} Hz must be < sr/2 (${sampleRate / 2} Hz)`,
        );
      return highpass(buffer, fx.cutoff, sampleRate);
    case 'resonate':
      requireNumber(fx.freq, 'resonate freq', true);
      if (fx.freq >= sampleRate / 2)
        throw new Error(
          `renderPatch: resonate freq ${fx.freq} Hz must be < sr/2 (${sampleRate / 2} Hz)`,
        );
      requireNumber(fx.q, 'resonate q', true);
      return resonate(buffer, fx.freq, fx.q, sampleRate);
    case 'compress': {
      // Patch-level units are seconds; effects.js works in samples.
      const toSamples = (sec) =>
        sec <= 0 ? 0 : Math.max(1, Math.round(sec * sampleRate));
      if (fx.attack !== undefined) requireNumber(fx.attack, 'compress attack');
      if (fx.release !== undefined) requireNumber(fx.release, 'compress release');
      return compress(buffer, {
        threshold: fx.threshold,
        ratio: fx.ratio,
        attack: toSamples(fx.attack ?? COMPRESS_DEFAULTS.attack),
        release: toSamples(fx.release ?? COMPRESS_DEFAULTS.release),
        makeup: fx.makeup ?? COMPRESS_DEFAULTS.makeup,
      });
    }
    default:
      throw new Error(
        `renderPatch: unknown effect type ${JSON.stringify(fx?.type)} (expected saturate / highpass / resonate / compress)`,
      );
  }
};

// Translate an 'fm' layer into the src/lib/fm.js spec. The only translation
// is envelope points → per-sample hooks: fm.js stays envelope-agnostic, so a
// missing pitchEnv/indexEnv simply falls back to the constant there. The
// optional operator shapes pass through untranslated — fm.js is
// shape-tolerant via its own 'sine' default.
const fmLayerSpec = (layer) => ({
  carrier: {
    freq: layer.carrier.freq,
    freqAt: layer.pitchEnv
      ? (t) => envelopeValue(layer.pitchEnv, t)
      : undefined,
    shape: layer.carrier.shape,
  },
  modulators: (layer.modulators ?? []).map((m) => ({
    freq: m.freq,
    index: m.index,
    indexAt: m.indexEnv ? (t) => envelopeValue(m.indexEnv, t) : undefined,
    feedback: m.feedback,
    ring: m.ring,
    modulates: m.modulates,
    shape: m.shape,
  })),
});

// Render one layer's source (no envelope, no effects yet) into `length`
// samples, validating the layer shape on the way.
const renderLayerSource = (layer, length, sr) => {
  if (layer.type === 'fm') {
    requireNumber(layer.carrier?.freq, 'fm carrier.freq');
    requireShape(layer.carrier?.shape, 'fm carrier shape');
    (layer.modulators ?? []).forEach((m, i) => {
      requireNumber(m.freq, `fm modulator ${i} freq`);
      requireNumber(m.index, `fm modulator ${i} index`);
      requireShape(m.shape, `fm modulator ${i} shape`);
    });
    return renderFmLayer(fmLayerSpec(layer), length, sr);
  }
  if (layer.type === 'noise') {
    requireNumber(layer.seed, 'noise seed');
    requireNumber(layer.cutoff, 'noise cutoff', true);
    if (layer.cutoff >= sr / 2)
      throw new Error(
        `renderPatch: noise cutoff ${layer.cutoff} Hz must be < sr/2 (${sr / 2} Hz)`,
      );
    requireNumber(layer.decay, 'noise decay', true);
    return filteredNoiseBurst({
      length,
      sr,
      seed: layer.seed,
      cutoff: layer.cutoff,
      decay: layer.decay,
    });
  }
  throw new Error(
    `renderPatch: unknown layer type ${JSON.stringify(layer.type)} (expected "fm" or "noise")`,
  );
};

// Render a whole patch (see schema in the header).
export const renderPatch = (patch, { sampleRate, duration }) => {
  requireNumber(sampleRate, 'sampleRate', true);
  requireNumber(duration, 'duration', true);
  if (!Array.isArray(patch?.layers))
    throw new Error('renderPatch: patch.layers must be an array');

  const length = Math.round(duration * sampleRate);

  // 1. Per layer: source → level envelope → layer effect chain.
  const buffers = patch.layers.map((layer) => {
    let buffer = renderLayerSource(layer, length, sampleRate);
    if (layer.levelEnv) {
      const env = layer.levelEnv;
      const shaped = new Float32Array(length);
      for (let n = 0; n < length; n++)
        shaped[n] = buffer[n] * envelopeValue(env, n / sampleRate);
      buffer = shaped;
    }
    for (const fx of layer.effects ?? [])
      buffer = applyEffect(buffer, fx, sampleRate);
    return buffer;
  });

  // 2. Linear mix with per-layer gains (interaction pattern 1).
  const gains = patch.layers.map((l) => l.gain ?? 1);
  let out = mixLayers(buffers, gains);

  // 3. Master effects, then the final hard clamp (the bound guarantee
  //    documented in the header), doubling as a finiteness backstop.
  for (const fx of patch.masterEffects ?? [])
    out = applyEffect(out, fx, sampleRate);
  const clamped = new Float32Array(length);
  for (let n = 0; n < length; n++) {
    const s = out[n];
    if (!Number.isFinite(s))
      throw new Error(
        `renderPatch: sample ${n} is not finite — check layer/effect parameters`,
      );
    clamped[n] = Math.min(1, Math.max(-1, s));
  }
  return clamped;
};

// Per-layer views (ui-refresh.md §8 step 3): a single-layer copy of
// `patch` so the UI can render one oscillator source on its own canvas.
// Pure patch manipulation — it returns a NEW wrapper object and never
// mutates `patch` (the live-patch contract: a viz helper must not leak
// side effects into the patch the UI is editing); the layer itself is
// shared by reference, which is safe because renderPatch only reads it.
// masterEffects are deliberately dropped: the layer's own effect chain
// still applies (renderPatch's per-layer path — source → levelEnv →
// layer effects), and the master chain only shapes the finished mix,
// not a single layer.
export const isolateLayer = (patch, i) => {
  if (!Array.isArray(patch?.layers))
    throw new Error('isolateLayer: patch.layers must be an array');
  if (!Number.isInteger(i) || i < 0 || i >= patch.layers.length)
    throw new Error(
      `isolateLayer: layer index must be an integer in [0, ${patch.layers.length - 1}], got ${i}`,
    );
  return { layers: [patch.layers[i]], masterEffects: [] };
};
