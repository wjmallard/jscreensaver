# wormhole — port notes

Port of `wormhole.c` by Jon Rafkind (2004) — flying through a colored wormhole in space: short line-segment "stars" stream out of a drifting centre, accelerating as they rush past the camera, then get freed at the camera while new ones spawn at the back of the tunnel. A classic hyperspace-streak look.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/wormhole.c` (~733 lines, much of it commented-out dead code; the live path is ~250 lines).

See [[squiral]] for the shared module skeleton; this port's motion model is closest to [[galaxy]] (moving particles, clear-and-redraw each frame) and [[grav]] (1/Z perspective projection).

## Algorithm
Each *star* is a `starline` — a pair of endpoints (`begin`, `end`) that share one random angle on a small circle of radius `diameter` about the wormhole centre, and differ only in depth `Z` (`end` a few units deeper: `max_Z + rnd(6)+4` vs `max_Z = 600`). So a star is a short **radial streak** pointing straight out from the centre frozen into it at birth.

Perspective is a fixed-point 1/Z projection (`calcStar`): for `Z > 0`, `calc = (offset << 10) / Z + centre`. As a star's `Z` is decremented by `zspeed` each step, its projected offset grows without bound — the streak slides outward from the centre and lengthens until `Z <= 0`, at which point the slot is freed and reused (`moveStar`). `stars` new streaks are spawned every step, keeping the field full (~`stars * max_Z/zspeed` ≈ 1200 live at the defaults). `zspeed` is a unitless depth decrement — star lifetime is `max_Z/zspeed` steps at any resolution.

**The scrambled trig is the wander.** The C's `Cos`/`Sine` helpers compute `cos(a * 180/M_PI)` — degrees multiplied by ~57.3 instead of ~0.0175 — so consecutive integer angles land at effectively random points on the circle. For star spawns this is harmless (a uniform random angle in ⇒ a uniform-ish random direction out), but the **centre drift uses the same helpers**: `moveWormhole` aims `ang` at a random target with `gang()` (real degree math), then travels along `Cos(ang)/Sine(ang)` — a scrambled, pseudo-random direction that has nothing to do with the aim. The visible behaviour is straight runs in random directions at `speed = width/180`, retargeted on edge clamps (`min_dist = 100` margin), near-arrivals (< 20 px), and 1-in-20-per-step whims. Occasionally (`rnd(500)==rnd(500)`) it enters a `spiral` for 50–80 steps: `ang` bumps by 1 every 5th step — through the scrambled trig that's a ~57° direction jump, a drunken stagger, **and the edge clamps are skipped**, so the centre can wander off-screen and back. All transcribed verbatim, including `gang()`'s `(int)(0.5 + atan2(...))` truncation-toward-zero.

`diameter` eases ±1/step toward a target re-rolled occasionally (`rnd(35)+5`), so the mouth of the tunnel gently pulses.

**Colour** (`initColorChanger`): a 2048-slot palette of 16 chained 128-wide **linear RGB blends** between random endpoints whose 16-bit channels are `rnd(50000)+10000` — mid-brightness, never black and never fully saturated (muted pastels/mids, ≈ 39..234 in 8-bit). Built **once per session**; the C's reshape keeps it too. A 128-wide window (`min`) drifts one slot per step toward a random target in `[0, 1920)` (`moveColorChanger`, re-rolled on arrival), and each streak is coloured by depth *through the window*: `color = begin.Z * shade_use / max_Z`, i.e. `shade[min + z*128/600]` — near ends read the window start, far ends the window end (a fresh spawn at z=600 reads one slot past the window, exactly as the C's index arithmetic does; max index 1919+128 = 2047, in bounds). There is **no** brightness-by-depth ramp and no hue-wheel — the depth gradient is whatever the random blend chain contains there.

Rendering (`drawWormhole`): fill black, then one `XDrawLine` per live star, every frame. Sparse (~1200 segments on black), so per-line `strokeStyle` + `ctx.stroke()` is the right tool; a per-pixel `ImageData` blit would be pure waste. Line width: the C uses the default thin line, switching to width 3 + round caps on windows over 2560 px — mirrored.

## Deviations from the C
- **16-bit → 8-bit colour.** `XAllocColor` channels are 16-bit; CSS wants 8. Converted with `>> 8` at palette-build time (the palette is 2048 precomputed CSS strings).
- **`devicePixelRatio` scaling.** `diameter` (at spawn), `min_dist`, the 20 px arrival radius and the 25 px initial-target margin are scaled by `S = devicePixelRatio` so the tunnel has the same physical size on retina. `speed = width/180` uses the device width (same physical speed). `zspeed` and `max_Z` are **not** scaled — they're depth units, and scaling them would halve star lifetime/density on retina.
- **`center == 0` spawn.** `calcStar` zeroes `Z` when a frozen centre coordinate is exactly 0 (reachable during off-screen spirals); in the C such a star is drawn once with uninitialized (malloc-garbage) coordinates, then freed on the next move. The port marks it dead at spawn instead of reproducing the UB — same population dynamics, no garbage line.
- **Resize.** The C's reshape keeps all state (stars, centre, palette). The port re-seeds the geometry on resize (house pattern — the canvas backing store is recreated anyway) but keeps the session palette, matching the C's colormap lifetime. `reinit()` (config-box restart) re-rolls the palette too, like a fresh session.
- **Pacing.** Stock `delay = 10000` µs paced as `(delay + OVERHEAD)` in a rAF lag-accumulator; `OVERHEAD = 9000` µs is live-measured via the binary's `-fps` overlay: 52.7 fps at Load 47.3% — a clean reading, the sleep slice `18975·(1−0.473) = 10000` equals the stock delay exactly.

## Correctness self-review
- **Recycle / no runaway.** Stars are freed on `bZ <= 0 || eZ <= 0` and their slots reused by the next `addStar` (the C's NULL-slot scan); the array self-limits at ~`stars * max_Z/zspeed`.
- **Startup matches the C.** The star array starts empty; the tunnel pours out of the centre over the first `max_Z/zspeed` (~60) steps, as in the original.
- **No div-by-zero.** `calcX` only divides by `Z` when `Z > 0`; the `Z <= 0` fallback (divide by centre) is never drawn since such stars are already dead, and centre-zero spawns die at birth.
- **`delay = 0` can't freeze.** `MAX_CATCHUP_STEPS = 8` caps the catch-up loop.
- **`pause` → `resume` doesn't jump.** `resume()` resets `lastTime` so `lag` doesn't burst a backlog of steps.

## Config
Exactly the three stock `wormhole.xml` resources, same defaults/ranges/units: `delay` (µs/step, 10000, `invert` "Frame rate" slider, 0–100000), `zspeed` (star speed, 10, 1–30), `stars` (new streaks/step, 20, 1–100). All live. (A previous revision added an `ncolors` slider and defaulted `delay` to 50000 — both invented; dropped in the fidelity audit.)
