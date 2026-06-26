# triangle -- port notes

Port of `triangle.c` (Tobias Gloth, 1995; xscreensaver port 1997).

Original: <https://www.jwz.org/xscreensaver/> - source: `triangle.c` (~355 lines)

One-line: a random fractal mountain built by midpoint-displacement subdivision of a triangular height field, rendered as shaded isometric triangle facets, painter's-ordered back to front.

## Algorithm
A triangular height field `h[i][j]` (row `i` holds `size+1-i` columns; `size` is the largest power of two whose `5*size` fits the canvas width, capped at 128). Heights are built by **midpoint displacement** over `steps` levels:

1. **Corners** (stage 0): seed `h[0][0]`, `h[size][0]`, `h[0][size]` with `MAX(0, DISPLACE(0, delta[0]))`.
2. **Subdivision** (stage `k = 1..steps`): for every cell of size `d = 2 << (steps-k)`, set its three edge midpoints to `DISPLACE(half-sum of endpoints, delta[k-1])`, where `DISPLACE(h,d) = h/2 + uniform[0,2d+1) - d` and `delta[k] = floor(0.4*dim) >> k` (so the random roughness halves each level -- the fractal exponent).

After each subdivision the mesh is drawn (a batch of facets per tick, resuming from a `(di,dj)` cursor -- the C's `draw_mesh`) at resolution `d/2`. Each cell is two facets (`calc_points1`/`calc_points2`). A facet projects to screen with an **isometric skew**: `sx = xpos[2*i + j]` (rows shear right), `sy = ypos[j] - heightY(h)`, where `xpos` maps `[LEFT,RIGHT]=[-0.25,1.25]` and `ypos` maps `[TOP,BOTTOM]=[0.3,1.0]` of `dim = min(W,H)`, and `heightY(h) = max(h,0)^2 / floor(0.4*dim)` (the C's quadratic `level[]` table). Subtracting the height from screen-y makes taller cells rise up the screen.

Rows `j` run **back (0, near screen top) to front (`size`, screen bottom)**, so facets are drawn in painter's order and nearer facets overlay farther ones. Each refinement pass redraws the whole terrain finer over the previous one; only the **sky** (above the back baseline `ypos[0]`) is cleared between passes, so the range visibly sharpens coarse -> fine. When the finest pass (drawn while `stage == -1`) finishes, the range is complete.

**Colour** (`draw_atriangle`): a flat sea-level facet (all three projected heights 0) is blue water; otherwise the facet's index is `ncolors - ncolors/(pi/2) * atan(dinv * (heightSpread))` -- gentle slopes near the top of the palette, steep faces near the bottom (`dinv = 0.2/d`, finer passes more slope-sensitive).

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` -- see `squiral.md`. Technique twin: `mountain.js` (same midpoint-displacement-terrain family, incremental one-facet-batch-per-step vector draws + per-cycle regen).

## Rendering -- sparse vector, one facet batch per step
Faithful to the C's `draw_mesh`: each `step()` draws up to `count = 256/curD` cells, resuming from the `(di,dj)` cursor, exactly as the C scans `i < MAX_SIZE - j` (256-wide, guarded by `i+j < size`). Coarse passes are a tick or two; the finest pass is the long one (~190 ticks). Integer math (`Math.trunc`, `>>`) mirrors the C's `int` divisions so projection and colour indices land identically.

## Deviations from the C
- **`devicePixelRatio`**: backing store sized in device px; `dim`, projection, displacement and line widths are all device px, so the range fills the canvas and reads the same on retina.
- **Inter-scene dwell restored**: xscreensaver's STANDALONE build clears and restarts the instant the finest pass completes (no pause -- you never linger on the finished range). The C's xlockmore path *did* pause (`MI_PAUSE = 2000000` us = 2 s). We restore that as a **Dwell** slider (in steps, default 200 ~= 5 s at the default delay), then wipe and regenerate.
- **Per-scene palette rotation**: the C frees and re-creates a fresh random smooth colormap each scene. We use one fixed vivid rainbow `hsl(i*360/n, 80%, 55%)` and rotate it by a random `offset` per scene to give the same scene-to-scene colour variety.
- **Sea colour**: the C's "BLUE" is index 45 into a *random* colormap (not reliably blue despite the comment). We render sea as a constant `hsl(210,70%,45%)` so water always reads as water.
- **`heightY` computed, not table-looked-up**: the C's `level[]` is only `MAX_LEVELS = 1000` long, and a tall peak can index past it (undefined in C). We compute `h^2/one` directly, defined for every height.
- **Seam sealing**: the C leaves coloured facets un-outlined (relying on exact X polygon tiling). Canvas leaves thin anti-alias gaps between abutting fills, so each facet is sealed with a **same-colour hairline** stroke. The mono path (`ncolors <= 2`) keeps the C's look exactly: black fill (backface removal) + white outline.
- **Tuning / dropped extras**: `delay` stays us (xml default 10000, eased to 25000). The `--fps` flag, the multi-screen `tp->fast` field (set but unused in the C), and the X expose/`refresh` repaint path are dropped (host owns the meter; canvas needs no manual repaint).

## Correctness self-review
- **Termination / cycle advance**: the stage machine runs `-1 -> 0 (corners) -> 1..steps (subdivide) -> -1 (idle)`; each subdivision tick advances `stage` by one, and each drawing pass advances the `(di,dj)` cursor by `>= dDraw` per tick until `dj == size` sets `initNow`. A headless frame-driver harness (1920x1080, 6000 frames) completed **11 full scene cycles** with **0** non-finite coordinates -- the cycle reliably advances and regenerates. No exact-float comparisons; all cursor/stage tests are integer `===`.
- **Every branch re-seeds its successor**: the finest subdivision sets `stage = -1`; its drawing pass finishing flips `initNow` and enters the dwell; the dwell wipes, picks a new `offset`, clears `dwelling`, leaving `stage == -1, initNow == true`, so the next tick subdivides corners for a fresh scene. `init()`/`reinit()` reset `stage/initNow/dwelling/cursor` and rebuild every table.
- **First frame looks right**: `init()` runs in `resize()` before the first rAF and clears to black; the harness saw the first facet at ~frame 3-4 (~30-40 ms), so there is no long black screen -- the coarse range appears almost immediately and refines.
- **Bounds**: the triangular array exactly fits all subdivision and draw accesses (verified by hand: midpoint `j+d2` lands on the last valid column of row `i+d2`; draw guards `i+j < size` / `i+j+d < size` keep every `getH`/`xpos`/`ypos` index in range). Heights are `Int32Array`, well clear of overflow.
- **Peaks above the top are intended**: ~18% of facet vertices project above `y = 0` (min seen `-522` on a 1080 canvas). The back baseline sits at `0.3*dim` from the top, so tall fractal peaks rise above the screen and are clipped by the canvas -- exactly as X clips them in the original. Not a bug.
- **No freeze on pause/resume**: `resume()` resets `lastTime = 0` so resuming doesn't burst a backlog; `MAX_CATCHUP_STEPS` caps catch-up; `dwell` is a plain integer increment vs `config.dwell` so it always reaches the wipe.

See [[mountain]] and [[squiral]].
