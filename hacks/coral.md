# coral — port notes

Port of `coral.c` by Frederick G.M. Roeber (1997) — diffusion-limited aggregation: sticky "seeds" plus thousands of random walkers that stick on contact and grow branching coral, then linger and regrow.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/coral.c` (~327 lines) · config: `hacks/config/coral.xml`

## Algorithm (faithful to coral.c)
Scatter `seeds` sticky nuclei (each a drawn cell inside a 3×3 sticky halo). `density`% of all cells become random walkers. Each sweep (`coral()`) every walker either **sticks** — if it sits on a sticky cell: draw it, spread stickiness to its 8 neighbours, retire it (swap the last live walker into its slot, which is then skipped until the next sweep, exactly as the C does) — or **steps** one cell in a random cardinal direction (a blocked edge means "stay put this sweep", the C's `do { } while(0)` + `continue`, *not* a re-roll). When every walker has stuck, hold, then clear and regrow.

The draw colour advances one entry every `colorsloth = nwalkers*2/ncolors` walkers absorbed, so it sweeps ~`ncolors/2` entries (about half the hue wheel) over the whole growth, starting from a random index. The just-stuck cell keeps the pre-advance colour (the C flushes its point batch *before* `XSetForeground`); the port draws each cell, then advances — same result.

## Palette (the audit fix)
coral.c builds its colormap with **`make_uniform_colormap`** (`NCOLORSMAX` = 200), which is `make_color_ramp(0,S,V → 359,S,V, closed_p=false)` with **`S` and `V` each random in 0.66–0.99** (utils/colors.c): a full hue sweep at a fixed, slightly-**muted** saturation/value, re-rolled on every regrow. The earlier port used a vivid `hsl(h, 100%, 50%)` full-saturation rainbow with no per-run variation — a Rule-1 deviation. Replaced with the faithful ramp via `makeColorRampRGB(0, S, V, 359, S, V, 200)` (`closedP` defaults false; colors.c's `make_color_ramp` deliberately walks `h1→h2` the long way, which the colormap.js port reproduces). On a TrueColor visual (a canvas) all 200 entries survive, so the count is fixed at 200 — coral.c has no `ncolors` resource.

## Motion / timing (faithful)
Per `coral_draw`: one full walker sweep per `delay2` µs (default 20000 → ~50 sweeps/s); on completion the finished image is **static for `delay` seconds** ("Linger", default 5 s), then it regrows. The port matches all three: growth pace, the static linger (counted off real wall time so it is `delay` seconds at any refresh rate, and pauses cleanly), and regrow.

The rAF loop adds a fixed **`OVERHEAD = 7855 µs`** to the per-sweep `delay2` (not the linger) so `(delay2 + OVERHEAD)` reproduces the live binary's effective sweep rate: measured against the live `-fps` overlay coral runs **35.9 fps** mid-growth, so `20000 + 7855 = 27855 µs → 35.9 sweeps/sec`. A calibration, not a tuning knob — the `delay2` slider stays 1:1 with the xml. See the framerate-calibration note.

## Deviations from the C
- **Palette** — see above (this was the main fidelity bug; now faithful).
- **Animated `erase_window` between linger and regrow → instant clear.** The xscreensaver erase wipes are not integrated in this gallery (`wipes.js` is built but unwired); coral clears to black before regrowing.
- **Retina handling.** coral.c sets `scale = 2` above 2560 px and grows at *device* resolution with 2×2 dots. The port instead follows the gallery's "consistent crispness" model: it grows at **logical (CSS-pixel) resolution** (`width = canvas.width / dpr`) and draws each cell as a `dpr × dpr` device-px rect. On a non-retina display (dpr 1) this is the C's `scale = 1` path exactly; on retina the branch structure is ~dpr× coarser than the C's, but the walker count stays in CSS px so it is display-independent (no dpr-scaled count). There is no `scale` resource in the C, and the port exposes none.
- **Bit-packed board (`x>>5` / `x&31`) → flat `Uint8Array`.** Same map, simpler indexing.
- **`rand_2()` 2-bit RNG hoarding → `Math.random()`.** Purely a `random()`-call optimization in the C; the distribution (uniform 0–3) is identical.
- **`XFillRectangles` 200-point batching → per-cell `fillRect`.** Pure draw-call batching; coral sticks relatively few cells per sweep, so direct fills are fast and the image is identical.
- **Seeds drawn as a `scale × scale` cell** (the C's `XDrawPoint` is 1 device px). Negligible — the ~20 seeds are immediately overgrown.

## Config (mirrors coral.xml)
- `delay2` — "Frame rate", µs between sweeps, 1–500000, default 20000, inverted (the xml's `convert="invert"`).
- `delay` — "Linger", seconds to hold the finished coral, 1–60, default 5.
- `density` — % of cells seeded as walkers, 1–90, default 25.
- `seeds` — sticky nuclei, 1–100, default 20.

coral.c additionally clamps `density > 100 → 90` and `seeds > 1000 → 1000`; the sliders cap below those, so the clamps are inert but kept faithful. The previously-exposed `ncolors`, `scale`, and a ms-unit `holdTime` sliders were invented and have been removed.
