// Tests for src/app/env-editor.js (plan "dahdsr" P4/S1) — the shared
// constrained-envelope canvas core: the kind configs (level / pitch /
// fm depth), envMaps (the pixel maps with the optional {t0, span}
// zoom window), hitTestEnv (the role-anchor / bend-dot hit test),
// dragEnv (the PURE drag — (points, kind, hit, t, v) -> a new
// canonical array, the no-split-brain contract), drawEnv (the canvas
// 2D drawing) and wireEnvEditor (the pointer handlers; displayOnly
// mode attaches none).
//
// Same headless DOM-stub technique as test/cards.test.mjs: a minimal
// document.createElement stand-in records what the code writes; the
// pure functions are tested without any DOM at all.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLICK_SLOP,
  HANDLE_RADIUS,
  KINDS,
  dragEnv,
  drawEnv,
  envMaps,
  hitTestEnv,
  wireEnvEditor,
} from '../src/app/env-editor.js';
import {
  dahdsrToPoints,
  isCanonicalLevel,
  midValueToCurve,
  pointsToDahdsr,
  segmentMidValue,
} from '../src/app/dahdsr.js';
import { bandHzRange, hzToNoteName, logYScale } from '../src/app/band.js';
import { editorValueRange } from '../src/app/controls.js';
import { COLORS, PAD_BOTTOM, PAD_TOP, drawAxis } from '../src/app/viz.js';
import { THEME } from '../src/app/theme.js';
import { kickPatch } from '../src/lib/index.js';

// ---- fixtures ---------------------------------------------------------

// The kick's canonical 6-point level env (the plan's reference shape):
// attack 5 ms, decay 300 ms, decayCurve 0.55 — the zero delay / hold /
// sustain / release spans as duplicate-t points.
const LEVEL_POINTS = [
  { t: 0, v: 0 },
  { t: 0, v: 0 },
  { t: 0.005, v: 1 },
  { t: 0.005, v: 1, curve: 0.55 },
  { t: 0.305, v: 0 },
  { t: 0.305, v: 0 },
];
const PITCH_POINTS = [{ t: 0, v: 100 }, { t: 0.03, v: 50 }];
const FM_POINTS = [{ t: 0, v: 8 }, { t: 0.02, v: 0 }];

// A live drum the wire tests edit: the kick body's own patch (a real
// fixture — levelEnv / pitchEnv / indexEnv all canonical).
const makeDrum = () => {
  const patch = kickPatch();
  return { name: 'kick', duration: 0.5, patch };
};

// ---- headless canvas stub (the test/cards.test.mjs technique) --------

const makeStubContext = () => {
  const g = { calls: [], strokes: [], fills: [], gradients: [] };
  let path = [];
  g.strokeStyle = undefined;
  g.fillStyle = undefined;
  g.lineWidth = 1;
  let shadowColor;
  let shadowBlur = 0; // the real canvas default (a glow-free start)
  Object.defineProperty(g, 'shadowColor', {
    get: () => shadowColor,
    set: (v) => { shadowColor = v; g.calls.push(['shadowColor', v]); },
    enumerable: true,
  });
  Object.defineProperty(g, 'shadowBlur', {
    get: () => shadowBlur,
    set: (v) => { shadowBlur = v; g.calls.push(['shadowBlur', v]); },
    enumerable: true,
  });
  g.createLinearGradient = (x0, y0, x1, y1) => {
    g.calls.push(['createLinearGradient', x0, y0, x1, y1]);
    const grad = { __gradient: [x0, y0, x1, y1], stops: [] };
    grad.addColorStop = (offset, color) => {
      grad.stops.push([offset, color]);
      g.calls.push(['addColorStop', offset, color]);
    };
    g.gradients.push(grad);
    return grad;
  };
  for (const m of [
    'clearRect', 'fillRect', 'fillText', 'stroke', 'fill', 'beginPath',
    'moveTo', 'lineTo', 'arc', 'closePath',
  ])
    g[m] = (...args) => {
      g.calls.push([m, ...args]);
      for (const a of args)
        if (typeof a === 'number' && !Number.isFinite(a))
          throw new Error(`non-finite coordinate in ${m}: ${args}`);
      if (m === 'beginPath') path = [];
      if (m === 'moveTo' || m === 'lineTo') path.push({ x: args[0], y: args[1] });
      if (m === 'stroke') {
        g.strokes.push({
          pts: path.slice(),
          strokeStyle: g.strokeStyle,
          lineWidth: g.lineWidth,
        });
        path = [];
      }
      if (m === 'fill') g.fills.push({ pts: path.slice(), fillStyle: g.fillStyle });
    };
  g.measureText = (t) => ({ width: 30, text: t });
  return g;
};

const makeCanvas = (width, height) => {
  const el = {
    tagName: 'canvas',
    width,
    height,
    style: {},
    listeners: Object.create(null),
    capturedPointers: [],
    addEventListener(type, handler) {
      (el.listeners[type] ??= []).push(handler);
    },
    setPointerCapture(pointerId) {
      el.capturedPointers.push(pointerId);
    },
    // The stub maps clientX/clientY 1:1 to canvas px.
    getBoundingClientRect() {
      return { left: 0, top: 0, width: el.width, height: el.height };
    },
    getContext() {
      el.context ??= makeStubContext();
      return el.context;
    },
  };
  return el;
};

const fire = (el, type, props = {}) => {
  for (const handler of el.listeners[type] ?? [])
    handler({ preventDefault() {}, stopPropagation() {}, ...props });
};
const press = (canvas, x, y) => fire(canvas, 'pointerdown', { clientX: x, clientY: y, pointerId: 1 });
const move = (canvas, x, y) => fire(canvas, 'pointermove', { clientX: x, clientY: y });
const release = (canvas, x, y) => fire(canvas, 'pointerup', { clientX: x, clientY: y });

// The maps every geometry test below shares: a 1000×400 canvas, the
// kick drum's 0.5 s duration, no window (the full span).
const W = 1000;
const H = 400;
const DURATION = 0.5;
const PLOTH = H - PAD_TOP - PAD_BOTTOM;
const maps = (kind, points) =>
  envMaps({ width: W, height: H, kind, points, window: null, duration: DURATION });
const tToX = (t) => maps('level', LEVEL_POINTS).tToX(t);
const vToY = (v) => maps('level', LEVEL_POINTS).vToY(v);

// ---- the kind configs --------------------------------------------------

