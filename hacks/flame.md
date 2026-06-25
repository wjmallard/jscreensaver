# flame — port notes

Port of `flame.c` (Scott Draves, 1993; from Patrick J. Naughton's 1991 xlock hack `flame.c`, brought into xscreensaver by jwz). Recursive fractal "cosmic flames" — an iterated nonlinear function system whose transforms are re-randomized every frame, plotted as accumulating points.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/flame.c` (~456 lines)

## Algorithm
Each frame draws one fractal from a set of **2..4 affine transforms** (`snum = 2 + cur_level % 3`), each `nx = a·x + b·y + c` for both output coordinates (6 random coefficients per function, each in `[-1, 1)`). Some of the functions (`anum` of them) additionally pass through one of **10 nonlinear "variations"** — sinusoidal, complex, bent, swirl, horseshoe, drape, broken, spherical, arctangent, complex-sine. `recurse(x, y, l)` composes these transforms `iterations` deep; at the leaf (`l == max_levels`) it maps the point from the `[-1,1]` square to the screen (`(W/2)(x+1), (H/2)(y+1)`) and plots it — but only the first `points` leaf points get emitted, after which `recurse` returns 0 and the whole depth-first recursion unwinds, ending the frame.

Successive frames overlay new fractals onto the same image (the plot colour cycling through the palette each frame), so the figure builds up and shifts. Every `iterations` frames it hits a **reset**: flip the "alternate" flag (which forces `anum = 0`, i.e. purely affine — these tend to be the clean linear webs), pick a fresh variation, **linger** for `delay2`, then clear and start a new flame.

`halfrandom()` (the C's cheap second-draw: reuse the high 16 bits of a previous `random()`) is reproduced faithfully — it's what picks `anum` and the initial colour.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — Uint32 blit, additive accumulation
Thousands of points per frame, heavily overlapping along the attractor, accumulating across the frames of a flame → the **blit path** (like [[hopalong]] / [[thornbird]]): write points into a persistent `Uint32Array` over an `ImageData`, `putImageData` once per frame. Only the plotted pixels are touched (≈`points`/frame), never the whole screen.

The twist vs. the plain single-colour blit: I **accumulate hits additively** — each hit adds ~1/6 of the current frame's (mid-bright) colour to the pixel, clamped at 255 per channel. Dense regions of the attractor saturate to white-hot while the sparse filaments stay dim and hued, which is what gives the glowing "flame" look (the brief asked for a density-mapped vivid render rather than the C's flat one-pixel-value plots). See **Deviations**.

## Variable-delay loop
`flame_draw` returns the microseconds until the next call — normally `delay`, but `delay2` (the "Linger") on a frame that just finished a flame and is about to clear. The port keeps this with the **boxfit/xspirograph variable-delay accumulator**: `step()` returns the ms to wait, the rAF loop banks time and honours it, so the long linger between flames is preserved. The catch-up cap is `nextDelay + 1000` ms so a multi-second linger always elapses (and a backgrounded tab still can't burst). The buffer persists between steps, so drawing happens inside `step()` (no per-frame full repaint).

## Deviations from the C
- **Additive density render** instead of flat single-colour `XFillRectangles`. The C sets one GC foreground per frame and overdraws; overlapping points are just the same pixel value. We instead sum colour per hit and clamp, so overlap → brightness (the cosmic-flame glow). The frame still has one *hue* (the cycling palette colour), so a flame is still multi-hued across its frames, exactly as the C cycles `pixcol` down each non-reset frame.
- **Colour**: the C builds a `make_smooth_colormap` of `ncolors` smooth (often muted) colours and cycles the pixel index down each frame. We build an `ncolors`-entry **vivid HSL rainbow** (full-sat, L=0.55) and cycle it the same way — house style favours saturated rainbows.
- **devicePixelRatio**: backing store sized in device px; the point size (`scale`) is 1, or 2 past 2560 px, matching the C's retina bump. The fractal math lives in the unit `[-1,1]` square and maps to `W/2,H/2`, so it auto-scales to the device-px canvas with no extra dpr factors.
- **NaN/Inf handling**: the C ignores `SIGFPE` and relies on silent NaNs. JS never throws on float overflow, so NaN/Inf simply propagate — see Correctness below. The C's explicit guards (the `fabs(x) > 1e5 → x = x/y` scale-back, and the per-variation `1e4` clamps) are ported verbatim.
- **Variation 8**: the C writes `atan(nx) / M_PI_2`; ported as `atan(nx) / Math.PI * 2` (same value, no `M_PI_2` constant in JS).
- **`delay2` default**: kept at the xml's 2 s linger. The build `delay` default is 40000 µs (xml is 50000) — a touch calmer by feel, as the brief allows.
- Dropped the X-only plumbing (`mono_p`, GC, colormap, fps overlay, `--root`, `ignoreRotation`).

## Correctness self-review
- **Termination is guaranteed by `total_points > max_total`** (`points`, default 10000), independent of recursion depth or divergence. The recursion is depth-first to depth `iterations`; the leaf counter ticks on every leaf visit and returns 0 once it exceeds `points`, which unwinds the entire tree. Verified by hand: even with `iterations = 250` and `snum = 4` (an astronomically large tree), the first ~`points` leaves end the frame. JS recursion depth = `iterations` ≤ 250, well within the call-stack limit.
- **Divergence can't hang or crash.** If the map blows up, `nx`/`ny` go to ±Inf then NaN. The leaf test `x > -1 && x < 1` is *false* for NaN/Inf (so nothing plots, and `plot()` also bounds-checks), but the leaf counter still ticks — so a divergent frame just produces few/no points and ends via `max_total` like any other. The `fabs > 1e5 → x/y` scale-back keeps most frames finite. No special "reseed on NaN" is needed because **every frame already re-randomizes all coefficients** (the natural reseed), and every `iterations` frames the variation changes and the screen clears.
- **Reset/clear timing matches the C.** `do_reset` is set on the reset frame but the clear happens at the *top of the next* `step()` — so the finished flame is shown and lingers (`delay2`) for one frame before the buffer is wiped, then the new flame draws fresh. The `cur_level` post-increment is reproduced so frame 0 is itself a reset frame (clean start). `flame_alt`, `variation`, `pixcol`, `lasthalf` are all re-seeded on the paths that read them.
- **pause/resume** uses the `rafId === 0` sentinel + `lastTime = 0` reset (no catch-up burst); **reinit** rebuilds the palette and buffer and resets `nextDelay = 0` for a clean fresh screen.

## Config
Ranges mirror `hacks/config/flame.xml`: `delay` (Frame rate, µs, live, inverted), `delay2` (Linger, µs, live), `iterations` (Number of fractals — recursion depth & frames per flame, live), `points` (Complexity — max points/frame, live), `ncolors` (Colors — palette size, reinit). `iterations`/`points`/`delay`/`delay2` are read every frame so they apply instantly; only `ncolors` resizes the palette and re-runs `init()`.
