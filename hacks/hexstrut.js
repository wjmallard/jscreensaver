// hexstrut.js -- "Hex Strut" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's hexstrut (Jamie Zawinski, 2016),
// hacks/glx/hexstrut.c. A flat plane tiled with upward-pointing equilateral
// triangles; each triangle is drawn as a Y of three flat "struts" (beams) from its
// centroid out to its three corners. Where the leg-tips of neighbouring Y's meet,
// the empty gaps read as a honeycomb of hexagons. Waves of in-plane rotation +
// colour change propagate outward across the plane from randomly-seeded cells; the
// whole sheet rolls slowly about its normal and wanders, viewed at a fixed random
// tilt. Self-contained three.js (own overlay canvas + renderer + loop), like
// dangerball.js / superquadrics.js. No assets.
//
// FAITHFUL TO hexstrut.c -- "do not deviate from the algorithm":
//   * UNLIT, FLAT colour. The .c never enables GL_LIGHTING (its glMaterialfv calls
//     are dead), draws solid GL_QUADS with one glColor per triangle, and runs with
//     GL_DEPTH_TEST and GL_CULL_FACE *disabled* -- so this is MeshBasicMaterial
//     (vertex colours), DoubleSide, depthTest/depthWrite off. Every strut vertex is
//     in the object's z=0 plane (the only 3D is the global tilt/roll/wander below).
//   * make_plane: n = count*2; an n x n grid of identical upward triangles, size =
//     2/n, w = size, h = size*sqrt(3)/2, odd rows shifted +w/2; the neighbour graph
//     (left, the row below, and the row-below-right) built bidirectionally exactly
//     as link_neighbor. The list is prepend-built, so iteration order is reverse
//     creation order -- preserved (it indexes the random cell seed + the draw order).
//   * draw_triangles: length = sqrt(3)/3, t2 = length*thickness/2, scale = |p0-p1|
//     (= the triangle edge = size); each leg is a quad from the centroid c (offset
//     +-(xt2,yt2) across the beam) to a far end at radius length*scale, swung by
//     angle = (2*PI/3)*rot. At rot=0 the far end lands exactly on the corner.
//   * tick_triangles: step = 0.01 + 0.04*speed; a 1/80 chance/frame seeds a random
//     idle cell (rot += step*+-1, delay = odelay = 4); rotating cells advance rot in
//     fixed step, cycle ccolor, and bank a full +-1 turn (orot, unused in draw) then
//     reset rot to 0 (the Y's 3-fold symmetry makes a 120deg turn seamless, so the
//     lasting effect is the colour shift); when a cell's delay counts down to 0 it
//     kicks its idle neighbours into the same-signed rotation -> an outward wave.
//   * the per-cell colour = a 64-entry make_smooth_colormap entry, BRIGHTENED
//     (c*0.75 + 0.25), used raw (colour management off).
//   * draw modelview: gluLookAt(0,0,30) * portrait-fit S(s) * T(wander) * trackball
//     tilt * Rz(roll*360) * S(30); gluPerspective(30). The "let's tilt the scene"
//     fixed initial trackball orientation (trackball(0,0,x,y), x,y = -0.4+frand(0.8))
//     is ported verbatim (quaternion -> the exact GL matrix). Spin uses ONLY the
//     rotator's z component (a roll about the sheet normal); wander is its position.
//
// PACING as in dangerball.js: effFps = 1e6/(delay+OVERHEAD), OVERHEAD = 37500. The
// wave (tick_triangles) is DISCRETE -- integer delays + per-frame random events --
// so it is ticked once per original-frame at effFps (NOT advanced by a fraction),
// exactly reproducing the original's stepping; the geometry is rebuilt every render
// frame from the current state. The slow global rotator is likewise ticked per
// original-frame and INTERPOLATED between samples (cheap, and imperceptible here
// since spin/wander speeds are tiny). RNG (yarandom.js), motion (rotator.js) and the
// palette (colormap.js) are the shared faithful ports.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';
import { makeSmoothColormap } from './colormap.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding). Disable three's color management so the
// port matches GL: set at MODULE SCOPE (before start() fills colors) so the
// setRGB(..., SRGBColorSpace) calls become no-ops and store RAW glColor, and the output
// is not sRGB-encoded. Without this, lit/shaded faces render up to ~2.5x too bright
// (measured vs the rubikblocks grayscale ground truth).
THREE.ColorManagement.enabled = false;

export const title = 'hexstrut';

export const info = {
  author: 'Jamie Zawinski',
  year: 2016,
  description: 'A grid of hexagons composed of rotating Y-shaped struts. Waves of rotation and color changes randomly propagate across the plane.',
};

