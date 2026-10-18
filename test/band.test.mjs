// Tests for src/app/band.js — the band's pure math (plan newui
// P2/S5): pitchCurvePoints (carrier-frequency samples of one FM
// layer's pitch curve, sampled from the facade's envelopeValue),
// hzToNoteName (the 12-TET point labels, "48.4Hz G1" / "1.3kHz D#6"
// Geonkick style), and bandTMaxFor (the band's time axis = the drum's
// duration) — and the drawing half (P2/S6): the logYScale /
// curveHzRange / pitchCurveToPixels pixel helpers, and drawBand (wave
// mode: background + ms axis + the glowing drum-hue mix waveform + its
// gradient area fill (plan "colors" S9) + per-curve pitch lines + note
// labels + working-source handles; spectrum mode: delegated to viz.js's
// drawSpectrum, whose bars wear per-bar hue-ramped gradients) with the
// recording stub-2D-context technique (the test/viz.test.mjs
// precedent: records calls, throws on non-finite coordinates — the free
// NaN guard).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BAND_HANDLE_RADIUS,
  bandHzRange,
  bandTMaxFor,
  curveHzRange,
  drawBand,
  hzToNoteName,
  logYScale,
  pitchCurvePoints,
  pitchCurveToPixels,
} from '../src/app/band.js';
import {
  COLORS,
  PAD_BOTTOM,
  PAD_TOP,
  dbScale,
  spectrumMagnitudes,
  withAlpha,
  waveformPoints,
} from '../src/app/viz.js';
import { envelopeValue, kickPatch } from '../src/lib/index.js';

// Approximate equality, tolerance scaled to the magnitude (the
// property-assertion style of the viz/knob tests). The curve samples
// live in a Float32Array, so they carry Float32 rounding (~1.2e-7
// relative) against the double-precision envelopeValue reference:
// 1e-6 relative is ~one ten-thousandth of a cent — still effectively
// exact.
const close = (a, b) =>
  Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

// A constant-frequency FM layer (no pitchEnv): the carrier is the flat
// 220 Hz the band must draw.
const flatLayer = { type: 'fm', carrier: { freq: 220 }, modulators: [] };

// A 2-point pitch envelope 100 -> 50 Hz in 30 ms — the kick recipe
// shape (drum_generation.md), the classic drum thump.
const glideEnv = [{ t: 0, v: 100 }, { t: 0.03, v: 50 }];
const glideLayer = { type: 'fm', carrier: { freq: 50 }, pitchEnv: glideEnv, modulators: [] };

// ---- pitchCurvePoints --------------------------------------------------

test('pitchCurvePoints: constant-freq layer -> flat array at the freq', () => {
  const pts = pitchCurvePoints(flatLayer, 0.5, 16);
  assert.ok(pts instanceof Float32Array, 'a Float32Array of Hz samples');
  assert.equal(pts.length, 16); // output length = n
  for (const p of pts) assert.equal(p, 220);
  // A carrier freq that is not exactly representable still comes out
  // at the carrier value (Float32 rounding, not a different note).
  const f = pitchCurvePoints(
    { type: 'fm', carrier: { freq: 48.4 }, modulators: [] }, 0.5, 4,
  );
  for (const p of f) assert.ok(close(p, 48.4), `48.4 -> ${p}`);
});

test('pitchCurvePoints: pitchEnv layer -> first 100, last 50, monotone between', () => {
  // The axis spans the glide itself, so every sample sits inside the
  // 100 -> 50 sweep: strictly decreasing, endpoints exact.
  const duration = 0.03;
  const n = 21;
  const pts = pitchCurvePoints(glideLayer, duration, n);
  assert.equal(pts.length, n);
  assert.equal(pts[0], 100); // t = 0
  assert.equal(pts[n - 1], 50); // t = duration
  for (let i = 0; i < n - 1; i++)
    assert.ok(
      pts[i] > pts[i + 1],
      `not strictly decreasing at sample ${i}: ${pts[i]} -> ${pts[i + 1]}`,
    );
  // Mid point: sample 10 sits at t = 10·0.03/20 = 15 ms, exactly the
  // way the plan asks — sampled via envelopeValue (the source of
  // truth), which resolves to 75 Hz at the glide's midpoint.
  assert.equal(pts[10], envelopeValue(glideEnv, (10 * duration) / (n - 1)));
  assert.ok(close(pts[10], 75));
});

test('pitchCurvePoints: tracks the real kick body over a 0.5 s axis', () => {
  // The actual kick patch (src/lib/voices/kick.js): the pitch env is
  // 100 -> 50 Hz in 30 ms, then envelopeValue's clamp holds 50 for the
  // rest of the hit — first sample 100, last sample 50, non-increasing
  // throughout.
  const layer = kickPatch().layers[0];
  const duration = 0.5;
  const n = 441;
  const pts = pitchCurvePoints(layer, duration, n);
  assert.equal(pts.length, n);
  assert.equal(pts[0], 100);
  assert.equal(pts[n - 1], 50); // held after the 30 ms glide
  for (let i = 0; i < n - 1; i++)
    assert.ok(pts[i] >= pts[i + 1], `not non-increasing at sample ${i}`);
  // A mid-glide sample against envelopeValue at that sample's own time
  // (Float32-tolerant: the sample is stored in the Float32Array, the
  // reference is double precision).
  const i = 13; // t = 13·0.5/440 ≈ 14.8 ms, inside the 30 ms glide
  assert.ok(close(pts[i], envelopeValue(layer.pitchEnv, (i * duration) / (n - 1))));
  assert.ok(pts[i] > 50 && pts[i] < 100);
});

test('pitchCurvePoints: n = 1 and n = 2 work', () => {
  // n = 1: the degenerate span — the single sample is t = 0 (no
  // division by n−1 = 0).
  assert.deepEqual([...pitchCurvePoints(glideLayer, 0.03, 1)], [100]);
  assert.deepEqual([...pitchCurvePoints(flatLayer, 0.5, 1)], [220]);
  // n = 2: the two endpoints, t = 0 and t = duration.
  assert.deepEqual([...pitchCurvePoints(glideLayer, 0.03, 2)], [100, 50]);
  assert.deepEqual([...pitchCurvePoints(flatLayer, 0.5, 2)], [220, 220]);
});

