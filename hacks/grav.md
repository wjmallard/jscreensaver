# grav — port notes

Port of `grav.c` by Greg Bowering (1997) — planets orbiting a central pulsing star, drawn in perspective, with optional decaying orbits and accumulating trails ("an orbital simulation, or perhaps a cloud chamber").

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/grav.c` (~360 lines)

## Algorithm
Each planet is a 3D point with position `P`, velocity `V`, acceleration `A`. Positions start random in `[-7.995, 7.995]` per axis (`XR = YR = ZR = HALF·ALMOST`), velocities random in `[-0.04, 0.04]`. Each step, for every axis:

- `A = P · GRAV / |P|³` — a central pull toward the origin (`GRAV = -0.02`, attractive). `|P|²` is floored at `COLLIDE = 0.0001` so the pull can't blow up at the centre. Note it's `1/r³` on the *vector* `P`, i.e. an inverse-**square** force in magnitude (`|P|/|P|³`).
- **decay on**: clamp `A` to `±0.1`, then `V += A`, then `V ·= 0.999999` (light damping → orbits spiral inward).
- **decay off**: `V += A` (energy-conserving, orbits persist/precess).
- `P += V`.

The point projects to the screen with a simple perspective: `xi = width·(½ + x/(z+DIST))`, `yi = height·(½ + y/(z+DIST))`, `DIST = 16`. A planet at/behind the camera (`z ≤ -15.99`) is sent off-screen. The disc radius is `RADIUS = (height/5)/(z+DIST)`, so nearer planets (smaller z) read as larger discs.

Drawing per step: erase the planet's old disc to black; if trails are on, stamp a 1px dot at the old position (never erased → trails accumulate); reproject; draw the new disc. A central **star** is a circle *outline* at screen centre that pulses: each frame a `NRAND(4)` roll grows it by 1 (case 0) or shrinks it by 1 (case 1), bounded `[2, STARRADIUS]` with `STARRADIUS = height/32` — like a pulsar.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — vector ops on a persistent canvas
Filled discs / a stroked star ring → **canvas vector ops** (`arc` + `fill`/`stroke`), and critically the canvas is **persistent** (not cleared each frame). Mirroring the C exactly: each step erases the old disc to `#000`, optionally stamps a trail dot, then draws the new disc; the star ring is erased and redrawn at its new size. This is the opposite of boxfit's full-repaint-per-frame choice — here a full repaint would wipe the accumulated trail dots, which are the whole point of the "cloud chamber" look. The one-time black background (after a reinit/resize) is painted in `draw()`; thereafter only incremental disc/ring edits touch the canvas.

## Loop
Standard rAF lag-accumulator paced by `config.delay` (µs in the xml; divided by 1000 for the ms rAF clock), with the same catch-up cap as squiral so a backgrounded tab doesn't burst on refocus. There are no phase pauses, so unlike boxfit `step()` doesn't return a variable delay.

## Deviations from the C
- **Persistent-canvas erase/draw** kept faithfully (above) rather than a full repaint, so trails behave exactly as in the original.
- **Colors** *(audit fix)*: now faithful. `grav.c` defines `BRIGHT_COLORS`, so the xlockmore framework fills the X colormap with `make_random_colormap` (bright path: random hue 0–360, saturation 30–100%, value 66–100% — vivid but *varied*, **not** a hue-ordered rainbow), and each planet and the star pick a *random* entry (`MI_PIXEL(NRAND(MI_NPIXELS))`). We port this exactly via `makeRandomColormapRGB(ncolors, true)` from `colormap.js`, built once per `init()`. When `ncolors ≤ 2` the C drops to mono/white (xlockmore's `npixels <= 2 goto MONO`, i.e. the `MI_NPIXELS > 2` gate) — we leave the palette null and use white. There is **no colour cycling** (a canvas is TrueColor → `writable_p` is false → the framework never rotates the map, and grav.c has no cycling code regardless). An earlier port used a fully-saturated `hsl(i·360/n, 100%, 55%)` rainbow — the systemic "vivid rainbow" deviation — now removed.
- **devicePixelRatio**: the projected disc radius and star radius are already in device px (they're derived from `canvas.height`), so they scale on retina for free. The trail-dot size and star-ring `lineWidth` are scaled by `dpr` explicitly; the C instead tripled the trail dot only past 2560 px (we keep that ×3 branch *and* apply dpr). The star's pulse step is `±dpr` device px (not `±1`): the pulse *range* (`STARRADIUS`) is also dpr-scaled, so this keeps the pulse period — measured in frames — equal to the original's at its native resolution rather than dpr-times slower.
- **Giant near-camera discs**: when a planet's `z` approaches `-16`, `z+DIST → 0` and the disc radius explodes (e.g. `20·height`). The C has the identical behaviour and relies on its `Planet()` macro to draw only when the disc *centre* is in bounds; our `disc()` clips with the exact same centre-in-bounds test, so an off-screen-centred giant simply isn't drawn — faithful.
- **No `--fps`**: the xml's "Show frame rate" is an xscreensaver overlay, not part of the hack; omitted (as in the other ports). The `--root` command flag is X-specific and N/A.
- **Integer truncation**: `xi`/`yi`/`ri` use `| 0` to match the C's `(int)` cast (truncate toward zero), and `INTRINSIC_RADIUS = (H/5) | 0` matches the C's integer `gp->height/5`. A planet whose projected radius rounds to 0 (very far away) draws nothing — X's `XFillArc` with a 0-size box draws nothing, so `disc()` returns early for `d < 1` (the trail dot and erase always pass `d ≥ 1`, so they're unaffected).

## Config
Ranges mirror `hacks/config/grav.xml`:
- `delay` — Frame rate, µs/step, **default 10000** (the stock xml/`.c` default); the rAF loop adds `OVERHEAD = 8484` so `(delay + OVERHEAD)` reproduces the live binary's effective rate (live `-fps` shows grav at **54.1 fps**: `10000 + 8484 = 18484 µs → 54.1 steps/sec`). `invert: true` (the xml's `convert="invert"` slider), **live**. A calibration, not a tuning knob — see the framerate-calibration note.
- `count` — "Number of objects" (planets), 1–40, default 12, **non-live** (sizes the planet array → `reinit()`).
- `ncolors` — "Number of colors", 1–255, default 64, **non-live** (sizes the `make_random_colormap` palette → `reinit()`).
- `decay` — Orbital decay, default on, **live** (read every step; flips the integration in place).
- `trail` — Object trails, default on, **live** (read every step).

`decay`/`trail` are live because the loop reads them every step with no buffer to resize; `count`/`ncolors` re-seed via `reinit()` (which clears the canvas and rebuilds the planets/star). "Reset to defaults" applies every key then reinits once. The xml's `showfps` boolean is not exposed (see deviations).
