# loop — port notes

Port of `loop.c` by David Bagley (1995), implementing Chris Langton's self-reproducing loops (Langton, *Self-Reproduction in Cellular Automata*, Physica 10D 135-144, 1984).

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/loop.c` (~1700 lines, the bulk of it the unported hexagon variant + its rule tables).

Shares squiral's skeleton (inline ES module, `config` object, rAF + lag-accumulator loop, dpr scaling) and is the closest sibling to [`ant.js`](ant.md) — both are Bagley square-grid CAs that draw one colored block per changed cell and reset periodically. See [`squiral.md`](squiral.md), and the grid-CA twins [`demon.md`](demon.md) / [`cloudlife.md`](cloudlife.md) (Uint8 grid, double buffer, colored per-cell block, periodic restart).

## Algorithm
An 8-state CA on a square (von Neumann, 4-neighbour) grid. From a single seed — the 10x10 **Adam loop** — a sheathed strand of "genetic" data circulates around the loop; when it reaches the loop's open construction arm it extrudes a copy, and the daughter then closes into its own loop and starts reproducing. The colony grows outward like a coral reef: the outer loops keep spawning while inner ones, walled in by their own daughters, fall dormant. It restarts when the colony fills the dish (`generation > cycles`) or the pattern stops changing (`dead`).

### The transition table (the crux)
The whole behaviour lives in `TRANSITION_TABLE`, transcribed **verbatim** from loop.c's `transition_table[]` (216 octal rules). Each rule is an octal word read right-to-left as `CBLTRI`: low digit `I` = next state, then `R`,`T`,`L`,`B` (the 4 neighbours), high digit `C` = the cell's own (center) state. Rules are packed into a 4096-entry lookup `table[(B<<9)|(L<<6)|(T<<3)|R]`, with all 8 center-state outputs stuffed 3 bits each into one entry — exactly loop.c's `TABLE`/`TABLE_IN`/`TABLE_OUT` macros.

Each rule is inserted under **all four 90-degree rotations** — `(R,T,L,B)`, `(T,L,B,R)`, `(L,B,R,T)`, `(B,R,T,L)` — so a cell's next state is rotation-invariant (depends only on its state and the cyclic order of its neighbours), matching the C's four `TABLE_IN` calls. Neighbour directions match `position_of_neighbor`: `R`=east(0°), `T`=north(90°), `L`=west(180°), `B`=south(270°). The CA has a chosen **handedness**: a random per-restart `clockwise` flag mirrors both the seed (`ADAM[j][N-1-i]`) and the lookup (`TABLE_OUT(c, B,L,T,R)`), per loop.c's `init_adam` / `do_gen`. Only one handedness works for a given table; both mirror images reproduce identically.

## Correctness self-review
The brief's decisive check is whether a seed loop actually **replicates** rather than freezing or dissolving into static noise. Verified offline (headless Node) before shipping:

- **It reproduces.** From the Adam seed (population 72) the live-cell count climbs steadily — 99 @gen50, 200 @gen200, 436 @gen400 — and the number of connected components rises 1 → 2 → 3 → 4 as daughter loops detach. Growing population + multiplying disjoint structures is the signature of correct self-reproduction; a wrong table either dies to 0 or freezes at the seed.
- **Both handedness variants replicate** identically (mirror symmetry), confirming the mirror seed + mirror lookup pairing is right.
- **The bounding-box optimisation is exact.** loop.c only scans/steps an active rectangle that grows as the colony spreads. I do the same, but verified it generation-for-generation against a full-grid double-buffer reference: the two grids stay **bit-identical through 600 generations**. The box never clips the wavefront because `initAdam` seeds it one cell larger than the loop footprint and the front advances at most one cell per generation, so the box is always ≥1 cell ahead of any change. (Background outside the box can't spontaneously light: the `0000000` rule keeps a 0-cell surrounded by 0-cells at 0.)
- **Restart re-seeds what the next step reads.** `init()` zeroes both buffers, repaints the dish black, drops a fresh Adam loop, and resets `generation` and the active box — so a restart (fill, freeze, or `reinit`) gives a clean screen, and `pause`/`resume` only toggles the rAF (resetting `lastTime` to avoid a catch-up burst).

## Deviations from the C
- **Square grid (4 neighbours) only — the iconic case.** loop.c's hexagonal (6-neighbour) variant, its big `hex_transition_table`, and the "blue wall flaw" mutation feature (`--count` random wall spots that liven up / mutate the colony) are **not** ported. They are most of the file.
- **Colours: vivid full-saturation HSL** keeping the C's state→hue mapping (0 black, 1 red, 2 blue, 3 magenta, 4 green, 5 yellow, 6 cyan, 7 white), brighter than the original colormap-stretched palette. The C's `ncolors` slider only stretched that colormap; with a fixed 8-state palette there's nothing to stretch, so that slider is dropped (like demon/ant fixing their palette to the state count).
- **Units**: `delay` in **ms** (C used 100000 µs); default eased to 60 ms, a touch calmer than stock, matching the ms convention in ant/demon/cloudlife.
- **Sizing**: the C randomises cell size from `--size` (negative = "up to"); we use the absolute size directly as device pixels (`size × dpr`), with the same `xs - (xs > 3)` 1px gridline gutter. The dead 1-cell border ring is preserved, so loops that wander to the screen edge die at the "petri dish" wall as in the original.
- **Rendering**: sparse `fillRect` per **changed** cell (the wavefronts), not a per-frame full blit — the active set each generation is small, so direct fills are cheaper than an ImageData pass here (unlike demon/cloudlife, whose whole field changes).

## Config
`delay` (Frame rate, live) · `size` (Cell size, reinit) · `cycles` (Lifespan — generations before restart, live). Handedness is randomised on every (re)build, so `reinit` / restart can flip the spin direction.
