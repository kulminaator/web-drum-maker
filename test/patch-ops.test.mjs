// Tests for src/app/patch-ops.js (plan newui P5/S12 + P7/S17) — the
// pure structural patch ops: addLayer / removeLayer (sources),
// addModulator / removeModulator (an FM layer's 1–4 modulators),
// addFx / removeFx (the master and per-layer fx chains), and the mix
// views: withSolo (the mix-minus-solo view), silentPatch (the all-
// muted view — silence), and mixView (the render-ready mix: the
// disabled layers zeroed, any solo keeping soloed ∩ enabled).
//
// The three op contracts under test (src/app/patch-ops.js header):
//   1. PURE — every op returns a NEW patch object and never mutates
//      its input (deep-compared before/after); the changed container
//      array is replaced wholesale and the survivors carry over by
//      reference;
//   2. FAILS LOUDLY — bad types / indices / paths and the caps
//      (8 layers; 4 modulators — the engine's limit, src/lib/fm.js;
//      4 fx slots per chain) throw descriptively;
//   3. THE OUTPUT ALWAYS RENDERS — every op's result renders at
//      8 kHz / 0.5 s (GUIDELINES §4) and is non-silent and bounded.
//
// One rate exception, documented: the noise DEFAULT's 5 kHz cutoff
// exceeds the 8 kHz Nyquist (4 kHz) and renderPatch rejects cutoffs
// >= sr/2, so the noise-default renders use 16 kHz — the rate
// adaptation test/hihat.test.mjs already established.
//
// The identity checks this step mandates (removeLayer's surviving
// layers, the zero-modulator render, the solo / full-mix renders) use
// exact sample equality: renderPatch is deterministic (src/lib/engine.js
// header), so byte-identity there is a property of the clone-first
// contract, not over-precise buffer matching. Everything else asserts
// properties (length, peak, bounds), per GUIDELINES §4.
//
// Tests are exempt from the app↔lib import boundary (GUIDELINES
// §1.4): this file reaches the library through the facade — the same
// door patch-ops.js itself walks.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addFx,
  addLayer,
  addModulator,
  mixView,
  removeFx,
  removeLayer,
  removeModulator,
  silentPatch,
  withSolo,
} from '../src/app/patch-ops.js';
import {
  isolateLayer,
  levelEnvelope,
  renderPatch,
} from '../src/lib/index.js';
import { KNEE_CURVE } from '../src/lib/envelopes.js';

const SR = 8000;
const SR_HIGH = 16000; // the noise default's 5 kHz cutoff needs this
const DUR = 0.5;
// The 8-layer UI sanity cap (src/app/patch-ops.js MAX_LAYERS): the cap
// test below grows the patch to it with the op under test.
const MAX_LAYERS_COUNT = 8;

const render = (patch, rate = SR) =>
  renderPatch(patch, { sampleRate: rate, duration: DUR });

const peakOf = (buf) => {
  let peak = 0;
  for (let n = 0; n < buf.length; n += 1)
    peak = Math.max(peak, Math.abs(buf[n]));
  return peak;
};

// The property contract for an op's output (GUIDELINES §4): the right
// length, non-silent (a default that rendered silence would be a dead
// source in the card row), bounded to ±1 (the engine's final clamp).
const assertRenders = (patch, label, rate = SR) => {
  const buf = render(patch, rate);
  assert.equal(buf.length, Math.round(DUR * rate), `${label}: length`);
  const peak = peakOf(buf);
  assert.ok(peak > 0.001, `${label}: render is silent (peak ${peak})`);
  for (let n = 0; n < buf.length; n += 1)
    assert.ok(Math.abs(buf[n]) <= 1, `${label}: sample ${n} out of ±1`);
  return buf;
};

// Exact sample equality (deterministic renders — see the header).
const buffersEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let n = 0; n < a.length; n += 1) if (a[n] !== b[n]) return false;
  return true;
};

// A fresh snapshot for the input-unmutated deep compare (a patch is
// plain data — no functions — so structuredClone round-trips it).
const snapshot = (patch) => structuredClone(patch);

// The standard one-shot level envelope (5 ms / 300 ms — the kick body's
// times, drum_generation.md kick recipe), in the canonical 6-point form
// with the KNEE_CURVE decay bend (the legacy 4-point knee's exponential
// collapse, src/lib/envelopes.js).
const standardLevelEnv = () =>
  levelEnvelope({ attack: 0.005, decay: 0.3, decayCurve: KNEE_CURVE });

// The shared fixture: a classic-kick-shaped two-source patch (an FM
// body with one constant-index modulator + a filtered-noise click)
// with ONE fx in each kind of chain (a resonator on the body, a
// saturator on the mix — the classic recipes' chains,
// drum_generation.md) so every op, including the removeFx paths, has
// something to act on. The noise cutoff (2 kHz) stays below the 8 kHz
// Nyquist, so the whole file renders at 8 kHz except the
// noise-DEFAULT renders (16 kHz, documented above).
const fixturePatch = () => ({
  layers: [
    {
      type: 'fm',
      carrier: { freq: 220 },
      modulators: [{ freq: 440, index: 5 }],
      gain: 0.8,
      levelEnv: standardLevelEnv(),
      effects: [{ type: 'resonate', freq: 300, q: 5 }],
    },
    {
      type: 'noise',
      seed: 1,
      cutoff: 2000,
      decay: 0.1,
      gain: 0.5,
      levelEnv: standardLevelEnv(),
      // no `effects` key — the engine's `?? []` default path
    },
  ],
  masterEffects: [{ type: 'saturate', drive: 2 }],
});

