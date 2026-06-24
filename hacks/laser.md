# laser

Spinning lasers: a shared origin shoots a handful of radiating beams whose far
ends sweep around the screen's perimeter, each trailing a short bright-coloured fan.
"Moving radiating lines, that look vaguely like scanning laser beams. (Frankie
say relax.)"

## Source

Ported from `xscreensaver-6.15/hacks/laser.c` (356 lines), by Pascal Pensa, 1995
(xlockmore; removed from the xscreensaver distribution at 5.08). Config mirrors
`xscreensaver-6.15/hacks/config/laser.xml`.

## Algorithm

All beams share one origin `(cx, cy)` picked inside the screen (with a `MINDIST`
margin). Each beam has a current endpoint `(bx, by)` that lives on one of the four
borders (`bn` = TOP/RIGHT/BOTTOM/LEFT), a direction `dir` (clockwise or
counter-clockwise), and a `speed`. Every substep the endpoint walks `speed` pixels
along its border; when it runs off the end of a border it wraps onto the adjacent
border, carrying the overshoot so the angular speed stays constant through the
corner. The beam is the line from the origin to that endpoint, so as the endpoint
circles the perimeter the beam spins about the centre.

Each beam keeps a ring buffer of its last `lw` endpoints (`lw` = 2..39, random per
scene). The visible fan is those `lw` lines from the origin. The C runs `lr` = 3..7
substeps per displayed frame (so the beam advances `lr` notches per frame) and,
once the ring is full, erases the oldest beam before drawing the newest. After
`cycles` frames the whole scene re-seeds: a new origin, a new `lw`/`lr`, and fresh
per-beam border / direction / speed / colour.

Colours are an `ncolors`-entry bright random colormap (see **Palette**); consecutive
beams take `MI_PIXEL` from a random start, stepping `COLORSTEP` (2) per beam. With
`ncolors <= 2` the C's mono path draws white beams.

Speed is `(rand(2..16) * width / 1000) + 1` in device pixels, so it scales with
resolution automatically (no extra `S` factor needed); `cx/cy` and the line width
are scaled for retina the usual way.

## Palette — xlockmore BRIGHT_COLORS (faithful)

laser is an xlockmore hack and `#define`s **`BRIGHT_COLORS`**, so `xlockmore.c` builds
its colormap with `make_random_colormap(bright_p = True)` — `ncolors` colours of
**independent random bright HSV** (hue 0–360, saturation 30–100 %, value 66–100 %),
*not* an ordered hue ramp. The port builds it with the shared
**`makeRandomColormapRGB(ncolors, true)`** (`colormap.js`, a faithful port of
`utils/colors.c`) mapped to `rgb()` strings; `ncolors <= 2` falls back to white (the
C's `MI_WHITE_PIXEL` mono path). Each beam takes `MI_PIXEL(c)` from a random start,
stepping `COLORSTEP` (2) per beam — and because the entries are independent random
hues, the beams come out as a **wide spread of distinct bright colours** (verified
against the live binary), not a tight band. *(The earlier port used a fixed vivid
`hsl(h,100%,55%)` rainbow ramp — that was the systemic palette bug: the ramp +
`COLORSTEP` produced a tight band of adjacent hues, whereas the real palette scatters
bright hues across the wheel.)*

## Timing — stock delay + measured OVERHEAD

The live `-fps` overlay reads **20.0 fps at Load ~20 %** (delay-bound, well under
100 %): a real frame of `1e6 / 20 = 50000 µs = 40000 µs` sleep-floor `+ 10000 µs`
per-frame compute. So `config.delay` is the **stock 40000 µs** (the xml / `DEFAULTS`
value, slider 1:1) and the loop paces each frame at `(config.delay + OVERHEAD) / 1000`
ms with **`OVERHEAD = 10000`**, giving the live ~20 frames/s. *(The earlier port used
a by-eye `delay = 50000` with no overhead; it happened to land on the same ~50000 µs
effective frame, but it mis-mapped the slider — the stock 40000 default now reads
correctly off the xml.)*

## Deviations from the C

- **Erase strategy (no XOR; no black overdraw).** laser.c erases the oldest beam
  by overdrawing it in black with a copy-mode GC (it does *not* use `GXxor`). A
  black overdraw on an anti-aliased canvas leaves grey ghosts, so instead we keep
  each beam's ring buffer and **clear the canvas + redraw every live beam each
  frame** (the rotor/qix idiom). The pixels shown are identical to the C's
  `lw`-beam fan; only the erase mechanism differs. One stroke per beam per frame
  (<= `count` strokes), so it stays cheap.
- **Pre-rolled fan.** `seed()` runs one full ring of substeps so the first painted
  frame already shows a complete fan; the C builds the fan up over its first `lw`
  substeps. Cosmetic.
- **Pacing.** One `step()` = one C frame (`lr` substeps + the re-seed timer), paced
  by `config.delay` (stock 40000 µs) + a measured `OVERHEAD` (see **Timing**), not a
  by-eye value. `cycles` counts frames exactly as the C does.
- **Encoding.** The micro sign in the "Frame rate" unit is the `µ` escape, not
  a literal byte (ASCII-safe source rule).
- **Params.** Exposes exactly the xml's tunables (delay, count, cycles, ncolors).
  `lw`/`lr` stay internal randoms like the C. `count` clamps to >= 1 (the C's
  `MINLASER`); `showfps` is dropped (the host owns the FPS readout).

## Correctness self-review

- **Re-seed completeness.** `seed()` is `init_laser` minus the X11 GC/alloc: it
  resets `cx, cy, lw, lr, sw, so, time` and rebuilds the `lasers` array (each beam's
  `bx, by, bn, dir, speed, color` and a fresh `lw`-length ring). Nothing the loop
  reads next is left stale, so beams never freeze or vanish across a re-seed. The
  ring buffers are reallocated because `lw` changes every scene.
- **Border walk / clipping.** Endpoints stay on the border by construction
  (`bx in [0, W]`, `by in [0, H]`); the corner-wrap is ported verbatim for both
  `dir` values across all four borders. Since `speed << W,H` always, a single step
  can never skip a whole border. No clip is needed, and no axis-aligned beam can
  NaN — the only divisions are `% W` / `% H` with `W, H >= 1` (guarded).
- **Headless trace.** A node harness ran 5000 frames (~120k substeps) at 2560x1440:
  0 NaN / out-of-range endpoints, 24 re-seeds fired on schedule, the fan stayed
  full (`sw == lw`), and `x in [0, W]`, `y in [0, H]` held on all four edges.
- **pause/resume/reinit.** Standard squiral-style loop: `resume()` resets
  `lastTime` so there's no catch-up burst; `reinit()` clears and re-seeds for a
  clean fresh scene.

See [[squiral]] for the skeleton, [[qix]] / [[rotor]] for the ring-buffer trail
idiom, and [[halo]] for the related X11-raster-op erase workaround.
