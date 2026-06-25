# hacks/shelved — the "demanding tier"

These WebGL shader hacks all **render correctly and run at a locked 60fps** — but
only because the harness's adaptive-resolution scaler trims them to **~0.61×**
render scale on the reference machine (M4 Max, single tab, single display). They
were set aside (2026-06-24) to keep the *active* collection full-native-resolution
crisp. They are **not broken** — just GPU-demanding. Re-home freely if you decide
~0.61× (still supersampled vs a non-retina display) is acceptable.

## The `heavy` metadata flag
Each module here carries `heavy: true` as the first field of its exported `info`:

    export const info = { heavy: true, author: ..., description: ..., year: ... };

It's a machine-readable performance marker — a future host/GUI can render a
"heavy" badge by checking `module.info.heavy` (absent/falsy = full-res-capable).
Drop the same field on any other module, active or shelved, you want marked; each
hack's `.md` also describes its cost in prose.

## Shelved (all settle at ~0.61×)
- **alienbeacon** — ~200-step canyon ray-march + multi-octave spiral noise + AO/shadow.
- **fluxcore** — ~210-step reactor march + 30-step sun-shadow trace + 3D noise.
- **bubblecolors** — per-pixel ray-march of rising color-banded blobs.
- **rigrekt** — ray-marched box tunnel warped by layered `sin` turbulence.
- **universeball** — ~50-step march with a nested fractal-fold inner loop.
- **bestill** — six scenes, several of them noise-field ray-marches.

(Hacks that hold a *full* 1.00× — e.g. `batteredplanet`, `topologica`,
`selfreflect`, `darktransit` — stayed in the active set.)

## Earlier false alarm (keep in mind)
A *first* shelving pass mis-blamed the shaders for stutter that was actually
environmental — many accumulated browser tabs (each holding a live WebGL
context; browsers thrash past ~16) plus a second 4K monitor. Those hacks were
un-shelved once tested on a clean single tab / single display. **The shelving
above is different**: these genuinely can't hold 60fps at full retina even in a
clean environment; adaptive res keeps them smooth by dropping to ~0.61×.

## Architectural lesson (host integration / harness v2)
The real villain behind the tab-thrash was **one WebGL context per hack** (each
mounts its own overlay canvas + context to dodge the shared 2D canvas's context
lock). The host — and a future harness rev — should **reuse a single GL context**
and swap only the program on switch. The adaptive scaler in `shadertoy.js` is a
backstop, not the fix.

## To revive
Move the files back to `hacks/`, restore the import from `'../shadertoy.js'` to
`'./shadertoy.js'`, and (optionally) set the module's default `config.resolution`
to ~0.65 so it opens at its sustainable scale with no visible ramp-down.
