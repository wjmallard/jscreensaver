// glknots.js -- "GL Knots" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's glknots (Jamie Zawinski, 2003),
// hacks/glx/glknots.c (+ hacks/glx/tube.c). A random 3D KNOT -- a closed
// parametric loop (one of two families, "type 0"/"type 1", from 9 small integer
// params) -- rendered as one fat, smooth, single-colored TUBE that spins and
// wanders while its color slowly cycles. Every `duration` seconds (wall-clock) it
// shrinks the knot away, generates a fresh random one, and grows it back.
//
// Self-contained on purpose (own overlay canvas + renderer + render loop), like
// dangerball.js / superquadrics.js -- it only follows the host's mountable-module
// contract (start(canvas) -> a handle with stop/pause/resume/getStats/reinit).
//
// Faithful to the .c:
//   * make_knot(): blobby_p = (0==random()%5); type = random()%2; the 9 params
//     p[i] = 1+random()%4, with 1/3 chance += random()%5; type-1's
//     p[0]+=4 / p[1]*=((p[0]+p[0])/10) (float) / blobby_p=false adjustments; the
//     two parametric loops (type 0 / type 1) sampled i=0..segments.
//   * tube.c's tube geometry: a unit tube of RADIUS `diameter` (the C uses the
//     `diameter` arg as the radius), smooth (radial) normals, 6 faces. Per-segment
//     radius `di`: non-blobby = diam = 4*thickness (constant); blobby (1/5 of
//     type-0 knots) = (dist*(segments/500))^2 * 3, varying along the curve.
//   * new_knot()'s colormap: make_smooth_colormap(128) then "twice as bright"
//     c' = (c>>2)+0x7FFF on 16-bit channels (-> [0.5,0.75] pastel); the whole knot
//     is ONE material color = colors[ccolor], ccolor advancing one step per frame.
//   * draw_knot()'s regen state machine (mode 0 normal for `duration` s, mode 1
//     "out" shrink over 10/speed frames, new_knot, mode 2 "in" grow over 10/speed),
//     and clear_p = !!(random()%15) (1/15 of knots DON'T clear -> a spinning smear).
//   * init_knot()'s rotator make_rotator(spin?2:0 per axis, accel 0.2,
//     wander?0.05:0, randomize=all-three-spin) + wander (x-.5)*8,(y-.5)*8,(z-.5)*15
//     + glRotatef x,y,z*360; the glScalef(0.25) object scale and the reshape
//     portrait fit; gluPerspective(30) cam at (0,0,30).
//   * lighting: directional white light from (1,1,1) + GL's default global ambient
//     0.2; material GL_AMBIENT_AND_DIFFUSE = the cycling color, specular white *
//     light-specular cyan (0,1,1) = a CYAN highlight, shininess 128. (Light
//     intensity = PI to cancel three's 1/PI Lambert, specular /PI so the highlight
//     doesn't blow out -- the superquadrics.js convention; ambient floor 0.2*color.)
//
// GEOMETRY (deliberate, faithful, documented in glknots.md): the .c draws each of the
// ~800 segments as its own fat overlapping cylinder (cap_size = dist/3, so consecutive
// discs overlap into one continuous tube; caps_p = wire, so in solid mode the segments
// are UNCAPPED). We build ONE continuous swept-tube BufferGeometry instead: a ring of 6
// vertices perpendicular to the curve tangent at each point (radius = that point's di),
// smooth radial normals, consecutive rings stitched with quads. This reproduces the
// exact ENVELOPE of the C's overlapping cylinders (including blobby's varying radius).
// A rotation-minimizing (parallel-transport) frame avoids twist; for CLOSED knots its
// holonomy is corrected (a -theta*i/N counter-rotation spread across the rings) so ring
// N lands exactly on ring 0 -- a seamless closure, no dark seam notch.
//
// Motion (rotator.js), palette (colormap.js) and RNG (yarandom.js) are faithful
// standalone ports. PACING: render every rAF; effFps = 1e6/(delay+OVERHEAD);
// spin/color/grow-shrink advance by `frames = dt*effFps`; the `duration` timer runs
// off real wall-clock seconds (as the .c does). The rotator's discrete random-walk
// is ticked at effFps and INTERPOLATED for smoothness (the dangerball.js pattern).

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';
import { makeSmoothColormap } from './colormap.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding). Disable three's color management so
// the port matches GL: colors are used raw and the output is not sRGB-encoded.
// Without this, lit/shaded faces render up to ~2.5x too bright.
THREE.ColorManagement.enabled = false;

