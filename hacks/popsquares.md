# popsquares

A pop-art-ish grid of pulsing colours, inspired by cheesy MTV commercials.

Port of xscreensaver's `popsquares.c` by **Levi Burton, 2003** (309 lines).
Source verbatim in [popsquares.c](popsquares.c); config in [popsquares.xml](popsquares.xml).
Follows the grid skeleton of [[squiral]] and [[greynetic]].

## The algorithm

The screen is tiled with a grid of `gw x gh` squares, each `sw x sh` device pixels.
The grid fineness comes from `subdivision` (the screen is split into roughly that many
cells per axis; `reshape` clamps it for tiny canvases and stretches it for extreme
aspect ratios). Every square holds an index into a shared **closed colour ramp**:

- The ramp is built ONCE at init via the shared `makeColorRampRGB` (a faithful port of
  `make_color_ramp`, utils/colors.c) with `closedP = true`. It takes the **fg** (dark)
  endpoint as `h1,s1,v1` and the **bg** (light) endpoint as `h2,s2,v2` (via `rgb_to_hsv`),
  fills the first `half = floor(ncolors/2) + 1` entries by linearly interpolating HSV
  (deltas divided by `half`, hue cast to `int`, channels 16-bit-quantized then downsampled
  `floor(c*256)` like the X server), then *mirrors* the back half
  (`colors[i] = colors[ncolors - i]`). The result is a seamless `fg -> bg -> fg` loop.
- Each frame, `step()` draws every square at its current ramp colour with a `fillRect`,
  then advances that square's index by one. When a square's index reaches `ncolors` it
  re-rolls to a fresh random index. With **twitch** on, a 1-in-4 wrap instead
  re-randomises the *entire* grid **mid-frame** (so the squares not yet drawn this frame
  already paint at their new colours, exactly as the C does — see Deviations).
- `border` shaves `border` px off each drawn square (`s.w - border`), so the black
  background shows through as a thin grid of gutters between squares.

Because the ramp is a closed loop, "advance the index, wrap at the end" produces a gentle
dark->light->dark pulse with no colour jump; the per-square random phase (seeded by
`randomize_square_colors`) keeps the field from beating in lockstep. At the default
`ncolors = 128` a full pulse is 128 frames.

## Motion & cadence (faithful)

The C builds the ramp **once** in `popsquares_init` and never rebuilds, regenerates, or
cycles it — the ramp is deterministic from the fixed fg/bg resources (not a random
`make_smooth_colormap`). The only motion is each square advancing its own static index by
+1 every `popsquares_draw` call (interval `delay`), re-rolling on wrap. The port matches:
a continuous per-frame redraw, no ramp regeneration, no colourmap cycling. Nothing is
painted-and-held or frozen — it is genuinely a continuously animated hack.

## Palette (faithful)

The stock hack picks the ramp's two endpoints from the `--fg`/`--bg` X resources. The XML
exposes these as **two independent selects** — `bg` (six *light* colours) and `fg` (six
*dark* colours), both defaulting to blue — and the port mirrors them verbatim as two
`select` params with the XML's own option labels (Light/Dark red…magenta). The ramp's base
is the dark `fg` (`ramp[0]`), its peak the light `bg` (`ramp[floor(ncolors/2)]`).

