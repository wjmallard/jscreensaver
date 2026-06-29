// imsmap.js -- imsmap packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's imsmap.c (Juergen Nickelsen & Jamie Zawinski, 1992;
// derived from code by Markus Schirmer, TU Berlin).
// https://www.jwz.org/xscreensaver/
//
// Recursive cloud-like fractal patterns by midpoint subdivision (the plasma /
// diamond-square fractal). This is a FAITHFUL transcription of imsmap.c's
// draw model (rebuilt 2026-06-27 after a fidelity audit; the previous port
// generated the field instantly and then CYCLED the colormap over it -- both
// were deviations the C does not do):
//
//   * The generation IS the animation. Starting from the screen corners, the
//     field is subdivided level by level; each level sets the edge/centre
//     midpoints of every cell to the average of its corners plus a random
//     offset that halves each level (set()/HEIGHT_TO_PIXEL). Each set point is
//     painted as a block whose size shrinks per level, so the picture FADES IN
//     from coarse blocks to full resolution. A chunk of columns is painted per
//     frame (col_chunk = iteration*2+1).
//   * When the finest level is reached the cloud sits PERFECTLY STILL for
//     `delay` SECONDS (imsmap_draw's this_delay = delay*1e6), then init_map
//     regenerates a fresh field + a fresh colormap. There is NO colour cycling.
//
// Colour: the C's make_smooth_colormap (a random 2-5 anchor HSV loop, often
// muted), ported faithfully in colormap.js, rebuilt on every regeneration. The
// xml exposes a `mode` resource but imsmap.c never reads it (the colormap is
// always make_smooth_colormap), so it is a dead control and not surfaced here.
//
// Rendering: blocks are painted into a persistent Uint32 display buffer (the C
// draws straight to the window and only repaints changed blocks); one
// putImageData per frame. Field math runs at device resolution like the C.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'imsmap';

