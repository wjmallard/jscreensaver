// extrusion.js -- "Extrusion" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's extrusion (Linas Vepstas, David Konerding,
// Jamie Zawinski; 1999), hacks/glx/extrusion.c + the seven per-shape files
// hacks/glx/extrusion-{helix2,helix3,helix4,joinoffset,screw,taper,twistoid}.c.
// "Various extruded shapes twist and turn inside out." One of 7 named shapes (or
// RANDOM) sweeps a 2D contour along a 3D path -- with per-point twist/scale -- into
// an extruded solid that spins (rotator) while its shape parameters slowly wander
// (the same rotator's "position" output drives lastx/lasty, which the .c feeds into
// each shape's geometry -> the continuous "turn inside out" morph).
//
// THE CRUX: the shapes are drawn by the GLE ("OpenGL Tubing & Extrusion") library,
// which xscreensaver LINKS at build time and does NOT vendor. This module replicates
// the exact GLE sweep semantics for the calls each shape makes, transcribed from the
// GLE-3 source (linas/glextrusion, src/extrude.c / ex_angle.c / ex_raw.c / view.c):
//
//   * gleExtrusion / gleSuperExtrusion (ex_angle.c: extrusion_angle_join) -- sweep a
//     2D `contour` along a 3D polyline. One contour ring per path point, mitered into
//     the bisecting plane at each joint (normal = normalize(dir_in + dir_out)); the
//     contour's local frame is a rotation-minimizing (parallel-transport) frame seeded
//     by the `up` vector (GLE reflects `up` across each bisecting plane == the same
//     twist-free frame). Local basis: Tn = miter normal (travel dir), Y = transported
//     up, X = Tn x Y; contour (cx,cy) -> P + cx*X + cy*Y. This is glknots' swept 6-gon
//     tube GENERALIZED to an arbitrary 2D contour with a per-point 2x3 affine xform.
//   * gleTwistExtrusion -- per-point contour rotation R(twist[j] deg) as the affine.
//   * gleScrew -- straight Z path (numsegs = |twist/18|+4), uniform twist -> a twisted
//     prism.
//   * gleHelicoid (helix2/3/4) -- super_helix() builds a 20-gon circle contour of
//     radius rToroid, up=(1,0,0), then gleSpiral sweeps it along a helix: npoints =
//     (20/360)*|sweep| + 4; the path winds around Z in the XY plane, radius & z
//     accumulate per-REVOLUTION (dr,dz per 2pi), sweep/startTheta in DEGREES; helix4
//     adds a matrix-exponential affine accumulation (a rotating elliptical section).
//   * Join style TUBE_JN_ANGLE (all shapes) mitered as above; joinoffset also draws a
//     second TUBE_JN_RAW copy (square-cut, capped, gapped prisms). TUBE_NORM_FACET =
//     flat per-contour-edge normals (screw/taper/twistoid); TUBE_NORM_EDGE/PATH_EDGE =
//     smooth per-contour-vertex normals (helices, joinoffset). TUBE_JN_CAP fills the
//     first & last rings; TUBE_CONTOUR_CLOSED wraps the contour (all but twistoid).
//
// Lighting (SetupLight + draw_extrusion): two directional lights -- LIGHT0 yellow
// (0.99,0.99,0) from (40,40,100), LIGHT1 cyan (0,0.99,0.99) from (-40,40,100); the
// material is GL_AMBIENT_AND_DIFFUSE, with COLOR_MATERIAL tracking DIFFUSE from each
// shape's glColor (ambient stays (0.6,0.6,0.4)); NO specular (commented out in the .c);
// GL_SMOOTH (Gouraud) + LIGHT_MODEL_TWO_SIDE + no cull. So: MeshLambertMaterial (Gouraud,
// no specular) with emissive = 0.2*(0.6,0.6,0.4) ambient floor, per-vertex diffuse color,
// DoubleSide. Flat coloring (--no-light) -> unlit MeshBasicMaterial. See extrusion.md.
//
// Motion (rotator.js) + RNG (yarandom.js) are faithful standalone ports. PACING: render
// every rAF; effFps = 1e6/(delay+OVERHEAD); spin + shape-morph advance by dt*effFps; the
// discrete rotator is ticked at effFps and INTERPOLATED (the glknots/dangerball pattern).

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';

// xscreensaver's GL fixed pipeline does NO color management -- raw glColor to the
// framebuffer, no sRGB encoding. Disable three's color management to match (else lit
// faces render up to ~2.5x too bright). Module scope, before any color is built.
THREE.ColorManagement.enabled = false;

export const title = 'extrusion';

export const info = {
  author: 'Linas Vepstas',
  year: 1999,
  description: 'Various extruded shapes twist and turn inside out.',
};

