// Tests for src/app/env-modal.js (plan "dahdsr" P4/S1/S2) — the
// full-screen envelope-editor modal: the pure parts (zoomWindow —
// the zoom / pan window clamps; formatWindow — the footer readout;
// stripSlice / stripTrace — the waveform strip's window → pixel
// mapping and amplitude auto-fit) and the DOM boundary (the overlay
// structure incl. the strip canvas, the topbar offset, Escape / [x]
// close, the zoom buttons (plot + strip move together), the kind
// select's live-patch re-derivation, the edit flow through onEdit
// (the strip re-renders), the playhead line on plot AND strip).
//
// Same headless DOM-stub technique as test/cards.test.mjs, plus a
// minimal `window` stub (the modal's Escape handler lives on
// window's keydown).

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  formatWindow,
  initEnvModal,
  stripSlice,
  stripTrace,
  zoomWindow,
} from '../src/app/env-modal.js';
import { cardEnvelopeOptions } from '../src/app/cards.js';
import { hzToNoteName } from '../src/app/band.js';
import { COLORS } from '../src/app/viz.js';
import { kickPatch, setPath, snarePatch } from '../src/lib/index.js';

// ---- the pure parts ----------------------------------------------------

test('zoomWindow: + halves the span about the center (zoom in), - doubles it (zoom out)', () => {
  const full = { t0: 0, span: 0.5 };
  assert.deepEqual(zoomWindow(full, 0.5, 0.5), { t0: 0.125, span: 0.25 }, 'halved about the center');
  assert.deepEqual(zoomWindow(full, 2, 0.5), full, 'doubled back to the full span');
  // From a panned window: the center is preserved.
  const panned = { t0: 0.1, span: 0.2 };
  const pannedIn = zoomWindow(panned, 0.5, 0.5);
  assert.equal(pannedIn.span, 0.1, 'center 0.2 kept: the span halves');
  assert.ok(Math.abs(pannedIn.t0 - 0.15) < 1e-12, 'center 0.2 kept: t0 = 0.2 - 0.05');
  assert.deepEqual(zoomWindow(panned, 2, 0.5), { t0: 0, span: 0.4 }, 'center 0.2 kept, clamped at the start');
});

test('zoomWindow: the span is clamped to [10 ms, duration] (the floor / the ceiling)', () => {
  // Halving below the 10 ms floor pins at the floor (the center is
  // kept, so t0 moves with it).
  const small = zoomWindow({ t0: 0, span: 0.02 }, 0.5, 0.5);
  assert.equal(small.span, 0.01, 'the 10 ms floor holds');
  assert.ok(Math.abs(small.t0 - 0.005) < 1e-12, '... about the center');
  const tinier = zoomWindow(small, 0.5, 0.5);
  assert.deepEqual(tinier, small, 'further zoom-in is a no-op at the floor');
  // Doubling past the full span pins at the full span (a 0.3 s window
  // doubled would be 0.6 s > the 0.5 s drum).
  const big = zoomWindow({ t0: 0.3, span: 0.3 }, 2, 0.5);
  assert.deepEqual(big, { t0: 0, span: 0.5 }, 'the full-span ceiling holds');
  const bigger = zoomWindow(big, 2, 0.5);
  assert.deepEqual(bigger, big, 'further zoom-out is a no-op at the ceiling');
});

test('zoomWindow: the window always stays inside [0, duration]', () => {
  for (const [t0, span] of [[0, 0.5], [0.49, 0.01], [0.2, 0.2], [0.005, 0.01], [0, 0.01]]) {
    for (const factor of [0.5, 1, 2, 0.01, 100]) {
      const w = zoomWindow({ t0, span }, factor, 0.5);
      assert.ok(w.t0 >= 0 && w.t0 + w.span <= 0.5 + 1e-12, `(${t0}, ${span}) x${factor} stays inside the drum`);
      assert.ok(w.span >= 0.01 - 1e-12 && w.span <= 0.5 + 1e-12, `... and the span stays in [10 ms, duration]`);
    }
  }
});

