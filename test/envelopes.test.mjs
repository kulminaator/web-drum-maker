import test from 'node:test';
import assert from 'node:assert/strict';
import {
  envelopeValue,
  levelEnvelope,
  KNEE_CURVE,
  pitchEnvelope,
  fmDepthEnvelope,
} from '../src/lib/envelopes.js';

// Tiny tolerance for "exactly linear" checks: the interpolation is exact
// math on inexact binary fractions (e.g. 0.015 / 0.03 is not exactly 0.5),
// so we assert to 1e-9 rather than bit equality.
const LINEAR_EPS = 1e-9;

test('envelopeValue clamps to the first v before the first point', () => {
  const points = [
    { t: 0.05, v: 3 },
    { t: 0.15, v: 9 },
  ];
  assert.equal(envelopeValue(points, 0), 3);
  assert.equal(envelopeValue(points, -1), 3);
  assert.equal(envelopeValue(points, 0.05), 3);
});

test('envelopeValue clamps to the last v after the last point', () => {
  const points = [
    { t: 0, v: 0 },
    { t: 0.1, v: 5 },
    { t: 0.2, v: 0 },
  ];
  assert.equal(envelopeValue(points, 0.2), 0);
  assert.equal(envelopeValue(points, 1), 0);
});

test('envelopeValue is exactly linear between points', () => {
  const points = [
    { t: 0, v: 2 },
    { t: 1, v: 10 },
  ];
  assert.equal(envelopeValue(points, 0), 2);
  assert.equal(envelopeValue(points, 1), 10);
  // Midpoint: 2 + (10 - 2) * 0.5 = 6.
  const mid = envelopeValue(points, 0.5);
  assert.ok(Math.abs(mid - 6) < LINEAR_EPS, `midpoint ${mid} != 6`);
  // Quarter point: 2 + 8 * 0.25 = 4.
  const quarter = envelopeValue(points, 0.25);
  assert.ok(Math.abs(quarter - 4) < LINEAR_EPS, `quarter ${quarter} != 4`);
});

test('envelopeValue throws on an empty point array', () => {
  assert.throws(() => envelopeValue([], 0), /at least one point/);
});

// ---- levelEnvelope: the canonical 6-point DAHDSR form ---------------

test('levelEnvelope: the canonical 6-point layout (every role, every index)', () => {
  const d = 0.01, a = 0.005, h = 0.02, dec = 0.3, s = 0.4, r = 0.1;
  const points = levelEnvelope({
    delay: d, attack: a, hold: h, decay: dec, sustain: s, release: r,
    attackCurve: 0.3, decayCurve: 0.55, releaseCurve: 0.7,
  });
  // Exactly six points, fixed roles: silent start, delay end (attack
  // leaves), peak, hold end (decay leaves), decay end = sustain
  // (release leaves), release end = silence. The t values are the same
  // left-to-right sums the constructor computes, so strict equality.
  assert.deepEqual(points, [
    { t: 0, v: 0 },
    { t: d, v: 0, curve: 0.3 },
    { t: d + a, v: 1 },
    { t: d + a + h, v: 1, curve: 0.55 },
    { t: d + a + h + dec, v: s, curve: 0.7 },
    { t: d + a + h + dec + r, v: 0 },
  ]);
});

test('levelEnvelope: the default shape (delay/hold/sustain/release = 0) is duplicate-t points', () => {
  // Every migrated voice carries this shape: peak 1.0 at attack, the
  // decay to 0 at attack + decay, and the four zero spans stored as
  // duplicate-t points.
  const points = levelEnvelope({ attack: 0.005, decay: 0.3 });
  assert.deepEqual(points, [
    { t: 0, v: 0 },
    { t: 0, v: 0 },
    { t: 0.005, v: 1 },
    { t: 0.005, v: 1 },
    { t: 0.005 + 0.3, v: 0 },
    { t: 0.005 + 0.3, v: 0 },
  ]);
});

