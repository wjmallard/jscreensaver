// cubestorm.js -- "Cube Storm" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's cubestorm (Jamie Zawinski, 2003),
// hacks/glx/cubestorm.c. A chain of `count` hollow, beveled "frame" cubes (each cube
// is six square picture-frames of width `thickness`, NOT a solid box) that spin and
// wander together, leaving fading colored TRAILS: every original-frame each cube's
// current position/orientation/color is appended to a history list and the WHOLE list
// is re-drawn, so the trail is a frozen long-exposure of the spinning storm. The trail
// grows to `length` snapshots, rolls (oldest dropped), and is periodically wiped --
// then rebuilt with a fresh smooth colormap.
//
// Self-contained three.js (own overlay canvas + renderer + loop), like dangerball.js /
// morph3d.js. RNG = yarandom.js, spin/wander = rotator.js, palette = colormap.js. No
// assets.
//
// Faithful to the .c:
//   * draw_face / draw_faces: one face = 4 mitered beveled struts (a front trapezoid in
//     the face plane + an inner wall stepping back by t), Rz(90) x4; a cube = 6 faces
//     placed by the exact cumulative Ry(90)x3, Rx(90), Rx(180) sequence. t = thickness/2
//     clamped to [0.001, 0.5]. The flat per-quad normals (0,0,-1) / (0,1,0) are kept.
//   * push_hist: cube 0 supplies the shared wander position AND the base rotation;
//     cubes 1.. add cube 0's rotation (N+1 cubes rotate relative to cube 0). Each cube's
//     color index increments per frame; oldest `count` snapshots dropped past `length`.
//   * draw_cube modelview per snapshot: Scale(s*1.1) [portrait fit + the constant 1.1] *
//     T((p-0.5)*{15,15,30}) * Rxyz(r*360) * Scale(4); rebuilt as an InstancedMesh.
//   * the clear cycle: accumulate (mean 200/speed frames) then a brief "no vapor trails"
//     wipe (mean 25/speed frames) that resets the history each frame + re-rolls colors.
//   * gluPerspective(30, 1/h, 1, 100) + gluLookAt(0,0,45, ..., up +y); 128-entry smooth
//     colormap; one white directional light from (1,1,1) with cyan {0,1,1} specular,
//     ambient {0,0,0} (so the floor is the GL default global 0.2 * the per-cube color);
//     material AMBIENT_AND_DIFFUSE = color, specular white, shininess 128.
//
// CULLING/WINDING: the .c draws under glFrontFace(GL_CW) + GL_CULL_FACE (so each frame
// shows only camera-facing strut faces, lit by the supplied normal -- two-sided lighting
// is off). three is CCW-front, so we REVERSE each quad's triangle winding and keep
// THREE.FrontSide: this selects exactly the faces GL kept (verified: the near +z face is
// CW in screen -> reversed -> CCW -> kept; far face culled) and lights them with the
// unflipped supplied normal -- identical to GL.
//
// Trails: the .c clears the framebuffer EVERY frame and re-renders the whole saved
// history (its own header notes the old "don't clear the buffer" trick stopped working
// on modern GPUs). We do the same -- option (b): keep the last N cube transforms+colors
// and draw them all each frame via an InstancedMesh, wiping on the .c's schedule. No
// blending: the cubes are OPAQUE frames (alpha 1), the storm is overlap + depth, not
// translucency.
//
// PACING -- render every rAF; the storm's "motion" is the discrete trail (each snapshot
// is frozen once pushed), so we tick the SIMULATION (rotator advance + clear decision +
// push_hist) at the original cadence effFps = 1e6/(delay+OVERHEAD) and just re-draw the
// static history in between -- no interpolation (the trail is inherently frame-by-frame,
// and the original runs at the same ~15fps). OVERHEAD = 37500 as across the track.

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

export const title = 'cubestorm';

export const info = {
  author: 'Jamie Zawinski',
  year: 2003,
  description: 'Boxes change shape and intersect each other, filling space.',
};

