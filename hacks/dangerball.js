// dangerball.js -- "DangerBall" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats }.
//
// Faithful port of xscreensaver's dangerball (Jamie Zawinski, 2001),
// hacks/glx/dangerball.c. A glossy sphere bristling with matte cone spikes that
// pulse outward, retract, then re-randomize to new directions/colors; the whole
// object spins and wanders through space while the colors slowly cycle.
//
// Self-contained on purpose: its own overlay canvas + renderer + render loop, no
// shared geometry harness. It only follows the host's mountable-module contract
// (start(canvas) -> a handle with stop/pause/resume/getStats), exactly as
// cubicgrid.js does.
//
// Faithful to the .c:
//   * 30 spikes; pulse speed 0.05/frame; sphere unit_sphere(16,32); spike cone
//     cone(diameter=1, 12 faces, smooth, no cap) -- which in tube.c is a BASE-
//     RADIUS-1 cone from y=0 (base) to y=1 (tip), so we rebuild that exact
//     primitive (radial smooth normals) rather than three's ConeGeometry.
//   * randomize_spikes(): per spike, azimuth=(rand%360)-180 about Y, elevation=
//     (rand%180)-90 about Z, each quantized (trunc) to multiples of 22; an
//     occasional color_shift = rand%(ncolors/2).
//   * the pulse state machine + asin() length easing from draw_spikes/move_spikes.
//   * draw_ball's exact modelview nesting: Scale(1.1)*Translate(wander)*
//     Rotate(spin)*Scale(2.0)*{sphere, spikes}; the per-spike transform
//     Ry(az)*Rz(el)*T(0.7)*Rz(-90)*Scale(0.2,len,0.2).
//   * 128-entry smooth colormap; ball = colors[ccolor] (glossy: white specular,
//     shininess 128), spikes = colors[(ccolor+shift)%128] (matte: no specular).
//   * one white directional light from (1,1,1), ambient 0.
//
// Motion (rotator.js), palette (colormap.js) and RNG (yarandom.js) are faithful
// standalone ports, consumed here in the SAME ORDER as init_ball/draw_ball so a
// fixed seed reproduces the original's structural choices.
//
// Frame-rate independence + faithful pace: the .c's `delay 30000` is only a
// *floor* (nominal ~33fps); the original's real effective rate is ~15fps once
// per-frame draw/vsync/event overhead is counted. Measured from jwz's demo video
// (object-tracking the pulse: 40 fixed steps per extend/retract cycle, period
// ~2.7s => ~15fps). So we step the simulation at a fixed 15 logical fps via the
// accumulator below — refresh-rate independent, and matching the original's pace
// (an assumed 30fps ran the whole hack ~2x too fast).

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';
import { makeSmoothColormap } from './colormap.js';

export const title = 'dangerball';

export const info = {
  author: 'Jamie Zawinski',
  year: 2001,
  description: 'A glossy sphere bristling with matte spikes that pulse outward and retract, re-aiming each cycle, as it tumbles and drifts through space and its colors slowly cycle.',
};

