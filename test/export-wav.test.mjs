// Tests for src/app/export-wav.js — the wavFileName builder, the
// quality-option metadata (EXPORT_RATES / EXPORT_BITS /
// EXPORT_DEFAULTS), the guard that the UI can never offer the library
// an option it rejects, and — since P8/S20 — the render+download
// behavior of exportDrum / exportSource, captured headlessly through
// the downloadText stub below (the Blob/anchor glue is the module's
// one I/O boundary; the capture records what it would hand the
// browser: the anchor's file name and the Blob's bytes + mime).
//
// Deep-importing src/app/ and src/lib/wav.js is allowed for tests
// (GUIDELINES §1.4: tests are exempt from the facade-only rule); the
// render side of the export is asserted against the FACADE's own
// renderPatch / isolateLayer / encodeWav (the same public API the
// app uses, test/facade.test.mjs's precedent).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXPORT_BITS,
  EXPORT_DEFAULTS,
  EXPORT_RATES,
  downloadText,
  downloadWav,
  exportDrum,
  exportSource,
  sourceSuffix,
  wavFileName,
} from '../src/app/export-wav.js';
import { encodeWav } from '../src/lib/wav.js';
import { isolateLayer, kickPatch, renderPatch } from '../src/lib/index.js';

// ---- the download capture (the I/O boundary, stubbed) ----------------
//
// Node has no DOM: captureDownloads installs the globals downloadText
// touches — the Blob constructor, URL.createObjectURL /
// revokeObjectURL, a minimal document whose createElement('a')
// returns an anchor that records { fileName, blob } when clicked, and
// a SYNCHRONOUS setTimeout (the revoke is deferred one macrotask in
// the browser; here it is collected and flushed before the restore,
// so the assertion is deterministic and the real Node URL is never
// handed the fake 'blob:captured' URL) — runs fn (the export call),
// restores everything, and returns what was "downloaded". The
// captured Blob's parts[0] is the exact payload (the encoded WAV
// bytes, or the JSON text) — byte-identical comparison against a
// directly-built encodeWav(...).
const captureDownloads = (fn) => {
  const downloads = [];
  const revoked = [];
  const pendingTimers = [];
  class CapturedBlob {
    constructor(parts, options = {}) {
      this.parts = parts;
      this.type = options.type;
    }
  }
  let lastBlob = null;
  const prevBlob = globalThis.Blob;
  const prevDocument = globalThis.document;
  const prevCreate = globalThis.URL.createObjectURL;
  const prevRevoke = globalThis.URL.revokeObjectURL;
  const prevSetTimeout = globalThis.setTimeout;
  globalThis.Blob = CapturedBlob;
  globalThis.URL.createObjectURL = (blob) => {
    lastBlob = blob;
    return 'blob:captured';
  };
  globalThis.URL.revokeObjectURL = (url) => { revoked.push(url); };
  globalThis.setTimeout = (callback) => { pendingTimers.push(callback); return 0; };
  globalThis.document = {
    body: { append: () => {} },
    createElement: (tag) => ({
      tag,
      href: '',
      download: '',
      click() { downloads.push({ fileName: this.download, blob: lastBlob }); },
      remove: () => {},
    }),
  };
  try {
    fn();
    for (const callback of pendingTimers) callback(); // the deferred revokes
  } finally {
    globalThis.Blob = prevBlob;
    globalThis.URL.createObjectURL = prevCreate;
    globalThis.URL.revokeObjectURL = prevRevoke;
    globalThis.setTimeout = prevSetTimeout;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
  return { downloads, revoked };
};

// A 2-source drum fixture (the kick: an FM body + a noise click, the
// master saturator in its chain): the isolation of one source differs
// from the mix, so exportSource's "not the mix" assert has teeth.
// 8 kHz / 0.1 s — the repo's cheap test rate (the kick's 2 kHz noise
// cutoff is well under the 4 kHz Nyquist), GUIDELINES §4.
const KICK = { name: 'kick', duration: 0.1, patch: kickPatch() };
const KICK_RATE = 8000;
const KICK_BITS = 16;
// The direct reference encodings (built through the facade, exactly
// as the plan specifies: encodeWav(renderPatch(isolateLayer(...)))).
const kickIso = (i, rate = KICK_RATE, bits = KICK_BITS) => encodeWav(
  renderPatch(isolateLayer(KICK.patch, i), { sampleRate: rate, duration: KICK.duration }),
  rate,
  { bitsPerSample: bits },
);
const kickMix = (rate = KICK_RATE, bits = KICK_BITS) => encodeWav(
  renderPatch(KICK.patch, { sampleRate: rate, duration: KICK.duration }),
  rate,
  { bitsPerSample: bits },
);

// 4-sample 8 kHz probe — cheap enough to encode once per option
// (GUIDELINES §4: low rate, short duration).
const PROBE = new Float32Array([0, 0.5, -0.5, 1]);

// The offered grid, as literals (independent of the metadata tables —
// test 2 checks the tables against these).
const RATES = [22050, 44100, 48000];
const BITS = [16, 24, 32];

test('wavFileName: all 9 rate × bit combinations for kick', () => {
  const expected = [
    'kick-22050hz-16bit.wav',
    'kick-22050hz-24bit.wav',
    'kick-22050hz-32bit.wav',
    'kick-44100hz-16bit.wav',
    'kick-44100hz-24bit.wav',
    'kick-44100hz-32bit.wav',
    'kick-48000hz-16bit.wav',
    'kick-48000hz-24bit.wav',
    'kick-48000hz-32bit.wav',
  ];
  const actual = [];
  for (const rate of RATES)
    for (const bits of BITS)
      actual.push(wavFileName('kick', rate, bits));
  assert.deepEqual(actual, expected);
});

test('wavFileName: the drum name is the file-name prefix', () => {
  assert.equal(wavFileName('hihat', 44100, 16), 'hihat-44100hz-16bit.wav');
});

test('option metadata: { value, label } entries with unique values', () => {
  for (const [name, opts] of [
    ['EXPORT_RATES', EXPORT_RATES],
    ['EXPORT_BITS', EXPORT_BITS],
  ]) {
    assert.ok(opts.length > 0, `${name} must offer at least one option`);
    const seen = new Set();
    for (const entry of opts) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['label', 'value'],
        `${name} entries are exactly { value, label }`,
      );
      assert.equal(typeof entry.value, 'number');
      assert.equal(typeof entry.label, 'string');
      assert.ok(entry.label.length > 0, `${name} labels are non-empty`);
      assert.ok(!seen.has(entry.value), `${name} values are unique`);
      seen.add(entry.value);
    }
  }
  for (const { value } of EXPORT_RATES)
    assert.ok(
      Number.isInteger(value) && value > 0,
      `rates are positive integers, got ${value}`,
    );
  assert.deepEqual(
    EXPORT_BITS.map((b) => b.value).sort((a, b) => a - b),
    BITS,
    'bits values are exactly the set { 16, 24, 32 }',
  );
});

