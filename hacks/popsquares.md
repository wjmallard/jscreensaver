# popsquares

A pop-art-ish grid of pulsing colours, inspired by cheesy MTV commercials.

Port of xscreensaver's `popsquares.c` by **Levi Burton, 2003** (309 lines).
Source verbatim in [popsquares.c](popsquares.c); config in [popsquares.xml](popsquares.xml).
Follows the grid skeleton of `See [[squiral]]` and `See [[greynetic]]`.

## The algorithm

The screen is tiled with a grid of `gw x gh` squares, each `sw x sh` device pixels.
The grid fineness comes from `subdivision` (the screen is split into roughly that many
cells per axis; `reshape` clamps it for tiny canvases and stretches it for extreme
aspect ratios). Every square holds an index into a shared **closed colour ramp**:

- The ramp is built like the C's `make_color_ramp(..., closed_p=True)`: the first
  `half = floor(ncolors/2) + 1` entries interpolate HSV linearly from the **fg** (dark)
  endpoint up to the **bg** (light) endpoint, then the second half is *mirrored* back
  (`colors[i] = colors[ncolors - i]`). The result is a seamless `fg -> bg -> fg` loop.
- Each frame, `step()` draws every square at its current ramp colour with a `fillRect`,
  then advances that square's index by one. When a square's index runs off the end of
  the ramp it re-rolls to a fresh random index. With **twitch** on, a 1-in-4 wrap instead
  re-randomises the *entire* grid at once (a glitchy strobe).
- `border` shaves `border` px off each drawn square (`s.w - border`), so the black
  background shows through as a thin grid of gutters between squares.

Because the ramp is a closed loop, "advance the index, wrap at the end" produces a gentle
dark->light->dark pulse with no colour jump; the per-square random phase (seeded by
`randomize_square_colors`) keeps the field from beating in lockstep.

## Palette

The stock hack picks the ramp's two endpoints via `--fg`/`--bg` (the XML offers six
dark/light colour pairs; default is dark-blue -> light-blue). That maps to a single
**Palette** select here: the six XML pairs (`blue` default, `red`, `yellow`, `green`,
`cyan`, `magenta`) reproduce the C's value-pulse look, plus an extra **rainbow** option
(a full-spectrum hue sweep, closed-looped) that the porter brief invites. `rgb_to_hsv` /
`hsv_to_rgb` are reimplemented inline so the ramp endpoints land exactly where the C puts
them; the default-blue ramp verifies as `[0] = rgb(0,0,139)` (= #00008B) peaking near
`rgb(0,0,255)` (= #0000FF).

## Deviations from the C

- **No double-buffer / DBE / GXxor tricks.** The C optionally renders into an X Pixmap
  and `XCopyArea`s it (or uses the DBE back-buffer). Canvas double-buffers for us, so we
  draw straight to the one shared canvas every frame. There is no XOR or canvas-feedback
  raster op in this hack, so nothing needed emulating.
- **fg/bg endpoint colours -> a `palette` select** (see above). Behaviourally identical
  to choosing `--fg`/`--bg`; the only addition is the bonus `rainbow` option.
- **Default `delay` 33000 us** instead of the stock 25000, so the pulse reads as a calmer
  breathe (per the brief's "a touch calmer than stock is fine"). The slider still spans
  0..100000 us and is `invert`ed (drag right = faster) like the XML.
- **`twitch` is live.** In the C it is read once at init; here toggling it applies on the
  next wrap without a reinit (it changes only branch behaviour, not buffer sizes). `border`
  is also live (it only changes the drawn rect, not the grid). `subdivision`, `ncolors`,
  and `palette` size the grid / ramp, so they re-run `init()` via `reinit()`.
- **`showfps` / transparent / `--root`** options are dropped (host-level concerns, not the
  hack's algorithm).

## Correctness self-review

Traced the ramp + wrap by hand and with a standalone numeric harness:

- **No undefined colour access.** The closed-loop mirror `colors[i] = colors[n - i]`
  reads only already-filled indices (`i` runs `half..n-1`, so `n - i` runs `1..half-1`,
  all written in the first loop). Verified 0 undefined entries for `ncolors` = 2 (minimum,
  where the mirror loop body is empty), 12, and 128. The mirror seam is exact
  (`colors[65] === colors[63]`, `colors[127] === colors[1]`), so the pulse never jumps.
- **No over-draw / runaway loop.** `step()` is a bounded double `for` over `gw*gh`
  squares; it never recurses. Each square's index strictly increments and is re-rolled
  the instant it reaches `ncolors`, so an index can never index past the ramp. The twitch
  re-roll path `return`s out of the frame after re-randomising (the rest of that frame is
  drawn on the next tick) — it cannot loop.
- **No freeze.** The rAF lag-accumulator is the standard one from squiral/greynetic, with
  `MAX_CATCHUP_STEPS = 8` and a `lag` cap, so a backgrounded tab can't burst on refocus and
  `delay = 0` (max rate) is bounded by the step counter, not by `lag` dropping below zero.
- **Clean first frame.** `layout()` seeds every square with a random ramp index before the
  first draw (`randomize_square_colors`), so frame 1 is already a varied grid, not a flat
  fill. `pause()`/`resume()` reset `lastTime = 0` to avoid a catch-up jump; `reinit()`
  clears to black and rebuilds ramp + grid for a clean restart after a non-live change.
- **Degenerate sizes guarded.** `nsquares < 1` is forced to a 1x1 grid (matching the C's
  `if (st->nsquares < 1) st->nsquares = 1`), and `sw`/`sh` of 0 yield `gw`/`gh` of 0 which
  the same guard catches, so no divide-by-zero or empty-array indexing.
