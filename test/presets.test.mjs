// Preset registry + drum-list operations (revamp P2/S5).
//
// Tests may import src/app/ directly (GUIDELINES §1.4 exemption); the
// facade import below is what the non-silent-render test uses, so the
// registry's patches are verified through the same public API the app
// uses.
//
// Render rate: 8 kHz (the repo's test rate, GUIDELINES §4) for
// kick/snare/blank/tom/clap — but 44.1 kHz for hihat: its recipe's
// 8 kHz master high-pass sits above the 8 kHz Nyquist (4 kHz), which
// renderPatch rejects, and for cymbal: its top partial (12.57 kHz) is
// above the 8 kHz Nyquist (4 kHz) and would alias, while at 44.1 kHz
// the full recipe is legal (top partial 20.48 kHz < 22.05 kHz Nyquist
// for hihat, 12.57 kHz for cymbal — the same precedent as
// test/hihat.test.mjs and the P1/S2–S3 descriptor tests).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS,
  presetById,
  presetOptions,
  addDrum,
  uniqueDrumName,
  removeDrum,
  renameDrum,
  SLOT_KEY,
  SLOT_NAME_MAX,
  listSlots,
  loadSlot,
  saveSlot,
  deleteSlot,
  slotOptionValue,
  slotNameFromValue,
  drumToJson,
  jsonToDrum,
} from '../src/app/presets.js';
import { isCanonicalLevel, pointsToDahdsr } from '../src/app/dahdsr.js';
import { envelopeValue, renderPatch } from '../src/lib/index.js';

// The render rate each preset's full recipe is legal at (see header).
const renderRate = (id) => (id === 'hihat' || id === 'cymbal' ? 44100 : 8000);

// Largest |sample| of a buffer — the non-silence probe (GUIDELINES §4:
// assert on properties, never full-buffer equality).
const maxAbs = (buf) => {
  let m = 0;
  for (const s of buf) m = Math.max(m, Math.abs(s));
  return m;
};

// A minimal drum list in the exact shape the app's boot list /
// exportDrum use ({ name, duration, patch }); the marker patches are
// never rendered.
const mkDrums = (names) =>
  names.map((name) => ({ name, duration: 0.5, patch: { layers: [] } }));

// ---- registry shape ----------------------------------------------------

test('PRESETS: ids and labels are unique non-empty strings', () => {
  assert.ok(PRESETS.length >= 4, 'at least the four planned presets');
  for (const [field, what] of [['id', 'id'], ['label', 'label']]) {
    const values = PRESETS.map((p) => p[field]);
    for (const v of values)
      assert.equal(
        typeof v === 'string' && v.length > 0,
        true,
        `every preset ${what} is a non-empty string (got ${JSON.stringify(v)})`,
      );
    assert.equal(
      new Set(values).size,
      values.length,
      `preset ${what}s are unique`,
    );
  }
  // The first seven presets, in order: the classic four, then the new
  // voices (APPENDED in P9/S22–24 — so this prefix is the stable part).
  assert.deepEqual(
    PRESETS.slice(0, 7).map((p) => p.id),
    ['kick', 'snare', 'hihat', 'blank', 'tom', 'clap', 'cymbal'],
  );
  for (const p of PRESETS) {
    assert.equal(typeof p.build, 'function', `${p.id}: build is a function`);
    assert.ok(
      Number.isFinite(p.duration) && p.duration > 0,
      `${p.id}: duration ${p.duration} is positive`,
    );
  }
  // The classic durations match the pre-registry values the app boots
  // with (DRUMS in src/app/main.js, revamp P2/S6) — a registry
  // change that moves them changes the booted app, so this pins it.
  assert.equal(presetById('kick').duration, 0.5);
  assert.equal(presetById('snare').duration, 0.5);
  assert.equal(presetById('hihat').duration, 0.3);
  assert.equal(presetById('blank').duration, 0.5);
  assert.equal(presetById('tom').duration, 0.4);
  assert.equal(presetById('clap').duration, 0.3);
  assert.equal(presetById('cymbal').duration, 1.5);
});

test('PRESETS: every build() returns a fresh patch with a layers array', () => {
  for (const p of PRESETS) {
    const patch = p.build();
    assert.ok(Array.isArray(patch.layers), `${p.id}: patch.layers is an array`);
    assert.ok(patch.layers.length > 0, `${p.id}: at least one layer`);
    // The voice builders' no-aliasing contract (fresh arrays per call)
    // applies to blank's inline build too: two builds never share a
    // nested array, so a live patch can never alias a registry build.
    const other = p.build();
    assert.notEqual(patch, other, `${p.id}: builds are distinct objects`);
    assert.notEqual(
      patch.layers[0].levelEnv,
      other.layers[0].levelEnv,
      `${p.id}: nested arrays are not shared between builds`,
    );
  }
});

test('PRESETS: every preset renders non-silently at 0.3 s', () => {
  for (const p of PRESETS) {
    const hit = renderPatch(p.build(), {
      sampleRate: renderRate(p.id),
      duration: 0.3,
    });
    const m = maxAbs(hit);
    assert.ok(
      m > 0.01,
      `${p.id}: render is non-silent (maxAbs ${m.toFixed(5)})`,
    );
  }
});

