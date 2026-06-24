# demon — port notes

Port of `demon.c` by David Bagley (1995), after David Griffeath's cyclic cellular automata — a Greenberg-Hastings-style excitable medium that self-organises from random noise into rotating spiral waves.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/demon.c` (~950 lines) · config: `hacks/config/demon.xml`

## Algorithm (direct port)
Each cell holds a state in `[0, states)`. A cell advances to `(state + 1) % states` if **any** neighbour already holds that next state (a threshold-1 rule); otherwise it holds. From random soup this self-organises (debris → droplets → defects → demons) into spiral waves, and after `cycles` generations the C calls `init_demon` again — a full re-init.

All six neighbourhoods are ported with their offset tables transcribed cell-for-cell from `draw_demon`:

- **Square** 4 (von Neumann) / 8 (Moore).
- **Hexagon** 6 — offset-coordinate lattice; the diagonal neighbours shift with row parity (even rows are drawn shifted, matching the C's `ccol = 2*col + !(row&1)`).
- **Triangle** 3 / 9 / 12 — `orient = (col+row)&1` picks left/right; 9 adds a shared second ring (NN, SS, NW, NE, SW, SE), 12 adds three per-orientation neighbours (NNE/SSE/WW on left, NNW/SSW/EE on right).

The rule reads the **old** grid for the whole pass and commits at the end (the C's `memcpy newcell=oldcell` then per-neighbour overwrite). Because a cell has exactly one valid "next" state, breaking on the first matching neighbour is equivalent to the C's multi-pass overwrite.

## Faithfulness — what matches the C now
- **`-neighbors` defaults to random** (`DEF_NEIGHBORS "0"`): each re-init picks a random grid from `{3,4,6,8,9,12}`, with its paired auto state count from `plots[1]` = `{12,16,18,20,22,24}`. There is **no Grid selector** in the config box because `demon.xml` exposes none.
- **Palette = `make_uniform_colormap`** (via `UNIFORM_COLORS`, `utils/colors.c`): a hue ramp `0→359` at a *single random* saturation **and** value, each in 66–100%, with `ncolors` (default 64) entries — built once and **kept across reseeds** (the C framework builds it at startup and `demon` never rebuilds it). Reproduced exactly with `makeColorRampRGB(0, S, V, 359, S, V, ncolors, false)` from `colormap.js`. So the map is a slightly-muted rainbow, **not** full-saturation.
- **State 0 is black.** Per-state colour is `baseColors[((s-1)*ncolors/(states-1)) % ncolors]` for `s≥1`, exactly as `drawcell`/`draw_state`. There is a genuine dark band in the cycle (an earlier port dropped it and coloured every state).
- **Timing matches.** `draw_demon` spreads one generation over `states + 1` framework ticks: one tick computes the next generation (paints nothing), then `states` ticks each paint only the cells that changed **into** that state (the C's per-state `cellList`). The port runs the same state machine, paced at `--delay` µs/tick, so the generation rate and the state-by-state reveal match. (An earlier port ran one whole generation per ~80 ms — roughly 12× too fast.)
- **`--size` is honoured**, including the default `-30` = *random* cell size per re-init (the C's `NRAND` branch for negative size), `0` = auto, positive = fixed; capped to `min(W,H)/5`. Computed in logical px, then scaled by `devicePixelRatio`.
- **Config mirrors `demon.xml`**: `delay` (µs, "Frame rate", inverted), `count` ("States", 0 = auto), `cycles` ("Timeout"), `ncolors` ("Number of colors"), `size` ("Cell size").

## Platform-side deviations (rendering / environment; not algorithm)
- **Framerate calibration (`OVERHEAD = 9880`).** The stock `delay = 50000 µs` is only a sleep floor; the live binary's real tick rate is lower (delay + framework overhead). Measured against the live `-fps` overlay demon runs **16.7 fps**, so the rAF loop adds `OVERHEAD`: `50000 + 9880 = 59880 µs → 16.7 ticks/sec`. A calibration, not a tuning knob — the `delay` slider stays 1:1 with the xml. See the framerate-calibration note.
- **Cell rendering is a stamp reimplementation, not the C's `XFillPolygon`/`XFillRectangles`.** Each shape is rasterised once into a pixel **stamp** and changed cells are blitted into one `ImageData`:
  - **Hex** = a half-open Voronoi cell (every pixel in exactly one hexagon — no gaps/AA seams).
  - **Triangle** = a half-open point-in-triangle test, two interlocking orientations. The tiling is the equilateral grid **rotated 90°** (triangles point left/right) — a from-scratch tiling that reproduces the C's `{E-or-W, N, S}` adjacency, not the C's exact vertex geometry. 9/12 render on the same triangle grid as 3 (only the neighbour coupling differs), matching the C (which draws 3/9/12 identically).
  - **Square** = a plain block.
  The grid is full-bleed (overfilled to the screen edges) rather than centred with the C's `xb/yb` border; cells are the faithful size either way.
- **~1px black gutter** between cells (device-scaled), standing in for the C's `xs - (xs>3)` / `(xs-1)` / `(xs-2)` insets. Not a configurable resource (the old port's "Border" slider was invented and has been removed).
- **Soup RNG**: `Math.floor(random()*states)` (uniform) vs the C's `(unsigned char)random() % states` (low byte, tiny modulo bias). The CA self-organises regardless of the exact initial noise.
- **No 2-colour stipple path.** The C falls back to B/W stipples when `ncolors < NUMSTIPPLES (11)`; the port always uses the colour path. `ncolors` below ~2 degenerates toward a single hue.

## Status
Core CA (neighbour topology + cyclic rule) was already correct and is unchanged. The 2026 fidelity audit rebuilt the **palette** (uniform colormap + black state 0), the **timing/lifecycle** (per-state reveal, `(states+1)`-ticks/generation pacing, random grid/size per re-init), and the **config** (mirrors the .xml, dropped the invented Grid/Border/States sliders, delay back to µs). These three rebuilds are transcribed from the .c, **not** tuned by eye, and want a side-by-side check against the live binary (especially the pace and the muted-rainbow palette).

## Open item
The geometry-specific code (neighbour offsets, cell→pixel origin, stamp) still lives as branches inside shared functions; a per-geometry "grid" strategy object would be cleaner. Noted for a future refactor.
