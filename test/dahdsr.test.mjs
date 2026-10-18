// Tests for src/app/dahdsr.js (plan "dahdsr" P3/S1) — the app-tier
// DAHDSR canonical-form helpers:
//
//   dahdsrToPoints / pointsToDahdsr  the canonical 6-point level env
//     and its inverse (the nine scalars);
//   isCanonicalLevel                 the cheap canonical guard;
//   normalizeLevelEnv                legacy level envs -> the closest
//     canonical parameters (landmark fit + decay-curve scan);
//   normalizePitchEnv / -IndexEnv    legacy multi-point pitch /
//     FM-depth envs -> the canonical 2-point snap;
//   normalizePatchEnvelopes          a whole patch adopted into
//     canonical form (clone-first — the input is never mutated);
//   segmentMidValue / midValueToCurve  the bend-dot value mapping and
//     its inverse (bisection over the curve scalar).
//
// Two invariants are the point of the step:
//   ONE MODEL — dahdsrToPoints and the lib's levelEnvelope are the same
//     constructor: their outputs deep-equal bit-for-bit (same
//     cumulative-time expression order, curve keys only when > 0);
//   FAILS LOUDLY — pointsToDahdsr throws on every non-canonical input
//     (a non-canonical level env after P2 is a bug, repo style).
//
// The round-trip identity is exact for DYADIC times (the cumulative
// sums stay in exact binary) and exact to ~1 ulp for realistic times
// (the canonical form stores cumulative t, so a span is a difference of
// rounded sums — the module header documents the limit; 1e-12 is four
// orders of magnitude above the observed worst case 2.2e-16).
//
// NOTE on the legacy knee: the exact 4-point knee is EXACTLY
// representable in the canonical form — the mid-knee becomes the
// sustain point and both legs are linear — so the min-max decay-curve
// scan lands at k = 0 (not the P2/S2 migration's KNEE_CURVE ≈ 0.55,
// which belongs to the constructor migration that kept the FULL decay
// span with sustain = 0 — a different shape). The test below pins the
// exact reproduction and asserts bit-identity against the old knee on
// a dense grid.
//
// Tests are exempt from the app↔lib import boundary (GUIDELINES
// §1.4): this file reaches the library through the facade — the same
// door dahdsr.js itself walks — plus one deep import (KNEE_CURVE, a
// test-only fixture constant not in the closed facade API).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAHDSR_CURVES,
  DAHDSR_PARAMS,
  DAHDSR_TIMES,
  dahdsrToPoints,
  isCanonicalLevel,
  midValueToCurve,
  normalizeIndexEnv,
  normalizeLevelEnv,
  normalizePatchEnvelopes,
  normalizePitchEnv,
  pointsToDahdsr,
  segmentMidValue,
} from '../src/app/dahdsr.js';
import { envelopeValue, levelEnvelope } from '../src/lib/index.js';
import { KNEE_CURVE } from '../src/lib/envelopes.js';

// Tolerance for the round-trip on realistic (non-dyadic) times: the
// canonical form stores cumulative t, so a span is a difference of
// rounded sums — at most ~2.2e-16 in the worst case measured; 1e-12
// is four orders of magnitude above that and far below any musical
// difference.
const ROUNDTRIP_EPS = 1e-12;

// Compares the keys PRESENT in expected (the fitted decayCurve is
// checked separately where the scan chooses it).
const assertParamsNear = (actual, expected, eps = ROUNDTRIP_EPS) => {
  for (const key of Object.keys(expected))
    assert.ok(
      Math.abs(actual[key] - expected[key]) < eps,
      `${key}: ${actual[key]} !~ ${expected[key]}`,
    );
};

// Dyadic times: exact in binary, and their cumulative sums (<= ~2 s,
// steps >= 2^-6) stay exact — the round-trip is bit-exact on this grid.
const DYADIC = [0, 1 / 64, 1 / 16, 1 / 4];
// Realistic times on the knob's 0.0005 s grid (inexact in binary).
const REALISTIC = [0, 0.0005, 0.01, 0.1, 0.3, 0.5];
// The legacy 4-point knee, verbatim from the pre-P2 constructor
// (src/lib/envelopes.js at 8705528): mid knee at half the decay time
// and 25 % of the level.
const knee = (attack, decay, level = 1) => [
  { t: 0, v: 0 },
  { t: attack, v: level },
  { t: attack + decay / 2, v: 0.25 * level },
  { t: attack + decay, v: 0 },
];

