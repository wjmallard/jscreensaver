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
Per-frame compositing of up to a few thousand 1-pixel segments, so it uses the **BLIT path** (a `Uint32Array` over a persistent `ImageData`), drawn into with **opaque** (no alpha) 1-px Bresenham segments — the canvas analogue of `XDrawSegments` with anti-aliasing off (`jwxyz_XSetAntiAliasing(..False)`). The trail mechanism is a **faithful transcription of `draw_euler2d`**, not a fade:
1. Build this frame's segment list `csegs` (`lastx → new screen position`), tracers (indices `Nvortex..N`) first, then vortex points; update `lastx`. Done every frame, including `count == 0` (which just seeds `lastx` and draws nothing).
2. Once `count > 0`: **erase** the frame from `eulertail` steps ago by re-stamping its stored segments in **black** (the C's ring buffer `old_segs[c_old_seg]`), then **draw** the current segments — tracers split into `ncolors` buckets with the C's exact partition `[floor(col·n/npix), floor((col+1)·n/npix))`, vortices in white — then **draw the boundary** on top (never stored, so never erased). Finally **store** `csegs` into the ring slot and advance `c_old_seg` (wrap at `eulertail`).
3. `putImageData` once per rAF frame, only when a step drew.

So a trail is full-brightness for exactly `eulertail` frames and then **hard-cut** (the oldest frame erased in black), exactly like the C — *not* an exponential fade. As in the C, the black erase can punch small holes where a newly-drawn trail crosses an about-to-be-erased one; that overlap artifact is faithful (it is what `XDrawSegments`-in-black does to the shared framebuffer).

## Faithful as of the 1C audit (2026-06-28)
This port was rebuilt during the Batch 1C fidelity audit. Earlier it (a) faded a persistent buffer toward black instead of the erase-ring, (b) used a **vivid full-saturation HSL rainbow** instead of `make_smooth_colormap`, (c) alpha-blended its lines, (d) approximated the colour bucketing with a per-segment inverse map, and (e) shipped reduced/calmed defaults. All five are corrected below.

- **Palette → `make_smooth_colormap`.** The standalone build sets `#define SMOOTH_COLORS`, so xlockmore builds the colormap via `make_smooth_colormap` **once at startup** (`xlockmore.c` `xlockmore_init`); `init_euler2d` never rebuilds it. We mirror that exactly: `makeSmoothColormapRGB(ncolors)` from `colormap.js`, built once in `init()` and **stable across flows** — only the boundary picks a fresh random colormap entry per flow (the C's `NRAND(MI_NPIXELS)`). These maps are often muted/pastel, **not** a rainbow. The even bucket-split across `ncolors` is the C's `col*n_non_vortex_segs/MI_NPIXELS` partition, now transcribed exactly (iterate colours, draw the segment range per colour).
- **Trails → erase ring (see Rendering).** Opaque draws, hard cutoff after `eulertail` frames.
- **`mod_dp2` evaluated at `sp->x`.** `derivs(x)` always calls `calc_all_mod_dp2(sp->x, …)`, i.e. the *current* positions, even on the midpoint method's intermediate `derivs(tempx)` call — the C passes `sp->x`, not the parameter. The port now does the same (it previously used the parameter, which perturbed the first integration step of every flow).
- **Mono path.** `ncolors <= 2` ⇒ `MI_NPIXELS <= 2` in the C, which draws every segment (and the boundary) white; reproduced.
- **Stock defaults restored** (see Config). The ring-buffer renderer removed the full-buffer fade scan, so the stock `count` 1024 is affordable.

## Remaining deviations from the C
- **Weird-aspect handling omitted.** The C clamps the working dimension and shifts (`xshift2`/`yshift2`) only when `width > 5·height` or vice-versa (lines 545-558). A browser window essentially never reaches 5:1, so this branch is unimplemented; on a pathological ultra-wide window the shape would scale to the full width. LOW / edge-case.
- **No `XSetLineAttributes` 3-px retina stroke.** The C bumps to 3-px round-cap lines above 2560 px (lines 560-562); we always use 1-device-px Bresenham. The buffer is full device resolution, so lines are crisp but thinner than the C on very large displays. LOW.
- **5-px screen margin scaled by dpr.** The fit-to-screen scale and circle radius reserve `5·devicePixelRatio` device px where the C reserves a flat `5.0`; a few device px difference at the window edge. Negligible.
- **`SUBTLE_PERTURB` / `DEBUG_POINTED_REGION` are compiled out in the C**, so only the plain `perturb` branch is ported (matching the shipped behaviour).
- **`eulerpower` slider.** `-eulerpower` is a real resource the C reads (`vars[]`/`opts[]`) but the **xml omits it**; it is exposed here as "Interaction power" because it meaningfully changes the look. Default `1` = classic Euler, which is also the only value that enables the polynomial boundary (`variable_boundary &= power == 1.0`).

## Correctness self-review (won't freeze / won't over-draw)
- **Velocity blow-up guard (the explicit risk):** the direct vortex term is zeroed when `|x-a|^(power+1) < 1e-4` (singular core), and a particle within `1e-5` of a *reflected* vortex is marked `dead` — both straight from the C. `perturb` additionally kills any particle whose step `|k|² > 0.1` or that reaches `|x|² > 1-1e-5` (outside the disk). So a particle near a vortex core can't produce a NaN/Inf position or a screen-spanning streak; it just dies. Verified by tracing every `dead[i] = 1` site against the C, and headlessly (600 frames incl. forced resets: lit-pixel count stays bounded at ~10% of screen — the erase ring works — and never wedges black for more than the 1-frame reset flash).
- **First-frame draw guard:** drawing is gated on `count > 0` exactly like the C. On `count == 0` the segment list is built (seeding `lastx` to real positions) but nothing is drawn/stored. `lastx` is also zeroed in `initFlow`; harmless since frame 0 overwrites it before any draw.
- **Termination / reset:** `count` increments every step and at `count > cycles` the buffer is cleared to black and `initFlow` re-seeds everything (`dead.fill(0)`, `nOldSegs.fill(0)`, `c_old_seg = 0`, fresh vortices/boundary/particles). The reset is unconditional on the step counter, so the live (non-dead) set being monotonically non-increasing within a flow can never wedge the sim into a blank-forever loop.
- **Adams-Bashforth priming:** `olddiffx` is filled by the midpoint method on the first step (`count < 1`) before AB2 reads it, and `.fill(0)` in `initFlow` as a backstop. The `diffx`/`olddiffx` pointer swap is reproduced with a JS reference swap.
- **Erase ring:** sized `eulertail · N · 4` ints, captured at `init()` (so `eulertail` is `live:false`, matching the C reading the resource once to size `old_segs`); clamped to `[1, cycles]` like `init_euler2d`. Reset each flow.
- **pause → resume:** `resume()` resets `lastTime = 0` so the lag accumulator doesn't fire a catch-up burst; buffer and sim state are untouched.
- **reinit / resize:** both clear to black and rebuild every array from the current `count`/`eulertail`, then roll a fresh flow.
- **Boundary index math:** the candidate-rotation extent loop uses Euclidean modulo for the `i % NR_ROTATES` / `i % (2·NR_ROTATES)` bucketing (JS `%` is sign-of-dividend); the forced-non-negative angles keep `i ≥ 0`, but the guard makes it robust.

## Config
Defaults/labels mirror `hacks/config/euler2d.xml` at the **stock** values: `delay` (µs/frame, default 10000, `invert` "Frame rate" slider showing raw µs), `count` (particles, 1024, max 5000), `eulertail` (trail length in frames, 10, max 500), `cycles` (steps before a new flow, 3000), `ncolors` (`make_smooth_colormap` size, 64). `power` is the xml-absent `-eulerpower` resource (default 1).
- **`live: true`** — `delay`, `cycles`: read every step, apply instantly (the C reads `MI_CYCLES` every draw).
- **`live: false`** — `count`, `eulertail`, `ncolors`, `power`: size the particle arrays / erase-ring / palette / flow type (`power == 1` enables the polynomial boundary), so a change re-runs `init()` via `reinit()` (which clears the canvas). `eulertail` is non-live because it sizes the erase-ring allocation, exactly as the C reads `eulertail` once to allocate `old_segs`.
- **Framerate calibration (`OVERHEAD = 8975`).** The stock `delay = 10000 µs` is only a sleep floor; the live binary's real rate is lower (delay + framework overhead). The live `-fps` overlay shows euler2d at **52.7 fps**, so the loop adds `OVERHEAD`: `10000 + 8975 = 18975 µs → 52.7 steps/sec`. A calibration, not a tuning knob — the `delay` slider stays 1:1 with the xml. See the framerate-calibration note.

## Needs live verification
The renderer is a **structural rebuild** (fade buffer → C ring-buffer erase) and the palette/defaults changed; verify against the live binary that trail length, colour feel (muted smooth map, not rainbow), and the boundary/vortex rendering match.
