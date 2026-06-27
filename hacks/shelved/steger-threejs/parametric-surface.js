// parametric-surface.js — shared recipe for Carsten Steger's surface family
// (klein, romanboy, projectiveplane, etruscanvenus, ...). Those hacks all render
// a parametric (u,v) surface the same way: TWO-SIDED (front and back faces in
// different colors, which on a non-orientable surface reveals where it passes
// through itself) drawn as SEE-THROUGH BANDS (alternating opaque/transparent
// strips). A port supplies just the surface function and a few options; this
// builds the geometry, the band alphaMap, and the two-mesh two-sided setup on top
// of ./three-hack.js. See docs/three-js-harness-plan.md.
//
//   startParametricSurface(hostCanvas, {
//     surface(u01, v01, target, t),// REQUIRED: fill target (THREE.Vector3) for u,v in [0,1];
//                                 //   optional 4th arg t = elapsed seconds, for dynamic hacks
//     dynamic,                    // true: recompute the surface every frame so a time-varying
//                                 //   surface (morph / 4D rotation) animates (def false)
//     slices, stacks,             // ParametricGeometry subdivisions (def 160 x 80)
//     bands,                      // opaque band count (def 16); 0 = solid surface
//     bandAxis,                   // 'u' | 'v' — which way the bands repeat (def 'v')
//     twoSided,                   // true: front/back different colors (def);
//                                 //   false: one color (single mesh)
//     cullBack,                   // one-sided only: true = FrontSide (band gaps show
//                                 //   the background, not the same-colored far surface);
//                                 //   false = DoubleSide (def, good for solid surfaces)
//     colorFront, colorBack,      // hex (def green / red); one-sided uses colorFront
//     roughness, metalness,       // material (def 0.5 / 0.1)
//     scale, cameraZ, tilt,       // framing (def 2.3 / 7 / 0.5 rad)
//     spinX, spinY,               // idle rotation, rad/sec (def 0.13 / 0.4)
//     key, fill, ambient,         // light intensities (def 1.3 / 0.85 / 0.45)
//     config, params,             // passed through to the handle
//   }) -> { stop, pause, resume, reinit, getStats, config, params }

import { ParametricGeometry } from 'three/addons/geometries/ParametricGeometry.js';
import { startThreeHack } from './three-hack.js';

// Stripe alphaMap: `bands` opaque + `bands` transparent texels, equal-width,
// alternating. Built 1 x N to vary along v (bands repeat along v, run along u) or
// N x 1 to vary along u. NearestFilter -> hard edges; alphaMap samples the green
// channel, so 255/0 = opaque/transparent under alphaTest. The on-screen band axis
// depends on the surface's uv layout, so 'u'/'v' is chosen by eye per hack.
function makeBandAlphaMap(THREE, bands, axis) {
  const n = bands * 2;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const on = (i % 2) === 0 ? 255 : 0;
    data[i * 4] = on;
    data[i * 4 + 1] = on;   // green channel is the one alphaMap samples
    data[i * 4 + 2] = on;
    data[i * 4 + 3] = on;
  }
  const tex = axis === 'u'
    ? new THREE.DataTexture(data, n, 1, THREE.RGBAFormat)
    : new THREE.DataTexture(data, 1, n, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

export function startParametricSurface(hostCanvas, opts) {
  const {
    surface,
    slices = 160,
    stacks = 80,
    bands = 16,
    bandAxis = 'v',
    twoSided = true,
    cullBack = false,
    dynamic = false,
    colorFront = 0x2ecc71,
    colorBack = 0xe74c3c,
    roughness = 0.5,
    metalness = 0.1,
    scale = 2.3,
    cameraZ = 7,
    tilt = 0.5,
    spinX = 0.13,
    spinY = 0.4,
    key = 1.3,
    fill = 0.85,
    ambient = 0.45,
    config = { speed: 1.0 },
    params,
  } = opts;

  return startThreeHack(hostCanvas, {
    config,
    params,
    init({ THREE, scene, camera, lights }) {
      camera.position.set(0, 0, cameraZ);
      lights.key.intensity = key;
      lights.fill.intensity = fill;
      if (ambient > 0) scene.add(new THREE.AmbientLight(0xffffff, ambient));

      // Build at morph-time t=0; the surface fn's optional 4th arg lets dynamic
      // hacks deform per-frame (static hacks ignore it).
      const geo = new ParametricGeometry((u, v, tgt) => surface(u, v, tgt, 0), slices, stacks);
      geo.computeVertexNormals();

      // Bands: a stripe alphaMap + alphaTest discards the gap fragments
      // (order-independent, writes depth) so they are genuinely transparent.
      const alphaMap = bands > 0 ? makeBandAlphaMap(THREE, bands, bandAxis) : null;
      const common = { roughness, metalness };
      if (alphaMap) { common.alphaMap = alphaMap; common.alphaTest = 0.5; }

      // Color: two-sided draws front/back in different colors (two meshes over one
      // geometry — reveals where a non-orientable surface passes through itself).
      // One-sided draws the same color on both faces (a single DoubleSide mesh), so
      // band gaps reveal only the same-colored far surface / background, not a
      // contrasting back color.
      const group = new THREE.Group();
      if (twoSided) {
        group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ ...common, color: colorFront, side: THREE.FrontSide })));
        group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ ...common, color: colorBack, side: THREE.BackSide })));
      } else {
        // One-sided: cullBack -> FrontSide so band gaps reveal the background
        // (clearly visible bands) rather than the same-colored far surface.
        const oneSide = cullBack ? THREE.FrontSide : THREE.DoubleSide;
        group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ ...common, color: colorFront, side: oneSide })));
      }
      group.scale.setScalar(scale);
      group.rotation.x = tilt;
      scene.add(group);

      const state = { group, alphaMap, spinX, spinY };
      if (dynamic) {
        // Approach A: re-evaluate vertex positions from the stored (u,v) grid at
        // the current time each frame, then rebuild normals. Fine at these vertex
        // counts (~25k) on a modern machine.
        state.dynamic = true;
        state.geo = geo;
        state.uv = geo.attributes.uv;
        state.pos = geo.attributes.position;
        state.tmp = new THREE.Vector3();
        state.surface = surface;
      }
      return state;
    },
    frame(state, { dt, elapsed }) {
      if (state.dynamic) {
        const { uv, pos, tmp, surface: fn } = state;
        for (let k = 0; k < uv.count; k++) {
          fn(uv.getX(k), uv.getY(k), tmp, elapsed);
          pos.setXYZ(k, tmp.x, tmp.y, tmp.z);
        }
        pos.needsUpdate = true;
        state.geo.computeVertexNormals();
      }
      state.group.rotation.y += dt * state.spinY;
      state.group.rotation.x += dt * state.spinX;
    },
    dispose(state) {
      state.alphaMap?.dispose();   // harness disposes geometry + materials; texture is ours
    },
  });
}
