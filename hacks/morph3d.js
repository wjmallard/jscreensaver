// morph3d.js -- "Morph 3D" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's morph3d (Marcelo Vianna, 1997),
// hacks/glx/morph3d.c. One platonic solid (tetra/cube/octa/dodeca/icosa, chosen at
// init) whose faces pulse: each face is a tessellated grid radially displaced by a
// "spike" factor that oscillates with sin(step) -- bulging out into a rounded blob,
// then collapsing through itself into spikes ("turn inside out and get spikey", the
// Windows "Flower Box" effect). The solid tumbles fast on three axes and wanders.
//
// Self-contained three.js (own overlay canvas + renderer + loop), like gears.js /
// dangerball.js. RNG is the shared yarandom.js. No assets.
//
// FAITHFUL TO morph3d.c -- "do not deviate from the algorithm":
//   * The TRIANGLE / SQUARE / PENTAGON tessellation macros are transcribed
//     line-for-line: the incremental (or per-Ti recomputed) vertex walk, the
//     displacement Factor = 1 - (r^2 * Amp / Vr^2) applied to BOTH the in-plane
//     position and the face's height Zf, and the per-vertex FINITE-DIFFERENCE
//     normals (cross of two +0.001 neighbor edges of the *displaced* surface) --
//     recomputed EVERY FRAME because Amp = seno changes. VisibleSpikes = (last
//     Factor < 0).
//   * Each solid's faces are identical geometry placed by a sequence of glRotatef /
//     glPushMatrix / glPopMatrix (draw_tetra/cube/octa/dodeca/icosa) -- transcribed
//     as op-lists and replayed on a matrix stack to get the per-face transform +
//     color. So ONE morphed face is rebuilt per frame and instanced N times.
//   * seno = (sin(step) + 1/3) * (4/5) * Magnitude; the per-solid Edge/Z/divisions/
//     Magnitude/colors; the saturated Material* palette.
//   * draw_morph3d modelview: T(0,0,-10), Scale(0.3*H/W, 0.3, 0.3), T(wander),
//     portrait-fit, Rotate(step*100 X, step*95 Y, step*90 Z); step += 0.05/frame.
//     Projection glFrustum(-1,1,-1,1,5,15).
//   * lighting: TWO white directional lights from (1,1,1) and (-1,-1,1), each
//     ambient 0; a global ambient (lmodel_ambient 0.5 * default material ambient
//     0.2 = a flat gray 0.1, modeled as material.emissive); TWO-SIDED lighting +
//     spikes-disable-cull (THREE.DoubleSide); specular 0.7 gray, shininess 60.
//
// Winding doesn't matter here (DoubleSide + explicit per-vertex normals). Color
// management / pacing as in gears.js / dangerball (colour management OFF -> raw colors; effFps).

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding). Disable three's color management so the
// port matches GL: colors are used raw (setRGB(..., SRGBColorSpace) becomes a no-op) and
// the output is not sRGB-encoded. Without this, lit/shaded faces render up to ~2.5x too
// bright (measured vs the rubikblocks grayscale ground truth).
THREE.ColorManagement.enabled = false;

export const title = 'morph3d';

export const info = {
  author: 'Marcelo Vianna',
  year: 1997,
  description: 'Platonic solids that turn inside out and get spikey.\n\nhttps://en.wikipedia.org/wiki/Platonic_solid',
};

// ---- constants (morph3d.c #defines) ----
const Pi = Math.PI;
const SQRT2 = 1.4142135623730951455;
const SQRT3 = 1.7320508075688771932;
const SQRT5 = 2.2360679774997898051;
const SQRT6 = 2.4494897427831778813;
const SQRT15 = 3.8729833462074170214;
const S3H = SQRT3 / 2;
const cossec36_2 = 0.8506508083520399322;
const cos72 = 0.3090169943749474241, sin72 = 0.9510565162951535721;
const cos36 = 0.8090169943749474241, sin36 = 0.5877852522924731292;
const TA = 109.47122063449069174;   // tetraangle / octaangle
const CA = 90.0;                     // cubeangle
const DA = 63.434948822922009981;    // dodecaangle
const IA = 41.810314895778596167;    // icoangle
const TAU = (SQRT5 + 1) / 2;

