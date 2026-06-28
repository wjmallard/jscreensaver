# cloudlife — port notes

Port of `cloudlife.c` by Don Marti (2003) — Conway's Life with **cell aging**, rendered as drifting clouds.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/cloudlife.c` (~439 lines) · demo video: youtube `TkVDO3nTTsE`.

> **Audited + rewritten in the fidelity audit (Batch 1C, nonlinear / cellular-automata class, 2026-06-28).** The previous port had flattened two look-defining things — the palette and the cell-size control — and carried a devicePixelRatio dot-count fudge. All three are corrected below.

## Algorithm (faithful to the C)
- Standard Life **B3/S23** on a grid with a 1-cell **off-screen border ring**: grid `= screen/size + 2` on each axis, where `size = 1 << cellSize` (the C's `cell_size` is a power-of-two **exponent**).
- Each cell stores an **age** (`Uint8`). `cell_value`: dead → 0, age `> maxAge` → **3**, else 1. So a weighted neighbour count can exceed 8, and over-age cells destabilise their neighbourhood — long-lived blobs "explode" instead of sitting.
- `is_alive`: a live cell survives on weighted count 2 or 3 (returns `age + 1`), else dies; a dead cell is born on exactly 3 (returns 1). Ages wrap at 256 like the C's `unsigned char` (never reached in practice — e.g. a 2×2 block self-destructs ~`maxAge + 2` ticks in, well under 255).
- **Rendering:** exactly **ONE** random sub-pixel of each cell's `size × size` block is painted per tick — live cells in the current foreground colour, dead cells in black — into a **persistent** buffer (`px = x*size - rx - 1`, `py = y*size - ry - 1`, `rx,ry ∈ [0,size)`). Old dots persist, so the field fades like clouds and movers leave comet trails. Mirrors the C's batched `XDrawPoints` via a single `putImageData`.
- **Colour:** the foreground is a **single** colour drawn from a `make_smooth_colormap`, walked **backwards** every `cycleColors` (= 2) ticks. It is **not** a per-cell age colour — the whole cloud is one slowly-shifting hue at any instant.
- **Reseed** the whole field when the age-sum (`do_tick`'s return) drops below `(width + height) / 4`. Every `maxAge/2` ticks, **stir the border**: `populate_edges(density)` → `tick` → `populate_edges(0)` (inject edge activity for one generation, then clear the border).
- **Continuously animated** — matches the C (draw-before-tick; colour cycle before draw; `cycles++` last). This is correctly an animated hack, not a static one.

## Audit fixes (what was wrong → now)
1. **Palette — Rule-1 violation.** Was a vivid full-saturation HSL rainbow (`hsl(i, 1, 0.5)`), with a comment admitting it was "intentionally brighter." The C calls `make_smooth_colormap`. **Fixed:** faithful `makeSmoothColormapRGB(64)` from `colormap.js` (2-5 random HSV anchors, often muted/pastel), built **once** at start exactly as `cloudlife_init` does.
2. **`cellSize` semantics.** Was a direct pixel size (default 8, range 2-24). The C's `cellSize` is the **exponent**: `size = 1 << cellSize`. **Fixed:** config/slider is the exponent again (default **3** → 8 px, range **1-20**, mirroring the xml).
3. **dpr dot-count fudge.** Was scattering `round(dpr²)` dots/cell (the exact "count wrongly scaled by dpr" bug). The C draws **one** dot/cell. **Fixed:** cells are sized in **device px** (`1 << cellSize`) and one dot is drawn — no dpr factor anywhere in the counts.
4. **`delay` unit.** Was milliseconds. The xml resource is **microseconds** (`--cycle-delay`, default 25000, range 0-100000, inverted). **Fixed:** µs; the loop divides by 1000.
5. **Invented sliders dropped.** `ncolors` and `cycleColors` are **not** in `cloudlife.xml` (command-line only). Removed from the config box; fixed as consts `NCOLORS = 64`, `CYCLE_COLORS = 2` (the `cloudlife_defaults`).
6. **Exact constants.** Density threshold is now `(initialDensity % 100 * 256) / 100` with `random() & 0xff < p` (C integer math, ≈0.297 at default 30), not `Math.random()*100 < 30`. Reseed threshold uses integer division `Math.floor((w+h)/4)`. The age-sum reads back the `Uint8`-stored value so it matches the C's `count += (unsigned char)assignment`.

## Accepted / platform deviations
- **RNG:** `Math.random()` instead of the C's `random()` — no bit-exact stream (fine for a stochastic hack). The C pulls `rx`/`ry` from one `random()` via a bit-split; we use two calls — same distribution.
- **Cell size in device px.** The canvas backing store is the analogue of the X11 screen, so a cell is `1 << cellSize` **device** pixels — i.e. on a hi-DPI display cells are exactly what the original would draw on that same hardware (finer than the old port's CSS-px cells). On a 1× display it is identical to stock.
- **Palette persistence.** Built once and kept across resize/reinit (the C keeps `colors`/`colorindex` across window-size changes; neither colour resource is user-tunable, so there is nothing to rebuild).

## Timing — calibrated against the live binary
Default `delay = 25000 µs` = 40 generations/sec **nominal**, but xscreensaver's *effective* rate is below nominal (the delay is a floor plus framework overhead — see the framerate-calibration note; `starfish` needed `OVERHEAD = 8000`). Measured against the live `-fps` overlay the binary runs **30.3 fps** (Load 24% = delay-bound, a portable target), while the port at the stock delay measured **40 gen/sec** (1.3× fast). Fixed with `OVERHEAD = 8000` µs in the loop: `25000 + 8000 = 33000 µs → 30.3 gen/sec`, re-measured at **30.3** — matching the live binary. The `delay` slider still maps 1:1 to the xml resource; `OVERHEAD` is a calibration offset, not a tuning knob.

## Config
Mirrors `hacks/config/cloudlife.xml` exactly (only its real resources): `delay` (µs/tick, "Frame rate", inverted, 0-100000, default 25000), `maxAge` ("Max age", 2-255, default 64), `density` ("Initial density", %, 1-99, default 30), `cellSize` ("Cell size", exponent 1-20, default 3 → 8 device px). `ncolors` (64) and `cycleColors` (2) are command-line-only in the C and fixed as consts. `showfps` is a framework control, not surfaced.

## Correctness self-review (code-level; no live binary)
Headless harness mocks a minimal DOM and drives the **real** module (`scratchpad/cloudlife-smoke.mjs`): param keys are exactly `delay/maxAge/density/cellSize`; the `delay` unit renders as ` µs` (U+00B5, no literal non-ASCII byte in source); at dpr 2 the field draws and accumulates with one dot/cell (no dpr inflation); the rAF loop blits ≈ once per `delay` (paced, not every frame); and `pause`/`resume`/`reinit`/`stop` plus extreme configs (cellSize 1 and 20, delay 0, maxAge 2, density 1/99) all run without throwing or spinning. Live-verified by the main session (2026-06-28): scattered green Life colonies with faint comet trails matching the binary, muted `make_smooth_colormap` (not a rainbow), and the generation rate calibrated to the live 30.3 fps (see *Timing*). Remaining nicety: device-px cell granularity on retina is finer than the old port (faithful to the C, but worth an eyeball on a real high-DPI display).

**Local dev:** ES-module `import`s need a server — `python3 -m http.server` in the repo, then <http://localhost:8000/#cloudlife>.
