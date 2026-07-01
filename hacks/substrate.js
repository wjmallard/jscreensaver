// substrate.js — substrate packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's substrate.c (Mike Kershaw "dragorn", 2004), itself a
// direct port of J. Tarbell's "Substrate" (complexification.net, June 2004) —
// sibling to the Tarbell flow field in binaryring.
// https://www.jwz.org/xscreensaver/
//
// Crystalline "cracks" grow as straight (or slightly curved) lines on a blank
// substrate. Each crack steps forward a fraction of a pixel per frame, marking
// an occupancy grid as it goes. When a crack steps onto a cell already marked by
// a DIFFERENT crack (or runs off the edge, or a curved crack closes its circle)
// it stops, restarts itself from a random existing crack heading PERPENDICULAR
// to it, and spawns one new crack the same way — so the space recursively
// subdivides into intricate city-block structures. Optional translucent "sand
// painting" lays a soft watercolour wash perpendicular to each crack.
//
// Rendering: sparse VECTOR draws — one small fillRect per crack tip per step,
// plus a handful of low-alpha fillRects for the sand grains. The canvas is NOT
// cleared each frame; it accumulates. Collision detection uses our OWN Int32
// occupancy grid (sized to the logical canvas), NOT canvas pixel reads — faster
// and exact, mirroring the C's cgrid[].

export const title = 'substrate';

