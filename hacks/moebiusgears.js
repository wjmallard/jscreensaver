// moebiusgears.js -- "Möbius Gears" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's moebiusgears (Jamie Zawinski, 2007),
// hacks/glx/moebiusgears.c. An odd number of identical involute gears arranged
// around a ring, twisted a half-turn over the full loop so the band of gears forms
// a Möbius strip; adjacent gears are offset half a tooth and counter-rotate so the
// whole interlinked loop meshes and turns. The ring tumbles, wanders, and "rolls".
//
// The gear geometry is the shared ./involute.js (faithful port of involute.c) --
// the same shared library moebiusgears.c uses via draw_involute_gear(). This module
// owns moebiusgears.c's part: the gear parameters, the Möbius ring layout + meshing,
// the scene/lighting/camera, and the render loop. Self-contained otherwise (own
// overlay canvas + renderer + loop), like gears.js / dangerball.js. Motion
// (rotator.js) and RNG (yarandom.js) are the shared faithful util ports.
//
// FAITHFUL TO moebiusgears.c -- "do not deviate from the algorithm":
//   * reset_mgears: count forced ODD and >= 13 (else gears intersect / mesh angle
//     too steep), teeth forced ODD and >= 7 (else teeth don't mesh when the loop
//     closes), ring_r = 3, gear_r = pi*ring_r / (count/2), tooth_h = gear_r*2.5/teeth,
//     the gear_r -> mesh-detail bucket, the nub draw, all gears IDENTICAL with the
//     inner_r/inner_r2/inner_r3 = r*{0.8,0.6,0.55} nested rings.
//   * the per-gear placement: Rz(pos_th) at pos_th = (2pi/gpt)*i around the ring,
//     out to ring_r, then Ry(pos_thz) at pos_thz = (pi/2/gpt)*i -- which accumulates
//     to a HALF-twist (pi) over the loop = the Möbius strip. Initial th offset half a
//     tooth on odd-index gears so they mesh; counter-rotation per index.
//   * draw_mgears modelview: Scale(1.1) -> position (rotator) -> rotation (fixed
//     x-=0.14, y-=0.06 tilt) -> Scale(1.5) -> per-gear. The optional "roll" spins
//     every gear about its local Y by a shared, accumulating angle.
//   * lighting: one white directional light from (1,1,1), ambient 0, material
//     specular = the light's cyan {0,1,1}, shininess 128.
//
// th is in RADIANS here (the .c uses radians for moebiusgears' th, unlike gears.c
// which uses degrees). Color = 0.7+frand(0.3) (lighter pastels than gears'
// 0.5+frand(0.5)); color2 = color*0.85. Color management + pacing as in gears.js /
// dangerball.js (raw vertex-color diffuse, colour management off; effFps = 1e6/(delay+OVERHEAD)).

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';
import {
  buildGearGeometry,
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

export const title = 'moebiusgears';

export const info = {
  author: 'Jamie Zawinski',
  year: 2007,
  description: 'An interlinked loop of rotating gears. The layout of the gears follows the path of a m\u00f6bius strip.\n\nSee also the "Pinion" and "Gears" screen savers.\n\nhttps://en.wikipedia.org/wiki/Involute_gear\nhttps://en.wikipedia.org/wiki/Moebius_strip',
};

export function start(hostCanvas, opts = {}) {
  const OVERHEAD = 37500;     // us; calibrates xml default delay 30000 -> ~15fps (see frame-rate-calibration)
  const SIDE = THREE.DoubleSide;   // closed solids: pixel-identical to back-face culling (see involute.js)

  // Live config -- transcribed 1:1 from hacks/config/moebiusgears.xml + DEFAULTS.
  const config = {
    delay: 30000,   // us, frame rate / overall speed (xml default; invert slider)
    speed: 1.0,     // spin/roll rate multiplier
    count: 17,      // number of gears (forced odd, >=13)
    teeth: 15,      // teeth per gear (forced odd, >=7)
    wander: true,
    spin: true,
    roll: true,
    wire: false,
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' µs', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.01, max: 5.0, step: 0.01, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'count', label: 'Number of gears', type: 'range', min: 13, max: 99, step: 1, default: 17, live: false },
    { key: 'teeth', label: 'Number of teeth', type: 'range', min: 7, max: 49, step: 1, default: 15, live: false },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'spin', label: 'Spin', type: 'checkbox', default: true, live: true },
    { key: 'roll', label: 'Roll', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const seed = opts.seed || 0;
  const rng = makeYaRandom(seed);
  const frand = (f = 1) => rng.frand(f);

  const _c = new THREE.Color();
  const toLin = (r, g, b) => { _c.setRGB(r, g, b, THREE.SRGBColorSpace); return [_c.r, _c.g, _c.b]; };

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

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // reshape_mgears: gluPerspective(30, aspect, 1, 100) + gluLookAt(0,0,30, 0,0,0, 0,1,0).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // One white directional light from (1,1,1). intensity PI cancels three's 1/PI
  // diffuse; the GL light's cyan {0,1,1} specular is folded onto the material specular
  // (highlight = light.color * material.specular). Plus the GL default light-model
  // ambient (0.2) * the material's AMBIENT_AND_DIFFUSE (= the gear color, via
  // involute.c) = a 0.2*color floor, so unlit walls are dim color, not pure black.
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(1, 1, 1);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.2 * Math.PI));

  const material = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    vertexColors: true,
    specular: 0x00ffff,
    shininess: 128,
    side: SIDE,
  });

  // Nested groups mirroring draw_mgears' modelview: portrait -> Scale(1.1) ->
  // position -> rotation -> Scale(1.5) -> per-gear.
  const viewRoot = new THREE.Group();   // reshape portrait-fit scale
  const scale11 = new THREE.Group(); scale11.scale.setScalar(1.1);
  const posGroup = new THREE.Group();
  const rotGroup = new THREE.Group();
  const scale15 = new THREE.Group(); scale15.scale.setScalar(1.5);
  viewRoot.add(scale11); scale11.add(posGroup); posGroup.add(rotGroup);
  rotGroup.add(scale15); scene.add(viewRoot);

  // ===================================================================
  //  reset_mgears -- build the ring of gears
  // ===================================================================
  const gearsArr = [];   // { mesh, pos_th, pos_thz, dir, th }
  let ringR = 3;
  let rollTh = 0;

  function reset() {
    for (const e of gearsArr) { scale15.remove(e.mesh); e.mesh.geometry.dispose(); }
    gearsArr.length = 0;
    rollTh = 0;

    let totalGears = Math.round(config.count);
    if (!(totalGears & 1)) totalGears++;       // must be odd or gears intersect
    let teeth = Math.round(config.teeth);
    if (!(teeth & 1)) teeth++;                 // must be odd or teeth don't mesh at the loop close
    if (teeth < 7) teeth = 7;
    if (totalGears < 13) totalGears = 13;      // mesh angle too steep with fewer

    const thick = 0.2;
    // nubs: 3/4 of the time none, else a random count up to teeth/2.
    const nubs = (rng.random() & 3) ? 0 : Math.trunc((rng.random() % teeth) / 2);
    const slope = 0;

    const gearsPerTurn = totalGears / 2.0;
    ringR = 3;
    const gearR = Math.PI * ringR / gearsPerTurn;
    const toothH = gearR * 2.5 / teeth;

    // mesh-detail bucket from gear radius, then knock it down for many teeth.
    let size = (gearR > 0.60 ? HUGE : gearR > 0.32 ? LARGE : gearR > 0.13 ? MEDIUM : SMALL);
    if (teeth > 77) size = SMALL;
    if (teeth > 45 && size >= HUGE) size = MEDIUM;

    for (let i = 0; i < totalGears; i++) {
      // All gears are geometrically identical; only color (and th phase) differ.
      const color = [0.7 + frand(0.3), 0.7 + frand(0.3), 0.7 + frand(0.3)];
      const color2 = [color[0] * 0.85, color[1] * 0.85, color[2] * 0.85];
      const g = {
        r: gearR, size, nteeth: teeth, tooth_w: 0, tooth_h: toothH, tooth_slope: slope,
        thickness: gearR * thick, thickness2: gearR * thick * 0.1, thickness3: gearR * thick,
        inner_r: gearR * 0.80, inner_r2: gearR * 0.60, inner_r3: gearR * 0.55,
        spokes: 0, nubs, inverted_p: false, spoke_thickness: 0,
        colLin: toLin(color[0], color[1], color[2]),
        col2Lin: toLin(color2[0], color2[1], color2[2]),
        polygons: 0,
      };
      const mesh = new THREE.Mesh(buildGearGeometry(g), material);
      mesh.matrixAutoUpdate = false;
      scale15.add(mesh);
      gearsArr.push({
        mesh,
        pos_th: (Math.PI * 2 / gearsPerTurn) * i,    // position around the ring
        pos_thz: (Math.PI / 2 / gearsPerTurn) * i,   // out-of-plane twist (accumulates to pi = Möbius)
        dir: (i & 1) ? 1 : -1,                       // counter-rotation per index
        th: (i & 1) ? (Math.PI * 2 / teeth) : 0,     // half-tooth mesh offset
      });
    }
  }

  // make_rotator(0.5,0.5,0.5, accel 2.0, wander 0.01, randomize FALSE).
  const rot = makeRotator(
    { spinX: 0.5, spinY: 0.5, spinZ: 0.5, spinAccel: 2.0, wanderSpeed: 0.01, randomize: false },
    rng,
  );

  reset();

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

  // ---- per-gear matrix: Rz(pos_th) * T(ringR,0,0) * Ry(pos_thz + roll) * Rz(th) ----
  const _m = new THREE.Matrix4(), _t = new THREE.Matrix4();
  function updateGearMatrix(e, rollY) {
    _m.makeRotationZ(e.pos_th);
    _m.multiply(_t.makeTranslation(ringR, 0, 0));
    _m.multiply(_t.makeRotationY(e.pos_thz + rollY));
    _m.multiply(_t.makeRotationZ(e.th));
    e.mesh.matrix.copy(_m);
    e.mesh.matrixWorldNeedsUpdate = true;
  }

  // ---- sizing (reshape_mgears) ----
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    viewRoot.scale.setScalar(w < h ? w / h : 1);
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

    // roll: shared accumulating angle (roll_th += speed*0.0005 per original-frame).
    if (config.roll) rollTh += config.speed * 0.0005 * frames;
    const rollY = config.roll ? rollTh : 0;

    // spin each gear: th += speed*(pi/100)*dir per original-frame (continuous).
    for (const e of gearsArr) {
      e.th += config.speed * (Math.PI / 100) * e.dir * frames;
      updateGearMatrix(e, rollY);
    }

    // Whole-ring tumble: tick rotator at the original cadence, interpolate.
    rotAccum += frames;
    let ticks = 0;
    while (rotAccum >= 1 && ticks < MAX_TICKS) { tickRotator(); rotAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) rotAccum = 0;
    const a = rotAccum;

    // rotation: get_rotation, then the fixed tilt x-=0.14, y-=0.06 (always applied).
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
      for (const e of gearsArr) e.mesh.geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { reset(); },
    config,
    params,
  };
}

export default { title, info, start };
