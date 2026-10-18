# Development Guidelines

Short version: clean and minimalistic ES6 code with a plain HTML5 interface,
no external dependencies, all synthesis in JavaScript (Web Audio only for
playback), and every development step covered by a fast, passing test suite.
Details below.

## 1. Core constraints (non-negotiable)

### 1.1 No external dependencies

- No npm packages, no CDN scripts, no web fonts, no frameworks (no React,
  Vue, etc.).
- No build step: the app is plain ES6 modules loaded directly by the browser
  (`<script type="module">`). Anything that would require transpilation,
  bundling, or a package install is out of scope.
- Node.js may be used **only as a tool for running tests** — nothing that
  executes in the browser may require Node.

### 1.2 All synthesis in JS; Web Audio only for playback

- Every audio-rate process — oscillators, FM and ring modulation, linear
  mixing, envelopes, noise, filters, saturation, compression, and anything
  else that shapes the sound — must be implemented as JavaScript math that
  produces sample values (`Float32Array`).
- The Web Audio API is allowed **only for playback**: creating `AudioBuffer`s,
  `AudioBufferSourceNode` scheduling, output gain/routing, sample-rate
  configuration, and (if ever needed) UI meters.
- Rationale: deterministic, unit-testable, portable sound generation that
  does not depend on the browser's audio implementation.

### 1.3 Tests for everything, and a fast suite

- After every development step, the new or changed code must be covered by
  tests, and the full test suite must pass before the step is considered
  done.
- The suite must remain reasonably fast: target **under ~10 seconds
  wall-clock** for the whole run, no network access, no real-time playback,
  no flaky timing-based assertions.
- Every test run and evaluation must be executed **with a timeout** (e.g.
  `timeout 30 node --test` for the whole run, or the runner's per-test limit
  `node --test --test-timeout=10000`), so that an endless loop in new code
  fails fast instead of hanging the session indefinitely.
- Pure DSP math must be testable without Web Audio — a direct consequence of
  1.2.

### 1.4 Layering: library / binding / UI

The code is split into three tiers — `index.html` → `src/app/` →
`src/lib/` — and the boundaries between them are non-negotiable. They are
enforced mechanically by `test/library-purity.test.mjs` and
`test/app-boundary.test.mjs`:

- (a) `src/lib/` is **pure** — no DOM, no Web Audio, no browser globals,
  and its imports stay within `src/lib/`. It must run in a host with no
  UI at all (see the Node example in README.md).
- (b) `src/app/` is the **only tier that may touch** the DOM, the canvas,
  `requestAnimationFrame`, or Web Audio, and it may import the library
  **only** through the facade `src/lib/index.js` — no deep imports into
  `src/lib/` internals.
- (c) `index.html` loads **only the binding entry** (`src/app/main.js`).
- (d) The facade's header documents the **closed public API** — adding an
  export is a library API change; say why in the commit message
  (`test/facade.test.mjs` locks the export list).
- (e) **No UI metadata** (labels, slider ranges) in library modules —
  that lives in `src/app/` (`controls.js`). No raw color literals in
  `src/app/` (other than `theme.js`) or in the `index.html` body (other
  than the `:root` block) — every color is a theme token, and the
  `:root` ↔ `theme.js` mirror is drift-guarded by `test/theme.test.mjs`.

Tests are exempt from (b): they test internals directly and may import
any `src/` module deeply.

## 2. Sound design

- Drum recipes, interaction patterns (cascaded FM, feedback, ring mod, ...),
  and effects notes live in [drum_generation.md](drum_generation.md). 
- Foundational theory: Fm synthesis by Chowning (1973), available on the internet.
- Implement one drum voice at a time. Each voice is a module in
  `src/lib/voices/` that exposes a parameterized patch the engine can
  render.
- The engine patch schema (documented in the `src/lib/engine.js`
  header) is the data model the UI edits: value edits go through
  `setPath`/`getPath`, structural container changes (adding or removing
  layers, modulators, or FX) go through the pure, clone-first ops in
  `src/app/patch-ops.js` because `setPath` refuses container edits, and
  card identity ("Source N") is UI state, not patch data. An optional
  schema field with an engine default (e.g. operator `shape`, default
  `'sine'`) is materialized in place by the UI when the control first
  binds to it — `setPath` stays strict, and the in-place write preserves
  the layer object identity the card registry is keyed on (the
  add-pitch-env precedent, now used for the wave-shape defaults too).
- The level envelope is stored in the canonical **DAHDSR 6-point form**
  (Delay / Attack / Hold / Decay / Sustain / Release): always exactly
  six points with fixed roles, zero-length spans (duplicate-t points)
  for inactive parameters, and the value pattern 0/0/1/1/s/0 — silent
  start, peak fixed at 1.0 (the layer `gain` is the level). A point's
  optional `curve` (0…1) exponentially bends its OUTGOING segment
  (absent = linear — the `shape`-default precedent, now also `curve`;
  the easing math is in `src/lib/envelopes.js`). The UI's DAHDSR knobs
  and the constrained canvas editor are PROJECTIONS of those same point
  arrays — no separate envelope state, no free-form point editing: a
  shape the knobs cannot name is not a shape the editor can draw.
  Legacy non-canonical envelopes (the old 4-point knee, free-form
  imports) are normalized into the canonical form once, at the
  import/load choke point in `src/app/presets.js` (`jsonToDrum` /
  `loadSlot`, clone-first; the math in `src/app/dahdsr.js`).
