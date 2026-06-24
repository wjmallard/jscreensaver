// binaryring.js — binaryring packaged as a mountable module.
// start(canvas) returns { stop, reinit, config, params }.
//
// Port of xscreensaver's binaryring.c (Emilio Del Tessandoro, 2006-2014),
// itself a port of J. Tarbell's "Binary Ring" (complexification.net, 2004).
// https://www.jwz.org/xscreensaver/
//
// A flow field of particles emitted from a ring around the centre. Each frame a
// particle drifts (velocity nudged by a random "curliness" each step) and draws
// the segment it just travelled — mirrored left/right — as a low-alpha (0.15)
// line ACCUMULATED into a persistent pixel buffer. Particles die of old age and
// are reborn on the ring. The colour periodically drifts (light "epoch") or goes
// black (dark "epoch"), so the image alternately builds up and erases.
//
// Rendering note: this is line-shaped but it's really per-pixel compositing
// (read-blend-write each pixel) of thousands of tiny segments per frame, so it
// uses the BLIT path (manual raster + alpha into a Uint32 buffer), not canvas
// strokes (~10k draw calls/frame otherwise). The raster is Xiaolin Wu
// ANTIALIASED (the C's ANTIALIAS=1 default): each pixel is blended at
// coverage*0.15, and any segment with an endpoint off-window is dropped whole
// (the C's hard clip).

export const title = 'binaryring';

