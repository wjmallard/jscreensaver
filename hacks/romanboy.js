// romanboy.js — "Roman/Boy Surface" packaged as a mountable three.js module.
// start(canvas) returns { stop, pause, resume, reinit, getStats, config, params }.
//
// After xscreensaver's romanboy (Carsten Steger, 2014), hacks/glx/romanboy.c. An
// immersion of the real projective plane that morphs between the Roman surface and
// Boy's surface. Same Steger family as klein, so it uses the shared
// ./parametric-surface.js recipe (two-sided green/red, see-through bands).
//
// Deferred for v1 (matching how klein deferred its 4D motion): the Roman<->Boy
// MORPH is a time-varying deformation D in the surface formula, so animating it
// means recomputing the geometry each frame. Here D is fixed at 1.0 (Boy end) and
// the shape just spins. Also deferred: the rainbow/depth color modes and the
// solid (non-banded) appearance.

import { startParametricSurface } from './parametric-surface.js';

export const title = 'romanboy';

export const info = {
  author: 'after Carsten Steger (xscreensaver romanboy)',
  description: "An immersion of the real projective plane (Boy's surface), drawn as two-sided see-through bands.",
  year: 2014,
};

// Verbatim algebra from romanboy.c's vertex shader. Constants, with the default
// surface order g = 3 (DEF_SURFACE_ORDER):
//   sqrt2og = sqrt(2)/g,  h1m1og = 0.5*(1 - 1/g),  gm1 = g - 1
// D is the deformation (Roman<->Boy morph); fixed here. u, v range over [0, 2*pi].
// NOTE: cv2 = cos(v)^2 here (NOT cos(v/2) as in klein) — transcribe verbatim.
const TAU = Math.PI * 2;
const G = 3.0;
const GM1 = G - 1.0;                 // 2
const SQRT2OG = Math.SQRT2 / G;      // sqrt(2)/3
const H1M1OG = 0.5 * (1.0 - 1.0 / G); // 1/3
const D = 1.0;                        // deformation (morph); 0 = Roman end, 1 = Boy end

function boySurface(u01, v01, target) {
  const u = u01 * TAU;
  const v = v01 * TAU;
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const sgu = Math.sin(G * u);
  const cgm1u = Math.cos(GM1 * u);
  const sgm1u = Math.sin(GM1 * u);
  const c2v = Math.cos(2.0 * v);   // (unused in position, kept for parity/readability)
  const s2v = Math.sin(2.0 * v);
  const cv = Math.cos(v);
  const cv2 = cv * cv;             // cos^2(v)
  const nomx = SQRT2OG * cv2 * cgm1u + H1M1OG * s2v * cu;
  const nomy = SQRT2OG * cv2 * sgm1u - H1M1OG * s2v * su;
  const den = 1.0 / (1.0 - 0.5 * Math.SQRT2 * D * s2v * sgu);
  target.set(nomx * den, nomy * den, cv2 * den);
}

export function start(canvas) {
  const config = { speed: 1.0 };
  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'fast', live: true },
  ];

  return startParametricSurface(canvas, {
    surface: boySurface,
    slices: 192,        // u carries cos(3u)/cos(2u) detail (g=3) -> 3 x base subdivision
    stacks: 128,
    bands: 16,          // romanboy.c NUMB=8 -> 16 opaque + 16 gaps
    bandAxis: 'v',      // by eye; flip to 'u' if rotated 90 degrees vs the original
    scale: 1.3,
    cameraZ: 8,
    config,
    params,
  });
}
