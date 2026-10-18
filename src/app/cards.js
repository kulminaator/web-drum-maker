// Source cards (binding layer, src/app/): the per-source knob cards of
// the card UI (new-ui.md §2.1 "all sources, one screen", §2.2 "the
// card is the source"): one self-contained <section class="card"> per
// oscillation source — a head (the "Source <identity>" title, the type
// badge, the per-source WAV-export button [⤓] — new-ui.md §7, P8/S20 —
// the remove button, the solo dot), a dense 3-column knob grid
// (the card-level parameters: the carrier, the level envelope, the
// gain, the fx chain), the FM card's DYNAMIC modulator sub-section
// (P5/S14): one .mod-block per modulator — its own knobs (freq, index
// — or FM index / FM decay per the factory's shadowing rules — and
// feedback) and toggles (the ring on/off group, the cascade-target
// select) plus the block's [✕] — and the [+ mod] button (disabled at
// the engine's 4-modulator limit; removal is allowed down to zero — a
// plain sine); the sub-section rebuilds when the modulator STRUCTURE
// changes (add/remove), plain value edits stay in place (the knobs
// already live-bind), a footer (the per-card envelope-editor button
// and the FX slot list — P6/S15: one .fx-slot per entry of the
// layer's effects chain (its type badge from controls.js's
// FX_TYPE_LABELS, that fx's parameter knobs from describeFxList, the
// slot's [✕]) plus the [+ fx] button and its compact type button
// group, built by initCardFxSlots and re-derived from the fresh patch
// on every structural add/remove), and the
// per-card envelope editor itself (P4/S10): the footer's [env] button
// toggles an expandable section (kind select + 320×120 canvas — open
// at build, the level (volume) envelope is the visible default) — a
// live DISPLAY-ONLY preview of the selected envelope plus the kind
// select; a click on the preview opens the full-screen constrained
// editor modal (src/app/env-modal.js, plan "dahdsr" P4/S1) for this
// source/kind. The old free-form point editor is retired with this
// switch (the no-split-brain rule — see the section header below).
//
// Library imports are facade-only (GUIDELINES §1.4(b)): getPath /
// setPath / pitchEnvelope from src/lib/index.js. The card's UI
// METADATA comes from the
// controls.js descriptor factories, which survive the rewrite as the
// single UI-metadata source (new-ui.md §4): describeLayer emits every
// NUMERIC descriptor — its shadowing rules (env-driven vs constant
// params, the dead-ring case) work unchanged — and describeToggles
// below emits the non-numeric patch fields describeLayer does not:
// the wave shape (shape-group — the carrier's, and each modulator's),
// the ring boolean (button group) and the cascade target (select) —
// booleans/enums, not min/max/step ranges (GUIDELINES §1.4(e): UI
// metadata stays in the app tier).
//
// The live-patch contract (new-ui.md §2.8 "live everywhere"): a
// control's initial value is read through the descriptor's funnel
// (getPath at build time, the optional read transform on top — plan
// "dahdsr" P3/S2) and every edit goes
// setPath(drum.patch, path, write(raw, value)) -> onPatchEdit(drum)
// (main.js re-renders the preview/playback + the band + the readouts).
// The card holds no private copy of the patch — the "redraw from the
// patch, never from a private copy" rule, generalized from the old
// envelope editor. drum.patch is re-read on every edit (never cached),
// so a wholesale patch replacement (P5/S13) cannot leave a card writing
// into a dead object. The readout-sync pass (main.js) walks the
// card's live-bound controls as {el, path, descriptor} entries and
// re-sets each control from the patch THROUGH the same funnel.
//
// Card identity (new-ui.md §2.7): `identity` ({label: 'Source 2'}) is
// passed IN by main.js — the card NEVER computes its own cosmetic
// number from layerIndex (the identity-stability invariant; the
// registry that mints labels lands in P5/S13). The index only
// addresses the patch paths.
//
// buildFmCard (plan P3/S7 — the milestone that proves the knob-card
// model) and buildNoiseCard (plan P4/S9) share one skeleton; both get
// their knobs from the same describeLayer factory (the noise card
// carries no modulator sub-section — a noise layer has no ring /
// cascade target).

import { getPath, pitchEnvelope, setPath } from '../lib/index.js';
import {
  descriptorRead,
  descriptorWrite,
  describeFxList,
  describeLayer,
  displayLabelOf,
  FX_TYPE_LABELS,
  SHAPE_OPTIONS,
} from './controls.js';
import {
  buildButtonGroup,
  buildKnob,
  buildShapeGroup,
} from './knob.js';
import { wireEnvEditor } from './env-editor.js';
import { MAX_FX_SLOTS, MAX_MODULATORS } from './patch-ops.js';
import { THEME } from './theme.js';

// Toggle descriptors for ONE layer — the non-numeric patch fields
// describeLayer does not emit (they are booleans/enums, not ranges):
//   - `carrier.shape`          -> the wave-shape group (SHAPE_OPTIONS),
//     emitted FIRST — it is the layer's defining wave; the modulator
//     shapes follow in their blocks;
//   - `modulators.N.shape`     -> the wave-shape group, emitted
//     alongside that modulator's ring / target descriptors (block
//     order: shape, then ring, then target);
//   - `modulators.N.ring`      -> a compact on/off button group;
//   - `modulators.N.modulates` -> the cascade-target select: "none"
//     (undefined — the modulator drives the carrier) plus one option
//     per OTHER modulator on the layer (its 1-based label).
// A control only addresses a field the patch ACTUALLY carries (the
// describeFxList rule, generalized): setPath is strict and refuses to
// create keys, so a modulator without a `ring` / `modulates` field
// gets no control for it — the dead control would throw on its first
// click. Noise layers have neither field: an empty list (they are
// filtered noise bursts, not oscillators — no shape for them; the
// `type !== 'fm'` early return below covers it). An unknown layer
// type throws, mirroring describeLayer's guard (factory drift fails
// loudly instead of shipping a half-populated card).
// The ONE difference for shape: it is a DEFAULTABLE schema field
// (src/lib/engine.js header — absent means sine), and the card row
// materializes it in place before card build (plan sinecontrol
// P3/S7), so a control always addresses a present field — the
// setPath-strict rule stays intact. A raw, unmaterialized patch (no
// shape fields) simply gets no shape controls — field-presence,
// exactly like ring / modulates.
// Descriptor shape: {kind, path, label, displayLabel, options} —
// kind dispatches the control builder (descriptorKind); options is
// the button group's {value, label} list (knob.js). label is the
// full aria name; displayLabel is the short visible caption (the
// label with the leading `Source N:` prefix stripped — displayLabelOf,
// controls.js; plan ui3 P5/S1), rendered by the button-group and
// select builders as `displayLabel ?? label` while the group's /
// select's aria-label keeps the FULL label.
export const describeToggles = (layer, layerIndex) => {
  if (layer.type !== 'fm' && layer.type !== 'noise')
    throw new Error(
      `cards: unknown layer type ${JSON.stringify(layer.type)} (expected "fm" or "noise")`,
    );
  if (layer.type !== 'fm') return [];
  const base = `layers.${layerIndex}`;
  const prefix = `Source ${layerIndex + 1}`;
  const mods = layer.modulators ?? [];
  const out = [];
  // The carrier's shape comes FIRST: it is the layer's defining wave
  // (the modulator shapes follow in their blocks below).
  if ('shape' in layer.carrier)
    out.push({
      kind: 'shape-group',
      path: `${base}.carrier.shape`,
      label: `${prefix}: wave shape`,
      displayLabel: displayLabelOf(`${prefix}: wave shape`),
      options: SHAPE_OPTIONS,
    });
  for (const [j, m] of mods.entries()) {
    if ('shape' in m) {
      const label = `${prefix}: modulator ${j + 1} shape`;
      out.push({
        kind: 'shape-group',
        path: `${base}.modulators.${j}.shape`,
        label,
        displayLabel: displayLabelOf(label),
        options: SHAPE_OPTIONS,
      });
    }
    if ('ring' in m) {
      const label = `${prefix}: modulator ${j + 1} ring`;
      out.push({
        kind: 'button-group',
        path: `${base}.modulators.${j}.ring`,
        label,
        displayLabel: displayLabelOf(label),
        options: [
          { value: false, label: 'off' },
          { value: true, label: 'on' },
        ],
      });
    }
    // The select needs a target to offer: with one modulator there is
    // no other modulator to cascade into (a self-cascade is rejected
    // by the engine's cycle check, src/lib/fm.js).
    if ('modulates' in m && mods.length > 1) {
      const options = [{ value: undefined, label: 'none' }];
      for (const k of mods.keys())
        if (k !== j) options.push({ value: k, label: `modulator ${k + 1}` });
      const label = `${prefix}: modulator ${j + 1} target`;
      out.push({
        kind: 'select',
        path: `${base}.modulators.${j}.modulates`,
        label,
        displayLabel: displayLabelOf(label),
        options,
      });
    }
  }
  return out;
};