test('pitchCurvePoints: throws for non-FM layers (FM sources only)', () => {
  const noise = { type: 'noise', seed: 1, cutoff: 2000, decay: 0.02, gain: 0.2 };
  assert.throws(
    () => pitchCurvePoints(noise, 0.5, 16),
    (e) => e instanceof Error && /FM layers only/.test(e.message),
  );
  // Unknown or missing type is a caller bug too — fail loudly, do not
  // draw a phantom curve.
  assert.throws(() => pitchCurvePoints({ type: 'ring' }, 0.5, 4), /FM layers only/);
  assert.throws(() => pitchCurvePoints({}, 0.5, 4), /FM layers only/);
  assert.throws(() => pitchCurvePoints(null, 0.5, 4), /FM layers only/);
});

test('pitchCurvePoints: rejects a non-positive or non-integer sample count', () => {
  assert.throws(() => pitchCurvePoints(flatLayer, 0.5, 0), /positive integer/);
  assert.throws(() => pitchCurvePoints(flatLayer, 0.5, -3), /positive integer/);
  assert.throws(() => pitchCurvePoints(flatLayer, 0.5, 1.5), /positive integer/);
});

// ---- hzToNoteName ------------------------------------------------------

test('hzToNoteName: the A octave series lands on the right names', () => {
  assert.equal(hzToNoteName(440), '440.0Hz A4');
  assert.equal(hzToNoteName(220), '220.0Hz A3');
  assert.equal(hzToNoteName(110), '110.0Hz A2');
});

test('hzToNoteName: 48.4 Hz -> "48.4Hz G1", with the exact nearest note within ±1 cent of the bound', () => {
  assert.equal(hzToNoteName(48.4), '48.4Hz G1');
  // ±1 cent check via exact computation: G1 is MIDI 31, i.e.
  // 440·2^((31−69)/12) Hz. 48.4 must be the NEAREST 12-TET note, i.e.
  // within half a semitone (50 cents) of G1 — asserted with 1 cent of
  // slack for float error in the cent math.
  const g1Hz = 440 * 2 ** ((31 - 69) / 12);
  const cents = 1200 * Math.log2(48.4 / g1Hz);
  assert.ok(
    Math.abs(cents) <= 50 + 1,
    `48.4 Hz is ${cents.toFixed(2)} cents from G1 — G1 is not the closest note`,
  );
  // And the neighbouring semitones are genuinely further away.
  const fsharp1Hz = 440 * 2 ** ((30 - 69) / 12);
  const g1Below = Math.abs(1200 * Math.log2(48.4 / g1Hz));
  const fsharpBelow = Math.abs(1200 * Math.log2(48.4 / fsharp1Hz));
  assert.ok(g1Below < fsharpBelow, 'G1 must be closer than F#1');
});

test('hzToNoteName: 1318.5 Hz -> "1.3kHz E6"', () => {
  assert.equal(hzToNoteName(1318.5), '1.3kHz E6');
});

test('hzToNoteName: >= 1000 Hz switches to kHz with one decimal', () => {
  assert.equal(hzToNoteName(1000), '1.0kHz B5'); // the switch point
  assert.equal(hzToNoteName(2000), '2.0kHz B6');
  assert.equal(hzToNoteName(1318.5), '1.3kHz E6'); // kHz style, one decimal
  assert.equal(hzToNoteName(999.9), '999.9Hz B5'); // just under: still Hz
});

