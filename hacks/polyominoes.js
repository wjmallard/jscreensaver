// polyominoes.js -- polyominoes packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's polyominoes.c (Stephen Montgomery-Smith, 2000;
// xlockmore/xscreensaver). https://www.jwz.org/xscreensaver/
//
// Repeatedly tries to completely tile a rectangle with irregularly-shaped
// polyomino puzzle pieces, animating the search. It is a genuine backtracking
// exact-cover solver: each step picks the MOST CONSTRAINED still-blank cell
// (the one the fewest pieces can cover), and tries to attach a piece there.
// On failure it detaches the most-recently-placed piece and tries the next
// option, exactly like the C. Pruning matches the C verbatim: every blank
// region's size must be a (combination of) multiple(s) of the piece size,
// the chessboard black/white balance must stay fillable, and (in identical-
// piece puzzles) a "reason to not attach" table jumps the backtrack straight
// past pieces that can never help. When a solution is found it holds, then
// backtracks to look for the next one; after `cycles` frames a fresh random
// puzzle is seeded. See [[squiral]] for the shared skeleton and [[penrose]]
// for the other incremental tiler (forced growth vs. exhaustive backtracking).

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'polyominoes';

export const info = {
  author: 'Stephen Montgomery-Smith',
  description: 'Repeatedly attempts to completely fill a rectangle with irregularly-shaped puzzle pieces.\n\nhttps://en.wikipedia.org/wiki/Polyomino',
  year: 2000,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/polyominoes.xml (1:1 with the original).
  const config = {
    delay: 10000,      // microseconds between solver steps (--delay, xml/stock 10000)
    cycles: 2000,      // frames before a fresh random puzzle (--cycles)
    ncolors: 64,       // size of the hue cycle pieces are coloured from (--ncolors)
    identical: false,  // use puzzles where every piece is the same shape (--identical)
  };

  // live: true  -> the loop reads config every step (applies instantly).
  // live: false -> the value sizes colours / selects the puzzle set, so a
  //                change re-runs initPuzzle() via reinit() (clears + re-seeds).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cycles', label: 'Duration', type: 'range', min: 500, max: 5000, step: 100, default: 2000, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'identical', label: 'Identical pieces', type: 'checkbox', default: false, live: false },
  ];

  // ---- Random helpers (the C's NRAND(n) = uniform int in [0, n)) -----------
  const NRAND = (n) => Math.floor(Math.random() * n);

  // random_permutation: a uniformly random permutation of 0..n-1 (verbatim).
  function randomPermutation(n) {
    const a = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const r = NRAND(n - i);
      let k = 0;
      while (a[k] !== -1) k++;
      for (let j = 0; j < r; j++) {
        k++;
        while (a[k] !== -1) k++;
      }
      a[k] = i;
    }
    return a;
  }

  // ---- Piece tables (transcribed verbatim from polyominoes.c) --------------
  // P(len, points, transform_len, transform_list[8], max_white). transform_list
  // entries name the rotations/reflections (see transform()); -1 = unused slot.
  function P(len, pts, tlen, tlist, maxw) {
    return {
      len: len,
      point: pts.map(([x, y]) => ({ x, y })),
      transform_len: tlen,
      transform_list: tlist.slice(),
      max_white: maxw,
    };
  }

  const tetromino = [
    P(4, [[0, 0], [1, 0], [2, 0], [3, 0]], 2, [0, 1, -1, -1, -1, -1, -1, -1], 2),
    P(4, [[0, 0], [1, 0], [2, 0], [2, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 2),
    P(4, [[0, 0], [1, 0], [1, 1], [2, 0]], 4, [0, 1, 2, 3, -1, -1, -1, -1], 3),
    P(4, [[0, 0], [1, 0], [1, 1], [2, 1]], 4, [0, 1, 4, 5, -1, -1, -1, -1], 2),
    P(4, [[0, 0], [0, 1], [1, 0], [1, 1]], 1, [0, -1, -1, -1, -1, -1, -1, -1], 2),
  ];

  const pentomino = [
    P(5, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]], 2, [0, 1, -1, -1, -1, -1, -1, -1], 3),
    P(5, [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(5, [[0, 0], [1, 0], [2, 0], [2, 1], [3, 0]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(5, [[0, 0], [1, 0], [2, -1], [2, 0], [2, 1]], 4, [0, 1, 2, 3, -1, -1, -1, -1], 3),
    P(5, [[0, 0], [1, 0], [2, 0], [2, 1], [3, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(5, [[0, 0], [1, 0], [1, 1], [2, 0], [2, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(5, [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]], 4, [0, 1, 2, 3, -1, -1, -1, -1], 3),
    P(5, [[0, 0], [1, -1], [1, 0], [2, 0], [2, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(5, [[0, 0], [0, 1], [1, 0], [2, 0], [2, 1]], 4, [0, 1, 2, 3, -1, -1, -1, -1], 3),
    P(5, [[0, 0], [0, 1], [1, 0], [2, -1], [2, 0]], 4, [0, 1, 4, 5, -1, -1, -1, -1], 3),
    P(5, [[0, 0], [1, -1], [1, 0], [1, 1], [2, 0]], 1, [0, -1, -1, -1, -1, -1, -1, -1], 4),
    P(5, [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]], 4, [0, 1, 2, 3, -1, -1, -1, -1], 3),
  ];

  const hexomino = [
    P(6, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]], 2, [0, 1, -1, -1, -1, -1, -1, -1], 3),
    P(6, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(6, [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [4, 0]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 4),
    P(6, [[0, 0], [1, 0], [2, 0], [2, 1], [3, 0], [4, 0]], 4, [0, 1, 2, 3, -1, -1, -1, -1], 3),
    P(6, [[0, 0], [1, 0], [2, 0], [3, -1], [3, 0], [3, 1]], 4, [0, 1, 2, 3, -1, -1, -1, -1], 4),
    P(6, [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [4, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(6, [[0, 0], [1, 0], [2, 0], [2, 1], [3, 0], [3, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(6, [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [3, 2]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(6, [[0, 0], [1, 0], [2, -1], [2, 0], [3, 0], [3, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(6, [[0, 0], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 4),
    P(6, [[0, 0], [1, -1], [1, 0], [2, 0], [3, 0], [3, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 4),
    P(6, [[0, 0], [0, 1], [1, 0], [2, 0], [3, 0], [3, 1]], 4, [0, 1, 2, 3, -1, -1, -1, -1], 3),
    P(6, [[0, 0], [0, 1], [1, 0], [2, 0], [3, -1], [3, 0]], 4, [0, 1, 4, 5, -1, -1, -1, -1], 3),
    P(6, [[0, 0], [1, 0], [2, -1], [2, 0], [2, 1], [3, 0]], 4, [0, 1, 2, 3, -1, -1, -1, -1], 4),
    P(6, [[0, 0], [1, 0], [1, 1], [2, 0], [2, 1], [3, 0]], 4, [0, 1, 2, 3, -1, -1, -1, -1], 3),
    P(6, [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [3, 0]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(6, [[0, 0], [1, -1], [1, 0], [2, 0], [2, 1], [3, 0]], 4, [0, 1, 4, 5, -1, -1, -1, -1], 3),
    P(6, [[0, 0], [1, 0], [2, -1], [2, 0], [2, 1], [3, -1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(6, [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [2, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(6, [[0, 0], [0, 1], [1, 0], [2, -1], [2, 0], [2, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 4),
    P(6, [[0, 0], [1, 0], [2, 0], [2, 1], [3, 1], [4, 1]], 4, [0, 1, 4, 5, -1, -1, -1, -1], 3),
    P(6, [[0, 0], [1, 0], [2, 0], [2, 1], [3, 1], [3, 2]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(6, [[0, 0], [1, 0], [1, 1], [2, 0], [2, 1], [3, 1]], 4, [0, 1, 4, 5, -1, -1, -1, -1], 4),
    P(6, [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [3, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 4),
    P(6, [[0, 0], [1, -1], [1, 0], [2, 0], [2, 1], [3, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 4),
    P(6, [[0, 0], [0, 1], [1, 0], [2, 0], [2, 1], [3, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(6, [[0, 0], [1, 0], [1, 1], [2, 0], [2, 1], [2, 2]], 4, [0, 1, 2, 3, -1, -1, -1, -1], 4),
    P(6, [[0, 0], [1, -1], [1, 0], [1, 1], [2, 0], [2, 1]], 4, [0, 1, 2, 3, -1, -1, -1, -1], 4),
    P(6, [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]], 2, [0, 1, -1, -1, -1, -1, -1, -1], 3),
    P(6, [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [3, 2]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(6, [[0, 0], [1, 0], [1, 2], [2, 0], [2, 1], [2, 2]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(6, [[0, 0], [0, 1], [1, -1], [1, 0], [2, 0], [2, 1]], 4, [0, 1, 2, 3, -1, -1, -1, -1], 3),
    P(6, [[0, 0], [0, 1], [1, 0], [2, -1], [2, 0], [3, -1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(6, [[0, 0], [0, 1], [1, -1], [1, 0], [2, -1], [2, 0]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3),
    P(6, [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2], [3, 2]], 4, [0, 1, 4, 5, -1, -1, -1, -1], 3),
  ];

  // Single-shape templates used by the identical-piece puzzles.
  const pentomino1 = P(5, [[0, 0], [1, 0], [2, 0], [3, 0], [1, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 3);
  const hexomino1 = P(6, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [1, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 4);
  const heptomino1 = P(7, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [1, 1], [2, 1]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 4);
  const elevenomino1 = P(11, [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [3, 1], [0, 2], [1, 2], [2, 2], [3, 2]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 6);
  const dekomino1 = P(10, [[1, -1], [1, 0], [0, 1], [1, 1], [2, 1], [3, 1], [0, 2], [1, 2], [2, 2], [3, 2]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 5);
  const octomino1 = P(8, [[1, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2], [3, 2]], 8, [0, 1, 2, 3, 4, 5, 6, 7], 5);

  // make_one_sided_*: split each piece whose transform_list contains a
  // reflection (a value >= 4) into two one-sided pieces -- the rotations-only
  // prefix and the reflected suffix shifted to the front (verbatim).
  function cloneTemplate(s) {
    return {
      len: s.len,
      point: s.point.map((p) => ({ x: p.x, y: p.y })),
      transform_len: s.transform_len,
      transform_list: s.transform_list.slice(),
      max_white: s.max_white,
    };
  }

  function makeOneSided(srcArr) {
    const out = [];
    for (let i = 0; i < srcArr.length; i++) {
      const a = cloneTemplate(srcArr[i]);
      let split = false;
      for (let t = 0; t < 8; t++) {
        if (a.transform_list[t] >= 4) {
          a.transform_len = t;
          out.push(a);
          const b = cloneTemplate(srcArr[i]);
          for (let u = t; u < 8; u++) b.transform_list[u - t] = b.transform_list[u];
          b.transform_len = b.transform_len - t;
          out.push(b);
          split = true;
          break;
        }
      }
      if (!split) out.push(a);
    }
    return out;
  }

  // ---- State (the polyominoesstruct fields we keep) ------------------------
  let gw, gh;                  // puzzle rectangle dimensions (cells)
  let nr_polyominoes;
  let polyomino;               // working pieces (array of objects)
  let array;                   // Int32Array gw*gh: -1 blank, >=0 piece index
  let attach_list;             // Int32Array: stack of attached piece indices
  let nr_attached;
  let reason;                  // Int32Array nr*nr (identical-mode pruning)
  let identical, rot180;
  let left_right, top_bottom;  // which corner the search biases toward
  let box, xMargin, yMargin;   // screen layout (device px)
  let use3D, useBitmaps;       // render mode (use3D: 75% per puzzle, like the C's fullrandom NRAND(4); bitmaps only when box>=12)
  let masks, boardImg, bmG, bmT; // 256 per-adjacency 1-bit tile masks + the board pixel buffer + the border's G/T
  let palette, paletteRGB, colorOf, borderColorRGB; // hue strings + numeric RGB + per-piece index + the border hue
  let counter, wait;
  let checkOk;                 // puzzle-specific pruning predicate

  // Neighbour-edge bits for the bitmap index (polyominoes.c lines 191-198).
  const LEFT = 1, RIGHT = 2, UP = 4, DOWN = 8;
  const LEFT_UP = 16, LEFT_DOWN = 32, RIGHT_UP = 64, RIGHT_DOWN = 128;

  // Array accessors mirroring the C's ARRAY / ARR macros.
  const A = (x, y) => array[x * gh + y];
  const setA = (x, y, v) => { array[x * gh + y] = v; };
  const ARR = (x, y) => ((x < 0 || x >= gw || y < 0 || y >= gh) ? -2 : array[x * gh + y]);

  const REASON = (r, c) => reason[r * nr_polyominoes + c];
  const setREASON = (r, c, v) => { reason[r * nr_polyominoes + c] = v; };
  const clearReasonRow = (r) => {
    for (let c = 0; c < nr_polyominoes; c++) reason[r * nr_polyominoes + c] = 0;
  };

  // ---- Polyomino geometry --------------------------------------------------

  // transform(): one of 8 rotations/reflections of (in - offset), translated to
  // attach_point. Returned as a fresh point (verbatim from the C switch).
  function transform(inp, offset, t, ap) {
    const dx = inp.x - offset.x;
    const dy = inp.y - offset.y;
    switch (t) {
      case 0: return { x: dx + ap.x, y: dy + ap.y };
      case 1: return { x: -(dy) + ap.x, y: dx + ap.y };
      case 2: return { x: -(dx) + ap.x, y: -(dy) + ap.y };
      case 3: return { x: dy + ap.x, y: -(dx) + ap.y };
      case 4: return { x: -(dx) + ap.x, y: dy + ap.y };
      case 5: return { x: dy + ap.x, y: dx + ap.y };
      case 6: return { x: dx + ap.x, y: -(dy) + ap.y };
      case 7: return { x: -(dy) + ap.x, y: -(dx) + ap.y };
    }
    return { x: ap.x, y: ap.y };
  }

  // permApply(): build a working piece from a template, applying the given
  // point / transform permutations (copy_polyomino). The permutations only
  // reorder the search, never the cells; sharing perms across a rot180 pair
  // keeps the two halves consistent, exactly as the C reuses perm_point.
  function permApply(src, pPerm, tPerm) {
    const dst = {
      len: src.len,
      max_white: src.max_white,
      point: new Array(src.len),
      transform_len: src.transform_len,
      transform_list: new Array(8).fill(-1),
      attached: 0,
      color: 0,
      attach_point: { x: 0, y: 0 },
      point_no: 0,
      transform_index: 0,
    };
    for (let i = 0; i < src.len; i++) {
      const sp = src.point[pPerm[i]];
      dst.point[i] = { x: sp.x, y: sp.y };
    }
    for (let i = 0; i < src.transform_len; i++) {
      dst.transform_list[i] = src.transform_list[tPerm[i]];
    }
    return dst;
  }

  const permRandom = (src) => permApply(src, randomPermutation(src.len), randomPermutation(src.transform_len));

  // ---- Search helpers ------------------------------------------------------

  function firstPolyNo() {
    let p = 0;
    while (p < nr_polyominoes && polyomino[p].attached) p++;
    return p;
  }

  // next_poly_no as a pure function (used by score_point's loop).
  function nextPolyNoVal(p) {
    if (identical) return nr_polyominoes;
    do { p++; } while (p < nr_polyominoes && polyomino[p].attached);
    return p;
  }

  // next_attach_try: advance (transform_index, point_no, poly_no); returns 0
  // when the options for the current blank are exhausted (verbatim).
  function nextAttachTry(cur) {
    cur.transform_index++;
    if (cur.transform_index >= polyomino[cur.poly_no].transform_len) {
      cur.transform_index = 0;
      cur.point_no++;
      if (cur.point_no >= polyomino[cur.poly_no].len) {
        cur.point_no = 0;
        cur.poly_no = nextPolyNoVal(cur.poly_no);
        if (cur.poly_no >= nr_polyominoes) {
          cur.poly_no = firstPolyNo();
          return 0;
        }
      }
    }
    return 1;
  }

  // ---- Pruning: connected blank regions + chessboard balance ---------------

  // Iterative flood fill of the -1 region containing (x,y), marking cells with
  // `blankMark`; returns the region size. (The C recurses; an explicit stack
  // avoids a multi-thousand-deep call stack on the big boards -- same result.)
  const fillStackX = [];
  const fillStackY = [];
  function countAdjacentBlanks(x, y, blankMark) {
    let count = 0;
    let sp = 0;
    fillStackX[sp] = x; fillStackY[sp] = y; sp++;
    while (sp > 0) {
      sp--;
      const cx = fillStackX[sp];
      const cy = fillStackY[sp];
      if (cx < 0 || cx >= gw || cy < 0 || cy >= gh) continue;
      if (array[cx * gh + cy] !== -1) continue;
      count++;
      array[cx * gh + cy] = blankMark;
      fillStackX[sp] = cx - 1; fillStackY[sp] = cy; sp++;
      fillStackX[sp] = cx + 1; fillStackY[sp] = cy; sp++;
      fillStackX[sp] = cx; fillStackY[sp] = cy - 1; sp++;
      fillStackX[sp] = cx; fillStackY[sp] = cy + 1; sp++;
    }
    return count;
  }

  function checkAllRegionsMultipleOf(n) {
    let good = 1;
    for (let x = 0; x < gw && good; x++) {
      for (let y = 0; y < gh && good; y++) {
        const count = countAdjacentBlanks(x, y, -2);
        good = count % n === 0 ? 1 : 0;
      }
    }
    for (let x = 0; x < gw; x++) for (let y = 0; y < gh; y++) if (A(x, y) === -2) setA(x, y, -1);
    return good;
  }

  function checkAllRegionsPositiveCombinationOf(m, n) {
    let good = 1;
    for (let x = 0; x < gw && good; x++) {
      for (let y = 0; y < gh && good; y++) {
        let count = countAdjacentBlanks(x, y, -2);
        good = 0;
        for (; count >= 0 && !good; count -= m) good = count % n === 0 ? 1 : 0;
      }
    }
    for (let x = 0; x < gw; x++) for (let y = 0; y < gh; y++) if (A(x, y) === -2) setA(x, y, -1);
    return good;
  }

  function findSmallestBlankComponent() {
    let blankMark = -10;
    let smallestMark = blankMark;
    let smallestSize = 1000000000;
    for (let x = 0; x < gw; x++) {
      for (let y = 0; y < gh; y++) {
        if (A(x, y) === -1) {
          const size = countAdjacentBlanks(x, y, blankMark);
          if (size < smallestSize) {
            smallestMark = blankMark;
            smallestSize = size;
          }
          blankMark--;
        }
      }
    }
    return smallestMark;
  }

  // whites_ok: with the rectangle chessboard-coloured, the remaining blank
  // black/white counts must stay within what the unattached pieces can cover.
  function whitesOk() {
    let whites = 0, blacks = 0, maxWhite = 0, minWhite = 0;
    for (let x = 0; x < gw; x++) {
      for (let y = 0; y < gh; y++) {
        if (A(x, y) === -1 && (x + y) % 2) whites++;
        if (A(x, y) === -1 && (x + y + 1) % 2) blacks++;
      }
    }
    for (let p = 0; p < nr_polyominoes; p++) {
      if (!polyomino[p].attached) {
        maxWhite += polyomino[p].max_white;
        minWhite += polyomino[p].len - polyomino[p].max_white;
      }
    }
    return (minWhite <= blacks && minWhite <= whites && blacks <= maxWhite && whites <= maxWhite);
  }

  // ---- score_point / find_blank (the most-constrained-cell heuristic) ------

  // How many distinct (piece, anchor, transform) placements cover (x,y)?
  // Returns 10000 for an interior cell with all 8 neighbours blank (lots of
  // room -> very low priority). Bails once the count reaches minScore.
  function scorePoint(x, y, minScore) {
    if (x >= 1 && x < gw - 1 && y >= 1 && y < gh - 1 &&
        A(x - 1, y - 1) < 0 && A(x - 1, y) < 0 && A(x - 1, y + 1) < 0 &&
        A(x + 1, y - 1) < 0 && A(x + 1, y) < 0 && A(x + 1, y + 1) < 0 &&
        A(x, y - 1) < 0 && A(x, y + 1) < 0) {
      return 10000;
    }
    let score = 0;
    const ap = { x, y };
    for (let poly_no = firstPolyNo(); poly_no < nr_polyominoes; poly_no = nextPolyNoVal(poly_no)) {
      if (polyomino[poly_no].attached) continue;
      const poly = polyomino[poly_no];
      for (let point_no = 0; point_no < poly.len; point_no++) {
        for (let ti = 0; ti < poly.transform_len; ti++) {
          let attachable = 1;
          for (let i = 0; i < poly.len; i++) {
            const tp = transform(poly.point[i], poly.point[point_no], poly.transform_list[ti], ap);
            if (!(tp.x >= 0 && tp.x < gw && tp.y >= 0 && tp.y < gh && A(tp.x, tp.y) < 0)) {
              attachable = 0;
              break;
            }
          }
          if (attachable) {
            score++;
            if (score >= minScore) return score;
          }
        }
      }
    }
    return score;
  }

  // find_blank: among the cells of the smallest blank component, pick the most
  // constrained one (lowest score), with a corner-bias tie-break (verbatim).
  function findBlank(point) {
    const blankMark = findSmallestBlankComponent();
    let worstScore = 1000000;
    point.x = 0;
    point.y = 0;
    for (let x = 0; x < gw; x++) {
      for (let y = 0; y < gh; y++) {
        if (A(x, y) === blankMark) {
          let score = 100 * scorePoint(x, y, worstScore);
          if (score > 0) {
            score += left_right ? 10 * x : 10 * (gw - 1 - x);
            score += top_bottom ? y : (gh - 1 - y);
          }
          if (score < worstScore) {
            point.x = x;
            point.y = y;
            worstScore = score;
          }
        }
      }
    }
    for (let x = 0; x < gw; x++) for (let y = 0; y < gh; y++) if (A(x, y) < 0) setA(x, y, -1);
  }

  // ---- attach / detach -----------------------------------------------------

  // detach the most-recently attached piece; overwrites cur + attach_point with
  // that piece's stored anchor so the search continues from there (verbatim).
  function detach(cur, attach_point, rot) {
    if (nr_attached === 0) return;
    nr_attached--;
    cur.poly_no = attach_list[nr_attached];
    const poly = polyomino[cur.poly_no];
    cur.point_no = poly.point_no;
    cur.transform_index = poly.transform_index;
    attach_point.x = poly.attach_point.x;
    attach_point.y = poly.attach_point.y;
    const tno = poly.transform_list[cur.transform_index] ^ (rot << 1);
    for (let i = 0; i < poly.len; i++) {
      const tp = transform(poly.point[i], poly.point[cur.point_no], tno, attach_point);
      setA(tp.x, tp.y, -1);
    }
    poly.attached = 0;
  }

  // Throwaway out-params for attach()'s own rollback detach.
  const scratchCur = { poly_no: 0, point_no: 0, transform_index: 0 };
  const scratchAp = { x: 0, y: 0 };

  // Try to attach piece poly_no so its point_no-th cell (under transform
  // transform_index, optionally 180-rotated) lands on attach_point. Returns 1
  // on success. In identical mode it records which piece blocked it
  // (reasonRow) so the backtrack can skip ahead (verbatim).
  function attach(poly_no, point_no, transform_index, attach_point, rot, reasonRow) {
    const ap = { x: attach_point.x, y: attach_point.y };
    if (rot) {
      ap.x = gw - 1 - ap.x;
      ap.y = gh - 1 - ap.y;
    }
    const poly = polyomino[poly_no];
    if (poly.attached) return 0;

    let attachable = 1;
    let worst = 1000000000;
    const tno = poly.transform_list[transform_index] ^ (rot << 1);

    for (let i = 0; i < poly.len; i++) {
      const tp = transform(poly.point[i], poly.point[point_no], tno, ap);
      if (!(tp.x >= 0 && tp.x < gw && tp.y >= 0 && tp.y < gh && A(tp.x, tp.y) === -1)) {
        if (identical) {
          attachable = 0;
          if (tp.x >= 0 && tp.x < gw && tp.y >= 0 && tp.y < gh &&
              A(tp.x, tp.y) >= 0 && A(tp.x, tp.y) < worst) {
            worst = A(tp.x, tp.y);
          }
        } else {
          return 0;
        }
      }
    }

    if (identical && !attachable) {
      if (worst < 1000000000) setREASON(reasonRow, worst, 1);
      return 0;
    }

    for (let i = 0; i < poly.len; i++) {
      const tp = transform(poly.point[i], poly.point[point_no], tno, ap);
      setA(tp.x, tp.y, poly_no);
    }

    attach_list[nr_attached] = poly_no;
    nr_attached++;
    poly.attached = 1;
    poly.point_no = point_no;
    poly.attach_point = { x: ap.x, y: ap.y };
    poly.transform_index = transform_index;

    if (!checkOk()) {
      detach(scratchCur, scratchAp, rot);
      return 0;
    }
    return 1;
  }

  // ---- One solver decision (the body of draw_polyominoes) ------------------
  function solveOneStep() {
    const cur = { poly_no: firstPolyNo(), point_no: 0, transform_index: 0 };
    let done = 0;
    let another = 1;
    const attach_point = { x: 0, y: 0 };
    findBlank(attach_point);
    if (identical && nr_attached < nr_polyominoes) clearReasonRow(nr_attached);

    while (!done) {
      if (nr_attached < nr_polyominoes) {
        while (!done && another) {
          done = attach(cur.poly_no, cur.point_no, cur.transform_index, attach_point, 0, nr_attached);
          if (done && rot180) {
            cur.poly_no = firstPolyNo();
            done = attach(cur.poly_no, cur.point_no, cur.transform_index, attach_point, 1, nr_attached - 1);
            if (!done) detach(cur, attach_point, 0);
          }
          if (!done) another = nextAttachTry(cur);
        }
      }

      if (identical) {
        if (!done) {
          if (nr_attached === 0) {
            done = 1;
          } else {
            let detachUntil = nr_attached - 1;
            if (nr_attached < nr_polyominoes) {
              while (detachUntil > 0 && REASON(nr_attached, detachUntil) === 0) detachUntil--;
            }
            while (nr_attached > detachUntil) {
              if (rot180) detach(cur, attach_point, 1);
              detach(cur, attach_point, 0);
              if (nr_attached + 1 + rot180 < nr_polyominoes) {
                for (let i = 0; i < nr_polyominoes; i++) {
                  setREASON(nr_attached, i, REASON(nr_attached, i) | REASON(nr_attached + 1 + rot180, i));
                }
              }
            }
            another = nextAttachTry(cur);
          }
        }
      } else {
        if (!done) {
          if (nr_attached === 0) {
            done = 1;
          } else {
            if (rot180) detach(cur, attach_point, 1);
            detach(cur, attach_point, 0);
          }
          another = nextAttachTry(cur);
        }
      }
    }
  }

  // ---- Puzzle setup (set_*_puzzle) -----------------------------------------

  function setPentominoPuzzle() {
    switch (NRAND(4)) {
      case 0: gw = 20; gh = 3; break;
      case 1: gw = 15; gh = 4; break;
      case 2: gw = 12; gh = 5; break;
      case 3: gw = 10; gh = 6; break;
    }
    nr_polyominoes = 12;
    polyomino = new Array(12);
    const perm = randomPermutation(12);
    for (let p = 0; p < 12; p++) polyomino[p] = permRandom(pentomino[perm[p]]);
    checkOk = () => checkAllRegionsMultipleOf(5) && whitesOk();
  }

  function setOneSidedPentominoPuzzle() {
    const osp = makeOneSided(pentomino);
    switch (NRAND(4)) {
      case 0: gw = 30; gh = 3; break;
      case 1: gw = 18; gh = 5; break;
      case 2: gw = 15; gh = 6; break;
      case 3: gw = 10; gh = 9; break;
    }
    nr_polyominoes = 18;
    polyomino = new Array(18);
    const perm = randomPermutation(18);
    for (let p = 0; p < 18; p++) polyomino[p] = permRandom(osp[perm[p]]);
    checkOk = () => checkAllRegionsMultipleOf(5) && whitesOk();
  }

  function setOneSidedHexominoPuzzle() {
    const osh = makeOneSided(hexomino);
    switch (NRAND(8)) {
      case 0: gw = 20; gh = 18; break;
      case 1: gw = 24; gh = 15; break;
      case 2: gw = 30; gh = 12; break;
      case 3: gw = 36; gh = 10; break;
      case 4: gw = 40; gh = 9; break;
      case 5: gw = 45; gh = 8; break;
      case 6: gw = 60; gh = 6; break;
      case 7: gw = 72; gh = 5; break;
    }
    nr_polyominoes = 60;
    polyomino = new Array(60);
    const perm = randomPermutation(60);
    for (let p = 0; p < 60; p++) polyomino[p] = permRandom(osh[perm[p]]);
    checkOk = () => checkAllRegionsMultipleOf(6) && whitesOk();
  }

  function setTetrPentominoPuzzle() {
    switch (NRAND(3)) {
      case 0: gw = 20; gh = 4; break;
      case 1: gw = 16; gh = 5; break;
      case 2: gw = 10; gh = 8; break;
    }
    nr_polyominoes = 17;
    polyomino = new Array(17);
    const perm = randomPermutation(17);
    for (let p = 0; p < tetromino.length; p++) polyomino[perm[p]] = permRandom(tetromino[p]);
    for (let p = 0; p < pentomino.length; p++) polyomino[perm[p + 5]] = permRandom(pentomino[p]);
    checkOk = () => checkAllRegionsPositiveCombinationOf(5, 4) && whitesOk();
  }

  function setPentHexominoPuzzle() {
    switch (NRAND(5)) {
      case 0: gw = 54; gh = 5; break;
      case 1: gw = 45; gh = 6; break;
      case 2: gw = 30; gh = 9; break;
      case 3: gw = 27; gh = 10; break;
      case 4: gw = 18; gh = 15; break;
    }
    nr_polyominoes = 47;
    polyomino = new Array(47);
    const perm = randomPermutation(47);
    for (let p = 0; p < pentomino.length; p++) polyomino[perm[p]] = permRandom(pentomino[p]);
    for (let p = 0; p < hexomino.length; p++) polyomino[perm[p + 12]] = permRandom(hexomino[p]);
    checkOk = () => checkAllRegionsPositiveCombinationOf(6, 5) && whitesOk();
  }

  // Identical-piece puzzles.

  function fillIdentical(n, template, check) {
    nr_polyominoes = n;
    polyomino = new Array(n);
    for (let p = 0; p < n; p++) polyomino[p] = permRandom(template);
    checkOk = check;
  }

  function fillIdenticalRot180(n, template, check) {
    rot180 = 1;
    nr_polyominoes = n;
    polyomino = new Array(n);
    for (let p = 0; p < n; p += 2) {
      const pPerm = randomPermutation(template.len);
      const tPerm = randomPermutation(template.transform_len);
      polyomino[p] = permApply(template, pPerm, tPerm);
      polyomino[p + 1] = permApply(template, pPerm, tPerm);
    }
    checkOk = check;
  }

  function setPentominoPuzzle1() {
    gw = 10; gh = 5;
    fillIdentical(10, pentomino1, () => checkAllRegionsMultipleOf(5) && whitesOk());
  }
  function setHexominoPuzzle1() {
    gw = 24; gh = 23;
    fillIdentical(92, hexomino1, () => checkAllRegionsMultipleOf(6) && whitesOk());
  }
  function setHeptominoPuzzle1() {
    gw = 26; gh = 21;
    fillIdenticalRot180(78, heptomino1, () => checkAllRegionsMultipleOf(7) && whitesOk());
  }
  function setHeptominoPuzzle2() {
    gw = 28; gh = 19;
    fillIdentical(76, heptomino1, () => checkAllRegionsMultipleOf(7) && whitesOk());
  }
  function setElevenominoPuzzle1() {
    gw = 25; gh = 22;
    fillIdenticalRot180(50, elevenomino1, () => checkAllRegionsMultipleOf(11) && whitesOk());
  }
  function setDekominoPuzzle1() {
    gw = 32; gh = 30;
    fillIdentical(96, dekomino1, () => checkAllRegionsMultipleOf(10) && whitesOk());
  }
  function setOctominoPuzzle1() {
    gw = 96; gh = 26;
    fillIdentical(312, octomino1, () => checkAllRegionsMultipleOf(8) && whitesOk());
  }
  function setPentominoPuzzle2() {
    gw = 15; gh = 15;
    fillIdentical(45, pentomino1, () => checkAllRegionsMultipleOf(5) && whitesOk());
  }
  function setElevenominoPuzzle2() {
    gw = 47; gh = 33;
    fillIdentical(141, elevenomino1, () => checkAllRegionsMultipleOf(11) && whitesOk());
  }

  // ---- Layout / colours ----------------------------------------------------

  function computeLayout() {
    const W = canvas.width;
    const H = canvas.height;
    const box1 = Math.floor(W / (gw + 2));
    const box2 = Math.floor(H / (gh + 2));
    box = Math.min(box1, box2);
    if (W > H * 5 || H > W * 5) {
      box = Math.floor(box * (W > H ? W / H : H / W));
    }
    if (box < 1) box = 1;
    // box>=12 -> round down to a multiple of 12 and use the 3-D dithered bitmap
    // tiles; smaller boxes fall back to flat rectangles (init_polyominoes ~2210).
    if (box >= 12) {
      box = Math.floor(box / 12) * 12;
      useBitmaps = true;
      buildMasks();
      boardImg = ctx.createImageData(box * gw, box * gh);
    } else {
      useBitmaps = false;
      masks = null;
      boardImg = null;
    }
    xMargin = Math.floor((W - box * gw) / 2);
    yMargin = Math.floor((H - box * gh) / 2);
  }

  // create_bitmaps (polyominoes.c ~786-979): precompute 256 box x box 1-bit
  // masks, one per 8-neighbour adjacency index n. 1-bits draw in the piece's
  // colour, 0-bits black. The body is dithered (HALFBIT etc. = a stipple that
  // blends the colour ~1/3..3/4 with black -> the dark 3-D body); the exposed
  // edges/corners are solid SETBIT walls -> the bright rim. Transcribed verbatim,
  // including the bit macros (lines 209-225), G/T/R/RT geometry (220-225), the
  // dedup aliasing (794-801), both the use3D and !use3D branches (810-835), and
  // the THREEQUARTERSBIT bellybutton (943-959; LARGE_BELLYBUTTON is not defined,
  // so the #else path -- the 3-D one -- is taken).
  function buildMasks() {
    const b = box;
    const G = Math.floor(b / 45) + 1;          // 1/2 of the gap between pieces
    const T = b <= 12 ? 1 : G * 2;             // wall thickness
    const R = b <= 12 ? 1 : G * 6;             // corner rounding amount
    const RT = b <= 12 ? 1 : G * 3;            // rounded-wall thickness
    const RR = 0;                              // roof-ridge thickness
    const half = b / 2;                        // box is a multiple of 12 -> exact
    bmG = G;
    bmT = T;

    masks = new Array(256);
    for (let n = 0; n < 256; n++) {
      // Avoid duplicating masks: a corner bit is redundant when either of its
      // two edges is already present -> alias to the simpler (smaller) index.
      if ((n & LEFT_UP) && ((n & LEFT) || (n & UP))) { masks[n] = masks[n & ~LEFT_UP]; continue; }
      if ((n & LEFT_DOWN) && ((n & LEFT) || (n & DOWN))) { masks[n] = masks[n & ~LEFT_DOWN]; continue; }
      if ((n & RIGHT_UP) && ((n & RIGHT) || (n & UP))) { masks[n] = masks[n & ~RIGHT_UP]; continue; }
      if ((n & RIGHT_DOWN) && ((n & RIGHT) || (n & DOWN))) { masks[n] = masks[n & ~RIGHT_DOWN]; continue; }

      const d = new Uint8Array(b * b);
      const isL = (n & LEFT) !== 0, isR = (n & RIGHT) !== 0, isU = (n & UP) !== 0, isD = (n & DOWN) !== 0;
      const isLU = (n & LEFT_UP) !== 0, isLD = (n & LEFT_DOWN) !== 0;
      const isRU = (n & RIGHT_UP) !== 0, isRD = (n & RIGHT_DOWN) !== 0;

      const SET = (x, y) => { d[x + y * b] = 1; };
      const RES = (x, y) => { d[x + y * b] = 0; };
      const HALF = (x, y) => { d[x + y * b] = ((x - y) % 2) ? 1 : 0; };
      const TWOTHIRDS = (x, y) => { d[x + y * b] = ((x + y - 1) % 3) ? 1 : 0; };
      const THIRD = (x, y) => { d[x + y * b] = (((x - y - 1) % 3) === 0) ? 1 : 0; };
      const THREEQ = (x, y) => { d[x + y * b] = ((y % 2) || ((x + 2 + Math.floor(y / 2) + 1) % 2)) ? 1 : 0; };

      // Base shading of the four triangles (top/left/right/bottom of the box).
      for (let y = 0; y < b; y++) for (let x = 0; x < b; x++) {
        if (!use3D) {
          HALF(x, y);
        } else if ((x >= y && x <= b - y - 1 && isU)
            || (x <= y && x <= b - y - 1 && y < half && !isL)
            || (x >= y && x >= b - y - 1 && y < half && !isR)) {
          SET(x, y);
        } else if ((x <= y && x <= b - y - 1 && isL)
            || (x >= y && x <= b - y - 1 && x < half && !isU)
            || (x <= y && x >= b - y - 1 && x < half && !isD)) {
          TWOTHIRDS(x, y);
        } else if ((x >= y && x >= b - y - 1 && isR)
            || (x >= y && x <= b - y - 1 && x >= half && !isU)
            || (x <= y && x >= b - y - 1 && x >= half && !isD)) {
          HALF(x, y);
        } else if ((x <= y && x >= b - y - 1 && isD)
            || (x <= y && x <= b - y - 1 && y >= half && !isL)
            || (x >= y && x >= b - y - 1 && y >= half && !isR)) {
          THIRD(x, y);
        }
      }

      // Solid bright walls along present edges, then clear the outer gap.
      if (isL) { for (let y = 0; y < b; y++) for (let x = G; x < G + T; x++) SET(x, y); }
      if (isR) { for (let y = 0; y < b; y++) for (let x = G; x < G + T; x++) SET(b - 1 - x, y); }
      if (isU) { for (let x = 0; x < b; x++) for (let y = G; y < G + T; y++) SET(x, y); }
      if (isD) { for (let x = 0; x < b; x++) for (let y = G; y < G + T; y++) SET(x, b - 1 - y); }
      if (isL) { for (let y = 0; y < b; y++) for (let x = 0; x < G; x++) RES(x, y); }
      if (isR) { for (let y = 0; y < b; y++) for (let x = 0; x < G; x++) RES(b - 1 - x, y); }
      if (isU) { for (let x = 0; x < b; x++) for (let y = 0; y < G; y++) RES(x, y); }
      if (isD) { for (let x = 0; x < b; x++) for (let y = 0; y < G; y++) RES(x, b - 1 - y); }

      // Rounded corners where two edges meet.
      if (isL && isU) { for (let x = G; x <= G + R; x++) for (let y = G; y <= R + 2 * G - x; y++) { if (x + y > R + 2 * G - RT) SET(x, y); else RES(x, y); } }
      if (isL && isD) { for (let x = G; x <= G + R; x++) for (let y = G; y <= R + 2 * G - x; y++) { if (x + y > R + 2 * G - RT) SET(x, b - 1 - y); else RES(x, b - 1 - y); } }
      if (isR && isU) { for (let x = G; x <= G + R; x++) for (let y = G; y <= R + 2 * G - x; y++) { if (x + y > R + 2 * G - RT) SET(b - 1 - x, y); else RES(b - 1 - x, y); } }
      if (isR && isD) { for (let x = G; x <= G + R; x++) for (let y = G; y <= R + 2 * G - x; y++) { if (x + y > R + 2 * G - RT) SET(b - 1 - x, b - 1 - y); else RES(b - 1 - x, b - 1 - y); } }

      // Concave-corner wall stubs: diagonal neighbour differs, but no straight edge.
      if (!isL && !isU && isLU) {
        for (let x = 0; x < G; x++) for (let y = 0; y < G; y++) RES(x, y);
        for (let x = G; x < G + T; x++) for (let y = 0; y < G; y++) SET(x, y);
        for (let x = 0; x < G + T; x++) for (let y = G; y < G + T; y++) SET(x, y);
      }
      if (!isL && !isD && isLD) {
        for (let x = 0; x < G; x++) for (let y = 0; y < G; y++) RES(x, b - 1 - y);
        for (let x = G; x < G + T; x++) for (let y = 0; y < G; y++) SET(x, b - 1 - y);
        for (let x = 0; x < G + T; x++) for (let y = G; y < G + T; y++) SET(x, b - 1 - y);
      }
      if (!isR && !isU && isRU) {
        for (let x = 0; x < G; x++) for (let y = 0; y < G; y++) RES(b - 1 - x, y);
        for (let x = G; x < G + T; x++) for (let y = 0; y < G; y++) SET(b - 1 - x, y);
        for (let x = 0; x < G + T; x++) for (let y = G; y < G + T; y++) SET(b - 1 - x, y);
      }
      if (!isR && !isD && isRD) {
        for (let x = 0; x < G; x++) for (let y = 0; y < G; y++) RES(b - 1 - x, b - 1 - y);
        for (let x = G; x < G + T; x++) for (let y = 0; y < G; y++) SET(b - 1 - x, b - 1 - y);
        for (let x = 0; x < G + T; x++) for (let y = G; y < G + T; y++) SET(b - 1 - x, b - 1 - y);
      }

      // 3-D bellybutton: brighten (3/4 dither) interior quadrants that continue
      // the piece on both that edge and the diagonal (use3D only).
      if (use3D) {
        if (!isL && !isU && !isLU) { for (let x = 0; x < half - RR; x++) for (let y = 0; y < half - RR; y++) THREEQ(x, y); }
        if (!isL && !isD && !isLD) { for (let x = 0; x < half - RR; x++) for (let y = half + RR; y < b; y++) THREEQ(x, y); }
        if (!isR && !isU && !isRU) { for (let x = half + RR; x < b; x++) for (let y = 0; y < half - RR; y++) THREEQ(x, y); }
        if (!isR && !isD && !isRD) { for (let x = half + RR; x < b; x++) for (let y = half + RR; y < b; y++) THREEQ(x, y); }
      }

      masks[n] = d;
    }
  }

  function buildColors() {
    const np = Math.max(2, config.ncolors);
    // SMOOTH_COLORS: polyominoes.c is an xlockmore hack with a `#define
    // SMOOTH_COLORS`, so xlockmore.c builds its colormap with
    // make_smooth_colormap -- 2-5 random HSV anchors interpolated into a closed
    // loop (muted/pastel, often just two hues), NOT a vivid full-saturation hue
    // ramp. Pieces index this map exactly as the C does (perm + start offset,
    // below). Re-rolled per puzzle, like penrose re-rolls its colormap per
    // tiling restart. (The C's mono path -- fewer than 12 colours -> solid
    // black/white tiles -- is not reproduced; see polyominoes.md.)
    const cm = makeSmoothColormapRGB(np);
    paletteRGB = cm;
    palette = cm.map(([r, g, b]) => `rgb(${r},${g},${b})`);
    // border_color = MI_PIXEL(NRAND(MI_NPIXELS)) -- a random map colour (init ~2247).
    borderColorRGB = cm[NRAND(np)];
    colorOf = new Array(nr_polyominoes);
    const perm = randomPermutation(nr_polyominoes);
    const start = NRAND(np);
    for (let i = 0; i < nr_polyominoes; i++) {
      colorOf[i] = (Math.floor(perm[i] * np / nr_polyominoes) + start) % np;
      if (rot180) {
        colorOf[i + 1] = colorOf[i];
        i++;
      }
    }
  }

  // ---- init / render -------------------------------------------------------

  function initPuzzle() {
    rot180 = 0;
    counter = 0;
    identical = config.identical;
    // The live binary is always fullrandom (xlockmore.c:518), so use3D = NRAND(4):
    // 3-D dithered tiles 75% of puzzles, the flatter HALFBIT bitmap the other 25%.
    use3D = NRAND(4) !== 0;

    if (identical) {
      switch (NRAND(9)) {
        case 0: setPentominoPuzzle1(); break;
        case 1: setHexominoPuzzle1(); break;
        case 2: setHeptominoPuzzle1(); break;
        case 3: setHeptominoPuzzle2(); break;
        case 4: setElevenominoPuzzle1(); break;
        case 5: setDekominoPuzzle1(); break;
        case 6: setOctominoPuzzle1(); break;
        case 7: setPentominoPuzzle2(); break;
        case 8: setElevenominoPuzzle2(); break;
      }
    } else {
      switch (NRAND(5)) {
        case 0: setPentominoPuzzle(); break;
        case 1: setOneSidedPentominoPuzzle(); break;
        case 2: setOneSidedHexominoPuzzle(); break;
        case 3: setPentHexominoPuzzle(); break;
        case 4: setTetrPentominoPuzzle(); break;
      }
    }

    // Rotate the board to match a portrait window.
    if (canvas.height > canvas.width) {
      const swap = gh;
      gh = gw;
      gw = swap;
    }

    attach_list = new Int32Array(nr_polyominoes);
    nr_attached = 0;
    if (identical) reason = new Int32Array(nr_polyominoes * nr_polyominoes);
    array = new Int32Array(gw * gh).fill(-1);

    left_right = NRAND(2);
    top_bottom = NRAND(2);

    computeLayout();
    buildColors();
    wait = 0;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Full-board repaint. draw_with_bitmaps redraws every filled cell each frame
  // anyway (blanks only when changed), so a full repaint is faithful; the C's
  // changed_array (delta tracking) is dropped. See render() for the dispatch.
  function render() {
    if (useBitmaps) renderBitmaps();
    else renderFlat();
  }

  // draw_with_bitmaps (polyominoes.c ~981-1023): each filled cell blits its
  // adjacency mask (1-bit -> piece colour, 0-bit -> black) into the board pixel
  // buffer; blank cells are black. Then the border rectangle in border_color.
  function renderBitmaps() {
    const b = box;
    const Wb = b * gw;
    const data = boardImg.data;
    for (let cx = 0; cx < gw; cx++) {
      const baseX = b * cx;
      for (let cy = 0; cy < gh; cy++) {
        const baseY = b * cy;
        const v = A(cx, cy);
        if (v < 0) {
          for (let my = 0; my < b; my++) {
            let di = ((baseY + my) * Wb + baseX) * 4;
            for (let mx = 0; mx < b; mx++) { data[di] = 0; data[di + 1] = 0; data[di + 2] = 0; data[di + 3] = 255; di += 4; }
          }
          continue;
        }
        // bitmap_index from the 8 neighbours (lines 1001-1008); ARR()=-2 off-board.
        let idx = 0;
        if (v !== ARR(cx - 1, cy)) idx |= LEFT;
        if (v !== ARR(cx + 1, cy)) idx |= RIGHT;
        if (v !== ARR(cx, cy - 1)) idx |= UP;
        if (v !== ARR(cx, cy + 1)) idx |= DOWN;
        if (v !== ARR(cx - 1, cy - 1)) idx |= LEFT_UP;
        if (v !== ARR(cx - 1, cy + 1)) idx |= LEFT_DOWN;
        if (v !== ARR(cx + 1, cy - 1)) idx |= RIGHT_UP;
        if (v !== ARR(cx + 1, cy + 1)) idx |= RIGHT_DOWN;
        const mask = masks[idx];
        const rgb = paletteRGB[colorOf[v]];
        const r = rgb[0], g = rgb[1], bl = rgb[2];
        for (let my = 0; my < b; my++) {
          let di = ((baseY + my) * Wb + baseX) * 4;
          const mrow = my * b;
          for (let mx = 0; mx < b; mx++) {
            if (mask[mrow + mx]) { data[di] = r; data[di + 1] = g; data[di + 2] = bl; }
            else { data[di] = 0; data[di + 1] = 0; data[di + 2] = 0; }
            data[di + 3] = 255;
            di += 4;
          }
        }
      }
    }
    ctx.putImageData(boardImg, xMargin, yMargin);

    // Border: T nested 1-px rectangles, offset t+1 outward (lines 1018-1022).
    const [br, bg, bb] = borderColorRGB;
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = `rgb(${br},${bg},${bb})`;
    for (let t = bmG; t < bmG + bmT; t++) {
      ctx.strokeRect(xMargin - t - 1 + 0.5, yMargin - t - 1 + 0.5, b * gw + 1 + 2 * t, b * gh + 1 + 2 * t);
    }
  }

  // draw_without_bitmaps (polyominoes.c ~700-784): the small-board (box<12) path
  // -- flat colour rectangles, then WHITE boundary lines between differing cells
  // and a WHITE board outline. (The black blank-blank cleanup segments are a
  // no-op under full repaint, so they are omitted.)
  function renderFlat() {
    for (let x = 0; x < gw; x++) {
      for (let y = 0; y < gh; y++) {
        const v = A(x, y);
        ctx.fillStyle = v < 0 ? '#000' : palette[colorOf[v]];
        ctx.fillRect(xMargin + box * x, yMargin + box * y, box, box);
      }
    }

    ctx.lineWidth = Math.floor(box / 10) + 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(xMargin, yMargin, box * gw, box * gh);

    ctx.beginPath();
    for (let x = 0; x < gw - 1; x++) {
      for (let y = 0; y < gh; y++) {
        if (A(x, y) !== A(x + 1, y)) {
          ctx.moveTo(xMargin + box * (x + 1), yMargin + box * y);
          ctx.lineTo(xMargin + box * (x + 1), yMargin + box * (y + 1));
        }
      }
    }
    for (let x = 0; x < gw; x++) {
      for (let y = 0; y < gh - 1; y++) {
        if (A(x, y) !== A(x, y + 1)) {
          ctx.moveTo(xMargin + box * x, yMargin + box * (y + 1));
          ctx.lineTo(xMargin + box * (x + 1), yMargin + box * (y + 1));
        }
      }
    }
    ctx.stroke();
  }

  // ---- Step (the per-frame body of draw_polyominoes) -----------------------
  function step() {
    if (config.cycles !== 0) {
      counter++;
      if (counter > config.cycles) {
        initPuzzle();
        return;
      }
    }
    if (box === 0) {
      initPuzzle();
      return;
    }

    wait--;
    if (wait > 0) return;

    solveOneStep();

    wait = (nr_attached === nr_polyominoes) ? 100 : 0;
    render();
  }

  // ---- Resize / loop / lifecycle -------------------------------------------

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    initPuzzle();
  }

  // Rebuild after a non-live config change (clears the canvas, fresh puzzle).
  function reinit() {
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    initPuzzle();
  }

  // rAF lag-accumulator loop: one step() per (config.delay + OVERHEAD), banking
  // leftover time so the pace is the same at any refresh rate; the catch-up cap
  // keeps a backgrounded tab (or a transiently heavy find_blank on a wide-open
  // board) from firing a burst of steps.
  //
  // OVERHEAD: the live binary's *delay (10000 us) is a sleep FLOOR; its real
  // frame is delay + the per-step solver compute (find_blank / score_point /
  // attach / repaint). The -fps overlay held the sleep floor at ~10000 us
  // across boards while fps swung 39-62 with the board's fill level (an emptier
  // board floods/scores more cells -> Load 60% -> ~39 fps; a near-full or
  // holding board -> Load 38% -> ~62 fps). The typical reading clustered at
  // 58.8 fps (= 17007 us/frame = 10000 floor + 7007 compute), so the faithful
  // per-step pace is (delay + 7007)/1000 ms; the port's own score_point compute
  // adds the same fill-level slowdown on the heavier boards.
  const OVERHEAD = 7007;
  const MAX_CATCHUP_STEPS = 4;
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
    reinit,   // fresh puzzle with the current config
    config,
    params,
  };
}
