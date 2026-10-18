// Control components (binding layer, src/app/): the pure knob math —
// the value <-> angle mapping, the pointer-delta -> value drag math,
// the keyboard step math, and the readout formatting of the rotary
// knob, the primary parameter control of the new card UI (new-ui.md
// §2.3: "knobs, not slider lists").
//
// The pure math below is the module's core (plan newui P1/S1): every
// one of its functions is pure (in: numbers/objects, out: numbers/
// strings), so it runs and is unit-tested under node --test with no
// browser (GUIDELINES §1.3/§4). The DOM builders at the bottom of this
// file — buildKnob (P1/S2), buildButtonGroup + buildFader (P1/S3, the
// two remaining control primitives: the compact enum button group and
// the linear fader), and buildShapeGroup (sinecontrol P2/S5: the wave-
// shape glyph buttons + live one-period preview, whose painting is
// imported from viz.js — the cards.js→viz.js cross-app precedent) —
// are the module's ONLY I/O boundary (GUIDELINES §3); the pure math
// never touches the DOM.
//
// The scale is LINEAR for every parameter (log scale deliberately out
// of scope): PARAM_RANGES (src/app/controls.js) is the single range
// source, and its wide linear ranges are the documented convention —
// the knob only maps a value to an angle and back; it adds no
// parameter scaling of its own.

// The shape preview's painter + palette (src/app/viz.js): drawShapeWave
// is the facade's waveShapePoints mapped to pixels, and COLORS.trace is
// the app accent (the :root --accent twin in index.html) the preview
// falls back to when the card passes no color of its own.
import { COLORS, drawShapeWave } from './viz.js';

// The rotor's angular sweep: a 270-degree arc. The indicator angle for
// `min` is KNOB_ANGLE_START (135 degrees); for `max` it is
// KNOB_ANGLE_START + KNOB_ANGLE_SWEEP (405 degrees, i.e. 45 degrees
// past one full turn), and the arc between 45 and 135 degrees stays
// empty — the dead gap. The P1/S2 DOM layer decides how the dial frame
// is oriented on screen (it may apply a fixed CSS offset); this math
// only ever produces angles in [135, 405].
export const KNOB_ANGLE_START = 135;
export const KNOB_ANGLE_SWEEP = 270;

// Vertical pointer travel (px) that spans the WHOLE min..max range in
// one drag (P1/S2 passes the accumulated clientY delta): a
// KNOB_TRAVEL_PX drag is the full sweep, regardless of the parameter's
// range — a wide 20..22000 Hz frequency knob and a tight 0..1 gain
// knob take the same finger travel.
export const KNOB_TRAVEL_PX = 150;

// Clamp a number into [min, max]. NaN passes through (Math.max/min
// propagate it): the callers receive values from the PARAM_RANGES table
// and the live patch — finite by construction — and formatKnobValue is
// the one place that renders a defensive readout for a broken value.
const clampTo = (v, min, max) => Math.min(max, Math.max(min, v));

// Value -> indicator angle in degrees (see the KNOB_ANGLE_* comments
// above). The value is clamped into [min, max] first, so a value set
// past the knob's range by another control pins the indicator to the
// sweep ends instead of overshooting them. A zero-width range
// (min === max) has no sweep: the indicator sits at the start angle —
// the guard runs before any division, so the fraction can never divide
// by zero.
export const knobValueToAngle = (value, min, max) => {
  if (max === min) return KNOB_ANGLE_START;
  const f = (clampTo(value, min, max) - min) / (max - min);
  return KNOB_ANGLE_START + f * KNOB_ANGLE_SWEEP;
};

// Indicator angle -> value: the exact inverse of knobValueToAngle,
// with angles outside the sweep clamped to the range ends — including
// the dead gap (anything below the start angle reads as min) and
// angles past the end (max).
export const knobAngleToValue = (angle, min, max) => {
  if (max === min) return min;
  const f = clampTo((angle - KNOB_ANGLE_START) / KNOB_ANGLE_SWEEP, 0, 1);
  return min + f * (max - min);
};

