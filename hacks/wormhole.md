# wormhole — port notes

Port of `wormhole.c` by Jon Rafkind (2004) — flying through a colored wormhole in space: short line-segment "stars" stream out of a drifting centre, accelerating and brightening as they rush past the camera, then recycle at the back of the tunnel. A classic hyperspace-streak look.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/wormhole.c` (~733 lines, much of it commented-out dead code; the live path is ~250 lines).

See [[squiral]] for the shared module skeleton; this port's motion model is closest to [[galaxy]] (moving particles, clear-and-redraw each frame) and [[grav]] (1/Z perspective projection + a one-time "paint the seeded scene before the first step" flag).

## Algorithm
Each *star* is a `starline` — a pair of endpoints (`begin`, `end`) that share one random angle on a small circle of radius `diameter` about the wormhole centre, and differ only in depth `Z` (`end` a few units deeper). So a star is a short **radial streak** pointing straight out from the centre.

Perspective is a fixed-point 1/Z projection (`calcStar`): for `Z > 0`, `calc = (offset << 10) / Z + centre`. As a star's `Z` is decremented by `zspeed` each step, its projected offset `(offset*1024)/Z` grows without bound — the streak slides outward from the centre, lengthens and (here) brightens, until `Z <= 0`, at which point the slot is freed and reused. `stars` new streaks are spawned every step (all at `Z = max_Z = 600`, the back of the tunnel), keeping the field full and rushing.

The centre itself drifts (`moveWormhole`): it moves along `ang` at `speed = width/180`, seeking a random `(want_x, want_y)` target; on arrival, on a random whim (`rnd(20)==rnd(20)`), or on hitting the `min_dist=100` edge margin it picks a new target (and clamps back inside). Occasionally (`rnd(500)==rnd(500)`) it enters a `spiral` for 50–80 steps, nudging `ang` by 1° every 5th step so the tunnel banks into a curve. `diameter` eases toward a periodically re-rolled target, so the mouth of the tunnel gently pulses.

Colour: depth picks a shade — `color = z * shade_use / max_Z` — within a 128-wide window that slowly drifts (`moveColorChanger` eases `min` toward a random target across a 2048-slot blended palette), so the whole field cycles hue over time.

Rendering (`drawWormhole`): fill black, then one `XDrawLine` per live star. Sparse (a few dozen to a few hundred segments on black), so per-line `strokeStyle` + `ctx.stroke()` is the right tool; a per-pixel `ImageData` blit would be pure waste here.

## Deviations from the C
- **Broken trig made faithful-by-equivalence.** The C's `Cos`/`Sine` compute `cos(a * 180/M_PI)` — i.e. they multiply *degrees* by `180/π ≈ 57.3` instead of `π/180`, so they are **not** a real degree→radian conversion; consecutive integer angles land at scrambled, effectively-random points on the circle. Since the spawn angle is already `rnd(360)` (uniform random), the net distribution is identical to "a uniform random point on the circle." I use proper radian trig (`Math.cos(ang*π/180)`), which yields the same visual without shipping a math bug. The C's misnamed helpers don't affect anything else (they're only ever called on the random spawn angle).
- **Colormap → HSL rainbow.** The C builds random `XColor` blends in a 2048-slot palette and walks a 128-wide window through it (the `color_changer`). There is no X11 colormap in the browser, so I collapse that to a hue ramp plus a drifting offset index (`shadeMin`/`shadeMinWant`, eased exactly like `moveColorChanger`). Per the project's house style I lean vivid (full-saturation `hsl`) over the original's muted random pastels.
- **Depth → lightness (brighten on approach).** The C's depth→colour is a shade gradient along the blended palette. I keep depth as the colour selector but also map it to **lightness** (Z: 600→0 ⇒ ~25%→70%), so near (fast) streak-ends read brightest — the "brighten as they approach" cue. Hue still comes from the drifting window.
- **`devicePixelRatio` scaling.** `diameter`, `min_dist`, `zspeed` and the line width are scaled by `S = devicePixelRatio` so the tunnel is the same physical size and speed on retina. `speed = width/180` is already in device px (the C's `SCREEN_X/180`). The `<<10` projection scale (`SHIFT = 1024`) is kept exactly — `offset` is in device px, so the projection needs no rescale.
- **Pre-seeded tunnel.** The C starts with an empty `stars` array (the centre fills in over the first ~30 frames). I pre-seed 64 stars at random depths in `init()` so frame 1 already shows a full wormhole instead of an empty middle.
- **`delay`** kept at the stock 10000 µs (already calm). Added an `ncolors` slider (palette size) since the stock UI exposes no colour control; the other three sliders (`delay`/`zspeed`/`stars`) map 1:1 to `wormhole.xml`.

## Correctness self-review
Ran a headless harness (stub canvas/`ctx`/`window`/rAF) driving 600+ steps, checking the failure modes the porter brief calls out:
- **Recycle / no runaway.** Live-star count stayed bounded (min ~80, max ~600 with `stars=20`, never into the thousands) — every star with `bZ<=0 || eZ<=0` is marked dead and its slot reused by the next `addStar` (the C's NULL-slot scan). Lifetime is `≈ max_Z / (zspeed*S)` steps, so the array self-limits. No leak, no endless growth.
- **No empty tunnel / no blank frame 1.** The pre-seed plus a `needsDraw` flag (set in `init()`, consumed on the first `frame()`) means frame 1 paints all 64 seeded streaks *before* any step runs — fixing a real bug found during review where `if (stepped) draw()` skipped the very first paint (and the first paint after resize/reinit), leaving the seeded tunnel invisible until a step happened.
- **No div-by-zero / non-finite coords.** `calcX` only divides by `Z` when `Z > 0` (recycled otherwise), so projected coords are always finite — harness confirmed zero non-finite stroke endpoints across frames. The `Z<=0` branch matches the C's degenerate fallback but is never actually drawn (those stars are already dead).
- **Streaks are radial.** Both endpoints share one `(x,y)` offset and one centre, differing only in `Z`, so they're collinear with the centre by construction (verified the convergence point drifts and streaks point outward from it).
- **`delay = 0` (max frame rate) can't freeze.** `MAX_CATCHUP_STEPS = 8` caps the catch-up loop even when `delayMs = 0`; harness ran a `delay=0` frame without spinning.
- **`pause`→`resume` doesn't jump.** `resume()` resets `lastTime = 0` so `lag` doesn't burst a backlog of steps; the canvas still holds the last frame during the pause, and the first resumed step fully clears+redraws. `reinit()` clears to black and re-seeds (harness: paints a fresh tunnel).

## Config
Units/defaults mirror `hacks/config/wormhole.xml`: `delay` (µs/step, 10000, `invert` "Frame rate" slider), `zspeed` (star speed, 10, range 1–30), `stars` (new streaks/step, 20, range 1–100). Added `ncolors` (palette size, 128) — not in the stock UI. `delay`/`zspeed`/`stars` are **live** (read every step); `ncolors` is **not live** (it sizes the palette, so a change re-runs `init()` via `reinit()`, which also clears the canvas).
