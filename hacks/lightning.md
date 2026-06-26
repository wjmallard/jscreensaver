# lightning -- port notes

Port of `lightning.c` (Keith Romberg, 1996-1997) -- crackling fractal lightning bolts. Each "storm" seeds 1-4 jagged top-to-bottom bolts (midpoint-displacement polylines with up to 2 forks to the ground). Every drawn frame the whole bolt is re-jittered by a wiggle amount that decays to zero, so it crackles and flickers for ~20 frames, then dies and a fresh storm strikes. Brightness is a per-frame "strike level" (thin white core, then a wider coloured glow) with an explicit invisible "flash gap" mid-life.

Original: <https://www.jwz.org/xscreensaver/> - source: `xscreensaver-6.15/hacks/lightning.c` (~600 lines). Removed from xscreensaver as of 5.08; kept here for the gallery.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` -- see `squiral.md`. The recursive-subdivision twins are `ccurve` and `forest` (`See [[ccurve]]` / `[[forest]]`); the fixed-timestep loop is the `squiral` one.

## Algorithm
A **bolt** runs from `end1` (random x, y=0) to `end2` (random x, y=H). `generate()` is midpoint displacement: recurse to a fixed depth, and at each midpoint jitter by `+/-WIDTH_VARIATION/2` x and `+/-HEIGHT_VARIATION/2` y; at depth 0 emit the leaf point. The main bolt uses `BOLT_ITERATION = 4` (`middle[0..14]`, 15 drawn points); per main vertex there's a 4% chance of a **fork** down to the ground, subdivided more finely the higher up it starts (`create_fork`: depth 3 / 5 / 9 vertices by `level`). `setup_multi_strike` picks 1/2/3/4 bolts; each bolt gets a `delay_time` (when it first strikes, staggered for multi-strike), a `wiggle_number` (lifespan, 8..23) and a `flash` window.

The driver (`draw_lightning`) is a 5-state **stage machine**, one state per tick:
- **0** clear, pick a random storm colour, reset `draw_time`, arm.
- **1** draw every visible bolt at its current strike level, then `update_bolt` each (wiggle the geometry, advance visibility + strike level), `draw_time++`.
- **2** hold the drawn frame for 7 ticks (`busyLoop > 6`) -- the strobe hold.
- **3** clear; loop back to 1 while the storm is active, else go to 4.
- **4** re-seed the whole storm (new geometry + timing, the C's `init_lightning`) and drop to stage 0.

So one **drawn frame spans ~9 ticks** (1 draw + 7 hold + 1 clear). `update_bolt` decays `wiggle_amount` (14 down toward 0, nudged +1 every 3rd frame); when it reaches 0 the bolt's `wiggle_number` is zeroed, and once **all** bolts are zeroed `storm_active()` is false and stage 3 -> 4 re-seeds. Visibility has a gap (`flash_begin .. flash_stop`) where the bolt is drawn black, producing the flicker; `strike_level` ramps thin -> wide -> thin around that gap.

## Rendering -- vector strokes, white core over a coloured glow
Genuinely line-shaped (one `XDrawLine` per segment in the C). The C fakes a thick bolt by re-drawing the polyline at `+/-1` then `+/-2` pixel offsets (outer copies coloured, centre white). Canvas has a native `lineWidth`, so the whole bolt (end1 -> middle -> end2, plus forks) is built as **one `Path2D`** and stroked at the level's widths: level 0 = 1px white; level 1 = 3px glow + 1px white core; level 2 = 5px glow + 1px white core. Widths scale by `devicePixelRatio` so the bolt reads on retina. Glow colour is one random bright hue per storm (`hsl`); white when `ncolors <= 2` (the C's mono fallback). A whole storm frame paints in a handful of `stroke()`s -- sparse vector, no per-pixel work.

