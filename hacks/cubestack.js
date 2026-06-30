// cubestack.js -- "Cube Stack" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's cubestack (Jamie Zawinski, 2016),
// hacks/glx/cubestack.c. An endless stack of unfolding, translucent cubes: each "cube"
// is six square picture-FRAMES (not solid) -- a frame = 4 trapezoidal struts forming the
// edges plus a little inward "+" stub at each edge midpoint. A cube is built one face at
// a time, each face folding up out of the plane (an eased rotation) as `state` advances
// 0..5; once a cube finishes it is committed to the stack and a fresh one starts
// unfolding on top. The whole stack marches forward, slowly spins about its axis, drifts
// (wander), and recolors from a looping smooth colormap.
//
// THE LOOK is additive translucency: the .c disables lighting + depth test and blends
// GL_SRC_ALPHA, GL_ONE, so overlapping struts GLOW (sum toward white) and you see through
// the frames. We reproduce that exactly: an unlit MeshBasicMaterial with
// THREE.AdditiveBlending, depthTest/depthWrite off, vertex colors carrying the
// alpha-premultiplied raw glColor. CRUCIAL: the renderer is opted out of three's color
// management (outputColorSpace = Linear, raw un-linearized colors) so additive overlaps
// accumulate in the same encoded space GL uses -- otherwise the hue washes to gray far
// too fast. No lighting, no normals.
//
// Self-contained three.js (own overlay canvas + renderer + loop), like cubestorm.js /
// dangerball.js. RNG = yarandom.js, wander = rotator.js, palette = colormap.js, the
// fold easing = easing.js (the same utils/easing.c the hack #includes). No assets.
//
// Faithful to the .c:
//   * draw_strut / draw_face / draw_cube_1 / draw_cubes transcribed verbatim as an
//     immediate-mode walk over a Matrix4 stack (glPushMatrix/glTranslatef/glRotatef ->
//     push/translate/rotate, GL post-multiply order). The geometry is tiny (<= ~7.5k
//     verts), so the whole tree is rebuilt into one BufferGeometry every frame, exactly
//     as the .c re-emits it -- no display lists, no per-face Object3Ds.
//   * the fold ratio r = ease(EASE_IN_OUT_SINE, frac(state)); the per-face alpha
//     modulation (COLORIZE: alpha = opacity * r2, where r2 is the face's own unfold
//     fraction or 1 once formed; the bottom face fades in as 1+state over state -1..0).
//   * the stack: `length` fully-formed cubes (state 5) marching +z by 1 each, only the
//     base cube (i == length-1) drawing its bottom face, then the top unfolding cube at
//     `state`; colors colors[ccolor - i - 1] down the stack (looping colormap).
//   * draw_cube modelview: S(portrait) * T(wander*{4,4,2}) * S(6) * Rx(-45) * Rz(20) *
//     Rz(spin); camera gluPerspective(30,1/h,1,100) + gluLookAt(0,0,30,...,up +y).
//   * per frame: state += speed*0.015, spin += speed*0.05; on state>6, commit (length++,
//     ccolor++, length capped 20). thickness clamped [0.001, 0.5], default 0.13.
//
// PACING -- render every rAF; advance the continuous state/spin by `frames =
// dt*effFps` (so the trajectory matches the original's per-frame step, sampled smoothly)
// and tick the wander rotator at effFps with interpolation (the geometry-track
// convention). effFps = 1e6/(delay+OVERHEAD), OVERHEAD = 37500 us as across the track.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';
import { makeSmoothColormap } from './colormap.js';
import { ease, EASE_IN_OUT_SINE } from './easing.js';

export const title = 'cubestack';

export const info = {
  author: 'Jamie Zawinski',
  year: 2016,
  description: 'An endless stack of unfolding, translucent cubes.',
};

