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

## Palette

Native screenhack — it does **not** use `colormap.js`, and there is no generated
colour anywhere (the only `make_*` path in the C is the `mono_p` black/white
fallback, which the port doesn't need). Edge colours are a fixed 8x8 table baked
into the C's resource defaults (`color00..color77` in `hyperball_defaults[]`),
indexed `COLORS[col][dep]`: `col` (0..7) is the edge's hard-coded hue from
`line_table` (`li_color`); `dep` (0..7) is a depth shade from the summed endpoint
depths (`(dep_p + dep_q) >> 6`), with `dep 0` = front = brightest. The eight hues
are pink / orange / yellow-green / green / teal / blue / violet / magenta, each
fading darker with depth. The port transcribes all 64 hex values **verbatim** from
the defaults block (cross-checked entry-by-entry against the `.c`), so the palette
is exactly the original's — this is **not** the vivid-`hsl()` rainbow bug. Verified
against the live binary: the same multi-hued wireframe ball over black.

## Timing

Stock `*delay: 20000` µs (the port's `config.delay` already matches). xscreensaver's
`*delay` is a sleep *floor*; the real per-frame cost is `delay + compute`, so the
effective rate is below `1e6/delay`. The live binary's `-fps` overlay reads
**FPS 33.0 at Load 34.0%** (delay-bound — Load well under 100%), so

    OVERHEAD = round(1e6 / 33.0) - 20000 = 30303 - 20000 = 10303 µs

(self-consistent: 10303 / (10303 + 20000) = 34.0% = the reported Load). The rAF
lag-accumulator now paces on `(config.delay + OVERHEAD) / 1000` ms/step. Verified
in a real browser: the port steps at **33.0 steps/sec**, matching the live 33.0 fps.
Previously it paced on `config.delay` alone and ran at ~50 steps/sec (~1.5x too fast).

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
- **Defaults match the xml** (delay 20000 µs, observer-z 3, xy=3 xz=5 yw=10, rest
  0). See **Palette** for the fixed 8x8 colour table and **Timing** for the
  delay + measured OVERHEAD calibration.

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
