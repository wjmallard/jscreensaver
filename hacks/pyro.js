// pyro.js — pyro packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's pyro.c (Jamie Zawinski, 1992; inspired by TI Explorer
// Lisp code by John S. Pezaris). https://www.jwz.org/xscreensaver/
//
// Fireworks. Primary rockets launch from the bottom edge with an upward+sideways
// velocity and a burning "fuse"; gravity pulls them back. When a rocket's fuse
// runs out it bursts into a shower of shrapnel sparks, fired outward along a
// pre-cached, slightly-whacked spherical velocity distribution and tinted the
// rocket's hue. Each spark carries a `decay` that shrinks it over its life;
// gravity on every projectile is proportional to its size, so big sparks fall
// faster than small ones, giving the drooping willow-burst shape.
//
// Rendering: sparse VECTOR ops (fillRect for tiny sparks, arc+fill for larger
// ones) with a full clear-to-black each frame — same as boxfit. The C erases
// each projectile's previous rect every step and draws only the new one; a full
// repaint on the double-buffered canvas reproduces the identical look (hard
// sparks on black, no trails) without the per-projectile erase bookkeeping.

export const title = 'pyro';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Exploding fireworks.',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/pyro.xml so the config box maps 1:1 to
  // the original. (The xml's "showfps" boolean is host chrome, not ported.)
  const config = {
    delay: 20000,    // µs between steps (--delay), inverted "Frame rate"
    count: 600,      // max live projectiles (--count), "Particle density"
    frequency: 30,   // launch when rand(frequency)==0 (--frequency), inverted
    scatter: 100,    // shrapnel per burst (--scatter), "Explosive yield"
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'count', label: 'Particle density', type: 'range', min: 10, max: 2000, step: 10, default: 600, lowLabel: 'sparse', highLabel: 'dense', live: false },
    { key: 'frequency', label: 'Launch frequency', type: 'range', min: 1, max: 100, step: 1, default: 30, invert: true, lowLabel: 'seldom', highLabel: 'often', live: true },
    { key: 'scatter', label: 'Explosive yield', type: 'range', min: 1, max: 400, step: 1, default: 100, lowLabel: 'low', highLabel: 'high', live: true },
  ];

  // Fixed point: the C keeps x/y/size/velocity scaled by 1024 and shifts >>10
  // for screen coords. We keep the same arithmetic so the motion matches exactly.
  const FP = 10;                 // fixed-point shift (>>10 == /1024)
  const PI_2000 = 6284;          // size of the velocity caches (~2000*PI)
  const GRAVITY = 100;           // the C's `g`, used only in the fuse calc

  // Whacked sin/cos caches that shape the explosion burst (cache() in the C).
  // Each index i holds a velocity vector along angle i/1000 rad, scaled by a
  // randomised radius dA — a sin() of a random angle plus a small asin() term
  // that fattens the distribution toward a sphere. Indexed randomly per spark.
  const sinCache = new Int32Array(PI_2000);
  const cosCache = new Int32Array(PI_2000);
  function buildCaches() {
    for (let i = 0; i < PI_2000; i++) {
      let dA = Math.sin((Math.floor(Math.random() * (PI_2000 / 2))) / 1000.0);
      dA += Math.asin(Math.random()) / (Math.PI / 2) * 0.1;
      cosCache[i] = Math.trunc(Math.cos(i / 1000.0) * dA * 2500.0 * S);
      sinCache[i] = Math.trunc(Math.sin(i / 1000.0) * dA * 2500.0 * S);
    }
  }

  let S = 1;                 // devicePixelRatio
  let W, H;                  // canvas size, device px
  let projectiles;           // flat pool of every projectile (size = config.count)

  // A projectile is a plain object reused from the pool. `dead` ones sit idle
  // until launch()/burst() revive them, mirroring the C's free-list (we just
  // scan for a dead slot instead of threading a next_free pointer).
  function makeProjectile() {
    return {
      x: 0, y: 0,        // position, fixed-point
      dx: 0, dy: 0,      // velocity, fixed-point
      decay: 0,          // size delta per step (negative on shrapnel -> shrinks)
      size: 0,           // current size, fixed-point
      fuse: 0,           // primary burn-down countdown (steps until burst)
      primary: false,    // true = rocket (white), false = shrapnel (coloured)
      hue: 0,            // 0..359, the burst colour
      dead: true,
    };
  }

  function getProjectile() {
    for (let i = 0; i < projectiles.length; i++) {
      if (projectiles[i].dead) return projectiles[i];
    }
    return null;   // pool exhausted -> drop the launch/spark, like the C
  }

  // Launch a primary rocket from the bottom edge. xlim/ylim are fixed-point.
  function launch(xlim, ylim, g) {
    const p = getProjectile();
    if (!p) return;

    // Pick an x and horizontal velocity so the rocket stays on screen.
    let x, dx, xxx;
    // dx/dy/size are velocities/extent in the position space, which is sized in
    // device px; scale them by dpr so a burst covers the same fraction of the
    // screen (and rises to the same apparent height) on retina as on 1x.
    do {
      x = Math.floor(Math.random() * xlim);
      dx = Math.round((30000 - Math.floor(Math.random() * 60000)) * S);
      xxx = x + dx * 200;
    } while (xxx <= 0 || xxx >= xlim);

    p.x = x;
    p.y = ylim;
    p.dx = dx;
    p.size = Math.round(8000 * S);
    p.decay = 0;
    p.dy = Math.round((Math.floor(Math.random() * 4000) - 13000) * S);   // upward (negative y)
    p.fuse = Math.floor(((Math.floor(Math.random() * 500) + 500) * Math.abs(Math.trunc(p.dy / g))) / 1000);
    p.primary = true;
    p.dead = false;

    // Cope with small windows -- the constants above assume big ones.
    const dd = Math.floor(1000000 / ylim);
    if (dd > 1) p.fuse = Math.floor(p.fuse / dd);

    p.hue = Math.floor(Math.random() * 360);
  }

  // Spawn one shrapnel spark from a bursting parent.
  function shrapnel(parent) {
    const p = getProjectile();
    if (!p) return;
    p.x = parent.x;
    p.y = parent.y;
    const v = Math.floor(Math.random() * PI_2000);
    p.dx = sinCache[v] + parent.dx;
    p.dy = cosCache[v] + parent.dy;
    // decay scaled by dpr so a spark's lifetime in steps is dpr-independent
    // (size is dpr-scaled too, so size/decay -- the step count -- stays fixed).
    p.decay = Math.round((Math.floor(Math.random() * 50) - 60) * S);   // shrinks
    p.size = Math.floor((parent.size * 2) / 3);
    p.fuse = 0;
    p.primary = false;
    p.hue = parent.hue;
    p.dead = false;
  }

  // One simulation step over the whole pool (pyro_draw in the C, minus the X11
  // erase calls — we full-repaint instead).
  function step() {
    const g = GRAVITY;

    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i];
      if (p.dead) continue;

      p.size += p.decay;
      p.x += p.dx;
      p.y += p.dy;
      p.dy += p.size >> 6;        // gravity, proportional to size
      if (p.primary) p.fuse--;

      // Screen coords: the C stores positions in a *1000 space (set by launch)
      // but reads them >>10 (/1024), and bounds-checks against the raw pixel
      // extent. We replicate that exactly rather than "tidy" the two scales.
      const x = p.x >> FP;
      const y = p.y >> FP;

      const alive = (p.primary ? (p.fuse > 0) : (p.size > 0)) &&
                    x < W && y < H && x > 0 && y > 0;

      if (!alive) {
        p.dead = true;
      }

      // Burst: a primary whose fuse just ran out scatters shrapnel and dies.
      if (p.primary && p.fuse <= 0) {
        const half = Math.max(1, Math.floor(config.scatter / 2));
        let j = Math.floor(Math.random() * Math.max(1, config.scatter)) + half;
        while (j-- > 0) shrapnel(p);
      }
    }

    // Launch a fresh rocket every so often. The C re-reads the window size here
    // and passes the *1000 bounds to launch (which seeds positions in that space).
    if (Math.floor(Math.random() * Math.max(1, config.frequency)) === 0) {
      launch(W * 1000, H * 1000, g);
    }
  }

  // Draw every live projectile (full repaint on the double-buffered canvas).
  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i];
      if (p.dead) continue;
      const size = p.size >> FP;
      if (size <= 0) continue;
      const x = p.x >> FP;
      const y = p.y >> FP;
      if (x <= 0 || y <= 0 || x >= W || y >= H) continue;

      // Rockets burn white (the launch streak); shrapnel wears the burst hue.
      // Vivid, fully-saturated colours per the gallery's palette convention.
      ctx.fillStyle = p.primary ? '#fff' : `hsl(${p.hue}, 100%, 60%)`;

      if (size < 4) {
        ctx.fillRect(x, y, Math.max(1, size), Math.max(1, size));
      } else {
        const r = size / 2;
        ctx.beginPath();
        ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    const n = Math.max(1, Math.round(config.count));
    projectiles = new Array(n);
    for (let i = 0; i < n; i++) projectiles[i] = makeProjectile();

    buildCaches();   // S is set, so burst velocities scale with dpr

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

  // rAF lag-accumulator paced by config.delay (µs), with a catch-up cap so a
  // backgrounded tab doesn't burst on refocus. Copied from squiral.js.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = config.delay / 1000;       // xml units are µs; rAF is ms
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    draw();
    rafId = requestAnimationFrame(frame);
  }

  // Re-seed after a non-live config change (count resizes the pool) or restart.
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
    reinit,   // re-seed with the current config
    config,   // host renders the config box from these
    params,
  };
}
