// Tests for src/lib/wav.js — the pure RIFF/WAVE encoder (plan "wav",
// step 1). Tests are exempt from the facade-only import rule (GUIDELINES
// §1.4) and deep-import the module under test; the read-back test uses a
// real engine render at a low rate / short duration per §4.
//
// Conventions under test (documented in src/lib/wav.js):
//   - 44-byte mono RIFF/WAVE header, little-endian throughout;
//   - format code 1 (PCM) for 16/24-bit, 3 (IEEE float) for 32-bit;
//   - saturation, not wrap, outside ±1; non-finite samples throw;
//   - symmetric 16-bit full scale (±1 → ±32767, never −32768);
//   - 32-bit output is bit-exact for Float32Array input;
//   - the default depth is 32-bit IEEE float (no options → lossless master).

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav } from '../src/lib/wav.js';
import { renderPatch } from '../src/lib/engine.js';
import { kickPatch } from '../src/lib/voices/kick.js';

// Read a 4-char RIFF chunk tag out of an encoded file.
const tag = (buf, offset) =>
  String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);

test('16-bit header: every RIFF/WAVE field is laid out correctly', () => {
  const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 8000, {
    bitsPerSample: 16,
  });
  const v = new DataView(buf.buffer);
  assert.equal(tag(buf, 0), 'RIFF');
  assert.equal(v.getUint32(4, true), 44); // file size − 8 = 36 header + 8 data
  assert.equal(tag(buf, 8), 'WAVE');
  assert.equal(tag(buf, 12), 'fmt ');
  assert.equal(v.getUint32(16, true), 16); // fmt chunk size
  assert.equal(v.getUint16(20, true), 1); // audio format: PCM
  assert.equal(v.getUint16(22, true), 1); // channels: mono
  assert.equal(v.getUint32(24, true), 8000); // sample rate
  assert.equal(v.getUint32(28, true), 16000); // byte rate: 8000 × 2
  assert.equal(v.getUint16(32, true), 2); // block align: 16 / 8
  assert.equal(v.getUint16(34, true), 16); // bits per sample
  assert.equal(tag(buf, 36), 'data');
  assert.equal(v.getUint32(40, true), 8); // 4 samples × 2 bytes
  assert.equal(buf.length, 52);
});

test('16-bit samples: exact little-endian codes, symmetric full scale', () => {
  const buf = encodeWav(new Float32Array([0, 1, -1, 0.5, -0.5, 0.25]), 8000, {
    bitsPerSample: 16,
  });
  const v = new DataView(buf.buffer);
  const codes = Array.from({ length: 6 }, (_, i) => v.getInt16(44 + 2 * i, true));
  // −0.5 → −16383 (not −16384): Math.round rounds halves toward +∞, a
  // harmless 1-lsb asymmetry on exactly-half codes — assert it as-is.
  assert.deepEqual(codes, [0, 32767, -32767, 16384, -16383, 8192]);
  // −1 (sample index 2, offset 48) is 0x8001 little-endian — the
  // symmetric −32767, NOT −32768.
  assert.deepEqual([buf[48], buf[49]], [0x01, 0x80]);
  // 0.5 (sample index 3, offset 50) → 16384 = 0x4000 → bytes 00 40.
  assert.deepEqual([buf[50], buf[51]], [0x00, 0x40]);
});

test('24-bit samples: three little-endian bytes, negatives via bit masks', () => {
  const buf = encodeWav(new Float32Array([1, -1, 0.5]), 8000, { bitsPerSample: 24 });
  assert.deepEqual([buf[44], buf[45], buf[46]], [0xff, 0xff, 0x7f]); // +1
  assert.deepEqual([buf[47], buf[48], buf[49]], [0x01, 0x00, 0x80]); // −1
  // 0.5 → round(4194303.5) = 4194304 = 0x00400000 → 00 00 40.
  assert.deepEqual([buf[50], buf[51], buf[52]], [0x00, 0x00, 0x40]);
});

test('32-bit float: bit-exact for Float32Array input, format code 3, block align 4', () => {
  const src = new Float32Array([0.1, -0.2, 1]);
  const buf = encodeWav(src, 8000, { bitsPerSample: 32 });
  const v = new DataView(buf.buffer);
  assert.equal(v.getUint16(20, true), 3); // audio format: IEEE float
  assert.equal(v.getUint16(32, true), 4); // block align: 32 / 8
  assert.equal(v.getUint16(34, true), 32);
  // The data bytes ARE the source float32 bytes (lossless master).
  assert.deepEqual(Array.from(buf.subarray(44)), Array.from(new Uint8Array(src.buffer)));
});

