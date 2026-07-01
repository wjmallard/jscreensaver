# blocktube -- design notes

Faithful port of xscreensaver's `blocktube` (Lars R. Damerow, 2003),
`hacks/glx/blocktube.c`. The camera sits on the axis of an endless tunnel whose
walls are ~1000 long thin reflective slabs; the slabs fall toward the camera,
each slowly spinning around the tube at its own rate, while the whole tunnel
fades from one bright hue to the next. Distance fades to black through linear
fog, so the tunnel recedes to a dark hole. Visual ground truth:
`XScreenSaver_ Screenshots_files/blocktube.jpg` (matched -- see self-review).

Source of truth vendored locally per Step 0: `hacks/blocktube.c`,
`hacks/blocktube.xml`. Texture `hacks/images/blocktube.png` (256x256 grayscale
swirl) was provided.

## Algorithm (how the .c works)

- **Entities.** `MAX_ENTITIES = 1000`. `randomize_entity()` gives each slab a
  brightness `tVal = 1 - frand()/1.5` (in `(1/3, 1]`), a starting `angle`
  (`random()%360`, degrees around the tube), an `angularVelocity`
  (`0.5 - frand()`, `(-1/2, 1/2]` deg/tick), and a `position` = `(frand() +
  tunnelWidth (radius 5..6), frand()*2 (0..2 lift), -frand()*tunnelLength
  (-200..0 depth))`. `id`/`age`/`lifetime` are vestigial (dangerball leftovers):
  `age` is an `int` and `age += 0.1` truncates to 0, so nothing ever ages out.
- **Motion.** `entityTick()`: `angle += angularVelocity`; `position[2] += 0.1`
  (forward); when `position[2] > zoom` (30) the slab recycles to the far end
  `position[2] = -tunnelLength + frand()*20` (-200..-180). **Only z is reset** --
  `tVal`, `angle`, `angularVelocity` persist for the whole run.
- **Per-slab transform** (`draw_blocktube`, modelview reset each slab):
  `Translate(0,0,zoom=30) * Rotate(tilt=4.5deg, X) * Rotate(angle, Z) *
  Translate(position)`. Camera at the eye origin looking down -Z (no
  `gluLookAt`). Projection `gluPerspective(45, w/h, 1, 100)`.
- **Block.** `cube_vertices(0.15, 1.2, 5.25)` -> a slab 0.15 thick (radial),
  1.2 wide (tangential), 5.25 long (along the tunnel axis), drawn from one
  display list. `glFrontFace(GL_CW)` + back-face cull.
- **Color cycle** (`tick()` / `newTargetColor()`, one tick per frame): hold the
  current color for `holdtime` (1000) ticks, then over `changetime` (200) ticks
  step `currentColor += (target - current)/changetime` toward a fresh random
  target, rerolled until luminance `0.3R + 0.59G + 0.11B > 150` (hues stay
  bright), then hold again. Each slab is drawn `glColor4ub(currentR*tVal,
  currentG*tVal, currentB*tVal)`.
- **Texture / lighting.** `do_texture` defaults True. The swirl is uploaded
  `GL_LINEAR`/no-mipmap and used as a **`GL_SPHERE_MAP` environment map**
  (`glTexGen S/T = SPHERE_MAP`) under **`GL_MODULATE`** -- each slab reflects the
  swirl by its orientation, tinted by the flat `glColor`. Lighting is **off**
  when textured. `GL_LINEAR` black fog, start 0, end `tunnelLength/1.8` = 111.11.
- **The gray bug.** When `do_texture` is off (not wireframe) the `.c` enables
  lighting but **not** `GL_COLOR_MATERIAL`, so `glColor` is ignored and every
  block draws as the default-material gray -- the author even left the comment
  *"I don't understand why all the blocks come out gray."*

## Shared libraries used

