# hypercube — port notes

Port of `hypercube.c` by Joe Keane, Fritz Mueller, and Jamie Zawinski (1992) — a wireframe tesseract (the 4D analog of a cube) rotating in 4-space and projected to the screen. Man-page one-liner: "2d projection of a 4d object."

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/hypercube.c` (575 lines). Removed from xscreensaver in 5.10 in favour of the more general `polytopes`; preserved here as a standalone.

## Algorithm
The hypercube has **16 vertices** and **32 edges**. The shape is held as four 4D **basis vectors** `a, b, c, d` (each `(x, y, z, w)`), initialised to the identity frame. Vertex `i` is the signed sum `sa·a + sb·b + sc·c + sd·d`, where each sign is `+1`/`-1` from a bit of `i` (bit 3 -> a, bit 2 -> b, bit 1 -> c, bit 0 -> d). So the 16 vertices are the corners `(+-1, +-1, +-1, +-1)` of the tesseract. This matches the C's `compute(-,-,-,-,0) .. compute(+,+,+,+,15)` macro expansion exactly.

Per step:
1. **Rotate the basis** in up to six independent 4D planes — `xy, xz, yz, xw, yw, zw` — each by `slider · 0.001` radians (`ANGLE_SCALE`). The rotation is the C's `rotate()` macro verbatim: `u' = u·cos + v·sin`, `v' = v·cos - u·sin`, applied to all four basis vectors. A zero-speed plane is skipped (the C's `if (sin != 0)`).
2. **Project 4D -> 2D.** For each vertex compute `sumX/sumY/sumZ` (the signed sum of the rotated basis x/y/z components); the **w component is dropped** (orthographic 4D -> 3D), then `(x, y)` get a `1/z` perspective divide: `mul = unitScale / (2·observerZ - sumZ)`, `x = sumX·mul + offsetX`, `y = sumY·mul + offsetY`. `unitScale`, the offsets, and `2·observerZ` are the C's `set_sizes()`.
3. **Draw** the 32 edges. Each edge connects the two vertices that differ in exactly one of the four binary coordinates, and carries one of 8 colours (one per square face/cube). The edge + colour table is copied **verbatim** from the C's `line_table[]`.

The w dimension only enters through the rotation, so as the basis turns (default `yw = 10`, plus `xy = 3`, `xz = 5`), the fourth axis sweeps into the visible three and the characteristic cube-within-a-cube morphing appears.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see [[squiral]]. Closest technique twins: [[scooter]] (rotating projected geometry under a `1/z` divide) and [[braid]] (colour-bucketed canvas stroking).

## Rendering — full repaint per frame, vector ops
32 short lines per frame — sparse vector drawing, far cheaper than any per-pixel blit. The edges are **bucketed by colour** (the 8 face groups), so each frame issues 8 `stroke()` calls (one `beginPath`/`moveTo`+`lineTo`.../`stroke` per colour), not 32 — braid's idiom. `lineWidth = 1.5·dpr`, round caps/joins.

## Deviations from the C
- **XOR erase -> full-frame repaint (the important one).** The X11 hack draws with `GXcopy` and *erases the previous frame's lines* by re-drawing them in the background colour (`XDrawLine` with `black_gc`) before drawing the new ones — an incremental erase-old/draw-new that only touches edges whose endpoints moved. Canvas has no XOR/erase-line raster op, so each `step()` instead **clears the whole canvas to black and redraws all 32 edges** at the new angles. Visually identical (a clean wireframe at each orientation) with **no ghosting/trails**; the C's per-point `moved[]` / `old_x,old_y` bookkeeping and the `roted/redraw/resize` skip-flags are therefore dropped as unnecessary.
- **Orthographic w-drop, faithful to the C.** Note the C projects 4D -> 2D by **dropping w** (no `sum_w` is ever computed) and applying a single `1/z` perspective divide — it is *not* a w-perspective then a z-perspective. The port does the same. (So the brief's "divide by w then by z" mental model differs from the actual source; only the `2·observerZ - sumZ` denominator exists, and it is always `> 0`.)
- **Seeded initial orientation.** The C lazily starts from the identity frame (its first `draw` call only rotates; points are all at the origin until the second call). The identity frame projects to a *degenerate* doubled cube (w-edges have zero length). To satisfy "frame 1 already shows a recognizable hypercube", the port seeds a fixed rotation in `init()` (`xz/yz` for 3D depth, `xw/yw` to offset the two w-cubes) — independent of the speed sliders, so the figure reads correctly even with every rotation frozen at 0.
- **Colours.** The 8 face colours are the C's `color0..color7` defaults verbatim (magenta, yellow, orange, pink, green, periwinkle, cyan-blue, cyan-green). They already encode the structure (one hue per cube), so no rainbow override — they are vivid as-is.
- **Live Zoom.** `observer-z` (xml "Zoom") is recomputed every step from `config.z`, so dragging it zooms smoothly; the rotation speeds are likewise live. (The C reads these once at init.) `--mono`, `--fps`, `--root`, and the per-colour CLI overrides are X-specific and omitted, as in the other ports.
- **devicePixelRatio.** `init()` reads `canvas.width/height` in device px and `set_sizes`-style scaling (`0.4·min_dim·sqrt(z²-1)`) lands the projection in device px, so the figure is sharp on retina for free; `lineWidth` folds in `dpr`.

## Correctness self-review
Verified with a headless numeric harness (the core rotation+projection, no canvas), driving the default config for 5000 steps:
- **Edge table is exactly the tesseract's 32 edges.** All 32 pairs differ in exactly one binary bit (`bad-bit = 0`), all 32 are unique. A wrong edge would mangle the cube; this is the C's `line_table` copied verbatim.
- **No divergence, no divide-by-zero.** Over 5000 steps: `nonfinite = 0`. The perspective denominator `2·observerZ - sumZ` stayed in `[4.008, 7.992]` at the default zoom and is provably `> 0` for any allowed zoom (`sumZ in [-2, 2]`, `2·observerZ >= 2.25`, so the minimum is `0.25`). The basis stays orthonormal indefinitely (after 5000 steps `a·b ≈ 1e-14`, `|a|² = 1.000000`) — the pairwise plane rotations preserve lengths, so nothing drifts to NaN or blows up. No clamp/reseed needed.
- **Frame 1 is recognizable.** With the seeded orientation, the first frame's projected vertices span ~760 px in x (on a 1920-wide canvas) — a clearly 3D, w-offset wireframe, not a flat or degenerate dot cloud.
- **On-screen and centred.** Projected coords stay well inside the canvas (`x in [531, 1390]` of 1920, `y in [112, 971]` of 1080) for the whole run — the `unitScale` normalisation keeps the figure a bounded fraction of the window at any zoom, so it never flies off-screen.
- **No freeze / no over-draw.** There is no closure or termination condition to mis-fire — every step rotates, projects all 16 vertices, and repaints all 32 edges unconditionally; the rAF lag-accumulator caps catch-up at `MAX_CATCHUP_STEPS = 8`. `pause()` then `resume()` resets `lastTime = 0` so there is no catch-up burst; `reinit()` clears to black and re-seeds the orientation for a clean fresh screen. Setting every rotation slider to 0 freezes the (still-correct) figure rather than breaking it.

## Palette
Native screenhack (`#include "screenhack.h"`) — **no colormap**, so no `colormap.js`. The eight edge colours are the C's fixed `color0..color7` resources from `hypercube_defaults[]`, copied verbatim: magenta `#FF00FF`, yellow `#FFFF00`, orange `#FF9300`, pink `#FF0093`, green `#00FF00` (the X11 `green`, deliberately not CSS `#008000`), periwinkle `#8080FF`, cyan-blue `#00D0FF`, cyan-green `#00FFD0`. Each of the 32 edges carries one of these via the `line_table` `li_color` field (one hue per face/cube), so the colour encodes the tesseract's structure. They are vivid by the author's design — **not** an invented `hsl()` rainbow — and the port has zero `hsl()`. Verified against the live binary: same eight hues, same per-face grouping.

