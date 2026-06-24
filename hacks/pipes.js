// pipes.js -- "Pipes" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's pipes (Marcelo Vianna & Jamie Zawinski, 1997),
// hacks/glx/pipes.c. A self-building 3D plumbing system grows through a cell grid:
// pipes run along the 3 axes, turn via ball joints (type 1) or elbows (types 2/3),
// and reveal one segment at a time; when a screenful is done it shrinks/spins away
// and a new system grows. Self-contained three.js (own overlay canvas + renderer +
// loop), like gears.js / dangerball.js. RNG = the shared yarandom.js; the geometry
// accumulator (Builder / MStack) is shared from involute.js.
//
// The faithful pipe SYSTEM -- the cell-grid growth (FindNeighbors /
// SelectNeighbor / turn probability / color-avoid-repeat / the three system
// types / the per-(nowdir,newdir) elbow-orientation switch), MakeTube (the
// 24-facet cylinder), mySphere (unit sphere), myElbow (the quarter-torus), the
// per-segment incremental reveal, the slow Y rotation, and the shrink/spin
// fadeout + regenerate -- PLUS the "factory" gadgetry (default factory=2): the
// bolted-flange elbows, valves and gauges (the Lightwave models in
// hacks/glx/pipeobjs.c, via the generated pipeobjs.js + the buildlwo.c port in
// lwo.js) and the rare Utah-teapot easter egg (teapot.c's Bezier teapot, in
// teapot.js). The whole system -- pipes + gadgets -- is baked into ONE merged
// geometry and revealed a segment at a time.
//
// FAITHFUL TO pipes.c -- "do not deviate from the algorithm":
//   * the HCELLS=33 x VCELLS=25 x HCELLS=33 cell grid with boundary walls; pinit's
//     color-avoid-repeat + random unoccupied start; FindNeighbors / SelectNeighbor.
//   * the turn logic (tightturns vs the turncounter-increasing chance), the three
//     system types (1=ball joints, 2=bolted elbows, 3=plain elbows), the exact
//     per-(nowdir,newdir) elbow translate+rotate switch, the start/end spheres, and
//     the cell-center pipe + cell-face pipe at the segment midpoint.
//   * MakeShape: the (counter>1 && NRAND(100)<factory) gate on straight segments,
//     then NRAND(100): <50 gauge (fallback to tube if it won't fit -- and the gauge
//     MARKS the cell above as used, a real grid side effect), <98 valve, else the
//     teapot; the per-shape orientation + the gray bolts / white gauge-face / the
//     contrasting valve-wheel color; type-2 elbows get bolt flanges (factory>0).
//   * coordinates ((P-{16,12,16})/3*4); MakeTube radius 1/3 along the pipe axis;
//     elbow R=r=1/3 quarter torus; spheres 0.6 (caps) / 0.5 (elbowradius joints).
//   * draw_pipes: gluPerspective(65), T(0,0, fisheye?-3.8:-4.8), Ry(initial_rotation
//     += 0.02/frame), Scale(0.1); reveal one segment/frame; fadeout = shrink
//     (s=fadeout^2/10000) + Rotate(90*(1-fadeout/100) about (1,0,0.1)), -4/frame,
//     then regenerate.
//   * lighting: one white directional light from (1,1,1); the gray ambient lift
//     (lmodel_ambient 0.5 + light0 ambient 0.4) * default material ambient 0.2 =
//     ~0.18 gray (modeled as material.emissive); specular 0.7, shininess 60;
//     two-sided (THREE.DoubleSide).
//
// COLOR / PACING as in gears.js / dangerball (raw vertex-color diffuse, colour
// management off; effFps = 1e6/(delay+OVERHEAD)).

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { Builder, MStack } from './involute.js';
import { addLWO, addTris } from './lwo.js';
import { buildTeapot } from './teapot.js';
import {
  BigValve, Bolts3D, GuageConnector, GuageDial, GuageFace,
  GuageHead, PipeBetweenBolts, ElbowBolts, ElbowCoins,
} from './pipeobjs.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding). Disable three's color management so the
// port matches GL: colors are used raw (setRGB(..., SRGBColorSpace) becomes a no-op) and
// the output is not sRGB-encoded. Without this, lit/shaded faces render up to ~2.5x too
// bright (measured vs the rubikblocks grayscale ground truth).
THREE.ColorManagement.enabled = false;

