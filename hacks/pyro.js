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
// The C runs the whole simulation in integer fixed point: positions/sizes/
// velocities are kept scaled and read back >>10 (/1024) for screen coords. The
// port keeps that arithmetic verbatim, in CSS-pixel space — identical to the C
// at the same window size — then scales the *draw* to the device backing store
// by devicePixelRatio for a crisp retina image. No physics constant is scaled by
// dpr: doing so would stretch the fuse (a step count) and burst rockets after
// apex on retina.
//
// Projectiles live in a fixed pool threaded onto a LIFO free list, exactly like
// the C's `next_free` chain — which matters: a primary is freed the instant its
// fuse dies, so its OWN slot is the first thing its burst re-allocates, and the
// resulting memory aliasing shapes every explosion (see shrapnel()).
//
// Rendering: sparse VECTOR ops (fillRect for tiny sparks, arc+fill for larger
// ones) with a full clear-to-black each frame. The C erases each projectile's
// previous rect every step and draws only the new one; a full repaint on the
// double-buffered canvas reproduces the identical look (hard sparks on black,
// no trails) without the per-projectile erase bookkeeping or the C's pixel-sort
// (an X11 GC optimisation with no canvas analogue).

export const title = 'pyro';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Exploding fireworks.\n\nSee also the "Fireworkx", "Eruption", and "XFlame" screen savers.',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/pyro.xml so the config box maps 1:1 to
  // the original. (The xml's "showfps" boolean is host chrome, not ported.)
  // delay: the stock xml default is 10000 µs; the rAF loop adds a fixed OVERHEAD
  // so (delay + OVERHEAD) reproduces the C's *effective* framerate (see pyro.md).
  // A pacing knob, not a fidelity item.
  const config = {
    delay: 10000,    // µs between steps (--delay), inverted "Frame rate"
    count: 600,      // size of the projectile pool (--count), "Particle density"
    frequency: 30,   // launch when rand(frequency)==0 (--frequency), inverted
    scatter: 100,    // shrapnel per burst (--scatter), "Explosive yield"
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'count', label: 'Particle density', type: 'range', min: 10, max: 2000, step: 10, default: 600, lowLabel: 'sparse', highLabel: 'dense', live: false },
    { key: 'frequency', label: 'Launch frequency', type: 'range', min: 1, max: 100, step: 1, default: 30, invert: true, lowLabel: 'seldom', highLabel: 'often', live: true },
    { key: 'scatter', label: 'Explosive yield', type: 'range', min: 1, max: 400, step: 1, default: 100, lowLabel: 'low', highLabel: 'high', live: true },
  ];

  const FP = 10;                 // fixed-point shift (>>10 == /1024)
  const PI_2000 = 6284;          // size of the velocity caches (~2000*PI)
  const GRAVITY = 100;           // the C's `g`, used only in the fuse calc

  // Whacked sin/cos caches that shape the explosion burst (cache() in the C).
  // Each entry is a unit vector at angle i/1000 rad scaled by a randomised
  // radius dA — sin() of a random angle plus a small asin() term that fattens
  // the distribution toward a sphere — times 2500. Sparks index it at random.
  // Built once, like the C (the distribution is independent of window/dpr).
  const sinCache = new Int32Array(PI_2000);
  const cosCache = new Int32Array(PI_2000);
  function buildCaches() {
    for (let i = 0; i < PI_2000; i++) {
      let dA = Math.sin((Math.floor(Math.random() * (PI_2000 / 2))) / 1000.0);
      dA += Math.asin(Math.random()) / (Math.PI / 2) * 0.1;
      cosCache[i] = Math.trunc(Math.cos(i / 1000.0) * dA * 2500.0);
      sinCache[i] = Math.trunc(Math.sin(i / 1000.0) * dA * 2500.0);
    }
  }

  let S = 1;                 // devicePixelRatio (render scale only — not physics)
  let W, H;                  // canvas size in CSS px (the physics space)
  let projectiles;           // flat pool of every projectile (size = config.count)
  let freeHead;              // head of the LIFO free list (a projectile, or null)

  // A projectile is a plain object reused from the pool. They are all wired onto
  // a LIFO free list exactly like the C's `next_free` chain.
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
      nextFree: null,
    };
  }

  // free_projectile(): push onto the free-list head, mark dead.
  function freeProjectile(p) {
    p.nextFree = freeHead;
    freeHead = p;
    p.dead = true;
  }

  // get_projectile(): pop the free-list head, or null if the pool is exhausted
  // (in which case the C — and we — silently drop the launch/spark).
  function getProjectile() {
    const p = freeHead;
    if (!p) return null;
    freeHead = p.nextFree;
    p.nextFree = null;
    p.dead = false;
    return p;
  }

  // Launch a primary rocket from the bottom edge. xlim/ylim are fixed-point.
  function launch(xlim, ylim, g) {
    const p = getProjectile();
    if (!p) return;

    // Pick an x and horizontal velocity so the arc stays on screen.
    let x, dx, xxx;
    do {
      x = Math.floor(Math.random() * xlim);
      dx = 30000 - Math.floor(Math.random() * 60000);
      xxx = x + dx * 200;
    } while (xxx <= 0 || xxx >= xlim);

    p.x = x;
    p.y = ylim;
    p.dx = dx;
    p.size = 8000;
    p.decay = 0;
    p.dy = Math.floor(Math.random() * 4000) - 13000;   // upward (negative y)
    p.fuse = Math.floor(((Math.floor(Math.random() * 500) + 500) * Math.abs(Math.trunc(p.dy / g))) / 1000);
    p.primary = true;

    // Cope with small windows -- the constants above assume big ones.
    const dd = Math.floor(1000000 / ylim);
    if (dd > 1) p.fuse = Math.floor(p.fuse / dd);

    p.hue = Math.floor(Math.random() * 360);   // C: hsv(h,1,1); rockets draw white
  }

  // Spawn one shrapnel spark from a bursting parent. The first spark of a burst
  // reuses the parent's OWN freed slot, so `parent` IS `p`: every field is read
  // before it is written, so the first spark gets the true parent velocity/size
  // — but it also OVERWRITES the parent slot, so the rest of the burst builds on
  // the first spark (its velocity offset by cache[v1], its size 2/3 of 2/3). This
  // aliasing is exactly what the C does, and it is what shapes the explosion:
  // bursts are dottier (most sparks 4/9 the rocket size) and drift off-centre.
  function shrapnel(parent) {
    const p = getProjectile();
    if (!p) return;
    p.x = parent.x;
    p.y = parent.y;
    const v = Math.floor(Math.random() * PI_2000);
    p.dx = sinCache[v] + parent.dx;
    p.dy = cosCache[v] + parent.dy;
    p.decay = Math.floor(Math.random() * 50) - 60;   // shrinks
    p.size = Math.floor((parent.size * 2) / 3);
    p.fuse = 0;
    p.primary = false;
    p.hue = parent.hue;
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

      const x = p.x >> FP;
      const y = p.y >> FP;

      // A primary lives while its fuse burns; shrapnel while it has size left;
      // both die off-screen. (Bounds are the raw pixel extent, as in the C.)
      const alive = (p.primary ? (p.fuse > 0) : (p.size > 0)) &&
                    x < W && y < H && x > 0 && y > 0;
      if (!alive) freeProjectile(p);

      // Burst: a primary whose fuse ran out scatters shrapnel. It was just
      // freed (above), so its slot is the free-list head and the first
      // shrapnel() reuses it (the aliasing described in shrapnel()).
      if (p.primary && p.fuse <= 0) {
        let j = Math.floor(Math.random() * config.scatter) + Math.floor(config.scatter / 2);
        while (j-- > 0) shrapnel(p);
      }
    }

    // Launch a fresh rocket every so often, seeding it in the *1000 position
    // space (the C re-reads the window size here; we use the cached CSS extent).
    if (Math.floor(Math.random() * config.frequency) === 0) {
      launch(W * 1000, H * 1000, g);
    }
  }

  // Draw every live projectile (full repaint). Physics is in CSS px; we scale
  // each coordinate by dpr at draw time so the backing store stays crisp on
  // retina without distorting the simulation. (No ctx transform state, so
  // nothing leaks to the next mounted hack.)
  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i];
      if (p.dead) continue;
      const size = p.size >> FP;
      if (size <= 0) continue;
      const x = p.x >> FP;
      const y = p.y >> FP;
      if (x <= 0 || y <= 0 || x >= W || y >= H) continue;

      // Rockets burn white (the launch streak); shrapnel wear the burst hue at
      // full saturation and value — hsl(h,100%,50%) == the C's hsv(h,1,1).
      ctx.fillStyle = p.primary ? '#fff' : `hsl(${p.hue}, 100%, 50%)`;

      if (size < 4) {
        ctx.fillRect(x * S, y * S, size * S, size * S);   // point / tiny square (C: XDrawPoint / small XFillRectangle)
      } else {
        const r = (size * S) / 2;
        ctx.beginPath();
        ctx.arc(x * S + r, y * S + r, r, 0, Math.PI * 2);   // filled disc (C: XFillArc)
        ctx.fill();
      }
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width / S;
    H = canvas.height / S;

    const n = Math.max(1, Math.round(config.count));
    projectiles = new Array(n);
    for (let i = 0; i < n; i++) projectiles[i] = makeProjectile();
    // Free every slot in index order, so the list head ends at the last slot
    // (matching the C's init loop). All projectiles start dead.
    freeHead = null;
    for (let i = 0; i < n; i++) freeProjectile(projectiles[i]);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay pyro runs 62.5 fps, while the port
  // at the stock 10000 us ran ~100 steps/sec (1.6x fast). 10000 + 6000 = 16000
  // us -> 62.5 steps/sec, matching the live binary. A calibration, not a tuning
  // knob (the delay slider still maps 1:1 to the xml resource).
  const OVERHEAD = 6000;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;   // xml units are µs; rAF is ms
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

  buildCaches();   // once, like the C
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
