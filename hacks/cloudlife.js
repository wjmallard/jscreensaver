// cloudlife.js — cloudlife packaged as a mountable module.
// start(canvas) runs the hack on the given canvas and returns
// { stop, pause, resume, reinit, config, params } to tear it down or retune it,
// so a host page can cycle hacks on one shared canvas.
//
// Port of xscreensaver's cloudlife.c (Don Marti, 2003).
// https://www.jwz.org/xscreensaver/
//
// Conway's Life (B3/S23) with one rule change: cells carry an AGE, and once a
// cell is older than maxAge it counts as 3 when populating the next generation
// (cell_value) — so long-lived formations destabilise and "explode" instead of
// sitting there. Rendering is the signature: exactly ONE random sub-pixel of
// each cell's size x size block is painted per tick (live cells in the current
// foreground colour, dead cells in black) into a persistent buffer, so cells
// fade in and out like clouds and movers leave comet trails. The foreground is
// a SINGLE colour walked backwards through a make_smooth_colormap every couple
// of ticks (not a per-cell age colour). See cloudlife.md.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'cloudlife';

export const info = {
  author: 'Don Marti',
  description: "Cloud-like formations based on a variant of Conway's Life.\n\nThe difference is that cells have a maximum age, after which they count as 3 for populating the next generation. This makes long-lived formations explode instead of just sitting there.\n\nhttps://en.wikipedia.org/wiki/Conway%27s_Game_of_Life",
  year: 2003,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/cloudlife.xml 1:1, so the config box maps
  // onto the original's resources: delay (--cycle-delay, µs/tick, "Frame rate",
  // inverted), maxAge (--max-age), density (--initial-density, a percent),
  // cellSize (--cell-size, a power-of-two EXPONENT). cloudlife.xml exposes nothing
  // else animatable (showfps is a framework control). ncolors and cycleColors are
  // command-line-only in the C and are NOT exposed here (see consts below).
  const config = {
    delay: 25000,    // usleep interval, microseconds (xml default 25000)
    maxAge: 64,      // age past which a cell counts as 3 neighbours (xml default 64)
    density: 30,     // % of cells alive when (re)seeding (xml default 30)
    cellSize: 3,     // exponent: a cell is 1 << cellSize device px (xml default 3)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 25000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'maxAge', label: 'Max age', type: 'range', min: 2, max: 255, step: 1, default: 64, lowLabel: 'young', highLabel: 'old', live: true },
    { key: 'density', label: 'Initial density', type: 'range', min: 1, max: 99, step: 1, default: 30, unit: '%', lowLabel: 'low', highLabel: 'high', live: false },
    { key: 'cellSize', label: 'Cell size', type: 'range', min: 1, max: 20, step: 1, default: 3, lowLabel: 'small', highLabel: 'large', live: false },
  ];

  // Fixed C defaults NOT exposed by cloudlife.xml (command-line only). The C only
  // builds/cycles colours when cycleColors is non-zero; its stock value is 2.
  const NCOLORS = 64;        // cloudlife_defaults *ncolors
  const CYCLE_COLORS = 2;    // cloudlife_defaults *cycleColors (ticks per colour step)

  const BLACK = 0xFF000000;  // opaque black, little-endian packed 0xAABBGGRR

  let cellPx;                 // cell size in device px = 1 << cellSize (C's `size`)
  let width, height;          // grid size in cells, including a 1-cell border ring
  let cells, newCells;        // age per cell (Uint8, 0 = dead) — wraps at 256 like the C
  let imageData, pixels;      // canvas-sized RGBA buffer, blitted once per tick
  let colors;                 // Uint32 smooth colormap (built once)
  let colorIndex, colorTimer, fgUint;
  let cycles;

  // make_smooth_colormap (utils/colors.c via colormap.js), built ONCE exactly as
  // cloudlife_init does: 2-5 random HSV anchors interpolated into a smooth loop,
  // often muted/pastel — NOT a vivid rainbow. The C never rebuilds this map; it
  // only cycles WHICH single entry is the foreground colour.
  function buildColors() {
    const map = makeSmoothColormapRGB(NCOLORS);
    colors = new Uint32Array(map.length);
    for (let i = 0; i < map.length; i++) {
      const [r, g, b] = map[i];
      colors[i] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
    fgUint = colors[0];
  }

  // initialDensity resource -> 0..256 threshold, exactly as cloudlife_init:
  //   density = (initialDensity % 100 * 256) / 100        (C integer arithmetic)
  function densityThreshold() {
    return Math.trunc((config.density % 100) * 256 / 100);
  }

  // random_cell(p): 1 with probability p/256, else 0 (C's `random() & 0xff < p`).
  function randomCell(p) {
    return Math.floor(Math.random() * 256) < p ? 1 : 0;
  }

  function populateField() {
    const p = densityThreshold();
    for (let i = 0; i < cells.length; i++) cells[i] = randomCell(p);
  }

  // Seed (p = threshold) or clear (p = 0) the off-screen border ring (populate_edges).
  function populateEdges(p) {
    for (let x = 0; x < width; x++) {
      cells[x] = randomCell(p);
      cells[(height - 1) * width + x] = randomCell(p);
    }
    for (let y = 0; y < height; y++) {
      cells[y * width] = randomCell(p);
      cells[y * width + width - 1] = randomCell(p);
    }
  }

  // is_alive: sum the eight neighbours via cell_value (dead=0, older-than-maxAge=3,
  // else 1) then apply B3/S23 to the centre's age (survivors age by one).
  function nextAge(x, y) {
    let count = 0;
    for (let j = y - 1; j <= y + 1; j++) {
      const row = j * width;
      for (let i = x - 1; i <= x + 1; i++) {
        if (i === x && j === y) continue;
        const c = cells[row + i];
        count += c === 0 ? 0 : (c > config.maxAge ? 3 : 1);
      }
    }
    const age = cells[y * width + x];
    if (age) {
      return (count === 2 || count === 3) ? age + 1 : 0;   // survive (age++) or die
    }
    return count === 3 ? 1 : 0;                             // birth on exactly 3
  }

  // Advance one generation into newCells, copy back, and return the age-sum
  // (do_tick's `count`, used to decide when to reseed). The sum reads back the
  // uint8-stored value so it matches the C's `count += (unsigned char)assignment`.
  function tick() {
    let sum = 0;
    for (let y = 1; y < height - 1; y++) {
      const rowBase = y * width;
      for (let x = 1; x < width - 1; x++) {
        const idx = rowBase + x;
        newCells[idx] = nextAge(x, y);
        sum += newCells[idx];
      }
    }
    cells.set(newCells);
    return sum;
  }

  // draw_field: for every cell paint ONE random sub-pixel of its size x size block
  // (live -> current fg colour, dead -> black) straight into the persistent pixel
  // buffer, then blit. Old dots persist, so the field fades like clouds and movers
  // comet-trail. (Per-pixel fillRect is hopelessly slow at this volume; the single
  // putImageData mirrors the C's batched XDrawPoints.)
  function drawField() {
    const cw = canvas.width;
    const size = cellPx;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const color = cells[y * width + x] ? fgUint : BLACK;
        // px = x*size - rx - 1, py = y*size - ry - 1, with rx,ry in [0,size).
        const rx = Math.floor(Math.random() * size);
        const ry = Math.floor(Math.random() * size);
        pixels[(y * size - ry - 1) * cw + (x * size - rx - 1)] = color;
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }

  function init() {
    // cellSize is the C's power-of-two EXPONENT (the "cellSize" resource); the
    // on-screen cell is 1 << cellSize pixels, measured in DEVICE px — the canvas
    // backing store is the analogue of the X11 screen, so there is no dpr fudge
    // (C: `size = 1 << f->cell_size`; grid = screen / size + 2).
    const size = 1 << Math.max(1, Math.round(config.cellSize));
    cellPx = size;
    width = Math.floor(canvas.width / size) + 2;    // +2 for the off-screen border ring
    height = Math.floor(canvas.height / size) + 2;

    cells = new Uint8Array(width * height);
    newCells = new Uint8Array(width * height);
    populateField();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    imageData = ctx.createImageData(canvas.width, canvas.height);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);
    init();
  }

  // One tick (cloudlife_draw): cycle the foreground colour, paint the current
  // field, advance a generation (reseeding if it nearly died), and every maxAge/2
  // ticks stir the border for one generation then clear it.
  function step() {
    if (CYCLE_COLORS) {
      if (colorTimer === 0) {
        colorTimer = CYCLE_COLORS;
        // Walk the single foreground colour BACKWARDS through the map, wrapping
        // 0 -> last (C: if(colorindex==0) colorindex=ncolors; colorindex--).
        colorIndex = (colorIndex + colors.length - 1) % colors.length;
        fgUint = colors[colorIndex];
      }
      colorTimer--;
    }

    drawField();

    // Reseed the whole field if the population (age-sum) has nearly died out.
    // (C: do_tick() < (height + width) / 4, integer division.)
    if (tick() < Math.floor((width + height) / 4)) {
      populateField();
    }

    // Periodic edge stir: inject border activity for one generation, then clear
    // the border again. (C: cycles % (max_age / 2) == 0.)
    if (cycles % Math.floor(config.maxAge / 2) === 0) {
      populateEdges(densityThreshold());
      tick();
      populateEdges(0);
    }

    cycles++;
  }

  // Drive off requestAnimationFrame but keep the original pace: run one step()
  // per config.delay (µs -> ms), banking leftover time so the rate is the same at
  // any refresh rate. Cap catch-up so a backgrounded tab (rAF paused) doesn't fire
  // a burst on refocus, and so delay=0 doesn't spin forever.
  //
  // OVERHEAD: xscreensaver's real per-frame rate is below its nominal delay (the
  // delay is a floor plus framework overhead — see the framerate-calibration note;
  // starfish needed OVERHEAD=8000). Measured against the live -fps overlay the
  // binary runs at 30.3 fps (Load 24%, i.e. delay-bound, a portable target), while
  // the port at the stock 25000 µs ran 40 gen/sec (1.3x fast). 25000 + 8000 =
  // 33000 µs -> 30.3 gen/sec, matching the live binary. NOT tuning — a calibration.
  const OVERHEAD = 8000;
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

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Build the colormap once (C's cloudlife_init) and zero the cycle/tick counters;
  // resize() only (re)allocates the grid + buffer, leaving these alone — the C
  // keeps cycles/colorindex/colors across window-size changes.
  buildColors();
  cycles = 0;
  colorIndex = 0;
  colorTimer = 0;

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
    reinit: resize,   // re-alloc grid + buffer with the current config
    config,
    params,
  };
}
