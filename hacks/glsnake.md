# glsnake -- design notes

Web port of xscreensaver's `glsnake` (Jamie Wilkinson, Andrew Bennetts, Peter
Aylett, 2002), `xscreensaver-6.15/hacks/glx/glsnake.c`. The "Rubik's Snake"
puzzle: `NODE_COUNT = 24` triangular prisms joined end-to-end by joints that
rotate in 90-degree steps. The snake holds a named SHAPE for `statictime` ms then
smoothly morphs (at `angvel`) to a random next shape, forever, while the whole
assembly spins on Y and Z. Segments are translucent with a 2-colour alternating
scheme. Self-contained three.js module: `start(canvas, opts) -> { stop, pause,
resume, getStats, reinit, config, params }`.

## Algorithm (how the .c works)

- **Nodes / shapes.** A shape is 24 joint angles, each `ZERO`/`LEFT`/`PIN`/`RIGHT`
  = `0`/`90`/`180`/`270` deg. `model[]` is a table of ~275 named shapes
  (`straight`, `ball`, `snow`, ... plus a long community list). `init` opens on
  `START_MODEL` (index 2, "snow").
- **Morph.** Every `statictime` ms (when not already morphing) it picks
  `RAND(models)` as the next shape and starts a morph. Each frame every joint eases
  toward `model[next]` by at most `iter_angle_max = 90*angvel*iter_msec/1000` deg,
  always the short way round (`fmod ..360`), snapping to the target when within
  reach; when all joints have arrived the morph ends.
- **Geometry (per node).** A fat triangular prism with bevelled corners/edges:
  `solid_prism_v` (18 verts) drawn as 6 corner triangles + 9 edge quads + 2 face
  triangles + 3 face quads, each face carrying one of the 20 `solid_prism_n`
  normals (renormalised by `GL_NORMALIZE`). One prism, reused 24x.
- **Placement.** `draw_glsnake` walks the snake: for each node it draws the prism,
  then applies `T(.5,.5,.5) . R(90,-z) . T(1+explode,0,0) . R(180+ang,x) .
  T(-.5,-.5,-.5)` to reach the next node. A first pass runs the same chain (with
  the `yspin`/`zspin` rotation but no scale) and grabs each node origin to compute
  the centre of mass, which the draw pass then translates by `-com` to recentre.
- **Colour.** `calc_snake_metrics` decides `is_cyclic`/`is_legal`; the colour
  scheme is green (cyclic), blue/indigo (acyclic or invalid), or -- with the
  (unexposed) `altcolour` -- purple+green. Two colours alternate node-to-node
  (`colour[(i+1)%2]`) and are cross-faded from the previous scheme to the next over
  the morph, weighted by `morph_percent`. Segments are translucent (alpha 0.6).
- **Spin.** `yspin`/`zspin` advance by `360*yangvel*iter_msec/1000` etc. -- pure
  wall-clock, frame-rate independent.

## Shared libraries used

`yarandom.js` (RNG -- `RAND(n) = (random()&0x7fffffff)%n`; the init draw order is
matched: one `RAND(models)` at init, then one per morph) and `hud-label.js` (the
shape-name caption, the web stand-in for `print_texture_label`). No `rotator.js`
-- glsnake spins via its own `yspin`/`zspin`, not a rotator. No jsm/addons -- the
prism is built directly.

## Faithful to the .c

- The **full model table** (275 shapes), extracted verbatim by a parser (not by
  hand): the four `#if 0` shapes are excluded exactly as the C compiles, and the
  two 23-entry stixpjr shapes (`begging dog`, `swan`) are zero-filled to
  `NODE_COUNT` as C aggregate initialisation does. `START_MODEL = 2` ("snow").
- The **prism** `solid_prism_v`/`solid_prism_n` and the exact display-list face
  winding (corner tris, edge quads, face tris/quads), vertex-for-vertex.
