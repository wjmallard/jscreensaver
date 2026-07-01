# critical -- port notes

Port of `critical.c` by Martin Pool (1998-2000) -- a self-organizing-criticality
display: random squiggles that settle into order, drawn as a moving colour trail.

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
(10) steps; the visible trail spans only ~`trail/LINES_PER_COLOR` (~5) adjacent
colormap entries at a time, so it reads as one slowly-cycling colour family (the
live binary looks the same -- a single hue family drifting through the colormap).
The walk is a grid-max search,
so each point is always a valid grid cell -- it can never diverge, fly off-screen,
or go NaN by construction.

Two integer counters drive the lifecycle (the C's `d_i_batch` / `i_restart`):
every `BATCHCOUNT` (1500) steps an `i_restart` tick fires, and every `RESTART`
(8) ticks a **full re-seed** runs (fresh smooth colormap, fresh random model, walk
origin reset). That is one re-seed per `RESTART*(BATCHCOUNT+1)` = **12008 steps**
(~2 min at the stock delay 10000) -- verified exactly with a headless harness.

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

`critical.c` **is** on the AA-off list -- it calls
`jwxyz_XSetAntiAliasing(dpy, gc, False)` on both the fg and bg GCs (critical.c
~326-327) and its identity **is** a draw-newest / erase-oldest each frame. But the
erase (`draw_step(st, st->bgc, ...)`) is a plain **background-colour over-paint**,
NOT an XOR / bitwise / pixel-exact op, and nothing but the trail is ever on screen,
so the identity does **not** depend on a bit-exact destructive erase. Full-repaint
therefore reproduces the identical image (a sparse trail on black) and we keep
canvas AA per the stroke-hack rule, rather than dropping to a software framebuffer.
(The only difference: the C's black over-paint can cut a tiny gap through a newer
segment that crosses the oldest one; full-repaint leaves crossings intact -- an
imperceptible improvement, not a regression.)

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
- **Palette (now faithful -- was the systemic vivid-rainbow bug).** The C's default
  `colorscheme=smooth` -> `make_smooth_colormap` (critical.c `setup_colormap`): a
  closed loop of `ncolors` entries interpolated between 2-5 random HSV anchors. The
  port now uses `colormap.js`'s faithful `makeSmoothColormapRGB(ncolors)`, replacing
  the earlier vivid full-saturation `hsl(h, 100%, 55%)` wheel (+ `hueOffset`), which
  was the same vivid-rainbow deviation caught across every prior batch. The colormap
  is re-rolled on each restart, exactly as the C re-runs `setup_colormap`, so a fresh
  run never repaints in the same colours; the roll can be muted or vivid, matching
  the live binary. `ncolors` maps 1:1. (`colorscheme` random/uniform are real C
  resources, but the post-removal xml exposes neither -- only the default `smooth`
  is ported; no invented colour selector.)
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

## Speed
The stock `delay` default is **10000 us** (the xml / `.c` value); an earlier port had
it doubled by-eye to 20000 -- **corrected to 10000**. The loop paces one step (one
new trail segment) per `(delay + OVERHEAD)`, not raw `delay`: the xml delay is a
sleep FLOOR, so the live binary's effective rate is `1e6/(delay+overhead)`. `OVERHEAD`
is the live-measured **7850 us** (live 56.0 fps, Load 44.0%, clean at stock delay 10000;
one ~80xH grid scan + a couple of line draws per step, comparable to compass 8571 /
substrate 8100).

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
  resets the trail ring, and rolls a fresh smooth colormap (`buildColors()`), so it
  does **not** repaint identically (the brief's restart check).
- **Clean first frame.** `init()` seeds one point; `repaint()` returns early while
  `histCount < 2` (just black), then a short segment appears and the trail unfurls
  -- on-screen, in-range from frame one, never a degenerate/off-screen start.
- **Pause/resume & reinit.** Pause cancels rAF and parks `rafId = 0`; resume resets
  `lastTime = 0` to avoid a catch-up burst. `reinit()` re-seeds and repaints
  immediately for a clean fresh screen.

See [[squiral]], [[qix]].
