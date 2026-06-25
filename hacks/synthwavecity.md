# synthwavecity — porter's notes

**Synthwave City**, by 3w36zj6, 2022. Shadertoy
[7lKyDD](https://www.shadertoy.com/view/7lKyDD) — a reworking of Jan Mroz's
("jaszunio15") **Synthwave**, Shadertoy
[3t3GDB](https://www.shadertoy.com/view/3t3GDB), **CC BY 3.0** (the original's
license, which carries to this derivative). A retro-80s skyline drawn entirely
from signed-distance fields: a banded neon sun, a scrolling perspective grid,
and sixteen magenta skyscrapers sliding past through a pink-and-violet haze.
xscreensaver 6.x ships it as `hacks/glx/glsl/synthwavecity.glsl`, run by its
`xshadertoy.c` driver.

## Files

- `synthwavecity.js` — the mountable module: `title`, `info`, the inlined
  shader, and `start(canvas)`. Thin; all rendering lives in the harness.
- `synthwavecity.glsl` — the original shader, copied **verbatim**, as provenance.

The shared WebGL2 harness (`shadertoy.js`) and the overlay-canvas approach are
unchanged here; see **starnest.md** for the full rationale (why native WebGL2
rather than a port of `xshadertoy.c`, and why a GL hack overlays its own
`pointer-events:none` canvas instead of touching the host's shared canvas).

## Deviations from the original

- **Shader:** none. The `mainImage` body and every helper (`sdSkyscraper`,
  `sun`, `grid`) are byte-for-byte as the author wrote them — including the one
  accented character (`ó`) in the attribution comment.
- **Harness knobs** (shader untouched):
  - `speed` — multiplies the playback rate; the whole scene is driven off
    `iTime` (the grid scroll, the sun's scanlines, and the buildings' `mod`
    drift), so this simply scales how fast the city slides by. Default `1.0`.
  - `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
    sharpness for framerate). Default `1.0`.

## Shader-specific note

Pure 2D SDF compositing — no ray-march, no loop. Per-pixel cost is low (sixteen
`sdSkyscraper` evaluations plus the sun/grid), so it is far lighter than
starnest; the resolution knob is rarely needed. Note `sun()` and `grid()` take a
`battery` argument that is always `1.0`, and the scene loops on a 40-second
building cycle (`mod(... , 40.0)`).

## Verify

Parse-only (syntax): `cp hacks/synthwavecity.js /tmp/synthwavecity.mjs && node --check /tmp/synthwavecity.mjs`.
Rendering can't be checked headlessly — open it in a browser via a dev server
(`python3 -m http.server`) and confirm a neon sunset skyline with a scrolling
grid and drifting magenta towers.
