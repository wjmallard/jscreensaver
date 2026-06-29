# drift — port notes

Port of `drift.c` by Scott Draves (1991-2000; xscreensaver glue by Jamie Zawinski, 1997), from xlockmore — "drifting recursive fractal cosmic flames." A Scott Draves *flame* / iterated-function-system chaos game whose transform coefficients slowly drift, so the fractal cloud continuously morphs and floats.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/drift.c` (~674 lines)

See [[thornbird]] and [[hopalong]] for the same accumulate-into-a-blit-buffer technique; [[squiral]] is the canonical skeleton.

## Algorithm
A flame is a set of `nxforms` (2-5) affine transforms `f[2][3][i]` (a 2x3 matrix each), every one carrying a non-linear *variation* (0 identity, 1 sinusoidal, 2 complex, 3 bent, 4 swirl, 5 horseshoe, 6 drape). One point `(x, y)` plus a colour coordinate `c` walks the system: each iteration picks a random transform `i`, advances the colour (`c → (c+1)/2` if `i≠0`, else `c/2`), applies the affine map to get `(nx, ny)`, then the variation, then a divergence guard (if it blows past ±1e4, reset the point to a random spot and re-arm the FUSE). After `FUSE` (10) throwaway iterations to let the orbit settle, each settled point inside the unit square is plotted at `((W/2)(x+1), (H/2)(y+1))`; in colour mode `c·ncolors` chooses the hue.

The **drift**: after iterating `ITERS_PER_FRAME` (3000) points each frame, every coefficient takes one `df`-step — `f += df`, and when `f` leaves `[-1,1]` its velocity `df` reverses (a bounce). So the whole transform set creeps around its bounding box and the cloud morphs. `df` is picked once per flame, normalised so each transform drifts at a small fixed speed.

Points accumulate without clearing for the life of one flame (`fractal_len = 2_000_000 · count / 20` points ≈ 1000 frames at the default `count`). When the flame is full it ends; the C holds the finished image for ~4 seconds (`erase_countdown`), then clears and seeds a fresh random flame.

`-grow` and `-liss` are the original's command-line toggles (exposed here as checkboxes; not in the stock xml slider set): **grow** paints many short overlaid fractals instead of drifting one (no coefficient drift); **liss** drives each coefficient from a Lissajous figure `sin(liss_time · df)` instead of integrating + bouncing.

## Rendering approach
BLIT path: hundreds of thousands of points accumulate over one flame, so a persistent `Uint32Array` view over one `ImageData` is written pixel-by-pixel and `putImageData` once per frame — not per-point `fillRect` (which would be millions of draw calls per flame). `f[2][3][MAXLEV]`/`df` are flattened to length-`2·3·MAXLEV` `Float64Array`s indexed `row·3·MAXLEV + col·MAXLEV + i`.

## Deviations from the C
- **Palette = `make_smooth_colormap` (faithful).** drift.c defines `SMOOTH_COLORS`, so the xlockmore glue (`xlockmore.c:485`, via `xlockmore.h:202`) builds the colormap with `make_smooth_colormap` — a muted 2–5 anchor HSV loop, *not* a vivid rainbow — once at startup and never cycles it (`writable_p` is False; drift never re-allocates colors). The port reproduces it with `makeSmoothColormapRGB(ncolors)` (`colormap.js`), built once in `init()` and packed to ABGR for the blit path. `ncolors≤2` → mono white (mirrors the C's `dp->color = MI_NPIXELS > 2`). Only the per-flame mono `pixcol` (`initfractal`) re-rolls a random index into this fixed map. **Audit fix (2026-06-27):** the prior port used a vivid full-saturation `hsl(i/ncolors, 100%, 55%)` rainbow — a flattening deviation (Rule 1) — now replaced with the faithful smooth colormap.
- **Point size is a hidpi adaptation, not from the C.** The C draws one X pixel per point (`XDrawPoints`, no point-size logic). The port scales the dot to `round(dpr)` (and 3 on very large backing stores) so each point stays ~1 CSS px and the per-frame screen-fill fraction matches dpr 1; without it, retina would fill ~4× slower and look sparse. A platform adaptation, not a tuning fudge.
- **`delay` default is the stock 10000 µs** (the slider maps 1:1 to the xml resource). The rAF loop adds `OVERHEAD = 17473 µs` so `(delay + OVERHEAD)` reproduces the live binary's effective rate: measured against the live `-fps` overlay drift runs **36.4 fps**, while the port at the stock delay ran ~100 fps (2.7× fast — each frame's 3000 iters + blit make the framework overhead large here); `10000 + 17473 = 27473 µs → 36 fps`. The post-flame erase gap still derives from the raw delay (`4e6/delay` frames, the C's `erase_countdown`) and is left untouched. A calibration, not a tuning knob — see the framerate-calibration note.
- **Drift loop runs in `step()` not on a `usleep`** — the standard rAF lag-accumulator (fixed timestep paced by `config.delay` µs) replaces the C's busy/`usleep` pacing; one `step()` == one `draw_drift()` call (3000 iterations + one coefficient drift).
- **`halfrandom`/`frandom` use `Math.random`** instead of the C's hand-rolled bit-recycling LRAND. The C's `frandom(3)` rejection-samples 2 bits to a flat `[0,3)`; `Math.floor(random()*3)` is already flat, so the *distribution* is identical — only the (irrelevant) bit stream differs.
- **Grow-mode cycling is bounded by `nfractals`** exactly as the C (`initmode` sets it; each finished fractal decrements it; at 0 we blank + wait + re-seed). The C's no-grow path keeps `nfractals == 1`, so one flame drifts then the gap fires.
- **`erase_countdown` frames don't re-blit** the static held image (the screen already shows it) — we only repaint on the frame that clears + seeds the next flame. Behaviour matches the C (which `return`s without drawing during the gap); just fewer redundant `putImageData`s.

## Correctness self-review
Termination / reset / divergence all traced against the C by hand and exercised headless (4000+ frames):
- **Divergence guard** — `iter()` resets the point and re-arms FUSE on `|nx| > 1e4`; the swirl/drape variations also clamp `ny` to 1e4. Headless run over default + grow + liss modes: **0 NaN words** in the buffer, every frame plotted. No runaway.
- **Flame end → blank → re-seed** — verified the buffer density swings 0 → ~full → 0 over time (periodic clear confirmed: blank frames observed at default `count`, and a forced short flame (`count=1`) reaches a fully-black frame mid-cycle before the next flame builds). The gap can't get stuck: `eraseCountdown` is set to a positive frame count (`max(1, 4e6/delay)`) and decremented every frame; at 0 it re-seeds.
- **Drift actually drifts** — the plotted cloud's centroid moves ~13 px over 300 frames within a single long flame (coefficients integrate + bounce), so the figure morphs rather than sitting static.
- **`fuse` re-armed on every reset** — `initfractal()` sets `fuse = FUSE` and the divergence guard re-sets it, so the next plotted points are always settled (no off-screen garbage streak at flame start).
- **Latent dead branch preserved (not a bug):** the C's per-xform "mixed variation" branch (`NMAJORVARS == major_variation`) can never fire because `major_variation`'s re-weighting tops out at 6, never 7 — so every flame uses a single uniform variation. The port reproduces this faithfully rather than "fixing" the original's behaviour.
- **pause → resume** resets `lastTime` so there's no catch-up burst; **reinit** rebuilds the palette + buffer and seeds a fresh flame (clean black start). Both exercised without throwing.

## Config
Units/defaults mirror `hacks/config/drift.xml`: `delay` (µs/frame, stock 10000), `count` ("Duration", flame-lifetime scale, 30), `ncolors` (200). Added: `grow` and `liss` checkboxes for the original's `-grow`/`-liss` options.
- **`live: true`** (`delay`, `count`): the loop reads them every frame.
- **`live: false`** (`ncolors`, `grow`, `liss`): they size the palette or pick the flame mode, so a change re-runs `init()` via `reinit()` (which clears the canvas and seeds a fresh flame).
