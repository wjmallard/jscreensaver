# logarithmiccircles -- porter's notes

**B/W logarithmic circles II**, by **mrange**, 2023. Shadertoy
[mljcWR](https://www.shadertoy.com/view/mljcWR), released **CC0** (public
domain). A black-and-white field of circular rings placed on a *logarithmic*
(`exp2`) radial grid, eight-fold mirrored via a polar fold and slowly
counter-rotated; because the rings scale outward with the same `exp2` law that
positions them, the whole pattern breathes self-similarly and loops forever.

A standalone WebGL hack, the same shape as [`starnest`](starnest.md). See
`starnest.md` for the full rationale behind the shared `shadertoy.js` harness
(native WebGL2 / GLSL ES 3.00, **not** a port of `xshadertoy.c`) and the
`pointer-events:none` overlay-canvas trick that lets a GL hack coexist with the
host's shared 2D canvas. Nothing here departs from that pattern.

## Files

- `logarithmiccircles.js` -- the mountable module: `title`, `info`, the inlined
  shader, and `start(canvas)`. Thin; all rendering lives in `shadertoy.js`.
- `logarithmiccircles.glsl` -- the original shader, copied **verbatim**, as
  provenance.

## Shader

**Verbatim** from `hacks/glx/glsl/logarithmiccircles.glsl` -- the `mainImage`
body and every tuning constant (`ExpBy = log2(4.1)`, `Radius = 0.3175`, the
8-fold `modPolar`) are exactly as the author wrote them. Zero edits. The only
header dropped from the inlined copy is the `// Title/Author/URL/Date/Desc` block
(the `.glsl` keeps it); the harness supplies `iResolution`/`iTime`/`iMouse`.

The shader is single-pass and texture-free, so it runs directly on the harness
as-is. It's also cheap (no ray-march -- just a log/exp radial remap and a polar
fold per pixel), so the adaptive-resolution path in the harness will keep it
pinned at full resolution on any modern GPU.

## Knobs (harness-level, shader untouched)

- **`speed`** -- multiplies the playback rate (`iTime`). The animation is driven
  by `tm = 0.2*iTime`, so this just scales how fast it breathes/rotates. Default
  `1.0`.
- **`resolution`** -- render scale vs `devicePixelRatio` (`1` = crisp; lower
  trades sharpness for framerate). Default `1.0`.

`reinit` / `pause` / `resume` behave as in the harness (random clock offset on
reinit; exact pause via accumulated `dt * speed`).

## Verify

Parse-only: `cp hacks/logarithmiccircles.js /tmp/lc.mjs && node --check /tmp/lc.mjs`.
Rendering needs a browser (`python3 -m http.server`) -- expect crisp white rings
on black, arranged in concentric log-spaced bands, mirrored into 8 sectors and
slowly turning.
