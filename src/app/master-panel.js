// The master panel (binding layer, src/app/): the right-hand panel of
// the new-ui.md §3 layout — a column holding, in order: the MASTER
// heading, the hit-LENGTH fader, the OUTPUT LEVEL knob, the per-source
// FADER STRIP (P7/S17 — one level/enable/solo row per source, built
// by buildFaderStrip from the SAME identity registry as the card row
// and rebuilt with it by main.js's rebuildCardRow), and the MASTER
// effect chain.
//
// The panel BINDS TO THE DRUM it is built for (main.js rebuilds it at
// boot and on every drum switch — one atomic replace, the card row's
// pattern): the length fader reads the drum's duration, and the master
// fx chain edits the drum's masterEffects. The output level is the one
// thing that is NOT per-drum: it is a Web-Audio PLAYBACK-ONLY gain
// (main.js's app.outputLevel -> the master GainNode — legal per
// GUIDELINES §1.2, which allows output gain/routing; the gain node
// never shapes the rendered samples), and the patch schema carries NO
// master gain — so the mix level is a playback property, not patch
// data: it is not exported with the patch, and it does not survive a
// patch load. The knob's initial value (outputLevel) is passed in:
// this builder reads no global state.
//
// Library imports are facade-only (GUIDELINES §1.4(b)): the fader
// strip's level faders read their values through getPath at build
// time and edit layers.<i>.gain through setPath (the live-patch
// contract, like every other control) before funneling to the
// callbacks main.js passes in. UI METADATA is app-tier by
// construction (GUIDELINES §1.4(e)): the length fader's range lives in
// the constants below, the fx slots' ranges in controls.js's
// PARAM_RANGES (via describeFxList, inside the shared builder), the
// strip fader's range in the constants below.
//
// The live-patch contract (new-ui.md §2.8) applies to the fx chain
// exactly as on the cards: every slot knob reads through getPath at
// build time and edits through setPath(drum.patch, path, v) ->
// onPatchEdit(drum), drum.patch re-read per edit, never cached. The
// length fader is the one control that does NOT touch the patch —
// drum.duration is patch-adjacent DRUM data (the preset registry
// carries it beside the patch, not inside it), so no setPath and no
// patch-ops: its onInput funnels to onDurationChange(drum, seconds),
// which main.js applies to drum.duration and pushes through the
// updateDrum funnel (the preview re-renders at the new length, the
// band's time axis follows it).
//
// The master fx chain reuses cards.js's buildFxSlots — the SAME slot
// UI as the per-card chains (type badge, per-field knobs, the slot's
// [✕], the [+ fx] type group, the 4-slot cap), parameterized by
// basePath 'masterEffects' (plan P6/S16: "reuse the slot builder from
// cards.js ... so both the card and the panel share one
// implementation"). The structural callbacks default to no-ops so the
// panel can be built standalone (the tests do); main.js passes
// onFxAdd / onFxRemove (patch-ops.js's addFx / removeFx on
// 'masterEffects' + the section rebuild + updateDrum).

import { getPath, setPath } from '../lib/index.js';
import { buildFxSlots } from './cards.js';
import { buildFader, buildKnob } from './knob.js';

// The length fader's range (plan P6/S16): 0.1…2 s on a 10 ms grid.
// Length is one of the two controls new-ui.md §2.3 keeps LINEAR (the
// other is the per-source level fader of the strip, P7/S17) — a
// hit's length reads naturally on a linear axis, and the fader's
// native range input gives drag/click/keyboard stepping for free.
const LENGTH_MIN = 0.1;
const LENGTH_MAX = 2;
const LENGTH_STEP = 0.01;

// The output level knob's range: 0…1, the master GainNode's linear
// gain, 1 = unity (the default mix level).
const OUTPUT_MIN = 0;
const OUTPUT_MAX = 1;
const OUTPUT_STEP = 0.01;

// The strip's per-source level fader range: 0…1, the layer gain —
// the SAME range and grid as the card's gain knob (controls.js's
// 'layer.gain' descriptor: 0…1 on a 0.01 grid), so the two writers of
// one path always agree and the sync pass never sees an off-grid
// value.
const LEVEL_MIN = 0;
const LEVEL_MAX = 1;
const LEVEL_STEP = 0.01;

