// penrose.js — penrose packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's penrose.c (Timo Korvola, 1996; xscreensaver port by
// Jamie Zawinski, 1997). https://www.jwz.org/xscreensaver/
//
// Penrose's quasiperiodic rhombus tiling ("fat" 72/108 and "thin" 36/144
// rhombi) grown by FORCED tiling: the tiling spreads outward from a seed edge,
// and at each step a tile is added either to a vertex whose boundary can only be
// extended one way (a "forced" vertex) or, lacking those, to a random vertex
// with a randomly chosen legal tile. Tiles never overlap and no untiled pocket
// is ever sealed off (a candidate that would enclose a gap is rejected). When
// the fringe leaves the screen, fills it, or the growth wedges, it restarts.
//
// Rendering: rhombi are genuine filled quads (two random-RGB hues — fat vs thin — with
// a thin dark outline), added a few per step to the PERSISTENT (double-buffered)
// canvas, so like the C there is no full repaint; each tile is drawn once where
// it lands. Per step the new tiles are bucketed by type into two Path2D (fat /
// thin) and filled in two passes, then outlined — see braid.js for the bucketing
// idiom. The 5-D integer coordinate system from the C is kept verbatim so the
// geometry is exact (no rounding drift across thousands of tiles).

import { makeRandomColormapRGB } from './colormap.js';

export const title = 'penrose';

