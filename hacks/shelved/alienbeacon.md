# alienbeacon — porter's notes

**Alien Beacon**, by **otaviogood**, 2014. Shadertoy
[ld2SzK](https://www.shadertoy.com/view/ld2SzK), **CC0 / public domain**. A
raymarched flight through a procedural alien canyon: ridged multi-octave spiral
noise sculpts rust-colored rock and "nickel tailings" water around a pulsing
green beacon sphere, while the sun drifts across the sky. xscreensaver 6.x ships
it as `hacks/glx/glsl/alienbeacon.glsl`, run by its `xshadertoy.c` driver.

A WebGL hack, same shape as [`starnest`](starnest.md) — see those notes for the
shared `shadertoy.js` harness and the overlay-canvas rationale (why a GL hack
gets its own `pointer-events:none` canvas over the host canvas instead of
reusing the host's locked 2D context). This file only covers what's specific to
Alien Beacon.

## Files

- `alienbeacon.js` — the mountable module: `title`, `info`, the inlined shader,
  and `start(canvas)`. Thin; all rendering lives in the shared harness.
- `alienbeacon.glsl` — the original shader, copied **verbatim** as provenance.
- (`shadertoy.js` is the shared harness, documented under `starnest.md`.)

## Deviations from the original

- **Shader:** none. The `mainImage` body, both `#define` toggles (`MOTION_BLUR`,
  `MOVING_SUN`), the hard-coded Catmull-Rom camera waypoints, and all tuning are
  byte-for-byte as the author left them. The source is pure ASCII with no
  backslashes/backticks, so it inlines into the JS template literal with **no
  escaping** (verified: runtime `SHADER` round-trips byte-exact vs the `.glsl`).
- **`iMouse`:** held at `(0,0)`. The shader exposes a mouse "debugging camera"
  (it offsets `camPos` and adds a yaw via `mx`); at the origin it sits on the
  authored fly-through, which is the intended screensaver view.
- **Two harness-level knobs** (shader untouched), the same pair as `starnest`:
  - `speed` — multiplies the playback rate; we scale `iTime` (the camera follows
    a 14-unit looping spline, and the sun/beacon are also driven by `iTime`).
    Default `1.0`.
  - `resolution` — render scale vs `devicePixelRatio` (`1` = crisp, lower =
    faster). Default `1.0`. **This is the important knob here:** the inner loop
    is up to 200 raymarch steps, each evaluating several octaves of spiral
    noise, plus normals/AO/shadow taps that re-evaluate the distance field — a
    genuinely heavy per-pixel cost. On a hi-DPI display that is the one place
    full resolution can drop frames, so this is the escape hatch (and the
    harness's adaptive scaler trims it automatically under load).

## Verify

Parse-only (syntax): `cp hacks/alienbeacon.js /tmp/alienbeacon.mjs && node --check
/tmp/alienbeacon.mjs`. Rendering can't be checked headlessly — open it in a
browser via a dev server (`python3 -m http.server`) and confirm it looks like a
slow flight through an orange rocky canyon with a glowing green sphere at the
center.
