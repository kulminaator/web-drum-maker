// src/app/env-editor.js
//
// The shared CONSTRAINED-ENVELOPE canvas core (plan "dahdsr" P4/S1).
//
// One canvas drawing + hit-test + drag core serves every envelope kind
// the app can edit:
//
//   - `level`    — the DAHDSR 6-point form: six role anchors (start
//                  fixed; delay end h->delay, v pinned 0; peak h->attack,
//                  v pinned 1.0; hold end h->hold, v pinned 1.0; sustain
//                  h->decay AND v->sustain; release end h->release, v
//                  pinned 0) plus the three bend segments (attack /
//                  decay / release — the `curve` field on points 1 / 3 /
//                  4) drawn as smaller hollow dots ON THE CURVE at each
//                  segment's midpoint. Value scale fixed 0..1 with value
//                  labels.
//   - `pitch`    — 2 anchors (start: v->from Hz, t fixed 0; end:
//                  h->time AND v->to Hz), no bends, log-Hz scale with
//                  note labels — reusing band.js's pure scale/label
//                  exports (logYScale, bandHzRange, hzToNoteName).
//   - `fm depth` — the same 2-anchor shape, linear scale over the
//                  modulator.index range (editorValueRange precedent).
//
// The canvas can ONLY ever produce a shape the DAHDSR knobs can name
// (the no-split-brain rule): a drag maps the pointer to (t, v) through
// the pixel maps and calls the PURE `dragEnv`, which returns a new
// canonical array — for `level` it updates the role's span (and
// sustain) and re-derives all six points with dahdsrToPoints, so the
// live-patch contract (one atomic whole-array write per edit) holds
// exactly like a knob turn. Clamps come from the knob ranges
// themselves (LEVEL_POINT_TIME_RANGE / ENVELOPE_TIME_RANGE /
// editorValueRange) — the canvas and the knobs can never disagree.
//
// The TIME WINDOW: `envMaps` accepts an optional `{t0, span}` window —
// null/absent means the full [0, duration]. The card preview draws at
// the full span; the modal (src/app/env-modal.js) zooms (span halved /
// doubled, 10 ms floor, full-span ceiling) and pans (empty-space drag
// moves t0). The curve is densely sampled through the facade's
// envelopeValue over the visible window, so bend shapes and the flat
// clamp legs at the window edges come for free — the UI never
// re-derives the math. PAD_TOP / PAD_BOTTOM + drawAxis (viz.js) are
// shared with the band, so the plot lines up with it.
//
// Layering: pure math (envMaps / hitTestEnv / dragEnv) + two I/O
// boundaries — `drawEnv` (canvas 2D context, the band.js pattern) and
// `wireEnvEditor` (pointer handlers; displayOnly mode attaches none).
// Import surface: facade, band.js, dahdsr.js, controls.js, knob.js,
// viz.js, theme.js — all app-tier (no facade change).

import { clamp, envelopeValue, getPath } from '../lib/index.js';
import {
  BAND_CURVE_SAMPLES,
  bandHzRange,
  hzToNoteName,
  logYScale,
} from './band.js';
import {
  ENVELOPE_TIME_RANGE,
  LEVEL_POINT_TIME_RANGE,
  editorValueRange,
} from './controls.js';
import {
  dahdsrToPoints,
  midValueToCurve,
  normalizeIndexEnv,
  normalizeLevelEnv,
  normalizePitchEnv,
  pointsToDahdsr,
  segmentMidValue,
} from './dahdsr.js';
import { formatKnobValue } from './knob.js';
import { THEME } from './theme.js';
import {
  COLORS,
  PAD_BOTTOM,
  PAD_TOP,
  drawAxis,
  drawPlayhead,
  withAlpha,
} from './viz.js';

// The pointer hit radius (canvas px) for anchors and bend dots, and the
// press-movement slop that separates a pan (modal) from a plain click.
export const HANDLE_RADIUS = 8;
export const CLICK_SLOP = 4;

