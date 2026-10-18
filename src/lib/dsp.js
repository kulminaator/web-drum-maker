// Shared single-bin DFT helper, used by both the app (src/app/viz.js's
// spectrum view) and the test suite (spectral peak checks in the noise,
// FM, effects, and voice tests). The browser code and the tests share
// this one implementation (no duplicated DSP); both reach it through
// the facade src/lib/index.js.

// Magnitude of the single-bin DFT of `buf` at `freq` Hz:
//
//   |X(f)| = |Σ x[n] · e^(−2πi·f·n/sr)|
//
// computed with the Goertzel algorithm: a second-order IIR resonator
// tuned to f that needs only two real multiplies per sample (no complex
// arithmetic). It works for fractional bin frequencies, which the
// spectrum canvas needs — its bins need not land on integer DFT bins.
export const goertzelMag = (buf, freq, sr) => {
  const N = buf.length;
  // w = 2π·f·N/sr is the (possibly fractional) bin angle.
  const w = (2 * Math.PI * freq * N) / sr;
  const c = 2 * Math.cos(w / N);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let n = 0; n < N; n++) {
    s0 = buf[n] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  // |X|² = s0² + s2² − 2·s0·s2·cos(w/N) = s0² + s2² − c·s0·s2;
  // max(0, ·) guards against tiny negative rounding at near-zero mags.
  return Math.sqrt(Math.max(0, s0 * s0 + s2 * s2 - c * s0 * s2));
};
