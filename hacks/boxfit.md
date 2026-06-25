# boxfit — port notes

Port of `boxfit.c` (Jamie Zawinski, 2005).

Original: <https://www.jwz.org/xscreensaver/> · source: `boxfit.c` (~573 lines) · inspired by levitated.net's "Box Fitting".

## Algorithm
Boxes spawn at random empty spots as zero-size seeds and grow outward every step until they touch a wall or a neighbour — leaving a `growBy + spacing + border` margin — then freeze. Each step tops the live (still-growing) count back up to `boxCount`, so the gaps between the big early boxes fill with progressively smaller ones, producing a tightly-packed gradient-coloured mosaic of squares or circles. When no new seed can be placed (100 random tries fail), the whole field shrinks back to nothing and a fresh round begins, possibly flipping squares↔circles and the gradient axis.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — vector ops, full repaint
Filled rects / circles + optional outline → **canvas vector ops** (`fillRect` / `arc` + `stroke`), not blit. The C draws incrementally (only `CHANGED` boxes, and during the shrink phase it black-fills a margin around each box before redrawing). We instead **clear and redraw every box each frame** — the canvas is double-buffered so it's flicker-free, and it makes the shrink phase fall out for free (no erase-around bookkeeping, no `CHANGED`/`UNDEAD` flags).

## Variable-delay loop
`boxfit_draw` returns the microseconds to wait before the next call — normally `delay`, but `2_000_000` (2 s) once the field finishes packing and `1_000_000` (1 s) after it finishes shrinking. The port keeps this: `step()` returns the ms until the next step and the rAF lag-accumulator honours it, so the between-phase pauses are preserved. A redraw happens only on a step that changed something (idle through the pauses).

## Deviations from the C
- **Full repaint** instead of incremental draw (above).
- **devicePixelRatio**: `growBy`, `spacing`, and `border` are scaled to device px (the C only bumps them ×3 past 2560 px), so packing density and line weight look the same on retina.
- **Border colour**: the C indexes the colormap with `(fill_pixel + ncolors/2) % ncolors` — using a *pixel value* as an index, a latent quirk that yields a quasi-random border colour. We store each box's colour *index* and use `(index + ncolors/2) % ncolors` — the intended complementary hue.
- **No image mode**: boxfit can grab a desktop/photo image to colour the boxes (`--grab`); that needs a screenshot we can't take in a browser, so only the gradient-colormap path is ported.
- **Units**: `delay` µs as in the xml. `r` (restart) and non-live changes (`mode`, `colors`) start a fresh round via `reinit()`.

## Config
Ranges mirror `hacks/config/boxfit.xml`: `delay` (Frame rate, live, inverted), `mode` (Shape — boxes-or-circles / boxes / circles, reinit), `boxCount` (Boxes, live), `growBy` (Grow by, live), `spacing` (live), `border` (live), plus `ncolors` (Colors — added for parity; the stock boxfit UI doesn't expose it, reinit). Collision is O(n²) per step like the C — fine for the default counts.
