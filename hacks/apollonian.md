# apollonian — port notes

Port of `apollonian.c` (Allan R. Wilks, 2000-2001; xscreensaver port by David Bagley, 2001) — an **Apollonian gasket**: four mutually-tangent circles recursively packed with ever-smaller tangent circles, demonstrating Descartes' Circle Theorem. Circles are coloured by curvature.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/apollonian.c` (~820 lines). Demo video: <https://www.youtube.com/watch?v=aeWnjSROR8U>.

## Algorithm (faithful)
Each circle is a `(bend, bend*x, bend*y)` triple, where **bend = curvature = 1/radius** and the real centre is `(x/bend, y/bend)`. The gasket starts from a "game": a seed quadruple of four mutually-tangent circles. Two sources of seeds, exactly as the C:
- a tiny table of hand-picked **examples** (one all-integer "double semi-bounded" pair-of-lines case, plus three irrational 3-fold/semi/un-bounded cases using the constants `DELTA`, `ALPHA`, `BETA`), and
- **generated integer Descartes quadruples** from `dquad()` — an exhaustive search (bounded by `MAXBEND = 100`) for root quadruples `(a,b,c,d)` with `a <= 0` satisfying the Descartes condition; ported verbatim along with its `gcd` and integer-`isqrt` helpers. (The first few it finds — `(-1,2,2,3)`, `(-2,3,6,7)`, `(-3,4,12,13)`, … — match the C's own comment table.)

`game = NRAND(PREDEF_CIRCLE_GAMES + count)` with `count = 64`, so ~94% of gaskets are generated integer quadruples and ~6% are the four predefined examples. For every game except game 0, the four seed centres are recomputed from the bends via the C's `q123 = sqrt(e1·e2 + e1·e3 + e2·e3)` construction (the only square root in the whole hack). Then the packing is grown by **Descartes recursion** (`f()`): given four mutually-tangent circles, the new circle tangent to the first three (opposite the fourth) has `bend' = 2*(bend1+bend2+bend3) - bend4`, and the `bend*x`, `bend*y` coords obey the **same linear recurrence** — so after the seed there are no square roots, and integer games stay exactly integer. `f()` emits the new circle and recurses three ways. Recursion stops when the new circle vanishes (`bend == 0`), shrinks below a pixel (`bend > size*outerE`), or wanders off-screen (`|centre coord| > BIG = 7`) — exactly the C's bail conditions. Pixel mapping is a faithful port of the C's `p()`.

## Timing / motion (faithful — was wrong before this audit)
`draw_apollonian` is a 5-chunk reveal driven by a frame counter `time`, replicated exactly:
- **frame 0** draws the four seed circles (`p(c1..c4)`),
- **frames 1-4** each draw one recursive fan (`f(c1,c2,c3,c4)`, `f(c1,c2,c4,c3)`, `f(c1,c3,c4,c2)`, `f(c2,c3,c4,c1)`) — each fan is an entire sub-packing of up to a few thousand circles, drawn in that single frame,
- then the finished gasket **holds** (no redraw) until `time > cycles`, at which point `init_apollonian` **clears the screen** and a fresh game regenerates.

So at the stock `delay` (1 s/frame) and `cycles = 20`, each gasket draws over 5 s, holds ~16 s, then regenerates (~21 s/gasket). `cycles` is read live (the C reads `MI_CYCLES` every frame). The old port instead grew the gasket smoothly in ~90 tiny batches with an invented hold formula — replaced by the exact frame-state machine above.

## Rendering — fill inner, stroke outer + lines (faithful — was wrong before this audit)
- **Inner circles are FILLED** (the C's `XFillArc`) — an Apollonian packing's circles are mutually tangent and never overlap, so filling produces the classic solid colour-packed disks without hiding anything. (The previous port stroked every circle as an outline, which is *not* the C's look; corrected.)
- **The outer bounding circle (`bend < 0`) and the degenerate "lines" (`bend == 0`) are STROKED** (the C's `XDrawArc` / `XDrawLine`).
- Each chunk's arcs are bucketed by colour index into one `Path2D` per colour (the `braid.js` / `penrose.js` idiom): a fan of thousands of circles becomes `<= ncolors` `fill()`/`stroke()` calls. Since the packing never overlaps, draw order within/across colour buckets is irrelevant to the final image.

## Palette — make_random_colormap(bright_p = False) (faithful — was a vivid rainbow before this audit)
apollonian declares no `*_COLORS` flag, so xlockmore builds it with `color_scheme_default`, i.e. **`make_random_colormap(bright_p = False)`**: `ncolors` **independent fully-random RGB colours** (each channel a random 16-bit value), **not** a smooth ramp and **not** a saturated rainbow. Ported via `makeRandomColormapRGB(ncolors, false)` from `colormap.js`. Cadence is faithful: the colormap is built **once** (per `init`, mirroring the C's once-at-startup build) and never cycled (apollonian's draw loop has no colour rotation; its writable-colormap path is dead on TrueColor). Only `color_offset = NRAND(ncolors)` is re-rolled per gasket, rotating which colour each curvature lands on. The colour index is the C's `((int)((g + color_offset) * g)) % ncolors`, where `g` is the bend **for the active geometry** (`e`/`s`/`h` — see "Alternate geometries"), made positive for the outer circle. `ncolors <= 2` is the C's mono path: white circles, with black inner labels / white outer labels.

The earlier `hsl(i*360/n, 100%, 50%)` vivid rainbow was the systemic "rainbow where the C uses `make_*_colormap`" bug — replaced.

## Labels (faithful: gate + contrasting colour)
With labels on (default) and an **all-integer** gasket (`c4.e` integer — the C's gate), each big-enough inner circle is stamped with its integer curvature (the bend for the active geometry — `e`/`s`/`h`), and the outer circle with its negative bend. Ported from `p()`:
- **inner label** only when the circle is bigger than the text (the C's `c.e < e*size/((ascent+descent)*2)`, i.e. diameter `> 2*(ascent+descent)`) **and** the bend `< 1000`; drawn in the **contrasting** colormap entry `(idx + ncolors/2) % ncolors` (mono: black), centred.
- **outer label** = the (negative) outer bend, in the ring's own colour (mono: white), near the top-left (the C's offset formula).

Font is the C's fixed `sans-serif bold 16` (scaled by `devicePixelRatio`). The X11 ascent/descent metrics are unavailable in canvas, so `ascent` and `ascent+descent` are approximated (`0.8·` and `1.2·` the font size); this only shifts the exact size threshold and the outer-label position slightly, never which gaskets are labelled. The previous port drew all labels in flat white with a looser size cutoff — corrected to the contrasting colour + faithful gate.

## Alternate geometries — `altgeom` (faithful; ported after the initial audit)
The C can **relabel** a packing in spherical or hyperbolic geometry (`--altgeom`, default on). This is now ported faithfully. It is a pure **relabel + recolour + caption** — circle positions and radii are *always* the euclidean `e`/`x`/`y`; only the bend used for the colour index, the label number, and a bottom-left space-name caption change.
- **Geometry pick (per gasket).** `cp->altgeom = label && altgeom` (so it is inert when labels are off); then `geometry = (game != 0 && altgeom) ? NRAND(3) : 0` — euclidean / spherical / hyperbolic in equal thirds for non-game-0 gaskets. Net: ≈63% of all gaskets are non-euclidean at the defaults (game 0 and the predefined irrational games never caption), matching the C.
- **Seed `s`/`h` bends.** Each circle carries `e`/`s`/`h`. The four predefined examples' `s`/`h` are restored from the C's table (game 0 tabulated; the irrational games use `s = h = e`). Generated quadruples get integer `s`/`h` from a **verbatim transcription of `cquad()`** (with `geom`, `is_tangent`, `iceil`, `iflor`, and the `For`/`FOR`/`H`/`UNIT`/`T`/`LO`/`HI`/`B` macros): a bounded exhaustive integer search for `(p,q) = (bend·x, bend·y)` placements that keep the packing tangent (`is_tangent`) and have the parity (`H`) / `UNIT` properties that force **integer** spherical/hyperbolic labels via `geom = (e² + (1 − p² − q²)·g) / 2e`. As in the C, `cquad` does not break — the **last** valid placement wins.
- **Propagation.** `f()` carries `s` and `h` through the **same** linear recurrence as `e`/`x`/`y` (`2(s₁+s₂+s₃) − s₄`), so every circle's labels stay integer.
- **Verification.** The transcription was checked against the C's own published tables (apollonian.c:255-279): euclidean `(-1,2,2,3)` → spherical `(0,1,1,2)`, hyperbolic `(-1,1,1,1)`, and `s + h == e` for every circle — an exact match. Over all 64 generated quads `cquad` finds an integer-label placement (0 fallbacks), `s` and `h` differ from `e`, and the whole 64-quad search costs ~11 ms (it runs once per non-euclidean gasket).
- **The bottom-left caption** (`euclidean`/`spherical`/`hyperbolic`) is drawn with the outer circle when labels are on, exactly as `p()` does — it is no longer omitted.

Two small, documented edges (the C's behaviour is buggy/undefined here, so a safe equivalent is used):
- If `cquad` finds *no* placement (never observed for the 64 quads), the seeds keep an `s = h = e` **euclidean fallback** rather than the C's stale leftover values.
- For non-euclidean inner circles whose (geometry) bend is negative, the colour index can go negative; the C indexes `pixels[]` out of bounds there — we **wrap into range** instead.

## Deviations from the C (the real, remaining ones)
- **`devicePixelRatio`**: the backing store is sized in device px and `size`/`offset`/line-width/font derive from it, so the gasket fills the viewport crisply on retina (and, as on a higher-resolution X display, resolves a few more of the tiniest circles).
- **Units / host**: `delay` in µs (xml default `1000000`); keypress / `fps` handling dropped (the host owns keys and the meter).

## Config
Mirrors `hacks/config/apollonian.xml`: `delay` (Frame rate, live, inverted; `0..1000000`, default `1000000`), `cycles` (Depth, live; `1..20`, default `20`), `ncolors` (`2..255`, default `64`, reinit), `label` (Draw labels, reinit), `altgeom` (Include alternate geometries, default on, reinit). `count` is fixed at 64 (the C's `*count`, never exposed in the .xml). Non-live changes and "Reset to defaults" re-run `init()` (rebuilds the palette, fresh gasket); `r` (restart) regenerates too.

## Correctness self-review
- **Termination is numeric-stable.** Curvatures only grow down the recursion, so the sub-pixel and off-screen bails always fire (headless stress: 400 gaskets, no throw / no stack overflow; heaviest single fan ~3.4k circles at 820×560). A defensive `MAX_DEPTH = 5000` / `pending > 300000` cap guards the irrational-seed float cases; neither is approached (real depth ≈ 25-71).
- **The reveal always completes and resets.** `time` advances 0→`cycles` then `generate()` clears + re-seeds; a degenerate game (`c1.e == 0 || c1.e == -c2.e`, which the actual seed set never produces) still falls through to a clean regenerate after `cycles`.
- **First frame looks right.** `generate()` runs in `init()` before the first `rAF`, so frame 0 draws the seed circles immediately. `pause()`/`resume()` reset `lastTime` so resuming can't burst.