// The level role anchors, by point index: the start anchor is fixed
// (t = 0, v = 0 — never draggable), each other anchor's h maps to the
// span that ENDS at it (and its pinned / editable v).
const LEVEL_ANCHORS = [
  { point: 0, fixed: true },
  { point: 1, param: 'delay' },
  { point: 2, param: 'attack' },
  { point: 3, param: 'hold' },
  { point: 4, param: 'decay', vParam: 'sustain' },
  { point: 5, param: 'release' },
];
// The level bend segments: the `curve` field on points 1 (attack), 3
// (decay) and 4 (release) — the DAHDSR three (BEND_SEGMENTS).
const LEVEL_BENDS = [1, 3, 4];

// The pitch / fm-depth anchors: the start is v-only (from, t fixed 0),
// the end is h->time AND v->to.
const TWO_POINT_ANCHORS = [
  { point: 0, fixedT: true },
  { point: 1 },
];

// One config per kind: the anchors, the bend segments, the knob-range
// clamps (time = the span/time knob range, value = the editorValueRange
// the knobs show), the canonical pass-through (a canonical input comes
// back by reference — legacy data is adopted on the edit path, the
// P3/S2 knob-funnel precedent), and the value scale.
export const KINDS = {
  level: {
    anchors: LEVEL_ANCHORS,
    bends: LEVEL_BENDS,
    timeRange: [LEVEL_POINT_TIME_RANGE.min, LEVEL_POINT_TIME_RANGE.max],
    valueRange: editorValueRange('level'),
    normalize: normalizeLevelEnv,
    scale: 'linear',
  },
  pitch: {
    anchors: TWO_POINT_ANCHORS,
    bends: [],
    timeRange: [ENVELOPE_TIME_RANGE.min, ENVELOPE_TIME_RANGE.max],
    valueRange: editorValueRange('pitch'),
    normalize: normalizePitchEnv,
    scale: 'logHz',
  },
  'fm depth': {
    anchors: TWO_POINT_ANCHORS,
    bends: [],
    timeRange: [ENVELOPE_TIME_RANGE.min, ENVELOPE_TIME_RANGE.max],
    valueRange: editorValueRange('fm depth'),
    normalize: normalizeIndexEnv,
    scale: 'linear',
  },
};

// The kind's canonical view of a raw points array: the normalizer is a
// reference pass-through for canonical input, so the common case costs
// nothing; a legacy (non-canonical) array is adopted here, on the edit
// path — the preview and the modal can only ever draw / drag the
// canonical shape.
export const kindPoints = (kind, points) => {
  const cfg = KINDS[kind];
  if (!cfg)
    throw new Error(
      `env-editor: unknown envelope kind ${JSON.stringify(kind)} (expected "level" / "pitch" / "fm depth")`,
    );
  return cfg.normalize(points);
};