export const info = {
  author: 'J. Tarbell and Emilio Del Tessandoro',
  description: 'A system of path tracing particles evolves continuously from an initial creation, alternating dark and light colors.',
  year: 2014,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/binaryring.xml (units match: delay in
  // microseconds). max_age is a real .c resource (--max-age) that the stock
  // settings UI omits; curliness is the C's hardcoded 0.5, not a resource.
  const config = {
    delay: 10000,       // microseconds between frames (--growth-delay; stock)
    ringRadius: 40,     // emit-ring radius, logical px (--ring-radius; stock)
    particles: 5000,    // emitted particles (--particles-number; stock)
    maxAge: 400,        // steps a particle lives before rebirth (--max-age; stock)
    color: true,        // random-walk the light colour vs stay white (--color)
  };

  const params = [
    { key: 'delay', label: 'Growth delay', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ringRadius', label: 'Ring radius', type: 'range', min: 0, max: 400, step: 1, default: 40, unit: ' px', lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'particles', label: 'Particles', type: 'range', min: 500, max: 20000, step: 100, default: 5000, lowLabel: 'few', highLabel: 'lots', live: false },
    { key: 'maxAge', label: 'Path length', type: 'range', min: 20, max: 1200, step: 10, default: 400, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'color', label: 'Fade with colors', type: 'checkbox', default: true, live: true },
  ];

  // The C hardcodes st->curliness = 0.5 (not a resource): the per-step random
  // velocity nudge magnitude.
  const CURLINESS = 0.5;
  // Framework+draw overhead (us) added to the stock delay so the rAF accumulator
  // paces one step per (delay + OVERHEAD); binaryring's per-frame draw is heavy
  // (5000 particles x 2 Wu-AA segments + blit). Live-measured: 42.4fps (Load 57.6%,
  // clean) at stock delay 10000 -> OVERHEAD 13600. See binaryring.md.
  const OVERHEAD = 13600;

  const BLACK = 0xFF000000;

  let W, H, S, cx, cy;
  let imageData, pixels;
  let particles;
  let epoch;                 // 0 = dark, 1 = light
  let colorsRGB;             // [ [0,0,0], [r,g,b] ] — index 1 drifts

  const frand1 = () => Math.random() * 2 - 1;
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  // Blend (lerp) the buffer pixel toward (r,g,b) by alpha a. Buffer is
  // little-endian 0xAABBGGRR (R is the low byte), matching ImageData.
  function blend(x, y, r, g, b, a) {
    x |= 0; y |= 0;
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const idx = y * W + x;
    const c = pixels[idx];
    const or = c & 0xff, og = (c >> 8) & 0xff, ob = (c >> 16) & 0xff;
    const nr = (or + (r - or) * a) | 0;
    const ng = (og + (g - og) * a) | 0;
    const nb = (ob + (b - ob) * a) | 0;
    pixels[idx] = ((0xff << 24) | (nb << 16) | (ng << 8) | nr) >>> 0;
  }

  // C's (int) cast (truncate toward zero) + the round_/fpart_/rfpart_ macros.
  // The drawn region is >= 0 after the hard clip, so `| 0` matches C's (int).
  const ipart = (v) => v | 0;
  const round_ = (v) => (v + 0.5) | 0;
  const fpart = (v) => v - (v | 0);
  const rfpart = (v) => 1 - (v - (v | 0));

  // _dla_plot: blend one pixel at coverage*alpha (capped at 1); blend() clips to
  // the buffer, matching the C's in-bounds test in _dla_plot.
  function plotAA(x, y, cov, r, g, b, alpha) {
    let br = cov * alpha;
    if (br > 1) br = 1;
    blend(x, y, r, g, b, br);
  }

  // Xiaolin Wu antialiased line (the C's draw_line_antialias, ANTIALIAS=1).
  function drawLineAA(x1, y1, x2, y2, r, g, b, alpha) {
    // Hard clip: the C bails on the WHOLE line if any endpoint is off-window.
    if (x1 < 0 || x1 > W || x2 < 0 || x2 > W ||
        y1 < 0 || y1 > H || y2 < 0 || y2 > H) return;

    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) return;   // zero-length: the C draws nothing (NaN->OOB)

    if (Math.abs(dx) > Math.abs(dy)) {
      if (x2 < x1) { let t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; }
      const gradient = dy / dx;         // swap-invariant, so pre-swap dy/dx is correct

      let xend = round_(x1);
      let yend = y1 + gradient * (xend - x1);
      let xgap = rfpart(x1 + 0.5);
      const xpxl1 = xend;
      const ypxl1 = ipart(yend);
      plotAA(xpxl1, ypxl1, rfpart(yend) * xgap, r, g, b, alpha);
      plotAA(xpxl1, ypxl1 + 1, fpart(yend) * xgap, r, g, b, alpha);
      let intery = yend + gradient;

      xend = round_(x2);
      yend = y2 + gradient * (xend - x2);
      xgap = fpart(x2 + 0.5);
      const xpxl2 = xend;
      const ypxl2 = ipart(yend);
      plotAA(xpxl2, ypxl2, rfpart(yend) * xgap, r, g, b, alpha);
      plotAA(xpxl2, ypxl2 + 1, fpart(yend) * xgap, r, g, b, alpha);

      for (let x = xpxl1 + 1; x <= xpxl2 - 1; x++) {
        plotAA(x, ipart(intery), rfpart(intery), r, g, b, alpha);
        plotAA(x, ipart(intery) + 1, fpart(intery), r, g, b, alpha);
        intery += gradient;
      }
    } else {
      if (y2 < y1) { let t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; }
      const gradient = dx / dy;

      let yend = round_(y1);
      let xend = x1 + gradient * (yend - y1);
      let ygap = rfpart(y1 + 0.5);
      const ypxl1 = yend;
      const xpxl1 = ipart(xend);
      plotAA(xpxl1, ypxl1, rfpart(xend) * ygap, r, g, b, alpha);
      plotAA(xpxl1, ypxl1 + 1, fpart(xend) * ygap, r, g, b, alpha);
      let interx = xend + gradient;

      yend = round_(y2);
      xend = x2 + gradient * (yend - y2);
      ygap = fpart(y2 + 0.5);
      const ypxl2 = yend;
      const xpxl2 = ipart(xend);
      plotAA(xpxl2, ypxl2, rfpart(xend) * ygap, r, g, b, alpha);
      plotAA(xpxl2, ypxl2 + 1, fpart(xend) * ygap, r, g, b, alpha);

      for (let y = ypxl1 + 1; y <= ypxl2 - 1; y++) {
        plotAA(ipart(interx), y, rfpart(interx), r, g, b, alpha);
        plotAA(ipart(interx) + 1, y, fpart(interx), r, g, b, alpha);
        interx += gradient;
      }
    }
  }

  function nextColor() {
    const c = colorsRGB[1];
    c[0] = clamp(c[0] + (Math.random() * 5 | 0) - 2);
    c[1] = clamp(c[1] + (Math.random() * 5 | 0) - 2);
    c[2] = clamp(c[2] + (Math.random() * 5 | 0) - 2);
  }

  function emit(p, dx, dy, direction) {
    p.x = -dx; p.y = -dy;
    p.xx = 0; p.yy = 0;
    p.vx = 2 * S * Math.cos(direction);
    p.vy = 2 * S * Math.sin(direction);
    p.age = Math.random() * config.maxAge | 0;
    const c = colorsRGB[epoch];
    p.r = c[0]; p.g = c[1]; p.b = c[2];
  }

  function createParticles() {
    const n = Math.max(1, Math.round(config.particles));
    particles = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = Math.PI * 2 * (i / n);
      const rr = config.ringRadius * S;
      if (epoch === 1 && config.color) nextColor();
      particles[i] = {};
      emit(particles[i], rr * Math.sin(t), rr * Math.cos(t), (Math.PI * i) / n);
    }
  }

  function move(p) {
    p.xx = p.x; p.yy = p.y;
    p.x += p.vx; p.y += p.vy;
    p.vx += frand1() * CURLINESS * S;
    p.vy += frand1() * CURLINESS * S;

    drawLineAA(cx + p.xx, cy + p.yy, cx + p.x, cy + p.y, p.r, p.g, p.b, 0.15);
    drawLineAA(cx - p.xx, cy + p.yy, cx - p.x, cy + p.y, p.r, p.g, p.b, 0.15);

    if (++p.age > config.maxAge) {
      const dir = frand1() * 2 * Math.PI;
      const rr = config.ringRadius * S;
      p.x = rr * Math.sin(dir); p.y = rr * Math.cos(dir);
      p.xx = p.yy = p.vx = p.vy = 0;
      p.age = 0;
      if (epoch === 1 && config.color) nextColor();
      const c = colorsRGB[epoch];
      p.r = c[0]; p.g = c[1]; p.b = c[2];
    }
  }

  function step() {
    for (let i = 0; i < particles.length; i++) move(particles[i]);
    ctx.putImageData(imageData, 0, 0);
    if (Math.random() * 10000 > 9950) epoch = epoch === 1 ? 0 : 1;
  }

  function init() {
    const dpr = window.devicePixelRatio || 1;
    S = dpr;
    W = canvas.width;
    H = canvas.height;
    cx = W >> 1;
    cy = H >> 1;
    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);
    epoch = 1;
    colorsRGB = [[0, 0, 0], [255, 255, 255]];
    createParticles();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // Pace at (stock delay + measured overhead), converting microseconds -> ms.
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
    reinit: init,   // fresh buffer + particles with the current config
    config,
    params,
  };
}
