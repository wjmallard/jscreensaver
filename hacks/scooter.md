# scooter — port notes

Port of `scooter.c` by Sven Thoennissen (2001; XScreenSaver port by EoflaOE, 2019) — a journey down a curving space tunnel through a star field. Originally a blanker from the Nightshift screensaver on the Amiga (EGS / VIONA Development). "Zooming down a tunnel in a star field. Originally an Amiga hack."

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/scooter.c` (~975 lines)

## Algorithm
The tunnel is a chain of **z-elements** — `ztotal = doorcount * 60` points strung one behind another along a path. Each z-element carries a 3D position and a 3D **rotation angle**; because each element's angle differs slightly from its neighbour's, the chain (and everything riding it) bends, so the corridor snakes.

Per frame (`shiftElements`):
1. **Scroll the angle chain** toward the viewer by `speed` (1..10), appending fresh angles at the far end. The new angles come from `calcNewElement`: a sine-eased nudge of a running rotation by a random per-interval delta in `[-14, +14]` per axis (`DOOR_CURVEDNESS`), re-rolling the delta and the interval length (10..30 s at speed 1) when it elapses.
2. **Rebuild every z-element's position** by walking the chain outward from the **spectator** (index 60, fixed on the z-axis at `z = 300·60`). Each step rotates the vector `(0,0,±300)` (`ZELEMENT_DISTANCE`) by that element's angle *relative to the spectator* and adds it to the previous element's position. This is what turns the angle drift into a curving 3D corridor.
3. **Scroll doors and stars** by `speed`; recycle any whose z-index drops below 0 (wrap by `+ztotal`). A recycled door gets the next ramp colour; a recycled star gets a fresh random off-axis position and size and is marked drawable.

Drawing: clear to black, then **stars** (small white rects, far off-axis, near-plane-clipped and screen-clipped) then **doors** (`DOOR_WIDTH × DOOR_HEIGHT` = 6000×4000 rectangles whose 4 corners are rotated by the door's spectator-relative angle, offset by its position, and projected). Projection is `proj = 12000 / (2.4·z)` scaled by `aspect_scale`; screen `x = midX + worldX·proj/10`, `y = midY − worldY·proj/10`. Any object with a corner at `z ≤ 0` is dropped (near-plane clip), so things grow and rush past as `z` shrinks, with no inversion.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. Closest technique twins: [[galaxy]] / [[grav]] (moving 3D objects under a 1/z projection) and [[braid]] (stroked shapes bucketed for canvas vector drawing).

## Rendering — full repaint per frame, vector ops
The C calls `XClearWindow` every frame (`cleardoors`) — there are **no accumulating trails** — so this is a full-repaint hack (like [[braid]], unlike [[grav]]). Each `step()` clears to black, advances the tunnel, and redraws. Doors are **stroked rectangles** (4 edges via `moveTo`/`lineTo`/`closePath`/`stroke`, `lineWidth = 2·dpr`); stars are **filled white rects** (`fillRect`). The load is sparse — at most ~40 doors and ≤200 star rects — so plain canvas vector ops beat a per-pixel `ImageData` blit over a mostly-black field.

## Deviations from the C
- **Stars drawn as rects, not ellipses.** The current C fills an ellipse per star (`XFillArc`, the rectangle path is `#if 0`'d out). We render the original **rectangle** form — it's the hack's historical drawing and what the port brief asks for ("stroked/filled rects"). Faithful to scooter's pre-2019 look; a one-line change to `arc`+`fill` would restore the ellipse if ever wanted.
- **Fast sin/cos table replaced by `Math.sin`.** The C precomputes a 0x8000-entry float `sintable` indexed by an integer angle masked to `0x7fff` (an Amiga-era speed trick). We keep the **same integer-angle units** (so the rotation deltas, `&= mask` wraparound, and accumulation match exactly) but compute `Math.sin(angle · 2π/0x8000)` directly. `COS(a)` = `SIN(a + 0x2000)`, mirrored.
- **No manual line clipping.** The C clips each door edge to the window (`clipline`) because X would draw the whole line otherwise. Canvas clips strokes to the surface for free, so `clipline` is dropped. The **door-level near-plane skip** (drop the whole door if any corner has `z ≤ 0`) is kept faithfully — `projectDoor` returns `null` then.
- **Integer truncation kept.** `rotate3d`'s products and every projected screen coordinate use `| 0` to match the C's `(int)` casts (truncate toward zero), so the accumulated curving path is bit-for-bit close to the original's integer math.
- **Colors.** Doors use the C's exact colour-ramp cycling (`randomColor` → interpolate `begin→end` over a random 8..39-step ramp), converted from 16-bit X channels to 8-bit `rgb()`. These are already vivid full-spectrum random colours, so no rainbow override was needed. Stars are white, as in the C ("in white colour, small stars look darker than big stars"). `ncolors ≤ 2` forces white doors (the C's mono path).
- **devicePixelRatio.** `aspect_scale` is `H / 864` (or `W / 1152` when narrower than 4:3) with `H`/`W` in device px, so the projection lands in device px and scales on retina for free; `lineWidth` is `·dpr`. (The C had a separate `pscale` of 2 past 2560 px; folding dpr in is the gallery convention and supersedes it.)
- **`--fps` / `--root`** are X-specific and omitted, as in the other ports.

