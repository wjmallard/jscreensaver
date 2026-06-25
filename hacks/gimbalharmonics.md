# gimbalharmonics — porter's notes

**Gimbal Harmonics**, by otaviogood, 2015. Shadertoy
[llS3zd](https://www.shadertoy.com/view/llS3zd), **CC0**. Fifteen discs nested
inside one another, each spun on its own axis so they sweep through harmonic
patterns around a hot-pink core — ray-marched and lit with a procedural studio
softbox. xscreensaver 6.x ships it as `hacks/glx/glsl/gimbalharmonics.glsl`, run
by its `xshadertoy.c` driver.

## Files

- `gimbalharmonics.js` — the mountable module: `title`, `info`, the inlined
  shader, and `start(canvas)`.
- `gimbalharmonics.glsl` — the original shader, copied verbatim, as provenance.
- `shadertoy.js` — the shared WebGL2 harness (this hack uses its single-pass path).

## Single-pass, despite the "iChannel" flag

When the GL pool was triaged, a grep for `iChannel` flagged this hack as needing
texture channels (the original Shadertoy bound `iChannel0` to a cube map for
reflections). But every `texture(iChannel0, …)` call here lives inside the
**commented-out** `GetEnvColor` / `GetEnvColorReflection` helpers — dead code the
compiler never sees. The live code lights the scene with `GetEnvColor2`, a fully
**procedural** softbox-plus-rim-light environment. So there are **no active
texture reads**: it runs on the harness's plain single-pass path, no FBOs, no
multipass machinery. (Its sibling `protophore` is the same story.)

## Deviations from the original

- **Shader:** none. The `mainImage` body and every constant are verbatim.
- **`iMouse`:** held at `(0,0)`; the camera auto-orbits via `iTime`, so a
  screensaver needs no pointer.
- **Added knobs** (harness-level, shader untouched): `speed` (scales `iTime`) and
  `resolution` (render scale vs `devicePixelRatio`). Both default `1.0`.

## Verify

Syntax: `node --check gimbalharmonics.js`. Rendering can't be checked headlessly;
open it via a dev server (`python3 -m http.server`) and confirm a slow churn of
nested chrome discs around a glowing pink core.