// ---- parameter lists --------------------------------------------------

test('the parameter lists are the six times/sustain and the three curves', () => {
  assert.deepEqual(DAHDSR_TIMES, ['delay', 'attack', 'hold', 'decay', 'release']);
  assert.deepEqual(DAHDSR_PARAMS, [
    'delay',
    'attack',
    'hold',
    'decay',
    'sustain',
    'release',
  ]);
  assert.deepEqual(DAHDSR_CURVES, ['attackCurve', 'decayCurve', 'releaseCurve']);
});

// ---- round-trip identity ----------------------------------------------

test('pointsToDahdsr(dahdsrToPoints(p)) is the identity (dyadic grid, bit-exact)', () => {
  let count = 0;
  for (const delay of DYADIC)
    for (const attack of DYADIC)
      for (const hold of DYADIC)
        for (const decay of DYADIC)
          for (const release of DYADIC)
            for (const sustain of [0, 0.25, 1])
              for (const attackCurve of [0, 1])
                for (const decayCurve of [0, 1])
                  for (const releaseCurve of [0, 1]) {
                    const p = {
                      delay,
                      attack,
                      hold,
                      decay,
                      sustain,
                      release,
                      attackCurve,
                      decayCurve,
                      releaseCurve,
                    };
                    assert.deepEqual(pointsToDahdsr(dahdsrToPoints(p)), p);
                    count++;
                  }
  // 4^5 spans x 3 sustains x 2^3 curves — includes every degenerate
  // combination (every span individually 0, and all spans 0 at once).
  assert.equal(count, 4 ** 5 * 3 * 8);
});

test('the round-trip is exact to ~1 ulp for realistic times', () => {
  let count = 0;
  for (const delay of REALISTIC)
    for (const attack of REALISTIC)
      for (const hold of REALISTIC)
        for (const decay of REALISTIC)
          for (const release of REALISTIC)
            for (const sustain of [0, 0.5])
              for (const [ac, dc, rc] of [
                [0, 0, 0],
                [0.01, 0.55, 1],
              ]) {
                const p = {
                  delay,
                  attack,
                  hold,
                  decay,
                  sustain,
                  release,
                  attackCurve: ac,
                  decayCurve: dc,
                  releaseCurve: rc,
                };
                assertParamsNear(pointsToDahdsr(dahdsrToPoints(p)), p);
                count++;
              }
  assert.ok(count > 30000);
});

test('dahdsrToPoints deep-equals the lib levelEnvelope (one model)', () => {
  // The two constructors must agree EXACTLY (bit-identical cumulative
  // times, curve keys only when > 0) — the app helper and the lib
  // constructor are one model.
  for (const delay of DYADIC)
    for (const attack of DYADIC)
      for (const hold of DYADIC)
        for (const decay of DYADIC)
          for (const release of DYADIC)
            for (const sustain of [0, 1])
              for (const [ac, dc, rc] of [
                [0, 0, 0],
                [0.01, 0.55, 1],
                [1, 1, 1],
              ]) {
                const p = {
                  delay,
                  attack,
                  hold,
                  decay,
                  sustain,
                  release,
                  attackCurve: ac,
                  decayCurve: dc,
                  releaseCurve: rc,
                };
                assert.deepEqual(dahdsrToPoints(p), levelEnvelope(p));
              }
  // Realistic values too — the agreement does not depend on the
  // input being dyadic (same expression order, same rounding).
  for (const p of [
    { attack: 0.005, decay: 0.3 },
    {
      delay: 0.05,
      attack: 0.005,
      hold: 0.1,
      decay: 0.2,
      sustain: 0.3,
      release: 0.05,
      attackCurve: 0.01,
      decayCurve: 0.55,
      releaseCurve: 1,
    },
    { attack: 0, decay: 0 },
    { delay: 0, attack: 0, hold: 0, decay: 0, sustain: 0, release: 0 },
  ])
    assert.deepEqual(dahdsrToPoints(p), levelEnvelope(p));
});

