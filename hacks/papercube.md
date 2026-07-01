# papercube — port notes

Faithful port of `xscreensaver-6.15/hacks/glx/papercube.c` (Ireneusz Szpilewski &
Jamie Zawinski, 2023) to `papercube.js`. "How to make a glueless paper cube": a
flat net of 16 paper squares folds itself up into a cube along a fixed set of
creases, holds, spins away, and repeats with fresh colours.

## Algorithm (the original .c)

- **The net (`map`).** An ASCII grid, `MAP_ROWS`(6) x `MAP_COLUMNS`(5). Fields
  (`'o'` / `'^'`) sit at even text cells; `'+'` between two fields marks a crease
  (hinge). `get_field_from_map`/`get_edge_from_map` decode it. Row 0 is the bottom
  text line, row 5 the top. There are **16 fields and 15 creases**, so the crease
  graph is a spanning tree rooted at the base field `(1,1)` (`BOTTOM_FIELD_*`).
  Resolved layout (row 5 top .. row 0 bottom):

  ```
  row5:            (5,2)^          row2: (2,0)(2,1)(2,2)(2,3)
  row4:            (4,2)           row1: (1,0)(1,1)(1,2)(1,3)(1,4)
  row3:            (3,2)           row0: (0,0)(0,1)(0,2)(0,3)
  ```

- **Fold recursion (`paint_field_and_neighbours`).** Each field is a 1x1 quad on
  the y=0 plane at `x in [col,col+1]`, `z in [-row,-(row+height)]`. Starting from
  `(1,1)` it walks the crease tree; for each child crease it pushes the matrix and
  does `glTranslate(axis)`, `glRotate(sign*angle, hinge-axis)`, `glTranslate(-axis)`
  before recursing — so rotating a crease carries its whole sub-flap. `axis` is the
  shared-edge coordinate; the hinge axis is **Z** for horizontal creases (rotate
  about the vertical line `x=axis`) and **X** for vertical creases (`z=-axis`);
  `sign = (axis <= 1) ? -1 : 1`.

- **The arrow tile `(5,2)` (`'^'`).** `paint_field` draws it as a rectangle plus a
  tapering triangular tip (arrow). When its move is "inserting", its visible height
  is `2*cos(pi - pi*angle/180)`, which shrinks 1 -> 0 as it tucks into the cube.

- **Fold schedule (`initialize_moves`).** Three stages driven by wall-clock time:
  *Sunrise* fades brightness 0->1 (`glColor3f(v,v,v)` modulates the texture,
  `GL_MODULATE`); *Fold* runs 17 moves — the 15 tiles fold 0->90 deg in a fixed
  sequence (with a 1/3-angle and a 4/3-angle special), then two closing moves take
  tile `(4,2)` 30->90 and the arrow `(5,2)` 120->90 while inserting; *Spin_and_sunset*
  spins about Y (`SPIN_RPS`=1 for `spin+sun_d` seconds = 5 revolutions) and fades
  brightness 1->0, then `initialize_papercube(False)` re-rolls colours, toggles the
  grid, and picks a new eye angle / spin sign. `speed` scales every duration
  (`base/speed`) and the rotator (`0.5*speed` spin, `0.01*speed` wander).

- **Camera / motion.** `gluPerspective(30)`, `gluLookAt(0,10,10, 0,0,0)`; a portrait
  fit scale; the whole assembly is centred on the base field `(1,1)` and tumbles /
  wanders via `rotator.h` (`get_rotation` -> `glRotatef x,y,z * 360`, `get_position`
  -> `(v-.5)*3`), then `glRotated(eye + sign*spin, Y)`.

- **No lighting.** `reshape_cube` does `glDisable(GL_LIGHT0)` and nothing ever calls
  `glEnable(GL_LIGHTING)` — the faces are flat, unlit, textured quads. The texture
  (`paint_picture`) is 128x128: a solid random-pastel `fg` fill, an optional `bg`
  grid (alternate cycles), and a 2px black border — which is what draws the black
  outline around every paper square.

## Shared libraries used

- `rotator.js` — the tumble + wander (`make_rotator(0.5*speed per active axis, accel
  0.3, 0.01*speed wander, randomize=False)`, then `get_position`/`get_rotation`).
- `yarandom.js` — `random()` / `frand()` for the per-cycle `fg`/`bg` colours, eye
  angle and spin sign, in the C's call order.

## Faithful to the .c

- The full net and its crease tree are transcribed exactly (each hinge's
  orientation, `axis`, and `sign`), so `paint_field_and_neighbours`'s nested
  `glTranslate/glRotate/glTranslate` matrix stack is reproduced by a persistent
  tree of nested groups: **pivot** (`position=hinge`, `rotation=sign*angle`) >
  **inner** (`position=-hinge`) > {field mesh in ABSOLUTE coords + child pivots}.
  Composing `pivot.matrix * inner.matrix = T(hinge) R T(-hinge)` — identical to the C.
