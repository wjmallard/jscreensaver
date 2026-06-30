# cubetwist -- design notes

Web port of xscreensaver's `cubetwist` (Jamie Zawinski, 2016),
`xscreensaver-6.15/hacks/glx/cubetwist.c`. A set of concentric cube FRAMES (each
"cube" = six square frames of four trapezoidal edge struts -- a hollow wireframe box,
NOT a solid) nested one inside the next, shrinking by a fixed step. A single
*oscillator* eases one degree of freedom of the OUTERMOST cube -- a +/-90 rotation or
a small +/-displacement slide -- and that transform is applied CUMULATIVELY to every
deeper cube, so the stack winds up into a spiral / slides, then resets and twists a
new way. The whole object slowly spins (3-axis) and wanders. Self-contained three.js:
`start(canvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }`.
**Asset-free, font-free.**

## Faithfulness (the rule: do NOT deviate from the algorithm)

- **`make_cubes`** -- `step = 2*(thickness+displacement)`; cubes shrink from `size`
  1.0 by `step` until `size <= step` (the loop transcribed verbatim). Color
  `cc = (0.3+frand(0.7))` per channel, each deeper cube minus `cstep = 0.8/depth`,
  clamped to `[0,1]` (GL clamps glColor). `thickness`/`displacement` default 0, which
  trips the init randomization: 50/50 between **thick** (`0.03+frand(.02)`, displacement
  0 or `thickness/3`) and **thin** (`0.001+frand(.02)`, displacement 0). RNG is drawn
  in `init_cube`'s order -- rotator, then the thickness randomize, then the color roll.
