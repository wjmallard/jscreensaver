# gears -- design notes

Web port of xscreensaver's `gears` (Brian Paul 1996; rewritten by Jamie Zawinski,
2007), `xscreensaver-6.15/hacks/glx/gears.c` + the involute-tooth geometry library
`hacks/glx/involute.c`. A train of 3-7 interlocking gears with proper involute teeth;
1/8 of the time it's an epicyclic (planetary) cluster -- five gears inside an
internally-toothed ring, held by a three-armed spider armature. The whole assembly
tumbles and drifts. Self-contained three.js module: `start(canvas, opts) -> { stop,
pause, resume, getStats, reinit, config, params }`. **No assets** -- everything is
procedural (this is why gears, not pipes, was the right next geometry port: pipes
needs the 3264-line `pipeobjs.c` factory models + teapot).

## Shared gear geometry

The involute gear bodies are built by **`hacks/involute.js`** (a faithful port of
`hacks/glx/involute.c`), which `gears.js` and `moebiusgears.js` both import -- exactly
as the C hacks share `involute.c`. The DoubleSide / vertex-color-diffuse choices live
there. `gears.js` owns `gears.c`'s part: gear generation + placement, the planetary
cluster + armature, the scene/lighting, the loop.

## Faithfulness (the rule: do NOT deviate from the algorithm)

Transcribed from the `.c`, not approximated:

- **`involute.c` geometry, verbatim (now `hacks/involute.js`):** `gear_teeth_geometry`'s `r[]`/`th[]` tooth
  profile and the per-size point sets (`SMALL`/`MEDIUM`/`LARGE`/`HUGE`, bucketed by
  on-screen tooth pixels = `tooth_h * canvasHeight`); `tooth_normals`' **area-weighted**
  vertex normals (un-normalized face-normal cross products, then averaged -- three
  normalizes the final vector in-shader, so the weighting is preserved);
  `draw_gear_teeth` (outer rim = the teeth, inner rim = the hole, top/bottom annulus),
  `draw_gear_interior` (the inset disc / raised lip / third disc, or spokes),
  `draw_gear_nubs`. Inverted (internal-tooth) gears handled for the planetary ring.
- **`gears.c` generation, verbatim:** `new_gear` (tooth size/count/radius, the four
  interior shapes + their RNG gates, nubs), `place_gear` -- the gearing ratio, the
  half-tooth offset for odd tooth counts, and the exact `th` adjustment that lines a
  child's teeth up with its parent so they visibly **MESH** -- the no-overlap collision
  test, `planetary_gears` + `armature` (a faithful `unit_tube`/`unit_cone` port from
  `tube.c`, placed by the `tube()` transform, plus `arm()`).
- **Lighting, verbatim:** one white directional light from `(1,1,1)`; material specular =
  the light's cyan `{0,1,1}`, shininess 128; plus a `0.2*color` ambient floor -- GL's
  DEFAULT light-model ambient (0.2) x involute.c's `AMBIENT_AND_DIFFUSE` (= the gear
  color), added as `THREE.AmbientLight(white, 0.2*PI)` -- so unlit side walls are dim
  color, not pure black (matches gears.jpg). [Added 2026-06-28; I'd wrongly used 0.]
- **`draw_gears` modelview:** position (rotator) -> rotation with the fixed
  `x-=0.14, y-=0.06` tilt (this is what gives the classic receding-train view even with
  `-no-spin`) -> bbox center + fit to 10 units -> per-gear translate + `Rz(th)`.

Verified by CDP capture against `XScreenSaver_ Screenshots_files/gears.jpg`: pastel
per-gear colors, meshing involute teeth, ambient-0 lighting, the rim/inset/bore
structure, the receding train, and the planetary ring + armature (incl. the cyan
specular on the smooth axles) all reproduce. RNG (`yarandom.js`) + motion (`rotator.js`)
are the shared faithful util ports.

## Known, deliberate render-state choices (not algorithm changes)

- **`material.side = DoubleSide`.** Every gear/armature piece is a CLOSED opaque solid,
  for which DoubleSide is pixel-identical to GL's back-face culling -- and it removes all
  winding risk. The geometry is still emitted with **faithful winding** (GL vertex order,
  the per-block `glFrontFace` tracked, triangle reversed when it was `GL_CW`), so flipping
  the one `SIDE` constant to `THREE.FrontSide` gives the exact culled path.
- **Diffuse via VERTEX COLORS.** A gear uses two colors (`color` for the teeth/outer,
  `color2 = color*0.85` for the inset) -- the `.c` swaps them with `glMaterialfv` mid-mesh.
  One three material can't do that, so the per-region diffuse is baked into a vertex-color
  attribute; specular/shininess stay uniform (matching the `.c`, which sets those once).
- **Color management** is DISABLED (`THREE.ColorManagement.enabled = false`, module scope),
  so the port matches GL's fixed pipeline: the random pastel (`0.5+frand(0.5)`) vertex color
  is written RAW (the `setRGB(..., SRGBColorSpace)` becomes a no-op at fill time) and the
  output is not sRGB-encoded; light `intensity = PI` still cancels three's `1/PI` diffuse.
  This is the track-wide fix from the 2026 colour-management audit -- the sRGB-output
  convention rendered shaded faces ~2.5x too bright vs the originals' raw framebuffer.

## Pacing

Same model as `dangerball` (see `framerate-calibration` memory): render every rAF,
motion is continuous. `delay` (us) -> `effFps = 1e6/(delay + OVERHEAD)`,
`OVERHEAD = 37500` (xml default 30000 -> ~15fps effective). Gear spin
(`th += ratio*5*speed` per original-frame) advances continuously; the whole-scene rotator
is a discrete random-walk ticked once per original-frame and interpolated.

OPEN: `OVERHEAD` is inherited from dangerball's measured rate, not measured for gears
specifically (the gears demo video, youtube `OHamiC1tcdg`, would pin the spin rate). The
spin reads reasonable; recalibrate against that video if it feels off.

## Config (params transcribed 1:1 from hacks/config/gears.xml)

`delay` (Frame rate, 0-100000, def 30000, invert) - `speed` (Speed, 0.01-5.0, def 1.0) -
`count` (Gear count, 0-20, def 0 = random 3-7) - `wander` - `spin` - `wire` (Wireframe).
`count` rebuilds the train (not live); the rest are live. As in dangerball, "Frame rate"
is effectively a smooth speed control on the web.

See also: `dangerball.md`, `cubicgrid.md`; the `glx-geometry-track-triage` +
`framerate-calibration` memories.
