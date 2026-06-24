// vermiculate.js — vermiculate packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's vermiculate.c (Tyler Pierce, 2001).
// https://www.jwz.org/xscreensaver/
//
// "To move in a worm-like manner" — a handful of worms crawl across the screen
// with smoothly turning headings, each laying down a thin coloured line trail.
// Worms bounce off each other's trails (but pass through their own) and off an
// optional border, ricocheting around the field. The C runs one of ~10 random
// sample programs at startup, and about half of them turn "erasing" off; we mirror
// that by picking one of two modes at random on each reset:
//   - SLITHER (erasing on): each worm is a fixed-length snake — it plots a segment
//     at its head and erases the one at its tail every step, so it slithers without
//     ever saturating the field, and (as in the C) never resets.
//   - ACCUMULATE (erasing off): the tail is not erased but frozen into a PERMANENT
//     trail; a worm dies once it wedges (its whole trail collapses to a point), and
//     when all worms have died the field clears, re-rolls the palette, and re-seeds.
//
// The meander is the whole point: each worm has one of seven "turn modes" — the
// random-walk-with-momentum / curvature engines from move() in the C — which is
// what makes the path wander smoothly instead of jittering like a plain random
// walk. The C's huge interactive scripting layer (keystroke macros, banks,
// grids, prey/follow, killwalls) is dropped; we keep only the autonomous worm
// behaviour the default/sample configurations produce. See [[squiral]] for the
// shared module skeleton and [[spiral]] for the circular-trail-buffer idiom.
//
// Rendering: like the C's sp() (XFillRectangle of pscale x pscale), each step
// stamps a filled rect at the worm's head pixel in the worm's colour, and over the
// tail pixel either a black rect (slither) or a frozen-colour rect (accumulate).
// pscale is 1 device px (3 on a very large / retina backing store), so the worms
// are thin — consecutive one-px-apart stamps overlap into a continuous trail —
// accumulating onto the persistent canvas, no per-frame repaint. A 1-device-px
// collision grid (the C's point[]) backs the bounce logic. Colours come from the
// C's random BRIGHT colormap (make_random_colormap, bright_p=True — independent
// random HSV, NOT an even hue ramp): the head in mycolors[col], the frozen trail
// in mycolors[col + thrmax]. (Filled rects rather than Path2D polylines: identical
// to the C and free of the wrap-bridge / anti-aliased-sliver hazards a stroked-
// and-erased polyline would have.)

import { makeRandomColormapRGB } from './colormap.js';

export const title = 'vermiculate';

