// Cymbal voice tests (P9/S24).
//
// Test parameters per GUIDELINES §4: property-based assertions only,
// never full-buffer equality. Duration 1.5 s — the preset's default
// hit length (src/app/presets.js: 1.5 s), which the plan pins here
// ("length at its 1.5 s default"). Render rate 16 kHz follows
// test/hihat.test.mjs: the top partial is 5000 × 2.514 ≈ 12.57 kHz,
// above the 8 kHz rate's Nyquist (4 kHz), where it would alias to
// 3.43 kHz; at 16 kHz the two lowest partials (5.0 / 6.69 kHz) stay
// clean and the upper two fold predictably (8.91 → 7.09 kHz,
// 12.57 → 3.43 kHz). The property tests below are time-domain
// (windowed energies) and rate-independent; at the 44.1 kHz playback
// rate nothing aliases (12.57 kHz < 22.05 kHz Nyquist).
//
// The long-decay test is the cymbal's defining property vs the
// hi-hat: at 50 % of the 1.5 s duration (0.75 s) the energy is still
// significant, because the per-partial level release ends at 1.5 s
// (drum_generation.md, Cymbal) — the hi-hat's staggered 70–90 ms
// decays make its 0.75 s window exactly zero (measured: cymbal
// mid/early ≈ 0.13, hi-hat mid/early = 0).

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPatch } from '../src/lib/engine.js';
import { cymbalPatch } from '../src/lib/voices/cymbal.js';
import { KNEE_CURVE } from '../src/lib/envelopes.js';

const SR = 16000;
const DURATION = 1.5; // the preset's default duration (src/app/presets.js)

// The recipe's four partials: base 5000 Hz × the cymbal mode ratios.
const RATIOS = [1.000, 1.338, 1.782, 2.514];

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

const closeTo = (a, b, eps) => Math.abs(a - b) < eps;

// ── tests ─────────────────────────────────────────────────────────────

