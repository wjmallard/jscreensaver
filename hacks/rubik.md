# rubik — port notes

Port of `xscreensaver-6.15/hacks/glx/rubik.c` (Marcelo F. Vianna, 1997) to a
self-contained three.js module, `hacks/rubik.js`. "An auto-solving Rubik's Cube":
build a solved LxMxN cube, generate a random scramble, then show the shuffling and
reverse it (or, with *hideshuffling*, start scrambled and only show the solve);
loop forever with fresh random sizes each cycle.

## Algorithm (how the .c works)

**State model.** The cube is six *facelet* arrays `cubeLoc[face][position]`, each
entry a `RubikLoc {face, rotation}` where `face` is the sticker colour (0..5) and
`rotation` is the sticker's orientation (0..3, bookkeeping only — never affects the
drawn colour). Face dimensions (`faceSizes`): TOP/BOTTOM are X*Z, LEFT/RIGHT are
Z*Y, FRONT/BACK are X*Y. A solved cube has every entry of `cubeLoc[f]` set to face
`f`. Faces: TOP=0, LEFT=1, FRONT=2, RIGHT=3, BOTTOM=4, BACK=5.

**A move** is `RubikMove {face, direction, position}` with `direction` one of the
four edge directions TOP/RIGHT/BOTTOM/LEFT (shuffle/solve never generate CW/CCW).
`convertMove()` turns it into a `RubikSlice {face(axis: TOP/LEFT/FRONT), rotation
(CW/CCW), depth}`. `moveRubik()` permutes `cubeLoc` for that turn: it `rotateFace`s
the turned face and slides the ring of four side rows/columns around it via
`readRC`/`rotateRC`/`reverseRC`/`writeRC` + the `slideNextRow`/`slideRC` transition
tables. Square faces turn 90 degrees (`degreeTurn=90`); a non-square face (only on
cuboids) can only turn 180 (`degreeTurn=180`), which takes a longer *double-slide*
branch in `moveRubik`.

**Shuffle.** `shuffle()` picks the three sizes (see Config), builds a solved cube,
then generates `count` random moves. `count<0` means a random `1..|count|`. Each
move is `face=NRAND(6)`, `direction=NRAND(4)`, `position=NRAND(sizeFace)`, rejected
(`compare_moves` on the derived slices) if it would immediately undo the previous
move, or repeat the same move three times in a row. With *hideshuffling* the moves
are applied immediately (cube starts scrambled).

**Solve.** There is **no solver** — the solve replays the stored moves last-to-first
with the direction reversed (`(dir + 2) % 4`). Because that is the exact inverse of
each recorded permutation, the cube provably returns to solved.

**Animation / main loop (`draw_rubik`).** A per-frame state machine: `rotatestep`
climbs from 0 to `degreeTurn` in steps of `anglestep = 90/cycles`; when it passes
`degreeTurn`, `evalmovement()` applies the permutation and the move ends. The
turning slice is *drawn with the pre-move colours, rotated in space*; the permutation
snaps it home exactly when the turn completes. `ACTION_SHUFFLE` walks `moves[0..]`;
after all moves it pauses `DELAY_AFTER_SHUFFLING`(5) frames, switches to
`ACTION_SOLVE`, replays in reverse, pauses `DELAY_AFTER_SOLVING`(20) frames, and
re-`shuffle()`s. Meanwhile the whole cube spins continuously (`step` += 0.002/frame,
applied as `glRotatef(step*100, step*95, step*90)` on X/Y/Z) and drifts on a bouncing
`PX,PY` path that jitters its velocity on each wall bounce.

**Geometry.** Each drawn cubie is a rounded/beveled cube (`draw_stickerless_cubit`:
6 face quads at +/-CUBELEN spanning +/-CUBEROUND, 12 edge-bevel quads, 8 corner
tris, all gray) plus, on each *exposed* face, an octagonal "rounded square" sticker
sitting just proud of the body at STICKERDEPTH, coloured per `cubeLoc`. `draw_cube`
only ever visits shell cubies (interior cubies are never drawn) and injects the
current move's `glRotatef` into the one slice being turned.

## What the port reproduces faithfully

