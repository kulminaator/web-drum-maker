// Structural patch ops (new-ui.md §4, plan P5/S12): the pure functions
// that change a patch's STRUCTURE — add/remove a source (layer),
// add/remove a modulator on an FM layer, add/remove an fx slot on the
// master or a layer's chain, and the mix views (withSolo, silentPatch,
// mixView — the mix's solo/enable state, P7/S17) — as opposed
// to editing parameter VALUES, which the UI does with setPath (which
// refuses container edits: a new layer/modulator/fx slot cannot be
// written to a path that does not exist yet).
//
// App tier, facade-only imports (GUIDELINES §1.4(b)): the ops
// manipulate patch DATA — the engine's schema (src/lib/engine.js
// header, via the facade) — not audio-rate math, so the only library
// import is the levelEnvelope constructor for the default level
// envelope, and the fx basePath validation is REUSED from controls.js
// (fxLabelPrefix — the exact rule describeFxList uses), never
// duplicated.
//
// Every op follows three contracts (the live-patch contract, new-ui.md
// §2.8, extended to structure):
//   1. PURE — an op never mutates its input. It returns a NEW patch
//      object with the changed container array (layers / masterEffects
//      / one layer's modulators or effects) replaced WHOLESALE via a
//      shallow clone (`{ ...patch, layers: [...patch.layers] }` etc.);
//      the untouched containers and the surviving layer/modulator/fx
//      objects carry over BY REFERENCE. Reference carry-over is what
//      keeps the card registry's layer-object identity (P5/S13) stable
//      across a structural change, and it is why everything the op
//      did not touch re-renders byte-identically.
//   2. FAILS LOUDLY — a bad type / index / path, or hitting a cap, is
//      a descriptive throw (repo style), never a silent no-op or a
//      TypeError from a bad shape.
//   3. THE OUTPUT ALWAYS RENDERS — test/patch-ops.test.mjs renders
//      every op's result at 8 kHz / 0.5 s (GUIDELINES §4) and asserts
//      it is non-silent and bounded.
//
// The UI funnels every structural change through these ops and replaces
// the drum's patch object WHOLESALE with the result (P5/S13): the card
// row then rebuilds from the fresh patch, and the surviving cards keep
// their identities because their layer objects are the same references.

import { levelEnvelope } from '../lib/index.js';
import { fxLabelPrefix } from './controls.js';

// Hard UI sanity cap: the ENGINE has no layer limit, but a card row
// past ~8 cards is unusable on one screen (new-ui.md §2.1 "all
// sources, one screen") — the cap lives here, and the throw documents
// it.
const MAX_LAYERS = 8;
// The engine's limit (src/lib/fm.js's MAX_MODULATORS), mirrored here
// so the card's [+ mod] button (P5/S14) can refuse BEFORE render time.
// Exported: the card's button wires its disabled state from this same
// constant (one source of truth for the cap).
export const MAX_MODULATORS = 4;
// The fx cap per chain (master or layer): four slots is the densest
// chain the card footer / master panel layout (P6/S15–16) fits.
// Exported: the card's [+ fx] button (P6/S15) wires its disabled state
// from this same constant (the MAX_MODULATORS precedent — one source
// of truth for the cap).
export const MAX_FX_SLOTS = 4;

// Default for a new FM source (addLayer 'fm') — a neutral, AUDIBLE
// starting point, mirroring the blankPatch precedent in presets.js
// (whose header comment-cites every value):
//   carrier 220 Hz, NO pitchEnv — the card's "add pitch env" flow
//     (P4/S11) applies: the source starts constant-freq;
//   one modulator at 440 Hz (the classic 2:1 first-sideband step,
//     drum_generation.md) with a CONSTANT index 5 — no indexEnv:
//     the user shapes the collapse with the card's controls;
//   carrier + modulator shape: 'sine' — the engine's documented
//     default (src/lib/engine.js header), carried FROM BIRTH (plan
//     sinecontrol P3/S7): the card's shape groups are field-presence
//     gated (cards.js's describeToggles — a control only addresses a
//     field the patch actually carries), so a created operator must
//     already carry the field for its shape group to bind;
//   gain 0.5 — half level, headroom for the other sources;
//   levelEnvelope 5 ms attack / 300 ms decay — the standard one-shot
//     (the kick body's times, drum_generation.md kick recipe);
//   effects: [] — a clean chain; the card's fx slots (P6/S15) add.
// KNEE_CURVE as the literal 0.55: patch-ops may only import through the
// facade (GUIDELINES §1.4(b)), and the constant is not part of the
// closed public API — its value and derivation live in src/lib/
// envelopes.js (KNEE_CURVE): the decay-curve bend that carries the
// legacy 4-point knee's sound into the canonical 6-point form.
const KNEE_CURVE = 0.55;