// buildFaderStrip — the per-source fader strip (plan P7/S17): fills
// `container` with ONE .level-row per layer, in PATCH ORDER, labeled
// by the source's STABLE identity — the registry's id as "L" + id,
// the same number the card head shows as "Source N", so the strip and
// the cards always AGREE (a remove-first leaves the strip's "L3" row
// named "L3", not renumbered to "L2" — the P5/S13 identity pattern).
// The rows are generated from the registry, never from array indices:
// a layer missing from the registry is a wiring bug and fails loudly
// instead of being silently numbered by position.
//
// Row content — the row is the mix-view CONTROL surface (the fader is
// a patch edit, the toggles are app-tier state):
//   div.fader           buildFader 0…1 step 0.01 on layers.<i>.gain —
//                       the TWIN of the card's gain knob (same range,
//                       same grid, same path: both write layers.<i>
//                       .gain, and main.js's sync pass —
//                       syncStripReadouts + syncCardReadouts — keeps
//                       both displays in step after any edit);
//   div.level-buttons   button.level-play "▶" — the row's AUDITION
//                       (P7/S18, new-ui.md §7: the L-row doubles as
//                       the solo trigger): a click fires onSourcePlay
//                       (drum, layerIndex, the row's identity label) —
//                       main.js renders withSolo(patch, [i]) (that one
//                       source, the others zeroed — the audition plays
//                       the source as it is, even if the mix view mutes
//                       it) into a TEMPORARY buffer (the mix buffer is
//                       untouched) and plays it, with the band
//                       playhead under it; button.level-enable "E" —
//                       pressed/active while the layer is ENABLED (the
//                       default; all sources start enabled). A click
//                       fires onEnableToggle: main.js toggles
//                       drum.disabledLayers — APP-TIER STATE, NOT PATCH
//                       DATA: muting is a mix-view choice, so the
//                       patch's gain (and the exported/saved patch) is
//                       untouched — the disabled layer is zeroed only
//                       in the render-ready view (main.js's mixedPatch,
//                       patch-ops.js's mixView); button.level-solo "S"
//                       — pressed/active while SOLOED (the default:
//                       off); onSoloToggle drives drum.soloLayers the
//                       same way (any solo active -> the mix keeps
//                       soloed ∩ enabled, so a soloed-but-disabled
//                       source is silent).
//
// opts: { onPatchEdit, onEnableToggle, onSoloToggle, onSourcePlay } —
// the funnels (no-ops by default, so the strip can be built
// standalone, as the tests do; main.js passes its updateDrum / toggle
// funnels + its per-source audition).
//
// Returns { container, controls }: the filled container and the
// faders' live-bound entries [{ el, path }] in row order — the element
// API main.js's syncStripReadouts walks (the card .controls pattern).
export const buildFaderStrip = (container, drum, registry, {
  onPatchEdit = () => {},
  onEnableToggle = () => {},
  onSoloToggle = () => {},
  onSourcePlay = () => {},
} = {}) => {
  const controls = [];
  const rows = [];

  drum.patch.layers.forEach((layer, i) => {
    // The label binds the row to the SOURCE's stable identity (the
    // registry's id — "Source N" on the card, "LN" here), never to
    // its array position (new-ui.md §2.7 — the strip and the cards
    // always agree). A missing entry is a wiring bug: fail loudly
    // instead of numbering from the index.
    const entry = registry?.get(layer);
    if (!entry)
      throw new Error(
        `master-panel: buildFaderStrip needs an identity-registry entry `
        + `for layer ${i} (the rows are labeled by the stable identity, `
        + 'never the array index)',
      );
    const name = `L${entry.id}`;
    const path = `layers.${i}.gain`;

    const row = document.createElement('div');
    row.className = 'level-row';

    // The level fader: the twin of the card's gain knob — both write
    // layers.<i>.gain (the live-patch contract: drum.patch re-read per
    // edit, never cached), and main.js's sync pass keeps both displays
    // from drifting apart (the two-writers problem, P3/S8).
    const fader = buildFader({
      label: name,
      min: LEVEL_MIN,
      max: LEVEL_MAX,
      step: LEVEL_STEP,
      value: getPath(drum.patch, path),
      onInput: (v) => {
        setPath(drum.patch, path, v);
        onPatchEdit(drum);
      },
    });
    controls.push({ el: fader, path });
    row.appendChild(fader);

    const buttons = document.createElement('div');
    buttons.className = 'level-buttons';

    // The audition button (P7/S18): plays this one source alone — the
    // callback carries the row's identity label (the registry's
    // "Source N"), which main.js registers the playhead under
    // ('src:<label>'). First in the column: the row's primary action.
    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'level-play';
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', `Play ${entry.label}`);
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onSourcePlay(drum, i, entry.label);
    });
    buttons.appendChild(playBtn);

    // The enable toggle (PRESSED/active while the layer is ENABLED —
    // the default). The current state is read from the drum's mix-view
    // Set (a lenient read: a standalone drum without the Set is
    // fully-enabled — main.js initializes the Sets at boot).
    const enabled = !(drum.disabledLayers?.has(layer));
    const enableBtn = document.createElement('button');
    enableBtn.type = 'button';
    enableBtn.className = enabled ? 'level-enable active' : 'level-enable';
    enableBtn.textContent = 'E';
    enableBtn.setAttribute('aria-pressed', String(enabled));
    enableBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onEnableToggle(drum, i);
    });
    buttons.appendChild(enableBtn);

    // The solo toggle (PRESSED/active while SOLOED — the default: off).
    const soloed = drum.soloLayers?.has(layer) ?? false;
    const soloBtn = document.createElement('button');
    soloBtn.type = 'button';
    soloBtn.className = soloed ? 'level-solo active' : 'level-solo';
    soloBtn.textContent = 'S';
    soloBtn.setAttribute('aria-pressed', String(soloed));
    soloBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onSoloToggle(drum, i);
    });
    buttons.appendChild(soloBtn);

    row.appendChild(buttons);
    rows.push(row);
  });

  container.replaceChildren(...rows);
  return { container, controls };
};

