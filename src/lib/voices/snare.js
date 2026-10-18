// Snare voice: a parameterized engine patch implementing the snare recipe
// from drum_generation.md —
//
//   snare = FM shell + filtered noise burst + resonator
//
// "A snare is partly pitched and partly noise": each physical component
// gets its own source (drum_generation.md, "Why Multiple Oscillators
// Help" — skin resonance, shell resonance, wire rattle, attack).
//
// Body: 180 Hz carrier ("Operator A = drum body") with a 15:1 ratio
// modulator at 2700 Hz ("Operator B = high ratio modulator"). The index
// runs ~12 → 0 in 15 ms — the recipe's "100 % → 0 %" fast FM envelope:
// at index 12 the Bessel power is spread over ~24 dense 2700 Hz-spaced
// sidebands (many aliasing into 1–4 kHz at 8 kHz renders), which is what
// makes the attack "noisy metallic"; when the index collapses the layer
// settles into the 180 Hz skin tone. Level env ~3 ms attack / ~200 ms
// decay.
// Shell: 330 Hz carrier ("mix another operator, carrier 330 Hz, for the
// drum shell resonance") with NO modulator — a pure tone — run through a
// 330 Hz resonator (Q 5). The resonator imposes the drum mode: peak gain
// at center is exactly Q (src/lib/effects.js), so the 330 Hz excitation rings
// at 5× and decays on its own ~150 ms level envelope.
// Wires: filtered noise burst (seed 2, cutoff ~1.5 kHz, ~120 ms decay),
// gain 0.3 — the snare-wire rattle, mixed linearly (interaction pattern 1).
// Master: compression (threshold 0.3, ratio 3, makeup 1.2) —
// "compression emphasizes attack, room tail, resonances, making synthetic
// drums feel more physical" (drum_generation.md, Effects section).
//
// The `overrides` argument is in RECIPE shape (not engine-patch shape),
// so presets and the UI can tweak the recipe without knowing the layer
// layout:
//
//   snarePatch()                                        // default recipe
//   snarePatch({ body: { modulator: { index: 2 } } })
//   snarePatch({ shell: { resonator: { q: 8 } } })
//
// The result is a plain engine patch (src/lib/engine.js schema), so
// `renderPatch(snarePatch(), { sampleRate, duration })` works directly.
// Every call builds fresh arrays (the shared default object below is
// only ever read), so two patches never alias.

import { fmDepthEnvelope, KNEE_CURVE, levelEnvelope } from '../envelopes.js';

// Default recipe values — all from the drum_generation.md snare section
// (see the header comment).
const SNARE_DEFAULTS = {
  body: {
    carrierFreq: 180, // Hz — "drum body" skin resonance
    // 15:1 ratio modulator (drum_generation.md: "Modulator ratio 15:1"
    // on the 180 Hz carrier) at index ~12 — "100 % → 0 %" in 15 ms.
    modulator: { freq: 2700, index: 12, indexDecay: 0.015 },
    levelEnv: { attack: 0.003, decay: 0.2 }, // ~3 ms attack, ~200 ms decay
    gain: 0.6,
  },
  shell: {
    carrierFreq: 330, // Hz — "drum shell resonance"
    resonator: { freq: 330, q: 5 }, // ring the shell mode (peak gain = Q)
    // The stick hits head and shell together: same 3 ms attack as the
    // body, ~150 ms decay (the shell rings slightly longer than the
    // tight body in a real snare, but the wire rattle carries the tail).
    levelEnv: { attack: 0.003, decay: 0.15 },
    gain: 0.15, // pre-resonator level; × Q 5 at center → 0.75 peak
  },
  wires: {
    seed: 2, // snare-wire seed choice (see src/lib/noise.js)
    cutoff: 1500, // Hz — the wire rattle lives in the 1.5 kHz+ band
    decay: 0.12, // s — ~120 ms rattle tail
    gain: 0.3,
  },
  compressor: { threshold: 0.3, ratio: 3, makeup: 1.2 },
};

// Recursive plain-object merge: objects merge key-by-key, everything
// else (numbers, arrays) is replaced by the override value. Never
// mutates its inputs; keys absent from `override` fall back to `base`.
// (Same helper as kick.js — kept local until the voices share more.)
const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const deepMerge = (base, override) => {
  const out = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(override)])) {
    const b = base[key];
    const o = override[key];
    out[key] = isPlainObject(b) && isPlainObject(o) ? deepMerge(b, o) : o ?? b;
  }
  return out;
};

// Build the engine patch for the snare recipe, deep-merging `overrides`
// (recipe shape, see header) over SNARE_DEFAULTS.
export const snarePatch = (overrides = {}) => {
  const { body, shell, wires, compressor } = deepMerge(SNARE_DEFAULTS, overrides);
  return {
    layers: [
      {
        type: 'fm',
        carrier: { freq: body.carrierFreq },
        // No pitch envelope: the recipe gives the body a constant 180 Hz
        // carrier — the transient comes from the FM index collapse.
        modulators: [
          {
            freq: body.modulator.freq,
            index: body.modulator.index,
            // The "100 % → 0 %" fast FM envelope: index → 0 in ~15 ms,
            // dense sideband burst collapsing into the pure 180 Hz tone.
            indexEnv: fmDepthEnvelope({
              from: body.modulator.index,
              time: body.modulator.indexDecay,
            }),
          },
        ],
        gain: body.gain,
        levelEnv: levelEnvelope({
          attack: body.levelEnv.attack,
          decay: body.levelEnv.decay,
          // KNEE_CURVE: the exponential decay bend that carries the
          // legacy 4-point knee's sound (src/lib/envelopes.js).
          decayCurve: KNEE_CURVE,
        }),
      },
      {
        type: 'fm',
        carrier: { freq: shell.carrierFreq },
        // No modulator: the shell is a pure 330 Hz excitation; the
        // resonator below turns it into the ringing shell mode.
        modulators: [],
        gain: shell.gain,
        levelEnv: levelEnvelope({
          attack: shell.levelEnv.attack,
          decay: shell.levelEnv.decay,
          // KNEE_CURVE: the exponential decay bend that carries the
          // legacy 4-point knee's sound (src/lib/envelopes.js).
          decayCurve: KNEE_CURVE,
        }),
        // "FM impulse → resonator bank" (drum_generation.md): the 330 Hz
        // resonator imposes the drum-like shell mode on the excitation.
        effects: [{ type: 'resonate', freq: shell.resonator.freq, q: shell.resonator.q }],
      },
      {
        type: 'noise',
        seed: wires.seed,
        cutoff: wires.cutoff,
        decay: wires.decay,
        gain: wires.gain,
      },
    ],
    masterEffects: [
      {
        type: 'compress',
        threshold: compressor.threshold,
        ratio: compressor.ratio,
        makeup: compressor.makeup,
      },
    ],
  };
};
