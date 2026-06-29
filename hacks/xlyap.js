// xlyap.js — xlyap packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's xlyap.c by Ron Record (1991). The Lyapunov exponent of
// a periodically-forced 1-D map drawn over a 2-D parameter plane (the
// Markus-Lyapunov "Zircon Zity" fractal): for each pixel (a, b), iterate the
// logistic map x -> r*x*(1-x), where the parameter r alternates between a and b
// following a fixed binary forcing sequence (e.g. "abbabaab"). Discard a
// "settle" phase, then average log2|f'(x)| over a "dwell" phase: that average is
// the Lyapunov exponent L. L < 0 => ordered/periodic; L > 0 => chaotic.
//
// COLOUR (the whole picture): a faithful transcription of the C's sendpoint()
// index scheme over a make_smooth_colormap palette (colormap.js). The C splits
// the exponent into two colour sub-ranges: chaotic points (L>0) into a narrow
// reserved band at the START of the colormap (so chaos reads ~uniform), ordered
// points (L<=0) across the broad remainder (so order gets the full colour
// sweep), each wrapped by a C modulo so |L| beyond the scale gives contour
// bands. This asymmetric split IS the recognisable Lyapunov look. The palette is
// the same muted random make_smooth_colormap the C builds, rebuilt per image
// (the C's init_color cadence) -- see [[marbling]] / imsmap / swirl.
//
// NOTE: the C defines 5 maps but the screensaver only ever runs the logistic
// one. do_preset() sets st->mapindex for builtins 9-21 but never updates the
// st->map/st->deriv function pointers OR the parameter window, so every builtin
// actually renders the logistic map on its carried-over window. We reproduce
// THAT (what the live binary draws), not the unreachable intent. See xlyap.md.
//
// RENDERING: an expensive PER-PIXEL field (settle+dwell iterations per pixel). The
// C computes ONE Lyapunov value per window pixel, 2000 pixels per delay step, in
// scanline order (xlyap_draw / sendpoint). We match that exactly: the exponent
// grid is computed at the window's LOGICAL resolution (one cell per CSS pixel) into
// a Uint32 view over one ImageData on an offscreen canvas, POINTS_PER_STEP cells
// per delay step, then drawImage-upscaled by devicePixelRatio to the device-res
// canvas (the same softness the live binary has on a hidpi screen). The image
// builds PROGRESSIVELY as a slow per-pixel scan, then HOLDS for `linger` seconds,
// then re-seeds a new random builtin with a fresh colormap -- exactly the C's
// build/linger/reseed cadence (xlyap_draw). [[squiral]] = shared skeleton.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'xlyap';

