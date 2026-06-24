// laser.js — laser packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's laser.c (Pascal Pensa, 1995; xlockmore).
// https://www.jwz.org/xscreensaver/  (removed from the distribution at 5.08)
//
// "Moving radiating lines, that look vaguely like scanning laser beams."
// A shared origin (cx, cy) shoots `count` independent beams; each beam's far
// endpoint walks around the screen's perimeter at its own speed and direction
// (clockwise or counter-clockwise), so every beam spins about the common centre.
// Each beam keeps a short ring buffer of its last `lw` endpoints, so it trails a
// fan of recent positions. After `cycles` frames the whole scene re-seeds: a new
// centre, a new trail length, and new per-beam borders / speeds / colours.
//
// Rendering: sparse vector ops. The C erases the oldest beam by overdrawing it in
// black, then draws the newest (a copy-mode erase, not GXxor). On an anti-aliased
// canvas a black overdraw leaves grey ghosts, so instead we keep each beam's ring
// buffer and CLEAR + REDRAW every live beam each frame (the rotor idiom). The
// pixels shown are identical to the C's lw-beam fan; see laser.md "Deviations".

import { makeRandomColormapRGB } from './colormap.js';

export const title = 'laser';

export const info = {
  author: 'Pascal Pensa',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nMoving radiating lines, that look vaguely like scanning laser beams. (Frankie say relax.)',
  year: 1995,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/laser.xml so the config box maps 1:1,
  // except `delay` is a touch smoother than the stock 40000 us.
  const config = {
    delay: 40000,   // microseconds between frames (--delay; xml/stock 40000)
    count: 10,      // number of beams sharing the centre (--count)
    cycles: 200,    // frames a scene lives before it re-seeds (--cycles)
    ncolors: 64,    // size of the random bright colormap (--ncolors)
  };

  // live: true  -> the loop reads config every frame (applies instantly).
  // live: false -> the value sizes the beam array / palette, so a change
  //                re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 40000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Count', type: 'range', min: 1, max: 20, step: 1, default: 10, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'cycles', label: 'Duration', type: 'range', min: 0, max: 2000, step: 10, default: 200, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // Constants transcribed from laser.c.
  const TOP = 0, RIGHT = 1, BOTTOM = 2, LEFT = 3;
  const MINREDRAW = 3, MAXREDRAW = 8;   // substeps drawn per frame (the C's lr)
  const MINWIDTH = 2, MAXWIDTH = 40;    // trail length range (the C's lw)
  const MINSPEED = 2, MAXSPEED = 17;    // perimeter speed range
  const MINDIST = 10;                   // min centre distance from an edge (logical px)
  const COLORSTEP = 2;                  // palette step between consecutive beams

  let S = 1;            // devicePixelRatio
  let W, H;             // canvas size, device px
  let cx, cy;           // shared beam origin, device px
  let lw;               // trail length (ring-buffer depth)
  let lr;               // substeps advanced per frame
  let sw;               // ring fill level (ramps up to lw)
  let so;               // ring write index
  let time;             // frames since the last re-seed
  let palette;          // ncolors random-bright CSS strings, or null for mono (white)
  let lasers;           // the live beams

  let dirty = true;     // repaint only after the scene advances

  const nrand = (n) => Math.floor(Math.random() * n);
  // RANGE_RAND(min,max): integer in [min, max-1] (matches the C macro).
  const rangeRand = (min, max) => min + Math.floor(Math.random() * (max - min));

  function buildPalette() {
    const n = Math.max(2, Math.round(config.ncolors));
    if (n <= 2) { palette = null; return; }   // the C's mono path -> white beams
    // xlockmore + BRIGHT_COLORS -> make_random_colormap(bright_p=true): each entry
    // is an independent random bright hue (H 0-360, S 30-100%, V 66-100%), NOT a
    // hue ramp -- so consecutive beams (COLORSTEP apart) are unrelated bright hues.
    const cm = makeRandomColormapRGB(n, true);
    palette = cm.map(([r, g, b]) => `rgb(${r},${g},${b})`);
  }

  // init_laser (minus the GC/alloc): pick the centre, trail length, substep
  // count, and re-seed every beam's border / direction / speed / colour. Called
  // at init and again every `cycles` frames, so it MUST set every field the loop
  // reads next, or a beam would freeze or vanish.
  function seed() {
    const dist = MINDIST * S;
    cx = Math.floor((dist < W - dist) ? rangeRand(dist, W - dist) : rangeRand(0, W));
    cy = Math.floor((dist < H - dist) ? rangeRand(dist, H - dist) : rangeRand(0, H));

    lw = rangeRand(MINWIDTH, MAXWIDTH);    // ring-buffer depth (trail length)
    lr = rangeRand(MINREDRAW, MAXREDRAW);  // substeps per frame
    sw = 0;
    so = 0;
    time = 0;

    const count = Math.max(1, Math.round(config.count));
    let c = palette ? nrand(palette.length) : 0;

    lasers = new Array(count);
    for (let i = 0; i < count; i++) {
      const bn = nrand(4);
      let bx, by;
      switch (bn) {
        case TOP:    bx = nrand(W); by = 0;       break;
        case RIGHT:  bx = W;        by = nrand(H); break;
        case BOTTOM: bx = nrand(W); by = H;       break;
        default:     bx = 0;        by = nrand(H); break;   // LEFT
      }

      const dir = nrand(2);
      const speed = Math.floor((rangeRand(MINSPEED, MAXSPEED) * W) / 1000) + 1;

      let color = '#fff';
      if (palette) {
        color = palette[c];
        c = (c + COLORSTEP) % palette.length;
      }

      lasers[i] = {
        bx,
        by,
        bn,
        dir,
        speed,
        color,
        sx: new Int32Array(lw),
        sy: new Int32Array(lw),
      };
    }

    // Pre-roll one full ring so the very first painted frame already shows a
    // complete fan (the C builds the fan up over its first lw substeps).
    for (let r = 0; r < lw; r++) substep();
  }

  // One draw_laser_once: walk every beam's endpoint by `speed` along the
  // perimeter (wrapping around corners; dir chooses CW vs CCW, preserving the
  // overshoot so the speed stays constant through a corner), record the endpoint
  // in the ring buffer at slot `so`, then advance the ring. Endpoints stay on the
  // border by construction (bx in [0, W], by in [0, H]) so no clipping is needed
  // and no axis-aligned beam can NaN (the only division is `% W` / `% H`, W,H>=1).
  function substep() {
    for (let i = 0; i < lasers.length; i++) {
      const l = lasers[i];
      if (l.dir) {
        switch (l.bn) {
          case TOP:
            l.bx -= l.speed;
            if (l.bx < 0) { l.by = -l.bx; l.bx = 0; l.bn = LEFT; }
            break;
          case RIGHT:
            l.by -= l.speed;
            if (l.by < 0) { l.bx = W + l.by; l.by = 0; l.bn = TOP; }
            break;
          case BOTTOM:
            l.bx += l.speed;
            if (l.bx >= W) { l.by = H - (l.bx % W); l.bx = W; l.bn = RIGHT; }
            break;
          case LEFT:
            l.by += l.speed;
            if (l.by >= H) { l.bx = l.by % H; l.by = H; l.bn = BOTTOM; }
            break;
        }
      } else {
        switch (l.bn) {
          case TOP:
            l.bx += l.speed;
            if (l.bx >= W) { l.by = l.bx % W; l.bx = W; l.bn = RIGHT; }
            break;
          case RIGHT:
            l.by += l.speed;
            if (l.by >= H) { l.bx = W - (l.by % H); l.by = H; l.bn = BOTTOM; }
            break;
          case BOTTOM:
            l.bx -= l.speed;
            if (l.bx < 0) { l.by = H + l.bx; l.bx = 0; l.bn = LEFT; }
            break;
          case LEFT:
            l.by -= l.speed;
            if (l.by < 0) { l.bx = -l.bx; l.by = 0; l.bn = TOP; }
            break;
        }
      }

      l.sx[so] = l.bx;
      l.sy[so] = l.by;
    }

    if (sw < lw) sw++;
    so = (so + 1) % lw;
  }

  // One frame (the C's draw_laser): lr substeps, then the re-seed timer. cycles
  // is read live so the slider applies instantly.
  function step() {
    for (let r = 0; r < lr; r++) substep();
    if (++time > config.cycles) seed();
    dirty = true;
  }

  // Clear and redraw every live beam: one stroke per beam, a fan of `sw` lines
  // from the centre to each stored endpoint. A full repaint avoids the ghosting a
  // black-overdraw erase would leave on an anti-aliased canvas, while showing the
  // identical pixels (the C keeps exactly lw beams alive at once).
  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = Math.max(1, Math.round(S));
    ctx.lineCap = 'butt';

    for (let i = 0; i < lasers.length; i++) {
      const l = lasers[i];
      ctx.strokeStyle = l.color;
      ctx.beginPath();
      for (let k = 0; k < sw; k++) {
        ctx.moveTo(cx, cy);
        ctx.lineTo(l.sx[k], l.sy[k]);
      }
      ctx.stroke();
    }

    dirty = false;
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = Math.max(1, canvas.width);
    H = Math.max(1, canvas.height);

    buildPalette();
    seed();

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    dirty = true;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Rebuild after a non-live config change (count/ncolors resize the beam array
  // or palette), clearing the screen and re-seeding via init().
  function reinit() {
    init();
  }

  // rAF lag-accumulator paced by config.delay (us): run one step() per delay,
  // banking leftover time so the sweep is the same at any refresh rate. Cap
  // catch-up so a backgrounded tab doesn't burst a run of steps on refocus.
  // OVERHEAD: the live binary's *delay is a sleep FLOOR; its real frame is
  // delay + per-frame compute. The -fps overlay read 20.0 fps at Load ~20 %
  // (delay-bound) = 50000 us/frame = 40000 floor + 10000 compute, so the
  // faithful per-frame pace is (delay + 10000)/1000 ms (matches the live ~20/s).
  const OVERHEAD = 10000;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, Math.max(delayMs, 1) * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    if (dirty) draw();
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
    reinit,   // fresh scene with the current config
    config,
    params,
  };
}
