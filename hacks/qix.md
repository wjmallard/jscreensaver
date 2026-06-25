# qix — port notes

Port of `qix.c` by Jamie Zawinski (1992) — bounces a polygonal "line" around the screen, trailing the classic Qix rainbow ribbon.

Original: <https://www.jwz.org/xscreensaver/> · source: `qix.c` (~641 lines) · <https://en.wikipedia.org/wiki/Qix>

## Algorithm
A *qix* is a ring buffer of `segments` polygon **frames**; each frame is a snapshot of `poly` vertices (default 2 = a plain line segment), every vertex carrying a position and a velocity. Frame 0 is seeded randomly and all the others start as copies of it, so the trail begins collapsed and unfurls. Each step (the C's `qix1`):

1. **Erase** the polygon in the slot about to be overwritten (the oldest) by repainting it in black.
2. **Build** the new polygon by copying the previous frame's vertices, then advancing every vertex by its velocity and **reflecting** it off the walls (the `wiggle` macro: optionally jitter the velocity, clamp it to `±spread`, step, and on a wall hit pin to the wall and reverse — `point += 2·|delta|`).
3. **Hue-shift** by `colorShift` degrees and **draw** the new polygon, then advance the write pointer.

At steady state exactly `segments` polygons are live: one drawn and one erased per step, a constant-length ribbon. With `solid` (the default, `poly` forced to 2) consecutive frames are joined into a **filled quad** — the solid ribbon; `hollow` strokes the closed polygon outline. `gravity` adds a downward pull to every vertex's `dy`; `random` motion jitters velocities each step (vs. clean `linear` bounces). `count` runs several independent qixes at once.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. Closest twins: `spiral.js` (the same ring-buffer **draw-newest / erase-oldest** trail) and `braid.js` (vector strokes via `Path2D`/`beginPath`).

## Rendering — sparse vector ops, draw-newest / erase-oldest
This is line/quad-shaped (a few hundred thin shapes spread over time, not a per-pixel field), so it uses canvas **vector ops**: one `fill()` of a 4-point quad (solid) or one closed `stroke()` polyline (hollow) per step per qix. Like the C — and like `spiral.js` — it does **not** clear and redraw the whole queue each frame; it draws the single new polygon and erases the single outgoing one in black, leaving the rest of the trail untouched. That is `O(1)` shapes per step instead of `O(segments)`.

A faithful quirk carried over from the C: a slot is **drawn** paired with its *predecessor* frame (`ofp = fp-1`) but later **erased** paired with its *successor* (`fp+1`). Tracing the ring shows every drawn quad is still erased exactly once, one slot-cycle later, so nothing accumulates — see *Correctness* below.

## Deviations from the C
- **No XOR, no transparency/additive color planes.** The C offers `-xor` (X11 `GXxor`) and `-transparent`/`-additive`/`-subtractive`, all of which rely on X11 GC raster-ops and writable color-plane masks that have no Canvas-2D equivalent. Rather than fake them, the port drops those modes and renders the **default look**: opaque draw-newest / erase-oldest with a cycling hue, which is exactly the non-transparent, non-xor path of the C (`*transparent` only ever did anything with `count > 1` on a paletted display). Noted here per the brief's XOR/feedback rule. `transparent`/`xor`/`additive`/`subtractive` are therefore omitted from the config box.
- **Float device-pixel coords instead of fixed-point `<<6`.** The C works in `<<SCALE` (SCALE=6) fixed-point and `>>SCALE`s only at draw time. The port keeps positions/velocities directly in device pixels (scaled by `devicePixelRatio`), so `spread`/`size` are multiplied by `S` rather than shifted. The reflection arithmetic and clamps are converted cleanly, not half-converted.
- **`devicePixelRatio`**: the backing store is sized in device px; `spread` (velocity clamp), `size` (extent clamp), the random-jitter amount, and the gravity pull are all multiplied by `S`, so motion and density look the same on retina.
- **Gravity strength bumped.** The C adds `3` to `dy` in `<<6` units (≈0.05 px/step) every frame, which is nearly imperceptible; the port adds `0.5·S` px/step so the Gravity toggle visibly arcs the ribbon.
- **`poly` cap 24** (the C's `MAXPOLY` is 16) and the xml's `high="100"` is trimmed to a saner slider range; **`count` default 2** (xml 4) and max 12, since opaque overlapping ribbons get busy fast on a bright canvas. `delay` left at the stock 10  ms.
- **Hue cycling** uses `hsl(h, 100%, 55%)` for a vivid rainbow; the C did an RGB↔HSV round-trip through the colormap. `colorShift` (Color contrast) maps 1:1 as degrees-per-frame.
- Keypress / `fps` handling and the periodic `get_geom` re-query are dropped — the host owns keys and the meter, and `resize()` already re-seeds on a window change.

## Config
Ranges mirror `hacks/config/qix.xml`: `delay` (Frame rate, live, inverted µs), `spread` (Density, live, inverted — bigger spread = faster/denser ribbon), `colorShift` (Color contrast, live), `gravity` (live); `segments` (trail length), `count`, `size` (Max size), `poly` (Poly corners), and the `fill` (Solid/Line) select are **non-live** (they size the queue / vertex count / qix count, so a change re-runs `init()` via `reinit()`, clearing the canvas). `motion` (Linear/Random) is live. "Reset to defaults" and `r` (restart) re-seed via `reinit()`.

## Correctness self-review
- **Bounded queue, no growth.** The ring buffer is allocated once at `init()` to `segments` frames; `step()` only overwrites the slot at `fp` and advances `fp` modulo `nlines`. Trail length is constant.
- **No residue.** Each physical rib (the quad between adjacent slots *k* and *k-1*) is drawn when slot *k* is written and erased when slot *k-1* is recycled, one slot-cycle later — so every drawn shape is erased exactly once. Verified by tracing the ring with `nlines = 4` by hand (including the first cycle).
- **Clean first frame, no degenerate start.** The seed frame is randomised inside `[0,W]×[0,H]` (or within `size` for `poly=2`), and all frames start `dead=true`, so the first `segments` steps only *draw* (the `if (!old.dead)` guard skips the not-yet-drawn erase) — the trail unfurls from a single polygon, on-screen from frame one.
- **Bounce from frame one.** `wiggle` pins any out-of-bounds vertex back onto the wall and reverses its velocity in the same step, so even an initially fast vertex can never escape `[0, max]`.
- **Pause/resume & reinit.** Pause cancels rAF and parks `rafId = 0`; resume resets `lastTime = 0` to avoid a catch-up burst (standard skeleton). `reinit()` clears to black and rebuilds the queue, giving a fresh screen.
- **Solid-quad guard.** Solid draws skip when the partner frame is `dead`, and the trace above shows the partner (`fp+1`, the oldest) is always alive by the time an alive frame is erased — so no malformed quad is ever drawn or erased.
