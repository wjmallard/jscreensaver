# Shelved: three.js-rebuild of the Carsten Steger surfaces

These are **incomplete, not faithful, and must not be shipped or attributed as-is.**

`three-hack.js`, `parametric-surface.js`, and `klein.js` / `romanboy.js` /
`projectiveplane.js` / `etruscanvenus.js` were a first attempt to port Carsten
Steger's xscreensaver surface hacks by **re-deriving** them from scratch in
three.js (a parametric-surface helper + standard materials). It did not reach
fidelity and was shelved 2026-06-26.

## Why it failed

These four are **math-visualization hacks with a combinatorial mode space** —
display (wireframe / surface / transparent) × appearance (solid / bands) × color
(one-sided / two-sided / rainbow / depth) × view (turn / walk-through, where the
camera flies *through* the surface) × projection (4D & 3D, perspective / ortho),
plus a 4D rotation and per-frame deformation. Reproducing any particular look by
re-deriving all of that in three.js is whack-a-mole; our klein and romanboy were
recognizable but clearly knock-offs, not the originals.

## The right way to do these (if revisited)

They are **modern GLSL-shader hacks** — each `.c` embeds full vertex + fragment
shaders. So the faithful port is to **run their actual shaders** and transcribe the
C-side control logic (uniforms, animation, the walk camera, the band index buffer)
to JS — i.e. the same approach as the shadertoy track, extended to vertex shaders.
That reproduces every mode for free because it *is* their code. three.js can host
their shaders via `ShaderMaterial` if desired.

The from-scratch three.js rebuild remains appropriate for **fixed-function**
geometry hacks (pipes, gears, cubes, cubicgrid, …) that have no embedded shaders.

Kept here for reference only.
