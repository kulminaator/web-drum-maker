// Preset registry, named save slots (P8/S19), + pure drum-list
// operations (revamp P2/S5).
//
// App tier, deliberately: PRESETS is UI data — which starting patches
// the UI offers, under which labels, with which default hit duration —
// and the list operations are pure helpers. No audio-rate math here
// (GUIDELINES §3: the UI layer reads/writes parameters and triggers
// playback), and the library is reached ONLY through the facade
// src/lib/index.js (GUIDELINES §1.4(b)).
// The slot API (P8/S19) is the one stateful part of the module: it
// reads/writes localStorage (SLOT_KEY) behind the guard described in
// its section — unavailable storage is REPORTED ({ ok: false, reason }),
// never thrown for.
//
// A preset is { id, label, build, duration }:
//   - id: the stable registry key — the drum-list operations (and, from
//     revamp P2/S8, the "New drum" picker) address presets by it;
//   - label: the user-facing name;
//   - build: () => a fresh engine patch — the same contract as the voice
//     builders: every call returns new arrays, so two patches never
//     alias;
//   - duration: the preset's default hit duration in seconds — for the
//     classic three, the values the app boots with (DRUMS in
//     src/app/main.js, revamp P2/S6), pinned by test/presets.test.mjs.
// New voices join this list in P9/S22–24 (tom first; clap and cymbal
// follow).

import { normalizePatchEnvelopes } from './dahdsr.js';
import {
  clapPatch,
  cymbalPatch,
  fmDepthEnvelope,
  hihatPatch,
  kickPatch,
  levelEnvelope,
  snarePatch,
  tomPatch,
} from '../lib/index.js';

// The "Blank" preset: one FM source — the minimal building block a user's
// new drum starts from. There is no drum_generation.md recipe for it, so
// the values are a neutral, AUDIBLE starting point (every default
// comment-cited):
//   carrier 220 Hz (A3): mid-range — clearly audible on any speaker, not
//     drum-specific, and low enough to leave the modulator its role;
//   modulator 440 Hz: a 2:1 ratio is the classic first sideband step
//     (drum_generation.md, FM fundamentals), so the attack reads as a
//     pitch-related sideband burst, not random noise;
//   index 5 collapsing in 50 ms: an audible but tame burst — the same
//     index-collapses-to-zero shape as the kick recipe's 8 → 0 in 20 ms
//     (drum_generation.md, kick), gentler on both axes so it doesn't
//     startle a user who just wants to tweak;
//   level envelope 5 ms attack / 300 ms decay: the standard one-shot
//     shape — the kick body uses the same times (drum_generation.md,
//     kick recipe);
//   gain 0.5: half level — headroom for the sources the user will add.
const blankPatch = () => ({
  layers: [
    {
      type: 'fm',
      carrier: { freq: 220 },
      modulators: [
        {
          freq: 440,
          index: 5, // shadowed by indexEnv (engine convention, GUIDELINES §2)
          // FM-depth collapse: index → 0 in 50 ms (see header comment).
          indexEnv: fmDepthEnvelope({ from: 5, time: 0.05 }),
        },
      ],
      gain: 0.5,
      // KNEE_CURVE as the literal 0.55: presets.js may only import
      // through the facade (GUIDELINES §1.4(b)), and the constant is
      // not part of the closed public API — its value and derivation
      // live in src/lib/envelopes.js (KNEE_CURVE): the decay-curve
      // bend that carries the legacy 4-point knee's sound into the
      // canonical 6-point form.
      levelEnv: levelEnvelope({
        attack: 0.005,
        decay: 0.3,
        decayCurve: 0.55,
      }),
    },
  ],
  masterEffects: [], // no master FX — a clean starting point
});

