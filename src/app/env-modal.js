// src/app/env-modal.js
//
// The full-screen envelope-editor modal (plan "dahdsr" P4/S1).
//
// A fixed overlay covering the viewport BELOW the topbar (the topbar's
// rect height is measured on open, so the trigger / loop transport stay
// live above the overlay) holding:
//
//   - a header row: the kind <select> (cardEnvelopeOptions — level /
//     pitch / per-modulator FM depth, the field-presence rule), the
//     zoom buttons (+ halve the span, - double it, reset), and the
//     close button [x];
//   - the large plot canvas — the shared constrained-editor core
//     (src/app/env-editor.js) in interactive mode: role-anchor and
//     bend-dot drags, plus the time-window pan on empty plot space;
//   - the waveform strip — a second canvas below the plot showing the
//     ISOLATED source's rendered hit (facade isolateLayer +
//     renderPatch — the closed API is untouched) at the SAME window
//     mapping as the plot (zoom / pan move both together), amplitude
//     auto-fit, stroked in the drum hue: the envelope being shaped is
//     visible on the sound it carves. The strip re-renders from the
//     patch on every edit (the modal's redraw — main.js's sync pass)
//     and re-maps on every window change (zoom / pan);
//   - a footer row: the current window readout (e.g. "0 - 500 ms") and
//     the selected kind label.
//
// The loop / trigger playhead (main.js's playheadFrame — the shared
// registerPlay clock) draws one line at the window's x on BOTH the
// plot and the strip while the modal is open for the on-screen drum:
// a one-shot Trigger play sweeps the hit, a loop beat sweeps per beat
// (the band's existing behavior, mirrored). The strip's buffer is
// cached — the rAF loop re-paints the mapping only, never re-renders.
//
// Escape and [x] close. The modal closes on drum switch / preset load
// (the stale-state rule — main.js calls close()), and its plot is
// re-painted by the normal re-render / readout-sync pass (main.js calls
// redraw()) so an external knob edit never leaves the plot stale
// (the always-fresh invariant, carried over from the old card editor).
//
// The zoom state is {t0, span} in seconds, clamped: span to [10 ms,
// duration], t0 to [0, duration - span]. The pure parts (zoomWindow /
// formatWindow, and the strip's window → pixel mapping —
// stripSlice / stripTrace) are exported for test/env-modal.test.mjs;
// the DOM (the overlay, the plot canvas, the strip canvas) is the
// module's only I/O boundary.

import { renderPatch, isolateLayer } from '../lib/index.js';
import { cardEnvelopeOptions } from './cards.js';
import { wireEnvEditor } from './env-editor.js';
import {
  COLORS,
  PAD_BOTTOM,
  PAD_TOP,
  drawAxis,
  drawPlayhead,
  waveformPoints,
  withAlpha,
} from './viz.js';

// The minimum zoom span (the 10 ms floor — plan "dahdsr" P4/S1).
const MIN_SPAN = 0.01;

// The plot canvas size (the CSS scales it to the modal's width; the
// pointer mapping goes through getBoundingClientRect, so the backing
// resolution is free to be large). The strip is the same width — its
// x mapping is the plot's (one playhead x serves both).
const PLOT_WIDTH = 1200;
const PLOT_HEIGHT = 420;
const STRIP_WIDTH = 1200;
const STRIP_HEIGHT = 160;

// The strip's render rate: 48 kHz, the app's base rate (main.js's
// PREVIEW_RATE — the canvas buffers' shared rate). The strip is a
// visual of the isolated source, not audio: the rate only needs to
// be fine enough that the windowed peak-per-pixel trace is faithful
// (at the 10 ms zoom floor, 480 samples per pixel column at full span
// — far over-sampled).
const STRIP_RATE = 48000;

// The zoom / pan window clamp: scale `window`'s span by `factor` about
// the window's center, keeping the window inside [0, duration] — span
// clamped to [MIN_SPAN, duration], t0 to [0, duration - span]. Pure.
export const zoomWindow = (window, factor, duration) => {
  const span = Math.min(Math.max(window.span * factor, MIN_SPAN), duration);
  const center = window.t0 + window.span / 2;
  const t0 = Math.min(Math.max(center - span / 2, 0), Math.max(0, duration - span));
  return { t0, span };
};

// The footer readout: the window as "start - end ms" (e.g.
// {t0: 0, span: 0.5} -> "0 - 500 ms"). Pure.
export const formatWindow = (window) =>
  `${Math.round(window.t0 * 1000)} - ${Math.round((window.t0 + window.span) * 1000)} ms`;

