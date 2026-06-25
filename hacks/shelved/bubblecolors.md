# bubblecolors — porter's notes

**Bubble Colors**, by Matt Vianueva (`diatribes@gmail.com`), 2025. Shadertoy
[wcGXWR](https://www.shadertoy.com/view/wcGXWR). A short, heavily golfed
fragment shader: it ray-marches a rising column of soft, color-banded blobs
while `cos` ripples wash tints across the churning field. xscreensaver 6.x ships
it as `hacks/glx/glsl/bubblecolors.glsl`, run by its `xshadertoy.c` driver.

A WebGL hack like `starnest` — see **[starnest.md](starnest.md)** for the full
rationale on the shared `shadertoy.js` harness (native WebGL2 instead of a port
of `xshadertoy.c`) and the `pointer-events:none` overlay canvas. These notes
just cover what's specific to this one.

## Files

- `bubblecolors.js` — the mountable module: `title`, `info`, the inlined shader,
  and `start(canvas)`. Thin; all rendering lives in the harness.
- `bubblecolors.glsl` — the original shader, copied **verbatim**, as provenance.

## License

No explicit license in the shader header (only Title/Author/URL/Date/Desc).
xscreensaver bundles it in its GPL-licensed `hacks/glx/glsl/` shader pool; the
body is reproduced here unchanged.

## The shader

One `mainImage` with a marching outer loop (90 steps) and an inner loop that
sums a few octaves of `sin` noise per step — that inner cost is why it's a GPU
piece. The whole thing fits in ~16 lines and is left exactly as written; only
the header comment is reflowed and ASCII-clean. It reads just `iResolution` and
`iTime` — no `iMouse`, no `iChannel` textures, single pass.

## Knobs (harness-level, shader untouched)

- `speed` — multiplies the playback rate (scales `iTime`). Default `1.0`.
- `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
  sharpness for framerate). Default `1.0`.

`reinit` / `r` jumps the clock to a random offset; since the column scrolls with
`iTime`, that lands on a fresh stretch of the field.

## Shader-specific note

The march uses `tanh()` for tone-mapping, which is a GLSL ES 3.00 builtin (so it
needs the WebGL2 harness — no ES 1.00 fallback). The blobs are intentionally
soft and overlapping; at low `resolution` they stay readable since there's no
fine detail to lose.

## Verify

Parse-only: `cp hacks/bubblecolors.js /tmp/bubblecolors.mjs && node --check
/tmp/bubblecolors.mjs`. Rendering can't be checked headlessly — open it in a
browser via a dev server (`python3 -m http.server`) and confirm it looks like a
slow upward churn of soft, color-shifting bubbles.