- The **joint chain** `T(.5,.5,.5) R(90,-z) T(1+explode,0,0) R(180+ang,x)
  T(-.5,-.5,-.5)`, applied cumulatively; the **two-pass centre-of-mass** recentre
  (pass 1 rotation-only, no scale, exactly as the C); the reshape
  `gluPerspective(25)` cam at `z=20`; the portrait-fit `glScalef(s,s,s)`.
- The **morph** loop (short-way ease, `fmod 360`, snap-when-within-reach),
  `statictime` hold, `start_morph` + `calc_snake_metrics` (`cross_product`,
  `getScalar`, the 25^3 legality grid, `is_cyclic`), the `morph_percent`-weighted
  `morph_colour` cross-fade, and the exact colour table + alternating
  `colour[(i+1)%2]`.
- Rendering state: translucent alpha `0.6`, `GL_BLEND`
  (`SRC_ALPHA, ONE_MINUS_SRC_ALPHA`) -> three `NormalBlending` transparent; **depth
  writes ON** and **no depth sort** (the C never sorts and leaves depth-write on),
  so the 24 prisms self-occlude in draw order; **culling off** -> `DoubleSide`. Two
  white lights (from `(0,10,20)` and `(0,20,-1)`, `w=0` => directional) + GL's
  default `0.2` global ambient; dim specular `{0.1}`, shininess `20`.
  (`THREE.ColorManagement.enabled = false` -> raw glColor; light `intensity = PI`
  cancels three's `1/PI` Lambert, specular `/PI` per the sibling-port convention.)

## Deviations / deliberate choices

- **No depth sort + `depthWrite: true` (faithful, not the three default).** three
  defaults transparent objects to `depthWrite:false` + a back-to-front sort; the C
  does neither. We set `renderer.sortObjects = false`, add the 24 meshes in node
  order, give each `renderOrder = i`, and keep `depthWrite:true`, reproducing the
  original's order-dependent blend and self-occlusion exactly (verified: the
  translucent prisms occlude one another the same way the reference screenshot
  does).
- **Two directional lights at `intensity = PI` each.** The C's two `GLfloat[3]`
  light positions are read by GL as 4-vectors with `w = 0` (the 4th float falls off
  the array -> `0`), i.e. directional. Both diffuse white; kept at `PI` each (the
  family convention), which matches the reference brightness (blue stays deep,
  whites bright but not blown). Spot direction/cutoff are never enabled, so they're
  plain directional lights.
- **Prism built as one non-indexed `BufferGeometry`** (per-face normals, so shared
  positions carry different normals across faces) rather than a GL display list;
  same 32 triangles, same normals. Pushed via `Float32BufferAttribute` (arrays
  sized `count*3` implicitly -- avoids the truncation trap).
- **Wireframe = `material.wireframe` on the bevelled solid geometry**, not the C's
  separate simpler `wire_prism` line list (which also drops lighting). Wireframe is
  a debug toggle; rebuilding a second geometry/material for it wasn't worth it.
  Minor.
- **`morph_percent`'s `if (rot > 180) rot = 180 - rot` is transcribed verbatim**
  (yes, that yields a negative `rot` for a 270-deg model delta -- a quirk of the
  original). It only feeds the colour cross-fade weight, and the `isnan/isinf`
  guard (`rotMax == 0` -> `1.0`) is reproduced with `Number.isFinite`.
- **Label font.** `labelfont` is `"sans-serif 18"`; we call the shared
  `hud-label.js` with `{ family: 'sans-serif' }` and no `fontUrl` (nothing bundled
  -- the apollonian precedent). The helper always backs the label with its own
  neutral default face (Luxi Mono) regardless, so the caption renders in that
  legible mono face -- the same as `engine`'s label. White text, top-left corner
  (`print_texture_label` position 1, `glColor4f(1,1,1,1)`), outline on.

## Pacing / OVERHEAD

