// coral.js — coral packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params } so a
// host page can cycle hacks on one shared canvas.
//
// Port of xscreensaver's coral.c by Frederick G.M. Roeber (1997).
// https://www.jwz.org/xscreensaver/
//
// Diffusion-limited aggregation: scatter a few sticky "seeds", then set
// thousands of random walkers loose. A walker that lands on a sticky cell
// sticks there and makes its 8 neighbours sticky too, so the coral grows
// outward branch by branch until every walker has been absorbed. The draw
// colour creeps through a (muted) rainbow as walkers stick; when the last one
// sticks the finished image LINGERS for a few seconds, then clears and regrows.

import { makeColorRampRGB } from './colormap.js';

export const title = 'coral';

export const info = {
  author: 'Frederick Roeber',
  description: 'Simulates colorful coral growth.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // coral.c has no ncolors resource: it hardcodes NCOLORSMAX and fills it via
  // make_uniform_colormap, which a TrueColor visual (a canvas) keeps whole.
  const NCOLORS = 200;     // coral.c NCOLORSMAX

  // Config mirrors coral.xml exactly: delay2 (µs/sweep, "Frame rate", inverted),
  // delay (seconds to linger, "Linger"), density, seeds. Nothing else is a
  // resource — scale is auto-derived from the display, ncolors is hardcoded.
  const config = {
    delay2: 20000,   // µs between simulation sweeps (--delay2; xml default 20000)
    delay: 5,        // seconds to hold the finished coral (--delay; xml default 5)
    density: 25,     // % of cells seeded as random walkers (--density)
    seeds: 20,       // initial sticky nuclei (--seeds)
  };

  // Tunable params for the host config box (units as the .xml exposes them).
  const params = [
    { key: 'delay2', label: 'Frame rate', type: 'range', min: 1, max: 500000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'delay', label: 'Linger', type: 'range', min: 1, max: 60, step: 1, default: 5, unit: ' s', lowLabel: '1 second', highLabel: '1 minute', live: true },
    { key: 'density', label: 'Density', type: 'range', min: 1, max: 90, step: 1, default: 25, lowLabel: 'sparse', highLabel: 'dense', live: false },
    { key: 'seeds', label: 'Seeds', type: 'range', min: 1, max: 100, step: 1, default: 20, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  let width, height, scale;
  let board;
  let walkerX, walkerY, liveWalkers;
  let colors, colorIndex, colorInterval;
  let done, holdRemaining;

  // Stamp a 3x3 sticky block centred on (x, y). Walkers and seeds only ever sit
  // one cell inside the grid border, so the neighbours are always in bounds.
  // (coral.c omits the centre setdot when a walker sticks since it's already
  // sticky; stamping all 9 is identical because that centre is already set.)
  function markSticky(x, y) {
    for (let dy = -1; dy <= 1; dy++) {
      const row = (y + dy) * width;
      for (let dx = -1; dx <= 1; dx++) {
        board[row + x + dx] = 1;
      }
    }
  }

  function drawCell(x, y) {
    ctx.fillRect(x * scale, y * scale, scale, scale);
  }

  // make_uniform_colormap (coral.c via utils/colors.c) = make_color_ramp(0,S,V
  // -> 359,S,V, closed_p=false): a full hue sweep at a FIXED, slightly-muted
  // saturation/value, with S,V each random in 0.66..0.99 and re-rolled on every
  // regrow. NOT a vivid full-saturation rainbow. Built with the faithful
  // colormap.js ramp (the C's "always h1->h2, never the short way" hue path).
  function buildColors() {
    const sat = (Math.floor(Math.random() * 34) + 66) / 100;   // 0.66..0.99
    const val = (Math.floor(Math.random() * 34) + 66) / 100;   // 0.66..0.99
    const ramp = makeColorRampRGB(0, sat, val, 359, sat, val, NCOLORS);
    colors = ramp.map(([r, g, b]) => `rgb(${r},${g},${b})`);
  }

  function init() {
    // The gallery's "consistent crispness" model: grow at LOGICAL (CSS-pixel)
    // resolution and draw each cell as a dpr x dpr device-px rect. On a non-
    // retina display (dpr 1) this is coral.c's scale=1 path exactly; on retina
    // it keeps the walker count + grid in CSS px (coral.c's >2560px scale=2
    // branch would instead grow at device resolution — see coral.md).
    scale = window.devicePixelRatio || 1;
    width = Math.floor(canvas.width / scale);
    height = Math.floor(canvas.height / scale);

    buildColors();
    colorIndex = Math.floor(Math.random() * NCOLORS);   // coral.c: random()%ncolors

    board = new Uint8Array(Math.max(0, width * height));
    walkerX = new Int32Array(0);
    walkerY = new Int32Array(0);
    liveWalkers = 0;
    done = false;
    holdRemaining = -1;

    if (width <= 2 || height <= 2) {
      done = true;
      return;
    }

    // density / seeds: coral.c's exact clamps (the .xml caps both sliders below
    // these limits, so the upper clamps are inert in practice but kept faithful).
    let density = Math.round(config.density);
    if (density < 1) density = 1;
    else if (density > 100) density = 90;   // "more like mold than coral"
    let seeds = Math.round(config.seeds);
    if (seeds < 1) seeds = 1;
    else if (seeds > 1000) seeds = 1000;

    const nwalkers = Math.floor(width * height * density / 100);
    colorInterval = Math.floor(nwalkers * 2 / NCOLORS);   // coral.c colorsloth

    // Scatter the sticky nuclei: each is one drawn cell wrapped in an invisible
    // 3x3 sticky halo for walkers to accrete onto, drawn in the start colour.
    ctx.fillStyle = colors[colorIndex];
    for (let i = 0; i < seeds; i++) {
      let x, y, tries = 10;
      do {
        x = 1 + Math.floor(Math.random() * (width - 2));
        y = 1 + Math.floor(Math.random() * (height - 2));
      } while (board[y * width + x] && tries--);
      markSticky(x, y);
      drawCell(x, y);
    }

    // Random walkers that diffuse until they touch the coral.
    walkerX = new Int32Array(nwalkers);
    walkerY = new Int32Array(nwalkers);
    for (let i = 0; i < nwalkers; i++) {
      walkerX[i] = 1 + Math.floor(Math.random() * (width - 2));
      walkerY[i] = 1 + Math.floor(Math.random() * (height - 2));
    }
    liveWalkers = nwalkers;
  }

  function clear() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    clear();
    init();
  }

  function restart() {
    clear();
    init();
  }

  // One diffusion sweep (coral.c's coral()): every live walker either sticks or
  // takes one random cardinal step. Sets `done` when the last walker sticks.
  function step() {
    for (let i = 0; i < liveWalkers; i++) {
      const x = walkerX[i];
      const y = walkerY[i];

      if (board[y * width + x]) {
        // Touched the coral: draw this cell, spread stickiness to its 8
        // neighbours, then retire the walker (swap in the last live one — and,
        // as in coral.c, that swapped-in walker is skipped until the next sweep).
        drawCell(x, y);
        markSticky(x, y);
        liveWalkers--;
        walkerX[i] = walkerX[liveWalkers];
        walkerY[i] = walkerY[liveWalkers];

        // Advance the colour every `colorInterval` walkers absorbed (coral.c's
        // colorsloth), sweeping ncolors/2 entries across the whole growth. The
        // just-drawn cell keeps the pre-advance colour (coral.c flushes first).
        if (colorInterval === 0 || liveWalkers % colorInterval === 0) {
          colorIndex = (colorIndex + 1) % NCOLORS;
          ctx.fillStyle = colors[colorIndex];
        }
      } else {
        // Step one cell in a random cardinal direction, staying inside the
        // border so the 3x3 sticky stamp never runs off the grid. A blocked
        // direction means "don't move this sweep" (coral.c's do/while(0) +
        // continue), NOT "retry another direction".
        switch (Math.floor(Math.random() * 4)) {
          case 0: if (x > 1)           walkerX[i] = x - 1; break;
          case 1: if (x < width - 2)   walkerX[i] = x + 1; break;
          case 2: if (y > 1)           walkerY[i] = y - 1; break;
          default: if (y < height - 2) walkerY[i] = y + 1; break;
        }
      }
    }

    if (liveWalkers === 0) done = true;
  }

  // rAF lag-accumulator: run one step() per config.delay2 (µs -> ms), banking
  // leftover time so the pace is identical at any refresh rate; cap catch-up so
  // a backgrounded tab doesn't fire a burst on return. When growth finishes,
  // LINGER (coral.c returns delay*1e6 µs, holding the static image) for
  // config.delay seconds of real wall time, then clear and regrow. coral.c
  // animates an erase between linger and regrow; we clear instantly (wipes
  // aren't integrated — see coral.md).
  //
  // OVERHEAD applies to the per-sweep delay2 only (NOT the linger): the stock
  // delay2 is a sleep floor; the live binary's real sweep rate is lower (delay2 +
  // framework overhead -- see the framerate-calibration note). The live coral
  // measures 35.9 fps mid-growth, but the port at the stock 20000 us ran 50
  // sweeps/sec (1.4x fast). 20000 + 7855 = 27855 us -> 35.9 sweeps/sec, matching
  // the live binary. A calibration, not a tuning knob (the slider stays 1:1).
  const OVERHEAD = 7855;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    const dt = now - lastTime;
    lastTime = now;

    if (done) {
      // Hold the finished coral, counting down real elapsed time so the linger
      // is config.delay seconds regardless of frame rate (and pauses cleanly:
      // resume zeroes lastTime, so the first frame's dt is 0).
      if (holdRemaining < 0) holdRemaining = config.delay * 1000;
      holdRemaining -= dt;
      if (holdRemaining <= 0) restart();
      lag = 0;
      rafId = requestAnimationFrame(frame);
      return;
    }

    lag += dt;
    const delayMs = (config.delay2 + OVERHEAD) / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);
    while (lag >= delayMs && !done) {
      step();
      lag -= delayMs;
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
    reinit: restart,   // clear + regrow with the current config
    config,
    params,
  };
}
