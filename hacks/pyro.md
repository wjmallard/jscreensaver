# pyro — port notes

Port of `pyro.c` (Jamie Zawinski, 1992; algorithm inspired by TI Explorer Lisp code by John S. Pezaris) — exploding fireworks.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/pyro.c` (~373 lines)

## Algorithm
Two kinds of projectile share one fixed-size pool:

- **Primary rockets** launch from the bottom edge at a random x, with an upward `dy` and a sideways `dx` picked (via a reject loop) so the arc stays on screen. Each rocket carries a burning `fuse` countdown and a random hue. Gravity is applied every step as `dy += size >> 6` — proportional to the projectile's size — so heavier sparks fall faster.
- When a rocket's fuse hits 0 it **bursts**: it spawns `rand(scatter) + scatter/2` **shrapnel** sparks at its current position, each with velocity `= cache[v] + parent_velocity`. The shrapnel inherit the rocket's hue, start at 2/3 the parent size, and carry a negative `decay` (`rand%50 − 60`) that shrinks them a little each step until they wink out.

The burst velocities come from a precomputed `sin_cache`/`cos_cache` of length `PI_2000` (6284). The C calls this distribution "slightly whacked, for better explosions": each cache entry is a unit vector at angle `i/1000` rad scaled by a randomised radius `dA` — a `sin()` of a random angle plus a small `asin(frand)` term that fattens the spread toward a sphere — times 2500. A spark indexes the cache at random, so a single burst draws from many radii and angles, giving the irregular, rounded firework shape rather than a perfect ring. A new rocket launches whenever `rand(frequency) == 0`.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — sparse vector ops, full repaint
At any instant only a few hundred small sparks are lit, so this draws with **canvas vector ops** — `fillRect` for sparks under 4 px (point/tiny square, matching the C's `XDrawPoint`/small `XFillRectangle`), `arc`+`fill` for bigger ones (the C's `XFillArc`) — not a per-pixel blit. Each frame **clears to black and redraws every live spark**, the same full-repaint strategy as boxfit. The C instead erases each projectile's *previous* rectangle every step (`XFillRectangle` in the erase GC) and draws only the new one; a full repaint on the double-buffered canvas reproduces the identical look — hard sparks on black, no motion trails — without the erase-around bookkeeping or the C's pixel-sort optimisation (which only existed to minimise GC colour changes on X11).

## Fixed-point arithmetic (kept verbatim)
The C runs the whole simulation in integer fixed point and the port mirrors it exactly so the motion matches:
- Position / size / velocity are stored scaled up and read back with `>> 10` (÷1024) for screen coordinates (`FP = 10`).
- `launch()` actually seeds positions in a `width*1000` space (not ×1024) but everything is still read `>> 10`, and the on-screen bound is the raw pixel extent — a small internal scale mismatch in the original. The port keeps this quirk rather than "tidying" the two scales, so trajectories land where the C's do.
- Gravity `dy += size >> 6`, the fuse formula, the burst count `rand(scatter) + scatter/2`, and the `size < 4` draw thresholds are all transcribed unchanged.

## Deviations from the C
- **Full repaint** instead of incremental draw + per-projectile erase (above). The C's `sorted_projectiles` / `sort_by_pixel` pixel-sorting is dropped — it only reduced X11 GC colour switches and has no analogue on canvas.
- **devicePixelRatio**: the backing store is sized in device px, and the launch velocities (`dx`, `dy`), the initial `size` (8000), the shrapnel `decay`, and the burst-velocity cache are all scaled by dpr. Because size and decay scale together, a spark's lifetime *in steps* is dpr-independent, and a burst covers the same fraction of the screen (and rises to the same apparent height) on retina as on 1×.
- **Free-list → pool scan**: the C threads a `next_free` linked list through the projectile array; the port keeps the same fixed pool but just scans for a `dead` slot. Same capacity, same "drop the spark when the pool is full" behaviour. The burst-then-free ordering is preserved (a rocket that bursts this step is also marked dead this step, so it bursts exactly once; a freed slot may be immediately reused by its own shrapnel, which is safe because each field read precedes its write).
- **Colour**: primary rockets burn **white** (the launch streak), exactly as the C draws primaries with the foreground pixel; shrapnel wear their hue as vivid `hsl(h, 100%, 60%)` (the gallery's saturated-rainbow convention) rather than the original's allocated XColor. `mono_p` mode (everything white) isn't ported.
- **No `XClearWindow`/colormap plumbing**: irrelevant on canvas.

## Config
Ranges/defaults/labels mirror `hacks/config/pyro.xml`:
- `delay` — **Frame rate** (µs/step, default 10000, `live`, inverted: drag right = faster).
- `count` — **Particle density** (size of the projectile pool, 10–2000, default 600, `reinit` — it sizes the pool).
- `frequency` — **Launch frequency** (launch when `rand(frequency)==0`, 1–100, default 30, `live`, inverted: lower = more often, so the slider reads "seldom → often").
- `scatter` — **Explosive yield** (shrapnel per burst, 1–400, default 100, `live`).

The xml's `showfps` boolean is host chrome (frame-rate overlay), not a hack parameter, so it isn't ported. `r` (restart) and the non-live `count` change re-seed via `reinit()`.