glsnake's motion is **wall-clock-based in the .c**: `yspin`/`zspin` and the joint
morph all scale with `iter_msec` (real ms since the last iteration), so the effFps
term cancels. We render every rAF and advance `frames = dt*effFps` original-frames
by the per-frame turn `360*ang/effFps` (== `360*ang*dt` == the C's
`360*ang*iter_msec/1000`), which is delay-independent -- exactly as the C, where
`delay` sets only frame cadence, not motion rate. The `statictime` hold runs off
`now` (wall-clock ms). **`OVERHEAD = 37500`** -- the GL family's shared default
(live GL is unmeasurable under this machine's XQuartz Apple-DRI block); it drops
out of the motion math here but is kept for family consistency and the host's
framerate readout. `dt` is clamped to `0.25 s` so a backgrounded tab doesn't jump
the morph/spin.

## Config (params transcribed 1:1 from hacks/glsnake.xml)

`delay` (Frame rate, 0-100000, def 30000, invert) - `duration` (statictime,
1000-30000, def 5000) - `packing` (explode, 0.0-0.5, def 0.03) - `angvel`
(0.05-5.0, def 1.0) - `yangvel` (0.0-1.0, def 0.10) - `zangvel` (0.0-1.0, def
0.14) - `labels` (Show titles, def false) - `wire` (Wireframe). `showfps` skipped
(the host has its own readout). All are live. `altcolour`/`zoom`/`interactive` are
command-line-only DEFs with no xml UI, so they stay internal constants.

## Omissions

- **Trackball / mouse / `interactive` mode** (`gltrackball_*`, node selection, the
  yellow-highlighted selected pair): the host hacks aren't interactive
  (`pointer-events:none` overlay), so the modelview omits the identity trackball
  term and `interactive` is fixed off (the `!interactive` branches always taken).
- **`altcolour`** (the `-altcolour` "authentic" purple+green scheme) and **`zoom`**
  have no xml UI knob, so they stay at their defaults (off / 25). The colour table
  and cyclic/acyclic/invalid selection are fully implemented.
- **`do_fps` / `showfps`** and the `MAGICAL_RED_STRING` debug centre-line (compiled
  out, `#if 0`).

## Structural / correctness self-review

Verified against ground truth (bundled `XScreenSaver_ Screenshots_files/glsnake.jpg`
+ demo video `youtube AIqz-G0n1JU`) via the cached headless-Chrome rig on a throwaway
harness (removed; not committed). Because chrome's virtual-time budget does not
advance the rAF timestamp (the port's clock), a second harness overrode
`requestAnimationFrame` and pumped frames with a virtual 33 ms/frame clock to
fast-forward past the 5 s hold into a morph.

- **"snow" (the START_MODEL, cyclic)**: renders as a translucent green+white prism
  snowflake ring, alternating colours, visible self-occlusion, "snow" label
  top-left -- green because `calc_snake_metrics` flags it cyclic, exactly as the C.
- **morph -> "double helix" (acyclic)**: after fast-forwarding, the snake had
  morphed to a new random shape, the label updated, and the scheme switched to the
  indigo/blue `(0.3,0.1,0.9)`+white acyclic colours -- matching the reference
  screenshot's deep-blue/grey translucent prisms, bevels, and lighting. Confirms
  morph, label update, cyclic vs acyclic colour, and Y/Z rotation (new orientation).
- The prism silhouette, bevelled corners/edges, translucency, and two-tone
  alternation match the reference `glsnake.jpg` closely; the camera
  (`gluPerspective(25)` at `z=20`) + com-recentre + portrait-fit are transcribed
  exactly, so on-screen scale is faithful.

See also `engine.md` (sibling GL port: same `hud-label.js` caption + the light
`intensity=PI` / specular `/PI` convention + the `matrixAutoUpdate=false` baked-
matrix pattern) and `glknots.md` (the pacing/effFps identity and the
non-indexed-BufferGeometry face-normal build).
