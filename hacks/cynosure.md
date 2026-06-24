# cynosure — port notes

Port of `cynosure.c` — Stephen Linhart's screensaver, written in Java by ozymandias G. desiderata (1996) and ported to C / XScreenSaver by Jamie Zawinski (1997). Random dropshadowed rectangles "pop onto the screen in lockstep": a randomly-sized grid of cells tiles the screen, one rectangle is placed at a random size/offset inside each cell, each row is a single drifting colour, and every so often the whole screen clears and a fresh pile begins.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/cynosure.c` (~457 lines)

## Algorithm
Each `step()` runs the C's `paint()` once — laying down one full **layer**:
- Grid size is `c_tweak(gridSize, gridSize/2)` per axis — i.e. `gridSize` cells wide/high, wobbled by +/- `gridSize/2` (so 6–18 with the default 12). Cell width/height = screen / cells, each floored at `MINCELLSIZE` (16px) with the cell count recomputed if a cell would be too small.
- **One colour per row**, chosen by `genNewColor()`, which drives a "sway" colour ramp: it keeps a base index that drifts by `+/- tweak` each call (`genConstrainedColor`), and every `c_tweak(sway, sway/3)` calls it snaps the drift centre to the most-recent index. `THRESHOLD` (1-in-100) of the time it jumps to a fully random hue instead. So rows are mostly a smooth gradient with occasional sparks.
- For each cell: a random rectangle size (`random() % (cell - shadowWidth)`, floored at `MINRECTSIZE` = 6px) at a random offset inside the cell. It's drawn in four passes — a dark (value-darkened) **shadow** offset by `elevation`, a black **edge** offset by `shadowWidth`, the solid **fill** (row colour), and a 1px black **border**.

`cynosure_draw()` (= `step()` here): increment a layer counter; every `iterations` (default 100) layers, clear the screen to a random palette colour and reset the counter; then paint one layer. The C returns `delay` from `cynosure_draw`, i.e. one full layer per delay interval — so the standard fixed-timestep lag-accumulator loop maps exactly (one `step()` per `config.delay`). `MAX_CATCHUP_STEPS` is lowered to 4 (each step paints a whole grid, so a deep catch-up burst would be expensive and visually pointless).

See [[squiral]] for the shared module skeleton (rAF lag accumulator, dpr sizing, `config`/`params`, pause/resume/reinit) and [[greynetic]] for the per-step `fillRect` rect-stamp idiom (the canvas is the persistent pile; nothing is read back).

## Palette
cynosure is a **native screenhack** that builds its colours with `make_smooth_colormap` (`cynosure.c` ~l.135): 2-5 random HSV anchor points interpolated into a closed loop of `ncolors` entries, re-rolled every run. The result is mostly **muted/pastel** gradients — one live run might be all browns/taupe, the next teal/green/blue with the odd vivid "sport" — **not** a clean spectrum. Ported faithfully via `colormap.js` `makeSmoothColormapRGB(n)` mapped to `rgb()` strings.

The earlier port used a fixed vivid `hsl(hue, 85%, 55%)` rainbow ramp (the **systemic vivid-rainbow bug** — neon and far more saturated than the live binary ever is). The C's colour-index logic (the "sway" base-colour ramp, the +/- `tweak` per-row drift, the 1%-random sport) was already faithful and is unchanged; only the index->RGB mapping was wrong. When `ncolors <= 2` the C goes `mono_p` (white fills, black shadows/edges) — mirrored here as the `n <= 2` branch.

**Shadow** = the C's **non-jwxyz** dropshadow path (`HAVE_JWXYZ` undefined — what the live X11 / XQuartz binary actually draws): each shadow colour is the fill colour with `value *= 0.4` (equivalently `rgb * 0.4` for fixed h,s), **opaque**. The earlier port used the Mac jwxyz `0x77`-alpha *translucent* path; switched to opaque-darkened to match the ground-truth binary, where stacked layers read as a solid dark bevel offset down-right by `elevation`.

