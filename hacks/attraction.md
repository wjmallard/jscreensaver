# attraction — port notes

Port of `attraction.c` (Jamie Zawinski & John Pezaris, 1992; viscosity by Philip Edward Cutone III; walls/maxspeed/graphs by Matt Strait) — a handful of balls move under a quasi-gravitational field that *attracts* at range but *repels* below a threshold, "similar to the strong and weak nuclear forces", so the balls swirl around each other forever without colliding.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/attraction.c` (~1114 lines) + `xscreensaver-6.15/utils/spline.c` (closed spline) + `xscreensaver-6.15/utils/colors.c` (colormaps). Demo video: <https://www.youtube.com/watch?v=KAT9nkXCdms>.

## Algorithm
Each ball has a position `(x,y)` (its top-left anchor), velocity `(vx,vy)`, a pending force `(dx,dy)`, a `size` and a `mass = size²·10`. Each step (`step()`, the math half of the C's `attraction_draw`):

1. **Force** (`computeForce`, the C's `compute_force`): for every *other* ball `j`, accumulate `acc = (mass_j / dist²) · (dist < threshold ? -1 : +1)`, projected onto the unit vector toward `j` (`acc/dist · (x_j-x_i)`). So it's a `1/r²` attraction that flips to a `1/r²` *repulsion* once two balls are closer than `threshold` — the repulsion wall is what keeps them from ever colliding. If two balls overlap (`dist ≤ 0.1`) they get a small random kick (`frand(10)-5`) instead.
2. **Integrate**: `v += d`; optionally a thresholded terminal-velocity damping (`maxspeed`: any `|v|>10` gets one `×0.9` and its pending force zeroed); optionally a global `viscosity` multiply (`v *= viscosity`, `1` = frictionless); then `p += v`.
3. **Bounce**: default is *correct-bounce* (`cbounce`): while out of bounds (≤ 4 resolutions/step) reflect both position and velocity off each wall. A ball's anchor is its top-left, so the right/bottom walls are at `W-size` / `H-size`. (The C's *old-bounce* branch is also ported for completeness but is never the default.)

**Seeding** (`seedBalls`, the C's `attraction_init` body): balls are placed evenly on a ring of radius `r` about the centre at a random phase `th`; `r = radius` resource, or auto = `min(W,H)/2 − 50` (the C clamps to the window when walls are on). Non-orbit balls get a small random velocity (`(6−rand%11)/8` per axis); orbit balls are given a *matched* size and a tangential speed `v = √(a·r)·vMult` (where `a` is the net radial force solved at angle 0) so they swing around the centre instead of clumping. If that force solves negative ("window too small for these orbit settings") the C bails to a plain random seed — we do the same with a bounded 2-try retry.

## Colour — FAITHFUL colormaps (this was the main bug fixed in the audit)
The earlier port painted everything with a vivid full-saturation `hsl()` rainbow. That is **not** what the C does. `attraction.c` builds three different colormaps (from `utils/colors.c`), ported here via `colormap.js`:

- **ball mode, no glow** (the default) → `make_random_colormap(npoints, bright_p=True)`: `npoints` independent **bright** colours (HSV hue 0–360, sat 30–100%, value 66–100% — vivid but *not* pure-rainbow), one per ball, **fixed for the whole run** (`pixel_index = random() % npoints`). Port: `makeRandomColormapRGB(nballs, true)`, each ball a fixed random index — same idiom as `grav.js`.
- **ball mode, glow** → `make_color_ramp(H,0.25,V → H,1.0,V)`, a **single-hue saturation ramp** of `ncolors` entries (one random hue `H`, value `V = frand(0.25)+0.75`). Each ball indexes it by acceleration: `s = 1 − (|dx|+|dy|)/0.5`, `index = ncolors·s` → slow balls vivid (sat 1.0), fast balls washed out (sat 0.25). Port: `makeColorRampRGB(H,0.25,V,H,1.0,V,ncolors,closed=false)`, indexed identically. (The old port mapped acceleration onto *hue* across the rainbow — wrong axis, wrong palette.)
- **lines / polygons / splines / filled-splines / tails** → `make_smooth_colormap(ncolors)`: a muted 2–5-anchor HSV loop. Port: `makeSmoothColormapRGB(ncolors)`, **cycled** one step every `colorShift+1` frames via `fg_index` (the C's `if (color_tick++ == color_shift)`).

`ncolors ≤ 2` ⇒ **mono**: the C drops to white (`mono_p`); the port draws white and does not cycle.

**Cadence:** all colormaps are built once per `init()` (and rebuilt on a reinit/resize, since the port reseeds there — see deviations). Only the non-ball smooth map *cycles* in place; nothing is rebuilt per frame.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `swirl.md` / `grav.md`.

## Render modes (one physics, several looks)
The `mode` select picks how the same balls are drawn, matching the C's six modes:

- **balls** (default) — each ball is a filled disc (`XFillArc`, top-left anchor, diameter = `size`). **Hard-cleared to black each frame**, then the discs are drawn. The C erases each ball's *old* disc and draws the *new* one; on a black field that is identical to a full clear + redraw, so this is faithful (no motion trails — the earlier port's added alpha-fade "cloud chamber" trail has been removed).
- **lines / polygons** — the balls are the vertices of a moving outline (open polyline / filled polygon, closed by a copy of ball 0). In these modes every ball *after the first* is given `size = 0` (mass unchanged) so the figure uses the whole window, exactly as the C does. `line_width = 1`.
- **tails** — one round-capped worm per ball through its last `segments` positions, offset by `radius` and `tailWidth = global_size or MAX_SIZE·2/3` wide (≈10 px when size is unset). Each segment keeps the cycling colour it was drawn in, so the worm carries a colour gradient (we group equal-colour runs into sub-paths).
- **splines / filled-splines** — a smooth *closed* curve through the balls. The C calls `compute_closed_spline` (utils/spline.c), an InterViews Catmull-Rom spline that converts each 4-control-point section into a cubic Bézier and line-approximates it; we port the same `calc_section` math (`third_point`/`mid_point` → Bézier control polygon) and hand the Béziers straight to canvas `bezierCurveTo` — the *identical* curve, far fewer ops than the recursive subdivision. With `< 3` control points the C draws nothing; the port matches.

## Rendering — sparse vector ops + a rolling history
Ball mode is sparse filled `arc`s on a freshly-cleared field, like `grav`. The line/polygon/tail/spline modes keep a **rolling ring buffer of the last `segments` point-sets** (each tagged with the cycling colour) and **full-repaint every frame** — clear, then stroke/fill every stored frame oldest-first. This is the one significant *forced* deviation:

- The C never clears in these modes. Instead it keeps a `point_stack` ring and each frame *erases the oldest frame's geometry by re-drawing it in the background colour*, then draws the newest — an XOR-free "subtract the tail" trick. Canvas can't do that cleanly: over-drawing the oldest outline in black would punch holes in any other outline it crosses. A full repaint of the whole history each frame yields the **identical visible result** (the last `segments` outlines, each in its own colour) without the erase artefacts, at the cost of redrawing `segments` paths/frame (bounded; each path is ≤ `npoints+1` points).

## Coordinate space — CSS pixels, not device pixels
The simulation runs in **logical (CSS) pixels** using the C's exact constants (threshold 200, `−50` ring margin, velocity `(6−rand%11)/8`, speed limit 10, `size_scale·(8+rand%7)`), so it behaves like the original on a 1:1 monitor. The canvas backing store is device-px and a single `ctx.setTransform(dpr,…)` scales all drawing up for crispness on retina. The earlier port ran the physics in *device* pixels with a `×dpr` factor on positions/velocities/threshold/mass — but that factor does **not** cancel in the force law (accelerations stayed unscaled while velocities/positions were scaled), so the dynamics evolved differently on retina displays. Running in CSS px removes the distortion entirely.

## Loop
Standard rAF lag-accumulator paced by `config.delay` (µs in the xml, ÷1000 for the ms rAF clock), same as `swirl.js`, with a catch-up cap (here **6**) so a backgrounded tab doesn't burst on refocus. The physics is the expensive part for many balls, so `draw()` runs at most once per frame (only when ≥ 1 step happened). The one-time black background after a reinit/resize is painted in `frame()`, then frame 1 immediately draws the seeded balls/outline so nothing starts blank.

## Config — mirrors `hacks/config/attraction.xml`
The params expose exactly the `.xml` controls: `delay` (Speed, inverted), `mode`, `walls` (the xml's `wallmode` select, as a checkbox), `points`, `viscosity` (inverted), `segments`, `ncolors`, `size` (labelled "Ball mass"), `threshold`, `orbit`, `radius`, `vMult` (Outward↔Inward). The `.xml` does **not** expose `glow`, `maxspeed`, `cbounce`, `colorShift`, `graphmode`, `vx`/`vy`, or the mouse-drag — those are command-line-only resources, so they are kept **internal at their C defaults** (`glow=false`, `maxspeed=true`, `cbounce=true`, `colorShift=3`) and are not surfaced as sliders. The earlier port had also added an invented **trails** slider — removed (the C has no such resource).

## Deviations from the C
- **Full repaint** for line/poly/tail/spline modes instead of the C's erase-the-oldest-frame over-draw (above) — forced by the lack of an XOR/erase raster op on canvas; visually equivalent.
- **Reseed on resize.** `attraction_reshape` only updates the bounds (keeps the balls + colormap); the port reseeds and rebuilds the palette via `init()`. Brief visual discontinuity on a window resize only; matches the gallery's house pattern.
- **Framerate calibration (`OVERHEAD = 6694`).** `delay` defaults to the **stock 10000 µs** (the xml min/max `0`/`40000` preserved); the rAF loop adds `OVERHEAD` so `(delay + OVERHEAD)` reproduces the live binary's effective rate. Measured against the live `-fps` overlay attraction runs **59.9 fps**, so `10000 + 6694 = 16694 µs → 59.9 steps/sec`. A calibration, not a tuning knob — see the framerate-calibration note.
- **Anti-aliasing.** The C disables AA on its GCs; canvas arcs/strokes are anti-aliased. Minor edge softening only; with a hard clear each frame there is no ghosting.
- **Dropped (X-/desktop-only):** the velocity/speed **graph meters** (`--graphmode`) and **mouse-drag** ball-grabbing (both interactive/diagnostic X11 features with no place in an unattended saver); the `vx`/`vy` seed-velocity overrides; and the `--fps` overlay.

## Correctness self-review
- **No termination / no freeze.** There is no closure or end state — the field is steady-state. Balls stay bounded because (a) the sub-threshold *repulsion* prevents collisions and runaway `1/r²` blow-ups (the overlap branch fires only at `dist ≤ 0.1` and just nudges randomly), (b) `maxspeed` caps speed at `10` px/step and (c) walls reflect anything that escapes. With the frictionless default the known C non-conservation slowly adds energy, but `maxspeed` bleeds it, so the motion never stalls *or* runs away.
- **State re-seeded on every branch.** `reinit()`/resize go through `init()`, which rebuilds balls, palette **and** the history ring, and resets `historyFp`/`fgIndex`/`colorTick`/`totalTicks` — so a config change (mode, count, segments, colours, orbit) starts from a clean, fully-seeded state. The orbit retry re-seeds velocities on fallback.
- **History ring indexing checked.** `step()` increments `totalTicks` *before* `pushHistory`, and the draw walks `idx = (historyFp − have + s) mod cap` with `have = min(totalTicks, cap)`, so before the ring fills it reads only the frames actually written (no stale `null`s drawn; `drawFrame`/`drawTails` also null-guard).
- **Headless smoke test.** Ran under a minimal DOM shim across all six modes plus `glow` / `orbit` / `ncolors=2` (mono) / `points=2` (polygon→lines fallback, splines draw-nothing) / `viscosity<1` / `walls=false`: no exceptions, the dpr transform is applied (`[2,0,0,2,0,0]`), draw ops map correctly (balls→fill, lines/splines→stroke, polygons/filled-splines→fill), and the colormap helpers return valid 0–255 triples.

### Spot-check requests for the browser (live verify)
- **Default ball mode** with 3–7 balls: confirm the discs are the muted `make_random_colormap` bright colours (one fixed colour per ball), **not** a saturated rainbow, on a clean black field with **no motion trail**.
- **Pace.** `delay` is the **stock 10000** with `OVERHEAD = 6694` (calibrated to the live 59.9 fps); confirm the swirl/clump speed matches the live binary.
- **glow** (internal default off; can be toggled via the returned `config.glow`): confirm the single-hue saturation ramp (slow balls vivid, fast pale), not a rainbow.
- **Spline modes** with default balls (n ≥ 3): confirm the closed curve is smooth and actually *closed* (no gap/cusp at ball 0).
- **Orbit mode** on a small window: confirm the negative-force fallback drops to a sane random seed rather than NaNs.
- **`segments` at max (1000)** in line/spline/tail mode: confirm it stays smooth on your machine (full repaint of up to 1000 paths/frame); lower it if not.
