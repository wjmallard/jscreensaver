# discrete — port notes

Port of `discrete.c` (Tim Auckland, 1996, of the xlockmore lineage; itself adapted from `hop.c` by Patrick J. Naughton). A family of "discrete map" strange attractors. The standalone `thornbird` hack is the BIRDIE map of this very hack pulled out into its own screenhack.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/discrete.c` (~442 lines)

## Algorithm
Each run picks **one** map at random, weighted by a fixed 18-entry `bias[]` table, seeds it with random coefficients, then iterates the map `count` times per inner frame, plotting one tiny point per iteration. Points accumulate into a persistent image; the plot colour advances through the hue cycle once per inner frame. After `cycles` (inner) frames the screen clears and a fresh map begins.

The seven **reachable** maps (with their `bias[]` weight) are:

- **SQRT** ×4 — a Barry-Martin / Hopalong sqrt variant. `j = a + i; i = -oldj ± sqrt(|b·(oldi - c)|)` (sign from `oldi`'s sign), with `is = js = 1` so the iterate is in raw pixels. The **last** point of every inner frame reseeds a fresh strand whose start marches across the screen as `inc` grows (`i = ±inc·maxx/cycles/2`, integer division) — that's the characteristic "comb".
- **STANDARD** ×4 — the area-preserving Chirikov **Standard Map**: `j = oldj + b·sin(oldi)`, `i = oldi + j`, both reduced mod `2π`. The last point reseeds the orbit at `i = π`, `j` drifting with `inc`.
- **BIRDIE** ×3 — the **Bird in a Thornbush**: `j = oldi; i = (1-c)·cos(π·a·oldj) + c·b; b = oldj` (note `b` is mutating state here, the two-steps-ago value).
- **AILUJ** ×3 — an **inverse Julia** iteration. Coefficients `(a,b)` are accepted only if the forward Mandelbrot orbit doesn't escape in 10 iters (a connected Julia set). `i = ±sqrt(((oldi-a) + sqrt((oldi-a)² + (oldj-b)²))/2)` with a random sign and a `|i| ≥ 1e-8` guard; `j = (oldj-b)/(2·i)`.
- **TRIG** ×2 — `r2 = oldi²+oldj²; i = a + b·(oldi·cos r2 - oldj·sin r2); j = b·(oldj·cos r2 + oldi·sin r2)` (a contracting spiral-rotation map, `a=5`).
- **CUBIC** ×1 — `i = oldj; j = a·oldj - oldj³ - b·oldi` (`a = 2.77`).
- **HENON** ×1 — the classic **Hénon** map `i = oldj + a - b·oldi²; j = c·oldi` (`a=1, b=1.4, c=0.3`).

Each iterate maps to a pixel with `x = maxx/2 + (int)((i-ic)·is)`, `y = maxy/2 - (int)((j-jc)·js)`.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. pause/resume use the `rafId === 0` sentinel + `lastTime` reset.

## Rendering — Uint32 blit, accumulate (don't clear)
Tens of thousands of points accumulate per displayed frame (`INNER·count` = 10·4096 ≈ 41k), far too many for per-point `fillRect`. So this uses the **blit path** like `hopalong` / `thornbird`: a persistent `Uint32` `ImageData` buffer that `step()` writes pixels into, blitted once per frame with `putImageData`. The buffer is never cleared between frames — points accumulate until a fresh map is chosen, mirroring the C's `XDrawPoints` onto an un-cleared window + `MI_CLEARWINDOW` on restart. Each point is a `dot × dot` block (`dot` = 1, or `round(dpr)` on retina) so the figure stays visible. All geometry is computed in **device pixels** (`maxx = canvas.width`), so the attractor fills the device-res canvas directly (the `is/js` scales derive from `maxx/maxy`); this matches `hopalong`'s "keep the math in pixels, bump the dot on retina" approach.

## Loop / INNER batching
Fixed-timestep **lag accumulator** paced by `config.delay` (µs → divide by 1000), 8-step catch-up cap. The C's `draw_discrete` runs `draw_discrete_1` **10 times** per displayed frame, incrementing the cycles counter by 10; we keep `INNER = 10` so (a) the pace matches stock, (b) the SQRT/STANDARD per-inner-frame "comb" reseed marches at the same rate, and (c) the `cycles` timeout fires at the same wall-clock time. One `step()` = one `draw_discrete` = 10 inner frames + one `putImageData`.

## Correctness self-review
- **Divergence guard (the brief's main hazard):** after each iterate I test `isFinite(i) && isFinite(j)`; on a non-finite value the run reseeds a fresh map immediately (CUBIC can blow up cubically for some coefficient draws). I also verified with a headless node harness (`scratchpad/harness.mjs`) that across **40 full lifetimes × 7 maps** *plus* a 200-run random-mix, **zero** runs diverge naturally — but the guard stays in as a safety net per the brief. A second harness (`discrete_variety_check.mjs`) confirmed every map spreads over hundreds-to-hundreds-of-thousands of distinct pixels (STANDARD/SQRT fill 100k–700k; the thinner curve maps fill hundreds–thousands, with the occasional tight-attractor parameter draw — which is authentic, and the `cycles` timeout brings a new draw).
- **Fixed-point / overflow:** the SQRT comb reseed `inc·maxx/cycles/2` is integer division in the C; I use `Math.trunc(Math.trunc(inc·W/cycles)/2)` (never `>>`, which would overflow past 2³¹ since `inc·W` reaches millions). Pixel mapping uses `Math.trunc` to match C's `(int)` truncation toward zero.
- **mod semantics:** STANDARD uses C `fmod`; JS `%` has identical sign-of-dividend behaviour, and the `+2π` before the reduction keeps the main-branch values in `[0, 2π)`. Confirmed numerically.
- **Reset / no-freeze:** `newAttractor()` always reseeds **everything the next step reads** (`op, a..e, i, j, ic/jc, scales, inc, pix, frameCount, sqrtSign, stdSign`) and clears the buffer, so neither a timeout nor a divergence can leave stale state. `frameCount` is module-level (not per-step), so the timeout accumulates correctly across steps. AILUJ's connected-set `do/while` always terminates (it just re-rolls coefficients).
- **pause/resume & reinit:** resume resets `lastTime` so no catch-up burst; `reinit()` rebuilds the palette and picks a fresh map on a clean black buffer.

## Deviations from the C
- **Blit instead of `XDrawPoints`** (above) — same accumulate-onto-uncleared-window effect, points written straight into the `ImageData`.
- **Dead maps dropped:** the C `enum` defines `HSHOE` and `DELOG`, but `bias[]` never selects them, so their (unreachable) cases are omitted.
- **Colour:** the C walks an X colormap (`MI_NPIXELS`/`ncolors`, `MI_PIXEL`), advancing the index once per inner frame; we build an `ncolors`-entry **vivid HSL rainbow** (full-sat, L=0.55) and advance it the same way (house style favours saturated rainbows over the muted X default). With ≤ 2 colours it falls back to white, as the C does.
- **devicePixelRatio:** backing store sized in device px; `dot` follows `round(dpr)` so points stay crisp/visible on retina. Projection math is otherwise unchanged (and already device-px-relative).
- **Off-screen points** are skipped rather than drawn — identical visual result to X11 clipping them.
- **`count` exposed:** the stock UI hardcodes `count = 4096` (via the DEFAULTS resource, not the xml); we surface it as a "Points" slider for parity with the other attractor ports and to let slower machines dial it down. Noted as the only param beyond the xml.
- **AILUJ `jscale` quirk preserved:** the C sets `js = maxx/4` (not `maxy/4`) for AILUJ — likely a typo, but ported verbatim so the figure's aspect matches the original.
- **No erase transition:** the C's `MI_CLEARWINDOW` becomes an instant fill of the buffer to black (no wipes module).

## Config
Ranges mirror `hacks/config/discrete.xml`: `delay` (Frame rate, µs, live, inverted), `cycles` (Timeout — inner frames before clear + new map, live), `ncolors` (Colors, reinit), plus `count` (Points — added for parity, live). Default `delay` is the stock 20000 µs. See [[hopalong]], [[thornbird]], [[squiral]].