test('hzToNoteName: never throws for any positive frequency; no NaN at the audio extremes', () => {
  for (const hz of [20, 48.4, 440, 2000, 22000, 1e6, 1e-6]) {
    const s = hzToNoteName(hz); // must not throw
    assert.ok(!s.includes('NaN'), `${hz} -> ${s} (NaN in label)`);
    // The point-label shape: "<freq>Hz|<freq>kHz <Note><Octave>".
    assert.match(s, /^\d+\.\d+(Hz|kHz) [A-G]#?-?\d+$/, `${hz} -> ${s}`);
  }
  // The audio extremes pinned exactly (the carrier range, controls.js).
  // 20 Hz is just above the D0/D#0 boundary (19.0 Hz on the log scale),
  // so the closest semitone is D#0, not D0.
  assert.equal(hzToNoteName(20), '20.0Hz D#0');
  assert.equal(hzToNoteName(22000), '22.0kHz F10');
});

test('hzToNoteName: non-positive and non-finite input fails loudly', () => {
  for (const bad of [0, -1, NaN, Infinity, -Infinity])
    assert.throws(() => hzToNoteName(bad), (e) =>
      e instanceof Error && /positive finite/.test(e.message));
});

// ---- bandTMaxFor ---------------------------------------------------------

test('bandTMaxFor: the band time axis is the drum duration (derived, not hardcoded)', () => {
  assert.equal(bandTMaxFor({ name: 'kick', duration: 0.5, patch: {} }), 0.5);
  assert.equal(bandTMaxFor({ name: 'cymbal', duration: 1.5, patch: {} }), 1.5);
  // Whatever the drum carries is what the axis shows — no table lookup.
  assert.equal(bandTMaxFor({ name: 'x', duration: 0.25, patch: {} }), 0.25);
});

// ---- logYScale (P2/S6) -----------------------------------------------

test('logYScale: hz -> y -> hz round-trips inside the range; endpoints on the plot edges', () => {
  const { toY, toHz } = logYScale(50, 1000, 180);
  for (const hz of [50, 61.7, 100, 220, 440, 723.5, 999, 1000])
    assert.ok(close(toHz(toY(hz)), hz), `round-trip at ${hz}: ${toHz(toY(hz))}`);
  // High Hz at the top (y = 0), low Hz at the bottom (y = plotH).
  assert.equal(toY(1000), 0);
  assert.equal(toY(50), 180);
});

test('logYScale: monotone — higher Hz -> smaller y, and toHz inverts', () => {
  const { toY, toHz } = logYScale(20, 22000, 200);
  let prevY = Infinity;
  for (const hz of [20, 50, 100, 250, 1000, 8000, 22000]) {
    const y = toY(hz);
    assert.ok(y < prevY, `toY not strictly decreasing at ${hz}`);
    prevY = y;
  }
  let prevHz = -Infinity;
  for (let y = 200; y >= 0; y -= 7) {
    const hz = toHz(y);
    assert.ok(hz > prevHz, `toHz not strictly increasing as y falls, at y=${y}`);
    prevHz = hz;
  }
});

test('logYScale: clamped outside the range — never leaves the plot', () => {
  const { toY, toHz } = logYScale(50, 2000, 100);
  assert.equal(toY(1), 100); // far below min -> the bottom edge
  assert.equal(toY(50), 100);
  assert.equal(toY(2000), 0); // far above max -> the top edge
  assert.equal(toY(1e6), 0);
  assert.equal(toHz(-10), toHz(0)); // y clamps at the top -> maxHz
  assert.equal(toHz(1e9), toHz(100)); // y clamps at the bottom -> minHz
  assert.ok(close(toHz(0), 2000));
  assert.ok(close(toHz(100), 50));
});

test('logYScale: degenerate ranges (flat, bad input) stay finite and total', () => {
  for (const [lo, hi] of [[220, 220], [0, 0], [-5, 10], [NaN, 500]]) {
    const { toY, toHz } = logYScale(lo, hi, 120);
    for (const hz of [1, 220, 5000])
      assert.ok(Number.isFinite(toY(hz)), `toY(${hz}) for [${lo}, ${hi}]`);
    for (const y of [0, 60, 120])
      assert.ok(Number.isFinite(toHz(y)), `toHz(${y}) for [${lo}, ${hi}]`);
  }
});

// ---- curveHzRange (P2/S6) ----------------------------------------------

test('curveHzRange: the min/max over every curve sample; [0, 0] when empty', () => {
  assert.deepEqual(curveHzRange([curveA(), curveB()]), [50, 300]);
  assert.deepEqual(curveHzRange([]), [0, 0]);
  assert.deepEqual(curveHzRange([{ points: new Float32Array([220]) }]), [220, 220]);
});

// ---- pitchCurveToPixels (P2/S6) ----------------------------------------

test('pitchCurveToPixels: x spans 0..width linearly in time, y via the scale', () => {
  const toY = logYScale(50, 1000, 100).toY;
  const px = pitchCurveToPixels(Float32Array.from([100, 200, 400]), 0.5, 600, toY);
  assert.ok(px instanceof Float32Array);
  assert.equal(px.length, 6);
  const expect = [0, toY(100), 300, toY(200), 600, toY(400)];
  for (let i = 0; i < 6; i++)
    assert.ok(close(px[i], expect[i]), `px[${i}]: ${px[i]} vs ${expect[i]}`);
  // A longer sample span: x_i = i/(n−1)·width (the pitchCurvePoints grid).
  const many = pitchCurveToPixels(new Float32Array(11).fill(100), 0.2, 440, toY);
  for (let i = 0; i < 11; i++)
    assert.ok(close(many[i * 2], (i / 10) * 440), `x[${i}]: ${many[i * 2]}`);
});

test('pitchCurveToPixels: n = 1 (x = 0), n = 2 (both endpoints), empty (no crash)', () => {
  const toY = logYScale(50, 1000, 100).toY;
  const one = pitchCurveToPixels(new Float32Array([200]), 0.5, 600, toY);
  assert.ok(close(one[0], 0) && close(one[1], toY(200)));
  const two = pitchCurveToPixels(new Float32Array([100, 200]), 0.5, 600, toY);
  assert.ok(close(two[0], 0) && close(two[1], toY(100)));
  assert.ok(close(two[2], 600) && close(two[3], toY(200)));
  const empty = pitchCurveToPixels(new Float32Array(0), 0.5, 600, toY);
  assert.ok(empty instanceof Float32Array);
  assert.equal(empty.length, 0);
});

// ---- drawBand (P2/S6): the recording stub 2D context -------------------
//
// The recording 2D-context technique (the test/viz.test.mjs precedent):
// every call is recorded, every coordinate is asserted finite (a free
// NaN guard — the stub throws on a non-finite coordinate), and
// stroke()/fill() snapshot the current path + style into ctx.strokes /
// ctx.fills so a test can ask "which stroke used which color, width,
// and opacity" without replaying the call list. createLinearGradient
// returns a distinct sentinel object { __gradient: [x0, y0, x1, y1] }
// (assignable to fillStyle/strokeStyle, asserted by identity) whose
// addColorStop records [offset, color] into its own stops — the plan
// "colors" S9 gradient assertions; the sentinels also collect into
// ctx.gradients in creation order. shadowColor/shadowBlur assignments
// are recorded (the glow-reset assertions).

const NOTE_LABEL = /^\d+\.\d+(Hz|kHz) [A-G]#?\d+$/;

const stubBandCanvas = (width, height) => {
  const calls = [];
  const strokes = [];
  const fills = [];
  const gradients = [];
  const finite = (name, ...nums) => {
    for (const v of nums)
      assert.ok(Number.isFinite(v), `${name}: non-finite coordinate ${v}`);
  };
  let fillStyle, strokeStyle, lineWidth = 1, globalAlpha = 1, font, textAlign;
  let shadowColor, shadowBlur = 0; // the real canvas default (glow-free start)
  let path = [];
  const record = (name, ...args) => calls.push([name, ...args]);
  const ctx = {
    calls,
    strokes,
    fills,
    gradients,
    set fillStyle(v) { fillStyle = v; record('fillStyle', v); },
    get fillStyle() { return fillStyle; },
    set strokeStyle(v) { strokeStyle = v; record('strokeStyle', v); },
    get strokeStyle() { return strokeStyle; },
    set lineWidth(v) { lineWidth = v; record('lineWidth', v); },
    get lineWidth() { return lineWidth; },
    set globalAlpha(v) { globalAlpha = v; record('globalAlpha', v); },
    get globalAlpha() { return globalAlpha; },
    set shadowColor(v) { shadowColor = v; record('shadowColor', v); },
    get shadowColor() { return shadowColor; },
    set shadowBlur(v) { shadowBlur = v; record('shadowBlur', v); },
    get shadowBlur() { return shadowBlur; },
    set font(v) { font = v; record('font', v); },
    get font() { return font; },
    set textAlign(v) { textAlign = v; record('textAlign', v); },
    get textAlign() { return textAlign; },
    createLinearGradient(x0, y0, x1, y1) {
      finite('createLinearGradient', x0, y0, x1, y1);
      record('createLinearGradient', x0, y0, x1, y1);
      const grad = { __gradient: [x0, y0, x1, y1], stops: [] };
      grad.addColorStop = (offset, color) => {
        grad.stops.push([offset, color]);
        record('addColorStop', offset, color);
      };
      gradients.push(grad);
      return grad;
    },
    beginPath() { path = []; record('beginPath'); },
    closePath() { record('closePath'); },
    moveTo(x, y) { finite('moveTo', x, y); path.push({ x, y }); record('moveTo', x, y); },
    lineTo(x, y) { finite('lineTo', x, y); path.push({ x, y }); record('lineTo', x, y); },
    arc(x, y, r) { finite('arc', x, y, r); path.push({ x, y, r }); record('arc', x, y, r); },
    fillRect(x, y, w, h) { finite('fillRect', x, y, w, h); record('fillRect', x, y, w, h); },
    fillText(text, x, y) { finite('fillText', x, y); record('fillText', text, x, y); },
    stroke() { strokes.push({ pts: path.slice(), strokeStyle, lineWidth, globalAlpha }); path = []; record('stroke'); },
    fill() { fills.push({ pts: path.slice(), fillStyle, globalAlpha }); path = []; record('fill'); },
    save() { record('save'); },
    restore() { record('restore'); },
    translate(x, y) { finite('translate', x, y); record('translate', x, y); },
    measureText: (text) => ({ width: 30, text }),
  };
  // The canvas: the drawing target (the band is a READ-ONLY overview —
  // plan "dahdsr" P4/S2 retired its editing half, so no pointer-surface
  // stub is needed anymore; drawBand only touches the 2D context).
  const canvas = { width, height, getContext: () => ctx };
  return { canvas, ctx };
};

// The fillText calls whose text is a note label (hzToNoteName output —
// "<freq>Hz|<freq>kHz <Note><Octave>"): the band's per-point labels,
// distinct from the axis tick labels (plain numbers / "<n> ms").
const noteLabels = (calls) =>
  calls.filter(([kind, text]) => kind === 'fillText' && NOTE_LABEL.test(text));

// Wave-mode test data: a 0.5 s decaying 80 Hz "hit" at 1000 Hz on a
// 400x200 band (plotH = 174), and two FM curves — a 100 -> 50 Hz glide
// (2 env points) and a flat 300 Hz carrier (1 anchor).
const BW = 400;
const BH = 200;
const BSR = 1000;
const BDUR = 0.5;
const mixBuffer = (() => {
  const buf = new Float32Array(500);
  for (let i = 0; i < buf.length; i++)
    buf[i] = Math.sin((2 * Math.PI * 80 * i) / BSR) * Math.exp(-i / 100);
  return buf;
})();
const curveA = () => ({
  points: Float32Array.from({ length: 24 }, (_, i) => 100 - (50 * i) / 23),
  color: '#ffb454',
  label: 'Source 1',
  layerIndex: 0,
  env: [{ t: 0, v: 100 }, { t: 0.03, v: 50 }],
});
const curveB = () => ({
  points: new Float32Array(24).fill(300),
  color: '#5cb3ff',
  label: 'Source 2',
  layerIndex: 2,
  env: [{ t: 0, v: 300 }],
});
// The log scale the wave-mode drawing uses for this data: the drawn
// curves' range [50, 300] over the 174 px plot.
const rangeScale = logYScale(50, 300, BH - PAD_TOP - PAD_BOTTOM);

test('drawBand wave mode: background, ms axis, accent waveform, one stroke per curve, note labels, working highlight', () => {
  const { canvas, ctx } = stubBandCanvas(BW, BH);
  drawBand(canvas, {
    mixBuffer, sr: BSR, duration: BDUR,
    curves: [curveA(), curveB()], workingIndex: 1, mode: 'wave',
  });
  const calls = ctx.calls;

  // One background fillRect, the whole canvas — wave mode has no other
  // fillRects (the waveform and the curves are strokes, the handles
  // are arc fills).
  const rects = calls.filter(([k]) => k === 'fillRect');
  assert.equal(rects.length, 1);
  assert.deepEqual(rects[0], ['fillRect', 0, 0, BW, BH]);

  // The ms time axis ran (drawAxis's last tick carries the unit).
  assert.ok(calls.some(([k, t]) => k === 'fillText' && t === '400 ms'));

  // The log-frequency ticks: only those inside the drawn range
  // [50, 300] -> 50 / 100 / 200, right-aligned at W − 15.
  const freqTicks = calls
    .filter(([k, t, x]) => k === 'fillText' && x === BW - 15)
    .map(([, t]) => t);
  assert.deepEqual(freqTicks, ['50', '100', '200']);

  // The mix waveform: exactly one stroke in the accent color, one
  // vertical segment per pixel column.
  const trace = ctx.strokes.filter((s) => s.strokeStyle === COLORS.trace);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].pts.length, 2 * BW);
  assert.equal(trace[0].globalAlpha, 1);

  // One stroke per curve, in the distinct source colors; curve A's
  // polyline runs the full width at the scale's y values.
  const strokeA = ctx.strokes.filter((s) => s.strokeStyle === curveA().color);
  const strokeB = ctx.strokes.filter((s) => s.strokeStyle === curveB().color);
  assert.equal(strokeA.length, 1);
  assert.equal(strokeB.length, 1);
  assert.notEqual(curveA().color, curveB().color);
  assert.equal(strokeA[0].pts.length, 24); // one vertex per sample
  assert.ok(close(strokeA[0].pts[0].x, 0));
  assert.ok(close(strokeA[0].pts[0].y, PAD_TOP + rangeScale.toY(100)));
  const aLast = strokeA[0].pts[strokeA[0].pts.length - 1];
  assert.ok(close(aLast.x, BW));
  assert.ok(close(aLast.y, PAD_TOP + rangeScale.toY(50)));

  // The working curve (B): full opacity + 2 px; the other: 45% + 1.5 px.
  assert.equal(strokeB[0].globalAlpha, 1);
  assert.equal(strokeB[0].lineWidth, 2);
  assert.ok(Math.abs(strokeA[0].globalAlpha - 0.45) < 1e-9);
  assert.equal(strokeA[0].lineWidth, 1.5);

  // One hzToNoteName label per pitch point (A: 2 env points, B: 1
  // anchor), in curve order.
  const labels = noteLabels(calls);
  assert.equal(labels.length, 3);
  assert.deepEqual(labels.map(([, t]) => t), [
    hzToNoteName(100), hzToNoteName(50), hzToNoteName(300),
  ]);
  // The labels sit above their points …
  assert.ok(labels[0][3] < PAD_TOP + rangeScale.toY(100));
  assert.ok(labels[1][3] < PAD_TOP + rangeScale.toY(50));
  // … except the point at the very top edge (B's 300 Hz anchor, canvas
  // y = PAD_TOP), where the label flips below the point.
  assert.ok(labels[2][3] > PAD_TOP);

  // Handles: only on the working curve — one filled circle per anchor,
  // at the anchor's true position, with the handle radius.
  const fillsB = ctx.fills.filter((f) => f.fillStyle === curveB().color);
  assert.equal(fillsB.length, 1);
  assert.equal(fillsB[0].pts.length, 1);
  assert.equal(fillsB[0].pts[0].r, BAND_HANDLE_RADIUS);
  assert.ok(close(fillsB[0].pts[0].x, 0));
  assert.ok(close(fillsB[0].pts[0].y, PAD_TOP + rangeScale.toY(300)));
  assert.ok(!ctx.fills.some((f) => f.fillStyle === curveA().color),
    'no handles for a non-working curve');

  // Only finite coordinates (the stub already throws; pin the whole
  // call list explicitly, like the viz tests).
  for (const c of calls)
    for (const v of c)
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `non-finite in ${c[0]}`);
});

