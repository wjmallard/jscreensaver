# fadeplot — port notes

Port of `fadeplot.c` ("a fading plot of sine squared" — "some easy plotting stuff" by Bas van Gaalen, Holland, PD; turned into an xlockmore/xscreensaver mode by Charles Vidal, 1996; screensaver-compatible 1997). The XML credits "Bas van Gaalen and Charles Vidal; 1997", so that is what `info` shows.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/fadeplot.c` (~243 lines).

## Algorithm
A precomputed table `stab[]` holds a **signed sine-squared** curve: `stab[i] = (int)(sin(2π i/angles) · |sin(2π i/angles)| · min) + min`, where `angles` (the table length) is randomised to `250..1199` each run and `min` is half the short side of the screen. The `·|sin|` keeps the sign while squaring the magnitude, so the values run `[0, 2·min]` with a flatter middle than a plain sine.

Each frame plots a cloud of `maxpts` tiny dots, split into `nbstep` strands. For strand `j`, dot `i`: the x-index into the table is `(st.x + speed.x·j + i·step.x) mod angles` and the y-index is the same with the `.y` parameters; the table value is scaled by `factor` and centred (`·factor + W/2 − min`). So `step` sets the table stride *within* a strand and `speed` phase-shifts *between* strands — together a Lissajous-like ribbon. The sweep phase `st` advances by `speed` every frame, sliding the whole figure.

Old dots are erased (painted black) at the top of each frame *before* the new cloud is computed and drawn, so the ribbon morphs frame-to-frame instead of smearing. Every `angles/2` frames a mutate-and-clear block fires: it reassigns `temps` and conditionally nudges `speed.y` (`%30+1`), `speed.x` (`%20`) and `step.y` (`%2+1`), then wipes the screen — retargeting the figure to a fresh shape.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see [[squiral]]. Point-accumulation + erase-then-redraw idiom follows [[thornbird]] and [[spiral]].

## Rendering — per-dot fillRect, erase-previous + draw-current (no trail)
The field is **sparse**: at most `maxpts` dots (default `cycles/scale = 1500`), so each dot is a `scale`-sized `fillRect`, far cheaper than a per-pixel ImageData blit. Unlike spiral/thornbird there is **no persistent trail** — fadeplot keeps only the *previous* frame's dots, erases exactly those (`paintLive('#000')` over the cached `pts`), then computes and draws the new cloud. The C does the same with two `XFillRectangles` calls (the stale `pts` array, then the freshly filled one). The canvas is otherwise not cleared except by the periodic mutate block.

## Coordinate space
The C works in plain integer device pixels. `min = MAX(MIN(W,H)/2, 1)`; `factor.x = MAX(W/(2·min), 1)` (and `.y`). On a normal-aspect display `factor` is 1, so a table value `v∈[0,2·min]` maps to `v + W/2 − min ∈ [W/2−min, W/2+min]` — centred and on-screen. Verified headless: across 3M plotted dots at 1920×1080 **zero** landed off-screen; same at 3840×2160.

## Deviations from the C
- **Faithful port.** The signed-sine-squared table, the `nbstep × (maxpts/nbstep)` strand loop with `(st + speed·j + i·step) mod angles` indexing, the `st += speed` sweep, the erase-previous/draw-current rendering, and the periodic mutate+clear are all transcribed exactly. Struct fields renamed to locals: `speed.x/.y → speedX/speedY`, `step.x/.y → stepX/stepY`, `factor.x/.y → factorX/factorY`, `st.x/.y → stX/stY`; the rect array `pts` becomes a flat `Int32Array(maxpts*2)` of packed `(x,y)` with `nlive` tracking how many are currently on screen.
- **Operator precedence preserved.** The C's `fp->temps = fp->temps % fp->angles * 5` parses as `(temps % angles) * 5` (C `%` and `*` are same precedence, left-assoc) — kept verbatim, including the cascade of `% angles`, `% (angles*2)`, `% (angles*3)` tests and the `%30+1` / `%20` / `%2+1` wrap rules. (This makes the clear cadence irregular rather than a clean "every angles/2" — that is the original's behaviour.)
- **Integer math.** The C truncates toward zero with `(int)`; the port uses `| 0` / `Math.trunc` to match (notably `maxpts = cycles/scale | 0`, `per = maxpts/nbstep | 0`, `W/2 | 0`, and the sine-table `Math.trunc`).
- **Negative-count branch dropped.** The C lets `count` be negative ("random strands up to `|count|`"); the XML "Thickness" slider is `0..30` non-negative and the C floors to `MINSTEPS=1` anyway, so only the `Math.max(1, count)` floor is kept. (Slider min is 1 here — `nbstep < 1` would divide by zero in `maxpts/nbstep`.)
- **Retina scale.** Preserved verbatim: on `W>2560 || H>2560` the C sets `scale=3`, scales `step.x/.y` by it, and divides `maxpts` by it (bigger, fewer dots so density holds). Same here, driven off the device-pixel canvas size.
- **devicePixelRatio.** Backing store sized in device px (`canvas.width = innerWidth·dpr`); dot size is the C's `scale` (1, or 3 on huge displays), which already tracks the device-px dimensions.
- **No XOR / feedback tricks.** fadeplot uses only plain `XFillRectangles`, so nothing exotic to emulate.
- **Palette.** A full vivid HSL rainbow (`hsl(h,100%,55%)`, house style) replaces the original's `MI_PIXEL` colormap; `pix` cycles one step per frame exactly like the C (white if `ncolors ≤ 2`).

## Correctness self-review
- **No dead figure / endless overdraw.** The sweep phase `st` advances every frame and is the only thing that must keep moving for the ribbon to animate; it does (`stX/stY += speed`, both `>0`). The mutate block can set `speedX = speedX % 20`, which *could* reach 0 — but `speedY` stays `≥1` (its rule is `%30+1`) and `st.y` keeps sweeping, so the figure never fully freezes. Erase-then-redraw means no unbounded accumulation: exactly `nlive` dots are erased each frame, and `nlive` is reset after a full clear so the next frame doesn't try to erase stale coords on a blank screen.
- **No divide-by-zero.** `angles ≥ 250` (so `angles/2`, `% angles` are safe) and `nbstep ≥ 1` (so `maxpts/nbstep` is safe). `min ≥ 1`, so `factor` divisions are safe. Headless trace over 2000 frames showed the mutate+clear firing and `speed/step` staying within their wrap bounds.
- **On-screen seeding.** The first frame already plots a full centred cloud (verified zero off-screen dots), so there is no degenerate/off-screen start.
- **pause/resume & reinit.** Standard skeleton: `resume()` resets `lastTime` so there is no catch-up burst; `reinit()` re-runs `init()` (re-randomises `angles`, reseeds, clears to black) for a clean fresh screen on non-live config change.

## Config
Ranges mirror `hacks/config/fadeplot.xml`: `delay` (Frame rate, µs, **live**, inverted — the XML's `convert="invert"`), `count` (Thickness 1..30 → `nbstep`, reinit), `cycles` (Cycles 1..10000 → `maxpts`, reinit), `ncolors` (Number of colors 1..255, reinit). Default `delay` is the stock 30000 µs. The XML low bounds are 0 for count/cycles; the sliders here start at 1 to avoid the divide-by-zero / empty-cloud degenerate cases the C floors away internally.
