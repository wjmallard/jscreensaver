// lightning.js -- lightning packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's lightning.c (Keith Romberg, 1996-1997).
// https://www.jwz.org/xscreensaver/
//
// Crackling fractal lightning bolts. Each "storm" seeds 1-4 jagged bolts. A bolt
// is a top-to-bottom polyline built by midpoint-displacement subdivision (the C's
// generate(): recurse to a fixed depth, jittering each midpoint), with up to 2
// forks branching off to the ground. Every drawn frame the whole bolt is jittered
// again (wiggle_bolt) by a wiggle amount that decays toward zero -- so the bolt
// crackles for ~20 frames, dimming and flickering, then the storm dies and a fresh
// one strikes. Brightness is a per-frame "strike level": thin white, then a wider
// coloured glow + white core, with an explicit invisible "flash gap" mid-life.
//
// Rendering: genuinely line-shaped (XDrawLine per segment in the C), so this uses
// canvas VECTOR strokes -- one Path2D per bolt, stroked at 1-3 widths. The C fakes
// thickness by re-drawing the polyline at +/-1, +/-2 pixel offsets; canvas has a
// native lineWidth, so a strike level maps to a stroke width (white core over a
// coloured glow) -- same look, far fewer ops. See [[ccurve]] / [[forest]] for the
// recursive-subdivision twins; the fixed-timestep loop is the [[squiral]] one.

import { makeRandomColormapRGB } from './colormap.js';

export const title = 'lightning';

