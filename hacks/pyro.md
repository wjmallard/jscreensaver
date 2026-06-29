# pyro — port notes

Port of `pyro.c` (Jamie Zawinski, 1992; algorithm inspired by TI Explorer Lisp code by John S. Pezaris) — exploding fireworks.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/pyro.c` (~373 lines)

## Algorithm
Two kinds of projectile share one fixed-size pool:

- **Primary rockets** launch from the bottom edge at a random x, with an upward `dy` and a sideways `dx` picked (via a reject loop) so the arc stays on screen. Each rocket carries a burning `fuse` countdown and a random hue, and a constant `size` of 8000 (it never decays). Gravity is applied every step as `dy += size >> 6` — proportional to the projectile's size — so heavier sparks fall faster.
- When a rocket's fuse hits 0 it **bursts**: it spawns `rand(scatter) + scatter/2` **shrapnel** sparks at its current position, each with velocity `= cache[v] + parent_velocity`. The shrapnel inherit the rocket's hue and carry a negative `decay` (`rand%50 − 60`) that shrinks them a little each step until they wink out.

The burst velocities come from a precomputed `sin_cache`/`cos_cache` of length `PI_2000` (6284). The C calls this distribution "slightly whacked, for better explosions": each cache entry is a unit vector at angle `i/1000` rad scaled by a randomised radius `dA` — a `sin()` of a random angle plus a small `asin(frand)` term that fattens the spread toward a sphere — times 2500. A spark indexes the cache at random, so a single burst draws from many radii and angles, giving the irregular, rounded firework shape rather than a perfect ring. A new rocket launches whenever `rand(frequency) == 0`. The cache is built once at startup, like the C.

### The free-list burst aliasing (this is load-bearing)
The C stores projectiles in a fixed array threaded onto a LIFO free list (`next_free`). The burst sequence is: the bursting primary is **freed** (its slot goes to the list head), and only *then* does the shrapnel loop run. So the **first** shrapnel re-allocates the parent's *own* slot — `shrapnel(parent)` is called with `parent` pointing at a struct that `get_projectile` just handed back as the new spark. Because each field is read before it is written, the first spark still gets the true parent velocity and `size = (parent*2)/3`, **but it overwrites the parent slot in the process.** Every subsequent spark in that burst therefore reads the *first spark* as its "parent":

- spark #1: `size = (8000*2)/3 = 5333`, `vel = cache[v1] + rocket_vel`
- sparks #2..j: `size = (5333*2)/3 = 3555` (= 4/9 of the rocket), `vel = cache[vk] + cache[v1] + rocket_vel`

Two visible consequences fall out of this aliasing: most sparks start ~33% smaller (3555 vs 5333 → mostly 3-px squares rather than 5-px discs after the `>>10` read), and the whole cloud (every spark but #1) is **velocity-offset by `cache[v1]`**, so bursts drift off-centre and look lopsided rather than perfectly radial. This is not a polish detail — it is the explosion's character, and it is reproduced exactly (see Deviations).

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — sparse vector ops, full repaint
At any instant only a few hundred small sparks are lit, so this draws with **canvas vector ops** — `fillRect` for sparks under 4 px (point/tiny square, matching the C's `XDrawPoint`/small `XFillRectangle`), `arc`+`fill` for bigger ones (the C's `XFillArc`) — not a per-pixel blit. Each frame **clears to black and redraws every live spark**, the same full-repaint strategy as boxfit. The C instead erases each projectile's *previous* rectangle every step (`XFillRectangle` in the erase GC) and draws only the new one; a full repaint on the double-buffered canvas reproduces the identical look — hard sparks on black, no motion trails — without the erase-around bookkeeping or the C's pixel-sort optimisation (which only existed to minimise GC colour changes on X11).

## Fixed-point arithmetic (kept verbatim)
The C runs the whole simulation in integer fixed point and the port mirrors it exactly so the motion matches:
- Position / size / velocity are stored scaled up and read back with `>> 10` (÷1024) for screen coordinates (`FP = 10`).
- `launch()` actually seeds positions in a `width*1000` space (not ×1024) but everything is still read `>> 10`, and the on-screen bound is the raw pixel extent — a small internal scale mismatch in the original. The port keeps this quirk rather than "tidying" the two scales, so trajectories land where the C's do.
- Gravity `dy += size >> 6`, the fuse formula, the burst count `rand(scatter) + scatter/2`, the `(parent*2)/3` shrapnel size, and the `size < 4` draw thresholds are all transcribed unchanged.
- The simulation runs in **CSS-pixel space**, identical to the C running at the same window size. No physics constant is scaled by `devicePixelRatio`; the *render* is scaled instead (see Deviations).

## Deviations from the C
- **Full repaint** instead of incremental draw + per-projectile erase (above). The C's `sorted_projectiles` / `sort_by_pixel` pixel-sorting is dropped — it only reduced X11 GC colour switches and has no analogue on canvas.
- **devicePixelRatio = render-only.** Physics runs in CSS px (`W = canvas.width / dpr`); each draw coordinate is multiplied by `dpr` at paint time (`fillRect`/`arc`), so the backing store stays crisp on retina without distorting the simulation. No ctx transform is used, so no state leaks to the next mounted hack. *(Audit fix 2026-06-28: the previous port scaled the launch velocities, the initial size, the shrapnel decay, AND the burst-velocity cache by dpr. Because the fuse is derived from `dy` — `fuse = (rand%500+500)*abs(dy/g)/1000` — scaling `dy` by dpr also scaled the fuse, a pure step count. On a 2× display rockets burned ~2× as long and burst well after apex, on the way down. Removing dpr from the physics makes retina match the C exactly.)*
- **Free list = real LIFO `next_free` chain**, including the burst aliasing described in the Algorithm section. *(Audit fix 2026-06-28: the previous port scanned the pool for the first `dead` slot, which did NOT reliably reuse the just-freed parent first, so the burst's aliasing onset varied with how many dead slots happened to precede the parent — scenes with many free slots produced cleaner, larger, more symmetric bursts than the C's. The free list restores the C's deterministic "parent reused first" behaviour, so most sparks are 4/9 the rocket size and the cloud drifts by `cache[v1]`.)* **STRUCTURAL — needs live verify against the binary.**
- **Colour.** Primary rockets burn **white** (the launch streak), exactly as the C draws primaries with the foreground pixel. Shrapnel wear the rocket's hue at full saturation and value: the C does `hsv_to_rgb(random%360, 1.0, 1.0)` per shell (a *direct* per-shell HSV, not a `make_*_colormap` ramp — so a vivid colour is faithful here), ported as `hsl(h, 100%, 50%)`, which is mathematically identical to `hsv(h, 1, 1)`. *(Audit fix 2026-06-28: was `hsl(h, 100%, 60%)`, a 10%-lighter, slightly washed colour.)* No per-frame colour cycling, matching the C (each shell's colour is fixed at launch). `mono_p` mode (everything white) isn't ported.
- **`delay` default = stock 10000 µs + `OVERHEAD = 6000 µs`.** This is a *pacing* calibration, not a fidelity item: the rAF lag-accumulator paces one sim step per `(delay + OVERHEAD)` µs. The default `delay` is the **stock 10000** (the slider maps 1:1 to the xml/`.c` resource), and the loop adds the OVERHEAD so the *effective* rate matches the live binary rather than the nominal `1/delay`. Measured against the live `-fps` overlay pyro runs **62.5 fps**, while the port at the stock delay ran ~100 steps/s (1.6× fast); `10000 + 6000 = 16000 µs → 62.5 steps/s`, matching the binary. (An earlier revision used a by-eye default of 20000 µs.)
- **No `XClearWindow`/colormap plumbing**: irrelevant on canvas.

## Config
Ranges/defaults/labels mirror `hacks/config/pyro.xml`:
- `delay` — **Frame rate** (µs/step, default **10000** = stock, + `OVERHEAD = 6000` — see Deviations; `live`, inverted: drag right = faster).
- `count` — **Particle density** (size of the projectile pool, 10–2000, default 600, `reinit` — it sizes the pool).
- `frequency` — **Launch frequency** (launch when `rand(frequency)==0`, 1–100, default 30, `live`, inverted: lower = more often, so the slider reads "seldom → often").
- `scatter` — **Explosive yield** (shrapnel per burst, 1–400, default 100, `live`).

The xml's `showfps` boolean is host chrome (frame-rate overlay), not a hack parameter, so it isn't ported. `r` (restart) and the non-live `count` change re-seed via `reinit()`.