const newFmLayer = () => ({
  type: 'fm',
  carrier: { freq: 220, shape: 'sine' },
  modulators: [{ freq: 440, index: 5, shape: 'sine' }],
  gain: 0.5,
  levelEnv: levelEnvelope({
    attack: 0.005,
    decay: 0.3,
    decayCurve: KNEE_CURVE,
  }),
  effects: [],
});

// Default for a new noise source (addLayer 'noise'): seed 1 (the
// kick-click seed choice, src/lib/noise.js), cutoff 5000 Hz with a
// 100 ms decay — an audible MID-BAND burst (5 kHz sits above the 8 kHz
// test rate's Nyquist, so the 8 kHz test renders the noise default at
// 16 kHz — the rate adaptation test/hihat.test.mjs established; the
// app's 48 kHz preview rate renders it directly), gain 0.5 and the
// same standard one-shot level envelope as the FM default.
const newNoiseLayer = () => ({
  type: 'noise',
  seed: 1,
  cutoff: 5000,
  decay: 0.1,
  gain: 0.5,
  levelEnv: levelEnvelope({
    attack: 0.005,
    decay: 0.3,
    decayCurve: KNEE_CURVE,
  }),
  effects: [],
});

// The modulator addModulator appends (the [+ mod] default, P5/S14):
// 880 Hz — 2:1 above the default 440 Hz modulator, a distinct partial
// rather than an octave clone — with a CONSTANT index 3: no indexEnv,
// no ring; the user shapes it with the card's knobs and toggles.
// The shape: 'sine' default (the engine's documented default, src/lib/
// engine.js header) is carried FROM BIRTH — the modulator-add path
// rebuilds only the card's mod sub-section (NOT rebuildCardRow, where
// main.js materializes missing shape fields — the P5/S14 pattern), so
// the created modulator must already carry the field for its shape
// group to bind (the groups are field-presence gated — cards.js's
// describeToggles; plan sinecontrol P3/S7).
const newModulator = () => ({ freq: 880, index: 3, shape: 'sine' });

// Default objects for addFx's four types — a neutral, AUDIBLE start per
// type, comment-cited like blankPatch's values:
//   saturate drive 2 — the kick's master drive (drum_generation.md
//     Effects: "industrial and techno kicks often use this heavily");
//   highpass 2000 Hz — a mid-band start, below the 8 kHz test Nyquist
//     (the engine rejects cutoffs >= sr/2 at render time);
//   resonate 300 Hz, Q 5 — the snare shell's resonator center/Q
//     (src/lib/voices/snare.js; peak gain at center is Q);
//   compress threshold 0.3, ratio 3, makeup 1.2 — the SNARE'S MASTER
//     values verbatim (src/lib/voices/snare.js, drum_generation.md
//     Effects); attack/release omitted — the engine fills its
//     10 ms / 100 ms defaults (src/lib/engine.js COMPRESS_DEFAULTS).
const NEW_FX = {
  saturate: () => ({ type: 'saturate', drive: 2 }),
  highpass: () => ({ type: 'highpass', cutoff: 2000 }),
  resonate: () => ({ type: 'resonate', freq: 300, q: 5 }),
  compress: () => ({
    type: 'compress',
    threshold: 0.3,
    ratio: 3,
    makeup: 1.2,
  }),
};

// Every op takes a real patch (the engine's schema): an object with a
// layers array. A missing layers array is a wiring bug, not user input
// — fail loudly (repo style: descriptive errors, never a TypeError
// from .length below).
const requirePatch = (patch) => {
  if (!patch || typeof patch !== 'object' || !Array.isArray(patch.layers))
    throw new Error(
      `patch-ops: patch must be an object with a layers array, got `
      + `${JSON.stringify(patch) ?? typeof patch}`,
    );
};