// UI-adjacent pure check (revamp P2/S8): the "New drum" picker's option
// list is built by presetOptions — the main.js select is generated from
// it, so its shape and order are pinned here.
test('presetOptions: one {value, label} per preset, in registry order', () => {
  const options = presetOptions();
  assert.equal(options.length, PRESETS.length, 'one option per preset');
  for (let i = 0; i < PRESETS.length; i += 1) {
    // deepEqual also guards the shape: exactly value+label, no extras.
    assert.deepEqual(
      options[i],
      { value: PRESETS[i].id, label: PRESETS[i].label },
      `option ${i} mirrors the registry`,
    );
  }
  // The values are preset ids: a chosen option feeds addDrum unchanged.
  for (const { value } of options)
    assert.equal(presetById(value).id, value);
  // A fresh list per call — the picker must not hand out shared state.
  assert.notEqual(presetOptions(), options, 'fresh list per call');
});

test('presetById: resolves each id; unknown ids throw naming the available ones', () => {
  for (const p of PRESETS) assert.equal(presetById(p.id), p);
  assert.throws(
    () => presetById('bongos'),
    (err) => {
      assert.match(err.message, /bongos/);
      for (const p of PRESETS) assert.match(err.message, new RegExp(p.id));
      return true;
    },
  );
});

// ---- addDrum -----------------------------------------------------------

test('addDrum: appends the preset, uniquifying the name kick, kick-2, ...', () => {
  const one = addDrum([], 'kick');
  assert.equal(one.length, 1);
  assert.deepEqual(
    { name: one[0].name, duration: one[0].duration },
    { name: 'kick', duration: 0.5 },
  );
  const two = addDrum(one, 'kick');
  assert.equal(two[1].name, 'kick-2');
  const three = addDrum(two, 'kick');
  assert.equal(three[2].name, 'kick-3');
  // A different preset keeps its own base name; existing entries keep
  // their order.
  const four = addDrum(three, 'hihat');
  assert.deepEqual(
    four.map((d) => d.name),
    ['kick', 'kick-2', 'kick-3', 'hihat'],
  );
  assert.equal(four[3].duration, 0.3); // the preset's own duration
});

// The "+ drum" button (plan "colors" S5) reuses the helper directly
// (the drum is built from the blank preset but named from 'new', so
// it can't masquerade as the Blank preset's label in the select).
test('uniqueDrumName: passes an unused base through, uniquifying the rest', () => {
  assert.equal(uniqueDrumName([], 'new'), 'new');
  assert.equal(uniqueDrumName([{ name: 'kick' }], 'new'), 'new');
  assert.equal(uniqueDrumName([{ name: 'new' }], 'new'), 'new-2');
  assert.equal(
    uniqueDrumName([{ name: 'new' }, { name: 'new-2' }], 'new'),
    'new-3',
  );
  // A gap in the sequence is fine — only the CURRENT names count.
  assert.equal(
    uniqueDrumName([{ name: 'new' }, { name: 'new-3' }], 'new'),
    'new-2',
  );
});

test('addDrum: never mutates the input list', () => {
  const input = mkDrums(['kick']);
  const snapshot = structuredClone(input);
  const out = addDrum(input, 'snare');
  assert.notEqual(out, input, 'a new list is returned');
  assert.deepEqual(input, snapshot, 'the input list is untouched');
  assert.equal(out.length, 2);
});

test('addDrum: the appended patch is an independent clone of the build', () => {
  const snapshot = structuredClone(presetById('kick').build());
  const drums = addDrum([], 'kick');
  assert.deepEqual(drums[0].patch, snapshot, 'added patch = a fresh build');
  // Mutate the live patch at two depths.
  drums[0].patch.layers[0].gain = 0.123;
  drums[0].patch.layers[0].carrier.freq = 999;
  // The registry is untouched: a fresh build still has the recipe
  // defaults (kick body: 50 Hz carrier, gain 0.8).
  const fresh = presetById('kick').build();
  assert.equal(fresh.layers[0].gain, 0.8);
  assert.equal(fresh.layers[0].carrier.freq, 50);
  assert.deepEqual(fresh, snapshot);
});

test('addDrum: two drums from the same preset do not share a patch', () => {
  const drums = addDrum(addDrum([], 'blank'), 'blank');
  assert.notEqual(drums[0].patch, drums[1].patch);
  drums[0].patch.layers[0].carrier.freq = 1; // mutate one live patch
  assert.equal(drums[1].patch.layers[0].carrier.freq, 220); // ...other stays
});

// ---- removeDrum ----------------------------------------------------------

test('removeDrum: drops the named drum, leaves the rest untouched', () => {
  const input = mkDrums(['kick', 'snare', 'hihat']);
  const out = removeDrum(input, 'snare');
  assert.notEqual(out, input, 'a new list is returned');
  assert.deepEqual(out.map((d) => d.name), ['kick', 'hihat']);
  assert.equal(out[0], input[0], 'surviving entry: same object (same live patch)');
  assert.equal(out[1], input[2]);
  assert.equal(input.length, 3, 'the input list is untouched');
});