test('levelEnvelope: curve keys are written only when > 0', () => {
  // No curves: every point is a plain {t, v} pair (absent = linear).
  const plain = levelEnvelope({ attack: 0.005, decay: 0.3 });
  for (const p of plain)
    assert.ok(!('curve' in p), `unexpected curve key on ${JSON.stringify(p)}`);
  // An explicit 0 is absent, too: the same array.
  assert.deepEqual(
    levelEnvelope({
      attack: 0.005, decay: 0.3,
      attackCurve: 0, decayCurve: 0, releaseCurve: 0,
    }),
    plain,
  );
  // Each curve rides exactly on its outgoing segment's point:
  // attack -> pts[1], decay -> pts[3], release -> pts[4] — never
  // anywhere else (pts[0] / pts[2] / pts[5] stay plain).
  const all = levelEnvelope({
    attack: 0.005, decay: 0.3,
    attackCurve: 0.3, decayCurve: 0.4, releaseCurve: 0.5,
  });
  assert.equal(all[1].curve, 0.3, 'attackCurve rides pts[1]');
  assert.equal(all[3].curve, 0.4, 'decayCurve rides pts[3]');
  assert.equal(all[4].curve, 0.5, 'releaseCurve rides pts[4]');
  for (const i of [0, 2, 5])
    assert.ok(!('curve' in all[i]), `no curve key on pts[${i}]`);
});

test('levelEnvelope: a fully populated shape resolves the DAHDSR landmarks', () => {
  // Binary-fraction spans: every landmark time and the linear leg
  // midpoints are exact, so the assertions are strict equalities.
  // (0.25 delay, 0.25 attack, 0.25 hold, 0.5 decay, sustain 0.5,
  // 0.25 release) -> (0,0) (0.25,0) (0.5,1) (0.75,1) (1.25,0.5) (1.5,0).
  const points = levelEnvelope({
    delay: 0.25, attack: 0.25, hold: 0.25, decay: 0.5, sustain: 0.5, release: 0.25,
  });
  assert.equal(envelopeValue(points, 0), 0); // silent start
  assert.equal(envelopeValue(points, 0.25), 0); // delay end: still silent
  assert.equal(envelopeValue(points, 0.375), 0.5); // attack midpoint
  assert.equal(envelopeValue(points, 0.5), 1); // the peak — fixed at 1.0:
  // the layer's gain is the level knob, the envelope shapes time only
  assert.ok(envelopeValue(points, 0.45) < 1, 'a true peak: lower before');
  // (just after the peak the HOLD leg is still 1 — sample the decay
  // leg for the "lower after" side of the peak)
  assert.ok(envelopeValue(points, 0.8) < 1, 'a true peak: lower on the decay leg');
  assert.equal(envelopeValue(points, 0.625), 1); // the hold leg is flat at 1
  assert.equal(envelopeValue(points, 0.75), 1); // hold end
  assert.equal(envelopeValue(points, 1.0), 0.75); // decay midpoint
  assert.equal(envelopeValue(points, 1.25), 0.5); // decay end = sustain
  assert.equal(envelopeValue(points, 1.375), 0.25); // release midpoint
  assert.equal(envelopeValue(points, 1.5), 0); // release end = silence
  assert.equal(envelopeValue(points, 2.0), 0); // ...held 0 after (clamping)
});

test('levelEnvelope: zero spans resolve per span through the zero-length rule', () => {
  // delay = 0: two (0, 0) points — silent AT the trigger, but the
  // attack is already rising just after.
  const noDelay = levelEnvelope({ attack: 0.25, decay: 0.5 });
  assert.deepEqual(noDelay[0], { t: 0, v: 0 });
  assert.deepEqual(noDelay[1], { t: 0, v: 0 });
  assert.equal(envelopeValue(noDelay, 0), 0);
  assert.equal(envelopeValue(noDelay, 0.125), 0.5); // attack midpoint

  // hold = 0: the peak value holds (duplicate (delay + attack, 1)
  // points) — the decay leg starts immediately at the peak.
  const noHold = levelEnvelope({
    delay: 0.25, attack: 0.25, hold: 0, decay: 0.5, sustain: 0.25, release: 0.25,
  });
  assert.deepEqual(noHold[2], { t: 0.5, v: 1 });
  assert.deepEqual(noHold[3], { t: 0.5, v: 1 });
  assert.equal(envelopeValue(noHold, 0.5), 1);
  assert.equal(envelopeValue(noHold, 0.625), 0.8125); // decay leg from the peak

  // decay = 0: an instant drop from the peak to the sustain level
  // (duplicate-t points at the hold end) — the release leg then runs
  // from the sustain, no decay time in between.
  const noDecay = levelEnvelope({
    delay: 0.25, attack: 0.25, hold: 0.25, decay: 0, sustain: 0.5, release: 0.5,
  });
  assert.deepEqual(noDecay[3], { t: 0.75, v: 1 });
  assert.deepEqual(noDecay[4], { t: 0.75, v: 0.5 });
  assert.equal(envelopeValue(noDecay, 0.625), 1); // hold just before the drop
  assert.equal(envelopeValue(noDecay, 0.875), 0.375); // release leg from the sustain

  // release = 0: instant silence at the decay end (duplicate-t points
  // at the decay end) — the value after the end is 0 (the hold clamp
  // on the last point).
  const noRelease = levelEnvelope({
    delay: 0.25, attack: 0.25, hold: 0.25, decay: 0.5, sustain: 0.5, release: 0,
  });
  assert.deepEqual(noRelease[4], { t: 1.25, v: 0.5 });
  assert.deepEqual(noRelease[5], { t: 1.25, v: 0 });
  assert.equal(envelopeValue(noRelease, 1.125), 0.625); // decay just before the end
  assert.equal(envelopeValue(noRelease, 1.5), 0); // silent after the decay end
});

