// fadeplot.js — fadeplot packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's fadeplot.c ("fading plot of sine squared" — easy
// plotting stuff by Bas van Gaalen; standalone by Charles Vidal, 1996/1997).
// https://www.jwz.org/xscreensaver/
//
// A waving ribbon follows a sinusoidal path. Each step plots a cloud of
// `maxpts` tiny dots whose positions are read out of a precomputed "signed
// sine-squared" lookup table `stab[]` (one entry per of `angles` samples). The
// dots are split into `nbstep` strands; within a strand the table is walked at a
// fixed stride (`step`), and consecutive strands are phase-offset by `speed`. A
// per-frame phase `st` slides both the x and y read positions forward each step,
// so the whole figure sweeps. Old dots are erased (painted black) before the new
// ones are drawn, so the ribbon morphs rather than smearing. Every `angles/2`
// frames the speeds/strides are nudged and the screen cleared, retargeting the
// figure to a fresh shape.
//
// Rendering: per-dot fillRect — the field is sparse (at most `maxpts` dots, a
// few hundred to a couple thousand), so stamping each dot is far cheaper than a
// per-pixel ImageData blit. Matches the C, which erases the previous frame's
// rects and draws the new ones each step rather than diffing pixels.

import { makeUniformColormapRGB } from './colormap.js';

export const title = 'fadeplot';

