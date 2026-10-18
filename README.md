# A web based FM Drum Maker

> A web interface to generate wonderful drum sounds with FM synthesis and
> multiple oscillator sources. Pure ES6 JavaScript, a plain HTML5 interface,
> and zero external dependencies.

The project is still under development. You can peek around.

The interactive interface is available at [https://kulminaator.github.io/web-drum-maker/](https://kulminaator.github.io/web-drum-maker/)

**Status:** The UI is a per-source knob-card builder wearing a joyful
indigo-dusk theme — a deep indigo base under a tokenized sunset
gradient wash — with a warm coral accent (the per-drum color coding
kept): all sources of the selected drum on one screen — self-contained
knob cards with dense 3-column knob grids, short captions, and
thicker knob outlines (with the DAHDSR level envelope —
delay/attack/hold/decay/sustain/release + per-segment curve — and a
full-screen visual editor (top bar + loop playback stay live while
editing), per-operator wave-shape control (sine / square / saw /
triangle) with live one-period previews, and FX slots), a top
waveform + read-only, note-labeled pitch-curve overview band, a master
panel (length, output level, per-source fader strip with enable/solo,
master FX chain), seven presets (kick, snare, hi-hat, blank, tom,
clap, cymbal) plus named save slots, JSON patch export/import, tempo
loop playback with a playhead on the band, and WAV export of the mix
and of single sources (16/24/32-bit at 22.05/44.1/48 kHz, defaulting
to 48 kHz / 32-bit float). The knobs are verified to turn clockwise
on increase — drag, wheel, and keys all raise the value upward. Every
sound still renders entirely in JavaScript (Web Audio only plays back
each rendered hit), all behind a passing 676-test suite. See
[GUIDELINES.md](GUIDELINES.md) for the development rules.

## Why FM for drums

Most drums are not stable pitched tones like a flute or a violin. They
contain:

- very short transients (the "click" at the start),
- rapidly changing frequencies,
- noise-like components,
- multiple resonances ringing at different rates.

Frequency modulation (FM) excels at producing exactly this kind of
fast-changing, inharmonic spectrum. With a carrier, a modulator, and
envelopes applied to the modulation depth, a handful of sine oscillators can
create a dense burst of sidebands that collapses into clean resonances within
50–200 ms. That "controlled explosion of harmonics that rapidly collapses"
is what a drum hit is.

Full design notes (voice recipes, interaction patterns, effects) are in
[drum_generation.md](drum_generation.md). The foundational theory is in
Chowning's 1973 paper.

## Goals

- Generate drum sounds (kick, snare, and hi-hat first; more later) entirely
  in JavaScript — no audio samples, no plugins, no external audio
  libraries.
- Use **multiple oscillator sources** per drum. One FM pair can only create
  one "cluster" of sidebands; a real drum is many resonant systems at once
  (attack click, body, shell, metallic rattle), so each component gets its
  own dedicated source.
- **Show the sound, don't just play it.** The user interface must include
  pretty, real-time visuals of the generated waveforms: the rendered
  time-domain waveform of the hit and a spectrum view, drawn with the plain
  HTML5 `<canvas>` — no external visualization libraries.
- **Tools to manage the synthesis.** The interface must provide interactive
  tools for shaping the sound — in particular an envelope editor for the
  level, pitch, and FM depth envelopes — plus per-operator controls (ratio,
  index, feedback), layer levels, and effect parameters. Every synthesis
  parameter (levels, pitches, ratios, envelope times, FM depth, effects)
  is exposed through these controls in a minimal HTML5 interface.
- Stay dependency-free: ES6 modules + a single HTML page, no frameworks,
  no build step, no npm.

## How the sound is made

### FM fundamentals

A carrier at frequency `Fc` modulated by a modulator at `Fm` with
modulation index `I` produces a family of sidebands at `Fc ± n·Fm`
(Bessel-weighted). Drums exploit this with **very short FM-depth
envelopes**: the index starts high (dense, bright, noise-like sidebands —
the attack) and collapses to zero within tens of milliseconds (settling
into the pure carrier — the body). Every operator's waveform is
user-selectable (sine by default; square / saw / triangle), and a
shaped modulator shapes the deviation signal itself — see
[drum_generation.md](drum_generation.md), Wave Shape.

A minimal kick, for example:

- Carrier: sine, 50 Hz, with a pitch envelope 100 Hz → 50 Hz in ~30 ms
- Modulator: sine, 200 Hz
- FM depth: high → 0 in ~20 ms

### Multiple oscillator sources and interaction patterns

The engine supports the interaction patterns described in
[drum_generation.md](drum_generation.md):

| # | Pattern | Typical use |
|---|---------|-------------|
| 1 | Linear mixing (no interaction) | layering a click on top of a body |
| 2 | FM (one oscillator modulates another) | sideband bursts, metallic character |
| 3 | Multiple modulators on one carrier | snare attack, cymbals |
| 4 | Cascaded FM (DX7-style chain) | noise bursts, harsh transients |
| 5 | Feedback (an operator modulates itself) | richer sine → saw-like → noise-like |
| 6 | Cross-modulation (mutual modulation) | nonlinear, chaotic metallic textures |
| 7 | Ring modulation (`Osc1 × Osc2`) | bells, cowbells, hi-hats |

### Layers, noise, and effects

A drum voice is a small network of coupled sources plus effects, e.g.:

```
Kick   = FM sine body        + short noise click        + saturation
Snare  = FM shell resonance  + filtered noise burst     + resonator
HiHat  = several oscillators at inharmonic ratios
         (e.g. 1.000 / 1.231 / 1.342 / 2.103 / 3.487 / 5.119)
         → dense beating → high-pass filter → fast decay
```

Effects (saturation/distortion, simple compression, filters, resonators)
contribute as much as the synthesis itself — and because they shape the
sound, they are part of the synthesis and therefore implemented in JS as
well. See the core constraints in [GUIDELINES.md](GUIDELINES.md).

## Architecture

### Core constraint

**All synthesis happens in plain JavaScript.** The engine computes raw
samples (a `Float32Array`) for each hit. The Web Audio API is used only for
playback: wrapping the result in an `AudioBuffer`, scheduling an
`AudioBufferSourceNode`, and routing it to the output. No Web Audio node may
act as a synthesis element (no native oscillators, no native filters in the
sound path). This keeps sound generation deterministic, unit-testable, and
independent of the browser's audio implementation.

### The three-tier stack

The stack is `index.html` (markup) → `src/app/` (binding) → `src/lib/`
(pure audio library), with strict boundaries between the tiers:

```
index.html
(markup: layout, controls, canvases — loads only the binding entry)
        │
        ▼
src/app/
(binding: DOM wiring, envelope editor, canvas visuals, Web Audio
 playback — the only tier that touches the browser)
        │  imports the library only through the facade
        ▼
src/lib/
(pure audio library: oscillators → FM / ring-mod routing →
 linear mixing → envelopes (level, pitch, FM depth) → effects →
 Float32Array (rendered hit);
 facade: src/lib/index.js)
```

The signal flows down the stack: the UI hands patch parameters to the
library, which renders a `Float32Array` hit; the binding plays it back
through Web Audio (playback only — see the core constraint above) and
draws the waveform and spectrum on the `<canvas>` visualizers.

The envelope model: every source's level envelope is stored in the
canonical **DAHDSR** 6-point form — six points with fixed roles
(silent start, delay end, peak at 1.0, hold end, sustain, release
end), zero-length spans for inactive parameters, and an optional
per-segment `curve` field on a point (absent = linear). The UI's
DAHDSR knobs and the constrained full-screen canvas editor are two
views over those same points — no separate envelope state, and the
canvas can only ever produce a shape the knobs can name (the full
constraint in [GUIDELINES.md](GUIDELINES.md), §2; the model in drum
terms in [drum_generation.md](drum_generation.md), Level envelope:
DAHDSR).

The layering rules (full text in [GUIDELINES.md](GUIDELINES.md), §1.4):

- `src/lib/` is pure — no DOM, no Web Audio, no browser globals, and its
  imports stay within `src/lib/`.
- `src/app/` is the only tier that may touch the DOM, the canvas,
  `requestAnimationFrame`, or Web Audio, and it imports the library
  **only** through the facade `src/lib/index.js`.
- `index.html` loads only the binding entry (`src/app/main.js`).
- The facade's header documents the closed public API — adding an export
  is a library API change.
- No UI metadata (labels, slider ranges) in library modules — that lives
  in `src/app/`.
- All colors come from the theme tokens (`src/app/theme.js`, mirrored in
  `index.html`'s `:root`; `test/theme.test.mjs` drift-guards the mirror)
  — no raw color literals elsewhere in `src/`.

`test/library-purity.test.mjs` and `test/app-boundary.test.mjs` enforce
these boundaries mechanically.

### Using the library without the UI

`src/lib/` is pure ES6 with zero browser references, so it runs in Node
unchanged — render a hit and inspect the samples with no browser, no Web
Audio, and no UI:

```sh
node --input-type=module -e 'import { kickPatch, renderPatch } from "./src/lib/index.js"; const hit = renderPatch(kickPatch(), { sampleRate: 48000, duration: 0.5 }); console.log(hit.length)'
# → 24000
```

A headless host can also encode a rendered hit into a WAV file
(`encodeWav` via the facade) — the export feature is a library
capability, not a browser one:

```sh
node --input-type=module -e 'import { kickPatch, renderPatch, encodeWav } from "./src/lib/index.js"; const hit = renderPatch(kickPatch(), { sampleRate: 48000, duration: 0.5 }); console.log(encodeWav(hit, 48000).length)'
# → 96044
```

`test/facade.test.mjs` locks this headless-usage contract (render →
edit → re-render → analyze → encode to WAV, using only the facade).

### Repository layout

```
├── index.html            # markup only; loads the single binding entry
├── src/
│   ├── lib/              # pure audio library (no DOM, no Web Audio, no browser globals)
│   │   ├── index.js      # facade: closed public API; the only lib import for src/app/
│   │   ├── engine.js     # renders a drum hit into a Float32Array
│   │   ├── osc.js        # oscillator sample math (sine, square, ...)
│   │   ├── fm.js         # FM routing: ratios, indices, cascades, feedback, ring mod
│   │   ├── envelopes.js  # one-shot envelopes for level, pitch, FM depth
│   │   ├── noise.js      # white noise and filtered noise bursts
│   │   ├── effects.js    # saturation, simple compression, biquad-style filters
│   │   ├── layer.js      # linear mixing of multiple sources
│   │   ├── params.js     # nested get/set/clamp helpers for patch editing
│   │   ├── dsp.js        # shared DSP helpers (Goertzel single-bin magnitude)
│   │   ├── wav.js        # WAV encoder: Float32Array → RIFF/WAVE bytes (16/24/32-bit mono)
│   │   └── voices/       # one module per drum, each a parameterized patch
│   │       ├── kick.js
│   │       ├── snare.js
│   │       ├── hihat.js
│   │       ├── tom.js
│   │       ├── clap.js
│   │       └── cymbal.js
│   └── app/              # binding layer (the only tier that may touch DOM/canvas/Web Audio)
│       ├── main.js         # entry point (ES module): wires UI → library → playback
│       ├── theme.js        # theme tokens: the single color source (mirrored in index.html :root, drift-guarded)
│       ├── knob.js         # control components: knob, fader, button group (pure math + DOM)
│       ├── cards.js        # per-source knob cards (FM + noise): DAHDSR knobs, env preview (opens the modal), FX slots
│       ├── dahdsr.js       # canonical-form math: DAHDSR points ↔ scalars, legacy normalization, bend mapping
│       ├── env-editor.js   # constrained envelope canvas core: role anchors, bend dots, windowed maps
│       ├── env-modal.js    # full-screen envelope editor modal: plot + waveform strip, zoom, playhead
│       ├── band.js         # top band: mix waveform + read-only, note-labeled pitch-curve overview
│       ├── master-panel.js # master panel: length, output level, fader strip, master FX
│       ├── patch-ops.js    # pure structural patch ops: add/remove sources, modulators, fx
│       ├── controls.js     # UI metadata: parameter ranges + control descriptors
│       ├── presets.js      # preset registry, named save slots, drum JSON export/import
│       ├── export-wav.js   # WAV export (mix + single sources) + Blob download helpers
│       └── viz.js          # canvas rendering: waveform, spectrum, axes, playhead, colors
├── test/
│   └── *.test.mjs        # one test file per src/ module (node:test)
├── drum_generation.md    # sound-design notes: recipes and DSP theory
├── GUIDELINES.md         # how to develop in this repo
└── additional-docs/      # local reference material (git-ignored, not shipped)
```

(The exact file split may evolve; the constraints in GUIDELINES.md matter
more than any individual file name.)

## Getting started

There is no build step and no dependency to install.

1. Serve the repository root with any static file server — ES modules do not
   load from `file://`:

   ```sh
   python3 -m http.server 8080
   # ...or any other static file server
   ```

2. Open `http://localhost:8080/` in a modern browser.

### Running the tests

```sh
node --test
```

(No path argument: on recent Node versions a directory argument is treated
as a module entry point, while the no-argument form recursively discovers
every `test/*.test.mjs`.)

Tests use Node's built-in `node:test` runner — no packages to install. The
suite must stay fast; see the testing policy in
[GUIDELINES.md](GUIDELINES.md).

## Roadmap

- [x] Core engine: oscillators, FM routing, envelopes (level / pitch / FM depth)
- [x] Kick, snare, and hi-hat voices
- [x] UI: the per-source knob-card builder — all sources on one screen
      (knob cards with per-source envelope editors and FX slots), a top
      waveform + pitch-curve band, a master panel with a per-source
      fader strip (enable/solo), plus trigger and tempo-loop playback
      with a playhead on the band
- [x] Pretty canvas visuals: time-domain waveform and spectrum of the
      rendered hit, live-updating as parameters change
- [x] JS effects: saturation, high-pass filter, simple compression
- [x] More voices (tom, clap, cymbal) and patch presets (seven presets:
      kick, snare, hi-hat, blank, tom, clap, cymbal)
- [x] WAV export of rendered hits (mix and single sources: 16/24/32-bit
      at 22.05/44.1/48 kHz, defaulting to 48 kHz / 32-bit float)
- [x] Oscillator wave-shape control (sine / square / saw / triangle) with
      per-operator previews
- [x] Joyful indigo-dusk theme: warm coral accent (per-drum color
      coding kept), dense 3-column knob grids with short captions,
      thicker knob outlines
- [x] DAHDSR level envelope (delay/attack/hold/decay/sustain/release +
      per-segment curve bends) with knobs and a constrained full-screen
      visual editor (top bar + loop playback stay live while editing);
      the band becomes a read-only, note-labeled pitch-curve overview
- [ ] Later: MIDI/keyboard triggering

## References

- [drum_generation.md](drum_generation.md) — project design notes: why FM
  works for drums, per-drum recipes, oscillator interaction patterns,
  effects.
- Chowning, J. M. (1973). *The Synthesis of Complex Audio Spectra by Means
  of Frequency Modulation.* Journal of the Audio Engineering Society, 21(7).
  Local copy: `additional-docs/fm_synthesis_paper.pdf`.
- [GUIDELINES.md](GUIDELINES.md) — development rules, testing policy,
  definition of done.
