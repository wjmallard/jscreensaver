# sphere — port notes

Port of `sphere.c` (Tom Duff, original algorithm, Lucasfilm 1982; xlock version
David Bagley 1993; made a standalone XScreenSaver hack by Jamie Zawinski 1997;
Copyright 1988 Sun Microsystems). Removed from the XScreenSaver distribution as
of 5.08; the source is preserved in-repo. Config from `hacks/config/sphere.xml`
(delay + ncolors only).

## Algorithm

An xlockmore hack. One ball at a time, **one scanline per tick**: each
`draw_sphere()` call paints a single column (`dirx = ±1`) or row (`diry = ±1`)
of the current ball — jwz's 1997 change added the vertical mode. Per tick:

1. If the sweep coordinate has crossed the whole disk (`|x| >= radius` on the
   active axis), roll a fresh ball: `radius = NRAND(min(w,h)/2 - 1) + 1`
   (uniform — 1-px dots through near-half-screen giants), centre
   `NRAND(width), NRAND(height)` (anywhere on screen, so balls are often
   clipped at the edges), axis 50/50 and direction 50/50, colour
   `NRAND(npixels)`.
2. Clamp the sweep coordinate onto the screen (clipped balls skip their
   off-screen scanlines), and compute the scanline's chord across the disk,
   `±SQRT(radius² - x²)`, clipped to the screen at both ends.
3. Draw the chord **black** (`XDrawLine` in `MI_BLACK_PIXEL`) — this erases
   older balls underneath and keeps the unlit limb pure black.