// Snap a raw value to the nearest multiple of `step`, then clamp into
// [min, max]. Snapping before clamping is the contract: the
// PARAM_RANGES min/max are grid-aligned (20 Hz on a step-1 grid,
// 0.0005 s on a step-0.0005 grid, ...), so a clamped value stays on
// the grid. A non-positive step skips the grid — the PARAM_RANGES table
// always supplies step > 0, and this keeps the math total rather than
// dividing by zero on a malformed descriptor.
const snapToGrid = (raw, step, min, max) => {
  const snapped = step > 0 ? Math.round(raw / step) * step : raw;
  return clampTo(snapped, min, max);
};

// Vertical pointer delta (px) -> new value for a drag in progress.
//
// LOCKED DIRECTION CONTRACT (plan ui3 P2) — this comment is the
// code-doc home of the rule, locked by the "direction contract" tests
// in test/knob.test.mjs and consumed by the pointer handlers: UP =
// MORE on every input channel (drag up, wheel up, ArrowUp/ArrowRight),
// and an increasing value rotates the indicator CLOCKWISE (the
// knobValueToAngle 135..405 mapping — min at 7:30, mid at 12:00, max
// at 4:30 — is unchanged by the flip below). deltaPx is the
// accumulated pointer travel in clientY, so POSITIVE = the pointer
// moved DOWN the screen = the value DECREASES — a full
// KNOB_TRAVEL_PX upward drag (deltaPx = -KNOB_TRAVEL_PX) spans min ->
// max exactly (knobDeltaToValue(-150, min, min, max, step) === max).
// Up = increase is the fader-consistent convention: the app's faders
// put min at the bottom, so up must raise the value here too.
//
// The raw result is snapped to the step grid, then clamped (see
// snapToGrid). A zero-width range returns the value unchanged — the
// guard runs before any arithmetic, so min === max can never produce
// NaN.
export const knobDeltaToValue = (deltaPx, value, min, max, step) => {
  if (max === min) return value;
  // MINUS: a positive clientY delta is downward travel, and up = more.
  const raw = value - (deltaPx / KNOB_TRAVEL_PX) * (max - min);
  return snapToGrid(raw, step, min, max);
};

// Keyboard step: value +/- direction·step, grid-snapped, clamped into
// [min, max]. direction is +1 (ArrowUp/ArrowRight), -1
// (ArrowDown/ArrowLeft), or +/-10 (PageUp/PageDown — the ×10 big step,
// plan P1/S2). The offset result is RE-SNAPPED rather than trusted: a
// knob whose value was set off-grid by a patch edit (a preset load,
// the envelope editor) returns to the grid on the first key press.
// (min/max are part of the signature because the clamps need bounds —
// the plan's abbreviated signature implied them via "clamped".)
export const knobStepValue = (value, step, direction, min, max) =>
  snapToGrid(value + direction * step, step, min, max);

// Readout string for a knob value: the formatValue convention from the
// old main.js — parseFloat(v.toPrecision(6)) drops float noise
// (0.30000000000000004 -> "0.3") while keeping the 6 significant
// digits a 20476 Hz hi-hat partial needs. The descriptor (a
// controls.js {path, label, min, max, step} object, or null for knobs
// without one — e.g. the master panel's output level, P6/S16) drives
// the unit: a label that mentions Hz gets " Hz" appended. Label-driven
// on purpose — no parameter-type knowledge and no audio math here.
// Non-finite values render as "-" so the readout never shows
// "NaN"/"Infinity".
export const formatKnobValue = (value, descriptor = null) => {
  if (!Number.isFinite(value)) return '-';
  const text = String(parseFloat(value.toPrecision(6)));
  const unit = descriptor?.label?.includes('Hz') ? ' Hz' : '';
  return text + unit;
};

// ---------------------------------------------------------------------
// DOM builders — the module's only I/O boundary (GUIDELINES §3).
// Everything above this line is pure; only the code below touches the
// DOM (document.createElement, attributes, styles, event listeners).
// ---------------------------------------------------------------------

