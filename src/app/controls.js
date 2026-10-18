// UI slider metadata for the drum sections (binding layer, src/app/).
// This metadata belongs to the UI, not the audio library: src/lib/
// builds and renders engine patches and knows nothing about labels or
// slider ranges (GUIDELINES §1.4(e)).
//
// There are no hand-written per-voice descriptor lists: the single
// PARAM_RANGES table below plus the describeLayer / describeFxList /
// describePatch factories derive one descriptor from each patch's
// ACTUAL structure, and src/app/main.js turns the list into slider
// rows (revamp P1/S3). The pre-S3 hand-written lists survive only as
// the equivalence-guard fixtures in test/descriptors.test.mjs.
//
// Each descriptor is {path, label, displayLabel, min, max, step}
// (format per plan step 13), optionally with a read/write transform
// pair (plan "dahdsr" P3/S2 — a backward-compatible extension; every
// pre-P3/S2 descriptor is untouched):
//   path — a dot path into the BUILT engine patch (src/lib/engine.js
//     schema). The UI applies a slider value with setPath(patch,
//     path, value) and re-renders the same patch object, so every
//     path must hit live engine data, never a detached copy of the
//     recipe. Envelope values live in point arrays ({t, v}), hence
//     the `N.t` / `N.v` path segments.
//   label — the control's FULL human-readable name: the rotor's /
//     group's aria-label (the accessible name — it keeps the
//     `Source N:` identity prefix even where the visible caption
//     drops it, plan ui3 P5/S1).
//   displayLabel — the SHORT visible caption: the label with the
//     leading `Source N:` prefix stripped (displayLabelOf below — the
//     card head already shows the source). OPTIONAL: a descriptor
//     without one falls back to `label` for the visible text (the
//     master panel's prefix-less controls); the factories set it on
//     every descriptor they emit, and the knob / button-group /
//     select builders render `displayLabel ?? label`.
//   min / max / step — the slider's range and resolution.
//   read(raw) / write(raw, value) — OPTIONAL transforms applied
//     around the raw getPath / setPath value (absent = the plain
//     {path, label, min, max, step} form; descriptorRead /
//     descriptorWrite below are the single funnel the knob builder's
//     initial read, the edit commit, and the readout-sync pass all go
//     through). The level descriptors use them: their path addresses
//     the WHOLE levelEnv point array, so a knob turn re-derives all
//     six canonical points atomically (read scalars -> change one ->
//     dahdsrToPoints -> whole-array write) — the knobs and the point
//     array are one model's two views, no split brain.
//
// Shadowing rules (the DSP fact itself is documented in
// src/lib/engine.js): when a layer carries a pitchEnv / indexEnv, the
// per-sample freqAt / indexAt hooks OVERRIDE the constant
// carrier.freq / modulator.index fields — a slider on a shadowed field
// would be dead. Descriptor paths therefore address the envelope
// points (e.g. indexEnv.0.v, the index at t = 0) instead of the
// shadowed constants, and only fields that are actually live get a
// slider (describeLayer implements these rules per layer;
// test/params.test.mjs renders every descriptor change and asserts the
// output moves — a shadowed path fails that test).
//
// Level-envelope note: levelEnvelope (src/lib/envelopes.js) produces
// the canonical 6-point DAHDSR form
//   pts[0]=(0,0)  pts[1]=(delay,0)  pts[2]=(delay+attack,1)
//   pts[3]=(delay+attack+hold,1)  pts[4]=(…+decay,sustain)
//   pts[5]=(…+release,0)
// with zero spans stored as duplicate-t points (the engine's
// zero-length-segment rule resolves them), an optional per-segment
// curve bend on pts[1] / pts[3] / pts[4], and the peak fixed at 1.0
// (the layer's gain is the level). describeLayer emits NINE knobs
// over that form (LEVEL_KNOB_SPECS below: the five spans, the sustain
// level, the three bends) — all with the SAME path (layers.i.levelEnv)
// and read/write transforms: the raw value is the whole point array,
// so one knob turn re-derives all six points atomically with exactly
// its own parameter changed. A non-canonical levelEnv (legacy
// imported/stored data — adopted on load, plan P3/S3) is normalized
// through dahdsr.js's normalizeLevelEnv on the transform path, so a
// knob can never wedge on old data. The span knobs' range starts at 0
// (a zero span is a legitimate degenerate value,
// LEVEL_POINT_TIME_RANGE below) instead of ENVELOPE_TIME_RANGE's
// 0.0005 floor.

