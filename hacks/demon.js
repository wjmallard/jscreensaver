// demon.js — demon packaged as a mountable module.
// start(canvas) runs the hack on the given canvas and returns { stop } to tear
// it down (cancel the rAF loop, drop the resize listener), so a host page can
// cycle hacks on one shared canvas. Loop/sizing stay inline per hack for now.
//
// Port of xscreensaver/xlockmore demon.c by David Bagley (1995), after David
// Griffeath's cyclic cellular automata. https://www.jwz.org/xscreensaver/
//
// Cyclic CA: each cell holds a state in [0, states). A cell advances to
// (state + 1) % states if ANY neighbour is already in that next state (a
// threshold-1 rule), otherwise it holds. From random soup this self-organises
// into rotating spiral waves ("debris -> droplets -> defects -> demons") and
// reseeds with fresh noise every `cycles` generations.
//
// Grids (the -neighbors option; randomised by default, exactly as the C's
// DEF_NEIGHBORS="0"): hexagons (6), squares (4 = von Neumann, 8 = Moore), or
// triangles (3, 9, or 12). The neighbour offset tables for all six are
// transcribed cell-for-cell from demon.c's draw_demon.
//
// Colour: the C uses make_uniform_colormap (utils/colors.c) — a hue ramp 0->359
// at a single random saturation & value in 66%-100%, with `ncolors` entries.
// State 0 is drawn BLACK; state s>=1 samples that ramp at
// ((s-1)*ncolors/(states-1)) % ncolors. So there is a dark band in the cycle
// (state 0) and the palette is a faithful, slightly-muted rainbow, NOT a
// full-saturation one.
//
// Timing: draw_demon spreads one generation across (states + 1) framework ticks
// — one tick computes the next generation, then `states` ticks each paint the
// cells that changed INTO that state (the C's per-state cellList). We replicate
// that state machine, so the generation rate and the state-by-state reveal match
// the original at the stock --delay.
//
// Rendering: each cell is a fixed shape, so we rasterise it once into a pixel
// "stamp" and blit changed cells into an ImageData buffer (one putImageData per
// painted tick). Stamps partition the plane exactly -- a half-open Voronoi cell
// for hexagons, a half-open point-in-triangle test for triangles -- so the
// tiling has no gaps or anti-aliased seams. This is a platform-side rendering of
// the C's XFillPolygon/XFillRectangles cells; the CA itself is a direct port.

import { makeColorRampRGB } from './colormap.js';

export const title = 'demon';

export const info = {
  author: 'David Bagley',
  description: 'A cellular automaton that starts with a random field, and organizes it into stripes and spirals.\n\nhttps://en.wikipedia.org/wiki/Maxwell%27s_demon',
  year: 1999,
};