export function start(hostCanvas, opts = {}) {
  const DEG = Math.PI / 180;
  const TWO_PI = Math.PI * 2;
  const OVERHEAD = 37500;     // us; calibrates xml default delay 30000 -> ~15fps (track default)
  const NCOLORS = 128;        // bp->ncolors
  // History capacity: length high=1000 + count high=20 + the .c realloc slack (100).
  const MAX_HIST = 1200;

  // Knobs transcribed 1:1 from hacks/config/cubestorm.xml. `delay` first, invert slider.
  const config = {
    delay: 30000,      // us (xml default; invert slider)
    speed: 1.0,        // spin/wander rate + clear-cycle rate (xml --speed)
    count: 4,          // number of cubes in the chain (xml --count)
    length: 200,       // max trail snapshots before rolling (xml --length / max_length)
    thickness: 0.06,   // strut width (xml --thickness)
    wander: true,      // drift through space (do_wander)
    spin: true,        // tumble (do_spin)
    wire: false,       // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.01, max: 5.0, step: 0.01, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'count', label: 'Cubes', type: 'range', min: 1, max: 20, step: 1, default: 4, lowLabel: 'few', highLabel: 'many', live: true },
    { key: 'length', label: 'Length', type: 'range', min: 20, max: 1000, step: 10, default: 200, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'thickness', label: 'Struts', type: 'range', min: 0.01, max: 1.0, step: 0.01, default: 0.06, lowLabel: 'thin', highLabel: 'thick', live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'spin', label: 'Spin', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);

  // ===================================================================
  //  cube geometry -- draw_faces(): six beveled frame faces
  // ===================================================================
  // One face = 4 struts (Rz(90) each); one strut = 2 quads: a front trapezoid in the
  // face plane (normal -z) and the inner wall stepping back by t (normal +y). The six
  // faces are placed by draw_faces' cumulative rotations. Reversed winding (see header)
  // + FrontSide reproduces the GL_CW + cull-back selection.
  function buildCubeGeometry(thickness) {
    let t = thickness / 2;
    if (t <= 0) t = 0.001;
    else if (t > 0.5) t = 0.5;
    const a = -0.5, b = 0.5;

    // strut 0 base quads, verbatim from draw_face's two glBegin blocks.
    const baseQuads = [
      { n: [0, 0, -1], v: [[a, a, a], [b, a, a], [b - t, a + t, a], [a + t, a + t, a]] },
      { n: [0, 1, 0], v: [[b - t, a + t, a], [b - t, a + t, a + t], [a + t, a + t, a + t], [a + t, a + t, a]] },
    ];

    // draw_faces() cumulative face matrices (GL post-multiplies each glRotatef).
    const Rx = (d) => new THREE.Matrix4().makeRotationX(d * DEG);
    const Ry = (d) => new THREE.Matrix4().makeRotationY(d * DEG);
    const Rz = (d) => new THREE.Matrix4().makeRotationZ(d * DEG);
    const faceMats = [];
    const M = new THREE.Matrix4();
    faceMats.push(M.clone());                       // draw_face
    M.multiply(Ry(90)); faceMats.push(M.clone());   // Ry(90)  draw_face
    M.multiply(Ry(90)); faceMats.push(M.clone());   // Ry(90)  draw_face
    M.multiply(Ry(90)); faceMats.push(M.clone());   // Ry(90)  draw_face
    M.multiply(Rx(90)); faceMats.push(M.clone());   // Rx(90)  draw_face
    M.multiply(Rx(180)); faceMats.push(M.clone());  // Rx(180) draw_face

    const pos = [], nrm = [];
    const vtmp = new THREE.Vector3(), ntmp = new THREE.Vector3();
    const emitQuad = (mat, quad) => {
      ntmp.set(quad.n[0], quad.n[1], quad.n[2]).transformDirection(mat);
      const vs = quad.v.map(([x, y, z]) => new THREE.Vector3(x, y, z).applyMatrix4(mat));
      // reversed winding: GL's CW front -> three's CCW front (kept by FrontSide).
      for (const k of [0, 2, 1, 0, 3, 2]) {
        pos.push(vs[k].x, vs[k].y, vs[k].z);
        nrm.push(ntmp.x, ntmp.y, ntmp.z);
      }
    };

    for (const Mf of faceMats)
      for (let i = 0; i < 4; i++) {                 // four struts, Rz(90) each
        const strut = Mf.clone().multiply(Rz(90 * i));
        for (const q of baseQuads) emitQuad(strut, q);
      }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    return g;
  }

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

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // gluPerspective(30, w/h, 1, 100) + gluLookAt(0,0,45, 0,0,0, 0,1,0).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 45);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // One white directional light from (1,1,1) (GL pos {1,1,1,0}, w=0 => parallel),
  // intensity PI to cancel three's 1/PI Lambert (diffuse = albedo*NdotL, as in GL).
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(1, 1, 1);
  scene.add(light);

  // Ambient floor: GL default global ambient 0.2 * material ambient (= the per-cube
  // color, since the material is GL_AMBIENT_AND_DIFFUSE); LIGHT0's own ambient is {0,0,0}.
  scene.add(new THREE.AmbientLight(0xffffff, 0.2 * Math.PI));

  // Per-cube material: white base * per-instance color; specular = light cyan {0,1,1} *
  // material white = cyan highlight (folded onto the material, as in dangerball, and
  // divided by PI so the PI light doesn't blow the tight shininess-128 glint into a
  // white disc). AMBIENT_AND_DIFFUSE is the instance color.
  const cubeMat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    specular: new THREE.Color(0, 1 / Math.PI, 1 / Math.PI),   // linear; cyan / PI
    shininess: 128,
    side: THREE.FrontSide,
  });

  // Outer group = portrait-fit s * the constant draw_cube Scale(1.1) (both uniform,
  // both outermost, so folded together). Per-snapshot transforms live in the instance
  // matrices below (T(pos) * Rxyz * Scale(4), in this group's local space).
  const rootG = new THREE.Group();
  scene.add(rootG);

  let cubeGeom = buildCubeGeometry(config.thickness);
  const inst = new THREE.InstancedMesh(cubeGeom, cubeMat, MAX_HIST);
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  inst.frustumCulled = false;     // wandering storm can leave the bounds; never pop
  inst.count = 0;
  rootG.add(inst);

  // ===================================================================
  //  simulation state -- subcubes (rotators), colors, history
  // ===================================================================
  let subcubes = [];              // [{ rot, ccolor }], one per cube (cube 0 = master)
  let colors = [];                // NCOLORS THREE.Color (used raw -- colour management off)
  let clearP = false;             // "no vapor trails" mode

  // History as flat typed arrays (the .c's histcube[] -- position, rotation, color).
  const HPx = new Float32Array(MAX_HIST), HPy = new Float32Array(MAX_HIST), HPz = new Float32Array(MAX_HIST);
  const HRx = new Float32Array(MAX_HIST), HRy = new Float32Array(MAX_HIST), HRz = new Float32Array(MAX_HIST);
  const HC = new Int32Array(MAX_HIST);
  let histCount = 0;
  let histDirty = true;

  // new_cube_colors(): 128-entry smooth colormap (used raw -- CM off), random initial index
  // per cube.
  function newCubeColors() {
    colors = makeSmoothColormap(rng, NCOLORS).map(
      (c) => new THREE.Color().setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace),
    );
    for (const sc of subcubes) sc.ccolor = rng.random() % NCOLORS;
  }

  // init_cube's per-cube rotators: cube 0 wanders + spins fast; the rest spin slower and
  // do not wander. spin/wander gated by the toggles; spin_accel passed regardless.
  function buildSubcubes() {
    const count = Math.max(1, Math.round(config.count));
    const sp = config.speed;
    subcubes = [];
    for (let i = 0; i < count; i++) {
      let wanderSpeed, spinSpeed, spinAccel;
      if (i === 0) { wanderSpeed = 0.05 * sp; spinSpeed = 10.0 * sp; spinAccel = 4.0 * sp; }
      else { wanderSpeed = 0; spinSpeed = 4.0 * sp; spinAccel = 2.0 * sp; }
      const rot = makeRotator(
        {
          spinX: config.spin ? spinSpeed : 0,
          spinY: config.spin ? spinSpeed : 0,
          spinZ: config.spin ? spinSpeed : 0,
          spinAccel: spinAccel,
          wanderSpeed: config.wander ? wanderSpeed : 0,
          randomize: true,
        },
        rng,
      );
      subcubes.push({ rot, ccolor: 0 });
    }
  }

  function initSim() {
    buildSubcubes();
    newCubeColors();    // init_cube order: rotators, then colors
    histCount = 0;
    clearP = false;
    histDirty = true;
  }
  initSim();

  // push_hist(): roll off the oldest `count`, then append this frame's `count` cubes.
  function pushHist() {
    const count = subcubes.length;       // == config.count
    const maxLen = config.length;
    if (histCount > maxLen && histCount > count) {
      // memmove: drop the oldest `count` snapshots off the front.
      HPx.copyWithin(0, count, histCount); HPy.copyWithin(0, count, histCount); HPz.copyWithin(0, count, histCount);
      HRx.copyWithin(0, count, histCount); HRy.copyWithin(0, count, histCount); HRz.copyWithin(0, count, histCount);
      HC.copyWithin(0, count, histCount);
      histCount -= count;
    }

    const p = subcubes[0].rot.getPosition(true);   // shared position from cube 0
    let rx = 0, ry = 0, rz = 0;
    for (let i = 0; i < count; i++) {
      const sc = subcubes[i];
      const r = sc.rot.getRotation(true);
      let rx2 = r.x, ry2 = r.y, rz2 = r.z;
      if (i === 0) { rx = rx2; ry = ry2; rz = rz2; }   // cube 0 = the base rotation
      else { rx2 += rx; ry2 += ry; rz2 += rz; }        // others rotate relative to it
      if (histCount >= MAX_HIST) break;                // capacity guard (never hit in range)
      const idx = histCount;
      HPx[idx] = p.x; HPy[idx] = p.y; HPz[idx] = p.z;
      HRx[idx] = rx2; HRy[idx] = ry2; HRz[idx] = rz2;
      HC[idx] = sc.ccolor;
      sc.ccolor++;
      if (sc.ccolor >= NCOLORS) sc.ccolor = 0;
      histCount++;
    }
  }

  // One original-frame: the clear-cycle decision then push_hist (draw_cube order).
  function simStep() {
    const sp = config.speed;
    if (clearP) {                          // "no vapor trails": reset every frame
      histCount = 0;
      const N = Math.max(1, Math.floor(25 / sp));
      if ((rng.random() % N) === 0) clearP = false;
    } else {
      const M = Math.max(1, Math.floor(200 / sp));
      if ((rng.random() % M) === 0) { clearP = true; newCubeColors(); }
    }
    pushHist();
    histDirty = true;
  }

  // ---- per-frame instance buffer rebuild (the for-loop in draw_cube) ----
  const tmpMat = new THREE.Matrix4();
  const tmpPos = new THREE.Vector3();
  const tmpQuat = new THREE.Quaternion();
  const tmpEuler = new THREE.Euler();
  const tmpScale = new THREE.Vector3(4, 4, 4);     // draw_cube Scale(4,4,4)
  function updateInstances() {
    const n = Math.min(histCount, MAX_HIST);
    for (let i = 0; i < n; i++) {
      tmpPos.set((HPx[i] - 0.5) * 15, (HPy[i] - 0.5) * 15, (HPz[i] - 0.5) * 30);
      // glRotatef(rx*360,X) Ry(ry*360) Rz(rz*360) == three Euler XYZ (== Rx*Ry*Rz).
      tmpEuler.set(HRx[i] * TWO_PI, HRy[i] * TWO_PI, HRz[i] * TWO_PI, 'XYZ');
      tmpQuat.setFromEuler(tmpEuler);
      tmpMat.compose(tmpPos, tmpQuat, tmpScale);   // T(pos) * R * S(4)
      inst.setMatrixAt(i, tmpMat);
      inst.setColorAt(i, colors[HC[i]]);
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  }

  // ---- live-config change detection (the .c bakes these at init; we restart) ----
  const lastCfg = { speed: config.speed, count: Math.round(config.count), wander: config.wander, spin: config.spin, thickness: config.thickness };
  function checkConfig() {
    const c = Math.round(config.count);
    if (config.speed !== lastCfg.speed || c !== lastCfg.count ||
        config.wander !== lastCfg.wander || config.spin !== lastCfg.spin) {
      lastCfg.speed = config.speed; lastCfg.count = c;
      lastCfg.wander = config.wander; lastCfg.spin = config.spin;
      initSim();
    }
    if (config.thickness !== lastCfg.thickness) {
      lastCfg.thickness = config.thickness;
      const ng = buildCubeGeometry(config.thickness);
      inst.geometry.dispose();
      inst.geometry = ng;
      cubeGeom = ng;
    }
  }

  // ---- sizing (reshape_cube: gluPerspective + the portrait-fit scale * 1.1) ----
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const s = (w < h ? w / h : 1);     // glScalef(s,s,s); fold in the constant Scale(1.1)
    rootG.scale.setScalar(s * 1.1);
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop: render every rAF; tick the sim at effFps ----
  const MAX_TICKS = 8;
  let raf = 0, last = 0, paused = false, ms = 16, simAccum = 0;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    checkConfig();

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    simAccum += dt * effFps;
    let ticks = 0;
    while (simAccum >= 1 && ticks < MAX_TICKS) { simStep(); simAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) simAccum = 0;       // drop backlog after a stall

    if (histDirty) { updateInstances(); histDirty = false; }
    cubeMat.wireframe = config.wire;

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      inst.geometry.dispose();
      cubeMat.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { initSim(); },     // fresh storm (host 're-seed')
    config,
    params,
  };
}

export default { title, info, start };
