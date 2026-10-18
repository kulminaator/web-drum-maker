// Parameter table + descriptor factory (revamp P1/S2): PARAM_RANGES
// shape (incl. the effect-key drift guard), factory output on the three
// recipe patches (paths resolve, defaults in range, unique labels,
// shadowing rules), the parameter-plumbing precedent from
// test/params.test.mjs (every descriptor moved to a differing range
// endpoint changes the 0.5 s render), the P1/S3 equivalence guard
// (the factory's list for each classic drum matches the pre-S3
// hand-written list, fixtures below, in (path, label, min, max, step)
// and order, modulo the recorded deliberate deltas), and the P1/S4
// envelope-editor value clamp (editorValueRange's kind → PARAM_RANGES
// mapping).
//
// Tests are exempt from the app↔lib import boundary (GUIDELINES §1.4):
// this file deep-imports src/app/controls.js and src/lib/ directly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getPath, setPath } from '../src/lib/params.js';
import { renderPatch } from '../src/lib/engine.js';
import { levelEnvelope } from '../src/lib/envelopes.js';
import { kickPatch } from '../src/lib/voices/kick.js';
import { snarePatch } from '../src/lib/voices/snare.js';
import { hihatPatch } from '../src/lib/voices/hihat.js';
import {
  PARAM_RANGES,
  descriptorRead,
  descriptorWrite,
  describeLayer,
  describeFxList,
  describePatch,
  displayLabelOf,
  editorValueRange,
} from '../src/app/controls.js';
import {
  DAHDSR_CURVES,
  DAHDSR_PARAMS,
  DAHDSR_TIMES,
  isCanonicalLevel,
  pointsToDahdsr,
} from '../src/app/dahdsr.js';

// --- PARAM_RANGES shape -------------------------------------------------

test('PARAM_RANGES: every entry has finite min < max, step > 0, a label', () => {
  assert.ok(Object.keys(PARAM_RANGES).length >= 17, 'the table lost an entry');
  for (const [key, range] of Object.entries(PARAM_RANGES)) {
    assert.ok(
      typeof range.label === 'string' && range.label.length > 0,
      `${key}: non-empty label`,
    );
    assert.ok(
      Number.isFinite(range.min) && Number.isFinite(range.max),
      `${key}: finite min/max`,
    );
    assert.ok(range.min < range.max, `${key}: min ${range.min} < max ${range.max}`);
    assert.ok(Number.isFinite(range.step) && range.step > 0, `${key}: step > 0`);
  }
});

// The four effect shapes the engine accepts (the fx schema in the
// src/lib/engine.js header). Enumerated from a sample of each shape —
// NOT from engine.js source text — so this is a data-level guard
// against engine drift: if the engine grows (or renames) an effect
// field, the PARAM_RANGES keys must grow (or rename) with it.
const FX_SAMPLES = [
  { type: 'saturate', drive: 2 },
  { type: 'highpass', cutoff: 4000 },
  { type: 'resonate', freq: 330, q: 5 },
  { type: 'compress', threshold: 0.3, ratio: 3, attack: 0.01, release: 0.1, makeup: 1.2 },
];

test('PARAM_RANGES: effect-param keys exactly match the four effect shapes', () => {
  for (const fx of FX_SAMPLES) {
    const expected = Object.keys(fx)
      .filter((f) => f !== 'type')
      .map((f) => `${fx.type}.${f}`)
      .sort();
    const actual = Object.keys(PARAM_RANGES)
      .filter((k) => k.startsWith(`${fx.type}.`))
      .sort();
    assert.deepEqual(actual, expected, `PARAM_RANGES keys for '${fx.type}'`);
  }
});

// --- displayLabel (plan ui3 P5/S1): the short visible caption ----------

test('displayLabelOf: strips the leading Source N: prefix (one anchored regex)', () => {
  assert.equal(displayLabelOf('Source 2: Saturator 1 Drive'), 'Saturator 1 Drive');
  assert.equal(displayLabelOf('Source 1: pitch start (Hz)'), 'pitch start (Hz)');
  assert.equal(displayLabelOf('Source 10: gain'), 'gain', 'multi-digit source index');
  // Only the LEADING prefix, and only the exact `Source N: ` form:
  assert.equal(displayLabelOf('Source 1: Source 2: gain'), 'Source 2: gain');
  // Not a prefix — unchanged:
  assert.equal(displayLabelOf('Master: Saturator 1 Drive'), 'Master: Saturator 1 Drive');
  assert.equal(displayLabelOf('Source 1'), 'Source 1'); // no colon + space
  assert.equal(displayLabelOf('source 1: gain'), 'source 1: gain'); // case-anchored
  assert.equal(displayLabelOf('gain'), 'gain'); // prefix-less label
});

// --- Recipe patches: sanity, shadowing, plumbing ------------------------

// Same rate split as test/params.test.mjs: 8 kHz per GUIDELINES §4,
// except the hi-hat — its 8 kHz master high-pass and ~20.5 kHz top
// partial only fit under the 22.05 kHz Nyquist, so it renders at the
// 44.1 kHz playback rate.
const VOICES = [
  { name: 'kick', patch: kickPatch, sampleRate: 8000 },
  { name: 'snare', patch: snarePatch, sampleRate: 8000 },
  { name: 'hihat', patch: hihatPatch, sampleRate: 44100 },
];

const maxDiff = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
};

