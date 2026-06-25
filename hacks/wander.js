// wander.js — wander packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's wander.c (Rick Campbell, 1998). https://www.jwz.org/xscreensaver/
//
// A long biased random walk: a single walker steps -1/0/+1 in x and y each move
// (the screen wraps), leaving a colour-cycled trail. `density` thins the walk
// (only 1-in-density iterations actually step, the rest redraw the last point);
// `length` controls how often the trail colour advances; `reset` how often the
// walker clears the screen and starts over from a fresh spot. The C runs 2000
// walk iterations per drawn frame.
//
// Rendering: 2000 single-pixel (or small-block) draws per frame, accumulated
// over thousands of frames into a persistent image — so this uses the BLIT path
// (write pixels into a persistent Uint32 ImageData buffer, putImageData once per
// frame) rather than 2000 fillRect calls/frame. See binaryring.js / thornbird.js.

export const title = 'wander';

export const info = {
  author: 'Rick Campbell',
  description: 'A colorful random-walk.',
  year: 1999,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/wander.xml so the config box maps 1:1 to
  // the original. `ncolors` isn't in the stock UI (it hardcodes a 256-step rainbow
  // loop) but we expose it for parity with the other ports. `delay` is a touch
  // calmer than the stock 20000 by feel (see wander.md).
  const config = {
    delay: 30000,        // µs between frames (--delay; stock 20000)
    density: 2,          // 1-in-density iterations step; rest redraw last (--density)
    reset: 2500000,      // ~1/reset chance per iteration to clear + respawn (--reset)
    length: 25000,       // ~1/length chance per iteration to advance colour (--length)
    advance: 1,          // colour step per change; 0 = random (--advance)
    circles: false,      // draw filled discs instead of squares (size>1) (--circles)
    size: 1,             // block size in logical px (--size)
    ncolors: 256,        // size of the rainbow colour loop
  };

  // live: true  -> the loop reads config every iteration, so edits apply instantly.
  // live: false -> the value sizes the grid/palette, so a change re-runs init()
  //                via reinit() (which clears the canvas).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'density', label: 'Density', type: 'range', min: 1, max: 30, step: 1, default: 2, invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'reset', label: 'Duration', type: 'range', min: 10000, max: 3000000, step: 10000, default: 2500000, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'length', label: 'Length', type: 'range', min: 100, max: 100000, step: 100, default: 25000, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'advance', label: 'Color contrast', type: 'range', min: 0, max: 100, step: 1, default: 1, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'circles', label: 'Draw spots', type: 'checkbox', default: false, live: false },
    { key: 'size', label: 'Size', type: 'range', min: 1, max: 20, step: 1, default: 1, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 256, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  const BLACK = 0xFF000000;
  const ITERATIONS = 2000;     // walk iterations per drawn frame (verbatim C)

  let W, H, S;                 // canvas size (device px) and devicePixelRatio
  let imageData, pixels;       // persistent Uint32 accumulation buffer
  let palette;                 // ncolors packed-ABGR rainbow values

  let gw, gh;                  // grid size = canvas size / size (in size-blocks)
  let size;                    // block size in device px (size * dpr, *3 on retina)
  let stamp;                   // offsets of a filled disc within a block (circles)

  // Walker state (matches the C's struct fields).
  let x, y, lastX, lastY, width1, height1;
  let colorIndex, colorValue;

  // NRAND(n) in the C is random in [0, n). NRAND(0) is undefined there but the
  // resources guarantee the divisors are >= 1, so we mirror that.
  function nrand(n) {
    return (Math.random() * n) | 0;
  }

  // hsl (h in [0,1)) -> [r,g,b] each 0-255.
  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const xx = c * (1 - Math.abs(((h * 6) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    const seg = Math.floor(h * 6) % 6;
    if (seg === 0) { r = c; g = xx; }
    else if (seg === 1) { r = xx; g = c; }
    else if (seg === 2) { g = c; b = xx; }
    else if (seg === 3) { g = xx; b = c; }
    else if (seg === 4) { r = xx; b = c; }
    else { r = c; b = xx; }
    return [
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255),
    ];
  }

  // The C's make_color_loop sweeps hue 0 -> 120 -> 240 at full saturation/value,
  // i.e. a full rainbow (it loops, but only [0,240] of the wheel is one period;
  // matching that two-thirds sweep keeps the original's red->green->blue feel).
  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    palette = new Uint32Array(n);
    for (let p = 0; p < n; p++) {
      const h = (p / n) * (240 / 360);
      const [r, g, b] = hslToRgb(h, 1, 0.5);
      palette[p] = (0xff << 24 | b << 16 | g << 8 | r) >>> 0;
    }
  }

  // Precompute the pixel offsets of a filled disc inside a size x size block,
  // so "Draw spots" can stamp a circle as cheaply as a square (mirrors the C's
  // precomputed circle pixmap that XCopyArea blits per point).
  function buildStamp() {
    const offsets = [];
    const r = size / 2;
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const ox = dx + 0.5 - r;
        const oy = dy + 0.5 - r;
        if (ox * ox + oy * oy <= r * r) offsets.push(dy * W + dx);
      }
    }
    stamp = Int32Array.from(offsets);
  }

  // Paint the walker at grid cell (gx,gy) in packed colour `value`. For size==1
  // it's a single pixel; otherwise a size x size square (or a disc if circles).
  function plot(gx, gy, value) {
    const px = gx * size;
    const py = gy * size;
    if (size === 1) {
      if (px >= 0 && px < W && py >= 0 && py < H) pixels[py * W + px] = value;
      return;
    }
    const base = py * W + px;
    if (config.circles) {
      for (let k = 0; k < stamp.length; k++) {
        const idx = base + stamp[k];
        if (idx >= 0 && idx < pixels.length) pixels[idx] = value;
      }
      return;
    }
    for (let dy = 0; dy < size; dy++) {
      const yy = py + dy;
      if (yy < 0 || yy >= H) continue;
      const rowBase = yy * W;
      for (let dx = 0; dx < size; dx++) {
        const xx = px + dx;
        if (xx >= 0 && xx < W) pixels[rowBase + xx] = value;
      }
    }
  }

  // Clear to black + respawn the walker at a fresh spot in a fresh colour. The C
  // runs an erase transition here; with no X11 GC we clear to black instantly.
  function resetWalk() {
    pixels.fill(BLACK);
    colorValue = palette[nrand(palette.length)];
    x = nrand(gw);
    y = nrand(gh);
    lastX = x;
    lastY = y;
  }

  // One drawn frame == 2000 walk iterations (verbatim C's draw loop).
  function step() {
    const density = Math.max(1, config.density);
    const lengthLimit = Math.max(1, config.length);
    const resetLimit = Math.max(100, config.reset);
    const advance = config.advance;
    const ncolors = palette.length;

    for (let i = 0; i < ITERATIONS; i++) {
      // 1-in-density iterations actually step; the rest revert to the last point
      // (so the walk is thinned but a point is still drawn every iteration).
      if (nrand(density)) {
        x = lastX;
        y = lastY;
      } else {
        lastX = x;
        lastY = y;
        // width_1 + NRAND(3) == (width-1) + {0,1,2} == a {-1,0,+1} step mod width.
        x += width1 + nrand(3);
        while (x >= gw) x -= gw;
        y += height1 + nrand(3);
        while (y >= gh) y -= gh;
      }

      // ~1/length chance to advance the trail colour.
      if (nrand(lengthLimit) === 0) {
        if (advance === 0) {
          colorIndex = nrand(ncolors);
        } else {
          colorIndex = (colorIndex + advance) % ncolors;
        }
        colorValue = palette[colorIndex];
      }

      // ~1/reset chance to wipe and start over.
      if (nrand(resetLimit) === 0) {
        resetWalk();
      }

      plot(x, y, colorValue);
    }

    ctx.putImageData(imageData, 0, 0);
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // size in device px; the C triples it on very large (retina) displays.
    size = Math.max(1, Math.round(config.size)) * S;
    if (W > 2560 || H > 2560) size *= 3;
    size = Math.max(1, Math.round(size));

    // Grid is the canvas measured in size-blocks (the C divides w/h by size).
    gw = Math.max(1, Math.floor(W / size));
    gh = Math.max(1, Math.floor(H / size));
    width1 = gw - 1;
    height1 = gh - 1;

    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    buildPalette();
    if (size > 1) buildStamp();

    // Seed the walker (verbatim C: random position, last == current).
    x = nrand(gw);
    y = nrand(gh);
    lastX = x;
    lastY = y;
    colorIndex = nrand(palette.length);
    colorValue = palette[nrand(palette.length)];

    // Draw the first point so frame 1 already shows the walker.
    plot(x, y, colorValue);
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

  // Re-seed with the current config (clears the accumulation buffer because
  // size/colors resize the grid and palette).
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
