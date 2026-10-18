// Facade headless-usage contract test (plan "cleaning", step 15).
//
// This file plays the role of a hypothetical UI-less consumer of the audio
// library: its ONLY project import is the facade (../src/lib/index.js) —
// the same closed door the binding walks through — and through that door
// alone it drives a complete workflow: render all three voices, change a
// parameter, re-shape an envelope point array through setPath, analyze
// the spectrum, isolate a layer, and encode a rendered hit to WAV file
// bytes. If a
// UI-less host can do all of that with the
// documented export list, the library is genuinely self-contained: the
// separation (plan steps 3–14) is not just structural. Step 16's
// app-boundary test will enforce this file's import rule mechanically.
//
// Test parameters per GUIDELINES §4: low rate, short duration, property
// assertions on the buffers. Kick and snare render at 8 kHz / 0.5 s
// (4000 samples). The hi-hat uses the rate adaptation already established
// in test/hihat.test.mjs: 16 kHz / 0.25 s (also 4000 samples), because
// the recipe's 8 kHz master high-pass sits at the 8 kHz sample rate's
// Nyquist (4 kHz) and renderPatch rejects cutoffs ≥ sr/2 — at that rate
// the 4 kHz base partial would also alias to a DC-zero tone. The
// test-rate cutoff
// (4000 Hz, the base partial) keeps the recipe's "high-pass at/above the
// lowest partial" character.
//
// The decay check uses proportional windows — the first 10 % of the
// duration vs the last 30 % — which are exactly the [0, 0.05) s and
// [0.35, 0.5) s windows at the 0.5 s renders, so one assertion covers
// both rates.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as facade from '../src/lib/index.js';

const {
  renderPatch,
  isolateLayer,
  kickPatch,
  snarePatch,
  hihatPatch,
  getPath,
  setPath,
  goertzelMag,
  encodeWav,
} = facade;

// The documented closed export set (plan step 8; src/lib/index.js header).
// Drift in EITHER direction — a missing or an extra export — fails the
// deep-equal below.
const EXPECTED_EXPORTS = [
  // engine
  'renderPatch',
  'isolateLayer',
  // voices
  'kickPatch',
  'snarePatch',
  'hihatPatch',
  'tomPatch',
  'clapPatch',
  'cymbalPatch',
  // params
  'getPath',
  'setPath',
  'clamp',
  // envelopes
  'levelEnvelope',
  'pitchEnvelope',
  'fmDepthEnvelope',
  'envelopeValue',
  // dsp
  'goertzelMag',
  // osc
  'waveShapePoints',
  // wav
  'encodeWav',
];

// ── render specs (see header for the hi-hat rate adaptation) ──────────

const KICK_SNARE = { sampleRate: 8000, duration: 0.5 };
const HIHAT = { sampleRate: 16000, duration: 0.25 };
// Every render in this file yields exactly this many samples.
const LENGTH = 4000;

const VOICES = [
  ['kick', kickPatch, KICK_SNARE],
  ['snare', snarePatch, KICK_SNARE],
  // Test-rate high-pass: 4000 Hz = the base partial (hihat.test.mjs).
  ['hihat', () => hihatPatch({ highpass: 4000 }), HIHAT],
];

// ── small buffer-property helpers (house style, test-local) ───────────

const maxAbs = (buf) => {
  let m = 0;
  for (let n = 0; n < buf.length; n++)
    m = Math.max(m, Math.abs(buf[n]));
  return m;
};

const rms = (buf) => {
  let s = 0;
  for (let n = 0; n < buf.length; n++) s += buf[n] * buf[n];
  return Math.sqrt(s / buf.length);
};

// buf slice over the [t0, t1) second window.
const windowSlice = (buf, t0, t1, sampleRate) =>
  buf.slice(Math.round(t0 * sampleRate), Math.round(t1 * sampleRate));

const maxAbsDiff = (a, b) => {
  let m = 0;
  for (let n = 0; n < a.length; n++)
    m = Math.max(m, Math.abs(a[n] - b[n]));
  return m;
};

// Byte-identical buffer comparison (the engine's determinism contract).
const byteIdentical = (a, b) =>
  a.length === b.length &&
  Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer)) === 0;

// ── tests ─────────────────────────────────────────────────────────────