// ---- pointsToDahdsr: fails loudly on non-canonical --------------------

const canonicalFixture = () =>
  dahdsrToPoints({
    delay: 0.05,
    attack: 0.01,
    hold: 0.1,
    decay: 0.2,
    sustain: 0.3,
    release: 0.05,
    decayCurve: 0.55,
  });

const mutate = (fn) => {
  const copy = JSON.parse(JSON.stringify(canonicalFixture()));
  fn(copy);
  return copy;
};

test('pointsToDahdsr throws on a non-canonical level env (each failure mode)', () => {
  const CANONICAL = /canonical/;
  // Wrong length.
  assert.throws(() => pointsToDahdsr(mutate((c) => c.pop())), CANONICAL); // 5
  assert.throws(
    () => pointsToDahdsr(mutate((c) => c.push({ t: 1, v: 0 }))),
    CANONICAL,
  ); // 7
  assert.throws(() => pointsToDahdsr([]), CANONICAL); // 0
  assert.throws(() => pointsToDahdsr(null), CANONICAL);
  assert.throws(() => pointsToDahdsr('nope'), CANONICAL);
  // Wrong value pattern 0 / 0 / 1 / 1 / s / 0 (s is the only free slot).
  assert.throws(() => pointsToDahdsr(mutate((c) => { c[0].v = 0.1; })), CANONICAL);
  assert.throws(() => pointsToDahdsr(mutate((c) => { c[1].v = 0.5; })), CANONICAL);
  assert.throws(() => pointsToDahdsr(mutate((c) => { c[2].v = 0.9; })), CANONICAL);
  assert.throws(() => pointsToDahdsr(mutate((c) => { c[3].v = 0.7; })), CANONICAL);
  assert.throws(() => pointsToDahdsr(mutate((c) => { c[5].v = 0.2; })), CANONICAL);
  // The sustain slot is free (any finite value).
  assert.doesNotThrow(() => pointsToDahdsr(mutate((c) => { c[4].v = 1.2; })));
  // Unsorted t.
  assert.throws(
    () =>
      pointsToDahdsr(
        mutate((c) => {
          const t = c[1].t;
          c[1].t = c[2].t + 0.1;
          c[2].t = t;
        }),
      ),
    CANONICAL,
  );
  // The first point must sit at t = 0.
  assert.throws(() => pointsToDahdsr(mutate((c) => { c[0].t = 0.01; })), CANONICAL);
  // Negative t.
  assert.throws(() => pointsToDahdsr(mutate((c) => { c[0].t = -0.01; })), CANONICAL);
  // Non-finite values.
  assert.throws(() => pointsToDahdsr(mutate((c) => { c[4].v = NaN; })), CANONICAL);
  assert.throws(() => pointsToDahdsr(mutate((c) => { c[2].t = Infinity; })), CANONICAL);
  // A curve key off the three bend points (indices 1 / 3 / 4).
  assert.throws(() => pointsToDahdsr(mutate((c) => { c[0].curve = 0.5; })), CANONICAL);
  assert.throws(() => pointsToDahdsr(mutate((c) => { c[2].curve = 0.5; })), CANONICAL);
  assert.throws(() => pointsToDahdsr(mutate((c) => { c[5].curve = 0.5; })), CANONICAL);
});

test('isCanonicalLevel is the cheap guard (true on canonical, false on every failure mode)', () => {
  assert.equal(isCanonicalLevel(canonicalFixture()), true);
  assert.equal(
    isCanonicalLevel(dahdsrToPoints({ attack: 0.005, decay: 0.3 })),
    true,
  );
  assert.equal(isCanonicalLevel(null), false);
  assert.equal(isCanonicalLevel([]), false);
  assert.equal(isCanonicalLevel(mutate((c) => c.pop())), false);
  assert.equal(isCanonicalLevel(mutate((c) => { c[0].v = 0.1; })), false);
  assert.equal(isCanonicalLevel(mutate((c) => { c[2].v = 0.9; })), false);
  assert.equal(isCanonicalLevel(mutate((c) => { c[5].v = 0.2; })), false);
  assert.equal(
    isCanonicalLevel(
      mutate((c) => {
        const t = c[1].t;
        c[1].t = c[2].t + 0.1;
        c[2].t = t;
      }),
    ),
    false,
  );
  assert.equal(isCanonicalLevel(mutate((c) => { c[0].t = 0.01; })), false);
  assert.equal(isCanonicalLevel(mutate((c) => { c[0].curve = 0.5; })), false);
});

