// Tests for src/app/viz.js — the pure visual math: waveformPoints
// (peak-per-pixel waveform), waveformPointsAt (a hit placed on a shared
// time axis, for the overlaid main view), timeToX (the shared time →
// pixel-x map), spectrumMagnitudes (Goertzel bins), dbScale (log
// magnitude mapping), and withAlpha (the gradient-stop alpha helper).
// The DOM draw functions are thin 2D-context calls over these pure
// functions: drawWaveform (the glowy trace + the S9 gradient fill under
// the curve), drawSpectrum (the S9 hue-ramped gradient bars),
// drawOverlaidWaveforms, drawPlayhead, and drawShapeWave (the one-period
// shape preview for the card shape groups) are covered with a recording
// 2D-context stub (ui-refresh.md §7.1); the rest by the manual browser
// pass (plan steps 14/17).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COLORS,
  dbScale,
  drawOverlaidWaveforms,
  drawPlayhead,
  drawShapeWave,
  drawSpectrum,
  drawWaveform,
  DRUM_COLORS,
  PAD_BOTTOM,
  PAD_TOP,
  spectrumMagnitudes,
  timeToX,
  withAlpha,
  waveformPoints,
  waveformPointsAt,
} from '../src/app/viz.js';

// Unit-amplitude sine, `n` samples at `sr`.
const sine = (freq, sr, n) => {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++)
    buf[i] = Math.sin((2 * Math.PI * freq * i) / sr);
  return buf;
};

test('waveformPoints: zero buffer -> flat midline', () => {
  const pts = waveformPoints(new Float32Array(1000), 100, 80);
  assert.equal(pts.length, 200); // 2 points (yTop, yBottom) per column
  for (const p of pts) assert.equal(p, 40); // mid = 80/2
});

test('waveformPoints: single spike -> column max at the canvas top', () => {
  const width = 100;
  const n = 1000; // 10 samples per column
  const buf = new Float32Array(n);
  const k = 37;
  buf[k * 10 + 3] = 1; // +1 spike inside column 37 only
  const pts = waveformPoints(buf, width, 100);
  assert.equal(pts[2 * k], 0); // max +1 -> y = 0 (top edge)
  assert.equal(pts[2 * k + 1], 50); // min 0 -> y = midline
  assert.equal(pts[2 * 7], 50); // an untouched column stays flat
  assert.equal(pts[2 * 7 + 1], 50);
});

test('waveformPoints: full-scale samples stay within [0, height]', () => {
  const pts = waveformPoints(sine(440, 1000, 2000), 300, 120);
  assert.equal(pts.length, 600);
  for (const p of pts) assert.ok(p >= 0 && p <= 120, `y ${p} outside [0, 120]`);
});

test('waveformPoints: DC level maps to the expected offset line', () => {
  // v = 0.5 -> y = 80/2·(1−0.5) = 20 for BOTH min and max — pins that
  // the per-column min/max are the actual samples, not 0-initialized
  // (a 0-init would wrongly pull positive columns down to the midline).
  const pts = waveformPoints(new Float32Array(500).fill(0.5), 50, 80);
  for (let x = 0; x < 50; x++) {
    assert.equal(pts[2 * x], 20);
    assert.equal(pts[2 * x + 1], 20);
  }
});

test('waveformPoints: wider than the buffer holds samples', () => {
  // 4 samples upscaled to 8 columns: each sample spans 2 columns. A
  // column whose min and max are the SAME sample value is a single y:
  // +1 -> 0 (top point), -1 -> 100 (bottom point), 0 -> 50 (midline).
  const pts = waveformPoints(new Float32Array([0, 1, -1, 0]), 8, 100);
  assert.equal(pts[0], 50); assert.equal(pts[1], 50); // sample 0 = 0
  assert.equal(pts[4], 0); assert.equal(pts[5], 0); // sample 1 = +1
  assert.equal(pts[8], 100); assert.equal(pts[9], 100); // sample 2 = −1
  assert.equal(pts[12], 50); assert.equal(pts[13], 50); // sample 3 = 0
});

test('waveformPointsAt: empty buffer -> flat midline', () => {
  const pts = waveformPointsAt(new Float32Array(0), 44100, 0.5, 100, 120);
  assert.equal(pts.length, 200); // 2 points (yTop, yBottom) per column
  for (const p of pts) assert.equal(p, 60); // mid = 120/2
});

test('waveformPointsAt: 0.3 s buffer on a 0.5 s axis covers the first 60 of 100 columns', () => {
  // The covered prefix must be element-for-element the full-buffer
  // waveformPoints computed at the covered width; the remaining columns
  // are exactly the flat midline.
  const sr = 1000;
  const buf = sine(120, sr, 300);
  const h = 120;
  const pts = waveformPointsAt(buf, sr, 0.5, 100, h);
  const ref = waveformPoints(buf, 60, h);
  assert.equal(pts.length, 200);
  for (let x = 0; x < 60; x++) {
    assert.equal(pts[2 * x], ref[2 * x]);
    assert.equal(pts[2 * x + 1], ref[2 * x + 1]);
  }
  for (let x = 60; x < 100; x++) {
    assert.equal(pts[2 * x], 60); // flat midline past the buffer
    assert.equal(pts[2 * x + 1], 60);
  }
});

