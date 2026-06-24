# rocks — port notes

Port of `rocks.c` by Jamie Zawinski (1992; colour added by Johannes Keukelaar, 1997), based on TI Explorer Lisp code by John Nguyen — flying forward through a tumbling 3D asteroid field. "An asteroid field zooms by."

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/rocks.c` (~561 lines)

## Algorithm
Each rock owns four numbers: a **radial offset** `r` from the flight axis, an **angle** `theta` around that axis (`SIN_RESOLUTION = 1000` units round the circle), a **depth** `z` (its distance ahead, in `DEPTH_SCALE = 100` ticks per integer depth, from `MAX_DEPTH·100 = 6000` down to the near plane), and a **colour**.

The perspective is a precomputed table: `depths[z] = atan(0.5 / (z/100))` — large near the viewer (`PI/2` at `z = 0`), small far away. Projecting a rock (`rockCompute`) is then:
- `size = real_size · factor` (always `real_size = MAX_SIZE = 400`, so the factor alone sizes it),
- `x = midx + cos(theta)·r·factor`, `y = midy + sin(theta)·r·factor`.

So as a rock's depth ticks down it **grows** and **swings out from the centre** — the field rushes past. Each step (`step`, the C's `rocks_draw` + `tick_rocks`):
1. **Field rotation** (`rotate`): an eased "delta" `d` is fed to every rock and added to its `theta`. `d` walks toward a random target `new_delta ∈ [-5,5]` (rarely ×5) over 5-tick strides, then re-rolls the target ~1/50 of the time once it settles.
2. **Steering** (`move`): a screen-space displacement `(dep_x, dep_y)` drifts via `computeMove` — it accelerates, bounces off `±midx·0.3` limits, and randomly flips direction (1/60). Each rock adds `dep · move_factor`, where `move_factor = 0 − z/6100` grows with depth, so **far rocks shift more than near ones** (parallax).
3. **Tick + recycle** (`rockTick`): `z -= speed`; rotate `theta`; if `z < MIN_DEPTH·100 = 200` the rock **dies** (`z = 0`). A dead rock has a **1/40 chance per tick to respawn** at `MAX_DEPTH` with a fresh random `r`/`theta`/colour (`rockReset`). Rocks are also killed if they wander off-screen *and* steering is off (the C's documented "won't come back" rule).

Drawing buckets by apparent size: `size ≤ 1` → a point; `size ≤ MIN_SIZE = 3` → a filled square; otherwise the **7-point asteroid polygon** scaled to `size` and anchored at its top-left `(x − size/2, y − size/2)`.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. Closest technique twins: [[scooter]] (perspective projection + near-plane recycle, full repaint per frame) and [[galaxy]] (moving 3D points under a projection, rainbow palette).

## Rendering — full repaint per frame, vector ops
The C draws **incrementally** onto a persistent window: each tick erases the rock's old position with `erase_gc` and draws it at the new one — there's no screen clear, so the background accumulates nothing. We instead **clear to black and redraw the whole field every frame** (like [[scooter]]). That drops the entire erase-GC / XOR machinery and matches the gallery convention. Load is sparse — at most ~100–200 filled polygons over a mostly-black field — so plain canvas vector ops beat a per-pixel `ImageData` blit.

## Deviations from the C
- **Full repaint instead of erase-then-draw.** The C's `rock_draw(…, False)` erase pass and its `erase_gc` are gone; we `fillRect` the whole canvas black and redraw. Visually identical (no trails in the original either), and it sidesteps X's draw-over-background model which canvas doesn't have.
- **Polygon drawn directly, no pixmap cache.** The C pre-renders the 7-point asteroid into one 1-bit `Pixmap` per integer size (`init_pixmaps`) and `XCopyPlane`s the right one. We scale the same normalized 7-point outline (`ROCK_SHAPE`) into a `Path2D`-style fill each draw — same shape, same top-left anchor, no `MAX_SIZE`-entry pixmap table. (The C's tiny-size buckets — point for `size ≤ 1`, filled square for `size ≤ 3` — are kept.)
- **Red/blue 3D via `'lighter'` compositing, not XOR.** With `--3d` the C draws each rock twice into separate `threed_left_gc`/`threed_right_gc` (blue/red) offset by `±diff` (`GETZDIFF`). Canvas has no plane-masked GC, so we draw the left eye in red and the right in blue with `globalCompositeOperation = 'lighter'` (additive), so the overlap reads white — the standard anaglyph emulation. `diff` and its `GETZDIFF` formula (and the eye separation `delta3d = 1.5`) are ported exactly. NOTE: this is a raster-op deviation, documented per the brief.
- **Colour: rainbow palette over random colormap.** The C makes `ncolors` (default 5) *random* colours via `make_random_colormap`. We build a vivid full-saturation `hsl()` rainbow of `ncolors` entries (gallery house style) and pick per-rock as the C does (`color = random % ncolors`). `ncolors ≤ 2` collapses to the C's mono foreground (`#E9967A`, "darksalmon" — the xml default `.foreground`). Default raised 5 → 16 for a richer spread; the slider still spans 2–255.
- **Integer truncation kept.** `size`, `diff`, `x`, `y`, and the steering math use `| 0` to match the C's `(int)` casts, so the projected coordinates and recycle timing track the original.
- **devicePixelRatio.** `resize()` sizes the backing store in device px and everything (positions, sizes, `MAX_SIZE`) is computed in those device px, so the field fills the same fraction of the screen and scales on retina for free. `S` (dpr) is captured but the C's pixel constants are used as-is in device space — at high dpr the rocks are correspondingly crisper, which is the intended gallery behaviour.
- **`--fps` / `--root` / `left3d` / `right3d`** X-specifics are omitted; the anaglyph colours are fixed (red / cyan-blue) rather than configurable.

