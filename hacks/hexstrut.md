# hexstrut -- design notes

Web port of xscreensaver's `hexstrut` (Jamie Zawinski, 2016),
`xscreensaver-6.15/hacks/glx/hexstrut.c`. A flat plane tiled with upward-pointing
equilateral triangles; each triangle is drawn as a **Y of three flat struts (beams)**
from its centroid out to its three corners. Where the leg-tips of neighbouring Y's
meet, the empty gaps read as a **honeycomb of hexagons**. Waves of in-plane rotation +
colour change propagate outward from randomly-seeded cells; the whole sheet rolls
slowly about its normal and wanders, viewed at a fixed random tilt. Self-contained
three.js: `start(canvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }`.
**Asset-free.**

## Faithfulness (the rule: do NOT deviate from the algorithm)

Transcribed from `hexstrut.c`:

- **`make_plane`:** `n = count*2`; an `n x n` grid of identical upward triangles,
  `size = 2/n`, `w = size`, `h = size*sqrt(3)/2`, odd rows shifted `+w/2`. Each cell's
  apex `p0 = ((x-n/2)w, (y-n/2)h)`, top-left/right `p0 +- (w/2, +h)`. The neighbour
  graph (left `(x-1)`, the row below `(x,y-1)`, and row-below-right `(x+1,y-1)`) is
  built bidirectionally exactly as `link_neighbor` (capacity 6). The list is
  prepend-built, so iteration order is **reverse creation order** -- preserved, since
  it indexes both the random cell seed (`random()%count`) and the paint order.
- **`draw_triangles`:** `length = sqrt(3)/3`, `t2 = length*thickness/2`,
  `scale = |p0-p1|` (= the triangle edge = `size`). Each leg is a quad from the
  centroid `c` (offset `+-(xt2,yt2)` across the beam, half-width `= t2*scale`) to a far
  end at radius `length*scale`, swung by `angle = (2*pi/3)*rot` via the exact
  `smc/spc/st2/slength` formulas. At `rot=0` the far end lands **exactly on the
  corner**, so the tips of adjacent Y's meet and close the hexagons (verified: the tiling
  closes cleanly). Every strut vertex is in the object `z=0` plane.
- **`tick_triangles`:** `step = 0.01 + 0.04*speed`; a `1/80` chance/frame seeds a
  random idle cell (`rot += step*+-1`, `delay = odelay = 4`); rotating cells advance
  `rot` in fixed steps, cycle `ccolor`, and on completing a full `+-1` turn bank it into
  `orot` (**unused in draw** -- the Y's 3-fold symmetry makes a 120deg turn seamless, so
  the lasting effect is the colour shift) and reset `rot` to 0; when a cell's `delay`
  counts down to 0 it kicks its idle neighbours into the **same-signed** rotation with
  the same delay -> an outward wave. Ported line-for-line (incl. the `orot`/`odelay`
  bookkeeping) so the propagation is identical.
- **Colour:** a 64-entry `make_smooth_colormap` (`colormap.js`), per-cell
  `colors[ccolor]`, **BRIGHTENED** `c*0.75 + 0.25` and written RAW to the framebuffer:
  three's colour management is disabled (`ColorManagement.enabled = false`), matching GL's
  fixed pipeline (no sRGB encoding), so the `setRGB(..., SRGBColorSpace)` store is a no-op
  and the value the `.c` writes IS the output. RNG (`yarandom.js`) and motion
  (`rotator.js`) draws are in `init_hexstrut`'s order (rotator, then the 2 tilt
  `frand(0.8)`s, then the colormap).
- **`init` clamps:** `speed <= 2`, `thickness` in `[0.05, 1.7]` -- replicated.

## Rendering (unlit, flat) -- NOT a lighting hack

`hexstrut.c` **never enables `GL_LIGHTING`** (its `glMaterialfv` calls are dead code; a
header comment even notes "we don't need normals at all, since no lighting"). It draws
solid `GL_QUADS` with **one `glColor` per triangle**, and runs with `GL_DEPTH_TEST` and
`GL_CULL_FACE` **disabled**. So this is:

- `THREE.MeshBasicMaterial` (unlit) with per-vertex colours -- **no lights, no normals**
  in the scene at all (so the systematic `DirectionalLight(PI)` / ambient-floor /
  specular-/PI rules of the lit geometry track do **not** apply here).
- `THREE.DoubleSide` (= `glDisable(GL_CULL_FACE)`); `depthTest:false`, `depthWrite:false`
  (= `glDisable(GL_DEPTH_TEST)`). Everything is coplanar (`z=0`), so it simply paints in
  buffer order, which is built in the same reverse-creation order the `.c` draws -- no
  z-fighting, matching the original.

