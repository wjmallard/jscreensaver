# helix — port notes

Port of `helix.c` ("Spirally string-art-ish patterns", Jamie Zawinski, 1992; the algorithm is from a c.1988 Mac program by Chris Tate, with ellipse code by Dan Stromberg and a `-subdelay` watch-the-drawing option by Matthew Strait). Each round draws ONE closed string-art figure of one of two kinds, in a single cycling hue, then holds it on screen for a few seconds and clears to start a fresh figure.

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

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. This is the same family as **[[xspirograph]]** (parametric trig figure → polyline → stroke → linger → clear → new figure) and the structure is copied closely from it: a per-figure state machine plus a **variable-delay loop** where `step()` returns the ms until the next step.

## Rendering — vector ops, incremental (persistent canvas)
The figure is genuinely line-shaped (the C emits one `XDrawLine` per step), so this uses **canvas vector ops**, not a blit. Like [[xspirograph]] (and unlike braid/boxfit, which clear-and-repaint every frame), helix **draws incrementally onto the persistent canvas**: each `step()` accumulates that draw call's batch of segments into a `Path2D` and `stroke()`s it once in the figure's colour. Nothing is repainted — the figure builds up over many frames, and the screen is cleared only between figures, exactly like the C drawing into the live window. The canvas is double-buffered so the running stroke is flicker-free.

## Variable-delay loop
`helix_draw` returns the microseconds to wait before the next call — `subdelay` while drawing, `linger` seconds at the hold, ~1 s of black after the clear. The port keeps this boxfit/xspirograph-style: `step()` returns the ms until the next step and the rAF lag-accumulator honours it (`acc` is capped at `nextDelay + 1000`, never below `nextDelay`, so a long linger pause always elapses).

## Deviations from the C
- **Erase = instant black, a wipe candidate.** The C runs xscreensaver's `erase_window` transition (an animated wipe) between figures. As instructed — and exactly like `xspirograph.js`'s `clearScreen()` — this port just `fillRect`s the screen black at that point. **Replacing it with a real wipe is a future enhancement** once a shared `wipes.js` module exists.
- **Colour.** The C rolls a full random HSV (`random()%360`, random saturation, value 0.5–1.0) per figure. This port keeps the gallery's vivid `hsl()` rainbow: a random index into an `ncolors`-entry palette. `ncolors` is **added for parity** with the other hacks (stock helix has no colour-count control).
- **`devicePixelRatio`.** The backing store is device-px and the line width is scaled by `dpr` (the C only bumps width to 3 px past 2560). The figure geometry is derived from the canvas size (`radius = min(W,H)/2`, `xmid/ymid = W/2, H/2`), so it auto-scales; no logical-size constants needed scaling, so the closure conditions (`limit` steps for HELIX, `|d_angle| > 360` for TRIG) are unaffected.
- **Default frame rate.** Stock `subdelay` is 20000 µs and `delay`/linger is 5 s; kept as-is (already calm). `delay` (linger) honours the slider directly.

## Correctness self-review (closure / reset / termination)
This family has bitten past ports (a sweep param that never resets = "dead line"; a closure test that never fires = endless over-draw; a catch-up cap below a long pause = freeze). Checked each:
- **Reset on every new figure.** `NEW_FIGURE` always calls `randomHelix()`/`randomTrig()`, which set `i = 0` (HELIX) and `dAngle = 0` (both). HELIX's `angle` is seeded on the first `helixStep` (`if (i === 0)`), so each figure starts from a fresh sweep — no leftover state from the previous figure.
- **Bounded termination, no exact-float trap.** Neither figure relies on float-equality closure. HELIX terminates by **integer step count**: `d_angle` is forced coprime to 360, so `limit = 361` exactly, and `helixStep` returns `true` when `i >= limit`. TRIG terminates when the integer `d_angle` leaves `[-360, 360]`; its step is clamped to ≥ 1 (the C's `if (tmp == 0) tmp = 1`), so it always advances and reaches the bound in at most ~720 steps even at the densest setting. Both are hard integer bounds — no figure can loop forever.
- **Linger actually elapses.** The accumulator is capped at `nextDelay + 1000` (not a fixed small value), and the catch-up `while` never decrements below `nextDelay`, so a `linger`-second hold drains in one step rather than being clipped — the figure is genuinely held, then cleared.
- **First frame looks right.** Geometry is rolled before the first `DRAW`, and the initial `clearScreen()` blanks the canvas, so there's no off-screen/degenerate opening frame. `pause`→`resume` resets `lastTime` (no catch-up burst) and `reinit` resets `nextDelay = 0` and re-seeds, giving a clean fresh screen.
- Traced by hand that **multiple distinct figures** draw in succession: after a figure closes → LINGER → CLEAR re-rolls `figtype` and geometry → a new, differently-shaped figure draws. Verified both branches (HELIX and TRIG) reach `finished = true` and hand back to NEW_FIGURE.

## Config
Ranges mirror `hacks/config/helix.xml`. The xml reuses `id="delay"` for two different sliders, ported under distinct keys:
- `subdelay` — **Frame rate** (`--subdelay`, µs/step, live, inverted: drag right = faster).
- `linger` — **Linger** (`--delay`, 1 s … 1 min hold before clearing, live).
- `ncolors` — **Colors** (added for parity; non-live).

Non-live changes and `reinit()` start a fresh sequence with the current config. Local-dev/module-fetch caveat is the same as `squiral.md` (serve over http, not `file://`).
