# stripeytorus — porter's notes

**Saturday Torus**, by mrange, 2021. Shadertoy
[fd33zn](https://www.shadertoy.com/view/fd33zn), **CC0** (public domain). An
analytic ray-traced torus wrapped in scrolling black-and-white stripes, lit and
self-shadowing, that twists as the bands flow around it. xscreensaver 6.x ships
it as `hacks/glx/glsl/stripeytorus.glsl`, run by its `xshadertoy.c` driver.

This is another WebGL hack on the shared `shadertoy.js` harness — see
[`starnest.md`](starnest.md) for the full rationale (why native WebGL2 instead
of porting `xshadertoy.c`, and why a `pointer-events:none` overlay canvas
instead of touching the host's shared `<canvas>`). Those notes apply unchanged
here.

## Files

- `stripeytorus.js` — the mountable module: `title`, `info`, the inlined shader,
  and `start(canvas)`. Thin; all rendering lives in the harness.
- `stripeytorus.glsl` — the original shader, copied **verbatim**, as provenance.

## Deviations from the original

- **Shader:** none. The `mainImage` body and every `#define` are exactly as the
  author tuned them; the inlined `SHADER` string round-trips byte-for-byte
  against `stripeytorus.glsl`.
- **Added knobs** (harness-level, shader untouched):
  - `speed` — multiplies playback rate (the stripes flow via `iTime`, so this
    scales how fast the bands travel around the torus). Default `1.0`.
  - `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
    sharpness for framerate). Default `1.0`.

## Shader-specific note

Per pixel this solves a **quartic** (closed-form) for the camera-ray/torus
intersection, then a second torus solve for the shadow ray — heavier per-pixel
arithmetic than a plain SDF march, but bounded (no loop), so it's steady on
modern GPUs. The `resolution` knob is the escape hatch on a high-DPI display.
`iMouse` is unused by this shader; the camera is fixed and only the stripes
animate.

## Verify

Parse-only (syntax): `cp hacks/stripeytorus.js /tmp/stripeytorus.mjs && node --check /tmp/stripeytorus.mjs`.
Rendering can't be checked headlessly — open it via a dev server
(`python3 -m http.server`) and confirm it looks like a striped torus with the
black-and-white bands slowly twisting around it.
