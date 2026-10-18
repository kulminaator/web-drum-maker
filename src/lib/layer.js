// Linear layer mixing (interaction pattern 1 in drum_generation.md): the
// one place where multiple rendered sources are combined. Mixing is plain
// elementwise addition with a per-layer gain — no interaction between
// layers — so every layer (FM body, noise click, shell, ...) contributes
// independently and stays unit-testable (GUIDELINES §3: pure functions,
// no module state).
//
// The engine (step 9) renders each layer into its own Float32Array,
// applies the layer's level envelope and effect chain, then calls
// mixLayers once over all layers. Gains live here so that normalized
// sources (e.g. peak-normalized noise bursts from noise.js) land at the
// right loudness in the mix.

// Elementwise gain-sum of buffers: out[n] = Σᵢ gains[i] · buffers[i][n].
//
// All buffers must share one length: a mismatch is a programming error
// that would silently misalign the sources, so it throws with the
// offending lengths instead of truncating or zero-padding. gains must
// have one entry per buffer for the same reason.
export const mixLayers = (buffers, gains) => {
  if (gains.length !== buffers.length) {
    throw new Error(
      `mixLayers: expected ${buffers.length} gains (one per buffer), got ${gains.length}`,
    );
  }
  const length = buffers.length ? buffers[0].length : 0;
  for (let i = 0; i < buffers.length; i += 1) {
    if (buffers[i].length !== length) {
      throw new Error(
        `mixLayers: buffer ${i} has length ${buffers[i].length}, ` +
          `expected ${length} — all layers must share one sample count`,
      );
    }
  }
  const out = new Float32Array(length);
  for (let i = 0; i < buffers.length; i += 1) {
    const g = gains[i];
    if (g === 0) continue; // muted layer: skip the multiplies (and any NaN it carries)
    const buf = buffers[i];
    for (let n = 0; n < length; n += 1) out[n] += g * buf[n];
  }
  return out;
};

// Scaled copy of `buffer`: out[n] = gain · buffer[n]. Returns a fresh
// Float32Array and never mutates the input, so the same rendered layer
// can be re-gained repeatedly (e.g. while the UI A/Bs a layer level)
// without side effects.
export const applyGain = (buffer, gain) => {
  const out = new Float32Array(buffer.length);
  for (let n = 0; n < buffer.length; n += 1) out[n] = gain * buffer[n];
  return out;
};
