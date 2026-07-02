# mountain — port notes

Port of `mountain.c` (Pascal Pensa, 1995; xscreensaver port 1997).

Original: <https://www.jwz.org/xscreensaver/> · source: `mountain.c` (~283 lines)

## Algorithm
A random landscape on a fixed **50x50 height field** (`WORLDWIDTH`). The field starts flat (all zero). `count` **peaks** are dropped at random interior cells, each set to `NRAND(MAXHEIGHT)` where `MAXHEIGHT = 3*(width+height)` (so peaks scale with the canvas, in device px). One **diffusion pass** (`spread`) walks every cell and averages that cell's height into each of the 9 cells in its 3x3 neighbourhood — in place, so the sweep smears the spikes into rounded hills. Then a small **noise** term (`NRAND(10)-5`) is added per cell and anything below 10 is flattened to ground.

The field is drawn one **quad per step**, walking left to right then bottom to top. Each quad spans cells `(x,y),(x+1,y),(x+1,y+1),(x,y+1)` and is projected with a fixed **isometric skew**: `sx = cellX·k - cellY/2 + width/4`, `sy = cellY·k - height + height/4` (with `k = 2·dim/(3·WORLDWIDTH)`). Subtracting the height from screen-y is what makes taller cells rise up the screen, so the accumulated peaks read as a 3D-ish range. Each quad is filled in a palette colour taken from the **average height of its four corners** (`(sum>>2)/10 + offset`, mod `ncolors`) and outlined in black (or, in wireframe mode, drawn as the outline only). Once the whole field is drawn the C dwells for `cycles` ticks (4000), then regenerates a fresh range and restarts the build.

**Per-range modes (fullrandom).** xscreensaver's xlockmore shim sets `mi->fullrandom = True` unconditionally (`xlockmore.c:518`), so `init_mountain` rolls, for every range: `wireframe = LRAND()&1` — **half of all ranges draw as coloured outlines only** — and `joke = NRAND(10)==0` — a 1-in-10 range draws each quad *randomly* filled-or-wire. The `-wireframe` resource branch is dead code in the standalone build.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. Technique twin: `spiral.js` (incremental sparse vector draws + periodic regen) and `braid.js` (vector strokes).

## Rendering — sparse vector, one quad per step
Faithful to the C's `drawamountain()`: each `step()` draws exactly one quad (a filled `Path2D` polygon plus a black outline stroke, or just the outline when wireframe). The range therefore **grows in place** across ~49x49 = 2401 steps; the field is never cleared mid-build, so older quads persist — matching X11's single buffer. Integer math (`Math.trunc`, `>>1`, `>>2`) mirrors the C's `int` divisions exactly so the projection and colour indices land on the same pixels/colours.

## Deviations from the C
- **`devicePixelRatio`**: the backing store is sized in device px; `MAXHEIGHT`, the projection, and line widths are all in device px, so the range fills the canvas and reads the same on retina. (Peak heights scale with the canvas via `MAXHEIGHT`, exactly as the C intends.) `pixelmode` compares **logical** px (`(W+H)/dpr < 200`) so retina doesn't skew the tiny-window test; a fullscreen canvas never triggers it. The C's `refresh_mountain` expose path is dropped (canvas needs no manual repaint).
- **Palette (audit fix)**: the C is built with `SMOOTH_COLORS`, so the shim allocates one **`make_smooth_colormap`** per session (`xlockmore.c:484`) — never rebuilt per range; `init_mountain` only re-rolls the rotation `offset = NRAND(ncolors)`. The port now uses the shared `makeSmoothColormapRGB(ncolors)` (built once at start / reinit, offset re-rolled per range) — the muted coherent anchor-hue loop, **not** the vivid full-saturation `hsl()` rainbow the port had (the systemic audit bug). White quads when `ncolors <= 2` (the C's mono path).
- **fullrandom modes restored (audit fix)**: the earlier port omitted `joke` and exposed an invented static **wireframe** checkbox (defaulting to always-filled). Both reversed: the checkbox is gone (mountain.xml has no such knob — Rule 3) and every range now rolls `wireframe` 50/50 and `joke` 1/10, exactly like the live binary.
- **Units / speed (audit fix)**: `delay` is the **stock xml 20000 µs** (an earlier by-eye 30000 in the .js / 10000 in these notes — both gone). Build ticks pace at **(delay + OVERHEAD)** µs per quad; `OVERHEAD = 6250` is live-measured via the binary's `-fps` overlay (38.1 fps at Load 23.8% mid-build — a clean reading: the sleep slice `26247·(1−0.238) = 20000` equals the stock delay exactly), giving the live ~63 s build. **Dwell ticks run at the raw delay** — the C draws nothing in stage 1, so its dwell tick costs just the 20 ms sleep; the stock `cycles = 4000` (a **draw-tick count** with no xml knob — the invented "Dwell" slider is gone) then holds the finished range ~80 s, like the live binary. `fps` / keypress handling dropped (the host owns the meter and keys).

## Correctness self-review
- **Termination / closure of the build**: the cursor advances `curX++`; at `curX === WORLDWIDTH-1` it wraps (`curY++, curX=0`); at `curY === WORLDWIDTH-1` it sets `stage = 1`. This is the C's exact branch, so the build always finishes (it never indexes past 49 — corners read `x+1,y+1`, max 49, in bounds). No exact-float comparisons anywhere; all cursor tests are integer `===`.
- **Stage machine re-seeds**: `stage 0` draws; `stage 1` increments `dwell` until `> cycles`, then `stage 2`; `stage 2` calls `generate()`, which resets `curX/curY/stage/dwell` and rebuilds `h` — so every state transition re-initialises what the next state reads. No dead/never-reset variable.
- **First frame looks right**: `generate()` runs in `resize()` before the first `rAF`, so the field + palette + black background are ready; the very first `step()` draws a valid quad at `(0,0)`.
- **No over-draw / freeze**: the dwell counter is plain integer increment vs the `CYCLES = 4000` constant, so it always reaches the regenerate branch. `pause()`/`resume()` reset `lastTime = 0` so resuming doesn't burst a backlog; `MAX_CATCHUP_STEPS` caps catch-up. `reinit` (and the host's `r`) rebuild the palette and call `generate()` for a clean fresh range.
- **Spot-check in the browser**: roughly half of new ranges should come up as coloured wireframe outlines, the rest filled with black grid lines; occasionally (1 in 10) a mixed fill/wire "joke" range. Colours should read as a coherent smooth ramp across the hills (height bands), not a rainbow.
- **`spread` faithfulness**: `v = h[x][y]` is read once at entry, then averaged into the neighbourhood with truncating integer division during the in-place sweep — byte-for-byte the C's behaviour, including the order-dependent smearing that gives the hills their shape.

See [[spiral]] and [[braid]].
