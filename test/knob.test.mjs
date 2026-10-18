// Tests for src/app/knob.js — the pure knob math (plan newui P1/S1):
// knobValueToAngle / knobAngleToValue (value <-> angle over the 270
// degree rotor sweep), knobDeltaToValue (pointer delta -> value over
// KNOB_TRAVEL_PX), knobStepValue (keyboard stepping), and
// formatKnobValue (readout strings). These run under plain node --test
// with no browser (GUIDELINES §1.3/§4); the DOM builders — buildKnob
// (P1/S2), buildButtonGroup and buildFader (P1/S3), and
// buildShapeGroup (sinecontrol P2/S5: the glyph buttons + the 72×24
// live preview canvas, checked through a recording 2D context) — are
// tested in this file against the same math, with a headless document
// stub.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KNOB_ANGLE_START,
  KNOB_ANGLE_SWEEP,
  KNOB_TRAVEL_PX,
  buildButtonGroup,
  buildFader,
  buildKnob,
  buildShapeGroup,
  faderFillPercent,
  formatKnobValue,
  knobAngleToValue,
  knobDeltaToValue,
  knobSnapValue,
  knobStepValue,
  knobValueToAngle,
} from '../src/app/knob.js';
import { COLORS, withAlpha } from '../src/app/viz.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Approximate equality for float round-trips, with a tolerance scaled
// to the magnitude (the property-assertion style the viz tests use).
const close = (a, b) =>
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

test('knob constants pin the plan contract: 135 degree start, 270 degree sweep, 150 px travel', () => {
  assert.equal(KNOB_ANGLE_START, 135);
  assert.equal(KNOB_ANGLE_SWEEP, 270);
  assert.equal(KNOB_TRAVEL_PX, 150);
});

// ---- value -> angle ------------------------------------------------

test('knobValueToAngle: min -> start, max -> start + sweep, mid -> half sweep', () => {
  assert.equal(knobValueToAngle(0, 0, 1), KNOB_ANGLE_START); // 135
  assert.equal(knobValueToAngle(1, 0, 1), KNOB_ANGLE_START + KNOB_ANGLE_SWEEP); // 405
  assert.equal(knobValueToAngle(0.5, 0, 1), KNOB_ANGLE_START + KNOB_ANGLE_SWEEP / 2); // 270
  // A real PARAM_RANGES span (carrier freq 20..22000): the ends map to
  // exactly the sweep ends.
  assert.equal(knobValueToAngle(20, 20, 22000), 135);
  assert.equal(knobValueToAngle(22000, 20, 22000), 405);
});

test('knobValueToAngle: interior values are linear in the range fraction', () => {
  assert.equal(knobValueToAngle(0.25, 0, 1), 135 + 67.5); // 202.5
  assert.equal(knobValueToAngle(0.75, 0, 1), 135 + 202.5); // 337.5
  // Thirds of the carrier range — no special-casing of quarters.
  assert.ok(close(knobValueToAngle(20 + (22000 - 20) / 3, 20, 22000), 135 + 90));
  assert.ok(close(knobValueToAngle(20 + ((22000 - 20) * 2) / 3, 20, 22000), 135 + 180));
});

test('knobValueToAngle: strictly increasing across the sweep', () => {
  let prev = -Infinity;
  for (let i = 0; i <= 10; i += 1) {
    const a = knobValueToAngle(i / 10, 0, 1);
    assert.ok(a > prev, `angle not increasing at fraction ${i / 10}`);
    prev = a;
  }
});

test('knobValueToAngle: out-of-range values pin to the sweep ends', () => {
  assert.equal(knobValueToAngle(-5, 0, 1), 135);
  assert.equal(knobValueToAngle(2, 0, 1), 405);
});

test('knobValueToAngle: zero-width range sits at the start (no division by zero)', () => {
  const a = knobValueToAngle(7, 7, 7);
  assert.equal(a, 135);
  assert.ok(Number.isFinite(a));
});

// ---- angle -> value ------------------------------------------------

test('knobAngleToValue: endpoints and mid', () => {
  assert.equal(knobAngleToValue(135, 0, 1), 0);
  assert.equal(knobAngleToValue(405, 0, 1), 1);
  assert.equal(knobAngleToValue(270, 0, 1), 0.5);
  assert.equal(knobAngleToValue(202.5, 0, 1), 0.25);
});

test('round-trip: value -> angle -> value is the identity', () => {
  for (const [min, max, values] of [
    [0, 1, [0, 1, 0.5, 0.1, 0.37, 0.62, 0.999]],
    [20, 22000, [20, 22000, 11010, 100, 7326]],
  ]) {
    for (const v of values) {
      const back = knobAngleToValue(knobValueToAngle(v, min, max), min, max);
      assert.ok(close(back, v), `round-trip failed for ${v} in [${min}, ${max}] (got ${back})`);
    }
  }
});

test('round-trip with clamping: values past the range come back at the ends', () => {
  // 30000 Hz is above the table's 22000 max; 5 Hz below its 20 floor.
  assert.equal(knobAngleToValue(knobValueToAngle(30000, 20, 22000), 20, 22000), 22000);
  assert.equal(knobAngleToValue(knobValueToAngle(5, 20, 22000), 20, 22000), 20);
});

test('knobAngleToValue: angles outside the sweep clamp to the range ends', () => {
  // The dead gap (45..135) and anything below it read as min; past the
  // sweep end reads as max.
  assert.equal(knobAngleToValue(0, 0, 1), 0);
  assert.equal(knobAngleToValue(45, 0, 1), 0);
  assert.equal(knobAngleToValue(90, 0, 1), 0);
  assert.equal(knobAngleToValue(134, 0, 1), 0);
  assert.equal(knobAngleToValue(-90, 0, 1), 0);
  assert.equal(knobAngleToValue(406, 0, 1), 1);
  assert.equal(knobAngleToValue(450, 0, 1), 1);
  assert.equal(knobAngleToValue(1000, 0, 1), 1);
});

test('knobAngleToValue: zero-width range returns min for any angle', () => {
  assert.equal(knobAngleToValue(270, 7, 7), 7);
  assert.equal(knobAngleToValue(0, 7, 7), 7);
});

// ---- pointer delta -> value -----------------------------------------

test('knobDeltaToValue: a full 150 px UPWARD drag spans min -> max exactly', () => {
  // LOCKED CONTRACT (plan ui3 P2): UP = MORE — a negative clientY
  // delta (the pointer moving up) raises the value.
  assert.equal(knobDeltaToValue(-150, 0, 0, 1, 0.01), 1);
  assert.equal(knobDeltaToValue(150, 1, 0, 1, 0.01), 0);
  // 75 px (half travel) of upward travel from the middle of
  // 0..1 reaches the top.
  assert.equal(knobDeltaToValue(-75, 0.5, 0, 1, 0.01), 1);
  assert.equal(knobDeltaToValue(75, 0.5, 0, 1, 0.01), 0);
});

test('knobDeltaToValue: small deltas snap to the step grid, then clamp at both ends', () => {
  // 15 px of 150 = 0.1 of the 0..1 range: an upward drag lands
  // exactly on a 0.1 line.
  assert.ok(close(knobDeltaToValue(-15, 0, 0, 1, 0.1), 0.1));
  // 10 px up = 0.0667 -> raw 0.5667 from 0.5 -> snaps to 0.6.
  assert.ok(close(knobDeltaToValue(-10, 0.5, 0, 1, 0.1), 0.6));
  // Overshoot clamps at both ends (the snap may run past the end first).
  assert.equal(knobDeltaToValue(-150, 0.95, 0, 1, 0.1), 1); // up past max
  assert.equal(knobDeltaToValue(150, 0.05, 0, 1, 0.1), 0); // down past min
  // A zero delta keeps an on-grid value.
  assert.equal(knobDeltaToValue(0, 0.5, 0, 1, 0.1), 0.5);
});