test('waveformPointsAt: spike at the buffer\'s last sample stays in the covered columns', () => {
  // 0.3 s @ 1000 Hz on a 0.5 s axis -> wCover 60, 5 samples per column;
  // the +1 spike in the FINAL sample (index 299) lands in column 59
  // (samples 295-299) and nothing beyond the covered width may move.
  const sr = 1000;
  const buf = new Float32Array(300);
  buf[299] = 1;
  const h = 100;
  const pts = waveformPointsAt(buf, sr, 0.5, 100, h);
  assert.equal(pts[2 * 59], 0); // max +1 -> y = 0 (top edge)
  assert.equal(pts[2 * 59 + 1], 50); // min 0 -> midline
  for (let x = 0; x < 100; x++) {
    if (x === 59) continue;
    assert.equal(pts[2 * x], 50); // every other column stays flat
    assert.equal(pts[2 * x + 1], 50);
  }
});

test('waveformPointsAt: tMax = buffer duration collapses to waveformPoints', () => {
  // Shared axis equal to the buffer's own duration: the covered width is
  // the full width, so the result must be identical to the single-drum
  // math (backward compatibility of the overlay math).
  const sr = 1000;
  const buf = sine(440, sr, 500);
  const pts = waveformPointsAt(buf, sr, buf.length / sr, 120, 90);
  const ref = waveformPoints(buf, 120, 90);
  assert.equal(pts.length, ref.length);
  for (let i = 0; i < ref.length; i++) assert.equal(pts[i], ref[i]);
});

test('waveformPointsAt: full-scale samples stay within [0, height]', () => {
  const sr = 1000;
  const buf = sine(440, sr, 400); // 0.4 s on a 0.5 s axis
  const pts = waveformPointsAt(buf, sr, 0.5, 200, 120);
  assert.equal(pts.length, 400);
  for (const p of pts) assert.ok(p >= 0 && p <= 120, `y ${p} outside [0, 120]`);
});

test('timeToX: endpoints and midpoint are linear, out-of-range clamps', () => {
  const tMax = 0.5;
  const W = 900;
  assert.equal(timeToX(0, tMax, W), 0); // start of the axis -> left edge
  assert.equal(timeToX(tMax, tMax, W), W); // end of the axis -> right edge
  assert.equal(timeToX(tMax / 2, tMax, W), W / 2); // linear in between
  assert.equal(timeToX(-0.1, tMax, W), 0); // negative t clamps to 0
  assert.equal(timeToX(0.9, tMax, W), W); // t > tMax clamps to width
});

// ---- drawOverlaidWaveforms (recording 2D-context stub, §7.1) --------

// Recording canvas + 2D context: captures the draw calls (clearRect,
// fillRect, fillText, moveTo, lineTo, beginPath, stroke, fill, save,
// restore, translate), the strokeStyle/fillStyle/shadowColor/shadowBlur
// assignments, and every createLinearGradient (a distinct sentinel
// object { __gradient: [x0, y0, x1, y1] } whose addColorStop records
// [offset, color] into its own stops — the stubs' gradient assertion
// is by sentinel identity, plan "colors" S9), and throws on any
// non-finite coordinate — a NaN guard for free. Each stroke() / fill()
// also snapshots its path + style into ctx.strokes / ctx.fills (the
// test/band.test.mjs technique) so a test can ask "which stroke or fill
// used which color and width" without replaying the call list.
// measureText returns a fixed width (30) so the legend positions are
// deterministic.
const stubCanvas = (width, height) => {
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
  const ctx = {
    calls,
    strokes,
    fills,
    gradients,
    font: undefined,
    textAlign: undefined,
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
    fillRect(x, y, w, h) { finite('fillRect', x, y, w, h); calls.push(['fillRect', x, y, w, h]); },
    fillText(text, x, y) { finite('fillText', x, y); calls.push(['fillText', text, x, y]); },
    beginPath() { path = []; calls.push(['beginPath']); },
    closePath() { calls.push(['closePath']); },
    stroke() { strokes.push({ pts: path.slice(), strokeStyle: style, lineWidth }); path = []; calls.push(['stroke']); },
    fill() { fills.push({ pts: path.slice(), fillStyle }); path = []; calls.push(['fill']); },
    createLinearGradient(x0, y0, x1, y1) {
      finite('createLinearGradient', x0, y0, x1, y1);
      calls.push(['createLinearGradient', x0, y0, x1, y1]);
      // A distinct sentinel per gradient: assignable to fillStyle / 
      // strokeStyle, asserted by identity; its stops are the recorded
      // addColorStop pairs.
      const grad = { __gradient: [x0, y0, x1, y1], stops: [] };
      grad.addColorStop = (offset, color) => {
        grad.stops.push([offset, color]);
        calls.push(['addColorStop', offset, color]);
      };
      gradients.push(grad);
      return grad;
    },
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    translate(x, y) { finite('translate', x, y); calls.push(['translate', x, y]); },
    moveTo(x, y) { finite('moveTo', x, y); path.push({ x, y }); calls.push(['moveTo', x, y]); },
    lineTo(x, y) { finite('lineTo', x, y); path.push({ x, y }); calls.push(['lineTo', x, y]); },
    measureText: (text) => ({ width: 30, text }),
  };
  return { canvas: { width, height, getContext: () => ctx }, ctx };
};