export const info = {
  author: 'Juergen Nickelsen and Jamie Zawinski',
  description: 'Recursive cloud-like fractal patterns.',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror the REAL imsmap.xml resources: delay2 (the per-chunk
  // paint interval, us), delay (the hold in SECONDS once a cloud is complete),
  // iterations (subdivision depth / detail), ncolors. The stock `mode` resource
  // is omitted because imsmap.c declares but never reads it (dead control), and
  // there is deliberately no colour-cycle control because the C does not cycle.
  const config = {
    delay2: 20000,     // microseconds between paint chunks (--delay2)
    delay: 5,          // seconds a finished cloud holds before regenerating (--delay)
    iterations: 7,     // subdivision levels / detail, 1..7 (--iterations)
    ncolors: 50,       // colour-map size (--ncolors)
  };

  const params = [
    { key: 'delay2', label: 'Paint speed', type: 'range', min: 2000, max: 80000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'delay', label: 'Hold', type: 'range', min: 1, max: 30, step: 1, default: 5, unit: ' s', lowLabel: 'brief', highLabel: 'long', live: true },
    { key: 'iterations', label: 'Detail', type: 'range', min: 1, max: 7, step: 1, default: 7, lowLabel: 'coarse', highLabel: 'fine', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 3, max: 255, step: 1, default: 50, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  // The C's NSTEPS: the coarsest subdivision step is 2^NSTEPS pixels, and the
  // per-level random amplitude is 1 << (NSTEPS - level). 7 -> step 128.
  const NSTEPS = 7;
  const COUNT = 1 << NSTEPS;   // 128

  let W, H, S;                 // canvas size (device px) and devicePixelRatio
  let imageData, displayBuf;   // persistent display buffer (Uint32 view) + ImageData
  let cell;                    // height/colour-index field (Uint16), xmax*ymax
  let palette;                 // ncolors packed-ABGR colour-map values
  let ncolors;                 // palette length actually used (>= 1)
  let extraKrinkly;            // C's extra_krinkly_p: wrap (not saturate) heights
  let flipX, flipXy;           // C's flip_x / flip_xy: mirror / transpose the cloud
  let xmax, ymax;              // field dims (swapped under flip_xy)

  // Subdivision state machine (the C's imsmap_draw persistent state).
  let cx, xstep, ystep, xnext, ynext, iteration, iterationsCfg, complete;

  // Pack r,g,b (0-255) as 0xFFBBGGRR for ImageData's little-endian layout.
  function packRGB(r, g, b) {
    return (0xff << 24 | b << 16 | g << 8 | r) >>> 0;
  }

  // Build the colour map for one cloud: the faithful make_smooth_colormap
  // (colormap.js) -- a random 2-5 anchor HSV loop, frequently muted/pastel.
  // The C calls make_smooth_colormap in init_map (per regeneration), so this is
  // rebuilt on every regeneration too.
  function buildPalette() {
    ncolors = Math.max(1, Math.round(config.ncolors));
    palette = new Uint32Array(ncolors);
    const map = makeSmoothColormapRGB(ncolors);
    for (let i = 0; i < ncolors; i++) {
      const [r, g, b] = map[i];
      palette[i] = packRGB(r, g, b);
    }
  }

  // Random integer in [0, n), matching the C's (random() % n).
  function nrand(n) {
    return Math.floor(Math.random() * n);
  }

  // The C's HEIGHT_TO_PIXEL macro. Common path saturates (h<0 -> 0; h>=ncolors
  // -> ncolors-1). On the ~1-in-5 regenerations where extraKrinkly is set,
  // out-of-range heights WRAP through the colormap (the "extra krinkly" banding).
  function heightToPixel(h) {
    if (h < 0) return extraKrinkly ? ncolors - 1 - ((-h) % ncolors) : 0;
    if (h >= ncolors) return extraKrinkly ? h % ncolors : ncolors - 1;
    return h;
  }

  // The C's wrap of a neighbour index: <0 -> max-1, >=max -> 0 (toroidal-ish).
  const wrap = (v, max) => (v < 0 ? max - 1 : (v >= max ? 0 : v));

  // The C's set(): displace the average by a per-level random amount, clamp to a
  // palette index, store it in the field, and return the packed colour.
  function setCell(x, y, size, h) {
    const rang = 1 << (NSTEPS - size);
    h = h + nrand(rang) - (rang >> 1);
    h = heightToPixel(h);
    cell[x + y * xmax] = h;
    return palette[h];
  }

  // The C's draw(): map field coords to display coords via flip_x / flip_xy,
  // then paint a gridSize x gridSize block of `color` into the display buffer.
  function draw(x, y, color, gridSize) {
    if (flipX) x = xmax - x;
    if (flipXy) { const t = x; x = y; y = t; }
    if (gridSize < 1) return;             // degenerate final level: nothing to paint
    const xe = Math.min(W, x + gridSize);
    const ye = Math.min(H, y + gridSize);
    for (let yy = (y < 0 ? 0 : y); yy < ye; yy++) {
      const base = yy * W;
      for (let xx = (x < 0 ? 0 : x); xx < xe; xx++) displayBuf[base + xx] = color;
    }
  }

  // init_map: new colormap + flips + krinkly, clear the field, fill the display
  // with the background colour (the C fills the window with colors[1]), reset the
  // subdivision state to the coarsest step.
  function regenerate() {
    buildPalette();
    extraKrinkly = nrand(5) === 0;
    flipX = nrand(2) === 1;
    flipXy = nrand(2) === 1;
    if (flipXy) { xmax = H; ymax = W; } else { xmax = W; ymax = H; }
    iterationsCfg = Math.max(1, Math.min(7, Math.round(config.iterations)));
    cell.fill(0);
    displayBuf.fill(palette[1 % ncolors]);
    cx = 0; xstep = COUNT; ystep = COUNT; iteration = 0; complete = false;
  }

  // OVERHEAD: delay2 (the per-chunk paint interval) is a sleep floor; the live
  // binary's real build rate is lower (delay2 + framework overhead -- see the
  // framerate-calibration note). The live imsmap measures 30.6 fps during the
  // coarse->fine build, but the port at the stock 20000 us ran 50 chunks/sec
  // (1.63x fast). 20000 + 12680 = 32680 us -> 30.6 chunks/sec, matching the
  // live binary. Applied ONLY to the per-chunk build delay below; the `delay`-
  // second finished-cloud hold is left untouched. A calibration, not a tuning
  // knob (the delay2 slider still maps 1:1 to the xml resource).
  const OVERHEAD = 12680;

  // One imsmap_draw call: paint col_chunk columns of the current subdivision
  // level, advancing the state. Returns the milliseconds until the next call
  // (delay2 normally; the `delay`-second hold once the cloud is complete).
  function drawChunk() {
    if (complete) regenerate();   // the hold just ended -> grow a fresh cloud

    if (cx === 0) {
      xnext = xstep >> 1;
      ynext = ystep >> 1;
      if (xnext < 1 && ynext < 1) {   // can't subdivide further: cloud complete
        complete = true;
        return Math.max(1, config.delay) * 1000;
      }
    }

    const colChunk = iteration * 2 + 1;
    for (let i = 0; i < colChunk; i++) {
      const x = cx;
      const x1 = wrap(x + xnext, xmax);
      const x2 = wrap(x + xstep, xmax);
      for (let y = 0; y < ymax; y += ystep) {
        const y1 = wrap(y + ynext, ymax);
        const y2 = wrap(y + ystep, ymax);

        const cTL = cell[x + y * xmax];
        const cBL = cell[x + y2 * xmax];
        const cTR = cell[x2 + y * xmax];
        const cBR = cell[x2 + y2 * xmax];
        // Corner colours (cells store already-clamped indices, so direct lookup).
        const q0 = palette[cTL], q1 = palette[cBL], q2 = palette[cTR], q3 = palette[cBR];

        let pix = setCell(x, y1, iteration, (cTL + cBL + 1) >> 1);          // left edge
        if (pix !== q0 || pix !== q1 || pix !== q2 || pix !== q3) draw(x, y1, pix, ynext);

        pix = setCell(x1, y, iteration, (cTL + cTR + 1) >> 1);             // top edge
        if (pix !== q0 || pix !== q1 || pix !== q2 || pix !== q3) draw(x1, y, pix, ynext);

        pix = setCell(x1, y1, iteration, (cTL + cBL + cTR + cBR + 2) >> 2); // centre
        if (pix !== q0 || pix !== q1 || pix !== q2 || pix !== q3) draw(x1, y1, pix, ynext);
      }

      cx += xstep;
      if (cx >= xmax) break;
    }

    if (cx >= xmax) {
      cx = 0;
      xstep = xnext;
      ystep = ynext;
      iteration++;
      if (iteration > iterationsCfg) {   // reached the chosen detail: hold, then regen
        complete = true;
        return Math.max(1, config.delay) * 1000;
      }
    }

    return Math.max(1, config.delay2 + OVERHEAD) / 1000;   // ms until the next paint chunk
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    imageData = ctx.createImageData(W, H);
    displayBuf = new Uint32Array(imageData.data.buffer);
    cell = new Uint16Array(W * H);
    dueTime = 0;
    regenerate();
    ctx.putImageData(imageData, 0, 0);   // show the background fill immediately
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Variable-delay scheduler: each drawChunk() returns the ms until the next
  // one (short while painting, a long `delay`-second wait during the hold). We
  // advance a due-time cursor by that amount, banking leftover time so the pace
  // is refresh-rate independent; a guard caps catch-up after a backgrounded tab.
  let dueTime = 0;
  let rafId = 0;

  function frame(now) {
    if (dueTime === 0) dueTime = now;
    let painted = false;
    let guard = 0;
    while (now >= dueTime && guard < 64) {
      const nextMs = drawChunk();
      painted = true;
      dueTime += nextMs;
      guard++;
    }
    if (painted) ctx.putImageData(imageData, 0, 0);
    rafId = requestAnimationFrame(frame);
  }

  // Rebuild after a non-live config change (clears, regrows from a fresh field).
  function reinit() {
    init();
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
    resume() { if (!rafId) { dueTime = 0; rafId = requestAnimationFrame(frame); } },
    reinit,
    config,
    params,
  };
}