// The modulator index a descriptor addresses (plan P5/S14): the per-
// modulator descriptors describeLayer / describeToggles emit carry the
// `modulators.<j>` path segment; the card-level ones (the carrier, the
// level envelope, the gain, the fx chain) do not. null = a card-level
// descriptor. The split is a pure path read — the descriptor CONTENT
// (ranges, labels, the shadowing rules) stays the factories'.
const modIndexOf = (descriptor, layerIndex) => {
  const prefix = `layers.${layerIndex}.modulators.`;
  if (!descriptor.path.startsWith(prefix)) return null;
  const j = Number(descriptor.path.slice(prefix.length).split('.')[0]);
  return Number.isInteger(j) ? j : null;
};

// The fx slot index a descriptor addresses (plan P6/S15): the fx
// descriptors describeLayer emits carry the `effects.<j>` path segment
// (see fxIndexOf's callers for the split); the card-level and
// per-modulator ones do not. null = a non-fx descriptor. Like
// modIndexOf the split is a pure path read — the descriptor CONTENT
// (ranges, labels, the field-presence rule) stays the factory's.
const fxIndexOf = (descriptor, layerIndex) => {
  const prefix = `layers.${layerIndex}.effects.`;
  if (!descriptor.path.startsWith(prefix)) return null;
  const j = Number(descriptor.path.slice(prefix.length).split('.')[0]);
  return Number.isInteger(j) ? j : null;
};

// The descriptor -> control-kind dispatcher: 'knob' for the numeric
// descriptors describeLayer / describePatch emit (a {min, max, step}
// range), 'button-group' / 'select' / 'shape-group' for the
// describeToggles kinds.
// buildControl routes EVERY descriptor through here, so a descriptor
// shape the factories start emitting that no control covers throws at
// card build time instead of shipping a dead control — the factory-
// drift guard (plan P3/S7: covers every descriptor kind describePatch
// can emit for the three voice patches).
export const descriptorKind = (descriptor) => {
  if (
    descriptor?.kind === 'button-group' ||
    descriptor?.kind === 'select' ||
    descriptor?.kind === 'shape-group'
  )
    return descriptor.kind;
  if (
    descriptor &&
    Number.isFinite(descriptor.min) &&
    Number.isFinite(descriptor.max) &&
    descriptor.min < descriptor.max &&
    Number.isFinite(descriptor.step) &&
    descriptor.step > 0
  )
    return 'knob';
  throw new Error(
    `cards: cannot classify descriptor ${JSON.stringify(descriptor)} `
      + '(expected a {min, max, step} range or a '
      + 'button-group / select / shape-group toggle)',
  );
};

// The cascade-target <select> for `modulators.N.modulates`
// (interaction pattern 4, src/lib/fm.js). The option values travel as
// strings (a select element's native value type): '' encodes none
// (undefined), '0'..'3' the target modulator's index; the element API
// decodes them back to raw values (undefined or number) so the onInput
// contract matches the knob's and the button group's.
//
// Same live, no-commit contract as the knob: a change event commits the
// selected raw value — state + DOM first, then onInput (new-ui.md
// §2.8). `.value` is the raw value the select currently shows;
// `.setValue(v)` is a no-op for a value no option represents (the
// button group's rule for unrepresentable values — onInput never fires
// for one) and for the value already shown (the P1/S8 readout-sync pass
// must not loop). A select always shows exactly one option: an
// unrepresentable initial value starts on "none".
const buildModulatesSelect = (descriptor, value, onInput) => {
  const toOption = (raw) => (raw === undefined ? '' : String(raw));
  const fromOption = (text) => (text === '' ? undefined : Number(text));
  const representable = (raw) =>
    descriptor.options.some((o) => o.value === raw);

  const root = document.createElement('div');
  root.className = 'select';

  const labelEl = document.createElement('span');
  labelEl.className = 'select-label';
  // The visible caption drops the `Source N:` prefix (displayLabel);
  // the select's aria-label keeps the FULL label (plan ui3 P5/S1 —
  // the accessible name is unchanged). Absent displayLabel falls
  // back to the full label.
  labelEl.textContent = descriptor.displayLabel ?? descriptor.label;
  root.appendChild(labelEl);

  const select = document.createElement('select');
  select.className = 'select-input';
  select.setAttribute('aria-label', descriptor.label);
  for (const option of descriptor.options) {
    const el = document.createElement('option');
    el.value = toOption(option.value);
    el.textContent = option.label;
    select.appendChild(el);
  }
  root.appendChild(select);

  let current = representable(value) ? value : undefined;

  const paint = () => {
    select.value = toOption(current);
    root.value = current;
  };

  const commit = (next) => {
    if (next === current) return;
    current = next;
    paint();
    onInput(next);
  };

  select.addEventListener('change', () => commit(fromOption(select.value)));

  root.value = current;
  root.setValue = (v) => {
    if (!representable(v)) return; // unrepresentable: no move, no onInput
    commit(v);
  };
  paint();
  return root;
};

