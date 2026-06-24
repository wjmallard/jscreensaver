# helix — port notes

Port of `helix.c` ("Spirally string-art-ish patterns", Jamie Zawinski, 1992; the algorithm is from a c.1988 Mac program by Chris Tate, with ellipse code by Dan Stromberg and a `-subdelay` watch-the-drawing option by Matthew Strait). Each round draws ONE closed string-art figure of one of two kinds, in one random colour, then holds it on screen for a few seconds and clears to start a fresh figure.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/helix.c` (~358 lines)

## Algorithm
Two figure types are chosen at random each round (the C's `dstate = (random()&1) ? HELIX : TRIG`), both built from a 360-entry sin/cos table indexed in **integer degrees** (`sins[i] = sin(i/180·π)`):

- **HELIX** (`helix()` / `random_helix()`): two moving points are each driven by their own integer harmonic of a single swept `angle`, and a line is drawn between them every step — a Lissajous/string-art weave:
  ```
  x1 = xmid + r1·sins[(angle·f1) mod 360]   y1 = ymid + r2·coss[(angle·f2) mod 360]
  x2 = xmid + r2·sins[(angle·f3) mod 360]   y2 = ymid + r1·coss[(angle·f4) mod 360]
  ```
  `angle += d_angle` each step. `d_angle` is re-rolled until it is **coprime to 360** (`gcd(360, d_angle) == 1`), and the four harmonics `f1..f4` until their overall gcd is 1. The figure runs for `limit = 1 + 360/gcd(360, d_angle) = 361` steps and then closes.

- **TRIG** (`trig()` / `random_trig()`): a chord is drawn between two parametric points on the screen-filling ellipse, swept by `d_angle` until it has woven a dense star/rosette:
  ```
  x1 = sins[(a·f1) mod 360]·xmid + xmid     y1 = coss[(a·f1) mod 360]·ymid + ymid
  x2 = sins[(a·f2+off) mod 360]·xmid + xmid y2 = coss[(a·f2+off) mod 360]·ymid + ymid
  ```
  (`a = d_angle + d_angle_offset`). `d_angle` advances by `±(360 / (2·density·f1·f2))` — clamped to **at least 1** so it can't stall when that integer division underflows to 0 — and the figure finishes once `|d_angle| > 360`. `density ∈ {16,32,64,128}` sets how fine the sweep is (denser = more chords).

### State machine (the C's `helix_draw`)
`NEW_FIGURE → DRAW → LINGER → CLEAR → NEW_FIGURE`.
- **NEW_FIGURE** rolls fresh geometry + colour for the current `figtype` (`random_helix`/`random_trig`), clears the screen, and goes to DRAW.
- **DRAW** advances the figure by one draw call's worth of segments — **10** `helix()` steps or **5** `trig()` steps, matching the C's `DRAW_HELIX`/`DRAW_TRIG` batched loops (both break early on completion) — and goes to LINGER once the figure closes.
- **LINGER** holds the finished figure on screen for `linger` seconds, then CLEAR blanks it, re-rolls the figure type (`random()&1`), and leaves the screen black ~1 s before the next figure (the C's erase transition takes about that long).

## Palette
Colour is **not** a resource and **not** a colormap — helix sets the stroke colour itself, rolling one fresh HSV per figure (in `random_helix`/`random_trig`):

```
hsv_to_rgb(random() % 360, frand(1.0), frand(0.5) + 0.5)
```

So **hue** is uniform 0-359, **saturation** is uniform 0-1 (many figures come out pastel or near-white), and **value** is 0.5-1.0 (always at least half-bright). The port reproduces this exactly via a self-contained `hsvToRgb255()` — a port of `utils/hsv.c` with the X server's 16-bit -> 8-bit downsample folded in (matching `colormap.js`'s quantization). Live captures confirm the spread: white, pale green, dusty pink, muted purple, blue.

This replaces an earlier fixed vivid `hsl(h, 100%, 60%)` rainbow indexed by a non-stock `ncolors` slider (the systemic palette bug) — full-saturation strokes that could never produce helix's frequent washed-out figures. The `ncolors` slider is removed (helix has no colour-count control); the C's `mono_p` white fallback never occurs on canvas, so the colour path always runs.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. This is the same family as **[[xspirograph]]** (parametric trig figure → polyline → stroke → linger → clear → new figure) and the structure is copied closely from it: a per-figure state machine plus a **variable-delay loop** where `step()` returns the ms until the next step.

## Rendering — vector ops, incremental (persistent canvas)
The figure is genuinely line-shaped (the C emits one `XDrawLine` per step), so this uses **canvas vector ops**, not a blit. Like [[xspirograph]] (and unlike braid/boxfit, which clear-and-repaint every frame), helix **draws incrementally onto the persistent canvas**: each `step()` accumulates that draw call's batch of segments into a `Path2D` and `stroke()`s it once in the figure's colour. Nothing is repainted — the figure builds up over many frames, and the screen is cleared only between figures, exactly like the C drawing into the live window. The canvas is double-buffered so the running stroke is flicker-free.

## Timing
helix has two stock timescales:
- **`--subdelay`** (default **20000 µs**) — the pause between draw steps. Each draw call advances the figure by 10 `helix()` steps or 5 `trig()` steps, exactly as the C batches them.
- **`--delay`** (default **5**) — confusingly, this is the LINGER in **seconds** (the C's `sleep_time * 1e6`), the hold once a figure is complete. The `*delay: 5` in the C's DEFAULTS is *not* a 5 µs per-frame delay.

**OVERHEAD calibration.** The draw phase is **delay-bound**, not compute-bound: the live `-fps` overlay reads **Load 24-46%** (it sleeps most of each frame). Measured live draw rate ≈ **36 fps** (samples 28.5 / 38.1 / 36.0 / 39.8 / 35.8 / 35.5; HELIX is denser/slower than TRIG, ±15% run variance). So `OVERHEAD = round(1e6/36) - 20000 = 7778 µs` (the port uses **7800**) and the draw paces at `(subdelay + OVERHEAD)/1000` ms. The port then measures **~35.7 draw-steps/s** (mean in-burst step gap 28.0 ms; the rAF 16.7 ms quantum makes individual gaps bimodal 16.7/33.3 ms). The **linger (5 s) is left untouched** — a multi-second hold needs no overhead. (The prior port had a by-eye `subdelay` of 50000, drawing ~2.5× too slow.)

`step()` returns the ms to wait before the next step — `(subdelay + OVERHEAD)` while drawing, `linger` seconds at the hold, ~1 s of black after the clear — and the rAF lag-accumulator honours it (`acc` is capped at `nextDelay + 1000`, never below `nextDelay`, so a long linger pause always elapses), boxfit/xspirograph-style.

## Deviations from the C
- **Erase = instant black, a wipe candidate.** The C runs xscreensaver's `erase_window` transition (an animated wipe) between figures. As instructed — and exactly like `xspirograph.js`'s `clearScreen()` — this port just `fillRect`s the screen black at that point. **Replacing it with a real wipe is a future enhancement** once a shared `wipes.js` module exists.
- **`devicePixelRatio`.** The backing store is device-px and the line width is scaled by `dpr` (the C only bumps width to 3 px past 2560). The figure geometry is derived from the canvas size (`radius = min(W,H)/2`, `xmid/ymid = W/2, H/2`), so it auto-scales; no logical-size constants needed scaling, so the closure conditions (`limit` steps for HELIX, `|d_angle| > 360` for TRIG) are unaffected.

(Palette and the draw-step frame rate were both fixed in the fidelity audit — see **Palette** and **Timing** above; they are no longer deviations.)

## Correctness self-review (closure / reset / termination)
This family has bitten past ports (a sweep param that never resets = "dead line"; a closure test that never fires = endless over-draw; a catch-up cap below a long pause = freeze). Checked each:
- **Reset on every new figure.** `NEW_FIGURE` always calls `randomHelix()`/`randomTrig()`, which set `i = 0` (HELIX) and `dAngle = 0` (both). HELIX's `angle` is seeded on the first `helixStep` (`if (i === 0)`), so each figure starts from a fresh sweep — no leftover state from the previous figure.
- **Bounded termination, no exact-float trap.** Neither figure relies on float-equality closure. HELIX terminates by **integer step count**: `d_angle` is forced coprime to 360, so `limit = 361` exactly, and `helixStep` returns `true` when `i >= limit`. TRIG terminates when the integer `d_angle` leaves `[-360, 360]`; its step is clamped to ≥ 1 (the C's `if (tmp == 0) tmp = 1`), so it always advances and reaches the bound in at most ~720 steps even at the densest setting. Both are hard integer bounds — no figure can loop forever.
- **Linger actually elapses.** The accumulator is capped at `nextDelay + 1000` (not a fixed small value), and the catch-up `while` never decrements below `nextDelay`, so a `linger`-second hold drains in one step rather than being clipped — the figure is genuinely held, then cleared.
- **First frame looks right.** Geometry is rolled before the first `DRAW`, and the initial `clearScreen()` blanks the canvas, so there's no off-screen/degenerate opening frame. `pause`→`resume` resets `lastTime` (no catch-up burst) and `reinit` resets `nextDelay = 0` and re-seeds, giving a clean fresh screen.
- Traced by hand that **multiple distinct figures** draw in succession: after a figure closes → LINGER → CLEAR re-rolls `figtype` and geometry → a new, differently-shaped figure draws. Verified both branches (HELIX and TRIG) reach `finished = true` and hand back to NEW_FIGURE.

## Config
Two sliders, mirroring the stock resources:
- `subdelay` — **Frame rate** (`--subdelay`, µs/step, live, inverted: drag right = faster).
- `linger` — **Linger** (`--delay`, 1 s … 1 min hold before clearing, live).

Both are live; `reinit()` starts a fresh sequence with the current config. Local-dev/module-fetch caveat is the same as `squiral.md` (serve over http, not `file://`).
