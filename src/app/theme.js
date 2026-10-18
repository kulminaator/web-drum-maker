// The single source for every color in the app (plan "colors", step 1).
//
// Pure data — no DOM, no imports (app tier). The CSS mirror lives in
// the :root block of index.html and is kept in sync MECHANICALLY:
// cssTokens() is the drift-guard contract (test/theme.test.mjs
// deep-equals the :root block against it in both directions), so the
// old "keep in sync" comments are history.
//
// The dynamic --drum variable (set on body at runtime, plan step 3)
// is deliberately NOT a token here: it is the active drum's hue, a
// value, not a palette entry — it lives in neither :root nor theme.js.

// Base palette: a deep indigo "dusk" base (plan ui3 P4 — the 90s
// black-and-green is retired: the page base is clearly indigo, not
// black), with two LIFTED surface tiers (panel = the main panels,
// raised well clear of the page base so the dark-well controls sitting
// on them read as distinct objects; panel2 = the raised children one
// step higher), an indigo line family (grid/mid/axis at rising
// alpha), and three text tiers retuned to hold 4.5:1 on the indigo
// panel (the contrast guard in test/theme.test.mjs is the arbiter,
// not the eye). The body backdrop's two-stop dusk wash is tokenized
// too (washTop → washBottom over the top 240 px — plan "colors" S2's
// one-sanctioned-non-token #1a2130 is retired: the stops ARE colors,
// so the drift guard mirrors them via cssTokens()).
export const THEME = {
  bg: '#14162b', // the deep indigo page base — dusk, not black
  washTop: '#2b2153', // the body backdrop's violet-dusk stop at 0 px
  washBottom: '#191a33', // the body backdrop's stop at 240 px
  panel: '#23264a', // the main panels — lifted so buttons/knobs stand out
  panel2: '#2d315c', // raised surfaces (card blocks, strip rows, slots)
  canvasBg: '#0f1124', // the scope well stays dark for trace contrast
  edge: '#4a5183',
  edgeSoft: '#3a4070',
  text: '#f2f1fb',
  muted: '#a7adc9',
  faint: '#8f96bd', // tertiary — brightened with the lifted panels to keep 4.5:1 on panel
  accent: '#ff6d5a', // the app's identity coral (also the kick hue)
  // The primary button's gradient end-stop (plan "colors" S7): an
  // apricot orange that sits next to the accent on the wheel.
  // Deliberately the same hue as EXTRA_DRUM_COLORS[0] (the first
  // spare) — tokenized so the button rule carries no raw hex; the two
  // stay equal by design.
  accent2: '#ff9e64',
  accentInk: '#07130d',
  solo: '#fbbf24', // lit S button + card solo dot (a state color, never a drum hue)
  playhead: '#f8fafc', // playback cursor — white reads modern on colored traces
  // Error / inline-warning text (.band-error, .add-source-error) — a
  // warm red, distinct from the solo amber (a warning, not an error).
  // Promoted from the raw hexes in index.html by the S11 pass
  // (hygiene: no raw color literal outside this file + the :root mirror).
  error: '#ff6b6b',
  // Canvas-only line tones (no :root twin — nothing in CSS paints
  // them): a violet tint that reads as dusk-soft, not slate-gray.
  grid: 'rgba(167, 163, 209, 0.12)', // light grid lines
  mid: 'rgba(167, 163, 209, 0.32)', // 0-amplitude reference line
  axis: 'rgba(167, 163, 209, 0.60)', // tick labels
};

// The full 7-hue preset drum family: the classic three (moved out of
// viz.js) plus tom/clap/cymbal/blank, which replace the old anonymous
// spares for the four newer presets. Blank is a neutral slate by
// design — the empty preset gets no loud hue.
export const DRUM_COLORS = {
  kick: '#ff6d5a', // = THEME.accent (the identity hue)
  snare: '#ffb454',
  hihat: '#38bdf8',
  tom: '#a78bfa',
  clap: '#fb7185',
  cymbal: '#e879f9',
  blank: '#94a3b8',
};

// Spare hues for custom (non-preset) drums, assigned in order by
// main.js's dedupe logic (colorForNewDrum — the first color no
// current drum uses). Not in :root: custom drums have no CSS mirror.
export const EXTRA_DRUM_COLORS = ['#ff9e64', '#facc15', '#f97316', '#60a5fa'];

// Per-source pitch-curve hues for the band: the drum family leads
// (the classic three first, as before, so the band's first curves keep
// their old colors), then the first spare past the seventh source; the
// list cycles past 8 sources (the card-row cap). Several FM curves of
// one drum must stay distinguishable (the working source is
// additionally highlighted).
export const BAND_SOURCE_COLORS = [
  DRUM_COLORS.kick,
  DRUM_COLORS.hihat,
  DRUM_COLORS.snare,
  DRUM_COLORS.tom,
  DRUM_COLORS.clap,
  DRUM_COLORS.cymbal,
  DRUM_COLORS.blank,
  EXTRA_DRUM_COLORS[0],
];

// The drift-guard contract: the flat --var: value list of every color
// token in :root, exactly what the :root block in index.html must
// contain (test/theme.test.mjs compares both directions). The
// canvas-only tokens (grid/mid/axis — no CSS paints them) and the
// dynamic --drum variable (runtime, set on body) are deliberately NOT
// in it.
export const cssTokens = () => [
  ['--bg', THEME.bg],
  ['--wash-top', THEME.washTop],
  ['--wash-bottom', THEME.washBottom],
  ['--panel', THEME.panel],
  ['--panel-2', THEME.panel2],
  ['--canvas-bg', THEME.canvasBg],
  ['--edge', THEME.edge],
  ['--edge-soft', THEME.edgeSoft],
  ['--text', THEME.text],
  ['--muted', THEME.muted],
  ['--faint', THEME.faint],
  ['--accent', THEME.accent],
  ['--accent-2', THEME.accent2],
  ['--accent-ink', THEME.accentInk],
  ['--solo', THEME.solo],
  ['--playhead', THEME.playhead],
  ['--error', THEME.error],
  ['--drum-kick', DRUM_COLORS.kick],
  ['--drum-snare', DRUM_COLORS.snare],
  ['--drum-hihat', DRUM_COLORS.hihat],
  ['--drum-tom', DRUM_COLORS.tom],
  ['--drum-clap', DRUM_COLORS.clap],
  ['--drum-cymbal', DRUM_COLORS.cymbal],
  ['--drum-blank', DRUM_COLORS.blank],
];
