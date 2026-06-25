# elementalring — porter's notes

**Elemental Ring**, by Otavio Good, 2016. Shadertoy
[MsVXDt](https://www.shadertoy.com/view/MsVXDt), **CC0 / public domain**. A
single-pass ray-march of three glowing braids twisting around a torus ring, lit
so the strands read like molten elemental energy, with a slow drifting orbit
camera. xscreensaver 6.x ships it as `hacks/glx/glsl/elementalring.glsl`, run by
its `xshadertoy.c` driver.

This is a WebGL hack; for the *why* of native WebGL2 (over porting
`xshadertoy.c`) and the *why* of the `pointer-events:none` overlay canvas, see
[`starnest.md`](starnest.md) — the same shared `shadertoy.js` harness and the
same host-owned-canvas constraint apply here unchanged.

## Files

- `elementalring.js` — the mountable module: `title`, `info`, the inlined shader,
  and `start(canvas)`. Thin; all rendering lives in the shared harness.
- `elementalring.glsl` — the original shader, copied verbatim, as provenance.

## Deviations from the original

- **Shader:** none. The `mainImage` body, every `#define`, and all the author's
  constants are exactly as tuned. The body is **byte-for-byte verbatim** with the
  `.glsl` (the inlined `SHADER` string was generated from the raw bytes, not
  hand-retyped, and round-trips byte-exact; it is pure ASCII to begin with, so no
  escaping was needed).
- **Two harness knobs** (shader untouched):
  - `speed` — multiplies the playback rate of the orbit + braid animation (the
    harness scales `iTime`). Default `1.0`.
  - `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
    sharpness for framerate). Default `1.0` — the usual escape hatch for a
    per-pixel ray-march on a high-DPI display.
- **`iMouse`:** held at `(0,0)`. The shader's mouse code is behind a
  `MANUAL_CAMERA` `#define` that is left off, so the automatic orbit camera runs
  and the pointer is ignored anyway.

## Shader-specific note

The `.glsl` carries an optional `NON_REALTIME_HQ_RENDER` block (stochastic AA +
motion blur for offline screenshot frames). It is `#define`-gated **off**, so the
realtime path (`localTime = iTime; RayTrace(fragCoord)`) is what runs — a single
ray-march pass per pixel, no extra cost. Left in place verbatim for provenance.

## Verify

Parse-only (syntax): `cp hacks/elementalring.js /tmp/e.mjs && node --check /tmp/e.mjs`.
Rendering can't be checked headlessly — open it in a browser via a dev server
(`python3 -m http.server`) and confirm it looks like a slow orbit around a ring
of three braided, glowing strands on a dark blue field.
