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
Canvas **vector ops, full repaint each frame**: the C double-buffers and `XFillRectangle`-clears black every frame, so there are no trails to preserve. Each fiber is exactly **two polylines**, as in the C: a body (`draw[0..NODES-1-tiplen]`, muted depth colour) plus the last `tiplen` segments overdrawn in the tip hue. **No tip dot** — the C draws only these two `XDrawLines` and the live binary shows plain short bright tip segments, not blobs. ~2 strokes per fiber per frame (~1000 strokes at count=500) — sparse enough for direct vector ops, matching [[braid]]/[[qix]] rather than the blit path.

## Fidelity notes / deviations from the C
- **Tip palette = `make_uniform_colormap`.** The C `#define UNIFORM_COLORS` → `color_scheme_uniform`, so `MI_PIXEL` looks up a uniform colormap. Ported via `colormap.js` `makeUniformColormapRGB(ncolors)` — a full 0→359 hue ramp at a *single per-run* saturation and value (each random in 66–100%), so on any run the tips are a somewhat desaturated/dimmed rainbow, **not** the max-vivid `hsl(…,100%,55%)` the earlier port used. The colour-wheel math (base-azimuth `atan2` + `psi`, truncated/wrapped index into `ncolors`) is unchanged and faithful. The **body** colours stay the hardcoded X names (`#E0E0C0`/`#808070`/`#404020`) — those are the back/middle/front depth cue, not a computed palette. (Verified vs the live binary: both show muted cool-hued tips over warm khaki bodies; the exact tip hue range differs per run — port blue/magenta, live cyan/teal — which is the uniform colormap's random S/V.)
- **Window-move term — faithful residue kept.** Each frame the C does `node[NODES-2].x *= 0.1*(ry-y); node[NODES-2].x += 0.05*(rx-x)` to sway the bundle when the X11 window is dragged. A browser canvas never moves, so `(ry-y)==(rx-x)==0`: the add term is 0, **but the multiply zeroes `node[NODES-2].x`**, and that zero is read by the downstream-load loops (for `i < NODES-2`) *before* the `i==NODES-2` pass recomputes the position. So the port keeps `nodes[NODES-2].x = 0` each frame and drops only the (always-zero) window tracking. *(An earlier note called the whole term a no-op — wrong: `*= 0` is not `+= 0`.)* The base "knock" (`change_fiberlamp`) is the remaining, intended, perturbation.
- **No tip dot.** The C draws two `XDrawLines` per fiber and nothing else; an earlier port stamped a filled `arc` at the tip. Removed — the live binary shows plain short bright tip segments, no blobs.
- **`count` default = 500** (stock xml), restored from an earlier port's 200. A full vector repaint of 500 fibers/frame is fine in a modern browser (the 12 s capture rendered smoothly).
- **No `PLAN`/`CHECKCOLORWHEEL` debug views** (both `#undef` in the C) — elevation view only.

## Correctness self-review
- **No closure/termination state to dead-lock.** Unlike figure hacks, fiberlamp is continuous physics with no "figure complete" branch — there is no float-equality closure test that could fail to fire. The only periodic event is the knock (`count++ > cycles`), which re-rolls `cxOffset` and resets `count` but *deliberately does not* reset fiber state (the bundle keeps swaying through it), so it can't freeze or blank.
- **Physics constants kept verbatim** (`DT=0.5, PY=0.12, DAMPING=0.055, NODES=20`); the C warns higher NODES needs smaller DT, so they're frozen together and `NODES` is not a knob.
- **Startup faithful.** `init()` runs exactly **one** physics step to prime `draw[]` before the first paint — the C's `draw_fiberlamp` likewise integrates one step before its first `XDrawLines`, so paint N shows the state after N steps in both. No multi-step warm-up: the fibers start as near-straight rods in a 30° cone and droop into the lamp shape over the first ~second, the C's authentic power-on bloom (skipped by the earlier port's 60-step warm-up).
- **Numerical stability verified by harness**, not by eye: a stubbed-canvas run captured every `moveTo`/`lineTo` coordinate — **0 NaN/Inf across millions of sampled points over ~24 simulated seconds**, with x/y bounds stable frame 1 vs after 1500 frames (no drift/blow-up). Geometry lands on-screen: y rises from the base at the bottom, x splays around centre, i.e. fibers fan up and out.
- **Index math matches the C exactly.** `draw[i-1]` is filled for `i = 1..NODES-1` → `draw[0..NODES-2]` valid (NODES-1 points); `draw[NODES-1]` is never referenced by either stroke (body = `draw[0..NODES-1-tiplen]`, tip = `draw[NODES-1-tiplen..NODES-2]`), matching the C's `XDrawLines(draw, NODES-tiplen)` / `XDrawLines(draw+NODES-1-tiplen, tiplen)`.
- **pause→resume** resets `lastTime` so there's no catch-up burst; **reinit** re-seeds fibers/palette and clears to black for a clean fresh screen.

## Config
Units/defaults mirror `hacks/config/fiberlamp.xml`: `delay` (µs/step, **10000** stock, `invert` "Frame rate" slider), `count` (fibers, **500** stock), `cycles` ("Time between knocks" in frames, 10000). `delay`/`cycles` are **live** (read every step); `count` is **not live** (it sizes the fiber array, so a change re-runs `init()` via `reinit()`).

`ncolors` (tip-wheel size, 64) is a real resource (`fiberlamp.c` `DEFAULTS *ncolors:64`) but `fiberlamp.xml` exposes **no** colour slider, so it is a fixed internal value, not a param (cf. `fadeplot`, whose xml *does* expose ncolors).

**Speed.** `config.delay` is the stock 10000 µs — a sleep *floor*; the rAF lag-accumulator paces at `(delay + OVERHEAD)`. `OVERHEAD` is the live-measured **15100 µs** (live 39.8 fps, Load 60.2%, clean at stock delay 10000): 500 fibers of O(NODES²) physics + ~1000 vector strokes/frame make it a heavier draw than the sparse curve hacks. See [[framerate-calibration]].

**Local dev:** ES-module `import`s need a server — `python3 -m http.server` in the repo, then <http://localhost:8000/#fiberlamp>.
