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

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding). Disable three's color management so the
// port matches GL: set at MODULE SCOPE (before start() fills colors) so the
// setRGB(..., SRGBColorSpace) calls become no-ops and store RAW glColor, and the output
// is not sRGB-encoded. Without this, lit/shaded faces render up to ~2.5x too bright
// (measured vs the rubikblocks grayscale ground truth).
THREE.ColorManagement.enabled = false;

export const title = 'cubicgrid';

export const info = {
  author: 'Vasek Potocek',
  description: 'A rotating lattice of colored points.',
  year: 2007,
};

export function start(hostCanvas) {
  const TICKS = 30;      // grid divisions per axis (cubicgrid.c DEF_DIV)
  const SIZE = 20;       // lattice extent in world units (DEF_ZOOM)
  const DOT_PX = 1.0;    // on-screen dot size, CSS px (orig "bigdots" ~2.5; smaller = finer)
  const CAM_Z = 18;      // observer distance (matches the video: lattice fills the frame)

  // delay (us) scales the spin around the xml default 20000; OVERHEAD encodes the
  // ~2x per-frame overhead so the default reproduces the measured pace. cubicgrid's
  // rotation is continuous (dt-scaled), so it stays smooth at any speed.
  const OVERHEAD = 37500;
  const REF_DELAY = 20000 + OVERHEAD;   // delay factor == 1 at the xml default

  // Live config. Keys/ranges/defaults/labels transcribed 1:1 from
  // hacks/config/cubicgrid.xml (the host renders the box from `params`, mutating
  // `config`). `speed` and `delay` both scale the spin (as in the original); `zoom`
  // is dot spacing; `bigdots` toggles dot size. (symmetry: only cubic is ported.)
  const config = {
    delay: 20000,     // us, frame rate (xml default; invert slider)
    speed: 1.0,       // spin-rate multiplier (xml --speed; ratio)
    zoom: 20,         // dot spacing / lattice extent (xml --zoom; DEF_ZOOM)
    bigdots: true,    // big vs fine dots (xml --bigdots, default on)
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.2, max: 10, step: 0.1, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'zoom', label: 'Dot spacing', type: 'range', min: 15, max: 100, step: 1, default: 20, lowLabel: 'close', highLabel: 'far', live: true },
    { key: 'bigdots', label: 'Big dots', type: 'checkbox', default: true, live: true },
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
  // (x,y,z)/TICKS; with color management disabled (module scope) the setRGB call
  // stores the RAW value and the output is not re-encoded, so each point displays
  // as the original's direct glColor3f(x,y,z) value.
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
    // speed x delay-factor both scale the spin (continuous/dt-scaled -> smooth).
    const rate = config.speed * (REF_DELAY / (config.delay + OVERHEAD));
    points.rotation.x += dt * SPIN.x * rate;
    points.rotation.y += dt * SPIN.y * rate;
    points.rotation.z += dt * SPIN.z * rate;
    mat.size = (config.bigdots ? DOT_PX : DOT_PX * 0.5) * dpr;   // live dot size
    points.scale.setScalar(config.zoom / SIZE);                  // live dot spacing
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
