// engine.js -- "Engine" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's engine (Ben Buxton / Ed Beroset / Jamie
// Zawinski, 2001), hacks/glx/engine.c. A spinning, wandering internal-combustion
// engine -- crankshaft + flywheel, reciprocating pistons, swinging connecting
// rods, spark plugs firing in sequence with red flashes -- built as one of ten
// real engine models (Honda Insight inline-3 ... Jaguar XKE V12). The whole
// assembly tumbles and drifts through space (rotator spin + wander).
//
// Self-contained on purpose (own overlay canvas + renderer + render loop), like
// dangerball.js / glknots.js -- it only follows the host's mountable-module
// contract. Its on-screen engine-name label is drawn by the shared HUD overlay
// helper (hud-label.js), the web stand-in for the .c's print_texture_label.
//
// Faithful to the .c:
//   * The exact 10-engine data table (cylinders, included angle, per-cylinder
//     firing/piston angles, crank step speed) transcribed verbatim from engines[].
//   * The geometry primitives cylinder()/rod()/Rect()/CrankBit(), ported vertex-
//     for-vertex (solid + tube, partial arcs, end-cap fans) so every part -- crank
//     journals, webs, wrist pins, hollow pistons + rings, plugs, electrodes, the
//     translucent block plates -- matches the original mesh, not an approximation.
//   * makeshaft()/makepiston()/display() assembly: the crankshaft (one, down the
//     middle, spun by display_a), the V/flat/inline bank split (includedAngle),
//     the per-cylinder piston reciprocation yp[b], the connecting-rod length ln[b]
//     and tilt ang[b] from the crank-slider tables, the sequential spark firing
//     (boom) with its growing/shrinking red flame + red light.
//   * Fixed material colors (blue crank, green webs, gray pistons, red plugs,
//     white electrodes, translucent-yellow block) -- engine.c uses no colormap.
//   * make_rotator(spin?0.5:0 x3, accel 1.0, wander?0.01:0, randomize) + the
//     draw modelview: Translate(wander x*16-9,y*14-7,z*16-10), Rotate(spin) with
//     the .c's quirk that the Z rotation reuses x (glRotatef(x*360) twice), then
//     Translate(-5,0,0) to spin about the engine's center; gluPerspective(40) at
//     viewer z=30; the reshape portrait-fit scale.
//   * One positional light at (7,7,12), diffuse+specular 0.8 gray, over GL's
//     default 0.2 global ambient (materials are GL_AMBIENT_AND_DIFFUSE = color).
//
// Motion (rotator.js) and RNG (yarandom.js) are faithful standalone ports.
// PACING: render every rAF; effFps = 1e6/(delay+OVERHEAD); the crank angle
// advances ENG.speed per original-frame (ticked at effFps, interpolated for a
// smooth crank), and the rotator's discrete random walk is ticked at effFps and
// INTERPOLATED too (the dangerball.js pattern). Firing/boom is stepped once per
// original-frame in the same catch-up loop, exactly as the .c's per-frame code.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';
import { makeHudLabel } from './hud-label.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw
// glColor/material values to the framebuffer (no sRGB encoding), and the
// screenshots capture those raw values. Disable three's color management so the
// port matches; without it, lit faces render up to ~2.5x too bright.
THREE.ColorManagement.enabled = false;

export const title = 'engine';

export const info = {
  author: 'Ben Buxton',
  year: 2001,
  description:
    'Internal combusion engines.\n\n' +
    'https://en.wikipedia.org/wiki/Internal_combustion_engine#Operation',
};

// The ten real engine models, transcribed verbatim from engine.c's engines[]
// table: { cylinders, includedAngle, pistonAngle[12], speed, name }. Order and
// values are load-bearing (firing order, V/flat/inline geometry).
const ENGINES = [
  { cylinders: 3, includedAngle: 0, pistonAngle: [0, 240, 480, 0, 0, 0, 0, 0, 0, 0, 0, 0], speed: 12, name: 'Honda Insight' },
  { cylinders: 4, includedAngle: 0, pistonAngle: [0, 180, 540, 360, 0, 0, 0, 0, 0, 0, 0, 0], speed: 12, name: 'BMW M3' },
  { cylinders: 4, includedAngle: 180, pistonAngle: [0, 360, 180, 540, 0, 0, 0, 0, 0, 0, 0, 0], speed: 12, name: 'VW Beetle' },
  { cylinders: 5, includedAngle: 0, pistonAngle: [0, 576, 144, 432, 288, 0, 0, 0, 0, 0, 0, 0], speed: 12, name: 'Audi Quattro' },
  { cylinders: 6, includedAngle: 0, pistonAngle: [0, 240, 480, 120, 600, 360, 0, 0, 0, 0, 0, 0], speed: 12, name: 'BMW M5' },
  { cylinders: 6, includedAngle: 90, pistonAngle: [0, 360, 480, 120, 240, 600, 0, 0, 0, 0, 0, 0], speed: 12, name: 'Subaru XT' },
  { cylinders: 6, includedAngle: 180, pistonAngle: [0, 360, 240, 600, 480, 120, 0, 0, 0, 0, 0, 0], speed: 12, name: 'Porsche 911' },
  { cylinders: 8, includedAngle: 90, pistonAngle: [0, 450, 90, 180, 270, 360, 540, 630, 0, 0, 0, 0], speed: 15, name: 'Corvette Z06' },
  { cylinders: 10, includedAngle: 90, pistonAngle: [0, 72, 432, 504, 288, 360, 144, 216, 576, 648, 0, 0], speed: 12, name: 'Dodge Viper' },
  { cylinders: 12, includedAngle: 60, pistonAngle: [0, 300, 240, 540, 480, 60, 120, 420, 600, 180, 360, 660], speed: 12, name: 'Jaguar XKE' },
];

