// One-shot envelopes: pure, sample-rate-independent math (GUIDELINES §3).
//
// An envelope is a plain array of points `{t, v}` sorted by `t` in seconds.
// The engine evaluates it once per sample via `envelopeValue`, so this
// module holds no audio-rate state and no sample rate appears here at all.
// The point arrays are just data, and they are edited through the
// canonical-form helpers in the app tier (src/app/dahdsr.js — the DAHDSR
// level form, the 2-point pitch/FM forms) together with the per-segment
// `curve` field below: the constrained DAHDSR editor replaced free-form
// point insertion, and the old insertPoint / removePoint / pointAt /
// clampPointT helpers left this module and the facade (plan "dahdsr" P5).
//
// Interpolation is piecewise linear by default, with an optional
// per-segment exponential bend: a point may carry a `curve` scalar that
// bends its OUTGOING segment (the segment after it — see
// `segmentValue` below). Absent (or 0) means exactly the plain linear
// interpolation: an optional schema field with an engine default, the
// `shape`-default precedent (GUIDELINES §2), so patches without curves
// render byte-identically to the linear math. This is the exponential
// ("log") mode this module once deferred, realized as DATA — the `curve`
// field lives in the patch's point objects and is edited like any other
// patch value; it is never engine state.

// Bend strength at curve = 1 (λ = CURVE_LAMBDA_MAX · k): 4. The "why":
// at k = 1 the segment midpoint sits at ~12 % of the chord for a 1 -> 0
// fall (value 1 - (1 - e^-2) / (1 - e^-4) ≈ 0.1192) — a strong-but-musical
// exponential, the classic drum tail — while k = 0 -> 1 stays a smooth
// family from the straight chord to that tail.
const CURVE_LAMBDA_MAX = 4;

// Value of the segment a -> b at its normalized position f in [0, 1],
// with the outgoing segment's curve bend. With k = a.curve (absent -> 0)
// and λ = CURVE_LAMBDA_MAX · k, the blend factor E(f) is:
//   rising (b.v > a.v):  E(f) = (e^{λf} - 1) / (e^λ - 1)   — ease-in:
//     a slow swell that hugs a.v and steepens into b.v;
//   falling (b.v < a.v): E(f) = (1 - e^{-λf}) / (1 - e^{-λ}) — ease-out:
//     a fast collapse with a long tail;
//   flat (b.v === a.v) or k = 0: E(f) = f — the λ -> 0 limit of both
//     families is exactly linear, so an absent/0 curve is byte-identical
//     to the plain interpolation.
// Both families are strictly increasing in f (monotone — no overshoot,
// no kinks introduced), and the midpoint value decreases strictly from
// the chord midpoint toward the lower end as k goes 0 -> 1, for BOTH
// directions — the bend always sags "down" from the chord, which keeps
// the editor's bend-dot drag well-defined and consistent (its inverse is
// a plain bisection on this monotone mapping).
const segmentValue = (a, b, f) => {
  const lambda = CURVE_LAMBDA_MAX * (a.curve ?? 0);
  const e =
    lambda === 0 || b.v === a.v
      ? f
      : b.v > a.v
        ? (Math.exp(lambda * f) - 1) / (Math.exp(lambda) - 1)
        : (1 - Math.exp(-lambda * f)) / (1 - Math.exp(-lambda));
  return a.v + (b.v - a.v) * e;
};

// Evaluation of a point array at time `t`: piecewise linear by default,
// with the optional per-segment curve bend when the segment's leaving
// point carries a `curve` field (see `segmentValue`). The points must be
// sorted by t — the constructors below build their arrays sorted by
// construction, and a host building its own array must sort it too, since
// an unsorted array silently breaks the segment search. Clamped outside
// the point range: before the first point the envelope holds the first v,
// after the last it holds the last v. The clamping is what gives one-shot
// envelopes their "hold" behavior (a pitch envelope stays at its `to`
// value forever, an untriggered level envelope reads its 0), so the
// constructors never need an explicit `t: Infinity` hold point. A
// zero-length segment (two points at the same t, e.g. attack = 0) is an
// instantaneous jump and resolves to the later point's value.
export const envelopeValue = (points, t) => {
  if (!points.length) throw new Error('envelope needs at least one point');
  const first = points[0];
  if (t <= first.t) return first.v;
  const last = points[points.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (t >= a.t && t <= b.t) {
      if (b.t === a.t) return b.v; // instant jump at this time
      const f = (t - a.t) / (b.t - a.t);
      return segmentValue(a, b, f);
    }
  }
  return last.v; // unreachable for sorted points; keeps the function total
};

