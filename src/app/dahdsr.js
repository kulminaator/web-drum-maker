// The DAHDSR canonical form (plan "dahdsr" P3/S1): the app-tier home of
// the canonical level-envelope model — the six parameters
// (Delay / Attack / Hold / Decay / Sustain / Release) plus the three
// per-segment curve bends — and the math between the scalar form and
// the engine's point form:
//
//   dahdsrToPoints / pointsToDahdsr  the canonical 6-point level env
//     (the same rules as the lib's levelEnvelope constructor — the two
//     constructors are one model; test/dahdsr.test.mjs locks the
//     agreement by deep equality against the facade's levelEnvelope)
//   isCanonicalLevel                 the cheap canonical guard
//   normalizeLevelEnv                legacy (non-canonical) level envs
//     (imported/stored data: the old 4-point knee, free-form shapes,
//     clap's slap arrays) -> the closest canonical parameters
//   normalizePitchEnv / -IndexEnv    legacy multi-point pitch /
//     FM-depth envs -> the canonical 2-point snap
//   normalizePatchEnvelopes          a whole patch adopted into
//     canonical form (clone-first — the input is never mutated, the
//     patch-ops contract)
//   segmentMidValue / midValueToCurve  the bend-dot value mapping: the
//     envelope's value at the midpoint of the segment leaving point i,
//     and its inverse (bisection over the curve scalar) — the P4
//     modal's bend-dot drag maps a vertical pixel drag to a target
//     midpoint value and calls the inverse
//
// App tier, facade-only import (GUIDELINES §1.4(b)): the UI never
// re-derives curve math — it samples the already-exported envelope math
// through the facade's envelopeValue (the band.js precedent), so the
// editor can only ever produce a shape the engine renders. Pure
// functions, no DOM, no state (GUIDELINES §3).

import { envelopeValue } from '../lib/index.js';

// The six DAHDSR parameters in canonical order, and the three
// per-segment curve bends (the segments LEAVING points 1 / 3 / 4 of the
// canonical array — attack / decay / release). DAHDSR_TIMES is the
// subset measured in seconds: sustain is a LEVEL, not a time, and the
// P3/S2 knobs give it its own 0…1 range.
export const DAHDSR_TIMES = ['delay', 'attack', 'hold', 'decay', 'release'];
export const DAHDSR_PARAMS = [
  'delay',
  'attack',
  'hold',
  'decay',
  'sustain',
  'release',
];
export const DAHDSR_CURVES = ['attackCurve', 'decayCurve', 'releaseCurve'];

// The canonical 6-point level envelope (Delay / Attack / Hold / Decay /
// Sustain / Release): always exactly six points with fixed roles, zero
// spans stored as duplicate-t points (the engine's zero-length-segment
// rule resolves them — see src/lib/envelopes.js), the peak fixed at
// 1.0 (the layer's gain is the level knob), and the `curve` keys
// written only when > 0 (absent = the segment's plain linear
// interpolation, the shape-default precedent, GUIDELINES §2).
//
// The lib constructor and this helper must agree EXACTLY —
// test/dahdsr.test.mjs deep-equals the outputs — so the cumulative
// times are built with the same expression order as the lib
// constructor (delay + attack, then + hold, ...), keeping the
// IEEE-754 rounding bit-identical.
export const dahdsrToPoints = ({
  delay = 0,
  attack,
  hold = 0,
  decay,
  sustain = 0,
  release = 0,
  attackCurve = 0,
  decayCurve = 0,
  releaseCurve = 0,
}) => {
  const withCurve = (point, curve) => (curve > 0 ? { ...point, curve } : point);
  return [
    { t: 0, v: 0 },
    withCurve({ t: delay, v: 0 }, attackCurve),
    { t: delay + attack, v: 1 },
    withCurve({ t: delay + attack + hold, v: 1 }, decayCurve),
    withCurve({ t: delay + attack + hold + decay, v: sustain }, releaseCurve),
    { t: delay + attack + hold + decay + release, v: 0 },
  ];
};

