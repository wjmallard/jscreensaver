# hyperball

A wireframe 2D projection of a rotating 4D **hyperball** — technically the
**120-cell** regular polytope (the 4D analog of the dodecahedron): 600 vertices,
1200 edges. The wireframe tumbles through up to six 4D rotation planes at once.

## Source

Ported from `xscreensaver-6.15/hacks/hyperball.c` (2463 lines; Joe Keane, 2000,
derived from TI Explorer Lisp code by Joe Keane, Fritz Mueller, and Jamie
Zawinski). Config from `xscreensaver-6.15/hacks/config/hyperball.xml`. The bulk
of the C file is two big static data tables (`point_table[600]`, `line_table[1200]`).
See [[scooter]] for the sibling 1/z-perspective projection idioms and [[squiral]]
for the rAF loop / sizing / pause-resume skeleton.

## Algorithm

The polytope's coordinate frame is four orthonormal 4-vectors `a, b, c, d` (each
with x/y/z/w components), stored row-major in `R[16]`, starting at the identity.

Each step:
1. **Project every vertex.** A vertex's 4 coords `(a,b,c,d)` weight the frame
   vectors: `sum_x = a*ax + b*bx + c*cx + d*dx`, likewise `sum_y`, `sum_z`. The
   `w` axis is computed-but-dropped (orthographic 4D -> 3D); `w` extent still
   shows through because the frame's x/y/z components mix in `w` as it rotates.
   3D -> 2D is a `1/z` perspective: `mul = unit_scale / (observer_z - sum_z)`,
   `x = sum_x*mul + cx`, `y = sum_y*mul + cy`. Per-vertex depth shade
   `dep = floor(sum_z * -128) + 128` (front = bright).
2. **Draw edges.** Each edge has a fixed hue `col` (0..7) and a depth bucket
   `dep = (dep_p + dep_q) >> 6` (0..7) from its endpoints. Colour =
   `COLORS[col][dep]` (the verbatim 8x8 `color00..color77` palette).
3. **Rotate the frame** by small fixed angles in the six planes (xy, xz, yz, xw,
   yw, zw), each `rate * 0.001` rad/step, applied to all four frame vectors —
   exactly the C's `rotates()`/`rotate()` macros. Draw-then-rotate, as the C.

`unit_scale = 0.4 * min(W,H) * sqrt(observer_z^2 - 1)` and the screen centre come
from `set_sizes()`; `unit_scale` is recomputed each step so **Zoom** is live.

## Deviations from the C

- **XOR/incremental erase -> full-frame repaint.** The C never clears; it erases
  incrementally — for each *moved* edge it redraws the edge's OLD endpoints in the
  background colour, then draws the new edge in colour (`GXcopy` black-erase, not
  actually `GXxor`). Canvas has no cheap stateful erase, so each step does a full
  `clear + redraw all 1200 edges`. No ghosting; identical look. The C's
  `hs_moved[]` "only redraw what moved" optimisation is therefore dropped (we
  always redraw everything).
- **Stroke batching.** Rather than 1200 individual `XDrawLine` calls, edges are
  bucketed into 64 `Path2D` objects keyed by `[colour][depth]` and stroked once
  per non-empty bucket (<= 64 strokes/frame; the harness measured 56-57).
- **Float vs int coords.** The C rounds projected coords with `rint()` (X11 needs
  ints). We keep floats for smoother sub-pixel lines; depth/colour are computed
  from `sum_z`, not the rounded coords, so colour is unaffected.
- **Live sliders.** The C precomputes each plane's cos/sin once at init. We
  recompute them from `config` every step (12 trig calls/frame, negligible vs 600
  vertices), so the six rotation-rate sliders and Zoom apply instantly. Constant
  config yields byte-identical rotation.
- **Encoding.** The micro sign in the Frame-rate unit is the escape `\u00B5`, not
  a literal byte (per the project's ASCII-safe rule).
- **Defaults match the xml** (delay 20000 us, observer-z 3, xy=3 xz=5 yw=10, rest
  0). The vivid 8-hue x 8-shade palette is the original's own `color00..color77`
  table, kept verbatim (already a rainbow, no retuning needed).

## Verbatim data tables (the transcription hazard)

Both big tables were **extracted programmatically** from `hyperball.c` (a regex
script, not hand-typed) and injected into `hyperball.js`:
- `POINTS` = `Float64Array(2400)` — the 600 vertices x 4 coords from `point_table`.
- `LINES` = `Int16Array(3600)` — the 1200 edges x `(ip, iq, colour)` from `line_table`.

Verified after injection: **600** points, **1200** lines, max vertex index **599**
(in range), max colour **7**. Spot-checked endpoints against the C: first vertex
`0.93, 0.30, 0.09, 0.03`, last `-0.16, 0.27, 0.90, -0.22`; first edges `0,1,0` /
`0,29,0`, last edge `569, 599, 7`. The 8x8 `COLORS` palette was transcribed from
`hyperball_defaults[]` (`color00..color77`, indexed `[col][dep]`, dep 0 = front).

## Correctness self-review

- **No freeze / no over-draw.** No state machine or closure condition — it's a
  pure continuous rotation. The loop redraws every frame; nothing to "never
  reset". `reinit()` resets the frame to identity and clears.
- **No divergence.** Frame vectors are rotated by orthonormal 2x2 rotations
  (norm-preserving), so they can't blow up over time; the harness ran 12 frames
  with all coords finite and bbox stable (~[190..791, 92..705] in 1000x800).
- **Projection divide guarded.** `observer_z >= 1.125` and `|sum_z| < 1` (all
  `point_table` vertices have norm < 1), so `observer_z - sum_z > 0.14` always;
  clamped to `>= 1e-3` anyway as belt-and-suspenders.
- **Depth bucket in range.** `dep_p, dep_q in [3, 253]`, sum `in [6, 506]`,
  `>> 6 in [0, 7]`; clamped 0..7 regardless, so `COLORS[col][dep]` never indexes
  out of bounds.
- **Frame 1 shows the solid.** The frame starts at identity, and step()
  draws-then-rotates, so the first drawn frame is the straight-on projection
  (`a`,`b` as screen x/y, `c` as depth). Harness confirmed motion across frames.
- **Pause/resume** reset `lastTime = 0` to avoid a catch-up burst; `MAX_CATCHUP_STEPS`
  caps a backgrounded tab.

## Browser spot-checks for the host session

- Confirm the wireframe is centred and ~3/4 of the min screen dimension across
  (it should not overflow). The Zoom slider should grow/shrink it live; far end
  shrinks toward a point.
- Confirm the six rotation sliders independently change tumble direction/speed
  live, and that 0 on all of them freezes the (drawn) solid.
