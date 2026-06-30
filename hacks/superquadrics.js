// superquadrics.js -- "Superquadrics" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's superquadrics (Ed Mackey, 1987/1997),
// hacks/glx/superquadrics.c. A superquadric surface -- a quadric whose X and Y
// "roundness" is set by two fractional exponents (Alan Barr, 1981, from Piet Hein's
// superellipse) -- rendered as a res x res grid of quads, smoothly MORPHING between
// random shapes (the two exponents, topology Mode 1..3, two checkerboard colors,
// pitch + bank) while it spins on Y. Self-contained (own overlay canvas + renderer +
// loop), like dangerball.js / morph3d.js.
//
// Faithful to the .c:
//   * the superquadric tables (inputs()): signed-power Sine/Cosine via XtoY (= sign(x)
//     * |x|^e, clipped to 1e4); the Mode bands (Mode<1 closed ellipsoid, 1..3 a
//     transition, Mode 3 the doubled-v torus) via mode3/cn3/inverter2; the dual
//     (2-exponent) surface normals; the seam fix-ups.
//   * DoneScale()'s quad grid + the running 2x2 color toggle (curmat[toggle]), with
//     per-vertex smooth normals.
//   * MakeUpStuff()'s random targets (exponent 0.1..2.6 with the >2 stretch to 3.0,
//     Mode 1..3, the (40..240)/255 colors + the pats[] checkerboard, pitch +-180 /
//     bank +-80) and NextSuperquadric()'s morph<->hold state machine (maxcount morph
//     frames, maxcount>>1 hold, fnow/flater blend) + the continuous Y spin.
//   * draw modelview T(0,0,-(7+3*Mode)) Rx(rotx) Rz(rotz) Ry(roty) Scale(0.7) *
//     portrait-fit; gluPerspective(15); lighting = LIGHT0 from (10,1,1) + its ambient
//     0.4 plus the global default ambient 0.2 (so the floor is 0.6 * color, since the
//     material is GL_AMBIENT_AND_DIFFUSE = the vertex color), specular 0.8 shininess 50,
//     TWO-SIDED (-> THREE.DoubleSide; the .c's per-Mode back/front cull is just an
//     optimization of the same two-sided look).
//
// CULLING/WINDING: like the LWO models in pipes, the .c draws under glFrontFace(GL_CW);
// three is CCW-front, so each emitted triangle is wound to AGREE with its (analytic)
// vertex normals -- otherwise DoubleSide flips the normal and the lit side loses its
// diffuse. PACING (effFps = 1e6/(delay+OVERHEAD)) + raw vertex color (colour management
// off) as in dangerball.js; the morph + spin advance continuously (smooth render, faithful rate).

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding). Disable three's color management so the
// port matches GL: colors are used raw (setRGB(..., SRGBColorSpace) becomes a no-op) and
// the output is not sRGB-encoded. Without this, lit/shaded faces render up to ~2.5x too
// bright (measured vs the rubikblocks grayscale ground truth).
THREE.ColorManagement.enabled = false;

export const title = 'superquadrics';

export const info = {
  author: 'Ed Mackey',
  year: 1987,
  description: 'Morphing 3D shapes.',
};