Verified through `colormap.js` for the default blue pair: `ramp[0] = rgb(0,0,139)` (=#00008B),
peak `ramp[64] = rgb(0,0,254)`. The peak is `254` not a pure `255` because the last filled
index sits one delta short of the endpoint — this matches `make_color_ramp` exactly (the C
divides the deltas by `half` but only fills indices `0..half-1`). `make_color_ramp` does
**not** reduce `*ncolorsP` in the read-only/TrueColor allocation path, so the draw loop
correctly wraps at the full `ncolors` and traverses the whole closed loop.

## Deviations from the C

- **fg/bg X resources -> two `select` params.** Behaviourally identical to choosing
  `--fg`/`--bg`; the porter exposes the same six dark + six light colours the .xml lists,
  in the same order. (A previous version collapsed these into a single 6-pair "palette"
  select **plus an invented full-spectrum "rainbow" ramp**; the rainbow was a fabricated
  vivid ramp the C never produces and has been removed, and the two real selects restored.)
- **No double-buffer / DBE tricks.** The C optionally renders into an X Pixmap and
  `XCopyArea`s it (or uses the DBE back-buffer). Canvas double-buffers for us, so we draw
  straight to the one shared canvas every frame. There is no XOR / canvas-feedback raster
  op in this hack, so nothing needed emulating.
- **Default `delay` 25000 us** — the stock value (the slider maps 1:1 to the xml resource,
  spanning 0..100000 us, `invert`ed so drag right = faster). The rAF loop adds a measured
  `OVERHEAD = 6847 us` so `(delay + OVERHEAD)` reproduces the live binary's effective rate:
  measured against the live `-fps` overlay popsquares runs **31.4 fps**, while the port at the
  stock delay ran ~40 fps (1.3x fast); `25000 + 6847 = 31847 us -> 31 fps`, matching the live
  binary. A calibration, not a tuning knob (see the project's framerate-calibration notes).
- **`ncolors` slider min is 2** (the XML `low` is 1). The C forces `ncolors >= 1` then
  `exit(1)`s with "insufficient colors" if `make_color_ramp` yields fewer than 2, so 1 is a
  degenerate value the real hack refuses; clamping the floor to 2 avoids that crash while
  staying within the XML's intent.
- **`twitch` and `border` are live.** In the C both are read once at init; here toggling
  them applies without a reinit (they change only branch behaviour / the drawn rect, not
  buffer sizes). `subdivision`, `ncolors`, `bg`, and `fg` size the grid / ramp, so they
  re-run `init()` via `reinit()`.
- **`showfps` / transparent / `--root`** options are dropped (host-level concerns, not the
  hack's algorithm).

## Fixes applied in the 1B audit

- **Ramp now built via the shared faithful `makeColorRampRGB`** instead of an inline HSV
  ramp. The inline version did **not** truncate hue to `int` (the C does, `hsv_to_rgb
  ((int)(h1 + i*dh), …)`) and rounded channels with `round(c*255)` rather than the X
  server's `floor(c*256)`. Both are now correct via colormap.js. (For the six pure
  endpoint pairs the hue truncation is a no-op — they all land on integer hues — but the
  channel downsample now matches the C.)
- **Twitch re-roll is now mid-frame, matching `popsquares_draw`.** The old port called
  `randomize_square_colors` and then `return`ed out of the frame, so the whole grid
  flashed to new colours on the *next* frame uniformly. The C continues the draw loop after
  re-randomising, so squares after the twitch point in *this* frame already paint their new
  colours (and a later square can twitch again). The port now mutates `squares[]` in place
  and continues the loop, reproducing this exactly. (Off by default; only visible with
  `--twitch`.)
- **Weird-aspect subdivision now truncates** (`Math.trunc(s*r)` / `Math.trunc(s/r)`) to
  match the C's assignment to the `int` `subdivisionx`/`subdivisiony` (was `Math.round`).
  Only affects >5:1 aspect ratios.

## Correctness self-review

- **No undefined / out-of-range colour access.** The closed-loop mirror lives in
  colormap.js (`colors[i] = colors[total - i]` for `i` in `[half, total)`, reading only
  already-filled low indices); verified 0 undefined / non-finite entries for `ncolors` = 2
  (minimum, mirror loop empty), 64, and 128, with seamless mirror seams
  (`ramp[127] === ramp[1]`, `ramp[65] === ramp[63]`). A square's index strictly increments
  and is re-rolled the instant it equals `ncolors`, so it can never index past the ramp.
- **No over-draw / runaway loop.** `step()` is a bounded double `for` over `gw*gh` squares;
  no recursion. The twitch path re-randomises in place and continues the loop (no early
  return) — a faithful, terminating transcription of the C.
- **No freeze.** The rAF lag-accumulator is the standard squiral/greynetic one, with
  `MAX_CATCHUP_STEPS = 8` and a `lag` cap so a backgrounded tab can't burst on refocus and
  `delay = 0` (max rate) is bounded by the step counter.
- **Clean first frame.** `layout()` seeds every square with a random ramp index before the
  first draw, so frame 1 is already a varied grid. `pause()`/`resume()` reset
  `lastTime = 0`; `reinit()` clears to black and rebuilds ramp + grid after a non-live
  change (the ramp is deterministic, so a rebuild reproduces the identical ramp — matching
  the C, which keeps its single ramp across a reshape).
- **Degenerate sizes guarded.** `nsquares < 1` is forced to a 1x1 grid (matching the C's
  `if (st->nsquares < 1) st->nsquares = 1`), and `sw`/`sh` of 0 yield `gw`/`gh` of 0 which
  the same guard catches, so no divide-by-zero or empty-array indexing.