// One live-bound control per descriptor (plan P3/S7, shared by the
// card-level knob grid and the modulator blocks, P5/S14): the
// descriptorKind dispatch (the factory-drift guard) into the knob /
// button-group / shape-group / cascade-target-select builders, the
// value read through the descriptor's funnel (getPath at build time,
// the optional read transform on top — plan "dahdsr" P3/S2; the
// live-patch contract: drum.patch is re-read, never cached), the edit
// funneled to setPath -> onPatchEdit via the card's `edit` closure
// (the funnel's write half).
const buildControl = (drum, descriptor, edit) => {
  const kind = descriptorKind(descriptor);
  // The initial value through the funnel's read half: the raw value
  // at the descriptor's path, and — for a transformed descriptor (the
  // DAHDSR level knobs, whose raw value is the whole levelEnv point
  // array) — the descriptor's scalar view of it.
  const value = descriptorRead(descriptor, getPath(drum.patch, descriptor.path));
  if (kind === 'knob')
    return buildKnob({
      label: descriptor.label,
      displayLabel: descriptor.displayLabel,
      min: descriptor.min,
      max: descriptor.max,
      step: descriptor.step,
      value,
      format: descriptor, // its label drives the readout's unit
      onInput: edit(descriptor),
    });
  if (kind === 'button-group')
    return buildButtonGroup({
      label: descriptor.label,
      displayLabel: descriptor.displayLabel,
      options: descriptor.options,
      value,
      onInput: edit(descriptor),
    });
  if (kind === 'shape-group')
    // Same shape as the button-group branch: the field is
    // materialized before card build (plan sinecontrol P3/S7), so
    // the strict getPath is safe. The preview wears the drum's hue
    // (plan "colors" S4): the CSS --drum var cannot reach the canvas,
    // so the color travels as the explicit argument — a drum with no
    // color yet falls back to the brand accent (knob.js keeps its own
    // null fallback for direct callers).
    return buildShapeGroup({
      label: descriptor.label,
      options: descriptor.options,
      value,
      color: drum.color ?? THEME.accent,
      onInput: edit(descriptor),
    });
  return buildModulatesSelect(descriptor, value, edit(descriptor));
};