// The cheap canonical guard: exactly six points, the value pattern
// 0 / 0 / 1 / 1 / s / 0 (s = the sustain — any finite value),
// non-decreasing t starting at 0, finite values, and a `curve` key
// only on the three bend points (indices 1 / 3 / 4 — the attack /
// decay / release segments). After P2 every level env the app holds is
// canonical, so a "no" here means legacy imported/stored data (or a
// bug) — normalizeLevelEnv adopts it.
export const isCanonicalLevel = (points) => {
  if (!Array.isArray(points) || points.length !== 6) return false;
  const expectedV = [0, 0, 1, 1, null, 0]; // index 4: the sustain, free
  for (let i = 0; i < 6; i++) {
    const p = points[i];
    if (!p || !Number.isFinite(p.t) || !Number.isFinite(p.v) || p.t < 0)
      return false;
    if (i === 0 ? p.t !== 0 : p.t < points[i - 1].t) return false;
    if (expectedV[i] !== null && p.v !== expectedV[i]) return false;
    if (
      'curve' in p &&
      ((i !== 1 && i !== 3 && i !== 4) || !Number.isFinite(p.curve))
    )
      return false;
  }
  return true;
};

// The inverse of dahdsrToPoints: the nine scalars from a canonical
// point array. The spans are point-to-point t differences — the
// canonical form stores CUMULATIVE times, so (delay + attack) - delay
// carries at most an IEEE-754 ulp of rounding for arbitrary inputs
// (exact for dyadic times; test/dahdsr.test.mjs pins both).
//
// Throws on non-canonical input: after P2 a non-canonical level env is
// a bug (or un-migrated legacy data — run normalizeLevelEnv instead),
// and failing loudly is the repo style.
export const pointsToDahdsr = (points) => {
  if (!isCanonicalLevel(points))
    throw new Error(
      'dahdsr: pointsToDahdsr needs a canonical 6-point level env — '
        + 'points (0,0),(d,0),(d+a,1),(d+a+h,1),(d+a+h+dec,s),'
        + '(d+a+h+dec+r,0) with sorted t, and curve keys only on '
        + 'indices 1 / 3 / 4',
    );
  const [p0, p1, p2, p3, p4, p5] = points;
  return {
    delay: p1.t - p0.t,
    attack: p2.t - p1.t,
    hold: p3.t - p2.t,
    decay: p4.t - p3.t,
    sustain: p4.v,
    release: p5.t - p4.t,
    attackCurve: p1.curve ?? 0,
    decayCurve: p3.curve ?? 0,
    releaseCurve: p4.curve ?? 0,
  };
};

// Shared precondition for the normalizers and the bend mapping: a
// non-empty array of finite {t, v} points. Legacy data is legal input
// for the normalizers, but a non-finite value is corruption, not a
// shape — fail loudly (repo style).
const requirePoints = (points, what) => {
  if (!Array.isArray(points) || !points.length)
    throw new Error(
      `dahdsr: ${what} needs a non-empty point array, got ${JSON.stringify(points)}`,
    );
  for (const p of points)
    if (!p || !Number.isFinite(p.t) || !Number.isFinite(p.v))
      throw new Error(
        `dahdsr: ${what} needs finite {t, v} points, got ${JSON.stringify(p)}`,
      );
};

// Shared precondition for the bend mapping: a valid segment index (the
// segment LEAVING point i — the last point has no outgoing segment, its
// curve would be inert).
const requireSegment = (points, i, what) => {
  requirePoints(points, what);
  if (!Number.isInteger(i) || i < 0 || i >= points.length - 1)
    throw new Error(
      `dahdsr: ${what} segment index ${i} out of range `
        + `(0 .. ${points.length - 2})`,
    );
};

// Normalize a level env to the canonical form. A canonical input is
// returned AS-IS (same reference — an already-canonical shape never
// goes through the lossy fit); a non-canonical one is LANDMARK-FIT to
// the closest canonical parameters:
//
//   delay     the first t where the envelope's value is > 0 — the t of
//             the last point of the leading all-zero run (the value
//             rises to > 0 immediately after it); no leading zero run
//             -> 0
//   attack    first-peak t - delay (the peak = the max value; the
//             segments never overshoot it)
//   hold      the span at the peak value after the FIRST peak point
//             (a double peak keeps its first peak — the fit is a lossy
//             projection)
//   sustain   the value at the start of the final fall to 0; if the
//             envelope never falls to 0, the last value with release
//             = 0 — the canonical form's last point is ALWAYS (T, 0)
//             (a one-shot that rings at a non-zero level forever is
//             inexpressible in the model), so the fit matches the old
//             envelope exactly up to the decay end and is the closest
//             canonical form beyond it (the trailing hold is cut off)
//   decay /   the remaining spans: hold end -> fall start, and fall
//   release   start -> the end
//   decayCurve  the deterministic 101-step scan (k = 0, 0.01, ..., 1)
//             minimizing the max absolute difference against the OLD
//             envelope over the decay window (256 dense samples via
//             the facade's envelopeValue); attackCurve / releaseCurve
//             = 0 (only the decay tail needs the bend's
//             expressiveness — the locked design, plan notes)
//
// The fit is deterministic: the same input always yields the same
// canonical form (ties in the scan keep the smaller k).
const CURVE_SCAN_STEPS = 100; // k = 0 .. 1 in 100 steps (101 values)
const CURVE_SCAN_SAMPLES = 256; // dense comparison over the decay window