const HALFREV = 180;
const ONEREV = 360;
const TWOREV = 720;
const DEG = Math.PI / 180;

export function start(hostCanvas, opts = {}) {
  // us; the GL family's shared overhead default. Live GL hacks can't be timed
  // under this machine's XQuartz Apple-DRI block, so every three.js port adopts
  // the same measured 37500. xml delay 30000 -> effFps = 1e6/67500 ~= 14.8fps.
  const OVERHEAD = 37500;
  const MAX_TICKS = 8;   // per-frame catch-up cap (avoids a spiral after a stall)

  // Knobs transcribed 1:1 from hacks/engine.xml. `delay` is the frame-rate knob;
  // `engine` is the model select (xml <select>: random + the 10 models). The .xml
  // arg for wander is `--no-move` (the `move` var); `spin` is `--no-spin`.
  const config = {
    delay: 30000,       // us (xml default; invert slider)
    engine: 'random',   // 'random' or '1'..'10' (xml <option> ids)
    titles: false,      // show the engine name (xml --titles; def False)
    wander: true,       // drift through space (the `move` var; xml def True)
    spin: true,         // tumble (xml def True)
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    {
      key: 'engine', label: 'Engine', type: 'select', default: 'random', live: true,
      options: [
        { value: 'random', label: 'Random engine' },
        { value: '1', label: 'Honda Insight (3 cylinders)' },
        { value: '2', label: 'BMW M3 (4 cylinders)' },
        { value: '3', label: 'VW Beetle (4 cylinders, flat)' },
        { value: '4', label: 'Audi Quattro (5 cylinders)' },
        { value: '5', label: 'BMW M5 (6 cylinders)' },
        { value: '6', label: 'Subaru XT (6 cylinders, V)' },
        { value: '7', label: 'Porsche 911 (6 cylinders, flat)' },
        { value: '8', label: 'Corvette Z06 (8 cylinders, V)' },
        { value: '9', label: 'Dodge Viper (10 cylinders, V)' },
        { value: '10', label: 'Jaguar XKE (12 cylinders, V)' },
      ],
    },
    { key: 'titles', label: 'Show engine name', type: 'checkbox', default: false, live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'spin', label: 'Spin', type: 'checkbox', default: true, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);

  // ---- crank-slider tables (display()'s ln_init loop), indexed 0..TWOREV-1 ----
  // yp: piston height; ln: connecting-rod length; ang: rod tilt (deg, via the
  // .c's coarse asin()*57 -- kept verbatim). sin/cos of integer degrees, as the
  // .c's sin_table/cos_table.
  const sinT = new Float64Array(TWOREV);
  const cosT = new Float64Array(TWOREV);
  const yp = new Float64Array(TWOREV);
  const ln = new Float64Array(TWOREV);
  const ang = new Float64Array(TWOREV);
  for (let i = 0; i < TWOREV; i++) {
    sinT[i] = Math.sin(i * DEG);
    cosT[i] = Math.cos(i * DEG);
  }
  for (let i = 0; i < TWOREV; i++) {
    const zb = sinT[i], yb = cosT[i];
    yp[i] = yb + Math.sqrt(25 - zb * zb);
    ln[i] = Math.sqrt(zb * zb + (yb - yp[i]) * (yb - yp[i]));
    ang[i] = -(Math.asin(zb / 5) * 57);   // 57 ~= 180/PI (the .c's integer constant)
  }

  const crankWidth = 1.5;   // e->crankWidth, set in init

  // ================= geometry primitives (ported from engine.c) ==============
  // Each pushes non-indexed triangles (pos + outward normal) into a target
  // { pos:[], nor:[] }. Face culling is OFF in the .c, so materials are
  // DoubleSide and triangle winding is irrelevant (only the normal direction is,
  // for lighting). Angles sang/eang are integer degrees; sin/cos use the degree
  // tables. `outer`/`inner`/`diameter` are RADII (as in the .c).

  function segCount(outer, win) {
    // nsegs = outer*(MAX(w,h)/200), floored, then >= 40, made even (engine.c).
    let n = Math.floor(outer * Math.floor(win / 200));
    n = Math.max(n, 6);
    n = Math.max(n, 40);
    if (n % 2) n += 1;
    return n;
  }

  function pushTri(t, ax, ay, az, nax, nay, naz, bx, by, bz, nbx, nby, nbz, cx, cy, cz, ncx, ncy, ncz) {
    t.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    t.nor.push(nax, nay, naz, nbx, nby, nbz, ncx, ncy, ncz);
  }
  // A quad (v0,v1,v2,v3) with per-vertex normals n0..n3 -> two triangles.
  function pushQuad(t, v0, n0, v1, n1, v2, n2, v3, n3) {
    pushTri(t, v0[0], v0[1], v0[2], n0[0], n0[1], n0[2], v1[0], v1[1], v1[2], n1[0], n1[1], n1[2], v2[0], v2[1], v2[2], n2[0], n2[1], n2[2]);
    pushTri(t, v0[0], v0[1], v0[2], n0[0], n0[1], n0[2], v2[0], v2[1], v2[2], n2[0], n2[1], n2[2], v3[0], v3[1], v3[2], n3[0], n3[1], n3[2]);
  }

  // cylinder(): axis along +X from x to x+length; circular cross-section in the
  // Y-Z plane centered at (y,z), radius outer (and inner for a tube). endcaps:
  // 0 none, 1 left, 2 right, 3 both. Direct port of engine.c's cylinder().
  function pushCylinder(t, x, y, z, length, outer, inner, endcaps, sang, eang, win) {
    const nsegs = segCount(outer, win);
    const step = Math.floor(ONEREV / nsegs);
    const tube = (inner < outer && endcaps < 3) ? 1 : 0;
    const xl = x + length;
    const sN = (a) => sinT[((a % TWOREV) + TWOREV) % TWOREV];
    const cN = (a) => cosT[((a % TWOREV) + TWOREV) % TWOREV];

    let z1 = cN(sang) * outer + z, y1 = sN(sang) * outer + y;
    let Z1 = cN(sang) * inner + z, Y1 = sN(sang) * inner + y;
    let Z2 = z, Y2 = y;
    const y2c = {}, z2c = {};

    let b = 0;
    for (let a = sang; a <= eang || b <= eang; a += step) {
      const y2 = outer * sN(a) + y;
      const z2 = outer * cN(a) + z;
      if (endcaps) { y2c[a] = y2; z2c[a] = z2; }
      if (tube) { Y2 = inner * sN(a) + y; Z2 = inner * cN(a) + z; }

      pushQuad(t,
        [x, y1, z1], [0, y1, z1],
        [xl, y1, z1], [0, y1, z1],
        [xl, y2, z2], [0, y2, z2],
        [x, y2, z2], [0, y2, z2]);

      if (a === sang && eang - sang < ONEREV) {
        const n = [0, y2, z2];
        if (tube) pushQuad(t, [x, Y1, Z1], n, [x, y1, z1], n, [xl, y1, z1], n, [xl, Z1, Z1], n);
        else pushQuad(t, [x, y, z], n, [x, y1, z1], n, [xl, y1, z1], n, [xl, y, z], n);
      }

      if (tube) {
        if (endcaps !== 1) {
          const n = [-1, 0, 0];
          pushQuad(t, [x, y1, z1], n, [x, y2, z2], n, [x, Y2, Z2], n, [x, Y1, Z1], n);
        }
        pushQuad(t,
          [x, Y1, Z1], [0, -Y1, -Z1],
          [xl, Y1, Z1], [0, -Y1, -Z1],
          [xl, Y2, Z2], [0, -Y2, -Z2],
          [x, Y2, Z2], [0, -Y2, -Z2]);
        if (endcaps !== 2) {
          const n = [1, 0, 0];
          pushQuad(t, [xl, y1, z1], n, [xl, y2, z2], n, [xl, Y2, Z2], n, [xl, Y1, Z1], n);
        }
      }

      z1 = z2; y1 = y2; Z1 = Z2; Y1 = Y2;
      b = a;
    }

    if (eang - sang < ONEREV) {
      const v1 = [x, y, z], v2 = [x, y1, z1], v3 = [xl, y1, z1];
      const ex1 = v2[0] - v1[0], ey1 = v2[1] - v1[1], ez1 = v2[2] - v1[2];
      const ex2 = v3[0] - v1[0], ey2 = v3[1] - v1[1], ez2 = v3[2] - v1[2];
      const n = [ey2 * ez1 - ez2 * ey1, ez2 * ex1 - ex2 * ez1, ex2 * ey1 - ey2 * ex1];
      pushQuad(t, [x, y, z], n, [x, y1, z1], n, [xl, y1, z1], n, [xl, y, z], n);
    }

    if (endcaps) {
      let end, start, norm;
      if (tube) {
        if (endcaps === 1) { end = 0; start = 0; }
        else if (endcaps === 2) { start = end = length + 0.01; }
        else { end = length + 0.02; start = -0.01; }
        norm = 1;
      } else {
        end = length; start = 0; norm = -1;
      }
      for (let ex = start; ex <= end; ex += length) {
        let fy1 = y + sN(sang) * outer;
        let fz1 = outer * cN(sang) + z;
        let fb = 0;
        for (let a = sang; a <= eang || fb <= eang; a += step) {
          const yy = (y2c[a] !== undefined) ? y2c[a] : (outer * sN(a) + y);
          const zz = (z2c[a] !== undefined) ? z2c[a] : (outer * cN(a) + z);
          pushTri(t, x + ex, y, z, norm, 0, 0, x + ex, fy1, fz1, norm, 0, 0, x + ex, yy, zz, norm, 0, 0);
          fy1 = yy; fz1 = zz; fb = a;
        }
        if (!tube) norm = 1;
        if (length === 0) break;
      }
    }
  }

  function pushRod(t, x, y, z, length, diameter, win) {
    pushCylinder(t, x, y, z, length, diameter, diameter, 3, 0, ONEREV, win);
  }

  // Rect(): a box from (x,y,z) to (x+w, y+h, z-t), six faces (engine.c's Rect()).
  function pushRect(t, x, y, z, w, h, tt) {
    const yh = y + h, xw = x + w, zt = z - tt;
    pushQuad(t, [x, y, z], [0, 0, 1], [x, yh, z], [0, 0, 1], [xw, yh, z], [0, 0, 1], [xw, y, z], [0, 0, 1]);
    pushQuad(t, [x, y, zt], [0, 0, -1], [x, yh, zt], [0, 0, -1], [xw, yh, zt], [0, 0, -1], [xw, y, zt], [0, 0, -1]);
    pushQuad(t, [x, yh, z], [0, 1, 0], [x, yh, zt], [0, 1, 0], [xw, yh, zt], [0, 1, 0], [xw, yh, z], [0, 1, 0]);
    pushQuad(t, [x, y, z], [0, -1, 0], [x, y, zt], [0, -1, 0], [xw, y, zt], [0, -1, 0], [xw, y, z], [0, -1, 0]);
    pushQuad(t, [x, y, z], [-1, 0, 0], [x, y, zt], [-1, 0, 0], [x, yh, zt], [-1, 0, 0], [x, yh, z], [-1, 0, 0]);
    pushQuad(t, [xw, y, z], [1, 0, 0], [xw, y, zt], [1, 0, 0], [xw, yh, zt], [1, 0, 0], [xw, yh, z], [1, 0, 0]);
  }

  function pushCrankBit(t, x, win) {
    pushRect(t, x, -1.4, 0.5, 0.2, 1.8, 1);
    // The arc lobe shares the Rect's exact x-span and overlaps it in y-z, so the arc's
    // end-cap FAN lands COPLANAR with the green Rect face. Both are the same green material,
    // so no depth trick separates them (polygonOffset applies equally; the faces aren't even
    // exactly coplanar -- two triangulations of one plane -> sub-pixel depth jitter -> a
    // per-pixel toss-up that shimmers, worsened by DoubleSide showing the fan's back-normal as
    // a different green shade). Nudge the arc +0.03 in x: its fan is now cleanly INSIDE the
    // 0.2-thick plate where they overlap (occluded -> the Rect wins, as GL_LESS does in the .c),
    // and only shows where the lobe protrudes past the plate. 0.03 on a 0.2 web is sub-visible.
    pushCylinder(t, x + 0.03, -0.5, 0, 0.2, 2, 2, 1, 60, 120, win);
  }

  // Bake a rotation about X (degrees) into a triangle set's positions + normals,
  // appending into `dst` (the .c rotates the modelview, then draws into the list).
  function bakeRotX(src, deg, dst) {
    const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
    const p = src.pos, n = src.nor;
    for (let i = 0; i < p.length; i += 3) {
      const y = p[i + 1], z = p[i + 2];
      dst.pos.push(p[i], c * y - s * z, s * y + c * z);
      const ny = n[i + 1], nz = n[i + 2];
      dst.nor.push(n[i], c * ny - s * nz, s * ny + c * nz);
    }
  }

  function makeGeom(t) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(t.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(t.nor, 3));
    g.computeBoundingSphere();
    return g;
  }

  // ---- materials (engine.c's fixed material colors; GL_AMBIENT_AND_DIFFUSE) ----
  // Only the piston has an explicit specular (gray, shininess 20) in the .c; the
  // rest are matte Lambert. specular /PI compensates three's PI light (the
  // superquadrics/dangerball convention). DoubleSide (culling is off in the .c).
  const mkMat = (r, g, b, o = {}) => new THREE.MeshPhongMaterial({
    color: new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace),
    specular: o.spec != null
      ? new THREE.Color().setRGB(o.spec / Math.PI, o.spec / Math.PI, o.spec / Math.PI, THREE.SRGBColorSpace)
      : new THREE.Color(0, 0, 0),
    shininess: o.shin || 0,
    side: THREE.DoubleSide,
    transparent: o.alpha != null,
    opacity: o.alpha != null ? o.alpha : 1,
    depthWrite: o.alpha == null,
    // engine.c uses GL_LESS (the glDepthFunc default): coincident coplanar faces resolve
    // DETERMINISTICALLY (first-drawn wins), they never tie -- which is why the .c doesn't
    // shimmer. three defaults to LessEqualDepth, where coincident faces TIE -> a per-pixel
    // depth-test toss-up -> shimmer. The worst case is the CrankBit cam: a green Rect face
    // coplanar with the green arc end-cap fan -- both green, so polygonOffset (same material,
    // same bias) can't separate them. Matching GL_LESS on the opaque parts makes the tie
    // deterministic (the Rect, drawn first, wins) -> no speckle, no shimmer. The translucent
    // block keeps LessEqual so three's transparent-sort path is undisturbed.
    depthFunc: o.alpha == null ? THREE.LessDepth : THREE.LessEqualDepth,
  });
  const matBlue = mkMat(0, 0, 1);
  const matGreen = mkMat(0, 1, 0);
  // Z-FIGHT FIX. The crankshaft is built from abutting primitives (engine.c), so
  // blue crank pins/journals AND the blue connecting-rod big-ends are COPLANAR /
  // coincident with the green crank-web (CrankBit) faces they butt against. The .c
  // hides this with GL_LESS + a blue-before-green draw order (blue wins ties); our
  // separate meshes under three's LEQUAL depth instead speckle at ~1-ULP ties and
  // flicker as the crank spins (worsened by DoubleSide back-faces). We resolve
  // every blue/green tie by biasing the two colors APART in depth: the green webs a
  // hair TOWARD the camera, the blue crankshaft/rods a hair AWAY, so green
  // deterministically wins with a ~2-unit margin -> clean solid webs, no blue bleed,
  // view-/order-independent. (Only a green offset was tried first; it fixed the web
  // bulk but a residual persisted on a cam-end triangle where the connecting rod --
  // in a DIFFERENT transform group, so a larger numerical depth mismatch -- still
  // tied; the opposing blue offset covers that.) Sub-pixel: only affects genuinely
  // coincident faces. NOTE the two green faces inside a CrankBit (arc end-cap fan vs
  // the Rect face) are coincident too, but share a normal + color, so their tie is
  // invisible and needs no fix.
  matGreen.polygonOffset = true;
  matGreen.polygonOffsetFactor = -1;
  matGreen.polygonOffsetUnits = -1;
  matBlue.polygonOffset = true;
  matBlue.polygonOffsetFactor = 1;
  matBlue.polygonOffsetUnits = 1;
  const matRed = mkMat(1, 0, 0);
  const matWhite = mkMat(1, 1, 1);
  const matPistonBody = mkMat(0.6, 0.6, 0.6, { spec: 0.6, shin: 20 });
  const matPistonRing = mkMat(0.2, 0.2, 0.2, { spec: 0.6, shin: 20 });
  const matYellow = mkMat(1, 1, 0, { alpha: 0.4 });
  const matBoom = mkMat(1, 0, 0, { alpha: 0.9 });
  const disposableMats = [matBlue, matGreen, matRed, matWhite, matPistonBody, matPistonRing, matYellow, matBoom];

  // ---- scene ----
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  const parent = hostCanvas.parentNode || document.body;
  parent.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // reshape_engine: gluPerspective(40, 1/h, 1.5, 70); viewer at z=30 looking at
  // origin, up +y.
  const camera = new THREE.PerspectiveCamera(40, 1, 1.5, 70);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // LIGHT0: positional at (7,7,12), diffuse+specular 0.8 gray. No distance
  // attenuation (GL default) -> PointLight decay 0. Kept in world space (fixed
  // while the engine tumbles): the .c sets the light after gluLookAt, a pure
  // z-translate here, so world == the given coords.
  const light = new THREE.PointLight(0xffffff, 0.8 * Math.PI, 0, 0);
  light.position.set(7, 7, 12);
  scene.add(light);
  // GL's default global ambient 0.2 * material color.
  scene.add(new THREE.AmbientLight(0xffffff, 0.2 * Math.PI));

  // The firing flash's red light (LIGHT1), reparented onto the firing cylinder's
  // plug frame; intensity 0 when idle (kept in the graph so the light count, and
  // thus the compiled shaders, never change).
  const boomLight = new THREE.PointLight(0xff0000, 0, 12, 1.3);
  scene.add(boomLight);

  // modelview nesting (display()):
  //   outer  : Scale(portraitFit)     (reshape's glScalef)
  //   trans  : Translate(wander)
  //   rotG   : Rotate(spin)
  //   center : Translate(-5,0,0)       (spin about the engine center)
  //      crankGroup : Rotate(display_a, X) -> crankshaft mesh
  //      banksGroup : the bank(s) with pistons/plugs/rods/block/boom
  const outer = new THREE.Group();
  const trans = new THREE.Group();
  const rotG = new THREE.Group();
  const center = new THREE.Group();
  center.position.set(-5, 0, 0);
  rotG.add(center); trans.add(rotG); outer.add(trans); scene.add(outer);

  // ---- rotator (init_engine: make_rotator BEFORE find_engine) ----
  let rot, prevR, curR, prevP, curP, rotAccum = 0;
  let builtSpin = null, builtWander = null;
  function buildRotator() {
    rot = makeRotator(
      {
        spinX: config.spin ? 0.5 : 0,
        spinY: config.spin ? 0.5 : 0,
        spinZ: config.spin ? 0.5 : 0,
        spinAccel: 1.0,
        wanderSpeed: config.wander ? 0.01 : 0,
        randomize: true,
      },
      rng,
    );
    const r0 = rot.getRotation(false), p0 = rot.getPosition(false);
    prevR = { ...r0 }; curR = { ...r0 }; prevP = { ...p0 }; curP = { ...p0 }; rotAccum = 0;
    builtSpin = config.spin; builtWander = config.wander;
  }
  function tickRotator() {
    prevR = curR; curR = rot.getRotation(true);
    prevP = curP; curP = rot.getPosition(true);
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpAngle = (a, b, t) => { let d = b - a; if (d > 0.5) d -= 1; else if (d < -0.5) d += 1; return a + d * t; };

  // ---- engine model state + built meshes ----
  let ENG = null;
  let crankOffset = 3.3;
  let engineName = '';
  let builtEngine = null;
  let crankGroup = null, banksGroup = null;
  let pistonInstances = [];        // { group, j, half }
  let rodInstances = [];           // { mesh, j, half }
  let bankPlugAsms = [];           // plugAssembly group per bank (holds boom mesh+light)
  const built = { geoms: [] };
  const M = new THREE.Matrix4(), Mt = new THREE.Matrix4();
  let unitRodGeom = null;          // unit rod (X axis, len 1, r 0.2, capped), shared

  // firing (boom) state -- a single flash at a time, as the .c.
  let boomTime = 0, boomD = 0, boomWd = 0, boomRedR = 0, boomRedG = 0, lastPlug = 0;
  let boomMesh = null;

  function pickEngineIndex() {
    if (config.engine === 'random' || config.engine == null) return rng.random() % ENGINES.length;
    const idx = parseInt(config.engine, 10) - 1;
    return (idx >= 0 && idx < ENGINES.length) ? idx : (rng.random() % ENGINES.length);
  }

  function disposeBuilt() {
    if (crankGroup) center.remove(crankGroup);
    if (banksGroup) center.remove(banksGroup);
    if (boomMesh && boomMesh.parent) boomMesh.parent.remove(boomMesh);
    for (const g of built.geoms) g.dispose();
    built.geoms = [];
    crankGroup = banksGroup = boomMesh = null;
    pistonInstances = []; rodInstances = []; bankPlugAsms = [];
    boomTime = 0; lastPlug = 0; boomLight.intensity = 0;
    // Keep the boom light in the graph (it may have detached with banksGroup) so
    // the scene's light count -- and thus the compiled shaders -- stays constant.
    scene.add(boomLight);
  }

  function buildEngine() {
    disposeBuilt();
    const win = Math.max(canvas.width, canvas.height) || 1000;
    ENG = ENGINES[pickEngineIndex()];
    crankOffset = (ENG.includedAngle !== 0) ? 3.3 / 2 : 3.3;
    const sides = (ENG.includedAngle === 0) ? 1 : 2;

    // engine_name: "%s\n%s%d%s" (name, V/Flat/'', cylinders, ' Cylinder'/'').
    const pre = ENG.includedAngle === 0 ? '' : ENG.includedAngle === 180 ? 'Flat ' : 'V';
    const suf = ENG.includedAngle === 0 ? ' Cylinder' : '';
    engineName = ENG.name + '\n' + pre + ENG.cylinders + suf;

    if (!unitRodGeom) {
      const t = { pos: [], nor: [] };
      pushRod(t, 0, 0, 0, 1, 0.2, win);
      unitRodGeom = makeGeom(t);   // long-lived; not in built.geoms
    }

    // ===== crankshaft (makeshaft): blue journals/flywheel/pins + green webs =====
    const blueT = { pos: [], nor: [] };
    const greenT = { pos: [], nor: [] };
    const crankThick = 0.2, crankDiam = 0.3;
    pushCylinder(blueT, -2.5, 0, 0, 1, 3, 2.5, 0, 0, ONEREV, win);   // flywheel rim (tube)
    // Z-FIGHT FIX (blue-on-blue flywheel spokes). A tube with endcaps=0 still gets
    // +/-x annular END-RING faces; the rim's +x ring sits at x=-1.5. The two spoke
    // Rects span x=[-2,-1.5], so each spoke's +x face was COPLANAR with that ring,
    // overlapping in the band r=[2.5,2.8] at the 4 spoke/rim junctions. It's the SAME
    // blue material (matBlue), so polygonOffset can't separate them (shared bias); and
    // the two faces are triangulated differently (the rim's circular per-segment quads
    // vs the spoke's 2-triangle rectangle), so they aren't bit-coplanar -> sub-ULP
    // depth jitter -> a per-pixel toss-up that speckles at the junctions (seen from the
    // +x/engine side, including through the translucent block). GL_LESS (LessDepth)
    // resolves only EXACT ties, not this ~coplanar case, so a GEOMETRIC change is
    // needed. Fix: recess each spoke's +x face 0.03 behind the rim ring (x-extent
    // 0.5 -> 0.47, +x face -1.5 -> -1.53) so the rim ring cleanly OCCLUDES it in the
    // overlap band -> deterministic, no speckle. 0.03 on a 0.5 spoke at r=3 is sub-
    // visible; only the +x face moves (x stays -2). The -x side is already clean: the
    // rim's -x ring at x=-2.5 sits 0.5 in front of the spokes' -x faces at x=-2. Same
    // KIND of sub-visible nudge as pushCrankBit's green-cam +0.03.
    pushRect(blueT, -2, -0.3, 2.8, 0.47, 0.6, 5.6);
    pushRect(blueT, -2, -2.8, 0.3, 0.47, 5.6, 0.6);
    pushRod(blueT, -2, 0, 0, 2, crankDiam, win);                     // first shaft bit
    let jj = 0;
    for (jj = 0; jj < ENG.cylinders - 1; jj++) {
      pushRod(blueT, crankWidth - crankThick + crankOffset * jj, 0, 0, crankOffset - crankWidth + 2 * crankThick, crankDiam, win);
    }
    pushRod(blueT, crankWidth - crankThick + crankOffset * jj, 0, 0, 0.9, crankDiam, win);
    for (let j = 0; j < ENG.cylinders; j++) {
      const rotDeg = (j & 1)
        ? HALFREV + ENG.pistonAngle[j] + ENG.includedAngle
        : HALFREV + ENG.pistonAngle[j];
      const pin = { pos: [], nor: [] };
      pushRod(pin, crankOffset * j, -1.0, 0.0, crankWidth, crankDiam, win);
      bakeRotX(pin, rotDeg, blueT);
      const web = { pos: [], nor: [] };
      pushCrankBit(web, crankOffset * j, win);
      pushCrankBit(web, crankWidth - crankThick + crankOffset * j, win);
      bakeRotX(web, rotDeg, greenT);
    }
    const crankBlue = new THREE.Mesh(makeGeom(blueT), matBlue);
    const crankGreen = new THREE.Mesh(makeGeom(greenT), matGreen);
    built.geoms.push(crankBlue.geometry, crankGreen.geometry);
    crankGroup = new THREE.Group();
    crankGroup.add(crankBlue, crankGreen);
    center.add(crankGroup);

    // ===== piston template (makepiston): body (gray) + 2 rings (dark) ==========
    const bodyT = { pos: [], nor: [] };
    pushCylinder(bodyT, 0, 0, 0, 2, 1, 0.7, 2, 0, ONEREV, win);   // hollow body, right cap
    const ringT = { pos: [], nor: [] };
    pushCylinder(ringT, 1.6, 0, 0, 0.1, 1.05, 1.05, 0, 0, ONEREV, win);
    pushCylinder(ringT, 1.8, 0, 0, 0.1, 1.05, 1.05, 0, 0, ONEREV, win);
    const pistonBodyGeom = makeGeom(bodyT);
    const pistonRingGeom = makeGeom(ringT);
    built.geoms.push(pistonBodyGeom, pistonRingGeom);

    // ===== banks: pistons, plugs, electrodes, rods, block =======================
    banksGroup = new THREE.Group();
    center.add(banksGroup);

    for (let half = 0; half < sides; half++) {
      const bank = new THREE.Group();
      bank.rotation.x = half * ENG.includedAngle * DEG;   // the V/flat bank angle
      banksGroup.add(bank);

      for (let j = 0; j < ENG.cylinders; j += sides) {
        const grp = new THREE.Group();
        grp.rotation.z = Math.PI / 2;                     // piston_list's glRotatef(90,0,0,1)
        grp.position.set(crankWidth / 2 + crankOffset * (j + half), 6, 0);
        grp.add(new THREE.Mesh(pistonBodyGeom, matPistonBody));
        grp.add(new THREE.Mesh(pistonRingGeom, matPistonRing));
        bank.add(grp);
        pistonInstances.push({ group: grp, j, half });
      }

      // plugAssembly: everything under the spark-plug frame (glRotatef(90,0,0,1)).
      const plugAsm = new THREE.Group();
      plugAsm.rotation.z = Math.PI / 2;
      bank.add(plugAsm);
      bankPlugAsms.push(plugAsm);

      const plugT = { pos: [], nor: [] };
      const elecT = { pos: [], nor: [] };
      for (let j = 0; j < ENG.cylinders; j += sides) {
        pushCylinder(plugT, 8.5, -crankWidth / 2 - crankOffset * (j + half), 0, 0.5, 0.4, 0.3, 1, 0, ONEREV, win);
        pushRod(elecT, 8, -crankWidth / 2 - crankOffset * (j + half), 0, 0.5, 0.2, win);
        pushRod(elecT, 9, -crankWidth / 2 - crankOffset * (j + half), 0, 1, 0.15, win);
      }
      const plugMesh = new THREE.Mesh(makeGeom(plugT), matRed);
      const elecMesh = new THREE.Mesh(makeGeom(elecT), matWhite);
      built.geoms.push(plugMesh.geometry, elecMesh.geometry);
      plugAsm.add(plugMesh, elecMesh);

      for (let j = 0; j < ENG.cylinders; j += sides) {
        const m = new THREE.Mesh(unitRodGeom, matBlue);
        m.matrixAutoUpdate = false;
        plugAsm.add(m);
        rodInstances.push({ mesh: m, j, half });
      }

      // engine block (translucent yellow Rects) -- NOT under the 90z frame.
      const rightSide = (sides > 1) ? 0 : 1.6;
      const blockT = { pos: [], nor: [] };
      pushRect(blockT, -crankWidth / 2, -0.5, 1, 0.2, 9, 2);
      pushRect(blockT, 0.3 + crankOffset * ENG.cylinders - rightSide, -0.5, 1, 0.2, 9, 2);
      pushRect(blockT, -crankWidth / 2 + 0.2, 8.3, 1, crankWidth / 2 + 0.1 + crankOffset * ENG.cylinders - rightSide, 0.2, 2);
      pushRect(blockT, -crankWidth / 2 + 0.2, 3, 1, crankWidth / 2 + 0.1 + crankOffset * ENG.cylinders - rightSide, 0.2, 0.2);
      pushRect(blockT, -crankWidth / 2 + 0.2, 3, -1 + 0.2, crankWidth / 2 + 0.1 + crankOffset * ENG.cylinders - rightSide, 0.2, 0.2);
      for (let j = 0; j < ENG.cylinders - (sides === 1 ? 1 : 0); j += sides) {
        pushRect(blockT, 0.4 + crankWidth + crankOffset * (j - half), 3, 1, 1, 5.3, 2);
      }
      const blockMesh = new THREE.Mesh(makeGeom(blockT), matYellow);
      blockMesh.renderOrder = 1;   // draw after the opaque parts
      built.geoms.push(blockMesh.geometry);
      bank.add(blockMesh);
    }

    // boom flame: a shared unit rod, red translucent, hidden until firing.
    boomMesh = new THREE.Mesh(unitRodGeom, matBoom);
    boomMesh.matrixAutoUpdate = false;
    boomMesh.visible = false;
    boomMesh.renderOrder = 2;
    bankPlugAsms[0].add(boomMesh);

    builtEngine = config.engine;
    updateTitle();
  }

  // ---- HUD engine-name label (print_texture_label, position 1 = top-left) ----
  const hud = makeHudLabel(parent, { color: 'rgb(255,255,0)', corner: 'tl' });
  let builtTitles = false;
  function updateTitle() { hud.setText(config.titles ? engineName : ''); builtTitles = config.titles; }

  buildRotator();   // init_engine: make_rotator ...
  buildEngine();    // ... then find_engine + build the meshes

  // ================= crank + firing (per original-frame) =====================
  let crankInt = 0;     // integer crank angle (== .c display_a); drives firing
  let displayA = 0;     // smooth visual crank angle (interpolated)

  // boom(): the growing/shrinking red flame + red light, ported from engine.c.
  function boom(j, s) {
    const flameOut = Math.floor(720 / ENG.speed / ENG.cylinders);
    if (boomTime === 0 && s) {
      boomRedR = 0; boomRedG = 0; boomD = 0.05; boomTime++;
    } else if (boomTime === 0 && !s) {
      return;
    } else if (boomTime >= 8 && boomTime < flameOut && !s) {
      boomTime++; boomRedR -= 0.2; boomRedG -= 0.1; boomD -= 0.04;
    } else if (boomTime >= flameOut) {
      boomTime = 0; boomLight.intensity = 0; if (boomMesh) boomMesh.visible = false; return;
    } else {
      boomRedR += 0.2; boomRedG += 0.1; boomD += 0.04; boomTime++;
    }
    boomWd = boomD * 3; if (boomWd > 0.7) boomWd = 0.7;

    const r = Math.max(0, Math.min(1, boomRedR));
    const g = Math.max(0, Math.min(1, boomRedG));
    const half = (ENG.includedAngle !== 0 && (j & 1)) ? 1 : 0;
    const plugAsm = bankPlugAsms[half] || bankPlugAsms[0];
    // three's add() re-parents safely (removes from the prior parent, if any).
    if (boomMesh && boomMesh.parent !== plugAsm) plugAsm.add(boomMesh);
    if (boomLight.parent !== plugAsm) plugAsm.add(boomLight);

    const yb = -crankWidth / 2 - crankOffset * j;
    // rod(8, yb, 0, boom_d, boom_wd): unit rod (len 1, r 0.2) -> len boom_d, r boom_wd.
    M.makeTranslation(8, yb, 0);
    M.multiply(Mt.makeScale(Math.max(boomD, 0.0001), boomWd / 0.2, boomWd / 0.2));
    boomMesh.matrix.copy(M);
    boomMesh.visible = boomD > 0.001;
    matBoom.color.setRGB(r, g, 0, THREE.SRGBColorSpace);

    // light at (x-boom_d, yb, 0) in the plug frame; intensity from boom_red.
    boomLight.position.set(8 - boomD, yb, 0);
    boomLight.color.setRGB(r, g, 0, THREE.SRGBColorSpace);
    boomLight.intensity = r * 6;
  }

  // One original-frame of the crank + firing, mirroring display()'s per-frame code.
  function originalFrame() {
    crankInt = (crankInt + ENG.speed) % TWOREV;
    for (let j = 0; j < ENG.cylinders; j++) {
      if (((crankInt + ENG.pistonAngle[j]) % TWOREV) === 0) { boom(j, 1); lastPlug = j; }
    }
    // the .c always runs this after the loop (j==cylinders != lastPlug): decay.
    boom(lastPlug, 0);
  }

  // ---- per-frame transform updates (piston reciprocation + rod swing) ----
  function updateMechanism() {
    crankGroup.rotation.x = displayA * DEG;
    const ai = ((Math.floor(displayA) % TWOREV) + TWOREV) % TWOREV;
    for (const pi of pistonInstances) {
      const b = (ai + ENG.pistonAngle[pi.j + pi.half]) % ONEREV;
      pi.group.position.y = yp[b] - 0.3;
    }
    for (const ri of rodInstances) {
      const b = (ai + HALFREV + ENG.pistonAngle[ri.j + ri.half]) % TWOREV;
      const yb = -crankWidth / 2 - crankOffset * (ri.j + ri.half);
      M.makeRotationY(ang[b] * DEG);                       // glRotatef(ang[b],0,1,0)
      M.multiply(Mt.makeTranslation(-cosT[b], yb, -sinT[b]));
      M.multiply(Mt.makeScale(ln[b], 1, 1));               // rod(...,ln[b],0.2)
      ri.mesh.matrix.copy(M);
    }
  }

  // ---- sizing (reshape_engine: gluPerspective + the portrait-fit scale) ----
  let portraitFit = 1;
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    portraitFit = w < h ? w / h : 1;   // display()'s glScalef(s,s,s)
    hud.resize();
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop ----
  let raf = 0, last = 0, paused = false, ms = 16;
  let crankAccum = 0;   // fractional original-frames pending for the crank/firing tick
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    // live structural changes
    if (config.engine !== builtEngine) buildEngine();
    if (config.titles !== builtTitles) updateTitle();
    if (config.spin !== builtSpin || config.wander !== builtWander) buildRotator();

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;

    // crank + firing: step whole original-frames (catch-up capped), interpolate
    // the visual crank angle between integer ticks for smoothness.
    crankAccum += frames;
    let ticks = 0;
    while (crankAccum >= 1 && ticks < MAX_TICKS) { originalFrame(); tickRotator(); crankAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) crankAccum = 0;
    rotAccum = crankAccum;
    displayA = (crankInt + crankAccum * ENG.speed) % TWOREV;
    updateMechanism();

    const a = rotAccum;
    outer.scale.setScalar(portraitFit);
    if (config.wander) {
      trans.position.set(
        lerp(prevP.x, curP.x, a) * 16 - 9,
        lerp(prevP.y, curP.y, a) * 14 - 7,
        lerp(prevP.z, curP.z, a) * 16 - 10,
      );
    } else trans.position.set(0, 0, 0);
    if (config.spin) {
      const rx = lerpAngle(prevR.x, curR.x, a) * 2 * Math.PI;
      const ry = lerpAngle(prevR.y, curR.y, a) * 2 * Math.PI;
      rotG.rotation.set(rx, ry, rx, 'XYZ');   // the .c reuses x for the Z rotation
    } else rotG.rotation.set(0, 0, 0);

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      disposeBuilt();
      if (unitRodGeom) unitRodGeom.dispose();
      for (const m of disposableMats) m.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
      hud.dispose();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() {                    // host 're-seed': a fresh random engine
      config.engine = 'random';
      builtEngine = null;          // force a rebuild next frame
    },
    config,
    params,
  };
}

export default { title, info, start };
