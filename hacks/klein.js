// klein.js — "Klein Bottle" packaged as a mountable three.js module.
// start(canvas) returns { stop, pause, resume, reinit, getStats, config, params }.
//
// After xscreensaver's klein (Carsten Steger, 2008), hacks/glx/klein.c. This is
// the FIRST geometry-track port and the proving ground for the three.js harness
// (see docs/three-js-harness-plan.md). It reproduces the look from jwz's
// screenshots page: the figure-8 Klein bottle, drawn as TWO-SIDED, SEE-THROUGH
// BANDS.
//
// The whole Carsten Steger surface family (romanboy, projectiveplane,
// etruscanvenus, sphereeversion) shares this same renderer, so the two techniques
// here are the reusable unlock for that entire cluster:
//
//   * Two-sided color (COLORS_TWOSIDED): front faces green, back faces red. The
//     Klein bottle has only one side, so as the surface passes through itself the
//     winding flips and the colors swap — which is exactly how the original lets
//     you SEE that it is non-orientable. We do it with two meshes over one
//     geometry: one THREE.FrontSide (green), one THREE.BackSide (red).
//   * See-through bands (APPEARANCE_BANDS): klein.c skips every other run of
//     strips — `((i & (NUMB-1)) >= NUMB/2)` with NUMB=8, i.e. 4 of every 8, giving
//     16 equal opaque bands + 16 gaps. We reproduce it with an alphaMap stripe +
//     alphaTest (per-fragment discard), so the gaps are truly transparent and you
//     see through to the far side. (Band axis chosen to match the screenshot; see
//     makeBandAlphaMap.)
//
// Deferred (xscreensaver options, not this screenshot's look): the "rotate in 4D"
// / "walk on it" motion, the rainbow & depth color modes, the changing-colors
// animation, and the solid (non-banded) appearance.
//
// Rendering: the (u,v) surface function goes straight into ParametricGeometry;
// the bands and two-sidedness are pure material/mesh config on top.

import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js';
import { startThreeHack } from './three-hack.js';

export const title = 'klein';

export const info = {
  author: 'after Carsten Steger (xscreensaver klein)',
  description: 'A figure-8 Klein bottle drawn as two-sided see-through bands: green outside, red inside — where they meet, you are watching a non-orientable surface pass through itself.',
  year: 2008,
};

// --- Geometry: figure-8 Klein bottle ---------------------------------------
// Verbatim algebra from klein.c (KLEIN_BOTTLE_FIGURE_8), orthographic 4D->3D
// projection (use xyz, drop the w = cu coordinate). u, v range over [0, 2*pi].
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

// klein.c: NUMB=8, draw 4 of every 8 u-strips -> 16 opaque + 16 transparent bands.
const NUM_BANDS = 16;

// A 1-D stripe alphaMap: NUM_BANDS opaque + NUM_BANDS transparent texels,
// alternating and equal-width. Built as a 1 x N texture so the stripe varies
// along V (uv.y) -> bands repeat along v and each band runs along u, the
// orientation that matches jwz's screenshot. (klein.c expresses the same skip on
// its u-loop; the on-screen axis depends on the surface's uv layout, so this is
// the empirical match. Swap to `new DataTexture(data, n, 1, ...)` to rotate the
// bands 90 degrees.) NearestFilter -> hard edges; alphaMap samples the green
// channel, so 255/0 = opaque/transparent under alphaTest.
function makeBandAlphaMap(THREE) {
  const n = NUM_BANDS * 2;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const on = (i % 2) === 0 ? 255 : 0;
    data[i * 4] = on;
    data[i * 4 + 1] = on;   // green channel is the one alphaMap samples
    data[i * 4 + 2] = on;
    data[i * 4 + 3] = on;
  }
  const tex = new THREE.DataTexture(data, 1, n, THREE.RGBAFormat);   // 1 x N -> varies along v
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;   // closed loop, even count -> tiles cleanly
  tex.needsUpdate = true;
  return tex;
}

export function start(canvas) {
  const config = { speed: 1.0 };
  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'fast', live: true },
  ];

  return startThreeHack(canvas, {
    config,
    params,
    init({ THREE, scene, camera, lights }) {
      camera.position.set(0, 0, 7);

      // Even light so both the green and red faces read all the way around; a
      // little directional gradient keeps the 3D form legible. First-pass balance.
      lights.key.intensity = 1.3;
      lights.fill.intensity = 0.85;
      scene.add(new THREE.AmbientLight(0xffffff, 0.45));

      const geo = new ParametricGeometry(figure8, 220, 80);
      geo.computeVertexNormals();

      const alphaMap = makeBandAlphaMap(THREE);

      // Two materials over one geometry: front = green (outside), back = red
      // (inside). alphaTest discards the gap fragments (order-independent, writes
      // depth) so you see through to the far side.
      const common = {
        alphaMap,
        alphaTest: 0.5,
        metalness: 0.1,
        roughness: 0.5,
      };
      const matFront = new THREE.MeshStandardMaterial({ ...common, color: 0x2ecc71, side: THREE.FrontSide });
      const matBack = new THREE.MeshStandardMaterial({ ...common, color: 0xe74c3c, side: THREE.BackSide });

      const group = new THREE.Group();
      group.add(new THREE.Mesh(geo, matFront));
      group.add(new THREE.Mesh(geo, matBack));
      group.scale.setScalar(2.3);
      group.rotation.x = 0.5;
      scene.add(group);

      return { group, alphaMap };
    },
    frame({ group }, { dt }) {
      group.rotation.y += dt * 0.4;
      group.rotation.x += dt * 0.13;
    },
    dispose({ alphaMap }) {
      alphaMap.dispose();   // harness disposes geometry+materials; texture is ours
    },
  });
}
