# whirlygig — port notes

Port of `whirlygig.c` by Ashton Trey Belew (2001) — "Zooming chains of sinusoidal spots." A global clock drives a chain of filled circles whose centre is a sin/cos curve; the whole chain crawls, zooms, and cycles colour, and the curve "mode" re-rolls itself periodically.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/whirlygig.c` (~740 lines). Removed from the XScreenSaver distribution as of 5.08, per the XML description.

## Algorithm
A single integer clock `currentTime` ticks up by `speed` (=1) each step. Each step:
- **Colour** advances one slot through a 100-entry palette (wraps at NCOLORS).
- For each of `whirlies` spots, an `internalTime = currentTime + 10*w + w*w` is used, so successive spots sit further along the curve and string out into a moving chain.
- The spot's `(x,y)` comes from a per-axis **mode** function of `internalTime`:
  - `spin` — `cos/sin` of a continuously growing argument times a `cos/sin((t%360))` envelope (evolves forever).
  - `funky` — like spin but the whole curve is a function of `t%360` only (periodic, ~360 ticks).
  - `circle` / `test` — identical in the C: a plain rotating point of radius `half/2`.
  - `linear` — `(t/2) % (2*half)`, a sawtooth sweep.
  - `fun` — a triangle-wave radius (built from `half_width` for **both** axes) times `cos/sin`.
  - `innie` — slow-beating amplitude (`cos(t/frequency)`) around a wandering centre.
  - `lissajous` — a Lissajous curve whose frequency ratio `weird` drifts very slowly.
- For each of `nlines` lines, the spot is offset by `20*line*sin(internalTime*offset_period/90)` (an oscillating fan), drawn as a filled circle of pulsing size `15 + 5*sin(t/180)`.
- The clock ticks; it wraps to 1 exactly at `FULL_CYCLE` (429496729).

The default **change** mode (for both x and y) re-rolls the active mode to one of funky/circle/linear/test every `CHANGE_TIME` (4000) ticks. Because `startTime` starts at 0 and `currentTime` starts at a large random value, the first change fires on frame 1 (matching the C).

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — sparse arcs; clear-each-frame (no trail) vs accumulate (trail)
At most `whirlies*nlines` small filled circles per step (default ≤ 15*5), so this is **sparse**: each spot is one `ctx.arc/fill` (the C's `XFillArc` over a full 360°·64 arc), centre `(xpos+size/2, ypos+size/2)`, radius `size/2`. The C's `XFillArc` places the bounding-box top-left at `(xpos,ypos)`; that offset is reproduced exactly.

The C's trail handling is tangled with X double-buffering: the default Linux path (`useDBEClear`) clears the back buffer every swap, while the per-circle "erase old spot" path only runs when DBE-clear is off (e.g. the macOS/jwxyz path). I collapse both to the visible intent:
- **trail off (default):** clear the whole canvas to black at the start of each step, then redraw — the chain glides cleanly with no leftovers (matches the DBE-clear default).
- **trail on:** never clear (after the initial black fill) — spots accumulate into a dense painting (matches the `--trail` intent and the non-DBE macOS path).

This drops the C's `last_x/last_y/last_size[100][100]` per-spot erase bookkeeping (only needed for the partial-erase X path) in favour of a full-frame clear, which also avoids the overlap "holes" that per-spot black erases leave where the chain crosses itself.

## Coordinate space / retina
All curve math runs in **logical** pixels (`half_width = innerWidth/2`, etc.) and is multiplied by `S = devicePixelRatio` only at draw time, so the whole pattern (including the fixed pixel constants 50/150/200 and the spot size) scales uniformly and looks identical at any DPR. Spot positions are truncated to integers (`Math.trunc`) to match the C's `int pos[]`.

## Deviations from the C
- **No XOR / no X double-buffer** — none used; canvas double-buffers natively. Trail behaviour reproduced as above (full clear vs accumulate) rather than the DBE/`last_*` partial erase.
- **Clock kept as a JS double.** The C truncates `internal_time` to a 32-bit `int`, which would eventually overflow to negative as the clock grows; we keep an exact integer double, so the modulo-driven curves stay correct indefinitely (no `>>`/int32 overflow — see the brief's warning). Identical to the C while in range; the harness confirms finite, in-range output even past 2^31 and near `FULL_CYCLE`.
- **`whirlies`/`nlines` use `0 = random`** (the C's sentinel is `-1`; our sliders are non-negative, like squiral's "count 0 = auto"). 0 re-rolls 1..15 / 1..5 on each `reinit`.
- **`xspeed`/`yspeed` clamped to ≥ 0.1.** The XML allows 0.0, but spin/funky divide by `180*speed`, so 0 yields `cos(Inf)=NaN` (the spot vanishes). 0.1 keeps them finite. `circle`/`test`/`fun`/`innie` are unaffected by this.
- **Mode `change` is the default select option.** In the XML the unlabelled "X random" option (no `arg-set`) simply leaves the `*xmode: change` resource default in force, so it *is* change mode; exposed plainly as "Change".
- **Not exposed (kept at XML defaults):** `speed` (1; the C warns changing it "will probably suck"), `color_modifier` (random 1..25), `offset_period`/`xoffset`/`yoffset` (1.0), and the `explain`/`showfps` host-only toggles. The colormap is a vivid HSL rainbow (house style) instead of the original's `make_uniform_colormap`.
- **Default `delay` 16000 µs** (~one display frame) vs the stock ~10000 µs (100 fps) — a touch calmer, per the brief. With `change` mode this means ~66 s between mode re-rolls (stock ~40 s); within a mode the chain moves continuously.

## Correctness self-review
- **No termination/closure to stall.** There is no "figure done" or float-equality close test — the loop simply ticks forever, so it can't dead-end or over-draw. The clock's only reset (`=== FULL_CYCLE`) is hit cleanly because `speed=1` steps the integer clock by 1.
- **Every state branch re-seeds what it reads.** `init()` seeds `currentTime` (random), `startTime=0`, `xmode`/`ymode` (random 0..6), `currentColor`, `colorModifier`, `modifier`, `whirlies`, `nlines` before the first step. The `change` re-roll sets `startTime = currentTime` whenever it fires, so the timer always advances.
- **Frame 1 shows a developed chain**, not a dot at the origin: `currentTime` is seeded to a large random value, so `internalTime` is large and the spots are spread along the curve immediately.
- **No divergence / NaN.** A headless harness (`computeAxis` for all 8 modes, 4 clock starts incl. `~FULL_CYCLE` and `>2^31`, 2000 ticks each) reported `bad=0` (all finite) and positions within `[0, ~2*half]` for every mode. `funky` is intentionally periodic (≈360 distinct points) — that is the C's `t%360`-only formula, not a stuck state; the chain still moves because each spot has a distinct `internalTime` and the size/colour evolve.
- **pause/resume/reinit:** pause cancels rAF (`rafId=0` sentinel); resume resets `lastTime` so no catch-up burst; `reinit()` re-seeds and clears. The catch-up cap (`MAX_CATCHUP_STEPS=8`) bounds a refocus burst.

See [[spiral]] (drifting sinusoid, sparse `fillRect`) and [[whirlwindwarp]] (sparse particle plotting on a persistent canvas).
