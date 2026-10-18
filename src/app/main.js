// The binding layer's entry point (ES module) — the only script
// index.html loads (GUIDELINES §1.4(c)). It owns the page shell
// (new-ui.md §3) and its wiring: the drum list (the classic three
// booted from the preset registry, src/app/presets.js), the top bar
// (the drum select switches the drum on screen — setActiveDrum;
// the "+ drum" button appends a CUSTOM drum built from the Blank
// preset — the first spare hue no drum uses, starting out of the
// tempo loop, then switched to — onAddDrum, plan "colors" S5;
// the TRIGGER plays the active drum's mix one-shot, P7/S18; the preset
// select LOADS a preset or a saved slot into the active drum — the
// card row replaced wholesale, the identity registry + mix-view state
// reset, P8/S19 — and the Save button stores the active drum in the
// named slot the inline input holds (no prompt() — the input is the
// harness-exercisable path); the localStorage guard: unavailable
// storage shows a visible note in the preset area, never a crash; the
// JSON-Export button downloads the active drum's formatted
// { name, duration, patch } JSON (presets.js's drumToJson through
// export-wav.js's downloadText — the shared Blob/anchor pattern), the
// JSON-Import button opens the HIDDEN file input whose change reads the
// file, validates it (jsonToDrum — errors land in the preset note), and
// replaces the active drum's patch + duration wholesale (the preset-
// load path — the identity registry reset, the panel re-bound, P8/S20),
// and the WAV-Export button downloads the active drum's MIX at the
// quality selects' current values (the old per-drum export row rebuilt
// as top-bar controls — rate/bits next to the button), while each card
// head's [⤓] downloads that ONE source in isolation (exportSource —
// the facade's isolateLayer) named by the card's stable identity
// ("kick-src2-…", not the layer index); the transport group (P8/S21)
// is the tempo LOOP — the Loop toggle starts / stops the lookahead
// scheduler (the 25 ms tick / 100 ms-ahead pattern, the AudioContext
// clock holds the rhythm), the BPM slider sets the beat length (60…200,
// re-read per beat), and the "In loop" checkbox next to the drum
// select sets the ACTIVE drum's inLoop flag (the three boot drums start
// in the loop): every beat fires each in-loop drum's current mix
// buffer (drum.playback — the enable/solo mix view) on the beat's grid
// time, and the band playhead tracks the active drum's latest play),
// and the
// top band (src/app/band.js's drawBand: the mix
// waveform + the FM sources' pitch curves with note labels, and the
// waveform/spectrum toggle — the band's math and drawing live in
// band.js, viz.js supplies the shared canvas primitives). The band's
// WORKING source (P4/S11): clicking a card head makes that source the
// working one (onWorking — FM layers with a pitchEnv only; a
// constant-freq FM source shows its card's "add pitch env" button
// instead, cards.js) and its pitch curve in the band is HIGHLIGHTED
// (full opacity + a wider line + point circles). The band itself is a
// READ-ONLY overview (plan "dahdsr" P4/S2 — its editing half is
// retired): precise pitch editing lives in the card preview /
// full-screen editor modal (env-editor.js's constrained 2-anchor
// pitch form).
// The card row is built from the active drum's patch (rebuildCardRow: one
// knob card per layer via src/app/cards.js — the FM card and the noise
// card), atomically: the full row is built in a detached fragment and
// swapped into #cards-row in one replace. Card identity (new-ui.md
// §2.7): the per-drum registry app.cards maps each live LAYER OBJECT
// to { id, label, cardEl } — the label ('Source N', N the drum's
// monotonic cardSeq) is minted once when the card is first built and
// never reassigned while the card lives: a structural op carries the
// surviving layer references over (patch-ops.js), so their identities
// survive, and a removed layer's entry is deleted — removing the first
// source never renumbers "Source 3". The add-source row ([+ FM source]
// / [+ noise source]) and each card's [✕] make those structural
// changes: the drum's patch is replaced WHOLESALE with the op's result
// (addLayer / removeLayer), rebuildCardRow rebuilds the row, and
// updateDrum refreshes the band + readouts; the 8-layer cap surfaces
// as an inline error in the add-source row, never a crash. The FM
// card's modulator sub-section (P5/S14): the card's [+ mod] button and
// each modulator block's [✕] make the CARD-INTERNAL structural changes
// (addModulator / removeModulator — the engine's 4-modulator limit caps
// the add, removal is allowed down to zero — a plain sine): the patch
// is replaced WHOLESALE with the op's result again, but the edited
// layer is a FRESH object (clone-first), so the registry entry and the
// working-source reference are re-pointed to it (the identity moves
// with the source, not the object), and ONLY that card's modulator sub-
// section rebuilds — the card element, its identity, and its siblings
// are untouched (no row rebuild) — before updateDrum refreshes
// everything from the patch. The card footer's fx slots (P6/S15): each
// card's effect chain renders as one .fx-slot per fx (its type badge,
// that fx's parameter knobs, the slot's [✕]) plus the [+ fx] button
// and its type group — a type click or a slot's [✕] runs the pure op
// (addFx / removeFx on that layer's 'layers.<i>.effects' chain, the
// 4-slot cap capping the add), the edited layer re-keys, and ONLY that
// card's fx sub-section rebuilds (the master chain and the other cards
// are untouched) before updateDrum refreshes everything from the
// patch. The top
// bar's drum select switches the band and the card row between the
// drums (setActiveDrum), and every parameter change funnels through
// updateDrum — re-render the preview, repaint the band from
// the fresh patch, sync the card readouts, and re-render the playback
// buffer once a gesture created the AudioContext. The master panel
// (P6/S16): src/app/master-panel.js builds the right-hand panel and it
// BINDS TO THE ACTIVE DRUM — built at boot and rebuilt on every drum
// switch (one atomic replace): the hit-length fader (0.1…2 s —
// patch-adjacent drum data, NOT patch data: its funnel sets
// drum.duration and runs updateDrum, so the preview re-renders at the
// new length and the band's time axis follows it), the output-level
// knob (0…1 — a Web-Audio playback-only gain: the patch schema has no
// master gain, so the mix level is a playback property, app.outputLevel,
// stored before the first gesture and applied to the master
// GainNode once it exists — GUIDELINES §1.2), the per-source fader
// strip (P7/S17) — one level/enable/solo row per source, in patch
// order, labeled by the sources' STABLE identity ("LN" = the card's
// "Source N", the same registry), and the master effect chain — the
// cards.js shared fx slot UI on 'masterEffects' (its addFx / removeFx
// ops touch no layer objects, so they skip the registry re-key and
// rebuild only the panel's fx section before updateDrum). The strip
// rebuilds with the card row (rebuildCardRow — ONE structural funnel
// for both views, so an add/remove source can never desync them). The
// strip's faders TWIN the cards' gain knobs (both write layers.<i>
// .gain; the sync pass keeps both displays in step), and its E / S
// buttons drive the per-drum MIX-VIEW state — drum.disabledLayers /
// drum.soloLayers, Sets of layer objects: muting/soloing is a
// MIX-VIEW choice, NOT patch data (the exported/saved patch is
// untouched) — the disabled layers are zeroed only in the render-ready
// view (mixedPatch, patch-ops.js's mixView: the disabled layers
// zeroed, any solo active keeping only the soloed ∩ enabled, nothing
// kept = silence), which the preview and the playback buffer render.
// Playback (P7/S18) — the old loop/trigger code's concepts (new-ui.md
// §4: "survive in concept"), re-wired to the one-band layout: the
// Trigger plays the active drum's CURRENT mix view (drum.playback —
// rendered by renderPlayback at the AudioContext's rate on every
// updateDrum, disabled/solo zeroing included) through a fresh
// AudioBufferSourceNode, and a strip row's ▶ plays that ONE SOURCE
// (patch-ops.js's withSolo on the raw patch — an audition that plays
// the source as it is, even if the mix view mutes it) into a TEMPORARY
// buffer, so a solo play never replaces the mix buffer. The
// AudioContext stays lazy (ensureAudioContext — the first trigger or
// ▶ click is the gesture that creates it; autoplay policy). The yellow
// playhead (viz.js's drawPlayhead) rides the BAND canvas — and, while
// the env-editor modal is open for the on-screen drum, the modal's
// plot + waveform strip too (plan "dahdsr" P4/S1/S2): every play is
// registered (registerPlay:
// 'mix' for the Trigger, 'src:<identity label>' for a row's ▶, and the
// drum's NAME for a loop beat — P8/S21; latest per key wins) and a
// self-terminating requestAnimationFrame chain (playheadFrame)
// recomputes x = timeToX(now − startedAt, drum.duration, W) from the
// audio clock each frame, repainting the band base underneath first
// (redrawPlayheadBase — the cursor hovers instead of leaving stale
// stripes); rAF runs only while something plays, and the last frame's
// repaint is what removes the line. The tempo LOOP (P8/S21) reuses
// this same registration + playhead: each beat of each in-loop drum
// registers under that drum's name on the beat's grid time (up to 100
// ms ahead — playheadFrame holds a not-yet-started beat, t < 0, alive
// without drawing it), so the band's one line tracks the ACTIVE drum's
// latest play whether it came from the Trigger, a ▶, or the loop.
//
// Thin UI layer per GUIDELINES §3: this file only reads/writes patch
// parameters, calls renderPatch through the library facade
// src/lib/index.js (the only lib module this file imports), touches
// the DOM, and schedules playback. No audio-rate math: all synthesis
// is in the pure engine modules; Web Audio is playback only
// (GUIDELINES §1.2) — AudioBuffer → AudioBufferSourceNode → master
// GainNode → destination.

