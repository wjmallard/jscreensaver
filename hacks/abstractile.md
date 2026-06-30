# abstractile -- port notes

Port of `abstractile.c` by Steve Sundstrom (2004-2009) -- mosaic patterns of interlocking tiles. A fine grid is filled with a maze of short horizontal/vertical line-segments; each segment takes a colour from a layered pattern/shape field and a "draw-order" key from one of ~40 draw maps. The segments are sorted by that key and painted incrementally so the mosaic grows in a coherent pattern, held a few seconds, then the previous screen is erased segment-by-segment and a fresh pattern + palette is built.

Original: <https://www.jwz.org/xscreensaver/> - source: `xscreensaver-6.15/hacks/abstractile.c` (~1624 lines, most of it tile-shape / pattern / colour DATA tables).

Shares squiral's skeleton (inline ES module, `config` object, dpr-aware sizing, sparse `fillRect` draws) - see [[squiral]]. It is a grid-tile mosaic like [[truchet]], but stateful: a CREATE / ERASE / DRAW machine that grows and dissolves whole screens, paced by a variable per-step delay like [[boxfit]].

## Algorithm
1. **CREATE** (`_init_screen` + `_create_screen`): pick this screen's `lwid` (cell px), tile style (`d3d`/`round`/`outline`), grid size, palette, draw/erase maps, and 4 layers of pattern/shape parameters. Build a shuffled `zlist` of every cell, then `_newline()` repeatedly: at each cell either start a new line, branch into/out of an existing line, or force a 1-cell line, filling the grid until full. Each line gets a colour (`_getcolor` -> layered `_pattern`/`_shape` field) and a draw-order key (`_getdeo`, one of ~40 maps). Sort all lines by that key.
2. **ERASE**: paint the *previous* screen's lines black, a batch at a time (the old mosaic dissolves).
3. **DRAW**: paint the new screen's lines, a batch at a time, in the sorted order (the new mosaic grows). Tile styles: flat, thin, outline (black gaps at crossings), block (beveled 3D), neon (concentric shade glow), and tiled (the big `_draw_tiled` corner/T/X tile table with per-cell triangles + polygons).
4. **LINGER** `sleep` seconds, then back to CREATE.

The big switch tables -- `_getdeo` (40 draw maps), `_shape` (18), `_pattern` (40), `_draw_tiled` (16 `d`-bitmask tile cases), `_wave`/`_dist`/`_triangle`, and the 30 `basecol` RGBs -- are transcribed **verbatim** from the C, case-for-case (a slip there is a broken tile). Integer math uses `Math.trunc` to match C integer division/casts.

## Colour generation
The palette utilities `make_color_ramp` / `make_color_path` / `make_color_loop` / `make_smooth_colormap` / `make_uniform_colormap` / `make_random_colormap` (from `utils/colors.c`) and `hsv_to_rgb` / `rgb_to_hsv` (from `utils/hsv.c`) are ported faithfully, including `make_color_ramp_rgb`'s C quirk of always passing `closed_p = False`. Colours become CSS `rgb()` strings (16-bit channels `>> 8`). The colour array is laid out as `ncolors` base bands of `shades` each (`shades = 5` for tiled, `lwid/2+1` for block/neon, `1` otherwise); the draw code indexes `colors[(line.color % ncolors) * shades + s]`.

