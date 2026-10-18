// Public API of the audio library. This is the only module the binding
// layer (`src/app/`) may import. Adding an export is a library API change
// — say why in the commit message.
//
// The export list is closed and deliberate. It is everything the binding
// currently needs, plus the envelope constructors and evaluator,
// isolateLayer, and the WAV encoder, which are legitimate library-level
// features a UI-less host would want (building custom patches, evaluating
// envelope points, isolating layers, exporting rendered hits to WAV
// files). Point arrays are edited by building a new sorted array and
// writing it with setPath — the app tier does that through its
// canonical-form helpers (src/app/dahdsr.js); the free-form point helpers
// are gone (plan "dahdsr" P5: four exports removed, none added).
// Low-level primitives (sineSample, renderFmLayer, saturate, mixLayers,
// ...) are intentionally NOT exported — they are internals for the unit
// tests, not the public surface. test/facade.test.mjs (plan step 15) locks
// this list.

// Patch renderer: render a patch to a Float32Array, or copy out a single
// layer for per-layer views.
export { renderPatch, isolateLayer } from './engine.js';

// Drum voices: one parameterized patch builder per drum
// (see drum_generation.md for the recipes).
export { kickPatch } from './voices/kick.js';
export { snarePatch } from './voices/snare.js';
export { hihatPatch } from './voices/hihat.js';
export { tomPatch } from './voices/tom.js';
export { clapPatch } from './voices/clap.js';
export { cymbalPatch } from './voices/cymbal.js';

// Patch-path plumbing: read/write/clamp arbitrary patch parameters by
// dot-separated path — the neutral API any host needs to edit live patches.
export { getPath, setPath, clamp } from './params.js';

// One-shot envelopes (level / pitch / FM depth): the constructors build
// the canonical point forms, envelopeValue evaluates them. The point
// arrays are edited through the canonical-form helpers in the app tier
// (src/app/dahdsr.js) and the per-segment `curve` field — not free-form
// insertion (plan "dahdsr" P5 removed the point-editing helpers).
export {
  levelEnvelope,
  pitchEnvelope,
  fmDepthEnvelope,
  envelopeValue,
} from './envelopes.js';

// Single-bin DFT magnitude, shared with the app's spectrum view.
export { goertzelMag } from './dsp.js';

// One-period wave-shape samples, shared with the app's per-operator
// shape previews (src/app/viz.js).
export { waveShapePoints } from './osc.js';

// WAV encoding: turn a rendered hit into RIFF/WAVE file bytes — a
// first-class export feature a UI-less host would want (the browser-side
// download glue lives in src/app/).
export { encodeWav } from './wav.js';