export const info = {
  author: 'Keith Romberg',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nCrackling fractal lightning bolts.',
  year: 1996,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/lightning.xml (1:1 with the original).
  // `delay` is microseconds; each step() advances ONE tick of the C's stage
  // machine, and a single drawn frame spans ~9 ticks (1 draw + 7 hold + 1 clear),
  // so the bolt crackles ~once per 9*delay. `ncolors` is MI_NPIXELS: the size of
  // the run's BRIGHT_COLORS colormap (make_random_colormap, built once), into
  // which each storm picks one random glow colour (st->color); <=2 colours draws
  // white bolts (the C's mono fallback). Both xml sliders kept; stock defaults.
  const config = {
    delay: 10000,      // microseconds between stage ticks (--delay)
    ncolors: 64,       // glow-hue palette size (--ncolors)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // --- constants, transcribed from lightning.c ---------------------------------
  const BOLT_NUMBER = 4;             // max simultaneous bolts in a storm
  const BOLT_ITERATION = 4;          // midpoint-displacement depth for the main bolt
  const LONG_FORK_ITERATION = 3;
  const MEDIUM_FORK_ITERATION = 2;
  const SMALL_FORK_ITERATION = 1;
  const WIDTH_VARIATION = 30;        // +/-15 px horizontal jitter per midpoint
  const HEIGHT_VARIATION = 15;       // +/-7 px vertical jitter per midpoint
  const DELAY_TIME_AMOUNT = 15;      // frames before a bolt first strikes
  const MULTI_DELAY_TIME_BASE = 5;   // extra stagger per bolt in a multi-strike
  const MAX_WIGGLES = 16;
  const WIGGLE_BASE = 8;
  const WIGGLE_AMOUNT = 14;          // initial per-frame jitter, decays to 0
  const RANDOM_FORK_PROBILITY = 4;   // % chance, per main vertex, of a fork
  const FIRST_LEVEL_STRIKE = 0;      // thin white
  const LEVEL_ONE_STRIKE = 1;        // glow + core, medium
  const LEVEL_TWO_STRIKE = 2;        // glow + core, widest
  const BOLT_VERTICIES = (1 << BOLT_ITERATION) - 1;   // 15 drawn middle points
  const FLASH_PROBILITY = 20;
  const MAX_FLASH_AMOUNT = 2;        // half the bolt's life is the flash window

  const WHITE = 'rgb(255,255,255)';

  // NRAND(n): integer in [0, n). Guarded so n<=0 -> 0: the C's NRAND(0) is a
  // modulo-by-zero crash, which the original avoids only because every bolt's
  // wiggle schedule is identical (shared draw_time) and all hit amount 0 the same
  // frame the storm goes inactive -- so the wiggle_line(..., 0) call never runs.
  // We keep that synchronisation but guard anyway, so a stray 0 stays finite.
  const nrand = (n) => (n <= 0 ? 0 : Math.floor(Math.random() * n));

  function distance(ax, ay, bx, by) {
    return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
  }

  let S = 1;            // devicePixelRatio
  let W = 0, H = 0;     // canvas size, device px
  let ncolors = 64;     // effective glow-palette size, 1..255
  let colors = null;    // the run's BRIGHT_COLORS map ([r,g,b] x ncolors); null = mono
  let promptNext = true; // make the first storm after init strike promptly
  let storm = null;     // the Storm struct (bolts + stage machine)

  // --- storm / bolt construction (the C's setup_multi_strike / random_storm) ----

  // How many bolts strike at once. Transcribed verbatim, gaps and all (prob 50
  // and 75 fall through to BOLT_NUMBER, exactly as in the C's if/else chain).
  function setupMultiStrike() {
    const p = nrand(100);
    if (p < 50) return 1;
    else if (p >= 51 && p < 75) return 2;
    else if (p >= 76 && p < 92) return 3;
    else return BOLT_NUMBER;
  }

  // The C's flashing_strike(): NRAND(20) <= 20 is ALWAYS true, so every bolt
  // flashes. Kept faithfully (the bug is load-bearing -- it's why bolts flicker).
  function flashingStrike() {
    const tmp = nrand(FLASH_PROBILITY);
    return tmp <= FLASH_PROBILITY ? 1 : 0;
  }

  // The invisible "flash gap" window, centred at half the bolt's life.
  function flashDuration(totalDuration) {
    const mid = Math.floor(totalDuration / MAX_FLASH_AMOUNT);
    const d = Math.floor(nrand(Math.floor(totalDuration / MAX_FLASH_AMOUNT)) / 2);
    return { start: mid - d, end: mid + d };
  }

  // generate(): midpoint displacement. Recurse to depth `iter`, writing each leaf
  // midpoint into verts[idx.n++]. Depth is fixed and tiny (<=4 for the bolt, <=3
  // for forks), so there is no stack / segment-count blow-up. Jitter is scaled by
  // S so the jaggedness stays proportional on retina.
  function generate(ax, ay, bx, by, iter, verts, idx) {
    const mx = (ax + bx) / 2 + (nrand(WIDTH_VARIATION) - WIDTH_VARIATION / 2) * S;
    const my = (ay + by) / 2 + (nrand(HEIGHT_VARIATION) - Math.floor(HEIGHT_VARIATION / 2)) * S;
    if (iter === 0) {
      verts[idx.n] = { x: mx, y: my };
      idx.n++;
      return;
    }
    generate(ax, ay, mx, my, iter - 1, verts, idx);
    generate(mx, my, bx, by, iter - 1, verts, idx);
  }

  // create_fork(): a branch from a main-bolt vertex down to the ground. The
  // subdivision depth (and so the vertex count) shrinks the lower down the bolt
  // the fork starts (level = the main vertex index).
  function createFork(fork, sx, sy, ex, ey, level) {
    fork.verts = [];
    fork.verts[0] = { x: sx, y: sy };
    const idx = { n: 1 };
    let numUsed;
    if (level <= 6) {
      generate(sx, sy, ex, ey, LONG_FORK_ITERATION, fork.verts, idx);
      numUsed = 9;
    } else if (level <= 11) {
      generate(sx, sy, ex, ey, MEDIUM_FORK_ITERATION, fork.verts, idx);
      numUsed = 5;
    } else if (distance(sx, sy, ex, ey) > 100 * S) {
      generate(sx, sy, ex, ey, MEDIUM_FORK_ITERATION, fork.verts, idx);
      numUsed = 5;
    } else {
      generate(sx, sy, ex, ey, SMALL_FORK_ITERATION, fork.verts, idx);
      numUsed = 3;
    }
    fork.verts[numUsed - 1] = { x: ex, y: ey };  // last leaf overwritten by the true endpoint
    fork.numUsed = numUsed;
  }

  // random_storm(): seed every bolt of the storm with fresh geometry + timing.
  function setupStorm() {
    storm.multiStrike = setupMultiStrike();
    storm.bolts = [];
    for (let i = 0; i < storm.multiStrike; i++) {
      const b = {};
      b.end1 = { x: nrand(W), y: 0 };
      b.end2 = { x: nrand(W), y: H };
      b.wiggleNumber = WIGGLE_BASE + nrand(MAX_WIGGLES);
      b.flash = flashingStrike();
      if (b.flash) {
        const fd = flashDuration(b.wiggleNumber);
        b.flashBegin = fd.start;
        b.flashStop = fd.end;
      } else {
        b.flashBegin = 0;
        b.flashStop = 0;
      }
      b.wiggleAmount = WIGGLE_AMOUNT;
      if (i === 0) b.delayTime = nrand(DELAY_TIME_AMOUNT);
      else b.delayTime = nrand(DELAY_TIME_AMOUNT) + MULTI_DELAY_TIME_BASE * i;
      // Make the opening strike of a freshly-initialised storm prompt, so the
      // screen isn't black for up to ~14 frames at load / resize / reinit.
      if (promptNext && i === 0) b.delayTime = nrand(2);
      b.strikeLevel = FIRST_LEVEL_STRIKE;

      // The main bolt: end1 -> middle[0..14] -> end2. generate() writes 2^4 = 16
      // leaves; the C's middle[] holds 15 and the 16th spills (harmlessly) into
      // the next struct field -- here it's just an extra array slot, never drawn.
      b.middle = [];
      generate(b.end1.x, b.end1.y, b.end2.x, b.end2.y, BOLT_ITERATION, b.middle, { n: 0 });

      b.forkNumber = 0;
      b.forksStart = [0, 0];
      b.branch = [
        { verts: [], numUsed: 0 },
        { verts: [], numUsed: 0 },
      ];
      b.visible = 0;
      for (let j = 0; j < BOLT_VERTICIES; j++) {
        if (b.forkNumber >= 2) break;
        if (nrand(100) < RANDOM_FORK_PROBILITY) {
          b.forksStart[b.forkNumber] = j;
          createFork(b.branch[b.forkNumber], b.middle[j].x, b.middle[j].y, nrand(W), H, j);
          b.forkNumber++;
        }
      }
      storm.bolts.push(b);
    }
    promptNext = false;
  }

  // --- per-frame update (the C's update_bolt / wiggle_bolt / wiggle_line) -------

  function wiggleLine(pts, number, amount) {
    const half = Math.floor(amount / 2);
    for (let i = 0; i < number; i++) {
      pts[i].x += (nrand(amount) - half) * S;
      pts[i].y += (nrand(amount) - half) * S;
    }
  }

  function wiggleBolt(b) {
    const half = Math.floor(b.wiggleAmount / 2);
    wiggleLine(b.middle, BOLT_VERTICIES, b.wiggleAmount);
    b.end2.x += (nrand(b.wiggleAmount) - half) * S;
    b.end2.y += (nrand(b.wiggleAmount) - half) * S;
    for (let i = 0; i < b.forkNumber; i++) {
      wiggleLine(b.branch[i].verts, b.branch[i].numUsed, b.wiggleAmount);
      // Re-anchor the fork base to its (now-wiggled) main vertex.
      b.branch[i].verts[0].x = b.middle[b.forksStart[i]].x;
      b.branch[i].verts[0].y = b.middle[b.forksStart[i]].y;
    }
    if (b.wiggleAmount > 1) b.wiggleAmount -= 1;
    else b.wiggleAmount = 0;
  }

  function updateBolt(b, timeNow) {
    wiggleBolt(b);
    if (b.wiggleAmount === 0 && b.wiggleNumber > 2) b.wiggleNumber = 0;
    if (timeNow % 3 === 0) b.wiggleAmount++;

    if (((timeNow >= b.delayTime) && (timeNow < b.flashBegin)) || (timeNow > b.flashStop))
      b.visible = 1;
    else
      b.visible = 0;

    if (timeNow === b.delayTime)
      b.strikeLevel = FIRST_LEVEL_STRIKE;
    else if (timeNow === b.delayTime + 1)
      b.strikeLevel = LEVEL_ONE_STRIKE;
    else if ((timeNow > b.delayTime + 1) && (timeNow <= b.delayTime + b.flashBegin - 2))
      b.strikeLevel = LEVEL_TWO_STRIKE;
    else if (timeNow === b.delayTime + b.flashBegin - 1)
      b.strikeLevel = LEVEL_ONE_STRIKE;
    else if (timeNow === b.delayTime + b.flashStop + 1)
      b.strikeLevel = LEVEL_ONE_STRIKE;
    else
      b.strikeLevel = LEVEL_TWO_STRIKE;
  }

  function stormActive() {
    let n = 0;
    for (let i = 0; i < storm.multiStrike; i++)
      if (storm.bolts[i].wiggleNumber > 0) n++;
    return n;
  }

  // --- drawing (the C's draw_bolt / first_/level1_/level2_strike) ---------------

  // The full bolt as one polyline path (end1 -> middle -> end2) plus each fork.
  function boltPath(b) {
    const p = new Path2D();
    p.moveTo(b.end1.x, b.end1.y);
    for (let i = 0; i < BOLT_VERTICIES; i++) p.lineTo(b.middle[i].x, b.middle[i].y);
    p.lineTo(b.end2.x, b.end2.y);
    for (let i = 0; i < b.forkNumber; i++) {
      const v = b.branch[i].verts;
      p.moveTo(v[0].x, v[0].y);
      for (let k = 1; k < b.branch[i].numUsed; k++) p.lineTo(v[k].x, v[k].y);
    }
    return p;
  }

  function strokeBolt(path, width, color) {
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke(path);
  }

  // Strike level -> stroke widths. The C re-draws the polyline at growing pixel
  // offsets (level 0: centre; level 1: +/-1 + centre; level 2: +/-2,+/-1 + centre)
  // with the outer copies coloured and the centre white. Native lineWidth gives
  // the same coloured-glow-with-white-core look in 1-2 strokes; the offset's
  // y-direction quirk in the C's draw_line() is moot since thick strokes join
  // cleanly. (Level 2's inner +/-1 glow band is fully covered, so it's dropped.)
  function drawBolt(b) {
    if (!b.visible) return;
    const path = boltPath(b);
    const glow = storm.color;
    if (b.strikeLevel === FIRST_LEVEL_STRIKE) {
      strokeBolt(path, S, WHITE);
    } else if (b.strikeLevel === LEVEL_ONE_STRIKE) {
      strokeBolt(path, 3 * S, glow);
      strokeBolt(path, S, WHITE);
    } else {
      strokeBolt(path, 5 * S, glow);
      strokeBolt(path, S, WHITE);
    }
  }

  // st->color = NRAND(MI_NPIXELS): pick a random entry of the run's colormap, once
  // per storm. The C builds that colormap ONCE at startup (the xlockmore layer:
  // BRIGHT_COLORS -> color_scheme_bright -> make_random_colormap(bright_p=True),
  // i.e. ncolors INDEPENDENT random colours -- hue 0-360 but saturation 30%-100% /
  // value 66%-100%, vivid but NOT full-saturation) and then only rotates this
  // index. <=2 colours -> white bolts (the C's MI_NPIXELS<=2 mono fallback).
  function pickColor() {
    if (!colors) return WHITE;
    const c = colors[nrand(colors.length)];
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  function clear() {
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, W, H);
  }

  // --- the stage machine (the C's draw_lightning switch); one tick per step() ---
  // 0: clear, pick colour, reset draw_time, arm.   1: draw+update bolts (+1 frame).
  // 2: hold the drawn frame for 7 ticks.            3: clear, loop while active.
  // 4: re-seed the whole storm (new geometry+timing) and drop back to stage 0.
  function step() {
    switch (storm.stage) {
      case 0:
        clear();
        storm.color = pickColor();
        storm.drawTime = 0;
        storm.stage = stormActive() ? 1 : 4;
        break;
      case 1:
        for (let i = 0; i < storm.multiStrike; i++) {
          if (storm.bolts[i].visible) drawBolt(storm.bolts[i]);
          updateBolt(storm.bolts[i], storm.drawTime);
        }
        storm.drawTime++;
        storm.stage = 2;
        storm.busyLoop = 0;
        break;
      case 2:
        if (++storm.busyLoop > 6) {
          storm.stage = 3;
          storm.busyLoop = 0;
        }
        break;
      case 3:
        clear();
        storm.stage = stormActive() ? 1 : 4;
        break;
      case 4:
        setupStorm();   // re-seed bolts (the C's init_lightning), then restart
        storm.stage = 0;
        break;
    }
  }

  // init_lightning(): size from the canvas, seed a fresh storm at stage 0.
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    ncolors = Math.min(255, Math.max(1, Math.round(config.ncolors)));
    // make_random_colormap(bright_p=True): ncolors fixed random bright colours,
    // built ONCE per run like the C (stage 0 only re-picks an index into it).
    // <=2 colours -> mono white bolts. Re-rolled on each init (reinit/resize), so
    // Math.random's order is fine -- only the bright distribution must match.
    colors = ncolors <= 2 ? null : makeRandomColormapRGB(ncolors, true);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    promptNext = true;
    clear();
    storm = {
      bolts: [],
      multiStrike: 0,
      color: WHITE,
      drawTime: 0,
      stage: 0,
      busyLoop: 0,
    };
    setupStorm();
    storm.stage = 0;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Fixed-timestep loop (squiral style): one stage tick per config.delay, banking
  // leftover time so the pace is the same at any refresh rate. Catch-up is capped
  // so a backgrounded tab can't burst a pile of ticks on refocus.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay lightning runs 60.2 fps, while the
  // port at the stock 10000 us ran ~100 ticks/sec (1.66x fast). 10000 + 6611 =
  // 16611 us -> 60.2 ticks/sec, matching the live binary. Applied to the per-tick
  // delay only, so the stage machine's tick COUNTS (the 7-tick hold, etc.) are
  // unchanged -- only the tick duration. A calibration, not a tuning knob.
  const OVERHEAD = 6611;
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
    reinit() { init(); },   // fresh storm with the current config
    config,
    params,
  };
}
