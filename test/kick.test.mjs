import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPatch } from '../src/lib/engine.js';
import { kickPatch } from '../src/lib/voices/kick.js';
import {
  descriptorRead,
  describePatch,
} from '../src/app/controls.js';
import { goertzelMag } from '../src/lib/index.js';

// Test parameters per plan step 10 and GUIDELINES §4: sr 8000, 0.5 s
// (4000 samples), property-based assertions only — never full-buffer
// equality.

const SR = 8000;
const DURATION = 0.5;

// Goertzel sweep: 50 Hz … 4000 Hz in 50 Hz steps (80 bins, covering
// everything below Nyquist at 8 kHz that the recipe can produce).
const FREQS = [];
for (let f = 50; f <= 4000; f += 50) FREQS.push(f);

// ── small buffer-property helpers ────────────────────────────────────

const maxAbs = (buf) => {
  let m = 0;
  for (let n = 0; n < buf.length; n++) {
    const a = Math.abs(buf[n]);
    if (a > m) m = a;
  }
  return m;
};

// buf slice over the [t0, t1) second window.
const window = (buf, t0, t1) =>
  buf.slice(Math.round(t0 * SR), Math.round(t1 * SR));

// Σx² over the [t0, t1) second window.
const windowEnergy = (buf, t0, t1) => {
  let e = 0;
  for (let n = Math.round(t0 * SR); n < Math.round(t1 * SR); n++)
    e += buf[n] * buf[n];
  return e;
};

// Σ |X(f)|² (Goertzel magnitudes squared) over the [lo, hi) Hz band.
const bandEnergy = (win, lo, hi) => {
  let e = 0;
  for (const f of FREQS) {
    if (f >= lo && f < hi) {
      const m = goertzelMag(win, f, SR);
      e += m * m;
    }
  }
  return e;
};

// Spectral centroid: Σ f·|X(f)| / Σ |X(f)| over the full sweep.
const centroid = (win) => {
  let num = 0;
  let den = 0;
  for (const f of FREQS) {
    const m = goertzelMag(win, f, SR);
    num += f * m;
    den += m;
  }
  return num / den;
};

const maxAbsDiff = (a, b) => {
  let m = 0;
  for (let n = 0; n < a.length; n++) {
    const d = Math.abs(a[n] - b[n]);
    if (d > m) m = d;
  }
  return m;
};

// Minimal nested-path resolver (src/lib/params.js lands in step 13); enough
// to prove every descriptor path addresses live data in the patch.
const getPath = (obj, path) =>
  path.split('.').reduce((o, k) => (o === undefined || o === null ? o : o[k]), obj);

// ── tests ─────────────────────────────────────────────────────────────

test('rendered hit: correct length, non-silent, bounded ±1', () => {
  const buf = renderPatch(kickPatch(), { sampleRate: SR, duration: DURATION });
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
  // Same windowing as the engine test (step 9): the 300 ms level decay
  // means the 200–400 ms window carries only the envelope tail + the
  // click's e^(-10) residue, while 0–20 ms carries the full thump.
  const buf = renderPatch(kickPatch(), { sampleRate: SR, duration: DURATION });
  const early = windowEnergy(buf, 0, 0.02);
  const late = windowEnergy(buf, 0.2, 0.4);
  assert.ok(
    early > 1e-6,
    `attack-window energy ${early} is silent — bad test`,
  );
  assert.ok(
    late < 0.25 * early,
    `late-window energy ${late} not < 0.25 × attack-window energy ${early}`,
  );
});

test('click present: early high-frequency Goertzel energy ≥ 20 % of early total', () => {
  // The body (50 Hz carrier, 200 Hz modulator, index 8 → 0) puts > 99 %
  // of its early energy in the 50–1000 Hz thump cluster — sidebands
  // above 1 kHz carry Bessel weight J5(8)² ≈ 4e-4 or less. The click
  // (2 kHz high-pass noise burst) is the only source above ~1.5 kHz, so
  // "the click is audible in band" is measured there: in the early
  // 0–30 ms window, 1.5–4 kHz energy (the click band) must be ≥ 20 % of
  // the 1–4 kHz total (the band the click is expected to occupy).
  // Measured: ≈ 44 % with the default click; ≈ 15 % when the click
  // layer is muted (body only) — so this assertion pins the click.
  const buf = renderPatch(kickPatch(), { sampleRate: SR, duration: DURATION });
  const early = window(buf, 0, 0.03);
  const high = bandEnergy(early, 1500, 4000);
  const total = bandEnergy(early, 1000, 4000);
  assert.ok(
    total > 1e-9,
    `early 1–4 kHz total energy ${total} is silent — bad test`,
  );
  assert.ok(
    high >= 0.2 * total,
    `early high-band energy ${high} < 20 % of 1–4 kHz total ${total} — click not audible in band`,
  );
});

