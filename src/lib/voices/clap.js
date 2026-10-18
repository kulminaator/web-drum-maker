// Clap voice: a parameterized engine patch implementing the clap recipe
// from drum_generation.md —
//
//   clap = three filtered noise bursts — a slap, then two fast re-slaps
//
// "A clap is a hand-slap: three fast re-slaps, each a burst of
// filtered noise" (drum_generation.md, Clap). No pitched body — the
// noise IS the body, high-passed into the 1–3 kHz slap band. The three
// layers use different seeds and slightly different cutoffs so the
// bursts read as three distinct slaps instead of one smeared noise
// (two identical bursts would reinforce/cancel sample-by-sample).
//
// Slap 1 (t = 0): seed 3, cutoff 2.5 kHz, level gate 0 → 1 in 3 ms,
// gone by 15 ms — the downbeat slap.
// Re-slap 2: seed 4, cutoff 2.1 kHz, silent until 14 ms, re-peak at
// 16 ms, gone by 31 ms.
// Re-slap 3: seed 5, cutoff 1.6 kHz, silent until 26 ms, re-peak at
// 29 ms, gone by 47 ms.
// (The re-peak times — 16 / 29 ms — are the recipe's "re-slap at
// ~10–30 ms"; the whole clap is silent again by ~50 ms.)
//
// Each burst's raw noise decays with a 30 ms time constant (the
// `decay` field, src/lib/noise.js); the level gate above is what
// shapes the actual slap length. The 30 ms constant is deliberately
// longer than a single slap so a re-slap is not starved by the burst's
// own exponential before its re-peak: exp(−16/30) ≈ 0.59 and
// exp(−29/30) ≈ 0.38 — with the 0.9 / 0.8 / 0.7 layer gains the
// re-slaps land quieter than the first slap, as in a real hand clap.
//
// The `overrides` argument is in RECIPE shape (not engine-patch shape),
// so presets and the UI can tweak the recipe without knowing the layer
// layout:
//
//   clapPatch()                                        // default recipe
//   clapPatch({ slap2: { cutoff: 3000 } })             // brighter re-slap
//   clapPatch({ slap2: { env: { peak: 0.02 } } })      // re-slap at 20 ms
//   clapPatch({ slap3: { gain: 0.9 } })                // louder third slap
//
// The result is a plain engine patch (src/lib/engine.js schema), so
// `renderPatch(clapPatch(), { sampleRate, duration })` works directly.
// Every call builds fresh arrays (the shared default object below is
// only ever read), so two patches never alias.

// The one slap: silent until `off`, up to full level at `peak` (a
// 2–3 ms re-trigger — a hand clap is near-instantaneous), then a
// collapse over `release` with the same knee shape as levelEnvelope
// (half the release at 25 % of the peak — the exponential-style fall).
// A plain point array (src/lib/envelopes.js data shape): before `off`
// the envelope clamps to the first point's 0, which is the silence
// between slaps — no explicit hold point needed.
const slapEnvelope = ({ off, peak, release }) => [
  { t: off, v: 0 },
  { t: peak, v: 1 },
  { t: peak + release / 2, v: 0.25 },
  { t: peak + release, v: 0 },
];

// Default recipe values — all from the drum_generation.md Clap section
// (see the header comment).
const CLAP_DEFAULTS = {
  // The three slaps, in order. `env` is the level gate's shape in
  // seconds (slapEnvelope); `decay` is the noise burst's own
  // exponential time constant (src/lib/noise.js).
  slap1: {
    seed: 3, // clap's seed choices (see src/lib/noise.js)
    cutoff: 2500, // Hz — the upper slap band (drum_generation.md: 1–4 kHz)
    decay: 0.03, // s — burst time constant (the level gate sets the length)
    gain: 0.9,
    env: { off: 0, peak: 0.003, release: 0.012 }, // gone by 15 ms
  },
  slap2: {
    seed: 4,
    cutoff: 2100, // Hz — a touch darker, so the slaps don't blend
    decay: 0.03,
    gain: 0.8,
    env: { off: 0.014, peak: 0.016, release: 0.015 }, // re-peak at 16 ms
  },
  slap3: {
    seed: 5,
    cutoff: 1600, // Hz — the lowest of the three, the clap's "body" band
    decay: 0.03,
    gain: 0.7,
    env: { off: 0.026, peak: 0.029, release: 0.018 }, // re-peak at 29 ms
  },
};

// Recursive plain-object merge: objects merge key-by-key, everything
// else (numbers, arrays) is replaced by the override value. Never
// mutates its inputs; keys absent from `override` fall back to `base`.
// (Same helper as kick.js / snare.js / tom.js — kept local until the
// voices share more.)
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

// One noise layer from a slap recipe entry (see CLAP_DEFAULTS).
const slapLayer = (slap) => ({
  type: 'noise',
  seed: slap.seed,
  cutoff: slap.cutoff,
  decay: slap.decay,
  gain: slap.gain,
  // The slap's gate: silent until `off`, re-peak at `peak` (the
  // re-slap), gone after `release`. The gate is the clap's shape —
  // the noise's own 30 ms decay only colors it (see the header).
  levelEnv: slapEnvelope(slap.env),
});

// Build the engine patch for the clap recipe, deep-merging `overrides`
// (recipe shape, see header) over CLAP_DEFAULTS.
export const clapPatch = (overrides = {}) => {
  const { slap1, slap2, slap3 } = deepMerge(CLAP_DEFAULTS, overrides);
  return {
    layers: [slapLayer(slap1), slapLayer(slap2), slapLayer(slap3)],
    // No master FX: three differently-seeded bursts at slightly
    // different cutoffs are already dense (drum_generation.md, Clap);
    // the UI's FX controls can add saturation or a resonator body.
    masterEffects: [],
  };
};
