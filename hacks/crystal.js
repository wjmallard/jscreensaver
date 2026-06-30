// crystal.js — crystal packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's crystal.c (Jouk Jansen, 1997).
// https://www.jwz.org/xscreensaver/
//
// Moving polygons that obey 2D plane-group (wallpaper) symmetry. A few small
// polygons (rectangles / squares / triangles) drift and spin inside ONE
// primitive unit cell; that motif is replicated across the screen by the
// rotation / reflection / glide / centring operations of one of the 17 planar
// crystallographic groups, then tiled over an nx*ny lattice of cells. The cell
// is sheared for oblique (gamma 60-120) and hexagonal (gamma 120) groups, and
// optionally outlined as a unit cell / full grid.
//
// Rendering: SPARSE vector. Each atom's symmetry copies are convex polygons
// filled on the canvas — one Path2D + one ctx.fill() per atom, so fills bucket
// by colour (the braid.js / penrose.js idiom). The whole field is cleared and
// redrawn every frame, as crystal.c does under HAVE_JWXYZ. (The C also XOR-mixes
// overlapping polygons within a frame, via GXxor; this plain-fill port does not
// reproduce that overlap mixing — see the .md.)
//
// See [[penrose]] (5-D integer wallpaper tiling) and [[truchet]] (square-cell
// tiling) for the closest technique twins.

import {
  makeRandomColormapRGB,
  makeSmoothColormapRGB,
  makeUniformColormapRGB,
} from './colormap.js';

export const title = 'crystal';

