// involute.js -- faithful ES-module port of xscreensaver's hacks/glx/involute.c
// (Jamie Zawinski), plus the slice of hacks/glx/tube.c the gears armature needs.
//
// In xscreensaver involute.c is a SHARED library: gears, moebiusgears,
// geodesicgears and pinion all `#include "involute.h"` and call
// draw_involute_gear(). This module mirrors that -- it is imported by gears.js and
// moebiusgears.js exactly as the C hacks share involute.c (the same way rotator.js
// / yarandom.js are shared). It is pure geometry: no DOM, no RNG, no color
// management -- the caller passes a gear with linear vertex colors (colLin,
// col2Lin) already set, and gets back a THREE.BufferGeometry.
//
// FAITHFUL TO involute.c (the rule: do not deviate from the algorithm):
//   * gear_teeth_geometry's r[]/th[] tooth profile + the per-size PUSH() point sets
//     (TOOTH_PROFILE); tooth_normals' AREA-WEIGHTED vertex normals (un-normalized
//     face-normal cross products, then averaged -- three normalizes in-shader);
//   * draw_gear_teeth (outer rim = teeth, inner rim = hole, top/bottom annulus);
//   * draw_gear_interior (inset disc / raised lip / third disc, or spokes);
//   * draw_gear_nubs; the inverted_p (internal-tooth ring) paths.
//   * draw_gear_interior's coax_p==1 axle-tube (used by pinion's bound gear pairs;
//     gears/moebiusgears never set coax_p, so it's inert for them).
//   (wobble is applied by the caller at the mesh level -- draw_involute_gear wraps
//   the gear in glRotatef(wobble,1,0,0), equivalent to an Rx on the mesh.)
//
// CULLING: triangles are emitted with faithful winding (GL vertex order, the
// per-block glFrontFace tracked, reversed when it was GL_CW), so the caller's
// material can use THREE.FrontSide to reproduce GL_CULL_FACE exactly. Gears are
// closed solids, so THREE.DoubleSide is pixel-identical and removes winding risk.

import * as THREE from 'three';

// involute.h size enum (controls mesh complexity / tooth point set).
export const INVOLUTE_SMALL = 0;
export const INVOLUTE_MEDIUM = 1;
export const INVOLUTE_LARGE = 2;
export const INVOLUTE_HUGE = 3;

// gear_teeth_geometry PUSH(OPR,IPR,PTH) point sets per size: [outerRadiusIdx,
// innerRadiusIdx(always 8), thetaIdx]. Transcribed verbatim from the switch.
const TOOTH_PROFILE = {
  [INVOLUTE_SMALL]: [[6, 8, 0], [0, 8, 8]],
  [INVOLUTE_MEDIUM]: [[6, 8, 0], [0, 8, 6], [0, 8, 10], [6, 8, 16]],
  [INVOLUTE_LARGE]: [
    [6, 8, 0], [4, 8, 2], [2, 8, 4], [0, 8, 6], [0, 8, 10],
    [2, 8, 12], [4, 8, 14], [6, 8, 16], [6, 8, 18],
  ],
  [INVOLUTE_HUGE]: [
    [6, 8, 0], [5, 8, 1], [4, 8, 2], [3, 8, 3], [2, 8, 4], [1, 8, 5],
    [0, 8, 6], [0, 8, 8], [0, 8, 10], [1, 8, 11], [2, 8, 12], [3, 8, 13],
    [4, 8, 14], [5, 8, 15], [6, 8, 16], [6, 8, 17], [6, 8, 18], [6, 8, 19],
  ],
};

// ---- normals.c: UN-normalized cross (p1-p) x (p2-p). The .c does not normalize
// here; GL_NORMALIZE does it at draw, and tooth_normals averages these
// (area-weighted) -- we keep them un-normalized and let three normalize in-shader.
function calcNormal(p, p1, p2) {
  const ax = p1[0] - p[0], ay = p1[1] - p[1], az = p1[2] - p[2];
  const bx = p2[0] - p[0], by = p2[1] - p[1], bz = p2[2] - p[2];
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}
const neg3 = (n) => [-n[0], -n[1], -n[2]];

