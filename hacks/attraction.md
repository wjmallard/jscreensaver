# attraction — port notes

Port of `attraction.c` (Jamie Zawinski & John Pezaris, 1992; viscosity by Philip Edward Cutone III; walls/maxspeed/graphs by Matt Strait) — a handful of balls move under a quasi-gravitational field that *attracts* at range but *repels* below a threshold, "similar to the strong and weak nuclear forces", so the balls swirl around each other forever without colliding.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/attraction.c` (~1114 lines) + `xscreensaver-6.15/utils/spline.c` (closed spline).

## Algorithm
Each ball has a position `(x,y)` (its top-left anchor), velocity `(vx,vy)`, a pending force `(dx,dy)`, a `size` and a `mass = size²·10`. Each step (`step()`, the math half of the C's `attraction_draw`):

1. **Force** (`computeForce`, the C's `compute_force`): for every *other* ball `j`, accumulate `acc = (mass_j / dist²) · (dist < threshold ? -1 : +1)`, projected onto the unit vector toward `j` (`acc/dist · (x_j-x_i)`). So it's a `1/r²` attraction that flips to a `1/r²` *repulsion* once two balls are closer than `threshold` — the repulsion wall is what keeps them from ever colliding. If two balls overlap (`dist ≤ 0.1`) they get a small random kick instead.
2. **Integrate**: `v += d`; optionally a thresholded terminal-velocity damping (`maxspeed`: any `|v|>10` gets one `×0.9` and its pending force zeroed); optionally a global `viscosity` multiply (`v *= viscosity`, `1` = frictionless); then `p += v`.
3. **Bounce** (correct-bounce): while out of bounds (≤ 4 resolutions/step) reflect both position and velocity off each wall. A ball's anchor is its top-left, so the right/bottom walls are at `W-size` / `H-size`.

**Seeding** (`seedBalls`, the C's `attraction_init` body): balls are placed evenly on a ring of radius `r = min(W,H)/2 − 50` about the centre, at a random phase `th`. Non-orbit balls get a small random velocity (`(6−rand%11)/8` per axis); orbit balls are given a *matched* size and a tangential speed `v = √(a·r)·vMult` (where `a` is the net radial force solved at angle 0) so they swing around the centre instead of clumping. If that force solves negative ("window too small for these orbit settings") the C bails to a plain random seed — we do the same with a bounded 2-try retry.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Render modes (one physics, several looks)
The `mode` select picks how the same balls are drawn, matching the C's six modes:

- **balls** (default) — each ball is a filled disc. **Rendered on a persistent canvas with an added alpha-fade trail** (galaxy's trick): each frame paints `rgba(0,0,0,1−trails)` over the whole canvas then draws the discs, so the default looks like a cloud chamber. `trails: 0` paints solid black instead → the C's exact "erase old disc, draw new disc" no-trail look. With **glow** on, the C ties colour *saturation* to acceleration via a colour ramp; we map acceleration onto *hue* across the rainbow palette instead (fast balls one end, slow the other) — same "colour reacts to force" idea in the gallery's vivid palette.
- **lines / polygons** — the balls are the vertices of a moving outline (open polyline / filled polygon). In these modes every ball *after the first* is given `size = 0` (mass unchanged) so the figure uses the whole window, exactly as the C does.
- **tails** — a fading trail behind each ball: one round-capped polyline per ball through its last `segments` positions.
- **splines / filled-splines** — a smooth *closed* curve through the balls. The C calls `compute_closed_spline` (utils/spline.c), an InterViews Catmull-Rom spline that converts each 4-control-point section into a cubic Bézier and line-approximates it; we port the same `calc_section` math (`third_point`/`mid_point` → Bézier control polygon) and hand the Béziers straight to canvas `bezierCurveTo` — same curve, far fewer ops than the recursive line subdivision.

## Rendering — sparse vector ops + a rolling history
Ball mode is sparse filled `arc`s on the persistent canvas (a few discs over a mostly-black field), like `grav`. The line/polygon/tail/spline modes keep a **rolling ring buffer of the last `segments` point-sets** (each tagged with the cycling foreground colour) and **full-repaint every frame** — clear, then stroke/fill every stored frame oldest-first. This is the one significant deviation:

- The C never clears in these modes. Instead it keeps a `point_stack` ring and each frame *erases the oldest frame's geometry by re-drawing it in the background colour*, then draws the newest — an XOR-free "subtract the tail" trick. Canvas can't do that cleanly: over-drawing the oldest outline in black would punch holes in any other outline it crosses. A full repaint of the whole history each frame yields the **identical rolling-ribbon look** without the erase artefacts, at the cost of redrawing `segments` paths/frame (bounded, and each path is ≤ `npoints+1` points). See `braid.js` for the Path2D-per-colour idea.

## Loop
Standard rAF lag-accumulator paced by `config.delay` (µs in the xml, ÷1000 for the ms rAF clock), same as `squiral.js`, with a catch-up cap (here **6**) so a backgrounded tab doesn't burst on refocus. The physics is the expensive part for many balls, so `draw()` runs at most once per frame (only when ≥ 1 step happened). The one-time black background after a reinit/resize is painted in `frame()`, then frame 1 immediately draws the seeded balls/outline so nothing starts blank.

## Deviations from the C
- **Ball trails** added (alpha fade, default `0.20`); not in the stock UI (the C erases each old disc). `trails: 0` is faithful. This is what makes the *default* mode read as the requested "balls with trails".
- **Full repaint** for line/poly/tail/spline modes instead of the C's erase-the-oldest-frame over-draw (above) — forced by the lack of an XOR/erase raster op on canvas; visually equivalent.
- **Glow** maps acceleration onto hue rather than the C's saturation colour-ramp (the gallery uses full-saturation `hsl()` rainbows); same "colour tracks force" behaviour.
- **Colours**: ball mode gets one evenly-spaced (shuffled) rainbow hue per ball (the C builds a random colormap of `npoints` entries); line/tail/etc. cycle a single `hsl()` rainbow stepped every `colorShift` frames (the C cycles a smooth colormap). Vivid full-saturation per house style.
- **devicePixelRatio**: sizes, velocities, the `threshold`, the speed limit and line widths are all scaled by `dpr` (`S`) so the simulation fills the same fraction of the screen and looks the same physical size on retina. The mass (`size²·10`) scales with the dpr-scaled size, which scales the forces consistently.
- **Dropped (X-/desktop-only):** the velocity/speed **graph meters** (`--graphmode` bar graphs) and **mouse-drag** ball-grabbing — both are interactive/diagnostic X11 features with no place in an unattended saver. The `radius`/`vx`/`vy` resource overrides and `--fps` overlay are likewise omitted; `radius` defaults to the auto value, `vx`/`vy` to the random seed.
- **`delay`** default eased from the stock `10000` µs to `14000` for a calmer pace (per the porter brief); the xml max (`40000`) is preserved.

## Correctness self-review
- **No termination / no freeze.** There is no closure or end state — the field is steady-state. Balls stay bounded because (a) the sub-threshold *repulsion* prevents collisions and runaway `1/r²` blow-ups (the overlap branch only fires at `dist ≤ 0.1` and just nudges randomly), (b) `maxspeed` caps speed at `~10·S` and (c) walls reflect anything that escapes. With the frictionless default the known C non-conservation slowly adds energy, but `maxspeed` bleeds it, so the motion never stalls *or* runs away. Traced by hand; ran the default for an extended period mentally against the C's move loop.
- **State re-seeded on every branch.** `reinit()`/resize go through `init()`, which rebuilds balls, palette **and** the history ring, and resets `historyFp`/`fgIndex`/`colorTick`/`totalTicks` — so a config change (mode, count, segments, colours, orbit) starts from a clean, fully-seeded state. The orbit retry re-seeds velocities on fallback.
- **History ring indexing checked.** `step()` increments `totalTicks` *before* `pushHistory`, and the draw walks `idx = (historyFp − have + s) mod cap` with `have = min(totalTicks, cap)`, so before the ring fills it reads only the frames actually written (no stale `null`s drawn; `drawFrame`/`drawTails` also null-guard). Verified the first-frame case (writes index 0, reads index 0).
- **First frame looks right.** Balls are seeded on a visible ring inside the window and drawn immediately after the one-time background, so frame 1 is already a clean ring (not an off-screen or degenerate start). Orbit mode's tangential velocities give an immediate swirl.
- **pause/resume** uses the `rafId === 0` sentinel and resets `lastTime = 0` on resume, so no catch-up burst; **stop** cancels the rAF and removes the resize listener.

### Spot-check requests for the browser
- **Spline modes** with the default 3–7 balls (n ≥ 3 → real Béziers): confirm the closed curve is smooth and actually *closed* (no gap or cusp at ball 0). With `points < 3` polygons fall back to lines (as in the C); splines with n < 3 degrade to a straight segment.
- **Orbit mode** on a small window: confirm the negative-force fallback drops to a sane random seed rather than producing NaNs (I bounded the retry to 2 tries).
- **Trail length (`segments`)** at the max (1000) in line/spline mode is 1000 path strokes/frame — confirm it's still smooth on your machine; lower it if not (it's `live: false`, so a change reseeds).
