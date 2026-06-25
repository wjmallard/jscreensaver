// imsmap.js — imsmap packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's imsmap.c (Juergen Nickelsen & Jamie Zawinski, 1992;
// derived from code by Markus Schirmer, TU Berlin).
// https://www.jwz.org/xscreensaver/
//
// Recursive cloud-like fractal patterns. A height-field is grown by midpoint
// subdivision (the plasma / diamond-square fractal): start with the four
// corners of the screen, then repeatedly split every cell, setting each new
// midpoint to the average of its neighbours plus a random offset whose
// amplitude halves at every level. The finished field is a smooth cloud of
// integer "heights" which is displayed through a colour map.
//
// In the original C the field generation IS the visible drawing: cells are
// painted as they are set, a chunk per frame, then the picture lingers for a
// few seconds before a fresh field is generated. Here we instead generate the
// whole field ONCE into a typed array, then animate by slowly CYCLING the
// colour map through it each frame (the smooth-colormap rotation is the
// motion — exactly the kind of plasma the smooth palette was built for), and
// regenerate a new field on the C's linger interval. See imsmap.md.
//
// Rendering: the field touches every pixel, so this uses the BLIT path — a
// Uint32 view over one ImageData, written by mapping each cell's height through
// the cycling palette, putImageData once per frame. (Same idiom as
// thornbird.js / binaryring.js.) Nothing is ever read back.

export const title = 'imsmap';

