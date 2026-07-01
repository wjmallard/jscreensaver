# cube21 -- port notes

Port of `xscreensaver-6.15/hacks/glx/cube21.c` (Vaclav "Vasek" Potocek, 2005) to a
self-contained three.js module, `hacks/cube21.js`. Visual ground truth:
`XScreenSaver_ Screenshots_files/cube21.jpg` and jwz's demo video
(`https://www.youtube.com/watch?v=AFtxL6--lTQ`).

## What it is

The "Cube 21" / "Square-1" shape-shifting puzzle. A cube whose top and bottom layers
are sliced into wedge pieces: 30deg "narrow" (edge) pieces and 60deg "wide" (corner)
pieces. Each layer has 12 unit slots (= 360deg); a solved layer is 4 wide + 4 narrow
alternating. Moves: (1) rotate the top or bottom layer by a multiple of 30deg (only
amounts the current cut allows), or (2) cut the cube through a vertical plane and flip
one half 180deg about a horizontal axis -- so the solid morphs between shapes. Moves
are chosen at random, separated by pauses; the whole object spins and wanders.

## Algorithm (transcribed operation-for-operation)

**Puzzle model** (`cube21_conf`):
- `pieces[2][13]` -- per side (0 top, 1 bottom) a narrow(1)/wide(0) flag per slot.
  Drawing reads `pieces[s][i+1]` (slots 1..12); `find_matches` reads 1..5 and 7..11;
  `rot_face` shifts 0..11; `rot_halves(s=1)` touches index 12. These asymmetric index
  ranges (and the fact that `pieces[0][12]` is never written after init) are the .c's,
  reproduced verbatim -- the moves preserve the "each half = 6 slots = 180deg"
  invariant that makes the ring draw consistently.
- `cind[5][12]` -- colour indices: rows 0/1 = top face (piece top / side), 2/3 = bottom
  face, 4 = middle band (never shuffled). `rot_face(s)` cyclically shifts rows 2s,2s+1;
  `rot_halves` swaps rows 0<->2, 1<->3 with the reversal + `k--` offset from the .c.
- `colors[6][3]` -- the RGB palette.

**Moves**: `find_matches` (valid rotation amounts = the found `i` in 1..5, their `i-6`
complements, and 6), `rot_face`, `rot_halves`, `randomize` (SHUFFLE=100 iterations of
face-rotate + half-flip), and the `finish()` state machine
(PAUSE1 -> ROT_TOP/BOTTOM [-> maybe the other face] -> PAUSE2 -> HALF1/HALF2 -> PAUSE1)
are ported expression-for-expression, including the `s = cp->rface` assignment inside
the `rot_face` call, the `ramount==6 && coin -> -6` flip, and the switch fall-through.

**Geometry**: `draw_narrow_piece` / `draw_wide_piece` / `draw_middle_piece` are
transcribed vertex-for-vertex with the exact `posc[]`/`texp`/`texq`/`TEX_GRAY`
coordinates, per-face normals (`COS15`,`SIN15`,`COS30`,`SIN30`) and texcoords. Each
piece ends with a `glRotatef(30|60, z)`, so a half accumulates exactly 180deg and a
face 360deg; `draw_half_face` walks slots emitting narrow/wide, `draw_middle` places
the two middle halves with the `hf[]` y-flips, and `draw_main`'s per-state
`glRotatef(theta, ...)` sub-rotations (incl. the HALF1->HALF2 fall-through and its
inner `+/-theta` y-rotation) are reproduced exactly.

