// gears.js -- "Gears" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's gears (Brian Paul 1996; rewritten by Jamie
// Zawinski, Nov 2007), hacks/glx/gears.c + the involute-tooth geometry library
// hacks/glx/involute.c. A train of 3-7 interlocking gears with proper involute
// teeth meshes and spins; 1/8 of the time it's an epicyclic (planetary) cluster
// of five gears inside a toothed ring, held by a three-armed spider armature. The
// whole assembly tumbles and wanders through space.
//
// Self-contained on purpose (per the geometry-track directive): its own overlay
// canvas + renderer + render loop, no shared geometry harness. It follows the
// host's mountable-module contract exactly as cubicgrid.js / dangerball.js do.
// Motion (rotator.js) and RNG (yarandom.js) are the shared faithful util ports;
// everything gear-specific (gen, involute geometry, tube/cone, armature) is
// transcribed inline from the .c -- NO three.js primitives stand in for it.
//
// FAITHFUL TO THE .c -- the rule here is "do not deviate from the algorithm":
//   * new_gear: tooth size/count/radius, the four interior shapes (ring; +inset
//     disc; +raised lip; +third disc/spokes), nubs, the pixel-size -> mesh-detail
//     bucket (SMALL/MEDIUM/LARGE/HUGE), all RNG draws in source order.
//   * place_gear: gearing ratio, the half-tooth offset for odd tooth counts, the
//     exact th adjustment that lines a child's teeth up with its parent, and the
//     no-overlap collision test -- so the teeth visibly MESH.
//   * planetary_gears + armature (ctube via a faithful unit_tube/unit_cone port,
//     and arm()).
//   * involute.c: gear_teeth_geometry's r[]/th[] tooth profile + per-size point
//     sets, tooth_normals' AREA-WEIGHTED (un-normalized, then averaged) vertex
//     normals, draw_gear_teeth (outer/inner rim walls + top/bottom annulus),
//     draw_gear_interior (rings, plates, spokes), draw_gear_nubs.
//   * draw_gears modelview: position (rotator) -> rotation (with the fixed
//     x-=0.14, y-=0.06 tilt that gives the classic receding-train view) -> bbox
//     center+fit -> per-gear translate + Rz(th).
//   * lighting: one white directional light from (1,1,1), ambient 0 (so unlit
//     side walls go dark, exactly as in the original), material specular = the
//     light's cyan {0,1,1}, shininess 128.
//
// COLOR MANAGEMENT mirrors dangerball.js: each gear's two random pastel colors
// (color = 0.5+frand(0.5); color2 = color*0.85) are treated as sRGB and converted
// to linear for the per-vertex diffuse, with diffuse carried by VERTEX COLORS so a
// single material reproduces the .c's per-region glMaterialfv(color vs color2)
// swaps. (GL fixed-function vs three's lit pipeline can't match bit-for-bit; this
// is the same accepted mapping the sibling geometry hacks use.)
//
// CULLING: geometry is emitted with faithful winding (GL vertex order, with the
// per-block glFrontFace tracked and the triangle reversed when it was GL_CW), so
// THREE.FrontSide would reproduce GL_CULL_FACE exactly. We default the material to
// DoubleSide because every gear/armature piece is a CLOSED opaque solid -- for
// which DoubleSide is pixel-identical to back-face culling -- and it removes all
// winding risk. Flip SIDE to THREE.FrontSide for the culled path.
//
// PACING (same model as dangerball): render every rAF; motion is continuous.
// `delay` (us, from the .xml) sets the original's effective frame rate as
// effFps = 1e6/(delay+OVERHEAD); each render advances `frames = dt*effFps`
// original-frames. Gear spin (th += ratio*5*speed per frame) advances
// continuously; the rotator's discrete random-walk is ticked once per
// original-frame and interpolated between ticks.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';

export const title = 'gears';

export const info = {
  author: 'Jamie Zawinski',
  year: 2007,
  description: 'Interlocking gears.',
};

// involute.c size enum (controls mesh complexity / tooth point set).
const SMALL = 0, MEDIUM = 1, LARGE = 2, HUGE = 3;

// gear_teeth_geometry PUSH(OPR,IPR,PTH) point sets per size: [outerRadiusIdx,
// innerRadiusIdx(always 8), thetaIdx]. Transcribed verbatim from the switch.
const TOOTH_PROFILE = {
  [SMALL]: [[6, 8, 0], [0, 8, 8]],
  [MEDIUM]: [[6, 8, 0], [0, 8, 6], [0, 8, 10], [6, 8, 16]],
  [LARGE]: [
    [6, 8, 0], [4, 8, 2], [2, 8, 4], [0, 8, 6], [0, 8, 10],
    [2, 8, 12], [4, 8, 14], [6, 8, 16], [6, 8, 18],
  ],
  [HUGE]: [
    [6, 8, 0], [5, 8, 1], [4, 8, 2], [3, 8, 3], [2, 8, 4], [1, 8, 5],
    [0, 8, 6], [0, 8, 8], [0, 8, 10], [1, 8, 11], [2, 8, 12], [3, 8, 13],
    [4, 8, 14], [5, 8, 15], [6, 8, 16], [6, 8, 17], [6, 8, 18], [6, 8, 19],
  ],
};

