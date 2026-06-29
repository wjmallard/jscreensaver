// flame.js — flame packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's flame.c (Scott Draves, 1993; from Patrick J. Naughton's
// 1991 xlock hack, ported to xscreensaver by jwz). https://www.jwz.org/xscreensaver/
//
// Recursive fractal "cosmic flames": an iterated nonlinear function system.
// Each frame builds a fresh set of 2..4 affine transforms with random
// coefficients, some of them wrapped in one of ten nonlinear "variations"
// (sinusoidal, swirl, horseshoe, spherical, ...). recurse() composes those
// transforms `iterations` deep and plots the leaf points that land inside the
// [-1,1] square, mapped to the screen — up to `points` plots before it bails.
// Successive frames overlay new fractals (the colour cycling through a palette)
// onto the same image, so the figure grows and shifts; every `iterations`
// frames the variation flips/changes, the image lingers (delay2), then clears
// and a new flame begins.
//
// Rendering: thousands of points per frame, heavily overlapping along the
// attractor, so the BLIT path -- write points into a persistent Uint32 ImageData
// buffer, putImageData once per frame. Faithful to the C: each point is a plain
// OVERWRITE (X11 GXcopy) of one solid colour -- the current frame's smooth-
// colormap entry, set once per frame and cycled one index down per frame. There
// is NO additive glow; overlapping points just take the most-recent colour. The
// buffer persists across the frames of a flame, so a block of same-variation
// fractals layers into one multi-hued figure, then clears and a new flame begins.
// (See [[hopalong]] / [[thornbird]] for the same single-colour blit idiom.)

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'flame';

