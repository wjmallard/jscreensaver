# glknots -- design notes

Web port of xscreensaver's `glknots` (Jamie Zawinski, 2003),
`xscreensaver-6.15/hacks/glx/glknots.c` (+ `hacks/glx/tube.c`). A random 3D knot --
a closed parametric loop -- rendered as one fat, smooth, single-colored tube that
spins and wanders while its color slowly cycles; every `duration` seconds it shrinks
the knot away, generates a fresh one, and grows it back. Self-contained three.js
module: `start(canvas, opts) -> { stop, pause, resume, getStats, reinit, config,
params }`.

## Algorithm (how the .c works)

- **`make_knot`**: roll `blobby_p = (0==random()%5)` and `type = random()%2`, plus 9
  params `p[i] = 1+random()%4` (with a 1/3 chance of `+= random()%5`). Sample
  `i = 0..segments` into a closed loop, one of two families:
  - **type 0** (richer space curve): `x = 10(cos mu + cos p0 mu) + cos p1 mu + cos p2 mu`,
    `y = 6 sin mu + 10 sin p3 mu`, `z = 16 sin p4 mu sin(p5 mu/2) + p6 sin p7 mu - 2 sin p8 mu`,
    `mu = i*2pi/segments`.
  - **type 1** (coiled torus): first `p0 += 4`, `p1 *= (p0+p0)/10`, `blobby_p = false`;
    then `mu = i*2pi*p0/segments`, `x = 10 cos mu (1 + cos(p1 mu/p0)/2)`,
    `y = 25 sin(p1 mu/p0)/2`, `z = 10 sin mu (1 + cos(p1 mu/p0)/2)`.
- **tube** (`tube.c`): each segment from the previous to the current point is a fat,
  6-faced, smooth-shaded disc whose `diameter` arg is actually the **radius**, extended
  past both ends by `cap_size = dist/3` so consecutive discs overlap into a continuous
  tube. Per-segment radius `di`: non-blobby `= 4*thickness` (constant); blobby (type-0
  only) `= (dist*(segments/500))^2 * 3` (varies along the curve -> a lumpy look).
- **color** (`new_knot`): a 128-entry `make_smooth_colormap`, each entry brightened
  `c' = (c>>2)+0x7FFF` on the 16-bit channel (-> a `[0.5,0.75]` pastel). The whole knot
  is ONE material color = `colors[ccolor]`; `ccolor` advances one step per frame.
- **motion/regen** (`draw_knot`): a `rotator` spin+wander; `glScalef(0.25)` object
  scale; a mode machine (normal for `duration` wall-clock seconds, then shrink over
  `10/speed` frames, `new_knot`, grow over `10/speed` frames). `clear_p = !!(random()%15)`
  is rolled per knot: 1/15 of knots DON'T clear the buffer, so they smear as they move.

## Shared libraries used

`yarandom.js` (RNG, bit-exact vs the C -- and the draw ORDER is matched: `make_rotator`
before `new_knot`, then `clear_p`, colormap, `blobby`, `type`, `p[]`), `rotator.js`
(spin + wander), `colormap.js` (`makeSmoothColormap`). No jsm / `three/addons` -- the
tube geometry is built directly (see below).

## Faithful to the .c (do not deviate)