// ---- normalizeLevelEnv --------------------------------------------------

test('normalizeLevelEnv: a canonical input passes through as-is', () => {
  const points = levelEnvelope({
    delay: 0.05,
    attack: 0.005,
    hold: 0.1,
    decay: 0.2,
    sustain: 0.3,
    release: 0.05,
    decayCurve: KNEE_CURVE,
  });
  assert.equal(normalizeLevelEnv(points), points); // same reference
});

test('normalizeLevelEnv: the exact legacy 4-point knee reproduces bit-identically', () => {
  // The knee is exactly representable: the mid-knee becomes the sustain
  // point, both legs stay linear — so the fit recovers
  // decay = release = decay/2, sustain = 0.25, and the min-max scan
  // lands at k = 0 (NOT the migration's KNEE_CURVE ≈ 0.55 — that
  // constant belongs to the P2/S2 constructor migration, which kept
  // the FULL decay span with sustain = 0 and bent it instead of
  // splitting it — a different shape, see the module/test headers).
  const old = knee(0.005, 0.3);
  const norm = normalizeLevelEnv(old);
  assert.ok(isCanonicalLevel(norm));
  const p = pointsToDahdsr(norm);
  assertParamsNear(p, {
    delay: 0,
    attack: 0.005,
    hold: 0,
    decay: 0.15,
    sustain: 0.25,
    release: 0.15,
    attackCurve: 0,
    decayCurve: 0,
    releaseCurve: 0,
  });
  // Bit-identity against the old envelope on a dense grid, including
  // the exact breakpoints and the clamp regions.
  let maxDiff = 0;
  for (let i = 0; i <= 4096; i++) {
    const t = (i * 0.305) / 4096;
    maxDiff = Math.max(maxDiff, Math.abs(envelopeValue(norm, t) - envelopeValue(old, t)));
  }
  for (const t of [-0.01, 0, 0.005, 0.155, 0.305, 1])
    assert.equal(envelopeValue(norm, t), envelopeValue(old, t), `t = ${t}`);
  assert.equal(maxDiff, 0);
  // The decay-leg midpoint is the old knee's value at the same time
  // (the "midpoint within tolerance" property — here exact).
  assert.equal(envelopeValue(norm, 0.005 + 0.15 / 2), envelopeValue(old, 0.005 + 0.15 / 2));
});

test('normalizeLevelEnv: a knee with level < 1 fits the landmarks (lossy level rescale)', () => {
  // The old constructor's `level` parameter: peak below 1.0. The
  // canonical form fixes the peak at 1.0 (the layer gain is the level
  // knob), so the fit is lossy in LEVEL — the landmarks are still
  // exact and every parameter stays in range.
  const old = knee(0.01, 0.4, 0.8);
  const p = pointsToDahdsr(normalizeLevelEnv(old));
  assertParamsNear(p, {
    delay: 0,
    attack: 0.01,
    hold: 0,
    decay: 0.2,
    sustain: 0.2,
    release: 0.2,
    attackCurve: 0,
    decayCurve: 0,
    releaseCurve: 0,
  });
  assert.ok(p.decayCurve >= 0 && p.decayCurve <= 1);
});

