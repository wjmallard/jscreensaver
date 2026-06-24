// discrete.js — discrete packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's discrete.c (Tim Auckland, 1996, adapted from hop.c by
// Patrick J. Naughton). https://www.jwz.org/xscreensaver/
//
// "discrete" plots a family of strange attractors based on the "discrete map"
// type of dynamical system. Each run picks one map at random (weighted by a
// fixed bias table) — a Hopalong/sqrt variant, the chaotic "Standard Map", the
// "Bird in a Thornbush", an inverse Julia-set iteration (AILUJ), plus Trig,
// Cubic and Henon maps — seeds it with random coefficients, then iterates the
// map thousands of times, plotting one tiny point per iteration. Points
// accumulate into a persistent image, the plot colour stepping once per inner
// frame through a make_smooth_colormap palette (random, often muted — not a
// vivid rainbow); after `cycles` frames the screen clears and a fresh map begins.
//
// Rendering: tens of thousands of points accumulate per frame, so this uses the
// BLIT path — a persistent Uint32 ImageData buffer that we write pixels into and
// putImageData once per frame, like hopalong / thornbird (its sibling, which is
// the BIRDIE map of this very hack pulled out into its own screenhack).
// See [[hopalong]] and [[thornbird]].

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'discrete';

export const info = {
  author: 'Tim Auckland',
  description: 'Discrete map fractal systems, including variants of Hopalong, Julia, and others.',
  year: 1996,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/discrete.xml so the config box maps
  // 1:1 to the original. (`count` isn't in the stock discrete UI — it hardcodes
  // 4096 via the DEFAULTS resource — but we expose it as "Points" for parity
  // with the other attractor ports and to let slower machines dial it down.)
  const config = {
    delay: 20000,   // microseconds between frames (--delay; xml/C stock 20000)
    cycles: 2500,   // frames before the screen clears + a new map begins (--cycles)
    count: 4096,    // points plotted per inner frame (DEFAULTS *count, "Points")
    ncolors: 100,   // size of the make_smooth_colormap palette (--ncolors)
  };

  // live: true  -> the loop reads config[key] every frame, applies instantly.
  // live: false -> the value sizes the palette, so a change re-runs init().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cycles', label: 'Timeout', type: 'range', min: 100, max: 10000, step: 100, default: 2500, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'count', label: 'Points', type: 'range', min: 512, max: 8192, step: 256, default: 4096, lowLabel: 'few', highLabel: 'many', live: true },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 100, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // The map types. Only these seven are reachable: the C enum also defines
  // HSHOE and DELOG but the bias[] table never selects them, so we omit their
  // (dead) cases. The bias table weights how often each map is picked.
  const BIAS = [
    'STANDARD', 'STANDARD', 'STANDARD', 'STANDARD',
    'SQRT', 'SQRT', 'SQRT', 'SQRT',
    'BIRDIE', 'BIRDIE', 'BIRDIE',
    'AILUJ', 'AILUJ', 'AILUJ',
    'TRIG', 'TRIG',
    'CUBIC',
    'HENON',
  ];

  // draw_discrete() runs draw_discrete_1() this many times per displayed frame
  // (the C's `for (i = 0; i < 10; i++)`); we keep it so the pace, the per-frame
  // reseed of the SQRT/STANDARD "comb", and the cycles-timeout all match the C.
  const INNER = 10;

  const BLACK = 0xFF000000;
  const PI = Math.PI;
  const rnd = Math.random;                 // [0, 1)
  const balance = () => rnd() * 2 - 1;     // [-1, 1), matches (LRAND/MAXRAND)*2-1

  let W, H, S, cx, cy, dot;     // canvas size (device px), dpr, centre, point size
  let imageData, pixels;        // persistent Uint32 accumulation buffer
  let palette;                  // ncolors packed-ABGR smooth-colormap values

  // Discrete-map state (names mirror the C struct).
  let op;                       // current map type
  let a, b, c;                  // map coefficients (b mutates in BIRDIE)
  let i, j;                     // current iterate
  let ic, jc, iscale, jscale;   // centre offset + scale, attractor-units -> pixels
  let inc;                      // step counter (drives the SQRT/STANDARD comb)
  let pix;                      // current palette index
  let frameCount;              // inner frames since this map began (vs. cycles)
  let sqrtSign, stdSign;       // toggles for the per-frame reseed of SQRT/STANDARD

  // Build the colour table once per init via make_smooth_colormap (utils/colors.c,
  // ported faithfully in colormap.js). The C compiles discrete with SMOOTH_COLORS,
  // so the xlockmore wrapper builds ONE random smooth colormap at startup
  // (2-5 HSV anchors, min-separation + min-avg-sat/val retries — frequently
  // muted/pastel, NOT a vivid rainbow) and never rebuilds it for the session. We
  // mirror that: built here in init(), NOT in newAttractor(), so every map in a
  // session shares the same palette exactly as the C does; draw_discrete_1 only
  // walks the index through it. Pack each [r,g,b] (0..255) into the little-endian
  // 0xAABBGGRR Uint32 the blit path expects.
  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    palette = new Uint32Array(n);
    const map = makeSmoothColormapRGB(n);
    for (let p = 0; p < n; p++) {
      const [r, g, b] = map[p];
      palette[p] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
  }

  // Plot a dot-sized square (dot scales with dpr) at integer (x, y). Points that
  // fall off-screen are skipped, which is exactly what X11 does to them (clip).
  function plot(x, y, color) {
    for (let oy = 0; oy < dot; oy++) {
      const yy = y + oy;
      if (yy < 0 || yy >= H) continue;
      const row = yy * W;
      for (let ox = 0; ox < dot; ox++) {
        const xx = x + ox;
        if (xx >= 0 && xx < W) pixels[row + xx] = color;
      }
    }
  }

  // init_discrete(): pick a new map, seed its coefficients + iterate, clear the
  // buffer, reset the counters. (Called at start and on a cycles timeout.) All
  // geometry is in device pixels (maxx == W, maxy == H), so the figure fills the
  // device-res canvas directly, like hopalong.
  function newAttractor() {
    const maxx = W, maxy = H;
    op = BIAS[(rnd() * BIAS.length) | 0];

    a = b = c = 0;
    ic = jc = 0;
    iscale = jscale = 1;

    switch (op) {
      case 'HENON':
        jc = balance() * 0.4;
        ic = 1.3 * (1 - (jc * jc) / (0.4 * 0.4));
        iscale = maxx;
        jscale = maxy * 1.5;
        a = 1;
        b = 1.4;
        c = 0.3;
        i = j = 0;
        break;
      case 'SQRT': {
        ic = 0;
        jc = 0;
        iscale = 1;
        jscale = 1;
        // range = 2*diagonal / [10, 19]; sets the coefficient spread in pixels.
        const range = Math.sqrt(maxx * 2 * maxx * 2 + maxy * 2 * maxy * 2) / (10 + ((rnd() * 10) | 0));
        a = rnd() * range - range / 2;
        b = rnd() * range - range / 2;
        c = rnd() * range - range / 2;
        if (((rnd() * 2) | 0) === 0) c = 0;
        i = j = 0;
        break;
      }
      case 'STANDARD':
        ic = PI;
        jc = PI;
        iscale = maxx / (PI * 2);
        jscale = maxy / (PI * 2);
        a = 0;             // decay (always 0 here -> the area-preserving map)
        b = rnd() * 2;     // kick strength
        c = 0;
        i = PI;
        j = PI;
        break;
      case 'BIRDIE':
        ic = 0;
        jc = 0;
        iscale = maxx / 2;
        jscale = maxy / 2;
        a = 1.99 + balance() * 0.2;
        b = 0;
        c = 0.8 + balance() * 0.1;
        i = j = 0;
        break;
      case 'TRIG':
        a = 5;
        b = 0.5 + balance() * 0.3;
        ic = a;
        jc = 0;
        iscale = maxx / (b * 20);
        jscale = maxy / (b * 20);
        i = j = 0;
        break;
      case 'CUBIC':
        a = 2.77;
        b = 0.1 + balance() * 0.1;
        ic = 0;
        jc = 0;
        iscale = maxx / 4;
        jscale = maxy / 4;
        i = j = 0.1;
        break;
      case 'AILUJ': {
        // Inverse Julia iteration. Pick (a, b) whose forward 'Brot orbit does
        // NOT escape in 10 iters, i.e. a connected Julia set (matches the C
        // do/while). jscale uses maxx (not maxy) — verbatim C quirk.
        ic = 0;
        jc = 0;
        iscale = maxx / 4;
        jscale = maxx / 4;
        let it, x, y, xn, yn;
        do {
          a = balance() * 1.5 - 0.5;
          b = balance() * 1.5;
          x = y = 0;
          for (it = 0; it < 10 && x * x + y * y < 13; it++) {
            xn = x * x - y * y + a;
            yn = 2 * x * y + b;
            x = xn;
            y = yn;
          }
        } while (it < 10);
        i = j = 0.1;
        break;
      }
    }

    pix = 0;
    inc = 0;
    frameCount = 0;
    sqrtSign = true;
    stdSign = true;

    pixels.fill(BLACK);
  }

  // draw_discrete_1(): advance colour + inc, then iterate the map `count` times,
  // plotting each point. The C has NO divergence guard / early reset; a non-finite
  // or far-off-screen coordinate is simply skipped by plot() (X11 clips it the
  // same way), so a (rare) escaping orbit just stops drawing until the cycles
  // timeout reseeds. In practice none of the seeded maps go non-finite.
  function mapStep() {
    inc++;

    let color;
    if (palette.length > 2) {
      color = palette[pix];
      if (++pix >= palette.length) pix = 0;
    } else {
      color = 0xFFFFFFFF;   // white, matching the C's MI_WHITE_PIXEL fallback
    }

    const count = Math.max(1, Math.round(config.count));
    const cycles = Math.max(2, Math.round(config.cycles));

    let k = count;
    while (k--) {
      const oldj = j;
      const oldi = i;

      switch (op) {
        case 'HENON':
          i = oldj + a - b * oldi * oldi;
          j = c * oldi;
          break;
        case 'SQRT':
          if (k) {
            // j uses the still-current i (== oldi); then i is recomputed.
            j = a + i;
            i = -oldj + (i < 0
              ? Math.sqrt(Math.abs(b * (i - c)))
              : -Math.sqrt(Math.abs(b * (i - c))));
          } else {
            // Last point of the frame: reseed a fresh strand whose start
            // marches across the screen as inc grows (the comb). Integer
            // division per the C (Math.trunc, never >> which overflows 2^31).
            i = (sqrtSign ? 1 : -1) * Math.trunc(Math.trunc(inc * W / cycles) / 2);
            j = a + i;
            sqrtSign = !sqrtSign;
          }
          break;
        case 'STANDARD':
          if (k) {
            j = (1 - a) * oldj + b * Math.sin(oldi) + a * c;
            j = (j + 2 * PI) % (2 * PI);
            i = oldi + j;
            i = (i + 2 * PI) % (2 * PI);
          } else {
            j = PI + ((stdSign ? 1 : -1) * inc * 2 * PI / (cycles - 0.5)) % PI;
            i = PI;
            stdSign = !stdSign;
          }
          break;
        case 'BIRDIE':
          j = oldi;
          i = (1 - c) * Math.cos(PI * a * oldj) + c * b;
          b = oldj;
          break;
        case 'TRIG': {
          const r2 = oldi * oldi + oldj * oldj;
          i = a + b * (oldi * Math.cos(r2) - oldj * Math.sin(r2));
          j = b * (oldj * Math.cos(r2) + oldi * Math.sin(r2));
          break;
        }
        case 'CUBIC':
          i = oldj;
          j = a * oldj - oldj * oldj * oldj - b * oldi;
          break;
        case 'AILUJ':
          i = ((rnd() < 0.5) ? -1 : 1) *
            Math.sqrt(((oldi - a) +
              Math.sqrt((oldi - a) * (oldi - a) + (oldj - b) * (oldj - b))) / 2);
          if (i < 1e-8 && i > -1e-8) i = (i > 0) ? 1e-8 : -1e-8;
          j = (oldj - b) / (2 * i);
          break;
      }

      // attractor units -> screen pixels (C: (int) truncation toward zero).
      // Non-finite / off-screen (x, y) are skipped inside plot(), matching X11 clip.
      const x = cx + Math.trunc((i - ic) * iscale);
      const y = cy - Math.trunc((j - jc) * jscale);
      plot(x, y, color);
    }
  }

  // draw_discrete(): run INNER inner frames, then reseed on the cycles timeout
  // (the C's `if (hp->count > cycles) init_discrete()`), else blit the buffer.
  function step() {
    for (let f = 0; f < INNER; f++) {
      mapStep();
      frameCount++;
    }

    if (frameCount > Math.max(2, Math.round(config.cycles))) {
      newAttractor();   // clears the buffer + picks a fresh map
    }

    ctx.putImageData(imageData, 0, 0);
  }

  function init() {
    S = window.devicePixelRatio || 1;
    dot = Math.max(1, Math.round(S));   // bump point size on retina so dots show
    W = canvas.width;
    H = canvas.height;
    cx = (W / 2) | 0;
    cy = (H / 2) | 0;

    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);

    buildPalette();
    newAttractor();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag accumulator paced by config.delay (microseconds): run one step()
  // per delay, banking leftover time so the pace is identical at any refresh
  // rate. Cap catch-up so a backgrounded tab doesn't burst on refocus.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead — see the framerate-calibration note). The
  // live discrete measures 37.2 fps, but the port at the stock 20000 µs ran 50
  // steps/sec (1.34x fast). 20000 + 6882 = 26882 µs -> 37.2 steps/sec, matching
  // the live binary (and replacing the old by-eye 50000 default). One step() ==
  // the C's draw_discrete (INNER=10 inner frames). A calibration, not a tuning
  // knob (the slider still maps 1:1 to the xml delay).
  const OVERHEAD = 6882;
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

  // Re-seed with the current config (rebuilds the palette + picks a fresh map).
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
    resume() { if (!rafId) { lastTime = 0; rafId = requestAnimationFrame(frame); } },
    reinit,
    config,
    params,
  };
}