test('removeDrum: refuses to remove the last drum', () => {
  const input = mkDrums(['kick']);
  assert.throws(
    () => removeDrum(input, 'kick'),
    /at least one drum/,
  );
  assert.equal(input.length, 1, 'the list survives the refused removal');
});

test('removeDrum: unknown name throws', () => {
  const input = mkDrums(['kick', 'snare']);
  assert.throws(() => removeDrum(input, 'bongos'), /bongos/);
});

// ---- renameDrum ----------------------------------------------------------

test('renameDrum: returns a new list with a renamed entry', () => {
  const input = mkDrums(['kick', 'snare']);
  const out = renameDrum(input, 'snare', 'my snare');
  assert.notEqual(out, input, 'a new list is returned');
  assert.deepEqual(out.map((d) => d.name), ['kick', 'my snare']);
  assert.equal(out[0], input[0], 'other entries: same objects');
  assert.notEqual(out[1], input[1], 'renamed entry: new object');
  assert.equal(out[1].patch, input[1].patch, 'the live patch carries over');
  assert.equal(input[1].name, 'snare', 'the input entry is not mutated');
});

test('renameDrum: a name clash throws', () => {
  const input = mkDrums(['kick', 'snare']);
  assert.throws(() => renameDrum(input, 'kick', 'snare'), /already exists/);
});

test('renameDrum: an empty (or whitespace-only) new name throws', () => {
  const input = mkDrums(['kick']);
  assert.throws(() => renameDrum(input, 'kick', ''), /non-empty/);
  assert.throws(() => renameDrum(input, 'kick', '   '), /non-empty/);
});

test('renameDrum: an unknown old name throws', () => {
  const input = mkDrums(['kick']);
  assert.throws(() => renameDrum(input, 'bongos', 'x'), /bongos/);
});

// ---- named save slots (P8/S19) ----------------------------------------

// A minimal in-memory localStorage — the browser contract the slot API
// guards (getItem / setItem on the slot key). The "absent" case (the
// guard's private-mode path) is the Node host's own state: no
// globalThis.localStorage at all.
const makeStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    clear: () => { map.clear(); },
  };
};

// Run fn with `store` (an object — or undefined for the absent case)
// installed as globalThis.localStorage, restoring the host's binding
// afterwards (Node has none by default; a webstorage-enabled host keeps
// its own getter).
const withStorage = (store, fn) => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const defineValue = (value) => Object.defineProperty(globalThis, 'localStorage',
    { value, configurable: true, writable: true, enumerable: true });
  if (desc && store === undefined) {
    // Absent case on a host that HAS a binding: mask it with undefined.
    defineValue(undefined);
  } else if (store !== undefined) {
    defineValue(store);
  }
  try {
    return fn();
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    else delete globalThis.localStorage;
  }
};

// A real drum-shaped fixture: the kick preset's fresh build at its
// registry duration (the slot stores exactly this shape's data).
const slotDrum = () => ({
  name: 'kick',
  duration: presetById('kick').duration,
  patch: structuredClone(presetById('kick').build()),
});

test('slots: save -> list -> load round-trips the patch (deep-equal, fresh objects)', () => {
  withStorage(makeStorage(), () => {
    const drum = slotDrum();
    assert.deepEqual(saveSlot('kick-ish', drum), { ok: true });
    assert.deepEqual(listSlots(), { ok: true, slots: ['kick-ish'] });
    const loaded = loadSlot('kick-ish');
    assert.equal(loaded.ok, true);
    // The stored shape is the plain { name, duration, patch } — the
    // SLOT's name, not the drum's (the rename-separation contract).
    assert.deepEqual(
      Object.keys(loaded.slot).sort(),
      ['duration', 'name', 'patch'],
      'the stored shape is the plain { name, duration, patch }',
    );
    assert.equal(loaded.slot.name, 'kick-ish');
    assert.equal(loaded.slot.duration, 0.5);
    assert.deepEqual(loaded.slot.patch, drum.patch, 'the patch round-trips deep-equal');
    assert.notEqual(loaded.slot.patch, drum.patch, '... and is a DIFFERENT object (no aliasing the live patch)');
    assert.notEqual(loaded.slot.patch.layers[0], drum.patch.layers[0], '... nested layer objects are not shared either');
    // Editing the LOADED patch does not corrupt the stored slot ...
    loaded.slot.patch.layers[0].gain = 0.001;
    const again = loadSlot('kick-ish');
    assert.deepEqual(again.slot.patch, drum.patch, 'the stored slot survives the loaded copy being mutated');
    // ... and editing the LIVE patch does not corrupt it (the save
    // cloned on the way in).
    drum.patch.layers[0].carrier.freq = 1;
    const onceMore = loadSlot('kick-ish');
    assert.notDeepEqual(onceMore.slot.patch, drum.patch, 'the stored slot is a snapshot, not a live reference');
    assert.equal(onceMore.slot.patch.layers[0].carrier.freq, presetById('kick').build().layers[0].carrier.freq);
  });
});