// The moveTo/lineTo calls made inside a save/restore pair: the trace
// segments (background, axis, and midline are all drawn at depth 0).
const traceSegments = (calls) => {
  const segs = [];
  let depth = 0;
  for (const c of calls) {
    if (c[0] === 'save') depth += 1;
    else if (c[0] === 'restore') depth -= 1;
    else if (depth > 0 && (c[0] === 'moveTo' || c[0] === 'lineTo')) segs.push(c);
  }
  return segs;
};

test('drawOverlaidWaveforms: three entries -> drum colors, legend, bg first, finite coords', () => {
  const sr = 1000;
  const tMax = 0.5;
  const W = 200;
  const H = 120;
  const entries = [
    { buffer: sine(50, sr, 500), sr, color: DRUM_COLORS.kick, label: 'Kick' },
    { buffer: sine(100, sr, 500), sr, color: DRUM_COLORS.snare, label: 'Snare' },
    { buffer: sine(200, sr, 300), sr, color: DRUM_COLORS.hihat, label: 'Hi-hat' },
  ];
  const { canvas, ctx } = stubCanvas(W, H);
  drawOverlaidWaveforms(canvas, entries, tMax);
  const calls = ctx.calls;

  // The background fill is the first draw, covering the whole canvas
  // (calls[0] is the recorded fillStyle assignment; the first fillRect
  // is the background).
  assert.deepEqual(calls.find(([k]) => k === 'fillRect'), ['fillRect', 0, 0, W, H]);

  // One trace strokeStyle per entry, in entry order, exactly the three
  // distinct DRUM_COLORS (earlier assignments are axis/midline).
  const styles = calls.filter(([k]) => k === 'strokeStyle').map(([, v]) => v);
  assert.deepEqual(styles.slice(-3), [DRUM_COLORS.kick, DRUM_COLORS.snare, DRUM_COLORS.hihat]);
  assert.equal(new Set(styles.slice(-3)).size, 3);

  // One legend fillText per label (painted after the traces, top-left):
  // y = PAD_TOP + 12, x starting at 8 and advanced by the stub's fixed
  // measureText width (30) + 14.
  const legend = calls.filter(([k, , , y]) => k === 'fillText' && y === PAD_TOP + 12);
  assert.deepEqual(legend.map(([, t]) => t), ['Kick', 'Snare', 'Hi-hat']);
  assert.deepEqual(legend.map(([, , x]) => x), [8, 52, 96]);

  // One save/translate/stroke block per entry, W segments each, all
  // within the plot (finite coordinates are enforced by the stub).
  assert.equal(calls.filter(([k]) => k === 'save').length, 3);
  assert.equal(calls.filter(([k]) => k === 'restore').length, 3);
  assert.deepEqual(
    calls.filter(([k]) => k === 'translate'),
    [['translate', 0, PAD_TOP], ['translate', 0, PAD_TOP], ['translate', 0, PAD_TOP]],
  );
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const segs = traceSegments(calls);
  assert.equal(segs.length, 3 * 2 * W);
  for (const [, , y] of segs) assert.ok(y >= 0 && y <= plotH, `trace y ${y} outside [0, ${plotH}]`);

  // Explicit finite check across the whole call list (the stub already
  // throws; this pins it down for every numeric argument).
  for (const c of calls)
    for (const v of c)
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `non-finite in ${c[0]}`);
});

test('drawOverlaidWaveforms: empty buffer entry -> flat midline, no exception', () => {
  const W = 100;
  const H = 80;
  const { canvas, ctx } = stubCanvas(W, H);
  const entry = { buffer: new Float32Array(0), sr: 1000, color: DRUM_COLORS.hihat, label: 'Hi-hat' };
  assert.doesNotThrow(() => drawOverlaidWaveforms(canvas, [entry], 0.5));
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const segs = traceSegments(ctx.calls);
  assert.equal(segs.length, 2 * W);
  for (const [, , y] of segs) assert.equal(y, plotH / 2); // flat midline
});

// ---- drawPlayhead (recording 2D-context stub, §7.1) ------------------

test('drawPlayhead: in-range x -> vertical hairline over the trace, no clear', () => {
  const W = 200;
  const H = 120;
  const { canvas, ctx } = stubCanvas(W, H);
  drawPlayhead(canvas, 100.6); // rounds to column 101, +0.5 hairline offset
  const calls = ctx.calls;

  // Exactly one moveTo/lineTo pair at the same x, spanning precisely
  // [PAD_TOP, H - PAD_BOTTOM] (the full plot height, not the whole canvas).
  assert.deepEqual(calls.filter(([k]) => k === 'moveTo'), [['moveTo', 101.5, PAD_TOP]]);
  assert.deepEqual(calls.filter(([k]) => k === 'lineTo'), [['lineTo', 101.5, H - PAD_BOTTOM]]);

  // The cursor is the yellow COLORS.playhead, 1.5 px wide.
  assert.deepEqual(calls.filter(([k]) => k === 'strokeStyle'), [['strokeStyle', COLORS.playhead]]);
  assert.equal(ctx.lineWidth, 1.5);

  // It does NOT clear the canvas: no fillRect at all, so the trace
  // underneath stays untouched (an overlay, not a repaint).
  assert.equal(calls.filter(([k]) => k === 'fillRect').length, 0);
});

