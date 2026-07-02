// sphere.js — sphere packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's sphere.c (Tom Duff, original algorithm 1982 at
// Lucasfilm; turned into a standalone XScreenSaver hack by Jamie Zawinski,
// 1997; xlock version David Bagley, 1993; Copyright 1988 Sun Microsystems).
// https://www.jwz.org/xscreensaver/
//
// Draws a bunch of shaded spheres, one at a time, ONE SCANLINE PER TICK. A
// line sweeps across the ball's disk — horizontally or vertically, jwz's 1997
// addition — and each tick the scanline's chord is first drawn black (erasing
// whatever was beneath it), then stippled with dots whose probability is the
// Lambert term N.L between the sphere's surface normal and a fixed light
// vector (NX,NY,NZ) = (48,-36,80), |N| = NR = 100: a random-threshold
// halftone. That grainy, banded shading is the hack's whole look. Balls
// accumulate over the black background forever (the C clears only in
// init_sphere); overlaps are erased chord-by-chord as new balls sweep over.
// shadowx/shadowy — rolled once per session in init_sphere — flip which
// corner the light shines from.
//
// Colour: the C is built with BRIGHT_COLORS, so the xlockmore shim allocates
// make_random_colormap(bright_p = True) once per session (xlockmore.c:484) —
// `ncolors` INDEPENDENT vivid random colours (H 0-360, S 30-100%, V 66-100%)
// — and each ball indexes a random entry. ncolors <= 2 takes the shim's mono
// branch: white stipple on black.
//
// Rendering: sparse fillRect dots on a logical-pixel grid (1 C pixel = S
// device px, so the grain reads the same on retina) — one black chord rect
// plus up to ~2*radius dots per tick.

import { makeRandomColormapRGB } from './colormap.js';

export const title = 'sphere';

