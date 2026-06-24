// cynosure.js — cynosure packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's cynosure.c — Stephen Linhart's screensaver, written
// in Java by ozymandias G desiderata (1996) and ported to C by Jamie Zawinski
// (1997). https://www.jwz.org/xscreensaver/
//
// Each step() paints one full LAYER of dropshadowed rectangles. A grid of
// randomly-sized cells (gridSize +/- gridSize/2 in each axis) tiles the screen;
// one rectangle is placed at a random size and offset inside every cell. Every
// row of the grid is a single colour, and the colour drifts slightly from row
// to row (the "sway" colour ramp), occasionally jumping to a random hue. Each
// rectangle is drawn as: a translucent dark shadow offset by `elevation`, a
// background-coloured edge offset by `shadowWidth`, the solid fill, and a 1px
// border. Layers stack on top of each other; every `iterations` layers the
// canvas clears to a random palette colour and the pile begins again — so
// rectangles "pop onto the screen in lockstep".
//
// Rendering: sparse per-step ctx.fillRect / strokeRect (like greynetic — the
// canvas itself is the persistent pile, nothing is read back). See [[greynetic]]
// for the rect-stamp idiom and [[squiral]] for the shared module skeleton.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'cynosure';

export const info = {
  author: 'Ozymandias G. Desiderata, Jamie Zawinski, and Stephen Linhart',
  description: 'Random dropshadowed rectangles pop onto the screen in lockstep.',
  year: 1998,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/cynosure.xml. The stock XML exposes
  // delay + ncolors + iterations; shadowWidth / elevation / sway / tweak /
  // gridSize come from the C's cynosure_defaults (same units), surfaced here so
  // the look is tunable. `delay` is the stock 500000 µs (~0.5 s per layer). The
  // per-layer draw (a full-canvas translucent rounded-rect) is NOT negligible:
  // the live -fps reads 1.8/s (not 2.0), so a measured OVERHEAD is added below.
  const config = {
    delay: 500000,      // µs between layers (--delay); one paint() per delay
    ncolors: 128,       // size of the smooth colour ramp (--ncolors)
    iterations: 100,    // layers painted before the screen clears (--iterations)
    shadowWidth: 2,     // bg-edge inset under each rectangle (C: shadowWidth)
    elevation: 5,       // dropshadow offset, px (C: elevation)
    sway: 30,           // calls between base-colour resets (C: sway)
    tweak: 20,          // amount of per-row colour variance (C: tweak)
    gridSize: 12,       // nominal cells per axis; varies +/- gridSize/2 (C: gridSize)
  };

  // live: true  -> the loop reads config every step, so it applies instantly.
  // live: false -> the value sizes the palette/grid, so a change re-runs init()
  //                via reinit() (which also clears the canvas).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 1000000, step: 10000, default: 500000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'iterations', label: 'Duration', type: 'range', min: 2, max: 200, step: 1, default: 100, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'gridSize', label: 'Grid size', type: 'range', min: 2, max: 30, step: 1, default: 12, lowLabel: 'coarse', highLabel: 'fine', live: true },
    { key: 'tweak', label: 'Color variance', type: 'range', min: 1, max: 60, step: 1, default: 20, lowLabel: 'subtle', highLabel: 'wild', live: true },
    { key: 'sway', label: 'Color sway', type: 'range', min: 1, max: 100, step: 1, default: 30, lowLabel: 'fast', highLabel: 'slow', live: true },
    { key: 'elevation', label: 'Shadow depth', type: 'range', min: 0, max: 20, step: 1, default: 5, lowLabel: 'flat', highLabel: 'deep', live: true },
    { key: 'shadowWidth', label: 'Edge width', type: 'range', min: 0, max: 10, step: 1, default: 2, lowLabel: 'thin', highLabel: 'thick', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 128, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // The C's MINCELLSIZE / MINRECTSIZE / THRESHOLD constants (px / odds).
  const MINCELLSIZE = 16;   // smallest allowed cell (before dpr scaling)
  const MINRECTSIZE = 6;    // narrowest a rectangle can be (before dpr scaling)
  const THRESHOLD = 100;    // 1-in-100 chance genNewColor() returns a random hue

  let S = 1;            // devicePixelRatio
  let W, H;             // canvas size, device px
  let colors;           // smooth colour ramp, ncolors css strings
  let shadowColors;     // same ramp, translucent + darkened (the dropshadow)

  // Sway / colour-ramp state (C: curColor, curBase, timeLeft).
  let curColor;         // base index the row colours drift around
  let curBase;          // most-recent generated index (becomes curColor on reset)
  let timeLeft;         // calls until curColor snaps to curBase

  // Layer counter (C: st->i vs st->iterations).
  let layer;

  function randInt(n) {
    return Math.floor(Math.random() * n);
  }

  // make_smooth_colormap (via colormap.js): pick 2-5 random HSV anchors and
  // interpolate them into a closed loop of `ncolors` entries — usually
  // muted/pastel, re-rolled every run, NOT a fixed vivid rainbow. shadowColors
  // is the C's NON-jwxyz dropshadow path: the same colour with value *= 0.4
  // (== rgb * 0.4 for fixed h,s), opaque — which is what the live XScreenSaver
  // binary draws on X11 (HAVE_JWXYZ undefined). n <= 2 takes the C's mono path
  // (ncolors <= 2 -> mono_p): white fills with black shadows/edges.
  function buildPalette() {
    const n = Math.max(2, Math.round(config.ncolors));
    colors = new Array(n);
    shadowColors = new Array(n);
    if (n <= 2) {
      colors.fill('#fff');
      shadowColors.fill('#000');
      return;
    }
    const cm = makeSmoothColormapRGB(n);
    for (let i = 0; i < n; i++) {
      const [r, g, b] = cm[i];
      colors[i] = `rgb(${r}, ${g}, ${b})`;
      shadowColors[i] = `rgb(${Math.round(r * 0.4)}, ${Math.round(g * 0.4)}, ${Math.round(b * 0.4)})`;
    }
  }

  // C: c_tweak — a value tweaked by +/- tweak, reflected off 0, clamped to 255.
  // Used both for grid cell counts and (indirectly) the sway timer.
  function cTweak(base, tweak) {
    const ranTweak = randInt(2 * tweak);
    let n = base + (ranTweak - tweak);
    if (n < 0) n = -n;
    return n < 255 ? n : 255;
  }

  // C: genConstrainedColor — a new index within +/- tweak of `base`, wrapped
  // into [0, ncolors). Note the C always tweaks by config.tweak (the `tweak`
  // arg is unused there too); we keep that behaviour.
  function genConstrainedColor(base) {
    const n = colors.length;
    let i = 1 + randInt(config.tweak);
    if (Math.random() < 0.5) i = -i;
    i = (base + i) % n;
    while (i < 0) i += n;
    return i;
  }

  // C: genNewColor — drives the "sway". When the sway timer expires, snap the
  // drift centre (curColor) to the last generated index (curBase) and reload the
  // timer with a tweaked sway. THRESHOLD of the time, jump to a fully random hue;
  // otherwise drift curBase one constrained step and return it.
  function genNewColor() {
    if (timeLeft === 0) {
      timeLeft = cTweak(config.sway, Math.floor(config.sway / 3));
      curColor = curBase;
    } else {
      timeLeft--;
    }

    if (randInt(THRESHOLD) === 0) {
      return randInt(colors.length);
    }
    curBase = genConstrainedColor(curColor);
    return curBase;
  }

  // C: paint() — lay down one full grid layer of dropshadowed rectangles.
  function paint() {
    const sw = Math.round(config.shadowWidth * S);
    const elev = Math.round(config.elevation * S);
    const minCell = Math.round(MINCELLSIZE * S);
    const minRect = Math.round(MINRECTSIZE * S);

    // Grid dimensions wobble by +/- gridSize/2 around the nominal gridSize.
    let cellsWide = cTweak(config.gridSize, Math.floor(config.gridSize / 2));
    let cellsHigh = cTweak(config.gridSize, Math.floor(config.gridSize / 2));
    if (cellsWide < 1) cellsWide = 1;
    if (cellsHigh < 1) cellsHigh = 1;

    let cellWidth = Math.floor(W / cellsWide);
    let cellHeight = Math.floor(H / cellsHigh);

    // Keep each cell above the minimum size, recomputing how many fit (the C
    // has a copy-paste quirk here — the height branch recomputes cellsHigh from
    // width/cellWidth; we use the correct height/cellHeight so the bottom rows
    // don't run off-screen).
    if (cellWidth < minCell) {
      cellWidth = minCell;
      cellsWide = Math.floor(W / cellWidth);
    }
    if (cellHeight < minCell) {
      cellHeight = minCell;
      cellsHigh = Math.floor(H / cellHeight);
    }
    if (cellsWide < 1) cellsWide = 1;
    if (cellsHigh < 1) cellsHigh = 1;

    for (let i = 0; i < cellsHigh; i++) {
      // Each row is one colour, drifting from the row above (the sway ramp).
      const c = genNewColor();
      const fill = colors[c];
      const shadow = shadowColors[c];

      for (let j = 0; j < cellsWide; j++) {
        // Random rect size inside the cell, floored at the minimum. The C does
        // random() % (cell - shadowWidth); guard the modulus against <= 0.
        const wRange = cellWidth - sw;
        const hRange = cellHeight - sw;
        let curHeight = hRange > 0 ? randInt(hRange) : 0;
        if (curHeight < minRect) curHeight = minRect;
        let curWidth = wRange > 0 ? randInt(wRange) : 0;
        if (curWidth < minRect) curWidth = minRect;

        // Random offset within the cell (C: random() % ((cell - cur) - sw)).
        const yRange = (cellHeight - curHeight) - sw;
        const xRange = (cellWidth - curWidth) - sw;
        const curY = (i * cellHeight) + (yRange > 0 ? randInt(yRange) : 0);
        const curX = (j * cellWidth) + (xRange > 0 ? randInt(xRange) : 0);

        // Shadow: translucent dark rect offset down-right by elevation.
        if (elev > 0) {
          ctx.fillStyle = shadow;
          ctx.fillRect(curX + elev, curY + elev, curWidth, curHeight);
        }

        // Edge: background (black) rect offset by shadowWidth — reads as a lit
        // bevel between the fill and the shadow.
        if (sw > 0) {
          ctx.fillStyle = '#000';
          ctx.fillRect(curX + sw, curY + sw, curWidth, curHeight);
        }

        // Fill: the row colour.
        ctx.fillStyle = fill;
        ctx.fillRect(curX, curY, curWidth, curHeight);

        // 1px black border around the rectangle (C: XDrawRectangle bg_gc). X11
        // strokes inclusive of (x+w, y+h); offset by 0.5 for a crisp 1px line.
        ctx.strokeStyle = '#000';
        ctx.lineWidth = Math.max(1, S);
        ctx.strokeRect(
          curX + 0.5,
          curY + 0.5,
          curWidth,
          curHeight,
        );
      }
    }
  }

  // C: cynosure_draw — every `iterations` layers, clear to a random palette
  // colour; then paint one layer. (We clear BEFORE painting the layer, as the C
  // does: it clears, then paints into the freshly-coloured window.)
  function step() {
    layer++;
    if (config.iterations > 0 && layer >= config.iterations) {
      layer = 0;
      ctx.fillStyle = colors[randInt(colors.length)];
      ctx.fillRect(0, 0, W, H);
    }
    paint();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    buildPalette();
    curColor = 0;
    curBase = 0;
    timeLeft = 0;
    layer = 0;
  }

  // reinit clears to black (the palette size may have changed) and re-seeds.
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    buildPalette();
    curColor = 0;
    curBase = 0;
    timeLeft = 0;
    layer = 0;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // Drive off requestAnimationFrame but keep the original pace: one step() (one
  // painted layer) per config.delay, banking leftover time so the speed is the
  // same at any refresh rate. Cap catch-up so a backgrounded tab doesn't fire a
  // burst of layers on refocus.
  // OVERHEAD: the live -fps overlay reads 1.8 layers/s at Load ~9% (3 clean solo
  // samples), i.e. a real frame of 1e6/1.8 = 555556 us = 500000 sleep-floor +
  // ~55556 us of per-layer compute. So pace each layer at (delay + OVERHEAD).
  const OVERHEAD = 55556;   // microseconds (measured off -fps, not by-eye)
  const MAX_CATCHUP_STEPS = 4;
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

    // The step counter bounds the loop even when delayMs is 0 (max frame rate),
    // which would otherwise spin forever since lag never drops below 0.
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
    reinit,   // re-seed colours + clear, keeping the current config
    config,
    params,
  };
}
