# coral — port notes

Port of `coral.c` by Frederick G.M. Roeber (1997) — diffusion-limited aggregation: sticky "seeds" plus thousands of random walkers that stick on contact and grow branching coral, then hold and regrow.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/coral.c` (~327 lines)

Shares squiral's skeleton (inline ES module, `config` object, rAF + lag-accumulator loop, dpr scaling) — see [`squiral.md`](squiral.md).

## Algorithm
Scatter a few sticky seeds (each a drawn dot inside an invisible 3×3 sticky halo). `density`% of all cells become random walkers. Each tick every walker either **sticks** (if it's sitting on a sticky cell — draw it, spread stickiness to its 8 neighbours, retire it) or **steps** one cell in a random cardinal direction. The drawing color creeps through the spectrum as walkers are absorbed. When every walker has stuck, hold for a few seconds, then clear and regrow.

## Deviations from the C
- **Bit-packed board → `Uint8Array`** (dropped the `x>>5` / `x&31` packing).
- **`rand_2()` bit-hoarding → `Math.random()`** — it only existed to conserve `random()` calls.
- **`XFillRectangles` point-batching → direct `fillRect`** per stuck cell. Coral only draws the cells that stick each tick (sparse), so per-cell `fillRect` is plenty fast — no pixel buffer needed.
- **Retina `scale *= 2` (>2560px) → `scale = config.scale × devicePixelRatio`** — the gallery's consistent crispness model.
- **Fancy `erase_window` wipe → instant clear** before regrowing.

## Optimizations / fidelity
- Walkers stored as parallel `Int32Array`s with **swap-remove** (matches the C's `XPoint` swap-remove — including the quirk that the swapped-in walker is skipped for the rest of that sweep).
- **No wrap needed**: walkers are confined to `[1, width-2]`, so the 3×3 sticky stamp never runs off the grid (the C's border invariant).
- The **slow tail is intentional and kept**: completion requires *every* walker to stick, so the last few wander a while before the hold/regrow — it doubles as a dwell on the finished image.

## Config
`density` (% of cells that start as walkers), `seeds`, `ncolors`, `delay` (ms/step; C default 20), `holdTime` (ms to hold the finished coral), `scale`.