// Clamp + snap a raw value into [min, max] on the step grid — the same
// snapToGrid the drag/step math uses, made public because buildKnob's
// setValue contract is exactly "clamped + snapped" (plan P1/S2), and
// the build-time normalization of the initial value is the same rule.
export const knobSnapValue = (value, step, min, max) =>
  snapToGrid(value, step, min, max);

// Vertical pointer-drag wiring — the old main.js envelope-editor
// pattern (pointerdown → setPointerCapture, track on pointermove, clear
// on pointerup/pointercancel) reduced to the clientY axis the knob math
// uses (no bounding-rect mapping: the knob's scale is in screen
// pixels, see KNOB_TRAVEL_PX). onPress() is asked for the value the
// drag anchors to (the knob's value at pointerdown); onDrag(deltaPx,
// startValue) gets the ACCUMULATED clientY delta (positive = the
// pointer moved down), so the value is always re-derived from the drag
// start — re-deriving from the mid-drag value would compound the delta.
// The gesture state lives in this closure: per knob, never module-wide.
const wireKnobDrag = (rotor, onPress, onDrag) => {
  let press = null; // { startY, value } of the in-progress gesture
  const release = () => {
    press = null;
  };
  rotor.addEventListener('pointerdown', (e) => {
    press = { startY: e.clientY, value: onPress() };
    // keep the gesture even if the pointer leaves the rotor mid-drag
    rotor.setPointerCapture(e.pointerId);
  });
  rotor.addEventListener('pointermove', (e) => {
    if (!press) return;
    onDrag(e.clientY - press.startY, press.value);
  });
  rotor.addEventListener('pointerup', release);
  rotor.addEventListener('pointercancel', release);
};

// Keyboard step sizes per key: arrows are one step, pages the ×10 big
// step (new-ui.md §2.3: "drag to turn, wheel, keyboard arrows").
const KNOB_KEY_STEPS = {
  ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1,
  PageUp: 10, PageDown: -10,
};

