# quasicrystal -- design notes

Web port of xscreensaver's `quasicrystal` (Jamie Zawinski, 2013),
`xscreensaver-6.15/hacks/glx/quasicrystal.c`. Overlapping sine waves sum into an
ordered-but-aperiodic plane tiling -- a quasicrystal interference pattern that
slowly slides, breathes, and washes through color. Self-contained WebGL2 module
(NOT the shadertoy harness): `start(canvas) -> { stop, pause, resume, reinit,
getStats, config, params }`.

## This is a DIRECT PORT, and that mattered

First attempt was a shadertoy-harness "field shader" that re-expressed the math
as an idealized sum-of-rotated-gratings and then **tuned the frequency/motion by
eye**. It came out wrong in three ways the user immediately caught: too blurry
(fringe frequency guessed ~4x too low), "rotating" instead of sliding (I drove a
spin the original doesn't), and missing the color **wash** (I flattened the
colorize). The fix was to stop approximating and **transcribe the actual `.c`
pipeline** -- which needs CPU state (the rotators, the colormap), so it can't
live in the iTime-only shadertoy harness. Hence: self-contained, CPU sim + one
fragment shader that evaluates the exact per-pixel result.

Lesson (see the `port-faithfully-dont-reinvent` memory): exact reproduction, no
fudge constants; even a "small" simplification (dropping the colorize clamp)
erased a signature effect (the wash).

## The exact pipeline (transcribed, not approximated)

Per frame the CPU ticks `count` `rotator.js` rotators + a scale rotator and the
`colormap.js` smooth colormap (all faithful ports), exactly mirroring the `.c`'s
draw-loop read pattern, and uploads per-plane `(cos, sin, wanderX, wanderY)` +
`scale`. The fragment shader then does, per pixel:

1. **Density / mapping** -- `A = (fragCoord - 0.5*res) / (3*max(w,h))`, derived
   straight from the `.c`'s `glOrtho(0,1,1,0)` + reshape (isotropic, 1/max) and
   draw's outer `glScalef(3)` (the `/3`); y flipped. **No `GLOBAL_SCALE`, no
   aspect hack.** Each plane's texcoord `S = scale * (cos*(A.x-wx) + sin*(A.y-wy))`
   with `scale = 700/count * pscale`, `pscale = 1 + 4z`.
2. **Blend** -- `G = (0.5+0.5*sin(2pi*S))/count + G*(1 - 1/count)`, the `.c`'s
   `glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)` over a black clear (an EMA
   in plane order; spans ~[0,0.63], not a true mean).
3. **Colorize (THE WASH)** -- `col = clamp(2 * c' * G, 0, 1)`, the `.c`'s
   `glBlendFunc(GL_DST_COLOR, GL_SRC_COLOR)` (= `2*src*dst`) over the grayscale.
   `c' = 0.6666 + colormap/3` (a near-white brightening). The **clamp** is what
   blooms bright interference peaks to white as the colormap cycles -- the
   "washing out" effect. Dropping the 2x+clamp was the bug.
4. **Contrast** -- when `contrast > 0`, the `.c`'s `glLogicOp(GL_AND_REVERSE)`:
   `dst = src & ~dst` in 8-bit, `src = (1 - contrast/200)*255`. A literal
   **bitwise invert + mask** (GLSL `uvec3` ops), which inverts the field and
   posterizes it into banded tonal levels. NOT a smooth contrast curve.

The 1D sine texture (4096-sample, GL_LINEAR in the `.c`) is evaluated directly as
`sin()` -- the limit of that texture, perceptually identical.

## Motion (also faithful, also a surprise)

The `.c` builds spin with `make_rotator(0, 0, 0.01, ...)`, but the rotator's max
angular velocity (`d_max`) derives from the **X** speed, which is 0 here -- so
the spin clamps to **near-zero**. The real quasicrystal barely rotates; it mostly
**slides** (wander, very slow) and **breathes** (pscale 1->5, ~140s cycle). The
first port's obvious rotation was fabricated. Sim is ticked at the original's
effective rate (`1e6/(delay+OVERHEAD)`, ~15fps), not 60.

## Config (params 1:1 from quasicrystal.xml)

`count` (Density 7-37, def 17) - `contrast` (0-100, def 30) - `speed` (0.1-5,
def 1 -- NB `speed` is **vestigial in the .c**: parsed, never applied; wired as a
real playback multiplier here) - `spin` (Rotation) - `wander` (Displacement) -
`symmetric` (Symmetry) - plus `resolution`.

**Intentional default deviation:** `symmetric` defaults **OFF** (the `.c` default
is True). Symmetric = evenly-distributed angles -> jwz's regular rosettes;
off = independent per-plane angles -> a few grids sliding past each other, the
cooler "Hackers (1995)" look (user's call). Everything else matches the `.c`
defaults.

## Open item

Our render is more **posterized** than jwz's demo video (youtube `JsGf65d5TfM`) --
that banding is the literal `GL_AND_REVERSE`; the video likely smooths it via
compression. Couldn't confirm against the real GL hack (XQuartz blocks the GL
hacks locally). If a ground-truth local render shows it smooth, revisit the
contrast stage.

See also: `framerate-calibration`, `port-faithfully-dont-reinvent`,
`geometry-hacks-need-config` memories; `dangerball.md` / `cubicgrid.md` (the
other self-contained ports).
