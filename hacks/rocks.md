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
3. **Tick + recycle** (`rockTick`): erase the rock at its old position; `z -= speed`; rotate `theta`; if `z < MIN_DEPTH·100 = 200` the rock **dies** (`z = 0` — it was just erased, so it simply vanishes). A dead rock has a **1/40 chance per tick to respawn** at `MAX_DEPTH` with a fresh random `r`/`theta`/colour (`rockReset`). Rocks are also killed if they turn up off-screen *and* steering is off (the C's documented "won't come back" rule, applied inside `rockDraw` on both the erase and draw calls, as in `rock_draw`).

Drawing buckets by apparent size: `size ≤ 1` → a point; `size ≤ MIN_SIZE = 3` → a filled square; otherwise the **7-point asteroid polygon** scaled to `size` (vertices truncated to ints — the C's `XPoint` shorts) and anchored at `(x − size/2, y − size/2)` with C integer division.

## Colour — the C's allocation, verbatim (`rocks_init`, rocks.c:399–447)
`ncolors` (stock **5**) colour slots. **Slot 0 holds the background colour (black)**: the C reserves `colors[0]` for bg, fills `colors[1..n-1]` via `make_random_colormap(…, bright_p=True, …)` (independent random hues, S 30–100%, V 66–100% — `makeRandomColormapRGB(n−1, true)` from `colormap.js`), then builds `draw_gcs[i]` over the *whole* array. A rock picks `color = random % ncolors`, so **~1/ncolors of the rocks are painted background-on-background — invisible "stealth" rocks** whose stamped boxes still knock black bites out of rocks behind them. Faithful, not a bug.

`ncolors < 2` (slider low = 1) means **mono**: `draw_gcs[0] == draw_gcs[1] ==` the foreground GC, so every rock is `#E9967A` ("darksalmon", the `.foreground` default) — the pre-1997 behaviour (`-mono` "gives the old behaviour"). The palette is rebuilt per init/reinit, as the C builds it once per run.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. Closest technique twin: [[scooter]] (perspective projection + near-plane recycle).

## Rendering — the C's incremental erase/draw, no per-frame clear
The C draws onto a persistent window: each tick erases the rock's old position and draws the new one; the window is cleared only at init. The canvas is the same kind of persistent buffer, so the port transcribes that model directly — **no full-screen repaint**:

- **Draw** (`stampRock` = `rock_draw`'s `XCopyPlane` path): the 1-bit pixmap's whole `size × size` bounding box is copied — 1-bits in the rock's colour, 0-bits in **background black**. So a rock stamp paints its full bounding square, and a later-drawn rock's box **clips black edges into an earlier one** where they overlap. That box-bite look (including bites cut by the invisible slot-0 rocks) is the original's, and the port keeps it.
- **Erase**: any rock bigger than a point erases via the filled-square path (the C's `size <= MIN_SIZE || !draw_p` test) — its `size × size` box in black at the old position; points erase as points. In 3D both eye positions are erased.
- All ops are opaque canvas fills at integer coordinates (`x/y/size/diff` are all C-truncated ints), so an erase covers its draw exactly — no AA residue accumulates.
- `resize` mirrors `rocks_reshape`: it updates only the geometry (`W/H/midX/midY`) and keeps all rock state flying; the canvas backing store is cleared by the resize (like an expose) and repainted black, and every live rock re-stamps itself on its next tick.

## Deviations from the C
- **No pixmap cache.** The C pre-renders the asteroid into one 1-bit `Pixmap` per integer size (`init_pixmaps`) and `XCopyPlane`s it; we scale the same truncated 7-point outline into a canvas fill each stamp. Same geometry, same box semantics; the polygon edge is canvas-antialiased rather than 1-bit hard, per the porting rules.
- **Anaglyph colours are fixed** (left Blue at `x − diff`, right Red at `x + diff`, the C's `*left3d`/`*right3d` defaults); the `-left3d`/`-right3d`/`-delta3d` resources have no xml knob and are not exposed. The right eye's opaque box clobbers the left's overlap exactly as `XCopyPlane` does — no additive blending. `diff` (`GETZDIFF`, eye separation `delta3d = 1.5`) is ported exactly, including its sign flip for rocks nearer than depth 10 (crossed disparity).
- **devicePixelRatio.** The backing store is device px and the C's pixel constants (`MAX_SIZE` etc.) are used as-is in that space — on retina the rocks are correspondingly crisper/smaller relative to logical px, like the C on a higher-res display (jwz's header note says those constants are display-resolution-naive by design).
- **`--fps` / `--root`** X-specifics are omitted.

## Config
Ranges mirror `hacks/config/rocks.xml`:
- `delay` — Frame rate, µs/step, 0–100000, default **50000** (stock), `invert: true` (the xml's `convert="invert"`), **live**. The loop paces at `(delay + OVERHEAD)`; `OVERHEAD = 7800` is live-measured via the binary's `-fps` overlay (17.3 fps at Load 13.4% — a clean reading, the sleep slice `57803·(1−0.134) = 50057` ≈ the stock delay).
- `count` — Rocks, 0–200, default 100 (the C clamps to ≥ 1 in code, as does the port), **non-live** (sizes the rock array → `reinit()`).
- `speed` — Velocity, 1–100, default 100, **live** (depth ticks per step; read every step).
- `ncolors` — Colors, 1–255, default **5** (stock; slot 0 is the background "stealth" slot), **non-live**; 1 → mono `#E9967A`.
- `rotate` — Rotation, default on, **live** (whether `theta` drifts).
- `move` — Steering, default on, **non-live** (toggling changes the off-screen-kill rule and `max_dep` → `reinit()`).
- `threed` — Red/blue 3D, default off, **non-live**: the C sets it at startup only, and flipping it mid-flight would strand stale eye stamps under the incremental erase model (the 2D and 3D erase footprints differ), so it re-seeds via `reinit()`.

The xml's `showfps` is a host concern, not a hack param. `r` (restart) reseeds the field via `reinit()`.

## Correctness self-review
- **Field fills in and holds a steady population.** Rocks are `calloc`'d to depth 0 (dead) in the C and born only via the 1/40-per-tick respawn — the field fills over the first second or two; **we deliberately do NOT pre-seed**, to match. Headless state sim (stub canvas, 2000 steps per config): at defaults the population settles around **~35–40 rocks drawn on-screen per step** (of ~59 alive — a 1/40 respawn against a 58-tick lifetime at speed 100 leaves ~40% of the pool dead at any moment, and live rocks swing off-screen as they near); at `speed=1` nearly the whole field is up (~91). Never collapses, never pegs, and no NaN/Inf coordinate ever reaches the canvas across ~18k steps spanning defaults / 3D / no-move / no-rotate / mono / ncolors=255 / count=1 / count=0.
- **Erase always covers draw.** Nothing mutates `x/y/size/diff` between a rock's draw and its next-tick erase (`rockCompute` runs only after the erase), so the black erase box lands on bit-identical coordinates — guaranteed structurally, and confirmed visually (no ghost trails accumulate over a 15 s capture with rotation + steering active, which would expose any mismatch within seconds).
- **Steering can't run away.** `computeMove` clamps the displacement to `±mid·0.3` (int-truncated limits, matching the C's `(int)` casts) and the speed to `±5`.
- **pause → resume** doesn't jump (`resume()` resets `lastTime = 0`); **reinit** clears to black and rebuilds palette/rocks. Live `speed`/`rotate`/`delay` changes apply instantly; `count`/`ncolors`/`move`/`threed` re-seed.

**Local dev:** ES-module `import`s mean `file://` double-click won't work (CORS on the `null` origin). Serve it — `python3 -m http.server` in the repo, then open <http://localhost:8000/#rocks>. GitHub Pages serves over http, so production is unaffected.