test('knobDeltaToValue: integer steps (the seed knob) keep integer results', () => {
  // A 37 px UPWARD drag: raw = 100 + (37/150)·998 = 346.17... ->
  // snaps to 346, still in [1, 999].
  const v = knobDeltaToValue(-37, 100, 1, 999, 1);
  assert.ok(Number.isInteger(v));
  assert.equal(v, 346);
});

test('knobDeltaToValue: zero-width range leaves the value unchanged (no NaN)', () => {
  assert.equal(knobDeltaToValue(150, 5, 5, 5, 1), 5);
  assert.equal(knobDeltaToValue(-300, 5, 5, 5, 1), 5);
});

// ---- keyboard step ---------------------------------------------------

test('knobStepValue: +/- one step, and PageUp/PageDown as +/- ten steps', () => {
  assert.ok(close(knobStepValue(0.5, 0.1, 1, 0, 2), 0.6));
  assert.ok(close(knobStepValue(0.5, 0.1, -1, 0, 2), 0.4));
  assert.ok(close(knobStepValue(0.5, 0.1, 10, 0, 2), 1.5)); // PageUp
  // PageDown lands at -0.5: the range must include it or the clamp wins.
  assert.ok(close(knobStepValue(0.5, 0.1, -10, -1, 2), -0.5));
});

test('knobStepValue: clamps at the range ends', () => {
  assert.equal(knobStepValue(1, 0.1, 1, 0, 1), 1);
  assert.equal(knobStepValue(0, 0.1, -1, 0, 1), 0);
  // A ×10 step that would overshoot clamps instead.
  assert.equal(knobStepValue(0.97, 0.1, 10, 0, 1), 1);
  assert.equal(knobStepValue(0.03, 0.1, -10, 0, 1), 0);
});

test('knobStepValue: an off-grid value returns to the grid on the first press', () => {
  // 0.53 (set off-grid by a patch edit) + 0.1 = 0.63 -> snaps to 0.6.
  assert.ok(close(knobStepValue(0.53, 0.1, 1, 0, 1), 0.6));
});

test('knobStepValue: integer steps keep integers', () => {
  assert.equal(knobStepValue(100, 1, 1, 1, 999), 101);
  assert.equal(knobStepValue(1, 1, -1, 1, 999), 1); // clamps at min
  assert.equal(knobStepValue(999, 1, 10, 1, 999), 999); // clamps at max
});

// ---- readout formatting ----------------------------------------------

test('formatKnobValue: drops float noise, keeps 6 significant digits', () => {
  assert.equal(formatKnobValue(0.30000000000000004), '0.3');
  assert.equal(formatKnobValue(0.1 + 0.2), '0.3'); // the classic float noise
  assert.equal(formatKnobValue(20476), '20476'); // hi-hat top partial
  assert.equal(formatKnobValue(0.0005), '0.0005'); // envelope-time floor
  assert.equal(formatKnobValue(1), '1');
});

test('formatKnobValue: appends " Hz" only when the descriptor label says so', () => {
  assert.equal(
    formatKnobValue(2000, { label: 'cutoff (Hz)', min: 50, max: 22000, step: 1 }),
    '2000 Hz',
  );
  assert.equal(
    formatKnobValue(20476, { label: 'carrier freq (Hz)', min: 20, max: 22000, step: 1 }),
    '20476 Hz',
  );
  assert.equal(formatKnobValue(5, { label: 'index', min: 0, max: 20, step: 0.1 }), '5');
  assert.equal(formatKnobValue(5, null), '5'); // a knob without a descriptor
  assert.equal(formatKnobValue(0.5), '0.5'); // descriptor optional
});

test('formatKnobValue: never prints NaN or Infinity', () => {
  assert.equal(formatKnobValue(NaN), '-');
  assert.equal(formatKnobValue(Infinity), '-');
  assert.equal(formatKnobValue(-Infinity), '-');
  assert.equal(
    formatKnobValue(NaN, { label: 'cutoff (Hz)', min: 1, max: 2, step: 1 }),
    '-',
  );
});

// ---- buildKnob: the DOM builder (P1/S2) --------------------------------
//
// Headless DOM-stub technique (the revamp steps' method): a minimal
// document.createElement stand-in records what the builder writes
// (classes, attributes, text, children) and which event listeners it
// registers; events are fired by invoking the recorded handlers with a
// synthetic event object. No browser, no layout — and the code under
// the stub is the REAL src/app/knob.js, including all the math above.

// A 2D context that records every drawing call (method + args, in
// order) and throws on a non-finite coordinate (the established free
// NaN guard from the band/viz stubs). Each stroke() / fill() also
// snapshots its path + style into ctx.strokes / ctx.fills (the
// test/viz.test.mjs technique) so a test can ask "which stroke or
// fill used which color and width". createLinearGradient returns a
// distinct sentinel object { __gradient: [x0, y0, x1, y1] } whose
// addColorStop records [offset, color] into its own stops (the
// plan "colors" S9/S10 gradient assertions, asserted by sentinel
// identity); the sentinels also collect into ctx.gradients.
const makeRecordingContext = () => {
  const calls = [];
  const strokes = [];
  const fills = [];
  const gradients = [];
  let path = [];
  const finite = (name, ...nums) => {
    for (const v of nums)
      assert.ok(Number.isFinite(v), `${name}: non-finite coordinate ${v}`);
  };
  let style;
  let fillStyle;
  let shadowColor;
  let shadowBlur = 0; // the real canvas default (a glow-free start)
  let lineWidth = 1;
  return {
    calls,
    strokes,
    fills,
    gradients,
    get strokeStyle() { return style; },
    set strokeStyle(v) { style = v; calls.push(['strokeStyle', v]); },
    get fillStyle() { return fillStyle; },
    set fillStyle(v) { fillStyle = v; calls.push(['fillStyle', v]); },
    get shadowColor() { return shadowColor; },
    set shadowColor(v) { shadowColor = v; calls.push(['shadowColor', v]); },
    get shadowBlur() { return shadowBlur; },
    set shadowBlur(v) { shadowBlur = v; calls.push(['shadowBlur', v]); },
    get lineWidth() { return lineWidth; },
    set lineWidth(v) { lineWidth = v; },
    clearRect(x, y, w, h) { finite('clearRect', x, y, w, h); calls.push(['clearRect', x, y, w, h]); },
    beginPath() { path = []; calls.push(['beginPath']); },
    closePath() { calls.push(['closePath']); },
    createLinearGradient(x0, y0, x1, y1) {
      finite('createLinearGradient', x0, y0, x1, y1);
      calls.push(['createLinearGradient', x0, y0, x1, y1]);
      const grad = { __gradient: [x0, y0, x1, y1], stops: [] };
      grad.addColorStop = (offset, color) => {
        grad.stops.push([offset, color]);
        calls.push(['addColorStop', offset, color]);
      };
      gradients.push(grad);
      return grad;
    },
    stroke() { strokes.push({ pts: path.slice(), strokeStyle: style, lineWidth }); path = []; calls.push(['stroke']); },
    fill() { fills.push({ pts: path.slice(), fillStyle }); path = []; calls.push(['fill']); },
    moveTo(x, y) { finite('moveTo', x, y); path.push({ x, y }); calls.push(['moveTo', x, y]); },
    lineTo(x, y) { finite('lineTo', x, y); path.push({ x, y }); calls.push(['lineTo', x, y]); },
  };
};