test('defaults are offered options', () => {
  assert.ok(
    EXPORT_RATES.some((r) => r.value === EXPORT_DEFAULTS.sampleRate),
    `EXPORT_DEFAULTS.sampleRate (${EXPORT_DEFAULTS.sampleRate}) is one of `
      + 'EXPORT_RATES',
  );
  assert.ok(
    EXPORT_BITS.some((b) => b.value === EXPORT_DEFAULTS.bitsPerSample),
    `EXPORT_DEFAULTS.bitsPerSample (${EXPORT_DEFAULTS.bitsPerSample}) is `
      + 'one of EXPORT_BITS',
  );
});

// ---- the download pattern (P8/S20): downloadText + downloadWav -------

test('downloadText: Blob with the mime type, anchor with the file name, URL revoked', () => {
  const { downloads, revoked } = captureDownloads(() => {
    downloadText('kick.json', '{"name":"kick"}', 'application/json');
  });
  assert.equal(downloads.length, 1, 'one anchor click');
  assert.equal(downloads[0].fileName, 'kick.json');
  assert.equal(downloads[0].blob.type, 'application/json');
  assert.deepEqual(downloads[0].blob.parts, ['{"name":"kick"}']);
  assert.deepEqual(revoked, ['blob:captured'], 'the object URL is revoked after the click');
});

test('downloadWav: byte-identical through the downloadText factor (P8/S20 kept the WAV half unchanged)', () => {
  const bytes = encodeWav(PROBE, 8000, { bitsPerSample: 16 });
  const { downloads } = captureDownloads(() => {
    downloadWav('probe-8000hz-16bit.wav', bytes);
  });
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].fileName, 'probe-8000hz-16bit.wav');
  assert.equal(downloads[0].blob.type, 'audio/wav', 'the WAV mime type');
  assert.deepEqual(downloads[0].blob.parts[0], bytes, 'the exact encoded bytes, unchanged');
});

// ---- per-source export (P8/S20) --------------------------------------

