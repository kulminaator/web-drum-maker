import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFmLayer } from '../src/lib/fm.js';
import { phaseAdvance, shapeSample, sineSample, WAVE_SHAPES } from '../src/lib/osc.js';
import { goertzelMag } from '../src/lib/index.js';

// Test parameters per plan step 5: sr 16000, 0.5 s. 8000 samples keeps
// renders cheap; note the Goertzel bin spacing here is sr/N = 2 Hz, which
// the sweep-based tests below account for (see the cascade test comment).
const SR = 16000;
const LENGTH = 8000;

// Plain reference carrier, built with the osc.js sample-then-advance
// convention (sample the current phase, then advance it).
const plainCarrier = (freq) => {
  const out = new Float32Array(LENGTH);
  let phase = 0;
  for (let n = 0; n < LENGTH; n++) {
    out[n] = sineSample(phase);
    phase = phaseAdvance(phase, freq, SR);
  }
  return out;
};

// Max absolute sample difference between two equal-length buffers.
const maxDiff = (a, b) => {
  let d = 0;
  for (let n = 0; n < a.length; n++) {
    const e = Math.abs(a[n] - b[n]);
    if (e > d) d = e;
  }
  return d;
};

test('index → 0 recovers the plain carrier (Chowning eq. 1)', () => {
  // Zero modulation index makes every deviation 0, so the layer must be
  // sample-identical to a plain sine carrier at the same frequency.
  const layer = {
    carrier: { freq: 100 },
    modulators: [
      { freq: 30, index: 0 },
      { freq: 11, index: 0, feedback: 0.5, ring: false },
    ],
  };
  const buf = renderFmLayer(layer, LENGTH, SR);
  assert.ok(
    maxDiff(buf, plainCarrier(100)) < 1e-6,
    'index-0 FM layer must equal the plain carrier',
  );
});

test('sideband ladder: Fc±Fm > Fc±2Fm > Fc±3Fm at I = 1.5', () => {
  // Chowning: sidebands at Fc ± n·Fm weighted by Bessel J_n(I). For
  // I = 1.5: J1 ≈ 0.558 > J2 ≈ 0.232 > J3 ≈ 0.055, so the ladder below
  // must hold for both the upper and the lower sidebands.
  const buf = renderFmLayer(
    { carrier: { freq: 100 }, modulators: [{ freq: 30, index: 1.5 }] },
    LENGTH,
    SR,
  );
  const mag = (f) => goertzelMag(buf, f, SR);
  assert.ok(mag(70) > mag(40), `J1 sideband 70 Hz (${mag(70)}) not > J2 at 40 Hz (${mag(40)})`);
  assert.ok(mag(130) > mag(160), `J1 sideband 130 Hz (${mag(130)}) not > J2 at 160 Hz (${mag(160)})`);
  assert.ok(mag(40) > mag(10), `J2 sideband 40 Hz (${mag(40)}) not > J3 at 10 Hz (${mag(10)})`);
  assert.ok(mag(160) > mag(190), `J2 sideband 160 Hz (${mag(160)}) not > J3 at 190 Hz (${mag(190)})`);
});

test('two modulators: mixed sideband present, more spectral energy than one', () => {
  // Pattern 3: deviations sum, so the spectrum gains mixed terms at
  // Fc ± Fm1 ± Fm2. The 100 + 30 + 11 = 141 Hz component has amplitude
  // J1(1)·J1(1) ≈ 0.19, a third of the carrier bin.
  const two = renderFmLayer(
    {
      carrier: { freq: 100 },
      modulators: [
        { freq: 30, index: 1 },
        { freq: 11, index: 1 },
      ],
    },
    LENGTH,
    SR,
  );
  const one = renderFmLayer(
    { carrier: { freq: 100 }, modulators: [{ freq: 30, index: 1 }] },
    LENGTH,
    SR,
  );
  const peak = goertzelMag(two, 100, SR);
  const mixed = goertzelMag(two, 141, SR);
  assert.ok(
    mixed > 0.01 * peak,
    `mixed sideband at 141 Hz (${mixed}) not measurably above 1 % of the carrier bin (${peak})`,
  );

  // Total spectral energy = sum of Goertzel magnitudes over the sweep.
  // Two interleaved 10 Hz steps (10 Hz and 15 Hz offsets): the
  // rectangular-window Goertzel is exactly zero at any point a whole
  // number of 2 Hz DFT bins away from a component, and one step-10
  // sweep would therefore null out one entire parity of component
  // frequencies. Interleaving keeps both parities visible. (Summing
  // magnitudes rather than powers: total power is Bessel-normalized to
  // the same value for any index, while the sum of magnitudes grows
  // with the number of distinct sideband bins.)
  const energy = (buf) => {
    let sum = 0;
    for (let f = 10; f <= 4000; f += 10) sum += goertzelMag(buf, f, SR);
    for (let f = 15; f <= 4000; f += 10) sum += goertzelMag(buf, f, SR);
    return sum;
  };
  const eTwo = energy(two);
  const eOne = energy(one);
  assert.ok(
    eTwo > eOne,
    `two-modulator spectral energy (${eTwo}) not > single-modulator (${eOne})`,
  );
});

