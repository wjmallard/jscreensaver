# blinkbox -- design notes

Web port of xscreensaver's `blinkbox` (Jeremy English, 2003; motion blur added 2005 by
John Boero), `xscreensaver-6.15/hacks/glx/blinkbox.c`. A glossy ball bounces around
inside a large invisible box. The six walls are tiled and the tiles are normally
invisible; when the ball strikes a wall, ONE tile lights up at the impact point in that
wall's color (left=red, right=green, top=blue, bottom=orange, front=yellow, back=purple)
and then fades out over 20 frames. The ball is drawn with a motion-blur trail, and the
whole box slowly tumbles. Self-contained three.js:
`start(canvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }`.
**Asset-free.** RNG is `yarandom.js` (the bounce re-randomization); no colormap (the
tile colors and the white ball are fixed).

## Faithfulness (the rule: do NOT deviate from the algorithm)

Transcribed verbatim from the .c:

- **Bounding box** `bbox = {top:(14,14,20), bottom:(-14,-14,-20)}`. The ball starts at the
  origin (the struct is `calloc`'d) with motion `mo=(1,1,1)`, hold `moh=(-1,-1.5,-1.5)`,
  and collision radius `d=1`.
- **Collision** runs `hit_top_bottom` (y), `hit_front_back` (z), `hit_side` (x) in that
  order each frame, BEFORE the move. A wall is struck when `ball +/- d` crosses it. On a
  hit: mark that side, copy the current ball position as the impact point, set
  `counter=MAX_COUNT(20)`, `alpha_count=0`, `des_count=1`, and `swap_mov()` the axis --
  swap `mo<->moh` for that axis, then re-roll the new `mo` magnitude to 1 or 2
  (`1 + random()%2`) keeping its post-swap sign. That is the bounce: direction flips and
  speed re-randomizes per axis, per hit.
- **Tiles** are a unit cube (`-1..1`) rotated 90deg about the wall's axis to lie flat on
  the wall (`glRotatef(90, ...)`: y-axis for left/right, x for top/bottom, z for
  front/back), translated to the impact point and scaled `(boxsize, boxsize, 0.25)`. The
  per-side `bpos` swizzle of the stored impact position and the `CheckBoxPos` in-plane
  clamp (keeping the tile from hanging off the wall edge) are transcribed exactly, case by
  case. With `do_fade` (default on) the tile alpha is `1 - 0.05*alpha_count`, fading over
  20 frames; with `do_dissolve` (default off) the in-plane scale also shrinks to zero
  (`boxsize - (boxsize/20)*des_count`).
- **Ball**: `unit_sphere(16,12)` -> `SphereGeometry(1, slices=12, stacks=16)` (low-poly on
  purpose -- the original's visible banding), scaled x2. With `do_blur` (default on) the
  `blur_detail=24` ghost copies are stepped `mo/24` along the velocity, each with alpha
  `sin(PI*i/24)/24` -- a half-sine envelope (dim at the ends, brightest mid-trail). The
  position swizzle, the per-side colors, the rotation axes, and the alpha profile are all
  verbatim.
- **Camera / scene**: `gluPerspective(30, w/h, 1, 100)` + `gluLookAt((0,0,40),(0,0,0),
  up(0,2,10))`. The scene tumbles `0.25deg` about each of z, y, x EVERY frame -- the .c
  applies these `glRotated` calls to the persisting modelview (no reload), so they
  accumulate; reproduced as the box group's quaternion post-multiplied by
  `Rz(.25)*Ry(.25)*Rx(.25)` each tick. The whole thing is scaled by
  `s = (w<h ? w/h : 1) * 0.5` (the reshape portrait-fit).

The tile counters step once per frame in the .c's draw loop just AFTER a tile is drawn;
we run `stepTiles()` at the START of a tick so a freshly-hit tile renders one full-bright
frame (`alpha_count` 0) before it begins to dim -- matching the .c order `draw(alpha_count)`
then `alpha_count++`.

## The look: a LIT + ADDITIVE hybrid, and the color-management trap

This hack is the unusual case the lessons flag: it is **LIT** *and* **ADDITIVE** at once.
The .c keeps `GL_LIGHTING` on (one positional white light, `GL_LIGHT1` at `(20,100,20)`,
no attenuation; `GL_COLOR_MATERIAL` so `glColor` is the ambient+diffuse albedo) so the
ball and tiles are SHADED. But with fade/blur on (the defaults) it ALSO enables
`GL_BLEND` with `glBlendFunc(GL_SRC_ALPHA, GL_ONE)` (additive) and DISABLES the depth
test -- so every shaded fragment is multiplied by its alpha and ADDED to the framebuffer.

Reproduced with `MeshLambertMaterial` (LIT; **no specular** -- only `GL_LIGHT1` is enabled
and its specular defaults to BLACK, and `GL_LIGHT0` is never enabled) under
`AdditiveBlending`, `depthTest:false`, `depthWrite:false`. Lights follow the family
convention: `PointLight(white, intensity=PI, decay=0)` at world `(20,100,20)` (the
`PI` cancels three's `1/PI` Lambert so diffuse = `albedo*N.L` like GL; `decay=0` = GL's
no-attenuation), plus `AmbientLight(white, 0.2*PI)` (GL global ambient 0.2 x the
`COLOR_MATERIAL` albedo). The light is added to the SCENE, not the tumbling group: the .c
specifies it under the view matrix in `init` (so it is fixed in eye space while the box
tumbles), which is equivalent to a world-fixed light here.

**The trap (same as cubestack, applied to a lit hack):** GL has no color management -- it
blends and writes the raw lit values in display space. three.js defaults to blending in
LINEAR space with an sRGB output gamma, which would re-curve every additive sum. The fix
is the same: `renderer.outputColorSpace = THREE.LinearSRGBColorSpace` and author all
colors RAW (`new THREE.Color(r,g,b)` stores them as-is; no `setRGB(..., SRGBColorSpace)`).
Then the lit values accumulate and display exactly as GL writes them. This is correct for
a lit hack here precisely BECAUSE GL applies no output gamma either -- the `N.L` lighting
math is color-space-independent; only the final encode differs, and we drop it to match
GL. The white ball trail glows to white in its overlapping core; the saturated tile colors
stay saturated (a fresh blue tile reaches full `(0,0,255)`, a faded/steeply-angled one
reads dim, exactly like the original). Scoped per-renderer (disposed on `stop()`), so the
other LIT geometry hacks are unaffected.

## Pacing / config

The .c is a DISCRETE per-frame sim (ball moves by `mo`, tile counters step, tumble
accumulates -- all once per frame). We tick it at `effFps = 1e6/(delay + OVERHEAD)`,
`OVERHEAD = 37500` (xml default delay 30000 -> ~15fps; the geometry-track family default),
and interpolate the ball position (`lerp(prev,cur,f)`) and the tumble (`slerp`) between
ticks so the render is smooth at any rAF rate. The motion-blur trail is anchored at the
interpolated base and spans the current `mo`, so it slides forward smoothly between ticks.
**OPEN:** `OVERHEAD` is the family default, not a per-hack measurement; pin against the
demo video (youtube `lgjbHMcSd8U`) if pacing reads off.

Config transcribed 1:1 from `hacks/config/blinkbox.xml`: `delay` (Frame rate, invert),
`boxsize` (Box size, 1..8, the tile size -- live, clamped like the .c), `fade`
(Motion-blur tile fade), `blur` (Motion blur), `dissolve` (tiles shrink as they fade),
`wire` (Wireframe). `boxsize` rescales the unit-cube tiles live (no geometry rebuild).

## Deviations / omissions

- **Ball culling.** The .c does not cull, so it draws both hemispheres of the additive
  sphere; we use `side: FrontSide` for the ball to keep the clean shaded front gradient +
  stack banding seen in the screenshot (DoubleSide would flip the back-face normals and
  over-light the back hemisphere, washing out the gradient). Net effect: the absolute peak
  brightness is moment-dependent (it tracks the random `mo` magnitude -- a just-bounced
  tight trail piles all 24 ghosts onto one spot and reaches white, a fast spread-out trail
  is dimmer). Verified the peak brackets the ground truth (my captures peaked 161 and 255
  vs the GT's 224). Tiles use `side: DoubleSide` (faithful no-cull for the thin slab).
- **Tile normals.** The .c's `unit_cube` has a couple of unnormalized/odd face normals; we
  use a clean `BoxGeometry`. Irrelevant in practice -- the thin additive slab reads as a
  glowing colored rectangle with dim depth-edges either way (matches the GT).
- **Per-fragment clamp.** GL clamps each fragment's lit color to `[0,1]` before the alpha
  multiply; three's float pipeline clamps only at the 8-bit write. So an over-bright lit
  fragment (`>1`) contributes slightly more per ghost than GL before the additive sum
  saturates. Sub-perceptual for a white ball over black.
- **Wireframe** toggles `material.wireframe` on the lit additive meshes -- a close
  approximation of the .c's separate non-lit `GL_LINE_LOOP` path (a rare debug view).
- **Non-default blend combos.** The default (fade+blur on) drives depth-test-off +
  additive throughout, transcribed faithfully. The rare all-blending-off opaque/
  depth-tested mode is approximated (we keep the additive path; `blur` off just shows a
  single ball, `fade` off keeps tiles full-bright for their 20 frames).

Verified by CDP capture vs `blinkbox.jpg`: the shaded glowing motion-blurred ball, the
per-wall colored tiles (red/green/blue/orange/purple) with dim 3D depth-edges flashing on
impact and fading, the slow tumble, all over black. Tile and ball brightness ranges match
the ground truth in character (exact positions differ -- the bounce sequence is random per
run and the capture moment differs, so no pixel match is expected).

See also: `cubestack.md` (the additive color-management trap), `dangerball.md` (the LIT
family convention); the `glx-geometry-track-triage` + `framerate-calibration` memories.
