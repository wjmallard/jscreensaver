# engine -- design notes

Web port of xscreensaver's `engine` (Ben Buxton / Ed Beroset / Jamie Zawinski,
2001), `xscreensaver-6.15/hacks/glx/engine.c`. A spinning, wandering internal-
combustion engine -- crankshaft + flywheel, reciprocating pistons, swinging
connecting rods, spark plugs firing in sequence with red flashes -- rendered as
one of ten real engine models (Honda Insight inline-3 ... Jaguar XKE V12).
Self-contained three.js module: `start(canvas, opts) -> { stop, pause, resume,
getStats, reinit, config, params }`.

## Algorithm (how the .c works)

- **Engine table** (`engines[]`): ten `{ cylinders, includedAngle, pistonAngle[12],
  speed, name }` records. `includedAngle` 0 = inline, 180 = flat (boxer), else V.
  `pistonAngle[j]` is cylinder j's crank phase (degrees of a 720-degree four-stroke
  cycle); it drives both the piston height and the firing order. `speed` is the
  crank step in degrees/frame (12 or 15). `find_engine()` maps `--engine <name>`
  to an index, or picks at random for "(none)".
- **Primitives**: everything is built from `cylinder()` (a cylinder/tube along +X,
  radius = the `outer`/`inner` args, optional partial arc `sang..eang` and end
  caps), `rod()` (a solid capped `cylinder`), `Rect()` (a box), and `CrankBit()` (a
  `Rect` + a 60-degree solid arc = one crank web/counterweight).
- **`makeshaft()`** builds the crankshaft display list: a blue flywheel (tube +
  two cross-brace `Rect`s), the blue main journals between cranks, and per cylinder
  a blue wrist pin (thrown -1 in Y) + two green `CrankBit` webs, each pre-rotated
  about X by `HALFREV + pistonAngle[j] (+ includedAngle if odd)` so the throws sit
  at the right phases.
- **`makepiston()`** builds the piston display list: a hollow gray body
  (`cylinder` tube, right-capped) + two dark rings, all pre-rotated 90 about Z so
  the piston stands vertical.
- **`display()`** per frame: `gluLookAt` from (0,0,30); an aspect "portrait fit"
  scale; position the light; `Translate(wander)`, `Rotate(spin)`, `Translate(-5,0,0)`
  (spin about the engine center). Draw the crankshaft rotated by `display_a`. Then,
  for each bank (`sides` = 1 inline / 2 V-flat, the 2nd rotated by `includedAngle`
  about X): the pistons (translated to `yp[b]-0.3`), then under a 90-Z frame the red
  spark plugs, white electrodes and blue connecting rods (each `Rotate(ang[b],Y)` +
  `rod(-cos b, .., -sin b, ln[b], 0.2)`), then the translucent-yellow block
  `Rect`s. `yp`/`ln`/`ang` come from a precomputed crank-slider table (crank radius
  1, rod length 5). Finally the firing loop: any cylinder at crank angle 0 (mod 720)
  fires `boom()` -- a growing then shrinking translucent-red flame rod + a red
  `LIGHT1` -- and `display_a += speed`.
- **Label**: when `--titles`, `print_texture_label(.., 1, engine_name)` draws the
  name (e.g. "Honda Insight\n3 Cylinder", "Jaguar XKE\nV12") in yellow at screen
  position 1 (top-left).

## Shared libraries used

`yarandom.js` (RNG; the model pick + rotator draws go through it, in `init_engine`'s
order: `make_rotator` before `find_engine`), `rotator.js` (spin + wander), and the
new `hud-label.js` (the on-screen text label; see below). No `colormap.js` --
engine uses fixed material colors, not a palette. No jsm/`three/addons` -- the
geometry is built directly from the ported primitives.

## The HUD label helper (`hud-label.js`)

`print_texture_label` renders a string into a texture and draws it in a separate
orthographic pass over the finished 3D frame (not as scene geometry). The web
equivalent is a **2D canvas overlay** stacked above the WebGL canvas:
`makeHudLabel(parentEl, opts) -> { setText, setColor, setCorner, resize, clear,
dispose }`. Built as reusable infrastructure so the other label-drawing GL ports
(glsnake, circuit) can import it unchanged.