test('drawBand wave mode: mixColor tints the mix waveform trace (default COLORS.trace)', () => {
  const { canvas, ctx } = stubBandCanvas(BW, BH);
  drawBand(canvas, {
    mixBuffer, sr: BSR, duration: BDUR,
    curves: [curveA(), curveB()], workingIndex: 1, mode: 'wave',
    mixColor: '#38bdf8',
  });
  // The mix waveform stroke wears the passed drum hue instead of the
  // brand accent: exactly one full-width trace in the tint, none in
  // the default (the per-curve pitch lines keep their own source
  // colors — S10 refines them, untouched here).
  const tinted = ctx.strokes.filter((s) => s.strokeStyle === '#38bdf8');
  assert.equal(tinted.length, 1);
  assert.equal(tinted[0].pts.length, 2 * BW);
  assert.equal(tinted[0].globalAlpha, 1);
  assert.ok(!ctx.strokes.some((s) => s.strokeStyle === COLORS.trace),
    'no accent trace when mixColor is passed');
  for (const color of [curveA().color, curveB().color])
    assert.equal(ctx.strokes.filter((s) => s.strokeStyle === color).length, 1);
  // The S9 area fill inherits the drum hue too: the gradient's stops
  // are the mix color (not the accent) at 0.28 -> 0 — the kick's fill
  // is green-tinted, the snare's orange (free color-coding in the
  // canvas, plan S9).
  assert.equal(ctx.gradients.length, 1, 'the mix area gradient');
  assert.deepEqual(ctx.gradients[0].stops, [
    [0, withAlpha('#38bdf8', 0.28)],
    [1, withAlpha('#38bdf8', 0)],
  ]);
});