import { clamp, getPath, renderPatch, setPath } from '../lib/index.js';
import {
  PRESETS,
  presetById,
  presetOptions,
  addDrum,
  uniqueDrumName,
  listSlots,
  loadSlot,
  saveSlot,
  slotNameFromValue,
  drumToJson,
  jsonToDrum,
} from './presets.js';
import {
  EXPORT_BITS,
  EXPORT_DEFAULTS,
  EXPORT_RATES,
  downloadText,
  exportDrum,
  exportSource,
} from './export-wav.js';
import { COLORS, DRUM_COLORS, drawPlayhead, timeToX } from './viz.js';
import { BAND_SOURCE_COLORS, EXTRA_DRUM_COLORS, THEME } from './theme.js';
import {
  BAND_CURVE_SAMPLES,
  drawBand,
  pitchCurvePoints,
} from './band.js';
import { buildButtonGroup } from './knob.js';
import { buildFmCard, buildNoiseCard } from './cards.js';
import { initEnvModal } from './env-modal.js';
import { descriptorRead } from './controls.js';
import { buildMasterPanel } from './master-panel.js';
import {
  addFx,
  addLayer,
  addModulator,
  mixView,
  removeFx,
  removeLayer,
  removeModulator,
  withSolo,
} from './patch-ops.js';

// The classic three voices the app boots — the same boot list as the
// tabbed layout it replaces — folded into the drum list via addDrum
// (src/app/presets.js): one { name, duration, patch } entry each, with
// a deep-cloned live patch the UI edits in place (setPath).
const BOOT_PRESETS = ['kick', 'snare', 'hihat'];

// Module-level UI state — the one clearly named I/O boundary
// (GUIDELINES §3): the live patches, the lazily created AudioContext +
// master gain (first transport gesture creates it), the play
// registrations for the (later) playback cursor, and the output level
// (a Web-Audio-only playback gain — the patch schema has no master gain).
//
// Exported so the headless DOM-stub harness (tmp/, git-ignored — there
// is no browser in this environment) can assert on the live session
// state: the patches, the rendered buffers, the card registry. The
// browser never reads the export.
export const app = {
  drums: BOOT_PRESETS.reduce((list, id) => addDrum(list, id), []),
  activeDrum: 'kick', // drum the band and the card row show
  cards: new Map(), // drum name -> Map<layer object, { id, label, cardEl }>
  masterPanel: null, // the built master panel element (binds to the active drum, P6/S16)
  ctx: null,
  master: null,
  plays: new Map(), // play key ('mix' | 'src:<label>') -> {startedAt, duration, drumName} — LATEST play per key
  playheadRaf: 0, // requestAnimationFrame handle, 0 = idle
  playheadOn: false, // the band canvas currently shows a drawn playhead line
  outputLevel: 1,
  envModal: null, // the envelope-editor modal (P4/S1) — set after construction below
};

// The per-drum UI state every drum entry needs, whatever created it —
// the boot (the classic three) or the top bar's "+ drum" (a custom
// blank-starting drum — onAddDrum below). The one argument: the tempo-
// loop flag (P8/S21) — app-tier transport state, NOT patch data. The
// three boot drums start IN the loop (the top bar's "In loop" checkbox
// is checked by default — the loop plays the classic three out of the
// box); a drum added later starts OUT of it (the user checks it in).
const prepareDrumState = (drum, inLoop) => {
  // The band's working source (P4/S11): the LAYER OBJECT the band
  // highlights and makes pitch-editable — null = none (the default).
  // An object, not an index: like the card registry (app.cards), it
  // binds to the source itself, so a wholesale patch replacement (P5/
  // P8) stops resolving and the highlight clears by identity.
  drum.workingSource = null;
  // The mix view (P7/S17): the per-drum enable/solo state — Sets of
  // LAYER OBJECTS (the identity key, like the registry: a removal
  // shifts the other layers' INDICES but not their objects, so the
  // state survives structural changes; removeSource prunes the dead
  // entry, rekeyLayer re-points it across the mod/fx ops' clone-first
  // layer replacement). APP-TIER STATE, not patch data: the drum's
  // patch — what is exported/saved — is never touched; the state is
  // applied only to the render-ready view (mixedPatch).
  drum.disabledLayers = new Set();
  drum.soloLayers = new Set();
  // The card identity counter (revamp S8/S13): the row rebuild mints
  // 'Source ' + ++cardSeq once per layer — 0 (absent) starts the count.
  drum.cardSeq = 0;
  drum.inLoop = inLoop;
};

// Each entry also carries `color` — the hex the UI paints with (band
// traces, card accents). Preset drums seed it from DRUM_COLORS
// (src/app/theme.js — all seven preset hues); custom drums take a
// spare palette color (colorForNewDrum).
for (const d of app.drums) {
  d.color = DRUM_COLORS[d.name];
  prepareDrumState(d, true);
}

// Custom (non-preset) drums have no DRUM_COLORS entry, and an
// undefined canvas strokeStyle would silently keep the previous
// trace's color, so each takes a spare hue — EXTRA_DRUM_COLORS, the
// single source in src/app/theme.js: the first color no current drum
// uses; past the palette's length the colors repeat (a list that long
// is already crowded).
//
// Assign the just-appended drum (always the list's last entry — the
// "+ drum" button's onAddDrum; the boot drums are seeded from
// DRUM_COLORS instead) its color and return the list — it mutates only
// the fresh entry, so nothing shared is touched.
const colorForNewDrum = (drums) => {
  const used = new Set(drums.map((d) => d.color).filter(Boolean));
  drums[drums.length - 1].color =
    EXTRA_DRUM_COLORS.find((c) => !used.has(c))
    ?? EXTRA_DRUM_COLORS[drums.length % EXTRA_DRUM_COLORS.length];
  return drums;
};

// Fixed preview render rate for the canvas buffers: 48 kHz, the
// app's base rate and the production-audio standard. The hi-hat's top
// partial is ~20.5 kHz, which sits well under the 24 kHz Nyquist (it
// would alias at the 22.05 kHz tier — the documented low-tier trade,
// still relevant for the 22.05 kHz EXPORT option).
const PREVIEW_RATE = 48000;

// DOM handles for the shell parts this step wires (the rest are wired
// by later steps — see the header).
const bandCanvas = document.getElementById('band-canvas');
const bandModeSlot = document.getElementById('band-mode-slot');
const cardsRow = document.getElementById('cards-row');
const masterPanelEl = document.getElementById('master-panel');
const drumSelect = document.getElementById('drum-select');
const addDrumBtn = document.getElementById('add-drum-btn');
const presetSelect = document.getElementById('preset-select');
const saveBtn = document.getElementById('save-btn');
const slotNameInput = document.getElementById('slot-name-input');
const presetNoteEl = document.getElementById('preset-note');
const drumNameEl = document.getElementById('drum-name');
const lengthValueEl = document.getElementById('length-value');
const bandErrorEl = document.getElementById('band-error');
const addFmBtn = document.getElementById('add-fm-btn');
const addNoiseBtn = document.getElementById('add-noise-btn');
const addErrorEl = document.getElementById('add-source-error');
const triggerBtn = document.getElementById('trigger-btn');
const jsonExportBtn = document.getElementById('json-export-btn');
const jsonImportBtn = document.getElementById('json-import-btn');
const jsonImportInput = document.getElementById('json-import-input');
const wavExportBtn = document.getElementById('wav-export-btn');
const wavRateSelect = document.getElementById('wav-rate-select');
const wavBitsSelect = document.getElementById('wav-bits-select');
const loopToggle = document.getElementById('loop-toggle');
const bpmSlider = document.getElementById('bpm');
const bpmValue = document.getElementById('bpm-value');
const inloopToggle = document.getElementById('inloop-toggle');
// The topbar (plan "dahdsr" P4/S1): the env-editor modal measures its
// height on open so the overlay starts BELOW it (the trigger / loop
// transport stay live above the overlay).
const topbarEl = document.getElementById('topbar');

// The drum entry the band currently shows.
const getActiveDrum = () => app.drums.find((d) => d.name === app.activeDrum);

// ---- The full-screen envelope-editor modal (plan "dahdsr" P4/S1) ---
// The overlay element is created in the app root (document.body) at
// boot, hidden; a card preview's click opens it for that source/kind
// (onEnvOpen below). Edits flow through onEdit: setPath + updateDrum —
// the existing re-render / readout-sync pass keeps the card knobs, the
// band, the card preview and (updateDrum's redraw below) the modal
// plot + its isolated-source waveform strip in sync. The modal closes
// on drum switch and preset load (the stale-state rule — a modal open
// on drum A must never draw drum B's patch).
const envModal = initEnvModal({
  root: document.body,
  topbar: topbarEl,
  onEdit: (drum, path, points) => {
    setPath(drum.patch, path, points);
    updateDrum(drum);
  },
});
// The headless harness (tmp/, git-ignored) asserts on the modal's DOM
// (the overlay, the kind select, the plot canvas) through this handle;
// the browser never reads the export (the bandCurvesFor precedent).
app.envModal = envModal;

// The user-facing spelling of a drum name: the preset's label when the
// name is a registry id (the classic three boot that way), the name
// capitalized otherwise (renamed/new drums — a later step).
const drumLabel = (name) => {
  try {
    return presetById(name).label;
  } catch {
    return name[0].toUpperCase() + name.slice(1);
  }
};

// Create the AudioContext lazily — browsers keep audio suspended until
// a user gesture (autoplay policy), and the first transport action
// (wired by P8) is the gesture that creates it. The context requests
// the app's base rate — 48 kHz, the highest-quality playback profile
// the browser can offer. Per the Web Audio spec a browser that cannot
// natively run at the requested rate resamples (or falls back to its
// device rate); either way ctx.sampleRate reports the rate playback
// actually happens at, and renderBuffer renders at exactly that rate,
// so the engine output and the context stay in sync by construction
// (Web Audio is playback only, GUIDELINES §1.2 — we only ever ask for
// a rate, never synthesize in the browser).
const ensureAudioContext = () => {
  if (!app.ctx) {
    app.ctx = new AudioContext({ sampleRate: 48000 });
    app.master = app.ctx.createGain();
    app.master.gain.value = app.outputLevel;
    app.master.connect(app.ctx.destination);
  }
  if (app.ctx.state === 'suspended') app.ctx.resume();
  return app.ctx;
};