// The decay-curve bend that carries the legacy 4-point knee's sound into
// the canonical form below. The old constructor put a fixed knee at
// (attack + decay / 2, level * 0.25) — the decay midpoint at 25 % of the
// peak. A falling 1 -> 0 segment's midpoint value is exactly
// (e^{λ/2} − 1) / (e^{λ} − 1) = 1 / (e^{λ/2} + 1), so matching the knee
// means solving (e^{λ/2} − 1) / (e^{λ} − 1) = 0.25 → e^{λ/2} = 3 →
// λ = 2 ln 3 ≈ 2.2, i.e. k = λ / 4 = ln 3 / 2 ≈ 0.5493 — the closest
// single-bend exponential to the old knee, rounded to the 0…1 curve
// scale's 0.01 grid (at k = 0.55 the midpoint sits at 0.2497 of the
// span, the knee's 0.25 to within 0.03 %).
export const KNEE_CURVE = 0.55;

// Level envelope: the canonical 6-point DAHDSR form (Delay / Attack /
// Hold / Decay / Sustain / Release) — always exactly six points with
// fixed roles, so the point INDICES are stable (the UI's knobs and the
// constrained editor address them by role):
//
//   pts[0] = (0, 0)                                    silent start (fixed)
//   pts[1] = (delay, 0)                        [curve: attackCurve]
//   pts[2] = (delay + attack, 1)                           the peak
//   pts[3] = (delay + attack + hold, 1)        [curve: decayCurve]
//   pts[4] = (delay + attack + hold + decay, sustain) [curve: releaseCurve]
//   pts[5] = (delay + attack + hold + decay + release, 0) release end
//
// A point's `curve` bends its OUTGOING segment (see `segmentValue`), so
// the attack/decay/release curves ride on pts[1] / pts[3] / pts[4].
// Zero-length spans are stored as duplicate-t points, which
// `envelopeValue`'s zero-length-segment rule (instant jump → the later
// point's value) resolves correctly per span: delay = 0 → two (0, 0)
// points (the attack starts at the trigger); hold = 0 → the peak value
// holds; decay = 0 → an instant drop from the peak to `sustain`;
// release = 0 → an instant drop to silence at the decay end.
//
// The peak is fixed at 1.0 (classic DAHDSR): the layer's `gain` is the
// level knob — the envelope shapes time, the gain shapes level. The
// `curve` keys are written only when > 0 (absent = the segment's plain
// linear interpolation, keeping a bend-less patch's shape minimal — the
// same optional-schema-field default the `curve` field itself has).
export const levelEnvelope = ({
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

// Pitch envelope: glide from `from` to `to` Hz over `time` seconds, then
// hold `to` (the hold comes from clamping in envelopeValue — no explicit
// hold point). Kick recipe: 100 -> 50 Hz in 30 ms (drum_generation.md).
export const pitchEnvelope = ({ from, to, time }) => [
  { t: 0, v: from },
  { t: time, v: to },
];

// FM depth (modulation index) envelope: the index collapse that turns the
// dense sideband burst of the attack into a pure ringing carrier — kick
// recipe: 8 -> 0 in 20 ms (drum_generation.md). `to` defaults to 0 so the
// modulator is fully released after the decay; after `time` the value is
// held by clamping.
export const fmDepthEnvelope = ({ from, to = 0, time }) => [
  { t: 0, v: from },
  { t: time, v: to },
];


