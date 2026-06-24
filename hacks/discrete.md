# discrete — port notes

Port of `discrete.c` (Tim Auckland, 1996, of the xlockmore lineage; itself adapted from `hop.c` by Patrick J. Naughton). A family of "discrete map" strange attractors. The standalone `thornbird` hack is the BIRDIE map of this very hack pulled out into its own screenhack.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/discrete.c` (~442 lines)

## Algorithm
Each run picks **one** map at random, weighted by a fixed 18-entry `bias[]` table, seeds it with random coefficients, then iterates the map `count` times per inner frame, plotting one tiny point per iteration. Points accumulate into a persistent image; the plot colour steps one entry per inner frame through a fixed `make_smooth_colormap` palette (built once at startup, shared by every map in the session). After `cycles` (inner) frames the screen clears and a fresh map begins.

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
- **No divergence guard (now faithful):** `discrete.c` has **no** non-finite check and **no** early reset — it iterates blindly and lets X11 clip any off-screen point. An earlier port added an `isFinite(i) && isFinite(j)` early-reset (with a comment claiming "the brief mandates" it — it does not), which made escaping orbits reseed sooner than the C ever would. **Removed during the 1C audit.** `plot()` already skips non-finite / off-screen coordinates exactly as X11 clips them, so a (rare) escaping orbit simply stops drawing until the `cycles` timeout reseeds — matching the C. Justified by a numerical harness (`scratchpad/discrete_divergence.mjs`): the seeds + recurrences over **60 full lifetimes × all 7 maps (~4.3 billion iterations)** produced **zero** non-finite `(i,j)` and a bounded max `|i|,|j| ≈ 4.6e3`, so the removal has no visible effect. (Every map is bounded by construction: STANDARD/AILUJ/BIRDIE via `fmod`/`sqrt`/`cos`, TRIG/HENON/CUBIC are contracting or classic bounded attractors, SQRT's growth is sub-linear under the `sqrt`.)
- **Fixed-point / overflow:** the SQRT comb reseed `inc·maxx/cycles/2` is integer division in the C; I use `Math.trunc(Math.trunc(inc·W/cycles)/2)` (never `>>`, which would overflow past 2³¹ since `inc·W` reaches millions). Pixel mapping uses `Math.trunc` to match C's `(int)` truncation toward zero.
- **mod semantics:** STANDARD uses C `fmod`; JS `%` has identical sign-of-dividend behaviour, and the `+2π` before the reduction keeps the main-branch values in `[0, 2π)`. Confirmed numerically.
- **Reset / no-freeze:** `newAttractor()` always reseeds **everything the next step reads** (`op, a..e, i, j, ic/jc, scales, inc, pix, frameCount, sqrtSign, stdSign`) and clears the buffer, so the `cycles` timeout reseed can't leave stale state. `frameCount` is module-level (not per-step), so the timeout accumulates correctly across steps. AILUJ's connected-set `do/while` always terminates (it just re-rolls coefficients).
- **pause/resume & reinit:** resume resets `lastTime` so no catch-up burst; `reinit()` rebuilds the palette and picks a fresh map on a clean black buffer.

## Deviations from the C
- **Blit instead of `XDrawPoints`** (above) — same accumulate-onto-uncleared-window effect, points written straight into the `ImageData`.
- **Dead maps dropped:** the C `enum` defines `HSHOE` and `DELOG`, but `bias[]` never selects them, so their (unreachable) cases are omitted.
- **Colour (FIXED in the 1C audit):** `discrete.c` is built with `SMOOTH_COLORS`, so the xlockmore wrapper (`xlockmore.c:485`, `color_scheme_smooth`) builds **one** `make_smooth_colormap` at startup — random 2–5 HSV anchors, frequently muted/pastel — and never rebuilds it. The hack then just walks the colour index (`MI_PIXEL`/`hp->pix`) one step per inner frame. An earlier port instead built a **vivid full-saturation HSL rainbow** ("house style"), which is exactly the Rule-1 deviation this audit targets. Now ported faithfully via `makeSmoothColormapRGB(ncolors)` from `colormap.js`, **built once in `init()`** (not in `newAttractor`), so every map in a session shares the one palette as the C does; the index-walk cadence is unchanged. With ≤ 2 colours it falls back to white (the C's `MONO`/`MI_NPIXELS <= 2` path). Note the palette **re-rolls on resize/`reinit`** (since those rerun `init()`), where the C would keep it — a benign, standard-port deviation on a rare event.
- **devicePixelRatio:** backing store sized in device px; `dot` follows `round(dpr)` so points stay crisp/visible on retina. Projection math is otherwise unchanged (and already device-px-relative).
- **Off-screen points** are skipped rather than drawn — identical visual result to X11 clipping them.
- **`count` exposed:** the stock UI hardcodes `count = 4096` (via the DEFAULTS resource, not the xml); we surface it as a "Points" slider for parity with the other attractor ports and to let slower machines dial it down. Noted as the only param beyond the xml.
- **AILUJ `jscale` quirk preserved:** the C sets `js = maxx/4` (not `maxy/4`) for AILUJ — likely a typo, but ported verbatim so the figure's aspect matches the original.
- **No erase transition:** the C's `MI_CLEARWINDOW` becomes an instant fill of the buffer to black (no wipes module).

## Config
Names/ranges mirror `hacks/config/discrete.xml`: `delay` (Frame rate, µs, live, inverted, 0–100000), `cycles` (Timeout — inner frames before clear + new map, live, 100–10000), `ncolors` (Number of colors, reinit, 1–255), plus `count` (Points — the only param **beyond** the xml UI: the stock GUI omits it and hardcodes `count = 4096` via DEFAULTS, but `--count`/`MI_COUNT` is a real read resource, so it's surfaced as a perf/quality knob; default 4096 = stock, so the default render is unchanged).

**Framerate calibration (`OVERHEAD = 6882`).** The `delay` default is now the **stock 20000 µs** (was a by-eye 50000). The structure is 1:1 (one `step()` = one `draw_discrete` = `INNER`=10 inner frames), so the stock delay is only a sleep floor — the live binary's effective tick rate is lower (delay + per-tick overhead). The `-fps` overlay measures **37.2 fps**, while the port at the bare stock delay ran 50 steps/sec (1.34× fast), so the loop runs at `delay + OVERHEAD = 26882 µs → 37.2 steps/sec`, matching the live binary. A calibration, not a tuning knob; the slider still maps 1:1 to the xml. (`delay` also governs the colour-walk and map-lifetime pace, so all three move together with it.) See [[framerate-calibration]], [[hopalong]], [[thornbird]], [[squiral]].