for (const voice of VOICES) {
  test(`factory: ${voice.name} — paths resolve, defaults in [min, max], labels unique`, () => {
    const patch = voice.patch();
    const descriptors = describePatch(patch);
    assert.ok(descriptors.length > 0, 'voice produced no descriptors');
    const labels = new Set();
    for (const d of descriptors) {
      assert.ok(typeof d.path === 'string' && d.path.length > 0, `${d.label}: missing path`);
      assert.ok(typeof d.label === 'string' && d.label.length > 0, `${d.path}: missing label`);
      assert.ok(!labels.has(d.label), `duplicate label '${d.label}'`);
      labels.add(d.label);
      // The value the CONTROL sees: the raw patch value through the
      // descriptor's optional read transform (the DAHDSR level knobs'
      // raw value is the whole point array, plan "dahdsr" P3/S2).
      const value = descriptorRead(d, getPath(patch, d.path)); // throws on a typo'd path
      assert.ok(Number.isFinite(value), `${d.label}: default is not finite`);
      assert.ok(
        value >= d.min && value <= d.max,
        `${d.label}: default ${value} outside [${d.min}, ${d.max}]`,
      );
    }
  });

  test(`plumbing: ${voice.name} — every descriptor moves the render`, () => {
    const base = renderPatch(voice.patch(), {
      sampleRate: voice.sampleRate,
      duration: 0.5,
    });
    for (const d of describePatch(voice.patch())) {
      const patch = voice.patch();
      let baseline = base;
      if (d.write) {
        // The level knobs are the span/level parameters of ONE shared
        // point array, and some are inaudible at the patch's own
        // values (release with sustain 0 is a zero→0 leg), so first
        // turn EVERY OTHER level knob to 0.05 — legal on all nine
        // (spans 0.05 s each: the whole envelope fits the 0.5 s
        // window; sustain and bends mid-low) — through the knobs'
        // own writes (one knob turn re-derives all six points,
        // eight turns compose), and re-baseline.
        for (const e of describePatch(patch)) {
          if (!e.write || e.label === d.label) continue; // same param
          setPath(patch, e.path, descriptorWrite(e, getPath(patch, e.path), 0.05));
        }
        baseline = renderPatch(patch, {
          sampleRate: voice.sampleRate,
          duration: 0.5,
        });
      }
      // Re-read the raw value AFTER the context writes (setPath
      // replaced the array — the earlier reference is stale).
      const current = descriptorRead(d, getPath(patch, d.path));
      // Move the parameter to a range endpoint that differs from the
      // default (min first; max if the default already sits at min).
      const alt = d.min !== current ? d.min : d.max;
      assert.notEqual(alt, current, `${d.label}: no alternative endpoint`);
      setPath(patch, d.path, descriptorWrite(d, getPath(patch, d.path), alt));
      const diff = maxDiff(
        baseline,
        renderPatch(patch, { sampleRate: voice.sampleRate, duration: 0.5 }),
      );
      assert.ok(diff > 0, `${d.label} → ${alt} does not change the render`);
    }
  });
}

// --- displayLabel shape guards (plan ui3 P5/S1) -------------------------

// Shape guard (the plan's "every descriptor of the golden voices"): every
// descriptor the factories emit for the three recipe patches carries the
// short caption — the label with the `Source N:` prefix stripped — while
// `label` (the full aria name) keeps it.
test('shape guard: every golden-voice descriptor carries its short displayLabel', () => {
  for (const voice of VOICES) {
    for (const d of describePatch(voice.patch())) {
      assert.equal(
        d.displayLabel,
        displayLabelOf(d.label),
        `${voice.name} '${d.label}': displayLabel is the stripped label`,
      );
      assert.ok(d.displayLabel.length > 0, `${voice.name} '${d.label}': non-empty caption`);
      assert.ok(d.label.startsWith('Source ') || d.label.startsWith('Master:'),
        `${voice.name} '${d.label}': the full label keeps its identity prefix`);
    }
  }
  // Concrete pins: the source prefix is GONE from the visible caption,
  // and the master-chain caption (no `Source N:` prefix) keeps its label.
  const kick = describePatch(kickPatch());
  assert.equal(
    kick.find((d) => d.path === 'layers.0.pitchEnv.0.v').displayLabel,
    'pitch start (Hz)',
  );
  assert.equal(kick.find((d) => d.path === 'layers.1.gain').displayLabel, 'gain');
  assert.equal(
    kick.find((d) => d.path === 'layers.0.levelEnv').displayLabel,
    'level delay (s)',
    'the first level knob of the nine',
  );
  assert.equal(
    kick.find((d) => d.path === 'masterEffects.0.drive').displayLabel,
    'Master: Saturator 1 drive',
  );
});

test('shape guard: the fx captions strip the source prefix, keep the Master prefix', () => {
  const sourceFx = describeFxList([{ type: 'saturate', drive: 2 }], 'layers.1.effects');
  assert.equal(sourceFx[0].label, 'Source 2: Saturator 1 drive');
  assert.equal(sourceFx[0].displayLabel, 'Saturator 1 drive');
  const masterFx = describeFxList([{ type: 'saturate', drive: 2 }], 'masterEffects');
  assert.equal(masterFx[0].label, 'Master: Saturator 1 drive');
  assert.equal(masterFx[0].displayLabel, 'Master: Saturator 1 drive');
});

// --- Shadowing rules (GUIDELINES §2, the factory's core contract) -------

test('shadowing: kick body — pitchEnv/indexEnv hide the shadowed constants', () => {
  const paths = describePatch(kickPatch()).map((d) => d.path);
  assert.ok(!paths.includes('layers.0.carrier.freq'), 'pitchEnv shadows carrier.freq');
  assert.ok(!paths.includes('layers.0.modulators.0.index'), 'indexEnv shadows the modulator index');
  // The live parameters are the envelope points instead.
  assert.ok(paths.includes('layers.0.pitchEnv.0.v'));
  assert.ok(paths.includes('layers.0.pitchEnv.1.t'));
  assert.ok(paths.includes('layers.0.modulators.0.indexEnv.0.v'));
  assert.ok(paths.includes('layers.0.modulators.0.indexEnv.1.t'));
});

