// Tests for src/app/cards.js (plan newui P3/S7 + P4/S9 + P4/S10 +
// P5/S13 + P5/S14 + P6/S15 + sinecontrol P3/S6-S7) — the source card
// builders: describeToggles (the non-numeric patch fields describeLayer
// does not emit — the wave shape (the carrier's, emitted first, and
// each modulator's), the ring boolean, the cascade target),
// descriptorKind (the descriptor -> control-kind dispatcher, the
// factory-drift guard), buildFmCard (the FM card, with the wave shape
// groups — sinecontrol P3/S6-S7: the card-level carrier shape row +
// one group per modulator block, field-presence gated (the shape
// fields are materialized in place by main.js's rebuildCardRow,
// P3/S7 — the tests materialize them by hand), with the painted
// previews and the sync-pass loop safety — and its DYNAMIC
// modulator sub-section: P5/S14: one .mod-block per modulator + the
// [+ mod] button, rebuilt on modulator structural changes),
// buildNoiseCard (the noise card: same skeleton, the [NOISE]
// badge, the describeLayer knob grid, no modulator sub-section), the
// [✕] remove button (P5/S13: wired to main.js's onRemove structural
// op, disabled on the drum's last source), and the per-card envelope
// preview (plan "dahdsr" P4/S1 — the old free-form editor of P4/S10
// is retired with the constrained DAHDSR editor):
// cardEnvelopeOptions (the per-source option list — level / pitch /
// fm depth, the field-presence rule) and initCardEnvelopeEditor (open
// at build — the level (volume) envelope is the visible default — the
// [env] toggle, the kind select, and the 320×120 DISPLAY-ONLY preview
// canvas whose click opens the full-screen modal). Same headless
// DOM-stub technique as test/knob.test.mjs: a
// minimal document.createElement stand-in records what the builder
// writes (classes, attributes, text, children) and which event
// listeners it registers; events are fired by invoking the recorded
// handlers with a synthetic event object. No browser, no layout — the
// code under the stub is the REAL src/app/cards.js.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFmCard,
  buildNoiseCard,
  cardEnvelopeOptions,
  descriptorKind,
  describeToggles,
  initCardFxSlots,
} from '../src/app/cards.js';
import {
  descriptorRead,
  describeLayer,
  describePatch,
  editorValueRange,
  FX_TYPE_LABELS,
  SHAPE_OPTIONS,
} from '../src/app/controls.js';
// The drift guard below needs the engine's closed enum. Tests are
// exempt from the facade-only import rule (GUIDELINES §1.4(b)) and
// import lib internals directly (the test/fm.test.mjs precedent).
import { WAVE_SHAPES } from '../src/lib/osc.js';
import { KNEE_CURVE } from '../src/lib/envelopes.js';
import { formatKnobValue } from '../src/app/knob.js';
import {
  addFx,
  addModulator,
  removeFx,
  removeModulator,
} from '../src/app/patch-ops.js';
import { COLORS, PAD_BOTTOM, PAD_TOP, withAlpha } from '../src/app/viz.js';
import { hzToNoteName } from '../src/app/band.js';
import { dahdsrToPoints, segmentMidValue } from '../src/app/dahdsr.js';
import { DRUM_COLORS, THEME } from '../src/app/theme.js';
import {
  getPath,
  hihatPatch,
  kickPatch,
  renderPatch,
  setPath,
  snarePatch,
} from '../src/lib/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- headless DOM stub (the test/knob.test.mjs technique) -----------

// A 2D context that records every drawing call (method + args, in
// order) and throws on a non-finite coordinate (the established free
// NaN guard from the band/boot-check stubs). Property assignments
// (font, textAlign, ...) are plain sets the recording does not need —
// but strokeStyle / fillStyle / lineWidth are tracked: each stroke()
// snapshots its path + strokeStyle + lineWidth into g.strokes and each
// fill() its path + fillStyle into g.fills (the test/knob.test.mjs
// technique), so a test can ask "which color and width did this paint
// use" (plan "colors" S4 — the drum-hue assertions read these). The
// shadowColor / shadowBlur assignments are ALSO recorded into calls
// (the band/viz stub pattern, plan "colors" S10 — the handle-halo
// ordering assertions read their indices), and createLinearGradient
// returns a distinct sentinel object { __gradient: [x0, y0, x1, y1] }
// whose addColorStop records [offset, color] into its own stops (the
// S9/S10 gradient assertions, by sentinel identity via fillStyle);
// the sentinels collect into g.gradients.
const makeStubContext = () => {
  const g = { calls: [], strokes: [], fills: [], gradients: [] };
  let path = [];
  g.strokeStyle = undefined;
  g.fillStyle = undefined;
  g.lineWidth = 1;
  let shadowColor;
  let shadowBlur = 0; // the real canvas default (a glow-free start)
  Object.defineProperty(g, 'shadowColor', {
    get: () => shadowColor,
    set: (v) => { shadowColor = v; g.calls.push(['shadowColor', v]); },
    enumerable: true,
  });
  Object.defineProperty(g, 'shadowBlur', {
    get: () => shadowBlur,
    set: (v) => { shadowBlur = v; g.calls.push(['shadowBlur', v]); },
    enumerable: true,
  });
  g.createLinearGradient = (x0, y0, x1, y1) => {
    for (const v of [x0, y0, x1, y1])
      if (typeof v === 'number' && !Number.isFinite(v))
        throw new Error(
          `non-finite coordinate in createLinearGradient: ${[x0, y0, x1, y1]}`,
        );
    g.calls.push(['createLinearGradient', x0, y0, x1, y1]);
    const grad = { __gradient: [x0, y0, x1, y1], stops: [] };
    grad.addColorStop = (offset, color) => {
      grad.stops.push([offset, color]);
      g.calls.push(['addColorStop', offset, color]);
    };
    g.gradients.push(grad);
    return grad;
  };
  for (const m of [
    'clearRect', 'fillRect', 'fillText', 'stroke', 'fill', 'beginPath',
    'moveTo', 'lineTo', 'arc', 'save', 'restore', 'translate', 'closePath',
  ])
    g[m] = (...args) => {
      g.calls.push([m, ...args]);
      for (const a of args)
        if (typeof a === 'number' && !Number.isFinite(a))
          throw new Error(`non-finite coordinate in ${m}: ${args}`);
      if (m === 'beginPath') path = [];
      if (m === 'moveTo' || m === 'lineTo') path.push({ x: args[0], y: args[1] });
      if (m === 'stroke') {
        g.strokes.push({
          pts: path.slice(),
          strokeStyle: g.strokeStyle,
          lineWidth: g.lineWidth,
        });
        path = [];
      }
      if (m === 'fill') g.fills.push({ pts: path.slice(), fillStyle: g.fillStyle });
    };
  g.measureText = (t) => ({ width: 30, text: t });
  return g;
};

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

