# deco — port notes

Port of `deco.c` by Jamie Zawinski and Michael D. Bayne (1997), with golden-ratio and Mondrian modes by Lars Huttar — recursively subdivides the whole screen into nested rectangles and paints each cell with a flat colour and a border, for a Mondrian / "tacky 70s rec-room panelling" look. A complete layout is drawn at once, then held for a few seconds before the screen is cleared and a fresh random layout is drawn.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/deco.c` (~344 lines)

## Algorithm
`subdivide(x, y, w, h, depth)` is the C's `deco()` verbatim. At each node it decides between *terminate* and *split*:

- **Terminate** when `floor(random * maxDepth) < depth` OR `w < minWidth` OR `h < minHeight`. At a leaf it advances the cycling colour index, flat-fills the cell (`fillRect`), and outlines it (`strokeRect`). The random test makes deeper boxes ever likelier to stop, so the picture mixes big and small panels; the min-size test is a hard floor that guarantees the recursion bottoms out.
- **Split** otherwise: choose the axis — in golden-ratio or Mondrian mode always cut the *longer* side (keeps panels roughly square), else pick at random — then recurse on the two halves. The cut is at `w/2` (or `h/2`), or, in golden mode, at one of the two golden offsets `floor(w*PHI1)` / `floor(w*PHI2)` chosen at random.

One `step()` clears to black, builds a fresh palette, and recurses from `depth 0` over the whole canvas — i.e. one `step()` is one finished image. The rAF loop spaces these `delay` seconds apart.

Three colour modes map straight across:
- **random** — an independent vivid hue per palette slot (the C's `make_random_colormap`, brightened per house style).
- **smooth** — a single even sweep around the hue wheel (`make_smooth_colormap`); adjacent cells differ only slightly.
- **Mondrian** — the fixed 8-colour red/yellow/blue/white set from `make_mondrian_colormap`, and (as in the C) it also overrides line width to `long_side/50` and the minimum cell to `long_side/8`.

## Shared skeleton
Follows the gallery skeleton — see [[squiral]]. Standalone ES module exporting `title`, `info`, and `start(canvas) → { stop, pause, resume, reinit, config, params }`; an rAF lag-accumulator loop instead of the C's `usleep`; `devicePixelRatio` folded into cell minima / line width with the backing store sized in device px. Rect fills + borders follow the [[greynetic]] vector-`fillRect` idiom (here with a paired `strokeRect`, the canvas analogue of `XFillRectangle` + `XDrawRectangle`).

## Deviations from the C
- **`delay` is a *Duration in seconds*, not the usual per-step µs interval.** deco.c's `deco_draw()` returns `1000000 * delay` µs and does no inter-frame animation, so I keep `config.delay` in seconds (xml "Duration", 1–60, default 5) and the loop uses `delayMs = config.delay * 1000`. The "Frame rate (µs, invert)" convention every other port uses doesn't apply — this slider is a plain hold time and is `live`. No `µ` appears in any rendered string (the unit is `' s'`).
- **Catch-up capped at 1 redraw/frame** (`MAX_CATCHUP_STEPS = 1`). A full subdivision carries no state from the previous one, so replaying a backlog after a backgrounded tab would just thrash an identical-cost picture; one redraw per frame is the faithful behaviour.
- **Borders inset by half the line width.** `XDrawRectangle` strokes the cell edge; Canvas centres a stroke on its path, so I inset the `strokeRect` by `lineWidth/2` and shrink it by `lineWidth`, so adjacent cells' borders meet cleanly instead of each pair overlapping by a full width. Visually equivalent; avoids doubled-up seams on retina.
- **Colour palette is HSL, not X11 colormaps.** The C allocates X colormap cells; we build CSS `hsl(...)` strings. Hues are pushed vivid (random) or smoothly ramped (smooth) per the project's "vivid over muted" guidance. The Mondrian palette is the exact C values, converted 16-bit → 8-bit.
- **`mono_p` path dropped.** The C flips to monochrome (and swaps fg/bg) when `ncolors <= 2`; we always draw in colour. `ncolors` is exposed as a 1–255 palette-size slider; at low counts you get few colours, but never the fg/bg swap. Noted as a minor look difference at the extreme low end.
- **No `--smooth-colors`/`--mondrian` booleans;** the three colour modes are folded into one `Colors` select (random / smooth / Mondrian) since they're mutually exclusive in practice (Mondrian overrides everything).
- **`lineWidth = 0` ("minimal")** renders as 1 device px. The C's "Retina" tripling (width or height > 2560) is kept, applied in device px.

## Correctness self-review
Traced the termination/closure conditions by hand and exercised every mode in a stubbed-canvas Node harness (random / smooth / mondrian / golden×{random,mondrian} / lineWidth=0 / maxDepth=40 / minWidth=minHeight=1), plus 2000 back-to-back `reinit()`s.

- **Terminates / no stack blowup.** At `depth 0` the random test `floor(random*maxDepth) < 0` is impossible, so the root always splits at least once (matches the C). Beyond that, the `w < minWidth || h < minHeight` floor (minima clamped to ≥ 2 device px) guarantees the recursion bottoms out; with splits roughly halving, depth is bounded ~log2(W/2) even ignoring the random cutoff. Harness leaf counts stayed sane (16–254) and `maxDepth=40` did **not** blow the stack.
- **Every leaf both fills and borders.** In all runs `leafFills === strokes`, so no cell is ever filled without a border or vice-versa.
- **Golden-ratio degenerate boxes are safe.** A small box can yield `wnew = floor(w*0.382) = 0`; that zero-width child immediately satisfies `w < minWidth`, becomes a leaf, and its `fillRect(...,0,h)` / `strokeRect` (shrunk to width 0 via `max(0, …)`) are harmless no-ops — no crash, no shrink-below-zero loop. 2000 reinits across golden mode hit this repeatedly with no error.
- **First frame is complete.** `init()` calls `step()`, so the very first painted frame is a full layout — no degenerate/off-screen start.
- **Pause/resume & reinit.** `resume()` zeroes `lastTime` (no accumulated jump) and the 1-step cap means even a long pause yields at most one extra redraw; `reinit()` zeroes `lag` and redraws a fresh layout that gets its full hold time.