// ---- geometry builder: accumulates positions/normals/colors, converts GL
// primitives to CCW-front triangles. An optional current matrix (setMatrix) bakes
// sub-object transforms (nubs, armature) like the GL modelview stack would.
export function Builder() {
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
  function tri(p0, p1, p2, n0, n1, n2, c, frontCCW) {
    if (frontCCW) { vert(p0, n0, c); vert(p1, n1, c); vert(p2, n2, c); }
    else { vert(p0, n0, c); vert(p2, n2, c); vert(p1, n1, c); }
  }
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
export function MStack() {
  const stk = [new THREE.Matrix4()];
  const tmp = new THREE.Matrix4();
  const top = () => stk[stk.length - 1];
  const axis = new THREE.Vector3();
  return {
    push() { stk.push(top().clone()); },
    pop() { stk.pop(); },
    translate(x, y, z) { top().multiply(tmp.makeTranslation(x, y, z)); },
    rotate(deg, x, y, z) { top().multiply(tmp.makeRotationAxis(axis.set(x, y, z).normalize(), deg * Math.PI / 180)); },
    scale(x, y, z) { top().multiply(tmp.makeScale(x, y, z)); },
    matrix() { return top(); },
  };
}

// ---- involute.c primitives ----

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
    B.quad(vt1, vb1, vb2, vt2, na, na, nb, nb, col, frontCCW);   // QUAD_STRIP [vt1,vb1,vt2,vb2]
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
      B.tri(center, p1, p2, n, n, n, col, frontCCW);   // TRIANGLE_FAN
    }
  } else {
    const frontCCW = upP;    // glFrontFace(upP ? CCW : CW)
    for (let i = 0; i < segments; i++) {
      const th = i * width, th2 = (i + 1) * width;
      const a1 = [Math.cos(th) * ra, Math.sin(th) * ra, z], b1 = [Math.cos(th) * rb, Math.sin(th) * rb, z];
      const a2 = [Math.cos(th2) * ra, Math.sin(th2) * ra, z], b2 = [Math.cos(th2) * rb, Math.sin(th2) * rb, z];
      B.quad(a1, b1, b2, a2, n, n, n, n, col, frontCCW);   // QUAD_STRIP [a1,b1,a2,b2]
    }
  }
}

// draw_spokes: N thick radial bars between ra..rb, top+bottom+side faces.
function drawSpokes(B, n, thickness, segments, ra, rb, z1, z2, slope, col) {
  const s1 = 1 + ((z2 - z1) * slope / 2);
  const s2 = 1 - ((z2 - z1) * slope / 2);
  segments *= 3;
  let segments2 = 0;
  while (segments2 < segments) segments2 += n;
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
      B.quad(   // top (glFrontFace CCW)
        [s1 * cth1 * ra, s1 * sth1 * ra, z1], [s1 * cth1 * rb, s1 * sth1 * rb, z1],
        [s1 * cth2 * rb, s1 * sth2 * rb, z1], [s1 * cth2 * ra, s1 * sth2 * ra, z1],
        nTop, nTop, nTop, nTop, col, true,
      );
      B.quad(   // bottom (glFrontFace CW)
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
export { involuteBiggestRing };

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

// gear_teeth_geometry: the orim (teeth) + irim (hole) point rings + smooth normals.
function gearTeethGeometry(g) {
  const width = (Math.PI * 2) / g.nteeth;
  const rh = g.tooth_h, tw = width, R = g.r;

  const r = new Array(9);
  r[0] = R + rh * 0.50; r[1] = R + rh * 0.40; r[2] = R + rh * 0.25; r[3] = R + rh * 0.05;
  r[4] = R - (r[2] - R); r[5] = R - (r[1] - R); r[6] = R - (r[0] - R); r[7] = r[6]; r[8] = g.inner_r;

  const th = new Array(21);
  th[0] = -tw * (g.size === INVOLUTE_SMALL ? 0.5 : g.size === INVOLUTE_MEDIUM ? 0.41 : 0.45);
  th[1] = -tw * 0.375; th[2] = -tw * 0.300; th[3] = -tw * 0.230;
  th[4] = -tw * (g.nteeth >= 5 ? 0.16 : 0.12); th[5] = -tw * 0.100;
  th[6] = -tw * (g.size === INVOLUTE_MEDIUM ? 0.1 : 0.04); th[7] = -tw * 0.020; th[8] = 0;
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
    if (g.inverted_p) {
      reverseRange(orim, start, orim.length);
      reverseRange(irim, start, irim.length);
    }
  }

  let opn = toothNormals(orim, g.tooth_slope);
  let ipn = toothNormals(irim, 0);
  if (g.inverted_p) { opn = opn.map(neg3); ipn = ipn.map(neg3); }
  return { orim, irim, opn, ipn };
}

// draw_gear_teeth: outer rim (teeth) wall, inner rim (hole) wall, top+bottom annulus.
function drawGearTeeth(B, g) {
  const z1 = -g.thickness / 2, z2 = g.thickness / 2;
  const s1 = 1 + (g.thickness * g.tooth_slope / 2);
  const s2 = 1 - (g.thickness * g.tooth_slope / 2);
  const { orim, irim, opn, ipn } = gearTeethGeometry(g);
  const col = g.colLin;
  const N = orim.length;

  const frontOuter = g.inverted_p;   // glFrontFace(inverted ? CCW : CW)
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const ni = opn[i], nj = opn[j];
    const vt_i = [s1 * orim[i][0], s1 * orim[i][1], z1], vb_i = [s2 * orim[i][0], s2 * orim[i][1], z2];
    const vt_j = [s1 * orim[j][0], s1 * orim[j][1], z1], vb_j = [s2 * orim[j][0], s2 * orim[j][1], z2];
    B.quad(vt_i, vb_i, vb_j, vt_j, ni, ni, nj, nj, col, frontOuter);
  }

  const frontInner = !g.inverted_p;   // glFrontFace(inverted ? CW : CCW); normals negated
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const ni = neg3(ipn[i]), nj = neg3(ipn[j]);
    const vt_i = [s1 * irim[i][0], s1 * irim[i][1], z1], vb_i = [s2 * irim[i][0], s2 * irim[i][1], z2];
    const vt_j = [s1 * irim[j][0], s1 * irim[j][1], z1], vb_j = [s2 * irim[j][0], s2 * irim[j][1], z2];
    B.quad(vt_i, vb_i, vb_j, vt_j, ni, ni, nj, nj, col, frontInner);
  }

  for (const isTop of [true, false]) {   // side faces (flat annulus at z1, z2)
    const z = isTop ? z1 : z2;
    const s = isTop ? s1 : s2;
    const n = [0, 0, z];
    const frontCCW = (isTop !== g.inverted_p);   // ((z==z1) ^ inverted) ? CCW : CW
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const o_i = [s * orim[i][0], s * orim[i][1], z], r_i = [s * irim[i][0], s * irim[i][1], z];
      const o_j = [s * orim[j][0], s * orim[j][1], z], r_j = [s * irim[j][0], s * irim[j][1], z];
      B.quad(o_i, r_i, r_j, o_j, n, n, n, n, col, frontCCW);   // QUAD_STRIP [o_i,r_i,o_j,r_j]
    }
  }
}

