# deluxe — port notes

Port of `deluxe.c` (Jamie Zawinski, 1999) — a small pool of "throbbers" that pulse concentrically from the centre of the screen: stars, circle outlines, paired horizontal/vertical lines, and bracket-corner frames, drawn as thick translucent outlines that glow where they cross. See [[piecewise]] and [[interaggregate]] for the translucent-overlapping-shapes idioms, and [[squiral]] for the shared skeleton.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/deluxe.c` (479 lines), config `deluxe.xml`.

## Algorithm
A fixed pool of `count` throbbers (default 5). Each throbber is **centred at the middle of the screen** `(W/2, H/2)` — they are *not* placed at random points (verified in `make_throbber`; the spawn-prompt hint of "random points" does not match the source). A throbber holds:
- a `size` that oscillates between `thickness/2` (low) and `max_size` (= `max(W,H)`, ×1.5 for circles),
- a constant-magnitude `speed` (always stored negative; ~8..15 for the default speed 15, then ×dpr),
- a `fuse` of 1..4,
- a random shape (`draw_star` 4/11, `draw_circle` 4/11, `draw_hlines` / `draw_vlines` / `draw_corners` 1/11 each) and a random colour.

`throb()` each frame: `size += speed`; if it drops to `thickness/2` it reverses (with the C's `size += speed*2` overshoot correction); if it exceeds `max_size` it reverses **and burns a fuse**. When the fuse hits 0 the throbber dies and the pool slot is re-seeded with a fresh random shape/colour/speed (the C `free`s and `make_throbber`s a replacement). At seed time, 3/4 of throbbers start at `max_size` (shrinking inward) and 1/4 start at `thickness` with the speed flipped positive (growing outward).

The whole frame is **cleared to black and redrawn every step**, so throbbers leave no trails; the effect is the translucent outlines overlapping where they cross within a single frame.

## Rendering approach
Sparse vector. Each throbber is one (or, for corners, four) `ctx.beginPath()` → `ctx.stroke()` path with `lineWidth = thickness·dpr`, `lineCap = 'square'` (X11 `CapProjecting`), `lineJoin = 'miter'` (X11 `JoinMiter`). The star, circle-arc, line, and corner geometry are ported directly from `draw_star` / `draw_circle` / `draw_hlines` / `draw_vlines` / `draw_corners`. Sizes, speeds, and line widths are scaled by `devicePixelRatio` (`S`) and the backing store is sized in device px, so it is crisp and dpr-independent in step count.

## Deviations from the C
- **Transparency / blend.** The C's `transparent` default uses X11 plane-mask compositing on real X11 and, on jwxyz (macOS), real alpha `0xCC ≈ 0.8` with normal source-over. This port defaults to **additive `globalCompositeOperation = 'lighter'`** at `opacity` 80% so crossings *glow* (the gallery's vivid house style). An **"Additive glow"** checkbox turns this off to fall back to faithful source-over (≈ the jwxyz look). Canvas has no X11 `GXxor` raster op; the additive/alpha blend is the deliberate stand-in, never a silent drop of the look. The non-jwxyz plane-mask path is not reproducible in canvas and is approximated the same way.
- **No background colour cycling.** The C's background is a fixed black erase each frame (`erase_gc`); there is no background colour animation in `deluxe.c`. This port matches that (the brief's "background may cycle" hazard does not apply here).
- **Opening desync (`init` only).** The C seeds every throbber at an extreme (`max_size` or `thickness`), so on the very first frames they animate in lockstep. To satisfy "frame 1 shows several shapes mid-expansion," the *initial* pool gets a random `size` in `[thickness/2, max_size]`; re-seeds keep the C's extreme-start, and the pool desyncs naturally as fuses expire at different times.
- **`speed` exposed + div-by-zero guard.** `speed` is a hidden resource in the C (default 15, not in the xml); it is exposed here as "Pulse speed" and clamped to `≥ 1` to avoid the C's latent `random() % speed` divide-by-zero when speed is 0.
- **Added knobs** beyond the stock xml (which exposes only frame rate, lines/thickness, shapes/count, colours, transparency, fps): `opacity`, `fade` (optional trails — `0` = the C's hard clear), and the `glow` toggle. The retina `thickness *= 3` branch is replaced by the uniform `×dpr` scaling used across the gallery.
- **`delay` → rAF lag-accumulator** (microseconds), identical pace at any refresh rate, with a catch-up cap; stock default `10000 µs` eased to `15000 µs`.

## Correctness self-review
- **Pool always recycles, never freezes / never empties.** Every throbber oscillates between two finite bounds with a constant nonzero `|speed|`, so it is guaranteed to reach `max_size` repeatedly; each top bounce decrements `fuse`, so `fuse` reaches 0 and the slot is re-seeded with all fields the draws read. Verified with a headless harness (200k steps, 5-throbber pool): **1024 re-seeds**, `size` bounded to `[50.9, 5760]`, **no NaN/Inf**, **no zero-speed**, shape distribution ≈ 4/4/1/1/1 per 11 as in the C.
- **Re-seed sets everything.** `makeThrobber()` sets `x, y, maxSize, thickness, speed, draw, size, fuse, color` — every field `throb`/draw reads — so a recycled slot is never half-initialised.
- **No divide-by-zero / degenerate radius.** `speed` clamped `≥ 1` (harness: speed=1 → all finite & nonzero); `drawCircle` early-returns on `r ≤ 0`; `maxSize > 0` since `W,H > 0`.
- **First frame is non-degenerate.** Colours and pool are built in `init()` before the first `step()`; initial sizes are spread across the pulse range so multiple shapes are visibly mid-expansion immediately.
- **Pause/resume / reinit.** `pause()` parks `rafId = 0`; `resume()` resets `lastTime = 0` so the banked `lag` can't burst. `reinit()` clears to black and re-seeds with the current config (count/thickness/speed/colours are `live: false`, so they take effect via reinit; delay/opacity/fade/glow are `live: true`).
- **Star path closes correctly.** The loop's `k = 10` lands on the even (outer) radius at angle `o + 2π ≡ o`, exactly reproducing the C's `points[10] = points[0]`.