// The preset registry: the classic three voices (the app boots with
// them, revamp P2/S6), the blank starting point, and the new voices
// (P9/S22–24 — appended, never reordered).
export const PRESETS = [
  { id: 'kick', label: 'Kick', build: () => kickPatch(), duration: 0.5 },
  { id: 'snare', label: 'Snare', build: () => snarePatch(), duration: 0.5 },
  { id: 'hihat', label: 'Hi-hat', build: () => hihatPatch(), duration: 0.3 },
  { id: 'blank', label: 'Blank', build: blankPatch, duration: 0.5 },
  // The tom's 250 ms level decay (drum_generation.md Tom Tom) settles
  // inside 0.4 s — long enough to ring, short enough to stay out of
  // the way in a loop.
  { id: 'tom', label: 'Tom', build: tomPatch, duration: 0.4 },
  // The clap is silent again by ~50 ms (drum_generation.md Clap) —
  // 0.3 s leaves tail room for UI-added FX, like the hi-hat's
  // short-hit duration.
  { id: 'clap', label: 'Clap', build: clapPatch, duration: 0.3 },
  // The cymbal's level release ends exactly at 1.5 s (drum_generation.md
  // Cymbal) — 1.5 s is the full ring at the default duration; the band's
  // ms axis grows to match (derived from the drum's duration, no
  // hardcode — the tick candidates already cover 500/1000/2000 ms).
  { id: 'cymbal', label: 'Cymbal', build: cymbalPatch, duration: 1.5 },
];

// ---- Named save slots (new-ui P8/S19) --------------------------------
//
// A slot is a named SNAPSHOT of one drum: the plain { name, duration,
// patch } shape the drum list already uses. `name` is the SLOT's name
// (the user's choice) — not the drum's: loading a slot into a drum
// keeps the drum's name (the preset is a starting point, not a rename;
// the same "preset = data, drum = session entry" separation the old UI
// had). The slots live in localStorage under SLOT_KEY as a JSON map of
// name -> { name, duration, patch }.
//
// The guard (the pivot §6 risk, carried over): localStorage can be
// UNAVAILABLE — private mode throws on access, a full quota throws on
// setItem. The slot API REPORTS that with { ok: false, reason:
// 'storage-unavailable' } instead of throwing, so the UI shows a
// visible note in the preset area rather than crashing the page.
// User-fixable errors still throw, descriptively: a bad slot name
// (validateSlotName) and corrupt stored JSON (parseSlots — never a
// silent null: a slot that cannot be read is an error, not an absence).
//
// No aliasing (the live-patch contract, new-ui.md §2.8): saveSlot
// deep-clones the drum's patch on the way in, and loadSlot deep-clones
// the stored slot on the way out — a live patch is never the stored
// object, so editing one cannot corrupt the other.
//
// Legacy envelope adoption (plan "dahdsr" P3/S3): the LOAD side
// (loadSlot) routes the fresh clone through normalizePatchEnvelopes —
// non-canonical envelope shapes (the pre-canonical 4-point knee level
// envs, the old free-form pitch / FM-depth point arrays) are LEGAL
// stored data and are SILENTLY migrated to the canonical DAHDSR form
// on the way out (a data migration, not an error). The SAVE side
// (saveSlot) preserves the stored shape as-is — the snapshot keeps
// whatever the live patch held, and the stored copy is never
// rewritten by a later load (clone-first, the input is never
// mutated in place).

// The localStorage key holding the slot map, and the name limit (the
// slot name shows in the top bar's select label — keep it short).
export const SLOT_KEY = 'fm-drum-machine:slots';
export const SLOT_NAME_MAX = 40;

// The guard's reason string (the UI's note renders it; the tests pin
// it): unavailable storage is an ENVIRONMENT condition, not a user
// error — the API reports it, it never throws for it.
const STORAGE_UNAVAILABLE = 'storage-unavailable';

// The saved-slot value namespace for the preset select's options: a
// slot NAMED "kick" must not collide with the registry id "kick"
// (a <select> needs unique values).
const SLOT_VALUE_PREFIX = 'slot:';

// The select value of a saved slot's option.
export const slotOptionValue = (name) => `${SLOT_VALUE_PREFIX}${name}`;

// The inverse: the saved-slot name a preset-select value addresses,
// or null when the value is a registry preset id (not a saved slot).
export const slotNameFromValue = (value) =>
  typeof value === 'string' && value.startsWith(SLOT_VALUE_PREFIX)
    ? value.slice(SLOT_VALUE_PREFIX.length)
    : null;

