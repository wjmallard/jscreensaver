# bouboule

A breathing, rotating star-ball: a field of dots scattered on an invisible
sphere, rotated and squashed onto a pulsing ellipsoid and projected to 2D —
"a deforming balloon with varying-sized spots painted on its invisible surface."

## Source

Ported from `xscreensaver-6.15/hacks/bouboule.c` (859 lines), config
`hacks/config/bouboule.xml`. From xlockmore; code (c) 1996 Jeremie Petit,
3D support by Henrik Theiling (1996), standalone by jwz (1997).

## Algorithm

- **Stars.** `count` stars are scattered as unit vectors on a sphere: each gets
  an elevation `theta` and bearing `omega`, giving `(cos theta sin omega,
  sin omega sin theta, cos omega)`. Each star also gets a fixed base size:
  `NRAND(2*max)`, clamped to 0 below `max` else shifted down by `max` (so about
  half the stars are minimal and the rest spread `0..max`). Verbatim from the C.
- **SinVariable.** Every motion is a value oscillating `min..max` as
  `min + (max-min)*(sin(alpha)+1)/2`, with `alpha` advancing by `step` each
  frame. When `mayrand != 0`, the step is itself modulated by a *nested*
  SinVariable (`varrand`, range -70..70) that occasionally re-rolls — so the
  breathing/rotation never settle into a perfect loop. The recursion bottoms out
  because `varrand` is created with `mayrand == 0`. Eight of these drive the
  centre (x, y, z), the ellipsoid half-extents (sizex, sizey), and the three
  rotation angles (thetax, thetay, thetaz).
- **Per frame.** Vary all eight SinVariables (re-bounding sizex/sizey first so
  the ball can't run off an edge or get too flat/tall — `MAX_SIZEX_SIZEY = 2`),
  build the 3x3 rotation matrix from the three angles, then for each star apply
  the full rotation, scale x by `sizex` and y by `sizey`, and offset by the
  centre. The whole field is one slowly-cycling rainbow hue (a hue step every
  `COLOR_CHANGES = 50` frames, like the C's non-3D colour path).
- **3D mode** (`--3d`, off by default here): a per-star horizontal offset
  `diff = GETZDIFF(rotated_z)` shifts a red copy `+diff` and a blue copy `-diff`
  for red/blue glasses.

## Rendering

Sparse `fillRect` dots over a full black repaint each frame — matching the C's
`HAVE_JWXYZ` path, which `XClearWindow`s every frame under Quartz double-
buffering instead of erasing the previous arc list. At most `count` dots/frame,
so plotting the live points beats any per-pixel `ImageData` blit. See
[[galaxy]] (moving star dots) and [[spiral]] for the same sparse-dot idiom and
the rAF lag-accumulator loop.

## Deviations from the C

- **size-by-depth (added).** The C only varies a star's size for the stereo
  offset; the flat (non-3D) ball is drawn with each star at its fixed base size.
  The brief asks for "size pulsing by depth", so each dot is additionally scaled
  by the rotated z of its star — `radius * (1 + 0.55*depth)`, depth in [-1, 1]
  (near face +1, far face -1) — so the sphere reads as solid even in flat mode.
  `depth` is exactly the rotated-z unit-vector component the C already computes
  for `GETZDIFF`; the scaling row `[SY*CX, SX, CX*CY]` is unit-length, so depth
  is genuinely bounded to [-1, 1] (verified by hand: its squared norm collapses
  to `CX^2 + SX^2 = 1`).
- **Dots are squares, not disks.** The C's `XFillArcs(... 360*64)` draws filled
  circles; the brief calls for `fillRect`, so dots are filled squares centred on
  each star. At these sizes the difference is negligible.
- **GXor stereo blend -> 'lighter'.** In 3D the C composites the red and blue
  copies with `GXor` (install-mode). Canvas has no XOR raster op, so the two
  copies are drawn with `globalCompositeOperation = 'lighter'`, which likewise
  sums overlapping red+blue to magenta/white — the closest faithful stand-in.
- **Adaptive erase dropped.** The C benchmarks `XFillArcs`-erase vs.
  `XFillRectangle`-erase and keeps the faster (the `ADAPT_ERASE` / `USEOLDXARCS`
  machinery, old-arc lists, double buffers). None of it is needed: we clear the
  whole canvas to black each frame, which is what the Quartz path does anyway.
- **Colour: vivid rainbow.** Full-saturation HSL hue cycle (`hsl(h,100%,55%)`)
  rather than the original colormap; 3D defaults OFF so the single-hue ball (the
  signature look) shows by default. `delay` is 30000 us, a touch calmer than the
  stock 20000. (See the project's aesthetic-tuning note.)

## Correctness self-review

- **No termination/closure to get wrong.** bouboule never finishes — it breathes
  forever; `alpha` wraps at `2*PI` in `sinvary`. Full repaint each frame means
  there is no erase-list to desync and no over-draw accumulation, so the classic
  failure modes (dead lines / endless over-draw) can't occur here.
- **No NaN / divide-by-zero.** `sx.value` oscillates in `[W/4, 3W/4]`, so both
  `W - sx.value` and `sx.value` stay positive => the ellipsoid half-width `ex`
  stays positive; the depth divide guards `ex > 0` anyway. `sizey.maximum` is 0
  when first read in `init` (fresh struct, like the C's calloc), so the sizey min
  reduces to `sizex.value / 2` — matching the C exactly.
- **First frame is clean.** `init()` clears to black and seeds every SinVariable
  and star, then `draw()` only runs after at least one `simulate()` (`stepped`
  gate), so no star screen-coord is read before it is stamped. The ball is
  already mid-screen and well-formed on the first painted frame (no off-screen or
  degenerate start).
- **pause/resume/reinit.** `pause` cancels rAF (sentinel `rafId === 0`); `resume`
  resets `lastTime = 0` so no catch-up burst; `reinit` re-runs `init()` for a
  clean re-seeded screen. Verified the loop can't spin at `delay == 0` (the
  `MAX_CATCHUP_STEPS` counter bounds it).

See [[squiral]] for the canonical module skeleton this port follows.