// The layer at `i`, with the engine's index contract (an integer in
// [0, length)). A bad index is a wiring bug and fails loudly, naming
// the valid range.
const layerAt = (patch, i) => {
  if (!Number.isInteger(i) || i < 0 || i >= patch.layers.length)
    throw new Error(
      `patch-ops: layer index must be an integer in [0, `
      + `${patch.layers.length - 1}], got ${i}`,
    );
  return patch.layers[i];
};

// Resolve an fx chain's base path to { label, layerIndex, list }:
// 'masterEffects' (layerIndex null) or 'layers.<i>.effects'. The SHAPE
// validation is controls.js's fxLabelPrefix — the exact rule
// describeFxList uses, imported rather than duplicated (new-ui.md §4).
// By the time the parse below runs, fxLabelPrefix has already thrown
// on any other shape; a well-shaped path to a layer that does not
// exist (stale card wiring after a removal) fails loudly too.
const fxChainBase = (patch, basePath) => {
  const label = fxLabelPrefix(basePath); // throws on a bad shape
  const match = /^layers\.(\d+)\.effects$/.exec(basePath);
  if (!match) return { label, layerIndex: null, list: patch.masterEffects ?? [] };
  const layerIndex = Number(match[1]);
  layerAt(patch, layerIndex); // throws when the layer does not exist
  return { label, layerIndex, list: patch.layers[layerIndex].effects ?? [] };
};

// Append a new layer of `type` ('fm' | 'noise') and return the new
// patch (the layer defaults above, comment-cited). Refuses past 8
// layers — the hard UI sanity cap documented in the throw (the engine
// itself has no limit).
export const addLayer = (patch, type) => {
  requirePatch(patch);
  const make = type === 'fm' ? newFmLayer : type === 'noise' ? newNoiseLayer : null;
  if (!make)
    throw new Error(
      `patch-ops: unknown layer type ${JSON.stringify(type)} `
      + '(expected "fm" or "noise")',
    );
  if (patch.layers.length >= MAX_LAYERS)
    throw new Error(
      `patch-ops: at most ${MAX_LAYERS} layers — a card row past ~8 is `
      + 'unusable (hard UI sanity cap; the engine itself has no limit), '
      + `the patch already has ${patch.layers.length}`,
    );
  return { ...patch, layers: [...patch.layers, make()] };
};

// Drop layer `i` and return the new patch (the surviving layers carry
// over by reference — the card identities that key on layer objects
// survive, P5/S13). Refuses the last layer: a drum keeps at least one
// source (mirrors presets.removeDrum's rule — the card's [x] button
// shows the disabled state in that case, P5/S13).
export const removeLayer = (patch, i) => {
  requirePatch(patch);
  layerAt(patch, i);
  if (patch.layers.length <= 1)
    throw new Error(
      'patch-ops: cannot remove the last layer — a drum keeps at least '
      + 'one source (mirrors presets.removeDrum)',
    );
  return {
    ...patch,
    layers: patch.layers.slice(0, i).concat(patch.layers.slice(i + 1)),
  };
};

// Append the default modulator (newModulator above) to FM layer
// `layerIndex` and return the new patch. Throws for noise layers (they
// have no modulators) and at 4 modulators — the engine's limit
// (src/lib/fm.js, new-ui.md §7 "1–4, the engine's limit"); the cap is
// checked BEFORE render so the card's [+ mod] button can disable at 4
// (P5/S14).
export const addModulator = (patch, layerIndex) => {
  requirePatch(patch);
  const layer = layerAt(patch, layerIndex);
  if (layer.type !== 'fm')
    throw new Error(
      `patch-ops: addModulator needs an "fm" layer — layer ${layerIndex} `
      + `is ${JSON.stringify(layer.type)}`,
    );
  const modulators = layer.modulators ?? [];
  if (modulators.length >= MAX_MODULATORS)
    throw new Error(
      `patch-ops: layer ${layerIndex} already has ${MAX_MODULATORS} `
      + "modulators — the engine's limit (src/lib/fm.js)",
    );
  const layers = patch.layers.slice();
  layers[layerIndex] = { ...layer, modulators: [...modulators, newModulator()] };
  return { ...patch, layers };
};

