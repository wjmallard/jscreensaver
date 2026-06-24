# rorschach — port notes

Port of `rorschach.c` (Jamie Zawinski, 1992; helix eraser added by Johannes Keukelaar, 1997) — inkblot patterns via a reflected random walk. A single dot wanders out from the centre of the screen, each step a small random jump, and every dot is stamped with optional X and/or Y mirror symmetry, so the random walk accretes a symmetric Rorschach inkblot. The finished blot lingers a few seconds, the screen clears, a fresh hue is chosen and a new blot begins.

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
- While `remaining > 0`, draw a 300-step chunk and decrement. The pace between chunks is the C's hardcoded 20 ms (`delay = 20000`).
- When `remaining` hits 0, the blot is finished: hold it for `linger` seconds.
- After the linger, clear the screen and `startBlot()` — pick a new random hue, recentre, reset `remaining`.

This port flattens the C's eraser/`remaining_iterations == -1`/`== 0` bookkeeping into an explicit `lingering` flag plus a `step()` that returns the ms until the next call, which is the cleaner equivalent of the C returning microseconds.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — sparse fillRect onto the persistent canvas
At most four small rectangles are drawn per walk step, so this is a **sparse accumulating draw**: `ctx.fillRect` straight onto the persistent canvas, no per-pixel `ImageData` buffer (cf. `binaryring.js`, which needs the blit path because it read-blends thousands of segment pixels per frame — rorschach only writes opaque dots). The canvas itself is the accumulator, exactly like the C drawing dots into the live window with `XFillRectangles`; nothing is repainted between steps.

## Variable-delay loop
`rorschach_draw` returns the microseconds to wait before the next call — 20 ms between walk chunks, then `delay` **seconds** (the configured linger) once a blot completes. The port keeps this xspirograph/boxfit-style: `step()` returns the ms until the next step and the rAF lag-accumulator honours it, so the multi-second hold between blots is preserved (the accumulator backlog cap is `nextDelay + 1000` so a long linger never gets starved by the backgrounded-tab clamp). See [[xspirograph]] for the same loop.

## Deviations from the C
- **Erase = instant black (no helix transition).** The C erases the finished blot with xscreensaver's scrolling *helix* `erase_window` wipe before the next walk. The web has no X11 GC eraser, so — as instructed — this port `fillRect`s the screen black at that point. **Replacing it with a real wipe is a future enhancement** once a shared wipes module exists.
- **Colour.** The C rolls a full random HSV (`random()%360`, saturation 1, value 1) per blot. This port keeps the gallery's vivid `hsl(h, 100%, 50%)` rainbow with the same random hue — visually equivalent.
- **devicePixelRatio.** The backing store is sized in device px and the dot size folds in `dpr`, so dots stay a consistent CSS size and crisp on retina. The C bumps dot size to 3 px only past 2560 px; this port keeps that 3 px branch and also scales by `dpr` (`scale = round(3·dpr)` on hidpi, else `round(dpr)`). The per-step `offset` is likewise multiplied by the dot scale so the walk covers the same fraction of the screen on hidpi (otherwise a retina blot would be cramped into a quarter-size cluster).
- **Linger exposed as a slider.** The xml's `delay` slider is *labeled* "Linger" (1 second … 1 minute) and in the C is the post-blot hold. This port maps it to the `linger` key (1–60 s) so the slider does what its label says, and adds a separate **Frame rate** slider bound to `config.delay` (the per-chunk pace, default 20000 µs = the C's hardcoded value) to satisfy the gallery's standard frame-rate control. The two are independent: Frame rate controls how fast the blot draws, Linger how long it rests.

## Correctness self-review
- **No dead/over-draw loops.** The only loop bound is `n = min(ITER_CHUNK, remaining)`; `remaining` is set to `>= 10` in `startBlot()` and strictly decreases each chunk, so it reaches 0 in a finite number of steps and the machine always advances to the linger → clear → restart cycle. There is no float-equality closure test (unlike xspirograph), so nothing can fail to fire.
- **Every branch re-seeds.** Entering `lingering` is only reached from `remaining === 0`; leaving it (the clear branch) calls `startBlot()`, which re-seeds `curX/curY/remaining/lingering` and the hue before the next walk reads them. The defensive `remaining === 0 && !lingering` branch also calls `startBlot()`, so no state is read unset.
- **First frame looks right.** `init()` calls `startBlot()` and sets `nextDelay = 0`, so the first `frame()` immediately draws a chunk centred on screen — no off-screen or degenerate start.
- **pause/resume / reinit.** `resume()` resets `lastTime = 0` so refocus doesn't burst; `pause()` uses `rafId === 0` as the sentinel. `reinit()` clears to black and re-seeds via `init()` for non-live changes (iterations, dot scale) — a clean fresh screen.
- **Off-screen wandering is harmless.** A long walk can drift the dot off-canvas; `fillRect` simply clips, matching the C (`XFillRectangles` clips to the window). The walk is not wrapped — faithful to the C, which lets blots run off the edges.

## Config
Ranges mirror `hacks/config/rorschach.xml`:
- `delay` — **Frame rate** (per-chunk pace, µs/step, live, inverted: drag right = faster). Default 20000 µs (the C's hardcoded chunk delay); not an xml slider, added for gallery parity.
- `iterations` — **Iterations** (`--iterations`, walk steps per blot, 100–10000, default 4000; non-live, re-runs via `reinit()`).
- `offset` — **Offset** (`--offset`, max jump per axis per step, 1–50, default 7; live).
- `linger` — **Linger** (`--delay`, 1 s … 1 min hold before clearing, default 5; live).
- `xsymmetry` — **With X symmetry** (`--xsymmetry`, default on; live).
- `ysymmetry` — **With Y symmetry** (`--ysymmetry`, default off; live).

The symmetry flags are live so toggling them changes the next stamped dots without restarting the blot (the existing dots stay). Non-live changes and `reinit()` start a fresh screen with the current config. Local-dev/module-fetch caveat is the same as `squiral.md`.
