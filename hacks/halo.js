// halo.js — halo packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's halo.c (Jamie Zawinski, 1993).
// https://www.jwz.org/xscreensaver/
//
// Circular interference patterns (moire). A handful of "halos" — concentric
// ring families whose centres random-walk around the screen — all breathe
// outward together one ring-spacing per step. Where two families overlap the
// rings CANCEL, which is the whole effect: that cancellation is what carves the
// moire fringes out of the overlap. The families grow until the rings either
// fill the screen or collapse to points, then the motion reverses (breathe back
// in); when the screen goes blank the centres are re-picked and the palette
// shifts. Occasionally a family restarts from the inside, and every so often the
// buffer is wiped for a fresh start.
//
// Rendering: a PERSISTENT canvas (never fully cleared each frame) accumulates
// the rings, one stroked arc per centre per step, exactly mirroring the C's loop
// (one XFillArc per circle, radius += increment). See "Deviations" in halo.md —
// the C composites with GXxor so overlaps cancel; canvas has no XOR raster op,
// so this uses ctx.globalCompositeOperation = 'difference', which likewise drives
// white-on-white back to black (cancel-on-overlap) and reproduces the moire.

export const title = 'halo';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Circular interference patterns.',
  year: 1993,
};

export function start(canvas) {
  // 'difference' needs the source-over default off; we manage the op per draw.
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/halo.xml so the config box maps 1:1,
  // except `delay` is tuned a touch calmer than the stock 100000 us.
  const config = {
    delay: 60000,   // us between steps (--delay; xml default 100000)
    count: 0,       // number of halos; 0 = auto from screen size (--count)
    ncolors: 100,   // size of the rainbow palette (--colors)
    mode: 'random', // colour scheme: random | seuss | ramp (--mode)
    animate: false, // random-walk the centres while breathing (--animate)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 200000, step: 1000, default: 60000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Number of circles (0 = auto)', type: 'range', min: 0, max: 20, step: 1, default: 0, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 100, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'mode', label: 'Colour mode', type: 'select', default: 'random', live: false, options: [
        { value: 'random', label: 'Random' },
        { value: 'seuss', label: 'Seuss' },
        { value: 'ramp', label: 'Ramp' },
      ] },
    { key: 'animate', label: 'Animate circles', type: 'checkbox', default: false, live: false },
  ];

  // INTRAND-style helper: integer in [0, n).
  const nrand = (n) => Math.floor(Math.random() * n);
  const max = (a, b) => (a > b ? a : b);
  const min = (a, b) => (a < b ? a : b);

  let S = 1;            // devicePixelRatio (logical px -> device px)
  let W, H;             // canvas size, device px
  let scale;            // the C's st->scale: 1, or 3 on very large/retina canvases
  let palette;          // ncolors rainbow CSS strings (or null for two-colour)
  let circles;          // the live halo family: array of { x, y, radius, increment, dx, dy }
  let fgIndex, bgIndex; // palette cursors (the C's fg_index/bg_index)
  let lineWidth;        // ring stroke width, device px

  // Per-step / per-cycle state (the C's scalars on struct state).
  let iterations;       // step counter; done may only fire on an odd value
  let clearTick;        // countdown to a full wipe after a done (0 = inactive)
  let drawColor;        // CSS colour the current breath is stroked in

  // Build the live colour and choose the effective colour mode. random_mode in
  // the C resolves to ramp 1/4 of the time, else seuss; ramp disables animate.
  // We keep one rainbow palette and just track an effective mode flag.
  let seussMode;        // true: draw every breath; false (ramp): only on the way in
  let animateNow;       // animate after ramp may have forced it off

  function buildPalette() {
    const n = max(2, Math.round(config.ncolors));
    if (n <= 2) { palette = null; return; }   // the C's mono path -> white rings
    palette = new Array(n);
    for (let i = 0; i < n; i++) palette[i] = `hsl(${i * 360 / n}, 100%, 55%)`;
  }

  // Pick the working colour from the palette cursor (white when two-colour).
  function colorAt(i) {
    if (!palette) return '#fff';
    return palette[((i % palette.length) + palette.length) % palette.length];
  }

  // init_circles_1: (re)seed the halo family. global_count==0 -> a random count
  // that scales with the smaller screen dimension. Each circle gets a centre, a
  // small-biased ring spacing (increment), a starting radius, and a slow drift.
  function initCircles() {
    let count = config.count;
    if (count <= 0) {
      const span = max(1, Math.floor(min(W, H) / (50 * S)));
      count = 3 + nrand(span) + nrand(span);
    }

    circles = new Array(count);
    for (let i = 0; i < count; i++) {
      const x = 10 + nrand(max(1, W - 20));
      const y = 10 + nrand(max(1, H - 20));

      // Prefer smaller increments to larger ones (the C's triangular roll).
      let inc;
      const j = 8;
      inc = (nrand(j) + nrand(j) + nrand(j)) - ((j * 3) >> 1);
      if (inc < 0) inc = -inc + 3;
      inc = (inc + 3) * scale;

      const radius = nrand(max(1, inc));
      const dx = ((nrand(3) - 1) * (1 + nrand(5))) * scale;
      const dy = ((nrand(3) - 1) * (1 + nrand(5))) * scale;
      circles[i] = { x, y, radius, increment: inc, dx, dy };
    }
  }

  // halo_init / halo_reshape: size state, choose colours, seed circles, clear.
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // halo_reshape: scale up the ring spacing on very large (retina) canvases.
    scale = (W > 2560 || H > 2560) ? 3 : 1;

    lineWidth = max(1, Math.round(S));

    buildPalette();

    // Resolve the colour mode the way halo_init does.
    let mode = config.mode;
    if (!palette) mode = 'seuss';                 // mono -> seuss
    if (mode === 'random') mode = (nrand(4) === 1) ? 'ramp' : 'seuss';
    seussMode = (mode !== 'ramp');
    animateNow = config.animate && seussMode;     // ramp + animate "doesn't work right"

    // fg/bg palette cursors (the C seeds bg a quarter of the way round).
    if (palette) {
      fgIndex = 0;
      bgIndex = Math.floor(palette.length / 4);
      if (fgIndex === bgIndex) bgIndex++;
    } else {
      fgIndex = 0;
      bgIndex = 0;
    }

    iterations = 0;
    clearTick = 0;
    drawColor = colorAt(fgIndex);

    initCircles();

    // Start from a clean black buffer (XClearWindow + erase buffer).
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // Stroke one ring (one circle's current radius) into the persistent buffer.
  // 'difference' is the XOR stand-in: white-on-black -> white, white-on-white
  // (an overlap) -> black, so overlapping families cancel just like GXxor.
  function strokeRing(cx, cy, radius) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  // halo_draw: one breath. Erase nothing (the buffer persists); for each circle
  // test the done conditions, draw its current ring, then grow its radius. After
  // the loop, run the done state machine (reverse / re-pick / inside-restart).
  function step() {
    let done = false;
    const oddIter = (iterations & 1) !== 0;

    ctx.globalCompositeOperation = 'difference';
    ctx.strokeStyle = seussMode ? '#fff' : drawColor;
    ctx.lineWidth = lineWidth;

    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      const radius = c.radius;
      const inc = c.increment;

      // done detection — only ever on an odd iteration (never stop on even).
      if (!oddIter) {
        // skip the test
      } else if (radius === 0) {
        // eschew inf
      } else if (radius < 0) {
        done = true;                       // collapsed to points (breathed in)
      } else {
        // Is the screen rectangle fully enclosed by this circle? (breathed out)
        const x1 = (-c.x) / radius;
        const y1 = (-c.y) / radius;
        const x2 = (W - c.x) / radius;
        const y2 = (H - c.y) / radius;
        const a1 = x1 * x1, a2 = x2 * x2, b1 = y1 * y1, b2 = y2 * y2;
        if (a1 + b1 < 1 && a2 + b2 < 1 && a1 + b2 < 1 && a2 + b1 < 1) done = true;
      }

      // Draw this ring when drawing every breath (seuss) or on the way back in.
      if (radius > 0 && (seussMode || circles[0].increment < 0)) {
        strokeRing(c.x, c.y, radius);
      }

      c.radius += inc;
    }

    if (done) {
      if (animateNow) {
        // Random-walk the centres and wrap each radius (the C's anim branch),
        // bouncing centres off the edges.
        for (let i = 0; i < circles.length; i++) {
          const c = circles[i];
          c.x += c.dx;
          c.y += c.dy;
          c.radius = wrapMod(c.radius, c.increment);
          if (c.x < 0 || c.x >= W) { c.dx = -c.dx; c.x += 2 * c.dx; }
          if (c.y < 0 || c.y >= H) { c.dy = -c.dy; c.y += 2 * c.dy; }
        }
      } else if (circles[0].increment < 0) {
        // Breathed all the way in: blank screen -> re-pick centres, shift hues.
        initCircles();
        if (palette) {
          fgIndex = (fgIndex + 1) % palette.length;
          bgIndex = (fgIndex + Math.floor(palette.length / 2)) % palette.length;
        }
        drawColor = colorAt(fgIndex);
      } else if (clearTick === 0 && nrand(3) === 0) {
        // Sometimes restart from the inside instead of breathing back in.
        iterations = 0;   // ick (matches the C; reset below avoids the ++)
        for (let i = 0; i < circles.length; i++) {
          circles[i].radius = wrapMod(circles[i].radius, circles[i].increment);
        }
        clearTick = (nrand(8) + 4) | 1;   // must be odd
      } else {
        // Reverse: start breathing back in.
        for (let i = 0; i < circles.length; i++) {
          circles[i].increment = -circles[i].increment;
          circles[i].radius += 2 * circles[i].increment;
        }
      }
    }

    // ramp mode advances the stroke colour each breath (the C's merge_gc shift).
    if (!seussMode && palette) {
      fgIndex = (fgIndex + 1) % palette.length;
      drawColor = colorAt(fgIndex);
    }

    if (done) iterations = 0;
    else iterations++;

    // clear_tick countdown -> a full wipe a few breaths after it was armed.
    if (done && clearTick > 0) {
      clearTick--;
      if (clearTick === 0) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
      }
    }
  }

  // C-style modulo that keeps the sign of the dividend (JS `%` already does, but
  // guard a zero divisor so a degenerate increment can't NaN the radius).
  function wrapMod(a, b) {
    if (!b) return 0;
    return a % b;
  }

  function reinit() {
    init();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced by config.delay (us): run one step() per delay,
  // banking leftover time so the breathing pace is identical at any refresh
  // rate. Cap catch-up so a backgrounded tab doesn't burst steps on refocus.
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
    reinit,   // re-seed the halos + clear, keeping the current config
    config,
    params,
  };
}
