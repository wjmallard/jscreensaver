# hextrail -- design notes

Web port of xscreensaver's `hextrail` (Jamie Zawinski, 2022),
`xscreensaver-6.15/hacks/glx/hextrail.c`. A network of colorful lines grows along
the spokes of a hexagonal grid: a cell sprouts "arms" toward empty neighbors, each
arm grows from the cell center out to an edge, hands the baton to the neighbor
(which grows edge -> center), and that neighbor sprouts its own arms -- a
connected, branching trail. Cells carry a slowly-drifting color from an 8-entry
smooth colormap; a thin hexagon-outline "border" fades in around active cells;
little blobs cap the junctions and dead-ends. When the field can no longer find an
empty cell to seed, the whole thing fades out and a fresh plane begins. Self-
contained three.js: `start(canvas, opts) -> { stop, pause, resume, getStats,
reinit, config, params }`. **Asset-free.**

## Faithfulness (the rule: do NOT deviate from the algorithm)

Transcribed from `hextrail.c`:

- **`make_plane` (the grid):** `grid_w = grid_h = count*2`; pointy-top hexagons at
  `pos = ((x - grid_w/2)*size, (y - grid_h/2)*size*sqrt(3)/2)`, `size = 2/grid_w`,
  with odd rows shifted `+size/2`; the exact 6-neighbor even/odd-row offset table
  (`NEIGHBOR(I, even-x, odd-x, y)`); `ccolor = random()%8` per cell; an 8-entry
  `make_smooth_colormap` (colormap.js) **regenerated every plane** (so each grow
  cycle gets a fresh random palette -- verified: cool green/teal/blue then warm
  orange/olive on the next cycle).
- **The arm state machine (`tick_hexagons` + `add_arms`):** per-arm
  `EMPTY/IN/WAIT/OUT/DONE`. `add_arms` (always `out_p` in this hack) picks
  `target = 1 + rand%4` (minus one for `out_p`), traverses the 6 arms in a
  shuffled order, and for each empty neighbor sets this arm `OUT` + the neighbor's
  opposite arm `WAIT`, speed `0.05*speed*(0.8+frand)`, propagates `ccolor` (1/5
  chance to advance one), and sets the neighbor `border = IN`. An `OUT` arm grows
  `ratio` to 1 then `DONE`s and flips its `WAIT` neighbor to `IN`; an `IN` arm
  grows to 1 then `DONE`s, `live_count--`, and `add_arms` outward -> the trail
  propagates across cell boundaries.
- **The border machine:** `IN` ramps `border_ratio` 0->1 (`0.05*speed`/frame) then
  `WAIT`; `OUT` ramps 1->0 then `EMPTY`. The **`OUT -> WAIT` switch fall-through**
  in the .c is preserved (after fading, a 1/50-per-frame chance to (re)start
  `OUT`); `EMPTY`'s random-`IN` trigger is commented out in the .c, so a border,
  once `EMPTY`, stays.
- **The grow/fade cycle (`FIRST`/`DRAW`/`FADE`):** when `live_count <= 0`, seed the
  center (first time) then up to `grid/3` *random* re-seeds; if none take (field
  full), enter `FADE` (`fade_ratio -= 0.01*speed`/frame, all `IN`/`WAIT` borders
  -> `OUT`) and, at zero, `make_plane` afresh. `count` ("Hexagon Size") and a
  host re-seed both restart via `make_plane`, mirroring the .c's reset.
- **`draw_hexagons` (geometry), exactly:** `length = sqrt(3)/3`, `size =
  length/count`, `thick2 = thickness*fade_ratio`; the `corners[]` pointy-top
  hexagon; the **border ring** quad between `size1`/`size2`; the **center<->edge
  line** quad (`OUT`: center->`size*ratio`; `IN`/`DONE`: edge->`size*(1-ratio)`)
  with the per-vertex gradient `cell color <-> average(this, neighbor)`; and the
  **center cap** triangle (`size*thick2*0.8`, doubled for a lone arm -> the round
  dead-end dots). Submission order (border, line, cap per edge) preserved.