test('no-options encode defaults to 32-bit float: the lossless master', () => {
  const src = new Float32Array([0.1, -0.2, 1, -1, 0.5, -0.5]);
  const buf = encodeWav(src, 8000); // no options — the default depth
  const v = new DataView(buf.buffer);
  assert.equal(v.getUint16(20, true), 3); // audio format: IEEE float
  assert.equal(v.getUint16(32, true), 4); // block align: 32 / 8
  assert.equal(v.getUint16(34, true), 32); // bits per sample
  // The data bytes ARE the source float32 bytes (the lossless-master
  // property of the default encode).
  assert.deepEqual(
    Array.from(buf.subarray(44)),
    Array.from(new Uint8Array(src.buffer)),
  );
});

test('out-of-range samples saturate to full scale in all three formats', () => {
  const over = new Float32Array([2, -2]);
  const b16 = encodeWav(over, 8000, { bitsPerSample: 16 });
  const v16 = new DataView(b16.buffer);
  assert.equal(v16.getInt16(44, true), 32767);
  assert.equal(v16.getInt16(46, true), -32767);
  const b24 = encodeWav(over, 8000, { bitsPerSample: 24 });
  assert.deepEqual([b24[44], b24[45], b24[46]], [0xff, 0xff, 0x7f]);
  assert.deepEqual([b24[47], b24[48], b24[49]], [0x01, 0x00, 0x80]);
  const b32 = encodeWav(over, 8000, { bitsPerSample: 32 });
  const v32 = new DataView(b32.buffer);
  assert.equal(v32.getFloat32(44, true), 1);
  assert.equal(v32.getFloat32(48, true), -1);
});

test('non-finite samples throw, naming the offending index', () => {
  assert.throws(() => encodeWav(new Float32Array([1, NaN, 0]), 8000), /index 1/);
  assert.throws(() => encodeWav(new Float32Array([0, -Infinity]), 8000), /index 1/);
  assert.throws(
    () => encodeWav(new Float32Array([NaN]), 8000, { bitsPerSample: 32 }),
    /index 0/,
  );
});

test('invalid options throw, naming the accepted values', () => {
  const s = new Float32Array([0]);
  for (const bits of [0, 8, 20, 320])
    assert.throws(() => encodeWav(s, 8000, { bitsPerSample: bits }), /16, 24, or 32/);
  for (const rate of [0, -1, 44100.5, NaN])
    assert.throws(() => encodeWav(s, rate), /positive integer/);
});

test('file length: 44 + n × bits/8 for n = 123 (odd)', () => {
  const s = new Float32Array(123);
  assert.equal(encodeWav(s, 8000, { bitsPerSample: 16 }).length, 44 + 246);
  assert.equal(encodeWav(s, 8000, { bitsPerSample: 24 }).length, 44 + 369);
  assert.equal(encodeWav(s, 8000, { bitsPerSample: 32 }).length, 44 + 492);
});

test('empty samples: valid 44-byte header-only file', () => {
  const buf = encodeWav(new Float32Array(0), 8000, { bitsPerSample: 16 });
  const v = new DataView(buf.buffer);
  assert.equal(buf.length, 44);
  assert.equal(v.getUint32(4, true), 36);
  assert.equal(v.getUint32(40, true), 0);
});

test('determinism: the same input encodes byte-identically', () => {
  const s = new Float32Array(500).map((_, i) => Math.sin(i / 7));
  const a = encodeWav(s, 44100, { bitsPerSample: 24 });
  const b = encodeWav(s, 44100, { bitsPerSample: 24 });
  assert.equal(Buffer.compare(a, b), 0);
});

test('header self-consistency: RIFF size and data size agree with the total length', () => {
  const s = new Float32Array(77);
  for (const bits of [16, 24, 32]) {
    const buf = encodeWav(s, 48000, { bitsPerSample: bits });
    const v = new DataView(buf.buffer);
    assert.equal(v.getUint32(4, true), buf.length - 8);
    assert.equal(v.getUint32(40, true), buf.length - 44);
  }
});

test('read-back of a real render: 16-bit within the quantization bound, 32-bit byte-identical', () => {
  const src = renderPatch(kickPatch(), { sampleRate: 8000, duration: 0.25 });
  assert.ok(Math.max(...src) > 0.01); // the render is non-silent
  const K = 64;
  // 16-bit: |decoded − source| ≤ half an lsb (+ float rounding margin).
  const b16 = encodeWav(src, 8000, { bitsPerSample: 16 });
  const v16 = new DataView(b16.buffer);
  for (let i = 0; i < K; i++) {
    const decoded = v16.getInt16(44 + 2 * i, true) / 32767;
    assert.ok(
      Math.abs(decoded - src[i]) <= 0.5 / 32767 + 1e-9,
      `sample ${i}: decoded ${decoded} vs source ${src[i]}`,
    );
  }
  // 32-bit: the first K data bytes are the source float32 bytes themselves.
  const b32 = encodeWav(src, 8000, { bitsPerSample: 32 });
  // (new Uint8Array over the source's buffer region — the raw float32
  // bytes of the first K samples, not a value conversion.)
  assert.deepEqual(
    Array.from(b32.subarray(44, 44 + 4 * K)),
    Array.from(new Uint8Array(src.buffer, 0, 4 * K)),
  );
});
