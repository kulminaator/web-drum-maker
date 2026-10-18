// Kick voice: a parameterized engine patch implementing the kick recipe
// from drum_generation.md —
//
//   kick = FM sine body + short noise click + saturation
//
// Body: 50 Hz carrier with a 100 → 50 Hz pitch drop in 30 ms ("the
// familiar drum thump"), a 200 Hz modulator at index 8 → 0 in 20 ms
// ("FM amount → 0 in 20 ms" — dense attack sidebands collapsing into a
// pure carrier), ~5 ms attack / ~300 ms decay level envelope, gain 0.8.
// Click: filtered noise burst (seed 1, cutoff ~2 kHz, ~20 ms decay),
// gain 0.2 — the "attack click", mixed linearly (interaction pattern 1).
// Master: saturation drive 2 — "FM -> Saturation … more harmonics
// appear, making the sound more aggressive. Industrial and techno kicks
// often use this heavily" (drum_generation.md, Effects section).
//
// The `overrides` argument is in RECIPE shape (not engine-patch shape),
// so presets and the UI can tweak the recipe without knowing the layer
// layout:
//
//   kickPatch()                                   // default recipe
//   kickPatch({ body: { pitchEnv: { to: 30 } } })
//   kickPatch({ click: { gain: 0.4 } })
//
// The result is a plain engine patch (src/lib/engine.js schema), so
// `renderPatch(kickPatch(), { sampleRate, duration })` works directly.
// Every call builds fresh arrays (the shared default object below is
// only ever read), so two patches never alias.

import {
  fmDepthEnvelope,
  KNEE_CURVE,
  levelEnvelope,
  pitchEnvelope,
} from '../envelopes.js';

// Default recipe values — all from the drum_generation.md kick section
// (see the header comment).
const KICK_DEFAULTS = {
  body: {
    carrierFreq: 50, // Hz — the "thump" fundamental
    pitchEnv: { from: 100, to: 50, time: 0.03 }, // 100 → 50 Hz in 30 ms
    modulator: { freq: 200, index: 8, indexDecay: 0.02 }, // 200 Hz, 8 → 0 in 20 ms
    levelEnv: { attack: 0.005, decay: 0.3 }, // ~5 ms attack, ~300 ms decay
    gain: 0.8,
  },
  click: {
    seed: 1, // kick-click seed choice (see src/lib/noise.js)
    cutoff: 2000, // Hz — the click lives in the high "snap" band
    decay: 0.02, // s — the click collapses in ~20 ms
    gain: 0.2,
  },
  saturation: { drive: 2 }, // techno-kick aggression (Effects section)
};

// Recursive plain-object merge: objects merge key-by-key, everything
// else (numbers, arrays) is replaced by the override value. Never
// mutates its inputs; keys absent from `override` fall back to `base`.
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

// Build the engine patch for the kick recipe, deep-merging `overrides`
// (recipe shape, see header) over KICK_DEFAULTS.
export const kickPatch = (overrides = {}) => {
  const { body, click, saturation } = deepMerge(KICK_DEFAULTS, overrides);
  return {
    layers: [
      {
        type: 'fm',
        carrier: { freq: body.carrierFreq },
        pitchEnv: pitchEnvelope(body.pitchEnv),
        modulators: [
          {
            freq: body.modulator.freq,
            index: body.modulator.index,
            // FM-depth collapse: index → 0 in 20 ms (drum_generation.md
            // kick recipe); `to` defaults to 0 in fmDepthEnvelope.
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
        type: 'noise',
        seed: click.seed,
        cutoff: click.cutoff,
        decay: click.decay,
        gain: click.gain,
      },
    ],
    masterEffects: [{ type: 'saturate', drive: saturation.drive }],
  };
};