export const title = 'pipes';

export const info = {
  author: 'Marcelo Vianna',
  year: 1997,
  description: 'A growing plumbing system, with bolts and valves.',
};

// dir constants (pipes.c): bit 2 (=4) set => NEAR/FAR (Z axis); bit 1 (=2) => LEFT/RIGHT.
const dirNone = -1, dirUP = 0, dirDOWN = 1, dirLEFT = 2, dirRIGHT = 3, dirNEAR = 4, dirFAR = 5;
const HCELLS = 33, VCELLS = 25, DEFINEDCOLORS = 7;
const ONE_THIRD = 1 / 3;
const ELBOWRADIUS = 0.5;
const NofSysTypes = 3;

// The 7 system colors (the same saturated Material* palette as morph3d/pipes.c).
const MAT = [
  [0.7, 0.0, 0.0], [0.1, 0.5, 0.2], [0.0, 0.0, 0.7], [0.2, 0.5, 0.7],
  [0.7, 0.7, 0.0], [0.6, 0.2, 0.5], [0.7, 0.7, 0.7],
];

export function start(hostCanvas, opts = {}) {
  const DEG = Math.PI / 180;
  const OVERHEAD = 37500;   // us; pacing (xml default delay 10000)

  const config = {
    delay: 10000,        // us (xml default; invert slider)
    cycles: 5,           // number of systems per screenful (xml --cycles / number of pipes)
    size: 500,           // system length (xml --size / pipe length)
    factory: 2,          // "gadgetry": % of straight cells that get a valve/gauge/teapot (xml --factory)
    fisheye: true,       // zoomed-in view (xml --fisheye)
    tightturns: false,   // allow tight turns (xml --tightturns)
    style: 2,            // system type: 1 ball joints, 2 bolted elbows, 3 curves, 0 random
    rotatepipes: true,   // rotate the system per screenful
    wire: false,
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' µs', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cycles', label: 'Number of pipes', type: 'range', min: 1, max: 100, step: 1, default: 5, live: false },
    { key: 'size', label: 'Pipe length', type: 'range', min: 0, max: 3000, step: 50, default: 500, lowLabel: 'short', highLabel: 'long', live: false },
    { key: 'factory', label: 'Gadgetry', type: 'range', min: 0, max: 10, step: 1, default: 2, lowLabel: 'none', highLabel: 'lots', live: false },
    { key: 'style', label: 'Style (0=rnd,1=balls,2=fittings,3=curves)', type: 'range', min: 0, max: 3, step: 1, default: 2, live: false },
    { key: 'fisheye', label: 'Fisheye lens', type: 'checkbox', default: true, live: true },
    { key: 'tightturns', label: 'Allow tight turns', type: 'checkbox', default: false, live: false },
    { key: 'rotatepipes', label: 'Rotate', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);
  const NRAND = (n) => rng.random() % n;
  const _c = new THREE.Color();
  const toLin = (rgb) => { _c.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace); return [_c.r, _c.g, _c.b]; };
  const grayLin = toLin([0.2, 0.2, 0.2]);    // MaterialGray (bolts, gauge connector + dial)
  const whiteLin = toLin([0.7, 0.7, 0.7]);   // MaterialWhite (gauge face)

  // ---- cell grid ----
  const cells = new Int8Array(HCELLS * VCELLS * HCELLS);
  const cidx = (x, y, z) => (x * VCELLS + y) * HCELLS + z;
  const getCell = (x, y, z) => cells[cidx(x, y, z)];
  const setCell = (x, y, z, v) => { cells[cidx(x, y, z)] = v; };

  // ---- growth state (pipesstruct) ----
  const st = {
    PX: 0, PY: 0, PZ: 0, nowdir: dirNone, olddir: dirNone,
    directions: [0, 0, 0, 0, 0, 0], ndirections: 0,
    counter: 0, turncounter: 0,
    system_number: 1, system_type: 2, number_of_systems: 5, system_length: 500,
    usedcolors: new Int32Array(DEFINEDCOLORS),
    colorIdx: 0,
  };

  function findNeighbors() {
    const { PX, PY, PZ } = st;
    const d = st.directions;
    d[dirUP] = getCell(PX, PY + 1, PZ) ? 0 : 1;
    d[dirDOWN] = getCell(PX, PY - 1, PZ) ? 0 : 1;
    d[dirLEFT] = getCell(PX - 1, PY, PZ) ? 0 : 1;
    d[dirRIGHT] = getCell(PX + 1, PY, PZ) ? 0 : 1;
    d[dirFAR] = getCell(PX, PY, PZ - 1) ? 0 : 1;
    d[dirNEAR] = getCell(PX, PY, PZ + 1) ? 0 : 1;
    st.ndirections = d[0] + d[1] + d[2] + d[3] + d[4] + d[5];
  }
  function selectNeighbor() {
    const list = [];
    for (let i = 0; i < 6; i++) if (st.directions[i]) list.push(i);
    return list[NRAND(st.ndirections)];
  }

  function pinit(zera) {
    if (zera) {
      st.system_number = 1;
      cells.fill(0);
      for (let X = 0; X < HCELLS; X++)
        for (let Y = 0; Y < VCELLS; Y++) {
          setCell(X, Y, 0, 1); setCell(X, Y, HCELLS - 1, 1);
          setCell(0, Y, X, 1); setCell(HCELLS - 1, Y, X, 1);
        }
      for (let X = 0; X < HCELLS; X++)
        for (let Z = 0; Z < HCELLS; Z++) { setCell(X, 0, Z, 1); setCell(X, VCELLS - 1, Z, 1); }
      st.usedcolors.fill(0);
    }
    st.counter = 0;
    st.turncounter = 0;

    // color: avoid repeating until necessary (pick among least-used).
    let lower = 1000;
    for (let i = 0; i < DEFINEDCOLORS; i++) if (lower > st.usedcolors[i]) lower = st.usedcolors[i];
    const collist = [];
    for (let i = 0; i < DEFINEDCOLORS; i++) if (st.usedcolors[i] === lower) collist.push(i);
    st.colorIdx = collist[NRAND(collist.length)];
    st.usedcolors[st.colorIdx]++;

    // random unoccupied (and not fully-surrounded) start.
    do {
      st.PX = NRAND(HCELLS - 1) + 1;
      st.PY = NRAND(VCELLS - 1) + 1;
      st.PZ = NRAND(HCELLS - 1) + 1;
    } while (getCell(st.PX, st.PY, st.PZ) ||
      (getCell(st.PX + 1, st.PY, st.PZ) && getCell(st.PX - 1, st.PY, st.PZ) &&
       getCell(st.PX, st.PY + 1, st.PZ) && getCell(st.PX, st.PY - 1, st.PZ) &&
       getCell(st.PX, st.PY, st.PZ + 1) && getCell(st.PX, st.PY, st.PZ - 1)));
    setCell(st.PX, st.PY, st.PZ, 1);
    st.olddir = dirNone;
    findNeighbors();
    st.nowdir = selectNeighbor();
  }

  // cell -> world coordinate.
  const cx = (PX) => (PX - 16) / 3.0 * 4.0;
  const cy = (PY) => (PY - 12) / 3.0 * 4.0;
  const cz = (PZ) => (PZ - 16) / 3.0 * 4.0;

  // ---- geometry builders (push into a Builder via an MStack transform) ----
  // MakeTube: a 24-facet cylinder radius 1/3, length 2/3 along Z, rotated per direction.
  function makeTube(B, stack, direction, col) {
    const facets = 24;
    stack.push();
    if (!(direction & 4)) stack.rotate(90, (direction & 2) ? 0 : 1, (direction & 2) ? 1 : 0, 0);
    B.setMatrix(stack.matrix());
    const step = (Math.PI * 2) / facets;
    for (let i = 0; i < facets; i++) {
      const a = i * step, a2 = (i + 1) * step;
      const c = Math.cos(a), s = Math.sin(a), c2 = Math.cos(a2), s2 = Math.sin(a2);
      const ti = [c / 3, s / 3, ONE_THIRD], bi = [c / 3, s / 3, -ONE_THIRD];
      const tj = [c2 / 3, s2 / 3, ONE_THIRD], bj = [c2 / 3, s2 / 3, -ONE_THIRD];
      const ni = [c, s, 0], nj = [c2, s2, 0];
      B.quad(ti, bi, bj, tj, ni, ni, nj, nj, col, true);
    }
    B.setMatrix(null);
    stack.pop();
  }

  // mySphere: unit_sphere(16,16) scaled by radius.
  function makeSphere(B, stack, radius, col) {
    const stacks = 16, slices = 16;
    stack.push();
    stack.scale(radius, radius, radius);
    B.setMatrix(stack.matrix());
    for (let i = 0; i < stacks; i++) {
      const ph0 = Math.PI * i / stacks - Math.PI / 2, ph1 = Math.PI * (i + 1) / stacks - Math.PI / 2;
      const y0 = Math.sin(ph0), y1 = Math.sin(ph1), r0 = Math.cos(ph0), r1 = Math.cos(ph1);
      for (let j = 0; j < slices; j++) {
        const t0 = (Math.PI * 2) * j / slices, t1 = (Math.PI * 2) * (j + 1) / slices;
        const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
        const v00 = [r0 * c0, y0, r0 * s0], v01 = [r0 * c1, y0, r0 * s1];
        const v10 = [r1 * c0, y1, r1 * s0], v11 = [r1 * c1, y1, r1 * s1];
        B.quad(v00, v10, v11, v01, v00, v10, v11, v01, col, true);   // normal = unit position
      }
    }
    B.setMatrix(null);
    stack.pop();
  }

  // myElbow: a quarter horn-torus (R=r=1/3), 25 sides x 25 rings (quarter => i<=rings/4).
  // `bolted` (type-2 systems, factory>0) adds the flange of coins + gray bolts.
  function makeElbow(B, stack, col, bolted) {
    const nsides = 25, rings = 25, r = ONE_THIRD, R = ONE_THIRD;
    B.setMatrix(stack.matrix());
    for (let i = 0; i <= Math.floor(rings / 4); i++) {
      const theta = i * 2 * Math.PI / rings, theta1 = (i + 1) * 2 * Math.PI / rings;
      const ct = Math.cos(theta), stt = -Math.sin(theta);
      const ct1 = Math.cos(theta1), st1 = -Math.sin(theta1);
      for (let j = 0; j < nsides; j++) {
        const phi = j * 2 * Math.PI / nsides, phi1 = (j + 1) * 2 * Math.PI / nsides;
        const cph = Math.cos(phi), cph1 = Math.cos(phi1), sph = Math.sin(phi), sph1 = Math.sin(phi1);
        const p0 = [ct * (R + r * cph), stt * (R + r * cph), r * sph];
        const p1 = [ct1 * (R + r * cph), st1 * (R + r * cph), r * sph];
        const p2 = [ct1 * (R + r * cph1), st1 * (R + r * cph1), r * sph1];
        const p3 = [ct * (R + r * cph1), stt * (R + r * cph1), r * sph1];
        const n0 = [ct * cph, stt * cph, sph];
        const n1 = [ct1 * cph, st1 * cph, sph];
        const n2 = [ct1 * cph1, st1 * cph1, sph1];
        const n3 = [ct * cph1, stt * cph1, sph1];
        B.quad(p3, p2, p1, p0, n3, n2, n1, n0, col, true);
      }
    }
    B.setMatrix(null);

    if (bolted) {
      stack.push();
      stack.rotate(90, 0, 0, -1);
      stack.rotate(90, 0, 1, 0);
      stack.translate(0, ONE_THIRD, ONE_THIRD);
      addLWO(B, stack, ElbowCoins, col);      // system color
      addLWO(B, stack, ElbowBolts, grayLin);  // gray
      stack.pop();
    }
  }

  // The per-(nowdir,newdir) elbow placement (translate to the cell +/- 1/3, rotate).
  function placeElbow(stack, nowdir, newdir, PX, PY, PZ) {
    const X = cx(PX), Yc = cy(PY), Z = cz(PZ), o = ONE_THIRD;
    const T = (x, y, z) => stack.translate(x, y, z);
    const Rt = (d, x, y, z) => stack.rotate(d, x, y, z);
    switch (nowdir) {
      case dirUP:
        if (newdir === dirLEFT) { T(X - o, Yc - o, Z); Rt(180, 1, 0, 0); }
        else if (newdir === dirRIGHT) { T(X + o, Yc - o, Z); Rt(180, 1, 0, 0); Rt(180, 0, 1, 0); }
        else if (newdir === dirFAR) { T(X, Yc - o, Z - o); Rt(90, 0, 1, 0); Rt(180, 0, 0, 1); }
        else if (newdir === dirNEAR) { T(X, Yc - o, Z + o); Rt(90, 0, 1, 0); Rt(180, 1, 0, 0); }
        break;
      case dirDOWN:
        if (newdir === dirLEFT) { T(X - o, Yc + o, Z); }
        else if (newdir === dirRIGHT) { T(X + o, Yc + o, Z); Rt(180, 0, 1, 0); }
        else if (newdir === dirFAR) { T(X, Yc + o, Z - o); Rt(270, 0, 1, 0); }
        else if (newdir === dirNEAR) { T(X, Yc + o, Z + o); Rt(90, 0, 1, 0); }
        break;
      case dirLEFT:
        if (newdir === dirUP) { T(X + o, Yc + o, Z); Rt(180, 0, 1, 0); }
        else if (newdir === dirDOWN) { T(X + o, Yc - o, Z); Rt(180, 1, 0, 0); Rt(180, 0, 1, 0); }
        else if (newdir === dirFAR) { T(X + o, Yc, Z - o); Rt(270, 1, 0, 0); Rt(180, 0, 1, 0); }
        else if (newdir === dirNEAR) { T(X + o, Yc, Z + o); Rt(270, 1, 0, 0); Rt(180, 0, 0, 1); }
        break;
      case dirRIGHT:
        if (newdir === dirUP) { T(X - o, Yc + o, Z); }
        else if (newdir === dirDOWN) { T(X - o, Yc - o, Z); Rt(180, 1, 0, 0); }
        else if (newdir === dirFAR) { T(X - o, Yc, Z - o); Rt(270, 1, 0, 0); }
        else if (newdir === dirNEAR) { T(X - o, Yc, Z + o); Rt(90, 1, 0, 0); }
        break;
      case dirNEAR:
        if (newdir === dirLEFT) { T(X - o, Yc, Z - o); Rt(270, 1, 0, 0); }
        else if (newdir === dirRIGHT) { T(X + o, Yc, Z - o); Rt(270, 1, 0, 0); Rt(180, 0, 1, 0); }
        else if (newdir === dirUP) { T(X, Yc + o, Z - o); Rt(270, 0, 1, 0); }
        else if (newdir === dirDOWN) { T(X, Yc - o, Z - o); Rt(90, 0, 1, 0); Rt(180, 0, 0, 1); }
        break;
      case dirFAR:
        if (newdir === dirUP) { T(X, Yc + o, Z + o); Rt(90, 0, 1, 0); }
        else if (newdir === dirDOWN) { T(X, Yc - o, Z + o); Rt(90, 0, 1, 0); Rt(180, 1, 0, 0); }
        else if (newdir === dirLEFT) { T(X - o, Yc, Z + o); Rt(90, 1, 0, 0); }
        else if (newdir === dirRIGHT) { T(X + o, Yc, Z + o); Rt(270, 1, 0, 0); Rt(180, 0, 0, 1); }
        break;
    }
  }

  // ---- factory gadgetry (pipeobjs.c models + the teapot) ----
  // MakeShape: on a straight cell (counter>1 && NRAND(100)<factory), draw a gauge,
  // valve, or -- rarely -- a teapot, instead of a plain tube.
  function makeShape(B, stack, newdir, col) {
    const n = NRAND(100);
    if (n < 50) {
      if (!makeGuage(B, stack, newdir, col)) makeTube(B, stack, newdir, col);
    } else if (n < 98) {
      makeValve(B, stack, newdir, col);
    } else {
      makeTeapot(B, stack, newdir, col);
    }
  }

  // MakeGuage: a pressure gauge standing UP off the pipe. Returns false (caller
  // draws a plain tube) on a vertical pipe or when the cell above is occupied;
  // otherwise it MARKS that cell used (a real side effect on the growth grid).
  function makeGuage(B, stack, newdir, col) {
    if (newdir === dirUP || newdir === dirDOWN) return false;
    if (!st.directions[dirUP]) return false;
    setCell(st.PX, st.PY + 1, st.PZ, 1);

    stack.push();
    if (newdir === dirLEFT || newdir === dirRIGHT) stack.rotate(90, 0, 1, 0);
    addLWO(B, stack, PipeBetweenBolts, col);   // system color
    addLWO(B, stack, Bolts3D, grayLin);        // gray
    stack.pop();

    addLWO(B, stack, GuageConnector, grayLin); // gray (still set from the bolts)
    stack.push();
    stack.translate(0, 1.33333, 0);            // object is centered on 1.33333, not 1+1/3
    stack.rotate(NRAND(270) + 45, 0, 0, -1);   // random dial reading
    addLWO(B, stack, GuageDial, grayLin);      // gray
    stack.pop();

    addLWO(B, stack, GuageHead, col);          // system color
    addLWO(B, stack, GuageFace, whiteLin);     // white (drawn last for low-res depth)
    return true;
  }

  // The valve hand-wheel takes a CONTRASTING color (never the system color).
  function valveColor() {
    let i;
    if (st.colorIdx === 0) i = NRAND(2) ? 4 : 2;        // Red    -> Yellow / Blue
    else if (st.colorIdx === 2) i = NRAND(2) ? 0 : 4;   // Blue   -> Red / Yellow
    else if (st.colorIdx === 4) i = NRAND(2) ? 2 : 0;   // Yellow -> Blue / Red
    else i = [0, 2, 4][NRAND(3)];                       // else   -> Red / Blue / Yellow
    return toLin(MAT[i]);
  }

  // MakeValve: a bolted pipe section carrying a contrasting hand-wheel valve.
  function makeValve(B, stack, newdir, col) {
    switch (newdir) {
      case dirUP: case dirDOWN:
        stack.rotate(90, 1, 0, 0); stack.rotate(NRAND(3) * 90, 0, 0, 1); break;
      case dirLEFT: case dirRIGHT:
        stack.rotate(90, 0, -1, 0); stack.rotate(NRAND(3) * 90 - 90, 0, 0, 1); break;
      case dirNEAR: case dirFAR:
        stack.rotate(NRAND(4) * 90, 0, 0, 1); break;
    }
    addLWO(B, stack, PipeBetweenBolts, col);   // system color
    addLWO(B, stack, Bolts3D, grayLin);        // gray
    const wheel = valveColor();
    stack.rotate(NRAND(90), 1, 0, 0);          // a random wheel angle
    addLWO(B, stack, BigValve, wheel);
  }

  // MakeTeapot: the rare Utah-teapot easter egg, in the system color.
  function makeTeapot(B, stack, newdir, col) {
    switch (newdir) {
      case dirUP: case dirDOWN:
        stack.rotate(90, 1, 0, 0); stack.rotate(NRAND(3) * 90, 0, 0, 1); break;
      case dirLEFT: case dirRIGHT:
        stack.rotate(90, 0, -1, 0); stack.rotate(NRAND(3) * 90 - 90, 0, 0, 1); break;
      case dirNEAR: case dirFAR:
        stack.rotate(NRAND(4) * 90, 0, 0, 1); break;
    }
    addTris(B, stack, buildTeapot(12), col);
  }

  // ---- generate the whole system into one geometry + per-segment vertex ranges ----
  function generateSystem() {
    const B = Builder();
    const stack = MStack();
    const stepEnds = [];
    const factoryVal = config.factory;
    pinit(1);
    let resetP = false;

    while (true) {
      const col = toLin(MAT[st.colorIdx]);

      // start-of-system sphere
      if (st.olddir === dirNone) {
        stack.push(); stack.translate(cx(st.PX), cy(st.PY), cz(st.PZ));
        makeSphere(B, stack, 0.6, col); stack.pop();
      }

      // stop conditions: end sphere, then new system or reset.
      if (st.ndirections === 0 || st.counter > st.system_length) {
        stack.push(); stack.translate(cx(st.PX), cy(st.PY), cz(st.PZ));
        makeSphere(B, stack, 0.6, col); stack.pop();
        if (++st.system_number > st.number_of_systems) resetP = true;
        else pinit(0);
        stepEnds.push(B.count());
        if (resetP) break;
        continue;
      }
      st.counter++; st.turncounter++;

      // decide the (maybe new) direction.
      let newdir = st.nowdir;
      if (!st.directions[newdir]) {
        newdir = selectNeighbor();
      } else if (config.tightturns) {
        if (st.counter > 1 && NRAND(100) < 20) newdir = selectNeighbor();
      } else {
        if (st.counter > 1 && NRAND(50) < NRAND(st.turncounter + 1)) {
          newdir = selectNeighbor(); st.turncounter = 0;
        }
      }

      if (newdir === st.nowdir) {
        // straight: cell-center pipe, or (rarely) a factory shape.
        stack.push(); stack.translate(cx(st.PX), cy(st.PY), cz(st.PZ));
        if (st.counter > 1 && NRAND(100) < factoryVal) makeShape(B, stack, newdir, col);
        else makeTube(B, stack, newdir, col);
        stack.pop();
      } else {
        // turn: ball joint (type 1) or elbow (types 2/3; type 2 is bolted).
        let sysT = st.system_type;
        if (sysT === NofSysTypes + 1) sysT = ((st.system_number - 1) % NofSysTypes) + 1;
        if (sysT === 1) {
          stack.push(); stack.translate(cx(st.PX), cy(st.PY), cz(st.PZ));
          makeSphere(B, stack, ELBOWRADIUS, col); stack.pop();
        } else {
          stack.push();
          placeElbow(stack, st.nowdir, newdir, st.PX, st.PY, st.PZ);
          makeElbow(B, stack, col, factoryVal > 0 && sysT === 2);
          stack.pop();
        }
      }

      // advance to the next cell.
      const OPX = st.PX, OPY = st.PY, OPZ = st.PZ;
      st.olddir = st.nowdir;
      st.nowdir = newdir;
      if (newdir === dirUP) st.PY++;
      else if (newdir === dirDOWN) st.PY--;
      else if (newdir === dirLEFT) st.PX--;
      else if (newdir === dirRIGHT) st.PX++;
      else if (newdir === dirNEAR) st.PZ++;
      else if (newdir === dirFAR) st.PZ--;
      setCell(st.PX, st.PY, st.PZ, 1);

      // cell-face pipe at the midpoint between the old and new cell.
      stack.push();
      stack.translate(((st.PX + OPX) / 2.0 - 16) / 3.0 * 4.0,
        ((st.PY + OPY) / 2.0 - 12) / 3.0 * 4.0,
        ((st.PZ + OPZ) / 2.0 - 16) / 3.0 * 4.0);
      makeTube(B, stack, newdir, col);
      stack.pop();

      findNeighbors();   // for the next iteration's stop check + turn decision
      stepEnds.push(B.count());
    }

    return { geometry: B.geometry(), stepEnds };
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

  // reshape_pipes: gluPerspective(65, aspect, 0.1, 20), camera at origin looking -z.
  const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 20);
  camera.position.set(0, 0, 0);

  // One white directional light from (1,1,1); the gray ambient lift as emissive.
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(1, 1, 1);
  scene.add(light);

  const material = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    vertexColors: true,
    specular: new THREE.Color().setRGB(0.7, 0.7, 0.7, THREE.SRGBColorSpace),
    shininess: 60,
    emissive: new THREE.Color().setRGB(0.18, 0.18, 0.18, THREE.SRGBColorSpace),
    side: THREE.DoubleSide,
  });

  // draw_pipes modelview: T(0,0,-3.8/-4.8) -> Ry(initial_rotation) -> Scale(0.1) ->
  // fadeout(scale+rotate) -> system.
  const pushG = new THREE.Group();
  const rotG = new THREE.Group();
  const scaleG = new THREE.Group(); scaleG.scale.setScalar(0.1);
  const fadeG = new THREE.Group();
  pushG.add(rotG); rotG.add(scaleG); scaleG.add(fadeG); scene.add(pushG);

  let mesh = null, stepEnds = [], systemSize = 0;
  let systemIndex = 0;   // reveal cursor (segments shown), continuous
  let fadeout = 0;       // 0 = none; else 100..0 shrink/spin
  let initialRotation = config.rotatepipes ? NRAND(180) : -10.0;

  function setup() {
    // (re)derive the run parameters from config, like init_pipes.
    st.system_type = (config.style < 1 || config.style > NofSysTypes + 1)
      ? NRAND(NofSysTypes) + 1 : config.style;
    st.number_of_systems = (config.cycles > 0 && config.cycles < 11) ? config.cycles : 5;
    st.system_length = config.size < 10 ? 10 : (config.size > 1000 ? 1000 : config.size);

    if (mesh) { fadeG.remove(mesh); mesh.geometry.dispose(); mesh = null; }
    const sys = generateSystem();
    stepEnds = sys.stepEnds;
    systemSize = stepEnds.length;
    mesh = new THREE.Mesh(sys.geometry, material);
    mesh.geometry.setDrawRange(0, 0);
    fadeG.add(mesh);
    systemIndex = 0;
    fadeout = 0;
  }

  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    pushG.position.set(0, 0, config.fisheye ? -3.8 : -4.8);
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  setup();

  // ---- render loop ----
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

    pushG.position.z = config.fisheye ? -3.8 : -4.8;
    initialRotation += 0.02 * frames;
    rotG.rotation.y = config.rotatepipes ? initialRotation * DEG : -10.0 * DEG;
    material.wireframe = config.wire;

    if (fadeout > 0) {
      const s = (fadeout * fadeout) / 10000.0;
      fadeG.scale.setScalar(s);
      fadeG.rotation.set(0, 0, 0);
      fadeG.rotateOnAxis(new THREE.Vector3(1, 0, 0.1).normalize(), 90 * (1 - fadeout / 100) * DEG);
      fadeout -= 4 * frames;
      if (fadeout <= 0) { fadeout = 0; setup(); }
    } else {
      fadeG.scale.setScalar(1);
      fadeG.rotation.set(0, 0, 0);
      if (systemIndex < systemSize) {
        systemIndex += frames;
        if (systemIndex > systemSize) systemIndex = systemSize;
      } else {
        fadeout = 100;
      }
      const idx = Math.min(Math.floor(systemIndex), systemSize - 1);
      if (mesh && idx >= 0) mesh.geometry.setDrawRange(0, stepEnds[idx]);
    }

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      if (mesh) mesh.geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { initialRotation = config.rotatepipes ? NRAND(180) : -10.0; setup(); },
    config,
    params,
  };
}

export default { title, info, start };
