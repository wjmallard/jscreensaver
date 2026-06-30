# compass — port notes

Port of `compass.c` (Jamie Zawinski, 1999).

Original: <https://www.jwz.org/xscreensaver/> · source: `compass.c` (~998 lines, most of it the hand-digitised glyph coordinate tables in `draw_letters`)

One-line summary: a single compass, centred on screen, whose dial and two needles each spin about randomly — "for that 'lost and nauseous' feeling."

## Algorithm
The compass is three concentric **discs**, each with its own angle `theta` (in the C's units of `360*64` per full turn):

- **disc 0 — dial** (`draw_ticks` + `draw_letters`): 72 radial tick marks (every 6th one longer) plus twelve glyphs around the rim at evenly-spaced bearings — the cardinal letters `W N E S` and the bearing numbers `30 33 3 6 12 15 21 24`. Pale cyan (`#DDFFFF`).
- **disc 1 — thick needle** (`draw_thick_arrow`): a double-ended arrow (head + tail spike). Gold (`#F7D64A`).
- **disc 2 — thin needle** (`draw_thin_arrow`): a shaft line through the centre plus a filled triangular head. Yellow (`#FFF66A`).

Each disc precesses by `roll_disc`: `theta += velocity`, `velocity += acceleration`, with `acceleration` flipping sign at a velocity `limit` (`5*64`), flipping randomly (~1/120 per step), and being scaled by `1.2`/`0.8` occasionally (~1/200, integer-truncated — so it can decay to 0 and leave a disc coasting). The three discs are seeded with independent random angle/velocity/acceleration, which is why the hands wander at different, drifting rates. A **static** case decoration (`draw_pointer`) — a red top triangle, a red accent, and six pale bezel marks — is painted on top and never rotates.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. Closest twins: `[[rotor]]` (spinning-arm idiom) and `[[braid]]` (vector ops batched into one `Path2D` per colour). The whole dial (ticks + every glyph, all one colour) is built into a single `Path2D` and stroked once; the arrows and bezel are a handful more stroke/fill calls.

## Deviations from the C
- **No XOR.** The porter brief flagged a `GXxor` erase, but `compass.c` has *no* XOR: it draws into a double buffer and erases each frame with a plain `XFillRectangle` in the background colour (`compass_draw`, the `erase_gc` whose foreground is `#000`). That is already a full-frame repaint, which maps **directly** to a canvas `fillRect('#000')` + redraw. So there is no XOR workaround here — the repaint is faithful, not a substitution.
- **Single, centred compass — no drift/bounce.** The brief also flagged "multiple compasses drifting across the screen and bouncing off edges." This hack has none of that: one compass, fixed at screen centre (`st->x = width/2, st->y = height/2`). Nothing translates, so there is nothing to bounce. (The drift/bounce hazard belongs to other hacks, not this one.)
- **Sizing in device px.** The C's size math (`size2 = min(w,h)`, widened for goofy aspect ratios, capped at `600`, doubled past `2560` px for retina, then `radius = size2/2 * 0.8`) is ported verbatim against the device-pixel canvas. Because the C's cap is in *real* pixels and our backing store is already `innerWidth*dpr`, the `>2560` retina doubling lands the compass at the same **physical** size on screen at any `dpr`.
- **Line caps/joins.** Dial uses `bevel` join / `butt` cap (the C's `JoinBevel`, default cap). The arrows use `round` cap+join to avoid miter spikes at the arrowheads (cosmetic; the C left them at the default).
- **Added config knobs.** The xml exposes only `delay` (and a host-owned fps toggle). For a useful config box, two faithful conveniences were added: **Spin speed** (a live multiplier on the per-step `theta` increment — it scales pace only, leaving the velocity/acceleration drift dynamics untouched) and **Size** (a scale on the auto-computed radius). Both default to `1` (== stock).
## Palette
compass is a **native screenhack** (`#include "screenhack.h"`), not an xlockmore hack, so it has **no colormap and no `make_*_colormap` / `hsv_to_rgb` call**. Every colour is a fixed named resource from `compass_defaults[]`, transcribed verbatim:

- dial — ticks, glyphs, bezel marks: `.foreground` `#DDFFFF` (pale cyan)
- thick double-ended needle (`draw_thick_arrow`, disc 1): `*arrow2Foreground` `#F7D64A` (gold)
- thin filled-head needle (`draw_thin_arrow`, disc 2): `*arrow1Foreground` `#FFF66A` (yellow)
- top triangle + upper-left accent (`draw_pointer`, `ptr_gc`): `*pointerForeground` `#FF0000` (red)
- background: `.background` `#000000`

The remaining `draw_pointer` marks (left/right/bottom + the three small corner ticks) reuse the dial GC (`dot_gc = discs[0]->gc`), i.e. the pale cyan. The port's four `COL_*` constants and per-shape choices match this exactly. **No systemic vivid-`hsl` bug here** — the instrument colours are iconic and fixed, so there is nothing to "fix"; verified against the live binary. The port has zero `hsl()`.

## Timing
Stock `*delay` = **20000 µs** (xml `delay` default; `config.delay` matches, slider 1:1, inverted). The delay is a sleep **floor**, so the effective frame rate is `1e6/(delay + compute)`, not `1e6/delay`, and the live binary rolls each disc exactly once per frame.

Calibrated against the live binary's `-fps` overlay. The first readings were taken while sibling audit agents loaded XQuartz concurrently; across all runs the reported sleep held rock-steady at **20000 µs**, with the variance confined to the compute slice. A clean **solo re-measure** (no concurrent load) then read a tight **~35 fps cluster** (34.4 / 34.6 / 35.9) at Load ~30 % (frametime 28571 µs; 28571 × (1 − 0.30) ≈ 20000 µs sleep, confirming the floor) — lower than the earlier contended 38.9-fps over-pick, i.e. compass does a touch more per-frame work than first measured:

```
OVERHEAD = round(1e6 / 35.0) - 20000 = 28571 - 20000 = 8571 µs
```

The loop now advances one disc roll per `(config.delay + OVERHEAD)/1000` ms (≈ 28.6 ms → ≈ 35 rolls/s), matching the live precession cadence. **Before this audit the port had no overhead term**, rolling once per bare 20 ms (≈ 50/s) — i.e. precessing ~43% too fast. `OVERHEAD ≥ 0` holds. The **Spin speed** knob still scales the per-roll `theta` increment only (not the step interval), so it stacks on top of this pace exactly as before.

## Correctness self-review
- **Termination / divergence:** there is no closure or reset condition to mis-fire — the compass spins forever. The only divergence risk is `theta`/`velocity` running away. A headless harness (200 trials × 5000 steps at speed 0.1/1/4) confirmed: `theta` stays bounded in `[-FULL, FULL]`, `velocity` stays bounded (the `limit` check reverses acceleration), and **zero** non-finite values appeared. `theta` took thousands of distinct values per run, so the discs genuinely spin (no "dead/stuck" hands).
- **Single-step wrap validity:** the C wraps `theta` with one add/subtract of `FULL`, which only holds if `|increment| < FULL`. Max observed `|velocity*speed|` was ~1.6k ≪ `FULL` (23040), so the wrap is always valid.
- **Sign quirk preserved:** `roll_disc`'s odd sign juggling (it can push `theta` into a negative domain) is ported as-is; the harness shows it stays bounded and `cos/sin` handle negative angles fine.
- **First frame complete:** discs are seeded with random angles in `init`, and the rAF loop draws before stepping, so the very first painted frame shows a complete compass.
- **pause/resume:** `resume()` resets `lastTime = 0` so no catch-up burst; `reinit()` clears to black and re-seeds a fresh spin.

## Config
- `delay` — Frame rate (live, inverted, µs). Mirrors `compass.xml`.
- `speed` — Spin speed (live; added convenience).
- `size` — Size (re-runs `init` via `reinit`; added convenience).

Non-live changes and "Reset to defaults" re-run `init()` (recompute radii/line widths, re-seed the spin). `r` (restart) likewise reseeds.
