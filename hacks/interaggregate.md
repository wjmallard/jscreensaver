# interaggregate — port notes

Port of `interaggregate.c` (David Goldfarb / dagraz, 2004; based on j.tarbell's "Intersection Aggregate", complexification.net, and the `substrate` port; xscreensaver machinery by Jamie Zawinski) — a field of slowly drifting circles whose pairwise **intersection points** are dabbed with faint grainy "sand painter" strokes that accumulate into pale pencil-like interference webs. See [[squiral]] for the shared skeleton, [[braid]] for the arc/geometry idioms, and [[greynetic]] for the additive-alpha-onto-a-persistent-canvas idiom.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/interaggregate.c` (~988 lines)

## Algorithm
Despite the name, nothing ever draws the circles themselves. Each frame:
1. **Move** every disc (`moveCircles`). Most discs (`percentOrbits` controls the split) are LINEAR: they drift in a straight line at a fixed slow velocity (each component in `[-0.25, 0.25)` px/frame) and wrap at the screen edges. The rest ORBIT an anchor disc (or the screen centre), stepping an angle `theta` by `dtheta ~ 1/r`. With the default `percentOrbits 0`, every disc is linear.
2. **Intersect** every pair (`drawIntersections`). Two discs cross when the centre distance `d` lies strictly between `|r1-r2|` and `r1+r2`; the two crossing points are found by the standard radical-line construction (`d1` along the centre line to the radical midpoint, `d2` the half-chord perpendicular to it).
3. **Paint** between those two points with all three of the first disc's **sand painters** (`paint`). A sand painter lays 11 mirrored pairs of single points along the segment at parametric position `sin(p ± sandp)`, where `sandp` fans out by `gain·0.1` per step and the per-point intensity tapers `0.1 → 0.001`. Its `gain` and phase `p` jitter every call (gain bounded by `±max_gain`). The result is a soft grainy dab clustered near one point of the segment.

Strokes are never erased, so the **aggregate** of every past intersection builds up — the buildup IS the effect. After `maxCycles` frames (or on resize) the buffer is wiped and a fresh field reseeded.

## Rendering approach
Sparse additive splats, like [[greynetic]]: the persistent canvas is the accumulation buffer. Each sand-painter point is one device pixel painted with `ctx.fillRect(x, y, 1, 1)` at an `rgba()` low alpha. The C alpha-blends each point into an offscreen `off_img` (`trans_point`: `new = old + (src - old)·a`); canvas `source-over` with that same alpha is exactly that blend, so no readback / ImageData buffer is needed. A frame is a few thousand 1px fills (≤ ~22 points × 3 painters × intersecting pairs), which is cheap.

## Palette & background (faithful — the fidelity fix, 2026-07-01)
The C has **one** colour source: a fixed 7-entry table `rgb_colormap[]` extracted from
`pollockEFF.gif` — `#FFFFFF`, two blacks, olive `#4e3e2e`, camel `#694d35`, tan `#b0a085`,
`#e6d3ae` — parsed once in `build_colors`; each sand painter picks one entry at random for
its life (`frand(0.999) * numcolors`). The background is the stock `.background: white`
(cleared to `bgcolor` on init / resize / `maxCycles`), so the muted strokes alpha-blend as
**pale pencil on white paper**, matching the xml blurb ("Pale pencil-like scribbles slowly
fill the screen"). This port is now a **verbatim** port of that table on white.

An earlier draft inverted this: it defaulted to a black background with an **invented**
`palette: 'rainbow'` — a vivid full-saturation HSL ramp sized to the disc count — with the
real Pollock map demoted to an opt-in `'pollock'` select. That is exactly the systemic
vivid-rainbow bug (the C has no palette resource at all). **Removed 2026-07-01**: the
`palette` select and its `hslToRgb` helper are gone, the background is white, and the
Pollock table is the only colormap (Rule 1 — a fixed table is already faithful; Rule 3 —
drop invented knobs). Canvas `source-over` at the per-point alpha reproduces the C's
`trans_point` lerp (`new = old + (src-old)·a`) exactly, so on opaque white paper the blend
matches byte-for-byte.

## Other deviations from the C
- **The C's `paint` `p`-clamp is kept verbatim**: `if (0 < painter->p) painter->p = 0;` pins `p` to 0 whenever it drifts positive (almost always), so in practice `p ≈ 0` and the point cluster sits at/around the segment's first intersection point rather than sweeping its length. This looks like a bug in the original, but reproducing it is what gives the authentic scribble texture, so it is **intentionally preserved** (and noted in code).
- **`growthDelay` → `config.delay`** drives the rAF lag-accumulator instead of the C's per-frame return value; identical pace at any refresh rate, with a catch-up cap. Stock default `18000 µs` kept, and the loop paces at `(delay + OVERHEAD)` (not raw delay) so the port runs at the live binary's fps — `OVERHEAD` is the live-measured **13850 µs** (live 31.4 fps, Load 43.4%, clean at stock delay 18000; the O(n²) pair scan makes it heavier than the sparse-vector norm). `max_gain 0.22` (the C's `f->max_gain`, previously exposed as an invented `gain` knob) is now the hardcoded `MAX_GAIN` const.
- **`devicePixelRatio` (`S`)** scales radii, drift speed, orbit radii, and line widths; the backing store is sized in device pixels (crisp on retina). Angular speed `dtheta` and the `radius = 5 + frand(min(55, r))` cap are computed in *logical* px (`r/S`) so the look is dpr-independent. **Fixed 2026-07-01**: the ORBIT base-disc radius `1 + frand(minDim/2)` was double-scaled by `S` (`minDim` is already device px), so orbiters swung ~`dpr`× too wide on retina; now `S + frand(minDim/2)`. Latent only — the default `percentOrbits 0` never enters the ORBIT branch.
- **Added knobs** not in the stock UI (the xml exposes only frame rate + disc count + fps): `percentOrbits`, `baseOrbits`, `baseOnCenter`, and `maxCycles` — all **real Xrm resources / command-line options** in the `.c` (`-percent-orbits` / `-base-orbits` / `-base-on-center` / `-max-cycles`), just omitted from the stock xml UI, so they are kept (Rule 3 allows `.c/.xml` resources). All default to the stock values, so the default look is unchanged. `count`'s slider min is `50` to mirror the xml `low="50"` (the C's hard minimum is 2).
- **Edge wrapping** uses the C's active `#else` branch (wrap x,y to `[0,W)`/`[0,H)` for both path types), not the `#if 0` radius-aware version.

## Correctness self-review
- **First frame is non-degenerate**: 100 discs are seeded at random positions across the whole canvas with radii 5–60 px·S, so many overlap immediately and intersections paint from frame one — no blank start, nothing off-screen.
- **No null anchor deref**: orbit anchors only ever index *earlier* discs (`circles[floor(p·i)]`, `p<0.9`, `i<n`) or the base block `circles[floor(frand(orbitStart-0.1))]` ∈ `[0, orbitStart)` — all already built. With the default `percentOrbits 0` the ORBIT branch is never entered and every `center` is null, but `moveCircles` only reads `center` on the ORBIT path, so it's never dereferenced. Verified by hand for the 0 / partial / 100 cases.
- **Reset fires**: `cycles` increments every frame and the `cycles >= maxCycles` wipe+reseed is reachable (`maxCycles` min 1000, and the `!== 0` guard only matters for the unreachable 0 case). `resize()` also reseeds via `init()`. So the screen periodically refreshes and never silently freezes.
- **Intersection guards**: the pair test rejects `d >= r1+r2` (disjoint) and `d <= |r1-r2|` (one inside the other) before the construction, and the half-chord sqrt is clamped `max(0, r1²-d1²)` against tiny negative round-off, so no `NaN` coordinates leak into `drawPoint`.
- **Pause/resume**: `pause()` cancels the rAF and parks `rafId = 0`; `resume()` resets `lastTime = 0` before re-arming so the banked `lag` can't fire a catch-up burst. `reinit()` wipes to white paper and re-seeds with the current config (count/orbit changes take effect cleanly).
- **`drawPoint` torus wrap** uses `while` loops (a point can land arbitrarily far out of bounds after the `(b-a)·sin` extrapolation), matching the C's `while (x >= width) x -= width;` so coordinates always resolve into the buffer.