test('feedback: β = 0 identical to no feedback; β = 0.9 spreads energy upward', () => {
  // Pattern 5. β = 0 must leave the sample stream untouched (the
  // feedback term is exactly 0·w), and strong feedback must reshape the
  // modulator toward saw-like/noise-like, which pushes sideband energy
  // into the high-frequency bins (≥ 3·Fc).
  const base = renderFmLayer(
    { carrier: { freq: 100 }, modulators: [{ freq: 37, index: 2 }] },
    LENGTH,
    SR,
  );
  const beta0 = renderFmLayer(
    { carrier: { freq: 100 }, modulators: [{ freq: 37, index: 2, feedback: 0 }] },
    LENGTH,
    SR,
  );
  assert.ok(
    maxDiff(base, beta0) < 1e-6,
    'β = 0 must be identical to no feedback',
  );

  const beta09 = renderFmLayer(
    { carrier: { freq: 100 }, modulators: [{ freq: 37, index: 2, feedback: 0.9 }] },
    LENGTH,
    SR,
  );
  const highBand = (buf) => {
    let sum = 0;
    for (let f = 3 * 100; f <= 2000; f += 10) sum += goertzelMag(buf, f, SR);
    return sum;
  };
  const hBase = highBand(base);
  const hBeta = highBand(beta09);
  assert.ok(
    hBeta > hBase,
    `high-band energy with β = 0.9 (${hBeta}) not > without feedback (${hBase})`,
  );
});

test('ring mod: 500 × 700 → strong 200/1200, carrier and ring freq near zero', () => {
  // Pattern 7: sin(2π·500t)·sin(2π·700t) = ½[cos(2π·200t) −
  // cos(2π·1200t)] — sum and difference tones at amplitude 0.5 each,
  // and nothing at 500 or 700 Hz.
  const buf = renderFmLayer(
    { carrier: { freq: 500 }, modulators: [{ freq: 700, index: 1, ring: true }] },
    LENGTH,
    SR,
  );
  const m200 = goertzelMag(buf, 200, SR);
  const m1200 = goertzelMag(buf, 1200, SR);
  assert.ok(m200 > 1000, `200 Hz too weak: ${m200} (expected ≈ 2000)`);
  assert.ok(m1200 > 1000, `1200 Hz too weak: ${m1200} (expected ≈ 2000)`);
  assert.ok(
    Math.abs(m200 - m1200) < 0.1 * m200,
    `asymmetric sum/difference tones: ${m200} vs ${m1200}`,
  );
  assert.ok(
    goertzelMag(buf, 500, SR) < 0.1 * m200,
    `carrier at 500 Hz not near zero: ${goertzelMag(buf, 500, SR)}`,
  );
  assert.ok(
    goertzelMag(buf, 700, SR) < 0.1 * m200,
    `ring frequency at 700 Hz not near zero: ${goertzelMag(buf, 700, SR)}`,
  );
});