// buildKnob — the rotary parameter control of the card UI
// (new-ui.md §2.3: "Knobs, not slider lists"; §2.8: "Live everywhere").
//
// Builds a <div class="knob">:
//   .knob-rotor     role="slider", tabindex="0", aria-label,
//                   aria-valuemin/max/now/valuetext — the focusable,
//                   operable control;
//   .knob-indicator a child of the rotor, CSS-drawn (no canvas): its
//                   rotation is knobValueToAngle(value) — the CSS layer
//                   may add a fixed dial offset (see the KNOB_ANGLE_*
//                   note above), this code only ever sets the raw
//                   135..405 degree angle;
//   .knob-label     the VISIBLE caption, beneath the rotor — the
//                   short displayLabel when the caller passes one
//                   (the label with the `Source N:` prefix stripped,
//                   plan ui3 P5/S1 — the card head already shows the
//                   source), else the full label; the rotor's
//                   aria-label above always keeps the FULL label, so
//                   the accessible name is unchanged;
//   .knob-value     an <output> readout, updated live with every change.
//
// LOCKED DIRECTION CONTRACT (plan ui3 P2): UP = MORE on every
// channel — an upward drag, a wheel up, and ArrowUp/ArrowRight each
// RAISE the value; their mirrors (downward drag, wheel down,
// ArrowDown/ArrowLeft) lower it. An increasing value rotates the
// indicator CLOCKWISE — 7:30 (min) -> 12:00 (mid) -> 4:30 (max), the
// 135..405 degree mapping above — so the knob always turns the
// correct way. The channels, all wired on the rotor:
//   - vertical pointer drag: KNOB_TRAVEL_PX of UPWARD travel spans
//     min..max (up = increase — the fader-consistent convention, see
//     knobDeltaToValue);
//   - wheel: one step per notch (up = increase), preventDefault'd so
//     the page does not scroll while a knob is turned;
//   - keyboard: ArrowUp/ArrowRight +1 step, ArrowDown/ArrowLeft −1,
//     PageUp/PageDown ±10 steps, Home/End jump to min/max.
//
// Every change goes through commit(): the readout, the indicator,
// aria-valuenow and aria-valuetext update immediately, then
// onInput(newValue) fires — live, with no apply/commit step (new-ui.md
// §2.8). An unchanged value is a no-op: the readout-sync pass (plan
// P1/S8) calls setValue with the value the knob often already holds
// (master fader vs. card level knob, P7/S17), and that must not
// re-trigger onInput in a setPath → updateDrum → sync → setValue loop.
//
// Element API: `.value` is the current number; `.setValue(v)` clamps +
// snaps v (knobSnapValue) and applies it — the programmatic setter for
// when another control edits the same patch path.
//
// `format` is the controls.js descriptor the knob was built from (or
// null for knobs without one — e.g. the master panel's output level,
// P6/S16); its label drives the " Hz" unit of the readout (label-driven
// by design — see formatKnobValue).
//
// No module-level mutable state: all state (the current value, the drag
// gesture) lives in this closure, so every call returns an independent
// element.
export const buildKnob = ({ label, displayLabel = null, min, max, step, value, format = null, onInput = () => {} }) => {
  let current = knobSnapValue(value, step, min, max);

  const root = document.createElement('div');
  root.className = 'knob';

  const rotor = document.createElement('div');
  rotor.className = 'knob-rotor';
  rotor.setAttribute('role', 'slider');
  rotor.setAttribute('tabindex', '0'); // the rotor is the focusable control
  rotor.setAttribute('aria-label', label);
  rotor.setAttribute('aria-valuemin', String(min));
  rotor.setAttribute('aria-valuemax', String(max));
  root.appendChild(rotor);

  // The indicator: a plain child element the CSS turns into a dial
  // mark (its rotation is set in paint — no canvas, no SVG).
  const indicator = document.createElement('div');
  indicator.className = 'knob-indicator';
  rotor.appendChild(indicator);

  const labelEl = document.createElement('span');
  labelEl.className = 'knob-label';
  // The visible caption drops the `Source N:` prefix (displayLabel);
  // the rotor's aria-label keeps the FULL label (plan ui3 P5/S1 —
  // the accessible name is unchanged). Absent displayLabel falls
  // back to the full label (the master panel's prefix-less knobs).
  labelEl.textContent = displayLabel ?? label;
  root.appendChild(labelEl);

  const readout = document.createElement('output');
  readout.className = 'knob-value';
  root.appendChild(readout);

  // Paint the indicator, the readout, and the aria state from current.
  // aria-valuenow gets the float-noise-cleared number (the same
  // toPrecision(6) convention as the readout); aria-valuetext gets the
  // full formatted text, unit included.
  const paint = () => {
    const text = formatKnobValue(current, format);
    const deg = knobValueToAngle(current, min, max);
    indicator.style.transform = `rotate(${deg}deg)`;
    // The value arc (index.html .knob-rotor::before) reads the SAME raw
    // angle as a custom property: its conic sweep is this angle's
    // 135..405 domain (the KNOB_ANGLE_* math — see the arc's comment
    // in the stylesheet). One extra write in this same DOM update —
    // no new state, no new I/O boundary.
    rotor.style.setProperty('--deg', `${deg}deg`);
    readout.textContent = text;
    rotor.setAttribute('aria-valuenow', String(parseFloat(current.toPrecision(6))));
    rotor.setAttribute('aria-valuetext', text);
  };

  // The single change funnel: state + DOM first, then the live
  // onInput callback (see the no-op note in the buildKnob header).
  const commit = (next) => {
    if (next === current) return;
    current = next;
    root.value = current;
    paint();
    onInput(current);
  };

  root.value = current;
  root.setValue = (v) => commit(knobSnapValue(v, step, min, max));
  paint();

  wireKnobDrag(
    rotor,
    () => current,
    (deltaPx, startValue) =>
      commit(knobDeltaToValue(deltaPx, startValue, min, max, step)),
  );

  rotor.addEventListener('wheel', (e) => {
    e.preventDefault();
    commit(knobStepValue(current, step, e.deltaY < 0 ? 1 : -1, min, max));
  });

  rotor.addEventListener('keydown', (e) => {
    const dir = KNOB_KEY_STEPS[e.key];
    if (dir !== undefined) {
      e.preventDefault();
      commit(knobStepValue(current, step, dir, min, max));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      commit(e.key === 'Home' ? min : max);
    }
  });

  return root;
};