- `yarandom.js` -- `random()` / `frand()` for entity layout, recycle depth, and
  the target-color rolls (matches the `.c`'s `random()` / `(double)random()/
  RAND_MAX` usage).
- `three` (vendored 0.160.0). No other util needed (no rotator/colormap here --
  the color cycle is bespoke and transcribed inline).

## Faithful to the .c (do not deviate)

- All the constants verbatim: `zoom` 30, `tilt` 4.5, `tunnelLength` 200,
  `tunnelWidth` 5, block `0.15 x 1.2 x 5.25`, fog end `200/1.8`, 1000 entities,
  `holdtime`/`changetime` defaults.
- `randomize_entity`, `entityTick` (incl. the posZ-only recycle) and the
  `tick()`/`newTargetColor()` state machine are line-for-line ports. The initial
  `currentColor` is an **unconstrained** `random()%256` per channel, and the
  first `newTargetColor()` is (as in the `.c`) re-picked before it is ever used,
  so the opening hold is on that random color.
- The per-slab modelview matrix `Translate(0,0,zoom) * Rx(tilt) * Rz(angle) *
  T(pos)` and `gluPerspective(45, w/h, 1, 100)`, camera at origin down -Z.
- Fog is on in textured/lit modes and **off in wireframe** (as the `.c` forces
  `do_fog = False` there).

## GL_MODULATE + sphere map -> MeshMatcapMaterial

three's `MeshMatcapMaterial` is exactly a view-space sphere/normal map. Its
fragment shader computes `outgoingLight = diffuse * vColor * matcap`, then applies
fog -- which reproduces `GL_MODULATE(glColor4ub, sphereMapTexture)` cleanly with:

- `material.color` = `currentColor/255` (the cycling tint, set once per frame),
- `instanceColor` = `(tVal, tVal, tVal)` per slab (set once via `setColorAt`),
- `matcap` = the swirl texture (`colorSpace = NoColorSpace`, sampled raw to match
  GL's untouched luminance bytes; `LinearFilter`, no mipmaps, `ClampToEdge`).

`InstancedMesh.setColorAt` makes the program prefix emit `USE_COLOR` in the
**fragment** shader (`vertexColors || instancingColor`), so per-instance `tVal`
multiplies **without** `material.vertexColors` -- which must stay off, or the
vertex shader's `vColor *= color` would read a missing per-vertex `color`
attribute (the unbound generic attribute is `(0,0,0)`) and zero every slab.

`THREE.ColorManagement.enabled = false` at module scope keeps the whole pipeline
raw (no sRGB encode), matching GL's fixed pipeline and the captured screenshot --
the glknots.js convention.

## Deviations / deliberate choices

- **matcap uv vs true GL_SPHERE_MAP.** matcap projects the view-space *normal*;
  `GL_SPHERE_MAP` projects the *reflection vector* (`r = u - 2(n.u)n`) with the
  `m = 2*sqrt(rx^2 + ry^2 + (rz+1)^2)` normalization. For a soft radial swirl on
  small slabs the two are visually indistinguishable (both are "sample a disc by
  surface orientation"); the modern three replacement for the removed
  `SphericalReflectionMapping` is a matcap. Not worth a custom texgen shader.
- **1000 slabs via one `InstancedMesh`** (per-instance matrix + color) instead of
  1000 `glCallList`s. Same geometry, same draw result.
- **BoxGeometry** (CCW front, unit normals) rather than the `.c`'s CW-front /
  `nv=0.7` normals. With back-face culling only the outward faces show either
  way, and matcap uses unit normals -- identical look. The `nv=0.7` non-unit
  normals in the `.c` are a no-op detail (texgen still reads them, but the
  perceptual effect on a soft swirl is nil).
- **Continuous motion, discrete color.** `posZ`/`angle` advance by `frames =
  dt*effFps` each rAF (smooth), while the integer color `counter` is ticked in a
  catch-up loop (cap 8). The `.c` does exactly one entity tick + one color tick
  per frame; decoupling smoothness from the (low) sim rate is the glknots.js
  pattern and imperceptible for the color (tiny per-tick deltas).
- **reshape's `glScalef` dropped.** It is dead code in the `.c` --
  `draw_blocktube` `glLoadIdentity()`s the modelview before every slab, so the
  portrait-fit scale never reaches the geometry. Reproducing the *visible* output
  means not applying it.
- **Wireframe.** three's `wireframe:true` shows the triangulated box (diagonals,
  all 6 faces); the `.c` draws 4 quad `GL_LINE_LOOP`s (no diagonals, 2 faces
  skipped). Kept the simple three path -- a recognizable colored wireframe
  tunnel, no fog, tinted `currentColor*tVal`. Documented rather than hand-built
  as instanced line segments (a niche, non-default toggle).
- **Non-textured gray** reproduced faithfully: a lit `MeshPhongMaterial`
  (default-material gray, no specular), directional light from `(0,1,1)` + 0.2
  ambient (intensity `PI` to cancel three's `1/PI` Lambert), `instanceColor` set
  to white so no `tVal`/hue tint leaks in -- i.e. the `.c`'s "all gray" result,
  not a "fixed" colored version. Verified headless.

## Pacing / OVERHEAD

`OVERHEAD = 37500` (the GL family's shared value -- live GL can't be timed under
this machine's XQuartz Apple-DRI block, so every three.js port adopts the same
measured overhead). `effFps = 1e6/(delay + OVERHEAD) = 1e6/77500 ~= 12.9 fps` at
the xml default `delay = 40000`. Slab forward speed is `0.1 * effFps ~= 1.3
units/s`; the color hold/change (1000/200 ticks) run off the same tick rate.

## Config (params transcribed 1:1 from hacks/blocktube.xml)

`delay` (Frame rate, 0..100000, invert), `holdtime` (Color hold time, 10..2000),
`changetime` (Color change time, 10..1000), `texture` (Textured, default on),
`wire` (Wireframe). The xml has no fog knob, so fog is not exposed (always on
except wireframe, matching `do_fog`'s default True + the wire override).
`showFPS` is the host's own readout, not a hack param.

## Omissions

- `id` / `age` / `lifetime` entity fields (vestigial, never affect rendering).
- The `width > height*5` "tiny window" reshape special case (a degenerate edge
  case; the normal `gluPerspective` path covers all realistic sizes).
- The XPM-load error path / display-list plumbing (framework detail).

## Structural / correctness self-review

Verified headless (chrome-headless-shell + swiftshader) against the target JPG:

- **Default textured:** receding ring-tunnel of long thin reflective slabs, fog
  hole in the center, big near-slabs at the frame edges, per-slab brightness
  variation, reflective sheen -- a clean structural match to the screenshot.
- **Color cycle:** unit-tested the state machine over 600 ticks -- it steps
  through varied bright hues (orange, pink, green, cyan, yellow...), every held
  color luminance > 150; and headless the textured tunnel was olive, gold, and
  cyan at different instants. Faithful to "They fade from hue to hue."
- **Wireframe** and **non-textured gray** modes render as described with no
  console errors; live-toggling `texture`/`wire` rebuilds the material and
  reassigns instance colors.
- No page errors in any mode. `node --check` passes; source is pure ASCII
  (`µ` for the delay unit).
