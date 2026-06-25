# apollonian — port notes

Port of `apollonian.c` (Allan R. Wilks, 2000-2001; xscreensaver port by David Bagley, 2001) — an **Apollonian gasket**: four mutually-tangent circles recursively packed with ever-smaller tangent circles, demonstrating Descartes' Circle Theorem. Coloured by curvature (which rises with depth), so the packing rainbows from the big outer circles inward.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/apollonian.c` (~820 lines)

## Algorithm
Each circle is a `(bend, bend*x, bend*y)` triple, where **bend = curvature = 1/radius** and the real centre is `(x/bend, y/bend)`. The gasket starts from a "game": a seed quadruple of four mutually-tangent circles. Two sources of seeds, exactly as the C:
- a tiny table of hand-picked **examples** (one all-integer "double semi-bounded" pair-of-lines case, plus three irrational 3-fold/semi/un-bounded cases using the constants `DELTA`, `ALPHA`, `BETA`), and
- **generated integer Descartes quadruples** from `dquad()` — an exhaustive search (bounded by `MAXBEND = 100`) for root quadruples `(a,b,c,d)` with `a <= 0` satisfying the Descartes condition; ported verbatim along with its `gcd` and integer-`isqrt` helpers. (The first few it finds — `(-1,2,2,3)`, `(-2,3,6,7)`, `(-3,4,12,13)`, … — match the C's own comment table exactly, which is how I checked the port.)

For every game except game 0, the four seed centres are recomputed from the bends via the C's `q123 = sqrt(e1·e2 + e1·e3 + e2·e3)` construction (the only square root in the whole hack). Then the packing is grown by **Descartes recursion** (`f()`): given four mutually-tangent circles, the new circle tangent to the first three (opposite the fourth) has
```
bend' = 2*(bend1 + bend2 + bend3) - bend4
```
and the `bend*x`, `bend*y` coords obey the **same linear recurrence** — so after the seed there are *no* square roots, and integer games stay exactly integer. `f()` emits the new circle and recurses three ways (replacing each of the first three by the new one). Recursion stops when the new circle vanishes (`bend == 0`), shrinks below a pixel (`bend > size*outerE`), or wanders off-screen (`|centre coord| > BIG = 7`) — exactly the C's bail conditions.

Each circle's screen geometry and colour come from a faithful port of the C's `p()`: the unified pixel mapping `centre = size*outerE*(coord)/(2*bend) + size/2 + offset`, `radius = outerE*size/(2*bend)`, with the C's separate sign convention for the outer (`bend < 0`) circle and the degenerate `bend == 0` straight-line case both preserved. Colour index is the C's `((int)((g + color_offset) * g)) % ncolors` on the (positive) bend `g`.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. Recursive generative geometry follows `penrose.js`; bucketed-arc stroking follows `braid.js`.

## Rendering — vector ops, bucketed by colour
Circles are genuine **outlines** (thin strokes), not per-pixel accumulation, so this uses canvas vector ops. A finished gasket is a few thousand circles (≈2.1k–2.5k for the bounded games, up to ≈12k for the unbounded line-packing game 0), which would be thousands of `arc()`+`stroke()` calls. As in `braid.js`/`penrose.js` they are **bucketed by colour index** into one `Path2D` per colour (≤ `ncolors`) and each bucket stroked once. The packing is grown **incrementally** — a batch of circles per step, the batch sized so the whole gasket reveals in ~the same wall-clock time (~1.5 s) no matter how many circles it has — so you watch it fill inward, then it holds, then a fresh game regenerates.

## Deviations from the C
- **Strokes outlines instead of filling.** The C *fills* the inner circles (`XFillArc`) and only strokes the outer one (`XDrawArc`). Per the brief, this port **strokes every circle's outline** (vivid by curvature/depth) for the classic clean "gasket" look; the bend→colour mapping is unchanged. (Filling would hide the nested smaller circles under the larger ones' paint — the outline view is the recognisable one.)
- **Euclidean only — `altgeom` / spherical + hyperbolic dropped.** The C can relabel a packing in spherical or hyperbolic geometry (the `s`/`h` bends, the `cquad()` exhaustive integer solver, and `geom()`). That only changes the *labels and colour* of certain generated games (when `--altgeom` is on, 2/3 of the time), never the circle positions, and `cquad()` is a heavy exhaustive search. It is omitted; the `altgeom` toggle is therefore **not exposed** (a control that did nothing would be misleading). The default-visible euclidean gasket — what you almost always see — is fully faithful.
- **Incremental reveal instead of the C's 5-frame draw.** The C draws the entire gasket across 5 enormous 1 s frames (`time` 0..4: the four seeds, then four `f()` fans), then idles until `time > cycles` and re-inits. We grow it smoothly (a batch per `delay` step) for a far nicer animation, then hold, then regenerate. Same final image.
- **`cycles` ("Depth") maps to hold duration, not recursion depth.** This is faithful: in the C, `cycles` never bounded the recursion either — depth is governed entirely by the pixel-size / off-screen bail in `f()`. `cycles` only set how long a finished gasket lingered before re-init. Here, higher "Depth" simply lingers longer on each completed packing.
- **Integer-curvature labels** (the signature numbers inside the circles) are kept, drawn only for all-integer games and only in circles big enough to fit the text — the C's `g < … && font fits` gate, approximated by a min-radius cutoff. Rendered in white (the C alternates fg/bg by colour; a single light pass reads fine over the rainbow strokes).
- **`devicePixelRatio`**: the backing store is sized in device px and `size`/`offset` derive from it, so the gasket fills the viewport crisply on retina; line width and the label font scale by `S`.
- **Units / tuning**: `delay` µs (xml 1 000 000 = 1 s/frame → a much calmer-*feeling* 16 ms reveal step, since we now animate the growth rather than flash whole frames). Keypress / `fps` handling dropped (the host owns keys and the meter).

