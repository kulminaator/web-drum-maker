import test from 'node:test';
import assert from 'node:assert/strict';
import { saturate, highpass, resonate, compress } from '../src/lib/effects.js';
import { whiteNoiseBuffer } from '../src/lib/noise.js';
import { goertzelMag } from '../src/lib/index.js';

// Test parameters per plan step 7 (GUIDELINES §4: low sample rate,
// ≤ 0.5 s) and the step 4 notes: sr 8000, 4000 samples. High-pass
// cutoff 200 Hz is chosen so 10× the cutoff (2000 Hz) lands in the
// filter's ≈ unity-gain band (measured 0.997; the gain at 10× varies
// with the (cutoff, sr) pair — keep both in the flat band).
const SR = 8000;
const N = 4000;

// Full-scale sine of `freq` Hz at SR. 100/2000/40 Hz all land on exact
// Goertzel bins here (2 Hz/bin for 4000 samples @ 8 kHz), so spectral
// checks see pure single-bin magnitudes.
const sine = (freq, amp = 1) => {
  const buf = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    buf[n] = amp * Math.sin((2 * Math.PI * freq * n) / SR);
  }
  return buf;
};

// RMS of buf[from..to) — windowing skips the one-pole filter's start-up
// transient (pole at −(1−a), |1−a| = 0.855 for cutoff 200 / sr 8000 →
// below 1e-3 by sample 50).
const rms = (buf, from, to) => {
  let sum = 0;
  for (let n = from; n < to; n++) sum += buf[n] * buf[n];
  return Math.sqrt(sum / (to - from));
};

// Peak-to-average ratio: peak / mean(|x|) over the whole buffer. The
// plain mean of x is ≈ 0 for symmetric signals, so the rectified mean
// is the meaningful "average" — and a working compressor lowers the PAR
// by attenuating the peaks more than the body.
const par = (buf) => {
  let peak = 0;
  let sum = 0;
  for (let n = 0; n < buf.length; n++) {
    const a = Math.abs(buf[n]);
    if (a > peak) peak = a;
    sum += a;
  }
  return peak / (sum / buf.length);
};

// Sine of `freq` Hz at SR, zero outside [from, to) — the 0.2 s burst
// for the compressor tests, inside the same 0.5 s buffer.
const burstSine = (freq, amp, from, to) => {
  const buf = new Float32Array(N);
  for (let n = from; n < to; n++) {
    buf[n] = amp * Math.sin((2 * Math.PI * freq * n) / SR);
  }
  return buf;
};

test('saturate: output within ±1 for full-scale input at drives 1, 4, 20', () => {
  const x = whiteNoiseBuffer(N, 5); // |x| < 1
  for (const drive of [1, 4, 20]) {
    const y = saturate(x, drive);
    assert.equal(y.length, N, `drive ${drive}: wrong output length`);
    for (let n = 0; n < N; n++) {
      assert.ok(
        y[n] >= -1 && y[n] <= 1,
        `drive ${drive}, sample ${n} = ${y[n]} outside [-1, 1]`,
      );
    }
  }
});

test('saturate: strictly monotone increasing', () => {
  const xs = [];
  for (let x = -2; x <= 2 + 1e-9; x += 0.05) xs.push(x);
  const y = saturate(new Float32Array(xs), 4);
  for (let i = 1; i < y.length; i++) {
    assert.ok(
      y[i] > y[i - 1],
      `not strictly increasing between x = ${xs[i - 1]} and ${xs[i]}`,
    );
  }
});