// ---- Parameter table and descriptor factory (revamp P1/S2) ------------
//
// The single UI-metadata table for every engine parameter, plus
// factories that derive slider descriptors from a patch's ACTUAL
// structure (describeLayer / describeFxList / describePatch). Per
// GUIDELINES §1.4(e) this metadata lives in src/app/, never in
// src/lib/. Descriptor format and the path/shadowing conventions are
// documented in the header above; src/app/main.js wires the factory
// into the UI (one slider row per describePatch entry — revamp P1/S3).
//
// Ranges are WIDE (the musically useful span), not per-recipe: the
// engine is the backstop (a cutoff ≥ sr/2 throws at render — the P3/S17
// error banner surfaces it), so a wide table can never make a slider
// illegal, only the render can. The pre-S3 hand-written lists' narrower
// per-recipe ranges (and their per-voice labels) are superseded by this
// table (P1/S3); their guard fixtures live in test/descriptors.test.mjs.

// App-tier import (same tier — GUIDELINES §1.4(b) governs the lib
// boundary, not app↔app): the DAHDSR canonical-form math the level
// descriptors' read/write transforms are built on (src/app/dahdsr.js
// — plan "dahdsr" P3/S1; it itself imports only the facade).
import { dahdsrToPoints, normalizeLevelEnv, pointsToDahdsr } from './dahdsr.js';

// One entry per engine parameter, keyed by parameter NAME (not by
// index): {label, min, max, step}. Effect params are keyed
// '<fx type>.<field>', mirroring the engine's fx schema (the header of
// src/lib/engine.js). test/descriptors.test.mjs guards the shape and
// the effect keys against engine drift.
export const PARAM_RANGES = {
  // FM source params.
  'carrier.freq': { label: 'carrier freq (Hz)', min: 20, max: 22000, step: 1 },
  'modulator.freq': { label: 'freq (Hz)', min: 20, max: 22000, step: 1 },
  'modulator.index': { label: 'index', min: 0, max: 20, step: 0.1 },
  // Capped just under the stability edge: the feedback term is a
  // one-sample-lagged self-deviation in RADIANS (src/lib/fm.js), so at
  // β ≥ 1 the operator's phase swing reaches a full radian per sample
  // and the sine degrades into alias-prone noise — the "noise-like"
  // end of drum_generation.md's feedback progression ("sine → saw-like
  // → noise-like"). That regime is what the noise layers are for; 0.95
  // keeps the knob in the musical sine → saw-like zone.
  'modulator.feedback': { label: 'feedback', min: 0, max: 0.95, step: 0.01 },
  // Noise source params (filteredNoiseBurst, src/lib/noise.js).
  'noise.cutoff': { label: 'cutoff (Hz)', min: 50, max: 22000, step: 1 },
  'noise.decay': { label: 'decay (s)', min: 0.005, max: 1.5, step: 0.005 },
  // Integer on purpose: the seed indexes the deterministic mulberry32
  // PRNG (src/lib/noise.js header) — the same seed must always give the
  // same transient, so a fractional step would silently re-shape it.
  'noise.seed': { label: 'seed', min: 1, max: 999, step: 1 },
  // Layer level in the mix.
  'layer.gain': { label: 'gain', min: 0, max: 1, step: 0.01 },
  // Effect params (the four fx types of src/lib/engine.js).
  'saturate.drive': { label: 'drive', min: 1, max: 10, step: 0.1 },
  'highpass.cutoff': { label: 'cutoff (Hz)', min: 50, max: 22000, step: 1 },
  'resonate.freq': { label: 'freq (Hz)', min: 20, max: 22000, step: 1 },
  'resonate.q': { label: 'Q', min: 0.5, max: 20, step: 0.5 },
  'compress.threshold': { label: 'threshold', min: 0.05, max: 0.9, step: 0.05 },
  'compress.ratio': { label: 'ratio', min: 1, max: 10, step: 0.5 },
  'compress.attack': { label: 'attack (s)', min: 0, max: 0.1, step: 0.001 },
  'compress.release': { label: 'release (s)', min: 0.01, max: 1, step: 0.01 },
  'compress.makeup': { label: 'makeup', min: 1, max: 4, step: 0.1 },
};

