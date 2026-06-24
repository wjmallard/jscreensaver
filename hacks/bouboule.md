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
  half the stars are minimal and the rest spread `0..max`). The size is FIXED
  per star — the C never resizes a dot frame to frame. Verbatim from the C.
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
  centre (the C's `arc->x`/`arc->y`, truncated to short). In flat (non-3D) mode
  the whole field is one colour from a `make_smooth_colormap`, stepped one entry
  every `COLOR_CHANGES = 50` frames (the C's non-3D colour path).
- **3D mode** (`--3d`, the STOCK DEFAULT — `*use3d:True`): a per-star horizontal
  offset `diff = GETZDIFF(rotated_z)` shifts a red copy `+diff` and a blue copy
  `-diff` for red/blue glasses. The colormap is unused in this mode (only red /
  blue / overlap magenta).

## Colour (faithful)

bouboule.c is compiled with `SMOOTH_COLORS`, so the xlockmore framework
(`xlockmore.c`, `color_scheme_smooth`) allocates one `make_smooth_colormap` of
`ncolors` (default 64) entries: a random loop of 2-5 HSV anchor points, often
muted/pastel. The flat-mode ball shows one entry at a time and steps slowly
through the loop, so it drifts gently across nearby hues. We build that palette
with the shared faithful helper `makeSmoothColormapRGB(ncolors)` from
`colormap.js` (rebuilt per `init()`). When `ncolors <= 2` the colormap is mono
and the ball is white — matching the C's `MI_NPIXELS > 2` gate.

(An earlier port used a vivid full-saturation `hsl(h,100%,55%)` rainbow — the
systemic palette deviation this audit corrects.)

## Rendering

Sparse filled-disk dots (`ctx.arc`, one per star) over a full black repaint each
frame — matching the C's `XFillArcs(... 0..360)` (filled circles) and its
`HAVE_JWXYZ` path, which `XClearWindow`s every frame under Quartz double-
buffering instead of erasing the previous arc list. Each disk's bounding box is
exactly the C's `[x, y, 2+size, 2+size]`, with the top-left shifted back by the
full `star->size` when nonzero (so the C's slight off-centre placement is
reproduced). At most `2*count` small disks/frame — trivially cheap. See
[[galaxy]] (moving star dots) and [[spiral]] for the same sparse-dot idiom and
the rAF lag-accumulator loop.

## Deviations from the C

- **GXor stereo blend -> 'lighter'** (platform). In 3D the C draws the red copy
  then the blue copy; in install/PseudoColor mode it uses `GXor` so the overlap
  ORs to the configured `both3d = magenta`. Canvas has no XOR raster op, so the
  two copies are composited with `globalCompositeOperation = 'lighter'`, which
  likewise sums overlapping red+blue to magenta — the designed anaglyph. Note
  the C's NON-install (TrueColor) path is `GXcopy` (plain source-over, last copy
  wins -> blue overlap); `lighter` favours the designed `both3d` intent. If live
  verification shows the demo video uses the GXcopy/blue-overlap look, switch the
  3D branch to the default `source-over` op.
- **Adaptive erase dropped** (platform). The C benchmarks `XFillArcs`-erase vs
  `XFillRectangle`-erase and keeps the faster (the `ADAPT_ERASE` / `USEOLDXARCS`
  machinery, old-arc lists, double buffers). None is needed: we clear the whole
  canvas to black each frame, which is what the Quartz path does anyway.
- **No `size` slider** (config). The `.xml` exposes only delay / count / ncolors
  / 3d. `*size` (15) is a real resource but jwz never surfaced a slider for it,
  so it stays a fixed constant here, matching the stock UI. (Likewise `*delta3d`
  = 1.5 is an internal constant; the `.xml` exposes no slider.)
- **delay default = stock 20000 us + OVERHEAD calibration** (pace). The rAF lag-
  accumulator runs one `simulate()` per `(delay + OVERHEAD)` of wall-clock time.
  The default `delay` is the **stock 20000 us** (the slider maps 1:1 to the .xml
  resource), and the loop adds a fixed `OVERHEAD = 6738 us` so the *effective*
  rate matches the live binary rather than the nominal `1/delay`. Measured against
  the live `-fps` overlay bouboule runs **37.4 fps**, while the port at the stock
  delay ran ~50/s (1.34× fast); `20000 + 6738 = 26738 us → 37.4/s`, matching the
  binary. A calibration, not a tuning knob — see the frame-rate-calibration note.
  (An earlier revision used a by-eye default of 30000 us.)
- **resize re-seeds fully** (platform). The C's `reshape_bouboule` keeps the
  stars, colormap and most SinVariables and only re-bounds the centre x/y to the
  new size. The port re-runs `init()` on resize (re-scatters the stars and
  rebuilds the smooth colormap). Resize is rare and the re-seed is harmless, but
  it is not a 1:1 transcription of `reshape_bouboule`.

## Correctness self-review

- **No termination/closure to get wrong.** bouboule never finishes — it breathes
  forever; `alpha` wraps at `2*PI` in `sinvary`. Full repaint each frame means
  there is no erase-list to desync and no over-draw accumulation, so the classic
  failure modes (dead lines / endless over-draw) can't occur here.
- **No NaN / divide-by-zero.** `sx.value` oscillates in `[W/4, 3W/4]`, so both
  `W - sx.value` and `sx.value` stay positive => the ellipsoid half-width stays
  positive; the per-star math no longer divides by it (the added depth-scaling,
  which did, has been removed). `sizey.maximum` is 0 when first read in `init`
  (fresh struct, like the C's calloc), so the sizey min reduces to
  `sizex.value / 2` — matching the C exactly.
- **First frame is clean.** `init()` clears to black and seeds every SinVariable
  and star, then `draw()` only runs after at least one `simulate()` (`stepped`
  gate), so no star screen-coord is read before it is stamped. The ball is
  already mid-screen and well-formed on the first painted frame.
- **pause/resume/reinit.** `pause` cancels rAF (sentinel `rafId === 0`); `resume`
  resets `lastTime = 0` so no catch-up burst; `reinit` re-runs `init()` for a
  clean re-seeded screen. The `MAX_CATCHUP_STEPS` counter bounds the loop even at
  `delay == 0`.

See [[squiral]] for the canonical module skeleton this port follows, and
[[swirl]] for another `make_smooth_colormap` 2D port.
