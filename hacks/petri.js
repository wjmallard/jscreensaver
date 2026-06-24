// petri.js — petri packaged as a mountable module.
// start(canvas) returns { stop, reinit, config, params }.
//
// Port of xscreensaver's petri.c by Dan Bornstein (1992-1999).
// https://www.jwz.org/xscreensaver/
//
// Competing molds spread across a toroidal grid. Each living cell accumulates
// "growth" at its speed; once growth passes orthlim it seeds its 4 orthogonal
// neighbours, and once past diaglim it seeds all 8 and then settles. A just-born
// cell is painted in its mould's BRIGHT shade and redrawn DIM once it settles,
// so each colony reads as a bright expanding ring filling in behind it. Random
// "blips" sprinkle new colonies, and when a colony's lifespan expires a "black
// death" (colour 0, white-fronted) wave eats the molds — or the dish is wiped
// clean outright. Only the active growth front is on a list, so it stays cheap.

export const title = 'petri';

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Configuration. Defaults follow petri.c (delay in ms rather than µs).
  const config = {
    size: 3,                 // cell size in px (orig 2)
    count: 20,               // number of mold types
    delay: 10,               // ms per iteration
    diaglim: 1.414,          // diagonal growth limit: 1 square, ~1.414 round, 2 diamond
    anychan: 0.0015,         // chance per iteration that a new colony is born
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
    { key: 'delay', label: 'Frame rate', type: 'range', min: 1, max: 100, step: 1, default: 10, unit: ' ms', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'size', label: 'Cell size', type: 'range', min: 1, max: 12, step: 1, default: 3, unit: ' px', lowLabel: 'fine', highLabel: 'coarse', live: false },
    { key: 'count', label: 'Mold types', type: 'range', min: 2, max: 32, step: 1, default: 20, live: false },
    { key: 'diaglim', label: 'Growth shape', type: 'range', min: 1, max: 2, step: 0.01, default: 1.414, lowLabel: 'square', highLabel: 'diamond', live: true },
    { key: 'anychan', label: 'Birth rate', type: 'range', min: 0, max: 0.02, step: 0.0005, default: 0.0015, lowLabel: 'rare', highLabel: 'often', live: true },
    { key: 'instantdeathchan', label: 'Instant death', type: 'range', min: 0, max: 1, step: 0.01, default: 0.2, lowLabel: 'plague', highLabel: 'wipe', live: true },
  ];

  const ORTHLIM = 1;
  // Neighbour offsets: orthogonal four, then the four diagonals.
  const ORTH = [-1, 0, 1, 0, 0, -1, 0, 1];
  const DIAG = [-1, 0, 1, 0, 0, -1, 0, 1, -1, -1, -1, 1, 1, -1, 1, 1];

  let W, H, cellPx, count;
  let col, growth, speed, isnext, nextcol, nextspeed, inList;   // per-cell arrays
  let alive;            // indices of cells on the growth front
  let blastcount;       // iterations until the next death event
  let colors;           // 2*count CSS colours: [0..count) dim, [count..2count) bright
  let lastFill = null;

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
  function randLife() {
    const lo = Math.max(1, config.minlifespan);
    const hi = Math.max(lo, config.maxlifespan);
    return Math.floor(Math.random() * (hi - lo) + lo);
  }

  function buildColors() {
    colors = new Array(count * 2);
    colors[0] = '#000';          // background / dead
    colors[count] = '#fff';      // death front
    for (let n = 1; n < count; n++) {
      const h = Math.floor(Math.random() * 360);
      colors[n + count] = `hsl(${h}, 100%, 55%)`;   // bright (growing)
      colors[n] = `hsl(${h}, 100%, 27%)`;           // dim (settled)
    }
  }

  function drawblock(idx, c) {
    const s = colors[c];
    if (s !== lastFill) { ctx.fillStyle = s; lastFill = s; }
    const x = idx % W;
    const y = (idx / W) | 0;
    ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
  }

  // Queue cell `idx` to become colour `c` at speed `sp`, and add it to the
  // growth front. A cell already showing `c` is left alone (so molds don't keep
  // re-seeding their own interior, and death can't spread across the void).
  function newcell(idx, c, sp) {
    if (col[idx] === c) return;
    nextcol[idx] = c;
    nextspeed[idx] = sp;
    isnext[idx] = 1;
    if (!inList[idx]) { inList[idx] = 1; alive.push(idx); }
  }

  function killcell(idx) {
    inList[idx] = 0;
    speed[idx] = 0;
    drawblock(idx, col[idx]);   // settle to the dim shade
  }

  // Wipe the dish: clear the canvas and zero every cell.
  function clearArr() {
    lastFill = null;
    ctx.fillStyle = colors[0];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    col.fill(0); growth.fill(0); speed.fill(0);
    isnext.fill(0); nextcol.fill(0); nextspeed.fill(0); inList.fill(0);
    alive = [];
    blastcount = randLife();
  }

  // Sprinkle new cells: living colonies most of the time, a black-death plague
  // (or a full wipe) when the lifespan counter runs out. `doit` forces a birth.
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

    // Growth pass over the cells that were alive at the start (cells seeded this
    // pass sit past n0 and are grown next time, matching the C's list order).
    const n0 = alive.length;
    for (let k = 0; k < n0; k++) {
      const idx = alive[k];
      if (!inList[idx] || speed[idx] === 0) continue;
      growth[idx] += speed[idx];

      let coords;
      if (growth[idx] >= dl) coords = DIAG;
      else if (growth[idx] >= ORTHLIM) coords = ORTH;
      else continue;

      const x = idx % W;
      const y = (idx / W) | 0;
      for (let c = 0; c < coords.length; c += 2) {
        let nx = x + coords[c];
        let ny = y + coords[c + 1];
        if (nx < 0) nx = W - 1; else if (nx >= W) nx = 0;
        if (ny < 0) ny = H - 1; else if (ny >= H) ny = 0;
        newcell(ny * W + nx, col[idx], speed[idx]);
      }

      if (growth[idx] >= dl) killcell(idx);
    }

    // Drop the cells that just settled (inList cleared) from the front.
    let w = 0;
    for (let k = 0; k < alive.length; k++) {
      if (inList[alive[k]]) alive[w++] = alive[k];
    }
    alive.length = w;

    randblip(alive.length === 0);

    // Commit pass: born / taken-over cells start growing and paint bright.
    for (let k = 0; k < alive.length; k++) {
      const idx = alive[k];
      if (isnext[idx]) {
        isnext[idx] = 0;
        speed[idx] = nextspeed[idx];
        growth[idx] = 0;
        col[idx] = nextcol[idx];
        drawblock(idx, col[idx] + count);
      }
    }
  }

  function init() {
    const dpr = window.devicePixelRatio || 1;
    cellPx = Math.max(1, Math.round(config.size * dpr));
    count = clamp(Math.round(config.count), 2, 255);

    W = Math.max(1, Math.floor(canvas.width / cellPx));
    H = Math.max(1, Math.floor(canvas.height / cellPx));

    const n = W * H;
    col = new Uint8Array(n);
    growth = new Float32Array(n);
    speed = new Float32Array(n);
    isnext = new Uint8Array(n);
    nextcol = new Uint8Array(n);
    nextspeed = new Float32Array(n);
    inList = new Uint8Array(n);

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

  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delay = Math.max(1, config.delay);
    lag = Math.min(lag, delay * MAX_CATCHUP_STEPS);
    let steps = 0;
    while (lag >= delay && steps < MAX_CATCHUP_STEPS) {
      update();
      lag -= delay;
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
    reinit: init,   // rebuild grid/colors + reseed with the current config
    config,
    params,
  };
}