test('formatWindow: "start - end ms" (the footer readout)', () => {
  assert.equal(formatWindow({ t0: 0, span: 0.5 }), '0 - 500 ms');
  assert.equal(formatWindow({ t0: 0.1, span: 0.2 }), '100 - 300 ms');
  assert.equal(formatWindow({ t0: 0.125, span: 0.25 }), '125 - 375 ms');
  assert.equal(formatWindow({ t0: 0, span: 0.01 }), '0 - 10 ms');
});

test('the modal\'s kind options come from cardEnvelopeOptions (level / pitch / fm depth per layer type)', () => {
  // FM layer with all three fields: all three kinds.
  const fm = kickPatch().layers[0];
  assert.deepEqual(
    cardEnvelopeOptions(fm, 0).map((o) => o.kind),
    ['level', 'pitch', 'fm depth'],
  );
  // FM layer with no pitchEnv: level + fm depth only (field-presence).
  const { pitchEnv: _gone, ...noPitch } = fm;
  assert.deepEqual(cardEnvelopeOptions(noPitch, 0).map((o) => o.kind), ['level', 'fm depth']);
  // A noise layer: level only (no pitch for noise).
  const noise = snarePatch().layers[2]; // the snare's noise layer (check below)
  void noise;
  const kick = kickPatch();
  const click = kick.layers[1]; // the kick's noise click
  assert.equal(click.type, 'noise', 'fixture sanity');
  assert.equal(click.levelEnv, undefined, 'fixture sanity: no levelEnv');
  assert.deepEqual(cardEnvelopeOptions(click, 1), []);
  const noiseWith = { type: 'noise', levelEnv: [{ t: 0, v: 0 }, { t: 0.1, v: 1 }] };
  assert.deepEqual(cardEnvelopeOptions(noiseWith, 1).map((o) => o.kind), ['level']);
});

// ---- headless DOM + window stubs ---------------------------------------

const makeStubContext = () => {
  const g = { calls: [], strokes: [] };
  let path = [];
  let ox = 0, oy = 0; // the translate offset (the trace's save/translate)
  g.lineWidth = 1;
  g.strokeStyle = undefined;
  g.fillStyle = undefined;
  g.createLinearGradient = () => {
    const grad = { stops: [] };
    grad.addColorStop = (o, c) => grad.stops.push([o, c]);
    return grad;
  };
  g.save = () => { g.calls.push(['save', ox, oy]); };
  g.restore = () => { g.calls.push(['restore']); ox = 0; oy = 0; };
  g.translate = (x, y) => { ox += x; oy += y; g.calls.push(['translate', x, y]); };
  for (const m of [
    'fillRect', 'fillText', 'stroke', 'fill', 'beginPath',
    'moveTo', 'lineTo', 'arc', 'closePath',
  ])
    g[m] = (...args) => {
      g.calls.push([m, ...args]);
      if (m === 'beginPath') path = [];
      if (m === 'moveTo' || m === 'lineTo') path.push({ x: args[0] + ox, y: args[1] + oy });
      if (m === 'stroke') {
        g.strokes.push({ pts: path.slice(), strokeStyle: g.strokeStyle, lineWidth: g.lineWidth });
        path = [];
      }
    };
  g.measureText = (t) => ({ width: 30, text: t });
  return g;
};

const makeStubEl = (tagName) => {
  const el = {
    tagName,
    className: '',
    textContent: '',
    style: {},
    children: [],
    attributes: Object.create(null),
    listeners: Object.create(null),
    capturedPointers: [],
    setAttribute(name, value) { el.attributes[name] = String(value); },
    getAttribute(name) { return el.attributes[name] ?? null; },
    appendChild(child) { el.children.push(child); return child; },
    append(...children) { el.children.push(...children); },
    replaceChildren(...children) { el.children.length = 0; el.children.push(...children); },
    addEventListener(type, handler) { (el.listeners[type] ??= []).push(handler); },
    setPointerCapture(pointerId) { el.capturedPointers.push(pointerId); },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: el.width ?? 0, height: el.height ?? 0 };
    },
    getContext() { el.context ??= makeStubContext(); return el.context; },
  };
  return el;
};