export const info = {
  author: 'Ron Record',
  description: 'The Lyapunov exponent makes pretty fractal pictures.\n\nhttps://en.wikipedia.org/wiki/Lyapunov_exponent',
  year: 1991,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Config mirrors hacks/config/xlyap.xml exactly: delay ("Frame rate", µs,
  // convert=invert) and linger ("Linger", seconds the finished image holds).
  // The xml exposes nothing else (showfps is host-owned). The window, forcing
  // sequence, settle/dwell and colormap are NOT user knobs in the C either --
  // they come from one of 22 builtin presets picked at random per image.
  const config = {
    delay: 10000,       // µs between compute batches (--delay; xml default 10000)
    linger: 5,          // seconds the finished image holds before reseeding (--linger)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'linger', label: 'Linger', type: 'range', min: 0, max: 10, step: 1, default: 5, unit: ' s', lowLabel: 'brief', highLabel: 'long', live: true },
  ];

  const BLACK = 0xFF000000;            // opaque black, little-endian 0xAABBGGRR
  const LOG2E = Math.LOG2E;            // 1.4426950408889634 (the C's M_LOG2E)
  const START_X = 0.65;                // the C's startX resource

  // The logistic map and its derivative (xlyap.c). The screensaver only ever
  // runs these (see the header note); the C's other 4 maps are unreachable.
  const map = (x, r) => r * x * (1 - x);   // logistic
  const deriv = (x, r) => r - 2 * r * x;   // dlogistic

  // Colour-index constants resolved from the compiled screensaver's
  // do_defaults()+parseargs()+the "colors" resource (xlyap.c). The screensaver
  // path always reduces these to fixed values, so we hardcode them. LOWRANGE is
  // genuinely NEGATIVE in the binary (mincolindex 1 - startcolor 17) -- faithful.
  const MAXCOLOR = 256;                       // st->maxcolor
  const STARTCOLOR = 17;                       // st->startcolor (do_defaults)
  const MINCOLINDEX = 1;                        // st->mincolindex (minColor resource)
  const NUMCOLORS = 200;                       // st->numcolors (colors resource)
  const NUMFREECOLS = NUMCOLORS - MINCOLINDEX;  // 199
  const LOWRANGE = MINCOLINDEX - STARTCOLOR;    // -16 (negative; transcribed as-is)

  // The 22 reachable builtins from xlyap.c's do_preset() (NBUILTINS=22, chosen
  // as random()%22 => 0..21; case 22 is unreachable in the screensaver). Each is
  // resolved to what the COMPILED binary computes: the logistic map on the window
  // do_preset leaves in place. Presets 0-8 set explicit windows. Presets 9-21
  // set st->mapindex (1/2) but NOT st->map/window, so they run logistic on the
  // carried-over [2,4]^2 default window (preset 14 sets its own window). `minlyap`
  // is the colour scale (= maxexp = -minexp): 1.0 for 0-8, 0.85 for 9-21.
  const PRESETS = [
    { minA: 3.75,    minB: 3.299999, aRange: 0.05,         bRange: 0.05,    settle: 100, dwell: 200,  minlyap: 1.0,  forcing: 'abaabbaaabbb' }, // 0
    { minA: 3.8,     minB: 3.2,      aRange: 0.05,         bRange: 0.05,    settle: 50,  dwell: 50,   minlyap: 1.0,  forcing: 'bbbbbaaaaa' },   // 1
    { minA: 3.4,     minB: 3.04,     aRange: 0.5,          bRange: 0.5,     settle: 500, dwell: 1000, minlyap: 1.0,  forcing: 'abbbbbbbbb' },   // 2
    { minA: 3.5,     minB: 3.0,      aRange: 0.2,          bRange: 0.2,     settle: 300, dwell: 600,  minlyap: 1.0,  forcing: 'aaabbbab' },     // 3
    { minA: 3.55667, minB: 3.2,      aRange: 0.05,         bRange: 0.05,    settle: 50,  dwell: 50,   minlyap: 1.0,  forcing: 'bbbbbaaaaa' },   // 4
    { minA: 3.79,    minB: 3.22,     aRange: 0.02999,      bRange: 0.02999, settle: 50,  dwell: 50,   minlyap: 1.0,  forcing: 'bbbbbaaaaa' },   // 5
    { minA: 3.7999,  minB: 3.299999, aRange: 0.2,          bRange: 0.2,     settle: 150, dwell: 300,  minlyap: 1.0,  forcing: 'abaabbaaabbb' }, // 6
    { minA: 3.89,    minB: 3.22,     aRange: 0.02999,      bRange: 0.028,   settle: 600, dwell: 1000, minlyap: 1.0,  forcing: 'bbbbbaaaaa' },   // 7
    { minA: 3.2,     minB: 3.7,      aRange: 0.05,         bRange: 0.005,   settle: 50,  dwell: 50,   minlyap: 1.0,  forcing: 'abbbbaa' },      // 8
    { minA: 2,       minB: 2,        aRange: 2,            bRange: 2,       settle: 200, dwell: 400,  minlyap: 0.85, forcing: 'aaaaaabbbbbb' }, // 9
    { minA: 2,       minB: 2,        aRange: 2,            bRange: 2,       settle: 200, dwell: 400,  minlyap: 0.85, forcing: 'aaaaaabbbbbb' }, // 10
    { minA: 2,       minB: 2,        aRange: 2,            bRange: 2,       settle: 200, dwell: 400,  minlyap: 0.85, forcing: 'abbabaab' },     // 11
    { minA: 2,       minB: 2,        aRange: 2,            bRange: 2,       settle: 200, dwell: 400,  minlyap: 0.85, forcing: 'abbb' },         // 12
    { minA: 2,       minB: 2,        aRange: 2,            bRange: 2,       settle: 200, dwell: 400,  minlyap: 0.85, forcing: 'abbabaab' },     // 13
    { minA: 3.91,    minB: 3.28,     aRange: 0.0899999999, bRange: 0.35,    settle: 200, dwell: 800,  minlyap: 0.85, forcing: 'abbabaab' },     // 14
    { minA: 2,       minB: 2,        aRange: 2,            bRange: 2,       settle: 200, dwell: 400,  minlyap: 0.85, forcing: 'aaaaaabbbbbb' }, // 15
    { minA: 2,       minB: 2,        aRange: 2,            bRange: 2,       settle: 200, dwell: 400,  minlyap: 0.85, forcing: 'abbabaab' },     // 16
    { minA: 2,       minB: 2,        aRange: 2,            bRange: 2,       settle: 200, dwell: 400,  minlyap: 0.85, forcing: 'abbb' },         // 17
    { minA: 2,       minB: 2,        aRange: 2,            bRange: 2,       settle: 200, dwell: 400,  minlyap: 0.85, forcing: 'abbabaab' },     // 18
    { minA: 2,       minB: 2,        aRange: 2,            bRange: 2,       settle: 200, dwell: 400,  minlyap: 0.85, forcing: 'aaaaaabbbbbb' }, // 19
    { minA: 2,       minB: 2,        aRange: 2,            bRange: 2,       settle: 200, dwell: 400,  minlyap: 0.85, forcing: 'abbabaab' },     // 20
    { minA: 2,       minB: 2,        aRange: 2,            bRange: 2,       settle: 200, dwell: 400,  minlyap: 0.85, forcing: 'abbb' },         // 21
  ];

  // The C computes ONE Lyapunov value per pixel at the window's full resolution
  // (a_inc = a_range/width; point.x runs 0..width), 2000 pixels per delay step
  // (xlyap_draw: `for (i=0;i<2000;i++) complyap(st); return st->delay;`). We match
  // that: the field is computed at the window's LOGICAL resolution -- one cell per
  // CSS pixel (gw = innerWidth, gh = innerHeight), the same pixel density the live
  // binary's 1x window has -- and POINTS_PER_STEP cells are computed per delay step
  // in scanline order, so the image reveals as a slow per-pixel scan exactly like
  // the C (reveal time = cells / POINTS_PER_STEP * delay). On a hidpi screen the
  // logical field is drawImage-upscaled by devicePixelRatio to fill the device-res
  // canvas -- the same softness the live binary shows on that screen. MAX_CELLS
  // only caps pathologically large windows (the grid then subsamples).
  const POINTS_PER_STEP = 2000;     // the C's per-frame pixel budget (xlyap_draw)
  const MAX_CELLS = 2500000;        // safety cap for very large windows

  let S = 1;                            // devicePixelRatio
  let W, H;                             // canvas size, device px
  let gw, gh;                           // reduced-grid dimensions
  let imageData, pixels;               // Uint32 view over ImageData (grid-sized)
  let scratch, sctx;                   // offscreen grid canvas, upscaled to main
  let palette;                          // Uint32 smooth colormap, MAXCOLOR entries

  let preset;                           // the active preset object
  let forcing;                          // active forcing sequence as 0/1 array
  let maxindex;                         // forcing.length
  let settle, dwell;                    // per-preset iteration counts
  let maxexp, minexp;                  // colour scale (= +/- preset.minlyap)
  let aMin, bMin, aInc, bInc;           // parameter window mapped onto the grid
  let curX, curY;                       // next grid cell to compute (scanline order)
  let curB, curRowBase;                 // cached b + row offset for the current row

  let state = 'compute';                // 'compute' (building) | 'hold' (linger)
  let holdUntil = 0;                    // rAF timestamp the linger ends

  // make_smooth_colormap (colormap.js) -> MAXCOLOR packed RGBA entries, rebuilt
  // per image to match the C's init_color (called on every reseed). The C builds
  // st->maxcolor (256) colours and indexes GC[i] = colors[i], so we build 256.
  function buildPalette() {
    const cm = makeSmoothColormapRGB(MAXCOLOR);
    palette = new Uint32Array(MAXCOLOR);
    for (let i = 0; i < MAXCOLOR; i++) {
      const c = cm[i];
      palette[i] = (0xFF000000 | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
    }
  }

  // Map a Lyapunov exponent L onto a colormap index -- a faithful transcription
  // of sendpoint() (negative=1, so tmpexpo = L). Chaotic (L>0) -> the reserved
  // low band via LOWRANGE; ordered (L<=0) -> the broad NUMFREECOLS range. Both
  // use C integer truncation ((int) -> Math.trunc) and C modulo (== JS % here,
  // both truncate toward zero), then BufferPoint's [0, MAXCOLOR) clamp.
  function colorIndex(L) {
    let idx;
    if (L > 0) {
      idx = Math.trunc(L * LOWRANGE / maxexp);     // negative
      idx = (idx % LOWRANGE) + STARTCOLOR;
    } else {
      idx = Math.trunc(L * NUMFREECOLS / minexp);  // >= 0
      idx = (idx % NUMFREECOLS) + MINCOLINDEX;
    }
    if (idx < 0) idx = 0;
    else if (idx >= MAXCOLOR) idx = MAXCOLOR - 1;
    return idx;
  }

  // The Lyapunov exponent at parameter point (a, b) -- a faithful port of the C's
  // complyap() with useprod=1 (the default): a settle phase to shed transients,
  // then average log2|f'(x)| over the dwell phase using the log(a*b)=log(a)+
  // log(b) product optimisation (far fewer log() calls). The C does NOT clamp x;
  // the logistic map keeps x in [0,1] for r in [2,4] (the only windows used), so
  // no clamp is needed. The dx==0 bail matches the C (log(0) is nasty).
  function lyapunov(a, b) {
    let x = START_X;
    let bindex = 0;
    let r = forcing[bindex] ? b : a;
    for (let i = 0; i < settle; i++) {
      x = map(x, r);
      if (++bindex >= maxindex) bindex = 0;
      r = forcing[bindex] ? b : a;
    }
    let prod = 1, total = 0, i;
    for (i = 0; i < dwell; i++) {
      x = map(x, r);
      let dx = deriv(x, r);
      if (dx < 0) dx = -dx;
      if (dx === 0) { i++; break; }
      prod *= dx;
      if (prod > 1e12 || prod < 1e-12) { total += Math.log(prod); prod = 1; }
      if (++bindex >= maxindex) bindex = 0;
      r = forcing[bindex] ? b : a;
    }
    total += Math.log(prod);
    const L = (total * LOG2E) / i;
    return Number.isFinite(L) ? L : 0;   // logistic L is always finite; guard anyway
  }

  // Compute the next POINTS_PER_STEP grid cells in scanline order (the C's
  // point.x++ then point.y++), colouring each as it is computed (the C colours via
  // sendpoint as the scanline advances). Flips to 'hold' when the last cell is done.
  function computeStep() {
    let n = POINTS_PER_STEP;
    while (n > 0) {
      const a = aMin + curX * aInc;
      pixels[curRowBase + curX] = palette[colorIndex(lyapunov(a, curB))];
      curX++;
      n--;
      if (curX >= gw) {
        curX = 0;
        curY++;
        if (curY >= gh) { state = 'hold'; return; }
        curB = bMin + curY * bInc;
        curRowBase = curY * gw;
      }
    }
  }

  function blit() {
    sctx.putImageData(imageData, 0, 0);
    ctx.drawImage(scratch, 0, 0, gw, gh, 0, 0, W, H);
  }

  // Adopt a preset: resolve the forcing/iteration counts/colour scale, map the
  // parameter window onto the grid, rebuild the colormap (init_color cadence),
  // then reset the progressive build to row 0.
  function applyPreset(p) {
    preset = p;
    forcing = [...p.forcing].map((c) => (c === 'b' ? 1 : 0));
    maxindex = forcing.length;
    settle = p.settle;
    dwell = p.dwell;
    maxexp = p.minlyap;
    minexp = -p.minlyap;
    aMin = p.minA;
    bMin = p.minB;
    aInc = p.aRange / gw;
    bInc = p.bRange / gh;
    curX = 0;
    curY = 0;
    curB = bMin;
    curRowBase = 0;
    state = 'compute';
    buildPalette();
    pixels.fill(BLACK);
    blit();
  }

  // The C's reseed: do_preset(random()%NBUILTINS). NBUILTINS=22 => indices 0..21.
  function newImage() {
    applyPreset(PRESETS[Math.floor(Math.random() * PRESETS.length)]);
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    // One cell per CSS pixel (the live binary's 1x window pixel density).
    gw = Math.max(2, Math.round(W / S));
    gh = Math.max(2, Math.round(H / S));
    if (gw * gh > MAX_CELLS) {
      const f = Math.sqrt((gw * gh) / MAX_CELLS);
      gw = Math.max(2, Math.floor(gw / f));
      gh = Math.max(2, Math.floor(gh / f));
    }
    scratch = document.createElement('canvas');
    scratch.width = gw;
    scratch.height = gh;
    sctx = scratch.getContext('2d');
    imageData = sctx.createImageData(gw, gh);
    pixels = new Uint32Array(imageData.data.buffer);
    newImage();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // Progressive driver matching the C's xlyap_draw: each `delay`-long step computes
  // POINTS_PER_STEP cells (the C's 2000), banked off requestAnimationFrame so the
  // scan pace is the same at any refresh rate; catch-up is capped so a backgrounded
  // tab can't burst. When the scan finishes the image HOLDS for `linger` seconds,
  // then a fresh random preset is seeded (the C's cadence).
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead — see the framerate-calibration note). The
  // live xlyap measures 48.7 fps during the build scan, but the port at the stock
  // 10000 µs ran 100 steps/sec (2.05x fast). 10000 + 10534 = 20534 µs -> 48.7
  // steps/sec, matching the live binary. Applied to the per-step COMPUTE delay
  // only — the `linger` hold is a separate wall-clock duration, left untouched.
  // A calibration, not a tuning knob (the slider still maps 1:1 to the xml delay).
  const OVERHEAD = 10534;
  const MAX_CATCHUP_STEPS = 8;
  let rafId = 0;
  let lastTime = 0;
  let lag = 0;

  function frame(now) {
    if (state === 'hold') {
      if (now >= holdUntil) newImage();
      lastTime = 0;                 // don't bank time while holding
      rafId = requestAnimationFrame(frame);
      return;
    }

    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    let computed = false;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS && state === 'compute') {
      computeStep();
      computed = true;
      lag -= delayMs;
      steps++;
    }
    if (computed) blit();
    if (state === 'hold') holdUntil = now + Math.max(0, config.linger) * 1000;

    rafId = requestAnimationFrame(frame);
  }

  // Restart with a fresh random preset (host 'r' key / non-live config change).
  function reinit() {
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
