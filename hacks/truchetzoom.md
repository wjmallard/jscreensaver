# truchetzoom — porter's notes

**Another truchet experiment**, by mrange, 2024. Shadertoy
[4cBcDy](https://www.shadertoy.com/view/4cBcDy), released **CC0** (public
domain). An infinitely self-similar truchet weave that zooms forever down a
golden-ratio (phi) "boxed spiral" while a Smith-chart conformal warp swirls the
whole tiling, so the pattern endlessly folds into itself. xscreensaver 6.x ships
it as `hacks/glx/glsl/truchetzoom.glsl`, run by its `xshadertoy.c` driver.

A WebGL hack like `starnest`. See **`starnest.md`** for the full rationale behind
the shared harness, the overlay-canvas trick, and why we run the shader natively
on WebGL2 / GLSL ES 3.00 rather than porting `xshadertoy.c` — all of which apply
here unchanged.

## Files

- `truchetzoom.js` — the mountable module: `title`, `info`, the inlined shader,
  and `start(canvas)`. Thin; all rendering lives in the shared harness.
- `shadertoy.js` — the **reusable** WebGL2 harness (shared, not a hack). NOT
  edited.
- `truchetzoom.glsl` — the original shader, copied **verbatim**, as provenance.

## The shader

**Verbatim** — the `mainImage` body and every `#define` (including the `DISTORT`
conformal warp) are exactly as the author tuned them, zero edits. The whole image
is analytic signed-distance math evaluated per pixel: a recursive phi-scaled
boxed-spiral coordinate (`boxySpiralCoord`) tiles the plane, `transform()`
distorts it through a Smith-chart map driven by `iTime`, and segment/badSquare
SDFs draw the foreground/background truchet arcs with anti-aliasing. No textures,
no multi-pass buffers, no CPU-side simulation.

One shader-specific note: the source already carries a small author tweak marked
`// jwz` (the scanline `thickness` term in `mainImage`) — that is part of the
upstream xscreensaver file and is kept as-is.

## The two knobs (harness-level, shader untouched)

- **`speed`** — multiplies the playback rate. The shader animates everything off
  `iTime` (the zoom cadence and the warp), so this scales the entire motion.
  Default `1.0`.
- **`resolution`** — render scale vs `devicePixelRatio` (`1` = crisp; lower
  trades sharpness for framerate). Default `1.0`. The per-pixel SDF/AA cost makes
  this the escape hatch on a high-DPI display.

`reinit` / `r` jumps the clock to a random offset, landing on a different phase
of the zoom; `pause`/`resume` and the live sliders behave as in `starnest`.

## Verify

Parse-only (syntax): `cp hacks/truchetzoom.js /tmp/truchetzoom.mjs && node --check
/tmp/truchetzoom.mjs`. Rendering can't be checked headlessly — open it in a
browser via a dev server (`python3 -m http.server`) and confirm it looks like a
black-and-white truchet weave endlessly zooming and swirling into itself.