// The localStorage access guard (the pivot §6 risk): private mode
// throws on ANY access and a full quota throws on setItem — both map
// to { ok: false, reason } so the caller REPORTS (a visible note in
// the preset area) instead of crashing.
const readRaw = () => {
  try {
    const ls = globalThis.localStorage;
    return { ok: true, raw: ls.getItem(SLOT_KEY) };
  } catch {
    return { ok: false, reason: STORAGE_UNAVAILABLE };
  }
};

const writeRaw = (text) => {
  try {
    globalThis.localStorage.setItem(SLOT_KEY, text);
    return { ok: true };
  } catch {
    return { ok: false, reason: STORAGE_UNAVAILABLE };
  }
};

// The stored map: the JSON name -> { name, duration, patch }. A null
// raw value (nothing saved yet) is the empty map; anything that is
// not an object map is corrupt stored data — a descriptive throw
// (never a silent null: a slot that cannot be read is an error).
const parseSlots = (raw) => {
  if (raw === null) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`presets: stored slot data is corrupt (${err.message})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(
      `presets: stored slot data is not an object map of name -> slot (got ${
        Array.isArray(parsed) ? 'an array' : typeof parsed
      })`,
    );
  return parsed;
};

// Slot-name validation (every slot op): a non-empty string
// (whitespace-only counts as empty — the renameDrum convention), no
// path separators ('/' or '\\' — the name is ONE key in a flat map,
// and a separator would let one name address another slot's key), and
// at most SLOT_NAME_MAX characters.
const validateSlotName = (name) => {
  if (typeof name !== 'string' || name.trim() === '')
    throw new Error(
      `presets: slot name must be a non-empty string, got ${JSON.stringify(name)}`,
    );
  if (name.includes('/') || name.includes('\\'))
    throw new Error(
      `presets: slot name '${name}' must not contain a path separator ('/' or '\\')`,
    );
  if (name.length > SLOT_NAME_MAX)
    throw new Error(
      `presets: slot name is ${name.length} characters — the limit is ${SLOT_NAME_MAX}`,
    );
};

// List the saved slot names, SORTED (a stable order for the select's
// options). { ok: true, slots } — or { ok: false, reason } for
// unavailable storage (the guard; the UI shows a note). Corrupt
// stored data throws (parseSlots — the UI's note path catches it).
export const listSlots = () => {
  const access = readRaw();
  if (!access.ok) return { ok: false, reason: access.reason };
  return { ok: true, slots: Object.keys(parseSlots(access.raw)).sort() };
};

// Save the drum as the named slot — the plain { name, duration, patch }
// snapshot (the SLOT's name, not the drum's), the patch DEEP-CLONED on
// the way in (a live patch is never the stored object — the
// no-aliasing contract). Overwrites an existing slot of the same name.
// { ok: true } — or { ok: false, reason } for unavailable storage;
// throws for a bad name (validateSlotName) or a malformed drum.
export const saveSlot = (name, drum) => {
  validateSlotName(name);
  if (
    !drum
    || typeof drum !== 'object'
    || typeof drum.duration !== 'number' || !Number.isFinite(drum.duration) || drum.duration <= 0
    || !drum.patch || typeof drum.patch !== 'object'
  )
    throw new Error(
      'presets: saveSlot needs a drum { name, duration, patch } with a positive finite duration and a patch object',
    );
  const access = readRaw();
  if (!access.ok) return { ok: false, reason: access.reason };
  const slots = parseSlots(access.raw);
  slots[name] = {
    name,
    duration: drum.duration,
    patch: structuredClone(drum.patch),
  };
  const written = writeRaw(JSON.stringify(slots));
  if (!written.ok) return { ok: false, reason: written.reason };
  return { ok: true };
};

// Load the named slot: { ok: true, slot } with a FRESH deep clone of
// the stored { name, duration, patch } whose envelopes are adopted
// into the canonical DAHDSR form (normalizePatchEnvelopes — plan
// "dahdsr" P3/S3, the section note above; the loaded patch never IS
// the stored object — the no-aliasing contract, the load half) — or
// { ok: false, reason } for unavailable storage. Throws descriptively
// for a bad name, an unknown slot (naming the available ones), and
// corrupt stored data (naming the slot — never a silent null).
export const loadSlot = (name) => {
  validateSlotName(name);
  const access = readRaw();
  if (!access.ok) return { ok: false, reason: access.reason };
  let slots;
  try {
    slots = parseSlots(access.raw);
  } catch (err) {
    throw new Error(`presets: saved slot '${name}' cannot be read — ${err.message}`);
  }
  // hasOwn (not slots[name]): a slot named "constructor" must not
  // resolve to Object.prototype.constructor.
  if (!Object.hasOwn(slots, name))
    throw new Error(
      `presets: no saved slot named '${name}' (slots: `
        + `${Object.keys(slots).sort().join(', ') || 'none'})`,
    );
  const slot = structuredClone(slots[name]);
  // Adopt legacy envelope shapes into the canonical DAHDSR form on
  // the way out (the section note above): a fresh clone, so the
  // stored slot is never mutated; a canonical snapshot passes
  // through unchanged in value.
  slot.patch = normalizePatchEnvelopes(slot.patch);
  return { ok: true, slot };
};

// Delete the named slot. { ok: true } — or { ok: false, reason } for
// unavailable storage; throws for a bad name and for an unknown slot.
export const deleteSlot = (name) => {
  validateSlotName(name);
  const access = readRaw();
  if (!access.ok) return { ok: false, reason: access.reason };
  let slots;
  try {
    slots = parseSlots(access.raw);
  } catch (err) {
    throw new Error(`presets: saved slot '${name}' cannot be deleted — ${err.message}`);
  }
  if (!Object.hasOwn(slots, name))
    throw new Error(
      `presets: no saved slot named '${name}' to delete (slots: `
        + `${Object.keys(slots).sort().join(', ') || 'none'})`,
    );
  delete slots[name];
  const written = writeRaw(JSON.stringify(slots));
  if (!written.ok) return { ok: false, reason: written.reason };
  return { ok: true };
};

// The top bar's preset select's option list (revamp P2/S8, extended in
// P8/S19): one {value, label} per registry preset in registry order,
// THEN one per saved slot (listSlots — sorted names, a stable order):
// the slot's label carries the "Saved: " prefix and its value the
// "slot:<name>" namespace (slotOptionValue). The pure {value, label}
// contract is unchanged — a chosen value feeds main.js's
// onPresetSelect, which resolves it back to a { duration, patch }
// snapshot (presetById for a registry entry, loadSlot for a slot).
// Storage that is unavailable (private mode) or corrupt degrades to
// the registry-only list — this stays TOTAL (never throws): main.js
// shows the guard's result as a visible note in the preset area.
export const presetOptions = () => {
  const options = PRESETS.map((p) => ({ value: p.id, label: p.label }));
  try {
    const listed = listSlots();
    if (listed.ok)
      for (const name of listed.slots)
        options.push({ value: slotOptionValue(name), label: `Saved: ${name}` });
  } catch {
    // Corrupt stored slot data: the registry entries remain a usable
    // option list (the error itself is surfaced by main.js's note).
  }
  return options;
};

// Look up a preset by id. Fails loudly, naming the available ids, so a
// typo in the picker wiring or a stale id in saved data is an immediate,
// diagnosable error rather than a silent null.
export const presetById = (id) => {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset)
    throw new Error(
      `presets: unknown preset '${id}' (available: `
        + `${PRESETS.map((p) => p.id).join(', ')})`,
    );
  return preset;
};

// ---- JSON export/import (new-ui P8/S20) ------------------------------
//
// The drum's portable file format: a FORMATTED JSON string of the same
// plain { name, duration, patch } snapshot the saved slots store
// (S19) — the drum's name, its hit duration in seconds, and the patch
// as the engine's schema. drumToJson / jsonToDrum are PURE (no Blob /
// file I/O — that glue is the top-bar buttons' call sites in main.js,
// the clearly-named I/O boundary, GUIDELINES §3); the JSON text is the
// entire transfer format, so a file exported here imports back to a
// deep-equal drum.
//
// jsonToDrum validates the shape it accepts, descriptively (the repo's
// fail-loudly style — a file the user cannot fix should say what is
// wrong with it): a non-object root, a missing/empty name, a
// non-positive or non-finite duration, a missing/empty layers array, an
// unknown layer type. The DEEPER fields (the carrier's freq, the
// envelope points) are the engine's validation — renderPatch rejects
// what the schema does not allow, and the import path (like the preset
// load) re-renders through updateDrum.
//
// No aliasing, the same contract as loadSlot: jsonToDrum returns a
// FRESH structuredClone of the validated snapshot — exactly the
// documented shape, no extra top-level keys — so the caller gets an
// object it owns and can install as a live patch. The clone's
// envelopes are then adopted into the canonical DAHDSR form
// (normalizePatchEnvelopes, plan "dahdsr" P3/S3): legacy shapes (the
// pre-canonical 4-point knee, the old free-form point arrays) are
// LEGAL file input and are silently migrated on import, while an
// already-canonical file passes through byte-identical — the
// export -> import round-trip stays stable.

// The layer types the engine renders (src/lib/engine.js's schema) —
// the validator's accepted set, named in its throws.
const LAYER_TYPES = ['fm', 'noise'];

// The shared shape check: drumToJson AND jsonToDrum both run it, so a
// file this app exports is a file this app imports (the round-trip
// invariant — an export can never produce text the import rejects).
// `what` is the subject the messages name ('drum JSON').
const validateDrumShape = (drum, what) => {
  if (typeof drum !== 'object' || drum === null || Array.isArray(drum))
    throw new Error(
      `presets: ${what} root must be a plain object, got ` +
        `${Array.isArray(drum) ? 'an array' : drum === null ? 'null' : typeof drum}`,
    );
  if (typeof drum.name !== 'string' || drum.name.trim() === '')
    throw new Error(
      `presets: ${what} needs a non-empty string name, got ${JSON.stringify(drum.name)}`,
    );
  if (
    typeof drum.duration !== 'number'
    || !Number.isFinite(drum.duration)
    || drum.duration <= 0
  )
    throw new Error(
      `presets: ${what} needs a finite duration > 0 in seconds, got ${JSON.stringify(drum.duration)}`,
    );
  if (
    typeof drum.patch !== 'object'
    || drum.patch === null
    || Array.isArray(drum.patch)
  )
    throw new Error(
      `presets: ${what} needs a patch object, got ` +
        `${Array.isArray(drum.patch) ? 'an array' : drum.patch === null ? 'null' : typeof drum.patch}`,
    );
  const layers = drum.patch.layers;
  if (!Array.isArray(layers))
    throw new Error(
      `presets: ${what}'s patch needs a layers array, got ` +
        `${layers === undefined ? 'nothing (missing)' : typeof layers}`,
    );
  if (layers.length === 0)
    throw new Error(`presets: ${what}'s patch needs at least one layer`);
  layers.forEach((layer, i) => {
    const type =
      typeof layer === 'object' && layer !== null && !Array.isArray(layer)
        ? layer.type
        : layer;
    if (!LAYER_TYPES.includes(type))
      throw new Error(
        `presets: ${what}'s patch layer ${i} has an unknown layer type ` +
          `${JSON.stringify(type)} (expected "fm" or "noise")`,
      );
  });
};