export function start(hostCanvas, opts = {}) {
  const DEG = Math.PI / 180;
  const OVERHEAD = 37500;        // us; xml default delay 40000 -> ~13fps effective (family default)
  const MaxRes = 50, MinRes = 5; // MaxRes / MinRes
  const CLIP = 10000.0;          // CLIP_NORMALS
  const MAXRAND = 2147483648.0;  // xlockmore MAXRAND (2^31)

  // Knobs transcribed 1:1 from hacks/config/superquadrics.xml.
  const config = {
    delay: 40000,      // us (xml default; invert slider)
    spinspeed: 5.0,    // degrees of Y spin per original-frame (xml --spinspeed)
    count: 25,         // "Density" -> grid resolution (clamped 5..50)
    cycles: 40,        // "Duration" -> morph length in frames (maxcount)
    wire: false,
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 40000, unit: ' µs', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'spinspeed', label: 'Spin speed', type: 'range', min: 0.1, max: 15, step: 0.1, default: 5.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'count', label: 'Density', type: 'range', min: 0, max: 100, step: 1, default: 25, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cycles', label: 'Duration', type: 'range', min: 0, max: 100, step: 1, default: 40, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);
  const LRAND = () => rng.LRAND();
  const myrand = (range) => Math.floor((range * LRAND()) / MAXRAND);   // (int)(range * LRAND()/MAXRAND)
  const myrandreal = () => LRAND() / MAXRAND;

  // pats[4][4] checkerboard patterns (init_superquadrics: pats[1]={0,1,0,1}, etc.).
  const pats = [
    [0, 0, 0, 0],
    [0, 1, 0, 1],
    [0, 0, 1, 1],
    [0, 1, 1, 0],
  ];

  // ---- shape state: morph from `now` to `later` ----
  const mkState = () => ({ xExp: 0, yExp: 0, mode: 1, r: [0, 0, 0, 0], g: [0, 0, 0, 0], b: [0, 0, 0, 0], rotx: 0, rotz: 0 });
  const now = mkState();
  const later = mkState();
  let counter = 0;       // >0 morphing (counts down from maxcount); <=0 holding (up from -maxwait)
  let roty = 0;          // continuous Y spin (degrees)
  let maxcount = 40, maxwait = 20;

  // displayed (per-frame, blended) shape + its 4 checkerboard colors.
  let dXExp = 1, dYExp = 1, dMode = 1, dRotx = 0, dRotz = 0;
  const curmat = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];

  function makeUpStuff(allstuff) {
    if (maxcount < 2) allstuff = 1;
    let dostuff = allstuff * 15;
    if (!dostuff) {
      dostuff = myrand(3) + 1;
      if (myrand(2) || (dostuff & 1)) dostuff |= 4;
      if (myrand(2)) dostuff |= 8;
    }
    if (dostuff & 1) {
      later.xExp = Math.floor(myrandreal() * 250 + 0.5) / 100.0 + 0.1;
      later.yExp = Math.floor(myrandreal() * 250 + 0.5) / 100.0 + 0.1;
      if (later.xExp > 2.0) later.xExp = later.xExp * 2.0 - 2.0;   // stretch 2.0..2.5 -> 2.0..3.0
      if (later.yExp > 2.0) later.yExp = later.yExp * 2.0 - 2.0;
    }
    if (dostuff & 2) {
      do { later.mode = myrand(3) + 1; } while (!allstuff && later.mode === now.mode);
    }
    if (dostuff & 4) {
      const r = (40 + myrand(200)) / 255.0, g = (40 + myrand(200)) / 255.0, b = (40 + myrand(200)) / 255.0;
      const r2 = (myrand(4) && (r < 0.31 || r > 0.69)) ? 1.0 - r : r;
      const g2 = (myrand(4) && (g < 0.31 || g > 0.69)) ? 1.0 - g : g;
      const b2 = (myrand(4) && (b < 0.31 || b > 0.69)) ? 1.0 - b : b;
      const pat = myrand(4);
      for (let t = 0; t < 4; t++) {
        later.r[t] = pats[pat][t] ? r : r2;
        later.g[t] = pats[pat][t] ? g : g2;
        later.b[t] = pats[pat][t] ? b : b2;
      }
    }
    if (dostuff & 8) {
      later.rotx = myrand(360) - 180;
      later.rotz = myrand(160) - 80;
    }
  }

  function setCurrentShape() {
    now.xExp = later.xExp; now.yExp = later.yExp;
    for (let t = 0; t < 4; t++) { now.r[t] = later.r[t]; now.g[t] = later.g[t]; now.b[t] = later.b[t]; }
    now.mode = later.mode; now.rotx = later.rotx; now.rotz = later.rotz;
    counter = -maxwait;
  }

  function computeDisplayed() {
    if (counter > 0) {
      let fnow = counter / maxcount;
      if (fnow > 1) fnow = 1; else if (fnow < 0) fnow = 0;
      const fl = 1 - fnow;
      dXExp = now.xExp * fnow + later.xExp * fl;
      dYExp = now.yExp * fnow + later.yExp * fl;
      dMode = now.mode * fnow + later.mode * fl;
      dRotx = now.rotx * fnow + later.rotx * fl;
      dRotz = now.rotz * fnow + later.rotz * fl;
      for (let t = 0; t < 4; t++) {
        curmat[t][0] = now.r[t] * fnow + later.r[t] * fl;
        curmat[t][1] = now.g[t] * fnow + later.g[t] * fl;
        curmat[t][2] = now.b[t] * fnow + later.b[t] * fl;
      }
    } else {
      dXExp = now.xExp; dYExp = now.yExp; dMode = now.mode; dRotx = now.rotx; dRotz = now.rotz;
      for (let t = 0; t < 4; t++) { curmat[t][0] = now.r[t]; curmat[t][1] = now.g[t]; curmat[t][2] = now.b[t]; }
    }
  }

  function initShapes() {
    counter = 0; roty = 0;
    maxcount = Math.max(1, config.cycles | 0); maxwait = maxcount >> 1;
    makeUpStuff(1); setCurrentShape(); makeUpStuff(1);   // init_superquadrics order
    counter = maxcount;
    computeDisplayed();
  }
  initShapes();

  // NextSuperquadric, made continuous: advance the spin + the morph<->hold machine by
  // `frames` original-frames this render-frame.
  function advance(frames) {
    roty -= config.spinspeed * frames;
    roty = ((roty % 360) + 360) % 360;
    maxcount = Math.max(1, config.cycles | 0); maxwait = maxcount >> 1;

    let f = frames, guard = 0;
    while (f > 1e-9 && guard++ < 1000) {
      if (counter > 0) {                       // morphing: count down to 0, then commit
        const step = Math.min(f, counter); counter -= step; f -= step;
        if (counter <= 1e-9) {
          setCurrentShape();                   // sets counter = -maxwait
          if (maxwait === 0) { makeUpStuff(0); counter = maxcount; }
        }
      } else {                                 // holding: count up to 0, then pick a new target
        const step = Math.min(f, -counter); counter += step; f -= step;
        if (counter >= -1e-9) { makeUpStuff(0); counter = maxcount; }
      }
    }
    computeDisplayed();
  }

  // ---- superquadric tables (inputs) ----
  const se = new Float64Array(MaxRes + 1), ce = new Float64Array(MaxRes + 1);
  const sn = new Float64Array(MaxRes + 1), cn = new Float64Array(MaxRes + 1);
  const sw = new Float64Array(MaxRes + 1), cw = new Float64Array(MaxRes + 1);
  const ss = new Float64Array(MaxRes + 1), cs = new Float64Array(MaxRes + 1);

  function XtoY(x, y) {   // signed power: sign(x) * |x|^y, clipped
    const z = Math.abs(x);
    if (z < 1e-20) return 0.0;
    let a = Math.exp(y * Math.log(z));
    if (a > CLIP) a = CLIP;
    return x < 0 ? -a : a;
  }
  const Sine = (x, e) => XtoY(Math.sin(x), e);
  const Cosine = (x, e) => XtoY(Math.cos(x), e);

  function inputs(res) {
    const Mode = dMode, xE = dXExp, yE = dYExp;
    let mode3, cn3, inverter2;
    if (Mode < 1.000001) { mode3 = 1.0; cn3 = 0.0; inverter2 = 1.0; }
    else if (Mode < 2.000001) { mode3 = 1.0; cn3 = (Mode - 1.0) * 1.5; inverter2 = (Mode - 1.0) * -2.0 + 1.0; }
    else { mode3 = Mode - 1.0; cn3 = (Mode - 2.0) / 2.0 + 1.5; inverter2 = -1.0; }
    const flatu = 0.0, flatv = 0.0;   // flatshade is off

    for (let iv = 1; iv <= res; iv++) {
      const u = (1 - iv) * 2 * Math.PI / (res - 1) + Math.PI;             // PI down to -PI
      const v = (1 - iv) * mode3 * Math.PI / (res - 1) + Math.PI * (mode3 / 2.0);
      se[iv] = Sine(u, xE); ce[iv] = Cosine(u, xE);
      sn[iv] = Sine(v, yE); cn[iv] = Cosine(v, yE) * inverter2 + cn3;
      sw[iv] = Sine(u + flatu, 2 - xE); cw[iv] = Cosine(u + flatu, 2 - xE);
      ss[iv] = Sine(v + flatv, 2 - yE) * inverter2; cs[iv] = Cosine(v + flatv, 2 - yE);
    }
    se[res] = se[1]; ce[res] = ce[1];
    if (Mode > 2.999999) { sn[res] = sn[1]; cn[res] = cn[1]; }
  }

  // ---- geometry buffers (preallocated for MaxRes) ----
  const W = MaxRes + 1;
  const gx = new Float64Array(W * W), gy = new Float64Array(W * W), gz = new Float64Array(W * W);
  const gnx = new Float64Array(W * W), gny = new Float64Array(W * W), gnz = new Float64Array(W * W);
  const maxVerts = 6 * (MaxRes - 1) * (MaxRes - 1);
  const posArr = new Float32Array(maxVerts * 3);
  const norArr = new Float32Array(maxVerts * 3);
  const colArr = new Float32Array(maxVerts * 3);
  const _c = new THREE.Color();
  let vCount = 0;

  function emitTri(vi, i0, i1, i2, col) {
    // wind so the triangle's geometric normal agrees with the analytic vertex normals
    // (the .c is glFrontFace(GL_CW); three is CCW-front -- with DoubleSide a mismatch
    // would flip the normal and dim the lit side).
    const ax = gx[i0], ay = gy[i0], az = gz[i0];
    const ex = gx[i1] - ax, ey = gy[i1] - ay, ez = gz[i1] - az;
    const fx = gx[i2] - ax, fy = gy[i2] - ay, fz = gz[i2] - az;
    const ggx = ey * fz - ez * fy, ggy = ez * fx - ex * fz, ggz = ex * fy - ey * fx;
    const nx = gnx[i0] + gnx[i1] + gnx[i2], ny = gny[i0] + gny[i1] + gny[i2], nz = gnz[i0] + gnz[i1] + gnz[i2];
    const order = (ggx * nx + ggy * ny + ggz * nz < 0) ? [i0, i2, i1] : [i0, i1, i2];
    for (const ix of order) {
      posArr[vi * 3] = gx[ix]; posArr[vi * 3 + 1] = gy[ix]; posArr[vi * 3 + 2] = gz[ix];
      norArr[vi * 3] = gnx[ix]; norArr[vi * 3 + 1] = gny[ix]; norArr[vi * 3 + 2] = gnz[ix];
      colArr[vi * 3] = col[0]; colArr[vi * 3 + 1] = col[1]; colArr[vi * 3 + 2] = col[2];
      vi++;
    }
    return vi;
  }

  function buildGeometry() {
    const res = Math.min(MaxRes, Math.max(MinRes, config.count | 0));
    inputs(res);

    // grid vertices + analytic normals (DoneScale's xx/yy/zz and xn/yn/zn).
    for (let ih = 1; ih <= res; ih++) {
      for (let iv = 1; iv <= res; iv++) {
        const idx = ih * W + iv;
        gx[idx] = cn[iv] * ce[ih]; gy[idx] = sn[iv]; gz[idx] = cn[iv] * se[ih];
        if (cs[iv] > 1e10 || cs[iv] < -1e10) { gnx[idx] = cs[iv]; gny[idx] = ss[iv]; gnz[idx] = cs[iv]; }
        else { gnx[idx] = cs[iv] * cw[ih]; gny[idx] = ss[iv]; gnz[idx] = cs[iv] * sw[ih]; }
      }
    }

    // the 4 checkerboard colors, used raw (colour management off).
    const lc = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let t = 0; t < 4; t++) {
      _c.setRGB(curmat[t][0], curmat[t][1], curmat[t][2], THREE.SRGBColorSpace);
      lc[t][0] = _c.r; lc[t][1] = _c.g; lc[t][2] = _c.b;
    }

    // quads with the running 2x2 toggle; quad (ih,iv) = A(ih,iv) B(ih-1,iv) C(ih-1,iv-1) D(ih,iv-1).
    let vi = 0, toggle = 0;
    for (let ih = 1; ih <= res; ih++) {
      toggle ^= 2;
      for (let iv = 1; iv <= res; iv++) {
        toggle ^= 1;
        if (ih > 1 && iv > 1) {
          const col = lc[toggle];
          const a = ih * W + iv, bb = (ih - 1) * W + iv, cc = (ih - 1) * W + (iv - 1), dd = ih * W + (iv - 1);
          vi = emitTri(vi, a, bb, cc, col);
          vi = emitTri(vi, a, cc, dd, col);
        }
      }
    }
    vCount = vi;
    posAttr.needsUpdate = true; norAttr.needsUpdate = true; colAttr.needsUpdate = true;
    geom.setDrawRange(0, vCount);
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

  // gluPerspective(15, aspect, 0.1, 200), camera at origin looking -z.
  const camera = new THREE.PerspectiveCamera(15, 1, 0.1, 200);
  camera.position.set(0, 0, 0);

  // LIGHT0 (10,1,1) + ambient 0.4, plus the global default ambient 0.2; the material is
  // GL_AMBIENT_AND_DIFFUSE = the surface color, so the ambient floor is 0.6 * color.
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(10, 1, 1);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6 * Math.PI));

  // specular: GL uses 0.8 gray @ shininess 50. The light intensity is PI (to cancel
  // three's 1/PI Lambert for the DIFFUSE term) -- but that same PI over-drives the
  // SPECULAR, blowing the highlight into a white disc. So divide the specular by PI
  // (0.8/PI) to land the highlight peak back at GL's ~0.8 (a bright glossy glint, not a
  // blown-out blob). shininess stays the faithful 50. [cf. the morph3d specular fix.]
  const material = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    vertexColors: true,
    specular: new THREE.Color().setRGB(0.8 / Math.PI, 0.8 / Math.PI, 0.8 / Math.PI, THREE.SRGBColorSpace),
    shininess: 50,
    side: THREE.DoubleSide,
  });

  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(posArr, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
  const norAttr = new THREE.BufferAttribute(norArr, 3); norAttr.setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(colArr, 3); colAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('position', posAttr);
  geom.setAttribute('normal', norAttr);
  geom.setAttribute('color', colAttr);

  // modelview nesting: T(0,0,-(7+3*Mode)) > Rx(rotx) > Rz(rotz) > Ry(roty) > Scale(0.7*fit).
  const distG = new THREE.Group();
  const pitchG = new THREE.Group();
  const bankG = new THREE.Group();
  const spinG = new THREE.Group();
  const scaleG = new THREE.Group();
  const mesh = new THREE.Mesh(geom, material);
  scaleG.add(mesh); spinG.add(scaleG); bankG.add(spinG); pitchG.add(bankG); distG.add(pitchG);
  scene.add(distG);

  let portraitFit = 1;
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    portraitFit = (w < h ? w / h : 1);   // ReshapeSuperquadrics' glScalef(s,s,s)
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop: continuous morph + spin at effFps ----
  let raf = 0, last = 0, paused = false, ms = 16;
  function tick(t) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = t; return; }
    const frame = t - last;
    last = t;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;

    advance(frames);
    buildGeometry();

    distG.position.z = -(7 + 3 * dMode);    // -(dist/16) - (Mode*3 - 1), dist = 128
    pitchG.rotation.x = dRotx * DEG;
    bankG.rotation.z = dRotz * DEG;
    spinG.rotation.y = roty * DEG;
    scaleG.scale.setScalar(0.7 * portraitFit);
    material.wireframe = config.wire;

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      geom.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { initShapes(); },   // fresh random shapes (host 're-seed')
    config,
    params,
  };
}

export default { title, info, start };
