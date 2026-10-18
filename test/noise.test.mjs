import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32,
  whiteNoiseBuffer,
  filteredNoiseBurst,
} from '../src/lib/noise.js';
import { goertzelMag } from '../src/lib/index.js';

// Test parameters per plan step 4: sr 16000 and cutoff 2000 for the
// high-pass character test. 0.5 s (8000 samples) keeps the run fast while
// giving the decay test well-separated quarter windows.
const SR = 16000;
const LENGTH = 8000;
const CUTOFF = 2000;
const DECAY = 0.1; // 100 ms — snare-wire range (drum_generation.md)

// Seed 3 is fixed by design: noise-bin Goertzel magnitudes vary per seed
// (Rayleigh-distributed), and 3 gives a comfortable margin on the
// high-pass ratio (measured ≈ 0.011 vs the 0.1 threshold).
const BURST_SEED = 3;

const burst = (seed = BURST_SEED) =>
  filteredNoiseBurst({
    length: LENGTH,
    sr: SR,
    seed,
    cutoff: CUTOFF,
    decay: DECAY,
  });

// RMS of buf[from..to) — helper for the decay test.
const rms = (buf, from, to) => {
  let sum = 0;
  for (let n = from; n < to; n++) sum += buf[n] * buf[n];
  return Math.sqrt(sum / (to - from));
};

test('mulberry32: same seed → same stream, values in [0, 1)', () => {
  const r1 = mulberry32(987);
  const r2 = mulberry32(987);
  for (let i = 0; i < 1000; i++) {
    const v1 = r1();
    const v2 = r2();
    assert.equal(v1, v2, `draw ${i} differs for the same seed`);
    assert.ok(v1 >= 0 && v1 < 1, `value ${v1} outside [0, 1)`);
  }
});

test('determinism: same seed → byte-identical buffers, different seed → different', () => {
  // White noise.
  const w1 = whiteNoiseBuffer(LENGTH, 11);
  const w2 = whiteNoiseBuffer(LENGTH, 11);
  assert.deepEqual(Buffer.from(w1.buffer), Buffer.from(w2.buffer));
  const w3 = whiteNoiseBuffer(LENGTH, 12);
  let differs = 0;
  for (let n = 0; n < LENGTH; n++) if (w1[n] !== w3[n]) differs += 1;
  assert.ok(
    differs > LENGTH / 2,
    `seeds 11 vs 12 differ in only ${differs}/${LENGTH} samples`,
  );

  // Filtered burst (filter + envelope + normalization are all
  // deterministic functions of the seed).
  const b1 = burst(21);
  const b2 = burst(21);
  assert.deepEqual(Buffer.from(b1.buffer), Buffer.from(b2.buffer));
  const b3 = burst(22);
  differs = 0;
  for (let n = 0; n < LENGTH; n++) if (b1[n] !== b3[n]) differs += 1;
  assert.ok(
    differs > LENGTH / 2,
    `seeds 21 vs 22 differ in only ${differs}/${LENGTH} samples`,
  );
});

test('bounds: all samples within ±1', () => {
  for (const buf of [whiteNoiseBuffer(LENGTH, 11), burst()]) {
    for (let n = 0; n < buf.length; n++) {
      assert.ok(
        buf[n] >= -1 && buf[n] <= 1,
        `sample ${n} = ${buf[n]} outside [-1, 1]`,
      );
    }
  }
});

test('high-pass character: 500 Hz < 0.1 × 4000 Hz at cutoff 2000 / sr 16000', () => {
  const buf = burst();
  const mag500 = goertzelMag(buf, 500, SR);
  const mag4000 = goertzelMag(buf, 4000, SR);
  assert.ok(
    mag500 < 0.1 * mag4000,
    `500 Hz magnitude ${mag500} not < 0.1 × ${mag4000} at 4000 Hz`,
  );
});

test('decay: RMS of last quarter < 0.25 × RMS of first quarter', () => {
  const buf = burst();
  const q = LENGTH / 4;
  const first = rms(buf, 0, q);
  const last = rms(buf, 3 * q, LENGTH);
  assert.ok(
    last < 0.25 * first,
    `last-quarter RMS ${last} not < 0.25 × first-quarter RMS ${first}`,
  );
});

test('non-silent: max |sample| > 0.01', () => {
  for (const buf of [whiteNoiseBuffer(LENGTH, 11), burst()]) {
    let maxAbs = 0;
    for (let n = 0; n < buf.length; n++) {
      const mag = Math.abs(buf[n]);
      if (mag > maxAbs) maxAbs = mag;
    }
    assert.ok(maxAbs > 0.01, `buffer too quiet, max |sample| = ${maxAbs}`);
  }
});