test('saturate: full scale → full scale; small-signal gain is drive/tanh(drive)', () => {
  // The /tanh(drive) normalization maps full scale to full scale at any
  // drive — the soft-clip property peaks rely on.
  for (const drive of [1, 4, 20]) {
    const y = saturate(new Float32Array([1, -1, 0.5, -0.5]), drive);
    assert.ok(Math.abs(y[0] - 1) < 1e-12, `drive ${drive}: saturate(1) = ${y[0]} ≠ 1`);
    assert.ok(Math.abs(y[1] + 1) < 1e-12, `drive ${drive}: saturate(−1) = ${y[1]} ≠ −1`);
    assert.ok(Math.abs(y[2] + y[3]) < 1e-12, `drive ${drive}: not odd-symmetric`);
  }
  // Plan step 7 expected saturate(0.1, 4) ≈ 0.1 (within 2 %), assuming
  // small signals pass at unity gain. That expectation is wrong for the
  // specified formula: the /tanh(drive) normalization normalizes full
  // scale (x = 1 → 1), while the small-signal gain is drive/tanh(drive)
  // (≈ drive). So saturate(0.1, 4) = tanh(0.4)/tanh(4) ≈ 0.3802. The
  // test asserts the formula's actual behavior instead (GUIDELINES §4).
  // Tolerance 1e-6: input and output both round-trip Float32 (0.1 is
  // not exact in binary), so the check validates the formula, not
  // float32 round-trip noise (~3e-9 here).
  const x01 = new Float32Array([0.1]);
  const y01 = saturate(x01, 4)[0];
  assert.ok(
    Math.abs(y01 - (Math.tanh(4 * x01[0]) / Math.tanh(4))) < 1e-6,
    `saturate(0.1, 4) = ${y01} deviates from the tanh(drive·x)/tanh(drive) formula`,
  );
  const x = 0.01;
  const gain = saturate(new Float32Array([x]), 4)[0] / x;
  const expected = 4 / Math.tanh(4);
  assert.ok(
    Math.abs(gain - expected) / expected < 0.02,
    `small-signal gain ${gain} not within 2% of drive/tanh(drive) = ${expected}`,
  );
});

test('saturate: 100 Hz sine at drive 8 develops odd harmonics', () => {
  const y = saturate(sine(100), 8);
  const f1 = goertzelMag(y, 100, SR);
  const f2 = goertzelMag(y, 200, SR);
  const f3 = goertzelMag(y, 300, SR);
  assert.ok(
    f3 > 0.05 * f1,
    `300 Hz magnitude ${f3} not > 5% of fundamental ${f1}`,
  );
  // tanh is odd → even harmonics vanish (measured ≈ 1e-15 of f1).
  assert.ok(
    f2 < 1e-9 * f1,
    `200 Hz magnitude ${f2} not ~0 — even harmonics should vanish`,
  );
});

test('highpass: constant (DC) input rejected after settling', () => {
  const y = highpass(new Float32Array(N).fill(1), 200, SR);
  let maxAbs = 0;
  for (let n = 100; n < N; n++) {
    const m = Math.abs(y[n]);
    if (m > maxAbs) maxAbs = m;
  }
  assert.ok(maxAbs < 1e-3, `DC not rejected: max |y[n≥100]| = ${maxAbs}`);
});

test('highpass: 10 × cutoff sine passes with gain ≈ 1', () => {
  const x = sine(2000); // 10 × 200 Hz cutoff
  const y = highpass(x, 200, SR);
  const ratio = rms(y, 200, N) / rms(x, 200, N);
  assert.ok(
    ratio > 0.9 && ratio < 1.1,
    `2000 Hz RMS ratio ${ratio} outside [0.9, 1.1]`,
  );
});

test('highpass: 0.2 × cutoff sine attenuated', () => {
  const x = sine(40); // 0.2 × 200 Hz cutoff
  const y = highpass(x, 200, SR);
  const ratio = rms(y, 200, N) / rms(x, 200, N);
  assert.ok(ratio < 0.3, `40 Hz RMS ratio ${ratio} not < 0.3`);
});

test('highpass: bounded ±1 for full-scale band-limited input', () => {
  // The one-pole topology boosts the upper band (steady-state Nyquist
  // gain (2−a)/a ≈ 12.8 for cutoff 200 / sr 8000 — the same boost that
  // motivated filteredNoiseBurst's peak normalization), so a blanket
  // ±1 bound cannot hold for broadband ±1 inputs; layer gains and the
  // engine's final clamp (step 9) cover those. For a full-scale sine
  // at 10× the cutoff (steady-state gain 0.997), the settled output
  // stays within ±1 (measured peak 0.994). Only the start-up transient
  // (first ≈ 50 samples, decaying like (1−a)ⁿ; here a 4-samples-per-
  // period sine peaks at −1.72 at n = 2) can momentarily exceed ±1.
  const y = highpass(sine(2000), 200, SR);
  for (let n = 200; n < N; n++) {
    assert.ok(
      y[n] >= -1 && y[n] <= 1,
      `sample ${n} = ${y[n]} outside [-1, 1]`,
    );
  }
});