test('cascade: 3-op chain spreads energy over more bins than a single pair', () => {
  // Pattern 4: Op3 → Op2 → Op1 → carrier, all I = 2. Each stage multiplies
  // the sideband count, so the count of spectral bins above 1 % of the
  // peak must exceed the single-pair case (same carrier + Op1).
  //
  // Frequency choice matters for the step-10 sweep: at sr 16000 / 0.5 s
  // the DFT bin spacing is 2 Hz, and a Goertzel point is a null for a
  // component an integer number of bins away — a step-10 (even-Hz) sweep
  // is blind to even-Hz components. With Fm1 = 31 (odd) the pair's
  // sidebands Fc ± 31k alternate in parity and stay partly visible, and
  // the dominant cascade terms (e.g. 100 + 31 + 55 + 79 = 265 Hz) land
  // on odd frequencies 1–5 Hz from sweep points (≈ 13–64 % of full
  // magnitude) instead of on nulls.
  const cascade = renderFmLayer(
    {
      carrier: { freq: 100 },
      modulators: [
        { freq: 31, index: 2 },
        { freq: 55, index: 2, modulates: 0 },
        { freq: 79, index: 2, modulates: 1 },
      ],
    },
    LENGTH,
    SR,
  );
  const single = renderFmLayer(
    { carrier: { freq: 100 }, modulators: [{ freq: 31, index: 2 }] },
    LENGTH,
    SR,
  );
  const countAbovePeak = (buf, frac) => {
    const mags = [];
    for (let f = 10; f <= 4000; f += 10) mags.push(goertzelMag(buf, f, SR));
    const peak = Math.max(...mags);
    return mags.filter((m) => m > frac * peak).length;
  };
  const cascadeBins = countAbovePeak(cascade, 0.01);
  const singleBins = countAbovePeak(single, 0.01);
  assert.ok(
    cascadeBins > singleBins,
    `cascade bins above 1 % of peak (${cascadeBins}) not > single pair (${singleBins})`,
  );
});

test('envelope hooks: freqAt / indexAt shape the render', () => {
  // fm.js is envelope-agnostic: the engine passes sample-varying hooks.
  // Constant hooks must reproduce the constant-parameter render exactly,
  // and non-trivial hooks must actually change the output.
  const base = renderFmLayer(
    { carrier: { freq: 100 }, modulators: [{ freq: 30, index: 2 }] },
    LENGTH,
    SR,
  );
  const asFunctions = renderFmLayer(
    {
      carrier: { freq: 100, freqAt: () => 100 },
      modulators: [{ freq: 30, index: 2, indexAt: () => 2 }],
    },
    LENGTH,
    SR,
  );
  assert.ok(
    maxDiff(base, asFunctions) < 1e-9,
    'constant hooks must equal constant parameters',
  );
  const glided = renderFmLayer(
    {
      // 100 → 50 Hz over 50 ms (kick-style pitch drop), index collapse
      // 2 → 0 over 20 ms (drum_generation.md FM-depth trick).
      carrier: { freq: 100, freqAt: (t) => 100 - 50 * Math.min(1, t / 0.05) },
      modulators: [{ freq: 30, index: 2, indexAt: (t) => 2 * Math.exp(-t / 0.02) }],
    },
    LENGTH,
    SR,
  );
  assert.ok(
    maxDiff(base, glided) > 1e-3,
    'envelope hooks must change the rendered output',
  );
});

test('graph validation: cycle, > 4 modulators, bad modulates target throw', () => {
  // Cross-modulation (pattern 6) is a cyclic graph and not supported;
  // the graph is capped at 1 carrier + 4 modulators for the POC.
  assert.throws(
    () =>
      renderFmLayer(
        {
          carrier: { freq: 100 },
          modulators: [
            { freq: 30, index: 1, modulates: 1 },
            { freq: 40, index: 1, modulates: 0 },
          ],
        },
        LENGTH,
        SR,
      ),
    /cyclic/,
  );
  assert.throws(
    () =>
      renderFmLayer(
        {
          carrier: { freq: 100 },
          modulators: [
            { freq: 30, index: 1 },
            { freq: 40, index: 1 },
            { freq: 50, index: 1 },
            { freq: 60, index: 1 },
            { freq: 70, index: 1 },
          ],
        },
        LENGTH,
        SR,
      ),
    /at most 4/,
  );
  assert.throws(
    () =>
      renderFmLayer(
        {
          carrier: { freq: 100 },
          modulators: [
            { freq: 30, index: 1 },
            { freq: 40, index: 1, modulates: 5 },
          ],
        },
        LENGTH,
        SR,
      ),
    /out of range/,
  );
});

test('determinism: same inputs → identical output arrays', () => {
  // A graph exercising every routing mode (cascade + feedback + ring +
  // FM) rendered twice must be byte-identical.
  const layer = {
    carrier: { freq: 87 },
    modulators: [
      { freq: 31, index: 2 },
      { freq: 55, index: 1.5, feedback: 0.5, modulates: 0 },
      { freq: 79, index: 0.8, ring: true },
    ],
  };
  const a = renderFmLayer(layer, LENGTH, SR);
  const b = renderFmLayer(layer, LENGTH, SR);
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
});

// ── wave shapes (sinecontrol plan, Phase 1 Step 2; GUIDELINES §4:
//    8 kHz / ≤ 0.5 s renders, property assertions) ──────────────────────