test('slots: saving twice under one name overwrites the slot', () => {
  withStorage(makeStorage(), () => {
    const drum = slotDrum();
    saveSlot('x', drum);
    drum.duration = 0.9;
    assert.deepEqual(saveSlot('x', drum), { ok: true });
    assert.deepEqual(listSlots(), { ok: true, slots: ['x'] }, 'one slot, not two');
    assert.equal(loadSlot('x').slot.duration, 0.9, 'the overwrite took effect');
  });
});

test('slots: unavailable storage (private mode) reports { ok: false, reason } — no throw', () => {
  withStorage(undefined, () => {
    assert.deepEqual(listSlots(), { ok: false, reason: 'storage-unavailable' });
    assert.deepEqual(saveSlot('x', slotDrum()), { ok: false, reason: 'storage-unavailable' });
    assert.deepEqual(loadSlot('x'), { ok: false, reason: 'storage-unavailable' });
    assert.deepEqual(deleteSlot('x'), { ok: false, reason: 'storage-unavailable' });
  });
});

test('slots: a throwing localStorage (private-mode access) is guarded too', () => {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    get() { throw new Error('SecurityError: localStorage is not available'); },
    configurable: true,
  });
  try {
    assert.deepEqual(listSlots(), { ok: false, reason: 'storage-unavailable' });
    assert.deepEqual(saveSlot('x', slotDrum()), { ok: false, reason: 'storage-unavailable' });
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev);
    else delete globalThis.localStorage;
  }
});

test('slots: a full quota (setItem throws) is reported, not thrown', () => {
  const store = makeStorage();
  store.setItem = () => { throw new Error('QuotaExceededError'); };
  withStorage(store, () => {
    assert.deepEqual(saveSlot('x', slotDrum()), { ok: false, reason: 'storage-unavailable' });
    assert.deepEqual(listSlots(), { ok: true, slots: [] }, 'reads still work');
  });
});

test('slots: bad names throw descriptively (empty, path separators, too long)', () => {
  withStorage(makeStorage(), () => {
    assert.throws(() => saveSlot('', slotDrum()), /non-empty/);
    assert.throws(() => saveSlot('   ', slotDrum()), /non-empty/);
    assert.throws(() => saveSlot('a/b', slotDrum()), /path separator/);
    assert.throws(() => saveSlot('a\\b', slotDrum()), /path separator/);
    assert.throws(() => saveSlot('x'.repeat(SLOT_NAME_MAX + 1), slotDrum()), /the limit is 40/);
    // The boundary is legal, and load / delete validate their names too.
    assert.deepEqual(saveSlot('y'.repeat(SLOT_NAME_MAX), slotDrum()), { ok: true });
    assert.throws(() => loadSlot('a/b'), /path separator/);
    assert.throws(() => deleteSlot(''), /non-empty/);
  });
});

test('slots: saveSlot validates the drum argument', () => {
  withStorage(makeStorage(), () => {
    assert.throws(() => saveSlot('x', null), /drum/);
    assert.throws(() => saveSlot('x', { name: 'x' }), /drum/);
    assert.throws(() => saveSlot('x', { name: 'x', duration: 0, patch: {} }), /drum/);
    assert.throws(() => saveSlot('x', { name: 'x', duration: 0.5 }), /drum/);
  });
});

test('slots: corrupt stored JSON throws descriptively, naming the slot', () => {
  const store = makeStorage();
  withStorage(store, () => {
    store.setItem(SLOT_KEY, '{oops');
    assert.throws(() => loadSlot('kick'), (err) => {
      assert.match(err.message, /kick/, 'the throw names the slot');
      assert.match(err.message, /corrupt/, '... and the corruption');
      return true;
    });
    assert.throws(() => listSlots(), /corrupt/);
  });
});

test('slots: a non-map stored value is corrupt too (never a silent null)', () => {
  const store = makeStorage();
  withStorage(store, () => {
    store.setItem(SLOT_KEY, JSON.stringify(['a', 'b']));
    assert.throws(() => loadSlot('a'), /kick|corrupt|not an object map/);
    store.setItem(SLOT_KEY, 'null');
    assert.throws(() => loadSlot('a'), /not an object map/);
  });
});

test('slots: loadSlot of an unknown slot throws, naming the available ones', () => {
  withStorage(makeStorage(), () => {
    saveSlot('alpha', slotDrum());
    assert.throws(() => loadSlot('beta'), (err) => {
      assert.match(err.message, /beta/);
      assert.match(err.message, /alpha/);
      return true;
    });
  });
  // An EMPTY map says "none", not a silent null.
  withStorage(makeStorage(), () => {
    assert.throws(() => loadSlot('nope'), /slots: none\)/);
  });
});

test('slots: prototype-key names do not leak (own-property lookup, not slots[name])', () => {
  withStorage(makeStorage(), () => {
    // A slot literally named "constructor": stored as an own property,
    // loads back the real slot — not Object.prototype.constructor.
    saveSlot('constructor', slotDrum());
    const loaded = loadSlot('constructor');
    assert.equal(loaded.ok, true);
    assert.equal(loaded.slot.name, 'constructor');
    assert.ok(
      Array.isArray(loaded.slot.patch.layers) && loaded.slot.patch.layers.length > 0,
      'a real patch, not the inherited Function',
    );
    // An UNNAMED prototype key is an unknown slot (descriptive throw),
    // never the inherited property.
    assert.throws(() => loadSlot('toString'), /no saved slot named 'toString'/);
    assert.throws(() => deleteSlot('toString'), /no saved slot named 'toString'/);
  });
});

