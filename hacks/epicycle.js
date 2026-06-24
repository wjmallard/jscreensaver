// epicycle.js — epicycle packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's epicycle.c (James Youngman, 1998).
// https://www.jwz.org/xscreensaver/
//
// "A pre-heliocentric model of planetary motion." A body moves on a system of
// nested rotating circles (a deferent plus epicycles, as in Ptolemaic
// cosmology): each circle is centred on a point on the rim of its parent, so the
// body's position is the SUM of a handful of rotating vectors. As the common
// time parameter T sweeps, the body traces one long continuous curve. The
// angular speeds are integer harmonics of a fundamental (wdot = wdot_max /
// divisor), so the figure CLOSES after exactly lcm(divisors) turns of the
// fundamental — that integer period (not a float-equality test) is what tells us
// the figure is done. The screen then holds the finished figure for `holdtime`
// seconds, clears, and a fresh random figure (new radii + integer speeds) begins.
//
// Rendering: the curve is genuinely line-shaped (one XDrawLine per timestep in
// the C), so this uses canvas VECTOR ops — each paced step strokes exactly ONE
// line segment onto the persistent (double-buffered) canvas, just as the C draws
// one XDrawLine into the live window per *delay. Nothing is repainted; the screen
// is cleared only between figures. Same family / loop shape as
// hacks/xspirograph.js and hacks/helix.js (trace -> hold -> clear -> new figure,
// on a variable-delay loop).

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'epicycle';

