# fuzzyflakes — port notes

Port of `fuzzyflakes.c` by Barry Dmytro (2004) — falling pastel snowflake / flower shapes (inspired by the *Azumanga Daioh* credits). A field of soft, slowly-rotating n-armed flakes drifts downward in several parallax layers over a flat coloured background.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/fuzzyflakes.c` (~655 lines)

Shares squiral's skeleton (inline ES module, `config`/`params`, rAF + lag-accumulator loop, dpr scaling) — see [`squiral.md`](squiral.md). Vector strokes are bucketed into a `Path2D` per pass, like [`truchet.md`](truchet.md).

## Algorithm
Flakes live in `layers` parallax layers; each layer holds `(width/200)*density` flakes. Near layers (index 1) fall fast and draw large/thick; far layers fall slow and draw small/thin.

Per frame the C runs `FuzzyFlakesMove` then repaints everything:
- **Move** (`FuzzyFlakesMove`): each flake's `YPos += speed/10/layer`; `TrueX = sin(XOffset + Ticks*deg*speed/10)*10 + XPos` (a fixed-column sine sway, amplitude 10 px — flakes do **not** drift sideways across the screen, they sway); `Angle += 0.005*speed/10` (slow spin); `Ticks++`. When a flake falls fully past the bottom (`YPos - radius > height`) it respawns at the top (`YPos = -radius`, `Ticks = 0`).
- **Draw** (`FuzzyFlakes` + `FuzzyFlakesDrawFlake`): fill the background, then draw layers **far → near** (so near flakes land on top). Each flake's radius shrinks by `layer*5` and its line widths divide by `layer`. Every arm is a line from the centre to `(cos a, sin a)*radius`, drawn twice: first the wider **border** colour (`(bthickness*2 + thickness)/layer`), then the narrower **fore** colour (`thickness/layer`) on top — so each arm is a coloured core with a contrasting outline.

## Rendering — vector ops, 2 Path2Ds per layer
Sparse strokes, not per-pixel. Within a layer every flake shares the same two line widths and colours, so all border arms accumulate into one `Path2D` and all fore arms into another; each layer costs exactly **two `stroke()` calls** regardless of flake count. `lineCap = 'square'` reproduces the C's `CapProjecting` (square arm tips), and because every arm shares the flake centre the overlapping inner projections fill a **central core** for free (no separate disc primitive needed). The background `fillRect` each frame means no smear and no XOR.

## Palette
Faithful port of `FuzzyFlakesColorHelper` (`flakeColors()` in the .js). The background is the chosen base colour, painted verbatim. The two flake colours are derived from it by the C's **own** routine: decompose the base RGB to HSL, then rebuild two colours from `tempR = (H+1)/3`, `tempG = H`, `tempB = (H-1)/3` (with `H` offset by 1/3 then 2/3) through the standard HSL piecewise. This is **not** a clean +120°/+240° hue rotation — it is the original's idiosyncratic reconstruction, so the results look nothing like a tidy triad:

| base (`--color`) | background | fore (core) | bord (outline) |
|---|---|---|---|
| Pink `#efbea5` (default) | peach | pale yellow `#eeeea5` | dusty rose `#cea5a5` |
| Red `#ff0000` | red | yellow `#ffff00` | dark red `#aa0000` |
| Yellow `#ffff00` | yellow | yellow `#fefe00` | maroon `#550000` |
| Green `#00ff00` | green | dark red `#aa0000` | black `#000000` |
| Cyan `#00ffff` | cyan | maroon `#550000` | yellow `#fffe00` |
| Blue `#0000ff` | blue | black `#000000` | yellow `#ffff00` |
| Magenta `#ff00ff` | magenta | yellow `#ffff00` | yellow `#fefe00` |

There is **no** `make_*_colormap`/`hsv_to_rgb` in the source — this hack computes its own colours, so there is no `colormap.js` involvement. Verified against the live binary to within ±1 per channel (X-server allocation rounding) for Pink, Green and Blue. The channel values truncate (the C casts float→int) before the hex round-trip, matching the original. `randomColors` rolls a fully random RGB base and runs the same helper, rerolling on the C's `Sat < 0.03` failure — matching the C exactly.

> Earlier the port emitted `hsl(h,s,l)` / `hsl(h+120,…)` / `hsl(h+240,…)`, a clean hue rotation that produced e.g. mint-green flakes for the default instead of the live's pale yellow. That assumption (documented as "same relationship") was wrong; the exact reconstruction above replaces it.