// Serialize the drum to its portable form: the plain
// { name, duration, patch } snapshot (the S19 slot's shape), formatted
// with 2-space indent — the file is human-readable, not minified.
// Field selection (not a whole-object dump) is deliberate: a live drum
// carries APP-TIER state (color, workingSource, the mix-view Sets —
// P7/S17) that is not patch data and must never leave the app (the
// exported/saved patch is the engine's schema and nothing else).
export const drumToJson = (drum) => {
  validateDrumShape(drum, 'drum JSON');
  return JSON.stringify(
    { name: drum.name, duration: drum.duration, patch: drum.patch },
    null,
    2,
  );
};

// Parse + validate a drum's portable form back into a plain object
// (the inverse of drumToJson). Throws descriptively for invalid JSON
// text (a NaN duration literal dies HERE — JSON.parse rejects it) and
// for every bad shape (validateDrumShape). Returns a FRESH deep clone
// of the validated snapshot with its envelopes adopted into the
// canonical DAHDSR form (normalizePatchEnvelopes — plan "dahdsr"
// P3/S3, the section note above) — the no-aliasing contract, the
// load half (loadSlot's precedent).
export const jsonToDrum = (text) => {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`presets: drum JSON is not valid JSON (${err.message})`);
  }
  validateDrumShape(parsed, 'drum JSON');
  const drum = structuredClone({
    name: parsed.name,
    duration: parsed.duration,
    patch: parsed.patch,
  });
  // Adopt legacy envelope shapes into the canonical DAHDSR form on
  // the way out (the section note above): a fresh clone, so the
  // parsed file data is never mutated; a canonical file passes
  // through unchanged in value (the round-trip stays stable).
  drum.patch = normalizePatchEnvelopes(drum.patch);
  return drum;
};

