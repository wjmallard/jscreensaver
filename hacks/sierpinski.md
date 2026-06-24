# sierpinski — port notes

Port of `sierpinski.c` by Desmond Daignault (1996), jwz-compatible since 1997.
The chaos-game Sierpinski triangle.

Original: <https://www.jwz.org/xscreensaver/> · source: `sierpinski.c` (~214 lines) ·
xml: `config/sierpinski.xml` · demo video: <https://www.youtube.com/watch?v=m0zdPWuFhjA>

## Algorithm (transcribed from the .c)
The **chaos game**: place N vertices **fully at random** across the window
(`NRAND(width)`/`NRAND(height)`), start at a random point, then for each of
`count` points per frame: pick a random vertex `v = NRAND(corners)`, jump
**halfway** toward it (`px = (px + vertex[v].x) / 2`, integer; same for `y`), and
plot the landing point coloured by `v`. 3 vertices draw the Sierpinski gasket; 4
("the 4 corners") turn the same midpoint game into a fuzzy quad with no fractal
structure. Points **accumulate** across frames; after `cycles` frames
`startover()` runs `MI_CLEARWINDOW` and begins a fresh round with new vertices
and colours. (Early dots land "wrong" then "focus" — the .c calls this correct.)

`corners` is resolved **once** at init (`init_sierpinski`): if `--size` is 3 or 4
it is used, otherwise it falls back to `(LRAND() & 1) + 3` — a single random
3-or-4 that does **not** change between rounds.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `thornbird.md`.

## Rendering
**Blit** (point plotting): accumulate dots into a canvas-sized `Uint32` buffer and
`putImageData` once per frame — per the perf playbook, points → blit, not per-dot
`fillRect`. The reset frame's clear lands in that same single blit, so the window
goes black at reset, matching the .c's `MI_CLEARWINDOW`. Dots are `round(dpr)`
device px so a point stays ~1 CSS px on retina; the buffer persists (the fractal
builds), `startover` wipes it.

## Palette (faithful — fixed in the audit)
The .c defines `BRIGHT_COLORS`, so the xlockmore framework
(`hacks/xlockmore.c:490`) builds an `ncolors`-entry (default **64**)
`make_random_colormap` in its **bright** variant — random hue, saturation
30–100%, value 66–100% — **not** a smooth rainbow. Each round picks 3 or 4 colour
**indices** spaced around that map with the exact `NRAND` offsets from
`sierpinski.c` startover() (3-corner: `+np/7`, `+4np/7`, with `NRAND(2np/7+1)`
jitter; 4-corner: `+np/7`, `+3np/7`, `+5np/7`, with `NRAND(np/7+1)` jitter). The
colormap is built **once per run** (`buildPalette` in `init`); only the indices
are re-picked each round. `MI_NPIXELS <= 2` (i.e. `ncolors` 1–2) falls back to
white, the .c's mono path. Built via `colormap.js` `makeRandomColormapRGB(n, true)`.

> Prior bug (now fixed): the port replaced the whole bright-colormap-index scheme
> with a vivid `hslToUint(h, 1, 0.55)` HSL rainbow spread — the systemic
> flatten-the-palette deviation this audit targets.

## Config (mirrors `sierpinski.xml`)
- `delay` — "Frame rate", `µs`/frame, inverted, **400000** (0–1000000). Live.
- `count` — "Points", points/frame, **2000** (10–10000). Live.
- `cycles` — "Timeout", frames before clear, **100** (0–1000). Live.
- `ncolors` — "Number of colors", colormap size, **64** (1–255). Reinit (rebuilds
  the colormap).
- `corners` — **"Shape"** (Random / Triangle / Square). Reinit. NOT an xml GUI
  slider: it maps to the stock **`--size`** resource the .c reads via `MI_SIZE`
  (a real, command-line-only resource). Default **Random** reproduces the stock
  `size`-unset fallback (a single 3-or-4 chosen at init). Kept because `--size` is
  a genuine resource, not an invented control.

## Deviations from the C (real, minimal)
- **delay default** = stock **400000 µs** (~2.5 fps) — slower than the previous
  port's 100 ms. It is a pace knob, not a fidelity item; the slider maps 1:1 to
  the xml `delay`. No frame-rate overhead fudge is applied (at 400 ms the
  framework's ~30 ms overhead is immaterial).
- **Shape selector** surfaces `--size`, which the xml GUI omits (see Config).
- **dot size** = `round(dpr)` device px (the .c draws single X pixels) so a point
  stays ~1 CSS px on retina.
- The 3D variant ("Sierpinski3D") is a separate hack and is not reproduced here.

## Previously-claimed deviations that were actually bugs (fixed)
- Vertices were inset by a margin and rejected by a minimum-pairwise-distance
  retry. The .c scatters vertices **fully at random** — fixed to match.
- `corners` (Random) was **re-rolled every round**. The .c fixes it **once** at
  init — fixed to resolve at init only.
- `ncolors` was absent. Added (mirrors the xml) and now drives the colormap size.
