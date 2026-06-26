# sphere

A bunch of shaded spheres in random colours, each wiped onto the screen by a
sweeping line, accumulating over black until the screen fills and refreshes.

## Source

Ported from `xscreensaver-6.15/hacks/sphere.c` (303 lines). Original algorithm
by **Tom Duff** at Lucasfilm, 1982; made a standalone XScreenSaver hack by
**Jamie Zawinski**, 1997 (xlock port David Bagley, 1993; Copyright 1988 Sun
Microsystems). Config from `hacks/config/sphere.xml`. The hack was removed from
the XScreenSaver distribution as of version 5.08; the source is preserved here.

## Algorithm

The C keeps one `spherestruct` and draws **one sphere at a time**, painting it
column-by-column (or row-by-row): a vertical/horizontal line sweeps across the
disk one pixel per `draw_sphere` call. For each pixel of the current line it
draws a dot with probability proportional to the Lambert term `N.L` of the
surface normal against a fixed light vector `(NX,NY,NZ) = (48,-36,80)`, length
`NR = 100` — a random-threshold halftone (`NRAND(radius*NR) <= NX*sx*x +
NY*sy*y + NZ*sqrt(r^2-x^2-y^2)`). A per-session sign flip `shadowx/shadowy`
(rolled once in `init_sphere`) chooses the light's left/right and up/down sense.
When the sweep reaches the far edge of the disk the struct is re-rolled (new
radius `1..min(w,h)/2`, new centre anywhere on screen, new axis/direction, new
colour) and the next ball begins. Balls accumulate on the black background;
overlaps overwrite (each column is blacked out, then re-stippled).

This port preserves: one ball at a time, the **sweeping reveal**, the fixed
single light direction with a per-session sign flip, the highlight pointing
up-and-to-the-right by default (screen y is down, so `NY = -36` is "up"),
accumulation over black, random radius/centre/colour per ball, and a periodic
full-screen wipe so the layout refreshes.

## Rendering / deviations from the C

- **Stipple halftone -> offset radial gradient.** Canvas has no cheap
  per-pixel random-threshold stipple, so (as the porter brief directs) each
  sphere is a single `createRadialGradient` whose inner hotspot sits at
  `centre + (NX*sx, NY*sy)/NR * radius` (the same highlight point the C's `N.L`
  peaks at, offset 0.6r toward the light) and whose outer circle is the sphere
  itself, fading to a near-black rim. Reads as a lit, round ball rather than a
  flat disk. The dithered/grainy texture of the original is lost; the shape,
  lighting direction, and roundness are kept.
- **Sweeping reveal kept, cheaply.** Instead of one stippled scanline per step,
  each step clips the gradient fill to a thin strip of the circle (a `rect`
  clip intersected with the `arc` path) and fills only that strip. So you still
  watch each ball wipe into existence, but the work per step is one clipped
  arc-fill (vector, sparse, cheap) instead of a per-pixel loop.
- **Radius range narrowed for looks.** The C picks `radius = 1..min(w,h)/2`,
  which includes 1-px "spheres" (single dots). This port uses
  `(0.05..0.35) * min(w,h)` so every ball is visibly round, several fit on
  screen at once, and sizes still vary. Centres are still chosen anywhere
  (`nrand(W/H)`), so balls are frequently clipped at the screen edges, as in
  the original.
- **Periodic wipe.** The C never clears after init (balls pile up forever). To
  "refresh the layout" per the brief, this port banks each finished ball's area
  and wipes to black once cumulative coverage passes ~1.8 screens, then carries
  on. No erase transition (instant clear) — see [[squiral]] for the same idiom.
- **No XOR / feedback** tricks are used by sphere, so none are emulated.
- **Dropped dead knobs.** `sphere.xml` exposes only `--delay` and `--ncolors`;
  the C `DEFAULTS` line also sets `cycles`/`size` but `sphere.c` never reads
  them, so they are omitted. `ncolors <= 2` renders grey (white-to-black)
  spheres, matching the C's `MI_NPIXELS(mi) > 2 ? colour : white`.
- **devicePixelRatio / pace.** All geometry is in device px; sweep speed scales
  with radius (`max(2*S, r/40)`) so a ball reveals in ~1-2 s at any resolution.
  Default `delay` is the stock 20000 µs.

## Correctness self-review

- **Termination / no stall.** `step()` always advances the sweep edge `p`
  toward `pEnd` by `speed >= 2*S > 0`, clamped with `min`/`max` (no exact
  float-equality test). When `p` reaches `pEnd` (within 1e-6) `finishSphere()`
  fires, which always calls `newSphere()`. A degenerate off-screen or
  zero-width chord just finishes on the next step rather than looping. A
  headless harness (mock canvas) ran 40,000 frames: 460 spheres created (~72
  steps each, ~1.45 s/ball), 33,402 reveal strips, 21 wipes — continuous
  progress, no exceptions, the rAF loop re-scheduled every frame.
- **Reset completeness.** `newSphere()` re-seeds everything the next state
  reads (centre, radius, axis, direction, gradient, `p`, `pEnd`, speed); the
  light flip is intentionally session-fixed (set once in `init`), matching
  `init_sphere`.
- **First frame.** `init()` pre-fills 3 complete spheres before starting the
  animated one, so frame 1 is already populated (no near-empty start), then the
  sweep continues.
- **pause/resume/reinit.** Standard squiral/scooter contract: `pause` clears
  `rafId`, `resume` resets `lastTime` to avoid a catch-up burst, `reinit`
  rebuilds the palette and re-seeds. `MAX_CATCHUP_STEPS = 8` caps work after a
  backgrounded tab.
- **Numeric range.** No attractor/divergence; all values are bounded by `W/H`
  and `r`, no `>>` or fixed-point overflow risk.

See [[scooter]] (closest twin: vector, sparse, periodic reposition) and
[[squiral]] (canonical skeleton).
