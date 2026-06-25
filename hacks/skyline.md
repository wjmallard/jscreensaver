# skyline — porter's notes

**Skyline**, by otaviogood, 2015. Shadertoy
[XtsSWs](https://www.shadertoy.com/view/XtsSWs), **CC0**. A procedurally generated
night city flown on rails: ray-marched skyscrapers with lit windows, cars with
glowing trails, and a hazy reflective skyline — all from analytic distance
fields. xscreensaver 6.x ships it as `hacks/glx/glsl/skyline.glsl`, run by its
`xshadertoy.c` driver. This is one of the **first two harness-v2 (multipass)
hacks** (with `neongravity`).

## Files

- `skyline.js` — the mountable module: `title`, `info`, the inlined shader, and
  `start(canvas)`.
- `skyline.glsl` — the original shader, copied verbatim, as provenance.
- `shadertoy.js` — the shared WebGL2 harness; this hack exercises its **multipass
  self-feedback** path.

## Self-feedback (`iChannel0` = its own previous frame)

Skyline reflects an environment in car bodies and glass:

```glsl
finalColor += saturate(texture(iChannel0, ref.xy).xyz - 0.35) * 0.15 * …
```

On Shadertoy, `iChannel0` was a **cube map**. xscreensaver can't load texture
assets, so `xshadertoy.c` binds the pass its **own previous frame** instead, and
we reproduce that exactly: the harness gives this pass a **ping-pong buffer**
(two textures) so it can sample last frame's output (`channels: { 0: 'self' }`)
while writing this frame's, then **blits** the result to the screen. The
reflections are therefore a soft feedback of the city onto itself — the same look
xscreensaver's binary produces.

## Deviations from the original

- **Shader:** verbatim, with one caveat that is **xscreensaver's own** edit, not
  ours: the cube-map lookups `texture(iChannel0, ref)` (a `vec3` direction) were
  changed to `texture(iChannel0, ref.xy)` because `texture(sampler2D, vec3)` is
  invalid in GLSL ES 3.00 / WebGL2. Both the original and the `.xy` line are
  present in `skyline.glsl` (the original is commented out, with jwz's note); we
  inline the file as shipped. `NON_REALTIME_HQ_RENDER` is left undefined.
- **`iMouse`:** held at `(0,0)`; the camera flies the city on its own via `iTime`.
- **Added knobs** (harness-level): `speed`, `resolution`. Both default `1.0`.
- Uses `dFdx`/`dFdy` for window-edge antialiasing — core in WebGL2, no shim.

## Cost

The heaviest of the four final ports — a long per-pixel city march plus the
feedback sample. If the adaptive-resolution scaler trims it below ~1.0× on a
given display, treat it like the `hacks/shelved/` "heavy" tier (set
`config.resolution` to its sustainable scale, and/or add `info.heavy: true`).

## Verify

Syntax: `node --check skyline.js`. Rendering: open via a dev server and confirm a
night-city fly-through with lit windows and softly reflective cars/glass; watch
the gallery's res/ms HUD to see where it settles.
