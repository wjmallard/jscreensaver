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

Persistence comes from a **rolling ring buffer** of the last `cycles` frames: each step plots a fresh frame of `count` points and erases (paints black) the frame about to be overwritten next, so at steady state `cycles × count` points are lit and the figure leaves trails whose length is the buffer depth — that's the "Thickness" knob. The plot colour advances through the rainbow every `1 + cycles/3` steps (jwz's "sooner" tweak, already the active branch in the C).

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — Uint32 blit, accumulate (don't clear)
Thousands of points accumulate over time (`cycles × count`, e.g. 400 × 100 = 40k live points), far too many for per-point `fillRect`. So this uses the **blit path** like `binaryring.js`: a persistent `Uint32` `ImageData` buffer that `step()` writes/erases individual pixels into, blitted once per frame with `putImageData`. The buffer is never cleared between frames — points accumulate and the ring buffer's per-frame erase removes the oldest ones, mirroring the C's `XFillRectangles` draw + erase-oldest scheme. Each "point" is a `scale × scale` block (`scale` = 1, or 2 on retina), matching the C's `XRectangle` width/height.

## Variable-delay loop
Fixed `delay` per step (no phase pauses here), driven by the standard rAF lag-accumulator with an 8-step catch-up cap (identical pace at any refresh rate, no burst on tab refocus).

## Deviations from the C
- **Blit instead of `XFillRectangles`** (above): the ring buffer stores each frame's *pixel indices* (`y·W + x`) rather than `XRectangle`s, which is all that's needed to erase those exact pixels later.
- **devicePixelRatio**: the backing store is sized in device px and `scale` follows the C's retina rule (`2` past 2560 px). Logical projection math is unchanged.
- **Colour**: the C walks an X colormap (`MI_NPIXELS`/`ncolors`); we build a `ncolors`-entry HSL rainbow and cycle the index on the same `1 + cycles/3` schedule. With ≤ 2 colours it falls back to white, as the C does. `ncolors` isn't in the stock thornbird UI (it hardcodes 64) — exposed here for parity with the other ports.
- **Divide-by-zero guard**: the C computes `inc / f1` where `f1`/`f2` come from `LRAND() % 5000` / `% 2000` and can be 0 (giving `inf`/`nan` early on); we clamp each to a minimum of 1 so the drift is well-defined from the first frame.
- **No erase transition**: the C's `MI_CLEARWINDOW` at init becomes an instant clear of the `ImageData` buffer to black. No wipes module is used.

## Config
Ranges mirror `hacks/config/thornbird.xml`: `delay` (Frame rate, µs, live, inverted), `count` (Points — iterations plotted per step, reinit), `cycles` (Thickness — trail/ring depth, reinit), plus `ncolors` (Colors — added for parity, reinit). `count`, `cycles`, and `ncolors` size the ring buffer / palette, so changing any of them re-runs `init()` via `reinit()` (which clears the buffer). The xml's lower bound for `cycles` is 2 (a depth-1 ring can't erase), and we clamp to that.
