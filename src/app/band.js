// The top band (new-ui.md §2.4): the mix waveform plus the FM
// sources' pitch curves — carrier Hz over time, note-labeled like
// Geonkick's "1.3kHz D#6 … 48.4Hz G1" — and the waveform/spectrum
// toggle.
//
// The band is a READ-ONLY overview (plan "dahdsr" P4/S2): its unique
// value is every FM source's pitch curve at once (one curve per layer,
// in the source's hue, note labels on every point), with the working
// source (a card-head click, main.js's onWorking) highlighted — full
// opacity, a wider line, and its point circles. PRECISE pitch editing
// lives in the card preview / the full-screen editor modal
// (src/app/env-editor.js — the constrained 2-anchor pitch form); the
// old free-form point editing (wireBandPitchEditing, P4/S11) is
// retired with the free-form model it belonged to. The band canvas
// carries no pointer listeners: a drag / click / double-click on it
// is inert (the tmp/boot-check.mjs band section pins that).
//
// App tier: the band is a visualization of the patch, not synthesis —
// there is no audio-rate math here (GUIDELINES §1.4(b)/§3). The one
// library import is the facade's envelopeValue (a pitch curve is
// sampled from the already-exported envelope math, never re-derived).
// The pure functions (pitchCurvePoints, hzToNoteName, bandTMaxFor,
// logYScale, curveHzRange, bandHzRange, pitchCurveToPixels) are
// unit-testable under node --test without a canvas (GUIDELINES
// §1.3/§4) and are what the modal's pitch kind reuses (env-editor.js
// — logYScale's toHz inverse maps a drag's y back to a Hz value, and
// bandHzRange widens a degenerate range by an octave each side). The
// module's I/O boundary is the canvas 2D context (drawBand — like the
// draw* functions in src/app/viz.js, which supply the shared canvas
// primitives: COLORS, PAD_TOP/PAD_BOTTOM, drawAxis, waveformPoints,
// timeToX, drawSpectrum).
//
// The curve LINE vs. the labeled POINTS (P2/S6): each curve entry's
// `points` is the DENSE sample (pitchCurvePoints) — the line is the
// true envelope shape (envelopes.js is piecewise linear with a hold,
// so a dense uniform sample is faithful). The labeled points are the
// entry's `env` — the pitch envelope's own {t, v} points, or the
// single constant-frequency anchor for a flat carrier: that is what
// makes the Geonkick look (one label per pitch point, not per
// sample). An entry without `env` falls back to labeling its sample
// points on the uniform time grid.

import { envelopeValue } from '../lib/index.js';
import {
  COLORS,
  PAD_BOTTOM,
  PAD_TOP,
  drawAxis,
  drawSpectrum,
  timeToX,
  withAlpha,
  waveformPoints,
} from './viz.js';

// Carrier-frequency samples (Hz) of one FM layer's pitch curve: n
// values at times t_i = i·duration/(n−1) across the band's time axis.
// With a pitchEnv the curve is the envelope (the engine's freqAt
// override — src/lib/engine.js: an envelope drives the carrier, so
// carrier.freq is only the constant case); without one it is the flat
// carrier.freq.
//
// n = 1 is the degenerate span: the single sample is the instant
// t = 0 (the formula would divide by n−1 = 0 otherwise).
//
// FM layers only: the band draws pitch curves for FM sources — a noise
// layer has no carrier to draw, so asking for its curve is a caller
// bug and fails loudly (repo style: descriptive errors).
export const pitchCurvePoints = (layer, duration, n) => {
  if (layer?.type !== 'fm')
    throw new Error(
      `pitchCurvePoints: FM layers only (the band draws pitch curves `
      + `for FM sources), got type ${JSON.stringify(layer?.type)}`,
    );
  if (!Number.isInteger(n) || n < 1)
    throw new Error(
      `pitchCurvePoints: n must be a positive integer, got ${n}`,
    );
  const points = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (i * duration) / (n - 1);
    points[i] = layer.pitchEnv
      ? envelopeValue(layer.pitchEnv, t)
      : layer.carrier.freq;
  }
  return points;
};

// 12-TET note names, index 0 = C.
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// The frequency part of a point label (new-ui.md §2.4): kHz with one
// decimal at >= 1000 Hz, else Hz with one decimal — "1.3kHz" / "48.4Hz".
const formatHz = (hz) =>
  hz >= 1000 ? `${(hz / 1000).toFixed(1)}kHz` : `${hz.toFixed(1)}Hz`;

