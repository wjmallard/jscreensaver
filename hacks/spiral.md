# spiral — port notes

Port of `spiral.c` (Darrick Brown, 1994; turned standalone by jwz 1997; the "cycles need not be arbitrary" fix by Peter Schmitzberger, 1995). The XML credits Schmitzberger/1997, so that is what `info` shows.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/spiral.c` (~331 lines). Note: spiral was dropped from the XScreenSaver distribution as of 5.08 (it ships only as a retired hack), per the XML description.

## Algorithm
A single "spiral" is, each step, a **ring of `count` dots** evenly spaced around a circle — centre `(cx,cy)`, radius `radius`, with a rotating phase `angle`. Every step the centre drifts by `(dx,dy)` and bounces off the world-box edges; the radius grows/shrinks by `dr` and bounces between ~50 and ~2500; the phase advances by `da`. With small probability (`JAGGINESS/3000` each) the drift is re-aimed, `dr` is nudged (clamped to 4..18), and `da` is re-rolled or reversed — the "craziness" that keeps the path wandering. The last `cycles` rings are held on a **circular buffer**; once it wraps, each step erases the oldest ring (black) just before stamping the new one, so a constant-length trail of overlapping rings crawls across the screen, producing shifting circular **moiré** interference. The ring colour cycles through the palette as the trail advances.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — per-dot fillRect, draw-new + erase-oldest (no full clear)
A ring is only `count` points and at most `cycles` rings are live, so the field is **sparse**: each dot is a 1-device-px `fillRect` (the C's `XDrawPoint`), bumped to `round(dpr)` px on retina. Like the C, the canvas is **not** cleared each frame — the oldest ring is erased in black and the new one drawn, leaving the rest of the trail standing. This is what builds the moiré (a full clear each frame would only ever show one ring). The C double-buffers via X; canvas double-buffers natively, so no flicker.

## Coordinate space
The C works in a proportional world box `0..right` by `0..10000` (`right = aspect * 10000`) and maps to pixels with `TFX/TFY`. The port keeps the exact world math (so the centre still bounces at world 1000/9000, radius at 50/2500, etc.) and converts only at draw time via `screenX/screenY`. World y is **not** flipped (the C's `TFY` divides by its own `top`, no inversion), so up/down match the original.

## Deviations from the C
- **Faithful port** — centre/radius/angle dynamics, the four random-jitter rules, color cycling, and the erase-oldest/draw-newest trail all match. Cryptic names renamed: the struct's `inc` → `head` (circular-buffer write cursor), `nlength` → `trailLen`, `colors` → `colorPos`; the per-ring arrays are `trailX/Y/A/R`.
- **`count` is live.** The C fixes dots-per-ring at init (and supports a negative "random up to" count). Here `count` (1..100, default 40) is read every step so the slider applies instantly; the negative-random branch is dropped (the XML slider is 0..100 non-negative). `cycles` and `ncolors` size buffers/palette, so they are `live:false` and apply via `reinit()`.
- **Erase correctness.** The C tracks an `erase` flag that turns on when the buffer first wraps; the port's `wrapped` flag is equivalent. Until the buffer has wrapped once, nothing is erased (the trail is still growing).
- **Radius lower-bounce quirk preserved.** The C's lower bound test reads `radius < 50 && radius < 0` (effectively dead, since `dr` is clamped ≥4 so the radius rarely goes negative); transcribed as-is rather than "fixed", so behaviour matches the original. The radius is in practice held positive by the upper bounce.
- **No expose/redraw path.** The C keeps a `redrawing`/`REDRAWSTEP` loop to repaint the trail after X expose events; a canvas needs no manual expose repair, so it is omitted. `refresh_spiral` (clear + flag a full redraw) collapses to the instant clear in `reinit()`/`resize()`.
- **devicePixelRatio**: backing store sized in device px; dot size scaled by `round(dpr)` so dots stay visible on retina.

## Config
Ranges mirror `hacks/config/spiral.xml`: `delay` (Frame rate, µs, live, inverted — the XML's `convert="invert"`), `count` (Count 1..100, **live** here), `cycles` (Cycles 10..800, reinit — trail length), `ncolors` (Number of colors 1..255, reinit). The XML's `--count` low bound is 0; the slider here starts at 1 since a ring needs ≥1 dot (the C clamps to `MINDOTS = 1` anyway). Palette is the faithful `make_smooth_colormap` (the C defines `SMOOTH_COLORS`): a random 2–5 anchor HSV smooth loop (often muted/pastel, re-rolled each run) via `colormap.js`'s `makeSmoothColormapRGB(ncolors)`, built **once per run** like the original. The per-frame colour cycling through that palette (`colorPos` → `MI_PIXEL`) is unchanged.

**Framerate calibration (`OVERHEAD = 9524`).** The stock `delay = 50000 µs` is only a sleep floor; the live binary's real rate is lower (delay + framework overhead — see the framerate-calibration note). The live spiral measures **16.8 fps**, while the port at the stock delay ran 20 steps/sec (1.19× fast). The loop adds `OVERHEAD`: `50000 + 9524 = 59524 µs → 16.8 steps/sec`, matching the live binary. The `delay` slider still maps 1:1 to the xml resource.