export const info = {
  author: 'Scott Draves',
  description: 'Iterative fractals.',
  year: 1993,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/flame.xml so the config box maps 1:1 to
  // the original.
  //   delay   — \u00B5s between frames while a flame builds.
  //   delay2  — \u00B5s to LINGER on a finished flame before it clears ("Linger").
  //   iterations — recursion depth AND frames per flame before reset+clear
  //                (the xml labels it "Number of fractals").
  //   points  — max leaf points plotted per frame ("Complexity").
  //   ncolors — size of the smooth colormap the frame colour cycles through.
  const config = {
    delay: 50000,      // \u00B5s between frames while a flame builds (--delay; xml default)
    delay2: 2000000,   // \u00B5s to linger on a finished flame (--delay2; xml default)
    iterations: 25,    // recursion depth / frames per flame (--iterations; xml default)
    points: 10000,     // max points plotted per frame (--points; xml default)
    ncolors: 64,       // smooth-colormap size (--colors; xml default)
  };

  // live: true  -> the loop reads config[key] every frame, applies instantly.
  // live: false -> sizes the palette, so a change re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 50000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'delay2', label: 'Linger', type: 'range', min: 1000, max: 10000000, step: 1000, default: 2000000, unit: ' \u00B5s', lowLabel: '0 seconds', highLabel: '10 seconds', live: true },
    { key: 'iterations', label: 'Number of fractals', type: 'range', min: 1, max: 250, step: 1, default: 25, lowLabel: 'few', highLabel: 'many', live: true },
    { key: 'points', label: 'Complexity', type: 'range', min: 100, max: 80000, step: 100, default: 10000, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  const MAXLEV = 4;       // max functions per frame (C: MAXLEV)
  const MAXKINDS = 10;    // number of nonlinear variations (C: MAXKINDS)
  const BLACK = 0xFF000000;

  let W, H, S;            // canvas size (device px) and devicePixelRatio
  let imageData, pixels;  // persistent Uint32 image buffer (overwrite / GXcopy)
  let palette;            // ncolors packed-ABGR smooth-colormap values

  // f[2][3][MAXLEV]: three non-homogeneous transforms per function — [out][term].
  let f;
  let scale;             // point size in device px (1, or 2 on retina)
  let variation;         // which nonlinear variation (0..MAXKINDS-1)
  let snum;              // number of functions this frame (2..MAXLEV)
  let anum;             // how many of them use the nonlinear variation
  let curLevel;          // frame counter (drives reset + colour cycle)
  let flameAlt;          // toggles "alternate" (anum = 0) frames
  let doReset;           // clear the buffer at the top of the next frame
  let pixcol;            // current palette index (cycles down each frame)
  let curColor;          // packed-ABGR colour for this frame's points (one solid colour)
  let mono;              // ncolors <= 2 -> draw white, no colour cycling (C: mono_p)
  let totalPoints;       // leaf points emitted this frame (bounds the recursion)
  let maxTotal;          // == config.points for this frame
  let maxLevels;         // == config.iterations for this frame (recursion depth)

  // The C's halfrandom(): reuse the high 16 bits of a 31-bit random() as a cheap
  // second draw. Faithfully reproduced — it shifts anum's distribution slightly.
  let lasthalf = 0;
  function random31() {
    return (Math.random() * 0x80000000) | 0;   // 31-bit non-negative int
  }
  function halfrandom(mv) {
    let r;
    if (lasthalf) {
      r = lasthalf;
      lasthalf = 0;
    } else {
      r = random31();
      lasthalf = r >> 16;
    }
    return r % mv;
  }

  // C: make_smooth_colormap (utils/colors.c) -- random 2-5 HSV anchors smoothly
  // interpolated into a closed loop, often muted/pastel (NOT a vivid rainbow).
  // Built ONCE per init; the C never rebuilds it, only cycles pixcol through it.
  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    const rgb = makeSmoothColormapRGB(n);
    palette = new Uint32Array(rgb.length);
    for (let p = 0; p < rgb.length; p++) {
      const [r, g, b] = rgb[p];
      palette[p] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
    // C: ncolors <= 2 falls back to mono (white), no colour cycling.
    mono = palette.length <= 2;
  }

  // Plain overwrite plot (X11 GXcopy): set each pixel to this frame's solid
  // colour `curColor`. `scale`-sized block so points stay visible (bigger on
  // retina). The buffer persists, so overlapping points take the latest colour.
  function plot(px, py) {
    for (let dy = 0; dy < scale; dy++) {
      const yy = py + dy;
      if (yy < 0 || yy >= H) continue;
      const rowBase = yy * W;
      for (let dx = 0; dx < scale; dx++) {
        const xx = px + dx;
        if (xx < 0 || xx >= W) continue;
        pixels[rowBase + xx] = curColor;
      }
    }
  }

  // recurse(x, y, l): compose the `snum` transforms `maxLevels` deep, plotting
  // the leaf points that fall in [-1,1]^2. Returns 0 once `maxTotal` points have
  // been emitted (which unwinds the whole recursion and ends the frame) — this
  // is the bound that guarantees termination even if the map diverges to NaN/Inf
  // (NaN comparisons are false, so divergent leaves simply don't plot, but they
  // still tick totalPoints, so we always reach maxTotal and stop).
  function recurse(x, y, l) {
    if (l === maxLevels) {
      totalPoints++;
      if (totalPoints > maxTotal) return 0;   // how long each fractal runs

      if (x > -1.0 && x < 1.0 && y > -1.0 && y < 1.0) {
        // C: (int)((width/2)*(x+1)); width/2 is INTEGER division (width is int),
        // so W>>1 (not W/2) to match exactly for odd canvas widths.
        const px = ((W >> 1) * (x + 1.0)) | 0;
        const py = ((H >> 1) * (y + 1.0)) | 0;
        plot(px, py);
      }
      return 1;
    }

    for (let i = 0; i < snum; i++) {
      // Scale back when values get very large (C: "non-IEEE machines throw an
      // exception instead of a silent NaN"). Keeps the iteration finite.
      if (Math.abs(x) > 1.0e5 || Math.abs(y) > 1.0e5) x = x / y;

      let nx = f[0][0][i] * x + f[0][1][i] * y + f[0][2][i];
      let ny = f[1][0][i] * x + f[1][1][i] * y + f[1][2][i];

      if (i < anum) {
        switch (variation) {
          case 0:   // sinusoidal
            nx = Math.sin(nx);
            ny = Math.sin(ny);
            break;
          case 1: { // complex
            const r2 = nx * nx + ny * ny + 1e-6;
            nx = nx / r2;
            ny = ny / r2;
            break;
          }
          case 2:   // bent
            if (nx < 0.0) nx = nx * 2.0;
            if (ny < 0.0) ny = ny / 2.0;
            break;
          case 3: { // swirl
            const r = (nx * nx + ny * ny);   // times k here is fun
            const c1 = Math.sin(r);
            const c2 = Math.cos(r);
            const t = nx;
            if (nx > 1e4 || nx < -1e4 || ny > 1e4 || ny < -1e4) ny = 1e4;
            else ny = c2 * t + c1 * ny;
            nx = c1 * nx - c2 * ny;
            break;
          }
          case 4: { // horseshoe
            // Avoid atan2 DOMAIN error at the origin.
            const r = (nx === 0.0 && ny === 0.0) ? 0.0 : Math.atan2(nx, ny);
            const c1 = Math.sin(r);
            const c2 = Math.cos(r);
            const t = nx;
            nx = c1 * nx - c2 * ny;
            ny = c2 * t + c1 * ny;
            break;
          }
          case 5: { // drape
            const t = (nx === 0.0 && ny === 0.0) ? 0.0 : Math.atan2(nx, ny) / Math.PI;
            if (nx > 1e4 || nx < -1e4 || ny > 1e4 || ny < -1e4) ny = 1e4;
            else ny = Math.sqrt(nx * nx + ny * ny) - 1.0;
            nx = t;
            break;
          }
          case 6:   // broken
            if (nx > 1.0) nx = nx - 1.0;
            if (nx < -1.0) nx = nx + 1.0;
            if (ny > 1.0) ny = ny - 1.0;
            if (ny < -1.0) ny = ny + 1.0;
            break;
          case 7: { // spherical
            const r = 0.5 + Math.sqrt(nx * nx + ny * ny + 1e-6);
            nx = nx / r;
            ny = ny / r;
            break;
          }
          case 8:   // arctangent
            nx = Math.atan(nx) / Math.PI * 2;   // C: atan(nx) / M_PI_2
            ny = Math.atan(ny) / Math.PI * 2;
            break;
          case 9: { // complex sine
            const u = nx;
            const v = ny;
            const ev = Math.exp(v);
            const emv = Math.exp(-v);
            nx = (ev + emv) * Math.sin(u) / 2.0;
            ny = (ev - emv) * Math.cos(u) / 2.0;
            break;
          }
          default:
            nx = Math.sin(nx);
            ny = Math.sin(ny);
        }
      }

      if (!recurse(nx, ny, l + 1)) return 0;
    }
    return 1;
  }

  // One frame == one flame_draw: maybe clear (from last frame's reset), advance
  // the flame/colour state, randomize the transforms, recurse from (0,0). Returns
  // the ms to wait before the next step — config.delay normally, or config.delay2
  // (the linger) on a frame that finished a flame and is about to clear.
  function step() {
    if (doReset) {
      doReset = false;
      pixels.fill(BLACK);
    }

    maxLevels = Math.max(1, Math.round(config.iterations));
    maxTotal = Math.max(1, Math.round(config.points));

    let thisDelay = config.delay + OVERHEAD;

    // Every maxLevels frames: flip alt, pick a new variation, linger, then clear
    // next frame. (C: post-increment, so frame 0 is a reset frame.)
    if (curLevel % maxLevels === 0) {
      curLevel++;
      doReset = true;
      thisDelay = config.delay2;
      flameAlt = !flameAlt;
      variation = random31() % MAXKINDS;
    } else {
      curLevel++;
      // C: set the draw colour to the CURRENT pixcol, THEN decrement (wrap at 0).
      // (Skipped on reset frames -- the C doesn't XSetForeground there.)
      if (!mono && palette.length > 2) {
        curColor = palette[pixcol];
        if (--pixcol < 0) pixcol = palette.length - 1;
      }
    }

    // Number of functions this frame (2..MAXLEV).
    snum = 2 + (curLevel % (MAXLEV - 1));

    // How many of them are the nonlinear (alternate) form.
    anum = flameAlt ? 0 : halfrandom(snum) + 2;

    // 6 coefficients per function, each in [-1, 1) (C: (random()&1023)/512 - 1).
    for (let k = 0; k < snum; k++) {
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 3; j++) {
          f[i][j][k] = (random31() & 1023) / 512.0 - 1.0;
        }
      }
    }

    totalPoints = 0;
    recurse(0.0, 0.0, 0);

    ctx.putImageData(imageData, 0, 0);
    return Math.max(0, thisDelay / 1000);   // \u00B5s -> ms until next step
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // C bumps the point size on very large (retina) displays.
    scale = (W > 2560 || H > 2560) ? 2 : 1;

    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    buildPalette();

    // f[2][3][MAXLEV], zero-initialised.
    f = [
      [new Float64Array(MAXLEV), new Float64Array(MAXLEV), new Float64Array(MAXLEV)],
      [new Float64Array(MAXLEV), new Float64Array(MAXLEV), new Float64Array(MAXLEV)],
    ];

    variation = random31() % MAXKINDS;
    pixcol = halfrandom(Math.max(1, palette.length));
    // C: gcv.foreground = colors[pixcol] (white when mono). Frame 0 (a reset
    // frame) draws with this; the else branch updates it on later frames.
    curColor = mono ? 0xFFFFFFFF : palette[pixcol];
    curLevel = 0;
    flameAlt = false;
    doReset = false;
    lasthalf = 0;
    totalPoints = 0;
    snum = 2;
    anum = 0;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Variable-delay loop (boxfit/xspirograph-style): step() returns the ms to wait
  // before the next step — config.delay normally, or config.delay2 (the linger)
  // on a frame that just finished a flame. The buffer persists between steps
  // (fractals accumulate), so drawing happens inside step().
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead — see the framerate-calibration note). The
  // live flame measures 16.6 fps while a flame builds, but the port at the stock
  // 50000 µs ran 20 steps/sec (1.2x fast). 50000 + 10241 = 60241 µs -> 16.6
  // steps/sec, matching the live binary. Added to the per-frame BUILD delay only
  // (step() sets `thisDelay = config.delay + OVERHEAD`); the `delay2` linger hold
  // is left untouched. A calibration, not a tuning knob (the slider maps 1:1).
  const OVERHEAD = 10241;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let acc = 0;
  let nextDelay = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    acc += now - lastTime;
    lastTime = now;
    // Bound the backlog so a backgrounded tab doesn't burst on refocus — but
    // never below nextDelay, or a long linger pause would never elapse.
    acc = Math.min(acc, nextDelay + 1000);

    let steps = 0;
    while (acc >= nextDelay && steps < MAX_CATCHUP_STEPS) {
      acc -= nextDelay;
      nextDelay = step();
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (clears the accumulation buffer because
  // ncolors resizes the palette).
  function reinit() {
    nextDelay = 0;
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
