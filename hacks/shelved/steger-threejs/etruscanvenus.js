// etruscanvenus.js — "Etruscan Venus" packaged as a mountable three.js module.
// start(canvas) returns { stop, pause, resume, reinit, getStats, config, params }.
//
// After xscreensaver's etruscanvenus (Carsten Steger, 2014),
// hacks/glx/etruscanvenus.c. Another immersion of the real projective plane, part
// of a family the original morphs through (Roman / Boy / Steiner / Etruscan
// Venus). Same Steger family as klein, on the shared ./parametric-surface.js
// recipe. Per the original's demo this one is drawn SOLID (no bands) and
// one-sided (a single surface seen from every angle) — no transparency.
//
// Deferred for v1 (as with romanboy's morph and klein's 4D spin): the deformation
// is a time-varying phase dd in [0,4) that walks two smootherstep weights (DB, DL)
// around the corners of the family. We FREEZE it at the original's default init
// frame dd = 0 (DB = DL = 0). Change DD below to 1/2/3 to sit on a different
// family member. Also deferred: rainbow/depth colors, the solid appearance.

import { startParametricSurface } from './parametric-surface.js';

export const title = 'etruscanvenus';

export const info = {
  author: 'after Carsten Steger (xscreensaver etruscanvenus)',
  description: 'An immersion of the real projective plane from the Etruscan Venus family, drawn as two-sided see-through bands.',
  year: 2014,
};

const TAU = Math.PI * 2;

// Deform phase, verbatim from etruscanvenus.c: dd in [0,4) walks (bb,ll) around
// the unit square; DB,DL are smootherstep(6t^5-15t^4+10t^3) of those. dd = 0 is
// the original's init frame (DB = DL = 0). Computed once at module load.
const DD = 0.0;
function smootherstep(t) {
  return ((6.0 * t - 15.0) * t + 10.0) * t * t * t;
}
let _bb;
let _ll;
if (DD < 1.0) { _bb = 0.0; _ll = DD; }
else if (DD < 2.0) { _bb = DD - 1.0; _ll = 1.0; }
else if (DD < 3.0) { _bb = 1.0; _ll = 3.0 - DD; }
else { _bb = 4.0 - DD; _ll = 0.0; }
const DB = smootherstep(_bb);
const DL = smootherstep(_ll);
const BOSQRT2 = DB / Math.SQRT2;

// Verbatim from etruscanvenus.c's vertex shader (the f * vec3(fx,fy,fz) position).
// u, v range over [0, 2*pi]. At DD = 0 this reduces to f = 1, x = (fx,fy,fz).
function etruscanVenus(u01, v01, target) {
  const u = u01 * TAU;
  const v = v01 * TAU;
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const c2u = Math.cos(2.0 * u);
  const s2u = Math.sin(2.0 * u);
  const s3u = Math.sin(3.0 * u);
  const cv = Math.cos(v);
  const sv = Math.sin(v);
  const s2v = Math.sin(2.0 * v);
  const nom = 1.0 - DL + DL * cv;
  const den = 1.0 - BOSQRT2 * s3u * s2v;
  const f = nom / den;
  const fx = c2u * cv + cu * sv;
  const fy = s2u * cv - su * sv;
  const fz = Math.SQRT2 * cv;
  target.set(f * fx, f * fy, f * fz);
}

export function start(canvas) {
  const config = { speed: 1.0 };
  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'fast', live: true },
  ];

  return startParametricSurface(canvas, {
    surface: etruscanVenus,
    slices: 192,        // u carries cos(3u)/sin(3u) detail -> higher subdivision
    stacks: 128,
    bands: 0,           // original demo: solid (no see-through bands)
    twoSided: false,    // single surface, same color from every angle
    scale: 1.4,
    cameraZ: 7,
    config,
    params,
  });
}
