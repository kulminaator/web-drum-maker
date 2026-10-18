// Effects: sample-level stages that shape rendered hits (GUIDELINES §3:
// pure functions, no module state, inputs never mutated).
// drum_generation.md "Effects Matter More Than People Think": distortion
// and filtering contribute as much as the synthesis — FM → Saturation
// adds harmonics and aggression (techno kicks), the high-pass removes
// the low end from noise layers and hi-hats, the resonator imposes
// drum-like modes on a transient (FM impulse → resonator bank), and
// the compressor makes synthetic drums feel more physical.

// Normalized tanh soft-clip:
//
//   y[n] = tanh(drive · x[n]) / tanh(drive)
//
// The /tanh(drive) factor maps full scale to full scale (x = 1 → y = 1
// for any drive): peaks of a full-scale signal bend into the soft clip
// instead of being cut off, and the output is structurally within ±1
// for any |input| ≤ 1 (|tanh| < 1). Small signals pass through with
// gain drive/tanh(drive) (≈ drive for drive ≥ 2) — the waveshaper
// "drives" the signal, which is the aggression of the FM → Saturation
// chain in drum_generation.md. tanh is odd, so a sine comes out with
// odd harmonics only. Precondition: drive > 0 (drive = 0 degenerates
// to 0/0).
export const saturate = (buffer, drive) => {
  const norm = Math.tanh(drive);
  const y = new Float32Array(buffer.length);
  for (let n = 0; n < buffer.length; n++) {
    y[n] = Math.tanh(drive * buffer[n]) / norm;
  }
  return y;
};

// One-pole high-pass — the same topology and coefficient formula as
// filteredNoiseBurst in src/lib/noise.js, kept consistent on purpose:
//
//   y[n] = (1 − a/2)·(x[n] − x[n−1]) − (1 − a)·y[n−1]
//   a = 1 − exp(−2π·cutoff/sr)
//
// The zero at z = 1 kills DC (a constant input decays to 0 like
// (−(1−a))ⁿ); the pole at z = −(1−a) gives ≈ 6 dB/oct roll-off below
// the cutoff and ≈ unity gain at 10× the cutoff (0.997 for cutoff
// 200 Hz at sr 8 kHz). The gain rises toward Nyquist — steady-state
// Nyquist gain (2−a)/a, ≈ 12.8 for those parameters — the same
// upper-band boost that motivated the peak normalization in
// filteredNoiseBurst, so a broadband ±1 input can exceed ±1; layer
// gains and the engine's final clamp (step 9) keep the full chain
// bounded. (The original plan draft wrote
// y[n] = y[n−1] + a·(x[n] − x[n−1]); that transfer function reduces to
// the pure gain a — see src/lib/noise.js for the full discussion.)
// Precondition: 0 < cutoff < sr/2.
export const highpass = (buffer, cutoff, sr) => {
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
  const y = new Float32Array(buffer.length);
  let yPrev = 0;
  let xPrev = 0;
  for (let n = 0; n < buffer.length; n++) {
    y[n] = (1 - a / 2) * (buffer[n] - xPrev) - (1 - a) * yPrev;
    yPrev = y[n];
    xPrev = buffer[n];
  }
  return y;
};