export const info = {
  author: 'James Youngman',
  description: "A pre-heliocentric model of planetary motion.\n\nThis draws the path traced out by a point on the edge of a circle. That circle rotates around a point on the rim of another circle, and so on, several times.\n\nThe geometry of epicycles was perfected by Hipparchus of Rhodes at some time around 125 B.C., 185 years after the birth of Aristarchus of Samos, the inventor of the heliocentric universe model. Hipparchus applied epicycles to the Sun and the Moon. Ptolemy of Alexandria went on to apply them to what was then the known universe, at around 150 A.D. Copernicus went on to apply them to the heliocentric model at the beginning of the sixteenth century. Johannes Kepler discovered that the planets actually move in elliptical orbits in about 1602. The inverse-square law of gravity was suggested by Boulliau in 1645. Isaac Newton's Principia Mathematica was published in 1687, and proved that Kepler's laws derived from Newtonian gravitation.\n\nhttps://en.wikipedia.org/wiki/Deferent_and_epicycle",
  year: 1998,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/epicycle.xml and the C's resource list.
  // The UI exposes the same five controls the xml does; the rest are the C's
  // internal resources (no UI in the original) kept here so the figure geometry
  // matches the source 1:1.
  const config = {
    delay: 20000,          // µs between draw steps (--delay)
    holdtime: 2,           // seconds to hold the finished figure before erasing (--holdtime)
    linewidth: 4,          // stroke width in CSS px (--linewidth), scaled by dpr
    harmonics: 8,          // speeds are harmonics of a fundamental (--harmonics)
    ncolors: 100,          // entries in the smooth colormap (--colors)
    // Internal resources (no stock UI) — verbatim from epicycle_defaults[].
    minCircles: 2,         // fewest circles in a figure (*minCircles)
    maxCircles: 10,        // most circles in a figure (*maxCircles)
    minSpeed: 0.003,       // fundamental speed lower bound (*minSpeed)
    maxSpeed: 0.005,       // fundamental speed upper bound (*maxSpeed)
    timestep: 1.0,         // T increment per drawn segment (*timestep)
    divisorPoisson: 0.4,   // chance the divisor (speed harmonic) steps up (*divisorPoisson)
    sizeFactorMin: 1.05,   // parent/child radius ratio, low (*sizeFactorMin)
    sizeFactorMax: 2.05,   // parent/child radius ratio, high (*sizeFactorMax)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'holdtime', label: 'Linger', type: 'range', min: 1, max: 30, step: 1, default: 2, unit: ' s', lowLabel: '1 second', highLabel: '30 seconds', live: true },
    { key: 'linewidth', label: 'Line thickness', type: 'range', min: 1, max: 50, step: 1, default: 4, lowLabel: 'thin', highLabel: 'thick', live: true },
    { key: 'harmonics', label: 'Harmonics', type: 'range', min: 1, max: 20, step: 1, default: 8, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 100, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  const FULLCIRCLE = 2.0 * Math.PI;   // radians in a circle (the C's FULLCIRCLE)
  const MIN_RADIUS = 5;               // smallest allowable circle radius (CSS px, the C's MIN_RADIUS)
  const FILL_PROPORTION = 0.9;        // proportion of screen to fill by scaling (the C's FILL_PROPORTION)

  // Pace model (see epicycle.md "Timing"): the C draws ONE line segment per
  // epicycle_draw call and returns *delay (20000 µs) as the wait before the next,
  // so the pen advances at a CONSTANT rate regardless of how many segments a
  // figure has. Live -fps measured ~56 segments/sec during the draw phase
  // (delay-bound: Load 16-41%), so the per-segment work is negligible and the
  // measured ~56/s is slightly ABOVE the nominal 50/s the 20 ms delay implies --
  // XQuartz just undershoots the sleep floor. But *delay is a FLOOR: the port must
  // not run faster than the author's specified pace, so with negligible per-segment
  // work OVERHEAD is effectively 0 (the apparent negative is measurement noise,
  // within run variance, and is clamped away). Pace each step at
  // (config.delay + OVERHEAD)/1000 ms, one seg/step -> the nominal 50 seg/s.
  const OVERHEAD = 0;                 // delay-bound, one cheap segment/frame; framework cost ~= 0

  // Safety bounds the C does not need (an X11 saver runs for hours; we cap so a
  // pathological high-lcm figure can't trace for many minutes or stall precalc).
  // The live binary is uncapped; ~99.95% of figures fall under this cap.
  const MAX_DRAW_SEGS = 16000;        // never draw more than this per figure (~4.8 min at 56 seg/s)
  const MAX_PRECALC_SAMPLES = 4000;   // bounding-box samples per figure (the C steps by 1.0)
  const BLACK_PAUSE_MS = 1000;        // black screen after the erase (the C's ~1 s erase wipe)

  // frand(x) — a random double in [0, x), exactly like the C's frand().
  function frand(x) {
    return Math.random() * x;
  }

  // Euclid's GCD (always non-negative) — the C's gcd().
  function gcd(u, v) {
    if (u < 0) u = -u;
    if (v < 0) v = -v;
    while (v !== 0) {
      const r = u % v;
      u = v;
      v = r;
    }
    return u;
  }

  // Lowest common multiple of two positive ints — the C's lcm().
  function lcm(u, v) {
    return (u / gcd(u, v)) * v;
  }

  let S = 1;                 // devicePixelRatio
  let W, H;                  // canvas size, device px
  let cx, cy;                // figure centre (x_origin / y_origin)
  let unitPixels;            // min(W, H) — the C's unit_pixels
  let palette;               // ncolors smooth-colormap CSS strings (one per session)

  // Current-figure state (mirrors the C's struct fields). One body, one chain of
  // circles described by parallel arrays.
  let drawstate;             // 'NEW' | 'DRAW' | 'HOLD' | 'CLEAR'
  let nCircles;              // circles in the current figure
  let radius;                // per-circle radius (device px)
  let wdot;                  // per-circle angular speed (radians per T unit)
  let divisor;               // per-circle integer speed harmonic (signed)
  let w0;                    // shared initial_w (assign_random_common_w)
  let wdotMax;               // fundamental speed (random_wdot_max)
  let timestep;              // T increment per segment
  let xtime;                 // T value at which the figure closes (one full period)
  let totalSegs;            // segments to draw this figure (= round(xtime/timestep), capped)
  let segIndex;              // segments drawn so far this figure
  let prevX, prevY;          // previous plotted point (segment start)

  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    // The C's colour_init: ncolors <= 2 falls back to mono (white foreground, the
    // mono_p path); otherwise make_smooth_colormap builds ONE smooth colormap for
    // the whole session — 2-5 random HSV anchors, often muted/pastel, NOT a vivid
    // full-spectrum rainbow. color_step (colorIndex) then sweeps the hue along the
    // curve by indexing into it.
    if (n <= 2) {
      palette = ['#fff'];
    } else {
      palette = makeSmoothColormapRGB(n).map(([r, g, b]) => `rgb(${r},${g},${b})`);
    }
  }

  // The C's random_radius(): frand(scale) * unit_pixels/2, floored at MIN_RADIUS.
  function randomRadius(scale) {
    let r = frand(scale) * (unitPixels / 2);
    const minR = MIN_RADIUS * S;
    if (r < minR) r = minR;
    return r;
  }

  // The C's random_divisor(): start at 1, step up while a Poisson coin keeps
  // coming up heads (capped at harmonics), then a random sign.
  function randomDivisor(harmonics) {
    let d = 1;
    while (frand(1.0) < config.divisorPoisson && d <= harmonics) d++;
    const sign = (frand(1.0) < 0.5) ? 1 : -1;
    return sign * d;
  }

  // The C's new_circle_chain() + new_body(): pick n circles whose radii shrink by
  // a common factor down the chain, each with a random signed speed harmonic.
  // (Summation order is irrelevant to the body position, so we keep a flat array
  // rather than the C's linked list.)
  function buildCircles(harmonics) {
    const minC = Math.max(1, Math.round(config.minCircles));
    const maxC = Math.max(minC, Math.round(config.maxCircles));
    let n;
    if (maxC === minC) n = minC;                                  // avoid division by zero
    else n = minC + Math.floor(Math.random() * (maxC - minC));   // [minCircles, maxCircles)

    const factor = config.sizeFactorMin + frand(config.sizeFactorMax - config.sizeFactorMin);

    nCircles = n;
    radius = new Array(n);
    wdot = new Array(n);
    divisor = new Array(n);

    let scale = 1.0;
    for (let k = 0; k < n; k++) {
      radius[k] = randomRadius(scale);
      divisor[k] = randomDivisor(harmonics);
      wdot[k] = wdotMax / divisor[k];
      scale /= factor;
    }

    // assign_random_common_w(): all circles share one initial angle so the figure
    // closes cleanly (and isn't forced symmetric about the X axis).
    w0 = frand(FULLCIRCLE);
  }

  // The C's move_body(): the body position at time t is the centre plus the sum
  // of every circle's rotating radius vector.
  function bodyXY(t) {
    let x = cx;
    let y = cy;
    for (let k = 0; k < nCircles; k++) {
      const w = (w0 + t * wdot[k]) % FULLCIRCLE;   // fmod keeps the angle bounded (precision)
      x += radius[k] * Math.cos(w);
      y += radius[k] * Math.sin(w);
    }
    return [x, y];
  }

  // The C's precalculate_figure() + rescale_circles(): trace the whole period to
  // find the bounding box, then shrink the radii so the figure fills (at most)
  // FILL_PROPORTION of the screen. Like the C, it only ever reduces, never
  // enlarges. We sample at most MAX_PRECALC_SAMPLES points (the C steps by 1.0).
  function precalcAndRescale() {
    let [x, y] = bodyXY(0);
    let xMin = x, xMax = x, yMin = y, yMax = y;

    const samples = Math.min(MAX_PRECALC_SAMPLES, Math.max(1, Math.round(xtime / timestep)));
    const sstep = xtime / samples;
    for (let s = 1; s <= samples; s++) {
      [x, y] = bodyXY(s * sstep);
      if (x > xMax) xMax = x;
      if (x < xMin) xMin = x;
      if (y > yMax) yMax = y;
      if (y < yMin) yMin = y;
    }

    // rescale_circles(): work relative to the centre, take the larger absolute
    // extent on each axis, and find the scale that keeps it inside half the
    // screen, then apply the fill margin.
    const exX = Math.max(xMax - cx, -(xMin - cx));
    const exY = Math.max(yMax - cy, -(yMin - cy));
    const xm = W / 2;
    const ym = H / 2;
    const xscale = exX > xm ? xm / exX : 1.0;
    const yscale = exY > ym ? ym / exY : 1.0;
    const scale = Math.min(xscale, yscale) * FILL_PROPORTION;

    if (scale < 1.0) {
      for (let k = 0; k < nCircles; k++) radius[k] *= scale;
    }

    // The C's weird-aspect branch: on an extreme aspect ratio, enlarge to fill.
    if (W > H * 5 || H > W * 5) {
      const r = W > H ? W / H : H / W;
      for (let k = 0; k < nCircles; k++) radius[k] *= r;
    }
  }

  // The C's color_step(): the hue advances once per full turn of the fundamental
  // (fastest) epicycle. Returns a palette index for the segment ending at T.
  function colorIndex(i) {
    const n = palette.length;
    if (n <= 1) return 0;
    const phase = (i * timestep * wdotMax) / FULLCIRCLE;   // turns of the fundamental
    let f = phase % 1;
    if (f < 0) f += 1;
    let idx = Math.floor(n * f);
    if (idx >= n) idx = n - 1;
    return idx;
  }

  // Build a fresh random figure — the C's epicycle_draw() restart block, but with
  // xtime/lcm computed BEFORE the bounding-box trace (see Deviations in the .md),
  // and every per-figure variable reset so nothing leaks from the last figure.
  function newFigure() {
    const harmonics = Math.max(1, Math.round(config.harmonics));

    // random_wdot_max(): speeds run from wdot_max down to wdot_max/divisor.
    wdotMax = harmonics * (config.minSpeed + FULLCIRCLE * frand(config.maxSpeed - config.minSpeed));

    buildCircles(harmonics);

    // compute_divisor_lcm(): the figure closes after lcm(|divisor|) fundamental
    // turns, i.e. at T = lcm * 2pi / wdot_max. This integer period is the closure
    // test — never an exact float-equality on the position.
    let L = 1;
    for (let k = 0; k < nCircles; k++) L = lcm(L, Math.abs(divisor[k]));
    timestep = config.timestep;
    xtime = Math.abs(L * FULLCIRCLE / wdotMax);

    const nSeg = Math.round(xtime / timestep);
    totalSegs = Math.max(2, Math.min(nSeg, MAX_DRAW_SEGS));

    precalcAndRescale();

    // Seed the trailing point at T=0 (the C's double move_body(0)) so the first
    // segment grows from the curve's start, not from the screen centre.
    segIndex = 0;
    const [sx, sy] = bodyXY(0);
    prevX = sx;
    prevY = sy;
  }

  // Draw exactly ONE line segment of the figure, as the C's epicycle_draw does
  // one XDrawLine(old -> current) per call. Returns true once all totalSegs
  // segments are drawn (the integer-period closure). One segment per paced step
  // keeps the pen at a constant speed no matter how complex the figure is —
  // matching the live binary, which advances one segment per *delay.
  function drawSegment() {
    if (segIndex >= totalSegs) return true;
    segIndex++;
    const [nx, ny] = bodyXY(segIndex * timestep);
    ctx.lineWidth = Math.max(1, config.linewidth * S);
    ctx.strokeStyle = palette[colorIndex(segIndex)];
    ctx.beginPath();
    ctx.moveTo(prevX, prevY);
    ctx.lineTo(nx, ny);
    ctx.stroke();
    prevX = nx;
    prevY = ny;
    return segIndex >= totalSegs;
  }

  // Instant clear to black. (The C runs xscreensaver's erase_window transition
  // here — a wipe candidate for later; for now we just blank the screen.)
  function clearScreen() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // One state-machine step — the C's epicycle_draw(). Returns the ms to wait
  // before the next step.
  function step() {
    switch (drawstate) {
      case 'NEW':
        newFigure();
        drawstate = 'DRAW';
        return 0;

      case 'DRAW':
        if (drawSegment()) drawstate = 'HOLD';
        return Math.max(0, (config.delay + OVERHEAD) / 1000);

      case 'HOLD':
        // The C holds the finished figure for `holdtime` seconds, then erases.
        drawstate = 'CLEAR';
        return Math.max(1, Math.round(config.holdtime)) * 1000;

      case 'CLEAR':
        clearScreen();
        drawstate = 'NEW';
        return BLACK_PAUSE_MS;

      default:
        drawstate = 'NEW';
        return 0;
    }
  }

  // Begin a fresh sequence with the current config.
  function reset() {
    buildPalette();
    drawstate = 'NEW';
    clearScreen();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    cx = W / 2;
    cy = H / 2;
    unitPixels = Math.min(W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    nextDelay = 0;
    reset();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Variable-delay loop (boxfit/xspirograph/helix-style): step() returns the ms
  // to wait before the next step — config.delay while drawing, the longer hold /
  // black pauses at a phase change — matching the C's "return microseconds until
  // next call". The canvas persists between steps (segments accumulate), so there
  // is no per-frame repaint; drawing happens inside step().
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let acc = 0;
  let nextDelay = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    acc += now - lastTime;
    lastTime = now;
    // Bound the backlog so a backgrounded tab doesn't burst on refocus — but
    // never below nextDelay, or a long hold/black pause would never elapse.
    acc = Math.min(acc, nextDelay + 1000);

    let steps = 0;
    while (acc >= nextDelay && steps < MAX_CATCHUP_STEPS) {
      acc -= nextDelay;
      nextDelay = step();
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
    reinit() { nextDelay = 0; reset(); },   // fresh sequence with the current config
    config,
    params,
  };
}