- The two knot families and all RNG-driven params, transcribed verbatim (incl. type-1's
  `p[1] *= (p[0]+p[0])/10` as **float** -- `p` is `double[]` in the C, so type-1 loops
  generally do NOT close; that open end is the original's behavior, reproduced).
- Tube radius semantics from `tube.c` (`diameter` = radius), `faces = 6`, smooth radial
  normals; the blobby `di = (dist*(segments/500))^2 * 3` and non-blobby `di = 4*thickness`.
- The colormap + the exact 16-bit brighten `(c>>2)+0x7FFF`.
- The regen mode machine + grow/shrink scale factors; `glScalef(0.25)`; the
  `(x-.5)*8,(x-.5)*8,(z-.5)*15` wander; `glRotatef x,y,z * 360` (three Euler `XYZ`).
- Lighting: directional white light from `(1,1,1)`; GL's default global ambient `0.2`
  (the material is `GL_AMBIENT_AND_DIFFUSE` = the cycling color, so the ambient floor is
  `0.2 * color`); material specular white * the light's **cyan** specular `(0,1,1)` = a
  cyan highlight, shininess `128`. (Per the superquadrics/dangerball convention, light
  `intensity = PI` cancels three's `1/PI` Lambert and the specular is divided by `PI` so
  the highlight doesn't blow out. `THREE.ColorManagement.enabled = false` -> raw glColor.)
- `gluPerspective(30)` cam at `(0,0,30)`, the reshape portrait-fit scale, black bg.

## Deviations / deliberate choices

- **Continuous swept tube, not N overlapping cylinders.** Instead of ~800 fat
  per-segment cylinders, we build ONE `BufferGeometry`: a ring of 6 vertices
  perpendicular to the curve tangent at each point (radius = that point's `di`), smooth
  radial normals, consecutive rings stitched with quads. This reproduces the exact
  **envelope** of the C's overlapping cylinders (including blobby's varying radius) with
  no internal geometry and no jsm dependency (`caps_p = wire`, so the C's solid-mode
  segments are uncapped too).
- **Closed-loop holonomy correction.** A rotation-minimizing (parallel-transport) frame
  avoids twist, but on a CLOSED knot it does not return to its start orientation: the
  transported frame at ring N is rotated relative to ring 0 by an angle `theta` about the
  shared tangent. We measure `theta` and spread a `-theta*(i/N)` counter-rotation across
  the rings so ring N lands exactly on ring 0 -- a seamless closure. **Without this the
  closure showed a dark seam notch** (background/back-faces peeking through the
  mis-clocked ring join -- a real bug the first pass shipped and a reviewer caught). This
  is the same trick `THREE.TubeGeometry` uses for closed curves.
- **Per-ring blobby radius.** The C's `di` is per-SEGMENT (constant within a cylinder);
  the swept tube needs a per-RING radius, so each ring takes the `di` of its incoming
  segment (ring 0 uses segment 0->1). Adjacent `dist` values are close, so the lumps are
  the same shape, just C1-smoothed at the disc boundaries the C left as tiny steps.
- **`FrontSide` (faithful), not `DoubleSide`.** The C does `glEnable(GL_CULL_FACE)` with
  CCW front; the tube is opaque and you only ever see its outside. Each emitted triangle
  is wound so its geometric normal agrees with the radial vertex normals (the
  superquadrics.js trick), so the outside faces front. Verified: no culling holes, even
  on the open type-1 knots.
- **`clear_p=false` smear needs `preserveDrawingBuffer: true`.** WebGL clears the drawing
  buffer after every composite by default, so a no-clear frame would NOT accumulate
  (unlike native GL's untouched back buffer). With it preserved + `autoClear` off +
  `scene.background = null`, the 1/15 smear knots accumulate trails as they spin/wander
  (verified -- see below); the normal 14/15 knots `renderer.clear()` every frame, so they
  stay crisp and pay only a small perf cost. Depth is also left uncleared on smear frames
  (we just skip `clear()` entirely), matching the C's "neither buffer cleared".
- **Rotation = a `select` (8 options), live.** `config-box.js` supports `type:'select'`
  (radio buttons), so the xml's 8 `--spin` options are mirrored 1:1 (`0/X/Y/Z/XY/XZ/YZ/
  XYZ`, default `XYZ`). Changing it rebuilds the rotator next frame (a deliberate user
  action, so the orientation jump is fine); `randomize = all-three-spin`, as in the C.
- **`segments` + `thickness` are LIVE** (the xml/`.c` set them only at init). They are
  quality knobs (xml labels: Resolution = Segmented<->Smooth, Thickness = Thin<->Thick),
  so changing one resamples / re-radiuses the CURRENT knot (same shape) rather than
  rolling a new one. `delay`/`speed`/`wander`/`wire` are live too; nothing triggers a
  surprise re-roll.
- **Wireframe keeps 6 faces.** The C drops to `faces = 3` in wireframe; we keep the
  6-faced tube and just toggle `material.wireframe` (wire is a debug mode; rebuilding the
  static mesh on a live toggle wasn't worth it). Minor.

## Pacing / OVERHEAD

`effFps = 1e6/(config.delay + OVERHEAD)`; render every rAF; spin/color/grow-shrink
advance by `frames = dt*effFps`; the `duration` timer (8 s) runs off real wall-clock
seconds, as the C's `time()` poll does. The rotator is a discrete random-walk, so it is
ticked once per original-frame at effFps and **interpolated** between ticks (the
dangerball.js pattern). **`OVERHEAD = 37500`** -- the GL family's shared default
(`gears`/`pipes`/`dangerball`/`morph3d`/...): live GL hacks can't be timed under this
machine's XQuartz Apple-DRI block, so every three.js port adopts the same measured
overhead. xml default delay 30000 -> `effFps = 1e6/67500 ~= 14.8fps`. See
framerate-calibration.

## Config (params transcribed 1:1 from hacks/glknots.xml)

`delay` (Frame rate, 0-100000, def 30000, invert) - `speed` (Speed, 0.01-5.0, def 1.0) -
`rotation` (select, 8 options, def XYZ) - `segments` (Resolution, 100-2000, def 800) -
`thickness` (Thickness, 0.05-1.0, def 0.3) - `wander` - `wire` (Wireframe). `showfps`
skipped (framework; the host has its own readout). `duration` (8) is a command-line-only
DEF in the C with no xml UI, so it stays an internal constant (not a knob).

## Omissions

- **Trackball / mouse** (`gltrackball_*`): the host hacks aren't interactive
  (`pointer-events:none` overlay); the modelview just omits the identity trackball term.
- **`do_fps` / `showfps`**: the host shows its own framerate readout (`getStats`).

## Structural / correctness self-review

Verified against ground truth (`XScreenSaver_ Screenshots_files/glknots.jpg` + the demo
video `youtube ILiYNkeEb_k`) via the CDP headless-Chrome rig, mounting the module on a
throwaway harness (removed; not committed). Because the module draws the rotator's RNG
before the knot's, seeds were mapped through that exact order to capture each case:

- **non-blobby type-0** (the common 9/10 case, and the reference's look): a uniform-
  diameter fat smooth tube knot, cyan specular streaks, single pale color on black --
  matches `glknots.jpg` in thickness ratio, smoothness, glints, and topology.
- **type-1**: the coiled torus-family knot, uniform thickness; its open ends are
  hollow (uncapped) -- faithful, since `glknots.c` ties `tube()`'s `caps_p` to the wire
  flag, so the solid-mode tube is never capped.
- **blobby** (1/10): a lumpy tube pinching toward points where the curve slows -- the
  faithful `di ~ dist^2`.
- **smear** (`clear_p=false`, 1/15): the spinning/wandering tube accumulates swept trails
  (only after adding `preserveDrawingBuffer`; cyan highlights preserved); the cleared
  case re-verified crisp afterward.

Offline numeric check confirmed no NaNs, sane coordinate extents (`maxR ~16..30` -> ~4..8
after the 0.25 scale, fitting the fov-30 camera at z=30), type-0 closing to machine
precision while type-1 stays open, and brightened colors landing in `[0.5,0.75]`.

**Coordinator review (2026-06-30).** Set `OVERHEAD = 37500` (the GL family default; live
GL is unmeasurable here). Caught and fixed an undersized geometry buffer:
`posArr`/`norArr` were a factor of ~3 too small (the vertex count `MAX_SEG*FACES*2*3` was
used as the float count, dropping the per-vertex `*3`), so at the default 800 segments the
tube's tail was silently truncated -- it read as a fake open end and made knots look
sparse/broken. With the correct size the full dense knot renders; re-verified headless via
the host at `#glknots` (seeds #1-3) -- the knots are now dense tangles / clean coils
matching `glknots.jpg`'s complexity, with the cyan glints and pastel palette. Confirmed the
no-cap decision against the `tube(..., faces, True, wire, wire)` call (`caps_p = wire`):
open ends are faithfully hollow, not capped.

See also `dangerball.md` (sibling: same author, rotator + colormap + tube primitive; the
pacing/interpolation pattern is shared) and `superquadrics.md` (the lighting + specular
`/PI` convention and the winding-vs-normal triangle trick).
