// ant.js — ant packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's ant.c by David Bagley (1995), after Chris Langton's
// ants / Greg Turk's "turmites". https://www.jwz.org/xscreensaver/
//
// A turmite crawls a toroidal grid that doubles as its tape: it reads the cell
// under it, looks up a rule (machine[color + state*ncolors] -> write a colour,
// turn, change state), paints the cell, then steps to a neighbour. From these
// few-bit rules emerge highways, spirals and builders. The rule is a random
// "Turk's number" (or one of three preset tables); colour trails persist, the
// ant head is white, and the dish resets every `cycles` generations.
//
// Cell shapes: the turmite rule is shape-independent — only the GRID geometry
// and the relative-move -> absolute-angle mapping change with `neighbors`.
// All of ant.c's shapes are ported: SQUARE (4 or 8 neighbours), HEXAGON (6),
// TRIANGLE (3 or 12). The default randomizes the shape per reset (8 and 12 are
// rare), exactly like the C's neighbors == 0.
//
// Palette: xlockmore gives ant color_scheme_default (ant.c defines no
// SMOOTH/UNIFORM/BRIGHT macro), i.e. make_random_colormap(bright_p = False) —
// `ncolors` INDEPENDENT, fully-random RGB colours, NOT a smooth ramp and NOT a
// saturated rainbow. The cell colours are then random samples of that base
// palette (the C's ap->colors[] / MI_PIXEL indexing).

import { makeRandomColormapRGB } from './colormap.js';

export const title = 'ant';

