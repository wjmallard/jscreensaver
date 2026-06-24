# cubestorm -- design notes

Web port of xscreensaver's `cubestorm` (Jamie Zawinski, 2003),
`xscreensaver-6.15/hacks/glx/cubestorm.c`. A chain of `count` hollow, beveled "frame"
cubes spins and wanders together and leaves fading colored TRAILS -- a frozen
long-exposure of the spinning storm that grows, rolls, and is periodically wiped and
re-coloured. Self-contained three.js:
`start(canvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }`.
**Asset-free.**

## Faithfulness (the rule: transcribe the algorithm)

Transcribed from `cubestorm.c`:

- **The cube is a wireframe FRAME, not a solid box.** `draw_face` builds one square
  picture-frame face from 4 mitered, beveled struts (`Rz(90)` x4): each strut is two
  quads -- a front trapezoid in the face plane (`a..b` outer, `a+t..b-t` inner, normal
  `(0,0,-1)`) and the inner wall stepping back by `t` (normal `(0,1,0)`), where
  `t = thickness/2` clamped to `[0.001, 0.5]`. `draw_faces` places six faces by the exact
  cumulative `Ry(90), Ry(90), Ry(90), Rx(90), Rx(180)` sequence (GL post-multiplies). One
  cube = 48 quads = 96 triangles; built once into a `BufferGeometry`, reused per snapshot.
