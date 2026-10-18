// WAV encoder: turns a rendered hit (a Float32Array, the engine's output)
// into complete RIFF/WAVE file bytes (plan "wav", step 1). Pure math — no
// browser globals, no Web Audio — so it runs in any host, including Node
// (GUIDELINES §1.4(a)); the browser-side download glue (Blob, object URL,
// anchor click) lives in src/app/export-wav.js.
//
// Format: standard RIFF/WAVE, mono, 44-byte header, little-endian throughout:
//
//   bytes  0–3   "RIFF"
//   bytes  4–7   file size − 8 (u32)
//   bytes  8–11  "WAVE"
//   bytes 12–15  "fmt "
//   bytes 16–19  16 (fmt chunk size)
//   bytes 20–21  audio format (u16): 1 = PCM (16/24-bit), 3 = IEEE float (32-bit)
//   bytes 22–23  channels (u16): 1 — mono
//   bytes 24–27  sample rate (Hz)
//   bytes 28–31  byte rate = sample rate × block align
//   bytes 32–33  block align (u16) = bits per sample / 8
//   bytes 34–35  bits per sample (u16)
//   bytes 36–39  "data"
//   bytes 40–43  data size = n × bits per sample / 8
//   bytes 44…    sample bytes
//
// Conventions:
//   - `samples` must be finite; a NaN/±Inf sample throws (fail loudly, the
//     same convention as renderPatch's finiteness backstop in engine.js).
//   - Out-of-range samples SATURATE to ±1 rather than wrapping: the engine
//     already backstops with its final hard clamp, but a host-supplied
//     buffer must not wrap into noise.
//   - 16-bit full scale is symmetric: ±1 → ±32767 (never −32768).
//   - The default depth is 32-bit IEEE float (format code 3), bit-exact
//     for Float32Array input — the render IS float32, so a no-options
//     encode is the lossless "master" file; 16/24-bit PCM remain explicit
//     options.
//   - Deterministic: the same input always encodes byte-identically (no
//     hidden state, GUIDELINES §3).
//
// The four 4-char tags are written with DataView.setUint8 per character —
// deliberately no TextEncoder, keeping the pure surface to DataView and
// Uint8Array (available in both browser and Node).

// Write a 4-ASCII-char RIFF chunk tag (e.g. "RIFF", "fmt ").
const writeTag = (view, offset, tag) => {
  for (let i = 0; i < tag.length; i++) view.setUint8(offset + i, tag.charCodeAt(i));
};

// Encode `samples` (a Float32Array of finite numbers, typically the
// renderPatch output) into a mono RIFF/WAVE file. `sampleRate` is the rate
// the samples were rendered at (positive integer Hz). `bitsPerSample` is
// 16 or 24 (integer PCM) or 32 (IEEE float); the default is 32 — the
// bit-exact "master" file of the float32 render (see the Conventions
// block above). Returns the complete file as a Uint8Array — a 44-byte
// header plus the sample bytes.
export const encodeWav = (samples, sampleRate, { bitsPerSample = 32 } = {}) => {
  if (!(samples instanceof Float32Array))
    throw new Error(
      `encodeWav: samples must be a Float32Array (the engine's render), got ${typeof samples}`,
    );
  if (!Number.isInteger(sampleRate) || sampleRate <= 0)
    throw new Error(
      `encodeWav: sampleRate must be a positive integer in Hz, got ${sampleRate}`,
    );
  if (bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32)
    throw new Error(`encodeWav: bitsPerSample must be 16, 24, or 32, got ${bitsPerSample}`);

  const n = samples.length;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = n * bytesPerSample;
  const totalSize = 44 + dataSize;

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  // Header (layout in the module doc above).
  writeTag(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeTag(view, 8, 'WAVE');
  writeTag(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bitsPerSample === 32 ? 3 : 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeTag(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Sample bytes. Clamp to ±1 first (saturation, not wrap — see above); a
  // non-finite value throws instead of encoding as noise.
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (!Number.isFinite(v))
      throw new Error(`encodeWav: sample at index ${i} is not finite (${v})`);
    const s = v > 1 ? 1 : v < -1 ? -1 : v;
    const off = 44 + i * bytesPerSample;
    if (bitsPerSample === 16) {
      // ×32767 keeps full scale symmetric (+1 → 32767, −1 → −32767).
      view.setInt16(off, Math.round(s * 32767), true);
    } else if (bitsPerSample === 24) {
      // Three little-endian bytes from the signed 24-bit code. JS >> is
      // arithmetic, so the & 0xFF masks extract the two's-complement bytes
      // of negatives too (−1 → 01 00 80).
      const code = Math.round(s * 8388607);
      out[off] = code & 0xFF;
      out[off + 1] = (code >> 8) & 0xFF;
      out[off + 2] = (code >> 16) & 0xFF;
    } else {
      // IEEE float: bit-exact for Float32Array input (lossless master).
      view.setFloat32(off, s, true);
    }
  }

  return out;
};