test('KINDS: one config per kind — anchors, bends, knob-range clamps, scale', () => {
  assert.deepEqual(Object.keys(KINDS).sort(), ['fm depth', 'level', 'pitch']);
  // level: six role anchors (the start fixed), the three bends, the
  // level span / value knob ranges, the linear 0..1 scale.
  assert.equal(KINDS.level.anchors.length, 6);
  assert.equal(KINDS.level.anchors[0].fixed, true, 'the start anchor is fixed');
  assert.deepEqual(KINDS.level.bends, [1, 3, 4], 'the DAHDSR three bend segments');
  assert.deepEqual(KINDS.level.timeRange, [0, 1.5], 'the level span knob range');
  assert.deepEqual(KINDS.level.valueRange, editorValueRange('level'), 'the level value knob range');
  assert.equal(KINDS.level.scale, 'linear');
  // pitch / fm depth: two anchors (start v-only, end h+v), no bends,
  // the envelope-time knob range, the editorValueRange values.
  for (const kind of ['pitch', 'fm depth']) {
    assert.equal(KINDS[kind].anchors.length, 2);
    assert.equal(KINDS[kind].anchors[0].fixedT, true, 'the start anchor is t-fixed');
    assert.deepEqual(KINDS[kind].bends, []);
    assert.deepEqual(KINDS[kind].timeRange, [0.0005, 1.5], 'the envelope-time knob range');
    assert.deepEqual(KINDS[kind].valueRange, editorValueRange(kind));
  }
  assert.equal(KINDS.pitch.scale, 'logHz');
  assert.equal(KINDS['fm depth'].scale, 'linear');
});

// ---- envMaps: the time window ------------------------------------------

test('envMaps: the full span (no window) maps 0..duration to 0..W with clamps', () => {
  const m = maps('level', LEVEL_POINTS);
  assert.equal(m.t0, 0);
  assert.equal(m.span, DURATION);
  assert.equal(m.tToX(0), 0);
  assert.equal(m.tToX(DURATION), W);
  assert.equal(m.tToX(DURATION / 2), W / 2);
  // Round-trips.
  for (const t of [0, 0.01, 0.123, 0.499, DURATION])
    assert.equal(m.xToT(m.tToX(t)), t, `xToT(tToX(${t})) = ${t}`);
  // The clamps: tToX pins to [0, W], xToT to [0, duration].
  assert.equal(m.tToX(-1), 0);
  assert.equal(m.tToX(10), W);
  assert.equal(m.xToT(-5), 0);
  assert.equal(m.xToT(W + 5), DURATION);
});

test('envMaps: a zoom window {t0, span} maps the window to 0..W (zoom in / pan / clamps)', () => {
  const m = envMaps({
    width: W, height: H, kind: 'level', points: LEVEL_POINTS,
    window: { t0: 0.1, span: 0.2 }, duration: DURATION,
  });
  assert.equal(m.t0, 0.1);
  assert.equal(m.span, 0.2);
  // The window's edges land on the plot's edges; its center maps to
  // the middle.
  assert.equal(m.tToX(0.1), 0);
  assert.equal(m.tToX(0.3), W);
  assert.equal(m.tToX(0.2), W / 2);
  // The clamps: outside the window, both maps pin to the edges.
  assert.equal(m.tToX(0.05), 0);
  assert.equal(m.tToX(0.4), W);
  assert.equal(m.xToT(0), 0.1);
  assert.equal(m.xToT(W), 0.1 + 0.2, 'the window end (the t0 + span sum, exact)');
  assert.ok(Math.abs(m.xToT(250) - 0.15) < 1e-12, 'the window middle maps to the plot middle');
  // The edge snap: t at the window's end sits exactly on the plot end.
  assert.equal(m.tToX(0.3), W);
  assert.equal(m.xToT(-9), 0.1);
  assert.equal(m.xToT(W + 9), 0.1 + 0.2, 'the window end, exact');
  // Round-trips inside the window (the pixel map is FP — within a
  // ulp of the original time).
  for (const t of [0.1, 0.15, 0.25, 0.3])
    assert.ok(Math.abs(m.xToT(m.tToX(t)) - t) < 1e-12, `xToT(tToX(${t})) ~= ${t}`);
});

test('envMaps: a stale window is clamped to the drum (span <= duration, 0 <= t0)', () => {
  const m = envMaps({
    width: W, height: H, kind: 'level', points: LEVEL_POINTS,
    window: { t0: -1, span: 2 }, duration: DURATION,
  });
  assert.equal(m.span, DURATION, 'the span cannot exceed the drum');
  assert.equal(m.t0, 0, 't0 cannot go before the start');
  const m2 = envMaps({
    width: W, height: H, kind: 'level', points: LEVEL_POINTS,
    window: { t0: 0.9, span: 0.2 }, duration: DURATION,
  });
  assert.equal(m2.t0, 0.3, 't0 is pulled back so the window ends at the drum end');
  assert.equal(m2.t0 + m2.span, DURATION);
});

test('envMaps: the level value scale is the fixed 0..1 with clamped yToV', () => {
  const m = maps('level', LEVEL_POINTS);
  assert.equal(m.vLo, 0);
  assert.equal(m.vHi, 1);
  assert.equal(m.vToY(0), PAD_TOP + PLOTH);
  assert.equal(m.vToY(1), PAD_TOP);
  assert.equal(m.vToY(0.5), PAD_TOP + PLOTH / 2);
  // yToV round-trips and clamps to the kind range outside the plot.
  for (const v of [0, 0.25, 0.7, 1])
    assert.equal(m.yToV(m.vToY(v)), v, `yToV(vToY(${v})) = ${v}`);
  assert.equal(m.yToV(-100), 1, 'past the top clamps to 1');
  assert.equal(m.yToV(H + 100), 0, 'past the bottom clamps to 0');
});

test('envMaps: the pitch value scale is log-Hz over the env\'s OWN range (bandHzRange + logYScale)', () => {
  const m = maps('pitch', PITCH_POINTS);
  const [lo, hi] = bandHzRange([{ points: PITCH_POINTS.map((p) => p.v) }]);
  assert.deepEqual([m.vLo, m.vHi], [lo, hi], 'the plot fits the env\'s own Hz range');
  // The endpoints land on the plot's edges (logYScale's law).
  assert.equal(m.vToY(100), PAD_TOP);
  assert.equal(m.vToY(50), PAD_TOP + PLOTH);
  // The log midpoint (50 * 2^0.5) lands on the plot's MIDDLE — a
  // linear scale would put 75 there.
  const logMid = 50 * Math.SQRT2;
  assert.equal(m.vToY(logMid), PAD_TOP + PLOTH / 2);
  // yToV round-trips INSIDE the plot...
  assert.equal(m.yToV(m.vToY(logMid)), logMid);
  // ...and EXTRAPOLATES past the edges (the drag keeps moving),
  // clamped to the pitch knob range (20..22000 Hz).
  const above = m.yToV(PAD_TOP - 10);
  assert.ok(above > 100, 'past the top extrapolates above the range max');
  const [cLo, cHi] = editorValueRange('pitch');
  assert.equal(m.yToV(PAD_TOP - 100000), cHi, 'hard past the top clamps to the knob max');
  assert.equal(m.yToV(H + 100000), cLo, 'hard past the bottom clamps to the knob min');
});

