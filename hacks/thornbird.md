# thornbird — port notes

Port of `thornbird.c` (Tim Auckland, 1997–2002), itself adapted from xlockmore's `discrete.c`. Removed from the XScreenSaver distribution as of version 6.05.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/thornbird.c` (~270 lines)

## Algorithm
A view of the **"Bird in a Thornbush"** strange attractor. The core is a 2D map iterated `count` times per frame:

```
j' = i
i' = (1 - c) * cos(PI * a * j) + c * b
b' = j
```

The two free parameters drift on slow Lissajous curves of the step counter — `a = 1.99 + 0.4·sin(inc/f1) + 0.05·cos(inc/f2)`, `c = 0.80 + 0.15·cos(inc/f1) + 0.05·sin(inc/f2)` (with random per-run frequencies `f1 ∈ [0,5000)`, `f2 ∈ [0,2000)`) — so the attractor continuously morphs. The resulting `(j, i, b)` triple is treated as a 3D point and projected to the screen through a slowly-tumbling viewpoint (two angles `theta`/`phi` advanced by small random per-step deltas), exactly as in the C.

Persistence comes from a **rolling ring buffer** of the last `cycles` frames: each step plots a fresh frame of `count` points and erases (paints black) the frame about to be overwritten next, so at steady state `cycles × count` points are lit and the figure leaves trails whose length is the buffer depth — that's the "Thickness" knob. The plot colour steps to the next entry of a **fixed random bright palette** every `1 + cycles/3` steps (jwz's "sooner" tweak, already the active branch in the C); the C reads the current colour *then* advances the index, so we match that order (the frame at the wrap step is drawn in the old colour).

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — Uint32 blit, accumulate (don't clear)
Thousands of points accumulate over time (`cycles × count`, e.g. 400 × 100 = 40k live points), far too many for per-point `fillRect`. So this uses the **blit path** like `binaryring.js`: a persistent `Uint32` `ImageData` buffer that `step()` writes/erases individual pixels into, blitted once per frame with `putImageData`. The buffer is never cleared between frames — points accumulate and the ring buffer's per-frame erase removes the oldest ones, mirroring the C's `XFillRectangles` draw + erase-oldest scheme. Each "point" is a `scale × scale` block (`scale` = 1, or 2 on retina), matching the C's `XRectangle` width/height. The ring buffer stores each frame's **raw `(x, y)` pairs** (an `Int32Array` of length `2·count`), and `plot()` clips per-pixel — so points that project off-screen simply draw nothing, exactly as the C stores raw `short`s and lets X clip the `XFillRectangles`. (An earlier port packed `y·W + x` into a single index, which forced off-screen points to be *clamped* onto the screen edges — a spurious bright border the C never shows. Fixed.)

## Variable-delay loop
Fixed `delay` per step (no phase pauses here), driven by the standard rAF lag-accumulator with an 8-step catch-up cap (identical pace at any refresh rate, no burst on tab refocus).

**Framerate calibration (`OVERHEAD = 14000`).** The stock `delay = 10000 µs` is only a sleep floor; the live binary's real rate is lower (delay + framework overhead — see the framerate-calibration note). Measured against the live `-fps` overlay the binary runs **41.7 fps** (Load 58% = delay-bound, a portable target), while the port at the stock delay ran **100 steps/sec** (2.4× fast). The loop adds `OVERHEAD` to the delay: `10000 + 14000 = 24000 µs → 41.7 steps/sec`, re-measured at **41.6** — matching the live binary. The `delay` slider still maps 1:1 to the xml resource.

## Palette — `make_random_colormap`, bright (audit fix 2026-06)
thornbird.c does `#define BRIGHT_COLORS`, so the xlockmore shim (`hacks/xlockmore.c`) builds its colormap with **`make_random_colormap(bright_p = True)`** (`utils/colors.c`), *not* a smooth ramp. That routine fills the 64-entry map with **independent random "bright" colours**: each entry is `hsv_to_rgb(H, S, V)` with `H = random()%360`, `S = (random()%70 + 30)/100` (30–99 %), `V = (random()%34 + 66)/100` (66–99 %). So as `pix` cycles, the colour **jumps to an unrelated bright colour** — there is no hue ordering. (Note: the sibling `discrete.c` uses `SMOOTH_COLORS`; thornbird does **not** — they differ.)

The previous port used a smooth full-saturation **HSL rainbow** swept by hue — wrong: wrong colour model (HSL vs HSV), wrong saturation/value ranges, and wrong *structure* (smooth sweep vs random scatter). Now ported faithfully via the shared **`makeRandomColormapRGB(ncolors, bright)`** in `colormap.js` (a transcription of `make_random_colormap` from `utils/colors.c`, reusing that module's `hsv_to_rgb` + 8-bit `to255`), built **once per run** (the C builds the colormap at startup and only rotates the index). Distribution-faithful via `Math.random` since the map is re-rolled each run. (The helper was added to `colormap.js` by the main session — the audit agent had inlined it because agents may not edit shared files; the main session promoted it so other `BRIGHT_COLORS` hacks can share it. Verified live: the bright-random scatter matches the binary.)

## Deviations from the C
- **Blit instead of `XFillRectangles`** (above): the ring buffer stores each frame's raw `(x, y)` pairs rather than `XRectangle`s, and `plot()` clips — off-screen points draw nothing, matching X clipping.
- **devicePixelRatio**: the backing store is sized in device px and `scale` follows the C's retina rule (`2` past 2560 px). `count`/`cycles` are absolute (not dpr-scaled). Logical projection math is unchanged. The projection centre uses integer `(W/2)|0` / `(H/2)|0` to match the C's `maxx/2` / `maxy/2` integer division.
- **`ncolors` is not a UI slider**: thornbird.xml exposes none (the hack hardcodes 64 via DEFAULTS). An earlier port invented an `ncolors` "Colors" slider; per the audit it's removed and 64 is a fixed internal constant. The `≤ 2 colours → white` branch is preserved (mirrors the C's `MI_NPIXELS > 2`) but is dead at the fixed count of 64.
- **Divide-by-zero guard**: the C computes `inc / f1` where `f1`/`f2` come from `LRAND() % 5000` / `% 2000` and can be 0 (giving `nan`/`inf`, a broken ~1/5000 run); we clamp each to a minimum of 1 so the drift is always well-defined. Deliberate robustness deviation; affects only the rare otherwise-broken run.
- **No erase transition**: the C's `MI_CLEARWINDOW` at init becomes an instant clear of the `ImageData` buffer to black. No wipes module is used.

## Config
Ranges mirror `hacks/config/thornbird.xml` 1:1: `delay` (Frame rate, µs, live, inverted), `count` (Points — iterations plotted per step, reinit), `cycles` (Thickness — trail/ring depth, reinit). `count` and `cycles` size the ring buffer, so changing either re-runs `init()` via `reinit()` (which clears the buffer). The xml's lower bound for `cycles` is 2 (a depth-1 ring can't erase), and we clamp to that. There is no `ncolors` control (the xml has none).