// The render-ready MIX VIEW for a drum (P7/S17): the patch with the
// mix-view state applied — the disabled layers zeroed, any solo active
// keeping only the soloed ∩ enabled layers (a soloed-but-disabled
// source is silent; nothing kept at all is silence). The state lives
// on the drum (disabledLayers / soloLayers, Sets of layer objects —
// app-tier mix-view choices, NOT patch data: the drum's patch is
// never touched). With no disabled and no solo layers the view keeps
// every layer and renders BYTE-IDENTICALLY to the raw patch
// (patch-ops.js's carry-over property) — the default view IS the full
// mix.
//
// Exported like `app` and `bandCurvesFor`: the headless DOM-stub
// harness (tmp/, git-ignored — there is no browser in this
// environment) asserts on the mix view's renders. The browser never
// reads the export.
export const mixedPatch = (drum) => {
  const disabled = [];
  const solo = [];
  drum.patch.layers.forEach((layer, i) => {
    if (drum.disabledLayers.has(layer)) disabled.push(i);
    if (drum.soloLayers.has(layer)) solo.push(i);
  });
  return mixView(drum.patch, disabled, solo);
};

// Render (or re-render) the drum's CURRENT MIX VIEW into its preview
// buffer — the Float32Array the band draws from, at PREVIEW_RATE. The
// band's waveform is the MIX's waveform: disabling/soloing a source
// moves it live (the "show the sound, don't just play it" goal), and
// with the default view (nothing disabled, nothing soloed) the render
// is byte-identical to the raw patch's (mixedPatch above).
const renderDrumPreview = (drum) => {
  drum.preview = renderPatch(mixedPatch(drum), {
    sampleRate: PREVIEW_RATE,
    duration: drum.duration,
  });
};

// The band's pitch-curve entries for a drum: one per FM layer (a
// noise layer has no carrier, so no curve). `points` is the dense
// sample of the carrier frequency across the band's time axis (the
// curve LINE — piecewise-linear envelope shapes are faithful at this
// density); `env` is the labeled, handleable pitch points: the
// layer's pitch envelope, or the single constant-frequency anchor for
// a flat carrier (drawBand; the editable handles land in P4/S11).
//
// Exported like `app`: the headless DOM-stub harness (tmp/, git-ignored
// — there is no browser in this environment) uses it to assert on the
// band's curve data (the curve count, the stable identity labels)
// without a browser. The browser never reads the export.
export const bandCurvesFor = (drum) => {
  const registry = app.cards.get(drum.name);
  const curves = [];
  drum.patch.layers.forEach((layer, layerIndex) => {
    if (layer.type !== 'fm') return;
    curves.push({
      points: pitchCurvePoints(layer, drum.duration, BAND_CURVE_SAMPLES),
      // Per-source hue so several curves stay distinguishable (the
      // working source is additionally highlighted, P4/S11).
      color: BAND_SOURCE_COLORS[curves.length % BAND_SOURCE_COLORS.length],
      // The curve's identity label binds the curve to its SOURCE, not
      // its position (new-ui.md §2.7): the registry's stable label
      // when the card row holds one for this layer; the positional
      // fallback only covers a drum whose row is not built yet (the
      // band is painted for the active drum only, whose row always is).
      label: registry?.get(layer)?.label ?? `Source ${layerIndex + 1}`,
      layerIndex,
      env: layer.pitchEnv ?? [{ t: 0, v: layer.carrier.freq }],
    });
  });
  return curves;
};

// The band's workingIndex for a drum: the working source's position
// in the curves array — which holds FM layers only, in patch order
// (bandCurvesFor) — so the working layer maps onto its FM ordinal.
// null when the drum has no working source, or the stored layer object
// no longer resolves in the patch (a structural op, P5 — the
// highlight clears by identity).
const workingIndexOf = (drum) => {
  const target = drum.workingSource;
  if (!target || target.type !== 'fm') return null;
  let fm = -1;
  for (const [layerIndex, layer] of drum.patch.layers.entries()) {
    if (layer.type !== 'fm') continue;
    fm += 1;
    if (layer === target) return fm;
  }
  return null;
};

// Paint the band for a drum: drawBand (src/app/band.js) in the mode
// the header's toggle holds — the mix waveform + pitch curves
// ('wave', the default) or the spectrum view (delegated to viz.js's
// drawSpectrum inside drawBand). The curves are sampled fresh from the
// patch on every call (bandCurvesFor), so a repaint always shows the
// patch as it is now — never a stale copy. workingIndex highlights the
// working source's curve (full opacity + 2 px + its handles, P4/S11).
const drawBandFor = (drum) => {
  drawBand(bandCanvas, {
    mixBuffer: drum.preview,
    sr: PREVIEW_RATE,
    duration: drum.duration,
    curves: bandCurvesFor(drum),
    workingIndex: workingIndexOf(drum),
    mode: bandMode.value,
    // The mix trace wears the drum's hue (plan "colors" S3) — the
    // per-curve pitch lines keep their own source colors (S10).
    // A drum without a color yet (undefined) falls back to
    // drawBand's default, COLORS.trace.
    mixColor: drum.color,
  });
};

// The band shows the active drum (setActiveDrum switches it with the
// card row).
const drawBandPreview = () => drawBandFor(getActiveDrum());

// The band's waveform/spectrum toggle (new-ui.md §3's "[spectrum ▾]")
// in the band header: the compact enum button group from knob.js,
// its onInput re-drawing the band in the other mode (the knob's live
// contract — no apply/commit step, new-ui.md §2.8).
const bandMode = buildButtonGroup({
  label: '',
  options: [
    { value: 'wave', label: 'waveform' },
    { value: 'spectrum', label: 'spectrum' },
  ],
  value: 'wave',
  onInput: () => drawBandPreview(),
});

// ---- card row + the mutation funnel (plan P3/S8) ----------------------

// Render a patch into an AudioBuffer at the AudioContext's sample
// rate — the shared core of the playback path (P7/S18). The
// preview/playback split carried over from the POC: the canvas buffers
// render at PREVIEW_RATE (now 48 kHz), the buffer Web Audio plays at
// the context's rate (the context's rate is what the user hears). Web Audio is
// playback only (GUIDELINES §1.2): the samples come from renderPatch —
// the context just carries them (createBuffer / copyToChannel). Only
// valid once a gesture created the context (ensureAudioContext).
const renderBuffer = (patch, duration) => {
  const samples = renderPatch(patch, {
    sampleRate: app.ctx.sampleRate,
    duration,
  });
  const buffer = app.ctx.createBuffer(1, samples.length, app.ctx.sampleRate);
  buffer.copyToChannel(samples, 0);
  return buffer;
};

// Re-render the drum's PLAYBACK buffer — the AudioBuffer the Trigger
// plays (P7/S18). Default: the CURRENT mix view (P7/S17 — the
// disabled/solo zeroing is included, so the buffer the transport plays
// is the mix as the user has it); `patchOverride` renders a different
// patch into drum.playback instead (the plan's renderPlayback(drum,
// patchOverride) contract). Re-rendered on every updateDrum, so a
// changed parameter — or a mute/solo toggle — affects the next hit.
const renderPlayback = (drum, patchOverride) => {
  drum.playback = renderBuffer(patchOverride ?? mixedPatch(drum), drum.duration);
};

// The readout-sync pass (the "two-writers problem"): after ANY
// parameter change, every control of the drum's cards is re-set from
// the patch — a knob and (P7/S17) the master fader edit the same path,
// and the displays must never drift apart. The value each control sees
// goes through the descriptor funnel's read half (descriptorRead —
// plan "dahdsr" P3/S2): a transformed descriptor (the DAHDSR level
// knobs, whose raw value is the whole point array) re-derives its
// scalar from the FRESH patch value on every pass. Cheap by design:
// setValue repaints text + aria only, and it is a NO-OP when the
// control already holds the value (the knob's commit contract, P1/S2),
// so the pass is loop-safe — a knob that made the edit does not
// re-fire onInput here, and setPath cannot re-enter updateDrum through
// the sync.
// An OPEN per-card envelope editor (cards.js, P4/S10) is redrawn from
// the patch here too: a knob on the same card can edit the same
// envelope points, and the old editor's always-fresh invariant carries
// over (redraw is a no-op while the section is collapsed, and inert
// cards have no envEditor at all).
const syncCardReadouts = (drum) => {
  const registry = app.cards.get(drum.name);
  if (!registry) return; // no card row built for this drum yet
  for (const { cardEl } of registry.values()) {
    for (const { el, path, descriptor } of cardEl.controls ?? []) {
      const raw = getPath(drum.patch, path);
      el.setValue(descriptorRead(descriptor, raw));
    }
    cardEl.envEditor?.redraw();
  }
};

// The strip's half of the readout-sync pass (P7/S17): the strip's
// level faders and the cards' gain knobs are TWINS on one path each
// (layers.<i>.gain) — after ANY edit, both displays re-read the patch
// (the fader's setValue is the knob's: a no-op when it already holds
// the value, so the pass is loop-safe). The strip shows the ACTIVE
// drum only (the panel binds to it), so the sync runs for the active
// drum only — like the band paint.
const syncStripReadouts = (drum) => {
  const controls = app.masterPanel?.stripControls;
  if (!controls) return;
  for (const { el, path } of controls)
    el.setValue(getPath(drum.patch, path));
};

// The single mutation funnel — the same name and role as the old
// main.js: every patch change (a card knob, a per-card envelope-editor
// or modal edit, and the structural add/remove ops — P5/S13, which
// rebuild the card row and then land here) refreshes everything the
// change touches from the patch: the preview buffer the band draws,
// the band itself (fresh pitch curves) when this drum is the one on
// screen, the card readouts (and any open per-card envelope editor /
// modal — its strip re-renders the edited source), and — once a
// gesture created the AudioContext — the playback buffer.
//
// The render-error line (P10/S25 — the old error-banner robustness):
// a render that CANNOT complete (e.g. a filter cutoff at or above
// Nyquist — renderPatch refuses it, and a JSON import can carry such a
// value: the importer validates shape, not ranges) must not take the
// page down. The engine's message lands in the band header's inline
// error line, the last good waveform stays painted, and the line
// auto-clears on the next successful funnel pass (the user fixes the
// value, or loads a preset). The knob ranges cap below the 48 kHz
// preview Nyquist (22000 < 24000) — the cap still exists (rather than
// being raised to the 24 kHz Nyquist) so the 22.05 kHz export tier
// keeps working — so this is reached through import / programmatic
// edits, not the sliders.
const updateDrum = (drum) => {
  try {
    renderDrumPreview(drum);
    if (drum.name === app.activeDrum) {
      drawBandFor(drum);
      syncStripReadouts(drum); // the strip shows the active drum only
      envModal.redraw(); // the open modal's plot + strip stay fresh (no-op closed)
    }
    syncCardReadouts(drum);
    if (app.ctx) renderPlayback(drum);
    bandErrorEl.textContent = ''; // success: the error (if any) is stale
  } catch (err) {
    bandErrorEl.textContent = err.message;
  }
};

