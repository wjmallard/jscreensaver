// lissie.js — lissie packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver/xlockmore's lissie.c (Alexander Jolk, 1996).
// https://www.jwz.org/xscreensaver/
//
// "The Lissajous worm." Each worm is a point sweeping a Lissajous figure
//   x = xi + rx*sin(tx),   y = yi + ry*sin(ty)
// where tx/ty advance by per-axis speeds dtx/dty that random-walk +/-1% each
// step (clamped to [0.01, 0.15] rad), so the figure slowly precesses and
// morphs instead of retracing one fixed curve. The worm leaves a FINITE trail:
// a ring buffer of the last `len` points, each drawn as a small circle outline
// in a colour from a smooth colormap (SMOOTH_COLORS) that advances one step per
// head, so the tail is a colour-cycling tube. Every `cycles` frames
// the whole screen reseeds with fresh worms.
//
// Rendering: sparse vector ops. The C draws one circle (XDrawArc) per worm per
// step and erases the oldest tail circle in SOLID BLACK (not XOR). Rather than
// erase incrementally on a persistent canvas — which leaves anti-aliased ghost
// rings, since canvas strokes are AA'd and the C explicitly disables AA — this
// port keeps the ring buffer but repaints each frame: clear to black, redraw
// each worm's live tail window. The visible result (a finite worm on black) is
// identical and ghost-free. See the .md for the deviation.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'lissie';

