# lockward -- design notes

Web port of xscreensaver's `lockward` (Leo L. Schwab, 2007),
`xscreensaver-6.15/hacks/glx/lockward.c`. A translucent "light show": `NSPINNERS=4`
independent rings, each `NBLADES=12` flat pie-wedge "blades" of random inner/outer
radii sharing one slowly colour-cycling colour, spinning to quantized stops then idling
then re-spinning; plus periodic white "blink" flashes (radial / concentric / segment
patterns) that BRIGHTEN whatever blades they overlap. "A cross between the wards in an
old combination lock and those old backlit information displays that animated and
changed colour via polarized light." Self-contained three.js: `start(canvas, opts) ->
{ stop, pause, resume, getStats, reinit, config, params }`. **Asset-free.**

It is a 2D/flat blade show drawn in 3D, so unlike the rest of the geometry track it is
**UNLIT** -- the `.c` never enables `GL_LIGHTING`; it draws `glColor` wedges. Hence
`MeshBasicMaterial` + no lights, orthographic, depth-test off, blending on.

## Faithfulness (the rule: do NOT deviate from the algorithm)

Transcribed from `lockward.c`:

- **Blade geometry (`gen_blade_arcs` / `draw_blink_blade`):** a blade is a 30-degree
  (`2pi/NBLADES`) annular wedge centred at 3 o'clock, a 14-vertex `GL_TRIANGLE_FAN` --
  7 outer-arc points at radius `outer+1` (angles `+15..-15`), then 7 inner-arc points at
  radius `inner+1` (angles `-15..+15`), `SUBDIV=6` steps of `5` deg. Radii indices `0..7`
  map to radii `1..8`, so there is always a central hole of radius 1 (visible in the
  ground truth). The fan triangulation is replicated exactly.
- **Spinners (`init_lockward` / `draw_lockward`):** each ring bakes its 12 blades into a
  local geometry at slots `360*i/12` with per-blade random radii (`outer != inner`,
  forced `outer > inner`), all one colour; the ring's `mesh.rotation.z` is
  `(rot - rotcount*rotinc)`. The four rings are painted `n = 3,2,1,0` then the blink --
  reproduced with `renderOrder` (every mesh is at `z=0`, so three cannot depth-sort the
  coincident transparent meshes; `renderOrder` is its primary transparent-sort key).
- **Spin schedule (`random_blade_rot`):** rotate `dist*30` deg (`dist` 1..12, sign
  random) over `rotcount` frames -- a max of 6 sec per division, min 1 sec -- then idle a
  random `rotateidle` interval, then re-spin. Approaching the target by subtracting
  `rotcount*rotinc` lands it exactly with no drift, and stays continuous across the
  spin -> idle -> re-spin transitions.
- **Colour cycle:** per-ring 128-entry `make_smooth_colormap` (`colormap.js`); `ccolor`
  is n.4 fixed point (`ncolors << 4 = 2048`) advanced by `colorinc` in `{-16..-1, 1..16}`
  (never zero); shown index `= ccolor >> 4`.
- **Blinks (`random_blink` + the 6 drawfuncs, 10 `BTYPE`s):** radial single / random /
  seq / doubleseq, segment single / random / scatter, concentric single / random / seq.
  The unused-blade / unused-ring bitmask reuse, the sequential `(counter*dir + val)`
  sweep, the doubleseq symmetric pair, the `ffs` run-finding over the
  `random()&random()&0x7F` scatter noise, and `set_alpha_by_dwell` (decay `dwellcnt/dwell`
  vs sharp = full until the last quarter then 0) are all transcribed. Blink colour is
  white; the blend is `glBlendFunc(GL_DST_COLOR, GL_SRC_ALPHA)` => `dst*(1+alpha)`, a
  **brightening** flash (`THREE.CustomBlending`, `DstColorFactor`/`SrcAlphaFactor`),
  vs the spinners' default `glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)` at alpha
  `0.5` (`NormalBlending`). Verified on screen: a radial flash lights its wedge toward
  white where it overlaps the brighter blades.
- **Camera (`reshape_lockward`):** `glOrtho` fitting the radius-8 figure to the SHORT
  axis -- landscape `[-8*aspect, 8*aspect] x [-8, 8]`, portrait mirrored. An
  `OrthographicCamera` on `+Z` looking at the origin, so a CCW `glRotatef` about Z reads
  CCW on screen as in GL.
- **RNG (`yarandom.js`):** init draws in the `.c`'s order (spinners `i=3..0`; per spinner
  `random_blade_rot`, then `colorinc`, then `make_smooth_colormap`, then blades `n=11..0`)
  for structural parity; `random() % n` / `& m` transcribed verbatim.

`GL_CULL_FACE` + `glFrontFace(GL_CW)` is replaced by `THREE.DoubleSide`: for this
always-face-on flat figure the cull hides nothing (the `.c`'s outer-before-inner fan
order is exactly so the blade is *not* culled), and being unlit there are no normals to
worry about, so two-sided is equivalent and simpler.

## Pacing / config

Pacing as across the track: render every rAF, continuous motion; `effFps =
1e6/(delay + OVERHEAD)`, `OVERHEAD = 37500`; each render-frame advances every rotation /
countdown / colour by `frames = dt*effFps`, and the discrete spin/blink EVENTS fire when
their timers elapse (the blink dwell is checked once per render-frame, matching the
`.c`'s once-per-frame drawfunc). The spinner spin/idle transitions are consumed in a
small loop so a slow frame can't desync them.

- **`fps` for the ms->frame conversions.** The `.c` hardcodes `ctx->fps = 60` (with a
  literal `WTF?` comment over the disabled `1000000/MI_DELAY` line) to convert the
  millisecond `rotateidle` / `blinkidle` / `blinkdwell` bounds and the "6 sec per
  division" rule into frame counts, while it actually renders at the `delay` rate. Here
  those conversions use `effFps`, so the configured millisecond durations are honoured in
  real time (a "1000 ms" idle is ~1 s, a `dist`-division spin takes 1..6*`dist` s). At the
  original's `delay 20000` (`~50fps` nominal, no overhead) its `fps=60` assumption made
  durations run ~20% slow; `effFps` lands them on the nominal seconds, which is closer to
  intent than the literal-60 behaviour.
- **OPEN:** `OVERHEAD = 37500` is the track's family default, not a per-hack measurement
  (the GL originals are runtime-blocked here). If the spin/blink cadence reads off, pin it
  against jwz's demo video (youtube `MGwySGVQZ2M`); no eyeball-tuning otherwise.
- **Colour space:** three's colour management is **disabled** (`ColorManagement.enabled =
  false`), matching GL's fixed pipeline (no sRGB encoding), so spinner colours (`setRGB`,
  now a no-op) and the white blink are written RAW to the 8-bit drawbuffer -- so the alpha
  and the brightening blends happen on the raw `glColor` values, matching the original's
  naive (colour-management-free) blending rather than blending in linear.

## Knobs / omissions

Config transcribed 1:1 from `hacks/config/lockward.xml`: `delay` (inverted),
`rotateidleMin`/`rotateidleMax`, `blinkidleMin`/`blinkidleMax`,
`blinkdwellMin`/`blinkdwellMax` (all ms), and the `blink` toggle. Omitted: `showFPS`
(host chrome); the spacebar/tab key that toggles the additive `glBlendFunc(GL_ONE,
GL_ONE)` blend mode (keyboard chrome, not in the `.xml`; we keep the default
normal-alpha mode the screensaver always starts in); and the `width > height*5` "tiny
window" viewport-offset branch of `reshape`.

Verified by CDP capture (headless) vs `lockward.jpg`: concentric annular-wedge blade
rings with the central hole, four independently-rotating translucent spinners (visible
overlap darkening + per-run `make_smooth_colormap` palettes), continuous rotation, and
the white blink brightening flashes -- all reproduce, exception-free. The ground truth's
green/blue palette is one RNG roll; each run draws fresh palettes.

See also: `dangerball.md`, `superquadrics.md`, `morph3d.md`; the
`glx-geometry-track-triage` + `framerate-calibration` memories.
