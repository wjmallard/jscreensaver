// loop.js — loop packaged as a mountable module.
// start(canvas) runs the hack on the given canvas and returns { stop } to tear
// it down (cancel the rAF loop, drop the resize listener), so a host page can
// cycle hacks on one shared canvas. Loop/sizing stay inline per hack for now.

export const title = 'loop';

export const info = {
  author: 'David Bagley',
  description: 'A cellular automaton that generates loop-shaped colonies that spawn, age, and eventually die.\n\nhttps://en.wikipedia.org/wiki/Langton%27s_loops',
  year: 1999,
};

export function start(canvas) {
    // loop - port of xscreensaver/xlockmore hack by David Bagley (1995),
    // implementing Chris Langton's self-reproducing loops (Physica 10D, 1984).
    // https://www.jwz.org/xscreensaver/
    //
    // An 8-state cellular automaton on a square (von Neumann, 4-neighbour) grid.
    // From a single seed "loop" (the Adam loop) a sheathed strand of data circles
    // and, when it reaches the loop's open arm, extrudes a daughter loop. The
    // colony grows outward like a coral reef: the outer loops keep reproducing
    // while the inner ones, walled in by their daughters, fall dormant. When the
    // colony fills the dish (or the pattern stops changing) it restarts.
    //
    // Scope: the SQUARE grid (4 neighbours), the iconic case. loop.c's hexagon
    // (6-neighbour) variant and its "blue wall flaw" mutations aren't ported.
    //
    // The crux is the transition table. Each rule is an octal CBLTRI word
    // (Center, Bottom, Left, Top, Right -> next state I), and each rule is
    // entered under all four 90-degree rotations, so a cell's next state depends
    // only on its own state and the multiset/cyclic-order of its 4 neighbours.
    // Verified offline: from the Adam seed the population grows and multiple
    // independent loops form -- the signature of correct self-reproduction.

    const ctx = canvas.getContext('2d');

    // Configuration. Units/defaults follow hacks/config/loop.xml so the tuning
    // UI maps 1:1 to the original (delay converted from the C's microseconds to
    // milliseconds for the rAF clock; default eased a touch calmer than stock).
    const config = {
      size: 12,        // cell size in px (the xml's --size, abs value)
      cycles: 1600,    // generations before the colony restarts (--cycles)
      delay: 100,      // ms per generation (xml --delay was 100000 us)
    };

    // Tunable params for the host config box.
    // live: true  -> the loop reads config[key] every step (applies instantly).
    // live: false -> the value sizes the grid, so a change re-runs init().
    const params = [
      { key: 'delay', label: 'Frame rate', type: 'range', min: 1, max: 200, step: 1, default: 100, unit: ' ms', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
      { key: 'size', label: 'Cell size', type: 'range', min: 2, max: 24, step: 1, default: 12, unit: ' px', lowLabel: 'small', highLabel: 'big', live: false },
      { key: 'cycles', label: 'Lifespan', type: 'range', min: 200, max: 8000, step: 100, default: 1600, lowLabel: 'short', highLabel: 'long', live: true },
    ];

    // The square transition table from loop.c, verbatim. Each entry is an octal
    // word read right-to-left as CBLTRI: I (next state) is the low digit, then
    // R, T, L, B, and C (center) is the high digit. State 0 surrounded by 0s
    // stays 0 (the first rule), so the dead background never spontaneously lights.
    const TRANSITION_TABLE = [
      0o0000000, 0o0025271, 0o0113221, 0o0202422, 0o0301021,
      0o0000012, 0o0100011, 0o0122244, 0o0202452, 0o0301220,
      0o0000020, 0o0100061, 0o0122277, 0o0202520, 0o0302511,
      0o0000030, 0o0100077, 0o0122434, 0o0202552, 0o0401120,
      0o0000050, 0o0100111, 0o0122547, 0o0202622, 0o0401220,
      0o0000063, 0o0100121, 0o0123244, 0o0202722, 0o0401250,
      0o0000071, 0o0100211, 0o0123277, 0o0203122, 0o0402120,
      0o0000112, 0o0100244, 0o0124255, 0o0203216, 0o0402221,
      0o0000122, 0o0100277, 0o0124267, 0o0203226, 0o0402326,
      0o0000132, 0o0100511, 0o0125275, 0o0203422, 0o0402520,
      0o0000212, 0o0101011, 0o0200012, 0o0204222, 0o0403221,
      0o0000220, 0o0101111, 0o0200022, 0o0205122, 0o0500022,
      0o0000230, 0o0101244, 0o0200042, 0o0205212, 0o0500215,
      0o0000262, 0o0101277, 0o0200071, 0o0205222, 0o0500225,
      0o0000272, 0o0102026, 0o0200122, 0o0205521, 0o0500232,
      0o0000320, 0o0102121, 0o0200152, 0o0205725, 0o0500272,
      0o0000525, 0o0102211, 0o0200212, 0o0206222, 0o0500520,
      0o0000622, 0o0102244, 0o0200222, 0o0206722, 0o0502022,
      0o0000722, 0o0102263, 0o0200232, 0o0207122, 0o0502122,
      0o0001022, 0o0102277, 0o0200242, 0o0207222, 0o0502152,
      0o0001120, 0o0102327, 0o0200250, 0o0207422, 0o0502220,
      0o0002020, 0o0102424, 0o0200262, 0o0207722, 0o0502244,
      0o0002030, 0o0102626, 0o0200272, 0o0211222, 0o0502722,
      0o0002050, 0o0102644, 0o0200326, 0o0211261, 0o0512122,
      0o0002125, 0o0102677, 0o0200423, 0o0212222, 0o0512220,
      0o0002220, 0o0102710, 0o0200517, 0o0212242, 0o0512422,
      0o0002322, 0o0102727, 0o0200522, 0o0212262, 0o0512722,
      0o0005222, 0o0105427, 0o0200575, 0o0212272, 0o0600011,
      0o0012321, 0o0111121, 0o0200722, 0o0214222, 0o0600021,
      0o0012421, 0o0111221, 0o0201022, 0o0215222, 0o0602120,
      0o0012525, 0o0111244, 0o0201122, 0o0216222, 0o0612125,
      0o0012621, 0o0111251, 0o0201222, 0o0217222, 0o0612131,
      0o0012721, 0o0111261, 0o0201422, 0o0222272, 0o0612225,
      0o0012751, 0o0111277, 0o0201722, 0o0222442, 0o0700077,
      0o0014221, 0o0111522, 0o0202022, 0o0222462, 0o0701120,
      0o0014321, 0o0112121, 0o0202032, 0o0222762, 0o0701220,
      0o0014421, 0o0112221, 0o0202052, 0o0222772, 0o0701250,
      0o0014721, 0o0112244, 0o0202073, 0o0300013, 0o0702120,
      0o0016251, 0o0112251, 0o0202122, 0o0300022, 0o0702221,
      0o0017221, 0o0112277, 0o0202152, 0o0300041, 0o0702251,
      0o0017255, 0o0112321, 0o0202212, 0o0300076, 0o0702321,
      0o0017521, 0o0112424, 0o0202222, 0o0300123, 0o0702525,
      0o0017621, 0o0112621, 0o0202272, 0o0300421, 0o0702720,
      0o0017721, 0o0112727, 0o0202321, 0o0300622,
    ];

    // The Adam loop (loop.c self_reproducing_loop, 10x10). Row j, column i.
    const ADAM = [
      [0, 2, 2, 2, 2, 2, 2, 2, 2, 0],
      [2, 4, 0, 1, 4, 0, 1, 1, 1, 2],
      [2, 1, 2, 2, 2, 2, 2, 2, 1, 2],
      [2, 0, 2, 0, 0, 0, 0, 2, 1, 2],
      [2, 7, 2, 0, 0, 0, 0, 2, 7, 2],
      [2, 1, 2, 0, 0, 0, 0, 2, 0, 2],
      [2, 0, 2, 0, 0, 0, 0, 2, 1, 2],
      [2, 7, 2, 2, 2, 2, 2, 2, 7, 2],
      [2, 1, 0, 6, 1, 0, 7, 1, 0, 2],
      [0, 2, 2, 2, 2, 2, 2, 2, 2, 0],
    ];
    const ADAM_N = 10;   // ADAM_LOOPX == ADAM_LOOPY == ADAM_SIZE + 2

    // Eight state colours. The C used: 0 black, 1 red, 2 blue, 3 magenta,
    // 4 green, 5 yellow, 6 cyan, 7 white. We keep that mapping but in vivid
    // full-saturation HSL (state 0 stays the black background).
    const COLORS = [
      '#000000',                 // 0 background
      'hsl(0, 100%, 55%)',       // 1 red    (sheath data)
      'hsl(220, 100%, 58%)',     // 2 blue   (the loop's outer wall)
      'hsl(300, 100%, 60%)',     // 3 magenta
      'hsl(120, 100%, 50%)',     // 4 green
      'hsl(55, 100%, 55%)',      // 5 yellow
      'hsl(185, 100%, 55%)',     // 6 cyan
      'hsl(0, 0%, 100%)',        // 7 white
    ];

    let cols, rows;            // active cell area (excludes the 1-cell border)
    let bncols, bnrows;        // grid incl. a 1-cell dead border on every side
    let cellPx, cellDraw;      // device px per cell; drawn size (gridline gutter)
    let cells, next;           // 8-state grid + its double buffer (incl. border)
    let table;                 // 4096-entry packed rule lookup (8 outputs/entry)
    let clockwise;             // handedness: mirror the seed and the lookup
    let generation;
    // Active bounding box (in border-grid coords), grown as the colony spreads.
    let minCol, minRow, maxCol, maxRow;
    let lastFill = null;

    // Build the 4096-entry table once. TABLE(R,T,L,B) lives at
    // table[(B<<9)|(L<<6)|(T<<3)|R]; each of the 8 center states packs a 3-bit
    // output, so TABLE_OUT(C,...) = (entry >> (C*3)) & 7. Every rule is inserted
    // under all 4 rotations -- (R,T,L,B), (T,L,B,R), (L,B,R,T), (B,R,T,L) --
    // exactly as loop.c's init_table does for the square grid.
    function buildTable() {
      if (table) return;
      table = new Uint32Array(4096);
      const put = (C, R, T, L, B, I) => {
        table[(B << 9) | (L << 6) | (T << 3) | R] |= (I << (C * 3));
      };
      for (let e = 0; e < TRANSITION_TABLE.length; e++) {
        let tt = TRANSITION_TABLE[e];
        const I = tt & 7; tt >>= 3;        // next state (low octal digit)
        const R = tt & 7; tt >>= 3;        // n[0] east
        const T = tt & 7; tt >>= 3;        // n[1] north
        const L = tt & 7; tt >>= 3;        // n[2] west
        const B = tt & 7; tt >>= 3;        // n[3] south
        const C = tt & 7;                  // center (high octal digit)
        put(C, R, T, L, B, I);
        put(C, T, L, B, R, I);
        put(C, L, B, R, T, I);
        put(C, B, R, T, L, I);
      }
    }

    function fill(col, row, style) {
      if (style !== lastFill) { ctx.fillStyle = style; lastFill = style; }
      ctx.fillRect(col * cellPx, row * cellPx, cellDraw, cellDraw);
    }

    // (col,row) are active-area coords (0..cols-1); the grid is offset by the
    // 1-cell border, so the cell at border index (i,j) draws at (i-1,j-1).
    function drawCell(col, row, state) {
      fill(col, row, COLORS[state]);
    }

    // Advance one generation: for each active cell read its 4 neighbours from
    // `cells` and write its next state into `next`. Out-of-grid reads can't
    // happen here because the border ring is never active. Clockwise loops use
    // the mirror lookup TABLE_OUT(c, B, L, T, R), matching loop.c's do_gen.
    function doGen() {
      const lo = bncols;
      for (let j = minRow; j <= maxRow; j++) {
        const base = j * bncols;
        for (let i = minCol; i <= maxCol; i++) {
          const c = cells[base + i];
          const R = cells[base + i + 1];     // dir 0   east
          const T = cells[base + i - lo];    // dir 90  north
          const L = cells[base + i - 1];     // dir 180 west
          const B = cells[base + i + lo];    // dir 270 south
          const idx = clockwise
            ? (R << 9) | (T << 6) | (L << 3) | B   // mirror: (B,L,T,R)
            : (B << 9) | (L << 6) | (T << 3) | R;  // (R,T,L,B)
          next[base + i] = (table[idx] >> (c * 3)) & 7;
        }
      }
    }

    // Seed the Adam loop in the centre with a random handedness and draw it.
    function initAdam() {
      clockwise = Math.random() < 0.5;
      // Centre the loop in the active area, then shift into border coords.
      const sx = ((cols - ADAM_N) >> 1) + 1;
      const sy = ((rows - ADAM_N) >> 1) + 1;
      for (let j = 0; j < ADAM_N; j++) {
        for (let i = 0; i < ADAM_N; i++) {
          const v = clockwise ? ADAM[j][ADAM_N - 1 - i] : ADAM[j][i];
          cells[(sy + j) * bncols + (sx + i)] = v;
          if (v) drawCell(sx + i - 1, sy + j - 1, v);
        }
      }
      // Active box starts as the loop's footprint (clamped inside the border).
      minCol = Math.max(1, sx - 1);
      minRow = Math.max(1, sy - 1);
      maxCol = Math.min(bncols - 2, sx + ADAM_N);
      maxRow = Math.min(bnrows - 2, sy + ADAM_N);
    }

    function init() {
      const dpr = window.devicePixelRatio || 1;
      cellPx = Math.max(1, Math.round(config.size * dpr));
      cellDraw = cellPx - (cellPx > 3 ? 1 : 0);   // 1px gridline, like the C

      // Active grid sized to the canvas, with room for at least one loop.
      cols = Math.max(ADAM_N + 1, Math.floor(canvas.width / cellPx));
      rows = Math.max(ADAM_N + 1, Math.floor(canvas.height / cellPx));
      bncols = cols + 2;
      bnrows = rows + 2;

      buildTable();
      cells = new Uint8Array(bncols * bnrows);
      next = new Uint8Array(bncols * bnrows);
      generation = 0;

      lastFill = null;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      initAdam();
    }

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      init();
    }

    function step() {
      // Compute the next generation, then draw only the cells that changed
      // (the wavefronts), growing the active box outward as the colony spreads.
      // `dead` detects a frozen pattern -> restart, like loop.c's draw_loop.
      doGen();

      let dead = true;
      for (let j = minRow; j <= maxRow; j++) {
        const base = j * bncols;
        for (let i = minCol; i <= maxCol; i++) {
          const o = base + i;
          if (cells[o] !== next[o]) {
            dead = false;
            cells[o] = next[o];
            drawCell(i - 1, j - 1, next[o]);
            if (i === minCol && i > 1) minCol--;
            if (j === minRow && j > 1) minRow--;
            if (i === maxCol && i < bncols - 2) maxCol++;
            if (j === maxRow && j < bnrows - 2) maxRow++;
          } else {
            cells[o] = next[o];
          }
        }
      }

      if (++generation > config.cycles || dead) init();
    }

    // Drive off requestAnimationFrame but keep the original pace: run one
    // step() per config.delay ms, banking leftover time so the speed is the
    // same at any refresh rate. Cap catch-up so a backgrounded tab (where rAF
    // is paused) doesn't fire a burst of steps when it regains focus.
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
      reinit: init,   // fresh dish + new Adam loop with the current config
      config,
      params,
    };
}