// Material* palette (the saturated GL diffuse colors).
const R = [0.7, 0.0, 0.0], G = [0.1, 0.5, 0.2], B = [0.0, 0.0, 0.7], C = [0.2, 0.5, 0.7];
const Y = [0.7, 0.7, 0.0], M = [0.6, 0.2, 0.5], W = [0.7, 0.7, 0.7], GRY = [0.5, 0.5, 0.5];

// Per-solid face transform op-lists ('push'/'pop'/'face'/[deg,ax,ay,az]) +
// colors + tessellation params -- transcribed from draw_*/pinit.
const SOLIDS = {
  1: { // tetra
    type: 'tri', edge: 2, z: 0.5 / SQRT6, div: 23, mag: 2.5, colors: [R, G, B, W],
    ops: ['face',
      'push', [180, 0, 0, 1], [-TA, 1, 0, 0], 'face', 'pop',
      'push', [180, 0, 1, 0], [-180 + TA, 0.5, S3H, 0], 'face', 'pop',
      [180, 0, 1, 0], [-180 + TA, 0.5, -S3H, 0], 'face'],
  },
  2: { // cube
    type: 'square', edge: 2, z: 0.5, div: 20, mag: 2.0, colors: [R, G, C, M, Y, B],
    ops: ['face',
      [CA, 1, 0, 0], 'face', [CA, 1, 0, 0], 'face', [CA, 1, 0, 0], 'face',
      [CA, 0, 1, 0], 'face', [2 * CA, 0, 1, 0], 'face'],
  },
  3: { // octa
    type: 'tri', edge: 2, z: 1 / SQRT6, div: 21, mag: 2.5, colors: [R, G, B, W, C, M, GRY, Y],
    ops: ['face',
      'push', [180, 0, 0, 1], [-180 + TA, 1, 0, 0], 'face', 'pop',
      'push', [180, 0, 1, 0], [-TA, 0.5, S3H, 0], 'face', 'pop',
      'push', [180, 0, 1, 0], [-TA, 0.5, -S3H, 0], 'face', 'pop',
      [180, 1, 0, 0], 'face',
      'push', [180, 0, 0, 1], [-180 + TA, 1, 0, 0], 'face', 'pop',
      'push', [180, 0, 1, 0], [-TA, 0.5, S3H, 0], 'face', 'pop',
      [180, 0, 1, 0], [-TA, 0.5, -S3H, 0], 'face'],
  },
  4: { // dodeca
    type: 'pent', edge: 1, z: TAU * TAU * Math.sqrt((TAU + 2) / 5) / 2, div: 10, mag: 2.0,
    colors: [R, G, C, B, M, Y, G, C, R, M, B, Y],
    ops: ['face',
      'push', [180, 0, 0, 1],
      'push', [-DA, 1, 0, 0], 'face', 'pop',
      'push', [-DA, cos72, sin72, 0], 'face', 'pop',
      'push', [-DA, cos72, -sin72, 0], 'face', 'pop',
      'push', [DA, cos36, -sin36, 0], 'face', 'pop',
      [DA, cos36, sin36, 0], 'face',
      'pop',
      [180, 1, 0, 0], 'face',
      [180, 0, 0, 1],
      'push', [-DA, 1, 0, 0], 'face', 'pop',
      'push', [-DA, cos72, sin72, 0], 'face', 'pop',
      'push', [-DA, cos72, -sin72, 0], 'face', 'pop',
      'push', [DA, cos36, -sin36, 0], 'face', 'pop',
      [DA, cos36, sin36, 0], 'face'],
  },
  5: { // icosa
    type: 'tri', edge: 1.5, z: (3 * SQRT3 + SQRT15) / 12, div: 15, mag: 2.5,
    colors: [R, G, B, C, Y, M, R, G, B, W, C, Y, M, R, G, B, C, Y, M, GRY],
    ops: ['face',
      'push',
      'push', [180, 0, 0, 1], [-IA, 1, 0, 0], 'face',
      'push', [180, 0, 1, 0], [-180 + IA, 0.5, S3H, 0], 'face', 'pop',
      [180, 0, 1, 0], [-180 + IA, 0.5, -S3H, 0], 'face',
      'pop',
      'push', [180, 0, 1, 0], [-180 + IA, 0.5, S3H, 0], 'face',
      'push', [180, 0, 1, 0], [-180 + IA, 0.5, S3H, 0], 'face', 'pop',
      [180, 0, 0, 1], [-IA, 1, 0, 0], 'face',
      'pop',
      [180, 0, 1, 0], [-180 + IA, 0.5, -S3H, 0], 'face',
      'push', [180, 0, 1, 0], [-180 + IA, 0.5, -S3H, 0], 'face', 'pop',
      [180, 0, 0, 1], [-IA, 1, 0, 0], 'face',
      'pop',
      [180, 1, 0, 0], 'face',
      'push', [180, 0, 0, 1], [-IA, 1, 0, 0], 'face',
      'push', [180, 0, 1, 0], [-180 + IA, 0.5, S3H, 0], 'face', 'pop',
      [180, 0, 1, 0], [-180 + IA, 0.5, -S3H, 0], 'face',
      'pop',
      'push', [180, 0, 1, 0], [-180 + IA, 0.5, S3H, 0], 'face',
      'push', [180, 0, 1, 0], [-180 + IA, 0.5, S3H, 0], 'face', 'pop',
      [180, 0, 0, 1], [-IA, 1, 0, 0], 'face',
      'pop',
      [180, 0, 1, 0], [-180 + IA, 0.5, -S3H, 0], 'face',
      'push', [180, 0, 1, 0], [-180 + IA, 0.5, -S3H, 0], 'face', 'pop',
      [180, 0, 0, 1], [-IA, 1, 0, 0], 'face'],
  },
};

