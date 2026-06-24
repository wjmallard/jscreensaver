# truchet — port notes

Port of `truchet.c` by Adrian Likins (1998) — Truchet tilings: the screen is cut into a grid of equal square cells and each cell randomly draws one of two tile orientations, so the tiles chain together into flowing maze-like curves (arcs) or zig-zags (lines).

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/truchet.c` (~540 lines)

Shares squiral's skeleton (inline ES module, `config` object, rAF + lag-accumulator loop, dpr scaling) — see [`squiral.md`](squiral.md). Vector strokes bucketed into one `Path2D` per frame, like [`braid.md`](braid.md).

## Algorithm
Every frame regenerates the **whole** field (the C's `truchet_draw`): roll a random colour, a random even line width in `[minLineWidth, maxLineWidth]`, and a random **square** cell size in `[minWidth, maxWidth]`; optionally clear; then walk a grid from the origin and, per cell, pick one of two orientations:

- **Arc tiles** (`draw_truchet`): two quarter-circle arcs, each centred on an **opposite pair of the cell's corners** with radius = half the cell. Orientation 0 puts arcs on the TL+BR corners (bulging into the SE & NW of the cell); orientation 1 puts them on TR+BL (SW & NE). Because every arc is centred on a corner with radius `cell/2`, it passes through two **edge midpoints**, and the neighbouring cell's arc shares those same midpoints — so the curves are continuous across boundaries.
- **Line tiles** (`draw_angles`): the same two orientations as straight diagonals joining adjacent edge midpoints.

When both flavours are enabled the C flips a coin each frame to draw one or the other; with only one enabled it always draws that one. The whole pattern flashes to a new random size/width/colour/orientation field every `delay`.

## Geometry — how the arcs map from X11 to canvas
The C draws with `XDrawArc(... x, y, w, h, angle1, angle2)` where the bounding box is `w × h` (a full cell) but offset by `±w/2, ±h/2` from the cell corner, so the box **centre** (= the arc centre) sits on a corner and the radius is `w/2`. X11 angles are 1/64°, measured CCW from 3 o'clock, but rendered into screen space (Y down). Tracing each of the four corner arcs to its two screen endpoints gives the four into-cell quarter-circles, which map to canvas `ctx.arc(cornerX, cornerY, r, a0, a1)` (canvas 0°=E, 90°=S, 180°=W, 270°=N, sweeping clockwise) as:

| corner | from → to (edge mids) | canvas arc |
|---|---|---|
| TL | top-mid (E) → left-mid (S) | `arc(0, π/2)` |
| BR | bottom-mid (W) → right-mid (N) | `arc(π, 3π/2)` |
| TR | right-mid (S) → top-mid (W) | `arc(π/2, π)` |
| BL | left-mid (N) → bottom-mid (E) | `arc(3π/2, 2π)` |

All four are the 90° quarter that bulges into the cell interior; each `arc` is preceded by a `moveTo` to its start midpoint so the sub-paths don't connect.

## Rendering — vector ops, one Path2D per frame
Tiles are thin strokes, not per-pixel accumulation, so this uses **canvas vector ops** (not the ImageData blit path). A frame is at most a few thousand short quarter-arcs / lines and they all share one colour, so the entire grid is accumulated into a single `Path2D` and stroked **once** per frame — `lineCap`/`lineJoin` `'round'` reproduce the C's `CapRound`/`JoinRound`.

## Deviations from the C
- **Square cells only.** The C also supports non-square tiles (separate `minHeight`/`maxHeight`, with a `MAXRATIO` aspect clamp), but its default `square` is True and the modern xml doesn't expose height; the port draws square cells (`w × w`) and skips the separate height knobs. The clamp `lineWidth ≤ cell/5` is kept.
- **Scroll mode is NOT ported.** The C's `-scroll` pans an oversized off-screen pixmap with `XCopyArea` for an animated drift between frames. It's off by default, not in the modern xml, and has no clean canvas analogue worth the complexity, so it's dropped (no scroll/anim params).
- **`-randomize` startup roll dropped.** The C, on launch, randomly picks one of 12 preset option combos (no-curves, square+no-erase, tiny tiles, etc.). The port exposes those same options as live config knobs instead of randomising them once at startup, so the look is steerable rather than a one-shot dice roll.
- **Colour**: the C `XAllocColor`s a fully random RGB each frame; the port uses a random vivid `hsl(0..359, 100%, 50..69%)` so every frame is saturated (no muddy random greys). Mono path dropped.
- **Clears every frame when erasing.** The C renders into an off-screen pixmap and `XCopyArea`s it to the window; canvas is already double-buffered, so the frame is drawn straight to the canvas. The no-erase path (`erase` off → clear only once `count` reaches `eraseCount`, stacking overlaid patterns) is preserved.
- **Units / tuning**: `delay` stays in **µs** (xml units, default 400000 = 400 ms, kept — a full-screen regenerate at that pace is already calm). Cell/line sizes are logical CSS px scaled by `devicePixelRatio` (`S`) so tiles and stroke weight look the same on retina. Keypress / `fps` handling dropped (the host owns keys and the meter).

## Correctness self-review
- **Arc continuity (the whole point).** Verified the arc centre is a cell **corner** and the radius is exactly `cell/2`, so each arc terminates on an edge **midpoint** shared with the adjacent cell — the curves join seamlessly. Each `ctx.arc` is the in-cell quarter (checked the swept mid-angle lands inside the cell for all four corners), and a `moveTo` to the start point precedes every `arc` so Path2D doesn't draw a connector chord between sub-arcs.
- **Grid coverage.** The loops run `for (x|y = 0; < cw|ch; += cell)`, i.e. they start at the origin and emit one cell past the right/bottom edge (the last cell's origin can be `< cw` while the cell extends past it), so there are no uncovered margins — matching the C's `while(width > cx*w)` bound with `overlap = 0`.
- **No freeze / no runaway draw.** There is no state machine to wedge: `step()` is stateless apart from `count`, and each frame fully repaints. `cell = max(2, round(w*S))` and `irand(maxW+1)` with the `w === 0 → maxW` guard mean the cell size is always ≥ 2 px, so the tile loops always terminate (no zero-step infinite loop) and never explode into millions of tiles. Line width is `max(1, …)`.
- **Min/max swaps tolerated.** A user can drag the "min" slider above the "max"; the port `Math.min`/`Math.max`es the pair before use so the random range is always valid.
- **Pause / resume / reinit.** `pause()` cancels rAF and sets `rafId = 0`; `resume()` resets `lastTime = 0` (no catch-up burst) and only restarts if paused. `reinit()` clears to black and draws one fresh frame. `MAX_CATCHUP_STEPS = 4` (lower than the usual 8 — each step repaints the entire screen, so a backgrounded tab shouldn't fire many full regenerates on refocus).

## Config
All knobs are **live** (the loop reads `config` every frame, so edits apply on the next regenerate — no reinit needed): `delay` (Frame rate, µs, inverted), `curves` / `angles` (which flavours are eligible), `minWidth` / `maxWidth` (cell-size range, CSS px), `minLineWidth` / `maxLineWidth` (stroke range, CSS px), `erase` (clear every frame), `eraseCount` (frames to stack before a clear when not erasing). Defaults transcribed from the C's resource table; the modern `hacks/config/truchet.xml` only exposes delay + fps. `reinit` / `r` (restart) repaints one fresh frame.