- The fold schedule is built once at `speed=1` (`SUN=2, FOLD=1, PAUSE=1, SPIN=3`),
  the exact 15-field `fields[]` order, the `1/3` (i=13) and `4/3` (i=14) multipliers,
  and the two closing moves (`(4,2)` 30->90, `(5,2)` 120->90 inserting). `get_move_value`'s
  latch-to-`After_stop` / return-`Stopping`-once behaviour is preserved, as is the
  `move_papercube` stage machine (Sunrise->Fold when sunrise stops; Fold->Spin when
  move[16] stops; re-init when sunset stops) and `move_fields`'s Starting-fall-through
  (`inserting` set on Starting, then angle written).
- The arrow tile's geometry is rebuilt every frame from `paint_field` exactly
  (`height`, `draw_arrow` when `height > 5/8`, `rect_height`, and `arrow_width *=
  (height-5/8)/(1-5/8)`), with texcoord `v` running `0..height`.
- The texture is built pixel-for-pixel like `paint_picture` (fg fill, optional
  `bg` grid at `x*16 - line/2`, 2px black border) into a `DataTexture`, sampled
  `LinearFilter` + `NoColorSpace` so `GL_MODULATE` (`map * color`) matches the raw
  framebuffer. `bg = 0.7 * (255 - fg)`; `fg = 255*(0.5+frand(0.5))` per channel.
- Colour management is disabled (`THREE.ColorManagement.enabled = false`) and there
  are no lights: an unlit `MeshBasicMaterial(map = texture, color = brightness)`,
  `DoubleSide` (no `GL_CULL_FACE`), opaque, depth-tested — matching the GL exactly.
- Camera `gluPerspective(30, w/h, 1, 100)` + `gluLookAt(0,10,10, ...)`, the portrait
  fit, and the base-field centre translate `(-1.5,-0.5,1.5)` (which cancels
  `paint_papercube`'s leading `glTranslate(cx,cy,cz)`) are reproduced by a
  scale > wander > tumble > eye/spin > centre group chain (verified against the C's
  composed modelview). The tumble maps `glRotatef x,y,z` to Euler `'XYZ'`, the
  established glknots convention.

## Deviations / deliberate choices

- **`speed` handling.** The .c bakes `speed` into fixed durations and the rotator at
  init (it's a static command-line arg). Here `speed` is a live knob: the fold clock
  advances by `dt*speed` against the `speed=1` schedule (algebraically identical to
  `base/speed` durations, and it tracks the slider without rebuilding), and the
  rotator (which bakes `0.5*speed`/`0.01*speed`) is rebuilt when `speed` **or** the
  rotation axes change — like glknots rebuilds its rotator on a rotation change.
- **Wander toggle.** Built with `wanderSpeed = 0.01*speed` always and gated by
  `config.wander` in the draw (offset forced to 0 when off) — identical output to the
  .c's `wander_speed = 0` and avoids a rotator rebuild (hence a tumble jump) on toggle.
- **Rotator smoothing.** The .c advances the rotator once per frame; we tick it at
  `effFps` and interpolate (lerp position, shortest-path lerp rotation) for smooth
  60fps display (the dangerball/glknots pattern). `dt` is clamped to 0.25s so a
  background-tab stall resumes smoothly instead of jumping the fold.

## Pacing / OVERHEAD

`OVERHEAD = 37500` (the GL family's shared measured value; live GL hacks can't be
timed under this machine's XQuartz Apple-DRI block). xml `delay` default 30000 ->
`effFps = 1e6/67500 ~= 14.8fps`, the rotator tick cadence. The fold timeline is
wall-clock (as in the .c), scaled by `speed`, so one cycle is ~39s at `speed=1`.

## Config

`params[]` mirror `papercube.xml` 1:1: **delay** (slider 0..100000, default 30000,
inverted, µs), **speed** (slider 0.02..5.0, default 1.0), **wander** (checkbox,
default on = `arg-unset --no-wander`), **rotation** (the 8-option `<select>`, default
`Y` = `DEF_SPIN`). The xml's `--fps` toggle is the host's built-in readout, not a
hack knob (as in the other ports). `config` is the source of truth; the host renders
the box from `params`.

## Omissions

- **Trackball / mouse** (`gltrackball_*`, `button_down_p`): the overlay canvas is
  `pointer-events:none`, so `!button_down_p` is always true (the rotator always
  updates) — the mouse-drag path is intentionally not ported.
- `DEFAULTS`' `count: 30` is unused in the .c (no `MI_COUNT`), and
  `suppressRotationAnimation` is a framework mobile hint — both ignored.

## Verification

Rendered headless (chrome-headless-shell + swiftshader) via a throwaway harness that
mounts the module directly. Captured the whole cycle: the flat net (with the arrow
tip's pentagon top and the left/right arms, centred on the base field), a mid-fold
(the `(2,2)..(5,2)` strip lifting into cube walls), a late fold, the fully **closed
cube** at completion (proving every hinge axis/sign and the arrow tuck are correct —
any error leaves gaps or a non-closing fold), the spinning/fading cube, and cycle 2
with the **grid texture** (teal complementary grid on the pink fill = `bg = 0.7*(255-fg)`).
No console errors. `node --check` passes; the JS source is ASCII-only (the µs unit
is written `µs`).