// strip vertex: push [Vert(3), normal(3) = cross(NeiA, NeiB)].
function pushVert(strip, vx, vy, vz, ax, ay, az, bx, by, bz) {
  strip.push([vx, vy, vz, ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]);
}
// GL_TRIANGLE_STRIP / GL_QUAD_STRIP -> triangle list (winding irrelevant: DoubleSide).
function appendStrip(out, s) {
  for (let k = 0; k + 2 < s.length; k++) {
    const a = (k % 2 === 0) ? s[k] : s[k + 1];
    const b = (k % 2 === 0) ? s[k + 1] : s[k];
    const c = s[k + 2];
    out.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    out.nrm.push(a[3], a[4], a[5], b[3], b[4], b[5], c[3], c[4], c[5]);
  }
}

// TRIANGLE(Edge, Amp, Divisions, Z) -- one triangular face (tetra/octa/ico).
function triangleFace(Edge, Amp, Div, Z, out) {
  const Vr = Edge * SQRT3 / 3;
  const AmpVr2 = Amp / (Vr * Vr);
  const Zf = Edge * Z;
  const Ax = Edge * (0.5 / Div);
  const Ay = Edge * (-SQRT3 / (2 * Div));
  let Yf = Vr + Ay, Yb = Yf + 0.001;
  let Factor = 0;
  for (let Ri = 1; Ri <= Div; Ri++) {
    const strip = [];
    let Xf = Ri * Ax, Xa = Xf + 0.001;
    const Yf2 = Yf * Yf, Yf_2 = (Yf - Ay) * (Yf - Ay);
    const Yb2 = Yb * Yb, Yb_2 = (Yb - Ay) * (Yb - Ay);
    for (let Ti = 0; Ti < Ri; Ti++) {
      let Xf2 = Xf * Xf;
      let Fa = 1 - ((Xf2 + Yf2) * AmpVr2);
      let F1 = 1 - ((Xa * Xa + Yf2) * AmpVr2);
      let F2 = 1 - ((Xf2 + Yb2) * AmpVr2);
      let vX = Fa * Xf, vY = Fa * Yf, vZ = Fa * Zf;
      pushVert(strip, vX, vY, vZ, F1 * Xa - vX, F1 * Yf - vY, F1 * Zf - vZ, F2 * Xf - vX, F2 * Yb - vY, F2 * Zf - vZ);
      Factor = Fa;
      Xf -= Ax; Yf -= Ay; Xa -= Ax; Yb -= Ay;

      Xf2 = Xf * Xf;
      Fa = 1 - ((Xf2 + Yf_2) * AmpVr2);
      F1 = 1 - ((Xa * Xa + Yf_2) * AmpVr2);
      F2 = 1 - ((Xf2 + Yb_2) * AmpVr2);
      vX = Fa * Xf; vY = Fa * Yf; vZ = Fa * Zf;
      pushVert(strip, vX, vY, vZ, F1 * Xa - vX, F1 * Yf - vY, F1 * Zf - vZ, F2 * Xf - vX, F2 * Yb - vY, F2 * Zf - vZ);
      Factor = Fa;
      Xf -= Ax; Yf += Ay; Xa -= Ax; Yb += Ay;
    }
    const Xf2 = Xf * Xf, Yf2f = Yf * Yf;
    const Fa = 1 - ((Xf2 + Yf2f) * AmpVr2);
    const F1 = 1 - ((Xa * Xa + Yf2f) * AmpVr2);
    const F2 = 1 - ((Xf2 + Yb * Yb) * AmpVr2);
    const vX = Fa * Xf, vY = Fa * Yf, vZ = Fa * Zf;
    pushVert(strip, vX, vY, vZ, F1 * Xa - vX, F1 * Yf - vY, F1 * Zf - vZ, F2 * Xf - vX, F2 * Yb - vY, F2 * Zf - vZ);
    Factor = Fa;
    Yf += Ay; Yb += Ay;
    appendStrip(out, strip);
  }
  out.vs = (Factor < 0);
}

