# noxfire — porter's notes

**Nox Fire**, by Matt Vianueva (`diatribes@gmail.com`), 2025. Shadertoy
[wfG3Dz](https://www.shadertoy.com/view/wfG3Dz), **relicensed MIT by
permission** (8-Mar-2026; the original Shadertoy default-licenses are not MIT,
so the in-tree relicense note is what we rely on). A tight per-pixel ray-march
straight down a pulsing, twisting tunnel of noise that reads as living flame
rushing past the camera. xscreensaver 6.x ships it as
`hacks/glx/glsl/noxfire.glsl`, run by its `xshadertoy.c` driver.

A WebGL hack like `starnest`. For the full rationale — why we run the shader
natively on **WebGL2 / GLSL ES 3.00** instead of porting `xshadertoy.c`, and the
`pointer-events:none` overlay-canvas trick that lets it coexist with the host's
shared 2D canvas — see **[`starnest.md`](starnest.md)**. The same shared
`shadertoy.js` harness runs both; only the inlined shader and the `info`/`title`
differ here.

## Files

- `noxfire.js` — the mountable module: `title`, `info`, the inlined shader, and
  `start(canvas)`. Thin; all rendering lives in the shared harness.
- `noxfire.glsl` — the original shader, copied **verbatim** (byte-for-byte) as
  provenance. The `SHADER` string in `noxfire.js` is the exact same bytes.
- The harness itself is `shadertoy.js` (shared, not a hack — do not edit).

## Deviations from the original

- **Shader:** none. The `mainImage` body is exactly as the author wrote it
  (including the commented-out `/* Original */` variant kept at the bottom of the
  file). The harness only prepends `#version 300 es` + `precision` + the standard
  Shadertoy uniform block and a `main()` that calls `mainImage`.
- **Added knobs** (harness-level, shader untouched), the same two as every
  WebGL hack here:
  - **`speed`** — multiplies the playback rate. The shader has no `speed`
    `#define` of its own (it drives everything off `iTime` directly), so this
    scales `iTime`; the whole tunnel-flow, turbulence, rotation, and radius
    pulse speed up or slow down together. Default `1.0`.
  - **`resolution`** — render scale vs `devicePixelRatio` (`1` = crisp; lower
    trades sharpness for framerate). Default `1.0`. With 100 march steps and an
    inner noise loop per pixel this is the useful escape hatch on a high-DPI
    display; the harness's adaptive-resolution fallback also leans on it.

## Shader-specific note

The brightness is built up as `o += 1./s` across the march and then squeezed
into range by a final `tanh(...)`, so the image is largely **self-exposing** —
`speed` changes the motion but not the overall look. `iMouse` is held at `(0,0)`
(unused by this shader), so there is no pointer interaction to preserve.

## Verify

Parse-only (syntax): `cp hacks/noxfire.js /tmp/noxfire.mjs && node --check /tmp/noxfire.mjs`.
Round-trip: the `SHADER` literal in `noxfire.js` equals `noxfire.glsl` byte-for-byte
(`sha256` of both, and a runtime template-eval compare, both match — 2068 bytes).
Rendering can't be checked headlessly — open it in a browser via a dev server
(`python3 -m http.server`) and confirm it looks like flame streaming down a
breathing tunnel.
