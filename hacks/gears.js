// gears.js -- "Gears" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's gears (Brian Paul 1996; rewritten by Jamie
// Zawinski, Nov 2007), hacks/glx/gears.c. A train of 3-7 interlocking gears with
// proper involute teeth meshes and spins; 1/8 of the time it's an epicyclic
// (planetary) cluster of five gears inside a toothed ring, held by a three-armed
// spider armature. The whole assembly tumbles and wanders through space.
//
// The gear geometry itself is the shared ./involute.js (a faithful port of
// xscreensaver's hacks/glx/involute.c, which is likewise a SHARED library that
// gears / moebiusgears / geodesicgears / pinion all #include). This module owns
// gears.c's part: gear generation + placement (the MESHING math), the planetary
// cluster + armature, the scene/lighting/camera, and the render loop. Self-
// contained otherwise (own overlay canvas + renderer + loop), following the host's
// mountable-module contract exactly as cubicgrid.js / dangerball.js do. Motion
// (rotator.js) and RNG (yarandom.js) are the shared faithful util ports.
//
// FAITHFUL TO gears.c -- the rule here is "do not deviate from the algorithm":
//   * new_gear: tooth size/count/radius, the four interior shapes (ring; +inset
//     disc; +raised lip; +third disc/spokes), nubs, the pixel-size -> mesh-detail
//     bucket, all RNG draws in source order.
//   * place_gear: gearing ratio, the half-tooth offset for odd tooth counts, the
//     exact th adjustment that lines a child's teeth up with its parent, and the
//     no-overlap collision test -- so the teeth visibly MESH.
//   * planetary_gears + armature (ctube via involute.js's unit_tube/unit_cone port,
//     and arm()).
//   * draw_gears modelview: position (rotator) -> rotation (with the fixed
//     x-=0.14, y-=0.06 tilt that gives the classic receding-train view) -> bbox
//     center+fit -> per-gear translate + Rz(th).
//   * lighting: one white directional light from (1,1,1), ambient 0 (so unlit
//     side walls go dark), material specular = the light's cyan {0,1,1}, shininess
//     128.
//
// COLOR MANAGEMENT mirrors dangerball.js: three's colour management is DISABLED (see the
// flag below), so each gear's two random pastel colors (color = 0.5+frand(0.5);
// color2 = color*0.85) are used RAW for the per-vertex diffuse -- matching GL's
// framebuffer (involute.js carries diffuse by VERTEX COLORS so one material reproduces
// the .c's per-region glMaterialfv swaps).
//
// PACING (same model as dangerball): render every rAF; motion is continuous.
// `delay` (us) -> effFps = 1e6/(delay+OVERHEAD); each render advances
// `frames = dt*effFps` original-frames. Gear spin (th += ratio*5*speed per frame)
// advances continuously; the rotator's discrete random-walk is ticked once per
// original-frame and interpolated between ticks.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';
import {
  buildGearGeometry,
  involuteBiggestRing,
  Builder,
  MStack,
  ctube,
  arm,
  INVOLUTE_SMALL as SMALL,
  INVOLUTE_MEDIUM as MEDIUM,
  INVOLUTE_LARGE as LARGE,
  INVOLUTE_HUGE as HUGE,
} from './involute.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding). Disable three's color management so the
// port matches GL: set at MODULE SCOPE (before start() fills colors) so the
// setRGB(..., SRGBColorSpace) calls become no-ops and store RAW glColor, and the output
// is not sRGB-encoded. Without this, lit/shaded faces render up to ~2.5x too bright
// (measured vs the rubikblocks grayscale ground truth).
THREE.ColorManagement.enabled = false;

export const title = 'gears';

export const info = {
  author: 'Jamie Zawinski',
  year: 2007,
  description: 'Interlocking gears.\n\nSee also the "Pinion" and "M\u00f6bius Gears" screen savers.\n\nhttps://en.wikipedia.org/wiki/Involute_gear\nhttps://en.wikipedia.org/wiki/Epicyclic_gearing',
};