const makeStubEl = (tagName) => {
  const el = {
    tagName,
    className: '',
    textContent: '',
    style: makeStubStyle(),
    children: [],
    attributes: Object.create(null),
    listeners: Object.create(null),
    capturedPointers: [],
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
    // Replace the whole child list (the P5/S14 modulator sub-section
    // rebuild and the editor's option refresh use it — the only child-
    // removal primitive the stub provides; the real DOM has it).
    replaceChildren(...children) {
      el.children.length = 0;
      el.children.push(...children);
    },
    addEventListener(type, handler) {
      (el.listeners[type] ??= []).push(handler);
    },
    setPointerCapture(pointerId) {
      el.capturedPointers.push(pointerId);
    },
    // The canvas is CSS-scaled in the browser; the stub maps 1:1, so a
    // synthetic clientX/clientY arrives as canvas px (the editor's
    // canvasPos maps through this rect).
    getBoundingClientRect() {
      return { left: 0, top: 0, width: el.width ?? 0, height: el.height ?? 0 };
    },
    // One MEMOIZED 2D context per element — a real canvas returns the
    // same context on every getContext('2d') call, and the tests read
    // the recorded calls off that same object.
    getContext() {
      el.context ??= makeStubContext();
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

// The element's text as the real DOM aggregates it: its own
// textContent plus every descendant's, in tree order (the stub records
// per-element text only — the builders set text on the leaf spans,
// never on their containers).
const textOf = (el) =>
  el.children.reduce((text, child) => text + (child.textContent ?? '') + textOf(child), el.textContent ?? '');

// ---- test fixtures ----------------------------------------------------

// A minimal live drum the card edits: one layer, an empty master chain.
const makeDrum = (layer) => ({
  name: 'test',
  duration: 0.5,
  patch: { layers: [layer], masterEffects: [] },
});

// The legacy 4-point level envelope shape (pre-canonical, P3/S2):
// the card fixtures keep it on purpose — the DAHDSR knob transforms
// adopt any levelEnv shape via normalizeLevelEnv on read/write, so
// the tests exercise the normalizer path (the engine itself reads
// the raw points; src/lib/envelopes.js).
const levelEnv = (attack, end) => [
  { t: 0, v: 0 },
  { t: attack, v: 1 },
  { t: (attack + end) / 2, v: 0.25 },
  { t: end, v: 0 },
];

// A 2-modulator FM layer; the modulators' extra fields (ring /
// modulates) are opt-in through `over`, mirroring how engine patches
// carry them only when a voice actually uses them.
const twoModLayer = (over = {}) => ({
  type: 'fm',
  carrier: { freq: 100 },
  modulators: [
    { freq: 300, index: 4, ...over.mod0 },
    { freq: 600, index: 2, ...over.mod1 },
  ],
  levelEnv: levelEnv(0.005, 0.3),
  gain: 0.5,
});

// The kick's FM body is the plan's reference card (P3/S7). The
// identity label is deliberately NOT "Source 1" (its array position) —
// the card must show the passed-in label, never compute its own number.
const KICK_IDENTITY = { label: 'Source 2' };

const makeCard = (overrides = {}) => {
  const layer = kickPatch().layers[0];
  const drum = makeDrum(layer);
  const edits = [];
  const workings = [];
  const card = buildFmCard({
    drum,
    layerIndex: 0,
    layer,
    identity: KICK_IDENTITY,
    onPatchEdit: (d) => edits.push(d),
    onWorking: (d, i) => workings.push([d, i]),
    ...overrides,
  });
  return { card, drum, layer, edits, workings };
};

// ---- describeToggles ---------------------------------------------------

test('describeToggles: a 2-modulator FM layer with ring + modulates gets a ring group and a target select', () => {
  const layer = twoModLayer({ mod0: { ring: true, modulates: 1 } });
  const toggles = describeToggles(layer, 2); // i = 2 -> "Source 3" labels
  assert.equal(toggles.length, 2);
  assert.deepEqual(toggles[0], {
    kind: 'button-group',
    path: 'layers.2.modulators.0.ring',
    label: 'Source 3: modulator 1 ring',
    displayLabel: 'modulator 1 ring',
    options: [
      { value: false, label: 'off' },
      { value: true, label: 'on' },
    ],
  });
  assert.deepEqual(toggles[1], {
    kind: 'select',
    path: 'layers.2.modulators.0.modulates',
    label: 'Source 3: modulator 1 target',
    displayLabel: 'modulator 1 target',
    options: [
      { value: undefined, label: 'none' },
      { value: 1, label: 'modulator 2' },
    ],
  });
});

test('describeToggles: omits the ring group when no modulator has a ring field', () => {
  const layer = twoModLayer({ mod0: { modulates: 1 } }); // no `ring` anywhere
  const toggles = describeToggles(layer, 0);
  assert.equal(toggles.length, 1);
  assert.equal(toggles[0].kind, 'select');
  assert.equal(toggles[0].path, 'layers.0.modulators.0.modulates');
});

test('describeToggles: a ring group is emitted per modulator that carries the field', () => {
  const layer = twoModLayer({ mod1: { ring: false } }); // only mod 2 has it
  const toggles = describeToggles(layer, 0);
  assert.equal(toggles.length, 1);
  assert.equal(toggles[0].kind, 'button-group');
  assert.equal(toggles[0].path, 'layers.0.modulators.1.ring');
});

test('describeToggles: the target select offers none + the other modulators, excluding itself', () => {
  const layer = {
    type: 'fm',
    carrier: { freq: 100 },
    modulators: [
      { freq: 200, index: 1 },
      { freq: 400, index: 2, modulates: 0 },
      { freq: 800, index: 3 },
    ],
    gain: 0.5,
  };
  const toggles = describeToggles(layer, 1);
  assert.equal(toggles.length, 1); // only modulator 2 carries the field
  assert.equal(toggles[0].path, 'layers.1.modulators.1.modulates');
  assert.deepEqual(toggles[0].options, [
    { value: undefined, label: 'none' },
    { value: 0, label: 'modulator 1' },
    { value: 2, label: 'modulator 3' },
  ]);
});

test('describeToggles: a single modulator has no target select (no other modulator to cascade into)', () => {
  const layer = {
    type: 'fm',
    carrier: { freq: 100 },
    modulators: [{ freq: 200, index: 1, modulates: 0 }],
    gain: 0.5,
  };
  assert.deepEqual(describeToggles(layer, 0), []);
});

test('describeToggles: noise layers have no toggles (neither field exists on them)', () => {
  const layer = { type: 'noise', seed: 1, cutoff: 1000, decay: 0.1, gain: 0.5 };
  assert.deepEqual(describeToggles(layer, 1), []);
});

test("describeToggles: an unknown layer type throws, mirroring describeLayer's guard", () => {
  assert.throws(() => describeToggles({ type: 'sine' }, 0), /unknown layer type/);
  assert.throws(() => describeToggles({ type: undefined }, 0), /unknown layer type/);
});

// The kick body with the shape fields MATERIALIZED (plan sinecontrol
// P3/S7 does this in rebuildCardRow; the tests do it by hand): the
// shape-group descriptors are field-presence gated, so they appear
// only once the fields exist on the layer. kickPatch() builds fresh
// arrays per call, so the in-place mutation stays local.
const materializedKickBody = () => {
  const layer = kickPatch().layers[0];
  layer.carrier.shape = 'sine';
  for (const m of layer.modulators) m.shape = 'sine';
  return layer;
};

test('describeToggles: a materialized kick body emits the carrier shape FIRST, then one per modulator', () => {
  const toggles = describeToggles(materializedKickBody(), 0);
  assert.equal(toggles.length, 2, 'carrier + the body\'s single modulator');
  assert.deepEqual(toggles[0], {
    kind: 'shape-group',
    path: 'layers.0.carrier.shape',
    label: 'Source 1: wave shape',
    displayLabel: 'wave shape',
    options: SHAPE_OPTIONS,
  });
  assert.deepEqual(toggles[1], {
    kind: 'shape-group',
    path: 'layers.0.modulators.0.shape',
    label: 'Source 1: modulator 1 shape',
    displayLabel: 'modulator 1 shape',
    options: SHAPE_OPTIONS,
  });
});

test('describeToggles: a 2-modulator materialized layer orders carrier, mod 1 shape, mod 1 ring, mod 1 target, mod 2 shape', () => {
  const layer = {
    type: 'fm',
    carrier: { freq: 100, shape: 'square' },
    modulators: [
      { freq: 300, index: 4, shape: 'sine', ring: true, modulates: 1 },
      { freq: 600, index: 2, shape: 'saw' },
    ],
    levelEnv: levelEnv(0.005, 0.3),
    gain: 0.5,
  };
  const toggles = describeToggles(layer, 0);
  assert.deepEqual(
    toggles.map((t) => [t.kind, t.path]),
    [
      ['shape-group', 'layers.0.carrier.shape'],
      ['shape-group', 'layers.0.modulators.0.shape'],
      ['button-group', 'layers.0.modulators.0.ring'],
      ['select', 'layers.0.modulators.0.modulates'],
      ['shape-group', 'layers.0.modulators.1.shape'],
    ],
    'the carrier first; within each block: shape, then ring, then target',
  );
  for (const t of toggles)
    if (t.kind === 'shape-group') assert.deepEqual(t.options, SHAPE_OPTIONS);
  assert.equal(toggles[1].label, 'Source 1: modulator 1 shape');
  assert.equal(toggles[4].label, 'Source 1: modulator 2 shape');
});

test('describeToggles: a layer WITHOUT the shape fields (a raw voice patch) emits NO shape descriptors', () => {
  // Field-presence: the materialization in rebuildCardRow (P3/S7) is
  // what makes the shape fields — and these descriptors — appear.
  assert.deepEqual(describeToggles(kickPatch().layers[0], 0), []);
  const shell = snarePatch().layers[1]; // constant carrier, no modulators
  assert.deepEqual(describeToggles(shell, 1), []);
  // Partial materialization: only the fields that exist get controls.
  const toggles = describeToggles(twoModLayer({ mod0: { shape: 'square' } }), 0);
  assert.equal(toggles.length, 1, 'only mod 1 has a shape field');
  assert.equal(toggles[0].path, 'layers.0.modulators.0.shape');
});

test('SHAPE_OPTIONS values mirror WAVE_SHAPES (the lib/app enum drift guard)', () => {
  // The values ARE the engine's closed enum (patch data); the labels
  // are UI glyphs. If osc.js ever gains or reorders a shape, this
  // fails loudly instead of the control offering a stale set (the
  // FX_TYPE_LABELS drift-guard precedent).
  assert.deepEqual(
    SHAPE_OPTIONS.map((o) => o.value),
    WAVE_SHAPES,
    'SHAPE_OPTIONS values must mirror osc.js WAVE_SHAPES',
  );
});

// ---- descriptorKind: the factory-drift guard --------------------------

test('descriptorKind: every descriptor describePatch emits for the three voice patches is a knob', () => {
  for (const build of [kickPatch, snarePatch, hihatPatch]) {
    const patch = build();
    const descriptors = describePatch(patch);
    assert.ok(descriptors.length > 0, `${build.name}: empty descriptor list`);
    for (const d of descriptors)
      assert.equal(descriptorKind(d), 'knob', `${build.name}: ${d.path}`);
  }
});

test('descriptorKind: the toggle descriptors classify as their control kind', () => {
  const layer = twoModLayer({ mod0: { ring: false, modulates: 1 } });
  const [ring, target] = describeToggles(layer, 0);
  assert.equal(descriptorKind(ring), 'button-group');
  assert.equal(descriptorKind(target), 'select');
});

test('descriptorKind: the shape-group descriptor classifies as shape-group; a range is still a knob', () => {
  assert.equal(
    descriptorKind({
      kind: 'shape-group',
      path: 'layers.0.carrier.shape',
      label: 'Source 1: wave shape',
      options: SHAPE_OPTIONS,
    }),
    'shape-group',
  );
  assert.equal(descriptorKind({ min: 0, max: 1, step: 0.01 }), 'knob');
});

test('descriptorKind: a descriptor that is neither a range nor a known toggle kind throws', () => {
  assert.throws(() => descriptorKind({ path: 'layers.0.x', label: 'x' }), /cannot classify/);
  assert.throws(() => descriptorKind({ kind: 'fader', path: 'x' }), /cannot classify/);
  assert.throws(() => descriptorKind({ min: 0, max: 0, step: 1 }), /cannot classify/);
  assert.throws(() => descriptorKind(null), /cannot classify/);
});

// ---- buildFmCard: the card shape ---------------------------------------

test('buildFmCard: the card is a <section class="card"> with head, knob grid, modulator sub-section, footer, and env editor section', () => {
  const { card } = makeCard();
  assert.equal(card.tagName, 'section');
  assert.equal(card.className, 'card');
  assert.ok(byClass(card, 'card-head'), 'missing .card-head');
  assert.ok(card.children.find((c) => c.className === 'knob-grid'), 'missing the card-level .knob-grid');
  assert.ok(byClass(card, 'mod-section'), 'missing the .mod-section sub-section');
  assert.ok(byClass(card, 'card-footer'), 'missing .card-footer');
  // The per-card envelope editor section (P4/S10) is the last child,
  // OPEN at build — the volume (level) envelope is visible by default
  // and the [env ▴] button collapses it.
  const env = envSectionOf(card);
  assert.ok(env, 'missing the .card-env editor section');
  assert.equal(card.children.at(-1), env, 'the editor section is the last child');
  assert.equal(env.className, 'card-env', 'open at build (the volume envelope visible by default)');
  assert.equal(byClass(card, 'card-env-btn').textContent, 'env ▴', 'the button advertises the collapse');
  assert.ok(envCanvasOf(card).getContext('2d').calls.length > 0, 'the open editor painted from the patch at build');
});

test('buildFmCard: the working flag lands on the section class', () => {
  assert.equal(makeCard({ working: true }).card.className, 'card working');
  assert.equal(makeCard({ working: false }).card.className, 'card');
});

test('buildFmCard: one knob per describeLayer descriptor — card-level in the grid, per-modulator in its block — each carrying its range', () => {
  const { card, layer } = makeCard();
  const descriptors = describeLayer(layer, 0);
  const knobs = card.controls.filter((c) => byClass(c.el, 'knob-value'));
  assert.equal(knobs.length, descriptors.length, 'one knob per numeric descriptor');
  for (const entry of knobs) {
    // The entry carries its own descriptor (P3/S2: the nine level
    // knobs share ONE path — find-by-path would collide).
    const d = entry.descriptor;
    const rotor = byClass(entry.el, 'knob-rotor');
    assert.ok(rotor, `knob for ${d.path} is missing its rotor`);
    assert.equal(rotor.getAttribute('aria-label'), d.label);
    assert.equal(rotor.getAttribute('aria-valuemin'), String(d.min));
    assert.equal(rotor.getAttribute('aria-valuemax'), String(d.max));
  }
});

test('buildFmCard: the kick body splits its 15 descriptors — 13 card-level knobs + 4 in the modulator block', () => {
  const { card } = makeCard();
  // Card grid: 3 pitch knobs (start/time/end) + the nine DAHDSR level
  // knobs (P3/S2) + gain. The modulator block: its freq + the 3
  // FM-depth knobs (the indexEnv shadows the constant index; the env's
  // second anchor — 'FM index end' — is now exposed too).
  const cardGrid = card.children.find((c) => c.className === 'knob-grid');
  assert.equal(cardGrid.children.length, 13, 'the card-level knobs');
  const block = byClassAll(card, 'mod-block')[0];
  const blockGrid = block.children.find((c) => c.className === 'knob-grid');
  assert.equal(blockGrid.children.length, 4, 'the modulator block\'s knobs');
});

test('buildFmCard: every knob readout shows the live patch value (getPath, not a private copy)', () => {
  const { card, drum, layer } = makeCard();
  const descriptors = describeLayer(layer, 0);
  for (const { el, descriptor } of card.controls) {
    if (!Number.isFinite(descriptor?.min)) continue; // a toggle (no knob readout)
    const readout = byClass(el, 'knob-value');
    assert.ok(readout, `a readout for ${descriptor.path}`);
    // The readout shows the descriptor READ of the raw value (the
    // level knobs' raw value is the whole point array, P3/S2).
    assert.equal(
      readout.textContent,
      formatKnobValue(descriptorRead(descriptor, getPath(drum.patch, descriptor.path)), descriptor),
      `readout for ${descriptor.path}`,
    );
  }
});

test('buildFmCard: shadowing end to end — a pitchEnv layer shows pitch start/time/end and NO carrier-freq knob', () => {
  const { card } = makeCard(); // the kick body carries a pitchEnv
  const labels = byClassAll(card, 'knob-label').map((el) => el.textContent);
  // The VISIBLE captions drop the `Source N:` prefix (plan ui3 P5/S1 —
  // the card head already shows the source); the rotor aria-labels
  // keep the FULL labels (the pin above, `aria-label === d.label`).
  assert.ok(labels.includes('pitch start (Hz)'));
  assert.ok(labels.includes('pitch time (s)'));
  assert.ok(labels.includes('pitch end (Hz)'));
  assert.ok(!labels.some((l) => l.startsWith('Source 1:')), 'no prefix survives in the visible captions');
  assert.ok(
    !labels.some((l) => l.includes('carrier freq')),
    `no carrier-freq knob for a pitchEnv layer, got: ${labels}`,
  );

  // The inverse: the snare shell (constant 330 Hz carrier, no pitchEnv,
  // no modulators) shows the carrier knob and no pitch knobs. The card
  // addresses layers.1 of the FULL snare patch, so the drum must carry
  // the shell at its real index.
  const snare = snarePatch();
  const shell = snare.layers[1];
  const shellCard = buildFmCard({
    drum: { name: 'snare', duration: 0.5, patch: snare }, // duration unused by the card
    layerIndex: 1,
    layer: shell,
    identity: { label: 'Source 2' },
  });
  const shellLabels = byClassAll(shellCard, 'knob-label').map((el) => el.textContent);
  assert.ok(shellLabels.includes('carrier freq (Hz)'));
  assert.ok(!shellLabels.some((l) => l.includes('pitch')));
});

test('buildFmCard: .controls lists every live-bound control with its patch path (the readout-sync contract)', () => {
  const { card, drum, layer } = makeCard();
  const expected = [
    ...describeLayer(layer, 0),
    ...describeToggles(layer, 0),
  ];
  assert.ok(Array.isArray(card.controls), '.controls is a list');
  assert.equal(card.controls.length, expected.length, 'one entry per descriptor');
  // Order: the card-level controls first, then the modulator block's
  // (a stable partition — within each group the factory order holds).
  const isMod = (d) => d.path.includes('.modulators.');
  const sorted = [...expected].sort((a, b) => Number(isMod(a)) - Number(isMod(b)));
  sorted.forEach((d, i) => {
    const entry = card.controls[i];
    assert.equal(entry.path, d.path, `control ${i} carries the descriptor's path`);
    assert.equal(typeof entry.el.setValue, 'function', 'the entry is a setValue-able control');
    // The control holds the descriptor READ of the live value (the
    // level knobs' raw value is the whole point array, P3/S2).
    assert.equal(entry.el.value, descriptorRead(d, getPath(drum.patch, d.path)),
      `control ${i} starts on the live patch value`);
  });
});

test('buildFmCard: .controls puts the card-level knobs first, then each modulator block (its knobs, then its toggles)', () => {
  const layer = twoModLayer({ mod0: { ring: false, modulates: 1 } });
  const drum = makeDrum(layer);
  const card = buildFmCard({
    drum,
    layerIndex: 0,
    layer,
    identity: { label: 'Source 1' },
  });
  assert.deepEqual(
    card.controls.map((c) => c.path),
    [
      // Card grid (the non-modulator descriptors, factory order):
      'layers.0.carrier.freq',
      'layers.0.levelEnv', // ×9 — the DAHDSR knobs share the one path (P3/S2)
      'layers.0.levelEnv',
      'layers.0.levelEnv',
      'layers.0.levelEnv',
      'layers.0.levelEnv',
      'layers.0.levelEnv',
      'layers.0.levelEnv',
      'layers.0.levelEnv',
      'layers.0.levelEnv',
      'layers.0.gain',
      // Modulator block 1 (its knobs, then its toggles):
      'layers.0.modulators.0.freq',
      'layers.0.modulators.0.index',
      'layers.0.modulators.0.ring',
      'layers.0.modulators.0.modulates',
      // Modulator block 2 (its knobs — it carries no toggle fields):
      'layers.0.modulators.1.freq',
      'layers.0.modulators.1.index',
    ],
    'card-level first, then per-block knobs-then-toggles',
  );
  // The toggle entries start on the live patch values too (the nine
  // DAHDSR level knobs push them past the gain, P3/S2).
  assert.equal(card.controls[13].el.value, false, 'ring group starts on the patch value');
  assert.equal(card.controls[14].el.value, 1, 'target select starts on the patch value');
});

test('buildFmCard: the head shows the identity label passed in — never the array index', () => {
  const { card } = makeCard(); // identity 'Source 2' at layerIndex 0
  const headText = textOf(byClass(card, 'card-head'));
  assert.equal(
    textOf(byClass(card, 'card-title')),
    'Source 2',
    'the title IS the identity label — no doubled prefix (the CSS uppercases it)',
  );
  assert.ok(headText.includes('Source 2'), 'the passed-in label');
  assert.ok(
    !headText.includes('Source 1'),
    'the head must not compute its number from layerIndex',
  );
  assert.ok(headText.includes('FM'), 'the type badge');
});

test('buildFmCard: the head carries the [✕] remove button and the solo dot', () => {
  const { card } = makeCard();
  const remove = byClass(card, 'card-remove');
  assert.equal(remove.tagName, 'button');
  assert.equal(remove.type, 'button');
  assert.equal(remove.textContent, '✕');
  assert.ok(byClass(card, 'card-solo'), 'the solo indicator dot (P7)');
});

test('buildFmCard: the [✕] is disabled with no handler on the drum\'s last source (the removeLayer guard)', () => {
  const { card } = makeCard(); // makeDrum: a single-layer patch
  const remove = byClass(card, 'card-remove');
  assert.equal(remove.disabled, true, 'one source left: the [✕] is disabled');
  assert.equal(remove.listeners['click'], undefined, '... and carries no handler');
});

test('buildFmCard: clicking [✕] fires onRemove(drum, layerIndex) and stops the head click', () => {
  const layer = kickPatch().layers[0];
  const other = kickPatch().layers[1]; // the noise click: a second source
  const drum = {
    name: 'kick',
    duration: 0.5,
    patch: { layers: [layer, other], masterEffects: [] },
  };
  const removes = [];
  const card = buildFmCard({
    drum,
    layerIndex: 0,
    layer,
    identity: { label: 'Source 1' },
    onRemove: (d, i) => removes.push([d, i]),
  });
  const remove = byClass(card, 'card-remove');
  assert.equal(remove.disabled, false, 'two sources: the [✕] is enabled');
  const event = fire(remove, 'click');
  assert.equal(
    event.stopped,
    true,
    'stopPropagation: the head\'s working-source click does not follow',
  );
  assert.deepEqual(removes, [[drum, 0]], 'onRemove got the drum and the layer index');
});

test('buildFmCard: a constant-freq FM card shows the "add pitch env" button; a pitchEnv card and a noise card do not', () => {
  // The hi-hat partials are constant-freq FM (no pitchEnv key) — the
  // band's working-source gate cannot work them as-is, so their cards
  // offer the button (P4/S11).
  const hat = hihatPatch();
  const hatCard = buildFmCard({
    drum: { name: 'hihat', duration: 0.3, patch: hat },
    layerIndex: 3,
    layer: hat.layers[3],
    identity: { label: 'Source 4' },
  });
  const btn = byClass(hatCard, 'card-add-pitch');
  assert.ok(btn, 'the constant-freq card carries the button');
  assert.equal(btn.tagName, 'button');
  assert.equal(btn.textContent, 'add pitch env');
  // It sits in the head, after the type badge.
  const head = byClass(hatCard, 'card-head');
  assert.ok(head.children.includes(btn), 'the button is a head child');
  assert.equal(head.children.indexOf(byClass(hatCard, 'card-badge')) < head.children.indexOf(btn), true,
    '... right after the badge');

  // The kick body (has a pitchEnv): its pitch is edited in the band
  // directly — no button.
  assert.equal(byClass(makeCard().card, 'card-add-pitch'), null, 'a pitchEnv card has no button');
  // A noise card: never (the band edits FM pitch only).
  assert.equal(byClass(makeNoiseCard().card, 'card-add-pitch'), null, 'a noise card has no button');
});

test('buildFmCard: clicking "add pitch env" inserts a flat 2-point pitchEnv at the current freq, then works the source', () => {
  const hat = hihatPatch();
  const drum = { name: 'hihat', duration: 0.3, patch: hat };
  const edits = [];
  const workings = [];
  const card = buildFmCard({
    drum,
    layerIndex: 3,
    layer: hat.layers[3],
    identity: { label: 'Source 4' },
    onPatchEdit: (d) => edits.push(d),
    onWorking: (d, i) => workings.push([d, i]),
  });
  const btn = byClass(card, 'card-add-pitch');
  const freq = hat.layers[3].carrier.freq;
  const layerRef = hat.layers[3];
  assert.ok(!('pitchEnv' in layerRef), 'fixture sanity: the partial carries no pitchEnv key');

  const event = fire(btn, 'click');
  assert.ok(event.stopped, 'the click stops propagation (the head\'s onWorking must not double-fire)');

  // One mutation: a flat 2-point pitch envelope at the current carrier
  // frequency, spanning the drum's duration (the band's time axis) —
  // the source is now workable, and the patch schema stays honest
  // (the envelope exists because the user asked for it).
  assert.deepEqual(
    getPath(drum.patch, 'layers.3.pitchEnv'),
    [{ t: 0, v: freq }, { t: drum.duration, v: freq }],
    'a flat 2-point pitchEnv at the current freq',
  );
  assert.equal(hat.layers[3], layerRef,
    'created in place on the live layer object — not a wholesale replacement (the registry keys on it)');
  assert.equal(edits.length, 1, 'one onPatchEdit (the funnel re-renders)');
  assert.equal(edits[0], drum);
  assert.deepEqual(workings, [[drum, 3]], 'the source is then selected as the working one');
});

test('buildFmCard: the footer carries the (wired) env button and the fx slot list (empty chain: hint + [+ fx], the type group hidden)', () => {
  const { card } = makeCard(); // the kick body HAS editable envelopes, NO fx
  const envBtn = byClass(card, 'card-env-btn');
  assert.equal(envBtn.tagName, 'button');
  assert.equal(envBtn.textContent, 'env ▴', 'the editor is open at build (the collapse affordance)');
  assert.deepEqual(
    Object.keys(envBtn.listeners),
    ['click'],
    'the env button is wired by the per-card editor (P4/S10)',
  );
  const fx = byClass(card, 'card-fx');
  assert.ok(fx, 'the FX slot container in the footer');
  // The kick body's chain is EMPTY: the muted "no fx" hint, the
  // enabled [+ fx] button (with a handler), the hidden type group.
  assert.equal(fx.children[0].className, 'fx-empty');
  assert.equal(fx.children[0].textContent, 'no fx', 'the muted empty-chain hint');
  const add = fx.children[1];
  assert.equal(add.className, 'fx-add');
  assert.equal(add.textContent, '+ fx');
  assert.equal(add.disabled, false, 'the empty chain is not at the cap');
  assert.ok(add.listeners['click'], '... and carries a handler');
  const types = fx.children[2];
  assert.equal(types.className, 'fx-types hidden', 'the type group is hidden at build');
  assert.deepEqual(
    types.children[0].children
      .filter((c) => c.tagName === 'button')
      .map((b) => b.textContent),
    Object.values(FX_TYPE_LABELS),
    'the four engine fx types, the labels REUSED from FX_TYPE_LABELS',
  );
  // No slots, no cap note.
  assert.equal(byClassAll(card, 'fx-slot').length, 0);
  assert.equal(byClass(card, 'fx-cap'), null);
});

test('buildFmCard: a noise layer is not an FM card (buildNoiseCard is its builder)', () => {
  const layer = { type: 'noise', seed: 1, cutoff: 1000, decay: 0.1, gain: 0.5 };
  assert.throws(
    () => buildFmCard({
      drum: makeDrum(layer),
      layerIndex: 0,
      layer,
      identity: { label: 'Source 1' },
    }),
    /needs an "fm" layer/,
  );
});

test('buildFmCard: a missing identity label throws (the card never numbers itself)', () => {
  const layer = kickPatch().layers[0];
  assert.throws(
    () => buildFmCard({ drum: makeDrum(layer), layerIndex: 0, layer }),
    /needs an identity/,
  );
});

// ---- buildFmCard: the live-patch wiring ---------------------------------

test('buildFmCard: turning a knob applies setPath to the live patch, then fires onPatchEdit', () => {
  const { card, drum, layer, edits } = makeCard();
  const descriptors = describeLayer(layer, 0);
  const gain = descriptors.at(-1);
  assert.equal(gain.path, 'layers.0.gain');
  // The CARD-LEVEL grid (a direct child — byClass walks in reverse
  // tree order, so it would find the modulator block's grid first).
  const gainKnob = card.children
    .find((c) => c.className === 'knob-grid').children.at(-1);
  const rotor = byClass(gainKnob, 'knob-rotor');
  fire(rotor, 'keydown', { key: 'ArrowUp' }); // 0.8 -> 0.81
  assert.equal(edits.length, 1);
  assert.equal(edits[0], drum, 'onPatchEdit receives the drum');
  assert.ok(
    Math.abs(getPath(drum.patch, gain.path) - 0.81) < 1e-9,
    'the patch holds the knob\'s new value',
  );
  assert.equal(edits.length, 1, 'one edit per knob move');
});

test('buildFmCard: clicking a ring toggle flips the patch field through setPath, then fires onPatchEdit', () => {
  const layer = twoModLayer({ mod0: { ring: false } });
  const drum = makeDrum(layer);
  const edits = [];
  const card = buildFmCard({
    drum,
    layerIndex: 0,
    layer,
    identity: { label: 'Source 1' },
    onPatchEdit: (d) => edits.push(d),
  });
  // The RING group (the card also carries the fx type group, P6/S15 —
  // pick the group by its aria-label, the ring descriptor's label).
  const group = byClassAll(card, 'button-group').find(
    (g) => g.getAttribute('aria-label') === 'Source 1: modulator 1 ring',
  );
  const buttons = group.children.filter((c) => c.tagName === 'button');
  assert.deepEqual(buttons.map((b) => b.textContent), ['off', 'on']);
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true'); // ring is false

  fire(buttons[1], 'click'); // on
  assert.equal(drum.patch.layers[0].modulators[0].ring, true, 'the patch copy holds the flipped value');
  assert.equal(edits.length, 1);
  assert.equal(edits[0], drum);
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'true');

  fire(buttons[0], 'click'); // off again
  assert.equal(drum.patch.layers[0].modulators[0].ring, false);
  assert.equal(edits.length, 2);
});

test('buildFmCard: the cascade target select writes modulators.N.modulates (undefined = none)', () => {
  const layer = twoModLayer({ mod0: { modulates: undefined } });
  const drum = makeDrum(layer);
  const edits = [];
  const card = buildFmCard({
    drum,
    layerIndex: 0,
    layer,
    identity: { label: 'Source 1' },
    onPatchEdit: (d) => edits.push(d),
  });
  const select = byClass(card, 'select-input');
  assert.deepEqual(
    select.children.map((o) => [o.value, o.textContent]),
    [['', 'none'], ['1', 'modulator 2']],
  );
  assert.equal(select.value, ''); // the patch holds undefined

  select.value = '1';
  fire(select, 'change', { target: select });
  assert.equal(getPath(drum.patch, 'layers.0.modulators.0.modulates'), 1);
  assert.equal(edits.length, 1);
  assert.equal(edits[0], drum);

  select.value = '';
  fire(select, 'change', { target: select });
  assert.equal(getPath(drum.patch, 'layers.0.modulators.0.modulates'), undefined);
  assert.equal(edits.length, 2);
});

test('buildFmCard: a modulator block without ring / modulates fields shows an empty toggle row', () => {
  const { card } = makeCard(); // the kick body: one mod, no ring, no modulates
  const block = byClassAll(card, 'mod-block')[0];
  assert.equal(
    block.children.find((c) => c.className === 'card-toggles').children.length,
    0,
  );
  // The card itself carries no card-level toggle row anymore — every
  // toggle lives in its modulator's block (P5/S14).
  assert.equal(card.children.find((c) => c.className === 'card-toggles'), undefined);
});

// ---- buildFmCard: the wave shape groups (plan sinecontrol P3/S6) --

test('buildFmCard: a materialized kick body carries ONE card-level shape group and one per modulator block', () => {
  const layer = materializedKickBody();
  const drum = makeDrum(layer);
  const card = buildFmCard({ drum, layerIndex: 0, layer, identity: KICK_IDENTITY });

  const groups = byClassAll(card, 'shape-group');
  assert.equal(groups.length, 2, 'the carrier group + one per modulator');

  // The card-level (CARRIER) group lives in its own row under the
  // head: 4 glyph buttons + the live preview canvas, active = the
  // patch's carrier shape.
  const row = byClass(card, 'card-shape-row');
  assert.ok(row, 'the .card-shape-row under the head');
  assert.equal(row.children.length, 1, 'one group in the carrier row');
  const carrierGroup = row.children[0];
  assert.equal(carrierGroup.getAttribute('aria-label'), 'Source 1: wave shape');
  const buttons = carrierGroup.children.filter((c) => c.tagName === 'button');
  assert.deepEqual(
    buttons.map((b) => [b.textContent, b.getAttribute('aria-label')]),
    [['∿', 'sine'], ['□', 'square'], ['◺', 'saw'], ['△', 'triangle']],
    'four glyph buttons, each named for its shape',
  );
  assert.equal(buttons[0].className, 'btn active', 'active = the patch carrier shape (sine)');
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true');
  assert.equal(carrierGroup.children.at(-1).className, 'shape-preview');

  // The modulator's group sits in ITS block (with the other toggles),
  // starting on the patch's value.
  const block = byClassAll(card, 'mod-block')[0];
  const blockGroup = byClass(block, 'shape-group');
  assert.ok(blockGroup, 'the mod block carries its shape group');
  assert.equal(blockGroup.getAttribute('aria-label'), 'Source 1: modulator 1 shape');
  assert.equal(blockGroup.value, 'sine');
});

test('buildFmCard: clicking a shape button applies setPath on the right path, then fires onPatchEdit', () => {
  const layer = materializedKickBody();
  const drum = makeDrum(layer);
  const edits = [];
  const card = buildFmCard({
    drum, layerIndex: 0, layer, identity: KICK_IDENTITY,
    onPatchEdit: (d) => edits.push(d),
  });

  // The CARRIER group: click the square glyph.
  const carrierGroup = byClass(byClass(card, 'card-shape-row'), 'shape-group');
  const carrierButtons = carrierGroup.children.filter((c) => c.tagName === 'button');
  fire(carrierButtons[1], 'click'); // '□' square
  assert.equal(
    getPath(drum.patch, 'layers.0.carrier.shape'),
    'square',
    'the patch copy holds the carrier shape',
  );
  assert.equal(edits.length, 1);
  assert.equal(edits[0], drum);
  assert.equal(carrierButtons[1].getAttribute('aria-pressed'), 'true');

  // The MODULATOR group: click the saw glyph.
  const modGroup = byClass(byClass(card, 'mod-block'), 'shape-group');
  const modButtons = modGroup.children.filter((c) => c.tagName === 'button');
  fire(modButtons[2], 'click'); // '◺' saw
  assert.equal(
    getPath(drum.patch, 'layers.0.modulators.0.shape'),
    'saw',
    'the patch copy holds the modulator shape',
  );
  assert.equal(edits.length, 2);

  // Clicking the ACTIVE button is a no-op (the group's contract —
  // the readout-sync pass must not loop).
  fire(modButtons[2], 'click');
  assert.equal(edits.length, 2, 'no edit for the already-active shape');
});

test('buildFmCard: the shape groups appear in .controls with their paths (the readout-sync contract)', () => {
  const layer = materializedKickBody();
  const drum = makeDrum(layer);
  const card = buildFmCard({ drum, layerIndex: 0, layer, identity: KICK_IDENTITY });
  const byPath = Object.fromEntries(card.controls.map((c) => [c.path, c]));
  const carrier = byPath['layers.0.carrier.shape'];
  const mod = byPath['layers.0.modulators.0.shape'];
  assert.ok(carrier, 'the carrier group is in .controls');
  assert.ok(mod, 'the modulator group is in .controls');
  assert.equal(typeof carrier.el.setValue, 'function', 'the sync pass can drive it');
  assert.equal(carrier.el.value, 'sine', '... on the live patch value');
  assert.equal(mod.el.value, 'sine');
  // The carrier group comes first (before the knob grid entries).
  assert.equal(card.controls[0].path, 'layers.0.carrier.shape');
});

test('buildFmCard: a mod block rebuild re-creates its shape group with the live value', () => {
  const layer = {
    type: 'fm',
    carrier: { freq: 100, shape: 'sine' },
    modulators: [
      { freq: 300, index: 4, shape: 'saw' },
      { freq: 600, index: 2, shape: 'triangle' },
    ],
    levelEnv: levelEnv(0.005, 0.3),
    gain: 0.5,
  };
  const drum = makeDrum(layer);
  const card = buildFmCard({ drum, layerIndex: 0, layer, identity: { label: 'Source 1' } });

  const mod1Buttons = byClass(
    byClassAll(card, 'mod-block')[0], 'shape-group',
  ).children.filter((c) => c.tagName === 'button');
  assert.equal(mod1Buttons[2].getAttribute('aria-pressed'), 'true', 'mod 1 starts on its live shape (saw)');
  fire(mod1Buttons[1], 'click'); // '□' square
  assert.equal(drum.patch.layers[0].modulators[0].shape, 'square');

  // A structural rebuild re-derives the blocks from the LIVE patch:
  // the re-created group starts on the value the patch holds.
  card.rebuildModSection();
  const rebuilt = byClassAll(card, 'mod-block');
  assert.equal(rebuilt.length, 2, 'both blocks rebuilt');
  const rebuiltMod1 = byClass(rebuilt[0], 'shape-group');
  assert.equal(rebuiltMod1.value, 'square', 'the re-created group is on the live value');
  const buttons = rebuiltMod1.children.filter((c) => c.tagName === 'button');
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'true', 'the square glyph is active');
  // The other block's group kept its live value too.
  assert.equal(byClass(rebuilt[1], 'shape-group').value, 'triangle');
});

test('buildFmCard: a raw voice patch (no shape fields) builds NO shape groups — the row stays empty', () => {
  const { card } = makeCard(); // the raw kick body
  assert.equal(byClassAll(card, 'shape-group').length, 0, 'field-presence: no dead control');
  assert.equal(
    byClass(card, 'card-shape-row').children.length,
    0,
    'the row is empty (the CSS :empty hide shows nothing)',
  );
  assert.ok(!card.controls.some((c) => c.path.endsWith('.shape')), 'no shape entry in .controls');
});

test('buildFmCard: every shape group paints its preview canvas at build (clear + midline + trace)', () => {
  const layer = materializedKickBody();
  const drum = makeDrum(layer);
  const card = buildFmCard({ drum, layerIndex: 0, layer, identity: KICK_IDENTITY });
  const previews = byClassAll(card, 'shape-preview');
  assert.equal(previews.length, 2, 'one preview per shape group (carrier + modulator)');
  for (const canvas of previews) {
    // drawShapeWave (viz.js): one clearRect, the faint midline stroke,
    // then the one-period trace stroke — all coordinates finite (the
    // stub context throws on a NaN).
    const ctx = canvas.getContext('2d');
    const calls = ctx.calls;
    assert.equal(
      calls.filter((c) => c[0] === 'clearRect').length,
      1,
      'the preview is cleared before painting',
    );
    assert.equal(
      calls.filter((c) => c[0] === 'stroke').length,
      2,
      'midline + the one-period trace are stroked',
    );
    // The fixture drum carries no color yet: the card passes the brand
    // accent (plan "colors" S4 — the drum-hue case is the test below).
    const [mid, trace] = ctx.strokes;
    assert.equal(mid.strokeStyle, COLORS.grid, 'the midline keeps the grid tone');
    assert.equal(trace.strokeStyle, THEME.accent, 'the trace strokes the accent fallback');
    // The S10 faint fill under the trace: one vertical 0 -> H gradient
    // at 0.12 of the trace color fading to transparent (sentinel
    // identity), and no glow (the shadow language is the band's and
    // the env editor's, not the preview's).
    assert.equal(ctx.gradients.length, 1, 'the one gradient fill');
    assert.deepEqual(ctx.gradients[0].__gradient, [0, 0, 0, 24], 'vertical 0 -> H');
    assert.deepEqual(ctx.gradients[0].stops, [
      [0, withAlpha(THEME.accent, 0.12)],
      [1, withAlpha(THEME.accent, 0)],
    ], 'the fill fades 0.12 -> 0 of the trace color');
    assert.equal(ctx.fills.length, 1, 'exactly one fill (under the trace)');
    assert.equal(ctx.fills[0].fillStyle, ctx.gradients[0], 'the fill wears the gradient sentinel');
    assert.equal(ctx.shadowBlur, 0, 'no glow in the preview');
  }
});

test('buildFmCard: the shape previews stroke the drum hue (plan "colors" S4)', () => {
  const layer = materializedKickBody();
  const drum = makeDrum(layer);
  drum.color = DRUM_COLORS.snare; // the card closure reads drum.color at build
  const card = buildFmCard({ drum, layerIndex: 0, layer, identity: KICK_IDENTITY });
  const previews = byClassAll(card, 'shape-preview');
  assert.equal(previews.length, 2, 'carrier + modulator previews');
  for (const canvas of previews) {
    const ctx = canvas.getContext('2d');
    const [mid, trace] = ctx.strokes;
    assert.equal(mid.strokeStyle, COLORS.grid, 'the midline keeps the grid tone');
    assert.equal(trace.strokeStyle, DRUM_COLORS.snare, 'the trace wears the drum hue');
    assert.equal(trace.lineWidth, 2, 'the trace is the 2 px one-period line');
    // The S10 fill follows the passed color too: its gradient stops are
    // the drum hue at 0.12 -> 0 (the preview's fill inherits the hue,
    // like the band's S9 area fill).
    assert.equal(ctx.gradients.length, 1, 'the one gradient fill');
    assert.deepEqual(ctx.gradients[0].stops, [
      [0, withAlpha(DRUM_COLORS.snare, 0.12)],
      [1, withAlpha(DRUM_COLORS.snare, 0)],
    ], 'the fill fades 0.12 -> 0 of the drum hue');
    assert.equal(ctx.fills.length, 1, 'exactly one fill (under the trace)');
    assert.equal(ctx.fills[0].fillStyle, ctx.gradients[0], 'the fill wears the gradient sentinel');
  }
});

test('buildFmCard: the readout-sync pass over the real .controls list fires no onInput (loop safety)', () => {
  const layer = materializedKickBody();
  const drum = makeDrum(layer);
  const edits = [];
  const card = buildFmCard({
    drum, layerIndex: 0, layer, identity: KICK_IDENTITY,
    onPatchEdit: (d) => edits.push(d),
  });
  // main.js's syncCardReadouts, simulated on this card: re-set EVERY
  // control from the patch. Every control (knobs, the shape groups,
  // the fx knobs) already HOLDS the patch value at build, so the pass
  // must be a silent no-op: a setValue with the held value fires no
  // onInput (the knob/group commit contract, P1/S2-S3), so the pass
  // cannot loop back into updateDrum.
  for (const { el, path, descriptor } of card.controls)
    el.setValue(descriptorRead(descriptor, getPath(drum.patch, path)));
  assert.equal(edits.length, 0, 'the held-value sync pass fires no onInput');
  assert.equal(
    card.controls.find((c) => c.path === 'layers.0.carrier.shape').el.value,
    'sine',
    'the carrier group still holds the patch value after the pass',
  );
});

test('buildFmCard: clicking the head fires onWorking with the drum and the layer index', () => {
  const { card, drum, layer, workings } = makeCard();
  fire(byClass(card, 'card-head'), 'click');
  assert.equal(workings.length, 1);
  assert.equal(workings[0][0], drum);
  assert.equal(workings[0][1], 0);
  assert.ok(layer, 'fixture sanity');
});

// ---- buildFmCard: the dynamic modulator sub-section (plan P5/S14) --

// A minimal FM layer with the standard level envelope; the modulators
// are passed in (the same field-presence rule the engine's patches
// follow: ring / modulates / indexEnv only when a voice uses them).
const modLayer = (modulators, over = {}) => ({
  type: 'fm',
  carrier: { freq: 100 },
  modulators,
  levelEnv: levelEnv(0.005, 0.3),
  gain: 0.5,
  ...over,
});

const modBlocksOf = (card) => byClassAll(card, 'mod-block');

test('buildFmCard: the FM card carries a modulator sub-section — one .mod-block per modulator + the [+ mod] button', () => {
  const layer = modLayer([{ freq: 300, index: 4 }, { freq: 600, index: 2 }]);
  const drum = makeDrum(layer);
  const card = buildFmCard({ drum, layerIndex: 0, layer, identity: { label: 'Source 1' } });
  const modSection = byClass(card, 'mod-section');
  assert.ok(modSection, 'the .mod-section sub-section');
  assert.ok(card.children.includes(modSection), '... a direct child of the card');
  const blocks = modBlocksOf(card);
  assert.equal(blocks.length, 2, 'one .mod-block per modulator');
  const descriptors = describeLayer(layer, 0);
  const ofMod = (j) =>
    descriptors.filter((d) => d.path.startsWith(`layers.0.modulators.${j}.`));
  blocks.forEach((block, j) => {
    // Block head: the 1-based label + the per-block [✕].
    const head = block.children.find((c) => c.className === 'mod-head');
    assert.equal(head.children[0].className, 'mod-label');
    assert.equal(head.children[0].textContent, `modulator ${j + 1}`);
    assert.equal(head.children[1].className, 'mod-remove');
    assert.equal(head.children[1].textContent, '✕');
    // The block's knob grid: that modulator's OWN descriptors (the
    // factory's shadowing rules decide the set), in factory order.
    const grid = block.children.find((c) => c.className === 'knob-grid');
    assert.equal(grid.children.length, ofMod(j).length, `block ${j + 1}: one knob per own descriptor`);
    ofMod(j).forEach((d, k) => {
      const rotor = byClass(grid.children[k], 'knob-rotor');
      assert.equal(rotor.getAttribute('aria-label'), d.label);
    });
  });
  // The card-level knob grid holds only the non-modulator descriptors
  // (carrier / level / gain for this fixture).
  const cardGrid = card.children.find((c) => c.className === 'knob-grid');
  const nonMod = descriptors.filter((d) => !d.path.includes('.modulators.'));
  assert.equal(cardGrid.children.length, nonMod.length, 'the card grid holds the non-modulator knobs only');
  // The [+ mod] button: present, enabled (2 < 4).
  const add = byClass(card, 'mod-add');
  assert.equal(add.textContent, '+ mod');
  assert.equal(add.disabled, false);
  assert.ok(add.listeners['click'], 'the enabled button carries a handler');
});

test('buildFmCard: a zero-modulator FM card shows an empty mod section with the enabled [+ mod] (a plain sine)', () => {
  const layer = modLayer([]);
  const drum = makeDrum(layer);
  const card = buildFmCard({ drum, layerIndex: 0, layer, identity: { label: 'Source 1' } });
  const modSection = byClass(card, 'mod-section');
  assert.ok(modSection, 'the sub-section is present even with zero modulators');
  assert.equal(modBlocksOf(card).length, 0, 'no blocks');
  const add = byClass(card, 'mod-add');
  assert.equal(add.disabled, false, '[+ mod] is enabled at zero');
  assert.ok(add.listeners['click']);
});

test('buildFmCard: at 4 modulators (the engine\'s limit) [+ mod] is disabled and every block keeps its [✕]', () => {
  const layer = modLayer([
    { freq: 440, index: 5 },
    { freq: 880, index: 3 },
    { freq: 1760, index: 2 },
    { freq: 3520, index: 1 },
  ]);
  const drum = makeDrum(layer);
  const card = buildFmCard({ drum, layerIndex: 0, layer, identity: { label: 'Source 1' } });
  const add = byClass(card, 'mod-add');
  assert.equal(add.disabled, true, '[+ mod] is disabled at the engine\'s limit');
  assert.equal(add.listeners['click'], undefined, '... and carries no handler');
  const removes = byClassAll(card, 'mod-remove');
  assert.equal(removes.length, 4, 'one [✕] per block');
  removes.forEach((r) =>
    assert.ok(r.listeners['click'], 'every block keeps its removal (allowed down to zero)'));
});

test('buildFmCard: the last modulator keeps its [✕] (an FM layer may drop to zero — a plain sine)', () => {
  const layer = modLayer([{ freq: 440, index: 5 }]);
  const drum = makeDrum(layer);
  const card = buildFmCard({ drum, layerIndex: 0, layer, identity: { label: 'Source 1' } });
  const remove = byClass(card, 'mod-remove');
  assert.equal(remove.disabled, false, 'no last-mod guard (unlike the card\'s own [✕])');
  assert.ok(remove.listeners['click']);
});

test('buildFmCard: [+ mod] fires onModAdd(drum, layerIndex) and stops propagation', () => {
  const layer = modLayer([{ freq: 440, index: 5 }]);
  const drum = makeDrum(layer);
  const adds = [];
  const card = buildFmCard({
    drum,
    layerIndex: 0,
    layer,
    identity: { label: 'Source 1' },
    onModAdd: (d, i) => adds.push([d, i]),
  });
  const event = fire(byClass(card, 'mod-add'), 'click');
  assert.ok(event.stopped, 'the head\'s working-source click does not follow');
  assert.deepEqual(adds, [[drum, 0]]);
});

test('buildFmCard: a block [✕] fires onModRemove(drum, layerIndex, modIndex) and stops propagation', () => {
  const layer = modLayer([{ freq: 300, index: 4 }, { freq: 600, index: 2 }]);
  const drum = makeDrum(layer);
  const removes = [];
  const card = buildFmCard({
    drum,
    layerIndex: 0,
    layer,
    identity: { label: 'Source 1' },
    onModRemove: (d, i, j) => removes.push([d, i, j]),
  });
  const block2 = modBlocksOf(card)[1];
  const remove = block2.children.find((c) => c.className === 'mod-head')
    .children.find((c) => c.className === 'mod-remove');
  const event = fire(remove, 'click');
  assert.ok(event.stopped);
  assert.deepEqual(removes, [[drum, 0, 1]], 'the drum, the layer index, and the MODULATOR index');
});

test('buildFmCard: a modulator block\'s knobs live-bind to that modulator\'s paths', () => {
  const layer = modLayer([{ freq: 300, index: 4 }, { freq: 600, index: 2 }]);
  const drum = makeDrum(layer);
  const edits = [];
  const card = buildFmCard({
    drum,
    layerIndex: 0,
    layer,
    identity: { label: 'Source 1' },
    onPatchEdit: (d) => edits.push(d),
  });
  const block2 = modBlocksOf(card)[1];
  const freqRotor = byClass(
    block2.children.find((c) => c.className === 'knob-grid').children[0],
    'knob-rotor',
  );
  assert.equal(freqRotor.getAttribute('aria-label'), 'Source 1: modulator 2 freq (Hz)');
  fire(freqRotor, 'keydown', { key: 'ArrowUp' }); // 600 -> 601 Hz (step 1)
  assert.equal(drum.patch.layers[0].modulators[1].freq, 601, 'the edit landed on THAT modulator\'s path');
  assert.equal(drum.patch.layers[0].modulators[0].freq, 300, '... and not on the other modulator\'s');
  assert.equal(edits.length, 1);
  assert.equal(edits[0], drum);
});

test('buildFmCard: a ring modulator with no cascade target hides its index knob (dead-ring shadowing, end to end)', () => {
  const layer = modLayer([{ freq: 300, index: 4, ring: true }]); // no modulates, no indexEnv
  const drum = makeDrum(layer);
  const edits = [];
  const card = buildFmCard({
    drum,
    layerIndex: 0,
    layer,
    identity: { label: 'Source 1' },
    onPatchEdit: (d) => edits.push(d),
  });
  const block = modBlocksOf(card)[0];
  const labels = () => block.children
    .find((c) => c.className === 'knob-grid').children
    .map((k) => k.children.find((c) => c.className === 'knob-label').textContent);
  assert.deepEqual(
    labels(),
    ['modulator 1 freq (Hz)'],
    'the index knob is ABSENT for the dead ring (ring on, no target)',
  );
  // The ring group IS present (the field exists) — the block's only toggle.
  const toggles = block.children.find((c) => c.className === 'card-toggles');
  assert.equal(toggles.children.length, 1);
  assert.equal(toggles.children[0].className, 'button-group');
  // The group's VISIBLE caption drops the prefix; the group's
  // aria-label keeps the FULL label (plan ui3 P5/S1, the a11y split).
  assert.equal(
    toggles.children[0].children.find((c) => c.className === 'button-group-label').textContent,
    'modulator 1 ring',
  );
  assert.equal(toggles.children[0].getAttribute('aria-label'), 'Source 1: modulator 1 ring');
  const buttons = toggles.children[0].children.filter((c) => c.tagName === 'button');
  assert.equal(buttons.find((b) => b.getAttribute('aria-pressed') === 'true').textContent, 'on');

  // Toggling ring off is a VALUE edit — the block stays in place (no
  // rebuild), the patch flips, onPatchEdit fires.
  fire(buttons.find((b) => b.textContent === 'off'), 'click');
  assert.equal(drum.patch.layers[0].modulators[0].ring, false, 'the patch holds the flipped value');
  assert.equal(edits.length, 1);
  assert.deepEqual(
    labels(),
    ['modulator 1 freq (Hz)'],
    '... and a plain value edit does NOT rebuild the block',
  );

  // The next STRUCTURAL rebuild brings the index knob back (no indexEnv).
  drum.patch = addModulator(drum.patch, 0);
  card.rebuildModSection();
  const rebuilt = modBlocksOf(card)[0];
  assert.deepEqual(
    rebuilt.children.find((c) => c.className === 'knob-grid').children
      .map((k) => k.children.find((c) => c.className === 'knob-label').textContent),
    ['modulator 1 freq (Hz)', 'modulator 1 index'],
    'ring off + no indexEnv: the index knob is back after the rebuild',
  );
});

test('buildFmCard: a ring modulator WITH an indexEnv never shows the constant index knob — the env shadows it, ring on or off', () => {
  const layer = modLayer([{
    freq: 300,
    index: 4,
    ring: true,
    indexEnv: [{ t: 0, v: 4 }, { t: 0.02, v: 0 }],
  }]);
  const drum = makeDrum(layer);
  const card = buildFmCard({ drum, layerIndex: 0, layer, identity: { label: 'Source 1' } });
  const knobLabels = (block) => block.children
    .find((c) => c.className === 'knob-grid').children
    .map((k) => k.children.find((c) => c.className === 'knob-label').textContent);
  assert.deepEqual(
    knobLabels(modBlocksOf(card)[0]),
    [
      'modulator 1 freq (Hz)',
      'modulator 1 FM index',
      'modulator 1 FM decay (s)',
      'modulator 1 FM index end',
    ],
    'the indexEnv shadows the constant index (ring on)',
  );
  // Ring off + a structural rebuild: STILL no constant index knob —
  // "toggling ring off brings the index knob back ONLY if no indexEnv".
  drum.patch.layers[0].modulators[0].ring = false;
  drum.patch = addModulator(drum.patch, 0);
  card.rebuildModSection();
  assert.deepEqual(
    knobLabels(modBlocksOf(card)[0]),
    [
      'modulator 1 freq (Hz)',
      'modulator 1 FM index',
      'modulator 1 FM decay (s)',
      'modulator 1 FM index end',
    ],
    'the env keeps shadowing after the rebuild (no index knob)',
  );
});

test('buildFmCard: the cascade select offers none + the other modulators (excluding itself) and writes modulators.N.modulates', () => {
  const layer = modLayer([
    { freq: 440, index: 5 }, // no modulates field -> no select
    { freq: 880, index: 3, modulates: undefined },
    { freq: 1760, index: 2 },
    { freq: 3520, index: 1 },
  ]);
  const drum = makeDrum(layer);
  const edits = [];
  const card = buildFmCard({
    drum,
    layerIndex: 0,
    layer,
    identity: { label: 'Source 1' },
    onPatchEdit: (d) => edits.push(d),
  });
  const blocks = modBlocksOf(card);
  assert.equal(byClass(blocks[0], 'select-input'), null, 'no select for a field the patch does not carry');
  const select = byClass(blocks[1], 'select-input');
  // The select's VISIBLE caption drops the prefix; the select's own
  // aria-label keeps the FULL label (plan ui3 P5/S1, the a11y split).
  assert.equal(byClass(blocks[1], 'select-label').textContent, 'modulator 2 target');
  assert.equal(select.getAttribute('aria-label'), 'Source 1: modulator 2 target');
  assert.deepEqual(
    select.children.map((o) => [o.value, o.textContent]),
    [
      ['', 'none'],
      ['0', 'modulator 1'],
      ['2', 'modulator 3'],
      ['3', 'modulator 4'],
    ],
    'none + every OTHER modulator, 1-based, excluding itself (the describeToggles helper learns the count)',
  );
  select.value = '0';
  fire(select, 'change', { target: select });
  assert.equal(getPath(drum.patch, 'layers.0.modulators.1.modulates'), 0, 'modulator 2 now targets modulator 1');
  assert.equal(edits.length, 1);
  // The cascade changes the rendered sound (property assertion — the
  // two renders differ, never a full-equality match).
  const cascaded = renderPatch(drum.patch, { sampleRate: 8000, duration: 0.5 });
  const flat = structuredClone(drum.patch);
  flat.layers[0].modulators[1].modulates = undefined;
  const uncascaded = renderPatch(flat, { sampleRate: 8000, duration: 0.5 });
  let differs = false;
  for (let n = 0; n < cascaded.length; n++)
    if (cascaded[n] !== uncascaded[n]) { differs = true; break; }
  assert.ok(differs, 'the cascaded render differs from the non-cascaded render');
});

test('buildFmCard: removing one of two modulators rebuilds the blocks — the survivor keeps its position and values', () => {
  const layer = modLayer([{ freq: 300, index: 4 }, { freq: 600, index: 2 }]);
  const drum = makeDrum(layer);
  const card = buildFmCard({ drum, layerIndex: 0, layer, identity: { label: 'Source 1' } });
  const survivor = drum.patch.layers[0].modulators[1];
  const blocks = modBlocksOf(card);
  const survivorGrid = blocks[1].children.find((c) => c.className === 'knob-grid');
  assert.equal(
    byClass(survivorGrid.children[0], 'knob-rotor').getAttribute('aria-valuenow'),
    '600',
    'fixture: the survivor starts at 600 Hz in block 2',
  );
  // The removal through the real op + the card's rebuild (main.js's
  // onModRemove wiring, mirrored here).
  drum.patch = removeModulator(drum.patch, 0, 0);
  card.rebuildModSection();
  const blocks2 = modBlocksOf(card);
  assert.equal(blocks2.length, 1, 'down to one block');
  assert.equal(
    blocks2[0].children.find((c) => c.className === 'mod-head').children[0].textContent,
    'modulator 1',
    'the survivor takes the FIRST block position',
  );
  const rotor2 = byClass(
    blocks2[0].children.find((c) => c.className === 'knob-grid').children[0],
    'knob-rotor',
  );
  assert.equal(rotor2.getAttribute('aria-valuenow'), '600', 'the survivor keeps its value');
  assert.equal(
    drum.patch.layers[0].modulators[0],
    survivor,
    'the surviving modulator object carried over by reference (clone-first)',
  );
  // The single-modulator select is gone (no other modulator to cascade into).
  assert.equal(byClassAll(card, 'select-input').length, 0);
  // [+ mod] is enabled again (1 < 4).
  assert.equal(byClass(card, 'mod-add').disabled, false);
});

// ---- buildNoiseCard: the noise source card (plan P4/S9) -------------

// A noise layer with the legacy 4-point level envelope (the engine
// applies levelEnv to noise too; the DAHDSR knob transforms normalize
// it, P3/S2): its descriptor set is seed / cutoff / decay / the nine
// DAHDSR level knobs / gain.
const noiseLayer = (over = {}) => ({
  type: 'noise',
  seed: 1,
  cutoff: 2000,
  decay: 0.02,
  levelEnv: levelEnv(0.005, 0.2),
  gain: 0.5,
  ...over,
});

// The identity label is deliberately NOT "Source 1" (its array
// position) — the card must show the passed-in label, never compute
// its own number (the same guard as the FM card's fixture).
const NOISE_IDENTITY = { label: 'Source 2' };

const makeNoiseCard = (overrides = {}) => {
  const layer = noiseLayer();
  const drum = makeDrum(layer);
  const edits = [];
  const card = buildNoiseCard({
    drum,
    layerIndex: 0,
    layer,
    identity: NOISE_IDENTITY,
    onPatchEdit: (d) => edits.push(d),
    ...overrides,
  });
  return { card, drum, layer, edits };
};

test('buildNoiseCard: the knob count matches describeLayer (seed / cutoff / decay / the nine DAHDSR level knobs / gain)', () => {
  const { card, layer } = makeNoiseCard();
  const descriptors = describeLayer(layer, 0);
  assert.deepEqual(
    descriptors.map((d) => d.path),
    [
      'layers.0.seed',
      'layers.0.cutoff',
      'layers.0.decay',
      'layers.0.levelEnv', // ×9 — the DAHDSR knobs share the one path (P3/S2)
      'layers.0.levelEnv',
      'layers.0.levelEnv',
      'layers.0.levelEnv',
      'layers.0.levelEnv',
      'layers.0.levelEnv',
      'layers.0.levelEnv',
      'layers.0.levelEnv',
      'layers.0.levelEnv',
      'layers.0.gain',
    ],
    'the factory emits exactly these for a noise layer with a levelEnv',
  );
  const knobs = byClass(card, 'knob-grid').children;
  assert.equal(knobs.length, descriptors.length, 'one knob per numeric descriptor');
  descriptors.forEach((d, i) => {
    const rotor = byClass(knobs[i], 'knob-rotor');
    assert.ok(rotor, `knob ${i} (${d.path}) is missing its rotor`);
    assert.equal(rotor.getAttribute('aria-label'), d.label);
    assert.equal(rotor.getAttribute('aria-valuemin'), String(d.min));
    assert.equal(rotor.getAttribute('aria-valuemax'), String(d.max));
  });
});

test('buildNoiseCard: the seed knob has integer step 1 (the deterministic PRNG seed)', () => {
  const { card, drum } = makeNoiseCard();
  const rotor = byClass(byClass(card, 'knob-grid').children[0], 'knob-rotor');
  assert.equal(rotor.getAttribute('aria-label'), 'Source 1: seed');
  assert.equal(rotor.getAttribute('aria-valuemin'), '1');
  assert.equal(rotor.getAttribute('aria-valuemax'), '999');
  // Behavior: one keyboard step moves the patch exactly +1 — integer
  // on the step-1 grid (a fractional seed would silently re-shape the
  // deterministic transient, src/lib/noise.js).
  fire(rotor, 'keydown', { key: 'ArrowUp' }); // 1 -> 2
  assert.equal(drum.patch.layers[0].seed, 2, 'seed 1 -> 2 on one step');
  fire(rotor, 'keydown', { key: 'ArrowUp' }); // 2 -> 3
  fire(rotor, 'keydown', { key: 'PageUp' }); // the x10 big step = +10
  assert.equal(drum.patch.layers[0].seed, 13, 'seed steps stay integer (+1, then +10)');
});

test('buildNoiseCard: no ring / modulates controls and no modulator sub-section (a noise layer carries neither)', () => {
  const { card } = makeNoiseCard();
  // The ONLY button group on the card is the fx type group (P6/S15) —
  // a noise layer has no modulators, so no ring on/off groups.
  const groups = byClassAll(card, 'button-group');
  assert.equal(groups.length, 1, 'no ring button groups — the fx type group only');
  assert.equal(
    groups[0].children.filter((c) => c.tagName === 'button').length,
    4,
    '... and it carries the four fx types',
  );
  assert.equal(byClass(card, 'select-input'), null, 'no cascade-target selects');
  assert.equal(byClass(card, 'card-toggles'), null, 'no toggle row at all');
  assert.equal(byClass(card, 'mod-section'), null, 'no modulator sub-section');
  assert.equal(byClass(card, 'mod-add'), null, 'no [+ mod] button');
  assert.equal(card.rebuildModSection, undefined, 'no structural rebuild hook');
});

test('buildNoiseCard: the badge says NOISE and the head shows the identity label passed in', () => {
  const { card } = makeNoiseCard(); // identity 'Source 2' at layerIndex 0
  const headText = textOf(byClass(card, 'card-head'));
  assert.equal(
    textOf(byClass(card, 'card-title')),
    'Source 2',
    'the title IS the identity label — no doubled prefix (the CSS uppercases it)',
  );
  assert.ok(headText.includes('Source 2'), 'the passed-in label');
  assert.ok(
    !headText.includes('Source 1'),
    'the head must not compute its number from layerIndex',
  );
  assert.ok(headText.includes('NOISE'), 'the [NOISE] type badge');
  assert.ok(!headText.includes('FM'), 'and no [FM] badge');
});

test('buildNoiseCard: the [✕] follows the same last-source guard and onRemove wiring', () => {
  const layer = noiseLayer();
  const other = kickPatch().layers[0];
  const drum = {
    name: 'test',
    duration: 0.5,
    patch: { layers: [layer, other], masterEffects: [] },
  };
  const removes = [];
  const card = buildNoiseCard({
    drum,
    layerIndex: 0,
    layer,
    identity: NOISE_IDENTITY,
    onRemove: (d, i) => removes.push([d, i]),
  });
  const remove = byClass(card, 'card-remove');
  assert.equal(remove.disabled, false, 'two sources: the [✕] is enabled');
  fire(remove, 'click');
  assert.deepEqual(removes, [[drum, 0]], 'onRemove got the drum and the layer index');
  // A single-layer drum (makeDrum's shape): disabled, no handler.
  const { card: solo } = makeNoiseCard();
  const soloRemove = byClass(solo, 'card-remove');
  assert.equal(soloRemove.disabled, true, 'one source left: the [✕] is disabled');
  assert.equal(soloRemove.listeners['click'], undefined, '... and carries no handler');
});

test('buildNoiseCard: every readout shows the live patch value (getPath, not a private copy)', () => {
  const { card, drum, layer } = makeNoiseCard();
  const descriptors = describeLayer(layer, 0);
  const knobs = byClass(card, 'knob-grid').children;
  descriptors.forEach((d, i) => {
    const readout = byClass(knobs[i], 'knob-value');
    // The readout shows the descriptor READ of the raw value (the
    // level knobs' raw value is the whole point array, P3/S2).
    assert.equal(
      readout.textContent,
      formatKnobValue(descriptorRead(d, getPath(drum.patch, d.path)), d),
      `readout for ${d.path}`,
    );
  });
});

test('buildNoiseCard: .controls lists exactly the describeLayer descriptors (the readout-sync contract)', () => {
  const { card, drum, layer } = makeNoiseCard();
  const expected = describeLayer(layer, 0);
  assert.equal(card.controls.length, expected.length, 'one entry per descriptor');
  expected.forEach((d, i) => {
    assert.equal(card.controls[i].path, d.path, `control ${i} carries the descriptor's path`);
    // The control holds the descriptor READ of the live value (the
    // level knobs' raw value is the whole point array, P3/S2).
    assert.equal(card.controls[i].el.value, descriptorRead(d, getPath(drum.patch, d.path)),
      `control ${i} starts on the live patch value`);
  });
});

test('buildNoiseCard: turning a knob applies setPath to the live patch, then fires onPatchEdit', () => {
  const { card, drum, edits } = makeNoiseCard();
  const cutoffRotor = byClass(byClass(card, 'knob-grid').children[1], 'knob-rotor');
  fire(cutoffRotor, 'keydown', { key: 'ArrowUp' }); // 2000 -> 2001 Hz (step 1)
  assert.equal(edits.length, 1);
  assert.equal(edits[0], drum, 'onPatchEdit receives the drum');
  assert.equal(drum.patch.layers[0].cutoff, 2001, 'the patch holds the knob\'s new value');
});

test('buildNoiseCard: an FM layer is not a noise card (buildFmCard is its builder)', () => {
  const layer = kickPatch().layers[0];
  assert.throws(
    () => buildNoiseCard({
      drum: makeDrum(layer),
      layerIndex: 0,
      layer,
      identity: { label: 'Source 1' },
    }),
    /needs a "noise" layer/,
  );
});

test('buildNoiseCard: a missing identity label throws (the card never numbers itself)', () => {
  const layer = noiseLayer();
  assert.throws(
    () => buildNoiseCard({ drum: makeDrum(layer), layerIndex: 0, layer }),
    /needs an identity/,
  );
});

// ---- Per-card envelope preview + modal open (plan "dahdsr" P4/S1) ---
//
// The old free-form point editor (drag / click-insert / double-click-
// remove) is RETIRED with the constrained DAHDSR editor: the card
// keeps a live DISPLAY-ONLY preview of the selected envelope (plus the
// kind select), and a click on the preview opens the full-screen
// modal (src/app/env-modal.js — main.js wires the click). The
// interactive math (envMaps / hitTestEnv / dragEnv / drawEnv /
// wireEnvEditor) is tested in test/env-editor.test.mjs and
// test/env-modal.test.mjs; here: the card side — option generation
// (the new pitch option, field-presence rule), section structure, the
// display-only contract (no pointer listeners, the click-to-open
// callback), and the preserved envEditor element API.

test('cardEnvelopeOptions: a kick-body FM layer offers [level, pitch, modulator 1 FM depth]', () => {
  const layer = kickPatch().layers[0];
  assert.deepEqual(cardEnvelopeOptions(layer, 0), [
    { kind: 'level', path: 'layers.0.levelEnv', label: 'level' },
    { kind: 'pitch', path: 'layers.0.pitchEnv', label: 'pitch' },
    { kind: 'fm depth', path: 'layers.0.modulators.0.indexEnv', label: 'modulator 1 FM depth' },
  ]);
});

test('cardEnvelopeOptions: the pitch option appears exactly when the pitchEnv field exists (field-presence rule)', () => {
  // The kick body carries a pitchEnv (100 -> 50 Hz) -> the option is
  // offered (the modal's kind select gains pitch — plan P4/S11's band
  // editing is replaced by the modal's pitch kind).
  const kickBody = kickPatch().layers[0];
  assert.ok(kickBody.pitchEnv, 'fixture sanity: the kick body has a pitchEnv');
  assert.ok(
    cardEnvelopeOptions(kickBody, 0).some((o) => o.kind === 'pitch'),
    'offered when the field exists',
  );
  // Delete the field -> the option disappears (the "add pitch env"
  // button recreates it; the option then appears via refresh).
  const { pitchEnv: _gone, ...noPitch } = kickBody;
  assert.ok(
    !cardEnvelopeOptions(noPitch, 0).some((o) => o.kind === 'pitch'),
    'absent when the field is gone',
  );
  // A hi-hat partial (no pitchEnv, no modulators) -> level only.
  const hat = hihatPatch().layers[3];
  assert.equal(hat.pitchEnv, undefined, 'fixture sanity: the partial has no pitchEnv');
  assert.deepEqual(cardEnvelopeOptions(hat, 3), [
    { kind: 'level', path: 'layers.3.levelEnv', label: 'level' },
  ]);
});

test('cardEnvelopeOptions: a noise layer with a levelEnv offers [level] (the engine applies levelEnv to noise too)', () => {
  const layer = noiseLayer();
  assert.deepEqual(cardEnvelopeOptions(layer, 1), [
    { kind: 'level', path: 'layers.1.levelEnv', label: 'level' },
  ]);
});

test('cardEnvelopeOptions: one fm-depth option per modulator that HAS an indexEnv, labeled 1-based', () => {
  const layer = {
    type: 'fm',
    carrier: { freq: 100 },
    modulators: [
      { freq: 200, index: 1 }, // no indexEnv -> no option
      { freq: 400, index: 2, indexEnv: [{ t: 0, v: 2 }, { t: 0.02, v: 0 }] },
      { freq: 800, index: 3, indexEnv: [{ t: 0, v: 3 }, { t: 0.03, v: 0 }] },
    ],
    levelEnv: levelEnv(0.005, 0.3),
    gain: 0.5,
  };
  assert.deepEqual(cardEnvelopeOptions(layer, 2), [
    { kind: 'level', path: 'layers.2.levelEnv', label: 'level' },
    { kind: 'fm depth', path: 'layers.2.modulators.1.indexEnv', label: 'modulator 2 FM depth' },
    { kind: 'fm depth', path: 'layers.2.modulators.2.indexEnv', label: 'modulator 3 FM depth' },
  ]);
});

test('cardEnvelopeOptions: a layer with neither field (the kick noise click) offers nothing', () => {
  const layer = kickPatch().layers[1];
  assert.equal(layer.levelEnv, undefined, 'fixture sanity: the click has no levelEnv');
  assert.deepEqual(cardEnvelopeOptions(layer, 1), []);
});

test('cardEnvelopeOptions: an unknown layer type throws, mirroring the other card factories', () => {
  assert.throws(() => cardEnvelopeOptions({ type: 'sine' }, 0), /unknown layer type/);
});

// ---- per-card envelope preview: the card section ----------------------

// The preview section's className carries two classes ('card-env'
// [+ 'hidden']), so the exact-match byClass cannot find it — the
// section is a DIRECT child of the card, matched by prefix.
const envSectionOf = (card) =>
  card.children.find((c) => String(c.className).startsWith('card-env'));

const envCanvasOf = (card) => {
  const env = envSectionOf(card);
  return env ? env.children.find((c) => c.tagName === 'canvas') : null;
};

const envSelectOf = (card) => {
  const env = envSectionOf(card);
  return env ? env.children.find((c) => c.tagName === 'select') : null;
};

// The kick body's LEVEL preview geometry (the fixture the paint tests
// use): the canvas is 320×120, the shared viz margins leave a 94 px
// plot, the drum's 0.5 s duration spans the width (tToX = t * 640),
// and the level kind's value scale is the fixed 0…1 (vToY(v) =
// PAD_TOP + (1 - v) * 94). The kick's canonical 6-point levelEnv
// (levelEnvelope(attack 0.005, decay 0.3, decayCurve KNEE_CURVE):
// (0,0) (0,0) (0.005,1) (0.005,1,curve:0.55) (0.305,0) (0.305,0) —
// the zero delay/hold/release spans as duplicate-t points, whose
// anchors overlap visually) gives the role-anchor x positions below;
// the three bend dots sit on the curve at their segments' midpoints.
const LEVEL_ANCHOR_X = [0, 0, 3.2, 3.2, 195.2, 195.2];
const levelVToY = (v) => PAD_TOP + (1 - v) * (120 - PAD_TOP - PAD_BOTTOM);
const levelEnvPoints = (drum) => getPath(drum.patch, 'layers.0.levelEnv');

test('initCardEnvelopeEditor: the built card offers its options in the kind select (pitch included)', () => {
  const { card } = makeCard(); // the kick body
  const select = envSelectOf(card);
  assert.ok(select, 'the preview section holds the kind select');
  assert.deepEqual(
    select.children.map((o) => o.textContent),
    ['level', 'pitch', 'modulator 1 FM depth'],
    'the kick body card offers exactly [level, pitch, modulator 1 FM depth]',
  );
  const canvas = envCanvasOf(card);
  assert.equal(canvas.width, 320, 'the per-card canvas is 320 px wide');
  assert.equal(canvas.height, 120, 'the per-card canvas is 120 px tall');
  // The hihat partial card (no indexEnv, no pitchEnv) and the noise
  // card offer only level.
  const hat = hihatPatch();
  const hatCard = buildFmCard({
    drum: { name: 'hihat', duration: 0.3, patch: hat },
    layerIndex: 3,
    layer: hat.layers[3],
    identity: { label: 'Source 4' },
  });
  assert.deepEqual(envSelectOf(hatCard).children.map((o) => o.textContent), ['level']);
  const noiseCard = makeNoiseCard().card;
  assert.deepEqual(envSelectOf(noiseCard).children.map((o) => o.textContent), ['level']);
});

test('initCardEnvelopeEditor: a source with no editable envelope keeps an inert [env] button', () => {
  const kick = kickPatch(); // the noise click has no levelEnv (no options)
  const drum = { name: 'kick', duration: 0.5, patch: kick };
  const card = buildNoiseCard({
    drum,
    layerIndex: 1,
    layer: kick.layers[1],
    identity: { label: 'Source 2' },
  });
  assert.equal(envSectionOf(card), undefined, 'no preview section is built');
  assert.equal(card.envEditor, undefined, 'no envEditor handle for the sync pass');
  assert.deepEqual(
    Object.keys(byClass(card, 'card-env-btn').listeners),
    [],
    'the [env] button stays inert (no control for a field the patch does not carry)',
  );
});

test('initCardEnvelopeEditor: the preview is DISPLAY-ONLY — no pointer gestures, the click opens the modal', () => {
  const { card, drum } = makeCard({ onEnvOpen: () => {} });
  const canvas = envCanvasOf(card);
  // The old editor's gesture surface is gone: no pointer handlers at
  // all (the constrained core's displayOnly mode attaches none).
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dblclick'])
    assert.equal(canvas.listeners[type], undefined, `no ${type} listener on the display-only preview`);
  // The sole affordance: the click that opens the modal, with a
  // pointer cursor and an aria/title affordance.
  assert.ok(Array.isArray(canvas.listeners.click), 'a click listener opens the modal');
  assert.equal(canvas.style.cursor, 'pointer', 'the cursor advertises the click');
  assert.equal(canvas.attributes['aria-label'], 'envelope preview');
  assert.equal(canvas.attributes.title, 'open the envelope editor');

  const opened = [];
  const card2 = buildFmCard({
    drum,
    layerIndex: 0,
    layer: kickPatch().layers[0],
    identity: KICK_IDENTITY,
    onEnvOpen: (d, i, kindPath) => opened.push([d, i, kindPath]),
  });
  fire(envCanvasOf(card2), 'click');
  assert.equal(opened.length, 1, 'the click fired onEnvOpen once');
  assert.equal(opened[0][0], drum, 'onEnvOpen receives the drum');
  assert.equal(opened[0][1], 0, '… the layer index');
  assert.equal(opened[0][2], 'layers.0.levelEnv', '… and the selected kind path (level by default)');
  void card;
});

test('initCardEnvelopeEditor: the selected kind is what the preview click opens', () => {
  const drum = { name: 'kick', duration: 0.5, patch: kickPatch() };
  const layer = drum.patch.layers[0];
  const opened = [];
  const card = buildFmCard({
    drum,
    layerIndex: 0,
    layer,
    identity: KICK_IDENTITY,
    onEnvOpen: (d, i, kindPath) => opened.push(kindPath),
  });
  const select = envSelectOf(card);
  select.value = '1'; // the kick body's pitch option
  fire(select, 'change');
  assert.equal(opened.length, 0, 'the kind change itself opens nothing (it edits nothing)');
  fire(envCanvasOf(card), 'click');
  assert.deepEqual(opened, ['layers.0.pitchEnv'], 'the click opens the SELECTED kind');
});

test('initCardEnvelopeEditor: open at build (painted from the patch), the [env] button collapses and re-expands it', () => {
  const { card, drum } = makeCard();
  const env = envSectionOf(card);
  const canvas = envCanvasOf(card);
  const ctx = canvas.getContext('2d');
  const envBtn = byClass(card, 'card-env-btn');

  // Open at build: the volume (level) envelope is the visible default
  // and the first paint comes from the patch — the background, the
  // time axis, the fixed 0…1 value labels ('1' / '0'), the curve
  // stroke, one handle per role anchor (6) and one hollow bend dot per
  // bend segment (3). The button advertises the collapse.
  assert.equal(env.className, 'card-env', 'the section is visible at build');
  assert.equal(envBtn.textContent, 'env ▴', 'the button affordance offers the collapse');
  assert.ok(ctx.calls.some(([m, x, y, w, h]) => m === 'fillRect' && x === 0 && y === 0 && w === 320 && h === 120), 'the background fill');
  const labels = ctx.calls.filter(([m, t, x, y]) => m === 'fillText' && x === 4 && y <= PAD_TOP + 10).map(([, t]) => t);
  assert.deepEqual(labels, ['1'], 'the top value label (the fixed 0…1 scale)');
  const bottomLabels = ctx.calls.filter(([m, t, x, y]) => m === 'fillText' && x === 4 && y > PAD_TOP + 10).map(([, t]) => t);
  assert.deepEqual(bottomLabels, ['0'], 'the bottom value label');
  const arcs = ctx.calls.filter(([m]) => m === 'arc');
  assert.equal(arcs.length, 9, '6 role-anchor handles + 3 bend dots');
  const anchorArcs = arcs.slice(0, 6);
  assert.deepEqual(
    anchorArcs.map(([m, x, y]) => [x, y]),
    LEVEL_ANCHOR_X.map((x, i) => [x, levelVToY([0, 0, 1, 1, 0, 0][i])]),
    'the role anchors sit at the canonical points (tToX / vToY)',
  );
  // The bend dots: on the curve at each bend segment's midpoint —
  // segment 1's linear midpoint (0.5), segment 3's KNEE_CURVE-bent
  // midpoint, segment 4's zero-length rule (the later point's value).
  const pts = levelEnvPoints(drum);
  const dotArcs = arcs.slice(6);
  assert.deepEqual(
    dotArcs.map(([m, x, y]) => [x, y]),
    [1, 3, 4].map((i) => [
      ((pts[i].t + pts[i + 1].t) / 2) * (320 / 0.5),
      levelVToY(segmentMidValue(pts, i)),
    ]),
    'the bend dots sit at the segment midpoints (segmentMidValue)',
  );

  // Collapsing: the button flips back and a collapsed redraw no-ops.
  fire(envBtn, 'click');
  assert.equal(env.className, 'card-env hidden', 'the section is hidden');
  assert.equal(envBtn.textContent, 'env ▾');
  const n = ctx.calls.length;
  card.envEditor.redraw();
  assert.equal(ctx.calls.length, n, 'no paint while collapsed');

  // Re-expanding repaints from the patch.
  fire(envBtn, 'click');
  assert.equal(env.className, 'card-env', 'the section is visible again');
  assert.equal(envBtn.textContent, 'env ▴');
  assert.ok(ctx.calls.length > n, 'the section repaints when (re)shown');
  assert.ok(drum, 'fixture sanity');
});

test('initCardEnvelopeEditor: the curve and handles wear the drum hue (plan "colors" S4)', () => {
  // No color yet: the brand-accent fallback (the preview re-reads
  // drum.color on every redraw — the live-patch contract).
  {
    const { card } = makeCard();
    const ctx = envCanvasOf(card).getContext('2d');
    const curve = ctx.strokes.find((s) => s.lineWidth === 2);
    assert.ok(curve, 'the 2 px curve stroke is painted');
    assert.equal(curve.strokeStyle, THEME.accent, 'the curve strokes the accent fallback');
    // Fills: the area gradient, then one anchor fill per role anchor
    // (6) in the hue, then one bend-dot fill (3) in the background
    // tone (the hollow look).
    assert.equal(ctx.fills.length, 10, 'the area fill + 6 anchor fills + 3 bend-dot fills');
    assert.ok(ctx.fills[0].fillStyle.__gradient, 'the first fill is the area gradient');
    assert.ok(
      ctx.fills.slice(1, 7).every((f) => f.fillStyle === THEME.accent),
      'the role anchors fill the accent fallback',
    );
    assert.ok(
      ctx.fills.slice(7).every((f) => f.fillStyle === COLORS.bg),
      'the bend dots fill the background tone (hollow)',
    );
    // The anchor rings keep the background tone, the bend-dot rings
    // wear the hue (only the dot OUTLINE carries the color).
    const rings = ctx.strokes.filter((s) => s.lineWidth === 1.5);
    assert.equal(rings.length, 9, 'one ring stroke per handle + dot');
    assert.ok(rings.slice(0, 6).every((s) => s.strokeStyle === COLORS.bg), 'the anchor rings keep the bg tone');
    assert.ok(rings.slice(6).every((s) => s.strokeStyle === THEME.accent), 'the dot rings wear the accent');
  }
  // The drum's hue: curve + anchors in one hue (the snare's orange).
  // The color is set BEFORE the build — the preview is open at build,
  // so the first paint already wears it (nothing to expand).
  {
    const layer = kickPatch().layers[0];
    const drum = makeDrum(layer);
    drum.color = DRUM_COLORS.snare;
    const card = buildFmCard({ drum, layerIndex: 0, layer, identity: KICK_IDENTITY });
    const ctx = envCanvasOf(card).getContext('2d');
    const curve = ctx.strokes.find((s) => s.lineWidth === 2);
    assert.equal(curve.strokeStyle, DRUM_COLORS.snare, 'the curve wears the drum hue');
    assert.equal(ctx.fills.length, 10, 'the area fill + 6 anchor fills + 3 dot fills');
    assert.ok(ctx.fills[0].fillStyle.__gradient, 'the first fill is the area gradient');
    assert.ok(
      ctx.fills.slice(1, 7).every((f) => f.fillStyle === DRUM_COLORS.snare),
      'the role anchors fill the drum hue',
    );
  }
});

test('initCardEnvelopeEditor: the area fill under the curve and the handles\' halo (plan "colors" S10)', () => {
  // The color is set before the build — the preview is open at build,
  // so the single recorded paint already wears the drum hue.
  const layer = kickPatch().layers[0];
  const drum = makeDrum(layer);
  drum.color = DRUM_COLORS.snare;
  const card = buildFmCard({ drum, layerIndex: 0, layer, identity: KICK_IDENTITY });
  const ctx = envCanvasOf(card).getContext('2d');
  const W = 320;
  const H = 120;
  const calls = ctx.calls;

  // The area fill: one vertical 0 -> H gradient in the drum hue at
  // 0.15 -> 0 (the S9 pattern, the S10 alpha), worn by the FIRST
  // fill and painted right after the 2 px curve stroke (nothing else
  // strokes between them).
  assert.equal(ctx.gradients.length, 1, 'one gradient (the area fill)');
  const [grad] = ctx.gradients;
  assert.deepEqual(grad.__gradient, [0, 0, 0, H], 'vertical 0 -> H');
  assert.deepEqual(grad.stops, [
    [0, withAlpha(DRUM_COLORS.snare, 0.15)],
    [1, withAlpha(DRUM_COLORS.snare, 0)],
  ], 'the fill fades 0.15 -> 0 of the drum hue');
  assert.equal(ctx.fills.length, 10, 'the area fill + 6 anchor fills + 3 dot fills');
  const [area] = ctx.fills;
  assert.equal(area.fillStyle, grad, 'the area fill wears the gradient sentinel');
  const curve = ctx.strokes.find((s) => s.lineWidth === 2);
  // The area's top edge is the curve's own vertices, then the plot's
  // bottom corners.
  assert.equal(area.pts.length, curve.pts.length + 2, 'top edge + two bottom corners');
  for (let i = 0; i < curve.pts.length; i += 1)
    assert.deepEqual(area.pts[i], curve.pts[i], 'the fill follows the curve');
  assert.deepEqual(area.pts[curve.pts.length], { x: W, y: H - PAD_BOTTOM }, 'closes to the bottom-right corner');
  assert.deepEqual(area.pts[curve.pts.length + 1], { x: 0, y: H - PAD_BOTTOM }, 'closes to the bottom-left corner');
  const iFill = calls.findIndex(([k]) => k === 'fill');
  let iCurveStroke = -1;
  for (let i = iFill - 1; i >= 0; i -= 1)
    if (calls[i][0] === 'stroke') { iCurveStroke = i; break; }
  assert.ok(iCurveStroke >= 0 && iCurveStroke < iFill, 'the fill comes right after the curve stroke');

  // The halo: shadowColor = the drum hue + shadowBlur 4 set AROUND
  // the role-anchor loop only — before the first anchor fill, reset
  // to 0 before the first bend dot — so the context leaves the paint
  // glow-free (a reopen repaint starts clean).
  const blurSets = calls
    .map(([k, v], i) => (k === 'shadowBlur' ? { i, v } : null))
    .filter(Boolean);
  assert.deepEqual(blurSets.map((s) => s.v), [4, 0], 'halo on, then off');
  const iShadowColor = calls.findIndex(([k, v]) => k === 'shadowColor' && v === DRUM_COLORS.snare);
  assert.ok(iShadowColor >= 0 && iShadowColor < blurSets[0].i, 'shadowColor set with the halo');
  const fillIdx = calls.map(([k], i) => (k === 'fill' ? i : -1)).filter((i) => i >= 0);
  assert.ok(fillIdx[0] < blurSets[0].i, 'the area fill is outside the halo');
  assert.ok(blurSets[0].i < fillIdx[1], 'the halo is on before the first anchor fill');
  assert.ok(fillIdx[6] < blurSets[1].i, 'the halo is off after the last anchor fill');
  assert.ok(blurSets[1].i < fillIdx[7], '… and before the first bend-dot fill');
  assert.equal(ctx.shadowBlur, 0, 'the context leaves the preview with the halo off');
});

test('initCardEnvelopeEditor: switching the kind redraws the new envelope (edits nothing)', () => {
  const { card, drum, edits } = makeCard();
  const canvas = envCanvasOf(card);
  const ctx = canvas.getContext('2d');
  const select = envSelectOf(card);
  const afterLevel = ctx.calls.length; // the build paint (level, open by default)

  select.value = '1';
  fire(select, 'change'); // 'pitch' — the kick body's pitchEnv (100 -> 50 Hz)

  const fresh = ctx.calls.slice(afterLevel);
  assert.ok(fresh.length > 0, 'a selection change redraws');
  // The pitch kind: the log-Hz scale fits the env's OWN range
  // (bandHzRange: 50…100) — two anchors at the endpoints: (0, 100 Hz)
  // at the top-left, (0.03 s, 50 Hz) at the bottom.
  const arcs = fresh.filter(([m]) => m === 'arc');
  assert.equal(arcs.length, 2, 'two anchors for the 2-point pitchEnv (no bend dots)');
  const plotH = 120 - PAD_TOP - PAD_BOTTOM;
  assert.deepEqual(
    arcs.map(([m, x, y]) => [x, y]),
    [
      [0, PAD_TOP], // p0: t = 0, v = 100 (the range max — the top)
      [0.03 * (320 / 0.5), PAD_TOP + plotH], // p1: t = 0.03, v = 50 (the bottom)
    ],
    'the anchors sit at the pitchEnv points (tToX / the log vToY)',
  );
  // The edge labels are note names at the range bounds, and a note
  // label rides each anchor (the band's look): each endpoint's note is
  // painted at least twice (the edge label + the anchor label).
  const edgeLabels = fresh.filter(([m, t, x, y]) => m === 'fillText' && x === 4).map(([, t]) => t);
  assert.deepEqual(edgeLabels, [hzToNoteName(100), hzToNoteName(50)], 'the note labels re-fit to the pitch range');
  for (const note of [hzToNoteName(100), hzToNoteName(50)]) {
    const count = fresh.filter(([m, t]) => m === 'fillText' && t === note).length;
    assert.ok(count >= 2, `the note ${note} is painted at its edge AND its anchor (got ${count})`);
  }
  assert.equal(edits.length, 0, 'a selection change fires no onPatchEdit');
  assert.deepEqual(
    getPath(drum.patch, 'layers.0.pitchEnv'),
    [{ t: 0, v: 100 }, { t: 0.03, v: 50 }],
    '…and the patch is untouched',
  );
});

test('initCardEnvelopeEditor: an external edit to the same points is shown on the next redraw (redraw from the patch)', () => {
  const { card, drum } = makeCard();
  const ctx = envCanvasOf(card).getContext('2d');
  const n = ctx.calls.length; // the build paint (open at build)

  // An external writer (a level knob — the whole-array re-derivation,
  // or the modal) replaces the levelEnv; the preview holds no copy of
  // the points, so the next redraw (main.js's sync pass calls it) must
  // show the new shape. The edit: sustain 0.4 with a shorter decay —
  // the sustain anchor (point 4) moves to (0.205 s, 0.4).
  setPath(
    drum.patch,
    'layers.0.levelEnv',
    dahdsrToPoints({
      delay: 0, attack: 0.005, hold: 0, decay: 0.2, sustain: 0.4,
      release: 0.1, decayCurve: KNEE_CURVE,
    }),
  );
  card.envEditor.redraw();
  const fresh = ctx.calls.slice(n);
  assert.ok(fresh.length > 0, 'the redraw ran');
  const pts = levelEnvPoints(drum);
  assert.equal(pts.length, 6, 'the replacement stayed a 6-point canonical array');
  const arcs = fresh.filter(([m]) => m === 'arc');
  // The sustain anchor (point 4) sits at the PATCH point's position —
  // the t through tToX, the v through the fixed 0…1 scale.
  assert.equal(arcs[4][1], pts[4].t * (320 / 0.5), 'the sustain anchor moved in time (from the patch, not a private copy)');
  assert.equal(arcs[4][2], levelVToY(pts[4].v), '… and in level');
  assert.equal(pts[4].v, 0.4, 'the patched sustain value is what the anchor shows');
  assert.equal(arcs[2][2], PAD_TOP, '… and the untouched peak anchor stays on top');
});

// ---- per-card envelope preview: option refresh (plan P5/S14) ---------

test('buildFmCard: a modulator structural change refreshes the preview options (a dead fm-depth option cannot survive)', () => {
  const layer = modLayer([
    { freq: 300, index: 4, indexEnv: [{ t: 0, v: 4 }, { t: 0.02, v: 0 }] },
    { freq: 600, index: 2 },
  ]);
  const drum = makeDrum(layer);
  const card = buildFmCard({ drum, layerIndex: 0, layer, identity: { label: 'Source 1' } });
  const select = envSelectOf(card);
  assert.deepEqual(
    select.children.map((o) => o.textContent),
    ['level', 'modulator 1 FM depth'],
  );
  // Select the fm-depth kind, then remove its modulator (main.js's
  // onModRemove wiring, mirrored): the selected option DIES — refresh
  // must drop it and fall back to the first option (level).
  select.value = '1';
  fire(select, 'change');
  assert.equal(select.value, '1');
  drum.patch = removeModulator(drum.patch, 0, 0);
  card.rebuildModSection();
  assert.deepEqual(
    select.children.map((o) => o.textContent),
    ['level'],
    'the dead fm-depth option is gone (setPath would throw on its first edit)',
  );
  assert.equal(select.value, '0', 'the selection fell back to the surviving first option');
  // An unchanged set is a no-op: the modulator add appends the constant-
  // index default (no indexEnv — no new option).
  drum.patch = addModulator(drum.patch, 0);
  card.rebuildModSection();
  assert.deepEqual(
    select.children.map((o) => o.textContent),
    ['level'],
    'no spurious option churn on an unchanged set',
  );
  assert.equal(select.value, '0');
});

test('initCardEnvelopeEditor: the envEditor element API is { redraw, refresh } (the preserved card handle)', () => {
  const { card } = makeCard();
  assert.ok(card.envEditor, 'the card carries the envEditor handle');
  assert.equal(typeof card.envEditor.redraw, 'function', 'redraw for the readout-sync pass');
  assert.equal(typeof card.envEditor.refresh, 'function', 'refresh for the structural rebuild');
});

// ---- per-card effect slots (plan P6/S15) -----------------------------

// The snare's shell card is the plan's reference card: the shell
// (layer 1 of the FULL snare patch) carries a 330 Hz resonator (Q 5)
// in its OWN chain — one fx slot with freq + Q knobs — while the
// drum's master chain (a compressor) must stay untouched by every
// card fx op (the basePath separation).
const makeShellCard = (overrides = {}) => {
  const patch = snarePatch();
  const drum = { name: 'snare', duration: 0.5, patch };
  const edits = [];
  const fxAdds = [];
  const fxRemoves = [];
  const card = buildFmCard({
    drum,
    layerIndex: 1,
    layer: patch.layers[1],
    identity: { label: 'Source 2' },
    onPatchEdit: (d) => edits.push(d),
    onFxAdd: (d, i, t) => fxAdds.push([d, i, t]),
    onFxRemove: (d, i, j) => fxRemoves.push([d, i, j]),
    ...overrides,
  });
  return { card, drum, edits, fxAdds, fxRemoves };
};

// The .card-fx container, its slots (depth-first, tree order — the
// slot order IS the array order, plan P6/S15), the [+ fx] button, and
// the type group. The group's className carries two classes when
// hidden ('fx-types hidden'), so it is matched by prefix (the
// envSectionOf technique).
const fxContainerOf = (card) => byClass(card, 'card-fx');
const fxSlotsOf = (card) => byClassAll(card, 'fx-slot');
const fxAddOf = (card) => byClass(card, 'fx-add');
const fxTypesOf = (card) => {
  const out = [];
  const walk = (el) => {
    for (const child of el.children) {
      if (String(child.className).startsWith('fx-types')) out.push(child);
      walk(child);
    }
  };
  walk(card);
  return out[0] ?? null;
};
const fxTypeButtonsOf = (card) =>
  fxTypesOf(card).children[0].children.filter((c) => c.tagName === 'button');
const slotBadgeOf = (slot) => slot.children.find((c) => c.className === 'fx-badge');
const slotRemoveOf = (slot) => slot.children.find((c) => c.className === 'fx-remove');
const slotKnobsOf = (slot) => slot.children.filter((c) => c.className === 'knob');

// Mirror main.js's onFxAdd / onFxRemove wiring (the patch-ops.js op +
// the card's fx sub-section rebuild — the standalone test has no
// registry to rekey, and the op's surviving layer object is not
// observed by the card: it re-reads the fresh patch on the rebuild).
const applyFxAdd = (drum, card, layerIndex, type) => {
  drum.patch = addFx(drum.patch, `layers.${layerIndex}.effects`, type);
  card.rebuildFxSection();
};
const applyFxRemove = (drum, card, layerIndex, slotIndex) => {
  drum.patch = removeFx(drum.patch, `layers.${layerIndex}.effects`, slotIndex);
  card.rebuildFxSection();
};

test('fx slots: the snare shell card shows exactly one fx slot — a Resonator with freq + Q knobs at the chain paths', () => {
  const { card, drum } = makeShellCard();
  const slots = fxSlotsOf(card);
  assert.equal(slots.length, 1, 'exactly one slot for the one resonator');
  assert.equal(
    slotBadgeOf(slots[0]).textContent,
    FX_TYPE_LABELS.resonate,
    'the badge REUSES controls.js\'s FX_TYPE_LABELS',
  );
  const knobs = slotKnobsOf(slots[0]);
  assert.equal(knobs.length, 2, 'freq + Q — the resonator fields the patch carries');
  const [freqRotor, qRotor] = knobs.map((k) => byClass(k, 'knob-rotor'));
  assert.equal(freqRotor.getAttribute('aria-label'), 'Source 2: Resonator 1 freq (Hz)');
  assert.equal(freqRotor.getAttribute('aria-valuemin'), '20');
  assert.equal(freqRotor.getAttribute('aria-valuemax'), '22000');
  assert.equal(freqRotor.getAttribute('aria-valuenow'), '330', 'the live patch value');
  assert.equal(freqRotor.getAttribute('aria-valuetext'), '330 Hz', '... with the label-driven unit');
  assert.equal(qRotor.getAttribute('aria-label'), 'Source 2: Resonator 1 Q');
  assert.equal(qRotor.getAttribute('aria-valuemin'), '0.5');
  assert.equal(qRotor.getAttribute('aria-valuemax'), '20');
  assert.equal(qRotor.getAttribute('aria-valuenow'), '5', 'the live patch value');
  // The slot's [✕]: enabled (the chain may empty, unlike the card's
  // own [✕], which keeps the drum's last source).
  const remove = slotRemoveOf(slots[0]);
  assert.equal(remove.textContent, '✕');
  assert.equal(remove.disabled, false);
  assert.ok(remove.listeners['click'], '... and carries a handler');
  // The card-level grid no longer carries the fx knobs (they moved
  // into the slot — a parameter's knobs live in exactly one place).
  const grid = card.children.find((c) => c.className === 'knob-grid');
  const gridLabels = grid.children
    .map((k) => k.children.find((c) => c.className === 'knob-label').textContent);
  assert.deepEqual(
    gridLabels,
    [
      'carrier freq (Hz)',
      'level delay (s)',
      'level attack (s)',
      'level hold (s)',
      'level decay (s)',
      'level release (s)',
      'level sustain',
      'level attack curve',
      'level decay curve',
      'level release curve',
      'gain',
    ],
    'the card grid holds the non-fx, non-modulator knobs only',
  );
  // .controls carries the slot knobs with their chain paths (the
  // readout-sync contract — main.js's sync pass re-sets them too).
  assert.deepEqual(
    card.controls
      .filter((c) => c.path.startsWith('layers.1.effects.'))
      .map((c) => c.path),
    ['layers.1.effects.0.freq', 'layers.1.effects.0.q'],
  );
  assert.equal(byClass(fxContainerOf(card), 'fx-empty'), null, 'no hint for a non-empty chain');
  assert.equal(byClass(card, 'fx-cap'), null, 'no cap note below the limit');
  assert.ok(drum, 'fixture sanity');
});

test('fx slots: [+ fx] toggles the type group (hidden at build; four types, no active one)', () => {
  const { card } = makeShellCard();
  const add = fxAddOf(card);
  const types = fxTypesOf(card);
  assert.equal(types.className, 'fx-types hidden', 'hidden at build');
  const buttons = fxTypeButtonsOf(card);
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
  assert.ok(event.stopped, 'the head\'s working-source click does not follow');
  assert.equal(types.className, 'fx-types', 'the first click reveals the group');
  fire(add, 'click');
  assert.equal(types.className, 'fx-types hidden', '... and the next hides it again');
});

test('fx slots: picking a type fires onFxAdd(drum, layerIndex, type), and the op + rebuild add the slot (the patch has 2 effects in order)', () => {
  const { card, drum, fxAdds } = makeShellCard();
  fire(fxAddOf(card), 'click'); // reveal the type group
  const buttons = fxTypeButtonsOf(card);
  fire(buttons.find((b) => b.textContent === FX_TYPE_LABELS.saturate), 'click');
  assert.deepEqual(
    fxAdds,
    [[drum, 1, 'saturate']],
    'onFxAdd got the drum, the layer index, and the clicked type',
  );
  applyFxAdd(drum, card, 1, 'saturate'); // main.js\'s wiring, mirrored
  // Two slots, in ARRAY order (the slot order is the chain order):
  assert.deepEqual(
    fxSlotsOf(card).map((s) => slotBadgeOf(s).textContent),
    [FX_TYPE_LABELS.resonate, FX_TYPE_LABELS.saturate],
  );
  // The patch holds 2 effects in order; the new one is the op default.
  assert.deepEqual(
    drum.patch.layers[1].effects.map((f) => f.type),
    ['resonate', 'saturate'],
    'the add appends — the order is the array order (no reordering)',
  );
  assert.deepEqual(drum.patch.layers[1].effects[1], { type: 'saturate', drive: 2 });
  // The second slot carries the drive knob at the right path.
  const slot2 = fxSlotsOf(card)[1];
  const knobs2 = slotKnobsOf(slot2);
  assert.equal(knobs2.length, 1, 'a saturator carries one field: drive');
  const driveRotor = byClass(knobs2[0], 'knob-rotor');
  assert.equal(driveRotor.getAttribute('aria-label'), 'Source 2: Saturator 2 drive');
  assert.equal(driveRotor.getAttribute('aria-valuemin'), '1');
  assert.equal(driveRotor.getAttribute('aria-valuemax'), '10');
  assert.equal(driveRotor.getAttribute('aria-valuenow'), '2', 'the op default');
  // .controls re-derived from the fresh chain on the rebuild.
  assert.deepEqual(
    card.controls
      .filter((c) => c.path.startsWith('layers.1.effects.'))
      .map((c) => c.path),
    ['layers.1.effects.0.freq', 'layers.1.effects.0.q', 'layers.1.effects.1.drive'],
  );
});

test('fx slots: a compressor slot shows only the fields the patch carries (the field-presence rule, end to end)', () => {
  const { card, drum } = makeShellCard();
  applyFxAdd(drum, card, 1, 'compress');
  const slots = fxSlotsOf(card);
  const slot = slots[slots.length - 1]; // the freshly added one
  assert.equal(slotBadgeOf(slot).textContent, FX_TYPE_LABELS.compress);
  assert.deepEqual(
    slotKnobsOf(slot).map((k) => k.children.find((c) => c.className === 'knob-label').textContent),
    [
      'Compressor 2 threshold',
      'Compressor 2 ratio',
      'Compressor 2 makeup',
    ],
    'threshold / ratio / makeup — the op default carries no attack / release (the engine defaults them), so no knobs for them',
  );
});

test('fx slots: the slot [✕] fires onFxRemove(drum, layerIndex, slotIndex), and the op + rebuild drop the slot (the patch has 1, the UI shows it)', () => {
  const { card, drum, fxRemoves } = makeShellCard();
  applyFxAdd(drum, card, 1, 'saturate'); // two slots first
  assert.equal(fxSlotsOf(card).length, 2);
  const event = fire(slotRemoveOf(fxSlotsOf(card)[0]), 'click'); // the RESONATOR
  assert.ok(event.stopped, 'the head click does not follow');
  assert.deepEqual(
    fxRemoves,
    [[drum, 1, 0]],
    'onFxRemove got the drum, the layer index, and the SLOT index',
  );
  applyFxRemove(drum, card, 1, 0); // main.js\'s wiring, mirrored
  assert.deepEqual(
    drum.patch.layers[1].effects.map((f) => f.type),
    ['saturate'],
    'the patch has 1 effect left',
  );
  const slots = fxSlotsOf(card);
  assert.equal(slots.length, 1, '... and the UI shows it');
  assert.equal(slotBadgeOf(slots[0]).textContent, FX_TYPE_LABELS.saturate);
  // The survivor re-indexed to slot 1: its knob paths re-derive.
  assert.deepEqual(
    card.controls
      .filter((c) => c.path.startsWith('layers.1.effects.'))
      .map((c) => c.path),
    ['layers.1.effects.0.drive'],
  );
  assert.equal(
    byClass(slotKnobsOf(slots[0])[0], 'knob-rotor').getAttribute('aria-valuenow'),
    '2',
    '... with its value intact (the op default)',
  );
});

test('fx slots: removing the LAST slot empties the chain — the "no fx" hint returns and [+ fx] re-enables', () => {
  const { card, drum, fxRemoves } = makeShellCard();
  fire(slotRemoveOf(fxSlotsOf(card)[0]), 'click');
  assert.deepEqual(fxRemoves, [[drum, 1, 0]]);
  applyFxRemove(drum, card, 1, 0); // removal is allowed down to EMPTY
  assert.deepEqual(drum.patch.layers[1].effects, []);
  assert.equal(fxSlotsOf(card).length, 0);
  assert.equal(
    byClass(fxContainerOf(card), 'fx-empty').textContent,
    'no fx',
    'the muted hint is back',
  );
  const add = fxAddOf(card);
  assert.equal(add.disabled, false, '[+ fx] is enabled again');
  assert.ok(add.listeners['click'], '... and carries a handler');
});

test('fx slots: at the 4-slot cap [+ fx] is disabled with an inline note (a synthetic click is a no-op)', () => {
  const layer = {
    type: 'fm',
    carrier: { freq: 200 },
    modulators: [],
    gain: 0.5,
    effects: [
      { type: 'saturate', drive: 2 },
      { type: 'highpass', cutoff: 2000 },
      { type: 'resonate', freq: 300, q: 5 },
      { type: 'compress', threshold: 0.3, ratio: 3, makeup: 1.2 },
    ],
  };
  const drum = makeDrum(layer);
  const fxAdds = [];
  const card = buildFmCard({
    drum,
    layerIndex: 0,
    layer,
    identity: { label: 'Source 1' },
    onFxAdd: (d, i, t) => fxAdds.push([d, i, t]),
  });
  assert.equal(fxSlotsOf(card).length, 4, 'one slot per chain entry');
  const add = fxAddOf(card);
  assert.equal(add.disabled, true, '[+ fx] is disabled at the cap (the shared MAX_FX_SLOTS)');
  assert.equal(add.listeners['click'], undefined, '... and carries no handler');
  assert.equal(byClass(card, 'fx-cap').textContent, '4 fx max', 'the inline note');
  fire(add, 'click'); // a synthetic click at the disabled button
  assert.equal(fxAdds.length, 0, '... is a no-op (the op\'s throw is unreachable from the UI)');
  // Every slot keeps its [✕] (removal is allowed down to empty).
  assert.ok(
    fxSlotsOf(card).every((s) => slotRemoveOf(s).listeners['click']),
  );
});

test('fx slots: a slot knob live-binds to the chain path (setPath + onPatchEdit)', () => {
  const { card, drum, edits } = makeShellCard();
  const freqKnob = slotKnobsOf(fxSlotsOf(card)[0])[0];
  fire(byClass(freqKnob, 'knob-rotor'), 'keydown', { key: 'ArrowUp' }); // 330 -> 331 Hz
  assert.equal(drum.patch.layers[1].effects[0].freq, 331, 'the edit landed on the CHAIN path');
  assert.equal(edits.length, 1, 'one onPatchEdit per knob move');
  assert.equal(edits[0], drum, 'onPatchEdit receives the drum');
  // The master chain is a different base path — untouched by value edits too.
  assert.deepEqual(
    drum.patch.masterEffects,
    [{ type: 'compress', threshold: 0.3, ratio: 3, makeup: 1.2 }],
  );
});

test('fx slots: card fx ops never touch the master chain (the basePath separation)', () => {
  const { card, drum } = makeShellCard();
  const masterBefore = drum.patch.masterEffects;
  assert.equal(masterBefore.length, 1, 'fixture: the snare master carries a compressor');
  applyFxAdd(drum, card, 1, 'saturate');
  assert.equal(
    drum.patch.masterEffects,
    masterBefore,
    'add: the master chain is the SAME reference (clone-first carry-over)',
  );
  applyFxRemove(drum, card, 1, 0);
  assert.equal(drum.patch.masterEffects, masterBefore, 'remove: still untouched');
  assert.deepEqual(drum.patch.masterEffects, [
    { type: 'compress', threshold: 0.3, ratio: 3, makeup: 1.2 },
  ], '... with its compressor intact');
  // The card chain DID move (the separation is one-directional):
  assert.deepEqual(drum.patch.layers[1].effects.map((f) => f.type), ['saturate']);
});

test('fx slots: a noise card gets the same chain UI — the empty hint at build, and a highpass lands on the noise layer\'s chain', () => {
  const fxAdds = [];
  const { card, drum } = makeNoiseCard({
    onFxAdd: (d, i, t) => fxAdds.push([d, i, t]),
  }); // the noise fixture has no effects
  assert.equal(
    byClass(fxContainerOf(card), 'fx-empty').textContent,
    'no fx',
    'the muted hint for the empty chain',
  );
  assert.equal(fxSlotsOf(card).length, 0);
  fire(fxAddOf(card), 'click');
  const buttons = fxTypeButtonsOf(card);
  fire(buttons.find((b) => b.textContent === FX_TYPE_LABELS.highpass), 'click');
  assert.deepEqual(fxAdds, [[drum, 0, 'highpass']], 'the noise card fires the same onFxAdd');
  applyFxAdd(drum, card, 0, 'highpass');
  assert.deepEqual(
    drum.patch.layers[0].effects,
    [{ type: 'highpass', cutoff: 2000 }],
    'the chain lives on the NOISE layer (the engine applies fx to any layer type)',
  );
  const slots = fxSlotsOf(card);
  assert.equal(slots.length, 1);
  assert.equal(slotBadgeOf(slots[0]).textContent, FX_TYPE_LABELS.highpass);
  const rotor = byClass(slotKnobsOf(slots[0])[0], 'knob-rotor');
  assert.equal(rotor.getAttribute('aria-label'), 'Source 1: High-pass 1 cutoff (Hz)');
  assert.equal(rotor.getAttribute('aria-valuenow'), '2000');
});

test('initCardFxSlots: a card without the footer\'s .card-fx container throws (fail loudly, repo style)', () => {
  const layer = kickPatch().layers[0];
  const bare = { children: [] }; // not a card built by buildCard
  assert.throws(
    () => initCardFxSlots(bare, makeDrum(layer), 0),
    /needs the card footer/,
  );
});

// ---- repo style (GUIDELINES §3: no leftover console.log, no dead code) --

test('cards.js source: no console.* calls, no debugger statements', async () => {
  const src = await readFile(join(repoRoot, 'src', 'app', 'cards.js'), 'utf8');
  assert.ok(!/console\s*\./.test(src), 'no console.* calls (GUIDELINES §3)');
  assert.ok(!/\bdebugger\b/.test(src), 'no debugger statements');
});
