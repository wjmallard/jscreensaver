# topblock -- port notes

Port of `xscreensaver-6.15/hacks/glx/topblock.c` (rednuht, 2006-2012) plus the shared
primitives it `#include`s: `hacks/glx/tube.c` (unit_tube), `hacks/glx/sphere.c`
(unit_sphere), and `hacks/glx/topblock.h` (the constants/macros). Local reference copies:
`hacks/topblock.c`, `hacks/topblock.xml`.

Visual ground truth: `XScreenSaver_ Screenshots_files/topblock.jpg` (a green studded
baseplate with a growing pile of colored 2x1 bricks and several more falling in) and the
demo video in the xml (`https://www.youtube.com/watch?v=zj0FHFJgQJ8`).

## Algorithm (the .c)

An endless stream of toy building bricks drops onto a studded "carpet" and stacks up.

- **init_topBlock** clamps the knobs (see below), sets up ONE directional light, builds two
  GL display lists (`carpet`, `block`), and picks a camera mode.
- **generateNewBlock** (once per frame): with probability `1/spawn` -- and only while the
  highest currently-falling block is below a ceiling `getHeight((plusheight-blockHeight)+
  highest)` -- appends a new brick at a random grid cell, random orientation (0/90/180/270),
  random color, at spawn height `getHeight(plusheight+highest)`. The brick list is a
  singly-linked list with a **recycle**: once `numFallingBlocks >= maxFalling` it drops the
  oldest node (which it then leaks) and reuses the next one, keeping ~`maxFalling` bricks.
- **draw_topBlock** (per frame): advance the world rotation; ease `eyeLine` toward `highest`;
  then, for every brick, if it is falling, descend it by `dropSpeed` (all bricks fall in
  lockstep). When a falling brick comes within `highest+1`, test its 2-cell footprint against
  every settled brick; on a footprint overlap where `|height-(node.height+blockHeight)| <=
  TOLERANCE`, it lands on top (`height = node.height+blockHeight`) and may raise `highest`.
- The whole scene sits under `gluLookAt` + a slow `Rz(rotation)` turntable; `eyeLine` rises so
  the camera tracks the growing pile.

## Shared / faithful geometry

- **block** (`buildBlock`): built under `glRotatef(90,y)`. FIVE box faces from the verbatim
  `topBlockVertices`/`topBlockNormals` -- the sixth (+z, the underside) is intentionally
  omitted, and `GL_CULL_FACE` is disabled, so a brick is hollow underneath like the real toy.
  Then under a second `Ry(90)`: 8 stud "nipples" on top (capped tubes, radius `cylSize`) and
  3 "udder" tubes inside the hollow underside (radius `uddSize`). Every `glTranslatef`/
  `glRotatef` in the list is replayed on a `Matrix4` stack (`makeAccumulator`) and baked into
  one `BufferGeometry`.
- **carpet** (`buildCarpet`): a `carpetWidth x carpetLength` plane (top quad + 4 rim quads,
  green) tiled with `carpetWidth*carpetLength` stud tubes; drawn centered at `(-w/2,-l/2)`.