export function start(hostCanvas, opts = {}) {
  const DEG = Math.PI / 180;
  const OVERHEAD = 37500;             // us; pacing (xml default delay 30000 -> ~15fps)
  const NCOLORS = 64;                 // bp->ncolors
  const LENGTH = Math.sqrt(3) / 3;    // draw_triangles: leg length factor
  const TWO_PI_3 = (Math.PI * 2) / 3; // per-cell rotation: angle = (2pi/3)*rot
  const MAX_TICKS = 8;                // catch-up cap (avoid spiral after a stall)

  // Knobs transcribed 1:1 from hacks/config/hexstrut.xml (the host renders the box
  // from `params` and mutates `config` in place). `delay` is the frame-rate knob;
  // `speed`/`thickness` are clamped exactly as init_hexstrut does.
  const config = {
    delay: 30000,      // us (xml default; invert slider)
    speed: 1.0,        // rotation step speed (xml --speed; clamped <= 2)
    count: 20,         // grid is (count*2)^2 triangles (xml --count, "Hexagon Size")
    thickness: 0.2,    // strut beam thickness (xml --thickness; clamped 0.05..1.7)
    wander: true,      // drift through space (do_wander)
    spin: true,        // roll about the sheet normal (do_spin)
    wire: false,       // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' µs', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.1, max: 5, step: 0.1, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'count', label: 'Hexagon size', type: 'range', min: 2, max: 80, step: 1, default: 20, invert: true, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'thickness', label: 'Line thickness', type: 'range', min: 0.01, max: 1.7, step: 0.01, default: 0.2, lowLabel: 'thin', highLabel: 'thick', live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'spin', label: 'Spin', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);   // 0 => time-seeded (random per run)

  // ---- init_hexstrut's RNG-consuming order: rotator, then the tilt, then colours ----
  // make_rotator(spin 0.002 x3 if do_spin, accel 1.0, wander 0.003 if do_wander). We
  // build it always-on (the frand draws are identical either way) and gate the OUTPUT
  // by config.spin/config.wander so the toggles stay live, as dangerball.js does.
  const rot = makeRotator(
    {
      spinX: 0.002, spinY: 0.002, spinZ: 0.002,
      spinAccel: 1.0,
      wanderSpeed: 0.003,
      randomize: false,
    },
    rng,
  );

  // "Let's tilt the scene a little": gltrackball_reset(tb, -0.4+frand(0.8), ...) then
  // gltrackball_rotate. Ported verbatim below -> the exact GL matrix.
  const tiltX = -0.4 + rng.frand(0.8);
  const tiltY = -0.4 + rng.frand(0.8);

  // 64-entry smooth colormap, brightened (used raw -- colour management off), as a per-index LUT.
  const _c = new THREE.Color();
  let lut = new Float32Array(NCOLORS * 3);
  function rebuildLut() {
    const cm = makeSmoothColormap(rng, NCOLORS);
    for (let i = 0; i < NCOLORS; i++) {
      // draw_triangles "Brighter": color = color*0.75 + 0.25 (the glColor space the .c
      // writes straight to the framebuffer); used raw (colour management off).
      _c.setRGB(cm[i].r * 0.75 + 0.25, cm[i].g * 0.75 + 0.25, cm[i].b * 0.75 + 0.25, THREE.SRGBColorSpace);
      lut[i * 3] = _c.r; lut[i * 3 + 1] = _c.g; lut[i * 3 + 2] = _c.b;
    }
  }
  rebuildLut();

  // ===================================================================
  //  trackball tilt: trackball(0,0,x,y) -> axis_to_quat -> quat_to_rotmatrix,
  //  applied via glMultMatrixf. Ported exactly from trackball.c / quaternion.c /
  //  gltrackball.c; the 16-float array is loaded column-major (GL order) into a
  //  THREE.Matrix4, so this group's local matrix IS the GL trackball matrix.
  // ===================================================================
  function trackballMatrix(p2x, p2y) {
    const m = new THREE.Matrix4();
    if (p2x === 0 && p2y === 0) return m;     // trackball() identity short-circuit
    const R = 0.8, SQRT2 = Math.SQRT2, SQRT1_2 = Math.SQRT1_2;
    const project = (x, y) => {               // tb_project_to_sphere(R, x, y)
      const d = Math.sqrt(x * x + y * y);
      if (d < R * SQRT1_2) return Math.sqrt(R * R - d * d);   // inside sphere
      const t = R / SQRT2; return (t * t) / d;                // on hyperbola
    };
    const p1z = project(0, 0), p2z = project(p2x, p2y);       // p1 = (0,0,p1z)
    // a = cross(p2, p1)
    const ax = p2y * p1z - p2z * 0;
    const ay = p2z * 0 - p2x * p1z;
    const az = p2x * 0 - p2y * 0;
    // d = p1 - p2; phi = 2*asin(|d| / (2R))
    const dx = -p2x, dy = -p2y, dz = p1z - p2z;
    let t = Math.sqrt(dx * dx + dy * dy + dz * dz) / (2 * R);
    if (t > 1) t = 1; else if (t < -1) t = -1;
    const phi = 2 * Math.asin(t);
    // axis_to_quat(a, phi): q = (normalize(a)*sin(phi/2), cos(phi/2))
    const alen = Math.sqrt(ax * ax + ay * ay + az * az);
    const sh = Math.sin(phi / 2) / alen;
    const qx = ax * sh, qy = ay * sh, qz = az * sh, qw = Math.cos(phi / 2);
    // quat_to_rotmatrix(q, m): the 16 floats GL receives (column-major).
    m.fromArray([
      1 - 2 * (qy * qy + qz * qz),  2 * (qx * qy - qz * qw),      2 * (qz * qx + qy * qw),      0,
      2 * (qx * qy + qz * qw),      1 - 2 * (qz * qz + qx * qx),  2 * (qy * qz - qx * qw),      0,
      2 * (qz * qx - qy * qw),      2 * (qy * qz + qx * qw),      1 - 2 * (qy * qy + qx * qx),  0,
      0, 0, 0, 1,
    ]);
    return m;
  }

  // ===================================================================
  //  the plane: per-cell constants + the neighbour graph + dynamic state.
  // ===================================================================
  let n = 0, scale = 0, triCount = 0;
  let cx, cy;              // centroid (Float64Array[triCount])
  let relX, relY, invR, slen;   // per-corner constants (Float64Array[triCount*3])
  let nbr;                // neighbour indices, -1 padded (Int32Array[triCount*6])
  // dynamic per-cell state (calloc -> all zero)
  let trot, torot, tdelay, todelay, tccolor;

  // link_neighbor(t0, t1): add t1 to t0's neighbour list (dedup, capacity 6).
  function addNeighbor(t0, t1) {
    if (!t0 || !t1 || t0 === t1) return;
    for (let k = 0; k < 6; k++) {
      if (t0.nb[k] === t1 || t0.nb[k] === undefined) { t0.nb[k] = t1; return; }
    }
  }

  let geom = null, posArr = null, colArr = null, posAttr = null, colAttr = null;

  function buildPlane() {
    n = (config.count | 0) * 2;
    if (n < 2) n = 2;
    const size = 2.0 / n;
    const w = size;
    const h = (size * Math.sqrt(3)) / 2;

    // make_plane in creation order (y outer, x inner), with the neighbour links.
    const grid = new Array(n * n).fill(null);
    const created = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let p0x = (x - (n >> 1)) * w;
        const p0y = (y - (n >> 1)) * h;
        if (y & 1) p0x += w / 2;
        const t = {
          p: [
            { x: p0x,         y: p0y },
            { x: p0x - w / 2, y: p0y + h },
            { x: p0x + w / 2, y: p0y + h },
          ],
          nb: [],
          idx: 0,
        };
        if (x > 0) { const t2 = grid[y * n + (x - 1)]; addNeighbor(t, t2); addNeighbor(t2, t); }
        if (y > 0) {
          const t2 = grid[(y - 1) * n + x]; addNeighbor(t, t2); addNeighbor(t2, t);
          if (x < n - 1) { const t3 = grid[(y - 1) * n + (x + 1)]; addNeighbor(t, t3); addNeighbor(t3, t); }
        }
        grid[y * n + x] = t;
        created.push(t);
      }
    }

    // bp->triangles is prepend-built -> iteration order is reverse creation order.
    const tris = created.slice().reverse();
    triCount = tris.length;
    for (let i = 0; i < triCount; i++) tris[i].idx = i;

    cx = new Float64Array(triCount);
    cy = new Float64Array(triCount);
    relX = new Float64Array(triCount * 3);
    relY = new Float64Array(triCount * 3);
    invR = new Float64Array(triCount * 3);
    slen = new Float64Array(triCount * 3);
    nbr = new Int32Array(triCount * 6).fill(-1);
    trot = new Float64Array(triCount);
    torot = new Int32Array(triCount);
    tdelay = new Int32Array(triCount);
    todelay = new Int32Array(triCount);
    tccolor = new Int32Array(triCount);

    // scale = |p0 - p1| of the first triangle (= the triangle edge length = size).
    scale = w;

    for (let i = 0; i < triCount; i++) {
      const t = tris[i];
      const ccx = (t.p[0].x + t.p[1].x + t.p[2].x) / 3;
      const ccy = (t.p[0].y + t.p[1].y + t.p[2].y) / 3;
      cx[i] = ccx; cy[i] = ccy;
      for (let k = 0; k < 3; k++) {
        const rx = t.p[k].x - ccx;
        const ry = t.p[k].y - ccy;
        const r = Math.sqrt(rx * rx + ry * ry);   // |corner - centroid| (z = 0)
        relX[i * 3 + k] = rx; relY[i * 3 + k] = ry;
        invR[i * 3 + k] = 1 / r;
        slen[i * 3 + k] = (LENGTH * scale) / r;   // far-end radius factor (const)
      }
      for (let k = 0; k < 6; k++) nbr[i * 6 + k] = t.nb[k] !== undefined ? t.nb[k].idx : -1;
    }

    // (re)allocate the strut geometry: 3 legs * (1 quad = 2 tris = 6 verts) = 18/cell.
    const maxVerts = triCount * 18;
    posArr = new Float32Array(maxVerts * 3);
    colArr = new Float32Array(maxVerts * 3);
    const old = geom;
    geom = new THREE.BufferGeometry();
    posAttr = new THREE.BufferAttribute(posArr, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
    colAttr = new THREE.BufferAttribute(colArr, 3); colAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', posAttr);
    geom.setAttribute('color', colAttr);
    if (mesh) mesh.geometry = geom;
    if (old) old.dispose();

    buildGeometry();
  }

  // ---- rebuild the strut quads from the current per-cell rot + colour ----
  function buildGeometry() {
    let thick = config.thickness;
    if (thick < 0.05) thick = 0.05; else if (thick > 1.7) thick = 1.7;
    const t2 = (LENGTH * thick) / 2;

    let vi = 0;
    for (let i = 0; i < triCount; i++) {
      const angle = TWO_PI_3 * trot[i];
      const cr = Math.cos(angle), sr = Math.sin(angle);
      const ccx = cx[i], ccy = cy[i];
      const ci = tccolor[i] * 3;
      const rcol = lut[ci], gcol = lut[ci + 1], bcol = lut[ci + 2];

      for (let k = 0; k < 3; k++) {
        const j = i * 3 + k;
        const rx = relX[j], ry = relY[j];
        const st2 = t2 * scale * invR[j];     // half-thickness offset magnitude
        const sl = slen[j];
        const smc = sr * ry - cr * rx;
        const spc = cr * ry + sr * rx;
        const xt2 = spc * st2, yt2 = smc * st2;
        const xlen = ccx - sl * smc;
        const ylen = ccy + sl * spc;
        // beam quad (all z = 0): V0 near-A, V1 near-B, V2 far-B, V3 far-A.
        const v0x = ccx - xt2, v0y = ccy - yt2;
        const v1x = ccx + xt2, v1y = ccy + yt2;
        const v2x = xlen + xt2, v2y = ylen + yt2;
        const v3x = xlen - xt2, v3y = ylen - yt2;
        // two triangles (0,1,2)(0,2,3); winding irrelevant (unlit, DoubleSide).
        const verts = [v0x, v0y, v1x, v1y, v2x, v2y, v0x, v0y, v2x, v2y, v3x, v3y];
        for (let q = 0; q < 6; q++) {
          const o = vi * 3;
          posArr[o] = verts[q * 2]; posArr[o + 1] = verts[q * 2 + 1]; posArr[o + 2] = 0;
          colArr[o] = rcol; colArr[o + 1] = gcol; colArr[o + 2] = bcol;
          vi++;
        }
      }
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    geom.setDrawRange(0, vi);
  }

  // ---- tick_triangles: one DISCRETE original-frame of the propagating wave ----
  function tickTriangles() {
    let sp = config.speed;
    if (sp > 2) sp = 2;                  // init_hexstrut: if (speed > 2) speed = 2
    const step = 0.01 + 0.04 * sp;

    // 1/80 chance: seed a random idle cell (random()%count picks the nth in the list,
    // which is our array order; if (! t->rot) start it turning +-1, delay = odelay = 4).
    if ((rng.random() % 80) === 0) {
      const ni = rng.random() % triCount;
      if (trot[ni] === 0) {
        trot[ni] += step * ((rng.random() & 1) ? 1 : -1);
        todelay[ni] = tdelay[ni] = 4;
      }
    }

    for (let t = 0; t < triCount; t++) {
      if (trot[t] !== 0) {                 // rotating: continue until a full turn done
        trot[t] += step * (trot[t] > 0 ? 1 : -1);
        tccolor[t]++; if (tccolor[t] >= NCOLORS) tccolor[t] = 0;
        if (trot[t] > 1 || trot[t] < -1) { torot[t] += (trot[t] > 1 ? 1 : -1); trot[t] = 0; }
      }
      if (tdelay[t] !== 0) {               // propagation delay: kick neighbours at 0
        tdelay[t]--;
        if (tdelay[t] === 0) {
          for (let k = 0; k < 6; k++) {
            const nb = nbr[t * 6 + k];
            if (nb >= 0 && trot[nb] === 0) {
              trot[nb] += step * (trot[t] > 0 ? 1 : -1);
              tdelay[nb] = todelay[nb] = todelay[t];
            }
          }
        }
      }
    }
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

  // gluPerspective(30, aspect, 1, 100) + gluLookAt(0,0,30, 0,0,0, 0,1,0).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // UNLIT flat colour (the .c never enables lighting): MeshBasicMaterial with vertex
  // colours; DoubleSide (glDisable(GL_CULL_FACE)); depth test/write off
  // (glDisable(GL_DEPTH_TEST)) -- everything is coplanar so it paints in buffer order.
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });
  let mesh = null;

  // modelview nesting (camera = gluLookAt; the rest is the object world matrix):
  //   portrait S(s) > wander T > trackball tilt > roll Rz > S(30) > mesh.
  const portraitG = new THREE.Group();
  const wanderG = new THREE.Group();
  const tiltG = new THREE.Group();
  tiltG.matrixAutoUpdate = false;
  tiltG.matrix.copy(trackballMatrix(tiltX, tiltY));
  const rollG = new THREE.Group();
  const scaleG = new THREE.Group();
  scaleG.scale.setScalar(30);
  portraitG.add(wanderG); wanderG.add(tiltG); tiltG.add(rollG); rollG.add(scaleG);
  scene.add(portraitG);

  mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  scaleG.add(mesh);

  buildPlane();   // sets mesh.geometry + fills the initial (rot=0) static Y's

  // ---- sizing (reshape: gluPerspective + the portrait-fit s = (W<H? W/H : 1)) ----
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    portraitG.scale.setScalar(w < h ? w / h : 1);
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- rotator sampling + interpolation (the slow global roll + wander) ----
  // C draw order: get_position then get_rotation, both update=true (button never down).
  const p0 = rot.getPosition(false), r0 = rot.getRotation(false);
  let prevP = { ...p0 }, curP = { ...p0 };
  let prevR = { ...r0 }, curR = { ...r0 };
  function tickRotator() {
    prevP = curP; curP = rot.getPosition(true);
    prevR = curR; curR = rot.getRotation(true);
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  function lerpAngle(a, b, t) {                 // shortest path on the [0,1) circle
    let d = b - a;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    return a + d * t;
  }

  // ---- render loop: discrete wave + slow rotator at effFps, geometry every frame ----
  let raf = 0, last = 0, paused = false, ms = 16, rotAccum = 0;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    if ((config.count | 0) * 2 !== n) buildPlane();   // live "Hexagon Size" change

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;

    // Discrete: tick the wave + the rotator once per original-frame at effFps.
    rotAccum += frames;
    let ticks = 0;
    while (rotAccum >= 1 && ticks < MAX_TICKS) { tickTriangles(); tickRotator(); rotAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) rotAccum = 0;
    const a = rotAccum;

    // roll: glRotatef(z*360, 0,0,1) -> rotation about the sheet normal (z in [0,1)).
    rollG.rotation.z = config.spin ? lerpAngle(prevR.z, curR.z, a) * 2 * Math.PI : 0;
    // wander: T((x-.5)*6, (y-.5)*6, (z-.5)*12) in the portrait-scaled frame.
    if (config.wander) {
      wanderG.position.set(
        (lerp(prevP.x, curP.x, a) - 0.5) * 6,
        (lerp(prevP.y, curP.y, a) - 0.5) * 6,
        (lerp(prevP.z, curP.z, a) - 0.5) * 12,
      );
    } else wanderG.position.set(0, 0, 0);

    material.wireframe = config.wire;
    buildGeometry();
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      if (geom) geom.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() {                       // fresh palette + a calm (un-rotated) plane
      trot.fill(0); torot.fill(0); tdelay.fill(0); todelay.fill(0); tccolor.fill(0);
      rebuildLut();
    },
    config,
    params,
  };
}

export default { title, info, start };
