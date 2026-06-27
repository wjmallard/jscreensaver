# analogtv — port notes (shared NTSC engine)

Port of `analogtv.c` by Trevor Blackwell & Jamie Zawinski — the ~2453-line CPU simulation of an NTSC television that several xscreensaver hacks render through. It is **not a hack** (no `XSCREENSAVER_MODULE`); it's a shared library `#include`d by `vfeedback`, `xanalogtv`, `pong`, `filmleader`, and `m6502`. So this port is a shared **module**, not a per-hack copy: `hacks/analogtv.glsl.js` exports GLSL *function* source plus a `startAnalogTV(canvas, opts)` harness, and a hack imports it and supplies only its own picture content. The first hack built on it is [[xanalogtv]]; a faithful `vfeedback` rebuild is the other intended client.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/analogtv.c` (+ `analogtv.h`). Validated against `analogtv-cli` (the original pipeline run head-less on a still image).

## Why a real signal simulation
The genuine NTSC artifacts — dot crawl, chroma/luma crosstalk, colour bleed, scanlines, bloom — are *emergent*: they fall out of actually running the broadcast signal path, not from a scanline overlay. So the port runs the real path:

**Encode** `atv_source` RGB → YIQ → band-limit each channel separately (Y ≈ 3.5 MHz, I ≈ 1.5 MHz, Q ≈ 0.5 MHz) → QAM-modulate I/Q onto a 4×-colourburst subcarrier → sum to one **composite** sample stream.

**Decode** composite → quadrature-demodulate against the subcarrier → low-pass → YIQ → RGB (the inverse 3×3 matrix a real set implements in hardware). Chroma is recovered only when a colourburst is present (`colormode`), so dead/snow channels stay monochrome.

**CRT** scanline profile (the `leveltable` edge-dimming), `pow(.,0.8)` gamma, and the geometry/timing faults (vertical roll, horizontal tear, top bar-bend, brightness bloom, right-edge squish, power-on warm-up).

## IIR → FIR adaptation (the load-bearing change)
`analogtv.c` band-limits with **Butterworth IIR** filters run sequentially along each scan line (each output sample depends on the previous one). A fragment shader has no sequential state across pixels, so each IIR is replaced by an **FIR convolution whose taps are that IIR's own impulse response** (`scratchpad/extract_kernels.mjs` drives the impulse through the original difference equations). Each kernel's DC gain is ≈ 1, so levels are preserved, and the result matches `analogtv-cli` pixel-wise on SMPTE bars (bar order, hue, saturation, colour bleed, scanlines). The encode kernels live in `ATV_ENCODE_GLSL` (encode passes only) so the decode/final passes don't carry an unresolved `atv_source`.

## Signal space & coordinates
Passes that touch the composite render at a **fixed, sample-accurate** size, decoupled from the canvas: `ATV_NS = 760` samples wide (1 texel = one 90° step of the 4×-fsc carrier, so the subcarrier is never undersampled) × `ATV_NL = 212` lines (`ATV_VISLINES = 200` + `2·ATV_OVERSCAN`). The carrier is `cos/sin(0.5·π·s)` on integer sample `s` — exact quadrature. Only the **final** pass upscales signal space to the display, applying scanlines / gamma / geometry at output resolution. Carrier convention is *clean* cos/sin, so there is **no** 103° burst tint (that offset is an artifact of how `analogtv.c` packs the burst) and colours round-trip at `tint ≈ 0`.

## The harness: `startAnalogTV(canvas, opts)`
Builds the FBO chain, runs the pipeline at a fixed 30 fps (TV-authentic, and it makes any feedback fold-rate independent of display refresh), and returns `{ stop, pause, resume, reinit, getStats, config, params }`.

