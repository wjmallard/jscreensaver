# darktransit — porter's notes

**Dark Transit**, by Matt Vianueva ("diatribes"), 2025. Shadertoy
[WcdczB](https://www.shadertoy.com/view/WcdczB), **MIT-licensed** (relicensed by
the author's permission, recorded in the shader header). A "low tech tunnel": a
~28-step distance-march down a sinuous corridor with a glowing orb drifting just
off the camera path, the frame masked top and bottom by black cinema bars.

A WebGL hack, so the shared **WebGL2 harness** does all the work — see
`starnest.md` for the full rationale (why we run the shader natively on GLSL ES
3.00 instead of porting `xshadertoy.c`, and why each GL hack overlays its own
`pointer-events:none` canvas rather than touching the host's shared 2D canvas).
Those notes apply here unchanged.

## Files

- `darktransit.js` — the mountable module: `title`, `info`, the inlined shader,
  and `start(canvas)`. Thin; all rendering lives in `shadertoy.js`.
- `darktransit.glsl` — the original shader, copied verbatim, as provenance.

## The two knobs (harness-level; shader untouched)

- `speed` — multiplies the playback rate of the fly-through (scales `iTime`).
  Default `1.0`. The march speed is driven by `iTime` via the `T` macro, so this
  just slows or accelerates the trip down the tunnel.
- `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
  sharpness for framerate). Default `1.0`. A per-pixel 28-step raymarch is where
  a high-DPI display can cost you, so this is the escape hatch.

`iMouse` stays at `(0,0)` (the shader doesn't read it). `reinit`/`r` jumps the
clock to a random offset, landing further along the corridor.

## Shader-specific notes

- **Pure procedural, single-pass:** no `iChannel`/textures/multi-pass buffers —
  the whole image is the one raymarch loop. Verified single-pass before porting.
- **Verbatim, with one ASCII swap:** the `mainImage` body and every `#define` are
  exactly as the author tuned them. The source's trailing `/* ... */` blocks are
  the golfing-history alternates; they contain U+2192 arrows (`->`) and one
  line-continuation `\`. The inlined `SHADER` string renders those arrows as ASCII
  `"->"` so the template literal is pure ASCII, and escapes the two backslashes
  for the JS template literal — the runtime string round-trips byte-for-byte to
  `darktransit.glsl` (confirmed: equal length, 2 backslashes each, 0 non-ASCII).
  The verbatim `.glsl` on disk keeps the original arrows untouched.
- **Cinema bars:** the shader hard-masks `|u.y| > .375` to black, so the image is
  letterboxed by design — not a harness artifact.

## Verify

Parse-only (syntax): `cp hacks/darktransit.js /tmp/darktransit.mjs && node --check
/tmp/darktransit.mjs` -> `OK`. Rendering can't be checked headlessly — open it via
a dev server (`python3 -m http.server`) and confirm a dark, letterboxed corridor
flying past with a small bright orb weaving alongside.
