// Library-purity boundary test (plan "cleaning", step 14).
//
// src/lib/ is the pure audio library tier: no browser, no UI, no Node.
// This file makes that structural instead of aspirational:
//
//   1. No browser-only global (DOM, Web Audio, timers, storage, network)
//      is referenced anywhere under src/lib/. Matching is word-boundary
//      (so "documented" never counts) and runs on source with comments
//      and string literals stripped — a mention in prose or an error
//      message is not a reference to the global.
//   2. Every module specifier in src/lib/ (import … from, export … from
//      re-exports — the facade is written entirely of those — plus
//      side-effect and dynamic imports) is a relative path that resolves
//      back inside src/lib/: no bare specifiers, no escape to src/app/,
//      no .. climbing above the library, no dangling paths.
//   3. The facade src/lib/index.js exists — it is part of the contract.
//
// Node here is a test tool only (GUIDELINES.md §1.1): this file never
// imports src/ code, it scans it as text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const libDir = join(repoRoot, 'src', 'lib');

// Browser-only globals banned from the pure library tier. Matched with
// word boundaries, case-sensitive — these are the real global names.
const BROWSER_GLOBALS = [
  'document',
  'window',
  'AudioContext',
  'webkitAudioContext',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'navigator',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'WebSocket',
  'fetch',
  'location',
  'alert',
  'confirm',
  'prompt',
  'matchMedia',
  'XMLHttpRequest',
  'HTMLElement',
];

// Keywords that can directly precede a regex literal (expression start).
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

// The ESM module-specifier shapes, with the specifier in group 2.
// Applied to comment-stripped source; a `;` or quote cannot appear in the
// binding list, so [^'";] cannot run past the statement or into another
// string.
const IMPORT_FROM_RE = /\bimport\s+[^'";]*?\bfrom\s*(['"])([^'"\n]+)\1/g;
const EXPORT_FROM_RE = /\bexport\s+[^'";]*?\bfrom\s*(['"])([^'"\n]+)\1/g;
const SIDE_EFFECT_IMPORT_RE = /\bimport\s*(['"])([^'"\n]+)\1/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

// --- source scanning helpers --------------------------------------------

/**
 * Recursively enumerate every .js file under dir (sorted, for stable
 * output).
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files.sort();
}

/**
 * True when a `/` in code state starts a regex literal rather than a
 * division, decided from the last significant token: an identifier,
 * number, closing paren/bracket, or closing quote ends a primary
 * expression (division); everything else — operators, opening brackets,
 * punctuation, statement start, or an expression-start keyword — is an
 * expression position (regex).
 * @param {string} lastTok
 */
function regexAllowedAfter(lastTok) {
  if (lastTok === '') return true;
  if (lastTok === 'ident' || lastTok === 'num') return false;
  if (REGEX_KEYWORDS.has(lastTok)) return true;
  if (/[)\]"'`]/.test(lastTok)) return false;
  return true;
}

/**
 * Index just past the regex literal starting at src[start] === '/'.
 * Respects \-escapes and [..] character classes; if no closing slash
 * appears before a newline, it was a division — consume just the '/'.
 * @param {string} src
 * @param {number} start
 */
function regexEnd(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') {
      inClass = true;
    } else if (c === '/') {
      i += 1;
      break;
    } else if (c === '\n') {
      return start + 1; // not a regex after all — treat as division
    }
    i += 1;
  }
  while (i < src.length && /[a-z]/i.test(src[i])) i += 1; // flags
  return i;
}

/**
 * Strip comments (// … and /* … *\/) from JS source, optionally also
 * blanking string and template literals. A small state machine rather
 * than a regex, so it respects escape sequences, ${ … } interpolation
 * (including nested templates), and regex literals — a "http://…" in a
 * string is not a comment, and a [//] in a regex is not a string.
 * Newlines are preserved wherever content is dropped, so line numbers
 * computed on the result still match the original file.
 *
 * @param {string} src source text
 * @param {{blankStrings?: boolean}} [opts] blankStrings=true also removes
 *   the contents (and delimiters) of '…', "…" and `…` literals and of
 *   regex literals — but never of the code itself, including template
 *   interpolation, which is real code.
 * @returns {string}
 */
