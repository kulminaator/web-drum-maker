import test from 'node:test';
import assert from 'node:assert/strict';
import { mixLayers, applyGain } from '../src/lib/layer.js';
import { whiteNoiseBuffer } from '../src/lib/noise.js';

// Realistic inputs: seeded white noise in [-1, 1) (the actual range a
// rendered engine layer sits in after noise.js normalization). 1024
// samples keeps the run fast; the mixing math is per-sample, so length
// beyond a few dozen samples adds no coverage.
const LENGTH = 1024;
const a = whiteNoiseBuffer(LENGTH, 7);
const b = whiteNoiseBuffer(LENGTH, 8);

// Max |got − want| over sample-wise arrays, with a 1e-6 absolute
// tolerance per plan step 6 (float32 storage adds ~6e-8 relative error,
// well under it).
const maxDiff = (got, want) => {
  let worst = 0;
  for (let n = 0; n < want.length; n += 1) {
    const d = Math.abs(got[n] - want[n]);
    if (d > worst) worst = d;
  }
  return worst;
};

const assertCloseSamplewise = (got, want, label) => {
  assert.ok(
    got instanceof Float32Array && got.length === want.length,
    `${label}: expected a Float32Array of length ${want.length}`,
  );
  const worst = maxDiff(got, want);
  assert.ok(
    worst < 1e-6,
    `${label}: max sample-wise difference ${worst} not < 1e-6`,
  );
};

test('linearity: mixLayers([a, b], [1, 1]) = a + b sample-wise', () => {
  const want = new Float64Array(LENGTH);
  for (let n = 0; n < LENGTH; n += 1) want[n] = a[n] + b[n];
  assertCloseSamplewise(mixLayers([a, b], [1, 1]), want, 'a + b');
});

test('scaling: mixLayers([a], [0.5]) = 0.5·a', () => {
  const want = new Float64Array(LENGTH);
  for (let n = 0; n < LENGTH; n += 1) want[n] = 0.5 * a[n];
  assertCloseSamplewise(mixLayers([a], [0.5]), want, '0.5·a');
});

test('scaling: gains [0, 0] → all zeros', () => {
  const out = mixLayers([a, b], [0, 0]);
  assert.ok(out.length === LENGTH, 'output length mismatch');
  for (let n = 0; n < LENGTH; n += 1) {
    assert.equal(out[n], 0, `sample ${n} = ${out[n]}, expected exactly 0`);
  }
});

test('linearity with non-unit gains: mix([a, b], [2, 3]) = 2a + 3b', () => {
  const want = new Float64Array(LENGTH);
  for (let n = 0; n < LENGTH; n += 1) want[n] = 2 * a[n] + 3 * b[n];
  assertCloseSamplewise(mixLayers([a, b], [2, 3]), want, '2a + 3b');
});

test('length mismatch throws a descriptive error', () => {
  const short = whiteNoiseBuffer(LENGTH - 1, 9);
  assert.throws(
    () => mixLayers([a, short], [1, 1]),
    /length 1023.*expected 1024|expected 1024.*1023/s,
  );
  // A too-long buffer is caught as well (first buffer sets the length).
  const long = whiteNoiseBuffer(LENGTH + 1, 10);
  assert.throws(() => mixLayers([a, long], [1, 1]), /length/);
});

test('gains count mismatch throws a descriptive error', () => {
  assert.throws(() => mixLayers([a, b], [1]), /expected 2 gains.*got 1/s);
  assert.throws(() => mixLayers([a], [1, 2]), /expected 1 gain.*got 2/s);
});

test('inputs are not mutated by mixLayers', () => {
  const aBefore = Float32Array.from(a);
  const bBefore = Float32Array.from(b);
  mixLayers([a, b], [2, 3]);
  assert.deepEqual(
    Buffer.from(a.buffer),
    Buffer.from(aBefore.buffer),
    'first buffer was mutated',
  );
  assert.deepEqual(
    Buffer.from(b.buffer),
    Buffer.from(bBefore.buffer),
    'second buffer was mutated',
  );
});

test('applyGain: scales a copy and leaves the input untouched', () => {
  const before = Float32Array.from(a);
  const out = applyGain(a, 0.5);
  assert.notEqual(out, a, 'applyGain must return a new buffer');
  assertCloseSamplewise(
    out,
    Float64Array.from(a.map((v) => 0.5 * v)),
    'applyGain 0.5',
  );
  assert.deepEqual(
    Buffer.from(a.buffer),
    Buffer.from(before.buffer),
    'applyGain mutated its input',
  );
});