// SQUARE(Edge, Amp, Divisions, Z) -- one square face (cube).
function squareFace(Edge, Amp, Div, Z, out) {
  const Zf = Edge * Z;
  const hd = Edge * SQRT2 / 2;
  const AmpVr2 = Amp / (hd * hd);
  let Factor = 0;
  for (let Yi = 0; Yi < Div; Yi++) {
    const Yf = -(Edge / 2.0) + (Yi / Div) * Edge;
    const Yf2 = Yf * Yf;
    const Yv = Yf + (1.0 / Div) * Edge;
    const Y2 = Yv * Yv;
    const strip = [];
    for (let Xi = 0; Xi <= Div; Xi++) {
      const Xf = -(Edge / 2.0) + (Xi / Div) * Edge;
      const Xf2 = Xf * Xf;
      let Xa = Xf + 0.001, Yb = Yv + 0.001;
      let Fa = 1 - ((Xf2 + Y2) * AmpVr2);
      const Xa2 = Xa * Xa;
      let F1 = 1 - ((Xa2 + Y2) * AmpVr2);
      let F2 = 1 - ((Xf2 + Yb * Yb) * AmpVr2);
      let vX = Fa * Xf, vY = Fa * Yv, vZ = Fa * Zf;
      pushVert(strip, vX, vY, vZ, F1 * Xa - vX, F1 * Yv - vY, F1 * Zf - vZ, F2 * Xf - vX, F2 * Yb - vY, F2 * Zf - vZ);

      Yb = Yf + 0.001;
      Fa = 1 - ((Xf2 + Yf2) * AmpVr2);
      F1 = 1 - ((Xa2 + Yf2) * AmpVr2);
      F2 = 1 - ((Xf2 + Yb * Yb) * AmpVr2);
      vX = Fa * Xf; vY = Fa * Yf; vZ = Fa * Zf;
      pushVert(strip, vX, vY, vZ, F1 * Xa - vX, F1 * Yf - vY, F1 * Zf - vZ, F2 * Xf - vX, F2 * Yb - vY, F2 * Zf - vZ);
      Factor = Fa;
    }
    appendStrip(out, strip);
  }
  out.vs = (Factor < 0);
}

