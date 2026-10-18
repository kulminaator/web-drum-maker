// Hi-hat voice: a parameterized engine patch implementing the hi-hat
// recipe from drum_generation.md —
//
//   hi-hat = six oscillators at inharmonic ratios → high-pass → fast decay
//
// "Several square waves at 1.000 / 1.231 / 1.342 / 2.103 / 3.487 /
// 5.119 (Yamaha OPL chips, TR-909 style digital hats) mixed together
// create dense beating. Then: high-pass filter, fast decay envelope. The
// result resembles metallic noise" (drum_generation.md, Hi-Hats).
//
// POC approximation (documented deviation — synced in drum_generation.md
// at step 17): the classic recipe uses SQUARE waves, but the engine's fm
// layers output sine carriers (plan step 12 keeps the engine unchanged —
// no 'osc' layer type). Each partial is therefore one carrier-only fm
// layer: no modulators, and a carrier with index 0 is a pure sine
// (Chowning eq. 1). The six layers are mixed linearly (interaction
// pattern 1) at the same inharmonic ratios. Sines at those ratios plus
// the high-pass and the fast staggered decay give the same "dense
// beating → high-passed metallic noise" character: the beating comes
// from the inharmonic spread, and the high-pass's rising upper-band gain
// plays the part the square waves' odd harmonics play in the classic
// recipe.
//
// Base frequency 4000 Hz: the top partial is 4000 × 5.119 ≈ 20.48 kHz,
// under the 24 kHz Nyquist of the 48 kHz base rate (it would alias at
// the 22.05 kHz export tier — the documented low-tier trade).
// Per-layer level envelope: ~1 ms attack, ~80 ms decay, staggered
// ±stagger/2 across the layers (70–90 ms at the defaults, the highest
// partial ringing longest) so the six partials release slightly out of
// phase — the metallic tail of a real hat.
// Master: one-pole high-pass at ~8 kHz — at 48 kHz the lower three
// partials (4.0–5.4 kHz) pass at −9…−12 dB and the upper three
// (8.4–20.5 kHz) at −5…+5 dB, so the metallic "sss" lives in the
// upper band.
//
// The `overrides` argument is in RECIPE shape (not engine-patch shape),
// so presets and the UI can tweak the recipe without knowing the layer
// layout:
//
//   hihatPatch()                                      // default recipe
//   hihatPatch({ baseFreq: 5000 })                    // shift all partials
//   hihatPatch({ levelEnv: { decay: 0.16 } })         // longer hat
//
// The result is a plain engine patch (src/lib/engine.js schema), so
// `renderPatch(hihatPatch(), { sampleRate, duration })` works directly.
// Every call builds fresh arrays (the shared default object below is
// only ever read), so two patches never alias.

import { KNEE_CURVE, levelEnvelope } from '../envelopes.js';

// Default recipe values — from the drum_generation.md Hi-Hats section
// (see the header comment).
const HIHAT_DEFAULTS = {
  baseFreq: 4000, // Hz; top partial = baseFreq × 5.119 ≈ 20.48 kHz < 24 kHz Nyquist @ 48 kHz
  // Yamaha OPL / TR-909 inharmonic ratios (drum_generation.md, Hi-Hats).
  ratios: [1.000, 1.231, 1.342, 2.103, 3.487, 5.119],
  levelEnv: {
    attack: 0.001, // ~1 ms — the beater's hit
    decay: 0.08, // ~80 ms nominal per-layer decay
    // Stagger: per-layer decays spread over ±stagger/2 (70–90 ms at the
    // defaults) so the partials don't release in unison.
    stagger: 0.02,
  },
  gain: 0.15, // per layer; six in-phase crests ≈ 0.9 before the high-pass
  highpass: 8000, // Hz — the recipe's "high-pass filter"
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

// Build the engine patch for the hi-hat recipe, deep-merging `overrides`
// (recipe shape, see header) over HIHAT_DEFAULTS.
export const hihatPatch = (overrides = {}) => {
  const { baseFreq, ratios, levelEnv, gain, highpass } =
    deepMerge(HIHAT_DEFAULTS, overrides);
  const n = ratios.length;
  return {
    layers: ratios.map((ratio, i) => {
      // Staggered per-layer decay (see defaults comment): the highest
      // partial (i = n − 1) rings longest.
      const frac = n > 1 ? i / (n - 1) - 0.5 : 0;
      const decay = levelEnv.decay + levelEnv.stagger * frac;
      return {
        type: 'fm',
        carrier: { freq: baseFreq * ratio },
        // No modulator: a carrier with index 0 is a pure sine (Chowning
        // eq. 1) — the POC stand-in for the recipe's square wave (see
        // header comment).
        modulators: [],
        gain,
        levelEnv: levelEnvelope({
          attack: levelEnv.attack,
          decay,
          // KNEE_CURVE: the exponential decay bend that carries the
          // legacy 4-point knee's sound (src/lib/envelopes.js).
          decayCurve: KNEE_CURVE,
        }),
      };
    }),
    masterEffects: [{ type: 'highpass', cutoff: highpass }],
  };
};
