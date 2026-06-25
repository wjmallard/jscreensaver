// vermiculate.js — vermiculate packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's vermiculate.c (Tyler Pierce, 2001).
// https://www.jwz.org/xscreensaver/
//
// "To move in a worm-like manner" — a handful of worms crawl across the screen
// with smoothly turning headings, each laying down a thick coloured line trail.
// Each worm is a fixed-length snake: it plots a new segment at its head every
// step and erases the segment at its tail, so it slithers without saturating the
// field. Worms bounce off the screen border and off each other's trails (but
// pass through their own), ricocheting around until they jam, at which point the
// screen clears and a fresh set of worms is seeded.
//
// The meander is the whole point: each worm has one of seven "turn modes" — the
// random-walk-with-momentum / curvature engines from move() in the C — which is
// what makes the path wander smoothly instead of jittering like a plain random
// walk. The C's huge interactive scripting layer (keystroke macros, banks,
// grids, prey/follow, killwalls) is dropped; we keep only the autonomous worm
// behaviour the default/sample configurations produce. See [[squiral]] for the
// shared module skeleton and [[spiral]] for the circular-trail-buffer idiom.
//
// Rendering: like the C's sp() (XFillRectangle), each step stamps a small filled
// rect at the worm's head pixel in its hue and a black rect over the tail pixel
// it is erasing. Consecutive one-pixel-apart stamps overlap into a continuous
// thick coloured trail — accumulating onto the persistent canvas, no per-frame
// repaint. A 1-device-px collision grid (the C's point[]) backs the bounce logic
// so the ricochets match the original even though the trail looks thick. (Filled
// rects rather than Path2D polylines: identical to the C and free of the wrap-
// bridge / anti-aliased-sliver hazards a stroked-and-erased polyline would have.)

export const title = 'vermiculate';