// PENTAGON(Edge, Amp, Divisions, Z) -- one pentagonal face (dodeca).
function pentagonFace(Edge, Amp, Div, Z, out) {
  const Zf = Edge * Z;
  const cr = Edge * cossec36_2;
  const AmpVr2 = Amp / (cr * cr);
  const x = [], y = [];
  for (let Fi = 0; Fi < 6; Fi++) {
    x[Fi] = -Math.cos(Fi * 2 * Pi / 5 + Pi / 10) / Div * cossec36_2 * Edge;
    y[Fi] = Math.sin(Fi * 2 * Pi / 5 + Pi / 10) / Div * cossec36_2 * Edge;
  }
  let Factor = 0;
  for (let Ri = 1; Ri <= Div; Ri++) {
    for (let Fi = 0; Fi < 5; Fi++) {
      const strip = [];
      for (let Ti = 0; Ti < Ri; Ti++) {
        let Xf = (Ri - Ti) * x[Fi] + Ti * x[Fi + 1];
        let Yf = (Ri - Ti) * y[Fi] + Ti * y[Fi + 1];
        let Xa = Xf + 0.001, Yb = Yf + 0.001;
        let Xf2 = Xf * Xf, Yf2 = Yf * Yf;
        let Fa = 1 - ((Xf2 + Yf2) * AmpVr2);
        let F1 = 1 - ((Xa * Xa + Yf2) * AmpVr2);
        let F2 = 1 - ((Xf2 + Yb * Yb) * AmpVr2);
        let vX = Fa * Xf, vY = Fa * Yf, vZ = Fa * Zf;
        pushVert(strip, vX, vY, vZ, F1 * Xa - vX, F1 * Yf - vY, F1 * Zf - vZ, F2 * Xf - vX, F2 * Yb - vY, F2 * Zf - vZ);
        Factor = Fa;

        Xf -= x[Fi]; Yf -= y[Fi]; Xa -= x[Fi]; Yb -= y[Fi];
        Xf2 = Xf * Xf; Yf2 = Yf * Yf;
        Fa = 1 - ((Xf2 + Yf2) * AmpVr2);
        F1 = 1 - ((Xa * Xa + Yf2) * AmpVr2);
        F2 = 1 - ((Xf2 + Yb * Yb) * AmpVr2);
        vX = Fa * Xf; vY = Fa * Yf; vZ = Fa * Zf;
        pushVert(strip, vX, vY, vZ, F1 * Xa - vX, F1 * Yf - vY, F1 * Zf - vZ, F2 * Xf - vX, F2 * Yb - vY, F2 * Zf - vZ);
        Factor = Fa;
      }
      let Xf = Ri * x[Fi + 1], Yf = Ri * y[Fi + 1];
      let Xa = Xf + 0.001, Yb = Yf + 0.001;
      const Xf2 = Xf * Xf, Yf2 = Yf * Yf;
      const Fa = 1 - ((Xf2 + Yf2) * AmpVr2);
      const F1 = 1 - ((Xa * Xa + Yf2) * AmpVr2);
      const F2 = 1 - ((Xf2 + Yb * Yb) * AmpVr2);
      const vX = Fa * Xf, vY = Fa * Yf, vZ = Fa * Zf;
      pushVert(strip, vX, vY, vZ, F1 * Xa - vX, F1 * Yf - vY, F1 * Zf - vZ, F2 * Xf - vX, F2 * Yb - vY, F2 * Zf - vZ);
      Factor = Fa;
      appendStrip(out, strip);
    }
  }
  out.vs = (Factor < 0);
}

const FACE_FN = { tri: triangleFace, square: squareFace, pent: pentagonFace };