## Deviations from the C
- **`lineWidth` instead of pixel-offset copies.** The C's `draw_line` re-strokes the polyline at small x/y offsets (with a quirky y-direction-dependent offset to keep corners joined); this port uses native thick strokes, which join cleanly, and scales width by dpr so the offsets (`+/-1`, `+/-2` device px, sub-pixel on retina) don't vanish. Same coloured-glow-with-white-core look. Level 2's inner `+/-1` glow band is fully covered by its `+/-2` band and the white core, so it's dropped (one fewer stroke, no visual change).
- **`NRAND(0)` guarded.** The standalone `NRAND(n)` is `random() % n` -- a crash at `n == 0`. `wiggle_line` is called with `wiggle_amount`, which hits 0; the original avoids the crash only because every bolt shares `draw_time`, so all reach amount 0 (and zero their `wiggle_number`) on the *same* frame the storm goes inactive, and the `amount == 0` call is never reached. The port keeps that synchronisation exactly **and** guards `nrand(n<=0) -> 0`, so a stray 0 just means "no displacement" instead of `NaN`.
- **Prompt opening strike.** A fresh storm's first bolt has `delay_time = NRAND(15)`, i.e. up to ~14 black frames (~1.3 s with the 9-tick frame) before anything appears. To avoid a long black wait at load/resize/reinit, the *first* storm after `init()` clamps bolt 0's `delay_time` to `NRAND(2)`. Later storms (re-seeded in stage 4) use the full stock range, so inter-strike gaps are preserved.
- **Float coords, no int truncation.** The C uses `XPoint` (short) coords; the port keeps floats (smoother subpixel) and works in device px, scaling all jitter/wiggle/fork-distance constants by dpr so the jaggedness stays proportionally the same on retina. Integer divisions in the timing math (`/2`, `%3`) are kept exact (`Math.floor`).
- **Clear-and-redraw, no XOR / no fade.** The C draws each frame onto the freshly `XClearWindow`-ed canvas and never uses XOR; the brightness change is the strike-level width, not an alpha fade. The port matches: stage 3 clears, stage 1 redraws. (No `globalCompositeOperation` tricks needed.)
- **`ncolors`** maps to the random glow hue (the C's `st->color = NRAND(MI_NPIXELS)` over a `BRIGHT_COLORS` map); a smooth `hsl` hue reads the same. `<=2` -> white bolts. Keypress / `fps` handling dropped (the host owns keys and the meter).

## Correctness self-review
Verified with a headless harness (mock canvas/`Path2D`/`window`, driving the stage machine ~6000 ticks ~= 60 s, then pause/resume/reinit):
- **Termination / progression.** Each storm runs stage 0 -> [1,2x7,3] x ~21 -> 4 and re-seeds; ~31 storms over 6000 ticks. `draw_time` is bounded (resets to 0 in stage 0 each storm) and the wiggle schedule is identical for all bolts, so every storm decays to `storm_active() == 0` and stage 4 fires -- no stall, no runaway. Recursion depth is a fixed constant (<=4 for the bolt, <=3 for forks), so the segment count can't explode the stack.
- **Every state re-seeds what the next reads.** Stage 4 rebuilds all bolt geometry/timing before stage 0; stage 0 re-picks the colour and resets `draw_time` before stage 1 draws. No "dead" bolt: a fresh storm always has `wiggle_number >= 8 > 0`, so stage 0's `storm_active()` is true and it proceeds to draw.
- **No endless black.** 345 of 6000 ticks issued a stroke; bolts become visible every storm (the `delay_time`/`flash` windows always leave several visible frames, and the first storm strikes within ~2 frames).
- **No NaN / no runaway coords.** 0 non-finite coordinates across the run. Max `|coord|` was ~2571 dev px on a 2560-wide canvas -- a few px of wiggle drift past the edge (clipped by the canvas), which resets every storm when geometry is regenerated; it does not grow over time.
- **pause/resume/reinit.** Paused -> 0 strokes; resume/reinit both resume drawing cleanly; `lastTime` reset on resume avoids a catch-up burst.

## Config
Ranges mirror `hacks/config/lightning.xml`: `delay` (Frame rate, live, inverted, 0-100000 us) and `ncolors` (Colors, reinit, 1-255). Both defaults match the stock values. A non-live change (`ncolors`) and "Reset to defaults" re-run `init()` (fresh storm). `delay` is per *tick*; a drawn frame is ~9 ticks, so the bolt crackles ~once per `9*delay`.