// A RECORDING style object (plan "colors" S8): direct property
// assignments (style.transform = ...) land as own properties, while
// setProperty/getPropertyValue capture the custom properties the
// builders set (the knob's --deg arc angle, the fader's --fill track
// split). getPropertyValue returns '' for an unset property, like the
// real DOM.
const makeStubStyle = () => {
  const custom = Object.create(null);
  return {
    setProperty(name, value) { custom[name] = String(value); },
    getPropertyValue(name) { return custom[name] ?? ''; },
  };
};

const makeStubEl = (tagName) => {
  const el = {
    tagName,
    className: '',
    textContent: '',
    style: makeStubStyle(),
    children: [],
    attributes: Object.create(null),
    listeners: Object.create(null),
    capturedPointers: [],
    setAttribute(name, value) {
      el.attributes[name] = String(value);
    },
    getAttribute(name) {
      return el.attributes[name] ?? null;
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    addEventListener(type, handler) {
      (el.listeners[type] ??= []).push(handler);
    },
    setPointerCapture(pointerId) {
      el.capturedPointers.push(pointerId);
    },
    // One MEMOIZED recording 2D context per element — a real canvas
    // returns the same context on every getContext('2d') call, and the
    // tests read the recorded calls off that same object (the
    // cards/band test technique).
    getContext() {
      el.context ??= makeRecordingContext();
      return el.context;
    },
  };
  return el;
};

globalThis.document = { createElement: makeStubEl };

// Fire a synthetic event at the listeners an element registered for
// `type`; the event carries a preventDefault recorder the handlers may
// call (wheel/keydown use it).
const fire = (el, type, props = {}) => {
  const event = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    ...props,
  };
  for (const handler of el.listeners[type] ?? []) handler(event);
  return event;
};

// Depth-first find of the first stub element with exactly this class.
const byClass = (root, cls) => {
  const stack = [...root.children];
  while (stack.length > 0) {
    const el = stack.pop();
    if (el.className === cls) return el;
    stack.push(...el.children);
  }
  return null;
};

// Build a knob and record every onInput value, in order. The defaults
// are a tight 0..1 step-0.01 gain-style knob at 0.5 — the plan's
// S2 examples use exactly this range.
const makeKnob = (over = {}) => {
  const onInput = [];
  const root = buildKnob({
    label: 'level',
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.5,
    format: null,
    onInput: (v) => onInput.push(v),
    ...over,
  });
  return { root, onInput, rotor: byClass(root, 'knob-rotor') };
};

// Assert an onInput sequence against expected values (the 1e-9 relative
// tolerance of close() — the 0.01 grid is not a binary grid).
const assertInput = (onInput, expected) => {
  assert.equal(
    onInput.length,
    expected.length,
    `expected ${expected.length} onInput value(s) ${expected}, got [${onInput}]`,
  );
  expected.forEach((exp, i) =>
    assert.ok(close(onInput[i], exp), `onInput[${i}]: expected ${exp}, got ${onInput[i]}`),
  );
};

test('knobSnapValue: snaps to the step grid, then clamps (the setValue contract)', () => {
  assert.ok(close(knobSnapValue(0.53, 0.1, 0, 1), 0.5));
  assert.ok(close(knobSnapValue(0.57, 0.1, 0, 1), 0.6));
  assert.equal(knobSnapValue(1.5, 0.1, 0, 1), 1); // clamp at max
  assert.equal(knobSnapValue(-0.4, 0.1, 0, 1), 0); // clamp at min
  assert.equal(knobSnapValue(100.4, 1, 1, 999), 100); // integer step
});

test('buildKnob: structure — knob > rotor > indicator, plus label and output readout', () => {
  const { root } = makeKnob();
  assert.equal(root.tagName, 'div');
  assert.equal(root.className, 'knob');
  const rotor = byClass(root, 'knob-rotor');
  assert.ok(rotor, 'missing .knob-rotor');
  assert.equal(rotor.children.length, 1);
  assert.equal(rotor.children[0].className, 'knob-indicator'); // CSS-drawn dial mark
  assert.equal(byClass(root, 'knob-label').textContent, 'level');
  assert.equal(byClass(root, 'knob-value').tagName, 'output');
});

test('buildKnob: rotor carries role=slider, tabindex=0, and the aria state at build time', () => {
  const descriptor = {
    path: 'layers.0.noise.cutoff',
    label: 'cutoff (Hz)',
    min: 50,
    max: 22000,
    step: 1,
  };
  const { root, rotor } = makeKnob({
    label: 'cutoff (Hz)',
    min: 50,
    max: 22000,
    step: 1,
    value: 2000,
    format: descriptor,
  });
  assert.equal(rotor.getAttribute('role'), 'slider');
  assert.equal(rotor.getAttribute('tabindex'), '0');
  assert.equal(rotor.getAttribute('aria-label'), 'cutoff (Hz)');
  assert.equal(rotor.getAttribute('aria-valuemin'), '50');
  assert.equal(rotor.getAttribute('aria-valuemax'), '22000');
  assert.equal(rotor.getAttribute('aria-valuenow'), '2000');
  // the descriptor's label drives the unit of the readout and valuetext
  assert.equal(rotor.getAttribute('aria-valuetext'), '2000 Hz');
  assert.equal(byClass(root, 'knob-value').textContent, '2000 Hz');
  assert.equal(root.value, 2000);
});

test('buildKnob: a 75 px UP drag from 0.5 on 0..1 reaches 1.0 (the plan example)', () => {
  const { root, rotor, onInput } = makeKnob();
  fire(rotor, 'pointerdown', { clientY: 100, pointerId: 7 });
  assert.deepEqual(rotor.capturedPointers, [7]); // captured on press, the old canvas pattern
  fire(rotor, 'pointermove', { clientY: 25 }); // -75 px = half of KNOB_TRAVEL_PX; UP = increase
  assertInput(onInput, [1]);
  assert.equal(byClass(root, 'knob-value').textContent, '1');
  assert.equal(rotor.getAttribute('aria-valuenow'), '1');
  fire(rotor, 'pointerup', { pointerId: 7 });
});

test('buildKnob: the drag re-derives from the drag start (no compounding)', () => {
  const { rotor, onInput } = makeKnob({ value: 0 });
  fire(rotor, 'pointerdown', { clientY: 80, pointerId: 1 });
  fire(rotor, 'pointermove', { clientY: 40 }); // 40 px up: raw 0.26667 -> snaps to 0.27
  fire(rotor, 'pointermove', { clientY: 0 }); // 80 px up: raw 0.53333 -> 0.53, NOT 0.27 + 0.26667 -> 0.54
  fire(rotor, 'pointerup', {});
  assertInput(onInput, [0.27, 0.53]);
});

test('buildKnob: a second drag re-anchors at the value the first drag left', () => {
  const { rotor, onInput } = makeKnob();
  fire(rotor, 'pointerdown', { clientY: 100, pointerId: 1 });
  fire(rotor, 'pointermove', { clientY: 25 }); // 75 px up: 0.5 -> 1
  fire(rotor, 'pointerup', {});
  fire(rotor, 'pointerdown', { clientY: 200, pointerId: 2 });
  fire(rotor, 'pointermove', { clientY: 250 }); // 50 px DOWN from 1 -> 1 - 0.3333 -> 0.67
  assertInput(onInput, [1, 0.67]);
});