test('envMaps: the fm-depth value scale is linear over the modulator.index range (editorValueRange)', () => {
  const m = maps('fm depth', FM_POINTS);
  assert.deepEqual([m.vLo, m.vHi], editorValueRange('fm depth'), 'the 0..20 index range');
  assert.equal(m.vToY(20), PAD_TOP);
  assert.equal(m.vToY(0), PAD_TOP + PLOTH);
  assert.equal(m.yToV(PAD_TOP - 100000), 20, 'clamps to the range max');
  assert.equal(m.yToV(H + 100000), 0, 'clamps to the range min');
});

test('envMaps: an unknown kind throws', () => {
  assert.throws(
    () => envMaps({ width: W, height: H, kind: 'sine', points: LEVEL_POINTS, window: null, duration: DURATION }),
    /unknown envelope kind/,
  );
});

// ---- hitTestEnv ---------------------------------------------------------

test('hitTestEnv: a role anchor within HANDLE_RADIUS is found by point index', () => {
  const m = maps('level', LEVEL_POINTS);
  // The sustain anchor (point 4) at (0.305 s, 0): (610, PAD_TOP+PLOTH).
  const x = m.tToX(0.305);
  const y = m.vToY(0);
  assert.deepEqual(hitTestEnv(LEVEL_POINTS, 'level', m, x, y), { type: 'anchor', index: 4 });
  // Slightly off-center but inside the radius: still a hit.
  assert.deepEqual(hitTestEnv(LEVEL_POINTS, 'level', m, x + 3, y - 4), { type: 'anchor', index: 4 });
});

test('hitTestEnv: outside the radius is empty space (null)', () => {
  const m = maps('level', LEVEL_POINTS);
  const x = m.tToX(0.305);
  const y = m.vToY(0);
  // Just beyond the radius on every axis:
  for (const [dx, dy] of [[HANDLE_RADIUS + 2, 0], [-(HANDLE_RADIUS + 2), 0], [0, HANDLE_RADIUS + 2], [0, -(HANDLE_RADIUS + 2)]])
    assert.equal(hitTestEnv(LEVEL_POINTS, 'level', m, x + dx, y + dy), null, `offset (${dx}, ${dy}) is a miss`);
  // Plain empty plot space.
  assert.equal(hitTestEnv(LEVEL_POINTS, 'level', m, 500, 200), null);
});

test('hitTestEnv: a bend dot is found on the curve at the segment midpoint', () => {
  const m = maps('level', LEVEL_POINTS);
  // The decay bend (segment 3, curve 0.55): the dot sits at the
  // segment's midpoint time, at the BENT midpoint value.
  const x = m.tToX((LEVEL_POINTS[3].t + LEVEL_POINTS[4].t) / 2);
  const y = m.vToY(segmentMidValue(LEVEL_POINTS, 3));
  assert.deepEqual(hitTestEnv(LEVEL_POINTS, 'level', m, x, y), { type: 'bend', index: 3 });
});

test('hitTestEnv: an exact distance tie goes to the anchor (anchors are tested first, strict comparison)', () => {
  const m = maps('level', LEVEL_POINTS);
  // The zero-length release segment's bend dot sits EXACTLY on the
  // sustain / release-end anchors (the zero-length-segment rule: the
  // later point's value at the shared time) — the same pixel.
  const x = m.tToX(0.305);
  const y = m.vToY(0);
  assert.deepEqual(hitTestEnv(LEVEL_POINTS, 'level', m, x, y), { type: 'anchor', index: 4 });
});

test('hitTestEnv: the pitch kind offers its two anchors (no bend dots)', () => {
  const m = maps('pitch', PITCH_POINTS);
  assert.deepEqual(
    hitTestEnv(PITCH_POINTS, 'pitch', m, m.tToX(0), m.vToY(100)),
    { type: 'anchor', index: 0 },
  );
  assert.deepEqual(
    hitTestEnv(PITCH_POINTS, 'pitch', m, m.tToX(0.03), m.vToY(50)),
    { type: 'anchor', index: 1 },
  );
  assert.equal(hitTestEnv(PITCH_POINTS, 'pitch', m, 500, 200), null);
});

// ---- dragEnv: the level role anchors ------------------------------------

const paramsOf = (points) => pointsToDahdsr(points);

test('dragEnv (level, anchor 1 — delay end): h -> the delay span (the neighbour stays put); v is pinned (a no-op)', () => {
  // Drag to t = 0.003 (inside the neighbour walls 0 … 0.005): the
  // delay span takes the move, the peak STAYS where it is, so the
  // attack span takes the rest.
  const next = dragEnv(LEVEL_POINTS, 'level', { type: 'anchor', index: 1 }, 0.003, 0.99);
  assert.ok(isCanonicalLevel(next), 'canonical out');
  assert.deepEqual(paramsOf(next), {
    delay: 0.003, attack: 0.005 - 0.003, hold: 0, decay: 0.3, sustain: 0, release: 0,
    attackCurve: 0, decayCurve: 0.55, releaseCurve: 0,
  }, 'h moved the delay span (the attack span took the rest); the pinned v (0.99) changed nothing');
  // The neighbour wall: dragging past the peak pins to it (attack 0).
  const wall = dragEnv(LEVEL_POINTS, 'level', { type: 'anchor', index: 1 }, 0.1, 0);
  assert.equal(paramsOf(wall).delay, 0.005, 'delay clamps at the peak\'s time');
  assert.equal(paramsOf(wall).attack, 0, '... the attack span collapses to 0');
  // A vertical-only wiggle at the same t commits nothing — the SAME
  // reference (the wire handler skips the onEdit).
  assert.equal(dragEnv(LEVEL_POINTS, 'level', { type: 'anchor', index: 1 }, 0, 0.42), LEVEL_POINTS);
});