test('drawPlayhead: edges x = 0 and x = width are inside the plot', () => {
  const W = 200;
  const H = 120;
  for (const [x, px] of [[0, 0.5], [W, W + 0.5]]) {
    const { canvas, ctx } = stubCanvas(W, H);
    drawPlayhead(canvas, x);
    assert.deepEqual(
      ctx.calls.filter(([k]) => k === 'moveTo'),
      [['moveTo', px, PAD_TOP]],
      `x=${x}: expected the hairline at ${px}`,
    );
  }
});

test('drawPlayhead: out-of-range / non-finite x -> no path at all', () => {
  const W = 200;
  const H = 120;
  for (const x of [-1, W + 1, NaN, Infinity]) {
    const { canvas, ctx } = stubCanvas(W, H);
    drawPlayhead(canvas, x);
    // No moveTo/lineTo/stroke — and nothing else: the context is pristine.
    assert.deepEqual(ctx.calls, [], `x=${x}: expected no draw calls`);
  }
});

// ---- drawWaveform (recording 2D-context stub, plan "colors" S9) ------
//
// The single-drum waveform view: the accent trace now glows (shadow set
// AROUND the stroke only, reset before the fill) and the area under the
// curve is filled with a vertical trace-color gradient (0.28 -> 0, the
// area closed to the plot's bottom corners).

test('drawWaveform: glowy trace + exactly one gradient fill under the curve, the shadow reset before the fill', () => {
  const W = 200;
  const H = 120;
  const sr = 1000;
  const buffer = sine(80, sr, 300); // 0.3 s hit
  const { canvas, ctx } = stubCanvas(W, H);
  drawWaveform(canvas, buffer, sr);
  const calls = ctx.calls;
  const plotH = H - PAD_TOP - PAD_BOTTOM;

  // The trace itself is unchanged: one accent stroke, one vertical
  // segment per pixel column.
  const trace = ctx.strokes.filter((s) => s.strokeStyle === COLORS.trace);
  assert.equal(trace.length, 1, 'one accent trace');
  assert.equal(trace[0].pts.length, 2 * W, 'one segment pair per column');

  // Exactly ONE gradient: vertical, the full canvas height 0 -> H.
  assert.equal(ctx.gradients.length, 1, 'one gradient fill');
  const [grad] = ctx.gradients;
  assert.deepEqual(grad.__gradient, [0, 0, 0, H], 'vertical 0 -> H');
  // The stops inherit the trace color: 0.28 at the top, 0 at the bottom
  // (withAlpha — the canvas palette tokens are hex, the stops are rgba).
  assert.deepEqual(grad.stops, [
    [0, withAlpha(COLORS.trace, 0.28)],
    [1, withAlpha(COLORS.trace, 0)],
  ]);

  // Exactly ONE fill, with that gradient (asserted by sentinel
  // identity), painted AFTER the trace stroke.
  assert.equal(ctx.fills.length, 1, 'one area fill');
  const [fill] = ctx.fills;
  assert.equal(fill.fillStyle, grad, 'the area fill wears the gradient sentinel');
  // The trace is the LAST stroke of the paint (axis grid + midline come
  // before it, all at depth 0 or inside the trace's own save block).
  let iTraceStroke = -1;
  calls.forEach(([k], i) => { if (k === 'stroke') iTraceStroke = i; });
  const iFill = calls.findIndex(([k]) => k === 'fill');
  assert.ok(iTraceStroke >= 0 && iFill > iTraceStroke, 'the fill comes after the trace stroke');

  // The area path: the trace's TOP edge (the per-column max, offset by
  // PAD_TOP) closed to the plot's bottom corners.
  const points = waveformPoints(buffer, W, plotH);
  assert.equal(fill.pts.length, W + 2, 'top edge + two bottom corners');
  assert.deepEqual(fill.pts[0], { x: 0, y: PAD_TOP + points[0] });
  for (let x = 1; x < W; x++)
    assert.deepEqual(fill.pts[x], { x, y: PAD_TOP + points[x * 2] });
  assert.deepEqual(fill.pts[W], { x: W, y: H - PAD_BOTTOM }, 'closes to the bottom-right corner');
  assert.deepEqual(fill.pts[W + 1], { x: 0, y: H - PAD_BOTTOM }, 'closes to the bottom-left corner');

  // The glow: shadowColor + shadowBlur 6 set AROUND the trace stroke
  // only — and shadowBlur returns to 0 BEFORE the fill, so the fill
  // (and everything painted later, e.g. the playhead over the band)
  // does not glow.
  const blurSets = calls
    .map(([k, v], i) => (k === 'shadowBlur' ? { i, v } : null))
    .filter(Boolean);
  assert.deepEqual(blurSets.map((s) => s.v), [6, 0], 'blur on, then off');
  const iShadowColor = calls.findIndex(([k, v]) => k === 'shadowColor' && v === COLORS.trace);
  assert.ok(iShadowColor < blurSets[0].i, 'shadowColor set with the glow');
  assert.ok(blurSets[0].i < iTraceStroke, 'the glow is on before the trace stroke');
  assert.ok(iTraceStroke < blurSets[1].i, 'the glow is off after the trace stroke');
  assert.ok(blurSets[1].i < iFill, 'the reset precedes the fill');
  assert.equal(ctx.shadowBlur, 0, 'the context leaves the paint with the glow off');

  // Finite coordinates across the whole call list (the stub already
  // throws; pinned explicitly, like the other draw tests).
  for (const c of calls)
    for (const v of c)
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `non-finite in ${c[0]}`);
});