test('buildKnob: pointermove without a press does nothing; pointercancel ends the drag', () => {
  const { rotor, onInput } = makeKnob();
  fire(rotor, 'pointermove', { clientY: 175 });
  assertInput(onInput, []);
  fire(rotor, 'pointerdown', { clientY: 100, pointerId: 1 });
  fire(rotor, 'pointercancel', {});
  fire(rotor, 'pointermove', { clientY: 175 }); // the gesture is over
  assertInput(onInput, []);
});

test('buildKnob: wheel steps one notch per turn (up = +, down = -) and prevents default', () => {
  const { rotor, onInput } = makeKnob(); // 0.5, step 0.01
  const up1 = fire(rotor, 'wheel', { deltaY: -100 });
  const up2 = fire(rotor, 'wheel', { deltaY: -100 });
  const down = fire(rotor, 'wheel', { deltaY: 100 });
  for (const e of [up1, up2, down]) assert.ok(e.prevented, 'wheel must preventDefault (no page scroll)');
  assertInput(onInput, [0.51, 0.52, 0.51]);
});

test('buildKnob: arrow keys step by one, PageUp/PageDown by ten', () => {
  const { rotor, onInput } = makeKnob(); // 0.5, step 0.01
  fire(rotor, 'keydown', { key: 'ArrowUp' });
  fire(rotor, 'keydown', { key: 'ArrowRight' });
  fire(rotor, 'keydown', { key: 'ArrowDown' });
  fire(rotor, 'keydown', { key: 'ArrowLeft' });
  fire(rotor, 'keydown', { key: 'PageUp' });
  fire(rotor, 'keydown', { key: 'PageDown' });
  assertInput(onInput, [0.51, 0.52, 0.51, 0.5, 0.6, 0.5]);
});

test('buildKnob: Home/End jump to the range ends', () => {
  const { rotor, onInput } = makeKnob();
  fire(rotor, 'keydown', { key: 'Home' });
  fire(rotor, 'keydown', { key: 'End' });
  assertInput(onInput, [0, 1]);
});

test('buildKnob: handled keys preventDefault; unhandled keys are ignored', () => {
  const { rotor, onInput } = makeKnob();
  const up = fire(rotor, 'keydown', { key: 'ArrowUp' });
  const home = fire(rotor, 'keydown', { key: 'Home' });
  assert.ok(up.prevented);
  assert.ok(home.prevented);
  const tab = fire(rotor, 'keydown', { key: 'Tab' });
  assert.ok(!tab.prevented);
  assertInput(onInput, [0.51, 0]); // ArrowUp and Home only
});

test('buildKnob: every change repaints the readout, the indicator, and the aria state (no commit step)', () => {
  const { root, rotor } = makeKnob(); // 0.5 on 0..1
  const readout = byClass(root, 'knob-value');
  const indicator = byClass(rotor, 'knob-indicator');
  assert.equal(indicator.style.transform, 'rotate(270deg)'); // 0.5 -> half the sweep
  // The value arc (plan "colors" S8): the rotor's --deg is the SAME
  // raw angle as the indicator's transform — the CSS maps it onto the
  // conic sweep (135 = min, 405 = max).
  assert.equal(rotor.style.getPropertyValue('--deg'), '270deg');
  fire(rotor, 'keydown', { key: 'End' });
  assert.equal(readout.textContent, '1');
  assert.equal(rotor.getAttribute('aria-valuenow'), '1');
  assert.equal(rotor.getAttribute('aria-valuetext'), '1');
  assert.equal(indicator.style.transform, 'rotate(405deg)');
  assert.equal(rotor.style.getPropertyValue('--deg'), '405deg');
  assert.equal(root.value, 1);
  fire(rotor, 'keydown', { key: 'Home' });
  assert.equal(readout.textContent, '0');
  assert.equal(rotor.getAttribute('aria-valuenow'), '0');
  assert.equal(indicator.style.transform, 'rotate(135deg)');
  assert.equal(rotor.style.getPropertyValue('--deg'), '135deg');
});

test('buildKnob: setValue clamps + snaps and updates the readout, the aria state, and .value', () => {
  const { root, rotor, onInput } = makeKnob({ step: 0.1 }); // 0.5, step 0.1
  root.setValue(0.63);
  assertInput(onInput, [0.6]);
  assert.ok(close(root.value, 0.6));
  assert.equal(byClass(root, 'knob-value').textContent, '0.6');
  assert.equal(rotor.getAttribute('aria-valuenow'), '0.6');
  assert.equal(rotor.getAttribute('aria-valuetext'), '0.6');
  root.setValue(5); // clamps to max
  assertInput(onInput, [0.6, 1]);
  assert.equal(root.value, 1);
  root.setValue(-2); // clamps to min
  assertInput(onInput, [0.6, 1, 0]);
});

test('buildKnob: setValue with the already-held value is a no-op (the readout-sync pass must not loop)', () => {
  const { root, onInput } = makeKnob();
  root.setValue(0.5); // the value the knob was built with
  assertInput(onInput, []);
  root.setValue(0.7);
  assertInput(onInput, [0.7]);
  root.setValue(0.7); // sync pass re-sends the same value
  assertInput(onInput, [0.7]);
});

test('buildKnob: knobs are independent — no shared module-level state', () => {
  const a = makeKnob();
  const b = makeKnob();
  fire(b.rotor, 'keydown', { key: 'End' });
  assert.equal(a.root.value, 0.5);
  assertInput(a.onInput, []);
  assert.equal(byClass(a.root, 'knob-value').textContent, '0.5');
  assert.equal(b.root.value, 1);
  assertInput(b.onInput, [1]);
});

test('buildKnob: the initial value is clamped + snapped like setValue', () => {
  const off = makeKnob({ step: 0.1, value: 0.53 });
  assert.ok(close(off.root.value, 0.5));
  assert.equal(off.rotor.getAttribute('aria-valuenow'), '0.5');
  const over = makeKnob({ step: 0.1, value: 1.5 });
  assert.equal(over.root.value, 1);
  const under = makeKnob({ min: 20, max: 22000, step: 1, value: 5 });
  assert.equal(under.root.value, 20);
});

// ---- direction contract (plan ui3 P2): up = more, clockwise on increase ----
//
// The LOCKED DIRECTION CONTRACT, pinned clause by clause (the
// knobDeltaToValue comment in knob.js is its code-doc home): an
// increasing value ALWAYS rotates the indicator CLOCKWISE (min 135deg
// at 7:30, mid 270deg at 12:00, max 405deg at 4:30), and every input
// channel agrees that UP = MORE. The wheel (up = +) and key tests
// above are the contract's already-correct half; this block pins the
// rotation and the all-channels agreement, including the drag channel
// the flip changed.

test('direction contract: the angle is strictly increasing in the value (clockwise on increase)', () => {
  // Exact endpoints and midpoint: min 135 (7:30), mid 270 (12
  // o'clock), max 405 (4:30) — and a dense grid across the range
  // where every step of the value raises the angle (never back).
  assert.equal(knobValueToAngle(0, 0, 1), 135);
  assert.equal(knobValueToAngle(0.5, 0, 1), 270);
  assert.equal(knobValueToAngle(1, 0, 1), 405);
  let prev = knobValueToAngle(0, 0, 1);
  for (let i = 1; i <= 200; i += 1) {
    const a = knobValueToAngle(i / 200, 0, 1);
    assert.ok(a > prev, `angle not increasing at fraction ${i / 200}`);
    prev = a;
  }
});