test('dragEnv (level, anchor 2 — peak): h -> the attack span (the neighbour stays put); v pinned to 1.0', () => {
  // Drag to t = 0.004 (inside the neighbour walls 0 … 0.005): the
  // attack span takes the move, the hold end stays put (the hold span
  // takes the rest). The sustain span is untouched — and the pinned v
  // never touches it.
  const next = dragEnv(LEVEL_POINTS, 'level', { type: 'anchor', index: 2 }, 0.004, 0.1);
  assert.ok(isCanonicalLevel(next));
  assert.deepEqual(paramsOf(next).attack, 0.004 - 0, 'attack = t - delay');
  assert.deepEqual(paramsOf(next).hold, 0.005 - 0.004, 'the hold span took the rest');
  assert.equal(paramsOf(next).decay, 0.3, 'the sustain span is untouched');
  assert.equal(paramsOf(next).sustain, 0, 'the pinned v never touches sustain');
  // Clamped at the start wall: dragging before the delay end (t < 0)
  // pins to it — the span stays >= 0.
  const clamped = dragEnv(LEVEL_POINTS, 'level', { type: 'anchor', index: 2 }, -0.2, 1);
  assert.equal(paramsOf(clamped).attack, 0, 'attack clamps at 0 (the neighbour wall)');
});

test('dragEnv (level, anchor 3 — hold end): h -> the hold span; v pinned to 1.0', () => {
  const next = dragEnv(LEVEL_POINTS, 'level', { type: 'anchor', index: 3 }, 0.03, 0.7);
  assert.ok(isCanonicalLevel(next));
  assert.deepEqual(paramsOf(next).hold, 0.03 - 0.005, 'hold = t - (delay + attack)');
  assert.equal(next[3].v, 1, 'the hold end stays pinned at 1.0');
});

test('dragEnv (level, anchor 4 — sustain): h -> the decay span, v -> the sustain level', () => {
  // Drag to (0.2, 0.5): decay = 0.2 - 0.005, release SHRINKS to
  // 0.305 - 0.2 (the release end stays where its own handle is),
  // sustain = 0.5.
  const next = dragEnv(LEVEL_POINTS, 'level', { type: 'anchor', index: 4 }, 0.2, 0.5);
  assert.ok(isCanonicalLevel(next));
  assert.deepEqual(paramsOf(next), {
    delay: 0, attack: 0.005, hold: 0, decay: 0.2 - 0.005, sustain: 0.5,
    release: 0.305 - 0.2, attackCurve: 0, decayCurve: 0.55, releaseCurve: 0,
  }, 'h moved the decay span (the release span took the rest); v set the sustain');
  assert.equal(next[4].t, 0.2, 'the sustain point sits at the dragged time');
  assert.equal(next[5].t, 0.305, 'the release end is unmoved (its handle was not dragged)');
  // v clamps to the sustain range 0..1.
  assert.equal(paramsOf(dragEnv(LEVEL_POINTS, 'level', { type: 'anchor', index: 4 }, 0.2, 2)).sustain, 1);
  assert.equal(paramsOf(dragEnv(LEVEL_POINTS, 'level', { type: 'anchor', index: 4 }, 0.2, -1)).sustain, 0);
});

test('dragEnv (level, anchor 5 — release end): h -> the release span; v pinned to 0', () => {
  const next = dragEnv(LEVEL_POINTS, 'level', { type: 'anchor', index: 5 }, 0.5, 0.8);
  assert.ok(isCanonicalLevel(next));
  assert.deepEqual(paramsOf(next).release, 0.5 - 0.305, 'release = t - the sustain time');
  assert.equal(next[5].v, 0, 'the release end stays pinned at 0');
  // The knob span max: a drag past 1.5 s pins the span at the max.
  const maxed = dragEnv(LEVEL_POINTS, 'level', { type: 'anchor', index: 5 }, 10, 0);
  assert.equal(paramsOf(maxed).release, 1.5, 'release clamps to the knob max (1.5 s)');
  // The neighbour wall: dragging left of the sustain end pins to it.
  const clamped = dragEnv(LEVEL_POINTS, 'level', { type: 'anchor', index: 5 }, 0.1, 0);
  assert.equal(paramsOf(clamped).release, 0, 'release clamps at 0 (the neighbour wall)');
});

test('dragEnv (level, anchor 0 — the start) is fixed: any drag is a no-op', () => {
  assert.equal(dragEnv(LEVEL_POINTS, 'level', { type: 'anchor', index: 0 }, 0.5, 0.5), LEVEL_POINTS);
});

test('dragEnv (level): both adjacent spans stay within the knob max (a > 1.5 s gap keeps a legal T interval)', () => {
  // A gap of 2 s between the hold end (0.5) and the release end (2.5):
  // decay 1.0 + release 1.0. The sustain anchor can only reach the
  // intersection of the two 1.5 s windows: [2.5 - 1.5, 0.5 + 1.5]
  // = [1.0, 2.0].
  const gap = dahdsrToPoints({
    delay: 0, attack: 0, hold: 0.5, decay: 1.0, sustain: 0.2,
    release: 1.0, decayCurve: 0,
  });
  const next = dragEnv(gap, 'level', { type: 'anchor', index: 4 }, 2.4, 0.2);
  assert.ok(isCanonicalLevel(next));
  assert.equal(paramsOf(next).decay, 1.5, 'decay clamps at its knob max');
  assert.equal(paramsOf(next).release, 0.5, '... so the release span took the rest');
});

test('dragEnv (level): every result is canonical (the no-split-brain contract)', () => {
  for (const index of [1, 2, 3, 4, 5])
    for (const t of [-1, 0, 0.005, 0.1, 0.305, 0.9, 10]) {
      const next = dragEnv(LEVEL_POINTS, 'level', { type: 'anchor', index }, t, 0.5);
      assert.ok(isCanonicalLevel(next), `anchor ${index} @ t=${t}`);
      const p = paramsOf(next);
      for (const k of ['delay', 'attack', 'hold', 'decay', 'release'])
        assert.ok(p[k] >= 0 && p[k] <= 1.5, `anchor ${index} @ t=${t}: span ${k} = ${p[k]} in [0, 1.5]`);
    }
});

// ---- dragEnv: the level bend dots ---------------------------------------