export function start(hostCanvas, opts = {}) {
  const DEG = Math.PI / 180;
  const OVERHEAD = 37500;     // us; calibrates xml default delay 30000 -> ~15fps (track default)
  const NCOLORS = 32;         // bp->ncolors
  // Geometry cap: 21 cubes (length<=20 + 1 top) * 6 faces * 4 struts * 15 verts/strut
  // (a strut is 2 + 3 triangles when thin) = 7560; round up for slack.
  const MAX_VERTS = 8640;

  // Knobs transcribed 1:1 from hacks/config/cubestack.xml. `delay` first, invert slider.
  const config = {
    delay: 30000,      // us (xml default; invert slider)
    speed: 1.0,        // animation speed (xml --speed; state/spin rate)
    thickness: 0.13,   // strut width (xml --thickness)
    opacity: 0.7,      // per-cube alpha before additive blend (xml --opacity)
    wander: true,      // drift through space (do_wander)
    wire: false,       // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' µs', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Animation speed', type: 'range', min: 0.1, max: 10, step: 0.1, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'thickness', label: 'Thickness', type: 'range', min: 0.0, max: 0.5, step: 0.01, default: 0.13, lowLabel: 'thin', highLabel: 'thick', live: true },
    { key: 'opacity', label: 'Opacity', type: 'range', min: 0.01, max: 1.0, step: 0.01, default: 0.7, lowLabel: 'transparent', highLabel: 'opaque', live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);

  // ===================================================================
  //  three.js scene -- one additive, unlit, vertex-colored mesh
  // ===================================================================
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);
  // The .c is the GL fixed pipeline with NO color management: it blends the raw glColor
  // values (GL_SRC_ALPHA, GL_ONE) directly in display space and shows them as-is. Three
  // defaults to blending in LINEAR space + an sRGB output gamma, which makes additive
  // overlaps desaturate to white far too fast (the dominant channel saturates, the output
  // curve lifts the others -> gray). Opt this renderer out: feed it the raw glColor values
  // (un-linearized) and skip the output conversion, so additive accumulation happens in
  // the same encoded space GL uses and the result passes straight to the sRGB canvas.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // gluPerspective(30, w/h, 1, 100) + gluLookAt(0,0,30, 0,0,0, 0,1,0).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // The whole hack is unlit: color = the glColor value, drawn with GL_SRC_ALPHA, GL_ONE
  // additive blending and no depth test. Vertex colors carry alpha-premultiplied raw
  // glColor (alpha folded in, opacity stays 1) so AdditiveBlending adds color*alpha.
  const positions = new Float32Array(MAX_VERTS * 3);
  const colorsArr = new Float32Array(MAX_VERTS * 3);
  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(colorsArr, 3).setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('position', posAttr);
  geom.setAttribute('color', colAttr);

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,    // GL_CULL_FACE is off; unlit so winding is irrelevant
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;  // variable buffer + wander; never auto-cull
  scene.add(mesh);

  // ===================================================================
  //  simulation state
  // ===================================================================
  let palette = [];   // NCOLORS raw glColor {r,g,b} in [0,1) (blended in encoded space)
  let state = -1;       // bp->state: unfold progress of the top cube (-1 .. 6)
  let spin = 0;         // bp->r: slow z-rotation, degrees
  let length = 0;       // bp->length: committed cubes in the stack
  let ccolor = 0;       // bp->ccolor: current color index

  // Store the raw glColor values (the .c divides hsv_to_rgb's 16-bit channels by 65536
  // and feeds them straight to glColor). With outputColorSpace = Linear above, these blend
  // additively in encoded space and display as-is -- exactly the GL fixed-pipeline result.
  function rollColors() {
    palette = makeSmoothColormap(rng, NCOLORS).map((c) => ({ r: c.r, g: c.g, b: c.b }));
  }
  // colors[] indexed as a ring (the .c's ccolor can transiently reach ncolors and read
  // one slot past the array; we wrap, since the colormap is a closed loop anyway).
  function col(i) { return palette[((i % NCOLORS) + NCOLORS) % NCOLORS]; }

  // wander rotator: make_rotator(0,0,0,0, 0.005, False) -- wander only, no spin, no RNG
  // in get_position. Built once at 0.005; the `wander` toggle gates the OUTPUT live.
  const rot = makeRotator(
    { spinX: 0, spinY: 0, spinZ: 0, spinAccel: 0, wanderSpeed: 0.005, randomize: false },
    rng,
  );
  let prevPos = { x: 0.5, y: 0.5, z: 0.5 };
  let curPos = { x: 0.5, y: 0.5, z: 0.5 };
  let wfrac = 0;

  function initSim() {
    rollColors();
    state = -1; spin = 0; length = 0; ccolor = 0;
    prevPos = { x: 0.5, y: 0.5, z: 0.5 };
    curPos = { x: 0.5, y: 0.5, z: 0.5 };
    wfrac = 0;
  }
  initSim();

  // ===================================================================
  //  immediate-mode draw -- a Matrix4 stack mirroring GL's modelview
  // ===================================================================
  const stack = [];
  const cur = new THREE.Matrix4();
  const _m = new THREE.Matrix4();
  const _v = new THREE.Vector3();
  let pc = 0;          // position write cursor (floats)
  let cc = 0;          // color write cursor (floats)
  let curR = 0, curG = 0, curB = 0;   // current premultiplied linear color

  function pushM() { stack.push(cur.clone()); }
  function popM() { cur.copy(stack.pop()); }
  function translate(x, y, z) { cur.multiply(_m.makeTranslation(x, y, z)); }
  function rotate(deg, ax) {
    const r = deg * DEG;
    if (ax === 'x') cur.multiply(_m.makeRotationX(r));
    else if (ax === 'y') cur.multiply(_m.makeRotationY(r));
    else cur.multiply(_m.makeRotationZ(r));
  }
  function scale(s) { cur.multiply(_m.makeScale(s, s, s)); }

  function setColor(lin, alpha) { curR = lin.r * alpha; curG = lin.g * alpha; curB = lin.b * alpha; }

  function emitVert(x, y, z) {
    _v.set(x, y, z).applyMatrix4(cur);
    positions[pc++] = _v.x; positions[pc++] = _v.y; positions[pc++] = _v.z;
    colorsArr[cc++] = curR; colorsArr[cc++] = curG; colorsArr[cc++] = curB;
  }
  // GL_TRIANGLE_FAN over the given vertices (unlit + DoubleSide, so winding is moot).
  function emitFan(vs) {
    for (let k = 1; k < vs.length - 1; k++) {
      emitVert(vs[0][0], vs[0][1], vs[0][2]);
      emitVert(vs[k][0], vs[k][1], vs[k][2]);
      emitVert(vs[k + 1][0], vs[k + 1][1], vs[k + 1][2]);
    }
  }

  // draw_strut: one trapezoidal edge bar + (when thin enough) the inward "+" stub.
  function drawStrut(thk) {
    pushM();
    translate(-0.5, -0.5, 0);
    emitFan([[0, 0, 0], [1, 0, 0], [1 - thk, thk, 0], [thk, thk, 0]]);
    const h = 0.5 - thk;
    if (h >= 0.25) {
      emitFan([
        [0.5, 0.5, 0],
        [0.5 - thk / 2, 0.5 - thk / 2, 0],
        [0.5 - thk / 2, 0.5 - h / 2, 0],
        [0.5 + thk / 2, 0.5 - h / 2, 0],
        [0.5 + thk / 2, 0.5 - thk / 2, 0],
      ]);
    }
    popM();
  }

  // draw_face: four struts, Rz(90) between (the 4 rotations net 360, leaving cur intact).
  function drawFace(thk) {
    for (let i = 0; i < 4; i++) { drawStrut(thk); rotate(90, 'z'); }
  }

  // draw_cube_1: the unfold. istate = (int)state, fold ratio r eased; each face fades/
  // folds in as state crosses its threshold (COLORIZE alpha = opacity * r2).
  function drawCube1(st, lin, opacity, bottomP, thk) {
    const istate = Math.trunc(st);
    const a = opacity;
    const r = ease(EASE_IN_OUT_SINE, st - istate);

    if (bottomP) {                                   // Bottom
      const r2 = (st < 0 ? 1 + st : 1);
      setColor(lin, a * r2);
      drawFace(thk);
    }
    if (st >= 0) {                                   // Left
      const r2 = (istate === 0 ? r : 1);
      setColor(lin, a * r2);
      pushM();
      translate(-0.5, 0.5, 0); rotate(-r2 * 90, 'y'); translate(0.5, -0.5, 0);
      drawFace(thk);
      popM();
    }
    if (st >= 1) {                                   // Back
      const r2 = (istate === 1 ? r : 1);
      setColor(lin, a * r2);
      pushM();
      translate(-0.5, 0.5, 0); rotate(90, 'y'); rotate(-90, 'z'); rotate(-r2 * 90, 'y'); translate(0.5, -0.5, 0);
      drawFace(thk);
      popM();
    }
    if (st >= 2) {                                   // Right
      const r2 = (istate === 2 ? r : 1);
      setColor(lin, a * r2);
      pushM();
      translate(0.5, 0.5, 0); rotate(90, 'y'); rotate(-90, 'z'); rotate(-90, 'y'); rotate(-r2 * 90, 'y'); translate(-0.5, -0.5, 0);
      drawFace(thk);
      popM();
    }
    if (st >= 3) {                                   // Front
      const r2 = (istate === 3 ? r : 1);
      setColor(lin, a * r2);
      pushM();
      translate(0.5, 0.5, 0); rotate(90, 'y'); rotate(-90, 'z'); rotate(-180, 'y'); translate(-1, 0, 0); rotate(-r2 * 90, 'y'); translate(0.5, -0.5, 0);
      drawFace(thk);
      popM();
    }
    if (st >= 4) {                                   // Top
      const r2 = (istate === 4 ? r : 1);
      setColor(lin, a * r2);
      pushM();
      translate(0, 0, 1); rotate(-90, 'z'); translate(0.5, 0.5, 0); rotate(-90, 'y'); rotate(r2 * 90, 'y'); translate(-0.5, -0.5, 0);
      drawFace(thk);
      popM();
    }
  }

  // draw_cubes: the marching stack + the top unfolding cube.
  function drawCubes(thk) {
    const opacity = config.opacity;
    const z = state / 6;
    translate(0, 0, -1.5 - z);
    translate(0, 0, -length);
    const c0 = ccolor;
    for (let i = length - 1; i >= 0; i--) {
      translate(0, 0, 1);
      drawCube1(5, col(c0 - i - 1), opacity, i === length - 1, thk);
    }
    translate(0, 0, 1);
    drawCube1(state, col(c0), opacity, length === 0, thk);
  }

  // ===================================================================
  //  per-frame build + sizing
  // ===================================================================
  let portraitScale = 1;
  function clampThk() {
    let t = config.thickness;
    if (t > 0.5) t = 0.5;
    if (t < 0.001) t = 0.001;
    return t;
  }
  const lerp = (a, b, t) => a + (b - a) * t;

  function buildFrame() {
    pc = 0; cc = 0; stack.length = 0;
    cur.identity();
    scale(portraitScale);                            // reshape glScalef(s,s,s)
    let wx = 0.5, wy = 0.5, wz = 0.5;
    if (config.wander) {
      wx = lerp(prevPos.x, curPos.x, wfrac);
      wy = lerp(prevPos.y, curPos.y, wfrac);
      wz = lerp(prevPos.z, curPos.z, wfrac);
    }
    translate((wx - 0.5) * 4, (wy - 0.5) * 4, (wz - 0.5) * 2);  // wander
    scale(6);                                        // glScalef(6,6,6)
    rotate(-45, 'x'); rotate(20, 'z'); rotate(spin, 'z');
    drawCubes(clampThk());

    geom.setDrawRange(0, pc / 3);
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    mat.wireframe = config.wire;
  }

  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    portraitScale = (w < h ? w / h : 1);             // reshape's portrait-fit scale
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
    const sp = config.speed;

    // Continuous advance (the .c's per-frame steps, scaled by elapsed frames).
    state += sp * 0.015 * frames;
    spin += sp * 0.05 * frames;
    while (spin > 360) spin -= 360;
    while (state > 6) {
      state -= 6;
      length++;
      ccolor++;
      if (ccolor > NCOLORS) ccolor = 0;
      if (length > 20) length = 20;
    }

    // Wander rotator ticked at effFps, interpolated for smooth drift.
    wfrac += frames;
    let ticks = 0;
    while (wfrac >= 1 && ticks < MAX_TICKS) {
      prevPos = curPos;
      curPos = rot.getPosition(true);
      wfrac -= 1; ticks++;
    }
    if (ticks === MAX_TICKS) wfrac = 0;

    buildFrame();
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      geom.dispose();
      mat.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { initSim(); },     // host 're-seed': fresh stack + colormap (the .c's space-bar re-rolls colors)
    config,
    params,
  };
}

export default { title, info, start };
