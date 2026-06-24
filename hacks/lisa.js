// lisa.js — lisa packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver/xlockmore's lisa.c (Caleb Cullen, 1997, 2006).
// https://www.jwz.org/xscreensaver/
//
// "Animated full-loop lissajous figures." Each figure is a CLOSED loop sampled
// at `nsteps` points: x = cx + R*(sum/product of sin(coeff*theta)),
// y = cy + R*(sum/product of sin(coeff*phi)), where theta = (i+phase)*pistep,
// phi = (i-phase)*pistep, pistep = 2*PI/nsteps. A per-frame `phase` (loopcount %
// nsteps) shifts theta up and phi down each frame, so the whole loop slowly
// precesses/morphs. Every 3*nsteps frames the figure "melts" over one full
// nsteps cycle into a new randomly-chosen Lissajous function (a blend of the old
// and new). The loop drifts around the screen, bouncing off the edges. The loop
// is drawn as a dashed rainbow: split into `cstep`-point colour segments, each a
// step around the hue cycle, with a one-segment gap between colours (the C's
// CapNotLast "intentional whitespace").
//
// Rendering: sparse vector ops. The C draws the whole figure each frame as
// polyline colour-segments and erases the previous frame's segments in SOLID
// black (no XOR). Rather than erase-old-then-draw-new on a persistent canvas —
// which leaves anti-aliased ghost lines, since canvas strokes are AA'd — this
// port repaints each frame: clear to black, recompute and redraw every figure.
// The visible result (moving rainbow loops on black) is identical and ghost-free.
// See lisa.md for the deviations; see [[lissie]] (sibling Lissajous worm) and
// [[xspirograph]] (same dashed-rainbow-polyline idiom).

import { makeUniformColormapRGB } from './colormap.js';

export const title = 'lisa';