test('dragEnv (level, bend dot): v-only, through midValueToCurve — the curve key appears / changes / drops', () => {
  // Drag the decay dot (segment 3) to the CURRENT midpoint value: k is
  // unchanged -> the SAME reference (no commit).
  const midV = segmentMidValue(LEVEL_POINTS, 3);
  assert.equal(dragEnv(LEVEL_POINTS, 'level', { type: 'bend', index: 3 }, 100, midV), LEVEL_POINTS);

  // Drag to the chord midpoint (the k = 0 value): the curve key DROPS.
  const chordMid = (LEVEL_POINTS[3].v + LEVEL_POINTS[4].v) / 2;
  const flat = dragEnv(LEVEL_POINTS, 'level', { type: 'bend', index: 3 }, 100, chordMid);
  assert.notEqual(flat, LEVEL_POINTS);
  assert.ok(!('curve' in flat[3]), 'the curve key is dropped at k = 0 (absent = linear)');
  assert.deepEqual(flat[3], { t: 0.005, v: 1 }, 'the point itself is untouched (v-only drag)');
  assert.deepEqual(flat[4], LEVEL_POINTS[4], 'the segment end is untouched');

  // Drag below the chord midpoint: k reappears at midValueToCurve's
  // value (the bisection inverse — bit-exact through the same call).
  const target = 0.25;
  const bent = dragEnv(LEVEL_POINTS, 'level', { type: 'bend', index: 3 }, 100, target);
  const expectedK = midValueToCurve(LEVEL_POINTS, 3, target);
  assert.ok(expectedK > 0 && expectedK <= 1, 'a midValueToCurve k in (0, 1]');
  assert.equal(bent[3].curve, expectedK, 'the curve field holds the dragged k');
  // The round trip: the dot\'s new midpoint value IS the target (the
  // bisection lands within ~1e-12 — the k-space tolerance).
  assert.ok(Math.abs(segmentMidValue(bent, 3) - target) < 1e-12, 'midpoint value -> k -> midpoint value');

  // The k = 1 bound: a target at or below the maximally-bent midpoint.
  const maxed = dragEnv(LEVEL_POINTS, 'level', { type: 'bend', index: 3 }, 100, 0);
  assert.equal(maxed[3].curve, 1, 'the lower bound is k = 1');
});

test('dragEnv (level, bend dot): horizontal movement is a no-op (vertical only)', () => {
  const midV = segmentMidValue(LEVEL_POINTS, 3);
  // The SAME v at a different t: unchanged.
  assert.equal(
    dragEnv(LEVEL_POINTS, 'level', { type: 'bend', index: 3 }, 500, midV),
    LEVEL_POINTS,
    't is ignored for a bend dot',
  );
});

test('dragEnv (level, bend dot): a non-bend segment index is a no-op', () => {
  assert.equal(
    dragEnv(LEVEL_POINTS, 'level', { type: 'bend', index: 2 }, 100, 0.2),
    LEVEL_POINTS,
    'segment 2 has no curve field (the bends are 1 / 3 / 4)',
  );
});

// ---- dragEnv: pitch ------------------------------------------------------

test('dragEnv (pitch, anchor 0 — start): v -> the from Hz (the t stays fixed at 0)', () => {
  const next = dragEnv(PITCH_POINTS, 'pitch', { type: 'anchor', index: 0 }, 99, 200);
  assert.deepEqual(next, [{ t: 0, v: 200 }, { t: 0.03, v: 50 }], 'v-only: the t stays 0, the end is untouched');
  // The v clamps to the pitch knob range (20..22000 Hz).
  assert.equal(dragEnv(PITCH_POINTS, 'pitch', { type: 'anchor', index: 0 }, 0, 10)[0].v, 20);
  assert.equal(dragEnv(PITCH_POINTS, 'pitch', { type: 'anchor', index: 0 }, 0, 999999)[0].v, 22000);
  // An unchanged v commits nothing.
  assert.equal(dragEnv(PITCH_POINTS, 'pitch', { type: 'anchor', index: 0 }, 0, 100), PITCH_POINTS);
});

test('dragEnv (pitch, anchor 1 — end): h -> the time, v -> the to Hz (the knob-range clamps)', () => {
  const next = dragEnv(PITCH_POINTS, 'pitch', { type: 'anchor', index: 1 }, 0.2, 80);
  assert.deepEqual(next, [{ t: 0, v: 100 }, { t: 0.2, v: 80 }], 'h + v: the start is untouched');
  // t clamps to the envelope-time knob range (0.0005..1.5 s).
  assert.equal(dragEnv(PITCH_POINTS, 'pitch', { type: 'anchor', index: 1 }, 0.0001, 50)[1].t, 0.0005);
  assert.equal(dragEnv(PITCH_POINTS, 'pitch', { type: 'anchor', index: 1 }, 10, 50)[1].t, 1.5);
  // v clamps to 20..22000 Hz.
  assert.equal(dragEnv(PITCH_POINTS, 'pitch', { type: 'anchor', index: 1 }, 0.2, 10)[1].v, 20);
  assert.equal(dragEnv(PITCH_POINTS, 'pitch', { type: 'anchor', index: 1 }, 0.2, 999999)[1].v, 22000);
  // An unchanged (t, v) commits nothing.
  assert.equal(dragEnv(PITCH_POINTS, 'pitch', { type: 'anchor', index: 1 }, 0.03, 50), PITCH_POINTS);
});

test('dragEnv (pitch): the result is always the canonical 2-point form', () => {
  const next = dragEnv(PITCH_POINTS, 'pitch', { type: 'anchor', index: 1 }, 0.9, 12000);
  assert.equal(next.length, 2);
  assert.equal(next[0].t, 0);
  assert.ok(next[0].v > 0 && next[1].v > 0 && next[1].t > 0, 'finite, positive, sorted');
});

// ---- dragEnv: fm depth ----------------------------------------------------

test('dragEnv (fm depth): the 2-anchor shape over the modulator.index range (0..20)', () => {
  const next = dragEnv(FM_POINTS, 'fm depth', { type: 'anchor', index: 1 }, 0.05, 12);
  assert.deepEqual(next, [{ t: 0, v: 8 }, { t: 0.05, v: 12 }]);
  assert.equal(dragEnv(FM_POINTS, 'fm depth', { type: 'anchor', index: 0 }, 0, 25)[0].v, 20, 'clamps at the index max');
  assert.equal(dragEnv(FM_POINTS, 'fm depth', { type: 'anchor', index: 1 }, 0.05, -3)[1].v, 0, 'clamps at the index min');
  assert.equal(dragEnv(FM_POINTS, 'fm depth', { type: 'anchor', index: 1 }, 0.0001, 12)[1].t, 0.0005, 'the time clamps at the knob min');
  // No bends for fm depth: a bend hit is a no-op.
  assert.equal(dragEnv(FM_POINTS, 'fm depth', { type: 'bend', index: 0 }, 0, 5), FM_POINTS);
});