test('drawBand wave mode: the mix trace glows (set around the stroke only, reset before the fill) and the mix color fills the area under it as a vertical gradient', () => {
  // A hue distinct from curveA's (#ffb454): the trace and the curve
  // strokes are told apart by their strokeStyle.
  const mixColor = '#38bdf8';
  const { canvas, ctx } = stubBandCanvas(BW, BH);
  drawBand(canvas, {
    mixBuffer, sr: BSR, duration: BDUR,
    curves: [curveA()], workingIndex: null, mixColor,
  });
  const calls = ctx.calls;
  const plotH = BH - PAD_TOP - PAD_BOTTOM;

  // The trace: one full-width stroke in the drum hue.
  const trace = ctx.strokes.filter((s) => s.strokeStyle === mixColor);
  assert.equal(trace.length, 1);
  assert.equal(trace[0].pts.length, 2 * BW);

  // Exactly ONE gradient: vertical, the full canvas height 0 -> H.
  assert.equal(ctx.gradients.length, 1, 'one gradient fill (the mix area)');
  const [grad] = ctx.gradients;
  assert.deepEqual(grad.__gradient, [0, 0, 0, BH], 'vertical 0 -> H');
  assert.deepEqual(grad.stops, [
    [0, withAlpha(mixColor, 0.28)],
    [1, withAlpha(mixColor, 0)],
  ]);

  // Exactly ONE fill, with that gradient (sentinel identity), painted
  // AFTER the trace stroke; its path is the trace's top edge closed to
  // the plot's bottom corners.
  assert.equal(ctx.fills.length, 1, 'one area fill (workingIndex null: no handles)');
  const [fill] = ctx.fills;
  assert.equal(fill.fillStyle, grad, 'the area fill wears the gradient sentinel');
  // The trace is the only stroke inside a save/restore block (the axis
  // and curve strokes are at depth 0).
  let depth = 0;
  let iTraceStroke = -1;
  for (let i = 0; i < calls.length; i += 1) {
    const [k] = calls[i];
    if (k === 'save') depth += 1;
    else if (k === 'restore') depth -= 1;
    else if (k === 'stroke' && depth > 0) iTraceStroke = i;
  }
  const iFill = calls.findIndex(([k]) => k === 'fill');
  assert.ok(iTraceStroke >= 0, 'the trace stroke ran');
  assert.ok(iFill > iTraceStroke, 'the fill comes after the trace stroke');
  const pts = waveformPoints(mixBuffer, BW, plotH);
  assert.equal(fill.pts.length, BW + 2, 'top edge + two bottom corners');
  assert.deepEqual(fill.pts[0], { x: 0, y: PAD_TOP + pts[0] });
  for (let x = 1; x < BW; x += 1)
    assert.deepEqual(fill.pts[x], { x, y: PAD_TOP + pts[x * 2] });
  assert.deepEqual(fill.pts[BW], { x: BW, y: BH - PAD_BOTTOM }, 'closes to the bottom-right corner');
  assert.deepEqual(fill.pts[BW + 1], { x: 0, y: BH - PAD_BOTTOM }, 'closes to the bottom-left corner');

  // The glow: shadowColor + shadowBlur 6 set AROUND the trace stroke
  // only — and shadowBlur returns to 0 BEFORE the fill, so the fill,
  // the pitch curves, and the playhead (painted over the band by
  // main.js) do not glow.
  const blurSets = calls
    .map(([k, v], i) => (k === 'shadowBlur' ? { i, v } : null))
    .filter(Boolean);
  assert.deepEqual(blurSets.map((s) => s.v), [6, 0], 'blur on, then off');
  const iShadowColor = calls.findIndex(([k, v]) => k === 'shadowColor' && v === mixColor);
  assert.ok(iShadowColor >= 0 && iShadowColor < blurSets[0].i, 'shadowColor set with the glow');
  assert.ok(blurSets[0].i < iTraceStroke, 'the glow is on before the trace stroke');
  assert.ok(iTraceStroke < blurSets[1].i, 'the glow is off after the trace stroke');
  assert.ok(blurSets[1].i < iFill, 'the reset precedes the area fill');
  assert.equal(ctx.shadowBlur, 0, 'the context leaves the band with the glow off');
});