test('pitch drop present: spectral centroid 0–10 ms > centroid 40–80 ms', () => {
  // 0–10 ms: carrier is mid-glide (100 → 50 Hz) with the index-8
  // sideband burst (dense 200 Hz-spaced partials up to ~1.7 kHz) plus
  // the click — the centroid sits high. 40–80 ms: index = 0, carrier
  // settled at 50 Hz, click nearly gone (e^(-2) amplitude) — the
  // centroid collapses toward the fundamental.
  const buf = renderPatch(kickPatch(), { sampleRate: SR, duration: DURATION });
  const early = centroid(window(buf, 0, 0.01));
  const late = centroid(window(buf, 0.04, 0.08));
  assert.ok(
    early > late,
    `spectral centroid 0–10 ms (${early} Hz) not > 40–80 ms (${late} Hz) — pitch drop missing`,
  );
});

test('parameter plumbing: kickPatch({body: {pitchEnv: {to: 30}}}) changes the render', () => {
  const a = renderPatch(kickPatch(), { sampleRate: SR, duration: DURATION });
  const b = renderPatch(
    kickPatch({ body: { pitchEnv: { to: 30 } } }),
    { sampleRate: SR, duration: DURATION },
  );
  assert.ok(
    maxAbsDiff(a, b) > 1e-3,
    `max |diff| = ${maxAbsDiff(a, b)} (expected > 1e-3)`,
  );
});

test('overrides deep-merge over defaults (partial override keeps the rest)', () => {
  const patch = kickPatch({ body: { pitchEnv: { to: 30 } } });
  // The overridden value reaches the built patch:
  assert.equal(patch.layers[0].pitchEnv[1].v, 30);
  // Untouched recipe values survive the merge:
  assert.equal(patch.layers[0].carrier.freq, 50);
  assert.equal(patch.layers[0].pitchEnv[0].v, 100);
  assert.equal(patch.layers[0].pitchEnv[1].t, 0.03);
  assert.equal(patch.layers[0].modulators[0].freq, 200);
  assert.equal(patch.layers[0].modulators[0].index, 8);
  assert.equal(patch.layers[0].gain, 0.8);
  assert.equal(patch.layers[1].seed, 1);
  assert.equal(patch.layers[1].cutoff, 2000);
  assert.equal(patch.layers[1].decay, 0.02);
  assert.equal(patch.layers[1].gain, 0.2);
  assert.deepEqual(patch.masterEffects, [{ type: 'saturate', drive: 2 }]);
});

test('determinism: same patch → byte-identical buffer', () => {
  const a = renderPatch(kickPatch(), { sampleRate: SR, duration: DURATION });
  const b = renderPatch(kickPatch(), { sampleRate: SR, duration: DURATION });
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
});

test('parameter descriptors: well-formed, resolve, defaults within [min, max]', () => {
  const patch = kickPatch();
  const descriptors = describePatch(patch); // P1/S3: sliders come from the factory
  assert.ok(descriptors.length >= 10, 'expected a full slider set');
  for (const d of descriptors) {
    for (const key of ['path', 'label', 'min', 'max', 'step'])
      assert.ok(key in d, `descriptor missing ${key}: ${JSON.stringify(d)}`);
    assert.ok(d.max > d.min, `descriptor ${d.path}: max not > min`);
    assert.ok(d.step > 0, `descriptor ${d.path}: step not > 0`);
    // The value the CONTROL sees: the raw patch value through the
    // descriptor's optional read transform (the DAHDSR level knobs'
    // raw value is the whole point array, plan "dahdsr" P3/S2).
    const value = descriptorRead(d, getPath(patch, d.path));
    assert.ok(
      Number.isFinite(value),
      `descriptor ${d.label} does not resolve in the built patch`,
    );
    assert.ok(
      value >= d.min && value <= d.max,
      `descriptor ${d.path}: default ${value} outside [${d.min}, ${d.max}]`,
    );
  }
});