- **View:** `gluPerspective(30, aspect, 1, 100)`, eye `(0,0,30)` looking at the
  origin; modelview `T((x-.5)*6, (y-.5)*6, (z-.5)*12)` (wander) `* tilt *
  Rz(rot.z*360)` (spin) `* Scale(18) *` the portrait-fit `s=(W<H?W/H:1)`, built as
  nested groups. The slow spin/wander is `rotator.js` (`spin .002`, `wander .003`,
  `accel 1`, **randomize off**), with only the Z (in-plane) rotation used.

## Rendering (unlit -- no lighting path)

`hextrail.c` **never `glEnable(GL_LIGHTING)`** (its `glMaterialfv` calls are
no-ops), so this is flat `glColor` geometry: a single `MeshBasicMaterial` with
per-vertex colors, no lights or normals. GL ran with `GL_DEPTH_TEST` and
`GL_CULL_FACE` **off**, so the mesh is `DoubleSide` with `depthTest`/`depthWrite`
off -- the triangles paint in submission order, exactly as the GL painter did.

- **Color:** the `glColor` `[0,1]` values are written RAW to the framebuffer. three's
  colour management is **disabled** (`ColorManagement.enabled = false`), matching GL's
  fixed pipeline (no sRGB encoding), so the .c's color math (the `fade_ratio` /
  `border_ratio` scaling, the neighbor averaging) runs in `glColor` space and that value
  IS the output -- the `srgbToLinear()` helper is now an identity pass-through (it was a
  real sRGB->linear conversion before the GL-fidelity color fix). Palette entries come
  straight from `colormap.js` (already the .c's `/65535`-style `[0,1]`).
- The geometry is rebuilt into preallocated `DynamicDraw` buffers sized for the
  grid (`grid_w*grid_h*90` verts: 6 edges x (6 border + 6 line + 3 cap)) only when
  a sim tick (or a live `thickness`/`count` change) dirties it.

## Pacing / config

Pacing as in `dangerball.js`: render every rAF, but the **simulation ticks at the
original cadence** `effFps = 1e6/(delay + OVERHEAD)`, `OVERHEAD = 37500` (family
default; xml default delay 30000 -> ~14.8fps). Each tick is one full
`tick_hexagons()` frame -- so growth speed, the border 1/50 flicker, the re-seed
draws and the fade all run at the original per-frame rate, and the RNG-driven
*structure* stays faithful. The slow spin/wander `rotator` is ticked once per sim
frame and **interpolated** between ticks, so the whole field glides smoothly at any
display rate while the trails still step at the original cadence. **OPEN:**
`OVERHEAD` is the family default, not a per-hack measurement (the GL originals are
runtime-blocked here), so pin it against the demo video (youtube `gXcEitEmLbw`) if
the grow/fill rate reads off. Config transcribed 1:1 from
`hacks/config/hextrail.xml`: `delay`, `speed`, `count` ("Hexagon Size", inverted),
`thickness` (clamped to the .c's `0.05..0.5` at use), `wander`, `spin`, `wire`.

## Omissions / deviations

- The **interactive trackball** (mouse drag/inertia/zoom) is screensaver chrome and
  omitted -- but the .c's deliberate *initial* tilt (`gltrackball_reset(-0.4 +
  frand(0.8), ...)` -> `trackball(0,0,x,y)`) is reproduced exactly as a fixed
  quaternion (the `tbProject`/cross-product/`axis_to_quat` math), so the
  characteristic slight perspective tilt of the field is preserved.
- `reshape`'s tiny-window (`width > height*3`) middle-crop branch is skipped
  (irrelevant at screensaver aspect ratios).
- `wire` maps to `material.wireframe`; the .c's wireframe instead draws `GL_LINES`
  (dropping the 3rd vertex of each triangle) -- close but not identical.
- The `showFPS` toggle is host chrome (`getStats`), not a hack knob.

Verified by CDP capture vs `hextrail.jpg`: the dense branching line network on the
hex substrate, the faint hexagon-outline borders, the round dead-end/junction dots,
the per-line color gradients, and the slow perspective tilt all reproduce; the full
grow -> fill -> fade -> fresh-palette cycle runs exception-free.

See also: `dangerball.md`, `superquadrics.md`, `morph3d.md`; the
`glx-geometry-track-triage` + `framerate-calibration` memories.
