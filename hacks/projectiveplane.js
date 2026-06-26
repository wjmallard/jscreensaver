// projectiveplane.js — "Projective Plane" packaged as a mountable three.js module.
// start(canvas) returns { stop, pause, resume, reinit, getStats, config, params }.
//
// After xscreensaver's projectiveplane (Carsten Steger, 2014),
// hacks/glx/projectiveplane.c. The real projective plane embedded in 4D and
// projected to 3D. Same Steger family as klein, so it uses the shared
// ./parametric-surface.js recipe (two-sided green/red, see-through bands).
//
// There is no morph here — the only animation in the original is a rotation in 4D,
// which (as with klein) is DEFERRED for v1. We use the orthographic 4D->3D
// projection (take xyz, drop w); the perspective projection divides by w, which
// passes through zero on this surface and would spike the mesh, so ortho is the
// safe choice. Also deferred: rainbow/depth colors, the solid appearance.

import { startParametricSurface } from './parametric-surface.js';

export const title = 'projectiveplane';

export const info = {
  author: 'after Carsten Steger (xscreensaver projectiveplane)',
  description: 'The real projective plane embedded in 4D and projected to 3D, drawn as two-sided see-through bands.',
  year: 2014,
};

// Verbatim from projectiveplane.c's vertex shader (the xx vec4), orthographic
// 4D->3D (use xyz, drop w = 0.5*(su*su*sv4*sv4 - cv4*cv4)). u, v range [0, 2*pi].
const TAU = Math.PI * 2;

function projectivePlane(u01, v01, target) {
  const u = u01 * TAU;
  const v = v01 * TAU;
  const su = Math.sin(u);
  const cu = Math.cos(u);
  const s2u = Math.sin(2.0 * u);
  const sv2 = Math.sin(0.5 * v);
  const sv4 = Math.sin(0.25 * v);
  target.set(
    0.5 * s2u * sv4 * sv4,
    0.5 * su * sv2,
    0.5 * cu * sv2,
  );
}

export function start(canvas) {
  const config = { speed: 1.0 };
  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'fast', live: true },
  ];

  return startParametricSurface(canvas, {
    surface: projectivePlane,
    slices: 128,
    stacks: 128,
    bands: 16,          // projectiveplane.c NUMB=8 -> 16 opaque + 16 gaps
    bandAxis: 'v',      // by eye; flip to 'u' if rotated 90 degrees vs the original
    scale: 4.5,         // surface extent is small (<= 0.5), so scale up to frame it
    cameraZ: 7,
    config,
    params,
  });
}