test('dragEnv: an unknown kind throws', () => {
  assert.throws(
    () => dragEnv(LEVEL_POINTS, 'sine', { type: 'anchor', index: 1 }, 0.1, 0),
    /unknown envelope kind/,
  );
});

// ---- dragEnv: legacy data is adopted on the edit path ---------------------

test('dragEnv (level): a legacy (non-canonical) levelEnv is adopted before the drag (the P3/S2 knob-funnel precedent)', () => {
  // A free-form 4-point legacy shape (the pre-canonical form).
  const legacy = [
    { t: 0, v: 0 },
    { t: 0.01, v: 1 },
    { t: 0.15, v: 0.3 },
    { t: 0.4, v: 0 },
  ];
  const next = dragEnv(legacy, 'level', { type: 'anchor', index: 4 }, 0.2, 0.5);
  assert.ok(isCanonicalLevel(next), 'the drag result is canonical — the legacy data was adopted');
  assert.equal(paramsOf(next).sustain, 0.5, 'the dragged sustain is held');
});

// ---- drawEnv ---------------------------------------------------------------

test('drawEnv (level): the background, the ms axis, the fixed 0..1 labels, 6 anchors + 3 bend dots, the gradient fill, the halo', () => {
  const canvas = makeCanvas(W, H);
  drawEnv(canvas, {
    kind: 'level', points: LEVEL_POINTS, window: null,
    duration: DURATION, color: THEME.accent,
  });
  const ctx = canvas.getContext('2d');
  // The background fill (the whole canvas).
  assert.ok(ctx.calls.some(([m, x, y, w, h]) => m === 'fillRect' && x === 0 && y === 0 && w === W && h === H));
  // The ms axis: the last tick carries the unit (500 ms drum, step
  // 100 -> the last tick is 400).
  assert.ok(ctx.calls.some(([m, t]) => m === 'fillText' && t === '400 ms'), 'the axis\'s last tick carries the unit');
  // The fixed 0..1 value labels (top-left / bottom-left).
  const labels = ctx.calls.filter(([m, t, x]) => m === 'fillText' && x === 4).map(([, t]) => t);
  assert.deepEqual(labels, ['1', '0']);
  // The curve stroke (2 px, the trace hue) and the area gradient.
  const curve = ctx.strokes.find((s) => s.lineWidth === 2);
  assert.ok(curve, 'the 2 px curve stroke');
  assert.equal(curve.strokeStyle, THEME.accent);
  assert.equal(ctx.gradients.length, 1, 'one gradient (the area fill)');
  // 9 arcs: the 6 role anchors + the 3 bend dots.
  const arcs = ctx.calls.filter(([m]) => m === 'arc');
  assert.equal(arcs.length, 9);
  // The anchors at the canonical points.
  assert.deepEqual(
    arcs.slice(0, 6).map(([m, x, y]) => [x, y]),
    LEVEL_POINTS.map((p) => [tToX(p.t), vToY(p.v)]),
  );
  // The bend dots on the curve at the segment midpoints.
  assert.deepEqual(
    arcs.slice(6).map(([m, x, y]) => [x, y]),
    [1, 3, 4].map((i) => [tToX((LEVEL_POINTS[i].t + LEVEL_POINTS[i + 1].t) / 2), vToY(segmentMidValue(LEVEL_POINTS, i))]),
  );
  // The halo: shadowBlur 4 around the anchor loop, 0 after.
  const blurSets = ctx.calls.map(([k, v]) => (k === 'shadowBlur' ? v : null)).filter((v) => v !== null);
  assert.deepEqual(blurSets, [4, 0]);
});

test('drawEnv (level, windowed): the axis ticks are the ABSOLUTE times of the window (drawAxis\'s start offset)', () => {
  const canvas = makeCanvas(W, H);
  drawEnv(canvas, {
    kind: 'level', points: LEVEL_POINTS,
    window: { t0: 0.1, span: 0.2 },
    duration: DURATION, color: THEME.accent,
  });
  const ctx = canvas.getContext('2d');
  // 200 ms window: step 25 -> the ticks at 100, 125, 150, 175 ms
  // (the absolute grid, not the relative 0, 25, ...). The axis labels
  // sit at y = H - 6 (the value labels are at the plot's left edge).
  // 200 ms window [100, 300): step 25 -> the grid at 100, 125, ..., 275
  // (the absolute grid, not the relative 0, 25, ...). The axis labels
  // sit at y = H - 6 (the value labels are at the plot's left edge).
  const axisLabels = ctx.calls.filter(([m, t, x, y]) => m === 'fillText' && y === H - 6).map(([, t]) => t);
  assert.deepEqual(axisLabels, ['100', '125', '150', '175', '200', '225', '250', '275 ms'],
    'the window\'s absolute tick grid (last tick carries the unit)');
  // The x-position: each tick sits at its OFFSET from the window start
  // (rel / range * W) — the 100 ms tick is the window's LEFT edge, not
  // the plot's middle (the start-offset regression: x = v/range would
  // put it at 0.5 W). Labels sit at y = H - 6.
  const axisPos = ctx.calls.filter(([m, t, x, y]) => m === 'fillText' && y === H - 6).map(([, t, x]) => [t, x]);
  assert.deepEqual(
    axisPos,
    ['100', '125', '150', '175', '200', '225', '250', '275 ms']
      .map((t, i) => [t, Math.round((i * 25 / 200) * W) + 0.5]),
    'each tick x is the offset from the window start (the 100 ms tick is the left edge)',
  );
});

test('drawAxis: the start offset runs the grid from the first multiple at/after start (FP-robust)', () => {
  const g = {
    calls: [],
    fillText: (...a) => g.calls.push(['fillText', ...a]),
    stroke: () => g.calls.push(['stroke']),
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
    font: '', lineWidth: 0, strokeStyle: '', fillStyle: '', textAlign: '',
  };
  // A panned window: start = 100 ms, range = 200 ms, step 25 -> the
  // grid is 100, 125, 150, 175 (the 100 ms tick at the window start is
  // NOT rounded out by the FP of start/step).
  drawAxis(g, 1000, 400, 200, [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000], 'ms', String, 100);
  assert.deepEqual(
    g.calls.filter(([m]) => m === 'fillText').map(([, t]) => t),
    ['100', '125', '150', '175', '200', '225', '250', '275 ms'],
    'the absolute grid from the window start to (not including) the window end',
  );
  // start = 0 is unchanged (every pre-existing caller): the grid runs
  // from 0 exactly as before.
  const g0 = {
    calls: [],
    fillText: (...a) => g0.calls.push(['fillText', ...a]),
    stroke: () => g0.calls.push(['stroke']),
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {},
    font: '', lineWidth: 0, strokeStyle: '', fillStyle: '', textAlign: '',
  };
  drawAxis(g0, 1000, 400, 200, [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000], 'ms', String);
  assert.deepEqual(
    g0.calls.filter(([m]) => m === 'fillText').map(([, t]) => t),
    ['0', '25', '50', '75', '100', '125', '150', '175 ms'],
    'start = 0 (the default) runs from 0 — the existing callers are unchanged',
  );
});

