// romanboy.js — "Roman/Boy Surface" packaged as a mountable three.js module.
// start(canvas) returns { stop, pause, resume, reinit, getStats, config, params }.
//
// After xscreensaver's romanboy (Carsten Steger, 2014), hacks/glx/romanboy.c. An
// immersion of the real projective plane that morphs between the Roman surface and
// Boy's surface. Same Steger family as klein, on the shared
// ./parametric-surface.js recipe. Per the original's demo this one is ONE-SIDED
// (the same color on both faces) with see-through bands — so the band gaps reveal
// the same-colored far surface / background instead of a contrasting back color.
//
// The Roman<->Boy MORPH is now animated via approach-A dynamic recompute: the
// deformation D oscillates 0<->1 with time and the surface is re-evaluated each
// frame. Still deferred: the rainbow/depth color modes and the solid (non-banded)
// appearance.

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
// D (deformation) morphs the Roman surface (D=0) into Boy's surface (D=1); we
// oscillate it smoothly with elapsed time t.
const MORPH_RATE = 0.4;   // rad/sec; D goes 0 -> 1 -> 0 every ~2*pi/MORPH_RATE seconds

function boySurface(u01, v01, target, t) {
  const D = 0.5 - 0.5 * Math.cos(MORPH_RATE * t);
  const u = u01 * TAU;
  const v = v01 * TAU;
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const sgu = Math.sin(G * u);
  const cgm1u = Math.cos(GM1 * u);
  const sgm1u = Math.sin(GM1 * u);
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
    dynamic: true,      // animate the Roman<->Boy morph (per-frame recompute)
    slices: 192,        // u carries cos(3u)/cos(2u) detail (g=3) -> 3 x base subdivision
    stacks: 128,
    bands: 24,          // romanboy.c: g*NUMU/NUMB = 3*64/8 = 24 bands (narrower than klein's 16)
    bandAxis: 'v',      // by eye; flip to 'u' if rotated 90 degrees vs the original
    twoSided: false,    // original demo: same color both faces
    cullBack: true,     // FrontSide so the band gaps show background (visible "invisible bands")
    scale: 1.3,
    cameraZ: 8,
    config,
    params,
  });
}
