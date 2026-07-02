# piecewise — port notes

Port of `piecewise.c` by Geoffrey Irving (2003) — a swarm of circles drifts and bounces around the screen, and every circle's outline is cut into arcs at the points where other circles' boundaries cross it; the arcs alternate visible/invisible, so outlines invert wherever circles overlap. All arcs are stroked in one shared colour that slowly walks a rainbow loop. See [[squiral]] for the shared module skeleton; technique twin: [[braid]] (stroked arcs).

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/piecewise.c` (~1035 lines) · demo video: youtube 3gQr1FxFSe0

## Algorithm
Each frame the C erases the (DBE double-buffered) window and recomputes the full **arrangement of circle boundaries** with a Bentley-Ottmann plane sweep — a splay-tree event queue plus a splay-tree fringe (~600 of the 1035 lines). Every crossing found adds its **angle** (`atan2` about each circle's centre, in X11 64ths-of-a-degree) to both circles' intersection lists; left-branch angles (`x < centre`) are lifted by `+2π` when non-positive so each circle's list sorts continuously around its boundary in `(-π/2, 3π/2]`, wrapping at the circle's topmost point.

`draw_circle` then cuts the outline at those sorted angles into segments that **alternate drawn/undrawn** (`(p & 1) ^ visible`), the parity anchored by a per-circle `visible` bit on the wrap segment; no crossings means the whole outline is drawn (or hidden) outright. `adjust_circle_visibility` keeps the picture **continuous between frames**: it merges last frame's sorted list with this frame's and forms the alternating sum `a = m − a`; paired old/new angles nearly cancel, so `a > π` exactly when the arrangement's parity shifted at the wrap point (a crossing slid past the circle's top) — then the anchor bit flips. `visible` starts as `random() & 1` per circle.

Geometry: `count` circles (default 32) with integer radii in `[ceil(minradius·h), floor(maxradius·h)]`, seeded fully inside the field, velocity `(1 + frand(.5))·speed/10` at a random heading; `move_circle` reflects off the walls with clamp-back. Colour: `make_color_loop(0,1,1, 120,1,1, 240,1,1)` builds a **256-entry full-S/V HSV hue loop** (red→green→blue→red); one `draw_gc` colour indexes it, starting at `random() % ncolors` and advancing one entry every `color_iterations = colorspeed ? 100/colorspeed : 100000` frames (min 1). Line width 1, tripled when the window exceeds 2560 px (the C's Retina rule).

## What the port transcribes
- **The piecewise-visibility engine** — the hack's identity: per-circle sorted crossing-angle lists (same branch attribution and `+2π` lift), the alternating-sum merge with last frame's list and the `a > π` anchor flip, and the parity-alternating arc segments including the wrap segment `[i[n−1], i[0]+2π]` and the no-crossing full-circle case.
- **Crossing math**: `fringe_intersect`'s closed form verbatim (`d = (rd²−sd)(sd−rs²)`, `d ≤ 0` = no crossing — separate/tangent/contained; `sd == 0` = concentric), each crossing recorded on both circles.
- **Motion**: `init_circles` / `move_circle` line for line — radius band, in-bounds seeding (`r + frand(W−1−2r)`), velocity formula, wall reflection with clamp-back, and the C's order (draw circle *i*, then move it).
- **Frame model**: full erase + full redraw per frame into a double buffer; the rAF canvas swaps tear-free like the DBE path (the C's `-no-db` single-buffer variant and the jwxyz `dbuf=False` shortcut are the same picture).
- **Colour**: the exact `make_color_loop` — `make_color_path` over the three equally-spaced full-S/V anchors = three open hue ramps of `trunc(256/3) = 85` entries (each stepping 120/85°), float-round-off remainder padded by repeating the last colour. Composed from the shared `makeColorRampRGB` (colormap.js), whose per-entry `hsv_to_rgb` truncation matches `colors.c`; one shared stroke colour, `color_index` init `random() % 256`, cadence `100/colorspeed` (min 1, ≈never at 0). Spot-checked: entry 0 = `rgb(255,0,0)`, 85 = green, 170 = blue, 255 = pad duplicate.
- **Line width**: the C's rule verbatim in device px — 1, or 3 when width/height > 2560 (so a fullscreen retina canvas triples, exactly the case the C targets).

## Deviations from the C
- **Pairwise sweep instead of splay trees.** The plane sweep is an *efficiency* device; its output contract is "every boundary crossing, once, on both circles." At `count ≤ 100` an O(n²) pairwise pass (~500 pairs at default 32) is far below a frame budget, so the port computes the same lists directly. The event queue, fringe trees, `tweak_circle` jitters and the PANIC/restart path exist only to keep the sweep's degeneracies at bay and are dropped — with no sweep there is nothing to corrupt (float-equality degeneracies are measure-zero and non-fatal here).
- **Float radians, not integer 64ths-of-a-degree.** The C quantizes angles to X11 arc units (`rint(atan2·11520/π)`) because `XDrawArcs` demands it; canvas takes float radians, so the port skips the quantization (sub-1/64° difference). Canvas arc angles share `atan2`'s y-down clockwise convention, so angles feed straight in — the C's negation (`angle1 = −a1`) exists only because X11 measures counterclockwise.
- **Sub-pixel arc centres**: the C rounds the arc bounding box to integer pixels (`rint(x−r)`); canvas strokes at float centres with AA.
- **Batching**: the C buffers 256 `XArc`s per `XDrawArcs`; the port accumulates all of a frame's segments in one path and strokes once (same one-colour result, and coincident AA edges composite once).
- **Resize** re-seeds the field (the canvas bitmap is lost anyway); the C's `reshape` keeps the circles and lets `move_circle` clamp them back in.
- **Retina**: backing store in device px; radii are height-relative (scale-free) and velocity is scaled by dpr so drift covers the same logical distance.

## Config
`piecewise.xml` 1:1 and nothing else: `delay` 10000 (0–100000, invert), `count` 32 (4–100), `colorspeed` 10 (0–100), `minradius` 0.05 (0.01–0.5), `maxradius` 0.2 (0.01–0.5). The old port's invented `alpha`, `fade`, `speed` and `ncolors` sliders are gone; `speed = 15` and `ncolors = 256` are the C's resource defaults with no xml knob, kept as constants. `colorspeed`/`delay` apply live; the rest re-seed.

## Speed
Stock `delay` = 10000 µs is the per-frame pace (`piecewise_draw` returns it). The rAF loop paces at **(delay + OVERHEAD)** µs per frame; `OVERHEAD = 9900` is live-measured via the binary's `-fps` overlay: 50.3 fps at Load 49.7% — a clean reading, the sleep slice `19881·(1−0.497) = 10000` equals the stock delay exactly.

## Audit history (2026-07)
The original port had replaced the entire mechanism with translucent **filled** discs under `'lighter'` additive compositing, gave every circle its own hue offset (`hsla(hue,100%,50%)`), and ran at a by-eye `delay: 20000`. All rebuilt as above: stroked piecewise arcs, one shared loop colour, stock delay. (The full-S/V rainbow *values* were coincidentally right — `make_color_loop` at s=v=1 **is** the vivid rainbow, `HSV(h,1,1) ≡ HSL(h,100%,50%)` — but it belongs on one shared colour, not per-circle.) Verified: port capture vs live binary side-by-side (same single-colour inverted-arc character, density, line weight), and a 600-frame run of the real module under a stubbed rAF measuring boundary-visibility continuity — mean per-frame flip fraction 5.3%, zero whole-circle inversions in 18 984 circle-frames, i.e. the anchor bit flips exactly when a crossing passes the wrap point.

## Encoding
ASCII-safe per the project rule: the only non-ASCII in DOM-bound strings is the micro sign in the delay unit, written `\u00B5s`. Em dashes and π appear only in comments/notes. Verified with `grep -nP "[^\x00-\x7F]" hacks/piecewise.js` (all hits on comment lines).
