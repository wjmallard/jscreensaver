# mountain — port notes

Port of `mountain.c` (Pascal Pensa, 1995; xscreensaver port 1997).

Original: <https://www.jwz.org/xscreensaver/> · source: `mountain.c` (~283 lines)

## Algorithm
A random landscape on a fixed **50x50 height field** (`WORLDWIDTH`). The field starts flat (all zero). `count` **peaks** are dropped at random interior cells, each set to `NRAND(MAXHEIGHT)` where `MAXHEIGHT = 3*(width+height)` (so peaks scale with the canvas, in device px). One **diffusion pass** (`spread`) walks every cell and averages that cell's height into each of the 9 cells in its 3x3 neighbourhood — in place, so the sweep smears the spikes into rounded hills. Then a small **noise** term (`NRAND(10)-5`) is added per cell and anything below 10 is flattened to ground.

The field is drawn one **quad per step**, walking left to right then bottom to top. Each quad spans cells `(x,y),(x+1,y),(x+1,y+1),(x,y+1)` and is projected with a fixed **isometric skew**: `sx = cellX·k - cellY/2 + width/4`, `sy = cellY·k - height + height/4` (with `k = 2·dim/(3·WORLDWIDTH)`). Subtracting the height from screen-y is what makes taller cells rise up the screen, so the accumulated peaks read as a 3D-ish range. Each quad is filled in a palette colour taken from the **average height of its four corners** (`(sum>>2)/10 + offset`, mod `ncolors`) and outlined in black (or, in wireframe mode, drawn as the outline only). Once the whole field is drawn the C dwells for `cycles` ticks, then regenerates a fresh range and restarts the build.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`. Technique twin: `spiral.js` (incremental sparse vector draws + periodic regen) and `braid.js` (vector strokes).

## Rendering — sparse vector, one quad per step
Faithful to the C's `drawamountain()`: each `step()` draws exactly one quad (a filled `Path2D` polygon plus a black outline stroke, or just the outline when wireframe). The range therefore **grows in place** across ~49x49 = 2401 steps; the field is never cleared mid-build, so older quads persist — matching X11's single buffer. Integer math (`Math.trunc`, `>>1`, `>>2`) mirrors the C's `int` divisions exactly so the projection and colour indices land on the same pixels/colours.

## Deviations from the C
- **`devicePixelRatio`**: the backing store is sized in device px; `MAXHEIGHT`, the projection, and line widths are all in device px, so the range fills the canvas and reads the same on retina. (Peak heights scale with the canvas via `MAXHEIGHT`, exactly as the C intends.)
- **No `pixelmode` / no expose repair**: the C's tiny-window `pixelmode` (skips outlines when `width+height < 200`) is dropped — our canvas is never that small. The C's `refresh_mountain` expose path is dropped (canvas needs no manual repaint).
- **"joke" mode omitted**: in FULLRANDOM the C has a 1-in-10 chance to enable a `joke` flag that makes each quad *randomly* either a wireframe or a filled+outlined polygon — a degenerate per-quad gimmick. We omit it and instead expose a clean **wireframe** checkbox (a real C mode: `--wireframe`). Default is the iconic **filled** look.
- **Units / tuning**: `delay` stays µs (xml default 20000); we default it to **10000 µs** so the ~2400-step build is a touch livelier-but-calm (~24 s) rather than the stock ~48 s. The C's `cycles` (4000) is a **draw-tick dwell count**, not seconds; at our step pace 4000 idle ticks is a very long pause, so the default is scaled to **600** (slider still reaches 4000). `fps` / keypress handling dropped (the host owns the meter and keys).
- **Vivid palette**: `hsl(i·360/n, 100%, 55%)` rainbow over the C's allocated colormap; white when `ncolors ≤ 2` (the C's mono path).

## Correctness self-review
- **Termination / closure of the build**: the cursor advances `curX++`; at `curX === WORLDWIDTH-1` it wraps (`curY++, curX=0`); at `curY === WORLDWIDTH-1` it sets `stage = 1`. This is the C's exact branch, so the build always finishes (it never indexes past 49 — corners read `x+1,y+1`, max 49, in bounds). No exact-float comparisons anywhere; all cursor tests are integer `===`.
- **Stage machine re-seeds**: `stage 0` draws; `stage 1` increments `dwell` until `> cycles`, then `stage 2`; `stage 2` calls `generate()`, which resets `curX/curY/stage/dwell` and rebuilds `h` — so every state transition re-initialises what the next state reads. No dead/never-reset variable.
- **First frame looks right**: `generate()` runs in `resize()` before the first `rAF`, so the field + palette + black background are ready; the very first `step()` draws a valid quad at `(0,0)`.
- **No over-draw / freeze**: the dwell counter is plain integer increment vs `config.cycles`, so it always reaches the regenerate branch. `pause()`/`resume()` reset `lastTime = 0` so resuming doesn't burst a backlog; `MAX_CATCHUP_STEPS` caps catch-up. `reinit` (and the host's `r`) call `generate()` for a clean fresh range.
- **`spread` faithfulness**: `v = h[x][y]` is read once at entry, then averaged into the neighbourhood with truncating integer division during the in-place sweep — byte-for-byte the C's behaviour, including the order-dependent smearing that gives the hills their shape.

See [[spiral]] and [[braid]].
