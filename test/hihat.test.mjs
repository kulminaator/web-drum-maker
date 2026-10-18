import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPatch } from '../src/lib/engine.js';
import { hihatPatch } from '../src/lib/voices/hihat.js';
import {
  descriptorRead,
  describePatch,
} from '../src/app/controls.js';
import { goertzelMag } from '../src/lib/index.js';

// Test parameters per plan step 12 and GUIDELINES §4: sr 16000, 0.25 s
// (4000 samples), property-based assertions only — never full-buffer
// equality.
//
// Why 16 kHz instead of the other voices' 8 kHz: the hat's top partial
// is 4000 × 5.119 ≈ 20.48 kHz, which would alias to garbage at an 8 kHz
// rate (Nyquist 4 kHz). At 16 kHz the three lowest partials
// (4000 / 4924 / 5368 Hz) stay clean and the top three fold
// predictably into the spectrum:
//   8412 Hz  →  7588 Hz (16000 − 8412)
//   13948 Hz →  2052 Hz (16000 − 13948)
//   20476 Hz →  4476 Hz (20476 − 16000)
// The spectral tests below use that alias map. (At the 44.1 kHz
// playback rate nothing aliases: 20.48 kHz < 22.05 kHz Nyquist.)
//
// Two rate-related adaptations, both forced by the 16 kHz rate:
// (1) The recipe's 8 kHz high-pass sits exactly at the 16 kHz Nyquist,
//     which renderPatch rejects (cutoff must be < sr/2). Every render
//     here uses { highpass: 4000 } — the cutoff at the base partial,
//     keeping the recipe's "high-pass at/above the lowest partial"
//     character. The default 8000 Hz value is pinned on the built
//     patch by the deep-merge test below.
// (2) The plan's literal high band (a 7.9–8.0 kHz bin sweep) is empty
//     at 16 kHz — no partial or alias lands there (see the map above) —
//     so "high-frequency content" is measured as the energy in the
//     upper half of the spectrum, [4000, 8000] Hz, against the energy
//     below 4 kHz: the high-pass + ratio spread put five of the six
//     layers' energy at/above 4 kHz, and only the 13948 Hz alias
//     (2052 Hz) + windowing leakage sits below it.

const SR = 16000;
const DURATION = 0.25;

// Every render uses the test-rate high-pass (see header note 1).
const render = (overrides = {}) =>
  renderPatch(
    hihatPatch({ highpass: 4000, ...overrides }),
    { sampleRate: SR, duration: DURATION },
  );

// The recipe's six partials: base 4000 Hz × the OPL/TR-909 ratios.
const RATIOS = [1.000, 1.231, 1.342, 2.103, 3.487, 5.119];
const PARTIALS = RATIOS.map((r) => 4000 * r); // 4000 … 20476 Hz

// 10 Hz sweep grid over [100, 8000] Hz. The Goertzel window is the whole
// 0.25 s buffer (4 Hz bin spacing), so a 10 Hz grid lands within 2 Hz of
// every effective partial frequency (all exact bins) and captures each
// at ≈ full magnitude.
const FREQS = [];
for (let f = 100; f <= 8000; f += 10) FREQS.push(f);

// ── small buffer-property helpers (house style) ──────────────────────

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

