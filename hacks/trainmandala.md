# trainmandala — porter's notes

**"CC0: Quick hack on the train"**, by **mrange**, 2023. Shadertoy
[mtjyz1](https://www.shadertoy.com/view/mtjyz1), released **CC0** (public
domain). A kaleidoscopic mandala of nested rings and radial spokes that zooms
forever inward on a 10-fold-symmetric, log-spiral lattice, glowing in shifting
rainbow hues. The author's note: *"Travelling on the train I tried to recreate
some twitter art."* (Inspired by [this
tweet](https://twitter.com/SnowEsamosc/status/1688731167451947008).)
xscreensaver 6.x ships it as `hacks/glx/glsl/trainmandala.glsl`, run by its
`xshadertoy.c` driver.

This is a WebGL hack. For the full rationale behind running these natively on
**WebGL2 / GLSL ES 3.00** instead of porting `xshadertoy.c`, and behind the
**pointer-events:none overlay canvas** that keeps the host's shared 2D canvas
untouched, see **[starnest.md](starnest.md)** — the same shared `shadertoy.js`
harness drives both, and this module is the same thin shape (`title`, `info`,
the inlined shader, `start(canvas)`).

## Files

- `trainmandala.js` — the mountable module; all rendering lives in the harness.
- `trainmandala.glsl` — the original shader, copied verbatim, as provenance.
- (`shadertoy.js` — the shared, reusable WebGL2 harness; not a hack.)

## The two knobs

Harness-level only; the shader's own constants are untouched:

- **`speed`** — playback-rate multiplier on `iTime`, which here drives the
  zoom-and-rotate. Default `1.0`.
- **`resolution`** — render scale vs `devicePixelRatio` (`1` = crisp; lower
  trades sharpness for framerate). Default `1.0`.

## Deviations from the original

- **Shader:** none. Verbatim — the `SHADER` literal round-trips byte-for-byte
  against `trainmandala.glsl` (SHA1 `cb8558a0…`).
- **`iMouse`:** unused by this shader, so the harness's fixed `(0,0)` is moot.

## Shader-specific note

The visual structure comes entirely from a polar fold: the author works in
log-radius space (`zoom = log2(1.8)`, with `REV`/`FWD` mapping radius to and
from an exponential ring index), so rings are evenly spaced *in log space* and
the whole figure self-similarly zooms as `fract(TIME)` sweeps one ring-period.
`mod1` on the polar angle (period `TAU/10`) gives the 10-fold rotational
symmetry; two inner iterations stack a rotated copy for the lattice. It's
additive glow (`col += gcol*0.02/(gd+0.0001)`) over a dark field, inverted and
`sqrt`-toned at the end — cheap per pixel, no buffers, single pass.

## Verify

Parse-only: `cp hacks/trainmandala.js /tmp/trainmandala.mjs && node --check
/tmp/trainmandala.mjs`. Rendering can't be checked headlessly — open it via a
dev server (`python3 -m http.server`) and confirm a rainbow ring-and-spoke
mandala spiralling endlessly inward.