// The FM card's modulator sub-section CONTENT (plan P5/S14): one
// .mod-block per modulator of the layer — re-derived from the LIVE
// patch on every call (the live-patch contract: the rebuild must see
// the structural op's result, not the pre-op layer) — and the [+ mod]
// button after the blocks:
//
//   div.mod-block:
//     header.mod-head   "modulator N" (1-based) + the block's [✕].
//                       The removal is ALWAYS enabled: a modulator may
//                       be removed down to ZERO — an FM layer with no
//                       modulators is a plain sine the engine renders
//                       fine (the hi-hat's partials are exactly that),
//                       unlike the card's own [✕], which keeps the
//                       drum's last source;
//     div.knob-grid     the modulator's OWN numeric descriptors from
//                       describeLayer (freq; index — or FM index / FM
//                       decay when an indexEnv shadows the constant; or
//                       no index at all in the dead-ring case; and
//                       feedback when the patch carries it) — the
//                       factory's shadowing rules work unchanged;
//     div.card-toggles  the modulator's OWN toggle descriptors from
//                       describeToggles (the ring on/off group when the
//                       field exists; the cascade-target select when
//                       the field exists AND there is another
//                       modulator to cascade into — its options, "none"
//                       plus every OTHER modulator's 1-based label,
//                       re-derive with the modulator count on every
//                       rebuild; an empty row hides itself, CSS).
//
//   button.mod-add      "[+ mod]" — disabled (no handler) at the
//                       engine's 4-modulator limit (patch-ops.js's
//                       MAX_MODULATORS, the shared constant); the state
//                       is wired from the live count at build and every
//                       structural change rebuilds this section, so it
//                       is always fresh.
//
// Returns { children, controls }: the elements to fill the stable
// .mod-section container with, and the blocks' live-bound controls in
// build order (per block: its knobs, then its toggles) — the card's
// .controls getter composes them after the card-level grid.
const buildModContent = (drum, layerIndex, edit, onModAdd, onModRemove) => {
  const layer = drum.patch.layers[layerIndex];
  const modulators = layer.modulators ?? [];
  const layerDescriptors = describeLayer(layer, layerIndex);
  const toggleDescriptors = describeToggles(layer, layerIndex);
  const ofMod = (j) => (list) =>
    list.filter((d) => modIndexOf(d, layerIndex) === j);

  const children = [];
  const controls = [];
  modulators.forEach((mod, j) => {
    const block = document.createElement('div');
    block.className = 'mod-block';

    const head = document.createElement('header');
    head.className = 'mod-head';
    const label = document.createElement('span');
    label.className = 'mod-label';
    label.textContent = `modulator ${j + 1}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'mod-remove';
    remove.textContent = '✕';
    // Always enabled (assigned explicitly — the stub element has no DOM
    // default): a modulator may be removed down to ZERO, an FM layer
    // with none is a plain sine the engine renders fine.
    remove.disabled = false;
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      onModRemove(drum, layerIndex, j);
    });
    head.appendChild(label);
    head.appendChild(remove);
    block.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'knob-grid';
    for (const d of ofMod(j)(layerDescriptors)) {
      const control = buildControl(drum, d, edit);
      grid.appendChild(control);
      controls.push({ el: control, path: d.path, descriptor: d });
    }
    block.appendChild(grid);

    const toggles = document.createElement('div');
    toggles.className = 'card-toggles';
    for (const d of ofMod(j)(toggleDescriptors)) {
      const control = buildControl(drum, d, edit);
      toggles.appendChild(control);
      controls.push({ el: control, path: d.path, descriptor: d });
    }
    block.appendChild(toggles);
    children.push(block);
  });

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'mod-add';
  add.textContent = '+ mod';
  const atCap = modulators.length >= MAX_MODULATORS;
  add.disabled = atCap;
  if (!atCap)
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      onModAdd(drum, layerIndex);
    });
  children.push(add);

  return { children, controls };
};

// ---- Per-card envelope preview + modal open (plan "dahdsr" P4/S1) ---
//
// The old free-form point editor (drag / click-insert / double-click-
// remove on this source's points) is RETIRED: the constrained DAHDSR
// editor (src/app/env-editor.js) is now the only envelope editor, and
// it lives in the full-screen modal (src/app/env-modal.js). The card
// keeps a live DISPLAY-ONLY preview of the selected envelope plus the
// kind <select>, and a click on the preview opens the modal for this
// source/kind (main.js wires the callback). No coexistence: the old
// editor's free-form points could not be named by the DAHDSR knobs
// (the no-split-brain rule), and two editors drawing the same patch
// would fight over the pixels — so the card editor is replaced
// outright, and the old editor's last src/ consumers of the facade's
// point API (pointAt / insertPoint / removePoint / clampPointT) go
// with it (P5/S13 removes the lib functions).
//
// The element API is preserved: card.envEditor = { redraw, refresh } —
// redraw repaints the preview from the live patch on the readout-sync
// pass (the always-fresh invariant; no-op while collapsed), refresh
// re-derives the option list when the modulator structure changes
// (P5/S14 — a removed modulator's indexEnv option is dead, a new
// modulator's appears).

// Find the first descendant of `root` whose className is exactly
// `cls` (depth-first). The footer init hooks use it to reach the
// controls buildCard already built into the card (the [env] button,
// the .card-fx container) — the card's element API is the section,
// not its internals.
const findClass = (root, cls) => {
  const stack = [...root.children];
  while (stack.length > 0) {
    const el = stack.pop();
    if (el.className === cls) return el;
    stack.push(...el.children);
  }
  return null;
};

// The preview canvas size (one canvas per card instance).
const CARD_ENV_WIDTH = 320;
const CARD_ENV_HEIGHT = 120;

// The envelope kinds one source card can view / edit, in select order.
// Field-presence rule (the describeToggles / describeFxList rule): an
// option exists only when its field exists in the live patch —
//   - `level`    -> layers.<i>.levelEnv;
//   - `pitch`    -> layers.<i>.pitchEnv — offered only when the field
//                   exists (the "add pitch env" button above creates
//                   it; the option then appears via refresh);
//   - `fm depth` -> layers.<i>.modulators.<j>.indexEnv — one per
//                   modulator that HAS an indexEnv.
// Pure: (layer, layerIndex) -> [{kind, path, label}].
export const cardEnvelopeOptions = (layer, layerIndex) => {
  if (layer.type === 'noise')
    return layer.levelEnv
      ? [{ kind: 'level', path: `layers.${layerIndex}.levelEnv`, label: 'level' }]
      : [];
  if (layer.type !== 'fm')
    throw new Error(
      `cards: cardEnvelopeOptions: unknown layer type ${JSON.stringify(layer.type)}`,
    );
  const base = `layers.${layerIndex}`;
  const out = [];
  if (layer.levelEnv)
    out.push({ kind: 'level', path: `${base}.levelEnv`, label: 'level' });
  if (layer.pitchEnv)
    out.push({ kind: 'pitch', path: `${base}.pitchEnv`, label: 'pitch' });
  if (layer.modulators)
    for (const [j, m] of layer.modulators.entries())
      if (m.indexEnv)
        out.push({
          kind: 'fm depth',
          path: `${base}.modulators.${j}.indexEnv`,
          label: `modulator ${j + 1} FM depth`,
        });
  return out;
};

// Wire the card's envelope section (a no-op — returns null — when the
// layer carries no editable envelope: the [env] button stays inert).
// OPEN at build (the level envelope is the visible default); the
// section holds the kind <select>, the display-only preview canvas and
// the (existing) [env] collapse button. onEnvOpen(drum, layerIndex,
// kindPath) fires on a preview click — main.js opens the modal for
// that source/kind.
export const initCardEnvelopeEditor = (
  card,
  drum,
  layerIndex,
  onEnvOpen = () => {},
) => {
  const envBtn = findClass(card, 'card-env-btn');
  let options = cardEnvelopeOptions(drum.patch.layers[layerIndex], layerIndex);
  if (!options.length) return null; // nothing to edit: the button stays inert

  const env = document.createElement('div');
  env.className = 'card-env'; // OPEN at build (no 'hidden')

  const select = document.createElement('select');
  select.className = 'card-env-select';
  select.setAttribute('aria-label', 'envelope kind');
  const fillSelect = (list) =>
    select.replaceChildren(
      ...list.map((o, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = o.label;
        return opt;
      }),
    );
  fillSelect(options);

  // The DISPLAY-ONLY preview: the shared constrained-editor core at
  // the full [0, duration] span (the zoom window is the modal's job).
  // No pointer listeners — the sole affordance is the click that opens
  // the modal (cursor: pointer + an aria/title affordance).
  const canvas = document.createElement('canvas');
  canvas.className = 'card-env-canvas';
  canvas.width = CARD_ENV_WIDTH;
  canvas.height = CARD_ENV_HEIGHT;
  canvas.setAttribute('aria-label', 'envelope preview');
  canvas.setAttribute('title', 'open the envelope editor');
  canvas.style.cursor = 'pointer';

  env.append(select, canvas);
  card.appendChild(env);

  const editor = { env: options[0] };

  const wire = wireEnvEditor(canvas, {
    getDrum: () => drum,
    getKind: () => ({ kind: editor.env.kind, path: editor.env.path }),
    displayOnly: true, // no pointer listeners
  });

  const redraw = () => {
    if (env.className.includes('hidden')) return; // no-op while collapsed
    wire.redraw();
  };

  // Re-derive the option list from the live patch (the modulator
  // structure changed under the preview — a removed modulator's
  // indexEnv option is dead, a new modulator's appears). Keep the
  // current selection when it survives.
  const refresh = () => {
    const fresh = cardEnvelopeOptions(drum.patch.layers[layerIndex], layerIndex);
    const same =
      fresh.length === options.length &&
      fresh.every((o, i) => o.path === options[i].path);
    if (same) return;
    options = fresh;
    if (!options.some((o) => o.path === editor.env.path))
      editor.env = options[0];
    fillSelect(options);
    select.value = String(options.findIndex((o) => o.path === editor.env.path));
    redraw(); // a no-op while collapsed; the kind may have changed
  };

  select.addEventListener('change', () => {
    editor.env = options[Number(select.value)];
    redraw(); // selection change edits nothing — no re-render
  });

  canvas.addEventListener('click', () => onEnvOpen(drum, layerIndex, editor.env.path));

  envBtn.addEventListener('click', () => {
    const hidden = env.className.includes('hidden');
    env.className = hidden ? 'card-env' : 'card-env hidden';
    envBtn.textContent = hidden ? 'env ▴' : 'env ▾';
    if (hidden) redraw(); // draw from the patch when (re)shown
  });

  // OPEN at build: flip the affordance to the collapse glyph and
  // paint from the patch now (the select's default is the first
  // option — level, when the layer carries a levelEnv).
  envBtn.textContent = 'env ▴';
  redraw();

  // The card element API (see the header above): redraw for the
  // readout-sync pass, refresh for the card's modulator structural
  // rebuild (P5/S14 — rebuildModSection calls both halves of the
  // "modulator structure changed" event).
  card.envEditor = { redraw, refresh };
  return editor;
};

// ---- Per-card effect slots (plan P6/S15) ----------------------------
//
// The card footer's FX chain: one .fx-slot per entry of the chain's
// array — a type badge (FX_TYPE_LABELS from controls.js, REUSED, not
// duplicated), that slot's parameter knobs from describeFxList (the
// factory already emits the right descriptors with the right paths,
// including its "only fields the patch actually carries" rule — a
// snare shell resonator gets freq + Q, the engine-defaulted compress
// attack/release get no knobs), and the slot's own [✕] — plus the
// [+ fx] button and its compact type button group (the four engine fx
// types). The slot order is the array order: the engine applies the
// chain "in order" and the UI does not reorder (plan P6/S15).
//
// buildFxSlots is the SHARED implementation, parameterized by the
// chain's base path ('layers.<i>.effects' here; the master panel's
// 'masterEffects', P6/S16) so the card and the panel never drift
// apart. It re-derives everything from the LIVE patch on
// every call (the live-patch contract): a structural op (addFx /
// removeFx) replaces the patch wholesale, and the card's
// rebuildFxSection re-derives the slots from the fresh chain.
//
// The structural ops live in main.js (onFxAdd / onFxRemove): the pure
// op (patch-ops.js) returns a NEW patch (clone-first — the edited
// layer is a fresh object that the registry re-keys), and main.js
// calls the rebuild + updateDrum. The VALUE edits (the slot knobs)
// stay in cards.js: setPath -> onPatchEdit, like every other control.
//
// The [+ fx] button toggles the type group (hidden at build, so the
// footer stays compact); at the chain's 4-slot cap (MAX_FX_SLOTS from
// patch-ops.js — the SAME constant the op checks) the button is
// disabled (no handler) and an inline note sits beside it. An empty
// chain shows a muted "no fx" hint + the button.
//
// Returns { container, controls, rebuild }: the filled container, the
// slots' live-bound controls in build order (per slot: its knobs), and
// the re-derive hook the card's rebuildFxSection element API calls.
//
// Exported (plan P6/S16): the master panel (src/app/master-panel.js)
// reuses this EXACT implementation for the 'masterEffects' chain —
// one slot UI, two base paths, no drift (the plan's "extract it as
// buildFxSlots in cards.js so both the card and the panel share one
// implementation"). The structural callbacks are the caller's: the
// card's forward the layer index (initCardFxSlots), the master
// panel's forward nothing but the drum (its chain is always
// masterEffects), and each runs its own op + rebuild + updateDrum.
export const buildFxSlots = (
  container,
  drum,
  basePath,
  onPatchEdit,
  onFxAdd,
  onFxRemove,
) => {
  // The edit funnel the slot knobs share with the card's other
  // controls (drum.patch re-read per edit, never cached): the raw
  // value is read LIVE at commit time and the descriptor's optional
  // write transform (plan "dahdsr" P3/S2) is applied — a transformed
  // knob re-derives its value from the FRESH raw, so concurrent edits
  // compose instead of clobbering. (fx descriptors are plain
  // {min, max, step} knobs without transforms: the funnel passes
  // their value straight through.)
  const edit = (descriptor) => (v) => {
    const raw = getPath(drum.patch, descriptor.path);
    setPath(drum.patch, descriptor.path, descriptorWrite(descriptor, raw, v));
    onPatchEdit(drum);
  };

  // The chain's current fx objects: a lenient read (the engine's own
  // `layer.effects ?? []` convention — src/lib/engine.js) because a
  // layer may carry NO effects key at all, and getPath is strict
  // (src/lib/params.js: it would throw on the missing key). The base
  // path's shape was already validated by describeFxList (via
  // fxLabelPrefix) on the first fill and never changes.
  const chainOf = () => {
    const match = /^layers\.(\d+)\.effects$/.exec(basePath);
    if (match) return drum.patch.layers[Number(match[1])].effects ?? [];
    return drum.patch.masterEffects ?? [];
  };

  const state = { container, controls: [], rebuild: null };
  state.rebuild = () => {
    const chain = chainOf();
    // The chain's descriptors (the factory validates the base path and
    // every fx type — the drift guard); the knobs group per slot by
    // the slot's index in the descriptor path.
    const descriptors = describeFxList(chain, basePath);
    const atCap = chain.length >= MAX_FX_SLOTS;
    const children = [];
    const controls = [];

    if (chain.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'fx-empty';
      hint.textContent = 'no fx';
      children.push(hint);
    }

    chain.forEach((fx, j) => {
      const slot = document.createElement('div');
      slot.className = 'fx-slot';

      // The type badge (controls.js's FX_TYPE_LABELS — the same table
      // describeFxList uses for its knob labels; describeFxList above
      // has already thrown for a type the table does not list).
      const badge = document.createElement('span');
      badge.className = 'fx-badge';
      badge.textContent = FX_TYPE_LABELS[fx.type];
      slot.appendChild(badge);

      // That slot's parameter knobs: the describeFxList descriptors
      // whose path addresses THIS slot (the factory's field-presence
      // rule decides the set — freq + Q for a resonator, drive for a
      // saturator, ...). Each is live-bound like the card's other
      // controls.
      const prefix = `${basePath}.${j}.`;
      for (const descriptor of descriptors) {
        if (!descriptor.path.startsWith(prefix)) continue;
        const control = buildControl(drum, descriptor, edit);
        slot.appendChild(control);
        controls.push({ el: control, path: descriptor.path, descriptor });
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'fx-remove';
      remove.textContent = '✕';
      // Always enabled (assigned explicitly — the stub element has no
      // DOM default): the chain may empty, and the "no fx" hint
      // returns (unlike the card's own [✕], which keeps the drum's
      // last source).
      remove.disabled = false;
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        onFxRemove(drum, basePath, j);
      });
      slot.appendChild(remove);
      children.push(slot);
    });

    // The compact type group (hidden at build; the [+ fx] button
    // toggles it): the four engine fx types, the labels reused from
    // FX_TYPE_LABELS. A type click fires onFxAdd — main.js runs
    // addFx and rebuilds this section, so the group's active state
    // never has to persist.
    const types = document.createElement('div');
    types.className = 'fx-types hidden';
    types.appendChild(buildButtonGroup({
      label: '',
      options: Object.entries(FX_TYPE_LABELS)
        .map(([value, label]) => ({ value, label })),
      value: null, // no selection at build (the group never throws for it)
      onInput: (type) => onFxAdd(drum, basePath, type),
    }));

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'fx-add';
    add.textContent = '+ fx';
    add.disabled = atCap;
    if (!atCap)
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        types.className = types.className.includes('hidden')
          ? 'fx-types'
          : 'fx-types hidden';
      });
    children.push(add);
    children.push(types);

    if (atCap) {
      const note = document.createElement('span');
      note.className = 'fx-cap';
      note.textContent = `${MAX_FX_SLOTS} fx max`;
      children.push(note);
    }

    container.replaceChildren(...children);
    state.controls = controls;
  };

  state.rebuild();
  return state;
};

// initCardFxSlots — the per-card effect slots (plan P6/S15): fills the
// card footer's .card-fx container for THIS layer's chain
// ('layers.<i>.effects'). See buildFxSlots above for the DOM shape,
// the live-patch contract, and the returned state.
//
// The structural callbacks default to no-ops so a card can be built
// standalone (the tests do); main.js passes onFxAdd / onFxRemove
// (patch-ops.js's addFx / removeFx op + the rebuild + updateDrum).
// The adapter forwards the card's layerIndex in place of the base
// path — main.js's ops address the layer, the shared builder the
// chain.
export const initCardFxSlots = (
  card,
  drum,
  layerIndex,
  onPatchEdit = () => {},
  onFxAdd = () => {},
  onFxRemove = () => {},
) => {
  const container = findClass(card, 'card-fx');
  if (!container)
    throw new Error(
      "cards: initCardFxSlots needs the card footer's .card-fx container",
    );
  return buildFxSlots(
    container,
    drum,
    `layers.${layerIndex}.effects`,
    onPatchEdit,
    (d, p, type) => onFxAdd(d, layerIndex, type),
    (d, p, i) => onFxRemove(d, layerIndex, i),
  );
};

// The card skeleton shared by every source card (FM and noise):
//
// <section class="card">:
//   header.card-head   "Source <identity.label>" title (the CSS
//                      uppercases it), the type badge
//                      (the `badge` argument: 'FM' / 'NOISE'), the
//                      "add pitch env" button (FM cards whose layer
//                      carries NO pitchEnv — see below), the [⤓]
//                      per-source WAV export button (P8/S20 — main.js
//                      runs exportSource with the quality selects +
//                      the card's identity label), the [✕] remove
//                      button (wired to main.js's removeLayer op,
//                      P5/S13; disabled on the drum's last source), the
//                      solo indicator dot (LIT — the .active class —
//                      while the source is soloed, P7/S17); clicking
//                      the head makes this card the working source —
//                      onWorking(drum, layerIndex) (the band highlights
//                      its pitch curve, P4/S11); the section also
//                      carries the .muted class while the source is
//                      disabled (user-muted, P7/S17);
//   div.card-shape-row the CARRIER's wave-shape group (plan sinecontrol
//                      P3/S6, FM cards only): the card-level
//                      shape-group descriptor describeToggles emits
//                      (the carrier's shape — the per-modulator groups
//                      live in their mod blocks via the toggle
//                      pipeline). Built even when empty — a
//                      pre-materialization patch shows nothing (the
//                      CSS :empty hide, P3/S7);

//   div.knob-grid      the CARD-LEVEL knobs (the 3-column grid): one
//                      buildKnob per NON-modulator, NON-fx
//                      describeLayer descriptor (the carrier — pitch
//                      start / time / end or the constant freq — the
//                      level attack / release end, the gain), each
//                      live-bound to its patch path (setPath ->
//                      onPatchEdit); the fx descriptors live in the
//                      footer's fx slot list (P6/S15) — the knobs for
//                      a parameter exist in exactly ONE place, the
//                      slot that owns it;
//   div.mod-section    the FM card's DYNAMIC modulator sub-section
//                      (P5/S14, FM cards only — a noise card never
//                      gets one): a STABLE container whose content
//                      (buildModContent) rebuilds when the modulator
//                      STRUCTURE changes — one .mod-block per
//                      modulator (its own knob grid + toggle row + its
//                      [✕]) plus the [+ mod] button (disabled at the
//                      engine's 4-modulator limit);
//   footer.card-footer the [env] button (toggles the per-card
//                      envelope editor section built by
//                      initCardEnvelopeEditor, P4/S10) and the FX slot
//                      list (P6/S15, initCardFxSlots): one .fx-slot per
//                      entry of the layer's effects chain (type badge
//                      + that fx's parameter knobs + the slot's [✕])
//                      plus the [+ fx] button and its type group;
//                      rebuildFxSection re-derives it after a
//                      structural addFx / removeFx;
//   div.card-env       the per-card envelope editor (P4/S10): open at
//                      build (the volume envelope visible by default),
//                      the [env] button toggles it; a kind
//                      select + the 320×120 canvas editing this
//                      source's level / FM-depth envelopes (absent when
//                      the layer carries no editable envelope).
//
// `working` (this card is the working source) lands on the section as
// the .working class; `disabled` / `solo` (the mix-view state, P7/S17)
// land on it as the .muted class and the lit solo dot — main.js reads
// them from the drum's disabledLayers / soloLayers Sets (app-tier
// state, never patch data) and passes them in, because the row funnel
// rebuilds the card whenever they change; `identity` must carry the
// label (see the module
// header — the card never numbers itself). onPatchEdit / onWorking /
// onRemove default to no-ops so a card can be built standalone (the
// tests do); main.js passes onPatchEdit (plan P3/S8), onRemove (the
// structural op that drops this source from the drum's patch, plan
// P5/S13), onModAdd / onModRemove (the modulator structural ops, plan
// P5/S14 — FM cards only; a noise card never fires them),
// onFxAdd / onFxRemove (the fx-chain structural ops, plan P6/S15 —
// addFx / removeFx on this layer's chain; every card, noise included,
// can fire them: the engine applies a layer's fx chain after its
// levelEnv, any layer type), and onSourceExport (the per-source WAV
// export, plan P8/S20 — the head's [⤓] button: main.js runs
// export-wav.js's exportSource with the top bar's quality selects and
// the card's own identity label; the card holds no export code).
//
// Element API: `.controls` — the card's live-bound controls, each
// {el, path}: the carrier shape row's group first (plan sinecontrol
// P3/S6), then the card-level knob grid, then the modulator
// sub-section's (per block: its knobs, then its toggles), then the fx
// slot list's (per slot: its knobs). A live composition (a getter
// over the sub-sections' own lists), so a structural rebuild (P5/S14
// modulator, P6/S15 fx) is reflected without any re-assignment:
// main.js's readout-sync pass (plan P3/S8) walks this list and re-sets
// every control from the patch after each edit, so two controls on one
// path (the card level knob and the master fader, P7/S17) never drift
// apart. The card owns the binding list — main.js never re-derives it.
// `.rebuildModSection` (FM cards only) is the modulator structural
// rebuild hook (P5/S14); `.rebuildFxSection` is the fx structural
// rebuild hook (P6/S15); `.envEditor` is the per-card editor's
// { redraw, refresh } handle (P4/S10, refresh from P5/S14).
const buildCard = ({
  drum,
  layerIndex,
  layer,
  identity,
  badge,
  working = false,
  // Mix-view state (P7/S17), read from the drum's per-drum Sets by
  // main.js's rebuildCardRow — app-tier state, NOT patch data: the
  // card is rebuilt by the row funnel whenever the state changes, so
  // these flags are always fresh at build.
  disabled = false,
  solo = false,
  onPatchEdit = () => {},
  onWorking = () => {},
  onRemove = () => {},
  onModAdd = () => {},
  onModRemove = () => {},
  onFxAdd = () => {},
  onFxRemove = () => {},
  onSourceExport = () => {},
  // The preview canvas's click (a source with an editable envelope
  // only): open the full-screen constrained editor modal for this
  // source/kind (main.js wires it to envModal.open, plan "dahdsr"
  // P4/S1). A no-op by default — the card never opens anything itself.
  onEnvOpen = () => {},
}) => {
  const section = document.createElement('section');
  // 'working' marks the band's working source (P4/S11); 'muted' dims
  // a disabled (user-muted) source — the mix-view state is visible on
  // the card as well as on the strip's E button (P7/S17).
  const classes = ['card'];
  if (working) classes.push('working');
  if (disabled) classes.push('muted');
  section.className = classes.join(' ');

  // ---- card head -----------------------------------------------------
  const head = document.createElement('header');
  head.className = 'card-head';

  // The identity label is PASSED IN (new-ui.md §2.7): stable while the
  // card lives, cosmetic only — never derived from layerIndex. The label
  // already carries the "Source " prefix — no extra one here (the CSS
  // uppercases the title, rendering "SOURCE 2").
  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = identity.label;

  const badgeEl = document.createElement('span');
  badgeEl.className = 'card-badge';
  badgeEl.textContent = badge;

  // The "add pitch env" button (P4/S11): FM cards only, and only while
  // the layer carries NO pitchEnv. The band's working-source highlight
  // requires one (main.js's onWorking gate) — a constant-freq source is
  // not workable as-is, so its card offers this instead: one click
  // inserts a flat 2-point pitch envelope at the current carrier
  // frequency and selects the source as the working one, so the band
  // immediately shows its highlighted, editable curve. A pitchEnv layer
  // has no button (its pitch is edited in the band directly), a noise
  // card never does (the band edits FM pitch only). The patch schema
  // stays honest: an envelope exists only when the user wants one.
  let addPitch = null;
  if (layer.type === 'fm' && !layer.pitchEnv) {
    addPitch = document.createElement('button');
    addPitch.type = 'button';
    addPitch.className = 'card-add-pitch';
    addPitch.textContent = 'add pitch env';
    addPitch.addEventListener('click', (e) => {
      // setPath is strict (src/lib/params.js) and refuses to create the
      // missing pitchEnv key — and a wholesale layer replacement would
      // change the layer OBJECT, breaking the card registry's identity
      // (it keys on the live layer objects, new-ui.md §2.7) — so the
      // field is created IN PLACE on the live layer: one mutation.
      const freq = getPath(drum.patch, `layers.${layerIndex}.carrier.freq`);
      drum.patch.layers[layerIndex].pitchEnv = pitchEnvelope({
        from: freq,
        to: freq,
        // Span the full band: a flat 2-point envelope across the hit,
        // the user can then shape it (a zero-time envelope is
        // degenerate — the plan rejects it).
        time: drum.duration,
      });
      e.stopPropagation(); // don't double-fire the head's onWorking
      onPatchEdit(drum);
      onWorking(drum, layerIndex);
    });
  }

  // The per-source WAV export button (P8/S20, new-ui.md §7: "WAV export
  // of the mix and of individual sources"): renders THIS source in
  // isolation (export-wav.js's exportSource — the facade's isolateLayer)
  // and downloads it as a WAV named by the card's STABLE identity
  // ("kick-src2-…", not the layer index — the naming survives a remove-
  // first). main.js wires it (onSourceExport — with the top bar's
  // quality selects), like every other head action: the card holds no
  // export code. stopPropagation: the head click is the working-source
  // select, not an export.
  const sourceExport = document.createElement('button');
  sourceExport.type = 'button';
  sourceExport.className = 'card-export';
  sourceExport.textContent = '⤓';
  sourceExport.setAttribute('aria-label', `Export ${identity.label} as WAV`);
  sourceExport.addEventListener('click', (e) => {
    e.stopPropagation();
    onSourceExport(drum, layerIndex, identity.label);
  });

  // The [✕] remove button (P5/S13): onRemove(drum, layerIndex) is
  // main.js's structural op (patch-ops.js's removeLayer) — it drops
  // this source from the drum's patch and rebuilds the row without it,
  // the surviving cards keeping their identities (new-ui.md §2.7).
  // Disabled when this is the drum's LAST source: removeLayer refuses
  // to drop it (a drum keeps at least one source, mirroring the
  // removeDrum guard), and the disabled state is wired from the patch
  // length at build — rebuildCardRow runs on every structural change,
  // so the state is always fresh. A disabled button carries no
  // handler (a real disabled button would not dispatch click anyway).
  const removable = drum.patch.layers.length > 1;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'card-remove';
  remove.textContent = '✕';
  remove.disabled = !removable;
  if (removable)
    remove.addEventListener('click', (e) => {
      e.stopPropagation(); // the head click is the working-source select
      onRemove(drum, layerIndex);
    });

  // The solo indicator dot (P7/S17): LIT (the .active class) while the
  // source is soloed (the `solo` flag, read by main.js from the
  // drum's soloLayers Set — mix-view data, not patch data; a styled
  // span, not a control: the strip's S button is the solo's home).
  const soloDot = document.createElement('span');
  soloDot.className = solo ? 'card-solo active' : 'card-solo';

  head.appendChild(title);
  head.appendChild(badgeEl);
  if (addPitch) head.appendChild(addPitch);
  head.appendChild(sourceExport);
  head.appendChild(remove);
  head.appendChild(soloDot);
  head.addEventListener('click', () => onWorking(drum, layerIndex));
  section.appendChild(head);

  // ---- controls: the factory descriptors, live-bound to the patch ---
  // Every value is read through getPath at build time and every edit
  // goes setPath -> onPatchEdit — the card keeps no private copy of
  // the patch (see the module header). buildControl is the one
  // dispatch point: a descriptor shape no control covers throws there
  // (the factory-drift guard).
  // The card's edit funnel (drum.patch re-read per edit, never
  // cached): the raw value is read LIVE at commit time and the
  // descriptor's optional write transform (plan "dahdsr" P3/S2) is
  // applied — the DAHDSR level knobs re-derive the whole point array
  // from the FRESH raw, so concurrent edits compose instead of
  // clobbering. Plain descriptors pass their value straight through.
  const edit = (descriptor) => (v) => {
    const raw = getPath(drum.patch, descriptor.path); // re-read per edit
    setPath(drum.patch, descriptor.path, descriptorWrite(descriptor, raw, v));
    onPatchEdit(drum);
  };

  // The CARRIER's wave-shape row (plan sinecontrol P3/S6, FM cards
  // only): the card-level shape descriptors describeToggles emits
  // (the carrier's — their paths carry no `modulators.` segment; the
  // per-modulator groups flow through the mod-block toggle pipeline
  // below). A distinct row, not the knob grid (it holds a shape
  // group, not knobs); built even when EMPTY — a pre-materialization
  // patch (no shape fields) shows nothing (the CSS :empty hide,
  // P3/S7) — and its controls join the card's .controls list (the
  // readout-sync pass reaches them; the group's no-op setValue keeps
  // it loop-safe).
  const shapeRowControls = [];
  if (layer.type === 'fm') {
    const shapeRow = document.createElement('div');
    shapeRow.className = 'card-shape-row';
    for (const descriptor of describeToggles(layer, layerIndex)) {
      if (modIndexOf(descriptor, layerIndex) !== null) continue; // a modulator's
      const control = buildControl(drum, descriptor, edit);
      shapeRow.appendChild(control);
      shapeRowControls.push({ el: control, path: descriptor.path, descriptor });
    }
    section.appendChild(shapeRow);
  }

  // The card-level knob grid: the NON-modulator, NON-fx descriptors
  // (the carrier — pitch start / time / end or the constant freq — the
  // level attack / release end, the gain). The per-modulator
  // descriptors live in the dynamic modulator sub-section below
  // (P5/S14); the fx descriptors live in the footer's fx slot list
  // (P6/S15) — a parameter's knobs exist in exactly one place, the
  // sub-section that owns the parameter.
  const grid = document.createElement('div');
  grid.className = 'knob-grid';
  const gridControls = [];
  for (const descriptor of describeLayer(layer, layerIndex)) {
    if (modIndexOf(descriptor, layerIndex) !== null) continue; // a modulator's
    if (fxIndexOf(descriptor, layerIndex) !== null) continue; // an fx slot's
    const control = buildControl(drum, descriptor, edit);
    grid.appendChild(control);
    gridControls.push({ el: control, path: descriptor.path, descriptor });
  }
  section.appendChild(grid);

  // The dynamic modulator sub-section (P5/S14, FM cards only): a
  // STABLE container — the .mod-blocks and the [+ mod] button inside
  // it rebuild when the modulator structure changes (add/remove), and
  // the container itself (and the card around it) never moves: the
  // card's identity and its siblings stay put.
  let modSection = null;
  if (layer.type === 'fm') {
    modSection = document.createElement('div');
    modSection.className = 'mod-section';
    const fillModSection = () => {
      const { children, controls } = buildModContent(
        drum, layerIndex, edit, onModAdd, onModRemove,
      );
      modSection.replaceChildren(...children);
      modSection.controls = controls;
    };
    fillModSection();
    section.appendChild(modSection);
    // The element API for the structural rebuild (P5/S14): main.js's
    // modulator add/remove call it after the patch op replaced the
    // patch — only this sub-section re-derives from the fresh patch,
    // plus the envelope editor's option list (its fm-depth options
    // address modulator indexEnvs and go stale the same way).
    section.rebuildModSection = () => {
      fillModSection();
      section.envEditor?.refresh();
    };
  }

  // The card's live-bound controls — the element API the readout-sync
  // pass consumes (see the header above): one {el, path, descriptor}
  // entry per control (the descriptor rides along so the sync pass can
  // apply the funnel's read transform, plan "dahdsr" P3/S2) — the
  // carrier shape row's group first, then the card-level knobs, then
  // the modulator sub-section's (per block: its knobs, then its
  // toggles), then the fx slot list's (per slot: its knobs). A live
  // composition (a getter): each structural rebuild re-derives its
  // sub-section's list in place, so the sync pass always sees the
  // current set without any re-assignment.
  let fxState = null; // assigned by initCardFxSlots below (P6/S15)
  Object.defineProperty(section, 'controls', {
    get: () => [
      ...shapeRowControls,
      ...gridControls,
      ...(modSection?.controls ?? []),
      ...(fxState?.controls ?? []),
    ],
  });

  // ---- footer: envelope editor + fx slots (P6/S15) --------------------
  const footer = document.createElement('footer');
  footer.className = 'card-footer';

  // The per-card envelope editor's toggle (initCardEnvelopeEditor wires
  // it; a source with no editable envelope leaves it inert).
  const envBtn = document.createElement('button');
  envBtn.type = 'button';
  envBtn.className = 'card-env-btn';
  // The built-in affordance; initCardEnvelopeEditor flips it to
  // 'env ▴' when the source carries an (open) editor — an inert
  // source (no editable envelope) keeps 'env ▾'.
  envBtn.textContent = 'env ▾';

  // The FX slot list container (initCardFxSlots fills it with the
  // layer's effect chain, P6/S15).
  const fx = document.createElement('div');
  fx.className = 'card-fx';

  footer.appendChild(envBtn);
  footer.appendChild(fx);
  section.appendChild(footer);

  // The per-card envelope preview (plan "dahdsr" P4/S1): the [env] button
  // toggles the card's display-only level / pitch / FM-depth preview and
  // a click on the preview opens the full-screen modal (onEnvOpen). A
  // no-op (the button stays inert) when the layer carries no editable
  // envelope.
  initCardEnvelopeEditor(section, drum, layerIndex, onEnvOpen);

  // The per-card effect slots (plan P6/S15): the footer's .card-fx
  // container holds this layer's chain — one .fx-slot per fx (type
  // badge + that fx's parameter knobs + the slot's [✕]) plus the
  // [+ fx] button and its type group. A structural add/remove (main.js
  // onFxAdd / onFxRemove) replaces the patch wholesale, so the section
  // re-derives from the fresh chain through this element API hook.
  fxState = initCardFxSlots(section, drum, layerIndex, onPatchEdit, onFxAdd, onFxRemove);
  section.rebuildFxSection = () => fxState.rebuild();

  return section;
};

// buildFmCard — the FM source card (plan P3/S7, the milestone that
// proves the knob-card model): the shared card skeleton with the [FM]
// badge. Its knob grid carries the carrier (pitch start / time / end,
// or the constant freq), the level attack + release end, and the
// gain; its modulator sub-section (P5/S14) carries one .mod-block per
// modulator — each with that modulator's OWN freq + index (or FM
// index / FM decay) + feedback knobs and its ring group / cascade-
// target select — plus the [+ mod] button (capped at the engine's
// 4-modulator limit): the factory's shadowing rules decide the split.
export const buildFmCard = (opts) => {
  if (opts.layer.type !== 'fm')
    throw new Error(
      `cards: buildFmCard needs an "fm" layer, got ${JSON.stringify(opts.layer.type)}`,
    );
  if (!opts.identity?.label)
    throw new Error(
      'cards: buildFmCard needs an identity {label} — main.js mints the '
      + 'label; the card never computes its own cosmetic number',
    );
  return buildCard({ ...opts, badge: 'FM' });
};

// buildNoiseCard — the noise source card (plan P4/S9): the same card
// skeleton with the [NOISE] badge. Its knob grid is the describeLayer
// output for a noise layer — seed / cutoff / decay, the level attack +
// release end (the engine applies levelEnv to noise too), and the gain
// — and it carries no modulator sub-section: a noise layer has no
// ring and no cascade target (describeToggles emits nothing for it).
export const buildNoiseCard = (opts) => {
  if (opts.layer.type !== 'noise')
    throw new Error(
      `cards: buildNoiseCard needs a "noise" layer, got ${JSON.stringify(opts.layer.type)}`,
    );
  if (!opts.identity?.label)
    throw new Error(
      'cards: buildNoiseCard needs an identity {label} — main.js mints '
      + 'the label; the card never computes its own cosmetic number',
    );
  return buildCard({ ...opts, badge: 'NOISE' });
};
