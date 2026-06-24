# lmorph — port notes

Port of `lmorph.c` ("Smooth and non-linear morphing between 1D curves", Sverre H. Huseby and Glenn T. Lines, 1993–1999) — generates a pool of random spline-ish line figures and endlessly morphs the drawn polyline from one to another. (Removed from the stock XScreenSaver distribution as of 5.08; the source ships in the tree.)

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/lmorph.c` (~579 lines).

## Algorithm
`initPointArrays()` builds a fixed pool of figures once, sized to the screen:
- **Closed** (figtype `all`/`closed`): a rectangle, four lissajous loops (1:3, 3:1, 2:3 and a plain circle/ellipse), and a 30-lobe flower — 7 figures.
- **Open** (figtype `all`/`open`): a 1-period sine, a 3-period cosine, two 5/6-arm spirals, and a 5-period sine — 5 figures.

Every figure is then scaled to 80% and re-centred (the C's `MARGINS`).

Each frame (`animateLMorph` → `createPoints` + `drawImage`):
- A morph runs `from = figs[nFrom]` → `to = figs[nTo]` over `steps` frames. Point `i` is a **cubic Bezier** from `from[i]` to `to[i]`, with the two interior control handles set from end-tangents (`aSlopeFrom`, `aSlopeTo`) — Hermite→Bezier. `aSlopeTo[i] = next[i] - to[i]` points toward the *next* figure, so successive morphs hand off C1-continuously; `aSlopeFrom` inherits the previous `aSlopeTo`.
- The Bezier parameter is **per-point**: `fg = gamma + 1.67·speed·exp(-200·(gamma - 0.5 + 0.7·speed)²)` where `speed = 0.45·sin(2π·(q+shift)/(numPoints-1))`. The Gaussian bump kicks each point forward/back near the middle of the morph, phase-shifted by `shift`, producing the travelling-wave "non-linear" feel rather than a flat cross-fade.
- `drawImage` clears the window and strokes the whole polyline (the active `#else` path; the incremental-redraw branch is `#if 0`-disabled in the C).

When `gamma` passes 1.0 the morph re-seeds: `to → from`, `next → to`, a fresh random `next` (≠ `to`), a new `shift`, an optional in-place point-order reversal of the next figure, and recomputed slopes.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. Closest twins: `xspirograph.js` / `qix.js` (line-figure idioms).

## Rendering — vector ops, full repaint per frame
The figure is genuinely line-shaped, and the C re-clears and re-draws the entire polyline every frame, so this uses **canvas vector ops with a full repaint**: `fillRect` black, accumulate all `numPoints` into a `Path2D`, `stroke()` once. No erase/XOR trick is needed — every frame redraws from scratch (unlike `xspirograph`, which accumulates). Figures are generated directly at device resolution, so they fill the canvas; only the line width is scaled by `devicePixelRatio`.

## Palette — single static foreground, faithfully
lmorph is a **native screenhack** (`#include "screenhack.h"`): no colormap, no colour-scheme define. `initLMorph()` allocates one foreground pixel from the `foreground` resource (default `#4444FF`, a blue the source notes was "brightened a little bit") and draws **every** figure of **every** frame through that one GC — the colour never changes over a run. So this port strokes a fixed `#4444FF` on black (`const FG`). Verified against the live binary: clean captures are solid blue (2 colours, black + `#4444FF`).

An earlier version of this port drifted the hue each frame (`hsl(h, 90%, 62%)` plus a `colorSpeed` knob) "for parity with the other hacks". That was the systemic vivid-rainbow deviation — lmorph has no colour cycling — and has been removed.