// draw_gear_interior: the inset discs / rings / spokes. (coax_p never set -> omitted.)
function drawGearInterior(B, g) {
  let steps = g.nteeth * 2;
  if (steps < 10) steps = 10;
  if (g.size < INVOLUTE_LARGE) steps = Math.floor(steps / 2);
  if (g.size < INVOLUTE_LARGE && steps > 16) steps = 16;

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

  // axle tube: coax_p==1 is the gear of a bound (coaxial) pair that draws the
  // shared axle connecting the two gear planes. (pinion only; coax_p is 0/unset
  // for gears/moebiusgears.)
  if (g.coax_p === 1) {
    const capHeight = g.coax_thickness / 3;
    const ra = (g.inner_r3 ? g.inner_r3 : g.inner_r2 ? g.inner_r2 : g.inner_r);
    const za = -(g.thickness / 2 + capHeight);
    const zb = g.coax_thickness / 2 + g.coax_displacement + capHeight;
    const col = g.colLin;
    drawRing(B, steps, ra, za, zb, g.tooth_slope, false, col);   // axle wall, facing out
    drawDisc(B, steps, 0, ra, za, true, col);                    // top plate
    drawDisc(B, steps, 0, ra, zb, false, col);                   // bottom plate
  }
}

// draw_gear_nubs: little embedded cylinders on the biggest ring.
function drawGearNubs(B, g, stack) {
  if (!g.nubs) return;
  const steps = (g.size < INVOLUTE_LARGE ? 5 : 20);
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
// The gear must have colLin / col2Lin (linear [r,g,b]) set by the caller.
export function buildGearGeometry(g) {
  const B = Builder();
  const stack = MStack();
  drawGearTeeth(B, g);
  drawGearInterior(B, g);
  drawGearNubs(B, g, stack);
  g.polygons = B.count() / 3;
  return B.geometry();
}

// ===================================================================
//  tube.c -- unit_tube + the tube() placement transform + arm(), used by
//  the gears planetary armature (shared GL geometry utilities).
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
  for (let z = 0; z <= 1; z++) {   // caps (outward-facing fans)
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
export function tube(B, stack, x1, y1, z1, x2, y2, z2, diameter, capSize, faces, col) {
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
export const ctube = (B, stack, diameter, width, col) =>
  tube(B, stack, 0, 0, width / 2, 0, 0, -width / 2, diameter, 0, 32, col);

// arm(): a flat-shaded tapering box (top/bottom/left/right faces; ends omitted).
export function arm(B, stack, length, width1, height1, width2, height2, col) {
  B.setMatrix(stack.matrix());
  const L = length / 2, w1 = width1 / 2, h1 = height1 / 2, w2 = width2 / 2, h2 = height2 / 2;
  B.quad([-L, -w1, -h1], [-L, w1, -h1], [L, w2, -h2], [L, -w2, -h2], [0, 0, -1], [0, 0, -1], [0, 0, -1], [0, 0, -1], col, true);
  B.quad([-L, -w1, h1], [-L, w1, h1], [L, w2, h2], [L, -w2, h2], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], col, false);
  B.quad([-L, -w1, -h1], [-L, -w1, h1], [L, -w2, h2], [L, -w2, -h2], [0, -1, 0], [0, -1, 0], [0, -1, 0], [0, -1, 0], col, false);
  B.quad([-L, w1, -h1], [-L, w1, h1], [L, w2, h2], [L, w2, -h2], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0], col, true);
  B.setMatrix(null);
}
