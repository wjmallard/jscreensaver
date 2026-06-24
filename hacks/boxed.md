# boxed -- design notes

Web port of xscreensaver's `boxed` (Sander van Grieken, 2002),
`xscreensaver-6.15/hacks/glx/boxed.c` (+ the embedded floor texture
`xscreensaver-6.15/hacks/glx/boxed.h`). A box full of 3D bouncing balls that fall
under gravity, bounce on a green textured floor and off four wireframe walls, collide
with one another, and -- when a ball drifts up and over a wall ("offside") and then
lands -- EXPLODE into ~400 little triangle shards that scatter, bounce, flash white
and vanish, after which a fresh ball drops in. A slow camera orbits the whole scene.
Self-contained three.js module: `start(canvas, opts) -> { stop, pause, resume,
getStats, reinit, config, params }`.

## Algorithm (how boxed.c works)

Per frame, `draw()` runs the whole simulation once, then renders:

- **`updateballs()`** -- for every ball: `dir.y -= 0.30*speed` (gravity); `loc += dir`.
  The floor is `y=0`; a ball bounces when `loc.y < radius` (reflect `loc.y` above the
  floor, negate `dir.y`). Four walls sit at `x,z = +/-20`: reaching a wall reflects the
  ball, *unless* the ball is above the wall top (`y > 41+radius`), in which case it goes
  **offside** (`offside=1`) and stops colliding with walls -- it escapes over the top.
  An offside ball that later lands sets `bounced=TRUE` (it will explode) and its `dir`
  is damped `*0.80` on each floor hit until it is slow enough to **respawn**
  (`createball`). A field boundary at `+/-95` catches balls that fell far outside
  (respawn if `y < -2000`). Balls also collide with each other in an O(n^2) pass that
  exchanges velocity along the line of centres, then walks both balls forward until
  they no longer overlap (`squaredist = rb^2 + rj^2`, a deliberately loose test).
- **`createtrisfromball()`** -- the ball's 400-triangle unit sphere becomes 400 shards.
  For each triangle: centroid `c = (v0+v1+v2)/3`; the 3 verts are recentred on `c` and
  scaled by `2*radius`; the shard's start `loc = ball.loc + c`; its velocity is
  `c*explosion + jitter + ball horizontal momentum`, where
  `explosion = 1 + (floor(cfg.explosion)/15)*2*rnd` and `momentum = cfg.momentum`. The
  shard normal is `c` (left **unnormalized** in the `.c`).
