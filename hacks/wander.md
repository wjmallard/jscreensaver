# wander — port notes

Port of `wander.c` by Rick Campbell (1998) — a colourful biased random walk: one walker wanders the screen leaving a colour-cycled trail, occasionally jumping, until it has wandered enough, then the screen clears and it starts over.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/wander.c` (283 lines)

## Algorithm
A single walker lives on a grid (the canvas measured in `size`-blocks). The C does **2000 walk iterations per drawn frame**; each iteration:
- **Step or stay** — with probability `1/density` it takes a step, saving the current cell as `last` and adding a `{-1, 0, +1}` offset to each of x and y (the screen wraps); otherwise it reverts to `last` (so the walk is *thinned* by `density` but a point is still drawn every iteration). The `{-1,0,+1}` step is the C's `x += width_1 + NRAND(3)` followed by `while (x >= width) x -= width` — `width_1 = width-1`, so adding `width-1 + {0,1,2}` is a `{-1,0,+1}` move modulo width.
- **Colour advance** — with probability `1/length` it advances the trail colour: by `advance` steps through the palette, or to a random entry if `advance == 0`.
- **Reset** — with probability `1/reset` it wipes the screen and respawns at a fresh cell in a fresh colour.
- **Plot** — paints the current cell (a pixel for `size==1`, else a `size`×`size` square, or a filled disc when *Draw spots* is on).

The step / colour-advance / reset / plot ordering, the `NRAND(density)` step gating, and the post-reset state (re-randomised `colorValue` and position, `colorIndex` left to keep cycling) are transcribed verbatim from `wander_draw`.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — blit accumulation
2000 single-pixel (or small-block) draws per frame, accumulated over thousands of frames into a **persistent** `Uint32` ImageData buffer (the buffer is never cleared except on reset); one `putImageData` per frame. 2000 `fillRect`s per frame would be far too many draw calls. This is the same blit-accumulation path as `binaryring.js` / `thornbird.js` — see [[binaryring]], [[thornbird]].

## Palette (audit-corrected)
The C builds the colormap **once** at init with `make_color_loop(0,1,1 → 120,1,1 → 240,1,1, closed)` and **never rebuilds or cycles** it. Tracing `make_color_path` for these three anchors: all three edges have equal shortest-hue-distance (`DH = 1/3`), all `direction = +1`, and saturation/value are constant at 1, so the result is a **uniform full-saturation rainbow over the whole hue wheel** (red → yellow → green → cyan → blue → magenta → red), `MAXIMUM_COLOR_COUNT = 256` entries. The trail "cycles" only in the sense that `color_index` advances along this static palette as the walk progresses.

The port reproduces this byte-for-byte: three edges of `trunc(256/3) = 85` colours, each stepping hue by `120/85` deg from its anchor (0/120/240) at full saturation/value, with `colors[255]` padded from `colors[254]` (the round-off pad). `hsvToRgb` is ported from `utils/hsv.c` with the 16-bit→8-bit `>>8` downsample (`floor(c·256)`) matching `colormap.js`. Built once in `init()`.

> **Note — this corrects a prior flattening.** The previous port swept hue only `[0, 240/360)` (the red→blue two-thirds) and called that "faithful", which **dropped the entire blue→magenta→red third of the wheel** and broke the loop closure. The full wheel is now restored.

## Deviations from the C
- **Erase transition → instant clear.** The C calls `erase_window()` (an animated wipe) on reset and on a keypress. There is no X11 GC / erase machinery here, so `reset` clears the accumulation buffer to black **instantly** (and the host owns the wipe/transition layer). The keypress-triggered reset is dropped (the host owns keys).
- **`circles` / spots.** The C blits a precomputed filled-circle pixmap per point; here a disc's pixel offsets within a block are precomputed once (`buildStamp`) and stamped, which only matters when `size > 1`.
- **Descriptive names.** The C's `width_1`/`height_1`/`color`/`color_index`/`color_count` became `width1`/`height1`/`colorValue`/`colorIndex`/`ncolors` (a loop-local alias for `palette.length`).

## Retina / size (audit-corrected)
`size` is in **device pixels**, exactly as the C's `size` (X11 reports device px, and `canvas.width` is device px too), and — verbatim from the C — is tripled when the backing store exceeds **2560 px** in either dimension ("Retina displays"). It is **not** multiplied by `devicePixelRatio`: a prior port did `size *= devicePixelRatio` *and* the `>2560` ×3, which double-counted on large retina displays (e.g. size 6 instead of 3). At dpr 1 this change is a no-op; it only fixes hi-dpi. Caveat: on a small (< ~1280 CSS-px) retina window each dot is a single device pixel (sub-CSS-pixel thin) — but that is exactly what the native binary draws at that resolution.

## Config
Defaults/ranges/labels mirror `hacks/config/wander.xml` 1:1: `delay` (Frame rate, µs, 0–100000, default **20000** = stock, `invert`), `density` (Density, 1–30, `invert`), `reset` (Duration, 10000–3000000), `length` (Length, 100–100000), `advance` (Color contrast, **1**–100), `circles` (Draw spots), `size` (Size, 1–100). `delay`/`density`/`reset`/`length`/`advance` are **live** (read every iteration); `circles`/`size` resize the grid/stamp so they re-run `init()` via `reinit()` (which clears the canvas).

Audit-corrected config:
- **`ncolors` slider removed.** There is no `ncolors` resource in the .xml and the C hardcodes 256 colours (`MAXIMUM_COLOR_COUNT`), so the previously-exposed "Colors" slider was an invented control (and buggy — default 256 > max 255). The palette is now fixed at 256.
- **`advance` low = 1** (was 0), matching the .xml. The C's `advance == 0` random-colour mode is unreachable from the stock GUI (needs `-advance 0` on the command line); the branch is kept to match the C but the slider can't reach it.
- **`size` high = 100** (was 20), matching the .xml spinbutton range (rendered here as a slider).
- **`delay` default = 20000** (was 30000), restored to the stock value; the slider still lets it be slowed. The rAF loop adds a fixed **`OVERHEAD = 7027 µs`** so `(delay + OVERHEAD) = 27027 µs` reproduces the live binary's effective rate (the `-fps` overlay measures **37.0 fps**; the port at the bare stock delay ran ~50 steps/sec, 1.35× fast). A calibration, not a tuning knob — see [[framerate-calibration]].
- `showfps` in the .xml is the global FPS-overlay toggle, not a hack parameter — omitted.

## Correctness self-review
- **No freeze, no degenerate start.** `init()` seeds a random cell with `last == current` and plots one point, so frame 1 already shows the walker. `gw`/`gh` are floored at 1 and every divisor passed to `nrand` is floored (`density>=1`, `length>=1`, `reset>=100`), so no `NRAND(0)`.
- **Wrap is exact (integer).** The step uses the C's `while (x >= gw) x -= gw` against integer grid coords (the offset is `width1 + {0,1,2}`, always `>= 0`, so x never goes negative and a single `while` suffices even at the `x = gw-1, +2` corner). No float-equality anywhere.
- **Reset re-seeds everything it reads.** `resetWalk()` sets `colorValue`, `x`, `y`, `lastX`, `lastY` and refills the buffer, so the post-reset walk never reads a stale cell. `colorIndex` keeps cycling (matches the C, which also leaves `color_index` alone on reset and only re-randomises `color`).
- **`reset` probability is per-iteration**, so it fires within a frame, not only at frame boundaries — matching the C and keeping the wipe cadence independent of the rAF rate.
- **pause/resume / reinit.** `pause` cancels rAF (`rafId = 0` sentinel); `resume` resets `lastTime = 0` so there's no catch-up burst; `reinit` re-runs `init()` for a clean fresh screen. The catch-up cap (`MAX_CATCHUP_STEPS = 8`) bounds the loop even at `delay = 0`.