export const normalizeLevelEnv = (points) => {
  requirePoints(points, 'normalizeLevelEnv');
  if (isCanonicalLevel(points)) return points;
  const n = points.length;

  // 1. delay: the last point of the leading all-zero run (the envelope
  //    value is > 0 immediately after it).
  let delay = 0;
  if (points[0].v === 0) {
    let i = 0;
    while (i < n && points[i].v === 0) i++;
    delay = points[i - 1].t;
  }

  // 2. peak: the max value and the FIRST point that reaches it.
  let peakIdx = 0;
  for (let i = 1; i < n; i++)
    if (points[i].v > points[peakIdx].v) peakIdx = i;
  const peakV = points[peakIdx].v;
  if (peakV <= 0)
    // Never positive: the silent envelope. The all-zero canonical form
    // (every span 0) renders EXACTLY zero everywhere — the engine's
    // clamp hides the zero-length peak — so this is faithful.
    // (attack / decay are the constructor's required parameters — the
    // lib's levelEnvelope has no defaults for them either.)
    return dahdsrToPoints({ attack: 0, decay: 0 });
  const attack = points[peakIdx].t - delay;

  // 3. hold: the contiguous span at the peak value after the first
  //    peak point.
  let holdEnd = peakIdx;
  while (holdEnd + 1 < n && points[holdEnd + 1].v === peakV) holdEnd++;
  const hold = points[holdEnd].t - points[peakIdx].t;

  // 4. sustain + the start of the final fall to 0.
  let sustain;
  let fallStart;
  if (points[n - 1].v !== 0) {
    // Never falls to 0: the last value is held forever by the clamp.
    sustain = points[n - 1].v;
    fallStart = n - 1;
  } else {
    // Walk back over the trailing all-zero run: its first point is the
    // fall's end, its predecessor the start of the final fall to 0.
    let j = n - 1;
    while (j > 0 && points[j - 1].v === 0) j--;
    fallStart = j - 1;
    sustain = points[fallStart].v;
  }

  // 5. decay / release: the remaining spans.
  const decay = points[fallStart].t - points[holdEnd].t;
  const release = points[n - 1].t - points[fallStart].t;

  // 6. decayCurve: the min-max scan over the decay window.
  let decayCurve = 0;
  if (decay > 0) {
    const tA = points[holdEnd].t;
    const tB = points[fallStart].t;
    let bestK = 0;
    let bestDiff = Infinity;
    for (let s = 0; s <= CURVE_SCAN_STEPS; s++) {
      const k = s / CURVE_SCAN_STEPS;
      const candidate = dahdsrToPoints({
        delay, attack, hold, decay, sustain, release, decayCurve: k,
      });
      let maxDiff = 0;
      for (let i = 0; i < CURVE_SCAN_SAMPLES; i++) {
        const t = tA + (i * (tB - tA)) / (CURVE_SCAN_SAMPLES - 1);
        const d = Math.abs(envelopeValue(candidate, t) - envelopeValue(points, t));
        if (d > maxDiff) maxDiff = d;
      }
      // Strict < keeps the SMALLER k on a tie — deterministic.
      if (maxDiff < bestDiff) {
        bestDiff = maxDiff;
        bestK = k;
      }
    }
    decayCurve = bestK;
  }

  return dahdsrToPoints({ delay, attack, hold, decay, sustain, release, decayCurve });
};

