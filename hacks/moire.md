# moire — port notes

Port of `moire.c` by Jamie Zawinski and Michael Bayne (1997) — concentric circular sine gratings whose overlapping ring systems produce moire interference fringes. *"When the lines on the screen make more lines in between, that's a moiré!"*

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/moire.c` (~253 lines)

## Algorithm
The core is one cheap per-pixel expression. For a grating centred at offset `(xo, yo)` with a ring-spacing `factor`, the value at pixel `(x, y)` is

```
i = ((x + xo)^2 + (y + yo)^2) / factor      // squared distance / factor
colour = colors[floor(i) % ncolors]
```

— so colour is a function of (quantised) distance from the centre: concentric colour bands, tightening as `factor` shrinks. The C picks the centre offset uniformly in `[-w/2, w/2) x [-h/2, h/2)` (so the actual ring centre lands on/near the screen) and `factor = random() % offset + 1`. It scans the whole screen once, top-to-bottom in 20-row `XShm` chunks, holds the still for `delay` seconds, then re-seeds a fresh centre/factor and redraws.

A single grating is just rings; the **moire** effect proper needs two or more overlapping ring systems. This port keeps the grating math verbatim and **sums** N gratings — `sum_k (dx_k^2 + dy_k^2) / factor_k`, then `floor(sum) % ncolors` — which is what makes the interference fringes appear. Each centre drifts a fraction of a pixel per frame (bouncing off the edges so it stays on/near screen), so the fringes crawl continuously rather than snapping to a new still each `delay`. Optional slow palette rotation (`cycle`) keeps even a near-stationary frame shimmering.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — blit (per-pixel field)
Pure per-pixel: every pixel is `putImageData`-painted from a `Uint32` view over one `ImageData` (packed `0xFFBBGGRR`), one blit per frame. This is the BLIT path shared with `binaryring.js` / `thornbird.js`, and the closest per-pixel twins are `greynetic.js` (per-pixel canvas) and `binaryring.js` (Uint32 ImageData). The inner loop hoists each centre's `dy^2` per row and pre-inverts `factor` (per-pixel multiply, not divide). **Full backing-store resolution, confirmed fine even on retina** — 2 centres over a ~5 MP retina canvas is ~10 M inner iterations/frame, a few ms, well under the 33 ms budget; no internal-res reduction needed. (Cranking `Gratings` to 5 on a 4K retina display is the only heavy case; the default is 2.)

## Deviations from the C
- **Whole frame per step, not 20-row chunks.** The C's row chunking is purely an `XShm`/`put_xshm_image` artifact (it streams scanline bands to the X server). There's no canvas analogue and no aesthetic reason to keep it, so each frame paints the full field at once.
- **Centres drift; the pattern is animated.** The C draws a *static* still and only changes it wholesale every `delay` seconds. The hack-port brief asks for a pattern that "actually moves frame to frame", so each centre gets a slow random drift velocity (~0.6 logical px/frame) and bounces off the edges. `delay` therefore now sets the **drift cadence** (a frame rate), not a seconds-long hold.
- **Multiple gratings summed (the moire enhancement).** The C uses a single grating per frame (its "moire" comes from the ring banding plus the `ncolors` wrap). To get true moire *interference* fringes we sum `centers` gratings (default 2). `centers = 1` reproduces the C's single-ring look; 2+ gives crossing fringe systems. Exposed as the **Gratings** slider.
- **Vivid rainbow ramp instead of `make_color_ramp`.** The C ramps foreground hue to background hue (random by default). We use the gallery's `hsl(h,100%,50%)` rainbow packed to ABGR, wrapping mod `ncolors` — same banding role, more vivid, per the project's palette guidance.
- **`factor` scaled by `S^2`, velocities by `S`** (`S = devicePixelRatio`), because the distance term is squared *device* pixels; this keeps ring spacing and drift speed visually identical at any dpr.
- **Dropped:** the `mono_p` 1-bit path (`offset *= 20`, fg/bg parity bit), `random`/foreground/background X resources, and `useSHM` — none apply in a browser. No XOR or feedback is involved, so no raster-op workaround is needed.

## Correctness self-review
- **First frame looks right.** `init()` seeds centres at random points *inside* `[0,W) x [0,H)` (on-screen by construction) and calls `render()` immediately, so t=0 already shows the full pattern — no off-screen/degenerate start.
- **No divide-by-zero / bad index.** Every `factor >= 1 * S^2 > 0`, so `1/factor` is finite. `sum` is a sum of squares over positive factors, hence `>= 0`, so `floor(sum)` is `>= 0`; adding the `phase` (0..ncolors-1) keeps it non-negative, and a defensive `if (ci < 0) ci += ncolors` guarantees a valid `[0, ncolors)` index regardless.
- **Cannot freeze or over-draw.** `render()` writes *every* pixel unconditionally each frame — there is no accumulation buffer, no closure/termination/float-equality test that could stall or endlessly redraw. The only loop bound is the standard capped lag-accumulator (`MAX_CATCHUP_STEPS = 8`), which a long pause cannot defeat.
- **Centres stay visible.** `moveCenters()` clamps + reflects at `[0,W] x [0,H]`, so no centre ever wanders far off-screen (unlike the C, whose centre is fixed for the life of a still anyway).
- **Pause/resume + reinit.** Standard pattern: `pause()` cancels rAF and sets the `rafId === 0` sentinel; `resume()` resets `lastTime = 0` so there's no catch-up burst (no visible jump). `reinit()` just re-runs `init()` — fresh palette + fresh random centres + a clean repaint — giving a brand-new pattern with the current config.

## Config
Ranges mirror `hacks/config/moire.xml`: `delay` (the xml's "Duration" slider, here repurposed as **Frame rate** in µs, live, inverted — see the drift-cadence note above), `ncolors` (**Colors**, ramp size, reinit), `offset` (**Offset**, upper bound of the random ring-spacing factor — small = tight rings, reinit). Added for the moire enhancement: `centers` (**Gratings**, 1-5, reinit — 1 = the C's plain rings, 2+ = interference) and `cycle` (**Color cycling**, live — slow palette rotation). Non-live changes re-seed the centres and palette and repaint via `reinit()`.

**Default `delay` is 33000 µs (~30 fps)**, a touch calmer than a free-running redraw, per the project's tuning guidance. See [[squiral]] for the shared module skeleton, [[greynetic]] and [[binaryring]] for the per-pixel / Uint32-blit idioms this follows.
