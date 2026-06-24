// swirl.js — swirl packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's swirl.c (M. Dobie & R. Taylor, 1994; standalone 1997).
// https://www.jwz.org/xscreensaver/
//
// Swirl scatters a handful of "knots" (spiral centres) across the screen, each
// with a random mass (+ or -) and a random spiral TYPE — orbit, wheel, ray, or
// hook. Every pixel's value is the signed sum of each knot's contribution at
// that point (an atan2/distance term per knot), folded modulo the colour count.
// That integer field is mapped through a make_smooth_colormap palette.
//
// The field is REVEALED, not cycled. swirl.c paints it with a centre-out SQUARE
// SPIRAL at decreasing block sizes (draw_swirl): `resolution` starts coarse and
// decrements down to `max_resolution`; for each resolution it paints BATCH_DRAW
// r x r blocks per frame (r = 1 << (resolution-1)) in a growing square-spiral
// from the centre (next_point), so the picture FADES IN coarse -> fine (like the
// imsmap port). When the finest resolution finishes it HOLDS the static image
// for RESTART frames, then re-seeds (fresh knots + a fresh make_smooth_colormap)
// and reveals a brand-new pattern.
//
// NO COLOUR CYCLING. swirl.c only rotates its colourmap `if (mi->writable_p)` —
// i.e. on a PseudoColor (writable-colourmap) X visual. A browser canvas is
// TrueColor (writable_p false), so the C does NOT cycle there: the revealed
// image is fully STATIC until the next regeneration (confirmed against the live
// binary: static + coarse->fine). An earlier port animated a continuous
// colourmap rotation the C never performs on TrueColor; it has been removed.
//
// Rendering: the per-pixel field is dense (a sqrt + atan2 per knot per pixel), so
// this uses the BLIT path AND the retina-downscale idiom — the field is drawn at
// LOGICAL (CSS-pixel) resolution into a small offscreen canvas and ctx.drawImage
// upscales it to the device-px canvas (see [[metaballs]] / [[marbling]]). do_point
// is evaluated lazily, only at the spiral's block corners (exactly as the C's
// draw_point calls do_point), so the heavy field cost is spread naturally across
// the reveal frames — no upfront hitch. See swirl.md.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'swirl';

