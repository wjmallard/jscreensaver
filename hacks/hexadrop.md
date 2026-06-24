# hexadrop — port notes

Port of `hexadrop.c` by Jamie Zawinski (2013) — the screen is tiled with a grid of regular polygons (hexagons, triangles, squares, or octagons) whose cells cyclically swap colour, with every cell pulling its new colour from one master cell so colour waves ripple across the whole tiling.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/hexadrop.c` (445 lines) · config: `hacks/config/hexadrop.xml`.

## Algorithm
`make_cells()` picks a base `size` from the long screen edge (`max(W,H) / grid_size`), derives a per-shape radius / rotation / lattice spacing, and lays out a grid one to three rows/cols larger than the screen so partial edge tiles still fill. Each cell stores a centre, radius, rotation `th`, a drop phase `i` (the inner-disc radius), a `speed`, and `colors[2]` (current + previous colour index).

Every frame `draw_cell()` fills TWO concentric convex polygons per cell: the OUTER one at the full cell radius in the *current* colour `colors[0]`, then the INNER one at radius `i` in the *previous* colour `colors[1]`. The inner disc shrinks by `speed` px per frame. When `i` goes negative the cell "drops": it resets `i` to the full radius, pushes `colors[0]` down into `colors[1]` (the just-shown colour becomes the new inner disc), and sets `colors[0]` to **cell 0's** current colour — except cell 0 itself, which rolls a fresh random colour. So cell 0 is the wave source; every other cell inherits its colour whenever it happens to reset, and because the cells reset at staggered phases (random `i`) and possibly different speeds, the inherited colour spreads outward as a ripple.

The four lattices (each in `make_cells`'s `switch (sides)`):
- **6 (hexagons)** — `r = size/sqrt(3)`, `th = PI/6`, rows packed at `size*sqrt(3)/2`, odd rows shifted left half a cell; `gh *= 1.2`.
- **3 (triangles)** — `size *= 2`, `r = size/sqrt(3)`, `th = PI/6`; cells at `x*size/2`, `y*size*sqrt(3)/2`; cells with `(x^y)&1` are flipped (`th += PI`) and nudged up `r/2` so up- and down-pointing triangles interlock.
- **4 (squares)** — `size /= 2`, `r = size*sqrt(2)`, `th = PI/4`; cells on a plain grid at `x*size*2`, `y*size*2`.
- **8 (octagons)** — `r = size*0.75`, `th = PI/8`, `gw,gh *= 1.25`; EVEN columns are octagons, ODD columns become small rotated squares (`sides=4`, `th=PI/4`, ~half radius) filling the gaps; odd rows shift left one `size`.

`uniform`/`lockstep` (and their "Maybe" defaults) control whether all cells share one speed and whether they start phase-/colour-synchronised. When both are left random the C deliberately turns on at most one of them.

## Rendering approach
Each cell is two small convex filled polygons redrawn every frame (sparse vector work, not per-pixel accumulation), so this uses canvas `ctx.fill(Path2D)` — see [[truchet]] for the tile-geometry idiom. Grid-cell colour state follows [[demon]] / [[cloudlife]]. Cells are coloured from a faithful port of the original's colormap (see **Palette**).

## Palette
hexadrop colours its cells from xscreensaver's stock colormap builders (`hexadrop_init_1`), clamping `ncolors >= 2` and then branching on the count:
- `ncolors < 10` → `make_random_colormap(..., bright_p = False, ...)` — fully-random RGB channels, an *unordered* scatter of dark/muted/bright colours (not a ramp).
- `ncolors >= 10` → `make_smooth_colormap` — 2–5 random HSV anchor points interpolated into a closed loop, i.e. a limited, harmonious, often-muted hue arc.

The default `ncolors` is 128, so the usual palette is the smooth colormap. The port mirrors this exactly via `colormap.js`: `makeSmoothColormapRGB(n)` for `n >= 10` and `makeRandomColormapRGB(n, false)` for `n < 10`, each mapped to `rgb()` strings. The window background and the master cell (cell 0, the wave source) both read from this map, so the whole honeycomb is a family of close shades — which is why the live tiling reads as a dense field of subtly-varying tiles, and only goes sparse when many cells happen to share the background colour (a faithful, phase-dependent effect, verified against the live `-sides 6`/`-sides 4` runs).

Earlier this port used a fixed vivid `hsl(h, 100%, 55%)` 360° rainbow — the systemic palette bug. That made every cell inheriting cell 0's colour vanish against the matching background, so the tiling looked far sparser and gaudier than the original's muted smooth map.

## Timing
Stock `*delay` is 30000 µs. The live delay is a sleep *floor*; each frame also pays a compute/framework cost, so the effective rate is below `1e6/30000 = 33.3` fps. Measured on the XQuartz build with the `-fps` overlay (squares and hexagons, firmly delay-bound at Load ≈ 17–29%), the self-consistent readings cluster at a **median ≈ 26.3 fps** (readings that implied a sleep below the 30000 µs floor were discarded as stale-window/startup grabs). So:

`OVERHEAD = round(1e6 / 26.3) − 30000 ≈ 8000 µs`

The loop paces on `(config.delay + OVERHEAD) / 1000` ms per step; an in-browser step-rate probe confirms ≈ 25–26 steps/s, matching the live pace.

## Deviations from the C
- **Dropped the `SCALE=10` fixed-point vertex grid.** The C rasterises polygons in 10x fixed point only because X11's integer `XFillPolygon` produced "little pointy errors at some corners"; canvas fills floats exactly, so vertices are computed directly in device px. `SCALE` is kept *only* to reproduce the drop dynamics frame-for-frame — the inner radius decrements by `speed` px/frame and its initial phase is `random(r)/SCALE` (up to r/10 px), exactly matching the C once its SCALE units are divided out. The `radius += SCALE` seam-avoidance bump becomes a `+1` px bump.
- **Per-shape speed is stored as a factor, not baked.** The C bakes `config.speed` into each cell's `c->speed` at build time; here each cell keeps only the random `0.1..1.0` (or uniform `1`) *factor* and the loop multiplies by `config.speed`, so the **Speed** slider applies live without a rebuild. The relative per-cell speeds are identical.
- **No XOR / feedback / erase tricks needed** — the algorithm is plain over-painting (outer then inner polygon every frame), which canvas does directly. First frame paints the background to cell 0's colour (mirroring the C's `XSetWindowBackground(colors[0])`) and draws every cell once, so nothing flashes black before the first step.
- **`uniform`/`lockstep` are 3-way selects** (Random / On / Off) rather than X resources with a "Maybe" string; the random "turn on at most one" rule is preserved in `resolveFlags()`. The xml's `showfps` boolean is omitted (the host has no FPS overlay).
- **`delay` defaults to the stock 30000 µs** (the xml/`.c` value), paced with a measured `OVERHEAD` (see **Timing**) rather than a by-eye number; `ncolors` clamps to >= 2 like the C.

## Correctness self-review
- **Drop terminates / never freezes.** `i` strictly decreases by `config.speed * factor` each frame; both are clamped > 0 (Speed slider min 0.1, factor >= 0.1), so `i` always reaches < 0 and resets — there is no exact-equality test that could miss. The reset re-seeds `i = radius` (full) and reassigns both colour slots, so the next frame reads valid state. With `config.speed` floored at 0.1 there is no zero-decrement freeze.
- **No off-screen / degenerate start.** `init()` builds the grid, paints the background, and draws one full frame before the rAF loop, so the very first painted frame is the complete tiling (not a black screen). `size` and (for squares) the halved `size` are floored to >= 1 so radii are never zero even on a tiny window.
- **Colour indices stay in range.** Indices are taken `% ncolors`, and the build clamps any seeded index to `ncolors-1`; `colors` has exactly `ncolors` (>= 2) entries, so `colors[idx]` is always defined.
- **Wave coherence.** Cells are iterated `0..ncells` in order exactly as the C, so a cell that resets and pulls `cells[0].colors[0]` on the same frame cell 0 rolled a new colour sees the fresh value — matching the original's propagation.
- **pause/resume & reinit.** `pause()` cancels the rAF and zeroes `rafId`; `resume()` resets `lastTime = 0` so no catch-up burst; `reinit()` clears to black and rebuilds via `init()` for non-live changes (shape/size/colours/sync). Live keys (`delay`, `speed`) are read fresh each frame.

See [[squiral]] for the shared module skeleton (config box, lag-accumulator loop, devicePixelRatio handling) every port follows.