// Make a card's source the working one (P4/S11 — the card head
// click): the band HIGHLIGHTS its pitch curve (the read-only
// overview's one interactive face — plan "dahdsr" P4/S2 retired the
// band's editing half; precise pitch editing lives in the card
// preview / modal). The gate: only an FM source that ALREADY carries
// a pitchEnv is workable — a constant-freq FM source (no pitchEnv)
// gets the small "add pitch env" button on its card head instead
// (cards.js — one mutation inserts a flat 2-point envelope at the
// current freq, then this same onWorking call works it), and a noise
// source deselects (the band has no pitch for it). The patch schema
// stays honest: an envelope exists only when the user wants one (no
// degenerate zero-time envelopes).
// Rebuilding the card row (rather than toggling one card's class) is
// deliberate: the working-source change and the add-pitch-env flow
// both change the card's SHAPE (the .working class, the button's
// presence, the shadowed pitch knobs), and the row rebuild is the
// atomic, identity-preserving pattern (S8/S13).
const onWorking = (drum, layerIndex) => {
  const layer = drum.patch.layers[layerIndex];
  drum.workingSource =
    layer?.type === 'fm' && layer.pitchEnv ? layer : null;
  rebuildCardRow(drum);
};

// Materialize the operator wave-shape fields IN PLACE (plan
// sinecontrol P3/S7): every fm layer's carrier and every modulator
// gains shape: 'sine' when it does not carry the field. The in-place
// write on the live objects is DELIBERATE — the add-pitch-env
// precedent (P4/S11), the one sanctioned exception to "edit through
// setPath": setPath is strict and refuses to create keys, shape is a
// documented schema default (the src/lib/engine.js header — absent
// means sine), and in-place keeps the layer OBJECT identity the card
// registry is keyed on (new-ui.md §2.7) — no re-key, no clone-first
// (this is default materialization, not a structural op). Called at
// the top of rebuildCardRow — the single funnel every displayed patch
// passes through (boot, drum switch, preset load, JSON import,
// structural ops) — so the cards' field-presence-gated shape groups
// (cards.js's describeToggles) always address a present field, and
// the strict read/write path needs no special case.
const ensureShapeFields = (patch) => {
  for (const layer of patch.layers) {
    if (layer.type !== 'fm') continue; // noise layers are not oscillators
    if (layer.carrier && !('shape' in layer.carrier))
      layer.carrier.shape = 'sine';
    for (const m of layer.modulators ?? [])
      if (!('shape' in m)) m.shape = 'sine';
  }
};

// Build (or rebuild) the card row for a drum — ATOMICALLY (new-ui.md
// §2.8: structural changes rebuild the card row atomically): the full
// new row is built in a DETACHED fragment (layer order = patch order:
// one buildFmCard / buildNoiseCard per layer), swapped into #cards-row
// in ONE replace (no flicker, no half-built row), and then updateDrum
// refreshes everything the change touches (the preview, the band when
// this drum is on screen, the readouts, the playback buffer).
//
// Card identity (new-ui.md §2.7): the per-drum registry (app.cards)
// keys its entries on the live LAYER OBJECT — the same reference the
// patch holds — and mints each layer's identity ONCE, when its card is
// first built: { id, label, cardEl } with id the drum's monotonic
// counter (cardSeq) and label 'Source ' + id. A layer still in the
// registry re-uses its identity across rebuilds (a structural op
// carries the surviving layer references over — patch-ops.js), a
// removed layer's entry is deleted (removeSource), and a fresh layer
// gets the next number — so removing the first source never renumbers
// "Source 3" (the displayed number is cosmetic and stable while the
// card lives).
const rebuildCardRow = (drum) => {
  // Materialize the wave-shape defaults in place BEFORE the card build
  // (plan sinecontrol P3/S7): the shape-group controls are field-
  // presence gated and setPath is strict, so the fields must exist
  // before any control addresses them. In place on the live layer
  // objects — the registry is keyed on exactly these references.
  ensureShapeFields(drum.patch);
  const registry = app.cards.get(drum.name) ?? new Map();
  const fragment = document.createDocumentFragment();
  for (const [layerIndex, layer] of drum.patch.layers.entries()) {
    let entry = registry.get(layer);
    if (!entry) {
      // A fresh layer: mint its identity once. cardSeq is monotonic —
      // a removed number is never re-issued while the drum lives.
      drum.cardSeq = (drum.cardSeq ?? 0) + 1;
      entry = { id: drum.cardSeq, label: `Source ${drum.cardSeq}` };
      registry.set(layer, entry);
    }
    // The live-patch contract (new-ui.md §2.8): the card applies the
    // edit with setPath (cards.js), main.js re-renders everything from
    // the patch. `working` marks the working source's card (.working
    // class, P4/S11); `disabled` / `solo` carry the mix-view state
    // (the .muted class + the lit solo dot, P7/S17 — read from the
    // drum's Sets, so the card's visuals always agree with the strip);
    // onWorking makes a card head clickable; onRemove wires the [✕]
    // to the structural op (P5/S13).
    const cardEl = layer.type === 'fm'
      ? buildFmCard({
          drum,
          layerIndex,
          layer,
          identity: { label: entry.label },
          working: drum.workingSource === layer,
          disabled: drum.disabledLayers.has(layer),
          solo: drum.soloLayers.has(layer),
          onPatchEdit: updateDrum,
          onWorking,
          onRemove: removeSource,
          onModAdd,
          onModRemove,
          onFxAdd,
          onFxRemove,
          // The preview canvas's click (plan "dahdsr" P4/S1): open the
          // full-screen modal for this source/kind.
          onEnvOpen: (d, i, kindPath) => envModal.open(d, i, kindPath),
          // The head's [⤓] (P8/S20): this ONE source in isolation,
          // at the top bar's quality selects, named by the card's
          // stable identity (exportSource — the label the card owns).
          onSourceExport: (d, i, label) =>
            exportSource(d, i, { ...exportQuality(), label }),
        })
      : buildNoiseCard({
          drum,
          layerIndex,
          layer,
          identity: { label: entry.label },
          working: drum.workingSource === layer,
          disabled: drum.disabledLayers.has(layer),
          solo: drum.soloLayers.has(layer),
          onPatchEdit: updateDrum,
          onWorking,
          onRemove: removeSource,
          onFxAdd,
          onFxRemove,
          // The preview canvas's click (plan "dahdsr" P4/S1) — the
          // noise card opens the same modal (its level preview).
          onEnvOpen: (d, i, kindPath) => envModal.open(d, i, kindPath),
          // The head's [⤓] (P8/S20) — the noise card exports its
          // source exactly like the FM card does (one line each;
          // exportSource's isolateLayer works on any layer type).
          onSourceExport: (d, i, label) =>
            exportSource(d, i, { ...exportQuality(), label }),
        });
    entry.cardEl = cardEl;
    fragment.append(cardEl);
  }
  app.cards.set(drum.name, registry);
  // The fader strip (P7/S17) rebuilds WITH the row — ONE structural
  // funnel for both views, so an add/remove source never desyncs
  // them: the rows re-derive from the fresh patch and registry (one
  // row per layer, the labels the registry's stable ids — a remove-
  // first leaves the strip's "L3" row named "L3", not "L2"), and the
  // E / S states re-read the drum's mix-view Sets.
  app.masterPanel.rebuildStrip(registry);
  // ONE replace: the row is never in a partial state (no flicker).
  cardsRow.replaceChildren(fragment);
  // A row rebuild clears the transient add-source error (the cap
  // message describes the last failed add, not a standing state).
  addErrorEl.textContent = '';
  updateDrum(drum);
};

// ---- structure: add / remove sources (plan P5/S13) -------------------

// The add-source row's buttons ([+ FM source] / [+ noise source]):
// append a new source to the ACTIVE drum with the pure op
// (patch-ops.js — clone-first: the returned patch object becomes the
// drum's live patch, and the surviving layer references carry over,
// so the registry's identities survive the wholesale replacement) and
// rebuild the row: the new card appears at the END with a fresh
// identity, and updateDrum refreshes the band + readouts (the band
// gains one more FM curve for an FM source; a noise source adds no
// pitch curve). The op's 8-layer cap is a throw by design (patch-ops
// fails loudly) — here it becomes the INLINE error in the add-source
// row: a visible message, never a crash, the patch and the row
// untouched.
const addSource = (type) => {
  const drum = getActiveDrum();
  try {
    drum.patch = addLayer(drum.patch, type);
  } catch (err) {
    addErrorEl.textContent = err.message;
    return;
  }
  rebuildCardRow(drum);
};

// A card's [✕]: drop that source with the pure op (which refuses the
// last layer — a drum keeps at least one source, mirrored as the
// button's disabled state in cards.js) and rebuild the row without it.
// The removed layer's identity is DELETED from the registry (its number
// is never re-issued — cardSeq is monotonic), and if the removed source
// was the working one the highlight clears: the dead object no longer
// resolves in the patch (workingIndexOf), so this also keeps the band
// from highlighting a source that is gone.
const removeSource = (drum, layerIndex) => {
  const removed = drum.patch.layers[layerIndex];
  drum.patch = removeLayer(drum.patch, layerIndex);
  app.cards.get(drum.name)?.delete(removed);
  // The mix-view Sets key on layer objects too (P7/S17): prune the
  // dead entry (a removed source keeps no mute/solo state).
  drum.disabledLayers.delete(removed);
  drum.soloLayers.delete(removed);
  if (drum.workingSource === removed) drum.workingSource = null;
  rebuildCardRow(drum);
};

// ---- structure: add / remove modulators (plan P5/S14) ---------------

