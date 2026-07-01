# lament -- design notes

Web port of xscreensaver's `lament` (Jamie Zawinski, 1998),
`xscreensaver-6.15/hacks/glx/lament.c` (+ `lament_model.c` geometry, `lament512.png`
texture). Lemarchand's Box -- the Hellraiser "Lament Configuration": a gold-filigree
puzzle box that slowly tumbles and, every so often, transforms through one of a handful
of configurations, then folds back into a box and rests. Self-contained three.js module:
`start(canvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }`.

## Algorithm (how the .c works)

- **Geometry** is loaded model data, not procedural: 30 named `gllist` objects (the
  `OBJ_*` enum / `all_objs[]`) in `lament_model.c` -- the box, the two star halves,
  four tetra corners + base, four lid flaps + base, taser base/arm/slide, two pillars +
  base, eleven `iso_*` pieces + the leviathan. `gl_init` compiles each into a display
  list under `Translate(-0.5)*Scale(1/3)` (the 3" model cube -> a unit cube at origin),
  classifying every triangle by `which_face()` (which of the 6 cube walls its normal
  faces, and whether it's an outer or interior surface) and assigning a texture +
  material accordingly, with UVs from `texturize_vert()` (surface coordinates on that
  wall's plane).
- **State machine** (`animate`): `init_lament` builds a weighted, shuffled list of ~82
  transforms (tetra/star/taser/pillar common, lid + sphere rare, leviathan very rare,
  and 35 BOX rest slots). From BOX it advances the cursor, picks the next transform, and
  each subsequent frame steps `anim_r`/`anim_y`/`anim_z` through that transform's
  sub-states (e.g. STAR_OUT -> STAR_ROT -> STAR_ROT_IN -> ... -> BOX), pausing
  (`anim_pause` frame counts) at the holds. `draw()` renders the current sub-state by
  positioning the relevant model objects.
- **Motion**: `make_rotator(0.5,0.5,0.5, accel 1, wander 0, randomize)` -- a slow
  multi-axis tumble, no wander. `draw()` orients the world (`Rotate(-90,x)` so +Z is
  up), scales to the window (`scale_for_window`), applies the rotator spin, then
  `Scale(0.5)`, then the per-state transforms.
- **Lighting**: `LIGHT0` positional at `(-4,2,5)`, ambient 0.7 gray over GL's default
  0.2 global ambient, diffuse white (`LIGHT1` is defined but its `glEnable` is commented
  out). Four materials with distinct GL ambient/diffuse/specular/shininess (exterior
  gold, interior, black, leviathan). Textures modulate the lit color (`GL_MODULATE`).

## Model conversion (Stage 1)

A one-off Node converter (kept in the session scratchpad, not the repo) parses each
`lament_model_<name>_data[]` array. Every object is **`GL_N3F_V3F`, `GL_TRIANGLES`**
(asserted) -- interleaved normal(3)+vertex(3), 6 floats/vertex; **there are no stored
UVs** (the task's `GL_T2F_N3F_V3F` guess was wrong -- lament computes UVs procedurally).
For each object the converter:

- bakes `gl_init`'s `Translate(-0.5)*Scale(1/3)` into positions (`v/3 - 0.5`);
- runs `which_face()` + `texturize_vert()` **in float, exactly as the C** (the C bakes
  these into display lists at init; the converter is the faithful analog), emitting a
  per-vertex UV and a per-triangle **material group** (0-5 = outer face S/U/N/D/W/E ->
  face tile + exterior gold; 6 = interior -> interior tile + interior color; 7 = black
  interior, `iso_base_a/b` only, no texture);
- Int16-quantizes positions/normals/uvs (per-component adaptive range) and base64-packs
  them into `lament-model.js` (decoded to `Float32Array`/`Uint8Array` on import).

**Verified**: all 30 objects parse; vertex counts equal the `gllist.points` fields
(box 1584 verts / 528 tris, ... 16098 verts / 5366 tris total); no NaNs; extents sane
(box is a clean unit cube `[-0.5,0.5]^3`; iso/tetra/star/taser pieces are the expected
sub-regions). Quantization is **render-only** -- the face classification was done in
float in the converter, so it can never flip a triangle's material. Asset size **349.7
KB** (smaller than the 459 KB source .c). UVs can fall outside `[0,1]` for the few
objects whose raw coords exceed the 3" cube; `RepeatWrapping` handles that exactly as
the C's `GL_REPEAT` does.

## Rendering (Stage 2)

- **One `THREE.Mesh` per object**, built once from the converted geometry (non-indexed
  `BufferGeometry`, triangles sorted into contiguous per-material groups via
  `addGroup`). `OBJ_*` -> the geometry map, keyed by the `lament_model_*` short names,
  matching `all_objs[]`.
- **Texture**: `lament512.png` is a **512x4096 atlas of 8 stacked 512x512 tiles**
  (tiles 0-5 = the six outer cube faces of gold filigree, 6 = interior, 7 = leviathan).
  Sliced at load into 8 `THREE.Texture`s (`NearestFilter`, `RepeatWrapping`,
  `flipY=false` to match the C's raw `glTexImage2D` row-0 slice). Applied per material
  group via the computed UVs when `tex` is on; a flat gold material (exterior diffuse)
  otherwise, and no texture in wireframe (the C forces `do_texture=false` in wire).
- **Materials / lighting**: `MeshPhongMaterial` per group with the .c's exact GL
  diffuse -> `color`, specular -> `specular`, shininess. `THREE.ColorManagement.enabled
  = false`; one `PointLight` at `(-4,2,5)`, `intensity=PI` (cancels three's 1/PI
  Lambert), `decay=0` (GL default no attenuation); specular `/PI` (so the highlight
  doesn't blow out -- the glknots/engine/superquadrics convention). NB: `set_colors()`
  maps the color array as ambient/diffuse/specular/shininess; the struct's **inline
  comments are mislabeled** (they say specular where diffuse is) -- the port follows
  `set_colors()`, which is authoritative (a shiny gold: diffuse `0.78,0.57,0.11`,
  near-white specular).
- **Camera**: `glFrustum(-1,1,-h,h,5,60)` (h=H/W) + `Translate(0,0,-40)` -> a symmetric
  perspective with `fovy = 2*atan(h/5)`, `aspect = W/H`, the -40 folded into the camera
  position (z=40). `scale_for_window` ported verbatim.

## Animation states ported (Stage 3)

The full state machine, transcribed transform-for-transform from `draw()` + `animate()`
and verified mid-transform against ground truth (see self-review):

- **BOX** (idle) -- the resting box.
- **STAR** (6 sub-states) -- the two star halves (`star_u`/`star_d`) push apart along Z
  (`anim_z`) and counter-rotate (`anim_r`), unfolding the 8-pointed star, then reverse.
- **TETRA** (4) -- one corner tetrahedron (UNE/USW/DWN/DSE) rotates `anim_r` about the
  cube's body diagonal while the base + other three stay; holds at 120/240 deg.
- **LID** (3, incl. ZOOM) -- the four bottom-face flaps (`lid_a..d`) hinge open by
  `anim_r` up to 112 deg; if the door faces the viewer (`facing_screen_p`) it ZOOMs into
  the box (`-Y` translate), else it closes.
- **TASER** (4) -- the base drops, the arm (`taser_a`) rises (`anim_z`), the tip
  (`taser_b`) slides out (`anim_y`), then retracts.
- **PILLAR** (3) -- one or both pillars (mode `anim_z` in {1,2,3}) rise (`anim_y`) and
  spin (`anim_r`, a random signed quarter-turn multiple), then return.
- **SPHERE** (2) -- `lament_sphere()` ported: each of the 6 faces is a 16x16 grid morphed
  cube->sphere by `anim_y` (per-vertex lerp toward the normalized radial point, with the
  weighted cube/sphere normal blend), textured per face. Rebuilt each frame while active.

### LEVIATHAN (8 states) -- implemented

The rarest transform (its lone 1/82 slot). An out-and-back **palindrome**:
`SPIN -> FADE -> TWIST -> COLLAPSE -> (long hold) -> EXPAND -> UNTWIST -> UNFADE ->
UNSPIN -> BOX`, transcribed 1:1 from `animate()` (SPIN/UNSPIN `anim_r += 3.5`, FADE/UNFADE
`anim_z` +/-0.01//-0.1, TWIST/UNTWIST `anim_y` +/-2 over 180 deg, COLLAPSE/EXPAND `anim_y`
+0.01//-0.005; COLLAPSE holds `pause2*4`). The deferral short-circuit in the BOX case is
removed. `draw()` splits over two cases, mirrored here:

- **SPIN/UNSPIN/FADE/UNFADE/TWIST/UNTWIST** (`drawLeviathanSpin`): the box's six `iso_*`
  "arms" (une/usw/dse/swd/den/unw) rotate `anim_r` about per-arm axes **pulled verbatim
  from the .c's `axes[6][4]` table** (the model normals; normalized for
  `makeRotationAxis`) and scale by `s = (1-anim_z)*0.6+0.4`. Two central pieces
  (`iso_use`/`iso_dwn`) scale by `s2 = MAX(0,360-anim_r)/360` (SPIN) or `1-that` (UNSPIN),
  `0` for the blend states. `iso_base_a`/`iso_base_b` are the black cores. The **twist** is
  the .c's cumulative `glRotatef(anim_y,1,-1,1)` applied *after* the i==2 arm and left on
  the stack -- so arms 3-5, `iso_base_b`, the bottom cone and `iso_dwn` all inherit it,
  counter-rotating that half against the top. (`iso_use`/`iso_dwn` are hidden when
  `s2<=1e-4` to skip a singular scale-0 matrix -- invisible there anyway; avoids a
  per-frame three "determinant is 0" warning.)
- **COLLAPSE/EXPAND** (`drawLeviathanCollapse`): two full cone fans (top + bottom rotated
  `Rot(180,(1,-1,1))`) plus the folding walls, all keyed off `anim_y` (0..1).

**Procedural cone fans (`leviathan()`).** Not a model object (`lament_model_leviathan` is
converted but, as in the .c, never drawn) -- a 3-facet cone: apex at `(2*ratio,0,0)`, a
radius-0.34 base triangle in the `x=0` plane, oriented onto the cube diagonal by
`Rot(-45,Y)*Rot(-acos(2/sqrt6),Z)` (+`Rot(180,Z)` for the bottom). Rebuilt per frame into a
small dynamic `BufferGeometry` (3 tris; the orient-rotation is baked into the verts, the
mesh matrix holds only the call-site transform), textured with the leviathan tile (tile 7)
and the `leviathan_color` material. `do_normal`/`calc_normal` ported from `normals.c`
(unnormalized cross product, normalized at build since GL_NORMALIZE was on).

**Folding walls (`folding_walls()`).** Three fading gold panels per half (6 total) that
hinge up by `ratio*30.85 deg`. The per-panel modelview (`base(top_p) * perI(i) * fold`)
and the .c's "hairy and incomprehensible" texture-coordinate swaps are transcribed exactly
(the three swap macros -- `1-x,1-y` / `1-x` / `(y,-x)` -- reproduced per branch); the
panel verts pull toward the axis by `offa/offb = {0.15,0.06}*sin(ratio/2*pi)`. Each panel
is a 1-quad dynamic mesh with its face tile (`tex[]={0,5,1,4,2,3}`) and a transparent gold
material whose `opacity = 1-ratio`.

**GL_CONSTANT_ALPHA arm fade (the desktop `glBlendColor` path, not the GLES `#ifdef`-out).**
The .c fades only the six arms via `glBlendFunc(GL_CONSTANT_ALPHA, GL_SRC_ALPHA)` +
`glBlendColor(1,1,1, MAX(0,1-anim_z*3))` -- an **additive** blend (`src*A + dst`, since the
arm material alpha is 1 so the SRC_ALPHA dst factor is 1). Reproduced exactly with three's
`CustomBlending` on the shared gold/interior materials (the arms' only groups): `blendSrc =
ConstantAlphaFactor`, `blendDst = SrcAlphaFactor`, `blendColor=(1,1,1)`, `blendAlpha = A`
(three 0.160's `blendColor`/`blendAlpha` map straight to `gl.blendColor`/`CONSTANT_ALPHA`).
`iso_base_a`/`iso_base_b` are black (group 7), untouched, so they stay opaque -- matching
the .c drawing them *before* `glEnable(GL_BLEND)`. `setArmBlend(A)` is reconciled every
frame (opaque `A==null` for SPIN/UNSPIN/wire, else additive), so the shared materials
always revert cleanly on BOX re-entry (verified: the returned box has proper dark recesses,
which additive blending cannot produce). The **shields** (`leviathan()`'s black occluder
quads, drawn when `alpha<0.9`) and the folding walls use plain `SRC_ALPHA/ONE_MINUS_SRC_ALPHA`
= transparent materials with `opacity`. Draw order follows the .c via `renderOrder`
(opaque cones/cores 0, shields 1, walls 2); depth writes stay on (the .c never touches the
depth mask), relying on three's back-to-front transparent sort.

## Shared libraries used

`yarandom.js` (RNG; the rotator + the `animate()` `frand`/`random` draws use it),
`rotator.js` (`make_rotator(0.5,0.5,0.5, accel 1, wander 0, randomize)`), and the
converted `lament-model.js` geometry. No jsm / `three/addons`.

## Faithful to the .c (do not deviate)

- The 30-object model + its `which_face`/`texturize_vert` classification and UVs, baked
  exactly as `gl_init` compiles them.
- The material colors (per `set_colors()`, not the mislabeled comments), the single
  `LIGHT0` at `(-4,2,5)` with 0.9 ambient floor, `GL_MODULATE` texturing.
- The `animate()` state machine: the weighted `PUSH` list, `shuffle_states`, every
  sub-state's per-frame increments/thresholds/pauses, `facing_screen_p` for LID_ZOOM,
  and the RNG-driven pauses/pillar mode/star hold.
- `draw()`'s modelview: `Rotate(-90,x)`, `scale_for_window`, rotator spin
  (`Rotate x,y,z*360` == three Euler `XYZ`), `Scale(0.5)`, and each state's exact
  translate/rotate nesting.
- The frustum/camera + the black background; `GL_CULL_FACE` -> `FrontSide` for the model
  objects.

## Deviations / deliberate choices

- **`emissiveMap` for GL's ambient term (the key fidelity fix).** three has no separate
  material ambient, so GL's constant ambient (`matAmbient * (0.2 global + 0.7 light0)` =
  `matAmbient * 0.9`) is injected as `emissive` -- a constant floor, which is exactly
  what GL's ambient is. But `GL_MODULATE` multiplies the *whole* lit color (incl.
  ambient) by the texel, while three's `map` multiplies only the diffuse; without more,
  the un-textured ambient floods the dark filigree recesses with gold (verified: the box
  came out washed-out pale, not the reference's gold-on-dark-brown). Setting
  `emissiveMap` = the same tile texture modulates the ambient by the texture too, so the
  recesses stay dark -- a close match to the reference `lament.jpg`.
- **Specular is not textured** (three's `MeshPhong` doesn't multiply specular by `map`;
  `GL_MODULATE` does). Minor -- the highlight sits on the bright gold; documented, not
  worth a custom shader.
- **Int16-quantized model data** -- render-only; the C's float face-classification was
  done in the converter, so quantization can't change any material assignment. Keeps the
  asset (349.7 KB) smaller than the source.
- **SPHERE uses `DoubleSide`.** The .c sets `glFrontFace(frontp?CW:CCW)` per face; the
  sphere is convex, so `DoubleSide` renders it correctly without per-face winding
  bookkeeping. (The static model objects keep `FrontSide` == the .c's `GL_CULL_FACE`.)
- **`facing_p` lags one frame.** `facing_screen_p` is computed from the matrices the last
  frame rendered (as the .c's `draw()` computes it one draw ahead of the `animate()` that
  reads it); it's stable near the transition, so the one-frame lag is invisible.
- **Anim interpolation snaps across state transitions.** The spin and `anim_*` are
  interpolated between the two most recent original-frame ticks for smoothness (the
  engine.js pattern); when the state (`type`) changes between the two ticks the frame
  snaps to the current values rather than interpolate across a reset -- safe, since every
  `anim_*` reset coincides with BOX re-entry (which ignores `anim_*`).
- **`opts.debugState` test seam.** A tiny, inert affordance (the runtime analog of
  `lament.c`'s `DEBUG_MODE`) that forces an initial transform so a screenshot rig needn't
  wait out the ~300-frame first rest. Production never passes it (`start(canvas[,
  {seed}])`).

## Pacing / OVERHEAD

`effFps = 1e6/(config.delay + OVERHEAD)`; render every rAF; the rotator + the per-frame
`animate()` step are ticked at `effFps` in a catch-up loop (capped at 8), with spin +
`anim_*` interpolated between ticks. **`OVERHEAD = 37500`** -- the GL family's shared
default (live GL is unmeasurable under this machine's XQuartz Apple-DRI block, so every
three.js port adopts the same measured overhead). xml default delay 20000 -> `effFps =
1e6/57500 ~= 17.4fps`. See framerate-calibration.

## Config (params transcribed 1:1 from hacks/lament.xml)

`delay` (Frame rate, 0-100000, def 20000, invert) - `tex` (Textured, def true; xml
`arg-unset --no-texture`) - `wire` (Wireframe, def false). `showfps` skipped (the host
has its own readout). All live.

## Omissions

- **Trackball / mouse** (`gltrackball_*`) and **fast-forward** (`space`/`tab` -> `ffwdp`,
  `speed=20`): the host overlay is `pointer-events:none` and non-interactive, so the
  modelview omits the identity trackball term and `speed` stays 1 (`ffwdp` never set).
- **`showfps`**: the host shows its own framerate readout via `getStats`.

## Structural / correctness self-review

Verified against ground truth (`XScreenSaver_ Screenshots_files/lament.jpg` + the demo
video `youtube -TBqI4YKOKI`) via the cached headless-Chrome rig on a throwaway harness
(deleted; not committed):

- **Box** matches the reference closely: gold filigree on dark-brown recesses, black
  background, a soft gold specular highlight. The 8-tile slicing is faithful -- tile 1
  (face U) is genuinely a plain-brown tile in the atlas, so one plain-gold face is
  correct, not a bug. The `emissiveMap` fix was found *by* this comparison (the first
  pass was washed-out pale).
- **All seven transform families** render correctly (confirmed mid-transform via a
  deterministic step: STAR unfolds to the 8-pointed star; TETRA splits + rotates a corner
  tetrahedron; LID swings the flaps open revealing the interior; TASER slides the arm out;
  PILLAR rotates a pillar out, revealing interior filigree; SPHERE morphs to a rounded,
  filigree-wrapped ball). NB: under headless *virtual* time rAF fires only a handful of
  times, so the timed captures barely advanced -- a capture artifact, not a hack bug (a
  real browser drives rAF at 60fps); the deterministic step confirmed the animation logic.
- **LEVIATHAN** (added later) verified across the full palindrome via a deterministic-step
  harness (overrode `requestAnimationFrame` to pump exact frame counts off the rAF
  timestamp, since virtual-time rAF barely advances): SPIN fragments the box into the six
  spinning arms with the pale cone fans growing out; FADE shows the arms going translucent
  (the constant-alpha additive blend) as the leviathan-tile cones emerge; TWIST is the gray
  cone-fan pinwheel (arms fully faded) with the leviathan face symbol at center; COLLAPSE
  folds the textured gold walls up around the cones; deep-collapse is the flat leviathan
  diamond; EXPAND is the extended twin spindle with the walls fading back; UNTWIST/UNFADE/
  UNSPIN reverse cleanly and the box fully reassembles (proper dark recesses = the shared
  arm materials reverted from additive to opaque). No JS errors, NaNs, or singular-matrix
  warnings across a full run; the six pre-existing transforms are unaffected.
- **Texture-off** = a flat shiny gold cube; **wireframe** = the gold triangle mesh (no
  texture), both as the .c produces.
- Offline: 30 objects, 5366 tris, no NaNs, box a clean unit cube; Int16 round-trip exact
  to the render tolerance.

See also `glknots.md` / `engine.md` (siblings: the module contract, the rotator +
pacing/interpolation pattern, the `ColorManagement=false` + light `intensity=PI` +
specular `/PI` lighting convention, and the texture-free vs textured multi-part assembly).