// ---- contract 1: pure, clone-first -----------------------------------

test('every op returns a new patch object and leaves the input unmutated', () => {
  const p = fixturePatch();
  const before = snapshot(p);
  const ops = [
    () => addLayer(p, 'fm'),
    () => addLayer(p, 'noise'),
    () => removeLayer(p, 0),
    () => removeLayer(p, 1),
    () => addModulator(p, 0),
    () => removeModulator(p, 0, 0),
    () => addFx(p, 'masterEffects', 'highpass'),
    () => removeFx(p, 'masterEffects', 0),
    () => addFx(p, 'layers.0.effects', 'compress'),
    () => addFx(p, 'layers.1.effects', 'saturate'),
    () => removeFx(p, 'layers.0.effects', 0),
    () => withSolo(p, [0]),
    () => withSolo(p, [0, 1]),
    () => withSolo(p, []),
    () => silentPatch(p),
    () => mixView(p, [], []),
    () => mixView(p, [1], []),
    () => mixView(p, [0], [0, 1]),
    () => mixView(p, [0, 1], [1]),
  ];
  for (const op of ops) {
    const out = op();
    assert.notEqual(out, p, 'the op must return a NEW patch object');
    assert.deepEqual(snapshot(p), before, 'the input patch was mutated');
  }
});

test('clone-first: only the changed container is replaced; survivors carry over by reference', () => {
  const p = fixturePatch();

  const added = addLayer(p, 'fm');
  assert.notEqual(added.layers, p.layers, 'addLayer: new layers array');
  assert.equal(added.layers[0], p.layers[0], 'addLayer: layer 0 shared');
  assert.equal(added.layers[1], p.layers[1], 'addLayer: layer 1 shared');
  assert.equal(added.masterEffects, p.masterEffects, 'addLayer: masterEffects shared');

  const removed = removeLayer(p, 0);
  assert.notEqual(removed.layers, p.layers, 'removeLayer: new layers array');
  assert.equal(removed.layers[0], p.layers[1], 'removeLayer: survivor shared');
  assert.equal(removed.masterEffects, p.masterEffects, 'removeLayer: masterEffects shared');

  const modded = addModulator(p, 0);
  assert.notEqual(modded.layers[0], p.layers[0], 'addModulator: edited layer is new');
  assert.notEqual(modded.layers[0].modulators, p.layers[0].modulators, 'addModulator: new modulators array');
  assert.equal(modded.layers[0].modulators[0], p.layers[0].modulators[0], 'addModulator: surviving modulator shared');
  assert.equal(modded.layers[1], p.layers[1], 'addModulator: sibling layer shared');

  const demodded = removeModulator(p, 0, 0);
  assert.notEqual(demodded.layers[0], p.layers[0], 'removeModulator: edited layer is new');
  assert.deepEqual(demodded.layers[0].modulators, [], 'removeModulator: down to zero modulators');
  assert.equal(demodded.layers[1], p.layers[1], 'removeModulator: sibling layer shared');

  const mfx = addFx(p, 'masterEffects', 'highpass');
  assert.notEqual(mfx.masterEffects, p.masterEffects, 'addFx master: new masterEffects array');
  assert.equal(mfx.masterEffects[0], p.masterEffects[0], 'addFx master: surviving slot shared');
  assert.equal(mfx.layers, p.layers, 'addFx master: layers untouched, same array');

  const lfx = addFx(p, 'layers.1.effects', 'compress');
  assert.notEqual(lfx.layers[1], p.layers[1], 'addFx layer: edited layer is new');
  assert.equal(lfx.layers[0], p.layers[0], 'addFx layer: sibling layer shared');
  assert.equal(lfx.masterEffects, p.masterEffects, 'addFx layer: masterEffects shared');

  const rfx = removeFx(p, 'masterEffects', 0);
  assert.notEqual(rfx.masterEffects, p.masterEffects, 'removeFx master: new masterEffects array');
  assert.equal(rfx.layers, p.layers, 'removeFx master: layers untouched, same array');

  const lrfx = removeFx(p, 'layers.0.effects', 0);
  assert.notEqual(lrfx.layers[0], p.layers[0], 'removeFx layer: edited layer is new');
  assert.deepEqual(lrfx.layers[0].effects, [], 'removeFx layer: chain emptied');

  const solo = withSolo(p, [1]);
  assert.notEqual(solo.layers[0], p.layers[0], 'withSolo: muted layer is a new object');
  assert.equal(solo.layers[1], p.layers[1], 'withSolo: kept layer shared');
  assert.equal(solo.masterEffects, p.masterEffects, 'withSolo: masterEffects shared');

  const full = withSolo(p, []);
  assert.notEqual(full.layers, p.layers, 'withSolo: still a new layers array');
  assert.equal(full.layers[0], p.layers[0], 'withSolo empty keep: layer 0 shared');
  assert.equal(full.layers[1], p.layers[1], 'withSolo empty keep: layer 1 shared');

  const silent = silentPatch(p);
  assert.notEqual(silent.layers, p.layers, 'silentPatch: new layers array');
  assert.notEqual(silent.layers[0], p.layers[0], 'silentPatch: layer 0 is a new object (even with gain untouched)');
  assert.notEqual(silent.layers[1], p.layers[1], 'silentPatch: layer 1 is a new object');
  assert.equal(silent.masterEffects, p.masterEffects, 'silentPatch: masterEffects shared');

  const view = mixView(p, [1], [0]); // disable 1, solo 0 -> keep [0]
  assert.equal(view.layers[0], p.layers[0], 'mixView: kept layer shared');
  assert.notEqual(view.layers[1], p.layers[1], 'mixView: disabled layer is a new object');
  assert.equal(view.layers[1].gain, 0, 'mixView: the disabled layer is zeroed');
  assert.equal(view.masterEffects, p.masterEffects, 'mixView: masterEffects shared');

  const allOn = mixView(p, [], []); // no disable, no solo -> full mix
  assert.equal(allOn.layers[0], p.layers[0], 'mixView default: layer 0 shared');
  assert.equal(allOn.layers[1], p.layers[1], 'mixView default: layer 1 shared');
});

