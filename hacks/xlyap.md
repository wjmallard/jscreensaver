# xlyap — port notes

Port of `xlyap.c` by Ron Record (1991) — the **Lyapunov exponent** of a
periodically-forced 1-D map drawn as a 2-D fractal (the Markus-Lyapunov / "Zircon
Zity" picture). Original: <https://www.jwz.org/xscreensaver/> · source:
`xscreensaver-6.15/hacks/xlyap.c` (~1938 lines, mostly X11 plumbing, rubber-band
zoom history, and an X colormap/colour-wheel system). See [[squiral]] for the
shared skeleton, [[marbling]] for the reduced-grid blit + cap idiom, `imsmap` /
`swirl` for the `make_smooth_colormap` rebuild-per-image idiom.

> **Audited 2026-06-27 (Batch 1B). This was a STRUCTURAL REBUILD of the colour
> pipeline — needs live verify.** The previous port used a vivid HSL rainbow and
> a symmetric diverging map centred on L=0; both were unfaithful (the C uses a
> muted `make_smooth_colormap` and an *asymmetric two-range* index scheme). The
> colour mapping IS the whole image, so this was rebuilt as an exact
> transcription of the C's `sendpoint()`. See "Deviations" + "Residual risk".

## The algorithm
For each pixel `(a, b)` of a 2-D parameter window, iterate a nonlinear map of the
unit interval — the logistic map `x -> r*x*(1-x)` — where the parameter `r`
alternates between `a` and `b` according to a fixed binary **forcing sequence**
(e.g. `"abbabaab"`, the Morse-Thue sequence). Two phases per pixel (`complyap()`):

1. **settle** — iterate `settle` times and throw the result away (shed transients).
2. **dwell** — iterate `dwell` more times, accumulating `log2|f'(x)|`. The average
   is the **Lyapunov exponent** `L`. The C uses the `log(a*b)=log(a)+log(b)`
   product optimisation (`useprod`, the default): multiply derivatives into a
   running product, only calling `log()` when it crosses `1e12`/`1e-12`. We do the
   same. The `dx==0` early-bail (`log(0)` guard) is transcribed. The C does **not**
   clamp `x`; logistic on `r ∈ [2,4]` keeps `x ∈ [0,1]` for every window used, so
   no clamp is needed (the previous port's clamp was a harmless no-op; removed).

`L < 0` => **ordered/periodic**; `L > 0` => **chaotic**. `start_x = 0.65`.

## Colour — the whole picture (faithful `sendpoint()` transcription)
The C builds a `make_smooth_colormap` of `maxcolor = 256` colours (a random 2-5
anchor HSV loop, **frequently muted/pastel** — NOT a rainbow), **rebuilt on every
reseed** (`init_color`). We use `makeSmoothColormapRGB(256)` from `colormap.js`,
rebuilt per image. The screensaver-path index constants resolve to fixed values
(`do_defaults` + the `minColor`/`colors` resources): `startcolor=17`,
`mincolindex=1`, `numcolors=200` ⇒ `numfreecols=199`, and `lowrange = mincolindex
- startcolor = -16` (**genuinely negative in the binary** — transcribed as-is).
With `negative=1` (default), `sendpoint()` maps `L` in two asymmetric sub-ranges:

- **chaotic** (`L>0`): `idx = (int)(L*lowrange/maxexp); idx = (idx % lowrange) +
  startcolor` → a **narrow ~16-colour band at the start** of the colormap (so
  chaos reads near-uniform).
- **ordered** (`L<=0`): `idx = (int)(L*numfreecols/minexp); idx = (idx %
  numfreecols) + mincolindex` → the **broad `[1,199]` sweep** (so ordered
  structures get the full colour range).

`(int)` is `Math.trunc`; C `%` equals JS `%` here (both truncate toward zero, so
the negative `lowrange` modulo matches). `|L|` beyond the scale **wraps** (the
modulo) into contour bands. `BufferPoint` clamps the index to `[0, 256)`. The
scale is per-preset: `maxexp = -minexp = minlyap` (`1.0` for builtins 0-8,
`0.85` for 9-21). Verified vs hand-computed values and over three presets: chaos
clusters in ~8-12 colours, order spans all 199, no NaN.

## Rendering (BLIT path + progressive build) — matches the C's cadence
Genuinely expensive PER-PIXEL field (`settle + dwell` map iterations per pixel).
The C computes ONE Lyapunov value per **window pixel** (`a_inc = a_range/width`,
`point.x` runs `0..width`), so the port matches that pixel density:

- Computed at the window's **LOGICAL resolution** — one cell per CSS pixel
  (`gw = round(innerWidth)`, `gh = round(innerHeight)`), the same density the live
  binary's 1x window has — into a `Uint32Array` view over one `ImageData`, then
  `drawImage`-upscaled by `devicePixelRatio` to the device canvas (the same softness
  the live binary shows on a hidpi screen). `MAX_CELLS = 2_500_000` only caps a
  pathologically large window (the grid then subsamples). This replaced an earlier
  `CELL = 2` / 110 000-cell reduced grid that the user (correctly) called
  "shockingly low-resolution" — the field is now full window resolution.
- **Progressive scan + hold + reseed**, matching `xlyap_draw()` exactly: each
  `delay`-long step computes `POINTS_PER_STEP = 2000` cells in scanline order (the
  C's `for (i=0;i<2000;i++) complyap(st); return st->delay;`), banked off rAF, so
  the image reveals as a slow per-pixel scan (reveal time ≈ `cells / 2000 * delay`);
  then **hold** for `linger` seconds, then re-seed a fresh random builtin **with a
  fresh colormap**. The C does the same: 2000 pixels per draw call, then a
  `linger`-second reset_countdown (each tick returns 1 000 000 µs), then
  `do_preset(random%22)` + `init_color`. This is a **paint-and-hold** hack — NOT
  continuously animated. (Pace note: the per-step budget is the C's literal 2000;
  the scan rate is calibrated to the live binary via the loop's `OVERHEAD` added
  to the compute delay — see Config / [[framerate-calibration]].)

## Deviations from the C
- **Logistic for ALL builtins (reproduces the live binary; this REVERSES the
  previous port).** `do_preset()` sets `st->mapindex` for builtins 9-21 (intending
  the circle / leftlog maps) but **never updates the `st->map`/`st->deriv` function
  pointers OR the parameter window** — that code lives only in the unreached
  `mapIndex`-resource branch of `parseargs()`. So the compiled screensaver runs the
  **logistic** map for *every* builtin, on the window `do_preset` leaves in place:
  builtins 0-8 have explicit windows; 9-21 fall back to the carried-over `[2,4]²`
  (builtin 14 sets its own). The previous port "honoured the intent" and ran
  circle/leftlog on `[0,1]²`/`[0,6.75]²` — but that is **not what the binary draws
  / the demo video shows**. Per the audit ("transcribe what runs, don't
  reinvent"), we now reproduce the binary. The 22 builtins collapse to logistic on
  a handful of windows/forcings; the duplicates are faithful (they bias the random
  pick toward `[2,4]²` with `"abbabaab"` / `"aaaaaabbbbbb"`). Only builtins 0-21
  are reachable (`random()%22`); case 22 is dropped.
- **Reseed colour-scale bug NOT reproduced (uses the intended scale).** On reseed
  the C calls `do_defaults()`, which sets `minexp = 0` and `minlyap = 1.0` but does
  **not** reset `maxexp`; builtins 0-8 (which don't touch these) then enter
  `sendpoint()`'s ordered branch with `minexp = 0` → a literal **divide-by-zero**
  whose `(int)` cast is undefined behaviour (typically `INT_MIN`), collapsing all
  ordered points to `colour[0]`. (Builtins 9-21 are unaffected — `do_preset` sets
  `minexp = -0.85`.) We use the **intended** symmetric scale `maxexp = -minexp =
  minlyap` for every image — i.e. exactly the first-image values `parseargs`
  produces and the obvious design. This is the one place we deliberately do NOT
  reproduce a (UB-relying, picture-degrading) C bug; **flagged for the main
  session to confirm against the live binary** (does it actually show degraded
  reseeded 0-8 frames, and does matching that matter?).
- **Dropped X11 plumbing:** rubber-band mouse-zoom and the multi-frame zoom
  history (`go_down`/`go_back`/`jumpwin`/`set_new_params`, `#if 0`-guarded or
  X-event-driven), colour-wheel spinning (`Spin`/`Cycle_frames`), the `-o` output
  file, the `-v` show-defaults dump, the `function`-forcing (`#ifdef MAPS`, never
  compiled), and `randomForce` pseudo-random forcing (`Rflag`, off by default).
  None affect the default screensaver picture.
- **Loop shape (class B).** Progressive scan-then-hold rather than a steady
  per-step animation, so it uses a delay-banked rAF lag-accumulator: each
  `config.delay`-long step computes `POINTS_PER_STEP = 2000` cells (the C's literal
  per-draw budget) in scanline order, then blits once per frame; `config.linger`
  holds the finished image. Hold timing is wall-clock (rAF timestamp).

## Config
Mirrors `hacks/config/xlyap.xml` exactly — the only resources it exposes:
- `delay` — "Frame rate", `0..100000` µs, default **10000**, `convert="invert"`
  (`invert: true`). µs interval between compute batches.
- `linger` — "Linger", `0..10` s, default **5**. Seconds the finished image holds.
- (`showfps` is host-owned.)

**Framerate calibration (`OVERHEAD = 10534`).** The stock `delay = 10000 µs` is only a sleep floor; the live binary's build-scan rate is lower (delay + framework overhead). The `-fps` overlay measures **48.7 fps** during the scan, while the port at the bare stock delay ran 100 steps/sec (2.05× fast), so the compute loop runs at `delay + OVERHEAD = 20534 µs → 48.7 steps/sec`. Applied to the per-step **compute** delay only — the `linger` hold is a separate wall-clock duration, untouched. The slider still maps 1:1 to the xml. See [[framerate-calibration]].

**Removed invented sliders** that the previous port added and the `.xml` never
had: `Detail`, `Quality`, `Colors`, `Contrast`. The window / forcing / settle /
dwell / colormap are per-builtin in the C (not user knobs), and `Colors`/`Contrast`
specifically drove the *unfaithful* rainbow + symmetric map (now gone). The field
is now full window resolution (one cell per CSS pixel); `POINTS_PER_STEP` (the C's
2000) and `MAX_CELLS` (the large-window safety cap) are fixed internal constants.

## Residual risk / couldn't verify (for the main session)
- **STRUCTURAL REBUILD of the colour core — verify vs the live binary.** The
  `sendpoint()` two-range index math + muted `make_smooth_colormap` is transcribed,
  not tuned, and math-verified (hand values + distribution), but the *aesthetic*
  result (muted palette, near-uniform chaotic sea, full-sweep ordered structures,
  contour-band wrapping) should be eyeballed against the demo video
  (youtube `5MrEaXnhEPg`) / XQuartz original.
- **The reseed bug** (above) — decide whether to reproduce the degraded 0-8
  reseed frames or keep the intended scale (current choice).
- **Off-by-one in `a`** (sub-pixel): the C advances `a` by `a_inc` *before* the
  first pixel; we sample `a ∈ [min_a, max_a)` from cell 0. One-cell shift, visually
  irrelevant; left clean rather than transcribing the off-by-one.

**Local dev:** ES-module `import`s need a real server — `python3 -m http.server`
in the repo, then <http://localhost:8000/#xlyap>. `file://` fails (CORS on the
`null` origin); GitHub Pages serves over http, so production is fine.