test('drawEnv (pitch): the two anchors, the note edge labels, the per-anchor note labels (no bend dots)', () => {
  const canvas = makeCanvas(W, H);
  drawEnv(canvas, {
    kind: 'pitch', points: PITCH_POINTS, window: null,
    duration: DURATION, color: THEME.accent,
  });
  const ctx = canvas.getContext('2d');
  const arcs = ctx.calls.filter(([m]) => m === 'arc');
  assert.equal(arcs.length, 2, 'two anchors, no bend dots');
  const m = maps('pitch', PITCH_POINTS);
  assert.deepEqual(
    arcs.map(([mn, x, y]) => [x, y]),
    [[0, PAD_TOP], [m.tToX(0.03), PAD_TOP + PLOTH]],
  );
  // Note names at the range bounds AND at each anchor.
  for (const note of [hzToNoteName(100), hzToNoteName(50)]) {
    const count = ctx.calls.filter(([mn, t]) => mn === 'fillText' && t === note).length;
    assert.ok(count >= 2, `the note ${note} is painted at its edge and its anchor`);
  }
});

test('drawEnv: the optional playhead line (drawPlayhead) overlays the plot', () => {
  const canvas = makeCanvas(W, H);
  drawEnv(canvas, {
    kind: 'level', points: LEVEL_POINTS, window: null,
    duration: DURATION, color: THEME.accent, playheadX: 250,
  });
  const ctx = canvas.getContext('2d');
  const line = ctx.strokes.find((s) => s.strokeStyle === COLORS.playhead);
  assert.ok(line, 'the playhead line is stroked');
  assert.deepEqual(line.pts, [
    { x: 250.5, y: PAD_TOP },
    { x: 250.5, y: H - PAD_BOTTOM },
  ], 'the vertical line at the given x (half-pixel aligned)');
  // Outside the plot: no line.
  const canvas2 = makeCanvas(W, H);
  drawEnv(canvas2, {
    kind: 'level', points: LEVEL_POINTS, window: null,
    duration: DURATION, color: THEME.accent, playheadX: W + 5,
  });
  assert.ok(!canvas2.getContext('2d').strokes.some((s) => s.strokeStyle === COLORS.playhead), 'past the end: no line');
});

test('drawEnv: an unknown kind throws; the color falls back to the theme accent', () => {
  const canvas = makeCanvas(W, H);
  assert.throws(
    () => drawEnv(canvas, { kind: 'sine', points: LEVEL_POINTS, window: null, duration: DURATION }),
    /unknown envelope kind/,
  );
  const canvas2 = makeCanvas(W, H);
  drawEnv(canvas2, { kind: 'level', points: LEVEL_POINTS, window: null, duration: DURATION });
  const curve = canvas2.getContext('2d').strokes.find((s) => s.lineWidth === 2);
  assert.equal(curve.strokeStyle, THEME.accent, 'no color: the accent fallback');
});

// ---- wireEnvEditor -----------------------------------------------------------

test('wireEnvEditor (displayOnly): NO pointer listeners; redraw paints from the patch', () => {
  const drum = makeDrum();
  const canvas = makeCanvas(320, 120);
  const wire = wireEnvEditor(canvas, {
    getDrum: () => drum,
    getKind: () => ({ kind: 'level', path: 'layers.0.levelEnv' }),
    displayOnly: true,
  });
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
    assert.equal(canvas.listeners[type], undefined, `no ${type} listener in displayOnly mode`);
  wire.redraw();
  const ctx = canvas.getContext('2d');
  assert.ok(ctx.calls.some(([m, x, y, w, h]) => m === 'fillRect' && w === 320 && h === 120), 'the redraw painted the plot');
  assert.equal(ctx.calls.filter(([m]) => m === 'arc').length, 9, 'the 6 anchors + 3 dots from the live patch');
});

test('wireEnvEditor: a press-drag on an anchor commits the dragEnv array through onEdit (the live-patch contract)', () => {
  const drum = makeDrum();
  const canvas = makeCanvas(W, H);
  const edits = [];
  const wire = wireEnvEditor(canvas, {
    getDrum: () => drum,
    getKind: () => ({ kind: 'level', path: 'layers.0.levelEnv' }),
    onEdit: (points) => edits.push(points),
  });
  wire.redraw();

  // Grab the sustain anchor at its handle (0.305 s, v 0) and drag to
  // (0.2 s, v 0.5) — the same geometry as the plan's reference drag.
  const m = maps('level', drum.patch.layers[0].levelEnv);
  press(canvas, m.tToX(0.305), m.vToY(0));
  assert.equal(canvas.capturedPointers.length, 1, 'the gesture captured the pointer');
  move(canvas, m.tToX(0.2), m.vToY(0.5));
  assert.equal(edits.length, 1, 'one commit per effective move');
  assert.ok(isCanonicalLevel(edits[0]), 'the committed array is canonical');
  assert.deepEqual(paramsOf(edits[0]), {
    delay: 0, attack: 0.005, hold: 0, decay: 0.2 - 0.005, sustain: 0.5,
    release: 0.305 - 0.2, attackCurve: 0, decayCurve: 0.55, releaseCurve: 0,
  });
  // The wire handler repaints from the patch after the commit.
  const n = canvas.getContext('2d').calls.length;
  move(canvas, m.tToX(0.25), m.vToY(0.5));
  assert.equal(edits.length, 2, 'the second move committed too');
  assert.ok(canvas.getContext('2d').calls.length > n, 'the plot repainted');
  release(canvas, m.tToX(0.25), m.vToY(0.5));
  assert.equal(wire.state.hit, null, 'the release ends the gesture');

  // A press on EMPTY space drags nothing (no onWindow: no pan either).
  edits.length = 0;
  press(canvas, 500, 200);
  move(canvas, 550, 250);
  release(canvas, 550, 250);
  assert.equal(edits.length, 0, 'empty space: no edit, no pan');
});