// The window stub: the modal's Escape handler lives on window's
// keydown (the stub records/removes the listeners like the browser).
const windowListeners = Object.create(null);
globalThis.window = {
  addEventListener(type, handler) { (windowListeners[type] ??= []).push(handler); },
  removeEventListener(type, handler) {
    const arr = windowListeners[type];
    if (arr) windowListeners[type] = arr.filter((h) => h !== handler);
  },
};
const fireKey = (key) => {
  for (const h of windowListeners.keydown ?? []) h({ key, preventDefault() {}, stopPropagation() {} });
};

globalThis.document = { createElement: makeStubEl };

// Every modal created (the close-semantics tests need a clean window
// listener list — an Escape fires ALL open modals' keydown handlers).
const allModals = [];
after(() => {
  for (const m of allModals) m.close();
});

// The modal harness: a root to hold the overlay, a topbar with a
// measured rect (48 px tall), a kick drum, and the edit recorder.
const makeModal = () => {
  const root = makeStubEl('div');
  const topbar = makeStubEl('header');
  topbar.width = 100;
  topbar.height = 48;
  const drum = { name: 'kick', duration: 0.5, patch: kickPatch() };
  const edits = [];
  const closes = [];
  const modal = initEnvModal({
    root,
    topbar,
    onEdit: (d, path, points) => edits.push([d, path, points]),
    onClose: () => closes.push(1),
  });
  allModals.push(modal);
  return { root, topbar, drum, edits, closes, modal };
};

// Close every modal left open by an earlier test (the window keydown
// listeners are process-global — an Escape fires them all).
const closeAllModals = () => {
  for (const m of allModals) m.close();
};

const fire = (el, type, props = {}) => {
  for (const handler of el.listeners[type] ?? [])
    handler({ preventDefault() {}, stopPropagation() {}, ...props });
};

test('initEnvModal: the overlay is built in the root, hidden — head (select, zooms, close), the plot canvas, the strip canvas, the footer', () => {
  const { root, modal } = makeModal();
  assert.equal(root.children.length, 1, 'the overlay is created in the root');
  assert.ok(modal.overlay.className.includes('env-modal'), 'the overlay carries the env-modal class');
  assert.ok(modal.overlay.className.includes('hidden'), '... and starts hidden');
  const [head, canvas, strip, foot] = modal.overlay.children;
  assert.equal(head.tagName, 'header');
  assert.equal(canvas.tagName, 'canvas');
  assert.equal(strip.tagName, 'canvas');
  assert.equal(foot.tagName, 'footer');
  // The header: the kind select, the + / - / reset zoom buttons, [x].
  assert.equal(head.children.length, 5);
  assert.equal(head.children[0].tagName, 'select');
  assert.deepEqual(
    head.children.slice(1).map((b) => b.className),
    ['env-modal-zoom-in', 'env-modal-zoom-out', 'env-modal-zoom-reset', 'env-modal-close'],
  );
  // The large plot canvas (the CSS scales it to the modal's width).
  assert.equal(canvas.width, 1200);
  assert.equal(canvas.height, 420);
  assert.equal(canvas, modal.canvas, 'the exposed handle is the plot canvas');
  // The waveform strip (P4/S2): same width as the plot (its x mapping
  // is the plot's — one playhead x serves both), a fixed short height.
  assert.equal(strip.width, 1200);
  assert.equal(strip.height, 160);
  assert.ok(String(strip.className).includes('env-modal-strip'), 'the strip carries its class');
  assert.equal(strip, modal.strip, 'the exposed handle is the strip canvas');
  assert.equal(strip.listeners['pointerdown'], undefined,
    'the strip is display-only (the plot owns the gestures)');
  // The footer: the window readout + the kind label.
  assert.equal(foot.children[0].tagName, 'output');
  assert.equal(foot.children[1].tagName, 'span');
});