// "48.4Hz G1" / "1.3kHz D#6": the formatted frequency plus the closest
// 12-TET note at A4 = 440 Hz.
//
// The note is the nearest semitone: midi = round(69 + 12·log2(f/440))
// (69 is A4); the name is midi mod 12 and the octave is floor(midi/12)
// − 1 (standard MIDI convention — the octave of A4 itself is 4, the
// plan's Math.floor(12·log2(f/440)) + 4 at A4). The mod is made
// positive for subsonic inputs, where midi goes negative.
//
// Total over the whole positive range: no positive frequency throws or
// yields NaN — the audio extremes 20 Hz / 22000 Hz (the carrier range,
// src/app/controls.js PARAM_RANGES) land on D#0 / F10. Non-positive or
// non-finite input is a caller bug, not a label, and fails loudly.
export const hzToNoteName = (hz) => {
  if (!Number.isFinite(hz) || hz <= 0)
    throw new Error(
      `hzToNoteName: hz must be a positive finite number, got ${hz}`,
    );
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${formatHz(hz)} ${name}${octave}`;
};

// The band's time axis (seconds): the drum's own duration — derived
// from the session data, never hardcoded (the MAIN_TMAX convention:
// the axis follows the data it displays, so a 1.5 s cymbal drum
// simply gets a wider axis, no special case).
export const bandTMaxFor = (drum) => drum.duration;

// ---- pure pixel helpers (P2/S6) --------------------------------------

// The log-frequency y scale of the pitch-curve axis: hz -> plot-y and
// its inverse, log2-based with HIGH frequency at the top (y = 0) and
// low at the bottom (y = plotH) — the same orientation as a spectrum,
// so a curve climbing toward the top reads as "getting brighter".
//
// Both maps are total and clamping: an hz outside [minHz, maxHz] pins
// to the plot edges (a sample past the range draws at the edge, not
// off-canvas), and a y outside [0, plotH] pins likewise — the inverse
// (toHz) turns a canvas y back into a Hz value (the modal's pitch kind
// reuses the same log law for its drag's v map, env-editor.js). A
// degenerate range (minHz >= maxHz — e.g. one flat single-frequency
// curve — or a non-positive/non-finite bound) has no log span: both
// maps collapse to constants (the plot middle / minHz) instead of
// dividing by zero, so flat curves draw centered and nothing yields
// NaN.
export const logYScale = (minHz, maxHz, plotH) => {
  const h = Number.isFinite(plotH) && plotH > 0 ? plotH : 0;
  const lo = Number.isFinite(minHz) && minHz > 0 ? minHz : 0;
  const hi = Number.isFinite(maxHz) && maxHz > 0 ? maxHz : 0;
  if (lo <= 0 || hi <= lo) {
    const flat = h / 2;
    const hz = lo; // 0 for a bad bound — finite, never NaN
    return { toY: () => flat, toHz: () => hz };
  }
  const span = Math.log2(hi) - Math.log2(lo);
  const toY = (hz) => {
    const c = Number.isFinite(hz) && hz > 0 ? Math.min(hi, Math.max(lo, hz)) : lo;
    return h * (1 - (Math.log2(c) - Math.log2(lo)) / span);
  };
  const toHz = (y) => {
    const c = Number.isFinite(y) ? Math.min(h, Math.max(0, y)) : 0;
    return lo * 2 ** ((1 - c / h) * span);
  };
  return { toY, toHz };
};

// The Hz range of the drawn curves: the min/max over every curve's
// sample points. [0, 0] for no curves. bandHzRange (below) is the
// range the drawing actually uses — this raw min/max is its input.
export const curveHzRange = (curves) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const curve of curves)
    for (let i = 0; i < curve.points.length; i++) {
      const v = curve.points[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  return Number.isFinite(lo) ? [lo, hi] : [0, 0];
};

// The Hz range the band's log scale covers: the min/max over the drawn
// curves' samples (curveHzRange), WIDENED BY ONE OCTAVE EACH SIDE when
// degenerate — a single flat curve (or no curves) has no log span. The
// ±octave span keeps a flat curve drawn exactly centered (the old
// degenerate constant scale painted it at the plot middle — the same
// pixels) while giving the scale a real span. The modal's pitch kind
// (env-editor.js) fits its plot on this same range — a degenerate one
// would map every y to the same Hz. No curves at all ([0, 0]) gets an
// arbitrary small span around 1 Hz — no tick candidate (50..20000)
// falls inside it, so nothing is drawn.
export const bandHzRange = (curves) => {
  const [lo, hi] = curveHzRange(curves);
  if (lo > 0 && hi > lo) return [lo, hi];
  const c = lo > 0 ? lo : 1;
  return [c / 2, c * 2];
};

// A pitch curve's sample points -> canvas x/y pairs (Float32Array of
// 2·n numbers: [x0, y0, x1, y1, ...]). x is LINEAR IN TIME on the
// band's 0…duration axis — the same time grid pitchCurvePoints
// samples at (t_i = i·duration/(n−1)), so x = (t_i/duration)·width =
// i/(n−1)·width, spanning 0…width (n = 1 -> x = 0, the single sample
// at t = 0; n = 0 -> empty). y is the points' Hz through the caller's
// scale (logYScale's toY — plot-relative, drawBand adds PAD_TOP).
//
// `duration` is part of the contract: it names the time axis the x
// positions refer to (its inverse is xToT(x) = x/width·duration), and
// it documents that a points array sampled over a different span would
// be misplaced.
export const pitchCurveToPixels = (points, duration, width, yMap) => {
  const n = points.length;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : (i / (n - 1)) * width;
    out[i * 2] = x;
    out[i * 2 + 1] = yMap(points[i]);
  }
  return out;
};

// ---- constants --------------------------------------------------------

// The band's pitch-point handle radius (px): the small filled circles
// the working curve's points are drawn as (drawBand's highlight).
export const BAND_HANDLE_RADIUS = 3;

// The dense sample count of a pitch curve's LINE (main.js passes it to
// pitchCurvePoints). The envelope math is piecewise linear with a hold
// (src/lib/envelopes.js), so a uniform sample this dense reproduces
// the true curve to well under a pixel at the band's width. The
// labeled points are the env points (the entry's `env`), not this
// sampling — the density costs nothing in labels.
export const BAND_CURVE_SAMPLES = 256;

// The log-frequency axis tick candidates (Hz) — only those inside the
// drawn curves' range are drawn (a 50…100 Hz kick band shows just
// 50/100, a hi-hat band shows the top of the decade).
const LOG_FREQ_TICKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

// The fallback anchors for a curve entry without `env`: its sample
// points on the uniform time grid (t_i = i·duration/(n−1)) — the same
// grid pitchCurveToPixels maps them to, so the labels sit on the line.
const gridAnchors = (points, duration) =>
  [...points].map((v, i) => ({
    t: points.length === 1 ? 0 : (i / (points.length - 1)) * duration,
    v,
  }));

// The log-frequency y-axis on the right edge: a faint full-width grid
// line, a right-edge tick mark, and a right-aligned label per
// candidate tick inside the drawn curves' range ("k" style at
// >= 1 kHz, like the spectrum's frequency axis). Painted before the
// waveform so the grid sits behind the traces.
const drawLogFreqAxis = (g, W, toY, minHz, maxHz) => {
  for (const tick of LOG_FREQ_TICKS) {
    if (tick < minHz || tick > maxHz) continue;
    const y = Math.round(PAD_TOP + toY(tick)) + 0.5;
    g.strokeStyle = COLORS.grid;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
    g.strokeStyle = COLORS.axis;
    g.beginPath();
    g.moveTo(W - 12, y);
    g.lineTo(W - 6, y);
    g.stroke();
    g.fillStyle = COLORS.axis;
    g.font = '11px system-ui, sans-serif';
    g.textAlign = 'right';
    g.fillText(tick >= 1000 ? `${tick / 1000}k` : String(tick), W - 15, y + 3.5);
  }
};

// ---- DOM drawing (the module's only I/O boundary) ---------------------

// Draw the top band for one drum: the mix waveform plus the FM
// sources' pitch curves (wave mode, the default) — or the spectrum
// view, delegated verbatim to drawSpectrum (src/app/viz.js) for the
// waveform/spectrum toggle (new-ui.md §3's "[spectrum ▾]").
//
// opts:
//   mixBuffer     Float32Array — the drum's rendered mix (preview);
//   sr            number       — its sample rate;
//   duration      number       — the band's time axis in seconds
//                                (bandTMaxFor: the drum's duration);
//   curves        Array        — one entry per FM source:
//                                { points, color, label, layerIndex, env? };
//                                `points` is the dense sample the LINE
//                                is drawn through (pitchCurveToPixels),
//                                `env` the labeled/handleable
//                                pitch points {t, v}[] (see the module
//                                header); `workingIndex` indexes this
//                                array (main.js maps the patch's FM
//                                layers onto it);
//   workingIndex  number|null  — which curve is the working source:
//                                full opacity + 2 px line + its points
//                                drawn as small circles (the editable
//                                handles, P4/S11). null -> no
//                                highlight, no handles (no path at all
//                                is drawn for them);
//   mode          'wave'|'spectrum' (default 'wave');
//   mixColor      string       — the mix waveform's stroke color
//                                (default COLORS.trace, the brand
//                                accent; main.js passes the active
//                                drum's hue — plan "colors" S3). The
//                                per-curve pitch lines keep their own
//                                source colors (S10 refines them).
//
// Wave mode paints, in order: the background, the ms time axis
// (drawAxis, the band's axis is the drum's duration), the 0-amplitude
// midline, the log-frequency ticks, the mix waveform (the mixColor
// peak-per-pixel trace over the full width, glowing, with a mixColor
// gradient fill under the curve — plan "colors" S9), one thin 1.5 px
// line per curve in its source color (non-working at 45 % opacity; the
// working curve additionally glows in its own color — shadowBlur 5
// set around that stroke only, plan "colors" S10), the working
// curve's handles (the same halo around their fills), and one
// hzToNoteName label per pitch point (11 px, source color, offset
// above the point — flipped below when the point sits at the top
// edge, where the baseline would clip off the canvas).
// Every coordinate is finite by construction (logYScale is total,
// waveformPoints stays inside [0, plotH]) — the stub 2D-context tests
// pin it by throwing on a non-finite coordinate.
export const drawBand = (canvas, {
  mixBuffer,
  sr,
  duration,
  curves = [],
  workingIndex = null,
  mode = 'wave',
  mixColor = COLORS.trace,
} = {}) => {
  // Spectrum mode: viz.js's spectrum view verbatim — the pitch curves
  // are a wave-mode overlay, so nothing else is drawn.
  if (mode === 'spectrum') {
    drawSpectrum(canvas, mixBuffer, sr);
    return;
  }
  if (mode !== 'wave')
    throw new Error(
      `drawBand: unknown mode ${JSON.stringify(mode)}`
      + " (expected 'wave' or 'spectrum')",
    );

  const g = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const plotH = H - PAD_TOP - PAD_BOTTOM;

  // Background.
  g.fillStyle = COLORS.bg;
  g.fillRect(0, 0, W, H);

  // The ms time axis: the band's axis is the drum's duration (derived,
  // not hardcoded), so it spans the whole hit even when the buffer is
  // shorter.
  drawAxis(
    g, W, H,
    duration * 1000,
    [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000], 'ms', String,
  );

  // The 0-amplitude midline, slightly brighter than the grid.
  g.strokeStyle = COLORS.mid;
  g.lineWidth = 1;
  const midY = Math.round(PAD_TOP + plotH / 2) + 0.5;
  g.beginPath();
  g.moveTo(0, midY);
  g.lineTo(W, midY);
  g.stroke();

  // The pitch curves' log-frequency scale: ticks and the hz -> y map
  // both cover the drawn curves' range (bandHzRange — the all-curves
  // min/max, widened by one octave when degenerate so a single flat
  // curve still gets a usable scale; see bandHzRange).
  const [minHz, maxHz] = bandHzRange(curves);
  const { toY } = logYScale(minHz, maxHz, plotH);
  drawLogFreqAxis(g, W, toY, minHz, maxHz);

  // The mix waveform: the drum-hue peak-per-pixel trace over the full
  // width (waveformPoints — the same math as viz.js's drawWaveform).
  // mixColor is the active drum's hue (main.js) — COLORS.trace, the
  // brand accent, for callers that pass none (the default). The glow
  // is set AROUND the trace stroke only — shadowBlur resets to 0 right
  // after, so the fill below, the pitch curves, and the playhead (which
  // main.js paints over the band afterwards) do not glow.
  const trace = waveformPoints(mixBuffer, W, plotH);
  g.save();
  g.translate(0, PAD_TOP);
  g.strokeStyle = mixColor;
  g.lineWidth = 1;
  g.shadowColor = mixColor;
  g.shadowBlur = 6;
  g.beginPath();
  for (let x = 0; x < W; x++) {
    g.moveTo(x + 0.5, trace[x * 2]);
    g.lineTo(x + 0.5, trace[x * 2 + 1]);
  }
  g.stroke();
  g.shadowBlur = 0;
  g.restore();

  // The area under the mix trace: its top edge closed to the plot's
  // bottom corners, filled with a vertical gradient from the mix color
  // at 0.28 (top) to fully transparent (bottom) — the fill inherits the
  // drum's hue (the kick's is green-tinted, the snare's orange: free
  // color-coding in the canvas, plan S9). Painted in canvas coordinates
  // (after the restore) so the gradient spans the full canvas height
  // 0..H.
  const fill = g.createLinearGradient(0, 0, 0, H);
  fill.addColorStop(0, withAlpha(mixColor, 0.28));
  fill.addColorStop(1, withAlpha(mixColor, 0));
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(0, PAD_TOP + trace[0]);
  for (let x = 1; x < W; x++) g.lineTo(x, PAD_TOP + trace[x * 2]);
  g.lineTo(W, H - PAD_BOTTOM);
  g.lineTo(0, H - PAD_BOTTOM);
  g.closePath();
  g.fill();

  // One polyline per curve, its dense sample on the band's time grid.
  // The working curve is highlighted: full opacity + a wider line + a
  // glow in its own color (shadowBlur 5, plan "colors" S10 — set
  // AROUND that stroke only and reset right after, so the other
  // curves, the labels, and the playhead do not glow); the others sit
  // back at 45 %.
  for (let i = 0; i < curves.length; i++) {
    const curve = curves[i];
    if (curve.points.length < 2) continue; // a lone point has no segment
    const pixels = pitchCurveToPixels(curve.points, duration, W, toY);
    const working = workingIndex === i;
    g.globalAlpha = working ? 1 : 0.45;
    g.strokeStyle = curve.color;
    g.lineWidth = working ? 2 : 1.5;
    if (working) {
      g.shadowColor = curve.color;
      g.shadowBlur = 5;
    }
    g.beginPath();
    for (let p = 0; p < pixels.length; p += 2) {
      const x = pixels[p];
      const y = PAD_TOP + pixels[p + 1];
      if (p === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    if (working) g.shadowBlur = 0;
  }

  // Handles (working curve only) + one hzToNoteName label per pitch
  // point, every curve. The anchors are the entry's `env` points — or
  // the sample points on the time grid for an entry without `env`
  // (see gridAnchors).
  g.font = '11px system-ui, sans-serif';
  for (let i = 0; i < curves.length; i++) {
    const curve = curves[i];
    const working = workingIndex === i;
    const anchors = curve.env ?? gridAnchors(curve.points, duration);
    if (working) {
      g.globalAlpha = 1;
      g.fillStyle = curve.color;
      // The working curve's anchors carry the same halo as its stroke
      // (S10, reset after the loop — the labels and the later curves'
      // paints stay glow-free). The radius is the plain
      // BAND_HANDLE_RADIUS: the hit-test and its test pins are
      // unchanged.
      g.shadowColor = curve.color;
      g.shadowBlur = 5;
      for (const a of anchors) {
        const x = timeToX(a.t, duration, W);
        const y = PAD_TOP + toY(a.v);
        g.beginPath();
        g.arc(x, y, BAND_HANDLE_RADIUS, 0, 2 * Math.PI);
        g.fill();
      }
      g.shadowBlur = 0;
    }
    g.globalAlpha = working ? 1 : 0.45;
    g.fillStyle = curve.color;
    for (const a of anchors) {
      const x = timeToX(a.t, duration, W);
      const y = PAD_TOP + toY(a.v);
      // Above the point, flipped below when the point is near the top
      // edge (the baseline would clip off the canvas there).
      let ly = y - BAND_HANDLE_RADIUS - 4;
      if (ly < 12) ly = y + BAND_HANDLE_RADIUS + 12;
      g.textAlign = x < 32 ? 'left' : x > W - 32 ? 'right' : 'center';
      g.fillText(hzToNoteName(a.v), x, ly);
    }
  }
  g.globalAlpha = 1;
};

