// julia.js — julia packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Faithful port of xscreensaver's julia.c by Sean McCullough (1995/1997) —
// "continuously varying Julia set". https://www.jwz.org/xscreensaver/
//
// This is NOT an escape-time fractal renderer. Like the C, it draws the Julia
// set by RANDOM INVERSE ITERATION: for the current complex parameter c, the two
// inverse branches of z -> z^2 + c are  w = +/- sqrt(z - c).  Starting from the
// origin, a 64-step random walk down those branches (the C's `while (k--)` loop)
// lands a seed on the set, then a deterministic depth-`d` binary tree of both
// branches (`apply()`) enumerates 2^(d+1)-1 points covering the set. Each point
// is drawn as a tiny filled rectangle (the C's XFillRectangles).
//
// The parameter c is walked along a Lissajous orbit each frame (the C's incr()),
// so the set continuously morphs; a small white ring marks the current c. The
// last `cycles+1` frames are kept in a ring of point buffers and the oldest is
// erased (black-filled) as a new one is drawn, leaving a colour-cycling trail of
// recent sets — the characteristic julia look. See julia.md.

import { makeUniformColormapRGB } from './colormap.js';

export const title = 'julia';

export const info = {
  author: 'Sean McCullough',
  description: 'The Julia set is a close relative of the Mandelbrot set. The small moving dot indicates the control point from which the rest of the image was generated.\n\nSee also the "Discrete" screen saver.\n\nhttps://en.wikipedia.org/wiki/Julia_set',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/julia.xml exactly. delay is microseconds.
  //   count  -> search-tree DEPTH = min(count, 10) (numpoints = 2^(depth+1)-1).
  //             the xml slider floors at 10, so depth is effectively always 10,
  //             as in the C; the knob is kept for fidelity to the original UI.
  //   cycles -> trail length: the set is kept for `cycles+1` frames (nbuffers).
  //   ncolors-> size of the uniform-hue palette cycled one entry per frame.
  const config = {
    delay: 10000,    // microseconds between frames (--delay)
    count: 1000,     // --count: tree depth, clamped to 10 (see above)
    cycles: 20,      // --cycles ("Iterations"): trail length; nbuffers = cycles+1
    ncolors: 200,    // --ncolors: uniform-hue palette size (<=2 => white)
  };

  // live: true  -> read every step, applies instantly.
  // live: false -> sizes a buffer/palette, so a change re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Count', type: 'range', min: 10, max: 20000, step: 10, default: 1000, lowLabel: 'few', highLabel: 'lots', live: false },
    { key: 'cycles', label: 'Iterations', type: 'range', min: 1, max: 100, step: 1, default: 20, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // delay is a sleep FLOOR in the C; the effective frame time also carries the
  // per-frame compute. OVERHEAD (us) is added to delay to match the live binary's
  // measured pace. Live julia (820x560, -fps) ran 56.8 fps at Load 43.2% (sleep
  // slice 10000us == stock delay, a clean reading): OVERHEAD = round(1e6/56.8) -
  // 10000 = 7606. See julia.md "Timing" and [[framerate-calibration]].
  const OVERHEAD = 7606;

  let W, H, S;             // canvas size (device px) and devicePixelRatio
  let centerx, centery;    // screen centre (W/2, H/2)
  let depth, numpoints;    // tree depth and 2^(depth+1)-1 points per frame
  let nbuffers;            // ring length = cycles + 1
  let scale;               // point size in px (1, or 3 on a retina-scale canvas)
  let circsize;            // diameter of the c-parameter marker ring

  let buffers;             // Array(nbuffers) of Int32Array(numpoints*2), [x,y] pairs
  let curBuf;              // buffers[buffer] during apply()
  let itree;               // write cursor into curBuf during apply()
  let buffer;              // current ring index
  let erase;               // once the ring has wrapped, erase the oldest before reuse

  let palette;             // Array(ncolors) of css colour strings, or null => white
  let ncolors;             // captured palette size
  let pix;                 // current palette index (advances one per frame)
  let inc;                 // orbit phase; advances by 1 each frame (the C's jp->inc)
  let cr, ci;              // current c parameter
  let prevCircle;          // last drawn marker-ring centre, for the black erase disc

  // A uniform-hue palette (the C's UNIFORM_COLORS); <=2 colours => mono white,
  // matching the C's `MI_NPIXELS(mi) > 2 ? MI_PIXEL : WHITE` branch.
  function buildPalette() {
    ncolors = Math.max(1, Math.min(255, Math.round(config.ncolors)));
    if (ncolors <= 2) { palette = null; return; }
    palette = makeUniformColormapRGB(ncolors).map(([r, g, b]) => `rgb(${r},${g},${b})`);
  }

  // The C's incr(): walk c on its Lissajous orbit. Ported verbatim (no scaling
  // or clamping — the original visits dust-like sets too, which is the point).
  function incr() {
    cr = 1.5 * (Math.sin(Math.PI * (inc / 290.0)) * Math.sin(inc * Math.PI / 210.0));
    ci = 1.5 * (Math.cos(Math.PI * (inc / 310.0)) * Math.cos(inc * Math.PI / 190.0));
    cr += 0.5 * Math.cos(Math.PI * inc / 395.0);
    ci += 0.5 * Math.sin(Math.PI * inc / 410.0);
  }

  // The C's apply(): write this node's screen point, then recurse on both inverse
  // branches to depth d. Fills curBuf[0..numpoints-1] when called with itree = 0.
  function apply(xr, xi, d) {
    const i = itree * 2;
    curBuf[i]     = (0.5 * xr * centerx + centerx) | 0;
    curBuf[i + 1] = (0.5 * xi * centery + centery) | 0;
    itree++;
    if (d > 0) {
      xi -= ci;
      xr -= cr;
      const theta = (xi === 0 && xr === 0) ? 0 : Math.atan2(xi, xr) / 2;
      const r = Math.sqrt(Math.sqrt(xi * xi + xr * xr));   // |z|^0.25
      const nxr = r * Math.cos(theta);
      const nxi = r * Math.sin(theta);
      d--;
      apply(nxr, nxi, d);
      apply(-nxr, -nxi, d);
    }
  }

  // Fill all numpoints of a buffer as scale x scale rects in one Path2D pass
  // (the C's XFillRectangles); used both to draw (in colour) and erase (in black).
  function fillBuffer(buf, color) {
    const path = new Path2D();
    for (let i = 0; i < numpoints; i++) path.rect(buf[i * 2], buf[i * 2 + 1], scale, scale);
    ctx.fillStyle = color;
    ctx.fill(path);
  }

  // One frame == one draw_julia(): advance c, erase the oldest trailing set and
  // the old marker, compute a fresh set, draw it in the next palette colour.
  function step() {
    // Erase the previous marker ring with a black disc (the C's XFillArc, +4 px).
    if (prevCircle) {
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(prevCircle.x, prevCircle.y, (circsize + 4) / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    incr();   // c moves to its new position for this frame
    const cx = (centerx * cr / 2 + centerx - 2);
    const cy = (centery * ci / 2 + centery - 2);

    // Draw the new marker ring (white outline) at the current c.
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, scale);
    ctx.beginPath();
    ctx.arc(cx, cy, circsize / 2, 0, Math.PI * 2);
    ctx.stroke();
    prevCircle = { x: cx, y: cy };

    // Once the ring has wrapped, erase the oldest set (still black) before reuse.
    if (erase) fillBuffer(buffers[buffer], '#000');

    inc++;

    // Advance the cycling colour one entry per frame.
    let color;
    if (palette) { color = palette[pix]; pix = (pix + 1) % ncolors; }
    else color = '#fff';

    // 64-step random inverse-iteration burn-in lands (xr, xi) on the set, then
    // the deterministic tree enumerates the set into the current buffer.
    let xr = 0, xi = 0;
    for (let k = 64; k--;) {
      xi -= ci;
      xr -= cr;
      const theta = (xi === 0 && xr === 0) ? 0 : Math.atan2(xi, xr) / 2;
      const r = Math.sqrt(Math.sqrt(xi * xi + xr * xr));
      xr = r * Math.cos(theta);
      xi = r * Math.sin(theta);
      if (Math.random() < 0.5) { xr = -xr; xi = -xi; }
    }
    curBuf = buffers[buffer];
    itree = 0;
    apply(xr, xi, depth);
    fillBuffer(curBuf, color);

    buffer++;
    if (buffer > nbuffers - 1) { buffer = 0; erase = true; }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    centerx = (W / 2) | 0;
    centery = (H / 2) | 0;

    // Point size: the C uses 1 px, tripled past 2560 px for retina-scale displays.
    scale = (W > 2560 || H > 2560) ? 3 : 1;
    // Marker ring diameter, the C's MAX(8, (MIN(centerx, centery)/96)*2+1).
    circsize = Math.max(8, ((Math.min(centerx, centery) / 96) | 0) * 2 + 1);

    depth = Math.min(Math.max(1, config.count | 0), 10);
    numpoints = (2 << depth) - 1;
    nbuffers = Math.max(2, (config.cycles | 0) + 1);

    buildPalette();

    buffers = new Array(nbuffers);
    for (let i = 0; i < nbuffers; i++) buffers[i] = new Int32Array(numpoints * 2);
    buffer = 0;
    erase = false;

    // The C seeds the colour index and orbit phase randomly.
    pix = palette ? Math.floor(Math.random() * ncolors) : 0;
    inc = ((Math.random() < 0.5) ? -1 : 1) * Math.floor(Math.random() * 200);
    cr = 0;
    ci = 0;
    prevCircle = null;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced by (delay + OVERHEAD) us: run one step() per
  // interval, banking leftover time so the pace is identical at any refresh rate.
  // Cap catch-up so a backgrounded tab doesn't fire a burst of steps on refocus.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

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

  // Re-seed with the current config (rebuilds palette/buffers, reseeds the orbit,
  // clears the canvas) — used by the host when a live:false param changes.
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
