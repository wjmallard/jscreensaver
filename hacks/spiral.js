// spiral.js — spiral packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's spiral.c (Darrick Brown, 1994; standalone by jwz 1997;
// cycles fix by Peter Schmitzberger 1995). https://www.jwz.org/xscreensaver/
//
// Draws a moving moiré pattern: a wandering "spiral" — really a ring of `count`
// evenly-spaced dots, of a slowly growing/shrinking radius and rotating phase —
// is stamped once per step, and the most recent `cycles` rings are kept on a
// circular buffer. As the centre drifts (bouncing off the field edges) and the
// radius pulses, the stack of overlapping rings forms shifting circular moiré
// interference. The ring's hue cycles as the trail advances. Once the buffer
// wraps, each new ring is drawn just after the oldest one is erased in black, so
// the trail keeps a constant length while the pattern crawls across the screen.
//
// Rendering: per-dot fillRect — sparse (a ring is only `count` dots, and at most
// `cycles` rings are live), so plotting the live points is far cheaper than any
// per-pixel ImageData blit. Matches the C, which erases the oldest ring and
// draws the new one each frame rather than clearing the whole window (so the
// trail of older rings persists). The C's expose-driven `redrawing` repaint path
// is dropped — a canvas needs no manual expose repair.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'spiral';

