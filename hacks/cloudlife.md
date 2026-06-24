# cloudlife — port notes

Port of `cloudlife.c` by Don Marti (2003) — Conway's Life with two twists, rendered as drifting clouds.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/cloudlife.c` (~439 lines)

Shares squiral's skeleton (inline ES module, `config` object, rAF + lag-accumulator loop, dpr scaling) — see [`squiral.md`](squiral.md).

## Algorithm
Standard Life (B3/S23), but cells track an **age**, and a cell older than `maxAge` counts as **3** neighbours instead of 1 — so stable blobs destabilise and "explode" rather than burning a hole in the screen. The rendering is the signature feature: only a few random sub-pixels of each cell are painted per tick (live cells in the cycling color, dead cells in black), so cells fade in and out like clouds and gliders look like little comets. The field reseeds if the population nearly dies, and the borders get stirred periodically so it never stalls.

## Deviations from the C
- **Bit-board → `Uint8Array`** (storing age per cell).
- **`cellSize` is a direct pixel size (8), not the C's power-of-two exponent (3 → `1<<3`)** — the exponent only enabled a bit-trick to pull two random offsets from one `random()`; we just call `Math.random()` twice.
- **dpr handling**: `cellPx = cellSize × dpr`, and we scatter **`round(dpr²)` sub-pixels per tick** so the fade rate (fill-per-area, hence the cloud's softness in seconds) looks identical across displays.
- **Color: vivid full-saturation HSL rainbow**, deliberately replacing the C's `make_smooth_colormap` (softer, partly desaturated, sometimes near-monochrome). A stated aesthetic preference for the gallery.

## Optimizations
- **The big one — rendering.** It started as one `fillRect` per scattered sub-pixel (~100k+ calls/frame) and stuttered at ~0.25 s/frame, badly in Firefox. Switched to writing a packed-`uint32` `ImageData` buffer and doing a **single `putImageData` blit per tick** — which mirrors the original's batched `XDrawPoints`. Night-and-day difference.

## Faithful to the original
- Both Life twists (age tracking; over-age counts triple), the one-random-pixel-per-cell cloud/comet rendering, the **single** foreground color cycling (not per-cell), reseed-on-near-death, and the periodic edge stir.

## Config
`cellSize`, `density` (% alive when seeding), `maxAge`, `ncolors`, `cycleColors` (ticks per color step), `delay` (ms/tick; C default 25 — tuned slower to taste).
