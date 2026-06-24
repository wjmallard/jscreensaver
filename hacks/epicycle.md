# epicycle — port notes

Port of `epicycle.c` ("A pre-heliocentric model of planetary motion", James Youngman, 1998) — a body riding a system of nested rotating circles (a deferent plus epicycles, as in Ptolemaic cosmology). Each circle is centred on a point on the rim of its parent, so the body's position is the **sum of a handful of rotating vectors**; as the common time parameter `T` sweeps, the body traces one long continuous curve, which then holds, clears, and is replaced by a fresh random figure.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/epicycle.c` (~803 lines) · <https://en.wikipedia.org/wiki/Deferent_and_epicycle>

Same family as `xspirograph.js` / `helix.js` (trace a line-figure -> hold -> clear -> new figure, on a variable-delay loop). See [[xspirograph]] and [[helix]].

## Algorithm
The body position at time `t` is the C's `move_body()`, transcribed verbatim into `bodyXY()`:

```
x = cx + Σ radius[k] · cos(w0 + t·wdot[k])
y = cy + Σ radius[k] · sin(w0 + t·wdot[k])
```

- A figure has `minCircles..maxCircles` circles. Radii shrink down the chain by a common random `factor` in `[sizeFactorMin, sizeFactorMax)`; each radius is `frand(scale)·unit_pixels/2` (floored at `MIN_RADIUS`).
- Speeds are **integer harmonics of a fundamental**: `wdot[k] = wdot_max / divisor[k]`, where `divisor` is a signed Poisson-ish integer (mostly ±1/±2, occasionally larger, capped at `harmonics`). `wdot_max = harmonics·(minSpeed + 2π·frand(maxSpeed−minSpeed))`.
- All circles share one random initial angle `w0` (`assign_random_common_w`) so the figure closes cleanly and isn't forced symmetric about the X axis.
- The hue advances once per full turn of the fundamental (the C's `color_step`): `idx = floor(ncolors · frac(T·wdot_max/2π))`, so the curve's colour sweeps smoothly through the session's colormap along its length (see **Palette**).

### Closure — the integer period (NOT float equality)
Because every speed is `wdot_max/divisor`, all circles return to `w0` simultaneously after **`lcm(|divisor|)` turns of the fundamental**, i.e. at `T = xtime = lcm·2π/wdot_max` (the C's `compute_divisor_lcm` → `xtime`). The figure is drawn for `totalSegs = round(xtime/timestep)` segments and is then complete. This is the brief's mandated integer-period closure test — there is **no exact float-equality** check on the body position (a quasi-periodic curve never hits that), so there are no dead lines and no endless over-draw.

### State machine (the C's `epicycle_draw`)
`NEW → DRAW → … → HOLD → CLEAR → NEW`:
- **NEW** rolls a fresh figure (`newFigure()`): new `wdot_max`, new circle chain, `L`/`xtime`/`totalSegs`, bounding-box precalc + rescale, and seeds the trailing point at `T=0` (the C's double `move_body(0)`, so the first segment grows from the curve's start, not from screen centre). Every per-figure variable is reset here.
- **DRAW** strokes exactly one segment per paced step (coloured via `colorIndex`); finishes at `totalSegs`.
- **HOLD** holds the finished figure for `holdtime` seconds.
- **CLEAR** blanks the screen and pauses ~1 s of black before the next figure.

## Palette
The C's `colour_init` calls `make_smooth_colormap` **once per session** to build `ncolors` (default 100) colours, then `color_step` walks that map as the curve is drawn. A smooth colormap is 2–5 random HSV anchors interpolated into a closed loop — usually a *limited, muted/pastel* range, **not** a full-spectrum rainbow — so a given session's figures share one coherent palette (e.g. green-dominant, blue-dominant, or pink↔teal). The port builds the palette with the shared **`makeSmoothColormapRGB(ncolors)`** (`colormap.js`, a faithful port of `utils/colors.c`), rebuilt per session in `reset()`, and `colorIndex` sweeps it exactly as `color_step` does. `ncolors ≤ 2` falls back to mono white (the C's `mono_p`). Verified against the live binary: the live curve is single-/limited-hue per session, and the port matches that character.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — vector ops, incremental (persistent canvas)
The curve is genuinely line-shaped (one `XDrawLine` per timestep in the C), so this uses **canvas vector ops**, not a blit. Like xspirograph/helix it draws incrementally onto the persistent (double-buffered) canvas: each paced step strokes **exactly one** line segment (`beginPath`/`moveTo`/`lineTo`/`stroke`), as the C draws one `XDrawLine(old → current)` per call. Nothing is repainted; the screen is cleared only between figures. `lineCap`/`lineJoin` are round, so consecutive segments read as one continuous curve.

## Variable-delay loop
`epicycle_draw` returns the microseconds to wait before the next call — `delay` while drawing, `holdtime` seconds at completion, ~1 s of black after the erase. The port keeps the boxfit-style loop: `step()` returns the ms until the next step and the rAF lag-accumulator honours it.

## Timing — stock delay + measured OVERHEAD
The C draws **one** line segment per `epicycle_draw` call and returns `*delay` (stock **20000 µs**) as the wait before the next, so the pen advances at a **constant** rate no matter how many segments a figure has. It is a clean delay-bound target: the live `-fps` overlay reads **Load 16–41 %** (well under 100 %), and the draw-phase rate measures **~53–59 fps** (≈ 56; the lower 11–31 readings are EMA samples dragged down by the 2 s holds on short figures). Per-segment work is therefore negligible, so **`OVERHEAD = 0`**: `*delay` is a *floor*, so the port must not run faster than the author's 20000 µs (= the nominal **50 seg/s**). The naive `round(1e6/56) − 20000` would be **−2143**, but a negative overhead would mean running faster than the specified delay — the measured ~56/s sitting just *above* nominal is only XQuartz undershooting the sleep, within run variance, so it is clamped to 0. The port paces each step at `(config.delay + OVERHEAD)/1000 = 20` ms and draws **one segment per step** → the nominal **50 seg/s** (the live ~56/s differs only by the XQuartz undershoot, inside the ±15 % `-fps` run variance).

## Deviations from the C
- **`xtime`/`lcm` computed BEFORE the bounding-box trace.** The C has an off-by-one: `precalculate_figure()` runs on the *previous* figure's `xtime` (and `0` on the very first figure, so the first figure is never rescaled). This port computes `L`/`xtime` first, then traces the bbox over the figure's **own** period, then rescales — so every figure, including the first, is correctly sized. (Verified: 0/20000 figures overflow the screen.)
- **One segment per step (no batching) + a safety cap the C lacks.** Like the C, the port draws exactly one segment per paced step, so the pen speed is constant and a figure takes as long as its segment count dictates. At the nominal 50 seg/s the median figure (≈ 332 segs) traces in ~6.6 s, p90 (≈ 1250 segs) in ~25 s, with a long tail (the C is uncapped: a rare high-`lcm` figure runs for minutes). As a gallery safety valve the port caps a figure at `MAX_DRAW_SEGS = 16000` (~5.3 min at 50 seg/s), truncating only ~0.05 % of figures; the bbox precalc is sampled at most `MAX_PRECALC_SAMPLES = 4000` points (the C steps by 1.0). *(An earlier revision batched up to 60 segments/step to normalise every figure to ~10–20 s; that raced the pen on complex figures and was removed for pace fidelity.)*
- **Erase = instant black + ~1 s pause, a wipe candidate.** The C calls xscreensaver's `erase_window` animated transition between figures. As instructed, this port `fillRect`s the screen black; a real wipe is a future enhancement once a shared wipes module exists.
- **Colour.** See **Palette**: the port builds one `makeSmoothColormapRGB(ncolors)` colormap per session (a faithful port of the C's `make_smooth_colormap`) and `colorIndex` sweeps the hue exactly as `color_step` does. `ncolors ≤ 2` falls back to mono white, as the C's `mono_p` path. (The C's commented-out `color0`/XOR foreground experiment is dropped — it is `#if 0` / dead code in the source.)
- **devicePixelRatio.** The backing store is device-px; radii derive from `min(W,H)` device px so figures auto-scale, and `MIN_RADIUS` and the line width are scaled by `dpr`. The C's "× 3 line width past 2560 px" hi-dpi hack is replaced by uniform `dpr` scaling of `lineWidth` (`config.linewidth · dpr`).
- **Minor.** Radii are kept as floats (the C truncates to `long` on each rescale — negligible accuracy gain). The circle chain is a flat array, not a linked list (summation order is irrelevant to the body position). `timestepCoarseFactor` (1.0, no stock UI) is folded into the precalc sampling.

## Config
Ranges mirror `hacks/config/epicycle.xml` (the five stock controls):
- `delay` — **Frame rate** (`--delay`, µs/step, live, inverted: drag right = faster).
- `holdtime` — **Linger** (`--holdtime`, 1–30 s hold before erasing, live).
- `linewidth` — **Line thickness** (`--linewidth`, 1–50, applied live; scaled by dpr).
- `harmonics` — **Harmonics** (`--harmonics`, 1–20; non-live, re-rolls a fresh figure via `reinit()`).
- `ncolors` — **Colors** (`--colors`, 1–255; non-live, rebuilds the palette).

The remaining C resources (`minCircles`, `maxCircles`, `minSpeed`, `maxSpeed`, `timestep`, `divisorPoisson`, `sizeFactorMin`, `sizeFactorMax`) have no stock UI; they live in `config` at the C's default values so the figure geometry matches the source 1:1. Non-live changes and `reinit()` start a fresh figure with the current config.

## Correctness self-review
A headless numeric harness re-ran the core math over **20 000 random figures**:
- **0** non-finite (NaN/Infinity) positions — the body is a bounded sum of `radius·cos/sin`, so it cannot diverge (no clamp/reseed needed).
- Completion is driven entirely by the integer `totalSegs = round(xtime/timestep)` (from `lcm`), so there is **no float-equality closure test**: figures cannot dead-line or over-draw, and cannot run forever (the 16000-segment cap is hit ~0.05 % of the time).
- Worst closure gap (uncapped figures) ≈ 29 px, which is one ordinary segment-length in a fast figure — the curve's end lands one segment from its start, the same spacing as everywhere else, so it reads as closed (and matches the C, which likewise stops at integer `T` near the period rather than snapping to the exact start).
- Every figure fits on screen after rescale (0/20000 exceeded 1.02 × half-dimension).
- `newFigure()` resets every per-figure variable; `pause`→`resume` cannot burst (`lastTime` reset); `reinit()` clears to black and re-seeds.

**Spot-check in the browser:** that figures look reasonably sized and centred (rescale), that the colormap hue sweeps smoothly along the curve, and that the hold/clear/new-figure rhythm feels right at the default `delay`/`holdtime`.