// ---- addLayer ---------------------------------------------------------

test('addLayer fm: the new layer matches the documented defaults exactly', () => {
  const out = addLayer(fixturePatch(), 'fm');
  assert.equal(out.layers.length, 3, 'the layer is appended');
  assert.deepEqual(out.layers[2], {
    type: 'fm',
    // shape: 'sine' carried from birth (sinecontrol P3/S7 — the card's
    // shape groups are field-presence gated, so a created operator
    // must already carry the field; an intentional default change,
    // the engine's documented default keeps the render byte-identical)
    carrier: { freq: 220, shape: 'sine' },
    modulators: [{ freq: 440, index: 5, shape: 'sine' }],
    gain: 0.5,
    levelEnv: standardLevelEnv(),
    effects: [],
  }, 'the documented FM defaults (no pitchEnv, no indexEnv, standard one-shot, shape from birth)');
});

test('addLayer noise: the new layer matches the documented defaults exactly', () => {
  const out = addLayer(fixturePatch(), 'noise');
  assert.equal(out.layers.length, 3, 'the layer is appended');
  assert.deepEqual(out.layers[2], {
    type: 'noise',
    seed: 1,
    cutoff: 5000,
    decay: 0.1,
    gain: 0.5,
    levelEnv: standardLevelEnv(),
    effects: [],
  }, 'the documented noise defaults (audible mid-band burst)');
});

test('addLayer: the results render non-silent and bounded, and the new source is audible on its own', () => {
  const fm = addLayer(fixturePatch(), 'fm');
  assertRenders(fm, 'addLayer fm');
  assertRenders(isolateLayer(fm, 2), 'addLayer fm, new layer alone');
  // The 5 kHz default cutoff exceeds the 8 kHz Nyquist (4 kHz), so the
  // noise default renders at 16 kHz (the hihat-test rate adaptation).
  const noise = addLayer(fixturePatch(), 'noise');
  assertRenders(noise, 'addLayer noise (16 kHz)', SR_HIGH);
  assertRenders(isolateLayer(noise, 2), 'addLayer noise, new layer alone (16 kHz)', SR_HIGH);
});

test('addLayer: refuses an unknown type and the 9th layer (the 8-layer cap)', () => {
  const p = fixturePatch();
  assert.throws(() => addLayer(p, 'sine'), /patch-ops: unknown layer type/);
  assert.throws(() => addLayer(p, 'sine'), /expected "fm" or "noise"/);
  assert.throws(() => addLayer(p, undefined), /patch-ops: unknown layer type/);
  // Grow to the cap via the op itself, then the 9th add must refuse,
  // documenting the UI sanity cap in the throw.
  let eight = {
    layers: [{ type: 'noise', seed: 1, cutoff: 1000, decay: 0.1, gain: 0.5 }],
    masterEffects: [],
  };
  for (let i = 1; i < MAX_LAYERS_COUNT; i += 1) eight = addLayer(eight, 'noise');
  assert.equal(eight.layers.length, MAX_LAYERS_COUNT, 'grown to the cap');
  assert.throws(
    () => addLayer(eight, 'noise'),
    (err) =>
      /patch-ops: at most 8 layers/.test(err.message)
      && /card row/.test(err.message)
      && /engine itself has no limit/.test(err.message),
  );
});

// ---- removeLayer -------------------------------------------------------

test('removeLayer: drops layer i — length -1, survivors keep their order and render byte-identically', () => {
  // Three layers so a middle removal exercises the re-index.
  const p = addLayer(fixturePatch(), 'fm'); // fm, noise, fm
  const before = [
    render(isolateLayer(p, 0)),
    render(isolateLayer(p, 1)),
    render(isolateLayer(p, 2)),
  ];
  const out = removeLayer(p, 1);
  assert.equal(out.layers.length, 2, 'length -1');
  assert.equal(out.layers[0], p.layers[0], 'former layer 0 kept');
  assert.equal(out.layers[1], p.layers[2], 'former layer 2 is now layer 1');
  // The survivors render BYTE-IDENTICAL via isolateLayer before/after
  // — the clone-first contract: their objects carried over, so their
  // sound is unchanged.
  assert.ok(
    buffersEqual(render(isolateLayer(out, 0)), before[0]),
    'survivor 0 re-renders identically',
  );
  assert.ok(
    buffersEqual(render(isolateLayer(out, 1)), before[2]),
    'survivor 1 re-renders identically',
  );
  assertRenders(out, 'removeLayer result');
});

