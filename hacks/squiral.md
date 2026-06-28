# squiral — port notes

Port of `squiral.c` by Jeff Epler (1999) — agents ("worms") that trace right-angled, spiraling paths on a grid until it fills, then a sweep clears it and they restart. This was the first port and is the **style reference** for the rest of the gallery.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/squiral.c` (~334 lines)

## Algorithm
Each worm has a position, a heading, and a winding (handedness). Each step it tries to turn toward its winding direction, else go straight, else turn the other way; if all are blocked it respawns elsewhere. A worm may only move into clear cells (it checks two cells ahead), which is what forces the squared-off spiral. Worms shift hue as they travel **when `cycle` is on** (off by default). Once coverage passes a threshold, a symmetric clear-sweep wipes the grid and it begins again.

## Shared skeleton (inherited by every port)
- A standalone ES module `hacks/<name>.js` (here `hacks/squiral.js`), **no build step** — exports `title` and `start(canvas) → { stop, reinit?, config?, params? }`, mounted onto one shared `<canvas>` by the host (`index.html` + `host.js`). Common config UI lives in `config-box.js` — see *Config box* below.
- A `config` object of tunable constants (declared inside `start()`).
- An rAF loop with a fixed-timestep **lag accumulator** instead of the C's `usleep(delay)` — identical pace at any refresh rate, with a catch-up cap so a backgrounded tab doesn't fire a burst of steps on refocus. The loop adds a calibration offset `OVERHEAD = 15000 µs` to the delay (it does **not** alter the accumulator itself): the live binary measures **40.4 fps** via the `-fps` overlay (Load 60% = delay-bound), but the port at the stock `delay = 10000 µs` ran ~100 steps/sec (2.5× fast); `10000 + 15000 = 25000 µs → ~40 steps/sec`, matching the live binary (density verified side-by-side). See the framerate-calibration note.
- The backing store is sized in device pixels. **squiral does not fold `devicePixelRatio` into `scale`** (most ports do); it copies the C's own crude Retina rule instead — `scale = --scale`, tripled if the drawable is `> 2560px` in either dimension. See *Deviations*.
- `Uint8Array` grids; `wrap()`/`clamp()` helpers; descriptive names.

## Deviations from the C — fidelity audit 2026-06-28 (Batch 1C)
The worm engine was already a faithful step-for-step port. The audit fixed four
look-affecting deviations (the earlier "faithful, no changes" claim was wrong about
the palette and the Retina scaling):

- **Palette = `make_uniform_colormap`** (was a vivid full-saturation rainbow). The C
  builds its colourmap with `make_uniform_colormap` (utils/colors.c): a uniform hue
  ramp 0→359 at a **constant saturation and value chosen once per run in 66%–100%**
  — `make_color_ramp(0,S,V, 359,S,V, ncolors, closed=False)`. Most runs are therefore
  somewhat muted; only a rare run lands near full saturation. The earlier port
  hard-coded `hsl(h,100%,50%)` — always the fully-vivid extreme, with no per-run
  variation (a Rule-1 violation). Now built via `makeColorRampRGB(0,S,V,359,S,V,
  ncolors,false)` (`colormap.js`), once per `init()` and held for the session.
- **Retina scale matches the C** (was `scale × devicePixelRatio`). squiral.c sets
  `scale = --scale`, then `*= 3` only if the drawable is `> 2560px` in either
  dimension. The port now applies that exact rule to the device-pixel `canvas.width/
  height` instead of folding in `devicePixelRatio`, so grid resolution and the auto
  worm count (`width/32`) track the original on high-DPI displays.
- **Initial edge-sweep restored**: the C calloc's `inclear = 0`, so the first frames
  run the edge-in clear-sweep over the (black) screen, suppressing worms near the
  edges until it meets in the middle. The port had `inclear = height`, skipping that
  startup; now `inclear = 0`.
- **Clear-sweep width reverted to the C's**: squiral.c erases a strip `(width-1)*scale`
  wide from `x=0`, leaving the **last column un-swept** while its `fill[]` memset
  clears the whole row. The earlier port treated this as an off-by-one and "fixed" it
  to full width — *that* was the deviation. Reverted to match: screen rect one cell
  short, grid clear full-width.

## Faithful as-was (verified against squiral.c)
- Worm turning rule, the `disorder`/`handedness` probabilities, the two-cells-ahead
  occupancy check, the `RANDOM` respawn, the per-step colour advance, and the
  coverage-triggered symmetric clear-sweep all transcribe the C step-for-step.
- **`colorStep` is `R(3)`, not the C's `R(3)+ncolors`** — modularly identical, since
  `(c + ncolors + k) % ncolors == (c + k) % ncolors`, *including* the quirk that ~1/3
  of cycling worms (k==0) never actually shift hue.
- **Descriptive names**: the C's `type`/`dir` are `winding`/`heading`; added a `DIRS`
  heading→`[dx,dy]` table. The C encodes left/up as `width-1`/`height-1`, which is
  `-1` under its positive modulo — the `DIRS` `-1` plus floored `wrap()` is equivalent.
- **`wrap()` uses floored (Euclidean) modulo** `((n % m) + m) % m`, because JS `%`
  takes the sign of the dividend — needed when a worm steps off the left/top edge.

## Note: `cycle` is exposed but not in the GUI xml
`squiral.xml` does **not** list `cycle`. It is a real command-line resource of the
original (`-cycle`/`-no-cycle`, default `False`) that the C reads and acts on, so the
port surfaces it as a checkbox (default off, matching the C) rather than dropping a
working feature. Every other control mirrors the xml 1:1.

## Config
Units, defaults, ranges, and labels mirror `hacks/config/squiral.xml`: `fill` (% filled before clearing, 75), `count` (worms; 0 = auto from width), `ncolors` (100), `delay` (µs/step, 10000), `disorder` (0.005), `handedness` (0.5, 0 = left / 1 = right), `scale` (1). The lone extra is `cycle` (off) — a real `-cycle` command-line resource the xml GUI omits (see the note above). The port originally used adapted units (fill as a 0–1 fraction, delay in ms); converting to xml units means the loop divides `delay` by 1000 and `init()` divides `fill` by 100. The palette is `make_uniform_colormap` (a per-run muted-to-vivid hue ramp), not a fixed rainbow — see *Deviations*.

## Config box (shared)
Tunable in-browser via `config-box.js`, a shared ES module the host imports. The "config" link (top-right) or the `c` key opens a panel of sliders/checkboxes; `esc`, `c`, or a click outside closes it. squiral declares an inline `params` array (one entry per tunable key, ranges/labels transcribed from the xml) and exposes `{ config, params, reinit }`; the host passes those to `renderConfig()`.
- **`live: true`** (`delay`, `disorder`, `handedness`): the loop reads `config` every step, so edits apply instantly.
- **`live: false`** (`count`, `scale`, `fill`, `ncolors`, `cycle`): the value sizes the grid/colors/worms, so a change re-runs `init()` via the hack's `reinit()` (which also clears the canvas). "Reset to defaults" applies every key, then reinits once.
- `delay` uses `invert: true` — the xml's `convert="invert"` "Frame rate" slider — rendered right-to-left (drag right = faster), showing the raw µs value.

**Local dev:** the ES-module `import`s make the page depend on real module fetches, so `file://` double-click doesn't work (CORS on the `null` origin). Serve it — `python3 -m http.server` in the repo, then open <http://localhost:8000/> (deep-link <http://localhost:8000/#squiral>). GitHub Pages serves over http, so production is unaffected.
