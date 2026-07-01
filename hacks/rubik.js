// rubik.js -- "Rubik" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's rubik (Marcelo F. Vianna, 1997),
// hacks/glx/rubik.c. An auto-solving Rubik's Cube: it builds a solved LxMxN cube,
// generates a random scramble (a list of face turns), then either shows the
// shuffling and reverses it, or (hideshuffling) starts scrambled and just solves.
// One layer rotates 90 (or 180 for a non-square face) per move, animated over
// `cycles` frames; between phases it pauses, then re-shuffles with fresh sizes.
//
// STATE MODEL (verbatim from the .c): the cube is six facelet arrays
// cubeLoc[face][position], each entry a {face(=colour 0..5), rotation} packed into
// one int (face<<2 | rotation). faceSizes(): TOP/BOTTOM are X*Z, LEFT/RIGHT Z*Y,
// FRONT/BACK X*Y. A face turn permutes these arrays via the exact xrubik machinery
// (moveRubik -> readRC/rotateRC/reverseRC/writeRC around the ring of side faces +
// rotateFace on the turned face), including the 180-degree double-slide branch for
// non-square faces. Because the permutation is the .c's, a scramble replayed in
// reverse (direction +2 mod 4) provably re-solves the cube.
//
// MOVES: shuffle() picks `count` random moves (count<0 => 1..|count| random),
// move.face=NRAND(6), move.direction=NRAND(4) (edge dirs only, never CW/CCW),
// move.position=NRAND(sizeFace); it rejects a move that immediately undoes the
// previous one, and three-in-a-row repeats (compare_moves via convertMove). Solve
// replays moves[storedmoves-1..0] with direction=(dir+2)%4.
//
// ANIMATION: draw_rubik's per-frame state machine, ticked at effFps. rotatestep
// climbs 0..degreeTurn by anglestep(=90/cycles); at the top evalmovement() applies
// the permutation and the move ends. degreeTurn is 90 for a square turned-face,
// else 180. The turning slice is drawn with pre-move colours, rotated in space;
// when it completes the permutation snaps it home -- exactly the .c's model.
//
// RENDER: each shell cubie is one beveled gray body (draw_stickerless_cubit,
// transcribed vertex-for-vertex: 6 face quads + 12 edge bevels + 8 corner tris)
// plus an octagonal "rounded square" sticker on each exposed face, sitting just
// proud of the body (STICKERDEPTH). Sticker colour is read from cubeLoc through the
// fixed cubie->facelet map derived from draw_cube (see below). During a move the
// slice's cubies are re-parented under a pivot group and rotated about the cube's
// central axis; the rest sit at fixed grid positions. Interior cubies are never
// built (the .c never draws them).
//
// cubie(i,j,k) -> facelet map (derived from draw_cube's static traversal; SX/SY/SZ
// = MAXSIZEX/Y/Z, i=X 0..left, j=Y 0..bottom, k=Z 0..back):
//   back  (k==0)     cubeLoc[BACK ][ i + SX*j ]
//   front (k==SZ-1)  cubeLoc[FRONT][ i + SX*(SY-1-j) ]
//   left  (i==0)     cubeLoc[LEFT ][ k + SZ*(SY-1-j) ]
//   right (i==SX-1)  cubeLoc[RIGHT][ (SZ-1-k) + SZ*(SY-1-j) ]
//   bottom(j==0)     cubeLoc[BOTT ][ i + SX*(SZ-1-k) ]
//   top   (j==SY-1)  cubeLoc[TOP  ][ i + SX*k ]
//
// COLOURS: the .c's exact material DIFFUSE arrays (NOT standard Rubik colours):
// TOP=Red(.5,0,0) LEFT=Yellow(.7,.7,0) FRONT=White(.8,.8,.8) RIGHT=Green(0,.5,0)
// BOTTOM=Orange(.9,.45,.36) BACK=Blue(0,0,.5), bevel body Gray(.2,.2,.2).
//
// LIGHTING: two directional lights (1,1,1) and (-1,-1,1), white diffuse; global
// ambient 0.5 * material ambient 0.2 = a flat 0.1 GRAY term (colour-independent, so
// a shadowed sticker reads gray not dark-tinted) -> reproduced as material.emissive
// (0.1,0.1,0.1), NOT AmbientLight. specular 0.7, shininess 60. GL_FLAT => flat
// shading. Light intensity = PI and specular /= PI (the superquadrics.js convention
// that cancels three's Lambert/specular normalization); ColorManagement off so raw
// glColor values are matched.
//
// PACING: OVERHEAD = 37500 (the GL family's shared measured value, since these can't
// be timed under this machine's XQuartz block). effFps = 1e6/(delay+OVERHEAD).
// The draw_rubik state machine is ticked at effFps (frame-counted delays 5 and 20
// are faithful only at the original cadence); spin/drift/turn are interpolated for
// 60fps smoothness.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';

// xscreensaver's GL fixed pipeline does NO color management -- raw glColor to the
// framebuffer. Disable three's color management so colors are used raw (matches GL).
THREE.ColorManagement.enabled = false;

export const title = 'rubik';

