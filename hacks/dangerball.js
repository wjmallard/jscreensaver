// dangerball.js -- "DangerBall" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
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
//   * spikes; pulse growth 0.05/frame; sphere unit_sphere(16,32); spike cone
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
//   * 128-entry smooth colormap; ball = colors[ccolor] (glossy, cyan highlight),
//     spikes = colors[(ccolor+shift)%128] (matte: no specular).
//   * one white directional light from (1,1,1), ambient 0.
//
// Motion (rotator.js), palette (colormap.js) and RNG (yarandom.js) are faithful
// standalone ports.
//
// PACING -- render rate and motion speed are INDEPENDENT axes (so slowing down
// never gets jittery, unlike a per-step-rate "speed" knob). We render every rAF;
// motion is a CONTINUOUS velocity. `delay` (us, from the .xml) sets the original's
// effective frame rate as effFps = 1e6/(delay+OVERHEAD); OVERHEAD encodes the ~2x
// per-frame overhead measured for the real hack, so the .xml default delay 30000
// lands at the faithful ~15fps / ~2.7s pulse (see the frame-rate-calibration note).
// One render frame advances `frames = dt*effFps` original-frames of motion: the
// pulse/color/wander advance continuously by `frames`, while the rotator's discrete
// random-walk is ticked once per original-frame and INTERPOLATED between ticks --
// smooth render AND the original's per-frame event cadence preserved.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';
import { makeSmoothColormap } from './colormap.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding). Disable three's color management so the
// port matches GL: colors are used raw (setRGB(..., SRGBColorSpace) becomes a no-op) and
// the output is not sRGB-encoded. Without this, lit/shaded faces render up to ~2.5x too
// bright (measured vs the rubikblocks grayscale ground truth).
THREE.ColorManagement.enabled = false;

export const title = 'dangerball';

export const info = {
  author: 'Jamie Zawinski',
  year: 2001,
  description: 'A spiky ball. Ouch!',
};