// ---- Pure drum-list operations ----------------------------------------
//
// The app's drum list is an array of { name, duration, patch } — the
// exact shape the app's drum list (DRUMS in src/app/main.js, revamp
// P2/S6) and exportDrum (src/app/export-wav.js) use. Every operation returns a NEW
// list and never mutates its input (GUIDELINES §3: pure functions).
// The live-patch contract applies to `patch` itself: addDrum hands out
// a structuredClone of the built patch, so a live patch never aliases
// the registry's build output or another drum's patch — the user edits
// their live patch in place (setPath) without corrupting anything the
// registry or the other drums hold. remove/rename carry the surviving
// entries over by reference (the same live objects the UI already
// holds — cloning here would silently orphan the UI's references).

// Descriptive precondition (repo style: fail loudly, never a TypeError
// from .map on a non-array).
const requireDrumList = (drums) => {
  if (!Array.isArray(drums))
    throw new Error(
      `presets: drums must be an array of { name, duration, patch }, got ${typeof drums}`,
    );
};

// Uniquify a base name against the list's current names:
// kick, kick-2, kick-3, ... (new, new-2, ... for the top bar's
// "+ drum" — main.js reuses it so the naming rule lives in ONE place).
// Exported like controls.js's fxLabelPrefix (revamp P5/S12): an app-tier
// export with no boundary impact — the library facade is untouched.
export const uniqueDrumName = (drums, base) => {
  const taken = new Set(drums.map((d) => d.name));
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return name;
};

