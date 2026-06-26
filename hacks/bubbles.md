# bubbles — port notes

Port of `bubbles.c` (James Macnicol, 1995-1996) — "the kind of bubble formation that happens when water boils: small bubbles appear and, as they get closer to each other, combine to form larger bubbles which eventually pop." Soft-drink / frying-pan fizz.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/bubbles.c` (1467 lines — but the vast bulk is an embedded PNG sprite and its X11 pixmap plumbing; the actual simulation is ~250 lines). Removed from the stock XScreenSaver distribution as of 5.08.

See [[fluidballs]] and [[boxfit]] for the rising/growing-particle idioms this follows.

## Algorithm
Each bubble has a centre `(x, y)`, a radius `r`, and an **area** `area = 10·π·r²` (the C's `calc_bubble_area`, 2D path). Area — not radius — is the conserved quantity: merges add areas, and a bubble's radius is just `r = sqrt(area / (10π))`. Radii are screen fractions: `min = 0.006·min(W,H)`, `max = 0.045·min(W,H)`.

One step:
1. **Spawn** up to `spawnRate` new min-radius bubbles, never past a hard cap. In rise mode they appear near the bottom edge, in drop mode near the top, in float mode anywhere.
2. **Move** (rise/drop only): `y += rise(r)·dir`, where `rise(r)` ramps from a small floor up with radius (bigger bubbles rise faster, the C's `droppage` table) and `dir = -1` rise / `+1` drop. A bubble that leaves the screen **pops**.
3. **Merge** (`get_closest_bubble` + `merge_bubbles` + `bubble_eat`): a square **mesh** of side `2·max+3` buckets every bubble; for each bubble only its own cell plus the 8 neighbours are searched for the closest other bubble within `r_a + r_b + 2`. When two touch, the bigger eats the smaller (a tie is broken at random): the survivor moves to the **area-weighted mean** of the two centres, gains the food's area, and regrows its radius. A new touch is then re-checked so a single merge can **cascade**, exactly like `insert_new_bubble`. In rise/drop mode the area is **clamped** at the maximum (the bubble keeps rising until it leaves the screen); in float mode an over-maximum merge makes the bubble **pop**.
4. **Compact** — dead bubbles are filtered out in one pass.

The opening field is seeded with bubbles spread over the whole screen at varied sizes, so frame 1 is already a populated, mid-rise field.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. Fixed-timestep rAF lag-accumulator paced by `config.delay` (µs); `step()` is the heavy work (the merge pass), so we draw at most once per frame.

## Rendering — vector ops, full repaint
Each bubble is a **radial-gradient disc** (`createRadialGradient` with an upper-left offset highlight → translucent body → faint rim, plus a thin stroke) so it reads as a rounded 3D bubble. We **clear and redraw every bubble each frame**; the canvas is double-buffered, so this is flicker-free and replaces the C's incremental per-bubble X11 draw/erase GCs.

## Deviations from the C
- **Bitmap bubble mode DROPPED (the big one).** The default ("fancy") mode blits a pre-rendered PNG sprite per bubble — the embedded bitmap and its `ximage-loader` / `XCopyArea` / clip-mask machinery are most of the 1467-line file (plus `bubbles_default.c`). A browser has no use for it, so **only the procedural `-simple` / drawn-circle path is ported**, and it's the only mode. The stock `-simple` toggle therefore disappears, and `-broken` ("don't hide popped bubbles") is meaningless under a full repaint — both are dropped.
- **Default motion = rise.** The xml's gravity select defaults to *float*; we default to *rise* (bubbles climb and pop at the top) because it's the nicer, more recognisable look. All three modes (rise / float / fall) are exposed.
- **Continuous motion.** The C only moves bubbles inside an insert-cascade (and a brand-new, non-touching bubble in `-simple` float mode is added to the mesh but never drawn — a latent quirk). We run a clean continuous simulation: every bubble rises each step and is always drawn. This better matches the stated "bubbles rise and pop" behaviour and avoids the invisible-bubble quirk.
- **Mesh rebuilt each step** (O(n)) instead of the C's incremental linked-list bookkeeping (`add_to_mesh` / `delete_bubble_in_mesh` on every move) — same spatial-hash collision behaviour, far less pointer surgery, and cell indices are clamped so they can never go out of bounds.
- **Rise speed tuned calmer:** `MAX_RISE = 12` px/step vs the C's `MAX_DROPPAGE = 20`, with a small `MIN_RISE` floor so the smallest bubbles drift instead of freezing (the C gives `radius == min` a droppage of exactly 0). Scaled by `devicePixelRatio`.
- **Encoding:** the micro sign in the Frame-rate unit is the escape `' µs'`, never a literal byte.
- **Colour:** bubbles get a vivid per-bubble rainbow hue (a survivor keeps its hue through a merge); the C drew plain white circle outlines.

## Correctness self-review
- **Pool can never overflow or empty.** Spawning stops at a hard `maxBubbles` cap (derived from the mesh size), so memory is bounded; spawning always adds at least one per step while under the cap, and the field is seeded, so it can't empty. A headless harness (mock canvas/window) ran 3000 steps in each of the three modes: counts stayed in `[≈90, <cap]` with `bad = 0` — every `x, y, r, area` finite, every radius in `[min, max]`, every surviving bubble on-screen. (Float mode settles at a higher steady count, since it only sheds bubbles via over-max merges, but stays safely under the cap.)
- **Merge cascade terminates.** Each `mergePair` marks exactly one bubble dead, so the per-bubble `while (closest)` cascade strictly decreases the live count and must end; a large guard counter is belt-and-braces only.
- **No out-of-bounds.** `cellOf` clamps the cell to `[0, meshW-1] × [0, meshH-1]`, and neighbour lookups skip cells outside the mesh, so the spatial grid is never indexed out of range. Spawn positions are clamped in-bounds.
- **pause/resume / reinit.** `pause()` cancels the rAF and uses `rafId === 0` as the paused sentinel; `resume()` resets `lastTime` so there's no catch-up burst; `reinit()` clears to black and re-seeds (used for the non-live `sizeScale` / `ncolors` changes). Verified clean in the harness.

## Config
Ranges mirror `hacks/config/bubbles.xml` where applicable: `delay` (Frame rate, live, inverted), `mode` (Motion — rise / float / fall, the xml's gravity select), `trails` (Leave trails, live). Added for this port: `spawnRate` (Bubble rate, live — the C hard-codes 5 new bubbles per frame), `sizeScale` (Bubble size — multiplies the screen-derived radius range, reinit), and `ncolors` (Colors — rainbow size, reinit).