test('drawWaveform: an empty buffer paints the flat midline trace + a full-height area fill', () => {
  const W = 100;
  const H = 80;
  const { canvas, ctx } = stubCanvas(W, H);
  drawWaveform(canvas, new Float32Array(0), 1000);
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  // The empty buffer's trace is the flat midline; the area fill still
  // closes from that midline to the bottom corners.
  assert.equal(ctx.fills.length, 1);
  const [fill] = ctx.fills;
  assert.ok(fill.fillStyle.__gradient, 'the fill is the gradient sentinel');
  for (const p of fill.pts.slice(0, W))
    assert.ok(p.y >= PAD_TOP && p.y <= PAD_TOP + plotH, `y ${p.y} outside the plot`);
  assert.deepEqual(fill.pts[W], { x: W, y: H - PAD_BOTTOM });
  assert.deepEqual(fill.pts[W + 1], { x: 0, y: H - PAD_BOTTOM });
});

// ---- drawSpectrum (recording 2D-context stub, plan "colors" S9) ------
//
// The hue-ramped bars: each non-zero bar keeps its log-scaled geometry
// but wears its own vertical gradient — hsl(h, 85%, 62%) at the top,
// the same hue at 0.35 alpha at the base — with h = 190 + 140·(i/binCount)
// ramping cyan (low) -> pink (high) across the frequency range.

