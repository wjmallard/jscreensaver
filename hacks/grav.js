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

import { makeRandomColormapRGB } from './colormap.js';

export const title = 'grav';

export const info = {
  author: 'Greg Bowering',
  description: 'An orbital simulation, or perhaps a cloud chamber.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/grav.xml so the tuning UI maps 1:1.
  // `ncolors` sizes the colour palette: grav.c defines BRIGHT_COLORS, so the
  // framework fills the X colormap via make_random_colormap(bright_p=True) and
  // each planet/star picks a RANDOM entry -- see buildPalette()/pickColor().
  const config = {
    delay: 10000,    // \u00B5s between steps (--delay; xml default 10000)
    count: 12,       // number of orbiting planets (--count)
    ncolors: 64,     // palette size; BRIGHT_COLORS random colormap (--ncolors)
    decay: true,     // damp velocities so orbits spiral inward (--no-decay)
    trail: true,     // leave a dot at every old position (--no-trail)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Number of objects', type: 'range', min: 1, max: 40, step: 1, default: 12, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
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
  let paletteStrings; // BRIGHT_COLORS colormap as 'rgb(...)' strings (null => white)
  let needsBackground; // clear to black on the next frame (after reinit/resize)

  function floatRand(min, max) {
    return min + Math.random() * (max - min);
  }

  // Build the colour palette. grav.c defines BRIGHT_COLORS, so the X colormap is
  // make_random_colormap with bright_p=True: `ncolors` INDEPENDENT random HSV
  // colours (hue 0-360, saturation 30-100%, value 66-100%) -- NOT a hue-ordered
  // rainbow. When ncolors <= 2 the C falls back to white (the MI_NPIXELS > 2
  // gate / `npixels <= 2 goto MONO`), so we leave paletteStrings null and
  // pickColor() returns white. Built once per init(); the hack never cycles.
  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    if (n > 2) {
      paletteStrings = makeRandomColormapRGB(n, true)
        .map(([r, g, b]) => `rgb(${r},${g},${b})`);
    } else {
      paletteStrings = null;
    }
  }

  // A planet/star colour: a random entry of the palette (the C's
  // MI_PIXEL(NRAND(MI_NPIXELS))), or white when ncolors <= 2.
  function pickColor() {
    if (!paletteStrings) return 'rgb(255,255,255)';
    return paletteStrings[(Math.random() * paletteStrings.length) | 0];
  }

  // INTRINSIC_RADIUS = (int)(height/5) in the C (integer division); AVG isn't
  // needed, only the projected radius RADIUS = INTRINSIC_RADIUS / (z + DIST).
  function intrinsicRadius() {
    return (H / 5) | 0;
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
      color: pickColor(),
    };
    project(p);
    return p;
  }

  // Fill a disc of diameter d centred on (x, y), matching the C's XFillArc, which
  // takes a top-left corner (x - d/2, y - d/2) and a width/height of d. Clipped to
  // the window like the C's Planet() macro (it only draws when the centre is in
  // bounds). d is already in device px. A 0-size arc draws nothing in X, so a
  // planet whose projected radius rounds to 0 (very far away) vanishes -- faithful;
  // the trail dot and erase always pass d >= 1, so they're unaffected.
  function disc(x, y, d, fill) {
    if (d < 1) return;
    if (x < 0 || y < 0 || x > W || y > H) return;
    const r = d / 2;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Stroked-circle outline for the star (the C uses XDrawArc). lineWidth scaled.
  // `pad` widens the stroke for the erase pass (see erasePad) so the mask
  // swallows the anti-aliased fringe the coloured ring leaves behind.
  function ring(x, y, d, stroke, pad = 0) {
    if (d < 1) d = 1;
    const r = d / 2;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1, Math.round(S)) + 2 * pad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Anti-aliased black-over-colour only partly cancels a soft rim, so each mask is
  // drawn ~1px larger than its shape to swallow that fringe and stop it piling up
  // along the trails. (The C's hard-edged XFillArc needs none of this — if this
  // ends up eating too much trail, switch disc/ring to integer-span rasterising.)
  function erasePad() { return Math.max(1, Math.round(S)); }

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

    // Erase the old disc (the C masks with the background colour). Pad the mask
    // by ~1px so the disc's anti-aliased rim doesn't survive and accumulate.
    const oldX = p.xi, oldY = p.yi, oldR = p.ri;
    disc(oldX, oldY, oldR + 2 * erasePad(), '#000');

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
    ring(cx, cy, star.sr, '#000', erasePad());   // mask (padded to eat the AA rim)
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

    buildPalette();   // BRIGHT_COLORS colormap; planets/star pick random entries

    const n = Math.max(1, Math.round(config.count));
    planets = [];
    for (let i = 0; i < n; i++) planets.push(makePlanet());

    star = {
      max: Math.max(2 * S, H / (2 * DIST)),   // STARRADIUS in device px
      sr: Math.max(2 * S, H / (2 * DIST)),
      color: pickColor(),
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
  //
  // OVERHEAD: the stock --delay is only a sleep floor; the live binary's real
  // rate is lower (delay + framework overhead -- see the framerate-calibration
  // note). The live grav measures 54.1 fps, but the port at the stock 10000 us
  // ran ~100 steps/sec (1.85x fast). 10000 + 8484 = 18484 us -> 54.1 steps/sec,
  // matching the live binary. A calibration, not a tuning knob (the delay
  // slider still maps 1:1 to the xml resource).
  const OVERHEAD = 8484;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
    const delayMs = (config.delay + OVERHEAD) / 1000;
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
