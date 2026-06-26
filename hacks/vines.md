# vines — port notes

Port of `vines.c` by Tracy Camp and David Hansen (1997) — "yet another geometric pattern generator", whose claim to fame is a pseudo-fractal vine-like pattern of nifty whorls and loops. Removed from XScreenSaver as of 5.08; lives on here.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/vines.c` (~189 lines)

See [[squiral]] for the shared module skeleton; technique twin of [[ccurve]] (recursion/vector lines, plus the "clear-and-reseed when full / budget reached" loop).

## Algorithm
Each frame draws one complete vine. A vine is a "turtle" launched from a random screen point that takes `length` (100..3099, times a retina factor) short steps. Per step it draws a segment, then turns by an **accelerating** amount: an integer angle accumulator `a += ang * i` (where `ang` is 60..779 and `i` is the step index), and the step vector is `i * cos(a) * 360 / 2pi` (and the `sin` for y). Because the turn grows with `i`, the path tightens into whorls and loops. Plot coordinates are accumulated in large integer units and divided down by a big `constant = length * (10..19)` to map onto a handful of screen pixels around the centre — so each vine is small and curvy.

Vines accumulate (the canvas is never cleared between them). A per-batch budget `iterations = 30 + NRAND(100)` (30..129) is decremented once per vine; when it hits 0 the screen clears and a fresh batch starts. Each vine is a single random colour from the `ncolors` pool (white if `ncolors <= 2`, the C's mono fallback).

## Faithful-to-the-C details (traced by hand, then checked numerically)
- **Integer math is preserved exactly.** All of `a, x1, y1, x2, y2, ang, length, constant` are 32-bit ints in the C. The screen mapping uses C integer division, kept as `Math.trunc(x / constant)`. The early segments collapse onto the centre until the accumulated coordinates outgrow `constant` — that dense centre dot is in the original too.
- **`a` is allowed to overflow.** `a += ang * i` grows to ~1e11 over a long vine, far past 2^31; the C's `int` wraps mod 2^32 and `cos`/`sin` read the wrapped value as radians, so the wraparound is part of the visual. Reproduced with `a = (a + ang * i) | 0`. (`ang * i` itself stays under 2^31, so only the accumulation wraps — verified.) `x2`/`y2` accumulation is likewise `| 0`-wrapped; the per-step increment is `(int)(...)` truncation = `Math.trunc`.
- **`pscale` (retina factor)** matches the C exactly off the device-pixel canvas size: `1`, `x3` if `> 1280`, `x6` if `> 2560`. It multiplies `length` (more, finer segments on big/retina displays), as in the C.
- **One whole vine per step** because the stock `count` resource is 0 (`vines.xml` doesn't expose it). The C's `count = i + MI_COUNT; if (count <= i || count > length) count = length;` is kept verbatim with `COUNT = 0`, so it always draws the full vine; the batchcount "grow gradually" path is dead with the default and left unexposed to match the xml UI.

## Deviations from the C
- **Rendering:** the C issues one `XDrawLine` per segment (up to ~18k/vine on retina). We batch a vine's segments into one `Path2D` and stroke it once in the vine's colour — visually identical (a connected polyline with round caps/joins), ~1 stroke per frame instead of thousands of draw calls.
- **Line width:** the C's `XSetLineAttributes` (round cap/join, width = `pscale`) is **commented out**, so the original draws 1px lines. We keep ~1 **CSS** px, scaled by `devicePixelRatio` so lines read on retina (the [[ccurve]] convention); `pscale` here only affects vine length, as in the C.
- **Color:** the C pulls a random index from the X colormap; we build a vivid HSL rainbow of `ncolors` and pick a random entry per vine (white when `ncolors <= 2`, matching the mono fallback).
- **Loop/units:** rAF lag-accumulator instead of `usleep(delay)`; `delay` kept in xml microseconds (200000 default ~= 5 vines/sec) and divided to ms in the loop. No XOR / feedback tricks are involved, so no raster-op workarounds.

## Config
Mirrors `hacks/config/vines.xml` 1:1 — the xml exposes only two tunables:
- `delay` — "Frame rate" slider, microseconds, `invert: true` (drag right = faster, raw value shown), `live`. One whole vine is drawn per step.
- `ncolors` — size of the random colour pool, `live: false` (resizes the palette, so a change re-runs `init()` via `reinit()`, which also clears).

(`--fps`/`showfps` is host-level and not ported as a tunable.)

## Correctness self-review
The brief's headline risk for this hack — *make sure the clear/reseed actually fires so it doesn't stall after the first fill* — is the reset on `iterations`. Traced by hand and confirmed with a headless harness (`scratchpad/harness.mjs`): across 1366x768 / 2880x1800 / 3840x2160 the budget reliably reaches 0 after `startIter - 1` vines (66, 128, 98) and would clear+restart; over ~340k–1.26M segments there were **0 non-finite points**, every vine drew a non-degenerate path, and the `a` int32 wraparound was exercised every batch (so the geometry matches the C, overflow included). The first frame draws a full vine (initial `i == length == 0` enters the seed branch immediately). `pause`→`resume` resets `lastTime` so there's no catch-up burst; `reinit` clears and re-seeds; the catch-up cap (8 steps) bounds a backgrounded tab. The only divide is by `constant = length * (10..19)`, always >= 1000, so no divide-by-zero.
