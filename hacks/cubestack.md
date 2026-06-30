# cubestack -- design notes

Web port of xscreensaver's `cubestack` (Jamie Zawinski, 2016),
`xscreensaver-6.15/hacks/glx/cubestack.c`. An endless stack of unfolding, translucent
cubes -- each "cube" is six square picture-FRAMES (a frame = 4 trapezoidal edge struts +
a little inward "+" stub at each edge midpoint, NOT a solid box). A cube is built one
face at a time, each face folding up out of its plane (an eased rotation) as `state`
advances 0..5; a finished cube is committed to the stack and a fresh one unfolds on top.
The stack marches forward, slowly spins about its axis, wanders, and recolors from a
looping smooth colormap. Self-contained three.js:
`start(canvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }`.
**Asset-free.** Pilot of the cube-cluster wave; the model the other four follow.

## Faithfulness (the rule: do NOT deviate from the algorithm)

`draw_strut` / `draw_face` / `draw_cube_1` / `draw_cubes` are transcribed verbatim as an
immediate-mode walk over a `THREE.Matrix4` stack: `glPushMatrix`/`glTranslatef`/
`glRotatef` -> `pushM`/`translate`/`rotate`, in GL's post-multiply order
(`cur.multiply(M)`). The geometry is tiny (<= ~7.5k verts), so the whole tree is rebuilt
into ONE `BufferGeometry` every frame -- exactly as the .c re-emits it in immediate mode,
no display lists, no per-face `Object3D`s. Preserved exactly:

- the fold ratio `r = ease(EASE_IN_OUT_SINE, frac(state))` (the shared `easing.js`, a port
  of `utils/easing.c`, the same header the hack `#include`s); the per-face alpha
  modulation `COLORIZE` (alpha = `opacity * r2`, where `r2` is the face's own unfold
  fraction, or 1 once formed; the Bottom fades in as `1 + state` over state -1..0).
- the stack: `length` fully-formed cubes (state 5) marching +z by 1 each, only the BASE
  cube (`i == length-1`) drawing its bottom face, then the top unfolding cube at `state`;
  colors `colormap[ccolor - i - 1]` down the stack (a looping 32-entry smooth colormap).
- `draw_cube`'s modelview `S(portrait) * T(wander*{4,4,2}) * S(6) * Rx(-45) * Rz(20) *
  Rz(spin)`, camera `gluPerspective(30,1/h,1,100)` + `gluLookAt(0,0,30,...,up +y)`.
- per frame: `state += speed*0.015`, `spin += speed*0.05`; on `state > 6`, commit
  (`length++`, `ccolor++`, length capped 20). `thickness` clamped `[0.001, 0.5]`.

`ccolor` is indexed as a ring (`% NCOLORS`): the .c's `ccolor` can transiently reach
`ncolors` and read one slot past the array; we wrap, since the colormap is a closed loop.

## The look: additive translucency, and the color-management trap

The .c **disables lighting and depth test** and blends `GL_SRC_ALPHA, GL_ONE` (additive),
so overlapping struts GLOW (sum toward white) and you see through the frames. Reproduced
with an unlit `MeshBasicMaterial` (`vertexColors`, `transparent`, `blending:
AdditiveBlending`, `depthTest:false`, `depthWrite:false`, `side: DoubleSide` since
`GL_CULL_FACE` is off and there is no lighting to make winding matter). Vertex colors
carry the cube color premultiplied by alpha (alpha folded in; `opacity` stays 1, so
`AdditiveBlending`'s `SrcAlpha` factor adds `color*alpha`).

**The trap (a transferable lesson):** the GL fixed pipeline has NO color management -- it
blends the raw glColor values in encoded/display space and shows them as-is. three.js
defaults to blending in LINEAR space with an sRGB output gamma. For ADDITIVE blending
that is visibly wrong: the dominant channel saturates almost immediately and the output
curve lifts the others, so overlaps wash to flat GRAY/white far too fast (first capture
of this port came out fully achromatic). FIX -- opt this renderer out of color
management: `renderer.outputColorSpace = THREE.LinearSRGBColorSpace` AND store the RAW
(un-linearized) glColor values in the vertex colors (no `setRGB(..., SRGBColorSpace)`).
Then additive accumulation happens in the same encoded space GL uses and passes straight
to the sRGB canvas -- overlaps brighten while keeping their hue, going white only at the
most-overlapped crossings, matching the ground truth. This is per-renderer (scoped,
disposed on stop), so it does not affect the LIT geometry hacks, which keep the usual
convention (sRGB->linear colors + `intensity = PI` light + specular `/PI`).

## Pacing / config

Render every rAF; advance the continuous `state`/`spin` by `frames = dt*effFps` (the .c's
per-frame steps, sampled smoothly) and tick the wander rotator at `effFps` with
interpolation (the geometry-track convention). `effFps = 1e6/(delay + OVERHEAD)`,
`OVERHEAD = 37500` (xml default delay 30000 -> ~15fps). The wander rotator
(`make_rotator(0,0,0,0, 0.005, False)` -- wander only, no spin) is built once; the
`wander` checkbox gates its OUTPUT live (the dangerball pattern). **OPEN:** `OVERHEAD` is
the family default, not a per-hack measurement; pin against the demo video
(youtube `rZi5yav6sRo`) if pacing reads off.

Config transcribed from `hacks/config/cubestack.xml`: `delay` (Frame rate, invert),
`speed` (Animation speed), `thickness`, `opacity`, `wander`, `wire`. `wire` is a live
`material.wireframe` toggle -- a close approximation of the .c's rare debug view (which
also draws `GL_LINE_LOOP` per fan and skips the additive setup); acceptable for a debug
knob.

Verified by CDP capture vs `cubestack.jpg`: the unfolding picture-frame faces with the
"+" stubs, the fold/march/spin, and -- after the color-management fix -- the
hue-preserving additive translucency (this run gold, the screenshot magenta; both are
valid random smooth-colormap draws).

See also: `cubestorm.md`, `easing.js`, `dangerball.md`; the `glx-geometry-track-triage` +
`framerate-calibration` memories.