test('slots: deleteSlot drops the slot; unknown and bad names throw', () => {
  withStorage(makeStorage(), () => {
    saveSlot('a', slotDrum());
    saveSlot('b', slotDrum());
    assert.deepEqual(deleteSlot('a'), { ok: true });
    assert.deepEqual(listSlots(), { ok: true, slots: ['b'] });
    assert.throws(() => deleteSlot('a'), /no saved slot named 'a'/);
    assert.throws(() => deleteSlot('a/b'), /path separator/);
  });
});

test('presetOptions: registry entries, then the saved slots, in a stable order', () => {
  withStorage(makeStorage(), () => {
    const drum = slotDrum();
    // Save in NON-alphabetical order — the options must be stable
    // (sorted names), and one slot is named like a registry id.
    saveSlot('zeta', drum);
    saveSlot('alpha', drum);
    saveSlot('kick', drum);
    const options = presetOptions();
    assert.equal(options.length, PRESETS.length + 3);
    // The registry prefix, in registry order (the pure contract kept).
    for (let i = 0; i < PRESETS.length; i += 1)
      assert.deepEqual(
        options[i],
        { value: PRESETS[i].id, label: PRESETS[i].label },
        `registry option ${i} mirrors the registry`,
      );
    // Then the slots: sorted names, the "Saved: " label prefix, and
    // the "slot:" value namespace (a slot named "kick" does not
    // collide with the registry id "kick").
    assert.deepEqual(
      options.slice(PRESETS.length),
      [
        { value: 'slot:alpha', label: 'Saved: alpha' },
        { value: 'slot:kick', label: 'Saved: kick' },
        { value: 'slot:zeta', label: 'Saved: zeta' },
      ],
    );
    // Stable: a fresh call returns the same sequence (and fresh
    // objects — the picker must not hand out shared state).
    const again = presetOptions();
    assert.deepEqual(again, options);
    assert.notEqual(again, options);
    // The value helpers invert the namespace.
    assert.equal(slotOptionValue('alpha'), 'slot:alpha');
    assert.equal(slotNameFromValue('slot:alpha'), 'alpha');
    assert.equal(slotNameFromValue('kick'), null, 'a registry id is not a slot');
    assert.equal(slotNameFromValue(42), null);
  });
});

test('presetOptions: unavailable storage degrades to the registry only (no throw)', () => {
  withStorage(undefined, () => {
    assert.deepEqual(
      presetOptions(),
      PRESETS.map((p) => ({ value: p.id, label: p.label })),
    );
  });
});

test('presetOptions: corrupt stored data degrades to the registry only (no throw)', () => {
  const store = makeStorage();
  withStorage(store, () => {
    store.setItem(SLOT_KEY, '{oops');
    assert.deepEqual(
      presetOptions(),
      PRESETS.map((p) => ({ value: p.id, label: p.label })),
    );
  });
});

// ---- JSON export/import (P8/S20) ------------------------------------
//
// drumToJson / jsonToDrum are the drum's portable file form (pure —
// the Blob/file glue is main.js's I/O boundary): a FORMATTED JSON
// string of the plain { name, duration, patch } snapshot the saved
// slots store (S19), and back. The round-trip is the contract: a file
// this app exports is a file this app imports (both run the shared
// shape check), deep-equal, with fresh objects on the way out.

test('drumToJson: formatted { name, duration, patch }; app-tier extras excluded', () => {
  const drum = slotDrum();
  const text = drumToJson(drum);
  const parsed = JSON.parse(text);
  // Exactly the documented shape — and in a stable key order.
  assert.deepEqual(parsed, { name: 'kick', duration: 0.5, patch: drum.patch });
  assert.deepEqual(Object.keys(parsed), ['name', 'duration', 'patch']);
  // Formatted (2-space indent): the file is human-readable, not minified.
  assert.match(text, /\n  "name": "kick",\n/);
  assert.match(text, /\n  "duration": 0.5,\n/);
  // A live drum carries APP-TIER state (the mix-view Sets, P7/S17, the
  // color, the working source) — none of it is patch data, none of it
  // leaves the app through the export (field selection, not a dump).
  drum.color = '#fff';
  drum.disabledLayers = new Set([drum.patch.layers[0]]);
  drum.soloLayers = new Set();
  drum.workingSource = drum.patch.layers[0];
  const slim = JSON.parse(drumToJson(drum));
  assert.deepEqual(slim, { name: 'kick', duration: 0.5, patch: drum.patch });
});

