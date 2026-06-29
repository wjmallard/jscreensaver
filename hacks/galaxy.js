// galaxy.js — galaxy packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's galaxy.c — originally Uli Siegmund (Amiga/EGS),
// ported by Harald Backert and Hubert Feyrer; standalone by jwz (1997).
// https://www.jwz.org/xscreensaver/
//
// A few spinning galaxies, each a disk of 500-1000 stars, drift toward each
// other under gravity and collide. Every star is pulled by every galaxy's
// CENTRE (treated as a point mass); the galaxy centres also gravitate toward
// one another (a small symmetric N-body). The 3D cloud is projected to 2D
// through a slowly-tumbling viewpoint and the stars are drawn as tiny dots,
// coloured per galaxy. After a fixed number of steps the universe is reseeded.
//
// Rendering: tiny filled rects via fillRect (sparse — at most a few thousand
// 1-2 px dots over a mostly-black field), on a freshly-cleared black canvas
// every frame (the C clears each frame; there are no star trails). Plotting only
// the live points is far cheaper than a full per-pixel ImageData blit.

import { makeColorRampRGB } from './colormap.js';

export const title = 'galaxy';

export const info = {
  author: 'Uli Siegmund, Harald Backert, and Hubert Feyrer',
  description: 'Spinning galaxies collide.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/galaxy.xml so the config box maps 1:1, at
  // the stock defaults. (delay is the xml resource in microseconds; the rAF loop
  // adds OVERHEAD to reproduce the live binary's effective rate; see galaxy.md.)
  const config = {
    delay: 20000,   // µs between steps (--delay; xml default 20000)
    count: -5,      // galaxies; negative = random up to |count| (--count)
    cycles: 250,    // steps before the universe reseeds (--cycles / "Duration")
    ncolors: 64,    // size of the uniform colormap (--ncolors)
    spin: true,     // tumble the viewpoint (--spin)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Galaxies (< 0 = random)', type: 'range', min: -20, max: 20, step: 1, default: -5, live: false },
    { key: 'cycles', label: 'Duration', type: 'range', min: 10, max: 1000, step: 10, default: 250, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 10, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'spin', label: 'Rotate viewpoint', type: 'checkbox', default: true, live: true },
  ];

  // Simulation constants, straight from galaxy.c.
  const MINGALAXIES = 2;
  const MAX_STARS = 3000;
  const MAX_IDELTAT = 50;
  const EPSILON = 0.00000001;
  const SQRT_EPSILON = 0.0001;
  const DELTAT = MAX_IDELTAT * 0.0001;   // integration timestep
  const GALAXYRANGESIZE = 0.1;
  const GALAXYMINSIZE = 0.15;
  const QCONS = 0.001;                    // gravitational constant scale
  const COLORBASE = 16;                   // colour buckets the C spreads galaxies over

  let W, H;           // canvas size, device px
  let scale;          // world->screen length scale
  let pscale;         // dot size in device px
  let midX, midY;     // screen centre
  let galaxies;       // array of galaxy clouds
  let palette;        // ncolors uniform-colormap CSS strings
  let rotY, rotX;     // viewpoint rotation angles
  let step;           // frames since last reseed
  let hitIterations;  // == config.cycles; reseed at 4x this

  function frand() {
    return Math.random();
  }

  // make_uniform_colormap (utils/colors.c, via galaxy.c's UNIFORM_COLORS): a hue
  // ramp 0->359 at ONE random saturation & value, each in 66%-100% — a uniformly
  // tinted, muted rainbow, NOT a full-saturation one. Built once per init; the C's
  // framework builds it at startup and galaxy never rebuilds it, so the colours
  // stay fixed across reseeds.
  function buildPalette() {
    const n = Math.max(2, Math.round(config.ncolors));
    const S = (Math.floor(Math.random() * 34) + 66) / 100;   // 0.66..0.99
    const V = (Math.floor(Math.random() * 34) + 66) / 100;
    const ramp = makeColorRampRGB(0, S, V, 359, S, V, n, false);
    palette = ramp.map(([r, g, b]) => `rgb(${r},${g},${b})`);
  }

  // Seed (or reseed) the whole universe: choose the galaxy count, then build
  // each galaxy's centre + a disk of orbiting stars. Mirrors startover() in C.
  function startover() {
    step = 0;
    rotY = 0;
    rotX = 0;
    hitIterations = Math.max(1, Math.round(config.cycles));

    // count < -MINGALAXIES: random in [MINGALAXIES, |count|]; else clamp up.
    let ngalaxies = Math.round(config.count);
    if (ngalaxies < -MINGALAXIES) {
      ngalaxies = Math.floor(frand() * (-ngalaxies - MINGALAXIES + 1)) + MINGALAXIES;
    } else if (ngalaxies < MINGALAXIES) {
      ngalaxies = MINGALAXIES;
    }

    galaxies = [];
    for (let i = 0; i < ngalaxies; i++) {
      // Galaxy colour (galaxy.c): NRAND(COLORBASE-2), nudged past slots 2-3 (the
      // C's "not all-green" fudge). The C draws every star of a galaxy with
      // MI_PIXEL(COLORSTEP * galcol), where COLORSTEP = ncolors / COLORBASE.
      let galcol = Math.floor(frand() * (COLORBASE - 2));
      if (galcol > 1) galcol += 2;
      const colorStep = Math.floor(palette.length / COLORBASE);
      const colorIndex = colorStep * galcol;

      const nstars = Math.floor(frand() * (MAX_STARS / 2)) + MAX_STARS / 2;

      // Random orientation matrix for this galaxy's disk (two Euler-ish angles).
      const w1 = 2 * Math.PI * frand();
      const w2 = 2 * Math.PI * frand();
      const sinw1 = Math.sin(w1), sinw2 = Math.sin(w2);
      const cosw1 = Math.cos(w1), cosw2 = Math.cos(w2);
      const mat = [
        [cosw2, -sinw1 * sinw2, cosw1 * sinw2],
        [0.0, cosw1, sinw1],
        [-sinw2, -sinw1 * cosw2, cosw1 * cosw2],
      ];

      // Galaxy centre: velocity random, position back-projected so the galaxies
      // converge on the origin around the middle of the run.
      const vel = [frand() * 2 - 1, frand() * 2 - 1, frand() * 2 - 1];
      const pos = [
        -vel[0] * DELTAT * hitIterations + frand() - 0.5,
        -vel[1] * DELTAT * hitIterations + frand() - 0.5,
        -vel[2] * DELTAT * hitIterations + frand() - 0.5,
      ];
      const mass = Math.floor(frand() * 1000) + 1;
      const size = GALAXYRANGESIZE * frand() + GALAXYMINSIZE;

      // Star arrays: flat Float64 for pos/vel (3 components per star).
      const starPos = new Float64Array(nstars * 3);
      const starVel = new Float64Array(nstars * 3);

      for (let j = 0; j < nstars; j++) {
        const w = 2 * Math.PI * frand();
        const sinw = Math.sin(w), cosw = Math.cos(w);
        const d = frand() * size;                                   // radius in disk
        let h = frand() * Math.exp(-2.0 * (d / size)) / 5.0 * size; // disk thickness
        if (frand() < 0.5) h = -h;

        const px = mat[0][0] * d * cosw + mat[1][0] * d * sinw + mat[2][0] * h + pos[0];
        const py = mat[0][1] * d * cosw + mat[1][1] * d * sinw + mat[2][1] * h + pos[1];
        const pz = mat[0][2] * d * cosw + mat[1][2] * d * sinw + mat[2][2] * h + pos[2];

        // Orbital (tangential) speed for a circular orbit at this radius.
        const v = Math.sqrt(mass * QCONS / Math.sqrt(d * d + h * h));
        const vx = (-mat[0][0] * v * sinw + mat[1][0] * v * cosw + vel[0]) * DELTAT;
        const vy = (-mat[0][1] * v * sinw + mat[1][1] * v * cosw + vel[1]) * DELTAT;
        const vz = (-mat[0][2] * v * sinw + mat[1][2] * v * cosw + vel[2]) * DELTAT;

        const o = j * 3;
        starPos[o] = px; starPos[o + 1] = py; starPos[o + 2] = pz;
        starVel[o] = vx; starVel[o + 1] = vy; starVel[o + 2] = vz;
      }

      galaxies.push({ mass, nstars, starPos, starVel, pos, vel, colorIndex });
    }

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // Advance the simulation one frame: gravity on every star from every galaxy
  // centre, integrate, project to screen, then a small N-body step between the
  // galaxy centres. Mirrors draw_galaxy()'s math (drawing is split into draw()).
  function simulate() {
    if (config.spin) {
      rotY += 0.01;
      rotX += 0.004;
    }
    const cox = Math.cos(rotY), six = Math.sin(rotY);
    const cor = Math.cos(rotX), sir = Math.sin(rotX);

    const eps = 1 / (EPSILON * SQRT_EPSILON * DELTAT * DELTAT * QCONS);
    const ng = galaxies.length;

    for (let i = 0; i < ng; i++) {
      const gt = galaxies[i];
      const sp = gt.starPos, sv = gt.starVel;
      const screen = gt.screen || (gt.screen = new Float32Array(gt.nstars * 2));

      for (let j = 0; j < gt.nstars; j++) {
        const o = j * 3;
        let v0 = sv[o], v1 = sv[o + 1], v2 = sv[o + 2];
        const x0 = sp[o], x1 = sp[o + 1], x2 = sp[o + 2];

        // Sum gravitational acceleration from each galaxy's centre (point mass).
        for (let k = 0; k < ng; k++) {
          const gtk = galaxies[k];
          const d0 = gtk.pos[0] - x0;
          const d1 = gtk.pos[1] - x1;
          const d2 = gtk.pos[2] - x2;
          let d = d0 * d0 + d1 * d1 + d2 * d2;
          if (d > EPSILON) {
            d = gtk.mass / (d * Math.sqrt(d)) * DELTAT * DELTAT * QCONS;
          } else {
            d = gtk.mass / (eps * Math.sqrt(eps));
          }
          v0 += d0 * d; v1 += d1 * d; v2 += d2 * d;
        }

        sv[o] = v0; sv[o + 1] = v1; sv[o + 2] = v2;
        const nx = x0 + v0, ny = x1 + v1, nz = x2 + v2;
        sp[o] = nx; sp[o + 1] = ny; sp[o + 2] = nz;

        // Project 3D -> 2D through the tumbling viewpoint.
        const so = j * 2;
        screen[so] = ((cox * nx) - (six * nz)) * scale * pscale + midX;
        screen[so + 1] = ((cor * ny) - (sir * ((six * nx) + (cox * nz)))) * scale * pscale + midY;
      }

      // N-body between galaxy centres (symmetric: i pulls k and vice-versa).
      for (let k = i + 1; k < ng; k++) {
        const gtk = galaxies[k];
        const d0 = gtk.pos[0] - gt.pos[0];
        const d1 = gtk.pos[1] - gt.pos[1];
        const d2 = gtk.pos[2] - gt.pos[2];
        let d = d0 * d0 + d1 * d1 + d2 * d2;
        if (d > EPSILON) {
          d = 1 / (d * Math.sqrt(d)) * DELTAT * QCONS;
        } else {
          d = 1 / (EPSILON * SQRT_EPSILON) * DELTAT * QCONS;
        }
        const e0 = d0 * d, e1 = d1 * d, e2 = d2 * d;
        gt.vel[0] += e0 * gtk.mass; gt.vel[1] += e1 * gtk.mass; gt.vel[2] += e2 * gtk.mass;
        gtk.vel[0] -= e0 * gt.mass; gtk.vel[1] -= e1 * gt.mass; gtk.vel[2] -= e2 * gt.mass;
      }

      gt.pos[0] += gt.vel[0] * DELTAT;
      gt.pos[1] += gt.vel[1] * DELTAT;
      gt.pos[2] += gt.vel[2] * DELTAT;
    }

    step++;
    if (step > hitIterations * 4) startover();
  }

  // Draw the current star positions onto a freshly-cleared black field. The C
  // clears every frame (XClearWindow single-buffered, or erases the previous
  // rects double-buffered) — either way only the live points show, no trails.
  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < galaxies.length; i++) {
      const gt = galaxies[i];
      const screen = gt.screen;
      if (!screen) continue;
      ctx.fillStyle = palette[gt.colorIndex];
      for (let j = 0; j < gt.nstars; j++) {
        const so = j * 2;
        // Bitwise-or floors to int; off-screen dots still draw cheaply (clipped).
        ctx.fillRect(screen[so] | 0, screen[so + 1] | 0, pscale, pscale);
      }
    }
  }

  function init() {
    W = canvas.width;
    H = canvas.height;
    // init_galaxy: world scale (w + h) / 8; dots are 1 px, bumped to 2 px (with the
    // world scale halved to keep the same extent) only past 2560 device px.
    scale = (W + H) / 8.0;
    midX = W / 2;
    midY = H / 2;
    pscale = 1;
    if (W > 2560 || H > 2560) {
      pscale = 2;
      scale /= pscale;
    }
    buildPalette();
    startover();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced by config.delay (µs); run one simulate() per
  // delay, banking leftover time so the speed is identical at any refresh rate.
  // Cap catch-up so a backgrounded tab doesn't burst on refocus. Draw once per
  // frame (the heavy work is simulate(), so we never draw more than we step).
  //
  // OVERHEAD: the stock --delay is only a sleep floor; the live binary's real
  // rate is lower (delay + framework overhead -- see the framerate-calibration
  // note). The live galaxy measures 38.9 fps, but the port at the stock 20000 us
  // ran 50 steps/sec (1.3x fast). 20000 + 5707 = 25707 us -> 38.9 steps/sec,
  // matching the live binary. A calibration, not a tuning knob (the delay
  // slider still maps 1:1 to the xml resource).
  const OVERHEAD = 5707;
  const MAX_CATCHUP_STEPS = 4;
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
    let stepped = false;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      simulate();
      lag -= delayMs;
      steps++;
      stepped = true;
    }

    if (stepped) draw();
    rafId = requestAnimationFrame(frame);
  }

  function reinit() {
    buildPalette();
    startover();
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
