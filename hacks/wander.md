# wander — port notes

Port of `wander.c` by Rick Campbell (1998) — a colourful biased random walk: one walker wanders the screen leaving a colour-cycled trail, occasionally jumping, until it has wandered enough, then the screen clears and it starts over.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/wander.c` (283 lines)

## Algorithm
A single walker lives on a grid (the canvas measured in `size`-blocks). The C does **2000 walk iterations per drawn frame**; each iteration:
- **Step or stay** — with probability `1/density` it takes a step, saving the current cell as `last` and adding a `{-1, 0, +1}` offset to each of x and y (the screen wraps); otherwise it reverts to `last` (so the walk is *thinned* by `density` but a point is still drawn every iteration). The `{-1,0,+1}` step is the C's `x += width_1 + NRAND(3)` followed by `while (x >= width) x -= width` — `width_1 = width-1`, so adding `width-1 + {0,1,2}` is a `{-1,0,+1}` move modulo width.
- **Colour advance** — with probability `1/length` it advances the trail colour: by `advance` steps through the palette, or to a random entry if `advance == 0`.
- **Reset** — with probability `1/reset` it wipes the screen and respawns at a fresh cell in a fresh colour.
- **Plot** — paints the current cell (a pixel for `size==1`, else a `size`×`size` square, or a filled disc when *Draw spots* is on).

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — blit accumulation
2000 single-pixel (or small-block) draws per frame, accumulated over thousands of frames into a **persistent** `Uint32` ImageData buffer (the buffer is never cleared except on reset); one `putImageData` per frame. 2000 `fillRect`s per frame would be far too many draw calls. This is the same blit-accumulation path as `binaryring.js` / `thornbird.js` — see [[binaryring]], [[thornbird]].

## Deviations from the C
- **Erase transition → instant clear.** The C calls `erase_window()` (an animated wipe) both on reset and on a keypress. There is no X11 GC / erase machinery here, so `reset` clears the accumulation buffer to black **instantly** (and the host owns the wipe/transition layer). Documented per the brief.
- **Colour loop.** The C's `make_color_loop(0,1,1 → 120,1,1 → 240,1,1)` is a full-saturation hue sweep over the red→green→blue two-thirds of the wheel; reproduced as an `hsl(h,100%,50%)` rainbow with `h` spanning `[0, 240/360)`. `ncolors` defaults to the C's 256 and is exposed as a knob (the stock UI hardcodes it).
- **`circles` / spots.** The C blits a precomputed filled-circle pixmap per point; here a disc's pixel offsets within a block are precomputed once (`buildStamp`) and stamped, which only matters when `size > 1`.
- **Retina sizing.** `size` is multiplied by `devicePixelRatio`, and (matching the C) tripled when the backing store exceeds 2560 px, so blocks look the same on retina.
- **Calmer default delay.** `delay` defaults to **30000 µs** vs the stock 20000 — a touch calmer by feel (the walk is dense at 2000 iters/frame). Keypress-triggered reset is dropped (the host owns keys).
- **Descriptive names.** The C's `width_1`/`height_1`/`color`/`color_index` became `width1`/`height1`/`colorValue`/`colorIndex`; `length`/`reset` are read as `lengthLimit`/`resetLimit` in the loop.

## Config
Units/ranges/labels mirror `hacks/config/wander.xml`: `delay` (Frame rate, µs, `invert`), `density` (Density, `invert` so drag-right = denser/slower-stepping), `reset` (Duration, short→long), `length` (Length, short→long), `advance` (Color contrast), `circles` (Draw spots), `size` (Size), plus `ncolors` (Colors) for parity. `delay`/`density`/`reset`/`length`/`advance` are **live** (read every iteration); `circles`/`size`/`ncolors` resize the grid/stamp/palette so they re-run `init()` via `reinit()` (which clears the canvas).

## Correctness self-review
- **No freeze, no degenerate start.** `init()` seeds a random cell with `last == current` and plots one point, so frame 1 already shows the walker. `gw`/`gh` are floored at 1 and every divisor passed to `nrand` is floored (`density>=1`, `length>=1`, `reset>=100`, `ncolors>=1`), so no `NRAND(0)` and no division surprises.
- **Wrap is exact (integer).** The step uses the C's `while (x >= gw) x -= gw` against integer grid coords (the offset is `width1 + {0,1,2}`, always `>= 0`, so x never goes negative and a single `while` suffices even at the `x = gw-1, +2` corner). No float-equality anywhere.
- **Reset re-seeds everything it reads.** `resetWalk()` sets `colorValue`, `x`, `y`, `lastX`, `lastY` and refills the buffer, so the post-reset walk never reads a stale cell. `colorIndex` keeps cycling (matches the C, which also leaves `color_index` alone on reset and only re-randomises `color`).
- **`reset` probability is per-iteration**, so it fires within a frame, not only at frame boundaries — matching the C and keeping the wipe cadence independent of the rAF rate.
- **pause/resume / reinit.** `pause` cancels rAF (`rafId = 0` sentinel); `resume` resets `lastTime = 0` so there's no catch-up burst; `reinit` re-runs `init()` for a clean fresh screen. The catch-up cap (`MAX_CATCHUP_STEPS = 8`) bounds the loop even at `delay = 0`.