test('levelEnvelope: the decay leg is monotone non-increasing (canonical + curve)', () => {
  // The migrated shape: the hold end carries KNEE_CURVE (the legacy
  // knee's exponential collapse) — the decay leg (peak 1.0 -> sustain)
  // must never rise, dense-grid check on the curved segment.
  const points = levelEnvelope({
    delay: 0.01, attack: 0.005, hold: 0.02, decay: 0.3, sustain: 0.4,
    release: 0.1, decayCurve: KNEE_CURVE,
  });
  const decayStart = 0.01 + 0.005 + 0.02; // hold end (the constructor's sum)
  let prev = Infinity;
  for (let i = 0; i <= 200; i++) {
    const t = decayStart + (0.3 * i) / 200;
    const v = envelopeValue(points, t);
    assert.ok(v <= prev + 1e-12, `value rises on the decay leg at t=${t}`);
    prev = v;
  }
  assert.equal(points[3].v, 1, 'the leg starts at the peak');
  assert.equal(points[4].v, 0.4, '...and ends at the sustain level');
});

test('pitchEnvelope: 100 -> 50 Hz in 30 ms, held at 50 afterwards', () => {
  const points = pitchEnvelope({ from: 100, to: 50, time: 0.03 });
  assert.equal(envelopeValue(points, 0), 100);
  assert.equal(envelopeValue(points, 0.03), 50);
  // Glide is linear: midpoint of 100 -> 50 is 75 at 15 ms.
  const mid = envelopeValue(points, 0.015);
  assert.ok(Math.abs(mid - 75) < LINEAR_EPS, `midpoint ${mid} != 75`);
  // Held at `to` after the glide (no Infinity point needed).
  assert.equal(envelopeValue(points, 0.05), 50);
  assert.equal(envelopeValue(points, 1), 50);
});

test('fmDepthEnvelope: from at t=0, 0 after time', () => {
  // to = 0 is the default: kick recipe 8 -> 0 in 20 ms.
  const points = fmDepthEnvelope({ from: 8, time: 0.02 });
  assert.equal(envelopeValue(points, 0), 8);
  const mid = envelopeValue(points, 0.01);
  assert.ok(Math.abs(mid - 4) < LINEAR_EPS, `midpoint ${mid} != 4`);
  assert.equal(envelopeValue(points, 0.02), 0);
  assert.equal(envelopeValue(points, 0.1), 0);
});

test('doubling the level decay changes the value at a fixed mid time', () => {
  const attack = 0.005;
  const short = levelEnvelope({ attack, decay: 0.1 });
  const long = levelEnvelope({ attack, decay: 0.2 });
  const t = 0.02; // inside both decay legs
  const shortV = envelopeValue(short, t);
  const longV = envelopeValue(long, t);
  assert.ok(
    Math.abs(longV - shortV) > 1e-6,
    `decay change had no effect at t=${t} (${shortV} vs ${longV})`,
  );
  // The longer decay should still be higher at a fixed early time.
  assert.ok(longV > shortV);
});

test('changing pitch time changes the glide', () => {
  const fast = pitchEnvelope({ from: 100, to: 50, time: 0.03 });
  const slow = pitchEnvelope({ from: 100, to: 50, time: 0.06 });
  const atFastEnd = 0.03;
  assert.equal(envelopeValue(fast, atFastEnd), 50); // fast: glide done
  const slowV = envelopeValue(slow, atFastEnd); // slow: halfway at 75
  assert.ok(Math.abs(slowV - 75) < LINEAR_EPS, `expected ~75, got ${slowV}`);
});

test('attack = 0 is an instant jump to the peak', () => {
  const points = levelEnvelope({ attack: 0, decay: 0.1 });
  // At t = 0 the envelope still reads the first point (0); just after,
  // the zero-length segments at the trigger jump to the peak.
  assert.equal(envelopeValue(points, 0), 0);
  const justAfter = envelopeValue(points, 1e-4);
  assert.ok(justAfter > 0.9, `expected near-peak just after 0, got ${justAfter}`);
});