test('initEnvModal.open: the overlay shows BELOW the topbar (its rect height), with the kind select + the full window readout', () => {
  const { drum, modal, topbar } = makeModal();
  topbar.height = 48;
  const overlay = modal.open(drum, 0);
  assert.equal(overlay, modal.overlay);
  assert.ok(!modal.overlay.className.includes('hidden'), 'the overlay is visible');
  assert.equal(modal.overlay.style.top, '48px', 'the top offset is the topbar\'s height (trigger / loop transport stay live above)');
  assert.ok(modal.isOpen(), 'isOpen() is true');
  assert.equal(modal.drumName(), 'kick');
  // The kind select: the kick body offers level / pitch / fm depth.
  assert.deepEqual(
    modal.kindSelect.children.map((o) => o.textContent),
    ['level', 'pitch', 'modulator 1 FM depth'],
  );
  assert.equal(modal.kindSelect.value, 'layers.0.levelEnv', 'the first option (level) is selected');
  // The footer: the full window + the kind label.
  const [windowOut, kindLabel] = modal.overlay.children[3].children;
  assert.equal(windowOut.textContent, '0 - 500 ms', 'the window readout is the full span');
  assert.equal(kindLabel.textContent, 'level');
  // The plot painted (the wire redraw on open).
  assert.ok(modal.canvas.getContext('2d').calls.length > 0, 'the plot canvas painted on open');
  // The strip painted (P4/S2): the background fill at full size and a
  // non-trivial trace (the kick body's isolated render is far from
  // silent — the trace strokes more than the base's midline).
  const sCtx = modal.strip.getContext('2d');
  assert.ok(
    sCtx.calls.some(([m, x, y, w, h]) => m === 'fillRect' && x === 0 && y === 0 && w === 1200 && h === 160),
    'the strip painted its background on open',
  );
  const traceSegments = sCtx.calls.filter(([m]) => m === 'lineTo').length;
  assert.ok(traceSegments > 1200, `the strip trace painted its peak-per-pixel segments (got ${traceSegments} lineTo's)`);
  // The Escape handler is on window now.
  assert.equal(windowListeners.keydown.length, 1, 'the keydown listener is attached');
  closeAllModals();
});

test('initEnvModal.open: a kindPath selects that kind; an unoffered path falls back to the first option', () => {
  const { drum, modal } = makeModal();
  modal.open(drum, 0, 'layers.0.pitchEnv');
  assert.equal(modal.kindSelect.value, 'layers.0.pitchEnv', 'the pitch kind is selected');
  assert.equal(modal.path(), 'layers.0.pitchEnv');
  // A path the layer does not offer: the first option.
  const modal2 = makeModal().modal;
  modal2.open(drum, 0, 'layers.99.nothing');
  assert.equal(modal2.kindSelect.value, 'layers.0.levelEnv', 'fallback to the first offered option');
});

test('initEnvModal.open: a layer with no editable envelope throws (fail loudly)', () => {
  const { drum, modal } = makeModal();
  drum.patch.layers[1] = { type: 'noise', seed: 1 }; // the noise click: no levelEnv
  assert.throws(() => modal.open(drum, 1), /no editable envelope/);
  assert.equal(modal.isOpen(), false, 'the failed open left the modal closed');
});

