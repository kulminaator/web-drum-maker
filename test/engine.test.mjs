import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPatch, isolateLayer } from '../src/lib/engine.js';
import {
  levelEnvelope,
  pitchEnvelope,
  fmDepthEnvelope,
} from '../src/lib/envelopes.js';
import { WAVE_SHAPES } from '../src/lib/osc.js';
import { kickPatch } from '../src/lib/voices/kick.js';

// Test parameters per plan step 9 and GUIDELINES §4: sr 8000, 0.5 s
// (4000 samples), property-based assertions only — never full-buffer
// equality.
const SR = 8000;
const DURATION = 0.5;

// ── small buffer-property helpers ────────────────────────────────────

const maxAbs = (buf) => {
  let m = 0;
  for (let n = 0; n < buf.length; n++) {
    const a = Math.abs(buf[n]);
    if (a > m) m = a;
  }
  return m;
};

const energy = (buf) => {
  let e = 0;
  for (let n = 0; n < buf.length; n++) e += buf[n] * buf[n];
  return e;
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

const assertBounded = (buf, label) => {
  for (let n = 0; n < buf.length; n++)
    assert.ok(
      Math.abs(buf[n]) <= 1,
      `${label}: sample ${n} = ${buf[n]} outside ±1`,
    );
};

// ── fixtures ──────────────────────────────────────────────────────────

// Kick-style patch (drum_generation.md recipe: 50 Hz body, 100→50 Hz
// pitch drop in 30 ms, 200 Hz modulator, index 8→0 in 20 ms, ~5 ms
// attack, 300 ms decay, noise click, saturation). Inlined here because
// the real voice module arrives in step 10 — this file must stand alone.
const kickStylePatch = () => ({
  layers: [
    {
      type: 'fm',
      carrier: { freq: 50 },
      pitchEnv: pitchEnvelope({ from: 100, to: 50, time: 0.03 }),
      modulators: [
        {
          freq: 200,
          index: 8,
          indexEnv: fmDepthEnvelope({ from: 8, time: 0.02 }),
        },
      ],
      gain: 0.8,
      levelEnv: levelEnvelope({ attack: 0.005, decay: 0.3 }),
    },
    {
      type: 'noise',
      seed: 1,
      cutoff: 2000,
      decay: 0.02,
      gain: 0.2,
      levelEnv: levelEnvelope({ attack: 0.001, decay: 0.05 }),
    },
  ],
  masterEffects: [{ type: 'saturate', drive: 2 }],
});

test('output length is exactly round(duration · sampleRate)', () => {
  const patch = kickStylePatch();
  assert.equal(
    renderPatch(patch, { sampleRate: 8000, duration: 0.5 }).length,
    4000,
  );
  assert.equal(
    renderPatch(patch, { sampleRate: 8000, duration: 0.25 }).length,
    2000,
  );
  // Non-integer product: 0.123 s at 7 kHz = 861.0000000000001 samples,
  // which must round to exactly 861.
  assert.equal(
    renderPatch(patch, { sampleRate: 7000, duration: 0.123 }).length,
    861,
  );
});

test('default kick-style patch renders non-silent', () => {
  const buf = renderPatch(kickStylePatch(), { sampleRate: SR, duration: DURATION });
  assert.ok(
    maxAbs(buf) > 0.01,
    `max |sample| = ${maxAbs(buf)} (expected > 0.01)`,
  );
});

test('output is clamped to ±1 for several patches, incl. high drive', () => {
  // Loud dense FM body used in two of the three patches below.
  const loudFm = {
    type: 'fm',
    carrier: { freq: 100 },
    modulators: [
      { freq: 30, index: 6 },
      { freq: 11, index: 3 },
    ],
    gain: 1,
    levelEnv: levelEnvelope({ attack: 0.001, decay: 0.2 }),
  };
  const patches = [
    kickStylePatch(),
    // High-drive saturation at the layer AND the master: the tanh
    // stages are individually bounded, and the mix of two driven layers
    // can exceed ±1 before the final clamp.
    {
      layers: [{ ...loudFm, effects: [{ type: 'saturate', drive: 20 }] }],
      masterEffects: [{ type: 'saturate', drive: 20 }],
    },
    // Every stage here can legally exceed ±1 on its own: the resonator
    // peak gain is Q = 10, the high-pass gain rises toward Nyquist, and
    // the compressor makeup of 1.5 lifts the whole mix. The final clamp
    // is the only thing keeping the result within ±1.
    {
      layers: [
        { ...loudFm, effects: [{ type: 'resonate', freq: 100, q: 10 }] },
        {
          type: 'noise',
          seed: 3,
          cutoff: 3000,
          decay: 0.05,
          gain: 1,
          levelEnv: levelEnvelope({ attack: 0.001, decay: 0.1 }),
          effects: [{ type: 'highpass', cutoff: 1000 }],
        },
      ],
      masterEffects: [
        { type: 'compress', threshold: 0.3, ratio: 3, makeup: 1.5 },
      ],
    },
  ];
  patches.forEach((p, i) =>
    assertBounded(
      renderPatch(p, { sampleRate: SR, duration: DURATION }),
      `patch ${i}`,
    ),
  );
});

test('doubling a layer gain doubles the output level (linear, below clamp)', () => {
  // Purely linear path: one layer, no effects, no master effects, gains
  // low enough that the final clamp never bites. Doubling the gain
  // doubles every sample exactly, so the amplitude scale (RMS) doubles
  // and the Σx² energy quadruples — the plan's "doubles output energy"
  // in amplitude scale. 5 % tolerance per plan (the math is exact here;
  // the margin guards against a future accidental nonlinearity).
  const make = (gain) => ({
    layers: [
      {
        type: 'fm',
        carrier: { freq: 100 },
        modulators: [{ freq: 30, index: 2 }],
        gain,
        levelEnv: levelEnvelope({ attack: 0.005, decay: 0.2 }),
      },
    ],
    masterEffects: [],
  });
  const a = renderPatch(make(0.2), { sampleRate: SR, duration: DURATION });
  const b = renderPatch(make(0.4), { sampleRate: SR, duration: DURATION });
  const rms = (x) => Math.sqrt(energy(x) / x.length);
  const rmsRatio = rms(b) / rms(a);
  const energyRatio = energy(b) / energy(a);
  assert.ok(
    Math.abs(rmsRatio - 2) < 0.05 * 2,
    `RMS ratio ${rmsRatio} not ≈ 2 after doubling the layer gain`,
  );
  assert.ok(
    Math.abs(energyRatio - 4) < 0.05 * 4,
    `Σx² energy ratio ${energyRatio} not ≈ 4 after doubling the layer gain`,
  );
});

test('80 ms level decay: 200–400 ms energy < 0.25 × 0–20 ms energy', () => {
  // Decay by design: the level envelope is the drum's release. With
  // levelEnvelope(attack 5 ms, decay 80 ms) the envelope hits 0 at 85 ms
  // and clamps there, so the 200–400 ms window is silent by construction
  // — while the 0–20 ms attack window carries the full thump.
  const patch = {
    layers: [
      {
        type: 'fm',
        carrier: { freq: 60 },
        pitchEnv: pitchEnvelope({ from: 120, to: 60, time: 0.03 }),
        modulators: [
          {
            freq: 250,
            index: 6,
            indexEnv: fmDepthEnvelope({ from: 6, time: 0.02 }),
          },
        ],
        gain: 0.9,
        levelEnv: levelEnvelope({ attack: 0.005, decay: 0.08 }),
      },
    ],
    masterEffects: [],
  };
  const buf = renderPatch(patch, { sampleRate: SR, duration: DURATION });
  const early = windowEnergy(buf, 0, 0.02);
  const late = windowEnergy(buf, 0.2, 0.4);
  assert.ok(
    early > 1e-6,
    `attack-window energy ${early} is silent — bad test patch`,
  );
  assert.ok(
    late < 0.25 * early,
    `late-window energy ${late} not < 0.25 × attack-window energy ${early}`,
  );
});

test('different FM depths (index) produce different outputs', () => {
  const withIndex = (index) => ({
    layers: [
      {
        type: 'fm',
        carrier: { freq: 100 },
        modulators: [{ freq: 40, index }],
        gain: 0.8,
        levelEnv: levelEnvelope({ attack: 0.005, decay: 0.15 }),
      },
    ],
    masterEffects: [],
  });
  const a = renderPatch(withIndex(2), { sampleRate: SR, duration: DURATION });
  const b = renderPatch(withIndex(6), { sampleRate: SR, duration: DURATION });
  assert.ok(
    maxAbsDiff(a, b) > 1e-3,
    `max |diff| = ${maxAbsDiff(a, b)} (expected > 1e-3)`,
  );
});

test('determinism: same patch → byte-identical buffer', () => {
  // Exercises both layer types, all three envelope kinds, and the
  // master effect chain — the whole path must be state-free.
  const a = renderPatch(kickStylePatch(), { sampleRate: SR, duration: DURATION });
  const b = renderPatch(kickStylePatch(), { sampleRate: SR, duration: DURATION });
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
});

test('invalid patches throw descriptive errors', () => {
  const opts = { sampleRate: SR, duration: DURATION };
  assert.throws(
    () =>
      renderPatch(
        { layers: [{ type: 'sine', freq: 100, gain: 1 }] },
        opts,
      ),
    /unknown layer type/,
  );
  assert.throws(
    () =>
      renderPatch(
        {
          layers: [
            {
              type: 'fm',
              carrier: { freq: 100 },
              gain: 1,
              effects: [{ type: 'chorus', depth: 0.1 }],
            },
          ],
        },
        opts,
      ),
    /unknown effect type/,
  );
  // Nyquist checks: filters/resonators need 0 < freq < sr/2.
  assert.throws(
    () =>
      renderPatch(
        {
          layers: [
            {
              type: 'fm',
              carrier: { freq: 100 },
              gain: 1,
              effects: [{ type: 'highpass', cutoff: SR }],
            },
          ],
        },
        opts,
      ),
    /must be < sr\/2/,
  );
  assert.throws(
    () => renderPatch(kickStylePatch(), { sampleRate: 0, duration: DURATION }),
    /sampleRate/,
  );
  assert.throws(
    () => renderPatch({ layers: 'nope' }, opts),
    /patch\.layers must be an array/,
  );
});

test('invalid operator wave shape throws a descriptive error', () => {
  // Absent shape is legal (the sine default); a present value must be in
  // the closed four-shape enum, naming the offending operator.
  const opts = { sampleRate: SR, duration: DURATION };
  assert.throws(
    () =>
      renderPatch(
        {
          layers: [
            { type: 'fm', carrier: { freq: 100, shape: 'pulse' }, gain: 1 },
          ],
        },
        opts,
      ),
    /renderPatch: fm carrier shape must be one of sine \/ square \/ saw \/ triangle, got "pulse"/,
  );
  assert.throws(
    () =>
      renderPatch(
        {
          layers: [
            {
              type: 'fm',
              carrier: { freq: 100 },
              gain: 1,
              modulators: [{ freq: 40, index: 1, shape: 'pulse' }],
            },
          ],
        },
        opts,
      ),
    /renderPatch: fm modulator 0 shape must be one of sine \/ square \/ saw \/ triangle, got "pulse"/,
  );
});

test('kick renders with every operator set to each wave shape', () => {
  // The default-sine contract cuts both ways: a real voice patch with
  // explicit shapes on every FM operator must render cleanly — right
  // length, bounded ±1, non-silent (four quick 8 kHz renders).
  for (const shape of WAVE_SHAPES) {
    const patch = JSON.parse(JSON.stringify(kickPatch()));
    patch.layers[0].carrier.shape = shape;
    for (const m of patch.layers[0].modulators) m.shape = shape;
    const buf = renderPatch(patch, { sampleRate: SR, duration: DURATION });
    assert.equal(buf.length, Math.round(DURATION * SR), `${shape}: length`);
    assertBounded(buf, `kick all-${shape}`);
    assert.ok(maxAbs(buf) > 0.01, `kick all-${shape} is silent`);
  }
});

// ── isolateLayer (per-layer views, ui-refresh.md §8 step 3) ───────────

test('isolateLayer returns a patch renderPatch accepts: right length, bounded, non-silent', () => {
  const patch = kickStylePatch();
  const isolated = isolateLayer(patch, 0);
  // New wrapper object, the layer kept by reference, master chain dropped.
  assert.notEqual(isolated, patch);
  assert.notEqual(isolated.layers, patch.layers);
  assert.equal(isolated.layers.length, 1);
  assert.equal(isolated.layers[0], patch.layers[0]);
  assert.deepEqual(isolated.masterEffects, []);
  const buf = renderPatch(isolated, { sampleRate: SR, duration: DURATION });
  assert.equal(buf.length, Math.round(DURATION * SR)); // same duration as the full patch
  assertBounded(buf, 'isolated layer 0');
  assert.ok(
    maxAbs(buf) > 0.01,
    `isolated layer 0 max |sample| = ${maxAbs(buf)} (expected non-silent)`,
  );
  // The noise-click layer (index 1) is renderable on its own, too.
  const buf1 = renderPatch(isolateLayer(patch, 1), { sampleRate: SR, duration: DURATION });
  assert.equal(buf1.length, Math.round(DURATION * SR));
  assertBounded(buf1, 'isolated layer 1');
  assert.ok(
    maxAbs(buf1) > 0.01,
    `isolated layer 1 max |sample| = ${maxAbs(buf1)} (expected non-silent)`,
  );
});

test('isolated render differs from the full-patch render', () => {
  const patch = kickStylePatch();
  const full = renderPatch(kickStylePatch(), { sampleRate: SR, duration: DURATION });
  for (const i of [0, 1]) {
    const iso = renderPatch(isolateLayer(patch, i), { sampleRate: SR, duration: DURATION });
    assert.ok(
      maxAbsDiff(full, iso) > 1e-3,
      `layer ${i}: max |full − isolated| = ${maxAbsDiff(full, iso)} (expected > 1e-3)`,
    );
  }
});

test('linear mix: isolated layer peak <= full-mix peak', () => {
  // Strictly linear path by construction: two pure-carrier FM layers (no
  // modulators → plain sines) with IDENTICAL carrier, phase and level
  // envelope, no layer or master effects. Their sources are sample-
  // identical, so the mix is exactly 1.3× each layer's contribution —
  // no cancellation, no nonlinearity — and the full-mix peak must be at
  // least as large as any single layer's peak.
  const pureSine = (gain) => ({
    type: 'fm',
    carrier: { freq: 60 },
    gain,
    levelEnv: levelEnvelope({ attack: 0.005, decay: 0.3 }),
  });
  const patch = { layers: [pureSine(0.8), pureSine(0.5)], masterEffects: [] };
  const full = renderPatch(patch, { sampleRate: SR, duration: DURATION });
  assert.ok(maxAbs(full) > 0.01, 'full mix is silent — bad test patch');
  for (const i of [0, 1]) {
    const iso = renderPatch(isolateLayer(patch, i), { sampleRate: SR, duration: DURATION });
    assert.ok(
      maxAbs(iso) <= maxAbs(full),
      `layer ${i} peak ${maxAbs(iso)} exceeds full-mix peak ${maxAbs(full)}`,
    );
  }
  // Sanity: the mix really does carry the second layer (not byte-equal
  // to the isolated first one).
  const iso0 = renderPatch(isolateLayer(patch, 0), { sampleRate: SR, duration: DURATION });
  assert.ok(
    maxAbsDiff(full, iso0) > 1e-3,
    `full mix indistinguishable from isolated layer 0 (max |diff| = ${maxAbsDiff(full, iso0)})`,
  );
});

test('isolateLayer is pure: the input patch is deep-unchanged', () => {
  const patch = kickStylePatch();
  const before = JSON.stringify(patch);
  isolateLayer(patch, 0);
  isolateLayer(patch, 1);
  // Rendering the isolated patch must not touch the source patch either.
  renderPatch(isolateLayer(patch, 0), { sampleRate: SR, duration: DURATION });
  assert.equal(JSON.stringify(patch), before);
  assert.equal(patch.layers.length, 2);
  assert.deepEqual(patch.masterEffects, [{ type: 'saturate', drive: 2 }]);
});

test('isolateLayer validates the layer index', () => {
  const patch = kickStylePatch(); // two layers: valid indices 0 and 1
  assert.throws(() => isolateLayer(patch, 2), /layer index/); // above range
  assert.throws(() => isolateLayer(patch, -1), /layer index/); // below range
  assert.throws(() => isolateLayer(patch, 1.5), /layer index/); // non-integer
  assert.throws(() => isolateLayer(patch, '1'), /layer index/); // non-numeric
  assert.throws(() => isolateLayer({ layers: [] }, 0), /layer index/); // empty patch
  assert.throws(
    () => isolateLayer({ layers: 'nope' }, 0),
    /patch\.layers must be an array/,
  );
});