**Texture** (`make_texture`): the 128x128 `GL_LUMINANCE` line-art -- `draw_horz_line`,
`draw_vert_line`, `draw_slanted_horz`, `draw_slanted_vert` (parabolic `w = d^2*255/9`
soft edge over +/-BORDER, `min`-blended into a 255 background) and the 3x3 value-100
gray dot at (0.7,0.7) -- reproduced with the same **integer** arithmetic (`Math.trunc`
for every C integer division). Uploaded as an RGBA `DataTexture` (R=G=B=L), row 0 = v0
(matching `glTexImage2D`), `CLAMP_TO_EDGE` + `LINEAR`, no mipmaps (the .c's `MIPMAP`
path is `#undef`'d -- "It doesn't look good"). The gray-dot at texcoord (0.7,0.7) is
what makes the between-piece "inner" faces read as ~0.39 gray.

**Colour modes** (`parse_colmode` + `init_cp`): white / one-random / silver /
two-random / classic / six-random; default "six". `rndcolor() = frand(0.5)+0.3`
(channels in [0.3,0.8) -- the muted palette). The fixed `ce_colors` and the
`0.2+0.7*c` classic transform, and every `cind` index formula
(`((j+5)%12)>=6?1:0` and `((j+5)%12)/3`), are copied exactly.

## Shared libraries

- `yarandom.js` -- `random()` / `frand()`, used for the shuffle and the palette. The
  shuffle is random per run (no deterministic reference to match), so RNG call order is
  followed for cleanliness but isn't visually load-bearing here.

## Rendering approach (deliberate, faithful)

The .c draws in OpenGL immediate mode with a mutating modelview. The port emulates that
directly: a single `THREE.Matrix4` mutated by `rotate`/`translate`/`scale` (and undone
manually, as the .c does with `glRotatef(-theta)`), plus an immediate-mode emitter
(`glBegin`/`glNormal`/`glColor`/`glTexCoord`/`glVertex`) that bakes every vertex into
**eye space** and appends to a non-indexed `BufferGeometry` (triangles every 3 verts,
quads -> 2 triangles). The whole puzzle is ~600 triangles, so it is rebuilt **every
frame**, baking ALL transforms (spin, wander, object placement, and the per-move
sub-rotations) into the vertex/normal buffers. The camera then carries only the
projection (`gluPerspective(30)`, eye at the origin looking down -z). This is the most
direct transcription and avoids decomposing the intricate half-flip transform tree into
scene-graph groups.

- **Lighting**: two directional lights fixed in eye space at (1,1,1) and (-1,-1,1)
  (the .c sets `GL_POSITION` under an identity modelview, so they don't rotate with the
  object -- reproduced by putting them in world space with the camera at the origin),
  diffuse 1, per-light ambient 0; global ambient 0.1; `GL_COLOR_MATERIAL` -> per-face
  vertex colours drive ambient+diffuse; material specular 0.2, shininess 20. Light
  intensity = PI, specular /PI, ambient *PI (the repo's three-lighting convention).
- **GL_FLAT**: one `glNormal` per face -> the port stores that exact normal on every
  vertex of the face and uses `flatShading:false`. That is genuinely flat (constant
  normal across the face) AND winding-independent (three's `flatShading:true` recomputes
  a geometric normal whose sign depends on winding -- avoided here).

## Deviations / deliberate choices

- **GL_MODULATE vs three `map`**: three's `map` multiplies (ambient+diffuse) by the
  texture but NOT the specular; the .c's `GL_MODULATE` multiplies the *whole* lit colour
  (incl. specular). So on a black outline pixel three leaves the weak (0.2) specular
  where GL zeroes it. With such weak, single-light specular the outlines still read
  black; the dominant (diffuse+ambient) term is modulated exactly. Not fixable with a
  stock material without a custom shader; accepted.
- **Second light's specular**: the .c sets `LIGHT1` diffuse but leaves its specular at
  the GL default (0,0,0), so only `LIGHT0` adds specular. three can't disable specular
  per light, so `LIGHT1` contributes a little extra (weak) specular. Accepted.
- **No `GL_CULL_FACE` in the .c** -> `side: THREE.DoubleSide`. The puzzle is opaque and
  depth-tested, so only front faces show; DoubleSide additionally guards against any
  winding mistake leaving a hole. (three flips normals for back faces under DoubleSide,
  vs GL's single-sided lighting, but back faces aren't visible.)
- **Wireframe**: the .c returns from `init_gl` before enabling lighting/texture and
  draws flat 0.7-gray `GL_LINE` quads. The port swaps to an unlit `MeshBasicMaterial`
  (0.7 gray, `wireframe:true`). Because the geometry is triangulated, three's wireframe
  shows the quad diagonals that `GL_LINE` on real quads would not. Minor, non-default
  mode; left as-is (a separate edge-only `LineSegments` wasn't worth it).
- **Live colormode / start change** re-inits the puzzle (regenerates palette + colour
  layout + reshuffle), mirroring the .c's `init_cp`. tex/wire/spin/wander/speeds are
  read live each frame with no reinit. (`change_cube21` in the .c only re-runs
  `init_gl`; a full reinit is the sensible host behaviour for a structural knob.)
- **Trackball** (`gltrackball_rotate`) omitted -- the overlay canvas is
  `pointer-events:none`; no interactive drag.
- **Tiny-window reshape branch** (`width > height*5`: viewport y-shift + `posarg=0`)
  omitted; only triggers at >5:1 aspect. The normal `ratio = w/h` + portrait-fit path
  is reproduced.

## Pacing / OVERHEAD

Per-frame increments in the .c (`xrot/yrot += spinspeed`, `posarg += wspeed/1000`,
`t += tspeed`, then `if(t>tmax) finish()`) are advanced per rAF by `frames = dt*effFps`,
`effFps = 1e6/(config.delay + OVERHEAD)`. `OVERHEAD = 37500` (the GL family's shared
measured value -- live GL hacks can't be timed under this machine's XQuartz Apple-DRI
block, so every three.js port adopts it). xml `delay` default 20000 -> ~17.4 fps.
Motion advances AFTER the draw, matching `draw_main`'s order (first frame draws at t=0).

## Config

`params[]` mirror `hacks/cube21.xml` 1:1: delay (xml id "speed", --delay, inverted),
cubesize, rotspeed, start (cube/shuffle = --no-randomize), colormode
(white/rnd/se/two/ce/six), spinspeed, wanderspeed, wait, spin, wander, tex ("Outlines"),
wire. `showfps` is host-level and omitted (as in glknots). Nothing invented, nothing
dropped. `config` is initialised from these defaults (not `param.default`).

## Verification

Rendered headless (chrome-headless-shell + swiftshader) via a standalone harness that
imports the module directly. Confirmed with no console errors/exceptions across: solved
cube and shuffled shapes; all six colour modes; wireframe. Checks:
- Solved cube: one-colour top/bottom faces (top=`colors[4]`, bottom=`colors[5]`), the
  radial wedge line-art converging to the face centre, the thin middle band, and colour
  material sides -- all correct.
- Middle band colours (`cind[4]`) render (a clear green equatorial band in classic mode
  confirmed the row-4 colour path; earlier "dark" middle reads were foreshortened /
  low-diffuse faces, not a bug).
- Default (spin+wander) view reproduces the target JPG's composition: the morphed
  cube drifted to the right, tilted, six muted colours, thick black outlines.
- Absolute on-screen scale follows the transcribed `zpos=-18` / `cubesize=0.7` /
  `fov=30`; the gallery JPG looks larger only because it is a lower-resolution capture.
