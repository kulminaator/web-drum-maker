// Tests for src/app/master-panel.js (plan newui P6/S16 + P7/S17-S18) —
// the right-hand master panel: the hit-length fader (0.1…2 s, the
// linear control kept where linearity is the point — new-ui.md
// §2.3), the output-level knob (0…1 — the Web-Audio playback-only
// gain; the GAIN NODE itself is exercised in the P8 playhead/loop
// harness where the AudioContext stub exists), the per-source fader
// strip (P7/S17 — one level/enable/solo row per source, labeled by
// the stable identity from the same registry as the card row; the
// faders twin the cards' gain knobs, the E / S buttons drive the
// drum's app-tier mix-view state, and P7/S18 adds the row's ▶
// audition button — the new-ui.md §7 L-row double-as-solo-trigger:
// its click fires onSourcePlay with the row's identity label, and
// main.js plays that one source alone with the band playhead under
// it), and the master effect chain — the
// cards.js shared fx slot UI (P6/S15) on the 'masterEffects' base
// path, with the add/remove flow (patch-ops.js's addFx / removeFx)
// touching the master chain only, never the card chains.
//
// Same headless DOM-stub technique as test/knob.test.mjs and
// test/cards.test.mjs: a minimal document.createElement stand-in
// records what the builder writes (classes, attributes, text,
// children) and which event listeners it registers; events are fired
// by invoking the recorded handlers with a synthetic event object.
// No browser, no layout — the code under the stub is the REAL
// src/app/master-panel.js (and, through it, cards.js's buildFxSlots).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFaderStrip, buildMasterPanel } from '../src/app/master-panel.js';
import { descriptorRead, FX_TYPE_LABELS } from '../src/app/controls.js';
import { presetById } from '../src/app/presets.js';
import { addFx, removeFx, removeLayer } from '../src/app/patch-ops.js';
import { buildFmCard } from '../src/app/cards.js';
import { getPath, snarePatch } from '../src/lib/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- headless DOM stub (the test/knob.test.mjs technique) -----------

// A RECORDING style object (plan "colors" S8, the test/knob.test.mjs
// twin): direct property assignments land as own properties, and
// setProperty/getPropertyValue capture the custom properties the
// builders set (the knob's --deg, the fader's --fill).
const makeStubStyle = () => {
  const custom = Object.create(null);
  return {
    setProperty(name, value) { custom[name] = String(value); },
    getPropertyValue(name) { return custom[name] ?? ''; },
  };
};