test('removeLayer: refuses the last layer (a drum keeps >= 1 source)', () => {
  const single = { layers: [fixturePatch().layers[0]], masterEffects: [] };
  assert.throws(
    () => removeLayer(single, 0),
    (err) =>
      /patch-ops: cannot remove the last layer/.test(err.message)
      && /keeps at least one source/.test(err.message)
      && /presets.removeDrum/.test(err.message),
  );
});

test('removeLayer: rejects a bad index', () => {
  const p = fixturePatch();
  assert.throws(() => removeLayer(p, 2), /patch-ops: layer index/);
  assert.throws(() => removeLayer(p, -1), /patch-ops: layer index/);
  assert.throws(() => removeLayer(p, 0.5), /patch-ops: layer index/);
});

// ---- addModulator / removeModulator ------------------------------------

test('addModulator: appends { freq: 880, index: 3, shape: "sine" } and the result renders, differing from the 1-mod render', () => {
  const p = fixturePatch();
  const oneMod = render(p);
  const out = addModulator(p, 0);
  assert.equal(out.layers[0].modulators.length, 2);
  // shape: 'sine' carried from birth (sinecontrol P3/S7 — the mod-
  // add path rebuilds only the card's mod sub-section, NOT
  // rebuildCardRow, so the created modulator must already carry the
  // field for its shape group to bind; an intentional default change,
  // the engine's documented default keeps the render byte-identical)
  assert.deepEqual(out.layers[0].modulators[1], { freq: 880, index: 3, shape: 'sine' });
  const twoMod = assertRenders(out, 'addModulator result');
  assert.ok(
    !buffersEqual(twoMod, oneMod),
    'the new constant-index modulator changes the sound',
  );
});

test("addModulator: refuses noise layers and the 5th modulator (the engine's 4-modulator limit)", () => {
  const p = fixturePatch();
  assert.throws(() => addModulator(p, 1), /patch-ops: addModulator needs an "fm" layer/);
  // A 4-modulator layer (the engine's INCLUSIVE max, src/lib/fm.js) —
  // it still renders, and the 5th add must refuse.
  const four = {
    layers: [{
      type: 'fm',
      carrier: { freq: 220 },
      modulators: [
        { freq: 440, index: 5 },
        { freq: 880, index: 3 },
        { freq: 1760, index: 2 },
        { freq: 3520, index: 1 },
      ],
      gain: 0.8,
    }],
    masterEffects: [],
  };
  assertRenders(four, 'a 4-modulator patch renders (the limit is inclusive)');
  assert.throws(
    () => addModulator(four, 0),
    (err) =>
      /patch-ops: layer 0 already has 4 modulators/.test(err.message)
      && /engine's limit \(src\/lib\/fm\.js\)/.test(err.message),
  );
});

test('addModulator: rejects a bad layer index', () => {
  const p = fixturePatch();
  assert.throws(() => addModulator(p, 2), /patch-ops: layer index/);
  assert.throws(() => addModulator(p, -1), /patch-ops: layer index/);
});

test('removeModulator: splices modulator j and keeps the survivors', () => {
  const p = addModulator(fixturePatch(), 0); // 2 mods
  const out = removeModulator(p, 0, 1);
  assert.equal(out.layers[0].modulators.length, 1);
  assert.equal(
    out.layers[0].modulators[0],
    p.layers[0].modulators[0],
    'the surviving modulator carries over',
  );
  assertRenders(out, 'removeModulator result');
});

test('removeModulator: zero modulators is allowed — a plain sine, non-silent, DIFFERENT from the 1-mod render', () => {
  const p = fixturePatch();
  const oneMod = render(p);
  const out = removeModulator(p, 0, 0);
  assert.deepEqual(out.layers[0].modulators, [], 'the layer keeps an empty modulator list');
  const sine = assertRenders(out, 'zero-modulator (plain sine) render');
  assert.ok(
    !buffersEqual(sine, oneMod),
    'the plain sine differs from the 1-modulator render',
  );
});

test('removeModulator: rejects a bad modulator index, noise layers, and a bad layer index', () => {
  const p = fixturePatch();
  assert.throws(() => removeModulator(p, 0, 1), /patch-ops: layer 0 has no modulator at index 1/);
  assert.throws(() => removeModulator(p, 0, -1), /patch-ops: layer 0 has no modulator at index -1/);
  assert.throws(() => removeModulator(p, 1, 0), /patch-ops: removeModulator needs an "fm" layer/);
  assert.throws(() => removeModulator(p, 5, 0), /patch-ops: layer index/);
});

// A cascaded 4-modulator layer: A <- B <- C <- D (each modulator
// targets its predecessor — a DX7-style chain the engine renders fine).
// The card's per-block [x] can remove ANY of them (P5/S14), including
// a cascade target — so the op must keep the surviving references
// renderable (contract 3) instead of shipping stale indices.
const cascadedPatch = () => ({
  layers: [{
    type: 'fm',
    carrier: { freq: 220 },
    modulators: [
      { freq: 440, index: 5 },              // A
      { freq: 880, index: 3, modulates: 0 }, // B -> A
      { freq: 1760, index: 2, modulates: 1 }, // C -> B
      { freq: 3520, index: 1, modulates: 2 }, // D -> C
    ],
    gain: 0.8,
  }],
  masterEffects: [],
});

