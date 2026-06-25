// grav.js — grav packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's grav.c (Greg Bowering, 1997).
// https://www.jwz.org/xscreensaver/
//
// Planets orbit a central pulsing star under an inverse-square-ish gravity, drawn
// in perspective: each planet is a 3D point (P), velocity (V) and acceleration (A).
// Every step the star at the origin pulls each planet (A = P * GRAV / |P|^3), the
// velocity integrates the pull and the position integrates the velocity, then the
// point is projected to the screen with a simple 1/(z+DIST) perspective so nearer
// planets read as larger discs. With "decay" on, acceleration is clamped and the
// velocity is lightly damped so orbits spiral inward; with "trails" on, each planet
// leaves a 1px dot at every old position, so the whole thing looks like a cloud
// chamber. The star itself randomly grows/shrinks each frame, pulsing like a pulsar.
//
// Rendering: canvas VECTOR ops (fillRect / arc) on a PERSISTENT canvas — we do NOT
// clear-and-redraw each frame. Mirroring the C, each step erases the planet's old
// disc to black, optionally stamps a trail dot (which is never erased, so trails
// accumulate), then draws the new disc; the star is erased and redrawn at its new
// size. A full repaint each frame would wipe the trails, which are the whole point.

export const title = 'grav';

export const info = {
  author: 'Greg Bowering',
  description: 'An orbital simulation, or perhaps a cloud chamber.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/grav.xml so the tuning UI maps 1:1.
  // `ncolors` sizes the hue palette (the stock hack uses it for the X colormap;
  // we map it onto an hsl() rainbow).
  const config = {
    delay: 13000,    // \u00B5s between steps (--delay)
    count: 12,       // number of orbiting planets (--count)
    ncolors: 64,     // size of the rainbow palette (--ncolors)
    decay: true,     // damp velocities so orbits spiral inward (--no-decay)
    trail: true,     // leave a dot at every old position (--no-trail)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 13000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Objects', type: 'range', min: 1, max: 40, step: 1, default: 12, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'decay', label: 'Orbital decay', type: 'checkbox', default: true, live: true },
    { key: 'trail', label: 'Object trails', type: 'checkbox', default: true, live: true },
  ];

  // Physics constants, verbatim from grav.c.
  const GRAV = -0.02;       // gravitational constant (negative = attractive)
  const DIST = 16.0;        // camera distance; also the projection denominator base
  const COLLIDE = 0.0001;   // floor on distance^2 so the pull can't blow up at r=0
  const ALMOST = 15.99;     // a planet with z <= -ALMOST is behind the camera
  const HALF = 0.5;
  const VR = 0.04;          // initial velocity range, per axis
  const DAMP = 0.999999;    // velocity damping when decay is on
  const MaxA = 0.1;         // acceleration clamp when decay is on
  // Initial position range per axis (XR = YR = ZR = HALF * ALMOST).
  const PR = HALF * ALMOST;

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let planets;        // [{ px,py,pz, vx,vy,vz, xi,yi,ri, color }]
  let star;           // { sr, max, color } — central pulsar
  let needsBackground; // clear to black on the next frame (after reinit/resize)

  function floatRand(min, max) {
    return min + Math.random() * (max - min);
  }

  function palette(i, n) {
    return `hsl(${(i * 360 / n) | 0}, 100%, 55%)`;
  }

  // INTRINSIC_RADIUS = height/5 in the C; AVG isn't needed, only the projected
  // radius RADIUS = INTRINSIC_RADIUS / (z + DIST).
  function intrinsicRadius() {
    return H / 5;
  }

  // Project a planet's 3D point to screen + set its disc radius, matching the C:
  //   xi = width  * (HALF + x/(z+DIST));  yi = height * (HALF + y/(z+DIST))
  //   ri = INTRINSIC_RADIUS / (z + DIST)
  // A point at or behind the camera (z <= -ALMOST) gets xi = yi = -1 (off-screen).
  function project(p) {
    if (p.pz > -ALMOST) {
      p.xi = (W * (HALF + p.px / (p.pz + DIST))) | 0;
      p.yi = (H * (HALF + p.py / (p.pz + DIST))) | 0;
    } else {
      p.xi = -1;
      p.yi = -1;
    }
    p.ri = (intrinsicRadius() / (p.pz + DIST)) | 0;
  }

  function makePlanet() {
    const p = {
      px: floatRand(-PR, PR),
      py: floatRand(-PR, PR),
      pz: floatRand(-PR, PR),
      vx: floatRand(-VR, VR),
      vy: floatRand(-VR, VR),
      vz: floatRand(-VR, VR),
      xi: -1,
      yi: -1,
      ri: 0,
      color: palette((Math.random() * config.ncolors) | 0, config.ncolors),
    };
    project(p);
    return p;
  }

  // Fill a disc of diameter d centred on (x, y), matching the C's XFillArc, which
  // takes a top-left corner (x - d/2, y - d/2) and a width/height of d. Clipped to
  // the window like the C's Planet() macro (it only draws when the centre is in
  // bounds). d is already in device px.
  function disc(x, y, d, fill) {
    if (d < 1) d = 1;
    if (x < 0 || y < 0 || x > W || y > H) return;
    const r = d / 2;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Stroked-circle outline for the star (the C uses XDrawArc). lineWidth scaled.
  function ring(x, y, d, stroke) {
    if (d < 1) d = 1;
    const r = d / 2;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1, Math.round(S));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // One physics step for a single planet (the body of draw_planet):
  // gravity -> velocity -> position -> reproject, drawing erase/trail/redraw.
  function stepPlanet(p) {
    let d = p.px * p.px + p.py * p.py + p.pz * p.pz;
    if (d < COLLIDE) d = COLLIDE;
    d = Math.sqrt(d);
    d = d * d * d;                 // |P|^3

    // Acceleration toward the origin; integrate into velocity and position.
    const axyz = [p.px, p.py, p.pz];
    const v = [p.vx, p.vy, p.vz];
    for (let c = 0; c < 3; c++) {
      let a = axyz[c] * GRAV / d;
      if (config.decay) {
        if (a > MaxA) a = MaxA;
        else if (a < -MaxA) a = -MaxA;
        v[c] += a;
        v[c] *= DAMP;
      } else {
        v[c] += a;
      }
      axyz[c] += v[c];             // position += velocity
    }
    p.px = axyz[0]; p.py = axyz[1]; p.pz = axyz[2];
    p.vx = v[0];   p.vy = v[1];   p.vz = v[2];

    // Erase the old disc (the C masks with the background colour).
    const oldX = p.xi, oldY = p.yi, oldR = p.ri;
    disc(oldX, oldY, oldR, '#000');

    // Optional trail dot at the old position (never erased -> trails accumulate).
    // The C uses r=1, tripled past 2560 px; we scale by devicePixelRatio instead.
    if (config.trail && oldX >= 0 && oldY >= 0) {
      const tr = Math.max(1, Math.round(S * (W > 2560 || H > 2560 ? 3 : 1)));
      disc(oldX, oldY, tr, p.color);
    }

    // Reproject to the new position/size and draw the new disc.
    project(p);
    disc(p.xi, p.yi, p.ri, p.color);
  }

  // Star pulsing: erase the old ring, randomly grow/shrink (bounded), redraw.
  // STARRADIUS = height/(2*DIST); the C nudges sr by +/-1 on 2 of every 4 frames.
  function stepStar() {
    const cx = W / 2, cy = H / 2;
    ring(cx, cy, star.sr, '#000');         // mask
    const roll = (Math.random() * 4) | 0;
    if (roll === 0) {
      if (star.sr < star.max) star.sr += S;
    } else if (roll === 1) {
      if (star.sr > 2 * S) star.sr -= S;
    }
    ring(cx, cy, star.sr, star.color);     // redraw
  }

  function step() {
    stepStar();
    for (let i = 0; i < planets.length; i++) stepPlanet(planets[i]);
  }

  function draw() {
    if (needsBackground) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      // Draw the initial star ring and planet discs so frame 1 isn't blank.
      ring(W / 2, H / 2, star.sr, star.color);
      for (let i = 0; i < planets.length; i++) {
        const p = planets[i];
        disc(p.xi, p.yi, p.ri, p.color);
      }
      needsBackground = false;
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    const n = Math.max(1, Math.round(config.count));
    planets = [];
    for (let i = 0; i < n; i++) planets.push(makePlanet());

    star = {
      max: Math.max(2 * S, H / (2 * DIST)),   // STARRADIUS in device px
      sr: Math.max(2 * S, H / (2 * DIST)),
      color: palette((Math.random() * config.ncolors) | 0, config.ncolors),
    };

    needsBackground = true;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator loop paced by config.delay (see squiral.js). The canvas is
  // persistent (trails accumulate), so step() draws incrementally and draw() only
  // paints the one-time background after a reinit/resize.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
    const delayMs = config.delay / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    draw();   // one-time background after reinit/resize

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (clears the canvas; count/colors may differ).
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
