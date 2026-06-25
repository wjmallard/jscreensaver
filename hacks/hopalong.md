# hopalong — port notes

Port of `hopalong` (`hop.c`) by Patrick Naughton (1992), of the xlockmore lineage. Later operations were added by Ed Kubaitis (the EJK1–6 formulas, from xmartin), Renaldo Recuerdo (RR), Clifford Pickover (Popcorn) and Peter de Jong (Jong). Lacy fractal patterns from iterating a strange-attractor map, from a 1986 *Scientific American* article.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/hopalong.c` (~563 lines)

## Algorithm
The Barry-Martin "hopalong" attractor. A new round picks one of **11 formulas** (Martin/sqrt, EJK1–6, RR, Popcorn, Jong, Sine) and random parameters `a,b,c,d` whose scale is set by `range = sqrt(cx² + cy²) / (1 + rand)`. Then each frame iterates the chosen map `count` times, plotting one point per iteration: most ops do `oldi = i + inc; j = a − i; i = oldj ± f(b·oldi − c)`, then project to screen as `x = cx + (i+j)`, `y = cy − (i−j)`. The points accumulate into a persistent buffer, so a lacy figure builds up over the frames. The whole frame shares **one colour**, which advances through the hue cycle each frame (so the accumulating image is a smooth rainbow, and `count` controls how many points get the same hue — the "colour contrast"). After `cycles` frames the buffer clears and a fresh attractor begins.

Special cases match the C: **Popcorn** ignores `range`, reuses `a`/`b` as integer counters and resets `inc` to 100; **Jong** and **Sine** use trig recurrences with their own projections; **EJK6** takes `asin` of the fractional part of `b·oldi` (C's `x − (long)x`, i.e. truncation toward zero → `Math.trunc`).

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. pause/resume use the `rafId === 0` sentinel + `lastTime` reset from `boxfit.js`.

## Rendering — Uint32 blit, accumulating
Point plotting, thousands per frame, accumulating across many frames → the **blit path**: iterate the map writing each point into a persistent `Uint32Array` over an `ImageData`, then `putImageData` once per frame (like `sierpinski` / `binaryring`). Per-point `fillRect` would be thousands of draw calls per frame for no benefit. The C's `XFillRectangles` of a point buffer maps to the same idea; we just keep the buffer between frames instead of redrawing.

## Variable / fixed loop
Fixed-timestep **lag accumulator** paced by `config.delay` (µs, so the loop divides by 1000), with a catch-up cap — identical pace at any refresh rate, no burst on tab refocus. One `step()` = one `draw_hop` = `count` points + one colour advance.

## Deviations from the C
- **Faithful port** of all 11 map formulas and their per-op parameter ranges; cryptic names renamed (`i`/`j` → `ii`/`jj`; `pix` kept; `op`/`inc`/`count`→`time` kept close to the C).
- **Colour**: the C uses the X colormap (`ncolors` smooth colours, `MI_PIXEL`), advancing the pixel index once per frame. We build an `ncolors`-entry **vivid HSL rainbow** (full-sat, L=0.55) and advance through it the same way — house style favours saturated rainbows over the muted X default.
- **devicePixelRatio**: backing store is sized in device px; the dot size and the random `inc` offset are scaled by dpr so the figure keeps its proportions and a crisp dot on retina. The C instead leaves the math in raw pixels and only bumps the dot size (×3 past 2560 px). Popcorn's `inc = 100` override is left unscaled (popcorn is unit-free — it scales off `MI_WIDTH/40`, which auto-scales with the device-px canvas; likewise Jong scales off `cx`).
- **Clear-on-restart**: `init_hop` calls `MI_CLEARWINDOW`; we just fill the buffer black instantly in `startover()` (no wipes/erase module). As in the C (and `sierpinski`), the clear only shows on the *next* blit, so the finished figure is visible for one frame first.
- **Formula select**: the C exposes each formula as a separate `--martin`/`--sine`/… boolean (all default off → fully random). We fold these into one **`Formula` select** (`random` + the 11 named ops) — same effect, one control instead of eleven mutually-exclusive checkboxes. The C's `OFFENDING`/`ignoreRotation`/verbose paths are dropped.

## Config
Ranges mirror `hacks/config/hopalong.xml`: `delay` (Frame rate, µs, live, inverted), `cycles` (Duration — frames before restart, live; xml allows up to 800000 but we cap the slider at 100000 for a usable range), `count` (Color contrast — points/frame, live), `ncolors` (Colors, reinit), plus the `formula` select (reinit; replaces the xml's eleven booleans). `r` (restart) and non-live changes start a fresh attractor via `reinit()`.