test('removeModulator: removing a cascade target clears that reference (the driver falls back to the carrier) and keeps the output renderable', () => {
  const p = cascadedPatch();
  assertRenders(p, 'a 4-mod cascaded patch renders');
  // Remove B (index 1): C targeted B -> its reference is CLEARED (it
  // drives the carrier now); D targeted C -> it re-indexes 2 -> 1 and
  // still points at C; A carries over by reference (untouched).
  const out = removeModulator(p, 0, 1);
  assert.equal(out.layers[0].modulators.length, 3);
  assert.equal(out.layers[0].modulators[0], p.layers[0].modulators[0], 'A carries over by reference');
  assert.deepEqual(out.layers[0].modulators[1], { freq: 1760, index: 2, modulates: undefined }, 'C: the dead reference is cleared (drives the carrier)');
  assert.deepEqual(out.layers[0].modulators[2], { freq: 3520, index: 1, modulates: 1 }, 'D: re-indexed to still target C');
  assertRenders(out, 'the fixed-up chain renders (no stale reference, no cycle)');
});

test('removeModulator: removing the FIRST modulator re-indexes the surviving chain — the renderable output keeps targeting the same modulators', () => {
  const p = cascadedPatch();
  const out = removeModulator(p, 0, 0);
  assert.equal(out.layers[0].modulators.length, 3);
  // B targeted A (the removed mod) -> cleared; C targeted B -> now 0
  // (B is modulator 1); D targeted C -> now 1 (C is modulator 2).
  assert.deepEqual(out.layers[0].modulators[0], { freq: 880, index: 3, modulates: undefined });
  assert.deepEqual(out.layers[0].modulators[1], { freq: 1760, index: 2, modulates: 0 });
  assert.deepEqual(out.layers[0].modulators[2], { freq: 3520, index: 1, modulates: 1 });
  assertRenders(out, 'the re-indexed chain renders');
});

test('removeModulator: the two-mod self-cycle trap — removing the target of a 2-mod cascade cannot leave a self-reference (which the engine rejects)', () => {
  // [A, B -> A]: removing A leaves B with modulates 0 — its OWN index
  // after the splice (a self-cycle: the engine\'s cycle check would
  // throw). The fixup clears it instead.
  const p = {
    layers: [{
      type: 'fm',
      carrier: { freq: 220 },
      modulators: [
        { freq: 440, index: 5 },
        { freq: 880, index: 3, modulates: 0 },
      ],
      gain: 0.8,
    }],
    masterEffects: [],
  };
  assertRenders(p, 'the 2-mod cascade renders');
  const out = removeModulator(p, 0, 0);
  assert.deepEqual(out.layers[0].modulators, [{ freq: 880, index: 3, modulates: undefined }], 'the orphaned reference is cleared');
  assertRenders(out, '... and the result renders (no self-cycle, no out-of-range index)');
});

test('removeModulator: a reference BEFORE the splice point is unchanged and carried over by reference', () => {
  const p = cascadedPatch();
  // Remove D (index 3): C\'s reference (2 < 3) is untouched.
  const out = removeModulator(p, 0, 3);
  assert.equal(out.layers[0].modulators[2], p.layers[0].modulators[2], 'C (the last survivor) carries over by reference');
  assert.equal(out.layers[0].modulators.length, 3);
  assertRenders(out, 'the result renders');
});

// ---- addFx / removeFx ----------------------------------------------------

// The documented default fx objects (src/app/patch-ops.js NEW_FX).
const FX_DEFAULTS = {
  saturate: { type: 'saturate', drive: 2 },
  highpass: { type: 'highpass', cutoff: 2000 },
  resonate: { type: 'resonate', freq: 300, q: 5 },
  compress: { type: 'compress', threshold: 0.3, ratio: 3, makeup: 1.2 },
};

test('addFx master: each of the four types lands with its documented defaults and renders through the chain', () => {
  const base = fixturePatch();
  const baseRender = render(base);
  for (const [type, fx] of Object.entries(FX_DEFAULTS)) {
    const out = addFx(base, 'masterEffects', type);
    assert.equal(out.masterEffects.length, 2, `${type}: one slot appended`);
    assert.deepEqual(out.masterEffects[1], fx, `${type}: documented default object`);
    assert.equal(out.masterEffects[0], base.masterEffects[0], `${type}: the existing slot is shared`);
    const buf = assertRenders(out, `addFx master ${type}`);
    assert.ok(!buffersEqual(buf, baseRender), `${type}: the fx changes the mix`);
  }
});

test('addFx layer chain: adds to layers.<i>.effects and renders; masterEffects untouched', () => {
  const base = fixturePatch();
  const out = addFx(base, 'layers.1.effects', 'compress');
  assert.equal(out.layers[1].effects.length, 1, 'the (absent) chain starts with the new slot');
  assert.deepEqual(out.layers[1].effects[0], FX_DEFAULTS.compress);
  assert.equal(out.masterEffects, base.masterEffects, 'the master chain is untouched (same array)');
  assertRenders(out, 'addFx layer chain');
});

