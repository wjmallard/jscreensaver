# hypnowheel -- design notes

Web port of xscreensaver's `hypnowheel` (Jamie Zawinski, 2008),
`xscreensaver-6.15/hacks/glx/hypnowheel.c`. Overlapping translucent spiral discs,
additively blended into a hypnotic concentric moire that spins and slowly wanders.
Self-contained WebGL2 module (NOT the shadertoy harness): `start(canvas) ->
{ stop, pause, resume, reinit, getStats, config, params }`.

## A DIRECT PORT (it replaced an approximated one)

The first version rode the shadertoy harness and **approximated** everything:
iTime-driven spin/twist, an in-shader cosine palette, baked params, and -- the bug
the user caught -- **no global wander** (the wheel sat dead center). Like
quasicrystal, a faithful port needs CPU state the iTime-only harness can't hold
(the rotators, the colormap), so it is self-contained: the real `rotator.js`
rotators + `colormap.js` colormap on the CPU, feeding one fragment shader that
evaluates the same per-pixel additive sum the `.c` rasterizes. See the
`port-faithfully-dont-reinvent` and `audit-past-ports` memories.

## The exact pipeline (transcribed from hypnowheel.c)

- **Global wander** -- a separate `make_rotator(0,0,0,0, speed*0.0025, False)`
  whose position drives `glTranslatef((x-0.5)*8, (y-0.5)*8)`. NOT gated by the
  `wander` option, so the wheel ALWAYS drifts. (Its spin speeds are 0, so its
  rotation is 0 -> no tilt -> the scene stays coplanar at z=0.)
- **Per-disc rotators** -- `make_rotator(s,s,s, 0.2, wander?w:0, True)`,
  `s = speed*0.2 + jitter`. In-plane spin only is used: `glRotatef(360*z)` about Z.
- **Twist** -- `twist = pos.z * twistiness * ((i&1)?1:-1)` (alternating sign ->
  counter-rotating spirals). With `wander` off, `pos.z` is a constant `0.5` -> a
  CONSTANT twist of `+/-2`; the apparent "fluctuation" is the counter-rotating
  spirals BEATING as they spin, not the twist changing.
- **Arm band** -- `count` arms, each a 50%-duty wedge (`dth/2` of `dth=2pi/n`)
  wound by `twist` turns over the radius (`2pi*twist*(r/rr)`, `rr=0.5`). In-shader:
  `band = smoothstep(-W, W, sin(arms*theta))` (`sin(a)>0 == fract(a/2pi) in [0,0.5)`).
- **Additive blend** -- `glBlendFunc(GL_ONE, GL_ONE)`; disc color =
  `colormap / cscale`, `cscale = 65536*(layers>3 ? layers-2 : 1)` (so for 4 layers
  each color is halved and overlaps bloom toward white). Summed per pixel, clamped.
- **Colors** -- a 1024-entry `make_smooth_colormap`, discs evenly spaced
  (`i*ncolors/layers`) and cycling (`color++` per frame).
- **Projection** -- 30deg perspective from z=30, `glScalef(45)`. Everything is
  coplanar (z=0), so perspective collapses to a uniform scale; the shader maps
  pixel -> world via `HALF_H = 30*tan(15deg)` and inverts `world = tGlobal +
  45*(tDisc + R(angle)*local)` per disc. No fudge constants.

## Two non-obvious things

- **`wander` defaults OFF (the .c default = the demo).** Off -> every disc's
  per-disc offset `(px-0.5)*0.1 *45` is 0, so all discs are CONCENTRIC: ONE wheel,
  one center, wandering via the global rotator. I first wrongly defaulted it ON,
  which gives each disc its own drifting center (several separate wheels) plus a
  slowly fluctuating twist -- the user spotted the extra centers against the demo's
  single one. Lesson: verify the DEFAULT against ground truth; don't guess which
  mode the demo uses.
- **`fwidth` clamp.** The edge AA uses `min(fwidth(arms*theta), 0.7)` -- `fwidth`
  spikes at the `atan` branch cut and the `r=0` singularity, which would wash a
  seam; `sin(arms*theta)` itself is continuous there because `arms` is an integer.

## Config (params 1:1 from hypnowheel.xml)

`count` (Arms 2-50, def 13) - `layers` (1-50, def 4) - `twistiness` (0.2-10, def 4)
- `speed` (0.1-20, def 1; a playback multiplier -- the .c scales all rotator rates
by speed) - `wander` (off) - `symmetric` (off; pairs discs share a rotator, .c
quirk: only i==0 ticks) - plus `resolution`. Motion runs at the .c's real (slow)
rates at speed 1.

Ground truth: jwz's demo video (youtube `QcJnc9EKJrI`). The colormap is random per
run (behavior, not a fidelity gap). See also `quasicrystal.md` (the same
self-contained direct-port pattern); `framerate-calibration`.