// Drop modulator `modIndex` from FM layer `layerIndex` and return the
// new patch. A layer may end up with ZERO modulators: that is a plain
// sine carrier (the hi-hat's partials are exactly that,
// src/lib/voices/hihat.js) and the engine renders it fine — the card
// simply shows no modulator block (P5/S14).
//
// The surviving cascade references (`modulates`) are FIXED UP so the
// output always renders (contract 3): the engine indexes `modulates`
// into the modulator array (src/lib/fm.js) and throws on an out-of-
// range index or a cyclic graph, so a bare splice that left a reference
// pointing at the removed modulator would ship an unrenderable patch
// (and the UI can reach that state — the card's per-block [✕] removes
// any modulator, including a cascade target):
//   - a reference TO the removed modulator is cleared (undefined —
//     that driver falls back to its default role, driving the carrier;
//     the dead link cannot survive);
//   - a reference PAST the splice point shifts down by one, keeping it
//     on the same modulator.
// The input's references are in range and acyclic (the engine rejects
// the opposite at render time), so this never creates an out-of-range
// reference or a new cycle. Survivors needing no fixup carry over by
// reference (contract 1 — only the changed objects are new).
export const removeModulator = (patch, layerIndex, modIndex) => {
  requirePatch(patch);
  const layer = layerAt(patch, layerIndex);
  if (layer.type !== 'fm')
    throw new Error(
      `patch-ops: removeModulator needs an "fm" layer — layer ${layerIndex} `
      + `is ${JSON.stringify(layer.type)}`,
    );
  const modulators = layer.modulators ?? [];
  if (!Number.isInteger(modIndex) || modIndex < 0 || modIndex >= modulators.length)
    throw new Error(
      `patch-ops: layer ${layerIndex} has no modulator at index ${modIndex} `
      + `(it has ${modulators.length} modulators)`,
    );
  const survivors = modulators
    .map((m, i) => {
      if (i === modIndex) return null;
      // No reference, or a reference that stays valid at the same index
      // (a target before the splice): carry over untouched.
      if (m.modulates === undefined || m.modulates < modIndex) return m;
      const target = m.modulates === modIndex ? undefined : m.modulates - 1;
      return { ...m, modulates: target };
    })
    .filter((m) => m !== null);
  const layers = patch.layers.slice();
  layers[layerIndex] = { ...layer, modulators: survivors };
  return { ...patch, layers };
};

// Append a default fx of `type` (the NEW_FX defaults above) to the
// chain at `basePath` ('masterEffects' or 'layers.<i>.effects' — the
// same validation as describeFxList, reused from controls.js) and
// return the new patch. Caps the chain at 4 slots (the card footer /
// master panel fit four, P6/S15–16).
export const addFx = (patch, basePath, type) => {
  requirePatch(patch);
  const { label, layerIndex, list } = fxChainBase(patch, basePath);
  const make = NEW_FX[type];
  if (!make)
    throw new Error(
      `patch-ops: unknown effect type ${JSON.stringify(type)} `
      + '(expected saturate / highpass / resonate / compress)',
    );
  if (list.length >= MAX_FX_SLOTS)
    throw new Error(
      `patch-ops: at most ${MAX_FX_SLOTS} fx slots per chain — the ${label} `
      + `chain already has ${list.length}`,
    );
  if (layerIndex === null)
    return { ...patch, masterEffects: [...list, make()] };
  const layers = patch.layers.slice();
  layers[layerIndex] = { ...layers[layerIndex], effects: [...list, make()] };
  return { ...patch, layers };
};

// Drop fx slot `i` from the chain at `basePath` and return the new
// patch (an EMPTY chain is fine — the card shows its "no fx" hint,
// P6/S15).
export const removeFx = (patch, basePath, i) => {
  requirePatch(patch);
  const { label, layerIndex, list } = fxChainBase(patch, basePath);
  if (!Number.isInteger(i) || i < 0 || i >= list.length)
    throw new Error(
      `patch-ops: the ${label} chain has no fx slot at index ${i} `
      + `(it has ${list.length} slots)`,
    );
  const chain = list.slice(0, i).concat(list.slice(i + 1));
  if (layerIndex === null) return { ...patch, masterEffects: chain };
  const layers = patch.layers.slice();
  layers[layerIndex] = { ...layers[layerIndex], effects: chain };
  return { ...patch, layers };
};