test('shadowing: snare shell — no envelopes, so carrier.freq is live', () => {
  const paths = describePatch(snarePatch()).map((d) => d.path);
  assert.ok(paths.includes('layers.1.carrier.freq'), 'shell carrier.freq gets a slider');
  assert.ok(!paths.includes('layers.1.pitchEnv.0.v'), 'the shell has no pitch envelope');
  assert.ok(!paths.includes('layers.1.modulators.0.index'), 'the shell has no modulators');
});

test('shadowing: kick click — noise layer gets seed/cutoff/decay/gain, no carrier', () => {
  const paths = describePatch(kickPatch())
    .map((d) => d.path)
    .filter((p) => p.startsWith('layers.1.'));
  for (const field of ['seed', 'cutoff', 'decay', 'gain'])
    assert.ok(paths.includes(`layers.1.${field}`), `noise field '${field}' missing`);
  assert.ok(!paths.some((p) => p.includes('carrier')), 'a noise layer has no carrier params');
  assert.ok(!paths.some((p) => p.includes('modulator')), 'a noise layer has no modulator params');
});

// A synthetic "builder" patch exercising the factory branches the
// classic recipes never do: a constant-index modulator (no indexEnv),
// feedback, a ring modulator with no cascade (dead index), a ring
// modulator cascading OUT (live index), a noise layer carrying a
// levelEnv (the engine applies it to any layer type), and a master
// chain with a full compress (attack/release fields present on the fx).
const builderPatch = () => ({
  layers: [
    {
      type: 'fm',
      carrier: { freq: 120 },
      modulators: [
        { freq: 240, index: 4 },                            // constant index
        { freq: 480, index: 2, feedback: 0.4 },             // feedback
        { freq: 360, index: 3, ring: true },                // ring, no cascade → dead index
        { freq: 720, index: 2, ring: true, modulates: 2 },  // ring cascading out → live index
      ],
      gain: 0.6,
      levelEnv: levelEnvelope({ attack: 0.004, decay: 0.25 }),
    },
    {
      type: 'noise',
      seed: 7,
      cutoff: 3000,
      decay: 0.08,
      gain: 0.4,
      // The classic recipes never put a levelEnv on a noise layer, but
      // the engine applies it to any layer type (src/lib/engine.js).
      levelEnv: levelEnvelope({ attack: 0.002, decay: 0.12 }),
    },
  ],
  masterEffects: [
    { type: 'highpass', cutoff: 1500 },
    { type: 'compress', threshold: 0.35, ratio: 3, attack: 0.008, release: 0.12, makeup: 1.3 },
  ],
});

const BUILDER = { name: 'builder', patch: builderPatch, sampleRate: 8000 };

test('factory: builder — same sanity contract as the recipe patches', () => {
  const patch = builderPatch();
  const descriptors = describePatch(patch);
  const labels = new Set();
  for (const d of descriptors) {
    assert.ok(!labels.has(d.label), `duplicate label '${d.label}'`);
    labels.add(d.label);
    const value = descriptorRead(d, getPath(patch, d.path));
    assert.ok(value >= d.min && value <= d.max,
      `${d.label}: default ${value} outside [${d.min}, ${d.max}]`);
  }
});

test('plumbing: builder — every descriptor moves the render', () => {
  const base = renderPatch(builderPatch(), { sampleRate: 8000, duration: 0.5 });
  for (const d of describePatch(builderPatch())) {
    const patch = builderPatch();
    let baseline = base;
    if (d.write) {
      // Audibility context for the level knobs — see the recipe loop
      // above (release is a zero→0 leg while the sustain is 0).
      for (const e of describePatch(patch)) {
        if (!e.write || e.label === d.label) continue;
        setPath(patch, e.path, descriptorWrite(e, getPath(patch, e.path), 0.05));
      }
      baseline = renderPatch(patch, { sampleRate: 8000, duration: 0.5 });
    }
    const current = descriptorRead(d, getPath(patch, d.path));
    const alt = d.min !== current ? d.min : d.max;
    assert.notEqual(alt, current, `${d.label}: no alternative endpoint`);
    setPath(patch, d.path, descriptorWrite(d, getPath(patch, d.path), alt));
    const diff = maxDiff(base === baseline ? base : baseline,
      renderPatch(patch, { sampleRate: 8000, duration: 0.5 }));
    assert.ok(diff > 0, `${d.label} → ${alt} does not change the render`);
  }
});

test('ring shadowing: the index is dead only for a ring that drives no cascade', () => {
  const paths = describePatch(builderPatch()).map((d) => d.path);
  assert.ok(
    !paths.includes('layers.0.modulators.2.index'),
    'ring with no cascade link it drives — dead index, no slider',
  );
  assert.ok(
    paths.includes('layers.0.modulators.3.index'),
    'ring cascading out — its index scales the link, slider stays',
  );
  assert.ok(paths.includes('layers.0.modulators.0.index'), 'constant index — slider');
  assert.ok(paths.includes('layers.0.modulators.1.feedback'), 'feedback present — slider');
  assert.ok(paths.includes('layers.1.levelEnv'), 'noise levelEnv — the nine DAHDSR knobs (same path)');
  assert.ok(paths.includes('masterEffects.1.attack'), 'full compress — attack slider');
});

// --- Factory edge cases --------------------------------------------------

