# flipflop — port notes

Faithful port of `xscreensaver-6.15/hacks/glx/flipflop.c` (Kevin Ogden &
Sergio Gutierrez, 2003; -textured mode added by Andrew Galante, 2008) to a
self-contained three.js module (`hacks/flipflop.js`). Visual ground truth:
`XScreenSaver_ Screenshots_files/flipflop.jpg` and the demo video
(`<video>` in `flipflop.xml`, youtube RzWRoAMFtnw).

## Algorithm (the `.c`)

A flat `board_x * board_y` grid of cells. `numsquares` of them hold a tile;
the rest are empty. State lives in `randsheet`:

- `occupied[i*board_y + j]` — tile index in that cell, or `-1` (empty).
- `xpos[n] / ypos[n]` — cell of tile `n`.
- `direction[n]` — `0` at rest, `1..4` = moving `+x/+y/-x/-y`.
- `angle[n]` — current flip angle (`0..PI`).
- `color[n]` — fixed RGB, assigned once at birth.

`randsheet_initialize()` fills cells in `(i outer, j inner)` order with tiles
`0..numsquares-1` (the rest `-1`), and colors each from `k=(i+j)%3`:
`k==0 -> RED (1,0,0)`, `k==1 -> BLUE (0,0,1)`, `k==2 -> YELLOW (1,1,0)` — the
diagonal red/blue/yellow stripes. Tiles keep their color forever, so the
stripes scramble as the tiles shuffle. (Default 9x9 tiles -> `76` tiles on
`81` cells, `5` empty, initially in the far corner.)

Per frame (`display` -> `drawBoard`):
1. `randsheet_new_move()` x `energy` (40): each picks `num=random()%numsquares`
   and `dir=random()%4+1`; if that tile is at rest and the `dir`-neighbor cell
   is in bounds and empty, it *reserves* the target (`occupied[target]=num`,
   `occupied[source]=-1`) and sets `direction`. Most attempts fail (few holes).
2. `randsheet_move(flipspeed*PI)`: every moving tile's `angle += rot`; at
   `angle>=PI` it snaps (`xpos/ypos += -+1`, `direction=0`, `angle=0`).
3. `randsheet_draw()`: per tile, `glTranslatef` to the pivot edge + `glRotatef`
   by the flip angle, then draw the box. The tile pivots end-over-end about the
   shared edge and lands flat in the adjacent cell.
4. `theta += 0.01*spin` -> board spin about the vertical (y) axis.

The box (`draw_sheet`) spans `[ht, 1-ht]` in x,z and `[-ht, ht]` in y — a thin
slab, the `half_thick` margin producing the black gaps between tiles. Camera
(`display`): `T(0,0,-reldist*board_avg)`, `Rx(22.5)`, `Ry(theta*100)`,
`T(-0.5*board_x, 0, -0.5*board_y)`; projection `gluPerspective(45, w/h, 1, 300)`.

## Shared libraries used

- `yarandom.js` — the `.c`'s `random()` is xscreensaver's `ya_random()`
  (`utils/yarandom.h`: `#define random() ya_random()`). Moves consume
  `rng.random()%numsquares` then `rng.random()%4+1`, in that order.

No `colormap.js`: flipflop uses no colormap, just the fixed `(i+j)%3` RGB triple.

## Faithful to the `.c`

- Board dims / counts / thickness / ratios / `energy` / `flipspeed` / `reldist`
  / tilt exactly (tiles: `ht=0.04`, ratio 95%; sticks: `ht=0.54`, ratio 80%).
- The move sim (`new_move` reserve-on-start, both RNG rolls before the rest
  check; `move` angle-accumulate + snap) is a line-for-line transcription.
- The per-tile pivot transforms transcribed exactly (dir 1: `T(i+1,0,j)`
  `Rz(PI-angle)`; dir 2: `T(i,0,j+1)` `Rx(-(PI-angle))`; dir 3: `T(i,0,j)`
  `Rz(angle)`; dir 4: `T(i,0,j)` `Rx(-angle)`; `glRotatef(deg,-1,0,0)` = `-`
  about `+x`). Verified endpoints land in the correct cells.
- Camera stack reproduced as a nested group hierarchy with the three camera
  left at the origin (identity view), so `modelViewMatrix` equals the GL
  modelview and the eye-fixed light constant is correct in eye space.
- Lighting equation transcribed exactly (see below). Matte (specular 0),
  back-face culled, depth-tested, black clear.

## Deviations / deliberate choices