## Timing — stock delay + measured OVERHEAD
- **Stock delay** `70000` µs and **stock steps** `150` (`lmorph_defaults`); both are now the port defaults (the slider maps `delay` 1:1 to the resource).
- The hack is **delay-bound**: `lmorph -delay 0 -fps` measured ~3265 fps, so the per-frame compute (`createPoints` over `points`, one `XDrawLines`) is trivial.
- At stock delay the live `-fps` overlay read a clean **~11.2 fps** (Load 16–25%; individual reads 10.7 / 10.9 / 11.1 / 11.5 / 12.0 fps), i.e. an ~89000 µs period. So `OVERHEAD = 1e6/11.2 − 70000 ≈ 19000` µs.
- The frame loop runs one `step()` every `(config.delay + OVERHEAD)/1000` ms. Measured port rate: **~11.2 steps/sec** (`Math.exp` hook, which only `createPoints` calls), matching live. A full morph (150 steps) lasts ≈ 13 s.
- Caveat: dense self-overlapping figures briefly spike the live binary to ~8 fps (Load 100%) — XQuartz's slow `XClearWindow`/`XDrawLines` on macOS, not the delay-bound steady state — so they do not drive OVERHEAD.

## Correctness self-review (closure / reset / freeze)
- **Re-seed is driven by an integer step counter, never `float == 1.0`.** `currGamma = stepNum / steps` is rebuilt from the integer `stepNum` each frame (no float accumulator to drift), and the morph ends on `stepNum > steps`. This is the brief's headline hazard: an exact-equality test against 1.0 would either never fire (freeze on one shape) or skip the re-seed. The integer test fires deterministically, traversing `gamma` over `[0, 1]` inclusive (both endpoints shown) then re-seeding.
- **Every state the next morph reads is re-seeded** in `seedNextMorph()`: `nFrom/nTo/nNext`, `aFrom/aTo`, `shift`, and both slope arrays. The startup `stepNum = SEED_NOW` sentinel forces the first `step()` to seed before drawing (mirrors the C's `currGamma = maxGamma + 1`), so the **first visible frame is a valid figure** (`gamma = 0` ⇒ exactly `aFrom`).
- **`do { nNext = rnd } while (nNext === nTo)` terminates** because every figtype yields ≥ 2 figures (open 5, closed 7, all 12).
- **No divergence.** A headless harness (1000×800, 6 morphs ≈ 2400 frames) recorded **0 non-finite coords**, x∈[40.8, 956], y∈[-2.8, 785] (a sub-3px Bezier-tangent overshoot above the top edge — visually negligible, draws just off-screen), 68 distinct figure checksums, and a **max-consecutive-identical-frames of 0** (never freezes). A second harness confirmed `figtype` open/closed and `points` 10…1000 plus pause/resume all run clean.

## Deviations from the C
- **Float coords, not `short`.** The C truncates every point to an `XPoint` (`short`), pixel-snapping. Canvas takes floats, so the port keeps full precision for smoother strokes. No behavioural effect beyond sub-pixel smoothing.
- **In-place point reversal kept.** The C's `RND(2)` reversal mutates the stored figure array in place (the source comment: "reverse the array to get more variation"), so figures accumulate reversals over time — replicated faithfully. A polyline drawn forward or backward traces the same path, so this never causes a visual jump; it only varies the point-correspondence of the morph.
- **Double-buffer dropped.** The C's `aWork[2]`/`aPrev` ping-pong only fed the disabled incremental-redraw branch; since the active path fully repaints, the port uses a single work buffer. No visible difference.
- **`--fps` toggle dropped** (host concern, not the hack's).

## Config
Defaults/ranges mirror `lmorph.c`'s `DEFAULTS` (lmorph has no `.xml`):
- `delay` — **Frame rate** (`--delay`, µs/step, live, inverted: drag right = faster; default **70000**, the stock value).
- `points` — **Control points** (`--points`, 10–1000; default 200; non-live — sizes the point buffers, re-runs via `reinit()`).
- `steps` — **Interpolation steps** (`--steps`, 100–500; default **150**, the stock value; live — morph speed).
- `linewidth` — **Lines** (`--linewidth`, 1–50; default 5; live).
- `figtype` — **Figures** (`--figtype` all/open/closed; non-live — sizes the figure pool).

Non-live changes and `reinit()` start a fresh screen with the current config. Local-dev/module-fetch caveat is the same as `squiral.md`.