test('describeLayer: unknown layer type throws', () => {
  assert.throws(() => describeLayer({ type: 'osc' }, 0), /unknown layer type/);
});

test('describeFxList: empty chain, unknown base path, unknown type and field', () => {
  assert.deepEqual(describeFxList([], 'masterEffects'), []);
  assert.deepEqual(describeFxList(null, 'masterEffects'), []);
  assert.throws(() => describeFxList([], 'weird.base'), /unknown fx base path/);
  assert.throws(
    () => describeFxList([{ type: 'warp', amount: 5 }], 'masterEffects'),
    /unknown effect type/,
  );
  // A known type with a field the table lacks: engine drift — fail loudly.
  assert.throws(
    () => describeFxList([{ type: 'saturate', drive: 2, knee: 1 }], 'masterEffects'),
    /PARAM_RANGES/,
  );
});

test('describePatch: layer list plus the master chain; a patch without layers throws', () => {
  const paths = describePatch(snarePatch()).map((d) => d.path);
  assert.ok(paths.includes('layers.0.carrier.freq'));
  assert.ok(paths.includes('layers.1.effects.0.freq'));
  assert.ok(paths.includes('masterEffects.0.threshold'));
  // A missing layers array is not a patch — fail loudly (the engine
  // would throw the same way at render).
  assert.throws(() => describePatch({}), /layers array/);
  assert.throws(() => describePatch(null), /layers array/);
});

// An EMPTY layers array is legal input shape-wise (the factory's job is
// to describe what IS there), so it yields only the master-chain
// descriptors.
test('describePatch: empty layers array yields only the master-chain descriptors', () => {
  assert.deepEqual(describePatch({ layers: [], masterEffects: [] }), []);
  const fx = describePatch({ layers: [], masterEffects: [{ type: 'saturate', drive: 2 }] });
  assert.deepEqual(fx.map((d) => d.path), ['masterEffects.0.drive']);
});

// --- S3 equivalence guard: factory output vs the pre-S3 lists ----------
//
// The three *_LEGACY_DESCRIPTORS lists below are the hand-written
// descriptor lists that used to live in src/app/controls.js (deleted in
// P1/S3 — the UI now builds its sliders from describePatch). They are
// copied here VERBATIM as fixtures ONLY to guard this migration: a
// future change to PARAM_RANGES or the factory that alters a classic
// drum's knobs is a behavior change and must be deliberate — it fails
// the guards below unless it is recorded in the *_DELTAS tables below
// (a deliberate change updates the deltas, never the fixtures).
// The fixtures stay in this file permanently.

// kick — verbatim output of the pre-S3 kickParameterDescriptors().
const KICK_LEGACY_DESCRIPTORS = [
  { path: 'layers.0.pitchEnv.0.v', label: 'Body: pitch start (Hz)', min: 20, max: 400, step: 1 },
  { path: 'layers.0.pitchEnv.1.t', label: 'Body: pitch time (s)', min: 0.005, max: 0.2, step: 0.001 },
  { path: 'layers.0.pitchEnv.1.v', label: 'Body: pitch end (Hz)', min: 20, max: 200, step: 1 },
  { path: 'layers.0.modulators.0.freq', label: 'Body: modulator freq (Hz)', min: 50, max: 2000, step: 10 },
  { path: 'layers.0.modulators.0.indexEnv.0.v', label: 'Body: FM index', min: 0, max: 20, step: 0.1 },
  { path: 'layers.0.modulators.0.indexEnv.1.t', label: 'Body: FM decay time (s)', min: 0.005, max: 0.2, step: 0.001 },
  { path: 'layers.0.levelEnv.1.t', label: 'Body: level attack (s)', min: 0.001, max: 0.05, step: 0.0005 },
  { path: 'layers.0.levelEnv.3.t', label: 'Body: level release end (s)', min: 0.16, max: 0.49, step: 0.005 },
  { path: 'layers.0.gain', label: 'Body: gain', min: 0, max: 1, step: 0.01 },
  { path: 'layers.1.cutoff', label: 'Click: cutoff (Hz)', min: 200, max: 4000, step: 50 },
  { path: 'layers.1.decay', label: 'Click: decay (s)', min: 0.005, max: 0.2, step: 0.001 },
  { path: 'layers.1.gain', label: 'Click: gain', min: 0, max: 1, step: 0.01 },
  { path: 'masterEffects.0.drive', label: 'Saturation: drive', min: 1, max: 10, step: 0.1 },
];