test('drawSpectrum: one gradient per non-zero bar, hue monotone increasing, log-scaled heights unchanged', () => {
  const W = 120;
  const H = 100;
  const sr = 1000;
  // Eight sines spread across the audible range: the Goertzel bins light
  // up a wide, deterministic spread (well beyond the one or two bins a
  // single tone would).
  const buffer = (() => {
    const n = sr * 0.5; // 0.5 s
    const buf = new Float32Array(n);
    for (let k = 0; k < 8; k += 1) {
      const f = 30 + 60 * k; // 30 .. 450 Hz, all below Nyquist (500)
      for (let i = 0; i < n; i += 1) buf[i] += Math.sin((2 * Math.PI * f * i) / sr) / 8;
    }
    return buf;
  })();
  const { canvas, ctx } = stubCanvas(W, H);
  drawSpectrum(canvas, buffer, sr);
  const calls = ctx.calls;
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const binCount = Math.max(16, Math.floor(W / 2)); // 60
  const barW = W / binCount;

  // The expected bars, recomputed the same way (the property-assertion
  // style: assert against the math, never a hardcoded pixel list).
  const mags = spectrumMagnitudes(buffer, sr, binCount);
  let peak = 0;
  for (const m of mags) if (m > peak) peak = m;
  const expected = [];
  for (let i = 0; i < binCount; i += 1) {
    const h = peak > 0 ? dbScale(mags[i] / peak) * plotH : 0;
    if (h > 0) expected.push({ i, h });
  }
  assert.ok(expected.length > 5, `a spread of non-zero bars, got ${expected.length}`);

  // The geometry is UNCHANGED: the background first, then exactly one
  // fillRect per non-zero bar at the log-scaled position/size.
  const rects = calls.filter(([k]) => k === 'fillRect');
  assert.equal(rects.length, 1 + expected.length, 'background + one rect per non-zero bar');
  assert.deepEqual(rects[0], ['fillRect', 0, 0, W, H]);
  const expectedRects = expected.map(({ i, h }) =>
    ['fillRect', i * barW, PAD_TOP + plotH - h, barW, h]);
  assert.deepEqual(rects.slice(1), expectedRects, 'the log-scaled bar heights are unchanged');

  // One gradient per non-zero bar, each the bar's own vertical span
  // (top -> base), created in bar order.
  assert.equal(ctx.gradients.length, expected.length, 'N gradient fills for N bars');
  expected.forEach(({ i, h }, n) => {
    const hue = 190 + 140 * (i / binCount);
    assert.deepEqual(ctx.gradients[n].__gradient, [0, PAD_TOP + plotH - h, 0, PAD_TOP + plotH]);
    // The per-bar stops: the hue at full color on top, 0.35 alpha at the
    // base (parsed back from the recorded hsl strings).
    assert.deepEqual(ctx.gradients[n].stops, [
      [0, `hsl(${hue}, 85%, 62%)`],
      [1, `hsl(${hue}, 85%, 62%, 0.35)`],
    ]);
    // The bar is painted with ITS gradient (sentinel identity), and the
    // assignment precedes the bar's fillRect.
    const iStyle = calls.findIndex(([k, v]) => k === 'fillStyle' && v === ctx.gradients[n]);
    const iRect = calls.findIndex((c) => JSON.stringify(c) === JSON.stringify(expectedRects[n]));
    assert.ok(iStyle >= 0, `bar ${i}: its gradient was assigned as fillStyle`);
    assert.ok(iStyle < iRect, `bar ${i}: the fillStyle precedes the fillRect`);
  });

  // The hue ramp, parsed from the recorded stop strings: strictly
  // increasing across the drawn bars (cyan at low -> pink at high).
  const hues = ctx.gradients.map((g) => Number(/^hsl\(([\d.]+),/.exec(g.stops[0][1])[1]));
  for (let n = 1; n < hues.length; n += 1)
    assert.ok(hues[n] > hues[n - 1], `hue not increasing at bar ${n}: ${hues[n - 1]} -> ${hues[n]}`);
  assert.ok(hues[0] >= 190 && hues[hues.length - 1] <= 330, 'the ramp spans 190..330 degrees');

  // No flat accent fillStyle any more: the bars are all gradients.
  assert.ok(!calls.some(([k, v]) => k === 'fillStyle' && v === COLORS.trace),
    'no flat COLORS.trace bar fill');
});

// The spectrum tests use exactly 1 s of audio at sr 1000: with the bin
// layout f_i = i·sr/(2·binCount), every bin then integrates an INTEGER
// number of cycles of any on-bin component, so the rectangular window
// nulls all off-bin magnitudes (no leakage to argue about).
test('spectrumMagnitudes: 100 Hz sine peaks at its bin (±1)', () => {
  const sr = 1000;
  const buf = sine(100, sr, 1000);
  const binCount = 250; // 2 Hz spacing -> bin 50 is exactly 100 Hz
  const mags = spectrumMagnitudes(buf, sr, binCount);
  assert.equal(mags.length, binCount);

  let best = 0;
  for (let i = 1; i < binCount; i++) if (mags[i] > mags[best]) best = i;
  assert.ok(Math.abs(best - 50) <= 1, `peak bin ${best}, expected 50 ± 1`);

  // A unit 1000-sample sine has |X| = N/2 = 500 at its bin.
  assert.ok(Math.abs(mags[best] - 500) < 1, `peak mag ${mags[best]}`);

  // Off-bin magnitudes are (near-)zero: the next-largest is far away.
  let runnerUp = 0;
  for (let i = 0; i < binCount; i++)
    if (i !== best && mags[i] > runnerUp) runnerUp = mags[i];
  assert.ok(runnerUp < 0.01 * mags[best], `runner-up mag ${runnerUp}`);
});

test('spectrumMagnitudes: DC offset dominates bin 0', () => {
  const sr = 1000;
  const buf = new Float32Array(1000).fill(0.5);
  const binCount = 250;
  const mags = spectrumMagnitudes(buf, sr, binCount);
  assert.ok(Math.abs(mags[0] - 500) < 1, `bin 0 = ${mags[0]}`); // Σ x = N·0.5
  for (let i = 1; i < binCount; i++)
    assert.ok(mags[i] < 0.01 * mags[0], `bin ${i} = ${mags[i]}`);
});

test('dbScale: 0 at the floor, 1 at full scale, finite at mag 0', () => {
  assert.equal(dbScale(1e-3), 0); // 1e-3 = 10^(−60/20): the −60 dB floor
  assert.equal(dbScale(1e-4), 0); // below the floor
  assert.equal(dbScale(1), 1); // full scale = 0 dB
  assert.equal(dbScale(2), 1); // above full scale clamps to 1
  assert.equal(dbScale(0), 0); // log10(0) = −∞, but the result is finite
  assert.equal(dbScale(-1), 0); // negative mags are treated as 0
});

test('dbScale: monotonic and within [0, 1] on the active range', () => {
  let prev = 0;
  for (let i = 0; i <= 200; i++) {
    const mag = 1e-4 * Math.pow(1e4, i / 200); // 1e-4 .. 1 in log steps
    const s = dbScale(mag);
    assert.ok(s >= prev, `not monotonic at mag ${mag}`);
    assert.ok(s >= 0 && s <= 1, `outside [0,1] at mag ${mag}`);
    prev = s;
  }
});

test('dbScale: logarithmic midpoint and custom floor', () => {
  // −30 dB is exactly halfway between the −60 dB floor and 0 dB.
  assert.ok(Math.abs(dbScale(Math.pow(10, -30 / 20)) - 0.5) < 1e-9);
  // A custom floor rescales the same curve.
  assert.equal(dbScale(1e-2, -40), 0); // 1e-2 = 10^(−40/20)
  assert.ok(Math.abs(dbScale(Math.pow(10, -20 / 20), -40) - 0.5) < 1e-9);
});

// ---- withAlpha (the gradient-stop alpha helper, plan "colors" S9) ---

test('withAlpha: 6-digit hex -> rgba() with the given alpha', () => {
  assert.equal(withAlpha('#3ddc97', 0.28), 'rgba(61, 220, 151, 0.28)');
  assert.equal(withAlpha('#000000', 0), 'rgba(0, 0, 0, 0)');
  assert.equal(withAlpha('#ffffff', 1), 'rgba(255, 255, 255, 1)');
});

test('withAlpha: 8-digit hex -> the stored alpha is replaced', () => {
  assert.equal(withAlpha('#3ddc9780', 0.5), 'rgba(61, 220, 151, 0.5)');
});

test('withAlpha: rgb()/rgba() input -> the alpha is replaced', () => {
  assert.equal(withAlpha('rgb(1, 2, 3)', 0.5), 'rgba(1, 2, 3, 0.5)');
  assert.equal(withAlpha('rgba(1, 2, 3, 0.9)', 0.5), 'rgba(1, 2, 3, 0.5)');
});

test('withAlpha: unsupported input fails loudly', () => {
  assert.throws(() => withAlpha('#12345', 0.5), /6- or 8-digit hex/);
  assert.throws(() => withAlpha('#1234567', 0.5), /6- or 8-digit hex/);
  assert.throws(() => withAlpha('hsl(0, 0%, 0%)', 0.5), /hex or rgb\(\)/);
  assert.throws(() => withAlpha('red', 0.5), /hex or rgb\(\)/);
});

// ---- drawShapeWave (recording 2D-context stub) ------------------------
//
// The card shape previews' one-period trace (the buildShapeGroup
// preview canvas is 72×24): one waveShapePoints sample per pixel
// column, v ∈ [−1, 1] mapped to the 1 px-inset span [1, H−1] so the
// 2 px stroke is never clipped, over a faint 1 px grid-tone midline.

const PREVIEW_W = 72;
const PREVIEW_H = 24;
const SHAPE_COLOR = '#ff00ff';

test('drawShapeWave: one clearRect and one trace stroke per shape, in the passed color, finite coords, y within [1, H−1]', () => {
  for (const shape of ['sine', 'square', 'saw', 'triangle']) {
    const { canvas, ctx } = stubCanvas(PREVIEW_W, PREVIEW_H);
    drawShapeWave(canvas, shape, SHAPE_COLOR);
    const calls = ctx.calls;

    // The paint starts by clearing the whole canvas — exactly once.
    const clears = calls.filter(([k]) => k === 'clearRect');
    assert.equal(clears.length, 1, `${shape}: one clearRect`);
    assert.deepEqual(clears[0], ['clearRect', 0, 0, PREVIEW_W, PREVIEW_H]);

    // Exactly two strokes: the faint midline first (1 px, the muted
    // grid tone, spanning the width), then the trace on top of it.
    assert.equal(ctx.strokes.length, 2, `${shape}: midline + trace`);
    const [mid, trace] = ctx.strokes;
    assert.equal(mid.strokeStyle, COLORS.grid, `${shape}: midline in the grid tone`);
    assert.equal(mid.lineWidth, 1, `${shape}: the midline is 1 px`);
    assert.equal(mid.pts.length, 2, `${shape}: the midline spans the width`);
    assert.equal(trace.strokeStyle, SHAPE_COLOR, `${shape}: trace in the passed color`);
    assert.equal(trace.lineWidth, 2, `${shape}: the trace is 2 px`);

    // One vertex per pixel column, x = 0 … W−1 (the waveShapePoints
    // grid over the full width).
    assert.equal(trace.pts.length, PREVIEW_W, `${shape}: one vertex per pixel column`);
    assert.equal(trace.pts[0].x, 0, `${shape}: the trace starts at the left edge`);
    assert.equal(trace.pts[PREVIEW_W - 1].x, PREVIEW_W - 1, `${shape}: the trace ends at the right edge`);

    // Finite coordinates only (the stub already throws on a non-finite
    // one) and every trace vertex inside the 1 px inset span [1, H−1]:
    // the shapes' [−1, 1] bound (osc.js header) maps onto the inset.
    for (const p of trace.pts) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${shape}: non-finite vertex`);
      assert.ok(p.y >= 1 && p.y <= PREVIEW_H - 1, `${shape}: y ${p.y} outside [1, ${PREVIEW_H - 1}]`);
    }

    // The S10 faint fill under the trace: exactly ONE gradient —
    // vertical 0 -> H, the trace color at 0.12 fading to transparent
    // (sentinel identity) — and its path is the trace's top edge closed
    // to the canvas's bottom corners. No glow: the preview's fill is
    // faint by design (the shadow language is the band's and the env
    // editor's).
    assert.equal(ctx.gradients.length, 1, `${shape}: one gradient fill`);
    const [grad] = ctx.gradients;
    assert.deepEqual(grad.__gradient, [0, 0, 0, PREVIEW_H], `${shape}: vertical 0 -> H`);
    assert.deepEqual(grad.stops, [
      [0, withAlpha(SHAPE_COLOR, 0.12)],
      [1, withAlpha(SHAPE_COLOR, 0)],
    ], `${shape}: the fill fades 0.12 -> 0 of the trace color`);
    assert.equal(ctx.fills.length, 1, `${shape}: one fill (under the trace)`);
    assert.equal(ctx.fills[0].fillStyle, grad, `${shape}: the fill wears the gradient sentinel`);
    assert.equal(ctx.fills[0].pts.length, PREVIEW_W + 2, `${shape}: top edge + two bottom corners`);
    for (let x = 0; x < PREVIEW_W; x += 1)
      assert.deepEqual(ctx.fills[0].pts[x], trace.pts[x], `${shape}: the fill's top edge is the trace`);
    assert.deepEqual(ctx.fills[0].pts[PREVIEW_W], { x: PREVIEW_W, y: PREVIEW_H }, `${shape}: closes to the bottom-right corner`);
    assert.deepEqual(ctx.fills[0].pts[PREVIEW_W + 1], { x: 0, y: PREVIEW_H }, `${shape}: closes to the bottom-left corner`);
    assert.equal(ctx.shadowBlur, 0, `${shape}: the preview leaves no glow`);
  }
});

test('drawShapeWave: the sine preview has its max in the first quarter and its min in the third (phase → x sanity)', () => {
  const { canvas, ctx } = stubCanvas(PREVIEW_W, PREVIEW_H);
  drawShapeWave(canvas, 'sine', SHAPE_COLOR);
  const pts = ctx.strokes[1].pts; // the trace (strokes[0] is the midline)
  let peak = 0;   // smallest y = largest v = the +1 crest
  let trough = 0; // largest y = smallest v = the −1 trough
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].y < pts[peak].y) peak = i;
    if (pts[i].y > pts[trough].y) trough = i;
  }
  // Phase 0 sits at the left edge and increases rightward: the crest
  // (phase π/2) lands in the first quarter, the trough (phase 3π/2)
  // in the third — a mirrored or quarter-shifted x map would fail.
  assert.ok(peak < PREVIEW_W / 2, `crest at x ${peak} is not in the first half`);
  assert.ok(Math.abs(peak - PREVIEW_W / 4) <= 2, `crest at x ${peak} is far from W/4`);
  assert.ok(trough > PREVIEW_W / 2, `trough at x ${trough} is not in the second half`);
  assert.ok(Math.abs(trough - (3 * PREVIEW_W) / 4) <= 2, `trough at x ${trough} is far from 3W/4`);
});

