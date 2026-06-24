# starnest — porter's notes

**Star Nest**, by Pablo Roman Andrioli ("Kali"), 2013. Shadertoy
[XlfGRj](https://www.shadertoy.com/view/XlfGRj), **MIT-licensed**. A volumetric
ray-march through a folded 3D Kaliset fractal that reads as an endless drift
through stars and nebulae. xscreensaver 6.x ships it as
`hacks/glx/glsl/starnest.glsl`, run by its `xshadertoy.c` driver.

This is the project's **first WebGL hack**. It's a different shape from the 2D
ports, so these notes cover the harness as much as the hack.

## Files

- `starnest.js` — the mountable module: `title`, `info`, the inlined shader, and
  `start(canvas)`. Thin; all the rendering lives in the harness.
- `shadertoy.js` — the **reusable** WebGL2 harness (shared, not a hack). Runs any
  single-pass, no-texture Shadertoy shader. Building it once unlocks the rest of
  the `hacks/glx/glsl/*.glsl` pool (stardome, topologica, ~34 more) as near
  drop-in follow-ups.
- `starnest.glsl` — the original shader, copied verbatim, as provenance (the
  analogue of keeping each 2D hack's `.c`).

## Why native WebGL2, and NOT a port of `xshadertoy.c`

`xshadertoy.c` is a back-compat shim: it rewrites modern Shadertoy shaders down
to **GLSL ES 1.00** (aliasing `texture()` to `texture2D`, faking `texelFetch`,
redefining `ivec`/`uint` away, writing `gl_FragColor`) so they run on 15-year-old
GL and mobile GLES2. In a 2026 browser **WebGL2 is universal**, and it speaks
**GLSL ES 3.00** — the same dialect Shadertoy itself targets. So we run the
shader on its home turf with a far thinner wrapper than xscreensaver needs, and
the shader body is **verbatim** — zero edits. The only thing we treat as sacred
is the shader; the harness is disposable plumbing we got to modernize.

The harness wrapper is just: a `#version 300 es` + `precision` + the standard
Shadertoy uniform block prepended to the shader, plus a `main()` that calls
`mainImage(color, gl_FragCoord.xy)`. One full-screen triangle is generated from
`gl_VertexID` (no vertex buffer needed — a WebGL2 convenience).

## The overlay canvas (this is *why* GL was flagged "infeasible")

It was never the hardware. The blocker is that the host owns **one shared
`<canvas>`** which 2D hacks bind to a `'2d'` context (and `host.js` itself calls
`canvas.getContext('2d')` in `goHome()`). **A canvas is locked to the first
context type it is ever given** — so `getContext('webgl2')` on the shared canvas
returns `null` once any 2D hack has run, and, worse, if a GL hack *did* grab
WebGL on it first, every *later* 2D hack's `getContext('2d')` would return null
and break.

So a GL hack must **never touch the shared canvas's context.** Instead the
harness creates its **own** canvas, `position:fixed; inset:0` exactly over the
host canvas, `z-index:1` (above the host canvas, below the host chrome at
`>= 99998`), and removes it on `stop()`. Crucially it is `pointer-events:none`,
so the click that summons the picker still falls through to the host canvas's
handler underneath. This needs **no changes to `host.js`** — exactly the
subagent contract (hacks never edit the host).

## Deviations from the original

- **Shader:** none. The `mainImage` body and every `#define` are as the author
  tuned them.
- **`iMouse`:** held at `(0,0)`, which is Star Nest's canonical default
  orientation (a screensaver has no pointer). A pointer-driven "explore" mode
  could be added later by listening on `window` for `mousemove` (which doesn't
  consume the picker click) rather than on the `pointer-events:none` overlay.
- **Added knobs** (harness-level, shader untouched):
  - `speed` — multiplies the playback rate of the fly-through (the shader has a
    `speed` `#define` of its own; we scale `iTime` around it). Default `1.0`.
  - `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower
    trades sharpness for framerate). Default `1.0`. A ray-march is the one place
    a high-DPI display can actually cost you, so this is the escape hatch.
- **`reinit` / `r`:** jumps the clock to a large random offset. Because the
  camera flies forward as `iTime` grows, this lands on a completely different
  region of the field — the GL analogue of reseeding a 2D hack.
- **`pause` / `resume`:** the clock accumulates `dt * speed`, so pausing is exact
  and changing speed never makes time jump.

## Host integration (deferred — not wired into `host.js`)

Left unwired on purpose: `host.js` is shared, and a parallel session is the one
that registers/reviews hacks. To wire it in later, the two usual lines:

```js
import * as starnest from './hacks/starnest.js';
// ...add `starnest` to the HACKS array.
```

Two integration notes for whoever does that:

1. **WebGL2 required.** The harness fails soft (logs and returns a no-op handle)
   if `getContext('webgl2')` is null — vanishingly rare in 2026, but worth a
   note. No WebGL1 fallback (Star Nest's shader is ES-1.00-friendly, so one could
   be added, but it isn't needed).
2. **The between-hack fade animates the shared canvas, not the overlay.** The
   host's swap fades `#c`'s opacity; our GL output is a separate element, so it
   won't fade with it, and on leaving a GL hack the host may briefly show `#c`'s
   stale last frame before fading. Cosmetic, and a host concern: the clean fix
   (when the host gains GL awareness) is to fade the overlay too, or clear `#c`
   to black on GL-hack mount. Standalone, the module is correct.

## Verify

Parse-only (syntax): `cp hacks/shadertoy.js /tmp/h.mjs && node --check /tmp/h.mjs`
(same for `starnest.js`). Rendering can't be checked headlessly — open it in a
browser via a dev server (`python3 -m http.server`) and confirm it looks like a
slow drift through a glittering blue-violet star field.