// snare — verbatim output of the pre-S3 snareParameterDescriptors().
const SNARE_LEGACY_DESCRIPTORS = [
  { path: 'layers.0.carrier.freq', label: 'Body: carrier freq (Hz)', min: 20, max: 500, step: 1 },
  { path: 'layers.0.modulators.0.freq', label: 'Body: modulator freq (Hz)', min: 200, max: 4000, step: 10 },
  { path: 'layers.0.modulators.0.indexEnv.0.v', label: 'Body: FM index', min: 0, max: 20, step: 0.1 },
  { path: 'layers.0.modulators.0.indexEnv.1.t', label: 'Body: FM decay time (s)', min: 0.005, max: 0.2, step: 0.001 },
  { path: 'layers.0.levelEnv.1.t', label: 'Body: level attack (s)', min: 0.001, max: 0.02, step: 0.0005 },
  { path: 'layers.0.levelEnv.3.t', label: 'Body: level release end (s)', min: 0.05, max: 0.49, step: 0.005 },
  { path: 'layers.0.gain', label: 'Body: gain', min: 0, max: 1, step: 0.01 },
  { path: 'layers.1.carrier.freq', label: 'Shell: carrier freq (Hz)', min: 100, max: 1000, step: 1 },
  { path: 'layers.1.levelEnv.1.t', label: 'Shell: level attack (s)', min: 0.001, max: 0.02, step: 0.0005 },
  { path: 'layers.1.levelEnv.3.t', label: 'Shell: level release end (s)', min: 0.03, max: 0.49, step: 0.005 },
  { path: 'layers.1.gain', label: 'Shell: gain', min: 0, max: 1, step: 0.01 },
  { path: 'layers.1.effects.0.freq', label: 'Shell: resonator freq (Hz)', min: 100, max: 1000, step: 1 },
  { path: 'layers.1.effects.0.q', label: 'Shell: resonator Q', min: 0.5, max: 10, step: 0.5 },
  { path: 'layers.2.cutoff', label: 'Wires: cutoff (Hz)', min: 200, max: 4000, step: 50 },
  { path: 'layers.2.decay', label: 'Wires: decay (s)', min: 0.01, max: 0.5, step: 0.005 },
  { path: 'layers.2.gain', label: 'Wires: gain', min: 0, max: 1, step: 0.01 },
  { path: 'masterEffects.0.threshold', label: 'Compressor: threshold', min: 0.05, max: 0.9, step: 0.05 },
  { path: 'masterEffects.0.ratio', label: 'Compressor: ratio', min: 1, max: 10, step: 0.5 },
  { path: 'masterEffects.0.makeup', label: 'Compressor: makeup', min: 1, max: 2, step: 0.1 },
];

// hihat — verbatim output of the pre-S3 hihatParameterDescriptors()
// (the old list was built in a loop over the six OPL ratios; the loop
// is kept verbatim).
const HITHAT_LEGACY_DESCRIPTORS = (() => {
  const ratios = [1.000, 1.231, 1.342, 2.103, 3.487, 5.119];
  const out = [];
  ratios.forEach((ratio, i) => {
    out.push(
      { path: `layers.${i}.carrier.freq`, label: `Partial ${i + 1}: frequency (Hz)`, min: 500, max: 21000, step: 1 },
      { path: `layers.${i}.levelEnv.1.t`, label: `Partial ${i + 1}: attack (s)`, min: 0.0005, max: 0.01, step: 0.0005 },
      { path: `layers.${i}.levelEnv.3.t`, label: `Partial ${i + 1}: release end (s)`, min: 0.05, max: 0.25, step: 0.005 },
      { path: `layers.${i}.gain`, label: `Partial ${i + 1}: gain`, min: 0, max: 1, step: 0.01 },
    );
  });
  out.push({ path: 'masterEffects.0.cutoff', label: 'High-pass cutoff (Hz)', min: 2000, max: 20000, step: 100 });
  return out;
})();

// Field-level diff of a legacy list against the factory's:
//   removed — fixture paths the factory no longer emits (path strings);
//   added   — factory paths the fixture never had, with the full
//             descriptor plus `at`, the row index in the factory list;
//   changed — per fixture path, ONLY the fields that differ
//             (label / min / max / step), value = the factory's.
// A deepEqual of this diff against the recorded deltas means the lists
// agree on (path, label, min, max, step) everywhere else.
const diffDescriptors = (legacy, actual) => {
  const byPath = new Map(actual.map((d) => [d.path, d]));
  const removed = [];
  const changed = {};
  for (const l of legacy) {
    const a = byPath.get(l.path);
    if (!a) {
      removed.push(l.path);
      continue;
    }
    const entry = {};
    for (const field of ['label', 'min', 'max', 'step'])
      if (a[field] !== l[field]) entry[field] = a[field];
    if (Object.keys(entry).length > 0) changed[l.path] = entry;
  }
  const added = [];
  actual.forEach((d, i) => {
    if (!legacy.some((l) => l.path === d.path))
      added.push({ at: i, path: d.path, label: d.label, min: d.min, max: d.max, step: d.step });
  });
  return { removed, added, changed };
};

// The legacy path sequence with each recorded addition spliced in at
// its recorded row — the expected factory order (the slider row order
// the user sees is part of the UI this guard protects). Removed paths
// are dropped first, so an addition's `at` row is relative to the
// post-removal legacy order. (P3/S2: the two index-welded level
// sliders were removed and replaced by nine DAHDSR knobs sharing the
// one `layers.i.levelEnv` path — the repeated added paths splice at
// consecutive rows.)
const expectedPathOrder = (legacy, added, removed) => {
  const gone = new Set(removed);
  const order = legacy.map((d) => d.path).filter((p) => !gone.has(p));
  for (const a of added) order.splice(a.at, 0, a.path);
  return order;
};

// The recorded deliberate S3 deltas (reviewed when the guard was first
// red): (a) the factory's generic 'Source N' / 'Master: <FxType> i'
// labels replace the per-voice prefixes ('Body' / 'Shell' / 'Wires' /
// 'Click' / 'Partial N' / 'Saturation' / 'Compressor' / 'High-pass'),
// with the 'modulator 1 …' / 'level …' wording; (b) the per-recipe
// ranges widen to the PARAM_RANGES / ENVELOPE_TIME_RANGE table (plus
// snare resonator Q max 10→20 and compressor makeup max 2→4, which are
// PARAM_RANGES entries, not time ranges); (c) the factory gives every
// noise layer a seed slider (deterministic transient, src/lib/noise.js
// header), which the old lists omitted — it lands as the first row of
// the noise layer; (d) the canonical 6-point level form makes a zero
// span a legitimate value (delay = 0 / hold = 0 by default, stored as
// duplicate-t points), so the two level point-time sliders' min relaxes
// 0.0005 -> 0 (P2/S2 — SUPERSEDED by (e): those two sliders are
// removed); (e) P3/S2 (plan "dahdsr"): the two index-welded level
// sliders (levelEnv.1.t / levelEnv.3.t) are REMOVED and replaced by
// NINE DAHDSR knobs sharing the one layers.i.levelEnv path (delay /
// attack / hold / decay / release / sustain / the three curve bends —
// read/write transforms over the whole point array), and the FM
// depth's second anchor gains its knob (indexEnv.1.v, 'FM index end' —
// the engine read it all along, the old UI never named it).
// (a)–(d) removed nothing; (e) removes the two level sliders.