test('drawShapeWave: a second draw on the same canvas re-clears (no accumulation)', () => {
  const { canvas, ctx } = stubCanvas(PREVIEW_W, PREVIEW_H);
  drawShapeWave(canvas, 'sine', SHAPE_COLOR);
  assert.equal(ctx.calls.filter(([k]) => k === 'clearRect').length, 1);
  const afterFirst = ctx.calls.length;

  drawShapeWave(canvas, 'square', '#00ff00');

  // The second draw's calls start with its own clearRect: the first
  // paint is wiped, not drawn over (no accumulation).
  const fresh = ctx.calls.slice(afterFirst);
  assert.deepEqual(fresh[0], ['clearRect', 0, 0, PREVIEW_W, PREVIEW_H]);
  assert.equal(ctx.calls.filter(([k]) => k === 'clearRect').length, 2);
  // …and the new shape is painted in the new color (exactly one such
  // trace now; the sine trace belongs to the cleared first frame).
  const traces = ctx.strokes.filter((s) => s.strokeStyle === '#00ff00');
  assert.equal(traces.length, 1);
  assert.equal(traces[0].lineWidth, 2);
});

test('drawShapeWave: an unknown shape throws (the waveShapePoints error propagates) before any paint', () => {
  const { canvas, ctx } = stubCanvas(PREVIEW_W, PREVIEW_H);
  assert.throws(
    () => drawShapeWave(canvas, 'pulse', SHAPE_COLOR),
    (e) => e instanceof Error && /unknown wave shape "pulse"/.test(e.message),
  );
  // The throw happens at the sampling step: the canvas is cleared, but
  // neither the midline nor a trace was painted — the caller
  // (buildShapeGroup) only passes the four known shapes, and an
  // unknown stored value simply gets no preview.
  assert.equal(ctx.calls.filter(([k]) => k === 'clearRect').length, 1);
  assert.equal(ctx.strokes.length, 0, 'no midline, no trace');
});