- **`push_hist` (the storm structure):** cube 0 is the master -- it supplies the shared
  wander position for *all* cubes AND the base rotation; cubes `1..` add cube 0's rotation
  (the .c's "N+1 cubes rotate relative to cube 0"). Each cube's colormap index increments
  per frame (so the trail is a smooth hue gradient), and the oldest `count` snapshots are
  dropped once the history passes `length`.
- **The clear cycle:** normally accumulate (each frame appends `count` snapshots); with
  probability `speed/200` flip into "no vapor trails" mode AND re-roll the colormap; in
  that mode the history is reset to empty every frame (just the live cubes show) until,
  with probability `speed/25`, trails resume. So: ~13s of storm at the defaults, a brief
  wipe, rebuild with new colours. (`floor(200/speed)`/`floor(25/speed)`, guarded `>= 1`.)
- **`draw_cube` modelview per snapshot:** `Scale(s*1.1)` * `T((p-0.5)*{15,15,30})` *
  `Rxyz(r*360)` * `Scale(4)`, where `s` is the portrait-fit and `1.1` the constant
  pre-scale (both uniform + outermost -> folded onto one outer group; the rest -- `T(pos)`,
  `Rxyz`, `Scale(4)` -- is each snapshot's `InstancedMesh` matrix, since
  `T*R*S(4) == compose(pos, eulerXYZ, 4)` and `S(4)` commutes with `R`). The rotations
  `glRotatef(rx*360,X) ... == three Euler 'XYZ'`.
- **Camera/lighting:** `gluPerspective(30, w/h, 1, 100)` + `gluLookAt(0,0,45, 0, +y)`;
  128-entry `make_smooth_colormap` (used raw -- three's colour management is disabled,
  GL-faithful output); one white directional light from
  `(1,1,1)` `intensity = PI`; ambient floor = GL default global `0.2` * the material
  ambient (= the per-cube colour, since the material is `GL_AMBIENT_AND_DIFFUSE`) ->
  `AmbientLight(white, 0.2*PI)`.

Motion (`rotator.js`), palette (`colormap.js`) and RNG (`yarandom.js`) are the shared
faithful ports; subcube rotators (cube 0: `wander 0.05`, `spin 10`, `accel 4`; the rest:
`spin 4`, `accel 2`, no wander) and the per-frame clear decision + `push_hist` draw from
the stream in the .c's order.

## Trails (the mechanism)

The .c's own header says the original "don't clear the buffer" accumulation trick stopped
working on modern GPUs, so it now **clears every frame and re-renders the entire saved
history**. We do the same (the brief's option **b**): keep the last `length`(+`count`)
snapshots of `{position, rotation, colorIndex}` in flat typed arrays and draw them all
each frame as one `InstancedMesh` (`DynamicDraw` matrices + per-instance colour), wiping on
the .c's schedule. **No blending** -- the cubes are OPAQUE frames (alpha 1); the "storm"
is overlap + depth-test, not translucency. Capacity `MAX_HIST = 1200` covers `length` high
1000 + `count` high 20 + the .c's realloc slack.

## Culling / winding (the one subtlety)

The .c draws under `glFrontFace(GL_CW)` + `GL_CULL_FACE`, two-sided lighting off: each
frame shows only the camera-facing strut faces, lit by the supplied normal. three is
CCW-front, so we **reverse each quad's triangle winding** and keep `THREE.FrontSide` --
this selects exactly the faces GL kept (verified by hand: the near `+z` face is CW in
screen -> reversed -> CCW -> kept; the far face is culled) and lights them with the
*unflipped* supplied normal, identical to GL. (Reversing the winding the wrong way shows
as an inside-out / blank cube, so it is easy to confirm; the capture shows correctly-lit
solid struts.)

## Lighting specular (the /PI fix)

GL gives each cube a white material specular under LIGHT0's cyan `{0,1,1}` specular ->
a cyan highlight at shininess 128. As in `dangerball.js`, the light has no separate
specular colour in three, so the cyan is folded onto the **material** specular; and as the
track-wide rule requires, it is divided by PI (`specular = (0, 1/PI, 1/PI)` linear) so the
`intensity = PI` light doesn't blow the (very tight, shininess-128) glint into a white
disc. In practice the highlight is a faint sparkle on a few struts -- the storm reads by
its diffuse colormap, matching the ground truth.

## Pacing / config

Render every rAF; the storm's "motion" is the discrete trail (each snapshot is frozen once
pushed), so there is **nothing to interpolate** -- the SIMULATION (rotator advance + clear
decision + `push_hist`) is ticked at the original cadence `effFps = 1e6/(delay+OVERHEAD)`
(`OVERHEAD = 37500`, track default; xml default delay 30000 -> ~15fps) and the static
history is re-drawn in between. The original itself runs at this same ~15fps, so the
frame-by-frame trail head is faithful, not choppy-by-mistake. **OPEN:** `OVERHEAD` is the
track default, not a per-hack measurement against the demo video (youtube `enuZbkMiqCE`),
since the GL originals are runtime-blocked here -- pin it there if the build/wipe rhythm
reads off. Config transcribed 1:1 from `hacks/config/cubestorm.xml`: `delay`, `speed`,
`count`, `length`, `thickness` ("Struts"), `wander`, `spin`, `wire`. The .c bakes
`speed`/`count`/`wander`/`spin` at init (can't change them live), so changing any of those
restarts the sim; `thickness` rebuilds the cube geometry; `length`/`delay` are read live.

## Deviations / omissions

- **Wireframe** maps to `material.wireframe` (triangle edges incl. the quad diagonals),
  vs the .c's `GL_LINE_LOOP` (quad outlines only) -- a minor edge-set difference in the
  secondary wire mode; the default solid mode is exact.
- **Omitted** (host-chrome / desktop-only, per the brief): the gltrackball mouse rotate,
  the spacebar-clear / event-helper colour-change keys, `-db` double-buffer, `-debug`.

Verified by CDP capture (headless, swiftshader) vs `cubestorm.jpg`: the sweeping spiral
comet-trail of nested hollow frame-cubes, the dense space-filling storm, the smooth
per-trail hue gradient, the solid lit struts, and the wander carrying the storm across
(and partly off) the frame all reproduce; exception-free.

See also: `dangerball.md`, `superquadrics.md`, `morph3d.md`; the
`glx-geometry-track-triage` + `framerate-calibration` memories.