test('drumToJson / jsonToDrum: round-trip (deep-equal, fresh objects, idempotent)', () => {
  const drum = slotDrum();
  const back = jsonToDrum(drumToJson(drum));
  // Deep-equal to the plain snapshot ... and a DIFFERENT object
  // (the fresh-clone contract — the caller gets an object it owns,
  // loadSlot's precedent).
  assert.deepEqual(back, { name: 'kick', duration: 0.5, patch: drum.patch });
  assert.notEqual(back, drum);
  assert.notEqual(back.patch, drum.patch);
  assert.notEqual(back.patch.layers[0], drum.patch.layers[0]);
  assert.notEqual(back.patch.layers[0].levelEnv, drum.patch.layers[0].levelEnv);
  // Mutating the loaded object cannot corrupt the live drum ...
  back.patch.layers[0].gain = 0.001;
  assert.notEqual(drum.patch.layers[0].gain, 0.001);
  // ... and re-exporting the loaded drum gives the SAME text (the
  // round-trip is idempotent — a file exports, imports, and re-exports
  // unchanged).
  assert.equal(drumToJson(jsonToDrum(drumToJson(drum))), drumToJson(drum));
});

test('jsonToDrum: a valid file with extra top-level keys imports the documented shape', () => {
  const drum = slotDrum();
  const text = JSON.stringify({
    name: drum.name,
    duration: drum.duration,
    patch: drum.patch,
    futureField: 42, // a newer app's field: ignored, not an error
  });
  const back = jsonToDrum(text);
  assert.deepEqual(Object.keys(back).sort(), ['duration', 'name', 'patch']);
  assert.deepEqual(back, { name: drum.name, duration: drum.duration, patch: drum.patch });
});

test('jsonToDrum: rejects each bad shape with a descriptive message', () => {
  const good = jsonToDrum(drumToJson(slotDrum()));
  const fail = (patch, re, message) =>
    assert.throws(() => jsonToDrum(JSON.stringify(patch)), re, message);
  // name: missing, empty, whitespace-only, or not a string.
  fail({ duration: 0.5, patch: good.patch }, /non-empty string name/, 'no name');
  fail({ ...good, name: '' }, /non-empty string name/, 'empty name');
  fail({ ...good, name: '   ' }, /non-empty string name/, 'whitespace-only name');
  fail({ ...good, name: 42 }, /non-empty string name/, 'non-string name');
  // duration: 0, negative, non-finite (NaN becomes null in JSON), or
  // not a number. (A RAW NaN literal in the text is not valid JSON —
  // the parse throw below, not this one.)
  fail({ ...good, duration: 0 }, /finite duration > 0/, 'zero duration');
  fail({ ...good, duration: -0.5 }, /finite duration > 0/, 'negative duration');
  fail({ ...good, duration: null }, /finite duration > 0/, 'null duration (JSON-stringified NaN)');
  fail({ ...good, duration: '0.5' }, /finite duration > 0/, 'string duration');
  // patch: missing, not an object, or missing its layers array.
  fail({ name: 'kick', duration: 0.5 }, /needs a patch object/, 'no patch');
  fail({ ...good, patch: 'nope' }, /needs a patch object/, 'non-object patch');
  fail({ name: 'kick', duration: 0.5, patch: {} }, /needs a layers array/, 'missing layers');
  fail({ ...good, patch: { layers: 'nope' } }, /needs a layers array/, 'non-array layers');
  // layers: empty, or a layer of an unknown type / not an object.
  fail({ ...good, patch: { layers: [] } }, /at least one layer/, 'empty layers');
  fail({ ...good, patch: { layers: [{ type: 'sine' }] } }, /unknown layer type/, 'unknown layer type');
  fail({ ...good, patch: { layers: [good.patch.layers[0], { type: 'bongos' }] } }, /layer 1.*bongos/, 'second layer named in the throw');
  fail({ ...good, patch: { layers: [null] } }, /unknown layer type/, 'null layer');
  fail({ ...good, patch: { layers: [good.patch.layers[0], {}] } }, /layer 1/, 'typeless layer');
  // non-object roots: string, number, null, array, boolean.
  for (const [root, what] of [['"hello"', 'string'], ['42', 'number'], ['null', 'null'], ['[]', 'array'], ['true', 'boolean']])
    assert.throws(() => jsonToDrum(root), /root must be a plain object/, `non-object root (${what})`);
  // invalid JSON text (incl. a NaN literal — JSON.parse rejects it).
  assert.throws(() => jsonToDrum('{oops'), /not valid JSON/);
  assert.throws(
    () => jsonToDrum('{"name":"k","duration":NaN,"patch":{"layers":[]}}'),
    /not valid JSON/, 'a NaN duration literal is not valid JSON',
  );
});

test('drumToJson: validates too — a file exported is a file imported (loud on a malformed live drum)', () => {
  const drum = slotDrum();
  assert.throws(() => drumToJson({ ...drum, name: '' }), /non-empty string name/);
  assert.throws(() => drumToJson({ ...drum, duration: 0 }), /finite duration > 0/);
  assert.throws(() => drumToJson({ ...drum, patch: { layers: [] } }), /at least one layer/);
  // A good drum still exports (the guard does not false-positive).
  assert.ok(drumToJson(drum).length > 0);
});

