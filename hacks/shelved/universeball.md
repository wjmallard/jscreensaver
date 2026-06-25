# universeball — porter's notes

**Universe Ball 2**, by Matt Vianueva, 2025. Shadertoy
[WcGcWV](https://www.shadertoy.com/view/WcGcWV), **relicensed MIT** (by the
author's permission, 8-Mar-2026). A ray-marched, palette-cycled glass orb
suspended in a star-flecked void, inspired by @Jaenam's gem shaders.
xscreensaver 6.x ships it as `hacks/glx/glsl/universeball.glsl`, run by its
`xshadertoy.c` driver.

This is a WebGL hack: it runs on the shared `shadertoy.js` harness, which
prepends `#version 300 es` + `precision` + the standard Shadertoy uniform block
and drives `mainImage()` from one full-screen triangle. See `starnest.md` for
the full rationale on that harness and on why the GL hack overlays its own
`pointer-events:none` canvas instead of touching the host's shared canvas.

## Files

- `universeball.js` — the mountable module: `title`, `info`, the inlined shader,
  and `start(canvas)`.
- `universeball.glsl` — the original shader, copied **verbatim**, as provenance.

## Deviations from the original

- **Shader:** none. The `mainImage` body and the `PALETTE` `#define` are exactly
  as the author tuned them. The source is pure ASCII with no backslashes, so it
  inlines into the JS template literal byte-for-byte with zero escaping.
- **Added knobs** (harness-level, shader untouched):
  - `speed` — multiplies the playback rate (`iTime` is scaled around the
    shader's own `*.2` time factor). Default `1.0`.
  - `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
    sharpness for framerate). Default `1.0` — the usual escape hatch for a
    per-pixel ray-march on a high-DPI display.

## Shader-specific note

This is a dense single-pass ray-march: ~50 outer steps, each with a nested
folding loop, plus several `cos`/`length`/`tanh` calls per step. It is heavier
per pixel than Star Nest, so the `resolution` knob matters more here on weaker
GPUs. The shader ignores `iMouse`, so the harness leaves it at the origin.

## Verify

Parse-only (syntax):
`cp hacks/universeball.js /tmp/universeball.mjs && node --check /tmp/universeball.mjs`.
Rendering can't be checked headlessly — open it in a browser via a dev server
(`python3 -m http.server`) and confirm it looks like a glowing, slowly
color-shifting orb against a dark, sparkling field.