export function start(hostCanvas, opts = {}) {
  const OVERHEAD = 37500;        // us; GL-family shared default (xml delay 20000 -> ~17fps)
  const TESS = 20;               // GLE _POLYCYL_TESS: the default tessellation "slices"
  const DEG = Math.PI / 180;
  const MINL = -400, MAXL = 400, LSPAN = MAXL - MINL;   // lastx/lasty range (max/min_last[xy])
  const MAX_TICKS = 8;           // rotator catch-up cap

  // geometry preallocation. helix3 is the worst case: sweep = 6*lastx up to 2400 deg
  // -> npoints = (20/360)*2400 + 4 ~= 137 rings, ncp = 20.
  const MAX_NP = 160, MAX_NCP = 24;
  const MAXV = 50000;            // vertex budget (segments*edges*2*3 + caps, incl 2 copies)

  // xml <select id="mode"> ids. 'twist' (label Twistoid) maps to the internal name.
  const SHAPE_OF = {
    helix2: 'helix2', helix3: 'helix3', helix4: 'helix4', joinoffset: 'joinoffset',
    screw: 'screw', taper: 'taper', twist: 'twistoid',
  };
  const SHAPE_LIST = ['helix2', 'helix3', 'helix4', 'joinoffset', 'screw', 'taper', 'twistoid'];

  // Knobs transcribed 1:1 from hacks/extrusion.xml.
  const config = {
    delay: 20000,        // us (xml default; invert slider)
    mode: 'random',      // object (xml <select id="mode">; random + 7 shapes)
    render: 'light',     // flat vs lighting (xml <select id="render">; --no-light == flat)
    wire: false,         // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    {
      key: 'mode', label: 'Object', type: 'select', default: 'random', live: true,
      options: [
        { value: 'random', label: 'Random object' },
        { value: 'helix2', label: 'Helix 2' },
        { value: 'helix3', label: 'Helix 3' },
        { value: 'helix4', label: 'Helix 4' },
        { value: 'joinoffset', label: 'Join offset' },
        { value: 'screw', label: 'Screw' },
        { value: 'taper', label: 'Taper' },
        { value: 'twist', label: 'Twistoid' },
      ],
    },
    {
      key: 'render', label: 'Render', type: 'select', default: 'light', live: true,
      options: [
        { value: 'flat', label: 'Use flat coloring' },
        { value: 'light', label: 'Use lighting' },
      ],
    },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);

  // ===================================================================
  //  static contours (built once; scaled/placed per frame)
  // ===================================================================
  // GLE circle contour (setup_circle): 20 unit points (cos,sin); the helicoid scales
  // it by rToroid and passes the unit points as smooth radial normals.
  const UNIT_CIRCLE = [];
  for (let i = 0; i < TESS; i++) {
    const a = (2 * Math.PI * i) / TESS;
    UNIT_CIRCLE.push([Math.cos(a), Math.sin(a)]);
  }

  // gear-cross ("texas shape") contour, shared by screw (SCALE 1.3) and taper (3.33333).
  // extrusion-screw.c / -taper.c init_contour(): 20 points + a repeat to close; the
  // CONTOUR macro's facet normal for edge j is (ay,-ax) of the *unit* edge j->j+1.
  const GEAR_RAW = [
    [1, 1], [1, 2.9], [0.9, 3], [-0.9, 3], [-1, 2.9],
    [-1, 1], [-2.9, 1], [-3, 0.9], [-3, -0.9], [-2.9, -1],
    [-1, -1], [-1, -2.9], [-0.9, -3], [0.9, -3], [1, -2.9],
    [1, -1], [2.9, -1], [3, -0.9], [3, 0.9], [2.9, 1],
    [1, 1],   // repeat so the last (closing) normal is computed
  ];
  function gearContour(scale) {
    const contour = [], cnorm = [];
    for (let i = 0; i < 20; i++) contour.push([scale * GEAR_RAW[i][0], scale * GEAR_RAW[i][1]]);
    for (let i = 0; i < 20; i++) {
      const ax = scale * (GEAR_RAW[i + 1][0] - GEAR_RAW[i][0]);
      const ay = scale * (GEAR_RAW[i + 1][1] - GEAR_RAW[i][1]);
      const l = 1.0 / Math.hypot(ax, ay);
      cnorm.push([ay * l, -ax * l]);     // norms[i] = (ay,-ax)
    }
    return { contour, cnorm };
  }

  // twistoid corrugated contour (extrusion-twistoid.c: init_tripples, SCALE 0.6):
  // a semicircular hump (11 pts) + a zig-zag (9 pts) = 20, OPEN. Facet normal for edge
  // j is (-ay,ax) of the unit edge j->j+1 (TWIST macro; note the sign differs from gear).
  function twistoidContour() {
    const S = 0.6, pts = [];
    for (let i = 0; i < 11; i++) {
      const ang = (Math.PI * i) / 10.0;
      pts.push([S * (-7.0 - 3.0 * Math.cos(ang)), S * (1.8 * Math.sin(ang))]);
    }
    // corrugation: i runs 11..19 in the C; (-10+i,0) then (-9.5+i,1), stopping at 20.
    let i = 11;
    while (i < 20) {
      pts.push([S * (-10.0 + i), S * 0.0]); i++;
      if (i >= 20) break;
      pts.push([S * (-9.5 + i), S * 1.0]); i++;
    }
    const cnorm = [];
    for (let j = 0; j < 19; j++) {
      const ax = pts[j + 1][0] - pts[j][0], ay = pts[j + 1][1] - pts[j][1];
      const l = 1.0 / Math.hypot(ax, ay);
      cnorm.push([-ay * l, ax * l]);     // twist_normal[j] = (-ay, ax)
    }
    cnorm.push([0, 0]);                  // edge 19 unused (open contour)
    return { contour: pts, cnorm };
  }
  const TWISTOID = twistoidContour();

  // joinoffset leaf contour (extrusion-joinoffset.c) + its 7-point zig-zag path/colors.
  const LEAF = [
    [-0.8, -0.5], [-1.8, 0.0], [-1.2, 0.3], [-0.7, 0.8], [-0.2, 1.3],
    [0.0, 1.6], [0.2, 1.3], [0.7, 0.8], [1.2, 0.3], [1.8, 0.0], [0.8, -0.5],
  ];
  const JOIN_PSCALE = 0.5;
  const JOIN_PATH = [
    [16, 0, 0], [0, -16, 0], [-16, 0, 0], [0, 16, 0], [16, 0, 0], [0, -16, 0], [-16, 0, 0],
  ].map((p) => [p[0] * JOIN_PSCALE, p[1] * JOIN_PSCALE, p[2] * JOIN_PSCALE]);
  const JOIN_COLORS = [
    [0.0, 0.0, 0.0], [0.2, 0.8, 0.5], [0.0, 0.8, 0.3], [0.8, 0.3, 0.0],
    [0.2, 0.3, 0.9], [0.2, 0.8, 0.5], [0.0, 0.0, 0.0],
  ];

  // ===================================================================
  //  GLE path generators
  // ===================================================================
  // gleSpiral (extrude.c): sweep along a helical path. Returns {pts, xforms}. Path winds
  // around Z in the XY plane; radius/z change per REVOLUTION; startTheta/sweep in DEGREES.
  function gleSpiral(startRadius, drdTheta, startZ, dzdTheta, startXform, dXform, startTheta, sweepTheta) {
    const npoints = Math.floor((TESS / 360.0) * Math.abs(sweepTheta)) + 4;
    const deltaAngle = DEG * sweepTheta / (npoints - 3);
    let theta = DEG * startTheta - deltaAngle;
    const delta = deltaAngle / (2.0 * Math.PI);
    const dz = dzdTheta * delta, dr = drdTheta * delta;   // per-step (renormalized)
    let z = startZ - dz, r = startRadius - dr;            // back-step (first point hidden)

    const pts = new Array(npoints);
    for (let i = 0; i < npoints; i++) {
      pts[i] = [r * Math.cos(theta), r * Math.sin(theta), z];
      z += dz; r += dr; theta += deltaAngle;
    }

    let xforms = null;
    if (startXform) {
      xforms = new Array(npoints);
      if (!dXform) {
        for (let i = 0; i < npoints; i++) xforms[i] = startXform.map((row) => row.slice());
      } else {
        // exp(delta * D) via (I + (delta/32) D)^32 for the 2x2 part; translation linear.
        const dt0 = delta * dXform[0][2], dt1 = delta * dXform[1][2];
        let t0 = startXform[0][2], t1 = startXform[1][2];
        const d = delta / 32.0;
        let mA = [[1 + d * dXform[0][0], d * dXform[0][1]], [d * dXform[1][0], 1 + d * dXform[1][1]]];
        const mul = (a, b) => [
          [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1]],
          [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1]],
        ];
        let mB = mul(mA, mA); mA = mul(mB, mB); mB = mul(mA, mA); mA = mul(mB, mB); mB = mul(mA, mA); // ^32
        let run = [[startXform[0][0], startXform[0][1]], [startXform[1][0], startXform[1][1]]];
        xforms[0] = startXform.map((row) => row.slice());
        for (let i = 1; i < npoints; i++) {
          xforms[i] = [[run[0][0], run[0][1], t0], [run[1][0], run[1][1], t1]];
          run = mul(mB, run);            // left-multiply
          t0 += dt0; t1 += dt1;
        }
      }
    }
    return { pts, xforms };
  }

  // gleHelicoid: circle contour (radius rToroid) swept by gleSpiral; up=(1,0,0). Returns
  // the full draw spec. Smooth (EDGE/PATH_EDGE) normals, closed, capped, angle join.
  function gleHelicoid(rToroid, startRadius, drdTheta, startZ, dzdTheta, sx, dx, startTheta, sweep) {
    const contour = UNIT_CIRCLE.map((p) => [rToroid * p[0], rToroid * p[1]]);
    const cnorm = UNIT_CIRCLE.map((p) => [p[0], p[1]]);
    const { pts, xforms } = gleSpiral(startRadius, drdTheta, startZ, dzdTheta, sx, dx, startTheta, sweep);
    return { contour, cnorm, closed: true, facet: false, path: pts, xforms, colors: null, up: [1, 0, 0], join: 'angle' };
  }

  // ===================================================================
  //  per-shape spec builders (called every frame with current lastx/lasty)
  // ===================================================================
  // Each returns an array of draw calls (joinoffset returns two). `baked` folds the
  // shape's own glScale/glTranslate (draw is otherwise Rotate*Scale(0.5), applied by the
  // scene groups). color = per-shape diffuse (the .c's glColor / material default).
  function specFor(shape, lastx, lasty) {
    if (shape === 'helix2') {
      const dc = gleHelicoid(0.01 * lastx, 6.0, 0.01 * lasty - 2.0, -3.0, 4.0, null, null, 0.0, 1080.0);
      dc.color = [0.6, 0.3, 0.8]; dc.baked = IDENT;
      return [dc];
    }
    if (shape === 'helix3') {
      const dc = gleHelicoid(1.0, 6.0, -1.0, 0.0, 0.02 * lasty - 2.0, null, null, 0.0, 6.0 * lastx);
      dc.color = [0.8, 0.3, 0.6]; dc.baked = IDENT;
      return [dc];
    }
    if (shape === 'helix4') {
      const lx = 0.01 * lastx, ly = 0.03 * lasty;
      const affine = [[1.0 / lx, 0.0, 0.0], [0.0, lx, 0.0]];
      const dAffine = [[0.0, -ly, 0.0], [ly, 0.0, 0.0]];
      const dc = gleHelicoid(1.0, 7.0, -1.0, -4.0, 6.0, affine, dAffine, 0.0, 980.0);
      dc.color = [0.7, 0.5, 0.3]; dc.baked = IDENT;
      return [dc];
    }
    if (shape === 'joinoffset') {
      const off = 0.05 * (lasty - 200.0);
      const contour = LEAF.map((p) => [p[0], p[1] + off]);   // moved_contour
      const cnorm = LEAF.map((p) => [p[0], p[1]]);           // cont_normal == raw contour (a GLE quirk)
      // copy 1: angle join, glScale(0.5)*glTranslate(0,4,0) -> bake 0.5*p + (0,2,0).
      const c1 = { contour, cnorm, closed: true, facet: false, path: JOIN_PATH, xforms: null, colors: JOIN_COLORS, up: [1, 0, 0], join: 'angle', color: null, baked: { s: 0.5, tx: 0, ty: 2, tz: 0 } };
      // copy 2: raw join, glScale(0.5)*glTranslate(0,-4,0) -> bake 0.5*p + (0,-2,0).
      const c2 = { contour, cnorm, closed: true, facet: false, path: JOIN_PATH, xforms: null, colors: JOIN_COLORS, up: [1, 0, 0], join: 'raw', color: null, baked: { s: 0.5, tx: 0, ty: -2, tz: 0 } };
      return [c1, c2];
    }
    if (shape === 'screw') {
      const { contour, cnorm } = gearContour(1.3);
      const twist = lasty;                                   // gleScrew(..., startz=-6, endz=9, twist=lasty)
      const numsegs = Math.floor(Math.abs(twist / 18.0)) + 4;
      const path = new Array(numsegs), tw = new Array(numsegs);
      const dz = (9.0 - -6.0) / (numsegs - 3), dang = twist / (numsegs - 3);
      let z = -6.0 - dz, ang = -dang;
      for (let i = 0; i < numsegs; i++) { path[i] = [0, 0, z]; tw[i] = ang; z += dz; ang += dang; }
      const xforms = tw.map((deg) => rotXform(deg));
      // gleScrew passes up=NULL -> GLE default (0,1,0), perpendicular to the Z path.
      return [{ contour, cnorm, closed: true, facet: true, path, xforms, colors: null, up: [0, 1, 0], join: 'angle', color: [0.5, 0.6, 0.6], baked: IDENT }];
    }
    if (shape === 'taper') {
      const { contour, cnorm } = gearContour(3.33333);
      // path: 40 pts, z = -10 + 0.5*j (init_taper); DrawStuff recomputes taper/twist 1..38.
      const path = new Array(40), taper = new Array(40), twist = new Array(40);
      for (let j = 0; j < 40; j++) path[j] = [0, 0, -10.0 + 0.5 * j];
      let z = -1.0; const dz = 1.999 / 38.0, dang = lasty / 40.0, ponent = Math.abs(lastx / 540.0);
      let ang = 0.0;
      for (let j = 1; j < 39; j++) {
        twist[j] = ang; ang += dang;
        taper[j] = Math.pow(1.0 - Math.pow(Math.abs(z), 1.0 / ponent), ponent);
        z += dz;
      }
      // ends (hidden) mirror their neighbour so the spindle closes to a point.
      taper[0] = taper[1]; taper[39] = taper[38]; twist[0] = twist[1]; twist[39] = twist[38];
      const xforms = new Array(40);
      for (let j = 0; j < 40; j++) {
        const a = DEG * twist[j], s = taper[j], co = Math.cos(a), si = Math.sin(a);
        xforms[j] = [[s * co, -s * si, 0.0], [s * si, s * co, 0.0]];   // gleTaper: taper*R(twist)
      }
      return [{ contour, cnorm, closed: true, facet: true, path, xforms, colors: null, up: [0, 1, 0], join: 'angle', color: [0.5, 0.6, 0.6], baked: IDENT }];
    }
    // twistoid: corrugated OPEN strip, 5-pt path, middle ring twisted by lastx.
    const path = [
      [-6.6, 0, 0], [-6.0, 0, 0], [0, 0, 0],
      [6.0, 6.0 * (-(lasty - 121.0) / 200.0), 0],
      [6.6, 6.0 * (-1.1 * (lasty - 121.0) / 200.0), 0],
    ];
    const tw = [0, 0, (lastx - 121.0) / 8.0, 0, 0];
    const xforms = tw.map((deg) => rotXform(deg));
    return [{ contour: TWISTOID.contour, cnorm: TWISTOID.cnorm, closed: false, facet: true, path, xforms, colors: null, up: null, join: 'angle', color: [0.6, 0.6, 0.4], baked: { s: 1.8, tx: 0, ty: 0, tz: 0 } }];
  }

  const IDENT = { s: 1, tx: 0, ty: 0, tz: 0 };
  const rotXform = (deg) => {   // gleTwistExtrusion 2x3 affine for a twist of `deg` degrees
    const a = DEG * deg, co = Math.cos(a), si = Math.sin(a);
    return [[co, -si, 0.0], [si, co, 0.0]];
  };

  // ===================================================================
  //  sweep engine (GLE angle / raw join, replicated with a ring-stitch)
  // ===================================================================
  const posArr = new Float32Array(MAXV * 3);
  const norArr = new Float32Array(MAXV * 3);
  const colArr = new Float32Array(MAXV * 3);
  let vCount = 0;

  // frame scratch (per path index): miter normal (Tn), transported up (Y), X = Tn x Y.
  const fTn = new Float64Array(MAX_NP * 3), fX = new Float64Array(MAX_NP * 3), fY = new Float64Array(MAX_NP * 3);
  // ring scratch (per drawn ring, per contour vertex): world pos, smooth normal, facet normal.
  const rPos = new Float64Array(MAX_NP * MAX_NCP * 3);
  const rNrm = new Float64Array(MAX_NP * MAX_NCP * 3);
  const rFac = new Float64Array(MAX_NP * MAX_NCP * 3);
  const rCol = new Float64Array(MAX_NP * 3);   // (packed r,g,b per ring)

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // rotation-minimizing frame over the whole path (GLE reflects `up` across each
  // bisecting plane; projecting the previous Y onto the next ring plane is the same
  // twist-free transport). Ring normal Tn = miter normal (normalize(dir_in + dir_out)).
  function computeFrames(path, up) {
    const np = path.length;
    const dir = new Array(np - 1);
    for (let i = 0; i < np - 1; i++) dir[i] = norm3(sub(path[i + 1], path[i]));
    const tnAt = (i) => {
      if (i === 0) return dir[0];
      if (i === np - 1) return dir[np - 2];
      let m = [dir[i - 1][0] + dir[i][0], dir[i - 1][1] + dir[i][1], dir[i - 1][2] + dir[i][2]];
      if (Math.hypot(m[0], m[1], m[2]) < 1e-9) m = dir[i - 1];
      return norm3(m);
    };
    // seed Y from up projected perpendicular to the first ring's tangent.
    const upv = up ? norm3(up) : [0, 1, 0];
    let tn0 = tnAt(0);
    let y = sub(upv, [tn0[0] * dot(upv, tn0), tn0[1] * dot(upv, tn0), tn0[2] * dot(upv, tn0)]);
    if (Math.hypot(y[0], y[1], y[2]) < 1e-6) {   // up parallel to tangent -> fallback
      y = Math.abs(tn0[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      y = sub(y, [tn0[0] * dot(y, tn0), tn0[1] * dot(y, tn0), tn0[2] * dot(y, tn0)]);
    }
    y = norm3(y);
    let tnPrev = tn0;
    for (let i = 0; i < np; i++) {
      const tn = tnAt(i);
      // TRANSPORT the up by the minimal ROTATION aligning tnPrev -> tn (Rodrigues). GLE
      // transports `up` by REFLECTION across each bisecting plane (VEC_REFLECT); both are
      // twist-free, but rotation -- unlike the earlier project-onto-plane+renormalize --
      // never degenerates on a PLANAR path with sharp corners, where the projected up can
      // land parallel to the miter normal and collapse to zero. That collapse (a fallback
      // frame FLIP at joinoffset's 90-degree turns) was the "fragments that flicker" bug.
      if (i > 0) {
        const ax = tnPrev[1] * tn[2] - tnPrev[2] * tn[1];
        const ay = tnPrev[2] * tn[0] - tnPrev[0] * tn[2];
        const az = tnPrev[0] * tn[1] - tnPrev[1] * tn[0];
        const s = Math.hypot(ax, ay, az), c = dot(tnPrev, tn);
        if (s > 1e-9) {                            // rotate y about axis (ax,ay,az)/s by atan2(s,c)
          const kx = ax / s, ky = ay / s, kz = az / s;
          const kv = kx * y[0] + ky * y[1] + kz * y[2];
          const cvx = ky * y[2] - kz * y[1], cvy = kz * y[0] - kx * y[2], cvz = kx * y[1] - ky * y[0];
          y = [
            y[0] * c + cvx * s + kx * kv * (1 - c),
            y[1] * c + cvy * s + ky * kv * (1 - c),
            y[2] * c + cvz * s + kz * kv * (1 - c),
          ];
        }
        // s ~ 0 with c > 0: collinear, no turn -> y unchanged. c < 0 (180-degree path
        // reversal) does not occur in any of the 7 shapes' drawn paths.
      }
      // clean FP drift so y stays exactly perpendicular to tn (safe: y is already ~perp
      // after the rotation, so this projection never zeroes out), then renormalize.
      let yp = sub(y, [tn[0] * dot(y, tn), tn[1] * dot(y, tn), tn[2] * dot(y, tn)]);
      yp = norm3(yp);
      const x = norm3(cross(tn, yp));            // X = Tn x Y (GLE: X = travel dir x up)
      const o = i * 3;
      fTn[o] = tn[0]; fTn[o + 1] = tn[1]; fTn[o + 2] = tn[2];
      fY[o] = yp[0]; fY[o + 1] = yp[1]; fY[o + 2] = yp[2];
      fX[o] = x[0]; fX[o + 1] = x[1]; fX[o + 2] = x[2];
      y = yp;
      tnPrev = tn;
    }
  }

  const bake = (b, x, y, z) => [b.s * x + b.tx, b.s * y + b.ty, b.s * z + b.tz];

  // place a contour ring (path index `pi`) into ring-scratch slot `slot`, using frame X/Y.
  function placeRing(dc, pi, slot) {
    const { contour, cnorm, xforms, baked } = dc;
    const ncp = contour.length;
    const P = dc.path[pi];
    const o = pi * 3, xx = fX[o], xy = fX[o + 1], xz = fX[o + 2], yx = fY[o], yy = fY[o + 1], yz = fY[o + 2];
    const xf = xforms ? xforms[pi] : null;
    const base = slot * MAX_NCP * 3;
    for (let j = 0; j < ncp; j++) {
      let cx = contour[j][0], cy = contour[j][1];
      let nx = cnorm[j][0], ny = cnorm[j][1];
      if (xf) {
        const tx = xf[0][0] * cx + xf[0][1] * cy + xf[0][2];
        const ty = xf[1][0] * cx + xf[1][1] * cy + xf[1][2];
        cx = tx; cy = ty;
        // normal by inverse-transpose of the 2x2 (NORM_XFORM_2X2); for a pure rotation
        // this is identity, for taper's scaled rotation it removes the scale.
        const a = xf[0][0], b = xf[0][1], c = xf[1][0], d = xf[1][1];
        if (b !== 0 || c !== 0 || a !== d) {
          let pnx = d * nx - c * ny, pny = -b * nx + a * ny;
          const l = 1.0 / (Math.hypot(pnx, pny) || 1);
          nx = pnx * l; ny = pny * l;
        }
      }
      const wp = bake(baked, P[0] + cx * xx + cy * yx, P[1] + cx * xy + cy * yy, P[2] + cx * xz + cy * yz);
      const wn = norm3([nx * xx + ny * yx, nx * xy + ny * yy, nx * xz + ny * yz]);   // smooth normal
      const q = base + j * 3;
      rPos[q] = wp[0]; rPos[q + 1] = wp[1]; rPos[q + 2] = wp[2];
      rNrm[q] = wn[0]; rNrm[q + 1] = wn[1]; rNrm[q + 2] = wn[2];
    }
    // facet normals: one per contour edge j (edge j -> j+1), in this ring's frame.
    for (let j = 0; j < ncp; j++) {
      const en = dc.cnorm[j];
      const wn = norm3([en[0] * xx + en[1] * yx, en[0] * xy + en[1] * yy, en[0] * xz + en[1] * yz]);
      const q = base + j * 3;
      rFac[q] = wn[0]; rFac[q + 1] = wn[1]; rFac[q + 2] = wn[2];
    }
  }

  function ringColor(dc, pi, slot) {
    const c = dc.colors ? dc.colors[pi] : dc.color;
    rCol[slot * 3] = c[0]; rCol[slot * 3 + 1] = c[1]; rCol[slot * 3 + 2] = c[2];
  }

  function pushVert(px, py, pz, nx, ny, nz, r, g, b) {
    if (vCount >= MAXV) return;
    const v = vCount * 3;
    posArr[v] = px; posArr[v + 1] = py; posArr[v + 2] = pz;
    norArr[v] = nx; norArr[v + 1] = ny; norArr[v + 2] = nz;
    colArr[v] = r; colArr[v + 1] = g; colArr[v + 2] = b;
    vCount++;
  }

  // stitch two adjacent rings (scratch slots sa,sb) into quads (2 tris each).
  function stitch(dc, sa, sb) {
    const ncp = dc.contour.length;
    const facet = dc.facet, closed = dc.closed;
    const ba = sa * MAX_NCP * 3, bb = sb * MAX_NCP * 3;
    const ca = [rCol[sa * 3], rCol[sa * 3 + 1], rCol[sa * 3 + 2]];
    const cb = [rCol[sb * 3], rCol[sb * 3 + 1], rCol[sb * 3 + 2]];
    const nEdge = closed ? ncp : ncp - 1;
    for (let j = 0; j < nEdge; j++) {
      const j2 = (j + 1) % ncp;
      const a0 = ba + j * 3, a1 = ba + j2 * 3, b0 = bb + j * 3, b1 = bb + j2 * 3;
      // per-vertex normals (smooth) or the shared facet normal for this quad.
      let na0, na1, nb0, nb1;
      if (facet) {
        const f = [rFac[ba + j * 3], rFac[ba + j * 3 + 1], rFac[ba + j * 3 + 2]];
        na0 = na1 = nb0 = nb1 = f;
      } else {
        na0 = [rNrm[a0], rNrm[a0 + 1], rNrm[a0 + 2]];
        na1 = [rNrm[a1], rNrm[a1 + 1], rNrm[a1 + 2]];
        nb0 = [rNrm[b0], rNrm[b0 + 1], rNrm[b0 + 2]];
        nb1 = [rNrm[b1], rNrm[b1 + 1], rNrm[b1 + 2]];
      }
      // quad A[j] A[j2] B[j2] B[j]  (winding irrelevant -- DoubleSide + two-sided lighting)
      pushVert(rPos[a0], rPos[a0 + 1], rPos[a0 + 2], na0[0], na0[1], na0[2], ca[0], ca[1], ca[2]);
      pushVert(rPos[a1], rPos[a1 + 1], rPos[a1 + 2], na1[0], na1[1], na1[2], ca[0], ca[1], ca[2]);
      pushVert(rPos[b1], rPos[b1 + 1], rPos[b1 + 2], nb1[0], nb1[1], nb1[2], cb[0], cb[1], cb[2]);
      pushVert(rPos[a0], rPos[a0 + 1], rPos[a0 + 2], na0[0], na0[1], na0[2], ca[0], ca[1], ca[2]);
      pushVert(rPos[b1], rPos[b1 + 1], rPos[b1 + 2], nb1[0], nb1[1], nb1[2], cb[0], cb[1], cb[2]);
      pushVert(rPos[b0], rPos[b0 + 1], rPos[b0 + 2], nb0[0], nb0[1], nb0[2], cb[0], cb[1], cb[2]);
    }
  }

  // fan-triangulate a ring as an end cap (TUBE_JN_CAP). Normal = ring axis (Tn); with
  // DoubleSide the sign is irrelevant. Only for closed contours.
  function cap(dc, slot, pi) {
    const ncp = dc.contour.length;
    const base = slot * MAX_NCP * 3;
    let cxp = 0, cyp = 0, czp = 0;
    for (let j = 0; j < ncp; j++) { cxp += rPos[base + j * 3]; cyp += rPos[base + j * 3 + 1]; czp += rPos[base + j * 3 + 2]; }
    cxp /= ncp; cyp /= ncp; czp /= ncp;
    const nx = fTn[pi * 3], ny = fTn[pi * 3 + 1], nz = fTn[pi * 3 + 2];
    const c = [rCol[slot * 3], rCol[slot * 3 + 1], rCol[slot * 3 + 2]];
    for (let j = 0; j < ncp; j++) {
      const j2 = (j + 1) % ncp;
      const a = base + j * 3, b = base + j2 * 3;
      pushVert(cxp, cyp, czp, nx, ny, nz, c[0], c[1], c[2]);
      pushVert(rPos[a], rPos[a + 1], rPos[a + 2], nx, ny, nz, c[0], c[1], c[2]);
      pushVert(rPos[b], rPos[b + 1], rPos[b + 2], nx, ny, nz, c[0], c[1], c[2]);
    }
  }

  // one draw call (a contour swept along a path). Rings live at path indices 1..np-2
  // (the first & last points are GLE's hidden lead-in/out for the end miters).
  function drawCall(dc) {
    const np = dc.path.length;
    if (np < 4) return;
    computeFrames(dc.path, dc.up);

    if (dc.join === 'raw') {
      // square-cut prisms, one per drawn segment, each capped -> the "raw" comparison
      // copy (gaps at the sharp joinoffset corners). Both rings share the segment frame.
      for (let i = 1; i <= np - 3; i++) {
        // frame perpendicular to THIS segment (not the miter plane).
        const d = norm3(sub(dc.path[i + 1], dc.path[i]));
        let y = [fY[i * 3], fY[i * 3 + 1], fY[i * 3 + 2]];
        y = norm3(sub(y, [d[0] * dot(y, d), d[1] * dot(y, d), d[2] * dot(y, d)]));
        const x = norm3(cross(d, y));
        // overwrite the frame at i and i+1 with the segment frame, place both rings.
        for (const k of [i, i + 1]) {
          const o = k * 3; fTn[o] = d[0]; fTn[o + 1] = d[1]; fTn[o + 2] = d[2];
          fX[o] = x[0]; fX[o + 1] = x[1]; fX[o + 2] = x[2];
          fY[o] = y[0]; fY[o + 1] = y[1]; fY[o + 2] = y[2];
        }
        placeRing(dc, i, 0); ringColor(dc, i, 0);
        placeRing(dc, i + 1, 1); ringColor(dc, i + 1, 1);
        stitch(dc, 0, 1);
        if (dc.closed) { cap(dc, 0, i); cap(dc, 1, i + 1); }
      }
      return;
    }

    // angle join: one mitered ring per path point 1..np-2; stitch consecutive.
    const lo = 1, hi = np - 2, nDraw = hi - lo + 1;
    for (let k = 0; k < nDraw; k++) { placeRing(dc, lo + k, k); ringColor(dc, lo + k, k); }
    for (let k = 0; k < nDraw - 1; k++) stitch(dc, k, k + 1);
    if (dc.closed) { cap(dc, 0, lo); cap(dc, nDraw - 1, hi); }
  }

  function rebuildGeometry() {
    vCount = 0;
    for (const dc of specFor(shapeName, lastx, lasty)) drawCall(dc);
    posAttr.needsUpdate = true; norAttr.needsUpdate = true; colAttr.needsUpdate = true;
    geom.setDrawRange(0, vCount);
    geom.computeBoundingSphere();
  }

  // ===================================================================
  //  shape selection + rotator (chooseExtrusionExample / init_rotation)
  // ===================================================================
  let shapeName = 'helix2', builtMode = null;
  let rot, prevR, curR, prevP, curP, rotAccum = 0, lastx = 0, lasty = 0;

  function selectShape() {
    // chooseExtrusionExample: RANDOM -> random()%7; else the named shape.
    if (config.mode === 'random') shapeName = SHAPE_LIST[rng.random() % SHAPE_LIST.length];
    else shapeName = SHAPE_OF[config.mode] || 'helix2';
    builtMode = config.mode;
  }
  function initRotation() {
    // make_rotator(0.5,0.5,0.5, 0.2, 0.005, True); then lastx/lasty random in [-400,400).
    rot = makeRotator({ spinX: 0.5, spinY: 0.5, spinZ: 0.5, spinAccel: 0.2, wanderSpeed: 0.005, randomize: true }, rng);
    lastx = (rng.random() % LSPAN) + MINL;
    lasty = (rng.random() % LSPAN) + MINL;
    const r0 = rot.getRotation(false), p0 = rot.getPosition(false);
    prevR = { ...r0 }; curR = { ...r0 }; prevP = { ...p0 }; curP = { ...p0 }; rotAccum = 0;
  }
  selectShape();     // RNG order: shape pick ...
  initRotation();    // ... then make_rotator, then lastx/lasty

  function tickRotator() {
    prevR = curR; curR = rot.getRotation(true);
    prevP = curP; curP = rot.getPosition(true);
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpAngle = (a, b, t) => { let d = b - a; if (d > 0.5) d -= 1; else if (d < -0.5) d += 1; return a + d * t; };

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
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // reshape_extrusion: gluPerspective(30, aspect, 1, 100); gluLookAt(0,0,30, 0,0,0, 0,1,0).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // SetupLight: two directional lights (w=0). LIGHT0 yellow from (40,40,100), LIGHT1 cyan
  // from (-40,40,100). intensity PI cancels three's 1/PI Lambert (the superquadrics/glknots
  // convention). No per-light ambient; only GL's global 0.2 * material-ambient (below).
  const light0 = new THREE.DirectionalLight(new THREE.Color().setRGB(0.99, 0.99, 0.0, THREE.SRGBColorSpace), Math.PI);
  light0.position.set(40, 40, 100);
  const light1 = new THREE.DirectionalLight(new THREE.Color().setRGB(0.0, 0.99, 0.99, THREE.SRGBColorSpace), Math.PI);
  light1.position.set(-40, 40, 100);
  scene.add(light0); scene.add(light1);

  // Material AMBIENT is (0.6,0.6,0.4) (glMaterialfv, unaffected by COLOR_MATERIAL which
  // tracks only DIFFUSE); the ambient lighting term = globalAmbient 0.2 * that = a constant
  // floor, modelled as emissive. Diffuse (per-vertex color) is each shape's glColor. Gouraud
  // (GL_SMOOTH) + no specular (commented out in the .c) -> MeshLambertMaterial. Two-sided.
  const AMBIENT_FLOOR = new THREE.Color().setRGB(0.2 * 0.6, 0.2 * 0.6, 0.2 * 0.4, THREE.SRGBColorSpace);
  const litMat = new THREE.MeshLambertMaterial({
    color: 0xffffff, vertexColors: true, emissive: AMBIENT_FLOOR, side: THREE.DoubleSide,
  });
  // Flat coloring (--no-light): unlit raw glColor.
  const flatMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide });

  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(posArr, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
  const norAttr = new THREE.BufferAttribute(norArr, 3); norAttr.setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(colArr, 3); colAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('position', posAttr);
  geom.setAttribute('normal', norAttr);
  geom.setAttribute('color', colAttr);

  // modelview: Rotate(spin) > Scale(0.5) > mesh (the shape's own scale/translate is baked).
  const rotG = new THREE.Group();
  const scaleG = new THREE.Group();
  const mesh = new THREE.Mesh(geom, litMat);
  scaleG.add(mesh); rotG.add(scaleG); scene.add(rotG);
  scaleG.scale.setScalar(0.5);

  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;   // gluPerspective(30, 1/h) with h=height/width -> aspect w/h
    camera.updateProjectionMatrix();
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ===================================================================
  //  render loop
  // ===================================================================
  let raf = 0, last = 0, paused = false, ms = 16;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    if (config.mode !== builtMode) { selectShape(); }   // live object change

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;

    // tick the rotator at the original cadence; interpolate for smoothness.
    rotAccum += frames;
    let ticks = 0;
    while (rotAccum >= 1 && ticks < MAX_TICKS) { tickRotator(); rotAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) rotAccum = 0;
    const a = rotAccum;

    // spin (glRotatef x,y,z * 360 == three Euler XYZ).
    rotG.rotation.set(
      lerpAngle(prevR.x, curR.x, a) * 2 * Math.PI,
      lerpAngle(prevR.y, curR.y, a) * 2 * Math.PI,
      lerpAngle(prevR.z, curR.z, a) * 2 * Math.PI,
      'XYZ',
    );
    // shape morph: get_position -> lastx/lasty in [-400,400] -> feeds the shape params.
    lastx = lerp(prevP.x, curP.x, a) * LSPAN + MINL;
    lasty = lerp(prevP.y, curP.y, a) * LSPAN + MINL;

    rebuildGeometry();

    // render mode + wireframe (init_extrusion forces do_light off in wireframe -> flat).
    const flat = config.render === 'flat' || config.wire;
    const m = flat ? flatMat : litMat;
    m.wireframe = config.wire;
    if (mesh.material !== m) mesh.material = m;

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      geom.dispose();
      litMat.dispose(); flatMat.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { selectShape(); initRotation(); },   // fresh shape + spin/morph (host 're-seed')
    config,
    params,
  };
}

export default { title, info, start };
