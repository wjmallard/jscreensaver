# protophore — porter's notes

**Protophore**, by otaviogood, 2015. Shadertoy
[XljGDz](https://www.shadertoy.com/view/XljGDz), **CC0**. A four-level recursive
sphere fractal whose cubic "teeth" interlock and rotate, ray-marched with one
bounce of reflection and lit by a procedural overhead softbox (the author was
imitating sports-car photography lighting). xscreensaver 6.x ships it as
`hacks/glx/glsl/protophore.glsl`, run by its `xshadertoy.c` driver.

## Files

- `protophore.js` — the mountable module: `title`, `info`, the inlined shader,
  and `start(canvas)`.
- `protophore.glsl` — the original shader, copied verbatim, as provenance.
- `shadertoy.js` — the shared WebGL2 harness (this hack uses its single-pass path).

## Single-pass, despite the "iChannel" flag

Exactly as with `gimbalharmonics`: the only `texture(iChannel0, …)` calls live in
**commented-out** `GetEnvColor` helpers, while the live environment is the
procedural `GetEnvColor2`. No active texture reads → the harness's plain
single-pass path, no FBOs.

## Deviations from the original

- **Shader:** none. Verbatim. `RECURSION_LEVELS` is left at `4` and `SPLIT_ANIM`
  is left **undefined**, exactly as xscreensaver ships it (so the sphere spins as
  one body rather than splitting at the equator).
- **`iMouse`:** held at `(0,0)`; the camera auto-orbits via `iTime`.
- **Added knobs** (harness-level): `speed`, `resolution`. Both default `1.0`.

## Verify

Syntax: `node --check protophore.js`. Rendering: open via a dev server and
confirm a rotating, toothy chrome fractal sphere under a soft overhead key light.