- **Overlay**: its own `<canvas>`, `position:fixed; inset:0; pointer-events:none`,
  `z-index:2` (above the hacks' `z-index:1` WebGL canvas), fully transparent except
  the text; dpr-aware `fillText`.
- **Font**: xscreensaver's `titleFont` default is `sans-serif 18`. No sans-serif is
  vendored in `hacks/fonts/`, so we use **`luximr.ttf` (Luxi Mono)** -- the cleanest,
  most neutral, legible face available (and itself an xscreensaver-bundled font),
  loaded via `FontFace` resolved relative to the module; the label redraws when the
  face is ready, falling back to platform monospace until then.
- **Corner** mirrors `print_texture_label`'s `position` codes. `texfont.c`'s
  position 1 ("top") is `x = ascent; y = window_height - ascent*2` in GL ortho (y
  up) -- i.e. the **top-left** corner with a ~one-ascent margin -- which is this
  helper's `'tl'`. (`'bl'` ~ position 2; `'tr'`/`'br'` complete the set.) The margin
  is `~0.8*fontSize`, matching `x = ascent`.
- **Outline**: `print_texture_label` draws the string five times (four dark offset
  copies + the color on top) for contrast, and picks the outline shade by a Rec.709
  luma test (`luma > 0.4 -> dark`). The helper does the same (a proportional ~1px
  border, luma-chosen color), so yellow text gets a black outline exactly as the .c.
- **Size**: proportional to the overlay height (~3%, clamped 12..40 px). The .c uses
  a fixed 18 px window-pixel font; at the usual window sizes the proportional value
  lands in the same ballpark while staying legible on tiny/huge canvases.
- **engine.js use**: `setText(engine_name)`, color `rgb(255,255,0)` (the .c's
  `glColor3f(1,1,0)`), corner `'tl'`; shown only when `config.titles`, and the text
  is refreshed on a model change or a live titles toggle.

## Faithful to the .c (do not deviate)

- The **ten-engine table** transcribed verbatim (cylinders, included angle, all
  `pistonAngle[]`, speed, name) -- firing order and V/flat/inline geometry.
- **`cylinder()`/`rod()`/`Rect()`/`CrankBit()` ported vertex-for-vertex**: solid vs
  tube, partial-arc closing walls, the two end-cap triangle fans, the radial wall
  normals; `nsegs = outer*(max(w,h)/200)`, floored, `>= 40`, made even. `outer`/
  `inner`/`diameter` are radii, as in the .c. So every part is the original mesh.
- **`makeshaft`/`makepiston`/`display` assembly**: one crankshaft down the middle
  spun by `display_a`; the per-crank pre-rotation `HALFREV+pistonAngle (+includedAngle
  if odd)`; the bank split (`sides`, 2nd bank rotated `includedAngle` about X); the
  `crankOffset = 3.3` (halved for V/flat); piston reciprocation `yp[b]-0.3`; the
  connecting rod `Rotate(ang[b],Y)` + length `ln[b]`; the plug/electrode/block
  geometry and positions; the `Translate(-5,0,0)` recentering.
- The **crank-slider tables** `yp[i]=cos i + sqrt(25 - sin^2 i)`, `ln`, and
  `ang = -asin(sin i / 5)*57` (kept the .c's coarse integer `57`, not `180/pi`).
- **Firing (`boom`)**: the single-flash state machine (`boom_time`, `flameOut =
  720/speed/cylinders`, grow to frame 8 then shrink, `boom_d`/`boom_wd`), the
  translucent-red flame `rod` at the plug, and the red `LIGHT1`; stepped once per
  original-frame exactly as the .c's per-frame fire loop (including the quirk that
  the frame after firing also runs the `boom(lastPlug, 0)` decay).
- **Fixed materials** (`GL_AMBIENT_AND_DIFFUSE` = the color): blue crank, green
  webs, gray 0.6 piston body (+ dark 0.2 rings, specular 0.6/shininess 20), red
  plugs, white electrodes, translucent-yellow (alpha 0.4) block with depth-write off.
- **Lighting**: one positional light at (7,7,12), diffuse+specular 0.8 gray, no
  distance attenuation; GL's default 0.2 global ambient. Light `intensity = PI`
  (0.8*PI here) cancels three's 1/PI Lambert; specular /PI so it doesn't blow out;
  `THREE.ColorManagement.enabled = false` -> raw glColor.
- **Motion**: `make_rotator(spin?0.5:0 x3, accel 1.0, wander?0.01:0, randomize)`;
  `Translate(x*16-9, y*14-7, z*16-10)` wander; `Rotate(spin)` with the .c's quirk
  that the **Z rotation reuses x** (`glRotatef(x*360)` for both X and Z axes) --
  kept verbatim. `gluPerspective(40)` at z=30; the reshape portrait-fit scale.

## Deviations / deliberate choices

- **Ported primitives -> `BufferGeometry`, not immediate-mode GL_QUADS.** The .c
  emits quads/triangles via `glBegin`; we accumulate the identical vertices +
  outward normals into non-indexed `BufferGeometry`. Same mesh, just retained-mode.
  (TRAP 1: the position/normal arrays are plain JS arrays grown with `push`, so
  there is no fixed-size truncation risk; each vertex contributes 3 floats.)
- **`DoubleSide`, winding ignored.** `engine.c` never enables `GL_CULL_FACE`, so all
  faces are two-sided; materials are `DoubleSide` and triangle winding is irrelevant
  (only normal direction matters, for lighting). This sidesteps the winding bugs
  that a culled port would risk.
- **Built once, transformed per frame.** The .c redraws the pistons/plugs/rods/block
  every frame from display lists; only their transforms change (piston Y, bank
  angle) -- except the connecting rods, whose length `ln[b]` changes. So each part
  is a mesh built once, and the connecting rods + the boom flame share ONE unit rod
  (radius 0.2, length 1, along X) instanced with a per-frame `Rotate * Translate *
  Scale(len,1,1)` matrix -- reproducing `rod(x,y,z,ln,0.2)` exactly (the scale only
  touches the length axis; `GL_NORMALIZE` is on in the .c, three renormalizes).
- **Per-crank rotation baked into the mesh.** The .c `glRotatef`s the modelview
  before drawing each crank's pin + webs into the display list; we bake that X-axis
  rotation into the geometry (positions + normals) at build time, so the whole
  crankshaft is two static meshes (blue + green) that spin as one under `display_a`.
- **`polygonOffset` on the green webs (z-fight fix).** The crankshaft is built from
  abutting primitives, so each blue crank-pin / journal end-cap disc is *coplanar*
  with the green crank-web (`CrankBit`) face it butts against (pin spans
  `[crankOffset*j, crankOffset*j+crankWidth]`; webs at `crankOffset*j` and
  `crankWidth-crankThick+crankOffset*j`). `engine.c` hides this with `GL_LESS` + a
  deterministic blue-before-green draw order, so blue wins the depth tie cleanly. Our
  port draws blue and green as two separate meshes under three's `LEQUAL` depth; the
  coincident planes rasterize to ~1-ULP-different depths per pixel (different
  triangulations of the same plane in separate meshes), so the winner **speckled
  per-pixel and flickered as the crank spun** -- blue bleeding through the green
  webs -- worsened by `DoubleSide` letting the pin's interior back-faces compete. Fix:
  a small negative polygon offset (`polygonOffsetFactor/Units = -1`) on the green web
  material biases it a hair toward the camera so it **deterministically wins** the
  depth test at every coincident surface -> clean solid green webs, no blue bleed, no
  flicker, independent of draw/sort order (and it occludes the back-face bleed too).
  Chosen over per-primitive geometric inset (would need editing every abutting rod
  length) and over `FrontSide` (our winding isn't guaranteed outward, so it would risk
  inside-out solids); the offset is sub-pixel and only affects genuinely coincident
  faces, so nothing else shifts. The camera near/far (`1.5`/`70`) already matches the
  .c's `gluPerspective` exactly -- depth precision was not the cause, the coincidence
  was. Verified: an inline-6 with spin off, two crank phases apart, went from heavy
  shifting blue speckle to clean stable green (also checked on the V12, tumbling).
  **Second pass (residual on a cam-end triangle).** The green-only offset fixed the
  web bulk, but a residual flutter persisted on a triangle at the end of a crank cam.
  Diagnosis: the ONLY visible-color coincidences here are blue-vs-green -- the two
  green faces inside a `CrankBit` (the arc end-cap fan vs the `Rect` face) are also
  coincident, but they share a normal AND color, so that tie is *invisible* and needs
  no fix (a uniform green offset couldn't separate them anyway). The residual was a
  blue/green tie the single `-1` green bias didn't fully overcome -- notably the blue
  connecting-rod big-end, which lives in a DIFFERENT transform group (the bank's Rz90
  frame) than the crankGroup webs, so its "same" point carries a larger numerical
  depth mismatch. Fix: also bias the blue crankshaft/rods the OPPOSITE way
  (`matBlue` `polygonOffsetFactor/Units = +1`), so every blue/green tie separates by a
  ~2-unit margin regardless of which group computed it -> the residual clears. Blue
  moving back is only ever the desired outcome at its coincidences (green webs win;
  the rod small-end sits inside the gray piston), so it introduces nothing new. Still
  preferred over geometric inset because the connecting rod is a shared scaled unit
  rod -- you can't inset just its big-end. Re-verified: an 8-frame cam animation
  (~2 deg steps) shows no toggling face; spin-on inline-6 + V12 render clean with no
  new artifacts and no console errors.
- **Geometric inset on the flywheel spokes (blue-on-blue z-fight fix).** The
  flywheel is a blue rim tube (`cylinder(-2.5,0,0, 1, 3,2.5, ..)`) plus two crossing
  blue spoke `Rect`s that reach `r=2.8` into the rim band `[2.5,3]`. A tube with
  `endcaps=0` still emits `+/-x` annular end-ring faces, so the rim has a `+x` ring
  at `x=-1.5`; the spokes span `x=[-2,-1.5]`, so each spoke's `+x` face was
  *coplanar* with that ring where they overlap (`r=[2.5,2.8]`) at the four spoke/rim
  junctions. Both are the SAME `matBlue`, so the crankshaft's `polygonOffset` can't
  separate them (identical bias), and the two faces are triangulated differently
  (the rim's circular per-segment quads vs the spoke's 2-triangle rectangle), so
  they aren't bit-coplanar -> sub-ULP depth jitter -> a per-pixel toss-up that
  **speckled with a hatched moire at the junctions** (seen from the `+x`/engine
  side, including through the translucent block). `GL_LESS` (`LessDepth`) resolves
  only EXACT ties, not this `~`coplanar case, so no depth trick fixes it -- it needs
  a GEOMETRIC change. Fix: recess each spoke's `+x` face 0.03 behind the rim ring
  (x-extent `0.5 -> 0.47`, `+x` face `-1.5 -> -1.53`) so the rim ring cleanly
  OCCLUDES it in the overlap band -> deterministic, no speckle. Only the `+x` face
  moves (`x` stays `-2`); the `-x` side was already clean (the rim's `-x` ring at
  `x=-2.5` sits 0.5 *in front of* the spokes' `-x` faces at `x=-2`). 0.03 on a 0.5
  spoke at `r=3` is sub-visible -- the same KIND of nudge as the green cam's `+0.03`
  in `CrankBit`. A deliberate sub-visible deviation from the .c, whose flush
  geometry has the identical coincidence but doesn't visibly fight under its
  fixed-function `GL_LESS` + single-display-list draw order.
- **Positional light kept in world space.** The .c sets the light after `gluLookAt`
  (a pure z-translate here), so its eye-space position equals the given world coords;
  we add it to the scene root at (7,7,12), fixed while the engine tumbles -- faithful.
- **Boom light re-parented, count kept constant.** The red flash light is re-parented
  onto the firing cylinder's plug frame (so it tracks the spinning plug) and its
  intensity is 0 when idle; it's always kept in the scene graph so the light count --
  and thus the compiled shaders -- never changes (no per-fire recompile hitch).
- **`engine`/`titles`/`spin`/`wander` are LIVE.** Changing the model rebuilds the
  meshes (a deliberate user action); toggling titles refreshes the label; toggling
  spin/wander re-inits the rotator. `reinit()` (host "re-seed") picks a fresh random
  model.
- **Piston brightness is orientation-dependent, as in the original.** The gray-0.6
  material reads light when the crowns face the light and dark when the walls are
  grazing; the bundled screenshot catches a darker phase, our stills a lighter one --
  same material, different tumble frame (verified across models).

## Pacing / OVERHEAD

`effFps = 1e6/(config.delay + OVERHEAD)`; render every rAF. The crank angle advances
`ENG.speed` per **original-frame**, ticked in a catch-up loop at `effFps` (capped at
8) with the visual angle interpolated between integer ticks for a smooth crank; the
firing/boom state machine and the rotator's discrete random walk are ticked in the
same loop (the rotator orientation/position then interpolated -- the dangerball.js
pattern). **`OVERHEAD = 37500`** -- the GL family's shared default (live GL can't be
timed under this machine's XQuartz Apple-DRI block, so every three.js port adopts
the same measured overhead). xml default delay 30000 -> `effFps = 1e6/67500 ~=
14.8fps`. See framerate-calibration.

## Config (params transcribed 1:1 from hacks/engine.xml)

`delay` (Frame rate, 0-100000, def 30000, invert) - `engine` (select: Random +
the 10 models, def Random) - `titles` (Show engine name, checkbox, def false) -
`wander` (checkbox, def true; the .xml's `--no-move` unset -> the `move` var) -
`spin` (checkbox, def true; `--no-spin`). `showfps` skipped (the host has its own
readout). The blurb is the xml `<_description>` verbatim, including the original's
**typo "combusion"** (kept, not "fixed"); the credit line "Written by Ben Buxton,
Ed Beroset and Jamie Zawinski; 2001." is stripped to `author`/`year` (first author,
first year), which the host re-adds.

## Omissions

- **Trackball / mouse** (`gltrackball_*`): the host hacks aren't interactive
  (`pointer-events:none` overlay); the modelview omits the identity trackball term.
- **`do_fps` / `showfps`**: the host shows its own framerate readout (`getStats`).
- **The macOS `suppressRotationAnimation` / device-rotation** paths in
  `print_texture_label` -- irrelevant in the browser overlay.

## Structural / correctness self-review

Verified against the bundled `XScreenSaver_ Screenshots_files/engine.jpg` + the demo
video (youtube 8BL2o8QJmiA) via the headless-Chrome rig on a throwaway harness
(removed; not committed):

- **Corvette Z06 (V8)** -- V-bank layout, blue crank + flywheel, green staggered
  webs, gray pistons + rings, blue rods, translucent-yellow block. Matches the
  reference's structure and palette.
- **Honda Insight (inline-3)** + titles -- single bank, 3 pistons, flywheel with the
  visible blue cross-brace spokes; the label "Honda Insight / 3 Cylinder" in yellow,
  black-outlined, top-left (Luxi Mono), matching `print_texture_label` position 1.
- **Jaguar XKE (V12)** + titles -- 12 staggered crank throws at the V12 firing
  angles, twin banks; label "Jaguar XKE / V12" (correct V-format: no " Cylinder").
- **Porsche 911 (flat-6)** + titles -- horizontally-opposed pistons (180 banks),
  visible red plug tips + white electrodes; label "Porsche 911 / Flat 6".
- **BMW M5 (inline-6)** -- inline layout; wander drift and spin confirmed across
  frames.
- **Firing** -- caught a bright-red plug flash on an end-on frame; a full 6 s V12 run
  (which fires many times/second) produced zero JS console errors, confirming the
  boom re-parenting/decay path is sound.
- **Live titles bug found + fixed** -- toggling `titles` without changing `engine`
  originally did not refresh the label (only a model rebuild called `updateTitle`);
  the tick loop now watches `config.titles` and updates the HUD. Re-verified with a
  random engine (engine unchanged) + titles on -> label renders.
- **Crank-web z-fighting fixed (post-registration, two passes)** -- blue crank
  pins/journals/rod-big-ends bled/flickered through the green webs at coincident
  attachment planes. Root cause + fix in Deviations: pass 1 = negative
  `polygonOffset` on the green web material (fixed the web bulk); pass 2 = opposite
  positive `polygonOffset` on the blue crankshaft/rods to clear a residual flutter on
  a cam-end triangle (a blue/green tie -- the connecting rod is in a different
  transform group -- that the green-only bias didn't fully win). Reproduced with an
  inline-6, spin off, crank phases apart; verified clean afterward (cam animation +
  spin-on inline-6/V12), no new artifacts, no console errors.
- **Flywheel spoke/rim z-fighting fixed (user-reported, geometric).** The four
  points where the blue spokes meet the blue rim speckled with a hatched moire. It
  persisted after the crankshaft's depth fixes because it is blue-on-blue (one
  `matBlue` mesh -> `polygonOffset` can't separate it) and only `~`coplanar
  (different triangulations -> sub-ULP jitter, which `GL_LESS` doesn't resolve), so
  it needed a geometric change. Root cause + fix in Deviations: the spoke `+x` faces
  were coplanar with the rim tube's `+x` annular end-ring at `x=-1.5`; recessing the
  spokes' `+x` face 0.03 (x-extent `0.5 -> 0.47`) lets the rim ring occlude them.
  Diagnosed on a throwaway harness (headless Chrome, camera steered to the flywheel
  `+x` face from below so the block does not occlude it, crank frozen): the
  bottom-junction hatch was present before and gone after, the clean `-x` face was
  unchanged, and V8 / V12 / inline-6 spin-on renders showed no regression (green
  webs still solid, pistons/plugs/rods/block all render).

See also `dangerball.md` / `glknots.md` (siblings: rotator + wander, the pacing/
interpolation pattern, the `intensity=PI` / specular `/PI` lighting convention, and
`ColorManagement=false` for raw glColor).