- DSP conventions that span modules: operators are **sample-then-advance**
  (read the current phase, compute the sample, *then* advance the phase) —
  this is what keeps `index → 0` sample-identical to the plain carrier
  (Chowning eq. 1); and in the engine, envelope points (`pitchEnv` /
  `indexEnv`) **override** the constant `carrier.freq` / `modulator.index`
  fields, so a parameter is either envelope-driven or constant — UI
  descriptors must not address a shadowed constant (see the shadowing
  notes in `src/app/controls.js`).

## 3. Code style

- ES6 modules (`import`/`export`); `const`/`let` (never `var`); arrow
  functions where natural.
- Naming: `camelCase` for variables and functions, `PascalCase` for classes,
  `kebab-case` for file names in `src/` and `test/`.
- Prefer small, **pure functions** for DSP (in: parameters, out: scalar or
  `Float32Array`). No globals, no module-level mutable state, no side
  effects outside clearly named I/O boundaries (rendering a buffer, DOM
  updates).
- Keep the UI layer thin: it reads/writes parameter values and triggers
  playback. No audio math in UI code.
- Comment DSP formulas and non-obvious parameter values (e.g. "20 ms FM
  decay — see drum_generation.md, kick recipe"). Explain *why*, not *what*.
- No dead code, no commented-out blocks, no leftover `console.log`.
- Single-page app: one `index.html`, no routing.

## 4. Testing policy

- Location and naming: `test/<module>.test.mjs`, one file per `src/` module.
- Runner: Node's built-in test runner — `node --test` (no path argument;
  it recursively discovers `test/*.test.mjs`). No test
  framework; use `node:test` and `node:assert` (Node is a dev tool only,
  see 1.1). Always run it **with a timeout** (e.g. `timeout 30 node --test`,
  per §1.3) so an endless loop in new code fails fast instead of hanging.
- Memory restrictions: our tests shall not use more than 1GB of RAM.

- What to test, in priority order:
  1. **DSP math** — oscillator phase and wrap-around, envelope shape and
     endpoints, FM behavior (e.g. index → 0 recovers the plain carrier),
     mixer linearity, effect bounds (output stays within ±1 after the
     final stage).
  2. **Patch-level renders** — a rendered hit has the expected length, is
     non-silent, and decays as designed (e.g. energy in a late window <
     energy in the attack window).
  3. **Parameter plumbing** — changing a patch parameter actually changes
     the rendered output.
- Keep it fast: render at a low sample rate (e.g. 8 kHz) and short duration
  (≤ 0.5 s) in tests; assert on *properties* of the buffer, never on
  full-buffer equality.
- Shared DSP helpers live in `src/lib/` where the app uses them (e.g. the
  Goertzel single-bin magnitude in `src/lib/dsp.js`, shared via the facade
  `src/lib/index.js` with `src/app/viz.js` and the tests). A `test/` file
  that only re-exports a helper is a compatibility shim, not a test —
  never duplicate math between `src/` and `test/`.
- A change that breaks an existing test is not merged. Fix the test only if
  it encoded a wrong expectation, and say so in the commit message.

## 5. Documentation

- `README.md` — what the project is, why FM for drums, architecture, how to
  run. Update it whenever the architecture or the run/test commands change.
- `drum_generation.md` — the sound-design spec. Keep its recipes in sync
  with what `src/lib/voices/*` actually implements.
- This file — update the guidelines when a new cross-cutting constraint
  emerges; rules should not live only in chat history.
- Visual changes are screenshot-verified: a step that changes the visual
  layer (CSS, canvas painting) is verified with a real
  `chromium-headless-shell` screenshot, kept in git-ignored `tmp/` — the
  browser is a dev tool, like Node (§1.1).

## 6. Workflow and definition of done

- Small, focused commits with imperative messages ("add kick voice FM
  body", not "stuff").
- **Commit often.** Don't let large piles of uncommitted work build up:
  commit at every small, coherent checkpoint — a working step, a green
  test suite, a finished sub-task — rather than hoarding changes until
  the end of a session. If a session might be interrupted, that is the
  moment to commit; easy to add another small commit later, hard to
  salvage one big blob.
- `additional-docs/` is local reference material and stays git-ignored;
  never commit it.
- A change is **done** when:
  1. it works in the browser (static server → open the page),
  2. new/changed code has tests and `node --test` passes,
  3. `README.md` / `drum_generation.md` / `GUIDELINES.md` reflect the
     change where applicable.
