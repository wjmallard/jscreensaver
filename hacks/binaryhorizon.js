// binaryhorizon.js — binaryhorizon packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's binaryhorizon.c (Patrick Leiser, 2020-2021), a fork of
// binaryring.c (Emilio Del Tessandoro), itself after J. Tarbell's "Binary Ring"
// (complexification.net, 2004). https://www.jwz.org/xscreensaver/
//
// A "horizon" variant of Binary Ring: instead of emitting particles around a
// ring, they emit along a horizontal line spanning the whole width at the
// vertical centre, fan downward (each given an initial direction in [0, PI]),
// and draw the segment they just travelled — mirrored left/right — as a tiny
// low-alpha (0.15) antialiased line ACCUMULATED into a persistent pixel buffer.
// Particles die of old age and are reborn on a "horizon line" that drifts into
// the upper half (dark epoch) or lower half (light epoch). An "epoch" flips
// occasionally between light (the colour random-walks) and dark, so the field
// alternately builds up and erases. Every `duration` seconds the whole thing
// resets to a fresh horizon.
//
// Rendering note: like binaryring this is line-shaped but really per-pixel
// compositing (read-blend-write each pixel) of thousands of tiny segments per
// frame, so it uses the BLIT path (manual raster + alpha into a Uint32 buffer),
// not canvas strokes, which would be far too many draw calls. The C defaults to
// ANTIALIAS=1 (Xiaolin Wu lines), so this port draws the antialiased version.
// See [[binaryring]] and [[thornbird]] for the same idiom.

export const title = 'binaryhorizon';

