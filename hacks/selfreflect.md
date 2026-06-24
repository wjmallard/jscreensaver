# selfreflect — porter's notes

**"Let's self reflect"**, by **mrange**, 2024. Shadertoy
[XfyXRV](https://www.shadertoy.com/view/XfyXRV), released **CC0** (public
domain). A single Platonic solid — built from a knighty-style polyhedral fold
([MsKGzw](https://www.shadertoy.com/view/MsKGzw)) — is ray-marched and traced
through a glassy inner sphere, so its mirrored facets reflect into themselves
bounce after bounce. xscreensaver 6.x ships it as
`hacks/glx/glsl/selfreflect.glsl`, run by its `xshadertoy.c` driver.

This is a second WebGL hack and runs on the **same** shared harness as the
first; the harness, overlay-canvas, and "why native WebGL2, not a port of
`xshadertoy.c`" rationale are all written up once in **`starnest.md`** — read
that for the shared machinery. These notes only cover what's specific here.

## Files

- `selfreflect.js` — the mountable module: `title`, `info`, the inlined shader,
  and `start(canvas)`. Thin; all rendering lives in the shared `shadertoy.js`.
- `selfreflect.glsl` — the original shader, copied **verbatim** as provenance.

## Shader

**Verbatim** — the `mainImage` body and every `const`/`#define` are exactly as
the author tuned them (zero edits). The inlined copy in `selfreflect.js` is the
raw `.glsl` bytes embedded directly in the template literal, so the string
between the backticks round-trips **byte-for-byte** identical to
`selfreflect.glsl` (verified by `cmp`; same md5). The `.glsl` is pure ASCII with
no backslashes/backticks/`${`, so no template-literal escaping was needed.
`iResolution` / `iTime` (aliased to `RESOLUTION` / `TIME` in the shader) and the
rest of the Shadertoy uniform block are supplied by the harness preamble.

## The two knobs (harness-level; shader untouched)

- `speed` — multiplies the playback rate; here that scales `iTime`, which the
  shader feeds straight into the solid's `rotation_speed`, so it just speeds up
  or stills the tumble. Default `1.0`.
- `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
  sharpness for framerate). Default `1.0`.

## Shader-specific note — this one is **heavy**

Each pixel runs an outer march (`MAX_RAY_MARCHES3 = 90`) and then up to
`MAX_BOUNCES2 = 6` refracted/reflected **inner** bounces, each its own 50-step
march (`MAX_RAY_MARCHES2`). That's a lot more work than Star Nest, so on a
high-DPI display the **`resolution` knob is the real escape hatch** — and the
harness's adaptive-resolution fallback will trim scale on its own under load.
The author also notes the inner reflections alias unless run at very high
resolution ("just run fullscreen on a 4K screen"), which is the same trade-off
the knob exposes.

## Verify

Parse-only (syntax): `cp hacks/selfreflect.js /tmp/selfreflect.mjs && node --check /tmp/selfreflect.mjs`.
Rendering can't be checked headlessly — open it in a browser via a dev server
(`python3 -m http.server`) and confirm it looks like a slowly tumbling, glassy
faceted solid mirroring into itself against a soft blue-violet box.
