# rigrekt — porter's notes

**Rig Rekt**, by Matt Vianueva ("diatribes", <diatribes@gmail.com>), 2026.
Shadertoy [3XKfDV](https://www.shadertoy.com/view/3XKfDV), **relicensed MIT** by
permission (8-Mar-2026; original posted 26-Feb-2026). A single-pass distance-field
ray-march flying down a folding tunnel of nested, recursively rotated boxes, lit
by a glowing core and warped by layered sine turbulence.

A WebGL hack like `starnest`, so the shared plumbing is identical — see
[`starnest.md`](starnest.md) for the full rationale of the **`shadertoy.js`**
harness (native WebGL2 / GLSL ES 3.00, *not* a port of `xshadertoy.c`) and the
**`pointer-events:none` overlay canvas** (why a GL hack must never touch the
host's shared `'2d'`-locked canvas). Nothing here departs from that.

## Files

- `rigrekt.js` — the mountable module: `title`, `info`, the inlined shader, and
  `start(canvas)`. Thin; all rendering lives in the shared harness.
- `rigrekt.glsl` — the original shader, copied **verbatim**, as provenance.

## Shader

**Verbatim, zero edits** — the `mainImage` body and every constant are exactly as
the author tuned them. It is a "golf"-style shader: a 64-step march where each
step folds a recursive box SDF (`boxen` spins the space with the `R()` rotation
macro at shrinking scales) intersected with a tunnel SDF, then adds a small inner
loop of sine turbulence, accumulating both a soft glow term and a hot core term.
The `iResolution`/`iTime` uniforms come from the harness preamble; it reads no
`iChannel`/texture and is single-pass, so it drops straight into `shadertoy.js`.

The body is pure ASCII and contains no backslash, backtick, or `${`, so it
inlines into the JS template literal with no escaping. Verified: the evaluated
`SHADER` string equals `rigrekt.glsl` byte-for-byte (it is `"\n"` + the file,
matching `starnest`'s leading-newline shape).

## The two knobs

Harness-level only; the shader is untouched.

- `speed` — multiplies the playback rate. The camera flies forward as `iTime`
  grows (`p.z += iTime`), so this is literally throttle. Default `1.0`.
- `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
  sharpness for framerate). The 64-step march is heavy on a high-DPI display, so
  this is the escape hatch. Default `1.0`.

`reinit` / `r` jumps the clock to a large random offset, landing further down the
tunnel; `pause`/`resume` are exact (the clock accumulates `dt * speed`).

## Shader-specific note

The shader **letterboxes itself**: `if (abs(u.y) > .75) { ... return; }` leaves
black bars above and below the central band — that crop is the author's framing,
not a harness artifact, and is preserved as-is. `iMouse` is unused by this shader,
so it's held at the origin like the rest of the pool.

## Verify

Parse-only (syntax): `cp hacks/rigrekt.js /tmp/rigrekt.mjs && node --check /tmp/rigrekt.mjs`.
Rendering can't be checked headlessly — open it in a browser via a dev server
(`python3 -m http.server`) and confirm it looks like a glowing flight down a
folding, box-lined tunnel inside a letterboxed band.