export function start(hostCanvas, opts = {}) {
  const DEG = Math.PI / 180;
  const OVERHEAD = 37500;     // us; calibrates xml default delay 30000 -> ~15fps (see frame-rate-calibration)
  const SIDE = THREE.DoubleSide;   // closed solids: pixel-identical to back-face culling (see header)

  // Live config -- keys/ranges/defaults/labels transcribed 1:1 from
  // hacks/config/gears.xml + the gears.c DEFAULTS. The host renders the box from
  // `params` and mutates `config` in place.
  const config = {
    delay: 30000,   // us, frame rate / overall speed (xml default; invert slider)
    speed: 1.0,     // gear spin-rate multiplier (xml --speed)
    count: 0,       // number of gears, 0 => random 3-7 (xml --count)
    wander: true,   // drift through space (do_wander)
    spin: true,     // tumble (do_spin)
    wire: false,    // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' µs', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.01, max: 5.0, step: 0.01, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'count', label: 'Gear count', type: 'range', min: 0, max: 20, step: 1, default: 0, lowLabel: '0', highLabel: '20', live: false },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'spin', label: 'Spin', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const seed = opts.seed || 0;            // 0 => time-seeded (random per run)
  const rng = makeYaRandom(seed);

  // RNG helpers, matching the .c macros. random() == ya_random (uint32); the .c
  // uses `random() % n` and frand() directly, so we do too (don't substitute the
  // bias-free NRAND -- faithful to source).
  const frand = (f = 1) => rng.frand(f);
  const BELLRAND = (n) => (frand(n) + frand(n) + frand(n)) / 3;   // ~triangular bell
  const RND = (n) => rng.random() % n;

  // sRGB pastel -> linear [r,g,b] for vertex-color diffuse (see header).
  const _c = new THREE.Color();
  const toLin = (r, g, b) => { _c.setRGB(r, g, b, THREE.SRGBColorSpace); return [_c.r, _c.g, _c.b]; };

  // ===================================================================
  //  Vector / normal helpers (normals.c)
  // ===================================================================
  // calc_normal: UN-normalized cross (p1-p) x (p2-p). The .c does not normalize
  // here; GL_NORMALIZE does it at draw, and tooth_normals AVERAGES these
  // un-normalized (area-weighted) face normals -- so we keep them un-normalized
  // and let three normalize the final per-vertex normal in-shader.
  function calcNormal(p, p1, p2) {
    const ax = p1[0] - p[0], ay = p1[1] - p[1], az = p1[2] - p[2];
    const bx = p2[0] - p[0], by = p2[1] - p[1], bz = p2[2] - p[2];
    return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
  }
  const neg3 = (n) => [-n[0], -n[1], -n[2]];

  // ===================================================================
  //  Geometry builder -- accumulates positions/normals/colors, converts
  //  GL primitives to CCW-front triangles. An optional current matrix
  //  (curMat) bakes sub-object transforms (nubs, armature) like the GL
  //  modelview stack would. setMatrix(null) => identity.
  // ===================================================================
  function Builder() {
    const pos = [], nor = [], col = [];
    let curMat = null, curNMat = null;
    const _v = new THREE.Vector3(), _n = new THREE.Vector3();

    function vert(p, n, c) {
      if (curMat) {
        _v.set(p[0], p[1], p[2]).applyMatrix4(curMat);
        _n.set(n[0], n[1], n[2]).applyMatrix3(curNMat);
        pos.push(_v.x, _v.y, _v.z); nor.push(_n.x, _n.y, _n.z);
      } else {
        pos.push(p[0], p[1], p[2]); nor.push(n[0], n[1], n[2]);
      }
      col.push(c[0], c[1], c[2]);
    }
    // tri in GL vertex order; frontCCW => keep, else reverse (reproduces glFrontFace).
    function tri(p0, p1, p2, n0, n1, n2, c, frontCCW) {
      if (frontCCW) { vert(p0, n0, c); vert(p1, n1, c); vert(p2, n2, c); }
      else { vert(p0, n0, c); vert(p2, n2, c); vert(p1, n1, c); }
    }
    // GL quad p0,p1,p2,p3 (front-CCW) -> tris (p0,p1,p2)+(p0,p2,p3).
    function quad(p0, p1, p2, p3, n0, n1, n2, n3, c, frontCCW) {
      tri(p0, p1, p2, n0, n1, n2, c, frontCCW);
      tri(p0, p2, p3, n0, n2, n3, c, frontCCW);
    }
    return {
      tri, quad,
      setMatrix(m) {
        if (!m) { curMat = null; curNMat = null; return; }
        curMat = m; curNMat = new THREE.Matrix3().getNormalMatrix(m);
      },
      count() { return pos.length / 3; },
      geometry() {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        g.computeBoundingSphere();
        return g;
      },
    };
  }

  // GL-style modelview stack for sub-object transforms (nubs, armature).
  function MStack() {
    const stk = [new THREE.Matrix4()];
    const tmp = new THREE.Matrix4();
    const top = () => stk[stk.length - 1];
    const axis = new THREE.Vector3();
    return {
      push() { stk.push(top().clone()); },
      pop() { stk.pop(); },
      translate(x, y, z) { top().multiply(tmp.makeTranslation(x, y, z)); },
      rotate(deg, x, y, z) { top().multiply(tmp.makeRotationAxis(axis.set(x, y, z).normalize(), deg * DEG)); },
      scale(x, y, z) { top().multiply(tmp.makeScale(x, y, z)); },
      matrix() { return top(); },
    };
  }

  // ===================================================================
  //  involute.c primitives
  // ===================================================================

  // draw_ring: uncapped tube radius r from `top` to `bottom`, faces in or out.
  function drawRing(B, segments, r, top, bottom, slope, inP, col) {
    if (top === bottom) return;
    const width = (Math.PI * 2) / segments;
    const s1 = 1 + ((bottom - top) * slope / 2);
    const s2 = 1 - ((bottom - top) * slope / 2);
    const frontCCW = inP;   // glFrontFace(inP ? CCW : CW)
    for (let i = 0; i < segments; i++) {
      const th = i * width, th2 = (i + 1) * width;
      const c1 = Math.cos(th), n1s = Math.sin(th), c2 = Math.cos(th2), n2s = Math.sin(th2);
      const na = inP ? [-c1, -n1s, 0] : [c1, n1s, 0];
      const nb = inP ? [-c2, -n2s, 0] : [c2, n2s, 0];
      const vt1 = [s1 * c1 * r, s1 * n1s * r, top], vb1 = [s2 * c1 * r, s2 * n1s * r, bottom];
      const vt2 = [s1 * c2 * r, s1 * n2s * r, top], vb2 = [s2 * c2 * r, s2 * n2s * r, bottom];
      // GL_QUAD_STRIP [vt1,vb1,vt2,vb2] -> quad (vt1,vb1,vb2,vt2)
      B.quad(vt1, vb1, vb2, vt2, na, na, nb, nb, col, frontCCW);
    }
  }

  // draw_disc: donut between ra..rb at z, facing up or down (ra==0 => filled).
  function drawDisc(B, segments, ra, rb, z, upP, col) {
    const width = (Math.PI * 2) / segments;
    const n = [0, 0, upP ? -1 : 1];
    if (ra === 0) {
      const frontCCW = !upP;   // glFrontFace(upP ? CW : CCW)
      const center = [0, 0, z];
      for (let i = 0; i < segments; i++) {
        const th = i * width, th2 = (i + 1) * width;
        const p1 = [Math.cos(th) * rb, Math.sin(th) * rb, z];
        const p2 = [Math.cos(th2) * rb, Math.sin(th2) * rb, z];
        B.tri(center, p1, p2, n, n, n, col, frontCCW);   // GL_TRIANGLE_FAN
      }
    } else {
      const frontCCW = upP;    // glFrontFace(upP ? CCW : CW)
      for (let i = 0; i < segments; i++) {
        const th = i * width, th2 = (i + 1) * width;
        const a1 = [Math.cos(th) * ra, Math.sin(th) * ra, z], b1 = [Math.cos(th) * rb, Math.sin(th) * rb, z];
        const a2 = [Math.cos(th2) * ra, Math.sin(th2) * ra, z], b2 = [Math.cos(th2) * rb, Math.sin(th2) * rb, z];
        // GL_QUAD_STRIP [a1,b1,a2,b2] -> quad (a1,b1,b2,a2)
        B.quad(a1, b1, b2, a2, n, n, n, n, col, frontCCW);
      }
    }
  }

  // draw_spokes: N thick radial bars between ra..rb, top+bottom+side faces.
  function drawSpokes(B, n, thickness, segments, ra, rb, z1, z2, slope, col) {
    const s1 = 1 + ((z2 - z1) * slope / 2);
    const s2 = 1 - ((z2 - z1) * slope / 2);
    segments *= 3;
    let segments2 = 0;
    while (segments2 < segments) segments2 += n;     // smallest multiple of n >= segments
    let insegs = Math.trunc(((segments2 / n) + 0.5) / thickness);
    let outsegs = (segments2 / n) - insegs;
    if (insegs <= 0) insegs = 1;
    if (outsegs <= 0) outsegs = 1;
    segments2 = (insegs + outsegs) * n;
    const width = (Math.PI * 2) / segments2;
    const nTop = [0, 0, -1], nBot = [0, 0, 1];
    let tick = 0, state = 0;
    for (let i = 0; i < segments2; i++, tick++) {
      const th1 = i * width, th2 = th1 + width;
      const cth1 = Math.cos(th1), sth1 = Math.sin(th1);
      const cth2 = Math.cos(th2), sth2 = Math.sin(th2);
      let changed = (i === 0) ? 1 : 0;
      if (state === 0 && tick === insegs) { tick = 0; state = 1; changed = 1; }
      else if (state === 1 && tick === outsegs) { tick = 0; state = 0; changed = 1; }

      if (state === 1 || (state === 0 && changed)) {
        // top (glFrontFace CCW)
        B.quad(
          [s1 * cth1 * ra, s1 * sth1 * ra, z1], [s1 * cth1 * rb, s1 * sth1 * rb, z1],
          [s1 * cth2 * rb, s1 * sth2 * rb, z1], [s1 * cth2 * ra, s1 * sth2 * ra, z1],
          nTop, nTop, nTop, nTop, col, true,
        );
        // bottom (glFrontFace CW)
        B.quad(
          [s2 * cth1 * ra, s2 * sth1 * ra, z2], [s2 * cth1 * rb, s2 * sth1 * rb, z2],
          [s2 * cth2 * rb, s2 * sth2 * rb, z2], [s2 * cth2 * ra, s2 * sth2 * ra, z2],
          nBot, nBot, nBot, nBot, col, false,
        );
      }
      if (state === 1 && changed) {   // left (glFrontFace CW)
        const p0 = [s1 * cth1 * ra, s1 * sth1 * ra, z1], p1 = [s1 * cth1 * rb, s1 * sth1 * rb, z1];
        const p2 = [s2 * cth1 * rb, s2 * sth1 * rb, z2], p3 = [s2 * cth1 * ra, s2 * sth1 * ra, z2];
        const nm = calcNormal(p1, p0, p2);   // do_normal(rb@z1, ra@z1, rb@z2)
        B.quad(p0, p1, p2, p3, nm, nm, nm, nm, col, false);
      }
      if (state === 0 && changed) {   // right (glFrontFace CCW)
        const p0 = [s1 * cth2 * ra, s1 * sth2 * ra, z1], p1 = [s1 * cth2 * rb, s1 * sth2 * rb, z1];
        const p2 = [s2 * cth2 * rb, s2 * sth2 * rb, z2], p3 = [s2 * cth2 * ra, s2 * sth2 * ra, z2];
        const nm = calcNormal(p0, p1, p2);   // do_normal(ra@z1, rb@z1, rb@z2)
        B.quad(p0, p1, p2, p3, nm, nm, nm, nm, col, true);
      }
    }
  }

  // involute_biggest_ring: which inside ring (0 or 1) is widest -> {pos,size,height,which}.
  function involuteBiggestRing(g) {
    const r0 = g.r - g.tooth_h / 2;
    const r1 = g.inner_r, r2 = g.inner_r2, r3 = g.inner_r3;
    const w1 = (r1 ? r0 - r1 : r0);
    let w2 = (r2 ? r1 - r2 : 0);
    const w3 = (r3 ? r2 - r3 : 0);
    const h1 = g.thickness, h2 = g.thickness2, h3 = g.thickness3;
    if (g.spokes) w2 = 0;
    if (w1 > w2 && w1 > w3) return { which: 0, pos: (r0 + r1) / 2, size: w1, height: h1 };
    if (w2 > w1 && w2 > w3) return { which: 1, pos: (r1 + r2) / 2, size: w2, height: h2 };
    return { which: 1, pos: (r2 + r3) / 2, size: w3, height: h3 };
  }

  // gear_teeth_geometry: the orim (teeth) and irim (hole) point rings + their
  // area-weighted smooth vertex normals. The heavy lifting.
  function gearTeethGeometry(g) {
    const width = (Math.PI * 2) / g.nteeth;
    const rh = g.tooth_h, tw = width, R = g.r;

    const r = new Array(9);
    r[0] = R + rh * 0.50; r[1] = R + rh * 0.40; r[2] = R + rh * 0.25; r[3] = R + rh * 0.05;
    r[4] = R - (r[2] - R); r[5] = R - (r[1] - R); r[6] = R - (r[0] - R); r[7] = r[6]; r[8] = g.inner_r;

    const th = new Array(21);
    th[0] = -tw * (g.size === SMALL ? 0.5 : g.size === MEDIUM ? 0.41 : 0.45);
    th[1] = -tw * 0.375; th[2] = -tw * 0.300; th[3] = -tw * 0.230;
    th[4] = -tw * (g.nteeth >= 5 ? 0.16 : 0.12); th[5] = -tw * 0.100;
    th[6] = -tw * (g.size === MEDIUM ? 0.1 : 0.04); th[7] = -tw * 0.020; th[8] = 0;
    th[9] = -th[7]; th[10] = -th[6]; th[11] = -th[5]; th[12] = -th[4]; th[13] = -th[3];
    th[14] = -th[2]; th[15] = -th[1]; th[16] = -th[0];
    th[17] = width * 0.47; th[18] = width * 0.50; th[19] = width * 0.53; th[20] = th[0] + width;

    if (g.inverted_p) {   // teeth on the inside
      for (let i = 0; i < 21; i++) th[i] = -th[i];
      for (let i = 0; i < 9; i++) r[i] = R - (r[i] - R);
    }

    const orim = [], irim = [];
    const profile = TOOTH_PROFILE[g.size];
    for (let i = 0; i < g.nteeth; i++) {
      const TH = (i * width) + (width / 4);
      const start = orim.length;
      for (const [OPR, IPR, PTH] of profile) {
        const a = TH + th[PTH];
        orim.push([Math.cos(a) * r[OPR], Math.sin(a) * r[OPR]]);
        irim.push([Math.cos(a) * r[IPR], Math.sin(a) * r[IPR]]);
      }
      if (g.inverted_p) {   // reverse this tooth's point order on both rims
        reverseRange(orim, start, orim.length);
        reverseRange(irim, start, irim.length);
      }
    }

    let opn = toothNormals(orim, g.tooth_slope);
    let ipn = toothNormals(irim, 0);
    if (g.inverted_p) { opn = opn.map(neg3); ipn = ipn.map(neg3); }   // flip normals
    return { orim, irim, opn, ipn };
  }

  function reverseRange(arr, start, end) {
    for (let j = 0; j < (end - start) / 2; j++) {
      const t = arr[end - j - 1]; arr[end - j - 1] = arr[start + j]; arr[start + j] = t;
    }
  }

  // tooth_normals: face normals from each edge (+z slope), then per-vertex by
  // averaging adjacent faces (un-normalized => area weighted, faithful to .c).
  function toothNormals(pts, slope) {
    const n = pts.length;
    const fn = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = i, b = (i === n - 1 ? 0 : i + 1);
      const p1 = [pts[a][0], pts[a][1], 0];
      const p2 = [pts[b][0], pts[b][1], 0];
      const p3 = [p1[0] - p1[0] * slope, p1[1] - p1[1] * slope, 1];   // p3=p1; xy*=(1-slope); z++
      fn[i] = calcNormal(p1, p2, p3);
    }
    const pn = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i === 0 ? n - 1 : i - 1), b = i;
      pn[i] = [(fn[a][0] + fn[b][0]) / 2, (fn[a][1] + fn[b][1]) / 2, (fn[a][2] + fn[b][2]) / 2];
    }
    return pn;
  }

  // draw_gear_teeth: outer rim (teeth) wall, inner rim (hole) wall, top+bottom annulus.
  function drawGearTeeth(B, g) {
    const z1 = -g.thickness / 2, z2 = g.thickness / 2;
    const s1 = 1 + (g.thickness * g.tooth_slope / 2);
    const s2 = 1 - (g.thickness * g.tooth_slope / 2);
    const { orim, irim, opn, ipn } = gearTeethGeometry(g);
    const col = g.colLin;
    const N = orim.length;

    // Outer rim (the teeth): glFrontFace(inverted ? CCW : CW).
    const frontOuter = g.inverted_p;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const ni = opn[i], nj = opn[j];
      const vt_i = [s1 * orim[i][0], s1 * orim[i][1], z1], vb_i = [s2 * orim[i][0], s2 * orim[i][1], z2];
      const vt_j = [s1 * orim[j][0], s1 * orim[j][1], z1], vb_j = [s2 * orim[j][0], s2 * orim[j][1], z2];
      B.quad(vt_i, vb_i, vb_j, vt_j, ni, ni, nj, nj, col, frontOuter);
    }

    // Inner rim (the hole): glFrontFace(inverted ? CW : CCW); normals negated.
    const frontInner = !g.inverted_p;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const ni = neg3(ipn[i]), nj = neg3(ipn[j]);
      const vt_i = [s1 * irim[i][0], s1 * irim[i][1], z1], vb_i = [s2 * irim[i][0], s2 * irim[i][1], z2];
      const vt_j = [s1 * irim[j][0], s1 * irim[j][1], z1], vb_j = [s2 * irim[j][0], s2 * irim[j][1], z2];
      B.quad(vt_i, vb_i, vb_j, vt_j, ni, ni, nj, nj, col, frontInner);
    }

    // Side faces (the flat annulus at z1 and z2).
    for (const isTop of [true, false]) {
      const z = isTop ? z1 : z2;
      const s = isTop ? s1 : s2;
      const n = [0, 0, z];   // sign(z) gives -Z (bottom) / +Z (top)
      const frontCCW = (isTop !== g.inverted_p);   // ((z==z1) ^ inverted) ? CCW : CW
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const o_i = [s * orim[i][0], s * orim[i][1], z], r_i = [s * irim[i][0], s * irim[i][1], z];
        const o_j = [s * orim[j][0], s * orim[j][1], z], r_j = [s * irim[j][0], s * irim[j][1], z];
        // GL_QUAD_STRIP [o_i,r_i,o_j,r_j] -> quad (o_i,r_i,r_j,o_j)
        B.quad(o_i, r_i, r_j, o_j, n, n, n, n, col, frontCCW);
      }
    }
  }

  // draw_gear_interior: the inset discs / rings / spokes. (coax_p is never set in
  // gears.c, so the axle-tube block is unreachable and omitted.)
  function drawGearInterior(B, g) {
    let steps = g.nteeth * 2;
    if (steps < 10) steps = 10;
    if (g.size < LARGE) steps = Math.floor(steps / 2);
    if (g.size < LARGE && steps > 16) steps = 16;

    if (g.inner_r2) {
      const ra = g.inner_r * 1.04, rb = g.inner_r2;
      const za = -g.thickness2 / 2, zb = g.thickness2 / 2;
      const s1 = 1 + (g.thickness2 * g.tooth_slope / 2);
      const s2 = 1 - (g.thickness2 * g.tooth_slope / 2);
      const col2 = g.col2Lin;
      if (!g.inner_r3) drawRing(B, steps, rb, za, zb, g.tooth_slope, true, col2);   // ring facing in
      if (g.spokes) drawSpokes(B, g.spokes, g.spoke_thickness, steps, ra, rb, za, zb, g.tooth_slope, col2);
      else {
        drawDisc(B, steps, s1 * ra, s1 * rb, za, true, col2);    // top plate
        drawDisc(B, steps, s2 * ra, s2 * rb, zb, false, col2);   // bottom plate
      }
    }

    if (g.inner_r3) {
      const ra = g.inner_r2, rb = g.inner_r3;
      const za = -g.thickness3 / 2, zb = g.thickness3 / 2;
      const s1 = 1 + (g.thickness3 * g.tooth_slope / 2);
      const s2 = 1 - (g.thickness3 * g.tooth_slope / 2);
      const col = g.colLin;
      drawRing(B, steps, ra, za, zb, g.tooth_slope, false, col);   // ring facing out
      drawRing(B, steps, rb, za, zb, g.tooth_slope, true, col);    // ring facing in
      drawDisc(B, steps, s1 * ra, s1 * rb, za, true, col);
      drawDisc(B, steps, s2 * ra, s2 * rb, zb, false, col);
    }
  }

  // draw_gear_nubs: little embedded cylinders on the biggest ring.
  function drawGearNubs(B, g, stack) {
    if (!g.nubs) return;
    const steps = (g.size < LARGE ? 5 : 20);
    const br = involuteBiggestRing(g);
    let r = br.pos;
    const size = br.size / 5, height = br.height * 0.7;
    const cc = (br.which === 1 ? g.colLin : g.col2Lin);
    if (g.inverted_p) r = g.r + size + g.tooth_h;
    const width = (Math.PI * 2) / g.nubs;
    const off = Math.PI / (g.nteeth * 2);   // align first nub with a tooth
    for (let i = 0; i < g.nubs; i++) {
      const th = (i * width) + off;
      stack.push();
      stack.rotate(th * 180 / Math.PI, 0, 0, 1);
      stack.translate(r, 0, 0);
      let sz = size, ht = height;
      if (g.inverted_p) {   // nubs go on the outside rim, pointing radially out
        sz = g.thickness / 3;
        ht = (g.r - g.inner_r) / 2;
        stack.translate(ht, 0, 0);
        stack.rotate(90, 0, 1, 0);
      }
      B.setMatrix(stack.matrix());
      drawDisc(B, steps, 0, sz, -ht, true, cc);
      drawDisc(B, steps, 0, sz, ht, false, cc);
      drawRing(B, steps, sz, -ht, ht, 0, false, cc);
      B.setMatrix(null);
      stack.pop();
    }
  }

  // draw_involute_gear -> a baked BufferGeometry for one gear (unrotated, at 0,0,0).
  function buildGearGeometry(g) {
    const B = Builder();
    const stack = MStack();
    drawGearTeeth(B, g);
    drawGearInterior(B, g);
    drawGearNubs(B, g, stack);
    g.polygons = B.count() / 3;
    return B.geometry();
  }

  // ===================================================================
  //  tube.c -- unit_tube / unit_cone + the tube() placement transform,
  //  used only by the planetary armature.
  // ===================================================================
  function stripToTris(B, verts, norms, col) {
    for (let k = 0; k + 2 < verts.length; k++) {
      if (k % 2 === 0) B.tri(verts[k], verts[k + 1], verts[k + 2], norms[k], norms[k + 1], norms[k + 2], col, true);
      else B.tri(verts[k + 1], verts[k], verts[k + 2], norms[k + 1], norms[k], norms[k + 2], col, true);
    }
  }
  function fanToTris(B, verts, norms, col) {
    for (let k = 1; k + 1 < verts.length; k++)
      B.tri(verts[0], verts[k], verts[k + 1], norms[0], norms[k], norms[k + 1], col, true);
  }

  // unit_tube(faces, smooth=true, caps=true): Y-axis unit cylinder y 0..1, radius 1.
  function unitTube(B, faces, col) {
    const step = (Math.PI * 2) / faces;
    const cols = faces + 1;   // smooth path: faces++ then closes the loop
    const sv = [], sn = [];
    let th = 0;
    for (let i = 0; i < cols; i++) {
      const x = Math.cos(th), y = Math.sin(th);
      const nrm = [x, 0, y];
      sv.push([x, 0, y], [x, 1, y]);
      sn.push(nrm, nrm);
      th += step;
    }
    stripToTris(B, sv, sn, col);
    // caps: bottom (y=0, ring CCW), top (y=1, ring reversed) -- outward facing.
    for (let z = 0; z <= 1; z++) {
      const cv = [[0, z, 0]], cn = [[0, z === 0 ? -1 : 1, 0]];
      let t = 0;
      for (let i = (z === 0 ? 0 : faces); (z === 0 ? i <= faces : i >= 0); i += (z === 0 ? 1 : -1)) {
        cv.push([Math.cos(t), z, Math.sin(t)]);
        cn.push(cn[0]);
        t += (z === 0 ? step : -step);
      }
      fanToTris(B, cv, cn, col);
    }
  }

  // tube(): place a unit_tube between two points (diameter, optional cap extension).
  function tube(B, stack, x1, y1, z1, x2, y2, z2, diameter, capSize, faces, col) {
    const X = x2 - x1, Y = y2 - y1, Z = z2 - z1;
    if (X === 0 && Y === 0 && Z === 0) return;
    const length = Math.sqrt(X * X + Y * Y + Z * Z);
    stack.push();
    stack.translate(x1, y1, z1);
    stack.rotate(-Math.atan2(X, Y) * (180 / Math.PI), 0, 0, 1);
    stack.rotate(Math.atan2(Z, Math.sqrt(X * X + Y * Y)) * (180 / Math.PI), 1, 0, 0);
    stack.scale(diameter, length, diameter);
    if (capSize !== 0) {
      const c = capSize / length;
      stack.translate(0, -c, 0);
      stack.scale(1, 1 + c + c, 1);
    }
    B.setMatrix(stack.matrix());
    unitTube(B, faces, col);
    B.setMatrix(null);
    stack.pop();
  }
  const ctube = (B, stack, diameter, width, col) =>
    tube(B, stack, 0, 0, width / 2, 0, 0, -width / 2, diameter, 0, 32, col);

  // arm(): a flat-shaded tapering box (top/bottom/left/right faces; ends omitted).
  function arm(B, stack, length, width1, height1, width2, height2, col) {
    const M = stack.matrix();
    B.setMatrix(M);
    const L = length / 2, w1 = width1 / 2, h1 = height1 / 2, w2 = width2 / 2, h2 = height2 / 2;
    // top (CCW, n=0,0,-1)
    B.quad([-L, -w1, -h1], [-L, w1, -h1], [L, w2, -h2], [L, -w2, -h2], [0, 0, -1], [0, 0, -1], [0, 0, -1], [0, 0, -1], col, true);
    // bottom (CW, n=0,0,1)
    B.quad([-L, -w1, h1], [-L, w1, h1], [L, w2, h2], [L, -w2, h2], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], col, false);
    // left (CW, n=0,-1,0)
    B.quad([-L, -w1, -h1], [-L, -w1, h1], [L, -w2, h2], [L, -w2, -h2], [0, -1, 0], [0, -1, 0], [0, -1, 0], [0, -1, 0], col, false);
    // right (CCW, n=0,1,0)
    B.quad([-L, w1, -h1], [-L, w1, h1], [L, w2, h2], [L, w2, -h2], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0], col, true);
    B.setMatrix(null);
  }

  // armature(): the three-armed spider that holds a planetary cluster.
  function buildArmature(gears0) {
    const B = Builder();
    const stack = MStack();
    const col = toLin(0.5 + frand(0.5), 0.5 + frand(0.5), 0.5 + frand(0.5));

    stack.push();
    { let s = gears0.r * 2.7; s = s / 5.6; stack.scale(s, s, s); }
    stack.translate(0, 0, 1.4 + gears0.thickness);
    stack.rotate(30, 0, 0, 1);

    ctube(B, stack, 0.5, 10, col);   // center axle

    for (const a of [0, 120, 240]) {   // three outer axles + collars
      stack.push();
      stack.rotate(a, 0, 0, 1);
      stack.translate(0, 4.2, -1);
      ctube(B, stack, 0.5, 3, col);
      stack.translate(0, 0, 1.8);
      ctube(B, stack, 0.7, 0.7, col);
      stack.pop();
    }

    stack.translate(0, 0, 1.5);
    ctube(B, stack, 1.5, 2, col);     // center disk

    for (const a of [270, 30, 150]) {   // three arms
      stack.push();
      stack.rotate(a, 0, 0, 1);
      stack.rotate(-10, 0, 1, 0);
      stack.translate(-2.2, 0, 0);
      arm(B, stack, 4.0, 1.0, 0.5, 2.0, 1.0, col);
      stack.pop();
    }

    stack.pop();
    return B.geometry();
  }

  // ===================================================================
  //  gears.c -- gear generation, placement, planetary
  // ===================================================================
  const gears = [];   // bp->gears
  let planetaryP = false;

  function newGear(parent) {
    const g = {
      x: 0, y: 0, z: 0, r: 0, th: 0, nteeth: 0, tooth_w: 0, tooth_h: 0, tooth_slope: 0,
      inner_r: 0, inner_r2: 0, inner_r3: 0, thickness: 0, thickness2: 0, thickness3: 0,
      spokes: 0, nubs: 0, spoke_thickness: 0, ratio: 0, inverted_p: false, base_p: false,
      coax_p: 0, wobble: 0, size: LARGE, polygons: 0,
    };

    // Tooth size.
    if (parent) {
      g.tooth_w = parent.tooth_w;
      g.tooth_h = parent.tooth_h;
      g.tooth_slope = -parent.tooth_slope;
    } else {
      g.tooth_w = 0.007 * (1.0 + BELLRAND(4.0));
      g.tooth_h = 0.005 * (1.0 + BELLRAND(8.0));
      // (tooth_slope randomization is commented out in the .c -> stays 0)
    }

    // Tooth count -> radius.
    if (!parent || gears.length > 4) g.nteeth = Math.trunc(5 + BELLRAND(20));
    else g.nteeth = Math.trunc(parent.nteeth * (0.5 + BELLRAND(2)));
    const c = g.nteeth * g.tooth_w * 2;   // circumference = teeth + gaps
    g.r = c / (Math.PI * 2);

    g.thickness = g.tooth_w + frand(g.r);
    g.thickness2 = g.thickness * 0.7;
    g.thickness3 = g.thickness;

    g.color = [0.5 + frand(0.5), 0.5 + frand(0.5), 0.5 + frand(0.5)];
    g.color2 = [g.color[0] * 0.85, g.color[1] * 0.85, g.color[2] * 0.85];

    // Interior shape.
    if (RND(10) === 0) {
      g.inner_r = (g.r * 0.1) + frand((g.r - g.tooth_h / 2) * 0.8);
      g.inner_r2 = 0; g.inner_r3 = 0;
    } else {
      g.inner_r = (g.r * 0.5) + frand((g.r - g.tooth_h) * 0.4);
      g.inner_r2 = (g.r * 0.1) + frand(g.inner_r * 0.5);
      g.inner_r3 = 0;
      if (g.inner_r2 > (g.r * 0.2)) {
        const nn = RND(10);
        if (nn <= 2) g.inner_r3 = (g.r * 0.1) + frand(g.inner_r2 * 0.2);
        else if (nn <= 7 && g.inner_r2 >= 0.1) g.inner_r3 = g.inner_r2 - 0.01;
      }
    }

    // Sometimes spokes in the middle disc.
    if (g.inner_r3 && RND(5) === 0) {
      g.spokes = Math.trunc(2 + BELLRAND(5));
      g.spoke_thickness = 1 + frand(7.0);
      if (g.spokes === 2 && g.spoke_thickness < 2) g.spoke_thickness += 1;
    }

    // Sometimes little nubbly bits, if there's room.
    if (g.nteeth > 5) {
      const br = involuteBiggestRing(g);
      if (br.size > g.r * 0.2 && RND(5) === 0) {
        g.nubs = 1 + RND(16);
        if (g.nubs > 8) g.nubs = 1;
      }
    }

    // Mesh-detail bucket from on-screen tooth size (pixels).
    const pix = g.tooth_h * canvasH;
    if (pix <= 2.5) g.size = SMALL;
    else if (pix <= 3.5) g.size = MEDIUM;
    else if (pix <= 25) g.size = LARGE;
    else g.size = HUGE;

    g.base_p = !parent;
    return g;
  }

  function placeGear(g, parent) {
    // Velocity.
    if (!parent) {
      g.ratio = 0.8 + BELLRAND(0.4);
      g.th = 1;   // not 0
    } else {
      g.ratio = parent.nteeth / g.nteeth;
      g.th = -(parent.th * g.ratio);
      if (g.nteeth & 1) {   // half-tooth offset for odd tooth count
        const off = 180.0 / g.nteeth;
        if (g.th > 0) g.th += off; else g.th -= off;
      }
      g.ratio *= parent.ratio;
    }

    if (parent) {   // place next to parent
      const r_off = parent.r + g.r;
      const angle = RND(360) - 180;   // -180..+180 deg
      g.x = parent.x + Math.cos(angle * (Math.PI / 180)) * r_off;
      g.y = parent.y + Math.sin(angle * (Math.PI / 180)) * r_off;
      g.z = parent.z;
      g.th += (g.th > 0 ? 360 : -360);
      // line teeth up with parent based on position + parent's rotation
      const p_c = 2 * Math.PI * parent.r;
      const g_c = 2 * Math.PI * g.r;
      const p_t = p_c * (angle / 360.0);
      const g_rat = p_t / g_c;
      const g_th = 360.0 * g_rat;
      g.th += angle + g_th;
    }

    // Reject if it overlaps an earlier gear on the same layer.
    for (let i = gears.length - 1; i >= 0; i--) {
      const og = gears[i];
      if (og === g || og === parent) continue;
      if (g.z !== og.z) continue;
      const sum = g.r + g.tooth_h + og.r + og.tooth_h;
      if (((g.x - og.x) ** 2 + (g.y - og.y) ** 2) < sum * sum) return false;
    }
    return true;
  }

  function placeNewGear(parent) {
    let g = null;
    for (let loop = 0; loop < 100; loop++) {
      g = newGear(parent);
      if (placeGear(g, parent)) { gears.push(g); return g; }
    }
    return null;   // gave up; keep previous parent
  }

  function planetaryGears() {
    planetaryP = true;
    const distance = 2.02;
    const g0 = newGear(null), g1 = newGear(null), g2 = newGear(null), g3 = newGear(null), g4 = newGear(null);
    placeGear(g0, null); placeGear(g1, null); placeGear(g2, null); placeGear(g3, null); placeGear(g4, null);

    g0.nteeth = 12 + (3 * RND(10));   // must be multiple of 3
    g0.tooth_w = g0.r / g0.nteeth;
    g0.tooth_h = g0.tooth_w * 2.8;

    for (const k of ['r', 'th', 'nteeth', 'tooth_w', 'tooth_h', 'tooth_slope',
      'inner_r', 'inner_r2', 'inner_r3', 'thickness', 'thickness2', 'thickness3',
      'ratio', 'size']) {
      g1[k] = g2[k] = g3[k] = g4[k] = g0[k];
    }
    g1.color = g2.color = g3.color = g4.color = g0.color;
    g1.color2 = g2.color2 = g3.color2 = g4.color2 = g0.color2;

    g1.x = Math.cos(Math.PI * 2 / 3) * g1.r * distance;
    g1.y = Math.sin(Math.PI * 2 / 3) * g1.r * distance;
    g2.x = Math.cos(Math.PI * 4 / 3) * g2.r * distance;
    g2.y = Math.sin(Math.PI * 4 / 3) * g2.r * distance;
    g3.x = Math.cos(Math.PI * 6 / 3) * g3.r * distance;
    g3.y = Math.sin(Math.PI * 6 / 3) * g3.r * distance;
    g4.x = 0; g4.y = 0; g4.th = -g3.th;
    if (g4.nteeth & 1) g4.th -= (180.0 / g4.nteeth);

    // sun: a ring gear with teeth on the inside.
    g0.inverted_p = true;
    g0.x = 0; g0.y = 0;
    g0.nteeth = g1.nteeth * 3;
    g0.r = g1.r * 3.05;
    g0.inner_r = g0.r * 0.8;
    g0.inner_r2 = 0; g0.inner_r3 = 0;
    g0.th = g1.th + (180 / g0.nteeth);
    g0.ratio = g1.ratio / 3;
    g0.tooth_slope = 0;
    g0.nubs = 3;
    g0.spokes = 0;
    g0.size = LARGE;

    gears.length = 0;
    gears.push(g1, g2, g3, g4, g0);
  }

  // ===================================================================
  //  three.js scene + canvas
  // ===================================================================
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);
  const canvasH = Math.round(window.innerHeight * dpr);   // MI_HEIGHT for the mesh-detail bucket

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // reshape_gears: gluPerspective(30, aspect, 1, 100) + gluLookAt(0,0,30, 0,0,0, 0,1,0).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // One white directional light from (1,1,1) (GL pos {1,1,1,0}, w=0 => parallel),
  // ambient 0 (so unlit side walls go dark). intensity PI cancels three's 1/PI
  // diffuse normalization (same as dangerball). The GL light's cyan {0,1,1}
  // SPECULAR is folded onto the material specular below (three has no separate
  // light-specular color); the highlight is light.color * material.specular.
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(1, 1, 1);
  scene.add(light);

  // Single shared material; diffuse comes from per-vertex colors (color/color2),
  // specular = the light's cyan, shininess 128 (draw_involute_gear).
  const material = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    vertexColors: true,
    specular: 0x00ffff,
    shininess: 128,
    side: SIDE,
  });

  // Nested groups mirroring draw_gears' modelview (see header).
  const viewRoot = new THREE.Group();   // reshape portrait-fit scale
  const posGroup = new THREE.Group();   // translate by rotator position
  const rotGroup = new THREE.Group();   // tumble (+ fixed tilt)
  const fitGroup = new THREE.Group();   // bbox fit scale
  const centerGroup = new THREE.Group();// bbox center translate
  viewRoot.add(posGroup); posGroup.add(rotGroup); rotGroup.add(fitGroup);
  fitGroup.add(centerGroup); scene.add(viewRoot);

  const meshes = [];
  let bbox = { x1: 0, y1: 0, x2: 0, y2: 0 };

  function buildScene() {
    // tear down any previous build
    for (const m of meshes) { centerGroup.remove(m); m.geometry.dispose(); }
    meshes.length = 0;
    gears.length = 0;
    planetaryP = false;

    if (RND(8) === 0) {
      planetaryGears();
    } else {
      let total = config.count;
      if (total <= 0) total = Math.trunc(3 + Math.abs(BELLRAND(8) - 4));   // 3-7, mostly 3
      let g = null;
      for (let i = 0; i < total; i++) g = placeNewGear(g);
    }

    // Center gears in scene (bbox over gear discs).
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const g of gears) {
      if (g.x - g.r < minx) minx = g.x - g.r;
      if (g.x + g.r > maxx) maxx = g.x + g.r;
      if (g.y - g.r < miny) miny = g.y - g.r;
      if (g.y + g.r > maxy) maxy = g.y + g.r;
    }
    bbox = { x1: minx, y1: miny, x2: maxx, y2: maxy };

    // Precompute linear vertex colors, build each gear's geometry + mesh.
    for (const g of gears) {
      g.colLin = toLin(g.color[0], g.color[1], g.color[2]);
      g.col2Lin = toLin(g.color2[0], g.color2[1], g.color2[2]);
      const mesh = new THREE.Mesh(buildGearGeometry(g), material);
      mesh.position.set(g.x, g.y, g.z);
      mesh.rotation.z = g.th * DEG;
      centerGroup.add(mesh);
      meshes.push({ mesh, gear: g, isArmature: false });
      // keep a flat handle for the spin loop
    }
    if (planetaryP) {
      // armature() scales off bp->gears[0] -- which is the first PLANET (g1),
      // not the sun (g0 is pushed last); see planetary_gears' push order.
      const am = new THREE.Mesh(buildArmature(gears[0]), material);
      centerGroup.add(am);
      meshes.push({ mesh: am, gear: null, isArmature: true });
    }

    // Apply the static bbox fit (draw_gears: scale 10/max(w,h), translate -center).
    const w = bbox.x2 - bbox.x1, h = bbox.y2 - bbox.y1;
    const s = 10.0 / (w > h ? w : h);
    fitGroup.scale.setScalar(s);
    centerGroup.position.set(-(bbox.x1 + w / 2), -(bbox.y1 + h / 2), 0);
  }

  // ---- rotator: slow whole-scene tumble + wander (init_gears speeds) ----
  // make_rotator(0.5,0.5,0.5, 0.25, 0.01, True).
  const rot = makeRotator(
    { spinX: 0.5, spinY: 0.5, spinZ: 0.5, spinAccel: 0.25, wanderSpeed: 0.01, randomize: true },
    rng,
  );

  buildScene();

  // ---- rotator sampling + interpolation (dangerball machinery) ----
  const r0 = rot.getRotation(false), p0 = rot.getPosition(false);
  let prevR = { ...r0 }, curR = { ...r0 };
  let prevP = { ...p0 }, curP = { ...p0 };
  let rotAccum = 0;
  function tickRotator() {
    prevR = curR; curR = rot.getRotation(true);
    prevP = curP; curP = rot.getPosition(true);
  }
  function lerpAngle(a, b, t) { let d = b - a; if (d > 0.5) d -= 1; else if (d < -0.5) d += 1; return a + d * t; }
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---- sizing (reshape_gears: gluPerspective + the portrait fit scale) ----
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    viewRoot.scale.setScalar(w < h ? w / h : 1);   // reshape glScalef(s,s,s)
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

    // Gear spin: th += ratio*5*speed per original-frame, sign preserved (continuous).
    for (const e of meshes) {
      if (e.isArmature) continue;
      const g = e.gear;
      const off = g.ratio * 5 * config.speed * frames;
      g.th += (g.th > 0 ? off : -off);
      e.mesh.rotation.z = g.th * DEG;
    }

    // Whole-scene tumble: tick rotator at the original cadence, interpolate.
    rotAccum += frames;
    let ticks = 0;
    while (rotAccum >= 1 && ticks < MAX_TICKS) { tickRotator(); rotAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) rotAccum = 0;
    const a = rotAccum;

    // rotation: get_rotation, then the fixed tilt x-=0.14, y-=0.06 (always applied,
    // so -no-spin still shows the classic receding-train view).
    let rx = -0.14, ry = -0.06, rz = 0;
    if (config.spin) {
      rx = lerpAngle(prevR.x, curR.x, a) - 0.14;
      ry = lerpAngle(prevR.y, curR.y, a) - 0.06;
      rz = lerpAngle(prevR.z, curR.z, a);
    }
    rotGroup.rotation.set(rx * 2 * Math.PI, ry * 2 * Math.PI, rz * 2 * Math.PI, 'XYZ');

    // position: (x-0.5)*4, (y-0.5)*4, (z-0.5)*7.
    if (config.wander) {
      posGroup.position.set(
        (lerp(prevP.x, curP.x, a) - 0.5) * 4,
        (lerp(prevP.y, curP.y, a) - 0.5) * 4,
        (lerp(prevP.z, curP.z, a) - 0.5) * 7,
      );
    } else posGroup.position.set(0, 0, 0);

    material.wireframe = config.wire;
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      for (const e of meshes) e.mesh.geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { buildScene(); },   // fresh gear train (host 're-seed')
    config,
    params,
  };
}

export default { title, info, start };