4. Stipple the chord: each pixel gets a dot with probability
   `N.L / (radius·NR)` — `NRAND(radius*NR) <= NX·sx·x + NY·sy·y +
   NZ·SQRT(r²-x²-y²)` — the Lambert cosine against the fixed light vector
   `(NX,NY,NZ) = (48,-36,80)`, `|N| = NR = 100`, as a random-threshold
   halftone (`XDrawPoints` in the ball's colour). The brightest point
   (probability exactly 1) sits at `centre + (0.48, -0.36)·radius`; pixels
   facing away from the light never draw. This grainy shading is the hack's
   identity.
5. Advance the sweep one pixel; running off the screen edge jumps the
   coordinate to the far rim so the next tick re-rolls.

`shadowx/shadowy` (`±1`, rolled once in `init_sphere`) flip which corner the
light shines from — fixed for the whole session. Balls **accumulate forever**:
`MI_CLEARWINDOW` runs only in `init_sphere` (start/resize); there is no wipe,
no dwell, no per-ball pause — a finished ball is followed immediately by the
next. `sphere.c` has no `MI_IS_FULLRANDOM` branches, and never reads
`MI_CYCLES`/`MI_SIZE` (the `DEFAULTS` cycles/size lines are dead).

**Colour**: built with `BRIGHT_COLORS`, so the xlockmore shim allocates
`make_random_colormap(bright_p = True)` **once per session** (xlockmore.c:484)
— `ncolors` *independent* vivid random colours (H 0–360, S 30–100%, V
66–100%), not a ramp. Each ball indexes a random entry. `ncolors <= 2` falls
into the shim's MONO branch (`npixels = 2`): dots draw in `MI_WHITE_PIXEL`.

## Module shape

`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see
`squiral.md`. xlockmore sibling: `mountain.js` (same shim rules: session
colormap, stock delay + OVERHEAD pacing, dead DEFAULTS knobs dropped).

## Rendering — sparse fillRect stipple on a logical-pixel grid

The simulation runs on a **logical-px grid** (`width/height =
canvas.px / devicePixelRatio`, min 4 like the C's `MAX(…, 4)`); each C pixel
renders as an `S×S` device rect, so the grain size and sweep pace match a 1x
display on retina. Per tick: one black chord `fillRect` + up to ~2·radius dot
`fillRect`s (sparse — fillRect is the right tool per the perf notes). Integer
math mirrors the C: `SQRT` is `Math.floor(Math.sqrt())`, the radius roll uses
`>> 1` integer halves, and all coords stay integers, so chord extents and the
threshold inequality are exact.

## Deviations from the C

- **Shading (audit fix)**: was a hand-built 5-stop `hsl()` offset radial
  gradient per ball — invented, smooth, un-grainy. Now the C's actual
  per-scanline random-threshold halftone, transcribed line for line from
  `draw_sphere` (the re-roll branch, the edge clamps, the chord clip, the
  black line, the stipple inequality, the off-screen jump).
- **Palette (audit fix)**: was an evenly-spaced full-vivid `hsl()` hue wheel
  (the systemic rainbow bug). Now `makeRandomColormapRGB(ncolors, true)` —
  the C's `BRIGHT_COLORS` scheme — built once per session, rebuilt only on
  `reinit` (config change); a resize re-inits the hack but keeps the palette,
  matching the shim (`reshape_sphere == 0` re-runs `init_sphere`; the colormap
  is allocated once). Mono (`ncolors <= 2`) is white stipple, not a grey
  gradient.
- **Radius (audit fix)**: was narrowed to `(0.05..0.35)·min(w,h)` "for looks";
  restored to the C's uniform `NRAND(min(w,h)/2 - 1) + 1` — tiny balls are
  frequent and legitimate.
- **Accumulation (audit fix)**: the port wiped to black after ~1.8 screens of
  banked coverage, and pre-filled 3 complete balls at init — both invented.
  The C clears only in `init_sphere` and starts on plain black; balls now pile
  up forever, overlaps erased chord-by-chord as new balls sweep over.
- **Pace (audit fix)**: the port swept `max(2, r/40)` px per tick so every
  ball revealed in ~1–2 s — invented. The C draws exactly **one scanline per
  tick** at `delay` µs (`xlockmore_draw` returns `mi->pause`), so a
  radius-250 ball takes ~10+ s at stock — faithfully slow. The rAF
  lag-accumulator paces at **(delay + OVERHEAD)** µs; `delay` is the stock
  20000, `OVERHEAD = 7800` is live-measured via the binary's `-fps` overlay
  (36.0 fps at Load 28.1% mid-sweep — a clean reading, the sleep slice
  `27778·(1−0.281) = 19972` ≈ the stock delay).
- **devicePixelRatio**: logical-px simulation grid, `S×S` device-px dots (see
  Rendering). `Math.random()` replaces the C's `random()` stream (house
  standard; only the distribution matters here).
- On X11, a *resize* re-init goes through the shim's animated `erase_window`
  wipe before clearing; the port clears instantly (wipes.js exists but is not
  integrated — host-level decision). `fps`/keypress handling dropped (the
  host owns the meter and keys).

## Correctness self-review

- **Termination**: every tick either advances the sweep by exactly 1 px or
  jumps it to `±radius` (off-screen edge), which forces the re-roll condition
  on the next tick; a ball lasts at most `2·radius + 1` ticks. All cursor
  tests are integer comparisons — no float-equality anywhere.
- **No negative sqrt**: the screen clamps only shrink the chord toward 0, so
  `|yy| <= isqrt(sqrd)` always, and `sqrd - yy·yy >= 0`. (The bottom clamp
  `height - y0` can address one row past the edge, exactly like the C, where X
  clips it; canvas clips it too.)
- **Re-roll completeness**: the re-roll branch re-seeds everything the next
  tick reads (radius, centre, axis, direction, sweep coord, colour);
  `shadowx/shadowy` are intentionally session-fixed (init_sphere). After
  `reinit` shrinks `ncolors`, the first step re-rolls before any draw uses
  `palette[color]`, so the index can't go stale.
- **First frame**: `init` leaves `|x| == radius` with `dirx = 1` (the C's
  `sp->x = sp->radius`), so the very first step rolls a ball and draws its
  first scanline — the C's exact startup: black screen, first ball sweeps in.
- **pause/resume/reinit**: squiral contract; `resume` resets `lastTime` so
  there's no catch-up burst; `MAX_CATCHUP_STEPS = 8` caps a backgrounded tab
  at 8 scanlines.
- **Verified vs the live binary** (side-by-side captures, 2026-07-01): same
  grain, same dark-limb falloff, same flat leading edge on the mid-sweep
  ball (with the black chord line at the sweep row), same chord-by-chord
  overwrite of older balls, comparable ball cadence at stock delay.

See [[mountain]] (xlockmore sibling) and [[squiral]] (canonical skeleton).