## Timing
Stock `*delay: 10000` µs (matches the xml). Initial `-fps` readings during the concurrent audit fan-out ran high (51.5–60.4 fps, vsync-influenced); a clean **solo re-measure** reads **~48–49 fps** at ~50 % Load — **delay-bound** (sleep floor holding at 10000 µs), so the per-step compute is the overhead slice. `OVERHEAD = round(1e6 / 49) − 10000 ≈ 10400` µs; the rAF lag-accumulator paces one step per `(config.delay + OVERHEAD) / 1000` ms (≈20.4 ms ⇒ ≈49 steps/s), matching the live fall/sway/spin rate. The `delay` slider stays 1:1 with the resource (0–100000 µs). (Earlier the loop paced on `delay` alone, so the field fell too fast.)

## Deviations from the C
- **Per-(layer, pass) batching vs per-flake.** The C draws each flake completely (its border arms, then its fore arms) before the next flake. The port draws **all** border arms of a layer, then **all** fore arms of that layer. The load-bearing order is preserved — borders under fores within a flake, and layers far→near — so a flake's outline always sits under its own core and near flakes stay on top. The only change is the overlap of two flakes *in the same layer*: their outlines/cores now union by colour instead of one flake's fill covering another's outline. Visually negligible.
- **Flake count from logical width.** The C's `Density = (XGWA.width/200)*density` uses raw pixels; the port uses `innerWidth` (logical px) so the flake count is the same at any `devicePixelRatio`. All sizes (radius, thicknesses, sway amplitude, fall speed) are CSS px scaled by `S = devicePixelRatio`, replacing the C's hard-coded `>2560px` retina doubling.
- **`density` exposed as a knob.** It's in the C resource table (`*density: 5`) but not the modern xml; the port surfaces it as a "Density" slider (1–20). Dropped: `--fps`, `--mono`, `--db`/`--no-db` (host owns the meter; canvas is already double-buffered).
- **Negative layer radius clamped.** `radius - layer*5` can go ≤ 0 for many layers / small radius; the port clamps it to ≥ 1 px (deep layers become tiny dots) so arms never invert. The wrap test still uses the unclamped **base** radius, as the C does.
- **Float arm coords.** The C truncates arm endpoints to int (`(int)(sin*radius)`); the port keeps float coords (sub-pixel, smoother, no functional difference). `lineCap = 'square'` reproduces `CapProjecting` and `lineJoin = 'miter'` mirrors `JoinMiter` (no joins occur on 2-point arms).

## Correctness self-review
- **No freeze / no runaway.** `step()` is `move()` + full `draw()`; there is no state machine to wedge. The rAF loop bounds itself with `steps < MAX_CATCHUP_STEPS` even when `delay = 0`. Flake count is capped (`per` clamped to ≤ 500) so cranking density/layers can't explode the per-frame stroke work.
- **Respawn / wrap verified.** A 20 000-step headless harness (retina 1280-logical) confirmed flakes respawn (1452 respawns), `YPos` stays in `[-rBase, ch+rBase]`, `TrueX` stays within `[~0, cw]` with the ±sway, `Angle`/`TrueX`/`YPos` are **never** non-finite, and `borderW > foreW` for every layer (outline always visible). Falls are slower the farther the layer, as intended.
- **Full first frame.** `init()` seeds every flake with random position/phase across the whole canvas and immediately calls `draw()`, so frame 1 is already a populated, evenly-spread field (no blank gap, no off-screen start).
- **No smear.** Every frame begins with a full-canvas `fillRect(bgColor)`; nothing is read back, so flakes can't leave trails.
- **Pause / resume / reinit.** `pause()` cancels rAF and sets `rafId = 0`; `resume()` resets `lastTime = 0` (no catch-up burst) and only restarts if paused. `reinit()` resets `lag` and re-seeds a fresh field (the re-paint inside `init()` covers the old one).
- **Min/max & out-of-range tolerated.** `arms`, `layers`, `density`, and per-layer radius are clamped; line widths are floored at 0.5 px.

## Config
Live (read every frame): `delay` (Frame rate, µs, inverted), `speed` (fall/sway/spin rate), `arms`, `thickness`, `bthickness`, `radius`. Not live (re-seed via `reinit`): `layers`, `density` (they size the flake arrays), `color` and `randomColors` (palette). Defaults/ranges transcribed from `hacks/config/fuzzyflakes.xml`; `density` from the C resource table. `r` (restart) re-seeds a fresh field.