// The shape tests render at 8 kHz / 0.5 s — cheaper than the 16 kHz
// suite above, and the shape math is sample-rate agnostic.
const SR8 = 8000;
const LEN8 = 4000;

// Max |sample| — the non-silent check.
const maxAbs = (buf) => {
  let m = 0;
  for (let n = 0; n < buf.length; n++) {
    const a = Math.abs(buf[n]);
    if (a > m) m = a;
  }
  return m;
};

// Every sample within ±1 (the shapes' bound invariant, osc.js header).
const assertBounded = (buf, label) => {
  for (let n = 0; n < buf.length; n++)
    assert.ok(
      Math.abs(buf[n]) <= 1,
      `${label}: sample ${n} = ${buf[n]} outside ±1`,
    );
};

// The shaped Chowning eq. 1 reference: sample the current phase with the
// shape, then advance (the osc.js sample-then-advance convention).
const shapedCarrier = (shape, freq) => {
  const out = new Float32Array(LEN8);
  let phase = 0;
  for (let n = 0; n < LEN8; n++) {
    out[n] = shapeSample(shape, phase);
    phase = phaseAdvance(phase, freq, SR8);
  }
  return out;
};

test('no shape fields ≡ explicit sine: byte-identical render (regression pin)', () => {
  // The default-sine contract: a layer with no shape fields must render
  // exactly like the same layer with explicit 'sine' on carrier and all
  // modulators (deterministic engine → exact sample equality).
  const bare = {
    carrier: { freq: 100 },
    modulators: [
      { freq: 30, index: 1.5 },
      { freq: 11, index: 0.8, feedback: 0.5 },
    ],
  };
  const explicit = {
    carrier: { freq: 100, shape: 'sine' },
    modulators: [
      { freq: 30, index: 1.5, shape: 'sine' },
      { freq: 11, index: 0.8, feedback: 0.5, shape: 'sine' },
    ],
  };
  const a = renderFmLayer(bare, LEN8, SR8);
  const b = renderFmLayer(explicit, LEN8, SR8);
  assert.equal(a.length, b.length);
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
});

test('index → 0 recovers the plain shaped carrier, per shape (Chowning eq. 1)', () => {
  // A modulator-free carrier (and an all-index-0 layer) at a constant
  // frequency must equal the hand-computed shapeSample/phaseAdvance
  // reference loop EXACTLY, for every shape — the shaped version of the
  // sine eq.-1 test above.
  for (const shape of WAVE_SHAPES) {
    const ref = shapedCarrier(shape, 100);
    const bareBuf = renderFmLayer(
      { carrier: { freq: 100, shape }, modulators: [] },
      LEN8,
      SR8,
    );
    assert.deepEqual(
      Buffer.from(bareBuf.buffer),
      Buffer.from(ref.buffer),
      `modulator-free ${shape} carrier must equal the reference`,
    );
    // All-index-0 with a shaped, feedback-driven modulator: the index-0
    // wave still feeds the latches/deviations downstream, but its index
    // of 0 keeps the carrier deviation exactly 0.
    const zeroedBuf = renderFmLayer(
      {
        carrier: { freq: 100, shape },
        modulators: [
          { freq: 30, index: 0 },
          { freq: 11, index: 0, feedback: 0.5, ring: false, shape: 'square' },
        ],
      },
      LEN8,
      SR8,
    );
    assert.deepEqual(
      Buffer.from(zeroedBuf.buffer),
      Buffer.from(ref.buffer),
      `index-0 ${shape} carrier must equal the reference`,
    );
  }
});

test('carrier shape is plumbed: sine vs square / saw / triangle', () => {
  // Same (modulator-free) layer, different carrier shape → different
  // render (not byte-equal), same length, bounded ±1, non-silent. The
  // modulator-free carrier keeps its phase wrapped, so every shape stays
  // within its [-1, 1] one-period bound here; with a deviation the
  // unwrapped saw/triangle sample site would leave one period, and the
  // engine's final ±1 clamp is the render-level backstop for that.
  const mk = (shape) => ({ carrier: { freq: 100, shape }, modulators: [] });
  const sine = renderFmLayer(mk('sine'), LEN8, SR8);
  assert.ok(maxAbs(sine) > 0.01, 'sine carrier render is silent');
  for (const shape of ['square', 'saw', 'triangle']) {
    const buf = renderFmLayer(mk(shape), LEN8, SR8);
    assert.equal(buf.length, sine.length, `${shape}: same length`);
    assertBounded(buf, `${shape} carrier`);
    assert.ok(maxAbs(buf) > 0.01, `${shape} carrier render is silent`);
    assert.notDeepEqual(
      Buffer.from(buf.buffer),
      Buffer.from(sine.buffer),
      `${shape} carrier must differ from the sine carrier`,
    );
  }
});

