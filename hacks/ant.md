# ant — port notes

Port of `ant.c` by David Bagley (1995), after Chris Langton's ant / Greg Turk's "turmites".

Original: <https://www.jwz.org/xscreensaver/> · source: `ant.c` (~1350 lines, most of it grid variants)

## Algorithm
A turmite crawls a toroidal grid that doubles as its tape. Each generation it reads the cell's colour, looks up `machine[color + state*ncolors]` → (write a colour, turn by a relative move, change state), paints the cell, and steps to a neighbour. The rule is a random **Turk's number** (`ncolors` colours cycling, each turning L or R per a bit of the number) or one of three preset **tables** (ladder, spiral, square builder). Colour trails persist; the ant head is white; the dish resets every `cycles` generations. Several ants can share one tape.

## Module shape
`start(canvas) -> { stop, reinit, config, params }` — see `squiral.md`.

## Deviations from the C
- **Square grid (4 neighbours) only — the iconic case.** The original's hexagon (6) and triangle (3/12) grids, **Truchet** lines, **eyes**, and **sharp-turns** are *not* ported — they are the bulk of the 1350 lines. (Like demon leaving its denser grids for later.)
- Faithful turmite core: `fromTableDirection` and the turn math (`chgDir = (2·ANGLES − dir) % ANGLES`, plus the step-first vs turn-first distinction) replicate the C exactly.
- **Colours**: rainbow palette for cell values `1..ncolors-1` (0 = black), ant = white. `ncolors` (2–8) comes from the random rule. A 1 px gridline gap is kept (`xs - (xs>3)`).
- **Units**: `delay` in ms.

## Config
`delay` (Frame rate, live) · `size`, `count` (reinit — cell size, ant count) · `cycles` (lifespan, live). The rule (hence `ncolors`) is randomised on every (re)build, so `reinit` / restart gives a fresh turmite.