test('drawBand wave mode: the working curve glows in its color (around the stroke only, reset after) and its handles carry the same halo (plan "colors" S10)', () => {
  const { canvas, ctx } = stubBandCanvas(BW, BH);
  drawBand(canvas, {
    mixBuffer, sr: BSR, duration: BDUR,
    curves: [curveA(), curveB()], workingIndex: 1, mode: 'wave',
  });
  const calls = ctx.calls;

  // The shadowBlur sets in paint order: the mix trace's S9 glow
  // (6 -> 0), the working curve's S10 glow (5 -> 0), and the working
  // handles' halo (5 -> 0). Nothing else glows.
  const blurSets = calls
    .map(([k, v], i) => (k === 'shadowBlur' ? { i, v } : null))
    .filter(Boolean);
  assert.deepEqual(blurSets.map((s) => s.v), [6, 0, 5, 0, 5, 0],
    'mix glow, working-curve glow, handle halo — in paint order');

  // The curve strokes are the last two strokes (axis + midline + mix
  // trace come first, in curve order A, B — B is the working one).
  const strokeIdx = calls.map(([k], i) => (k === 'stroke' ? i : -1)).filter((i) => i >= 0);
  const iStrokeA = strokeIdx[strokeIdx.length - 2];
  const iStrokeB = strokeIdx[strokeIdx.length - 1];
  const [iGlowOn, iGlowOff] = [blurSets[2].i, blurSets[3].i];
  // The glow wraps B's stroke only: on before it, off right after it,
  // and the non-working curve A is stroked in the shadow-free gap
  // before the glow turns on.
  assert.ok(iGlowOn < iStrokeB, 'the glow is on before the working stroke');
  assert.ok(iStrokeB < iGlowOff, 'the glow is off right after the working stroke');
  assert.ok(iStrokeA < iGlowOn, 'curve A (non-working) is stroked before the glow turns on');
  const iShadowColorB = calls.findIndex(([k, v]) => k === 'shadowColor' && v === curveB().color);
  assert.ok(iShadowColorB >= 0 && iShadowColorB < iGlowOn, 'the glow color is the working curve\'s');
  assert.ok(!calls.some(([k, v]) => k === 'shadowColor' && v === curveA().color),
    'no glow color for the non-working curve');

  // The handle halo wraps the working handles' fills only: the fill
  // order is the mix area fill first, then B's single anchor — the
  // halo is on before that fill and off after it, with the curve
  // glow already reset.
  const fillIdx = calls.map(([k], i) => (k === 'fill' ? i : -1)).filter((i) => i >= 0);
  const [iAreaFill, iHandleFill] = [fillIdx[0], fillIdx[1]];
  assert.equal(ctx.fills[0].fillStyle, ctx.gradients[0], 'the first fill is the S9 mix area gradient');
  assert.ok(iGlowOff < iHandleFill, 'the curve glow is off before the handle fills');
  const [iHaloOn, iHaloOff] = [blurSets[4].i, blurSets[5].i];
  assert.ok(iHaloOn < iHandleFill, 'the halo is on before the first handle fill');
  assert.ok(iHandleFill < iHaloOff, 'the halo is off after the last handle fill');
  assert.ok(iAreaFill < iHaloOn, '... and the area fill (painted earlier) is outside the halo');
  assert.equal(ctx.shadowBlur, 0, 'the context leaves the band with the glow off');
});

test('drawBand wave mode: workingIndex null -> no highlight, no handle paths at all', () => {
  const { canvas, ctx } = stubBandCanvas(BW, BH);
  drawBand(canvas, {
    mixBuffer, sr: BSR, duration: BDUR,
    curves: [curveA(), curveB()], workingIndex: null,
  });
  assert.equal(ctx.calls.filter(([k]) => k === 'arc').length, 0, 'no handle arcs');
  // The ONLY fill is the mix area fill (the S9 gradient) — no handles.
  assert.equal(ctx.fills.length, 1, 'only the mix area fill, no handle fills');
  assert.ok(ctx.fills[0].fillStyle.__gradient, 'the area fill is the gradient sentinel');
  for (const color of [curveA().color, curveB().color]) {
    const s = ctx.strokes.filter((st) => st.strokeStyle === color);
    assert.equal(s.length, 1);
    assert.ok(Math.abs(s[0].globalAlpha - 0.45) < 1e-9, `curve ${color} not dimmed`);
    assert.equal(s[0].lineWidth, 1.5, `curve ${color} not the thin width`);
  }
});