// 2-pole resonant biquad — the "FM impulse → resonator bank" stage from
// drum_generation.md ("Resonators"): feed a short excitation (FM burst
// or click) into a resonator and it imposes drum-like modes — it rings
// at its own frequency with its own decay, turning any transient into a
// tom / snare-shell / bell-like mode.
//
// Coefficient source: the RBJ audio EQ cookbook low-pass biquad (Comp
// Music 1137 biquad notes, music.columbia.edu) — the standard 2-pole
// resonator with both zeros at z = −1 (Nyquist):
//
//   ω0 = 2π·freq/sr,  α = sin(ω0) / (2Q)
//   b0 = (1 − cos ω0) / 2,  b1 = 1 − cos ω0,  b2 = (1 − cos ω0) / 2
//   a0 = 1 + α,             a1 = −2 cos ω0,   a2 = 1 − α
//
// Normalized coefficients: every coefficient is divided by a0 = 1 + α.
// Substituting a1 = −2 cos ω0 (negative) into the cookbook recurrence
// y[n] = (b0x[n] + b1x[n−1] + b2x[n−2] − a1·y[n−1] − a2·y[n−2]) / a0
// gives the form implemented below, where the two stored feedback
// gains are both positive:
//
//   y[n] = b0·x[n] + b1·x[n−1] + b2·x[n−2] + f1·y[n−1] − f2·y[n−2]
//   f1 = 2 cos ω0 / a0,   f2 = (1 − α) / a0
//
// Why this topology: it is the resonator form with bounded gain at all
// frequencies. The zero-less 2-pole (y = x − a1·y[n−1] − a2·y[n−2]) has
// DC gain 1 / (2(1 − cos ω0) − α) ≈ 1/ω0² → ∞ for narrow ω0, so any
// low component in the excitation would blow up; the zeros at z = −1
// instead pin the Nyquist gain to 0. The peak gain at the center
// frequency is exactly Q: at z = e^jω0 the numerator collapses to
// sin²(ω0) and the denominator to 2α·sin(ω0), so |H(e^jω0)| = sin(ω0)
// / (2α) = Q. That is what makes Q read as the "ring amount" of the
// drum mode (Q 10 → 10 × a full-scale resonant input).
//
// Stability bounds: the poles sit at z ≈ √((1−α)/(1+α))·e^(±jω0), i.e.
// radius r ≈ 1 − α, strictly inside the unit circle for every
// 0 < ω0 < π and Q > 0 — the biquad is stable for all legal inputs, and
// the ring decay time constant is 1/(1−r) ≈ 2Q/sin(ω0) samples
// (200 Hz, Q 10, sr 8 kHz → ≈ 128 samples ≈ 16 ms — drum-like). Q is
// clamped to ≥ 0.5 because below Q ≈ 0.707 (the Butterworth point) the
// response has no gain peak at all — the "resonator" would silently
// degrade into a plain low-pass, useless for imposing drum modes.
// Precondition: 0 < freq < sr/2.
export const resonate = (buffer, freq, q, sr) => {
  const Q = Math.max(q, 0.5); // clamp — see stability note above
  const w0 = (2 * Math.PI * freq) / sr;
  const alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  const b0 = (1 - Math.cos(w0)) / (2 * a0);
  const b1 = 2 * b0; // = (1 − cos ω0) / a0
  const b2 = b0;
  const f1 = (2 * Math.cos(w0)) / a0; // −a1/a0, a1 = −2 cos ω0 < 0
  const f2 = (1 - alpha) / a0; // a2/a0
  const y = new Float32Array(buffer.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // zero initial state (starts at rest)
  for (let n = 0; n < buffer.length; n++) {
    const x0 = buffer[n];
    const out = b0 * x0 + b1 * x1 + b2 * x2 + f1 * y1 - f2 * y2;
    y[n] = out;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = out;
  }
  return y;
};

// Simple causal compressor — the "Compression" stage from
// drum_generation.md: "compression emphasizes attack, room tail,
// resonances, making synthetic drums feel more physical".
//
// Stage 1 — envelope follower on |x| with linear (ramp) smoothing: the
// envelope moves toward |x[n]| at a constant rate, rising 1/attack per
// sample and falling 1/release per sample (attack and release are in
// SAMPLES; the engine converts seconds at the patch sample rate when it
// builds the options). A step at the input is fully tracked in exactly
// `attack` samples (rising) or `release` samples (falling) — no
// exponentials, no per-sample exp(), and the envelope can never
// overshoot |x| (so env ≤ max|x|).
//
// Stage 2 — per-sample gain law, applied to the dry sample:
//
//   G = 1 − (env − threshold)·(1 − 1/ratio),   env > threshold
//   G = 1,                                      otherwise
//
// the standard hard-knee law: unity gain below the threshold, and above
// it the output level follows the input with an asymptotic slope of
// 1/ratio (the linear-gain form of that slope — exact at env =
// threshold, slightly more aggressive as env grows). G is clamped to ≥
// 0 (with env ≤ max|x| this only bites for extreme threshold/ratio
// combinations — a negative G would invert the signal), so G ≤ 1 always
// and the total gain G·makeup is clamped to ≤ makeup: with makeup = 1
// and |x| ≤ 1 the output stays within ±1; with makeup > 1 the engine's
// final clamp (step 9) keeps the full chain bounded.
// Fully causal: y[n] uses x[n] and env[n], which use x[n] and env[n−1].
// Precondition: 0 < threshold ≤ 1, ratio ≥ 1, attack ≥ 0, release ≥ 0,
// makeup ≥ 0.
export const compress = (buffer, { threshold, ratio, attack, release, makeup }) => {
  if (!(threshold > 0 && threshold <= 1)) {
    throw new Error(`compress: threshold must be in (0, 1], got ${threshold}`);
  }
  if (!(ratio >= 1)) {
    throw new Error(`compress: ratio must be ≥ 1, got ${ratio}`);
  }
  if (!(attack >= 0) || !(release >= 0) || !(makeup >= 0)) {
    throw new Error(`compress: attack/release/makeup must be ≥ 0, got ${attack}/${release}/${makeup}`);
  }
  const upStep = attack > 0 ? 1 / attack : Infinity; // 0 = instantaneous
  const downStep = release > 0 ? 1 / release : Infinity;
  const slope = 1 - 1 / ratio; // 0 at ratio = 1 (bypass), → 1 as ratio → ∞
  const y = new Float32Array(buffer.length);
  let env = 0; // starts at rest (causal)
  for (let n = 0; n < buffer.length; n++) {
    const x = buffer[n];
    const target = Math.abs(x);
    if (target > env) env += Math.min(upStep, target - env);
    else env -= Math.min(downStep, env - target);
    let g = 1;
    if (env > threshold) {
      g = 1 - (env - threshold) * slope;
      if (g < 0) g = 0;
    }
    y[n] = x * g * makeup;
  }
  return y;
};
