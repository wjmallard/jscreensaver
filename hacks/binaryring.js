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
// (read-blend-write each pixel) of thousands of tiny segments per frame — so it
// uses the BLIT path (manual raster + alpha into a Uint32 buffer), not canvas
// strokes, which would be far too many draw calls.

export const title = 'binaryring';

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  const config = {
    particles: 4000,    // orig 5000
    ringRadius: 40,     // emit ring radius (logical px)
    maxAge: 400,        // steps a particle lives before rebirth
    curliness: 0.5,     // random velocity nudge per step
    color: true,        // colour drift vs monochrome
    delay: 16,          // ms per step (orig 10)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 1, max: 60, step: 1, default: 16, unit: ' ms', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'particles', label: 'Particles', type: 'range', min: 200, max: 8000, step: 100, default: 4000, live: false },
    { key: 'ringRadius', label: 'Ring radius', type: 'range', min: 1, max: 200, step: 1, default: 40, unit: ' px', live: true },
    { key: 'maxAge', label: 'Path length', type: 'range', min: 20, max: 1200, step: 10, default: 400, live: true },
    { key: 'curliness', label: 'Curliness', type: 'range', min: 0, max: 2, step: 0.05, default: 0.5, lowLabel: 'smooth', highLabel: 'wild', live: true },
    { key: 'color', label: 'Color', type: 'checkbox', default: true, live: true },
  ];

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

  // Bresenham line, alpha-blending each pixel (the C's non-antialiased path).
  function drawLine(x0, y0, x1, y1, r, g, b, a) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
    if (steep) { let t = x0; x0 = y0; y0 = t; t = x1; x1 = y1; y1 = t; }
    if (x0 > x1) { let t = x0; x0 = x1; x1 = t; t = y0; y0 = y1; y1 = t; }
    const dx = x1 - x0, dy = Math.abs(y1 - y0);
    let err = 0, y = y0;
    const ystep = y0 < y1 ? 1 : -1;
    for (let x = x0; x <= x1; x++) {
      if (steep) blend(y, x, r, g, b, a); else blend(x, y, r, g, b, a);
      err += dy;
      if ((err << 1) > dx) { y += ystep; err -= dx; }
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
    p.vx += frand1() * config.curliness * S;
    p.vy += frand1() * config.curliness * S;

    drawLine(cx + p.xx, cy + p.yy, cx + p.x, cy + p.y, p.r, p.g, p.b, 0.15);
    drawLine(cx - p.xx, cy + p.yy, cx - p.x, cy + p.y, p.r, p.g, p.b, 0.15);

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

    const delay = Math.max(1, config.delay);
    lag = Math.min(lag, delay * MAX_CATCHUP_STEPS);
    let steps = 0;
    while (lag >= delay && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delay;
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
    reinit: init,   // fresh buffer + particles with the current config
    config,
    params,
  };
}
