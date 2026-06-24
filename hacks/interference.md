# interference — port notes

Port of `interference.c` by Hannu Mallat (1998; later perf/tuning passes by David Slimp and Dave Odell) — several decaying sinusoidal "wave" sources drift around the plane, their heights summed per pixel into an intensity field that indexes a cycling HSV colour loop. The classic plasma-interference shimmer.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/interference.c` (~1001 lines, mostly X11/threadpool plumbing).

## Algorithm
Each source is a radial ripple — a cosine whose amplitude decays linearly to zero at `radius`. The C precomputes that ripple **once** as a 1-D table `wave_height[]`, indexed not by raw distance but by a *compressed squared distance* (`FAST_TABLE`: small distances keep resolution `>>4`, large ones `>>9` past a 128px cutoff — a cheap sqrt-free lookup). Each frame:
1. Every source advances its two orbital phases (`x_theta`, `y_theta`) by `elapsed * speed / 1000`, then maps to a screen position `(w/2 + cos(θ)·w/2, h/2 + cos(θ)·h/2)` — a Lissajous sweep that spans the whole window.
2. For every grid cell (a `gridsize` block), the squared distance to each source is walked **incrementally** (`dist0 += px2g + ddist` per column — no per-pixel multiply), looked up in `wave_height[]`, and summed into an int accumulator.
3. The accumulated intensity is reduced mod `ncolors` and used to index the palette; the result is blitted as `gridsize × gridsize` blocks.

The palette is a **closed 3-anchor HSV loop** (`make_color_loop`): colour mode walks hue through `(hue, hue+shift, hue+2·shift)` at full S/V; gray mode walks value `1.0 → 0.5 → 0.0`. As the summed field scrolls through indices each frame, the image shimmers.

## Shared skeleton (inherited from [[squiral]])
Standalone ES module exporting `title`, `info`, and `start(canvas) → { stop, pause, resume, reinit, config, params }`; rAF **lag-accumulator** loop at fixed timestep in place of the C's `usleep(delay)`; `devicePixelRatio` folded into sizing; typed-array state. See [[binaryring]] for the Uint32-over-ImageData blit idiom this reuses, and [[greynetic]] for the canvas conventions.

## Rendering
This is the dense per-pixel path, O(cells × sources) per frame. To stay fast and stay faithful to the C's hard `g×g` blocks, the field is computed at **grid resolution** into an `Int32Array`, mapped through a `Uint32Array` palette into a small grid-sized `ImageData`, `putImageData`'d onto an offscreen canvas, then `drawImage`'d up to the full backing store with `imageSmoothingEnabled = false` — the GPU does the block expansion the C did by hand (`gridsize` therefore doubles as the internal-resolution / performance knob, exactly as in the original). The ripple table, palette, accumulator, and offscreen are all rebuilt only in `init()`.

## Deviations from the C
- **Faithful port.** The wave table (`FAST_TABLE` / `fast_inv_table` with `DISCARD_BITS1=4`, `DISCARD_BITS2=9`, `CUTOFF=128²`), the incremental squared-distance walk, the `result % ncolors` mapping, the orbital source motion, and the 3-anchor HSV colour loop all match the original. Verified `wave_height[0] = ncolors` decaying to 0 at the radius, and `FAST_TABLE(800²)` lands just past the table end (so far pixels are correctly skipped).
- **No threadpool.** The C splits rows across `hardware_concurrency()` worker threads; the JS does the single-threaded equivalent (one pass over the grid). Same output, no SMP.
- **`gridsize` folds in `devicePixelRatio`** (`g = round(gridsize · dpr)`) so a block is a consistent CSS size on retina; distances and `radius` are in device px so the table indices stay valid. The C's `xgwa > 2560 → scale 3.5` retina branch on `radius` is preserved.
- **Hue `0` means "random"** (the C rerolls `hue` while it is `< 0 || ≥ 360`; the xml's slider min is 0, so 0 is the natural "surprise me"). The resolved hue is held in state so `reinit` keeps it stable across non-palette changes.
- **Default `delay` 30000 µs** — the stock value (the slider maps 1:1 to the xml resource). The loop adds `OVERHEAD = 5842 µs` so `(delay + OVERHEAD)` reproduces the live binary's effective rate: measured against the live `-fps` overlay interference runs **27.9 fps**, while the port at the stock delay ran ~33 fps (1.2× fast); `30000 + 5842 = 35842 µs → 28 fps`. Source motion reads the real wall-clock elapsed, so OVERHEAD only paces the render cadence, not the wave speed. A calibration, not a tuning knob — see the framerate-calibration note. `count` defaults to 3 (xml min is 0, but the C clamps `count < 1 → 1`, so the param min is 1).
- **Encoding:** the only DOM-bound non-ASCII is the frame-rate unit, written `' µs'` (micro sign) per the project's ASCII-safe rule; every other non-ASCII byte in the file is an em dash in a comment.

## Correctness self-review
- **First frame is valid, not blank.** `init()` seeds source phases, calls `placeSources()`, then `render()` immediately — so frame 0 is already drawn before the rAF loop starts. A headless replay at 1920×1080/defaults: 67% of cells get wave coverage, max raw intensity 234 > 192 = `ncolors` (so the mod-wrap produces the banded rings), and all 192 palette indices are exercised — no degenerate/banded start.
- **Table indexing is guarded.** Every lookup is gated by `if (idx < tableLen)`, mirroring the C's `if (dist1 < c->radius)`; corner distances on a large screen (index ≫ `tableLen`) are simply skipped, so there is no out-of-range read.
- **No freeze / no runaway.** The loop is purely time-driven (no closure/termination condition to mis-fire); `MAX_CATCHUP_STEPS` is kept low (4) because each step is a full per-pixel pass, and `lag` is capped so a backgrounded tab can't queue a burst. `step()` reads real wall-clock `elapsed` for the source advance, so a long frame still moves the waves the right amount rather than stalling.
- **pause/resume** resets both `lastTime` (rAF clock) and `lastFrame` (animation clock) on resume, so the waves don't jump by the paused duration.
- **reinit** clears to black and rebuilds the table/palette/accumulator/sources — needed because `radius`, `gridsize`, `ncolors`, `shift`, `hue`, and `gray` all resize buffers or recolour, so they are `live: false`. `speed` and `delay` are `live: true` (read every step).

## Config
Units and defaults mirror `hacks/config/interference.xml`: `delay` (µs/frame, 30000, inverted "Frame rate" slider), `speed` (30), `radius` ("Wave size", 800), `count` ("Number of waves", 3), `gridsize` ("Magnification", 2), `ncolors` (192), `shift` ("Color contrast", 60), `hue` (0 = random), `gray` (off). `delay`/`speed` are live; the rest re-run `init()` via `reinit()`. See [[squiral]] for the config-box wiring (the `c` key / "config" link opens the panel).