export const info = {
  author: 'David Bagley',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 4.22.\n\nA cellular automaton that is really a two-dimensional Turing machine: as the heads ("ants") walk along the screen, they change pixel values in their path. Then, as they pass over changed pixels, their behavior is influenced.\n\nhttps://en.wikipedia.org/wiki/Langton%27s_ant\nhttps://en.wikipedia.org/wiki/Turing_machine',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/ant.xml (1:1 with the original).
  // `delay` is microseconds (one generation per step, like the C's draw_ant);
  // `cycles` is the generation lifespan before the dish resets; `count`/`size`
  // are the xml's signed spinbuttons (NEGATIVE = random magnitude, per init_ant);
  // `ncolors` is the size of the random colour pool; `neighbors` is the cell
  // shape (0 = random, the C's DEF_NEIGHBORS).
  const config = {
    delay: 20000,    // microseconds per generation (--delay)
    cycles: 40000,   // generations before the dish resets (--cycles)
    count: -3,       // ant count; <0 => random 1..|count| (--count)
    size: -12,       // cell size; <0 => random (--size)
    ncolors: 64,     // size of the random colour pool (--ncolors)
    neighbors: '0',  // cell shape: 0=random, 3, 4, 6, 9, 12 (--neighbors)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cycles', label: 'Timeout', type: 'range', min: 1000, max: 800000, step: 1000, default: 40000, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'count', label: 'Ant count', type: 'range', min: -20, max: 20, step: 1, default: -3, live: false },
    { key: 'size', label: 'Ant size', type: 'range', min: -18, max: 18, step: 1, default: -12, live: false },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 3, max: 255, step: 1, default: 64, lowLabel: 'three', highLabel: 'many', live: false },
    { key: 'neighbors', label: 'Cell shape', type: 'select', default: '0', live: false, options: [
        { value: '0', label: 'Random cell shape' },
        { value: '3', label: 'Three sided cells' },
        { value: '4', label: 'Four sided cells' },
        { value: '6', label: 'Six sided cells' },
        { value: '9', label: 'Nine sided cells' },
        { value: '12', label: 'Twelve sided cells' },
      ] },
  ];

  // Relative ant moves (ant.c). *S = turn-then-step; S* = step-then-turn.
  const FS = 0, TRS = 1, THRS = 2, TBS = 3, THLS = 4, TLS = 5,
        SF = 6, STR = 7, STHR = 8, STB = 9, STHL = 10, STL = 11;
  const ANGLES = 360;
  const NUMSTIPPLES = 11;   // automata.h: caps ncolors and gates getTable
  const MINANTS = 1, MINSIZE = 1, MINGRIDSIZE = 24, MINRANDOMSIZE = 5;
  const DEG = Math.PI / 180;
  const PLOTS = [3, 4, 6, 8, 12];            // ant.c plots[] (NUMBER_9 undefined)
  const GOODNEIGHBORKINDS = 3;               // first 3 of PLOTS (3,4,6) are common

  // Unit polygons (automata.h); scaled per cell into hexDelta / triDelta.
  const hexUnit = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 2 }, { x: -1, y: 1 }, { x: -1, y: -1 }, { x: 0, y: -2 }];
  const triUnit = [
    [{ x: 0, y: 0 }, { x: 1, y: -1 }, { x: 0, y: 2 }],
    [{ x: 0, y: 0 }, { x: -1, y: 1 }, { x: 0, y: -2 }],
  ];

  // Three preset rule tables from ant.c: [ncolors, nstates, (color,move,next)*].
  const TABLES = [
    { nc: 4, ns: 1, data: [1, STR, 0, 2, STL, 0, 3, TRS, 0, 0, TLS, 0] },   // ladder builder
    { nc: 2, ns: 2, data: [1, TLS, 0, 0, FS, 1, 1, TRS, 0, 1, TRS, 0] },    // spiral
    { nc: 2, ns: 2, data: [1, TLS, 0, 0, FS, 1, 0, TRS, 0, 1, TRS, 0] },    // square builder
  ];
  const NTABLES = TABLES.length;

  // getTable's sharpturn swap (neighbors > 4): hard<->normal left/right.
  const SHARP_SWAP = { [TRS]: THRS, [THRS]: TRS, [THLS]: TLS, [TLS]: THLS, [STR]: STHR, [STHR]: STR, [STHL]: STL, [STL]: STHL };

  let cssW, cssH;           // logical (CSS px) drawing size; C geometry is exact here
  let neighbors;            // current cell shape: 3, 4, 6, 8 or 12
  let ncols, nrows, xs, ys, xb, yb;
  let hexDelta, triDelta;   // per-cell relative polygon vertices (shape deltas)
  let tape;                 // colour per cell
  let truchetState;         // truchet arc state per cell (+1; 0 = none)
  let ants;                 // [{ col, row, direction, state }]
  let machine;              // [{ color, direction, next }] indexed color + state*antNcolors
  let antNcolors, nstates;
  let basePalette;          // make_random_colormap base ([r,g,b], built once per run)
  let antColorStr;          // CSS colours for cell values 0..antNcolors-1 (0 = black)
  let truchet, eyes, sharpturn;   // randomized each reset (xlockmore fullrandom = True)
  let initDir;              // initial ant direction (hex sharpturn truchet needs it)
  let generation;
  let lastFill = null;

  // NRAND(n): a uniform integer in [0, n), matching the C's (random() % n).
  const rnd = (n) => Math.floor(Math.random() * n);
  // LRAND() & 1: a fair coin, matching the C's fullrandom toggles.
  const lbit = () => Math.random() < 0.5;
  // C integer division (truncates toward zero), used by the geometry math.
  const idiv = (a, b) => Math.trunc(a / b);

  // Map a relative move to an absolute angle delta (ant.c fromTableDirection).
  // Crafted to work for any neighbor count, so it stays exact for odd counts.
  function fromTableDirection(dir, nb) {
    switch (dir) {
      case FS:   return 0;
      case TLS:  return ANGLES / nb;
      case THLS: return 2 * ANGLES / nb;
      case TBS:  return idiv(nb, 2) * ANGLES / nb;
      case THRS: return ANGLES - 2 * ANGLES / nb;
      case TRS:  return ANGLES - ANGLES / nb;
      case SF:   return ANGLES;
      case STL:  return ANGLES + ANGLES / nb;
      case STHL: return ANGLES + 2 * ANGLES / nb;
      case STB:  return ANGLES + idiv(nb, 2) * ANGLES / nb;
      case STHR: return 2 * ANGLES - 2 * ANGLES / nb;
      case STR:  return 2 * ANGLES - ANGLES / nb;
    }
    return 0;
  }

  // ant.c init_ant: a fixed shape (3/4/6/8/12) is used as-is; anything else
  // (0 = random, or 9 since NUMBER_9 is undefined) randomizes, with 8 and 12
  // rare (1/10) and 3/4/6 common (9/10).
  function pickNeighbors() {
    const req = parseInt(config.neighbors, 10);
    if (PLOTS.indexOf(req) !== -1) return req;
    if (rnd(10) === 0) return PLOTS[rnd(PLOTS.length)];
    return PLOTS[rnd(GOODNEIGHBORKINDS)];
  }

  // A random "Turk's number": ncolors = i+2 colours cycling, each turning left
  // or right per a bit of the number (hard turns when sharpturn & neighbors > 4).
  function getTurk(i) {
    let power2 = 1 << (i + 1);
    const number = rnd(power2 - 1) + power2;   // not all-1s in binary
    antNcolors = i + 2;
    nstates = 1;
    const total = antNcolors * nstates;
    machine = new Array(total);
    for (let j = 0; j < total; j++) {
      let direction;
      if (sharpturn && neighbors > 4)
        direction = (power2 & number) ? fromTableDirection(THRS, neighbors) : fromTableDirection(THLS, neighbors);
      else
        direction = (power2 & number) ? fromTableDirection(TRS, neighbors) : fromTableDirection(TLS, neighbors);
      machine[j] = { color: (j + 1) % total, direction, next: 0 };
      power2 >>= 1;
    }
    // ap->truchet gated to cell size and to the shapes that draw it.
    truchet = truchet && xs > 2 && ys > 2 && (neighbors === 3 || neighbors === 4 || neighbors === 6);
  }

  function getTable(t) {
    const tab = TABLES[t];
    antNcolors = tab.nc;
    nstates = tab.ns;
    const total = antNcolors * nstates;
    machine = new Array(total);
    for (let j = 0; j < total; j++) {
      let mv = tab.data[j * 3 + 1];
      if (sharpturn && neighbors > 4 && SHARP_SWAP[mv] !== undefined) mv = SHARP_SWAP[mv];
      machine[j] = {
        color: tab.data[j * 3],
        direction: fromTableDirection(mv, neighbors),
        next: tab.data[j * 3 + 2],
      };
    }
    truchet = false;   // ant.c: tables never use Truchet lines
  }

  function buildMachine() {
    if (rnd(NUMSTIPPLES) === 0) getTable(rnd(NTABLES));   // 1/11
    else getTurk(rnd(NUMSTIPPLES - 1));                   // ncolors 2..11
  }

  // make_random_colormap(bright_p = False): `ncolors` fully-random RGB colours.
  // Built ONCE per run (xlockmore's one-time color setup), like vines.
  function buildBasePalette() {
    const np = Math.min(255, Math.max(3, Math.round(config.ncolors)));
    basePalette = makeRandomColormapRGB(np, false);
  }

  // Cell colours: random samples of the base palette, exactly the C's
  //   ap->colors[i] = (unsigned char)(NRAND(npixels) + i*npixels) / (ncolors-1)
  // Note the cast binds before the divide, so the sum is truncated to 8 bits
  // (& 0xFF, i.e. it wraps) BEFORE dividing — clustering/wrapping the indices,
  // not an even spread. Drawn fresh each reset (init_ant), then rendered via
  // MI_PIXEL(ap->colors[color-1]).
  function resampleAntColors() {
    const np = basePalette.length;
    const div = Math.max(1, antNcolors - 1);
    antColorStr = new Array(antNcolors);
    antColorStr[0] = '#000';
    for (let c = 1; c < antNcolors; c++) {
      let idx = Math.floor(((rnd(np) + (c - 1) * np) & 0xFF) / div);
      if (idx < 0) idx = 0; else if (idx >= np) idx = np - 1;
      const [r, g, b] = basePalette[idx];
      antColorStr[c] = `rgb(${r}, ${g}, ${b})`;
    }
  }

  // ---- geometry: per-shape cell polygons (CoordModePrevious accumulation) ----

  function buildHexDelta() {
    hexDelta = new Array(7);
    for (let i = 0; i < 6; i++) {
      hexDelta[i] = {
        x: (xs - 1) * hexUnit[i].x,
        y: idiv(idiv((ys - 1) * hexUnit[i].y, 2) * 4, 3),
      };
    }
    hexDelta[6] = { x: 0, y: 0 };   // padding (truchet reads hexagon[side+1])
  }

  function buildTriDelta() {
    triDelta = [new Array(4), new Array(4)];
    for (let o = 0; o < 2; o++) {
      for (let i = 0; i < 3; i++) {
        triDelta[o][i] = {
          x: (xs - 2) * triUnit[o][i].x,
          y: (ys - 2) * triUnit[o][i].y,
        };
      }
      triDelta[o][3] = { x: 0, y: 0 };
    }
  }

  // fillcell, all shapes. Square is a rectangle with the C's 1px gridline gap;
  // hexagon/triangle are filled polygons (or a single point when tiny).
  function paintCell(col, row, style) {
    if (style !== lastFill) { ctx.fillStyle = style; lastFill = style; }
    if (neighbors === 4 || neighbors === 8) {
      ctx.fillRect(xb + xs * col, yb + ys * row, xs - (xs > 3 ? 1 : 0), ys - (ys > 3 ? 1 : 0));
    } else if (neighbors === 6) {
      const ccol = 2 * col + ((row & 1) ? 0 : 1), crow = 2 * row;
      let px = xb + ccol * xs, py = yb + crow * ys;
      if (xs === 1 && ys === 1) { ctx.fillRect(px, py, 1, 1); return; }
      const p = new Path2D();
      p.moveTo(px, py);
      for (let s = 1; s < 6; s++) { px += hexDelta[s].x; py += hexDelta[s].y; p.lineTo(px, py); }
      p.closePath();
      ctx.fill(p);
    } else {   // TRI (3 or 12)
      const orient = (col + row) & 1;          // 0 left, 1 right
      const baseX = xb + col * xs, baseY = yb + row * ys;
      if (xs <= 3 || ys <= 3) { ctx.fillRect((orient ? -1 : 1) + baseX, baseY, 1, 1); return; }
      let px = baseX + (orient ? (idiv(xs, 2) - 1) : -(idiv(xs, 2) - 1)), py = baseY;
      const p = new Path2D();
      p.moveTo(px, py);
      for (let s = 1; s < 3; s++) { px += triDelta[orient][s].x; py += triDelta[orient][s].y; p.lineTo(px, py); }
      p.closePath();
      ctx.fill(p);
    }
  }

  function drawcell(col, row, color) {
    paintCell(col, row, color ? antColorStr[color] : '#000');
  }

  // XDrawArc(x,y,w,h,a1deg,a2deg) as a 1px-stroked canvas ellipse arc. X angles
  // run CCW from 3-o'clock (y up); canvas runs CW (y down), so negate.
  function arcX(x, y, w, h, a1, a2) {
    const rx = w / 2, ry = h / 2;
    if (rx <= 0 || ry <= 0) return;
    ctx.beginPath();
    ctx.ellipse(x + rx, y + ry, rx, ry, 0, -a1 * DEG, -(a1 + a2) * DEG, a2 > 0);
    ctx.stroke();
  }

  // ---- truchet: per-shape arc overlays (drawtruchet / truchetcell) ----
  // Arcs are black on a coloured cell (MI_NPIXELS > 2), white on the background.

  function truchetSquare(col, row, ts) {
    const X = xb + xs * col, Y = yb + ys * row;
    const hx = idiv(xs, 2), hy = idiv(ys, 2);
    if (ts) {
      arcX(X - hx + 1, Y + hy - 1, xs - 2, ys - 2, 0, 90);
      arcX(X + hx - 1, Y - hy + 1, xs - 2, ys - 2, -90, -90);
    } else {
      arcX(X - hx + 1, Y - hy + 1, xs - 2, ys - 2, 0, -90);
      arcX(X + hx - 1, Y + hy - 1, xs - 2, ys - 2, 90, 90);
    }
  }

  function truchetHex(col, row, ts) {
    const ccol = 2 * col + ((row & 1) ? 0 : 1), crow = 2 * row;
    const fudge = 7;
    if (sharpturn) {
      let hx = xb + ccol * xs - Math.trunc(xs / 2.0) - 1;
      let hy = yb + crow * ys - Math.trunc(ys / 2.0) - 1;
      for (let side = 0; side < 6; side++) {
        if (side) { hx += hexDelta[side].x; hy += hexDelta[side].y; }
        if (ts === side % 2)
          arcX(hx, hy, xs, ys, (570 - side * 60 + fudge) % 360, 120 - 2 * fudge);
      }
    } else {
      let hx = xb + ccol * xs - Math.trunc(xs * 1.6 / 2.0) - 1;
      let hy = yb + crow * ys - Math.trunc(ys * 1.6 / 2.0) - 1;
      for (let side = 0; side < 6; side++) {
        if (side) { hx += hexDelta[side].x; hy += hexDelta[side].y; }
        let h2x = hx + idiv(hexDelta[side + 1].x, 2);
        let h2y = hy + idiv(hexDelta[side + 1].y, 2) + 1;
        if (side === 1) { h2x += Math.trunc(xs * 0.1 + 1); h2y += Math.trunc(ys * 0.1 - (ys > 5 ? 1 : 0)); }
        else if (side === 2) { h2x += Math.trunc(xs * 0.1); }
        else if (side === 4) { h2x += Math.trunc(xs * 0.1); h2y += Math.trunc(ys * 0.1 - 1); }
        else if (side === 5) { h2x += Math.trunc(xs * 0.5); h2y += Math.trunc(-ys * 0.3 + 1); }
        if (ts === side % 3)
          arcX(h2x, h2y, Math.trunc(xs * 1.5), Math.trunc(ys * 1.5), (555 - side * 60) % 360, 90);
      }
    }
  }

  function truchetTri(col, row, ts) {
    const orient = (col + row) & 1;
    const fudge = 7, fudge2 = 1.18;
    let tx = xb + col * xs, ty = yb + row * ys;
    if (orient) tx += idiv(xs, 2) - 1; else tx -= idiv(xs, 2) - 1;
    for (let side = 0; side < 3; side++) {
      if (side > 0) { tx += triDelta[orient][side].x; ty += triDelta[orient][side].y; }
      if (ts === side) {
        const ang = orient ? ((510 - side * 120) % 360) : ((690 - side * 120) % 360);
        arcX(Math.trunc(tx - xs * fudge2 / 2), Math.trunc(ty - 3 * ys * fudge2 / 4),
             Math.trunc(xs * fudge2), Math.trunc(3 * ys * fudge2 / 2),
             ang + fudge, 60 - 2 * fudge);
      }
    }
  }

  function drawTruchet(col, row, color, ts) {
    ctx.strokeStyle = color ? '#000' : '#fff';
    ctx.lineWidth = 1;
    if (neighbors === 6) truchetHex(col, row, ts);
    else if (neighbors === 4) truchetSquare(col, row, ts);
    else if (neighbors === 3) truchetTri(col, row, ts);
  }

  // ---- the ant head (white) plus optional black eyes (draw_anant) ----

  function eyesSquare(col, row, direction) {
    if (!(xs > 3 && ys > 3)) return;
    const X = xb + xs * col, Y = yb + ys * row;
    const hx = idiv(xs, 2), hy = idiv(ys, 2);
    let pts = null;
    switch (direction) {
      case 0:   pts = [[X + xs - 3, Y + hy - 2], [X + xs - 3, Y + hy]]; break;
      case 45:  pts = [[X + xs - 4, Y + 1], [X + xs - 3, Y + 2]]; break;
      case 90:  pts = [[X + hx - 2, Y + 1], [X + hx, Y + 1]]; break;
      case 135: pts = [[X + 2, Y + 1], [X + 1, Y + 2]]; break;
      case 180: pts = [[X + 1, Y + hy - 2], [X + 1, Y + hy]]; break;
      case 225: pts = [[X + 2, Y + ys - 3], [X + 1, Y + ys - 4]]; break;
      case 270: pts = [[X + hx - 2, Y + ys - 3], [X + hx, Y + ys - 3]]; break;
      case 315: pts = [[X + xs - 4, Y + ys - 3], [X + xs - 3, Y + ys - 4]]; break;
    }
    if (pts) for (const [px, py] of pts) ctx.fillRect(px, py, 1, 1);
  }

  function eyesHex(col, row, direction) {
    if (!(xs > 3 && ys > 3)) return;
    const ccol = 2 * col + ((row & 1) ? 0 : 1), crow = 2 * row;
    let hx = xb + ccol * xs;
    let hy = yb + crow * ys + idiv(ys, 2);
    const ang = idiv(direction * neighbors, ANGLES);
    for (let side = 0; side < neighbors; side++) {
      if (side) { hx -= idiv(hexDelta[side].x, 2); hy += idiv(hexDelta[side].y, 2); }
      if (side === (neighbors + ang - 2) % neighbors) ctx.fillRect(hx, hy, 1, 1);
      if (side === (neighbors + ang - 1) % neighbors) ctx.fillRect(hx, hy, 1, 1);
    }
  }

  function eyesTri(col, row, direction) {
    if (!(xs > 6 && ys > 6)) return;
    const orient = (col + row) & 1;
    let tx = xb + col * xs, ty = yb + row * ys;
    if (orient) tx += idiv(xs, 6) - 1; else tx -= idiv(xs, 6) - 1;
    const ang = idiv(direction * neighbors, ANGLES);
    if (neighbors === 12) return;   // UNDER_CONSTRUCTION: no eyes for 12 sides
    for (let side = 0; side < 3; side++) {
      if (side) { tx += idiv(triDelta[orient][side].x, 3); ty += idiv(triDelta[orient][side].y, 3); }
      if (side === (ang + 2) % 3) ctx.fillRect(tx, ty, 1, 1);
      if (side === (ang + 1) % 3) ctx.fillRect(tx, ty, 1, 1);
    }
  }

  function drawAnt(col, row, direction) {
    paintCell(col, row, '#fff');
    if (!eyes) return;
    ctx.fillStyle = '#000'; lastFill = '#000';
    if (neighbors === 6) eyesHex(col, row, direction);
    else if (neighbors === 4 || neighbors === 8) eyesSquare(col, row, direction);
    else eyesTri(col, row, direction);
  }

  // position_of_neighbor: step one cell in `dir`, per shape (toroidal wrap).
  function moveAnt(a, dir) {
    dir = ((dir % ANGLES) + ANGLES) % ANGLES;
    let col = a.col, row = a.row;
    if (neighbors === 6) {
      switch (dir) {
        case 0:   col = (col + 1 === ncols) ? 0 : col + 1; break;
        case 60:  if (!(row & 1)) col = (col + 1 === ncols) ? 0 : col + 1; row = (!row) ? nrows - 1 : row - 1; break;
        case 120: if (row & 1) col = (!col) ? ncols - 1 : col - 1; row = (!row) ? nrows - 1 : row - 1; break;
        case 180: col = (!col) ? ncols - 1 : col - 1; break;
        case 240: if (row & 1) col = (!col) ? ncols - 1 : col - 1; row = (row + 1 === nrows) ? 0 : row + 1; break;
        case 300: if (!(row & 1)) col = (col + 1 === ncols) ? 0 : col + 1; row = (row + 1 === nrows) ? 0 : row + 1; break;
      }
    } else if (neighbors === 4 || neighbors === 8) {
      switch (dir) {
        case 0:   col = (col + 1 === ncols) ? 0 : col + 1; break;
        case 45:  col = (col + 1 === ncols) ? 0 : col + 1; row = (!row) ? nrows - 1 : row - 1; break;
        case 90:  row = (!row) ? nrows - 1 : row - 1; break;
        case 135: col = (!col) ? ncols - 1 : col - 1; row = (!row) ? nrows - 1 : row - 1; break;
        case 180: col = (!col) ? ncols - 1 : col - 1; break;
        case 225: col = (!col) ? ncols - 1 : col - 1; row = (row + 1 === nrows) ? 0 : row + 1; break;
        case 270: row = (row + 1 === nrows) ? 0 : row + 1; break;
        case 315: col = (col + 1 === ncols) ? 0 : col + 1; row = (row + 1 === nrows) ? 0 : row + 1; break;
      }
    } else {   // TRI (3 or 12): staggered rows, the column steps by 2
      if ((col + row) % 2) {   // right
        switch (dir) {
          case 0:   col = (!col) ? ncols - 1 : col - 1; break;
          case 30: case 40: col = (!col) ? ncols - 1 : col - 1; row = (!row) ? nrows - 1 : row - 1; break;
          case 60:  col = (!col) ? ncols - 1 : col - 1; if (!row) row = nrows - 2; else if (!(row - 1)) row = nrows - 1; else row = row - 2; break;
          case 80: case 90: if (!row) row = nrows - 2; else if (!(row - 1)) row = nrows - 1; else row = row - 2; break;
          case 120: row = (!row) ? nrows - 1 : row - 1; break;
          case 150: case 160: col = (col + 1 === ncols) ? 0 : col + 1; row = (!row) ? nrows - 1 : row - 1; break;
          case 180: col = (col + 1 === ncols) ? 0 : col + 1; break;
          case 200: case 210: col = (col + 1 === ncols) ? 0 : col + 1; row = (row + 1 === nrows) ? 0 : row + 1; break;
          case 240: row = (row + 1 === nrows) ? 0 : row + 1; break;
          case 270: case 280: if (row + 1 === nrows) row = 1; else if (row + 2 === nrows) row = 0; else row = row + 2; break;
          case 300: col = (!col) ? ncols - 1 : col - 1; if (row + 1 === nrows) row = 1; else if (row + 2 === nrows) row = 0; else row = row + 2; break;
          case 320: case 330: col = (!col) ? ncols - 1 : col - 1; row = (row + 1 === nrows) ? 0 : row + 1; break;
        }
      } else {   // left
        switch (dir) {
          case 0:   col = (col + 1 === ncols) ? 0 : col + 1; break;
          case 30: case 40: col = (col + 1 === ncols) ? 0 : col + 1; row = (row + 1 === nrows) ? 0 : row + 1; break;
          case 60:  col = (col + 1 === ncols) ? 0 : col + 1; if (row + 1 === nrows) row = 1; else if (row + 2 === nrows) row = 0; else row = row + 2; break;
          case 80: case 90: if (row + 1 === nrows) row = 1; else if (row + 2 === nrows) row = 0; else row = row + 2; break;
          case 120: row = (row + 1 === nrows) ? 0 : row + 1; break;
          case 150: case 160: col = (!col) ? ncols - 1 : col - 1; row = (row + 1 === nrows) ? 0 : row + 1; break;
          case 180: col = (!col) ? ncols - 1 : col - 1; break;
          case 200: case 210: col = (!col) ? ncols - 1 : col - 1; row = (!row) ? nrows - 1 : row - 1; break;
          case 240: row = (!row) ? nrows - 1 : row - 1; break;
          case 270: case 280: if (!row) row = nrows - 2; else if (row === 1) row = nrows - 1; else row = row - 2; break;
          case 300: col = (col + 1 === ncols) ? 0 : col + 1; if (!row) row = nrows - 2; else if (row === 1) row = nrows - 1; else row = row - 2; break;
          case 320: case 330: col = (col + 1 === ncols) ? 0 : col + 1; row = (!row) ? nrows - 1 : row - 1; break;
        }
      }
    }
    a.col = col; a.row = row;
  }

  // draw_ant: one generation = move every ant one cell (no batching; the C does
  // exactly one generation per call, then sleeps `delay`).
  function step() {
    for (let k = 0; k < ants.length; k++) {
      const ant = ants[k];
      const pos = ant.col + ant.row * ncols;
      const color = tape[pos];
      const st = machine[color + ant.state * antNcolors];

      drawcell(ant.col, ant.row, st.color);   // paint + write the tape
      tape[pos] = st.color;

      const oldDir = ant.direction;
      const chgDir = (2 * ANGLES - st.direction) % ANGLES;
      ant.direction = (chgDir + oldDir) % ANGLES;

      if (truchet) {
        let a = 0;
        if (neighbors === 6) {
          if (sharpturn) {
            const av = (((ANGLES + ant.direction - oldDir) % ANGLES) === 240) ? 1 : 0;
            const bv = (initDir % 120) ? 0 : 1;
            a = ((av && !bv) || (bv && !av)) ? 1 : 0;
          } else {
            a = (idiv(oldDir, 60) % 3 + idiv(ant.direction, 60) % 3 + 1) % 3;
          }
        } else if (neighbors === 4) {
          const av = idiv(oldDir, 180), bv = idiv(ant.direction, 180);
          a = ((av && !bv) || (bv && !av)) ? 1 : 0;
        } else if (neighbors === 3) {
          if (chgDir === 240) a = (2 + idiv(ant.direction, 120)) % 3;
          else a = (1 + idiv(ant.direction, 120)) % 3;
        }
        drawTruchet(ant.col, ant.row, st.color, a);
        truchetState[pos] = a + 1;
      }

      ant.state = st.next;

      // status.direction < ANGLES means turn-then-step; else step in old dir.
      const moveDir = st.direction < ANGLES ? ant.direction : oldDir;
      moveAnt(ant, moveDir);
      drawAnt(ant.col, ant.row, ant.direction);
    }

    if (++generation > config.cycles) init();
  }

  function init() {
    neighbors = pickNeighbors();

    // The C clamps a tiny window before sizing (per shape).
    let w = cssW, h = cssH;
    if (neighbors === 6) { if (w < 8) w = 8; if (h < 8) h = 8; }
    else if (neighbors !== 4 && neighbors !== 8) { if (w < 2) w = 2; if (h < 2) h = 2; }

    // Cell size from the `size` resource (identical across shapes in init_ant).
    const gridMax = Math.max(MINSIZE, idiv(Math.min(w, h), MINGRIDSIZE));
    const size = Math.round(config.size);
    if (size < -MINSIZE) {
      ys = rnd(Math.min(-size, gridMax)) + MINSIZE;   // random 1..min(|size|,gridMax)
      if (ys < MINRANDOMSIZE) ys = Math.min(MINRANDOMSIZE, gridMax);
    } else if (size < MINSIZE) {
      ys = size === 0 ? gridMax : MINSIZE;
    } else {
      ys = Math.min(size, gridMax);
    }

    if (neighbors === 6) {
      xs = ys;
      const nccols = Math.max(idiv(w, xs) - 2, 2);
      const ncrows = Math.max(idiv(h, ys) - 1, 4);
      ncols = idiv(nccols, 2);
      nrows = 2 * idiv(ncrows, 4);
      xb = idiv(w - xs * nccols, 2) + idiv(xs, 2);
      yb = idiv(h - ys * idiv(ncrows, 2) * 2, 2) + ys - 2;
      buildHexDelta();
    } else if (neighbors === 4 || neighbors === 8) {
      xs = ys;
      ncols = Math.max(idiv(w, xs), 2);
      nrows = Math.max(idiv(h, ys), 2);
      xb = idiv(w - xs * ncols, 2);
      yb = idiv(h - ys * nrows, 2);
    } else {   // TRI (3 or 12)
      xs = Math.trunc(1.52 * ys);
      ncols = idiv(Math.max(idiv(w, xs) - 1, 2), 2) * 2;
      nrows = idiv(Math.max(idiv(h, ys) - 1, 2), 2) * 2;
      xb = idiv(w - xs * ncols, 2) + idiv(xs, 2);
      yb = idiv(h - ys * nrows, 2) + ys;
      buildTriDelta();
    }

    // fullrandom = True is hardcoded in xlockmore, so the .xml truchet/eyes/
    // sharpturn toggles are inert and these are randomized every reset instead.
    truchet = lbit();
    eyes = lbit();
    sharpturn = lbit();

    buildMachine();        // sets antNcolors/nstates/machine; may clear/gate truchet
    resampleAntColors();   // cell colours = MI_PIXEL samples of the base palette

    tape = new Uint8Array(ncols * nrows);
    truchetState = new Uint8Array(ncols * nrows);
    generation = 0;

    lastFill = null;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cssW, cssH);
    lastFill = '#000';

    // All ants start at the centre, facing a random shape-aligned direction.
    let row = idiv(nrows, 2);
    let col = idiv(ncols, 2);
    if (col > 0 && ((neighbors % 2) || neighbors === 12) && lbit()) col--;
    const dir = rnd(neighbors) * ANGLES / neighbors;
    initDir = dir;
    let n = Math.round(config.count);
    if (n < -MINANTS) n = rnd(-n) + MINANTS;   // negative => random 1..|count|
    else if (n < MINANTS) n = MINANTS;
    ants = [];
    for (let k = 0; k < n; k++) ants.push({ col, row, direction: dir, state: 0 });
    drawAnt(col, row, dir);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    cssW = window.innerWidth;
    cssH = window.innerHeight;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    // Draw in CSS px so the C's pixel geometry is exact; dpr only sharpens.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    init();
  }

  // Fixed-timestep lag-accumulator loop: one generation per config.delay,
  // banking leftover time so the pace is steady at any refresh rate.
  //
  // OVERHEAD: the stock --delay is only a sleep floor; the live binary's real
  // rate is lower (delay + framework overhead -- see the framerate-calibration
  // note). The live ant measures 37.9 fps, but the port at the stock 20000 us ran
  // 50 generations/sec (1.3x fast). 20000 + 6385 = 26385 us -> 37.9 gen/sec,
  // matching the live binary. A calibration, not a tuning knob (the delay
  // slider still maps 1:1 to the xml resource).
  const OVERHEAD = 6385;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
    const delayMs = Math.max(0.001, (config.delay + OVERHEAD) / 1000);
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Rebuild after a non-live config change: ncolors resizes the base palette
  // (the only rebuild outside startup), then a fresh shape + grid + rule + ants.
  function reinit() {
    buildBasePalette();
    init();
  }

  window.addEventListener('resize', resize);
  buildBasePalette();   // built once for the whole run (the C's one-time colour setup)
  resize();
  rafId = requestAnimationFrame(frame);

  return {
    stop() {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
    },
    pause() { cancelAnimationFrame(rafId); rafId = 0; },
    resume() { if (!rafId) { lastTime = 0; rafId = requestAnimationFrame(frame); } },
    reinit,
    config,
    params,
  };
}