## Timing
Stock `*delay 10000` µs (the C default and the xml). The live `-fps` overlay read **56.7 fps @ Load 43.3 %** and **60.4 fps @ Load 39.6 %** across two runs — well under 100 % Load, so the hack is delay-bound (the 32-line draw is nearly free). Mean frame ≈ 17097 µs, so `OVERHEAD = round(1e6/58.5) - 10000 ≈ 7097` µs, and the loop paces on `(config.delay + OVERHEAD)/1000` ms. The port previously used a by-eye `delay 15000` with no overhead (≈ 67 steps/s, too fast); after the fix it measures **58.5 steps/s**, matching the live ~58/s. (`OVERHEAD >= 0`, as required.)

## Config
Ranges mirror `hacks/config/hypercube.xml`:
- **Frame rate** — `delay`, 0..100000 µs, default 10000 (the C/xml stock; was a by-eye 15000), invert (drag right = faster); paced at `(delay + OVERHEAD)/1000` ms — see Timing. Live.
- **Zoom** — `observer-z`, 1.125..10.0, default 3.0; near = stronger perspective, far = flatter/orthographic. Live.
- **XY / XZ / YZ / XW / YW / ZW rotation** — the six 4D plane speeds, 0..20 each (`· 0.001` rad/step), defaults `xy=3, xz=5, yw=10` (the rest 0), exactly the C's. Live.
