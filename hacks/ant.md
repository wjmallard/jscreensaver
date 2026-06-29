# ant — port notes

Port of `ant.c` by David Bagley (1995), after Chris Langton's ant / Greg Turk's "turmites".

Original: <https://www.jwz.org/xscreensaver/> · source: `ant.c` (~1350 lines, most of it grid variants) · video: <https://www.youtube.com/watch?v=PaG7RCO4ezs>

## Algorithm
A turmite crawls a toroidal grid that doubles as its tape. Each generation it reads the cell's colour, looks up `machine[color + state*ncolors]` → (write a colour, turn by a relative move, change state), paints the cell, and steps to a neighbour. The rule is a random **Turk's number** (`ncolors` colours cycling, each turning L or R per a bit of the number; `ncolors = i+2` for `i = NRAND(NUMSTIPPLES-1)`, so 2..11) or — with probability `1/NUMSTIPPLES` (1/11) — one of three preset **tables** (ladder, spiral, square builder). Colour trails persist; the ant head is white; the dish resets every `cycles` generations. Several ants can share one tape.

`NUMSTIPPLES = 11` (`automata.h`) governs both numbers; an earlier port used 1/6 and capped `ncolors` at 8 — both fixed.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md` / `vines.md`.

## Palette (the load-bearing fix)
ant compiles with **no** `SMOOTH_COLORS` / `UNIFORM_COLORS` / `BRIGHT_COLORS` macro, so xlockmore gives it `color_scheme_default` → `make_random_colormap(..., bright_p = False, ...)`: `ncolors` (the `--ncolors` resource, default 64) **fully-random RGB** colours — *not* a smooth ramp and *not* a saturated rainbow. That base palette is built **once per run** (`buildBasePalette`, via `colormap.js`'s `makeRandomColormapRGB(n, false)`).

The ant's cell colours are then random *samples* of that base palette, exactly the C's
`ap->colors[i] = (unsigned char)(NRAND(npixels) + i*npixels) / (ncolors-1)`, drawn fresh each reset (`resampleAntColors`) and rendered via `MI_PIXEL(ap->colors[color-1])`. Cell value 0 = black; ant head = white. The C's cast binds before the divide, so the sum is truncated to 8 bits (`& 0xFF`, i.e. wraps) *before* dividing — the indices cluster/wrap rather than spread evenly; transcribed verbatim.

The previous port painted cells with `hsl(h, 100%, 55%)` — a vivid full-saturation rainbow, the systemic Batch-1 bug. Removed.

## Cell shapes (all of ant.c's grids)
The turmite rule is shape-independent — only the GRID geometry and the relative-move → absolute-angle mapping change with `neighbors`. All shapes are ported:

- **Square** — `neighbors == 4` (von Neumann) or `8` (Moore, diagonal moves too). Rectangular `fillcell` with the C's 1px gridline gap.
- **Hexagon** — `neighbors == 6`. `shape.hexagon[6]` polygon, built from `hexagonUnit` (`automata.h`) and filled as a `Path2D` (`CoordModePrevious` accumulation of the relative vertex deltas).
- **Triangle** — `neighbors == 3` or `12`. `shape.triangle[2][3]` (two orientations by `(col+row)&1`) from `triangleUnit`; `xs = trunc(1.52·ys)`, even `ncols`/`nrows`, staggered rows (the column steps by ±2 in `position_of_neighbor`).

**Shape selection** (`init_ant`, `pickNeighbors`): a fixed `--neighbors` of 3/4/6/8/12 is used as-is; **0 (the default) or 9** (since `NUMBER_9` is undefined) randomizes — `1/10` of the time uniformly over `{3,4,6,8,12}` (so 8 and 12 are rare), otherwise uniformly over `{3,4,6}`. With the default the shape is re-rolled on every reset, exactly like the binary.

Per-shape geometry constants (`xs`/`ys`/`ncols`/`nrows`/`xb`/`yb`, and the `hexDelta`/`triDelta` vertex deltas) are transcribed from `init_ant` with C integer truncation (`Math.trunc`).

## fullrandom: truchet / eyes / sharpturn are randomized, not toggled
xscreensaver's `xlockmore.c` hardcodes `mi->fullrandom = True`, so `init_ant`'s `MI_IS_FULLRANDOM` branch always wins and the `--truchet` / `--eyes` / `--sharpturn` resources are **inert** — each is re-rolled `LRAND() & 1` on every reset. The port mirrors the *binary's* behaviour: all three are randomized per reset rather than exposed as (dead) toggles.

- **Eyes** — two black pixels on the white head, per direction, gated by cell size (square/hex `> 3px`, triangle `> 6px`; 12-sided draws none, the C's `UNDER_CONSTRUCTION` path). Per-shape offsets transcribed from `draw_anant` (square cases 0/45/90/.../315; hex `hexagon[side]/2` walk; triangle `triangle[orient][side]/3` walk).
- **Sharpturn** — only acts when `neighbors > 4`: in `getTurk`/`getTable` it swaps normal↔hard left/right (so it changes 6/8/12 rules), and it picks the hex Truchet variant. A no-op on the square/triangle-3 grids, as in the C.
- **Truchet** (**Turk rules only** — `getTable` always clears it; `getTurk` keeps it only when cells `> 2px` and `neighbors ∈ {3,4,6}`): arc overlays on each cell, black on a coloured cell / white on the background. Square = two opposite-corner quarter-circles; hexagon = the 6-side arc set (sharpturn and non-sharpturn variants, with the C's fudge constants); triangle = the 3-side arc set. `XDrawArc` angles converted to canvas `ellipse` (X is CCW/y-up, canvas CW/y-down → negate); the per-cell truchet *state* `a` is computed per shape in `draw_ant`.

## Config (mirrors `ant.xml`)
- `delay` — Frame rate, microseconds, default **20000** (one generation per step, the C's `draw_ant`). Live. Unit `µs`.
- `cycles` — Timeout (generation lifespan), default 40000 (xml high 800000; the slider floor is 1000 rather than the xml's 0, which would reset every frame). Live.
- `count` — Ant count, signed spinbutton −20..20, default **−3**. Negative = random `1..|count|` (the C's `NRAND`-based count). Reinit.
- `size` — Ant size, signed spinbutton −18..18, default **−12**. Negative = random; size logic (`MINSIZE`/`MINGRIDSIZE`/`MINRANDOMSIZE`) transcribed from `init_ant`. Reinit.
- `ncolors` — Number of colors, 3..255, default 64 — the size of the random base palette. Reinit.
- `neighbors` — Cell shape select mirroring the xml (0 = random, 3, 4, 6, 9, 12). Default 0 (random). 9 falls through to random (the C's `NUMBER_9` is undefined). Reinit.

The old port's invented `delay` (ms) and fixed `size`/`count` were replaced with these. Grid geometry (cell sizes, `ncols`/`nrows`, `xb`/`yb` centering, polygon vertices) is computed in **CSS px** so the C's pixel math is exact; the canvas is dpr-scaled via `setTransform` only for sharpness.

## Motion
Continuous: one generation per `delay`, every ant moves one cell, trails persist, dish resets at `cycles`. Matches `draw_ant` exactly (no colour cycling, no paint-and-hold). Fixed-timestep lag accumulator (vines/squiral style).

## Notes
- **Framerate calibration (`OVERHEAD = 6385`).** The stock `delay = 20000 µs` is only a sleep floor; the live binary's real rate is lower (delay + framework overhead). The live `-fps` overlay shows ant at **37.9 fps**, so the loop adds `OVERHEAD`: `20000 + 6385 = 26385 µs → 37.9 generations/sec`. A calibration, not a tuning knob — the `delay` slider stays 1:1 with the xml. See the framerate-calibration note.
- The faithful turmite core (`fromTableDirection`, `chgDir = (2·ANGLES − dir) % ANGLES`, the step-first vs turn-first distinction, per-shape toroidal wrap) replicates the C exactly and is shared across all shapes.
- No scope cuts remain among the cell shapes (square 4/8, hexagon 6, triangle 3/12 are all ported). The `eyes`-for-12-sided case is intentionally absent (the C's `UNDER_CONSTRUCTION`/`return`).

## Needs live verification
All the per-shape **geometry, eyes and Truchet arcs** are new from-scratch transcriptions of X11 drawing primitives (polygon `CoordModePrevious` builds, `XDrawArc` angle/box → canvas `ellipse`, single-pixel eye offsets, the hex Truchet fudge constants). They run clean headless across all shapes (no crashes, no non-finite coordinates), but the exact **hexagon and triangle** cell shape, tiling alignment and Truchet curvature should be eye-checked against the live binary (`-neighbors 6`, `-neighbors 3`, default). The square grid was already verified in the prior pass. Lower-risk: square 4/8. Higher-risk: hexagon/triangle polygon alignment and the heavily-fudged hex Truchet arcs.
