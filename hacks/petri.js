// petri.js — petri packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's petri.c by Dan Bornstein (1992-1999).
// https://www.jwz.org/xscreensaver/
//
// Competing molds spread across a toroidal grid. Each living cell accumulates
// "growth" at its speed; once growth passes orthlim it seeds its 4 orthogonal
// neighbours, and once past diaglim it seeds all 8 and then settles. A just-born
// cell is painted in its mould's BRIGHT shade and redrawn at HALF intensity once
// it settles, so each colony reads as a bright expanding ring filling in dim
// behind it. Random "blips" sprinkle new colonies; when a colony's lifespan
// expires a "black death" (colour 0, white-fronted) wave eats the molds — or the
// dish is wiped clean outright (instantdeathchan). Only the active growth front
// is on a doubly-linked list, head-inserted exactly as petri.c, so it stays
// cheap AND resolves contested cells in the same order the original does (older
// colony wins, because newer cells sit ahead of it and are visited first).
//
// Palette: the C's setup_random_colormap — make_random_colormap with bright_p
// (random hue, 30-100% saturation, 66-100% value, NOT a full-saturation rainbow)
// — gives the count-1 mould fronts; each settled shade is that colour halved.
// colour 0 = black (background), its "bright" twin = white (the death front).

import { makeRandomColormapRGB } from './colormap.js';

export const title = 'petri';

