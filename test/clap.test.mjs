// Clap voice tests (P9/S23).
//
// Test parameters per GUIDELINES §4: low rate, short duration — 8 kHz /
// 0.5 s (4000 samples) — property-based assertions only, never
// full-buffer equality. The recipe's highest cutoff (2.5 kHz) is below
// the 4 kHz Nyquist, so no hihat-style rate adaptation is needed.
//
// The re-slap structure test is a PROPERTY assertion on windowed
// energies (plan S23: "energy has a secondary peak in the 10–40 ms
// window"), never a full-buffer comparison.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPatch } from '../src/lib/engine.js';
import { clapPatch } from '../src/lib/voices/clap.js';

const SR = 8000;
const DURATION = 0.5;

// ── small buffer-property helpers (house style, test-local) ───────────

const maxAbs = (buf) => {
  let m = 0;
  for (let n = 0; n < buf.length; n++)
    m = Math.max(m, Math.abs(buf[n]));
  return m;
};

// Σx² over the [t0, t1) second window.
const windowEnergy = (buf, t0, t1) => {
  let e = 0;
  for (let n = Math.round(t0 * SR); n < Math.round(t1 * SR); n++)
    e += buf[n] * buf[n];
  return e;
};

const maxAbsDiff = (a, b) => {
  let m = 0;
  for (let n = 0; n < a.length; n++) {
    const d = Math.abs(a[n] - b[n]);
    if (d > m) m = d;
  }
  return m;
};

// ── tests ─────────────────────────────────────────────────────────────

test('rendered hit: correct length, non-silent, bounded ±1', () => {
  const buf = renderPatch(clapPatch(), { sampleRate: SR, duration: DURATION });
  assert.ok(buf instanceof Float32Array, 'renderPatch returns a Float32Array');
  assert.equal(buf.length, Math.round(DURATION * SR), 'length');
  // The first slap's peak is the burst's normalized 1.0 × the 0.9 layer
  // gain (drum_generation.md Clap), so a healthy render peaks near 0.9.
  assert.ok(
    maxAbs(buf) > 0.01,
    `max |sample| = ${maxAbs(buf)} (expected > 0.01)`,
  );
  for (let n = 0; n < buf.length; n++)
    assert.ok(
      Math.abs(buf[n]) <= 1,
      `sample ${n} = ${buf[n]} outside ±1`,
    );
});

test('re-slap structure: a secondary energy peak inside the 10–40 ms window', () => {
  // The recipe (drum_generation.md, Clap): the first slap is the
  // downbeat at t = 0, then a dip, then re-slaps re-peaking at
  // 16 / 29 ms. So the energy must dip between 6 and 12 ms and
  // RE-PEAK inside the 10–40 ms window — a property of the windows,
  // not of the samples.
  const buf = renderPatch(clapPatch(), { sampleRate: SR, duration: DURATION });
  const firstSlap = windowEnergy(buf, 0, 0.006); // [0, 6 ms) — the downbeat
  const dip = windowEnergy(buf, 0.006, 0.012); // [6, 12 ms) — between slaps
  const reSlap = windowEnergy(buf, 0.012, 0.024); // [12, 24 ms) — re-peak at 16 ms
  assert.ok(
    firstSlap > 1e-6,
    `first-slap energy ${firstSlap} is silent — bad test`,
  );
  assert.ok(
    firstSlap > dip,
    `dip energy ${dip} not < first-slap energy ${firstSlap} — no dip before the re-slap`,
  );
  assert.ok(
    reSlap > dip,
    `re-slap energy ${reSlap} not > dip energy ${dip} — no secondary peak in the 10–40 ms window`,
  );
});

test('the clap decays: the re-slap tail is far quieter than the re-slap peak', () => {
  // Both level gates are fully collapsed by 47 ms (drum_generation.md
  // Clap), so the 200–300 ms window carries essentially nothing while
  // the 12–24 ms window carries the re-slap peak.
  const buf = renderPatch(clapPatch(), { sampleRate: SR, duration: DURATION });
  const reSlap = windowEnergy(buf, 0.012, 0.024);
  const late = windowEnergy(buf, 0.2, 0.3);
  assert.ok(
    late < reSlap,
    `late-window energy ${late} not < re-slap energy ${reSlap} — no decay`,
  );
});

