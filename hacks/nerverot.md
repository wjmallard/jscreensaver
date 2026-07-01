# nerverot — port notes

Port of `nerverot.c` (Dan Bornstein, 2000-2001) — "nervous rotation of random thingies": a writhing blob that vibrates violently while slowly drifting and rotating ("Nervously vibrating squiggles").

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/nerverot.c` (~1366 lines)

## Algorithm
The model is a set of **blots** — 3D vertices sampled on a randomly chosen shape. There are nine shape generators (`setupBlots*`): sphere, cube, cylinder, squiggle, cube-corners, tetrahedron, sheet, swirly-cone, and **duo** (two of the others translated apart, recursively). The shape is picked by an 11-way roll (cases 8/9/10 all map to duo), most shapes then get `scaleBlotsToRadius1` + a random reorder + a random whole-set rotation. Each blot also carries a 3x3 grid of display offsets `xoff[i][j]`, `yoff[i][j]`, each a float in `(-1..1)`.

Each iteration (`updateWithFeeling` + `renderSegs` + `eraseAndDraw`):

1. **Maybe regenerate.** `itersTillNext--`; when it goes negative, pick a fresh shape and reset the counter to `rand·maxIters`.
2. **Drift.** Current `xRot/yRot/zRot`, `curScale`, and a light position `lightX/Y/Z` each ease toward a *target* by `iterAmt = 0.01` per step (`cur += (target - cur)·iterAmt`).
3. **Jitter.** Every offset gets `+= rand(-1..1)·nervousness`, then is **reflected** back into `[-1,1]` at the edges (`>1 → -(v-1)+1`, `<-1 → -(v+1)-1`).
4. **Events.** With probability `eventChance`, a 14-way roll jumps one or more drift targets (rotations to `±2π`, the centre offset by up to `±maxRadius`, the scale, or the light).
5. **Render.** Each blot is rotated (z then x then y), its colour comes from the **squared distance to the light** (`color = 1 + (|blot−light|²/4)·ncolors`, capped), and its 9 grid points project to screen as `base + ((i−1) + xoff·maxNerveRadius)·radius` where `base = blot/2·baseScale·curScale + centre + centreOff` and `radius = (z+1)/2·(maxRadius−minRadius) + minRadius`. The blot draws as an 8-segment outline (`blotShape`) traced through that grid.
6. **Erase + draw.** The double-buffered C clears the whole window then strokes the new segments (the non-double-buffered path overdraws line-by-line, but `HAVE_JWXYZ` forces double-buffering off and relies on Quartz; we follow the clear-and-repaint path).

So: a tight cloud of little jittering square-ish blots, the whole cloud slowly tumbling, scaling, and sliding, with a moving light shading it across the colour ramp. `count` is a *request* — most shapes round it to a structural number.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see [[squiral]].

## Rendering — vector ops, bucketed by colour (like braid)
This is genuinely line-shaped (8 thin segments per blot, default ~250 blots ⇒ ~2000 segments/frame), so it uses **canvas vector ops**, not the per-pixel blit path. The naive port is ~2000 individual `XDrawLine`s per frame. Exactly as in [[braid]], segments are **bucketed by their integer colour index** into one `Path2D` per colour (`<= ncolors` buckets, default 4) and each bucket is stroked once — so a frame is ~`ncolors` `stroke()` calls regardless of blot count (the harness measured ~4.4 strokes/frame at the defaults). The canvas is cleared to black at the top of each frame, then the buckets are stroked. Draw order across buckets is irrelevant (the segments are independent thin lines).

## Deviations from the C
- **Full repaint each frame** instead of the C's two-array erase-old/draw-new segment swap. The C keeps `segsToErase` and `segsToDraw` and XORs nothing — under double-buffering it just clears the back buffer and strokes the new segments, which is exactly what we do (clear to black, stroke buckets). The erase array is therefore unnecessary; the visual result is identical. No XOR or feedback is involved, so no raster-op emulation is needed.
- **Colors**: the C's `setupColormap` builds an X `make_color_ramp` from a random vivid hue `(h1, s=1, v=1)` to a random dimmer hue `(h2, s=0.7, v=0.7)`, `ncolors` **open** (non-closed) entries, indexed `1..ncolors` by the light distance. We reproduce it exactly via `colormap.js`'s `makeColorRampRGB(h1, 1, 1, h2, 0.7, 0.7, ncolors, false)` — a faithful port of `make_color_ramp` (colors.c) that uses the same direct `dh=(h2−h1)/n` hue path and `hsv_to_rgb`. Indexed `0..ncolors-1` (the C's `gcs[color]` → our `palette[color-1]`; colour 1, nearest the light, = the vivid `h1` end, colour `n`, farthest, = the dim `h2` end). Built **once at init** — the C never rebuilds the colormap on a shape change. With `ncolors` small (default **4**) you get the original's banded, few-colour look. *(Fidelity audit: this was a vivid full-saturation `hsl()` rainbow — the systemic palette bug — now the faithful HSV `make_color_ramp`.)*
- **devicePixelRatio**: `baseScale = min(W,H)` and the centre are already in device px (from `canvas.width/height`), so they scale on retina for free. `minRadius`/`maxRadius` (and thus the per-blot `radius` and the event-driven centre offsets, which are scaled by `maxRadius`) and the stroke `lineWidth` are multiplied by `S = devicePixelRatio` explicitly. The C instead tripled `lineWidth` past 2560 px; we use the smooth dpr scale instead (noted, equivalent intent).
- **Duo recursion kept faithful**: `setupBlotsDuo` recurses into the real `setupBlots(req/2)` (which can pick duo again), exactly like the C. Termination is guaranteed because `req` halves each level and duo special-cases `req < 15` to a sphere, bounding the depth (250→125→62→31→15→sphere — ~5 levels). Verified to terminate over 3000 back-to-back regenerations (348 ms wall, no stack issue).
- **`maxIters`/`eventChance`/`nervousness`/`maxNerveRadius` are live**; `count`/`ncolors`/`lineWidth` re-seed via `reinit()`. The C's hidden defaults not surfaced by the xml (`iterAmt 0.01`, `minScale 0.6`, `maxScale 1.75`, `minRadius 3`, `maxRadius 25`) are kept as constants so the drift/scale/radius feel matches the original; `doubleBuffer` is moot (we always repaint).
- **`--fps`** ("Show frame rate") and the `--root` command flag are X/host concerns and omitted, as in the other ports.
- **Speed**: `delay` is the stock xml **10000 µs** (was 30000 — a by-eye 3x slow-down, which also contradicted this note). Like the other audited hacks the loop paces at **(delay + OVERHEAD)** µs, where `OVERHEAD` is the per-frame framework+draw cost the C's delay does not include (the C's delay is *on top of* draw time). `OVERHEAD = 8350` is live-measured (live 54.5 fps, Load 45.5%, clean at stock delay 10000) — nerverot is on the heavier side of the sparse-vector hacks (~250 blots × 8 segments ≈ 2000 line segments/frame, bucketed into ~`ncolors` strokes, plus per-blot trig + 2250 jitter reflects).

## Correctness self-review
- **Termination / no freeze.** The only loops that aren't a fixed `for` over `blotCount` are (a) the rejection samplers in `setupBlotsSphere` (radius in `[0.2,1]`) and `setupBlotsSquiggle` (stay within `[minCoor,maxCoor]`) — both reject from a region of non-trivial measure, same as the C, so they finish quickly; and (b) the duo recursion, bounded as above. The rAF loop has the standard `MAX_CATCHUP_STEPS` cap (verified: a 5-second time jump at `delay=0` ran only ~16 steps, so a backgrounded tab can't burst-freeze).
- **No dead frames / degenerate start.** `resize()`/`reinit()` call `init()` (which seeds the shape, drift state with targets = start, and colours) **and then `draw()`**, so frame 1 is already populated — no blank first frame and no off-screen-only start (`baseScale·curScale` centres the unit-radius blob at screen centre).
- **No over-draw / runaway.** Offsets are reflected into `[-1,1]` every step (bounded jitter); rotations/scale/light ease toward bounded targets; nothing accumulates on the canvas (cleared each frame). The colour index is clamped to `[0, ncolors-1]` so a bucket index is always valid even when `color` rounds to `ncolors`.
- **No non-finite coordinates.** Headless harness drove 600 default frames + 500 frames at `maxIters=1` (hammering all 11 shape cases incl. nested duo) + counts `{1,2,14,15,16,30,1000}` + `ncolors=1` + a `delay=0` burst: **0** non-finite `moveTo/lineTo` coordinates in any case, and `pause→resume`/`reinit` don't throw or jump.
- **Spot-check in browser**: confirm the blob (a) visibly *jitters* hard while *slowly* tumbling/sliding (jitter is per-frame, drift is `iterAmt=0.01` slow), (b) occasionally swaps to a clearly different shape, and (c) at `ncolors=4` shows distinct colour banding shifting as the light moves. Off-screen excursions (the blob sliding/scaling partly out of frame on an "event") are faithful to the C — the canvas simply clips.

## Config
Ranges mirror `hacks/config/nerverot.xml`:
- `delay` — Frame rate, µs/step, default 10000 (stock), `invert: true`, **live**. The loop paces at `(delay + OVERHEAD)`, `OVERHEAD = 8350` µs (live-measured).
- `maxIters` — Duration, 100–8000, default 1200, **live** (only read to reset the shape-change counter).
- `count` — Blot count (a *request*), 1–1000, default 250, **non-live** (sizes the blot array → `reinit()`).
- `ncolors` — Colors, 1–255, default 4, **non-live** (sizes the palette → `reinit()`).
- `eventChance` — Changes, 0–1, default 0.2, **live**.
- `nervousness` — Nervousness, 0–1, default 0.3, **live**.
- `maxNerveRadius` — Crunchiness, 0–1, default 0.7, **live**.
- `lineWidth` — Line thickness, 0–100, default 0 (=1px), **non-live** (folded into the stroke; reinit harmless); range mirrors the xml `high=100` (an earlier draft capped it at 20).

Non-live changes and "Reset to defaults" re-run `init()` via `reinit()` (clears the canvas, rebuilds the blots/palette). The xml's `showfps` boolean is not exposed (see deviations).
