# neongravity — porter's notes

**Neon Gravity** ("Abstract gravitational well II"), by Marten Range (mrange),
2024. Shadertoy [43G3Wc](https://www.shadertoy.com/view/43G3Wc), **CC0**.
Luminous neon strands spiral and plunge into a dark gravitational core, rendered
with tone-mapping and then antialiased by a separate FXAA pass. xscreensaver 6.x
ships it as `hacks/glx/glsl/neongravity-0.glsl` + `neongravity-1.glsl`, run by its
`xshadertoy.c` driver. This is one of the **first two harness-v2 (multipass)
hacks** (with `skyline`).

## Files

- `neongravity.js` — the mountable module: `title`, `info`, both inlined shaders,
  and `start(canvas)`.
- `neongravity-1.glsl` / `neongravity-0.glsl` — the two passes, copied verbatim,
  as provenance.
- `shadertoy.js` — the shared WebGL2 harness; this hack exercises its **two-pass
  feed-forward** path.

## Two passes — and a rewire back to the author's intent

The shader is a classic Shadertoy BufferA→Image graph:

- **scene** (`neongravity-1.glsl`) ray-marches the well and tone-maps it.
- **image** (`neongravity-0.glsl`) runs FXAA, sampling the scene on `iChannel0`,
  and is what you see.

We wire that explicitly:

```js
passes: [
  { name: 'scene', source: SCENE },
  { name: 'image', source: IMAGE, channels: { 0: 'scene' } },
]
```

**Why not just mirror `xshadertoy.c`?** Its harness has no per-pass channel map —
it packs the files in name order and hard-wires `iChannelN` to pass N's output.
That makes the FXAA pass (file `-0`, so pass 0) read its **own** empty buffer and
then displays the **renderer** (file `-1`) raw, *un*-antialiased — a packing
accident, not the author's design. Binding `iChannel0` to the scene explicitly
restores the intended BufferA→Image flow, so you get the smooth result. The
buffer is read only within the same frame, so no ping-pong is needed (a single
texture); the final FXAA pass draws straight to the screen.

## Deviations from the original

- **Shader:** both bodies verbatim. One ASCII transliteration per the project's
  source-encoding rule: the author's name in a `neongravity-1` comment carries a
  Scandinavian a-ring, rendered as plain `a` in the inlined `.js` ("Marten
  Range"); the `.glsl` provenance keeps the original bytes.
- **Wiring:** the channel map above is harness-level configuration, not a shader
  edit — the `mainImage` bodies are untouched.
- **`iMouse`:** held at `(0,0)`.
- **Added knobs** (harness-level): `speed`, `resolution`. Both default `1.0`.
- The FXAA pass passes a `sampler2D` as a function argument (`fxaa(iChannel0,…)`)
  — legal in GLSL ES 3.00, no shim.

## Verify

Syntax: `node --check neongravity.js`. Rendering: open via a dev server and
confirm a neon vortex falling into a dark core with **clean, antialiased** edges
(if the strands look jagged/stair-stepped, the FXAA pass isn't being fed — check
the `channels` map).