test('drawBand wave mode: a curve without env labels and handles its sample points on the time grid', () => {
  const { canvas, ctx } = stubBandCanvas(BW, BH);
  const noEnv = {
    points: Float32Array.from([100, 200, 400]),
    color: '#ff6b9d',
    label: 'Source 1',
    layerIndex: 0,
  };
  drawBand(canvas, { mixBuffer, sr: BSR, duration: BDUR, curves: [noEnv], workingIndex: 0 });
  const labels = noteLabels(ctx.calls);
  assert.deepEqual(labels.map(([, t]) => t),
    [hzToNoteName(100), hzToNoteName(200), hzToNoteName(400)]);
  // The three anchors sit on the uniform grid: 0, mid, W.
  const xs = labels.map(([, , x]) => x);
  assert.ok(close(xs[0], 0) && close(xs[1], BW / 2) && close(xs[2], BW));
  // Working -> a filled circle handle at every anchor (one fill per
  // arc path).
  const fills = ctx.fills.filter((f) => f.fillStyle === '#ff6b9d');
  assert.equal(fills.length, 3);
  for (const f of fills) {
    assert.equal(f.pts.length, 1);
    assert.equal(f.pts[0].r, BAND_HANDLE_RADIUS);
  }
});

test('drawBand wave mode: a label that would clip the top edge flips below its point', () => {
  const { canvas, ctx } = stubBandCanvas(BW, BH);
  const ramp = Float32Array.from({ length: 10 }, (_, i) => 500 + (500 * i) / 9);
  const topCurve = {
    points: ramp,
    color: '#c792ea',
    label: 'Source 3',
    layerIndex: 3,
    env: [{ t: 0, v: 500 }, { t: 0.1, v: 1000 }],
  };
  drawBand(canvas, { mixBuffer, sr: BSR, duration: BDUR, curves: [topCurve], workingIndex: null });
  const labels = noteLabels(ctx.calls);
  assert.equal(labels.length, 2);
  const scale = logYScale(500, 1000, BH - PAD_TOP - PAD_BOTTOM);
  // The 1000 Hz anchor sits at the very top of the plot: its label
  // cannot go above, so it is drawn below the point, inside the canvas.
  const top = labels.find(([, t]) => t === hzToNoteName(1000));
  assert.ok(top[3] > PAD_TOP, `flipped label y ${top[3]} must be below the top-edge point`);
  assert.ok(top[3] < BH);
  // The 500 Hz anchor is at the bottom edge: its label stays above.
  const bottom = labels.find(([, t]) => t === hzToNoteName(500));
  assert.ok(bottom[3] < PAD_TOP + scale.toY(500));
});

test('drawBand wave mode: no curves -> waveform + time axis only (no ticks, labels, handles)', () => {
  const { canvas, ctx } = stubBandCanvas(BW, BH);
  assert.doesNotThrow(() =>
    drawBand(canvas, { mixBuffer, sr: BSR, duration: BDUR, curves: [], workingIndex: null }));
  const calls = ctx.calls;
  assert.equal(calls.filter(([k]) => k === 'fillRect').length, 1);
  assert.equal(noteLabels(calls).length, 0);
  // Wave mode still paints the mix trace + its S9 gradient area fill
  // (no curves: no handle fills).
  assert.equal(ctx.fills.length, 1, 'only the mix area fill');
  assert.ok(ctx.fills[0].fillStyle.__gradient, 'the area fill is the gradient sentinel');
  assert.equal(calls.filter(([k, t, x]) => k === 'fillText' && x === BW - 15).length, 0,
    'no frequency ticks without curves');
  assert.equal(
    ctx.strokes.filter((s) => s.strokeStyle !== COLORS.grid
      && s.strokeStyle !== COLORS.mid && s.strokeStyle !== COLORS.trace).length,
    0, 'no curve strokes without curves');
});

test('drawBand: mode defaults to wave; an unknown mode fails loudly', () => {
  const { canvas } = stubBandCanvas(BW, BH);
  assert.doesNotThrow(() =>
    drawBand(canvas, { mixBuffer, sr: BSR, duration: BDUR, curves: [curveA()] }));
  assert.throws(
    () => drawBand(canvas, { mixBuffer, sr: BSR, duration: BDUR, mode: 'spectrum2' }),
    (e) => e instanceof Error && /unknown mode/.test(e.message),
  );
});

// ---- drawBand, spectrum mode (P2/S6) -----------------------------------

