# critical -- port notes

Port of `critical.c` by Martin Pool (1998-2000) -- a self-organizing-criticality
display: random squiggles that settle into order, drawn as a moving rainbow trail.

Original: <https://www.jwz.org/xscreensaver/> - source: `critical.c` (~462 lines) -
removed from xscreensaver as of 5.08 (the .xml is the post-removal stub).

## Algorithm
The model is an 80 x H grid of cells (`MODEL_W = 80` fixed; H follows the screen
aspect), each holding a random unsigned-short value. One **step** (the C's
`model_step`):

1. Scan the whole grid for the **highest-valued cell** (`>=`, so ties resolve to
   the last/bottom-right one, exactly as in the C). That cell's `(x, y)` is the
   next **point** of the walk.
2. Replace that cell **and its eight neighbours** with new random values
   (neighbours off the edge are ignored).

Consecutive points are joined by straight lines (cell centre to cell centre,
`x*cellSize + half`) into a trail. The colour advances every `LINES_PER_COLOR`
(10) steps, so the trail is a sliding rainbow band. The walk is a grid-max search,
so each point is always a valid grid cell -- it can never diverge, fly off-screen,
or go NaN by construction.

Two integer counters drive the lifecycle (the C's `d_i_batch` / `i_restart`):
every `BATCHCOUNT` (1500) steps an `i_restart` tick fires, and every `RESTART`
(8) ticks a **full re-seed** runs (new colormap phase, fresh random model, walk
origin reset). That is one re-seed per `RESTART*(BATCHCOUNT+1)` = **12008 steps**
(~4 min at the default delay 20000) -- verified exactly with a headless harness.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` -- see
`squiral.md`. Closest twin: `qix.js` (the same moving-trail idiom); `binaryring.js`
for the moving-trail/walk feel.

## Rendering -- sparse vector ops, full repaint of the trail
The trail is the **only** thing on screen: the C draws the newest segment and
erases the oldest in black each step, and nothing else is ever drawn, so at any
moment exactly ~`trail` segments are live over an otherwise-black screen. Rather
than emulate X11's draw-newest / erase-oldest (which on canvas leaves
anti-aliasing **ghosts** where a black re-stroke fails to fully cover a coloured
one -- the known erase-redraw AA hazard), the port keeps the last `trail` points
in a ring and **full-repaints** each frame: clear to black, then stroke the
connected polyline. Segments are grouped by colour into one `Path2D` each and
stroked once per colour (<= `ncolors`, typically ~6 strokes/frame). The model
scan is ~80 x H ~= 3600 cells/step; both costs are trivial.

`step()` only mutates state (model / trail ring / counters); `frame()` does a
single `repaint()` after all of that frame's steps, so a multi-step catch-up
frame repaints once, not N times.

## Deviations from the C
- **No erase transition on restart.** The C kicks off an animated `erase_window`
  wipe between runs. There is no Canvas-2D equivalent (the project's `wipes.js`
  is not yet integrated), so a restart simply re-seeds; because the port
  full-repaints every frame, the screen clears to the fresh short trail on the
  next frame -- an instant cut instead of a wipe. Noted per the brief's
  erase/feedback rule.
- **Full repaint instead of draw-newest / erase-oldest.** Visually identical (a
  moving ~`trail`-segment squiggle on black) but seam-free: no XOR/black-restroke
  AA ghosts. A side effect is the segment count is `trail-1` at steady state vs.
  the C's `trail-2` (its erase fires one slot early) -- an off-by-one in trail
  length that is imperceptible.
- **devicePixelRatio.** The backing store is device px; `cellSize` is computed in
  device px (`canvas.width / 80`), so the grid stays ~80 x (80*H/W) on any dpr and
  the look is the same on retina. Line width is `max(1, dpr)`.
- **Palette.** The C's default `colorscheme=smooth` becomes a vivid full-saturation
  HSL wheel (`hsl(h, 100%, 55%)`); a random `hueOffset` is re-rolled on each
  restart so a fresh run never repaints in the same colours. `ncolors` maps 1:1.
- **Trail slider capped at 300** (the C clamps `trail` to 2..1000); 300 is plenty
  for the look and keeps repaint cheap. `batchcount` (1500) and `restart` (8) are
  kept as faithful internal constants -- the post-removal xml exposes only `delay`
  and `ncolors`, and those two knobs only change restart cadence, not the look.
- Keypress / `fps` handling dropped (the host owns keys and the meter); `resize()`
  re-seeds on a window change.

## Config
Ranges mirror `hacks/config/critical.xml`: `delay` (Frame rate, **live**, inverted
microseconds) and `ncolors` (Colors). Added: `trail` (Trail length), the C's
defining visual resource. `ncolors` and `trail` are **non-live** (they size the
palette / trail ring, so a change re-runs `init()` via `reinit()`, giving a fresh
screen). "Reset to defaults" and `r` (restart) re-seed via `reinit()`.

## Correctness self-review
- **Bounded, finite walk.** The next point is the argmax of the grid, always a
  valid cell in `[0,80) x [0,H)`. Headless harness over 12013 steps: **0**
  out-of-range or NaN points. No iterated map, so no clamp/reseed-on-divergence is
  needed -- documented rather than bolted on.
- **No unbounded growth.** The trail is a fixed `trail`-length ring; `histCount`
  caps at `trail` (harness max = 50 with trail=50). Full repaint is O(trail).
- **Restart fires on integer counters, exactly.** `d_i_batch--` then
  `if (<0) { reset; i_restart = (i_restart+1)%RESTART; if (0) restart }` -- ported
  verbatim with integers (no float test). Harness: first full restart at step
  **12008 = RESTART*(BATCHCOUNT+1)**, matching the C. Restart re-seeds the model,
  resets the trail ring, and re-rolls `hueOffset`, so it does **not** repaint
  identically (the brief's restart check).
- **Clean first frame.** `init()` seeds one point; `repaint()` returns early while
  `histCount < 2` (just black), then a short segment appears and the trail unfurls
  -- on-screen, in-range from frame one, never a degenerate/off-screen start.
- **Pause/resume & reinit.** Pause cancels rAF and parks `rafId = 0`; resume resets
  `lastTime = 0` to avoid a catch-up burst. `reinit()` re-seeds and repaints
  immediately for a clean fresh screen.

See [[squiral]], [[qix]].
