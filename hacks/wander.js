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
  description: 'A colorful random-walk.\n\nhttps://en.wikipedia.org/wiki/Random_walk',
  year: 1999,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/wander.xml so the config box maps 1:1 to
  // the original. There is no `ncolors` resource: the C hardcodes a 256-entry
  // full-saturation rainbow loop (MAXIMUM_COLOR_COUNT), so the palette is fixed.
  const config = {
    delay: 20000,        // µs between frames (--delay, stock 20000)
    density: 2,          // 1-in-density iterations step; rest redraw last (--density)
    reset: 2500000,      // ~1/reset chance per iteration to clear + respawn (--reset)
    length: 25000,       // ~1/length chance per iteration to advance colour (--length)
    advance: 1,          // colour step per change; 0 = random (--advance)
    circles: false,      // draw filled discs instead of squares (size>1) (--circles)
    size: 1,             // block size in device px (--size)
  };

  // live: true  -> the loop reads config every iteration, so edits apply instantly.
  // live: false -> the value sizes the grid/palette, so a change re-runs init()
  //                via reinit() (which clears the canvas).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'density', label: 'Density', type: 'range', min: 1, max: 30, step: 1, default: 2, invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'reset', label: 'Duration', type: 'range', min: 10000, max: 3000000, step: 10000, default: 2500000, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'length', label: 'Length', type: 'range', min: 100, max: 100000, step: 100, default: 25000, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'advance', label: 'Color contrast', type: 'range', min: 1, max: 100, step: 1, default: 1, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'circles', label: 'Draw spots', type: 'checkbox', default: false, live: false },
    { key: 'size', label: 'Size', type: 'range', min: 1, max: 100, step: 1, default: 1, lowLabel: 'small', highLabel: 'large', live: false },
  ];

  const BLACK = 0xFF000000;
  const ITERATIONS = 2000;     // walk iterations per drawn frame (verbatim C)
  const MAX_COLORS = 256;      // MAXIMUM_COLOR_COUNT — fixed palette size (verbatim C)

  let W, H;                    // canvas size (device px)
  let imageData, pixels;       // persistent Uint32 accumulation buffer
  let palette;                 // MAX_COLORS packed-ABGR rainbow-loop values

  let gw, gh;                  // grid size = canvas size / size (in size-blocks)
  let size;                    // block size in device px (*3 on retina, per the C)
  let stamp;                   // offsets of a filled disc within a block (circles)

  // Walker state (matches the C's struct fields).
  let x, y, lastX, lastY, width1, height1;
  let colorIndex, colorValue;

  // NRAND(n) in the C is random in [0, n). NRAND(0) is undefined there but the
  // resources guarantee the divisors are >= 1, so we mirror that.
  function nrand(n) {
    return (Math.random() * n) | 0;
  }

  // hsv_to_rgb (utils/hsv.c): h in degrees, s,v in [0,1]. Returns [r,g,b] 0..255.
  // Faithful to the C — integer hue, then the 16-bit-channel >>8 downsample (==
  // floor(c*256), the same as colormap.js's to255). wander only ever calls this
  // at full saturation/value, but the general form keeps it honest.
  function hsvToRgb(h, s, v) {
    const H = (((h % 360) + 360) % 360) / 60;
    const i = Math.trunc(H);
    const f = H - i;
    const p1 = v * (1 - s);
    const p2 = v * (1 - s * f);
    const p3 = v * (1 - s * (1 - f));
    let r, g, b;
    if      (i === 0) { r = v;  g = p3; b = p1; }
    else if (i === 1) { r = p2; g = v;  b = p1; }
    else if (i === 2) { r = p1; g = v;  b = p3; }
    else if (i === 3) { r = p1; g = p2; b = v;  }
    else if (i === 4) { r = p3; g = p1; b = v;  }
    else              { r = v;  g = p1; b = p2; }
    return [to255(r), to255(g), to255(b)];
  }

  // 16-bit-quantized channel -> 8-bit, matching the X server's downsample.
  function to255(c) {
    return c <= 0 ? 0 : c >= 1 ? 255 : Math.floor(c * 256);
  }

  // make_color_loop(0,1,1 -> 120,1,1 -> 240,1,1, closed) (utils/colors.c) routed
  // through make_color_path: three equal edges (each 1/3 of the wheel), so each
  // gets trunc(256/3) = 85 colours, hue stepping by 120/85 deg from its anchor at
  // full saturation/value; the 255 generated entries leave colors[255] padded from
  // colors[254] (the C's float round-off pad). Net result: a UNIFORM rainbow over
  // the WHOLE hue wheel (red -> green -> blue -> red). Built once; never cycled.
  function buildPalette() {
    palette = new Uint32Array(MAX_COLORS);
    const anchors = [0, 120, 240];
    const per = Math.trunc(MAX_COLORS / anchors.length);   // 85 colours per edge
    const dh = 120 / per;                                  // hue step within an edge
    let k = 0;
    for (let e = 0; e < anchors.length; e++) {
      for (let j = 0; j < per; j++, k++) {
        const [r, g, b] = hsvToRgb(Math.trunc(anchors[e] + j * dh), 1, 1);
        palette[k] = (0xff << 24 | b << 16 | g << 8 | r) >>> 0;
      }
    }
    for (; k < MAX_COLORS; k++) palette[k] = palette[k - 1];   // round-off pad
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

      // ~1/length chance to advance the trail colour. advance===0 is the C's
      // random-colour mode (-advance 0); the xml slider starts at 1 so the UI
      // never reaches it, but the branch is kept to match the C exactly.
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
    W = canvas.width;
    H = canvas.height;

    // size is in device pixels, exactly as the C's `size` (X11 reports device px,
    // and canvas.width is device px too). The C triples it when the backing store
    // exceeds 2560 px in either dimension ("Retina displays"). Do NOT scale by
    // devicePixelRatio: the C never does, and canvas.width already IS device px.
    size = Math.max(1, Math.round(config.size));
    if (W > 2560 || H > 2560) size *= 3;

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
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead — see the framerate-calibration note). The
  // live wander measures 37.0 fps, but the port at the stock 20000 µs ran 50
  // steps/sec (1.35x fast). 20000 + 7027 = 27027 µs -> 37.0 steps/sec, matching
  // the live binary. A calibration, not a tuning knob (the slider still maps 1:1
  // to the xml delay).
  const OVERHEAD = 7027;
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

  // Re-seed with the current config (clears the accumulation buffer because
  // size/circles resize the grid and the stamp).
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
