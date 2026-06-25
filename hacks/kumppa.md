# kumppa — port notes

Port of `kumppa.c` by Teemu Suutari (1998) — "Spiraling, spinning, and very, very fast splashes of color rush toward the screen." Fresh color is injected near the center every step, then the *entire framebuffer* is spun and zoomed slightly outward about the center, so every mark gets pulled into a spiral streak racing off the edges. See [[squiral]] for the shared skeleton this follows and [[greynetic]] for the scratch-canvas idiom.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/kumppa.c` (~545 lines, much of it the elaborate integer rotation tables).

## Algorithm
Two looks, chosen by the `random` resource:
- **cosilines ON (default)** — eight oscillators with fixed phase increments and amplitudes (the C's `cosinus[8][6]` table) drive four wandering line endpoints. Each step every line is drawn from its previous endpoint to its new one, cycling through the color ramp. The result is smooth Lissajous ribbons.
- **cosilines OFF** — eight random small colored squares are splatted within ±16px of the center each step (`Satnum` placement, `fgc[Satnum(50)]` color, with indices ≥32 falling back to the black background, so some splats punch holes).

Either way a small black square is stamped dead-center (`fgc[32]`, the background) so the very core never bakes to a solid blob, and then the framebuffer is spun+zoomed by `rotate()`.

The `rotate()` / `make_rots()` machinery in the C is a hand-rolled, fixed-point pixel-shuffle: `make_rots()` precomputes which screen columns/rows map where for a small rotation+outward-scale about `(midx,midy)`, parameterized by `speed` (`rotsizeX = 2/speed + 1` = how many steps it takes to sweep the rotation across the half-width), and `rotate()` `XCopyArea`s the window onto itself through that mapping. Higher `speed` = bigger spin/zoom per step = faster outward streaking. The xml mislabels `speed` as **"Density"**; it is really the spin/zoom rate.

## Shared skeleton (inherited)
Standalone ES module exporting `title` + `start(canvas) → { stop, pause, resume, reinit, config, params }`; rAF **lag-accumulator** loop at fixed timestep (`config.delay` µs) replacing the C's `usleep`; `devicePixelRatio` folded into a `pscale` (mark/line size) and the backing store sized in device px; vivid HSL ramp; descriptive names.

## Deviations from the C
- **Canvas self-feedback replaces the X11 pixel-shuffle (the load-bearing one).** There is no canvas equivalent of `XCopyArea`-onto-self through an arbitrary transform, and re-deriving `make_rots()` would reproduce 200 lines of fixed-point table-building for no visible gain. Instead each step copies the current frame into a **scratch canvas**, then redraws it back onto the main canvas through `ctx.translate(cx,cy) / rotate(theta) / scale(z) / translate(-cx,-cy) + drawImage(scratch)`. The scratch copy is required because `drawImage` cannot safely read and write the same canvas through a transform. `drawImage`'s bilinear sampling *is* the smear. New marks are then painted on top — same visual cause-and-effect as the C, just via canvas transforms instead of an integer rotation table.
- **`speed → (theta, z)` mapping.** `theta = speed * 0.6` rad/step (≈5.7°/step at the default 0.1 — a lively spin that still reads as a spiral, not a blur), `z = 1 + speed * 0.16` (≈1.016 outward zoom at default; ≈1.032 at max 0.2). These were tuned so the look matches the C's "rushing outward" feel across the full 0.0001–0.2 range. The xml's "Density" label is kept (mapped to `speed`) so the config box matches the original, with a clarifying note here.
- **Color ramp.** The C hardcodes a 32-entry blue→cyan→green→yellow→red→magenta→violet ramp. Reproduced as a resizable vivid HSL wheel starting at hue 240 (blue) and sweeping a full turn, exposed as `ncolors` for parity with the other ports.
- **Retina scale.** The C triples line width on >2560px displays; folded into `pscale` as a ×1.5 bump (×3 over-dominated the canvas port) on top of the dpr.
- **Encoding.** `µs` in the Frame-rate slider unit is written `µs` (no literal non-ASCII in a rendered string); em-dashes/`µ` appear only in comments.
- **Calmer default.** Same 10000 µs default as stock; the lag accumulator paces it identically at any refresh rate.

## Correctness self-review
The risk for a self-feedback hack is the loop running away to **all-black** (content collapses to the center) or **all-white / flat** (content saturates). Traced:
- **No black-hole collapse:** the zoom is strictly `z > 1` (1.016–1.032), so every frame the existing image is pushed *outward* and eventually off the edges — it can never shrink inward to a point. Pixels sampled from outside the source canvas come back transparent (a `drawImage` no-op), so the borders keep feeding in from black rather than smearing a frozen edge color inward.
- **No white-out:** `z` is only fractionally above 1, so each output pixel is resampled from a *nearby* (slightly smaller) source neighborhood — energy disperses outward rather than piling up. The only color *added* per step is the handful of center marks plus a central **black** stamp, so the core is continuously refreshed instead of baking solid. Over thousands of frames the screen reaches a moving steady state (spiral streaks in, fade out at the rim), not a flat field. Verified by reasoning about the fixed point: average brightness is bounded by (input per step) / (1 − fraction retained on-screen), and with content exiting the frame the denominator stays well away from 1.
- **State re-seeding:** `reinit()` resets the transform to identity, clears to black, and re-runs `init()`, which rebuilds the scratch canvas, zeroes `acos`/`coords`/`ocoords`/`drawCount`, and rebuilds the palette — a clean fresh screen with no stale oscillator phase or leftover transform. `resize()` does the same and re-derives `cx,cy`/`pscale` for the new size (matching the C's `kumppa_reshape`, which resets `midx,midy` and the rotation state).
- **Pause/resume:** `pause()` cancels rAF (`rafId = 0` sentinel); `resume()` resets `lastTime = 0` before re-arming so no catch-up burst fires — the spin simply continues from the frozen framebuffer.
- **`ctx` transform hygiene:** every `feedback()` is wrapped in `save()/restore()`, and `resize()`/`reinit()` call `setTransform(1,0,0,1,0,0)` before clearing, so a transform can never leak into the flat fills or the mark drawing (which assume identity).
- **Index math:** the C's `((a<<2)+draw_count)&31` color walk is reproduced with a floored modulo over `colors.length` (resizable), so it stays in range for any `ncolors`; the splat path maps clamp-high indices (≥32) to black exactly as the C maps them to `fgc[32]`.

## Config
Mirrors `hacks/config/kumppa.xml`: `delay` (µs/step, 10000, `invert:true` Frame-rate slider showing raw µs), `speed` (0.0001–0.2, default 0.1 — labelled **Density** in the xml; it is the spin/zoom rate, `live`), `random` (smooth-lines toggle, default on, non-live → `reinit`). `ncolors` (32) is added for parity. `live: true` keys (`delay`, `speed`) are read every step; `live: false` keys (`random`, `ncolors`) size the look/palette so a change re-runs `init()` via `reinit()`.

**Local dev:** ES-module imports mean `file://` double-click won't load it (CORS on the `null` origin). Serve it — `python3 -m http.server`, then <http://localhost:8000/#kumppa>. GitHub Pages serves over http, so production is unaffected.