test('export list: exactly the documented closed set, nothing else', () => {
  assert.deepEqual(
    [...Object.keys(facade)].sort(),
    [...EXPECTED_EXPORTS].sort(),
    'facade exports must deep-equal the documented set (plan step 8)',
  );
  for (const name of EXPECTED_EXPORTS)
    assert.equal(typeof facade[name], 'function', `${name} must be a function`);
});

for (const [name, build, opts] of VOICES) {
  test(`render ${name}: ${LENGTH} samples, non-silent, finite, bounded ±1, decaying`, () => {
    const buf = renderPatch(build(), opts);
    assert.ok(buf instanceof Float32Array, 'renderPatch returns a Float32Array');
    assert.equal(buf.length, LENGTH, 'length');
    const peak = maxAbs(buf);
    assert.ok(peak > 0.01, `max |s| = ${peak} (expected > 0.01)`);
    for (let n = 0; n < buf.length; n++) {
      assert.ok(Number.isFinite(buf[n]), `sample ${n} = ${buf[n]} is not finite`);
      assert.ok(Math.abs(buf[n]) <= 1, `sample ${n} = ${buf[n]} outside ±1`);
    }
    // Decay: RMS of the late window (last 30 % of the duration) < RMS of
    // the attack window (first 10 %) — [0.35, 0.5) s vs [0, 0.05) s at
    // the 0.5 s renders.
    const { sampleRate, duration } = opts;
    const attack = rms(windowSlice(buf, 0, 0.1 * duration, sampleRate));
    const late = rms(windowSlice(buf, 0.7 * duration, duration, sampleRate));
    assert.ok(
      attack > 1e-6,
      `attack-window RMS ${attack} is silent — bad test`,
    );
    assert.ok(
      late < attack,
      `late-window RMS ${late} not < attack-window RMS ${attack} — no decay`,
    );
  });
}

test('parameter plumbing: setPath("masterEffects.0.drive") changes the render, getPath round-trips', () => {
  const original = renderPatch(kickPatch(), KICK_SNARE);
  // A fresh kickPatch() IS the copy: every call builds fresh arrays
  // (src/lib/voices/kick.js), so editing it cannot touch `original`'s patch.
  const patch = kickPatch();
  const written = 4; // the recipe default is drive 2
  setPath(patch, 'masterEffects.0.drive', written);
  assert.equal(
    getPath(patch, 'masterEffects.0.drive'),
    written,
    'getPath round-trips the value setPath just wrote',
  );
  const changed = renderPatch(patch, KICK_SNARE);
  const d = maxAbsDiff(original, changed);
  assert.ok(d > 1e-3, `max |diff| = ${d} (expected > 1e-3 — parameter had no effect)`);
});

test('envelope point editing through setPath: a new array changes the render; restoring is byte-identical', () => {
  const patch = kickPatch();
  const original = renderPatch(patch, KICK_SNARE);
  const env = getPath(patch, 'layers.0.levelEnv');
  assert.ok(Array.isArray(env) && env.length >= 2, 'levelEnv must be a point array');

  // The free-form point helpers (insertPoint / removePoint / pointAt /
  // clampPointT) left the API with the constrained DAHDSR editor (plan
  // "dahdsr" P5): a UI-less host edits an envelope by building a NEW
  // sorted point array and writing it with setPath — the same live-patch
  // contract the UI walks (the engine accepts any sorted array; the
  // canonical forms are what the app tier builds and normalizes to).
  const custom = [
    { t: 0, v: 0 },
    { t: 0.1, v: 0.5 },
    { t: 0.5, v: 0 },
  ];
  setPath(patch, 'layers.0.levelEnv', custom);
  const edited = renderPatch(patch, KICK_SNARE);
  const d = maxAbsDiff(original, edited);
  assert.ok(d > 1e-3, `max |diff| after the edit = ${d} (expected > 1e-3 — the new shape had no effect)`);

  // Round-trip: writing the original array back restores it, and the
  // engine's determinism contract makes the re-render byte-identical to
  // the first one.
  setPath(patch, 'layers.0.levelEnv', env);
  assert.deepEqual(
    getPath(patch, 'layers.0.levelEnv'),
    env,
    'the original point array is restored',
  );
  const restored = renderPatch(patch, KICK_SNARE);
  assert.ok(
    byteIdentical(restored, original),
    're-render after the restore must be byte-identical to the original',
  );
});