export const info = {
  author: 'M. Dobie and R. Taylor',
  description: 'Flowing, swirly patterns.',
  year: 1994,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/swirl.xml so the config box maps 1:1 to the
  // original: delay (µs/frame, "Frame rate", inverted), count (knot count),
  // ncolors (palette size). swirl.xml exposes nothing else animatable (showfps
  // is a framework control). There is deliberately NO cycle-speed/duration
  // control: the C does not cycle on TrueColor, and the hold is the hardcoded
  // RESTART, not a user resource.
  const config = {
    delay: 10000,       // µs between frames (--delay; xml default 10000)
    count: 5,           // base knot count (--count); n_knots = rand(count/2)+count+1
    ncolors: 200,       // size of the make_smooth_colormap palette (--ncolors)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Count', type: 'range', min: 0, max: 20, step: 1, default: 5, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 2, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  const BLACK = 0xFF000000;       // opaque black, little-endian 0xAABBGGRR

  // Knot types. The C's ALL mode enables ORBIT/WHEEL/RAY/HOOK but NOT PICASSO
  // (its switch never sets picasso under ALL), so we mirror that: PICASSO exists
  // for completeness but is never seeded. Values are small ints (switch keys).
  const ORBIT = 0;
  const WHEEL = 1;
  const RAY = 2;
  const HOOK = 3;
  const PICASSO = 4;
  const TYPES_ALL = [ORBIT, WHEEL, RAY, HOOK];

  // Spiral directions, in the C's DIR_T enum order (drives next_point's walk).
  const DRAW_RIGHT = 0;
  const DRAW_DOWN = 1;
  const DRAW_LEFT = 2;
  const DRAW_UP = 3;

  const MASS = 4;                 // maximum |mass| of a knot (C's MASS)
  const MIN_RES = 7;              // resolution starts at MIN_RES+1 (C's MIN_RES)
  const MAX_RES = 1;             // finest resolution (C's MAX_RES; 2 in two-plane mode)
  const TWO_PLANE_PCNT = 30;      // probability (%) of two-plane interleave mode
  const BATCH_DRAW = 100;         // spiral points painted per frame (C's BATCH_DRAW)
  const RESTART = 2500;           // frames the finished image holds before regen (C's RESTART)

  // Cap the internal field so the per-pixel do_point work (spread over the reveal)
  // and the per-frame blit stay bounded on huge / retina displays; the grid
  // upscales with bilinear smoothing, which suits swirl's soft flowing look.
  const MAX_CELLS = 360000;

  let S = 1;                      // devicePixelRatio
  let W, H;                       // canvas size, device px
  let gw, gh;                     // field grid size, LOGICAL px (capped)
  let imageData, pixels;          // Uint32 view over ImageData (grid-sized)
  let scratch, sctx;              // offscreen grid canvas, upscaled to main

  let palette;                    // Uint32Array(ncolors): the colourmap
  let ncolors;                    // captured colour count (2..255)
  let qcolours;                   // ncolors / 4 (the C's qcolours)
  let radsConst;                  // ncolors / (2*PI) (the C's rads)

  // Knot arrays (one entry per knot), refreshed every swirl.
  let nKnots;
  let kx, ky;                     // knot position, grid coords (Float64)
  let km;                         // knot mass, signed (Float64)
  let kt, kT;                     // knot type in plane 1 / plane 2 (Uint8)
  let twoPlane;                   // interleave two type-sets this swirl?

  // Reveal/lifecycle state (the C's swirl_data spiral + restart fields).
  let resolution;                 // current block resolution (coarse -> fine)
  let maxResolution;             // finest resolution this swirl (1, or 2 two-plane)
  let sr;                         // pixel step = 1 << (resolution - 1)
  let sx, sy;                     // current spiral point (grid coords)
  let direction;                  // current spiral direction (DRAW_*)
  let dirTodo, dirDone;          // square-spiral arm length bookkeeping
  let offScreen;                  // previous arm fell off-grid (termination flag)
  let drawing;                    // mid-reveal at the current resolution?
  let startAgain;                 // RESTART hold counter (-1 = not holding yet)

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // The C's random_no(n): a random integer in [0, n] inclusive.
  function randNo(n) {
    return Math.floor((n + 1) * Math.random());
  }

  // Build a fresh colourmap via make_smooth_colormap (the exact utils/colors.c
  // routine, ported in colormap.js): 2-5 random HSV anchors with min-separation
  // + min-avg-saturation/value retries. This is what the STANDALONE C uses --
  // the framework's color_scheme_smooth (#define SMOOTH_COLORS) builds it at
  // startup, and draw_swirl re-runs make_smooth_colormap on every RESTART -- so
  // successive swirls get a fresh, frequently muted/pastel map, NOT a fixed vivid
  // rainbow. (basic_map / the basic_colours table the old port mimicked live
  // under #ifndef STANDALONE and are dead in this build.) Pack each [r,g,b]
  // (0..255) into the little-endian 0xAABBGGRR Uint32 the blit path expects.
  function buildPalette() {
    const n = ncolors;
    palette = new Uint32Array(n);
    const map = makeSmoothColormapRGB(n);
    for (let i = 0; i < n; i++) {
      const [r, g, b] = map[i];
      palette[i] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
  }

  // Seed a fresh set of knots (positions, masses, spiral types) and decide
  // whether this swirl runs in two-plane interleave mode. Faithful to the C's
  // init_swirl + create_knots.
  function seedKnots() {
    const count = clamp(Math.round(config.count), 0, 64);
    nKnots = randNo(Math.floor(count / 2)) + count + 1;
    twoPlane = randNo(100) <= TWO_PLANE_PCNT;

    kx = new Float64Array(nKnots);
    ky = new Float64Array(nKnots);
    km = new Float64Array(nKnots);
    kt = new Uint8Array(nKnots);
    kT = new Uint8Array(nKnots);

    for (let k = 0; k < nKnots; k++) {
      kx[k] = randNo(gw);
      ky[k] = randNo(gh);

      // Mass 1..MASS+1, sometimes negated (a -ve knot subtracts its field).
      let m = randNo(MASS) + 1;
      if (randNo(100) > 50) m = -m;
      km[k] = m;

      // A random type from the ALL set (orbit/wheel/ray/hook).
      kt[k] = TYPES_ALL[randNo(TYPES_ALL.length - 1)];

      // In two-plane mode each knot also has a DIFFERENT second-plane type.
      if (twoPlane) {
        let t2 = TYPES_ALL[randNo(TYPES_ALL.length - 1)];
        while (t2 === kt[k]) {
          t2 = TYPES_ALL[randNo(TYPES_ALL.length - 1)];
        }
        kT[k] = t2;
      } else {
        kT[k] = kt[k];
      }
    }
  }

  // Compute the colour INDEX for one grid pixel (the C's do_point): sum each
  // knot's spiral contribution, then fold the signed total into [0, ncolors).
  // `plane` selects which type-set to use in two-plane mode (a per-pixel
  // checkerboard, vs. the C's block interleave — see swirl.md). The field math is
  // a verbatim transcription of do_point and is what draw_point samples lazily at
  // each spiral block corner.
  function doPoint(gx, gy) {
    const n = ncolors;
    const qn = qcolours;
    const rads = radsConst;
    const plane = twoPlane ? ((gx + gy) & 1) : 0;
    let value = 0;
    for (let k = 0; k < nKnots; k++) {
      const dx = gx - kx[k];
      const dy = gy - ky[k];
      const m = km[k];
      const type = plane ? kT[k] : kt[k];
      const dist = Math.sqrt(dx * dx + dy * dy);
      let add = 0;
      // Skip the singular cell (dist <= 0.1): keeps every term finite and dodges
      // atan2(0,0). Matches the C's `if (dist > 0.1)` guard.
      if (dist > 0.1) {
        switch (type) {
          case ORBIT:
            add = n / (1.0 + 0.01 * Math.abs(m) * dist);
            break;
          case WHEEL: {
            const theta = (Math.atan2(dy, dx) + Math.PI) / Math.PI;
            const s = Math.sin(0.1 * m * dist) * qn * Math.exp(-0.01 * dist);
            add = (theta < 1.0)
              ? (n * theta + s)
              : (n * (theta - 1.0) + s);
            break;
          }
          case PICASSO:
            add = n * Math.abs(Math.cos(0.002 * m * dist));
            break;
          case RAY:
            add = n * Math.abs(Math.sin(2.0 * Math.atan2(dy, dx)));
            break;
          case HOOK:
            add = rads * Math.atan2(dy, dx) + 0.05 * (Math.abs(m) - 1) * dist;
            break;
        }
        add = Math.trunc(add);     // the C casts (int): truncate toward zero
      }
      value += m > 0 ? add : -add;
    }

    // Fold into range exactly as the C does (the asymmetric +2 / mod-(n-1)
    // handling of negatives shapes the banding). n >= 2 so the `% (n - 1)`
    // divisor is never zero.
    let v;
    if (value >= 0) v = (value % n) + 2;
    else v = n - (Math.abs(value) % (n - 1));
    return ((v % n) + n) % n;
  }

  // Paint an s x s block of palette[colorIdx] into the grid pixel buffer (the C's
  // draw_block). Clipped to the grid defensively; draw_point's bounds guard
  // already keeps full blocks on-grid.
  function drawBlock(bx, by, s, colorIdx) {
    const c = palette[colorIdx];
    const xe = Math.min(gw, bx + s);
    const ye = Math.min(gh, by + s);
    for (let yy = by < 0 ? 0 : by; yy < ye; yy++) {
      const rowBase = yy * gw;
      for (let xx = bx < 0 ? 0 : bx; xx < xe; xx++) {
        pixels[rowBase + xx] = c;
      }
    }
  }

  // Draw the current spiral point (the C's draw_point): an r x r block of the
  // field's colour at that cell, sampled lazily via do_point — or, in two-plane
  // mode, four r/2 sub-blocks each with their own do_point. Returns whether the
  // block was on-grid (and therefore painted).
  function drawPoint() {
    const x = sx, y = sy, r = sr;
    // bounds check (the C's draw_point guard): the whole block must fit on-grid
    if (x < 0 || x > gw - r || y < 0 || y > gh - r) return false;
    if (twoPlane) {
      const r2 = r >> 1;
      drawBlock(x, y, r2, doPoint(x, y));
      drawBlock(x + r2, y, r2, doPoint(x + r2, y));
      drawBlock(x + r2, y + r2, r2, doPoint(x + r2, y + r2));
      drawBlock(x, y + r2, r2, doPoint(x, y + r2));
    } else {
      drawBlock(x, y, r, doPoint(x, y));
    }
    return true;
  }

  // Advance the centre-out square spiral by one step (the C's next_point,
  // verbatim): grow the current arm, or turn and lengthen it (arm length +1 every
  // half-turn). When the spiral has fallen fully off-grid on consecutive arms,
  // stop drawing this resolution.
  function nextPoint() {
    if (dirDone < dirTodo) {
      switch (direction) {
        case DRAW_RIGHT: sx += sr; break;
        case DRAW_DOWN: sy += sr; break;
        case DRAW_LEFT: sx -= sr; break;
        case DRAW_UP: sy -= sr; break;
      }
      dirDone++;
    } else {
      dirDone = 0;
      switch (direction) {
        case DRAW_RIGHT:
          direction = DRAW_DOWN;
          if (sx > gw - sr) {
            dirDone = dirTodo;
            sy += dirTodo * sr;
            if (offScreen) drawing = false;
            offScreen = true;
          } else offScreen = false;
          break;
        case DRAW_DOWN:
          direction = DRAW_LEFT;
          dirTodo++;
          if (sy > gh - sr) {
            dirDone = dirTodo;
            sx -= dirTodo * sr;
            if (offScreen) drawing = false;
            offScreen = true;
          } else offScreen = false;
          break;
        case DRAW_LEFT:
          direction = DRAW_UP;
          if (sx < 0) {
            dirDone = dirTodo;
            sy -= dirTodo * sr;
            if (offScreen) drawing = false;
            offScreen = true;
          } else offScreen = false;
          break;
        case DRAW_UP:
          direction = DRAW_RIGHT;
          dirTodo++;
          if (sy < 0) {
            dirDone = dirTodo;
            sx += dirTodo * sr;
            if (offScreen) drawing = false;
            offScreen = true;
          } else offScreen = false;
          break;
      }
    }
  }

  // Blit the grid buffer to the visible canvas (bilinear upscale).
  function render() {
    sctx.putImageData(imageData, 0, 0);
    ctx.drawImage(scratch, 0, 0, gw, gh, 0, 0, W, H);
  }

  // Begin a brand-new swirl (the C's init_swirl restart path): fresh knots, a
  // fresh make_smooth_colormap, a clean black canvas, and the coarse->fine reveal
  // restarted from the coarsest resolution. (two-plane mode caps the finest
  // resolution at 2, exactly as the C's init_swirl sets max_resolution.)
  function newSwirl() {
    seedKnots();
    buildPalette();
    maxResolution = twoPlane ? 2 : MAX_RES;
    resolution = MIN_RES + 1;
    sr = 1 << (resolution - 1);
    drawing = false;
    startAgain = -1;
    // NB: offScreen is NOT reset here. The C only ever writes off_screen in
    // next_point; init_swirl/initialise_swirl never touch it, so it carries
    // across resolutions and swirls (zero-initialised once). See init().
    pixels.fill(BLACK);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // One frame (the C's draw_swirl): paint a batch of spiral points if mid-reveal;
  // otherwise drop to a finer resolution and restart the spiral, or — once the
  // finest resolution is done — hold the static image for RESTART frames and then
  // regenerate. Returns whether anything was painted (so the loop can skip the
  // blit during the static hold). NO colour rotation: the C only cycles on a
  // writable (PseudoColor) colourmap, which a canvas is not.
  function step() {
    let painted = false;
    if (drawing) {
      let batch = BATCH_DRAW;
      while (batch > 0 && drawing) {
        if (drawPoint()) painted = true;
        nextPoint();
        batch--;
      }
    } else if (resolution > maxResolution) {
      // move to a higher (finer) resolution and restart the spiral at the centre
      resolution--;
      sr = 1 << (resolution - 1);
      drawing = true;
      sx = Math.trunc((gw - sr) / 2);   // (width - r) / 2, C int division
      sy = Math.trunc((gh - sr) / 2);
      direction = DRAW_RIGHT;
      dirTodo = 1;
      dirDone = 0;
      // (the C's draw_swirl does NOT reset off_screen at a resolution change)
    } else {
      // finest resolution done: hold static for RESTART frames, then regenerate
      if (startAgain === -1) startAgain = RESTART;
      else if (startAgain === 0) { startAgain = -1; newSwirl(); }
      else startAgain--;
    }
    return painted;
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // Field grid at LOGICAL resolution (device px / dpr) so retina doesn't
    // multiply the per-pixel cost; capped so huge displays stay affordable.
    let lw = Math.max(1, Math.round(W / S));
    let lh = Math.max(1, Math.round(H / S));
    if (lw * lh > MAX_CELLS) {
      const f = Math.sqrt((lw * lh) / MAX_CELLS);
      lw = Math.max(1, Math.floor(lw / f));
      lh = Math.max(1, Math.floor(lh / f));
    }
    gw = lw;
    gh = lh;

    // Clamp ncolors to >= 2: the field-folding step divides by (ncolors - 1).
    // (xml allows low = 1.)
    ncolors = clamp(Math.round(config.ncolors), 2, 255);
    qcolours = Math.floor(ncolors / 4);
    radsConst = ncolors / (2.0 * Math.PI);

    scratch = document.createElement('canvas');
    scratch.width = gw;
    scratch.height = gh;
    sctx = scratch.getContext('2d');
    imageData = sctx.createImageData(gw, gh);
    pixels = new Uint32Array(imageData.data.buffer);

    ctx.imageSmoothingEnabled = true;

    // The C zero-initialises off_screen once (static struct) and thereafter only
    // next_point writes it; mirror that single initialisation here.
    offScreen = false;

    newSwirl();   // seeds the first swirl + clears the buffer/canvas to black
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
  // banking leftover time so the pace is identical at any refresh rate. The cap
  // is low because a reveal frame paints a batch; a slow frame should fall
  // behind, not stack a burst. One blit per frame, only if something was painted
  // (so the static hold does no work and stays byte-identical).
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // The live swirl measures 60.4 fps, but the port at the stock 10000 us ran
  // 100 steps/sec (1.66x fast). 10000 + 6556 = 16556 us -> 60.4 steps/sec,
  // matching the live binary. A calibration, not a tuning knob (the delay
  // slider still maps 1:1 to the xml resource). The RESTART hold is frame-
  // counted, so it scales with (delay + OVERHEAD) exactly as the live binary's.
  const OVERHEAD = 6556;
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

    let painted = false;
    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      if (step()) painted = true;
      lag -= delayMs;
      steps++;
    }

    if (painted) render();
    rafId = requestAnimationFrame(frame);
  }

  // Rebuild after a non-live config change (count/ncolors resize knots/palette).
  // init() clears to black and starts a fresh swirl, keeping config.
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
    reinit,   // fresh swirl with the current config
    config,
    params,
  };
}
