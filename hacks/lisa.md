# lisa — port notes

Port of `lisa.c` ("draws animated full-loop lissajous figures", Caleb Cullen, 1997; 2006 colour-cycling fixes) — one or more closed Lissajous loops that slowly precess, drift around the screen bouncing off the edges, and periodically "melt" from one harmonic shape into another. Each loop is drawn as a dashed rainbow.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/lisa.c` (~743 lines) · <https://en.wikipedia.org/wiki/Lissajous_curve>. Sibling Lissajous hack: see [[lissie]]; the dashed-rainbow-polyline idiom and variable look mirror [[xspirograph]].

## Algorithm
A figure is a CLOSED loop sampled at `nsteps` (`cycles`) points. For point `i`:

```
theta = (i + phase) * pistep,   phi = (i - phase) * pistep,   pistep = 2*PI / nsteps
additive:        x = cx + (R/2)*(sin(xc0*theta) + sin(xc1*theta))
                 y = cy + (R/2)*(sin(yc0*phi)   + sin(yc1*phi))
multiplicative:  x = cx +  R   * sin(xc0*theta) * sin(xc1*theta)
                 y = cy +  R   * sin(yc0*phi)   * sin(yc1*phi)
```

`R` is the radius (== `size`, clamped to fit the screen by `checkRadius`), and the coefficient pairs come from a fixed table of 28 functions (the C's `Function[]`). With either mode the loop's half-extent equals `R`, so the bounce uses `R` as the half-size.

`phase = loopcount % nsteps` advances by 1 each frame, shifting `theta` up and `phi` down, so the whole loop slowly precesses/morphs (a full precession every `nsteps` frames). The figure is re-sampled in full every frame — closure is inherent in `pistep = 2*PI/nsteps` plus modular indexing when stroking, so there is **no float-equality closure test** to misfire.

### State machine (the C's `draw_lisa`/`change_lisa`)
- Each frame `loopcount++`. When it exceeds `maxcycles = 3*nsteps - 1`, `change()` fires: `loopcount` resets to 0 and every loop starts melting (`melting = nsteps-1`, `nfuncs = 2`) into a freshly-chosen, non-repeating function. "Rare" functions (index >= 25) are biased down (1:4 chance of a re-roll).
- During a melt the displayed point is a weighted blend of the old function[0] (weight `melting/nsteps`) and the new function[1] (weight `(nsteps-melting)/nsteps`); when `melting` ticks to 0 the new function becomes current (`function[0] = function[1]`, `nfuncs = 1`). So a change = a smooth one-cycle morph, then ~2 steady cycles, repeat.
- The first figure is always `Function[24]` (the C's `STARTFUNC`), so the first frame is a clean, non-degenerate shape (seeded in `seedAll`).
- The centre drifts by `(dx,dy)` each frame and bounces off the edges; on a bounce the new velocity is a fresh random `0..VMAX` (so a loop can occasionally stall on one axis, exactly as in the C).

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — vector ops, full repaint each frame
Sparse vector ops. The whole figure is split into `cstep`-point colour segments (`cstep = nsteps>ncolors ? floor(nsteps/ncolors) : 1`); segment *k* is hue `k mod ncolors`, drawn as a `Path2D` polyline, with the connector to the next segment's start point **left undrawn** — the C's `CapNotLast` "intentional whitespace" that separates colours into a dashed rainbow. Segments are bucketed by colour and each colour stroked once (<= `ncolors` strokes per loop). `lineCap='butt'`, `lineJoin='bevel'` mirror the C's `CapNotLast`/`JoinBevel`.

## Palette — `make_uniform_colormap` (faithful)
lisa.c defines `UNIFORM_COLORS`, so xlockmore fills its `ncolors` (default 64) cells with **`make_uniform_colormap`**: a full hue ramp from 0 to 359 at a **single per-run saturation and value, each random in 66%–100%** (HSV). So the loop is a rainbow, but on any given run it is usually a touch desaturated/dimmed, and it varies run to run. The port builds exactly this via the shared `colormap.js` `makeUniformColormapRGB(ncolors)` (an exact port: `make_color_ramp(0,S,V → 359,S,V)` over a per-run `S,V`). `ncolors <= 2` draws white (the C's `MI_NPIXELS <= 2` / `MI_WHITE_PIXEL` mono path). This **replaces the early port's fixed max-vivid `hsl(h,100%,60%)` rainbow** (the systemic always-vivid palette bug — see the fidelity audit), which was always brighter and more saturated than the original's averaged ~83% S / ~83% V. The colour index resets to 0 at the start of each figure (the C's per-frame `loop->color = STARTCOLOR`), keeping the colouring solid rather than flickering.

## Deviations from the C
- **Erase = full repaint (not erase-old-then-draw-new).** The C draws the new figure and erases the *previous* frame's segments in SOLID black (it uses no XOR). Doing that incrementally on a persistent canvas would leave anti-aliased ghost lines, so — like [[lissie]] — this port clears to black and recomputes/redraws every figure each frame. Visually identical (moving rainbow loops on black), ghost-free. With `count > 1` the C's per-figure black erase could nick an overlapping figure; full repaint avoids that too.
- **Float coords, no `ceil`.** The C rounds each point to integer X11 pixels with `(int)ceil(...)`. This port keeps float coordinates for smooth anti-aliased strokes. Rendering-only; does not affect the (count-based) state machine.
- **`cstep < 2` draws dots.** When `cycles <= ncolors`, `cstep == 1` and the C's `XDrawLines(..., 1, ...)` draws nothing (invisible figure). This port draws a `linewidth`-sized dot per point instead so small-`cycles` figures stay visible.
- **Robust mono / low-colour path.** The C's `MI_NPIXELS <= 2` branch sets `cstep = 0` and then computes `nsteps % 0` (a div-by-zero only dodged because real displays have many colours). This port always uses `ncolors >= 1`, so `cstep >= 1`; `ncolors == 1` draws a single white loop. No crash path.
- **devicePixelRatio.** Drift velocities, the figure radius (`size`), and line width are scaled by `dpr` (`S`), and the backing store is device-px, so size/speed/strokes are consistent on retina. The C's "*2 line width past 2560 px" hack is replaced by the uniform `dpr` scale. Uniform scaling preserves the phase/closure behaviour.
- **`additive` exposed in the UI.** A stock lisa option (`-/+additive`, default on) that the stock UI omits; added here as a checkbox since it materially changes the shapes (sum-of-sines vs product-of-sines).

## Correctness self-review
- **No closure/over-draw bug:** the figure is re-sampled in full every frame and closed by modular indexing — there is no exact-float-equality test that could fail to fire.
- **Every state branch re-seeds what the next reads:** `change()` sets `func1`/`melting`/`nfuncs`; the melt-end sets `func0`/`nfuncs`; `seedAll` sets all per-loop state and pre-computes the first frame so the first paint is a real figure (not blank/off-screen).
- **No divergence / freeze:** all output is bounded sums/products of sines * radius. A headless harness ran ~4 change cycles for both modes and reported **0 NaN/Inf**, point bounds inside the canvas, melts active (~2299 melt-frames), changes firing every `3*nsteps` steps, and 9164/9216 distinct head positions (the loop genuinely precesses — no "dead" static figure). The rAF catch-up is capped (`MAX_CATCHUP_STEPS = 8`) and `lag` is bounded, so a backgrounded tab can't burst or freeze; `pause`/`resume` reset `lastTime` to avoid a jump.

## Timing — stock delay + framework OVERHEAD
lisa.c's `*delay: 17000` is a sleep floor; the live binary's real per-frame cost is higher. Measured live lisa = **39.8 fps** (`-fps` overlay, Load 32% — delay-bound, so a portable target), i.e. a ~25126 µs period. So `config.delay` defaults to the **stock 17000** and the step loop adds a measured **`OVERHEAD = 8126` µs** (`= 1e6/39.8 - 17000`); the port then precesses/drifts at the original's pace (measured port rate **39.9 steps/s** via a `Math.sin`-count proxy — see framerate-calibration). The `delay` slider still maps 1:1 to the stock resource. This replaced an earlier by-eye `delay: 25000`.

## Config
Defaults/ranges mirror `lisa.c`'s `DEFAULTS` block (lisa has no `.xml` — it was removed from xscreensaver in 5.08):
- `delay` — **Frame rate** (`--delay`, stock 17000 µs/step + OVERHEAD, live, inverted: drag right = faster).
- `cycles` — **Steps** (`--cycles`, `nsteps`; 1–1000; non-live, re-seeds via `reinit()`).
- `ncolors` — **Colors** (`--ncolors`; 1–255; non-live).
- `size` — **Size** (`--size`; 10–500; live — `checkRadius` re-reads it each frame).
- `count` — **Count** (`--count`; number of loops, 1–20; non-live).
- `additive` — **Additive** (`-/+additive`; sum vs product of sines; live).

Non-live changes and `reinit()` start a fresh screen with the current config. Local-dev/module-fetch caveat is the same as `squiral.md`.
