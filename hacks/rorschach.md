# rorschach — port notes

Port of `rorschach.c` (Jamie Zawinski, 1992; helix eraser added by Johannes Keukelaar, 1997) — inkblot patterns via a reflected random walk. A single dot wanders out from the centre of the screen, each step a small random jump, and every dot is stamped with optional X and/or Y mirror symmetry, so the random walk accretes a symmetric Rorschach inkblot. The finished blot lingers `delay` **seconds** (the xml's only delay resource — a linger, not a frame knob), the screen clears, a fresh hue is chosen and a new blot begins.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/rorschach.c` (~227 lines) · <https://en.wikipedia.org/wiki/Rorschach_inkblot_test> · <https://en.wikipedia.org/wiki/Random_walk>

## Algorithm
The walk starts at `(W/2, H/2)`. Each step nudges the position by a uniform random integer in `[-offset, +offset]` on each axis independently — the C's `x += (random() % (1 + (offset<<1))) - offset`, transcribed verbatim. The visited point is stamped as a small filled rectangle, along with its mirror images:
- **X symmetry** also stamps `(W - x, y)` — reflection across the vertical centre line.
- **Y symmetry** also stamps `(x, H - y)` — reflection across the horizontal centre line.
- **Both** additionally stamps `(W - x, H - y)` — the diagonal (point) reflection.

So one walk produces up to four mirrored copies per step; with the default `xsymmetry` on / `ysymmetry` off you get the classic left-right-mirrored blot.

The C plots in chunks of `ITER_CHUNK = 300` steps per draw call (kept here), so a 4000-step blot accretes visibly over a dozen-odd frames rather than appearing in a single flash. The walk position and current hue persist between chunks.

### State machine (the C's `rorschach_draw`)
`draw walk chunks → linger → erase → start new blot`:
- While `remaining > 0`, draw a 300-step chunk and decrement. The pace between chunks is the C's **hardcoded** 20 ms (`rorschach_draw`'s `delay = 20000` — there is no Xrm resource for it), plus the measured per-chunk `OVERHEAD` so the port never runs faster than the binary.
- When `remaining` hits 0, the blot is finished: hold it for `delay` seconds (the C returns `sleep_time * 1000000`).
- After the linger, clear the screen and `startBlot()` — pick a new random hue, recentre, reset `remaining`. (The C starts its eraser and calls `rorschach_draw_start` on that same tick.)

This port flattens the C's eraser/`remaining_iterations == -1`/`== 0` bookkeeping into an explicit `lingering` flag plus a `step()` that returns the ms until the next call, which is the cleaner equivalent of the C returning microseconds.

### Colour (faithful)
`rorschach_draw_start` rolls `hsv_to_rgb(random()%360, 1.0, 1.0)` per blot — a random integer hue at **full saturation, full value**. That is exactly the pure hue `hsl(h, 100%, 50%)` produces (for S=V=1 the HSV and HSL formulas coincide), so the port's per-blot `hsl(random 0–359, 100%, 50%)` is the C's colour choice verbatim, not a gallery embellishment. Mono mode (white foreground) has no web equivalent and is dropped, like the other ports.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — sparse fillRect onto the persistent canvas
At most four small rectangles are drawn per walk step, so this is a **sparse accumulating draw**: `ctx.fillRect` straight onto the persistent canvas, no per-pixel `ImageData` buffer (cf. `binaryring.js`, which needs the blit path because it read-blends thousands of segment pixels per frame — rorschach only writes opaque dots). The canvas itself is the accumulator, exactly like the C drawing dots into the live window with `XFillRectangles`; nothing is repainted between steps.

