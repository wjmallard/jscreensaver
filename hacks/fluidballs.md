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
The C runs exactly **one** `step()` + one repaint per frame and sleeps `state->delay` between frames (`fluidballs_draw` returns the constant delay). Here a standard rAF lag-accumulator paces the sim by `config.delay` (µs in the xml, divided by 1000 for the ms rAF clock) so the speed is independent of the monitor refresh rate; catch-up is capped (`MAX_CATCHUP_STEPS = 4`) so a backgrounded tab doesn't burst on refocus, and the collision pass is the heavy work so `draw()` runs at most once per frame even if several `step()`s fire. The accumulator runs `1e6/(delay + OVERHEAD)` steps/sec (see *Pace*).

**Pace (calibrated against the live binary).** The default `delay` is the **stock 10000 µs** (the slider maps 1:1 to the xml resource); the loop adds a fixed `OVERHEAD = 8975 µs` so `(delay + OVERHEAD)` reproduces the live binary's *effective* rate rather than the nominal `1/delay`. Measured against the live `-fps` overlay fluidballs runs **52.7 fps**, while the port at the stock delay ran ~100 steps/s (1.9× fast); `10000 + 8975 = 18975 µs → 52.7 steps/s`, matching the binary. A calibration, not a tuning knob — see the framerate-calibration notes. (An earlier revision used a by-eye default of 16000 µs.)

## Audit 2026-06-28 (Batch 1B)
Fidelity audit against `fluidballs.c`. Fixes applied:
- **Removed an invented "special ball."** The previous port drew one random ball each shake in a second colour (`fg2`), billed as "visual variety." That is wrong: in the C, `fg2`/`draw_gc2` is the colour of the *mouse-dragged* ball, and `mouse_ball` is only ever non-zero while you are actively dragging with the pointer — which never happens during screensaving (any input exits the saver). So in the real binary **every ball is the same single colour** (`fg`). The port now draws all balls in one colour, and `fg2` is dropped along with the mouse-drag feature.
- **Faithful colour computation (including the overflow).** The C rolls each 16-bit channel as `0x8888 + (random() % 0x8888)` into an `unsigned short`; the sum can exceed `0xffff`, so it **wraps** to a dark value about 12.5% of the time per channel. The server then shows the high byte (`>> 8`). The old port clamped each channel to `[0x88,0xff]` (random range `0x78`, no wrap), which made *every* colour phase a pale pastel. Now transcribed exactly (`(0x8888 + rand%0x8888) & 0xffff) >> 8`), so ~1/3 of shakes give a more saturated colour with a dark channel, as the binary does.
- **Removed a devicePixelRatio double-count on ball size.** The old port set `max_radius = (size/2) * dpr` *and* kept the C's ×3 retina bump (keyed on device-px width > 2560). On a retina display both fire, making balls ~2× the C's size (and, via the area-trim, too few of them). X11 / jwxyz work in device px and the canvas is device px, so the faithful value is `max_radius = size/2` device px, with the ×3 / ≤5 caps keyed on the device size exactly as the C. Now matches the C at dpr 1 *and* on retina.

## Deviations from the C
- **Full repaint instead of double-buffered erase/draw** (above) — same visible result, no X11 GC tricks.
- **No mouse-drag ball.** The C lets you pick up a ball with the mouse (`mouse_ball`, `draw_gc2`) and fling it. A screensaver has no pointer interaction, so that path — and the second colour `fg2` that only the dragged ball ever uses — is dropped. The gravity-permute and recolor behaviour is unaffected.
- **Colours**: faithful (see the audit note above). All balls share one bright colour, re-rolled on each shake, channels per the C's `0x8888 + random()%0x8888` 16-bit-with-wrap formula downsampled `>> 8`; this hack does **not** use an `ncolors` rainbow.
- **devicePixelRatio**: positions, radii, and the box are all in device px; `max_radius = size/2` device px with the C's ×3 retina bump (device width/height > 2560) and ≤5 tiny-window cap, no extra dpr scaling — matching the C across displays (see the audit note).
- **Wall-clock shake timer**: the C uses `gettimeofday()` and accumulates *integer-second* deltas each frame; we use `performance.now()` (the rAF timestamp) to accumulate real (fractional) seconds since the last shake. Same thresholds (5 s settle gate, 30 s hard cap, 0.015 stability); the fractional accumulation reaches them at the same wall-clock time.
- **Box geometry / resize**: the C's box is the window minus a bottom strip reserved for the optional FPS text; we don't draw FPS, so the box is the full canvas `[0,W]×[0,H]`. The C polls window geometry every frame (`check_window_moved`) and, on a move/resize, updates the bounds **without re-scattering the balls**. The port mirrors this: the `resize` listener updates `W`/`H` (the walls) and lets the running simulation continue; it re-seeds only on first start and on a non-live config change (`reinit()`). `max_radius`/`count` are fixed at seed time, as in the C (it never recomputes them on resize).
- **`--fps`/`showfps`, `--root`, `--db`** are X/overlay flags, omitted as in the other ports. `timeScale` and `shakeThreshold` aren't in the xml UI; kept as the constants `TC = 1` and `SHAKE_THRESHOLD = 0.015` (the C's defaults).
- **Divide-by-zero guard**: the collision axis divides by `d = sqrt(dist²)`; two perfectly-coincident balls would give `d = 0`. The C relies on float jitter; the port adds `if (d === 0) d = 0.0001` so a stacked pair gets a finite push instead of `NaN`. The only added line of logic.
- **Default `delay` = stock 10000 µs + `OVERHEAD = 8975 µs`** — a pacing calibration matched to the live binary's measured 52.7 fps, not a fidelity item (see *Loop* / *Pace*).