test('normalizeLevelEnv: a clap-like slap (leading silence, t0 > 0) fits delay from the data', () => {
  // Clap's hand-written slapEnvelope (src/lib/voices/clap.js): a 4-point
  // knee that STARTS at the slap offset — the plan's grounding note
  // expects delay ≈ 0.016 and sustain ≈ 0.25 for slap 2.
  const off = 0.016, attack = 0.003, release = 0.012;
  const old = [
    { t: off, v: 0 },
    { t: off + attack, v: 1 },
    { t: off + attack + release / 2, v: 0.25 },
    { t: off + attack + release, v: 0 },
  ];
  const p = pointsToDahdsr(normalizeLevelEnv(old));
  assertParamsNear(p, {
    delay: off,
    attack,
    hold: 0,
    decay: release / 2,
    sustain: 0.25,
    release: release / 2,
    attackCurve: 0,
    decayCurve: 0,
    releaseCurve: 0,
  });
});

test('normalizeLevelEnv: an envelope that never falls to 0 keeps the last value (release = 0)', () => {
  const old = [
    { t: 0, v: 0 },
    { t: 0.01, v: 1 },
    { t: 0.2, v: 0.4 },
  ];
  const norm = normalizeLevelEnv(old);
  const p = pointsToDahdsr(norm);
  assertParamsNear(p, {
    delay: 0,
    attack: 0.01,
    hold: 0,
    decay: 0.19,
    sustain: 0.4,
    release: 0,
    attackCurve: 0,
    decayCurve: 0,
    releaseCurve: 0,
  });
  // The fit is exact up to the decay end (both envelopes are the same
  // linear 1 -> 0.4 leg; the cumulative t of the canonical form may sit
  // a ulp off the legacy breakpoint, so assert to ~1 ulp).
  let maxDiff = 0;
  for (let i = 0; i < 512; i++) {
    const t = (i * 0.2) / 512; // [0, T)
    maxDiff = Math.max(maxDiff, Math.abs(envelopeValue(norm, t) - envelopeValue(old, t)));
  }
  assert.ok(maxDiff < ROUNDTRIP_EPS, `max diff up to the decay end ${maxDiff}`);
  // AT the decay end the release = 0 zero-length rule makes the
  // canonical form drop to silence (the P2/S2 "instant silence" rule),
  // while the legacy holds its last value at the point.
  assert.equal(envelopeValue(norm, 0.2), 0);
  assert.equal(envelopeValue(old, 0.2), 0.4);
  // Beyond the decay end the canonical form is SILENT — its last point
  // is always (T, 0): a one-shot ringing at a non-zero level forever is
  // inexpressible in the canonical model, so the fit (the closest
  // canonical form) cuts off the legacy's trailing hold.
  assert.equal(envelopeValue(norm, 0.201), 0);
  assert.equal(envelopeValue(old, 0.201), 0.4);
});

test('normalizeLevelEnv: an all-zero envelope is the silent canonical form', () => {
  const old = [
    { t: 0.016, v: 0 },
    { t: 0.1, v: 0 },
  ];
  const norm = normalizeLevelEnv(old);
  assert.ok(isCanonicalLevel(norm));
  assertParamsNear(pointsToDahdsr(norm), {
    delay: 0,
    attack: 0,
    hold: 0,
    decay: 0,
    sustain: 0,
    release: 0,
    attackCurve: 0,
    decayCurve: 0,
    releaseCurve: 0,
  });
  // Renders EXACTLY zero everywhere (the engine's clamp hides the
  // zero-length peak) — faithful to the silent input.
  for (let t = 0; t <= 0.2; t += 0.01) assert.equal(envelopeValue(norm, t), 0);
});