## Deviations from the C
- **Palette regenerated every screen.** The C's `newcols` (regenerate the colormap per screen) was disabled by jwz because it thrashed the X colormap; canvas has no such cost, so this port sets `newcols = true` (the author's original Linux/Mac intent). Successive screens therefore differ in both layout **and** palette, and the per-screen `cmap` rotation actually takes effect. (With the C's shipped `newcols = false`, the whole run reuses one forced-tiled palette of 4-7 base colours.)
- **Neon / block draw is O(lines), not O(object^2).** The C re-draws *every* prior line of a line's connected "object" on each shade level so junction glows merge seamlessly -- that is quadratic in object size and on a large screen would freeze the browser. This port draws each line's shades once. The 3D shade gradient per line is preserved; only a minor seam can show where same-object lines meet at a T/X joint. (TILED, OUTLINE and FLAT have no such quadratic and are fully faithful.)
- **Timing is a faithful transcription, with one rendering-speed caveat.** The pace is `abstractile_draw`'s `usleep` verbatim: each draw/erase batch is `(5-speed)*(2-dialog)*100000/lpu` microseconds and a finished screen lingers `sleep` seconds, with `lpu = li/200` (`li/50` on small "dialog" windows < 500 px). The C subtracts the per-call work time before sleeping; the rAF accumulator loop already absorbs work time by tracking wall-clock, so the port returns the target period itself (no `mse` subtraction). The `/lpu` term reproduces the C's per-screen variation -- the "10/8/6/4/2/0 second" total-draw goals for speed 0-5 -- so dense screens (small `lwid` -> big `lpu`, e.g. `--tile thin`) build fast and sparse screens (`--tile tiled`) build slowly. *Caveat:* canvas `fillRect` is not compute-bound the way XQuartz's X11 draws are, so on the densest screens (`--tile thin`, `lwid 2`) the port hits the C's intended ~0.5 s pace that jwz's comment notes "draws in a blink on Linux," whereas the throttled Mac binary takes ~1.5 s. (Earlier this port used a constant host `delay` knob, so every screen drew in a flat ~4 s regardless of density -- that approximation is gone.)
- **`fillRect` guarded to positive w/h.** X clamps negative-size fills; canvas mirrors them. The rounded-end shrink loop and the neon/block `adj` shrink can produce non-positive rects, so each fill is guarded (`w>0 && h>0`), preventing stray mirrored rectangles.
- **Forced-line direction quirk kept.** The C's "surrounded empty cell" fallback rolls `random()%4` (0-3), which can never select `DIR_RIGHT` (=4) and re-rolls on 0; ported verbatim, plus a 64-iteration safety break so a degenerate 1xN grid can't spin forever (it just skips the cell).
- **`rco` set for d3d screens too.** The C `return`s from `_init_colors` before building the random colour-order permutation on 3D screens (leaving it stale/zero); this port always builds it, so the "by colour" draw order never collapses. Harmless.
- **Dropped / moot:** X11 plumbing, `--fps` (host owns the meter and keys), the dead `dmap` pre-assignment is kept as in the C, and the window-too-small (<=20 px) guard idles. `dialog` (the C's small-window mode) is decided from device width (<500).

## Correctness self-review
- **Termination / no stuck build.** `_create_screen` loops `while (!grid_full && zi < gridn)`; `zi` advances on every `_newline()` (even its early returns), so it is hard-bounded by `gridn`. Every empty cell, when visited in the shuffled `zlist`, is filled (forced if surrounded), so the grid reliably fills; the force loop is guarded. Harness: drove 3000 frames and 8 full multi-screen runs (all 7 tile styles + a 3200x2000 retina build) with no hang.
- **State machine re-seeds the next state's inputs.** CREATE rebuilds `dline` from a fresh sentinel, re-shuffles the grid, regenerates the palette + maps + layer params, and the swap captures `eli`/`elwid`/`egridx`/`egridy`/`emap`/`evar`/`edir` **before** they are overwritten so the erase order matches the screen actually on screen. ERASE -> DRAW -> linger -> CREATE cycle verified.
- **Sort/index consistency.** Grid fields `line/hl/hr/vu/vd` are used only during the build (pre-sort indices, internally consistent); `dhl/dhr/dvu/dvd` are used only during the draw (sorted `di`, set fresh, all cleared each screen). Sorting `dline` moves whole objects, so `dline[di].color/.x/.y/.len/.hv` stay correct after the sort.
- **No NaN / Infinity.** Harness reported 0 non-finite `fillRect`/triangle coordinates and 0 bad fill styles across all modes. All integer divisions use `Math.trunc`; every divisor (`cs2`/`cs4`/`csw`/`ncolors`/`gridx`/`gridy`/`nstr`) is >= 1 by construction.
- **Pause / resume / reinit.** `pause()` cancels rAF and sets `rafId = 0`; `resume()` resets `lastTime` (no catch-up burst). `reinit()` clears to black and re-seeds. The catch-up cap is `max(250 ms, nextDelay)` so a multi-second linger can elapse while a backgrounded tab still can't burst more than `MAX_CATCHUP_STEPS = 8` batches on refocus.

## Config

Mirrors the xml exactly (`speed` / `sleep` / `tile`). abstractile has **no** `*delay`
resource, so there is no host "Frame rate" knob -- the C derives its whole pace from
speed, sleep, and the per-screen `lpu`.

- **speed** (Speed, 0-5, live) - the C's `--speed`. Sets the batch period `(5-speed)*(2-dialog)*100000/lpu` us (5 = ~instant build, 0 = ~10 s).
- **sleep** (Linger, 0-60 s, live) - hold a finished screen before erasing it (the C's `--sleep`).
- **tile** (select, not live -> reinit) - random / flat / thin / outline / block / neon / tiled, matching the xml's `--tile` options.

`reinit` / `r` (restart) clears to black and grows a fresh screen with the current config.