test('shaped modulator: square ≠ sine at the same index, bounded', () => {
  // A shaped modulator shapes the deviation signal itself — the
  // sideband structure changes, not just the carrier's timbre.
  const mk = (shape) => ({
    carrier: { freq: 100 },
    modulators: [{ freq: 30, index: 1.5, shape }],
  });
  const sine = renderFmLayer(mk('sine'), LEN8, SR8);
  const square = renderFmLayer(mk('square'), LEN8, SR8);
  assert.equal(square.length, sine.length);
  assertBounded(square, 'square-modulator render');
  assert.ok(maxAbs(square) > 0.01, 'square-modulator render is silent');
  assert.notDeepEqual(
    Buffer.from(square.buffer),
    Buffer.from(sine.buffer),
    'square modulator must differ from the sine modulator at the same index',
  );
});

test('shaped ring modulator and shaped cascade driver differ from sine', () => {
  // Ring: the product is taken against the shaped wave. Cascade: the
  // shaped driver feeds the next stage's deviation. Each must render,
  // differ from its sine counterpart, and stay bounded ±1.
  const ring = (shape) => ({
    carrier: { freq: 500 },
    modulators: [{ freq: 700, index: 1, ring: true, shape }],
  });
  const ringSine = renderFmLayer(ring('sine'), LEN8, SR8);
  const ringSquare = renderFmLayer(ring('square'), LEN8, SR8);
  assert.equal(ringSquare.length, ringSine.length);
  assertBounded(ringSquare, 'square ring modulator');
  assert.ok(maxAbs(ringSquare) > 0.01, 'square ring render is silent');
  assert.notDeepEqual(
    Buffer.from(ringSquare.buffer),
    Buffer.from(ringSine.buffer),
    'square ring modulator must differ from the sine ring modulator',
  );

  const cascade = (shape) => ({
    carrier: { freq: 100 },
    modulators: [
      { freq: 31, index: 2 },
      { freq: 55, index: 2, modulates: 0 },
      { freq: 79, index: 2, modulates: 1, shape },
    ],
  });
  const cascSine = renderFmLayer(cascade('sine'), LEN8, SR8);
  const cascSaw = renderFmLayer(cascade('saw'), LEN8, SR8);
  assert.equal(cascSaw.length, cascSine.length);
  assertBounded(cascSaw, 'saw cascade driver');
  assert.ok(maxAbs(cascSaw) > 0.01, 'saw cascade render is silent');
  assert.notDeepEqual(
    Buffer.from(cascSaw.buffer),
    Buffer.from(cascSine.buffer),
    'saw cascade driver must differ from the sine cascade driver',
  );
});

test('feedback on a shaped operator: β = 0.5 bounded, differs from β = 0', () => {
  // Feedback is a phase self-deviation of one sample old — on a shaped
  // operator it is applied inside the shape. β = 0 must leave the shaped
  // render byte-identical to no feedback (mirror of the existing
  // feedback test's first half), for every shape.
  const mk = (feedback) => ({
    carrier: { freq: 100, shape: 'square' },
    modulators: [{ freq: 37, index: 2, shape: 'square', feedback }],
  });
  const beta0 = renderFmLayer(mk(0), LEN8, SR8);
  const beta05 = renderFmLayer(mk(0.5), LEN8, SR8);
  assertBounded(beta05, 'β = 0.5 shaped operator');
  assert.ok(maxAbs(beta05) > 0.01, 'β = 0.5 shaped render is silent');
  assert.notDeepEqual(
    Buffer.from(beta05.buffer),
    Buffer.from(beta0.buffer),
    'β = 0.5 must differ from β = 0 on the shaped operator',
  );
  for (const shape of WAVE_SHAPES) {
    const noFeedback = renderFmLayer(
      {
        carrier: { freq: 100, shape },
        modulators: [{ freq: 37, index: 2, shape }],
      },
      LEN8,
      SR8,
    );
    const zeroFeedback = renderFmLayer(
      {
        carrier: { freq: 100, shape },
        modulators: [{ freq: 37, index: 2, shape, feedback: 0 }],
      },
      LEN8,
      SR8,
    );
    assert.deepEqual(
      Buffer.from(zeroFeedback.buffer),
      Buffer.from(noFeedback.buffer),
      `β = 0 (${shape}) must be byte-identical to no feedback`,
    );
  }
});
