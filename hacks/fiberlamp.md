# fiberlamp — port notes

Port of `fiberlamp.c` by Tim Auckland (2005) — a fiber-optic lamp: many flexible glass fibers fan up and out from a base at the bottom-centre, each a hanging cantilever that sways with gravity/spring physics and glows at a coloured tip. The whole bundle slowly drifts and is periodically "knocked".

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/fiberlamp.c` (~480 lines), config `xscreensaver-6.15/hacks/config/fiberlamp.xml`.

See [[squiral]] for the shared module skeleton, [[grav]] for the per-object physics idiom this follows, and [[braid]] for the vector-stroke idiom.

## Algorithm
Each fiber is a chain of `NODES` (=20) nodes — the large-amplitude cantilever equation has no closed form, so it's discretised. Every node stores two angles, `phi` (tilt from vertical) and `eta` (azimuth), plus their angular velocities `phidash`/`etadash`. Each frame, node-by-node down the strand:
- a 2nd-order **damped diff equation** integrates `phidash`/`etadash` from three terms — a `pstress`/`estress` spring pulling each node's angle back toward its parent's, the **radial/transverse load** of *all* downstream nodes (the weight that droops the fiber), and a `drag` damping term;
- the node's 3D position is then placed off its parent using the parent's angles (`x = p.x + LEN*cos(eta)*sin(phi)`, `y = p.y - LEN*cos(phi)`, `z = p.z + LEN*sin(eta)*sin(phi)`), and projected to the screen in **elevation view** (x,y), with the base at the bottom-centre and a `width/2` scale.

Node lengths `LEN(i)` are uniform `1/(NODES-2.5)` except the last three nodes (`0.25/(NODES-2.5)`, shorter, for crisp colour tips); they sum to 1.0. A slowly-turning colour wheel `psi` (`+0.01`/frame) gives each tip a hue from its **base azimuth** (`atan2` of node[1]'s position + psi). Fibers get a muted body colour and a tip length by **depth** (back = dim/`#404020`, middle = medium/`#808070`, front = bright/`#E0E0C0`), and are bubble-sorted back-to-front by tip `z` (one pass/frame — order changes slowly). Every `cycles` frames the lamp is **knocked**: the base x shifts to a fresh random offset in `[-1/8, 1/8]` fiber units and the bundle sways in response.

## Rendering
Canvas **vector ops, full repaint each frame**: the C double-buffers and `XFillRectangle`-clears black every frame, so there are no trails to preserve. Each fiber is one body polyline (`draw[0..NODES-1-tiplen]`, muted depth colour) plus the last `tiplen` segments overdrawn in the vivid tip hue, with a small filled **tip dot** (`arc`, r ≈ 1.4×lineWidth) for the glowing fiber end. ~2 strokes + 1 dot per fiber per frame (≈600 ops/frame at count=200) — sparse enough for direct vector ops, matching [[braid]]/[[qix]] rather than the blit path.

## Deviations from the C
- **Window-move term dropped.** The C deflects `node[NODES-2].x` by the X11 window's motion (`*= 0.1*(ry-y); += 0.05*(rx-x)`). A browser canvas never moves, so both deltas are identically 0 every frame *and* that node's x is immediately overwritten by the `i == NODES-2` integration step, so the term is a no-op. Removed (not silently — noted inline and here). The base "knock" (`change_fiberlamp`) is the remaining, and intended, perturbation.
- **Tips are a vivid HSL rainbow** instead of the X colormap lookup, per the gallery's aesthetic call. The colour-wheel math (base-azimuth `atan2` + `psi`, truncated/wrapped index) is faithful; only the palette source changed. The **body** colours stay muted (`#E0E0C0`/`#808070`/`#404020`) because they're the back/middle/front depth cue — structural to the look, not a palette choice.
- **`count` default lowered 500 → 200.** A full vector repaint of 500 fibers/frame is heavy in a browser; 200 reads the same and stays smooth. The xml range (10..500) is preserved, so 500 is one slider drag away. `delay` left at the stock 10 ms.
- **Warm-up steps at init.** The C lets the bundle splay out over the first many frames (starting near-vertical). To avoid a degenerate first painted frame (all fibers collapsed on the axis), `init()` runs ~60 silent physics steps before the first `draw()`, so frame 1 already shows a splayed bundle. Pure cosmetics on startup; steady-state is unchanged.
- **No `PLAN`/`CHECKCOLORWHEEL` debug views** (both `#undef` in the C) — elevation view only.

## Correctness self-review
- **No closure/termination state to dead-lock.** Unlike figure hacks, fiberlamp is continuous physics with no "figure complete" branch — there is no float-equality closure test that could fail to fire. The only periodic event is the knock (`count++ > cycles`), which re-rolls `cxOffset` and resets `count` but *deliberately does not* reset fiber state (the bundle keeps swaying through it), so it can't freeze or blank.
- **Physics constants kept verbatim** (`DT=0.5, PY=0.12, DAMPING=0.055, NODES=20`); the C warns higher NODES needs smaller DT, so they're frozen together and `NODES` is not a knob.
- **Numerical stability verified by harness**, not by eye: a stubbed-canvas run captured every `moveTo`/`lineTo`/`arc` coordinate — **0 NaN/Inf across 6.3M sampled points over ~24 simulated seconds**, with x/y bounds identical at frame 1 and after 1500 frames (no drift/blow-up). Geometry lands on-screen: y rises from the base at the bottom, x splays ~±580 px around centre (horizontal spread ~1160 px), i.e. fibers fan up and out, not collapsed on the axis.
- **Index math matches the C exactly.** `draw[i-1]` is filled for `i = 1..NODES-1` → `draw[0..NODES-2]` valid (NODES-1 points); `draw[NODES-1]` is never referenced by either stroke (body = `draw[0..NODES-1-tiplen]`, tip = `draw[NODES-1-tiplen..NODES-2]`), matching the C's `XDrawLines(draw, NODES-tiplen)` / `XDrawLines(draw+NODES-1-tiplen, tiplen)`.
- **pause→resume** resets `lastTime` so there's no catch-up burst; **reinit** re-seeds fibers/palette and clears to black for a clean fresh screen.

## Config
Units/defaults mirror `hacks/config/fiberlamp.xml`: `delay` (µs/step, 10000, `invert` "Frame rate" slider), `count` (fibers, default 200 vs xml 500), `cycles` ("Time between knocks" in frames, 10000), `ncolors` (tip-wheel size, 64). `delay`/`cycles` are **live** (read every step); `count`/`ncolors` are **not live** (they size the fiber array / tip palette, so a change re-runs `init()` via `reinit()`).

**Local dev:** ES-module `import`s need a server — `python3 -m http.server` in the repo, then <http://localhost:8000/#fiberlamp>.
