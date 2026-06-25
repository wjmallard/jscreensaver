# neontriangulator — porter's notes

**Neon Triangulator**, by **mrange**, 2025. Shadertoy
[tXGGRD](https://www.shadertoy.com/view/tXGGRD), released **CC0** (public
domain). A synthwave ray-march flying down an endless neon corridor of
triangulated, reflecting prisms — glowing edges, a box pattern stamped on the
walls, and a setting sun on the horizon. xscreensaver 6.x ships it as
`hacks/glx/glsl/neontriangulator.glsl`, run by its `xshadertoy.c` driver.

This is a **WebGL hack** built on the shared `./shadertoy.js` harness; see
[`starnest.md`](starnest.md) for the full rationale on the harness, the overlay
canvas, and why we run the shader on WebGL2 / GLSL ES 3.00 rather than porting
`xshadertoy.c`. These notes only cover what's specific to this hack.

## Files

- `neontriangulator.js` — the mountable module: `title`, `info`, the inlined
  shader, and `start(canvas)`. Thin; all rendering lives in the harness.
- `neontriangulator.glsl` — the original shader, copied **verbatim**, as
  provenance.

## Shader

The `mainImage` body and every `#define` / `const` are **verbatim** from the
original — zero edits. The inlined `SHADER` string drops only the xscreensaver
`// Title:`/`// Author:`/`// URL:`/`// Date:`/`// Desc:` metadata header (the
same as `starnest.js` does), beginning at the shader's own `// CC0:` comment.
The shader is already pure ASCII with no backslashes, backticks, or `${`, so it
embeds in the JS template literal with no escaping. It reads no `iChannel`
samplers and is single-pass — exactly the harness's scope.

## Harness knobs (shader untouched)

- `speed` — multiplies the fly-through playback rate (scales `iTime`).
  Default `1.0`.
- `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
  sharpness for framerate). Default `1.0`.

## Shader-specific note

This is the **heaviest shader in the pool so far**: `render()` does up to
`MaxBounces` (4) reflective bounces, and each bounce runs a `MaxIter` (77) step
ray-march plus a finite-difference `normal()` (6 more field evals), over a
polar-folded distance field. On a high-DPI display the `resolution` knob is the
escape hatch if the framerate drags. `iMouse` is unused by the shader, so the
harness holding it at `(0,0)` is a no-op here. `reinit` / `r` jumps the clock to
a random offset; since the camera flies forward as `iTime` grows, that lands on
a fresh stretch of corridor.

## Verify

Parse-only (syntax): `cp hacks/neontriangulator.js /tmp/n.mjs && node --check /tmp/n.mjs`.
Rendering can't be checked headlessly — open it in a browser via a dev server
(`python3 -m http.server`) and confirm it looks like a neon synthwave flight
down a corridor of glowing triangular prisms toward a hazy sun.