// RMS over the [t0, t1) second window.
const windowRms = (buf, t0, t1) => {
  const a = Math.round(t0 * SR);
  const b = Math.round(t1 * SR);
  let e = 0;
  for (let n = a; n < b; n++) e += buf[n] * buf[n];
  return Math.sqrt(e / (b - a));
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

const maxAbsDiff = (a, b) => {
  let m = 0;
  for (let n = 0; n < a.length; n++) {
    const d = Math.abs(a[n] - b[n]);
    if (d > m) m = d;
  }
  return m;
};

const closeTo = (a, b, eps) => Math.abs(a - b) < eps;

// Minimal nested-path resolver (src/lib/params.js lands in step 13); enough
// to prove every descriptor path addresses live data in the patch.
const getPath = (obj, path) =>
  path.split('.').reduce((o, k) => (o === undefined || o === null ? o : o[k]), obj);

// ── tests ─────────────────────────────────────────────────────────────

test('rendered hit: correct length, non-silent, bounded ±1', () => {
  const buf = render();
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

test('fast decay: RMS(60–90 ms) < 0.25 × RMS(0–10 ms)', () => {
  // The per-layer level envelopes end at 71–91 ms (1 ms attack + the
  // staggered 70–90 ms decays), so the 60–90 ms window carries only the
  // final envelope legs while 0–10 ms carries the full attack.
  // Measured: late/early ≈ 0.078 (threshold 0.25).
  const buf = render();
  const early = windowRms(buf, 0, 0.01);
  const late = windowRms(buf, 0.06, 0.09);
  assert.ok(
    early > 1e-6,
    `attack-window RMS ${early} is silent — bad test`,
  );
  assert.ok(
    late < 0.25 * early,
    `late-window RMS ${late} not < 0.25 × attack-window RMS ${early}`,
  );
});

test('high-frequency content: [4000, 8000] Hz energy > 2 × energy below 4 kHz', () => {
  // The hat is the only recipe whose six partials all sit at/above the
  // base partial (4000 Hz), and the high-pass keeps most of the energy
  // up there: at/above 4 kHz the five clean-or-aliased partials
  // (4000, 4924, 5368, 7588 ← 8412, 4476 ← 20476) land, while below
  // 4 kHz only the 13948 Hz alias (2052 Hz) + windowing leakage of the
  // 4000 Hz tone remains. The [4000, 8000] band is the upper half of
  // the 16 kHz spectrum — see header note 2 for why the plan's literal
  // 7.9–8.0 kHz band is empty here.
  // Measured: high/low ≈ 17 (threshold 2).
  const buf = render();
  const high = bandEnergy(buf, 4000, 8001);
  const low = bandEnergy(buf, 100, 4000);
  assert.ok(
    low > 1e-9,
    `energy below 4 kHz ${low} is silent — bad test (the 13948 Hz alias should land here)`,
  );
  assert.ok(
    high > 2 * low,
    `[4000, 8000] Hz energy ${high} not > 2 × below-4 kHz energy ${low} — high-pass + ratio spread missing`,
  );
});

test('inharmonicity: ≥ 4 of the 6 expected partials show Goertzel peaks > 5 % of max', () => {
  // Each of the six expected partials (base × ratio) must appear in the
  // spectrum — the "dense beating" needs at least four of them present
  // at comparable strength. The ±20 Hz tolerance is ±5 Goertzel bins at
  // the 4 Hz spacing. A Goertzel at f > sr/2 measures the folded alias
  // bin — that is exactly how the 13948 / 20476 Hz partials are found
  // here (at 2052 / 4476 Hz).
  // Measured: all 6 partials present, 28–100 % of the strongest
  // (threshold 5 %) — the 13948 Hz partial is weakest because it has
  // the mid-stagger decay and its alias (2052 Hz) sits in the
  // high-pass's lower-gain region.
  const buf = render();
  const gm = (f) =>
    Math.max(
      goertzelMag(buf, f - 20, SR),
      goertzelMag(buf, f, SR),
      goertzelMag(buf, f + 20, SR),
    );
  const mags = PARTIALS.map((f) => ({ f, m: gm(f) }));
  const peak = Math.max(...mags.map((x) => x.m));
  const count = mags.filter((x) => x.m > 0.05 * peak).length;
  assert.ok(
    peak > 1e-6,
    `strongest partial peak ${peak} is silent — bad test`,
  );
  assert.ok(
    count >= 4,
    `only ${count} of 6 partials above 5 % of max: ${mags
      .map((x) => `${x.f} Hz = ${((x.m / peak) * 100).toFixed(1)} %`)
      .join(', ')}`,
  );
});

test('parameter plumbing: doubling the decay changes the render and raises late-window energy', () => {
  // The default staggered decays (70–90 ms) end the hit by ~91 ms, so
  // the 100–200 ms window is silent; doubling the decay (staggered
  // 140–180 ms, release ends 141–181 ms) fills that window with the
  // ringing partials.
  // Measured: late(100–200 ms) 0 → 0.867, max |diff| ≈ 0.27.
  const a = render();
  const b = render({ levelEnv: { decay: 0.16 } });
  assert.ok(
    maxAbsDiff(a, b) > 1e-3,
    `max |diff| = ${maxAbsDiff(a, b)} (expected > 1e-3)`,
  );
  const lateA = windowEnergy(a, 0.1, 0.2);
  const lateB = windowEnergy(b, 0.1, 0.2);
  assert.ok(
    lateB > lateA,
    `late-window energy ${lateB} not raised by doubling the decay (was ${lateA})`,
  );
  assert.ok(
    lateB > 0.001 * windowEnergy(b, 0, 0.01),
    `doubled-decay late window (${lateB}) is still silent — the decay knob is not reaching the render`,
  );
});

test('overrides deep-merge over defaults (partial override keeps the rest)', () => {
  const patch = hihatPatch({ levelEnv: { decay: 0.16 } });
  assert.equal(patch.layers.length, 6);
  for (let i = 0; i < 6; i++) {
    assert.equal(patch.layers[i].type, 'fm');
    assert.deepEqual(patch.layers[i].modulators, []);
    // Carrier frequencies are built (base × ratio), hence the epsilon.
    assert.ok(
      closeTo(patch.layers[i].carrier.freq, 4000 * RATIOS[i], 1e-6),
      `layer ${i} carrier ${patch.layers[i].carrier.freq} Hz`,
    );
    assert.equal(patch.layers[i].gain, 0.15);
    assert.deepEqual(patch.layers[i].levelEnv[0], { t: 0, v: 0 });
    assert.deepEqual(patch.layers[i].levelEnv[1], { t: 0, v: 0 }); // delay = 0
    assert.equal(patch.layers[i].levelEnv[2].t, 0.001); // default attack survives
  }
  // The decay override reaches the built envelopes, staggered ±10 ms
  // (layer 0: 0.16 − 0.01 = 0.15 s decay → 0.151 s release end;
  // layer 5: 0.16 + 0.01 = 0.17 s decay → 0.171 s release end — the
  // canonical pts[5] role):
  assert.ok(closeTo(patch.layers[0].levelEnv[5].t, 0.151, 1e-9));
  assert.ok(closeTo(patch.layers[5].levelEnv[5].t, 0.171, 1e-9));
  // Untouched recipe values survive the merge:
  assert.deepEqual(patch.masterEffects, [{ type: 'highpass', cutoff: 8000 }]);

  // The default patch carries the plan's 70–90 ms staggered releases:
  const d = hihatPatch();
  for (let i = 0; i < 6; i++) {
    const decay = 0.08 + 0.02 * (i / 5 - 0.5); // 0.07 … 0.09 s
    assert.ok(closeTo(d.layers[i].levelEnv[5].t, 0.001 + decay, 1e-9));
  }
  assert.deepEqual(d.masterEffects, [{ type: 'highpass', cutoff: 8000 }]);
});

test('determinism: same patch → byte-identical buffer', () => {
  const a = render();
  const b = render();
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
});

test('parameter descriptors: well-formed, resolve, defaults within [min, max]', () => {
  const patch = hihatPatch();
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
