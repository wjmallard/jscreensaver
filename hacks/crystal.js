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
// Rendering: SOFTWARE rasterizer into an offscreen RGBA buffer, blitted with one
// putImageData per frame. crystal.c draws with XSetFunction(GXxor) so overlapping
// cell copies BITWISE-XOR their pixel colours (mixed/complementary tones where
// different colours cross, black where identical copies cancel) — Canvas 2D has
// no bitwise XOR (its 'xor'/'difference' modes are alpha-coverage / |a-b|, not
// the real thing), so each cell polygon is scanline-filled writing `dst ^= colour`
// per channel, exactly mirroring the C's per-XFillPolygon XOR. The unit-cell /
// grid outline is drawn first in COPY mode (GXcopy, as in the C, before the atoms
// switch the GC to GXxor), so the atoms XOR over it. The buffer is cleared to
// black each frame, as crystal.c does under HAVE_JWXYZ (XClearWindow).
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
    cell: 'random',  // unit-cell outline: 'random' (the C's fullrandom -- 50% none /
                     // 25% one random cell / 25% full grid) | 'none' | 'one' | 'grid'
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
    { key: 'cell', label: 'Unit cell', type: 'select', default: 'random', live: false, options: [
        { value: 'random', label: 'Random (none / one / grid)' },
        { value: 'none', label: 'No cell' },
        { value: 'one', label: 'One cell' },
        { value: 'grid', label: 'Full grid' },
      ] },
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
  let palette;                // per-run colormap.js palette ([r,g,b] triplets)
  let gridPixel;              // colour index for the cell/grid outline
  let inx, iny;               // which single cell to outline (cell mode)
  let unitCell, gridCell;     // per-run cell decision (the C's fullrandom roll)
  let direction, colorPhase;  // colour-cycling state
  let cellMin;                // min cell dimension
  let stepCount;              // steps since last regeneration

  // Software XOR rasterizer state (see header / .md). The frame is composed in an
  // offscreen RGBA buffer (alpha kept 255) and blitted once with putImageData.
  let imageData, buf, buf32;  // ImageData, its Uint8 view, a Uint32 view (fast clear)
  let W = 0, H = 0;           // device-px buffer size (= canvas.width / height)
  let curR = 0, curG = 0, curB = 0;        // colour of the atom currently filling
  const sxScratch = new Float64Array(5);   // reused per-copy device-px vertex arrays
  const syScratch = new Float64Array(5);
  const xint = new Float64Array(8);         // reused scanline edge crossings

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

  // Rasterize every nx*ny lattice copy of the cell-space polygon `xy` (np points)
  // into device-px screen coords, calling `fill(xs, ys, np)` per copy. Each copy
  // is filled SEPARATELY (one XFillPolygon in the C), so two overlapping copies of
  // the same atom XOR-cancel — they must NOT be merged into a single path.
  function emitLattice(xy, np, fill) {
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
          sxScratch[k] = sx * S;
          syScratch[k] = sy * S;
        }
        fill(sxScratch, syScratch, np);
      }
    }
  }

  // Rasterize the full symmetry orbit of one atom, calling `fill` per polygon.
  function drawAtom(atom, fill) {
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

      emitLattice(xy, np, fill);

      // Centrosymmetric groups: add the inverted copy (mutates xy in place,
      // exactly as the C does, so the centred block below sees the inversion).
      if (centro[planegroup]) {
        for (let k = 0; k <= np; k++) {
          xy[k].x = A - xy[k].x;
          xy[k].y = B - xy[k].y;
        }
        emitLattice(xy, np, fill);
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
        emitLattice(xy, np, fill);
        if (centro[planegroup]) {
          const xy1 = [];
          for (let k = 0; k <= np; k++) {
            xy1[k] = { x: A - xy[k].x, y: B - xy[k].y };
          }
          emitLattice(xy1, np, fill);
        }
      }
    }
  }

  // Outline the unit cell (a single random cell) or the whole grid of cells, in
  // COPY mode into the buffer. The C draws this with the GC still in GXcopy, before
  // switching to GXxor for the atoms, so the atoms XOR over these lines.
  function drawCell() {
    const gc = palette[gridPixel % ncolors];
    const gr = gc[0], gg = gc[1], gb = gc[2];
    if (gridCell) {
      for (let j = 0; j <= cell_ny; j++) {
        const p0 = cellPoint(0, j * B);
        const p1 = cellPoint(cell_nx * A, j * B);
        drawLineCopy(p0[0], p0[1], p1[0], p1[1], gr, gg, gb);
      }
      for (let i = 0; i <= cell_nx; i++) {
        const p0 = cellPoint(i * A, 0);
        const p1 = cellPoint(i * A, cell_ny * B);
        drawLineCopy(p0[0], p0[1], p1[0], p1[1], gr, gg, gb);
      }
    } else {
      const c00 = cellPoint(inx * A, iny * B);
      const c10 = cellPoint((inx + 1) * A, iny * B);
      const c11 = cellPoint((inx + 1) * A, (iny + 1) * B);
      const c01 = cellPoint(inx * A, (iny + 1) * B);
      drawLineCopy(c00[0], c00[1], c10[0], c10[1], gr, gg, gb);
      drawLineCopy(c10[0], c10[1], c11[0], c11[1], gr, gg, gb);
      drawLineCopy(c11[0], c11[1], c01[0], c01[1], gr, gg, gb);
      drawLineCopy(c01[0], c01[1], c00[0], c00[1], gr, gg, gb);
    }
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
    if (ncolors <= 2) {
      // mono path (MI_WHITE_PIXEL): XOR of white over black = white, white over
      // white = black, so identical overlaps still cancel.
      palette = new Array(ncolors);
      for (let i = 0; i < ncolors; i++) palette[i] = [255, 255, 255];
      return;
    }
    // The colormap.js helpers return arrays of [r,g,b] byte triplets, which the
    // software rasterizer consumes directly (no rgb() string round-trip).
    if (nrand(10) === 0) palette = makeRandomColormapRGB(ncolors, true);   // ~10% bright random
    else if (nrand(2) === 0) palette = makeUniformColormapRGB(ncolors);    // ~45% uniform hue ramp
    else palette = makeSmoothColormapRGB(ncolors);                         // ~45% smooth HSV loop
  }

  function colorFor(colour) {
    const idx = (((colour + colorPhase) % ncolors) + ncolors) % ncolors;
    return palette[idx];
  }

  // ---- Software XOR / COPY rasterizer --------------------------------------
  // Canvas 2D cannot bitwise-XOR, so the frame is composed in `buf` (RGBA, alpha
  // kept 255 throughout) and blitted with putImageData. COPY writes dst = colour
  // (the cell outline, GXcopy); XOR writes dst ^= colour per channel (the atoms,
  // GXxor). XORing each RGB byte independently equals XORing the packed 24-bit
  // TrueColor pixel value the way the C's GXxor does.

  function setPxCopy(x, y, r, g, b) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;   // alpha left at 255
  }

  // 1-CSS-px (= round(S) device-px) Bresenham line, COPY mode.
  function drawLineCopy(x0, y0, x1, y1, r, g, b) {
    x0 = Math.round(x0); y0 = Math.round(y0);
    x1 = Math.round(x1); y1 = Math.round(y1);
    const w = Math.max(1, Math.round(S));
    const o = w >> 1;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      for (let yy = 0; yy < w; yy++)
        for (let xx = 0; xx < w; xx++)
          setPxCopy(x0 - o + xx, y0 - o + yy, r, g, b);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  // Scanline-fill a convex polygon (n device-px vertices), XOR mode. Each call is
  // one XFillPolygon equivalent: every interior pixel is XORed exactly once, so
  // two overlapping fills of the same colour cancel back to black. Pixel-centre
  // sampling with a half-open edge test (no double-XOR seams between neighbours).
  function fillPolyXor(xs, ys, n, r, g, b) {
    let ymin = Infinity, ymax = -Infinity;
    for (let i = 0; i < n; i++) {
      if (ys[i] < ymin) ymin = ys[i];
      if (ys[i] > ymax) ymax = ys[i];
    }
    let yStart = Math.ceil(ymin - 0.5);
    let yEnd = Math.floor(ymax - 0.5);
    if (yStart < 0) yStart = 0;
    if (yEnd > H - 1) yEnd = H - 1;
    for (let y = yStart; y <= yEnd; y++) {
      const yc = y + 0.5;
      let cnt = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ya = ys[i], yb = ys[j];
        if (ya === yb) continue;
        if ((yc >= ya && yc < yb) || (yc >= yb && yc < ya)) {
          const t = (yc - ya) / (yb - ya);
          if (cnt < xint.length) xint[cnt++] = xs[i] + t * (xs[j] - xs[i]);
        }
      }
      for (let a = 1; a < cnt; a++) {        // insertion sort (cnt is tiny: 2 for convex)
        const v = xint[a];
        let bi = a - 1;
        while (bi >= 0 && xint[bi] > v) { xint[bi + 1] = xint[bi]; bi--; }
        xint[bi + 1] = v;
      }
      for (let k = 0; k + 1 < cnt; k += 2) {
        let xL = Math.ceil(xint[k] - 0.5);
        let xR = Math.floor(xint[k + 1] - 0.5);
        if (xL < 0) xL = 0;
        if (xR > W - 1) xR = W - 1;
        let idx = (y * W + xL) * 4;
        for (let x = xL; x <= xR; x++) {
          buf[idx] ^= r; buf[idx + 1] ^= g; buf[idx + 2] ^= b;
          idx += 4;
        }
      }
    }
  }

  // Fill callback bound to the atom colour currently being drawn (avoids a
  // per-atom closure allocation in the step loop).
  function fillXorCur(xs, ys, n) { fillPolyXor(xs, ys, n, curR, curG, curB); }

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
    // Decide the unit-cell display per run. The C's init_crystal under fullrandom
    // (xscreensaver is ALWAYS fullrandom) rolls unit_cell 50/50, then grid 50/50
    // when on -- so 50% no cell, 25% one (random inx/iny) cell, 25% full grid. The
    // `cell` select can instead pin any single state.
    switch (config.cell) {
      case 'none': unitCell = false; gridCell = false; break;
      case 'one':  unitCell = true;  gridCell = false; break;
      case 'grid': unitCell = true;  gridCell = true;  break;
      default:     unitCell = Math.random() < 0.5;
                   gridCell = unitCell ? (Math.random() < 0.5) : false;
    }
    direction = (Math.random() < 0.5) ? 1 : -1;
    colorPhase = 0;
  }

  // ---- One step (draw_crystal) ---------------------------------------------
  function step() {
    // Clear the offscreen buffer to opaque black (the HAVE_JWXYZ XClearWindow).
    // 0xFF000000 = A:255 B:0 G:0 R:0 on little-endian (all target browsers).
    buf32.fill(0xFF000000);

    if (config.cycle) {
      colorPhase += direction;
      if (nrand(1000) === 0) direction = -direction;
    }

    // GXcopy pass: the cell / grid outline, drawn before the atoms XOR over it.
    if (unitCell) drawCell();

    // GXxor pass: every atom's symmetry orbit, XORed into the buffer.
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

      const c = colorFor(atom.colour);
      curR = c[0]; curG = c[1]; curB = c[2];
      drawAtom(atom, fillXorCur);
    }

    ctx.putImageData(imageData, 0, 0);

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
    W = canvas.width;
    H = canvas.height;
    imageData = ctx.createImageData(W, H);
    buf = imageData.data;
    buf32 = new Uint32Array(buf.buffer);
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