- **The complete state machine**, transcribed 1:1: `faceSizes`, `convertMove`,
  `rotateFace`, `readRC`/`rotateRC`/`reverseRC`/`writeRC`, `slideRC`, `moveRubik`
  (including the 180-degree double-slide branch), `compareMoves`, the shuffle
  move-generation with both rejection rules, and the `(dir+2)%4` reverse-replay
  solve. `RubikLoc` is packed as one int `face<<2 | rotation`; assignments copy the
  int (value semantics, matching the C's struct-copy — no aliasing).
- **`draw_cube`'s cubie->facelet map**, derived from the static (`NO_FACE`)
  traversal and spot-checked against all three moving branches, so the port reads
  colours generically for any LxMxN instead of transcribing the ~500-line hardcoded
  draw. For cubie `(i,j,k)` (i=X, j=Y up, k=Z toward front):
  back `cubeLoc[BACK][i+SX*j]`, front `cubeLoc[FRONT][i+SX*(SY-1-j)]`,
  left `cubeLoc[LEFT][k+SZ*(SY-1-j)]`, right `cubeLoc[RIGHT][(SZ-1-k)+SZ*(SY-1-j)]`,
  bottom `cubeLoc[BOTTOM][i+SX*(SZ-1-k)]`, top `cubeLoc[TOP][i+SX*k]`.
- **Slice animation.** From the same `convertMove` slice: TOP-axis rotates the layer
  `j = SY-1-depth` about +Y by the signed step; LEFT-axis rotates `i = depth` about
  X by the negated step; FRONT-axis rotates `k = SZ-1-depth` about +Z. These signs
  are copied verbatim from `draw_cube`'s `glRotatef` calls, so the visual turn lands
  exactly on the `moveRubik` permutation. The turning cubies are re-parented under a
  pivot group; the rest stay at fixed grid positions (cubies never change cell — only
  their sticker colours change, exactly as `cubeLoc` works in the C).
- **The beveled cubie**, transcribed vertex-for-vertex from `draw_stickerless_cubit`
  and the six sticker octagons, with per-triangle winding flipped to match each
  polygon's `glNormal3f` outward normal (so flat shading lights each face from the
  outside).
- **Colours = the .c's exact DIFFUSE material arrays** (not standard-Rubik colours):
  TOP=Red(.5,0,0), LEFT=Yellow(.7,.7,0), FRONT=White(.8,.8,.8), RIGHT=Green(0,.5,0),
  BOTTOM=Orange(.9,.45,.36), BACK=Blue(0,0,.5); body Gray(.2,.2,.2).
- **Lighting.** Two directional white lights at (1,1,1) and (-1,-1,1), specular 0.7,
  shininess 60, `GL_FLAT` => `flatShading:true`. The camera is `glFrustum(-1,1,-1,1,
  5,15)` (fixed *square* frustum; the .c corrects window aspect with a modelview
  X-scale, which the port reproduces rather than changing the camera aspect), cube
  translated to z=-10, with `Scale4Window = 0.9/AVSIZE` object scale, the portrait
  fit, and the spin/drift chain.

## Deviations / deliberate choices

- **Global ambient as `material.emissive`.** The C's ambient term is
  `LIGHT_MODEL_AMBIENT(0.5) * material-ambient(0.2) = 0.1`, and crucially the
  material ambient is the GL default gray (0.2,0.2,0.2) — *not* the diffuse colour —
  so a shadowed sticker reads flat 0.1 **gray**, not a dark tint of its colour. An
  `AmbientLight` in three would tint by `material.color` (wrong), so the port uses
  `emissive = (0.1,0.1,0.1)` (a colour-independent flat add), which matches the GL
  result exactly.
- **Light intensity = PI, specular /= PI.** The repo-standard convention (superquadrics
  /glknots) that cancels three r160's Lambert/specular normalization so raw diffuse =
  `colour*(N·L)`; `THREE.ColorManagement.enabled = false` keeps raw glColor values.
- **Specular on both lights.** GL only gives LIGHT0 a (default) specular colour; LIGHT1
  has none. three applies `material.specular` to *both* lights, so the port shows a
  faint extra highlight from the second light. Minor (stickers are fairly matte at
  shininess 60); three has no per-light specular toggle for Phong.