export const info = {
  author: 'Jouk Jansen',
  description: 'Moving polygons, similar to a kaleidoscope.\n\nSee also the "Kaleidescope" and "GLeidescope" screen savers.\n\nhttps://en.wikipedia.org/wiki/Kaleidoscope',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/crystal.xml (1:1 with the original); `delay` is
  // the STOCK value and the loop adds a measured OVERHEAD (see the .md Timing
  // section). `cycles` restores xlockmore's periodic regeneration (see the .md).
  const config = {
    delay: 60000,    // microseconds between steps (--delay, xml/C default 60000)
    ncolors: 100,    // size of the hue palette (--ncolors)
    count: 500,      // max number of on-screen objects (--count, xml -500)
    nx: 3,           // max number of unit cells across (--nx, xml -3)
    ny: 3,           // max number of unit cells down (--ny, xml -3)
    size: 15,        // max atom (polygon) size (C *size: -15)
    cycles: 400,     // steps before a fresh crystal is rolled (xlockmore cycles)
    cell: true,      // draw the unit-cell outline (--cell)
    grid: false,     // draw the whole grid of cells, not just one (--grid)
    centre: false,   // force the cell to be centred on screen (--centre)
    cycle: false,    // colour cycling (C DEF_CYCLE True, but off on TrueColor)
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes the lattice / colours, so a change re-runs
  //                init() via reinit() (a clean black canvas + a fresh crystal).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 60000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 100, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'count', label: 'Max objects', type: 'range', min: 1, max: 1000, step: 1, default: 500, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'nx', label: 'Horizontal symmetries', type: 'range', min: 1, max: 8, step: 1, default: 3, live: false },
    { key: 'ny', label: 'Vertical symmetries', type: 'range', min: 1, max: 8, step: 1, default: 3, live: false },
    { key: 'size', label: 'Atom size', type: 'range', min: 1, max: 40, step: 1, default: 15, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'cycles', label: 'New crystal after', type: 'range', min: 50, max: 3000, step: 50, default: 400, unit: ' steps', live: true },
    { key: 'cell', label: 'Draw cell', type: 'checkbox', default: true, live: true },
    { key: 'grid', label: 'Draw full grid', type: 'checkbox', default: false, live: true },
    { key: 'centre', label: 'Center on screen', type: 'checkbox', default: false, live: false },
    { key: 'cycle', label: 'Color cycling', type: 'checkbox', default: false, live: true },
  ];

  // ---- Constants from the C ------------------------------------------------
  const PI_RAD = Math.PI / 180.0;
  const MIN_CELL = 200;
  const DEF_NUM_ATOM = 10;
  const DEF_SIZ_ATOM = 10;
  const T = Math.trunc;   // C's (int) cast truncates toward zero.

  // Symmetry tables (copied verbatim from crystal.c — these are DATA; a wrong
  // entry breaks the tiling). Indexed by plane group 0..16.

  // Is the group centrosymmetric? (adds an inversion copy of every atom).
  const centro = [
    false,   // 0
    true,    // 1
    false,   // 2
    false,   // 3
    false,   // 4
    true,    // 5
    true,    // 6
    true,    // 7
    true,    // 8
    true,    // 9
    true,    // 10
    true,    // 11
    false,   // 12
    false,   // 13
    false,   // 14
    true,    // 15
    true,    // 16
  ];

  // Is the cell primitive? (false = centred: adds a half-cell-shifted copy).
  const primitive = [
    true,    // 0
    true,    // 1
    true,    // 2
    true,    // 3
    false,   // 4
    true,    // 5
    true,    // 6
    true,    // 7
    false,   // 8
    true,    // 9
    true,    // 10
    true,    // 11
    true,    // 12
    true,    // 13
    true,    // 14
    true,    // 15
    true,    // 16
  ];

  // For group g, the symmetry operations run j in [numops[2g+1], numops[2g]).
  const numops = [
    1, 0,    // 0
    1, 0,    // 1
    9, 7,    // 2
    2, 0,    // 3
    9, 7,    // 4
    9, 7,    // 5
    4, 2,    // 6
    5, 3,    // 7
    9, 7,    // 8
    8, 6,    // 9
    10, 6,   // 10
    8, 4,    // 11
    16, 13,  // 12
    19, 13,  // 13
    16, 10,  // 14
    19, 13,  // 15
    19, 13,  // 16
  ];

  // Symmetry operations: 19 rows of [a, b, c, d, e, f]. The 2x2 matrix
  // [[a,b],[c,d]] is applied to a cell coordinate; e,f add a half-cell glide
  // (e*a/2, f*b/2). Copied verbatim from crystal.c's operation[114].
  const operation = [
    1, 0, 0, 1, 0, 0,      // 0  identity
    -1, 0, 0, 1, 0, 1,     // 1  glide (-x, y + b/2)
    -1, 0, 0, 1, 1, 0,     // 2  (-x + a/2, y)
    1, 0, 0, 1, 0, 0,      // 3  identity
    -1, 0, 0, 1, 1, 1,     // 4  (-x + a/2, y + b/2)
    1, 0, 0, 1, 1, 1,      // 5  (x + a/2, y + b/2)
    0, -1, 1, 0, 0, 0,     // 6  90 deg rotation
    1, 0, 0, 1, 0, 0,      // 7  identity
    -1, 0, 0, 1, 0, 0,     // 8  mirror x
    0, 1, 1, 0, 0, 0,      // 9  diagonal mirror
    -1, 0, -1, 1, 0, 0,    // 10
    1, -1, 0, -1, 0, 0,    // 11
    0, 1, 1, 0, 0, 0,      // 12
    0, -1, 1, -1, 0, 0,    // 13 120 deg rotation (hexagonal)
    -1, 1, -1, 0, 0, 0,    // 14
    1, 0, 0, 1, 0, 0,      // 15 identity
    0, -1, -1, 0, 0, 0,    // 16
    -1, 1, 0, 1, 0, 0,     // 17
    1, 0, 1, -1, 0, 0,     // 18
  ];

  // ---- State ---------------------------------------------------------------
  let S = 1;                  // devicePixelRatio
  let win_w, win_h;           // logical (CSS) px window size
  let planegroup, invert;     // 0..16, and 0/1 y-axis flip
  let gamma, cg, sg;          // cell angle and cos/sin of (gamma - 90)
  let A, B;                   // per-cell width / height (a/nx, b/ny)
  let cell_nx, cell_ny;       // lattice cell counts
  let offset_w, offset_h;     // screen placement of the cell origin
  let num_atom;               // number of motif atoms
  let atoms;                  // the atoms
  let ncolors;                // palette size
  let palette;                // per-run colormap.js palette (rgb() strings)
  let gridPixel;              // colour index for the cell/grid outline
  let inx, iny;               // which single cell to outline (cell mode)
  let direction, colorPhase;  // colour-cycling state
  let cellMin;                // min cell dimension
  let stepCount;              // steps since last regeneration

  // NRAND(n): uniform integer in [0, n); guards n <= 0 (the C's macro returns 0).
  const nrand = (n) => (n > 0 ? Math.floor(Math.random() * n) : 0);

  // ---- Coordinate transforms (verbatim from crystal.c) ---------------------

  // Cell -> "un-sheared" storage coords (trans_coor). src/dst are {x,y} arrays
  // of np+1 points (the last duplicating the first).
  function transCoor(src, np) {
    const dst = [];
    for (let i = 0; i <= np; i++) {
      dst[i] = {
        x: src[i].x + T(src[i].y * sg),
        y: T(src[i].y / cg),
      };
    }
    return dst;
  }

  // Cell coords -> device-px screen point (trans_coor_back + offsets + invert,
  // then scaled by the devicePixelRatio).
  function cellPoint(xc, yc) {
    let sy = T(yc * cg) + offset_h;
    const sx = xc - T(yc * sg) + offset_w;
    if (invert) sy = win_h - sy;
    return [sx * S, sy * S];
  }

  // ---- Motif setup (crystal_setupatom) -------------------------------------
  function setupAtom(atom) {
    const s = atom.size_at;
    const ca = Math.cos(atom.angle);
    const sa = Math.sin(atom.angle);
    const y0 = T(atom.y0 * cg);
    const x0 = atom.x0 - T(atom.y0 * sg);
    const xy = [];
    switch (atom.at_type) {
      case 0:   // rectangles (2:1)
        xy[0] = { x: x0 + T(2 * s * ca) + T(s * sa), y: y0 + T(s * ca) - T(2 * s * sa) };
        xy[1] = { x: x0 + T(2 * s * ca) - T(s * sa), y: y0 - T(s * ca) - T(2 * s * sa) };
        xy[2] = { x: x0 - T(2 * s * ca) - T(s * sa), y: y0 - T(s * ca) + T(2 * s * sa) };
        xy[3] = { x: x0 - T(2 * s * ca) + T(s * sa), y: y0 + T(s * ca) + T(2 * s * sa) };
        xy[4] = { x: xy[0].x, y: xy[0].y };
        atom.xy = transCoor(xy, 4);
        return;
      case 1:   // squares (1.5)
        xy[0] = { x: x0 + T(1.5 * s * ca) + T(1.5 * s * sa), y: y0 + T(1.5 * s * ca) - T(1.5 * s * sa) };
        xy[1] = { x: x0 + T(1.5 * s * ca) - T(1.5 * s * sa), y: y0 - T(1.5 * s * ca) - T(1.5 * s * sa) };
        xy[2] = { x: x0 - T(1.5 * s * ca) - T(1.5 * s * sa), y: y0 - T(1.5 * s * ca) + T(1.5 * s * sa) };
        xy[3] = { x: x0 - T(1.5 * s * ca) + T(1.5 * s * sa), y: y0 + T(1.5 * s * ca) + T(1.5 * s * sa) };
        xy[4] = { x: xy[0].x, y: xy[0].y };
        atom.xy = transCoor(xy, 4);
        return;
      case 2:   // triangles
        xy[0] = { x: x0 + T(1.5 * s * sa), y: y0 + T(1.5 * s * ca) };
        xy[1] = { x: x0 + T(1.5 * s * ca) - T(1.5 * s * sa), y: y0 - T(1.5 * s * ca) - T(1.5 * s * sa) };
        xy[2] = { x: x0 - T(1.5 * s * ca) - T(1.5 * s * sa), y: y0 - T(1.5 * s * ca) + T(1.5 * s * sa) };
        xy[3] = { x: xy[0].x, y: xy[0].y };
        atom.xy = transCoor(xy, 3);
        return;
    }
  }

  // ---- Drawing (crystal_drawatom) ------------------------------------------

  // Append every nx*ny lattice copy of the cell-space polygon `xy` (np+1 points)
  // to `path`, transformed to device-px screen coords.
  function emitLattice(xy, np, path) {
    for (let l = 0; l < cell_nx; l++) {
      for (let m = 0; m < cell_ny; m++) {
        const ox = l * A;
        const oy = m * B;
        for (let k = 0; k < np; k++) {
          const xc = xy[k].x + ox;
          const yc = xy[k].y + oy;
          let sy = T(yc * cg) + offset_h;
          const sx = xc - T(yc * sg) + offset_w;
          if (invert) sy = win_h - sy;
          const dx = sx * S;
          const dy = sy * S;
          if (k === 0) path.moveTo(dx, dy);
          else path.lineTo(dx, dy);
        }
        path.closePath();
      }
    }
  }

  // Build the full symmetry orbit of one atom into `path` (one colour per atom).
  function drawAtom(atom, path) {
    const np = atom.num_point;
    for (let j = numops[2 * planegroup + 1]; j < numops[2 * planegroup]; j++) {
      const o0 = operation[j * 6];
      const o1 = operation[j * 6 + 1];
      const o2 = operation[j * 6 + 2];
      const o3 = operation[j * 6 + 3];
      const o4 = operation[j * 6 + 4];
      const o5 = operation[j * 6 + 5];

      // Translation that brings the transformed atom centre back into the cell.
      let xtrans = o0 * atom.x0 + o1 * atom.y0 + T(o4 * A / 2.0);
      let ytrans = o2 * atom.x0 + o3 * atom.y0 + T(o5 * B / 2.0);
      if (xtrans < 0) xtrans = (xtrans < -A) ? 2 * A : A;
      else if (xtrans >= A) xtrans = -A;
      else xtrans = 0;
      if (ytrans < 0) ytrans = B;
      else if (ytrans >= B) ytrans = -B;
      else ytrans = 0;

      // Transform the polygon vertices by the same operation.
      const xy = [];
      for (let k = 0; k < np; k++) {
        xy[k] = {
          x: o0 * atom.xy[k].x + o1 * atom.xy[k].y + T(o4 * A / 2.0) + xtrans,
          y: o2 * atom.xy[k].x + o3 * atom.xy[k].y + T(o5 * B / 2.0) + ytrans,
        };
      }
      xy[np] = { x: xy[0].x, y: xy[0].y };

      emitLattice(xy, np, path);

      // Centrosymmetric groups: add the inverted copy (mutates xy in place,
      // exactly as the C does, so the centred block below sees the inversion).
      if (centro[planegroup]) {
        for (let k = 0; k <= np; k++) {
          xy[k].x = A - xy[k].x;
          xy[k].y = B - xy[k].y;
        }
        emitLattice(xy, np, path);
      }

      // Centred (non-primitive) groups: add the half-cell-shifted copy (and, if
      // also centro, its inversion).
      if (!primitive[planegroup]) {
        const xt = (xy[np].x >= A / 2.0) ? T(-A / 2.0) : T(A / 2.0);
        const yt = (xy[np].y >= B / 2.0) ? T(-B / 2.0) : T(B / 2.0);
        for (let k = 0; k <= np; k++) {
          xy[k].x += xt;
          xy[k].y += yt;
        }
        emitLattice(xy, np, path);
        if (centro[planegroup]) {
          const xy1 = [];
          for (let k = 0; k <= np; k++) {
            xy1[k] = { x: A - xy[k].x, y: B - xy[k].y };
          }
          emitLattice(xy1, np, path);
        }
      }
    }
  }

  // Outline the unit cell (single random cell) or the whole grid of cells.
  function drawCell() {
    const path = new Path2D();
    if (config.grid) {
      for (let j = 0; j <= cell_ny; j++) {
        const p0 = cellPoint(0, j * B);
        const p1 = cellPoint(cell_nx * A, j * B);
        path.moveTo(p0[0], p0[1]);
        path.lineTo(p1[0], p1[1]);
      }
      for (let i = 0; i <= cell_nx; i++) {
        const p0 = cellPoint(i * A, 0);
        const p1 = cellPoint(i * A, cell_ny * B);
        path.moveTo(p0[0], p0[1]);
        path.lineTo(p1[0], p1[1]);
      }
    } else {
      const c00 = cellPoint(inx * A, iny * B);
      const c10 = cellPoint((inx + 1) * A, iny * B);
      const c11 = cellPoint((inx + 1) * A, (iny + 1) * B);
      const c01 = cellPoint(inx * A, (iny + 1) * B);
      path.moveTo(c00[0], c00[1]);
      path.lineTo(c10[0], c10[1]);
      path.lineTo(c11[0], c11[1]);
      path.lineTo(c01[0], c01[1]);
      path.closePath();
    }
    ctx.strokeStyle = palette[gridPixel % ncolors];
    ctx.lineWidth = Math.max(1, S);
    ctx.stroke(path);
  }

  // ---- Colours -------------------------------------------------------------
  // crystal.c builds its OWN colormap each init (MI_IS_INSTALL is hard-wired
  // True on xscreensaver and ncolors=100 > 2, so the install branch always
  // runs), picking among three schemes per run: 1/10 make_random_colormap with
  // bright_p=True, else 1/2 make_uniform_colormap, else make_smooth_colormap
  // -> ~10% bright-random / ~45% uniform / ~45% smooth. So the live palette is a
  // LIMITED, often muted/pastel per-run map (not a fixed full-saturation
  // rainbow). ncolors <= 2 is the mono path -> white (MI_WHITE_PIXEL). Faithful
  // ports of all three live in colormap.js. Re-rolled every init, so a plain
  // Math.random stream reproduces the distribution (see colormap.js).
  function buildPalette() {
    palette = new Array(ncolors);
    if (ncolors <= 2) {
      palette.fill('#fff');
      return;
    }
    let cm;
    if (nrand(10) === 0) cm = makeRandomColormapRGB(ncolors, true);   // ~10% bright random
    else if (nrand(2) === 0) cm = makeUniformColormapRGB(ncolors);    // ~45% uniform hue ramp
    else cm = makeSmoothColormapRGB(ncolors);                         // ~45% smooth HSV loop
    for (let i = 0; i < ncolors; i++) {
      palette[i] = 'rgb(' + cm[i][0] + ',' + cm[i][1] + ',' + cm[i][2] + ')';
    }
  }

  function colorFor(colour) {
    const idx = (((colour + colorPhase) % ncolors) + ncolors) % ncolors;
    return palette[idx];
  }

  // ---- Init (init_crystal) -------------------------------------------------
  function init() {
    S = window.devicePixelRatio || 1;
    win_w = canvas.width / S;
    win_h = canvas.height / S;
    stepCount = 0;

    ncolors = Math.max(2, config.ncolors | 0);
    buildPalette();

    cellMin = Math.min(T(win_w / 2) + 1, MIN_CELL);
    cellMin = Math.min(cellMin, T(win_h / 2) + 1);
    if (cellMin < 1) cellMin = 1;

    planegroup = nrand(17);
    invert = nrand(2);
    if (planegroup > 11) gamma = 120.0;
    else if (planegroup < 2) gamma = 60.0 + nrand(60);
    else gamma = 90.0;
    cg = Math.cos((gamma - 90) * PI_RAD);
    sg = Math.sin((gamma - 90) * PI_RAD);

    let neqv = numops[2 * planegroup] - numops[2 * planegroup + 1];
    if (centro[planegroup]) neqv *= 2;
    if (!primitive[planegroup]) neqv *= 2;

    // nx / ny: the C's defaults are negative ("random up to |n|"); we treat the
    // positive config values the same way for per-crystal variety.
    cell_nx = nrand(config.nx) + 1;
    if (planegroup > 8) cell_ny = cell_nx;
    else cell_ny = nrand(config.ny) + 1;
    neqv *= cell_nx * cell_ny;

    // count: treated as the C's negative count (a maximum; the actual number is
    // random), then divided among the symmetry copies.
    const rawCount = config.count | 0;
    if (rawCount === 0) num_atom = DEF_NUM_ATOM;
    else num_atom = nrand(rawCount) + 1;
    if (neqv > 1) num_atom = T(num_atom / neqv) + 1;
    if (num_atom < 1) num_atom = 1;

    // Cell dimensions / placement (maxsize off — the default path).
    let aFull = 0;
    let bFull = 0;
    let maxRepeat = 10;
    offset_w = -1;
    while (maxRepeat-- > 0 &&
           (offset_w < 4 || T(offset_w - bFull * sg) < 4)) {
      bFull = nrand(T(win_h / cg) - cellMin) + cellMin;
      if (planegroup > 8) aFull = bFull;
      else aFull = nrand(win_w - cellMin) + cellMin;
      offset_w = T((win_w - (aFull - bFull * sg)) / 2.0);
    }
    offset_h = T((win_h - bFull * cg) / 2.0);
    if (!config.centre) {
      const n2 = 2 * offset_h;
      if (offset_h > 0) offset_h = nrand(n2);
      offset_w = T(win_w - aFull - bFull * Math.abs(sg));
      if (gamma > 90.0) {
        if (offset_w > 0) offset_w = nrand(offset_w) + T(bFull * sg);
        else offset_w = T(bFull * sg);
      } else if (offset_w > 0) {
        offset_w = nrand(offset_w);
      } else {
        offset_w = 0;
      }
    }

    // Atom size (the C's *size: -15 -> negative -> random sizes; we expose the
    // magnitude as config.size and re-derive the negative bound).
    let sizeAtom = Math.min(T(aFull / 40) + 1, T(bFull / 40) + 1);
    const miSize = -Math.max(1, config.size | 0);
    if (miSize < sizeAtom) {
      if (miSize < -sizeAtom) sizeAtom = -sizeAtom;
      else sizeAtom = miSize;
    }

    A = T(aFull / cell_nx);
    B = T(bFull / cell_ny);
    if (A < 1) A = 1;
    if (B < 1) B = 1;

    atoms = [];
    for (let i = 0; i < num_atom; i++) {
      const at_type = nrand(3);
      let sizeAt;
      if (sizeAtom === 0) sizeAt = DEF_SIZ_ATOM;
      else if (sizeAtom > 0) sizeAt = sizeAtom;
      else sizeAt = nrand(-sizeAtom) + 1;
      sizeAt++;
      const atom = {
        // C: NRAND(ncolors - 2) + 2 (skips the first two map entries); mono -> 1.
        colour: (ncolors > 2) ? nrand(ncolors - 2) + 2 : 1,
        x0: nrand(A),
        y0: nrand(B),
        velocity: [nrand(7) - 3, nrand(7) - 3],
        velocity_a: (nrand(7) - 3) * PI_RAD,
        angle: nrand(90) * PI_RAD,
        at_type: at_type,
        size_at: sizeAt,
        num_point: (at_type === 2) ? 3 : 4,
        xy: [],
      };
      setupAtom(atom);
      atoms.push(atom);
    }

    gridPixel = nrand(ncolors);
    inx = nrand(cell_nx);
    iny = nrand(cell_ny);
    direction = (Math.random() < 0.5) ? 1 : -1;
    colorPhase = 0;
  }

  // ---- One step (draw_crystal) ---------------------------------------------
  function step() {
    // Clear to black (the HAVE_JWXYZ double-buffered path; no GXxor erase).
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (config.cycle) {
      colorPhase += direction;
      if (nrand(1000) === 0) direction = -direction;
    }

    if (config.cell) drawCell();

    for (const atom of atoms) {
      // Random-walk the velocities (clamped), drift the position (wrapped to the
      // cell), and drift the spin angle — exactly as draw_crystal does.
      atom.velocity[0] += nrand(3) - 1;
      atom.velocity[0] = Math.max(-20, Math.min(20, atom.velocity[0]));
      atom.velocity[1] += nrand(3) - 1;
      atom.velocity[1] = Math.max(-20, Math.min(20, atom.velocity[1]));
      atom.x0 += atom.velocity[0];
      if (atom.x0 < 0) atom.x0 += A;
      else if (atom.x0 >= A) atom.x0 -= A;
      atom.y0 += atom.velocity[1];
      if (atom.y0 < 0) atom.y0 += B;
      else if (atom.y0 >= B) atom.y0 -= B;
      atom.velocity_a += (nrand(1001) - 500) / 2000;
      atom.angle += atom.velocity_a;
      setupAtom(atom);

      const path = new Path2D();
      drawAtom(atom, path);
      ctx.fillStyle = colorFor(atom.colour);
      ctx.fill(path);
    }

    // The C standalone runs one plane group forever; we restore xlockmore's
    // periodic regeneration (re-rolls the group, cell, motif, and colours) so a
    // long session keeps changing and the unbounded spin random-walk can't run
    // away. Set `cycles` very high to approximate the standalone's behaviour.
    stepCount++;
    if (stepCount >= config.cycles) init();
  }

  // ---- Resize / loop / lifecycle -------------------------------------------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // Rebuild after a non-live config change (clears the canvas, fresh crystal).
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // OVERHEAD: the live binary's *delay is a sleep FLOOR; its real per-frame cost
  // is delay + framework/compute, so effective fps is below 1e6/delay. Measured
  // off the live `-fps` overlay: 3 runs averaged ~14.0 fps at Load ~16% (delay-
  // bound), so OVERHEAD = round(1e6/14.0) - 60000 ~= 11600 us. See the .md.
  const OVERHEAD = 11600;

  // rAF lag-accumulator loop: one step() per (config.delay + OVERHEAD), banking
  // leftover time so the pace is the same at any refresh rate; cap catch-up so a
  // backgrounded tab can't burst.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, Math.max(delayMs, 1) * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();
  rafId = requestAnimationFrame(frame);

  return {
    stop() {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
    },
    pause() { cancelAnimationFrame(rafId); rafId = 0; },
    resume() { if (!rafId) { lastTime = 0; rafId = requestAnimationFrame(frame); } },
    reinit,   // fresh crystal with the current config
    config,
    params,
  };
}