- **`updatetris()`** -- per shard: `dir.y -= 0.1*speed` (a *weaker* gravity than the
  balls'); `loc += dir`; bounce on the floor (`*0.80` damp) while inside `+/-95`, else
  mark `far` (freefall out of frame, no more collisions). Any shard inside the box
  footprint (`+/-21`) is pushed back **out** against its nearest wall. Each tick, with
  probability `decay`, a live shard begins to vanish: `drawtriman()` then draws it
  **white** (diffuse 1, emission 0.8) for 3 frames (`gone` 1->4) before dropping it.
- **camera** -- a slow orbit: `r = 150 + 115*cos(...)`, `eye = (r*sin, 80*sin+81.6,
  r*cos)`, `centre = (30*sin, (80*sin+81.6)/10, 30*sin)`.

## Faithful to the .c (transcribed, not tuned)

The physics is a line-by-line transcription -- the constants are NOT tuned by eye:

- **Gravity** 0.30*speed (balls) / 0.10*speed (shards); **restitution/damping** 0.80 on
  every offside-ball and shard floor bounce; **movement** is `loc += dir` per tick.
- **createball()** exactly: `loc=(5-10r, 35+20r, 5-10r)`, `dir=((.5-r)*speed, 0,
  (.5-r)*speed)`, `radius=ballsize`; colour rolled until `r+g+b >= 1.8` (bright); at
  init `loc.y *= rnd()` to scatter the drop heights.
- **Wall/offside logic** and the `41+radius` clearance height; the field `+/-95`, box
  `+/-20`, and shard-repel `+/-21` bounds; the `< -2000` respawn.
- **Ball-ball collision** verbatim, including the post-resolve "walk apart" loop
  (bounded here by a 1000-iteration guard the `.c` omits -- see Deviations).
- **generatesphere()** verbatim (MESH_SIZE 10 -> 202 vertices, 1200 indices, 400 tris),
  so the ball geometry *and* the explosion's shard set are the exact same triangles the
  `.c` uses. Ball normals = the unit vertex positions (as the `.c`'s `glNormal3f`).
- **Explosion** verbatim: the `1 + tman.explosion*2*rnd` force, the `(0.1-0.2r, 0.15-0.3r,
  0.1-0.2r)` jitter, the ball-momentum add, the `2*radius` shard scale, the recentre-on-
  centroid, and the flat `c` normal.
- **decay remap** from `pinit()`: `d <= 0.8182 ? d/3 : (d-0.75)*4`; **explosion** per
  triman = `floor(cfg.explosion)/15` (the `(int)` cast is preserved).
- **Colours** (raw glColor, no colormap here): floor grid `(0.1,0.1,0.6)` blue, walls
  `(0.2,0.5,0.2)` green, floor plate texture MODULATE-d with white. Ball material:
  diffuse `color`, emission `0.5*color`, specular/ambient black, shininess 5. Shard
  material: diffuse `color`, emission `0.3*color`; white flash diffuse 1, emission 0.8.
- **Lighting**: LIGHT0 = white positional at the box floor centre `(0,0,0)`, LIGHT1 =
  half-grey directional from above `(0,1,0)`; **no ambient term** (both lights' ambient
  0, material ambient black, and `0.2*0 = 0`). `glShadeModel(GL_SMOOTH)`.
- **Camera** verbatim, **including the bug**: `gluLookAt` is passed `v2.x` for BOTH the
  x and z of the look-at centre (`v2.z` is computed but never used). Projection
  `gluPerspective(50, w/h, 2, 1000)` + the reshape portrait squish
  (`glScalef(s,s,s)`, `s = w<h ? w/h : 1`), premultiplied onto the projection matrix.

### The GL_NORMALIZE detail (why the balls are emission-dominated)

boxed does **not** `glEnable(GL_NORMALIZE)` (confirmed: it is absent from `boxed.c` and
from any shared init; 78 *other* GL hacks enable it, boxed is not one). A ball is drawn
with `glScalef(radius,radius,radius)`, so its unit vertex normals are shrunk to length
`1/radius` in eye space and GL lights them un-normalized -> the ball's **diffuse term is
attenuated by `1/radius`** (at the default radius 3, diffuse is 1/3 strength; bigger
balls are darker on the lit side). three re-normalizes normals in-shader, so we cannot
get this from the normals; instead we bake `1/radius` into the ball's **diffuse albedo**
(`material.color = color/radius`) and keep the **emission** at the full `0.5*color`. A
ball then ranges from `0.5*color` (unlit) to ~`1.0*color` (fully lit) -- exactly the
`.c`'s range, and the reason the balls read as saturated-but-emission-glowing rather
than washed-white. Shards are *not* scaled by radius in the `.c`, so their diffuse is
left at full strength (their `c` normal has magnitude ~0.95, a <5% effect, ignored).

## Deviations / deliberate choices

- **Floor texture is procedural, not the boxed.h blob.** The `.c` bakes a 256x256 green
  noise texture into `boxed.h` (a 262 KB GIMP `HEADER_PIXEL` string). Rather than inline
  a quarter-megabyte blob, `boxed.js` regenerates its **look**: the decoded texture is a
  clean **linear radial green gradient** (`G ~= 251 - 0.9*r` from a bright ~250 centre to
  ~90 at the corners) plus fine grain and a faint warm tint (measured means RGB
  14.6 / 162.9 / 2.1). All three numbers were **measured off the real decoded blob**
  (`scratchpad` decoder), not chosen by eye. Uploaded as a `DataTexture` with
  `NearestFilter` (GL_NEAREST) + `RepeatWrapping` (GL_REPEAT), MODULATE-d with white via
  an unlit `MeshBasicMaterial` -- identical pipeline to the `.c`. A deterministic hash
  supplies the grain so the port's `yarandom` stream stays aligned with the `.c`'s. The
  drawfilledbox texcoords are transcribed exactly (only the TOP face uses the full
  texture; every other face samples the bottom edge row, `v=1`).
- **sRGB output.** `THREE.ColorManagement.enabled = false` (module scope) is kept as the
  GL-family convention, but note that in three r160 this still applies sRGB **output**
  encoding -- and that is correct here: the bundled screenshot is itself sRGB-encoded
  (its wall pixels measure `(124,188,124) = sRGB(0.2,0.5,0.2)`), and the port matches it
  exactly (walls `(124,188,124)`, grid `(89,89,203) = sRGB(0.1,0.1,0.6)`, bright-green
  floor). Light `intensity = PI` cancels three's `1/PI` Lambert; specular is black so
  nothing blows out.
- **Shard render split: two geometries, not per-triangle glColor.** The `.c` re-issues
  `glColor`/`glMaterialfv` mid-`glBegin` to draw the occasional white-flashing shard.
  Here each triman owns two `BufferGeometry`s -- a coloured one (`emission 0.3*color`)
  and a white one (`emission 0.8`, shared material) -- and each physics tick sorts every
  live shard into one or the other (respecting the `gone` 0 / 1..3 / >3 lifecycle) by
  rewriting the position/normal buffers + `setDrawRange`. Same pixels, GL-free.
- **Per-fragment (Phong) vs per-vertex (Gouraud).** The `.c` is `GL_SMOOTH` Gouraud
  (per-vertex); three's `MeshPhongMaterial` is per-fragment. Smoother, same model.
- **Rendering interpolation for smoothness.** The discrete ball/shard physics ticks at
  `effFps` (see Pacing); ball positions are linearly interpolated between the previous
  and current tick each rAF so motion is smooth at 60 Hz. A teleport guard (jump > 6
  units) snaps instead of interpolating, so a respawn or a collision "walk-apart" never
  streaks. Shards are *not* interpolated (they are transient debris and there can be
  thousands) -- they redraw at tick cadence. The camera is a smooth continuous function
  of `tic`/`camtic`, advanced every rAF (not stepped), so the orbit is perfectly smooth.
- **Collision loop guard.** The `.c`'s post-collision "walk until separated" `while` has
  no iteration cap; the port bounds it at 1000 (it separates in a handful of steps in
  practice) so a browser tab can never hang. Not reachable in normal play.
- **Wireframe mode** toggles `material.wireframe` on every material (balls, shards,
  floor); the grid/walls are already `LineSegments`. The `.c`'s wire path also disables
  lighting; here the lit materials just render as wireframe -- a minor, secondary-mode
  difference (boxed is meant to run solid).

## Pacing / OVERHEAD

`OVERHEAD = 37500` (the shared GL-family default -- live GL hacks can't be timed under
this machine's XQuartz Apple-DRI block). xml `delay = 15000` ->
`effFps = 1e6/(15000+37500) ~= 19 fps`. The frame-locked physics therefore advances at
19 ticks/s (interpolated to 60 Hz for display). Because the integration is per-tick
(`dir += gravity` each tick), the real-time briskness scales with `effFps`; at 19 fps
the motion is a touch calmer than a 60 fps original would be -- an inherent property of
porting a frame-locked hack under the pacing convention, not a tuning choice.

## Config (params transcribed 1:1 from hacks/boxed.xml)

`delay` (invert), `speed` (0.001-4.0, default 0.5), `balls` (3-40, default 20),
`ballsize` (1-5, default 3), `explosion` (1-50, default 15), `decay` (0-1, default
0.07), `momentum` (0-1, default 0.6), `wire`. Ranges/defaults/labels/low-high labels
mirror the xml. The xml's `showfps` boolean is intentionally omitted -- that is the
host's own frame-rate readout. `config` is initialised from these defaults (not from
`param.default`). `delay`/`speed`/`wire` are live every frame; `explosion`/`decay`/
`momentum` are read live at each new explosion; `ballsize` is picked up by each new
ball; a change to the ball **count** rebuilds the sim in place (`initSim`). Clamps
(`balls` 3..40, `ballsize` 1..5, `explosion` 0..50, `decay` 0.02..0.90, `momentum`
0..1) mirror `setdefaultconfig()`.

## Shared libraries used

- `hacks/yarandom.js` -- `frand(1)` is boxed's `rnd()`. RNG *call order* matches the
  `.c`'s `pinit` (all balls' `createball` + `loc.y*=rnd()` first, then the six camera-
  path rolls) so a pinned seed would reproduce the same layout. The floor grain uses a
  separate deterministic hash so it does not perturb this stream.

## Correctness self-review

- `node --check hacks/boxed.js` passes; `LC_ALL=C grep -nP "[^\x00-\x7F]"` is empty (the
  `µs` unit label is the only non-ASCII, escaped).
- Verified headless (chrome-headless-shell over CDP, 1280x720) against the bundled
  screenshot: blue tessellated grid, green radial floor plate, green wireframe cage,
  colourful balls, and live explosions (colored shards scattering + white flashes) all
  present and correctly placed (explosions occur *outside* the box, where offside balls
  land). Colour pipeline confirmed pixel-exact on the walls/grid/floor. Exercised the
  untested paths (wireframe toggle, live `balls` 20->5->38 reinit, `ballsize` change,
  `reinit`, pause/resume) with no exceptions.