export const info = {
  author: 'Dan Bornstein',
  description: 'Colonies of mold grow in a petri dish. Growing colored circles overlap and leave spiral interference in their wake.',
  year: 1999,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/petri.xml so the config box maps 1:1 to
  // the original. `delay` is the usleep interval in microseconds; the speeds are
  // fractions of the maximum, scaled by diaglim exactly as setup_display does.
  const config = {
    delay: 10000,            // µs between iterations (--delay)
    size: 2,                 // cell size in px (--size)
    count: 20,               // number of mould varieties (--count, min 2)
    diaglim: 1.414,          // diagonal growth limit: 1 square, ~1.414 round, 2 diamond
    anychan: 0.0015,         // chance per iteration a new colony is born
    minorchan: 0.5,          // chance a birth event is "minor" (2 cells)
    instantdeathchan: 0.2,   // chance a death event wipes the dish instead of a plague
    minlifespan: 500,        // colony lifespan range (iterations) before black death
    maxlifespan: 1500,
    minlifespeed: 0.04,      // living-cell speed range (fraction of max)
    maxlifespeed: 0.13,
    mindeathspeed: 0.42,     // black-death speed range
    maxdeathspeed: 0.46,
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'diaglim', label: 'Colony shape', type: 'range', min: 1, max: 2, step: 0.001, default: 1.414, lowLabel: 'square', highLabel: 'diamond', live: true },
    { key: 'anychan', label: 'Fertility', type: 'range', min: 0, max: 0.25, step: 0.0005, default: 0.0015, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'minorchan', label: 'Offspring', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5, lowLabel: 'few', highLabel: 'many', live: true },
    { key: 'instantdeathchan', label: 'Death comes', type: 'range', min: 0, max: 1, step: 0.01, default: 0.2, lowLabel: 'slowly', highLabel: 'quickly', live: true },
    { key: 'minlifespeed', label: 'Min growth', type: 'range', min: 0, max: 1, step: 0.01, default: 0.04, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'maxlifespeed', label: 'Max growth', type: 'range', min: 0, max: 1, step: 0.01, default: 0.13, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'mindeathspeed', label: 'Min death', type: 'range', min: 0, max: 1, step: 0.01, default: 0.42, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'maxdeathspeed', label: 'Max death', type: 'range', min: 0, max: 1, step: 0.01, default: 0.46, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'minlifespan', label: 'Min lifespan', type: 'range', min: 0, max: 3000, step: 10, default: 500, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'maxlifespan', label: 'Max lifespan', type: 'range', min: 0, max: 3000, step: 10, default: 1500, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'size', label: 'Cell size', type: 'range', min: 1, max: 12, step: 1, default: 2, unit: ' px', lowLabel: 'fine', highLabel: 'coarse', live: false },
    { key: 'count', label: 'Mold varieties', type: 'range', min: 2, max: 20, step: 1, default: 20, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  const ORTHLIM = 1;
  // all_coords from petri.c: the 4 DIAGONALS, then the 4 ORTHOGONALS. growth past
  // diaglim seeds all 8 (start 0); growth past orthlim seeds the orthogonals only
  // (start 8) — mirroring `coords = all_coords` vs `coords = &all_coords[4]`.
  const COORDS = [-1, -1, -1, 1, 1, -1, 1, 1, -1, 0, 1, 0, 0, -1, 0, 1];

  let W, H, cellPx, count, offsetX, offsetY;
  let col, growth, speed, isnext, nextcol, nextspeed, next, prev;  // per-cell arrays
  let HEAD, TAIL;       // sentinel indices into next[]/prev[] (the C's head/tail)
  let blastcount;       // iterations until the next death event
  let colors;           // 2*count CSS colours: [0..count) dim, [count..2count) bright
  let lastFill = null;

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  // random_life_value: a lifespan in [minlifespan, maxlifespan) (minlifespan >= 1,
  // maxlifespan >= minlifespan, exactly as setup_display clamps them).
  function randLife() {
    const lo = Math.max(1, config.minlifespan);
    const hi = Math.max(lo, config.maxlifespan);
    return (Math.random() * (hi - lo) + lo) | 0;
  }

  // setup_random_colormap: count-1 BRIGHT random colours (make_random_colormap,
  // bright_p) for the growing fronts; each settled shade is that colour halved
  // (colors[n] = colors[n+count]/2). colour 0 dim = black (background), bright =
  // white (the death front). Not rebuilt on instantdeath wipes — only on reinit.
  function buildColors() {
    colors = new Array(count * 2);
    colors[0] = '#000';
    colors[count] = '#fff';
    const bright = makeRandomColormapRGB(count - 1, true);
    for (let n = 1; n < count; n++) {
      const [r, g, b] = bright[n - 1];
      colors[n + count] = `rgb(${r},${g},${b})`;            // bright (growing)
      colors[n] = `rgb(${r >> 1},${g >> 1},${b >> 1})`;     // dim (settled, half)
    }
  }

  function drawblock(idx, c) {
    const s = colors[c];
    if (s !== lastFill) { ctx.fillStyle = s; lastFill = s; }
    const x = idx % W;
    const y = (idx / W) | 0;
    ctx.fillRect(x * cellPx + offsetX, y * cellPx + offsetY, cellPx, cellPx);
  }

  // Queue cell `idx` to become colour `c` at speed `sp`, and splice it onto the
  // FRONT of the growth list (head insertion, exactly as the C) if not already on
  // it. A cell already showing `c` is left alone, so molds don't re-seed their own
  // interior and death can't spread across the void.
  function newcell(idx, c, sp) {
    if (col[idx] === c) return;
    nextcol[idx] = c;
    nextspeed[idx] = sp;
    isnext[idx] = 1;
    if (prev[idx] === -1) {           // not on the list yet
      const a = next[HEAD];
      next[idx] = a;
      prev[idx] = HEAD;
      next[HEAD] = idx;
      prev[a] = idx;
    }
  }

  // Unlink `idx`, stop it growing, and paint it the settled (dim) shade. next[idx]
  // is left intact so the growth-pass iterator can still step off a just-killed
  // cell, exactly as petri.c's killcell relies on.
  function killcell(idx) {
    const p = prev[idx], nx = next[idx];
    next[p] = nx;
    prev[nx] = p;
    prev[idx] = -1;
    speed[idx] = 0;
    drawblock(idx, col[idx]);
  }

  // setup_arr: wipe the dish (clear the canvas, empty the list, zero every cell)
  // and re-arm the death countdown. The palette is NOT rebuilt here (the C keeps
  // it across instantdeath wipes).
  function clearArr() {
    lastFill = null;
    ctx.fillStyle = colors[0];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    col.fill(0); growth.fill(0); speed.fill(0);
    isnext.fill(0); nextcol.fill(0); nextspeed.fill(0);
    prev.fill(-1);
    next[HEAD] = TAIL; prev[HEAD] = HEAD;
    next[TAIL] = TAIL; prev[TAIL] = HEAD;
    blastcount = randLife();
  }

  // randblip: sprinkle new cells — living colonies most of the time, a black-
  // death plague (or a full wipe) when the lifespan counter runs out. `doit`
  // forces a birth (used when the dish is empty). The blastcount-- post-decrement
  // and short-circuit order match the C exactly.
  function randblip(doit) {
    const dl = clamp(config.diaglim, 1, 2) * ORTHLIM;
    let b = 0;
    let n;

    if (!doit && (blastcount-- >= 0) && (Math.random() > config.anychan)) return;

    if (blastcount < 0) {
      b = 1;
      n = 2;
      blastcount = randLife();
      if (Math.random() < config.instantdeathchan) { clearArr(); b = 0; }
    } else if (Math.random() <= config.minorchan) {
      n = 2;
    } else {
      n = (Math.random() * 3 | 0) + 3;
    }

    while (n--) {
      const x = W ? (Math.random() * W | 0) : 0;
      const y = H ? (Math.random() * H | 0) : 0;
      let c, s;
      if (b) {
        c = 0;
        s = (Math.random() * (config.maxdeathspeed - config.mindeathspeed) + config.mindeathspeed) * dl;
      } else {
        c = ((count - 1) ? (Math.random() * (count - 1) | 0) : 0) + 1;
        s = (Math.random() * (config.maxlifespeed - config.minlifespeed) + config.minlifespeed) * dl;
      }
      newcell(y * W + x, c, s);
    }
  }

  function update() {
    const dl = clamp(config.diaglim, 1, 2) * ORTHLIM;

    // Growth pass over the current front. New cells are head-inserted (behind the
    // iterator) so they first grow next pass; killed cells keep next[], so
    // `a = next[a]` still steps off them correctly.
    for (let a = next[HEAD]; a !== TAIL; a = next[a]) {
      if (speed[a] === 0) continue;
      growth[a] += speed[a];

      let startC;
      if (growth[a] >= dl) startC = 0;            // all 8 neighbours
      else if (growth[a] >= ORTHLIM) startC = 8;  // 4 orthogonals only
      else continue;

      const x = a % W;
      const y = (a / W) | 0;
      for (let i = startC; i < 16; i += 2) {
        let nx = x + COORDS[i];
        let ny = y + COORDS[i + 1];
        if (nx < 0) nx = W - 1; else if (nx >= W) nx = 0;
        if (ny < 0) ny = H - 1; else if (ny >= H) ny = 0;
        newcell(ny * W + nx, col[a], speed[a]);
      }

      if (growth[a] >= dl) killcell(a);
    }

    randblip(next[HEAD] === TAIL);

    // Commit pass: born / taken-over cells (incl. those just seeded this pass and
    // by randblip, all now at the front) start growing and paint bright.
    for (let a = next[HEAD]; a !== TAIL; a = next[a]) {
      if (isnext[a]) {
        isnext[a] = 0;
        speed[a] = nextspeed[a];
        growth[a] = 0;
        col[a] = nextcol[a];
        drawblock(a, col[a] + count);
      }
    }
  }

  function init() {
    const dpr = window.devicePixelRatio || 1;
    cellPx = Math.max(1, Math.round(config.size * dpr));
    count = clamp(Math.round(config.count), 2, 128);

    W = Math.max(1, Math.floor(canvas.width / cellPx));
    H = Math.max(1, Math.floor(canvas.height / cellPx));
    offsetX = ((canvas.width - W * cellPx) / 2) | 0;
    offsetY = ((canvas.height - H * cellPx) / 2) | 0;

    const n = W * H;
    HEAD = n; TAIL = n + 1;
    col = new Uint8Array(n);
    growth = new Float32Array(n);
    speed = new Float32Array(n);
    isnext = new Uint8Array(n);
    nextcol = new Uint8Array(n);
    nextspeed = new Float32Array(n);
    next = new Int32Array(n + 2);
    prev = new Int32Array(n + 2);

    buildColors();
    clearArr();
    randblip(true);   // seed the first colonies
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Fixed-timestep loop: run update() once per `delay` (the C's usleep return),
  // catching up a few steps if frames are slow. delay is microseconds.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay petri runs 54.0 fps (Load 46% =
  // delay-bound, a portable target), while the port at the stock 10000 us ran
  // ~100 updates/sec (1.85x fast). 10000 + 8500 = 18500 us -> 54 updates/sec,
  // matching the live binary. A calibration, not a tuning knob (the delay
  // slider still maps 1:1 to the xml resource).
  const OVERHEAD = 8500;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = Math.max(1, (config.delay + OVERHEAD) / 1000);
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);
    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      update();
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
    reinit: init,   // rebuild grid/colours + reseed with the current config
    config,
    params,
  };
}
