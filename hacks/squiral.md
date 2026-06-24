# squiral — port notes

Port of `squiral.c` by Jeff Epler (1999) — agents ("worms") that trace right-angled, spiraling paths on a grid until it fills, then a sweep clears it and they restart. This was the first port and is the **style reference** for the rest of the gallery.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/squiral.c` (~334 lines)

## Algorithm
Each worm has a position, a heading, and a winding (handedness). Each step it tries to turn toward its winding direction, else go straight, else turn the other way; if all are blocked it respawns elsewhere. A worm may only move into clear cells (it checks two cells ahead), which is what forces the squared-off spiral. Worms cycle hue as they travel. Once coverage passes a threshold, a symmetric clear-sweep wipes the grid and it begins again.

## Shared skeleton (inherited by every port)
- A standalone ES module `hacks/<name>.js` (here `hacks/squiral.js`), **no build step** — exports `title` and `start(canvas) → { stop, reinit?, config?, params? }`, mounted onto one shared `<canvas>` by the host (`index.html` + `host.js`). Common config UI lives in `config-box.js` — see *Config box* below.
- A `config` object of tunable constants (declared inside `start()`).
- An rAF loop with a fixed-timestep **lag accumulator** instead of the C's `usleep(delay)` — identical pace at any refresh rate, with a catch-up cap so a backgrounded tab doesn't fire a burst of steps on refocus.
- `devicePixelRatio` folded into the cell `scale` and the backing store sized in device pixels, so rendering is crisp on retina while cells stay a consistent CSS size.
- `Uint8Array` grids; `wrap()`/`clamp()` helpers; descriptive names.

## Deviations from the C
- **Faithful port** — worm logic, color cycling, and clear-sweep all match the original; no algorithmic changes.
- **Descriptive names**: the C's `type`/`dir` became `winding`/`heading`; added a `DIRS` heading→`[dx,dy]` table.
- **`wrap()` uses floored (Euclidean) modulo** `((n % m) + m) % m`, because JS `%` takes the sign of the dividend — needed when a worm steps off the left/top edge.
- **One apparent off-by-one fixed**: the clear-sweep wipes the full row width; the C's erase was one cell short.

## Config
Units and defaults now mirror `hacks/config/squiral.xml` exactly, so the config box maps 1:1 to the original: `fill` (% filled before clearing, 75), `count` (worms; 0 = auto from width), `ncolors` (100), `delay` (µs/step, 10000), `disorder` (0.005), `handedness` (0.5), `cycle` (off), `scale` (1). The port originally used adapted units (fill as a 0–1 fraction, delay in ms); converting to xml units means the loop divides `delay` by 1000 and `init()` divides `fill` by 100.

## Config box (shared)
Tunable in-browser via `config-box.js`, a shared ES module the host imports. The "config" link (top-right) or the `c` key opens a panel of sliders/checkboxes; `esc`, `c`, or a click outside closes it. squiral declares an inline `params` array (one entry per tunable key, ranges/labels transcribed from the xml) and exposes `{ config, params, reinit }`; the host passes those to `renderConfig()`.
- **`live: true`** (`delay`, `disorder`, `handedness`): the loop reads `config` every step, so edits apply instantly.
- **`live: false`** (`count`, `scale`, `fill`, `ncolors`, `cycle`): the value sizes the grid/colors/worms, so a change re-runs `init()` via the hack's `reinit()` (which also clears the canvas). "Reset to defaults" applies every key, then reinits once.
- `delay` uses `invert: true` — the xml's `convert="invert"` "Frame rate" slider — rendered right-to-left (drag right = faster), showing the raw µs value.

**Local dev:** the ES-module `import`s make the page depend on real module fetches, so `file://` double-click doesn't work (CORS on the `null` origin). Serve it — `python3 -m http.server` in the repo, then open <http://localhost:8000/> (deep-link <http://localhost:8000/#squiral>). GitHub Pages serves over http, so production is unaffected.
