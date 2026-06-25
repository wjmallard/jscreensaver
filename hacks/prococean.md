# prococean — porter's notes

**Very fast procedural ocean**, by afl_ext, 2017. Shadertoy
[MdXyzX](https://www.shadertoy.com/view/MdXyzX), **MIT-licensed**. A ray-marched
sea whose surface is built from summed octaves of `exp(sin(x))` waves (no noise,
no textures), lit by a cheap analytic atmosphere and a sun that drifts across the
sky. xscreensaver 6.x ships it as `hacks/glx/glsl/prococean.glsl`, run by its
`xshadertoy.c` driver.

A second WebGL hack on the shared `./shadertoy.js` harness — see
[`starnest.md`](starnest.md) for the full rationale (native WebGL2 / GLSL ES 3.00
instead of porting `xshadertoy.c`, and the `pointer-events:none` overlay canvas
that keeps the picker click reaching the host). Those notes apply unchanged; only
the hack-specific points are below.

## Files

- `prococean.js` — the mountable module: `title`, `info`, the inlined shader, and
  `start(canvas)`.
- `prococean.glsl` — the original shader, copied verbatim, as provenance.

## Deviations from the original

- **Shader:** none. The `mainImage` body and every `#define` are byte-for-byte the
  author's (trailing whitespace and all). The harness prepends only the
  `#version` / `precision` / Shadertoy uniform block; nothing in the body changed.
- **`iMouse`:** held at `(0,0)` by the harness. The shader normally lets the mouse
  orbit the camera; at `(0,0)` it sits at a fixed default heading and the camera
  still translates forward over the water as `iTime` grows, so it animates fine as
  an unattended screensaver.
- **Added knobs** (harness-level, shader untouched):
  - `speed` — multiplies the playback rate (scales `iTime`, which drives both the
    wave phase and the forward camera drift). Default `1.0`.
  - `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
    sharpness for framerate). Default `1.0`.

## Shader-specific notes

- **GPU cost:** heavier than `starnest`. The water path runs up to 64 raymarch
  steps, each summing 12 wave octaves (`ITERATIONS_RAYMARCH`), then one normal
  evaluation at 36 octaves (`ITERATIONS_NORMAL`) — so every water pixel is many
  hundreds of `exp`/`sin`/`cos`. On a high-DPI display the `resolution` knob is the
  escape hatch if framerate drops.
- **Built-in LOD:** the shader itself drops to a plain forward projection (no mouse
  rotation matrices) when `iResolution.x < 600.0`, so very small windows get a
  cheaper path automatically.

## Verify

Parse-only (syntax): `cp hacks/prococean.js /tmp/prococean.mjs && node --check /tmp/prococean.mjs`.
Rendering can't be checked headlessly — open it via a dev server
(`python3 -m http.server`) and confirm a sunlit, gently rolling blue ocean with a
moving sun glint.
