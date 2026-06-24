// klein.js — "Klein Bottle" packaged as a mountable three.js module.
// start(canvas) returns { stop, pause, resume, reinit, getStats, config, params }.
//
// After xscreensaver's klein (Carsten Steger, 2008), hacks/glx/klein.c. The first
// geometry-track port; uses the shared ./parametric-surface.js recipe (two-sided,
// see-through bands).
//
// klein.c has THREE 4D Klein-bottle immersions (figure-8, pinched-torus, Lawson)
// and picks one at random. We render the PINCHED TORUS: the classic "a torus that
// everts and reconnects through an inelegant 3D self-intersection" view. The
// dropped 4th coordinate is W = sin(u)*sin(v/2), which is MAXIMAL at the pinch
// (v = pi) — so in 4D the surface separates cleanly there and the 3D pass-through
// is just its shadow. (The figure-8 immersion, our first try, has a two-lobe
// cross-section that reads as "two linked torus turns" — not the look here.)
//
// The "rotate in 4D" motion is now ON (a Z-W rotation via approach-A dynamic
// recompute): it cycles the dropped 4th coordinate into view, so the pinch opens
// and recloses as it turns. Still deferred: the "walk on it" mode, the rainbow &
// depth color modes, the changing-colors animation, and the solid appearance.

import { startParametricSurface } from './parametric-surface.js';

export const title = 'klein';

export const info = {
  author: 'after Carsten Steger (xscreensaver klein)',
  description: 'A Klein bottle as a pinched torus: a torus that everts and reconnects through a 3D self-intersection. Drawn two-sided (green outside, red inside) with see-through bands.',
  year: 2008,
};

// Verbatim from klein.c (KLEIN_BOTTLE_PINCHED_TORUS), orthographic 4D->3D
// projection (use xyz, drop w = su*sv2). u, v range over [0, 2*pi].
//   xx = ( (PTR+cos u)*cos v, (PTR+cos u)*sin v, sin u * cos(v/2), sin u * sin(v/2) )
//        / (PTR + RADIUS_INCR)
// cos(v/2) shrinks the tube to a flat line at v = pi (the pinch) and inverts it
// past there, so the torus everts once per loop.
const TAU = Math.PI * 2;
const PTR = 2.0;          // PINCHED_TORUS_RADIUS
const NORM = 1 / 3.25;    // 1 / (PINCHED_TORUS_RADIUS + RADIUS_INCR)
const ROT4D = 0.4;        // 4D rotation rate (rad/sec): cycles W into view, opening the pinch

function pinchedTorus(u01, v01, target, t) {
  const u = u01 * TAU;
  const v = v01 * TAU;
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const cv = Math.cos(v);
  const sv = Math.sin(v);
  const cv2 = Math.cos(0.5 * v);
  const sv2 = Math.sin(0.5 * v);
  const r = PTR + cu;
  // Full 4D coordinates: W = sin(u)*sin(v/2) is maximal at the pinch (v = pi).
  const X = r * cv;
  const Y = r * sv;
  const Z = su * cv2;
  const W = su * sv2;
  // Rotate in the Z-W plane: at t = 0 we drop W (the flat self-intersecting view);
  // as it turns, W lifts into Z and the pinch separates the way it does in 4D.
  const th = ROT4D * t;
  const Zr = Z * Math.cos(th) - W * Math.sin(th);
  target.set(X * NORM, Y * NORM, Zr * NORM);
}

export function start(canvas) {
  const config = { speed: 1.0 };
  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'fast', live: true },
  ];

  return startParametricSurface(canvas, {
    surface: pinchedTorus,
    dynamic: true,      // animate the 4D (Z-W) rotation
    slices: 128,        // u = around the tube
    stacks: 200,        // v = around the loop; extra resolution for a smooth pinch
    bands: 16,          // klein.c NUMB=8 -> 16 opaque + 16 gaps
    bandAxis: 'v',      // by eye; flip to 'u' if rotated 90 degrees vs the original
    scale: 2.3,
    cameraZ: 7,
    config,
    params,
  });
}
