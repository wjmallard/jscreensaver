# bestill — porter's notes

A **six-scene collection** of calm, still landscape / cloud raymarchers by
**Matt Vianueva** ("diatribes", `diatribes@gmail.com`), each originally a
Shadertoy and each **relicensed MIT by permission** (8-Mar-2026). xscreensaver
6.x ships them as `hacks/glx/glsl/bestill{0..5}-0.glsl`, run by its
`xshadertoy.c` driver.

This is a WebGL hack. For the *why* behind the shared WebGL2 harness, the
overlay-canvas trick, and "native WebGL2, not a port of `xshadertoy.c`", see
**`starnest.md`** — all of that applies unchanged here. These notes only cover
what is specific to bestill.

## The six scenes

| # | Title                   | Shadertoy |
|---|-------------------------|-----------|
| 0 | Be Still                | [tfXcRn](https://www.shadertoy.com/view/tfXcRn) |
| 1 | Everything is Temporary | [w32BDD](https://www.shadertoy.com/view/w32BDD) |
| 2 | Night Cloud Dance       | [3cjcWD](https://www.shadertoy.com/view/3cjcWD) |
| 3 | Cloud Lights            | [wXXBRX](https://www.shadertoy.com/view/wXXBRX) |
| 4 | Desert Duo              | [3cXyzB](https://www.shadertoy.com/view/3cXyzB) |
| 5 | Water                   | [tXjXDy](https://www.shadertoy.com/view/tXjXDy) |

They share a family resemblance: a tiny single-pass raymarch of an orb drifting
over a noisy plane under a slow camera sway, `tanh`-tonemapped into a different
mood each (dusk, night-cloud, moonlit blue, desert sun, water).

## Files

- `bestill.js` — one mountable module that bundles **all six** scenes as a
  `SCENES` array of shader-body strings, plus `title`, `info`, and
  `start(canvas)`. Thin; all rendering lives in the harness.
- `bestill0-0.glsl` .. `bestill5-0.glsl` — the six originals, copied **verbatim**,
  as provenance (the analogue of keeping each 2D hack's `.c`).
- `shadertoy.js` — the **shared** WebGL2 harness (not a hack, not modified here).

## What's verbatim, and how it's packaged

Each entry in `SCENES` is the corresponding `.glsl` file's contents **byte-for-byte**
(trailing whitespace, blank-line padding, and bestill1's large commented-out
alternate version all preserved). The harness preamble prepends `#version 300 es`,
the `precision` lines, and the whole Shadertoy uniform block, and appends a
`main()` that calls `mainImage(color, gl_FragCoord.xy)` — so each scene string
contains **only** the shader's own `#define`s / helpers / `mainImage`, never a
`#version` / `precision` / `uniform` / `out` line (the originals have none). I
verified each round-trips byte-exact against its `.glsl` file.

Confirmed all six are **single-pass and texture-free** — no `iChannel`,
`texture()`, `texelFetch`, or `BufferA-D` — so they run on the same harness as
Star Nest with nothing added.

## Scene selection — random per mount

`start(canvas)` picks `SCENES[Math.floor(Math.random() * SCENES.length)]` once,
so **each mount shows one random scene** for its whole lifetime. The shader is
chosen at mount time and then fixed: the harness's `reinit` (the `r` key) only
jumps the playback clock, so it re-rolls the *time offset within the current
scene*, not the scene itself. To draw a different scene, re-mount the hack.

## The two harness knobs (shader untouched)

Same two as Star Nest, copied verbatim:

- `speed` — multiplies the playback rate (`iTime` is scaled; each scene's own
  motion constants are left exactly as the author tuned them). Default `1.0`.
- `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
  sharpness for framerate). Default `1.0` — the escape hatch for a raymarch on a
  high-DPI display.

## Shader-specific notes

- **bestill3 ("Cloud Lights")** is the only scene with a multi-line `#define`
  (the `O(Z,c)` orb macro). Its three `\` line-continuations are real backslashes
  the GLSL preprocessor needs, so in the JS template literal they are written
  `\\`; verified the runtime string carries exactly three backslashes.
- **bestill1 ("Everything is Temporary")** keeps the author's trailing run of
  blank lines and a big commented-out earlier version of `mainImage`; harmless,
  preserved for fidelity.
- **No `iMouse` use.** These scenes ignore the pointer, so the harness's held
  `(0,0)` mouse is moot here.

## Host integration (deferred — not wired into `host.js`)

Not wired in, same as Star Nest (the host is shared; a parallel session
registers hacks). To wire it in later, the usual two lines:

```js
import * as bestill from './hacks/bestill.js';
// ...add `bestill` to the HACKS array.
```

## Verify

Parse-only (syntax): `cp hacks/bestill.js /tmp/bestill.mjs && node --check /tmp/bestill.mjs`.
Rendering can't be checked headlessly — open it in a browser via a dev server
(`python3 -m http.server`) and confirm a slow, calm scene drifts by (re-mount a
few times to cycle through the six moods).
