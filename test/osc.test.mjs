import test from 'node:test';
import assert from 'node:assert/strict';
import {
  phaseAdvance,
  sineSample,
  squareSample,
  sawSample,
  triSample,
  WAVE_SHAPES,
  shapeSample,
  waveShapePoints,
} from '../src/lib/osc.js';

const TWO_PI = 2 * Math.PI;
// Low test sample rate: 100 Hz needs only 10 samples per period, which is
// cheap to render yet tight enough for the tolerances below.
const SR = 1000;

// Deterministic PRNG (mulberry32) so the "random advance" tests never flake.
const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Advance the phase by `steps` samples at `freq` Hz, starting from `from`.
const advance = (from, freq, steps) => {
  let phase = from;
  for (let n = 0; n < steps; n++) phase = phaseAdvance(phase, freq, SR);
  return phase;
};

test('phase returns to start after 1000 advances of 100 Hz at sr 1000', () => {
  // 1000 samples at 100 Hz / sr 1000 = exactly 100 full rotations.
  const phase = advance(0.5, 100, 1000);
  assert.ok(Math.abs(phase - 0.5) < 1e-9, `expected ~0.5, got ${phase}`);
});

test('phase stays in [0, 2π) for random advances', () => {
  const rand = mulberry32(42);
  let phase = rand() * TWO_PI;
  for (let n = 0; n < 10000; n++) {
    const freq = rand() * SR; // up to 1 kHz: up to one full rotation per sample
    phase = phaseAdvance(phase, freq, SR);
    assert.ok(phase >= 0 && phase < TWO_PI, `phase ${phase} out of range`);
  }
});

test('10 advances of 100 Hz at sr 1000 is one full sine period', () => {
  const period = (skip) => {
    let phase = advance(0, 100, skip);
    const out = [];
    for (let n = 0; n < 10; n++) {
      out.push(sineSample(phase));
      phase = phaseAdvance(phase, 100, SR);
    }
    return out;
  };
  const first = period(0);
  const second = period(10);
  for (let n = 0; n < 10; n++) {
    assert.ok(Math.abs(first[n] - second[n]) < 1e-12, `sample ${n} differs`);
  }
  // Half-period offset flips the sign: sin(π + x) = -sin(x).
  assert.ok(Math.abs(first[6] + first[1]) < 1e-12);
  assert.ok(Math.abs(first[7] + first[2]) < 1e-12);
});

test('per-sample advance equals 2π·freq/sr', () => {
  for (const freq of [1, 10, 100, 440, 999]) {
    const delta = phaseAdvance(0, freq, SR);
    assert.ok(
      Math.abs(delta - (TWO_PI * freq) / SR) < 1e-12,
      `freq ${freq}: ${delta} vs ${(TWO_PI * freq) / SR}`,
    );
  }
  // Same with a non-zero start phase (no wrap in this case).
  const start = 0.25;
  assert.ok(
    Math.abs(phaseAdvance(start, 100, SR) - start - (TWO_PI * 100) / SR) < 1e-12,
  );
});

test('sine has zero DC balance over one period', () => {
  let sum = 0;
  let phase = 0;
  for (let n = 0; n < 10; n++) {
    sum += sineSample(phase);
    phase = phaseAdvance(phase, 100, SR);
  }
  assert.ok(Math.abs(sum) < 1e-12, `DC sum ${sum}`);
});

test('saw is monotone non-decreasing over one period', () => {
  const N = 1000;
  let prev = sawSample(0);
  for (let n = 1; n < N; n++) {
    const v = sawSample((n / N) * TWO_PI);
    assert.ok(v >= prev, `saw decreased at sample ${n}: ${v} < ${prev}`);
    prev = v;
  }
});

test('saw starts at exactly -1 and approaches +1 from the left', () => {
  assert.equal(sawSample(0), -1);
  // Just before the wrap the value is just below +1; the jump back down
  // at phase 2π is the shape's intrinsic discontinuity, not a bug.
  const left = sawSample(TWO_PI - 1e-12);
  assert.ok(left < 1, `expected < 1 at the wrap, got ${left}`);
  assert.ok(Math.abs(left - 1) < 1e-9, `left limit ${left} is not near 1`);
});