// Envelope-POINT times: the engine stores whole point arrays, so a
// single t value is not a PARAM_RANGES parameter of its own — the
// factory gives the point times it exposes as sliders (pitch/index
// collapse time, the level point times) this one wide shared range.
// Caveat: a shared wide range can produce an unsorted level-env point
// array (a point moved past its neighbours); the evaluator then
// degrades gracefully (holds, never throws — verified against
// renderPatch), and the point-level envelope editor is the precise
// tool for such shapes.
// Exported (not just PARAM_RANGES) so the constrained env editor's
// drag clamps (src/app/env-editor.js) read the same numbers as the
// knobs — the canvas can never write a time the knobs cannot show
// (plan "dahdsr" P4/S1).
export const ENVELOPE_TIME_RANGE = {
  label: 'time (s)',
  min: 0.0005,
  max: 1.5,
  step: 0.0005,
};

// The level span knobs' time range: the same wide span as
// ENVELOPE_TIME_RANGE, with the min relaxed to 0 — in the canonical
// 6-point form a zero span is a legitimate degenerate value (delay = 0
// and hold = 0 by default, stored as duplicate-t points), so the spans
// must be addressable AT 0, not just above it.
// Exported for the same reason (the env editor's level-span clamps).
export const LEVEL_POINT_TIME_RANGE = {
  label: 'time (s)',
  min: 0,
  max: 1.5,
  step: 0.0005,
};

// The bend-parameter range: the optional per-segment `curve` field
// (src/lib/envelopes.js — 0 = linear, 1 = the full exponential bend),
// exposed by the level's three curve knobs. A plain app-tier range
// beside the other envelope ranges: the bends are addressed by the
// level descriptors' transforms (no dot path of their own), so they
// do not get a PARAM_RANGES entry.
const CURVE_BEND_RANGE = {
  label: 'curve',
  min: 0,
  max: 1,
  step: 0.01,
};

// Human captions for the four effect types (the engine's fx.type
// values, src/lib/engine.js header). A type not listed here has no
// PARAM_RANGES entry either, so describeFxList throws on it — an
// unknown type fails loudly instead of shipping an unlabeled slider.
// Exported (P6/S15): src/app/cards.js reuses this EXACT table for the
// fx-slot type badges and the [+ fx] type button group — one source of
// truth for a type's label, never duplicated.
export const FX_TYPE_LABELS = {
  saturate: 'Saturator',
  highpass: 'High-pass',
  resonate: 'Resonator',
  compress: 'Compressor',
};

// The wave-shape options for the per-operator shape groups (plan
// sinecontrol P3/S6 — knob.js's buildShapeGroup renders them as the
// Geonkick-style glyph buttons): the VALUES are the engine's closed
// WAVE_SHAPES enum (src/lib/osc.js — they ARE the patch data the
// control addresses), the LABELS are UI glyphs (no UI metadata may
// live in src/lib/ — GUIDELINES §1.4(e)). The drift guard in
// test/cards.test.mjs keeps the two lists in sync (the
// FX_TYPE_LABELS precedent).
export const SHAPE_OPTIONS = [
  { value: 'sine', label: '∿' },
  { value: 'square', label: '□' },
  { value: 'saw', label: '◺' },
  { value: 'triangle', label: '△' },
];

// The range entry for a PARAM_RANGES key. The table is the single
// source of truth for ranges, so a missing entry is a bug (a new
// engine parameter without UI metadata) and fails loudly.
const rangeFor = (key) => {
  const range = PARAM_RANGES[key];
  if (!range)
    throw new Error(`controls: no PARAM_RANGES entry for parameter '${key}'`);
  return range;
};

// The short visible caption for a descriptor label (plan ui3 P5/S1):
// strip the leading `Source N:` prefix — one anchored regex, so at
// most one prefix, only at the very start ('Source 2: Saturator 1
// Drive' -> 'Saturator 1 Drive'). The card head already shows the
// source identity, so the visible caption drops the redundant prefix;
// the aria-label keeps the FULL label (no a11y regression — the
// boot-check's knob lookups run on `label`, not on this). Labels
// without the prefix ('Master: …', the master panel's) pass through
// unchanged.
export const displayLabelOf = (label) => label.replace(/^Source \d+: /, '');

// One plain slider descriptor {path, label, displayLabel, min, max,
// step} (the format the header documents).
const makeDescriptor = (path, label, range) => ({
  path,
  label,
  displayLabel: displayLabelOf(label),
  min: range.min,
  max: range.max,
  step: range.step,
});