## Variable-delay loop
`rorschach_draw` returns the microseconds to wait before the next call — 20 ms between walk chunks, then `delay` **seconds** (the configured linger) once a blot completes. The port keeps this helix/xspirograph-style: `step()` returns the ms until the next step and the rAF lag-accumulator honours it, so the multi-second hold between blots is preserved. Chunk steps return `(CHUNK_DELAY + OVERHEAD) / 1000` — the hardcoded 20000 µs + the live-measured per-chunk cost `OVERHEAD = 6300` (the binary's `-fps` overlay read 38.0 fps at Load 24.0% mid-walk — a clean reading whose sleep slice `26316·(1−0.240) = 20000` lands on the hardcoded chunk pace exactly, confirming it) — and the accumulator backlog cap is `nextDelay + 50` ms, enough headroom to keep the ~21 ms cadence accurate across 60 Hz frames without letting a refocus burst repaint half a blot at once (while still letting a multi-second linger elapse). See [[xspirograph]] for the same loop.

## Deviations from the C
- **Erase = instant black (no erase_window transition).** The C erases the finished blot with xscreensaver's `erase_window` wipe (a random one; the 1997 change made the helix wipe available to it) before the next walk. Transitions are the host's domain (`wipes.js` exists but is not yet integrated), so this port `fillRect`s the screen black at that point and starts the next blot on the same tick, like the C's `rorschach_draw_start`.
- **devicePixelRatio.** The backing store is sized in device px; per the repo's retina convention the *look* is pinned to the C at 1x: the dot is 1 **logical** px (`scale = round(dpr)`) and the per-step `offset` is in logical px (multiplied by `round(dpr)` only). The C's `st->scale *= 3` branch for >2560-px framebuffers ("Retina displays") is kept but tested against the **logical** size — a genuinely huge display — because the port already compensates for dpr; testing device px would wrongly trip it on any fullscreen 2x laptop (2880+ device px) and, worse, the old code multiplied `offset` by that 3x too, which the C never does (`rorschach_draw_step` uses the raw resource value). Note this diverges from the raw C on a literal retina framebuffer, where jwz keeps `offset` at 7 *device* px (a denser, half-size blot) — the convention here is that the 1x look is canonical.
- **Resize restarts the blot.** The C's `rorschach_reshape` just updates the mirror axes and lets the current walk continue; resizing a canvas destroys its contents, so the port clears and starts a fresh blot instead.

## Correctness self-review
- **No dead/over-draw loops.** The only loop bound is `n = min(ITER_CHUNK, remaining)`; `remaining` is set to `>= 10` in `startBlot()` and strictly decreases each chunk, so it reaches 0 in a finite number of steps and the machine always advances to the linger → clear → restart cycle. There is no float-equality closure test (unlike xspirograph), so nothing can fail to fire.
- **Every branch re-seeds.** Entering `lingering` is only reached from `remaining === 0`; leaving it (the clear branch) calls `startBlot()`, which re-seeds `curX/curY/remaining/lingering` and the hue before the next walk reads them. The defensive `remaining === 0 && !lingering` branch also calls `startBlot()`, so no state is read unset.
- **First frame looks right.** `init()` calls `startBlot()` and sets `nextDelay = 0`, so the first `frame()` immediately draws a chunk centred on screen — no off-screen or degenerate start.
- **pause/resume / reinit.** `resume()` resets `lastTime = 0` so refocus doesn't burst; `pause()` uses `rafId === 0` as the sentinel. `reinit()` clears to black and re-seeds via `init()` for non-live changes (iterations, dot scale) — a clean fresh screen.
- **Off-screen wandering is harmless.** A long walk can drift the dot off-canvas; `fillRect` simply clips, matching the C (`XFillRectangles` clips to the window). The walk is not wrapped — faithful to the C, which lets blots run off the edges.

## Config
Keys, ranges and defaults mirror `hacks/config/rorschach.xml` 1:1 (the xml's five resources, in xml order — there is deliberately **no frame-rate slider**, because the chunk pace is hardcoded in the C, not a resource):
- `iterations` — **Iterations** (`--iterations`, walk steps per blot, 0–10000, default 4000; the C clamps `< 10` to 10, kept; non-live, re-runs via `reinit()`).
- `offset` — **Offset** (`--offset`, max jump per axis per step, 0–50, default 7; the C clamps `<= 0` to 3, kept; live).
- `xsymmetry` — **With X symmetry** (`--xsymmetry`, default on; live).
- `ysymmetry` — **With Y symmetry** (`--ysymmetry`, default off; live).
- `delay` — **Linger** (`--delay`, **seconds**, 1–60, default 5: how long the finished blot rests before the clear; live).

The symmetry flags are live so toggling them changes the next stamped dots without restarting the blot (the existing dots stay). Non-live changes and `reinit()` start a fresh screen with the current config. Local-dev/module-fetch caveat is the same as `squiral.md`.
