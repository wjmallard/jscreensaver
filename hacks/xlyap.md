# xlyap — port notes

Port of `xlyap.c` by Ron Record (1991) — the **Lyapunov exponent** of a
periodically-forced 1-D map drawn as a 2-D fractal (the Markus-Lyapunov / "Zircon
Zity" picture). Original: <https://www.jwz.org/xscreensaver/> · source:
`xscreensaver-6.15/hacks/xlyap.c` (~1938 lines, mostly X11 plumbing, rubber-band
zoom history, and an X colormap/colour-wheel system). See [[squiral]] for the
shared skeleton, [[marbling]] for the reduced-grid blit + cap idiom, [[demon]]
for `hslToUint`.

## The algorithm
For each pixel `(a, b)` of a 2-D parameter window, iterate a nonlinear map of the
unit interval — by default the logistic map `x -> r*x*(1-x)` — where the parameter
`r` alternates between `a` and `b` according to a fixed binary **forcing sequence**
(default `"abbabaab"`). Two phases per pixel (`complyap()` in the C):

1. **settle** — iterate `settle` times and throw the result away (shed transients).
2. **dwell** — iterate `dwell` more times, accumulating `log2|f'(x)|`. The average
   is the **Lyapunov exponent** `L`. The C uses the `log(a*b)=log(a)+log(b)`
   product optimisation (`useprod`, the default): multiply derivatives into a
   running product, only calling `log()` when it crosses `1e12`/`1e-12`. We do the
   same — far fewer `log()` calls.

`L < 0` => the orbit is **ordered/periodic**; `L >= 0` => **chaotic**. Colour by
sign + magnitude. The C also ships 5 maps (logistic, circle, leftlog, rightlog,
doublelog) with their derivatives, and 23 builtin presets (`do_preset()`) that
each pick a parameter window + forcing sequence + dwell/settle; the screensaver
chooses one at random per image, lingers, then re-seeds — which is exactly what we
do.

## Rendering (BLIT path + progressive build)
This is a genuinely expensive PER-PIXEL field (`settle + dwell` map iterations per
pixel), so it follows [[marbling]]'s small-offscreen blit + cap idiom:

- The exponent grid is computed at a **reduced LOGICAL resolution** (`logical px /
  Detail`, *not* device px — retina must not multiply the cost), capped at
  `MAX_CELLS = 110000`, written into a `Uint32Array` view over one `ImageData` on
  an offscreen canvas, then `ctx.drawImage`-upscaled (bilinear) to the device-res
  canvas. Lyapunov fields are smooth, so the upscale looks clean.
- **Progressive**: the image builds a band of rows per frame (like the C computes
  scanline-by-scanline). Each eligible frame computes chunks for at most
  `FRAME_BUDGET_MS = 14`, so a frame never blocks for seconds. When the last row
  is done it enters a **hold** state for `linger` seconds, then re-seeds a new
  random preset. (The C does the same: `xlyap_draw()` runs ~2000 pixels per call,
  then a `linger`-second countdown, then `do_preset(random)`.)
- Every cell's exponent is also stored in a `Float32Array`, so changing the colour
  knobs (Colors / Contrast) **recolours** the finished field instantly without
  recomputing it — the C's `e`/recalc key.

**Caps (porter brief mandate — cap grid AND iterations):** `MAX_CELLS = 110000`
reduced cells; `SETTLE_CEIL = 600`, `DWELL_CEIL = 1000` iteration ceilings;
`CHUNK_ITERS = 100000` sizes one chunk; `FRAME_BUDGET_MS = 14` hard-caps per-frame
work. **Measured** (headless harness, 1440x900 logical, Detail 2 => 419x262 grid):
a full image takes 0.11 s (light preset) to 1.14 s (the circle map, slowest
because of `sin`/`cos`); the heavy logistic deep-zoom presets are 0.3-0.5 s.
Spread over progressive 14 ms frames that's ~0.3-1.3 s of build with no freeze.

## Deviations from the C
- **Honour `mapindex` (fix a latent C bug).** In the compiled screensaver,
  `do_preset()` sets `st->mapindex` but **never updates the `st->map`/`st->deriv`
  function pointers** (that code lives only in the unreached `mapIndex`-resource
  branch of `parseargs()`), so *every* preset actually runs the logistic map on
  the logistic `[2,4]^2` window. We honour the obvious author intent: presets that
  set `mapindex` use that map **and** its correct parameter window
  (`amins`/`aranges`), so the circle (`[0,1]^2`) and leftlog (`[0,6.75]^2`) maps
  render as designed. This is the one deliberate behavioural change; it is more
  faithful to the source's intent and stays bounded (each map keeps `x` in `[0,1]`
  within its valid `r` range, and `x` is clamped defensively regardless).
- **Vivid rainbow palette** instead of the C's X colormap machinery. The C builds
  HSV colour wheels / a muted `make_smooth_colormap` and indexes them via an
  intricate (and partly buggy: `lowrange` can go negative) X-pixel scheme in
  `sendpoint()`. We drop all of that and map `L` onto a single vivid diverging
  rainbow: the order/chaos boundary `L=0` lands at the palette midpoint, deeper
  order/chaos walks toward the two ends, and `|L|` beyond the scale **wraps**
  (modulo) into contour bands — the same banding the C gets from its `% lowrange`
  / `% numfreecols`, just unified and vivid. `Contrast` sets the band density.