// The mix-minus-solo view (P7's solo render): a new patch in which
// every layer NOT in `keepIndices` has gain 0 — a shallow layer clone,
// so the muted layers are NEW objects and the kept ones (and the
// master chain) carry over by reference. An EMPTY keepIndices means
// "no solo" = the full mix: the result is still a new patch object,
// but every layer carries over untouched, so it renders
// byte-identically to the input. Unknown indices (out of range or
// non-integer) are a wiring bug and fail loudly.
//
// NOTE the empty-keep semantics: "nothing is soloed" = everything
// plays. The OPPOSITE situation — nothing should play — is
// silentPatch (below): the two cannot share one code path.
export const withSolo = (patch, keepIndices) => {
  requirePatch(patch);
  if (!Array.isArray(keepIndices))
    throw new Error(
      `patch-ops: keepIndices must be an array of layer indices, got `
      + `${JSON.stringify(keepIndices) ?? typeof keepIndices}`,
    );
  for (const i of keepIndices)
    if (!Number.isInteger(i) || i < 0 || i >= patch.layers.length)
      throw new Error(
        `patch-ops: withSolo unknown layer index ${i} (the patch has `
        + `layers 0..${patch.layers.length - 1})`,
      );
  const keep = new Set(keepIndices);
  if (keep.size === 0) return { ...patch, layers: [...patch.layers] };
  return {
    ...patch,
    layers: patch.layers.map((layer, i) =>
      (keep.has(i) ? layer : { ...layer, gain: 0 })),
  };
};

// The all-muted mix view (P7/S17): a new patch in which EVERY layer
// has gain 0 — the render-ready patch when the mix view keeps nothing
// (every layer disabled, or every soloed layer also disabled). The
// complement of withSolo's empty-keep "full mix" semantics (see the
// note there). Contract 1 holds: shallow layer clones (every muted
// layer is a NEW object — a layer that already had gain 0 still gets
// a clone, so the view is never the input object), the master chain
// and every other field carry over by reference. The render is all
// zeros — the silence the disabled/solo mix view must produce, and
// what keeps a soloed-but-disabled source silent (P7/S17).
export const silentPatch = (patch) => {
  requirePatch(patch);
  return {
    ...patch,
    layers: patch.layers.map((layer) => ({ ...layer, gain: 0 })),
  };
};

// The render-ready MIX VIEW (P7/S17, the withSolo generalization):
// the mix's enable/solo state as layer INDICES — `disabledIndices`
// (the user-muted layers) and `soloIndices` (the soloed ones) —
// reduced to the patch to render:
//   - every disabled layer is zeroed (muting is a mix-view choice —
//     the patch the drum carries, and what is exported/saved, is
//     never touched);
//   - ANY solo active -> only the soloed AND enabled layers are kept
//     (solo ∩ enabled — a soloed-but-disabled source is silent);
//   - NO solo -> every enabled layer is kept;
//   - nothing kept (everything disabled, or every soloed layer also
//     disabled) -> silentPatch (all zeros — silence, NOT the full
//     mix: withSolo's empty-keep semantics would be wrong here).
// Pure and clone-first like withSolo (which does the zeroing): kept
// layers carry over by reference, so a view that keeps every layer
// renders byte-identically to the input — the default view (no
// disabled, no solo) IS the full mix. Unknown indices are a wiring
// bug and fail loudly, like withSolo's.
export const mixView = (patch, disabledIndices, soloIndices) => {
  requirePatch(patch);
  for (const [name, list] of [
    ['disabledIndices', disabledIndices],
    ['soloIndices', soloIndices],
  ])
    if (!Array.isArray(list))
      throw new Error(
        `patch-ops: ${name} must be an array of layer indices, got `
        + `${JSON.stringify(list) ?? typeof list}`,
      );
  for (const i of [...disabledIndices, ...soloIndices])
    if (!Number.isInteger(i) || i < 0 || i >= patch.layers.length)
      throw new Error(
        `patch-ops: mixView unknown layer index ${i} (the patch has `
        + `layers 0..${patch.layers.length - 1})`,
      );
  const disabled = new Set(disabledIndices);
  const solo = new Set(soloIndices);
  const enabled = [];
  patch.layers.forEach((_layer, i) => {
    if (!disabled.has(i)) enabled.push(i);
  });
  const keep = solo.size > 0 ? enabled.filter((i) => solo.has(i)) : enabled;
  if (keep.length === 0) return silentPatch(patch);
  return withSolo(patch, keep);
};