test('sourceSuffix: the identity label\'s number ("Source 2" -> "src2"); no number throws descriptively', () => {
  assert.equal(sourceSuffix('Source 2'), 'src2');
  assert.equal(sourceSuffix('Source 10'), 'src10', 'multi-digit ids');
  assert.throws(() => sourceSuffix('Source X'), /no number/);
  assert.throws(() => sourceSuffix(''), /no number/);
  assert.throws(() => sourceSuffix(undefined), /no number/);
  // The stable-naming property the suffix exists for: removing the
  // first source, the survivor keeps its number (not a positional
  // renumbering to "src1").
  assert.equal(sourceSuffix('Source 3'), 'src3');
});

test('wavFileName: the src-suffix scheme (identity, not index)', () => {
  assert.equal(wavFileName('kick-src2', 44100, 16), 'kick-src2-44100hz-16bit.wav');
  assert.equal(wavFileName('kick-src10', 48000, 32), 'kick-src10-48000hz-32bit.wav');
  // The mix name is unchanged (no suffix).
  assert.equal(wavFileName('kick', 44100, 16), 'kick-44100hz-16bit.wav');
});

test('exportSource: renders through isolateLayer — equals the isolated encoding, differs from the mix', () => {
  // The kick\'s SECOND source (the noise click) under the card\'s
  // "Source 2" identity.
  const { downloads } = captureDownloads(() => {
    exportSource(KICK, 1, {
      sampleRate: KICK_RATE,
      bitsPerSample: KICK_BITS,
      label: 'Source 2',
    });
  });
  assert.equal(downloads.length, 1, 'one download');
  assert.equal(downloads[0].fileName, 'kick-src2-8000hz-16bit.wav', 'the stable-identity file name');
  assert.equal(downloads[0].blob.type, 'audio/wav');
  // The bytes ARE the isolated layer\'s encoding (the plan\'s direct
  // reference: encodeWav(renderPatch(isolateLayer(...)))).
  assert.deepEqual(downloads[0].blob.parts[0], kickIso(1));
  // ... and DIFFER from the mix export (a 2-source drum: the mix
  // carries the FM body + the master saturator, the isolation neither
  // — so byte-equality with the mix would be the bug).
  assert.notDeepEqual(downloads[0].blob.parts[0], kickMix());
});

test('exportSource: the first source, at another quality, with a multi-digit label', () => {
  const { downloads } = captureDownloads(() => {
    exportSource(KICK, 0, {
      sampleRate: 48000,
      bitsPerSample: 24,
      label: 'Source 12',
    });
  });
  assert.equal(downloads[0].fileName, 'kick-src12-48000hz-24bit.wav');
  assert.deepEqual(downloads[0].blob.parts[0], kickIso(0, 48000, 24));
  assert.notDeepEqual(downloads[0].blob.parts[0], kickMix(48000, 24));
});

test('exportSource: a missing label throws (the file name is the identity, not an index)', () => {
  assert.throws(
    () => captureDownloads(() => exportSource(KICK, 0, { sampleRate: KICK_RATE, bitsPerSample: KICK_BITS })),
    /no number/,
  );
});

test('exportDrum: the MIX at the chosen quality (unchanged row behavior)', () => {
  const { downloads } = captureDownloads(() => {
    exportDrum(KICK, { sampleRate: KICK_RATE, bitsPerSample: 24 });
  });
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].fileName, 'kick-8000hz-24bit.wav', 'the mix file name (no src suffix)');
  assert.equal(downloads[0].blob.type, 'audio/wav');
  assert.deepEqual(downloads[0].blob.parts[0], kickMix(KICK_RATE, 24), 'the full mix, encoded');
  // Sanity: the mix is NOT either isolated source (2 sources + master fx).
  assert.notDeepEqual(downloads[0].blob.parts[0], kickIso(0, KICK_RATE, 24));
  assert.notDeepEqual(downloads[0].blob.parts[0], kickIso(1, KICK_RATE, 24));
});

test('UI can\'t offer what the library rejects (encoder drift guard)', () => {
  // Every listed bit depth is accepted by encodeWav on the probe.
  for (const { value: bits } of EXPORT_BITS) {
    const wav = encodeWav(PROBE, 8000, { bitsPerSample: bits });
    assert.equal(
      wav.length,
      44 + PROBE.length * (bits / 8),
      `encodeWav accepts ${bits}-bit and emits the right size`,
    );
  }
  // Every listed rate is encoded as that rate (header field, u32 LE at
  // offset 24).
  for (const { value: rate } of EXPORT_RATES) {
    const wav = encodeWav(PROBE, rate, { bitsPerSample: 16 });
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    assert.equal(
      view.getUint32(24, true),
      rate,
      `encodeWav encodes the listed rate ${rate} into the header`,
    );
  }
});
