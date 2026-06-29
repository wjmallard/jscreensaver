// vines.js — vines packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's vines.c (Tracy Camp & David Hansen, 1997; ~189 lines).
// https://www.jwz.org/xscreensaver/
//
// "Yet another geometric pattern generator", whose claim to fame is a
// pseudo-fractal vine-like pattern of nifty whorls and loops. From a random
// centre point a "turtle" steps with an ever-accelerating integer turn,
// drawing short segments scaled down by a big divisor so each vine stays a
// small, curvy whorl. Vines accumulate one per frame; after a random budget
// (30..129) the screen clears and a fresh batch begins. Each vine is a single
// colour drawn at random from a fixed make_random_colormap palette (white when
// ncolors <= 2, the C's mono fallback).
//
// Rendering: genuinely line-shaped (one XDrawLine per segment in the C), so
// this uses canvas VECTOR ops — each vine's up-to-~18k segments are batched
// into one Path2D and stroked once in that vine's colour (one stroke/frame).
//
// See [[squiral]] for the shared skeleton; technique twin of [[ccurve]].

import { makeRandomColormapRGB } from './colormap.js';

export const title = 'vines';

export const info = {
  author: 'Tracy Camp and David Hansen',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nGenerates a continuous sequence of small, curvy geometric patterns.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/vines.xml (1:1 with the original).
  // The xml exposes only `delay` (the "Frame rate" slider, microseconds, one
  // whole vine drawn per step) and `ncolors` (size of the random colour pool).
  // Stock delay is 200000 us (~5 vines/sec) — kept, it is the intended calm pace
  // since each step is a discrete "draw a whole vine" event, not smooth motion.
  const config = {
    delay: 200000,   // microseconds between vines (--delay)
    ncolors: 64,     // size of the random colour pool (--ncolors)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 250000, step: 1000, default: 200000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // --count; 0 = draw each complete vine in a single frame (the xml default).
  const COUNT = 0;

  // NRAND(n): a uniform integer in [0, n), matching the C's (random() % n).
  const rand = (n) => Math.floor(Math.random() * n);

  let S = 1;                 // devicePixelRatio
  let W, H;                  // canvas size, device px
  let pscale;                // retina density factor (the C's fp->pscale)
  let palette;               // fixed make_random_colormap CSS strings (null if <=2)
  let currentColor;          // this vine's colour

  // Current-vine state (mirrors the C's vinestruct fields; all ints, so we hold
  // the int32 wraparound with `| 0` where the C relies on integer overflow).
  let a;                     // angle accumulator (grows huge, wraps at 2^31)
  let x1, y1, x2, y2;        // turtle endpoints in fixed-point plot units
  let i;                     // segment index this vine; grows 0..length
  let length;                // number of segments in this vine
  let iterations;            // vines remaining before the screen clears
  let constant;              // big divisor: plot units -> screen pixels
  let ang;                   // per-step turn factor
  let centerx, centery;      // this vine's screen origin

  // The C's colormap: xlockmore gives vines color_scheme_default (it defines no
  // SMOOTH/BRIGHT/UNIFORM macro), i.e. make_random_colormap(bright_p = False) —
  // `ncolors` INDEPENDENT, fully-random RGB colours (each channel random/0xFFFF),
  // NOT a smooth ramp and NOT a saturated rainbow. Built ONCE per run (color
  // setup lives in xlockmore_init), not rebuilt per batch. ncolors <= 2 takes the
  // C's MONO path (white only), so we hold no palette there.
  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    palette = n > 2
      ? makeRandomColormapRGB(n, false).map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`)
      : null;
  }

  // The C's init_vines: pick the per-batch retina factor, reset the counters,
  // and clear the window. Called on start/resize and again whenever a batch's
  // iteration budget runs out (the screen-full reset). NOTE: the colormap is
  // built ONCE (see buildPalette / start), NOT here — the C's color setup lives
  // in xlockmore_init, while init_vines only clears + resets counters.
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // fp->pscale: 1, x3 for large/retina, x6 for very large — drives vine length.
    pscale = 1;
    if (W > 1280 || H > 1280) pscale *= 3;
    if (W > 2560 || H > 2560) pscale *= 2;

    // The C's XSetLineAttributes (CapRound/JoinRound, width=pscale) is commented
    // out, so the original draws 1px lines with the GC defaults (butt cap, miter
    // join) — which are the canvas defaults too, so we leave cap/join alone. We
    // keep ~1 CSS px, scaled by dpr so they read on retina (as ccurve does);
    // pscale only affects vine length here, as in the C.
    ctx.lineWidth = Math.max(1, S);

    i = 0;
    length = 0;
    iterations = 30 + rand(100);   // 30..129 vines per screen before the clear

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // The C's draw_vines: when the current vine is finished, count it against the
  // batch budget (clearing + restarting when it hits 0), otherwise seed a fresh
  // vine; then advance/draw the turtle up to `count` segments (the whole vine
  // when COUNT == 0). Accumulates over a batch — never clears except via init().
  function step() {
    if (i >= length) {
      iterations--;
      if (iterations === 0) {
        init();          // screen full of vines: clear and start a fresh batch
        return;
      }
      centerx = rand(W);
      centery = rand(H);

      ang = 60 + rand(720);                 // 60..779
      length = (100 + rand(3000)) * pscale; // 100..3099, denser on retina
      constant = length * (10 + rand(10));  // length * (10..19): the plot divisor

      i = 0;
      a = 0;
      x1 = 0;
      y1 = 0;
      x2 = 1;
      y2 = 0;

      // C: MI_NPIXELS > 2 -> a random colormap entry, else the MONO white fallback.
      currentColor = palette ? palette[rand(palette.length)] : '#fff';
    }

    let count = i + COUNT;
    if (count <= i || count > length) count = length;   // COUNT == 0 -> whole vine

    const path = new Path2D();
    while (i < count) {
      // Integer-divide plot units down to screen pixels (the C's int division);
      // early segments collapse onto the centre until x/y outgrow `constant`.
      const px1 = centerx + Math.trunc(x1 / constant);
      const py1 = centery - Math.trunc(y1 / constant);
      const px2 = centerx + Math.trunc(x2 / constant);
      const py2 = centery - Math.trunc(y2 / constant);
      path.moveTo(px1, py1);
      path.lineTo(px2, py2);

      // Accelerating turn: `a` is a 32-bit int the C lets overflow, and cos/sin
      // read it directly as radians, so the wraparound is part of the look.
      a = (a + ang * i) | 0;

      x1 = x2;
      y1 = y2;

      // (int)(i * cos(a) * 360 / 2pi): truncate the step, then int32-accumulate.
      x2 = (x2 + Math.trunc((i * (Math.cos(a) * 360.0)) / (2.0 * Math.PI))) | 0;
      y2 = (y2 + Math.trunc((i * (Math.sin(a) * 360.0)) / (2.0 * Math.PI))) | 0;
      i++;
    }

    ctx.strokeStyle = currentColor;
    ctx.stroke(path);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Fixed-timestep lag-accumulator loop (squiral style): run one step() — one
  // whole vine — per config.delay, banking leftover time so the pace is the same
  // at any refresh rate. Cap catch-up so a backgrounded tab can't burst.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
    const delayMs = config.delay / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Rebuild after a non-live config change: ncolors resizes the fixed palette
  // (the only rebuild outside startup), then clear + re-seed via init().
  function reinit() {
    buildPalette();
    init();
  }

  window.addEventListener('resize', resize);
  buildPalette();   // built once for the whole run (the C's one-time color setup)
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
