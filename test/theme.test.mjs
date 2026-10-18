// The theme drift guard (plan "colors", step 1).
//
// src/app/theme.js is the single source for every color in the app;
// the :root block in index.html is its CSS mirror. This file makes
// "keep in sync" mechanical (the SHAPE_OPTIONS/WAVE_SHAPES enum-guard
// precedent, test/cards.test.mjs):
//
//   1. Mirror: the :root block's --name → value map deep-equals
//      cssTokens() in BOTH directions — a cssTokens() var missing
//      from :root (or vice versa) fails, as does a value drift. The
//      guard SELECTS only the names in cssTokens(): :root also
//      carries NON-color layout tokens (--radius-*, --shadow-*,
//      plan "colors" S2) that are exempt from the color mirror by
//      design. (The dynamic --drum variable is runtime-only — in
//      neither.)
//   2. Drum hues: all 11 (7 DRUM_COLORS + 4 EXTRA_DRUM_COLORS) are
//      pairwise distinct, and every DRUM_COLORS value is a --drum-*
//      var in :root (the mirror half of the guard).
//   3. Contrast sanity: text / muted / faint on panel all reach
//      4.5:1 — the WCAG normal-text minimum — computed by a small
//      pure ratio function here, not eyeballed.
//
// Node here is a test tool only (GUIDELINES.md §1.1): the index.html
// parse uses node:fs, the library-purity test precedent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DRUM_COLORS,
  EXTRA_DRUM_COLORS,
  THEME,
  cssTokens,
} from '../src/app/theme.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Parse the :root { … } block out of index.html into a Map of
// --name → value. Comments are stripped first (the block carries
// explanatory ones); the block holds no nested braces, so the first
// closing brace ends it. Values are trimmed — the comparison is on
// exact strings, so both sides must format rgba() identically.
const rootVars = async () => {
  const html = await readFile(join(repoRoot, 'index.html'), 'utf8');
  const block = html.match(/:root\s*\{([\s\S]*?)\}/)?.[1];
  assert.ok(block, 'index.html must contain a :root { … } block');
  const noComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  const vars = new Map();
  for (const m of noComments.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars.set(m[1], m[2].trim());
  }
  return vars;
};

test('cssTokens() and the :root block mirror each other exactly (drift guard)', async () => {
  const tokens = new Map(cssTokens());
  // Select only the cssTokens() names: :root also carries non-color
  // layout tokens (--radius-*, --shadow-* — plan "colors" S2), which
  // are exempt from the color mirror by design.
  const vars = new Map(
    [...(await rootVars()).entries()].filter(([name]) => tokens.has(name)),
  );
  // :root → theme.js: every guarded var on the page has a matching token.
  for (const [name, value] of vars) {
    assert.ok(tokens.has(name), `:root has ${name} but cssTokens() does not`);
    assert.equal(tokens.get(name), value, `value drift on ${name}`);
  }
  // theme.js → :root: every token is on the page.
  for (const [name, value] of tokens) {
    assert.ok(vars.has(name), `cssTokens() has ${name} but :root does not`);
    assert.equal(vars.get(name), value, `value drift on ${name}`);
  }
  assert.equal(vars.size, tokens.size, 'same number of vars on both sides');
});

test('all 11 drum hues are pairwise distinct (7 presets + 4 spares)', () => {
  const all = [...Object.values(DRUM_COLORS), ...EXTRA_DRUM_COLORS];
  assert.equal(all.length, 11);
  assert.equal(new Set(all).size, 11, 'a preset and a spare share a hue');
});

test('every DRUM_COLORS value is a --drum-* var in :root (the mirror half)', async () => {
  const vars = await rootVars();
  for (const [name, value] of Object.entries(DRUM_COLORS)) {
    const cssName = `--drum-${name}`;
    assert.ok(vars.has(cssName), `DRUM_COLORS.${name} needs a ${cssName} var in :root`);
    assert.equal(vars.get(cssName), value, `${cssName} drifted from DRUM_COLORS.${name}`);
  }
});

// ---- contrast sanity (computed, not eyeballed) ---------------------
// WCAG relative luminance + contrast ratio, inlined on purpose: the
// test is the only consumer, and a color math library would be an
// external dependency (GUIDELINES §1.1).
const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `expected a #rrggbb hex, got ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const relLuminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrastRatio = (a, b) => {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('text / muted / faint on panel all reach 4.5:1 (WCAG normal text)', () => {
  for (const key of ['text', 'muted', 'faint']) {
    const ratio = contrastRatio(THEME[key], THEME.panel);
    assert.ok(ratio >= 4.5, `${key} (${THEME[key]}) on panel: ${ratio.toFixed(2)}:1 < 4.5:1`);
  }
});