export const info = {
  author: 'Patrick Leiser, J. Tarbell and Emilio Del Tessandoro',
  description: 'A system of path tracing particles evolves continuously from an initial horizon, alternating between colors.',
  year: 2021,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/binaryhorizon.xml so the config box maps
  // 1:1 to the original. `delay` is the xml --growth-delay slider in microseconds;
  // the loop paces at (delay + OVERHEAD).
  const config = {
    delay: 10000,       // \u00B5s between steps (--growth-delay); stock xml default
    particles: 5000,    // emitted particles (--particles-number); stock xml default
    duration: 30,       // seconds before a full reset (--duration)
    color: true,        // colour drift vs monochrome (--color)
    bicolor: true,      // dark epoch also drifts colour (--bicolor/--monocolor)
    fade: true,         // colour random-walks vs re-rolls fully (--fade/--no-fade)
  };

  // live: true  -> the loop reads config every step, so it applies instantly.
  // live: false -> the value sizes the particle pool / reset cadence, so a
  //                change re-runs init() via reinit() (fresh buffer).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'particles', label: 'Particles', type: 'range', min: 100, max: 20000, step: 100, default: 5000, lowLabel: 'few', highLabel: 'lots', live: false },
    { key: 'duration', label: 'Reset every', type: 'range', min: 1, max: 120, step: 1, default: 30, unit: ' s', lowLabel: '1 sec', highLabel: '2 min', live: true },
    { key: 'color', label: 'Random colors', type: 'checkbox', default: true, live: true },
    { key: 'bicolor', label: 'Two contrasting colors', type: 'checkbox', default: true, live: true },
    { key: 'fade', label: 'Random-walk colors', type: 'checkbox', default: true, live: true },
  ];

  const BLACK = 0xFF000000;
  const WHITE_EPOCH = 1;       // colours[1] — the drifting "light" colour
  const DARK_EPOCH = 0;        // colours[0] — black unless bicolor

  // C hardcodes st->curliness = 0.5 (not an Xrm resource, so there is no knob).
  const CURLINESS = 0.5;
  // Per-frame framework+draw cost added to config.delay so the loop paces at
  // (delay + OVERHEAD), matching the live binary's fps. Live-measured: 46.1fps
  // (Load 53.9%, clean) at stock delay 10000 -> OVERHEAD 11700. See binaryhorizon.md.
  const OVERHEAD = 11700;

  let W, H, S, cx, cy;
  let imageData, pixels;
  let particles;
  let epoch;                   // 0 = dark, 1 = light
  let colorsRGB;               // [ [r,g,b]_dark, [r,g,b]_light ]
  let lineHeight;              // y-offset (device px) of the rebirth horizon
  let startTime;               // ms timestamp of the current run
  let runDuration;             // ms until the next full reset (with jitter)
  let durationJitter;          // session-fixed +0..30% (C jitters duration once)

  // C's frand1(): roughly uniform in [-1, 1].
  const frand1 = () => Math.random() * 2 - 1;
  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  // Blend (lerp) the buffer pixel toward (r,g,b) by alpha a. Buffer is
  // little-endian 0xAABBGGRR (R is the low byte), matching ImageData. This is
  // the C's draw_point(): read the current pixel, lerp, write back.
  function drawPoint(x, y, r, g, b, a) {
    if (a > 1) a = 1;
    const idx = y * W + x;
    const c = pixels[idx];
    const or = c & 0xff, og = (c >> 8) & 0xff, ob = (c >> 16) & 0xff;
    const nr = (or + (r - or) * a) | 0;
    const ng = (og + (g - og) * a) | 0;
    const nb = (ob + (b - ob) * a) | 0;
    pixels[idx] = ((0xff << 24) | (nb << 16) | (ng << 8) | nr) >>> 0;
  }

  // C's _dla_plot(): bounds-check then plot at brightness br.
  function plot(x, y, r, g, b, br) {
    if (x >= 0 && x < W && y >= 0 && y < H) drawPoint(x, y, r, g, b, br);
  }

  const ipart = (v) => v | 0;
  const fpart = (v) => v - (v | 0);
  const rfpart = (v) => 1 - (v - (v | 0));

  // Xiaolin Wu antialiased line, alpha-blending each pixel at `alpha` weight.
  // This is the C's draw_line_antialias (ANTIALIAS=1, the stock default),
  // including its hard clip: if ANY endpoint is off-screen the whole line is
  // skipped (which is what keeps off-screen particles from drawing).
  function drawLine(x1, y1, x2, y2, r, g, b, alpha) {
    if (x1 < 0 || x1 > W || x2 < 0 || x2 > W ||
        y1 < 0 || y1 > H || y2 < 0 || y2 > H) {
      return;
    }

    let dx = x2 - x1;
    let dy = y2 - y1;

    if (Math.abs(dx) > Math.abs(dy)) {
      if (x2 < x1) { let t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; }
      const gradient = (x2 - x1) === 0 ? 0 : (y2 - y1) / (x2 - x1);

      let xend = Math.round(x1);
      let yend = y1 + gradient * (xend - x1);
      let xgap = rfpart(x1 + 0.5);
      const xpxl1 = xend;
      const ypxl1 = ipart(yend);
      plot(xpxl1, ypxl1, r, g, b, rfpart(yend) * xgap * alpha);
      plot(xpxl1, ypxl1 + 1, r, g, b, fpart(yend) * xgap * alpha);
      let intery = yend + gradient;

      xend = Math.round(x2);
      yend = y2 + gradient * (xend - x2);
      xgap = fpart(x2 + 0.5);
      const xpxl2 = xend;
      const ypxl2 = ipart(yend);
      plot(xpxl2, ypxl2, r, g, b, rfpart(yend) * xgap * alpha);
      plot(xpxl2, ypxl2 + 1, r, g, b, fpart(yend) * xgap * alpha);

      for (let x = xpxl1 + 1; x <= xpxl2 - 1; x++) {
        plot(x, ipart(intery), r, g, b, rfpart(intery) * alpha);
        plot(x, ipart(intery) + 1, r, g, b, fpart(intery) * alpha);
        intery += gradient;
      }
    } else {
      if (y2 < y1) { let t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; }
      const gradient = (y2 - y1) === 0 ? 0 : (x2 - x1) / (y2 - y1);

      let yend = Math.round(y1);
      let xend = x1 + gradient * (yend - y1);
      let ygap = rfpart(y1 + 0.5);
      const ypxl1 = yend;
      const xpxl1 = ipart(xend);
      // Textbook-correct Wu feathers the 2nd endpoint pixel horizontally (xpxl+1);
      // the C mis-places it vertically (ypxl+1) here — a copy-paste bug, visually
      // null over these soft 0.15-alpha segments. See binaryhorizon.md.
      plot(xpxl1, ypxl1, r, g, b, rfpart(xend) * ygap * alpha);
      plot(xpxl1 + 1, ypxl1, r, g, b, fpart(xend) * ygap * alpha);
      let interx = xend + gradient;

      yend = Math.round(y2);
      xend = x2 + gradient * (yend - y2);
      ygap = fpart(y2 + 0.5);
      const ypxl2 = yend;
      const xpxl2 = ipart(xend);
      plot(xpxl2, ypxl2, r, g, b, rfpart(xend) * ygap * alpha);
      plot(xpxl2 + 1, ypxl2, r, g, b, fpart(xend) * ygap * alpha);

      for (let y = ypxl1 + 1; y <= ypxl2 - 1; y++) {
        plot(ipart(interx), y, r, g, b, rfpart(interx) * alpha);
        plot(ipart(interx) + 1, y, r, g, b, fpart(interx) * alpha);
        interx += gradient;
      }
    }
  }

  // C's next_color(): drift the colour by a small random walk (fade), or re-roll
  // it fully at random (no-fade). Mutates the [r,g,b] triple in place.
  function nextColor(c) {
    if (config.fade) {
      c[0] = clamp255(c[0] + (Math.random() * 5 | 0) - 2);
      c[1] = clamp255(c[1] + (Math.random() * 5 | 0) - 2);
      c[2] = clamp255(c[2] + (Math.random() * 5 | 0) - 2);
    } else {
      c[0] = Math.random() * 255 | 0;
      c[1] = Math.random() * 255 | 0;
      c[2] = Math.random() * 255 | 0;
    }
  }

  // C's init_particle(): place a particle, seed its velocity from `direction`,
  // and give it a random starting age so the field doesn't pulse in lockstep.
  function initParticle(p, dx, dy, direction, colorRGB) {
    const maxInitialVelocity = 2 * S;
    p.x = -dx;
    p.y = -dy;
    p.xx = 0;
    p.yy = 0;
    p.vx = maxInitialVelocity * Math.cos(direction);
    p.vy = maxInitialVelocity * Math.sin(direction);
    p.age = Math.random() * maxAge() | 0;
    p.r = colorRGB[0];
    p.g = colorRGB[1];
    p.b = colorRGB[2];
  }

  // The C hardcodes max_age via the resource (default 400). It has no slider in
  // the stock xml, so we keep it as a constant in device-independent step units.
  function maxAge() {
    return 400;
  }

  // C's create_particles(): emit along the horizon line — the i-th particle at
  // x = width * i/N (so they span the whole width), y = 0 (the centre row),
  // heading fanned across [0, PI] so they drift downward and spread.
  function createParticles() {
    const n = Math.max(1, Math.round(config.particles));
    particles = new Array(n);
    for (let i = 0; i < n; i++) {
      const emitx = W * (i / n);
      const emity = 0;
      const direction = (Math.PI * i) / n;
      if (epoch === WHITE_EPOCH && config.color) nextColor(colorsRGB[WHITE_EPOCH]);
      particles[i] = {};
      initParticle(particles[i], emitx, emity, direction, colorsRGB[WHITE_EPOCH]);
    }
  }

  // C's move(): advance one particle, draw the segment it just travelled
  // (mirrored left/right), then reborn on the horizon line if too old.
  function move(p) {
    const maxDv = 1 * S;
    p.xx = p.x;
    p.yy = p.y;
    p.x += p.vx;
    p.y += p.vy;
    p.vx += frand1() * CURLINESS * maxDv;
    p.vy += frand1() * CURLINESS * maxDv;

    drawLine(cx + p.xx, cy + p.yy, cx + p.x, cy + p.y, p.r, p.g, p.b, 0.15);
    drawLine(cx - p.xx, cy + p.yy, cx - p.x, cy + p.y, p.r, p.g, p.b, 0.15);

    if (++p.age > maxAge()) {
      const dir = frand1() * 2 * Math.PI;
      p.x = W * Math.sin(dir);
      p.y = lineHeight;
      p.xx = p.yy = p.vx = p.vy = 0;
      p.age = 0;
      if (epoch === WHITE_EPOCH && config.color) nextColor(colorsRGB[WHITE_EPOCH]);
      if (epoch === DARK_EPOCH && config.color && config.bicolor) nextColor(colorsRGB[DARK_EPOCH]);
      const c = colorsRGB[epoch];
      p.r = c[0];
      p.g = c[1];
      p.b = c[2];
    }
  }

  // One step == one frame of the C's binaryhorizon_draw: optional full reset,
  // move every particle, blit, then occasionally flip the epoch and pick a new
  // horizon-line height (upper half for dark, lower half for light).
  function step() {
    const now = performance.now();
    if (runDuration && now > startTime + runDuration) {
      reset(now);
    }

    for (let i = 0; i < particles.length; i++) move(particles[i]);

    ctx.putImageData(imageData, 0, 0);

    if (Math.random() * 10000 > 9975) {
      epoch = epoch === WHITE_EPOCH ? DARK_EPOCH : WHITE_EPOCH;
      // -abs(...) lands the line in the upper half (negative offset from cy);
      // flipping the sign for the light epoch moves it into the lower half.
      lineHeight = -Math.abs((frand1() * H / 2) | 0);
      if (epoch === WHITE_EPOCH) lineHeight = -lineHeight;
    }
  }

  // C's full reset (every `duration` seconds): fresh black buffer, white epoch,
  // re-emitted horizon. Mirrors binaryhorizon_draw's reset branch, which clears
  // the buffer and re-creates particles but does NOT reset the drifting colours
  // or the horizon line (both carry over, then keep drifting / flip as before).
  // Keeps the picture from saturating over a long run.
  function reset(now) {
    startTime = now;
    runDuration = computeDuration();
    epoch = WHITE_EPOCH;
    pixels.fill(BLACK);
    createParticles();
  }

  // C jitters duration by up to +30% so multiple screens aren't in lockstep, but
  // only ONCE at init (the reset branch reuses that value), so cycle length is
  // constant within a session. durationJitter is fixed in init(); applying it to
  // the live config.duration here keeps the slider responsive.
  function computeDuration() {
    const d = Math.max(0, Math.round(config.duration));
    if (d <= 0) return 0;
    return d * durationJitter * 1000;   // -> ms
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    cx = W >> 1;
    cy = H >> 1;
    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);
    epoch = WHITE_EPOCH;
    lineHeight = 0;
    colorsRGB = [[0, 0, 0], [255, 255, 255]];
    durationJitter = 1 + Math.random() * 0.3;   // fixed for the session (C jitters once)
    startTime = performance.now();
    runDuration = computeDuration();
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

  // rAF lag-accumulator paced at (config.delay + OVERHEAD) microseconds: run one
  // step() per period, banking leftover time so the pace holds at any rate. Cap
  // catch-up so a backgrounded tab doesn't fire a burst of steps on refocus.
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