export const info = {
  author: 'Peter Schmitzberger',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nMoving circular moir\u00e9 patterns.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/spiral.xml so the config box maps 1:1.
  const config = {
    delay: 50000,   // µs between steps (--delay)
    count: 40,      // dots per ring (--count)
    cycles: 350,    // trail length: how many rings stay on screen (--cycles)
    ncolors: 64,    // size of the smooth-colormap palette (--ncolors)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 50000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Count', type: 'range', min: 1, max: 100, step: 1, default: 40, lowLabel: 'few', highLabel: 'many', live: true },
    { key: 'cycles', label: 'Cycles', type: 'range', min: 10, max: 800, step: 10, default: 350, lowLabel: 'low', highLabel: 'high', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // Simulation constants, straight from spiral.c.
  const TWOPI = 2.0 * Math.PI;
  const JAGGINESS = 4;     // chance/3000 per step of re-rolling a motion param
  const SPEED = 2.0;       // velocity scale for the wandering centre
  // World coordinate space (the C's proportional 0..right by 0..10000 box).
  const WORLD_TOP = 10000.0;

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let worldRight;     // world width = aspect * 10000
  let palette;        // ncolors smooth-colormap CSS strings

  // The wandering ring's live state (the C's spiralstruct scalars).
  let cx, cy;         // ring centre, world coords
  let angle;          // ring phase (radians)
  let radius;         // ring radius, world units
  let dx, dy;         // centre velocity
  let dr, da;         // radius / angle deltas
  let colorPos;       // float cursor into the palette (cycles with the trail)

  // Circular trail buffer: the last `trailLen` rings, oldest erased as we wrap.
  let trailLen;       // == config.cycles
  let trailX, trailY, trailA, trailR;   // per-ring centre / phase / radius
  let head;           // next write slot (the C's `inc`)
  let wrapped;        // buffer has wrapped once -> start erasing the oldest ring

  function nrand(n) {
    return Math.floor(Math.random() * n);
  }

  function lrandBit() {
    return Math.floor(Math.random() * 2);   // 0 or 1, like (LRAND() & 1)
  }

  // SMOOTH_COLORS: the C builds its palette ONCE per run via make_smooth_colormap
  // (a random 2-5 anchor HSV smooth loop, frequently muted/pastel, re-rolled each
  // run) -- not a fixed rainbow. Faithful port via colormap.js; the per-frame
  // cycling through this palette (colorPos -> MI_PIXEL) is unchanged.
  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    const map = makeSmoothColormapRGB(n);
    palette = map.map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);
  }

  // World (x,y) -> device-pixel screen (x,y). The C maps x by /right*width and
  // y by /top*height; world y grows up the same as screen y here (the C's TFY
  // does too, since top=10000 maps to height with no flip relative to itself).
  function screenX(x) {
    return (x / worldRight) * W;
  }
  function screenY(y) {
    return (y / WORLD_TOP) * H;
  }

  // Stamp one ring: `count` dots evenly spaced around the circle (cx,cy,r),
  // phase-shifted by `a`. Caller sets ctx.fillStyle (a colour, or black to
  // erase). Dot size is 1 device px (the C's XDrawPoint), bumped on retina.
  function drawRing(x, y, a, r) {
    const dots = Math.max(1, Math.round(config.count));
    const inc = TWOPI / dots;
    const ps = Math.max(1, Math.round(S));
    for (let i = 0; i < TWOPI; i += inc) {
      const wx = x + Math.cos(i + a) * r;
      const wy = y + Math.sin(i + a) * r;
      ctx.fillRect(screenX(wx) | 0, screenY(wy) | 0, ps, ps);
    }
  }

  // Seed the wandering ring + trail buffer (the C's init_spiral). Clears to black.
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    worldRight = (W / H) * WORLD_TOP;

    buildPalette();

    trailLen = Math.max(1, Math.round(config.cycles));
    trailX = new Float64Array(trailLen);
    trailY = new Float64Array(trailLen);
    trailA = new Float64Array(trailLen);
    trailR = new Float64Array(trailLen);

    // Initial values, transcribed from init_spiral().
    cx = (5000.0 - nrand(2000)) / 10000.0 * worldRight;
    cy = 5000.0 - nrand(2000);
    radius = nrand(200) + 200;
    angle = 0.0;
    dx = (10 - nrand(20)) * SPEED;
    dy = (10 - nrand(20)) * SPEED;
    dr = (nrand(10) + 4) * (1 - lrandBit() * 2);   // +/- (4..13)
    da = nrand(360) / 7200.0 + 0.01;
    colorPos = palette.length > 2 ? nrand(palette.length) : 0;

    head = 0;
    wrapped = false;
    trailX[head] = cx;
    trailY[head] = cy;
    trailA[head] = angle;
    trailR[head] = radius;
    head++;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // One animation step (the C's draw_spiral): erase the oldest ring once wrapped,
  // advance the centre / radius / angle (with random jitter), then draw the new
  // ring in the next palette colour and advance the circular buffer.
  function step() {
    // Erase the ring at the write slot (the oldest, now being overwritten).
    if (wrapped) {
      ctx.fillStyle = '#000';
      drawRing(trailX[head], trailY[head], trailA[head], trailR[head]);
    }

    // Drift the centre, bouncing off the world box.
    cx += dx;
    if (cx > 9000.0 || cx < 1000.0) dx *= -1.0;
    cy += dy;
    if (cy > 9000.0 || cy < 1000.0) dy *= -1.0;

    // Pulse the radius (the C's bounds; the lower test mirrors the original).
    radius += dr;
    if (radius > 2500.0 && dr > 0.0) dr *= -1.0;
    else if (radius < 50.0 && radius < 0.0) dr *= -1.0;

    // Randomly perturb the motion. JAGGINESS/3000 chance each, like the C.
    // Re-aim the drift (only while the centre is well inside the box).
    if (nrand(3000) < JAGGINESS &&
        (cx > 2000.0 && cx < 8000.0 && cy > 2000.0 && cy < 8000.0)) {
      dx = (10 - nrand(20)) * SPEED;
      dy = (10 - nrand(20)) * SPEED;
    }
    // Nudge the radius-change speed, clamped to a sane band.
    if (nrand(3000) < JAGGINESS) {
      if (lrandBit()) dr += nrand(3) + 1;
      else dr -= nrand(3) + 1;
      if (dr > 18.0) dr = 18.0;
      else if (dr < 4.0) dr = 4.0;
    }
    // Re-roll the rotation speed, and occasionally reverse it.
    if (nrand(3000) < JAGGINESS) da = nrand(360) / 7200.0 + 0.01;
    if (nrand(3000) < JAGGINESS) da *= -1.0;

    angle += da;
    if (angle > TWOPI) angle -= TWOPI;
    else if (angle < 0.0) angle += TWOPI;

    // Advance the hue cursor along the trail.
    colorPos += palette.length / (2 * trailLen);
    if (colorPos >= palette.length) colorPos = 0.0;

    // Write this ring into the buffer and draw it.
    trailX[head] = cx;
    trailY[head] = cy;
    trailA[head] = angle;
    trailR[head] = radius;

    ctx.fillStyle = palette.length > 2 ? palette[colorPos | 0] : '#fff';
    drawRing(cx, cy, angle, radius);

    head++;
    if (head > trailLen - 1) {
      head -= trailLen;
      wrapped = true;
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
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // The live spiral measures 16.8 fps, but the port at the stock 50000 us ran
  // 20 steps/sec (1.19x fast). 50000 + 9524 = 59524 us -> 16.8 steps/sec,
  // matching the live binary. A calibration, not a tuning knob (the delay
  // slider still maps 1:1 to the xml resource).
  const OVERHEAD = 9524;
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