// Append a drum built from `presetId`: the preset's default duration and
// a deep CLONE of a fresh build (see the section comment above).
export const addDrum = (drums, presetId) => {
  requireDrumList(drums);
  const preset = presetById(presetId);
  return [
    ...drums,
    {
      name: uniqueDrumName(drums, preset.id),
      duration: preset.duration,
      patch: structuredClone(preset.build()),
    },
  ];
};

// Drop the drum named `name`. Refuses both the empty result (a drum list
// keeps at least one drum — the UI's remove button mirrors this guard)
// and an unknown name.
export const removeDrum = (drums, name) => {
  requireDrumList(drums);
  const i = drums.findIndex((d) => d.name === name);
  if (i < 0)
    throw new Error(
      `presets: no drum named '${name}' to remove (drums: `
        + `${drums.map((d) => d.name).join(', ')})`,
    );
  if (drums.length <= 1)
    throw new Error(
      'presets: cannot remove the last drum — a drum list keeps at least one drum',
    );
  return drums.slice(0, i).concat(drums.slice(i + 1));
};

// Rename the drum `oldName` to `newName`. Validates: the new name is
// non-empty (whitespace-only counts as empty) and clashes with no
// existing drum name. The renamed entry is a NEW object; the live patch
// reference carries over — renaming changes identity, not sound.
export const renameDrum = (drums, oldName, newName) => {
  requireDrumList(drums);
  if (typeof newName !== 'string' || newName.trim() === '')
    throw new Error(
      `presets: new drum name must be a non-empty string, got ${JSON.stringify(newName)}`,
    );
  const i = drums.findIndex((d) => d.name === oldName);
  if (i < 0)
    throw new Error(
      `presets: no drum named '${oldName}' to rename (drums: `
        + `${drums.map((d) => d.name).join(', ')})`,
    );
  if (drums.some((d) => d.name === newName))
    throw new Error(`presets: a drum named '${newName}' already exists`);
  return drums.map((d, j) => (j === i ? { ...d, name: newName } : d));
};
