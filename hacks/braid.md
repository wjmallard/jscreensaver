# braid — port notes

Port of `braid.c` (John Neil, 1995; xscreensaver port by Jamie Zawinski, 1997).

Original: <https://www.jwz.org/xscreensaver/> · source: `braid.c` (~443 lines)

## Algorithm
A random **braid word** — a sequence of letters, each `±(1..nstrands-1)` — is laid out around a circle. Each letter spans one angular sector (`theta = 2π / braidlength`); its magnitude says which adjacent pair of concentric rings crosses there, its sign says which strand goes **over**. Within a crossing sector the two strands swap radius along a sine-smoothstep, and the under-strand is **gapped** in the middle ~2/7 of the arc (that gap is the whole "woven" illusion); every other ring runs as a plain circular arc. The braid word is constrained so no letter cancels its neighbour (incl. wrap-around) and enough distinct crossings appear, then the permutation it induces is decomposed into **knot components** (cycles), each given its own hue. The braid itself is static; what animates is `startcolor`, which spins the palette around the rings (a barber-pole). Every `cycles` frames a fresh braid is generated.

## Module shape
`start(canvas) -> { stop, reinit, config, params }` — see `squiral.md`.

## Rendering — vector ops, but bucketed by colour
This is genuinely line/arc-shaped (thin strokes, not per-pixel accumulation), so it uses **canvas vector ops**, not the blit path. But the naïve port is ~7500 one-pixel `XDrawLine`s per frame (≈500 angular samples × up to 15 strands) — far too many `stroke()` calls. Since the C casts the colour to an integer index anyway (`MI_PIXEL(mi, (int) color_use)`), segments are **bucketed by that integer index** into one `Path2D` per colour (≤ `ncolors`), and each bucket is stroked once — turning thousands of draw calls into ~`ncolors` per frame. Draw order across buckets doesn't matter: strands only overlap at crossings, and the over/under there is enforced by the *gap*, not by paint order.

## Deviations from the C
- **Clears every frame.** The C clears only at init and overdraws in place (fine under X11's single buffer). Canvas is double-buffered, so each frame clears to black and redraws — flicker-free, no anti-aliasing build-up. The braid geometry is identical frame-to-frame, so the result looks the same.
- **Redraws only when the colour advances** (a `dirty` flag), so a slow `delay` doesn't burn CPU re-stroking an unchanged image.
- **`devicePixelRatio`**: radii, centre, and `linewidth` are in device px; the "~5 px per ring" room test and the thickness cap are converted back to logical px so strand count and line weight look the same on retina.
- **Thickness cap**: the C's overflow guard does `MIN(1, sqrt(minDim/8))`, which forces hairlines (almost certainly a `MAX` typo); we use `MAX(1, …)` so the capped thickness is sane. Only triggers for large `size` on tiny windows.
- **`startcolor` wrapped both ways** into `[0, ncolors)`; the C only resets at the top end and lets it drift negative for the other spin direction (its per-segment colour re-wraps anyway, so this is identical, just tidier).
- **Units / tuning**: `delay` ms (xml µs default 1000 ≈ unbounded → calmer 20 ms); `cycles` default raised 100 → 200, since our loop isn't draw-bound like X11 so a braid would otherwise flash by. Keypress/`fps` handling dropped (the host owns keys and the meter).

## Config
Ranges mirror `hacks/config/braid.xml`: `delay` (Frame rate, live, inverted), `cycles` (Duration, live), `ncolors` (reinit), `count` (Rings — the *max*; the actual count is random ≤ it, reinit), `size` (Line thickness; `< 0` = random `1..|size|`, reinit). Non-live changes and "Reset to defaults" re-run `generate()` (a fresh random braid). `r` (restart) also regenerates.
