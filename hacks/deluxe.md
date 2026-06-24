# deluxe — port notes

Port of `deluxe.c` (Jamie Zawinski, 1999) — a small pool of "throbbers" that pulse concentrically from the centre of the screen: stars, circle outlines, paired horizontal/vertical lines, and bracket-corner frames, drawn as thick translucent outlines that overlap where they cross. See [[piecewise]] and [[interaggregate]] for the translucent-overlapping-shapes idioms, and [[squiral]] for the shared skeleton.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/deluxe.c` (479 lines), config `deluxe.xml`.

## Algorithm
A fixed pool of `count` throbbers (default 5). Each throbber is **centred at the middle of the screen** `(W/2, H/2)` — they are *not* placed at random points (verified in `make_throbber`; the spawn-prompt hint of "random points" does not match the source). A throbber holds:
- a `size` that oscillates between `thickness/2` (low) and `max_size` (= `max(W,H)`, ×1.5 for circles),
- a constant-magnitude `speed` (always stored negative; ~8..15 for the default speed 15, then ×dpr),
- a `fuse` of 1..4,
- a random shape (`draw_star` 4/11, `draw_circle` 4/11, `draw_hlines` / `draw_vlines` / `draw_corners` 1/11 each) and a random colour.

`throb()` each frame: `size += speed`; if it drops to `thickness/2` it reverses (with the C's `size += speed*2` overshoot correction); if it exceeds `max_size` it reverses **and burns a fuse**. When the fuse hits 0 the throbber dies and the pool slot is re-seeded with a fresh random shape/colour/speed (the C `free`s and `make_throbber`s a replacement). At seed time, 3/4 of throbbers start at `max_size` (shrinking inward) and 1/4 start at `thickness` with the speed flipped positive (growing outward).

The whole frame is **cleared to black and redrawn every step** (the C's `erase_gc` `XFillRectangle`), so throbbers leave no trails; the effect is the translucent outlines overlapping where they cross within a single frame.

## Blend / transparency (faithful)
The C's `transparent` resource defaults **on** (`arg-unset="--no-transparent"`). On jwxyz/macOS — the platform the demo video and almost all users see — `make_throbber` gives each colour a non-opaque alpha of `0xCC ≈ 0.8` and draws with ordinary source-over compositing (`jwxyz_XSetAlphaAllowed`). This port reproduces that **exactly**: `globalAlpha = 0.8`, `globalCompositeOperation = 'source-over'`, no additive blending — so a crossing shows the top colour at 80% over what is beneath, it does **not** blow out to white. The **Transparency** checkbox (default on) maps to the resource; off draws fully opaque shapes (the C's `-no-transparent`/`-opaque` path, `globalAlpha = 1`).

There is **no XOR / GC raster op** in `deluxe.c` (the GC function is the default `GXcopy`). The only other compositing branch is the non-jwxyz X11 path, which uses plane-mask transparency (`allocate_alpha_colors`); canvas has no plane-mask equivalent, so it is approximated by the same `0.8` alpha. The jwxyz alpha path is the canonical look and is reproduced bit-faithfully.

## Palette (faithful)
The C builds the colour table **once** in `deluxe_init` via `make_random_colormap(..., bright_p=True, ...)` and never cycles or rebuilds it. With `bright_p`, each of `ncolors` entries is an independent random **HSV**: hue `0-359`, saturation `30-99%`, value `66-99%` (`utils/colors.c`) — bright but **frequently pastel**, *not* a fully-saturated rainbow. This is ported inline (a faithful `hsv_to_rgb` matching `hacks/colormap.js`, plus the X server's 16→8-bit channel downsample); `make_random_colormap` is not a ramp, so it is generated here rather than via a `colormap.js` helper (see Shared-helper note). `ncolors < 2` falls back to **mono white**, exactly as the C's `goto MONO` (foreground = white).

> Earlier this port used `hsl(hue, 100%, 55%)` — fully-saturated vivid hues — which was the "vivid house style" deviation flagged in project memory. That has been replaced with the C's bright-HSV distribution.

## Rendering approach
Sparse vector. Each throbber is one (or, for corners, four) `ctx.beginPath()` → `ctx.stroke()` path with `lineWidth = thickness·dpr`, `lineCap = 'square'` (X11 `CapProjecting`), `lineJoin = 'miter'` (X11 `JoinMiter`). The star, circle-arc, line, and corner geometry are ported directly from `draw_star` / `draw_circle` / `draw_hlines` / `draw_vlines` / `draw_corners`. Sizes, speeds, and line widths are scaled by `devicePixelRatio` (`S`) and the backing store is sized in device px, so the geometry is crisp and the step count is dpr-independent (`max_size/speed = maxCss/speedval`).

## Config (mirrors deluxe.xml)
The config box exposes exactly the xml's sliders/toggles: **Frame rate** (`delay`, inverted), **Lines** (`thickness`), **Shapes** (`count`), **Number of colors** (`ncolors`), **Transparency** (`transparent`). `showfps` is handled by the host's own framerate readout, not a hack param.

## Deviations from the C
- **`speed` is a fixed internal value.** `speed` is a real resource the C reads (default 15, in `deluxe_defaults`/`deluxe_options`) but it is **not** in `deluxe.xml`, so it is not exposed as a slider here; it is kept at the C default 15 internally. (The `random() % speed` jitter is guarded `≥ 1` against the C's latent divide-by-zero at speed 0.)
- **Retina line width.** The C bumps `thickness *= 3` when the window exceeds 2560 px; this port uses the uniform `×devicePixelRatio` scaling used across the gallery (same intent, dpr-correct).
- **`delay` → rAF lag-accumulator** (microseconds), identical pace at any refresh rate, with a catch-up cap. Default is the stock `10000 µs` (the slider maps 1:1 to the xml resource; range `0–50000 µs` matches the xml). The loop adds `OVERHEAD = 8083 µs` so `(delay + OVERHEAD)` reproduces the live binary's effective rate: measured against the live `-fps` overlay deluxe runs **55.3 fps**, while the port at the stock delay ran ~100 fps (1.8× fast); `10000 + 8083 = 18083 µs → 55 fps`. A calibration, not a tuning knob — see the framerate-calibration note.
- **X11 plane-mask transparency** is approximated by the jwxyz `0.8` alpha (canvas has no plane masks); see Blend above.
- No trails / no background colour cycling: the C hard-clears to black each frame and never animates the background — this port matches that (no `fade`, no colour rotation).

## Correctness self-review
- **Blend & palette verified headless.** A mocked-canvas harness (3000 steps, default config) confirmed every shape is drawn at `globalAlpha = 0.8`, `source-over`; switching `transparent` off gives `globalAlpha = 1`; the palette is rgb() strings with most entries `sat < 0.9` (pastel, not vivid) and max channel in `[171, 253]` (the V `66-99%` floor), confirming the bright-HSV distribution rather than the old full-saturation ramp. Param keys = `count, delay, ncolors, thickness, transparent` (the xml set); `delay` max = 50000.
- **Pool always recycles, never freezes / never empties.** Every throbber oscillates between two finite bounds with a constant nonzero `|speed|`, so it reaches `max_size` repeatedly; each top bounce decrements `fuse`, so `fuse` reaches 0 and the slot is re-seeded with all fields the draws read.
- **Re-seed sets everything.** `makeThrobber()` sets `x, y, maxSize, thickness, speed, draw, size, fuse, color` — every field `throb`/draw reads — so a recycled slot is never half-initialised.
- **No divide-by-zero / degenerate radius.** `speed` clamped `≥ 1`; `drawCircle` early-returns on `r ≤ 0`; `maxSize > 0` since `W,H > 0`.
- **Seeding matches the C.** The pool seeds each throbber at an extreme (`max_size` or `thickness`) exactly as `deluxe_init` does — the previous artificial first-frame phase-spread was removed; the pool desyncs on its own within ~1–2 s as per-shape speeds differ and fuses expire at different times.
- **Star path closes correctly.** The loop's `k = 10` lands on the even (outer) radius at angle `o + 2π ≡ o`, exactly reproducing the C's `points[10] = points[0]`.
- **Pause/resume / reinit.** `pause()` parks `rafId = 0`; `resume()` resets `lastTime = 0` so the banked `lag` can't burst. `reinit()` clears to black and re-seeds with the current config (`count`/`thickness`/`ncolors` are `live: false`, so they take effect via reinit; `delay`/`transparent` are `live: true`).

## Shared-helper note
`make_random_colormap` (bright-HSV, per-entry random) has no helper in `hacks/colormap.js` (which exports `makeSmoothColormapRGB` / `makeColorRampRGB` only), so it is inlined here. A shared `makeRandomColormapRGB(ncolors, brightP)` would let several hacks that call `make_random_colormap` share one faithful implementation — flagged for the maintainer; not added here (shared file, parallel-write-unsafe).

## Residual risk
- The jwxyz alpha is reproduced exactly; the **non-jwxyz X11 plane-mask** look is only approximated (no canvas equivalent). The macOS/jwxyz path is the canonical reference, so this is low-risk.
- Sizes are floats here vs ints in the C; the half-thickness bounce threshold can differ by one sub-pixel step for odd `thickness·dpr`. Visually negligible.
