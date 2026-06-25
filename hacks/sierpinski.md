# sierpinski — port notes

Port of `sierpinski.c` by Desmond Daignault (1996). The chaos-game Sierpinski triangle.

Original: <https://www.jwz.org/xscreensaver/> · source: `sierpinski.c` (~214 lines)

## Algorithm
The **chaos game**: place N random vertices (3 = triangle, 4 = square), start at a random point, then repeatedly pick a random vertex and jump **halfway** toward it, plotting where you land. Each dot is coloured by the vertex it jumped to. With 3 vertices the Sierpinski triangle emerges from the noise; 4 fills the square in interleaved colour regions. Points **accumulate** across frames; after `cycles` frames the dish clears and restarts with fresh vertices/colours. (Early dots land "wrong" then focus — intended.)

## Module shape
`start(canvas) -> { stop, reinit, config, params }` — see `squiral.md`.

## Rendering
**Blit** (point plotting): accumulate dots into a canvas-sized `Uint32` buffer and `putImageData` once per frame — per the perf playbook, points → blit, not per-dot `fillRect`. Dots are `round(dpr)` px so they stay visible on retina; the buffer persists (the fractal builds), `startover` wipes it.

## Deviations from the C
- **Colours**: vivid spread hues (one per vertex), not the X colormap; inline `hslToUint`.
- **Units**: `delay` in ms; default 100 (orig 400) — halved from 50 for calmer cycling (~`cycles × delay` ≈ 15 s per triangle).
- **Shape**: the default **Random** rolls a fresh 3-or-4 each round, matching the stock hack — whose `--size` is unset, so it falls back to `(LRAND() & 1) + 3`. **Triangle** (3) is the classic fractal; **Square** (4) is the original's "4 corners", the same midpoint game with a fourth vertex (it fills a quad rather than a fractal). Vertices are inset from the edge with a minimum pairwise spread so the set isn't a degenerate sliver.
- The 3D variant and the original's exact colour-spacing aren't reproduced.

## Config
`delay` (Frame rate, live) · `corners` (Shape: Triangle / Square / Random — reinit) · `count` (Points/frame, live) · `cycles` (Density, live).
