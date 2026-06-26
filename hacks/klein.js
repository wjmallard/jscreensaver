// klein.js — "Klein Bottle" packaged as a mountable three.js module.
// start(canvas) returns { stop, pause, resume, reinit, getStats, config, params }.
//
// After xscreensaver's klein (Carsten Steger, 2008), hacks/glx/klein.c. The first
// geometry-track port and the proving ground for the three.js harness + the
// shared ./parametric-surface.js recipe (two-sided, see-through bands). It
// reproduces the look from jwz's screenshots page: a figure-8 Klein bottle, green
// outside / red inside, banded so you can see through to the far surface — where
// the colors meet, you are watching a non-orientable surface pass through itself.
//
// Deferred (xscreensaver options, not this screenshot's look): the "rotate in 4D"
// / "walk on it" motion, the rainbow & depth color modes, the changing-colors
// animation, and the solid (non-banded) appearance.

import { startParametricSurface } from './parametric-surface.js';

export const title = 'klein';

export const info = {
  author: 'after Carsten Steger (xscreensaver klein)',
  description: 'A figure-8 Klein bottle drawn as two-sided see-through bands: green outside, red inside — where they meet, you are watching a non-orientable surface pass through itself.',
  year: 2008,
};

// Verbatim algebra from klein.c (KLEIN_BOTTLE_FIGURE_8), orthographic 4D->3D
// projection (use xyz, drop the w = cos(u) coordinate). u, v range over [0, 2*pi].
// Note cv2/sv2 here are cos/sin of v/2 (the half-angle twist that closes the
// bottle); do not confuse with romanboy's cv2 = cos^2(v).
const TAU = Math.PI * 2;
const R = 2.0;            // FIGURE_8_RADIUS
const NORM = 1 / 3.25;    // 1 / (FIGURE_8_RADIUS + RADIUS_INCR)

function figure8(u01, v01, target) {
  const u = u01 * TAU;
  const v = v01 * TAU;
  const su = Math.sin(u);
  const s2u = Math.sin(2 * u);
  const cv = Math.cos(v);
  const sv = Math.sin(v);
  const cv2 = Math.cos(0.5 * v);
  const sv2 = Math.sin(0.5 * v);
  const radial = su * cv2 - s2u * sv2 + R;
  target.set(
    radial * cv * NORM,
    radial * sv * NORM,
    (su * sv2 + s2u * cv2) * NORM,
  );
}

export function start(canvas) {
  const config = { speed: 1.0 };
  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'fast', live: true },
  ];

  return startParametricSurface(canvas, {
    surface: figure8,
    slices: 220,        // u carries the sin(2u) detail -> higher subdivision
    stacks: 80,
    bands: 16,          // klein.c NUMB=8 -> 4 of every 8 strips -> 16 opaque + 16 gaps
    bandAxis: 'v',
    config,
    params,
  });
}