test('initEnvModal: Escape closes (the keydown listener is removed, onClose fires)', () => {
  closeAllModals(); // a clean window listener list (see the stub comment)
  const { drum, modal, closes } = makeModal();
  const before = windowListeners.keydown?.length ?? 0;
  modal.open(drum, 0);
  assert.equal(windowListeners.keydown.length, before + 1, 'the keydown listener is attached');
  fireKey('Escape');
  assert.ok(modal.overlay.className.includes('hidden'), 'the overlay is hidden again');
  assert.equal(modal.isOpen(), false);
  assert.equal(windowListeners.keydown.length, before, 'the keydown listener is removed');
  assert.equal(closes.length, 1, 'onClose fired');
  // A second Escape does nothing: the listener is gone.
  fireKey('Escape');
  assert.equal(closes.length, 1);
  // Non-Escape keys do not close.
  modal.open(drum, 0);
  fireKey('Enter');
  assert.ok(modal.isOpen(), 'Enter is not the close key');
  modal.close();
});

test('initEnvModal: the [x] button closes (idempotent)', () => {
  const { drum, modal, closes } = makeModal();
  modal.open(drum, 0);
  const closeBtn = modal.overlay.children[0].children[4];
  fire(closeBtn, 'click');
  assert.equal(modal.isOpen(), false);
  assert.equal(closes.length, 1);
  fire(closeBtn, 'click'); // already closed: a no-op
  assert.equal(closes.length, 1, 'closing twice fires onClose once');
});

test('initEnvModal: the zoom buttons halve / double the span (clamped), reset restores the full span; the strip re-maps with them', () => {
  const { drum, modal } = makeModal();
  modal.open(drum, 0);
  const readout = () => modal.overlay.children[3].children[0].textContent;
  const [zoomIn, zoomOut, zoomReset] = modal.overlay.children[0].children.slice(1, 4);
  assert.equal(readout(), '0 - 500 ms');
  const sCtx = modal.strip.getContext('2d');
  const sCallsBefore = sCtx.calls.length;
  fire(zoomIn, 'click');
  assert.equal(readout(), '125 - 375 ms', 'zoom in halves the span about the center');
  assert.ok(sCtx.calls.length > sCallsBefore, 'the strip re-mapped on zoom (the window moved — both views together)');
  fire(zoomIn, 'click');
  assert.equal(readout(), '188 - 313 ms', '... again (0.125 s span: 187.5 -> 188, 312.5 -> 313)');
  fire(zoomOut, 'click');
  assert.equal(readout(), '125 - 375 ms', 'zoom out doubles it');
  fire(zoomReset, 'click');
  assert.equal(readout(), '0 - 500 ms', 'reset restores the full span');
  // The floor: zoom in until the 10 ms span.
  for (let i = 0; i < 8; i++) fire(zoomIn, 'click');
  assert.ok(readout().endsWith(' ms') && readout().length <= 15, `the floor readout is sane: ${readout()}`);
  const floor = zoomWindow({ t0: 0, span: 0.5 }, 0.5 ** 8, 0.5);
  assert.equal(floor.span, 0.01, 'eight halvings land on the 10 ms floor');
  // The buttons no-op while closed.
  modal.close();
  fire(zoomIn, 'click');
  assert.equal(modal.isOpen(), false, 'zooming a closed modal is a no-op');
});

test('initEnvModal: a kind change re-derives the option list from the LIVE patch (the refresh rule) and redraws', () => {
  const { drum, modal } = makeModal();
  modal.open(drum, 0);
  // A modulator is removed while the modal is open: its fm-depth
  // option dies — the select re-derives from the fresh patch and the
  // selection falls back to the first option.
  const nBefore = modal.kindSelect.children.length;
  assert.equal(nBefore, 3, 'fixture sanity: three options at open');
  drum.patch.layers[0].modulators = [];
  modal.kindSelect.value = 'layers.0.levelEnv';
  fire(modal.kindSelect, 'change');
  assert.deepEqual(
    modal.kindSelect.children.map((o) => o.textContent),
    ['level', 'pitch'],
    'the dead fm-depth option is gone (the list is re-derived from the live patch)',
  );
  assert.equal(modal.path(), 'layers.0.levelEnv');
  // The plot repainted (the selection change redraws).
  assert.ok(modal.canvas.getContext('2d').calls.length > 0);
});

