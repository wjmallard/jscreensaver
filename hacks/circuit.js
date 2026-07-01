// circuit.js -- "Circuit" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's circuit (Ben Buxton, 2001), hacks/circuit.c.
// A stream of random electronic components -- resistor, diode, transistor (TO-220 /
// TO-92 / surface-mount), LED, capacitor (electrolytic / ceramic), IC, 7-segment
// display, fuse, RCA plug, 3.5mm plug, slide switch -- drift in from the edges,
// tumble across, and exit, up to `parts` on screen at once. Each is built from
// primitives (cylinders, boxes, leads, spheres, holed tabs) and carries the
// original's detailed features: resistor color-code BANDS, IC pins + label, the
// transistor part-number markings, LED dome, capacitor can, glass fuse. A faint
// green background grid (with an occasional roving bright spot) sits behind them.
//
// Self-contained on purpose (own overlay canvas + renderer + render loop), like
// engine.js / glknots.js -- it only follows the host's mountable-module contract.
//
// Faithful to the .c:
//   * The exact geometry primitives createCylinder()/circle()/sphere()/Rect()/
//     ICLeg()/HoledRectangle()/wire(), ported vertex-for-vertex (window-dependent
//     segment counts, per-vertex smooth normals, partial arcs, end-cap fans).
//   * Every Draw*/New* routine transcribed: the resistor color-band code (the
//     colorcodes[12] table, values[9][2], the 4-band layout), the diode banded
//     cylinder, the three transistor packages + their transistortypes[]/to92types[]/
//     smctypes[] tables, the IC pin count + ictypes[] label + date code, the two
//     capacitor styles, the LED (dome + one lucky LED becomes a colored light), the
//     7-segment display (segment tables + pins), the fuse, RCA, 3.5mm, slide switch.
//   * NewComponent()'s spawn: come-from-a-side (top/bottom/left/right) with the
//     matching drift, z in [-9,-2], a random tumble axis+speed, and random()%11 type.
//   * display()'s modelview: gluLookAt at (0,0,14), the whole-scene z-rotation
//     (0.01*rotate-speed / frame), the reshape frustum (glFrustum(-1,1,-h,h,1.5,35))
//     and portrait-fit scale; the drift (dx,dy * MOVE_MULT 0.02) + per-frame tumble.
//   * Lighting: one positional light at (7,7,15), diffuse+specular 0.8 gray, over
//     GL's default 0.2 global ambient (materials are GL_AMBIENT_AND_DIFFUSE = color).
//
// 3D TEXT LABELS (inline; not the shared HUD helper -- these ride ON the parts, they
// are not a screen-space caption): each IC and transistor label string is rendered to
// a 2D <canvas> (bold monospace, the .c's "componentFont: monospace bold 12", light
// gray glyphs on transparent) -> a THREE.CanvasTexture -> a small transparent quad
// positioned + oriented on the component surface with the same transform the .c uses
// for print_texture_string, so the label tumbles with the part.
//
// Motion (rotator-free -- circuit uses its own per-component tumble) and RNG
// (yarandom.js) are faithful. PACING: render every rAF; effFps = 1e6/(delay+OVERHEAD);
// continuous motion (drift, tumble, scene spin, roving spot) advances by frames =
// dt*effFps; discrete per-frame events (spawn, grid-spot start) run in a catch-up loop
// ticked at effFps (the engine.js pattern). OVERHEAD = 37500 (GL family default).

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw
// glColor/material values to the framebuffer (no sRGB encoding), and the screenshots
// capture those raw values. Disable three's color management so the port matches;
// without it, lit faces render up to ~2.5x too bright.
THREE.ColorManagement.enabled = false;

export const title = 'circuit';

export const info = {
  author: 'Ben Buxton',
  year: 2001,
  description: 'Electronic components float around.',
};

const DEG = Math.PI / 180;
const sinDeg = (a) => Math.sin(a * DEG);
const cosDeg = (a) => Math.cos(a * DEG);
const tanDeg = (a) => Math.tan(a * DEG);

// ---- fixed data tables, transcribed verbatim from circuit.c ----

// standard resistor colour codes (index 0..11)
const COLORCODES = [
  [0.0, 0.0, 0.0],   // black  0
  [0.49, 0.25, 0.08],// brown  1
  [1.0, 0.0, 0.0],   // red    2
  [1.0, 0.5, 0.0],   // orange 3
  [1.0, 1.0, 0.0],   // yellow 4
  [0.0, 1.0, 0.0],   // green  5
  [0.0, 0.5, 1.0],   // blue   6
  [0.7, 0.2, 1.0],   // violet 7
  [0.5, 0.5, 0.5],   // grey   8
  [1.0, 1.0, 1.0],   // white  9
  [0.66, 0.56, 0.2], // gold  10
  [0.8, 0.8, 0.8],   // silver 11
];

// base values for components (first two resistor bands)
const VALUES = [
  [1, 0], [2, 2], [3, 3], [4, 7], [5, 6], [6, 8], [7, 5], [8, 2], [9, 1],
];

const TRANSISTORTYPES = [
  'TIP2955', 'TIP32C', 'LM 350T', 'IRF730', 'ULN2577', '7805T', '7912T',
  'TIP120', '2N6401', 'BD239', '2SC1590', 'MRF485', 'SC141D',
];

const TO92TYPES = [
  'C\n548', 'C\n848', '74\nL05', 'C\n858', 'BC\n212L', 'BC\n640', 'BC\n337',
  'BC\n338', 'S817', '78\nL12', 'TL\n431', 'LM\n35DZ',
];

const SMCTYPES = ['1M-', '1K', '1F', 'B10', 'S14', 'Q3', '4A'];

const ICTYPES = [
  [8, 'NE 555'], [8, 'LM 386N'], [8, 'ADC0831'], [8, 'LM 383T'], [8, 'TL071'],
  [8, 'LM 311'], [8, 'LM393'], [8, 'LM 3909'],
  [14, 'LM 380N'], [14, 'NE 556'], [14, 'TL074'], [14, 'LM324'], [14, 'LM339'],
  [14, 'MC1488'], [14, 'MC1489'], [14, 'LM1877-9'], [14, '4011'], [14, '4017'],
  [14, '4013'], [14, '4024'], [14, '4066'],
  [16, '4076'], [16, '4049'], [16, '4094'], [16, '4043'], [16, '4510'],
  [16, '4511'], [16, '4035'], [16, 'RS232'], [16, 'MC1800'], [16, 'ULN2081'],
  [16, 'UDN2953'],
  [24, 'ISD1416P'], [24, '4515'], [24, 'TMS6264L'], [24, 'MC146818'],
];

// 7-segment display: per-segment vertex offsets + start points + digit map
const VDATA_H = [[0, 0], [0.1, 0.1], [0.9, 0.1], [1, 0], [0.9, -0.1], [0.1, -0.1]];
const VDATA_V = [[0.27, 0], [0.35, -0.1], [0.2, -0.9], [0.1, -1], [0, -0.9], [0.15, -0.15]];
const SEG_START = [
  [0.55, 2.26], [1.35, 2.26], [1.2, 1.27], [0.25, 0.25], [0.06, 1.25], [0.25, 2.25], [0.39, 1.24],
];
const NUMS = [
  [1, 1, 1, 1, 1, 1, 0], [0, 1, 1, 0, 0, 0, 0], [1, 1, 0, 1, 1, 0, 1],
  [1, 1, 1, 1, 0, 0, 1], [0, 1, 1, 0, 0, 1, 1], [1, 0, 1, 1, 0, 1, 1],
  [1, 0, 1, 1, 1, 1, 1], [1, 1, 1, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 0, 0, 1, 1],
];