test('drawShapeWave: S10 — the preview paints the two strokes plus exactly one faint gradient fill (the S9 "no fills" pin is replaced, GUIDELINES §4)', () => {
  // Plan "colors" S10 (an INTENTIONAL expectation change, said so in
  // the commit message per GUIDELINES §4): the "two strokes, no
  // fills" state this test pinned in S9 is gone by design — the
  // preview now adds one faint gradient fill under the trace (0.12 of
  // the trace color fading to 0) so it stops looking like a bare
  // squiggle. The two strokes stay; there is STILL no glow (the
  // shadow language belongs to the band and the envelope editor).
  for (const shape of ['sine', 'square']) {
    const { canvas, ctx } = stubCanvas(PREVIEW_W, PREVIEW_H);
    drawShapeWave(canvas, shape, SHAPE_COLOR);
    assert.equal(ctx.strokes.length, 2, `${shape}: midline + trace (unchanged)`);
    assert.equal(ctx.gradients.length, 1, `${shape}: the one gradient fill`);
    assert.equal(ctx.fills.length, 1, `${shape}: exactly one fill`);
    assert.equal(ctx.fills[0].fillStyle, ctx.gradients[0], `${shape}: the fill is the gradient sentinel`);
    assert.equal(ctx.calls.filter(([k]) => k === 'shadowBlur').length, 0, `${shape}: still no glow`);
  }
});
