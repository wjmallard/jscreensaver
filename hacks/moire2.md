# moire2 — port notes

Port of `moire2.c` by Jamie Zawinski (1998) — fields of concentric circles (zone plates) drifting past one another, their bitwise interference spraying moire fringes, shown two-tone with one tone slowly cycling through a smooth colour map. This is the **multi-zone-plate** moire (distinct from `moire`, the single warped grating).

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/moire2.c` (~362 lines)

> **Rebuilt 2026-06-27 (fidelity audit).** The first port flattened all three stages of the C — it turned the thin 1-bit rings into a fully-filled per-pixel ring-index ramp, the bitwise OR/XOR into an arithmetic sum, and the single cycling colour into a per-pixel full-spectrum rainbow — and the old notes claimed this was the "same picture." It was not (it was the quasicrystal failure mode). The port below is a faithful transcription.

## Algorithm
Two or three ring-fields (the C's `do_three` = `random()%3==0` gives 3, else 2). Each field is a stack of **thin concentric rings**: line width = `thickness`, ring-to-ring spacing `ii = thickness + 1 + (xor?0:1) + random%(4*thickness)`, centred at a point that drifts (and bounces) around the screen. 1/5 of fields are inverted (the C's whole-plane `GXxor` fill); 1/5 get a ~5% elliptical stretch on one axis (the C's `maxx`/`maxy *= 1+frand(.05)`).

The fields are combined into **one bit per pixel** by a bitwise op: `GXor` (union) or `GXxor` (parity). `xor` is chosen when there are 3 fields, `thickness == 1`, or a coin flip — exactly the C. The 1-bit result is shown **two-tone**: "on" bits one colour, "off" bits the other. One of the two is a single colour slowly **cycling** through the colour map (`pix = (pix+1) % ncolors` every frame); the other is a fixed black or white. The C's `flip_a` chooses which bit cycles; `flip_b` chooses the fixed tone. Every `colorShift` frames a counter ticks down; after `30 + random%70 + random%70` ticks the whole scene re-rolls.

## Colour — make_smooth_colormap
The palette is the C's `make_smooth_colormap` (a closed HSV loop through a random 2–5 anchor points, frequently muted/pastel), ported faithfully in [[colormap]] (`makeSmoothColormapRGB`). Built **once per launch**, matching the C (`moire2_init_1` builds the map once; only the cycling index moves). So a given session keeps one colour scheme and cycles through it; re-rolls change the ring patterns and the flips, not the hues.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see [[squiral]].

## Rendering — 1-bit field, blit at logical resolution
Canvas has no `XCopyArea`-with-raster-op, so the scrolling 1-bit pixmaps are evaluated **directly per pixel**: a pixel is "on" in a field iff it is within the line width of a ring radius (`(dist mod ii) < lineWidth`), combined across fields by `|`/`^`. The 1-bit result is painted two-tone into a `Uint32` `ImageData` at **logical (CSS-pixel) resolution**, one `putImageData` into an offscreen scratch canvas, then `drawImage`-upscaled onto the device-px main canvas with **smoothing off** (crisp rings, like the 1-bit pixmap). The C does the morally equivalent thing with its `".lowrez: true"` default ("Too slow on Retina screens otherwise"). One sqrt per field per logical pixel, so cost is independent of dpr.

## Deviations from the C
- **Per-pixel ring membership instead of scrolling pixmaps.** Forced by the platform (no raster-op blit); the *result* is faithful — thin rings of the correct spacing/width, combined by the same bitwise op, shown two-tone with the same cycling. This is a mechanism change, not a look change.
- **Nearest-neighbour upscale on Retina.** Like the C's `.lowrez`, the field is computed below device resolution and scaled up; rings stay crisp (smoothing off) but are chunkier than a hypothetical full-res render.
- **Encoding:** the micro sign in the "Frame rate" unit is the `µs` escape (no literal non-ASCII in any rendered string); literal Unicode appears only in comments.
- **Config:** added `colorShift` (a real C resource, absent from the stock xml UI) as a "Re-roll rate" slider, and `sources` (surfacing the C's hidden 2-or-3 choice) so the field count is tunable; `0 = auto` reproduces the C's `random()%3` each re-roll. `thickness` maps to ring spacing/width.

## Config
`delay` (Frame rate, live, invert) · `colorShift` (Re-roll rate, live, invert) · `thickness` (Ring spacing; 0 = auto, reinit) · `sources` (Ring-fields; 0 = auto, reinit) · `ncolors` (reinit). Defaults mirror `hacks/moire2.xml`: delay 50000 (the C default), ncolors 150, thickness 0, plus the two added keys (colorShift 5, sources 0).

**Framerate calibration (`OVERHEAD = 13291`).** The stock `delay = 50000 µs` is only a sleep floor; the live binary's real rate is lower (delay + framework overhead — see the framerate-calibration note). The live moire2 measures **15.8 fps**, while the port at the stock delay ran 20 steps/sec (1.27× fast). The loop adds `OVERHEAD`: `50000 + 13291 = 63291 µs → 15.8 steps/sec`, matching the live binary. The `delay` slider still maps 1:1 to the xml resource.
