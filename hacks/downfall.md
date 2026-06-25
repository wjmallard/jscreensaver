# downfall — porter's notes

**Downfall**, by Matt Vianueva (`diatribes@gmail.com`), 2025. Shadertoy
[w3sBWl](https://www.shadertoy.com/view/w3sBWl), **relicensed MIT** by the author
(permission noted in the shader header, 8-Mar-2026). A tiny golfed ray-march down
a churning, tunnel-like cascade: each step folds space with an inner sine loop, so
bright falling sheets streak past the camera. xscreensaver 6.x ships it as
`hacks/glx/glsl/downfall.glsl`, run by its `xshadertoy.c` driver.

A WebGL hack on the shared `shadertoy.js` harness. See **[starnest.md](starnest.md)**
for the full rationale — why we run native WebGL2 / GLSL ES 3.00 instead of porting
`xshadertoy.c`, and why the harness paints its own `pointer-events:none` overlay
canvas rather than touching the host's shared `<canvas>`. None of that is repeated
here; it is identical.

## Files

- `downfall.js` — the mountable module: `title`, `info`, the inlined shader, and
  `start(canvas)`. Thin; all rendering lives in the harness.
- `downfall.glsl` — the original shader, copied **verbatim** (byte-for-byte), as
  provenance.
- `shadertoy.js` — the shared harness (not edited).

## Deviations from the original

- **Shader:** none. The `mainImage` body is exactly as the author wrote it. It is
  pure ASCII with no backslashes/backticks, so it inlines into the JS template
  literal with no escaping (the `const SHADER` string round-trips byte-exact vs
  `downfall.glsl`). The harness prepends `#version 300 es` + `precision` + the
  Shadertoy uniform block, so `SHADER` carries none of those.
- **Added knobs** (harness-level, shader untouched), the same two as every
  `shadertoy.js` hack:
  - `speed` — multiplies the playback rate (we scale `iTime`). Default `1.0`.
  - `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
    sharpness for framerate). Default `1.0` — the escape hatch for a high-DPI
    display, since the 100-step march is the real per-pixel cost here.
- **`reinit` / `pause` / `resume`:** as provided by the harness (reinit jumps the
  clock to a fresh random offset; pausing is exact because the clock accumulates
  `dt * speed`).

## Shader-specific notes

- Single-pass, **no `iChannel`/texture** reads — in scope for the harness as-is.
- Uses the GLSL ES 3.00 builtins `tanh()` (tone-mapping the accumulator) and
  comma-operator statement chaining; both are fine under WebGL2 / GLSL ES 3.00, and
  are the reason this needs the ES-3.00 harness rather than a GLES2 rewrite.
- `iMouse` is unused by the shader, so the harness holding it at `(0,0)` changes
  nothing.

## Verify

Parse-only (syntax): `cp hacks/downfall.js /tmp/downfall.mjs && node --check /tmp/downfall.mjs`.
Rendering can't be checked headlessly — open it in a browser via a dev server
(`python3 -m http.server`) and confirm it looks like a fast plunge down a glowing,
sine-rippled chute.
