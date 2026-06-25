# greynetic — port notes

Port of `greynetic.c` (Jamie Zawinski, 1992) — one of the oldest xscreensaver hacks. The name is **ironic**: it draws garish multicolour rectangles, not grey ones. (The `grey` toggle exists to make it actually grey, as a joke.)

Original: <https://www.jwz.org/xscreensaver/> · source: `greynetic.c` (~296 lines)

## Algorithm
Every step it stamps **one** rectangle and never clears, so the screen fills with a churning pile of overlapping rects. Sizing follows the C's "minimize area, but don't try too hard" loop: up to 10 tries for a box whose `w + h` is under both the screen width and height (each side ≥ 50px), then it takes whatever the last try produced. The rect lands at a random position. Two fills:
- **solid** — a single vivid random colour. On the Mac/jwxyz build the C gives the colour a *random alpha* so stacked rects show through; we keep that (rgba with a random opacity).
- **stippled** — a two-colour fill (random fg + random bg) through one of 12 classic X11 bitmap patterns (`stipple`, `cross_weave`, `dimple1/3`, `gray1/3`, `hlines2`, `vlines2/3`, …) drawn `FillOpaqueStippled`. The 12 bitmaps are inlined verbatim from the C.

Colours are drawn from a recycled pool (the C allocates up to 512 X colours, then reuses them); `grey` collapses each colour's three channels to one grey level.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — per-step fillRect, no buffer
The canvas itself is the persistent pile — nothing is read back, nothing accumulates in a separate buffer.
- **solid**: a trivial per-step `ctx.fillRect` with an `rgba()` fill at a random alpha (floor = the `Opacity` slider, the rest random), so layers stay translucent like the Mac original.
- **stippled**: bake the tiny 1-bpp bitmap into an offscreen tile (fg where the bit is set, bg elsewhere) and `ctx.createPattern(..., 'repeat')` — the direct canvas analogue of X11's `FillOpaqueStippled`. The tile is scaled by `devicePixelRatio` so the weave stays visible on retina.

## Deviations from the C
- **Both fills exposed, not compile-time-chosen.** The C picks stipple-vs-solid at *compile* time (`DO_STIPPLE` is set on X11, unset on Mac, where it does solid+alpha instead). We offer both at once via a `Fill` select (solid / stippled / random per rect), defaulting to random so you get the union of both looks.
- **Vivid by default.** Truly uniform-random RGB skews muddy; with `grey` off we nudge low-saturation rolls toward brighter hues so it reads as the intended garish colour. `grey` on reproduces the C's exact `green = blue = red` desaturation.
- **Alpha control.** The C's Mac path uses a fully-random alpha (`random() & amask`); we add an `Opacity` floor slider (default 60%) so it isn't always near-invisible, with the remainder still random.
- **Stipple background is opaque.** X11 `FillOpaqueStippled` paints bg pixels too; our pattern does the same (alpha 255), so stippled rects are opaque — only solid rects are translucent. Matches the X11 build.
- **No `mono` path.** The C falls back to fg/bg-only drawing under `mono_p` (1-bit displays) or when colour allocation fails; neither applies in a browser, so it's dropped.
- **Resize** re-reads the window size and clears (the C's `greynetic_reshape` just updates the limits and keeps drawing over the old pixels; clearing on resize is the gallery convention since the backing store is reallocated anyway).

## Config
Ranges mirror `hacks/config/greynetic.xml`: `delay` (Frame rate, 0–250000 µs, live, inverted) and `grey` (checkbox, reinit). Added for parity with the other ports: `mode` (Fill — solid / stippled / random, reinit), `alpha` (Opacity %, live), and `ncolors` (Colors — size of the recycled colour pool, reinit; the C hardcodes the 512 cap). `r` (restart) and any non-live change re-seed the colour pool and clear via `reinit()`.