// ---------------------------------------------------------------------
// buildButtonGroup — the enum control (new-ui.md §2.3: "Enum
// parameters get compact button groups, the way Geonkick does"): the
// filter type LP/BP/HP on the FX slots (P6/S15), ring on/off per
// modulator (P3/S7), and the band's waveform/spectrum toggle (P2/S6).
//
// Builds a <div class="button-group">: a label line plus one compact
// <button type="button"> per options entry {value, label}. The active
// option carries the .active class and aria-pressed="true"; every
// other button is aria-pressed="false". A click commits that option's
// value — the knob's live contract (onInput, no apply/commit step).
//
// A value no option matches (at build time or via setValue) leaves the
// group with NO active button, and the builder never throws for it —
// a patch field may hold an enum the group does not list. In that
// state .value is null, and onInput never fires for a value the group
// cannot represent.
//
// Element API (the knob's uniform contract, P1/S3): `.value` is the
// active option's value (null when none is active); `.setValue(v)`
// activates the matching option or clears the group for an unknown
// value, and is a no-op when the active state does not move (the
// readout-sync pass must not loop — same rule as buildKnob's commit).
//
// No module-level mutable state: the active option lives in this
// closure, so every call returns an independent group.
export const buildButtonGroup = ({ label, displayLabel = null, options, value, onInput = () => {} }) => {
  const root = document.createElement('div');
  root.className = 'button-group';
  root.setAttribute('role', 'group'); // one choice group: at most one option active
  root.setAttribute('aria-label', label);

  const labelEl = document.createElement('span');
  labelEl.className = 'button-group-label';
  // The visible caption drops the `Source N:` prefix (displayLabel);
  // the group's aria-label keeps the FULL label (plan ui3 P5/S1 —
  // the accessible name is unchanged). Absent displayLabel falls
  // back to the full label (the master panel's prefix-less groups).
  labelEl.textContent = displayLabel ?? label;
  root.appendChild(labelEl);

  // -1 = no option matches (the "unknown value" state, see above).
  let activeIndex = options.findIndex((option) => option.value === value);

  const buttons = options.map((option, i) => {
    const button = document.createElement('button');
    button.type = 'button'; // pure toggles — never form submissions
    button.className = i === activeIndex ? 'btn active' : 'btn';
    button.setAttribute('aria-pressed', String(i === activeIndex));
    button.textContent = option.label;
    button.addEventListener('click', () => commit(option.value));
    root.appendChild(button);
    return button;
  });

  // Repaint the whole row: exactly the active button carries .active
  // and aria-pressed="true". (Full className re-assignment — the group
  // owns its buttons' class lists, nothing else is lost.)
  const paint = () => {
    buttons.forEach((button, i) => {
      const isActive = i === activeIndex;
      button.className = isActive ? 'btn active' : 'btn';
      button.setAttribute('aria-pressed', String(isActive));
    });
  };

  // The single change funnel: state + DOM first, then the live
  // onInput callback; a no-op when the active state does not move.
  const commit = (next) => {
    const nextIndex = options.findIndex((option) => option.value === next);
    if (nextIndex === activeIndex) return;
    activeIndex = nextIndex;
    root.value = nextIndex === -1 ? null : options[nextIndex].value;
    paint();
    if (nextIndex !== -1) onInput(options[nextIndex].value);
  };

  root.value = activeIndex === -1 ? null : options[activeIndex].value;
  root.setValue = (v) => commit(v);
  return root;
};

// Value -> percent of the range (0..100), clamped first (the same
// clamp the readout shows), for the fader track's --fill custom
// property: the filled portion of the CSS track (the BPM slider
// pattern, plan "colors" S8 — buildFader already paints the value,
// so the fill reuses it, no new state). A zero-width range has no
// sweep: 0.
export const faderFillPercent = (value, min, max) => {
  if (max === min) return 0;
  return ((clampTo(value, min, max) - min) / (max - min)) * 100;
};