// A modulator op's clone-first replacement creates a fresh layer
// OBJECT for the edited layer: the card registry (keyed on layer
// objects, P5/S13) and the working-source highlight (the layer object,
// P4/S11) both bind to the source, not the object — re-point both
// across the replacement, keeping the identity (and the highlight)
// alive. The surviving SIBLING layers carry over by reference
// (patch-ops.js), so their registry entries stay valid untouched.
const rekeyLayer = (drum, oldLayer, newLayer) => {
  const registry = app.cards.get(drum.name);
  if (registry?.has(oldLayer)) {
    const entry = registry.get(oldLayer);
    registry.delete(oldLayer);
    registry.set(newLayer, entry);
  }
  if (drum.workingSource === oldLayer) drum.workingSource = newLayer;
  // The mix-view Sets key on layer objects too (P7/S17): a muted or
  // soloed layer keeps its state across the re-key.
  if (drum.disabledLayers.has(oldLayer)) {
    drum.disabledLayers.delete(oldLayer);
    drum.disabledLayers.add(newLayer);
  }
  if (drum.soloLayers.has(oldLayer)) {
    drum.soloLayers.delete(oldLayer);
    drum.soloLayers.add(newLayer);
  }
};

// The FM card's modulator structural ops (plan P5/S14): the card's
// [+ mod] button and each modulator block's [✕]. The pure op
// (patch-ops.js) replaces the patch, rekeyLayer re-points the identity
// to the fresh layer object, and ONLY that card's modulator sub-
// section rebuilds (cards.js's rebuildModSection — the blocks re-derive
// from the fresh patch; the card element, its identity, and its
// siblings stay put — the row-level rebuild is for source add/remove
// only), before updateDrum refreshes the preview, the band, the
// readouts, and the playback. The add is capped at the engine's 4-
// modulator limit by the button's disabled state (wired from
// patch-ops.js's shared MAX_MODULATORS in cards.js), and the removal is
// allowed down to ZERO modulators — a plain sine the engine renders
// fine — so the ops' throws are unreachable from the UI: no try/catch.
const onModAdd = (drum, layerIndex) => {
  const oldLayer = drum.patch.layers[layerIndex];
  drum.patch = addModulator(drum.patch, layerIndex);
  rekeyLayer(drum, oldLayer, drum.patch.layers[layerIndex]);
  app.cards.get(drum.name)
    .get(drum.patch.layers[layerIndex]).cardEl.rebuildModSection();
  updateDrum(drum);
};

const onModRemove = (drum, layerIndex, modIndex) => {
  const oldLayer = drum.patch.layers[layerIndex];
  drum.patch = removeModulator(drum.patch, layerIndex, modIndex);
  rekeyLayer(drum, oldLayer, drum.patch.layers[layerIndex]);
  app.cards.get(drum.name)
    .get(drum.patch.layers[layerIndex]).cardEl.rebuildModSection();
  updateDrum(drum);
};

// ---- structure: add / remove fx (plan P6/S15) -----------------------

// A card's fx structural ops (plan P6/S15): the footer's [+ fx] type
// group (addFx on this layer's 'layers.<i>.effects' chain, the NEW_FX
// default for the clicked type) and each fx slot's [✕] (removeFx at
// the slot's index). The same card-internal pattern as the modulator
// ops (P5/S14): the pure op (patch-ops.js) replaces the patch
// (clone-first — the edited layer is a fresh object), rekeyLayer
// re-points the identity to it, and ONLY that card's fx sub-section
// rebuilds (the master chain is a DIFFERENT base path — addFx /
// removeFx address 'layers.<i>.effects' and never touch
// masterEffects — and the other cards' chains are untouched, so no
// row rebuild) before updateDrum refreshes the preview, the band,
// the readouts, and the playback. The add is capped at the 4-slot
// limit by the button's disabled state (wired from patch-ops.js's
// shared MAX_FX_SLOTS in cards.js), and the removal is allowed down to
// an EMPTY chain (the "no fx" hint returns) — so the ops' throws are
// unreachable from the UI: no try/catch.
const onFxAdd = (drum, layerIndex, type) => {
  const oldLayer = drum.patch.layers[layerIndex];
  drum.patch = addFx(drum.patch, `layers.${layerIndex}.effects`, type);
  rekeyLayer(drum, oldLayer, drum.patch.layers[layerIndex]);
  app.cards.get(drum.name)
    .get(drum.patch.layers[layerIndex]).cardEl.rebuildFxSection();
  updateDrum(drum);
};

const onFxRemove = (drum, layerIndex, slotIndex) => {
  const oldLayer = drum.patch.layers[layerIndex];
  drum.patch = removeFx(drum.patch, `layers.${layerIndex}.effects`, slotIndex);
  rekeyLayer(drum, oldLayer, drum.patch.layers[layerIndex]);
  app.cards.get(drum.name)
    .get(drum.patch.layers[layerIndex]).cardEl.rebuildFxSection();
  updateDrum(drum);
};

// ---- master panel (plan P6/S16) -------------------------------------

// The length fader's funnel: the hit length is patch-adjacent DRUM
// data (drum.duration), not patch data — no patch-ops: set it and run
// the updateDrum funnel — the preview re-renders at the new length
// (renderPatch takes the duration), the band's time axis follows
// (drawBand derives it from drum.duration — the band head's length
// readout is refreshed here for the drum on screen), and the playback
// buffer re-renders once a gesture created the AudioContext.
const onDurationChange = (drum, seconds) => {
  drum.duration = seconds;
  if (drum.name === app.activeDrum)
    lengthValueEl.textContent = `${seconds.toFixed(2)} s`;
  updateDrum(drum);
};

// The output-level knob's funnel: the mix level is a Web-Audio
// PLAYBACK-ONLY gain (GUIDELINES §1.2 — output gain/routing is the
// allowed use of the Web Audio API; the gain node never shapes the
// rendered samples). The patch schema has NO master gain, so the
// value is a playback property (app.outputLevel), not patch data. Before
// the first gesture the AudioContext (and the master GainNode) do not
// exist: the value is stored on app.outputLevel, and
// ensureAudioContext applies it when the context is created (the
// existing wiring) — turning the knob pre-gesture is not lost.
const onOutputLevel = (v) => {
  app.outputLevel = v;
  if (app.master) app.master.gain.value = v;
};

// The master panel's fx structural ops: the shared buildFxSlots UI
// (cards.js) on the 'masterEffects' chain — the same card-internal
// pattern as the card fx ops (P6/S15) MINUS the registry re-key: the
// master chain touches NO LAYER OBJECTS, so the card registry and the
// working-source reference are untouched (the op is clone-first — the
// surviving layer references carry over, and the other cards' chains
// are the same references), the panel's fx section re-derives from
// the fresh chain, and updateDrum refreshes the preview, the band, the
// readouts, and the playback. The add is capped at the 4-slot limit by
// the button's disabled state (the shared MAX_FX_SLOTS), the removal is
// allowed down to an EMPTY chain (the "no fx" hint returns) — the
// ops' throws are unreachable from the UI: no try/catch.
const onMasterFxAdd = (drum, type) => {
  drum.patch = addFx(drum.patch, 'masterEffects', type);
  app.masterPanel.rebuildFxSection();
  updateDrum(drum);
};

const onMasterFxRemove = (drum, slotIndex) => {
  drum.patch = removeFx(drum.patch, 'masterEffects', slotIndex);
  app.masterPanel.rebuildFxSection();
  updateDrum(drum);
};

// ---- mix view: enable / solo (plan P7/S17) ---------------------------

// A strip row's E / S toggle: flip the layer's membership in the
// drum's mix-view Set (APP-TIER STATE — the patch is NOT touched, so
// the exported/saved patch is unaffected), then rebuild the row: the
// strip re-derives the row's button states, the cards re-derive their
// mix-view visuals (the muted class, the solo dot), and updateDrum
// re-renders the preview (and, once a gesture created the context, the
// playback buffer) from the fresh mix view (mixedPatch) — one funnel,
// both views in agreement (the plan's strip/cards invariant).
const onEnableToggle = (drum, layerIndex) => {
  const layer = drum.patch.layers[layerIndex];
  if (drum.disabledLayers.has(layer))
    drum.disabledLayers.delete(layer);
  else
    drum.disabledLayers.add(layer);
  rebuildCardRow(drum);
};

const onSoloToggle = (drum, layerIndex) => {
  const layer = drum.patch.layers[layerIndex];
  if (drum.soloLayers.has(layer))
    drum.soloLayers.delete(layer);
  else
    drum.soloLayers.add(layer);
  rebuildCardRow(drum);
};

// ---- playback: trigger, per-source audition, band playhead (P7/S18) ----
//
// The one-shot plays (the top bar's Trigger and the strip rows' ▶) and
// the band's yellow playhead — the old loop/trigger code's concepts
// (new-ui.md §4: "survive in concept"), re-wired to the one-band
// layout. The Transport group's Loop + BPM are present in the markup
// but INERT until P8/S21: this section wires the one-shot plays only.

// Start a buffer through a fresh source node into the master gain
// (Web Audio = playback only, GUIDELINES §1.2 — the source node and
// the gain are the playback path; no synthesis happens in Web Audio).
const startBuffer = (buffer) => {
  const source = app.ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(app.master);
  source.start();
};

// The Trigger (top bar): play the active drum's CURRENT MIX VIEW —
// drum.playback, re-rendered on every updateDrum (the disabled/solo
// zeroing included), at the context's rate. The first click is the
// gesture that creates the AudioContext (ensureAudioContext — autoplay
// policy): before it, drum.playback does not exist (renderPlayback
// only runs once the context does), so render it now.
const playMix = () => {
  const drum = getActiveDrum();
  ensureAudioContext();
  if (!drum.playback) renderPlayback(drum);
  startBuffer(drum.playback);
  registerPlay('mix', app.ctx.currentTime, drum);
};

