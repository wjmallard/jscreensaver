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

SOFTWARE rasterizer into an offscreen RGBA buffer, blitted with one
`putImageData` per frame. `crystal.c` draws with `XSetFunction(GXxor)`, so every
cell copy **bitwise-XORs** its colour into the framebuffer: where two different
colours overlap you get their XOR (a mixed / complementary tone), and where two
identical copies coincide they cancel to **black**. Canvas 2D has no bitwise XOR
(`'xor'` is alpha-coverage, `'difference'` is `|a-b|`), so the frame is composed
by hand:

1. Clear the buffer to opaque black (the `HAVE_JWXYZ` `XClearWindow`).
2. **GXcopy pass** — draw the unit-cell / grid outline by writing `dst = colour`
   along each line (the C draws this while the GC is still `GXcopy`, *before*
   switching to `GXxor`, so the atoms XOR over it).
3. **GXxor pass** — for every atom, scanline-fill each of its symmetry / lattice
   copies writing `dst ^= colour` per R,G,B channel. Each copy is a **separate**
   fill (one `XFillPolygon` in the C), so two overlapping copies of the *same*
   atom XOR-cancel — they are not merged into one path.

XORing each RGB byte independently equals XORing the packed 24-bit TrueColor
pixel value, which is what the C's `GXxor` does. The scanline fill samples pixel
centres with a half-open edge test (no double-XOR seams between neighbouring
polygons). At default `count` that is a few hundred small convex fills per frame.
All algorithm math runs in **logical (CSS) px** (matching the C's window-pixel
coordinates) and only the final screen point is multiplied by `devicePixelRatio`,
with the buffer sized to the device canvas, so the blit is crisp at any DPR and
the C math is byte-for-byte faithful (`Math.trunc` for every `(int)` cast).

## Deviations from the C

- **XOR overlap-mixing (software rasterizer).** `crystal.c` draws with `GXxor`.
  On macOS/JWXYZ (the live binary verified against here) it *also* clears the
  window every frame (`XClearWindow` under `HAVE_JWXYZ`), so there is no
  cross-frame accumulation — that clear-and-redraw path is what this port mirrors.
  Within a frame the C XORs every polygon against black **and against each other**:
  different-colour overlaps show the bitwise-XOR mixed tone, and same-colour
  overlaps cancel to black. Canvas 2D cannot bitwise-XOR, so the port composes the
  whole frame in a software RGBA buffer (`dst ^= colour` per channel) and blits it
  with `putImageData` — see **Rendering**. Verified against the live binary: with
  `--ncolors 4` (atoms use exactly two palette entries) the overlap colour is their
  exact bitwise XOR — e.g. `#34FAF7 ^ #9434FA = #A0CE0D`, *not* the `'difference'`
  blend `#60C603` — and dense runs reproduce the live binary's mixed-tone interior
  plus black cancellation. The 1-px-boundary pixels of a JS scanline fill are not
  byte-identical to X11's `XFillPolygon`, but the overlap mixing and cancellation
  match. The wallpaper-symmetry tiling, palette, and pace are faithful.
- **Periodic regeneration restored.** The xscreensaver standalone `draw_crystal`
  runs ONE plane group forever (only the atoms drift). The original xlockmore
  crystal — and the `*cycles: 200` default still present in this file's
  `DEFAULTS` — regenerated periodically. Because the spin is an *unbounded*
  random walk (the C never clamps `velocity_a`), an indefinitely long run would
  eventually spin frantically. So a `cycles` step counter calls `init()` (a full
  re-roll of group, cell, motif, and colours — exactly the "re-seed the motif +
  colours" the brief asks for). Exposed as the **New crystal after** slider; set
  it to its max to approximate the standalone's single-group behaviour.
- **Colour cycling** is the C's `rotate_colors` re-expressed as a colour-index
  phase rotation over the palette (Canvas has no writable colormap). It defaults
  **off** to match TrueColor/JWXYZ, where it never runs (see Palette).
- **Negative-count / -nx / -ny / -size semantics.** The C's defaults are
  negative ("random up to |n|"). The config exposes positive sliders
  (**Max objects** = `-count`, **Horizontal/Vertical symmetries** = `-nx`/`-ny`,
  **Atom size** = `-size`) and re-derives the negative bound internally, so the
  default behaviour (random variety up to the slider value) matches `count -500`,
  `nx/ny -3`, `size -15`.
- **`maxsize` is not exposed** (its default is off); the random-size/placement
  path is the only one ported.

## Palette

`crystal.c` is an xlockmore hack but does **not** rely on the xlockmore default
colour scheme: with `MI_IS_INSTALL` hard-wired `True` on xscreensaver and
`ncolors` 100 (> 2), the hack's own install branch always runs and builds a
fresh colormap on every `init_crystal`, choosing one of three schemes per run:

- **~10%** `make_random_colormap(bright_p=True)` — vivid random RGB
  (`makeRandomColormapRGB(n, true)`).
- **~45%** `make_uniform_colormap` — a full hue ramp at one per-run S,V
  (`makeUniformColormapRGB(n)`).
- **~45%** `make_smooth_colormap` — a closed loop through 2–5 HSV anchors, often
  pastel/muted (`makeSmoothColormapRGB(n)`).

So the live palette is a **limited, per-run map** — frequently muted or
two-toned (e.g. a gray-purple↔mint smooth run), occasionally vivid — never a
fixed full-saturation spectrum. The port reproduces this exactly via the three
`colormap.js` helpers, picked per `init()` with the C's `1/10 … else 1/2 … else`
probabilities; `ncolors <= 2` is the mono path (white, `MI_WHITE_PIXEL`). Each
atom's colour index is `NRAND(ncolors - 2) + 2` as in the C. (Verified against
the live binary: 5 grabs spanned a vivid run, a 13-colour harmonious run, a
2-hue pastel smooth run, and a cool blue/green/cyan run — all reproduced by the
port across re-rolls.)

The earlier port used a fixed vivid `hsl(i*360/n, 100%, 55%)` rainbow — the
systemic vivid-rainbow bug; replaced by the faithful `colormap.js` choice above.

Colour cycling (`rotate_colors`) is forced **off** on TrueColor/JWXYZ
(`has_writable_cells` is false there, so `cycle_p` is false regardless of
`DEF_CYCLE True`), so the live binary never cycles; the port mirrors this
(the **Color cycling** checkbox defaults off).

## Timing

Stock `*delay` is **60000 µs** (`crystal.xml` / `crystal.c` DEFAULTS). `delay` is
a sleep FLOOR, so the live effective fps is below `1e6/60000 ≈ 16.7`. Measured
off the live `-fps` overlay across 3 runs: **13.7 / 14.2 / 14.0 fps at Load
15–17.6%** (Load well under 100% → delay-bound). Mean ≈ 14.0 fps, so

`OVERHEAD = round(1e6 / 14.0) − 60000 ≈ 11600 µs`.

`config.delay` is the stock 60000 (the prior port used a by-eye 50000, *faster*
than stock) and the rAF loop paces one `step()` per `(config.delay + OVERHEAD)`,
i.e. ~71.6 ms → ~14 fps, matching the live binary. The per-step drift/spin is the
C's, unscaled.

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
