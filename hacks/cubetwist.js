// cubetwist.js -- "Cube Twist" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's cubetwist (Jamie Zawinski, 2016),
// hacks/glx/cubetwist.c. A set of concentric cube FRAMES (each cube = 6 square
// frames of 4 trapezoidal edge struts -- a hollow wireframe box, NOT a solid) nested
// one inside the next, shrinking by a fixed step. Every frame, a single "oscillator"
// eases one degree of freedom of the OUTERMOST cube (a +/-90 rotation or a small
// +/-displacement slide); that rotation/translation is then applied CUMULATIVELY to
// each deeper cube, so the stack winds up into a spiral and slides, then resets and
// twists a new way. The whole object slowly spins (3-axis) and wanders through space.
//
// LIT vs UNLIT -- the .c only sets up lighting in the `!do_flat` branch, and
// DEF_FLAT is "True", so the DEFAULT mode is UNLIT: each cube is one flat glColor,
// the outermost bright and each deeper cube darker by a constant `cstep` subtracted
// from every channel (a depth gradient, NOT shading). The ground-truth screenshot is
// this mode (sampled: the layer-to-layer brightness step is a constant per-channel
// subtraction, not a multiplicative light falloff, and there is zero specular tint).
// We default to it faithfully (flat -> MeshBasicMaterial). The "Flat shading"
// checkbox, unchecked, switches to the .c's lit path: two white directional lights
// (GL_LIGHT0 from {0.5,-1,-0.5}, GL_LIGHT1 from {-0.75,-1,0}; both white diffuse AND
// white specular -- LIGHT1's specular is set explicitly), a yellow material specular
// {1,1,0} and shininess 30, plus the GL global ambient (0.2 * the cube color).
//
// Self-contained three.js (own overlay canvas + renderer + loop), like cubestack.js /
// dangerball.js. RNG = yarandom.js, spin+wander = rotator.js, the oscillator easing =
// easing.js (the same utils/easing.c the hack #includes). No assets, no fonts.
//
// Faithful to the .c:
//   * make_cubes: step = 2*(thickness+displacement); cubes shrink size 1.0 by `step`
//     until size <= step; color cc = (0.3+frand(0.7))x3, each deeper cube -= cstep
//     (cstep = 0.8/depth, clamped [0,1]). thickness/displacement default 0 -> init
//     RANDOMIZES them (50/50: thick 0.03+frand(.02) | thin 0.001+frand(.02)).
//   * draw_strut / the 6-face / 4-strut frame transcribed as a Matrix4-stack walk,
//     baked once per cube into a static BufferGeometry (frames don't change shape).
//   * draw_cubes' cumulative nesting: cube i sits at M_global * (R(rot)*T(pos))^i,
//     all cubes sharing the head's oscillator-driven rot/pos (the .c propagates the
//     head's rot/pos down the chain each frame). draw_cube modelview S(portrait)*
//     S(1.1)*T(wander*{4,4,2})*R(spin*360)*S(6); camera gluPerspective(30,1/h,1,100)
//     + gluLookAt(0,0,30,...,up +y).
//   * tick_oscillators: ratio += (0.1/speed)*osc.speed per frame; *var = from +
//     (to-from)*ease(EASE_IN_OUT_SINE, ratio); on ratio>=1 either expire (remaining
//     hits 0) or reverse (swap from/to). add_random_oscillator picks 1 of the head's
//     6 DOFs; rotations to +/-90 (repeat usually 1), slides to +/-disp (repeat 2).
//     A new oscillator is added (after RESETTING the head's rot/pos to 0) only when
//     none is running, with probability 1/60 per frame.
//
// PACING -- render every rAF; advance the oscillator ratios continuously by `frames =
// dt*effFps` (the .c's per-frame step, sampled smoothly) and tick the spin/wander
// rotator + the 1/60 add-check once per original-frame (at effFps) with interpolation
// for a smooth render (the geometry-track convention, as cubestack/dangerball do).
// effFps = 1e6/(delay + OVERHEAD), OVERHEAD = 37500 us (the track family default).

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';
import { ease, EASE_IN_OUT_SINE } from './easing.js';

