# hacks/shelved — retired experiments

Nothing here is served: the catalog build resolves `hacks/<slug>.js` only, and
its `--check` (run by the pre-push hook) fails if a taxonomy entry has no
module there.

- `kumppa-webgl.js` — exploratory WebGL2 proof-of-concept for kumppa; the
  faithful, shipped port is the canvas one (`hacks/kumppa.js`).
- `vfeedback.js` / `vfeedback.md` — video feedback on the analog-TV engine,
  shelved as inspired-not-faithful; the `.md` tells the story.
- `steger-threejs/` — the Steger parametric-surface hacks tried on three.js;
  see its own README.

The GPU-heavy shadertoy six (alienbeacon, bestill, bubblecolors, fluxcore,
rigrekt, universeball) lived here from 2026-06-24, when "shelved" meant "too
heavy for full res", and moved to `hacks/` on 2026-08-08, having long since
shipped in the catalog. They keep `heavy: true` in their `info` exports (the
picker's red GPU dot) and settle at ~0.61× render scale under `shadertoy.js`'s
adaptive scaler.

## Earlier false alarm (keep in mind)
A *first* shelving pass mis-blamed the shaders for stutter that was actually
environmental — many accumulated browser tabs (each holding a live WebGL
context; browsers thrash past ~16) plus a second 4K monitor. Those hacks were
un-shelved once tested on a clean single tab / single display. The heavy six
were different: they genuinely can't hold 60fps at full retina even in a clean
environment; adaptive res keeps them smooth.

## Architectural lesson (host integration / harness v2)
The real villain behind the tab-thrash was **one WebGL context per hack** (each
mounts its own overlay canvas + context to dodge the shared 2D canvas's context
lock). The host — and a future harness rev — should **reuse a single GL context**
and swap only the program on switch. The adaptive scaler in `shadertoy.js` is a
backstop, not the fix.
