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

## Rendering — sparse dots via fillRect, cleared every frame
The field is mostly black with at most a few thousand 1–2 px star dots, so I plot only the live points with `fillRect` rather than touching every pixel — a full per-pixel `ImageData` blit would cost width·height work to draw a handful of points. Star screen positions are precomputed into a per-galaxy `Float32Array` during `simulate()` and consumed in `draw()`, and the whole galaxy is one `fillStyle` (one colour per galaxy, as in the C).

The canvas is cleared to black **every frame** before the dots are drawn, exactly like the C: it either `XClearWindow`s every frame (single-buffered) or, with `dbuf`, erases the previous frame's rects — either way only the current positions show, with **no trails**. (A `tracks` resource is declared in `galaxy.c` but is dead code — never read by the draw path — so it produces no trails either.) An earlier version of this port added an alpha-fade "trails" slider; it was **removed in the fidelity audit** as an embellishment with no counterpart in the C.

## Lag-accumulator loop
Fixed-timestep rAF accumulator paced by `config.delay` (µs), same as `squiral.js` — identical pace at any refresh rate, with a catch-up cap so a backgrounded tab doesn't burst on refocus. `simulate()` is the expensive part (gravity over every star), so the catch-up cap is a low **4** and `draw()` runs at most once per frame (only when at least one step happened).

## Deviations from the C
- **Colour — now faithful (audit fix).** `galaxy.c` defines `UNIFORM_COLORS`, so the xlockmore framework builds the palette with `make_uniform_colormap` (utils/colors.c): a hue ramp `0 → 359` at a single random saturation and value, **each in 66%–100%** — a uniformly-tinted, somewhat muted rainbow, not a full-saturation one. The port now builds this via `makeColorRampRGB(0, S, V, 359, S, V, ncolors, false)` from `colormap.js`, mirroring `demon.js` (also `UNIFORM_COLORS`). The earlier port used a vivid `hsl(i·360/n, 100%, 60%)` rainbow — the systemic over-saturation bug this audit targets — now removed. Each galaxy's colour is `palette[COLORSTEP · galcol]` with `COLORSTEP = ncolors / COLORBASE` (=16) and `galcol = NRAND(14)` nudged past slots 2–3, exactly the C's `MI_PIXEL(COLORSTEP · galcol)` (the earlier `floor(galcol/16 · n)` form diverged for `ncolors` not divisible by 16). The palette is built once per run and is **not** rebuilt across reseeds (matching the C; only `galcol` is re-rolled each reseed). Note: `galaxy.c` 6.15 has no velocity-based star shading.
- **Retina dots — now exact (audit fix).** Transcribed `init_galaxy` verbatim: `scale = (W+H)/8`, `pscale = 1`, and only past **2560 device px** does `pscale = 2` (with `scale /= 2` to keep the same world extent). The earlier port keyed dot size off `devicePixelRatio` directly; the threshold form matches the C at and below a fullscreen retina display.
- **`delay` default + framerate calibration (`OVERHEAD = 5707`).** `delay` defaults to the **stock 20000 µs** (1:1 with the xml); the rAF loop adds `OVERHEAD` so `(delay + OVERHEAD)` reproduces the live binary's effective rate. Measured against the live `-fps` overlay galaxy runs **38.9 fps**, so `20000 + 5707 = 25707 µs → 38.9 steps/sec`. A calibration, not a tuning knob — see the framerate-calibration note.
- **`tracks` / `dbuf` dropped.** `dbuf` is the canvas's built-in double buffering; `tracks` is declared in the C but never read (dead code). Neither is exposed, and neither changes the look.
- **Star arrays** are flat `Float64Array`s (3 components/star) instead of the C's `Star{pos[3],vel[3]}` structs — same math, no per-star object churn. Off-canvas stars are still passed to `fillRect` (cheaply clipped) rather than bounds-checked; the C casts the projected coords to `(short)` (16-bit wrap), the port floors with `| 0` (no wrap) — identical on-screen, differing only for stars flung past ±32767 px (already invisible).

## Config
Mirrors `hacks/config/galaxy.xml` exactly: `delay` (Frame rate, µs, live, inverted), `count` (Galaxies; negative = random up to |count|, reinit), `cycles` ("Duration" — `cycles·4` steps before reseed, live), `ncolors` (Colors, reinit), `spin` (Rotate viewpoint, live). `count` and `ncolors` size the galaxy/star/palette arrays, so they reinit; everything else is read live. The xml's `showfps` is a host concern and isn't a hack param. `r` (restart) and non-live changes rebuild the palette and reseed the universe via `reinit()`.