// The read/write funnel (plan "dahdsr" P3/S2): the ONE place the
// optional descriptor transforms are applied. The knob builder's
// initial read (cards.js buildControl), the edit commit (the card's
// `edit` closure), and the readout-sync setValue (main.js
// syncCardReadouts) all go through this pair — no forked wiring;
// a descriptor without transforms passes the raw value straight
// through (every pre-P3/S2 descriptor is untouched).
// (A null/undefined descriptor — a plain entry that carries no
// descriptor at all — passes the raw value straight through.)
export const descriptorRead = (descriptor, raw) =>
  descriptor?.read ? descriptor.read(raw) : raw;

export const descriptorWrite = (descriptor, raw, value) =>
  descriptor?.write ? descriptor.write(raw, value) : value;

// The nine DAHDSR level knobs (plan "dahdsr" P3/S2): one descriptor
// per parameter of the canonical 6-point level form (src/app/dahdsr.js
// — the app-tier home of that model), all addressing the SAME path
// (layers.i.levelEnv — the whole point array) and carrying
// read/write transforms over the canonical-form math:
//   read(raw)    pointsToDahdsr(normalizeLevelEnv(raw))[param]
//   write(raw,v)  dahdsrToPoints({ ...pointsToDahdsr(normalizeLevelEnv(raw)), [param]: v })
// so a knob turn re-derives ALL six points atomically with exactly
// this parameter changed (the no-split-brain rule: the canvas can
// only ever draw a shape the knobs can name). The normalizeLevelEnv
// wrap tolerates legacy non-canonical data on the way to P3/S3's
// load-time normalization (card build must not throw on an old
// 4-point knee); canonical input passes it through BY REFERENCE (zero
// cost, zero behavior change — the plan's pointsToDahdsr /
// dahdsrToPoints spec holds exactly). Ranges: the five spans share
// LEVEL_POINT_TIME_RANGE (a zero span is legitimate); sustain is a
// LEVEL, so it takes the layer.gain range from PARAM_RANGES (the
// single source of truth); the bends take CURVE_BEND_RANGE.
const LEVEL_KNOB_SPECS = [
  { param: 'delay', label: 'level delay (s)', range: LEVEL_POINT_TIME_RANGE },
  { param: 'attack', label: 'level attack (s)', range: LEVEL_POINT_TIME_RANGE },
  { param: 'hold', label: 'level hold (s)', range: LEVEL_POINT_TIME_RANGE },
  { param: 'decay', label: 'level decay (s)', range: LEVEL_POINT_TIME_RANGE },
  { param: 'release', label: 'level release (s)', range: LEVEL_POINT_TIME_RANGE },
  { param: 'sustain', label: 'level sustain', range: rangeFor('layer.gain') },
  { param: 'attackCurve', label: 'level attack curve', range: CURVE_BEND_RANGE },
  { param: 'decayCurve', label: 'level decay curve', range: CURVE_BEND_RANGE },
  { param: 'releaseCurve', label: 'level release curve', range: CURVE_BEND_RANGE },
];

// One DAHDSR level descriptor (see LEVEL_KNOB_SPECS): the plain
// {path, label, min, max, step} knob shape every other descriptor has
// (descriptorKind classifies it as a knob — the transforms are an
// attachment, not a new kind) plus the read/write transforms.
const makeLevelDescriptor = (base, prefix, spec) => {
  const label = `${prefix}: ${spec.label}`;
  return {
    path: `${base}.levelEnv`,
    label,
    displayLabel: displayLabelOf(label),
    min: spec.range.min,
    max: spec.range.max,
    step: spec.range.step,
    read: (raw) => pointsToDahdsr(normalizeLevelEnv(raw))[spec.param],
    write: (raw, value) =>
      dahdsrToPoints({ ...pointsToDahdsr(normalizeLevelEnv(raw)), [spec.param]: value }),
  };
};