export const info = {
  author: 'Tyler Pierce',
  description: 'Squiggly worm-like paths.',
  year: 2001,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // The xml exposes only Duration (the C's `speed`, 1..1000) + fps. `speed` is a
  // frame-rate control (higher = worms crawl faster: waitabit() returns less idle
  // time, the C batching more move-rounds per 10ms sleep); we map that intent onto
  // the standard inverted `delay` slider. Everything else the C sets from a random
  // sample string (an un-portable keystroke program), so there is no xml resource
  // for it \u2014 `threads`, `curviness` and `border` are exposed as adaptation knobs
  // that mirror the C's *interactive* controls (the ']'/'[' worm add/remove,
  // '/'/'*' curviness, and 'B' border toggle); each uses the C's own default and
  // range. There is no colour or trail-length knob: the palette is always the C's
  // random BRIGHT colormap and every worm's length is randomised per the C.
  const config = {
    delay: 10000,     // microseconds/frame; the C's waitabit 10ms quantum (Duration)
    threads: 12,      // number of worms (C: maininit default 4; samples run 3..62)
    curviness: 30,    // tightness of the meander (C's `curviness`, 5..50, default 30)
    border: false,    // draw the containing L-border; off by default, as the live
                      // usually is (nearly every sample string toggles bordcol off)
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes worms/palette/grid, so a change re-runs
  //                init() via reinit() (which also clears the canvas).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'curviness', label: 'Curviness', type: 'range', min: 5, max: 50, step: 1, default: 30, lowLabel: 'loose', highLabel: 'tight', live: true },
    { key: 'threads', label: 'Worms', type: 'range', min: 1, max: 60, step: 1, default: 12, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'border', label: 'Border', type: 'checkbox', default: false, live: false },
  ];

  // --- the C's #defines, transcribed -----------------------------------------
  const DEGS = 360;            // degs
  const DEGS2 = DEGS / 2;      // degs2 (180)
  const DEGS4 = DEGS / 4;      // degs4 (90)
  const DEGS8 = DEGS / 8;      // degs8 (45)
  const RLMAX = 200;           // rlmax: max trail length
  const TMODES = 7;            // tmodes: number of turn modes
  const THRMAX = 120;          // thrmax: the C's max thread count; also the frozen-
                               // trail colour offset (accumulate mode: col + thrmax)
  const TAILMAX = THRMAX * 2 + 1;   // tailmax (241): size of the C's mycolors[]

  // The C batches many move() rounds per idle wait: waitabit() adds `threads` to
  // an accumulator each round and only sleeps 10ms once it crosses `speed`, so it
  // runs ~speed/threads rounds per frame and a worm advances that many px per 10ms
  // (per-worm speed is normalised by the thread count). We reproduce that: each
  // fixed step runs round(SPEED_BUDGET / threads) move-rounds and the accumulator
  // sleeps `delay` (the 10ms quantum) between them. SPEED_BUDGET is the port's
  // analog of the sample string's `speed`, picked for a faithful ~1500 px/s worm
  // slither at the default thread count.
  const SPEED_BUDGET = 240;
  // Framework + draw cost added to the delay floor so the port never runs faster
  // than the 10ms quantum implies (see the framerate note). Live-measured: 52.5fps
  // (Load 47.5%, clean) at delay 10000 -> OVERHEAD 9050 (matches the live frame rate;
  // final slither speed also depends on SPEED_BUDGET -- eyeball vs live).
  const OVERHEAD = 9050;

  let W, H;                    // canvas size, device px
  let wid, hei;                // collision-grid size = canvas size (1px cells)
  let point;                   // Uint8Array(wid*hei): plotted colour index, 0 = empty
  let palette;                 // CSS strings, one per colour code; [0] = black (empty)
  let threads;                 // array of worm objects
  let erasing;                 // C's st->erasing: true = slither (erase tails),
                               // false = accumulate (freeze tails, worms die + reset)
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

  // The C's randpal(): make_random_colormap(&mycolors[1], &ncolors=tailmax-1=240,
  // ..., bright_p=True, ...) fills mycolors[1..240] with INDEPENDENT random BRIGHT
  // colours — H random 0..360, S random 30..100%, V random 66..100% (so anything
  // from vivid to near-white), NOT an even hue ramp. mycolors[0] is black (the
  // empty cell). We build the whole 240-entry map like the C, because accumulate
  // mode draws frozen trails in mycolors[col + thrmax] (col 2..threads+1, so the
  // frozen index reaches ~181) as well as the worm head in mycolors[col] and the
  // border in mycolors[1]. makeRandomColormapRGB(n,true) is the faithful port.
  // Re-rolled on each accumulate reset (the C's autopal), fixed otherwise.
  function buildPalette() {
    const rgb = makeRandomColormapRGB(TAILMAX - 1, true);   // 240 random bright
    palette = new Array(TAILMAX);
    palette[0] = '#000';                                    // colour 0 = empty / erase
    for (let i = 0; i < rgb.length; i++) {
      palette[i + 1] = `rgb(${rgb[i][0]},${rgb[i][1]},${rgb[i][2]})`;
    }
  }

  // Grid accessors (the C's gp/sp). sp() only updates the 1px collision grid;
  // the visible pixel is painted separately by stamp() (a pscale-sized rect). The
  // grid footprint is always 1px even when pscale is 3, matching the C (worms
  // ricochet off where ink is; the trail is just drawn a little wider).
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
    // The C's newonscreen: reclen = random1(rlmax - 30) + 30 = 30..199 per worm
    // (the `little` variant, random1(10)+5, is only set by a keystroke we drop).
    LP.reclen = random1(RLMAX - 30) + 30;
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
    // The C's `col = thr + 1`: 2, 3, 4, ... It is BOTH the collision code (never 1,
    // the border, so worms bounce off it) AND the colormap index — the worm draws
    // in palette[col] (the C's mycolors[col]), exactly as the original conflates
    // the two. So worm colours are consecutive entries of the random bright map.
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

  function makeWorm(idx) {
    const LP = {
      xrec: new Int32Array(RLMAX + 1),
      yrec: new Int32Array(RLMAX + 1),
    };
    firstInit(LP, idx);   // sets col = idx + 1, the palette index for this worm
    newOnScreen(LP);
    return LP;
  }

  // Draw the border in colour 1 (the C's bordupdate with bordcorn 0): just the
  // TOP and LEFT edges, an L-shape — not a full rectangle. Worms that run off
  // the right/bottom wrap toroidally and are caught by this L on the far side
  // (so they still stay on screen). Marked in the collision grid and painted in
  // palette[1] (the C's mycolors[1], its own random bright colour), pscale-thick
  // like the C's sp() rects. (Most sample strings toggle the border off via 'B';
  // the C's pre-sample default, mirrored here, is on.)
  function drawBorder() {
    if (!config.border) return;
    for (let x = 0; x < wid; x++) { sp(x, 0, 1); }
    for (let y = 0; y < hei; y++) { sp(0, y, 1); }
    ctx.fillStyle = palette[1];
    ctx.fillRect(0, 0, W, lineW);
    ctx.fillRect(0, 0, lineW, H);
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

    // Plot the head pixel into the collision grid and stamp it on the canvas in
    // this worm's colour, palette[col] (the C's sp() -> mycolors[col]). Consecutive
    // one-pixel-apart stamps overlap into a continuous colour trail.
    sp(xi, yi, LP.col);
    stamp(xi, yi, palette[LP.col]);

    // Handle the tail once the ring is full (the C's move(), vermiculate.c:672-678):
    //  - erasing ON (slither): blank the oldest recorded pixel, so the worm stays a
    //    fixed-length snake. We re-read the grid first so we never erase ink a newer
    //    head (this worm or another) has since laid over that cell — that would punch
    //    a hole in a live trail (worms bounce off each other, so this is rare).
    //  - erasing OFF (accumulate): recolour the oldest pixel to `col + thrmax` — a
    //    DIFFERENT random-bright entry — freezing it as a PERMANENT trail. The worm
    //    thus leaves a lasting mark behind its reclen-long moving head.
    if (LP.filled) {
      const ex = LP.xrec[LP.recpos];
      const ey = LP.yrec[LP.recpos];
      if (erasing) {
        if (gp(ex, ey) === LP.col) {
          sp(ex, ey, 0);
          stamp(ex, ey, '#000');
        }
      } else {
        const fc = LP.col + THRMAX;
        sp(ex, ey, fc);
        stamp(ex, ey, palette[fc]);
      }
    }

    // Record this head position in the trail ring.
    LP.yrec[LP.recpos] = yi;
    LP.xrec[LP.recpos] = xi;
    if (LP.recpos === LP.reclen - 1) LP.filled = true;

    // Accumulate mode only (the C, vermiculate.c:683-697): a worm DIES once its whole
    // reclen-long trail has collapsed to a single point — i.e. it is wedged and can no
    // longer advance (every move bounces it back to the same cell). Scan the ring; the
    // worm is dead unless some consecutive pair of recorded positions differ.
    if (LP.filled && !erasing) {
      let co = LP.recpos;
      LP.dead = true;
      do {
        const nextco = wrapAround(co + 1, 0, LP.reclen);
        if (LP.yrec[co] !== LP.yrec[nextco] || LP.xrec[co] !== LP.xrec[nextco]) {
          LP.dead = false;
        }
        co = nextco;
      } while (!(!LP.dead || co === LP.recpos));
    }

    LP.recpos++;
    LP.recpos = wrapAround(LP.recpos, 0, LP.reclen);
    return !LP.dead;
  }

  // Stamp a pscale-sized rect at grid pixel (gx,gy), in device px — exactly the
  // C's sp(): XFillRectangle(x, y, pscale, pscale), top-left at the pixel.
  function stamp(gx, gy, style) {
    ctx.fillStyle = style;
    ctx.fillRect(gx, gy, lineW, lineW);
  }

  // Clear the field and re-seed the worms (the C's reset_p block + clearscreen).
  // The C picks a random one of ~10 sample programs at startup and ~half of them
  // turn `erasing` OFF (accumulate mode). We reproduce that spread by choosing the
  // mode at random here — no user knob, which would be invented — at the C's ~50%
  // rate (exactly 5 of the 10 active sample strings turn erasing off). Slither mode
  // then never resets again (worms can't die with erasing on, matching the C, so it
  // is effectively absorbing within a session); accumulate mode resets each time all
  // worms wedge, and every such reset re-rolls the palette (the C's `autopal`, which
  // all the erasing-off samples set). Re-run / reload to sample both modes.
  function doReset() {
    erasing = Math.random() < 0.5;
    if (!erasing) buildPalette();   // autopal re-roll for the accumulate session
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    point.fill(0);
    for (let i = 0; i < threads.length; i++) {
      threads[i].col = i + 2;   // grid + colormap marker, never 1 (the border)
      newOnScreen(threads[i]);
    }
    drawBorder();
  }

  let xMin, xMax, yMin, yMax;   // grid bounds (the C's xmin..ymax)
  let lineW;                    // trail stamp size in device px (the C's pscale)

  function init() {
    W = canvas.width;
    H = canvas.height;

    // Collision grid at 1 device px per cell, like the C's point[wid*hei].
    wid = W;
    hei = H;
    xMin = 0; yMin = 0; xMax = wid - 1; yMax = hei - 1;

    // Trail stamp size = the C's pscale: 1 device px normally, 3 on a very large
    // (retina) backing store. Not user-configurable in the C, so no knob.
    const pscale = (W > 2560 || H > 2560) ? 3 : 1;
    lineW = pscale;

    point = new Uint8Array(wid * hei);
    buildPalette();

    // Build the worm pool (one per `threads`). A change to the worm count is a
    // non-live param, so it re-runs init() via reinit() and rebuilds the pool.
    threads = [];
    const pool = Math.max(Math.round(config.threads), 1);
    for (let i = 1; i <= pool; i++) threads.push(makeWorm(i));

    resetPending = true;   // first step seeds + draws, so frame 1 already draws
  }

  // One animation step: optionally reset, then advance every worm a batch of
  // move-rounds. The C's `alltrap` reset fires when every worm is trapped: in
  // SLITHER mode (erasing on) worms never set `dead`, so it never fires and that
  // mode runs forever without clearing (the C's periodic `ticks` reset is dead
  // code — `tick` is a per-call local AND `had_instring` stays true once a sample
  // string is consumed, so `tick > ticks` is unreachable). In ACCUMULATE mode
  // (erasing off) worms die as they wedge, and once all are trapped the field
  // clears and re-seeds via doReset (which re-picks the mode) — the C's behaviour.
  function step() {
    if (resetPending) {
      resetPending = false;
      doReset();
    }

    const rounds = Math.max(1, Math.round(SPEED_BUDGET / threads.length));
    for (let r = 0; r < rounds; r++) {
      let allTrapped = true;
      for (const LP of threads) {
        if (move(LP)) allTrapped = false;
      }
      if (allTrapped) resetPending = true;
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

  // rAF lag-accumulator paced by (config.delay + OVERHEAD) (µs): run one step()
  // per frame, banking leftover time so the speed is identical at any refresh
  // rate. Cap catch-up so a backgrounded tab doesn't burst a run of steps on
  // refocus. OVERHEAD keeps the effective rate at/under the delay floor.
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
