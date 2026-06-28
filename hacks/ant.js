// ant.js — ant packaged as a mountable module.
// start(canvas) returns { stop, reinit, config, params }.
//
// Port of xscreensaver's ant.c by David Bagley (1995), after Chris Langton's
// ants / Greg Turk's "turmites". https://www.jwz.org/xscreensaver/
//
// A turmite crawls a toroidal grid that doubles as its tape: it reads the cell
// under it, looks up a rule (machine[color + state*ncolors] -> write a colour,
// turn, change state), paints the cell, then steps to a neighbour. From these
// few-bit rules emerge highways, spirals and builders. The rule is a random
// "Turk's number" (or one of a few preset tables); colour trails persist, the
// ant head is white, and the dish resets every `cycles` generations.
//
// Scope: the SQUARE grid (4 neighbours), the iconic case. ant.c's hexagon /
// triangle grids, Truchet lines, eyes and sharp-turns aren't ported yet.

export const title = 'ant';

export const info = {
  author: 'David Bagley',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 4.22.\n\nA cellular automaton that is really a two-dimensional Turing machine: as the heads ("ants") walk along the screen, they change pixel values in their path. Then, as they pass over changed pixels, their behavior is influenced.\n\nhttps://en.wikipedia.org/wiki/Langton%27s_ant\nhttps://en.wikipedia.org/wiki/Turing_machine',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  const config = {
    size: 6,         // cell size in px
    count: 4,        // number of ants sharing the tape
    delay: 10,       // ms per generation
    cycles: 40000,   // generations before the dish resets
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 1, max: 60, step: 1, default: 10, unit: ' ms', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'size', label: 'Cell size', type: 'range', min: 2, max: 24, step: 1, default: 6, unit: ' px', lowLabel: 'small', highLabel: 'big', live: false },
    { key: 'count', label: 'Ants', type: 'range', min: 1, max: 12, step: 1, default: 4, live: false },
    { key: 'cycles', label: 'Lifespan', type: 'range', min: 1000, max: 100000, step: 1000, default: 40000, live: true },
  ];

  // Relative ant moves (ant.c). *S = turn-then-step; S* = step-then-turn.
  const FS = 0, TRS = 1, THRS = 2, TBS = 3, THLS = 4, TLS = 5,
        SF = 6, STR = 7, STHR = 8, STB = 9, STHL = 10, STL = 11;
  const ANGLES = 360;
  const NB = 4;   // square grid

  // Three preset rule tables from ant.c: [ncolors, nstates, (color,move,next)*].
  const TABLES = [
    { nc: 4, ns: 1, data: [1, STR, 0, 2, STL, 0, 3, TRS, 0, 0, TLS, 0] },             // ladder builder
    { nc: 2, ns: 2, data: [1, TLS, 0, 0, FS, 1, 1, TRS, 0, 1, TRS, 0] },              // spiral
    { nc: 2, ns: 2, data: [1, TLS, 0, 0, FS, 1, 0, TRS, 0, 1, TRS, 0] },              // square builder
  ];

  let ncols, nrows, cellPx, cellDraw;
  let tape;                 // colour per cell
  let ants;                 // [{ col, row, direction, state }]
  let machine;              // [{ color, direction, next }] indexed color + state*ncolors
  let ncolors, nstates;
  let palette;              // CSS colours for cell values 1..ncolors-1 (0 = black)
  let generation;
  let lastFill = null;

  // Map a relative move to an absolute angle delta (ant.c fromTableDirection).
  function fromTableDirection(dir) {
    switch (dir) {
      case FS:   return 0;
      case TLS:  return ANGLES / NB;
      case THLS: return 2 * ANGLES / NB;
      case TBS:  return ((NB / 2) | 0) * ANGLES / NB;
      case THRS: return ANGLES - 2 * ANGLES / NB;
      case TRS:  return ANGLES - ANGLES / NB;
      case SF:   return ANGLES;
      case STL:  return ANGLES + ANGLES / NB;
      case STHL: return ANGLES + 2 * ANGLES / NB;
      case STB:  return ANGLES + ((NB / 2) | 0) * ANGLES / NB;
      case STHR: return 2 * ANGLES - 2 * ANGLES / NB;
      case STR:  return 2 * ANGLES - ANGLES / NB;
    }
    return 0;
  }

  // A random "Turk's number": ncolors = i+2 colours cycling, each turning left
  // or right per a bit of the number.
  function getTurk(i) {
    let power2 = 1 << (i + 1);
    const number = ((Math.random() * (power2 - 1)) | 0) + power2;
    ncolors = i + 2;
    nstates = 1;
    const total = ncolors * nstates;
    machine = new Array(total);
    for (let j = 0; j < total; j++) {
      machine[j] = {
        color: (j + 1) % total,
        direction: (power2 & number) ? fromTableDirection(TRS) : fromTableDirection(TLS),
        next: 0,
      };
      power2 >>= 1;
    }
  }

  function getTable(t) {
    const tab = TABLES[t];
    ncolors = tab.nc;
    nstates = tab.ns;
    const total = ncolors * nstates;
    machine = new Array(total);
    for (let j = 0; j < total; j++) {
      machine[j] = {
        color: tab.data[j * 3],
        direction: fromTableDirection(tab.data[j * 3 + 1]),
        next: tab.data[j * 3 + 2],
      };
    }
  }

  function buildMachine() {
    if (Math.random() < 1 / 6) getTable((Math.random() * TABLES.length) | 0);
    else getTurk((Math.random() * 7) | 0);   // ncolors 2..8
  }

  function buildPalette() {
    palette = new Array(ncolors);
    for (let c = 1; c < ncolors; c++) {
      const h = (c - 1) * 360 / Math.max(1, ncolors - 1);
      palette[c] = `hsl(${h}, 100%, 55%)`;
    }
  }

  function fill(col, row, style) {
    if (style !== lastFill) { ctx.fillStyle = style; lastFill = style; }
    ctx.fillRect(col * cellPx, row * cellPx, cellDraw, cellDraw);
  }

  function drawcell(col, row, color) {
    fill(col, row, color ? palette[color] : '#000');
  }

  function drawAnt(col, row) {
    fill(col, row, '#fff');
  }

  // Step one ant by one generation in the new direction (4-neighbour wrap).
  function moveAnt(ant, dir) {
    dir = ((dir % ANGLES) + ANGLES) % ANGLES;
    if (dir === 0) ant.col = ant.col + 1 === ncols ? 0 : ant.col + 1;
    else if (dir === 90) ant.row = ant.row === 0 ? nrows - 1 : ant.row - 1;
    else if (dir === 180) ant.col = ant.col === 0 ? ncols - 1 : ant.col - 1;
    else if (dir === 270) ant.row = ant.row + 1 === nrows ? 0 : ant.row + 1;
  }

  function step() {
    for (let i = 0; i < ants.length; i++) {
      const a = ants[i];
      const pos = a.col + a.row * ncols;
      const color = tape[pos];
      const status = machine[color + a.state * ncolors];

      drawcell(a.col, a.row, status.color);   // paint + write the tape
      tape[pos] = status.color;

      const oldDir = a.direction;
      const chgDir = (2 * ANGLES - status.direction) % ANGLES;
      a.direction = (chgDir + oldDir) % ANGLES;
      a.state = status.next;

      // status.direction < ANGLES means turn-then-step; else step in old dir.
      const moveDir = status.direction < ANGLES ? a.direction : oldDir;
      moveAnt(a, moveDir);
      drawAnt(a.col, a.row);
    }

    if (++generation > config.cycles) init();
  }

  function init() {
    const dpr = window.devicePixelRatio || 1;
    cellPx = Math.max(1, Math.round(config.size * dpr));
    cellDraw = cellPx - (cellPx > 3 ? 1 : 0);   // 1px gridline, like the original

    ncols = Math.max(2, Math.floor(canvas.width / cellPx));
    nrows = Math.max(2, Math.floor(canvas.height / cellPx));

    buildMachine();
    buildPalette();
    tape = new Uint8Array(ncols * nrows);
    generation = 0;

    lastFill = null;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // All ants start at the centre, facing a random (90°-aligned) direction.
    const col = ncols >> 1;
    const row = nrows >> 1;
    const dir = ((Math.random() * NB) | 0) * ANGLES / NB;
    const n = Math.max(1, Math.round(config.count));
    ants = [];
    for (let i = 0; i < n; i++) ants.push({ col, row, direction: dir, state: 0 });
    drawAnt(col, row);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delay = Math.max(1, config.delay);
    lag = Math.min(lag, delay * MAX_CATCHUP_STEPS);
    let steps = 0;
    while (lag >= delay && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delay;
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
    reinit: init,   // new rule + grid + ants with the current config
    config,
    params,
  };
}
