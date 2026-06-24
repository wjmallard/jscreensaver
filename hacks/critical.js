// critical.js -- critical packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's critical.c (Martin Pool, 1998-2000).
// https://www.jwz.org/xscreensaver/
//
// A self-organizing-criticality display. An 80 x H grid of cells holds random
// values; each step the highest-valued cell is found -- that becomes the next
// point of a walk -- and that cell plus its eight neighbours are re-randomised.
// The points are joined by straight lines into a moving colour trail. It starts
// as random squiggles, but after a while the walk settles into order.
//
// Rendering: SPARSE vector ops. The trail is the only thing on screen (nothing
// accumulates -- the C draws the newest segment and erases the oldest each step),
// so we keep the last `trail` points and stroke the connected polyline between
// them, grouped by colour into one Path2D per colour (<= ncolors strokes/frame).
// See [[qix]] (the same moving-trail idiom) and [[squiral]] (the skeleton).

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'critical';

export const info = {
  author: 'Martin Pool',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nDraws a system of self-organizing lines. It starts out as random squiggles, but after a few iterations, order begins to appear.',
  year: 1999,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/critical.xml (delay, ncolors) plus the
  // C's `trail` resource, the defining visual knob. Units match the xml so the
  // config box maps 1:1.
  const config = {
    delay: 10000,   // microseconds between steps (--delay); stock critical.xml default
    ncolors: 64,    // size of the colour cycle (--ncolors)
    trail: 50,      // number of points kept in the moving trail (--trail)
  };

  // live: true  -> the loop reads config every step (applies instantly).
  // live: false -> the value sizes the palette / trail ring, so a change
  //                re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 3, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'trail', label: 'Trail length', type: 'range', min: 2, max: 300, step: 1, default: 50, lowLabel: 'short', highLabel: 'long', live: false },
  ];

  // Fixed model/cadence constants from critical.c's defaults.
  const MODEL_W = 80;          // grid width in cells (fixed; varying it is boring on big screens)
  const LINES_PER_COLOR = 10;  // advance the colour every this many steps
  const BATCHCOUNT = 1500;     // steps between restart checks (st->batchcount)
  const RESTART = 8;           // restart checks before a full re-seed (st->n_restart)

  let S = 1;                   // devicePixelRatio
  let cellSize, half;          // cell pitch / centre offset, device px
  let modelH;                  // grid height in cells (width is MODEL_W)
  let cells;                   // Uint16Array(MODEL_W * modelH) of random values

  let ncolors, trail;          // resolved from config
  let colors;                  // palette: a smooth colormap (re-rolled on restart)

  let history;                 // ring of { x, y, color } in cell coords
  let histHead, histCount;     // next write slot / number of valid points

  let dIColor, curColor;       // current colour index / string
  let dIBatch, iRestart;       // batch + restart counters (integers, like the C)

  function clip(low, val, high) {
    return val < low ? low : val > high ? high : val;
  }

  // A new unsigned-short random value, matching the C's (unsigned short)random().
  function randCell() {
    return (Math.random() * 65536) | 0;
  }

  // The C's default colorscheme=smooth -> make_smooth_colormap (setup_colormap in
  // critical.c): a closed loop of `ncolors` entries interpolated between 2-5 random
  // HSV anchors. colormap.js is a faithful port of that; NOT the old vivid
  // full-saturation hsl() wheel. Re-rolled on each restart, as the C re-runs
  // setup_colormap when it re-seeds.
  function buildColors() {
    colors = makeSmoothColormapRGB(ncolors).map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);
  }

  // Fill every cell with a fresh random value (the C's model_initialize).
  function modelInitialize() {
    for (let i = cells.length - 1; i >= 0; i--) {
      cells[i] = randCell();
    }
  }

  // One criticality step (the C's model_step): find the highest-valued cell --
  // `>=` so ties resolve to the last (bottom-right) one, exactly as in the C --
  // then replace it and its eight neighbours with new randoms. The returned
  // point is always a valid grid cell, so it can never fly off-screen or NaN.
  function modelStep() {
    let topVal = 0;
    let topX = 0;
    let topY = 0;
    let i = 0;
    for (let y = 0; y < modelH; y++) {
      for (let x = 0; x < MODEL_W; x++) {
        const v = cells[i];
        if (v >= topVal) {
          topVal = v;
          topX = x;
          topY = y;
        }
        i++;
      }
    }
    for (let dy = -1; dy <= 1; dy++) {
      const yy = topY + dy;
      if (yy < 0 || yy >= modelH) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = topX + dx;
        if (xx < 0 || xx >= MODEL_W) continue;
        cells[yy * MODEL_W + xx] = randCell();
      }
    }
    return { x: topX, y: topY };
  }

  // Push a point onto the trail ring with the colour it was drawn in.
  function pushPoint(p, color) {
    history[histHead] = { x: p.x, y: p.y, color };
    histHead = (histHead + 1) % trail;
    if (histCount < trail) histCount++;
  }

  // Full re-seed (the C's restart block): rebuild the colormap, new model, walk
  // origin re-seeded. buildColors() rolls a fresh smooth colormap so the new run
  // does not repaint identically (the C re-calls setup_colormap here). The walk's
  // batch counter is reset; dIColor is left to continue, like the C (the colormap
  // changed, so colours differ).
  function restart() {
    buildColors();
    modelInitialize();
    histHead = 0;
    histCount = 0;
    pushPoint(modelStep(), curColor);
    dIBatch = BATCHCOUNT;
  }

  // One simulation step: advance the colour cadence, take a criticality step,
  // append the point, then run the C's batch/restart bookkeeping with the same
  // integer counters (no float tests). No canvas drawing here -- frame() does a
  // single full repaint after all of a frame's steps.
  function step() {
    if (dIBatch % LINES_PER_COLOR === 0) {
      dIColor = (dIColor + 1) % ncolors;
      curColor = colors[dIColor];
    }

    pushPoint(modelStep(), curColor);

    dIBatch--;
    if (dIBatch < 0) {
      dIBatch = BATCHCOUNT;
      iRestart = (iRestart + 1) % RESTART;
      if (iRestart === 0) restart();
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;

    // Cell pitch in device px; model height follows the aspect ratio. Keeping
    // the pitch in device px means the grid stays ~80 x (80*H/W) on any dpr.
    cellSize = Math.max(1, Math.floor(canvas.width / MODEL_W));
    half = Math.floor(cellSize / 2);
    modelH = Math.max(1, Math.floor(canvas.height / cellSize));
    cells = new Uint16Array(MODEL_W * modelH);

    ncolors = Math.max(3, Math.round(config.ncolors));
    trail = clip(2, Math.round(config.trail), 1000);

    buildColors();

    history = new Array(trail);
    histHead = 0;
    histCount = 0;

    dIColor = 0;
    curColor = colors[0];
    dIBatch = BATCHCOUNT;
    iRestart = 0;

    modelInitialize();
    pushPoint(modelStep(), curColor);
  }

  // Clear to black and stroke the current trail. The trail is the whole image
  // (the C leaves the rest of the screen black), so a full repaint is faithful
  // AND seam-free: it avoids the anti-aliasing ghosts that an erase-oldest
  // (re-stroke-in-black) scheme leaves on canvas. Segments are grouped by colour
  // into one Path2D each; a segment takes its NEWER endpoint's colour, matching
  // the C, which drew each segment with the foreground colour active when its
  // endpoint was added.
  function repaint() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (histCount < 2) return;

    ctx.lineWidth = Math.max(1, S);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const paths = new Map();
    const start = (histHead - histCount + trail * 2) % trail;
    let prev = history[start];
    for (let k = 1; k < histCount; k++) {
      const cur = history[(start + k) % trail];
      let path = paths.get(cur.color);
      if (!path) {
        path = new Path2D();
        paths.set(cur.color, path);
      }
      path.moveTo(prev.x * cellSize + half, prev.y * cellSize + half);
      path.lineTo(cur.x * cellSize + half, cur.y * cellSize + half);
      prev = cur;
    }
    for (const [color, path] of paths) {
      ctx.strokeStyle = color;
      ctx.stroke(path);
    }
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator: run one step() (one new trail segment) per
  // (config.delay + OVERHEAD) microseconds, banking leftover time so the speed is
  // identical at any refresh rate. Cap catch-up so a backgrounded tab doesn't
  // burst on refocus.
  //
  // OVERHEAD: the xml *delay (10000) is only a sleep FLOOR; the live binary's real
  // per-step rate is (delay + framework/draw cost), so its effective fps is
  // 1e6/(delay+overhead), NOT 1e6/delay (see the framerate-calibration note).
  // critical is a sparse vector hack (one ~80xH grid scan + two line draws per
  // step). Live-measured: 56.0fps (Load 44.0%, clean) at stock delay 10000 ->
  // OVERHEAD 7850. Measured off the live -fps overlay, not by-eye.
  const OVERHEAD = 7850;         // microseconds (live-measured)
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

    repaint();
    rafId = requestAnimationFrame(frame);
  }

  // Rebuild after a non-live config change (re-seeds + repaints immediately).
  function reinit() {
    init();
    repaint();
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