// --- resonate (step 8) ---
//
// The biquad's steady-state gain at its center frequency is exactly Q
// (derivation in src/lib/effects.js), so a full-scale resonant sine comes
// out at peak ≈ Q — a blanket "|output| ≤ c for |input| ≤ 1" bound
// cannot hold at resonance (that is the resonator's purpose); the
// engine's final clamp (step 9) is the backstop there, exactly as for
// the high-pass above. The bound test below is scoped to the
// off-center 1000 Hz path, per the plan.

test('resonate: 200 Hz sine through 200 Hz center, Q 10 → RMS ≥ 2 × input', () => {
  const x = sine(200);
  const y = resonate(x, 200, 10, SR);
  const ratio = rms(y, 200, N) / rms(x, 200, N);
  assert.ok(ratio >= 2, `resonant RMS ratio ${ratio} not ≥ 2`);
  // Upper sanity: the center gain is exactly Q, so the ratio lands just
  // under 10 (measured 9.93 — the rest is the ~100-sample ramp-up of
  // the zero initial state). The upper bound catches a coefficient
  // regression that would make the stage run away instead of ringing.
  assert.ok(ratio <= 11, `resonant RMS ratio ${ratio} above Q + 1 = 11`);
});

test('resonate: 1000 Hz input through 200 Hz center, Q 10 → RMS < 0.5 × input', () => {
  const x = sine(1000);
  const y = resonate(x, 200, 10, SR);
  const ratio = rms(y, 200, N) / rms(x, 200, N);
  // Measured 0.045 — the plan's 0.5 threshold has ~11× margin.
  assert.ok(ratio < 0.5, `1000 Hz RMS ratio ${ratio} not < 0.5`);
});

test('resonate: bounded ±1.5 for |input| ≤ 1 (off-center, exact bound documented)', () => {
  // Exact bound asserted: max_n |y[n]| ≤ 1.5 for all N = 4000 samples
  // of a full-scale (|x| ≤ 1) 1000 Hz input through the 200 Hz / Q 10
  // resonator. The off-center path attenuates (steady-state gain
  // 0.045; measured peak including the start transient: 0.19), so 1.5
  // is a ~8× margin. A blanket ±1.5 for ANY |input| ≤ 1 cannot hold —
  // the peak gain is Q at the center (a full-scale 200 Hz input peaks
  // at exactly 10 — see the RMS test above).
  const y = resonate(sine(1000), 200, 10, SR);
  for (let n = 0; n < N; n++) {
    assert.ok(
      y[n] >= -1.5 && y[n] <= 1.5,
      `sample ${n} = ${y[n]} outside [-1.5, 1.5]`,
    );
  }
});

test('resonate: q < 0.5 clamps to 0.5 (bit-identical output)', () => {
  // Documents the clamp from the plan: below Q ≈ 0.707 the response
  // has no gain peak, so the stage would silently become a plain
  // low-pass — the clamp keeps it a (weak) resonator.
  const x = sine(1000);
  assert.deepEqual(
    Buffer.from(resonate(x, 200, 0.1, SR).buffer),
    Buffer.from(resonate(x, 200, 0.5, SR).buffer),
  );
});

// --- compress (step 8) ---