- **Custom `ShaderMaterial` for the light (the notable one).** flipflop is the
  ONE GL hack in this repo that sets *non-default* distance attenuation:
  `GL_CONSTANT_ATTENUATION 1.2`, `GL_LINEAR/QUADRATIC 0.15/board_avg`, on a
  positional light fixed in EYE space at `(0, board_avg*0.3, 0)` (its
  `GL_POSITION` is set with `modelview==identity` at init, so it never moves
  with the board). The sibling ports' idiom — `PointLight(..., distance=0,
  decay=0)` — gives *no* falloff, and three's `PointLight` falloff is `1/d^2`
  (plus an optional window), neither of which is GL's `1/(kc+kl*d+kq*d*d)`. So
  the tiles use a small custom shader transcribing the fixed-function equation:
  `col = 0.2*C + att*(0.8 + max(N.L,0))*C`, `att = 1/(1.2 + k*d + k*d*d)`,
  `k = 0.15/avg`, clamped to `[0,1]`, `C` = tile color. `0.2` is the light-model
  (global) ambient (un-attenuated); `0.8` the light's `GL_AMBIENT`; diffuse
  `1`; specular `0`. This is why near tiles read near-saturated and far tiles
  fade toward black — matching the screenshot. Computed per-fragment; GL's fixed
  pipeline is per-vertex (Gouraud) with `GL_SMOOTH`, but each tile face has a
  single constant normal and the tiles are tiny, so the two are visually
  identical here.
- **Raw output.** `THREE.ColorManagement.enabled=false` (module scope) and the
  shader writes `gl_FragColor` directly with no `<colorspace_fragment>` /
  `<tonemapping_fragment>` chunk, so the framebuffer gets the raw lit values GL
  would write (the screenshots are raw). Same intent as `glknots.js`.
- **Texture option OMITTED.** `-textured` (`DEF_TEXTURED "False"`, off by
  default) grabs a *desktop screenshot* and maps it across the tiles, scrambling
  it as they move (`grab-ximage.h` / `load_texture_async` / `image_loaded_cb` /
  the `tex[]` swaps in `randsheet_move`). A browser has no desktop to grab, so
  the entire grab/texture path is omitted — no substitute image is invented. The
  xml's "Load image" checkbox is kept in `params` (to mirror the xml 1:1) but is
  an **inert no-op**: toggling it does nothing.
- **`sticks` mode** (secondary; xml `<select>`). Same code, `half_thick=0.54`,
  80% fill. The `.c` box then spans `[0.54, 0.46]` in x,z — an inverted
  (degenerate) quad. The port builds the box with `abs(1-2*ht)` so sticks are a
  valid, outward-normalled thin/tall stick rather than reproducing the
  inside-out quad. Tiles mode (the default, and the screenshot) is unaffected.
- **Wireframe** (secondary). three renders the box as a wireframe (all triangle
  edges, incl. the quad diagonals); the `.c` draws only the top+bottom quad
  outlines as `GL_LINE_LOOP`s. In wire mode the shader outputs the flat unlit
  color (the `.c` disables lighting in wireframe). Close enough for the option.
- **Ultra-wide reshape clamp omitted.** `reshape_flipflop` has a special path
  for `width > height*5` (show a middle band). Only triggers past a 5:1 aspect
  ratio; the standard `gluPerspective(45, w/h, 1, 300)` path is used.

## Pacing / OVERHEAD

`OVERHEAD = 37500` (the GL family's shared measured overhead; live GL timing is
blocked under this machine's XQuartz). xml `delay` default `20000` ->
`effFps = 1e6/57500 ~= 17.4 fps`. Continuous motion (flip angle, board spin)
advances by `frames = dt*effFps`; discrete move attempts tick at `effFps`
(`40` per tick, catch-up capped at `8`). Per-frame advances match the `.c`
(flip `0.03*PI/frame`, spin `0.01*spin/frame`) at the calibrated fps, so the
relative pacing (flip duration vs spin vs move rate) is preserved; only the
absolute wall-clock speed follows `effFps` (the project-wide GL convention).

## Config (mirrors `flipflop.xml` 1:1)

`delay` (Frame rate, invert, 0..100000, 20000), `spin` (Spin, 0..3, 0.1,
Stopped/Whirlwind), `mode` (Draw Tiles / Draw Sticks), `sizeX` (Width, 3..20,
9), `sizeY` (Depth, 3..20, 9), `texture` (Load image — inert, see above),
`wire` (Wireframe). `showfps` is a host concern (the host has its own readout),
not a hack knob — omitted, as in the sibling ports. The xml exposes neither
`-count` nor `-free`, so `numsquares` is always the ratio-derived value.
`mode`/`sizeX`/`sizeY` rebuild the board live; `wire` toggles live.

## Verification

Standalone headless capture (chrome-headless-shell, 1280x720, seed 12345) vs
`flipflop.jpg`: matches — tilted receding board, red/blue/yellow diagonal
stripes, thin slabs with black grid-gaps, tiles mid-flip standing up / arcing
over, and the near-bright / far-dark attenuation gradient. The differing
position of the moving cluster is just the random shuffle (different RNG
sequence), not a structural difference. `node --check` passes; source is
pure-ASCII (`µ` for the micro sign in the delay unit).
