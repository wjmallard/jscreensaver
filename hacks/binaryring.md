# binaryring — port notes

Port of `binaryring.c` (Emilio Del Tessandoro, 2006–2014), after J. Tarbell's "Binary Ring" (complexification.net, 2004).

Original: <https://www.jwz.org/xscreensaver/> · source: `binaryring.c` (~576 lines)

## Algorithm
Particles emitted around a ring at the centre drift through a flow field: each step the velocity is nudged by a random `curliness` (the C's hardcoded `0.5`), and the segment just travelled is drawn — **mirrored left/right across the vertical centre** — as a low-alpha (0.15) line. Particles die at `maxAge` and are reborn on the ring with zero velocity (initial creation instead gets velocity `2` outward). An "epoch" flips occasionally (`random % 10000 > 9950`, ~0.5 %/frame) between **light** — where new/reborn particles take the current light colour, which slowly random-walks — and **dark** (black), whose particles paint black and so *erase* the accumulated image. So the field alternately builds up and fades.

## Palette — a white random-walk, NOT a rainbow
The C has exactly two colours: `colors[BLACK]` = black and `colors[WHITE]` = white; with `color` (Fade with colors) on it random-walks the *light* one by `±2` per channel each time a particle is created or reborn (`next_color`), clamped to `[0,255]`. There is **no** colormap / hsv / hue math — the port keeps `colorsRGB = [[0,0,0],[255,255,255]]` and walks index 1 directly (equivalent to the C's pack/unpack round-trip). The walk is **unbiased**: a 4000×8000-step simulation gives equal per-channel means (≈160) and ~⅓ dominance each for R/G/B, so a run settles on a random desaturated tint that slowly drifts through hues — matching the live binary (per-run colour differs; the "greenish core" shared across captures is coincidence, not bias).

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — blit with Xiaolin Wu antialiasing
Thousands of tiny segments per frame, each **alpha-accumulated** into a persistent `Uint32` buffer (read-blend-write per pixel) — per-pixel compositing, not vector strokes (~10k `stroke` calls/frame otherwise). One `putImageData` per frame. This is the **documented exception** to "use canvas vector ops for line/curve" — the work is per-pixel accumulation, not stroking. The raster is the C's **`draw_line_antialias`** (the `#define ANTIALIAS 1` default): Xiaolin Wu's algorithm, each pixel blended at `coverage × 0.15` through the same `draw_point` lerp (`new = old + (target-old)·a`), truncating toward zero (`| 0`) exactly like the C's `(int)` casts. Endpoints use the C's **hard clip** — if *either* endpoint is off-window the whole segment is dropped, so nothing draws across the edge. Zero-length segments (the first step after a zero-velocity rebirth) draw nothing, matching the C (its `NaN → (int) →` out-of-bounds).

## Deviations from the C
- Physics scaled by `devicePixelRatio` (`S = dpr`): ring radius, the `2.0` initial velocity, and the `0.5` nudge are all `× S`, so the ring + motion look the same size on retina. All draw coords are device px.
- Keypress colour-flip (`binaryring_event`) dropped — the host owns keys.
- The earlier port used the C's **non-AA** Bresenham path (`ANTIALIAS=0`) and by-eye **ms** pacing; both were fixed in the **2026-07-01 fidelity audit** (Wu-AA raster to match the C default; µs pacing; stock `particles` restored; invented Curliness slider dropped).

## Config — mirrors binaryring.xml
`delay` (**Growth delay**, µs, *no* invert — mirrors the xml's raw "Growth delay" Low→High, unlike substrate's inverted "Frame rate") · `ringRadius` (**Ring radius**, 0–400) · `particles` (**Particles**, 500–20000, `reinit` — a count change rebuilds the pool) · `maxAge` (**Path length**) · `color` (**Fade with colors**); all but `particles` are live. `maxAge` is the real `--max-age` resource (default 400) that the stock settings UI omits — kept, like substrate's `--max-cracks`. The old **Curliness** slider was **removed** as invented: the C hardcodes `st->curliness = 0.5`, it is not an Xrm resource (Rule 3).

## Speed
`delay` = the stock `growth_delay` **10000 µs** (xml default; range 0–100000). The rAF lag-accumulator paces one step per **(delay + OVERHEAD)** (µs → ms), matching `substrate.js`. `OVERHEAD` is the live-measured **13600 µs** (live 42.4 fps, Load 57.6%, clean at stock delay 10000); binaryring's per-frame draw is unusually heavy for a sparse vector hack (5000 particles × 2 Wu-AA segments ≈ 10k rasters + a full-buffer `putImageData`), which is why it lands well above the sparse-hack norm. `particles` default restored to the stock **5000** (was 4000).