test('compress: 0.2 s peak-0.9 burst, threshold 0.25, ratio 4 → PAR drops', () => {
  // Burst: 4 full cycles of 50 Hz (samples 800..2400 = 0.1..0.3 s —
  // starts and ends on a zero crossing), peak 0.9, in 0.5 s of
  // silence. 50 Hz gives the largest margin: its |x| envelope has a
  // 10 ms period, so the fast follower (attack 4 samples = 0.5 ms,
  // release 16 = 2 ms) tracks it almost exactly — the crests compress
  // at G ≈ 1 − (0.9 − 0.25)·(1 − 1/4) = 0.5125 while the troughs
  // (env ≈ 0 < threshold) pass at unity. Slower followers flatten the
  // envelope and erase the effect: measured PAR ratio 1.27 > 1 for a
  // 200 Hz burst at attack 16 / release 40. Deterministic, so the
  // margin (0.80 × dry) is stable across runs.
  const x = burstSine(50, 0.9, 800, 2400);
  const y = compress(x, { threshold: 0.25, ratio: 4, attack: 4, release: 16, makeup: 1 });
  const dry = par(x); // ≈ 3.93
  const wet = par(y); // ≈ 3.13
  assert.ok(
    wet < dry,
    `compressed PAR ${wet} not < dry PAR ${dry} — compression not working`,
  );
});

test('compress: |output| ≤ 1 for |input| ≤ 1 with makeup 1', () => {
  // Structural: G ≤ 1 always (G = 1 below threshold, and
  // 1 − (env − threshold)·(1 − 1/ratio) < 1 above it), so
  // |y| = G·|x|·makeup ≤ |x| ≤ 1 for makeup 1 — for any envelope
  // timing, hence the full-scale noise below.
  const x = whiteNoiseBuffer(N, 6); // |x| < 1
  const y = compress(x, { threshold: 0.25, ratio: 4, attack: 4, release: 16, makeup: 1 });
  for (let n = 0; n < N; n++) {
    assert.ok(
      y[n] >= -1 && y[n] <= 1,
      `sample ${n} = ${y[n]} outside [-1, 1]`,
    );
  }
});

test('compress: constant 0.9 input settles at the gain law\'s 0.5125', () => {
  // Gain-law spot check, isolated from envelope dynamics: a constant
  // input holds the follower at env = 0.9 exactly (it rises at 1/4 per
  // sample and then neither rises nor falls), so the settled gain is
  // G = 1 − (0.9 − 0.25)·(1 − 1/4) = 0.5125 to the float32 round-trip.
  // (A sine input would oscillate the envelope around the 400 Hz |x|
  // ripple and the ratio would sit ≈ 0.05 above the law — the PAR
  // test above covers that regime.)
  const x = new Float32Array(N).fill(0.9);
  const y = compress(x, { threshold: 0.25, ratio: 4, attack: 4, release: 16, makeup: 1 });
  const ratio = rms(y, 100, N) / rms(x, 100, N);
  assert.ok(
    Math.abs(ratio - 0.5125) < 1e-4,
    `settled gain ${ratio} not ≈ 0.5125 (the gain law at env = 0.9)`,
  );
});

test('compress: invalid parameters throw', () => {
  const x = new Float32Array(64);
  const opts = { threshold: 0.25, ratio: 4, attack: 4, release: 16, makeup: 1 };
  assert.throws(() => compress(x, { ...opts, threshold: 0 }), /threshold/);
  assert.throws(() => compress(x, { ...opts, threshold: 1.5 }), /threshold/);
  assert.throws(() => compress(x, { ...opts, ratio: 0.5 }), /ratio/);
  assert.throws(() => compress(x, { ...opts, attack: -1 }), /attack/);
  assert.throws(() => compress(x, { ...opts, release: -1 }), /release/);
  assert.throws(() => compress(x, { ...opts, makeup: -1 }), /makeup/);
});

test('resonate + compress: determinism (same inputs → identical arrays)', () => {
  const x = sine(200);
  assert.deepEqual(
    Buffer.from(resonate(x, 200, 10, SR).buffer),
    Buffer.from(resonate(x, 200, 10, SR).buffer),
  );
  const b = burstSine(50, 0.9, 800, 2400);
  const opts = { threshold: 0.25, ratio: 4, attack: 4, release: 16, makeup: 1 };
  assert.deepEqual(
    Buffer.from(compress(b, opts).buffer),
    Buffer.from(compress(b, opts).buffer),
  );
});
