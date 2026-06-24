# petri — port notes

Port of `petri.c` by Dan Bornstein (1992–1999). Competing molds spreading across a petri dish.

Original: <https://www.jwz.org/xscreensaver/> · source: `petri.c` (~779 lines)

## Algorithm
A toroidal grid of cells. Each living cell accumulates `growth` at its `speed` each iteration; past `orthlim` (1) it seeds its 4 orthogonal neighbours, and past `diaglim` (~1.414) it seeds all 8 and then **settles**. A just-born cell is painted in its mould's **bright** shade and redrawn **dim** once it settles — so each colony reads as a bright expanding ring filling in dim behind it. Only the active growth front is on a list, so cost scales with the front, not the grid. Random "blips" sprinkle new colonies; when a colony's lifespan (`blastcount`, in `[minlifespan, maxlifespan]`) runs out, a **black death** wave (colour 0, white-fronted) eats the molds — or the dish is wiped outright (`instantdeathchan`).

## Module shape (shared by every port)
`start(canvas) -> { stop, reinit, config, params }`; inline fixed-timestep rAF loop; `config`/`params` drive the host config box. See `squiral.md` for the skeleton.

## Deviations from the C
- The per-cell C linked list becomes **typed arrays + an `alive` index list** (the front). Cells seeded during a pass are grown the *next* pass, matching the C's head-insertion order.
- **Colours**: random vivid hues, bright (growing) + dim (~half lightness, settled) per mould; colour 0 = black, its bright = white (the death front). `originalcolors` (fixed primaries) not ported.
- **Units**: `delay` in ms (orig µs). The memThrottle / cell-size auto-scaling is dropped; no centring offset.

## Config
`delay` (Frame rate, live) · `size`, `count` (reinit — grid & mould count) · `diaglim` (growth shape) · `anychan` (birth rate) · `instantdeathchan` — all live but size/count. Speed/lifespan params keep their defaults (not exposed in the box yet).
