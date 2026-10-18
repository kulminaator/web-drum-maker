// Tom voice: a parameterized engine patch implementing the tom recipe
// from drum_generation.md —
//
//   tom = a single FM body, the kick's thump pitched into the mid range
//
// "A tom is a pitched drum: the kick's single FM body, transposed up
// into the mid range" (drum_generation.md, Tom Tom). No click, no
// shell, no master FX — a clean pitched thump between the kick and the
// snare.
//
// Body: 90 Hz carrier with a 140 → 90 Hz pitch drop in 40 ms (the
// familiar drum thump, one register above the kick's 100 → 50 Hz), a
// 270 Hz modulator (3:1 ratio) at index 4 → 0 in 30 ms — the FM-depth
// collapse that turns the dense sideband burst of the attack into the
// pure ringing carrier. The low index (4, vs the kick's 8) keeps the
// burst gentle: the sidebands at 90 ± n·270 Hz (360 / 630 / 900 …) add
// a short "woody" smear, then the layer settles into the 90 Hz tone.
// Level env ~3 ms attack / ~250 ms decay, gain 0.8.
//
// The `overrides` argument is in RECIPE shape (not engine-patch shape),
// so presets and the UI can tweak the recipe without knowing the layer
// layout:
//
//   tomPatch()                                       // default recipe
//   tomPatch({ body: { pitchEnv: { to: 120 } } })    // retune the thump
//   tomPatch({ body: { levelEnv: { decay: 0.5 } } }) // longer ring
//
// The result is a plain engine patch (src/lib/engine.js schema), so
// `renderPatch(tomPatch(), { sampleRate, duration })` works directly.
// Every call builds fresh arrays (the shared default object below is
// only ever read), so two patches never alias.

import {
  fmDepthEnvelope,
  KNEE_CURVE,
  levelEnvelope,
  pitchEnvelope,
} from '../envelopes.js';

// Default recipe values — all from the drum_generation.md Tom Tom
// section (see the header comment).
const TOM_DEFAULTS = {
  body: {
    carrierFreq: 90, // Hz — the mid-range tom fundamental
    pitchEnv: { from: 140, to: 90, time: 0.04 }, // 140 → 90 Hz in 40 ms
    // 3:1 ratio modulator (drum_generation.md: "Modulator: Sine 270 Hz
    // (3:1 ratio)") at index 4 → 0 in 30 ms — the gentle attack burst.
    modulator: { freq: 270, index: 4, indexDecay: 0.03 },
    levelEnv: { attack: 0.003, decay: 0.25 }, // ~3 ms attack, ~250 ms decay
    gain: 0.8,
  },
};

// Recursive plain-object merge: objects merge key-by-key, everything
// else (numbers, arrays) is replaced by the override value. Never
// mutates its inputs; keys absent from `override` fall back to `base`.
// (Same helper as kick.js / snare.js — kept local until the voices
// share more.)
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

// Build the engine patch for the tom recipe, deep-merging `overrides`
// (recipe shape, see header) over TOM_DEFAULTS.
export const tomPatch = (overrides = {}) => {
  const { body } = deepMerge(TOM_DEFAULTS, overrides);
  return {
    layers: [
      {
        type: 'fm',
        carrier: { freq: body.carrierFreq },
        // Pitch drop 140 → 90 Hz in 40 ms (drum_generation.md, Tom
        // Tom) — the envelope shadows carrier.freq (engine convention,
        // GUIDELINES §2), which carries the same 90 Hz rest value.
        pitchEnv: pitchEnvelope(body.pitchEnv),
        modulators: [
          {
            freq: body.modulator.freq,
            index: body.modulator.index,
            // FM-depth collapse: index → 0 in 30 ms (drum_generation.md
            // tom recipe); `to` defaults to 0 in fmDepthEnvelope.
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
    ],
    // No master FX: the tom is a clean pitched thump (drum_generation.md
    // Tom Tom) — the user can add saturation or a resonator in the UI.
    masterEffects: [],
  };
};
