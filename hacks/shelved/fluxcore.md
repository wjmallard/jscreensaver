# fluxcore — porter's notes

**Flux Core**, by otaviogood, 2015. Shadertoy
[ltlSWf](https://www.shadertoy.com/view/ltlSWf), **CC0** (public domain). A
single-pass distance-field ray-march that flies through a glowing fractal
reactor: nested carved cylinders spiral inward past rust-streaked struts and
orange wobbling tori toward a blazing energy beam at the core. xscreensaver 6.x
ships it as `hacks/glx/glsl/fluxcore.glsl`, run by its `xshadertoy.c` driver.

A WebGL hack, same shape as `starnest` — see **`starnest.md`** for the full
rationale on the shared `shadertoy.js` harness (native WebGL2 instead of a port
of `xshadertoy.c`) and the `pointer-events:none` overlay canvas. Only the
hack-specific bits are noted here.

## Files

- `fluxcore.js` — the mountable module: `title`, `info`, the inlined shader, and
  `start(canvas)`. Thin; all rendering lives in the harness.
- `fluxcore.glsl` — the original shader, copied verbatim, as provenance.

## Deviations from the original

- **Shader:** none. The `RayTrace` / `DistanceToObject` bodies, every `const`,
  and the whole camera fly-by timeline are exactly as the author wrote them. The
  inlined `SHADER` string is **byte-exact** with `fluxcore.glsl` (header comments
  and CC0 dedication included).
- **Added knobs** (harness-level, shader untouched):
  - `speed` — multiplies the playback rate; the camera animation is driven by
    `localTime = iTime`, which the harness scales. Default `1.0`. The fly-by
    loops on a 70-second cycle (`t6`), so at `1.0` it runs the full author tour.
  - `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
    sharpness for framerate). Default `1.0`. This shader is a **heavy
    raymarch** — up to **210** march steps per pixel, plus a 30-step sun-shadow
    trace and several octaves of 3D noise per hit (`RustNoise3D` adds 7 more) —
    so on a hi-DPI display this is the escape hatch if the framerate drops.
- **`iMouse` / `iFrame`:** the shader's mouse camera is behind `#ifdef
  MANUAL_CAMERA`, which is **off**, so `iMouse` is never read — the fixed
  cinematic camera path runs instead. `iFrame` is used only by `ZERO_TRICK`
  (`max(0, -iFrame)`, an always-zero loop-init guard); both uniforms are supplied
  by the harness, so nothing else is needed.

## Verify

Parse-only (syntax):
`cp hacks/fluxcore.js /tmp/fluxcore.mjs && node --check /tmp/fluxcore.mjs`.
Rendering can't be checked headlessly — open it in a browser via a dev server
(`python3 -m http.server`) and confirm a slow fly-through of a glowing
blue-and-orange fractal reactor with a bright beam down the center.