function stripSource(src, { blankStrings = false } = {}) {
  let out = '';
  let i = 0;
  let lastTok = ''; // last significant token: keyword | 'ident' | 'num' | char
  const stack = []; // 'line' | 'block' | 'template' | 'interp' | { str }
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    const top = stack[stack.length - 1];

    if (top === undefined || top === 'interp') {
      // Code state (top level, or inside a template's ${ … }). Code is
      // always kept — blank mode blanks strings, templates and regexes,
      // never the code around them.
      if (top === 'interp' && c === '}') {
        stack.pop();
        out += c;
        i += 1;
        continue;
      }
      if (c === '/' && d === '/') { stack.push('line'); i += 2; continue; }
      if (c === '/' && d === '*') { stack.push('block'); i += 2; continue; }
      if (c === '/' && regexAllowedAfter(lastTok)) {
        const end = regexEnd(src, i);
        if (!blankStrings) out += src.slice(i, end);
        lastTok = ')'; // a regex literal ends a primary expression
        i = end;
        continue;
      }
      if (c === "'" || c === '"') {
        stack.push({ str: c });
        if (!blankStrings) out += c;
        i += 1;
        continue;
      }
      if (c === '`') {
        stack.push('template');
        if (!blankStrings) out += c;
        i += 1;
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
        const word = src.slice(i, j);
        lastTok = REGEX_KEYWORDS.has(word) ? word : 'ident';
        out += word;
        i = j;
        continue;
      }
      if (c >= '0' && c <= '9') {
        let j = i;
        while (j < n && /[0-9a-fA-FxXeE_.]/.test(src[j])) j += 1;
        lastTok = 'num';
        out += src.slice(i, j);
        i = j;
        continue;
      }
      out += c;
      if (!/\s/.test(c)) lastTok = c;
      i += 1;
      continue;
    }

    if (top === 'line') {
      if (c === '\n') { stack.pop(); out += '\n'; }
      i += 1;
      continue;
    }

    if (top === 'block') {
      if (c === '*' && d === '/') { stack.pop(); i += 2; continue; }
      if (c === '\n') out += '\n';
      i += 1;
      continue;
    }

    if (typeof top === 'object') {
      // Inside a '…' or "…" string.
      if (c === '\\') {
        if (!blankStrings) out += c + (d === '' ? '' : d);
        i += 2;
        continue;
      }
      if (c === top.str) {
        stack.pop();
        if (!blankStrings) out += c;
        lastTok = top.str; // a string literal ends a primary expression
        i += 1;
        continue;
      }
      if (c === '\n') { stack.pop(); i += 1; continue; } // unterminated — bail
      if (!blankStrings || c === '\n') out += c;
      i += 1;
      continue;
    }

    if (top === 'template') {
      if (c === '\\') {
        if (!blankStrings) out += c + (d === '' ? '' : d);
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        if (!blankStrings) out += c;
        lastTok = '`'; // a template literal ends a primary expression
        i += 1;
        continue;
      }
      if (c === '$' && d === '{') {
        stack.push('interp');
        if (!blankStrings) out += '${';
        i += 2;
        continue;
      }
      if (!blankStrings || c === '\n') out += c;
      i += 1;
      continue;
    }
  }
  return out;
}

/**
 * Extract every module specifier from comment-stripped source (strings
 * must be kept — the specifiers live in them).
 * @param {string} code
 * @returns {Array<{spec: string, line: number}>}
 */
function extractSpecifiers(code) {
  const specs = [];
  const patterns = [
    IMPORT_FROM_RE,
    EXPORT_FROM_RE,
    SIDE_EFFECT_IMPORT_RE,
    DYNAMIC_IMPORT_RE,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      specs.push({
        spec: m[2],
        line: code.slice(0, m.index).split('\n').length,
      });
    }
  }
  return specs;
}

// --- tests ----------------------------------------------------------------

test('the facade src/lib/index.js exists (contract)', async () => {
  await assert.doesNotReject(
    stat(join(libDir, 'index.js')),
    'src/lib/index.js is missing — the facade is part of the library contract',
  );
});

test('src/lib/ enumerates the library (non-vacuous guard)', async () => {
  const files = await listJsFiles(libDir);
  assert.ok(
    files.length > 0,
    'no .js files found under src/lib/ — the boundary checks would be vacuous',
  );
});

