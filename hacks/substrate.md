# substrate — port notes

Port of `substrate.c` (Mike Kershaw "dragorn", 2004), a direct port of J. Tarbell's
"Substrate" (complexification.net, June 2004). Sibling to the Tarbell flow field in
`binaryring`.

Original: <https://www.jwz.org/xscreensaver/> · source: `substrate.c` (~780 lines)

## Algorithm
Cracks grow as straight (or arced) lines on a blank substrate. Each step a crack
advances `STEP = 0.42` px and marks an **occupancy grid** (`cgrid`) with its integer
heading angle. A crack stops when it steps onto a cell already marked by a *different*
crack (angle differs by >= 5 deg — a near-parallel self-overlap is tolerated), or runs
off the edge, or (if curved) closes a full 360 deg arc. On stopping it **restarts itself**
from a random existing crack cell heading **perpendicular** (+/-90 deg) to it, and
**spawns one new crack** the same way — so the plane recursively subdivides into
city-block structures. With `wireframe` off, a **SandPainter** walks perpendicular to
each crack to the far edge of the open region and sprays `sandGrains` very-low-alpha
dots between the tip and that edge, building substrate's watercolour wash.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — sparse vector, accumulating (NOT cleared per frame)
One small `fillRect` per crack tip per step (opaque black, the C's `fgcolor`), plus the
sand grains as low-alpha `fillRect`s. The canvas accumulates; it is only cleared (to
**white**, the stock `.background`) on a reseed. Collision detection reads our own
`Int32Array` `cgrid` (sized to the **logical** canvas, `canvas.{w,h}/dpr`), never canvas
pixels — faster and exact, mirroring the C's `cgrid[]`. Sand alpha is done by canvas
`globalAlpha` compositing, which is exactly the read-blend-write the C's `trans_point()`
does by hand against its `off_img` buffer, so `off_img` is dropped.

## Crack pool / no-freeze guarantee
The pool only **grows**, from `initialCracks` up to `maxCracks` (the C reallocs one slot
per `make_crack`; we `push`, capped). A dying crack always restarts in place via
`startCrack`, and `makeCrack` no-ops once the cap is hit — so a saturated screen keeps
moving (cracks just restart into ever-smaller gaps) rather than freezing. The for-loop
reads `cracks.length` each iteration, so a crack spawned mid-frame also moves that frame
(faithful to the C, where `f->num` grows inside the draw loop).

## Saturation / duration restart (spot-check this)
There is **no per-pixel "is the screen full" test** in the C; instead a `cycles` counter
(one per step) triggers `build_substrate` + clear-to-white at `maxCycles` (xml "Duration",
default 10000). By then the field is saturated, so this *is* the saturation restart. The
port keeps it: `step()` increments `cycles` and calls `reseed()` when
`maxCycles !== 0 && cycles >= maxCycles`. Verified in a headless harness: over 920 steps
with `maxCycles = 400` the reset fired exactly twice (3 white fills incl. init), with zero
non-finite values. Set `maxCycles = 0` to disable the restart (runs forever).

## Deviations from the C
- **devicePixelRatio**: the sim runs at logical resolution (`cgrid` = `W*H` logical) and
  each tip/grain is drawn as an `S x S` device-px block (`S = dpr`), so lines stay 1
  logical px and the look holds on retina. Crack motion + the perpendicular sand walk are
  in logical px (unscaled `STEP`/`0.81`), matching the original pixel cadence.
- **Sand blending** via `globalAlpha` instead of the C's manual `off_img` lerp (identical
  result); `off_img` removed. Off-screen grains are skipped (the C's `XDrawPoint` clips).
- **Colormap**: the 122-entry Pollock map from `substrate.c` is included verbatim — it is
  the C's **only** colour mode (crack lines are black `fgcolor`; the sand grains carry the
  Pollock tones). No colour slider: an earlier draft added a non-stock `'rainbow'` HSL
  palette behind a `palette` select; both were **removed 2026-07-01** as invented (the C
  has no such option — Rule 3, drop invented knobs).
- **Angle compare is raw degrees** (no modulo), exactly as the C — a curved crack's `t`
  accumulates past 360 before its `degrees_drawn > 360` restart fires, but stays well below
  the `OPEN = 10001` sentinel, so occupied/empty never alias.
- **Units / defaults**: `delay` µs as in the xml, at the **stock default 18000** plus a
  live-measured `OVERHEAD = 8100` µs, so the rAF lag-accumulator paces one step per
  `(delay + OVERHEAD)` and reproduces the live binary's **38.3 fps** (measured via `-fps`
  at 820x560: Load 31.0%, a clean delay-bound reading — the sleep slice `26110 * (1-0.310)
  = 18016` ≈ stock 18000, so contention-free). The earlier by-eye `18000 -> 16000` nudge is
  gone; see [[framerate-calibration]]. substrate is intentionally slow/meditative; raise
  **Frame rate** to speed growth, **Initial cracks** for a busier start. `maxCracks` exposed
  as "Max cracks" (stock 100; not in the stock UI). Keypress-to-restart dropped (the host
  owns keys + `reinit`).

## Correctness self-review
- **Termination/closure**: every stop branch (collision, out-of-bounds, closed circle)
  calls `startCrack` (re-seeds x/y/t and, for curved, `ys/xs/t_inc/degrees_drawn`) so the
  next state reads valid fields; collision uses an integer angle delta (>= 5), not float
  equality, so it reliably fires. Curved cracks reset `degrees_drawn = 0` on restart.
- **No overflow / NaN**: `cgrid` is `Int32`; `(W+H)/2` is small (no `>>` past 2^31, and
  `Math.floor` is used); `r` is clamped to `>= 10` so `STEP/r` never divides by ~0; harness
  confirms 0 non-finite `globalAlpha`/`fillRect` args over thousands of steps incl. an
  all-curved + min-pool + rainbow run.
- **Pause/resume/reinit**: `pause()` nulls `rafId`; `resume()` re-baselines `lastTime = 0`
  so the first frame can't burst a catch-up (verified: 1st frame runs 0 steps, then it
  advances). `reinit` (and resize) rebuilds the grid + clears to white for a clean restart.
- **Perf**: `regionColor` runs per crack per step; its perpendicular walk is capped at
  `W+H+2` iterations (it naturally terminates at the first crack/edge). At the default
  cap of 100 cracks x 64 grains that's ~6k `fillRect`s/step, fine for the ~1 step/frame the
  default delay yields. The 10000-try `startCrack` search is the C's; respawns are rare
  relative to the fill, and the search gets *cheaper* as the screen fills (more hit cells).