export const info = {
  author: 'Marcelo Vianna',
  year: 1997,
  description:
    'A Rubik\'s Cube that repeatedly shuffles and solves itself.\n\n' +
    'See also the "GLSnake" and "Cube21" screen savers.\n\n' +
    'https://en.wikipedia.org/wiki/Rubik%27s_Cube',
};

export function start(hostCanvas, opts = {}) {
  // ---- constants (rubik.c #defines) ----
  const MAXORIENT = 4, MAXFACES = 6;
  const TOP = 0, RIGHT = 1, BOTTOM = 2, LEFT = 3;
  const CW = MAXORIENT + 1, CCW = 2 * MAXORIENT - 1;   // 5, 7 (HALF=6, unused here)
  const HALF = MAXORIENT + 2;                          // 6
  const TOP_FACE = 0, LEFT_FACE = 1, FRONT_FACE = 2, RIGHT_FACE = 3, BOTTOM_FACE = 4, BACK_FACE = 5;
  const NO_FACE = MAXFACES;                            // 6
  const ACTION_SHUFFLE = 0, ACTION_SOLVE = 1;
  const DELAY_AFTER_SHUFFLING = 5, DELAY_AFTER_SOLVING = 20;
  const MINSIZE = 2;
  const MAXRAND = 2147483648.0;
  const MAX_TICKS = 8;
  const OVERHEAD = 37500;   // us; GL family shared overhead (see header)

  // beveled-cube dimensions (rubik.c)
  const CUBELEN = 0.50, CUBEROUND = CUBELEN - 0.05;                 // 0.45
  const STICKERLONG = CUBEROUND - 0.05, STICKERSHORT = STICKERLONG - 0.05;  // 0.40, 0.35
  const STICKERDEPTH = CUBELEN + 0.01;                             // 0.51

  const mod = (a, n) => ((a % n) + n) % n;
  const deg2rad = (d) => (d * Math.PI) / 180;

  // ---- config / params (mirror hacks/rubik.xml 1:1) ----
  const config = {
    delay: 20000,          // us (xml <delay>)
    count: -30,            // stored moves; <0 => random 1..|count| (xml <count>)
    cycles: 20,            // frames per 90deg turn (xml <cycles>, "Rotation")
    size: -6,              // cube size; <0 => random 2..|size| (xml <size>)
    hideshuffling: false,  // start scrambled, only show the solve (xml <shuffle>)
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'count', label: 'Count', type: 'range', min: -100, max: 100, step: 1, default: -30, live: true },
    { key: 'cycles', label: 'Rotation', type: 'range', min: 3, max: 200, step: 1, default: 20, invert: true, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    { key: 'size', label: 'Size', type: 'range', min: -20, max: 20, step: 1, default: -6, live: true },
    { key: 'hideshuffling', label: 'Hide shuffling', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);

  // ===================================================================
  //  cube-state tables (verbatim from rubik.c) -- {f: face, r: rotation}
  // ===================================================================
  // slideNextRow[face][dir]: next face + orientation when a row/col slides.
  const slideNextRow = [
    [{ f: 5, r: TOP }, { f: 3, r: RIGHT }, { f: 2, r: TOP }, { f: 1, r: LEFT }],
    [{ f: 0, r: RIGHT }, { f: 2, r: TOP }, { f: 4, r: LEFT }, { f: 5, r: BOTTOM }],
    [{ f: 0, r: TOP }, { f: 3, r: TOP }, { f: 4, r: TOP }, { f: 1, r: TOP }],
    [{ f: 0, r: LEFT }, { f: 5, r: BOTTOM }, { f: 4, r: RIGHT }, { f: 2, r: TOP }],
    [{ f: 2, r: TOP }, { f: 3, r: LEFT }, { f: 5, r: TOP }, { f: 1, r: RIGHT }],
    [{ f: 4, r: TOP }, { f: 3, r: BOTTOM }, { f: 0, r: TOP }, { f: 1, r: BOTTOM }],
  ];
  // rotateSlice[face][dir%2]: turned plane {f: TOP/LEFT/FRONT axis, r: CW/CCW}.
  const rotateSlice = [
    [{ f: 1, r: CCW }, { f: 2, r: CW }],
    [{ f: 2, r: CW }, { f: 0, r: CCW }],
    [{ f: 1, r: CCW }, { f: 0, r: CCW }],
    [{ f: 2, r: CCW }, { f: 0, r: CCW }],
    [{ f: 1, r: CCW }, { f: 2, r: CCW }],
    [{ f: 1, r: CCW }, { f: 0, r: CW }],
  ];
  const rowToRotate = [
    [3, 2, 1, 5], [2, 4, 5, 0], [3, 4, 1, 0], [5, 4, 2, 0], [3, 5, 1, 2], [3, 0, 1, 4],
  ];
  // rotateToRow[face] = {face, direction, sideFace} (CW->min face); only used by the
  // CW/CCW pre-branch of moveRubik, which shuffle/solve never trigger (dirs 0..3).
  const rotateToRow = [
    { f: 1, d: LEFT, s: TOP }, { f: 0, d: BOTTOM, s: RIGHT }, { f: 0, d: RIGHT, s: BOTTOM },
    { f: 0, d: TOP, s: LEFT }, { f: 1, d: RIGHT, s: BOTTOM }, { f: 0, d: LEFT, s: TOP },
  ];

  // ---- packed facelet helpers: loc = face<<2 | rotation ----
  const FACE = (loc) => loc >> 2;
  const ROT = (loc) => loc & 3;
  const MK = (face, rot) => (face << 2) | (rot & 3);

  // ---- cube state (rubikstruct) ----
  let SX = 0, SY = 0, SZ = 0;            // MAXSIZEX/Y/Z
  let builtSX = -1, builtSY = -1, builtSZ = -1;
  let avsize = 1;
  const cubeLoc = [null, null, null, null, null, null];   // cubeLoc[face] = Int array
  const rowLoc = [[], [], [], []];                        // rowLoc[orient] (0..3)
  let moves = [];
  let storedmoves = 0, shufflingmoves = 0;
  let degreeTurn = 90;
  let anglestep = 4.5, rotatestep = 0;
  let action = ACTION_SHUFFLE, done = false, doneTimer = 0;
  let movement = { face: NO_FACE, direction: 0, position: 0 };
  let step = 0, PX = 0, PY = 0, VX = 0.005, VY = 0.005;
  let needsRecolor = true;

  // ---- geometry-independent state helpers (verbatim ports) ----
  function faceSizes(face) {
    switch (face) {
      case 0: case 4: return { row: SX, col: SZ };   // TOP / BOTTOM
      case 1: case 3: return { row: SZ, col: SY };   // LEFT / RIGHT
      default: return { row: SX, col: SY };          // FRONT(2) / BACK(5)
    }
  }
  const sizeRow = (face) => faceSizes(face).row;
  const sizeFace = (face) => { const s = faceSizes(face); return s.row * s.col; };
  const checkFaceSquare = (face) => { const s = faceSizes(face); return s.row === s.col; };

  function convertMove(move) {
    const plane = rotateSlice[move.face][move.direction % 2];
    const slice = { face: plane.f, rotation: plane.r, depth: 0 };
    const { row, col } = faceSizes(move.face);
    if (plane.f === 1 || (plane.f === 2 && (move.face === 1 || move.face === 3))) {  // VERTICAL
      if (slice.rotation === CW) slice.depth = row - 1 - (move.position % row);
      else slice.depth = move.position % row;
    } else {  // HORIZONTAL
      if (slice.rotation === CW) slice.depth = col - 1 - Math.floor(move.position / row);
      else slice.depth = Math.floor(move.position / row);
    }
    if (Math.floor(move.direction / 2)) slice.rotation = (slice.rotation === CW) ? CCW : CW;
    return slice;
  }

  function rotateFace(face, direction) {
    const { row, col } = faceSizes(face);
    const n = row * col;
    const faceLoc = cubeLoc[face].slice(0, n);
    for (let position = 0; position < n; position++) {
      const i = position % row, j = Math.floor(position / row);
      let src;
      if (direction === CW) src = (row - i - 1) * row + j;
      else if (direction === CCW) src = i * row + (col - j - 1);
      else src = (row - i - 1) + (col - j - 1) * row;   // HALF
      const loc = faceLoc[src];
      cubeLoc[face][position] = MK(FACE(loc), mod(ROT(loc) + direction - MAXORIENT, MAXORIENT));
    }
  }

  function readRC(face, dir, h, orient, size) {
    const sr = sizeRow(face);
    const dst = rowLoc[orient];
    if (dir === TOP || dir === BOTTOM) for (let g = 0; g < size; g++) dst[g] = cubeLoc[face][g * sr + h];
    else for (let g = 0; g < size; g++) dst[g] = cubeLoc[face][h * sr + g];
  }
  function rotateRC(rotate, orient, size) {
    const r = rowLoc[orient];
    for (let g = 0; g < size; g++) r[g] = MK(FACE(r[g]), (ROT(r[g]) + rotate) % MAXORIENT);
  }
  function reverseRC(orient, size) {
    const r = rowLoc[orient];
    for (let g = 0; g < (size >> 1); g++) { const t = r[size - 1 - g]; r[size - 1 - g] = r[g]; r[g] = t; }
  }
  function writeRC(face, dir, h, orient, size) {
    const sr = sizeRow(face);
    const src = rowLoc[orient];
    if (dir === TOP || dir === BOTTOM) for (let g = 0; g < size; g++) cubeLoc[face][g * sr + h] = src[g];
    else for (let g = 0; g < size; g++) cubeLoc[face][h * sr + g] = src[g];
  }

  function slideRC(face, direction, h, sizeOnOppAxis) {
    const newFace = slideNextRow[face][direction].f;
    const rotate = slideNextRow[face][direction].r;
    const newDirection = (rotate + direction) % MAXORIENT;
    let newH = 0, reverse = false;
    switch (rotate) {
      case TOP: newH = h; reverse = false; break;
      case RIGHT:
        if (newDirection === TOP || newDirection === BOTTOM) { newH = sizeOnOppAxis - 1 - h; reverse = false; }
        else { newH = h; reverse = true; }
        break;
      case BOTTOM: newH = sizeOnOppAxis - 1 - h; reverse = true; break;
      case LEFT:
        if (newDirection === TOP || newDirection === BOTTOM) { newH = h; reverse = true; }
        else { newH = sizeOnOppAxis - 1 - h; reverse = false; }
        break;
    }
    return { newFace, newDirection, newH, rotate, reverse };
  }

  function moveRubik(face, direction, position) {
    let { row, col } = faceSizes(face);   // sizeOfRow, sizeOfColumn
    if (direction === CW || direction === CCW) {   // never hit by shuffle/solve
      direction = (direction === CCW) ? (rotateToRow[face].d + 2) % MAXORIENT : rotateToRow[face].d;
      let i, j;
      if (rotateToRow[face].s === RIGHT) i = j = col - 1;
      else if (rotateToRow[face].s === BOTTOM) i = j = row - 1;
      else i = j = 0;
      face = rotateToRow[face].f;
      position = j * row + i;
      ({ row, col } = faceSizes(face));
    }
    let i = position % row, j = Math.floor(position / row);
    let h = (direction === TOP || direction === BOTTOM) ? i : j;
    let sizeOnAxis, sizeOnOppAxis;
    if (direction === TOP || direction === BOTTOM) { sizeOnAxis = col; sizeOnOppAxis = row; }
    else { sizeOnAxis = row; sizeOnOppAxis = col; }

    if (h === sizeOnOppAxis - 1) {
      const nd = (direction === TOP || direction === BOTTOM) ? TOP : RIGHT;
      if (degreeTurn === 180) rotateFace(rowToRotate[face][nd], HALF);
      else if (direction === TOP || direction === RIGHT) rotateFace(rowToRotate[face][nd], CW);
      else rotateFace(rowToRotate[face][nd], CCW);
    }
    if (h === 0) {
      const nd = (direction === TOP || direction === BOTTOM) ? BOTTOM : LEFT;
      if (degreeTurn === 180) rotateFace(rowToRotate[face][nd], HALF);
      else if (direction === TOP || direction === RIGHT) rotateFace(rowToRotate[face][nd], CCW);
      else rotateFace(rowToRotate[face][nd], CW);
    }

    readRC(face, direction, h, 0, sizeOnAxis);
    if (degreeTurn === 180) {
      let s = slideRC(face, direction, h, sizeOnOppAxis);
      const sizeOnDepthAxis = (sizeFace(s.newFace) / sizeOnOppAxis) | 0;
      readRC(s.newFace, s.newDirection, s.newH, 1, sizeOnDepthAxis);
      rotateRC(s.rotate, 0, sizeOnAxis);
      if (s.reverse) reverseRC(0, sizeOnAxis);
      face = s.newFace; direction = s.newDirection; h = s.newH;
      for (let k = 2; k <= MAXORIENT + 1; k++) {
        s = slideRC(face, direction, h, sizeOnOppAxis);
        if (k !== MAXORIENT && k !== MAXORIENT + 1)
          readRC(s.newFace, s.newDirection, s.newH, k, (k % 2) ? sizeOnDepthAxis : sizeOnAxis);
        rotateRC(s.rotate, k - 2, (k % 2) ? sizeOnDepthAxis : sizeOnAxis);
        if (k !== MAXORIENT + 1)
          rotateRC(s.rotate, k - 1, (k % 2) ? sizeOnAxis : sizeOnDepthAxis);
        if (s.reverse) {
          reverseRC(k - 2, (k % 2) ? sizeOnDepthAxis : sizeOnAxis);
          if (k !== MAXORIENT + 1) reverseRC(k - 1, (k % 2) ? sizeOnAxis : sizeOnDepthAxis);
        }
        writeRC(s.newFace, s.newDirection, s.newH, k - 2, (k % 2) ? sizeOnDepthAxis : sizeOnAxis);
        face = s.newFace; direction = s.newDirection; h = s.newH;
      }
    } else {
      for (let k = 1; k <= MAXORIENT; k++) {
        const s = slideRC(face, direction, h, sizeOnOppAxis);
        if (k !== MAXORIENT) readRC(s.newFace, s.newDirection, s.newH, k, sizeOnAxis);
        rotateRC(s.rotate, k - 1, sizeOnAxis);
        if (s.reverse) reverseRC(k - 1, sizeOnAxis);
        writeRC(s.newFace, s.newDirection, s.newH, k - 1, sizeOnAxis);
        face = s.newFace; direction = s.newDirection; h = s.newH;
      }
    }
  }

  const evalmovement = (m) => { if (m.face >= 0 && m.face < MAXFACES) moveRubik(m.face, m.direction, m.position); };

  function compareMoves(m1, m2, opp) {
    const s1 = convertMove(m1), s2 = convertMove(m2);
    if (s1.face === s2.face && s1.depth === s2.depth) {
      if (s1.rotation === s2.rotation) { if (!opp) return true; }
      else { if (opp) return true; }
    }
    return false;
  }

  // ---- shuffle(): pick sizes, build solved cube, generate the scramble ----
  function clampSize(i) {
    if (i < -MINSIZE) return rng.NRAND(-i - MINSIZE + 1) + MINSIZE;
    if (i < MINSIZE) return MINSIZE;
    return i;
  }
  function shuffle() {
    // sizex/sizey/sizez command-line overrides are unused (xml exposes only `size`).
    let i = clampSize(config.size);
    if ((rng.LRAND() % 2)) {
      SX = SY = SZ = i;
    } else {
      SX = i;
      i = clampSize(config.size);
      if ((rng.LRAND() % 2)) { SY = SZ = i; }
      else { SY = i; i = clampSize(config.size); SZ = i; }
    }

    for (let face = 0; face < MAXFACES; face++) {
      const n = sizeFace(face);
      const arr = new Int16Array(n);
      for (let position = 0; position < n; position++) arr[position] = MK(face, TOP);
      cubeLoc[face] = arr;
    }

    storedmoves = config.count | 0;                       // MI_COUNT
    if (storedmoves < 0) storedmoves = rng.NRAND(-storedmoves) + 1;
    moves = new Array(storedmoves);
    anglestep = (config.cycles <= 1) ? 90.0 : 90.0 / config.cycles;

    for (i = 0; i < storedmoves; i++) {
      let move, condition;
      do {
        move = { face: rng.NRAND(MAXFACES), direction: rng.NRAND(MAXORIENT), position: 0 };
        move.position = rng.NRAND(sizeFace(move.face));
        degreeTurn = checkFaceSquare(rowToRotate[move.face][move.direction]) ? 90 : 180;
        condition = true;
        if (i > 0) {   // avoid immediately undoing the previous move
          if (compareMoves(move, moves[i - 1], true)) condition = false;
          if (degreeTurn === 180 && compareMoves(move, moves[i - 1], false)) condition = false;
        }
        if (i > 1)     // avoid three consecutive identical moves
          if (compareMoves(move, moves[i - 1], false) && compareMoves(move, moves[i - 2], false)) condition = false;
      } while (!condition);
      if (config.hideshuffling) evalmovement(move);
      moves[i] = move;
    }

    VX = 0.005; if (rng.NRAND(100) < 50) VX = -VX;
    VY = 0.005; if (rng.NRAND(100) < 50) VY = -VY;
    movement = { face: NO_FACE, direction: 0, position: 0 };
    rotatestep = 0;
    action = config.hideshuffling ? ACTION_SOLVE : ACTION_SHUFFLE;
    shufflingmoves = 0;
    done = false; doneTimer = 0;

    avsize = (SX + SY + SZ) / 3.0;
    if (SX !== builtSX || SY !== builtSY || SZ !== builtSZ) buildCube();
    needsRecolor = true;
  }

  // ===================================================================
  //  cubie geometry: beveled body + octagonal stickers (rubik.c verbatim)
  // ===================================================================
  const CL = CUBELEN, CR = CUBEROUND, SL = STICKERLONG, SS = STICKERSHORT, SD = STICKERDEPTH;

  // draw_stickerless_cubit: 6 face quads, 12 edge bevels, 8 corner tris (gray).
  const bodyPolys = [
    { n: [0, 0, 1], v: [[-CR, -CR, CL], [CR, -CR, CL], [CR, CR, CL], [-CR, CR, CL]] },
    { n: [0, 0, -1], v: [[-CR, CR, -CL], [CR, CR, -CL], [CR, -CR, -CL], [-CR, -CR, -CL]] },
    { n: [-1, 0, 0], v: [[-CL, -CR, CR], [-CL, CR, CR], [-CL, CR, -CR], [-CL, -CR, -CR]] },
    { n: [1, 0, 0], v: [[CL, -CR, -CR], [CL, CR, -CR], [CL, CR, CR], [CL, -CR, CR]] },
    { n: [0, -1, 0], v: [[CR, -CL, -CR], [CR, -CL, CR], [-CR, -CL, CR], [-CR, -CL, -CR]] },
    { n: [0, 1, 0], v: [[-CR, CL, -CR], [-CR, CL, CR], [CR, CL, CR], [CR, CL, -CR]] },
    { n: [-1, -1, 0], v: [[-CR, -CL, -CR], [-CR, -CL, CR], [-CL, -CR, CR], [-CL, -CR, -CR]] },
    { n: [1, 1, 0], v: [[CR, CL, -CR], [CR, CL, CR], [CL, CR, CR], [CL, CR, -CR]] },
    { n: [-1, 1, 0], v: [[-CL, CR, -CR], [-CL, CR, CR], [-CR, CL, CR], [-CR, CL, -CR]] },
    { n: [1, -1, 0], v: [[CL, -CR, -CR], [CL, -CR, CR], [CR, -CL, CR], [CR, -CL, -CR]] },
    { n: [0, -1, -1], v: [[-CR, -CR, -CL], [CR, -CR, -CL], [CR, -CL, -CR], [-CR, -CL, -CR]] },
    { n: [0, 1, 1], v: [[-CR, CR, CL], [CR, CR, CL], [CR, CL, CR], [-CR, CL, CR]] },
    { n: [0, -1, 1], v: [[-CR, -CL, CR], [CR, -CL, CR], [CR, -CR, CL], [-CR, -CR, CL]] },
    { n: [0, 1, -1], v: [[-CR, CL, -CR], [CR, CL, -CR], [CR, CR, -CL], [-CR, CR, -CL]] },
    { n: [-1, 0, -1], v: [[-CL, -CR, -CR], [-CL, CR, -CR], [-CR, CR, -CL], [-CR, -CR, -CL]] },
    { n: [1, 0, 1], v: [[CL, -CR, CR], [CL, CR, CR], [CR, CR, CL], [CR, -CR, CL]] },
    { n: [1, 0, -1], v: [[CR, -CR, -CL], [CR, CR, -CL], [CL, CR, -CR], [CL, -CR, -CR]] },
    { n: [-1, 0, 1], v: [[-CR, -CR, CL], [-CR, CR, CL], [-CL, CR, CR], [-CL, -CR, CR]] },
    { n: [1, 1, 1], v: [[CR, CR, CL], [CL, CR, CR], [CR, CL, CR]] },
    { n: [-1, -1, -1], v: [[-CR, -CL, -CR], [-CL, -CR, -CR], [-CR, -CR, -CL]] },
    { n: [-1, 1, 1], v: [[-CR, CR, CL], [-CR, CL, CR], [-CL, CR, CR]] },
    { n: [1, -1, -1], v: [[CL, -CR, -CR], [CR, -CL, -CR], [CR, -CR, -CL]] },
    { n: [1, -1, 1], v: [[CR, -CR, CL], [CR, -CL, CR], [CL, -CR, CR]] },
    { n: [-1, 1, -1], v: [[-CL, CR, -CR], [-CR, CL, -CR], [-CR, CR, -CL]] },
    { n: [-1, -1, 1], v: [[-CR, -CR, CL], [-CL, -CR, CR], [-CR, -CL, CR]] },
    { n: [1, 1, -1], v: [[CL, CR, -CR], [CR, CR, -CL], [CR, CL, -CR]] },
  ];

  // sticker octagons per orientation 0..5 = back / front / left / right / bottom / top.
  const stickerPolys = [
    { n: [0, 0, -1], v: [[-SS, SL, -SD], [SS, SL, -SD], [SL, SS, -SD], [SL, -SS, -SD], [SS, -SL, -SD], [-SS, -SL, -SD], [-SL, -SS, -SD], [-SL, SS, -SD]] },
    { n: [0, 0, 1], v: [[-SS, -SL, SD], [SS, -SL, SD], [SL, -SS, SD], [SL, SS, SD], [SS, SL, SD], [-SS, SL, SD], [-SL, SS, SD], [-SL, -SS, SD]] },
    { n: [-1, 0, 0], v: [[-SD, -SS, SL], [-SD, SS, SL], [-SD, SL, SS], [-SD, SL, -SS], [-SD, SS, -SL], [-SD, -SS, -SL], [-SD, -SL, -SS], [-SD, -SL, SS]] },
    { n: [1, 0, 0], v: [[SD, -SS, -SL], [SD, SS, -SL], [SD, SL, -SS], [SD, SL, SS], [SD, SS, SL], [SD, -SS, SL], [SD, -SL, SS], [SD, -SL, -SS]] },
    { n: [0, -1, 0], v: [[SL, -SD, -SS], [SL, -SD, SS], [SS, -SD, SL], [-SS, -SD, SL], [-SL, -SD, SS], [-SL, -SD, -SS], [-SS, -SD, -SL], [SS, -SD, -SL]] },
    { n: [0, 1, 0], v: [[-SL, SD, -SS], [-SL, SD, SS], [-SS, SD, SL], [SS, SD, SL], [SL, SD, SS], [SL, SD, -SS], [SS, SD, -SL], [-SS, SD, -SL]] },
  ];

  // fan-triangulate a convex polygon; flip each tri's winding so its geometric
  // normal agrees with the .c's outward normal (flat shading derives the lit normal
  // from winding, so this is what makes each face light from the OUTSIDE).
  function addPoly(pos, verts, normal) {
    for (let t = 1; t + 1 < verts.length; t++) {
      let a = verts[0], b = verts[t], c = verts[t + 1];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * normal[0] + ny * normal[1] + nz * normal[2] < 0) { const tmp = b; b = c; c = tmp; }
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    }
  }
  function makeGeom(polys) {
    const pos = [];
    for (const p of polys) addPoly(pos, p.v, p.n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }
  const bodyGeom = makeGeom(bodyPolys);
  const stickerGeoms = stickerPolys.map((p) => makeGeom([p]));

  // ---- materials: exact .c diffuse colors; specular/emissive per the header ----
  const specularCol = new THREE.Color().setRGB(0.7 / Math.PI, 0.7 / Math.PI, 0.7 / Math.PI, THREE.SRGBColorSpace);
  const emissiveCol = new THREE.Color().setRGB(0.1, 0.1, 0.1, THREE.SRGBColorSpace);   // flat 0.5*0.2 ambient
  const mkMat = (r, g, b) => new THREE.MeshPhongMaterial({
    color: new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace),
    specular: specularCol, shininess: 60, emissive: emissiveCol,
    flatShading: true, side: THREE.FrontSide,
  });
  // stickerMats indexed by the facelet colour value (pickcolor): 0..5 =
  // Red, Yellow, White, Green, Orange, Blue.
  const stickerMats = [
    mkMat(0.5, 0.0, 0.0), mkMat(0.7, 0.7, 0.0), mkMat(0.8, 0.8, 0.8),
    mkMat(0.0, 0.5, 0.0), mkMat(0.9, 0.45, 0.36), mkMat(0.0, 0.0, 0.5),
  ];
  const bodyMat = mkMat(0.2, 0.2, 0.2);

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

  // glFrustum(-1,1,-1,1,5,15) is a SQUARE frustum regardless of window aspect; the
  // .c corrects the resulting viewport stretch with a modelview X-scale (WindH/WindW)
  // instead. So keep the camera aspect fixed at 1 and reproduce that X-scale below.
  const camera = new THREE.PerspectiveCamera((2 * Math.atan(1 / 5) * 180) / Math.PI, 1, 5, 15);
  camera.position.set(0, 0, 10);   // == glTranslatef(0,0,-10) with the cube at origin
  camera.lookAt(0, 0, 0);

  // two directional white lights (eye/world space, fixed as the cube spins), global
  // ambient handled as material.emissive (see header).
  const light0 = new THREE.DirectionalLight(0xffffff, Math.PI); light0.position.set(1, 1, 1); scene.add(light0);
  const light1 = new THREE.DirectionalLight(0xffffff, Math.PI); light1.position.set(-1, -1, 1); scene.add(light1);

  // transform chain (outer -> inner), mirroring draw_rubik:
  //   drift : Translate(PX, PY, 0)                 (bouncing wander)
  //   scale : Scale(Scale4Window * aspect * fit)   (0.9/avsize, X *= H/W, * portrait)
  //   spin  : Rotate(step*100 X, step*95 Y, step*90 Z)
  //   cubeGroup (fixed grid) + sliceGroup (the turning layer)
  const driftGroup = new THREE.Group();
  const scaleGroup = new THREE.Group();
  const spinGroup = new THREE.Group();
  const cubeGroup = new THREE.Group();
  const sliceGroup = new THREE.Group();
  spinGroup.add(cubeGroup); spinGroup.add(sliceGroup);
  scaleGroup.add(spinGroup); driftGroup.add(scaleGroup); scene.add(driftGroup);

  // ---- cube meshes ----
  let cubies = [];          // { group, i, j, k, stickers:[{mesh, face, idx}] }
  let activeSlice = null;   // { axis, layer, rotation } while a move animates

  function mkSticker(colorFace, idx, orient) {
    return { mesh: new THREE.Mesh(stickerGeoms[orient], stickerMats[0]), face: colorFace, idx };
  }
  function buildCube() {
    for (const c of cubies) c.group.removeFromParent();
    cubies = [];
    cubeGroup.clear(); sliceGroup.clear(); sliceGroup.rotation.set(0, 0, 0);
    activeSlice = null;
    const HX = (SX - 1) / 2, HY = (SY - 1) / 2, HZ = (SZ - 1) / 2;
    for (let i = 0; i < SX; i++) for (let j = 0; j < SY; j++) for (let k = 0; k < SZ; k++) {
      if (!(i === 0 || i === SX - 1 || j === 0 || j === SY - 1 || k === 0 || k === SZ - 1)) continue;
      const g = new THREE.Group();
      g.position.set(i - HX, j - HY, k - HZ);
      g.add(new THREE.Mesh(bodyGeom, bodyMat));
      const stickers = [];
      if (k === 0) stickers.push(mkSticker(BACK_FACE, i + SX * j, 0));
      if (k === SZ - 1) stickers.push(mkSticker(FRONT_FACE, i + SX * (SY - 1 - j), 1));
      if (i === 0) stickers.push(mkSticker(LEFT_FACE, k + SZ * (SY - 1 - j), 2));
      if (i === SX - 1) stickers.push(mkSticker(RIGHT_FACE, (SZ - 1 - k) + SZ * (SY - 1 - j), 3));
      if (j === 0) stickers.push(mkSticker(BOTTOM_FACE, i + SX * (SZ - 1 - k), 4));
      if (j === SY - 1) stickers.push(mkSticker(TOP_FACE, i + SX * k, 5));
      for (const s of stickers) g.add(s.mesh);
      cubeGroup.add(g);
      cubies.push({ group: g, i, j, k, stickers });
    }
    builtSX = SX; builtSY = SY; builtSZ = SZ;
  }
  function recolor() {
    for (const c of cubies) for (const s of c.stickers) s.mesh.material = stickerMats[FACE(cubeLoc[s.face][s.idx])];
  }

  // ---- slice animation ----
  function startMove() {
    const slice = convertMove(movement);
    let axis, layer;
    if (slice.face === TOP_FACE) { axis = 'y'; layer = SY - 1 - slice.depth; }
    else if (slice.face === LEFT_FACE) { axis = 'x'; layer = slice.depth; }
    else { axis = 'z'; layer = SZ - 1 - slice.depth; }   // FRONT_FACE
    activeSlice = { axis, layer, rotation: slice.rotation };
    sliceGroup.rotation.set(0, 0, 0);
    for (const c of cubies) {
      const coord = axis === 'x' ? c.i : axis === 'y' ? c.j : c.k;
      if (coord === layer) sliceGroup.add(c.group);
    }
  }
  function endMove() {
    sliceGroup.rotation.set(0, 0, 0);
    for (const c of [...sliceGroup.children]) cubeGroup.add(c);
    activeSlice = null;
  }
  function updateSliceRotation(renderStep) {
    if (!activeSlice) return;
    const signed = (activeSlice.rotation === CCW) ? renderStep : -renderStep;   // degrees
    if (activeSlice.axis === 'y') sliceGroup.rotation.set(0, deg2rad(signed), 0);
    else if (activeSlice.axis === 'x') sliceGroup.rotation.set(deg2rad(-signed), 0, 0);
    else sliceGroup.rotation.set(0, 0, deg2rad(signed));
  }

  // ---- one draw_rubik state tick (ticked at effFps) ----
  function cframe() {
    step += 0.002;
    PX += VX; PY += VY;
    let bounced = false;
    if (PY < -1) { PY += (-1) - PY; VY = -VY; bounced = true; }
    if (PY > 1) { PY -= PY - 1; VY = -VY; bounced = true; }
    if (PX < -1) { PX += (-1) - PX; VX = -VX; bounced = true; }
    if (PX > 1) { PX -= PX - 1; VX = -VX; bounced = true; }
    if (bounced) {
      VX += (rng.LRAND() / MAXRAND) * 0.002 - 0.001;
      VY += (rng.LRAND() / MAXRAND) * 0.002 - 0.001;
      VX = Math.max(-0.006, Math.min(0.006, VX));
      VY = Math.max(-0.006, Math.min(0.006, VY));
    }

    const advance = () => {
      if (activeSlice === null) startMove();
      if (rotatestep === 0) {
        degreeTurn = checkFaceSquare(rowToRotate[movement.face][movement.direction]) ? 90 : 180;
        anglestep = (config.cycles <= 1) ? 90.0 : 90.0 / config.cycles;   // cycles is live
      }
      rotatestep += anglestep;
    };

    if (action === ACTION_SHUFFLE) {
      if (done) {
        if (++doneTimer > DELAY_AFTER_SHUFFLING) { movement.face = NO_FACE; rotatestep = 0; action = ACTION_SOLVE; done = false; doneTimer = 0; }
      } else if (movement.face === NO_FACE) {
        if (shufflingmoves < storedmoves) { rotatestep = 0; movement = { ...moves[shufflingmoves] }; }
        else { rotatestep = 0; done = true; doneTimer = 0; }
      } else {
        advance();
        if (rotatestep > degreeTurn) { evalmovement(movement); needsRecolor = true; endMove(); shufflingmoves++; movement.face = NO_FACE; }
      }
    } else {   // ACTION_SOLVE
      if (done) {
        if (++doneTimer > DELAY_AFTER_SOLVING) shuffle();
      } else if (movement.face === NO_FACE) {
        if (storedmoves > 0) {
          rotatestep = 0;
          movement = { ...moves[storedmoves - 1] };
          movement.direction = (movement.direction + (MAXORIENT / 2)) % MAXORIENT;   // inverse
        } else { rotatestep = 0; done = true; doneTimer = 0; }
      } else {
        advance();
        if (rotatestep > degreeTurn) { evalmovement(movement); needsRecolor = true; endMove(); storedmoves--; movement.face = NO_FACE; }
      }
    }
  }

  // ---- sizing (reshape_rubik: fixed square frustum + the aspect X-scale) ----
  let winW = window.innerWidth, winH = window.innerHeight;
  function syncSize() {
    winW = window.innerWidth; winH = window.innerHeight;
    renderer.setSize(winW, winH, false);
    // camera.aspect stays 1 (see the frustum note); aspect handled by the X-scale.
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- init: init_rubik + pinit -> shuffle ----
  step = rng.NRAND(90);
  PX = (rng.LRAND() / MAXRAND) * 2.0 - 1.0;
  PY = (rng.LRAND() / MAXRAND) * 2.0 - 1.0;
  shuffle();

  // ---- render loop ----
  let raf = 0, last = 0, paused = false, ms = 16, acc = 0;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last; last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    acc += dt * effFps;
    let n = 0;
    while (acc >= 1 && n < MAX_TICKS) { cframe(); acc -= 1; n++; }
    if (n === MAX_TICKS) acc = 0;
    const frac = acc;   // [0,1) -- interpolate continuous motion for 60fps smoothness

    const W = winW, H = winH;
    driftGroup.position.set(PX + VX * frac, PY + VY * frac, 0);
    const sWin = 0.9 / avsize;                       // Scale4Window
    const sPortrait = (W < H) ? W / H : 1;
    scaleGroup.scale.set(sWin * (H / W) * sPortrait, sWin * sPortrait, sWin * sPortrait);
    const rstep = step + 0.002 * frac;
    spinGroup.rotation.set(deg2rad(rstep * 100), deg2rad(rstep * 95), deg2rad(rstep * 90), 'XYZ');

    if (needsRecolor) { recolor(); needsRecolor = false; }
    updateSliceRotation(Math.min(rotatestep + anglestep * frac, degreeTurn));

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      bodyGeom.dispose();
      for (const g of stickerGeoms) g.dispose();
      bodyMat.dispose();
      for (const m of stickerMats) m.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; acc = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { shuffle(); },   // fresh scramble now (host 're-seed')
    config,
    params,
  };
}

export default { title, info, start };
