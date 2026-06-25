# binaryhorizon — port notes

Port of `binaryhorizon.c` by Patrick Leiser (2020-2021) — a fork of `binaryring.c` (Emilio Del Tessandoro), itself after J. Tarbell's "Binary Ring" (complexification.net, 2004). A "horizon" variant of Binary Ring: path-tracing particles emit along a horizontal line, fan downward, and accumulate soft alpha trails that alternately build up and erase.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/binaryhorizon.c` (~623 lines)

## Algorithm
Particles are emitted along a horizon — the i-th of N at `x = width * i/N` (so they span the whole width) on the centre row, each handed an initial direction `PI*i/N` so `vy = 2·sin(dir) >= 0` and they all drift **downward**, fanning out (`vx = 2·cos(dir)` runs +2 → -2). Each step the velocity is nudged by a random `curliness`, and the segment just travelled is drawn — **mirrored left/right** about the centre — as a low-alpha (0.15) **antialiased** (Xiaolin Wu) line, alpha-accumulated into a persistent pixel buffer (read-blend-write). At `max_age` (400) a particle dies and is reborn at `x = width·sin(rand)`, `y = lineHeight` — the drifting **horizon line**.

An **epoch** flips occasionally (≈0.25%/frame) between **light** (`colors[1]`, which random-walks) and **dark** (`colors[0]`, black — unless `bicolor`, then it also drifts). On each flip a new `lineHeight` is chosen: `-abs(rand·height/2)` lands it in the **upper** half for the dark epoch; the sign flips for the light epoch, dropping it into the **lower** half. So the rebirth horizon migrates up/down as the field alternately fills and clears. Every `duration` seconds (jittered +0..30%) the whole thing fully resets: black buffer, white epoch, fresh horizon.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. Built directly on the `binaryring.js` skeleton (same blend/draw idiom).

## Rendering — blit, despite being line-based
Thousands of tiny segments per frame, each **alpha-accumulated** into a persistent `Uint32` ImageData buffer (per-pixel composite, not vector strokes — which would be ~10k draw calls/frame). One `putImageData` per frame. Same documented exception as `binaryring`/`thornbird`.

## Deviations from the C
- **Antialiased lines kept** (the C's `ANTIALIAS=1`, its stock default), unlike `binaryring.js` which took the simpler Bresenham `ANTIALIAS=0` path. The Wu routine and its **hard clip** are ported faithfully: if *any* endpoint is off-screen the whole line is skipped — that clip is what keeps off-screen particles from drawing, so dropping it would change the look, hence it's preserved verbatim.
- **Physics scaled by `devicePixelRatio`** (`S`): initial velocity `2·S`, per-step nudge `curliness·S`, so the motion looks the same on retina. Emission/rebirth x-coords use the device-px `width` directly (as the C uses `st->width`), so they already scale.
- **`max_age` is a constant (400)**, not a slider — the stock hack reads it from a resource with no xml UI, so there's no knob for it (matches xml).
- **`duration` timed off `performance.now()`** (ms) instead of `time()` (whole seconds). Same behaviour, finer resolution; the +0..30% jitter is preserved.
- **Units**: `delay` is the xml's `--growth-delay` in µs; default lowered to 14000 (stock 10000) for a calmer pace. `particles` default 4000 (stock 5000). Keypress colour-flip dropped (the host owns keys).
- **Colour fidelity**: the C packs pixels for 15/16/24/32-bit visuals; the web is always 24-bit RGBA, so only the 24/32-bit lerp path is ported (the `point2rgb`/`rgb2point` depth switch collapses to a direct ABGR blend).

## Correctness self-review (no freeze / no runaway over-draw)
- **Termination / closure**: there is no closure test (the C has none either) — particles loop forever, dying and reborn at `age > max_age`. Every rebirth branch re-seeds **everything the next `move()` reads**: position, `xx/yy`, `vx/vy = 0`, `age = 0`, and the colour from the current epoch. No stale state, so no "dead" particles.
- **No off-screen degenerate start**: emission spans the visible width on the centre row with downward velocity, so the first frame already draws on-screen. Until the first epoch flip, `lineHeight = 0`, so early rebirths land on the centre row (intended — matches the calloc'd C state).
- **Erase / build balance**: the field is bounded two ways — the dark epoch lerps pixels toward black (erasing), and the `duration` timer hard-resets the buffer — so it can't saturate to a permanent white wash over a long run.
- **Antialiased line guards**: the hard clip rejects out-of-range lines before any pixel math, and the zero-length `gradient` is guarded (`den === 0 ? 0`), so no divide-by-zero and no out-of-bounds index. `plot()` bounds-checks again. The Wu inner loop runs `xpxl1+1 .. xpxl2-1`, which is empty (not negative) for short segments — no infinite loop.
- **Loop bound**: standard rAF lag-accumulator with `MAX_CATCHUP_STEPS = 8` and `lag` capped, so a backgrounded tab can't fire a burst; `pause()` then `resume()` resets `lastTime = 0` to avoid a catch-up jump.

## Config
`delay` (Frame rate, live) · `particles` (reinit) · `duration` (Reset every, live) · `curliness` (live) · `color`, `bicolor`, `fade` (all live checkboxes). Ranges/labels transcribed from `hacks/config/binaryhorizon.xml`. `fade` off = each new colour is a fully random RGB instead of a small random walk; `bicolor` on = the dark epoch also tints (two contrasting colours) instead of pure black.

## Things to spot-check in the browser
- The migrating horizon band: confirm reborn particles visibly cluster into the upper half (dark epoch) vs lower half (light epoch) as epochs flip, rather than always at centre.
- That the antialiased trails look soft (not blocky) and that the field both **builds and erases** over ~30 s, with a clean full reset on the `duration` timer.