- **`cycles` is live.** The C reads it only in `shuffle()`; the port recomputes
  `anglestep` at each move start from `config.cycles`, so a change takes effect on the
  next turn without a reshuffle. `count`/`size`/`hideshuffling` are read at the next
  `shuffle()` (faithful — the C reads them there too); the host "re-seed" action calls
  `reinit()` => an immediate fresh `shuffle()`.
- **Interpolation.** The `draw_rubik` state machine is ticked at `effFps` (its
  frame-counted delays 5/20 are only faithful at the original cadence); the continuous
  spin, drift, and the in-progress turn angle are interpolated by the sub-tick fraction
  for 60fps smoothness (clamped to `degreeTurn`). Catch-up capped at 8 ticks.
- **Generic shell build instead of the hardcoded traversal.** Proven equivalent for
  the static case and consistent across all three moving branches (see the map above).

## Pacing / OVERHEAD

`OVERHEAD = 37500` (the GL family's shared measured value — these hacks can't be
timed under this machine's XQuartz Apple-DRI block, so every three.js GL port adopts
the same constant). `config.delay` default = the xml `<delay>` 20000. `effFps =
1e6/(delay + OVERHEAD) = 1e6/57500 ~= 17.4fps`, the original's effective rate.

## Config (mirrors hacks/rubik.xml 1:1)

| key | xml | control | range | default | notes |
|---|---|---|---|---|---|
| `delay` | delay | slider (invert) | 0..100000 us | 20000 | Frame rate |
| `count` | count | spinbutton->slider | -100..100 | -30 | stored moves; <0 => random 1..|count| |
| `cycles` | cycles | slider (invert) | 3..200 | 20 | "Rotation"; frames per 90deg turn |
| `size` | size | spinbutton->slider | -20..20 | -6 | cube size; <0 => random 2..|size| |
| `hideshuffling` | shuffle | checkbox | — | false | "Hide shuffling" (arg `--hideshuffling`) |

Spinbuttons render as sliders (the host's config-box has no spinbutton type; the
default branch is a range). The `-sizex/-sizey/-sizez` command-line overrides are
not exposed (the xml doesn't either); internally they are 0, so `size` drives all
three axes exactly as the stock resource path. Size selection follows `shuffle()`:
`LRAND()%2` biases toward NxNxN, else toward MxNxN, else a full LxMxN cuboid.

## Omissions

- **Trackball / mouse** interaction and `current_device_rotation` (mobile) — the
  screensaver path only; not ported.
- **Mono mode** (`pickcolor`'s gray palette) — xscreensaver is always colour here.
- The `RubikLoc.rotation` field is tracked through the permutations (faithful) but,
  as in the C, never affects the rendered colour.

## Verification

- `node --check hacks/rubik.js` passes; `LC_ALL=C grep -nP "[^\x00-\x7F]"` reports
  nothing (the `µs` unit is escaped; literal non-ASCII only in comments).
- **Solve-correctness (decisive):** a standalone Node harness running the *verbatim*
  ported state logic built a solved cube, applied a 30-move deduped scramble, then the
  `(dir+2)%4` reverse-replay, across 10 shapes x 40 seeds = **400 runs, 0 failures** —
  every scramble was genuinely scrambled and returned to fully solved. Shapes included
  cuboids (3x3x2, 4x3x2, 5x4x3, 2x3x4, 6x4x5) that exercise the 180-degree branch.
- **Visual:** headless captures (chrome-headless-shell + swiftshader) across several
  seeds show the beveled gray bodies with inter-cubie gaps, octagonal "rounded square"
  stickers, the exact palette (red/white/green/blue/yellow/orange), flat per-face
  shading, a slice caught mid-turn (lit differently as it rotates), and the cube
  drifting around the black field — matching `XScreenSaver_ Screenshots_files/rubik.jpg`.
  (Transient all-white frames seen only under rapid *concurrent* headless launches were
  swiftshader context flakiness, not a code issue — the same seeds render correctly on
  a single launch, mean brightness ~0.03 in line with the good captures.)