test('saw has zero DC balance over one period', () => {
  // Midpoint sampling: the saw is linear on [0, 2π), so the midpoint
  // rule is exact here — a left-edge sum would carry the wrap jump as a
  // systematic bias (exactly -1 for any N) and never converge to 0.
  const N = 1000;
  let sum = 0;
  for (let n = 0; n < N; n++) sum += sawSample(((n + 0.5) / N) * TWO_PI);
  assert.ok(Math.abs(sum) < 1e-9, `DC sum ${sum}`);
});

test('triangle is exactly ±1 at its extrema', () => {
  assert.equal(triSample(0), -1); // min at phase 0
  assert.equal(triSample(Math.PI), 1); // max at π
  // The min is reached again at the wrap (from the left).
  assert.ok(
    Math.abs(triSample(TWO_PI - 1e-12) + 1) < 1e-9,
    `left of wrap ${triSample(TWO_PI - 1e-12)}`,
  );
});

test('triangle is continuous at the wrap and at π', () => {
  // One-sided limits match within float tolerance at both joints.
  const eps = 1e-12;
  assert.ok(
    Math.abs(triSample(0) - triSample(TWO_PI - eps)) < 1e-9,
    'discontinuous at the wrap',
  );
  assert.ok(
    Math.abs(triSample(Math.PI - eps) - triSample(Math.PI + eps)) < 1e-9,
    'discontinuous at π',
  );
});

test('triangle has zero DC balance over one period', () => {
  // Midpoint sampling is exact for the piecewise-linear triangle.
  const N = 1000;
  let sum = 0;
  for (let n = 0; n < N; n++) sum += triSample(((n + 0.5) / N) * TWO_PI);
  assert.ok(Math.abs(sum) < 1e-9, `DC sum ${sum}`);
});

test('WAVE_SHAPES is the closed enum of the four shapes', () => {
  assert.deepEqual(WAVE_SHAPES, ['sine', 'square', 'saw', 'triangle']);
  // Every enum value dispatches without throwing.
  for (const shape of WAVE_SHAPES)
    assert.equal(typeof shapeSample(shape, 0.7), 'number');
});

test('shapeSample dispatches exactly to each shape function', () => {
  // Byte pin of the dispatcher: 'sine' must be EXACTLY sineSample and
  // 'square' exactly squareSample (this is what keeps the default-sine
  // renders byte-identical in the FM step), and saw/triangle delegate
  // to the new functions. Dense uniform sweep (all of [0, 2π)) plus
  // seeded random phases.
  const rand = mulberry32(1234);
  const check = (p) => {
    assert.equal(shapeSample('sine', p), sineSample(p), `sine at ${p}`);
    assert.equal(shapeSample('square', p), squareSample(p), `square at ${p}`);
    assert.equal(shapeSample('saw', p), sawSample(p), `saw at ${p}`);
    assert.equal(shapeSample('triangle', p), triSample(p), `triangle at ${p}`);
  };
  const N = 1000;
  for (let n = 0; n < N; n++) check((n / N) * TWO_PI);
  for (let n = 0; n < 10000; n++) check(rand() * TWO_PI);
});

test('shapeSample throws descriptively for unknown shapes, naming the value', () => {
  for (const bad of ['pulse', undefined, '']) {
    assert.throws(
      () => shapeSample(bad, 0),
      (err) =>
        err instanceof Error &&
        err.message ===
          `osc: unknown wave shape "${bad}" (expected sine / square / saw / triangle)`,
      `did not throw the expected message for ${String(bad)}`,
    );
  }
});

test('all four shapes are bounded in [-1, 1] over a dense phase sweep', () => {
  // The bound invariant the engine's final ±1 clamp backstop relies on.
  const N = 50000;
  const rand = mulberry32(99);
  for (let n = 0; n < N; n++) {
    const p = (n / N) * TWO_PI;
    for (const shape of WAVE_SHAPES) {
      const v = shapeSample(shape, p);
      assert.ok(v >= -1 && v <= 1, `${shape}(${p}) = ${v} outside [-1, 1]`);
    }
  }
  for (let n = 0; n < N; n++) {
    const p = rand() * TWO_PI;
    for (const shape of WAVE_SHAPES) {
      const v = shapeSample(shape, p);
      assert.ok(v >= -1 && v <= 1, `${shape}(${p}) = ${v} outside [-1, 1]`);
    }
  }
});