test('direction contract: the built indicator sits at 7:30 / 12:00 / 4:30 for min / mid / max', () => {
  const { root, rotor } = makeKnob(); // 0..1
  const indicator = byClass(rotor, 'knob-indicator');
  root.setValue(0); // min: 7:30
  assert.equal(indicator.style.transform, 'rotate(135deg)');
  root.setValue(0.5); // mid: 12:00
  assert.equal(indicator.style.transform, 'rotate(270deg)');
  root.setValue(1); // max: 4:30
  assert.equal(indicator.style.transform, 'rotate(405deg)');
});

test('direction contract: all four channels agree — up raises, down lowers, and the angle follows', () => {
  const { root, rotor } = makeKnob(); // 0.5 on 0..1, step 0.01
  const angle = () => knobValueToAngle(root.value, 0, 1);
  const mid = 270; // the angle at the mid value

  // The four UP channels, each from a fresh mid value: the value
  // INCREASES and the angle rises.
  fire(rotor, 'pointerdown', { clientY: 100, pointerId: 1 });
  fire(rotor, 'pointermove', { clientY: 95 }); // a 5 px upward drag
  fire(rotor, 'pointerup', {});
  assert.ok(root.value > 0.5, `an upward drag raises the value (got ${root.value})`);
  assert.ok(angle() > mid, 'the angle rises with an upward drag');

  root.setValue(0.5);
  fire(rotor, 'wheel', { deltaY: -100 }); // wheel up
  assert.ok(root.value > 0.5, `wheel up raises the value (got ${root.value})`);
  assert.ok(angle() > mid, 'the angle rises with wheel up');

  root.setValue(0.5);
  fire(rotor, 'keydown', { key: 'ArrowUp' });
  assert.ok(root.value > 0.5, `ArrowUp raises the value (got ${root.value})`);
  assert.ok(angle() > mid, 'the angle rises with ArrowUp');

  root.setValue(0.5);
  fire(rotor, 'keydown', { key: 'ArrowRight' });
  assert.ok(root.value > 0.5, `ArrowRight raises the value (got ${root.value})`);
  assert.ok(angle() > mid, 'the angle rises with ArrowRight');

  // Their four mirrors, each from a fresh mid value: the value
  // DECREASES and the angle falls.
  fire(rotor, 'pointerdown', { clientY: 100, pointerId: 2 });
  fire(rotor, 'pointermove', { clientY: 105 }); // a 5 px downward drag
  fire(rotor, 'pointerup', {});
  assert.ok(root.value < 0.5, `a downward drag lowers the value (got ${root.value})`);
  assert.ok(angle() < mid, 'the angle falls with a downward drag');

  root.setValue(0.5);
  fire(rotor, 'wheel', { deltaY: 100 }); // wheel down
  assert.ok(root.value < 0.5, `wheel down lowers the value (got ${root.value})`);
  assert.ok(angle() < mid, 'the angle falls with wheel down');

  root.setValue(0.5);
  fire(rotor, 'keydown', { key: 'ArrowDown' });
  assert.ok(root.value < 0.5, `ArrowDown lowers the value (got ${root.value})`);
  assert.ok(angle() < mid, 'the angle falls with ArrowDown');

  root.setValue(0.5);
  fire(rotor, 'keydown', { key: 'ArrowLeft' });
  assert.ok(root.value < 0.5, `ArrowLeft lowers the value (got ${root.value})`);
  assert.ok(angle() < mid, 'the angle falls with ArrowLeft');
});

// ---- buildButtonGroup: the enum control (P1/S3) ---------------------
//
// Same headless stub technique as the buildKnob tests above: events
// are fired by invoking the recorded handlers; class and aria state
// are read back off the recorded stub elements.

const FILTER_OPTIONS = [
  { value: 'lp', label: 'LP' },
  { value: 'bp', label: 'BP' },
  { value: 'hp', label: 'HP' },
];

const makeButtonGroup = (over = {}) => {
  const onInput = [];
  const root = buildButtonGroup({
    label: 'filter',
    options: FILTER_OPTIONS,
    value: 'bp',
    onInput: (v) => onInput.push(v),
    ...over,
  });
  return { root, onInput };
};

// The group's toggle buttons, in option order.
const groupButtons = (root) => root.children.filter((child) => child.tagName === 'button');

const activeButton = (root) =>
  groupButtons(root).find((b) => b.className === 'btn active') ?? null;

test('buildButtonGroup: structure — a label line and one toggle button per option', () => {
  const { root } = makeButtonGroup();
  assert.equal(root.tagName, 'div');
  assert.equal(root.className, 'button-group');
  assert.equal(root.getAttribute('role'), 'group');
  assert.equal(root.getAttribute('aria-label'), 'filter');
  assert.equal(byClass(root, 'button-group-label').textContent, 'filter');
  const buttons = groupButtons(root);
  assert.equal(buttons.length, 3);
  for (const b of buttons) {
    assert.equal(b.tagName, 'button');
    assert.equal(b.type, 'button'); // a toggle, never a form submission
  }
  assert.deepEqual(buttons.map((b) => b.textContent), ['LP', 'BP', 'HP']);
});

test('buildButtonGroup: the matching option is active at build (.active + aria-pressed)', () => {
  const { root } = makeButtonGroup(); // value 'bp' -> middle button
  const buttons = groupButtons(root);
  assert.equal(buttons[1].className, 'btn active');
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'true');
  assert.equal(buttons[0].className, 'btn');
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'false');
  assert.equal(buttons[2].className, 'btn');
  assert.equal(buttons[2].getAttribute('aria-pressed'), 'false');
  assert.equal(root.value, 'bp');
});

test('buildButtonGroup: clicking another option fires onInput and moves the active state', () => {
  const { root, onInput } = makeButtonGroup(); // active: 'bp'
  const buttons = groupButtons(root);
  fire(buttons[2], 'click');
  assert.deepEqual(onInput, ['hp']);
  assert.equal(activeButton(root).textContent, 'HP');
  assert.equal(buttons[2].className, 'btn active');
  assert.equal(buttons[2].getAttribute('aria-pressed'), 'true');
  assert.equal(buttons[1].className, 'btn');
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'false');
  assert.equal(root.value, 'hp');
});

test('buildButtonGroup: clicking the already-active option is a no-op', () => {
  const { root, onInput } = makeButtonGroup();
  const buttons = groupButtons(root);
  fire(buttons[1], 'click'); // 'bp' is already active
  assert.deepEqual(onInput, []);
  assert.equal(root.value, 'bp');
  assert.equal(buttons[1].className, 'btn active');
});

test('buildButtonGroup: an unknown value at build time leaves no active button (no throw)', () => {
  const { root, onInput } = makeButtonGroup({ value: 'notch' });
  const buttons = groupButtons(root);
  for (const b of buttons) {
    assert.equal(b.className, 'btn');
    assert.equal(b.getAttribute('aria-pressed'), 'false');
  }
  assert.equal(activeButton(root), null);
  assert.equal(root.value, null);
  // The group is still usable: clicking any option works.
  fire(buttons[0], 'click');
  assert.deepEqual(onInput, ['lp']);
  assert.equal(root.value, 'lp');
});

