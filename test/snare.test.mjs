import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPatch } from '../src/lib/engine.js';
import { snarePatch } from '../src/lib/voices/snare.js';
import {
  descriptorRead,
  describePatch,
} from '../src/app/controls.js';
import { goertzelMag } from '../src/lib/index.js';

// Test parameters per plan step 11 and GUIDELINES §4: sr 8000, 0.5 s
// (4000 samples), property-based assertions only — never full-buffer
// equality.

const SR = 8000;
const DURATION = 0.5;

// Goertzel sweep for band energy: 50 Hz … 4000 Hz in 50 Hz steps (the
// kick-test grid — every band boundary used below lands on it).
const FREQS = [];
for (let f = 50; f <= 4000; f += 50) FREQS.push(f);

// Finer 10 Hz sweep for the shell-ring window: 330 Hz sits exactly on
// this grid (the 50 Hz grid only has 300/350 Hz near it, and a 120 ms
// window's 8.33 Hz bin spacing leaves only ~2 % of a 330 Hz component's
// power at those offsets).
const FINE_FREQS = [];
for (let f = 50; f <= 4000; f += 10) FINE_FREQS.push(f);

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

// Σ |X(f)|² (Goertzel magnitudes squared) over the [lo, hi) Hz band,
// summed over the given sweep grid.
const bandEnergy = (win, lo, hi, grid = FREQS) => {
  let e = 0;
  for (const f of grid) {
    if (f >= lo && f < hi) {
      const m = goertzelMag(win, f, SR);
      e += m * m;
    }
  }
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

// Minimal nested-path resolver (src/lib/params.js lands in step 13); enough
// to prove every descriptor path addresses live data in the patch.
const getPath = (obj, path) =>
  path.split('.').reduce((o, k) => (o === undefined || o === null ? o : o[k]), obj);

// ── tests ─────────────────────────────────────────────────────────────

test('rendered hit: correct length, non-silent, bounded ±1', () => {
  const buf = renderPatch(snarePatch(), { sampleRate: SR, duration: DURATION });
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

test('decay: late-window energy < 0.3 × attack-window energy', () => {
  // The body level envelope ends at ~203 ms and the shell's at ~153 ms,
  // so the 200–400 ms window carries only the wire burst's e^(-t/120 ms)
  // residue (amplitude ≤ 0.19 there), while 0–20 ms carries the full
  // attack (body + shell + wires at near-peak envelope). Measured
  // late/early ≈ 0.9 % — the 30 % threshold has ~30× margin.
  const buf = renderPatch(snarePatch(), { sampleRate: SR, duration: DURATION });
  const early = windowEnergy(buf, 0, 0.02);
  const late = windowEnergy(buf, 0.2, 0.4);
  assert.ok(
    early > 1e-6,
    `attack-window energy ${early} is silent — bad test`,
  );
  assert.ok(
    late < 0.3 * early,
    `late-window energy ${late} not < 0.3 × attack-window energy ${early}`,
  );
});

test('noise character: early high-band (≥ 1.5 kHz) energy ≥ 30 % of early total', () => {
  // "Early total" is measured over 1–4 kHz, not the full 50 Hz–4 kHz
  // sweep: the tonal body (180 Hz) and shell (330 Hz) sit below 1 kHz
  // and would swamp the noise-like content (same band choice as the
  // kick click test). In 1–4 kHz the only recipe sources are the wire
  // noise (1.5 kHz high-pass burst) and the body's dense 2700 Hz-spaced
  // sidebands from the index-12 collapse in the first 15 ms (many alias
  // into 1–4 kHz at 8 kHz) — the plan's "noisy metallic component
  // (wires + metallic FM)". Measured on the default recipe: ≈ 99 %
  // (the metallic FM sidebands carry ~97 % of the band; the wires alone
  // already satisfy the threshold, as a 1.5 kHz high-pass burst must —
  // so this is the plan's character check, not a layer pin: the shell
  // is pinned by the ring test below, the body FM by the index plumbing
  // test).
  const buf = renderPatch(snarePatch(), { sampleRate: SR, duration: DURATION });
  const early = window(buf, 0, 0.03);
  const high = bandEnergy(early, 1500, 4000);
  const total = bandEnergy(early, 1000, 4000);
  assert.ok(
    total > 1e-9,
    `early 1–4 kHz total energy ${total} is silent — bad test`,
  );
  assert.ok(
    high >= 0.3 * total,
    `early high-band energy ${high} < 30 % of 1–4 kHz total ${total} — noise character missing`,
  );
});

test('shell ring: 330 Hz energy in 30–150 ms > 25 % of window total', () => {
  // Plan's primary formulation ("330 Hz in 30–150 ms > 1.5× its 0–5 ms
  // value relative to decay") is unachievable here, so the plan's
  // fallback is asserted: the Q 5 resonator's own ring decay is
  // ≈ 2Q/sin(ω0) ≈ 39 samples ≈ 5 ms at 8 kHz (src/lib/effects.js) — far
  // shorter than the shell's 150 ms level envelope — so the 330 Hz
  // level tracks the envelope instead of out-ringing it. The meaningful
  // check is that the 330 Hz shell mode dominates the mid window: after
  // the FM index collapse (15 ms) the body is a pure 180 Hz tone and the
  // wire rattle is thin broadband, so 330 Hz must carry > 25 % of all
  // swept energy in 30–150 ms. The total uses the 10 Hz grid so the
  // 330 Hz bin sits exactly on it (see FINE_FREQS note).
  // Measured on the default recipe: ≈ 38 % (the 180 Hz body tone is the
  // rest of the window at ≈ 42 %); with the shell layer muted the 330 Hz
  // bin holds only wire-noise leakage (≈ 0.02 % of the total), so this
  // pins the shell.
  const buf = renderPatch(snarePatch(), { sampleRate: SR, duration: DURATION });
  const win = window(buf, 0.03, 0.15);
  const shell = goertzelMag(win, 330, SR);
  const total = bandEnergy(win, 0, 4001, FINE_FREQS);
  assert.ok(
    total > 1e-9,
    `window 30–150 ms total energy ${total} is silent — bad test`,
  );
  assert.ok(
    shell * shell >= 0.25 * total,
    `330 Hz energy ${shell * shell} not > 25 % of 30–150 ms window total ${total} — shell ring missing`,
  );
});

test('parameter plumbing: body modulator index 12 → 2 changes the render', () => {
  // The index collapse (15 ms) shapes the entire attack: J1(12)² ≈ 0.05
  // vs J1(2)² ≈ 0.33 sideband power, so the first 15 ms (and the
  // compressor gain they drive) differ clearly.
  const a = renderPatch(snarePatch(), { sampleRate: SR, duration: DURATION });
  const b = renderPatch(
    snarePatch({ body: { modulator: { index: 2 } } }),
    { sampleRate: SR, duration: DURATION },
  );
  assert.ok(
    maxAbsDiff(a, b) > 1e-3,
    `max |diff| = ${maxAbsDiff(a, b)} (expected > 1e-3)`,
  );
});

test('overrides deep-merge over defaults (partial override keeps the rest)', () => {
  const patch = snarePatch({ body: { modulator: { index: 2 } } });
  // The overridden value reaches the built patch (and its index
  // envelope, which is built from the merged value):
  assert.equal(patch.layers[0].modulators[0].index, 2);
  assert.equal(patch.layers[0].modulators[0].indexEnv[0].v, 2);
  // Untouched recipe values survive the merge:
  assert.equal(patch.layers[0].carrier.freq, 180);
  assert.equal(patch.layers[0].modulators[0].freq, 2700);
  assert.equal(patch.layers[0].modulators[0].indexEnv[1].t, 0.015);
  assert.equal(patch.layers[0].gain, 0.6);
  assert.equal(patch.layers[1].carrier.freq, 330);
  assert.deepEqual(patch.layers[1].modulators, []);
  assert.deepEqual(
    patch.layers[1].effects,
    [{ type: 'resonate', freq: 330, q: 5 }],
  );
  assert.equal(patch.layers[2].seed, 2);
  assert.equal(patch.layers[2].cutoff, 1500);
  assert.equal(patch.layers[2].decay, 0.12);
  assert.equal(patch.layers[2].gain, 0.3);
  assert.deepEqual(patch.masterEffects, [
    { type: 'compress', threshold: 0.3, ratio: 3, makeup: 1.2 },
  ]);
});

test('determinism: same patch → byte-identical buffer', () => {
  const a = renderPatch(snarePatch(), { sampleRate: SR, duration: DURATION });
  const b = renderPatch(snarePatch(), { sampleRate: SR, duration: DURATION });
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
});

test('parameter descriptors: well-formed, resolve, defaults within [min, max]', () => {
  const patch = snarePatch();
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