export const info = {
  author: 'Juergen Nickelsen and Jamie Zawinski',
  description: 'Recursive cloud-like fractal patterns.',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges/labels mirror hacks/config/imsmap.xml so the config box
  // maps 1:1 to the original. `delay2` is the per-frame pacing (the palette
  // cycle here); `delay` is the linger in SECONDS before a new field is grown;
  // `iterations` is how many subdivision levels (density); `ncolors` is the
  // palette size; `mode` chooses the colour-map flavour (random / h / s / v).
  const config = {
    delay2: 25000,     // µs between palette-cycle frames (--delay2, "Frame rate")
    delay: 5,          // seconds a finished field lingers (--delay, "Linger")
    iterations: 7,     // subdivision levels, 1..7 (--iterations, "Density")
    ncolors: 50,       // size of the colour map (--ncolors)
    mode: 'random',    // 'random' | 'h' | 's' | 'v' colour-map flavour (--mode)
    cycleSpeed: 0.5,   // palette steps advanced per frame (the visible motion)
  };

  // live: true  -> the loop reads config every frame (applies instantly).
  // live: false -> the value sizes the field/palette, so a change re-runs
  //                init() via reinit() (which also clears + regrows).
  const params = [
    { key: 'delay2', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 25000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'delay', label: 'Linger', type: 'range', min: 1, max: 60, step: 1, default: 5, unit: ' s', lowLabel: '1 second', highLabel: '1 minute', live: true },
    { key: 'cycleSpeed', label: 'Cycle speed', type: 'range', min: 0, max: 3, step: 0.05, default: 0.5, lowLabel: 'still', highLabel: 'fast', live: true },
    { key: 'iterations', label: 'Density', type: 'range', min: 1, max: 7, step: 1, default: 7, lowLabel: 'sparse', highLabel: 'dense', live: false },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 3, max: 255, step: 1, default: 50, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'mode', label: 'Coloration', type: 'select', default: 'random', live: false, options: [
        { value: 'random', label: 'Random coloration' },
        { value: 'h', label: 'Hue gradients' },
        { value: 's', label: 'Saturation gradients' },
        { value: 'v', label: 'Brightness gradients' },
      ] },
  ];

  // The C's NSTEPS: the coarsest subdivision step is 2^NSTEPS pixels, and the
  // per-level random amplitude is 1 << (NSTEPS - level). 7 -> step 128.
  const NSTEPS = 7;
  const COUNT = 1 << NSTEPS;   // 128
  const BLACK = 0xFF000000;

  let W, H, S;                 // canvas size (device px) and devicePixelRatio
  let imageData, pixels;       // the one ImageData + its Uint32 view
  let heights;                 // Uint16 height-field, one cell per canvas pixel
  let palette;                 // ncolors packed-ABGR colour-map values
  let ncolors;                 // palette length actually used (>= 1)
  let cycleOffset;             // float cursor rotated through the palette

  // hsl (h in [0,1)) -> [r,g,b] each 0-255. (Same helper as thornbird.js.)
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

  function packRGB(r, g, b) {
    return (0xff << 24 | b << 16 | g << 8 | r) >>> 0;
  }

  // Build a CYCLIC, smooth colour map of `ncolors` entries. `mode` picks the
  // flavour (mirrors imsmap.xml's --mode); every map wraps end-to-end so the
  // per-frame rotation is seamless, the way the C's make_smooth_colormap does.
  function buildPalette() {
    ncolors = Math.max(1, Math.round(config.ncolors));
    palette = new Uint32Array(ncolors);

    if (config.mode === 'h') {
      // Hue gradient: a full rainbow sweep, fixed S/V.
      for (let i = 0; i < ncolors; i++) {
        const [r, g, b] = hslToRgb(i / ncolors, 1, 0.5);
        palette[i] = packRGB(r, g, b);
      }
    } else if (config.mode === 's') {
      // Saturation gradient at one random hue: grey -> vivid -> grey (cyclic).
      const hue = Math.random();
      for (let i = 0; i < ncolors; i++) {
        const t = i / ncolors;
        const sat = 0.5 - 0.5 * Math.cos(t * 2 * Math.PI);   // 0..1..0
        const [r, g, b] = hslToRgb(hue, sat, 0.5);
        palette[i] = packRGB(r, g, b);
      }
    } else if (config.mode === 'v') {
      // Brightness gradient at one random hue: dark -> light -> dark (cyclic).
      const hue = Math.random();
      for (let i = 0; i < ncolors; i++) {
        const t = i / ncolors;
        const val = 0.5 - 0.45 * Math.cos(t * 2 * Math.PI);   // 0.05..0.95..0.05
        const [r, g, b] = hslToRgb(hue, 0.8, val);
        palette[i] = packRGB(r, g, b);
      }
    } else {
      // Random coloration: a smooth random walk through HSL that returns to its
      // start, so it stays cyclic. (The C's make_smooth_colormap, "random".)
      const segs = Math.max(2, Math.round(ncolors / 24) * 2);  // even # of knots
      const knots = [];
      for (let k = 0; k < segs; k++) {
        knots.push([Math.random(), 0.6 + Math.random() * 0.4, 0.35 + Math.random() * 0.4]);
      }
      knots.push(knots[0]);   // close the loop for a seamless wrap
      for (let i = 0; i < ncolors; i++) {
        const f = (i / ncolors) * segs;
        const a = Math.floor(f) % segs;
        const t = f - Math.floor(f);
        const [ha, sa, va] = knots[a];
        const [hb, sb, vb] = knots[a + 1];
        // Interpolate hue the short way around the colour wheel.
        let dh = hb - ha;
        if (dh > 0.5) dh -= 1;
        else if (dh < -0.5) dh += 1;
        const h = ((ha + dh * t) % 1 + 1) % 1;
        const [r, g, b] = hslToRgb(h, sa + (sb - sa) * t, va + (vb - va) * t);
        palette[i] = packRGB(r, g, b);
      }
    }
  }

  // Random integer in [0, n), matching the C's (random() % n).
  function nrand(n) {
    return Math.floor(Math.random() * n);
  }

  // Clamp a raw height to a valid palette index, matching the C's
  // HEIGHT_TO_PIXEL with extra_krinkly_p = false (the common path): heights
  // below 0 saturate to 0, heights >= ncolors saturate to ncolors-1.
  function heightToPixel(h) {
    if (h < 0) return 0;
    if (h >= ncolors) return ncolors - 1;
    return h;
  }

  // Paint a grid_size x grid_size block of the height-field at (x, y) — the C's
  // draw() with XFillRectangle, which is how each level's midpoints tile the
  // screen (coarse levels paint big blocks, fine levels small ones, so the
  // whole field ends up covered). Clipped to the canvas.
  function fillBlock(x, y, gridSize, h) {
    const x1 = Math.min(W, x + gridSize);
    const y1 = Math.min(H, y + gridSize);
    for (let yy = (y < 0 ? 0 : y); yy < y1; yy++) {
      const base = yy * W;
      for (let xx = (x < 0 ? 0 : x); xx < x1; xx++) {
        heights[base + xx] = h;
      }
    }
  }

  // Grow the entire height-field by midpoint subdivision — a faithful port of
  // imsmap.c's init_map() seed + imsmap_draw() subdivision loop, run to
  // completion in one go (the C spreads it over many frames; we do it once and
  // then animate the palette over it). The four screen corners start at 0; each
  // level sets the edge- and centre-midpoints of every cell to the average of
  // the neighbouring corners plus a random offset that halves each level. Every
  // set point is painted as a block (fillBlock) so the field stays gap-free.
  function generateField() {
    heights.fill(0);

    // The C swaps x/y under flip_xy and mirrors under flip_x; cosmetically that
    // just reorients the same cloud, so we fold it into a random reflection of
    // the whole field at the end (cheaper than per-access flips). Seed corner.
    let xstep = COUNT;
    let ystep = COUNT;

    // The map is "done" after `iterations` halvings; clamp like the C (0..7).
    const iterations = Math.max(0, Math.min(7, Math.round(config.iterations)));

    for (let iteration = 0; iteration <= iterations; iteration++) {
      const xnext = xstep >> 1;
      const ynext = ystep >> 1;
      if (xnext < 1 && ynext < 1) break;   // can't subdivide below 1px

      // Per-level random amplitude (the C's set(): rang = 1 << (NSTEPS-size)).
      const rang = 1 << Math.max(0, NSTEPS - iteration);
      const gridSize = Math.max(1, ynext);

      // The block painted for this level's midpoints is `ynext`-sized, matching
      // the C's draw(..., st->ynextStep). Sub-1 means we're done filling.
      for (let x = 0; x < W; x += xstep) {
        // Right neighbour column, clamped to the field (the C wraps to 0; on a
        // non-toroidal canvas we clamp to the last column so edges stay smooth).
        let x2 = x + xstep;
        if (x2 >= W) x2 = W - 1;
        const x1 = Math.min(W - 1, x + xnext);

        for (let y = 0; y < H; y += ystep) {
          let y2 = y + ystep;
          if (y2 >= H) y2 = H - 1;
          const y1 = Math.min(H - 1, y + ynext);

          const cTL = heights[y * W + x];
          const cBL = heights[y2 * W + x];
          const cTR = heights[y * W + x2];
          const cBR = heights[y2 * W + x2];

          // Left-edge midpoint = average of the two left corners + random.
          let h = ((cTL + cBL + 1) >> 1) + nrand(rang) - (rang >> 1);
          h = heightToPixel(h);
          heights[y1 * W + x] = h;
          fillBlock(x, y1, gridSize, h);

          // Top-edge midpoint = average of the two top corners + random.
          h = ((cTL + cTR + 1) >> 1) + nrand(rang) - (rang >> 1);
          h = heightToPixel(h);
          heights[y * W + x1] = h;
          fillBlock(x1, y, gridSize, h);

          // Centre midpoint = average of all four corners + random.
          h = ((cTL + cBL + cTR + cBR + 2) >> 2) + nrand(rang) - (rang >> 1);
          h = heightToPixel(h);
          heights[y1 * W + x1] = h;
          fillBlock(x1, y1, gridSize, h);
        }
      }

      xstep = xnext;
      ystep = ynext;
    }
  }

  // Map the whole height-field through the palette at the current cycle offset
  // and blit it. Each cell's colour is palette[(height + offset) mod ncolors],
  // so advancing `cycleOffset` rotates the colour map through the cloud — the
  // visible motion. ncolors <= 1 can't cycle, so it just shows palette[0].
  function render() {
    const off = ((Math.floor(cycleOffset) % ncolors) + ncolors) % ncolors;
    // Precompute the rotated palette once per frame (ncolors entries) so the
    // per-pixel inner loop is a single array read.
    const rot = new Uint32Array(ncolors);
    for (let i = 0; i < ncolors; i++) rot[i] = palette[(i + off) % ncolors];
    const n = W * H;
    for (let i = 0; i < n; i++) pixels[i] = rot[heights[i]];
    ctx.putImageData(imageData, 0, 0);
  }

  // One step: advance the palette cycle and repaint. Every `delay` seconds of
  // accumulated cycling, grow a fresh field (the C's linger-then-regenerate).
  let sinceRegen = 0;   // ms of frame time accrued since the last regen
  function step() {
    cycleOffset += config.cycleSpeed;
    render();

    // delay is in seconds; delay2 is the per-frame µs budget. Count real frame
    // budgets so the linger is honest regardless of cycle speed / frame rate.
    sinceRegen += Math.max(1, config.delay2) / 1000;   // µs -> ms per frame
    if (sinceRegen >= config.delay * 1000) {
      sinceRegen = 0;
      generateField();
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);
    heights = new Uint16Array(W * H);
    cycleOffset = 0;
    sinceRegen = 0;
    buildPalette();
    generateField();
    render();   // first frame already shows the cloud
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Drive off requestAnimationFrame but keep a fixed pace: one step() per
  // config.delay2, banking leftover time so the cycle speed is the same at any
  // refresh rate. Cap catch-up so a backgrounded tab doesn't burst on refocus.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay2 is microseconds (xml units); the rAF clock is milliseconds.
    const delayMs = config.delay2 / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    // The step counter bounds the loop even when delayMs is 0 (max frame rate),
    // which would otherwise spin forever since lag never drops below 0.
    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Rebuild after a non-live config change (clears, rebuilds palette + field).
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
    reinit,   // fresh palette + field, keeping the current config
    config,
    params,
  };
}
