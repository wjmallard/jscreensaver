// hopalong.js — hopalong packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's hopalong (hop.c) by Patrick Naughton (1992),
// xlockmore lineage; later ops from Ed Kubaitis, Renaldo Recuerdo,
// Clifford Pickover and Peter de Jong. https://www.jwz.org/xscreensaver/
//
// The Barry-Martin "hopalong" strange attractor: iterate a 2D map (one of 11
// formulas — Martin/sqrt, EJK1..6, RR, Popcorn, Jong, Sine), plotting one point
// per iteration. Thousands of points accumulate into a lacy fractal; one solid
// colour per frame, walking a make_smooth_colormap palette one entry per frame
// so the figure builds up in bands of evolving (often muted) colour. After
// `cycles` frames the image clears and a fresh attractor (new random formula +
// parameters) begins.
//
// Rendering: point plotting, thousands per frame, so the BLIT path — accumulate
// into a persistent Uint32 ImageData buffer and putImageData once per frame
// (like sierpinski / binaryring), not per-point fillRect.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'hopalong';

export const info = {
  author: 'Patrick Naughton',
  description: 'Lacy fractal patterns based on iteration in the imaginary plane, from a 1986 Scientific American article.\n\nSee also the "Discrete" screen saver.',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/hopalong.xml.
  //   count   — points plotted per frame. The colour only advances once per
  //             frame, so more points per frame = fewer colour changes per
  //             point: the xml labels this "Color contrast" for that reason.
  //   cycles  — frames before the image clears and a new attractor begins.
  //   ncolors — size of the make_smooth_colormap palette walked once/frame.
  const config = {
    delay: 10000,    // µs between frames (--delay)
    cycles: 2500,    // frames before clear + new attractor (--cycles)
    count: 1000,     // points plotted per frame (--count)
    ncolors: 200,    // hue-cycle size (--ncolors)
    formula: 'random',
  };

  // live: true  -> the loop reads it every frame, applies instantly.
  // live: false -> sizes the buffer / colour table / picks the attractor, so a
  //                change re-runs init() via reinit() (and clears the canvas).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cycles', label: 'Duration', type: 'range', min: 100, max: 100000, step: 100, default: 2500, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'count', label: 'Color contrast', type: 'range', min: 100, max: 10000, step: 100, default: 1000, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'formula', label: 'Formula', type: 'select', default: 'random', live: false, options: [
        { value: 'random',  label: 'random' },
        { value: 'martin',  label: 'Martin' },
        { value: 'sine',    label: 'Sine' },
        { value: 'popcorn', label: 'Popcorn' },
        { value: 'jong',    label: 'Jong' },
        { value: 'rr',      label: 'RR' },
        { value: 'ejk1',    label: 'EJK1' },
        { value: 'ejk2',    label: 'EJK2' },
        { value: 'ejk3',    label: 'EJK3' },
        { value: 'ejk4',    label: 'EJK4' },
        { value: 'ejk5',    label: 'EJK5' },
        { value: 'ejk6',    label: 'EJK6' },
      ] },
  ];

  // Operation codes — same set as the C's #defines.
  const OP = {
    MARTIN: 0, EJK1: 1, EJK2: 2, EJK4: 3, EJK5: 4,
    RR: 5, JONG: 6, POPCORN: 7, SINE: 8, EJK3: 9, EJK6: 10,
  };
  // The 11 ops, indexed 0..10, for the random pick (NRAND(OPS), OPS=11).
  const OPS = [
    OP.MARTIN, OP.EJK1, OP.EJK2, OP.EJK4, OP.EJK5,
    OP.RR, OP.JONG, OP.POPCORN, OP.SINE, OP.EJK3, OP.EJK6,
  ];
  const FORMULA_OP = {
    martin: OP.MARTIN, sine: OP.SINE, popcorn: OP.POPCORN, jong: OP.JONG,
    rr: OP.RR, ejk1: OP.EJK1, ejk2: OP.EJK2, ejk3: OP.EJK3,
    ejk4: OP.EJK4, ejk5: OP.EJK5, ejk6: OP.EJK6,
  };

  const BLACK = 0xFF000000;       // opaque black, little-endian 0xAABBGGRR
  const WHITE = 0xFFFFFFFF;       // opaque white (MI_WHITE_PIXEL; used when ncolors <= 2)
  const PI = Math.PI;

  let W, H, S, cx, cy, dot;
  let imageData, pixels;
  let colorsU;                 // palette: packed-RGBA make_smooth_colormap (or [WHITE])
  let op, a, b, c, d, ii, jj;  // attractor state (i/j renamed ii/jj)
  let inc, pix, time;

  const rnd = Math.random;            // [0,1)
  const signed = () => rnd() * 2 - 1; // [-1,1)

  // Palette: a faithful make_smooth_colormap (utils/colors.c, via colormap.js) --
  // 2-5 random HSV anchors interpolated into a closed loop, OFTEN muted/pastel,
  // NOT a vivid spectral rainbow. The STANDALONE C builds this ONCE at startup
  // (#define SMOOTH_COLORS -> color_scheme_smooth in xlockmore.c) and init_hop
  // never rebuilds it, so a single palette serves the whole run, walked by `pix`
  // (one entry per frame); we build it once per init() to match that cadence.
  // When ncolors <= 2 the framework falls to MONO and draw_hop skips the colour
  // path, drawing in MI_WHITE_PIXEL (its `if (MI_NPIXELS(mi) > 2)` gate), so we
  // use a single white entry there.
  function buildColors() {
    const n = Math.max(1, Math.round(config.ncolors));
    if (n > 2) {
      const map = makeSmoothColormapRGB(n);
      colorsU = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        const [r, g, b] = map[i];
        colorsU[i] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
      }
    } else {
      colorsU = new Uint32Array([WHITE]);
    }
  }

  // Plot a dot-sized square (dot scales with dpr) at integer (x, y).
  function plot(x, y, color) {
    x |= 0; y |= 0;
    for (let j = 0; j < dot; j++) {
      const yy = y + j;
      if (yy < 0 || yy >= H) continue;
      const row = yy * W;
      for (let i = 0; i < dot; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < W) pixels[row + xx] = color;
      }
    }
  }

  // Pick a new attractor (formula + parameters) and clear the buffer. Faithful
  // to init_hop(): `range` sets the parameter scale (derived from the device-px
  // centre, so a,b,c,d scale with the canvas and the figure fills it at any dpr)
  // and `inc` is a random integer offset. The C keeps the whole iteration in raw
  // pixels; we leave inc UNSCALED too (faithful, and its per-frame ++ drift
  // swamps the tiny initial value) and only bump the dot SIZE on dense displays
  // (see init()). The map state i/j is already in screen-pixel units.
  function startover() {
    op = config.formula === 'random'
      ? OPS[(rnd() * OPS.length) | 0]
      : FORMULA_OP[config.formula];

    // range = sqrt(cx^2 + cy^2) / (1 + rand[0,1))  -> divisor in [1, 2)
    const range = Math.sqrt(cx * cx + cy * cy) / (1.0 + rnd());
    ii = 0.0;
    jj = 0.0;
    inc = ((rnd() * 200) | 0) - 100;   // C: (int)((LRAND()/MAXRAND)*200) - 100 -> [-100,99]

    switch (op) {
      case OP.MARTIN:
        a = signed() * range / 20.0;
        b = signed() * range / 20.0;
        c = (rnd() < 0.5) ? signed() * range / 20.0 : 0.0;
        break;
      case OP.EJK1:
        a = signed() * range / 30.0;
        c = signed() * range / 40.0;
        b = rnd() * 0.4;
        break;
      case OP.EJK2:
        a = signed() * range / 30.0;
        b = Math.pow(10.0, 6.0 + rnd() * 24.0);
        if (rnd() < 0.5) b = -b;
        c = Math.pow(10.0, rnd() * 9.0);
        if (rnd() < 0.5) c = -c;
        break;
      case OP.EJK3:
        a = signed() * range / 30.0;
        c = signed() * range / 70.0;
        b = rnd() * 0.35 + 0.5;
        break;
      case OP.EJK4:
        a = signed() * range / 2.0;
        c = signed() * range / 200.0;
        b = rnd() * 9.0 + 1.0;
        break;
      case OP.EJK5:
        a = signed() * range / 2.0;
        c = signed() * range / 200.0;
        b = rnd() * 0.3 + 0.1;
        break;
      case OP.EJK6:
        a = signed() * range / 30.0;
        b = rnd() + 0.5;
        break;
      case OP.RR:
        a = signed() * range / 40.0;
        b = signed() * range / 200.0;
        c = signed() * range / 20.0;
        d = rnd() * 0.9;
        break;
      case OP.POPCORN:
        a = 0.0;
        b = 0.0;
        c = signed() * 0.24 + 0.25;
        inc = 100;   // C overrides inc; popcorn reuses it as a 0..99 frame counter
        break;
      case OP.JONG:
        a = signed() * PI;
        b = signed() * PI;
        c = signed() * PI;
        d = signed() * PI;
        break;
      case OP.SINE:   // MARTIN2
        a = PI + signed() * 0.7;
        break;
    }

    pix = (rnd() * colorsU.length) | 0;
    time = 0;
    pixels.fill(BLACK);
  }

  // One frame: advance colour + inc once, then plot `count` points by iterating
  // the chosen map. Mirrors draw_hop()'s inner while-loop, one case per op.
  function step() {
    const n = Math.max(1, Math.round(config.count));
    inc++;
    const color = colorsU[pix];
    if (++pix >= colorsU.length) pix = 0;

    for (let k = 0; k < n; k++) {
      const oldj = jj;
      let oldi, x, y;

      switch (op) {
        case OP.MARTIN:   // SQRT, MARTIN1
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj + ((ii < 0) ? Math.sqrt(Math.abs(b * oldi - c))
                                : -Math.sqrt(Math.abs(b * oldi - c)));
          x = cx + Math.trunc(ii + jj);
          y = cy - Math.trunc(ii - jj);
          break;
        case OP.EJK1:
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj - ((ii > 0) ? (b * oldi - c) : -(b * oldi - c));
          x = cx + Math.trunc(ii + jj);
          y = cy - Math.trunc(ii - jj);
          break;
        case OP.EJK2:
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj - ((ii < 0) ? Math.log(Math.abs(b * oldi - c))
                                : -Math.log(Math.abs(b * oldi - c)));
          x = cx + Math.trunc(ii + jj);
          y = cy - Math.trunc(ii - jj);
          break;
        case OP.EJK3:
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj - ((ii > 0) ? Math.sin(b * oldi) - c : -Math.sin(b * oldi) - c);
          x = cx + Math.trunc(ii + jj);
          y = cy - Math.trunc(ii - jj);
          break;
        case OP.EJK4:
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj - ((ii > 0) ? Math.sin(b * oldi) - c
                                : -Math.sqrt(Math.abs(b * oldi - c)));
          x = cx + Math.trunc(ii + jj);
          y = cy - Math.trunc(ii - jj);
          break;
        case OP.EJK5:
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj - ((ii > 0) ? Math.sin(b * oldi) - c : -(b * oldi - c));
          x = cx + Math.trunc(ii + jj);
          y = cy - Math.trunc(ii - jj);
          break;
        case OP.EJK6:
          oldi = ii + inc;
          jj = a - ii;
          // C: asin((b*oldi) - (long)(b*oldi)) — fractional part via trunc.
          ii = oldj - Math.asin((b * oldi) - Math.trunc(b * oldi));
          x = cx + Math.trunc(ii + jj);
          y = cy - Math.trunc(ii - jj);
          break;
        case OP.RR:   // RR1
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj - ((ii < 0) ? -Math.pow(Math.abs(b * oldi - c), d)
                                : Math.pow(Math.abs(b * oldi - c), d));
          x = cx + Math.trunc(ii + jj);
          y = cy - Math.trunc(ii - jj);
          break;
        case OP.POPCORN: {
          const HVAL = 0.05;
          const INCVAL = 50;
          if (inc >= 100) inc = 0;
          if (inc === 0) {
            if (a++ >= INCVAL) {
              a = 0;
              if (b++ >= INCVAL) b = 0;
            }
            ii = (-c * INCVAL / 2 + c * a) * PI / 180.0;
            jj = (-c * INCVAL / 2 + c * b) * PI / 180.0;
          }
          const tempi = ii - HVAL * Math.sin(jj + Math.tan(3.0 * jj));
          const tempj = jj - HVAL * Math.sin(ii + Math.tan(3.0 * ii));
          // C: MI_WIDTH/40 and MI_HEIGHT/40 are INTEGER divisions, then (int)(.)
          x = cx + Math.trunc(Math.trunc(W / 40) * tempi);
          y = cy + Math.trunc(Math.trunc(H / 40) * tempj);
          ii = tempi;
          jj = tempj;
          break;
        }
        case OP.JONG:
          // C: oldi = i + 4*inc/centerx with INTEGER division (all ints) -- the
          // term stays 0 until 4*inc exceeds centerx, then drifts by a small int.
          oldi = (cx > 0) ? ii + Math.trunc(4 * inc / cx) : ii;
          jj = Math.sin(c * ii) - Math.cos(d * jj);
          ii = Math.sin(a * oldj) - Math.cos(b * oldi);
          x = cx + Math.trunc(cx * (ii + jj) / 4.0);
          y = cy - Math.trunc(cy * (ii - jj) / 4.0);
          break;
        case OP.SINE:   // MARTIN2
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj - Math.sin(oldi);
          x = cx + Math.trunc(ii + jj);
          y = cy - Math.trunc(ii - jj);
          break;
      }
      plot(x, y, color);
    }

    ctx.putImageData(imageData, 0, 0);
    if (++time > Math.max(1, Math.round(config.cycles))) startover();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    dot = Math.max(1, Math.round(S));   // the C bumps the dot to 3 past 2560px
    W = canvas.width;
    H = canvas.height;
    cx = (W / 2) | 0;
    cy = (H / 2) | 0;
    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    buildColors();
    startover();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag accumulator paced by config.delay (µs), with a catch-up cap so a
  // backgrounded tab doesn't fire a burst of frames on refocus.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead — see the framerate-calibration note). The
  // live hopalong measures 57.9 fps, but the port at the stock 10000 µs ran 100
  // steps/sec (1.73x fast). 10000 + 7271 = 17271 µs -> 57.9 steps/sec, matching
  // the live binary. One step() == the C's draw_hop. A calibration, not a tuning
  // knob (the slider still maps 1:1 to the xml delay).
  const OVERHEAD = 7271;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;   // xml units are microseconds
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
    reinit: init,   // fresh buffer + new attractor with the current config
    config,
    params,
  };
}
