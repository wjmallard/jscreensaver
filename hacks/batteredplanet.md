# batteredplanet — porter's notes

**A battered alien planet**, by mrange, 2020. Shadertoy
[wsjBD3](https://www.shadertoy.com/view/wsjBD3), **CC0** (public domain). A
single-pass ray-march over procedurally noised alien terrain under twin suns,
with a banded gas giant looming on the horizon. xscreensaver 6.x ships it as
`hacks/glx/glsl/batteredplanet.glsl`, run by its `xshadertoy.c` driver.

A WebGL hack, same shape as `starnest` — see **`starnest.md`** for the full
rationale on the shared `shadertoy.js` harness (native WebGL2 instead of a port
of `xshadertoy.c`) and the `pointer-events:none` overlay canvas. Only the
hack-specific bits are noted here.

## Files

- `batteredplanet.js` — the mountable module: `title`, `info`, the inlined
  shader, and `start(canvas)`. Thin; all rendering lives in the harness.
- `batteredplanet.glsl` — the original shader, copied verbatim, as provenance.

## Deviations from the original

- **Shader:** none. The `mainImage` body, every `#define`, and all the tuned
  `const` colors are exactly as the author wrote them. The inlined `SHADER`
  string is **byte-exact** with `batteredplanet.glsl` (header comments included).
- **Added knobs** (harness-level, shader untouched):
  - `speed` — multiplies the playback rate of the fly-over (the camera advances
    with `iTime`); the harness scales `iTime`. Default `1.0`.
  - `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
    sharpness for framerate). Default `1.0`. This shader is a **heavy
    raymarch** — up to `MAX_ITER 65` steps per pixel, each sampling multi-octave
    value noise (`height` runs 4–8 noise octaves) — so on a hi-DPI display this
    is the escape hatch if the framerate drops.
- **`iMouse`:** held at `(0,0)`; the shader doesn't read it (the camera path is
  fixed), so there is nothing to drive.

## Verify

Parse-only (syntax):
`cp hacks/batteredplanet.js /tmp/b.mjs && node --check /tmp/b.mjs`.
Rendering can't be checked headlessly — open it in a browser via a dev server
(`python3 -m http.server`) and confirm a slow drift over a rocky orange alien
landscape with a big banded planet on the horizon.