test('initEnvModal: a pointer drag on the plot commits through onEdit(drum, path, points) — the caller does setPath + the sync pass', () => {
  const { drum, modal, edits } = makeModal();
  modal.open(drum, 0);
  const canvas = modal.canvas;
  // The modal canvas is 1200×420 over the 0.5 s drum: tToX = t * 2400.
  // The sustain anchor (point 4) at (0.305 s, v 0): (732, 420 - PAD_BOTTOM - ...).
  // Compute the exact pixel through the same maps the wire uses:
  // plotH = 420 - 6 - 20 = 394, vToY(0) = 6 + 394 = 400.
  const pressX = 0.305 * 2400; // 732
  const pressY = 400;
  for (const h of canvas.listeners.pointerdown ?? [])
    h({ clientX: pressX, clientY: pressY, pointerId: 1 });
  // Drag to (0.2 s, v 0.5): x = 480, y = 6 + 0.5 * 394 = 203.
  for (const h of canvas.listeners.pointermove ?? [])
    h({ clientX: 480, clientY: 203, pointerId: 1 });
  assert.equal(edits.length, 1, 'one commit through onEdit');
  const [editDrum, editPath, points] = edits[0];
  assert.equal(editDrum, drum, 'onEdit receives the modal\'s drum');
  assert.equal(editPath, 'layers.0.levelEnv', '... and its current kind path');
  assert.equal(points.length, 6, 'the committed array is the canonical 6-point form');
  assert.equal(points[4].v, 0.5, 'the dragged sustain');
  for (const h of canvas.listeners.pointerup ?? [])
    h({ clientX: 480, clientY: 203, pointerId: 1 });
  // The caller's contract (main.js): setPath, then the sync pass calls
  // redraw — the strip RE-RENDERS the isolated source from the fresh
  // patch (the shaped envelope is visible on the sound it carves).
  setPath(drum.patch, editPath, points);
  const sCtx = modal.strip.getContext('2d');
  const sBefore = sCtx.calls.length;
  modal.redraw();
  assert.ok(sCtx.calls.length > sBefore, 'the modal redraw re-rendered the strip from the patch');
});

test('initEnvModal: drawPlayhead paints the line on the PLOT and the STRIP at the window\'s x (no-op closed; a repaint first)', () => {
  const { drum, modal } = makeModal();
  // Closed: a no-op (no paint, no crash).
  const ctx = modal.canvas.getContext('2d');
  const sCtx = modal.strip.getContext('2d');
  const n0 = ctx.calls.length;
  const s0 = sCtx.calls.length;
  modal.drawPlayhead(0.1);
  assert.equal(ctx.calls.length, n0, 'closed: drawPlayhead is a no-op (plot)');
  assert.equal(sCtx.calls.length, s0, 'closed: drawPlayhead is a no-op (strip)');

  modal.open(drum, 0);
  const n1 = ctx.calls.length; // the open paint
  const s1 = sCtx.calls.length;
  modal.drawPlayhead(0.25); // the drum middle -> the plot middle (600 px)
  assert.ok(ctx.calls.slice(n1).length > 0, 'the plot repainted first (drawPlayhead never clears)');
  assert.ok(sCtx.calls.slice(s1).length > 0, '... and so did the strip');
  const line = ctx.strokes[ctx.strokes.length - 1];
  assert.deepEqual(line.pts, [
    { x: 600.5, y: 6 },
    { x: 600.5, y: 420 - 20 },
  ], 'the plot line at the window\'s x for t (half-pixel aligned, plot top to bottom)');
  const sLine = sCtx.strokes[sCtx.strokes.length - 1];
  assert.deepEqual(sLine.pts, [
    { x: 600.5, y: 6 },
    { x: 600.5, y: 160 - 20 },
  ], '... and the SAME x on the strip (same window, same width; the strip is shorter)');

  // A time outside the window (zoomed in): the bases repaint, the
  // line no-ops on BOTH views (drawPlayhead's bounds check). The
  // playhead line is identified by its stroke style (the axis grid
  // lines are also vertical 2-point strokes — the base repaint
  // legitimately adds them, so the count is filtered on
  // COLORS.playhead).
  const playheadStrokes = (strokes) =>
    strokes.filter((s) => s.strokeStyle === COLORS.playhead).length;
  const [zoomIn] = modal.overlay.children[0].children.slice(1, 2);
  for (let i = 0; i < 4; i++) fire(zoomIn, 'click'); // span 0.5 -> 0.03125, t0 0.234375
  const n2 = ctx.calls.length;
  const s2 = sCtx.calls.length;
  const phBefore = playheadStrokes(ctx.strokes);
  const sPhBefore = playheadStrokes(sCtx.strokes);
  modal.drawPlayhead(0.01); // far outside the zoomed window
  assert.ok(ctx.calls.length > n2, 'the plot base still repaints (erasing the stale line)');
  assert.equal(playheadStrokes(ctx.strokes), phBefore, '... but no new plot line (the time is outside the window)');
  assert.ok(sCtx.calls.length > s2, 'the strip base still repaints');
  assert.equal(playheadStrokes(sCtx.strokes), sPhBefore, '... but no new strip line either');
});

