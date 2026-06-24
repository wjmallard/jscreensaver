# trizm — porter's notes

**Trizm**, by Matt Vianueva (`diatribes@gmail.com`), 2025. Shadertoy
[3fcBD8](https://www.shadertoy.com/view/3fcBD8), **relicensed MIT by permission**
(8-Mar-2026, per the shader header). A triangle-wave raymarcher: a forward fly
through a neon corridor where `arcsin(sin(x))` triangle waves fold space into
glowing lattices, lit by plasma'ish highlights and `tanh`-tonemapped. xscreensaver
6.x ships it as `hacks/glx/glsl/trizm.glsl`, run by its `xshadertoy.c` driver. By
the author's note it's a riff on @OldEclipse's "Cyber Conduits" and @Shane's
"Abstract Corridor".

This is a second WebGL hack built on the shared harness; for the full rationale
of **why native WebGL2 instead of porting `xshadertoy.c`**, the **overlay-canvas**
trick (so the picker click still falls through), and the **two added knobs**, see
[`starnest.md`](starnest.md) — it all applies identically here.

## Files

- `trizm.js` — the mountable module: `title`, `info`, the inlined shader, and
  `start(canvas)`. Thin; all rendering lives in the harness.
- `trizm.glsl` — the original shader, copied verbatim, as provenance.
- `shadertoy.js` — the **shared** WebGL2 harness (not edited; see `starnest.md`).

## Shader

**Verbatim — zero edits.** The `mainImage` body and every constant are as the
author tuned them. The inlined `SHADER` template literal round-trips **byte-exact**
against `trizm.glsl` (1889 chars; the body is pure ASCII with no backtick / `${` /
backslash, so no escaping was needed). `iResolution` / `iTime` / `iMouse` come from
the harness preamble.

## The two knobs (harness-level, shader untouched)

- `speed` — multiplies the playback rate of the fly-through (scales `iTime`).
  Default `1.0`. The shader's own time scale (`t = iTime * .5`) is left intact;
  this rides on top of it.
- `resolution` — render scale vs `devicePixelRatio` (`1` = crisp; lower trades
  sharpness for framerate). Default `1.0`. Same params as `starnest.js`, verbatim.

`iMouse` is held at `(0,0)`; the shader doesn't read it, so orientation is fixed.
`reinit` / `r` jumps the clock to a random offset, which (since the camera flies
forward as `iTime` grows) lands on a different stretch of corridor.

## Shader-specific note

The shader is **dense per-pixel** (20 raymarch steps, each with a 3-iteration
triangle-wave inner loop and several `cos`/`fract` calls), so on a high-DPI display
the `resolution` knob — and the harness's adaptive-resolution fallback — earn their
keep here even more than on starnest. Output is `tanh`-tonemapped, so it self-clamps
and won't blow out regardless of speed.

## Verify

Parse-only (syntax): `cp hacks/trizm.js /tmp/trizm.mjs && node --check /tmp/trizm.mjs`.
Rendering can't be checked headlessly — open it via a dev server
(`python3 -m http.server`) and confirm it looks like a fast drift down a glowing,
folding neon corridor. (Host wiring is deferred, exactly as for starnest — see
`starnest.md`.)
