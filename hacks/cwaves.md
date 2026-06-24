# cwaves — port notes

Port of `cwaves.c` by Jamie Zawinski (2007) — "a field of sinusoidal colors languidly scrolls." Smooth horizontal-looking colour bands made from a sum of vertical sine waves; advancing each wave's phase a little every frame makes the bands slide and breathe. See the style reference [[squiral]] and the blit twins [[interference]] / [[moire]].

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/cwaves.c` (~219 lines, of which the live render is ~20).

## Algorithm
`nwaves` sine waves are seeded once, each with a low spatial frequency `scale` (`frand(0.03)+0.005`), an initial phase `offset` (`frand(PI)`), and a small signed per-frame phase drift `delta` (`(BELLRAND(2)-1)/15`). Each frame:

1. Every wave's `offset += delta` (this is the whole animation — the waves drift out of phase with one another).
2. For each column `x` (stepping by `scale`/band-width), `v = (1/nwaves) * sum_i cos(x*scale_i - offset_i)`, giving a value in `[-1, 1]`.
3. `j = ncolors * (v/2 + 0.5)` indexes a smooth colormap, and the C fills the full-height strip `(x, 0, scale, height)` with `colors[j]`.

So it is really a 1-D colour field (one colour per column) stretched into vertical bars; there is no 2-D geometry. The C also has a `--debug` mode that overplots the individual wave curves — not ported (debug-only, never on by default).

## Rendering
Because every column is a single flat colour spanning the whole height, the field is computed into a `cols x 1` Uint32 `ImageData` (one packed colour per column), `putImageData`'d onto a 1-row offscreen canvas, then `drawImage`'d up to the full backing store with `imageSmoothingEnabled = false`. The GPU stretches each column into its vertical strip — the canvas analogue of the C's per-column `XFillRectangle(x, 0, scale, height)`, and far cheaper than per-pixel since the field is only `cols` wide and 1 tall. Same Uint32-over-ImageData idiom as [[interference]]/[[moire]], reduced to one dimension.

## Deviations from the C
- **Palette**: faithful — uses `colormap.js`'s `makeSmoothColormapRGB(ncolors)`, the exact port of the C's `make_smooth_colormap(..., True, 0, False)` (a random 2-5 anchor HSV loop, frequently muted/pastel, closed so it wraps back to its start). Built **once per `init()`/`reinit()`**, matching the C's cadence (`make_smooth_colormap` is called once in `cwaves_init`, and re-rolled only on an interactive event). The field is continuous and the map is closed, so adjacent bands blend with no seam. (An earlier version of this port used an ad-hoc vivid HSL rainbow over ~50 knots — replaced for fidelity to the muted original.)
- **`abort()` -> clamp**: the C `abort()`s if `j` ever lands outside `[0, ncolors)`. `v` can only reach exactly `+/-1` if every cosine aligns perfectly, so instead of crashing we clamp `j` to `[0, ncolors-1]`. Behaviourally identical in practice (the bound is essentially never hit) and safe at the edge.
- **Band width / dpr**: the C's `waveScale` (the strip drawing width) is folded with `devicePixelRatio` (`strip = round(scale * dpr)`) so bands keep a consistent CSS size on retina. The cosine **frequency**, however, is driven by CSS-px x (`x = c * scale`), *not* the device-px strip position, so band density is dpr-independent and matches the 1x C look (driving the cosine with device-px x would double the band density on retina). The xml omits this slider (it only exposes `--waves` and `--colors`); we surface it as "Band width" because it is a real `--scale` option in the C and controls how crisp/chunky the bands look.
- **Pacing**: the C returns `delay` from each draw (`usleep`-style). We use the shared rAF lag-accumulator so the pace is identical at any refresh rate, with a catch-up cap so a backgrounded tab doesn't burst. One `step()` == one `offset += delta` advance == one C draw, so the drift speed matches frame-for-frame at the same delay.
- **Framerate calibration (`OVERHEAD = 8090`)**: `delay` keeps the xml's stock **20000 µs** (1:1 with the resource), but that is only a sleep floor — the live binary's real rate is lower (delay + framework overhead). The live cwaves measures **35.6 fps**, while the port at the stock delay ran 50 steps/sec (1.4× fast); the loop adds `OVERHEAD`: `20000 + 8090 = 28090 µs → 35.6 steps/sec`, matching the live binary. See the framerate-calibration note.

## Config
Units/defaults mirror `hacks/config/cwaves.xml`: `delay` (µs/frame, 20000, inverted "Frame rate" slider), `nwaves` ("Complexity", 1–100, 15), `ncolors` ("Color transitions", rough→smooth, 2–1000, 600). Added `scale` ("Band width", fine→coarse, 1–16, 2) for the C's `waveScale`.
- **`live: true`** (`delay`): the loop reads it every frame, applies instantly.
- **`live: false`** (`nwaves`, `ncolors`, `scale`): each resizes the waves array, colormap, or strip buffer, so a change re-runs `init()` via `reinit()` (which also clears + re-seeds, giving fresh waves and a fresh colormap).

## Correctness self-review
- **No termination/closure state machine** — cwaves never resets or restarts; it runs one unconditional `offset += delta` then repaints, forever. There is nothing to get stuck in, no "dead line" or over-draw failure mode. The only per-step work is a bounded loop over `cols` columns and `nwaves` waves.
- **Index safety**: `v` is the mean of `n` cosines, so `v ∈ [-1, 1]`, `v/2 + 0.5 ∈ [0, 1]`, `j ∈ [0, ncolors]`. The single out-of-range value (`j == ncolors` at `v == 1`) is clamped, so the palette read is always in bounds — no crash, no wrap artefact.
- **Drift never diverges visually**: `offset` grows without bound over time, but it only feeds `cos(...)`, which is periodic, so there is no precision blow-up or visual drift to a degenerate state across long runs.
- **First frame is valid**: `init()` seeds the waves and the colormap and calls `render()` before the rAF loop starts, so frame 0 already shows the full band field (no blank flash, no off-screen/degenerate start).
- **pause/resume**: `pause()` cancels the rAF and sets `rafId = 0`; `resume()` resets `lastTime = 0` before re-arming, so the lag accumulator doesn't fire a catch-up burst of phase advances after a pause. Since the waves' state is just their phases, pausing freezes the bands and resuming continues smoothly.
- **reinit**: clears to black and rebuilds waves + colormap + strip buffer — a clean fresh screen with a new random palette and new wave set.
