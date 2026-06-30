# deco — port notes

Port of `deco.c` by Jamie Zawinski and Michael D. Bayne (1997), with golden-ratio and Mondrian modes by Lars Huttar — recursively subdivides the whole screen into nested rectangles and paints each cell with a flat colour and a border, for a Mondrian / "tacky 70s rec-room panelling" look. A complete layout is drawn at once, then held for a few seconds before the screen is cleared and a fresh random layout is drawn.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/deco.c` (~344 lines)

## Algorithm
`subdivide(x, y, w, h, depth)` is the C's `deco()` verbatim. At each node it decides between *terminate* and *split*:

- **Terminate** when `floor(random * maxDepth) < depth` OR `w < minWidth` OR `h < minHeight`. At a leaf it advances the cycling colour index, flat-fills the cell (`fillRect`), and outlines it (`strokeRect`). The random test makes deeper boxes ever likelier to stop, so the picture mixes big and small panels; the min-size test is a hard floor that guarantees the recursion bottoms out.
- **Split** otherwise: choose the axis — in golden-ratio or Mondrian mode always cut the *longer* side (keeps panels roughly square), else pick at random — then recurse on the two halves. The cut is at `w/2` (or `h/2`), or, in golden mode, at one of the two golden offsets `floor(w*PHI1)` / `floor(w*PHI2)` chosen at random.

One `step()` clears to black and recurses from `depth 0` over the whole canvas — i.e. one `step()` is one finished image. The palette is built once per run and reused (see **Palette**), as in the C. The rAF loop spaces redraws `delay` seconds apart (see **Timing**).

The three colour modes are detailed under **Palette**; Mondrian additionally forces the line width to `long_side/50` and the minimum cell to `long_side/8` (`mondrian_set_sizes`), which is why its panels are large and its borders thick.

## Palette
deco.c is a native `screenhack` that builds its colormap **once** in `deco_init` and reuses it for every redraw — recomputing per frame is an explicitly *unimplemented* idea in the source — so a fixed set of colours recurs across layouts. We mirror that: the palette is built once in `init()` from the shared `colors.c` ports in [colormap.js](colormap.js), not the vivid `hsl()` ramps the first port used.

- **random** (default) — `make_random_colormap` with `bright_p = False`, i.e. `makeRandomColormapRGB(n, false)`: each entry's R/G/B channels are independent uniform randoms, giving the muted/dark/bright *scatter* (tan, slate-gray, dark olive, the odd vivid pop) the live binary shows — **not** a saturated full-spectrum rainbow.
- **smooth** — `make_smooth_colormap` → `makeSmoothColormapRGB(n)`: 2–5 random HSV anchors interpolated into a gentle closed loop, so each run is one coherent (usually muted/pastel) colour family and consecutively-filled cells differ only slightly.
- **Mondrian** — the fixed 8-entry red/yellow/blue/white set from `make_mondrian_colormap` (5 white, 1 red, 1 blue, 1 yellow; the C's 16-bit channels `>> 8`), unchanged.

Leaf cells take colours by cycling a single index through the palette in fill order (the C's `current_color`), pre-incremented at each leaf and carried across redraws — so the first leaf uses `colors[1]`, exactly as the C.

**mono_p.** When `ncolors <= 2` the C sets `mono_p` (and skips the fg/bg swap): cells are left as the black background and bordered in **white**, with no per-cell colour. The port now does this too — at the low end of the `ncolors` slider you get a white wireframe of nested rectangles on black, not colour.

## Timing
**Paint-and-hold.** `deco_draw` draws one complete layout and returns `1000000 * delay` µs, with stock `*delay 5` — it holds each finished picture for **5 seconds** (the xml "Duration" slider, 1–60 s) before clearing and drawing a fresh random layout. There is no inter-frame animation, so per-frame compute is a rounding error against the multi-second hold: **no OVERHEAD term** is needed (the paint-and-hold case). `config.delay` is kept in seconds and the rAF loop spaces redraws `delay * 1000` ms apart; the slider is `live`. No `-fps` calibration applies (the live binary runs ~1 frame / 5 s), and no `µ` appears in any rendered string — the unit is `' s'`.

## Shared skeleton
Follows the gallery skeleton — see [[squiral]]. Standalone ES module exporting `title`, `info`, and `start(canvas) → { stop, pause, resume, reinit, config, params }`; an rAF lag-accumulator loop instead of the C's `usleep`; `devicePixelRatio` folded into cell minima / line width with the backing store sized in device px. Rect fills + borders follow the [[greynetic]] vector-`fillRect` idiom (here with a paired `strokeRect`, the canvas analogue of `XFillRectangle` + `XDrawRectangle`).

## Deviations from the C
(Palette and pace are faithful ports — see **Palette** and **Timing**. What follows are the rendering-substrate and UI differences.)

- **Catch-up capped at 1 redraw/frame** (`MAX_CATCHUP_STEPS = 1`). A full subdivision carries no state from the previous one, so replaying a backlog after a backgrounded tab would just thrash an identical-cost picture; one redraw per frame is the faithful behaviour.
- **Borders inset by half the line width.** `XDrawRectangle` strokes the cell edge; Canvas centres a stroke on its path, so I inset the `strokeRect` by `lineWidth/2` and shrink it by `lineWidth`, so adjacent cells' borders meet cleanly instead of each pair overlapping by a full width. Visually equivalent at the 1-px default; avoids doubled-up seams on retina. (At Mondrian's thick `long_side/50` borders the bevel line-join can leave a small fill-coloured triangle where two insets meet at a corner — a minor cosmetic artifact, not present at default widths.)
- **No `--smooth-colors`/`--mondrian` booleans;** the three colour modes are folded into one `Colors` select (random / smooth / Mondrian) since they're mutually exclusive in practice (Mondrian overrides everything).
- **`lineWidth = 0` ("minimal")** renders as 1 device px. The C's "Retina" tripling (width or height > 2560) is kept, applied in device px.

## Correctness self-review
Traced the termination/closure conditions by hand and exercised every mode in a stubbed-canvas Node harness (random / smooth / mondrian / golden×{random,mondrian} / lineWidth=0 / maxDepth=40 / minWidth=minHeight=1), plus 2000 back-to-back `reinit()`s.

- **Terminates / no stack blowup.** At `depth 0` the random test `floor(random*maxDepth) < 0` is impossible, so the root always splits at least once (matches the C). Beyond that, the `w < minWidth || h < minHeight` floor (minima clamped to ≥ 2 device px) guarantees the recursion bottoms out; with splits roughly halving, depth is bounded ~log2(W/2) even ignoring the random cutoff. Harness leaf counts stayed sane (16–254) and `maxDepth=40` did **not** blow the stack.
- **Every leaf both fills and borders.** In all runs `leafFills === strokes`, so no cell is ever filled without a border or vice-versa.
- **Golden-ratio degenerate boxes are safe.** A small box can yield `wnew = floor(w*0.382) = 0`; that zero-width child immediately satisfies `w < minWidth`, becomes a leaf, and its `fillRect(...,0,h)` / `strokeRect` (shrunk to width 0 via `max(0, …)`) are harmless no-ops — no crash, no shrink-below-zero loop. 2000 reinits across golden mode hit this repeatedly with no error.
- **First frame is complete.** `init()` calls `step()`, so the very first painted frame is a full layout — no degenerate/off-screen start.
- **Pause/resume & reinit.** `resume()` zeroes `lastTime` (no accumulated jump) and the 1-step cap means even a long pause yields at most one extra redraw; `reinit()` zeroes `lag` and redraws a fresh layout that gets its full hold time.
