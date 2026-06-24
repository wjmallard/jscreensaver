# strange — port notes

Port of `strange.c` by Massimino Pascal (1997); point size / zoom / brightness / motion blur and the dense **accumulator** renderer added by dmo2118 (2017). A 2-D **strange attractor**: a swarm of dots swoops and twists around as the map's random coefficients drift.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/strange.c` (~1352 lines). See [[hopalong]] and [[thornbird]] for the strange-attractor swarm twins, and [[squiral]] for the shared module skeleton.

## Two renderers (the key fidelity point)
`strange.c` has **two** renderers and picks one **at runtime by the point count**:

```c
#define useAccumulator (A->Max_Pt > 6000)
#define DEF_POINTS "5500"
```

The default `points = 5500` is **not** `> 6000`, so the **DEFAULT is the SIMPLE renderer**, *not* the accumulator. An earlier version of this port ran the accumulator unconditionally — i.e. it rendered the wrong picture at every default setting (a hypnowheel-class wrong-default bug), and it was also the reason "strange opt" was flagged for perf (the accumulator does a full `W×H` pass per frame; the simple path doesn't). This port now mirrors the C: simple by default, accumulator only once **Number of points** crosses 6000.

- **Simple renderer (default, `points ≤ 6000`).** Each frame: clear to black, settle `SKIP_FIRST = 100` iterations from the origin, then plot the whole orbit (`points` dots) as a swarm — **all in one colour**, that colour being `palette[Col % ncolors]` and `Col` incrementing one step per frame, so the swarm cycles hue frame-by-frame. **No accumulation, no trails** (every frame is independent; the C clears `dbuf` / erases the previous points each frame). `brightness` and `motionBlur` do nothing here (the C only reads them in the accumulator) — faithful.
- **Accumulator renderer (`points > 6000`, e.g. the C's own hint `-points 500000`).** Plot into a per-pixel hit-count field, box-blur "bloom" it by `pointSize`, run an optional IIR motion blur, then map accumulated density through a fixed `colorScale` into a **150-entry** (`DEF_NUM_COLS`) logarithmic brightness ramp (`ramp_color`) tinted by the cycling base colour. Dense parts glow.

## Algorithm (shared by both)
Iterate one of two non-linear polynomial maps in fixed-point (`UNIT_BITS = 12`, so world `[-1, 1]` lives in `[-UNIT, UNIT] = [-4096, 4096]`):

- **Iterate_X2** — `xo = fold(P0 − y + poly1(x,y));  yo = fold(P5 + x + poly2(x,y))`, where `poly1/2` are weighted sums of `x², xy, y², x²y / y²x` and `fold()` is an odd-extended sine lookup (`Fold[i] = sin(i/UNIT)`).
- **Iterate_X3** — same numerators plus a third polynomial `z`, then a projective divide `xo = tx·UNIT / (UNIT + z²)`. Wilder; can collapse to a tiny cluster for some coefficients.

The 15 coefficients come from `Old_Gauss_Rand(mid, amp, 4)` — `c ± A·(z − e^(−y²S))/(z − e^(−S))` with `z = curve/10`, `y` uniform. Each frame the **current** coefficients interpolate from `prm1` toward `prm2` (`u = count/40000`, a *small* drift — `count` only reaches 1000); when `count` reaches 1000 it commits (`prm1 = prm2`, a snap) and rolls a fresh `prm2`, so the figure morphs through an endless sequence of attractors. `curve < 10` forces the projective X3 map (the C avoids "boring" X2 there); otherwise the map is picked 50/50 at init. The plotted point is the **input** `(x, y)` of each iteration (`x1 = Lx·x + cx`), then `x, y` advance to the iterate's output plus a ±4 jitter — matching the C exactly (an earlier port plotted the *output*, a one-step orbit shift).

## Palette
`make_smooth_colormap` (utils/colors.c), via the shared `colormap.js` — matching the STANDALONE C's `SMOOTH_COLORS` framework map (`*ncolors: 100`). Built **once** per init (the C does not rebuild it on a reroll) as `ncolors` `[r,g,b]` anchors and **cycled one entry per frame** (`Col++`). The simple swarm uses `palette[Col % ncolors]` directly; the accumulator uses it as the base colour `src_color` that `ramp_color` ramps from near-black to bright across the 150-entry ramp (rebuilt every frame, as the C does in TrueColor). An earlier port used a **vivid full-saturation HSL rainbow** here — replaced (governing rule: faithful, possibly-muted `make_smooth_colormap`, not an invented rainbow).

## Intensity → colour (accumulator) — now faithful
The C uses a **fixed** `colorScale` (a `<<COLOR_BITS` fixed-point factor of `W·H · brightness · colorFac · zoom²/0.81 / 640 / 480 / pointSize² · 800000 / Max_Pt · numCols/256`); the density index is **linear** in accumulated value, clamped to `numCols−1`, and the *log* lives in the ramp (`ramp_color`). This port now transcribes that formula verbatim. An earlier port had **replaced** it with a per-frame log-normalisation (a double-log: log in the index *and* the ramp) because it had computed `colorScale ≈ 95` "at default settings" and concluded a single hit would saturate the ramp — but that was evaluated at `points = 5500`, where **the accumulator never runs**. In the regime where it *does* run (`points > 6000`), `colorScale` is much smaller and is exactly calibrated for it: simulated at `points = 200000`, attractors span the full ramp (≈ 3..149) with bright cores saturating and dim filaments at the low end. So the faithful fixed `colorScale` is restored and the invented normalisation removed.

**The accumulator path is a STRUCTURAL transcription and should be verified against the live binary** (`-points 500000 -delay 0` and the default-ish `-points 50000`) for overall exposure, the motion-blur trail length, and the boredom-acceleration cadence.

## Deviations from the C (true, remaining)
- **`uint16` accumulator, no wraparound.** The C's bloom/IIR field is `PIXEL0` = `uint16`, so it *wraps* at 65536; this port uses `Float32` (no wrap). Only matters at pathological density (the wrap would flip a bright core dark), and the `numCols−1` clamp masks most of it. The non-wrapping behaviour is visually cleaner; low severity.
- **Box-blur bloom.** The C does an incremental, separable O(1)-per-pixel box blur of radius `pointSize`; this port does a direct `pointSize × pointSize` block sum (identical result, O(pointSize²) per pixel — a single read at the default `pointSize = 1`). Both expand right/down, matching the C's in-place direction.
- **Retina point size.** The C triples `pointSize` past 2560 px; this port scales it by `devicePixelRatio` instead. `pointSize` is a *size* (device px), so dpr-scaling is correct, and `colorScale`'s `W·H/pointSize²` keeps the look dpr-invariant.
- **No threads / no XShm.** The C splits the accumulator across worker threads and blits via shared memory; here it's a single JS loop + `putImageData`. Pure performance plumbing, no visual effect (the per-thread `accMap`s sum to the same field this port builds directly).
- **Fixed-point in doubles.** PRM is a 32-bit `int` in the C; JS numbers are doubles, so the polynomial products (which can exceed 2³¹) stay exact, and `>>UNIT_BITS` is `Math.floor(v/UNIT)` (= the C's arithmetic shift, incl. for negatives). The X3 projective divide uses the C's `(Tmp_x·UNIT)/Tmp_z0` fallback form rather than the `HAVE_INTTYPES_H` `(1<<30)/Tmp_z0` form (negligibly different rounding). The `& (UNIT2−1)` fold index is applied to a value first coerced with `|0` (always in range there).
- **RNG.** The C uses three PRNGs (`NRAND`/`GOODRND`/`CHEAPRND`) for thread-safety and speed; the only randomness reaching the picture is the ±4 jitter and the coefficient draws, so a plain `Math.random` stream is faithful in distribution.
- **`Tmp_z0 == 0` guard** kept verbatim (the C's `-curve 9` corner): `if (tz0 === 0) tz0 = 1`.

## Motion / cadence
Matches the C. Both renderers continuously redraw; the motion is the coefficient drift + reroll (and, in the accumulator, the IIR trail). Drift cadence: the simple path leaves `Speed = 4` (the `VARY_SPEED_TO_AVOID_BOREDOM` block lives in the accumulator branch) and the bbox "boring" test is **dead** there because `Ly < 0` makes `(ymax−ymin < Ly·0.2)` always false — so `Count += 4` steadily, committing/rerolling every 250 frames. The accumulator runs `VARY_SPEED` (the live branch is `pixelCount < W·H/1000` → accelerate `Speed` toward 32, else reset to 4), then *also* runs the shared bottom drift block — so the accumulator advances `Count` by `2·Speed` per frame (a faithful quirk of the C's two `Count += Speed` sites). `Col++` once per frame in both.

## Config
Mirrors `hacks/config/strange.xml` 1:1: `delay` (µs/frame, inverted), `curve`, `points`, `pointSize`, `zoom`, `brightness`, `motionBlur`, `ncolors` — same names, defaults, ranges. `delay`/`zoom`/`brightness`/`motionBlur` are live; `curve`/`points`/`pointSize`/`ncolors` reinit (they pick the map, switch renderer across the 6000 line, size buffers, or size the palette). No invented sliders.

**Framerate calibration (`OVERHEAD = 8083`).** The stock `delay = 10000 µs` is only a sleep floor; the live binary's rate is lower (delay + framework overhead). The `-fps` overlay measures **55.3 fps** (the default simple swarm), while the port at the bare stock delay ran 100 steps/sec (1.81× fast), so the loop runs at `delay + OVERHEAD = 18083 µs → 55.3 steps/sec`. A calibration, not a tuning knob; the slider still maps 1:1 to the xml. See [[framerate-calibration]].

## Caveats / spot-check in browser
- **Default = the simple swarm.** Confirm it reads as discrete dots that swoop, twist, and recolour each frame (one colour at a time, cycling), with no glow/trails — *not* the dense accumulator field. Simulated: all `points` land in-bounds for fresh X2/X3 attractors (the world box is fixed to `[-UNIT, UNIT]` and `Lx/Ly` fill the canvas), zero NaN.
- **Crank Number of points past ~6000** to reach the accumulator (glow + optional motion-blur trails). This is the heavy path (a full `W×H` bloom + colour-map pass per frame, single-threaded); fine for moderate counts, slower toward 500000. Verify exposure/trails against the live binary.
- **First-frame X3 collapse:** roughly half of fresh attractors use X3, a fraction of those start collapsed to a tiny cluster for a moment before the boredom-acceleration drifts them out. Expected and transient.