// ---- legacy envelope adoption on import/load (plan "dahdsr" P3/S3) ----
//
// Patches entering the app (the JSON import path — jsonToDrum — and
// the named save-slot load path — loadSlot) are adopted through
// normalizePatchEnvelopes (P3/S1): a non-canonical envelope shape (the
// pre-canonical 4-point knee level env, the old free-form pitch /
// FM-depth point arrays) is LEGAL input — silently migrated to the
// canonical DAHDSR form, never an error — and clone-first, so the
// imported object is never mutated in place. An already-canonical
// file/slot passes through byte-identical (the round-trip property:
// export -> import is stable).

// A drum in the PRE-canonical shapes the old app stored: the legacy
// 4-point knee level env (the pre-P2 levelEnvelope constructor
// verbatim — the kick body's attack 5 ms / decay 300 ms values), a
// free-form 3-point pitch env, and a 3-point FM-depth env (the old
// band/card free-form editing could store either). The exact knee is
// EXACTLY representable in the canonical form (the mid-knee becomes
// the sustain point, both legs stay linear — the fit is lossless for
// this shape; test/dahdsr.test.mjs pins it), so the adopted level env
// is sample-identical to the knee.
const legacyKickDrum = () => ({
  name: 'kick',
  duration: 0.5,
  patch: {
    layers: [
      {
        type: 'fm',
        carrier: { freq: 50 },
        modulators: [
          {
            freq: 200,
            index: 8,
            // A 3-point legacy FM-depth env (the old free-form edit).
            indexEnv: [{ t: 0, v: 8 }, { t: 0.01, v: 3 }, { t: 0.02, v: 0 }],
          },
        ],
        gain: 0.8,
        // A 3-point legacy pitch env (the old free-form edit).
        pitchEnv: [{ t: 0, v: 100 }, { t: 0.015, v: 60 }, { t: 0.03, v: 50 }],
        // The legacy 4-point knee level env (pre-P2 constructor).
        levelEnv: [
          { t: 0, v: 0 },
          { t: 0.005, v: 1 },
          { t: 0.155, v: 0.25 },
          { t: 0.305, v: 0 },
        ],
      },
    ],
    masterEffects: [],
  },
});

test('jsonToDrum: a legacy envelope shape is adopted to canonical form (silently, clone-first)', () => {
  const legacy = legacyKickDrum();
  const snapshot = structuredClone(legacy);
  const adopted = jsonToDrum(JSON.stringify(legacy));
  // SILENT: legacy data is legal input — the import succeeds (no
  // throw, no error note) even though the shapes are non-canonical.
  const layer = adopted.patch.layers[0];
  // Every level env is the canonical 6-point DAHDSR form: the exact
  // knee lands on its EXACT canonical form (the mid-knee becomes the
  // sustain point — sustain 0.25, both legs linear, no curves).
  assert.ok(isCanonicalLevel(layer.levelEnv), 'the level env is canonical');
  assert.deepEqual(
    layer.levelEnv,
    [
      { t: 0, v: 0 },
      { t: 0, v: 0 },
      { t: 0.005, v: 1 },
      { t: 0.005, v: 1 },
      { t: 0.155, v: 0.25 },
      { t: 0.305, v: 0 },
    ],
    'the exact knee lands on its exact canonical form (bit-exact times)',
  );
  assert.deepEqual(pointsToDahdsr(layer.levelEnv), {
    delay: 0, attack: 0.005, hold: 0, decay: 0.15, sustain: 0.25,
    release: 0.15, attackCurve: 0, decayCurve: 0, releaseCurve: 0,
  }, '... and the DAHDSR scalars read the fitted spans');
  // Every pitch / FM-depth env is the canonical 2-point form: the
  // multi-point legacy snaps endpoint-faithfully.
  assert.deepEqual(
    layer.pitchEnv,
    [{ t: 0, v: 100 }, { t: 0.03, v: 50 }],
    'the 3-point pitch env snaps to its endpoints',
  );
  assert.deepEqual(
    layer.modulators[0].indexEnv,
    [{ t: 0, v: 8 }, { t: 0.02, v: 0 }],
    '... and the 3-point FM-depth env too',
  );
  // CLONE-FIRST: the input object is never mutated in place ... the
  // adopted patch is a fresh object whose envelope arrays are not the
  // input's ...
  assert.deepEqual(legacy, snapshot, 'the input object is untouched');
  assert.notEqual(adopted.patch, legacy.patch);
  assert.notEqual(adopted.patch.layers[0].levelEnv, legacy.patch.layers[0].levelEnv);
  // ... and the non-envelope data carries through unchanged.
  assert.equal(adopted.name, 'kick', 'the drum name');
  assert.equal(adopted.duration, 0.5, 'the duration');
  assert.equal(adopted.patch.layers[0].gain, 0.8, 'the layer gain');
  assert.equal(adopted.patch.layers[0].carrier.freq, 50, 'the carrier');
});

