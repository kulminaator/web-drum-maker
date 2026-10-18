// Cymbal voice: a parameterized engine patch implementing the cymbal
// recipe from drum_generation.md —
//
//   cymbal = four inharmonic FM partials, each with a short FM-depth
//            collapse, ringing for ~1.5 s
//
// The hi-hat's documented approach stretched into a long decay
// (drum_generation.md, Cymbal): several oscillators at inharmonic
// ratios — here 1.000 / 1.338 / 1.782 / 2.514, cymbal MODE ratios
// (the hat's OPL set is 1.000 / 1.231 / 1.342 / 2.103 / 3.487 /
// 5.119) — the inharmonic spread beating into the metallic shimmer,
// and a level decay an order of magnitude longer than the hat's
// ~80 ms: the cymbal's ring.
//
// Base frequency 5000 Hz: the partials are 5.0 / 6.69 / 8.91 / 12.57
// kHz — the top partial sits in the 12–15 kHz cymbal band, and all
// four are well under the 24 kHz Nyquist of the 48 kHz base rate (the
// top partial aliases at the 22.05 kHz export tier — the documented
// low-tier trade). The partial count stays modest (≤ 6 layers — the
// card-row cap is 8): the inharmonic spread, not the count, creates
// the shimmer.
//
// Each partial is an FM layer with one modulator at 1.5 × the carrier
// and a SHORT FM-depth collapse — index 2 → 0 in 20 ms (the kick
// recipe's collapse shape, gentler; drum_generation.md, kick): the
// stick impact is a dense inharmonic sideband burst per partial, and
// after the collapse the partial rings as a pure sine (Chowning eq. 1).
// 1.5:1 (not 2:1) keeps every modulator under the 22 kHz carrier/mod
// range (top: 1.5 × 12.57 kHz = 18.86 kHz), and its half-integer
// sidebands (0.5c / 2.5c / 3.5c …) keep the burst inharmonic — a 2:1
// ratio would emit only odd harmonics of the carrier.
//
// Per-partial level envelope: ~2 ms attack (the beater's hit) /
// ~1.5 s release, the release ending EXACTLY at 1.5 s — the preset's
// default hit duration (src/app/presets.js), so the ring runs the
// full hit: the recipe's natural 1.5–2 s decay is capped by that
// duration (drum_generation.md, Cymbal).
//
// Master: no FX — the 5–12.6 kHz partials ARE the cymbal's bright
// band; the UI's FX controls can add a high-pass or resonator on top.
//
// The `overrides` argument is in RECIPE shape (not engine-patch shape),
// so presets and the UI can tweak the recipe without knowing the layer
// layout:
//
//   cymbalPatch()                                     // default recipe
//   cymbalPatch({ baseFreq: 4000 })                   // darker cymbal
//   cymbalPatch({ ratios: [1.000, 1.338, 1.782] })    // three partials
//   cymbalPatch({ levelEnv: { decay: 1.0 } })         // shorter ring
//
// The result is a plain engine patch (src/lib/engine.js schema), so
// `renderPatch(cymbalPatch(), { sampleRate, duration })` works
// directly. Every call builds fresh arrays (the shared default object
// below is only ever read), so two patches never alias.

import { fmDepthEnvelope, KNEE_CURVE, levelEnvelope } from '../envelopes.js';

// Default recipe values — from the drum_generation.md Cymbal section
// (see the header comment).
const CYMBAL_DEFAULTS = {
  baseFreq: 5000, // Hz — the lowest partial
  // Cymbal mode ratios (drum_generation.md, Cymbal): the top partial
  // is 5000 × 2.514 ≈ 12.57 kHz — the 12–15 kHz cymbal band, under
  // the 24 kHz Nyquist @ 48 kHz.
  ratios: [1.000, 1.338, 1.782, 2.514],
  modRatio: 1.5, // per-partial modulator = 1.5 × carrier (see header)
  fm: {
    index: 2, // FM depth at the stick impact (the kick's 8, gentler)
    time: 0.02, // ~20 ms collapse — the length of the attack burst
  },
  levelEnv: {
    attack: 0.002, // ~2 ms — the beater's hit
    // Release ends at attack + decay = 1.5 s — the preset's default
    // duration (src/app/presets.js), so the ring runs the full hit
    // (the recipe's 1.5–2 s decay capped by that duration).
    decay: 1.498,
  },
  gain: 0.2, // per partial; four in-phase crests ≈ 0.8, headroom before the final ±1 clamp
};

// Recursive plain-object merge: objects merge key-by-key, everything
// else (numbers, arrays) is replaced by the override value. Never
// mutates its inputs; keys absent from `override` fall back to `base`.
// (Same helper as kick.js / snare.js / hihat.js / tom.js / clap.js —
// kept local until the voices share more.)
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

// Build the engine patch for the cymbal recipe, deep-merging `overrides`
// (recipe shape, see header) over CYMBAL_DEFAULTS.
export const cymbalPatch = (overrides = {}) => {
  const { baseFreq, ratios, modRatio, fm, levelEnv, gain } =
    deepMerge(CYMBAL_DEFAULTS, overrides);
  return {
    layers: ratios.map((ratio) => {
      const carrier = baseFreq * ratio;
      return {
        type: 'fm',
        carrier: { freq: carrier },
        // One modulator per partial: the short FM-depth collapse that
        // makes the stick impact a dense inharmonic burst, then a pure
        // ringing sine (see the header comment).
        modulators: [
          {
            freq: modRatio * carrier,
            // Shadowed by indexEnv (engine convention, GUIDELINES §2):
            // the collapse drives the index, the constant is the
            // pre-collapse depth.
            index: fm.index,
            indexEnv: fmDepthEnvelope({ from: fm.index, time: fm.time }),
          },
        ],
        gain,
        levelEnv: levelEnvelope({
          attack: levelEnv.attack,
          decay: levelEnv.decay,
          // KNEE_CURVE: the exponential decay bend that carries the
          // legacy 4-point knee's sound (src/lib/envelopes.js).
          decayCurve: KNEE_CURVE,
        }),
      };
    }),
    // No master FX — see the header comment.
    masterEffects: [],
  };
};
