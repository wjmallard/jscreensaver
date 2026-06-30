# rubikblocks -- design notes

Web port of xscreensaver's `rubikblocks` (Vasek Potocek, 2009),
`xscreensaver-6.15/hacks/glx/rubikblocks.c`. A "Rubik's Mirror Blocks" puzzle: a 3x3x3 of
27 cubies whose slabs are DIFFERENT widths along each axis (the `fx`/`fy`/`fz`
eccentricity), so the SOLVED state is a tidy box but every scrambled state is a jagged
cluster of overhanging blocks. The puzzle shuffles ITSELF -- linger, pick a face layer +
axis, animate a 90 or 180 degree turn of that layer, settle, linger, repeat -- while the
whole thing slowly spins and wanders through space. Each facelet is a white face with a
soft black border. Self-contained three.js:
`start(canvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }`.
**Asset-free** (the only texture is generated in code). Author is Vasek Potocek, not jwz.

## Faithfulness (the rule: do NOT deviate from the algorithm)

The puzzle math is transcribed verbatim. Each piece carries a rotation QUATERNION `qr`
(the .c's `qr[4]` = `[w,x,y,z]`); a piece is drawn rotated by `qr` about the cube centre
(`glRotatef` before `glCallList`). Ported directly:

- **`mult_quat`** (`src*dest -> dest`), **`settle_value`** (round each component to
  `{0, +-1/2, +-1/sqrt2, +-1}` to snap a settled orientation), **`flag_pieces`** (computes
  each piece's CURRENT position `qr * pos * qr^-1` via the conj-imag / `mult_quat` dance and
  flags the 9 pieces on the chosen `+-1` face of an axis), **`randomize`** (100 instant
  90-degree turns -- the "Start as random shape" scramble), and **`finish`** -- the
  `linger <-> turn` state machine, including the `static int axis` walk (1 -> {2,3},
  2 -> {1,3}, 3 -> {1,2}), `side`/`angle`/sign from `rnd01()`, and `tmax = 90*angle`.
- **27 pieces** from `init_cp`'s `i`/`j`/`k` triple loop (`pos` in `{-1,0,1}^3`, ordered
  `pos = (k,j,i)`), each a closed box whose 8 corners pass through `fx`/`fy`/`fz` (the
  eccentricity: `A=0.5`, `B=0.25`, `C=0` -> x-slabs 1.5/1.0/0.5 wide, y-slabs
  1.25/1.0/0.75, z regular). The jagged overhangs in a scrambled state EMERGE from drawing
  these fixed irregular pieces under accumulated rotations -- there is no special-case
  shape logic, exactly as in the .c. Geometry depends only on the (fixed) position, so each
  piece's `BufferGeometry` is built ONCE (the `init_lists` QUAD_STRIP + QUADS, 6 flat faces
  with per-face normals + `(0,0)-(1,1)` texcoords); only the per-piece quaternion changes.
- **`draw_main` modelview**: `T((x-.5)*6, (y-.5)*6, -20) * Rspin(get_rotation*360) *
  S(cubesize) * S(portrait fit) * [per-piece Rqr]`, as one root `Group` (T*R*S) holding the
  27 piece meshes (each `R(qr)`); `gluPerspective(30, ratio, 1, 100)` with the camera at
  the origin looking down -z. Portrait reshape `s = w<h ? w/h : 1`.
