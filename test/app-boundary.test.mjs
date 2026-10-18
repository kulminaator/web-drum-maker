// App-boundary test (plan "cleaning", step 16).
//
// Step 14's test/library-purity.test.mjs guards the library side of the
// split: src/lib/ is pure and its imports never leave src/lib/. This file
// guards the other three edges of the same contract:
//
//   1. Every .js file under src/app/ reaches the library ONLY through the
//      facade src/lib/index.js. A deep import like '../lib/engine.js'
//      fails — that is exactly how the pre-cleanup binding leaked into
//      library internals. Imports between app modules (./viz.js,
//      ./controls.js) are the binding's own business and stay allowed.
//      Non-relative specifiers (npm packages, node: builtins) are banned:
//      the binding is browser code (GUIDELINES.md §1.1).
//   2. index.html loads exactly one <script>, and it is the binding entry
//      <script type="module" src="src/app/main.js"> — the HTML tier never
//      reaches the library directly.
//   3. src/ holds no .js files at its top level — only the lib/ and app/
//      subdirectories. The two-tier layout is complete and stays so.
//   4. test/facade.test.mjs (the headless-consumer contract test, step 15)
//      itself honors the contract it proves: its only project import is
//      the facade ../src/lib/index.js.
//
// Node here is a test tool only (GUIDELINES.md §1.1): this file never
// imports src/ code, it scans it as text. Like test/library-purity.test.mjs
// it is deliberately self-contained (the scanner below is the same
// comment-stripping state machine, duplicated on purpose so each boundary
// test stands alone and can be read without loading the other).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(repoRoot, 'src', 'app');
const libDir = join(repoRoot, 'src', 'lib');
const srcDir = join(repoRoot, 'src');
const FACADE_REL = 'src/lib/index.js';

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
// (Identical to test/library-purity.test.mjs — kept in sync on purpose.)

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

test('src/app/ enumerates the binding layer (non-vacuous guard)', async () => {
  const files = await listJsFiles(appDir);
  assert.ok(
    files.length > 0,
    'no .js files found under src/app/ — the boundary checks would be vacuous',
  );
  assert.ok(
    files.includes(join(appDir, 'main.js')),
    'src/app/main.js is missing — it is the binding entry index.html loads',
  );
});

test('src/app/ reaches src/lib/ only through the facade', async () => {
  const files = await listJsFiles(appDir);
  const violations = [];
  let specCount = 0;
  let facadeCount = 0;
  for (const file of files) {
    const src = await readFile(file, 'utf8');
    const code = stripSource(src); // strings kept: specifiers live in them
    const relFile = relative(repoRoot, file);
    for (const { spec, line } of extractSpecifiers(code)) {
      specCount += 1;
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        violations.push(
          `${relFile}:${line}: non-relative specifier '${spec}' — the binding `
          + 'is browser code: no npm packages, no node: builtins (GUIDELINES §1.1)',
        );
        continue;
      }
      const resolved = resolve(dirname(file), spec);
      const relToRepo = relative(repoRoot, resolved);
      if (relToRepo.startsWith('..') || isAbsolute(relToRepo)) {
        violations.push(
          `${relFile}:${line}: '${spec}' escapes the repo (→ ${relToRepo})`,
        );
        continue;
      }
      if (relToRepo === FACADE_REL) {
        facadeCount += 1;
        continue;
      }
      if (relToRepo.startsWith('src/lib/')) {
        violations.push(
          `${relFile}:${line}: deep library import '${spec}' → ${relToRepo} — `
          + 'src/app/ may import src/lib/ only through the facade '
          + 'src/lib/index.js',
        );
        continue;
      }
      const st = await stat(resolved).catch(() => null);
      if (!st || !st.isFile()) {
        violations.push(
          `${relFile}:${line}: '${spec}' does not resolve to an existing file`,
        );
      }
    }
  }
  assert.ok(
    specCount > 0,
    'no module specifiers found at all — the extraction is broken',
  );
  assert.ok(
    facadeCount > 0,
    'no app module imports the facade — the binding drives the library, '
    + 'so at least one facade import is expected',
  );
  assert.deepEqual(
    violations,
    [],
    'app import boundary violations:\n  ' + violations.join('\n  '),
  );
});

test('index.html loads only the binding entry', async () => {
  const html = await readFile(join(repoRoot, 'index.html'), 'utf8');
  const entry = '<script type="module" src="src/app/main.js">';
  assert.ok(
    html.includes(entry),
    `index.html must load the binding entry: ${entry}</script>`,
  );
  const scriptCount = (html.match(/<script\b/g) || []).length;
  assert.equal(
    scriptCount,
    1,
    `index.html must contain exactly one <script> tag (the binding entry), `
    + `found ${scriptCount} — the HTML tier never loads library modules`,
  );
});

test('src/ holds only the lib/ and app/ subdirectories (two-tier layout)', async () => {
  const entries = await readdir(srcDir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(
    files,
    [],
    `no files (in particular no .js) at the top level of src/, found: `
    + (files.join(', ') || '(none)'),
  );
  assert.deepEqual(
    dirs,
    ['app', 'lib'],
    `src/ must hold exactly the two tier directories lib/ and app/, `
    + `found: ${dirs.join(', ') || '(none)'}`,
  );
});

test('test/facade.test.mjs honors the contract it proves', async () => {
  const file = join(repoRoot, 'test', 'facade.test.mjs');
  const src = await readFile(file, 'utf8');
  const code = stripSource(src);
  const specs = extractSpecifiers(code).map((s) => s.spec);
  assert.ok(
    specs.length > 0,
    'no module specifiers found — the extraction is broken',
  );
  const projectImports = specs.filter(
    (s) => s.startsWith('./') || s.startsWith('../'),
  );
  assert.deepEqual(
    projectImports,
    ['../src/lib/index.js'],
    'the headless-consumer test must reach the library only through the '
    + 'facade, like the binding it imitates',
  );
  for (const spec of specs) {
    assert.ok(
      spec.startsWith('node:') || spec === '../src/lib/index.js',
      `test/facade.test.mjs: unexpected specifier '${spec}' — only node: `
      + 'builtins and the facade are allowed (no npm packages)',
    );
  }
});

test('stripSource strips comments without shifting lines (scanner self-test)', () => {
  // Comments are dropped; a "URL" inside a string is not a comment.
  assert.equal(
    stripSource('const a = 1; // import x from "../lib/engine.js"'),
    'const a = 1; ',
  );
  assert.equal(
    stripSource('const a = /* import x from "./viz.js" */ 1;'),
    'const a =  1;',
  );
  assert.equal(
    stripSource('const u = "http://example.com";'),
    'const u = "http://example.com";',
  );
  // Escapes inside strings are respected.
  assert.equal(
    stripSource("const s = 'it\\'s a // test'; const b = 1;"),
    "const s = 'it\\'s a // test'; const b = 1;",
  );
  // Template static text is blanked, but interpolation is real code and
  // survives — including a comment-like sequence inside the interpolation.
  assert.equal(
    stripSource('const s = `x${document}y`;', { blankStrings: true }),
    'const s = document};',
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
  const multi = 'a /* import x from\n"./lib/fm.js" */ b // import y\n`c\nd${e}\nf`';
  for (const blankStrings of [false, true]) {
    assert.equal(
      stripSource(multi, { blankStrings }).split('\n').length,
      multi.split('\n').length,
    );
  }
});