export const info = {
  author: 'Timo Korvola',
  description: 'Quasiperiodic tilings.\n\nIn April 1997, Sir Roger Penrose, a British math professor who has worked with Stephen Hawking on such topics as relativity, black holes, and whether time has a beginning, filed a copyright-infringement lawsuit against the Kimberly-Clark Corporation, which Penrose said copied a pattern he created (a pattern demonstrating that "a nonrepeating pattern could exist in nature") for its Kleenex quilted toilet paper. Penrose said he doesn\'t like litigation but, "When it comes to the population of Great Britain being invited by a multinational to wipe their bottoms on what appears to be the work of a Knight of the Realm, then a last stand must be taken."\n\nAs reported by News of the Weird #491, 4-Jul-1997.\n\nhttps://en.wikipedia.org/wiki/Penrose_tiling\nhttps://en.wikipedia.org/wiki/Tessellation',
  year: 1996,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/penrose.xml (1:1 with the original).
  const config = {
    delay: 10000,   // microseconds between growth steps (--delay, xml/stock 10000)
    size: 40,       // rhombus edge length in logical px (--size)
    ncolors: 64,    // hue-cycle size the fat/thin colours are drawn from (--ncolors)
    ammann: false,  // draw Ammann matching lines (--ammann)
  };

  // live: true  -> the loop reads config every step (applies instantly).
  // live: false -> the value sizes geometry/colours, so a change re-runs init()
  //                via reinit() (which also clears the canvas).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'size', label: 'Tile size', type: 'range', min: 5, max: 100, step: 1, default: 40, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'ammann', label: 'Draw ammann lines', type: 'checkbox', default: false, live: false },
  ];

  // ---- Constants from the C ------------------------------------------------
  const MINSIZE = 5;
  const MAX_TILES_PER_VERTEX = 7;
  const N_VERTEX_RULES = 8;

  // Pause lengths (in steps) the C uses to "celebrate" an event before restart.
  const CELEBRATE = 200;    // a dislocation / weirdness occurred (C: 31415)
  const COMPLETION = 120;   // tiles filled the screen (C: 3141)
  // (Shortened from the C's huge counts: at our delay those would freeze for
  // many seconds; ~2 s of hold reads as a deliberate pause, then it restarts.)

  // Sides, as seen looking OUT from a vertex into the untiled gap.
  const S_LEFT = 1;
  const S_RIGHT = 2;

  // Vertex-type encoding: bits 0-1 = corner (0..3), bit 2 = tile type.
  const VT_CORNER_MASK = 0x3;
  const VT_TYPE_MASK = 0x4;
  const VT_THIN = 0;
  const VT_THICK = 0x4;
  const VT_BITS = 3;
  const VT_TOTAL_MASK = 0x7;

  // Rotate the corner of a vertex type CCW / CW, or to the diagonal.
  const VT_LEFT = (vt) => (((vt - 1) & VT_CORNER_MASK) | (vt & VT_TYPE_MASK));
  const VT_RIGHT = (vt) => (((vt + 1) & VT_CORNER_MASK) | (vt & VT_TYPE_MASK));
  const VT_FAR = (vt) => (vt ^ 2);

  // Interior angle (in units of 36 degrees) at each corner of each tile type.
  // THIN  corners 0..3 -> 144,36,144,36 ; THICK corners 0..3 -> 72,108,72,108.
  const vtype_angles = [4, 1, 4, 1, 2, 3, 2, 3];
  const vtype_angle = (v) => vtype_angles[v];

  // fringe-changes result bits.
  const FC_BAG = 1;          // total enclosure; must never add such a tile.
  const FC_NEW_RIGHT = 2;
  const FC_NEW_FAR = 4;
  const FC_NEW_LEFT = 8;
  const FC_CUT_THIS = 0x10;
  const FC_CUT_RIGHT = 0x20;
  const FC_CUT_FAR = 0x40;
  const FC_CUT_LEFT = 0x80;

  // The eight legal vertex configurations (cyclic CCW sequences of tile types).
  // A vertex's current tiles must be a strict contiguous subsequence of one of
  // these. tile = type | corner.
  const vertex_rules = [
    { tiles: [VT_THICK | 2, VT_THICK | 2, VT_THICK | 2, VT_THICK | 2, VT_THICK | 2], n: 5 },
    { tiles: [VT_THICK | 0, VT_THICK | 0, VT_THICK | 0, VT_THICK | 0, VT_THICK | 0], n: 5 },
    { tiles: [VT_THICK | 0, VT_THICK | 0, VT_THICK | 0, VT_THIN | 0], n: 4 },
    { tiles: [VT_THICK | 2, VT_THICK | 2, VT_THIN | 1, VT_THIN | 3, VT_THICK | 2, VT_THIN | 1, VT_THIN | 3], n: 7 },
    { tiles: [VT_THICK | 2, VT_THICK | 2, VT_THICK | 2, VT_THICK | 2, VT_THIN | 1, VT_THIN | 3], n: 6 },
    { tiles: [VT_THICK | 1, VT_THICK | 3, VT_THIN | 2], n: 3 },
    { tiles: [VT_THICK | 0, VT_THIN | 0, VT_THIN | 0], n: 3 },
    { tiles: [VT_THICK | 2, VT_THIN | 1, VT_THICK | 3, VT_THICK | 1, VT_THIN | 3], n: 5 },
  ];

  // 5-D unit basis (filled lazily in init): basis[i] = (cos, sin) of i*72 deg.
  const fived_basis = [];

  // ---- State ---------------------------------------------------------------
  let S = 1;                 // devicePixelRatio
  let width, height;         // device-px canvas size
  let originX, originY;      // seed origin (device px)
  let edgeLength, lineWidth;
  let ammannR = 0;

  // The fringe: a doubly-linked ring of boundary vertices (next = LEFT/CCW
  // neighbour, prev = RIGHT/CW neighbour). `fringeNode` is one arbitrary node.
  // fringeN counts ON-SCREEN nodes only (used to detect "filled the screen").
  let fringeNode, fringeN;

  // Forced vertices: those whose boundary can be extended only one way on at
  // least one side. Kept as a plain array; each member carries `forcedSides`.
  // (The C uses an intrusive linked list with O(1) splice; an array is the same
  // behaviour — a random pick among forced / visible-forced vertices.)
  let forced;                // array of vertices
  let forcedVisible;         // count of on-screen forced vertices

  let done, failures, busyLoop;
  let thickColor, thinColor;
  let palette;

  // INTRAND helpers matching the C's NRAND(n) = uniform int in [0, n).
  const nrand = (n) => Math.floor(Math.random() * n);

  // ---- Geometry ------------------------------------------------------------

  // Project 5-D integer coords to device-px screen coords (X is y-down).
  function fivedToLoc(fived) {
    let ox = 0, oy = 0;
    for (let i = 0; i < 5; i++) {
      const r = fived[i] * edgeLength;
      ox += r * fived_basis[i][0];
      oy -= r * fived_basis[i][1];
    }
    return {
      x: originX + Math.round(ox),
      y: originY + Math.round(oy),
    };
  }

  // Step one edge in direction `dir` (0..9, in 36-deg units) in 5-D space.
  const dir2i = [0, 3, 1, 4, 2];
  function addUnitVec(dir, fived) {
    let d = dir;
    while (d < 0) d += 10;
    fived[dir2i[d % 5]] += (d % 2 ? -1 : 1);
  }

  // Direction (36-deg units) of the edge from `vertex` to its neighbour on
  // `side`. Returns -1 if the two vertices are not unit-adjacent (a weirdness
  // the C flags by setting done).
  function vertexDir(vertex, side) {
    const v2 = (side === S_LEFT ? vertex.next : vertex.prev);
    for (let i = 0; i < 5; i++) {
      const d = v2.fived[i] - vertex.fived[i];
      if (d === 1) return 2 * i;
      if (d === -1) return (2 * i + 5) % 10;
    }
    done = true;
    busyLoop = CELEBRATE;
    return -1;
  }

  function fivedEqual(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4];
  }

  // ---- Rule matching -------------------------------------------------------

  // Pack a vertex's tiles (3 bits each) into a number for hashing.
  function packTiles(tiles, n) {
    let h = 0;
    for (let i = 0; i < n; i++) h |= tiles[i] << (VT_BITS * i);
    return h;
  }

  // Find every rule whose cyclic tile sequence contains the vertex's current
  // tiles as a strict contiguous subsequence. Returns the match list and
  // narrows vertex.ruleMask to the rules that still apply. (Rabin-Karp window
  // slide, like the C.)
  function matchRules(vertex, matches, firstOnly) {
    const n_tiles = vertex.nTiles;
    let hits = 0;
    const goodRules = [];
    const lowerBitsMask = ~(VT_TOTAL_MASK << (VT_BITS * (n_tiles - 1)));
    let newRuleMask = 0;

    for (let i = 0; i < N_VERTEX_RULES; i++) {
      if (n_tiles >= vertex_rules[i].n) {
        vertex.ruleMask &= ~(1 << i);
      } else if (vertex.ruleMask & (1 << i)) {
        goodRules.push(i);
      }
    }
    const vertexHash = packTiles(vertex.tiles, n_tiles);

    for (let j = 0; j < goodRules.length; j++) {
      const ruleIdx = goodRules[j];
      const vr = vertex_rules[ruleIdx];
      let ruleHash = 0;
      for (let i = 0; i < n_tiles; i++) ruleHash |= vr.tiles[i] << (VT_BITS * i);
      if (ruleHash === vertexHash) {
        if (matches) matches[hits] = { rule: ruleIdx, pos: 0 };
        hits++;
        if (firstOnly) return hits;
        newRuleMask |= 1 << ruleIdx;
      }
      for (let i = vr.n - 1; i > 0; i--) {
        ruleHash = vr.tiles[i] | ((ruleHash & lowerBitsMask) << VT_BITS);
        if (vertexHash === ruleHash) {
          if (matches) matches[hits] = { rule: ruleIdx, pos: i };
          hits++;
          if (firstOnly) return hits;
          newRuleMask |= 1 << ruleIdx;
        }
      }
    }
    vertex.ruleMask = newRuleMask;
    return hits;
  }

  // Given the matches, the distinct tile types that could legally be added on
  // `side` of the vertex. Returns them in `results`; return count.
  function findCompletions(vertex, matches, nMatches, side, results) {
    let nRes = 0;
    if (nMatches <= 0) return 0;
    for (let i = 0; i < nMatches; i++) {
      const rule = vertex_rules[matches[i].rule];
      const pos = (matches[i].pos + (side === S_RIGHT ? vertex.nTiles : rule.n - 1)) % rule.n;
      const vtype = rule.tiles[pos];
      let cont = true;
      for (let j = 0; j < nRes; j++) {
        if (vtype === results[j]) { cont = false; break; }
      }
      if (cont) results[nRes++] = vtype;
    }
    return nRes;
  }

  // Would adding `vtype` close the vertex's remaining gap exactly?
  function fillsVertex(vtype, vertex) {
    const l = vertexDir(vertex, S_LEFT);
    const r = vertexDir(vertex, S_RIGHT);
    if (l < 0 || r < 0) return false;
    return (((l - r - vtype_angle(vtype)) % 10) + 10) % 10 === 0;
  }

  // ---- Fringe surgery ------------------------------------------------------

  // Append (RIGHT) or prepend (LEFT) a tile type to a vertex's CCW tile list.
  function addVtype(vertex, side, vtype) {
    if (side === S_RIGHT) {
      vertex.tiles[vertex.nTiles++] = vtype;
    } else {
      for (let i = vertex.nTiles; i > 0; i--) vertex.tiles[i] = vertex.tiles[i - 1];
      vertex.tiles[0] = vtype;
      vertex.nTiles++;
    }
  }

  // Make a new fringe vertex one unit step (direction `dir`) from `from`.
  function allocVertex(dir, from) {
    const v = {
      prev: null,
      next: null,
      tiles: new Array(MAX_TILES_PER_VERTEX).fill(0),
      nTiles: 0,
      ruleMask: (1 << N_VERTEX_RULES) - 1,
      inForced: false,
      forcedSides: 0,
      loc: { x: 0, y: 0 },
      fived: from.fived.slice(),
      offScreen: false,
    };
    addUnitVec(dir, v.fived);
    v.loc = fivedToLoc(v.fived);
    if (v.loc.x < 0 || v.loc.y < 0 || v.loc.x >= width || v.loc.y >= height) {
      let ww = width, hh = height;
      if (ww < 200 * S) ww = 200 * S;   // tiny window guard (C uses 200 px)
      if (hh < 200 * S) hh = 200 * S;
      v.offScreen = true;
      if (v.loc.x < -ww || v.loc.y < -hh || v.loc.x >= 2 * ww || v.loc.y >= 2 * hh) {
        done = true;   // grown more than a window beyond the edge: restart.
      }
    } else {
      v.offScreen = false;
      fringeN++;
    }
    return v;
  }

  // ---- Forced pool ---------------------------------------------------------

  function forcedRemove(vertex) {
    if (!vertex.inForced) return;
    const idx = forced.indexOf(vertex);
    if (idx >= 0) forced.splice(idx, 1);
    vertex.inForced = false;
    if (!vertex.offScreen) forcedVisible--;
  }

  // Recompute whether `vertex` is forced and update the forced pool. Sets done
  // if the vertex has become untileable (a dislocation). Never call on a fully
  // tiled vertex.
  function checkVertex(vertex) {
    const hits = [];
    const nHits = matchRules(vertex, hits, false);
    let forcedSides = 0;

    if (vertex.ruleMask === 0) {
      done = true;
      busyLoop = CELEBRATE;   // dislocation; should be able to recover via restart.
    }
    const tmp = [];
    if (findCompletions(vertex, hits, nHits, S_LEFT, tmp) === 1) forcedSides |= S_LEFT;
    if (findCompletions(vertex, hits, nHits, S_RIGHT, tmp) === 1) forcedSides |= S_RIGHT;

    if (forcedSides === 0) {
      forcedRemove(vertex);
    } else {
      if (!vertex.inForced) {
        vertex.inForced = true;
        forced.push(vertex);
        if (!vertex.offScreen) forcedVisible++;
      }
      vertex.forcedSides = forcedSides;
    }
  }

  // Remove a vertex no longer on the fringe (also drop it from the forced pool).
  function deleteVertex(vertex) {
    if (fringeNode === vertex) { done = true; busyLoop = CELEBRATE; }
    forcedRemove(vertex);
    if (!vertex.offScreen) fringeN--;
    // (No explicit free in JS; GC reclaims it once unlinked.)
  }

  // ---- fringe_changes ------------------------------------------------------
  // Decide, for adding `vtype` on `side` of `vertex`, which of the new tile's
  // other three corners (right/far/left) attach to existing fringe vertices vs
  // must be allocated, and which vertices get swallowed (cut from the fringe).
  // Returns the bit flags; fills out the right/far/left slots of `o`.
  function fringeChanges(vertex, side, vtype, o) {
    let result = FC_NEW_FAR;   // assume far is new; cleared below if it attaches.
    o.right = undefined;
    o.far = null;
    o.left = undefined;

    if (fillsVertex(vtype, vertex)) {
      result |= FC_CUT_THIS;
    } else if (side === S_LEFT) {
      result |= FC_NEW_RIGHT;
      o.right = null;
    } else {
      result |= FC_NEW_LEFT;
      o.left = null;
    }

    let f = null;
    if (!(result & FC_NEW_LEFT)) {
      const v = vertex.next;
      o.left = v;
      if (fillsVertex(VT_LEFT(vtype), v)) {
        result = (result & ~FC_NEW_FAR) | FC_CUT_LEFT;
        f = v.next;
        o.far = f;
      }
    }
    if (!(result & FC_NEW_RIGHT)) {
      const v = vertex.prev;
      o.right = v;
      if (fillsVertex(VT_RIGHT(vtype), v)) {
        result = (result & ~FC_NEW_FAR) | FC_CUT_RIGHT;
        f = v.prev;
        o.far = f;
      }
    }
    if (!(result & FC_NEW_FAR) && fillsVertex(VT_FAR(vtype), f)) {
      result |= FC_CUT_FAR;
      result &= ~FC_NEW_LEFT & ~FC_NEW_RIGHT;
      if (result & FC_CUT_LEFT) o.right = f.next;
      if (result & FC_CUT_RIGHT) o.left = f.prev;
    }
    if (((result & FC_CUT_LEFT) && (result & FC_CUT_RIGHT)) ||
        ((result & FC_CUT_THIS) && (result & FC_CUT_FAR))) {
      result |= FC_BAG;
    }
    return result;
  }

  // ---- Drawing -------------------------------------------------------------

  // Two Path2D buckets for the current step's tiles (fat / thin), plus an
  // outline path, filled/stroked once per step (braid.js bucketing idiom).
  let fatPath, thinPath, outlinePath, ammannPath;

  function newPaths() {
    fatPath = new Path2D();
    thinPath = new Path2D();
    outlinePath = new Path2D();
    ammannPath = new Path2D();
  }

  // Add a rhombus (v1..v4 CCW; vtype gives type & the corner v1 sits at) to the
  // step's paths. Mirrors draw_tile(): pts[corner]=v1, RIGHT=v2, FAR=v3, LEFT=v4.
  function drawTile(v1, v2, v3, v4, vtype) {
    if (v1.offScreen && v2.offScreen && v3.offScreen && v4.offScreen) return;
    const corner = vtype & VT_CORNER_MASK;
    const pts = [null, null, null, null];
    pts[corner] = v1.loc;
    pts[VT_RIGHT(corner)] = v2.loc;
    pts[VT_FAR(corner)] = v3.loc;
    pts[VT_LEFT(corner)] = v4.loc;

    const path = ((vtype & VT_TYPE_MASK) === VT_THICK) ? fatPath : thinPath;
    path.moveTo(pts[0].x, pts[0].y);
    path.lineTo(pts[1].x, pts[1].y);
    path.lineTo(pts[2].x, pts[2].y);
    path.lineTo(pts[3].x, pts[3].y);
    path.closePath();

    outlinePath.moveTo(pts[0].x, pts[0].y);
    outlinePath.lineTo(pts[1].x, pts[1].y);
    outlinePath.lineTo(pts[2].x, pts[2].y);
    outlinePath.lineTo(pts[3].x, pts[3].y);
    outlinePath.closePath();

    if (config.ammann) addAmmann(pts, vtype);
  }

  // Ammann matching lines: a segment across each rhombus (the C's debugging
  // overlay). Geometry copied verbatim from draw_tile().
  function addAmmann(pts, vtype) {
    if ((vtype & VT_TYPE_MASK) === VT_THICK) {
      if (ammannR === 0) {
        const pi10 = Math.PI / 10;   // 2*atan(1)/5 = pi/10
        ammannR = 1 - Math.sin(pi10) / (2 * Math.sin(3 * pi10));
      }
      const r = ammannR;
      ammannPath.moveTo(r * pts[3].x + (1 - r) * pts[0].x, r * pts[3].y + (1 - r) * pts[0].y);
      ammannPath.lineTo(r * pts[1].x + (1 - r) * pts[0].x, r * pts[1].y + (1 - r) * pts[0].y);
    } else {
      ammannPath.moveTo((pts[3].x + pts[2].x) / 2, (pts[3].y + pts[2].y) / 2);
      ammannPath.lineTo((pts[1].x + pts[2].x) / 2, (pts[1].y + pts[2].y) / 2);
    }
  }

  // Paint the step's accumulated tiles onto the persistent canvas.
  function flushPaths() {
    ctx.fillStyle = palette[thickColor];
    ctx.fill(fatPath);
    ctx.fillStyle = palette[thinColor];
    ctx.fill(thinPath);

    ctx.strokeStyle = '#000';
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'miter';
    ctx.stroke(outlinePath);

    if (config.ammann) {
      // Contrast colour: thin lines on fat tiles get the thin hue and vice
      // versa; here a single mid pass reads fine over both.
      ctx.strokeStyle = palette[thinColor];
      ctx.lineWidth = Math.max(1, lineWidth * 0.5);
      ctx.stroke(ammannPath);
    }
  }

  // ---- add_tile ------------------------------------------------------------
  // Add the tile `vtype` on `side` of `vertex` (assumed rule-legal). Allocates
  // new vertices, rejects the move if it would enclose a gap or duplicate an
  // existing vertex, rechains the fringe, draws the tile, and re-checks the
  // touched vertices. Returns true iff a tile was added.
  function addTile(vertex, side, vtype) {
    const o = { right: undefined, far: null, left: undefined };
    const fc = fringeChanges(vertex, side, vtype, o);

    const ltype = VT_LEFT(vtype);
    const rtype = VT_RIGHT(vtype);
    const ftype = VT_FAR(vtype);

    if (fc & FC_BAG) { done = true; }

    let right = o.right, far = o.far, left = o.left;

    if (side === S_LEFT) {
      if (right == null) {
        const d = vertexDir(vertex, S_LEFT);
        if (d < 0) return false;
        right = allocVertex(d - vtype_angle(vtype), vertex);
      }
      if (far == null) {
        const d = vertexDir(left, S_RIGHT);
        if (d < 0) return false;
        far = allocVertex(d + vtype_angle(ltype), left);
      }
    } else {
      if (left == null) {
        const d = vertexDir(vertex, S_RIGHT);
        if (d < 0) return false;
        left = allocVertex(d + vtype_angle(vtype), vertex);
      }
      if (far == null) {
        const d = vertexDir(right, S_LEFT);
        if (d < 0) return false;
        far = allocVertex(d - vtype_angle(rtype), right);
      }
    }

    // Reject if any newly allocated vertex coincides with an existing one.
    let node = fringeNode;
    do {
      if (((fc & FC_NEW_LEFT) && fivedEqual(node.fived, left.fived)) ||
          ((fc & FC_NEW_RIGHT) && fivedEqual(node.fived, right.fived)) ||
          ((fc & FC_NEW_FAR) && fivedEqual(node.fived, far.fived))) {
        // Better luck next time: undo the freshly allocated vertices.
        if (fc & FC_NEW_LEFT) deleteVertex(left);
        if (fc & FC_NEW_RIGHT) deleteVertex(right);
        if (fc & FC_NEW_FAR) deleteVertex(far);
        return false;
      }
      node = node.next;
    } while (node !== fringeNode);

    // Rechain the fringe ring.
    if (!(fc & FC_CUT_THIS)) {
      if (side === S_LEFT) { vertex.next = right; right.prev = vertex; }
      else { vertex.prev = left; left.next = vertex; }
    }
    if (!(fc & FC_CUT_FAR)) {
      if (!(fc & FC_CUT_LEFT)) { far.next = left; left.prev = far; }
      if (!(fc & FC_CUT_RIGHT)) { far.prev = right; right.next = far; }
    }

    drawTile(vertex, right, far, left, vtype);

    // Add the tile to each surviving corner (or delete swallowed vertices).
    if (fc & FC_CUT_THIS) {
      fringeNode = far;
      deleteVertex(vertex);
    } else {
      addVtype(vertex, side, vtype);
      checkVertex(vertex);
      fringeNode = vertex;
    }
    if (fc & FC_CUT_FAR) {
      deleteVertex(far);
    } else {
      addVtype(far, (fc & FC_CUT_RIGHT) ? S_LEFT : S_RIGHT, ftype);
      checkVertex(far);
    }
    if (fc & FC_CUT_LEFT) {
      deleteVertex(left);
    } else {
      addVtype(left, (fc & FC_CUT_FAR) ? S_LEFT : S_RIGHT, ltype);
      checkVertex(left);
    }
    if (fc & FC_CUT_RIGHT) {
      deleteVertex(right);
    } else {
      addVtype(right, (fc & FC_CUT_FAR) ? S_RIGHT : S_LEFT, rtype);
      checkVertex(right);
    }
    return true;
  }

  // ---- Forced / random tile addition --------------------------------------

  function addForcedTile(vertex) {
    let side;
    if (vertex.forcedSides === (S_LEFT | S_RIGHT)) side = nrand(2) ? S_LEFT : S_RIGHT;
    else side = vertex.forcedSides;

    const hits = [];
    let n = matchRules(vertex, hits, true);
    const out = [];
    n = findCompletions(vertex, hits, n, side, out);
    if (n <= 0) { done = true; return false; }
    return addTile(vertex, side, out[0]);
  }

  // Whether adding `vtype` on `side` of `vertex` conforms to the rules.
  function legalMove(vertex, side, vtype) {
    const hits = [];
    const nHits = matchRules(vertex, hits, false);
    const legal = [];
    const nLegal = findCompletions(vertex, hits, nHits, side, legal);
    for (let i = 0; i < nLegal; i++) if (legal[i] === vtype) return true;
    return false;
  }

  // Add a randomly chosen legal tile to `vertex`, making sure it conforms to the
  // rules at every vertex it would touch (and re-rolling the colours).
  function addRandomTile(vertex) {
    pickColors();

    const hits = [];
    const nHits = matchRules(vertex, hits, false);
    const side = nrand(2) ? S_LEFT : S_RIGHT;
    const vtypes = [];
    const n = findCompletions(vertex, hits, nHits, side, vtypes);
    if (n <= 0) { done = true; return; }

    const noGood = new Array(n).fill(false);
    let nGood = n;
    for (let i = 0; i < n; i++) {
      const o = { right: undefined, far: null, left: undefined };
      const fc = fringeChanges(vertex, side, vtypes[i], o);
      if (fc & FC_BAG) { done = true; }
      if (o.right) {
        const s = (((fc & FC_CUT_FAR) && (fc & FC_CUT_LEFT)) ? S_RIGHT : S_LEFT);
        if (!legalMove(o.right, s, VT_RIGHT(vtypes[i]))) { noGood[i] = true; nGood--; continue; }
      }
      if (o.left) {
        const s = (((fc & FC_CUT_FAR) && (fc & FC_CUT_RIGHT)) ? S_LEFT : S_RIGHT);
        if (!legalMove(o.left, s, VT_LEFT(vtypes[i]))) { noGood[i] = true; nGood--; continue; }
      }
      if (o.far) {
        const s = ((fc & FC_CUT_LEFT) ? S_RIGHT : S_LEFT);
        if (!legalMove(o.far, s, VT_FAR(vtypes[i]))) { noGood[i] = true; nGood--; }
      }
    }
    if (nGood <= 0) { done = true; return; }

    // Pick the (nrand(nGood))-th still-good candidate.
    let pick = nrand(nGood);
    let j = 0;
    for (let i = 0; i <= pick; i++, j++) {
      while (noGood[j]) j++;
    }
    if (!addTile(vertex, side, vtypes[j - 1])) {
      done = true;
    }
  }

  // ---- Colours -------------------------------------------------------------

  // Pick a fat colour and a contrasting thin colour (the C's good-contrast trick:
  // thin is thick + [ncolors/6 .. ncolors/6 + 2*ncolors/3) around the wheel).
  function pickColors() {
    const np = config.ncolors;
    if (np > 2) {
      thickColor = nrand(np);
      thinColor = (nrand((2 * np / 3) | 0) + thickColor + ((np / 6) | 0)) % np;
    } else {
      thickColor = 0;
      thinColor = np > 1 ? (np - 1) : 0;
    }
  }

  // ---- Init / step ---------------------------------------------------------

  function init() {
    S = window.devicePixelRatio || 1;
    width = canvas.width;
    height = canvas.height;

    // Fill the 5-D basis once.
    if (fived_basis.length === 0) {
      const fifth = 2 * Math.PI / 5;
      for (let i = 0; i < 5; i++) fived_basis.push([Math.cos(fifth * i), Math.sin(fifth * i)]);
    }

    // Palette: penrose defines no *_COLORS macro, so xlockmore.c builds its
    // colormap from the default scheme -- make_random_colormap with
    // bright_p = False, i.e. fully random RGB (NOT a hue ramp); see penrose.md.
    // ncolors <= 2 falls back to white (the C's MI_WHITE_PIXEL mono path).
    const n = config.ncolors;
    palette = new Array(n);
    if (n > 2) {
      const cm = makeRandomColormapRGB(n, false);
      for (let i = 0; i < n; i++) palette[i] = 'rgb(' + cm[i][0] + ',' + cm[i][1] + ',' + cm[i][2] + ')';
    } else {
      for (let i = 0; i < n; i++) palette[i] = '#fff';
    }

    // Edge length: size in logical px, retina-scaled, clamped MINSIZE..min/2.
    let size = config.size * S;
    lineWidth = Math.max(1, Math.round(S));
    const minSizeS = MINSIZE * S;
    const halfMin = Math.max(minSizeS, Math.min(width, height) / 2);
    if (size < minSizeS) edgeLength = minSizeS;
    else edgeLength = Math.min(size, halfMin);

    // Origin: the C's (w/2 + rand(w))/2 — biased toward centre.
    originX = ((width / 2 + nrand(width)) / 2) | 0;
    originY = ((height / 2 + nrand(height)) / 2) | 0;

    done = false;
    busyLoop = 0;
    failures = 0;
    ammannR = 0;
    forced = [];
    forcedVisible = 0;
    fringeN = 2;
    pickColors();

    // The seed "2-gon": two vertices joined into a degenerate ring (the first
    // edge). v0 at the origin; v1 one unit step away in a random 5-D axis.
    const v0 = {
      prev: null, next: null,
      tiles: new Array(MAX_TILES_PER_VERTEX).fill(0), nTiles: 0,
      ruleMask: (1 << N_VERTEX_RULES) - 1,
      inForced: false, forcedSides: 0,
      loc: { x: originX, y: originY },
      fived: [0, 0, 0, 0, 0],
      offScreen: false,
    };
    const v1 = {
      prev: v0, next: v0,
      tiles: new Array(MAX_TILES_PER_VERTEX).fill(0), nTiles: 0,
      ruleMask: (1 << N_VERTEX_RULES) - 1,
      inForced: false, forcedSides: 0,
      loc: { x: 0, y: 0 },
      fived: [0, 0, 0, 0, 0],
      offScreen: false,
    };
    v0.prev = v0.next = v1;
    const axis = nrand(5);
    v1.fived[axis] = 2 * nrand(2) - 1;
    v1.loc = fivedToLoc(v1.fived);
    fringeNode = v0;
  }

  // One growth step (the C's draw_penrose), drawing the tiles it adds.
  function step() {
    newPaths();

    if (busyLoop > 0) { busyLoop--; return; }
    if (done || failures >= 100) { reinit(); return; }

    // The initial 2-gon: prev === next means the ring is the seed edge.
    if (fringeNode.prev === fringeNode.next) {
      const vtype = VT_TOTAL_MASK & nrand(8);   // C: VT_TOTAL_MASK & LRAND()
      if (!addTile(fringeNode, S_LEFT, vtype)) {
        // Couldn't seed; restart cleanly.
        done = true;
      }
      flushPaths();
      return;
    }

    // No visible fringe nodes left: the tiling filled the viewport.
    if (fringeN === 0) {
      done = true;
      busyLoop = COMPLETION;
      return;
    }

    if (forcedVisible > 0 && failures < 10) {
      // Random visible forced vertex.
      let n = nrand(forcedVisible);
      let chosen = null;
      for (let k = 0; k < forced.length; k++) {
        if (forced[k].offScreen) continue;
        if (n-- === 0) { chosen = forced[k]; break; }
      }
      if (chosen) {
        if (addForcedTile(chosen)) failures = 0; else failures++;
      } else { failures++; }
    } else if (forced.length > 0) {
      // Random forced vertex (visible or not).
      const chosen = forced[nrand(forced.length)];
      if (addForcedTile(chosen)) failures = 0; else failures++;
    } else {
      // No forced vertices: add a random tile to a random visible fringe node.
      let n = nrand(fringeN);
      let fp = fringeNode;
      for (let i = 0; i <= n; i++) {
        do { fp = fp.next; } while (fp.offScreen);
      }
      addRandomTile(fp);
      failures = 0;
    }

    flushPaths();
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
    init();
  }

  // Rebuild after a non-live config change (clears the canvas, re-seeds).
  function reinit() {
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // rAF lag-accumulator loop: one step() per config.delay (µs), banking leftover
  // time so the pace is the same at any refresh rate; cap catch-up so a
  // backgrounded tab can't burst.
  // OVERHEAD: the live binary's *delay is a sleep FLOOR; its real frame is
  // delay + per-step compute. The -fps overlay read 57.2 fps at Load 42.8 %
  // (delay-bound) = 17482 µs/frame = 10000 floor + 7482 compute, so the
  // faithful per-step pace is (delay + 7482)/1000 ms (matches the live ~57/s).
  const OVERHEAD = 7482;
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
    reinit,   // fresh tiling with the current config
    config,
    params,
  };
}
