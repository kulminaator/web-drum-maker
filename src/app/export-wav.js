// WAV export (binding layer, src/app/): renders the LIVE finetuned
// patch at the chosen quality (sample rate × bit depth) through the
// library facade, encodes the hit into RIFF/WAVE bytes via encodeWav,
// and downloads them with a Blob + object URL — the one clearly-named I/O
// boundary for export (GUIDELINES §3: side effects only at clearly named
// I/O boundaries; §1.4(b): src/app/ is the only tier that may touch the
// DOM). Two flavors (new-ui.md §7: "WAV export of the mix and of
// individual sources"): exportDrum — the drum's MIX (all its sources
// together, the top bar's WAV-Export button) — and exportSource — ONE
// source, rendered through the facade's isolateLayer (each card's
// per-source [⤓] button), the file name carrying the card's STABLE
// identity ("kick-src2-…" — the label, not the layer index: the naming
// survives the renumbering a positional name would not,
// new-ui.md §2.7).
//
// The quality-option metadata (EXPORT_RATES / EXPORT_BITS /
// EXPORT_DEFAULTS) lives here because it is UI metadata: which rates and
// bit depths the UI offers, with their labels, is a presentation choice,
// not audio math (GUIDELINES §1.4(e) — no UI metadata in library modules).
//
// Testability split: wavFileName, the option tables, and the
// render+encode half of exportDrum / exportSource are unit-tested in
// test/export-wav.test.mjs — the download glue (downloadText) is
// captured there through a Blob/anchor stub (the I/O boundary, tested
// headlessly); the encoder itself is test/wav.test.mjs's ground,
// and the facade workflow test (test/facade.test.mjs) covers the
// headless render → encode path.

import { renderPatch, isolateLayer, encodeWav } from '../lib/index.js';

// Sample rates the UI offers. 48000 matches PREVIEW_RATE in main.js
// (what the user hears in the preview); 44100 is the CD rate; 22050 is
// the cheaper tier — the hi-hat's top partial (~20.5 kHz) aliases under
// its 11.025 kHz Nyquist, which is the documented trade of the low tier.
// All three rates keep the hi-hat's 8 kHz master high-pass below
// Nyquist, so no offered rate is rejected by renderPatch.
export const EXPORT_RATES = [
  { value: 22050, label: '22.05 kHz' },
  { value: 44100, label: '44.1 kHz' },
  { value: 48000, label: '48 kHz' },
];

// Bit depths the UI offers. 32-bit float is bit-exact of the Float32Array
// render (no quantization); 16-bit is the most compatible.
export const EXPORT_BITS = [
  { value: 16, label: '16-bit PCM' },
  { value: 24, label: '24-bit PCM' },
  { value: 32, label: '32-bit float' },
];

// Defaults for the export row: the app's base quality — 48 kHz (what
// the user hears, = PREVIEW_RATE) at 32-bit float, the bit-exact
// lossless master of the render.
export const EXPORT_DEFAULTS = { sampleRate: 48000, bitsPerSample: 32 };

// Deterministic, self-describing file name, e.g. kick-48000hz-32bit.wav.
// (The per-source export passes an identity-suffixed name —
// wavFileName('kick-src2', …) = 'kick-src2-48000hz-32bit.wav'.)
export const wavFileName = (drumName, sampleRate, bitsPerSample) =>
  `${drumName}-${sampleRate}hz-${bitsPerSample}bit.wav`;

// The per-source export's file-name suffix, from the card's STABLE
// identity label (the registry's "Source N", passed in by the card —
// the card never numbers itself, new-ui.md §2.7): the label's numeric
// part, e.g. "Source 2" -> "src2". The identity, NOT the layer index:
// removing the first source keeps the survivor's "src3" name.
// Throws descriptively for a label without a number — there is no
// sound positional fallback (that is exactly the drift this naming
// exists to avoid).
export const sourceSuffix = (label) => {
  const match = /(\d+)\s*$/.exec(String(label ?? ''));
  if (!match)
    throw new Error(
      `export-wav: source identity label ${JSON.stringify(label)} has no number ` +
        "— the per-source file name is the card's stable identity, not the layer index",
    );
  return `src${match[1]}`;
};

// The download pattern, factored so it lives ONCE (P8/S20): Blob →
// object URL → anchor click. setTimeout defers the revoke past the
// click so the download is not cancelled while it is starting. The
// only DOM-touching export (allowed: §1.4(b)); the text (or bytes)
// and the mime type are the caller's — downloadWav is the WAV half.
export const downloadText = (fileName, text, mime) => {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

// The WAV half of the download: the encoded bytes, mime audio/wav.
export const downloadWav = (fileName, bytes) =>
  downloadText(fileName, bytes, 'audio/wav');

// Export one drum: render its LIVE patch at the chosen quality through
// the facade, encode the hit, and download the WAV bytes. `drum` is plain
// data { name, patch, duration } — main.js passes the entry from its
// app.drums map; no import of main.js → no coupling, no cycle. duration
// is the drum's playback duration (0.5/0.5/0.3 s, the preset registry
// in src/app/presets.js)
// — the export is exactly the hit the user hears; a longer-tail option is
// deliberately out of scope (roadmap).
export const exportDrum = (drum, { sampleRate, bitsPerSample }) => {
  const samples = renderPatch(drum.patch, { sampleRate, duration: drum.duration });
  downloadWav(
    wavFileName(drum.name, sampleRate, bitsPerSample),
    encodeWav(samples, sampleRate, { bitsPerSample }),
  );
};

// Export ONE source (new-ui.md §7): the layer in ISOLATION — the
// facade's isolateLayer (that layer alone, no other sources, no master
// chain) rendered at the chosen quality — so the file is exactly the
// source as it is, the audition's (the strip ▶'s) rendering. `label`
// is the card's stable identity ("Source N"), named in the file
// (sourceSuffix — identity, not index). Same shape of plain data and
// same I/O boundary as exportDrum.
export const exportSource = (
  drum,
  layerIndex,
  { sampleRate, bitsPerSample, label },
) => {
  const samples = renderPatch(
    isolateLayer(drum.patch, layerIndex),
    { sampleRate, duration: drum.duration },
  );
  downloadWav(
    wavFileName(`${drum.name}-${sourceSuffix(label)}`, sampleRate, bitsPerSample),
    encodeWav(samples, sampleRate, { bitsPerSample }),
  );
};