export function start(canvas) {
    const ctx = canvas.getContext('2d');

    // Resources, mirroring hacks/config/demon.xml 1:1 (delay/count/cycles/
    // ncolors/size). `neighbors` is the CLI-only -neighbors option (not in the
    // .xml GUI); 0 = pick a random grid each reseed, exactly like the C default.
    const config = {
      delay: 50000,     // microseconds per tick (--delay). A tick = compute one
                        //   generation OR paint one state's changed cells.
      count: 0,         // States (--count): 0/1 = auto per grid; >=2 = fixed count.
      cycles: 1000,     // generations before a full re-init (--cycles / "Timeout").
      ncolors: 64,      // size of the uniform colormap (--ncolors).
      size: -30,        // cell size px (--size): <0 random magnitude, 0 auto, >0 fixed.
      neighbors: 0,     // -neighbors: 0 = random of {3,4,6,8,9,12}; else that grid.
    };

    // Host config box. Defaults/ranges/labels track demon.xml; there is no Grid
    // selector because the .xml exposes none (the grid randomises per the C).
    const params = [
      { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 50000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
      { key: 'count', label: 'States', type: 'range', min: 0, max: 20, step: 1, default: 0, lowLabel: '0', highLabel: '20', live: false },
      { key: 'cycles', label: 'Timeout', type: 'range', min: 0, max: 800000, step: 1000, default: 1000, lowLabel: 'small', highLabel: 'large', live: true },
      { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
      { key: 'size', label: 'Cell size', type: 'range', min: -40, max: 40, step: 1, default: -30, live: false },
    ];

    let hex, tri, cols, rows;
    let neighbors, nk;                   // chosen grid + its plots[] index
    let cellPx;                          // square grid: device px per cell
    let r, colStep, rowStep, halfCol;    // hex / triangle grid geometry (integers)
    let triX0, triY0, triX1, triY1;      // triangle stamps (left-pointing / right-pointing)
    let borderPx;                        // black gutter between cells (device px)
    let stampX, stampY;                  // pixel offsets covering one cell (hex / square)
    let cells, newCells;                 // state per cell, in [0, states)
    let changed, changedCount;           // indices of cells that changed this generation
    let evenDx, evenDy, oddDx, oddDy;    // neighbour offsets (by cell variant)
    let imageData, pixels, cw, ch, dpr;  // canvas-sized RGBA buffer
    let baseColors, colors, ncolors, states;
    let generation, state;               // generation count + per-generation draw phase

    const BLACK = 0xFF000000;            // opaque black, little-endian 0xAABBGGRR

    // NRAND(n) === random() % n (a uniform int in [0, n)).
    function nrand(n) {
      return n <= 0 ? 0 : Math.floor(Math.random() * n);
    }

    // Neighbour offset tables, transcribed from demon.c's draw_demon. Each entry
    // is a (dx, dy) in cell coordinates; the rule reads them off the OLD grid.
    // For hexagons and triangles the set depends on cell parity (the C's per-cell
    // branches), so even/odd variants differ; squares are parity-independent.
    function buildNeighbors() {
      if (neighbors === 6) {
        // Offset-coordinate hexagons (even rows shifted). NE,E,SE,SW,W,NW.
        evenDx = [1, 1, 1, 0, -1, 0];   evenDy = [-1, 0, 1, 1, 0, -1];
        oddDx = [0, 1, 0, -1, -1, -1];  oddDy = [-1, 0, 1, 1, 0, -1];
      } else if (neighbors === 4) {
        evenDx = oddDx = [0, 1, 0, -1];            // N,E,S,W
        evenDy = oddDy = [-1, 0, 1, 0];
      } else if (neighbors === 8) {
        evenDx = oddDx = [0, 1, 0, -1, 1, 1, -1, -1];   // N,E,S,W,NE,SE,SW,NW
        evenDy = oddDy = [-1, 0, 1, 0, -1, 1, 1, -1];
      } else {
        // Triangles (3, 9, 12). orient = (x+y)&1: even = left-pointing (uses E),
        // odd = right-pointing (uses W). Base ring is {E-or-W, N, S}.
        const eX = [1, 0, 0],  eY = [0, -1, 1];   // left  : E, N, S
        const oX = [-1, 0, 0], oY = [0, -1, 1];   // right : W, N, S
        if (neighbors >= 9) {
          // Second ring shared by both orientations: NN, SS, NW, NE, SW, SE.
          const cX = [0, 0, -1, 1, -1, 1];
          const cY = [-2, 2, -1, -1, 1, 1];
          eX.push(...cX); eY.push(...cY);
          oX.push(...cX); oY.push(...cY);
        }
        if (neighbors === 12) {
          eX.push(1, 1, -1);   eY.push(-2, 2, 0);   // left  : NNE, SSE, WW
          oX.push(-1, -1, 1);  oY.push(-2, 2, 0);   // right : NNW, SSW, EE
        }
        evenDx = eX; evenDy = eY; oddDx = oX; oddDy = oY;
      }
    }

    // Rasterise a triangle (3 vertices, device-px offsets) to pixel offsets.
    // inset > 0 erodes inward by that many px (a black gutter); inset 0 uses a
    // half-open rule -- keep pixels exactly on a "claimed" edge, drop the others
    // -- so the two orientations partition their shared edges with no seam.
    function rasterTriangle(vx, vy, claim, inset) {
      const sx = [];
      const sy = [];
      const minX = Math.min(vx[0], vx[1], vx[2]);
      const maxX = Math.max(vx[0], vx[1], vx[2]);
      const minY = Math.min(vy[0], vy[1], vy[2]);
      const maxY = Math.max(vy[0], vy[1], vy[2]);
      const area = (vx[1] - vx[0]) * (vy[2] - vy[0]) - (vy[1] - vy[0]) * (vx[2] - vx[0]);
      const sign = area >= 0 ? 1 : -1;
      const len = [];
      for (let k = 0; k < 3; k++) {
        const b = (k + 1) % 3;
        len.push(Math.hypot(vx[b] - vx[k], vy[b] - vy[k]));
      }
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          let inside = true;
          for (let k = 0; k < 3; k++) {
            const b = (k + 1) % 3;
            const s = sign * ((vx[b] - vx[k]) * (py - vy[k]) - (vy[b] - vy[k]) * (px - vx[k]));
            if (inset > 0) {
              if (s < inset * len[k]) { inside = false; break; }
            } else if (s < 0 || (s === 0 && !claim[k])) {
              inside = false;
              break;
            }
          }
          if (inside) { sx.push(px); sy.push(py); }
        }
      }
      return { sx, sy };
    }

    // Build the pixel offsets that make up one cell.
    function buildStamp() {
      if (tri) {
        // Two interlocking orientations. Vertices relative to the cell origin
        // (the left-pointing apex / the top of the right-pointing vertical edge).
        // Edges, in vertex order, are [top-slant, *, bottom-slant]; claim the
        // top slant (and the left vertical) so each shared edge lands once.
        const inset = borderPx / 2;
        let t = rasterTriangle([0, colStep, colStep], [0, -rowStep, rowStep], [true, false, false], inset);
        triX0 = Int16Array.from(t.sx); triY0 = Int16Array.from(t.sy);   // left-pointing
        t = rasterTriangle([0, colStep, 0], [-rowStep, 0, rowStep], [true, false, true], inset);
        triX1 = Int16Array.from(t.sx); triY1 = Int16Array.from(t.sy);   // right-pointing
        return;
      }

      const sx = [];
      const sy = [];
      if (hex) {
        // Half-open Voronoi cell of a hex-lattice point: a pixel belongs here
        // if this centre is nearest among the 6 neighbours, claiming ties on
        // three edges (E/NE/NW) and ceding them on the opposite three, so each
        // shared boundary pixel lands in exactly one hexagon.
        const nbx = [colStep, -colStep, halfCol, -halfCol, halfCol, -halfCol];
        const nby = [0, 0, -rowStep, -rowStep, rowStep, rowStep];
        const claimTie = [true, false, true, true, false, false]; // E,W,NE,NW,SE,SW
        for (let dy = -r - 1; dy <= r + 1; dy++) {
          for (let dx = -halfCol - 1; dx <= halfCol + 1; dx++) {
            const d0 = dx * dx + dy * dy;
            let mine = true;
            for (let i = 0; i < 6; i++) {
              const ex = dx - nbx[i], ey = dy - nby[i];
              const di = ex * ex + ey * ey;
              if (claimTie[i] ? d0 > di : d0 >= di) { mine = false; break; }
              // erode away from the edges to leave a black gutter
              if (borderPx > 0 && di - d0 < colStep * borderPx) { mine = false; break; }
            }
            if (mine) { sx.push(dx); sy.push(dy); }
          }
        }
      } else {
        const size = cellPx - borderPx;
        for (let dy = 0; dy < size; dy++) {
          for (let dx = 0; dx < size; dx++) { sx.push(dx); sy.push(dy); }
        }
      }

      stampX = Int16Array.from(sx);
      stampY = Int16Array.from(sy);
    }

    // Stamp cell (x, y) into the pixel buffer in the given packed colour.
    function drawCell(x, y, color) {
      let ox, oy, sx, sy;
      if (tri) {
        ox = x * colStep;
        oy = (y + 1) * rowStep;
        if ((x + y) & 1) { sx = triX1; sy = triY1; } else { sx = triX0; sy = triY0; }
      } else if (hex) {
        ox = x * colStep + ((y & 1) ? 0 : halfCol);
        oy = y * rowStep + r;
        sx = stampX; sy = stampY;
      } else {
        ox = x * cellPx;
        oy = y * cellPx;
        sx = stampX; sy = stampY;
      }
      for (let p = 0; p < sx.length; p++) {
        const px = ox + sx[p];
        const py = oy + sy[p];
        if (px >= 0 && px < cw && py >= 0 && py < ch) pixels[py * cw + px] = color;
      }
    }

    // make_uniform_colormap (utils/colors.c, via UNIFORM_COLORS): a hue ramp
    // 0->359 at one random saturation & value, each in 66%-100%, with `ncolors`
    // entries. Built ONCE per mount/resize/config-change -- the C's framework
    // builds it at startup and demon never rebuilds it, so colours stay fixed
    // across reseeds. Packed into the little-endian 0xAABBGGRR the blit expects.
    function setupColormap() {
      ncolors = config.ncolors <= 0 ? 64 : Math.min(255, Math.round(config.ncolors));
      const S = (Math.floor(Math.random() * 34) + 66) / 100;
      const V = (Math.floor(Math.random() * 34) + 66) / 100;
      const ramp = makeColorRampRGB(0, S, V, 359, S, V, ncolors, false);
      baseColors = new Uint32Array(ncolors);
      for (let i = 0; i < ncolors; i++) {
        const [rr, gg, bb] = ramp[i];
        baseColors[i] = ((0xff << 24) | (bb << 16) | (gg << 8) | rr) >>> 0;
      }
    }

    // Cell size in LOGICAL px from the --size resource (demon.c init_demon, which
    // uses the same ys formula for every grid): <0 random up to |size|, 0 auto,
    // >0 fixed; all capped to min(W,H)/MINGRIDSIZE. Randomised per reseed when <0.
    function computeSize(W, H) {
      const MINSIZE = 4, MINGRIDSIZE = 5;
      let size = Math.round(config.size);
      if (W < 100 || H < 100) size = Math.min(W, H);       // tiny window
      const cap = Math.max(MINSIZE, Math.floor(Math.min(W, H) / MINGRIDSIZE));
      if (size < -MINSIZE) return nrand(Math.min(-size, cap) - MINSIZE + 1) + MINSIZE;
      if (size < MINSIZE)  return size === 0 ? cap : MINSIZE;
      return Math.min(size, cap);
    }

    // init_demon (minus the one-time colormap): pick a random grid + cell size +
    // state count, rebuild geometry, clear to black, and lay down fresh soup.
    function regen() {
      const plots0 = [3, 4, 6, 8, 9, 12];      // demon.c plots[0]: neighborhoods
      const plots1 = [12, 16, 18, 20, 22, 24]; // demon.c plots[1]: auto state counts

      nk = plots0.indexOf(config.neighbors);
      if (nk < 0) nk = nrand(plots0.length);   // neighbors 0 -> NRAND(NEIGHBORKINDS)
      neighbors = plots0[nk];
      hex = neighbors === 6;
      tri = neighbors === 3 || neighbors === 9 || neighbors === 12;

      // states from --count (demon.c init_demon). count via the slider is 0..20,
      // so the random-negative branch is unreachable from the GUI but kept exact.
      const MINSTATES = 2;
      const count = Math.round(config.count);
      if (count < -MINSTATES) states = nrand(-count - MINSTATES + 1) + MINSTATES;
      else if (count < MINSTATES) states = plots1[nk];
      else states = count;

      // Per-state colours: state 0 black, state s>=1 sampled from baseColors at
      // ((s-1)*ncolors/(states-1)) % ncolors (demon.c drawcell / draw_state).
      colors = new Uint32Array(states);
      colors[0] = BLACK;
      for (let s = 1; s < states; s++) {
        colors[s] = baseColors[Math.floor((s - 1) * ncolors / (states - 1)) % ncolors];
      }

      // Cell size (random when --size < 0), in logical px then scaled to device.
      const lw = Math.max(1, Math.round(cw / dpr));
      const lh = Math.max(1, Math.round(ch / dpr));
      const cs = Math.max(1, Math.round(computeSize(lw, lh) * dpr));
      borderPx = Math.round(dpr);              // ~1px black gutter (demon.c xs-1)

      if (hex) {
        // Pointy-top hexagons; integer spacing so the lattice tiles exactly.
        r = Math.round(cs / 2);
        colStep = Math.round(Math.sqrt(3) * r);
        rowStep = Math.round(1.5 * r);
        halfCol = Math.round(colStep / 2);
        cols = Math.ceil(cw / colStep) + 1;
        rows = Math.ceil(ch / rowStep) + 1;
      } else if (tri) {
        // Equilateral triangles alternating left/right. Even cols/rows so the
        // toroidal wrap keeps the orientation consistent across the seam.
        rowStep = Math.round(cs / 2);
        colStep = Math.round(rowStep * Math.sqrt(3));
        cols = Math.ceil(cw / colStep) + 2;
        rows = Math.ceil(ch / rowStep) + 2;
        if (cols & 1) cols++;
        if (rows & 1) rows++;
      } else {
        cellPx = cs;
        cols = Math.max(2, Math.floor(cw / cellPx));
        rows = Math.max(2, Math.floor(ch / cellPx));
      }

      cells = new Uint8Array(cols * rows);
      newCells = new Uint8Array(cols * rows);
      changed = new Int32Array(cols * rows);
      buildNeighbors();
      buildStamp();

      // RandomSoup + MI_CLEARWINDOW: clear to black, seed every cell, and queue
      // the whole grid as "changed" so the soup reveals state-by-state over the
      // next `states` ticks (just as the C draws cellList[0..states-1]).
      pixels.fill(BLACK);
      changedCount = cells.length;
      for (let i = 0; i < cells.length; i++) {
        cells[i] = nrand(states);
        changed[i] = i;
      }
      generation = 0;
      state = 0;
      ctx.putImageData(imageData, 0, 0);       // show the black clear immediately
    }

    // Compute the next generation: for each cell, advance to (state+1)%states if
    // any neighbour already holds that next state (reads OLD grid, writes new),
    // then commit and record the changed cells. After `cycles` generations the
    // C re-inits (new random grid/size/states) -- regen() does the same.
    function computeGeneration() {
      for (let y = 0; y < rows; y++) {
        const rowBase = y * cols;
        const rowOdd = y & 1;
        for (let x = 0; x < cols; x++) {
          // Triangles flip orientation per cell ((x+y) parity); hex/square key
          // their offsets off row parity only.
          const useOdd = tri ? ((x + y) & 1) : rowOdd;
          const dx = useOdd ? oddDx : evenDx;
          const dy = useOdd ? oddDy : evenDy;

          const idx = rowBase + x;
          const s = cells[idx];
          const target = s + 1 === states ? 0 : s + 1;

          let next = s;
          for (let n = 0; n < dx.length; n++) {
            const nx = (x + dx[n] + cols) % cols;
            const ny = (y + dy[n] + rows) % rows;
            if (cells[ny * cols + nx] === target) { next = target; break; }
          }
          newCells[idx] = next;
        }
      }

      changedCount = 0;
      for (let i = 0; i < cells.length; i++) {
        if (newCells[i] !== cells[i]) {
          cells[i] = newCells[i];
          changed[changedCount++] = i;
        }
      }

      generation++;
      if (generation > config.cycles) { regen(); return; }
      state = 0;
    }

    // Paint the cells that changed INTO state `s` (the C's draw_state on
    // cellList[s]). State 0 paints black, so cells cycling back to 0 are erased.
    function drawState(s) {
      const c = colors[s];
      for (let k = 0; k < changedCount; k++) {
        const idx = changed[k];
        if (cells[idx] === s) drawCell(idx % cols, (idx / cols) | 0, c);
      }
    }

    // One framework tick (draw_demon): either compute the next generation (no
    // paint) or paint one state's changed cells. Returns whether it painted.
    function tick() {
      if (state >= states) { computeGeneration(); return false; }
      drawState(state);
      state++;
      return true;
    }

    function resize() {
      dpr = window.devicePixelRatio || 1;
      canvas.width = cw = Math.round(window.innerWidth * dpr);
      canvas.height = ch = Math.round(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      imageData = ctx.createImageData(cw, ch);
      pixels = new Uint32Array(imageData.data.buffer);
      setupColormap();
      regen();
    }

    // Drive off requestAnimationFrame at the stock pace: one tick() per
    // config.delay (µs), banking leftover time so the speed is the same at any
    // refresh rate. Cap catch-up so a backgrounded tab doesn't fire a burst, and
    // blit once per frame only if a tick painted (compute ticks paint nothing).
    //
    // OVERHEAD: the stock --delay is only a sleep floor; the live binary's real
    // rate is lower (delay + framework overhead -- see the framerate-calibration
    // note). The live demon measures 16.7 fps, but the port at the stock 50000 us
    // ran 20 ticks/sec (1.2x fast). 50000 + 9880 = 59880 us -> 16.7 ticks/sec,
    // matching the live binary. A calibration, not a tuning knob (the delay
    // slider still maps 1:1 to the xml resource).
    const OVERHEAD = 9880;
    const MAX_CATCHUP_STEPS = 4;
    let lastTime = 0;
    let lag = 0;
    let rafId = 0;

    function frame(now) {
      if (lastTime === 0) lastTime = now;
      lag += now - lastTime;
      lastTime = now;

      const delayMs = (config.delay + OVERHEAD) / 1000;
      lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

      let painted = false;
      let steps = 0;
      while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
        if (tick()) painted = true;
        lag -= delayMs;
        steps++;
      }

      if (painted) ctx.putImageData(imageData, 0, 0);
      rafId = requestAnimationFrame(frame);
    }

    // Rebuild after a non-live config change (count/ncolors/size): fresh colormap
    // + fresh grid/soup, keeping the current canvas size.
    function reinit() {
      setupColormap();
      regen();
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
      reinit,
      config,
      params,
    };
}