test('parameter plumbing: changing the noise cutoff changes the render', () => {
  // The cutoff is the one spectral knob of a noise layer
  // (filteredNoiseBurst, src/lib/noise.js): retuning slap 1 from the
  // recipe's 2.5 kHz up to 3.5 kHz re-shapes the burst's spectrum and
  // therefore the render.
  const a = renderPatch(clapPatch(), { sampleRate: SR, duration: DURATION });
  const b = renderPatch(
    clapPatch({ slap1: { cutoff: 3500 } }),
    { sampleRate: SR, duration: DURATION },
  );
  assert.ok(
    maxAbsDiff(a, b) > 1e-3,
    `max |diff| = ${maxAbsDiff(a, b)} (expected > 1e-3 — parameter had no effect)`,
  );
  // ... and the recipe value really did reach the built patch:
  const patch = clapPatch({ slap1: { cutoff: 3500 } });
  assert.equal(patch.layers[0].cutoff, 3500);
});

test('overrides deep-merge over defaults (partial override keeps the rest)', () => {
  const patch = clapPatch({ slap2: { cutoff: 3000 } });
  // The overridden value reaches the built patch:
  assert.equal(patch.layers[1].cutoff, 3000);
  // Untouched recipe values survive the merge (drum_generation.md
  // Clap): three noise layers, seeds 3/4/5, cutoffs 2.5/2.1/1.6 kHz,
  // 30 ms burst time constant, gains 0.9/0.8/0.7, and each slap's
  // 4-point level gate (silent until `off`, re-peak at `peak`, gone
  // after `release`, the levelEnvelope knee at half release / 25 %).
  assert.equal(patch.layers.length, 3);
  for (let i = 0; i < 3; i++)
    assert.equal(patch.layers[i].type, 'noise');
  assert.deepEqual(
    patch.layers.map((l) => l.seed),
    [3, 4, 5],
  );
  assert.deepEqual(
    patch.layers.map((l) => l.cutoff),
    [2500, 3000, 1600],
  );
  assert.deepEqual(
    patch.layers.map((l) => l.decay),
    [0.03, 0.03, 0.03],
  );
  assert.deepEqual(
    patch.layers.map((l) => l.gain),
    [0.9, 0.8, 0.7],
  );
  assert.deepEqual(patch.layers[0].levelEnv, [
    { t: 0, v: 0 },
    { t: 0.003, v: 1 },
    { t: 0.003 + 0.012 / 2, v: 0.25 },
    { t: 0.003 + 0.012, v: 0 },
  ]);
  assert.deepEqual(patch.layers[1].levelEnv, [
    { t: 0.014, v: 0 },
    { t: 0.016, v: 1 },
    { t: 0.016 + 0.015 / 2, v: 0.25 },
    { t: 0.016 + 0.015, v: 0 },
  ]);
  assert.deepEqual(patch.layers[2].levelEnv, [
    { t: 0.026, v: 0 },
    { t: 0.029, v: 1 },
    { t: 0.029 + 0.018 / 2, v: 0.25 },
    { t: 0.029 + 0.018, v: 0 },
  ]);
  assert.deepEqual(patch.masterEffects, []);
});

test('fresh arrays per call: two builds never share state', () => {
  const a = clapPatch();
  const b = clapPatch();
  assert.notEqual(a, b, 'distinct patch objects');
  assert.notEqual(a.layers, b.layers, 'distinct layers arrays');
  for (let i = 0; i < 3; i++) {
    assert.notEqual(a.layers[i], b.layers[i], `distinct layer ${i} objects`);
    assert.notEqual(a.layers[i].levelEnv, b.layers[i].levelEnv);
  }
});

test('determinism: same patch → byte-identical buffer', () => {
  const a = renderPatch(clapPatch(), { sampleRate: SR, duration: DURATION });
  const b = renderPatch(clapPatch(), { sampleRate: SR, duration: DURATION });
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
});