export const title = 'glknots';

export const info = {
  author: 'Jamie Zawinski',
  year: 2003,
  description:
    'Generates some twisting 3d knot patterns. Spins \'em around.\n\n' +
    'https://en.wikipedia.org/wiki/Knot_theory',
};

export function start(hostCanvas, opts = {}) {
  // ---- constants (glknots.c DEFAULTS / #defines + tube.c) ----
  const NCOLORS = 128;            // bp->ncolors
  const DURATION = 8;             // DEF_DURATION (command-line-only; not a UI knob)
  const FACES = 6;                // tube.c faces (non-wireframe)
  const MAX_SEG = 2000;           // xml segments slider high; geometry preallocation
  const MAX_TICKS = 8;            // rotator catch-up cap (avoids spiral after a stall)
  // us; the GL family's shared overhead default. Live GL hacks can't be timed under
  // this machine's XQuartz Apple-DRI block, so every three.js port adopts the same
  // measured 37500 (gears/pipes/dangerball/morph3d/...). xml delay 30000 ->
  // effFps = 1e6/67500 ~= 14.8fps. See framerate-calibration.
  const OVERHEAD = 37500;

  // Knobs transcribed 1:1 from hacks/glknots.xml (the host renders the box from
  // `params` and mutates `config` in place). `delay` is the frame-rate knob;
  // `duration` is intentionally NOT exposed (xml has no UI for it).
  const config = {
    delay: 30000,        // us (xml default; invert slider)
    speed: 1.0,          // grow/shrink + regen speed (xml --speed)
    rotation: 'XYZ',     // spin axes (xml <select>; default = all three)
    segments: 800,       // "Resolution" (xml --segments; curve sample count)
    thickness: 0.3,      // tube thickness (xml --thickness; diam = 4*thickness)
    wander: true,        // drift through space (do_wander)
    wire: false,         // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.01, max: 5.0, step: 0.01, default: 1.0, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    {
      key: 'rotation', label: 'Rotation', type: 'select', default: 'XYZ', live: true,
      options: [
        { value: '0', label: 'Don\'t rotate' },
        { value: 'X', label: 'Rotate around X axis' },
        { value: 'Y', label: 'Rotate around Y axis' },
        { value: 'Z', label: 'Rotate around Z axis' },
        { value: 'XY', label: 'Rotate around X and Y axes' },
        { value: 'XZ', label: 'Rotate around X and Z axes' },
        { value: 'YZ', label: 'Rotate around Y and Z axes' },
        { value: 'XYZ', label: 'Rotate around all three axes' },
      ],
    },
    { key: 'segments', label: 'Resolution', type: 'range', min: 100, max: 2000, step: 10, default: 800, lowLabel: 'Segmented', highLabel: 'Smooth', live: true },
    { key: 'thickness', label: 'Thickness', type: 'range', min: 0.05, max: 1.0, step: 0.05, default: 0.3, lowLabel: 'Thin', highLabel: 'Thick', live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);

  // "make colors twice as bright": on the 16-bit channel, c' = (c>>2) + 0x7FFF.
  // colormap.js returns channels as trunc(C*65535)/65536, so *65536 recovers the
  // exact 16-bit int; we redo the C's shift/add and divide back. -> [0.5, 0.75].
  const bright = (v) => ((Math.round(v * 65536) >> 2) + 0x7fff) / 65536;

  // ---- knot state ----
  let knotParams = null;          // { type, p[9], blobby }
  let knotPoints = null;          // sampled curve points (length N+1)
  let knotRadii = null;           // per-ring radius (length N+1)
  let colors = [];                // NCOLORS brightened THREE.Color
  let ccolor = 0;                 // color-cycle cursor (float; index = floor)
  let clearP = true;              // clear each frame? (1/15 of knots smear)
  let builtSegments = -1, builtThickness = -1;

  const clampThickness = (t) => (t <= 0 ? 0.001 : t > 1 ? 1 : t);

  // make_knot(): sample one of the two knot families. All p are integer EXCEPT
  // type-1's p[1] (multiplied by the float (p[0]+p[0])/10), exactly as the .c.
  function sampleKnot(kp, nseg) {
    const { type, p } = kp;
    const pts = new Array(nseg + 1);
    const TWO_PI = Math.PI * 2;
    for (let i = 0; i <= nseg; i++) {
      let mu, x, y, z;
      if (type === 0) {
        mu = (i * TWO_PI) / nseg;
        x = 10 * (Math.cos(mu) + Math.cos(p[0] * mu)) + Math.cos(p[1] * mu) + Math.cos(p[2] * mu);
        y = 6 * Math.sin(mu) + 10 * Math.sin(p[3] * mu);
        z = 16 * Math.sin(p[4] * mu) * Math.sin((p[5] * mu) / 2) + p[6] * Math.sin(p[7] * mu) - 2 * Math.sin(p[8] * mu);
      } else {
        mu = (i * TWO_PI * p[0]) / nseg;
        x = 10 * Math.cos(mu) * (1 + Math.cos((p[1] * mu) / p[0]) / 2);
        y = (25 * Math.sin((p[1] * mu) / p[0])) / 2;
        z = 10 * Math.sin(mu) * (1 + Math.cos((p[1] * mu) / p[0]) / 2);
      }
      pts[i] = { x, y, z };
    }
    return pts;
  }

  // Per-ring radius `di`. Non-blobby: constant diam = 4*thickness. Blobby (type-0
  // only): di = (dist*(segments/500))^2 * 3 for the segment ending at this point.
  function computeRadii(pts, kp, nseg, thickness) {
    const r = new Array(nseg + 1);
    if (!kp.blobby) {
      const diam = 4 * thickness;
      for (let i = 0; i <= nseg; i++) r[i] = diam;
      return r;
    }
    const segDi = (i) => {
      const a = pts[i], b = pts[i - 1];
      const dist = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      const di = dist * (nseg / 500.0);
      return di * di * 3;
    };
    r[0] = segDi(1);              // ring 0 has no incoming segment; use 0->1
    for (let i = 1; i <= nseg; i++) r[i] = segDi(i);
    return r;
  }

  // new_knot(): roll clear_p, build a fresh colormap (+ brighten), pick a fresh
  // random knot. RNG ORDER matches the .c: clear_p, colormap, blobby, type, p[].
  function newKnot() {
    clearP = (rng.random() % 15) !== 0;     // !!(random()%15): false (smear) 1/15
    const cmap = makeSmoothColormap(rng, NCOLORS);
    colors = cmap.map((c) => new THREE.Color().setRGB(bright(c.r), bright(c.g), bright(c.b), THREE.SRGBColorSpace));

    let blobby = (rng.random() % 5) === 0;
    const type = rng.random() % 2;
    const p = new Array(9);
    for (let i = 0; i < 9; i++) {
      p[i] = 1 + (rng.random() % 4);
      if (rng.random() % 3 === 0) p[i] += rng.random() % 5;
    }
    if (type === 1) {
      p[0] += 4;
      p[1] *= (p[0] + p[0]) / 10;            // float, exactly as the .c (double p[])
      blobby = false;
    }
    knotParams = { type, p, blobby };
    rebuildKnotGeometry();
  }

  // Resample the CURRENT knot at the current resolution/thickness and rebuild the
  // swept-tube mesh. (Cheap; called on new_knot and on a live segments/thickness
  // change -- resolution/thickness are quality knobs, they don't change the shape.)
  function rebuildKnotGeometry() {
    const nseg = Math.max(10, Math.min(MAX_SEG, config.segments | 0));
    knotPoints = sampleKnot(knotParams, nseg);
    knotRadii = computeRadii(knotPoints, knotParams, nseg, clampThickness(config.thickness));
    buildGeometry(knotPoints, knotRadii, nseg);
    builtSegments = config.segments;
    builtThickness = config.thickness;
  }

  // ===================================================================
  //  swept-tube geometry (the envelope of tube.c's overlapping discs)
  // ===================================================================
  const cosT = new Float64Array(FACES), sinT = new Float64Array(FACES);
  for (let j = 0; j < FACES; j++) {
    const a = (j * Math.PI * 2) / FACES;
    cosT[j] = Math.cos(a);
    sinT[j] = Math.sin(a);
  }

  // ring vertex pos/normal scratch (per point: FACES vertices), preallocated to MAX.
  const RV = new Float32Array((MAX_SEG + 1) * FACES * 3);
  const RN = new Float32Array((MAX_SEG + 1) * FACES * 3);
  const Fn = new Float64Array((MAX_SEG + 1) * 3);   // per-ring frame normal (holonomy pass)
  // emitted (non-indexed) triangle pos/normal: MAX_SEG bands * FACES quads * 2 tris
  // * 3 verts, each vertex 3 floats. (The earlier sizing dropped the per-vertex *3
  // and silently truncated the tube's tail -- Float32Array ignores out-of-bounds
  // writes -- which read as a fake open end and left closed knots looking broken.)
  const MAX_VERTS = MAX_SEG * FACES * 2 * 3;
  const posArr = new Float32Array(MAX_VERTS * 3);
  const norArr = new Float32Array(MAX_VERTS * 3);
  let vCount = 0;

  function emitTri(ia, ib, ic) {
    // wind so the geometric normal agrees with the (radial) vertex normals -- so
    // FrontSide shows the OUTSIDE (the .c is glFrontFace(GL_CCW) + GL_CULL_FACE).
    const ax = RV[ia * 3], ay = RV[ia * 3 + 1], az = RV[ia * 3 + 2];
    const ex = RV[ib * 3] - ax, ey = RV[ib * 3 + 1] - ay, ez = RV[ib * 3 + 2] - az;
    const fx = RV[ic * 3] - ax, fy = RV[ic * 3 + 1] - ay, fz = RV[ic * 3 + 2] - az;
    const gx = ey * fz - ez * fy, gy = ez * fx - ex * fz, gz = ex * fy - ey * fx;
    const sx = RN[ia * 3] + RN[ib * 3] + RN[ic * 3];
    const sy = RN[ia * 3 + 1] + RN[ib * 3 + 1] + RN[ic * 3 + 1];
    const sz = RN[ia * 3 + 2] + RN[ib * 3 + 2] + RN[ic * 3 + 2];
    const order = gx * sx + gy * sy + gz * sz < 0 ? [ia, ic, ib] : [ia, ib, ic];
    for (const k of order) {
      posArr[vCount * 3] = RV[k * 3]; posArr[vCount * 3 + 1] = RV[k * 3 + 1]; posArr[vCount * 3 + 2] = RV[k * 3 + 2];
      norArr[vCount * 3] = RN[k * 3]; norArr[vCount * 3 + 1] = RN[k * 3 + 1]; norArr[vCount * 3 + 2] = RN[k * 3 + 2];
      vCount++;
    }
  }

  function buildGeometry(P, r, N) {
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const closed = dist(P[0], P[N]) < 1e-6;   // type-0 loops close exactly; type-1 don't
    // index helper: period-N wrap when closed (P[N]==P[0]), else clamp to [0,N].
    const ix = closed
      ? (k) => ((k % N) + N) % N
      : (k) => (k < 0 ? 0 : k > N ? N : k);

    // per-point unit tangents (central difference)
    const T = new Array(N + 1);
    for (let i = 0; i <= N; i++) {
      const a = P[ix(i + 1)], b = P[ix(i - 1)];
      let tx = a.x - b.x, ty = a.y - b.y, tz = a.z - b.z;
      const L = Math.hypot(tx, ty, tz) || 1;
      T[i] = { x: tx / L, y: ty / L, z: tz / L };
    }

    // PASS 1 -- rotation-minimizing (parallel-transport) frame: carry a normal along
    // the curve by projecting it perpendicular to each tangent; store it per ring.
    const pickUp = (t) => (Math.abs(t.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 });
    let cur;
    {
      const t = T[0], u = pickUp(t);
      const d = u.x * t.x + u.y * t.y + u.z * t.z;
      let px = u.x - d * t.x, py = u.y - d * t.y, pz = u.z - d * t.z;
      const L = Math.hypot(px, py, pz) || 1;
      cur = { x: px / L, y: py / L, z: pz / L };
    }
    for (let i = 0; i <= N; i++) {
      const t = T[i];
      let d = cur.x * t.x + cur.y * t.y + cur.z * t.z;
      let nx = cur.x - d * t.x, ny = cur.y - d * t.y, nz = cur.z - d * t.z;
      let L = Math.hypot(nx, ny, nz);
      if (L < 1e-6) {                          // tangent flipped ~180deg: re-seed
        const u = pickUp(t);
        d = u.x * t.x + u.y * t.y + u.z * t.z;
        nx = u.x - d * t.x; ny = u.y - d * t.y; nz = u.z - d * t.z;
        L = Math.hypot(nx, ny, nz) || 1;
      }
      nx /= L; ny /= L; nz /= L;
      Fn[i * 3] = nx; Fn[i * 3 + 1] = ny; Fn[i * 3 + 2] = nz;
      cur = { x: nx, y: ny, z: nz };
    }

    // Holonomy: on a CLOSED loop the transported frame at ring N is rotated about the
    // shared tangent (T[0]==T[N]) relative to ring 0 by some angle theta. Spreading a
    // -theta*(i/N) counter-rotation across the rings lands ring N exactly on ring 0, so
    // the closure is seamless -- otherwise the mis-clocked seam shows a dark notch (the
    // background/back-faces peeking through). This is what THREE.TubeGeometry does for
    // closed curves.
    let theta = 0;
    if (closed) {
      const t = T[0];
      const n0x = Fn[0], n0y = Fn[1], n0z = Fn[2];
      const nNx = Fn[N * 3], nNy = Fn[N * 3 + 1], nNz = Fn[N * 3 + 2];
      const cx = n0y * nNz - n0z * nNy, cy = n0z * nNx - n0x * nNz, cz = n0x * nNy - n0y * nNx;
      theta = Math.atan2(cx * t.x + cy * t.y + cz * t.z, n0x * nNx + n0y * nNy + n0z * nNz);
    }

    // PASS 2 -- emit ring vertices with the (holonomy-corrected) frame. For ring i,
    // rotate the stored normal by p = -theta*i/N about the tangent: n' = n cos p +
    // b sin p, b' = b cos p - n sin p, with b = T x n.
    vCount = 0;
    for (let i = 0; i <= N; i++) {
      const t = T[i];
      const nx = Fn[i * 3], ny = Fn[i * 3 + 1], nz = Fn[i * 3 + 2];
      const bx = t.y * nz - t.z * ny, by = t.z * nx - t.x * nz, bz = t.x * ny - t.y * nx;  // B = T x N
      let ex = nx, ey = ny, ez = nz, fx = bx, fy = by, fz = bz;
      if (theta !== 0) {
        const p = -theta * (i / N), cp = Math.cos(p), sp = Math.sin(p);
        ex = nx * cp + bx * sp; ey = ny * cp + by * sp; ez = nz * cp + bz * sp;   // n'
        fx = bx * cp - nx * sp; fy = by * cp - ny * sp; fz = bz * cp - nz * sp;   // b'
      }
      const ri = r[i];
      const base = i * FACES * 3;
      for (let j = 0; j < FACES; j++) {
        const c = cosT[j], s = sinT[j];
        const rx = c * ex + s * fx, ry = c * ey + s * fy, rz = c * ez + s * fz;   // radial (unit) normal
        const o = base + j * 3;
        RV[o] = P[i].x + ri * rx; RV[o + 1] = P[i].y + ri * ry; RV[o + 2] = P[i].z + ri * rz;
        RN[o] = rx; RN[o + 1] = ry; RN[o + 2] = rz;
      }
    }

    // stitch consecutive rings with quads (bands 0..N-1; no N->0 band -- a closed
    // knot's ring N already sits on ring 0, an open knot stays open, as in the .c).
    for (let i = 0; i < N; i++) {
      const r0 = i * FACES, r1 = (i + 1) * FACES;
      for (let j = 0; j < FACES; j++) {
        const j2 = (j + 1) % FACES;
        const a = r0 + j, b = r0 + j2, c = r1 + j2, d = r1 + j;
        emitTri(a, b, c);
        emitTri(a, c, d);
      }
    }

    // No end caps: glknots.c passes caps_p = wire to tube(), so in solid mode the
    // tube is uncapped. type-1 knots that don't close therefore show hollow open
    // ends (their lit rims) -- faithful to the original, which never caps them.

    posAttr.needsUpdate = true;
    norAttr.needsUpdate = true;
    geom.setDrawRange(0, vCount);
    geom.computeBoundingSphere();
  }

  // ===================================================================
  //  three.js scene
  // ===================================================================
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  // preserveDrawingBuffer: WebGL clears the drawing buffer after every composite by
  // default, so a no-clear frame would NOT accumulate (unlike native GL's untouched
  // back buffer). Preserving it lets the 1/15 clear_p=false knots actually smear; in
  // the normal (cleared) case we clear each frame anyway, so it costs only a little.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 1);
  renderer.autoClear = false;     // we control clearing (clear_p smear)

  const scene = new THREE.Scene();
  scene.background = null;        // null so a no-clear frame can smear (not painted over)

  // gluPerspective(30, aspect, 1, 100) + gluLookAt(0,0,30, 0,0,0, 0,1,0).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // Directional white light from (1,1,1) (GL pos {1,1,1,0}, w=0 => parallel),
  // intensity PI (cancels three's 1/PI Lambert). The .c sets LIGHT0 ambient 0 but
  // leaves GL's default global ambient 0.2; the material is GL_AMBIENT_AND_DIFFUSE
  // = the surface color, so the ambient floor is 0.2 * color.
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(1, 1, 1);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.2 * Math.PI));

  // Material: GL material specular WHITE * the light's CYAN specular (0,1,1) = a
  // cyan highlight; in three (one light color) fold the cyan onto material.specular
  // and keep light white. Divide by PI so the PI light intensity doesn't blow the
  // highlight into a white disc (the superquadrics.js convention). shininess 128.
  const material = new THREE.MeshPhongMaterial({
    color: 0xffffff,              // set per-frame to colors[ccolor]
    specular: new THREE.Color().setRGB(0, 1 / Math.PI, 1 / Math.PI, THREE.SRGBColorSpace),
    shininess: 128,
    side: THREE.FrontSide,
  });

  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(posArr, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
  const norAttr = new THREE.BufferAttribute(norArr, 3); norAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('position', posAttr);
  geom.setAttribute('normal', norAttr);

  // modelview nesting (outer->inner), mirroring reshape + draw_knot:
  //   outer : Scale(portraitFit)         (reshape's glScalef(s,s,s))
  //   trans : Translate(wander)
  //   rotG  : Rotate(spin)               (glRotatef x,y,z * 360)
  //   scaleG: Scale(0.25 * growShrink)   (glScalef(0.25) * mode 1/2 factor)
  const outer = new THREE.Group();
  const trans = new THREE.Group();
  const rotG = new THREE.Group();
  const scaleG = new THREE.Group();
  const mesh = new THREE.Mesh(geom, material);
  scaleG.add(mesh); rotG.add(scaleG); trans.add(rotG); outer.add(trans);
  scene.add(outer);

  // ---- rotator (init_knot order: make_rotator BEFORE new_knot) ----
  let rot, builtSpin;
  let prevR, curR, prevP, curP, rotAccum = 0;
  function rebuildRotator() {
    const sp = config.rotation;
    const sx = /[xX]/.test(sp), sy = /[yY]/.test(sp), sz = /[zZ]/.test(sp);
    rot = makeRotator(
      {
        spinX: sx ? 2 : 0, spinY: sy ? 2 : 0, spinZ: sz ? 2 : 0,
        spinAccel: 0.2,
        wanderSpeed: 0.05,         // always 0.05 (RNG-faithful); honored live via config.wander
        randomize: sx && sy && sz, // make_rotator(... , (spinx && spiny && spinz))
      },
      rng,
    );
    builtSpin = sp;
    const r0 = rot.getRotation(false), p0 = rot.getPosition(false);
    prevR = { ...r0 }; curR = { ...r0 }; prevP = { ...p0 }; curP = { ...p0 }; rotAccum = 0;
  }
  rebuildRotator();   // init_knot: make_rotator first ...
  newKnot();          // ... then new_knot (clear_p, colormap, knot)

  function tickRotator() {
    prevR = curR; curR = rot.getRotation(true);
    prevP = curP; curP = rot.getPosition(true);
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpAngle = (a, b, t) => {   // shortest path on the [0,1) rotation circle
    let d = b - a;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    return a + d * t;
  };

  // ---- regen state machine ----
  let mode = 0;            // 0 normal, 1 out (shrink), 2 in (grow)
  let modeTick = 0;        // frames remaining in mode 1/2 (counts down)
  let lastTransitionSec = 0;   // wall-clock seconds at the last mode-1 entry

  // ---- sizing (reshape_knot: gluPerspective + the portrait fit scale) ----
  let portraitFit = 1;
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    portraitFit = w < h ? w / h : 1;   // reshape's glScalef(s,s,s)
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop ----
  let raf = 0, last = 0, paused = false, ms = 16, firstRender = true;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; lastTransitionSec = now / 1000; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    // live structural changes
    if (config.rotation !== builtSpin) rebuildRotator();
    if (config.segments !== builtSegments || config.thickness !== builtThickness) rebuildKnotGeometry();

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;
    const nowSec = now / 1000;

    // color cycle (ccolor++ per frame in the .c)
    ccolor = (ccolor + frames) % NCOLORS;

    // mode machine: normal for DURATION s, then shrink (10/speed frames), new
    // knot, grow (10/speed frames), back to normal.
    const T = 10 / Math.max(0.0001, config.speed);
    if (mode === 0) {
      if (nowSec - lastTransitionSec >= DURATION) { mode = 1; modeTick = T; lastTransitionSec = nowSec; }
    } else if (mode === 1) {
      modeTick -= frames;
      if (modeTick <= 0) { newKnot(); modeTick = T; mode = 2; }
    } else {
      modeTick -= frames;
      if (modeTick <= 0) mode = 0;
    }
    let s = 1;
    if (mode === 1) s = Math.max(0, Math.min(1, modeTick / T));                    // 1 -> 0
    else if (mode === 2) s = Math.max(0, Math.min(1, (T - modeTick + 1) / T));     // ~0 -> 1

    // rotator: tick at the original cadence, interpolate for smoothness
    rotAccum += frames;
    let ticks = 0;
    while (rotAccum >= 1 && ticks < MAX_TICKS) { tickRotator(); rotAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) rotAccum = 0;
    const a = rotAccum;

    // transforms (draw_knot modelview)
    outer.scale.setScalar(portraitFit);
    if (config.wander) {
      trans.position.set(
        (lerp(prevP.x, curP.x, a) - 0.5) * 8,
        (lerp(prevP.y, curP.y, a) - 0.5) * 8,
        (lerp(prevP.z, curP.z, a) - 0.5) * 15,
      );
    } else trans.position.set(0, 0, 0);
    rotG.rotation.set(
      lerpAngle(prevR.x, curR.x, a) * 2 * Math.PI,   // glRotatef(x*360) about X
      lerpAngle(prevR.y, curR.y, a) * 2 * Math.PI,   // then Y
      lerpAngle(prevR.z, curR.z, a) * 2 * Math.PI,   // then Z  == three Euler 'XYZ'
      'XYZ',
    );
    scaleG.scale.setScalar(0.25 * s);

    // single cycling color for the whole knot
    material.color.copy(colors[Math.floor(ccolor) % NCOLORS]);
    material.wireframe = config.wire;

    // clear_p: clear color+depth each frame, EXCEPT the 1/15 "smear" knots (which
    // leave the previous frames so the spinning/wandering tube trails). Always
    // clear the very first frame so we start from black.
    if (clearP || firstRender) { renderer.clear(); firstRender = false; }
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
    reinit() { newKnot(); },   // fresh random knot (host 're-seed')
    config,
    params,
  };
}

export default { title, info, start };
