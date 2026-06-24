# binaryring — port notes

Port of `binaryring.c` (Emilio Del Tessandoro, 2006–2014), after J. Tarbell's "Binary Ring" (complexification.net, 2004).

Original: <https://www.jwz.org/xscreensaver/> · source: `binaryring.c` (~576 lines)

## Algorithm
Particles emitted around a ring at the centre drift through a flow field: each step the velocity is nudged by a random `curliness`, and the segment just travelled is drawn — **mirrored left/right** — as a low-alpha (0.15) line. Particles die at `maxAge` and are reborn on the ring. An "epoch" flips occasionally between **light** (the colour slowly random-walks) and **dark** (black), so the accumulated image alternately builds up and erases.

## Module shape
`start(canvas) -> { stop, reinit, config, params }` — see `squiral.md`.

## Rendering — blit, despite being line-based
Thousands of tiny segments per frame, each **alpha-accumulated** into a persistent `Uint32` buffer (read-blend-write per pixel) — i.e. per-pixel compositing, not vector strokes (which would be ~10k draw calls/frame, far too slow). A Bresenham raster + manual lerp-blend does it; one `putImageData` per frame. This is the **documented exception** to "use vector ops for line/arc/curve" — it's only an exception because the work is per-pixel accumulation, not stroking.

## Deviations from the C
- Non-antialiased Bresenham (the C's `ANTIALIAS=0` path) — simpler, and the 0.15 alpha accumulation softens it anyway.
- Physics scaled by `devicePixelRatio` so the ring + motion look the same on retina.
- **Units**: `delay` ms (orig 10); `particles` default 4000 (orig 5000). Keypress colour-flip dropped (host owns keys).

## Config
`delay` (Frame rate, live) · `particles` (reinit) · `ringRadius`, `maxAge` (Path length), `curliness`, `color` — all live.