test('normalizeLevelEnv: a double-peak shape fits deterministically, all parameters in range', () => {
  // A hand-crafted non-canonical double peak: the fit is a LOSSY
  // projection (it keeps the FIRST peak, the sustain level, and the
  // end point) — assert stability and properties, not a specific
  // exotic shape.
  const old = [
    { t: 0, v: 0 },
    { t: 0.05, v: 1 },
    { t: 0.1, v: 0.4 },
    { t: 0.2, v: 1 },
    { t: 0.35, v: 0.2 },
    { t: 0.5, v: 0 },
  ];
  const norm = normalizeLevelEnv(old);
  assert.ok(isCanonicalLevel(norm));
  const p = pointsToDahdsr(norm);
  // The landmarks are exact by construction (the decayCurve is NOT in
  // the expectation — the scan chooses it).
  assertParamsNear(p, {
    delay: 0,
    attack: 0.05,
    hold: 0,
    decay: 0.3,
    sustain: 0.2,
    release: 0.15,
    attackCurve: 0,
    releaseCurve: 0,
  });
  // The fitted decayCurve is in [0, 1] ...
  assert.ok(p.decayCurve >= 0 && p.decayCurve <= 1, `decayCurve ${p.decayCurve} out of range`);
  // Deterministic: the same input always fits the same canonical form.
  assert.deepEqual(normalizeLevelEnv(old), norm);
  assert.deepEqual(pointsToDahdsr(normalizeLevelEnv(old)), p);
  // The input array is untouched.
  assert.deepEqual(old, [
    { t: 0, v: 0 },
    { t: 0.05, v: 1 },
    { t: 0.1, v: 0.4 },
    { t: 0.2, v: 1 },
    { t: 0.35, v: 0.2 },
    { t: 0.5, v: 0 },
  ]);
});

test('normalizeLevelEnv throws on empty or non-finite input', () => {
  assert.throws(() => normalizeLevelEnv([]), /non-empty/);
  assert.throws(() => normalizeLevelEnv(null), /non-empty/);
  assert.throws(() => normalizeLevelEnv([{ t: 0, v: NaN }, { t: 1, v: 0 }]), /finite/);
});

// ---- normalizePitchEnv / normalizeIndexEnv ------------------------------

test('normalizePitchEnv / normalizeIndexEnv: 2-point inputs pass through as-is', () => {
  const pitch = [{ t: 0, v: 100 }, { t: 0.3, v: 50 }];
  const index = [{ t: 0, v: 8 }, { t: 0.02, v: 0 }];
  assert.equal(normalizePitchEnv(pitch), pitch);
  assert.equal(normalizeIndexEnv(index), index);
});

test('normalizePitchEnv / normalizeIndexEnv: a multi-point legacy collapses to the endpoint-faithful 2-point snap', () => {
  const legacy = [
    { t: 0.02, v: 100 },
    { t: 0.1, v: 80 },
    { t: 0.3, v: 50 },
  ];
  const snap = normalizePitchEnv(legacy);
  assert.deepEqual(snap, [
    { t: 0, v: 100 },
    { t: 0.3, v: 50 },
  ]);
  // Endpoint-faithful: the start value is the value at the trigger,
  // and the last value is held forever by the clamp.
  assert.equal(envelopeValue(snap, 0), 100);
  assert.equal(envelopeValue(snap, 0.3), 50);
  assert.equal(envelopeValue(snap, 10), 50);
  // The input is untouched.
  assert.equal(legacy.length, 3);

  const legacyIndex = [
    { t: 0.01, v: 5 },
    { t: 0.05, v: 2 },
    { t: 0.2, v: 0 },
  ];
  assert.deepEqual(normalizeIndexEnv(legacyIndex), [
    { t: 0, v: 5 },
    { t: 0.2, v: 0 },
  ]);
});

test('normalizePitchEnv / normalizeIndexEnv: a 1-point legacy is a constant snap', () => {
  assert.deepEqual(normalizeIndexEnv([{ t: 0.2, v: 4 }]), [
    { t: 0, v: 4 },
    { t: 0.2, v: 4 },
  ]);
});

test('normalizePitchEnv / normalizeIndexEnv throw on empty or non-finite input', () => {
  assert.throws(() => normalizePitchEnv([]), /non-empty/);
  assert.throws(() => normalizeIndexEnv([{ t: 0, v: NaN }]), /finite/);
});

// ---- normalizePatchEnvelopes --------------------------------------------