test('jsonToDrum: a canonical import passes through byte-identical (export -> import is stable)', () => {
  // The snare is the multi-layer canonical case (three layers: 6-point
  // level envs, 2-point pitch envs, 2-point FM-depth envs): the
  // adoption must be a NO-OP in value — the imported patch deep-equals
  // the exported one, and re-exporting the imported drum gives the
  // IDENTICAL text (the round-trip property, now through the
  // normalization path).
  const drum = { name: 'snare', duration: 0.5, patch: presetById('snare').build() };
  const text = drumToJson(drum);
  const adopted = jsonToDrum(text);
  assert.deepEqual(adopted, drum, 'the canonical patch passes through unchanged');
  assert.equal(drumToJson(adopted), text, '... and re-exports to the identical text');
  for (const layer of adopted.patch.layers) {
    if (Array.isArray(layer.levelEnv))
      assert.ok(isCanonicalLevel(layer.levelEnv), 'every level env is still canonical');
    if (Array.isArray(layer.pitchEnv))
      assert.equal(layer.pitchEnv.length, 2, 'every pitch env is the 2-point form');
    for (const mod of layer.modulators ?? [])
      if (Array.isArray(mod.indexEnv))
        assert.equal(mod.indexEnv.length, 2, 'every FM-depth env is the 2-point form');
  }
});

test('slots: a legacy stored snapshot is adopted to canonical form on load (save preserves, load normalizes)', () => {
  withStorage(makeStorage(), () => {
    const legacy = legacyKickDrum();
    assert.deepEqual(saveSlot('legacy', legacy), { ok: true });
    // The STORED data is preserved as-is — the snapshot keeps the
    // legacy shape (normalization is on the load side only, so a slot
    // saved by the old app is not rewritten on disk).
    const storedRaw = JSON.parse(globalThis.localStorage.getItem(SLOT_KEY));
    assert.equal(storedRaw.legacy.patch.layers[0].levelEnv.length, 4, 'the stored slot keeps the legacy 4-point shape');
    assert.equal(storedRaw.legacy.patch.layers[0].pitchEnv.length, 3, '... and the legacy 3-point pitch env');
    // The LOAD adopts it: canonical 6-point level env, 2-point pitch /
    // FM-depth snaps — silently (the load succeeds, no error).
    const loaded = loadSlot('legacy');
    assert.equal(loaded.ok, true, 'the load succeeds on legacy data');
    const layer = loaded.slot.patch.layers[0];
    assert.ok(isCanonicalLevel(layer.levelEnv), 'the loaded level env is canonical');
    assert.deepEqual(layer.levelEnv, [
      { t: 0, v: 0 },
      { t: 0, v: 0 },
      { t: 0.005, v: 1 },
      { t: 0.005, v: 1 },
      { t: 0.155, v: 0.25 },
      { t: 0.305, v: 0 },
    ], '... on the exact canonical form');
    assert.deepEqual(layer.pitchEnv, [{ t: 0, v: 100 }, { t: 0.03, v: 50 }]);
    assert.deepEqual(layer.modulators[0].indexEnv, [{ t: 0, v: 8 }, { t: 0.02, v: 0 }]);
    // CLONE-FIRST: the load does not mutate the stored slot — a second
    // load re-derives the same canonical form from the STILL-legacy
    // stored data.
    const storedAfter = JSON.parse(globalThis.localStorage.getItem(SLOT_KEY));
    assert.equal(storedAfter.legacy.patch.layers[0].levelEnv.length, 4, 'the stored copy is still legacy after the load');
    assert.deepEqual(loadSlot('legacy').slot.patch, loaded.slot.patch, 'a second load re-derives the same canonical form');
    assert.notEqual(loaded.slot.patch, legacy.patch, 'the loaded patch is a fresh clone (no aliasing the input)');
  });
});

test('jsonToDrum: the adopted legacy patch renders like its normalization (properties)', () => {
  const legacy = legacyKickDrum();
  const adopted = jsonToDrum(JSON.stringify(legacy));
  const hit = renderPatch(adopted.patch, { sampleRate: 8000, duration: 0.5 });
  assert.equal(hit.length, 4000, 'the render length follows the import');
  // Non-silent (GUIDELINES §4: properties, not full-buffer equality)...
  assert.ok(maxAbs(hit) > 0.01, `the adopted patch renders non-silently (maxAbs ${maxAbs(hit).toFixed(5)})`);
  // ... and decays: the late window carries less energy than the attack.
  const energy = (from, to) => {
    let e = 0;
    for (let i = Math.floor(from * 8000); i < Math.floor(to * 8000); i++) e += hit[i] * hit[i];
    return e;
  };
  assert.ok(energy(0.4, 0.5) < energy(0, 0.1), 'the hit decays (late-window energy < attack energy)');
  // The normalization expectation: the exact knee's adoption is
  // lossless, so the adopted level env is SAMPLE-IDENTICAL to the
  // legacy knee everywhere (the render carries the same envelope, not
  // just a close one).
  const legacyEnv = legacy.patch.layers[0].levelEnv;
  const adoptedEnv = adopted.patch.layers[0].levelEnv;
  let maxDiff = 0;
  for (let i = 0; i <= 4096; i++) {
    const t = (i * 0.5) / 4096;
    maxDiff = Math.max(maxDiff, Math.abs(envelopeValue(adoptedEnv, t) - envelopeValue(legacyEnv, t)));
  }
  assert.equal(maxDiff, 0, 'the adopted level env is sample-identical to the legacy knee');
});