test('waveShapePoints returns a Float32Array of n finite samples', () => {
  for (const n of [2, 3, 7, 64, 257]) {
    const pts = waveShapePoints('sine', n);
    assert.ok(pts instanceof Float32Array, `n=${n}: not a Float32Array`);
    assert.equal(pts.length, n, `n=${n}: wrong length`);
    for (let i = 0; i < n; i++)
      assert.ok(Number.isFinite(pts[i]), `n=${n}, i=${i}: not finite`);
  }
});

// The only math pin: the sine series equals the hand-computed
// Math.sin(i·2π/(n−1)) — same formula, same FP operations — rounded
// the way a Float32Array stores it (the return type; the previews
// consume the samples directly). Byte equality against the f32
// rounding of the double locks both the phase grid and the rounding.
test('waveShapePoints: sine series matches Math.sin(i·2π/(n−1)) hand-computed', () => {
  const f32 = new Float32Array(1);
  // Store, then READ BACK: the assignment expression yields the raw
  // double, while the read yields the stored (rounded) float32.
  const asF32 = (x) => {
    f32[0] = x;
    return f32[0];
  };
  for (const n of [2, 5, 32, 100]) {
    const pts = waveShapePoints('sine', n);
    for (let i = 0; i < n; i++) {
      const expected = Math.sin((i * TWO_PI) / (n - 1));
      assert.equal(pts[i], asF32(expected), `n=${n}, i=${i}: ${pts[i]} vs ${expected}`);
    }
  }
});

test('waveShapePoints: n = 1 is the degenerate span (phase 0 only)', () => {
  for (const shape of WAVE_SHAPES) {
    const pts = waveShapePoints(shape, 1);
    assert.equal(pts.length, 1, `${shape}: length`);
    assert.equal(pts[0], shapeSample(shape, 0), `${shape}: value`);
  }
});

test('waveShapePoints: series lands on each shape\'s endpoints', () => {
  // First sample at phase 0, last sample at the wrap (phase 2π).
  // The wrap values are all exact in FP: square(2π) = -1, saw(2π) =
  // 2π/π − 1 = 1, tri(2π) = −1; sine(2π) = Math.sin(2π) ≈ −2.4e-16,
  // so sine gets a tolerance there.
  const n = 17;
  const check = (shape, first, last) => {
    const pts = waveShapePoints(shape, n);
    assert.equal(pts[0], first, `${shape} first`);
    assert.ok(
      Math.abs(pts[n - 1] - last) < 1e-15,
      `${shape} last: ${pts[n - 1]} (expected ~${last})`,
    );
  };
  check('sine', 0, 0);
  check('square', 1, -1);
  check('saw', -1, 1);
  check('triangle', -1, -1);
});

test('waveShapePoints throws descriptively for non-positive or non-integer n', () => {
  // The band.js pitchCurvePoints n-validation precedent.
  for (const bad of [0, -1, -17, 1.5, 2.7, NaN]) {
    assert.throws(
      () => waveShapePoints('sine', bad),
      (err) =>
        err instanceof Error &&
        err.message === `waveShapePoints: n must be a positive integer, got ${bad}`,
      `did not throw the expected message for n=${String(bad)}`,
    );
  }
});

test('waveShapePoints throws via shapeSample for unknown shapes, naming the value', () => {
  for (const bad of ['pulse', undefined, '']) {
    assert.throws(
      () => waveShapePoints(bad, 8),
      (err) =>
        err instanceof Error &&
        err.message ===
          `osc: unknown wave shape "${bad}" (expected sine / square / saw / triangle)`,
      `did not throw the expected message for ${String(bad)}`,
    );
  }
});

test('square is exactly 50 % high / 50 % low and matches sign(sin)', () => {
  let highs = 0;
  let lows = 0;
  let phase = 0;
  for (let n = 0; n < 10; n++) {
    const s = squareSample(phase);
    if (s === 1) highs += 1;
    else if (s === -1) lows += 1;
    else assert.fail(`squareSample returned ${s}`);
    phase = phaseAdvance(phase, 100, SR);
  }
  assert.equal(highs, 5);
  assert.equal(lows, 5);

  // Equivalent to sign(sin(phase)) away from the zero crossings, where
  // FP noise makes Math.sin(π) ≈ ±1e-16 instead of exactly 0.
  const rand = mulberry32(7);
  for (let n = 0; n < 10000; n++) {
    const p = rand() * TWO_PI;
    const sin = Math.sin(p);
    if (Math.abs(sin) < 1e-6) continue;
    assert.equal(squareSample(p), Math.sign(sin), `phase ${p}`);
  }
});
