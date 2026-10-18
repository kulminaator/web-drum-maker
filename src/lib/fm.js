// FM routing: one carrier plus at most four modulators, rendered
// sample-by-sample into a Float32Array (GUIDELINES §3: pure entry function,
// all phase state function-local, no module-level mutability).
//
// Implements the operator interaction patterns 2–5 and 7 from
// drum_generation.md:
//   2. FM             — a modulator drives the carrier's phase deviation
//   3. multiple mods  — several modulators on one carrier (deviations sum)
//   4. cascade        — a modulator drives another modulator (`modulates`)
//   5. feedback       — a modulator drives itself (`feedback`, β)
//   7. ring mod       — a modulator multiplies the carrier (`ring`)
// (Pattern 6, mutual cross-modulation, is a cyclic graph and is not
// supported — the cycle check below rejects it.)
//
// Discretization (sample-then-advance, matching the osc.js convention and
// Chowning's continuous model e(t) = sin(ωc·t + I·sin(ωm·t)) for the
// default sine operators):
//   1. modulator i's output at the current phase
//      w_i = the operator's wave shape sampled at (φ_i + d_i)
//      (shape_i, default 'sine'),
//      where
//        d_i = β_i·w_i[n−1]                 (feedback: one sample old — the
//                                            current sample would be implicit
//                                            since w_i depends on d_i, and a
//                                            one-sample delay is what
//                                            DX7-style operator chips do)
//            + Σ_{j: j drives i} I_j·w_j    (cascades: current sample — the
//                                            driver was computed earlier in
//                                            topological order)
//   2. carrier deviation = Σ_{j: j drives the carrier} I_j·w_j
//   3. out[n] = the carrier's wave shape sampled at (φ_c + deviation)
//      (default 'sine') · Π_{i: ring} w_i
//   4. advance the carrier and every modulator phase via phaseAdvance
//
// A modulator with `ring: true` contributes *instead of* a phase
// deviation: it multiplies the carrier output (pattern 7: sin·sin =
// ½[cos(ωc−ωm) − cos(ωc+ωm)] — sum and difference tones only). A ring
// modulator can still be driven by cascades, so its factor w_i carries
// their deviation. The same holds with wave shapes: a shaped ring
// modulator multiplies by the shaped wave, and feedback on a shaped
// operator is still a phase self-deviation of one sample old — now
// applied inside the shaped operator.
//
// Envelope hooks: `carrier.freqAt(t)` and each modulator's `indexAt(t)`
// (t in seconds) are optional functions; when absent the constant `freq` /
// `index` is used. The engine (step 9) builds them from src/lib/envelopes.js
// points, which keeps this module envelope-agnostic.

import { phaseAdvance, shapeSample } from './osc.js';

// The POC keeps the graph tiny (plan step 5): 1 carrier + ≤ 4 modulators.
const MAX_MODULATORS = 4;

// Topological order: every cascade driver before the modulator it drives,
// so a driver's current-sample output is available when its target is
// computed. Kahn's algorithm over ≤ 4 nodes; a node that never becomes
// ready means a cycle — cross-modulation (pattern 6) — which the POC does
// not support.
const computeOrder = (modulators) => {
  const order = [];
  const scheduled = new Array(modulators.length).fill(false);
  while (order.length < modulators.length) {
    const ready = modulators.findIndex(
      (m, i) =>
        !scheduled[i] &&
        modulators.every((o, j) => o.modulates !== i || scheduled[j]),
    );
    if (ready === -1)
      throw new Error(
        'renderFmLayer: cyclic modulator graph (cross-modulation) is not supported',
      );
    scheduled[ready] = true;
    order.push(ready);
  }
  return order;
};

// Render one FM layer into a fresh Float32Array of `length` samples.
//
// layer = {
//   carrier:    { freq, freqAt?, shape? },      // Hz; freqAt(t) overrides;
//                                                // shape: wave shape of the
//                                                // operator's sample (osc.js
//                                                // shapeSample), default 'sine'
//   modulators: [{ freq, index, indexAt?,
//                  feedback = 0, ring = false, modulates?, shape? }],
// }
// `modulates` is the index of the modulator whose phase deviation this
// modulator's output drives (cascade, pattern 4); the driver's own
// `index`/`indexAt` scales the link, the same way it scales the carrier
// link. Without `modulates` the modulator drives the carrier.
export const renderFmLayer = (layer, length, sr) => {
  const modulators = layer.modulators ?? [];
  if (modulators.length > MAX_MODULATORS)
    throw new Error(
      `renderFmLayer: at most ${MAX_MODULATORS} modulators, got ${modulators.length}`,
    );
  for (const [j, m] of modulators.entries()) {
    if (
      m.modulates !== undefined &&
      (m.modulates < 0 || m.modulates >= modulators.length)
    )
      throw new Error(
        `renderFmLayer: modulator ${j} "modulates" index ${m.modulates} out of range`,
      );
  }
  const order = computeOrder(modulators);

  // Envelope hooks (see header): fall back to the constant values.
  const freqAt = layer.carrier.freqAt ?? (() => layer.carrier.freq);
  const indexAt = modulators.map((m) => m.indexAt ?? (() => m.index));

  const out = new Float32Array(length);
  const phases = new Array(modulators.length).fill(0);
  const wavePrev = new Array(modulators.length).fill(0); // w_i[n−1] (feedback)
  const wave = new Array(modulators.length).fill(0);     // w_i[n]
  let carrierPhase = 0;

  for (let n = 0; n < length; n++) {
    const t = n / sr;

    // Modulators at the current phase, in dependency order: a cascade
    // driver's current output is computed before the modulator it drives.
    for (const i of order) {
      const m = modulators[i];
      let deviation = (m.feedback ?? 0) * wavePrev[i];
      for (const j of order) {
        if (modulators[j].modulates === i)
          deviation += indexAt[j](t) * wave[j];
      }
      wave[i] = shapeSample(m.shape ?? 'sine', phases[i] + deviation);
    }

    // Carrier: sum the deviations of the modulators that drive it
    // (a modulator with a `modulates` target drives that modulator
    // instead; a `ring` modulator multiplies instead — by its shaped
    // wave), then apply the ring products (pattern 7). With every index
    // 0 the deviation is 0 and the output is the plain shaped carrier
    // (default sine) — Chowning eq. 1.
    let deviation = 0;
    for (const i of order) {
      if (modulators[i].modulates === undefined && !modulators[i].ring)
        deviation += indexAt[i](t) * wave[i];
    }
    let sample = shapeSample(layer.carrier.shape ?? 'sine', carrierPhase + deviation);
    for (const i of order) {
      if (modulators[i].ring) sample *= wave[i];
    }
    out[n] = sample;

    // Sample-then-advance (the osc.js convention, so index → 0 is
    // sample-identical to a plain shaped carrier): rotate every phase
    // for the next sample, and latch the outputs as the feedback source
    // — a phase self-deviation of one sample old, now applied inside the
    // shaped operator.
    carrierPhase = phaseAdvance(carrierPhase, freqAt(t), sr);
    for (let i = 0; i < modulators.length; i++) {
      phases[i] = phaseAdvance(phases[i], modulators[i].freq, sr);
      wavePrev[i] = wave[i];
    }
  }
  return out;
};