test('normalizePatchEnvelopes: clone-first, normalizes every nested envelope', () => {
  const canonicalIndex = [{ t: 0, v: 8 }, { t: 0.02, v: 0 }];
  const legacyPitch = [
    { t: 0, v: 100 },
    { t: 0.05, v: 70 },
    { t: 0.3, v: 50 },
  ];
  const legacyIndex = [
    { t: 0.01, v: 5 },
    { t: 0.05, v: 2 },
    { t: 0.2, v: 0 },
  ];
  const patch = {
    layers: [
      {
        type: 'fm',
        carrier: { freq: 50 },
        pitchEnv: legacyPitch,
        modulators: [
          { freq: 200, index: 8, indexEnv: canonicalIndex },
          { freq: 300, index: 3, indexEnv: legacyIndex },
        ],
        gain: 1,
        levelEnv: knee(0.005, 0.3),
        effects: [],
      },
      {
        type: 'noise',
        seed: 1,
        cutoff: 5000,
        decay: 0.05,
        gain: 0.5,
        levelEnv: knee(0.001, 0.05),
        effects: [],
      },
    ],
    masterEffects: [],
  };
  const before = JSON.parse(JSON.stringify(patch));

  const out = normalizePatchEnvelopes(patch);

  // A NEW patch; the input is never mutated (GUIDELINES §3).
  assert.notEqual(out, patch);
  assert.deepEqual(patch, before);
  // Every layer's levelEnv is canonical (the knees adopted: sustain
  // 0.25, decay/release split).
  assert.ok(isCanonicalLevel(out.layers[0].levelEnv));
  assert.ok(isCanonicalLevel(out.layers[1].levelEnv));
  const level = pointsToDahdsr(out.layers[0].levelEnv);
  assert.ok(Math.abs(level.sustain - 0.25) < ROUNDTRIP_EPS);
  // The FM layer's pitchEnv snapped to the endpoints...
  assert.deepEqual(out.layers[0].pitchEnv, [
    { t: 0, v: 100 },
    { t: 0.3, v: 50 },
  ]);
  // ...and modulator 2's indexEnv too, while modulator 1's canonical
  // indexEnv carries over BY REFERENCE (the pass-through).
  assert.deepEqual(out.layers[0].modulators[1].indexEnv, [
    { t: 0, v: 5 },
    { t: 0.2, v: 0 },
  ]);
  assert.equal(out.layers[0].modulators[0].indexEnv, canonicalIndex);
  // Untouched fields carry over by reference (no deep rebuild).
  assert.equal(out.layers[0].carrier, patch.layers[0].carrier);
  assert.equal(out.masterEffects, patch.masterEffects);
});

test('normalizePatchEnvelopes: an already-canonical patch round-trips byte-identical', () => {
  // The P3/S3 export -> import stability property: canonical data never
  // goes through the lossy fit, and its arrays carry over by reference.
  const patch = {
    layers: [
      {
        type: 'fm',
        carrier: { freq: 50 },
        pitchEnv: [{ t: 0, v: 100 }, { t: 0.3, v: 50 }],
        modulators: [
          { freq: 200, index: 8, indexEnv: [{ t: 0, v: 8 }, { t: 0.02, v: 0 }] },
        ],
        gain: 1,
        levelEnv: levelEnvelope({ attack: 0.005, decay: 0.3, decayCurve: KNEE_CURVE }),
        effects: [],
      },
    ],
    masterEffects: [],
  };
  const out = normalizePatchEnvelopes(patch);
  assert.notEqual(out, patch);
  assert.deepEqual(out, patch);
  assert.equal(out.layers[0].levelEnv, patch.layers[0].levelEnv);
  assert.equal(out.layers[0].pitchEnv, patch.layers[0].pitchEnv);
  assert.equal(out.layers[0].modulators[0].indexEnv, patch.layers[0].modulators[0].indexEnv);
});

test('normalizePatchEnvelopes throws on a patch without a layers array', () => {
  assert.throws(() => normalizePatchEnvelopes({}), /layers/);
  assert.throws(() => normalizePatchEnvelopes(null), /layers/);
});

// ---- the bend-dot value mapping ------------------------------------------

// k0 grid for the round-trip: the whole 0…1 curve scale in 0.01 steps.
const K_GRID = Array.from({ length: 101 }, (_, k) => k / 100);

// A canonical env whose three bend segments are all non-degenerate:
// the attack RISES 0 -> 1, the decay FALLS 1 -> 0.3, the release
// FALLS 0.3 -> 0.
const bendBase = () =>
  dahdsrToPoints({
    delay: 0,
    attack: 0.01,
    hold: 0.02,
    decay: 0.2,
    sustain: 0.3,
    release: 0.05,
  });