// A strip row's ▶ (new-ui.md §7: the L-row doubles as the solo
// trigger): play THAT ONE SOURCE — patch-ops.js's withSolo on the raw
// patch, every other layer zeroed, the source's own gain and the
// master chain intact. The audition plays the source as it is, even
// if the mix view mutes or solos around it (the E / S toggles are mix
// choices, the ▶ is an audition). The render goes into a TEMPORARY
// buffer — a solo play must not replace drum.playback (the mix the
// Trigger plays), so this path renders with renderBuffer directly,
// not renderPlayback.
const playSource = (drum, layerIndex, label) => {
  ensureAudioContext();
  const buffer = renderBuffer(
    withSolo(drum.patch, [layerIndex]),
    drum.duration,
  );
  startBuffer(buffer);
  registerPlay(`src:${label}`, app.ctx.currentTime, drum);
};

// Register one play on the audio clock: the KEY is the play's lane —
// 'mix' for the Trigger, 'src:<identity label>' for a row's ▶ — and
// LATEST PER KEY WINS (a retrigger replaces the key's older entry —
// the old semantics: the cursor shows the newest hit per lane). The
// entry carries the drum it was played on: the playhead shows on the
// band only while THAT drum is the one on screen (playheadViewFor).
// Starts the playhead rAF chain if it is idle.
const registerPlay = (key, startedAt, drum) => {
  app.plays.set(key, { startedAt, duration: drum.duration, drumName: drum.name });
  ensurePlayheadLoop();
};

// Start the playhead rAF chain when idle. The app.ctx guard: plays can
// only exist after a gesture created the context, but guard anyway so
// the rAF chain can never start without a clock.
const ensurePlayheadLoop = () => {
  if (app.playheadRaf === 0 && app.ctx)
    app.playheadRaf = requestAnimationFrame(playheadFrame);
};

// The visible canvas that shows a play's time domain, or null when
// none is: there is ONE band, and it shows the ACTIVE drum — so a play
// resolves to the band only while its own drum is on screen (the old
// "another drum's tab is open, so the line is drawn nowhere" rule: the
// rAF bookkeeping still runs, so the line appears the instant its drum
// is shown again). The time axis is the drum's duration — read fresh
// at frame time, like the old drum-tab case, so a length change
// mid-hit moves the axis and the line follows it.
const playheadViewFor = (play) =>
  play.drumName === app.activeDrum
    ? { canvas: bandCanvas, tMax: getActiveDrum().duration }
    : null;

// Repaint the band base under the playhead — the old
// redrawPlayheadBase pattern: the playhead is drawn OVER (drawPlayhead
// never clears), so the frame loop repaints the base first — without
// this, every frame's line would stay on the canvas behind the moving
// one (stale yellow stripes) and the last line would survive the hit.
const redrawPlayheadBase = () => drawBandFor(getActiveDrum());

// One animation frame: recompute every live play's x position from
// the audio clock (never accumulated — so the line can't drift, and
// the first frame after a backgrounded tab snaps to the correct
// position), repaint the band base (the hover, and the line's
// disappearance when the last hit ends), draw this frame's cursors on
// top, and drop finished hits.
//
// The loop self-terminates: when nothing is live, app.plays is empty
// and no further rAF is scheduled (idle page = zero animation cost —
// and the last frame's repaint has already removed the line).
const playheadFrame = () => {
  app.playheadRaf = 0;
  const now = app.ctx.currentTime;
  let live = false;
  const lines = [];
  for (const [key, play] of app.plays) {
    const t = now - play.startedAt;
    if (t >= play.duration) {
      app.plays.delete(key);
      continue; // hit finished
    }
    live = true;
    if (t < 0) continue; // loop beat scheduled ≤100 ms ahead, not started yet (S21)
    const view = playheadViewFor(play);
    if (!view) continue;
    lines.push({ t, tMax: view.tMax });
  }
  // Repaint the base when a line draws this frame, or when a line drew
  // LAST frame (the repaint is what erases it — drawPlayhead never
  // clears).
  if (lines.length > 0 || app.playheadOn) {
    redrawPlayheadBase();
    for (const { t, tMax } of lines)
      drawPlayhead(bandCanvas, timeToX(t, tMax, bandCanvas.width));
    // The modal rides the same clock (plan "dahdsr" P4/S1/S2): while
    // it is open for the on-screen drum, its playhead line follows the
    // same times on BOTH the plot and the waveform strip (the modal
    // maps t through its own zoom window — one x serves both).
    if (envModal.isOpen() && envModal.drumName() === app.activeDrum)
      for (const { t } of lines) envModal.drawPlayhead(t);
  }
  app.playheadOn = lines.length > 0;
  if (live) app.playheadRaf = requestAnimationFrame(playheadFrame);
};

// ---- Tempo loop transport (plan P8/S21) --------------------------------
//
// The transport group's Loop toggle + BPM, now wired (the old
// scheduler survives in concept — new-ui.md §4). Classic Web-Audio
// lookahead scheduling: a 25 ms setInterval decides *which* beats are
// due, the AudioContext clock decides *when* they sound. Each tick
// schedules every beat that falls in the next 100 ms with
// source.start(ctx.currentTime + offset), so the hardware clock — not
// the coarse OS timer — holds the rhythm: beat n lands exactly on
// n·(60/bpm) with no drift over long runs. If a tick is late (tab
// backgrounded, interval throttled), overdue beats clamp to "now" and
// fire as a burst — the standard pattern's graceful degradation.
//
// Fixed 4-step grid: a bar is four beats and every beat fires one hit
// per IN-LOOP drum — no per-step pattern (a sequencer is a roadmap
// item, not this step). The loop fires ALL in-loop drums: each drum
// carries an `inLoop` flag (the top bar's "In loop" checkbox, the
// three boot drums checked by default), and scheduleLoop skips the
// drums that are out. `disabled` is deliberately NOT checked here: it
// is a per-LAYER mix-view state (P7/S17), not a drum state — a drum
// with every layer disabled renders silence anyway, so the loop only
// needs inLoop. Each beat plays that drum's CURRENT mix buffer
// (drum.playback — re-rendered on every updateDrum, the enable/solo
// zeroing already included) and registers the play at the beat's grid
// time (registerPlay, the drum's name as the key): the band playhead
// tracks the active drum's latest play — the latest-per-drum
// semantics, unchanged (S18).
//
// Stopping: the ≤100 ms of beats already scheduled play out — the
// documented tail, not a bug. The playhead drawing is S18's band
// playhead, shared with the one-shot plays (loop beats and Trigger / ▶
// plays all register on the same clock and draw the same line); a
// backgrounded-tab rAF snap is inherited — playheadFrame recomputes x
// from ctx.currentTime every frame, and holds a not-yet-started beat
// (t < 0) alive without drawing it.
//
// No synthesis in the scheduler (GUIDELINES §1.2/§3): it plays the
// per-drum playback AudioBuffers rendered at the context's sample rate
// and re-rendered on every parameter change (renderPlayback via
// updateDrum) — the same buffers the Trigger button plays.

const LOOP_TICK_MS = 25; // scheduler interval
const LOOP_AHEAD = 0.1; // seconds of audio pre-scheduled per tick
const BPM_MIN = 60;
const BPM_MAX = 200;

// The BPM slider's filled track (plan "colors" S6): the clamped
// value's percent position in the BPM_MIN…BPM_MAX range, for the CSS
// --fill custom property (the track gradient's split point). No new
// state — the same value the readout shows.
const bpmFill = (bpm) =>
  `${(((bpm - BPM_MIN) / (BPM_MAX - BPM_MIN)) * 100).toFixed(2)}%`;

const loop = {
  bpm: 120, // default; re-read by the scheduler at every beat
  timer: null, // setInterval handle while running
  nextStepTime: 0, // ctx time of the next unscheduled beat
};

// One scheduler tick: schedule every beat due within the next
// LOOP_AHEAD seconds. Each beat fires every in-loop drum through a
// fresh source node started at the beat's exact ctx time.
const scheduleLoop = () => {
  const ctx = app.ctx;
  const now = ctx.currentTime;
  const horizon = now + LOOP_AHEAD;
  while (loop.nextStepTime < horizon) {
    // The beat's grid time, captured BEFORE the increment below. The
    // play is registered at this time (up to LOOP_AHEAD s ahead of the
    // start), so the cursor appears exactly on the beat, not up to 100
    // ms late (playheadFrame holds the line while t < 0).
    const tBeat = loop.nextStepTime;
    const offset = Math.max(0, tBeat - now); // late ticks clamp to now
    for (const drum of app.drums) {
      if (!drum.inLoop) continue;
      // Safety net: a drum with no buffer yet is skipped. startLoop and
      // the "In loop" toggle both render the buffer before a beat can
      // need it, so this is unreachable in practice.
      if (!drum.playback) continue;
      const source = ctx.createBufferSource();
      source.buffer = drum.playback; // fresh: re-rendered on every param change
      source.connect(app.master);
      source.start(now + offset);
      registerPlay(drum.name, tBeat, drum); // playhead: on the beat's grid time
    }
    loop.nextStepTime += 60 / loop.bpm; // one beat; BPM re-read per beat
  }
};

const startLoop = () => {
  ensureAudioContext();
  for (const drum of app.drums)
    if (drum.inLoop) renderPlayback(drum); // fresh buffers up front
  loop.nextStepTime = app.ctx.currentTime; // first beat immediately
  scheduleLoop(); // first tick synchronously: beat 0 lands exactly on the toggle time
  loop.timer = setInterval(scheduleLoop, LOOP_TICK_MS);
};

const stopLoop = () => {
  clearInterval(loop.timer);
  loop.timer = null;
  // Beats already scheduled (≤ LOOP_AHEAD s ahead) play out — the tail
  // of the loop, not a bug.
};

