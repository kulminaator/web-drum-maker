FM synthesizers are surprisingly good at drums because FM excels at creating fast-changing, inharmonic spectra, which is exactly what many percussion sounds are. Most drums are not stable pitched tones like a flute or violin. Instead they contain:

Very short transients (the "click" at the start)
Rapidly changing frequencies
Noise-like components
Multiple resonances ringing at different rates

FM can generate all of these with envelopes applied to modulation amounts.

Basic FM Drum Synthesis

The key trick is that FM drums typically use very short modulation envelopes.

Level envelope: DAHDSR

Every source's level envelope in this project is one canonical shape:
the classic DAHDSR curve — Delay / Attack / Hold / Decay / Sustain /
Release, the six parameters users know from every other drum tool. In
drum terms:

- Delay: a silent lead-in. The layer sits at 0 for `delay` seconds —
  e.g. a snare click a few ms behind the shell hit.
- Attack: the rise from silence to the peak. For one-shots this is
  1–5 ms — the beater's hit.
- Hold: time held at the peak. Usually 0 for drums (a held peak is a
  pad, not a hit).
- Decay: the fall from the peak toward the sustain level — the body of
  the drop.
- Sustain: the level the decay settles at. For one-shot drums it is
  normally 0: a drum hit does not hold a note, it rings out.
- Release: the time the tail takes to reach silence. A one-shot has no
  key release — there is no key-up event — so "release" here is the
  length of the natural tail, not a key-off.

The peak is fixed at 1.0 (classic DAHDSR): the layer's `gain` is the
level knob. The envelope shapes time; the gain shapes level.

Canonical 6-point storage

The form is stored as exactly six points with fixed roles (src/lib/
envelopes.js, src/app/dahdsr.js):

    (0, 0)                                    silent start (fixed)
    (delay, 0)                         [curve: attackCurve]
    (delay + attack, 1)                          the peak
    (delay + attack + hold, 1)         [curve: decayCurve]
    (delay + attack + hold + decay, sustain) [curve: releaseCurve]
    (delay + attack + hold + decay + release, 0)  release end

An inactive parameter is a zero-length span — two points at the same
time — and the engine's zero-length-segment rule (an instant jump to
the later point's value) resolves each one: delay = 0 → two (0, 0)
points (the attack starts at the trigger); hold = 0 → the peak value
holds; decay = 0 → an instant drop to `sustain`; release = 0 → instant
silence at the decay end. The value pattern is always 0 / 0 / 1 / 1 /
s / 0.

Curve bends

A point may carry an optional `curve` scalar k in [0, 1] that
exponentially bends its OUTGOING segment (the segment after it);
absent (or 0) is exactly the plain linear interpolation — the λ → 0
limit, byte-identical to it. With λ = 4k, the blend factor E(f) at
normalized position f in [0, 1] of a segment from a to b is:

    rising  (b.v > a.v):  E(f) = (e^{λf} − 1) / (e^λ − 1)       ease-in
    falling (b.v < a.v):  E(f) = (1 − e^{−λf}) / (1 − e^{−λ})   ease-out
    v = a.v + (b.v − a.v) · E(f)

Rising segments ease in (a slow swell that hugs the start value and
steepens into the end); falling segments ease out (a fast collapse
with a long tail — the classic drum tail). Both families are strictly
monotone (no overshoot, no kinks), and the segment's midpoint value
decreases strictly from the chord midpoint toward the lower end as k
goes 0 → 1 — the bend always sags "down" from the chord, which is what
makes the editor's bend-dot drag well-defined (a vertical drag maps to
the midpoint value, whose inverse is a plain bisection). At k = 1 a
1 → 0 fall sits at ~12 % of the chord at its midpoint — a
strong-but-musical exponential.

