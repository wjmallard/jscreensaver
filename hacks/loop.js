// loop.js — loop packaged as a mountable module.
// start(canvas) runs the hack on the given canvas and returns { stop } to tear
// it down (cancel the rAF loop, drop the resize listener), so a host page can
// cycle hacks on one shared canvas. Loop/sizing stay inline per hack for now.

import { makeColorRampRGB } from './colormap.js';

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
    // Scope: the SQUARE grid (4 neighbours), the iconic case. loop.c's default
    // -neighbors 0 randomises between the square and a HEXAGON (6-neighbour)
    // variant; the hexagon grid (its 262144-entry rule table + hex geometry) is
    // NOT ported. The square grid's "blue wall flaw" feature (loop.c's default
    // --count -5 sprinkles 0..5 random blue debris each restart) IS ported.
    //
    // The crux is the transition table. Each rule is an octal CBLTRI word
    // (Center, Bottom, Left, Top, Right -> next state I), and each rule is
    // entered under all four 90-degree rotations, so a cell's next state depends
    // only on its own state and the multiset/cyclic-order of its 4 neighbours.

    const ctx = canvas.getContext('2d');

    // Configuration. Names/defaults/ranges follow hacks/config/loop.xml so the
    // tuning UI maps 1:1 to the original. `delay` is the usleep interval in
    // MICROSECONDS (the xml resource), divided to ms for the rAF clock.
    const config = {
      delay: 100000,   // usleep between generations, microseconds (xml --delay)
      cycles: 1600,    // generations before the colony restarts (xml --cycles)
      ncolors: 15,     // framework colormap size; sets the 8 state hues (--ncolors)
      size: -12,       // cell size px; <0 = random magnitude, 0 = auto (xml --size)
    };

    // Tunable params for the host config box (mirrors loop.xml exactly).
    // live: true  -> the loop reads config[key] every step (applies instantly).
    // live: false -> the value sizes the grid / palette, so a change re-runs init().
    // NB `size` mirrors the xml spinbutton (-50..50, default -12); a NEGATIVE value
    // means "random magnitude up to |size|" (the xlockmore convention), 0 = auto-fit.
    const params = [
      { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 200000, step: 1000, default: 100000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
      { key: 'cycles', label: 'Timeout', type: 'range', min: 0, max: 8000, step: 100, default: 1600, lowLabel: 'small', highLabel: 'large', live: true },
      { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 15, lowLabel: 'two', highLabel: 'many', live: false },
      { key: 'size', label: 'Size', type: 'range', min: -50, max: 50, step: 1, default: -12, lowLabel: 'small', highLabel: 'big', live: false },
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
    const MINSIZE = 5;          // loop.c MINSIZE
    const MINGRIDSIZE = 30;     // loop.c MINGRIDSIZE = 3*ADAM_LOOPX

    // Helpers. aRand mirrors the C's NRAND(n): a random integer in [0, n-1].
    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
    function aRand(n) { return Math.floor(Math.random() * Math.max(1, n)); }

    // Eight state colours. loop.c #defines UNIFORM_COLORS, so the xlockmore
    // framework fills the colormap with make_uniform_colormap, which is
    // make_color_ramp(0,S,V -> 359,S,V) with S (saturation) and V (value) each a
    // single RANDOM value in 66%..100% held for the whole session (utils/colors.c).
    // init_loop then sets 8 fixed state colours by sampling that hue ramp at evenly
    // spaced indices (k*ncolors/REALCOLORS, REALCOLORS=6), plus black (state 0) and
    // white (state 7). So the palette is a per-session random-S/V hue wheel, NOT
    // fixed vivid primaries, and `ncolors` quantises the hues. We rebuild the exact
    // ramp via colormap.js's make_color_ramp and pick the same indices. S/V are
    // fixed across colony restarts (as in the C); rebuilt only when ncolors changes.
    let COLORS = null;
    let builtNP = -1;
    function buildColors() {
      const NP = clamp(Math.round(config.ncolors), 2, 255);   // MI_NPIXELS
      if (COLORS && NP === builtNP) return;
      builtNP = NP;
      const REALCOLORS = 6;
      const S = (Math.floor(Math.random() * 34) + 66) / 100;  // make_uniform_colormap
      const V = (Math.floor(Math.random() * 34) + 66) / 100;
      const ramp = makeColorRampRGB(0, S, V, 359, S, V, NP, false);
      const css = (rgb) => 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
      const at = (k) => css(ramp[Math.floor(k * NP / REALCOLORS)]);
      COLORS = [
        '#000000',     // 0 background (MI_BLACK_PIXEL)
        css(ramp[0]),  // 1 red     (MI_PIXEL 0)
        at(4),         // 2 blue    (MI_PIXEL 4*NP/6)
        at(5),         // 3 magenta (MI_PIXEL 5*NP/6)
        at(2),         // 4 green   (MI_PIXEL 2*NP/6)
        at(1),         // 5 yellow  (MI_PIXEL 1*NP/6)
        at(3),         // 6 cyan    (MI_PIXEL 3*NP/6)
        '#ffffff',     // 7 white   (MI_WHITE_PIXEL)
      ];
    }

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

    // Write one cell (border coords) and grow the active bbox to include it.
    // Clamped to the interior so doGen's neighbour reads stay on-grid; the seed
    // and the centred flaws are interior on any sane grid, so this never clips.
    function setCell(col, row, v) {
      if (col < 1 || col > bncols - 2 || row < 1 || row > bnrows - 2) return;
      cells[row * bncols + col] = v;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
    }

    // A "blue wall flaw" (loop.c init_flaw, square branch): a 3-cell blue elbow at
    // a random, roughly centred spot. Verbatim placement; BLUE = state 2. The
    // colony collides with this debris, which liven things up / spawns mutants.
    function initFlaw() {
      const BLUE = 2;
      if (bncols <= 3 || bnrows <= 3) return;
      const aw = Math.min(bncols - 3, 2 * MINGRIDSIZE);
      const a = aRand(aw) + Math.floor((bncols - aw) / 2);
      const bw = Math.min(bnrows - 3, 2 * MINGRIDSIZE);
      const b = aRand(bw) + Math.floor((bnrows - bw) / 2);
      const orient = aRand(4);
      setCell(a + 1, b + 1, BLUE);                                 // center
      if (orient === 0 || orient === 1) setCell(a + 1, b, BLUE);     // top
      if (orient === 1 || orient === 2) setCell(a + 2, b + 1, BLUE); // right
      if (orient === 2 || orient === 3) setCell(a + 1, b + 2, BLUE); // bottom
      if (orient === 3 || orient === 0) setCell(a, b + 1, BLUE);     // left
    }

    // loop.c init_loop seeds `flaws` of them, where flaws = NRAND(-count+1) for a
    // negative count. The xml does not expose --count, so it stays at the baked-in
    // DEFAULTS value of -5 -> 0..5 flaws per restart.
    function initFlaws() {
      const count = -5;
      const flaws = count < 0 ? aRand(-count + 1) : count;
      for (let i = 0; i < flaws; i++) initFlaw();
    }

    // Seed the Adam loop with a random handedness AND a random 90-degree
    // orientation (loop.c init_adam, square branch: dir = NRAND(4), placed via the
    // dirx/diry basis vectors). clockwise mirrors the seed columns (ADAM[j][N-1-i]).
    // Cells are only written here; drawInitial() paints the whole seed afterwards.
    function initAdam() {
      clockwise = Math.random() < 0.5;
      const dir = aRand(4);                 // NRAND(local_neighbors), square = 4
      let sx, sy, dxX, dxY, dyX, dyY;       // start point + dirx/diry basis
      switch (dir) {
        case 0: sx = Math.floor((bncols - ADAM_N) / 2); sy = Math.floor((bnrows - ADAM_N) / 2); dxX = 1; dxY = 0; dyX = 0; dyY = 1; break;
        case 1: sx = Math.floor((bncols + ADAM_N) / 2); sy = Math.floor((bnrows - ADAM_N) / 2); dxX = 0; dxY = 1; dyX = -1; dyY = 0; break;
        case 2: sx = Math.floor((bncols + ADAM_N) / 2); sy = Math.floor((bnrows + ADAM_N) / 2); dxX = -1; dxY = 0; dyX = 0; dyY = -1; break;
        default: sx = Math.floor((bncols - ADAM_N) / 2); sy = Math.floor((bnrows + ADAM_N) / 2); dxX = 0; dxY = -1; dyX = 1; dyY = 0; break;
      }
      for (let j = 0; j < ADAM_N; j++) {
        for (let i = 0; i < ADAM_N; i++) {
          const v = clockwise ? ADAM[j][ADAM_N - 1 - i] : ADAM[j][i];
          setCell(sx + dxX * i + dyX * j, sy + dxY * i + dyY * j, v);
        }
      }
    }

    // Paint the whole seeded dish once (the first frame's "diff against an all-0
    // grid" in loop.c's draw_loop). The canvas is already black, so only non-0
    // cells need drawing; the final cell value is used, so a flaw overwritten by a
    // 0 of the seed correctly stays black.
    function drawInitial() {
      for (let j = minRow; j <= maxRow; j++) {
        const base = j * bncols;
        for (let i = minCol; i <= maxCol; i++) {
          const v = cells[base + i];
          if (v) drawCell(i - 1, j - 1, v);
        }
      }
    }

    function init() {
      buildColors();
      const dpr = window.devicePixelRatio || 1;

      // Cell size (CSS px), faithful to loop.c init_loop: a NEGATIVE --size means
      // "random magnitude in [MINSIZE, |size|]", 0 = auto-fit, positive = fixed;
      // all capped so at least MINGRIDSIZE cells fit. (loop.c's >2560px retina *3
      // hack is replaced by dpr scaling: cells are a constant CSS size, sharpened
      // to device px, so counts stay in CSS px and rendering stays crisp.)
      const cssW = window.innerWidth, cssH = window.innerHeight;
      const cap = Math.max(MINSIZE, Math.floor(Math.min(cssW, cssH) / MINGRIDSIZE));
      const sz = Math.round(config.size);
      let ys;
      if (sz < -MINSIZE) ys = aRand(Math.min(-sz, cap) - MINSIZE + 1) + MINSIZE;
      else if (sz < MINSIZE) ys = (sz === 0) ? cap : MINSIZE;
      else ys = Math.min(sz, cap);

      cellPx = Math.max(1, Math.round(ys * dpr));
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

      // Empty-bbox sentinel; initFlaws + initAdam expand it (as loop.c's init_loop
      // sets mincol = bncols-1 etc. then init_flaw/init_adam lower/raise it).
      minCol = bncols; minRow = bnrows; maxCol = -1; maxRow = -1;
      initFlaws();
      initAdam();

      // Grow the bbox by a 1-cell margin: the port runs doGen BEFORE the diff that
      // grows the box, so every active cell must already have its neighbours
      // in-box (the front advances <=1 cell/gen). Then clamp inside the border.
      minCol = Math.max(1, minCol - 1);
      minRow = Math.max(1, minRow - 1);
      maxCol = Math.min(bncols - 2, maxCol + 1);
      maxRow = Math.min(bnrows - 2, maxRow + 1);

      drawInitial();
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
    // step() per config.delay (microseconds -> ms), banking leftover time so the
    // speed is the same at any refresh rate. Cap catch-up so a backgrounded tab
    // (where rAF is paused) doesn't fire a burst of steps when it regains focus.
    //
    // OVERHEAD: the stock --delay is only a sleep floor; the live binary's real
    // rate is lower (delay + framework overhead -- see the framerate-calibration
    // note). The live loop measures 8.9 fps, but the port at the stock 100000 us
    // ran 10 steps/sec (1.12x fast). 100000 + 12360 = 112360 us -> 8.9 steps/sec,
    // matching the live binary. A calibration, not a tuning knob (the delay
    // slider still maps 1:1 to the xml resource).
    const OVERHEAD = 12360;
    const MAX_CATCHUP_STEPS = 8;
    let lastTime = 0;
    let lag = 0;
    let rafId = 0;

    function frame(now) {
      if (lastTime === 0) lastTime = now;
      lag += now - lastTime;
      lastTime = now;

      const delayMs = (config.delay + OVERHEAD) / 1000;
      lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);
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
      reinit: init,   // fresh dish + new Adam loop with the current config
      config,
      params,
    };
}
