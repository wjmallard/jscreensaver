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

- **GXxor / XOR:** none. This hack draws with `GXcopy` only; the fade is a colour
  ramp, so no XOR emulation is needed.
- **`closest` is an index, not a pointer.** The C stores `bug->closest` as a
  `bug*` into `targets[]` and the bug<->target `mutateBug` shuffles structs with
  `memcpy` and pointer comparisons. The port stores an integer index and
  translates the pointer comparisons to index comparisons (the moved last-target
  becomes index `i`; bugs that pointed at the converted target are re-randomized)
  to give identical behaviour.
- **FPS level-of-detail dropped.** The C uses `gettimeofday` to auto-tune `delay`
  and, when slow, drop trail length / bug count to hold a frame-rate band
  (`MAX_FPS`/`MIN_FPS`). The browser uses the standard rAF lag-accumulator with
  an exposed **Frame rate** slider instead, so that adaptive-detail logic and the
  `--fps` / `showfps` overlay are omitted.
- **`dt` consistency.** With `delay > 0` the C runs at `dt = DESIRED_DT/2 = 0.1`
  but only recomputes `halfDtSq`/`dtInv` from it on the next parameter mutation,
  so there's a brief startup transient where those derived constants lag `dt`.
  The port uses `dt = 0.1` and computes the derived constants consistently from
  the first frame (i.e. the C's steady state). The affected term
  (`acc * halfDtSq`) is a tiny second-order position correction.
- **Pacing.** The C does two `dt=0.1` sub-steps per drawn frame; the port does
  one `step()` per `config.delay` (lag-accumulator), defaulting `delay` to
  **16000 us** (a touch calmer/smoother than the stock 20000) and keeping
  per-step motion small for smooth trails.
- **Colour scheme is selectable.** The C cycles its scheme via mutation; the port
  defaults to `Auto (cycle)` (faithful) but also lets you lock any of the six
  schemes. When locked, the live `getScheme()` uses the chosen scheme while the
  internal auto value keeps mutating harmlessly. Colours are emitted as `rgb()`
  strings built byte-for-byte from the C's `initCMap` (gray/red/blue ramps plus
  the chained pseudo-random ramp).
- **Counts exposed.** `count`/`targets`/`trail` are surfaced as sliders where
  `0 = the C's auto-random`; the stock UI only exposed `delay`.

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
- Trails should fade head->tail; the default `Color` look is blue bug trails with
  red target trails. `Auto (cycle)` should occasionally switch schemes; the
  `schizo` schemes shimmer (colours shift along the trail each frame).
- Nothing should pile up at the edges, freeze, or blink to a blank screen
  (a `randomBigChange` reseed briefly empties trails, then they rebuild).
- Bumping **Bugs**/**Trail length** should cleanly clear and re-seed (reinit);
  with ~100 bugs and a long trail it is the heaviest case to watch for jank.