test('wireEnvEditor: a drag on a bend dot commits the curve change', () => {
  const drum = makeDrum();
  const canvas = makeCanvas(W, H);
  const edits = [];
  const wire = wireEnvEditor(canvas, {
    getDrum: () => drum,
    getKind: () => ({ kind: 'level', path: 'layers.0.levelEnv' }),
    onEdit: (points) => {
      edits.push(points);
      drum.patch.layers[0].levelEnv = points; // the caller\'s setPath
    },
  });
  wire.redraw();
  const m = maps('level', drum.patch.layers[0].levelEnv);
  const midV = segmentMidValue(drum.patch.layers[0].levelEnv, 3);
  press(canvas, m.tToX(0.155), m.vToY(midV));
  assert.deepEqual(wire.state.hit, { type: 'bend', index: 3 }, 'the press hit the decay bend dot');
  move(canvas, m.tToX(0.155), m.vToY(0.25));
  assert.equal(edits.length, 1);
  const expectedK = midValueToCurve(drum.patch.layers[0].levelEnv, 3, 0.25);
  assert.equal(drum.patch.layers[0].levelEnv[3].curve, expectedK, 'the curve field holds the dragged k');
  release(canvas, m.tToX(0.155), m.vToY(0.25));
});

test('wireEnvEditor: an empty-space drag PANS the window (onWindow), the CLICK_SLOP separates pan from click', () => {
  const drum = makeDrum();
  const canvas = makeCanvas(W, H);
  const windows = [];
  const wire = wireEnvEditor(canvas, {
    getDrum: () => drum,
    getKind: () => ({ kind: 'level', path: 'layers.0.levelEnv' }),
    getWindow: () => ({ t0: 0.1, span: 0.2 }),
    onWindow: (w) => windows.push(w),
  });
  wire.redraw();

  // A press on empty space, moved past the slop: the CONTENT follows
  // the pointer (the map-pan convention) — dragging the plot LEFT by
  // 10 px moves the window FORWARD in time by 10 px in window time.
  press(canvas, 500, 200);
  move(canvas, 490, 200); // 10 px > CLICK_SLOP (4) -> the pan starts
  assert.ok(windows.length >= 1, 'the pan committed a new window');
  const dt = 10 / W * 0.2;
  assert.deepEqual(windows[windows.length - 1], { t0: 0.1 + dt, span: 0.2 }, 't0 moved with the pointer, span unchanged');

  // The pan clamps at the drum's edges: drag far to the LEFT (the
  // content follows the pointer -> the window would start past the
  // drum end) -> t0 pins so the window ends at the drum end.
  move(canvas, -10000, 200);
  let last = windows[windows.length - 1];
  assert.equal(last.t0 + last.span, DURATION, 't0 is clamped so the window ends at the drum end');
  // ... and far to the RIGHT -> the window would start before the drum
  // start -> t0 pins at 0.
  move(canvas, 10000, 200);
  last = windows[windows.length - 1];
  assert.equal(last.t0, 0, 't0 is clamped at the drum start');

  release(canvas, 10000, 200);
  assert.equal(wire.state.hit, null);

  // A press that STAYS inside the slop is a plain click: no pan.
  windows.length = 0;
  press(canvas, 500, 200);
  move(canvas, 502, 201); // ~2.2 px < the slop
  release(canvas, 502, 201);
  assert.equal(windows.length, 0, 'a still press is a click, not a pan');
});

test('wireEnvEditor: the hover cursor — grab on a handle, move on empty (pannable), crosshair on empty (not)', () => {
  const drum = makeDrum();
  const withPan = makeCanvas(W, H);
  wireEnvEditor(withPan, {
    getDrum: () => drum,
    getKind: () => ({ kind: 'level', path: 'layers.0.levelEnv' }),
    onWindow: () => {},
  });
  const m = maps('level', drum.patch.layers[0].levelEnv);
  move(withPan, m.tToX(0.305), m.vToY(0));
  assert.equal(withPan.style.cursor, 'grab', 'over the handle: grab');
  move(withPan, 500, 200);
  assert.equal(withPan.style.cursor, 'move', 'over empty space (pannable): move');

  const noPan = makeCanvas(W, H);
  wireEnvEditor(noPan, {
    getDrum: () => drum,
    getKind: () => ({ kind: 'level', path: 'layers.0.levelEnv' }),
  });
  move(noPan, 500, 200);
  assert.equal(noPan.style.cursor, 'crosshair', 'over empty space (not pannable): crosshair');
});

test('wireEnvEditor: a pitch drag through the frozen maps keeps the start anchor at t = 0 (v-only) and clamps to the knob ranges', () => {
  const drum = makeDrum();
  const canvas = makeCanvas(W, H);
  const edits = [];
  const wire = wireEnvEditor(canvas, {
    getDrum: () => drum,
    getKind: () => ({ kind: 'pitch', path: 'layers.0.pitchEnv' }),
    onEdit: (points) => {
      edits.push(points);
      drum.patch.layers[0].pitchEnv = points; // the caller's setPath
    },
  });
  wire.redraw();
  // Drag the start anchor (100 Hz, the top-left) hard up-right: the t
  // must STAY 0 (the start is fixed); the v extrapolates the log scale
  // past the plot top (the frozen [50, 100] map — one octave over),
  // and hard past the top it clamps to the knob max (22000 Hz).
  const m = maps('pitch', drum.patch.layers[0].pitchEnv);
  press(canvas, 0, m.vToY(100));
  assert.deepEqual(wire.state.hit, { type: 'anchor', index: 0 });
  move(canvas, 300, -50);
  assert.equal(edits.length, 1);
  assert.equal(edits[0][0].t, 0, 'the start anchor stays at t = 0');
  assert.ok(edits[0][0].v > 100, 'the v extrapolates past the range max (the drag keeps moving)');
  move(canvas, 300, -4000);
  assert.equal(edits[1][0].v, 22000, 'hard past the top: the v clamps to the knob max');
  release(canvas, 300, -4000);
  // Drag the end anchor to the window's right edge: the time lands on
  // the drum end (0.5 s — inside the knob range, so no clamp). The
  // knob-max clamp itself (a window past 1.5 s on a long drum) is
  // covered by dragEnv's direct tests. (edits[2]: the first drag
  // committed twice — the extrapolating move and the clamping move.)
  press(canvas, m.tToX(0.03), m.vToY(50));
  move(canvas, W, 200);
  assert.equal(edits[2][1].t, 0.5, 'the end time lands on the window edge');
  assert.equal(edits[2][0].v, 22000, 'the start (first drag) is untouched by this one');
  release(canvas, W, 200);
});