- **The frame geometry** -- `draw_strut` (a trapezoid in the face plane + a beveled top
  quad) and the 6-face / 4-strut loop (Rz 90 between struts; Ry 90 around the four
  sides + the extra Rz at `j==3`; Rx 180 for top/bottom) are transcribed as a
  `THREE.Matrix4`-stack walk, in GL's post-multiply order. Unlike `cubestack` (whose
  geometry morphs every frame), a cubetwist frame is STATIC, so each cube's frame is
  baked ONCE into its own `BufferGeometry` (position + the .c's explicit per-quad
  normals + the cube's flat color), and only the per-object transforms animate -- the
  cubestorm / gears pattern. Depth can reach ~499 at the thinnest randomized strut; a
  `MAX_DEPTH = 512` guard caps it (never reached in practice).
- **`draw_cubes`' cumulative nesting** -- the .c propagates the head cube's `rot`/`pos`
  down the linked list and applies `glRotatef(rot)*glTranslatef(pos)` between levels
  WITHOUT a push/pop, so cube *i* lands at `M_global * (R*T)^i`. Reproduced exactly:
  the model root carries `M_global`, cube *i*'s mesh matrix is the accumulated
  `(R*T)^i`. `M_global = S(portrait)*S(1.1)*T(wander*{4,4,2})*R(spin*360)*S(6)`; camera
  `gluPerspective(30,1/h,1,100)` + `gluLookAt(0,0,30,...,up +y)`.
- **The oscillators** -- `tick_oscillators`: `ratio += (0.1/speed)*osc.speed` per
  frame; `*var = from + (to-from)*ease(EASE_IN_OUT_SINE, ratio)` (the shared
  `easing.js`, a port of `utils/easing.c`, the same header the hack `#include`s); at
  `ratio>=1` the oscillator either expires (when `remaining` hits 0) or reverses (swap
  `from`/`to`, `ratio=0`). `add_random_oscillator` picks one of the head's six DOFs --
  rotations to `+/-90` (`repeat` usually 1), slides to `+/-(thickness+displacement)`
  (`repeat` 2). A new oscillator is added (after RESETTING the head's rot/pos to 0)
  only when none is running, with probability 1/60 per frame. The `add_oscillator`
  per-DOF dedup (and its quirk of never checking the last list node) is transcribed,
  though it is moot here -- adds only ever happen with an empty list, so there is
  exactly one oscillator at a time.

The **head reset is faithful and visible**: because `repeat` is usually 1, a rotation
oscillator ends wound up at +/-90 (per level -- a deep spiral), holds during the idle
gap, then SNAPS back to aligned when the next oscillation begins. The verification run
caught exactly this (a strong spiral, then near-aligned concentric cubes a second
later).

## Lighting: the default is UNLIT (the .c's `do_flat`)

`init_cube` sets up `GL_LIGHTING`/`GL_LIGHT0`/`GL_LIGHT1` ONLY in the `!wire && !do_flat`
branch, and `DEF_FLAT` is `"True"`, so the **default mode is unlit**: every face of a
cube is one flat `glColor`, and the only brightness variation is the per-cube depth
gradient (`cc -= cstep`). Sampling the ground-truth screenshot confirms this -- the
layer-to-layer step is a **constant per-channel subtraction** (`srgb(149,100,119)` vs
`srgb(133,85,101)`, delta ~16 on every channel), which is the `cstep` gradient, NOT a
multiplicative light falloff (which would hold a constant *ratio*); and there is zero
specular tint. So the faithful default is `flat: true` -> `MeshBasicMaterial`,
vertex-colored, no normals needed. Opaque + depth-tested, no blending, so the standard
color path applies: colors authored `sRGB->linear` (`setRGB(..., SRGBColorSpace)`) with
the default sRGB output, giving the glColor value on screen (no color-management opt-out
like cubestack's additive case).

The **`flat` checkbox, unchecked**, switches to the .c's lit path (also verified):
two white `DirectionalLight`s at the .c's positions -- `GL_LIGHT0` from `{0.5,-1,-0.5}`,
`GL_LIGHT1` from `{-0.75,-1,0}`, **both** white diffuse and white specular (`LIGHT1`'s
specular is set explicitly, not the GL black default) -- at `intensity = PI` so they
sum like GL's two lights and the PI cancels three's `1/PI` Lambert; an `AmbientLight`
at `0.2*PI` for GL's global ambient (x the cube color); and a `MeshPhongMaterial` with
the yellow material specular `{1,1,0}` divided by PI (so the PI lights don't blow it
to a white disc) and shininess 30. Both materials use `side: DoubleSide`: the .c culls
`GL_CW` back faces, but for flat opaque bars the visible pixels are identical and this
removes winding risk (per the cube-cluster lessons). The only consequence is, in the
lit path, back faces glimpsed through the gaps are lit by their viewer-facing normal --
a minor, non-default deviation.

## Pacing / config

Render every rAF. The oscillator ratios advance CONTINUOUSLY by `frames = dt*effFps`
(the .c's per-frame step, sampled smoothly), while the spin/wander rotator and the
1/60 "start a new oscillation" check tick once per original-frame (at `effFps`) with
interpolation for a smooth render (the geometry-track convention, as cubestack /
dangerball). `effFps = 1e6/(delay + OVERHEAD)`, `OVERHEAD = 37500` (xml default delay
30000 -> ~15fps). The rotator (`make_rotator(0.05,0.05,0.05, 1.0, 0.005, True)`) is
built once at full speed; the `spin`/`wander` checkboxes gate its OUTPUT live (the
dangerball pattern -- the randomize path consumes the same RNG regardless of speed, so
the stream stays in step). **OPEN:** `OVERHEAD` is the family default, not a per-hack
measurement; pin against the demo video (youtube `RjrtUtMEa_4`) if pacing reads off.

Config transcribed 1:1 from `hacks/config/cubetwist.xml`: `delay` (Frame rate, invert),
`speed` (Animation speed), `thickness`, `displacement`, `flat` (Flat shading), `wander`,
`spin`, `wire`. Notes:

- **`speed` is nearly a no-op at a constant setting** -- and this is faithful. The .c's
  per-frame ratio step is `(0.1/speed) * osc.speed`, and `osc.speed` is `speed*0.07`
  (rotation) / `speed*0.3` (slide), so `speed` CANCELS: the rate is a fixed
  `0.007`/`0.03` per frame whatever the slider says. It only bites transiently, when
  the slider is moved mid-oscillation (in-flight oscillators keep their creation-time
  `osc.speed` while `tick` uses the live `speed`). The port reproduces this exactly.
- **`thickness` / `displacement` rebuild the geometry** (they change the cube count and
  sizes), so the loop watches them and re-runs `make_cubes` on change. To avoid the
  palette flickering while dragging (which the .c, a command-line program, never does),
  the base color is rolled at init and on re-seed only, not inside `make_cubes`; the
  default look is unchanged, and a slider near 0 still triggers the .c's randomization.
  Rebuilding at the thinnest settings (hundreds of nested cubes) can briefly stutter.
- **`reinit()`** (host "re-seed") mirrors the .c's space-bar: clear the oscillators,
  reset the head, re-randomize thickness/displacement, re-roll the color, rebuild.
- **`wire`** is a live `material.wireframe` toggle -- a close approximation of the .c's
  `GL_LINE_LOOP` debug view (three adds the triangle diagonals); acceptable for a debug
  knob.

## Verification

CDP capture vs `cubetwist.jpg`. The default unlit mode reproduces the structure
exactly: concentric cube frames, the cumulative spiral twist, the bright-outer ->
dark-center depth gradient, the corner-on perspective. Color is random per run (the .c
rolls `0.3+frand(0.7)` per channel) -- the screenshot is mauve, captured runs were green
and gold; all are valid draws, and the palette CHARACTER (one hue, outer-bright /
inner-to-black gradient) matches. The thin- vs thick-strut split (the init randomization)
showed up across runs as expected. The lit path (`flat` off) was verified separately and
renders correctly shaded with the two-light setup.

See also: `cubestack.md`, `cubestorm.md`, `dangerball.md`, `easing.js`; the
`glx-geometry-track-triage` + `framerate-calibration` memories.
