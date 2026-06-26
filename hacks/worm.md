# worm — port notes

Port of `worm.c` (Brad Taylor, Dave Lemke, Boris Putanec, and Henrik Theiling; 1991) — multicolored worms crawl around a toroidal screen, each a wiggling rainbow snake. Removed from the XScreenSaver distribution as of 5.08, ported here from the vendored 6.15 tree.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/worm.c` (~433 lines)

## Algorithm
Each worm keeps a **circular buffer** of its last `wormlength` positions plus a current heading (`dir`, one of 36 directions = 10 degrees each). Every step:
1. Advance the ring index (`tail = (tail + 1) % wormlength`), wrapping.
2. The cell now at `tail` is the **oldest** position — erase it to black, then overwrite that slot with the new head.
3. Turn the heading by +/-1 segment at random, advance one cell of `size` pixels (`x += size*cos(dir)`, `y += size*sin(dir)`), **wrapping toroidally** on all four edges.
4. Draw the new head in the worm's current color.

So each worm is always exactly `wormlength` segments long (one erased, one drawn per step). `wormlength = sqrt(w+h) * cycles / 8` (cycles=10 default). Each frame the whole palette offset (`chromo`) shifts by one, so worm *i*'s color is `(i + chromo) % ncolors`; since drawn segments keep the color they had when laid down, the body becomes a **moving rainbow gradient** along its length.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see [[squiral]] for the shared skeleton (rAF lag-accumulator, dpr sizing, params schema). The moving colored-trail idea mirrors [[binaryring]], but rendering here is **sparse** (two `fillRect`s per worm per step: erase tail, draw head) — no per-pixel buffer.

## Rendering — sparse fillRect, erase-then-draw in two passes
Integer-aligned `fillRect` (crisp, no AA, so an erase exactly covers a same-position dot). Within a `step()` **all** worms erase their tails (pass 1) **before** any head draws (pass 2), matching the C, which clears each tail immediately in `worm_doit` but batches the `XFillRectangles` draws in `draw_worm`. This stops one worm's tail-erase from biting another worm's freshly drawn head.

The erase never needs its own wrap logic: the tail coordinate was stored already-wrapped when it was a head, and the dot rectangle is allowed to clip at the canvas edge exactly as X11's `XClearArea` clipped at the window border (dots are **not** split/wrapped across an edge — only the center position wraps, same as the C).

## Deviations from the C
- **3D mode dropped.** worm.c's `use3d` path (red/blue anaglyph eyes via `diffcirc`/`z`/`dir2`, drawn with `GXor`) is omitted — `use3d` defaults False and there's no X GC XOR on a 2D canvas. 2D path only.
- **Expose-redraw dropped.** The `redrawing`/`REDRAWSTEP` logic only services X11 expose events (`refresh_worm`); a `<canvas>` persists, so it's unused. Removed.
- **Erase = black fill.** The C's `XClearArea` clears to the window background (black); emulated with a black `fillRect` (not XOR). Faithful.
- **Color.** The C uses a smooth palette and falls back to white-only when `ncolors <= 2`; we always use an `hsl()` rainbow of `ncolors` entries (vivid per house style). With `ncolors=1` every worm is one hue.
- **dpr / retina.** `size` (cell + step) is multiplied by `devicePixelRatio` so worms look the same on retina; `wormlength` is computed from **logical** dimensions (`(W+H)/dpr`) so a worm's apparent length is dpr-independent. Worm length therefore differs by a few segments from a raw device-pixel computation — documented, not a bug.
- **Initial seed.** worm.c stacks every segment at screen center, so all worms emerge from one point; we seed each worm at a **random on-screen point** (still a valid degenerate chain — all `wormlength` slots at that point) so multiple worms spread out from the first frame. They still unfurl over the first `wormlength` steps exactly as the original.
- **`count`/`size` sign convention kept.** xml ranges map 1:1 (`count` -100..100 default -20; `size` -20..20 default -3). A **negative** value means "pick a random amount up to its magnitude" (re-rolled each reinit); a positive value is exact — this is worm.c's `BATCHCOUNT`/`SIZE` behavior, preserved. The `count` slider is capped at 100 worms for perf (matches xml high).
- **Units.** `delay` in microseconds (xml; default 17000 ~= one frame, smooth). Frame-rate slider uses `invert` (drag right = faster) and the `µs` escape (no literal byte).

## Correctness self-review
The brief's worm-specific hazards, each checked:
- **Ring buffer stays exactly N.** A headless harness ran 12 worms x 200k steps: distinct-position count never exceeds `wormlength`, `tail` index always in `[0, wormlength)`. The off-by-one that would leave a permanent dotted trail (or eat the worm) does not occur — advancing `tail` then erasing-and-reusing that one slot keeps length constant.
- **Toroidal wrap on all 4 edges + matching erase.** Positions span the full `0..W-1` / `0..H-1`; thousands of edge-wrap jumps observed. Every stored buffer coordinate and every erase coordinate stayed in range (0 out-of-range over 2.4M head writes), because the erase reuses the same wrapped coordinate that was drawn — draw and erase always agree, so no leftover dot at a wrap.
- **No stall.** 100% of steps produced nonzero motion: `sin^2+cos^2=1` guarantees at least one axis rounds to >= 1 cell, so a worm never freezes in place.
- **Termination / reset.** There is no closure/termination state to mis-fire (worms crawl forever); `chromo` cycles `% nc` (no overflow); `reinit()` clears to black and re-seeds; `pause`/`resume` reset `lastTime` so resume doesn't burst. `step()` does bounded work (worms x 2 fillRects), and the rAF loop caps catch-up at `MAX_CATCHUP_STEPS`.

Minor faithful artifact: where a wiggling worm overlaps itself, the tail-erase can nibble a tiny black notch out of the body — this is present in the original X11 worm too (same overlapping-square geometry).