## Timing
**Paint-and-hold.** Stock `*delay 500000` (.xml default 500000) = 0.5 s per painted layer, so the per-frame compute is a rounding error against the delay and there is **no OVERHEAD term** — `config.delay` is just the stock 500000 µs and the loop paces one `paint()` layer per delay. The live `-fps` overlay reads **FPS 1.8 / Load 11.8%** (delay-bound; nominal `1e6/500000 = 2` fps), confirming the pace. The earlier port's by-eye 600000 µs is reset to stock.

## Deviations from the C
- **Palette + shadow** are covered under **Palette** above (smooth colormap, opaque value*0.4 shadow). The `DO_STIPPLE` compile-time alternative (a 2-bit stipple shadow) is not built in the C and is not ported.
- **`elevation`/`shadowWidth`/border-width scaled by `devicePixelRatio`** (`S`) rather than the C's "double them if width or height > 2560" retina heuristic — same intent (keep the bevel/shadow visible on hi-DPI), expressed continuously.
- **One C quirk corrected**: in `paint()`, the C's `cellHeight < MINCELLSIZE` branch recomputes `cellsHigh = width / cellWidth` (copy-paste from the width branch — wrong axis). I use `cellsHigh = H / cellHeight`, so the bottom rows don't run off-screen when cells are clamped. Noted because it's a deliberate divergence from the source.
- **Modulus guards**: the C does `random() % (cell - shadowWidth)` and `random() % ((cell - cur) - shadowWidth)` without guarding the divisor; with the default clamps those are always positive, but I guard `range > 0 ? randInt(range) : 0` so an aggressive config (thick edges, tiny cells) can't divide by zero or go negative.
- **Border**: X11 `XDrawRectangle` strokes inclusive of `(x+w, y+h)`; rendered here as `strokeRect(x+0.5, y+0.5, w, h)` for a crisp 1px line on the device grid.
- **`delay` default 500000 µs** = the stock value (paint-and-hold; see **Timing**). **`iterations` is `live`** (the C re-reads it each draw too), as are the look knobs (gridSize/tweak/sway/elevation/shadowWidth); only `ncolors` is non-live (it sizes the palette → `reinit()`).

## Correctness self-review
- **No freeze / no infinite over-draw.** Both `paint()` loops are bounded by `cellsWide`/`cellsHigh`, which are derived from a finite screen size and clamped `>= 1`. The screen clears every `iterations` layers and `layer` resets to 0, so the pile never grows unbounded (unlike greynetic, which intentionally never clears — here clearing is the whole "lockstep" effect). `iterations > 0` is guaranteed (slider min 2), so the clear always fires.
- **Sway ramp resets correctly.** `timeLeft` counts down to 0, at which point it reloads via `c_tweak(sway, sway/3)` (>= 0, and since `sway >= 1` the tweak range `2*floor(sway/3)` can be 0 → `c_tweak` returns `sway` itself, never a stuck 0) and `curColor` snaps to `curBase`. `genConstrainedColor` always returns a valid `[0, ncolors)` index (the `while (i < 0) i += n` wrap is preserved). `init()`/`reinit()` seed `curColor = curBase = timeLeft = 0` so the first frame's ramp starts clean.
- **First frame looks right.** `paint()` fills the whole grid immediately (no RNG-seeded geometry that could start degenerate/off-screen); the very first `step()` lays a complete layer.
- **pause/resume** uses the shared `rafId === 0` sentinel + `lastTime = 0` reset, so resuming doesn't fire a catch-up burst. **reinit** clears to black and re-seeds the ramp — a clean fresh screen.
- **Spot-check in browser:** confirm the dropshadows read as a 3D bevel (shadow + black edge + fill) rather than mud, and that the periodic full-screen clear-to-a-colour is visible roughly every `iterations` layers. With `ncolors` low (2) it should go near-monochrome; with `tweak` high the rows should jump around more.