test('midValueToCurve recovers k on a grid (round-trip with segmentMidValue)', () => {
  // For each k0 and each bend segment: the midpoint of the k0-bent
  // segment maps back to k0 (the midpoint is strictly monotone in k,
  // so the bisection's root is unique).
  for (const k0 of K_GRID) {
    const points = bendBase();
    points[1].curve = k0; // attack (0 -> 1 rise)
    points[3].curve = k0; // decay (1 -> 0.3 fall)
    points[4].curve = k0; // release (0.3 -> 0 fall)
    for (const i of [1, 3, 4]) {
      const mid = segmentMidValue(points, i);
      const k = midValueToCurve(points, i, mid);
      assert.ok(
        Math.abs(k - k0) < 1e-9,
        `segment ${i}: k0 = ${k0} recovered ${k}`,
      );
    }
  }
});

test('midValueToCurve: the clamp boundaries (chord midpoint -> 0, max-bend midpoint -> 1)', () => {
  const base = bendBase();
  // Decay segment: a = (0.01, 1), b = (0.21, 0.3) — chord midpoint
  // 0.65, the k = 1 midpoint sags toward the (lower) end value.
  const decayK1 = bendBase();
  decayK1[3].curve = 1;
  const decayMid1 = segmentMidValue(decayK1, 3);
  assert.ok(decayMid1 > 0.3 && decayMid1 < 0.65);
  assert.equal(midValueToCurve(base, 3, 0.65), 0); // AT the chord midpoint
  assert.equal(midValueToCurve(base, 3, 0.9), 0); // ABOVE it
  assert.equal(midValueToCurve(base, 3, decayMid1), 1); // AT the k = 1 midpoint
  assert.equal(midValueToCurve(base, 3, 0.3), 1); // the end value (below it)
  assert.equal(midValueToCurve(base, 3, 0), 1); // far below

  // Attack segment: a = (0, 0), b = (0.01, 1) — chord midpoint 0.5,
  // the k = 1 midpoint sits just above the START value (the bend's
  // "all the way down" position): start value and below -> 1.
  const attackK1 = bendBase();
  attackK1[1].curve = 1;
  const attackMid1 = segmentMidValue(attackK1, 1);
  assert.ok(attackMid1 > 0 && attackMid1 < 0.5);
  assert.equal(midValueToCurve(base, 1, 0.5), 0); // AT the chord midpoint
  assert.equal(midValueToCurve(base, 1, 1), 0); // ABOVE it (the end value)
  assert.equal(midValueToCurve(base, 1, attackMid1), 1); // AT the k = 1 midpoint
  assert.equal(midValueToCurve(base, 1, 0), 1); // the start value

  // A flat segment: the midpoint is the constant value for every k —
  // at/above -> 0, below -> 1 (the bend is inert there).
  const flat = [
    { t: 0, v: 0.5 },
    { t: 0.2, v: 0.5 },
  ];
  assert.equal(midValueToCurve(flat, 0, 0.5), 0);
  assert.equal(midValueToCurve(flat, 0, 0.6), 0);
  assert.equal(midValueToCurve(flat, 0, 0.4), 1);
});

test('segmentMidValue / midValueToCurve: the input points are never mutated', () => {
  const base = bendBase();
  const before = JSON.parse(JSON.stringify(base));
  segmentMidValue(base, 3);
  midValueToCurve(base, 3, 0.5);
  assert.deepEqual(base, before);
});

test('segmentMidValue / midValueToCurve fail loudly on bad segments', () => {
  const base = bendBase();
  // The last point has no outgoing segment (its curve would be inert).
  assert.throws(() => segmentMidValue(base, 5), /segment index/);
  assert.throws(() => midValueToCurve(base, 5, 0.5), /segment index/);
  assert.throws(() => midValueToCurve(base, -1, 0.5), /segment index/);
  assert.throws(() => segmentMidValue(base, 0.5), /segment index/);
  assert.throws(() => midValueToCurve(base, 3, NaN), /finite number/);
  assert.throws(() => midValueToCurve([], 0, 0.5), /non-empty/);
});