## Correctness self-review (won't freeze / won't over-draw)
- **Termination is numeric-stable.** Curvatures only *grow* down the recursion, so the `bend > size*outerE` (sub-pixel) and `|coord| > BIG` (off-screen) bails always fire — verified by a headless audit over all 4 predefined + many generated games: max recursion depth observed was 25–71 and total circles 2.1k–12.3k, every game terminating cleanly. A defensive hard cap (`MAX_DEPTH = 5000`, `shapes.length > 200000`) guards the irrational-seed float cases against a pathological non-terminating branch; neither cap was approached in testing.
- **No exact-float-equality traps.** The bail tests are `>`/`<` inequalities and an `=== 0` bend check (bends are produced by integer-coefficient linear recurrence from the seed, so `c.e === 0` is exact for integer games and a genuine "this branch is a line/degenerate, stop" signal — same as the C).
- **The reveal always completes and resets.** `revealed` monotonically climbs to `shapes.length`; once complete, `holdSteps` counts down (re-armed once, then strictly decremented every step) and on hitting 0 clears to black and calls `generate()`. A degenerate game that emits nothing (`c1.e === 0 || c1.e === -c2.e`) is handled by an early hold-then-regenerate, so it can never wedge on a blank screen. `pause()`/`resume()` reset `lastTime` so resuming can't burst; `reinit()` clears and re-seeds for a clean fresh screen on a non-live config change.
- **First frame looks right.** `generate()` runs in `init()` (called from `resize()` before the first `rAF`), so shapes exist immediately and the reveal starts on frame 1 — no off-screen or degenerate opening.

## Config
Ranges mirror `hacks/config/apollonian.xml`: `delay` (Frame rate, live, inverted), `cycles` (Depth → hold duration, reinit), `ncolors` (reinit), `label` (Draw curvature labels, reinit). `altgeom` is intentionally not exposed (see deviations). Non-live changes and "Reset to defaults" re-run `init()` (a fresh gasket); `r` (restart) regenerates too.
