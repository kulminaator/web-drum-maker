// Tom voice tests (P9/S22).
//
// Test parameters per GUIDELINES §4: low rate, short duration — 8 kHz /
// 0.5 s (4000 samples) — property-based assertions only, never
// full-buffer equality. The recipe's frequencies (90 Hz carrier, 270 Hz
// modulator, sidebands at 90 ± n·270 Hz) are all far below the 4 kHz
// Nyquist, so no hihat-style rate adaptation is needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPatch } from '../src/lib/engine.js';
import { tomPatch } from '../src/lib/voices/tom.js';
import { KNEE_CURVE } from '../src/lib/envelopes.js';

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
  const buf = renderPatch(tomPatch(), { sampleRate: SR, duration: DURATION });
  assert.ok(buf instanceof Float32Array, 'renderPatch returns a Float32Array');
  assert.equal(buf.length, Math.round(DURATION * SR), 'length');
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

test('thump decays: late-window energy < attack-window energy', () => {
  // The level envelope (3 ms attack / 250 ms decay, drum_generation.md
  // Tom Tom) is fully collapsed by 253 ms, so the 200–400 ms window
  // carries essentially nothing, while 0–20 ms carries the full thump.
  const buf = renderPatch(tomPatch(), { sampleRate: SR, duration: DURATION });
  const early = windowEnergy(buf, 0, 0.02);
  const late = windowEnergy(buf, 0.2, 0.4);
  assert.ok(
    early > 1e-6,
    `attack-window energy ${early} is silent — bad test`,
  );
  assert.ok(
    late < early,
    `late-window energy ${late} not < attack-window energy ${early} — no decay`,
  );
});

test('parameter plumbing: changing the carrier frequency changes the render', () => {
  // The pitch envelope (140 → 90 Hz) SHADOWS the constant carrier.freq
  // (engine convention, GUIDELINES §2), so the tom's carrier frequency
  // is the envelope's rest pitch: retune the thump up, 90 → 120 Hz.
  const a = renderPatch(tomPatch(), { sampleRate: SR, duration: DURATION });
  const b = renderPatch(
    tomPatch({ body: { pitchEnv: { to: 120 } } }),
    { sampleRate: SR, duration: DURATION },
  );
  assert.ok(
    maxAbsDiff(a, b) > 1e-3,
    `max |diff| = ${maxAbsDiff(a, b)} (expected > 1e-3 — parameter had no effect)`,
  );
});

test('overrides deep-merge over defaults (partial override keeps the rest)', () => {
  const patch = tomPatch({ body: { pitchEnv: { to: 120 } } });
  // The overridden value reaches the built patch:
  assert.equal(patch.layers[0].pitchEnv[1].v, 120);
  // Untouched recipe values survive the merge (drum_generation.md Tom
  // Tom): 90 Hz carrier, 140 Hz glide start at 40 ms, 270 Hz (3:1)
  // modulator at index 4 → 0 in 30 ms, 3 ms / 250 ms level envelope,
  // gain 0.8, one layer, no master FX.
  assert.equal(patch.layers.length, 1);
  assert.equal(patch.layers[0].carrier.freq, 90);
  assert.equal(patch.layers[0].pitchEnv[0].v, 140);
  assert.equal(patch.layers[0].pitchEnv[0].t, 0);
  assert.equal(patch.layers[0].pitchEnv[1].t, 0.04);
  assert.equal(patch.layers[0].modulators.length, 1);
  assert.equal(patch.layers[0].modulators[0].freq, 270);
  assert.equal(patch.layers[0].modulators[0].index, 4);
  assert.equal(patch.layers[0].modulators[0].indexEnv[0].v, 4);
  assert.equal(patch.layers[0].modulators[0].indexEnv[1].t, 0.03);
  assert.equal(patch.layers[0].modulators[0].indexEnv[1].v, 0);
  assert.equal(patch.layers[0].gain, 0.8);
  // The canonical 6-point DAHDSR form: 3 ms / 250 ms with the
  // KNEE_CURVE decay bend (the legacy 4-point knee's exponential
  // collapse), zero spans as duplicate-t points.
  assert.deepEqual(patch.layers[0].levelEnv, [
    { t: 0, v: 0 },
    { t: 0, v: 0 },
    { t: 0.003, v: 1 },
    { t: 0.003, v: 1, curve: KNEE_CURVE },
    { t: 0.003 + 0.25, v: 0 },
    { t: 0.003 + 0.25, v: 0 },
  ]);
  assert.deepEqual(patch.masterEffects, []);
});

test('fresh arrays per call: two builds never share state', () => {
  const a = tomPatch();
  const b = tomPatch();
  assert.notEqual(a, b, 'distinct patch objects');
  assert.notEqual(a.layers, b.layers, 'distinct layers arrays');
  assert.notEqual(a.layers[0], b.layers[0], 'distinct layer objects');
  assert.notEqual(a.layers[0].levelEnv, b.layers[0].levelEnv);
  assert.notEqual(a.layers[0].pitchEnv, b.layers[0].pitchEnv);
  assert.notEqual(
    a.layers[0].modulators[0].indexEnv,
    b.layers[0].modulators[0].indexEnv,
  );
});

test('determinism: same patch → byte-identical buffer', () => {
  const a = renderPatch(tomPatch(), { sampleRate: SR, duration: DURATION });
  const b = renderPatch(tomPatch(), { sampleRate: SR, duration: DURATION });
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
});
