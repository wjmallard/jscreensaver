// three-hack.js — a small three.js harness that mounts real-geometry hacks (the
// hacks/glx/*.c pool from xscreensaver: meshes, matrices, lighting), the way
// ./shadertoy.js mounts the GLSL-shader pool.
//
//   startThreeHack(hostCanvas, { init, frame, dispose, reinit, config, params })
//     -> { stop, pause, resume, reinit, getStats, config, params }
//
// Why three.js: these hacks are rasterized geometry, and three.js already *is*
// the lowest-common-denominator primitive layer they need — BufferGeometry,
// meshes, materials, lights, the scene-graph matrix math, ParametricGeometry /
// TubeGeometry / loaders. Porting a hack is mostly: delete its fixed-function GL
// boilerplate (three.js subsumes it) and re-express the algorithm underneath as
// three.js geometry. See docs/three-js-harness-plan.md.
//
// Same overlay-canvas trick as shadertoy.js: the host owns one shared <canvas>
// locked to a '2d' context, so we can never get a 'webgl' context on it. Each GL
// hack overlays its OWN canvas exactly covering the host canvas and removes it on
// stop(); pointer-events:none lets the click that summons the picker fall through.
//
// The hack supplies callbacks and owns its own state object:
//   init(ctx) -> state      ctx = { THREE, scene, camera, renderer }. Build
//                           geometry, add it to scene, return any per-frame state.
//   frame(state, fctx)      fctx = { dt, elapsed, THREE, scene, camera, renderer }.
//                           dt is seconds, already scaled by config.speed; advance
//                           the animation here.
//   dispose(state)          optional; free anything init() put outside the scene
//                           graph (scene meshes are auto-disposed on stop()).
//   reinit(state, ctx)      optional; re-randomize on the picker's "new region" key.
//
// Honored config key (a hack may expose it as a param or not):
//   config.speed   animation-rate multiplier on dt / elapsed (default 1).
//
// getStats() mirrors the shadertoy harness so the host #fps readout is uniform
// across 2D / shader / geometry hacks. Geometry isn't fill-bound the way
// ray-marching is, so scale is pinned at 1 (no adaptive-resolution trimming).

import * as THREE from 'three';

export function startThreeHack(hostCanvas, hack = {}) {
  const config = hack.config || {};

  // Our own canvas, laid exactly over the host canvas — see header. z-index:1
  // keeps it above the host canvas but below the host chrome (>= 99998);
  // pointer-events:none lets clicks reach the host's "open picker" handler.
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 6);

  // A neutral default light rig (key + sky/ground fill) so a hack "looks lit" out
  // of the box. A hack may add to or replace these via ctx.scene in init().
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  const fill = new THREE.HemisphereLight(0xbfd4ff, 0x202028, 0.7);
  scene.add(key, fill);

  // lights are exposed so a hack can retune the default rig (intensity, color)
  // in init() rather than fight it — e.g. a vertex-colored surface wants flatter,
  // more even light than a single-material object does.
  const ctx = { THREE, scene, camera, renderer, lights: { key, fill } };
  const state = hack.init ? hack.init(ctx) : {};

  // Keep the drawing buffer matched to viewport * DPR. Cheap to check each frame,
  // so window resizes and DPR changes (dragging between monitors) all flow
  // through one path; a resize listener covers the paused case too.
  let cssW = 0;
  let cssH = 0;
  let curDpr = 0;
  function syncSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w === cssW && h === cssH && dpr === curDpr) return;
    cssW = w;
    cssH = h;
    curDpr = dpr;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);   // false: CSS size stays pinned at 100% by style
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  let rafId = 0;
  let lastNow = 0;
  let elapsed = 0;      // seconds, scaled by speed
  let frameMs = 16;     // smoothed real frame time (EMA), ms — seeds the getStats ms
  const stats = { ms: 16 };

  function render(now) {
    syncSize();

    if (lastNow === 0) lastNow = now;
    let dtMs = now - lastNow;
    lastNow = now;
    if (dtMs < 0) dtMs = 0;
    if (dtMs > 100) dtMs = 100;   // clamp big gaps (backgrounded tab) so motion stays smooth

    frameMs += (dtMs - frameMs) * 0.1;
    stats.ms = frameMs;

    const speed = config.speed == null ? 1 : config.speed;
    const dt = (dtMs / 1000) * speed;
    elapsed += dt;
    if (hack.frame) hack.frame(state, { dt, elapsed, ...ctx });

    renderer.render(scene, camera);
    rafId = requestAnimationFrame(render);
  }

  function onResize() {
    syncSize();   // keep the buffer correct even while paused (no rAF running)
  }
  window.addEventListener('resize', onResize);

  syncSize();
  rafId = requestAnimationFrame(render);

  return {
    stop() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      window.removeEventListener('resize', onResize);
      if (hack.dispose) hack.dispose(state);
      scene.traverse((o) => {
        o.geometry?.dispose?.();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
        else m?.dispose?.();
      });
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    },
    resume() {
      if (!rafId) { lastNow = 0; rafId = requestAnimationFrame(render); }
    },
    reinit() {
      if (hack.reinit) hack.reinit(state, ctx);
    },
    getStats() {
      return { ms: stats.ms, scale: 1, w: canvas.width, h: canvas.height };
    },
    config,
    params: hack.params,
  };
}