// buildMasterPanel — the right-hand panel (plan P6/S16).
//
// opts:
//   drum              the drum the panel binds to (its duration and
//                     patch.masterEffects);
//   outputLevel       the current mix level (main.js's app.outputLevel
//                     — the global playback gain, see the header);
//   onPatchEdit       the funnel a slot knob edit funnels into
//                     (main.js's updateDrum: re-render preview +
//                     playback, repaint the band, sync the readouts);
//   onDurationChange  (drum, seconds) — the length fader's funnel
//                     (main.js sets drum.duration and runs the
//                     updateDrum funnel; no patch-ops — the duration
//                     is not patch data);
//   onOutputLevel     (value) — the output knob's funnel (main.js
//                     stores app.outputLevel and sets the master
//                     gain);
//   onFxAdd / onFxRemove
//                     (drum, type) / (drum, slotIndex) — the master
//                     chain's structural ops (main.js runs the pure op
//                     on 'masterEffects', rebuilds the fx section, and
//                     updates the drum). No-ops by default;
//   onEnableToggle / onSoloToggle
//                     (drum, layerIndex) — the strip's E / S funnels
//                     (P7/S17; main.js toggles the drum's mix-view
//                     Sets and rebuilds the row). No-ops by default;
//   onSourcePlay
//                     (drum, layerIndex, label) — the strip's ▶
//                     audition funnel (P7/S18; main.js renders
//                     withSolo(patch, [i]) into a temporary buffer and
//                     plays it, playhead under it). No-op by default.
//
// DOM shape (a column — the CSS makes .master-inner a flex column):
//   span.master-title   "MASTER";
//   div.fader           the length fader (knob.js's buildFader — the
//                       linear control kept where linearity is the
//                       point, new-ui.md §2.3); value = drum.duration;
//   div.knob            the output level knob (buildKnob 0…1); value
//                       = outputLevel;
//   div.level-strip     the per-source fader strip (P7/S17): EMPTY at
//                       build — main.js's rebuildCardRow fills it via
//                       the `rebuildStrip` element API below, ONE
//                       structural funnel for the card row and the
//                       strip (they can never desync):
//                       one level row per source, in patch order,
//                       labeled by the stable identity;
//   div.master-fx       the master effect chain: cards.js's shared
//                       slot UI on basePath 'masterEffects' (one
//                       .fx-slot per entry — badge + parameter knobs +
//                       [✕] — the "no fx" hint for an empty chain, the
//                       [+ fx] button, its type group, the 4-slot cap
//                       note).
//
// Element API:
//   `rebuildFxSection` re-derives the fx section from the LIVE patch
//                       (the card's rebuildFxSection pattern) —
//                       main.js's master fx structural ops call it
//                       after the op replaced the patch wholesale, so
//                       the slots re-read the fresh masterEffects
//                       chain;
//   `rebuildStrip(registry)` (P7/S17) re-derives the strip from the
//                       LIVE patch + the drum's identity registry —
//                       main.js's rebuildCardRow calls it after the
//                       registry is fresh (one structural funnel for
//                       both views; the row count, the stable labels,
//                       and the E/S states always agree with the
//                       cards);
//   `stripControls` the strip faders' live-bound entries [{el, path}]
//                       in row order (re-derived by rebuildStrip) —
//                       the list main.js's syncStripReadouts walks in
//                       the two-writers sync pass (the card .controls
//                       pattern).
export const buildMasterPanel = ({
  drum,
  outputLevel,
  onPatchEdit = () => {},
  onDurationChange = () => {},
  onOutputLevel = () => {},
  onFxAdd = () => {},
  onFxRemove = () => {},
  onEnableToggle = () => {},
  onSoloToggle = () => {},
  onSourcePlay = () => {},
}) => {
  const panel = document.createElement('div');
  panel.className = 'master-inner';

  const title = document.createElement('span');
  title.className = 'master-title';
  title.textContent = 'MASTER';
  panel.appendChild(title);

  // The hit length: patch-adjacent drum data, not patch data — the
  // funnel (onDurationChange) owns drum.duration; there is no setPath
  // here and no descriptor (the readout carries no unit — the label
  // does not mention Hz, formatKnobValue's label-driven rule).
  panel.appendChild(buildFader({
    label: 'length',
    min: LENGTH_MIN,
    max: LENGTH_MAX,
    step: LENGTH_STEP,
    value: drum.duration,
    onInput: (seconds) => onDurationChange(drum, seconds),
  }));

  // The output level: the playback-only master gain (see the module
  // header). format is null (no controls.js descriptor — the gain is
  // not a patch parameter), so the readout is a bare number.
  panel.appendChild(buildKnob({
    label: 'output level',
    min: OUTPUT_MIN,
    max: OUTPUT_MAX,
    step: OUTPUT_STEP,
    value: outputLevel,
    format: null,
    onInput: onOutputLevel,
  }));

  // The per-source fader strip container (P7/S17): EMPTY at build —
  // main.js's rebuildCardRow fills it via rebuildStrip below (one
  // structural funnel for the card row and the strip): one
  // level/enable/solo row per source, in patch order, labeled by the
  // sources' STABLE identity — built from the same registry as the
  // card row, never from array indices.
  const strip = document.createElement('div');
  strip.className = 'level-strip';
  panel.appendChild(strip);

  // The master effect chain: the shared slot UI (cards.js) on the
  // 'masterEffects' base path — the same slots, badges, knobs, [+ fx]
  // type group, and 4-slot cap as the card chains. The adapters drop
  // the base path argument: this panel's chain is ALWAYS
  // masterEffects, so the panel-scoped callbacks need no path.
  const fxSection = document.createElement('div');
  fxSection.className = 'master-fx';
  panel.appendChild(fxSection);
  const fxState = buildFxSlots(
    fxSection,
    drum,
    'masterEffects',
    onPatchEdit,
    (d, _basePath, type) => onFxAdd(d, type),
    (d, _basePath, j) => onFxRemove(d, j),
  );

  // The element API (see the header above): the structural rebuild
  // hooks main.js calls — the fx section after addFx / removeFx
  // replaced the patch, the strip after the card row (and the
  // registry) changed.
  panel.rebuildFxSection = () => fxState.rebuild();
  panel.stripControls = []; // filled by rebuildStrip (the sync pass walks it)
  panel.rebuildStrip = (registry) => {
    panel.stripControls = buildFaderStrip(strip, drum, registry, {
      onPatchEdit,
      onEnableToggle,
      onSoloToggle,
      onSourcePlay,
    }).controls;
  };
  return panel;
};
