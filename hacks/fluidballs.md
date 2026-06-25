# fluidballs — port notes

Port of `fluidballs.c` by Peter Birtles (2000), ported to X11 by Jamie Zawinski (2002) with physics tweaks by Steven Barker — "a particle system of bouncing balls; gravity moves around to shake the box." Hundreds of balls of mixed sizes pile and jostle in a box like a coarse fluid.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/fluidballs.c` (~880 lines, most of it X11/Xft plumbing; the physics is ~130 lines).

See [[grav]] / [[galaxy]] for the moving-bodies idioms this follows.

## Algorithm
Each ball has a position `(px, py)`, velocity `(vx, vy)`, radius `r`, and a precomputed mass `m = r³·π·1.3333` (sphere-like, so a bigger ball is much heavier and shoves smaller ones aside). One physics step is `update_balls()`:

1. **Pairwise collisions** — the upper-triangle `O(n²)` loop over every pair `(a, b)`. If the centre distance² is less than `(r_a + r_b)²` the balls overlap: take `d = sqrt(dist²)`, the overlap depth `dd = r_a + r_b - d`, and the unit collision axis `(cdx, cdy)`. Push each ball out along that axis by half the overlap, then resolve a 1D elastic collision of the velocity components along the axis (`vca`, `vcb`) using the standard two-body formula, scaled by the elasticity `e` so a little energy is lost on each bounce. Add the impulses back onto the full velocity vectors.
2. **Walls** — clamp each ball inside the box `[0,W]×[0,H]`; on contact, set the position to the wall and reflect the perpendicular velocity with `v ← -v·e`.
3. **Gravity / wind** — `vx += accx; vy += accy; px += vx; py += vy` (times the time constant `tc = 1`).

With **shake** on, a wall-clock timer measures how far the balls moved this frame (`max_d`, the max per-ball squared displacement / `max_radius`); once they've been settling for >5 s and either `max_d < shake_threshold` (0.015) or 30 s have passed, `shake()` permutes the gravity vector to one of four rotations and re-rolls the ball colour — the box tips and the pile avalanches to a new corner.

At init: `count` balls (default 300) get random positions, tiny random velocities (`±0.1`), and radii either uniform (`= max_radius`) or a random spread (`(0.2 + frand(0.8))·max_radius`) when "various sizes" is on. `max_radius = size/2`. If the balls' total area would exceed 75% of the box, `count` is trimmed to fit.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — full repaint per frame
Filled circles via `ctx.arc` + `fill`. Unlike grav/galaxy (persistent canvas), fluidballs **clears to black and redraws every ball each frame**, which is what the brief calls for and is the canvas equivalent of the C's scheme: the C double-buffers into a Pixmap, erases each ball's *old* disc with `erase_gc`, draws the *new* disc, then blits the buffer to the window. A whole-canvas clear-and-redraw produces the identical visible result with no erase "turds" (the C even comments that optimizing the erase "leaves turds"). At the default 300 balls this is a few hundred `arc` fills per frame — cheap.

## Loop
Standard rAF lag-accumulator paced by `config.delay` (µs in the xml, divided by 1000 for the ms rAF clock), catch-up capped (`MAX_CATCHUP_STEPS = 4`) so a backgrounded tab doesn't burst on refocus. The collision pass is the heavy work, so `draw()` runs at most once per frame even if several `step()`s fire — we never draw more than we simulate. `step()` has no variable delay (the C returns a constant `state->delay`).

## Deviations from the C
- **Full repaint instead of double-buffered erase/draw** (above) — same visible result, no X11 GC tricks.
- **No mouse-drag ball.** The C lets you pick up a ball with the mouse (`mouse_ball`, `draw_gc2`) and fling it. A screensaver has no pointer interaction, so that path is dropped. The second "mouse" colour (`fg2`) is kept but repurposed: one random ball is drawn in it each shake, purely for a touch of visual variety. The gravity-permute and recolor behaviour is unaffected.
- **Colours**: the C allocates two X colours, each channel rolled in `[0x88, 0xff]` (always at least half-bright). We build the identical bright `rgb()` strings directly — every ball shares one colour (re-rolled on each shake), exactly like the original; this hack does **not** use an `ncolors` rainbow.
- **devicePixelRatio**: positions, radii, and the box are all in device px. `max_radius = size/2` is scaled by `dpr` so balls are a consistent CSS size and crisp on retina. The C's retina branch (×3 past 2560 px) and tiny-window cap (≤5) are kept and key on the device-px canvas size, so on a hi-dpi display both the dpr scale *and* the ×3 apply — matching the C's intent that balls grow on dense displays.
- **Wall-clock shake timer**: the C uses `gettimeofday()`; we use `performance.now()` (the rAF timestamp) to accumulate real seconds since the last shake. Same thresholds (5 s settle gate, 30 s hard cap, 0.015 stability).
- **Box geometry**: the C's box is the window minus a strip at the bottom reserved for the optional FPS text. We don't draw FPS, so the box is the full canvas `[0,W]×[0,H]`. The C also polls for the window being moved/resized every frame; the browser equivalent is the `resize` listener, which re-inits.
- **`--fps`, `--root`, `--db`** are X/overlay flags, omitted as in the other ports. `timeScale` and `shakeThreshold` aren't in the xml UI; kept as the constants `TC = 1` and `SHAKE_THRESHOLD = 0.015` (the C's defaults).
- **Default `delay` 16000 µs** (stock 10000) — a touch calmer by feel, per the gallery convention; noted here and in the config comment.

## Correctness self-review (stability — won't explode or tunnel at defaults)
The brief's failure mode for this hack is exploding velocities or overlap tunnelling. Checked by hand:
- **No exponential energy gain.** Every velocity change is multiplied by `e ≤ 1`: the collision impulses are scaled by `e`, and wall reflections are `-v·e`. Gravity adds a *bounded* constant (`accy ≤ 0.1`) each step. So total energy is injected only by gravity and bled off by every bounce — it can't run away. (Setting Friction to exactly 1.0 / "rubber" conserves collision/wall energy but gravity is still the only source, so it stays bounded.)
- **Collision resolution is positional, not just impulse.** Overlapping balls are physically separated by the full overlap `dd` (half each) *before* the velocity exchange, so a pair can't stay interpenetrated and accumulate impulse frame after frame — this is the key anti-tunnelling step, ported verbatim. The walls likewise hard-clamp the position onto the boundary, so a ball can never leak out of the box even if it arrives fast.
- **Divide-by-zero guarded.** The collision axis divides by `d = sqrt(dist²)`. Two balls at exactly the same point would give `d = 0`; the C doesn't guard this (relying on float jitter), but I added `if (d === 0) d = 0.0001` so a perfectly-stacked pair gets a finite (arbitrary-direction) push instead of `NaN`. This is the only added line of logic.
- **`reinit` gives a clean screen.** `init()` only fills arrays (it doesn't paint), so `reinit()` clears to black first, then re-seeds — a fresh box. `resize()` re-inits on the new device size.
- **pause → resume doesn't jump.** `resume()` resets `lastTime = 0` (so `lag` doesn't catch up a burst) *and* `lastShakeClock = 0` (so the shake timer doesn't count the paused interval as settling time and fire an immediate shake on resume).
- **Index 0 unused.** Arrays are `count + 1` long and every loop runs `1..count`, mirroring the C's 1-based indexing exactly (no off-by-one).
- **First frame looks right.** Balls are seeded at random positions across the whole box with small velocities, so frame 1 already shows a full scatter of balls that immediately begins to fall and pile — no degenerate/off-screen start.

## Config
Ranges mirror `hacks/config/fluidballs.xml`:
- `delay` — Frame rate, µs/step, default 16000 (stock 10000), `invert: true`, **live**.
- `count` — Number of balls, 1–3000, default 300, **non-live** (sizes the ball arrays → `reinit()`).
- `size` — Ball size, 3–200, default 25, **non-live** (sets `max_radius` and the radii → `reinit()`).
- `gravity` — Gravity ("Freefall"→"Jupiter"), 0–0.1, default 0.01, **live**.
- `wind` — Wind ("Still"→"Hurricane"), 0–0.1, default 0.00, **live**.
- `elasticity` — Friction ("Clay"→"Rubber"), 0.2–1, default 0.97, **live** (read every step).
- `random` — Various ball sizes, default on, **non-live** (changes the radii → `reinit()`).
- `shake` — Shake box, default on, **live** (read every frame).

`gravity`/`wind`/`elasticity`/`shake` are all read fresh each step/frame and apply instantly. The subtlety is shake: the C permutes the running `(accx, accy)` vector, which would normally make the live sliders stale. Instead of storing `accx/accy` numerically, the port stores the shake permutation **symbolically** as coefficients on the base `(wind, gravity)` (`accx = axW·wind + axG·gravity`, etc.; each coefficient ∈ {-1,0,1}). shake() applies the C's exact per-case linear map to those coefficients, so the permutation composes correctly across shakes *and* the step loop recomputes `accx/accy` from the live slider values every frame — dragging Gravity mid-run takes effect immediately, in whatever direction the box is currently tipped. `count`/`size`/`random` resize the ball set and so re-seed via `reinit()` (which clears the canvas). "Reset to defaults" applies every key then reinits once.