`opts`:
- `source` — GLSL defining `vec3 atv_source(vec2 uv)` (the picture; `uv` in `[0,1]`, y-down). May read `uTime`/`uFrame`/`uPrev` and custom uniforms.
- `decl`, `setUniforms(gl, prog, ctx)` — extra encode uniforms; `ctx.pass` is `0` for the main station and `1` for the second station (see `twoStation`).
- `frameKnobs(ctx) → { … }` — per-frame values merged over `config` (all optional): `color, tint, brightness, contrast, noise, seed, agc, ghostfir[4], hfloss, mixB, ofsX, ofsY, bend, roll, rolling, slant, hdrift`.
- `images: [url | {canvas}]` — bound as `uImage0…`. A **URL** is a PNG loaded once; a **`{canvas}`** is a live 2D canvas the harness re-uploads every frame (used for [[xanalogtv]]'s station-ID + clock overlay). `uImagesReady` flags when the URLs are in.
- `ghost` — adds the RF multipath echo pass (`ghostfir`), plus the high-frequency-loss term (`hfloss`).
- `bloom` — adds the `crtload` precompute (line-luma reduce → 0.95 IIR-as-FIR) and the horizontal breathing.
- `twoStation` — encodes a second station (pass 1) and additively sums it into the composite at a wrapped, drifting offset.
- `config` / `params` / `name`. Notable `config`: `fps`, `resolution` (backing-store scale), `powerup` (opt-in warm-up, re-armed on each off→on), `startClock` (deterministic test clock), `speed`, `squeezebottom`.

> **Self-feedback** (`atv_source` reading the previous final frame, for a video-feedback hack) was supported via a `feedback`/`agcServo` path; it was **sliced out 2026-06-27** since no live hack used it. The exact machinery + a re-integration recipe are archived in `hacks/shelved/vfeedback.md`.

## Pipeline order (per 30 fps step)
`encode` (source → composite) → [`twoStation`: encode pass-1 → additive sum] → [`ghost`: composite += Σ ghostfir·box-sum at lags 4/8/12/16, + hfloss·(sample 2 away within the subcarrier group)] → `decode` (composite → linear RGB, with luma-only AGC + the colormode chroma gate) → [`bloom`: reduce line-luma → `crtload` IIR] → `final` (CRT geometry + scanlines + gamma, drawn straight to the canvas).

## Deviations from the C
- **IIR → FIR** band-limiting, as above (faithful in result, not in arithmetic).
- **Sample width 760** vs the C's 912/line (≈ 755 active); 760 keeps ~190 carrier cycles/line as on a real set while staying a clean buffer width.
- **Clean carrier** (no 103° burst tint) — see above; the per-hack `tint` default is therefore 0.
- **AGC** is a per-frame scalar from the reception parameters (`agc = 1/rx_signal_level`), applied to the **luma path only** (matching `analogtv_ntsc_to_yiq`, where the Y filter carries `agclevel` and the I/Q filters do not).
- **Revived:** `hfloss` (high-frequency loss) — the original leaves its driver gated behind `if (0)`, so it never runs; this port enables it (each sample picks up `hfloss ×` the sample 2 away in its subcarrier group → luma lift + chroma wash on weak signals), driven per-frame by the caller. Faithful to the arithmetic at `analogtv.c:1292`, just no longer dead.
- **Dropped:** `hashnoise` (disabled in the original — `#if 0`), the PseudoColor/colormap path, and X11 plumbing.

## Validation
`analogtv-cli in.png out.mp4` runs the *real* NTSC pipeline on a still; ffmpeg pulls a frame for pixel comparison. The live originals also run under XQuartz for motion reference (`DISPLAY=:0`, built in `xscreensaver-6.15/hacks/`). Browser output is checked head-less with puppeteer (`scratchpad/shot2.mjs`, `scratchpad/timelapse.mjs`). See the memory note `analogtv-ntsc-shader-port` for the full rig.

**Local dev:** ES-module imports need a server (`python3 -m http.server`); `file://` won't load. GitHub Pages serves over http, so production is unaffected.
