# discoball -- design notes

Web port of xscreensaver's `discoball` (Jamie Zawinski, 2016),
`xscreensaver-6.15/hacks/glx/discoball.c`. "A dusty, dented disco ball. Woop woop." A
sphere tiled with small flat MIRROR facets -- each a thin slab (a square top face + four
short side walls) -- lit by two below-the-ball directional lights so the facets glint as
the ball turns, with a handful of additive pinkish light BEAMS glowing in front.
Self-contained three.js: `start(canvas, opts) -> { stop, pause, resume, getStats, reinit,
config, params }`. **Asset-free** (the beam glow texture is generated in `build_texture`).

## Faithfulness (the rule: do NOT deviate from the algorithm)

Transcribed from `discoball.c`:

- **Tessellation (`build_ball`):** rings from `+PI/2` down to `-PI/2` stepping by
  `tile_size = PI/rows`; per ring, `row_tiles = floor(min(circ_lo, circ_hi)/tile_size)`
  tiles evenly spaced (`spacing = 2PI/row_tiles`). Each tile sits on the unit sphere,
  `size = tile_size*0.85` (the 15% gap is the grout). The facing NORMAL is skewed by a
  small random (`+0.06..+0.12` per axis) and the square is spun in-plane by
  `tilt = 4 - BELLRAND(8)` deg -- so neighbours glint at slightly different moments.
- **Dents:** `0..4` random dent points; each pushes nearby tiles inward (`position *= s`),
  bends their normals away (`n = (n + (n - normalize(dir)))/2`), and DROPS the tiles near
  its apex (`vector_angle < dropsy`), plus a `1/150`-per-dent random drop -- the "dusty,
  dented" missing-tile look. The dent `strength` is assigned twice in the .c (a harmless
  artefact); preserved.
- **Tile geometry:** the .c's flat slab -- a top mirror QUAD (`glNormal 0,1,0`) + four
  side-wall quads down to `y=-0.2`, each with its own flat normal. The per-tile transform
  `T(pos) Rz(-atan2(nx,ny)) Rx(atan2(nz,r)) Ry(tilt) Scale(size/2)` maps local `+Y` onto
  the skewed normal (exactly `draw_ball_1`'s stack). Since the ball is static (it only
  spins), **all tiles are baked once into ONE merged geometry** (transformed into
  ball-local space) and the whole mesh spins; rebuilt only on a `count`/`reinit` change.
- **Spin / modelview:** `wander T((p-0.5)*{6,6,2})` -> `[spin]` -> `Rx(50)` -> `Scale(4)`
  -> `Rz(th)`; `th += +-speed/frame` (constant-direction spin about the tilted axis, the
  sign fixed at init), wrapped to `(-360,360)`. By default `do_spin` is **False** and
  `do_wander` **True**, so the only motion is the `th` spin + the wander. Built as nested
  groups; camera `gluPerspective(30, w/h, 1, 100)` + `gluLookAt(0,0,30, ...)` (lookAt has
  no rotation, so world == eye -- the lights stay fixed while the ball spins through them)
  + the portrait-fit `Scale(s=(W<H?W/H:1))`.
- **Beams (`draw_rays`):** `5 + BELLRAND(10)` (5..14) additive textured quads, each
  oriented to a random ray normal `(cos t, sin t, 1)`, scaled `(5,5,10)`, pushed out by
  `T(0,0,1.1)`, tinted a random pink/olive `(0.9+.., 0.6+.., 0.6+..)`. **The subtle bit:**
  the "substrate mask" code zeroes the modelview's rotation/scale 3x3 *in place* (the
  local C array `m`), and the front rays then reuse `glMultMatrixf(&m[0][0])` -- so the
  beams ride a **pure-translation, camera-facing, UNSCALED** frame at the ball centre,
  pushed `4.1` toward the camera and spun about the **view axis** by `-th`. (Getting this
  wrong puts the beams `4x` too far out, off-screen -- the first cut did exactly that.)
  Blend `GL_SRC_ALPHA/GL_ONE` == `THREE.AdditiveBlending`; the `cos(r^2*6.2)*0.4` glow ->
  a generated white RGBA whose alpha is the profile (`map * additive == colour * alpha`).
- **Substrate depth mask:** there is no solid ball body, so a big (`40x40`) camera-facing
  quad at the ball centre (`z=-0.4`, slightly behind) writes DEPTH but not colour
  (`colorWrite:false`, `renderOrder -1`) to occlude the far-side tiles seen through the
  gaps -- exactly the .c's billboard trick.