test('stripSource strips comments/strings without shifting lines', () => {
  // Comments are dropped; a "URL" inside a string is not a comment.
  assert.equal(
    stripSource('const a = 1; // fetch location', { blankStrings: true }),
    'const a = 1; ',
  );
  assert.equal(
    stripSource('const a = /* window */ 1;', { blankStrings: true }),
    'const a =  1;',
  );
  assert.equal(
    stripSource('const u = "http://example.com";'),
    'const u = "http://example.com";',
  );
  // String contents are blanked (with escapes) in blank mode.
  assert.equal(
    stripSource('const u = "fetch here";', { blankStrings: true }),
    'const u = ;',
  );
  assert.equal(
    stripSource("const s = 'it\\'s a // test';", { blankStrings: true }),
    'const s = ;',
  );
  // Template static text is blanked, but interpolation is real code and
  // survives — it may reference globals. Nested templates work too.
  assert.equal(
    stripSource('const s = `x${document}y`;', { blankStrings: true }),
    'const s = document};', // static text blanked, interp code (incl. '}') kept
  );
  assert.equal(
    stripSource('const s = `a${`b`}c`;', { blankStrings: true }),
    'const s = };',
  );
  // Regex literals survive (incl. a slash inside a class); a regex after
  // an expression-start keyword is recognized, divisions are not eaten.
  assert.equal(
    stripSource('const r = /[//]/.test(u);'),
    'const r = /[//]/.test(u);',
  );
  assert.equal(
    stripSource('return /fetch/g.test(s);', { blankStrings: true }),
    'return .test(s);',
  );
  assert.equal(stripSource('const x = a / b;'), 'const x = a / b;');
  assert.equal(stripSource('const x = f(a) / 2;'), 'const x = f(a) / 2;');
  // Line count is preserved in both modes.
  const multi = 'a /* x\ny */ b // fetch\n`c\nd${e}\nf`';
  for (const blankStrings of [false, true]) {
    assert.equal(
      stripSource(multi, { blankStrings }).split('\n').length,
      multi.split('\n').length,
    );
  }
});

test('no browser-only globals anywhere in src/lib/', async () => {
  const files = await listJsFiles(libDir);
  const violations = [];
  for (const file of files) {
    const src = await readFile(file, 'utf8');
    // Comments and string literals are stripped: a mention of a browser
    // global in prose or an error message is not a reference to it.
    const code = stripSource(src, { blankStrings: true });
    // Canary: the stripper must not shift lines, or the report below lies.
    assert.equal(
      code.split('\n').length,
      src.split('\n').length,
      `${relative(repoRoot, file)}: stripper changed the line count`,
    );
    for (const name of BROWSER_GLOBALS) {
      const re = new RegExp(`\\b${name}\\b`, 'g');
      for (const m of code.matchAll(re)) {
        const line = code.slice(0, m.index).split('\n').length;
        violations.push(`${relative(repoRoot, file)}:${line}: '${name}'`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'browser-only globals in the pure library tier:\n  ' + violations.join('\n  '),
  );
});

test('every module specifier in src/lib/ stays inside src/lib/', async () => {
  const files = await listJsFiles(libDir);
  const violations = [];
  let specCount = 0;
  let facadeSpecs = 0;
  for (const file of files) {
    const src = await readFile(file, 'utf8');
    const code = stripSource(src); // strings kept: specifiers live in them
    const relFile = relative(repoRoot, file);
    for (const { spec, line } of extractSpecifiers(code)) {
      specCount += 1;
      if (relFile === 'src/lib/index.js') facadeSpecs += 1;
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        violations.push(
          `${relFile}:${line}: bare (non-relative) specifier '${spec}'`,
        );
        continue;
      }
      const resolved = resolve(dirname(file), spec);
      const inLib = relative(libDir, resolved);
      if (inLib.startsWith('..') || isAbsolute(inLib)) {
        violations.push(
          `${relFile}:${line}: '${spec}' escapes src/lib/ (→ ${inLib})`,
        );
        continue;
      }
      const st = await stat(resolved).catch(() => null);
      if (!st || !st.isFile()) {
        violations.push(
          `${relFile}:${line}: '${spec}' does not resolve to a file in src/lib/`,
        );
      }
    }
  }
  assert.ok(
    specCount > 0,
    'no module specifiers found at all — the extraction is broken',
  );
  assert.ok(
    facadeSpecs > 0,
    'the facade has no re-exports — it is part of the contract',
  );
  assert.deepEqual(
    violations,
    [],
    'lib import boundary violations:\n  ' + violations.join('\n  '),
  );
});
