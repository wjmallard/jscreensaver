# hexplasma — porter's notes

**Hexagon Plasma**, by Nemerix, 2025. Shadertoy
[3fy3z3](https://www.shadertoy.com/view/3fy3z3), **MIT-licensed**. A flowing
plasma whose domain is warped through a hexagonal signed-distance field and then
folded by four turns of a `sin`/rotate feedback loop, glowing teal-to-white where
the field thins toward zero. xscreensaver 6.x ships it as
`hacks/glx/glsl/hexplasma.glsl`, run by its `xshadertoy.c` driver.

A single-pass, no-texture WebGL hack, the same shape as `starnest`. See
[`starnest.md`](starnest.md) for the full rationale of the shared
**`shadertoy.js`** harness (native WebGL2 / GLSL ES 3.00 instead of porting
`xshadertoy.c`) and the **overlay-canvas** trick (a GL hack must never touch the
host's shared 2D canvas, so the harness lays its own `pointer-events:none` canvas
over it).

## Files

- `hexplasma.js` — the mountable module: `title`, `info`, the inlined shader, and
  `start(canvas)`. Thin; all rendering lives in the harness.
- `hexplasma.glsl` — the original shader, copied verbatim, as provenance.

## The shader

**Verbatim** — the `mainImage` body and every constant are exactly as the author
tuned them; zero edits. The inlined copy in `hexplasma.js` is byte-for-byte
identical to `hexplasma.glsl` (it is pure ASCII, with no backslash, backtick, or
`${`, so it drops straight into a JS template literal). `iResolution` / `iTime`
are supplied by the harness preamble.

## Knobs (harness-level, shader untouched)

- `speed` — multiplies the playback rate (scales `iTime`, which drives the plasma
  evolution). Default `1.0`.
- `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
  sharpness for framerate). Default `1.0`.

## Shader-specific note

The image is a pure function of `iResolution` and `iTime` (`iMouse` is unused), so
`reinit` / `r` simply jumps the clock to a fresh offset — a different moment in
the same endlessly evolving plasma.

## Verify

Parse-only (syntax): `cp hacks/hexplasma.js /tmp/hexplasma.mjs && node --check
/tmp/hexplasma.mjs`. Rendering can't be checked headlessly — open it via a dev
server (`python3 -m http.server`) and confirm it looks like a slow teal-and-white
hexagonal plasma flow.