## Correctness self-review
The brief flags "frame 1 looks dead", endless over-draw, and freezes. Verified headlessly (stub canvas/`window`, drive the rAF loop, scan every polygon coordinate for NaN/Inf):
- **Field fills in and holds a steady population.** Rocks are `calloc`'d to `depth 0` (dead) in the C and born only via the 1/40-per-tick respawn — so the field fills over the first second or two, exactly as the original; **we deliberately do NOT pre-seed**, to match. Over 30 steady-state frames the default config holds **~58 visible rocks/frame (of 100)**, min 41 / max 109 — never collapses to zero, never pegs. The rest of the 100 are mid-respawn (dead), which is correct.
- **Every config path runs clean, no NaN/Inf.** default (rotate+move), **3D** (~114 draws/frame ≈ 57 rocks × 2 eyes — confirms the double-draw), **no-move/rotate-only** (~64; the off-screen-kill path runs without starving the field), **no-rotate-no-move** (~69), and **slow speed=1** (~114; rocks linger longer so more are visible at once). No polygon ever received a non-finite coordinate across ~2000-frame runs.
- **No degenerate loops / division by zero.** `depths[0]` is set to `PI/2` explicitly (the C's "avoid division by 0"); the table is only indexed by `depth ∈ [0, 6000]`. The respawn is probabilistic (1/40) so a dead rock always eventually returns; the `while (theta < 0) theta += SIN_RESOLUTION` normalisation terminates because each step's `d` is bounded to `±25`.
- **Steering can't run away.** `computeMove` clamps the displacement to `±midx·0.3` and the speed to `±5`, so `dep_x/dep_y` stay bounded and projected `x/y` never blow up (verified — coords stay finite over 2000 frames with steering on).
- **pause → resume** doesn't jump (`resume()` resets `lastTime = 0`, no catch-up burst); **reinit** clears to black and rebuilds tables/palette/rocks (field re-fills from empty again, as intended). Live `speed`/`rotate`/`threed`/`delay` changes apply instantly with no throw.

## Config
Ranges mirror `hacks/config/rocks.xml`:
- `delay` — Frame rate, µs/step, default 50000, `invert: true` (the xml's `convert="invert"`), **live**.
- `count` — Rocks, 1–200, default 100, **non-live** (sizes the rock array → `reinit()`).
- `speed` — Velocity ("Velocity" in the xml), 1–100, default 100, **live** (depth ticks per step; read every step).
- `ncolors` — Colors, 2–255, default 16 (xml default 5; raised for a richer rainbow), **non-live** (sizes the palette → `reinit()`; ≤ 2 → mono).
- `rotate` — Rotation, default on, **live** (whether `theta` drifts).
- `move` — Steering, default on, **non-live** (toggling it changes the off-screen-kill rule and `max_dep`, so it reseeds via `reinit()`).
- `threed` — Red/blue 3D, default off, **live** (anaglyph double-draw).

`speed`/`rotate`/`threed`/`delay` are read live with no buffer to resize; `count`/`ncolors`/`move` re-seed via `reinit()`. The xml's `showfps` is a host concern, not a hack param. `r` (restart) reseeds the field via `reinit()`.

**Local dev:** ES-module `import`s mean `file://` double-click won't work (CORS on the `null` origin). Serve it — `python3 -m http.server` in the repo, then open <http://localhost:8000/#rocks>. GitHub Pages serves over http, so production is unaffected.
