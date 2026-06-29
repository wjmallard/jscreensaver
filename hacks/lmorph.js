// lmorph.js — lmorph packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's lmorph.c (Sverre H. Huseby and Glenn T. Lines, 1995;
// cubic interpolation + non-linear morph speed added 1999 by gtl).
// https://www.jwz.org/xscreensaver/
//
// "Smooth and non-linear morphing between 1D curves." A pool of ~12 random
// spline-ish line figures (a rectangle, lissajous loops, a flower, spirals,
// sine/cosine waves) is generated once; the hack then endlessly morphs the drawn
// polyline from one figure to another. Each point travels along a cubic Bezier
// whose end-tangents are the direction toward the *next* figure, so the morph
// stays smooth across hand-offs, and a per-point "speed" term gives the wave a
// travelling, non-uniform feel rather than a flat cross-fade.
//
// Rendering: the figure is genuinely line-shaped (the C clears the window and
// emits one XDrawLines through all numPoints points each frame), so this uses
// canvas VECTOR ops with a FULL repaint per frame — accumulate the polyline into
// a Path2D and stroke it once. No erase trick is needed because every frame
// redraws the whole figure from scratch.

export const title = 'lmorph';

export const info = {
  author: 'Sverre H. Huseby and Glenn T. Lines',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nThis generates random spline-ish line drawings and morphs between them.',
  year: 1995,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror lmorph.c's DEFAULTS (lmorph has no .xml). The figure
  // is drawn in a single static foreground colour, exactly as the C.
  const config = {
    delay: 70000,       // µs between morph steps (stock *delay; --delay)
    points: 200,        // control points per figure (--points)
    steps: 150,         // interpolation frames per morph (stock *steps; --steps)
    linewidth: 5,       // stroke width in logical px (--linewidth)
    figtype: 'all',     // which figure pool: all | open | closed (--figtype)
  };

  // live: true  -> the loop reads config every step, so it applies instantly
  //                (frame rate, morph speed, line width).
  // live: false -> the value sizes the point buffers / figure pool, so a change
  //                re-runs init() via reinit() (point count, figure type).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 70000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'points', label: 'Control points', type: 'range', min: 10, max: 1000, step: 10, default: 200, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'steps', label: 'Interpolation steps', type: 'range', min: 100, max: 500, step: 10, default: 150, lowLabel: 'less', highLabel: 'more', live: true },
    { key: 'linewidth', label: 'Lines', type: 'range', min: 1, max: 50, step: 1, default: 5, lowLabel: 'thin', highLabel: 'thick', live: true },
    { key: 'figtype', label: 'Figures', type: 'select', options: [
        { value: 'all', label: 'Open and closed figures' },
        { value: 'open', label: 'Open figures' },
        { value: 'closed', label: 'Closed figures' },
      ], default: 'all', live: false },
  ];

  const TWO_PI = 2.0 * Math.PI;
  // Sentinel: a stepNum larger than any possible `steps` so the first step()
  // seeds the first morph (mirrors the C's currGamma = maxGamma + 1 at startup).
  const SEED_NOW = 1 << 30;

  // The C draws every figure in one static foreground colour, set once in
  // initLMorph and never changed (lmorph_defaults: ".foreground: #4444FF"; the
  // source comment notes the blue was "brightened a little bit"). There is no
  // colormap and no per-point or per-frame colour, so this is a fixed blue --
  // verified against the live binary, whose clean captures are solid #4444FF.
  const FG = '#4444FF';

  let S = 1;                 // devicePixelRatio
  let W, H;                  // canvas size, device px

  let numPoints;             // points per figure (== config.points, clamped)
  let numFigs;               // number of figures in the pool (figtype-dependent)
  let figs;                  // [{ x: Float64Array, y: Float64Array }, ...]

  let workX, workY;          // the currently displayed polyline (numPoints long)
  let aSlopeFromX, aSlopeFromY;   // end-tangent at the start of the morph
  let aSlopeToX, aSlopeToY;       // end-tangent at the end of the morph

  let nFrom, nTo, nNext;     // figure indices: morphing from -> to, next after
  let aFrom, aTo;            // figs[nFrom], figs[nTo] (the morph endpoints)
  let shift;                 // phase offset for the per-point speed wave
  let stepNum;               // integer step within the current morph

  function rnd(n) {
    return Math.floor(Math.random() * n);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // Build the figure pool for the current figtype, then shrink every figure 10%
  // inward (the C's MARGINS) so nothing touches the edges. Each figure is
  // numPoints (x, y) samples; closed figures repeat point 0 at the last index.
  function buildFigures() {
    const mx = W - 1;
    const my = H - 1;
    const mp = numPoints - 1;
    const rx = mx / 2;
    const ry = my / 2;

    figs = [];
    const closed = config.figtype === 'all' || config.figtype === 'closed';
    const open = config.figtype === 'all' || config.figtype === 'open';

    const add = (gen) => {
      const x = new Float64Array(numPoints);
      const y = new Float64Array(numPoints);
      gen(x, y, mx, my, mp, rx, ry);
      figs.push({ x, y });
    };

    if (closed) {
      // rectangle (numPoints/4 samples per edge, last point closes to point 0).
      add((x, y, mx, my, mp) => {
        const s = Math.floor(numPoints / 4);
        for (let q = 0; q < s; q++) {
          x[q] = (q / s) * mx;             y[q] = 0;
          x[s + q] = mx;                   y[s + q] = (q / s) * my;
          x[2 * s + q] = mx - (q / s) * mx; y[2 * s + q] = my;
          x[3 * s + q] = 0;                y[3 * s + q] = my - (q / s) * my;
        }
        for (let q = 4 * s; q < numPoints; q++) { x[q] = 0; y[q] = 0; }
        x[mp] = x[0]; y[mp] = y[0];
      });
      // lissajous 1:3
      add((x, y, mx, my, mp, rx, ry) => {
        for (let q = 0; q < numPoints; q++) {
          x[q] = mx / 2 + rx * Math.sin(1 * TWO_PI * q / mp);
          y[q] = my / 2 + ry * Math.cos(3 * TWO_PI * q / mp);
        }
        x[mp] = x[0]; y[mp] = y[0];
      });
      // lissajous 3:1 (both axes use ry)
      add((x, y, mx, my, mp, rx, ry) => {
        for (let q = 0; q < numPoints; q++) {
          x[q] = mx / 2 + ry * Math.sin(3 * TWO_PI * q / mp);
          y[q] = my / 2 + ry * Math.cos(1 * TWO_PI * q / mp);
        }
        x[mp] = x[0]; y[mp] = y[0];
      });
      // 30-lobe flower
      add((x, y, mx, my, mp, rx, ry) => {
        for (let q = 0; q < numPoints; q++) {
          const r = ry * (0.8 - 0.2 * Math.sin(30 * TWO_PI * q / mp));
          x[q] = mx / 2 + r * Math.sin(TWO_PI * q / mp);
          y[q] = my / 2 + r * Math.cos(TWO_PI * q / mp);
        }
        x[mp] = x[0]; y[mp] = y[0];
      });
      // circle
      add((x, y, mx, my, mp, rx, ry) => {
        for (let q = 0; q < numPoints; q++) {
          x[q] = mx / 2 + ry * Math.sin(TWO_PI * q / mp);
          y[q] = my / 2 + ry * Math.cos(TWO_PI * q / mp);
        }
        x[mp] = x[0]; y[mp] = y[0];
      });
      // ellipse (cos on x, sin on y)
      add((x, y, mx, my, mp, rx, ry) => {
        for (let q = 0; q < numPoints; q++) {
          x[q] = mx / 2 + rx * Math.cos(TWO_PI * q / mp);
          y[q] = my / 2 + ry * Math.sin(TWO_PI * q / mp);
        }
        x[mp] = x[0]; y[mp] = y[0];
      });
      // lissajous 2:3
      add((x, y, mx, my, mp, rx, ry) => {
        for (let q = 0; q < numPoints; q++) {
          x[q] = mx / 2 + rx * Math.sin(2 * TWO_PI * q / mp);
          y[q] = my / 2 + ry * Math.cos(3 * TWO_PI * q / mp);
        }
        x[mp] = x[0]; y[mp] = y[0];
      });
    }

    if (open) {
      // sine wave, one period (x spans by q/numPoints, not q/mp — as in the C)
      add((x, y, mx, my, mp) => {
        for (let q = 0; q < numPoints; q++) {
          x[q] = (q / numPoints) * mx;
          y[q] = (1.0 - Math.sin((q / mp) * TWO_PI)) * my / 2.0;
        }
      });
      // cosine wave, three periods
      add((x, y, mx, my, mp) => {
        for (let q = 0; q < numPoints; q++) {
          x[q] = (q / mp) * mx;
          y[q] = (1.0 - Math.cos((q / mp) * 3 * TWO_PI)) * my / 2.0;
        }
      });
      // spiral, one endpoint at bottom
      add((x, y, mx, my, mp, rx, ry) => {
        for (let q = 0; q < numPoints; q++) {
          x[q] = mx / 2 + ry * Math.sin(5 * TWO_PI * q / mp) * (q / mp);
          y[q] = my / 2 + ry * Math.cos(5 * TWO_PI * q / mp) * (q / mp);
        }
      });
      // spiral, one endpoint at top
      add((x, y, mx, my, mp, rx, ry) => {
        for (let q = 0; q < numPoints; q++) {
          x[q] = mx / 2 + ry * Math.sin(6 * TWO_PI * q / mp) * (q / mp);
          y[q] = my / 2 - ry * Math.cos(6 * TWO_PI * q / mp) * (q / mp);
        }
      });
      // sine wave, five periods
      add((x, y, mx, my, mp) => {
        for (let q = 0; q < numPoints; q++) {
          x[q] = (q / mp) * mx;
          y[q] = (1.0 - Math.sin((q / mp) * 5 * TWO_PI)) * my / 2.0;
        }
      });
    }

    numFigs = figs.length;

    // MARGINS: scale every figure to 80% and re-centre with a 10% border.
    const marginx = (mx + 1) / 10;
    const marginy = (my + 1) / 10;
    const scalex = ((mx + 1) - 2.0 * marginx) / (mx + 1);
    const scaley = ((my + 1) - 2.0 * marginy) / (my + 1);
    for (const f of figs) {
      for (let w = 0; w < numPoints; w++) {
        f.x[w] = marginx + f.x[w] * scalex;
        f.y[w] = marginy + f.y[w] * scaley;
      }
    }
  }

  // Reverse a figure's point order in place — the C's RND(2) variation. Since a
  // polyline drawn forward or backward traces the *same* path, this never causes
  // a visual jump; it only changes which point maps to which during the morph.
  function reverseFigure(n) {
    const x = figs[n].x;
    const y = figs[n].y;
    const half = Math.floor(numPoints / 2);
    for (let i1 = 0, i2 = numPoints - 1; i1 < half; i1++, i2--) {
      const tx = x[i1]; x[i1] = x[i2]; x[i2] = tx;
      const ty = y[i1]; y[i1] = y[i2]; y[i2] = ty;
    }
  }

  // Reached the end of a morph: rotate to -> from, next -> to, pick a fresh
  // next, optionally reverse it, and recompute the end-tangent slopes (the C's
  // reseed block in animateLMorph). aSlopeTo points from the new `to` figure
  // toward the `next` figure, giving the cubic its end direction; aSlopeFrom
  // inherits the previous aSlopeTo for C1-continuous hand-offs.
  function seedNextMorph() {
    nFrom = nTo;
    nTo = nNext;
    do {
      nNext = rnd(numFigs);
    } while (nNext === nTo);

    shift = rnd(numPoints);
    if (rnd(2)) reverseFigure(nNext);

    const next = figs[nNext];
    const to = figs[nTo];
    for (let i = 0; i < numPoints; i++) {
      aSlopeFromX[i] = aSlopeToX[i];
      aSlopeFromY[i] = aSlopeToY[i];
      aSlopeToX[i] = next.x[i] - to.x[i];
      aSlopeToY[i] = next.y[i] - to.y[i];
    }

    aFrom = figs[nFrom];
    aTo = figs[nTo];
  }

  // The C's createPoints(): each point is a cubic Bezier from aFrom to aTo with
  // control handles set by the slopes (Hermite -> Bezier), evaluated at a
  // per-point gamma. The Gaussian `speed` term kicks gamma forward/back near the
  // middle of the morph, phase-shifted by `shift`, for the travelling-wave look.
  function createPoints(currGamma) {
    for (let idx = 0; idx < numPoints; idx++) {
      const q = numPoints - idx;   // the C loops q = numPoints .. 1
      const speed = 0.45 * Math.sin(TWO_PI * (q + shift) / (numPoints - 1));
      const e = currGamma - 0.5 + 0.7 * speed;
      const fg = currGamma + 1.67 * speed * Math.exp(-200.0 * e * e);
      const f1g = 1.0 - fg;
      const f1g2 = f1g * f1g;
      const fg2 = fg * fg;

      const fromX = aFrom.x[idx];
      const toX = aTo.x[idx];
      workX[idx] = f1g2 * f1g * fromX
                 + f1g2 * fg * (3 * fromX + aSlopeFromX[idx])
                 + f1g * fg2 * (3 * toX - aSlopeToX[idx])
                 + fg2 * fg * toX;

      const fromY = aFrom.y[idx];
      const toY = aTo.y[idx];
      workY[idx] = f1g2 * f1g * fromY
                 + f1g2 * fg * (3 * fromY + aSlopeFromY[idx])
                 + f1g * fg2 * (3 * toY - aSlopeToY[idx])
                 + fg2 * fg * toY;
    }
  }

  // Full repaint: clear to black, stroke the whole polyline once (the C's
  // XClearWindow + XDrawLines) in the static foreground colour. Open figures
  // stay open; closed figures close because their last point coincides with 0.
  function drawImage() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = FG;
    ctx.lineWidth = Math.max(1, Math.round(config.linewidth) * S);

    const path = new Path2D();
    path.moveTo(workX[0], workY[0]);
    for (let i = 1; i < numPoints; i++) path.lineTo(workX[i], workY[i]);
    ctx.stroke(path);
  }

  // One animation step (the C's animateLMorph). currGamma is rebuilt from the
  // integer stepNum every frame (no float accumulator to drift), and the morph
  // ends on an INTEGER step count (stepNum > steps), never an exact float==1.0
  // test — so it can neither freeze on one shape nor skip a re-seed.
  function step() {
    const steps = Math.max(1, Math.round(config.steps));
    if (stepNum > steps) {
      seedNextMorph();
      stepNum = 0;
    }
    const currGamma = stepNum / steps;
    createPoints(currGamma);
    drawImage();

    stepNum++;
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    numPoints = clamp(Math.round(config.points), 10, 1000);

    buildFigures();

    workX = new Float64Array(numPoints);
    workY = new Float64Array(numPoints);
    aSlopeFromX = new Float64Array(numPoints);
    aSlopeFromY = new Float64Array(numPoints);
    aSlopeToX = new Float64Array(numPoints);   // starts at zero, as in the C
    aSlopeToY = new Float64Array(numPoints);

    // Pre-pick to/next so the first seedNextMorph (forced below) has valid state.
    nTo = rnd(numFigs);
    do {
      nNext = rnd(numFigs);
    } while (nNext === nTo);
    nFrom = nTo;

    stepNum = SEED_NOW;        // force a seed on the first step()

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

  // rAF lag-accumulator paced by config.delay (µs): run one step() per delay,
  // banking leftover time so the speed is identical at any refresh rate. Cap
  // catch-up so a backgrounded tab doesn't burst a run of steps on refocus.
  //
  // OVERHEAD: the live binary's *delay (70000) is a sleep floor; its real per-
  // frame cost is higher. The hack is delay-bound (-delay 0 measured ~3265 fps,
  // so compute is trivial); at stock delay the live -fps overlay read a clean
  // ~11.2 fps (Load 16-25%), i.e. a ~89000 us period, so OVERHEAD = 1e6/11.2 -
  // 70000 ~= 19000 us. Adding it makes the port morph at the original's pace
  // while config.delay still maps 1:1 to the stock resource. (Dense self-
  // overlapping figures spike to ~8 fps under XQuartz's slow XDrawLines, an
  // artifact of the macOS X server, not the delay-bound steady state.)
  const OVERHEAD = 19000;
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

  // Rebuild after a non-live config change (clears the canvas, re-seeds).
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
