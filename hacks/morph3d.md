# morph3d -- design notes

Web port of xscreensaver's `morph3d` (Marcelo Vianna, 1997),
`xscreensaver-6.15/hacks/glx/morph3d.c`. One platonic solid (tetra/cube/octa/dodeca/
icosa, chosen at init by `count` or random) whose faces pulse: each face is a
tessellated grid that is radially displaced by a "spike" factor oscillating with
`sin(step)` -- bulging out into a rounded blob, then collapsing through itself into long
spikes ("Platonic solids that turn inside out and get spikey", the Windows "Flower Box"
effect). The solid tumbles fast on three axes and wanders. Self-contained three.js:
`start(canvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }`.
**Asset-free.** Does NOT share involute.js (no gears here).

## Faithfulness (the rule: do NOT deviate from the algorithm)

Transcribed from `morph3d.c`:

- **The TRIANGLE / SQUARE / PENTAGON macros, line-for-line:** the incremental (TRIANGLE/
  SQUARE) or per-Ti recomputed (PENTAGON) vertex walk; the displacement
  `Factor = 1 - (r^2 * Amp / Vr^2)` applied to BOTH the in-plane position and the face
  height `Zf`; and the per-vertex **finite-difference normals** (cross of two `+0.001`
  neighbor edges of the *displaced* surface). All recomputed EVERY FRAME because
  `Amp = seno` changes -- so this is a dynamic morph, not static geometry. `VisibleSpikes
  = (last Factor < 0)`.
- **Per-solid face placement:** each solid's faces are identical geometry placed by a
  sequence of `glRotatef`/`glPushMatrix`/`glPopMatrix` (draw_tetra/cube/octa/dodeca/
  icosa). Transcribed as op-lists (`'push'`/`'pop'`/`'face'`/`[deg,ax,ay,az]`) and
  replayed on a matrix stack to get the per-face transform + color. So ONE morphed face
  is rebuilt per frame and instanced N times (4/6/8/12/20 meshes sharing one geometry,
  each with its color + transform).
- `seno = (sin(step) + 1/3) * (4/5) * Magnitude`; the per-solid Edge / Z / divisions /
  Magnitude / the saturated Material* palette.
- **draw_morph3d modelview:** `T(0,0,-10)`, `Scale(0.3*H/W, 0.3, 0.3)`, `T(wander =
  2.5*(W/H)*sin(step*1.11), 2.5*cos(step*1.25*1.11), 0)`, portrait-fit, `Rotate(step*100
  X, step*95 Y, step*90 Z)`; `step += 0.05`/frame. Projection `glFrustum(-1,1,-1,1,5,15)`
  (a SQUARE frustum; aspect is handled by the model X-scale `0.3*H/W`, exactly as the .c
  does, via `Matrix4.makePerspective`).
- **Lighting:** TWO white directional lights from `(1,1,1)` and `(-1,-1,1)` (intensity PI
  each, summed as in GL); a global ambient (`lmodel_ambient 0.5` * the default material
  ambient `0.2` = a flat gray `0.1`, modeled as `material.emissive` since it is gray, NOT
  diffuse-tinted); TWO-SIDED lighting + the spikes-disable-cull behavior, both covered by
  `THREE.DoubleSide`. Specular: GL `front_specular` is `0.7` gray @ shininess 60, but only
  LIGHT0 has a (default-white) specular -- **LIGHT1's specular DEFAULTS TO BLACK**, so the
  original shows ONE soft highlight. three has no per-light specular (both lights would
  spec) and `intensity=PI` over-amplifies it, so the material specular is dimmed to `0.1`
  gray (a gentle sheen, not two saturated white spots). [Dimmed 2026-06-28.]

Verified by CDP capture vs `morph3d.jpg`: the tetra morphs correctly between a bulged
3-point star (medium amplitude) and thin radiating spikes off a central blob (high
amplitude), smooth-shaded, tumbling, in the tetra palette -- matching the ground truth's
spike phase. (Winding is irrelevant here -- DoubleSide + explicit per-vertex normals.)

## Notes

- In xscreensaver (standalone) the object is FIXED per run -- it morphs the FACES of one
  solid; it does not cycle between solids (that's the xlock `change` hook, mouse-only).
  Faithful: `count` 0 = random 1-5, else the chosen solid.
- Pacing model as in gears.js / dangerball (`effFps = 1e6/(delay+OVERHEAD)`, `OVERHEAD =
  37500`; xml default delay 40000 -> ~13fps; `step` advances `0.05 * frames`).
- Config from `hacks/config/morph3d.xml`: `delay` (0-100000, def 40000) + `object`
  (the .xml `select`; exposed here as a 0-5 range, 0=random, rebuilds on change).

See also: `gears.md`, `dangerball.md`; the `glx-geometry-track-triage` memory.