test('buildButtonGroup: setValue activates the match; unknown clears; same value is a no-op', () => {
  const { root, onInput } = makeButtonGroup(); // 'bp'
  root.setValue('lp');
  assert.deepEqual(onInput, ['lp']);
  assert.equal(activeButton(root).textContent, 'LP');
  root.setValue('lp'); // the readout-sync no-op rule (the sync pass must not loop)
  assert.deepEqual(onInput, ['lp']);
  root.setValue('notch'); // unknown: clear the group, and no onInput (unrepresentable)
  assert.deepEqual(onInput, ['lp']);
  assert.equal(activeButton(root), null);
  assert.equal(root.value, null);
});

test('buildButtonGroup: the active button\'s label is the group\'s readout of its value', () => {
  // The plan's "readout text matches format(value)" for a group is the
  // option's own label (the group has no numeric format): what the
  // user sees pressed is the text of the value the group holds.
  const { root } = makeButtonGroup({ value: 'hp' });
  assert.equal(activeButton(root).textContent, 'HP');
  root.setValue('lp');
  assert.equal(activeButton(root).textContent, 'LP');
});

test('buildButtonGroup: boolean options (ring on/off) match by strict equality', () => {
  const onInput = [];
  const root = buildButtonGroup({
    label: 'ring',
    options: [
      { value: false, label: 'off' },
      { value: true, label: 'on' },
    ],
    value: false,
    onInput: (v) => onInput.push(v),
  });
  const buttons = groupButtons(root);
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'true'); // false, not 0, is active
  assert.equal(buttons[0].className, 'btn active');
  fire(buttons[1], 'click');
  assert.deepEqual(onInput, [true]);
  assert.equal(root.value, true);
});

test('buildButtonGroup: groups are independent — no shared module-level state', () => {
  const a = makeButtonGroup();
  const b = makeButtonGroup();
  fire(groupButtons(b.root)[0], 'click');
  assert.equal(a.root.value, 'bp');
  assert.deepEqual(a.onInput, []);
  assert.equal(groupButtons(a.root)[1].getAttribute('aria-pressed'), 'true');
  assert.equal(b.root.value, 'lp');
  assert.deepEqual(b.onInput, ['lp']);
});

// ---- buildFader: the linear control (P1/S3) --------------------------

const makeFader = (over = {}) => {
  const onInput = [];
  const root = buildFader({
    label: 'length (s)',
    min: 0.1,
    max: 2,
    step: 0.01,
    value: 0.5,
    format: { label: 'length (s)', min: 0.1, max: 2, step: 0.01 },
    onInput: (v) => onInput.push(v),
    ...over,
  });
  const input = root.children.find((child) => child.tagName === 'input');
  return { root, onInput, input };
};

test('buildFader: structure — a range input, a label, and an output readout', () => {
  const { root, input } = makeFader();
  assert.equal(root.tagName, 'div');
  assert.equal(root.className, 'fader');
  assert.equal(input.tagName, 'input');
  assert.equal(input.type, 'range');
  assert.equal(input.className, 'fader-input');
  assert.equal(input.getAttribute('min'), '0.1');
  assert.equal(input.getAttribute('max'), '2');
  assert.equal(input.getAttribute('step'), '0.01');
  assert.equal(byClass(root, 'fader-label').textContent, 'length (s)');
  assert.equal(byClass(root, 'fader-value').tagName, 'output');
});

test('buildFader: the input carries the slider role and aria state at build time', () => {
  const { root, input } = makeFader(); // 0.5 on 0.1..2
  assert.equal(input.getAttribute('role'), 'slider');
  assert.equal(input.getAttribute('aria-label'), 'length (s)');
  assert.equal(input.getAttribute('aria-valuemin'), '0.1');
  assert.equal(input.getAttribute('aria-valuemax'), '2');
  assert.equal(input.getAttribute('aria-valuenow'), '0.5');
  assert.equal(input.getAttribute('aria-valuetext'), '0.5');
  assert.equal(input.value, '0.5');
  assert.equal(root.value, 0.5);
});

test('buildFader: the input event fires onInput with the parsed value and repaints', () => {
  const { root, input, onInput } = makeFader();
  input.value = '1.25';
  fire(input, 'input', { target: input });
  assert.deepEqual(onInput, [1.25]);
  assert.equal(root.value, 1.25);
  assert.equal(byClass(root, 'fader-value').textContent, '1.25');
  assert.equal(input.getAttribute('aria-valuenow'), '1.25');
  assert.equal(input.getAttribute('aria-valuetext'), '1.25');
});

test('buildFader: an off-grid slider position is snapped before onInput', () => {
  const { input, onInput } = makeFader({ step: 0.05, value: 0.5 });
  input.value = '0.83';
  fire(input, 'input', { target: input }); // 0.83 -> nearest 0.05 line = 0.85
  assertInput(onInput, [0.85]);
});

test('buildFader: setValue round-trips through .value, input, readout, and aria', () => {
  const { root, input, onInput } = makeFader({ step: 0.1, value: 0.5 });
  root.setValue(0.63); // snaps to the 0.1 grid
  assertInput(onInput, [0.6]);
  assert.ok(close(root.value, 0.6));
  assert.equal(input.value, '0.6');
  assert.equal(byClass(root, 'fader-value').textContent, '0.6');
  assert.equal(input.getAttribute('aria-valuenow'), '0.6');
  assert.equal(input.getAttribute('aria-valuetext'), '0.6');
  root.setValue(9); // clamps to max 2
  assertInput(onInput, [0.6, 2]);
  assert.equal(input.value, '2');
  assert.equal(root.value, 2);
  root.setValue(-3); // clamps to min 0.1
  assertInput(onInput, [0.6, 2, 0.1]);
});

test('buildFader: setValue with the already-held value is a no-op (the readout-sync pass must not loop)', () => {
  const { root, onInput } = makeFader();
  root.setValue(0.5); // the value the fader was built with
  assert.deepEqual(onInput, []);
  root.setValue(0.7); // 7 * 0.1 = 0.7000000000000001 in float — tolerance match
  assertInput(onInput, [0.7]);
  root.setValue(0.7); // sync pass re-sends the same value
  assertInput(onInput, [0.7]);
});

test('buildFader: float noise is dropped in the readout, input value, and aria', () => {
  const { root, input } = makeFader({ step: 0.1, value: 0.5 });
  root.setValue(0.7); // 7 * 0.1 = 0.7000000000000001 in float
  assert.equal(byClass(root, 'fader-value').textContent, '0.7');
  assert.equal(input.value, '0.7');
  assert.equal(input.getAttribute('aria-valuenow'), '0.7');
});

test('faderFillPercent: 0..100 across the range, clamped, zero-width safe', () => {
  assert.equal(faderFillPercent(0, 0, 1), 0);
  assert.equal(faderFillPercent(1, 0, 1), 100);
  assert.equal(faderFillPercent(0.25, 0, 1), 25);
  // A real fader span (length 0.1..2): interior values are linear in
  // the range fraction.
  assert.ok(close(faderFillPercent(0.4, 0.1, 2), (0.3 / 1.9) * 100));
  assert.equal(faderFillPercent(-5, 0, 1), 0); // clamped to min
  assert.equal(faderFillPercent(9, 0, 1), 100); // clamped to max
  assert.equal(faderFillPercent(7, 7, 7), 0); // zero-width: no sweep
});

