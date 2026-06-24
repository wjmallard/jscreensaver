# boxfit — port notes

Port of `boxfit.c` (Jamie Zawinski, 2005).

Original: <https://www.jwz.org/xscreensaver/> · source: `boxfit.c` (~573 lines) · inspired by levitated.net's "Box Fitting".

## Algorithm
Boxes spawn at random empty spots as zero-size seeds and grow outward every step until they touch a wall or a neighbour — leaving a `growBy + spacing + border` margin — then freeze. Each step tops the live (still-growing) count back up to `boxCount`, so the gaps between the big early boxes fill with progressively smaller ones, producing a tightly-packed gradient-coloured mosaic of squares or circles. When no new seed can be placed (100 random tries fail), the whole field shrinks back to nothing and a fresh round begins, possibly flipping squares↔circles and the gradient axis.

## Palette
boxfit.c is a **native screenhack** (`#include "screenhack.h"`) that colours its boxes itself: `reset_boxes()` calls `make_smooth_colormap` with `*colors: 64`, a gradient of 2–5 random HSV anchors interpolated into a closed loop — muted/pastel hues, **not** a full-spectrum rainbow. Each box's fill is sampled from that map by its spawn position along one axis (`color_horiz_p` picks the axis per round), so a round reads as a smooth single-direction sweep through a few related hues. The live binary confirms this: rounds show e.g. blue→mauve, olive→green→lime, or maroon→dusty-pink — always a limited, muted multi-anchor sweep.

The port builds the palette with `makeSmoothColormapRGB(ncolors)` from `colormap.js` (a faithful port of `make_smooth_colormap`), re-rolled each round (Math.random — only the distribution must match). An earlier version used a fixed vivid `hsl(i*360/n, 80%, 55%)` full-hue rainbow — the systemic vivid-rainbow bug — now replaced.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — vector ops, full repaint
Filled rects / circles + optional outline → **canvas vector ops** (`fillRect` / `arc` + `stroke`), not blit. The C draws incrementally (only `CHANGED` boxes, and during the shrink phase it black-fills a margin around each box before redrawing). We instead **clear and redraw every box each frame** — the canvas is double-buffered so it's flicker-free, and it makes the shrink phase fall out for free (no erase-around bookkeeping, no `CHANGED`/`UNDEAD` flags).

## Variable-delay loop
`boxfit_draw` returns the microseconds to wait before the next call — normally `delay`, but `2_000_000` (2 s) once the field finishes packing and `1_000_000` (1 s) after it finishes shrinking. The port keeps this: `step()` returns the ms until the next step and the rAF lag-accumulator honours it, so the between-phase pauses are preserved (those two are the C's literal magic returns and keep their fixed 2 s / 1 s values). A redraw happens only on a step that changed something (idle through the pauses).

## Timing
Stock `*delay 20000` µs (matches the xml `default="20000"`). The delay is a sleep floor; each grow/shrink step also runs O(n²) collision tests, so the effective per-step pace is delay + compute. The live `-fps` overlay read ~35 fps at Load ~28 % across several rounds (delay-bound) ⇒ frame ≈ 28400 µs = 20000 floor + **OVERHEAD ≈ 8400 µs** compute, so a normal step waits `(config.delay + OVERHEAD)/1000` ms. (An earlier port used a by-eye `delay 40000` with no overhead — ~2× too slow per step.) The fps reading that lands right after a phase pause shows a much lower average (the 2 s hold drags the running mean down) and is excluded from the calibration.

## Deviations from the C
- **Full repaint** instead of incremental draw (above).
- **devicePixelRatio**: `growBy`, `spacing`, and `border` are scaled to device px (the C only bumps them ×3 past 2560 px), so packing density and line weight look the same on retina.
- **Border colour**: the C indexes the colormap with `(fill_pixel + ncolors/2) % ncolors` — using a *pixel value* as an index, a latent quirk that yields a quasi-random border colour. We store each box's colour *index* and use `(index + ncolors/2) % ncolors` — the intended complementary hue.
- **No image mode**: boxfit can grab a desktop/photo image to colour the boxes (`--grab`); that needs a screenshot we can't take in a browser, so only the gradient-colormap path is ported.
- **Units**: `delay` µs, stock `20000` as in the xml (see Timing for the OVERHEAD pace). `r` (restart) and non-live changes (`mode`, `colors`) start a fresh round via `reinit()`.

## Config
Ranges mirror `hacks/config/boxfit.xml`: `delay` (Frame rate, live, inverted), `mode` (Shape — boxes-or-circles / boxes / circles, reinit), `boxCount` (Boxes, live), `growBy` (Grow by, live), `spacing` (live), `border` (live), plus `ncolors` (Colors — added for parity; the stock boxfit UI doesn't expose it, reinit). Collision is O(n²) per step like the C — fine for the default counts.
