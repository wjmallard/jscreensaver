# stardome -- porter's notes

**Stars and galaxy**, by **mrange**, 2022. Shadertoy
[stBcW1](https://www.shadertoy.com/view/stBcW1), **CC0** (public domain). A
procedural night sky cast on the inside of a dome: several layers of twinkling
stars tinted by blackbody temperature, a tilted spiral galaxy, a lit crescent
moon, and a faint horizon grid, all swept by a slowly rotating camera.
xscreensaver 6.x ships it as `hacks/glx/glsl/stardome.glsl`, run by its
`xshadertoy.c` driver.

This is a follow-up to the project's first WebGL hack; it reuses the same
shared harness. For the full rationale of *why* native WebGL2 (and not a port of
`xshadertoy.c`) and *why* the GL hack draws on its own `pointer-events:none`
overlay canvas rather than the host's shared `<canvas>`, see
[`starnest.md`](starnest.md). The short version: WebGL2 speaks GLSL ES 3.00, the
same dialect Shadertoy targets, so the shader body runs **verbatim** behind a
thin wrapper that only prepends `#version`, `precision`, and the Shadertoy
uniform block.

## Files

- `stardome.js` -- the mountable module: `title`, `info`, the inlined shader,
  and `start(canvas)`. The shader body is copied **byte-for-byte** from the
  `.glsl` (trailing whitespace and `f`-suffixed float literals included); only
  the original's leading `// Title/Author/URL/Date` metadata block is dropped,
  leaving the CC0 license header at the top of the string.
- `stardome.glsl` -- the original shader, copied verbatim, as provenance.
- Renders via the shared `shadertoy.js` harness (unchanged, not edited here).

## Knobs (harness-level; the shader's `#define`s are untouched)

- **`speed`** -- playback-rate multiplier on the camera sweep. Left at the
  default `1.0`. Note the shader's clock is `mod(iTime, 30.0)` with a 4s fade-in
  and a fade-out near 30s, so the scene loops on a ~30s cycle regardless of
  speed; the knob just changes how fast it gets there. `reinit`/`r` jumps the
  clock to a random offset within that loop.
- **`resolution`** -- render scale vs `devicePixelRatio` (`1` = crisp, lower =
  faster). **Recommended escape hatch on hi-DPI displays:** every pixel evaluates
  a handful of fbm noise octaves across five star layers plus the galaxy, so
  fill rate is the cost here. Dropping to `~0.5`-`0.75` on a Retina panel
  recovers framerate with little visible loss.

## Verify

Parse-only (syntax): `cp hacks/stardome.js /tmp/stardome.mjs && node --check
/tmp/stardome.mjs`. Rendering can't be checked headlessly -- open it in a
browser via a dev server (`python3 -m http.server`) and confirm a deep-blue
star-strewn dome with a pale galaxy band and a small lit moon, drifting slowly.
