# demon — port notes

Port of `demon.c` by David Bagley (1995), after David Griffeath's cyclic cellular automata — a Greenberg-Hastings-style excitable medium that self-organises from random noise into rotating spiral waves.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/demon.c` (~950 lines)

Shares squiral's skeleton (inline ES module, `config` object, rAF + lag-accumulator loop, dpr scaling) — see [`squiral.md`](squiral.md).

## Algorithm
Each cell holds a state in `[0, states)`. A cell advances to `(state + 1) % states` if **any** neighbour is already in that next state, otherwise it holds. From random soup this self-organises (debris → droplets → defects → demons) into spiral waves, and reseeds with fresh noise every `cycles` generations. Because the states are cyclic, a full color rotation takes ≈ `states × delay` ms.

## Deviations from the C
- **Grids: hexagons (6, default), squares (4 / 8), and triangles (3) are implemented. The denser triangle variants (9 / 12 neighbours) are NOT ported** (they add second-ring offset tables for marginal payoff).
- **Every state gets a color** (cyclic HSL rainbow). The C drew state 0 black; mapping the cyclic states onto the cyclic hue wheel instead gives a seamless rotating rainbow with no dark band.
- **`states` auto-pairs to the grid** (tri 12 / sq-4 16 / hex 18 / sq-8 20), per the C's own table. This matters: a cell only advances when a neighbour is exactly one state ahead, so too many states for a small neighbourhood **fizzles/freezes** (e.g. 18 states on the 3-neighbour triangle locks up in ~50 steps). `config.states: 0` means auto; a number overrides.
- Stipple / colormap machinery → packed `uint32` colors; `devicePixelRatio` folded in.

## Optimizations / rendering
Because every cell is a fixed shape, each shape is rasterised once into a pixel **stamp** and blitted into an `ImageData` buffer (one `putImageData` per generation), drawing only the cells that **change** each generation (the wavefronts):
- **Hex** stamp = a **half-open Voronoi cell** — every pixel belongs to exactly one hexagon, so the tiling has no gaps and no anti-aliased seams (all integer math).
- **Triangle** stamp = a **half-open point-in-triangle** test, two interlocking orientations (◄ / ► chosen by `(col + row)` parity).
- **Square** stamp = a plain block.
- **Optional black borders** (`config.border`) = erode the stamp inward so the gutter pixels stay background — matches the C drawing each cell ~1px short (`xs - 1`).

## Geometry notes
- The hex neighbour topology is the standard offset-coordinate scheme (parity-dependent diagonals), transcribed from the C.
- The triangle grid is the equilateral tiling **rotated 90°** (triangles point left/right), derived from scratch to match the C's `{N, S, E-or-W}` adjacency. Col/row counts are forced even so the left/right orientation stays consistent across the toroidal wrap.

## Open item
The geometry-specific code (neighbour offsets, cell→pixel origin, stamp) currently lives as branches inside shared functions. A cleaner structure would isolate those three concerns into a per-geometry "grid" strategy object feeding one shared CA/blit engine — noted for a future refactor.

## Config
`cellSize`, `border` (CSS px; 0 = solid), `neighbors` (6 / 4 / 8 / 3), `states` (0 = auto-pair), `cycles`, `delay` (ms/generation).