export const info = {
  author: 'Caleb Cullen',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nLissajous loops.\n\nhttps://en.wikipedia.org/wiki/Lissajous_curve',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror lisa.c's DEFAULTS (lisa has no .xml -- it was removed
  // from xscreensaver in 5.08, so config comes from the C #defines). `additive`
  // is a stock lisa option (-/+additive, default on); exposed here as a checkbox
  // since it materially changes the shapes.
  const config = {
    delay: 17000,      // microseconds between steps (stock *delay; --delay)
    cycles: 768,       // nsteps: points per loop / frames per precession (--cycles)
    ncolors: 64,       // size of the hue cycle (--ncolors)
    size: 500,         // figure radius cap in logical px (--size)
    count: 1,          // number of simultaneous loops (--count)
    additive: true,    // sum-of-sines (true) vs product-of-sines (false) (--additive)
  };

  // live: true  -> the loop reads config every step (applies instantly).
  // live: false -> the value sizes loops/colours/buffers, so a change re-runs init().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 50000, step: 1000, default: 17000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cycles', label: 'Steps', type: 'range', min: 1, max: 1000, step: 1, default: 768, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'size', label: 'Size', type: 'range', min: 10, max: 500, step: 10, default: 500, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'count', label: 'Count', type: 'range', min: 1, max: 20, step: 1, default: 1, lowLabel: 'one', highLabel: 'many', live: false },
    { key: 'additive', label: 'Additive', type: 'checkbox', default: true, live: true },
  ];

  // Constants from the C (#defines).
  const XVMAX = 10;          // maximum drift velocity per axis (px/frame)
  const YVMAX = 10;
  const NUMSTDFUNCS = 28;    // size of the Function[] table
  const RAREFUNCMIN = 25;    // functions at this index or above are "rare"
  const RAREFUNCODDS = 4;    // 1:n chance a rare pick is re-randomized
  const MAXCYCLES = 3;       // frames per change = MAXCYCLES * nsteps
  const STARTFUNC = 24;      // the first figure is always Function[24]
  const TWO_PI = Math.PI * 2;

  // The C's Function[] table: each is x = sin(xcoeff[0]*t)*sin(xcoeff[1]*t),
  // y = sin(ycoeff[0]*t)*sin(ycoeff[1]*t) (product), or the sum of the two sines
  // when additive. nx/ny are always 2. Index 25+ are the "rare" functions.
  const Function = [
    { xcoeff: [1.0, 2.0], ycoeff: [1.0, 2.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 2.0], ycoeff: [1.0, 1.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 3.0], ycoeff: [1.0, 2.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 3.0], ycoeff: [1.0, 3.0], nx: 2, ny: 2 },
    { xcoeff: [2.0, 4.0], ycoeff: [1.0, 2.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 4.0], ycoeff: [1.0, 3.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 4.0], ycoeff: [1.0, 4.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 5.0], ycoeff: [1.0, 5.0], nx: 2, ny: 2 },
    { xcoeff: [2.0, 5.0], ycoeff: [2.0, 5.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 2.0], ycoeff: [2.0, 5.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 2.0], ycoeff: [3.0, 5.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 2.0], ycoeff: [2.0, 3.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 3.0], ycoeff: [2.0, 3.0], nx: 2, ny: 2 },
    { xcoeff: [2.0, 3.0], ycoeff: [1.0, 3.0], nx: 2, ny: 2 },
    { xcoeff: [2.0, 4.0], ycoeff: [1.0, 3.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 4.0], ycoeff: [2.0, 3.0], nx: 2, ny: 2 },
    { xcoeff: [2.0, 4.0], ycoeff: [2.0, 3.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 5.0], ycoeff: [2.0, 3.0], nx: 2, ny: 2 },
    { xcoeff: [2.0, 5.0], ycoeff: [2.0, 3.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 5.0], ycoeff: [2.0, 5.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 3.0], ycoeff: [2.0, 7.0], nx: 2, ny: 2 },
    { xcoeff: [2.0, 3.0], ycoeff: [5.0, 7.0], nx: 2, ny: 2 },
    { xcoeff: [1.0, 2.0], ycoeff: [3.0, 7.0], nx: 2, ny: 2 },
    { xcoeff: [2.0, 5.0], ycoeff: [5.0, 7.0], nx: 2, ny: 2 },
    { xcoeff: [5.0, 7.0], ycoeff: [5.0, 7.0], nx: 2, ny: 2 },
    { xcoeff: [2.0, 7.0], ycoeff: [1.0, 7.0], nx: 2, ny: 2 },    // rare
    { xcoeff: [2.0, 9.0], ycoeff: [1.0, 7.0], nx: 2, ny: 2 },    // rare
    { xcoeff: [5.0, 11.0], ycoeff: [2.0, 9.0], nx: 2, ny: 2 },   // rare
  ];

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let palette;        // ncolors uniform-colormap CSS strings (full hue ramp)
  let loops;          // active lissajous figures
  let loopcount;      // frames since the last change (the C's lc->loopcount)
  let nsteps;         // points per loop (config.cycles), fixed per seed
  let maxcycles;      // frames between changes minus one (MAXCYCLES*nsteps - 1)

  // NRAND(n) — uniform integer in [0, n-1] (the C's random() % n).
  function nrand(n) {
    return Math.floor(Math.random() * n);
  }

  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    // lisa.c is UNIFORM_COLORS -> make_uniform_colormap: a full hue ramp at one
    // per-run S,V (each 66%-100%), so it is a rainbow but usually a touch
    // muted, and varies run to run -- not the fixed max-vivid hsl() the first
    // port used. ncolors <= 2 -> white (the C's MONO / MI_WHITE_PIXEL path).
    if (n <= 2) {
      palette = new Array(n).fill('#fff');
      return;
    }
    palette = makeUniformColormapRGB(n).map(([r, g, b]) => `rgb(${r},${g},${b})`);
  }

  // The C's CHECK_RADIUS: clamp the figure radius to `size` if it fits, else to
  // min(W,H)*3/8. Runs every frame so a live `size` change resizes the figure.
  function checkRadius(loop) {
    const sizePx = config.size * S;
    if (H / 2 > sizePx && W / 2 > sizePx) loop.radius = sizePx;
    if (loop.radius < 0 || loop.radius > loop.center.x || loop.radius > loop.center.y) {
      loop.radius = (W > H ? H : W) * 3 / 8;
    }
  }

  // Build one figure — the C's initlisa(). Velocities and line width are scaled
  // by S so motion speed and stroke weight match the logical size on retina.
  function makeLoop() {
    const n = palette.length;
    const cstep = (nsteps > n) ? Math.floor(nsteps / n) : 1;
    // LINEWIDTH = -8 -> random 1..8 px; the C doubles it past 2560, we scale by S.
    const linewidth = Math.max(1, Math.round((nrand(8) + 1) * S));
    const loop = {
      center: { x: W / 2, y: H / 2 },
      dx: (nrand(XVMAX) + 1) * S,
      dy: (nrand(YVMAX) + 1) * S,
      radius: config.size * S,
      melting: 0,
      nfuncs: 1,
      func0: STARTFUNC,    // current function index
      func1: STARTFUNC,    // function being melted in (when nfuncs == 2)
      pistep: TWO_PI / nsteps,
      cstep,
      linewidth,
      px: new Float64Array(nsteps),
      py: new Float64Array(nsteps),
    };
    checkRadius(loop);
    return loop;
  }

  // Compute all nsteps points of a figure at the current phase — the C's inner
  // loop in drawlisa(). Reads config.additive live. Points are stored in
  // loop.px/py (closed-loop sampling: index i wraps via i % nsteps when drawn).
  function computePoints(loop) {
    const ps = loop.pistep;
    const phase = loopcount % nsteps;
    const additive = config.additive;
    const nfuncs = loop.nfuncs;
    const melting = loop.melting;
    const radius = loop.radius;
    const cx = loop.center.x;
    const cy = loop.center.y;
    const f0 = Function[loop.func0];
    const f1 = Function[loop.func1];

    for (let i = 0; i < nsteps; i++) {
      const theta = (i + phase) * ps;
      const phi = (i - phase) * ps;
      let xsum = 0;
      let ysum = 0;

      // The C iterates fctr = nfuncs-1 .. 0 (while(fctr--)); function[0] is the
      // current shape, function[1] the one being melted in. The order matters:
      // the additive radius-scaling happens once, on the fctr==0 pass.
      for (let fctr = nfuncs - 1; fctr >= 0; fctr--) {
        const lf = (fctr === 0) ? f0 : f1;

        if (additive) {
          const xprod = Math.sin(lf.xcoeff[1] * theta) + Math.sin(lf.xcoeff[0] * theta);
          const yprod = Math.sin(lf.ycoeff[1] * phi) + Math.sin(lf.ycoeff[0] * phi);
          if (melting) {
            if (fctr) {
              // function[1]: the new shape, faded in as melting -> 0.
              xsum += xprod * (nsteps - melting) / nsteps;
              ysum += yprod * (nsteps - melting) / nsteps;
            } else {
              // function[0]: the old shape, faded out.
              xsum += xprod * melting / nsteps;
              ysum += yprod * melting / nsteps;
            }
          } else {
            xsum = xprod;
            ysum = yprod;
          }
          if (!fctr) {
            xsum = xsum * radius / lf.nx;
            ysum = ysum * radius / lf.ny;
          }
        } else {
          let xprod;
          let yprod;
          if (melting) {
            if (fctr) {
              yprod = xprod = radius * (nsteps - melting) / nsteps;
            } else {
              yprod = xprod = radius * melting / nsteps;
            }
          } else {
            xprod = yprod = radius;
          }
          xprod *= Math.sin(lf.xcoeff[1] * theta) * Math.sin(lf.xcoeff[0] * theta);
          yprod *= Math.sin(lf.ycoeff[1] * phi) * Math.sin(lf.ycoeff[0] * phi);
          xsum += xprod;
          ysum += yprod;
        }
      }

      if ((nfuncs > 1) && (!melting)) {
        xsum /= nfuncs;
        ysum /= nfuncs;
      }

      // The C rounds to integer X11 pixels with ceil(); we keep float coords for
      // smooth anti-aliased strokes (a rendering-only deviation, see lisa.md).
      loop.px[i] = cx + xsum;
      loop.py[i] = cy + ysum;
    }
  }

  // Advance one figure by a frame — the C's drawlisa() state half: drift the
  // centre, bounce off the edges, recompute the points, then tick the melt.
  function advance(loop) {
    loop.center.x += loop.dx;
    loop.center.y += loop.dy;
    checkRadius(loop);

    // Bounce off the edges; the new velocity is a fresh random 0..VMAX (the C's
    // NRAND), scaled by S, so a figure can occasionally stall on an axis as in
    // the original.
    if ((loop.center.x - loop.radius) <= 0) {
      loop.center.x = loop.radius;
      loop.dx = nrand(XVMAX) * S;
    } else if ((loop.center.x + loop.radius) >= W) {
      loop.center.x = W - loop.radius;
      loop.dx = -nrand(XVMAX) * S;
    }
    if ((loop.center.y - loop.radius) <= 0) {
      loop.center.y = loop.radius;
      loop.dy = nrand(YVMAX) * S;
    } else if ((loop.center.y + loop.radius) >= H) {
      loop.center.y = H - loop.radius;
      loop.dy = -nrand(YVMAX) * S;
    }

    computePoints(loop);

    // Tick the melt; when it reaches 0 the new function becomes the current one.
    if (loop.melting) {
      loop.melting--;
      if (loop.melting === 0) {
        loop.nfuncs = 1;
        loop.func0 = loop.func1;
      }
    }
  }

  // The C's change_lisa(): reset the phase and start every figure melting into a
  // fresh, non-repeating function (rare functions are biased down).
  function change() {
    loopcount = 0;
    for (const loop of loops) {
      let newfunc = nrand(NUMSTDFUNCS);
      if (newfunc === loop.func0) newfunc = (newfunc + 1) % NUMSTDFUNCS;
      if (newfunc >= RAREFUNCMIN && nrand(RAREFUNCODDS) === 0) {
        newfunc = nrand(NUMSTDFUNCS);
        if (newfunc === loop.func0) newfunc = (newfunc + 1) % NUMSTDFUNCS;
      }
      loop.func1 = newfunc;
      loop.melting = nsteps - 1;   // melt over one full cycle
      loop.nfuncs = 2;
    }
  }

  // One frame of simulation — the C's draw_lisa(): tick the frame counter, fire a
  // change at the boundary, then advance every figure. Drawing is in render().
  function step() {
    loopcount++;
    if (loopcount > maxcycles) change();
    for (const loop of loops) advance(loop);
  }

  // Repaint the whole screen: black, then each figure as dashed rainbow polyline
  // segments (the C's per-cstep XDrawLines), one colour per segment with a
  // one-segment gap between colours. When cstep < 2 (cycles <= ncolors) the C
  // would draw invisible 1-point "lines"; we draw dots instead so small-cycle
  // figures stay visible.
  function render() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const ncol = palette.length;

    for (const loop of loops) {
      const px = loop.px;
      const py = loop.py;
      const cstep = loop.cstep;

      if (cstep < 2) {
        const lw = loop.linewidth;
        const half = lw / 2;
        for (let i = 0; i < nsteps; i++) {
          ctx.fillStyle = palette[i % ncol];
          ctx.fillRect(px[i] - half, py[i] - half, lw, lw);
        }
        continue;
      }

      // Bucket each colour segment into its own Path2D, stroke once per colour.
      const buckets = new Array(ncol);
      let k = 0;
      for (let start = 0; start < nsteps; start += cstep, k++) {
        const ci = k % ncol;
        let path = buckets[ci];
        if (!path) {
          path = new Path2D();
          buckets[ci] = path;
        }
        // Polyline of cstep points (cstep-1 line segments); wraps to close the
        // loop. The gap to the next segment's start point is left undrawn — the
        // C's CapNotLast "intentional whitespace" between colours.
        for (let j = 0; j < cstep; j++) {
          const idx = (start + j) % nsteps;
          if (j === 0) path.moveTo(px[idx], py[idx]);
          else path.lineTo(px[idx], py[idx]);
        }
      }

      ctx.lineWidth = loop.linewidth;
      for (let c = 0; c < ncol; c++) {
        if (buckets[c]) {
          ctx.strokeStyle = palette[c];
          ctx.stroke(buckets[c]);
        }
      }
    }
  }

  // Reseed the whole screen — the C's init_lisa(): fresh figures, all starting on
  // Function[24], and pre-compute their first frame so render() has something to
  // draw before the first step().
  function seedAll() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    loopcount = 0;
    nsteps = Math.max(1, Math.round(config.cycles));
    maxcycles = MAXCYCLES * nsteps - 1;
    const n = Math.max(1, Math.round(config.count));
    loops = [];
    for (let i = 0; i < n; i++) {
      const loop = makeLoop();
      computePoints(loop);
      loops.push(loop);
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    ctx.lineCap = 'butt';     // the C's CapNotLast: no rounded segment caps
    ctx.lineJoin = 'bevel';   // the C's JoinBevel
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

  // Fixed-timestep rAF loop (squiral/lissie-style): one step() per config.delay,
  // banking leftover time so the speed is the same at any refresh rate. Cap
  // catch-up so a backgrounded tab can't burst. render() runs once per frame.
  //
  // OVERHEAD: the live binary's *delay (17000) is a sleep floor; its real per-
  // frame cost is higher. Measured live lisa = 39.8 fps (Load 32%, delay-bound),
  // i.e. a ~25126 us period, so OVERHEAD = 1e6/39.8 - 17000 = 8126 us. Adding it
  // to the step delay makes the port precess/drift at the original's pace while
  // config.delay still maps 1:1 to the stock resource. See framerate-calibration.
  const OVERHEAD = 8126;
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

    render();
    rafId = requestAnimationFrame(frame);
  }

  // Rebuild after a non-live config change (cycles/colors/count): clear + reseed.
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