// Descriptors for ONE layer, with full dot paths (`layers.${i}....`).
// Respects the shadowing rules of the header (GUIDELINES §2):
//   - pitchEnv exists → the freqAt hook overrides the constant
//     carrier.freq, so the sliders go on the envelope points
//     (start / time / end) and there is NO carrier.freq descriptor;
//   - indexEnv exists → the indexAt hook overrides the constant
//     modulator.index: sliders on the envelope points instead;
//   - a RING modulator multiplies the carrier instead of deviating it
//     (src/lib/fm.js, pattern 7), so its index is never used on the
//     carrier link; it scales only a cascade link it DRIVES
//     (`modulates`). With no target the index is never read by the
//     engine and its slider would be dead — verified: moving the ring
//     index 3 → 0 leaves the render byte-identical unless the ring
//     modulator cascades out (a cascade INPUT does not make it live —
//     the driver's index scales that link, not the target's).
// Noise layers: seed / cutoff / decay. `gain` is always emitted.
// Envelope-point descriptors assume the standard shapes the library's
// constructors build: pitchEnvelope / fmDepthEnvelope the canonical
// 2-point form (the point knobs address pts[0] / pts[1] by index —
// the band's free-form editing goes away in plan P4/S2, so the
// indices can never drift), and the level knobs are the DAHDSR
// transforms (LEVEL_KNOB_SPECS) over the canonical 6-point form, emit-
// ted for any layer that carries a (non-empty) levelEnv.
export const describeLayer = (layer, i) => {
  if (layer.type !== 'fm' && layer.type !== 'noise')
    throw new Error(
      `controls: unknown layer type ${JSON.stringify(layer.type)} (expected "fm" or "noise")`,
    );
  const base = `layers.${i}`;
  const prefix = `Source ${i + 1}`; // 1-based, the sub-tab convention (P3/S9)
  const out = [];

  if (layer.type === 'fm') {
    if (layer.pitchEnv) {
      out.push(
        makeDescriptor(`${base}.pitchEnv.0.v`, `${prefix}: pitch start (Hz)`, rangeFor('carrier.freq')),
        makeDescriptor(`${base}.pitchEnv.1.t`, `${prefix}: pitch time (s)`, ENVELOPE_TIME_RANGE),
        makeDescriptor(`${base}.pitchEnv.1.v`, `${prefix}: pitch end (Hz)`, rangeFor('carrier.freq')),
      );
    } else {
      out.push(makeDescriptor(`${base}.carrier.freq`, `${prefix}: carrier freq (Hz)`, rangeFor('carrier.freq')));
    }

    for (const [j, m] of (layer.modulators ?? []).entries()) {
      const mp = `${prefix}: modulator ${j + 1}`;
      out.push(makeDescriptor(`${base}.modulators.${j}.freq`, `${mp} freq (Hz)`, rangeFor('modulator.freq')));
      if (m.indexEnv) {
        // The engine reads BOTH envelope points (indexAt, engine.js
        // header) — the second anchor (the index the depth collapses
        // TO) gets a knob too, so the editor's anchors and the knobs
        // are 1:1 (the old UI never exposed it; the shadowing rules
        // above are unchanged).
        out.push(
          makeDescriptor(`${base}.modulators.${j}.indexEnv.0.v`, `${mp} FM index`, rangeFor('modulator.index')),
          makeDescriptor(`${base}.modulators.${j}.indexEnv.1.t`, `${mp} FM decay (s)`, ENVELOPE_TIME_RANGE),
          makeDescriptor(`${base}.modulators.${j}.indexEnv.1.v`, `${mp} FM index end`, rangeFor('modulator.index')),
        );
      } else if (!(m.ring && m.modulates === undefined)) {
        // Constant index: live unless this is the dead ring case above.
        out.push(makeDescriptor(`${base}.modulators.${j}.index`, `${mp} index`, rangeFor('modulator.index')));
      }
      if (m.feedback !== undefined)
        out.push(makeDescriptor(`${base}.modulators.${j}.feedback`, `${mp} feedback`, rangeFor('modulator.feedback')));
    }
  } else {
    // The seed first: it selects the deterministic transient
    // (src/lib/noise.js header), the rest shape the burst.
    out.push(
      makeDescriptor(`${base}.seed`, `${prefix}: seed`, rangeFor('noise.seed')),
      makeDescriptor(`${base}.cutoff`, `${prefix}: cutoff (Hz)`, rangeFor('noise.cutoff')),
      makeDescriptor(`${base}.decay`, `${prefix}: decay (s)`, rangeFor('noise.decay')),
    );
  }

  // Level envelope (the engine applies it to ANY layer type — noise
  // layers included): the nine DAHDSR knobs over the canonical 6-point
  // form (see the Level-envelope note in the header) — all addressing
  // the whole point array through read/write transforms.
  if (layer.levelEnv && layer.levelEnv.length) {
    for (const spec of LEVEL_KNOB_SPECS)
      out.push(makeLevelDescriptor(base, prefix, spec));
  }

  // Layer level in the mix — always live.
  out.push(makeDescriptor(`${base}.gain`, `${prefix}: gain`, rangeFor('layer.gain')));

  // The layer's own effect chain (the engine applies it after levelEnv,
  // in order) — the same static-list rules as the master chain,
  // addressed at this layer's effects array. This is what makes the
  // snare shell's resonator sliders (layers.1.effects.0.freq / .q) part
  // of the factory output.
  out.push(...describeFxList(layer.effects ?? [], `${base}.effects`));
  return out;
};