// The strip's window slice: the hit-buffer samples covered by the
// {t0, span} window — the SAME window the plot draws (envMaps clamps
// in the same order: span to [1e-9, duration], then t0 to
// [0, duration - span]), so zoom / pan move both views together.
// Clamped to the buffer: a window past the hit's end is an empty
// slice (a silent tail draws a flat midline). Pure.
export const stripSlice = (buffer, sr, window, duration) => {
  const span = Math.min(Math.max(window.span, 1e-9), duration);
  const t0 = Math.min(Math.max(window.t0, 0), Math.max(0, duration - span));
  const i0 = Math.min(buffer.length, Math.max(0, Math.floor(t0 * sr)));
  const i1 = Math.min(buffer.length, Math.max(i0, Math.ceil((t0 + span) * sr)));
  return buffer.subarray(i0, i1);
};

// The strip's trace: per-pixel peak [yTop, yBottom] pairs (canvas y,
// plot-relative — the caller adds PAD_TOP) of the window slice, with
// AMPLITUDE AUTO-FIT: the slice's own peak maps to the plot's full
// height, so a zoomed-in tail fills the strip (the envelope being
// shaped is visible at any zoom). Reuses viz.js's waveformPoints
// (full-slice → full-width peak-per-pixel) and rescales around the
// midline by 1/peak — the midline-stay formula keeps columns that sit
// entirely on one side of zero (all-negative) correct, and a silent
// slice (peak ≈ 0) returns the flat midline as-is (no division).
// The engine's final clamp keeps samples within ±1, so the fit only
// ever expands (scale >= 1) — the trace never draws past the plot.
// Pure.
export const stripTrace = (buffer, sr, window, duration, width, height) => {
  const plotH = height - PAD_TOP - PAD_BOTTOM;
  const slice = stripSlice(buffer, sr, window, duration);
  const pts = waveformPoints(slice, width, plotH);
  let peak = 0;
  for (let i = 0; i < slice.length; i++) {
    const a = Math.abs(slice[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-9) return pts; // silent slice: the flat midline as-is
  const scale = 1 / peak;
  const mid = plotH / 2;
  const out = new Float32Array(width * 2);
  for (let x = 0; x < width; x++) {
    out[x * 2] = mid + (pts[x * 2] - mid) * scale;
    out[x * 2 + 1] = mid + (pts[x * 2 + 1] - mid) * scale;
  }
  return out;
};

// initEnvModal({root, topbar, onEdit, onClose}) ->
//   { overlay, canvas, strip, kindSelect, open, close, isOpen, drum,
//     drumName, path, redraw, drawPlayhead }
//
// The overlay element is created in `root` (the app root — document
// body) hidden; open(drum, layerIndex, kindPath?) shows it below the
// topbar for that source, kindPath selecting the initial kind (the
// first offered option when absent). Edits flow through
// onEdit(drum, path, newPoints) — the caller (main.js) does
// setPath + onPatchEdit(drum), and the existing re-render / readout-
// sync pass keeps the card knobs, the band and the preview in sync.
export const initEnvModal = ({ root, topbar, onEdit, onClose = () => {} }) => {
  const state = {
    open: false,
    drum: null,
    layerIndex: null,
    kind: null,
    path: null,
    label: null,
    window: null,
  };

  const overlay = document.createElement('div');
  overlay.className = 'env-modal hidden';

  const head = document.createElement('header');
  head.className = 'env-modal-head';

  const kindSelect = document.createElement('select');
  kindSelect.className = 'env-modal-kind';
  kindSelect.setAttribute('aria-label', 'envelope kind');

  const makeZoomBtn = (cls, text, aria) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.setAttribute('aria-label', aria);
    return b;
  };
  const zoomIn = makeZoomBtn('env-modal-zoom-in', '+', 'zoom in');
  const zoomOut = makeZoomBtn('env-modal-zoom-out', '-', 'zoom out');
  const zoomReset = makeZoomBtn('env-modal-zoom-reset', 'reset', 'reset zoom');

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'env-modal-close';
  closeBtn.textContent = 'x';
  closeBtn.setAttribute('aria-label', 'close the envelope editor');

  head.append(kindSelect, zoomIn, zoomOut, zoomReset, closeBtn);

  const canvas = document.createElement('canvas');
  canvas.className = 'env-modal-canvas';
  canvas.width = PLOT_WIDTH;
  canvas.height = PLOT_HEIGHT;
  canvas.setAttribute('aria-label', 'envelope plot');

  // The waveform strip (plan "dahdsr" P4/S2): the isolated source's
  // rendered hit at the plot's window mapping — display-only (no
  // pointer listeners; the plot owns the gestures).
  const strip = document.createElement('canvas');
  strip.className = 'env-modal-strip';
  strip.width = STRIP_WIDTH;
  strip.height = STRIP_HEIGHT;
  strip.setAttribute('aria-label', 'isolated source waveform strip');

  const foot = document.createElement('footer');
  foot.className = 'env-modal-foot';
  const windowOut = document.createElement('output');
  windowOut.className = 'env-modal-window';
  const kindLabel = document.createElement('span');
  kindLabel.className = 'env-modal-kind-label';
  foot.append(windowOut, kindLabel);

  overlay.append(head, canvas, strip, foot);
  root.append(overlay);

  // The interactive plot: the shared core with the modal's live state
  // as the getters. onEdit lifts (drum, path) out of the state so
  // main.js's callback can do setPath + onPatchEdit.
  const wire = wireEnvEditor(canvas, {
    getDrum: () => (state.open ? state.drum : null),
    getKind: () => ({ kind: state.kind, path: state.path }),
    getWindow: () => (state.open ? state.window : null),
    onEdit: (points) => onEdit(state.drum, state.path, points),
    onWindow: (w) => {
      state.window = w;
      windowOut.textContent = formatWindow(w);
      paintStrip(); // the strip rides the same window (zoom / pan move both)
    },
  });

  // The strip's cached render of the isolated source (the render rate
  // is STRIP_RATE — the app's base rate). refreshStrip re-renders it
  // from the LIVE patch (the edit path: main.js's sync pass calls
  // redraw after every setPath, so the shaped envelope is visible on
  // the sound it carves); paintStrip only re-maps the cached buffer
  // (the window path: zoom / pan / the playhead's per-frame repaint —
  // the rAF loop must never re-render).
  const refreshStrip = () => {
    if (!state.open) return;
    try {
      state.stripBuffer = renderPatch(
        isolateLayer(state.drum.patch, state.layerIndex),
        { sampleRate: STRIP_RATE, duration: state.drum.duration },
      );
    } catch {
      // A render that cannot complete (an imported patch with an
      // out-of-range value) must not take the modal down: the error
      // is already on the band's error line (main.js's updateDrum
      // funnel caught the mix render first), and the strip degrades
      // to its base (bg + axis + midline, no trace).
      state.stripBuffer = null;
    }
    paintStrip();
  };

  const paintStrip = () => {
    if (!state.open) return;
    const g = strip.getContext('2d');
    const W = strip.width;
    const H = strip.height;
    const plotH = H - PAD_TOP - PAD_BOTTOM;
    const { t0, span } = state.window;

    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, W, H);
    // The same ms axis as the plot (windowed via `start` — the views
    // line up pixel for pixel).
    drawAxis(
      g, W, H,
      span * 1000,
      [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000], 'ms', String,
      t0 * 1000,
    );
    // The 0-amplitude midline (the band's look).
    g.strokeStyle = COLORS.mid;
    g.lineWidth = 1;
    const midY = Math.round(PAD_TOP + plotH / 2) + 0.5;
    g.beginPath();
    g.moveTo(0, midY);
    g.lineTo(W, midY);
    g.stroke();

    if (!state.stripBuffer) return; // render failure: the base only
    const color = state.drum.color ?? COLORS.trace;
    const trace = stripTrace(
      state.stripBuffer, STRIP_RATE, state.window,
      state.drum.duration, W, H,
    );
    // The drum-hue peak-per-pixel trace, glowing (the glow is set
    // AROUND the stroke only — the fill below does not glow).
    g.save();
    g.translate(0, PAD_TOP);
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.shadowColor = color;
    g.shadowBlur = 4;
    g.beginPath();
    for (let x = 0; x < W; x++) {
      g.moveTo(x + 0.5, trace[x * 2]);
      g.lineTo(x + 0.5, trace[x * 2 + 1]);
    }
    g.stroke();
    g.shadowBlur = 0;
    g.restore();
    // The 0.15-alpha gradient fill under the trace (the plot's
    // pattern), painted in canvas coordinates (after the restore).
    const fill = g.createLinearGradient(0, 0, 0, H);
    fill.addColorStop(0, withAlpha(color, 0.15));
    fill.addColorStop(1, withAlpha(color, 0));
    g.fillStyle = fill;
    g.beginPath();
    g.moveTo(0, PAD_TOP + trace[0]);
    for (let x = 1; x < W; x++) g.lineTo(x, PAD_TOP + trace[x * 2]);
    g.lineTo(W, H - PAD_BOTTOM);
    g.lineTo(0, H - PAD_BOTTOM);
    g.closePath();
    g.fill();
  };

  // The modal's redraw (main.js's sync pass calls it after every
  // edit, and open / a kind change call it directly): the plot
  // repaints from the patch, and the strip RE-RENDERS the isolated
  // hit from it (the shaped envelope is visible on the sound it
  // carves). No-op while closed (both halves guard on state.open).
  const redraw = () => {
    wire.redraw();
    refreshStrip();
  };

  const buildKindSelect = (options) => {
    kindSelect.replaceChildren(
      ...options.map((o) => {
        const opt = document.createElement('option');
        opt.value = o.path;
        opt.textContent = o.label;
        return opt;
      }),
    );
  };

  const updateFooter = () => {
    windowOut.textContent = state.window ? formatWindow(state.window) : '';
    kindLabel.textContent = state.label ?? '';
  };

  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  const open = (drum, layerIndex, kindPath = null) => {
    const layer = drum?.patch?.layers[layerIndex];
    const options = cardEnvelopeOptions(layer, layerIndex);
    if (!options.length)
      throw new Error(
        `env-modal: layer ${layerIndex} of ${JSON.stringify(drum?.name)} has no editable envelope`,
      );
    const option = options.find((o) => o.path === kindPath) ?? options[0];
    state.open = true;
    state.drum = drum;
    state.layerIndex = layerIndex;
    state.kind = option.kind;
    state.path = option.path;
    state.label = option.label;
    state.window = { t0: 0, span: drum.duration };
    // Below the topbar: its rect is measured on open (the trigger /
    // loop transport stay live above the overlay).
    const rect = topbar.getBoundingClientRect();
    overlay.style.top = `${rect.top + rect.height}px`;
    overlay.className = 'env-modal';
    buildKindSelect(options);
    kindSelect.value = option.path;
    updateFooter();
    redraw();
    window.addEventListener('keydown', onKey);
    return overlay;
  };

  const close = () => {
    if (!state.open) return;
    state.open = false;
    overlay.className = 'env-modal hidden';
    window.removeEventListener('keydown', onKey);
    onClose();
  };

  kindSelect.addEventListener('change', () => {
    if (!state.open) return;
    // Re-derive the option list from the LIVE patch (the card editor's
    // refresh rule — a modulator add / remove changes the list while
    // the modal is open); fall back to the first option when the
    // selected path no longer exists.
    const layer = state.drum.patch.layers[state.layerIndex];
    const options = cardEnvelopeOptions(layer, state.layerIndex);
    buildKindSelect(options);
    let option = options.find((o) => o.path === kindSelect.value);
    if (!option) {
      option = options[0];
      kindSelect.value = option.path;
    }
    state.kind = option.kind;
    state.path = option.path;
    state.label = option.label;
    state.window = { t0: 0, span: state.drum.duration };
    updateFooter();
    redraw();
  });

  // The zoom buttons move the window: the readout follows, the PLOT
  // re-maps (wire.redraw), and the strip re-maps the CACHED buffer
  // (paintStrip — no re-render: the sound is unchanged, only the
  // view). Zoom / pan therefore move both views together.
  const applyZoom = (nextWindow) => {
    state.window = nextWindow;
    windowOut.textContent = formatWindow(nextWindow);
    wire.redraw();
    paintStrip();
  };
  zoomIn.addEventListener('click', () => {
    if (!state.open) return;
    applyZoom(zoomWindow(state.window, 0.5, state.drum.duration));
  });
  zoomOut.addEventListener('click', () => {
    if (!state.open) return;
    applyZoom(zoomWindow(state.window, 2, state.drum.duration));
  });
  zoomReset.addEventListener('click', () => {
    if (!state.open) return;
    applyZoom({ t0: 0, span: state.drum.duration });
  });
  closeBtn.addEventListener('click', close);

  // The playhead line for playheadFrame (plan "dahdsr" P4/S1/S2): the
  // bases are re-painted first (drawPlayhead never clears) and ONE
  // line — the window's x for time t, the same mapping on both views
  // (both canvases are the same width over the same window) — lands
  // on the PLOT and the STRIP. Outside the window, drawPlayhead's
  // own bounds check no-ops. The strip re-paints from its CACHED
  // buffer (paintStrip — the rAF loop never re-renders).
  const drawPlayheadLine = (t) => {
    if (!state.open) return;
    wire.redraw();
    paintStrip();
    const x = ((t - state.window.t0) / state.window.span) * canvas.width;
    drawPlayhead(canvas, x);
    drawPlayhead(strip, x);
  };

  return {
    overlay,
    canvas,
    strip,
    kindSelect,
    open,
    close,
    isOpen: () => state.open,
    drum: () => (state.open ? state.drum : null),
    drumName: () => (state.open ? state.drum.name : null),
    path: () => (state.open ? state.path : null),
    redraw,
    drawPlayhead: drawPlayheadLine,
  };
};