export const info = {
  author: 'Tom Duff and Jamie Zawinski',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nDraws shaded spheres in multiple colors.',
  year: 1982,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/sphere.xml so the config box maps 1:1.
  // sphere.xml exposes only delay (--delay) and ncolors (--ncolors); the C's
  // DEFAULTS cycles/size lines are dead knobs sphere.c never reads, so they
  // are dropped.
  const config = {
    delay: 20000,   // µs per scanline (--delay), stock
    ncolors: 64,    // colormap size; <=2 is mono white-on-black (--ncolors)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // Light source vector (NX, NY, NZ), length NR == 100, verbatim from sphere.c.
  // Screen y is down, so NY = -36 aims the highlight up (and NX = 48 right)
  // before the per-session shadowx/shadowy sign flips.
  const NX = 48;
  const NY = -36;
  const NZ = 80;
  const NR = 100;

  const nrand = (n) => Math.floor(Math.random() * n);
  const isqrt = (a) => Math.floor(Math.sqrt(a));   // the C's SQRT: (int)sqrt((double)(a))

  let S = 1;              // devicePixelRatio: 1 C pixel = S device px
  let width, height;      // simulation grid, logical px (the C's sp->width/height)
  let palette;            // npixels CSS colours, built once per session
  let npixels;            // the C's MI_NPIXELS
  let shadowx, shadowy;   // light sign flips, fixed per session (init_sphere)

  // The C's spherestruct — the one ball currently being swept in.
  let radius = 0;         // disk radius, 1 .. min(w,h)/2 - 1
  let x0 = 0, y0 = 0;     // ball centre (anywhere on screen, so often clipped)
  let color = 0;          // palette index
  let x = 0, y = 0;       // sweep coordinate, centre-relative
  let dirx = 0, diry = 0; // sweep axis + direction; exactly one is +1 or -1

  // BRIGHT_COLORS: `ncolors` independent random vivid colours, allocated once
  // per session like the shim (rebuilt only by reinit, when config.ncolors may
  // have changed). ncolors <= 2 falls into the shim's MONO branch (npixels = 2,
  // dots drawn in MI_WHITE_PIXEL).
  function buildPalette() {
    npixels = Math.max(1, Math.round(config.ncolors));
    palette = npixels > 2
      ? makeRandomColormapRGB(npixels, true).map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`)
      : [];
  }

  // One tick == one draw_sphere() call == ONE SCANLINE of the current ball.
  function step() {
    // The sweep line crossed the whole disk: roll a fresh ball (this also
    // fires on the very first tick, since init leaves |x| == radius).
    if ((dirx && Math.abs(x) >= radius) || (diry && Math.abs(y) >= radius)) {
      radius = nrand(Math.min(width >> 1, height >> 1) - 1) + 1;
      if (nrand(2)) {
        dirx = nrand(2) * 2 - 1;
        diry = 0;
      } else {
        dirx = 0;
        diry = nrand(2) * 2 - 1;
      }
      x0 = nrand(width);
      y0 = nrand(height);
      x = -radius * dirx;
      y = -radius * diry;
      if (npixels > 2) color = nrand(npixels);
    }

    // Clamp the sweep start onto the screen (centres land anywhere on screen,
    // so balls are often clipped; their off-screen scanlines are skipped).
    if (dirx === 1) {
      if (x0 + x < 0) x = -x0;
    } else if (dirx === -1) {
      if (x0 + x >= width) x = width - x0 - 1;
    }
    if (diry === 1) {
      if (y0 + y < 0) y = -y0;
    } else if (diry === -1) {
      if (y0 + y >= height) y = height - y0 - 1;
    }

    // This scanline's chord across the disk (half == the C's sp->maxy/sp->maxx),
    // clipped to the screen at both ends.
    let minx = 0, maxx = 0, miny = 0, maxy = 0;
    if (dirx) {
      const half = isqrt(radius * radius - x * x);
      miny = (y0 - half < 0) ? -y0 : -half;
      maxy = (y0 + half >= height) ? height - y0 : half;
    }
    if (diry) {
      const half = isqrt(radius * radius - y * y);
      minx = (x0 - half < 0) ? -x0 : -half;
      maxx = (x0 + half >= width) ? width - x0 : half;
    }

    // 1) Erase the chord to black (the C's XDrawLine in MI_BLACK_PIXEL): this
    // is what overwrites older balls underneath, and keeps the unlit limb of
    // the new ball pure black.
    ctx.fillStyle = '#000';
    if (dirx) ctx.fillRect((x0 + x) * S, (y0 + miny) * S, S, (maxy - miny + 1) * S);
    if (diry) ctx.fillRect((x0 + minx) * S, (y0 + y) * S, (maxx - minx + 1) * S, S);

    // 2) Stipple it: each pixel gets a dot with probability N.L / (radius*NR)
    // — the Lambert cosine as a random-threshold halftone (the C's XDrawPoints
    // in the ball's colour; pixels facing away from the light never draw).
    ctx.fillStyle = npixels > 2 ? palette[color] : '#fff';
    if (dirx) {
      const sqrd = radius * radius - x * x;
      const nd = NX * shadowx * x;
      const px = (x0 + x) * S;
      for (let yy = miny; yy <= maxy; yy++) {
        if (nrand(radius * NR) <= nd + NY * shadowy * yy + NZ * isqrt(sqrd - yy * yy)) {
          ctx.fillRect(px, (y0 + yy) * S, S, S);
        }
      }
    }
    if (diry) {
      const sqrd = radius * radius - y * y;
      const nd = NY * shadowy * y;
      const py = (y0 + y) * S;
      for (let xx = minx; xx <= maxx; xx++) {
        if (nrand(radius * NR) <= NX * shadowx * xx + nd + NZ * isqrt(sqrd - xx * xx)) {
          ctx.fillRect((x0 + xx) * S, py, S, S);
        }
      }
    }

    // 3) Advance the sweep one pixel. Falling off the screen edge jumps the
    // coordinate to the far rim, so the next tick rolls a fresh ball.
    if (dirx === 1) {
      x++;
      if (x0 + x >= width) x = radius;
    } else if (dirx === -1) {
      x--;
      if (x0 + x < 0) x = -radius;
    }
    if (diry === 1) {
      y++;
      if (y0 + y >= height) y = radius;
    } else if (diry === -1) {
      y--;
      if (y0 + y < 0) y = -radius;
    }
  }

  // init_sphere: size the grid, clear (MI_CLEARWINDOW — the hack's ONLY clear;
  // balls accumulate until the next init/resize), roll the session light
  // flips, and leave |x| == radius so the first step rolls a fresh ball.
  function init() {
    S = window.devicePixelRatio || 1;
    width = Math.max(Math.round(canvas.width / S), 4);
    height = Math.max(Math.round(canvas.height / S), 4);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    dirx = 1;
    diry = 0;
    x = radius;
    shadowx = nrand(2) ? 1 : -1;
    shadowy = nrand(2) ? 1 : -1;
  }

  // Config change (the host's apply/'r'): rebuild the colormap and start over.
  // A plain resize re-inits but KEEPS the session palette, matching the shim
  // (reshape_sphere == 0 means resize re-runs init_sphere, but the colormap is
  // allocated only once per session).
  function reinit() {
    buildPalette();
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

  // rAF lag-accumulator paced at (delay + OVERHEAD) µs per scanline: the C's
  // delay is a sleep on top of its per-tick draw cost, so the port adds the
  // measured overhead to reproduce the binary's real cadence (never faster
  // than the author's floor). Catch-up is capped so a backgrounded tab doesn't
  // burst a run of scanlines on refocus.
  const OVERHEAD = 7800;  // µs; live -fps: 36.0 fps at Load 28.1% mid-sweep (clean: sleep slice = 19972 ≈ stock 20000)
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
  buildPalette();
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