export const title = 'cubetwist';

export const info = {
  author: 'Jamie Zawinski',
  year: 2016,
  description: 'A series of nested cubes rotate and slide recursively.',
};

export function start(hostCanvas, opts = {}) {
  const DEG = Math.PI / 180;
  const OVERHEAD = 37500;     // us; calibrates xml default delay 30000 -> ~15fps (track default)
  const MAX_DEPTH = 512;      // safety cap; real depth maxes ~499 at the thinnest randomized strut
  const MAX_TICKS = 8;        // rotator catch-up cap (avoids spiral after a stall)

  // Knobs transcribed 1:1 from hacks/config/cubetwist.xml.
  const config = {
    delay: 30000,         // us (xml default; invert slider)
    speed: 1.0,           // animation speed (xml --speed)
    thickness: 0.0,       // strut width (xml --thickness; 0 => init randomizes)
    displacement: 0.0,    // slide amount + nesting gap (xml --displacement; 0 => randomizes via thickness)
    flat: true,           // flat shading == UNLIT (do_flat; xml default True)
    wander: true,         // drift through space (do_wander)
    spin: true,           // tumble (do_spin)
    wire: false,          // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Animation speed', type: 'range', min: 0.1, max: 10, step: 0.1, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'thickness', label: 'Thickness', type: 'range', min: 0.0, max: 0.5, step: 0.01, default: 0.0, lowLabel: 'thin', highLabel: 'thick', live: true },
    { key: 'displacement', label: 'Displacement', type: 'range', min: 0.0, max: 0.5, step: 0.01, default: 0.0, lowLabel: 'tight', highLabel: 'wide', live: true },
    { key: 'flat', label: 'Flat shading', type: 'checkbox', default: true, live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'spin', label: 'Spin', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

  // ===================================================================
  //  three.js scene
  // ===================================================================
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);
  // Opaque, depth-tested, no blending -> the standard color path: author colors
  // sRGB->linear (setRGB SRGBColorSpace) and keep the default sRGB output, so the
  // on-screen value is the glColor value, matching the GL fixed pipeline.

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // gluPerspective(30, w/h, 1, 100) + gluLookAt(0,0,30, 0,0,0, 0,1,0).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // Lights for the LIT (flat=false) path; fixed in eye/world space (the .c sets them
  // in init under the identity-rotation view, so they don't rotate with the model).
  // intensity PI cancels three's 1/PI Lambert so diffuse = albedo*N*L like GL; the two
  // lights sum, as in GL. Ambient = global ambient 0.2 * material AMBIENT_AND_DIFFUSE.
  const light0 = new THREE.DirectionalLight(0xffffff, Math.PI);
  light0.position.set(0.5, -1, -0.5);
  const light1 = new THREE.DirectionalLight(0xffffff, Math.PI);
  light1.position.set(-0.75, -1, 0);
  const ambient = new THREE.AmbientLight(0xffffff, 0.2 * Math.PI);
  scene.add(light0, light0.target, light1, light1.target, ambient);

  // The model root: its matrix is the global modelview (manual; it is S*S*T*R*S, not a
  // single TRS). Holds one mesh per nested cube; each mesh's matrix is its cumulative
  // (R*T)^i transform. matrixAutoUpdate off so our matrices survive.
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  scene.add(group);

  // flat=true -> unlit; flat=false -> lit. Both vertex-colored (per-cube color baked
  // into each geometry). DoubleSide: the .c culls GL_CW back faces, but with flat
  // opaque bars the visible (front) pixels are identical; DoubleSide removes winding
  // risk (lessons). In the lit path this lights back faces glimpsed through the gaps
  // by their viewer-facing normal -- a minor, non-default deviation.
  const matBasic = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const matPhong = new THREE.MeshPhongMaterial({
    vertexColors: true,                                   // diffuse = white * vertex color
    specular: new THREE.Color().setRGB(1 / Math.PI, 1 / Math.PI, 0, THREE.SRGBColorSpace), // {1,1,0}/PI
    shininess: 30,
    side: THREE.DoubleSide,
  });
  let currentMat = matBasic;

  // ===================================================================
  //  simulation state (the .c's statics + the head cube + oscillators)
  // ===================================================================
  let effThickness = 0;       // the .c's `thickness` static (may differ from config after randomize)
  let effDisplacement = 0;    // the .c's `displacement` static
  const cc0 = [0.5, 0.5, 0.5]; // base random color (make_cubes' cc), rolled at init / re-seed
  const head = { rot: { x: 0, y: 0, z: 0 }, pos: { x: 0, y: 0, z: 0 } }; // outermost cube DOFs (degrees / units)
  const oscillators = [];     // { ratio, from, to, speed, grp, ax, remaining }

  // make_rotator(do_spin?0.05, ..., 1.0, do_wander?0.005, True). Built at FULL speed
  // (the spin/wander checkboxes gate its OUTPUT live, the dangerball pattern -- the
  // randomize path consumes the same RNG regardless of speed, so the stream stays in
  // step). Created before make_cubes, matching init_cube's RNG order.
  const rot = makeRotator(
    { spinX: 0.05, spinY: 0.05, spinZ: 0.05, spinAccel: 1.0, wanderSpeed: 0.005, randomize: true },
    rng,
  );

  // ===================================================================
  //  per-cube frame geometry (built once per make_cubes; a Matrix4-stack walk
  //  mirroring draw_strut + the 6-face/4-strut loop, in the cube's local space)
  // ===================================================================
  const curB = new THREE.Matrix4();
  const stackB = [];
  const _bm = new THREE.Matrix4();
  const _bv = new THREE.Vector3();
  const _bn = new THREE.Vector3();
  let posArr = null, normArr = null, nx = 0, ny = 0, nz = 0;

  function pushB() { stackB.push(curB.clone()); }
  function popB() { curB.copy(stackB.pop()); }
  function transB(x, y, z) { curB.multiply(_bm.makeTranslation(x, y, z)); }
  function rotB(deg, ax) {
    const r = deg * DEG;
    if (ax === 'x') curB.multiply(_bm.makeRotationX(r));
    else if (ax === 'y') curB.multiply(_bm.makeRotationY(r));
    else curB.multiply(_bm.makeRotationZ(r));
  }
  function emitV(p) {
    _bv.set(p[0], p[1], p[2]).applyMatrix4(curB);
    posArr.push(_bv.x, _bv.y, _bv.z);
    normArr.push(nx, ny, nz);
  }
  // One quad (the .c's 4-vertex GL_TRIANGLE_FAN) -> two triangles, with the local
  // normal transformed by the current frame rotation (translation doesn't affect it).
  function emitQuad(a, b, c, d, lx, ly, lz) {
    _bn.set(lx, ly, lz).transformDirection(curB);
    nx = _bn.x; ny = _bn.y; nz = _bn.z;
    emitV(a); emitV(b); emitV(c);
    emitV(a); emitV(c); emitV(d);
  }
  // draw_strut: the bottom edge bar of one square frame face (a trapezoid in z=0 + a
  // beveled top quad), translated to the cube's -corner.
  function drawStrut(size, thk) {
    pushB();
    transB(-size / 2, -size / 2, -size / 2);
    emitQuad([0, 0, 0], [size, 0, 0], [size - thk, thk, 0], [thk, thk, 0], 0, 0, -1);
    emitQuad([thk, thk, 0], [size - thk, thk, 0], [size - thk, thk, thk], [thk, thk, thk], 0, 1, 0);
    popB();
  }
  // The full cube frame: 6 faces, each 4 struts (Rz 90 between), faces oriented by the
  // .c's j-loop (Ry 90 around the 4 sides + an extra Rz at j==3; Rx 180 for top/bottom).
  function buildFramePosNorm(size, thk) {
    posArr = []; normArr = []; stackB.length = 0; curB.identity();
    pushB();
    for (let j = 0; j < 6; j++) {
      for (let i = 0; i < 4; i++) { drawStrut(size, thk); rotB(90, 'z'); }
      if (j === 3) rotB(90, 'z');
      if (j < 4) rotB(90, 'y'); else rotB(180, 'x');
    }
    popB();
    return { pos: new Float32Array(posArr), norm: new Float32Array(normArr) };
  }

  const cubeMeshes = [];      // one Mesh per nested cube

  function disposeCubes() {
    for (const m of cubeMeshes) { group.remove(m); m.geometry.dispose(); }
    cubeMeshes.length = 0;
  }

  // make_cubes: build the nested list (sizes + colors) and one static mesh per cube.
  // Does NOT roll the base color (cc0 is rolled at init / re-seed, so dragging the
  // thickness/displacement sliders -- which the .c can't do -- rebuilds without
  // flickering the palette; the default look is unchanged).
  function makeCubes() {
    disposeCubes();
    const step = 2 * (effThickness + effDisplacement);
    const sizes = [];
    let size = 1.0;
    while (true) {                       // mirrors the .c's while(1){ make; size-=step; if(<=step)break; }
      sizes.push(size);
      size -= step;
      if (size <= step) break;
      if (sizes.length >= MAX_DEPTH) break;   // safety (step is always > 0 after randomize)
    }
    const depth = sizes.length;
    const cstep = 0.8 / depth;
    const cc = [cc0[0], cc0[1], cc0[2]];
    for (let i = 0; i < depth; i++) {
      const col = new THREE.Color().setRGB(clamp01(cc[0]), clamp01(cc[1]), clamp01(cc[2]), THREE.SRGBColorSpace);
      const { pos, norm } = buildFramePosNorm(sizes[i], effThickness);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
      const colArr = new Float32Array(pos.length);
      for (let k = 0; k < colArr.length; k += 3) { colArr[k] = col.r; colArr[k + 1] = col.g; colArr[k + 2] = col.b; }
      g.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
      const mesh = new THREE.Mesh(g, currentMat);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      group.add(mesh);
      cubeMeshes.push(mesh);
      cc[0] -= cstep; cc[1] -= cstep; cc[2] -= cstep;
    }
  }

  // ===================================================================
  //  oscillators (tick_oscillators / add_random_oscillator)
  // ===================================================================
  function setHead(grp, ax, v) { head[grp][ax] = v; }
  const randsign = () => ((rng.random() & 1) ? 1 : -1);

  // tick_oscillators, advanced by `frames` continuous original-frames this render.
  function tickOscillators(frames) {
    if (oscillators.length === 0) return;
    const tick = 0.1 / config.speed;
    let idx = 0;
    while (idx < oscillators.length) {
      const a = oscillators[idx];
      a.ratio += tick * a.speed * frames;
      if (a.ratio > 1) a.ratio = 1;
      setHead(a.grp, a.ax, a.from + (a.to - a.from) * ease(EASE_IN_OUT_SINE, a.ratio));
      if (a.ratio < 1) { idx++; }                    // mid cycle
      else if (--a.remaining <= 0) { oscillators.splice(idx, 1); }  // ended & expired -> remove
      else { const s = a.from; a.from = a.to; a.to = s; a.ratio = 0; idx++; }  // reverse
    }
  }

  // add_oscillator: don't double up on a DOF (the .c's loop skips the last node; moot
  // here since add fires only with an empty list, but transcribed faithfully).
  function addOscillator(grp, ax, speed, to, repeat) {
    for (let i = 0; i < oscillators.length - 1; i++)
      if (oscillators[i].grp === grp && oscillators[i].ax === ax) return;
    if (repeat <= 0) return;
    oscillators.unshift({ ratio: 0, from: head[grp][ax], to, speed, grp, ax, remaining: repeat });
  }

  function addRandomOscillator() {
    const s1 = config.speed * 0.07;
    const s2 = config.speed * 0.3;
    const disp = (effThickness + effDisplacement);
    const c1 = 1 + ((rng.random() % 4) ? 0 : (rng.random() % 3));
    const c2 = 2;
    const n = rng.random() % 6;
    switch (n) {
      case 0: addOscillator('rot', 'x', s1, 90 * randsign(), c1); break;
      case 1: addOscillator('rot', 'y', s1, 90 * randsign(), c1); break;
      case 2: addOscillator('rot', 'z', s1, 90 * randsign(), c1); break;
      case 3: addOscillator('pos', 'x', s2, disp * randsign(), c2); break;
      case 4: addOscillator('pos', 'y', s2, disp * randsign(), c2); break;
      case 5: addOscillator('pos', 'z', s2, disp * randsign(), c2); break;
    }
  }

  // ===================================================================
  //  init / re-seed (init_cube + make_cubes; space-bar via reinit)
  // ===================================================================
  function rollBaseColor() {
    cc0[0] = 0.3 + rng.frand(0.7);
    cc0[1] = 0.3 + rng.frand(0.7);
    cc0[2] = 0.3 + rng.frand(0.7);
  }
  // The space-bar / init randomization of thickness+displacement.
  function randomizeThicknessDisplacement() {
    if (rng.random() & 1) {
      effThickness = 0.03 + rng.frand(0.02);
      effDisplacement = (rng.random() & 1) ? 0 : (effThickness / 3);
    } else {
      effThickness = 0.001 + rng.frand(0.02);
      effDisplacement = 0;
    }
  }
  // Apply the slider values (clamp to 0.5), randomizing when ~0 (init_cube's rule).
  function applyThicknessDisplacement() {
    effThickness = Math.min(config.thickness, 0.5);
    effDisplacement = Math.min(config.displacement, 0.5);
    if (effThickness <= 0.0001) randomizeThicknessDisplacement();
  }

  applyThicknessDisplacement();   // init_cube: clamp + randomize-if-zero (after the rotator)
  rollBaseColor();                // make_cubes' cc roll (kept here for RNG-order parity)
  makeCubes();
  let lastThickness = config.thickness;
  let lastDisplacement = config.displacement;

  // ===================================================================
  //  per-frame transforms
  // ===================================================================
  const Mg = new THREE.Matrix4();
  const RT = new THREE.Matrix4();
  const acc = new THREE.Matrix4();
  const _gm = new THREE.Matrix4();
  let portraitScale = 1;

  function updateTransforms(sx, sy, sz, wx, wy, wz) {
    // group = S(portrait)*S(1.1)*T(wander)*R(spin)*S(6)  (reshape's portrait scale folded in).
    Mg.identity();
    Mg.multiply(_gm.makeScale(portraitScale, portraitScale, portraitScale));
    Mg.multiply(_gm.makeScale(1.1, 1.1, 1.1));
    Mg.multiply(_gm.makeTranslation(wx, wy, wz));
    Mg.multiply(_gm.makeRotationX(sx));
    Mg.multiply(_gm.makeRotationY(sy));
    Mg.multiply(_gm.makeRotationZ(sz));
    Mg.multiply(_gm.makeScale(6, 6, 6));
    group.matrix.copy(Mg);
    group.matrixWorldNeedsUpdate = true;             // cascades the recompute to the cube meshes

    // cube i at (R*T)^i, R = Rx(rot.x)*Ry(rot.y)*Rz(rot.z), T = translate(pos).
    RT.identity();
    RT.multiply(_gm.makeRotationX(head.rot.x * DEG));
    RT.multiply(_gm.makeRotationY(head.rot.y * DEG));
    RT.multiply(_gm.makeRotationZ(head.rot.z * DEG));
    RT.multiply(_gm.makeTranslation(head.pos.x, head.pos.y, head.pos.z));
    acc.identity();
    for (let i = 0; i < cubeMeshes.length; i++) {
      cubeMeshes[i].matrix.copy(acc);
      acc.multiply(RT);
    }
  }

  // ===================================================================
  //  rotator sampling + interpolation (the discrete spin/wander random-walk)
  // ===================================================================
  const r0 = rot.getRotation(false);
  const p0 = rot.getPosition(false);
  let prevR = { ...r0 }, curR = { ...r0 };
  let prevP = { ...p0 }, curP = { ...p0 };
  let rotAccum = 0;

  // One original-frame: advance the rotator (the .c calls get_position then
  // get_rotation each draw_cube) and run the 1/60 "start a new oscillation" check.
  function tickFrame() {
    prevP = curP; curP = rot.getPosition(true);
    prevR = curR; curR = rot.getRotation(true);
    if (oscillators.length === 0 && (rng.random() % 60) === 0) {
      head.rot.x = head.rot.y = head.rot.z = 0;       // reset the head before the new oscillation
      head.pos.x = head.pos.y = head.pos.z = 0;
      addRandomOscillator();
    }
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  function lerpAngle(a, b, t) {                        // shortest path on the [0,1) circle
    let d = b - a;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    return a + d * t;
  }

  // ===================================================================
  //  sizing + render loop
  // ===================================================================
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    portraitScale = (w < h ? w / h : 1);              // reshape's portrait-fit scale
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  let raf = 0, last = 0, paused = false, ms = 16;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    // Thickness / displacement sliders change the GEOMETRY -> rebuild on change.
    if (config.thickness !== lastThickness || config.displacement !== lastDisplacement) {
      applyThicknessDisplacement();
      makeCubes();
      lastThickness = config.thickness;
      lastDisplacement = config.displacement;
    }

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;

    tickOscillators(frames);                           // continuous: smooth twist/slide

    rotAccum += frames;                                // discrete: rotator + add-check at effFps
    let ticks = 0;
    while (rotAccum >= 1 && ticks < MAX_TICKS) { tickFrame(); rotAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) rotAccum = 0;
    const a = rotAccum;

    // flat (lit/unlit) + wire are live.
    const wantMat = config.flat ? matBasic : matPhong;
    if (wantMat !== currentMat) { currentMat = wantMat; for (const m of cubeMeshes) m.material = wantMat; }
    matBasic.wireframe = matPhong.wireframe = config.wire;

    // spin (gated): rotation in [0,1) -> *360 deg == *2pi rad; wander (gated): {4,4,2}.
    let sx = 0, sy = 0, sz = 0, wx = 0, wy = 0, wz = 0;
    if (config.spin) {
      sx = lerpAngle(prevR.x, curR.x, a) * 2 * Math.PI;
      sy = lerpAngle(prevR.y, curR.y, a) * 2 * Math.PI;
      sz = lerpAngle(prevR.z, curR.z, a) * 2 * Math.PI;
    }
    if (config.wander) {
      wx = (lerp(prevP.x, curP.x, a) - 0.5) * 4;
      wy = (lerp(prevP.y, curP.y, a) - 0.5) * 4;
      wz = (lerp(prevP.z, curP.z, a) - 0.5) * 2;
    }
    updateTransforms(sx, sy, sz, wx, wy, wz);
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      disposeCubes();
      matBasic.dispose();
      matPhong.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() {                                          // host 're-seed' == the .c's space-bar
      oscillators.length = 0;
      head.rot.x = head.rot.y = head.rot.z = 0;
      head.pos.x = head.pos.y = head.pos.z = 0;
      randomizeThicknessDisplacement();                 // space-bar always re-randomizes
      rollBaseColor();
      makeCubes();
    },
    config,
    params,
  };
}

export default { title, info, start };