The strut geometry is rebuilt every render frame into preallocated `DynamicDraw`
buffers (`triCount*18` verts: 3 legs x 1 quad x 2 tris x 3 verts). Changing the
**Hexagon Size** slider rebuilds the plane (new `n`, fresh buffers).

## The fixed tilt + camera + modelview

- **Camera:** `gluPerspective(30, aspect, 1, 100)` + `gluLookAt(0,0,30, 0,0,0, 0,1,0)`
  -> `PerspectiveCamera(30, aspect, 1, 100)` at `(0,0,30)` looking at the origin.
- **Modelview** (camera handles `gluLookAt`; the rest is the object world matrix), as
  nested groups: portrait-fit `S(s)` (`s = W<H? W/H : 1`) > wander `T((x-.5)6,(y-.5)6,(z-.5)12)`
  > **trackball tilt** > roll `Rz(z*360)` > `S(30)` > mesh.
- **Tilt:** the `.c`'s "let's tilt the scene a little" -- `gltrackball_reset(tb,
  -0.4+frand(0.8), -0.4+frand(0.8))` then `gltrackball_rotate`. Ported **verbatim**:
  `trackball(0,0,x,y)` (deformed-sphere projection -> cross-product axis -> `2*asin`
  angle) -> `axis_to_quat` -> `quat_to_rotmatrix`, and the resulting 16-float array is
  loaded **column-major (GL order)** into a `THREE.Matrix4` used as the group's local
  matrix, so it *is* the GL `glMultMatrixf` matrix (no sign/transpose guesswork).
- **Spin uses ONLY the rotator's `z`** (`glRotatef(z*360, 0,0,1)` = a roll about the
  sheet normal); `x,y` rotation is computed/ticked (to keep the RNG stream in step) but
  unused, exactly as the `.c`. `spin`/`wander` are gated live on the output (the rotator
  is built always-on; its `frand` draw count is identical either way), as in
  `dangerball.js`.

## Pacing / config

Pacing as in `dangerball.js`: `effFps = 1e6/(delay + OVERHEAD)`, `OVERHEAD = 37500`; xml
default delay 30000 -> ~15fps. The wave is **discrete** (integer delays + per-frame
random events), so `tick_triangles` is ticked **once per original-frame** at `effFps`
(not advanced by a fraction) -- reproducing the original's stepping exactly; the
geometry is rebuilt every render frame from the current state. The slow global rotator
is likewise ticked per original-frame and interpolated between samples (imperceptible
here -- spin/wander speeds are a tiny 0.002/0.003). **OPEN:** `OVERHEAD` is the family
default, not a per-hack measurement (the GL originals are runtime-blocked here); pin it
against the demo video (youtube `iOCffj3ZmgE`) if the wave/roll rate reads off.

Config transcribed 1:1 from `hacks/config/hexstrut.xml`: `delay` (invert), `speed`
(0.1..5, clamped <=2), `count` ("Hexagon Size", 2..80, invert), `thickness`
(0.01..1.7, clamped 0.05..1.7), `wander`, `spin`, `wire`. The xml `showfps` is omitted
(host chrome), as are the mouse/trackball-drag interaction and `-debug` (screensaver-
irrelevant).

## Verification notes / deviations

- Verified by CDP capture vs `hexstrut.jpg`: the honeycomb of Y-struts, the flat square
  beam ends, the perspective tilt, and a propagating wave of flexed/disconnected Y's
  whose colour has cycled away from the field colour -- all reproduce, exception-free.
- **Hexagon size vs the ground truth:** the GT promo screenshot shows ~6 hexagons
  across; the documented default `count=20` shows ~13. The strut-width:leg-length ratio
  is identical in both (= `thickness` 0.2, which is scale-independent), and
  across-count depends only on fov/aspect/count (not resolution) -- so the GT is simply
  a **lower-count capture**. Confirmed: rendering at `count=10` reproduces the GT
  density (and bigger-looking struts) precisely. The port keeps the faithful xml/.c
  default `count=20`; drag **Hexagon Size** toward "large" to match the promo shot.
- **Base colour is RNG-seeded** (`seed 0` = time-based), so the field colour differs per
  run (the GT's pink, my mauve, a teal -- all valid `make_smooth_colormap[0]` draws).
- **Wireframe** maps to `material.wireframe` (three's triangle-edge wireframe, incl. the
  beam quad diagonal), which approximates -- but is not identical to -- the `.c`'s
  `GL_LINES` beam-outline wire. A non-default, debug-ish knob; the solid default (and
  the GT) are exact.

See also: `dangerball.md`, `superquadrics.md`, `morph3d.md`; the
`glx-geometry-track-triage` + `framerate-calibration` memories.