test('buildFader: the track fill (--fill) tracks the value at build and on every commit', () => {
  const { input } = makeFader(); // 0.5 on 0.1..2
  assert.equal(input.style.getPropertyValue('--fill'), '21.05%'); // (0.5−0.1)/1.9
  input.value = '1.25';
  fire(input, 'input', { target: input });
  assert.equal(input.style.getPropertyValue('--fill'), '60.53%');
  input.value = '2';
  fire(input, 'input', { target: input });
  assert.equal(input.style.getPropertyValue('--fill'), '100.00%');
  input.value = '0.1';
  fire(input, 'input', { target: input });
  assert.equal(input.style.getPropertyValue('--fill'), '0.00%');
});

test('buildFader: the readout matches formatKnobValue(value, format), unit included', () => {
  const { root } = makeFader(); // 'length (s)': no unit
  assert.equal(byClass(root, 'fader-value').textContent, '0.5');
  const hz = makeFader({
    label: 'cutoff (Hz)',
    min: 50,
    max: 22000,
    step: 1,
    value: 2000,
    format: { label: 'cutoff (Hz)', min: 50, max: 22000, step: 1 },
  });
  assert.equal(byClass(hz.root, 'fader-value').textContent, '2000 Hz');
  assert.equal(hz.input.getAttribute('aria-valuetext'), '2000 Hz');
  hz.root.setValue(20476);
  assert.equal(byClass(hz.root, 'fader-value').textContent, '20476 Hz');
});

test('buildFader: the initial value is clamped + snapped like setValue', () => {
  const { root } = makeFader({ value: 9 }); // clamps to max 2
  assert.equal(root.value, 2);
  const { root: under } = makeFader({ value: 0.01, step: 0.1 }); // snaps to 0 -> clamps to 0.1
  assert.ok(close(under.value, 0.1));
});

test('buildFader: faders are independent — no shared module-level state', () => {
  const a = makeFader();
  const b = makeFader();
  b.root.setValue(1.5);
  assert.equal(a.root.value, 0.5);
  assert.deepEqual(a.onInput, []);
  assert.equal(a.input.value, '0.5');
  assert.equal(b.root.value, 1.5);
  assert.deepEqual(b.onInput, [1.5]);
});

// ---- buildShapeGroup: the wave-shape control (sinecontrol P2/S5) ----
//
// The FM cards' per-operator shape control: a buildButtonGroup-style
// glyph button row (∿ □ ◺ △) plus a 72×24 live one-period preview
// canvas painted by viz.js's drawShapeWave. Same headless stub
// technique as above — the stub canvas now carries a memoized
// recording 2D context (getContext), so the preview's paints are read
// back off that context.

// The shape options: the engine's enum values (src/lib/osc.js
// WAVE_SHAPES) with Geonkick-style glyph labels — the S6 controls.js
// SHAPE_OPTIONS twin (the drift guard against the lib enum lands
// there).
const SHAPE_OPTIONS = [
  { value: 'sine', label: '∿' },
  { value: 'square', label: '□' },
  { value: 'saw', label: '◺' },
  { value: 'triangle', label: '△' },
];

const makeShapeGroup = (over = {}) => {
  const onInput = [];
  const root = buildShapeGroup({
    label: 'wave shape',
    options: SHAPE_OPTIONS,
    value: 'sine',
    onInput: (v) => onInput.push(v),
    ...over,
  });
  return { root, onInput, preview: byClass(root, 'shape-preview') };
};

// The preview's trace stroke: drawShapeWave paints the faint 1 px
// midline first (strokes[0]) and the one-period trace on top of it
// (strokes[1]) — the viz test's ordering.
const previewTrace = (preview, offset = 0) => preview.getContext('2d').strokes[1 + offset * 2];

test('buildShapeGroup: structure — 4 glyph buttons + 72×24 preview, group aria, per-button aria-label', () => {
  const { root, preview } = makeShapeGroup({ label: 'carrier wave shape' });
  assert.equal(root.tagName, 'div');
  assert.equal(root.className, 'shape-group');
  assert.equal(root.getAttribute('role'), 'group');
  assert.equal(root.getAttribute('aria-label'), 'carrier wave shape');
  const buttons = groupButtons(root);
  assert.equal(buttons.length, 4);
  for (const b of buttons) {
    assert.equal(b.tagName, 'button');
    assert.equal(b.type, 'button'); // a toggle, never a form submission
  }
  // The glyph row: the option labels, in option order.
  assert.deepEqual(buttons.map((b) => b.textContent), ['∿', '□', '◺', '△']);
  // The glyph alone is useless to assistive tech: the shape name is
  // the button's aria-label (the group itself keeps its aria-label).
  assert.deepEqual(
    buttons.map((b) => b.getAttribute('aria-label')),
    ['sine', 'square', 'saw', 'triangle'],
  );
  assert.equal(preview.tagName, 'canvas');
  assert.equal(preview.className, 'shape-preview');
  assert.equal(preview.width, 72);
  assert.equal(preview.height, 24);
});

test('buildShapeGroup: the matching option is active at build and the preview is painted once, in the accent when color is null', () => {
  const { root, preview } = makeShapeGroup({ value: 'square' }); // square active
  const buttons = groupButtons(root);
  assert.equal(buttons[1].className, 'btn active');
  assert.equal(buttons[1].getAttribute('aria-pressed'), 'true');
  assert.equal(buttons[0].className, 'btn');
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'false');
  assert.equal(root.value, 'square');

  const ctx = preview.getContext('2d');
  // Exactly ONE paint at build: one clearRect, then the midline +
  // trace strokes (drawShapeWave's two strokes).
  assert.equal(ctx.calls.filter(([k]) => k === 'clearRect').length, 1);
  assert.equal(ctx.strokes.length, 2, 'midline + one trace');
  const [mid, trace] = ctx.strokes;
  assert.equal(mid.strokeStyle, COLORS.grid);
  assert.equal(mid.lineWidth, 1);
  // The card passes no color: the trace is the app accent.
  assert.equal(trace.strokeStyle, COLORS.trace);
  assert.equal(trace.lineWidth, 2);
  // One vertex per pixel column, all finite (the stub already throws
  // on a non-finite one) and inside the 1 px inset span [1, H−1].
  assert.equal(trace.pts.length, 72);
  for (const p of trace.pts) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    assert.ok(p.y >= 1 && p.y <= 23, `y ${p.y} outside [1, 23]`);
  }
  // The S10 faint fill under the trace: one vertical 0 -> H gradient
  // at 0.12 of the trace color fading to transparent (sentinel
  // identity) — and no glow (the preview's fill is faint by design;
  // the shadow language is the band's and the env editor's).
  assert.equal(ctx.gradients.length, 1, 'the one gradient fill');
  assert.deepEqual(ctx.gradients[0].__gradient, [0, 0, 0, 24], 'vertical 0 -> H');
  assert.deepEqual(ctx.gradients[0].stops, [
    [0, withAlpha(COLORS.trace, 0.12)],
    [1, withAlpha(COLORS.trace, 0)],
  ], 'the fill fades 0.12 -> 0 of the trace color');
  assert.equal(ctx.fills.length, 1, 'exactly one fill (under the trace)');
  assert.equal(ctx.fills[0].fillStyle, ctx.gradients[0], 'the fill wears the gradient sentinel');
  assert.equal(ctx.shadowBlur, 0, 'the preview leaves no glow');
});

