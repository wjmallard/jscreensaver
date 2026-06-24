# petri — port notes

Port of `petri.c` by Dan Bornstein (1992–1999). Competing molds spreading across a petri dish.

Original: <https://www.jwz.org/xscreensaver/> · source: `petri.c` (~779 lines), `config/petri.xml`

## Algorithm
A toroidal grid of cells. Each living cell accumulates `growth` at its `speed` each iteration; past `orthlim` (1) it seeds its 4 orthogonal neighbours, and past `diaglim` (~1.414) it seeds all 8 and then **settles** (`killcell`). A just-born/taken-over cell is painted in its mould's **bright** shade in the commit pass, and redrawn at **half intensity** once it settles — so each colony reads as a bright expanding ring filling in dim behind it. Only the active growth front is on a list, so cost scales with the front, not the grid. Random "blips" sprinkle new colonies; when a colony's lifespan (`blastcount`, in `[minlifespan, maxlifespan]`) runs out a **black death** wave (colour 0, white-fronted) eats the molds — or the dish is wiped outright (`instantdeathchan`). The `blastcount--` post-decrement, short-circuit order, growth thresholds, the diaglim-scaled speeds, and the `all_coords` diagonal/orthogonal split are transcribed verbatim from `update`/`randblip`.

The C's per-cell **doubly-linked list** is ported faithfully as index-based `next[]`/`prev[]` typed arrays with `HEAD`/`TAIL` sentinels (`prev[idx] === -1` ⇔ not on the list, the C's `c->prev == 0`). New cells are **head-inserted** (so they first grow the *next* pass), killed cells keep their `next[]` (so the growth-pass iterator steps off them), and contested cells resolve in the C's order: the **older** colony wins, because newer cells sit ahead of it in the list and are visited first. (The earlier array port resolved this the *opposite* way — newer-wins — shifting colony-collision boundaries.)

## Palette (faithful)
`setup_random_colormap` (originalcolors defaults false): **`make_random_colormap` with `bright_p`** — random hue 0–360, saturation 30–100%, value 66–100% — for the `count-1` growing fronts (via `makeRandomColormapRGB(count-1, true)` from `colormap.js`). Each settled (dim) shade is its bright twin **halved** (`colors[n] = colors[n+count] / 2`, i.e. `rgb >> 1`, matching the C's `red/2` then 8-bit downsample exactly). Colour 0's dim = black (background), bright = white (the death front). It is **not** a full-saturation HSL rainbow (the prior bug). Built once per `init`/`reinit`; **persists across instantdeath wipes** (the C rebuilds it only on full re-setup). `originalcolors` (the fixed 8-primary set) is not ported.

## Motion
Genuinely animated: `update()` runs once per `delay` (the C's `petri_draw`/usleep return), via a fixed-timestep rAF loop. Continuous growth/death/respawn — not a static hack.

## Config (mirrors `config/petri.xml`)
All 13 xml controls are exposed: `delay` (µs, inverted "Frame rate"), `diaglim`, `anychan` (Fertility), `minorchan` (Offspring), `instantdeathchan` (Death comes), `min/maxlifespeed`, `min/maxdeathspeed`, `min/maxlifespan`, `size`, `count` — same defaults/ranges as the xml. `showfps` is a framework control, not ported. Speeds/lifespans are live (read per birth/reset); `size`/`count` reinit (grid + colormap rebuild).

Two xml label quirks are mirrored verbatim but read counter to their effect, so the port keeps the algorithmically-correct value mapping rather than the xml's `convert`/label: `diaglim` is `convert="invert"` with Square/Diamond labels (invert would put "Square" on the diamond end), so the port omits invert (Square↔1.0, Diamond↔2.0); `minorchan` is labelled Few→Many though higher `minorchan` means *fewer* cells per birth.

## Deviations from the C
- **memThrottle / retina cell-size doubling dropped.** The C's `>2560px → ×2` retina rule and 22 MB `memThrottle` (which grows the cell size) are not ported; instead `cellPx = round(size · devicePixelRatio)`, which reproduces the same *apparent* cell size on hi-DPI while staying crisp. At `size 1` on a large display this allocates more than the C would (no throttle) — acceptable in a browser.
- **Resize → reinit.** The C's `petri_reshape` is a no-op (keeps the original grid); the port rebuilds the grid + colormap on window resize, the sane web behaviour.
- **Centring offset.** Added (`offsetX/offsetY` centre the grid's leftover margin), matching the C's `xOffset/yOffset`.
- **RNG.** `Math.random()` stands in for the C's `RAND_FLOAT` (`(random()&0xffff)/0x10000`); only the distribution matches, not the exact stream.
- **delay default** is the stock 10000 µs (the slider maps 1:1 to the xml resource). The rAF loop adds a fixed `OVERHEAD = 8500 µs` so `(delay + OVERHEAD)` reproduces the live binary's effective rate, not the nominal one: measured against the live `-fps` overlay petri runs **54.0 fps** (Load 46% = delay-bound, a portable target), while the port at the stock delay ran ~100 updates/sec (1.85× fast). `10000 + 8500 = 18500 µs → 54 updates/sec`, confirmed by a side-by-side colony-coverage match at 12 s. A calibration, not a tuning knob — see the framerate-calibration note.
