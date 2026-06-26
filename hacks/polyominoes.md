# polyominoes — port notes

Port of `polyominoes.c` (Stephen Montgomery-Smith, 2000; xlockmore/xscreensaver) — repeatedly tries to completely tile a rectangle with irregularly-shaped polyomino puzzle pieces, animating a genuine backtracking exact-cover search.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/polyominoes.c` (~2369 lines, most of it piece DATA). See [[squiral]] for the shared module skeleton and [[penrose]] for the sibling incremental tiler (forced growth there vs. exhaustive backtracking here).

## Algorithm
A real solver, ported faithfully. Each step (`solveOneStep`, = the C's `draw_polyominoes` body) makes **one net decision**:

1. `findBlank` picks the **most constrained** still-blank cell — among the cells of the *smallest* connected blank region (`findSmallestBlankComponent`), the one the fewest pieces can cover (`scorePoint`), with a corner-bias tie-break. A cell nothing can cover scores 0 and is picked first (fail fast → backtrack).
2. It then tries to `attach` a piece so one of its squares lands on that cell, iterating every `(piece, anchor square, transform)` via `nextAttachTry`. On success the step ends (one piece placed). On failure it `detach`es the most-recently-placed piece and keeps trying the next option from where that piece left off — classic depth-first backtracking.

Two pruning predicates (`checkOk`, run after every tentative placement) reject dead branches exactly as the C does: **every blank region's size** must be a multiple of the piece size (or a positive combination, for mixed tetromino+pentomino / pentomino+hexomino puzzles), and the **chessboard black/white balance** of the remaining blanks must stay coverable (`whitesOk`, using each piece's `max_white`). In **identical-piece** puzzles a third device — the `reason_to_not_attach` table — records which already-placed piece blocked an attach, so the backtrack jumps straight past pieces that cannot possibly help (the C's 2001 search improvement), ported verbatim including the bitwise-OR merge as pieces are detached.

When a placement fills the board (`nr_attached === nr_polyominoes`) it sets `wait = 100` (holds the finished tiling ~100 frames), then resumes backtracking to find the *next* solution. Every `cycles` frames a fresh random puzzle is seeded (`initPuzzle`). 14 puzzle families are ported: 5 non-identical (pentomino; one-sided pentomino; one-sided hexomino; pentomino+hexomino; tetromino+pentomino) and 9 identical (pentomino1, hexomino1, heptomino1[rot180], heptomino2, elevenomino1[rot180], dekomino1, octomino1, pentomino2, elevenomino2). The `rot180` puzzles place pieces in symmetric pairs (a piece and its 180° rotation at the opposite corner), also ported verbatim.

All piece tables (`tetromino`, `pentomino`, `hexomino`, the six single-shape templates, and the `make_one_sided_*` splitters) are copied square-for-square from the C, including each piece's `transform_list` and `max_white`.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — flat colored cells (deviation)
The board is repainted each active step: filled cells in their piece hue (vivid `hsl()` rainbow), blanks black, a thin dark separator on every edge between differing cells, and a pale board outline. This is essentially the C's **non-bitmap** path (`draw_without_bitmaps`: flat rectangles + boundary lines). The C's *default* path renders rounded, beveled, 3-D-looking "puzzle-piece" bitmaps (`create_bitmaps`, the `HALFBIT`/`THREEQUARTERSBIT`/bellybutton machinery, ~250 lines of per-pixel mask math) — that look is **approximated**, not reproduced; replicating it pixel-exact in canvas was deemed out of scope. The piece colours, layout, board sizing, portrait rotation, and margins all match the C.

Per the porter brief this is the SPARSE path (`fillRect` + vector lines), not a per-pixel blit. A full-board repaint (≤ ~2500 cells) each step is trivially cheap and avoids the delta-tracking the C needs (its `changed_array` is dropped — nothing else reads it).

## Deviations from the C
- **3-D bitmap tiles approximated by flat colored cells + outlines** (see above) — the only visible departure.
- **Recursive flood fill → explicit stack.** `count_adjacent_blanks` recurses in the C; on the big identical boards (e.g. 96×26 = 2496 cells) that is a 2000+-deep call chain. Ported as an iterative stack — identical result, no stack-overflow risk.
- **`changed_array` dropped**; we full-repaint instead of drawing only the delta. Visually identical (canvas persists; same content each frame).
- **Mono / `use3D` / `plain` paths dropped.** The C picks a b&w fallback when fewer than 12 colors and four 3-D shading styles; we always use the rainbow palette. `--identical` is exposed as a checkbox (the C's fullrandom mode randomizes it; we honor the toggle).
- **Units / tuning:** `delay` µs (xml default 10000 → calmer **50000**, so placements read as "watching it solve"). `cycles` (Duration) and `ncolors` (Colors) keep the xml ranges. Keypress / `fps` handling dropped — the host owns keys and the meter.
- **No XOR / feedback tricks** are involved, so nothing to emulate there.

## Config
Ranges mirror `hacks/config/polyominoes.xml`: `delay` (Frame rate, live, inverted), `cycles` (Duration, live), `ncolors` (Colors, reinit), `identical` (Identical pieces, reinit). Non-live changes and "Reset to defaults" re-run `initPuzzle()` via `reinit()` (fresh puzzle + cleared canvas); `r` (restart) also re-seeds.

## Correctness self-review
The SOLVER was the stated risk (stall / infinite loop / no restart). Verified four ways:

1. **No infinite loop, per call.** Each `solveOneStep` ends when `done` is set, which happens either by placing one piece or by detaching the whole stack down to empty (`nr_attached === 0 → done = 1`). Every `detach` strictly decreases `nr_attached` and `nrAttachTry` strictly advances the finite `(poly, point, transform)` index, so the loop is bounded — it cannot spin.
2. **Always visible progress; clean restart.** A headless harness drove **12,000 frames** across **both** puzzle families (non-identical, then `identical` flipped on via `reinit()`): **zero throws, zero hangs**, ~5.5 M cell draws, slowest single frame **5 ms** (per-frame work stays bounded even on the 96×26 / 60-distinct-piece boards). After `cycles` frames a brand-new random puzzle is seeded, so a hard board can never dead-end the screen — it keeps showing pieces placed/removed, then resets.
3. **It actually solves.** Forcing the solvable 10×6 and 12×5 pentomino puzzles, the board reached **100% filled** and entered the `wait`-hold (~5,300 no-draw hold-frames over 30,000 → ~50+ full solutions found, each held then backtracked for the next). The chessboard/region pruning and (identical-mode) `reason_to_not_attach` table were exercised without error.
4. **Hardest size doesn't freeze.** The 20×3 pentomino board (only 2 solutions) churns for thousands of steps without completing in a short run — expected — but never throws or stalls, and in the live hack `cycles` reseeds it long before that matters. Visible motion (placements/removals) the whole time.

**Spot-check in the browser:** confirm pieces visibly drop into the rectangle and the search backtracks (pieces removed and retried), that a finished tiling holds briefly before it hunts for another, that a new random puzzle (different shape set / aspect) appears after a while, and that toggling **Identical pieces** switches to the all-same-shape puzzles. The flat-colored-cell look (vs. the C's rounded 3-D tiles) is the intended rendering deviation.