test('initEnvModal: the pitch plot paints the log-Hz range with note labels (the modal\'s pitch kind)', () => {
  const { drum, modal } = makeModal();
  modal.open(drum, 0, 'layers.0.pitchEnv');
  const ctx = modal.canvas.getContext('2d');
  const labels = ctx.calls.filter(([m, t, x]) => m === 'fillText' && x === 4).map(([, t]) => t);
  // The kick's pitchEnv: 100 -> 50 Hz; the range fits the env itself.
  assert.deepEqual(labels, [hzToNoteName(100), hzToNoteName(50)], 'the note edge labels');
});

// ---- the strip's pure mapping (plan "dahdsr" P4/S2) -------------------

// A 1 s hit at 1000 Hz: a +0.25 impulse at t = 0.25 s (sample 250)
// and a -0.5 impulse at t = 0.749 s (sample 749), silent otherwise —
// slice peak 0.5, so the auto-fit scales by 2. The trace math runs on
// a small 100×100 strip (plotH = 74, mid = 37); full window = 10
// samples per column, the [0.25, 0.75) zoom = 5.
const SW = 100; // strip width for the pure-mapping tests
const SH = 100; // strip height (plotH = 74, midline at 37)
const S_SAMP = 1000; // the sample rate (1 s buffer)
const S_DUR = 1; // the drum's duration
const spikeBuffer = () => {
  const buf = new Float32Array(S_SAMP);
  buf[250] = 0.25;
  buf[749] = -0.5;
  return buf;
};

test('stripSlice: the window maps to the buffer\'s sample range (clamped to the buffer)', () => {
  const buf = spikeBuffer();
  assert.equal(stripSlice(buf, S_SAMP, { t0: 0, span: 1 }, S_DUR).length, 1000, 'the full window is the whole buffer');
  const mid = stripSlice(buf, S_SAMP, { t0: 0.25, span: 0.5 }, S_DUR);
  assert.equal(mid.length, 500, 'the mid window is samples [250, 750)');
  assert.equal(mid[0], 0.25, '... starting on the +0.25 impulse (inclusive)');
  assert.equal(mid[499], -0.5, '... ending on the -0.5 impulse at 749 (750 itself is exclusive)');
  // A window past a SHORT buffer's end is empty (a silent tail):
  // the slice clamps at the buffer end rather than going negative.
  const short = buf.subarray(0, 500);
  assert.equal(stripSlice(short, S_SAMP, { t0: 0.9, span: 0.1 }, S_DUR).length, 0, 'past the buffer end: empty slice');
});