export const info = {
  author: 'Tyler Pierce',
  description: 'Draws squiggly worm-like paths.',
  year: 2001,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/vermiculate.xml plus the C's own
  // constants (the xml only exposes Duration + fps). The xml's "Duration"
  // slider is the C's `speed` (1..1000); higher = the worms crawl faster
  // (waitabit() returns less idle time), so it is really a frame-rate control.
  // We map it through `delay` (the standard inverted frame-rate slider) and add
  // worm-count / colours / trail-length / curviness, which the C sets from the
  // chosen sample string. Defaults are tuned a touch calmer than stock.
  const config = {
    delay: 16000,     // microseconds between steps (frame rate)
    threads: 6,       // number of worms on screen (C default 4; samples vary)
    ncolors: 64,      // size of the hue cycle
    trail: 90,        // worm length in segments (C: random 30..199 per worm)
    curviness: 30,    // tightness of the meander (C's `curviness`, 5..50)
    border: true,     // draw a border the worms bounce off (C's bordcol)
    thickness: 2,     // line width in logical px (the C plots 1px dots)
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes worms/colours/grid, so a change re-runs
  //                init() via reinit() (which also clears the canvas).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 16000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'curviness', label: 'Curviness', type: 'range', min: 5, max: 50, step: 1, default: 30, lowLabel: 'loose', highLabel: 'tight', live: true },
    { key: 'threads', label: 'Worms', type: 'range', min: 1, max: 30, step: 1, default: 6, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'trail', label: 'Worm length', type: 'range', min: 10, max: 200, step: 5, default: 90, lowLabel: 'short', highLabel: 'long', live: false },
    { key: 'thickness', label: 'Thickness', type: 'range', min: 1, max: 8, step: 1, default: 2, lowLabel: 'thin', highLabel: 'thick', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'border', label: 'Border', type: 'checkbox', default: true, live: false },
  ];

  // --- the C's #defines, transcribed -----------------------------------------
  const DEGS = 360;            // degs
  const DEGS2 = DEGS / 2;      // degs2 (180)
  const DEGS4 = DEGS / 4;      // degs4 (90)
  const DEGS8 = DEGS / 8;      // degs8 (45)
  const RLMAX = 200;           // rlmax: max trail length
  const TMODES = 7;            // tmodes: number of turn modes

  // The C runs many move() rounds between idle waits (up to 1000), pacing by an
  // accumulated `speed` budget (waitabit). We let the lag accumulator pace the
  // frame rate via `delay`, and run a few move-rounds per step so a 1px/round
  // worm covers ground at a pleasant slither instead of inching one pixel/frame.
  const ROUNDS_PER_STEP = 3;
  // The C resets the whole field every `ticks` (20000) draw-rounds even if the
  // worms never jam, to keep things fresh. Scale to our per-round cadence.
  const MAX_TICKS = 8000;

  let S = 1;                   // devicePixelRatio
  let W, H;                    // canvas size, device px
  let wid, hei;                // collision-grid size = canvas size (1px cells)
  let point;                   // Uint8Array(wid*hei): plotted colour index, 0 = empty
  let palette;                 // ncolors CSS strings; palette[0] is unused (empty)
  let threads;                 // array of worm objects
  let tickc;                   // draw-round counter toward MAX_TICKS
  let resetPending;            // re-seed everything next step

  // Heading -> unit step. The C precomputes sinof[]/cosof[] over 360 integer
  // degrees and steps the worm by exactly one of those per move. (The C also
  // builds tanof[] for its prey-following mode, which this port drops.)
  const cosof = new Float64Array(DEGS);
  const sinof = new Float64Array(DEGS);
  (function buildTrig() {
    const dtor = Math.PI / DEGS2;
    for (let d = 0; d < DEGS; d++) {
      cosof[d] = Math.cos(d * dtor);
      sinof[d] = Math.sin(d * dtor);
    }
  })();

  function random1(n) {
    return Math.floor(Math.random() * n);   // ya_random() % n
  }

  // The C's wraparound(VAL,LOWER,UPPER): a single-step modular fold (it assumes
  // VAL is at most one period out of range, which is true for +/-1px moves and
  // <360 heading deltas). Returns the folded value.
  function wrapAround(val, lower, upper) {
    if (val >= upper) return val - (upper - lower);
    if (val < lower) return val + (upper - lower);
    return val;
  }

  // ncolors smooth-rainbow CSS strings (the C's random colormap; an even rainbow
  // reads better on the web). White when ncolors <= 1 (the C's mono fallback).
  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    palette = new Array(n);
    for (let i = 0; i < n; i++) {
      palette[i] = n > 1 ? `hsl(${(i * 360 / n)}, 100%, 55%)` : '#fff';
    }
  }

  // Grid accessors (the C's gp/sp). sp() only updates the 1px collision grid;
  // the visible pixel is painted separately by stamp() (a thickness-sized rect),
  // so a thick visible trail and a 1px collision footprint coexist (matches the
  // C's intent: worms ricochet off where ink is; the trail just looks thicker).
  function gp(x, y) {
    return point[wid * y + x];
  }
  function sp(x, y, c) {
    point[wid * y + x] = c;
  }

  // Seed one worm's per-run state (the C's newonscreen).
  function newOnScreen(LP) {
    LP.filled = false;
    LP.dead = false;
    LP.reclen = Math.min(RLMAX, Math.max(2, Math.round(config.trail)));
    LP.deg = random1(DEGS);
    LP.y = random1(hei);
    LP.x = random1(wid);
    LP.recpos = 0;
    LP.turnco = 2;
    LP.turnsize = random1(4) + 2;
    // Clear the trail ring so a respawn doesn't erase stale far-away pixels.
    LP.xrec.fill(0);
    LP.yrec.fill(0);
  }

  // Seed one worm's persistent state (the C's firstinit). `idx` is 1-based to
  // match the C's thr (1..threads), which seeds circturn's sign and magnitude.
  function firstInit(LP, idx) {
    // Grid marker, the C's `col = thr + 1`: 2, 3, 4, ... so it never equals the
    // border's colour 1 (worms must bounce off the border, not pass through it).
    // `col` is only a collision code; the visible colour is `hue` (see seedHue).
    LP.col = idx + 1;
    LP.tmode = random1(TMODES) + 1;    // the C defaults tmode 1 but samples spread 1..7
    LP.slice = Math.floor(DEGS / 3);
    LP.orichar = 'R';
    LP.spiturn = 5;
    LP.selfbounce = false;             // the C's default; bounce branches mirror it
    LP.ctinc = random1(2) * 2 - 1;     // +/-1
    LP.circturn = ((idx % 2) * 2 - 1) * ((idx - 1) % 7 + 1);
    LP.tsc = 1;
    LP.tslen = 6;
    LP.turnseq = [6, -6, 6, 6, -6, 6];
    LP.tclim = Math.floor(DEGS / 2 / 12);   // 15
  }

  // Give worm number `i` (0-based) a hue from the palette, spread so a handful
  // of worms land on distinct rainbow colours; with low ncolors they quantize
  // (and repeat) just as the C's small colormaps do.
  function seedHue(LP, i) {
    const n = Math.max(1, Math.round(config.threads));
    const idx = Math.round(i * palette.length / n) % palette.length;
    LP.hue = palette[idx];
  }

  function makeWorm(idx) {
    const LP = {
      xrec: new Int32Array(RLMAX + 1),
      yrec: new Int32Array(RLMAX + 1),
    };
    firstInit(LP, idx);
    seedHue(LP, idx - 1);
    newOnScreen(LP);
    return LP;
  }

  // Draw the border in colour 1 (the C's bordupdate with bordcorn 0): just the
  // TOP and LEFT edges, an L-shape — not a full rectangle. Worms that run off
  // the right/bottom wrap toroidally and are caught by this L on the far side
  // (so they still stay on screen). Marked in the collision grid and stroked
  // a neutral grey so it reads as structure, distinct from the coloured worms.
  function drawBorder() {
    if (!config.border) return;
    for (let x = 0; x < wid; x++) { sp(x, 0, 1); }
    for (let y = 0; y < hei; y++) { sp(0, y, 1); }
    ctx.strokeStyle = '#888';
    ctx.lineWidth = Math.max(1, Math.round(S));
    ctx.beginPath();
    ctx.moveTo(0.5 * S, 0);
    ctx.lineTo(0.5 * S, H);
    ctx.moveTo(0, 0.5 * S);
    ctx.lineTo(W, 0.5 * S);
    ctx.stroke();
  }

  // Compute the worm's next heading per its turn mode — move()'s big switch.
  // Faithful to the C: every branch mutates LP.deg (and its own turn-state) so
  // the meander is the algorithm's, not a substituted random walk.
  function turn(LP) {
    switch (LP.tmode) {
      case 1:
        // Bounded random nudge: a momentum-free wander whose step size is
        // turnsize. Small turnsize -> gentle curves; this is the plainest mode.
        LP.deg += random1(2 * LP.turnsize + 1) - LP.turnsize;
        break;
      case 2:
        // Axis-snapping wander: snaps to 45/90 deg grids, occasional big turns.
        if (LP.slice === DEGS || LP.slice === DEGS2 || LP.slice === DEGS4) {
          if (LP.orichar === 'D') {
            if (LP.deg % DEGS4 !== DEGS8) LP.deg = DEGS4 * random1(4) + DEGS8;
          } else if (LP.orichar === 'V') {
            if (LP.deg % DEGS4 !== 0) LP.deg = DEGS4 * random1(4);
          }
        }
        if (random1(100) === 0) {
          if (LP.slice === 0) LP.deg = LP.deg - DEGS4 + random1(DEGS2);
          else LP.deg += (random1(2) * 2 - 1) * LP.slice;
        }
        break;
      case 3:
        // Constant curvature: a steady arc (circturn deg/step) -> big loops.
        LP.deg += LP.circturn;
        break;
      case 4:
        // Spiral: the turn rate (spiturn) itself drifts and reverses, so the
        // worm winds in and out of spirals.
        if (Math.abs(LP.spiturn) > 11) LP.spiturn = 5;
        else LP.deg += LP.spiturn;
        if (random1(15 - Math.abs(LP.spiturn)) === 0) {
          LP.spiturn += LP.ctinc;
          if (Math.abs(LP.spiturn) > 10) LP.ctinc *= -1;
        }
        break;
      case 5:
        // Curvy meander: arc one way for ~curviness steps, then flip — the
        // classic vermiculate squiggle. Uses the live `curviness`.
        LP.turnco = Math.abs(LP.turnco) - 1;
        if (LP.turnco === 0) {
          LP.turnco = Math.round(config.curviness) + random1(10);
          LP.circturn *= -1;
        }
        LP.deg += LP.circturn;
        break;
      case 6:
        // Alternating straights and arcs (turnco state machine).
        if (Math.abs(LP.turnco) === 1) {
          LP.turnco *= -1 * (random1(Math.floor(DEGS2 / Math.abs(LP.circturn))) + 5);
        } else if (LP.turnco === 0) {
          LP.turnco = 2;
        } else if (LP.turnco > 0) {
          LP.turnco--;
          LP.deg += LP.circturn;
        } else {
          LP.turnco++;
        }
        break;
      case 7:
        // Scripted turn sequence: cycles a list of per-step deltas (turnseq),
        // each held tclim steps -> repeating decorative figures.
        LP.turnco++;
        if (LP.turnco > LP.tclim) {
          LP.turnco = 1;
          LP.tsc = (LP.tsc % LP.tslen) + 1;
        }
        LP.deg += LP.turnseq[LP.tsc - 1];
        break;
    }
  }

  // One worm step — the C's move(). Returns true if the worm is still alive.
  // Stamps its head pixel and erases its tail pixel on the canvas; updates the
  // collision grid; handles border / cross-trail bounces.
  function move(LP) {
    if (LP.dead) return false;

    turn(LP);
    LP.deg = wrapAround(LP.deg, 0, DEGS);

    const oldy = LP.y;
    const oldx = LP.x;
    LP.x = wrapAround(LP.x + cosof[LP.deg], xMin, xMax + 1);
    LP.y = wrapAround(LP.y + sinof[LP.deg], yMin, yMax + 1);

    let xi = LP.x | 0;
    let yi = LP.y | 0;
    // Defensive clamp (float wrap can land exactly on the upper bound).
    if (xi > xMax) xi = xMax; else if (xi < 0) xi = 0;
    if (yi > yMax) yi = yMax; else if (yi < 0) yi = 0;

    const oldcol = gp(xi, yi);
    if (oldcol !== 0) {
      // Something is already inked here. With selfbounce off (the default), a
      // different colour (another worm or the border) -> reverse (deg += 180)
      // and stay put; the worm's own colour -> pass straight through. (The C's
      // realbounce/killwalls reflection paths, needing a grid, are dropped.)
      if (oldcol !== LP.col && LP.selfbounce) {
        LP.deg += DEGS4 * (random1(2) * 2 - 1);
      } else if (oldcol !== LP.col) {
        LP.deg += DEGS2;
      } else if (oldcol === LP.col && LP.selfbounce) {
        LP.deg += DEGS4 * (random1(2) * 2 - 1);
      }
      if (oldcol !== LP.col || LP.selfbounce) {
        // Don't advance into the obstacle: snap back to the previous cell.
        LP.x = oldx;
        LP.y = oldy;
        xi = oldx | 0;
        yi = oldy | 0;
        if (xi > xMax) xi = xMax; else if (xi < 0) xi = 0;
        if (yi > yMax) yi = yMax; else if (yi < 0) yi = 0;
      }
      LP.deg = wrapAround(LP.deg, 0, DEGS);
    }

    // Plot the head pixel into the collision grid and stamp it on the canvas.
    // Like the C's sp() (XFillRectangle of pscale x pscale): consecutive
    // one-pixel-apart stamps overlap into a continuous thick colour trail.
    sp(xi, yi, LP.col);
    stamp(xi, yi, LP.hue);

    // Erase the tail: the C, with erasing on, blanks the oldest recorded pixel
    // once the ring is full, keeping each worm a fixed-length snake. We re-read
    // the grid first so we never erase ink a newer head (this worm or another)
    // has since laid over that cell — that would punch holes in a live trail.
    if (LP.filled) {
      const ex = LP.xrec[LP.recpos];
      const ey = LP.yrec[LP.recpos];
      if (gp(ex, ey) === LP.col) {
        sp(ex, ey, 0);
        stamp(ex, ey, '#000');
      }
    }

    // Record this head position in the trail ring.
    LP.yrec[LP.recpos] = yi;
    LP.xrec[LP.recpos] = xi;
    if (LP.recpos === LP.reclen - 1) LP.filled = true;

    LP.recpos++;
    LP.recpos = wrapAround(LP.recpos, 0, LP.reclen);
    return !LP.dead;
  }

  // Stamp a thickness-sized rect centred on grid pixel (gx,gy), in device px.
  // Centring makes the trail width symmetric about the 1px collision path.
  function stamp(gx, gy, style) {
    ctx.fillStyle = style;
    ctx.fillRect(gx - half, gy - half, lineW, lineW);
  }

  // Wipe the field and re-seed the worms (the C's reset_p block + clearscreen).
  function doReset() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    point.fill(0);
    for (let i = 0; i < threads.length; i++) {
      threads[i].col = i + 2;   // grid marker, never 1 (the border)
      seedHue(threads[i], i);   // fresh rainbow spread each reset
      newOnScreen(threads[i]);
    }
    drawBorder();
  }

  let xMin, xMax, yMin, yMax;   // grid bounds (the C's xmin..ymax)
  let lineW;                    // trail stamp size in device px (the C's pscale)
  let half;                     // half of lineW, for centring the stamp

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // Collision grid at 1 device px per cell, like the C's point[wid*hei].
    wid = W;
    hei = H;
    xMin = 0; yMin = 0; xMax = wid - 1; yMax = hei - 1;

    // Trail stamp size: thickness in logical px, scaled to device px (the C's
    // pscale, which it bumps to 3 on retina). Centre the stamp so the visible
    // trail straddles the 1px collision path symmetrically.
    lineW = Math.max(1, Math.round(config.thickness * S));
    half = (lineW - 1) >> 1;

    point = new Uint8Array(wid * hei);
    buildPalette();

    // Build the worm pool (one per `threads`). A change to the worm count is a
    // non-live param, so it re-runs init() via reinit() and rebuilds the pool.
    threads = [];
    const pool = Math.max(Math.round(config.threads), 1);
    for (let i = 1; i <= pool; i++) threads.push(makeWorm(i));

    tickc = 0;
    resetPending = true;   // first step seeds + draws, so frame 1 already draws
  }

  // One animation step: optionally reset, then advance every worm a batch of
  // move-rounds, and clear the field if all worms jam or the tick budget runs
  // out. With erasing on (always, here) worms never set `dead`, so as in the C
  // the periodic tick-budget reset is what keeps the field fresh.
  function step() {
    if (resetPending) {
      resetPending = false;
      doReset();
    }

    for (let r = 0; r < ROUNDS_PER_STEP; r++) {
      let allTrapped = true;
      for (const LP of threads) {
        if (move(LP)) allTrapped = false;
      }
      if (allTrapped) resetPending = true;
    }

    if (tickc++ > MAX_TICKS) {
      tickc = 0;
      resetPending = true;
    }
  }

  function reinit() {
    init();
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
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

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
