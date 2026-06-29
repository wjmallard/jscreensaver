# imsmap — port notes

Port of `imsmap.c` by Juergen Nickelsen & Jamie Zawinski (1992; derived from code by Markus Schirmer, TU Berlin) — recursive cloud-like fractal patterns grown by midpoint subdivision (the plasma / diamond-square fractal). Rebuilt 2026-06-27 in the fidelity audit to match the C's draw model exactly: the earlier port generated the whole field instantly and then *cycled the colormap* over it — both deviations the C does not do.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/imsmap.c` (~426 lines)

## Algorithm
A height-field is grown by **midpoint subdivision**. The four screen corners start at height 0; then, level by level, every cell is split — each new edge-midpoint is set to the average of its two flanking corners and each new centre-midpoint to the average of all four — plus a random offset whose amplitude **halves at every level** (`rang = 1 << (NSTEPS - level)`, NSTEPS = 7, so the coarsest level perturbs by ±64 and each finer by half). Heights map to a palette index via `HEIGHT_TO_PIXEL`: normally saturating (h<0 → 0, h≥ncolors → ncolors-1), but on a random 1-in-5 of regenerations (`extra_krinkly_p`) out-of-range heights **wrap** through the colormap, banding the cloud.

## Rendering — the generation IS the animation (faithful)
As in the C, the subdivision **is** the visible drawing: each midpoint is painted as it is set, in a block whose size shrinks per level, so the picture **fades in from coarse blocks to full resolution** (`iteration*2+1` columns per frame). When the finest chosen level is reached the cloud sits **perfectly still** for `delay` seconds, then `regenerate()` (the C's `init_map`) grows a fresh field with a fresh colour map. There is **no colour cycling**. Blocks are painted into a persistent `Uint32` ImageData buffer (the C draws straight to the window, repainting only changed blocks) and blitted once per frame; the field math runs at device resolution.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Palette
The C's **`make_smooth_colormap`** (a random 2–5 anchor HSV loop, frequently muted/pastel), ported faithfully in `colormap.js`, rebuilt on every regeneration (the C calls it in `init_map`). Not a fixed vivid rainbow.

## Timing — variable-delay scheduler + framerate calibration
`drawChunk()` returns the time until the next call: `delay2` µs while painting, then a `delay`-second wait once the cloud is complete. A due-time cursor banks leftover wall-time, so the pace is refresh-rate independent (a guard caps catch-up after a backgrounded tab).

**`OVERHEAD = 12680` (build phase only).** `delay2` is a sleep floor; the live binary's real build rate is lower (delay2 + framework overhead — see the framerate-calibration note). The live imsmap measures **30.6 fps** during the coarse→fine build, while the port at the stock `delay2 = 20000 µs` ran 50 chunks/sec (1.63× fast). The loop adds OVERHEAD to the per-chunk delay only — `20000 + 12680 = 32680 µs → 30.6 chunks/sec` — and the `delay`-second finished-cloud hold is left untouched. The `delay2` slider still maps 1:1 to the xml resource.

## Config
Mirrors the real `imsmap.xml` resources: `delay2` (Paint speed, µs, live), `delay` (Hold, seconds, live), `iterations` (Detail — subdivision depth 1–7, reinit), `ncolors` (reinit). The xml's `mode` resource is **dropped**: `imsmap.c` declares it but never reads it (the colormap is always `make_smooth_colormap`), so it is a dead control.

## Deviations from the C
- **Edges clamp instead of wrap.** The C wraps the right/bottom neighbour to the opposite edge on its toroidal field; on a non-toroidal canvas that would fold the far edge into the near one, so we clamp the neighbour to the last row/column. Cosmetic — only the outermost seam differs, and it stays smooth.
- **`flip_x` / `flip_xy` kept.** The C randomly mirrors x and/or transposes the whole cloud per regeneration; `draw()` reproduces both faithfully.
- **Instant clear on regenerate.** The C's `MI_CLEARWINDOW` becomes filling the buffer with `colors[1]` (the C's background colour); the next cloud fades in over it. No wipe transition.
- **Mono / Floyd–Steinberg path dropped.** The C has a 1-bpp dithered fallback (`floyd_steinberg`) for `mono_p` / `ncolors ≤ 2`; we always run colour (min 3 via the xml range), so the dither path isn't ported.
- **ASCII-safe encoding**: the only rendered non-ASCII glyph is the frame-rate unit, written `' µs'` (micro sign); all other non-ASCII bytes are em dashes in comments only.
</content>