export function start(hostCanvas, opts = {}) {
  // ---- constants (dangerball.c DEFAULTS / #defines) ----
  const COUNT = 30;            // MI_COUNT: spike count
  const SPEED = 0.05;          // DEF_SPEED: the original's per-frame pulse increment
  const SPIKE_FACES = 12;      // SPIKE_FACES
  const NCOLORS = 128;         // bp->ncolors
  const DIAM = 0.2;            // draw_spikes: spike thickness scale
  const ROT_SCALE = 22;        // randomize_spikes quantization
  const DEG = Math.PI / 180;

  // Render/step at 30fps for SMOOTH motion (the original's true ~15fps effective
  // rate looked jittery), but scale every per-step motion by SPEED_SCALE so the
  // WALL-CLOCK pace still matches the original (= the youtube demo): 30 steps/sec
  // x 0.5 == 15 steps/sec at full speed. Applies to the spike pulse, the spin,
  // the wander, AND the color cycle. (Measured effective rate ~15fps: a ~2.7s,
  // 40-step pulse; `delay 30000` is only a floor -- real overhead ~doubles it.)
  const FPS = 30;
  const SPEED_SCALE = 0.5;

  const seed = opts.seed || 0;            // 0 => time-seeded (random per run)
  const rng = makeYaRandom(seed);

  // ---- RNG-consuming init, in init_ball's order: rotator, colormap, spikes ----
  // do_spin & do_wander default True; spin_speed 10, spin_accel 2, wander 0.12.
  const rot = makeRotator(
    {
      // spin/wander x SPEED_SCALE: the rotator's velocity scales linearly with
      // these, so 30 steps/sec at half-speed == the original's 10 / 0.12 at
      // ~15 steps/sec, same wall-clock rate. (Original values: spin 10, wander 0.12.)
      spinX: 10 * SPEED_SCALE, spinY: 10 * SPEED_SCALE, spinZ: 10 * SPEED_SCALE,
      spinAccel: 2.0,
      wanderSpeed: 0.12 * SPEED_SCALE,
      randomize: true,
    },
    rng,
  );

  const cmap = makeSmoothColormap(rng, NCOLORS);
  const colors = cmap.map((c) => new THREE.Color().setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace));

  // spike azimuth/elevation pairs (degrees), and pulse/color state.
  const spikes = new Int32Array(COUNT * 2);
  let pos = 0;            // pulse position, -1..+1; sign = retract phase.
  let colorShift = 0;
  let ccolor = 0;        // color-cycle cursor (float; index = floor, advances SPEED_SCALE/step).

  function randomizeSpikes() {
    pos = 0;
    for (let i = 0; i < COUNT; i++) {
      spikes[i * 2]     = (rng.random() % 360) - 180;
      spikes[i * 2 + 1] = (rng.random() % 180) - 90;
    }
    // Quantize with C-style truncation toward zero (NOT floor).
    for (let i = 0; i < COUNT * 2; i++)
      spikes[i] = Math.trunc(spikes[i] / ROT_SCALE) * ROT_SCALE;

    if ((rng.random() % 3) === 0) colorShift = rng.random() % (NCOLORS / 2);
    else colorShift = 0;
  }
  randomizeSpikes();   // init_ball calls this last.

  // ---- our own overlay canvas (host's shared canvas is locked to 2D) ----
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // gluPerspective(30, aspect, 1, 100) + gluLookAt(0,0,30, 0,0,0, 0,1,0).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // One white directional light from (1,1,1) (GL pos {1,1,1,0}, w=0 => parallel).
  // intensity PI gives the classic "diffuse = albedo*NdotL" full-bright lit side
  // under three's physically-based lighting (r155+); ambient stays 0 (faithful:
  // the .c uses ambient {0,0,0}, so unlit faces are black). The .c's light also
  // has a cyan {0,1,1} SPECULAR; three has no separate light-specular color, so
  // that cyan is folded onto the ball material's specular instead (see below) --
  // the highlight is light.color * material.specular, same product.
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(1, 1, 1);
  scene.add(light);

  // ---- geometry: a faithful unit_cone replica + a sphere ----
  // unit_cone(faces, smooth): `faces` triangles (base point A, tip, base point
  // B); base ring radius 1 at y=0, tip at (0,1,0); smooth => radial own-normals
  // on the base, mid-plane normal on the tip (all horizontal -- the original
  // shades a spike like a cylinder, not a true cone). cap_p=False => no base disc.
  function makeUnitCone(faces) {
    const step = (Math.PI * 2) / faces;
    const s2 = step / 2;
    const positions = [];
    const normals = [];
    let th = 0;
    let x = 1, y = 0;
    let x0 = Math.cos(s2), y0 = Math.sin(s2);
    for (let i = 0; i < faces; i++) {
      positions.push(x, 0, y);          // bottom point A
      normals.push(x, 0, y);            // smooth: its own (radial) normal

      positions.push(0, 1, 0);          // tip
      normals.push(x0, 0, y0);          // mid-plane normal

      th += step;
      x0 = Math.cos(th + s2); y0 = Math.sin(th + s2);
      x = Math.cos(th); y = Math.sin(th);

      positions.push(x, 0, y);          // bottom point B
      normals.push(x, 0, y);            // smooth: its own normal
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    return g;
  }

  const coneGeo = makeUnitCone(SPIKE_FACES);
  const sphereGeo = new THREE.SphereGeometry(1, 32, 16);   // unit_sphere(16,32)

  // Ball: glossy, shininess 128. The .c's highlight color = light_specular
  // (cyan {0,1,1}) x material_specular (white {1,1,1}) = CYAN. three has no
  // separate light-specular color (light.color stays white for the diffuse), so
  // we fold the cyan onto the MATERIAL specular here -- the highlight is
  // light.color * material.specular = white * cyan = the same cyan. Spikes: matte
  // (specular black => no highlight). color = AMBIENT_AND_DIFFUSE => diffuse `color`.
  const ballMat = new THREE.MeshPhongMaterial({
    color: 0x000000,
    // Cyan highlight, scaled DOWN: full-cyan x the PI light intensity blew out a
    // big white core, so we dim the material specular (smaller clipped core +
    // dimmer) and raise shininess a bit to tighten the spot.
    specular: 0x004040,   // dim cyan (~0.25) instead of full 0x00ffff
    shininess: 200,       // tighter highlight (was 128)
  });
  const spikeMat = new THREE.MeshPhongMaterial({
    color: 0x000000,
    specular: 0x000000,
    shininess: 0,
  });

  // ---- nested groups mirroring draw_ball's modelview ----
  //   outer  : Scale(1.1)            (and the reshape aspect fit, set in syncSize)
  //   trans  : Translate(wander)
  //   rotG   : Rotate(spin)
  //   inner  : Scale(2.0)            holds the sphere + the spikes
  const outer = new THREE.Group();
  const trans = new THREE.Group();
  const rotG = new THREE.Group();
  const inner = new THREE.Group();
  inner.scale.setScalar(2.0);
  const spikesGroup = new THREE.Group();

  const sphereMesh = new THREE.Mesh(sphereGeo, ballMat);
  inner.add(sphereMesh);
  inner.add(spikesGroup);
  rotG.add(inner);
  trans.add(rotG);
  outer.add(trans);
  scene.add(outer);

  // 30 cone meshes sharing the geometry + matte material; matrices rebuilt each
  // frame (only 30, cheap) to match draw_spikes exactly.
  const spikeMeshes = [];
  for (let i = 0; i < COUNT; i++) {
    const m = new THREE.Mesh(coneGeo, spikeMat);
    m.matrixAutoUpdate = false;        // we set m.matrix by hand.
    spikesGroup.add(m);
    spikeMeshes.push(m);
  }
  const tmpM = new THREE.Matrix4();

  function updateSpikeMatrices() {
    // draw_spikes: pos -> eased length.
    const pp = pos < 0 ? -pos : pos;
    const len = (Math.asin(0.5 + pp / 2) - 0.5) * 2;
    for (let i = 0; i < COUNT; i++) {
      const az = spikes[i * 2] * DEG;        // rotate about Y
      const el = spikes[i * 2 + 1] * DEG;    // rotate about Z
      const m = spikeMeshes[i].matrix;
      m.makeRotationY(az);                              // Ry(az)
      m.multiply(tmpM.makeRotationZ(el));              // * Rz(el)
      m.multiply(tmpM.makeTranslation(0.7, 0, 0));     // * T(0.7,0,0)
      m.multiply(tmpM.makeRotationZ(-Math.PI / 2));    // * Rz(-90)
      m.multiply(tmpM.makeScale(DIAM, len, DIAM));     // * S(diam,len,diam)
      spikeMeshes[i].matrixWorldNeedsUpdate = true;
    }
  }

  // move_spikes: one original-frame step of the pulse state machine.
  function moveSpikesStep() {
    if (pos >= 0) {                 // moving outward
      pos += SPEED * SPEED_SCALE;
      if (pos >= 1) pos = -1;       // reverse gears at apex
    } else {                        // moving inward
      pos += SPEED * SPEED_SCALE;
      if (pos >= 0) randomizeSpikes();   // stop at end -> new set (sets pos=0)
    }
  }

  // One simulation step == one draw_ball pass. A fixed-timestep accumulator
  // (below) runs this at a constant 30 steps/sec on any display, so motion renders
  // smoothly; each step's motion is scaled by SPEED_SCALE so the wall-clock pace
  // matches the original's ~15fps. Mirrors draw_ball's order: position, rotation
  // (consumes RNG), color, pulse.
  let lastP = rot.getPosition(false);
  let lastR = rot.getRotation(false);
  let drawColor = 0;
  function simStep() {
    lastP = rot.getPosition(true);
    lastR = rot.getRotation(true);
    drawColor = Math.floor(ccolor);           // color index for this frame
    ccolor += SPEED_SCALE;                     // x0.5: cycle at the original's wall-clock rate
    if (ccolor >= NCOLORS) ccolor -= NCOLORS;
    moveSpikesStep();
  }

  // ---- sizing (reshape_ball: gluPerspective + the portrait fit scale) ----
  function syncSize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // reshape_ball's glScalef(s,s,s): shrink to fit when portrait. Folds with the
    // constant Scale(1.1) onto the outer group (both are uniform pre-scales).
    const s = (w < h ? w / h : 1);
    outer.scale.setScalar(s * 1.1);
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop: 30Hz fixed-timestep sim + render-on-each-rAF-frame ----
  const STEP = 1 / FPS;        // logical tick period (~the .c's delay 30000us)
  const MAX_STEPS = 6;         // catch-up cap (avoids spiral after a long stall)
  let raf = 0;
  let last = 0;
  let acc = 0;
  let paused = false;
  let ms = 16;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    // Advance the simulation at a constant 30 steps/sec regardless of refresh.
    acc += Math.min(frame / 1000, 0.25);
    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS) {
      simStep();
      acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS) acc = 0;   // drop backlog after a stall

    // Render the current sim state (mirrors draw_ball's modelview + colors).
    trans.position.set((lastP.x - 0.5) * 8, (lastP.y - 0.5) * 8, (lastP.z - 0.5) * 15);
    // glRotatef x,y,z (degrees) == three Euler 'XYZ' (radians) == Rx*Ry*Rz.
    rotG.rotation.set(lastR.x * 2 * Math.PI, lastR.y * 2 * Math.PI, lastR.z * 2 * Math.PI, 'XYZ');

    ballMat.color.copy(colors[drawColor]);
    spikeMat.color.copy(colors[(drawColor + colorShift) % NCOLORS]);

    updateSpikeMatrices();
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      coneGeo.dispose();
      sphereGeo.dispose();
      ballMat.dispose();
      spikeMat.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; acc = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
  };
}

export default { title, info, start };
