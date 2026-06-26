# lissie — port notes

Port of `lissie.c` ("the Lissajous worm", Alexander Jolk, 1996; from xlockmore, bundled in xscreensaver until 5.08) — a point sweeping a Lissajous figure and dragging a finite, rainbow-coloured tail of little circles behind it.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/lissie.c` (~323 lines) · <https://en.wikipedia.org/wiki/Lissajous_curve>

## Algorithm
Each worm is a point on a Lissajous figure:

```
x = xi + rx·sin(tx)
y = yi + ry·sin(ty)
```

`tx`/`ty` advance every step by per-axis angular speeds `dtx`/`dty`. The speeds **random-walk** (`×rand(0.99, 1.01)` each step, clamped to `[0.01, 0.15]` rad), so the phase relationship between the two axes drifts: the figure slowly precesses and morphs rather than retracing one fixed curve forever. `tx`/`ty` wrap once past `2π` each step (a single subtraction suffices since `dt < 2π`).

The worm keeps a **finite tail** in a ring buffer `loc[100]`: each step writes a new head at `pos % 100` and the point `len` slots back falls off the tail (`len ∈ [10, 99]`, random per worm). Each tail point is drawn as a circle **outline** of diameter `ri` (`ri/2` radius) — or a single point when `ri < 2` — in a hue that cycles one step per head, so the live tail is a moving rainbow tube. The C's `Lissie()` macro only draws a point when `x>0 && y>0 && x<=W && y<=H`, which both skips the un-written `(0,0)` slots during warm-up and clips off-screen excursions; the port replicates that test exactly.

`ri` (circle size) comes from `--size` (default `-200`): negative = a random diameter up to `|size|`, `0` = auto (`min(w,h)/4`), positive = a fixed diameter — all capped at `min(w,h)/4`. Centre `xi/yi` sits in the middle half of the screen (inset by `ri`); amplitudes `rx/ry` are sized so the figure stays on-screen.

### Reseed (the C's `draw_lissie`)
`if (++loopcount > cycles) init_lissie()` — every `cycles` frames (default 20000) the screen clears and all worms are re-seeded with fresh geometry/phase/colour. That is the only "reset"; between reseeds the random-walking speeds keep one figure-set evolving.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. Uses the **fixed-timestep** rAF lag-accumulator (one `step()` per `config.delay` µs), like `squiral`, not the variable-delay variant — `draw_lissie` is called at a fixed delay.

## Rendering — sparse vector ops, full repaint each frame
The C draws one circle (`XDrawArc`) per worm per step and **erases the oldest tail circle in SOLID BLACK** (`MI_BLACK_PIXEL`), not XOR — so there is *no* XOR look to emulate here. The catch: the C explicitly disables anti-aliasing (`jwxyz_XSetAntiAliasing(False)`), so its black erase removes a circle cleanly; canvas strokes are anti-aliased, so an incremental black erase leaves faint AA **ghost rings** along the worm's path (the known persistent-erase-redraw artifact).

So this port keeps the ring buffer but, instead of erasing incrementally, **repaints every frame**: clear to black, then redraw each worm's live tail window (the last `len` ring-buffer entries, each in its stored hue). The visible result — a finite worm of `len` circles on a black field — is identical to the C's, and ghost-free. Cost is `count × len` circle strokes per frame (≤ 20 × 99 ≈ 2000 at the extreme; ~99 at the default single worm), which is cheap. Rendering happens once per displayed frame after the step loop.

## Deviations from the C
- **Erase = full repaint, not incremental black masking.** Mechanically different from the C's per-step `XDrawArc` in black, but visually equivalent and it avoids the AA ghost rings canvas would otherwise leave. (See [[squiral]] for the same persistent-canvas considerations.)
- **Tail pre-rolled so the first frame is full.** The C grows a worm in over its first ~`len` frames (the tail starts empty). On reseed and on first start this port pre-advances each worm `len` steps so a complete worm is on screen immediately — same steady state, no ~1 s warm-up flash. The expose-driven `redrawing`/`refresh_lissie` repaint logic from the C is dropped (the persistent canvas never needs a damage repaint).
- **devicePixelRatio.** Backing store is device-px; the `--size` cap is scaled by `dpr` and line width is `max(1, S)`, so circles keep their logical size and stay crisp on retina. All geometry scales together, so the figure looks identical at any dpr.
- **Colour.** The C cycles each worm's pixel index through `ncolors`; this port keeps the gallery's vivid `hsl()` rainbow (white when `ncolors ≤ 1`, the C's mono path). The hue still advances one step per head, so the tail gradient matches the original.
- **`cycles` floor.** The xml allows `cycles` down to 0, which in the C reseeds *every* frame — the screen clears before anything is drawn (perpetual black). The slider's minimum is raised to 1000 to avoid that degenerate setting; the default (20000) is unchanged.
- **No `--fps` toggle** (host-level concern, dropped from the UI).

## Config
Ranges mirror `hacks/config/lissie.xml`:
- `delay` — **Frame rate** (`--delay`, µs/step, live, inverted: drag right = faster).
- `cycles` — **Timeout** (`--cycles`, frames before reseed; live; min raised to 1000, see above).
- `count` — **Worms** (`--count`, 1–20; non-live, re-runs via `reinit()`).
- `size` — **Size** (`--size`, -500…500; negative = random up to that magnitude, positive = fixed, 0 = auto; non-live).
- `ncolors` — **Colors** (`--ncolors`, 1–255; non-live).

Non-live changes and `reinit()` start a fresh screen with the current config. Local-dev/module-fetch caveat is the same as `squiral.md`.

## Correctness self-review
- **No closure/termination test to misfire.** Motion is continuous (a sweeping point), so there is no float-equality closure check to get stuck on. The only reset is the `loopcount > cycles` reseed, which clears `loopcount` and rebuilds every worm — verified each branch re-seeds all of `tx/ty/dtx/dty/pos/color` and the ring buffers.
- **Bounded everything.** `dtx/dty` are clamped to `[0.01, 0.15]` every step; `sin()` keeps points within `xi ± rx` / `yi ± ry`, which `initlissie`'s amplitude math keeps on-screen. A headless harness ran the core iteration for 25 000 steps × 30 worms across every `size` setting (`-500…500`, 0): **0 non-finite values**, `dt` stayed inside `[0.01, 0.15]`, `ri` in `1…360`, **in-bounds fraction 1.000**, ~1.4 M distinct points (no stuck/degenerate curve).
- **Ring-buffer indexing.** Live window is `idx = ((pos - j) % 100 + 100) % 100` for `j ∈ [0, len)` — the floor-mod handles `pos < j` during the first frames; warm-up `(0,0)` slots are skipped by the bounds test. `len ≤ 99 < 100`, so the just-fell-off slot is never inside the window.
- **pause → resume** resets `lastTime` (no catch-up burst); **reinit** clears to black and re-seeds a clean screen. First frame already shows a full worm (pre-roll).