// The pixel <-> model maps for one kind at one window.
//
//   envMaps({ width, height, kind, points, window, duration }) ->
//     { t0, span, plotH, vLo, vHi, tToX, xToT, vToY, yToV }
//
// `window` is {t0, span} in seconds, or null/absent for the full
// [0, duration]; it is clamped to the drum (span <= duration,
// 0 <= t0 <= duration - span) so a stale window can never draw outside
// the drum. `points` is the kind's canonical view (kindPoints).
//
// Time: linear over the window — tToX clamps to [0, W], xToT clamps to
// [t0, t0 + span]. Value: `level` is linear over the fixed 0..1,
// `fm depth` linear over the modulator.index range, `pitch` log-Hz over
// the env's OWN Hz range (bandHzRange — the two endpoints, octave
// expanded when degenerate) so the curve always fills the plot; yToV
// extrapolates past the plot edges and clamps to the kind's knob range
// (editorValueRange), so a drag past the edge keeps moving the value
// within what the knob can show.
export const envMaps = ({ width, height, kind, points, window, duration }) => {
  const W = width;
  const plotH = height - PAD_TOP - PAD_BOTTOM;
  const cfg = KINDS[kind];
  if (!cfg)
    throw new Error(
      `env-editor: unknown envelope kind ${JSON.stringify(kind)}`,
    );
  const w = window ?? { t0: 0, span: duration };
  const span = clamp(w.span, 1e-9, duration);
  const t0 = clamp(w.t0, 0, duration - span);

  let vToY, yToV, vLo, vHi;
  if (cfg.scale === 'logHz') {
    // The plot fits the env's own range (bandHzRange — the same helper
    // the band uses for its full-curve range); the log mapping is
    // band.js's logYScale (plot-relative, PAD_TOP added below).
    [vLo, vHi] = bandHzRange([{ points: points.map((p) => p.v) }]);
    const { toY } = logYScale(vLo, vHi, plotH);
    vToY = (v) => PAD_TOP + toY(v);
    const [cLo, cHi] = cfg.valueRange;
    const oct = Math.log2(vHi) - Math.log2(vLo);
    // toY clamps, but the drag must keep moving past the plot edges:
    // extrapolate the log law, then clamp to the knob range.
    yToV = (y) =>
      clamp(vLo * 2 ** ((1 - (y - PAD_TOP) / plotH) * oct), cLo, cHi);
  } else {
    [vLo, vHi] = cfg.valueRange;
    vToY = (v) => PAD_TOP + (1 - (v - vLo) / (vHi - vLo)) * plotH;
    yToV = (y) =>
      clamp(vLo + (1 - (y - PAD_TOP) / plotH) * (vHi - vLo), vLo, vHi);
  }

  // The window edges snap to the plot edges exactly (a t at the window
  // boundary sits ON the boundary — the FP of the linear map would
  // leave a sub-pixel gap there; the epsilon covers the t0 + span
  // sum's rounding, 1e-9 s << the 10 ms zoom floor).
  const tEnd = t0 + span;
  return {
    t0,
    span,
    plotH,
    vLo,
    vHi,
    tToX: (t) => (t <= t0 ? 0 : t >= tEnd - 1e-9 ? W : ((t - t0) / span) * W),
    xToT: (x) => (x <= 0 ? t0 : x >= W ? tEnd : clamp(t0 + (x / W) * span, t0, tEnd)),
    vToY,
    yToV,
  };
};