export const info = {
  author: 'Alexander Jolk',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nLissajous loops. This one draws the progress of circular shapes along a path.\n\nhttps://en.wikipedia.org/wiki/Lissajous_curve',
  year: 1996,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/lissie.xml (1:1 with the original).
  const config = {
    delay: 10000,    // microseconds between steps (--delay); stock lissie.c DEFAULTS
    cycles: 20000,   // frames before the screen reseeds (--cycles)
    count: 1,        // number of worms (--count)
    size: -200,      // circle size; <0 = random up to |size|, 0 = auto, >0 = fixed (--size)
    ncolors: 200,    // size of the hue cycle (--ncolors)
  };

  // Ranges/defaults/labels transcribed from hacks/config/lissie.xml.
  // live: true  -> the loop reads config every step (applies instantly).
  // live: false -> the value sizes worms/colors, so a change re-runs init().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cycles', label: 'Timeout', type: 'range', min: 1000, max: 80000, step: 1000, default: 20000, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'count', label: 'Worms', type: 'range', min: 1, max: 20, step: 1, default: 1, lowLabel: 'one', highLabel: 'many', live: false },
    { key: 'size', label: 'Size', type: 'range', min: -500, max: 500, step: 10, default: -200, lowLabel: 'small / random', highLabel: 'large', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // Constants from the C (#defines).
  const MAXLISSIELEN = 100;   // ring-buffer size
  const MINLISSIELEN = 10;    // shortest tail
  const MINSIZE = 1;          // smallest circle diameter
  const MINDT = 0.01;         // slowest per-axis angular speed (rad/step)
  const MAXDT = 0.15;         // fastest per-axis angular speed (rad/step)
  const TWO_PI = Math.PI * 2;

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let palette;        // ncolors smooth-colormap CSS strings (SMOOTH_COLORS)
  let worms;          // active worms
  let loopcount;      // frames since last reseed (the C's lp->loopcount)
  let dot, dotHalf;   // device-px footprint for the ri<2 "point" case

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // FLOATRAND(min,max) — uniform real in [min, max).
  function frand(min, max) {
    return min + Math.random() * (max - min);
  }

  // INTRAND(min,max) — uniform integer in [min, max] (the C's min + NRAND(max-min+1)).
  function irand(min, max) {
    const lo = Math.floor(min);
    const hi = Math.floor(max);
    if (hi < lo) return lo;   // guard a degenerate (tiny-canvas) range
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    // lissie.c is SMOOTH_COLORS -> make_smooth_colormap: 2-5 random HSV anchors
    // interpolated into a closed loop, usually muted/pastel and re-rolled each run
    // -- not the fixed max-vivid hsl() the first port used. The worm's colour index
    // advances one step per head, so the visible len-point tail is a narrow slice of
    // the loop (often near one hue, drifting slowly), as in the live binary.
    // ncolors <= 2 -> white (the C's MI_NPIXELS<=2 / MI_WHITE_PIXEL mono path).
    if (n <= 2) {
      palette = new Array(n).fill('#fff');
      return;
    }
    palette = makeSmoothColormapRGB(n).map(([r, g, b]) => `rgb(${r},${g},${b})`);
  }

  // Build one worm — the C's initlissie(). Geometry is in device px (W/H are the
  // device-px backing store), and the size cap is scaled by S so circles keep
  // their logical size on retina.
  function makeWorm() {
    const minWH4 = Math.max(MINSIZE, Math.min(W, H) / 4);   // MAX(MINSIZE, MIN(w,h)/4)
    const sz = Math.round(config.size * S);                 // size cap, dpr-scaled

    let ri;
    if (sz < -MINSIZE) {
      ri = irand(MINSIZE, Math.min(-sz, minWH4));   // random up to |size|
    } else if (sz < MINSIZE) {
      ri = (sz === 0) ? minWH4 : MINSIZE;           // 0 = auto, -1 = min
    } else {
      ri = Math.min(sz, minWH4);                    // fixed
    }
    ri = Math.round(ri);

    const xi = irand(W / 4 + ri, W * 3 / 4 - ri);
    const yi = irand(H / 4 + ri, H * 3 / 4 - ri);
    const rx = irand(W / 4, Math.min(W - xi, xi)) - 2 * ri;
    const ry = irand(H / 4, Math.min(H - yi, yi)) - 2 * ri;

    return {
      tx: frand(0, TWO_PI),
      ty: frand(0, TWO_PI),
      dtx: frand(MINDT, MAXDT),
      dty: frand(MINDT, MAXDT),
      xi,
      yi,
      rx,
      ry,
      ri,
      len: irand(MINLISSIELEN, MAXLISSIELEN - 1),
      pos: 0,
      color: Math.floor(Math.random() * palette.length),
      lx: new Float32Array(MAXLISSIELEN),   // ring buffer x (0 = unset sentinel)
      ly: new Float32Array(MAXLISSIELEN),   // ring buffer y
      lc: new Int16Array(MAXLISSIELEN),     // ring buffer colour index
    };
  }

  // Advance one worm by a single step — the state half of the C's drawlissie()
  // (time/speed update + new head point). Drawing is deferred to render().
  function advance(w) {
    w.pos++;
    const p = w.pos % MAXLISSIELEN;

    // Let time go by; wrap each axis once past 2*PI (dt < 2*PI, so one subtract).
    w.tx += w.dtx;
    w.ty += w.dty;
    if (w.tx > TWO_PI) w.tx -= TWO_PI;
    if (w.ty > TWO_PI) w.ty -= TWO_PI;

    // Vary both speeds by max. 1%, clamped.
    w.dtx = clamp(w.dtx * frand(0.99, 1.01), MINDT, MAXDT);
    w.dty = clamp(w.dty * frand(0.99, 1.01), MINDT, MAXDT);

    w.lx[p] = w.xi + Math.sin(w.tx) * w.rx;
    w.ly[p] = w.yi + Math.sin(w.ty) * w.ry;

    // Drawn with the current colour, then advance the cycle (the C's post-inc).
    w.lc[p] = w.color;
    w.color++;
    if (w.color >= palette.length) w.color = 0;
  }

  // Repaint the whole screen: black, then each worm's live tail window (the last
  // `len` ring-buffer entries). The bounds test mirrors the C's Lissie() macro,
  // so unset (0,0) slots during warm-up and any off-screen point are skipped.
  function render() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    for (const w of worms) {
      const rad = w.ri / 2;
      const point = w.ri < 2;
      for (let j = 0; j < w.len; j++) {
        const idx = ((w.pos - j) % MAXLISSIELEN + MAXLISSIELEN) % MAXLISSIELEN;
        const x = w.lx[idx];
        const y = w.ly[idx];
        if (x > 0 && y > 0 && x <= W && y <= H) {
          const col = palette[w.lc[idx]];
          if (point) {
            ctx.fillStyle = col;
            ctx.fillRect(x - dotHalf, y - dotHalf, dot, dot);
          } else {
            ctx.strokeStyle = col;
            ctx.beginPath();
            ctx.arc(x, y, rad, 0, TWO_PI);
            ctx.stroke();
          }
        }
      }
    }
  }

  // Reseed the whole screen with fresh worms — the C's init_lissie(). Each worm
  // is pre-rolled `len` steps so its tail is already full on the first frame
  // (the C grows the worm in over ~len frames; we skip that warm-up).
  function seedAll() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    loopcount = 0;
    const n = Math.max(1, Math.round(config.count));
    worms = [];
    for (let i = 0; i < n; i++) {
      const w = makeWorm();
      for (let k = 0; k < w.len; k++) advance(w);
      worms.push(w);
    }
  }

  // One frame of simulation — the C's draw_lissie(): reseed past the timeout,
  // else advance every worm. Rendering happens once per rAF frame in frame().
  function step() {
    loopcount++;
    if (loopcount > config.cycles) {
      seedAll();   // resets loopcount to 0
      return;
    }
    for (const w of worms) advance(w);
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    ctx.lineWidth = Math.max(1, Math.round(S));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    dot = Math.max(1, Math.round(S));
    dotHalf = dot / 2;
    buildPalette();
    seedAll();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Fixed-timestep rAF loop (squiral/lisa-style): one step() per (delay + OVERHEAD),
  // banking leftover time so the speed is the same at any refresh rate. Cap catch-up
  // so a backgrounded tab can't burst. render() runs once per displayed frame.
  //
  // OVERHEAD: the live binary's *delay (10000) is a sleep floor; its real per-frame
  // cost is higher. Measured live lissie = ~55.5 fps (Load ~45%, delay-bound), i.e. a
  // ~18000 us period, so OVERHEAD = 1e6/55.5 - 10000 = 8000 us. Adding it to the step
  // delay makes the worm sweep/precess at the original's pace while config.delay still
  // maps 1:1 to the stock resource. See framerate-calibration.
  const OVERHEAD = 8000;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // (config.delay + OVERHEAD) is microseconds (xml units); rAF clock is milliseconds.
    const delayMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    render();
    rafId = requestAnimationFrame(frame);
  }

  // Rebuild after a non-live config change (count/size/colors): clear + re-seed.
  function reinit() {
    ctx.fillStyle = '#000';
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
    reinit,   // fresh screen with the current config
    config,   // host renders the config box from these
    params,
  };
}