// The nine DAHDSR level knobs' recorded rows for layer `i` (plan
// P3/S2) — the added-rows table for the `layers.i.levelEnv` path in
// the factory order (spans, sustain, bends) with their ranges.
const levelKnobRows = (i) => {
  const n = i + 1;
  const rows = ['delay', 'attack', 'hold', 'decay', 'release'].map((s) => ({
    path: `layers.${i}.levelEnv`,
    label: `Source ${n}: level ${s} (s)`,
    min: 0,
    max: 1.5,
    step: 0.0005,
  }));
  rows.push({
    path: `layers.${i}.levelEnv`,
    label: `Source ${n}: level sustain`,
    min: 0,
    max: 1,
    step: 0.01,
  });
  for (const s of ['attack', 'decay', 'release'])
    rows.push({
      path: `layers.${i}.levelEnv`,
      label: `Source ${n}: level ${s} curve`,
      min: 0,
      max: 1,
      step: 0.01,
    });
  return rows;
};

const KICK_DELTAS = {
  removed: [
    'layers.0.levelEnv.1.t',
    'layers.0.levelEnv.3.t',
  ],
  added: [
    { at: 6, path: 'layers.0.modulators.0.indexEnv.1.v', label: 'Source 1: modulator 1 FM index end', min: 0, max: 20, step: 0.1 },
    ...levelKnobRows(0).map((r, k) => ({ at: 7 + k, ...r })),
    { at: 17, path: 'layers.1.seed', label: 'Source 2: seed', min: 1, max: 999, step: 1 },
  ],
  changed: {
    'layers.0.pitchEnv.0.v': { label: 'Source 1: pitch start (Hz)', max: 22000 },
    'layers.0.pitchEnv.1.t': { label: 'Source 1: pitch time (s)', min: 0.0005, max: 1.5, step: 0.0005 },
    'layers.0.pitchEnv.1.v': { label: 'Source 1: pitch end (Hz)', max: 22000 },
    'layers.0.modulators.0.freq': { label: 'Source 1: modulator 1 freq (Hz)', min: 20, max: 22000, step: 1 },
    'layers.0.modulators.0.indexEnv.0.v': { label: 'Source 1: modulator 1 FM index' },
    'layers.0.modulators.0.indexEnv.1.t': { label: 'Source 1: modulator 1 FM decay (s)', min: 0.0005, max: 1.5, step: 0.0005 },
    'layers.0.gain': { label: 'Source 1: gain' },
    'layers.1.cutoff': { label: 'Source 2: cutoff (Hz)', min: 50, max: 22000, step: 1 },
    'layers.1.decay': { label: 'Source 2: decay (s)', max: 1.5, step: 0.005 },
    'layers.1.gain': { label: 'Source 2: gain' },
    'masterEffects.0.drive': { label: 'Master: Saturator 1 drive' },
  },
};

const SNARE_DELTAS = {
  removed: [
    'layers.0.levelEnv.1.t',
    'layers.0.levelEnv.3.t',
    'layers.1.levelEnv.1.t',
    'layers.1.levelEnv.3.t',
  ],
  added: [
    { at: 4, path: 'layers.0.modulators.0.indexEnv.1.v', label: 'Source 1: modulator 1 FM index end', min: 0, max: 20, step: 0.1 },
    ...levelKnobRows(0).map((r, k) => ({ at: 5 + k, ...r })),
    ...levelKnobRows(1).map((r, k) => ({ at: 16 + k, ...r })),
    { at: 28, path: 'layers.2.seed', label: 'Source 3: seed', min: 1, max: 999, step: 1 },
  ],
  changed: {
    'layers.0.carrier.freq': { label: 'Source 1: carrier freq (Hz)', max: 22000 },
    'layers.0.modulators.0.freq': { label: 'Source 1: modulator 1 freq (Hz)', min: 20, max: 22000, step: 1 },
    'layers.0.modulators.0.indexEnv.0.v': { label: 'Source 1: modulator 1 FM index' },
    'layers.0.modulators.0.indexEnv.1.t': { label: 'Source 1: modulator 1 FM decay (s)', min: 0.0005, max: 1.5, step: 0.0005 },
    'layers.0.gain': { label: 'Source 1: gain' },
    'layers.1.carrier.freq': { label: 'Source 2: carrier freq (Hz)', min: 20, max: 22000 },
    'layers.1.gain': { label: 'Source 2: gain' },
    'layers.1.effects.0.freq': { label: 'Source 2: Resonator 1 freq (Hz)', min: 20, max: 22000 },
    'layers.1.effects.0.q': { label: 'Source 2: Resonator 1 Q', max: 20 },
    'layers.2.cutoff': { label: 'Source 3: cutoff (Hz)', min: 50, max: 22000, step: 1 },
    'layers.2.decay': { label: 'Source 3: decay (s)', min: 0.005, max: 1.5 },
    'layers.2.gain': { label: 'Source 3: gain' },
    'masterEffects.0.threshold': { label: 'Master: Compressor 1 threshold' },
    'masterEffects.0.ratio': { label: 'Master: Compressor 1 ratio' },
    'masterEffects.0.makeup': { label: 'Master: Compressor 1 makeup', max: 4 },
  },
};