- **Dropped X11 plumbing:** rubber-band mouse-zoom and the multi-frame zoom
  history (`go_down`/`go_back`/`jumpwin`/`set_new_params`, all `#if 0`-guarded or
  X-event-driven), the colour-wheel spinning (`Spin`/`Cycle_frames`), the
  `-o`/output-file save, the `-v`/show-defaults dump, the `function`-forcing dead
  code (under `#ifdef MAPS`, never compiled), and the `randomForce` pseudo-random
  forcing (`Rflag`, off by default). None affect the default screensaver picture.
- **Loop shape.** Because this is a progressive build-then-hold hack rather than a
  steady per-step animation, it uses a delay-throttled, time-budgeted batch loop
  instead of the squiral lag-accumulator: each eligible frame computes for up to
  `FRAME_BUDGET_MS`, then blits; `config.delay` ("Frame rate") throttles how often
  a batch runs (right = build faster / less idle CPU); `config.linger` holds the
  finished image. Hold timing is wall-clock (rAF timestamp).
- **Config knobs.** The xml exposes only `delay`, `linger`, and `showfps` (fps is
  host-owned). `settle`/`dwell`/window/map/forcing are per-preset in the C too
  (not user knobs), so instead of exposing them we add **Detail** (grid
  coarseness, `live:false`), **Quality** (a multiplier on the preset
  settle/dwell, `live:false`), **Colors** (palette size, `live:true` -> recolour),
  and **Contrast** (band density, `live:true` -> recolour). `delay`/`linger` are
  `live:true`. Default `delay` is 32000 µs (xml 10000, eased slower so the build
  isn't sluggish).

## Correctness self-review
This hack's failure modes are (a) NaN/Inf from `log` of a non-positive argument or
an unbounded map, (b) a progressive build that never completes or never re-seeds,
and (c) a frame that blocks for seconds. Verified with a headless node harness
(`xlyap_harness.mjs` / `xlyap_perf.mjs`):

- **Always finite & in-range.** `x` is clamped to `[0,1]` every iteration; `log(0)`
  is guarded (`dx === 0` bails, matching the C); the product is bounded to
  `[1e-12, 1e12]`; the final `L` is `Number.isFinite`-checked (-> 0 otherwise).
  Across the default window and presets 0/2/7/9/16/19 the harness reported
  **0 NaN/Inf** and bounded min/max (e.g. circle `-25.8..1.3`, logistic deep
  `-3.1..0.2`), and the colour index wraps to `[0, ncolors)` regardless of `|L|`.
- **Both regimes present + rich colour.** Every tested window has thousands of
  negative *and* positive cells (e.g. default 2958 neg / 1138 pos) and uses
  223-256 distinct colours — the first frame is structured, not degenerate.
- **Build completes & re-seeds.** The progressive loop's `curRow` advances to `gh`
  for every preset (`completed: true`, `rows === gh`), at which point `state`
  flips to `'hold'`; after `linger` seconds `newImage()` picks a fresh random
  preset and resets `curRow = 0` + clears the buffer. No off-by-one leaves a row
  uncomputed; `aInc`/`bInc` reset on every preset adoption and on resize.
- **No freeze.** The compute loop breaks on `FRAME_BUDGET_MS` (and always does at
  least one chunk for progress); measured full images are 0.1-1.1 s spread over
  many frames. The heaviest per-row cost (circle, ~4.4 ms/row) is well under one
  frame.
- **Lifecycle.** `pause()`/`resume()` (resets `nextBatch` so no burst),
  `reinit()` (fresh preset + grid), `resize()` (re-grids, restarts the build), and
  `stop()` (cancels rAF + removes the resize listener) all run clean. Live colour
  changes recolour the stored exponents without a recompute.

**Worth a browser spot-check (new hack):** the *aesthetics* — whether the diverging
rainbow + default `Contrast 1` reads as the recognisable Lyapunov fractal (vivid
ordered swallowtails over chaotic ground) rather than noisy; and whether the
build-then-linger cadence feels pleasant at the default `delay 32000` / `linger 5`.
The math is verified correct, bounded, and complete; the colour mapping is a
deliberate vivid replacement for the C's X colormap and is tuned by feel.

## Config
Units/defaults mirror `hacks/config/xlyap.xml` where present: `delay` (µs/frame,
xml 10000 -> 32000), `linger` (seconds, 0-10, default 5). Added: `detail` (1-6,
grid cell size), `quality` (0.5-2, iteration scale), `ncolors` (2-256, palette
size), `contrast` (0.3-3, band density). The `delay` slider uses `invert: true`
(the xml's `convert="invert"` "Frame rate" slider). Map/window/forcing/settle/dwell
come from one of the 23 builtin presets at random per image, as in the C.

**Local dev:** ES-module `import`s need a real server — `python3 -m http.server`
in the repo, then <http://localhost:8000/#xlyap>. `file://` fails (CORS on the
`null` origin); GitHub Pages serves over http, so production is fine.