## Correctness self-review
The brief flags "frame 1 looks dead", endless over-draw, and freezes. Verified headlessly (stub canvas/`window`, drive the rAF loop):
- **First drawn frame already shows the full corridor.** After the universal one-rAF lag-accumulator warm-up (the first callback banks 0 ms, same as squiral/galaxy/grav), the first real `step()` projects all 24 default doors with **96/96 corner-z values positive** and finite (door 0 ≈ 16200, then ≈34200, 52200, … — a clean receding sequence). No NaN, no near-plane inversion.
- **Recycle keeps a steady stream.** Doors redraw every frame; stars start with `draw = 0` (blank, as in the C) and switch on as they pass the near plane — observed climbing 1 → 36 → 38 over time and never emptying. The wrap math (`zelement += ztotal` after dropping below 0) means an element is always in range, so the chain never runs dry.
- **No degenerate loops / division by zero.** `colorSteps` is re-rolled to ≥ 8 before any interpolation divides by it; `rotationDuration` starts at 1 and is re-rolled to `10·fps + …` (≥ 1) on the first elapse; `projection` is only called after the `z ≤ 0` clip, so its denominator is always positive.
- **pause → resume** doesn't jump (`resume()` resets `lastTime = 0`, so no catch-up burst); **reinit** clears to black and rebuilds the chain/doors/stars (stars correctly start blank again). Live `cycles`/`delay` changes apply instantly with no throw.

## Config
Ranges mirror `hacks/config/scooter.xml`:
- `delay` — Frame rate, µs/step, default 20000, `invert: true` (the xml's `convert="invert"` slider), **live**.
- `cycles` — Speed ("Boat Speed" in the xml), 1–10, default 5, **live** (read every step; clamped to `[MIN_SPEED, MAX_SPEED]` as in the C, which ignores the xml's wider 0–1000 range).
- `count` — Doors, 4–40, default 24, **non-live** (sizes the z-element chain → `reinit()`).
- `size` — Stars, 1–200, default 100, **non-live** (sizes the star array → `reinit()`).
- `ncolors` — Colors, 2–255, default 200, **non-live** (richness of the door colour ramp; ≤ 2 → white).

`cycles`/`delay` are live because the loop reads them every step with no buffer to resize; `count`/`size`/`ncolors` re-seed via `reinit()` (which clears the canvas and rebuilds everything). "Reset to defaults" applies every key then reinits once.

**Local dev:** ES-module `import`s mean `file://` double-click won't work (CORS on the `null` origin). Serve it — `python3 -m http.server` in the repo, then open <http://localhost:8000/#scooter>. GitHub Pages serves over http, so production is unaffected.