- **Spin + wander** via `rotator.js` (`make_rotator(spinspeed x3, 0.1, wanderspeed, True)`).
  `get_position` is sampled before `get_rotation` (the .c's order). The two are ticked once
  per original-frame and INTERPOLATED between ticks (the dangerball pattern). The `spin`/
  `wander` CHECKBOXES gate the output live (zero rotation / centred position when off); the
  `spinspeed`/`wanderspeed` SLIDERS rebuild the rotator (they ARE its internal speeds, not a
  post-scale), like cubestorm's speed knob.

The layer-turn animation is made CONTINUOUS for smooth render: instead of the .c's fixed
per-frame `qfram`, we apply `qfram^frames` -- a fractional `tspeed`-degree step about the
turn's FIXED axis -- to each active piece. Because same-axis rotations compose additively,
this is mathematically identical to the .c applying `qfram` exactly `frames` times; the
clock `t` advances by `frames*tspeed` and `settle_value` snaps the sub-degree overshoot.

## Lighting + the facelet texture: a measured color-management decision

`init_gl` is the LIT path: two white parallel `DirectionalLight`s (GL `position` `{1,1,1,0}`
and `{-1,-1,1,0}`), global ambient `{0.1}` (the .c overrides the 0.2 default), material
`AMBIENT_AND_DIFFUSE` = white (`GL_COLOR_MATERIAL` tracks the default white `glColor`),
specular `{0.2}`, shininess 20, flat faces. Lights are `intensity = PI` (cancels three's
`1/PI` Lambert so diffuse = `albedo*NdotL` as in GL); ambient is `0.1*PI`; specular is
linear `0.2/PI` (the PI light over-drives the broad shininess-20 glint otherwise).

**Color management -- the cubestack opt-out, pinned by measurement.** This hack's content
IS the gray levels (white material + lit grays + black borders, no hue), so the output
gamma is decisive. The .c is the GL fixed pipeline with NO output encode -- it writes the
raw lit value to the 8-bit buffer, and the ground-truth screenshot is that buffer: its gray
faces measure **169 = 0.677*255** = one-light diffuse (`cos~55deg` = 0.577) + the 0.1 global
ambient, with no sRGB lift. The usual sRGB-output LIT convention would render that as ~214
(too light). So this renderer opts out: `outputColorSpace = LinearSRGBColorSpace`, raw white
material + linear specular. Verified: across fresh runs (each a new random tumble) the gray
faces land at 78/91 (dark), **145/162** (matching the GT's 132/169), and 202/247 -- the full
raw-GL range, not the lifted one.

The facelet texture (`make_texture`) is a 64x64 luminance map -- all white, then a soft
black line on each of the 4 edges (`w = offset^2 * 255 / 25`, taking the min) -- expanded to
RGBA in a `DataTexture` (`NoColorSpace`, `LinearFilter`, `ClampToEdge`, no mipmaps, matching
the .c's non-`MIPMAP` branch). The .c applies it with **`GL_MODULATE`**, which scales the
whole lit color; under linear output that is byte-exact as `map` + `specularMap` on the same
texture (`texel * lit == (texel*albedo)*light` -- multiplication commutes), so the borders
kill diffuse, ambient AND specular to black. `tex`/"Outlines" off drops both maps.

## Pacing / config

Render every rAF; `effFps = 1e6/(delay + OVERHEAD)`, `OVERHEAD = 37500` (the geometry-track
family default; the GL original is runtime-blocked here). One render frame is
`frames = dt*effFps` original-frames: the layer turn and clock `t` advance by `frames`, and
the rotator is ticked `frames` times. **OPEN:** `OVERHEAD` is the family default, not a
per-hack measurement; the xml default delay 20000 lands at ~17fps (90-degree turn ~1.7s,
180-degree ~3.4s, linger ~0.8s). Pin against the demo video (youtube `B2sGaRLWz-A`) if the
pacing reads off.

Config transcribed from `hacks/config/rubikblocks.xml` (labels verbatim -- the xml itself
reuses "Spin"/"Wander" for both the speed sliders and the on/off checkboxes): `delay`
("Frame rate", invert), `cubesize`, `rotspeed` ("Rotation"), `randomize` (the xml `<select>`
"Start as cube / random shape", exposed as a "Start scrambled" checkbox -- a live toggle
re-inits the puzzle), `spinspeed`/`wanderspeed`, `wait` ("Linger"), `spin`, `wander`, `tex`
("Outlines"), `wire`.

## Verification

CDP capture (port 9225) vs `rubikblocks.jpg`: the irregular mirror-blocks cuboid, the
self-shuffle (jagged mid-turn states across the +5s/+13s shots), the white/gray flat
shading at the correct raw-GL gray levels, and the thick black facelet grid all match. The
GT thumbnail is a tighter zoom-CROP than the faithful default framing (FOV 30, distance 20,
cubesize 1 -> the cube is ~1/3 frame); structure/shading/borders are the fidelity target,
not the crop.

## Known deviations / omissions

- **Trackball** (mouse drag to rotate) is dropped -- the host hacks are non-interactive.
- **Second light's specular.** GL gives only `LIGHT0` a (white) specular; `LIGHT1` defaults
  to black specular. three's `MeshPhongMaterial` applies specular from BOTH lights, so a
  second faint highlight comes from `(-1,-1,1)` that GL lacks. With specular `0.2/PI` and
  the broad shininess 20 it is a barely-visible sheen on near-camera faces; the faces read
  essentially matte (as in the GT).
- **Flat specular.** `GL_FLAT` computes one lit color per face (specular included); three
  shades the flat-normal face per-fragment, so specular has a gentle gradient where GL is
  flat. Sub-0.2 amplitude -> negligible.
- **`spin` off** snaps to axis-aligned (the dangerball gating convention); the .c's
  `spin=False` instead FREEZES a random initial tilt. Default is on, so this only affects
  the toggle.
- **Wireframe** is a plain `material.wireframe` toggle (lit white lines); the .c's wireframe
  path is unlit `glColor 0.7` lines with no texture. A rarely-used debug knob.

See also: `cubestack.md` (the color-management opt-out + the pilot conventions),
`dangerball.md` (the rotator gating + interpolation pattern); the `port-faithfully`,
`audit-past-ports`, and `framerate-calibration` memories.
