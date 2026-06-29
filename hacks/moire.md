# moire — port notes

Port of `moire.c` by Jamie Zawinski and Michael Bayne (1997) — a concentric circular sine grating (a "zone plate") whose rings alias against the pixel grid into moire fringes. *"When the lines on the screen make more lines in between, that's a moiré!"*

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/moire.c` (~253 lines)

## Algorithm
The core is one cheap per-pixel expression. For a grating centred at offset `(xo, yo)` with a ring-spacing `factor`, the value at pixel `(x, y)` is

```
i = ((x + xo)^2 + (y + yo)^2) / factor      // squared distance / factor
colour = colors[floor(i) % ncolors]
```

— so colour is a function of (quantised) distance from the centre: concentric colour bands, tightening as `factor` shrinks. The **moire** fringes are the aliasing of those rings against the integer pixel grid, strongest toward the periphery where the rings pack tighter than the sampling — so a single zone plate already produces them. The C picks the centre offset `draw_xo = random()%w - w/2` (the ring centre, at `-draw_xo`, is uniform in `(-w/2, w/2]` — frequently near or just off the left/top edge) and `factor = random()%offset + 1`. It also (re)builds `colors`: `rgb_to_hsv` of a random foreground RGB and a random background RGB (default `random:true`), fed to `make_color_ramp` as a **closed HSV loop** (`closed_p=True`, `writable_p=False` — a static ramp, no hardware colour-cycling). It then scans the whole screen once, top-to-bottom in 20-row `XShm` chunks, **holds the still for `delay` seconds**, then re-seeds a fresh centre/factor/ramp and redraws.

This port reproduces that behaviour: it paints one **static** zone plate, holds it for `delay` seconds, then snaps to a new randomly-seeded one — nothing drifts or cycles within a still. The colour ramp is the faithful `make_color_ramp` via `colormap.js` (`makeColorRampRGB(h1,s1,v1, h2,s2,v2, ncolors, closedP=true)` with random RGB->HSV endpoints), rebuilt on every re-seed: a limited two-hue ramp, frequently muted, different each still — not a fixed rainbow.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — blit (per-pixel field)
Pure per-pixel: every pixel is `putImageData`-painted from a `Uint32` view over one `ImageData` (packed `0xFFBBGGRR`). The pattern is static between re-seeds, so there is exactly **one blit per still**, not per animation frame. This is the BLIT path shared with `binaryring.js` / `thornbird.js`, and the closest per-pixel twins are `greynetic.js` (per-pixel canvas) and `binaryring.js` (Uint32 ImageData). The inner loop hoists each centre's `dy^2` per row and pre-inverts `factor` (per-pixel multiply, not divide). **Full backing-store resolution, confirmed fine even on retina** — a single zone plate over a ~5 MP retina canvas is a few ms, and it is painted only once per still. (Cranking `Gratings` to 5 sums five fields per pixel, the only heavier case; the default is 1.)

## Deviations from the C
- **Whole still painted at once, not in 20-row chunks.** The C reveals each still top-to-bottom in 20-row `XShm` bands (an artifact of streaming scanlines to the X server). There is no canvas analogue, so each still is painted in a single `putImageData`. The hold-then-snap cadence and the static, non-cycling pattern are otherwise faithful.
- **`centers` (Gratings) slider, default 1.** The C draws a single zone plate; `centers = 1` reproduces it exactly (the moire is the ring/pixel-grid aliasing, which one plate already gives). The slider can sum 2-5 gratings for crossing interference fringe systems — a port extra, off by default.
- **`factor` scaled by `S^2`, centre in device px** (`S = devicePixelRatio`), because the distance term is squared *device* pixels; this keeps ring spacing visually identical at any dpr.
- **Dropped:** the `mono_p` 1-bit path (`offset *= 20`, fg/bg parity bit), the non-random `foreground`/`background` X-resource colours (we always take the default `random:true` path), and `useSHM` — none apply in a browser. No XOR or feedback is involved, so no raster-op workaround is needed.

## Correctness self-review
- **First still looks right.** `init()` builds a ramp + seeds the centre(s)/factor and calls `render()` immediately, so t=0 already shows the full pattern.
- **No divide-by-zero / bad index.** Every `factor >= 1 * S^2 > 0`, so `1/factor` is finite. `sum` is a sum of squares over positive factors, hence `>= 0`, so `floor(sum) >= 0`; a defensive `if (ci < 0) ci += ncolors` guarantees a valid `[0, ncolors)` index. This matches the C's `colors[((long)i) % ncolors]`.
- **Static, then snaps.** Within a still nothing is recomputed — `render()` runs only inside `snap()` (the re-seed) and at `init()`, so a still cannot flicker or animate. The rAF loop accumulates wall-clock time and calls `snap()` once per `delay` seconds; `snap()` rebuilds the ramp + centre(s)/factor and repaints (the faithful per-still re-randomization).
- **Pause/resume + reinit.** `pause()` cancels rAF and sets the `rafId === 0` sentinel; `resume()` resets `lastTime = 0` so the hold clock never jumps. `reinit()` re-runs `init()` — a brand-new still with the current config, hold clock reset.

## Config
Ranges mirror `hacks/config/moire.xml`: `delay` (the xml's **Duration** slider, 1-60 s, default 5 — the seconds each still is **held** before snapping to a new one, live), `ncolors` (**Colors**, ramp size, 2-255), `offset` (**Offset**, upper bound of the random ring-spacing factor — small = tight rings). The one port addition is `centers` (**Gratings**, 1-5; 1 = the C's single static zone plate, 2+ sums gratings for crossing fringes). `centers`/`offset`/`ncolors` re-seed via `reinit()`.

**Framerate calibration: none needed (paint-and-hold).** `delay` is the xml's *Duration* — a **hold** timer in seconds, not a per-frame rate — so the stock default (5 s) maps 1:1 to the xml and no `OVERHEAD` applies. Nothing animates within a still; the C's ~16 fps top-to-bottom `XShm` reveal of each still is collapsed into a single repaint, so its frame rate has no analogue here. See the framerate-calibration note.

See [[squiral]] for the shared module skeleton, [[greynetic]] and [[binaryring]] for the per-pixel / Uint32-blit idioms this follows, and `colormap.js` for the faithful `make_color_ramp` / `rgb_to_hsv` port.