test('stripTrace: amplitude auto-fit — the slice\'s own peak maps to the plot\'s full height', () => {
  const buf = spikeBuffer();
  const trace = stripTrace(buf, S_SAMP, { t0: 0, span: 1 }, S_DUR, SW, SH);
  assert.equal(trace.length, SW * 2, 'one [yTop, yBottom] pair per pixel column');
  // The +0.25 impulse sits in column 25 (samples [250, 260)): its raw
  // top is 37·(1−0.25) = 27.75, the 2× fit lifts it to 18.5; the
  // column's zero floor stays on the midline.
  assert.equal(trace[25 * 2], 18.5, 'the positive column\'s fitted top');
  assert.equal(trace[25 * 2 + 1], 37, '... and its midline floor');
  // The -0.5 impulse sits in column 74 (samples [740, 750)): its raw
  // bottom is 37·1.5 = 55.5, and 55.5 is the SLICE PEAK's excursion —
  // the fit maps it to the BOTTOM edge (74); its zero ceiling stays
  // on the midline.
  assert.equal(trace[74 * 2], 37, 'the negative column\'s midline ceiling');
  assert.equal(trace[74 * 2 + 1], 74, '... and its fitted bottom edge (the 0.5 peak fills the plot)');
  // Silent columns stay on the midline (both edges).
  assert.equal(trace[0], 37);
  assert.equal(trace[1], 37);
  assert.equal(trace[40 * 2], 37);
  assert.equal(trace[40 * 2 + 1], 37);
});

test('stripTrace: the window moves the trace — the same impulses land in different columns when zoomed', () => {
  const buf = spikeBuffer();
  // Zoom to [0.25, 0.75): the +0.25 impulse is at the window START
  // (column 0, fitted top 18.5 — the slice peak is still 0.5), the
  // -0.5 impulse in the LAST column (slice [745, 750) holds 749).
  const trace = stripTrace(buf, S_SAMP, { t0: 0.25, span: 0.5 }, S_DUR, SW, SH);
  assert.equal(trace[0], 18.5, 'the start impulse: column 0 top, auto-fitted');
  assert.equal(trace[(SW - 1) * 2 + 1], 74, 'the tail impulse: last column bottom edge');
});

test('stripTrace: a silent slice is the flat midline (no division); an all-negative column stays below the midline', () => {
  const buf = spikeBuffer();
  const silent = stripTrace(buf, S_SAMP, { t0: 0.4, span: 0.1 }, S_DUR, SW, SH);
  for (let x = 0; x < SW; x++) {
    assert.equal(silent[x * 2], 37, `column ${x} top`);
    assert.equal(silent[x * 2 + 1], 37, `column ${x} bottom`);
  }
  // An all-negative COLUMN (samples [500, 510) all -1): the column's
  // max is negative, so BOTH edges of its excursion sit at the bottom
  // edge (the midline-stay rescale keeps the column below the
  // midline, not mirrored above it).
  const neg = new Float32Array(S_SAMP);
  for (let i = 500; i < 510; i++) neg[i] = -1;
  const t = stripTrace(neg, S_SAMP, { t0: 0, span: 1 }, S_DUR, SW, SH);
  assert.equal(t[50 * 2], 74, 'all-negative column: top edge at the bottom');
  assert.equal(t[50 * 2 + 1], 74, '... bottom edge too');
  // ... while a column with a lone -1 among zeros spans midline ->
  // bottom (its max is 0, its min -1).
  const lone = new Float32Array(S_SAMP);
  lone[500] = -1;
  const t2 = stripTrace(lone, S_SAMP, { t0: 0, span: 1 }, S_DUR, SW, SH);
  assert.equal(t2[50 * 2], 37, 'lone-negative column: midline ceiling');
  assert.equal(t2[50 * 2 + 1], 74, '... bottom edge');
});