## Correctness self-review (stability — won't explode or tunnel at defaults)
The brief's failure mode for this hack is exploding velocities or overlap tunnelling. Checked by hand:
- **No exponential energy gain.** Every velocity change is multiplied by `e ≤ 1`: the collision impulses are scaled by `e`, and wall reflections are `-v·e`. Gravity adds a *bounded* constant (`accy ≤ 0.1`) each step. So total energy is injected only by gravity and bled off by every bounce — it can't run away. (Setting Friction to exactly 1.0 / "rubber" conserves collision/wall energy but gravity is still the only source, so it stays bounded.)
- **Collision resolution is positional, not just impulse.** Overlapping balls are physically separated by the full overlap `dd` (half each) *before* the velocity exchange, so a pair can't stay interpenetrated and accumulate impulse frame after frame — this is the key anti-tunnelling step, ported verbatim. The walls likewise hard-clamp the position onto the boundary, so a ball can never leak out of the box even if it arrives fast.
- **Divide-by-zero guarded.** The collision axis divides by `d = sqrt(dist²)`. Two balls at exactly the same point would give `d = 0`; the C doesn't guard this (relying on float jitter), but I added `if (d === 0) d = 0.0001` so a perfectly-stacked pair gets a finite (arbitrary-direction) push instead of `NaN`. This is the only added line of logic.
- **`reinit` gives a clean screen.** `seed()` only fills arrays (it doesn't paint), so `reinit()` clears to black first, then re-seeds — a fresh box. `resize()`, by contrast, keeps the running simulation (it only moves the walls), matching the C's `check_window_moved`; it seeds only on first start.
- **pause → resume doesn't jump.** `resume()` resets `lastTime = 0` (so `lag` doesn't catch up a burst) *and* `lastShakeClock = 0` (so the shake timer doesn't count the paused interval as settling time and fire an immediate shake on resume).
- **Index 0 unused.** Arrays are `count + 1` long and every loop runs `1..count`, mirroring the C's 1-based indexing exactly (no off-by-one).
- **First frame looks right.** Balls are seeded at random positions across the whole box with small velocities, so frame 1 already shows a full scatter of balls that immediately begins to fall and pile — no degenerate/off-screen start.

## Config
Ranges mirror `hacks/config/fluidballs.xml`:
- `delay` — Frame rate, µs/step, default **10000** (stock) + `OVERHEAD = 8975`, `invert: true`, **live**.
- `count` — Number of balls, 1–3000, default 300, **non-live** (sizes the ball arrays → `reinit()`).
- `size` — Ball size, 3–200, default 25, **non-live** (sets `max_radius` and the radii → `reinit()`).
- `gravity` — Gravity ("Freefall"→"Jupiter"), 0–0.1, default 0.01, **live**.
- `wind` — Wind ("Still"→"Hurricane"), 0–0.1, default 0.00, **live**.
- `elasticity` — Friction ("Clay"→"Rubber"), 0.2–1, default 0.97, **live** (read every step).
- `random` — Various ball sizes, default on, **non-live** (changes the radii → `reinit()`).
- `shake` — Shake box, default on, **live** (read every frame).

`gravity`/`wind`/`elasticity`/`shake` are all read fresh each step/frame and apply instantly. The subtlety is shake: the C permutes the running `(accx, accy)` vector, which would normally make the live sliders stale. Instead of storing `accx/accy` numerically, the port stores the shake permutation **symbolically** as coefficients on the base `(wind, gravity)` (`accx = axW·wind + axG·gravity`, etc.; each coefficient ∈ {-1,0,1}). shake() applies the C's exact per-case linear map to those coefficients, so the permutation composes correctly across shakes *and* the step loop recomputes `accx/accy` from the live slider values every frame — dragging Gravity mid-run takes effect immediately, in whatever direction the box is currently tipped. `count`/`size`/`random` resize the ball set and so re-seed via `reinit()` (which clears the canvas). "Reset to defaults" applies every key then reinits once.