// The Transport group's wiring (P8/S21): the Loop toggle is the user
// gesture that creates the AudioContext (autoplay policy) and starts /
// stops the lookahead scheduler; the BPM slider sets the beat length
// (clamped to 60…200, re-read per beat — a change takes effect from the
// next beat on), its readout updating live; the "In loop" checkbox
// (next to the drum select) sets the ACTIVE drum's inLoop flag — the
// checkbox mirrors the active drum (showActiveDrum), so switching
// drums shows / sets the right drum's membership.
const wireTransport = () => {
  bpmValue.textContent = String(loop.bpm);
  // The track's fill at boot — without this the CSS default (0 %)
  // would show an unfilled track under the 120 thumb (S6).
  bpmSlider.style.setProperty('--fill', bpmFill(loop.bpm));
  loopToggle.addEventListener('change', () => {
    if (loopToggle.checked) startLoop();
    else stopLoop();
  });
  bpmSlider.addEventListener('input', () => {
    loop.bpm = clamp(parseFloat(bpmSlider.value), BPM_MIN, BPM_MAX);
    bpmValue.textContent = String(loop.bpm);
    bpmSlider.style.setProperty('--fill', bpmFill(loop.bpm));
  });
  inloopToggle.addEventListener('change', () => {
    const drum = getActiveDrum();
    drum.inLoop = inloopToggle.checked;
    // A drum joining the loop needs its CURRENT mix buffer for the next
    // beat (renderPlayback re-renders the enable/solo mix view at the
    // context's rate); only possible once a gesture created the context.
    if (drum.inLoop && app.ctx) renderPlayback(drum);
  });
};

// Build (or rebuild) the master panel for a drum: the panel BINDS TO
// THE DRUM it is built for — the length fader reads its duration, the
// master fx chain its masterEffects — so a drum switch rebuilds it
// wholesale, one atomic replace (the card row's pattern). The output-
// level knob is the exception: its value is the GLOBAL playback gain
// (app.outputLevel), not per-drum state, so every build passes it in
// fresh. The rebuild is display-only — the drum itself is refreshed
// by the funnel (rebuildCardRow / updateDrum), which runs after it.
const buildPanelFor = (drum) => {
  app.masterPanel = buildMasterPanel({
    drum,
    outputLevel: app.outputLevel,
    onPatchEdit: updateDrum,
    onDurationChange,
    onOutputLevel,
    onFxAdd: onMasterFxAdd,
    onFxRemove: onMasterFxRemove,
    onEnableToggle,
    onSoloToggle,
    onSourcePlay: playSource,
  });
  masterPanelEl.replaceChildren(app.masterPanel);
};

// Switch the drum the band and the card row show — the top bar's drum
// select (P4/S9). The per-drum state (the preview, the playback,
// the card registry + identities) lives on the drum object in the
// list, so switching swaps the display targets and tears nothing down:
// the new drum's card row is rebuilt from its OWN registry (re-using
// the identities already minted for its layers), the select + band-head
// readouts follow, and the funnel re-renders the drum's preview and
// repaints the band. A drum the select does not list is unreachable
// (its options are the drum list) and ignored.
const setActiveDrum = (name) => {
  const drum = app.drums.find((d) => d.name === name);
  if (!drum) return;
  envModal.close(); // the stale-state rule: the modal follows the drum
  app.activeDrum = name;
  showActiveDrum();
  // The master panel binds to the active drum (P6/S16): rebuild it for
  // the new drum BEFORE the card row (both are display-only — the
  // funnel below renders the drum). The length fader now reads the new
  // drum's duration, the fx section its master chain; the output knob
  // keeps the GLOBAL mix level (buildPanelFor passes it in).
  buildPanelFor(drum);
  // The rebuild funnels through updateDrum: the drum's preview
  // re-renders from its own patch (fresh buffer, byte-identical —
  // nothing was edited), the band repaints for the new drum, and the
  // readouts sync. The previous drum's state (patch, registry,
  // identities, preview) is untouched — switching tears nothing down.
  rebuildCardRow(drum);
};

// (Re)build the preset select's options: the registry entries, then
// the saved slots (presets.js's presetOptions — the "Saved: " label
// prefix, the "slot:<name>" value namespace). One atomic replace (the
// card row's fragment pattern), so the select is never in a partial
// state. Called at boot and after a slot save (the new option appears
// without a reload).
const refreshPresetSelect = () => {
  const fragment = document.createDocumentFragment();
  for (const { value, label } of presetOptions()) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    fragment.append(opt);
  }
  presetSelect.replaceChildren(fragment);
};

// Build the top bar's select options: one per drum in the list (list
// order) and one per preset — the registry entries, then the saved
// slots (refreshPresetSelect, P8/S19).
const buildSelectOptions = () => {
  for (const d of app.drums) {
    const opt = document.createElement('option');
    opt.value = d.name;
    opt.textContent = drumLabel(d.name);
    drumSelect.append(opt);
  }
  refreshPresetSelect();
};

// The preset area's status line (the VISIBLE face of the guard — the
// pivot §6 risk, carried over): when localStorage is unavailable
// (private mode) the note says so INSTEAD of the page crashing; a
// corrupt stored-slot error or a failed load/save shows its message
// here; a successful save confirms here. Empty = nothing to report.
const showPresetNote = (text) => {
  presetNoteEl.textContent = text;
};

// The storage-availability check (boot): unavailable storage -> the
// visible note (the select then holds the registry entries only);
// corrupt stored data -> the note (presets.js throws descriptively —
// never a silent null — and the message lands here).
const refreshPresetAvailability = () => {
  try {
    const listed = listSlots();
    if (!listed.ok) {
      showPresetNote('saved slots unavailable (browser storage is blocked — private mode?)');
      return;
    }
    showPresetNote('');
  } catch (err) {
    showPresetNote(err.message);
  }
};

// The shared "replace this drum's patch + duration WHOLESALE" path
// (the preset/slot load, P8/S19, and the JSON import, P8/S20): the
// drum gets the snapshot's duration and a FRESH patch (the caller's
// contract — a fresh object, never a live patch: the registry preset
// is built + cloned here, the saved slot is loadSlot's fresh clone,
// the imported drum is jsonToDrum's fresh clone), and every per-drum
// state that keys on the OLD layer objects resets: the card identity
// registry (fresh Source 1, 2, ... — the old layer objects are all
// dead), the mix-view Sets (disabled / solo), the working source. The
// master panel re-binds (the new duration + master chain) BEFORE the
// row rebuild (rebuildCardRow funnels the strip rebuild through the
// panel), and rebuildCardRow rebuilds the row + strip and funnels
// through updateDrum (the preview, the band, the readouts, the
// playback). The drum KEEPS ITS NAME — the snapshot is a starting
// point, not a rename (the "preset = data, drum = session entry"
// separation, the import's too).
const applyDrumSnapshot = (drum, duration, patch) => {
  envModal.close(); // the stale-state rule: a loaded preset is a new patch
  drum.patch = patch;
  drum.duration = duration;
  app.cards.set(drum.name, new Map());
  drum.cardSeq = 0;
  drum.disabledLayers.clear();
  drum.soloLayers.clear();
  drum.workingSource = null;
  // The master panel binds to the active drum (P6/S16): re-bind it to
  // the fresh duration + master chain BEFORE the row rebuild.
  buildPanelFor(drum);
  rebuildCardRow(drum); // fresh row + strip; ends in updateDrum
  lengthValueEl.textContent = `${drum.duration.toFixed(2)} s`;
};

// The preset select's change: LOAD the chosen preset into the ACTIVE
// drum — "loading a preset replaces the card row wholesale" (new-ui.md
// §2.6). A registry entry loads its build() output (a fresh patch,
// cloned for the live-patch contract); a saved slot (a "slot:<name>"
// value) loads the slot's stored snapshot (loadSlot's fresh clone —
// the stored data and the live patch never alias). The wholesale
// replacement is applyDrumSnapshot (see above); a load error (an
// unknown slot, corrupt stored data) lands in the note, the drum
// untouched.
const onPresetSelect = () => {
  const drum = getActiveDrum();
  const value = presetSelect.value;
  try {
    const slotName = slotNameFromValue(value);
    let duration;
    let patch;
    if (slotName !== null) {
      const loaded = loadSlot(slotName);
      if (!loaded.ok) {
        showPresetNote(`saved slots unavailable (${loaded.reason})`);
        return;
      }
      duration = loaded.slot.duration;
      patch = loaded.slot.patch; // a fresh clone (loadSlot's contract)
    } else {
      const preset = presetById(value);
      duration = preset.duration;
      patch = structuredClone(preset.build());
      // A registry-preset load re-identifies the drum's APPEARANCE: it
      // adopts the preset's hue (DRUM_COLORS — the seven preset family,
      // src/app/theme.js) so the workspace shows which drum type is on
      // screen (plan "colors" S5: the blank preset reads slate, the tom
      // reads purple, ...). The drum keeps its NAME (the preset is
      // data, the drum is the session entry — the contract above); the
      // hue is appearance, not patch data, so a saved-slot load (the
      // branch above — the snapshot stores no hue) keeps the drum's
      // current one.
      drum.color = DRUM_COLORS[preset.id];
    }
    applyDrumSnapshot(drum, duration, patch);
    // The hue may have just changed (the preset's): refresh the live
    // --drum variable + the band-name color through the single funnel.
    // showActiveDrum is idempotent — its other readouts (select value,
    // length, In-loop mirror) were just re-derived by the rebuild.
    showActiveDrum();
    showPresetNote('');
  } catch (err) {
    showPresetNote(err.message);
  }
};

// The top bar's "+ drum" (plan "colors" S5 — the custom-drum half of
// the color sweep): append a new drum built from the Blank preset —
// the registry's designated starting point ("the minimal building block
// a user's new drum starts from", presets.js) — and switch to it. The
// name uniquifies from 'new' ('new', 'new-2', ... — presets.js's
// uniqueDrumName): never a preset id, so the new drum can't masquerade
// as the Blank preset's label in the drum select. The color is the
// first spare hue no drum uses (colorForNewDrum — the EXTRA_DRUM_COLORS
// list in theme.js), never a preset hue; the per-drum state
// initializes like the boot drums' (prepareDrumState) EXCEPT the loop
// flag: a drum added later starts OUT of the tempo loop (the boot
// three are the shipped default — the "In loop" checkbox shows it
// unchecked). The new option appends to the drum select (the list is
// append-only), and setActiveDrum funnels the row, the band, and the
// hue.
const onAddDrum = () => {
  const blank = presetById('blank');
  const list = [
    ...app.drums,
    {
      name: uniqueDrumName(app.drums, 'new'),
      duration: blank.duration,
      patch: structuredClone(blank.build()),
    },
  ];
  const drum = list[list.length - 1];
  colorForNewDrum(list);
  prepareDrumState(drum, false);
  app.drums = list;
  const opt = document.createElement('option');
  opt.value = drum.name;
  opt.textContent = drumLabel(drum.name);
  drumSelect.append(opt);
  setActiveDrum(drum.name);
};

