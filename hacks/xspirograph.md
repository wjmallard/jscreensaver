# xspirograph — port notes

Port of `xspirograph.c` ("The Spiral Generator", Rohit Singh, 2000; `-subdelay`/`-alwaysfinish` and overdraw-avoidance later added by Matthew Strait) — the pen-in-nested-plastic-gears toy. A point at distance `d` from the centre of a small disc rolling inside a larger ring traces an epitrochoid, drawn as a long polyline that closes on itself; figures stack in different hues, then the screen clears and a fresh set begins.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/xspirograph.c` (~338 lines) · <https://en.wikipedia.org/wiki/Spirograph>

## Algorithm
The core is the C's `go()` equation, transcribed verbatim into `plot()`:

```
x = xmid + (r1 - r2)·cos(θ°) + d·cos( ((r1·θ − delta)/r2)° )
y = ymid + (r1 - r2)·sin(θ°) + d·sin( ((r1·θ − delta)/r2)° )
```

`r1` is the ring radius (half the smaller screen dimension), `r2 = r1/divisor + 5` the rolling-disc radius (`divisor` random in ±[1,4], so `r2` is signed), `d` the pen offset (`100..299`). `delta = 1` is a deliberate *error* baked into the second term — Singh's note: "Imperfection adds to beauty"; it slightly desynchronises the two rotations so the petals precess instead of overlapping exactly.

The figure is swept by integer `theta` (degrees), one line segment per step. Closure is tested by **float equality** to the first point, exactly as the C does — but with `delta`'s imperfection the precessing curve never lands on it again, so **every figure runs to the `360*100` theta cap** (the C's non-`-alwaysfinish` break), building the dense rosette the live binary shows.

### State machine (the C's `xspirograph_draw`)
`NEW_LAYER → DRAW → … → ERASE1 → ERASE2 → NEW_LAYER`. A `counter` counts figures drawn this screen:
- **NEW_LAYER** increments `counter`. Once it exceeds `2 × layers`, reset to 0 and go to ERASE1; otherwise pick a colour and draw.
- Geometry is chosen by `pick_new()` only on the **first** figure of each pair (the odd→even `counter` transition where `flip_p` was 0). The pair's **second** figure reuses the same geometry with `r2` negated, giving a mirror-petalled companion. Each figure (both halves of a pair) gets its *own* fresh colour.
- So `layers = N` draws `2N` figures = `N` mirror-pairs, each pair a different shape, every figure a different hue.
- **ERASE1/ERASE2** hold the finished figures (`linger` seconds), clear, then leave the screen black ~1 s before the next set.

`flip_p = counter & 1` is recomputed every step from the live `counter` and drives both the `r2` sign in DRAW and the pick-new decision in NEW_LAYER — this port computes it identically at the top of `step()`.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — vector ops, incremental (persistent canvas)
The curve is genuinely line-shaped (the C emits one `XDrawLine` per theta step), so this uses **canvas vector ops**, not a blit. Unlike boxfit/braid (which clear and fully repaint each frame), xspirograph **draws incrementally onto the persistent canvas**: each step accumulates up to `SEGS_PER_STEP` (1000, matching the C's batch) line segments into a `Path2D` and `stroke()`s it once in the layer's colour. Nothing is repainted — segments build up over many frames and stacked layers accumulate, exactly like the C drawing over the live window. The canvas is double-buffered so the running stroke is flicker-free.

## Palette
The C is a native screenhack with **no `make_*_colormap`** — `new_colors()` rolls a *fresh* colour per figure: `hsv_to_rgb(random()%360, frand(1.0), frand(0.5)+0.5)` — hue 0–359, **saturation random 0..1 (full range, so many figures come out pale or near-white)**, value 0.5–1.0. The port reproduces this exactly: `newColor()` rolls the same H/S/V distribution and converts it with an inline `hsv_to_rgb` matching `utils/hsv.c` / `colormap.js`; each figure is a single random HSV colour, re-rolled per run, so a plain `Math.random` stream is faithful.

There is **no palette table and no colour-count control.** The earlier port shipped the systemic vivid-rainbow bug — a fixed `hsl(h, 100%, 60%)` ramp indexed by a fabricated `ncolors` slider, so every figure was max-saturation. Verified against the live binary: live figure-sets mix vivid *and* pale/near-white figures (saturation spans 0..1); the fixed rainbow was wrong. `ncolors` is removed (it isn't in the `.c` DEFAULTS or the xml).

## Timing
Stock `*subdelay = 20000` µs is the per-draw-step delay; `*delay = 5` is **not** a frame delay — the C reads it only as a 0/nonzero flag deciding whether the erase phases pause (it then hard-codes a 5 s hold + 1 s black). `xspirograph_draw` returns the microseconds to the next call — `subdelay` while drawing, the multi-second holds at the erase phases — and the port keeps this boxfit-style: `step()` returns the ms until the next step and the rAF lag-accumulator honours it, so the between-set pauses are preserved.

**Calibration (delay-bound, not compute-bound).** The live `-fps` overlay reads ~48.9–52.9 fps at Load ~24–33 % while drawing — delay-bound on `subdelay` (1e6/20000 = 50 fps). So OVERHEAD ≈ 0; a token `OVERHEAD = 500` µs added to `subdelay` pins the draw step at ~48.8/s. Measured port rate: **48.6 steps/s** (mean inter-stroke interval; the 16.8 ms median is rAF quantization). `config.subdelay` default = the stock **20000** — the previous port shipped `60000` (3× too slow), contradicting its own slider default of 20000.

## Deviations from the C
- **Erase = instant black, a wipe candidate.** The C calls xscreensaver's `erase_window` transition (a fancy animated wipe) between figure-sets. As instructed, this port just `fillRect`s the screen black at that point. **Replacing it with a real wipe is a future enhancement** once a shared wipes module exists.
- **Linger honours the config.** The C's ERASE1 hard-codes a 5 s hold (with a source comment questioning why it ignores the configured delay). This port uses the configured `linger` value (1–60 s, the xml's "Linger" slider) so the slider actually does something; the post-erase black hold stays ~1 s as in the C.
- **devicePixelRatio.** `r2`'s `+5`, the pen distance `d`, and the line width are scaled by `dpr`, and the backing store is device-px, so the figures keep their size and the strokes stay crisp on retina (the C only bumps line width to 3 px past 2560). Scaling all geometry uniformly preserves the theta at which a figure closes, so closure detection is unaffected.
- **No `alwaysfinish` toggle.** The C's `-alwaysfinish` removes the `360*100` theta cap. Since the float-equality closure essentially never fires, the default (cap on) means every figure runs to 36000 segments — which is what the port does — so the toggle is dropped from the UI (it isn't in the xml either).

## Config
Ranges mirror `hacks/config/xspirograph.xml`. The xml reuses `id="delay"` for two different sliders, ported under distinct keys:
- `subdelay` — **Frame rate** (`--subdelay`, µs/step, live, inverted: drag right = faster).
- `linger` — **Linger** (`--delay`, 1 s … 1 min hold before erasing, live).
- `layers` — **Layers** (`--layers`, 1–10 figure-pairs; non-live, re-runs via `reinit()`).

Non-live changes and `reinit()` start a fresh screen with the current config. Local-dev/module-fetch caveat is the same as `squiral.md`.
