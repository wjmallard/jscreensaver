# squiral — port notes

Port of `squiral.c` by Jeff Epler (1999) — agents ("worms") that trace right-angled, spiraling paths on a grid until it fills, then a sweep clears it and they restart. This was the first port and is the **style reference** for the rest of the gallery.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/squiral.c` (~334 lines)

## Algorithm
Each worm has a position, a heading, and a winding (handedness). Each step it tries to turn toward its winding direction, else go straight, else turn the other way; if all are blocked it respawns elsewhere. A worm may only move into clear cells (it checks two cells ahead), which is what forces the squared-off spiral. Worms cycle hue as they travel. Once coverage passes a threshold, a symmetric clear-sweep wipes the grid and it begins again.

## Shared skeleton (inherited by every port)
- Single-file, inline `<script type="module">`, **no build step**.
- A `config` object of module-level constants.
- An rAF loop with a fixed-timestep **lag accumulator** instead of the C's `usleep(delay)` — identical pace at any refresh rate, with a catch-up cap so a backgrounded tab doesn't fire a burst of steps on refocus.
- `devicePixelRatio` folded into the cell `scale` and the backing store sized in device pixels, so rendering is crisp on retina while cells stay a consistent CSS size.
- `Uint8Array` grids; `wrap()`/`clamp()` helpers; descriptive names.

## Deviations from the C
- **Faithful port** — worm logic, color cycling, and clear-sweep all match the original; no algorithmic changes.
- **Descriptive names**: the C's `type`/`dir` became `winding`/`heading`; added a `DIRS` heading→`[dx,dy]` table.
- **`wrap()` uses floored (Euclidean) modulo** `((n % m) + m) % m`, because JS `%` takes the sign of the dividend — needed when a worm steps off the left/top edge.
- **One apparent off-by-one fixed**: the clear-sweep wipes the full row width; the C's erase was one cell short.

## Config
`fill` (coverage fraction before clearing), `count` (worms; 0 = auto from width), `ncolors`, `delay` (ms/step), `disorder`, `handedness`, `cycle`, `scale`.
