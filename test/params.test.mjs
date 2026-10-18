import test from 'node:test';
import assert from 'node:assert/strict';

import { clamp, getPath, setPath } from '../src/lib/params.js';
import { renderPatch } from '../src/lib/engine.js';
import { kickPatch } from '../src/lib/voices/kick.js';
import { snarePatch } from '../src/lib/voices/snare.js';
import { hihatPatch } from '../src/lib/voices/hihat.js';
import {
  descriptorRead,
  descriptorWrite,
  describePatch,
} from '../src/app/controls.js';

// --- getPath / setPath -------------------------------------------------

test('getPath reads nested values incl. array indices', () => {
  const obj = {
    layers: [
      { carrier: { freq: 50 }, modulators: [{ freq: 200, index: 8 }] },
      { cutoff: 2000 },
    ],
    masterEffects: [{ drive: 2 }],
  };
  assert.equal(getPath(obj, 'layers.0.carrier.freq'), 50);
  assert.equal(getPath(obj, 'layers.0.modulators.0.index'), 8);
  assert.equal(getPath(obj, 'layers.1.cutoff'), 2000);
  assert.equal(getPath(obj, 'masterEffects.0.drive'), 2);
  // A single-segment path reads a top-level property.
  assert.equal(getPath({ n: 3 }, 'n'), 3);
});

test('getPath/setPath round-trip on nested objects incl. array indices', () => {
  const obj = { a: { b: [{ c: 7 }, { c: 8 }] }, layers: [{ gain: 0.5 }] };
  const paths = ['a.b.0.c', 'a.b.1.c', 'layers.0.gain'];
  const writes = [100, -3.25, 1];
  for (let i = 0; i < paths.length; i++) {
    setPath(obj, paths[i], writes[i]);
    assert.equal(getPath(obj, paths[i]), writes[i], `round-trip ${paths[i]}`);
  }
  // Untouched values survive.
  assert.equal(getPath(obj, 'a.b.1.c'), -3.25);
  assert.equal(getPath(obj, 'layers.0.gain'), 1);
});

test('setPath updates the object in place (live patch contract)', () => {
  // The UI edits the live engine patch: the container is mutated, never
  // rebuilt, so the same object the engine renders is the one edited.
  const obj = { layers: [{ gain: 0.8 }] };
  const layer = obj.layers[0];
  setPath(obj, 'layers.0.gain', 0.5);
  assert.equal(layer.gain, 0.5);
  assert.equal(obj.layers[0], layer);
});

test('setPath/getPath are strict: missing paths throw (documented choice)', () => {
  // Plan step 13: setPath does NOT create missing intermediates — a
  // failing descriptor path is a typo, and inventing keys would
  // corrupt the live patch instead of surfacing the bug.
  const obj = { layers: [{ gain: 0.8 }] };
  assert.throws(() => setPath(obj, 'layers.0.gains', 1), /does not resolve/);
  assert.throws(() => setPath(obj, 'layers.9.gain', 1), /out of range/);
  assert.throws(() => setPath(obj, 'layers.0.gain.0', 1), /non-object/);
  assert.throws(() => setPath({}, 'a.b', 1), /not found/);
  assert.throws(() => setPath(obj, 'nope', 1), /does not resolve/);
  // Arrays are never extended.
  assert.throws(() => setPath(obj, 'layers.1', {}), /does not resolve/);
  // Nothing was created by the failed writes above.
  assert.deepEqual(Object.keys(obj.layers[0]), ['gain']);
  assert.throws(() => getPath(obj, 'layers.0.gains'), /does not resolve/);
  assert.throws(() => getPath(obj, 'a.b.c'), /not found/);
});

test('getPath/setPath reject malformed paths', () => {
  const obj = { a: [1, 2, 3] };
  assert.throws(() => getPath(obj, ''), /non-empty/);
  assert.throws(() => getPath(obj, 'a..b'), /empty segment/);
  assert.throws(() => getPath(obj, 'a.0.b'), /non-object/);
  assert.throws(() => setPath(obj, 'a.x', 5), /array index/);
  assert.throws(() => setPath(obj, 'a.3', 5), /does not resolve/);
});

// --- clamp -------------------------------------------------------------

test('clamp bounds', () => {
  assert.equal(clamp(5, 0, 10), 5); // in range: unchanged
  assert.equal(clamp(-1, 0, 10), 0); // below min
  assert.equal(clamp(11, 0, 10), 10); // above max
  assert.equal(clamp(0, 0, 10), 0); // at min
  assert.equal(clamp(10, 0, 10), 10); // at max
  assert.throws(() => clamp(1, 5, 2), /min.*≤.*max/);
  assert.throws(() => clamp(NaN, 0, 10), /finite/);
});

// --- Descriptor sanity + parameter plumbing (plan step 13) -------------
//
// The UI builds one slider per descriptor, seeds it with
// getPath(patch, path), and writes slider values back with setPath
// before re-rendering. The descriptors come from the describePatch
// factory (src/app/controls.js, revamp P1/S3), so these sections test
// the factory indirectly. Two things must hold for that contract to
// work:
//   1. every descriptor path resolves on the built patch (a typo here
//      throws in the browser and kills the whole UI), and the default
//      lies in [min, max] (the slider range must not snap the default);
//   2. every descriptor actually moves the render (a dead path that
//      happens to resolve would be a slider that does nothing).
//
// Render rates: 8 kHz / 0.5 s per GUIDELINES §4, except the hi-hat —
// its recipe's 8 kHz master high-pass and ~20.5 kHz top partial only
// fit under the 22.05 kHz Nyquist, so it renders at 44.1 kHz (the
// playback rate; same reason step 12's voice tests use 16 kHz).
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
  test(`descriptor sanity: ${voice.name} — paths resolve, defaults in [min, max]`, () => {
    const patch = voice.patch();
    const descriptors = describePatch(patch);
    assert.ok(descriptors.length > 0, 'voice has no descriptors');
    for (const d of descriptors) {
      assert.ok(typeof d.path === 'string' && d.path.length > 0, `${d.label}: missing path`);
      assert.ok(typeof d.label === 'string' && d.label.length > 0, `${d.path}: missing label`);
      assert.ok(Number.isFinite(d.min) && Number.isFinite(d.max) && d.min < d.max,
        `${d.path}: bad range [${d.min}, ${d.max}]`);
      assert.ok(Number.isFinite(d.step) && d.step > 0, `${d.path}: bad step`);
      // The value the CONTROL sees: the raw patch value through the
      // descriptor's optional read transform (the DAHDSR level knobs'
      // raw value is the whole point array, plan "dahdsr" P3/S2).
      const value = descriptorRead(d, getPath(patch, d.path)); // throws on a typo'd path
      assert.ok(Number.isFinite(value), `${d.label}: default is not finite`);
      assert.ok(value >= d.min && value <= d.max,
        `${d.label}: default ${value} outside [${d.min}, ${d.max}]`);
    }
  });

  test(`parameter plumbing: ${voice.name} — every descriptor moves the render`, () => {
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
        // window) — through the knobs' own writes (one knob turn
        // re-derives all six points, eight turns compose), and
        // re-baseline.
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
      assert.notEqual(alt, current, `${d.label}: no alternative value`);
      setPath(patch, d.path, descriptorWrite(d, getPath(patch, d.path), alt));
      const changed = renderPatch(patch, {
        sampleRate: voice.sampleRate,
        duration: 0.5,
      });
      const diff = maxDiff(baseline, changed);
      assert.ok(diff > 0, `${d.label} → ${alt} does not change the render`);
    }
  });
}