// The top bar's Save button: store the ACTIVE drum's current patch as
// the named slot the inline input holds (NO prompt() — the DOM-stub
// harness cannot exercise one; the inline input is the sanctioned
// path). It stores the drum's plain { name, duration, patch } data —
// the mix-view state (disabled / solo) is NOT saved: it is app-tier
// state, not patch data (P7/S17). A bad name throws descriptively
// (presets.js) and the message lands in the note; unavailable storage
// reports { ok: false, reason } and becomes the note. On success the
// preset select refreshes (the new "Saved: <name>" option appears)
// and the note confirms.
const onSaveClick = () => {
  const name = slotNameInput.value.trim();
  try {
    const result = saveSlot(name, getActiveDrum());
    if (!result.ok) {
      showPresetNote(
        `cannot save the slot (${result.reason}) — saved slots need browser storage`,
      );
      return;
    }
    refreshPresetSelect();
    showPresetNote(`saved '${name}'`);
  } catch (err) {
    showPresetNote(err.message);
  }
};

// ---- JSON / WAV export (plan P8/S20) --------------------------------
//
// The top bar's I/O buttons: JSON-Export (the active drum's portable
// form as a file), JSON-Import (a file replaces the active drum's
// patch + duration wholesale — the preset-load path), and WAV-Export
// (the active drum's mix at the quality selects' values — the old
// per-drum export row rebuilt as top-bar controls, new-ui.md §4).
// Each card head's [⤓] is the per-source half of the WAV export
// (onSourceExport in rebuildCardRow — exportSource with the same
// quality, the file named by the card's stable identity).

// The top bar's WAV quality selects: options from export-wav.js's
// EXPORT_RATES / EXPORT_BITS tables (the single source of the offered
// rates/bits — the UI can never offer the library an option it
// rejects, the guard test/export-wav.test.mjs pins), defaults
// EXPORT_DEFAULTS (48000 = PREVIEW_RATE — what the user hears — at
// 32-bit float, the bit-exact lossless master of the render; the
// export path renders at the select's value).
// One atomic replace each (the card row's
// fragment pattern); the values travel as strings (a select's native
// type) and are re-parsed to numbers at click time.
const buildWavSelect = (select, options, defaultValue) => {
  const fragment = document.createDocumentFragment();
  for (const { value, label } of options) {
    const opt = document.createElement('option');
    opt.value = String(value);
    opt.textContent = label;
    fragment.append(opt);
  }
  select.replaceChildren(fragment);
  select.value = String(defaultValue);
};
buildWavSelect(wavRateSelect, EXPORT_RATES, EXPORT_DEFAULTS.sampleRate);
buildWavSelect(wavBitsSelect, EXPORT_BITS, EXPORT_DEFAULTS.bitsPerSample);

// The CURRENT export quality — read at click time (not cached at
// build), so a select change takes effect on the very next export.
const exportQuality = () => ({
  sampleRate: Number(wavRateSelect.value),
  bitsPerSample: Number(wavBitsSelect.value),
});

// The top bar's WAV-Export (P8/S20): the active drum's MIX — all its
// sources together (exportDrum, unchanged from the old row: the raw
// live patch at the chosen quality, exactly the hit the user hears).
// The Blob/anchor download is export-wav.js's I/O boundary.
const onWavExport = () => {
  exportDrum(getActiveDrum(), exportQuality());
};

// The top bar's JSON-Export (P8/S20): the active drum's portable form
// — the plain { name, duration, patch } snapshot (presets.js's
// drumToJson, formatted) — as a Blob download (downloadText: the
// shared anchor pattern, factored from downloadWav so it lives once).
// The file name is the drum's name + ".json".
const onJsonExport = () => {
  const drum = getActiveDrum();
  downloadText(`${drum.name}.json`, drumToJson(drum), 'application/json');
};

// The top bar's JSON-Import (P8/S20): the HIDDEN file input's change.
// The file's text is validated by jsonToDrum (descriptive throws land
// in the preset note — the standing I/O status line — and the drum is
// untouched), and the validated snapshot REPLACES THE ACTIVE DRUM'S
// patch + duration wholesale through applyDrumSnapshot — the SAME
// path as a preset load (the card identity registry reset, the mix-
// view state cleared, the panel re-bound, rebuildCardRow funnels
// updateDrum). The drum KEEPS ITS NAME (the import is a starting
// point, not a rename). The input's value is cleared AFTER reading so
// re-selecting the SAME file fires change again (a file input only
// fires on a value change).
const onJsonImportChange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // re-selectable: the same file fires change again
  if (!file) return;
  const drum = getActiveDrum();
  try {
    const loaded = jsonToDrum(await file.text());
    applyDrumSnapshot(drum, loaded.duration, loaded.patch);
    showPresetNote('');
  } catch (err) {
    showPresetNote(err.message);
  }
};

// Refresh the band head's readouts for the active drum: its name (in
// its own trace color — COLORS.trace for a drum with no color yet)
// and its hit length (the band's time axis follows the active drum's
// duration — derived, not hardcoded). The "In loop" checkbox (P8/S21)
// mirrors the ACTIVE drum's inLoop flag too — it is the drum select's
// neighbor and applies to the selected drum, so a drum switch shows
// the new drum's membership (and a drum added later, which starts out
// of the loop, shows it unchecked).
const showActiveDrum = () => {
  const drum = getActiveDrum();
  drumSelect.value = drum.name;
  drumNameEl.textContent = drumLabel(drum.name);
  drumNameEl.style.color = drum.color ?? COLORS.trace;
  // The live per-drum hue (plan "colors" S3): a RUNTIME variable set
  // on body — deliberately in NEITHER :root NOR cssTokens() (the
  // drift guard mirrors exactly those two), so the dynamic value
  // stays out of the static palette. Every CSS use site writes
  // var(--drum, var(--accent)), the fallback covering the
  // pre-first-paint frame. showActiveDrum is the single funnel —
  // boot, setActiveDrum, and a preset load (the hue may have just
  // changed to the preset's) all run through it.
  document.body.style.setProperty('--drum', drum.color ?? THEME.accent);
  lengthValueEl.textContent = `${drum.duration.toFixed(2)} s`;
  inloopToggle.checked = Boolean(drum.inLoop);
};

// Boot (P2/S4-S6, P3/S8, P4/S9, P5/S13, P6/S16, P7/S17-S18, P8/S19):
// build the select options, show the active drum, wire the drum
// select, the "+ drum" button (a custom drum from the Blank preset),
// the preset select (preset / slot LOAD), the Save button
// (named slot save), the add-source row, and the Trigger, build the
// band's mode toggle, build the master panel for the active drum (its
// strip rows' ▶ audition buttons come along), and rebuild the card row
// — the rebuild funnels through updateDrum, which renders the drum's
// preview, paints the band, and syncs the readouts (the other drums'
// previews render lazily on their first display, same funnel). The
// knob -> setPath -> re-render -> band loop, the drum switching, the
// add/remove source flow, the master panel (length / output level /
// master fx), the fader strip (levels / enable / solo), the one-shot
// plays (Trigger + per-source ▶ with the band playhead), the tempo
// LOOP transport (P8/S21 — the Transport group's Loop toggle + BPM
// slider + the "In loop" checkbox, wireTransport below), and the
// preset panel (load + named save slots, the storage guard's note),
// and the JSON / WAV export (P8/S20: the JSON-Export download, the
// JSON-Import's hidden file input, the WAV-Export button + quality
// selects, and the cards' per-source [⤓] through onSourceExport)
// are live from here.
buildSelectOptions();
showActiveDrum();
drumSelect.addEventListener('change', () => setActiveDrum(drumSelect.value));
addDrumBtn.addEventListener('click', onAddDrum);
bandModeSlot.append(bandMode);
buildPanelFor(getActiveDrum());
rebuildCardRow(getActiveDrum());
// The preset panel (P8/S19): the preset select LOADS a preset or a
// saved slot into the active drum (the card row replaced wholesale),
// the Save button stores the active drum in the NAMED slot the inline
// input holds, and the availability note shows the guard's result at
// boot (private mode -> a visible note, not a crash).
presetSelect.addEventListener('change', onPresetSelect);
saveBtn.addEventListener('click', onSaveClick);
refreshPresetAvailability();
// The add-source row (P5/S13): the buttons append a source to the
// ACTIVE drum through the pure structural op and rebuild the row —
// the new card appears at the end with a fresh identity; the 8-layer
// cap shows as the inline error, not a crash.
addFmBtn.addEventListener('click', () => addSource('fm'));
addNoiseBtn.addEventListener('click', () => addSource('noise'));
// The Trigger (P7/S18): one-shot playback of the active drum's mix
// view — the click is the gesture that creates the AudioContext
// (autoplay policy), and the band playhead runs for the hit's
// duration. The strip rows' ▶ audition buttons are wired through the
// master panel's onSourcePlay (buildPanelFor above).
triggerBtn.addEventListener('click', playMix);
// The Transport group (P8/S21): the Loop toggle (the gesture that
// creates the AudioContext) starts / stops the lookahead scheduler;
// the BPM slider sets the beat length (re-read per beat); the "In
// loop" checkbox sets the active drum's inLoop flag (the three boot
// drums start in the loop — the checkbox is checked by default).
wireTransport();
// The JSON / WAV export (P8/S20): the JSON-Export button downloads
// the active drum's formatted JSON snapshot (downloadText — the
// shared anchor pattern); the JSON-Import button clicks the HIDDEN
// file input (the browser shows the picker; the change handler reads,
// validates, and wholesale-replaces the active drum); the WAV-Export
// button downloads the active drum's mix at the quality selects'
// CURRENT values. (The cards' per-source [⤓] buttons are wired
// through onSourceExport in rebuildCardRow.)
jsonExportBtn.addEventListener('click', onJsonExport);
jsonImportBtn.addEventListener('click', () => jsonImportInput.click());
jsonImportInput.addEventListener('change', onJsonImportChange);
wavExportBtn.addEventListener('click', onWavExport);