// ---- curve segments (per-segment exponential bend) -------------------
//
// A 2-point array isolates a single segment: with a = {t: 0, …} and
// b = {t: 1, …}, sampling at time f lands at normalized position f of
// that segment (envelopeValue computes (f - 0) / (1 - 0) = f exactly).
// The curve field lives on the segment-LEAVING point a.
const curveSeg = (a, b) => [a, b];

const rise = { t: 0, v: 0 };
const riseEnd = { t: 1, v: 1 };
const fall = { t: 0, v: 1 };
const fallEnd = { t: 1, v: 0 };
const flat = { t: 0, v: 0.3 };
const flatEnd = { t: 1, v: 0.3 };

const CURVE_SEGS = [
  [rise, riseEnd], // rising
  [fall, fallEnd], // falling
  [flat, flatEnd], // flat
];

test('curve 0 or absent is exactly linear: dense grid, rise/fall/flat', () => {
  const segs = CURVE_SEGS.concat([
    [{ t: 0, v: 0.1 }, { t: 1, v: 0.7 }], // rising, inexact fractions
    [{ t: 0, v: 0.7 }, { t: 1, v: 0.2 }], // falling, inexact fractions
  ]);
  for (const [a, b] of segs) {
    // Both "absent" and an explicit 0 must reproduce the plain formula.
    for (const lead of [a, { ...a, curve: 0 }]) {
      for (let i = 0; i <= 512; i++) {
        const f = i / 512;
        const v = envelopeValue(curveSeg(lead, b), f);
        const lin = a.v + (b.v - a.v) * f;
        assert.ok(
          Math.abs(v - lin) < LINEAR_EPS,
          `f=${f}: curved ${v} != linear ${lin}`,
        );
      }
    }
  }
});

test('curved segments hit the endpoints exactly (k = 0, 0.5, 1)', () => {
  for (const [a, b] of CURVE_SEGS)
    for (const k of [0, 0.5, 1]) {
      const pts = curveSeg({ ...a, curve: k }, b);
      assert.equal(envelopeValue(pts, 0), a.v, `f=0 at k=${k}`);
      assert.equal(envelopeValue(pts, 1), b.v, `f=1 at k=${k}`);
    }
});

test('k = 1 is monotone in f with no overshoot (both directions)', () => {
  // E(f) is strictly increasing in f for both families, so the segment
  // value moves monotonically from a.v toward b.v: non-decreasing on a
  // rise, non-increasing on a fall — never leaving [lo, hi] (no
  // overshoot, no kinks).
  for (const [a, b] of [
    [rise, riseEnd],
    [fall, fallEnd],
  ]) {
    const rising = b.v > a.v;
    const lo = Math.min(a.v, b.v);
    const hi = Math.max(a.v, b.v);
    let prev;
    for (let i = 0; i <= 512; i++) {
      const f = i / 512;
      const v = envelopeValue(curveSeg({ ...a, curve: 1 }, b), f);
      assert.ok(
        v >= lo - 1e-12 && v <= hi + 1e-12,
        `overshoot at f=${f}: ${v} outside [${lo}, ${hi}]`,
      );
      if (prev !== undefined) {
        const ordered = rising ? v >= prev - 1e-12 : v <= prev + 1e-12;
        assert.ok(ordered, `not monotone at f=${f}: ${prev} -> ${v}`);
      }
      prev = v;
    }
  }
});

test('segment midpoint bows down from the chord as k goes 0 -> 1', () => {
  for (const [a, b] of [
    [rise, riseEnd], // rising: start 0, chord midpoint 0.5
    [fall, fallEnd], // falling: start 1, chord midpoint 0.5
  ]) {
    const chordMid = (a.v + b.v) / 2;
    const ks = [0, 0.25, 0.5, 0.75, 1];
    let prev = Infinity;
    for (const k of ks) {
      const mid = envelopeValue(curveSeg({ ...a, curve: k }, b), 0.5);
      assert.ok(
        mid <= chordMid + 1e-12,
        `mid ${mid} above chord midpoint ${chordMid} at k=${k}`,
      );
      assert.ok(
        mid < prev - 1e-9,
        `midpoint not strictly decreasing at k=${k}: ${prev} -> ${mid}`,
      );
      prev = mid;
    }
    // k = 0: the midpoint IS the chord midpoint (straight chord).
    const mid0 = envelopeValue(curveSeg(a, b), 0.5);
    assert.ok(
      Math.abs(mid0 - chordMid) < LINEAR_EPS,
      `k=0 midpoint ${mid0} != chord midpoint ${chordMid}`,
    );
  }
});