test('addFx: refuses unknown types and bad base paths (the drift guard)', () => {
  const p = fixturePatch();
  assert.throws(() => addFx(p, 'masterEffects', 'delay'), /patch-ops: unknown effect type/);
  assert.throws(
    () => addFx(p, 'masterEffects', 'delay'),
    /expected saturate \/ highpass \/ resonate \/ compress/,
  );
  assert.throws(() => addFx(p, 'bogus', 'saturate'), /unknown fx base path/);
  assert.throws(() => addFx(p, 'layers.0', 'saturate'), /unknown fx base path/);
  assert.throws(() => addFx(p, 'layers.x.effects', 'saturate'), /unknown fx base path/);
  // A well-shaped path to a layer that does not exist (stale card wiring).
  assert.throws(() => addFx(p, 'layers.5.effects', 'saturate'), /patch-ops: layer index/);
});

test('addFx: caps the chain at 4 slots', () => {
  let p = fixturePatch(); // master has 1 slot
  p = addFx(p, 'masterEffects', 'highpass');
  p = addFx(p, 'masterEffects', 'resonate');
  p = addFx(p, 'masterEffects', 'compress');
  assert.equal(p.masterEffects.length, 4, 'grown to the cap');
  assert.throws(
    () => addFx(p, 'masterEffects', 'saturate'),
    (err) =>
      /patch-ops: at most 4 fx slots per chain/.test(err.message)
      && /Master chain already has 4/.test(err.message),
  );
  // The cap is PER CHAIN: a full master chain leaves the layer chains open.
  assert.equal(addFx(p, 'layers.0.effects', 'saturate').layers[0].effects.length, 2);
});

test('removeFx: splices slot i from the master chain and renders', () => {
  const p = fixturePatch(); // master: [saturate]
  const out = removeFx(p, 'masterEffects', 0);
  assert.deepEqual(out.masterEffects, [], 'the chain is emptied');
  assert.equal(out.layers, p.layers, 'layers untouched, same array');
  assertRenders(out, 'removeFx master result');
  // With two slots, removing the second keeps the first in order.
  const two = addFx(p, 'masterEffects', 'highpass');
  const out2 = removeFx(two, 'masterEffects', 1);
  assert.equal(out2.masterEffects.length, 1);
  assert.equal(out2.masterEffects[0], p.masterEffects[0], 'the first slot survives');
  assertRenders(out2, 'removeFx master (second slot)');
});

test('removeFx: splices slot i from a layer chain; rejects bad slot indices and empty chains', () => {
  const p = fixturePatch();
  const out = removeFx(p, 'layers.0.effects', 0); // the body's resonator
  assert.deepEqual(out.layers[0].effects, [], 'the chain is emptied');
  assert.equal(out.masterEffects, p.masterEffects, 'the master chain is untouched');
  assertRenders(out, 'removeFx layer result');
  assert.throws(() => removeFx(p, 'layers.0.effects', 1), /has no fx slot at index 1/);
  assert.throws(() => removeFx(p, 'layers.1.effects', 0), /has no fx slot at index 0/);
  assert.throws(() => removeFx(p, 'masterEffects', 5), /has no fx slot at index 5/);
  assert.throws(() => removeFx(p, 'layers.9.effects', 0), /patch-ops: layer index/);
});

// ---- withSolo -------------------------------------------------------------

test('withSolo: zeros the gain of every layer not in keepIndices (shallow layer clone)', () => {
  const p = fixturePatch();
  const out = withSolo(p, [1]);
  assert.equal(out.layers[0].gain, 0, 'the unsoloed layer is zeroed');
  assert.deepEqual(out.layers[0], { ...p.layers[0], gain: 0 }, 'only the gain changed');
  assert.equal(out.layers[1], p.layers[1], 'the soloed layer carries over untouched');
  assertRenders(out, 'withSolo result');
});

test('withSolo: the solo render differs from the mix and equals the hand-built single-layer patch render', () => {
  const p = fixturePatch();
  const mix = render(p);
  // Solo the FM body: the noise layer's contribution must be gone and
  // the result must equal a hand-built single-layer patch (the same
  // layer object, as isolateLayer would hand it out, under the same
  // master chain — the mix-minus-solo expectation, P7).
  const soloFm = render(withSolo(p, [0]));
  assert.ok(!buffersEqual(soloFm, mix), 'the solo drops the noise layer');
  const handBuiltFm = { layers: [p.layers[0]], masterEffects: p.masterEffects };
  assert.ok(buffersEqual(soloFm, render(handBuiltFm)), 'solo === the single-layer render');
  // And the other way round: solo the noise layer.
  const soloNoise = render(withSolo(p, [1]));
  assert.ok(!buffersEqual(soloNoise, mix), 'the solo drops the FM body');
  const handBuiltNoise = { layers: [p.layers[1]], masterEffects: p.masterEffects };
  assert.ok(buffersEqual(soloNoise, render(handBuiltNoise)), 'solo === the single-layer render');
});

test('withSolo: an empty keepIndices is the full mix (new object, byte-identical render)', () => {
  const p = fixturePatch();
  const out = withSolo(p, []);
  assert.notEqual(out, p, 'still a new patch object');
  assert.equal(out.layers[0], p.layers[0], 'layer 0 carries over untouched');
  assert.equal(out.layers[1], p.layers[1], 'layer 1 carries over untouched');
  assert.ok(buffersEqual(render(out), render(p)), 'mix-identical render');
});

test('withSolo: keeping every index keeps every gain (mix-identical render)', () => {
  const p = fixturePatch();
  const out = withSolo(p, [0, 1]);
  assert.equal(out.layers[0].gain, p.layers[0].gain, 'layer 0 gain kept');
  assert.equal(out.layers[1].gain, p.layers[1].gain, 'layer 1 gain kept');
  assert.ok(buffersEqual(render(out), render(p)), 'mix-identical render');
});

