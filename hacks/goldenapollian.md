# goldenapollian — porter's notes

**Golden apollian**, by Martin "mrange" Ranelius, 2021. Shadertoy
[WlcfRS](https://www.shadertoy.com/view/WlcfRS), released **CC0** (public
domain). A camera flight down a twisting tunnel of stacked planes, each etched
with a golden Apollonian-gasket fractal — an inversive packing of ever-smaller
circles — lit by a pair of drifting suns. xscreensaver 6.x ships it as
`hacks/glx/glsl/goldenapollian.glsl`, run by its `xshadertoy.c` driver.

This is a second WebGL hack on the same shared plumbing as
[`starnest`](starnest.md) — see those notes for the full rationale on the
**`./shadertoy.js`** harness (native WebGL2 / GLSL ES 3.00, no `xshadertoy.c`
port) and the **overlay canvas** (a GL hack must never touch the host's shared
2D canvas, so it lays its own `pointer-events:none` canvas over it). Nothing
about the host needs to change.

## Files

- `goldenapollian.js` — the mountable module: `title`, `info`, the inlined
  shader, and `start(canvas)`. Thin; all rendering lives in the harness.
- `goldenapollian.glsl` — the original shader, copied **verbatim**, as
  provenance.

## Deviations from the original

- **Shader:** none. The `mainImage` body, every `#define`, and the in-shader
  effect tables are exactly as the author tuned them. (The original already
  carries one upstream xscreensaver tweak: a `// jwz` comment where `fadeFrom`
  is pinned to `5`; that is part of the shipped `.glsl` and is preserved as-is,
  not something we added.)
- **Harness knobs** (shader untouched):
  - `speed` — multiplies the playback rate of the fly-through (we scale `iTime`).
    Default `1.0`. The motion is already gentle, so it is left at stock.
  - `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
    sharpness for framerate). Default `1.0`.
- **`reinit` / `r`:** jumps the clock to a large random offset, landing on a
  different stretch of tunnel — the GL analogue of reseeding a 2D hack.

## Shader-specific note

This is a **heavy** per-pixel shader: every pixel ray-marches up to **9 planes**
and, at each, folds an Apollonian gasket through **7 inversive iterations** plus
two shadow/light taps. That is far more arithmetic per fragment than a typical
2D plasma, and it scales with pixel count, so on a high-DPI display the
**`resolution`** knob is the real escape hatch — drop it to `0.5`–`0.75` if the
framerate dips. No exotic GLSL is used (the author's own `tanh_approx` stands in
for `tanh`, and a `const effect[]` array is indexed per plane); it compiles
cleanly on WebGL2 with the standard harness preamble.

## Verify

Parse-only (syntax):
`cp hacks/goldenapollian.js /tmp/goldenapollian.mjs && node --check /tmp/goldenapollian.mjs`.
Rendering can't be checked headlessly — open it in a browser via a dev server
(`python3 -m http.server`) and confirm it looks like a slow flight down a glowing
tunnel of golden, circle-packed rings on a dark sky.