export function start(hostCanvas, opts = {}) {
  const DEG = Math.PI / 180;
  const OVERHEAD = 37500;     // us; calibrates xml default delay 30000 -> ~15fps (see frame-rate-calibration)
  const SIDE = THREE.DoubleSide;   // closed solids: pixel-identical to back-face culling (see involute.js)

  // Live config -- keys/ranges/defaults/labels transcribed 1:1 from
  // hacks/config/gears.xml + the gears.c DEFAULTS.
  const config = {
    delay: 30000,   // us, frame rate / overall speed (xml default; invert slider)
    speed: 1.0,     // gear spin-rate multiplier (xml --speed)
    count: 0,       // number of gears, 0 => random 3-7 (xml --count)
    wander: true,   // drift through space (do_wander)
    spin: true,     // tumble (do_spin)
    wire: false,    // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' µs', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.01, max: 5.0, step: 0.01, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'count', label: 'Gear count', type: 'range', min: 0, max: 20, step: 1, default: 0, lowLabel: '0', highLabel: '20', live: false },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'spin', label: 'Spin', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const seed = opts.seed || 0;            // 0 => time-seeded (random per run)
  const rng = makeYaRandom(seed);

  // RNG helpers, matching the .c macros. random() == ya_random (uint32); the .c
  // uses `random() % n` and frand() directly, so we do too (don't substitute the
  // bias-free NRAND -- faithful to source).
  const frand = (f = 1) => rng.frand(f);
  const BELLRAND = (n) => (frand(n) + frand(n) + frand(n)) / 3;   // ~triangular bell
  const RND = (n) => rng.random() % n;

  // raw glColor [r,g,b] for vertex-color diffuse (colour management off; see header).
  const _c = new THREE.Color();
  const toLin = (r, g, b) => { _c.setRGB(r, g, b, THREE.SRGBColorSpace); return [_c.r, _c.g, _c.b]; };

  // ===================================================================
  //  gears.c -- gear generation, placement, planetary, armature
  // ===================================================================
  const gears = [];   // bp->gears
  let planetaryP = false;

  function newGear(parent) {
    const g = {
      x: 0, y: 0, z: 0, r: 0, th: 0, nteeth: 0, tooth_w: 0, tooth_h: 0, tooth_slope: 0,
      inner_r: 0, inner_r2: 0, inner_r3: 0, thickness: 0, thickness2: 0, thickness3: 0,
      spokes: 0, nubs: 0, spoke_thickness: 0, ratio: 0, inverted_p: false, base_p: false,
      coax_p: 0, wobble: 0, size: LARGE, polygons: 0,
    };

    // Tooth size.
    if (parent) {
      g.tooth_w = parent.tooth_w;
      g.tooth_h = parent.tooth_h;
      g.tooth_slope = -parent.tooth_slope;
    } else {
      g.tooth_w = 0.007 * (1.0 + BELLRAND(4.0));
      g.tooth_h = 0.005 * (1.0 + BELLRAND(8.0));
      // (tooth_slope randomization is commented out in the .c -> stays 0)
    }

    // Tooth count -> radius.
    if (!parent || gears.length > 4) g.nteeth = Math.trunc(5 + BELLRAND(20));
    else g.nteeth = Math.trunc(parent.nteeth * (0.5 + BELLRAND(2)));
    const c = g.nteeth * g.tooth_w * 2;   // circumference = teeth + gaps
    g.r = c / (Math.PI * 2);

    g.thickness = g.tooth_w + frand(g.r);
    g.thickness2 = g.thickness * 0.7;
    g.thickness3 = g.thickness;

    g.color = [0.5 + frand(0.5), 0.5 + frand(0.5), 0.5 + frand(0.5)];
    g.color2 = [g.color[0] * 0.85, g.color[1] * 0.85, g.color[2] * 0.85];

    // Interior shape.
    if (RND(10) === 0) {
      g.inner_r = (g.r * 0.1) + frand((g.r - g.tooth_h / 2) * 0.8);
      g.inner_r2 = 0; g.inner_r3 = 0;
    } else {
      g.inner_r = (g.r * 0.5) + frand((g.r - g.tooth_h) * 0.4);
      g.inner_r2 = (g.r * 0.1) + frand(g.inner_r * 0.5);
      g.inner_r3 = 0;
      if (g.inner_r2 > (g.r * 0.2)) {
        const nn = RND(10);
        if (nn <= 2) g.inner_r3 = (g.r * 0.1) + frand(g.inner_r2 * 0.2);
        else if (nn <= 7 && g.inner_r2 >= 0.1) g.inner_r3 = g.inner_r2 - 0.01;
      }
    }

    // Sometimes spokes in the middle disc.
    if (g.inner_r3 && RND(5) === 0) {
      g.spokes = Math.trunc(2 + BELLRAND(5));
      g.spoke_thickness = 1 + frand(7.0);
      if (g.spokes === 2 && g.spoke_thickness < 2) g.spoke_thickness += 1;
    }

    // Sometimes little nubbly bits, if there's room.
    if (g.nteeth > 5) {
      const br = involuteBiggestRing(g);
      if (br.size > g.r * 0.2 && RND(5) === 0) {
        g.nubs = 1 + RND(16);
        if (g.nubs > 8) g.nubs = 1;
      }
    }

    // Mesh-detail bucket from on-screen tooth size (pixels).
    const pix = g.tooth_h * canvasH;
    if (pix <= 2.5) g.size = SMALL;
    else if (pix <= 3.5) g.size = MEDIUM;
    else if (pix <= 25) g.size = LARGE;
    else g.size = HUGE;

    g.base_p = !parent;
    return g;
  }

  function placeGear(g, parent) {
    // Velocity.
    if (!parent) {
      g.ratio = 0.8 + BELLRAND(0.4);
      g.th = 1;   // not 0
    } else {
      g.ratio = parent.nteeth / g.nteeth;
      g.th = -(parent.th * g.ratio);
      if (g.nteeth & 1) {   // half-tooth offset for odd tooth count
        const off = 180.0 / g.nteeth;
        if (g.th > 0) g.th += off; else g.th -= off;
      }
      g.ratio *= parent.ratio;
    }

    if (parent) {   // place next to parent
      const r_off = parent.r + g.r;
      const angle = RND(360) - 180;   // -180..+180 deg
      g.x = parent.x + Math.cos(angle * (Math.PI / 180)) * r_off;
      g.y = parent.y + Math.sin(angle * (Math.PI / 180)) * r_off;
      g.z = parent.z;
      g.th += (g.th > 0 ? 360 : -360);
      // line teeth up with parent based on position + parent's rotation
      const p_c = 2 * Math.PI * parent.r;
      const g_c = 2 * Math.PI * g.r;
      const p_t = p_c * (angle / 360.0);
      const g_rat = p_t / g_c;
      const g_th = 360.0 * g_rat;
      g.th += angle + g_th;
    }

    // Reject if it overlaps an earlier gear on the same layer.
    for (let i = gears.length - 1; i >= 0; i--) {
      const og = gears[i];
      if (og === g || og === parent) continue;
      if (g.z !== og.z) continue;
      const sum = g.r + g.tooth_h + og.r + og.tooth_h;
      if (((g.x - og.x) ** 2 + (g.y - og.y) ** 2) < sum * sum) return false;
    }
    return true;
  }

  function placeNewGear(parent) {
    let g = null;
    for (let loop = 0; loop < 100; loop++) {
      g = newGear(parent);
      if (placeGear(g, parent)) { gears.push(g); return g; }
    }
    return null;   // gave up; keep previous parent
  }

  function planetaryGears() {
    planetaryP = true;
    const distance = 2.02;
    const g0 = newGear(null), g1 = newGear(null), g2 = newGear(null), g3 = newGear(null), g4 = newGear(null);
    placeGear(g0, null); placeGear(g1, null); placeGear(g2, null); placeGear(g3, null); placeGear(g4, null);

    g0.nteeth = 12 + (3 * RND(10));   // must be multiple of 3
    g0.tooth_w = g0.r / g0.nteeth;
    g0.tooth_h = g0.tooth_w * 2.8;

    for (const k of ['r', 'th', 'nteeth', 'tooth_w', 'tooth_h', 'tooth_slope',
      'inner_r', 'inner_r2', 'inner_r3', 'thickness', 'thickness2', 'thickness3',
      'ratio', 'size']) {
      g1[k] = g2[k] = g3[k] = g4[k] = g0[k];
    }
    g1.color = g2.color = g3.color = g4.color = g0.color;
    g1.color2 = g2.color2 = g3.color2 = g4.color2 = g0.color2;

    g1.x = Math.cos(Math.PI * 2 / 3) * g1.r * distance;
    g1.y = Math.sin(Math.PI * 2 / 3) * g1.r * distance;
    g2.x = Math.cos(Math.PI * 4 / 3) * g2.r * distance;
    g2.y = Math.sin(Math.PI * 4 / 3) * g2.r * distance;
    g3.x = Math.cos(Math.PI * 6 / 3) * g3.r * distance;
    g3.y = Math.sin(Math.PI * 6 / 3) * g3.r * distance;
    g4.x = 0; g4.y = 0; g4.th = -g3.th;
    if (g4.nteeth & 1) g4.th -= (180.0 / g4.nteeth);

    // sun: a ring gear with teeth on the inside.
    g0.inverted_p = true;
    g0.x = 0; g0.y = 0;
    g0.nteeth = g1.nteeth * 3;
    g0.r = g1.r * 3.05;
    g0.inner_r = g0.r * 0.8;
    g0.inner_r2 = 0; g0.inner_r3 = 0;
    g0.th = g1.th + (180 / g0.nteeth);
    g0.ratio = g1.ratio / 3;
    g0.tooth_slope = 0;
    g0.nubs = 3;
    g0.spokes = 0;
    g0.size = LARGE;

    gears.length = 0;
    gears.push(g1, g2, g3, g4, g0);
  }

  // armature(): the three-armed spider that holds a planetary cluster.
  function buildArmature(gears0) {
    const B = Builder();
    const stack = MStack();
    const col = toLin(0.5 + frand(0.5), 0.5 + frand(0.5), 0.5 + frand(0.5));

    stack.push();
    { let s = gears0.r * 2.7; s = s / 5.6; stack.scale(s, s, s); }
    stack.translate(0, 0, 1.4 + gears0.thickness);
    stack.rotate(30, 0, 0, 1);

    ctube(B, stack, 0.5, 10, col);   // center axle

    for (const a of [0, 120, 240]) {   // three outer axles + collars
      stack.push();
      stack.rotate(a, 0, 0, 1);
      stack.translate(0, 4.2, -1);
      ctube(B, stack, 0.5, 3, col);
      stack.translate(0, 0, 1.8);
      ctube(B, stack, 0.7, 0.7, col);
      stack.pop();
    }

    stack.translate(0, 0, 1.5);
    ctube(B, stack, 1.5, 2, col);     // center disk

    for (const a of [270, 30, 150]) {   // three arms
      stack.push();
      stack.rotate(a, 0, 0, 1);
      stack.rotate(-10, 0, 1, 0);
      stack.translate(-2.2, 0, 0);
      arm(B, stack, 4.0, 1.0, 0.5, 2.0, 1.0, col);
      stack.pop();
    }

    stack.pop();
    return B.geometry();
  }

  // ===================================================================
  //  three.js scene + canvas
  // ===================================================================
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);
  const canvasH = Math.round(window.innerHeight * dpr);   // MI_HEIGHT for the mesh-detail bucket

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // reshape_gears: gluPerspective(30, aspect, 1, 100) + gluLookAt(0,0,30, 0,0,0, 0,1,0).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // One white directional light from (1,1,1) (GL pos {1,1,1,0}, w=0 => parallel).
  // intensity PI cancels three's 1/PI diffuse normalization (same as dangerball). The
  // GL light's cyan {0,1,1} SPECULAR is folded onto the material specular below (three
  // has no separate light-specular color); the highlight is light.color *
  // material.specular. Plus the GL DEFAULT light-model ambient (0.2) * the material's
  // AMBIENT_AND_DIFFUSE (= the gear color, set by involute.c) = a 0.2*color floor, so
  // unlit side walls are dim color rather than pure black (matches gears.jpg).
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(1, 1, 1);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.2 * Math.PI));

  // Single shared material; diffuse comes from per-vertex colors (color/color2),
  // specular = the light's cyan, shininess 128 (draw_involute_gear).
  const material = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    vertexColors: true,
    specular: 0x00ffff,
    shininess: 128,
    side: SIDE,
  });

  // Nested groups mirroring draw_gears' modelview.
  const viewRoot = new THREE.Group();   // reshape portrait-fit scale
  const posGroup = new THREE.Group();   // translate by rotator position
  const rotGroup = new THREE.Group();   // tumble (+ fixed tilt)
  const fitGroup = new THREE.Group();   // bbox fit scale
  const centerGroup = new THREE.Group();// bbox center translate
  viewRoot.add(posGroup); posGroup.add(rotGroup); rotGroup.add(fitGroup);
  fitGroup.add(centerGroup); scene.add(viewRoot);

  const meshes = [];
  let bbox = { x1: 0, y1: 0, x2: 0, y2: 0 };

  function buildScene() {
    for (const e of meshes) { centerGroup.remove(e.mesh); e.mesh.geometry.dispose(); }
    meshes.length = 0;
    gears.length = 0;
    planetaryP = false;

    if (RND(8) === 0) {
      planetaryGears();
    } else {
      let total = config.count;
      if (total <= 0) total = Math.trunc(3 + Math.abs(BELLRAND(8) - 4));   // 3-7, mostly 3
      let g = null;
      for (let i = 0; i < total; i++) g = placeNewGear(g);
    }

    // Center gears in scene (bbox over gear discs).
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const g of gears) {
      if (g.x - g.r < minx) minx = g.x - g.r;
      if (g.x + g.r > maxx) maxx = g.x + g.r;
      if (g.y - g.r < miny) miny = g.y - g.r;
      if (g.y + g.r > maxy) maxy = g.y + g.r;
    }
    bbox = { x1: minx, y1: miny, x2: maxx, y2: maxy };

    // Precompute linear vertex colors, build each gear's geometry + mesh.
    for (const g of gears) {
      g.colLin = toLin(g.color[0], g.color[1], g.color[2]);
      g.col2Lin = toLin(g.color2[0], g.color2[1], g.color2[2]);
      const mesh = new THREE.Mesh(buildGearGeometry(g), material);
      mesh.position.set(g.x, g.y, g.z);
      mesh.rotation.z = g.th * DEG;
      centerGroup.add(mesh);
      meshes.push({ mesh, gear: g, isArmature: false });
    }
    if (planetaryP) {
      // armature() scales off bp->gears[0] -- which is the first PLANET (g1),
      // not the sun (g0 is pushed last); see planetary_gears' push order.
      const am = new THREE.Mesh(buildArmature(gears[0]), material);
      centerGroup.add(am);
      meshes.push({ mesh: am, gear: null, isArmature: true });
    }

    // Apply the static bbox fit (draw_gears: scale 10/max(w,h), translate -center).
    const w = bbox.x2 - bbox.x1, h = bbox.y2 - bbox.y1;
    const s = 10.0 / (w > h ? w : h);
    fitGroup.scale.setScalar(s);
    centerGroup.position.set(-(bbox.x1 + w / 2), -(bbox.y1 + h / 2), 0);
  }

  // ---- rotator: slow whole-scene tumble + wander (init_gears speeds) ----
  // make_rotator(0.5,0.5,0.5, 0.25, 0.01, True).
  const rot = makeRotator(
    { spinX: 0.5, spinY: 0.5, spinZ: 0.5, spinAccel: 0.25, wanderSpeed: 0.01, randomize: true },
    rng,
  );

  buildScene();

  // ---- rotator sampling + interpolation (dangerball machinery) ----
  const r0 = rot.getRotation(false), p0 = rot.getPosition(false);
  let prevR = { ...r0 }, curR = { ...r0 };
  let prevP = { ...p0 }, curP = { ...p0 };
  let rotAccum = 0;
  function tickRotator() {
    prevR = curR; curR = rot.getRotation(true);
    prevP = curP; curP = rot.getPosition(true);
  }
  function lerpAngle(a, b, t) { let d = b - a; if (d > 0.5) d -= 1; else if (d < -0.5) d += 1; return a + d * t; }
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---- sizing (reshape_gears: gluPerspective + the portrait fit scale) ----
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    viewRoot.scale.setScalar(w < h ? w / h : 1);   // reshape glScalef(s,s,s)
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop ----
  const MAX_TICKS = 8;
  let raf = 0, last = 0, paused = false, ms = 16;

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

    // Gear spin: th += ratio*5*speed per original-frame, sign preserved (continuous).
    for (const e of meshes) {
      if (e.isArmature) continue;
      const g = e.gear;
      const off = g.ratio * 5 * config.speed * frames;
      g.th += (g.th > 0 ? off : -off);
      e.mesh.rotation.z = g.th * DEG;
    }

    // Whole-scene tumble: tick rotator at the original cadence, interpolate.
    rotAccum += frames;
    let ticks = 0;
    while (rotAccum >= 1 && ticks < MAX_TICKS) { tickRotator(); rotAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) rotAccum = 0;
    const a = rotAccum;

    // rotation: get_rotation, then the fixed tilt x-=0.14, y-=0.06 (always applied,
    // so -no-spin still shows the classic receding-train view).
    let rx = -0.14, ry = -0.06, rz = 0;
    if (config.spin) {
      rx = lerpAngle(prevR.x, curR.x, a) - 0.14;
      ry = lerpAngle(prevR.y, curR.y, a) - 0.06;
      rz = lerpAngle(prevR.z, curR.z, a);
    }
    rotGroup.rotation.set(rx * 2 * Math.PI, ry * 2 * Math.PI, rz * 2 * Math.PI, 'XYZ');

    // position: (x-0.5)*4, (y-0.5)*4, (z-0.5)*7.
    if (config.wander) {
      posGroup.position.set(
        (lerp(prevP.x, curP.x, a) - 0.5) * 4,
        (lerp(prevP.y, curP.y, a) - 0.5) * 4,
        (lerp(prevP.z, curP.z, a) - 0.5) * 7,
      );
    } else posGroup.position.set(0, 0, 0);

    material.wireframe = config.wire;
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      for (const e of meshes) e.mesh.geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { buildScene(); },   // fresh gear train (host 're-seed')
    config,
    params,
  };
}

export default { title, info, start };
