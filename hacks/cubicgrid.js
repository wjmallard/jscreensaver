// cubicgrid.js — "Cubic Grid" as a self-contained, mountable three.js module.
// start(canvas) -> { stop, pause, resume, getStats }.
//
// After xscreensaver's cubicgrid (Vasek Potocek, 2007), hacks/glx/cubicgrid.c.
// A finite ticks^3 lattice of points, colored by position in the RGB cube, seen
// from close in as it tumbles — rows line up and "view-throughs" open and evolve.
//
// Self-contained on purpose: its own overlay canvas + renderer + render loop, no
// shared geometry harness. It only follows the host's mountable-module contract
// (start(canvas) -> a handle with stop/pause/resume/getStats).
//
// Faithful to the .c:
//   * ticks = 30 -> 27,000 points; symmetry = cubic (integer lattice).
//   * point color = (x, y, z) / ticks (the RGB cube; the (0,0,0) corner is black
//     and so invisible on the black background).
//   * CONSTANT pixel point size (fixed-function glPointSize, no distance
//     attenuation) — near and far dots are the same size; that is what makes the
//     view-throughs read.
//   * NO depth test (the .c never enables GL_DEPTH_TEST nor clears a depth buffer).
//   * 30-degree perspective; the lattice is centered, scaled to `size` units, and
//     sits ~18 units in front of the observer.
// The hexagonal-symmetry variant is a documented option in the original, not yet
// ported here.

import * as THREE from 'three';

export const title = 'cubicgrid';

export const info = {
  author: 'Vasek Potocek',
  description: 'A finite 3D lattice of dots, colored by position in the RGB cube, seen from within as it slowly tumbles \u2014 rows align and view-throughs open and evolve.',
  year: 2007,
};

export function start(hostCanvas) {
  const TICKS = 30;      // grid divisions per axis (cubicgrid.c DEF_DIV)
  const SIZE = 20;       // lattice extent in world units (DEF_ZOOM)
  const DOT_PX = 1.0;    // on-screen dot size, CSS px (orig "bigdots" ~2.5; smaller = finer)
  const CAM_Z = 18;      // observer distance (matches the video: lattice fills the frame)

  // Live config: the host renders a settings box from `params` and mutates
  // `config` in place; the loop reads it each frame. Maps to the .c's spin / -bigdots.
  const config = {
    speed: 1.0,      // spin-rate multiplier (1.0 = the tuned pace)
    dotSize: 1.0,    // on-screen point size, CSS px (the .c's -bigdots)
  };
  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 3, step: 0.05, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'dotSize', label: 'Dot size', type: 'range', min: 0.5, max: 4, step: 0.5, default: 1.0, lowLabel: 'fine', highLabel: 'bold', live: true },
  ];

  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  // Our own overlay canvas — the host's shared canvas is locked to a 2D context.
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // 30-degree perspective; observer out in front, looking into the lattice.
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, CAM_Z);   // .c uses 18 (observer inside); pulled back a little

  // Build the lattice: TICKS^3 points, centered, scaled to SIZE units. Color =
  // (x,y,z)/TICKS authored in sRGB and stored linear, so it displays as the
  // original's direct glColor3f values under the renderer's sRGB output.
  const count = TICKS * TICKS * TICKS;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const scl = SIZE / TICKS;
  const off = TICKS / 2;
  const col = new THREE.Color();
  let p = 0;
  for (let x = 0; x < TICKS; x++) {
    for (let y = 0; y < TICKS; y++) {
      for (let z = 0; z < TICKS; z++) {
        positions[p * 3] = (x - off) * scl;
        positions[p * 3 + 1] = (y - off) * scl;
        positions[p * 3 + 2] = (z - off) * scl;
        col.setRGB(x / TICKS, y / TICKS, z / TICKS, THREE.SRGBColorSpace);
        colors[p * 3] = col.r;
        colors[p * 3 + 1] = col.g;
        colors[p * 3 + 2] = col.b;
        p++;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: DOT_PX * dpr,               // CSS px -> device px
    sizeAttenuation: false,           // constant screen size, like fixed-function GL_POINTS
    vertexColors: true,
    depthTest: false,                 // the .c uses no depth buffer
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  // The .c spins via a wandering 3-axis rotator; a steady multi-axis tumble at
  // slightly different rates reproduces the evolving view-throughs. Tuned calm.
  const SPIN = { x: 0.075, y: 0.085, z: 0.05 };   // rad/sec — net ~0.12 (quarter of the measured rate)

  function syncSize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  syncSize();
  window.addEventListener('resize', syncSize);

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
    const dt = Math.min(frame / 1000, 0.1);
    points.rotation.x += dt * SPIN.x * config.speed;
    points.rotation.y += dt * SPIN.y * config.speed;
    points.rotation.z += dt * SPIN.z * config.speed;
    mat.size = config.dotSize * dpr;   // live dot size
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { points.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2); },
    config,
    params,
  };
}
