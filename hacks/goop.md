# goop — port notes

Port of `goop.c` by Jamie Zawinski (1997) — big translucent amoeba-like blobs drift around the screen, slowly throbbing and morphing, bouncing off the edges and overlapping like a lava lamp. One of the classic xscreensaver "goop" looks.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/goop.c` (~650 lines), closed-spline math from `xscreensaver-6.15/utils/spline.c`.

See [[metaballs]] and [[interaggregate]] for the sibling translucent-overlapping-blob ports, and [[squiral]] for the shared module skeleton.

## Algorithm
- **Blobs.** `count` blobs (xml default 12), each its own vivid colour. A blob has a centre `(x,y)`, a velocity `(dx,dy)`, a rotation angle `th` (with a torque), and `npoints` control points (5..9). Each control point `i` carries a *signed* radius `r[i]`: the magnitude is the point's distance from the centre, the sign is the direction it is currently throbbing.
- **Throb (`throbBlob`).** Each frame, every control point is placed evenly around the perimeter at angle `i*(2pi/npoints) + |th|` and distance `|r[i]|` from the centre, then its radius is nudged by up to `elasticity` px in its current direction. When the magnitude reaches `min_r`/`max_r` (or randomly 1/50 of the time) the direction reverses — so each point independently oscillates and the outline ripples.
- **Move (`moveBlob`).** The centre drifts by `(dx,dy)`; when it crosses an edge heading outward the matching velocity component flips (bounce). 1/10 of the time the velocity is randomly perturbed and throttled to `maxv`; the rotation advances by `frand(torque)` and flips sign 1/100 of the time.
- **Outline.** The control points define a **closed uniform cubic B-spline** (the C's `compute_closed_spline`). Drawn filled, in order, with the current blend.

Rendering is the **sparse vector** path: only ~12 large shapes per frame, so each is a `Path2D` filled directly — no per-pixel buffer. Because the overlap blend depends on the whole stack, the frame is fully redrawn every step (clear to black, fill all blobs).

## Spline: bezier instead of polygon flattening
`spline.c` builds a closed uniform cubic B-spline and then **flattens it to a polygon** (recursive `add_bezier_arc` subdivision) because X11 fills polygons, not curves. Canvas *can* fill curves, so this port skips the flattening: for each control-point section it computes the standard B-spline -> bezier control points (`calc_section`) and feeds them straight to `ctx.bezierCurveTo`. The four points `calc_section` derives are exactly one cubic bezier, and each section's end point equals the next section's start point, so the curve is C1-continuous and closes on itself. This is smoother (true curve, not line segments) and cheaper than reproducing the subdivision. A headless check confirmed the section start/end points coincide to machine precision (mismatch `0.00e+0`), i.e. no gaps or kinks.

## Config
Units/defaults mirror `hacks/config/goop.xml`: `delay` (Frame rate, µs, 12000), `torque` (Speed, 0.0075), `count` (Blobs, 12 — see note below), `elasticity` (0.9), `maxv` (Speed limit, 0.5), and a `mode` Blend select.
- **`live: true`** — `delay`, `torque`, `elasticity`, `maxv`, `mode`: read every step, so they apply instantly. The C fixes torque/elasticity/max-velocity per blob at creation; reading them live is a small, friendlier deviation (existing blobs simply adopt the new value, which converges immediately since these only scale per-frame increments / the throttle).
- **`live: false`** — `count`: it sizes the blob array, so a change re-runs `init()` via `reinit()` (which also clears the canvas).
- `delay` uses `invert: true` (the xml's `convert="invert"` "Frame rate" slider — drag right = faster), shown as the raw µs value.

**The "Blobs" slider == planes.** The xml's only blob-count control (`id="count"`) is wired to `--planes`, the number of colour layers; the *actual* per-layer `count` resource is left at its default of 1 and isn't exposed. So in the original each "plane" is one blob with its own colour, and the slider really sets the number of distinctly-coloured blobs. This port folds that away: `config.count` is simply the number of blobs, each a distinct colour — identical to the original's default behaviour.

## Deviations from the C
- **Blend mode (the important one).** The C has three modes. Its **default is `transparent`**, *not* XOR. On the old PseudoColor path that used colour-plane masks; on jwxyz (macOS/iOS — the platform xscreensaver actually runs on today) `transparent` is rendered as plain **alpha compositing**: each blob colour is given alpha `0xBB` (~0.73) and drawn source-over on black. Canvas supports that natively, so the default `'transparent'` mode here is `globalCompositeOperation = 'source-over'` at `globalAlpha = 0.73` — a faithful match to what macOS goop shows. The other modes:
  - **`additive`** ("transmitted light", the xml's default colour-mode) -> `'lighter'`: overlaps brighten toward white, the glowing lava-lamp look.
  - **`xor`** -> `'difference'`: **canvas has no XOR raster op**, so the C's `GXxor` (overlaps invert) is approximated with `difference` (`|backdrop - source|`), the closest available analog — overlapping blobs cancel/invert much like the 1-bit XOR plane.
  - **`opaque`** -> `'source-over'` at full alpha.
  The XOR look is therefore preserved as an option, but is **not** the default, because it isn't the original's default. (The porter brief framed goop as XOR-first; the source shows transparent-alpha is the real default — documented here so the choice is explicit.)
- **Curve, not polygon** — see "Spline" above.
- **Colours.** The C picks a random hue per layer with S 30-100% / V 66-100%; this port uses fully-saturated `hsl(random, 100%, 55%)` for the project's vivid-rainbow aesthetic. The black background is unchanged.
- **No fixed-point `SCALE`.** The C does all blob math in `<<` SCALE=10000 fixed-point longs for sub-pixel motion; JS doubles give that for free, so the port works directly in float pixels (no `>>`/overflow concerns). `RAND(n)` (integer) becomes `frand(n)` (float) — equivalent at these magnitudes.
- **devicePixelRatio.** Blob *sizes* derive from the device-pixel canvas dims, so they already scale with dpr; velocities and elasticity are multiplied by `S = devicePixelRatio` so the on-screen drift/throb speed feels the same on retina. Torque is angular, so it isn't scaled.
- **No `--fps`, `--thickness`/outline, `--subtractive`** UI: `outline` mode and the subtractive colour-mode aren't exposed (subtractive is a no-op on jwxyz anyway). Frame rate is the standard project slider.
- **Default delay** kept at the stock 12000 µs (already calm, and < one display frame so it steps ~once per refresh).

## Correctness self-review
A headless harness re-ran the core math (`makeBlob`/`moveBlob`/`throbBlob` + the spline section points) for **5000 frames x 12 blobs**:
- **No NaN/Infinity** anywhere (centres, angle, all control points) — 0 non-finite values. There's no division or attractor map that could diverge.
- **Bounce contains the blobs.** Centre X stayed in `-0.4 .. 1795` (W=1920), Y in `48.6 .. 1080.3` (H=1080): only sub-pixel overshoot at the edges, then the velocity reverses — a blob never escapes. (Blobs *do* extend off-screen at the edges because their radii are large; that's the intended amoeba-hugging-the-edge look.) The throttle (`/2` past `maxv`) bounds velocity, so overshoot can't grow.
- **Throb is alive and bounded.** Across all points, `|radius|` rode within `~37 .. 269` px (each blob's own `min_r..max_r`); 79/81 control radii had moved >1px (the throb never stalls — the radius-limit + 1/50 random reversals keep every point oscillating). It can't run away: hitting `max_r`/`min_r` reverses direction.
- **Closure.** Each spline section's end point coincides with the next section's start (mismatch `0`), and the path `closePath()`s, so the filled outline is always a single closed shape — no gaps, no self-destruct.
- **Frame 1 is correct.** `init()` calls `throbBlob` once per blob to seed the control points before the first draw, and blobs start at random *on-screen* centres, so the very first painted frame already shows proper blobs (no degenerate origin shapes — which the C would briefly show because it draws before the first throb).
- **No freeze / over-draw.** The rAF loop is the shared lag-accumulator with `MAX_CATCHUP_STEPS`; `step()` does a fixed amount of work (move+throb+fill per blob) with no data-dependent unbounded loop. **Pause/resume** uses the `rafId === 0` sentinel and resets `lastTime` so resume can't burst; **reinit** rebuilds the blobs and clears the canvas for a clean restart.

**Spot-check in the browser:** confirm ~12 large translucent blobs drift, throb, and overlap from the first second; flip **Blend** through Translucent / Additive / XOR / Opaque and watch the overlap compositing change live; nudge **Speed** / **Speed limit** / **Elasticity** (all live) and **Blobs** (reinit); verify blobs bounce at the edges and never sail off; check `p` pause/resume doesn't jump and `r`/config-reset gives a clean screen.