export const info = {
  author: 'J. Tarbell and Mike Kershaw',
  description: 'Crystalline lines grow on a computational substrate. A simple perpendicular growth rule creates intricate city-like structures.',
  year: 2004,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/substrate.xml. Units match the xml so
  // the tuning UI maps 1:1 to the original (delay in microseconds).
  const config = {
    delay: 18000,         // \u00B5s between steps (--growth-delay; stock)
    maxCycles: 10000,     // steps before the field clears + reseeds (--max-cycles)
    sandGrains: 64,       // grains in each sand-painting wash (--sand-grains)
    circlePercent: 33,    // % of new cracks that curve into arcs (--circle-percent)
    initialCracks: 3,     // cracks seeded at the start of a round (--initial-cracks)
    maxCracks: 100,       // hard cap on simultaneously live cracks (--max-cracks)
    wireframe: false,     // true = bare crack lines, no sand wash (--wireframe)
    seamless: false,      // wrap cracks around the edges (--seamless)
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes the grid / reseeds the round, so a change
  //                re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 18000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'maxCycles', label: 'Duration', type: 'range', min: 2000, max: 25000, step: 500, default: 10000, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'sandGrains', label: 'Sand grains', type: 'range', min: 16, max: 128, step: 1, default: 64, lowLabel: 'few', highLabel: 'lots', live: true },
    { key: 'circlePercent', label: 'Circle percentage', type: 'range', min: 0, max: 100, step: 1, default: 33, unit: '%', lowLabel: '0%', highLabel: '100%', live: true },
    { key: 'initialCracks', label: 'Initial cracks', type: 'range', min: 3, max: 15, step: 1, default: 3, lowLabel: 'few', highLabel: 'more', live: false },
    { key: 'maxCracks', label: 'Max cracks', type: 'range', min: 11, max: 400, step: 1, default: 100, lowLabel: 'few', highLabel: 'many', live: true },
    { key: 'wireframe', label: 'Wireframe only', type: 'checkbox', default: false, live: true },
    { key: 'seamless', label: 'Seamless mode', type: 'checkbox', default: false, live: true },
  ];

  // Per-step crack advance (C's STEP); the perpendicular sand walk uses 0.81.
  const STEP = 0.42;
  // Live-measured framework overhead: stock delay 18000us + this reproduces the
  // live binary's ~38.3fps (Load 31.0% = a clean delay-bound reading). See substrate.md.
  const OVERHEAD = 8100;
  const D2R = Math.PI / 180;
  // cgrid sentinel: cells >= OPEN are empty; an occupied cell stores its crack's
  // integer angle (always < ~810 deg, so never collides with the sentinel).
  const OPEN = 10001;

  // Raw colormap extracted from pollockEFF.gif (verbatim from substrate.c) — the
  // earthy sand tones that give substrate its signature watercolour look.
  const POLLOCK = [
    '#201F21', '#262C2E', '#352626', '#372B27',
    '#302C2E', '#392B2D', '#323229', '#3F3229',
    '#38322E', '#2E333D', '#333A3D', '#473329',
    '#40392C', '#40392E', '#47402C', '#47402E',
    '#4E402C', '#4F402E', '#4E4738', '#584037',
    '#65472D', '#6D5D3D', '#745530', '#755532',
    '#745D32', '#746433', '#7C6C36', '#523152',
    '#444842', '#4C5647', '#655D45', '#6D5D44',
    '#6C5D4E', '#746C43', '#7C6C42', '#7C6C4B',
    '#6B734B', '#73734B', '#7B7B4A', '#6B6C55',
    '#696D5E', '#7B6C5D', '#6B7353', '#6A745D',
    '#727B52', '#7B7B52', '#57746E', '#687466',
    '#9C542B', '#9D5432', '#9D5B35', '#936B36',
    '#AA7330', '#C45A27', '#D95223', '#D85A20',
    '#DB5A23', '#E57037', '#836C4B', '#8C6B4B',
    '#82735C', '#937352', '#817B63', '#817B6D',
    '#927B63', '#D9893B', '#E49832', '#DFA133',
    '#E5A037', '#F0AB3B', '#8A8A59', '#B29A58',
    '#89826B', '#9A8262', '#888B7C', '#909A7A',
    '#A28262', '#A18A69', '#A99968', '#99A160',
    '#99A168', '#CA8148', '#EB8D43', '#C29160',
    '#C29168', '#D1A977', '#C9B97F', '#F0E27B',
    '#9F928B', '#C0B999', '#E6B88F', '#C8C187',
    '#E0C886', '#F2CC85', '#F5DA83', '#ECDE9D',
    '#F5D294', '#F5DA94', '#F4E784', '#F4E18A',
    '#F4E193', '#E7D8A7', '#F1D4A5', '#F1DCA5',
    '#F4DBAD', '#F1DCAE', '#F4DBB5', '#F5DBBD',
    '#F4E2AD', '#F5E9AD', '#F4E3BE', '#F5EABE',
    '#F7F0B6', '#D9D1C1', '#E0D0C0', '#E7D8C0',
    '#F1DDC6', '#E8E1C0', '#F3EDC7', '#F6ECCE',
    '#F8F2C7', '#EFEFD0',
  ];

  let S = 1;          // devicePixelRatio: 1 logical px == S device px
  let W, H;           // logical grid dimensions (canvas size / S)
  let cgrid;          // Int32Array(W*H): occupancy grid (OPEN or a crack angle)
  let cracks;         // live crack pool (grows from initialCracks up to maxCracks)
  let colormap;       // sand colours (the Pollock table)
  let cycles;         // steps since this round began; drives the periodic reset

  const frand = (x) => Math.random() * x;
  const rndInt = (n) => Math.floor(Math.random() * n);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  // Positive modulo (fmod-style wrap, always in [0, n)) for seamless geometry.
  const wrap = (a, n) => ((a % n) + n) % n;

  // Crack::findStart() + Crack::startCrack(): re-seed a crack from a random
  // EXISTING crack cell, heading perpendicular (+/-90 deg) to it. If none is
  // found (sparse screen) it falls back to the crack's stashed default cell.
  function startCrack(cr) {
    let px = 0;
    let py = 0;
    let found = false;
    let timeout = 0;

    // Shift until we land on an occupied cell to branch from.
    while (!found && timeout++ < 10000) {
      px = rndInt(W);
      py = rndInt(H);
      if (cgrid[py * W + px] < 10000) found = true;
    }

    if (!found) {
      // Timed out (almost no cracks yet): use the stashed default cell.
      px = Math.trunc(cr.x);
      py = Math.trunc(cr.y);
      if (px < 0) px = 0;
      if (px >= W) px = W - 1;
      if (py < 0) py = 0;
      if (py >= H) py = H - 1;
      cgrid[py * W + px] = Math.trunc(cr.t);
    }

    // Branch perpendicular to the angle stored at the start cell.
    let a = cgrid[py * W + px];
    if (rndInt(100) < 50) a -= 90 + (frand(4.1) - 2.0);
    else a += 90 + (frand(4.1) - 2.0);

    if (rndInt(100) < clamp(config.circlePercent | 0, 0, 100)) {
      // Curved crack: trace an arc of radius r (maybe negative = other way).
      cr.curved = true;
      cr.degrees_drawn = 0;
      let r = 10 + rndInt(Math.max(1, Math.floor((W + H) / 2)));
      if (rndInt(100) < 50) r *= -1;
      const radianInc = STEP / r;          // arc length = r * theta
      cr.t_inc = radianInc * 360 / 2 / Math.PI;
      cr.ys = r * Math.sin(radianInc);
      cr.xs = r * (1 - Math.cos(radianInc));
    } else {
      cr.curved = false;
    }

    cr.x = px + 0.61 * Math.cos(a * D2R);
    cr.y = py + 0.61 * Math.sin(a * D2R);
    cr.t = a;
  }

  // make_crack(): append a fresh crack (with its own sand colour) and start it,
  // but only while we are under the live-crack cap. Mirrors the C: the pool only
  // ever GROWS, capped at maxCracks; dying cracks restart in place via startCrack.
  function makeCrack() {
    if (cracks.length >= Math.max(11, config.maxCracks | 0)) return;
    const cr = {
      x: rndInt(W),
      y: rndInt(H),
      t: rndInt(360),
      ys: 0,
      xs: 0,
      t_inc: 0,
      curved: false,
      degrees_drawn: 0,
      sandp: 0,                       // unused-but-faithful: C never moves sandp
      sandg: frand(0.2) - 0.01,
      sandcolor: colormap[rndInt(colormap.length)],
    };
    startCrack(cr);
    cracks.push(cr);
  }

  // SandPainter::render(): walk perpendicular to the crack until we hit another
  // crack (the far edge of the open region), then spray `grains` low-alpha dots
  // between the crack tip and that edge. Canvas globalAlpha does the read-blend-
  // write that the C's trans_point() does by hand against its off_img buffer.
  function regionColor(cr) {
    const seamless = config.seamless;
    let rx = cr.x;
    let ry = cr.y;
    let open = true;
    let guard = 0;
    const maxWalk = W + H + 2;

    while (open && guard++ < maxWalk) {
      rx += 0.81 * Math.sin(cr.t * D2R);
      ry -= 0.81 * Math.cos(cr.t * D2R);
      let cx = Math.trunc(rx);
      let cy = Math.trunc(ry);
      if (seamless) { cx = cx % W; cy = cy % H; }   // C's raw modulo (may be < 0)
      if (cx >= 0 && cx < W && cy >= 0 && cy < H) {
        if (cgrid[cy * W + cx] > 10000) { /* open: keep walking */ }
        else open = false;
      } else {
        open = false;
      }
    }

    // Modulate the spray gain.
    cr.sandg += frand(0.1) - 0.05;
    if (cr.sandg < 0) cr.sandg = 0;
    if (cr.sandg > 1) cr.sandg = 1;

    const grains = clamp(config.sandGrains | 0, 2, 256);
    const w = cr.sandg / (grains - 1);
    ctx.fillStyle = cr.sandcolor;

    for (let i = 0; i < grains; i++) {
      const f = Math.sin(cr.sandp + Math.sin(i * w));
      let drawx = cr.x + (rx - cr.x) * f;
      let drawy = cr.y + (ry - cr.y) * f;
      if (seamless) {
        drawx = wrap(drawx + W, W);
        drawy = wrap(drawy + H, H);
      }
      const a = 0.1 - i / (grains * 10.0);
      if (a <= 0) continue;
      const gx = Math.trunc(drawx);
      const gy = Math.trunc(drawy);
      if (gx < 0 || gx >= W || gy < 0 || gy >= H) continue;   // C clips off-screen
      ctx.globalAlpha = a;
      ctx.fillRect(gx * S, gy * S, S, S);
    }
    ctx.globalAlpha = 1;
  }

  // Crack::move(): advance one crack, draw its tip + sand, then test the cell it
  // landed on. Continue if open or near-parallel to our own angle; otherwise stop
  // (collision / out-of-bounds / circle closed) by restarting + spawning anew.
  function moveDrawCrack(i) {
    const cr = cracks[i];
    const seamless = config.seamless;

    if (!cr.curved) {
      cr.x += STEP * Math.cos(cr.t * D2R);
      cr.y += STEP * Math.sin(cr.t * D2R);
    } else {
      cr.x += cr.ys * Math.cos(cr.t * D2R);
      cr.y += cr.ys * Math.sin(cr.t * D2R);
      cr.x += cr.xs * Math.cos(cr.t * D2R - Math.PI / 2);
      cr.y += cr.xs * Math.sin(cr.t * D2R - Math.PI / 2);
      cr.t += cr.t_inc;
      cr.degrees_drawn += Math.abs(cr.t_inc);
    }
    if (seamless) {
      cr.x = wrap(cr.x + W, W);
      cr.y = wrap(cr.y + H, H);
    }

    // Bounds check with a sub-pixel jitter (C's random(-0.33, 0.33)).
    let cx = Math.trunc(cr.x + (frand(0.66) - 0.33));
    let cy = Math.trunc(cr.y + (frand(0.66) - 0.33));
    if (seamless) { cx = cx % W; cy = cy % H; }   // C's raw modulo (may be < 0)

    if (cx >= 0 && cx < W && cy >= 0 && cy < H) {
      if (!config.wireframe) regionColor(cr);

      // Draw the crack tip (opaque black, like the C's fgcolor).
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      ctx.fillRect(cx * S, cy * S, S, S);

      const idx = cy * W + cx;
      if (cr.curved && cr.degrees_drawn > 360) {
        // Curved crack completed its circle: stop, restart, spawn one new crack.
        startCrack(cr);
        makeCrack();
      } else if (cgrid[idx] > 10000 || Math.abs(cgrid[idx] - cr.t) < 5) {
        // Open cell, or near-parallel to our own trail: keep cracking.
        cgrid[idx] = Math.trunc(cr.t);
      } else if (Math.abs(cgrid[idx] - cr.t) > 2) {
        // Hit a different crack: stop, restart, spawn one new crack.
        startCrack(cr);
        makeCrack();
      }
    } else {
      // Off the edge: stash a random default cell, then restart + spawn.
      cr.x = rndInt(W);
      cr.y = rndInt(H);
      cr.t = rndInt(360);
      startCrack(cr);
      makeCrack();
    }
  }

  // build_substrate(): clear the grid + canvas and seed a fresh round of cracks.
  // This is the periodic restart that keeps a saturated screen from going static.
  function reseed() {
    cgrid.fill(OPEN);
    cracks = [];
    cycles = 0;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const n = clamp(config.initialCracks | 0, 3, 1000);
    for (let i = 0; i < n; i++) makeCrack();
  }

  function step() {
    // The pool can grow mid-loop (a dying crack spawns a new one that also moves
    // this frame) — read .length each iteration, exactly like the C's for loop.
    for (let i = 0; i < cracks.length; i++) moveDrawCrack(i);

    cycles++;
    const maxCycles = config.maxCycles | 0;
    if (maxCycles !== 0 && cycles >= maxCycles) reseed();   // saturation restart
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = Math.max(1, Math.floor(canvas.width / S));
    H = Math.max(1, Math.floor(canvas.height / S));
    colormap = POLLOCK;
    cgrid = new Int32Array(W * H);
    reseed();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator loop (fixed timestep paced by config.delay microseconds),
  // copied from squiral.js: run one step() per delay, banking leftover time and
  // capping catch-up so a backgrounded tab can't burst.
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
    reinit: init,   // fresh grid + cracks with the current config
    config,
    params,
  };
}