const HITHAT_DELTAS = {
  // All six partials lose both index-welded sliders (P3/S2) — built
  // from the same loop as the fixture.
  removed: (() => {
    const removed = [];
    for (let i = 0; i < 6; i++)
      removed.push(`layers.${i}.levelEnv.1.t`, `layers.${i}.levelEnv.3.t`);
    return removed;
  })(),
  // …and gain the nine DAHDSR knobs each: the post-removal legacy rows
  // are 2i (carrier) and 2i+1 (gain), so layer i's nine rows are
  // 11·i+1 … 11·i+9 (each prior layer's splices shift the tail by 9).
  added: (() => {
    const added = [];
    for (let i = 0; i < 6; i++)
      for (let k = 0; k < 9; k++)
        added.push({ at: 11 * i + 1 + k, ...levelKnobRows(i)[k] });
    return added;
  })(),
  // Built from the same loop as the fixture: all six partials get the
  // same label/range treatment, so a hand-written copy would only
  // invite transcription drift.
  changed: (() => {
    const changed = {};
    for (let i = 0; i < 6; i++) {
      const n = i + 1;
      changed[`layers.${i}.carrier.freq`] = { label: `Source ${n}: carrier freq (Hz)`, min: 20, max: 22000 };
      changed[`layers.${i}.gain`] = { label: `Source ${n}: gain` };
    }
    changed['masterEffects.0.cutoff'] = { label: 'Master: High-pass 1 cutoff (Hz)', min: 50, max: 22000, step: 1 };
    return changed;
  })(),
};

for (const [name, legacy, patch, deltas] of [
  ['kick', KICK_LEGACY_DESCRIPTORS, kickPatch, KICK_DELTAS],
  ['snare', SNARE_LEGACY_DESCRIPTORS, snarePatch, SNARE_DELTAS],
  ['hihat', HITHAT_LEGACY_DESCRIPTORS, hihatPatch, HITHAT_DELTAS],
]) {
  test(`S3 guard: ${name} — factory list equals the pre-S3 list modulo recorded deltas`, () => {
    const actual = describePatch(patch());
    assert.deepEqual(
      diffDescriptors(legacy, actual),
      deltas,
      `${name}: the factory's (path, label, min, max, step) drifted from the ` +
      'pre-S3 list — review the diff; record deliberate changes in the deltas, ' +
      'never in the fixture',
    );
    assert.deepEqual(
      actual.map((d) => d.path),
      expectedPathOrder(legacy, deltas.added, deltas.removed),
      `${name}: slider row order drifted from the pre-S3 order`,
    );
  });
}

// --- P3/S2 (plan "dahdsr"): the DAHDSR level knobs -------------------
//
// The descriptor format's read/write transform extension (the header
// of src/app/controls.js): the level knobs address the WHOLE levelEnv
// point array, so a knob turn re-derives all six canonical points
// atomically. The canonical-form math itself (round-trips, the
// normalizer, the bend mapping) is test/dahdsr.test.mjs's job; here
// the guard is the DESCRIPTOR layer — shape, the simulated knob turn,
// and (in the plumbing tests above) the render.

// The nine level knobs in the factory's order, with their expected
// ranges (the span knobs share the level time range — min relaxed to
// 0; sustain is a level — the layer.gain range; the bends take the
// 0…1 bend range).
const LEVEL_KNOBS = [
  { param: 'delay', label: 'level delay (s)', min: 0, max: 1.5, step: 0.0005 },
  { param: 'attack', label: 'level attack (s)', min: 0, max: 1.5, step: 0.0005 },
  { param: 'hold', label: 'level hold (s)', min: 0, max: 1.5, step: 0.0005 },
  { param: 'decay', label: 'level decay (s)', min: 0, max: 1.5, step: 0.0005 },
  { param: 'release', label: 'level release (s)', min: 0, max: 1.5, step: 0.0005 },
  { param: 'sustain', label: 'level sustain', min: 0, max: 1, step: 0.01 },
  { param: 'attackCurve', label: 'level attack curve', min: 0, max: 1, step: 0.01 },
  { param: 'decayCurve', label: 'level decay curve', min: 0, max: 1, step: 0.01 },
  { param: 'releaseCurve', label: 'level release curve', min: 0, max: 1, step: 0.01 },
];

test('shape guard: every levelEnv layer carries the nine DAHDSR knobs (read/write present)', () => {
  for (const voice of VOICES) {
    const patch = voice.patch();
    for (const [i, layer] of patch.layers.entries()) {
      if (!layer.levelEnv) continue;
      const level = describeLayer(layer, i).filter((d) => d.path === `layers.${i}.levelEnv`);
      assert.equal(level.length, 9, `${voice.name} L${i}: nine level knobs`);
      level.forEach((d, k) => {
        const spec = LEVEL_KNOBS[k];
        assert.equal(d.path, `layers.${i}.levelEnv`, 'the raw value is the WHOLE point array');
        assert.equal(d.label, `Source ${i + 1}: ${spec.label}`);
        assert.equal(d.displayLabel, spec.label, 'the caption drops the source prefix');
        assert.deepEqual([d.min, d.max, d.step], [spec.min, spec.max, spec.step]);
        assert.equal(typeof d.read, 'function', `${spec.label}: read transform`);
        assert.equal(typeof d.write, 'function', `${spec.label}: write transform`);
        const value = d.read(getPath(patch, d.path));
        assert.ok(Number.isFinite(value) && value >= d.min && value <= d.max,
          `${spec.label}: the read transform sees a value in [min, max]`);
      });
    }
  }
});