export function start(hostCanvas, opts = {}) {
  // us; the GL family's shared overhead default (live GL is unmeasurable under this
  // machine's XQuartz DRI block). xml delay 20000 -> effFps = 1e6/57500 ~= 17.4fps.
  const OVERHEAD = 37500;
  const MAX_TICKS = 8;      // per-frame catch-up cap
  const XMAX = 50;          // ci->XMAX (fixed); YMAX = XMAX * (winH/winW)
  const MOVE_MULT = 0.02;   // MOVE_MULT

  // Knobs transcribed 1:1 from hacks/circuit.xml.
  const config = {
    delay: 20000,      // us (xml default; invert slider)
    count: 10,         // parts on screen (xml --parts)
    speed: 1,          // rotate-speed (whole-scene spin + roving-spot rate)
    spin: true,        // per-component tumble (xml --no-spin)
    render: 'light',   // 'light' (directional) or 'flat' (--no-light) (xml <select>)
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'count', label: 'Parts', type: 'range', min: 1, max: 30, step: 1, default: 10, lowLabel: 'One', highLabel: 'Lots', live: true },
    { key: 'speed', label: 'Rotation speed', type: 'range', min: 0, max: 100, step: 1, default: 1, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    { key: 'spin', label: 'Spin', type: 'checkbox', default: true, live: true },
    {
      key: 'render', label: 'Render', type: 'select', default: 'light', live: true,
      options: [
        { value: 'flat', label: 'Flat coloring' },
        { value: 'light', label: 'Directional lighting' },
      ],
    },
  ];

  const rng = makeYaRandom(opts.seed || 0);
  // circuit.c's RNG helpers: f_rand = RAND(10000)/10000; RAND_RANGE(min,max).
  const f_rand = () => ((rng.random() & 0x7fffffff) % 10000) / 10000;
  const RAND = (n) => (rng.random() & 0x7fffffff) % n;
  const RR = (min, max) => min + (max - min) * f_rand();

  // ===================================================================
  //  matrix-stack geometry builder (immediate-mode GL, one mesh per material)
  // ===================================================================
  // Each Draw* routine sets a material then emits primitives; a material() call
  // flushes the previous triangle bucket into its own mesh, exactly mirroring how
  // glMaterialfv sets state for the subsequent glBegin/glEnd draws. push/pop/
  // translate/rotate reproduce the glPushMatrix/glTranslatef/glRotatef nesting;
  // vertices + normals are baked into component-local space through the current
  // matrix (transforms are rigid, so normals use transformDirection).
  const _tmp = new THREE.Matrix4();
  const _axis = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _n = new THREE.Vector3();

  function makeBuilder(win) {
    let mtx = new THREE.Matrix4();
    const stack = [];
    let cur = null;
    const buckets = [];
    const decals = [];

    function pv(x, y, z, nx, ny, nz) {
      _p.set(x, y, z).applyMatrix4(mtx);
      _n.set(nx, ny, nz).transformDirection(mtx);
      cur.pos.push(_p.x, _p.y, _p.z);
      cur.nor.push(_n.x, _n.y, _n.z);
    }
    const B = {
      win,
      push() { stack.push(mtx.clone()); },
      pop() { mtx.copy(stack.pop()); },
      translate(x, y, z) { mtx.multiply(_tmp.makeTranslation(x, y, z)); },
      rotate(deg, x, y, z) { mtx.multiply(_tmp.makeRotationAxis(_axis.set(x, y, z).normalize(), deg * DEG)); },
      material(spec) { cur = { spec, pos: [], nor: [] }; buckets.push(cur); },
      tri(ax, ay, az, anx, any, anz, bx, by, bz, bnx, bny, bnz, cx, cy, cz, cnx, cny, cnz) {
        pv(ax, ay, az, anx, any, anz); pv(bx, by, bz, bnx, bny, bnz); pv(cx, cy, cz, cnx, cny, cnz);
      },
      // quad v0,v1,v2,v3 each [x,y,z,nx,ny,nz] -> two tris
      quad(a, b, c, d) {
        B.tri(a[0], a[1], a[2], a[3], a[4], a[5], b[0], b[1], b[2], b[3], b[4], b[5], c[0], c[1], c[2], c[3], c[4], c[5]);
        B.tri(a[0], a[1], a[2], a[3], a[4], a[5], c[0], c[1], c[2], c[3], c[4], c[5], d[0], d[1], d[2], d[3], d[4], d[5]);
      },
      // record a text quad at the current matrix (a plane facing +Z, centered)
      decal(text, w, h, lines) { decals.push({ text, w, h, lines, matrix: mtx.clone() }); },
      buckets, decals,
    };
    return B;
  }

  // createCylinder(): body along +X from 0..length, radius in Y-Z. endcaps: draw
  // triangle-fan caps. half: 180deg arc + a flat bottom rect. Direct port.
  function emitCylinder(B, length, radius, endcaps, half) {
    let nsegs = Math.floor(radius * B.win / 20);
    nsegs = Math.max(nsegs, 4);
    if (nsegs % 2) nsegs += 1;
    const angle = half ? (180 - Math.floor(90 / nsegs)) : 374;
    const step = Math.max(1, Math.floor(angle / nsegs));
    let z1 = radius, y1 = 0;
    for (let a = 0; a <= angle; a += step) {
      const y2 = radius * sinDeg(a), z2 = radius * cosDeg(a);
      B.quad(
        [0, y1, z1, 0, y1, z1],
        [length, y1, z1, 0, y1, z1],
        [length, y2, z2, 0, y2, z2],
        [0, y2, z2, 0, y2, z2],
      );
      z1 = z2; y1 = y2;
    }
    if (half) {
      B.quad(
        [0, 0, radius, 0, 1, 0],
        [length, 0, radius, 0, 1, 0],
        [length, 0, -radius, 0, 1, 0],
        [0, 0, -radius, 0, 1, 0],
      );
    }
    if (endcaps) {
      for (let ex = 0; ex <= length; ex += length) {
        let cz1 = radius, cy1 = 0;
        const norm = (ex === length) ? 1 : -1;
        for (let a = 0; a <= angle; a += step) {
          const y2 = radius * sinDeg(a), z2 = radius * cosDeg(a);
          B.tri(ex, 0, 0, norm, 0, 0, ex, cy1, cz1, norm, 0, 0, ex, y2, z2, norm, 0, 0);
          cz1 = z2; cy1 = y2;
        }
        if (length === 0) break;
      }
    }
  }

  // circle(): a disk in the Y-Z plane at x=0, normal +X, arc s..t step 10deg.
  function emitCircle(B, radius, half) {
    let x1, y1, t, s;
    if (half) { t = 270; s = 90; x1 = radius; y1 = 0; } else { t = 360; s = 0; x1 = 0; y1 = 0; }
    for (let i = s; i <= t; i += 10) {
      const x2 = radius * cosDeg(i), y2 = radius * sinDeg(i);
      B.tri(0, 0, 0, 1, 0, 0, 0, y1, x1, 1, 0, 0, 0, y2, x2, 1, 0, 0);
      x1 = x2; y1 = y2;
    }
  }

  // sphere(): partial sphere with its pole on the X axis (Dr = cos*r = x-coord).
  // Integer truncation of the loop bounds/steps is preserved from the .c.
  function emitSphere(B, r, stacks, slices, ss, es, sl, el) {
    const step = 180 / stacks, sstep = 360 / slices;
    let a1 = Math.trunc(ss * step);
    const b1 = Math.trunc(sl * sstep);
    let y1 = 0, z1 = 0, Y1 = 0, Z1 = 0;
    const c0 = Math.trunc((el / slices) * 360);
    const c1 = Math.trunc((es / stacks) * 180);
    for (let a = Math.trunc(ss * step); a <= c1; a = Math.trunc(a + step)) {
      const d = sinDeg(a), d1 = sinDeg(a1), D = cosDeg(a), D1 = cosDeg(a1);
      const dr = d * r, dr1 = d1 * r, Dr = D * r, Dr1 = D1 * r;
      for (let b = b1; b <= c0; b = Math.trunc(b + sstep)) {
        const y2 = dr * sinDeg(b), z2 = dr * cosDeg(b), Y2 = dr1 * sinDeg(b), Z2 = dr1 * cosDeg(b);
        B.quad(
          [Dr, y1, z1, Dr, y1, z1],
          [Dr, y2, z2, Dr, y2, z2],
          [Dr1, Y2, Z2, Dr1, Y2, Z2],
          [Dr1, Y1, Z1, Dr1, Y1, Z1],
        );
        z1 = z2; y1 = y2; Z1 = Z2; Y1 = Y2;
      }
      a1 = a;
    }
  }

  // Rect(): box from (x,y,z) to (x+w, y+h, z-t), six faces (circuit.c's Rect()).
  function emitRect(B, x, y, z, w, h, tt) {
    const yh = y + h, xw = x + w, zt = z - tt;
    B.quad([x, y, z, 0, 0, 1], [x, yh, z, 0, 0, 1], [xw, yh, z, 0, 0, 1], [xw, y, z, 0, 0, 1]);
    B.quad([x, y, zt, 0, 0, -1], [x, yh, zt, 0, 0, -1], [xw, yh, zt, 0, 0, -1], [xw, y, zt, 0, 0, -1]);
    B.quad([x, yh, z, 0, 1, 0], [x, yh, zt, 0, 1, 0], [xw, yh, zt, 0, 1, 0], [xw, yh, z, 0, 1, 0]);
    B.quad([x, y, z, 0, -1, 0], [x, y, zt, 0, -1, 0], [xw, y, zt, 0, -1, 0], [xw, y, z, 0, -1, 0]);
    B.quad([x, y, z, -1, 0, 0], [x, y, zt, -1, 0, 0], [x, yh, zt, -1, 0, 0], [x, yh, z, -1, 0, 0]);
    B.quad([xw, y, z, 1, 0, 0], [xw, y, zt, 1, 0, 0], [xw, yh, zt, 1, 0, 0], [xw, yh, z, 1, 0, 0]);
  }

  function emitICLeg(B, x, y, z, dir) {
    if (dir) {
      emitRect(B, x - 0.1, y, z, 0.1, 0.1, 0.02);
      emitRect(B, x - 0.1, y, z, 0.02, 0.1, 0.1);
      emitRect(B, x - 0.1, y + 0.03, z - 0.1, 0.02, 0.05, 0.3);
    } else {
      emitRect(B, x, y, z, 0.1, 0.1, 0.02);
      emitRect(B, x + 0.08, y, z, 0.02, 0.1, 0.1);
      emitRect(B, x + 0.08, y + 0.03, z - 0.1, 0.02, 0.05, 0.3);
    }
  }

  // HoledRectangle(): a rectangle (w x h, depth d) with a circular hole radius,
  // p facets. Direct port of circuit.c's HoledRectangle().
  function emitHoledRect(B, w, h, d, radius, p) {
    const stp = Math.floor(360 / p);
    let x1 = radius, y1 = 0;
    let xr1 = w / 2, yr1 = 0;
    const side = w / 2, side1 = h / 2;
    for (let a = 0; a <= 360; a += stp) {
      const y2 = radius * sinDeg(a), x2 = radius * cosDeg(a);
      let xr, yr, nx, ny;
      if (a < 45 || a > 315) {
        xr = side; yr = side1 * tanDeg(a); nx = 1; ny = 0;
      } else if (a <= 135 || a >= 225) {
        xr = side / tanDeg(a);
        if (a >= 225) { yr = -side1; xr = -xr; nx = 0; ny = -1; }
        else { yr = side1; nx = 0; ny = 1; }
      } else {
        xr = -side; yr = -side1 * tanDeg(a); nx = -1; ny = 0;
      }
      B.quad([x1, y1, 0, -x1, -y1, 0], [x1, y1, -d, -x1, -y1, 0], [x2, y2, -d, -x2, -y2, 0], [x2, y2, 0, -x2, -y2, 0]);
      B.quad([x1, y1, 0, 0, 0, 1], [xr1, yr1, 0, 0, 0, 1], [xr, yr, 0, 0, 0, 1], [x2, y2, 0, 0, 0, 1]);
      B.quad([xr, yr, 0, nx, ny, 0], [xr, yr, -d, nx, ny, 0], [xr1, yr1, -d, nx, ny, 0], [xr1, yr1, 0, nx, ny, 0]);
      B.quad([xr, yr, -d, 0, 0, -1], [x2, y2, -d, 0, 0, -1], [x1, y1, -d, 0, 0, -1], [xr1, yr1, -d, 0, 0, -1]);
      x1 = x2; y1 = y2; xr1 = xr; yr1 = yr;
    }
  }

  // wire(): a thin gray shiny lead. createCylinder(len, 0.05, 1, 0).
  const WIRE = { r: 0.3, g: 0.3, b: 0.3, spec: 0.9, shine: 30 };
  function emitWire(B, len) {
    B.material(WIRE);
    emitCylinder(B, len, 0.05, 1, 0);
  }

  // ===================================================================
  //  per-component builders (New* value pick + Draw* geometry, merged)
  // ===================================================================

  function buildResistor(B, norm) {
    // NewResistor: value/multiplier/tolerance -> 4 band colour indices.
    const v = RAND(9), m = RAND(5), t = (RAND(10) < 5) ? 10 : 11;
    const b = [VALUES[v][0], VALUES[v][1], m, t];
    B.translate(-4, 0, 0);
    emitWire(B, 3);
    B.translate(3, 0, 0);
    B.material({ r: 0.74, g: 0.62, b: 0.46, spec: 0.8, shine: 30 });
    emitCylinder(B, 1.8, 0.4, 1, 0);
    B.push();
    for (let i = 0; i < 4; i++) {
      B.translate(0.35, 0, 0);
      const cc = COLORCODES[b[i]];
      B.material({ r: cc[0], g: cc[1], b: cc[2], spec: 0.8, shine: 40 });
      emitCylinder(B, 0.1, 0.42, 0, 0);   // band_list: createCylinder(0.1,0.42,0,0)
    }
    B.pop();
    B.translate(1.8, 0, 0);
    emitWire(B, 3);
  }

  function buildDiode(B) {
    // NewDiode: white band, body dark red or dark gray.
    let br, bg, bb;
    if (f_rand() < 0.5) { br = 0.7; bg = 0.1; bb = 0.1; } else { br = 0.2; bg = 0.2; bb = 0.2; }
    B.translate(-4, 0, 0);
    emitWire(B, 3);
    B.translate(3, 0, 0);
    // bandedCylinder(0.3, 1.5, body, {pos:0.8,len:0.1,white}, 1), spec 0.7 shine 40.
    const radius = 0.3, l = 1.5;
    B.material({ r: br, g: bg, b: bb, spec: 0.7, shine: 40 });
    emitCylinder(B, l, radius, 1, 0);
    B.push();
    B.translate(0.8 * l, 0, 0);
    B.material({ r: 1, g: 1, b: 1, spec: 0.7, shine: 40 });
    emitCylinder(B, 0.1 * l, radius * 1.05, 0, 0);
    B.pop();
    B.translate(1.5, 0, 0);
    emitWire(B, 3);
  }

  function buildTransistor(B) {
    // NewTransistor: type 0=TO-220, 1=TO-92, 2=SMC; text from the matching table.
    const ttype = rng.random() % 3;
    let text;
    if (ttype === 0) text = TRANSISTORTYPES[rng.random() % TRANSISTORTYPES.length];
    else if (ttype === 2) text = SMCTYPES[rng.random() % SMCTYPES.length];
    else text = TO92TYPES[rng.random() % TO92TYPES.length];
    const col = { r: 0.3, g: 0.3, b: 0.3, shine: 30 };

    if (ttype === 1) {                  // TO-92
      B.material({ ...col, specRGB: [0.3, 0.3, 0.3] });
      B.rotate(90, 0, 1, 0);
      B.rotate(90, 0, 0, 1);
      emitCylinder(B, 1.0, 0.4, 1, 1);
      emitRect(B, 0, -0.2, 0.4, 1, 0.2, 0.8);
      B.push();
      B.rotate(90, 1, 0, 0);
      B.translate(0.5, -0.05, 0.22);
      B.decal(text, 0.7, 0.7, text.split('\n').length);
      B.pop();
      B.translate(-2, 0, -0.2);
      emitWire(B, 2);
      B.translate(0, 0, 0.2);
      emitWire(B, 2);
      B.translate(0, 0, 0.2);
      emitWire(B, 2);
    } else if (ttype === 0) {           // TO-220
      B.material({ ...col, specRGB: [0.3, 0.3, 0.3] });
      emitRect(B, 0, 0, 0, 1.5, 1.5, 0.5);
      B.push();
      B.translate(0.75, 0.75, 0.02);
      B.decal(text, 1.25, 0.7, 1);
      B.pop();
      B.material({ ...col, spec: 0.9, shine: 30 });
      emitRect(B, 0, 0, -0.5, 1.5, 1.5, 0.30);
      B.push();
      B.translate(0.75, 1.875, -0.55);
      emitHoledRect(B, 1.5, 0.75, 0.25, 0.2, 8);
      B.pop();
      B.push();
      B.translate(0.375, 0, 0);
      B.rotate(90, 0, 0, -1);
      emitWire(B, 2);
      B.translate(0, 0.375, 0);
      emitWire(B, 2);
      B.translate(0, 0.375, 0);
      emitWire(B, 2);
      B.pop();
    } else {                            // SMC (surface mount)
      B.translate(-0.5, -0.25, 0.1);
      B.material({ ...col, specRGB: [0.3, 0.3, 0.3] });
      emitRect(B, 0, 0, 0, 1, 0.5, 0.2);
      B.push();
      B.translate(0.5, 0.25, 0.02);
      B.decal(text, 0.6, 0.42, 1);      // the .c leaves this quad's texture unset;
      B.pop();                          // we draw the smctype for a meaningful label.
      B.material({ ...col, spec: 0.9, shine: 30 });
      emitRect(B, 0.25, -0.1, -0.05, 0.1, 0.1, 0.2);
      emitRect(B, 0.75, -0.1, -0.05, 0.1, 0.1, 0.2);
      emitRect(B, 0.5, 0.5, -0.05, 0.1, 0.1, 0.2);
      emitRect(B, 0.25, -0.2, -0.2, 0.1, 0.15, 0.1);
      emitRect(B, 0.75, -0.2, -0.2, 0.1, 0.15, 0.1);
      emitRect(B, 0.5, 0.5, -0.2, 0.1, 0.15, 0.1);
    }
  }

  function buildIC(B) {
    // NewIC: pin count -> a random matching type -> "VAL\nYYWW" label.
    const pinChoices = [8, 14, 16, 24];
    const pins = pinChoices[Math.trunc(RR(0, 4))];
    const matching = [];
    for (const it of ICTYPES) if (it[0] === pins) matching.push(it[1]);
    const val = matching[rng.random() % matching.length];
    const yy = Math.trunc(RR(80, 100)), ww = Math.trunc(RR(1, 53));
    const text = val + '\n' + String(yy).padStart(2, '0') + String(ww).padStart(2, '0');

    let w, h;
    if (pins === 8) { w = 1.0; h = 1.5; }
    else if (pins === 14 || pins === 16) { w = 1.0; h = 3; }
    else { w = 1.5; h = 3.5; }
    w /= 2; h /= 2;
    // body (six faces, drawn explicitly in the .c), col {0.1} spec 0.6 shine 40.
    B.material({ r: 0.1, g: 0.1, b: 0.1, spec: 0.6, shine: 40 });
    B.quad([w, h, 0.1, 0, 0, 1], [w, -h, 0.1, 0, 0, 1], [-w, -h, 0.1, 0, 0, 1], [-w, h, 0.1, 0, 0, 1]);
    B.quad([w, h, -0.1, 0, 0, -1], [w, -h, -0.1, 0, 0, -1], [-w, -h, -0.1, 0, 0, -1], [-w, h, -0.1, 0, 0, -1]);
    B.quad([w, h, -0.1, 1, 0, 0], [w, -h, -0.1, 1, 0, 0], [w, -h, 0.1, 1, 0, 0], [w, h, 0.1, 1, 0, 0]);
    B.quad([w, -h, -0.1, 0, -1, 0], [w, -h, 0.1, 0, -1, 0], [-w, -h, 0.1, 0, -1, 0], [-w, -h, -0.1, 0, -1, 0]);
    B.quad([-w, h, -0.1, -1, 0, 0], [-w, h, 0.1, -1, 0, 0], [-w, -h, 0.1, -1, 0, 0], [-w, -h, -0.1, -1, 0, 0]);
    B.quad([-w, h, -0.1, 0, 1, 0], [w, h, -0.1, 0, 1, 0], [w, h, 0.1, 0, 1, 0], [-w, h, 0.1, 0, 1, 0]);
    // label on the top face (z=0.1), rotated 90deg so it reads along the long axis.
    B.push();
    B.translate(0, 0, 0.12);
    B.rotate(90, 0, 0, 1);
    B.decal(text, 2 * h * 0.7, 2 * w * 0.62, 2);
    B.pop();
    // pins: two rows of ICLeg.
    let d = (h * 2 - 0.1) / pins;
    d *= 2;
    B.material({ r: 0.4, g: 0.4, b: 0.4, spec: 0.6, shine: 40 });
    for (let z = 0; z < pins / 2; z++) emitICLeg(B, w, -h + z * d + d / 2, 0, 0);
    for (let z = 0; z < pins / 2; z++) emitICLeg(B, -w, -h + z * d + d / 2, 0, 1);
    // pin-1 dimple (a small disk) in a corner.
    B.material({ r: 0.2, g: 0.2, b: 0.2, spec: 0.6, shine: 40 });
    B.translate(-w + 0.3, h - 0.3, 0.1);
    B.rotate(90, 0, 1, 0);
    emitCircle(B, 0.1, 0);
  }

  function buildCapacitor(B) {
    // NewCapacitor: 0 = electrolytic (blue can), 1 = ceramic (brown blob).
    const ctype = (f_rand() < 0.5) ? 1 : 0;
    if (ctype === 0) {
      const length = RR(0.5, 1), width = RR(0.5, 1);
      B.translate(-length * 2, 0, 0);
      // top sliver (black), then the blue can, gray + black end circles, leads.
      B.material({ r: 0, g: 0, b: 0, spec: 0.8, shine: 40 });
      B.quad(
        [0, 0.82 * width, -0.1, 0, 1, 0],
        [3 * length, 0.82 * width, -0.1, 0, 1, 0],
        [3 * length, 0.82 * width, 0.1, 0, 1, 0],
        [0, 0.82 * width, 0.1, 0, 1, 0],
      );
      B.material({ r: 0.0, g: 0.2, b: 0.9, spec: 0.8, shine: 40 });
      emitCylinder(B, 3.0 * length, 0.8 * width, 1, 0);
      B.material({ r: 0.7, g: 0.7, b: 0.7, spec: 0.8, shine: 40 });
      emitCircle(B, 0.6 * width, 0);
      B.material({ r: 0, g: 0, b: 0, spec: 0.8, shine: 40 });
      B.translate(3.0 * length, 0, 0);
      emitCircle(B, 0.6 * width, 0);
      B.translate(0, 0.4 * width, 0);
      emitWire(B, 3 * length);
      B.translate(0, -0.8 * width, 0);
      emitWire(B, 3.3 * length);
    } else {
      const width = RR(0.3, 1);
      B.material({ r: 0.84, g: 0.5, b: 0, spec: 0.8, shine: 40 });
      emitSphere(B, width, 15, 15, 0, 4, 0, 15);
      B.translate(1.35 * width, 0, 0);
      emitSphere(B, width, 15, 15, 11, 15, 0, 15);
      B.rotate(90, 0, 0, 1);
      B.translate(0, 0.7 * width, 0.3 * width);
      emitWire(B, 3 * width);
      B.translate(0, 0, -0.6 * width);
      emitWire(B, 3 * width);
    }
  }

  // LED: returns { lit } so the caller can wire up the shared coloured light.
  function buildLED(B, canLight) {
    const r = f_rand();
    let lr, lg, lb;
    if (r < 0.2) { lr = 0.9; lg = 0; lb = 0; }
    else if (r < 0.4) { lr = 0.3; lg = 0.9; lb = 0; }
    else if (r < 0.6) { lr = 0.8; lg = 0.9; lb = 0; }
    else if (r < 0.8) { lr = 0.0; lg = 0.2; lb = 0.8; }
    else { lr = 0.9; lg = 0.55; lb = 0; }
    // NewLED: one lucky LED (when no light active) becomes the scene light source.
    let lit = false;
    if (canLight() && f_rand() < 0.4) lit = true;

    // body cylinder (translucent when unlit, coloured spec), dome, base flange, leads.
    const bodySpec = { r: lr, g: lg, b: lb, specRGB: [lr, lg, lb], shine: 30 };
    if (!lit) { bodySpec.alpha = 0.6; }
    B.translate(-0.9, 0, 0);
    B.material(bodySpec);
    emitCylinder(B, 1.2, 0.3, 0, 0);
    // dome: lit -> flat glowing colour; unlit -> translucent lit colour.
    if (lit) B.material({ r: lr, g: lg, b: lb, flat: true });
    else B.material({ r: lr, g: lg, b: lb, specRGB: [lr, lg, lb], shine: 30, alpha: 0.6 });
    emitSphere(B, 0.3, 7, 7, 3, 7, 0, 7);
    B.translate(1.2, 0, 0);
    B.material({ r: lr, g: lg, b: lb, specRGB: [lr, lg, lb], shine: 30, ...(lit ? {} : { alpha: 0.6 }) });
    emitCylinder(B, 0.1, 0.38, 1, 0);
    B.translate(-0.3, 0.15, 0);
    emitWire(B, 3);
    B.translate(0, -0.3, 0);
    emitWire(B, 3.3);
    return { lit, r: lr, g: lg, b: lb };
  }

  function buildDisp(B) {
    // 7-segment display: body + dark front + lit segments (a random digit) + pins.
    const value = Math.trunc(RR(0, 10));
    B.translate(-0.9, -1.8, 0);
    B.material({ r: 0.8, g: 0.8, b: 0.8, shine: 0 });
    emitRect(B, 0, 0, -0.01, 1.8, 2.6, 0.7);
    B.material({ r: 0.2, g: 0.2, b: 0.2, shine: 0 });
    B.quad(
      [-0.05, -0.05, 0, 0, 0, 1],
      [-0.05, 2.65, 0, 0, 0, 1],
      [1.85, 2.65, 0, 0, 0, 1],
      [1.85, -0.05, 0, 0, 0, 1],
    );
    // segments (flat/unlit): on = bright red, off = dark red.
    for (let j = 0; j < 7; j++) {
      const on = NUMS[value][j];
      B.material({ r: on ? 0.9 : 0.3, g: 0, b: 0, flat: true });
      const vd = (j === 0 || j === 3 || j === 6) ? VDATA_H : VDATA_V;
      const xx = [], yy = [];
      for (let k = 0; k < 6; k++) { xx[k] = SEG_START[j][0] + vd[k][0]; yy[k] = SEG_START[j][1] + vd[k][1]; }
      // GL_POLYGON (a hexagon) -> triangle fan from vertex 0.
      for (let i = 1; i < 5; i++) {
        B.tri(xx[0], yy[0], 0.01, 0, 0, 1, xx[i], yy[i], 0.01, 0, 0, 1, xx[i + 1], yy[i + 1], 0.01, 0, 0, 1);
      }
    }
    // decimal point (a small bright-red quad in place of the .c's GL_POINT).
    B.material({ r: 0.9, g: 0, b: 0, flat: true });
    emitRect(B, 1.46, 0.16, 0.02, 0.08, 0.08, 0);
    // pins.
    B.material({ r: 0.4, g: 0.4, b: 0.4, spec: 0.6, shine: 40 });
    for (let x = 0.35; x <= 1.5; x += 1.15) {
      for (let y = 0.2; y <= 2.4; y += 0.3) emitICLeg(B, x, y, -0.7, 1);
    }
  }

  function buildFuse(B) {
    B.translate(-1.8, 0, 0);
    B.material({ r: 0.5, g: 0.5, b: 0.5, spec: 1, shine: 40 });
    emitCylinder(B, 0.8, 0.45, 1, 0);
    B.translate(0.8, 0, 0);
    // glass tube: two translucent cylinders (depth-write off).
    B.material({ r: 0.4, g: 0.4, b: 0.4, specRGB: [1, 1, 1], shine: 40, alpha: 0.3 });
    emitCylinder(B, 2, 0.4, 0, 0);
    emitCylinder(B, 2, 0.3, 0, 0);
    B.translate(2, 0, 0);
    B.material({ r: 0.5, g: 0.5, b: 0.5, spec: 1, shine: 40 });
    emitCylinder(B, 0.8, 0.45, 1, 0);
  }

  function buildRCA(B) {
    const white = (rng.random() % 10 < 5);
    B.translate(0.3, 0, 0);
    B.material({ r: 0.6, g: 0.6, b: 0.6, specRGB: [1, 1, 1], shine: 40 });
    emitCylinder(B, 0.7, 0.45, 0, 0);
    B.translate(0.4, 0, 0);
    emitCylinder(B, 0.9, 0.15, 1, 0);
    B.translate(-1.9, 0, 0);
    if (white) B.material({ r: 1, g: 1, b: 1, shine: 20 });
    else B.material({ r: 1, g: 0, b: 0, shine: 20 });
    emitCylinder(B, 1.5, 0.6, 1, 0);
    B.translate(-0.9, 0, 0);
    emitCylinder(B, 0.9, 0.25, 0, 0);
    B.translate(0.1, 0, 0);
    emitCylinder(B, 0.2, 0.3, 0, 0);
    B.translate(0.3, 0, 0);
    emitCylinder(B, 0.2, 0.3, 1, 0);
    B.translate(0.3, 0, 0);
    emitCylinder(B, 0.2, 0.3, 1, 0);
  }

  function buildThreeFive(B) {
    const cream = { r: 0.8, g: 0.8, b: 0.6, specRGB: [0.7, 0.7, 0.7], shine: 40 };
    const light = { r: 0.6, g: 0.6, b: 0.6, specRGB: [0.7, 0.7, 0.7], shine: 40 };
    const dark = { r: 0.3, g: 0.3, b: 0.3, specRGB: [0.7, 0.7, 0.7], shine: 40 };
    B.translate(-2.0, 0, 0);
    B.material(cream);
    emitCylinder(B, 0.7, 0.2, 0, 0);
    B.translate(0.7, 0, 0);
    emitCylinder(B, 1.3, 0.4, 1, 0);
    B.material(light);
    B.translate(1.3, 0, 0);
    emitCylinder(B, 1.3, 0.2, 0, 0);
    B.material(dark);
    B.translate(0.65, 0, 0);
    emitCylinder(B, 0.15, 0.21, 0, 0);
    B.translate(0.3, 0, 0);
    emitCylinder(B, 0.15, 0.21, 0, 0);
    B.material(light);
    B.translate(0.4, 0, 0);
    emitSphere(B, 0.23, 7, 7, 0, 5, 0, 7);
  }

  function buildSwitch(B) {
    const metal = { r: 0.6, g: 0.6, b: 0.6, specRGB: [0.9, 0.9, 0.9], shine: 90 };
    const dark = { r: 0.1, g: 0.1, b: 0.1, specRGB: [0.9, 0.9, 0.9], shine: 90 };
    const brown = { r: 0.69, g: 0.32, b: 0, specRGB: [0.9, 0.9, 0.9], shine: 90 };
    B.material(metal);
    emitRect(B, -0.25, 0, 0, 1.5, 0.5, 0.75);
    B.push();
    B.rotate(90, 1, 0, 0);
    B.translate(-0.5, -0.4, -0.4);
    emitHoledRect(B, 0.5, 0.75, 0.1, 0.15, 8);
    B.translate(2, 0, 0);
    emitHoledRect(B, 0.5, 0.75, 0.1, 0.15, 8);
    B.pop();
    emitRect(B, 0.1, -0.4, -0.25, 0.1, 0.4, 0.05);
    emitRect(B, 0.5, -0.4, -0.25, 0.1, 0.4, 0.05);
    emitRect(B, 0.9, -0.4, -0.25, 0.1, 0.4, 0.05);
    emitRect(B, 0.1, -0.4, -0.5, 0.1, 0.4, 0.05);
    emitRect(B, 0.5, -0.4, -0.5, 0.1, 0.4, 0.05);
    emitRect(B, 0.9, -0.4, -0.5, 0.1, 0.4, 0.05);
    B.material(dark);
    emitRect(B, 0, 0.5, -0.1, 1, 0.05, 0.5);
    emitRect(B, 0, 0.6, -0.1, 0.5, 0.6, 0.5);
    B.material(brown);
    emitRect(B, -0.2, -0.01, -0.1, 1.4, 0.1, 0.55);
  }

  // ===================================================================
  //  3D text decal (canvas -> CanvasTexture -> transparent quad on the part)
  // ===================================================================
  // The .c pre-renders each string as a texfont texture and maps it onto the part
  // (IC top, transistor faces) in light gray on transparent. We draw the string to a
  // 2D canvas and wrap it on a plane (facing +Z, centered) with the placement matrix.
  const FONT_FAMILY = 'JScreenSaverCircuit';
  let fontReady = false;
  try {
    const url = new URL('./fonts/luximr.ttf', import.meta.url).href;
    const face = new FontFace(FONT_FAMILY, 'url(' + url + ')');
    face.load().then((f) => { document.fonts.add(f); fontReady = true; }).catch(() => {});
  } catch (e) { /* fall back to platform monospace */ }

  function makeDecalMesh(text, w, h) {
    const lines = String(text).split('\n');
    const cw = 256;
    const ch = Math.max(48, Math.round(cw * (h / w)));
    const cvs = document.createElement('canvas');
    cvs.width = cw; cvs.height = ch;
    const ctx = cvs.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = 'rgb(179,179,179)';    // texfg {0.7,0.7,0.7}
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fam = (fontReady ? "'" + FONT_FAMILY + "', " : '') + 'monospace';
    // fit the widest line to ~86% width, and all lines to ~78% height.
    let size = Math.floor((ch / lines.length) * 0.82);
    for (let guard = 0; guard < 24; guard++) {
      ctx.font = 'bold ' + size + "px " + fam;
      let widest = 0;
      for (const ln of lines) widest = Math.max(widest, ctx.measureText(ln).width);
      if (widest <= cw * 0.86 || size <= 6) break;
      size -= 2;
    }
    ctx.font = 'bold ' + size + "px " + fam;
    const lineH = size * 1.12;
    const y0 = ch / 2 - (lines.length - 1) * lineH / 2;
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], cw / 2, y0 + i * lineH);

    const tex = new THREE.CanvasTexture(cvs);
    tex.anisotropy = 4;
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.renderOrder = 3;
    return { mesh, tex, mat, geom: mesh.geometry };
  }

  // ===================================================================
  //  material construction (GL_AMBIENT_AND_DIFFUSE = color; specular /PI)
  // ===================================================================
  function makeMat(spec) {
    if (spec.flat) {
      return new THREE.MeshBasicMaterial({
        color: new THREE.Color().setRGB(spec.r, spec.g, spec.b, THREE.SRGBColorSpace),
        side: THREE.DoubleSide,
        transparent: spec.alpha != null,
        opacity: spec.alpha != null ? spec.alpha : 1,
        depthWrite: spec.alpha == null,
      });
    }
    let specular = new THREE.Color(0, 0, 0);
    if (spec.specRGB) specular = new THREE.Color().setRGB(spec.specRGB[0] / Math.PI, spec.specRGB[1] / Math.PI, spec.specRGB[2] / Math.PI, THREE.SRGBColorSpace);
    else if (spec.spec != null) specular = new THREE.Color().setRGB(spec.spec / Math.PI, spec.spec / Math.PI, spec.spec / Math.PI, THREE.SRGBColorSpace);
    return new THREE.MeshPhongMaterial({
      color: new THREE.Color().setRGB(spec.r, spec.g, spec.b, THREE.SRGBColorSpace),
      specular,
      shininess: spec.shine || 0,
      side: THREE.DoubleSide,
      transparent: spec.alpha != null,
      opacity: spec.alpha != null ? spec.alpha : 1,
      depthWrite: spec.alpha == null,
    });
  }

  // ===================================================================
  //  three.js scene
  // ===================================================================
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

  // reshape_circuit: glFrustum(-1,1,-h,h,1.5,35), h = winH/winW; gluLookAt(0,0,14,...).
  // A symmetric frustum: fov_vertical = 2*atan(h/near); aspect = winW/winH.
  const camera = new THREE.PerspectiveCamera(45, 1, 1.5, 35);
  camera.position.set(0, 0, 14);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // LIGHT0: positional at (7,7,15), diffuse+specular 0.8 gray, no distance
  // attenuation (the .c's glLighti(LINEAR, 0.5) truncates to int 0) -> decay 0.
  // intensity 0.8*PI cancels three's 1/PI Lambert (the engine/glknots convention).
  const mainLight = new THREE.PointLight(0xffffff, 0.8 * Math.PI, 0, 0);
  mainLight.position.set(7, 7, 15);
  // GL's default global ambient 0.2 * material color. (Flat mode raises it to PI so
  // components render at full unlit colour and the point light is switched off.)
  const ambient = new THREE.AmbientLight(0xffffff, 0.2 * Math.PI);
  scene.add(ambient);

  // The "one lucky LED is the light source" colored light (kept in the graph, its
  // intensity toggled) -- a point-light stand-in for the .c's LIGHT1 spotlight.
  const ledLight = new THREE.PointLight(0xffffff, 0, 0, 0);

  // modelview nesting (display()):
  //   sceneRot : Rotate(rotate_angle, Z)        (the slow whole-scene spin) + light
  //   scaleG   : Scale(portraitFit)             (reshape's glScalef) + grid + parts
  const sceneRot = new THREE.Group();
  const scaleG = new THREE.Group();
  const componentsGroup = new THREE.Group();
  sceneRot.add(mainLight);
  sceneRot.add(scaleG);
  scaleG.add(componentsGroup);
  scaleG.add(ledLight);
  scene.add(sceneRot);

  let YMAX = 50;

  // ---- background grid (drawgrid): green lines at z=-10 + a roving bright spot ----
  const gridCol = [0, 0.25, 0.05], gridCol2 = [0, 0.125, 0.05];
  let gridMesh = null, gridMesh2 = null;
  function buildGrid() {
    if (gridMesh) { scaleG.remove(gridMesh); gridMesh.geometry.dispose(); gridMesh.material.dispose(); }
    if (gridMesh2) { scaleG.remove(gridMesh2); gridMesh2.geometry.dispose(); gridMesh2.material.dispose(); }
    const p1 = [], p2 = [];
    const hx = XMAX / 2, hy = YMAX / 2;
    for (let x = -hx; x <= hx; x += 2) {
      p1.push(x, hy, -10, x, -hy, -10);
      p2.push(x - 0.02, hy, -10, x - 0.02, -hy, -10, x + 0.02, hy, -10, x + 0.02, -hy, -10);
    }
    for (let y = -hy; y <= hy; y += 2) {
      p1.push(-hx, y, -10, hx, y, -10);
      p2.push(-hx, y - 0.02, -10, hx, y - 0.02, -10, -hx, y + 0.02, -10, hx, y + 0.02, -10);
    }
    const g1 = new THREE.BufferGeometry(); g1.setAttribute('position', new THREE.Float32BufferAttribute(p1, 3));
    const g2 = new THREE.BufferGeometry(); g2.setAttribute('position', new THREE.Float32BufferAttribute(p2, 3));
    gridMesh = new THREE.LineSegments(g1, new THREE.LineBasicMaterial({ color: new THREE.Color().setRGB(gridCol[0], gridCol[1], gridCol[2], THREE.SRGBColorSpace) }));
    gridMesh2 = new THREE.LineSegments(g2, new THREE.LineBasicMaterial({ color: new THREE.Color().setRGB(gridCol2[0], gridCol2[1], gridCol2[2], THREE.SRGBColorSpace) }));
    scaleG.add(gridMesh); scaleG.add(gridMesh2);
  }

  // roving spot: a small green sphere pair that streaks across the grid.
  const spotGeom = (() => {
    const B = makeBuilder(600);
    B.material({ r: 0, g: 0.8, b: 0, flat: true });
    emitSphere(B, 0.1, 10, 10, 0, 10, 0, 10);
    const bk = B.buckets[0];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(bk.nor, 3));
    return g;
  })();
  const spotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(0, 0.8, 0, THREE.SRGBColorSpace) });
  const spotMesh = new THREE.Mesh(spotGeom, spotMat);
  spotMesh.visible = false;
  scaleG.add(spotMesh);
  let spotActive = false, spotDir = 0, spotDs = 0, spotX = 0, spotY = 0;

  // ===================================================================
  //  component lifecycle
  // ===================================================================
  let lightActive = (config.render === 'flat');   // uselight==0 -> ci->light=1
  let litComp = null;
  const components = [];    // live component objects (each: { group, disposables, ... })

  function componentCanLight() { return !lightActive; }

  function makeComponent() {
    const c = {};
    c.baseAngle = RR(0, 360);
    const rnd = f_rand();
    if (rnd < 0.25) {                     // from the top
      c.y = YMAX / 2; c.x = RR(0, XMAX) - XMAX / 2;
      c.dx = c.x > 0 ? -RR(0.5, 2) : RR(0.5, 2);
      c.dy = -RR(0.5, 2);
    } else if (rnd < 0.5) {               // from the bottom
      c.y = -YMAX / 2; c.x = RR(0, XMAX) - XMAX / 2;
      c.dx = c.x > 0 ? -RR(0.5, 2) : RR(0.5, 2);
      c.dy = RR(0.5, 2);
    } else if (rnd < 0.75) {              // from the left
      c.x = -XMAX / 2; c.y = RR(0, YMAX) - YMAX / 2;
      c.dx = RR(0.5, 2);
      c.dy = c.y > 0 ? -RR(0.5, 2) : RR(0.5, 2);
    } else {                              // from the right
      c.x = XMAX / 2; c.y = RR(0, YMAX) - YMAX / 2;
      c.dx = -RR(0.5, 2);
      c.dy = c.y > 0 ? -RR(0.5, 2) : RR(0.5, 2);
    }
    c.z = RR(0, 7) - 9;
    c.rotx = f_rand(); c.roty = f_rand(); c.rotz = f_rand();
    c.drot = f_rand() * 3;
    c.rdeg = 0;
    c.dz = f_rand() * 2 - 1;   // set by the .c but never used for motion
    // normalized tumble axis (guard the degenerate all-near-zero case)
    _axis.set(c.rotx, c.roty, c.rotz);
    if (_axis.lengthSq() < 1e-9) _axis.set(0, 1, 0);
    _axis.normalize();
    c.axis = _axis.clone();

    const type = rng.random() % 11;
    c.type = type;
    const B = makeBuilder(builderWin);
    let led = null;
    if (type < 1) buildResistor(B);
    else if (type < 2) buildDiode(B);
    else if (type < 3) buildTransistor(B);
    else if (type < 4) buildCapacitor(B);
    else if (type < 5) buildIC(B);
    else if (type < 6) led = buildLED(B, componentCanLight);
    else if (type < 7) buildFuse(B);
    else if (type < 8) buildRCA(B);
    else if (type < 9) buildThreeFive(B);
    else if (type < 10) buildSwitch(B);
    else buildDisp(B);

    // assemble the group: one mesh per material bucket + the decal quads.
    const group = new THREE.Group();
    const disposables = { geoms: [], mats: [], texs: [] };
    for (const bk of B.buckets) {
      if (!bk.pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(bk.nor, 3));
      const m = makeMat(bk.spec);
      if (bk.spec.alpha != null) { /* translucent parts drawn after opaque */ }
      const mesh = new THREE.Mesh(g, m);
      if (bk.spec.alpha != null) mesh.renderOrder = 2;
      group.add(mesh);
      disposables.geoms.push(g); disposables.mats.push(m);
    }
    for (const dc of B.decals) {
      const d = makeDecalMesh(dc.text, dc.w, dc.h, dc.lines);
      d.mesh.matrixAutoUpdate = false;
      d.mesh.matrix.copy(dc.matrix);
      group.add(d.mesh);
      disposables.geoms.push(d.geom); disposables.mats.push(d.mat); disposables.texs.push(d.tex);
    }
    c.group = group;
    c.disposables = disposables;
    c.led = led;
    if (led && led.lit) { lightActive = true; litComp = c; }
    componentsGroup.add(group);
    return c;
  }

  function disposeComponent(c) {
    componentsGroup.remove(c.group);
    for (const g of c.disposables.geoms) g.dispose();
    for (const m of c.disposables.mats) m.dispose();
    for (const t of c.disposables.texs) t.dispose();
    if (litComp === c) { litComp = null; lightActive = false; ledLight.intensity = 0; }
  }

  // Pre-populate the field with `count` parts at random in-view positions and spin
  // phases. DEVIATION from the .c (which starts empty and drifts parts in from the
  // edges over ~a minute): the web host is browsed by sampling hacks briefly, so an
  // empty-for-a-minute start reads as broken. This seeds the steady state the .c
  // reaches after running a while -- parts still drift, exit, and respawn normally.
  function initialFill() {
    const n = Math.max(1, Math.round(config.count));
    for (let i = 0; i < n; i++) {
      const c = makeComponent();   // spawns at an edge with its drift velocity
      // advance it a random fraction of its time-to-exit so parts are scattered
      // ALONG their trajectories across the field (the .c's steady state) -- some
      // just entering, some central, some near exit; only the central band is
      // visible, exactly as when the original has been running a while.
      let kx = Infinity, ky = Infinity;
      if (c.dx > 0) kx = (XMAX / 2 - c.x) / (c.dx * MOVE_MULT);
      else if (c.dx < 0) kx = (-XMAX / 2 - c.x) / (c.dx * MOVE_MULT);
      if (c.dy > 0) ky = (YMAX / 2 - c.y) / (c.dy * MOVE_MULT);
      else if (c.dy < 0) ky = (-YMAX / 2 - c.y) / (c.dy * MOVE_MULT);
      const kmax = Math.max(0, Math.min(kx, ky));
      const k = f_rand() * kmax;
      c.x += c.dx * MOVE_MULT * k;
      c.y += c.dy * MOVE_MULT * k;
      c.rdeg = f_rand() * 360;
      c.group.position.set(c.x, c.y, c.z);   // position now (frame 0); the move loop keeps it up to date
      components.push(c);   // TRACK it -- else it's in the scene but the move loop never visits it,
                            // so it renders stuck at the group origin (0,0,0) and reinit() can't clear it
    }
  }

  // ---- sizing (reshape_circuit: the frustum + YMAX + portrait-fit scale) ----
  let portraitFit = 1;
  let builderWin = 1000;
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    const hRatio = h / w;                        // reshape's h = winH/winW
    camera.aspect = w / h;
    camera.fov = 2 * Math.atan(hRatio / 1.5) / DEG;
    camera.updateProjectionMatrix();
    YMAX = XMAX * hRatio;                         // ci->YMAX = XMAX * h
    // display()'s glScalef: s = (w<h ? w/h : 1); s = 1/s.
    portraitFit = (w < h) ? (h / w) : 1;
    builderWin = Math.max(w, h);                  // ci->win_w/h for nsegs
    buildGrid();
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- discrete per-original-frame events (spawn, roving-spot start) ----
  function originalFrame() {
    const maxparts = Math.max(1, Math.round(config.count));
    // roving spot start (drawgrid): faster chance when the scene is spinning.
    if (!spotActive) {
      if (f_rand() < (config.speed > 0 ? 0.05 : 0.01)) {
        spotDir = Math.trunc(RR(0, 4));
        spotDs = RR(0.4, 0.8);
        if (spotDir === 0) { spotX = -XMAX / 2; spotY = Math.trunc(RR(0, YMAX / 2)) * 2 - YMAX / 2; }
        else if (spotDir === 1) { spotX = XMAX / 2; spotY = Math.trunc(RR(0, YMAX / 2)) * 2 - YMAX / 2; }
        else if (spotDir === 2) { spotY = YMAX / 2; spotX = Math.trunc(RR(0, XMAX / 2)) * 2 - XMAX / 2; }
        else { spotY = -YMAX / 2; spotX = Math.trunc(RR(0, XMAX / 2)) * 2 - XMAX / 2; }
        spotActive = true;
      }
    }
    // spawn: ~5% chance per frame to add ONE component into a free slot.
    if (f_rand() < 0.05 && components.length < maxparts) {
      components.push(makeComponent());
    }
  }

  // ---- render loop ----
  let raf = 0, last = 0, paused = false, ms = 16;
  let accum = 0;
  let builtRender = config.render;

  function applyRenderMode() {
    if (config.render === 'flat') {
      mainLight.intensity = 0;
      ambient.intensity = Math.PI;             // full flat colour
      lightActive = true;                      // block LED light claims (uselight==0)
      ledLight.intensity = 0;
    } else {
      mainLight.intensity = 0.8 * Math.PI;
      ambient.intensity = 0.2 * Math.PI;
      if (!litComp) lightActive = false;
    }
    builtRender = config.render;
  }
  applyRenderMode();
  initialFill();

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    if (config.render !== builtRender) applyRenderMode();

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;

    // discrete events, ticked at the original cadence (catch-up capped).
    accum += frames;
    let ticks = 0;
    while (accum >= 1 && ticks < MAX_TICKS) { originalFrame(); accum -= 1; ticks++; }
    if (ticks === MAX_TICKS) accum = 0;

    // whole-scene slow spin (0.01 * rotate-speed deg / frame).
    sceneRot.rotation.z += 0.01 * config.speed * frames * DEG;
    scaleG.scale.setScalar(portraitFit);

    // continuous per-component motion: drift (dx,dy * MOVE_MULT) + tumble (rdeg).
    const doSpin = config.spin;
    for (let i = components.length - 1; i >= 0; i--) {
      const c = components[i];
      if (doSpin) c.rdeg += c.drot * frames;
      c.x += c.dx * MOVE_MULT * frames;
      c.y += c.dy * MOVE_MULT * frames;
      c.group.position.set(c.x, c.y, c.z);
      c.group.quaternion.setFromAxisAngle(c.axis, (c.baseAngle + c.rdeg) * DEG);
      // exit when it drifts past the XMAX/YMAX box.
      if (c.x > XMAX / 2 || c.x < -XMAX / 2 || c.y > YMAX / 2 || c.y < -YMAX / 2) {
        disposeComponent(c);
        components.splice(i, 1);
      }
    }
    // trim if `count` was lowered well below the live set (extras finish drifting).
    const maxparts = Math.max(1, Math.round(config.count));
    while (components.length > maxparts + 4) {
      disposeComponent(components.shift());
    }

    // the lit LED (if any) drives the shared coloured light.
    if (litComp && config.render !== 'flat') {
      ledLight.position.set(litComp.x, litComp.y, litComp.z);
      ledLight.color.setRGB(litComp.led.r, litComp.led.g, litComp.led.b, THREE.SRGBColorSpace);
      ledLight.intensity = 0.9 * Math.PI;
    } else {
      ledLight.intensity = 0;
    }

    // roving spot motion.
    if (spotActive) {
      spotMesh.visible = true;
      spotMesh.position.set(spotX, spotY, -10);
      if (spotDir === 0) { spotX += spotDs * frames; if (spotX > XMAX / 2) spotActive = false; }
      else if (spotDir === 1) { spotX -= spotDs * frames; if (spotX < -XMAX / 2) spotActive = false; }
      else if (spotDir === 2) { spotY -= spotDs * frames; if (spotY < -YMAX / 2) spotActive = false; }
      else { spotY += spotDs * frames; if (spotY > YMAX / 2) spotActive = false; }
    } else {
      spotMesh.visible = false;
    }

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  function reinit() {
    for (const c of components.slice()) disposeComponent(c);
    components.length = 0;
    litComp = null;
    lightActive = (config.render === 'flat');
    ledLight.intensity = 0;
    spotActive = false;
    accum = 0;
    initialFill();
  }

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      for (const c of components.slice()) disposeComponent(c);
      components.length = 0;
      if (gridMesh) { gridMesh.geometry.dispose(); gridMesh.material.dispose(); }
      if (gridMesh2) { gridMesh2.geometry.dispose(); gridMesh2.material.dispose(); }
      spotGeom.dispose(); spotMat.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit,
    config,
    params,
  };
}

export default { title, info, start };