test('withSolo: refuses unknown indices and a non-array keep list', () => {
  const p = fixturePatch();
  assert.throws(() => withSolo(p, [2]), /patch-ops: withSolo unknown layer index 2/);
  assert.throws(() => withSolo(p, [-1]), /patch-ops: withSolo unknown layer index -1/);
  assert.throws(() => withSolo(p, [0.5]), /patch-ops: withSolo unknown layer index/);
  assert.throws(() => withSolo(p, 0), /patch-ops: keepIndices must be an array/);
  assert.throws(() => withSolo(p, '0'), /patch-ops: keepIndices must be an array/);
});

// ---- silentPatch (the all-muted mix view, P7/S17) --------------------

test('silentPatch: zeros EVERY layer gain and the render is silence', () => {
  const p = fixturePatch();
  const out = silentPatch(p);
  assert.equal(out.layers.length, 2);
  for (const layer of out.layers)
    assert.equal(layer.gain, 0, 'every layer gain is zeroed');
  // The render is ALL ZEROS — the silence the disabled/solo mix view
  // must produce (energy in every window, including the attack
  // window, drops to zero).
  const buf = render(out);
  assert.equal(buf.length, Math.round(DUR * SR), 'the length is right');
  for (let n = 0; n < buf.length; n += 1)
    assert.equal(buf[n], 0, `sample ${n} of the all-muted render`);
});

test('silentPatch: rejects a patch without a layers array', () => {
  for (const bad of [undefined, null, 42, 'patch', {}, { layers: 'nope' }])
    assert.throws(
      () => silentPatch(bad),
      /patch-ops: patch must be an object with a layers array/,
    );
});

// ---- mixView (the render-ready mix, P7/S17) -------------------------

test('mixView: the default view (no disabled, no solo) is the full mix — byte-identical render', () => {
  const p = fixturePatch();
  const out = mixView(p, [], []);
  assert.equal(out.layers[0], p.layers[0], 'layer 0 carries over untouched');
  assert.equal(out.layers[1], p.layers[1], 'layer 1 carries over untouched');
  assert.ok(buffersEqual(render(out), render(p)), 'mix-identical render');
});

test('mixView: disabling a layer zeros ONLY its gain — the other source plays, its contribution is gone from the render', () => {
  const p = fixturePatch(); // two sources: FM body (0) + noise click (1)
  const mix = render(p);
  const out = mixView(p, [1], []); // disable the noise click
  assert.equal(out.layers[1].gain, 0, 'the disabled layer is zeroed');
  assert.deepEqual(out.layers[1], { ...p.layers[1], gain: 0 }, '... and only its gain changed');
  assert.equal(out.layers[0], p.layers[0], 'the enabled layer is untouched (same object)');
  const buf = assertRenders(out, 'mixView with one layer disabled');
  assert.ok(!buffersEqual(buf, mix), 'the mix render differs from the full mix');
  // For a 2-source drum the mixed render equals the OTHER source's
  // isolated render: a hand-built single-layer patch under the same
  // master chain (the zeroed source contributes exactly nothing
  // before the master fx — byte-identity, stronger than the final-
  // clamp tolerance).
  const isolated = { layers: [p.layers[0]], masterEffects: p.masterEffects };
  assert.ok(buffersEqual(buf, render(isolated)), '=== the other source\'s isolated render');
});

test('mixView: the disabled source\'s energy window drops to zero (temporally separated sources)', () => {
  // A dedicated 2-source fixture the sources do not overlap in time, so
  // each one owns a window the other is exactly silent in: the noise
  // burst (decay 0.1 — an exponential collapse, non-zero but decaying
  // after 100 ms) owns the early window, the FM sine is gated to the
  // last ~50 ms by its levelEnv (exactly zero before 400 ms). No
  // master fx: the mix is the plain sum, so a zeroed layer removes
  // exactly its contribution.
  const gated = {
    layers: [
      {
        type: 'fm',
        carrier: { freq: 220 },
        modulators: [], // a plain sine (the zero-modulator case)
        gain: 1,
        levelEnv: [
          { t: 0, v: 0 },
          { t: 0.4, v: 0 },
          { t: 0.45, v: 1 },
          { t: 0.5, v: 1 },
        ],
      },
      { type: 'noise', seed: 1, cutoff: 2000, decay: 0.1, gain: 1 },
    ],
    masterEffects: [],
  };
  const energy = (b, fromS, toS) => {
    let e = 0;
    for (let n = Math.floor(fromS * SR); n < Math.floor(toS * SR); n += 1)
      e += Math.abs(b[n]);
    return e;
  };
  const mix = render(gated);
  assert.ok(energy(mix, 0.02, 0.04) > 0, 'fixture: the full mix carries the burst in its early window');
  assert.ok(energy(mix, 0.46, 0.49) > 0, 'fixture: ... and the gated sine in its late window');
  const out = mixView(gated, [1], []); // disable the burst
  const buf = render(out);
  assert.equal(energy(buf, 0.02, 0.04), 0, 'the disabled source\'s energy window drops to exactly zero');
  assert.ok(energy(buf, 0.46, 0.49) > 0, '... the enabled source keeps its own window');
  assert.ok(!buffersEqual(buf, mix), 'the mixed render differs from the full mix');
});