test('buildShapeGroup: a passed color strokes the preview (no accent fallback)', () => {
  const { preview } = makeShapeGroup({ value: 'saw', color: '#ff00ff' });
  const ctx = preview.getContext('2d');
  const trace = previewTrace(preview);
  assert.equal(trace.strokeStyle, '#ff00ff');
  // The S10 fill follows the passed color too: its gradient stops are
  // the passed color at 0.12 -> 0 (no accent fallback in the fill).
  assert.equal(ctx.gradients.length, 1, 'the one gradient fill');
  assert.deepEqual(ctx.gradients[0].stops, [
    [0, withAlpha('#ff00ff', 0.12)],
    [1, withAlpha('#ff00ff', 0)],
  ], 'the fill fades 0.12 -> 0 of the passed color');
  assert.equal(ctx.fills.length, 1, 'exactly one fill (under the trace)');
  assert.equal(ctx.fills[0].fillStyle, ctx.gradients[0], 'the fill wears the gradient sentinel');
});

test('buildShapeGroup: clicking another option fires onInput, moves the active state, and repaints the preview', () => {
  const { root, preview, onInput } = makeShapeGroup(); // 'sine' active
  const buttons = groupButtons(root);
  const firstTrace = previewTrace(preview);
  fire(buttons[2], 'click'); // 'saw'
  assert.deepEqual(onInput, ['saw']);
  assert.equal(activeButton(root).getAttribute('aria-label'), 'saw');
  assert.equal(buttons[2].className, 'btn active');
  assert.equal(buttons[2].getAttribute('aria-pressed'), 'true');
  assert.equal(buttons[0].className, 'btn');
  assert.equal(buttons[0].getAttribute('aria-pressed'), 'false');
  assert.equal(root.value, 'saw');
  const ctx = preview.getContext('2d');
  // The repaint re-clears the canvas and paints a second midline +
  // trace (the second stroke after the clearRect).
  assert.equal(ctx.calls.filter(([k]) => k === 'clearRect').length, 2);
  assert.equal(ctx.strokes.length, 4, 'two midlines + two traces');
  const newTrace = ctx.strokes[3];
  assert.equal(newTrace.strokeStyle, COLORS.trace);
  assert.equal(newTrace.pts.length, 72);
  // It actually painted a different shape: saw's trace is not sine's.
  assert.notDeepEqual(newTrace.pts, firstTrace.pts);
});

test('buildShapeGroup: each glyph button commits its option\'s value (all four shapes)', () => {
  const { root, onInput } = makeShapeGroup({ value: 'sine' });
  const buttons = groupButtons(root);
  fire(buttons[1], 'click'); // square
  fire(buttons[3], 'click'); // triangle
  fire(buttons[0], 'click'); // back to sine (it moved away, so it fires)
  assert.deepEqual(onInput, ['square', 'triangle', 'sine']);
  assert.equal(root.value, 'sine');
});

test('buildShapeGroup: clicking the already-active option is a no-op (no onInput, no repaint)', () => {
  const { root, preview, onInput } = makeShapeGroup(); // 'sine' active
  const calls = preview.getContext('2d').calls;
  const before = calls.length;
  fire(groupButtons(root)[0], 'click'); // 'sine' is already active
  assert.deepEqual(onInput, []);
  assert.equal(root.value, 'sine');
  assert.equal(calls.length, before, 'commit no-op: the preview is not repainted');
});

test('buildShapeGroup: setValue activates the match (fire + repaint); the held value is a no-op (sync-pass loop safety)', () => {
  const { root, preview, onInput } = makeShapeGroup(); // 'sine'
  const calls = preview.getContext('2d').calls;
  const before = calls.length;
  root.setValue('sine'); // the readout-sync pass re-sends the held value
  assert.deepEqual(onInput, []);
  assert.equal(calls.length, before, 'no repaint for an unchanged value');
  root.setValue('triangle');
  assert.deepEqual(onInput, ['triangle']);
  assert.equal(root.value, 'triangle');
  assert.equal(activeButton(root).getAttribute('aria-label'), 'triangle');
  assert.equal(preview.getContext('2d').strokes.length, 4, 'the repaint happened');
});

test('buildShapeGroup: an unknown build value leaves no active button, .value null, a cleared preview (no throw, no onInput)', () => {
  const onInput = [];
  const root = buildShapeGroup({
    label: 'wave shape',
    options: SHAPE_OPTIONS,
    value: 'pulse',
    onInput: (v) => onInput.push(v),
  });
  const preview = byClass(root, 'shape-preview');
  for (const b of groupButtons(root)) {
    assert.equal(b.className, 'btn');
    assert.equal(b.getAttribute('aria-pressed'), 'false');
  }
  assert.equal(root.value, null);
  // The preview is cleared, not painted: one clearRect, no strokes.
  const ctx = preview.getContext('2d');
  assert.equal(ctx.calls.filter(([k]) => k === 'clearRect').length, 1);
  assert.deepEqual(ctx.calls.filter(([k]) => k === 'clearRect')[0], ['clearRect', 0, 0, 72, 24]);
  assert.equal(ctx.strokes.length, 0, 'no midline, no trace');
  assert.deepEqual(onInput, []);
  // The group is still usable: clicking any option works and paints.
  fire(groupButtons(root)[1], 'click');
  assert.deepEqual(onInput, ['square']);
  assert.equal(root.value, 'square');
  assert.equal(ctx.strokes.length, 2);
});

test('buildShapeGroup: setValue with an unknown value clears the group and the preview without firing or throwing', () => {
  const { root, preview, onInput } = makeShapeGroup(); // 'sine'
  root.setValue('pulse'); // never throws, never fires (unrepresentable)
  assert.deepEqual(onInput, []);
  assert.equal(root.value, null);
  assert.equal(activeButton(root), null);
  const ctx = preview.getContext('2d');
  assert.equal(ctx.calls.filter(([k]) => k === 'clearRect').length, 2, 'build paint + the clear');
  assert.equal(ctx.strokes.length, 2, 'the clear adds no stroke');
  // Back to a known value: repaint + fire again.
  root.setValue('saw');
  assert.deepEqual(onInput, ['saw']);
  assert.equal(root.value, 'saw');
  assert.equal(activeButton(root).getAttribute('aria-label'), 'saw');
  assert.equal(ctx.strokes.length, 4);
});

test('buildShapeGroup: groups are independent — no shared module-level state', () => {
  const a = makeShapeGroup(); // 'sine'
  const b = makeShapeGroup({ value: 'triangle' });
  fire(groupButtons(b.root)[1], 'click'); // b -> 'square'
  assert.equal(a.root.value, 'sine');
  assert.deepEqual(a.onInput, []);
  assert.equal(activeButton(a.root).getAttribute('aria-label'), 'sine');
  assert.equal(previewTrace(a.preview).strokeStyle, COLORS.trace);
  assert.equal(b.root.value, 'square');
  assert.deepEqual(b.onInput, ['square']);
  assert.equal(activeButton(b.root).getAttribute('aria-label'), 'square');
  // b's repaint touched only b's canvas.
  assert.equal(a.preview.getContext('2d').strokes.length, 2);
  assert.equal(b.preview.getContext('2d').strokes.length, 4);
});

// ---- repo style (GUIDELINES §3: no leftover console.log, no dead code)

test('knob.js source: no console.* calls, no debugger statements', async () => {
  const src = await readFile(join(repoRoot, 'src', 'app', 'knob.js'), 'utf8');
  assert.ok(!/console\s*\./.test(src), 'no console.* calls (GUIDELINES §3)');
  assert.ok(!/\bdebugger\b/.test(src), 'no debugger statements');
});
