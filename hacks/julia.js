// julia.js — julia packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port (in spirit) of xscreensaver's julia.c by Sean McCullough (1995/1997) —
// "continuously varying Julia set". https://www.jwz.org/xscreensaver/
//
// The Julia set for a complex parameter c is the boundary between the points z
// that stay bounded under z -> z^2 + c and the points that escape to infinity.
// Each frame the parameter c is walked smoothly around a small orbit (the C's
// incr()), so the set continuously morphs. A small ring marks the current c
// (the xml's "control point from which the rest of the image was generated").
//
// Rendering deviates from the C's algorithm: the original plots set points by
// random inverse iteration (complex sqrt back-tracking). This port uses the
// standard PER-PIXEL escape-time method instead — for every pixel iterate
// z -> z^2 + c until |z| > 2 (bailout) or a max iteration count is hit, then
// colour by a smooth escape count (in-set pixels are black). See julia.md.
//
// Per-pixel work is expensive, so the field is computed at a small LOGICAL grid
// (capped at MAX_FIELD on the long side, independent of devicePixelRatio) into a
// Uint32 ImageData on an offscreen canvas, which the main canvas then upscales
// with drawImage — the metaballs/marbling/strange idiom. Computing at full
// device resolution on a retina display would be seconds per frame.

export const title = 'julia';