// Draw one envelope: the background, the shared ms time axis (offset to
// the window's start — drawAxis's `start`), the value / note labels,
// the densely-sampled curve (envelopeValue over the window — bends and
// the flat clamp legs included) with the 0.15-alpha gradient fill, one
// drum-hue handle per role anchor (halo, the card-editor look), the
// smaller hollow bend dots on the curve at each bend segment's
// midpoint, and — for `pitch` — a note label at each anchor (the band's
// look). `playheadX` (canvas px, finite) overlays the shared playhead
// line. `color` is the drum hue (the THEME accent when absent).
export const drawEnv = (canvas, opts) => {
  const { kind, points, window, color, duration, playheadX = null } = opts;
  const g = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const cfg = KINDS[kind];
  if (!cfg)
    throw new Error(
      `env-editor: unknown envelope kind ${JSON.stringify(kind)}`,
    );
  const pts = cfg.normalize(points);
  const m = envMaps({ width: W, height: H, kind, points: pts, window, duration });
  const trace = color ?? THEME.accent;

  g.fillStyle = COLORS.bg;
  g.fillRect(0, 0, W, H);
  drawAxis(
    g, W, H,
    m.span * 1000,
    [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000],
    'ms', String,
    m.t0 * 1000,
  );

  // The value labels (top-left / bottom-left, the old card-editor
  // look): plain values for level / fm depth, note names for pitch.
  g.font = '11px system-ui, sans-serif';
  g.fillStyle = COLORS.axis;
  g.textAlign = 'left';
  const label = (v) => (cfg.scale === 'logHz' ? hzToNoteName(v) : formatKnobValue(v));
  g.fillText(label(m.vHi), 4, PAD_TOP + 10);
  g.fillText(label(m.vLo), 4, PAD_TOP + m.plotH - 3);

  // The curve: densely sampled through envelopeValue over the window.
  // The clamp legs (before the first point / after the last) come from
  // the evaluator — the UI never re-derives the math.
  const n = BAND_CURVE_SAMPLES;
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i++)
    ys[i] = m.vToY(envelopeValue(pts, m.t0 + (i / (n - 1)) * m.span));

  g.strokeStyle = trace;
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * W;
    if (i === 0) g.moveTo(x, ys[i]);
    else g.lineTo(x, ys[i]);
  }
  g.stroke();

  const fill = g.createLinearGradient(0, 0, 0, H);
  fill.addColorStop(0, withAlpha(trace, 0.15));
  fill.addColorStop(1, withAlpha(trace, 0));
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(0, ys[0]);
  for (let i = 1; i < n; i++) g.lineTo((i / (n - 1)) * W, ys[i]);
  g.lineTo(W, H - PAD_BOTTOM);
  g.lineTo(0, H - PAD_BOTTOM);
  g.closePath();
  g.fill();

  // One handle per role anchor (drum hue, halo, bg ring).
  g.shadowColor = trace;
  g.shadowBlur = 4;
  for (const a of cfg.anchors) {
    const p = pts[a.point];
    g.beginPath();
    g.arc(m.tToX(p.t), m.vToY(p.v), 5, 0, Math.PI * 2);
    g.fillStyle = trace;
    g.fill();
    g.strokeStyle = COLORS.bg;
    g.lineWidth = 1.5;
    g.stroke();
  }
  g.shadowBlur = 0;

  // The bend dots: smaller + hollow, ON THE CURVE at each bend
  // segment's midpoint (segmentMidValue — the curve scalar's own law).
  for (const i of cfg.bends) {
    g.beginPath();
    g.arc(
      m.tToX((pts[i].t + pts[i + 1].t) / 2),
      m.vToY(segmentMidValue(pts, i)),
      3, 0, Math.PI * 2,
    );
    g.fillStyle = COLORS.bg;
    g.fill();
    g.strokeStyle = trace;
    g.lineWidth = 1.5;
    g.stroke();
  }

  // Pitch: a note label at each anchor (the band's point-label look).
  if (cfg.scale === 'logHz') {
    g.fillStyle = trace;
    for (const a of cfg.anchors) {
      const p = pts[a.point];
      const x = m.tToX(p.t);
      let y = m.vToY(p.v) - 8;
      if (y < 12) y = m.vToY(p.v) + 14;
      g.textAlign = x < 40 ? 'left' : x > W - 40 ? 'right' : 'center';
      g.fillText(hzToNoteName(p.v), x, y);
    }
  }

  // The optional playhead line (drawPlayhead never clears — drawEnv
  // just painted the base, so the overlay is clean).
  if (Number.isFinite(playheadX)) drawPlayhead(canvas, playheadX);
};

// The nearest role anchor or bend dot within HANDLE_RADIUS of (x, y)
// -> {type: 'anchor'|'bend', index} (the point index — anchors 0..5
// for level, 0..1 for pitch / fm depth; bends 1/3/4 for level), or
// null for empty plot space. Anchors are tested first, and the
// comparison is strict, so an exact distance tie goes to the anchor.
export const hitTestEnv = (points, kind, maps, x, y) => {
  const cfg = KINDS[kind];
  if (!cfg)
    throw new Error(
      `env-editor: unknown envelope kind ${JSON.stringify(kind)}`,
    );
  const pts = cfg.normalize(points);
  let best = null;
  let bestDist = HANDLE_RADIUS;
  for (const a of cfg.anchors) {
    const p = pts[a.point];
    const d = Math.hypot(maps.tToX(p.t) - x, maps.vToY(p.v) - y);
    if (d < bestDist) {
      bestDist = d;
      best = { type: 'anchor', index: a.point };
    }
  }
  for (const i of cfg.bends) {
    const d = Math.hypot(
      maps.tToX((pts[i].t + pts[i + 1].t) / 2) - x,
      maps.vToY(segmentMidValue(pts, i)) - y,
    );
    if (d < bestDist) {
      bestDist = d;
      best = { type: 'bend', index: i };
    }
  }
  return best;
};