// ---------------------------------------------------------------------
// buildFader — the linear control (new-ui.md §2.3: "Linear controls
// are kept only where linearity is the point"): the per-source level
// faders of the master strip (P7/S17) and the length control (P6/S16).
//
// Builds a <div class="fader">: a vertical <input type="range"> (the
// vertical orientation is the CSS layer's job — writing-mode /
// rotation, the P2/S4 stylesheet — this builder only builds the
// control), a label line, and an <output> readout. The input carries
// the slider's explicit role/aria (role="slider",
// aria-valuemin/max/now/valuetext) — the same aria discipline as
// buildKnob's rotor, so a fader and a knob read identically to
// assistive tech.
//
// Interaction: the native `input` event — drag, click, or the
// browser's own arrow-key stepping on the focused range, all provided
// by the native control — fires onInput with the parsed, snapped
// value. Live, no commit step (new-ui.md §2.8).
//
// Element API (the knob's uniform contract, P1/S3): `.value` is the
// current number; `.setValue(v)` clamps + snaps v (knobSnapValue) and
// applies it — the programmatic setter for the two-writers sync pass
// (P1/S8: the card level knob and the master fader edit the same
// patch path, and setValue with an already-held value is a no-op so
// that sync cannot loop).
//
// `format` is the controls.js descriptor (or null) whose label drives
// the " Hz" unit of the readout, exactly like buildKnob.
//
// No module-level mutable state: the current value lives in this
// closure, so every call returns an independent fader.
export const buildFader = ({ label, min, max, step, value, format = null, onInput = () => {} }) => {
  let current = knobSnapValue(value, step, min, max);

  const root = document.createElement('div');
  root.className = 'fader';

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'fader-input';
  input.setAttribute('role', 'slider');
  input.setAttribute('aria-label', label);
  input.setAttribute('aria-valuemin', String(min));
  input.setAttribute('aria-valuemax', String(max));
  input.setAttribute('min', String(min));
  input.setAttribute('max', String(max));
  input.setAttribute('step', String(step));
  root.appendChild(input);

  const labelEl = document.createElement('span');
  labelEl.className = 'fader-label';
  labelEl.textContent = label;
  root.appendChild(labelEl);

  const readout = document.createElement('output');
  readout.className = 'fader-value';
  root.appendChild(readout);

  // Readout/aria strings go through the same float-noise cleanup as
  // buildKnob (toPrecision(6)); input.value gets the cleaned number as
  // a string — the native control re-snaps a dirty value to its grid
  // anyway, and the stub tests read the string back.
  const paint = () => {
    const text = formatKnobValue(current, format);
    const clean = String(parseFloat(current.toPrecision(6)));
    readout.textContent = text;
    input.value = clean;
    input.setAttribute('aria-valuenow', clean);
    input.setAttribute('aria-valuetext', text);
    // The track's filled portion (index.html .fader-input's --fill
    // gradient split, the BPM slider pattern): the same value the
    // readout shows — one line in this same paint path.
    input.style.setProperty('--fill', `${faderFillPercent(current, min, max).toFixed(2)}%`);
  };

  // The single change funnel: state + DOM first, then the live
  // onInput callback; a no-op when the snapped value does not move.
  const commit = (next) => {
    if (next === current) return;
    current = next;
    root.value = current;
    paint();
    onInput(current);
  };

  // The native control already steps by `step` (drag, click, and its
  // own keyboard arrows); the re-snap keeps the value the patch
  // receives grid-aligned regardless of the browser's rounding.
  input.addEventListener('input', (e) =>
    commit(knobSnapValue(parseFloat(e.target.value), step, min, max)),
  );

  root.value = current;
  root.setValue = (v) => commit(knobSnapValue(v, step, min, max));
  paint();
  return root;
};