export const info = {
  author: 'Sean McCullough',
  description: 'The Julia set is a close relative of the Mandelbrot set. The small moving dot indicates the control point from which the rest of the image was generated.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/julia.xml where an escape-time analog
  // exists. delay is microseconds (xml units). The xml's "cycles" slider is
  // labelled "Iterations"; in escape-time that is literally the max iteration
  // count, so it drives maxIter (see julia.md "Deviations").
  const config = {
    delay: 16000,      // µs between frames (--delay)
    maxIter: 150,      // escape-time iteration cap (xml "Iterations"/--cycles)
    ncolors: 200,      // size of the cycling hue palette (--ncolors)
    zoom: 1,           // view zoom; 1 == short axis spans the complex range [-2, 2]
    morphSpeed: 1,     // how fast the c-parameter walks its orbit per step
    cycle: true,       // slowly rotate the palette over time (echoes the C's colour cycling)
  };

  // live: true  -> read from config every step, applies instantly.
  // live: false -> sizes a buffer/palette, so a change re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 16000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'maxIter', label: 'Iterations', type: 'range', min: 20, max: 400, step: 10, default: 150, lowLabel: 'few', highLabel: 'many', live: true },
    { key: 'zoom', label: 'Zoom', type: 'range', min: 0.3, max: 4, step: 0.1, default: 1, lowLabel: 'out', highLabel: 'in', live: true },
    { key: 'morphSpeed', label: 'Morph speed', type: 'range', min: 0, max: 5, step: 0.1, default: 1, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'cycle', label: 'Color cycling', type: 'checkbox', default: true, live: true },
  ];

  // The C's incr() walks c on a Lissajous-like sinusoidal orbit. Its raw range
  // (|c| up to ~2.4) spends most of its time where the set is a thin "dust", so
  // here the orbit is scaled and clamped to stay near the detail-rich boundary
  // of the Mandelbrot set, where Julia sets look richest (a documented tuning).
  const ORBIT_AMP = 0.62;  // shrink the raw orbit
  const ORBIT_MAX = 1.05;  // clamp |c| so frames stay interesting (never all-dust)

  // Iterations of escape count per full trip around the hue wheel. Small =>
  // tight rainbow contour bands; this value gives the classic colourful look.
  const ITERS_PER_CYCLE = 12;

  const BLACK = 0xFF000000;
  const INV_LOG2 = 1 / Math.log(2);
  const MAX_FIELD = 720;   // cap the long side of the compute grid (perf)

  let S;                   // devicePixelRatio
  let gw, gh;              // compute grid size (logical px, capped at MAX_FIELD)
  let imageData, pixels;   // Uint32 buffer at grid resolution
  let scratch, sctx;       // offscreen canvas holding the grid, upscaled to the main canvas

  let palette;             // Uint32Array(ncolors) packed ABGR hue wheel
  let ncolors;             // captured palette size (2..255)
  let inc;                 // orbit phase; advances by morphSpeed each step
  let colorShift;          // palette rotation offset (palette-index units)

  // hsl (h in [0,1)) -> [r,g,b] each 0-255.
  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    const seg = Math.floor(h * 6) % 6;
    if (seg === 0) { r = c; g = x; }
    else if (seg === 1) { r = x; g = c; }
    else if (seg === 2) { g = c; b = x; }
    else if (seg === 3) { g = x; b = c; }
    else if (seg === 4) { r = x; b = c; }
    else { r = c; b = x; }
    return [
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255),
    ];
  }

  // A full-circle, fully-saturated hue wheel of ncolors entries, packed ABGR.
  function buildPalette() {
    palette = new Uint32Array(ncolors);
    for (let i = 0; i < ncolors; i++) {
      const [r, g, b] = hslToRgb(i / ncolors, 1, 0.5);
      palette[i] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
  }

  // The C's incr() orbit, scaled + clamped (see ORBIT_AMP/ORBIT_MAX above).
  function cParam(phase) {
    let cr = 1.5 * (Math.sin(Math.PI * (phase / 290.0)) * Math.sin(phase * Math.PI / 210.0));
    let ci = 1.5 * (Math.cos(Math.PI * (phase / 310.0)) * Math.cos(phase * Math.PI / 190.0));
    cr += 0.5 * Math.cos(Math.PI * phase / 395.0);
    ci += 0.5 * Math.sin(Math.PI * phase / 410.0);
    cr *= ORBIT_AMP;
    ci *= ORBIT_AMP;
    const m = Math.hypot(cr, ci);
    if (m > ORBIT_MAX) {
      cr = (cr / m) * ORBIT_MAX;
      ci = (ci / m) * ORBIT_MAX;
    }
    return [cr, ci];
  }

  // Escape-time iterate every grid pixel for the current c, writing a colour
  // into the Uint32 pixel buffer. In-set pixels (never escape) are black.
  function computeField(cr, ci) {
    const maxIter = config.maxIter | 0;
    const half = 0.5 * Math.min(gw, gh);
    const scale = (2.0 / config.zoom) / half;  // complex units per grid pixel
    const idxScale = ncolors / ITERS_PER_CYCLE;
    const shift = colorShift;
    let p = 0;
    for (let py = 0; py < gh; py++) {
      const zi0 = (py - gh / 2) * scale;
      for (let px = 0; px < gw; px++) {
        const zr0 = (px - gw / 2) * scale;
        let zr = zr0;
        let zi = zi0;
        let zr2 = zr * zr;
        let zi2 = zi * zi;
        let n = 0;
        while (n < maxIter && zr2 + zi2 <= 4.0) {
          zi = 2 * zr * zi + ci;
          zr = zr2 - zi2 + cr;
          zr2 = zr * zr;
          zi2 = zi * zi;
          n++;
        }
        if (n >= maxIter) {
          pixels[p] = BLACK;
        } else {
          // Smooth (fractional) escape count -> no hard contour stepping.
          const mag2 = zr2 + zi2;
          let sn = n + 1 - Math.log(Math.log(mag2) * 0.5 * INV_LOG2) * INV_LOG2;
          if (sn < 0) sn = 0;
          let idx = Math.floor(sn * idxScale + shift) % ncolors;
          if (idx < 0) idx += ncolors;
          pixels[p] = palette[idx];
        }
        p++;
      }
    }
  }

  // Draw the small ring marking the current control point c, mapped into the
  // same z-plane view as the field (the C draws this circle at z == c too).
  function drawDot(cr, ci) {
    const half = 0.5 * Math.min(gw, gh);
    const scale = (2.0 / config.zoom) / half;
    const dx = (cr / scale + gw / 2) * (canvas.width / gw);
    const dy = (ci / scale + gh / 2) * (canvas.height / gh);
    if (dx < 0 || dy < 0 || dx > canvas.width || dy > canvas.height) return;
    ctx.strokeStyle = 'white';
    ctx.lineWidth = Math.max(1, S);
    ctx.beginPath();
    ctx.arc(dx, dy, Math.max(3, 4 * S), 0, Math.PI * 2);
    ctx.stroke();
  }

  // One frame: advance the orbit, recompute the whole escape-time field, blit
  // it to the offscreen grid, upscale onto the main canvas, then mark c.
  function step() {
    inc += config.morphSpeed;
    if (config.cycle) {
      colorShift += 0.5;
      if (colorShift >= ncolors) colorShift -= ncolors;
    }

    const [cr, ci] = cParam(inc);
    computeField(cr, ci);

    sctx.putImageData(imageData, 0, 0);
    if (S === 1 && gw === canvas.width && gh === canvas.height) {
      ctx.drawImage(scratch, 0, 0);
    } else {
      ctx.drawImage(scratch, 0, 0, gw, gh, 0, 0, canvas.width, canvas.height);
    }

    drawDot(cr, ci);
  }

  function init() {
    S = window.devicePixelRatio || 1;

    // Compute grid = canvas at logical resolution, then capped so the long side
    // is at most MAX_FIELD. The main canvas upscales the result, keeping the
    // per-frame pixel work bounded and independent of dpr (see julia.md).
    let lw = Math.max(1, Math.round(canvas.width / S));
    let lh = Math.max(1, Math.round(canvas.height / S));
    const longSide = Math.max(lw, lh);
    if (longSide > MAX_FIELD) {
      const k = MAX_FIELD / longSide;
      lw = Math.max(1, Math.round(lw * k));
      lh = Math.max(1, Math.round(lh * k));
    }
    gw = lw;
    gh = lh;

    ncolors = Math.max(2, Math.min(255, Math.round(config.ncolors)));
    buildPalette();

    // Offscreen canvas + Uint32 pixel buffer at grid resolution.
    scratch = document.createElement('canvas');
    scratch.width = gw;
    scratch.height = gh;
    sctx = scratch.getContext('2d');
    imageData = sctx.createImageData(gw, gh);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    // Seed the orbit at a random phase (the C seeds jp->inc the same way); the
    // clamped orbit means any phase already shows a recognizable Julia set.
    inc = Math.floor(Math.random() * 400) - 200;
    colorShift = 0;

    // Start clean.
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

  // rAF lag-accumulator paced by config.delay (µs): run one step() per delay,
  // banking leftover time so the pace is identical at any refresh rate. Cap
  // catch-up so a backgrounded tab doesn't fire a burst of steps on refocus.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = config.delay / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (rebuilds the palette/grid because ncolors
  // and the canvas size them; also reseeds the orbit and clears the canvas).
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