export const info = {
  author: 'Bas van Gaalen and Charles Vidal',
  description: 'A waving ribbon follows a sinusoidal path.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/fadeplot.xml so the config box maps 1:1.
  const config = {
    delay: 30000,   // microseconds between steps (--delay), stock fadeplot.c DEFAULTS
    count: 10,      // number of strands / ribbon thickness (--count)
    cycles: 1500,   // dot budget: maxpts = cycles / scale (--cycles)
    ncolors: 64,    // size of the rainbow palette (--ncolors)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Thickness', type: 'range', min: 1, max: 30, step: 1, default: 10, lowLabel: 'thin', highLabel: 'thick', live: false },
    { key: 'cycles', label: 'Cycles', type: 'range', min: 1, max: 10000, step: 1, default: 1500, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let palette;        // ncolors uniform-colormap CSS strings (full hue ramp)

  // The fadeplotstruct scalars (the C works in plain ints).
  let min;            // MAX(MIN(W,H)/2, 1) — half the short side
  let scale;          // dot size in device px (1, or 3 on huge/retina displays)
  let speedX, speedY; // per-strand phase offsets (the C's speed.x/.y)
  let stepX, stepY;   // intra-strand table stride (the C's step.x/.y)
  let factorX, factorY; // table-value -> pixel scale (the C's factor.x/.y)
  let stX, stY;       // per-frame sweep phase (the C's st.x/.y)
  let temps;          // frame counter that drives the periodic mutate+clear
  let nbstep;         // number of strands (the C's nbstep, from count)
  let maxpts;         // total dots per frame (cycles / scale)
  let angles;         // number of samples in the sine table
  let stab;           // Int32Array(angles): signed sine-squared * min + min
  let pts;            // Int32Array(maxpts*2): packed (x,y) of the live dots
  let nlive;          // how many of `pts` are currently drawn (for erase)
  let pix;            // current palette index

  function nrand(n) {
    return Math.floor(Math.random() * n);
  }

  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    // fadeplot.c defines BOTH UNIFORM_COLORS and BRIGHT_COLORS, but xlockmore.h
    // resolves the scheme as #if UNIFORM / #elif SMOOTH / #elif BRIGHT, so
    // UNIFORM_COLORS wins -> make_uniform_colormap: a full hue ramp (0..359) at
    // one per-run S,V (each 66%-100%). A rainbow, but usually a touch muted and
    // varying run to run -- not the fixed max-vivid hsl() the first port used.
    // ncolors <= 2 -> white (the C's MI_WHITE_PIXEL path; see step()).
    if (n <= 2) {
      palette = new Array(n).fill('#fff');
      return;
    }
    palette = makeUniformColormapRGB(n).map(([r, g, b]) => `rgb(${r},${g},${b})`);
  }

  // Build the "signed sine squared" table: x = sin(2π i/angles), entry =
  // (int)(x*|x|*min) + min, so values land in [0, 2*min] (verbatim C).
  function initSintab() {
    angles = nrand(950) + 250;
    stab = new Int32Array(angles);
    for (let i = 0; i < angles; i++) {
      const x = Math.sin(2.0 * Math.PI * i / angles);
      stab[i] = Math.trunc(x * Math.abs(x) * min) + min;
    }
  }

  // Seed all state (the C's init_fadeplot). Clears to black.
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    min = Math.max(Math.min(W, H) / 2 | 0, 1);

    speedX = 8;
    speedY = 10;
    stepX = 1;
    stepY = 1;
    temps = 0;
    factorX = Math.max((W / (2 * min)) | 0, 1);
    factorY = Math.max((H / (2 * min)) | 0, 1);

    // The C bumps the dot size on very large (retina) displays and scales the
    // table strides to match, so the figure keeps its shape at higher density.
    scale = 1;
    if (W > 2560 || H > 2560) {
      scale *= 3;
      stepX *= scale;
      stepY *= scale;
    }

    // nbstep = count, clamped to >= MINSTEPS (1). The C also supports a negative
    // count meaning "random up to |count|"; the XML slider is non-negative so
    // that branch can't fire — we keep just the floor.
    nbstep = Math.max(1, Math.round(config.count));

    maxpts = Math.round(config.cycles) / scale | 0;
    if (maxpts < 1) maxpts = 1;

    pts = new Int32Array(maxpts * 2);
    nlive = 0;

    buildPalette();
    pix = palette.length > 2 ? nrand(palette.length) : 0;

    initSintab();

    stX = 0;
    stY = 0;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // Paint the currently-live dots in `color` (a CSS colour, or black to erase).
  function paintLive(color) {
    ctx.fillStyle = color;
    for (let k = 0; k < nlive; k++) {
      ctx.fillRect(pts[k * 2], pts[k * 2 + 1], scale, scale);
    }
  }

  // One animation step (the C's draw_fadeplot): erase the previous frame's dots,
  // pick the next plot colour, recompute the dot cloud from the sine table at the
  // current sweep phase, draw it, advance the phase, and periodically mutate the
  // motion parameters + clear the screen.
  function step() {
    // Erase the previous frame's dots (paint them black).
    paintLive('#000');

    // Pick the plot colour: cycle through the palette, or white if too few.
    let color;
    if (palette.length > 2) {
      color = palette[pix];
      if (++pix >= palette.length) pix = 0;
    } else {
      color = '#fff';
    }

    // Recompute the dot cloud: nbstep strands, each maxpts/nbstep dots, read out
    // of the sine table at offset (st + speed*j + i*step) mod angles, scaled by
    // factor and centred. Integer-divide maxpts/nbstep exactly like the C.
    const per = (maxpts / nbstep) | 0;
    let temp = 0;
    for (let j = 0; j < nbstep; j++) {
      for (let i = 0; i < per; i++) {
        // C's % can go negative on negative operands, but st/speed/step/i are
        // all >= 0 here, so a plain JS % matches.
        const ix = (stX + speedX * j + i * stepX) % angles;
        const iy = (stY + speedY * j + i * stepY) % angles;
        pts[temp * 2] = stab[ix] * factorX + (W / 2 | 0) - min;
        pts[temp * 2 + 1] = stab[iy] * factorY + (H / 2 | 0) - min;
        temp++;
      }
    }
    nlive = temp;

    // Draw the new cloud.
    paintLive(color);

    // Slide the sweep phase forward for the next frame.
    stX = (stX + speedX) % angles;
    stY = (stY + speedY) % angles;

    // Periodically nudge the motion and wipe the screen. The arithmetic mirrors
    // the C verbatim, including its operator precedence (`temps % angles * 5` is
    // `(temps % angles) * 5`) and the % 30 + 1 / % 20 / % 2 + 1 wrap rules.
    temps++;
    if ((temps % ((angles / 2) | 0)) === 0) {
      temps = (temps % angles) * 5;
      if ((temps % angles) === 0) {
        speedY = (speedY + 1) % 30 + 1;
      }
      if ((temps % (angles * 2)) === 0) {
        speedX = speedX % 20;
      }
      if ((temps % (angles * 3)) === 0) {
        stepY = (stepY + 1) % 2 + 1;
      }

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      nlive = 0;   // nothing on screen to erase next frame
    }
  }

  function reinit() {
    init();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced by config.delay (microseconds): run one step() per
  // delay, banking leftover time so the speed is identical at any refresh rate.
  // Cap catch-up so a backgrounded tab doesn't burst a run of steps on refocus.
  //
  // OVERHEAD: the live binary's *delay (stock 30000) is a sleep FLOOR; its real
  // per-frame cost is higher. Measured live fadeplot on XQuartz = ~25 fps (Load
  // ~22%, delay-bound) when the figure is a compact dotted band, i.e. a ~40000
  // us period, so OVERHEAD = round(1e6/25) - 30000 = 10000 us. (The rate dips to
  // ~11 fps while the figure spreads into a full-screen curve -- that is the X
  // server's per-frame full-window composite cost on XQuartz for 1500 scattered
  // rects, not the hack's intended pace; the compact-band rate is the faithful
  // delay-bound target and matches the lisa-family overhead.) config.delay still
  // maps 1:1 to the stock resource. See framerate-calibration.
  const OVERHEAD = 10000;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (the stock resource); add the measured
    // framework OVERHEAD, then convert to the rAF clock's milliseconds.
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
    reinit,
    config,
    params,
  };
}