test('a zero-length segment with a curve still resolves to the later point', () => {
  const points = [
    { t: 0, v: 0 },
    { t: 0.2, v: 1, curve: 1 },
    { t: 0.2, v: 0.3 },
  ];
  // At the jump instant itself the later point's value (rule unchanged).
  assert.equal(envelopeValue(points, 0.2), 0.3);
  // Just before the jump: still on the curved rising segment, near its
  // end value — the curve shaped the approach, not the jump.
  assert.ok(envelopeValue(points, 0.2 - 1e-6) > 0.99);
});

test('a curve on the last point is inert (no outgoing segment)', () => {
  const lead = { t: 0, v: 0 };
  const tail = { t: 1, v: 1 };
  // t spans the clamp-before, the segment, and the clamp-after.
  for (let i = -64; i <= 128; i++) {
    const t = i / 64;
    assert.equal(
      envelopeValue([lead, tail], t),
      envelopeValue([lead, { ...tail, curve: 1 }], t),
      `t=${t} differs with a curve on the last point`,
    );
  }
});

test('a curve bends only its outgoing segment (3-point envelope)', () => {
  const plain = [
    { t: 0, v: 0 },
    { t: 0.5, v: 0.5 },
    { t: 1, v: 1 },
  ];
  const curved = [
    { t: 0, v: 0 },
    { t: 0.5, v: 0.5, curve: 1 },
    { t: 1, v: 1 },
  ];
  // First segment (leaving a point without a curve) stays linear.
  assert.ok(
    Math.abs(envelopeValue(curved, 0.25) - 0.25) < LINEAR_EPS,
    `first segment bent: ${envelopeValue(curved, 0.25)}`,
  );
  // The curved second segment sags below its chord midpoint at f = 0.5.
  const mid = envelopeValue(curved, 0.75);
  assert.ok(mid < 0.75, `expected sag below 0.75, got ${mid}`);
  // The uncurved twin is exactly linear at the same point.
  assert.ok(
    Math.abs(envelopeValue(plain, 0.75) - 0.75) < LINEAR_EPS,
    `plain twin not linear: ${envelopeValue(plain, 0.75)}`,
  );
});

test('hold-clamps before/after the point range are unchanged with curves', () => {
  const points = [
    { t: 0.05, v: 0.2, curve: 1 },
    { t: 0.3, v: 0.8, curve: 1 },
  ];
  // Before the first point: hold the first v (the curve never gets to act).
  assert.equal(envelopeValue(points, 0), 0.2);
  assert.equal(envelopeValue(points, -3), 0.2);
  assert.equal(envelopeValue(points, 0.05), 0.2);
  // After the last point: hold the last v.
  assert.equal(envelopeValue(points, 0.3), 0.8);
  assert.equal(envelopeValue(points, 5), 0.8);
});

// ---- multi-point evaluation (kept from the retired point-editing API) --
//
// The free-form helpers (insertPoint / removePoint / pointAt /
// clampPointT) are gone (plan "dahdsr" P5) — point arrays are now edited
// through the canonical-form helpers in the app tier. The behavior that
// test pinned, though, is the ENGINE's, not the helper's: linear blending
// through an arbitrary mid point of a sorted, hand-built array. That is
// still true and still worth pinning, so the array is built inline now.

test('envelopeValue through a hand-built mid point is the expected linear blend', () => {
  const points = [
    { t: 0, v: 0 },
    { t: 0.1, v: 0.3 },
    { t: 0.2, v: 1 },
  ];
  // (0,0) -> (0.1,0.3): halfway at 0.05 s is 0.15.
  assert.ok(
    Math.abs(envelopeValue(points, 0.05) - 0.15) < LINEAR_EPS,
    `expected 0.15 at 0.05 s`,
  );
  // (0.1,0.3) -> (0.2,1): halfway at 0.15 s is 0.3 + 0.7 * 0.5 = 0.65.
  assert.ok(
    Math.abs(envelopeValue(points, 0.15) - 0.65) < LINEAR_EPS,
    `expected 0.65 at 0.15 s`,
  );
  // The mid point itself and the untouched endpoints hold.
  assert.ok(Math.abs(envelopeValue(points, 0.1) - 0.3) < LINEAR_EPS);
  assert.equal(envelopeValue(points, 0), 0);
  assert.equal(envelopeValue(points, 0.2), 1);
});
