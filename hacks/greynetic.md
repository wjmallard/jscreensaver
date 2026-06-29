# greynetic — port notes

Port of `greynetic.c` (Jamie Zawinski, 1992) — one of the oldest xscreensaver hacks. The name is **ironic**: it draws garish multicolour rectangles, not grey ones. (The `grey` toggle exists to make it actually grey, as a joke.)

Original: <https://www.jwz.org/xscreensaver/> · source: `greynetic.c` (~296 lines) · demo video: <https://www.youtube.com/watch?v=lVEi089s1_c>

## Algorithm
Every step it stamps **one** rectangle and never clears, so the screen fills with a churning pile of overlapping rects. Sizing follows the C's "minimize area, but don't try too hard" loop: up to 10 tries for a box whose `w + h` is under both the screen width and height (each side ≥ 50px), then it takes whatever the last try produced. The rect lands at a random position. No scaling — the box is drawn at full size.

`greynetic.c` has two **compile-time** rendering paths:
- **`DO_STIPPLE` (X11, the `#ifndef HAVE_JWXYZ` default)** — each rect is `FillOpaqueStippled` through one of 12 inlined X11 bitmaps with a random foreground + random background colour, both **opaque** (no alpha).
- **jwxyz (Mac/iOS/Android)** — each rect is a solid random colour with a **random alpha** (`pixel = (pixel & ~amask) | (random() & amask)`), no stipple. There is no `GCFunction`/XOR in either path.

**This port reproduces the `DO_STIPPLE` (X11) path**, because that is what the autoconf/XQuartz live binary the main session verifies against actually runs. The Mac alpha path is documented here as the alternative; if the canonical demo video turns out to show the alpha look, switching is small (drop the stipple pattern, fill solid with an `rgba()` at a random alpha). **FLAGGED for live-verify: which compile path matches ground truth.**

Colours: pure **uniform random RGB** per channel (`fgc.red = random()` etc.), cached in a 512-entry pool (`pixels[512]`); once the pool fills it reuses random entries. This is *not* a `make_*_colormap` ramp — greynetic has no smooth palette, just raw random colours (which is the ironic point: independent random RGB averages toward grey). `grey` collapses each colour's three channels to one grey level.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — per-step pattern fill, no buffer
The canvas itself is the persistent pile — nothing is read back, nothing accumulates in a separate buffer. Each stipple bitmap is baked into an offscreen tile (fg where the bit is set, bg elsewhere, all alpha 255) and used as a `ctx.createPattern(..., 'repeat')`, the direct canvas analogue of X11's `FillOpaqueStippled`. The pattern is anchored at the **canvas origin** (not the rect), matching X11's window-origin stipple phase so overlapping weaves align. The 12 inlined bitmaps are byte-exact copies of the C's arrays.

## Deviations from the C
- **X11 path only (not the Mac alpha path).** See above — faithful to the live binary; the alpha path is the documented alternative. *(class C, flagged for live-verify.)*
- **Stipple tile scaled by `devicePixelRatio`.** The C draws 1 bitmap pixel = 1 screen pixel; we draw 1 bitmap pixel = `round(dpr)` device px so the weave stays at a consistent visible size on retina (same apparent scale as a dpr-1 display). *(class B, platform.)*
- **No `mono` path.** The C falls back to fg/bg-only drawing under `mono_p` (1-bit displays) or when colour allocation fails; neither applies in a browser. *(class B.)*
- **Resize clears.** The C's `greynetic_reshape` just updates the limits and keeps drawing over the old pixels; setting `canvas.width/height` in the browser clears anyway, and a fresh start on resize is the gallery convention. *(class B.)*
- **`reinit` (the `r` key) clears + empties the colour pool**, so toggling `grey` takes effect on the next rects. The C reads `grey` once at init and can't toggle it at runtime. *(class C.)*
- **Framerate calibration (`OVERHEAD = 9417`).** The stock `delay = 10000 µs` is only a sleep floor; the live binary's real rate is lower (delay + framework overhead). Measured against the live `-fps` overlay greynetic runs **51.5 fps**, while the port at the stock delay ran ~100 fps (1.9× fast); the loop adds `OVERHEAD` so `10000 + 9417 = 19417 µs → 52 fps`, matching the live binary. The delay slider still maps 1:1 to the xml resource. *(class B, calibration.)*

## Config
Mirrors `hacks/config/greynetic.xml` exactly — the only real resources are:
- `delay` — **Frame rate**, 0–250000 µs, default **10000**, inverted slider, live.
- `grey` — checkbox, default false (reinit).

Previously-invented sliders **removed**: `mode` (solid/stippled/random — the C chooses at compile time, not at runtime), `alpha` (Opacity floor — the C's alpha is fully random with no floor, and the X11 path has no alpha at all), `scale` (Rect size — the C never scales the rect; its default 0.5 shrank every rect to half size), and `ncolors` (the C hardcodes the 512-entry pool cap).

## Audit (2026-06-27, Batch 1B)
Rebuilt to the X11 `DO_STIPPLE` pipeline. Fixed:
- removed the `scale = 0.5` rect-shrink (every rect was drawn at half size);
- removed the invented saturation "nudge" on colours — now pure uniform random RGB per the C (`fgc.red/green/blue = random()`);
- set `delay` default to the xml's **10000 µs** (was 250000 = 25× too slow for the "rapid slap-down" cadence);
- removed the invented `mode` / `alpha` / `scale` / `ncolors` sliders (config now mirrors the .xml: `delay` + `grey`);
- replaced the pre-filled colour pool with the C's incremental 512-cap pool (fresh randoms until full, then reuse);
- anchored the stipple to the canvas origin (was anchored per-rect, so weaves jumped between overlapping rects).

The 12 inlined bitmaps were already byte-exact. **Residual risk:** the X11-vs-Mac path choice (stipple vs translucent solid) is the one thing the main session should confirm against ground truth.