- **RNG:** `yarandom.js`, consumed in `init_ball`'s order -- `th`, `make_rotator` (which
  draws the same 12 values regardless of the spin speed, so building it with `0.1` always
  keeps the `build_ball` stream aligned to the .c's `do_spin`-off default), `build_ball`
  (dents -> tiles -> beams), then the material colours.

## Lighting (and the specular /PI fix)

Two white `DirectionalLight`s at **intensity PI** (to cancel three's `1/PI` Lambert) from
the GL light directions `(0.5,-1,-0.5)` and `(-0.75,-1,0)` -- both *below* the ball, which
is why the bottom facets are bright and the top dark. Both have white diffuse + white
specular (so both glint, unlike morph3d). The material is `GL_AMBIENT_AND_DIFFUSE` = a
`~0.6` grey, so the ambient floor = `(global 0.2 + light ambients 0) * grey` ->
`AmbientLight(white, 0.2*PI)` (three's `BRDF_Lambert` folds in the material).

- **Specular:** GL `cspec ~0.8..1.0` white @ shininess 10. The `PI` light intensity
  over-drives the specular into a white disc, so `material.specular = cspec / PI`
  (authored sRGB) -- a controlled glint, not a blob. This is the systematic
  superquadrics/morph3d fix; verified against the ground truth (the facets keep crisp
  light/dark gradients; the white wash on the ball is the *additive beam glow* drawing
  over it with depth-test off, which is faithful).
- **Winding:** the .c draws under `glFrontFace(GL_CW)` + `GL_CULL_FACE`, so we bake flat
  per-face normals and WIND each triangle to agree with its normal, then render
  `FrontSide` -- the far-facing facets cull exactly as in GL (and the depth mask hides the
  rest). Colours are GL RGB written RAW: three's colour management is disabled
  (`ColorManagement.enabled = false`), so the `setRGB(..., SRGBColorSpace)` store is a
  no-op, matching GL's fixed pipeline (no sRGB encoding). (The `MeshPhongMaterial`
  `color: 0x999999` / `specular: 0x444444` constructor literals are dead defaults --
  `setMaterial()` overwrites both via `setRGB` before the first render.)

## Pacing / config

Pacing as in `dangerball.js` (`effFps = 1e6/(delay + OVERHEAD)`, `OVERHEAD = 37500`); xml
default delay 30000 -> ~14.8fps, speed `1.0 deg/frame` -> a slow ~24s turn. Render every
rAF; the `th` spin advances continuously by `frames = dt*effFps`, the rotator wander is
ticked at `effFps` and interpolated (dangerball pattern). Config transcribed 1:1 from
`hacks/config/discoball.xml`: `delay`, `speed`, `count` ("Size" -> rows, .c clamps
10..200; a change rebuilds the ball), `wander`, `spin`, `wire`.

## Notes / deviations

- **Shadow brightness (resolved):** disabling three's colour management
  (`ColorManagement.enabled = false`) makes GL's raw output faithful, so the shaded/unlit
  facets darken to match the ground truth's near-black top tiles. The ambient product
  (`0.2 * ~0.6 = ~0.12` raw) is now written RAW rather than being lifted to `~0.27` by a
  linear->sRGB encode -- the earlier too-bright reading was that encode, not the geometry.
  (Specular is still divided by `PI` per the `intensity = PI` convention -- independent of
  colour management.)
- **Ball size:** the ground-truth gallery image is a ~2x zoom crop (the ball fills the
  frame). The code's `distance 30 / fov 30 / radius 4` camera *necessarily* renders the
  ball at half the frame height, which our capture confirms -- so we render faithfully to
  the code, not to the crop.
- **OPEN (`OVERHEAD`):** the family default, not a per-hack measurement (the GL originals
  are runtime-blocked here); pin against the demo video (youtube `8yd4PYJQrMw`) if the
  spin rate reads off.
- **OMITTED (chrome):** the mouse trackball; `-wireframe`'s facet-outline-only mode (we
  just toggle `material.wireframe` and hide the beams/mask); the tiny-window reshape
  special-case. `gltrackball_init` is assumed not to draw from the shared RNG stream.

See also: `superquadrics.md`, `dangerball.md`, `morph3d.md`; the
`glx-geometry-track-triage` + `framerate-calibration` memories.