export function start(hostCanvas, opts = {}) {
  // ---- constants (dangerball.c DEFAULTS / #defines) ----
  const MAX_SPIKES = 100;      // xml count high=100; we build this many, show config.count
  const SPIKE_FACES = 12;      // SPIKE_FACES
  const NCOLORS = 128;         // bp->ncolors
  const DIAM = 0.2;            // draw_spikes: spike thickness scale
  const ROT_SCALE = 22;        // randomize_spikes quantization
  const DEG = Math.PI / 180;
  const OVERHEAD = 37500;      // us; calibrates the xml default delay 30000 -> ~15fps (the measured effective rate)

  // Live config. Keys/ranges/defaults/labels transcribed 1:1 from
  // hacks/config/dangerball.xml (the host renders the box from `params` and
  // mutates `config` in place). `delay` is the original's frame-rate knob, here a
  // smooth speed control; `spikespeed` is the .xml --speed (pulse growth).
  const config = {
    delay: 30000,       // us, frame rate / overall speed (xml default; invert slider)
    spikespeed: 0.05,   // pulse growth per original-frame (xml --speed / DEF_SPEED)
    count: 30,          // number of spikes shown (xml --count)
    wander: true,       // drift through space (do_wander)
    spin: true,         // tumble (do_spin)
    wire: false,        // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'spikespeed', label: 'Spike growth', type: 'range', min: 0.001, max: 0.25, step: 0.001, default: 0.05, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'count', label: 'Number of spikes', type: 'range', min: 1, max: 100, step: 1, default: 30, lowLabel: 'few', highLabel: 'ouch', live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'spin', label: 'Spin', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const seed = opts.seed || 0;            // 0 => time-seeded (random per run)
  const rng = makeYaRandom(seed);

  // ---- RNG-consuming init, in init_ball's order: rotator, colormap, spikes ----
  // do_spin & do_wander default True; spin_speed 10, spin_accel 2, wander 0.12.
  // (No speed-scaling baked in: the rotator runs at the original rate; pacing is
  // applied by ticking it at effFps below, with interpolation for smoothness.)
  const rot = makeRotator(
    {
      spinX: 10, spinY: 10, spinZ: 10,
      spinAccel: 2.0,
      wanderSpeed: 0.12,
      randomize: true,
    },
    rng,
  );

  const cmap = makeSmoothColormap(rng, NCOLORS);
  const colors = cmap.map((c) => new THREE.Color().setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace));

  // spike azimuth/elevation pairs (degrees), and pulse/color state. We randomize
  // all MAX_SPIKES and show config.count of them (so the count slider is instant).
  const spikes = new Int32Array(MAX_SPIKES * 2);
  let pos = 0;            // pulse position, -1..+1; sign = retract phase (continuous).
  let colorShift = 0;
  let ccolor = 0;        // color-cycle cursor (float; index = floor(ccolor)).

  function randomizeSpikes() {
    pos = 0;
    for (let i = 0; i < MAX_SPIKES; i++) {
      spikes[i * 2]     = (rng.random() % 360) - 180;
      spikes[i * 2 + 1] = (rng.random() % 180) - 90;
    }
    // Quantize with C-style truncation toward zero (NOT floor).
    for (let i = 0; i < MAX_SPIKES * 2; i++)
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

  // Ball: glossy, shininess 200. The .c's highlight color = light_specular
  // (cyan {0,1,1}) x material_specular; three has no separate light-specular
  // color (light.color stays white for the diffuse), so we fold the cyan onto the
  // MATERIAL specular here -- the highlight is light.color * material.specular = a
  // cyan highlight. Dimmed/tightened so the PI light intensity doesn't blow it out.
  const ballMat = new THREE.MeshPhongMaterial({
    color: 0x000000,
    specular: 0x004040,   // dim cyan -> small, cyan-tinted specular highlight
    shininess: 200,
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

  // MAX_SPIKES cone meshes sharing the geometry + matte material; matrices rebuilt
  // each frame (cheap), with the first config.count made visible (count slider).
  const spikeMeshes = [];
  for (let i = 0; i < MAX_SPIKES; i++) {
    const m = new THREE.Mesh(coneGeo, spikeMat);
    m.matrixAutoUpdate = false;        // we set m.matrix by hand.
    spikesGroup.add(m);
    spikeMeshes.push(m);
  }
  const tmpM = new THREE.Matrix4();

  function updateSpikeMatrices() {
    // draw_spikes: |pos| -> eased length.
    const pp = pos < 0 ? -pos : pos;
    const len = (Math.asin(0.5 + pp / 2) - 0.5) * 2;
    const n = config.count;
    for (let i = 0; i < MAX_SPIKES; i++) {
      const vis = i < n;
      spikeMeshes[i].visible = vis;
      if (!vis) continue;
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

  // move_spikes, made CONTINUOUS: advance |pos| by `d` this frame. pos runs
  // 0->1 (outward), flips to -1 at apex, -1->0 (inward), then a fresh set.
  function advancePulse(d) {
    if (pos >= 0) { pos += d; if (pos >= 1) pos = -1; }
    else { pos += d; if (pos >= 0) randomizeSpikes(); }
  }

  // ---- rotator sampling + interpolation (the discrete random-walk) ----
  // We tick the rotator once per original-frame (at effFps) and interpolate the
  // rendered orientation/position between the last two samples, so the tumble is
  // smooth at any speed while keeping the original per-frame event cadence.
  const r0 = rot.getRotation(false);
  const p0 = rot.getPosition(false);
  let prevR = { ...r0 }, curR = { ...r0 };
  let prevP = { ...p0 }, curP = { ...p0 };
  let rotAccum = 0;
  function tickRotator() {
    prevR = curR; curR = rot.getRotation(true);
    prevP = curP; curP = rot.getPosition(true);
  }
  // shortest-path lerp on the [0,1) rotation circle (rotx etc. are abs, wrap at 1).
  function lerpAngle(a, b, t) {
    let d = b - a;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    return a + d * t;
  }
  const lerp = (a, b, t) => a + (b - a) * t;

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

  // ---- render loop: continuous motion at effFps, rotator interpolated ----
  const MAX_TICKS = 8;         // rotator catch-up cap (avoids spiral after a stall)
  let raf = 0;
  let last = 0;
  let paused = false;
  let ms = 16;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);   // original-frames per second (live)
    const frames = dt * effFps;                        // original-frames of motion this render-frame

    // Continuous: pulse + color advance smoothly (no per-step jitter).
    advancePulse(config.spikespeed * frames);
    ccolor = (ccolor + frames) % NCOLORS;

    // Discrete random-walk: tick at the original cadence, interpolate for render.
    rotAccum += frames;
    let ticks = 0;
    while (rotAccum >= 1 && ticks < MAX_TICKS) { tickRotator(); rotAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) rotAccum = 0;   // drop backlog after a stall
    const a = rotAccum;                       // [0,1) interpolation fraction

    // Render (mirrors draw_ball's modelview + colors).
    if (config.spin) {
      // glRotatef x,y,z (deg) == three Euler 'XYZ' == Rx*Ry*Rz; rotx in [0,1) -> *2pi.
      rotG.rotation.set(
        lerpAngle(prevR.x, curR.x, a) * 2 * Math.PI,
        lerpAngle(prevR.y, curR.y, a) * 2 * Math.PI,
        lerpAngle(prevR.z, curR.z, a) * 2 * Math.PI,
        'XYZ',
      );
    } else rotG.rotation.set(0, 0, 0);

    if (config.wander) {
      trans.position.set(
        (lerp(prevP.x, curP.x, a) - 0.5) * 8,
        (lerp(prevP.y, curP.y, a) - 0.5) * 8,
        (lerp(prevP.z, curP.z, a) - 0.5) * 15,
      );
    } else trans.position.set(0, 0, 0);

    const ci = Math.floor(ccolor) % NCOLORS;
    ballMat.color.copy(colors[ci]);
    spikeMat.color.copy(colors[(ci + colorShift) % NCOLORS]);
    ballMat.wireframe = spikeMat.wireframe = config.wire;

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
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { randomizeSpikes(); },   // fresh spike directions + colors (host 're-seed')
    config,
    params,
  };
}

export default { title, info, start };
