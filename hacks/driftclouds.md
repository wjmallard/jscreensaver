# driftclouds — porter's notes

**2D Clouds**, by **drift**, 2016. Shadertoy
[4tdSWr](https://www.shadertoy.com/view/4tdSWr). Layered simplex-noise fractal
Brownian motion (ridged + plain octaves, plus two more noise fields for cloud
colour) drifting across a vertical blue sky gradient. xscreensaver 6.x ships it
as `hacks/glx/glsl/driftclouds.glsl`, run by its `xshadertoy.c` driver.

**License:** the author left a 2024 note on the Shadertoy page granting anyone
permission to use the shader "in any way that you choose. Credit would be nice
but I won't insist on it." So: free to use, attribution appreciated.

This is a WebGL hack, so it runs on the shared `./shadertoy.js` harness rather
than canvas2d. For the full rationale of that harness (native WebGL2 instead of
porting `xshadertoy.c`, and the `pointer-events:none` overlay canvas that never
touches the host's shared 2D context), see `starnest.md` — driftclouds reuses it
unchanged.

## Files

- `driftclouds.js` — the mountable module: `title`, `info`, the inlined shader,
  and `start(canvas)`. The shader body is **verbatim** from the original (built
  by inlining the raw `.glsl` bytes, so trailing whitespace is preserved); the
  only additions are two harness-level knobs.
- `driftclouds.glsl` — the original shader, copied verbatim, as provenance.

## The two harness knobs (shader untouched)

- `speed` — multiplies the playback rate of the drift. The shader has its own
  `const float speed = 0.03`; we scale `iTime` around it. Default `1.0`.
- `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
  sharpness for framerate). Default `1.0`. The fragment runs several fbm loops
  of simplex noise per pixel, so this is the escape hatch on a high-DPI display.

`reinit` / `r` jumps the clock to a random offset (a fresh patch of sky);
`pause` / `resume` are exact because the clock accumulates `dt * speed`.

## Shader-specific note

Pure ASCII, single-pass, no `iChannel` textures — a clean fit for the harness's
no-texture scope. It's a 2D screen-space effect (`fragCoord/iResolution`), so
`iMouse` is unused and the held-at-origin default is a no-op here. The author's
tunables are plain top-level `const`s (not `#define`s), left exactly as written.
