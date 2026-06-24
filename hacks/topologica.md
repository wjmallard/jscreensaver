# topologica — porter's notes

**Topologica**, by Otavio Good, 2014. Shadertoy
[4djXzz](https://www.shadertoy.com/view/4djXzz), released **CC0** (public
domain). A volumetric ray-march that steps through a low-frequency 3D
value-noise field ramped into sharp `1/x` pulses, yielding a slowly drifting
blue-violet tangle of glowing filaments. xscreensaver 6.x ships it as
`hacks/glx/glsl/topologica.glsl`, run by its `xshadertoy.c` driver.

## Files

- `topologica.js` — the mountable module: `title`, `info`, the inlined shader,
  and `start(canvas)`. Thin; all the rendering lives in the harness.
- `topologica.glsl` — the original shader, copied verbatim, as provenance.

## Reuses the shared harness

This rides on `shadertoy.js`, the reusable WebGL2 harness introduced with
**starnest** — same overlay-canvas approach, same "verbatim shader body, no
`xshadertoy.c` transcription" rationale. See `starnest.md` for the full write-up
of *why* WebGL was flagged infeasible (the host's single shared `<canvas>` is
locked to its `'2d'` context, so each GL hack overlays its own
`pointer-events:none` canvas) and why we run GLSL ES 3.00 on its home turf
rather than down-porting it. None of that is repeated here.

## The shader body is verbatim

Zero edits. Only the xscreensaver `// Title/Author/URL/Date/Desc` metadata header
is dropped from the inlined string (it feeds `info` instead); the author's CC0
license block, every constant, and the ray-march loop are exactly as written.
The harness prepends `#version 300 es`, `precision`, and the standard Shadertoy
uniform block, then calls `mainImage(color, gl_FragCoord.xy)` from `main()`.

The shader reads `iResolution`, `iTime`, `iMouse`, and `iFrame` — all supplied
by the harness preamble. `iFrame` is used only by the author's `ZERO_TRICK`
(`max(0, -iFrame)`), a constant `0` dressed up as a variable so the GLSL compiler
won't unroll the 37-step march. `iMouse` is held at `(0,0)`, its canonical
default orientation; the camera still drifts on its own via `iTime`.

## Harness knobs (shader untouched)

- `speed` — multiplies the playback rate of the drift (we scale `iTime`).
  Default `1.0`; left at stock — the motion is already a calm sway.
- `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
  sharpness for framerate). Default `1.0`. A 37-step ray-march with two 3D-noise
  lookups per step is GPU-bound on a high-DPI display, so this is the escape
  hatch. `reinit` / `r` jumps the clock to a fresh random offset.

## Verify

Parse-only (syntax): `cp hacks/topologica.js /tmp/topologica.mjs && node --check
/tmp/topologica.mjs`. Rendering can't be checked headlessly — open it in a
browser via a dev server (`python3 -m http.server`) and confirm it looks like a
slow drift through glowing blue-violet filaments on black.
