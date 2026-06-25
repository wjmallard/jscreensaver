# galaxy — port notes

Port of `galaxy.c` — originally Uli Siegmund on the Amiga (EGS/Cluster), ported to C/Intuition by Harald Backert, then to X11/xlockmore by Hubert Feyrer; turned standalone by jwz (1997).

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/galaxy.c` (~462 lines)

## Algorithm
A few spinning galaxies drift toward each other under gravity and collide.

Each galaxy is a centre (a point mass with its own position/velocity) wrapping a disk of 500–1000 stars. At seed time (`startover`) each disk is built in its own plane via a random orientation matrix: stars are scattered by radius `d` with an exponential thickness `h`, and given a *tangential* velocity `v = sqrt(mass·QCONS / r)` so the disk visibly rotates. Galaxy centres start with random velocities and positions back-projected (`pos = -vel·DELTAT·cycles + …`) so they converge on the origin around the middle of the run — that's the collision.

Each step (`simulate`, the math half of the C's `draw_galaxy`):
1. **Stars feel the centres.** Every star accumulates gravitational acceleration from *every galaxy centre* (treated as a point mass), then integrates velocity and position. Stars do **not** attract each other (it's `O(stars·galaxies)`, not `O(stars²)`).
2. **Centres feel each other.** A small symmetric N-body step runs between the galaxy centres (`i` pulls `k`, `k` pulls `i`), then each centre integrates.
3. **Project.** Each new 3D star position is projected to 2D through a slowly-tumbling viewpoint (`rot_y += 0.01`, `rot_x += 0.004` when spin is on).

After `cycles · 4` steps the universe reseeds.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — sparse dots via fillRect, with an added fade trail
The field is mostly black with at most a few thousand 1–2 px star dots, so I plot only the live points with `fillRect` rather than touching every pixel — a full per-pixel `ImageData` blit would cost width·height work to draw a handful of points. Star screen positions are precomputed into a per-galaxy `Float32Array` during `simulate()` and consumed in `draw()`, and the whole galaxy is one `fillStyle` (one colour per galaxy, as in the C).

The C draws each frame onto a freshly-**cleared** background (it either `XClearWindow`s every frame, or, with `dbuf`, erases the previous frame's rects) — so there are **no persistent trails** despite a `tracks` option being declared (it's dead code in the standalone draw path). I replaced the hard clear with an optional **alpha-black fade** (`rgba(0,0,0,1-trails)`): one cheap full-canvas rect per frame that leaves comet-like motion tails. `trails: 0` reproduces the C's clear-every-frame look exactly.

## Lag-accumulator loop
Fixed-timestep rAF accumulator paced by `config.delay` (µs), same as `squiral.js` — identical pace at any refresh rate, with a catch-up cap so a backgrounded tab doesn't burst on refocus. `simulate()` is the expensive part (gravity over every star), so the catch-up cap is a low **4** and `draw()` runs at most once per frame (only when at least one step happened).

## Deviations from the C
- **Trails** added (above); not in the stock UI. Default `0.30` for a gentle tail; `0` = faithful.
- **Colour.** The C buckets galaxies over a 16-slot colormap (`COLORBASE`), nudging indices to avoid an all-green galaxy. We keep the same bucket pick and map it onto a vivid full-saturation `hsl()` rainbow (per the gallery's house style) instead of xlockmore's velocity-shaded colormap.
- **devicePixelRatio.** The C only doubles the dot size + halves the scale past 2560 px; we fold `dpr` in directly — `pscale = round(dpr)` (2 px dots on retina) and `scale = (W+H)/8/pscale` — so the galaxies fill the same fraction of the screen and dots stay a consistent CSS size. World scale `(W+H)/8` is otherwise the C's.
- **`tracks` / `dbuf` dropped.** `dbuf` is the canvas's built-in double buffering; `tracks` is dead code in the C. Neither is exposed.
- **Star arrays** are flat `Float64Array`s (3 components/star) instead of the C's `Star{pos[3],vel[3]}` structs — same math, no per-star object churn. Stars off the canvas are still passed to `fillRect` (cheaply clipped) rather than bounds-checked.

## Config
Ranges mirror `hacks/config/galaxy.xml`: `delay` (Frame rate, µs, live, inverted), `count` (Galaxies; negative = random up to |count|, reinit), `cycles` ("Duration" — steps·4 before reseed, live), `ncolors` (Colors, reinit), `spin` (Rotate viewpoint, live), plus the added `trails` (live). `count` and `ncolors` size the galaxy/star/palette arrays so they reinit; everything else is read live. The xml's `showfps` is a host concern and isn't a hack param. `r` (restart) and non-live changes reseed the universe via `reinit()`.
