# extrusion -- design notes

Web port of xscreensaver's `extrusion` (Linas Vepstas, David Konerding, Jamie
Zawinski; 1999), `xscreensaver-6.15/hacks/glx/extrusion.c` + the seven per-shape
files `extrusion-{helix2,helix3,helix4,joinoffset,screw,taper,twistoid}.c` (all
vendored here). "Various extruded shapes twist and turn inside out." Self-contained
three.js module: `start(canvas, opts) -> { stop, pause, resume, getStats, reinit,
config, params }`.

## Algorithm (how the .c works)

`extrusion.c` picks one of 7 named shapes (or RANDOM), sets up a `rotator` and two
directional lights, then every frame:

- **spin**: `get_rotation(rot)` -> `glRotatef(x*360)`,`(y*360)`,`(z*360)`.
- **morph**: `get_position(rot)` -> `lastx`,`lasty` in `[-400,400]`. These are NOT a
  screen translation -- each shape's `DrawStuff_*` feeds `lastx`/`lasty` into its
  geometry parameters, so the shape continuously deforms as the rotator wanders. This
  is the literal "twist and turn inside out."
- `glScalef(0.5)`, material `GL_AMBIENT_AND_DIFFUSE = (0.6,0.6,0.4)`, then the chosen
  `DrawStuff_*()`.

Each `DrawStuff_*` calls the **GLE** ("OpenGL Tubing & Extrusion") library, which
xscreensaver *links* at build time and does **not** vendor. GLE sweeps a 2D contour
along a 3D path. The exact calls, from the vendored per-shape files:

- **helix2/3/4** -> `gleHelicoid(rToroid, startRadius, drdTheta, startZ, dzdTheta,
  startXform, dXform, startTheta, sweepTheta)`: a circle of radius `rToroid` swept
  along a helix. helix2 morphs `rToroid`/`drdTheta`; helix3 morphs pitch + sweep
  (turn count); helix4 adds a *rotating elliptical* cross-section via an affine xform.
- **joinoffset** -> `gleExtrusion(...)` **twice**: a leaf contour (offset off the path
  by `0.05*(lasty-200)`) swept along a 7-point zig-zag, once with the angle join and
  once (a copy, offset in y) with the RAW join, to compare the two styles. Per-path
  colors.
- **screw** -> `gleScrew(20, gearContour, norms, NULL, -6, 9, lasty)`: a 20-point
  "gear-cross" contour extruded straight along Z, twisting by `lasty` degrees total.
- **taper** -> a custom `gleTaper` (= `gleSuperExtrusion` with per-point `taper*R(twist)`
  affines): the gear-cross swept along a 40-point Z path, tapering to points at both
  ends (a superellipse profile `(1-|z|^(1/p))^p`, `p=|lastx/540|`) while twisting.
- **twistoid** -> `gleTwistExtrusion(20, corrugation, normals, NULL, 5, path, NULL,
  twist)`: an OPEN corrugated strip (semicircle hump + zig-zag) swept along a short
  bent path, with the middle point twisted by `(lastx-121)/8` degrees.

I read the GLE-3 source (`github.com/linas/glextrusion`, `src/extrude.c`,
`ex_angle.c`, `ex_raw.c`, `view.c`, `texgen.c`) to transcribe the exact sweep
semantics -- see "GLE replication" below.

## Shared libraries used

`yarandom.js` (RNG; the draw ORDER is matched: shape pick, then `make_rotator`, then
`lastx`/`lasty`), `rotator.js` (`make_rotator(0.5,0.5,0.5, 0.2, 0.005, True)` -> spin +
wander). No jsm / `three/addons` -- the swept geometry is built directly, generalizing
`glknots.js`'s parallel-transport-frame + ring-stitch from a fixed 6-gon to an
arbitrary 2D contour with per-point 2x3 affine transforms.

## GLE replication (the crux)

Transcribed from the GLE-3 C source, not approximated:

- **Path (`gleSpiral`/`gleHelicoid`)**: `npoints = floor((slices/360)*|sweep|) + 4`
  with `slices = 20` (`_POLYCYL_TESS`). The path winds around **Z in the XY plane**;
  `radius`/`z` accumulate per **revolution** (`dr,dz` are per 2pi, renormalized to
  per-step by `deltaAngle/2pi`); `startTheta`/`sweep` are **degrees**; the first &
  last points are hidden lead-in/out (a one-step back-step). helix4's affine
  accumulation is GLE's matrix exponential `(I + (delta/32)*D)^32` (five squarings),
  left-multiplied along the path, exactly as `gleSpiral`.
- **`gleHelicoid`** = `super_helix`: a 20-gon circle contour of radius `rToroid`,
  `up=(1,0,0)`, join gains `TUBE_CONTOUR_CLOSED | TUBE_NORM_PATH_EDGE`.
- **`gleScrew`** = a straight Z path (`numsegs = |twist/18|+4`, uniform z + uniform
  twist) fed to `gleTwistExtrusion`. **`gleTwistExtrusion`** = per-point contour
  rotation `R(twist[j] deg)` as the 2x3 affine. **taper** = per-point `taper*R(twist)`.
- **Frame / join (`extrusion_angle_join`)**: one contour ring per path point, mitered
  into the bisecting plane at each joint (plane normal = `normalize(dir_in + dir_out)`,
  GLE's `BISECTING_PLANE`). The contour's orientation is a twist-free
  (rotation-minimizing) frame: GLE reflects the `up` vector across each successive
  bisecting plane; I transport `Y` by the minimal ROTATION aligning consecutive miter
  normals (Rodrigues), seeded by the real `up` projected perpendicular to the first
  segment. (An earlier projection-onto-plane+renormalize transport degenerated on
  joinoffset's planar 90-degree corners -- see the bug note under self-review.) Local
  basis `Tn` (miter normal = travel dir), `Y` (transported up),
  `X = Tn x Y`; contour `(cx,cy) -> P + cx*X + cy*Y` (GLE's `uview_direction` puts -Z
  along travel, Y along up, so `X = travel x up`). Per-point affines transform the
  contour before placing; normals by the inverse-transpose 2x2 (`NORM_XFORM_2X2`).
- **Normals**: `TUBE_NORM_FACET` (screw/taper/twistoid) -> flat per-contour-edge
  normals; `TUBE_NORM_EDGE`/`PATH_EDGE` (helices, joinoffset) -> smooth per-vertex.
  joinoffset passes its *contour points* as the "normals" (a genuine GLE-demo quirk),
  reproduced.
- **Caps** (`TUBE_JN_CAP`, all shapes): fan-fill the first & last rings (closed
  contours). **RAW join** (joinoffset copy 2): square-cut, capped, per-segment prisms
  (gaps at the sharp corners) -- built as independent segment frames.

## Faithful to the .c

- All 7 shapes' exact contour arrays, path arrays, GLE parameters, and per-shape
  `glColor` diffuse, transcribed from the vendored per-shape files.
- The morph mechanism: the rotator's `get_position` drives `lastx`/`lasty` in
  `[-400,400]`, fed verbatim into each shape's parameter expressions.
- Lighting (`SetupLight`): two directional lights, LIGHT0 **yellow** `(0.99,0.99,0)`
  from `(40,40,100)`, LIGHT1 **cyan** `(0,0.99,0.99)` from `(-40,40,100)`; material
  ambient `(0.6,0.6,0.4)`; **no specular** (commented out in the .c); `GL_SMOOTH`
  (Gouraud) + `LIGHT_MODEL_TWO_SIDE` + `glDisable(CULL_FACE)`. Modelled as a
  `MeshLambertMaterial` (Gouraud, no specular), `DoubleSide`, per-vertex diffuse color,
  `emissive = 0.2*(0.6,0.6,0.4)` (the constant ambient floor: global ambient 0.2 x the
  material ambient, which `COLOR_MATERIAL` leaves fixed because it tracks only DIFFUSE).
  Light `intensity = PI` cancels three's `1/PI` Lambert (the glknots/superquadrics
  convention); `THREE.ColorManagement.enabled = false` -> raw glColor.
- `gluPerspective(30)` cam at `(0,0,30)`; `glScalef(0.5)` object scale; black bg.

## Deviations / deliberate choices

- **Ring-stitch, not GLE's exact miter.** I place the contour *rigidly* in the
  bisecting plane (orthonormal `X`,`Y`); GLE keeps the contour's `(cx,cy)` fixed and
  intersects the extruded line with the plane, i.e. *projects* the perpendicular ring
  onto the tilted plane along the travel direction. For the finely-tessellated shapes
  (helices/screw/taper, small per-joint angles) these are identical; only joinoffset's
  90-degree corners differ (GLE stretches the section into a true miter; mine stays
  rigid). The join is still gap-free and the shape identity is unchanged. This is the
  approach `glknots.js` established, generalized.
- **Rotation-transport RMF vs GLE's bisecting-plane reflection.** Both give a twist-free
  frame; they can differ in absolute contour *clocking* at corners, but the object spins
  randomly so clocking is invisible, and any *applied* twist (screw/taper/twistoid/
  helix4) shows correctly against the twist-free reference. For a planar path both
  produce the same constant out-of-plane contour X-axis (verified for joinoffset:
  `X = (0,0,1)` throughout, as GLE's `d x up`).
- **`DoubleSide` + faithful winding-agnostic normals.** The .c is two-sided + no cull,
  so I don't need to get triangle winding or normal *sign* right: `DoubleSide` lights
  whichever face the camera sees. (Same reasoning as superquadrics.)
- **twistoid color.** twistoid calls no `glColor3f`, so under `COLOR_MATERIAL` its
  DIFFUSE is the `glMaterialfv` value `(0.6,0.6,0.4)` (in the unlit flat path the C
  would instead show the leftover `glColor` white); I use `(0.6,0.6,0.4)` for both
  modes -- a negligible edge case.
- **`segments`/tessellation** are GLE's fixed `slices = 20` (not exposed); geometry is
  rebuilt every frame (cheap, <=~16k verts) because the shapes morph continuously.

## Pacing / OVERHEAD

`effFps = 1e6/(config.delay + OVERHEAD)`; render every rAF; spin + morph advance by
`frames = dt*effFps`; the discrete rotator is ticked at `effFps` and **interpolated**
(the glknots/dangerball pattern). **`OVERHEAD = 37500`** -- the GL family's shared
default: live GL hacks can't be timed under this machine's XQuartz Apple-DRI block, so
every three.js port adopts the same measured overhead. xml default `delay 20000` ->
`effFps = 1e6/57500 ~= 17.4fps`. See framerate-calibration.

## Config (params transcribed 1:1 from hacks/extrusion.xml)

`delay` (Frame rate, 0-100000, def 20000, invert) - `mode` (Object; select: random +
the 7 shapes, ids `random,helix2,helix3,helix4,joinoffset,screw,taper,twist` -- `twist`
== twistoid, matching the xml `arg-set --name twistoid`) - `render` (select: `flat` =
`--no-light` unlit vs `light` = the default two-light shading) - `wire` (Wireframe;
the .c forces `do_light = 0` in wireframe, so wire is unlit). `showfps` skipped (host
has its own readout).

## Omissions

- **Texture** (`do_texture`, `ximage-loader`, the GLE `gleTextureMode` path): the xml
  `render` select offers only flat/light -- there is no texture option in the UI (the
  command-line default is `-texture False`), so this port is texture-OFF, matching the
  UI default. The checkerboard/`Create_Texture` path is not ported.
- **Trackball / mouse** (`gltrackball_*`, `button2` deform): the host is
  non-interactive (`pointer-events:none`); `mouse_dx/dy` are 0, so `lastx`/`lasty` come
  purely from the rotator's wander (as they do in the unattended screensaver).
- **`do_fps` / `showfps`**: the host shows its own framerate readout (`getStats`).

## Structural / correctness self-review

Verified against ground truth (`XScreenSaver_ Screenshots_files/extrusion.jpg` -- a
twisted tapered gear-cross spindle -- + the demo video `youtube eKYmqL7ndGs`) via the
headless-Chrome rig on a throwaway harness (removed; not committed):

- **taper** matches the reference screenshot's shape (a twisting, tapered, corrugated
  spindle), lit mint-green where both lights hit and dark olive where neither does --
  the two-light (yellow+cyan) signature.
- **screw**: a horizontal twisted gear-cross prism (a drill/screw).
- **helix2 / helix3**: fat / tightening circular coils (helicoids); helix3's radius
  shrinks along the sweep (`drdTheta=-1`).
- **helix4**: a helicoid whose *elliptical* cross-section rotates along the path (the
  affine matrix-exponential) -- ribbon-like twisting petals.
- **joinoffset**: the angle-join swept leaf ribbon (offset from its path) over the raw-
  join copy (separate capped, gapped, per-path-colored prisms) -- the two styles
  compared, as the demo intends.
- **twistoid**: a corrugated open strip that twists in the middle (jwz's source note
  even says it "looks funny -- like we're looking at [it] from the back," so a slightly
  odd orientation is faithful).
- **flat** mode: uniform unlit shape color; **wireframe**: unlit white mesh -- both
  match the `--no-light` / `-wireframe` (do_light off) paths.

### Bug fix (2026-06-30): joinoffset fragmentation/flicker

**Symptom (user report):** one shape "tries to turn into a square briefly, then
dissociates into oddly shaped long narrow beam-like things" and "flickers a lot."
**Shape:** joinoffset (confirmed by pinning each shape's `lastx`/`lasty` and rendering
in wireframe).

**Cause:** joinoffset is the only shape whose path is **planar with sharp (90-degree)
corners** (the diamond zig-zag). The original frame transport projected the previous
`Y` onto the next ring plane and renormalized. On a planar path, `Y` stays in-plane, so
at the corners where the miter normal aligns with the path plane's in-plane direction
(points 2 and 4), the projected `Y` landed **parallel to the miter normal -> projected
to zero**, tripping the degenerate fallback, which **flipped the frame** (`X` from
`(0,0,1)` to `(0,0,-1)`). That discontinuity twisted the ring stitch through itself ->
self-intersecting / flipped-normal slivers = the "fragments," and tiny per-frame
numerical differences flipped the fallback direction -> the "flicker." The "square"
phase is just `lasty ~ 200` (the contour offset `0.05*(lasty-200)` ~ 0, leaf on the
path -> the diamond frame reads as a square); the "beams" are large-offset frames
(offset up to -30 units on a ~2-unit leaf), which is faithful GLE behaviour.

**Fix:** transport `Y` by the minimal **rotation** aligning consecutive miter normals
(Rodrigues) instead of project+renormalize. Rotation preserves `Y` perpendicular to the
miter normal exactly and never zeroes out, so the frame is continuous through the corners
(no flip, no slivers, no flicker). Verified in wireframe across the full `lasty` range
`[-400, 400]`: the angle copy is now a **connected** swept ribbon and the raw copy is
faithfully-disjoint capped prisms (raw join = gaps at corners, as intended). The
remaining beam-like look at extreme offsets is inherent/faithful (jwz's note that
joinoffset "looks funny" corroborates). The other 6 shapes are unchanged: straight
paths (screw/taper) have no corner to rotate through, and smooth paths (helices,
twistoid) transport identically to first order -- re-verified all 6 render as before.
