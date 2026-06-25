# euler2d — port notes

Port of `euler2d.c` by Stephen Montgomery-Smith (2000) — a 2D incompressible, inviscid (Euler) fluid simulation: a small set of point **vortices** induces a velocity field that **advects a cloud of tracer particles**, leaving streaky trails inside a curvy, polynomial-shaped boundary. After a while it rolls a brand-new flow (new vortices, new boundary).

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/euler2d.c` (~892 lines). See [[squiral]] for the shared skeleton and [[binaryring]]/[[interference]] for the blit idiom this one reuses.

## Algorithm
- **20 vortex points** carry a vorticity `w[j]` (some positive, some negative). Plus `count` massless **tracer particles**. Both vortices and tracers are advected; only the vortices induce velocity.
- **Velocity** at a point is the Biot-Savart sum over the vortices: each contributes `(x-a)` rotated 90° and divided by `|x-a|^(power+1)`. To confine the flow to the unit disk, each vortex also contributes a **reflection term** about the unit circle (`as = a/|a|^2`), so the normal velocity vanishes on the boundary.
- **Variable boundary**: the unit disk is mapped through a random degree-6 polynomial `p(z) = z + c2 z² + … + c6 z⁶` (coefficients normalised so `Σ k|c_k| = 1`, keeping `p` a bijection). The code searches 18 candidate rotations to fit the mapped shape to the screen, then renders particles at `p(z)·scale + shift` and divides each velocity by `|p'(z)|²` (the conformal-map metric correction). This only runs when `power == 1`; otherwise the domain is a plain circle.
- **ODE**: positions integrate with the **midpoint method** on the first step (to prime the history) then **Adams-Bashforth order 2** thereafter (`x += dt·(1.5 fₙ − 0.5 fₙ₋₁)`), with `delta_t = 0.001` (smaller for `power > 1`).
- **Trails**: the C keeps a ring buffer of the last `eulertail` frames of line segments and erases the oldest in black each frame. We instead **fade a persistent pixel buffer toward black** and stamp the new segments in — see *Deviations*.
- After `cycles` steps the whole flow is re-initialised (`init_euler2d`), which is when the boundary shape and vortex layout change.

## Rendering
Per-pixel compositing of up to a few thousand 1-pixel segments per frame, so it uses the **BLIT path** (a `Uint32Array` over a persistent `ImageData`), exactly like [[binaryring]]:
1. **Age** the buffer: multiply every pixel toward black by `fade = (1/255)^(1/eulertail)`, so a stamp decays to ~black over `eulertail` frames (the canvas analogue of the C's erase-the-oldest-frame ring buffer).
2. **Stamp** this frame's segments (`lastx → new position`) with a Bresenham alpha-blend: tracers split evenly across a vivid HSL rainbow (`ncolors` buckets, the C's `col*nsegs/ncolors` split), vortices in white, the boundary re-drawn each frame in a fixed rainbow colour so it stays crisp against the fade.
3. `putImageData` once per step.

## Deviations from the C
- **Trail decay via alpha-fade buffer instead of the erase ring buffer.** The C stores `eulertail` past frames of `XSegment` lists and `XDrawSegments` them in black to erase. Canvas has no cheap "redraw these exact lines in black", and an exponential fade is the idiomatic browser equivalent (and what [[binaryring]] does). Visually it's a smooth fade-out rather than a hard cut after exactly `eulertail` frames; `eulertail` still controls trail length. This is the one substantive rendering deviation.
- **Vivid rainbow palette** (`hsl(i·360/ncolors, 100%, 50%)`) replacing the original's `MI_PIXEL` colormap, per the project's aesthetic guidance. The even bucket-split across `ncolors` is preserved.
- **Reduced particle count** (`count` default 700, was 1024; max 3000, xml max 5000) and a **slightly calmer delay** (16000 µs vs the stock 10000). Each step is an `O(count·20)` Biot-Savart pass plus a full-buffer fade in JS, so the catch-up cap is low (`MAX_CATCHUP_STEPS = 3`). On a fast machine you can push `count` back up via the config box; flagged here as the main perf deviation.
- **No `XSetLineAttributes` 3-px retina stroke / no antialiasing toggle** — segments are 1-device-px Bresenham lines (the C disables AA too via `jwxyz_XSetAntiAliasing(..False)`), with dpr folded into the backing store so they stay crisp on retina.
- **`SUBTLE_PERTURB` and `DEBUG_POINTED_REGION` are both compiled out in the C**, so only the plain `perturb` branch is ported (matching the shipped behaviour).
- The xml exposes `ncolors` but the C reads it from `MI_NPIXELS`; we honour the slider directly. `eulerpower` (a command-line-only option, not in the xml) is exposed as an "Interaction power" slider since it changes the look meaningfully.

## Correctness self-review (won't freeze / won't over-draw)
- **Velocity blow-up guard (the explicit risk):** the direct vortex term is zeroed when `|x-a|^(power+1) < 1e-4` (singular core), and a particle that comes within `1e-5` of a *reflected* vortex is marked `dead` — both straight from the C. `perturb` additionally kills any particle whose step `|k|² > 0.1` or that reaches `|x|² > 1-1e-5` (outside the disk). So a particle near a vortex core can't produce a NaN/Inf position or a screen-spanning streak; it just dies. Verified by tracing every `dead[i] = 1` site against the C.
- **First-frame draw guard:** drawing is gated on `count > 0` exactly like the C. On `count == 0` the segment list is built (so `lastx` is seeded to real positions) but nothing is drawn, so there's no stray line from the zero-initialised `lastx`. `lastx` is explicitly zeroed in `initFlow` so frame 0 is deterministic, not garbage.
- **Termination / reset:** `count` increments every step and at `count > cycles` the buffer is cleared to black and `initFlow` re-seeds everything (`dead.fill(0)`, fresh vortices/boundary/particles). Particles only ever *die* within a flow (the live set is monotonically non-increasing), and the periodic reset is what revives them — no state can wedge the sim into an all-dead, blank-forever loop because the reset is unconditional on the step counter.
- **Adams-Bashforth priming:** `olddiffx` is filled by the midpoint method on the first step (`count < 1`) before AB2 ever reads it, and is `.fill(0)` in `initFlow` as a backstop. The diffx/olddiffx pointer swap is reproduced with a JS reference swap.
- **pause → resume:** `resume()` resets `lastTime = 0` so the lag accumulator doesn't fire a catch-up burst; the buffer and sim state are untouched, so it continues seamlessly.
- **reinit / resize:** both clear to black and rebuild every array from the current `count`, then roll a fresh flow — a clean screen, no leftover trails sized to the old buffer.
- **Boundary index math:** the candidate-rotation extent loop uses Euclidean modulo for the `i % NR_ROTATES` / `i % (2·NR_ROTATES)` bucketing (JS `%` is sign-of-dividend); in practice the forced-non-negative angles keep `i ≥ 0`, but the guard makes it robust.

## Config
Units/labels mirror `hacks/config/euler2d.xml`: `delay` (µs/frame, default 16000, `invert` "Frame rate" slider showing raw µs), `count` (particles, 700), `eulertail` (trail length in frames, 16), `cycles` (steps before a new flow, 3000), `ncolors` (rainbow buckets, 96), `power` (interaction-law exponent, 1 = classic Euler).
- **`live: true`** — `delay`, `eulertail`, `cycles`: read every step, apply instantly.
- **`live: false`** — `count`, `ncolors`, `power`: size the particle arrays / palette / flow type (`power == 1` enables the polynomial boundary), so a change re-runs `init()` via `reinit()` (which clears the canvas).
