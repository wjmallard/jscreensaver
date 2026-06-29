# xrayswarm

Worm-like swarms of particles chasing wandering targets, each leaving a short
"vapor trail" that fades from bright (head) to dark (tail). Port of
xscreensaver's `xrayswarm.c`.

## Source

- `xscreensaver-6.15/hacks/xrayswarm.c` (Chris Leger, 2000; a ripoff of SGI's
  "swarm" screensaver). 1234 lines.
- Config: `xscreensaver-6.15/hacks/config/xrayswarm.xml` (only param: `delay`,
  default 20000; plus a `showfps` toggle).
- See [[whirlwindwarp]] and [[galaxy]] (swarming particles with fading trails).
  Skeleton follows [[squiral]].

## The algorithm

Two species live in realspace `[0,maxx) x [0,maxy)` where `maxx = 1` and
`maxy = H/W`; positions map to pixels by `px = pos * W` (so both axes use `W` and
stay square).

- **Targets** (the C's `targets[]`, auto 2..10): each step picks a random
  acceleration direction, integrates with a speed clamp to `targetVel`, and
  bounces off the walls. They drift slowly.
- **Bugs** (the C's `bugs[]`, auto 25..100): each chases its *currently closest*
  target, accelerating toward it (`atan2` with a little directional `noise`),
  clamped between `minVel` and `maxVel`, then bounces. Five bugs per step
  re-evaluate which target is closest, with a `theta < temp*2` hysteresis that
  makes them fickle, so the swarm keeps churning and overshooting rather than
  collapsing onto a point.

Every bug and target stores its recent pixel positions in a ring buffer
(`hist[]`) with a single shared `head`/`tail`. Each frame the trail is drawn as a
chain of line segments connecting consecutive `hist` points; segment colour is
taken from a per-position table that fades **bright at the head to dark at the
tail** (the C builds 16-level gray/red/blue ramps in `computeColorIndices`).

Periodically (`changeProb`) the C mutates physics params (`randomSmallChange`),
converts bugs<->targets, changes the colour scheme, or reseeds the whole swarm /
re-rolls the trail length (`randomBigChange`). All of this is ported.

## Rendering approach

SPARSE vector drawing. The C redraws **all** trail segments every frame (drawing
the same lines idempotently, with colours shifting one step toward the tail as
the swarm ages), so the port simply **clears to black and redraws all segments
each frame**. Segments are batched into one `Path2D` per colour-map index and
stroked once per index, so there are `<= ncolors` (about 16) strokes per frame
rather than one per segment. Line width is 1px, or 3px on Retina (`W`/`H` >
2560), matching the C; `hist` coords are already device-px so no extra dpr
multiply is needed.

The `head`/`tail` ring-buffer bookkeeping (advance `head`, drop oldest when full)
lives in `step()` rather than the draw routine, so `head`/`tail` stay in lockstep
even when the rAF lag-accumulator runs several `step()`s between one `draw()`.
This keeps the trail length fixed (memory/draw cost is constant).

## Deviations from the C

- **Config mirrors the .xml (only `delay`).** `xrayswarm.xml` exposes a single
  user resource, `delay` ("Frame rate", 0..100000, default 20000, inverted),
  plus a debug `--fps` toggle we omit. Earlier port revisions added
  `count`/`targets`/`trail`/`scheme`/`changeProb` sliders; those have been
  **removed** as invented controls the original never had. The C auto-manages all
  of them and the port now does too: counts and trail length are auto-randomized
  in `initBugs` (the C's `-1` sentinels), `colorScheme` starts at `COLOR_TRAILS`
  (the C's `xrayswarm_init` default of 2) and auto-cycles via `randomSmallChange`
  case 9, and the mutation rate is the C's hardcoded `changeProb = 0.08`.
- **GXxor / XOR / additive:** none. This hack draws with `GXcopy` only (no
  `GXxor`, no additive blend); the "x-ray" look comes purely from the fade colour
  ramp (bright head -> dark tail) on black, redrawn each frame. The port strokes
  opaque (`source-over`) on a cleared canvas, matching `GXcopy`. **No** additive
  / `globalCompositeOperation='lighter'` accumulation is used or wanted.
- **No anti-aliasing in the C.** The C disables AA on every GC
  (`jwxyz_XSetAntiAliasing False`); canvas 2D has no way to disable line AA, so
  the port's thin trail lines are slightly softer than the original's hard pixels.
  Cosmetic; class B (platform).
- **`closest` is an index, not a pointer.** The C stores `bug->closest` as a
  `bug*` into `targets[]` and the bug<->target `mutateBug` shuffles structs with
  `memcpy` and pointer comparisons. The port stores an integer index and
  translates the pointer comparisons to index comparisons (the moved last-target
  becomes index `i`; bugs that pointed at the converted target are re-randomized)
  to give identical behaviour.
- **FPS level-of-detail dropped.** The C uses `gettimeofday` to auto-tune `delay`
  and, when slow, drop trail length / bug count to hold a frame-rate band
  (`MAX_FPS`/`MIN_FPS`). The browser uses the standard rAF lag-accumulator with
  the `delay` **Frame rate** slider instead, so that adaptive-detail logic and the
  `--fps` / `showfps` overlay are omitted. (Most of that branch is `if (0)`
  dead code in the C anyway; only the trail-length reduction is live, and the
  browser never needs it.)
- **`dt` consistency.** With `delay > 0` the C runs at `dt = DESIRED_DT/2 = 0.1`
  but only recomputes `halfDtSq`/`dtInv` from it on the next parameter mutation,
  so there's a brief startup transient where those derived constants lag `dt`.
  The port uses `dt = 0.1` and computes the derived constants consistently from
  the first frame (i.e. the C's steady state). The affected term
  (`acc * halfDtSq`) is a tiny second-order position correction.
- **Pacing.** The C does two `dt=0.1` sub-steps per drawn frame (`draw_cnt=2`
  when `delay>0`); the port does one `step()` per `config.delay` via a
  lag-accumulator. The default `delay` is the **stock 20000 us** (the slider maps
  1:1 to the xml resource); the loop adds a fixed `OVERHEAD = 9940 us` so
  `(delay + OVERHEAD)` reproduces the live binary's *effective* step rate, not the
  nominal one. Measured against the live `-fps` overlay xrayswarm runs **33.4
  fps**, while the port at the stock delay ran ~50 steps/s (1.5× fast);
  `20000 + 9940 = 29940 us → 33.4 steps/s`, matching the binary. A calibration,
  not a tuning knob — see the framerate-calibration note.
- **Colour scheme: auto-cycles (faithful).** The C starts at `COLOR_TRAILS`
  (default scheme 2) and changes scheme only via `randomSmallChange` case 9; the
  port does exactly this, with **no** scheme selector (an earlier revision added
  one — removed, see the config note above). Colours are emitted as `rgb()`
  strings built byte-for-byte from the C's `initCMap` (gray/red/blue ramps plus
  the chained pseudo-random ramp) — a hardcoded table, **not** a `make_*_colormap`
  rainbow, so there is no muted-vs-vivid palette deviation to fix.
- **Trail reseed on spawn/relocate (DELIBERATE deviation — the port is LESS
  faithful here).** A `seedHist(entity)` helper fills an entity's whole history
  ring with its current position, called in `initBugs()` for every entity and
  right after the position reset in `mutateBug(0)`. The C's `mutateBug(0)`
  `memcpy`s a whole bug (including its `hist[][]` trail) into the new target and
  then overwrites only `pos`, so the original **draws a long straight line** from
  the old bug location to the new random target position for ~`trailLen` frames —
  most visible as a burst of corner-running lines in the first seconds (the init
  parameter-shake fires `mutateBug` while trails are still the `memset(0)` from
  `initBugs`). Reseeding the ring removes that artifact. This is an aesthetic
  bug-fix, not a faithful transcription: a strictly faithful port would keep the
  jump-lines. Kept because the artifact is jarring and it was a prior, documented,
  deliberate choice (full write-up + a suggested C patch in
  `docs/xrayswarm-upstream-bug.md`); flag for the main session if strict fidelity
  to the original's jump-lines is preferred.
- **Batched stroke order.** The C draws segments interleaved tail->head (bugs then
  targets per trail position), so higher segments paint over lower ones. The port
  batches all segments by colour-map index into one `Path2D` each and strokes once
  per index, so where 1px trails overlap the topmost colour can differ slightly
  from the C. Per-segment colours are identical; only overlap layering shifts.
  Negligible on black with thin lines; a performance adaptation.

## Correctness self-review

- **No freeze / termination.** The hack runs forever by design (no closure
  state). The rAF loop is the standard capped lag-accumulator
  (`MAX_CATCHUP_STEPS = 4`); `pause()`/`resume()` reset `lastTime` and the
  mutation timer to avoid a catch-up burst.
- **No NaN / divergence.** Velocities are clamped to `maxVel` (and targets to
  `targetVel`); the low-speed boost `minVel/sqrt(temp)` is guarded with
  `temp > 1e-12` so it can never divide by zero into NaN (the only place the C's
  unguarded `sqrt(0)` could bite). `bounce()` reflects positions back in-bounds
  and reverses velocity, so positions stay within `[0,maxx) x [0,maxy)`. A
  headless harness ran ~67s of simulated time (4200 frames) including parameter
  mutations and full reseeds: **0 non-finite and 0 out-of-range coordinates**,
  and every frame's geometry changed (nothing stuck).
- **Bounded trail / fixed cost.** `hist` ring buffers are sized `MAX_TRAIL_LEN`;
  `head`/`tail` advance together and the oldest point is dropped when the buffer
  fills, so the drawn segment count is bounded by `(nbugs+ntargets)*trailLen`
  (harness max 10032 coords/frame vs. a 26400 ceiling). `trailLen` only changes
  via `randomBigChange`/`reinit`, never exceeding `MAX_TRAIL_LEN`.
- **Every mutation re-seeds what it reads.** `randomBigChange` case 0 sets the new
  `trailLen` *then* calls `computeColorIndices()` and `initBugs()` (which resets
  `head=tail=0` and re-rolls positions). `mutateBug` keeps every `closest` index
  in `[0, ntargets)` after either conversion (verified by tracing the
  pointer->index translation), and `ntargets >= 1`, `nbugs > ntargets` invariants
  always hold (initBugs bumps them). Recursion is bounded by the C's
  `rscDepth`/`rbcDepth` guards.
- **First frame is non-degenerate.** A single stored point draws nothing
  (`head === tail`), so `init()` warms up a few `step()`s to build short trails
  and then draws once, so the swarm is already on-screen the instant it mounts
  (and after resize/reinit).

## Spot-check in the browser (suggested)

- Frame 1 should already show scattered short streaks across the screen that
  immediately start swirling toward moving target points.
- Trails should fade head->tail; the start-up look is `COLOR_TRAILS` — blue bug
  trails with red target trails. Over time the auto-cycle should occasionally
  switch schemes (gray / red+random / the `schizo` variants that shimmer as
  colours shift along the trail each frame).
- Nothing should pile up at the edges, freeze, or blink to a blank screen
  (a `randomBigChange` reseed briefly empties trails, then they rebuild).
- The **Frame rate** slider is the only control; lowering it (longer delay)
  should visibly slow the swarm. With the auto-rolled ~100 bugs and a long trail
  it is the heaviest case to watch for jank.