test('drawBand spectrum mode: delegates to drawSpectrum (hue-ramped gradient bars + kHz axis, no pitch curves)', () => {
  const { canvas, ctx } = stubBandCanvas(BW, BH);
  assert.doesNotThrow(() => drawBand(canvas, {
    mixBuffer, sr: BSR, duration: BDUR,
    curves: [curveA(), curveB()], workingIndex: 1, mode: 'spectrum',
  }));
  const calls = ctx.calls;
  const plotH = BH - PAD_TOP - PAD_BOTTOM;
  // The spectrum's own paint ran: the background first, then its bar
  // fills (many fillRects — unlike wave mode's single one), with the
  // kHz axis. (calls[0] is the fillStyle assignment the stub records;
  // the first fillRect is the background.)
  assert.deepEqual(calls.find(([k]) => k === 'fillRect'), ['fillRect', 0, 0, BW, BH]);
  // The S9 bars: one vertical hsl gradient per non-zero bar (replacing
  // the old flat COLORS.trace fill — an intentional expectation change,
  // plan "colors" S9). The bar geometry (log-scaled heights, one bin
  // per 2 px) is UNCHANGED: recompute from the same Goertzel
  // magnitudes and compare exactly.
  const binCount = Math.max(16, Math.floor(BW / 2)); // 200
  const barW = BW / binCount;
  const mags = spectrumMagnitudes(mixBuffer, BSR, binCount);
  let peak = 0;
  for (const m of mags) if (m > peak) peak = m;
  const expected = [];
  for (let i = 0; i < binCount; i += 1) {
    const h = peak > 0 ? dbScale(mags[i] / peak) * plotH : 0;
    if (h > 0) expected.push({ i, h });
  }
  const barRects = calls.filter(([k]) => k === 'fillRect').slice(1);
  assert.equal(barRects.length, expected.length, 'one bar per non-zero bin (heights unchanged)');
  assert.ok(barRects.length > 1, 'spectrum bar fills');
  expected.forEach(({ i, h }, n) => {
    assert.deepEqual(barRects[n], ['fillRect', i * barW, PAD_TOP + plotH - h, barW, h]);
  });
  // One gradient per non-zero bar: the bar's own vertical span (top ->
  // base), hsl(h, 85%, 62%) -> hsl(h, 85%, 62%, 0.35), h = 190 +
  // 140·(i/binCount).
  assert.equal(ctx.gradients.length, expected.length, 'N gradient fills for N bars');
  expected.forEach(({ i, h }, n) => {
    const hue = 190 + 140 * (i / binCount);
    assert.deepEqual(ctx.gradients[n].__gradient, [0, PAD_TOP + plotH - h, 0, PAD_TOP + plotH]);
    assert.deepEqual(ctx.gradients[n].stops, [
      [0, `hsl(${hue}, 85%, 62%)`],
      [1, `hsl(${hue}, 85%, 62%, 0.35)`],
    ]);
  });
  // The hue ramp, parsed from the recorded hsl strings: strictly
  // increasing across the drawn bars (cyan at low -> pink at high).
  const hues = ctx.gradients.map((g) => Number(/^hsl\(([\d.]+),/.exec(g.stops[0][1])[1]));
  for (let n = 1; n < hues.length; n += 1)
    assert.ok(hues[n] > hues[n - 1], `hue not increasing at bar ${n}: ${hues[n - 1]} -> ${hues[n]}`);
  assert.ok(!calls.some(([k, v]) => k === 'fillStyle' && v === COLORS.trace),
    'no flat accent bar fill any more');
  // The kHz axis ran (drawAxis labels the last tick with the unit;
  // at sr = 1000 the single 0 tick is "0 kHz").
  assert.ok(calls.some(([k, t]) => k === 'fillText' && t === '0 kHz'));
  // And no pitch curves: no curve-color stroke, no handles, no labels.
  assert.ok(!calls.some(([k, v]) => k === 'strokeStyle' && v === curveA().color));
  assert.ok(!calls.some(([k, v]) => k === 'strokeStyle' && v === curveB().color));
  assert.equal(ctx.fills.length, 0);
  assert.equal(noteLabels(calls).length, 0);
});

// ---- bandHzRange (P4/S11) ---------------------------------------------

test('bandHzRange: the all-curves min/max, widened one octave each side when degenerate', () => {
  // Non-degenerate: the raw range, unchanged.
  assert.deepEqual(bandHzRange([curveA(), curveB()]), [50, 300]);
  // A single flat curve (any point count): ±one octave around the freq.
  assert.deepEqual(bandHzRange([{ points: new Float32Array(24).fill(220) }]), [110, 440]);
  assert.deepEqual(bandHzRange([{ points: new Float32Array([220]) }]), [110, 440]);
  // The widened span keeps the flat curve exactly at the plot middle
  // (the old degenerate constant-scale position, plotH/2 — same pixels
  // as before the widening, a real span instead of none).
  assert.ok(close(logYScale(110, 440, 100).toY(220), 50));
  // No curves: an arbitrary span around 1 Hz — no tick candidate
  // (50..20000) falls inside it, so nothing is drawn.
  assert.deepEqual(bandHzRange([]), [0.5, 2]);
});

test('drawBand wave mode: a single flat curve uses the widened range (centered line, its 200 tick)', () => {
  const { canvas, ctx } = stubBandCanvas(BW, BH);
  const flat = {
    points: new Float32Array(24).fill(220),
    color: '#8593a6',
    label: 'Source 1',
    layerIndex: 0,
    env: [{ t: 0, v: 220 }],
  };
  drawBand(canvas, { mixBuffer, sr: BSR, duration: BDUR, curves: [flat], workingIndex: 0 });
  // The widened [110, 440] range admits the 200 tick candidate.
  const ticks = ctx.calls
    .filter(([k, t, x]) => k === 'fillText' && x === BW - 15)
    .map(([, t]) => t);
  assert.deepEqual(ticks, ['200']);
  // The flat line sits at the plot middle ...
  const stroke = ctx.strokes.find((s) => s.strokeStyle === flat.color);
  assert.ok(stroke, 'the flat curve is drawn');
  const y = stroke.pts[0].y;
  for (const p of stroke.pts) assert.ok(close(p.y, y), 'the line stays flat');
  assert.ok(close(y, PAD_TOP + (BH - PAD_TOP - PAD_BOTTOM) / 2), '... exactly centered');
  // ... and the working handle sits on it (one env anchor, at t = 0).
  const fills = ctx.fills.filter((f) => f.fillStyle === flat.color);
  assert.equal(fills.length, 1, 'one handle (the single env anchor)');
  assert.ok(close(fills[0].pts[0].y, y), 'the handle is on the centered line');
  assert.ok(close(fills[0].pts[0].x, 0), 'at t = 0');
});

test('drawBand wave mode: with two env curves, only the working curve draws handle circles', () => {
  const { canvas, ctx } = stubBandCanvas(BW, BH);
  drawBand(canvas, {
    mixBuffer, sr: BSR, duration: BDUR,
    curves: [curveA(), curveB()], workingIndex: 0, mode: 'wave',
  });
  const fillsA = ctx.fills.filter((f) => f.fillStyle === curveA().color);
  const fillsB = ctx.fills.filter((f) => f.fillStyle === curveB().color);
  assert.equal(fillsA.length, 2, 'the working curve (A) draws one circle per env point');
  assert.equal(fillsB.length, 0, 'the non-working curve (B) exposes no handles');
  for (const f of fillsA) assert.equal(f.pts[0].r, BAND_HANDLE_RADIUS);
});

