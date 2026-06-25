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
// colour per frame, advancing through the hue cycle so the whole image is a
// smooth rainbow. After `cycles` frames the image clears and a fresh attractor
// (new random formula + parameters) begins.
//
// Rendering: point plotting, thousands per frame, so the BLIT path — accumulate
// into a persistent Uint32 ImageData buffer and putImageData once per frame
// (like sierpinski / binaryring), not per-point fillRect.

export const title = 'hopalong';

export const info = {
  author: 'Patrick Naughton',
  description: 'Lacy fractal patterns based on iteration in the imaginary plane, from a 1986 Scientific American article.',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/hopalong.xml.
  //   count   — points plotted per frame. The colour only advances once per
  //             frame, so more points per frame = fewer colour changes per
  //             point: the xml labels this "Color contrast" for that reason.
  //   cycles  — frames before the image clears and a new attractor begins.
  //   ncolors — size of the hue cycle.
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
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: false },
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

  const BLACK = 0xFF000000;
  const PI = Math.PI;

  let W, H, S, cx, cy, dot;
  let imageData, pixels;
  let colorsU;                 // ncolors packed-RGBA rainbow entries
  let op, a, b, c, d, ii, jj;  // attractor state (i/j renamed ii/jj)
  let inc, pix, time;

  const rnd = Math.random;            // [0,1)
  const signed = () => rnd() * 2 - 1; // [-1,1)

  // HSL (h deg, s/l in [0,1]) -> little-endian 0xAABBGGRR, matching ImageData.
  function hslToUint(h, s, l) {
    const k = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = k * (1 - Math.abs(hp % 2 - 1));
    let r = 0, g = 0, bl = 0;
    if (hp < 1)      { r = k; g = x; }
    else if (hp < 2) { r = x; g = k; }
    else if (hp < 3) { g = k; bl = x; }
    else if (hp < 4) { g = x; bl = k; }
    else if (hp < 5) { r = x; bl = k; }
    else             { r = k; bl = x; }
    const m = l - k / 2;
    const R = Math.round((r + m) * 255);
    const G = Math.round((g + m) * 255);
    const B = Math.round((bl + m) * 255);
    return ((255 << 24) | (B << 16) | (G << 8) | R) >>> 0;
  }

  function buildColors() {
    const n = Math.max(1, Math.round(config.ncolors));
    colorsU = new Array(n);
    for (let i = 0; i < n; i++) colorsU[i] = hslToUint((i * 360 / n) % 360, 1, 0.55);
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

  // Pick a new attractor (formula + parameters) and clear the buffer.
  // Faithful to init_hop(): `range` sets the parameter scale, `inc` a random
  // integer offset. `inc` and `range` are scaled by dpr so the figure keeps its
  // proportions on retina (the C leaves the math in raw pixels and only bumps
  // the dot size). The map state i/j is already in screen-pixel units.
  function startover() {
    op = config.formula === 'random'
      ? OPS[(rnd() * OPS.length) | 0]
      : FORMULA_OP[config.formula];

    // range = sqrt(cx^2 + cy^2) / (1 + rand[0,1))  -> divisor in [1, 2)
    const range = Math.sqrt(cx * cx + cy * cy) / (1.0 + rnd());
    ii = 0.0;
    jj = 0.0;
    inc = ((rnd() * 200) | 0) - 100;   // [-100, 100), scaled into pixel space below
    inc *= S;

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
        inc = 100;   // the C overrides inc here (no dpr scaling — popcorn is unit-free)
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
          x = cx + (ii + jj);
          y = cy - (ii - jj);
          break;
        case OP.EJK1:
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj - ((ii > 0) ? (b * oldi - c) : -(b * oldi - c));
          x = cx + (ii + jj);
          y = cy - (ii - jj);
          break;
        case OP.EJK2:
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj - ((ii < 0) ? Math.log(Math.abs(b * oldi - c))
                                : -Math.log(Math.abs(b * oldi - c)));
          x = cx + (ii + jj);
          y = cy - (ii - jj);
          break;
        case OP.EJK3:
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj - ((ii > 0) ? Math.sin(b * oldi) - c : -Math.sin(b * oldi) - c);
          x = cx + (ii + jj);
          y = cy - (ii - jj);
          break;
        case OP.EJK4:
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj - ((ii > 0) ? Math.sin(b * oldi) - c
                                : -Math.sqrt(Math.abs(b * oldi - c)));
          x = cx + (ii + jj);
          y = cy - (ii - jj);
          break;
        case OP.EJK5:
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj - ((ii > 0) ? Math.sin(b * oldi) - c : -(b * oldi - c));
          x = cx + (ii + jj);
          y = cy - (ii - jj);
          break;
        case OP.EJK6:
          oldi = ii + inc;
          jj = a - ii;
          // C: asin((b*oldi) - (long)(b*oldi)) — fractional part via trunc.
          ii = oldj - Math.asin((b * oldi) - Math.trunc(b * oldi));
          x = cx + (ii + jj);
          y = cy - (ii - jj);
          break;
        case OP.RR:   // RR1
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj - ((ii < 0) ? -Math.pow(Math.abs(b * oldi - c), d)
                                : Math.pow(Math.abs(b * oldi - c), d));
          x = cx + (ii + jj);
          y = cy - (ii - jj);
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
          x = cx + (W / 40 * tempi);
          y = cy + (H / 40 * tempj);
          ii = tempi;
          jj = tempj;
          break;
        }
        case OP.JONG:
          oldi = (cx > 0) ? ii + 4 * inc / cx : ii;
          jj = Math.sin(c * ii) - Math.cos(d * jj);
          ii = Math.sin(a * oldj) - Math.cos(b * oldi);
          x = cx + (cx * (ii + jj) / 4.0);
          y = cy - (cy * (ii - jj) / 4.0);
          break;
        case OP.SINE:   // MARTIN2
          oldi = ii + inc;
          jj = a - ii;
          ii = oldj - Math.sin(oldi);
          x = cx + (ii + jj);
          y = cy - (ii - jj);
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
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = config.delay / 1000;   // xml units are microseconds
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
