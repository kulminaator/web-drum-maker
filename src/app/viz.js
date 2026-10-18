// Canvas visuals for rendered drum hits: a peak-per-pixel waveform and
// a log-scale spectrum, drawn with the plain HTML5 canvas (README:
// "show the sound, don't just play it").
//
// Pure computation (waveformPoints, waveformPointsAt, timeToX,
// spectrumMagnitudes, dbScale, withAlpha) is separated from the DOM drawing
// (drawWaveform, drawOverlaidWaveforms, drawPlayhead, drawSpectrum,
// drawShapeWave) so the math is
// unit-testable under node --test without a canvas (GUIDELINES
// §1.2/§4). The draw* functions are the only I/O boundary: they touch
// only the canvas 2D context and do no audio math (GUIDELINES §3).

import { goertzelMag, waveShapePoints } from '../lib/index.js';
import { THEME } from './theme.js';

// Peak-per-pixel min/max of a hit buffer, mapped to canvas y.
//
// Returns a Float32Array of length 2·width: per pixel column,
// [yTop, yBottom] — the canvas y of the column's MAX sample and the y
// of its MIN sample. The sample → y map is y = height/2·(1 − v):
// v = +1 → 0 (top edge), v = 0 → height/2 (a zero buffer draws a flat
// midline), v = −1 → height (bottom edge). Per-column peak picking
// (instead of plotting every sample) keeps fast transients visible when
// the buffer is far longer than the canvas is wide — the dense "pretty"
// look the README asks for.
//
// Samples are assumed within ±1 (the engine's final clamp guarantees
// it). When width exceeds the sample count, trailing columns repeat
// the last covered sample so every column still has a peak.
export const waveformPoints = (buffer, width, height) => {
  const n = buffer.length;
  const points = new Float32Array(width * 2);
  const mid = height / 2;
  if (n === 0) {
    points.fill(mid);
    return points;
  }
  for (let x = 0; x < width; x++) {
    const start = Math.floor((x * n) / width);
    let end = Math.floor(((x + 1) * n) / width);
    if (end === start) end = start + 1; // wider than the buffer: hold the sample
    // Initialize from the first covered sample, not 0: a column whose
    // samples are all positive must NOT drag its bottom to the midline.
    let min = buffer[start];
    let max = buffer[start];
    for (let i = start + 1; i < end; i++) {
      const v = buffer[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    points[x * 2] = mid * (1 - max);     // y of the column max (top)
    points[x * 2 + 1] = mid * (1 - min); // y of the column min (bottom)
  }
  return points;
};

// Peak-per-pixel trace of `buffer` placed on a SHARED time axis of
// length tMax (s): the buffer (duration n/sr) occupies the first
// round((n/sr)/tMax · width) pixel columns, the remaining columns are
// flat midline. Reuses waveformPoints (full-buffer → full-width
// peak-per-pixel) on the covered sub-width, so peak semantics are
// identical to the single-drum view. Absolute time is the point:
// loop beats fire all drums at the same start time, so their attacks
// line up vertically on the overlaid main view (ui-refresh.md §4.2).
export const waveformPointsAt = (buffer, sr, tMax, width, height) => {
  const n = buffer.length;
  const points = new Float32Array(width * 2).fill(height / 2);
  if (n === 0) return points;
  const wCover = Math.min(width, Math.max(1, Math.round((n / sr / tMax) * width)));
  points.set(waveformPoints(buffer, wCover, height), 0);
  return points;
};

// Shared time → pixel-x map (pure; clamped to the plot).
//
// The same tMax-relative math as the trace placement (waveformPointsAt):
// absolute time t occupies the fraction t/tMax of the width, so on the
// overlaid main view the cursor passes through each trace exactly where
// that drum's audio is — including the hi-hat's 60 %-width placement.
// Out-of-range times clamp to the plot edges (ui-refresh.md §5.4).
export const timeToX = (t, tMax, width) => Math.max(0, Math.min(width, (t / tMax) * width));

// Per-bin magnitudes of a hit buffer for the spectrum view.
//
// Bin i (0 … binCount−1) is the Goertzel single-bin DFT magnitude at
// f_i = i · sr / (2·binCount): bin 0 is DC and the top bin sits just
// below Nyquist, so the bins span 0 … sr/2 at sr/(2·binCount) spacing.
// O(binCount·N) with fractional bins — at the 48 kHz preview rate
// with binCount ≈ width/2 that is ~10⁷ multiply-adds, comfortably
// interactive for slider-driven redraws.
export const spectrumMagnitudes = (buffer, sr, binCount) => {
  const mags = new Float32Array(binCount);
  const spacing = sr / (2 * binCount);
  for (let i = 0; i < binCount; i++)
    mags[i] = goertzelMag(buffer, i * spacing, sr);
  return mags;
};

// Log (dB) mapping of a normalized magnitude to a 0…1 canvas fraction.
//
// The input is a normalized magnitude (1.0 = full scale = 0 dB); the
// scale is logarithmic — the ear's loudness perception — with a floor
// at minDb (default −60 dB, the canvas noise floor): at or below the
// floor → 0, at or above 0 dB → 1. A 0 magnitude maps to exactly 0
// (log10(0) would be −∞, but the guard keeps the result finite).
export const dbScale = (mag, minDb = -60) => {
  if (mag <= 0) return 0;
  const db = 20 * Math.log10(mag);
  if (db <= minDb) return 0;
  if (db >= 0) return 1;
  return (db - minDb) / (0 - minDb);
};

// A color as an `rgba(r, g, b, a)` string with the given alpha — the
// canvas gradient stops need an alpha form of the (hex) trace color:
// the fill under the waveform fades 0.28 -> 0 of that color (plan
// "colors" S9). Accepts 6-digit hex (#rrggbb), 8-digit hex
// (#rrggbbaa — its stored alpha is replaced), and rgb()/rgba() strings
// (the alpha is replaced); anything else is a caller bug and fails
// loudly (repo style).
export const withAlpha = (color, a) => {
  let r, g, b;
  if (typeof color === 'string' && color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length !== 6 && hex.length !== 8)
      throw new Error(
        `withAlpha: expected a 6- or 8-digit hex color, ` + `got ${JSON.stringify(color)}`,
      );
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else {
    const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/.exec(String(color));
    if (!m)
      throw new Error(
        `withAlpha: expected a hex or rgb()/rgba() string, ` + `got ${JSON.stringify(color)}`,
      );
    [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

// ---- DOM drawing (the only I/O in this module) -----------------------

// Canvas palette: defined from the single source (src/app/theme.js's
// THEME; the CSS-mirrored tokens live in index.html's :root and the
// drift guard test/theme.test.mjs keeps them in lockstep — grid/mid/
// axis are canvas-only, deliberately no CSS twin). Exported so the
// envelope editor in src/app/main.js shares the same colors.
export const COLORS = {
  bg: THEME.canvasBg,
  grid: THEME.grid, // light grid lines
  mid: THEME.mid, // 0-amplitude reference line
  axis: THEME.axis, // tick labels
  trace: THEME.accent, // accent (waveform trace; the spectrum bars are hue-ramped, S9)
  playhead: THEME.playhead, // playback cursor
};

// Per-drum trace colors for the overlaid main view: re-exported from
// the single source (src/app/theme.js), mirrored as the --drum-*
// custom properties in index.html — the drift guard keeps the pairs in
// sync. Exported here (and not only from theme.js) so the existing
// consumers and tests keep their symbolic import.
export { DRUM_COLORS } from './theme.js';

// Plot area: a small top margin and a bottom margin holding the tick
// labels, so the trace/bars never collide with the axis text. Exported
// so the step-15 envelope editor in src/app/main.js uses the same margins.
export const PAD_TOP = 6;
export const PAD_BOTTOM = 20;

// First step from `candidates` such that at most 8 ticks fit in
// `range` (keeps the axis legible at any canvas size).
const niceStep = (range, candidates) => {
  for (const step of candidates) if (range / step <= 8) return step;
  return candidates[candidates.length - 1];
};

// One linear time/frequency axis: light vertical grid lines at nice
// steps plus tick labels along the bottom. Tick 0 is left-aligned at
// the left edge, the last tick carries the unit name and is
// right-aligned when it sits near the right edge. Exported for the
// step-15 envelope editor in src/app/main.js (shared time axis).
//
// The optional `start` (default 0) offsets the axis origin — the env
// editor's zoomed window [t0, t0 + span] draws the nice multiples of
// the step from the first one at or above `start`, labelled with the
// offset values, so the editor lines up with the band (same
// candidates, same style, same PAD constants). At start = 0 the ticks
// run from 0 exactly as before (every existing caller unchanged).
export const drawAxis = (g, W, H, range, candidates, unit, format, start = 0) => {
  if (range <= 0) return; // degenerate (empty) buffer: no axis
  const step = niceStep(range, candidates);
  const end = start + range;
  // The first tick: the first multiple of the step at or after start.
  // The 1e-9 index tolerance covers the start/step ratio's FP (a
  // panned window's t0 is arbitrary FP — a tick exactly at the window
  // start must not be rounded OUT); it is 1e-8 ms at the smallest
  // step, far below a visible position.
  const ticks = [];
  for (let i = start > 0 ? Math.ceil(start / step - 1e-9) : 0; ; i++) {
    const v = i * step;
    if (v >= end) break;
    ticks.push(v);
  }
  const last = ticks[ticks.length - 1];
  g.font = '11px system-ui, sans-serif';
  g.lineWidth = 1;
  for (const v of ticks) {
    const rel = v - start;
    const x = Math.round((rel / range) * W) + 0.5;
    if (rel > 1e-9) {
      g.strokeStyle = COLORS.grid;
      g.beginPath();
      g.moveTo(x, PAD_TOP);
      g.lineTo(x, H - PAD_BOTTOM);
      g.stroke();
    }
    g.fillStyle = COLORS.axis;
    g.textAlign = rel <= 1e-9 ? 'left' : x > W - 40 ? 'right' : 'center';
    // The label is the ABSOLUTE tick value (v) — for the env editor's
    // zoomed window the ticks are the drum's own times (100 ms, 125
    // ms, ...), not offsets from the window start (at start = 0 the
    // two are the same, as before).
    g.fillText(v === last ? `${format(v)} ${unit}` : format(v), x, H - 6);
  }
};

// Draw the time-domain view of a rendered hit: a peak-per-pixel accent
// trace with a soft glow and a gradient fill under the curve, on a dark
// background with a light time grid and ms tick labels.
export const drawWaveform = (canvas, buffer, sr) => {
  const g = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const plotH = H - PAD_TOP - PAD_BOTTOM;

  g.fillStyle = COLORS.bg;
  g.fillRect(0, 0, W, H);

  // Time axis: grid + labels in ms.
  drawAxis(
    g, W, H,
    (buffer.length * 1000) / sr,
    [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000], 'ms', String,
  );

  // 0-amplitude midline, slightly brighter than the grid.
  g.strokeStyle = COLORS.mid;
  g.lineWidth = 1;
  const midY = Math.round(PAD_TOP + plotH / 2) + 0.5;
  g.beginPath();
  g.moveTo(0, midY);
  g.lineTo(W, midY);
  g.stroke();

  // Peak-per-pixel trace: one vertical segment per pixel column. The
  // glow is set AROUND the stroke only — shadowBlur resets to 0 right
  // after, so the fill below (and every later paint) does not glow.
  const points = waveformPoints(buffer, W, plotH);
  g.save();
  g.translate(0, PAD_TOP);
  g.strokeStyle = COLORS.trace;
  g.shadowColor = COLORS.trace;
  g.shadowBlur = 6;
  g.beginPath();
  for (let x = 0; x < W; x++) {
    g.moveTo(x + 0.5, points[x * 2]);
    g.lineTo(x + 0.5, points[x * 2 + 1]);
  }
  g.stroke();
  g.shadowBlur = 0;
  g.restore();

  // The area under the curve: the trace's top edge closed to the plot's
  // bottom corners, filled with a vertical gradient from the trace color
  // at 0.28 (top) to fully transparent (bottom) — the DAW glow-fill
  // look. Painted in canvas coordinates (after the restore) so the
  // gradient spans the full canvas height 0..H.
  const fill = g.createLinearGradient(0, 0, 0, H);
  fill.addColorStop(0, withAlpha(COLORS.trace, 0.28));
  fill.addColorStop(1, withAlpha(COLORS.trace, 0));
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(0, PAD_TOP + points[0]);
  for (let x = 1; x < W; x++) g.lineTo(x, PAD_TOP + points[x * 2]);
  g.lineTo(W, H - PAD_BOTTOM);
  g.lineTo(0, H - PAD_BOTTOM);
  g.closePath();
  g.fill();
};

// All hits on one shared time axis (0 … tMax), one colored
// peak-per-pixel trace per entry, ms axis, and a colored legend
// (label per drum). entries: [{buffer, sr, color, label}]. The shared
// axis makes each hit's placement unambiguous — e.g. the hi-hat's
// shorter 60 %-width trace starts at the same x as every other hit
// (ui-refresh.md §4.2/§5.2).
export const drawOverlaidWaveforms = (canvas, entries, tMax) => {
  const g = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const plotH = H - PAD_TOP - PAD_BOTTOM;

  g.fillStyle = COLORS.bg;
  g.fillRect(0, 0, W, H);

  // Shared time axis: grid + labels in ms.
  drawAxis(
    g, W, H,
    tMax * 1000,
    [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000], 'ms', String,
  );

  // 0-amplitude midline, slightly brighter than the grid.
  g.strokeStyle = COLORS.mid;
  g.lineWidth = 1;
  const midY = Math.round(PAD_TOP + plotH / 2) + 0.5;
  g.beginPath();
  g.moveTo(0, midY);
  g.lineTo(W, midY);
  g.stroke();

  // One peak-per-pixel trace per entry, placed by absolute time on the
  // shared axis (waveformPointsAt leaves the uncovered columns flat).
  for (const entry of entries) {
    const points = waveformPointsAt(entry.buffer, entry.sr, tMax, W, plotH);
    g.save();
    g.translate(0, PAD_TOP);
    g.strokeStyle = entry.color;
    g.beginPath();
    for (let x = 0; x < W; x++) {
      g.moveTo(x + 0.5, points[x * 2]);
      g.lineTo(x + 0.5, points[x * 2 + 1]);
    }
    g.stroke();
    g.restore();
  }

  // Legend: one colored label per entry, top-left. All default level
  // envelopes start at 0, so no trace sits under the legend at the
  // default patches — and it is painted after the traces anyway.
  g.font = '11px system-ui, sans-serif';
  g.textAlign = 'left';
  let x = 8;
  for (const entry of entries) {
    g.fillStyle = entry.color;
    g.fillText(entry.label, x, PAD_TOP + 12);
    x += g.measureText(entry.label).width + 14;
  }
};

// Yellow vertical playback cursor at pixel x. Drawn OVER whatever the
// canvas shows — deliberately NO clear: the playhead animation loop in
// src/app/main.js repaints the base trace before calling, so the cursor
// hovers over a fresh frame instead of accumulating stripes. No-op
// when x is outside the plot (before start / after end / non-finite),
// so a clamped-but-past-the-end time simply draws nothing.
export const drawPlayhead = (canvas, x) => {
  if (!Number.isFinite(x) || x < 0 || x > canvas.width) return;
  const g = canvas.getContext('2d');
  g.strokeStyle = COLORS.playhead;
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(Math.round(x) + 0.5, PAD_TOP);
  g.lineTo(Math.round(x) + 0.5, canvas.height - PAD_BOTTOM);
  g.stroke();
};

// Draw the spectrum view of a rendered hit: log-scale (dB) bars from
// Goertzel bin magnitudes, each bar a hue-ramped vertical gradient
// (cyan at low -> pink at high), on a dark background with light dB and
// frequency grids and kHz tick labels. Bins are self-scaled to the
// loudest bin (auto-gain) so quiet and loud hits both fill the view.
export const drawSpectrum = (canvas, buffer, sr) => {
  const g = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const plotH = H - PAD_TOP - PAD_BOTTOM;

  g.fillStyle = COLORS.bg;
  g.fillRect(0, 0, W, H);

  // Frequency axis: grid + labels in kHz (0 … Nyquist).
  drawAxis(
    g, W, H,
    sr / 2,
    [500, 1000, 2000, 5000, 10000, 20000], 'kHz',
    (v) => (v >= 1000 ? `${v / 1000}k` : `${v}`),
  );

  // dB reference grid: 0 / −20 / −40 / −60 dB across the plot.
  g.strokeStyle = COLORS.grid;
  g.lineWidth = 1;
  for (const db of [0, -20, -40, -60]) {
    const y = Math.round(PAD_TOP + (1 - dbScale(db)) * plotH) + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }

  // One bin per 2 CSS px (≈ 53 Hz at the 48 kHz preview rate).
  const binCount = Math.max(16, Math.floor(W / 2));
  const mags = spectrumMagnitudes(buffer, sr, binCount);
  let peak = 0;
  for (let i = 0; i < binCount; i++) if (mags[i] > peak) peak = mags[i];

  // One vertical gradient per bar: its hue at hsl(h, 85%, 62%) on top
  // fading to the same hue at 0.35 alpha at the bar's base. The hue is
  // ramped across the frequency range — h = 190 + 140·(f/Nyquist), and
  // bin i sits at f_i = i·sr/(2·binCount), so f_i/Nyquist = i/binCount
  // and the ramp runs from cyan (190°) at DC to pink (~330°) at the top
  // bin: low energy reads cool, high energy warm. This IS the "colorful"
  // centerpiece of the refreshed canvas (plan "colors" S9) — the per-bin
  // colors are computed from each bin's frequency, canvas art rather
  // than theme tokens (no static palette entry could track a bin).
  const barW = W / binCount;
  for (let i = 0; i < binCount; i++) {
    const h = peak > 0 ? dbScale(mags[i] / peak) * plotH : 0;
    if (h <= 0) continue;
    const hue = 190 + 140 * (i / binCount);
    const top = PAD_TOP + plotH - h;
    const bar = g.createLinearGradient(0, top, 0, top + h);
    bar.addColorStop(0, `hsl(${hue}, 85%, 62%)`);
    bar.addColorStop(1, `hsl(${hue}, 85%, 62%, 0.35)`);
    g.fillStyle = bar;
    g.fillRect(i * barW, top, barW, h);
  }
};

// Draw one period of a wave shape into a small preview canvas: the
// live shape feedback of the FM cards' shape groups (buildShapeGroup
// in src/app/knob.js). The geometry is the facade's waveShapePoints —
// the library is the single source of the shape math (GUIDELINES §4,
// the goertzelMag precedent); this only maps it to pixels.
//
// One sample per pixel column (the shape is one low-frequency period,
// so pixel sampling is exact enough). v ∈ [−1, 1] maps to
// y ∈ [1, H−1]: a 1 px inset top/bottom so the 2 px stroke is never
// clipped at the canvas edge. A faint 1 px midline (the muted grid
// tone) is painted under the trace so the zero-crossings read, and a
// faint gradient fill under the trace (the trace color at 0.12 fading
// to transparent, plan "colors" S10) so the preview is not a bare
// squiggle. An unknown shape fails loudly — waveShapePoints' throw
// propagates on a freshly cleared canvas; the caller only passes the
// four known shapes (an unknown stored value is handled by the group,
// which draws no preview at all).
export const drawShapeWave = (canvas, shape, color) => {
  const g = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  g.clearRect(0, 0, W, H);

  // Sample before painting anything: an unknown shape throws while
  // only the clear has happened (no partial trace on the canvas).
  const points = waveShapePoints(shape, W);

  // The faint midline at the trace map's v = 0, painted first so the
  // trace sits on top of it.
  g.strokeStyle = COLORS.grid;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, 1 + (H - 2) / 2);
  g.lineTo(W, 1 + (H - 2) / 2);
  g.stroke();

  // The one-period trace, 2 px in the passed color. The map is
  // y(v) = 1 + (H−2)/2·(1−v): v = +1 → y = 1 (top inset),
  // v = −1 → y = H−1 (bottom inset), v = 0 → the midline above.
  // The y map is precomputed once — the trace AND the fill below both
  // follow the same vertices.
  const y = new Float32Array(W);
  for (let x = 0; x < W; x++) y[x] = 1 + ((H - 2) / 2) * (1 - points[x]);
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, y[0]);
  for (let x = 1; x < W; x++) g.lineTo(x, y[x]);
  g.stroke();

  // The faint fill under the trace (plan "colors" S10): the trace's
  // top edge closed to the canvas's bottom corners, a vertical
  // gradient from the trace color at 0.12 (top) to fully transparent
  // (bottom) — the preview stops looking like a bare squiggle. No
  // glow: the faintness is the fill's whole role (the shadow language
  // belongs to the band and the envelope editor).
  const fill = g.createLinearGradient(0, 0, 0, H);
  fill.addColorStop(0, withAlpha(color, 0.12));
  fill.addColorStop(1, withAlpha(color, 0));
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(0, y[0]);
  for (let x = 1; x < W; x++) g.lineTo(x, y[x]);
  g.lineTo(W, H);
  g.lineTo(0, H);
  g.closePath();
  g.fill();
};