test('shape guard: only the level knobs carry transforms (the rest keep the plain form)', () => {
  for (const voice of VOICES) {
    for (const d of describePatch(voice.patch())) {
      const transformed = d.path.endsWith('.levelEnv');
      assert.equal(typeof d.read, transformed ? 'function' : 'undefined', `${d.label}: read`);
      assert.equal(typeof d.write, transformed ? 'function' : 'undefined', `${d.label}: write`);
    }
  }
  // The FM depth's second anchor (the index the depth collapses TO —
  // the engine reads it, the old UI never exposed it) has its knob.
  for (const [name, patch] of [['kick', kickPatch], ['snare', snarePatch]]) {
    const paths = describePatch(patch()).map((d) => d.path);
    assert.ok(
      paths.includes('layers.0.modulators.0.indexEnv.1.v'),
      `${name}: the index end knob is there`,
    );
  }
});

// A simulated knob turn: apply the descriptor's write with a new
// value to a canonical levelEnv — the points re-derive with exactly
// that parameter changed, all spans stay ≥ 0, and the array is
// canonical (the atomic whole-array write, plan P3/S2). The spans are
// compared with a 1e-9 tolerance: the write re-derives cumulative
// times from the scalars, and the re-difference carries at most a
// ulp (test/dahdsr.test.mjs pins the round-trip precision).
const near = (a, b, msg) =>
  assert.ok(Math.abs(a - b) <= 1e-9, `${msg} (${a} !~ ${b})`);

test('simulated knob turn: write re-derives the points with exactly one parameter changed', () => {
  // A canonical env with every span nonzero AND curves — the kick's
  // real shape (several zero spans, one curve) is covered by the
  // plumbing tests; both degenerate and non-degenerate must work.
  const env = levelEnvelope({
    delay: 0.01, attack: 0.02, hold: 0.03, decay: 0.1,
    sustain: 0.25, release: 0.05,
    attackCurve: 0.1, decayCurve: 0.55, releaseCurve: 0.2,
  });
  const knobs = describeLayer(
    { type: 'fm', carrier: { freq: 100 }, gain: 0.5, levelEnv: env }, 0,
  ).filter((d) => d.path === 'layers.0.levelEnv');
  assert.equal(knobs.length, 9);
  const before = pointsToDahdsr(env);
  knobs.forEach((d, k) => {
    const { param } = LEVEL_KNOBS[k];
    const alt = before[param] !== d.min ? d.min : d.max; // a differing endpoint
    const next = d.write(env, alt);
    assert.ok(isCanonicalLevel(next), `${param}: the re-derived array is canonical`);
    const after = pointsToDahdsr(next);
    near(after[param], alt, `${param}: exactly the turned parameter changed`);
    for (const p of [...DAHDSR_PARAMS, ...DAHDSR_CURVES])
      if (p !== param) near(after[p], before[p], `${p}: untouched by the ${param} turn`);
    for (const span of DAHDSR_TIMES)
      assert.ok(after[span] >= 0, `${param}: span '${span}' stays ≥ 0`);
    // The read transform agrees with the write (the knob's readout
    // tracks the knob it just turned).
    assert.equal(d.read(next), alt, `${param}: read sees the turned value`);
  });
});

// --- P1/S4: the envelope editor's v clamp comes from the table --------
//
// The editor's v clamp (drum.editor.valueRange in src/app/main.js) is
// editorValueRange(kind) — a lookup in PARAM_RANGES — instead of the
// S2 descriptor-union (valueRangeFor, deleted in S4). The pointer
// behavior itself stays browser-verified (same precedent as today's
// envelope editor; the pure envelope math is covered by
// test/envelopes.test.mjs) — this tests the pure kind → range mapping.

test('editorValueRange: each kind clamps to its parameter table entry', () => {
  // The mapping itself: level values are gains, pitch values are
  // carrier frequencies, fm-depth values are modulation indices.
  assert.deepEqual(
    editorValueRange('level'),
    [PARAM_RANGES['layer.gain'].min, PARAM_RANGES['layer.gain'].max],
    'level → layer.gain',
  );
  assert.deepEqual(
    editorValueRange('pitch'),
    [PARAM_RANGES['carrier.freq'].min, PARAM_RANGES['carrier.freq'].max],
    'pitch → carrier.freq',
  );
  assert.deepEqual(
    editorValueRange('fm depth'),
    [PARAM_RANGES['modulator.index'].min, PARAM_RANGES['modulator.index'].max],
    'fm depth → modulator.index',
  );
});

test('editorValueRange: current table pins level [0,1], pitch = carrier range, fm depth = index range', () => {
  // The plan's concrete clamps (level [0,1]; pitch = carrier.freq
  // range; fm depth = modulator.index range): a PARAM_RANGES change
  // that moves the editor's clamp is deliberate and lands here first.
  assert.deepEqual(editorValueRange('level'), [0, 1]);
  assert.deepEqual(editorValueRange('pitch'), [20, 22000]);
  assert.deepEqual(editorValueRange('fm depth'), [0, 20]);
});

test('editorValueRange: unknown kind throws; the result is a fresh array', () => {
  assert.throws(() => editorValueRange('vibrato'), /unknown envelope kind/);
  assert.throws(() => editorValueRange('level '), /unknown envelope kind/);
  const range = editorValueRange('level');
  range[0] = -5; // mutating the result must not touch the table
  assert.equal(PARAM_RANGES['layer.gain'].min, 0);
});
