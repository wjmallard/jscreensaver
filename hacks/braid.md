# braid — port notes

Port of `braid.c` (John Neil, 1995; xscreensaver port by Jamie Zawinski, 1997).

Original: <https://www.jwz.org/xscreensaver/> · source: `braid.c` (~443 lines)

## Algorithm
A random **braid word** — a sequence of letters, each `±(1..nstrands-1)` — is laid out around a circle. Each letter spans one angular sector (`theta = 2π / braidlength`); its magnitude says which adjacent pair of concentric rings crosses there, its sign says which strand goes **over**. Within a crossing sector the two strands swap radius along a sine-smoothstep, and the under-strand is **gapped** in the middle ~2/7 of the arc (that gap is the whole "woven" illusion); every other ring runs as a plain circular arc. The braid word is constrained so no letter cancels its neighbour (incl. wrap-around) and enough distinct crossings appear, then the permutation it induces is decomposed into **knot components** (cycles), each given its own hue. The braid itself is static; what animates is `startcolor`, which spins the palette around the rings (a barber-pole). Every `cycles` frames a fresh braid is generated.

## Module shape
`start(canvas) -> { stop, reinit, config, params }` — see `squiral.md`.

## Palette
`braid.c` defines `UNIFORM_COLORS` (and no other `*_COLORS`), so its colormap is
**`make_uniform_colormap`**: a full hue ramp `0 -> 359` at a *single* per-run
saturation and value, each random in **66%–100%** — a rainbow, but on any given run a
touch muted, and different every run. The port builds it via
`makeUniformColormapRGB(ncolors)` from `colormap.js`. `ncolors <= 2` collapses to white
(the C's `MI_NPIXELS(mi) > 2 ? MI_PIXEL(...) : MI_WHITE_PIXEL` mono path).

The map is built **once per run** (in `init()`) and held: a new braid re-rolls only
`startcolor` (a random index offset) and the spin direction — never the palette itself,
matching the C, whose colormap is a fixed framework resource for the run. Per-segment
colour indices are computed exactly as the C (`color_use = startcolor + SPINRATE *
components[...] + (psi + t)/2pi * ncolors`, truncated and wrapped), then that integer
indexes the map.

> Audit fix (2026-07-01): the first port hardcoded a full-saturation
> `hsl(i*360/n, 100%, 50%)` rainbow rebuilt on *every* braid — the systemic vivid-rainbow
> bug. Replaced with the faithful uniform colormap, built once.

## Rendering — vector ops, but bucketed by colour
This is genuinely line/arc-shaped (thin strokes, not per-pixel accumulation), so it uses **canvas vector ops**, not the blit path. But the naïve port is ~7500 one-pixel `XDrawLine`s per frame (≈500 angular samples × up to 15 strands) — far too many `stroke()` calls. Since the C casts the colour to an integer index anyway (`MI_PIXEL(mi, (int) color_use)`), segments are **bucketed by that integer index** into one `Path2D` per colour (≤ `ncolors`), and each bucket is stroked once — turning thousands of draw calls into ~`ncolors` per frame. Draw order across buckets doesn't matter: strands only overlap at crossings, and the over/under there is enforced by the *gap*, not by paint order.

## Deviations from the C
- **Clears every frame.** The C clears only at init and overdraws in place (fine under X11's single buffer). Canvas is double-buffered, so each frame clears to black and redraws — flicker-free, no anti-aliasing build-up. The braid geometry is identical frame-to-frame, so the result looks the same.
- **Redraws only when the colour advances** (a `dirty` flag), so a slow `delay` doesn't burn CPU re-stroking an unchanged image.
- **`devicePixelRatio`**: radii, centre, and `linewidth` are in device px; the "~5 px per ring" room test and the thickness cap are converted back to logical px so strand count and line weight look the same on retina.
- **Thickness cap**: the C's overflow guard does `MIN(1, sqrt(minDim/8))`, which forces hairlines (almost certainly a `MAX` typo); we use `MAX(1, …)` so the capped thickness is sane. Only triggers for large `size` on tiny windows.
- **`startcolor` wrapped both ways** into `[0, ncolors)`; the C only resets at the top end and lets it drift negative for the other spin direction (its per-segment colour re-wraps anyway, so this is identical, just tidier).

## Speed
`config.delay` is the **stock xml default, `1000` µs** (units match the xml), and the rAF
lag-accumulator paces one `step()` per **`(delay + OVERHEAD)`** — never faster than the
author's floor. `delay` is the field that paces the draw (each step spins `startcolor` and
ages the braid). The raw 1000 µs is only a sleep floor: the live binary is **draw-bound**
(each frame draws `~500 * nstrands` line segments — hundreds to thousands), so it runs far
below 1000 fps. `OVERHEAD` (the framework + draw cost) captures that real frame period.
**Live-measured `OVERHEAD = 4900` µs** — the live binary ran **170.1 fps** (Load 83.0%,
clean at stock delay 1000): draw-bound but cheap, nowhere near the guessed ~40 fps. Being
draw-bound the rate is machine-dependent; the rAF accumulator banks wall time so the sim
keeps ~170 steps/s even on a 60 Hz display. The earlier by-eye `delay: 40 ms` / `cycles:
200` tuning is gone (`cycles` is back to the stock 100). `fps`/keypress handling dropped
(the host owns keys and the meter).

## Config
Ranges/defaults mirror `hacks/config/braid.xml`: `delay` (Frame rate, µs, live, inverted,
`0..100000` default `1000`), `cycles` (Duration, live, `0..500` default `100`), `ncolors`
(`1..255` default `64`, reinit), `count` (Rings — the *max*; the actual count is random ≤ it,
`3..15` default `15`, reinit), `size` (Line thickness; `< 0` = random `1..|size|`, `-20..20`
default `-7`, reinit). No invented knobs — every control maps 1:1 to a real Xrm resource.
Non-live changes and "Reset to defaults" re-run `init()` (rebuild the palette + a fresh
random braid); `r` (restart) also regenerates.
