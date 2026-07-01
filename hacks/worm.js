// worm.js — worm packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }; the
// host renders the config box from `config`/`params`. Loop/sizing/units stay
// inline per hack (see squiral.js for the shared skeleton).
//
// Port of xscreensaver's worm.c (Brad Taylor, Dave Lemke, Boris Putanec, and
// Henrik Theiling; 1991). Multicolored worms crawl around a toroidal screen:
// each worm is a circular buffer of its last N positions. Every step the head
// turns by +/-10 degrees, advances by one cell (wrapping at the edges), and the
// oldest cell is erased to black — so each worm stays exactly N segments long.
// The palette is xscreensaver's make_smooth_colormap (worm.c defines
// SMOOTH_COLORS) and its offset shifts by one each frame, so every worm's body
// reads as a moving smooth-colormap gradient. See [[squiral]] for the skeleton,
// [[binaryring]] for the moving colored-trail idea.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'worm';

export const info = {
  author: 'Brad Taylor, Dave Lemke, Boris Putanec, and Henrik Theiling',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nDraws multicolored worms that crawl around the screen.',
  year: 1991,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Configuration. Units and defaults match xscreensaver's
  // hacks/config/worm.xml so the tuning UI maps 1:1 to the original.
  const config = {
    delay: 17000,   // microseconds between steps (--delay)
    ncolors: 150,   // size of the hue cycle (--ncolors)
    count: -20,     // worms; negative N = random 1..|N|, positive = exactly N (--count)
    size: -3,       // cell/step size; negative N = random 1..|N|, positive = N (--size)
  };

  // Ranges/defaults/labels transcribed from hacks/config/worm.xml.
  // live: true  -> the loop reads config every step, so it applies instantly.
  // live: false -> the value sizes the worms/palette, so a change re-runs
  //                init() via reinit().
  // count/size keep the C's sign convention: a negative value means "pick a
  // random amount up to |value|" (re-rolled each reinit), positive is exact.
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 17000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 150, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'count', label: 'Count', type: 'range', min: -100, max: 100, step: 1, default: -20, lowLabel: 'random', highLabel: 'fixed', live: false },
    { key: 'size', label: 'Size', type: 'range', min: -20, max: 20, step: 1, default: -3, lowLabel: 'random', highLabel: 'fat', live: false },
  ];

  // Fidelity constants from worm.c.
  const SEGMENTS = 36;   // directions around the circle (10 degrees each)
  const MINWORMS = 1;    // floor on worm count
  const MINSIZE = 1;     // floor on cell size
  const CYCLES = 10;     // xlockmore *cycles default; scales worm length
  const MAXWORMS = 100;  // perf cap (xml high)

  // Heading -> unit step, precomputed once per mount (worm.c's sintab/costab).
  const costab = new Float32Array(SEGMENTS);
  const sintab = new Float32Array(SEGMENTS);
  for (let i = 0; i < SEGMENTS; i++) {
    costab[i] = Math.cos((i * 2 * Math.PI) / SEGMENTS);
    sintab[i] = Math.sin((i * 2 * Math.PI) / SEGMENTS);
  }

  let W, H, S;          // device-pixel size + devicePixelRatio
  let circsize;         // cell/step size in device px (integer >= 1)
  let wormlength;       // segments per worm (ring-buffer length)
  let nc;               // palette size actually used
  let colors;           // css color strings (smooth colormap), length nc
  let worms;            // array of worm objects
  let chromo;           // per-frame palette offset (worm.c's chromo)

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // Euclidean modulo so a worm that steps off the left/top edge wraps cleanly
  // (JS % takes the sign of the dividend).
  function wrap(coord, size) {
    return ((coord % size) + size) % size;
  }

  // worm.c's IRINT: round to nearest, ties away from zero.
  function irint(x) {
    return x > 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
  }

  // Resolve a signed count/size into a concrete value (worm.c's negative =
  // "random up to |value|" convention; floor = `min`).
  function resolveSigned(value, min) {
    if (value < -min) {
      return (Math.random() * (-value - min + 1) | 0) + min;
    }
    if (value < min) {
      return min;
    }
    return value;
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // worm.c defines SMOOTH_COLORS (line 54), so the xlockmore framework builds
    // the palette with make_smooth_colormap (utils/colors.c) — a random smooth
    // HSV loop, NOT a vivid full-saturation rainbow. Built once per init (the C
    // builds it once at startup); chromo cycles the offset each frame. ncolors
    // <= 2 hits the C's mono path (npixels <= 2 in xlockmore.c) -> white worms.
    nc = clamp(Math.round(config.ncolors), 1, 255);
    if (nc <= 2) {
      colors = ['#fff'];
    } else {
      colors = makeSmoothColormapRGB(nc).map(([r, g, b]) => `rgb(${r},${g},${b})`);
    }
    nc = colors.length;

    // Cell/step size in device px (scaled by dpr so worms look the same on retina).
    const baseSize = resolveSigned(Math.round(config.size), MINSIZE);
    circsize = Math.max(1, Math.round(baseSize * S));

    // Worm length is a segment count (worm.c: sqrt(w+h) * cycles / 8). Derive it
    // from LOGICAL size (device px / dpr) so the worm has the same apparent
    // length across pixel ratios.
    wormlength = Math.max(4, Math.floor((Math.sqrt((W + H) / S) * CYCLES) / 8));

    // Number of worms.
    const nw = clamp(resolveSigned(Math.round(config.count), MINWORMS), MINWORMS, MAXWORMS);

    chromo = (Math.random() * nc) | 0;

    worms = [];
    for (let i = 0; i < nw; i++) {
      // worm.c seeds every segment of every worm at screen center (xsize/2,
      // ysize/2), so all worms burst outward from one point over the first
      // ~wormlength steps. Faithful: stack the whole ring buffer at center.
      const sx = (W / 2) | 0;
      const sy = (H / 2) | 0;
      const cx = new Int32Array(wormlength);
      const cy = new Int32Array(wormlength);
      cx.fill(sx);
      cy.fill(sy);
      worms.push({
        index: i,
        cx,
        cy,
        dir: (Math.random() * SEGMENTS) | 0,
        tail: 0,
        x: sx,
        y: sy,
      });
    }
  }

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

  function step() {
    // Pass 1 (worm.c's worm_doit): advance the ring buffer and erase each tail.
    // All erases happen before any heads draw, so one worm can't erase another
    // worm's freshly drawn head (matching the C, which batches the draws).
    ctx.fillStyle = 'black';
    for (const w of worms) {
      w.tail = (w.tail + 1) % wormlength;
      const ti = w.tail;
      // Erase the oldest cell (already a wrapped coord; canvas clips at the
      // edge exactly as X did, so no separate wrap is needed for the rect).
      ctx.fillRect(w.cx[ti], w.cy[ti], circsize, circsize);

      // Turn +/- one segment (10 degrees), then advance one cell, toroidal.
      if (Math.random() < 0.5) {
        w.dir = (w.dir + 1) % SEGMENTS;
      } else {
        w.dir = (w.dir + SEGMENTS - 1) % SEGMENTS;
      }
      const nx = wrap(w.x + irint(circsize * costab[w.dir]), W);
      const ny = wrap(w.y + irint(circsize * sintab[w.dir]), H);

      // The slot that held the oldest cell now holds the newest head.
      w.cx[ti] = nx;
      w.cy[ti] = ny;
      w.x = nx;
      w.y = ny;
    }

    // Pass 2 (worm.c's draw_worm): draw each head. Worm i's color is
    // (i + chromo) % nc; chromo shifts every frame so each body is a moving
    // smooth-colormap gradient (segments keep the color they had when drawn).
    for (const w of worms) {
      ctx.fillStyle = colors[(w.index + chromo) % nc];
      ctx.fillRect(w.x, w.y, circsize, circsize);
    }

    chromo = (chromo + 1) % nc;
  }

  // Drive off requestAnimationFrame but keep the original pace: run one step()
  // per frame period, banking leftover time so the speed is the same at any
  // refresh rate. Cap catch-up so a backgrounded tab doesn't fire a burst.
  //
  // OVERHEAD: worm.c's *delay (17000 µs) is a sleep FLOOR; the live binary's
  // real frame period is delay + per-frame framework/draw cost, so we pace at
  // (delay + OVERHEAD) to match the author's rate rather than run faster (see
  // the framerate-calibration note). worm is a very light sparse hack (a handful
  // of worms, two fillRects each). Live-measured: 40.6fps (Load 31.0%, clean) at
  // stock delay 17000 -> OVERHEAD 7600.
  const OVERHEAD = 7600;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
    const delayMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    // The step counter bounds catch-up (MAX_CATCHUP_STEPS) so a long stall or a
    // tiny delay can't fire an unbounded burst of steps in one frame.
    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Rebuild the simulation after a non-live config change (clears the canvas
  // because size/colors/count may have changed, then re-seeds via init()).
  function reinit() {
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
    resume() { if (!rafId) { lastTime = 0; rafId = requestAnimationFrame(frame); } },
    reinit,   // re-seed the worms, keeping the current config
    config,   // host renders the config box from these
    params,
  };
}