export function start(hostCanvas, opts = {}) {
  const DEG = Math.PI / 180;
  const OVERHEAD = 37500;   // us; pacing (xml default delay 40000 -> ~13fps)

  const config = {
    delay: 40000,   // us (xml default; invert slider)
    object: 0,      // 0 = random, 1=tetra 2=cube 3=octa 4=dodeca 5=icosa
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 40000, unit: ' µs', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'object', label: 'Object (0=random)', type: 'range', min: 0, max: 5, step: 1, default: 0, live: false },
  ];

  const rng = makeYaRandom(opts.seed || 0);
  const _c = new THREE.Color();
  const toLin = (rgb) => { _c.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace); return _c.clone(); };

  // ---- canvas / renderer ----
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // glFrustum(-1,1,-1,1,5,15), camera at origin looking down -z. Aspect is handled
  // by the model X-scale (0.3*H/W), NOT the projection -- so the frustum is square.
  const camera = new THREE.PerspectiveCamera(45, 1, 5, 15);
  camera.position.set(0, 0, 0);
  camera.projectionMatrix.makePerspective(-1, 1, 1, -1, 5, 15);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

  // Two white directional lights (1,1,1) and (-1,-1,1), ambient 0. intensity PI
  // cancels three's 1/PI diffuse (two lights sum, as in GL).
  const l0 = new THREE.DirectionalLight(0xffffff, Math.PI); l0.position.set(1, 1, 1); scene.add(l0);
  const l1 = new THREE.DirectionalLight(0xffffff, Math.PI); l1.position.set(-1, -1, 1); scene.add(l1);

  // draw_morph3d modelview chain: T(0,0,-10) -> Scale(0.3aspect) -> T(wander) ->
  // portrait-fit -> Rotate(step). Nested groups.
  const rootG = new THREE.Group(); rootG.position.set(0, 0, -10);
  const scaleG = new THREE.Group();
  const wanderG = new THREE.Group();
  const portraitG = new THREE.Group();
  const rotG = new THREE.Group();
  rootG.add(scaleG); scaleG.add(wanderG); wanderG.add(portraitG); portraitG.add(rotG);
  scene.add(rootG);

  // ---- chosen solid ----
  let solid, faceFn, faces, meshes = [], geom = null, posArr = null, nrmArr = null;

  function buildSolid() {
    for (const m of meshes) { rotG.remove(m); m.material.dispose(); }
    meshes = [];
    if (geom) { geom.dispose(); geom = null; }

    let obj = Math.round(config.object);
    if (obj <= 0 || obj > 5) obj = (rng.random() % 5) + 1;   // NRAND(5)+1
    solid = SOLIDS[obj];
    faceFn = FACE_FN[solid.type];

    // Per-face transforms + colors (replay the op-list on a matrix stack).
    faces = [];
    const stack = [new THREE.Matrix4()];
    const tmp = new THREE.Matrix4(), axis = new THREE.Vector3();
    let ci = 0;
    for (const op of solid.ops) {
      const top = stack[stack.length - 1];
      if (op === 'push') stack.push(top.clone());
      else if (op === 'pop') stack.pop();
      else if (op === 'face') faces.push({ matrix: top.clone(), color: solid.colors[ci++] });
      else top.multiply(tmp.makeRotationAxis(axis.set(op[1], op[2], op[3]).normalize(), op[0] * DEG));
    }

    rebuildFace(0);   // size + create the shared geometry

    // One mesh per face: shared geometry, own material (face color) + transform.
    for (const f of faces) {
      const mat = new THREE.MeshPhongMaterial({
        color: toLin(f.color),
        // GL front_specular is 0.7 gray @ shininess 60, but only LIGHT0 has a (default
        // white) specular -- LIGHT1's specular defaults to BLACK, so the original shows
        // ONE soft highlight, not two. three has no per-light specular (both our lights
        // would spec) and intensity=PI over-amplifies it, so we dim the material specular
        // to a gentle sheen rather than two saturated white spots.
        specular: new THREE.Color().setRGB(0.1, 0.1, 0.1, THREE.SRGBColorSpace),
        shininess: 60,
        emissive: new THREE.Color().setRGB(0.1, 0.1, 0.1, THREE.SRGBColorSpace),
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(f.matrix);
      rotG.add(mesh);
      meshes.push(mesh);
    }
  }

  // Recompute the one morphed face for this seno; update the shared geometry.
  function rebuildFace(seno) {
    const out = { pos: [], nrm: [], vs: false };
    faceFn(solid.edge, seno, solid.div, solid.z, out);
    if (!geom) {
      posArr = new Float32Array(out.pos.length);
      nrmArr = new Float32Array(out.nrm.length);
      geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      geom.setAttribute('normal', new THREE.BufferAttribute(nrmArr, 3));
    }
    posArr.set(out.pos); nrmArr.set(out.nrm);
    geom.attributes.position.needsUpdate = true;
    geom.attributes.normal.needsUpdate = true;
    geom.computeBoundingSphere();
    return out.vs;
  }

  // ---- sizing ----
  let W = window.innerWidth, H = window.innerHeight;
  function syncSize() {
    W = window.innerWidth; H = window.innerHeight;
    renderer.setSize(W, H, false);
    // Scale4Window 0.3, X squished by H/W (aspect handled in-model, square frustum).
    scaleG.scale.set(0.3 * H / W, 0.3, 0.3);
    portraitG.scale.setScalar(W < H ? W / H : 1);
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  buildSolid();

  // ---- render loop ----
  let raf = 0, last = 0, paused = false, ms = 16, step = (rng.random() % 90);
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;

    // wander (in the 0.3-scaled frame): 2.5*(W/H)*sin(step*1.11), 2.5*cos(step*1.25*1.11).
    wanderG.position.set(2.5 * (W / H) * Math.sin(step * 1.11), 2.5 * Math.cos(step * 1.25 * 1.11), 0);
    // tumble: step*100 X, step*95 Y, step*90 Z (degrees).
    rotG.rotation.set(step * 100 * DEG, step * 95 * DEG, step * 90 * DEG, 'XYZ');

    // seno = (sin(step) + 1/3) * (4/5) * Magnitude; morph the face.
    const seno = (Math.sin(step) + 1.0 / 3.0) * (4.0 / 5.0) * solid.mag;
    rebuildFace(seno);

    renderer.render(scene, camera);
    step += 0.05 * frames;
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      for (const m of meshes) m.material.dispose();
      if (geom) geom.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { buildSolid(); },
    config,
    params,
  };
}

export default { title, info, start };