test('spectral analysis: kick body energy in 40–80 Hz exceeds energy near 400 Hz', () => {
  // The kick body is a 50 Hz carrier (100 → 50 Hz drop — the
  // drum_generation.md kick recipe); the 200 Hz modulator places
  // sidebands at
  // 50 ± n·200 Hz (150 / 350 / 450 / …), so 400 Hz sits in a
  // Bessel-weight valley between the 350 and 450 Hz sidebands. Over the
  // full 0.5 s buffer the coherent 50 Hz tone stays strong while the
  // ~20 ms click is a small, incoherent contribution at every frequency.
  const buf = renderPatch(kickPatch(), KICK_SNARE);
  // Σ |X(f)|² (Goertzel magnitudes squared) over the [lo, hi] Hz band.
  const bandEnergy = (lo, hi, step) => {
    let e = 0;
    for (let f = lo; f <= hi; f += step) {
      const m = goertzelMag(buf, f, KICK_SNARE.sampleRate);
      e += m * m;
    }
    return e;
  };
  const body = bandEnergy(40, 80, 5);
  const valley = bandEnergy(390, 410, 5);
  assert.ok(body > 0, `40–80 Hz energy ${body} is zero — bad test`);
  assert.ok(
    body > valley,
    `40–80 Hz energy ${body} not > near-400 Hz energy ${valley} — the 50 Hz body is missing`,
  );
});

test('isolateLayer: solo renders are finite and bounded ±1; the body layer is non-silent', () => {
  const patch = kickPatch();
  const full = renderPatch(patch, KICK_SNARE);
  assert.ok(maxAbs(full) > 0.01, 'full patch must be non-silent (precondition)');
  for (let i = 0; i < patch.layers.length; i++) {
    const solo = renderPatch(isolateLayer(patch, i), KICK_SNARE);
    assert.ok(
      solo instanceof Float32Array && solo.length === LENGTH,
      `solo[${i}] must be a ${LENGTH}-sample Float32Array`,
    );
    for (let n = 0; n < solo.length; n++) {
      assert.ok(Number.isFinite(solo[n]), `solo[${i}] sample ${n} is not finite`);
      assert.ok(
        Math.abs(solo[n]) <= 1,
        `solo[${i}] sample ${n} = ${solo[n]} outside ±1`,
      );
    }
  }
  // Layer 0 is the FM body — the thump of the full patch — so its solo
  // render must be non-silent. (isolateLayer drops masterEffects by
  // design: the solo view is the layer before the master chain.)
  const body = renderPatch(isolateLayer(patch, 0), KICK_SNARE);
  assert.ok(
    maxAbs(body) > 0.01,
    `body solo max |s| = ${maxAbs(body)} (expected > 0.01)`,
  );
});

test('headless export: render kick at 8 kHz → encodeWav 16-bit → a complete WAV file', () => {
  // The UI-less consumer's export path (plan "wav", step 2): render a hit
  // and turn it into RIFF/WAVE file bytes through the facade alone — no
  // browser, no src/app/ (whose download glue stays on the binding side).
  const samples = renderPatch(kickPatch(), KICK_SNARE); // 8 kHz, 4000 samples
  // Explicit 16-bit — the no-options default is now 32-bit float (the
  // lossless master of the float32 render).
  const wav = encodeWav(samples, KICK_SNARE.sampleRate, { bitsPerSample: 16 });
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (off) =>
    String.fromCharCode(
      view.getUint8(off),
      view.getUint8(off + 1),
      view.getUint8(off + 2),
      view.getUint8(off + 3),
    );
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(12), 'fmt ');
  assert.equal(view.getUint16(20, true), 1, 'audio format 1 (PCM)');
  assert.equal(view.getUint32(24, true), 8000, 'sample rate 8000');
  assert.equal(tag(36), 'data');
  assert.equal(view.getUint32(40, true), 2 * LENGTH, 'data size = 2 × 4000');
  assert.equal(
    wav.length,
    44 + 2 * LENGTH,
    'total length = 44-byte header + 2 bytes × 4000 samples',
  );
});