// ---------------------------------------------------------------------
// buildShapeGroup — the wave-shape control (plan sinecontrol P2/S5):
// the Geonkick-style glyph buttons (∿ □ ◺ △) plus a live 72×24
// one-period preview canvas — one per carrier and per modulator on the
// FM cards (P3/S7), the plan's "live shape feedback".
//
// Builds a <div class="shape-group">
//   role="group", aria-label = label (the group keeps the button
//   group's a11y contract):
//   - the same button row as buildButtonGroup — one
//     <button type="button"> per option {value, label}; the active
//     option carries the .active class and aria-pressed="true" —
//     EXCEPT each button additionally carries aria-label = its
//     option's value (the shape name, e.g. "sine"): the glyph text
//     alone is useless to assistive tech, so the name travels on the
//     button itself;
//   - <canvas class="shape-preview" width="72" height="24"> — the
//     visual feedback: one period of the active shape, stroked in
//     `color` (drawShapeWave).
//
// `color` defaults to null: the cards pass nothing and the preview
// falls back to COLORS.trace — the app accent (the :root --accent
// twin in index.html) — so no color plumbing into buildCard (P3/S7).
//
// Element API (the knob's uniform contract, P1/S2-S3): `.value` is the
// active option's value (null when none is active); `.setValue(v)`
// activates the matching option or clears the group for an unknown
// value, and is a no-op when the active state does not move (the
// readout-sync pass must not loop — the same rule as
// buildButtonGroup's commit). The single commit(next) funnel repaints
// the buttons AND the preview, then fires onInput(value) — the
// preview repaint (drawShapeWave, or a bare clearRect for an unknown
// value) is the component's one I/O boundary (GUIDELINES §3).
//
// Initial state: the buttons are painted from `value` and the preview
// is painted for the active shape at build (an unknown build value →
// no active button and the preview cleared — mirrors
// buildButtonGroup's unknown-value rule, the canvas half of the
// feedback simply shows nothing).
//
// No module-level mutable state: the active option lives in this
// closure, so every call returns an independent group.
export const buildShapeGroup = ({ label, options, value, color = null, onInput = () => {} }) => {
  const root = document.createElement('div');
  root.className = 'shape-group';
  root.setAttribute('role', 'group'); // one choice group: at most one option active
  root.setAttribute('aria-label', label);

  // -1 = no option matches (the "unknown value" state, see above).
  let activeIndex = options.findIndex((option) => option.value === value);

  const buttons = options.map((option, i) => {
    const button = document.createElement('button');
    button.type = 'button'; // pure toggles — never form submissions
    button.className = i === activeIndex ? 'btn active' : 'btn';
    button.setAttribute('aria-pressed', String(i === activeIndex));
    // The glyph alone is meaningless to assistive tech: name the shape.
    button.setAttribute('aria-label', String(option.value));
    button.textContent = option.label;
    button.addEventListener('click', () => commit(option.value));
    root.appendChild(button);
    return button;
  });

  const preview = document.createElement('canvas');
  preview.className = 'shape-preview';
  preview.width = 72;
  preview.height = 24;
  root.appendChild(preview);

  // The preview's stroke color: the passed color, or the app accent
  // when the card passes nothing (see the `color` note above).
  const strokeColor = color ?? COLORS.trace;

  // Repaint the row AND the preview from activeIndex. An unknown value
  // (activeIndex -1) clears the canvas without a trace — the no-active-
  //button rule plus the preview half of the feedback.
  const paint = () => {
    buttons.forEach((button, i) => {
      const isActive = i === activeIndex;
      button.className = isActive ? 'btn active' : 'btn';
      button.setAttribute('aria-pressed', String(isActive));
    });
    if (activeIndex === -1) {
      preview.getContext('2d').clearRect(0, 0, preview.width, preview.height);
      return;
    }
    drawShapeWave(preview, options[activeIndex].value, strokeColor);
  };

  // The single change funnel: state + DOM (buttons and preview) first,
  // then the live onInput callback; a no-op when the active state does
  // not move (the readout-sync pass must not loop).
  const commit = (next) => {
    const nextIndex = options.findIndex((option) => option.value === next);
    if (nextIndex === activeIndex) return;
    activeIndex = nextIndex;
    root.value = nextIndex === -1 ? null : options[nextIndex].value;
    paint();
    if (nextIndex !== -1) onInput(options[nextIndex].value);
  };

  root.value = activeIndex === -1 ? null : options[activeIndex].value;
  root.setValue = (v) => commit(v);
  paint();
  return root;
};