// The canonical 2-point snap for a pitch / FM-depth env: legacy
// multi-point shapes (the old band/card free-form editing could store
// them) collapse to the endpoints — (0, first.v) and (last.t, last.v).
// Endpoint-faithful: the start value is the envelope's value at the
// trigger, and the last value is held forever by envelopeValue's clamp
// (the same "hold" the lib's 2-point constructors rely on). 2-point
// inputs pass through as-is (already canonical).
const snapTwoPoint = (points, what) => {
  requirePoints(points, what);
  if (points.length === 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  return [
    { t: 0, v: first.v },
    { t: last.t, v: last.v },
  ];
};

export const normalizePitchEnv = (points) =>
  snapTwoPoint(points, 'normalizePitchEnv');

export const normalizeIndexEnv = (points) =>
  snapTwoPoint(points, 'normalizeIndexEnv');

// Normalize every envelope in a patch: every layer's `levelEnv`, every
// `pitchEnv`, and every modulator's `indexEnv`. Clone-first (the
// patch-ops contract): a NEW patch is returned and the input is never
// mutated — a layer (or modulator) is shallow-cloned only when one of
// its envs is replaced, and untouched layers / modulators / envs carry
// over BY REFERENCE, so an already-canonical patch round-trips
// byte-identical (export -> import is stable — the P3/S3 property).
export const normalizePatchEnvelopes = (patch) => {
  if (!patch || !Array.isArray(patch.layers))
    throw new Error(
      'dahdsr: normalizePatchEnvelopes needs a patch with a layers '
        + `array, got ${JSON.stringify(patch)}`,
    );
  const layers = patch.layers.map((layer) => {
    if (!layer || typeof layer !== 'object') return layer;
    let next = layer;
    // Replace a field on a SHALLOW clone so the input layer is never
    // mutated; the original carries over by reference while untouched.
    const assign = (key, value) => {
      if (next === layer) next = { ...layer };
      next[key] = value;
    };
    if (Array.isArray(layer.levelEnv))
      assign('levelEnv', normalizeLevelEnv(layer.levelEnv));
    if (Array.isArray(layer.pitchEnv))
      assign('pitchEnv', normalizePitchEnv(layer.pitchEnv));
    if (Array.isArray(layer.modulators)) {
      let modulatorsChanged = false;
      const modulators = layer.modulators.map((mod) => {
        if (mod && Array.isArray(mod.indexEnv)) {
          const indexEnv = normalizeIndexEnv(mod.indexEnv);
          if (indexEnv !== mod.indexEnv) {
            modulatorsChanged = true;
            return { ...mod, indexEnv };
          }
        }
        return mod;
      });
      if (modulatorsChanged) assign('modulators', modulators);
    }
    return next;
  });
  return { ...patch, layers };
};

// The envelope's value at the midpoint of the segment leaving point i
// — a facade envelopeValue sample (the UI never re-derives the curve
// math). For a zero-length segment (duplicate t) the sample is the
// later point's value — the engine's instant-jump rule.
export const segmentMidValue = (points, i) => {
  requireSegment(points, i, 'segmentMidValue');
  const a = points[i];
  const b = points[i + 1];
  return envelopeValue(points, (a.t + b.t) / 2);
};

// The inverse of segmentMidValue: the curve scalar k in [0, 1] whose
// bent segment midpoint sits at targetV — the bend-dot drag's inverse
// (P4/S1's dragEnv maps a vertical pixel drag to targetV and calls
// this). The midpoint value is strictly monotone in k — the chord
// midpoint at k = 0, sagging toward the lower end as k -> 1 (see
// segmentValue in src/lib/envelopes.js) — so the inverse is unique
// where reachable and a plain bisection. The unreachable targets clamp:
// at/above the chord midpoint -> 0 (no bend); at/below the k = 1
// midpoint -> 1 (max bend — for a rising segment the k = 1 midpoint
// sits just above the segment's start value, the bend's "all the way
// down" position, so this subsumes the start-value boundary).
//
// The inversion SAMPLES the facade's envelopeValue (a private copy of
// the points with the candidate curve on point i) — it never
// re-derives the easing math (the band.js precedent).
export const midValueToCurve = (points, i, targetV) => {
  requireSegment(points, i, 'midValueToCurve');
  if (!Number.isFinite(targetV))
    throw new Error(
      `dahdsr: midValueToCurve target must be a finite number, got ${targetV}`,
    );
  const a = points[i];
  const b = points[i + 1];
  const chordMid = (a.v + b.v) / 2;
  if (targetV >= chordMid) return 0;
  // Sample the midpoint with a candidate curve on a private copy of
  // the array (the input is never touched).
  const sampled = points.slice();
  sampled[i] = { ...a };
  const midAt = (k) => {
    sampled[i].curve = k;
    return envelopeValue(sampled, (a.t + b.t) / 2);
  };
  if (targetV <= midAt(1)) return 1;
  // midAt(1) < targetV < chordMid: the unique root (strict
  // monotonicity) — bisect; midAt decreases in k.
  let lo = 0;
  let hi = 1;
  for (let n = 0; n < 100 && hi - lo > 1e-12; n++) {
    const mid = 0.5 * (lo + hi);
    if (midAt(mid) > targetV) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
};