// The pure drag: (points, kind, hit, t, v) -> a new canonical array, or
// the SAME reference when the drag changes nothing (the wire handler
// compares references to decide whether to commit).
//
//   - `level` anchor: the pointer's t becomes the anchor's absolute
//     time, clamped between the neighbour walls (the canonical
//     non-decreasing rule) and the knob span max (1.5 s) on BOTH
//     adjacent spans; the resulting spans (this one and the next one,
//     which shrinks / grows with the move) replace the params and
//     dahdsrToPoints re-derives all six points. Pinned-v anchors ignore
//     v; the sustain anchor maps v to sustain (clamped 0..1).
//   - `level` bend dot: v-only — midValueToCurve inverts the dot's
//     vertical position to the curve scalar k (k = 0 above the chord
//     midpoint -> the curve key is dropped; k = 1 at the lower bound);
//     the other points are untouched.
//   - `pitch` / `fm depth`: the 2-point canonical form is rebuilt with
//     the clamped values (start: v only; end: h + v), clamped to the
//     knob ranges (time 0.0005..1.5 s, pitch 20..22000 Hz, index
//     0..20) — the canvas can never disagree with the knobs.
export const dragEnv = (points, kind, hit, t, v) => {
  const cfg = KINDS[kind];
  if (!cfg)
    throw new Error(
      `env-editor: unknown envelope kind ${JSON.stringify(kind)}`,
    );
  const pts = cfg.normalize(points);

  if (hit.type === 'bend') {
    if (!cfg.bends.includes(hit.index)) return points;
    const k = midValueToCurve(pts, hit.index, v);
    // A no-op tolerance: midValueToCurve is a bisection (~1e-12 in
    // k), so a dot dragged back to its OWN midpoint value comes back
    // a hair off the stored k — far below the bend knob's 0.01 step.
    // Treat sub-eps moves as no change (the wire skips the commit).
    if (Math.abs(k - (pts[hit.index].curve ?? 0)) < 1e-9) return points;
    const next = pts.slice();
    const p = { ...pts[hit.index] };
    if (k > 0) p.curve = k;
    else delete p.curve;
    next[hit.index] = p;
    return next;
  }

  const anchor = cfg.anchors.find((a) => a.point === hit.index);
  if (!anchor || anchor.fixed) return points; // the start anchor is fixed

  if (kind === 'level') {
    const params = pointsToDahdsr(pts);
    const prevT = pts[hit.index - 1].t;
    const nextT = hit.index < pts.length - 1 ? pts[hit.index + 1].t : null;
    // The neighbour walls (non-decreasing t) and the knob span max on
    // BOTH adjacent spans (a gap > 1.5 s between two anchors keeps a
    // legal T interval — each span is <= 1.5 s, so the gap <= 3 s).
    const maxSpan = cfg.timeRange[1];
    let lo = prevT;
    let hi = nextT === null ? prevT + maxSpan : nextT;
    if (nextT !== null) {
      lo = Math.max(lo, nextT - maxSpan);
      hi = Math.min(hi, prevT + maxSpan);
    }
    const T = clamp(t, lo, hi);
    const next = { ...params, [anchor.param]: T - prevT };
    if (nextT !== null)
      next[LEVEL_ANCHORS[hit.index + 1].param] = nextT - T;
    if (anchor.vParam) next.sustain = clamp(v, 0, 1);
    // A drag that changes no parameter (a pinned-v vertical wiggle at
    // the same t, a move clamped back to the wall) commits nothing —
    // the SAME reference, so the wire handler skips the onEdit.
    if (Object.keys(params).every((k) => params[k] === next[k])) return points;
    return dahdsrToPoints(next);
  }

  // pitch / fm depth: rebuild the 2-point form (clamped to the knob
  // ranges).
  const [vLo, vHi] = cfg.valueRange;
  const nv = clamp(v, vLo, vHi);
  if (anchor.fixedT) {
    if (nv === pts[0].v) return points;
    return [{ t: 0, v: nv }, { ...pts[1] }];
  }
  const nt = clamp(t, cfg.timeRange[0], cfg.timeRange[1]);
  if (nt === pts[1].t && nv === pts[1].v) return points;
  return [{ ...pts[0] }, { t: nt, v: nv }];
};