// Label prefix for an fx chain's position, derived from its base path:
// a source chain is 'layers.N.effects', the master chain is passed as
// 'masterEffects' (describePatch). Keeping the position in the label
// keeps labels unique when the same effect type exists on a source AND
// on the master chain (describePatch merges both lists into one).
// Exported (P5/S12): src/app/patch-ops.js reuses this EXACT
// validation for addFx / removeFx's basePath — the single source of
// truth for which fx base paths exist.
export const fxLabelPrefix = (basePath) => {
  const match = /^layers\.(\d+)\.effects$/.exec(basePath);
  if (match) return `Source ${Number(match[1]) + 1}`;
  if (basePath !== 'masterEffects')
    throw new Error(
      `controls: unknown fx base path '${basePath}' (expected 'masterEffects' or 'layers.N.effects')`,
    );
  return 'Master';
};

// Descriptors for the parameters of an EXISTING effect chain (static
// list — adding / removing / reordering slots comes with the chain
// editors, P3/S14–15). Paths are `<basePath>.<i>.<field>`, e.g.
// masterEffects.1.q. One descriptor per parameter field PRESENT on the
// fx object (besides its type): the engine fills omitted fields with
// defaults (the snare's compress omits attack/release), and a slider on
// a field the patch does not carry cannot resolve (setPath is strict),
// so only fields the patch actually has get sliders. An unknown fx type
// or a field missing from PARAM_RANGES throws — the drift guard. The
// base path is validated even for an empty chain, so a typo'd basePath
// fails loudly instead of silently relabeling.
export const describeFxList = (fxList, basePath) => {
  const prefix = fxLabelPrefix(basePath);
  const out = [];
  for (const [i, fx] of (fxList ?? []).entries()) {
    const typeLabel = FX_TYPE_LABELS[fx?.type];
    if (!typeLabel)
      throw new Error(
        `controls: unknown effect type ${JSON.stringify(fx?.type)} (expected saturate / highpass / resonate / compress)`,
      );
    for (const field of Object.keys(fx)) {
      if (field === 'type') continue;
      const range = rangeFor(`${fx.type}.${field}`);
      out.push(makeDescriptor(
        `${basePath}.${i}.${field}`,
        `${prefix}: ${typeLabel} ${i + 1} ${range.label}`,
        range,
      ));
    }
  }
  return out;
};

// Descriptors for a whole patch: describeLayer for every layer (full
// dot paths, shadowing rules as documented there, including each
// layer's own effect chain) plus the master effect chain. This list is
// what the UI turns into slider rows — src/app/main.js's initDrum runs
// the buildSlider loop over it (revamp P1/S3).
export const describePatch = (patch) => {
  if (!Array.isArray(patch?.layers))
    throw new Error('controls: describePatch needs a patch with a layers array');
  const out = patch.layers.flatMap((layer, i) => describeLayer(layer, i));
  out.push(...describeFxList(patch.masterEffects ?? [], 'masterEffects'));
  return out;
};

// ---- Envelope editor value range (revamp P1/S4) -----------------------
//
// The [min, max] the interactive envelope editor (src/app/main.js) may
// write into a point's v value, by envelope KIND. The editor's v clamp
// is driven by this table directly instead of a union over the slider
// descriptors (the S2 descriptor-union approach, dropped in S4):
//   level    → layer.gain      (level-envelope values are gains)
//   pitch    → carrier.freq    (pitch-envelope values are carrier Hz)
//   fm depth → modulator.index (index-envelope values are modulation
//                              indices)
// PARAM_RANGES is the single source of truth: a kind whose parameter
// lacks a table entry fails loudly (rangeFor throws).
export const editorValueRange = (kind) => {
  const key = {
    level: 'layer.gain',
    pitch: 'carrier.freq',
    'fm depth': 'modulator.index',
  }[kind];
  if (!key)
    throw new Error(
      `controls: unknown envelope kind ${JSON.stringify(kind)} (expected "level" / "pitch" / "fm depth")`,
    );
  const range = rangeFor(key);
  return [range.min, range.max];
};