// A minimal element stub: attributes, children, style, listeners, and
// the plain properties the builders assign (value, textContent,
// className, type, disabled).
const makeStubEl = (tagName) => {
  const el = {
    tagName,
    className: '',
    textContent: '',
    style: makeStubStyle(),
    children: [],
    attributes: Object.create(null),
    listeners: Object.create(null),
    setAttribute(name, value) {
      el.attributes[name] = String(value);
    },
    getAttribute(name) {
      return el.attributes[name] ?? null;
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    append(...children) {
      el.children.push(...children);
    },
    // Replace the whole child list (the fx section's rebuild uses it —
    // the only child-removal primitive the stub provides).
    replaceChildren(...children) {
      el.children.length = 0;
      el.children.push(...children);
    },
    addEventListener(type, handler) {
      (el.listeners[type] ??= []).push(handler);
    },
    // One MEMOIZED recording 2D context per element (the cards.test.mjs
    // twin, reduced — the master-panel tests never read the paint
    // records): the per-card envelope editor is OPEN at build, so its
    // first paint must not crash on a missing context.
    getContext() {
      el.context ??= (() => {
        const g = { calls: [] };
        for (const m of [
          'clearRect', 'fillRect', 'fillText', 'stroke', 'fill', 'beginPath',
          'closePath', 'moveTo', 'lineTo', 'arc', 'save', 'restore', 'translate',
        ])
          g[m] = (...args) => {
            g.calls.push([m, ...args]);
            for (const a of args)
              if (typeof a === 'number' && !Number.isFinite(a))
                throw new Error(`non-finite coordinate in ${m}: ${args}`);
          };
        g.measureText = (t) => ({ width: 30, text: t });
        g.createLinearGradient = (x0, y0, x1, y1) => {
          g.calls.push(['createLinearGradient', x0, y0, x1, y1]);
          const grad = { __gradient: [x0, y0, x1, y1], stops: [] };
          grad.addColorStop = (offset, color) => grad.stops.push([offset, color]);
          return grad;
        };
        return g;
      })();
      return el.context;
    },
  };
  return el;
};

globalThis.document = { createElement: makeStubEl };

// Fire a synthetic event at the listeners an element registered for
// `type`; the event carries a preventDefault recorder the handlers may
// call.
const fire = (el, type, props = {}) => {
  const event = {
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...props,
  };
  for (const handler of el.listeners[type] ?? []) handler(event);
  return event;
};

// Depth-first find of the first stub element with exactly this class.
const byClass = (root, cls) => {
  const stack = [...root.children];
  while (stack.length > 0) {
    const el = stack.pop();
    if (el.className === cls) return el;
    stack.push(...el.children);
  }
  return null;
};

// Every stub element (depth-first) with exactly this class, in tree
// order.
const byClassAll = (root, cls) => {
  const out = [];
  const walk = (el) => {
    for (const child of el.children) {
      if (child.className === cls) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
};

// ---- test fixtures ----------------------------------------------------

// A live snare drum (the plan's reference: its master chain carries a
// compressor) — the shape main.js's drum list entries have.
const makeSnareDrum = () => ({
  name: 'snare',
  duration: 0.5,
  patch: snarePatch(),
});

// A blank drum: one FM layer, an EMPTY master chain (the "no fx" case)
// — the registry's blank preset (its build is the private blankPatch).
const makeBlankDrum = () => {
  const preset = presetById('blank');
  return { name: 'blank', duration: preset.duration, patch: preset.build() };
};

const makePanel = (overrides = {}) => {
  const drum = makeSnareDrum();
  const edits = [];
  const durations = [];
  const levels = [];
  const fxAdds = [];
  const fxRemoves = [];
  const enableToggles = [];
  const soloToggles = [];
  const sourcePlays = [];
  const panel = buildMasterPanel({
    drum,
    outputLevel: 0.8,
    onPatchEdit: (d) => edits.push(d),
    onDurationChange: (d, s) => durations.push([d, s]),
    onOutputLevel: (v) => levels.push(v),
    onFxAdd: (d, t) => fxAdds.push([d, t]),
    onFxRemove: (d, j) => fxRemoves.push([d, j]),
    onEnableToggle: (d, i) => enableToggles.push([d, i]),
    onSoloToggle: (d, i) => soloToggles.push([d, i]),
    onSourcePlay: (d, i, label) => sourcePlays.push([d, i, label]),
    ...overrides,
  });
  return {
    panel, drum, edits, durations, levels, fxAdds, fxRemoves,
    enableToggles, soloToggles, sourcePlays,
  };
};

// Panel part finders. The length fader and the output knob are DIRECT
// children of the panel (the fx slots' parameter knobs are nested
// inside .master-fx, so a whole-tree search would be ambiguous — the
// byClass stack helper walks in reverse child order); the type group's
// className carries two classes when hidden ('fx-types hidden'), so it
// is matched by prefix.
const titleOf = (panel) => byClass(panel, 'master-title');
const lengthFaderOf = (panel) => panel.children.find((c) => c.className === 'fader');
const outputKnobOf = (panel) => panel.children.find((c) => c.className === 'knob');
const stripOf = (panel) => byClass(panel, 'level-strip');
const fxSectionOf = (panel) => byClass(panel, 'master-fx');
const fxSlotsOf = (panel) => byClassAll(panel, 'fx-slot');
const fxAddOf = (panel) => byClass(panel, 'fx-add');
const fxTypesOf = (panel) => byClassAll(panel, 'fx-types')[0]
  ?? byClassAll(panel, 'fx-types hidden')[0] ?? null;
const fxTypeButtonsOf = (panel) =>
  fxTypesOf(panel).children[0].children.filter((c) => c.tagName === 'button');
const slotBadgeOf = (slot) => slot.children.find((c) => c.className === 'fx-badge');
const slotRemoveOf = (slot) => slot.children.find((c) => c.className === 'fx-remove');
const slotKnobsOf = (slot) => slot.children.filter((c) => c.className === 'knob');
const rotorOf = (knob) => byClass(knob, 'knob-rotor');
const faderInputOf = (fader) => byClass(fader, 'fader-input');

// Mirror main.js's master fx wiring (the patch-ops.js op + the panel's
// fx section rebuild — main.js's re-key has no counterpart here: the
// master chain touches no layer objects, and the panel re-reads the
// fresh patch on the rebuild).
const applyFxAdd = (drum, panel, type) => {
  drum.patch = addFx(drum.patch, 'masterEffects', type);
  panel.rebuildFxSection();
};
const applyFxRemove = (drum, panel, slotIndex) => {
  drum.patch = removeFx(drum.patch, 'masterEffects', slotIndex);
  panel.rebuildFxSection();
};

// ---- panel layout ------------------------------------------------------

test('master panel: renders the column — MASTER heading, length fader, output knob, strip container, fx section', () => {
  const { panel } = makePanel();
  assert.equal(panel.className, 'master-inner', 'a column wrapper');
  assert.deepEqual(
    panel.children.map((c) => c.className),
    ['master-title', 'fader', 'knob', 'level-strip', 'master-fx'],
    'heading, length, output level, strip container (P7), master fx — in order',
  );
  assert.equal(titleOf(panel).textContent, 'MASTER');
  assert.equal(
    stripOf(panel).children.length, 0,
    'the strip is EMPTY at build — main.js\'s rebuildCardRow fills it via rebuildStrip (P7)',
  );
});

test('master panel: the length fader is the linear 0.1…2 s control, value = drum.duration', () => {
  const { panel, drum } = makePanel();
  const input = faderInputOf(lengthFaderOf(panel));
  assert.equal(input.type, 'range', 'a native range input');
  assert.equal(input.getAttribute('min'), '0.1', 'the plan\'s 0.1 s floor');
  assert.equal(input.getAttribute('max'), '2', 'the plan\'s 2 s ceiling');
  assert.equal(input.getAttribute('step'), '0.01', '... on a 10 ms grid');
  assert.equal(input.getAttribute('aria-valuemin'), '0.1');
  assert.equal(input.getAttribute('aria-valuemax'), '2');
  assert.equal(input.value, '0.5', 'the drum\'s duration');
  assert.equal(input.getAttribute('aria-valuenow'), '0.5');
  assert.equal(input.getAttribute('aria-valuetext'), '0.5', 'no unit (the label does not mention Hz)');
  assert.equal(byClass(lengthFaderOf(panel), 'fader-label').textContent, 'length');
  assert.equal(drum.duration, 0.5, 'fixture sanity: the fader read the live value');
});

test('master panel: the output-level knob is 0…1, value from the passed outputLevel', () => {
  const { panel } = makePanel(); // outputLevel 0.8
  const rotor = rotorOf(outputKnobOf(panel));
  assert.equal(rotor.getAttribute('aria-valuemin'), '0');
  assert.equal(rotor.getAttribute('aria-valuemax'), '1');
  assert.equal(rotor.getAttribute('aria-valuenow'), '0.8', 'the mix level passed in');
  assert.equal(rotor.getAttribute('aria-valuetext'), '0.8', 'a bare number (format null — no descriptor)');
  assert.equal(byClass(outputKnobOf(panel), 'knob-label').textContent, 'output level');
  assert.equal(outputKnobOf(panel).value, 0.8, 'the element API carries the number');
});

test('master panel: a different drum\'s duration and output level are reflected (per-drum bind, global level)', () => {
  const { panel } = makePanel({
    drum: { ...makeBlankDrum(), name: 'hihat', duration: 0.3 },
    outputLevel: 1,
  });
  assert.equal(faderInputOf(lengthFaderOf(panel)).value, '0.3', 'the hihat\'s 0.3 s duration');
  assert.equal(
    rotorOf(outputKnobOf(panel)).getAttribute('aria-valuenow'),
    '1',
    'the global mix level',
  );
});

// ---- length fader --------------------------------------------------------

test('master panel: a length fader input calls onDurationChange(drum, seconds) with the parsed value', () => {
  const { panel, drum, durations } = makePanel();
  fire(faderInputOf(lengthFaderOf(panel)), 'input', { target: { value: '0.75' } });
  assert.deepEqual(durations, [[drum, 0.75]], 'the drum and the parsed seconds');
  assert.equal(lengthFaderOf(panel).value, 0.75, 'the fader\'s element API moved');
  assert.equal(
    faderInputOf(lengthFaderOf(panel)).getAttribute('aria-valuenow'),
    '0.75',
    '... and the readout',
  );
});

test('master panel: an off-grid length is snapped to the 10 ms grid before the funnel', () => {
  const { panel, drum, durations } = makePanel();
  fire(faderInputOf(lengthFaderOf(panel)), 'input', { target: { value: '0.753' } });
  assert.deepEqual(durations, [[drum, 0.75]], '0.753 -> 0.75 (the step grid)');
});

test('master panel: a length past the range clamps to 2 s (and the floor to 0.1 s)', () => {
  const { panel, drum, durations } = makePanel();
  fire(faderInputOf(lengthFaderOf(panel)), 'input', { target: { value: '5' } });
  assert.deepEqual(durations, [[drum, 2]], 'clamped to the ceiling');
  fire(faderInputOf(lengthFaderOf(panel)), 'input', { target: { value: '0.01' } });
  assert.deepEqual(durations, [[drum, 2], [drum, 0.1]], 'clamped to the floor');
});

test('master panel: re-setting the same length is a no-op (the sync-pass loop safety)', () => {
  const { panel, drum, durations } = makePanel();
  fire(faderInputOf(lengthFaderOf(panel)), 'input', { target: { value: '0.75' } });
  lengthFaderOf(panel).setValue(0.75); // e.g. a future readout-sync pass
  assert.deepEqual(durations, [[drum, 0.75]], 'setValue with the held value does not re-fire');
  lengthFaderOf(panel).setValue(1);
  assert.deepEqual(durations, [[drum, 0.75], [drum, 1]], '... a real move does');
});

// ---- output level knob ----------------------------------------------------

test('master panel: an output knob input calls onOutputLevel with the new value', () => {
  const { panel, levels } = makePanel(); // outputLevel 0.8, step 0.01
  fire(rotorOf(outputKnobOf(panel)), 'keydown', { key: 'ArrowUp' });
  assert.deepEqual(levels, [0.81], 'one step up');
  fire(rotorOf(outputKnobOf(panel)), 'keydown', { key: 'PageUp' });
  assert.deepEqual(levels, [0.81, 0.91], 'the x10 big step');
  fire(rotorOf(outputKnobOf(panel)), 'keydown', { key: 'End' });
  assert.deepEqual(levels, [0.81, 0.91, 1], 'Home/End jump to the range ends');
  fire(rotorOf(outputKnobOf(panel)), 'keydown', { key: 'ArrowUp' });
  assert.equal(levels.length, 3, 'past max: clamped, no fire (the commit no-op)');
  fire(rotorOf(outputKnobOf(panel)), 'keydown', { key: 'Home' });
  assert.deepEqual(levels, [0.81, 0.91, 1, 0], '... and Home to 0');
});

// ---- master fx chain -------------------------------------------------------

test('master fx: one slot per masterEffects entry — the snare\'s compressor with threshold/ratio/makeup knobs', () => {
  const { panel, drum } = makePanel();
  assert.equal(fxSlotsOf(panel).length, 1, 'exactly one slot for the one compressor');
  const slot = fxSlotsOf(panel)[0];
  assert.equal(slotBadgeOf(slot).textContent, FX_TYPE_LABELS.compress, 'the reused FX_TYPE_LABELS badge');
  const knobs = slotKnobsOf(slot);
  assert.equal(knobs.length, 3, 'threshold / ratio / makeup — the fields the patch carries');
  const rotors = knobs.map(rotorOf);
  assert.deepEqual(
    rotors.map((r) => r.getAttribute('aria-label')),
    [
      'Master: Compressor 1 threshold',
      'Master: Compressor 1 ratio',
      'Master: Compressor 1 makeup',
    ],
    'the describeFxList labels on the master base path (the "Master" prefix)',
  );
  assert.deepEqual(
    rotors.map((r) => r.getAttribute('aria-valuenow')),
    ['0.3', '3', '1.2'],
    'the live patch values',
  );
  const remove = slotRemoveOf(slot);
  assert.equal(remove.textContent, '✕');
  assert.equal(remove.disabled, false, 'the chain may empty');
  assert.ok(remove.listeners['click'], '... and carries a handler');
  assert.equal(byClass(fxSectionOf(panel), 'fx-empty'), null, 'no hint for a non-empty chain');
  assert.equal(byClass(panel, 'fx-cap'), null, 'no cap note below the limit');
  assert.ok(drum, 'fixture sanity');
});

test('master fx: [+ fx] toggles the type group (hidden at build; four types, no active one)', () => {
  const { panel } = makePanel();
  const add = fxAddOf(panel);
  const types = fxTypesOf(panel);
  assert.equal(types.className, 'fx-types hidden', 'hidden at build');
  const buttons = fxTypeButtonsOf(panel);
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    Object.values(FX_TYPE_LABELS),
    'saturate / highpass / resonate / compress, the reused labels',
  );
  assert.ok(
    buttons.every((b) => b.getAttribute('aria-pressed') !== 'true'),
    'no type is active at build (value null — the group never throws)',
  );
  const event = fire(add, 'click');
  assert.ok(event.stopped, 'nothing behind the panel may follow the click');
  assert.equal(types.className, 'fx-types', 'the first click reveals the group');
  fire(add, 'click');
  assert.equal(types.className, 'fx-types hidden', '... and the next hides it again');
});

test('master fx: picking a type fires onFxAdd(drum, type), and the op + rebuild add the slot on masterEffects', () => {
  const { panel, drum, fxAdds } = makePanel();
  fire(fxAddOf(panel), 'click'); // reveal the type group
  const buttons = fxTypeButtonsOf(panel);
  fire(buttons.find((b) => b.textContent === FX_TYPE_LABELS.saturate), 'click');
  assert.deepEqual(fxAdds, [[drum, 'saturate']], 'onFxAdd got the drum and the clicked type (no path — always masterEffects)');
  applyFxAdd(drum, panel, 'saturate'); // main.js\'s wiring, mirrored
  // Two slots, in ARRAY order (the slot order is the chain order):
  assert.deepEqual(
    fxSlotsOf(panel).map((s) => slotBadgeOf(s).textContent),
    [FX_TYPE_LABELS.compress, FX_TYPE_LABELS.saturate],
  );
  // The patch holds 2 effects in order; the new one is the op default.
  assert.deepEqual(
    drum.patch.masterEffects.map((f) => f.type),
    ['compress', 'saturate'],
    'the add appends — the order is the array order (no reordering)',
  );
  assert.deepEqual(drum.patch.masterEffects[1], { type: 'saturate', drive: 2 });
  // The second slot carries the drive knob at the right path.
  const slot2 = fxSlotsOf(panel)[1];
  const driveKnob = slotKnobsOf(slot2)[0];
  assert.equal(rotorOf(driveKnob).getAttribute('aria-label'), 'Master: Saturator 2 drive');
  assert.equal(rotorOf(driveKnob).getAttribute('aria-valuemin'), '1');
  assert.equal(rotorOf(driveKnob).getAttribute('aria-valuemax'), '10');
  assert.equal(rotorOf(driveKnob).getAttribute('aria-valuenow'), '2', 'the op default');
});

test('master fx: a slot knob live-binds to the master chain path (setPath + onPatchEdit)', () => {
  const { panel, drum, edits } = makePanel();
  const ratioKnob = slotKnobsOf(fxSlotsOf(panel)[0])[1];
  fire(rotorOf(ratioKnob), 'keydown', { key: 'ArrowUp' }); // 3 -> 3.5 (step 0.5)
  assert.equal(drum.patch.masterEffects[0].ratio, 3.5, 'the edit landed on the MASTER chain path');
  assert.equal(edits.length, 1, 'one onPatchEdit per knob move');
  assert.equal(edits[0], drum, 'onPatchEdit receives the drum');
});

test('master fx: the slot [✕] fires onFxRemove(drum, slotIndex), and the op + rebuild drop the slot', () => {
  const { panel, drum, fxRemoves } = makePanel();
  applyFxAdd(drum, panel, 'saturate'); // two slots first
  assert.equal(fxSlotsOf(panel).length, 2);
  const event = fire(slotRemoveOf(fxSlotsOf(panel)[0]), 'click'); // the COMPRESSOR
  assert.ok(event.stopped, 'nothing behind the panel may follow the click');
  assert.deepEqual(fxRemoves, [[drum, 0]], 'onFxRemove got the drum and the SLOT index');
  applyFxRemove(drum, panel, 0);
  assert.deepEqual(
    drum.patch.masterEffects.map((f) => f.type),
    ['saturate'],
    'the patch has 1 effect left',
  );
  const slots = fxSlotsOf(panel);
  assert.equal(slots.length, 1, '... and the UI shows it');
  assert.equal(slotBadgeOf(slots[0]).textContent, FX_TYPE_LABELS.saturate);
  // The survivor re-indexed to slot 1: its knob path re-derives.
  assert.equal(
    rotorOf(slotKnobsOf(slots[0])[0]).getAttribute('aria-label'),
    'Master: Saturator 1 drive',
  );
  assert.equal(
    rotorOf(slotKnobsOf(slots[0])[0]).getAttribute('aria-valuenow'),
    '2',
    '... with its value intact (the op default)',
  );
});

test('master fx: removing the LAST slot empties the chain — the "no fx" hint returns and [+ fx] re-enables', () => {
  const { panel, drum, fxRemoves } = makePanel();
  fire(slotRemoveOf(fxSlotsOf(panel)[0]), 'click');
  assert.deepEqual(fxRemoves, [[drum, 0]]);
  applyFxRemove(drum, panel, 0); // removal is allowed down to EMPTY
  assert.deepEqual(drum.patch.masterEffects, []);
  assert.equal(fxSlotsOf(panel).length, 0);
  assert.equal(
    byClass(fxSectionOf(panel), 'fx-empty').textContent,
    'no fx',
    'the muted hint is back',
  );
  const add = fxAddOf(panel);
  assert.equal(add.disabled, false, '[+ fx] is enabled again');
  assert.ok(add.listeners['click'], '... and carries a handler');
});

test('master fx: an empty master chain shows the "no fx" hint + the enabled [+ fx] (the blank drum)', () => {
  const { panel, drum } = makePanel({ drum: makeBlankDrum() });
  assert.equal(fxSlotsOf(panel).length, 0, 'no slots for the empty chain');
  assert.equal(
    byClass(fxSectionOf(panel), 'fx-empty').textContent,
    'no fx',
    'the muted hint',
  );
  assert.equal(fxAddOf(panel).disabled, false, '[+ fx] is enabled');
  assert.ok(drum, 'fixture sanity');
});

test('master fx: at the 4-slot cap [+ fx] is disabled with an inline note (a synthetic click is a no-op)', () => {
  const { panel, fxAdds } = makePanel({
    drum: {
      name: 'maxed',
      duration: 0.5,
      patch: {
        layers: [{ type: 'fm', carrier: { freq: 220 }, modulators: [], gain: 0.5 }],
        masterEffects: [
          { type: 'saturate', drive: 2 },
          { type: 'highpass', cutoff: 2000 },
          { type: 'resonate', freq: 300, q: 5 },
          { type: 'compress', threshold: 0.3, ratio: 3, makeup: 1.2 },
        ],
      },
    },
  });
  assert.equal(fxSlotsOf(panel).length, 4, 'one slot per chain entry');
  const add = fxAddOf(panel);
  assert.equal(add.disabled, true, '[+ fx] is disabled at the cap (the shared MAX_FX_SLOTS)');
  assert.equal(add.listeners['click'], undefined, '... and carries no handler');
  assert.equal(byClass(panel, 'fx-cap').textContent, '4 fx max', 'the inline note');
  fire(add, 'click'); // a synthetic click at the disabled button
  assert.equal(fxAdds.length, 0, '... is a no-op (the op\'s throw is unreachable from the UI)');
  // Every slot keeps its [✕] (removal is allowed down to empty).
  assert.ok(
    fxSlotsOf(panel).every((s) => slotRemoveOf(s).listeners['click']),
  );
});

test('master fx: card chains are untouched by master ops (the basePath separation)', () => {
  const { panel, drum } = makePanel();
  const masterBefore = drum.patch.masterEffects;
  const layerChains = drum.patch.layers.map((l) => l.effects);
  assert.equal(masterBefore.length, 1, 'fixture: the snare master carries a compressor');
  applyFxAdd(drum, panel, 'saturate');
  assert.notEqual(
    drum.patch.masterEffects,
    masterBefore,
    'add: the master chain is a FRESH array (the op edited it)',
  );
  assert.equal(
    drum.patch.masterEffects[0],
    masterBefore[0],
    '... but the surviving compressor is the SAME object (clone-first carry-over)',
  );
  drum.patch.layers.forEach((l, i) =>
    assert.equal(l.effects, layerChains[i], `add: layer ${i}'s chain is the SAME reference (untouched)`),
  );
  applyFxRemove(drum, panel, 0);
  drum.patch.layers.forEach((l, i) =>
    assert.equal(l.effects, layerChains[i], `remove: layer ${i}'s chain is STILL untouched`),
  );
  assert.deepEqual(
    drum.patch.masterEffects.map((f) => f.type),
    ['saturate'],
    '... with the master chain moved as intended',
  );
});

test('master fx: rebuildFxSection re-derives the slots from the LIVE patch (a wholesale chain replacement)', () => {
  const { panel, drum } = makePanel();
  // A wholesale replacement (a preset load / JSON import, P8): the
  // section must re-read the fresh chain, not the stale one.
  drum.patch = {
    ...drum.patch,
    masterEffects: [{ type: 'highpass', cutoff: 6000 }],
  };
  panel.rebuildFxSection();
  assert.equal(fxSlotsOf(panel).length, 1, 'one slot for the fresh chain');
  assert.equal(slotBadgeOf(fxSlotsOf(panel)[0]).textContent, FX_TYPE_LABELS.highpass);
  const rotor = rotorOf(slotKnobsOf(fxSlotsOf(panel)[0])[0]);
  assert.equal(rotor.getAttribute('aria-label'), 'Master: High-pass 1 cutoff (Hz)');
  assert.equal(rotor.getAttribute('aria-valuenow'), '6000', 'the fresh value');
});

// ---- fader strip (P7/S17) -----------------------------------------------

// The strip's rows are generated from the SAME identity registry as
// the card row (main.js's app.cards entry: Map<layer object,
// { id, label, cardEl }>) — this helper mirrors what main.js passes
// to panel.rebuildStrip, with the card elements left null (the strip
// never reads them).
const makeRegistry = (drum, ids) => {
  const registry = new Map();
  drum.patch.layers.forEach((layer, i) => {
    registry.set(layer, { id: ids[i], label: `Source ${ids[i]}`, cardEl: null });
  });
  return registry;
};

const stripRowsOf = (panel) =>
  stripOf(panel).children.filter((c) => c.className === 'level-row');
const rowFaderOf = (row) => row.children.find((c) => c.className === 'fader');
const rowFaderInputOf = (row) => byClass(row, 'fader-input');
const rowFaderLabelOf = (row) => byClass(row, 'fader-label');
const rowFaderValueOf = (row) => byClass(row, 'fader-value');
const rowButtonsOf = (row) => row.children.find((c) => c.className === 'level-buttons').children;
const rowPlayOf = (row) => rowButtonsOf(row).find((b) => b.textContent === '▶');
const rowEnableOf = (row) => rowButtonsOf(row).find((b) => b.textContent === 'E');
const rowSoloOf = (row) => rowButtonsOf(row).find((b) => b.textContent === 'S');

// The card's gain knob for layer 0 (the twin the strip fader syncs
// with): its entry in the card's .controls list, found by path.
const cardGainKnobOf = (card) =>
  card.controls.find((c) => c.path === 'layers.0.gain').el;

// main.js's sync pass, mirrored: re-set a control list from the live
// patch (the two-writers contract — the readout-sync pass, P3/S8).
// The value goes through the descriptor's read transform (P3/S2: the
// DAHDSR level knobs' raw value is the whole point array — main.js's
// syncCardReadouts does the same).
const syncControls = (drum, controls) => {
  for (const { el, path, descriptor } of controls)
    el.setValue(descriptorRead(descriptor, getPath(drum.patch, path)));
};

test('fader strip: one .level-row per layer in patch order, labeled by the registry ids, faders on layers.N.gain', () => {
  const { panel, drum } = makePanel();
  const registry = makeRegistry(drum, [1, 2, 3]);
  panel.rebuildStrip(registry);
  const rows = stripRowsOf(panel);
  assert.equal(rows.length, 3, 'one row per layer (the snare has three)');
  assert.deepEqual(
    rows.map(rowFaderLabelOf).map((l) => l.textContent),
    ['L1', 'L2', 'L3'],
    'the rows carry the registry ids ("LN" = the card\'s "Source N")',
  );
  rows.forEach((row, i) => {
    const input = rowFaderInputOf(row);
    assert.equal(input.getAttribute('min'), '0', 'the level fader spans 0…1');
    assert.equal(input.getAttribute('max'), '1');
    assert.equal(input.getAttribute('step'), '0.01', '... on the gain knob\'s grid');
    assert.equal(
      input.getAttribute('aria-label'),
      `L${i + 1}`,
      'the fader is labeled with the source identity',
    );
    assert.equal(
      input.value,
      String(getPath(drum.patch, `layers.${i}.gain`)),
      'the fader starts on the layer\'s live gain',
    );
    assert.equal(rowEnableOf(row).getAttribute('aria-pressed'), 'true', 'enabled by default');
    assert.ok(rowEnableOf(row).className.includes('active'), '... and lit');
    assert.equal(rowSoloOf(row).getAttribute('aria-pressed'), 'false', 'not soloed by default');
    assert.equal(rowSoloOf(row).className, 'level-solo', '... and unlit');
  });
  // The element API: the faders' live-bound entries, in row order —
  // the list main.js's syncStripReadouts walks.
  assert.deepEqual(
    panel.stripControls.map((c) => c.path),
    ['layers.0.gain', 'layers.1.gain', 'layers.2.gain'],
    'stripControls holds the faders by path (row order)',
  );
  assert.deepEqual(
    panel.stripControls.map((c) => c.el.value),
    drum.patch.layers.map((l) => l.gain),
    '... and each fader holds its layer\'s gain',
  );
});

test('fader strip: the row count and labels match the registry AFTER a remove-first (stable identity, the P5/S13 pattern)', () => {
  const { panel, drum } = makePanel();
  const registry = makeRegistry(drum, [1, 2, 3]);
  panel.rebuildStrip(registry);
  assert.equal(stripRowsOf(panel).length, 3);
  // Remove the FIRST source (main.js's removeSource, mirrored: the
  // pure op + the registry entry deletion).
  const removed = drum.patch.layers[0];
  drum.patch = removeLayer(drum.patch, 0);
  registry.delete(removed);
  panel.rebuildStrip(registry);
  const rows = stripRowsOf(panel);
  assert.equal(rows.length, 2, 'the strip lost exactly the removed row');
  assert.deepEqual(
    rows.map(rowFaderLabelOf).map((l) => l.textContent),
    ['L2', 'L3'],
    'the survivors keep their ORIGINAL labels — no renumbering ("L3" does not become "L2")',
  );
  assert.deepEqual(
    panel.stripControls.map((c) => c.path),
    ['layers.0.gain', 'layers.1.gain'],
    'the faders re-bind to the survivors\' paths (patch order)',
  );
  assert.equal(
    rowFaderValueOf(rows[0]).textContent,
    String(parseFloat(drum.patch.layers[0].gain.toPrecision(6))),
    '... and the first surviving fader reads the first surviving gain',
  );
});

test('fader strip: a fader input writes layers.N.gain (setPath + onPatchEdit) and the CARD\'s gain knob readout matches (round-trip, both directions)', () => {
  const { panel, drum, edits } = makePanel();
  const registry = makeRegistry(drum, [1, 2, 3]);
  panel.rebuildStrip(registry);
  // The card for layer 0 (the twin display, main.js's card row):
  const card = buildFmCard({
    drum,
    layerIndex: 0,
    layer: drum.patch.layers[0],
    identity: { label: 'Source 1' },
    onPatchEdit: (d) => edits.push(d),
  });
  const gainKnob = cardGainKnobOf(card);

  // main.js's updateDrum syncs BOTH displays after every edit — the
  // mirrored funnel (the card readouts + the strip faders, the two
  // halves of the two-writers pass). A stale twin's setValue fires its
  // onInput once (the knob's contract), which re-enters the funnel and
  // converges: the next pass finds every control holding the value and
  // fires nothing.
  const funnel = () => {
    syncControls(drum, card.controls);
    syncControls(drum, panel.stripControls);
  };

  // (a) Strip -> card: a fader input lands on the patch, and the
  //     funnel's sync pass moves the card's gain knob readout to the
  //     same value.
  fire(rowFaderInputOf(stripRowsOf(panel)[0]), 'input', { target: { value: '0.3' } });
  assert.equal(getPath(drum.patch, 'layers.0.gain'), 0.3, 'the fader edit landed on layers.0.gain');
  assert.ok(edits.length >= 1 && edits.every((d) => d === drum), 'onPatchEdit fired with the drum (the live contract)');
  assert.equal(rowFaderValueOf(stripRowsOf(panel)[0]).textContent, '0.3', 'the fader readout shows the new value');
  funnel();
  assert.equal(
    byClass(gainKnob, 'knob-value').textContent,
    '0.3',
    'the card\'s gain knob readout matches the strip fader (strip -> card)',
  );
  assert.equal(gainKnob.value, 0.3, '... and so does the knob\'s element API');

  // (b) Card -> strip: turning the card's gain knob lands on the same
  //     path, and the funnel's sync pass moves the strip fader readout
  //     back.
  fire(byClass(gainKnob, 'knob-rotor'), 'keydown', { key: 'ArrowUp' }); // 0.3 -> 0.31 (step 0.01)
  assert.ok(
    Math.abs(getPath(drum.patch, 'layers.0.gain') - 0.31) < 1e-9,
    'the card knob edit landed on layers.0.gain (0.31)',
  );
  funnel();
  assert.equal(
    rowFaderInputOf(stripRowsOf(panel)[0]).getAttribute('aria-valuenow'),
    '0.31',
    'the strip fader readout matches the card knob (card -> strip)',
  );
  assert.equal(rowFaderValueOf(stripRowsOf(panel)[0]).textContent, '0.31');

  // (c) The sync pass is loop-safe once both displays hold the value:
  //     re-setting them fires nothing (setValue with the held value is
  //     a no-op — the pass cannot loop).
  const before = edits.length;
  funnel();
  assert.equal(edits.length, before, 'the converged sync pass fires nothing (no loop)');
});

test('fader strip: the E and S clicks fire the toggle funnels (drum, layerIndex) and stop propagation', () => {
  const { panel, drum, enableToggles, soloToggles } = makePanel();
  panel.rebuildStrip(makeRegistry(drum, [1, 2, 3]));
  const rows = stripRowsOf(panel);
  const e0 = fire(rowEnableOf(rows[0]), 'click');
  assert.ok(e0.stopped, 'nothing behind the row may follow the click');
  assert.deepEqual(enableToggles, [[drum, 0]], 'onEnableToggle got the drum and the layer index');
  const s1 = fire(rowSoloOf(rows[1]), 'click');
  assert.ok(s1.stopped);
  assert.deepEqual(soloToggles, [[drum, 1]], 'onSoloToggle got the drum and the layer index');
  assert.equal(rowEnableOf(rows[1]).listeners['click'].length, 1, 'every row carries its own E handler');
  assert.equal(rowSoloOf(rows[2]).listeners['click'].length, 1, '... and its own S handler');
});

test('fader strip: each row carries the ▶ audition button, first in the button column (P7/S18)', () => {
  const { panel, drum } = makePanel();
  panel.rebuildStrip(makeRegistry(drum, [7, 8, 9])); // non-default ids: the aria-label must follow the registry
  const rows = stripRowsOf(panel);
  rows.forEach((row, i) => {
    const btns = rowButtonsOf(row);
    assert.equal(btns.length, 3, '▶, E, S — three buttons per row');
    assert.equal(btns[0].className, 'level-play', 'the play button leads the column');
    assert.equal(btns[0].textContent, '▶');
    assert.equal(
      btns[0].getAttribute('aria-label'),
      `Play Source ${[7, 8, 9][i]}`,
      'the accessible name carries the row\'s identity label (the glyph is not readable)',
    );
    assert.equal(btns[1].textContent, 'E', '... then E,');
    assert.equal(btns[2].textContent, 'S', '... then S');
  });
});

test('fader strip: a ▶ click fires onSourcePlay(drum, layerIndex, identity label) and stops propagation (P7/S18)', () => {
  const { panel, drum, sourcePlays } = makePanel();
  panel.rebuildStrip(makeRegistry(drum, [4, 5, 6]));
  const rows = stripRowsOf(panel);
  const ev = fire(rowPlayOf(rows[1]), 'click');
  assert.ok(ev.stopped, 'nothing behind the row may follow the click');
  assert.deepEqual(
    sourcePlays,
    [[drum, 1, 'Source 5']],
    'the funnel got the drum, the layer index (patch order), and the row\'s STABLE identity label ("Source 5" = the registry\'s id 5 — not the array position)',
  );
  assert.equal(rowPlayOf(rows[0]).listeners['click'].length, 1, 'every row carries its own ▶ handler');
  assert.equal(rowPlayOf(rows[2]).listeners['click'].length, 1, '... including the last row');
  // The audition is a PLAY action, not a mix-view toggle: the E / S
  // states and the patch are untouched by a ▶ click.
  assert.equal(drum.disabledLayers, undefined, '... and the mix-view Sets are not touched');
});

test('fader strip: a rebuild reflects the drum\'s mix-view state (disabled E un-lit, soloed S lit)', () => {
  const { panel, drum } = makePanel();
  const registry = makeRegistry(drum, [1, 2, 3]);
  // The mix-view Sets (app-tier state, main.js owns the mutation —
  // here the test sets them directly, mirroring the toggle funnels).
  drum.disabledLayers = new Set([drum.patch.layers[0]]);
  drum.soloLayers = new Set([drum.patch.layers[2]]);
  panel.rebuildStrip(registry);
  const rows = stripRowsOf(panel);
  assert.equal(rowEnableOf(rows[0]).getAttribute('aria-pressed'), 'false', 'the disabled layer\'s E is un-pressed');
  assert.equal(rowEnableOf(rows[0]).className, 'level-enable', '... and unlit');
  assert.equal(rowSoloOf(rows[2]).getAttribute('aria-pressed'), 'true', 'the soloed layer\'s S is pressed');
  assert.ok(rowSoloOf(rows[2]).className.includes('active'), '... and lit');
  assert.equal(rowEnableOf(rows[1]).getAttribute('aria-pressed'), 'true', 'the other layers stay enabled');
  assert.equal(rowEnableOf(rows[2]).getAttribute('aria-pressed'), 'true');
  assert.equal(rowSoloOf(rows[0]).getAttribute('aria-pressed'), 'false', '... and un-soloed');
  assert.equal(rowSoloOf(rows[1]).getAttribute('aria-pressed'), 'false');
});

test('fader strip: a layer missing from the registry fails loudly (the rows are never numbered from array indices)', () => {
  const { panel, drum } = makePanel();
  const registry = makeRegistry(drum, [1, 2, 3]);
  registry.delete(drum.patch.layers[1]); // a wiring bug: the row is gone
  assert.throws(
    () => panel.rebuildStrip(registry),
    /identity-registry entry/,
    'no silent positional fallback',
  );
  assert.throws(
    () => buildFaderStrip(makeStubEl('div'), drum, new Map(), {}),
    /identity-registry entry/,
    '... and an empty registry throws too',
  );
});

test('fader strip: re-setting a held fader value is a no-op (the sync-pass loop safety)', () => {
  const { panel, drum, edits } = makePanel();
  panel.rebuildStrip(makeRegistry(drum, [1, 2, 3]));
  fire(rowFaderInputOf(stripRowsOf(panel)[0]), 'input', { target: { value: '0.5' } });
  assert.equal(edits.length, 1);
  panel.stripControls[0].el.setValue(0.5); // e.g. the sync pass after a card edit
  assert.equal(edits.length, 1, 'setValue with the held value does not re-fire onPatchEdit');
  panel.stripControls[0].el.setValue(0.6);
  assert.equal(edits.length, 2, '... a real move does');
});

// ---- repo style (GUIDELINES §3: no leftover console.log, no dead code) --

test('master-panel.js source: no console.* calls, no debugger statements', async () => {
  const src = await readFile(join(repoRoot, 'src', 'app', 'master-panel.js'), 'utf8');
  assert.ok(!/console\s*\./.test(src), 'no console.* calls (GUIDELINES §3)');
  assert.ok(!/\bdebugger\b/.test(src), 'no debugger statements');
});