// Wire the pointer handlers (pointerdown / move / up / cancel +
// setPointerCapture — the old card-editor / band pattern):
//
//   - a press on an anchor or bend dot starts a drag: each move maps
//     the pointer through the maps FROZEN at pointerdown (the
//     card-editor / band frozen-range pattern — a pitch drag must not
//     re-fit the log scale under the cursor) and commits
//     dragEnv's new array through onEdit(newPoints) — the caller does
//     setPath + onPatchEdit(drum) (the live-patch contract) — then
//     redraws;
//   - a press on EMPTY space that moves more than CLICK_SLOP starts a
//     window PAN (t0 follows the pointer, clamped to the drum) through
//     onWindow({t0, span}); a still press is a plain click (no-op here
//     — the card preview's click-to-open lives on the card, which uses
//     displayOnly mode);
//   - displayOnly mode attaches NO pointer listeners at all (the card
//     preview is display-only — its single affordance is the click).
//
// `getDrum` / `getKind` / `getWindow` resolve the current drum, the
// selected {kind, path} and the {t0, span} window (null = full span)
// at event time, so a re-created card or a modal kind switch needs no
// re-wiring. Returns { redraw, state } — redraw repaints the plot from
// the live patch (the always-fresh invariant); state is the press /
// hit / frozen-maps bookkeeping (tests inspect it).
export const wireEnvEditor = (canvas, {
  getDrum,
  getKind,
  getWindow = () => null,
  onEdit = () => {},
  onWindow = null,
  displayOnly = false,
}) => {
  const state = { press: null, hit: null, maps: null };

  const current = () => {
    const drum = getDrum();
    if (!drum) return null;
    const { kind, path } = getKind();
    const points = kindPoints(kind, getPath(drum.patch, path));
    const window = getWindow() ?? { t0: 0, span: drum.duration };
    const maps = envMaps({
      width: canvas.width,
      height: canvas.height,
      kind,
      points,
      window,
      duration: drum.duration,
    });
    return { drum, kind, path, points, window, maps };
  };

  const redraw = () => {
    const c = current();
    if (!c) return;
    drawEnv(canvas, {
      kind: c.kind,
      points: c.points,
      window: c.window,
      duration: c.drum.duration,
      color: c.drum.color ?? THEME.accent,
    });
  };

  if (displayOnly) return { redraw, state };

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) * canvas.width) / r.width,
      y: ((e.clientY - r.top) * canvas.height) / r.height,
    };
  };

  canvas.addEventListener('pointerdown', (e) => {
    const c = current();
    if (!c) return;
    const { x, y } = pos(e);
    state.hit = hitTestEnv(c.points, c.kind, c.maps, x, y);
    state.maps = c.maps; // frozen for the gesture
    state.press = { x, y, moved: false, t0: c.window.t0 };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = state.hit
      ? 'grabbing'
      : onWindow ? 'move' : 'crosshair';
  });

  canvas.addEventListener('pointermove', (e) => {
    const c = current();
    if (!c) return;
    const { x, y } = pos(e);

    if (state.hit) {
      // The anchor / bend-dot drag: (t, v) from the pointer through the
      // frozen maps, the new canonical array from dragEnv (pure).
      const next = dragEnv(
        c.points, c.kind, state.hit,
        state.maps.xToT(x), state.maps.yToV(y),
      );
      if (next !== c.points) {
        onEdit(next);
        redraw();
      }
      return;
    }

    if (
      state.press && !state.press.moved &&
      Math.hypot(x - state.press.x, y - state.press.y) > CLICK_SLOP
    )
      state.press.moved = true;

    if (state.press && state.press.moved && onWindow) {
      // The window pan: t0 follows the pointer (clamped to the drum),
      // span unchanged.
      const dt = ((state.press.x - x) / canvas.width) * c.window.span;
      const t0 = clamp(state.press.t0 + dt, 0, c.drum.duration - c.window.span);
      if (t0 !== c.window.t0) {
        onWindow({ t0, span: c.window.span });
        redraw();
      }
      return;
    }

    canvas.style.cursor = hitTestEnv(c.points, c.kind, c.maps, x, y)
      ? 'grab'
      : onWindow ? 'move' : 'crosshair';
  });

  const endPress = () => {
    state.press = null;
    state.hit = null;
    state.maps = null;
    canvas.style.cursor = onWindow ? 'move' : 'crosshair';
  };
  canvas.addEventListener('pointerup', endPress);
  canvas.addEventListener('pointercancel', endPress);

  return { redraw, state };
};
