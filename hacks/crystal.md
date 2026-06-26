# crystal

Moving polygons that obey 2D plane-group (wallpaper) symmetry, like a
kaleidoscope. A handful of small polygons (rectangles / squares / triangles)
drift and spin inside one primitive unit cell; that motif is replicated across
the screen by the symmetry operations of one of the 17 planar crystallographic
groups, then tiled over an `nx * ny` lattice of cells.

Port of xscreensaver's `crystal.c` (Jouk Jansen, 1997), ~1285 lines of C →
`hacks/crystal.js`. The closest technique twins are `[[penrose]]` (a wallpaper
tiling in exact integer coords) and `[[truchet]]` (a cell-grid tiling).

## Algorithm

1. **Pick a group.** `init()` rolls `planegroup` in `[0,17)`, an `invert`
   (y-axis flip), and a cell angle `gamma`: `120°` for hexagonal groups (>11),
   a random `60..120°` for the two oblique groups (<2), else `90°`.
2. **Symmetry tables (DATA, copied verbatim from the C).** Each group's set of
   symmetry operations is read from `numops` (the half-open range
   `[numops[2g+1], numops[2g])` into the `operation` table). Each operation is a
   2×2 integer matrix plus a half-cell glide `(e·a/2, f·b/2)`. `centro[g]` adds
   an inversion copy and `primitive[g] == false` adds a half-cell-centred copy
   (and, when both, the inversion of that copy). These four tables are
   transcribed exactly — a wrong entry would break the tiling.
3. **Cell sizing/placement.** A big cell `(aFull, bFull)` is randomly sized and
   placed (the default non-`maxsize`, non-`centre` path), then divided into the
   `nx × ny` lattice (`A = aFull/nx`, `B = bFull/ny`).
4. **Motif.** `num_atom` atoms get random colour, position, integer velocity,
   angular velocity, spin angle, shape type, and size. `crystal_setupatom`
   builds each polygon's vertices in cell space (sheared by `gamma` via
   `trans_coor`).
5. **Each step (`draw_crystal`).** Clear to black; optionally draw the unit-cell
   / grid outline; then for every atom: random-walk the velocity (clamped to
   ±20) and spin, drift+wrap the position inside the cell, rebuild the polygon,
   and draw its full symmetry orbit. `crystal_drawatom` applies every operation
   × centro × primitive × lattice copy, mapping cell coords back to screen via
   `trans_coor_back` (+ offsets, + optional invert).

## Rendering

SPARSE vector. Per atom, all of its symmetry/lattice copies (same colour) are
accumulated into one `Path2D` and filled once, so fills bucket by colour (the
`braid.js`/`penrose.js` idiom). At default `count` that is a few hundred small
convex polygons per frame. All algorithm math runs in **logical (CSS) px**
(matching the C's window-pixel coordinates) and only the final screen point is
multiplied by `devicePixelRatio`, so motion speed and proportions are
resolution-independent and the C math is byte-for-byte faithful (`Math.trunc`
for every `(int)` cast).

## Deviations from the C

- **No XOR.** `crystal.c` draws with `GXxor`. On macOS/JWXYZ it already clears
  the window every frame (`XClearWindow` under `HAVE_JWXYZ`) and redraws, rather
  than XOR-erasing the previous frame; that is the path ported here — clear to
  black, redraw all atoms each frame. Canvas has no raster XOR, and on a black
  background XOR-with-black is just the colour, so the look matches. Overlapping
  polygons within a frame simply paint over each other (the X11 path would XOR
  them); this is the documented faithful-on-modern behaviour.
- **Periodic regeneration restored.** The xscreensaver standalone `draw_crystal`
  runs ONE plane group forever (only the atoms drift). The original xlockmore
  crystal — and the `*cycles: 200` default still present in this file's
  `DEFAULTS` — regenerated periodically. Because the spin is an *unbounded*
  random walk (the C never clamps `velocity_a`), an indefinitely long run would
  eventually spin frantically. So a `cycles` step counter calls `init()` (a full
  re-roll of group, cell, motif, and colours — exactly the "re-seed the motif +
  colours" the brief asks for). Exposed as the **New crystal after** slider; set
  it to its max to approximate the standalone's single-group behaviour.
- **Colour cycling** is the C's `rotate_colors` re-expressed as a hue-index phase
  rotation over an HSL palette (Canvas has no writable colormap). It defaults
  **off**, matching real TrueColor/JWXYZ behaviour (`has_writable_cells` is false
  there, so `cycle_p` is forced off) even though `DEF_CYCLE` is `True`.
- **Negative-count / -nx / -ny / -size semantics.** The C's defaults are
  negative ("random up to |n|"). The config exposes positive sliders
  (**Max objects** = `-count`, **Horizontal/Vertical symmetries** = `-nx`/`-ny`,
  **Atom size** = `-size`) and re-derives the negative bound internally, so the
  default behaviour (random variety up to the slider value) matches `count -500`,
  `nx/ny -3`, `size -15`.
- **`maxsize` is not exposed** (its default is off); the random-size/placement
  path is the only one ported. Vivid HSL palette over the original's allocated
  colormap, per the project's house style. `delay` default lowered to 33 ms
  (~30 fps) from the stock 60 ms for smoother drift (the per-step motion is the
  C's, unscaled — the drift is slow, so this reads smooth, not fast).

## Correctness self-review

- **Termination / freeze.** There is no growth state machine to wedge (unlike
  penrose); every step clears and redraws a fixed `num_atom`, so a step is O(atoms
  × symmetry copies) and always finite. The `cycles` regeneration is the only
  branch that re-enters `init()`, and it resets its own counter.
- **No runaway.** A 30 000-step headless fuzz (≈500 regenerated crystals,
  `cycles=60`, grid + colour-cycle on) produced **zero** non-finite coordinates
  and kept all output within ~60 px of the device canvas — the lattice covers the
  viewport, with a small off-screen margin where polygons overrun cell edges.
  The unbounded `velocity_a` walk is the C's; the periodic re-init bounds it in
  practice.
- **Lattice coverage / no infinite loop.** The `nx × ny` cell loop in
  `emitLattice` is bounded by the cell counts; off-screen copies are still added
  to the path (canvas clips them) rather than looped over indefinitely. The cell
  sizing `while` loop is bounded by `max_repeat = 10` exactly as in the C.
- **Position wrap.** `x0/y0` are integers wrapped with a single `±A`/`±B` step
  (the C's exact logic); velocities are clamped to ±20 so one step can never
  overshoot the cell by more than the wrap can correct (`A,B ≥ ~25`).
- **In-place mutation order.** The centro block mutates the polygon array in
  place and the non-primitive block then reads/extends that mutated array — this
  is reproduced exactly, so group 8 (the one group that is *both* centro and
  centred) tiles identically to the C.
- **First frame.** `init()` fully seeds the motif so the first executed `step()`
  paints the whole lattice (one ~33 ms rAF tick of black first, matching the
  shared lag-accumulator loop used by `[[penrose]]`/`[[squiral]]`).

See `[[penrose]]` and `[[truchet]]`.
