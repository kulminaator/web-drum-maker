// Oscillator sample math: pure functions, no state (GUIDELINES §3).
//
// Callers keep the phase in radians and advance it once per sample.
// The frequency is a per-call parameter so pitch envelopes (step 3) can
// change it sample-to-sample; the modulo wrap keeps the phase bounded in
// [0, 2π), so trig input stays small and phase accumulation does not
// drift over long renders.
//
// The four wave shapes (sine, square, saw, triangle) are one-period
// functions of a wrapped phase in [0, 2π): each maps a phase to exactly
// one cycle of its waveform, and every shape is bounded in [-1, 1]. The
// engine's final ±1 clamp backstop and the bounded-output tests rely on
// that bound invariant; `shapeSample` dispatches a wrapped phase to the
// requested shape (WAVE_SHAPES is the closed enum of patch data).

const TWO_PI = 2 * Math.PI;

// One sample's worth of rotation at `freq` Hz, wrapped into [0, 2π).
// Requires phase in [0, 2π) and freq >= 0 (drum recipes only use
// non-negative frequencies).
export const phaseAdvance = (phase, freq, sr) =>
  (phase + (TWO_PI * freq) / sr) % TWO_PI;

// Sine sample from a wrapped phase.
export const sineSample = (phase) => Math.sin(phase);

// 50 % duty square: high on the first half of the cycle, low on the
// second — the sign(sin(phase)) equivalent at non-zero crossings.
export const squareSample = (phase) => (phase < Math.PI ? 1 : -1);

// Rising saw over one period: exactly -1 at phase 0, climbing toward +1
// as phase → 2π (range [-1, 1)). The jump back down at the wrap is the
// shape's intrinsic discontinuity, not a bug.
export const sawSample = (phase) => phase / Math.PI - 1;

// Continuous triangle: exactly -1 at phase 0, exactly +1 at π, back to
// -1 as phase → 2π. Continuous at both π and the wrap
// (triSample(0) === -1 === lim phase→2π⁻).
export const triSample = (phase) =>
  phase < Math.PI ? (2 * phase) / Math.PI - 1 : 3 - (2 * phase) / Math.PI;

// The closed wave-shape enum (patch data). squareSample predates this
// enum — the dispatcher below is what finally puts it to work.
export const WAVE_SHAPES = ['sine', 'square', 'saw', 'triangle'];

// Dispatch a wrapped phase to the requested shape. Fails loudly for an
// unknown shape (the engine's requireNumber convention — GUIDELINES
// §2/§3) so a corrupt patch value never becomes silent NaN audio.
export const shapeSample = (shape, phase) => {
  switch (shape) {
    case 'sine':
      return sineSample(phase);
    case 'square':
      return squareSample(phase);
    case 'saw':
      return sawSample(phase);
    case 'triangle':
      return triSample(phase);
    default:
      throw new Error(
        `osc: unknown wave shape "${shape}" (expected sine / square / saw / triangle)`,
      );
  }
};

// One-period sample series of a shape: n values with
// phase_i = i / (n − 1) · 2π — sample 0 at phase 0, sample n − 1 at
// the wrap (2π ≡ 0 of the next cycle). This series is the preview
// canvases' geometry (one period across the preview width,
// src/app/viz.js),
// so it lives here in the library, not in the app: the app may only
// import through the facade (GUIDELINES §1.4(b), §4 — shared DSP
// helpers live in src/lib/, never duplicated in the app).
//
// n = 1 is the degenerate span: the single sample is phase 0 (the
// formula would divide by n − 1 = 0 otherwise).
//
// A non-positive or non-integer n is a caller bug and fails loudly
// (the band.js pitchCurvePoints n-validation precedent); an unknown
// shape throws via shapeSample, naming the value.
export const waveShapePoints = (shape, n) => {
  if (!Number.isInteger(n) || n < 1)
    throw new Error(
      `waveShapePoints: n must be a positive integer, got ${n}`,
    );
  const points = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const phase = n === 1 ? 0 : (i * TWO_PI) / (n - 1);
    points[i] = shapeSample(shape, phase);
  }
  return points;
};