- **tube** (`tube.c`): a unit tube of radius 1 along +y, `faces` sides, SMOOTH radial normals,
  with two flat caps -- topblock passes `caps_p=True` (unlike glknots, whose tubes are
  uncapped). `tube_1`'s placement transform is transcribed exactly: `Translate(x1,y1,z1) .
  Rz(-atan2(X,Y)) . Rx(atan2(Z,hypot(X,Y))) . Scale(diameter,length,diameter)`. The
  `diameter` arg is used as the RADIUS (the unit tube already has radius 1).
- **sphere** (blob mode): `unit_sphere(resolution/2, resolution)` -> a radius-1 UV sphere.

All 8 nipples + 3 udders + 5 box faces are merged into ONE block geometry, drawn as a single
**InstancedMesh** (per-instance matrix + `setColorAt`) for all ~150 bricks; the carpet is one
static `Mesh`. Two draw calls, exactly the .c's two display lists. `frustumCulled=false` on
both (bricks span a large volume and the matrices are set manually).

## Faithful to the .c

- The recycle linked-list surgery is reproduced as `blocks.shift()+shift()+push` (verified:
  for the real `maxFalling>=75` the list length and `numFallingBlocks` stay equal and never
  hit the degenerate `<2` case that would break for tiny `maxFalling`).
- Collision uses bit-exact arithmetic (`blockHeight 1.49`, `TOLERANCE 0.1`, footprint cells
  offset by 2). Grid `x,y` are integers (float-stored), so the `===` cell tests are exact.
- The RNG call ORDER matches: per frame `random()%spawn`, then on a spawn `random()%4`
  (orientation), `random()%(half+endOffx)`, `random()%(half+endOffy)`, `random()%maxColors`;
  and the initial `random()%360` start angle in non-follow mode. `yarandom.js`, seeded per
  instance.
- The 8 block colors are the verbatim RGB switch (red/green/blue/white/orange/yellow/grey/
  near-black); default `maxColors 7` uses 0..6 (no black), as the screenshot shows.
- **Camera**: the ENTIRE GL modelview -- `gluLookAt` included -- is baked into a `worldRoot`
  `Matrix4` and the three camera is left at the origin/identity (so view = identity, world ==
  eye). This lets all three modes transcribe 1:1:
  - non-follow: `gluLookAt(1,20+eyeLine,25 -> 0,10+eyeLine,0, +y) . Rx(90) . Rz(rotation)`;
  - follow: `Rz(90) . gluLookAt(followBlock target, up -x) . Rz(rotation)`;
  - tunnel/override: the same non-follow path with the override cam/eye and no carpet.
  `followBlock` (the block-chasing easing + `quadrantCorrection`) is ported verbatim.
- The trackball block `Translate(0,0,-5) . gltrackball . Translate(0,0,5)` collapses to
  identity with no mouse (the overlay is `pointer-events:none`), so it is dropped.
- **Lighting**: GL `GL_POSITION {10,10,1,0}` is set under an identity modelview in init, so it
  is stored in EYE coordinates -- fixed to the camera, it does NOT turn with the world. Since
  our camera view is identity, a scene-space `DirectionalLight` at `(10,10,1)` is eye-fixed and
  matches. Ambient = LIGHT0 `{.1,.1,.1}` + GL's default global ambient `.2` = `0.3*color`
  floor; the material is `GL_AMBIENT_AND_DIFFUSE = color` with NO material specular (matte).
  Light intensity `= PI` cancels three's `1/PI` Lambert; ambient `= 0.3*PI` (the glknots/
  dangerball convention). `THREE.ColorManagement.enabled = false` for raw glColor output.
- `reshape`'s `gluPerspective(60, 1/h, 1, 1000)` and the tiny-window (`width > height*5`)
  middle-crop viewport are both reproduced.
- `drawCarpet` auto-disables once `highest > 5*maxFalling` (and in tunnel mode), as in the .c.
- The clamps from init are all mirrored: `size` (>10->10, <1->2), `carpetWidth = 8*size`,
  `maxFalling = 75*size`, `rotateSpeed/100`, `resolution*2`, `maxColors` clamped to 8 (even
  though the xml slider goes to 32), `dropSpeed = blockHeight/(80/dropSpeed)`.

## Deviations / deliberate choices

- **Per-fragment vs per-vertex lighting.** three's `MeshPhongMaterial` lights per fragment; GL
  fixed-function lights per vertex (Gouraud). On the flat brick faces (constant per-face
  normal) this is identical; on the small smooth studs the difference is imperceptible. Chosen
  for robust `instanceColor` handling (the cubestorm precedent). No specular either way.
- **Smooth (renormalized) tube normals.** GL doesn't `glEnable(GL_NORMALIZE)`, so its studs are
  lit with the non-uniform-scale-skewed normals; the port renormalizes (correct shading). The
  studs are tiny; the difference is not visible.
- **Interpolation.** The .c is frame-locked; the port renders every rAF and ticks the sim at
  `effFps`, INTERPOLATING falling heights + world rotation + the eye/eyeLine scalars one tick
  behind (catch-up capped at 8) so the fall is smooth at 60fps. Discrete state (spawn,
  collision) is only ever evaluated at the sim cadence, so the physics is unchanged.
- **Wireframe** is a best-effort `material.wireframe` toggle: three draws all triangle edges
  (lit), where GL draws per-polygon `GL_LINE_LOOP`s unlit and skips the udders/rims. Wireframe
  is a debug knob; the geometry is not rebuilt for it.
- **Structural knobs restart the scene.** `size`, `resolution`, `nipples`, `blob`, `follow`,
  `override` rebuild the display lists + reset the sim (the .c bakes these at init). Scalar
  knobs (`delay`, `dropSpeed`, `spawn`, `maxColors`, `rotateSpeed`, `rotate`, `carpet`, `wire`)
  are live.

## Pacing / OVERHEAD

`OVERHEAD = 6667` (**recalibrated 2026-07-01, was 37500**). `delay` is the frame-rate knob;
render is every rAF, the sim advances `dt*effFps` ticks per frame, `effFps =
1e6/(delay+OVERHEAD)`.

Why NOT the GL track's shared 37500 (`~21fps`): topblock's spawn AND fall are **frame-coupled**
-- `generateNewBlock` rolls `random()%spawn` once per sim-tick and bricks fall by `dropSpeed`
per tick -- so the sim rate IS the block-drop cadence. At `~21fps` the spawn gate fires only
~21x/s * 1/50 = ~0.4 blocks/s, giving a multi-second (observed ~15s) lag to the FIRST block and
a too-sparse pile vs the reference. The `.c` is a light hack (`delay=10000` -> tens of fps), so
`~21fps` is far too slow. Recalibrated to the `.c`'s intended **~60fps** (`1e6/(10000+6667)`),
which the reference screenshot's dense pile also implies: first block <1s, ~1.2 blocks/s. The
live binary can't be timed here (XQuartz Apple-DRI block) so 60 is the light-hack target rate,
not a measurement -- eyeball in a real browser. (If a slow machine's frame rate still starves
spawns via the `dt`-clamp + 8-tick catch-up cap, the fallback is a real-time spawn clock.)

## Config

`params[]` mirror `hacks/topblock.xml` 1:1: delay (invert), dropSpeed, size, spawn (invert),
resolution, maxColors, rotateSpeed, rotate, follow, blob, override ("Tunnel mode"), carpet,
nipples, wire. `config` is initialized from these defaults, not `param.default`. The xml's
`showfps` boolean is omitted (the host provides the FPS readout). `maxColors`' slider high is
32 per the xml, but the value is clamped to 8 in code exactly as `init_topBlock` does.

## Omissions

- Mouse trackball + the `a/z/s/x/d/c/f/v/g/b/h/n/r` debug keys (screensaver has no input; the
  trackball collapses to identity anyway).
- `do_fps` / `showfps` (host-owned FPS readout).

## Verification

Rendered headless (chrome-headless-shell + SwiftShader WebGL, driven over CDP for real-time
rAF) at default settings. Matches the reference: green studded baseplate, correctly
proportioned 2x1 studded bricks in the exact palette, falling from above and stacking into a
growing pile, top faces bright with shaded sides, slow turntable rotation, camera rising with
the pile. Confirmed multi-height stacks form (collision-on-top works) and the pile builds "up
and up."