test('rendered hit at the 1.5 s default: correct length, non-silent, bounded ±1', () => {
  const buf = renderPatch(cymbalPatch(), { sampleRate: SR, duration: DURATION });
  assert.ok(buf instanceof Float32Array, 'renderPatch returns a Float32Array');
  assert.equal(buf.length, Math.round(DURATION * SR), 'length');
  // Four 0.2-gain partials at in-phase crests ≈ 0.8 (drum_generation.md
  // Cymbal), so a healthy render peaks near 0.8 — well under the clamp.
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

test('long decay: energy still significant at 50 % of the duration, unlike the hi-hat', () => {
  // The per-partial level release ends at 1.5 s (drum_generation.md
  // Cymbal), so at 50 % of the duration the envelope is at ~0.25 and
  // the ring is still strong — the hi-hat's 70–90 ms decays make the
  // same window exactly zero. The hit still DECAYS: the 90 % window
  // (envelope ~0.05) is far quieter than the 50 % window.
  // Measured: mid/early ≈ 0.13, late/mid ≈ 0.04.
  const buf = renderPatch(cymbalPatch(), { sampleRate: SR, duration: DURATION });
  const early = windowEnergy(buf, 0, 0.01); // [0, 10 ms) — the stick impact
  const mid = windowEnergy(buf, 0.74, 0.76); // [740, 760 ms) — 50 % of 1.5 s
  const late = windowEnergy(buf, 1.34, 1.36); // [1340, 1360 ms) — 90 % of 1.5 s
  assert.ok(
    early > 1e-6,
    `attack-window energy ${early} is silent — bad test`,
  );
  assert.ok(
    mid > 0.02 * early,
    `mid-window energy ${mid} not > 0.02 × attack energy ${early} — no ring at 50 % of the duration (the hi-hat's would be zero here)`,
  );
  assert.ok(
    late < mid,
    `late-window energy ${late} not < mid-window energy ${mid} — no decay`,
  );
});

test('parameter plumbing: retuning a partial ratio changes the render', () => {
  // The top partial is the cymbal's signature (12.57 kHz, the
  // 12–15 kHz band): retuning its ratio 2.514 → 2.2 (12.57 → 11.0 kHz)
  // re-pitches the highest ring tone and its 1.5:1 attack burst, so
  // the render changes.
  const a = renderPatch(cymbalPatch(), { sampleRate: SR, duration: DURATION });
  const b = renderPatch(
    cymbalPatch({ ratios: [1.000, 1.338, 1.782, 2.2] }),
    { sampleRate: SR, duration: DURATION },
  );
  assert.ok(
    maxAbsDiff(a, b) > 1e-3,
    `max |diff| = ${maxAbsDiff(a, b)} (expected > 1e-3 — parameter had no effect)`,
  );
  // ... and the recipe value really did reach the built patch:
  const patch = cymbalPatch({ ratios: [1.000, 1.338, 1.782, 2.2] });
  assert.ok(
    closeTo(patch.layers[3].carrier.freq, 5000 * 2.2, 1e-6),
    `top partial carrier ${patch.layers[3].carrier.freq} Hz`,
  );
  assert.ok(
    closeTo(patch.layers[3].modulators[0].freq, 1.5 * 5000 * 2.2, 1e-6),
    `top partial modulator ${patch.layers[3].modulators[0].freq} Hz`,
  );
});

test('overrides deep-merge over defaults (partial override keeps the rest)', () => {
  const patch = cymbalPatch({ levelEnv: { decay: 1.0 } });
  // The overridden decay reaches the built envelopes (release end =
  // 0.002 + 1.0 = 1.002 s, the canonical pts[5] role):
  for (let i = 0; i < 4; i++)
    assert.ok(
      closeTo(patch.layers[i].levelEnv[5].t, 1.002, 1e-9),
      `layer ${i} release end ${patch.layers[i].levelEnv[5].t} s`,
    );
  // Untouched recipe values survive the merge (drum_generation.md
  // Cymbal): four fm layers, base 5000 Hz × the cymbal mode ratios,
  // one 1.5:1 modulator each with the 2 → 0 / 20 ms FM-depth collapse
  // (the constant index shadowed by the indexEnv, GUIDELINES §2),
  // ~2 ms attack, gain 0.2.
  assert.equal(patch.layers.length, 4);
  for (let i = 0; i < 4; i++) {
    const layer = patch.layers[i];
    assert.equal(layer.type, 'fm');
    assert.ok(
      closeTo(layer.carrier.freq, 5000 * RATIOS[i], 1e-6),
      `layer ${i} carrier ${layer.carrier.freq} Hz`,
    );
    assert.equal(layer.modulators.length, 1);
    assert.ok(
      closeTo(layer.modulators[0].freq, 1.5 * 5000 * RATIOS[i], 1e-6),
      `layer ${i} modulator ${layer.modulators[0].freq} Hz`,
    );
    assert.equal(layer.modulators[0].index, 2);
    assert.deepEqual(layer.modulators[0].indexEnv, [
      { t: 0, v: 2 },
      { t: 0.02, v: 0 },
    ]);
    assert.equal(layer.gain, 0.2);
    // The canonical 6-point DAHDSR form with the KNEE_CURVE decay bend.
    assert.deepEqual(layer.levelEnv, [
      { t: 0, v: 0 },
      { t: 0, v: 0 },
      { t: 0.002, v: 1 },
      { t: 0.002, v: 1, curve: KNEE_CURVE },
      { t: 0.002 + 1.0, v: 0 },
      { t: 0.002 + 1.0, v: 0 },
    ]);
  }
  assert.deepEqual(patch.masterEffects, []);

  // The default patch carries the full-length ring: release end at
  // 0.002 + 1.498 = 1.5 s — the preset's default duration, so the
  // ring runs the full hit.
  const d = cymbalPatch();
  for (let i = 0; i < 4; i++)
    assert.ok(closeTo(d.layers[i].levelEnv[5].t, 1.5, 1e-9));
  assert.deepEqual(d.masterEffects, []);
});

test('fresh arrays per call: two builds never share state', () => {
  const a = cymbalPatch();
  const b = cymbalPatch();
  assert.notEqual(a, b, 'distinct patch objects');
  assert.notEqual(a.layers, b.layers, 'distinct layers arrays');
  for (let i = 0; i < 4; i++) {
    assert.notEqual(a.layers[i], b.layers[i], `distinct layer ${i} objects`);
    assert.notEqual(a.layers[i].levelEnv, b.layers[i].levelEnv);
    assert.notEqual(a.layers[i].modulators, b.layers[i].modulators);
    assert.notEqual(
      a.layers[i].modulators[0].indexEnv,
      b.layers[i].modulators[0].indexEnv,
    );
  }
});

test('determinism: same patch → byte-identical buffer', () => {
  const a = renderPatch(cymbalPatch(), { sampleRate: SR, duration: DURATION });
  const b = renderPatch(cymbalPatch(), { sampleRate: SR, duration: DURATION });
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
});
