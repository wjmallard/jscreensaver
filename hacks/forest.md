# forest -- port notes

Port of `forest.c` (aka xtree.c; Peter Baumung, 1999, built on jwz's xscreensaver code) -- grows a recursive fractal forest one tree per frame, each tree a branching fractal crowned with round leaves, in a per-forest seasonal hue. When a forest is full it lingers, clears, and a new one grows in a fresh colour theme.

Original: <https://www.jwz.org/xscreensaver/> - source: `xscreensaver-6.15/hacks/forest.c` (~240 lines). Removed from xscreensaver as of 5.08; kept here for the gallery.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` -- see `squiral.md`. The recursive-subdivision twin is `ccurve` (`See [[ccurve]]`); the fixed-timestep loop is the `squiral` one.

## Algorithm
A tree is grown by `draw_tree_rec(thick, x, y, angle)` (`angle` 0 = straight up):
1. Draw a tapered branch of random length `(24 + rand(12)) * size` from `(x,y)` to the new tip `(a,b)`, width `thick*size` narrowing to `0.68*thick*size`.
2. While `thick > 2`, recurse into a **main continuation** (`0.68*thick`, angle straightened toward vertical via `0.8*angle` plus a small jitter), and -- on every segment after the first (`thick < treeThick-1`) -- two **side branches** at `angle +/- rRand(0.2, 0.9)` (the second sprouting from the segment midpoint).
3. Once `thick < 0.5*treeThick` the twig sprouts `12 + rand(4)` round leaves scattered within `+/-12*size` of the tip.

`draw_trees` plants one tree per frame. The tree count `todo` starts at 25 and counts down; each tree's root `y = 1.25*H*(1 - todo/23)` sweeps from above the top edge down past the bottom, so the ~24 trees paint **back-to-front** (nearer trees overpaint farther). Each tree's base thickness is `rRand(7,12)` (int) and its leaf hue is one of 4 seasonal groups. When `todo` hits 0, `pause` is armed and the finished forest is held for several frames; the reseed frame then runs `init_trees` (clear, new `season`, `todo=25`) and -- exactly as in the C's `draw_trees` -- *falls through to draw* the first tree (`todo=25`). That tree's root sits above the top edge and grows upward, so it is off-screen; only `todo` 24..1 are ever visible.

**Colours** transcribe `init_trees` exactly: indices 0..3 are trunk shades (brown for `ncolors>=8`, gray for 4..7, mono for <4); indices 4..n-1 are leaf hues -- 4 consecutive rainbow hues from `colorM[(season+g)%12]`, each in 4 darkening shades `colorM - 2*colorV*k`. So every forest gets a coherent seasonal palette (e.g. greens-through-azure) that changes each cycle. Verified the packed RGB math (`(c>>16)&255`, ...) reproduces the C's `XColor` bytes.

## Rendering -- filled bands + circles, bucketed by colour
Genuinely shape-based: the C draws each branch as `widths` adjacent 1px `XDrawLine`s shaded across its width in 4 trunk colours, plus `XFillArc` leaves. Doing thousands of 1px strokes per tree is wasteful in canvas, so:
- **Branches** are drawn as **4 filled cross-section bands** -- one solid tapered quad per trunk colour spanning fractions `[k/4, (k+1)/4]` of the width. This is the same shaded solid band the strands produce, with no rounding gaps.
- **Leaves** are filled circles (`Path2D.arc`).
Both are bucketed into one `Path2D` per colour and filled once, so a whole tree paints in ~8 `fill()` calls. (`XFillArc`'s `width`/`height` is the diameter, so leaf radius = `size*rRand(2,6)/2`, centred on the bounding-box centre -- matched here.)

## Deviations from the C
- **Filled bands instead of stroked strands.** The C's per-strand `i*4/widths` colouring becomes 4 equal filled bands across the branch -- visually identical (solid, shaded, tapered) and far cheaper. Faint anti-alias seams between the 4 near-identical brown bands are possible but invisible at branch scale. The C's `for(i=0;i<widths;i++)` draws nothing when `(int)widths == 0`; the port's `if (widths < 1) return` matches that. The C strokes those strands at line width 2 (`XSetLineAttributes(... 2 ...)`), so its branches read ~1-2px wider than these exact-width bands -- negligible on the trunk, slightly more relative on the thinnest twigs (which are leaf-covered anyway).
- **Leaf vs branch z-order.** The C interleaves leaves with branches per recursion node; the port draws **all branches then all leaves** of a tree, so foliage always crowns the twigs. The per-tree paint order (and thus the back-to-front forest layering) is preserved -- only the intra-tree leaf/twig overlap shifts slightly, which reads as natural foliage.
- **`devicePixelRatio` is automatic.** `treeSize = canvas.height/480` uses the device-pixel backing-store height, so every length/width/leaf derived from it is already in device px -- crisp on retina with the C's exact proportions. No separate scale factor or line width is needed (everything is filled, not stroked).
- **`rRand` is continuous.** The C quantizes to a 1/10000 grid (`rRand = a+(b-a)*NRAND(10001)/10000`); a plain uniform draw over `[a,b)` is equivalent for the geometry.
- **`delay` mirrors the stock 500000 us** (restored to the xml default in the fidelity audit; an earlier port had lowered it to 250000 by feel). A cycle is 31 steps (1 reseed/off-screen tree + 24 visible trees + 1 linger-arm + 5 hold), ~15 s at stock pace; the `delay` slider is **live**, so the grow is trivially sped up. The xml's `delay` (Frame rate, inverted) and `ncolors` (Number of colors) sliders are both kept; `--fps` is dropped (the host owns the meter).
- **Trees draw past the screen edges** (roots sweep from above the top to below the bottom, leaves jitter outward). The C draws off-screen too and relies on X clipping; canvas clips identically.

## Correctness self-review
- **Termination.** `draw_tree_rec` recurses only while `thick > 2`, multiplying `thick` by 0.68 each level, so depth is bounded (~5 from `thick=11`) and the branch factor is <=3 -- no runaway. Headless harness over 200 frames: max 5272 path coords in any single frame (bounded), 0 hangs.
- **The clear/reseed cycle fires.** Each 31-frame cycle has exactly one clear (in `seedForest`/`init_trees`), so the linger->reseed path runs once per forest and never stalls on a full screen. Per cycle: 1 reseed frame (clear + the off-screen `todo=25` tree) + 24 visible-tree draws + 1 linger-arm frame + 5 hold frames. (An earlier headless harness counted ~7 clears / 200 frames; the cadence is unchanged by the reseed-fall-through fix -- only the reseed frame now also draws.)
- **Every state path re-seeds what the next frame reads.** `pauseCount==1` runs `seedForest()` (clear + new `season` + `buildPalette()` + `todo=25`) before the next draw; the per-tree fields (`treeX/Y/Thick/Size/Color`) are all recomputed at the top of each drawing step. No "dead" state across cycles.
- **No NaN / no over-draw.** Harness reported **0 non-finite coords**; `ncolors` 1..20 (incl. the <4, <8 boundaries) ran 60 frames each with **0 exceptions and 0 malformed colour strings**. There is no float-equality closure to misfire (the figure resets on an integer frame counter, not a geometric condition), so the "never resets" class of bug can't occur.
- **No freeze on refocus.** Fixed-timestep loop caps catch-up at `MAX_CATCHUP_STEPS = 4` (small, since each step paints a whole tree); `pause`/`resume` reset `lastTime` to avoid a burst; `reinit` re-reads `ncolors` and grows a fresh forest from a cleared screen.

## Config
Mirrors `hacks/config/forest.xml`: `delay` (Frame rate, live, inverted, 0..3000000 us, default 500000 = stock) and `ncolors` (Number of colors, reinit, 1..20, default 20). `--fps`/`showfps` is a framework control (host-owned), so it is not exposed. Non-live changes / "Reset to defaults" / `r` re-run `init()` (fresh forest).
