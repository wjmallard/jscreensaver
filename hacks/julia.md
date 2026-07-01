# julia — port notes

A continuously varying **Julia set**: the complex parameter `c` walks a small orbit and the set is redrawn every frame so it smoothly morphs, leaving a short colour-cycling trail of recent sets. A small white ring marks the current `c` (the xml's "control point from which the rest of the image was generated").

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/julia.c` by Sean McCullough, 1995/1997 (~450 lines) + `config/julia.xml`.

## Algorithm
This is a **faithful port of the C's random-inverse-iteration method** — *not* a per-pixel escape-time renderer. For a parameter `c`, the inverse of `z -> z^2 + c` has two branches `w = +/- sqrt(z - c)`; iterating those branches from any seed converges onto the Julia set (an IFS / "chaos game" on the set).

Each `step()` is one `draw_julia()`:
1. **Burn-in** (`while (k--)`, the C's `draw_julia`): from `(xr, xi) = (0, 0)`, take 64 inverse-`sqrt` steps, randomly negating the branch each step, to land a seed on the set.
2. **Tree** (`apply()`, ported verbatim): from that seed, recurse on *both* inverse branches to depth `d`, writing `2^(d+1) - 1` screen points into the current buffer (`numpoints = (2 << depth) - 1`).
3. **Draw** the points as `scale x scale` rects in one `Path2D` fill (the C's `XFillRectangles`), in the next palette colour.
4. **Trail.** Points live in a ring of `nbuffers = cycles + 1` buffers; once the ring wraps, the oldest buffer is erased (black-filled) just before reuse — so the screen shows the last `cycles+1` sets, each in its own cycling colour, as `c` morphs.
5. **Marker.** `c` advances along the C's `incr()` Lissajous orbit; a white ring is drawn at the screen position of `z == c` and the previous ring is erased with a black disc — exactly the C's `c`-circle (`XFillArc` erase + `XDrawArc`).

The complex-to-screen map is the C's: `x = 0.5*xr*centerx + centerx`, `y = 0.5*xi*centery + centery`. Colour is the C's `UNIFORM_COLORS` scheme via [colormap.js](colormap.js) `makeUniformColormapRGB(ncolors)` (a uniform hue ramp at randomized high S/V), advanced one entry per frame. Skeleton/loop/conventions follow [[squiral]].

This replaces an earlier escape-time *reinvention* (the reason julia was shelved "pending perf"): porting the original method faithfully is both correct **and** ~15x cheaper — the per-frame work dropped from a full per-pixel escape-time field (~59% of one core at 820x560, capped at a 720px grid) to ~4% (a few thousand `fillRect`s). Same lesson as [[quasicrystal]] / [[strange]]: transcribe the real pipeline, don't approximate-and-tune. See [[shelved-perf-diagnosis]].

## Config
Mirrors `config/julia.xml` exactly: `delay` (Frame rate, µs, 10000, inverted), `count` (Count, 10–20000, 1000), `cycles` (Iterations, 1–100, 20), `ncolors` (Number of colors, 1–255, 200).
- **`count`** sets the tree depth `= min(count, 10)` (the C clamps `batchcount` to 10). The xml slider floors at 10, so depth is effectively always 10 (numpoints 2047) — as in the C; the knob is kept for fidelity to the original UI, not because it visibly changes the picture.
- **`cycles`** (the xml labels it "Iterations") is the **trail length**: the set is kept for `cycles+1` frames. More = a longer rainbow comet-tail of past sets.
- **`ncolors`** sizes the uniform-hue palette. `<= 2` gives mono **white** points, matching the C's `MI_NPIXELS(mi) > 2 ? MI_PIXEL : WHITE` branch.
- **`live: true`** — `delay` only. **`live: false`** — `count`, `cycles`, `ncolors` size buffers/palette, so a change re-runs `init()` via `reinit()`. `delay` uses `invert: true` (the xml's `convert="invert"`), shown as raw µs with the `µs` escape.

## Timing
Stock `*delay 10000`. `delay` is a sleep floor in the C; effective frame time also carries the per-frame compute, so the rAF loop paces at `(delay + OVERHEAD)/1000` ms. **`OVERHEAD` is calibrated against the live `-fps` overlay** (see [[framerate-calibration]]); set from the measured live fps as `round(1e6/fps) - delay`, never by eye.

## Deviations from the C
(Algorithm, palette and config are faithful. What remains are rendering-substrate differences.)
- **Point batching.** The C issues one `XFillRectangles` per buffer; the port builds one `Path2D` of the buffer's rects and `fill()`s it once (draw and black erase). Same pixels, fewer canvas calls.
- **Point size.** `scale = 1`, tripled to `3` past 2560 px (the C's retina accommodation), using the device-pixel canvas dimensions. On a small window points are a fine 1px dust, as in the live binary at the same size.
- **Expose/redraw machinery dropped.** The C's `redrawing`/`redrawpos` `REDRAWSTEP` loop repaints buffers after an X11 Expose event; a canvas never loses its contents, so it is omitted (the C leaves it off by default too — `redrawing = 0`).
- **RNG.** The burn-in's random branch and the initial colour/orbit seeds use `Math.random()` (the walk is stochastic; an exact LRAND sequence isn't visually meaningful here).

## Correctness self-review
- **Bounded work, terminates.** `apply()` recurses to a fixed depth (<= 10), writing exactly `numpoints` points; the burn-in is a fixed 64 steps. No unbounded loop, no growth over time (the ring buffer is fixed-size).
- **Trail erase is correct.** `erase` only turns on after the ring first wraps, so early buffers (not yet drawn) are never black-filled; thereafter the buffer about to be overwritten is the oldest on screen, so erasing it removes exactly the stalest set. The first painted frame is already a recognizable set for any seed.
- **`sqrt`/`atan2` domain.** The `xi == 0 && xr == 0` guard avoids the `atan2(0,0)` domain warning (the C's same guard); `r = sqrt(sqrt(...))` is always real and finite.
- **Pause/resume & reinit.** `rafId === 0` pause sentinel with `lastTime = 0` on resume (no catch-up burst); `reinit()` rebuilds palette/buffers, reseeds the orbit phase and colour index, and clears the canvas on non-live config changes. The rAF lag-accumulator caps catch-up at `MAX_CATCHUP_STEPS`.

**Spot-check in the browser:** confirm the set morphs smoothly from frame one, the white control ring tracks the changing shape, and each new set appears in the next palette colour leaving a short coloured trail; drag **Iterations** (longer/shorter trail) and **Number of colors** (reinit) and confirm a clean restart; **Count** is expected to look unchanged (depth pinned at 10).
