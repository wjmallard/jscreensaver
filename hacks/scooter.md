# scooter — port notes

Port of `scooter.c` by Sven Thoennissen (2001; XScreenSaver port by EoflaOE, 2019) — a journey down a curving space tunnel through a star field. Originally a blanker from the Nightshift screensaver on the Amiga (EGS / VIONA Development). "Zooming down a tunnel in a star field. Originally an Amiga hack."

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/scooter.c` (~975 lines)

## Algorithm
The tunnel is a chain of **z-elements** — `ztotal = doorcount * 60` points strung one behind another along a path. Each z-element carries a 3D position and a 3D **rotation angle**; because each element's angle differs slightly from its neighbour's, the chain (and everything riding it) bends, so the corridor snakes.

Per frame (`shiftElements`):
1. **Scroll the angle chain** toward the viewer by `speed` (1..10), appending fresh angles at the far end. The new angles come from `calcNewElement`: a sine-eased nudge of a running rotation by a random per-interval delta in `[-14, +14]` per axis (`DOOR_CURVEDNESS`), re-rolling the delta and the interval length (10..30 s at speed 1) when it elapses.
2. **Rebuild every z-element's position** by walking the chain outward from the **spectator** (index 60, fixed on the z-axis at `z = 300·60`). Each step rotates the vector `(0,0,±300)` (`ZELEMENT_DISTANCE`) by that element's angle *relative to the spectator* and adds it to the previous element's position. This is what turns the angle drift into a curving 3D corridor.
3. **Scroll doors and stars** by `speed`; recycle any whose z-index drops below 0 (wrap by `+ztotal`). A recycled door gets the next ramp colour; a recycled star gets a fresh random off-axis position and size and is marked drawable.

Drawing: clear to black, then **stars** (filled white ellipses, far off-axis, near-plane-clipped and screen-clamped) then **doors** (`DOOR_WIDTH × DOOR_HEIGHT` = 6000×4000 rectangles whose 4 corners are rotated by the door's spectator-relative angle, offset by its position, and projected). Projection is `proj = 12000 / (2.4·z)` scaled by `aspect_scale`; screen `x = midX + worldX·proj/10`, `y = midY − worldY·proj/10`. Any object with a corner at `z ≤ 0` is dropped (near-plane clip), so things grow and rush past as `z` shrinks, with no inversion.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. Closest technique twins: [[galaxy]] / [[grav]] (moving 3D objects under a 1/z projection) and [[braid]] (stroked shapes bucketed for canvas vector drawing).

## Rendering — full repaint per frame, vector ops
The C calls `XClearWindow` every frame (`cleardoors`) — there are **no accumulating trails** — so this is a full-repaint hack (like [[braid]], unlike [[grav]]). Each `step()` clears to black, advances the tunnel, and redraws. Doors are **stroked rectangles** (4 edges via `moveTo`/`lineTo`/`closePath`/`stroke`, `lineWidth = 2·dpr`); stars are **filled white ellipses** (`ellipse`+`fill`, the C's `XFillArc` inscribed in the star's clamped bounding box). The load is sparse — at most ~40 doors and ≤200 stars — so plain canvas vector ops beat a per-pixel `ImageData` blit over a mostly-black field.

The loop paces at **(delay + OVERHEAD)** µs per step — the C's `usleep(delay)` sits on top of its per-frame sim+draw cost, so the port must never run faster than the stock floor. Stock `delay` = 20000; `OVERHEAD` = 8100 µs live-measured via the binary's `-fps` overlay (35.6 fps at Load 28.7% — clean: the sleep slice `28090·(1−0.287) = 20028` ≈ the stock delay).

## Deviations from the C
- **Stars are ellipses, matching the shipping C.** `drawstars` fills `XFillArc(…, 0, 360·64)` inscribed in the star's screen box, and the box is **clamped to the window first** — a star at the screen edge gets a deformed (squashed) ellipse, not a clipped one; the port reproduces that quirk. A degenerate (zero-wide/high) box fills nothing in X, so sub-pixel stars pop in once they project to ~1 px — kept (`continue` on `bw/bh ≤ 0`; no minimum-size fudge). The Amiga-era **rectangle** star path sits `#if 0`'d in the C and is not what the binary draws. (X's un-antialiased fill is why "in white color, small stars look darker than big stars" — canvas AA gives that shading for free.) Half-sizes use integer division (`(width/2) | 0`) like the C's int math.
- **Fast sin/cos table replaced by `Math.sin`.** The C precomputes a 0x8000-entry float `sintable` indexed by an integer angle masked to `0x7fff` (an Amiga-era speed trick). We keep the **same integer-angle units** (so the rotation deltas, `&= mask` wraparound, and accumulation match exactly) but compute `Math.sin(angle · 2π/0x8000)` directly. `COS(a)` = `SIN(a + 0x2000)`, mirrored.
- **No manual line clipping.** The C clips each door edge to the window (`clipline`) because X would draw the whole line otherwise. Canvas clips strokes to the surface for free, so `clipline` is dropped. The **door-level near-plane skip** (drop the whole door if any corner has `z ≤ 0`) is kept faithfully — `projectDoor` returns `null` then.
- **Integer truncation kept.** `rotate3d`'s products and every projected screen coordinate use `| 0` to match the C's `(int)` casts (truncate toward zero), so the accumulated curving path is bit-for-bit close to the original's integer math.
- **Colors.** Doors use the C's exact colour-ramp cycling (`randomColor` → interpolate `begin→end` over a random 8..39-step ramp), converted from 16-bit X channels to 8-bit `rgb()`. These are already vivid full-spectrum random colours, so no rainbow override was needed. Stars are white, as in the C. The mono gate mirrors xlockmore's `MI_NPIXELS` exactly: `--ncolors` **1–2** → white doors; **≤ 0** falls back to 64 (`xlockmore.c:466`), i.e. still colourful; and any value ≥ 3 has **no further effect** — the ramp is the door's own `XAllocColor` pipeline, not the xlock palette, so there is no "number of colours" to vary.
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
- `delay` — Frame rate, µs/step, default 20000 (stock), `invert: true` (the xml's `convert="invert"` slider), **live**. The loop paces at `(delay + OVERHEAD)`; a delay of 0 is also guarded in `calcNewElement` (the C's `fps = 1000000/MI_DELAY` would divide by zero).
- `cycles` — Speed ("Boat Speed" in the xml), 1–10, default 5, **live** (read every step; clamped to `[MIN_SPEED, MAX_SPEED]` as in the C, which ignores the xml's wider 0–1000 range — everything past 10 is dead slider).
- `count` — Doors, 4–40, default 24, **non-live** (sizes the z-element chain → `reinit()`).
- `size` — Stars, 0–200, default 100, **non-live** (sizes the star array → `reinit()`; the C clamps `< 1` to 1, so 0 ≡ 1 star).
- `ncolors` — Colors, 0–200, default 200, **non-live** (mono gate only: 1–2 → white doors; 0 → colourful via xlockmore's 64 fallback; every value ≥ 3 is identical — the ramp itself is always full-colour).

`cycles`/`delay` are live because the loop reads them every step with no buffer to resize; `count`/`size`/`ncolors` re-seed via `reinit()` (which clears the canvas and rebuilds everything). "Reset to defaults" applies every key then reinits once.

**Local dev:** ES-module `import`s mean `file://` double-click won't work (CORS on the `null` origin). Serve it — `python3 -m http.server` in the repo, then open <http://localhost:8000/#scooter>. GitHub Pages serves over http, so production is unaffected.