The shipped voices use k = 0.55 on the decay segment (KNEE_CURVE,
src/lib/envelopes.js): the closest single-bend exponential to the
project's original 25 %-of-the-peak decay knee — solving
(e^{λ/2} − 1) / (e^λ − 1) = 0.25 gives e^{λ/2} = 3, λ = 2 ln 3 ≈ 2.2,
k = λ/4 ≈ 0.55 (at k = 0.55 the midpoint sits at 0.2497 of the span —
the knee's 0.25 to within 0.03 %).

Why canonical

The six knobs and the constrained full-screen canvas editor are two
views over the SAME six points: there is no separate envelope state
and no mode conversion. The canvas can only ever draw a shape the
knobs can name — every drag re-derives the whole point array from the
six scalars (src/app/env-editor.js), clamped to the knob ranges.
Complexity beyond six scalars — double hits, multi-peaked tails — is
deliberately outside the per-source envelope model: in this project it
comes from layering sources (each component gets its own dedicated
source), the core design.

Kick Drum

A simple kick might be:

Carrier: Sine 50 Hz
Modulator: Sine 200 Hz


At note start:

FM amount = high


Then quickly decay:

FM amount -> 0 in 20 ms


Result:

Initial burst of harmonics = attack
Settles into pure sine = body

Additionally:

Pitch envelope:
100 Hz -> 50 Hz
within 30 ms


This creates the familiar drum thump.

In this implementation (`src/lib/voices/kick.js`), the full recipe is:

- Body: 50 Hz sine carrier, pitch envelope 100 Hz -> 50 Hz in 30 ms;
  200 Hz modulator at index 8 -> 0 in 20 ms; level envelope (DAHDSR):
  attack 5 ms, decay 300 ms, decay curve 0.55 (the exponential collapse
  — the old 25 % knee's closest bend); layer gain 0.8.
- Click: seeded filtered noise burst, ~2 kHz high-pass cutoff, ~20 ms
  exponential decay, gain 0.2 — mixed linearly over the body
  (interaction pattern 1).
- Master: saturation at drive 2 (the "FM -> Saturation" above —
  techno-kick aggression).

Snare Drum

A snare is partly pitched and partly noise.

Using FM:

Operator A = drum body
Operator B = high ratio modulator


Example:

Carrier 180 Hz
Modulator ratio 15:1


Fast FM envelope:

100% -> 0%


produces noisy metallic components.

Then mix another operator:

Carrier 330 Hz


for the drum shell resonance.

The FM sidebands become sufficiently dense that the result starts sounding noise-like.

In this implementation (`src/lib/voices/snare.js`), the full recipe is:

- Body: 180 Hz carrier with a 2700 Hz (15:1) modulator at index ~12 -> 0
  in ~15 ms (the "100 % -> 0 %" collapse); level envelope (DAHDSR):
  attack 3 ms, decay 200 ms, decay curve 0.55; layer gain 0.6.
- Shell: 330 Hz carrier with NO modulator (a pure tone), level envelope
  (DAHDSR): attack 3 ms, decay 150 ms, decay curve 0.55; layer gain
  0.15, run through a 330 Hz resonator at Q 5 — the "FM impulse ->
  Resonator" pattern below (peak gain at the center frequency is
  exactly Q).
- Wires: seeded filtered noise burst, ~1.5 kHz cutoff, ~120 ms decay,
  gain 0.3 — the snare-wire rattle.
- Master: compression, threshold 0.3, ratio 3, makeup 1.2 ("compression
  makes synthetic drums feel more physical").

Tom Tom

A tom is a pitched drum: the kick's single FM body, transposed up into
the mid range. No click, no shell, no master FX — a clean pitched
thump between the kick and the snare.

Carrier: Sine 90 Hz
Modulator: Sine 270 Hz (3:1 ratio)

FM amount -> 0 in 30 ms

Pitch envelope:
140 Hz -> 90 Hz
within 40 ms

In this implementation (`src/lib/voices/tom.js`), the full recipe is:

- Body: 90 Hz sine carrier, pitch envelope 140 Hz -> 90 Hz in 40 ms;
  270 Hz (3:1 ratio) modulator at index 4 -> 0 in 30 ms; level envelope
  (DAHDSR): attack 3 ms, decay 250 ms, decay curve 0.55; layer gain
  0.8. The low index (4, vs the kick's 8) keeps the attack burst
  gentle — the sidebands at 90 ± n·270 Hz (360 / 630 / 900 …) add a
  short "woody" smear before the layer settles into the pure 90 Hz
  tone.
- One layer, no master FX: the resonant bodies of the "FM impulse ->
  Resonator" list below (tom, bongos, steel drums) are approached here
  with the FM body alone; the UI's add-source and FX controls let the
  user build a fuller tom (a noise click, a resonator shell) from this
  starting point.

Clap

A clap is a hand-slap: three fast re-slaps, each a burst of filtered
noise. No pitched body — the "body" IS the noise, high-passed into the
1–4 kHz slap band. The slaps come from 2–3 noise layers with slightly
different seeds and cutoffs whose level envelopes re-peak ~10–30 ms
after the first slap (one layer plus a resonator body would work too,
but the re-peaking gates give the crisp, distinct re-slaps directly).

Slap 1: filtered noise burst at t = 0
Re-slap 2: re-peaks ~16 ms later
Re-slap 3: re-peaks ~29 ms later

In this implementation (`src/lib/voices/clap.js`), the full recipe is:

- Three noise layers, seeds 3/4/5, cutoffs 2.5 / 2.1 / 1.6 kHz (the
  slap band, ~1–4 kHz), layer gains 0.9 / 0.8 / 0.7. The distinct
  seeds keep the bursts from reinforcing/cancelling into one smeared
  transient, and the slightly different cutoffs give each slap its own
  brightness.
- Each burst's raw noise decays with a 30 ms time constant; the level
  envelope gates the actual slap length — in DAHDSR terms: delay (the
  silent lead-in) 0 / 14 / 26 ms, attack 2–3 ms (silent → full), then
  a 6–9 ms decay to a 25 % sustain and a matching release to silence
  (the classic knee shape, which the canonical form represents
  exactly — the knee's midpoint becomes the sustain point — and is
  adopted there on import/load), so a re-slap is not starved by the
  burst's own exponential before its re-peak. The 30 ms constant and
  the 0.9 / 0.8 / 0.7 gains make the re-slaps land quieter than the
  first slap (exp(−16/30) ≈ 0.59, exp(−29/30) ≈ 0.38), as in a real
  hand clap.
- Slap 1: re-peak at 3 ms, gone by 15 ms. Re-slap 2: silent until
  14 ms, re-peak at 16 ms, gone by 31 ms. Re-slap 3: silent until
  26 ms, re-peak at 29 ms, gone by 47 ms — the re-peak times (16 /
  29 ms) are the "re-slap at ~10–30 ms" above, and the whole clap is
  silent again by ~50 ms.
- No master FX: the three differently-seeded bursts are already dense;
  the UI's FX controls can add saturation or a resonator body on top.

Hi-Hats

Classic FM hi-hats are often based on several oscillators using non-harmonic frequency ratios.

Famous example:

Yamaha OPL chips
TR-909 style digital hats

Several square waves:

1.000
1.231
1.342
2.103
3.487
5.119


mixed together create dense beating.

Then:

High-pass filter
Fast decay envelope


The result resembles metallic noise.

In this implementation (`src/lib/voices/hihat.js`), the six oscillators run
at base x {1.000, 1.231, 1.342, 2.103, 3.487, 5.119} with base 4000 Hz
(top partial ~= 20.5 kHz, under the 24 kHz Nyquist at the 48 kHz base
rate; it would alias at the 22.05 kHz export tier — the documented
low-tier trade), mixed linearly, with a one-pole high-pass at ~8 kHz on
the master and a per-layer level envelope (DAHDSR: attack 1 ms, decay
80 ms, decay curve 0.55), staggered across the layers so the partials
release 70-90 ms apart (the highest partial rings longest — the
metallic tail).

Documented approximation: the classic OPL/TR-909 recipe uses SQUARE
waves, but this voice deliberately stays on sine carriers at the same
inharmonic ratios — the recipe is unchanged by choice, not by
limitation (the engine now supports square carriers, see Wave Shape:
anyone who wants the literal recipe can square each partial with one
click on its card). The classic OPL character is approximated as
documented: the dense beating comes from the inharmonic spread, and
the high-pass's rising upper-band gain plays the part the square
waves' odd harmonics play in the classic recipe, so the character —
dense beating -> high-passed metallic noise — is preserved.

FM produces similar effects by using extreme modulation indices and high frequency ratios.

Cymbal

A cymbal is the hi-hat's inharmonic partial family stretched into a
long ring: the stick hit is a dense sideband burst, and the ring is
the partials beating against each other while they fade over
1.5 s or more.

Partial ratios (cymbal modes — inharmonic, like the hi-hat's OPL set):

1.000
1.338
1.782
2.514


In this implementation (`src/lib/voices/cymbal.js`), the full recipe is:

- Four FM layers ("partials") at base 5000 Hz x {1.000, 1.338, 1.782,
  2.514} — 5.0 / 6.69 / 8.91 / 12.57 kHz: the top partial sits in the
  12–15 kHz cymbal band, and all four are under the 24 kHz Nyquist at
  the 48 kHz base rate (the top partial aliases at the 22.05 kHz
  export tier — the documented low-tier trade). The partial count
  stays modest (<= 6 layers — the card-row cap is 8): the inharmonic
  spread, not the count, creates the shimmer.
- Each partial carries one modulator at 1.5 x its carrier with a short
  FM-depth collapse: index 2 -> 0 in 20 ms (the kick recipe's collapse
  shape, gentler). The stick impact is a dense inharmonic sideband
  burst per partial; after the collapse the partial rings as a pure
  sine (Chowning eq. 1). 1.5:1 (not 2:1) keeps every modulator under
  the 22 kHz carrier/modulator range (top: 1.5 x 12.57 kHz = 18.86
  kHz), and its half-integer sidebands (0.5c, 2.5c, 3.5c, ...) keep
  the burst inharmonic — a 2:1 ratio would emit only odd harmonics of
  the carrier.
- Per-partial level envelope (DAHDSR): attack 2 ms, decay 1498 ms to
  sustain 0, decay curve 0.55 — the decay ends exactly at 1.5 s, the
  preset's default hit duration (src/app/presets.js), so the ring runs
  the full hit. The recipe's natural 1.5–2 s cymbal decay is capped by
  that duration.
- Layer gain 0.2 each: four in-phase crests ~= 0.8, headroom before
  the engine's final +/-1 clamp.
- No master FX: the 5–12.6 kHz partials ARE the cymbal's bright band;
  the UI's FX controls can add a high-pass or resonator on top.

Wave Shape

Every operator in the engine can be one of four one-period wave shapes.
For a wrapped phase φ in [0, 2π), the sample math (src/lib/osc.js) is:

sine:      sin(φ)                     range [-1, 1]
square:    +1 for φ < π, else −1      50 % duty (range [-1, 1])
saw:       φ/π − 1                    rising: exactly −1 at 0, climbing
                                       toward +1 at the wrap (range
                                       [-1, 1) — the jump back down at
                                       the wrap is the shape, not a bug)
triangle:  2φ/π − 1 for φ < π,        exactly −1 at 0 and the wrap,
            3 − 2φ/π otherwise        +1 at π, continuous

All four are bounded in [-1, 1]; the engine's final ±1 clamp backstop
and the bounded-output tests rely on that bound invariant.

Carrier vs modulator

Shaping the CARRIER changes the timbre of the settled tone: the
index → 0 recovery holds per shape — a modulator-free carrier is
exactly its one-period shape (the shaped Chowning eq. 1).

Shaping the MODULATOR does something deeper: the modulator's sample IS
the deviation signal. A sine modulator delivers Bessel-weighted sines;
a square modulator instead hard-switches the deviation between +I and
−I every half cycle, so the sideband structure changes — not just the
carrier's timbre. The same holds downstream: a shaped ring modulator
multiplies by the shaped wave, and a shaped cascade driver hands the
shaped wave to the next stage (src/lib/fm.js).

Feedback interaction

The documented progression — small feedback: sine → richer sine, more:
sine → saw-like, high: sine → noise-like — is the SINE operator's
behavior. Feedback on a square or saw operator is a different, more
aggressive texture (the one-sample-old phase self-deviation now happens
inside a non-sinusoidal sample): try it, don't assume.

Aliasing caveat

Square and saw waves carry harmonics to infinity. A 12.5 kHz square at
48 kHz has harmonics above the 24 kHz Nyquist, and that content
aliases back down into the band. The engine deliberately does not
band-limit (philosophy: the user's choice — the output stays bounded),
and the band's spectrum view shows exactly what happens: pick shapes
and frequencies with your ears, not against a hidden safety net. (The
shipped voice recipes stay in the band anyway: hi-hat's top partial is
~20.5 kHz, cymbal's ~12.6 kHz — both below Nyquist, both sines.)

The UI

Every FM card carries a per-carrier shape group (the card's defining
wave) and one shape group per modulator — four glyph buttons (∿ □ ◺ △)
each, with a live one-period preview of the active shape; the rendered
result shows up in the top band through the normal render funnel. Shape
is patch data: it is exported and saved with the patch, and the default
(absent field = sine) keeps every pre-existing patch byte-identical.

Why Multiple Oscillators Help

Real drums are many resonant systems at once:

A snare contains:

Drum skin resonance
Shell resonance
Snare wire rattle
Attack click

One FM pair can generate only one "cluster" of sidebands.

With multiple sources you can dedicate oscillators to each component:

Osc1 = attack click
Osc2 = body resonance
Osc3 = shell resonance
Osc4 = metallic rattle


This is why modern FM synths sound much more realistic than simple 2-operator designs.

FM Algorithms

A major reason Yamaha DX-series synths were effective for percussion is the operator-routing flexibility.

Example:

     Op4
      |
     Op3
      |
     Op2
      |
     Op1


creates a highly complex transient.

Meanwhile:

Op5 --> Out
Op6 --> Out


provide stable resonances.

You get:

Noise-like attack
Tonal sustain

from a single patch.

Combining FM with Other Sources

Modern synthesizers rarely rely on FM alone.

A drum may combine:

FM body
+
Noise generator
+
Wavetable click
+
Sample layer


For example:

Kick
FM sine body
+
Short noise click
+
Saturation

Snare
FM shell
+
Filtered noise burst
+
Resonator

Cymbal
Complex FM network
+
Noise source
+
Comb filter

Effects Matter More Than People Think

Effects often contribute as much as the synthesis.

Distortion

FM already generates lots of sidebands.

After distortion:

FM -> Saturation


more harmonics appear, making the sound more aggressive.

Industrial and techno kicks often use this heavily.

Compression

Compression emphasizes:

Attack
Room tail
Resonances

making synthetic drums feel more physical.

Filters

Even if the source isn't noise, FM can create dense harmonics.

Filtering a dense FM sound:

FM -> Bandpass


can become nearly indistinguishable from filtered noise.

A huge number of "noise" percussion patches are actually filtered FM.

Resonators

Physical-modeling-style resonators are extremely powerful:

FM impulse
   ->
Resonator bank


The resonator imposes drum-like modes:

Tom
Snare
Bongos
Steel drums
Bells

This is common in Eurorack and software synths.

Modern Multi-Operator FM Drums

On synths like:

Elektron Digitone
Kodamo EssenceFM
Opsix
FM8
DX7 derivatives

a typical drum patch might look like:

Operator 1:
Kick body

Operator 2:
Modulates Op1

Operator 3:
Short click

Operator 4:
Noise-like transient

Operator 5:
Metallic resonance

Operator 6:
Sub bass reinforcement


with separate envelopes for:

Level
Pitch
FM depth

on every operator.

The sound evolves over just 50-200 ms, which is exactly what percussion needs.

A useful mental model is that FM drum synthesis is less about creating a steady waveform and more about creating a controlled explosion of harmonics that rapidly collapses over time. By adding multiple operators, layers, noise sources, resonators, and effects, you're effectively constructing the attack, resonances, and decay mechanisms of a physical drum piece by piece.

---
Mixing multiple oscillators, possible?

Absolutely. In fact, that's the entire power of FM and many advanced drum synths.

There are several levels of "oscillators affecting each other":

In this project, patterns 1–7 are not only reachable through the fixed
voice recipes above — the card UI composes them directly: several source
cards mix linearly (1); any FM card carries up to four modulators
(2, 3); the per-modulator target select builds cascades (4); the
per-modulator feedback knob drives self-modulation (5); and the
per-modulator ring toggle switches a modulator into ring mode (7).
Pattern 6 (mutual cross-modulation) is the exception: it is a cyclic
modulator graph, which the engine rejects (src/lib/fm.js).

1. Linear Mixing (No Interaction)

The simplest case:

Osc1 ----\
          +---- Output
Osc2 ----/


They are simply added together.

Example:

Osc1 = kick body
Osc2 = click

No new frequencies are created. You just hear both.

2. FM Modulation

One oscillator changes another oscillator's frequency.

Osc2 ---> Osc1 ---> Output


Mathematically:

Output = sin(
    Fc*t +
    I*sin(Fm*t)
)


Where:

Fc = carrier frequency
Fm = modulator frequency
I = modulation index

This creates entire families of sidebands:

Fc ± nFm


which are frequencies that weren't present before.

For drums this is hugely important because:

50 Hz carrier
x
800 Hz modulator


can instantly create:

850
1650
2450
...


producing attack and metallic character.

3. Multiple Oscillators Modulating One Oscillator

Example:

      Osc2
        |
        v
      Osc1 ---> Output
        ^
        |
      Osc3


Now frequencies interact:

Fc ± Fm1 ± Fm2


The spectrum becomes much richer.

This is common for:

snare attacks
cymbals
metallic percussion

because real metal objects have many interacting resonances.

4. Cascaded FM

Classic DX7 style:

Osc4
 |
 v
Osc3
 |
 v
Osc2
 |
 v
Osc1
 |
Output


This is where things become wild.

Osc4 modulates Osc3.

Osc3's output is already complex.

Then Osc3 modulates Osc2.

Then Osc2 modulates Osc1.

The result is almost an exponential growth of sidebands.

You can produce:

noise bursts
cymbals
crashes
harsh transients

with only a few sine oscillators.

This is one reason a 6-operator DX7 can sound dramatically more complex than a simple 2-operator FM synth.

5. Feedback

One oscillator modulates itself.

      +----+
      |    |
      v    |
Osc1 ------+
   |
 Output


This is extremely useful for drums.

With small feedback:

sine → richer sine


With more feedback:

sine → saw-like


With high feedback:

sine → noise-like


DX7 kick and snare sounds often rely on operator feedback.

6. Cross-Modulation

Sometimes oscillators modulate each other simultaneously.

Osc1 <----> Osc2


This isn't stable FM anymore.

The system becomes nonlinear.

Results include:

chaotic behavior
noisy textures
complex metallic sounds

Many modular synths exploit this.

For percussion it can sound incredibly realistic because real objects are nonlinear too.

7. Ring Modulation

Another useful interaction:

Output = Osc1 × Osc2


Instead of adding frequencies, you get:

Fc + Fm
Fc - Fm


For example:

500 Hz × 700 Hz


produces:

200 Hz
1200 Hz


This is excellent for:

bells
cymbals
cowbells
hi-hats

Many FM synths include ring modulation as another operator mode.

8. Oscillators Affecting Effects

Modern drum synths often route oscillator groups into effects that create new interactions.

Example:

Body FM Oscillators
        \
         +--> Distortion --> Output
        /
Metal FM Oscillators


The distortion doesn't process them independently.

The frequencies intermodulate.

If two oscillators produce:

500 Hz
700 Hz


distortion can generate:

1200 Hz
200 Hz
1400 Hz
1000 Hz
...


This is called intermodulation distortion.

Many aggressive techno kicks rely heavily on this.

9. Why Cymbals Are a Great Example

A real cymbal has hundreds of vibration modes:

Mode A
Mode B
Mode C
Mode D
...


all interacting.

An FM cymbal can mimic this by:

Osc1 modulates Osc2
Osc3 modulates Osc2
Osc4 modulates Osc5
Osc5 modulates Osc1
Feedback on Osc5


Each interaction generates additional sidebands.

The final spectrum can contain thousands of partials from only a handful of oscillators.

Thinking Like a Physical System

The really interesting insight is that an FM drum patch can be treated as a network of coupled resonators:

Stick impact
    |
Attack oscillator
    |
Metal resonator A
    |
Metal resonator B
    |
Metal resonator C


Modern synths like Opsix, FM8, EssenceFM, Phase Plant, Bitwig Polymer/Grid, and modular environments let you build these interaction networks directly.

Once multiple operators start modulating, feeding back, ring-modulating, and then hitting saturation, you're no longer thinking in terms of "waveforms." You're effectively designing a miniature dynamical system whose behavior happens to sound like a drum. That's why sophisticated FM percussion can sound far more organic than you'd expect from "just a bunch of sine waves."