test('mixView: no solo -> all ENABLED play (a disabled one stays out); the enabled set renders byte-identically to its own single-layer patch', () => {
  const p = fixturePatch();
  const out = mixView(p, [0], []); // no solo, body disabled -> noise only
  const buf = assertRenders(out, 'mixView: enabled-only mix');
  const isolated = { layers: [p.layers[1]], masterEffects: p.masterEffects };
  assert.ok(buffersEqual(buf, render(isolated)), '=== the enabled source\'s isolated render');
  assert.ok(!buffersEqual(buf, render(p)), '... and differs from the full mix');
});

test('mixView: any solo active keeps only the SOLOED layers (nothing disabled) — the solo render equals the soloed source\'s isolated render', () => {
  const p = fixturePatch();
  // Solo the body, nothing disabled: the noise click is out.
  const soloBody = mixView(p, [], [0]);
  assert.equal(soloBody.layers[1].gain, 0, 'the unsoloed layer is zeroed');
  assert.equal(soloBody.layers[0], p.layers[0], 'the soloed layer is untouched');
  const buf = assertRenders(soloBody, 'mixView solo');
  assert.ok(!buffersEqual(buf, render(p)), 'the solo differs from the full mix');
  const isolated = { layers: [p.layers[0]], masterEffects: p.masterEffects };
  assert.ok(buffersEqual(buf, render(isolated)), '=== the soloed source\'s isolated render');
  // And the other way round: solo the noise click.
  const soloNoise = mixView(p, [], [1]);
  const buf2 = assertRenders(soloNoise, 'mixView solo (other source)');
  const isolated2 = { layers: [p.layers[1]], masterEffects: p.masterEffects };
  assert.ok(buffersEqual(buf2, render(isolated2)), '=== the noise click\'s isolated render');
});

test('mixView: a SOLOED-BUT-DISABLED source is silent — it plays on neither side of the intersection', () => {
  const p = fixturePatch();
  // Solo the body AND disable it: the only soloed layer is also the
  // only disabled one -> nothing is kept -> SILENCE (not the full
  // mix: withSolo's empty-keep semantics would be wrong here).
  const out = mixView(p, [0], [0]);
  for (const layer of out.layers)
    assert.equal(layer.gain, 0, 'nothing is kept — every layer is zeroed');
  const buf = render(out);
  for (let n = 0; n < buf.length; n += 1)
    assert.equal(buf[n], 0, 'the mix is silent');
  // The other source (soloed, enabled) would play: solo both -> keep
  // the enabled one.
  const out2 = mixView(p, [0], [0, 1]);
  assert.equal(out2.layers[1], p.layers[1], 'the enabled solo survives');
  assert.equal(out2.layers[0].gain, 0, 'the disabled solo is zeroed');
  const buf2 = assertRenders(out2, 'solo both, one disabled');
  const isolated = { layers: [p.layers[1]], masterEffects: p.masterEffects };
  assert.ok(buffersEqual(buf2, render(isolated)), '=== the enabled solo\'s isolated render');
});

test('mixView: disabling EVERY layer (no solo) is silence — not the full mix', () => {
  const p = fixturePatch();
  const out = mixView(p, [0, 1], []);
  const buf = render(out);
  for (let n = 0; n < buf.length; n += 1)
    assert.equal(buf[n], 0, 'every layer disabled -> the mix is silent');
  assert.ok(!buffersEqual(buf, render(p)), '... and the full mix is not');
});

test('mixView: soloing a DISABLED-ONLY state with no enabled solo is silence, and clearing the solo restores the enabled mix', () => {
  const p = fixturePatch();
  // Both disabled, one soloed: keep = solo ∩ enabled = {} -> silent.
  const silent = render(mixView(p, [0, 1], [1]));
  for (let n = 0; n < silent.length; n += 1)
    assert.equal(silent[n], 0, 'soloed-but-disabled only -> silence');
  // Clear the solo: keep = enabled = {} -> STILL silence (the other
  // source is disabled too) — then re-enable: the full mix returns.
  const stillSilent = render(mixView(p, [0, 1], []));
  for (let n = 0; n < stillSilent.length; n += 1)
    assert.equal(stillSilent[n], 0, 'no solo, nothing enabled -> still silent');
  assert.ok(buffersEqual(render(mixView(p, [], [])), render(p)), 're-enabled: the full mix returns');
});

test('mixView: refuses unknown indices and non-array state lists', () => {
  const p = fixturePatch();
  assert.throws(() => mixView(p, [2], []), /patch-ops: mixView unknown layer index 2/);
  assert.throws(() => mixView(p, [0], [1, -1]), /patch-ops: mixView unknown layer index -1/);
  assert.throws(() => mixView(p, [0.5], []), /patch-ops: mixView unknown layer index/);
  assert.throws(() => mixView(p, '0', []), /patch-ops: disabledIndices must be an array/);
  assert.throws(() => mixView(p, [0], '1'), /patch-ops: soloIndices must be an array/);
});

// ---- shared preconditions --------------------------------------------------

test('every op rejects a patch without a layers array', () => {
  for (const bad of [undefined, null, 42, 'patch', {}, { layers: 'nope' }]) {
    assert.throws(
      () => addLayer(bad, 'fm'),
      /patch-ops: patch must be an object with a layers array/,
    );
    assert.throws(
      () => withSolo(bad, []),
      /patch-ops: patch must be an object with a layers array/,
    );
  }
});
