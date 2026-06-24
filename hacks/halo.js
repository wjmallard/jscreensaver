// halo.js — halo packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's halo.c (Jamie Zawinski, 1993).
// https://www.jwz.org/xscreensaver/
//
// Circular interference patterns (moire). A handful of "halos" — concentric
// ring families whose centres random-walk around the screen — all breathe
// outward together one ring-spacing per step. Where two families overlap the
// rings CANCEL, which is the whole effect: that cancellation carves the moire
// fringes out of the overlap. The families grow until the rings either fill the
// screen or collapse to points, then the motion reverses (breathe back in);
// when the screen goes blank the centres are re-picked and the palette shifts.
// Occasionally a family restarts from the inside, and every so often the buffer
// is wiped for a fresh start.
//
// Rendering (faithful to the C's two-pixmap pipeline): the XOR runs in a
// PIXEL-EXACT depth-1 plane held as a typed array, so cancellation is EXACT with
// zero antialiasing (canvas arc().fill() rounds ~1px differently as the radius
// grows, leaving a faint residual outline that never fully cancels). Each step
// this step's union of FILLED disks is scan-converted into `frameBits` using
// X11's center-inside-radius fill rule, then XORed into the persistent `bufBits`
// plane (255^255=0, 255^0=255 -- exact). The plane is COLOURISED at blit time
// exactly like the C's copy_gc: set bits -> colors[fgIndex], clear bits ->
// colors[bgIndex], the cursors advancing per re-pick. The palette is the C's own
// make_uniform_colormap / make_smooth_colormap (via colormap.js), chosen once at
// init. "ramp" mode skips the plane and over-paints filled disks straight onto
// the canvas (the C's GXcopy path) in the cycling colour, only while breathing in.

import { makeColorRampRGB, makeSmoothColormapRGB } from './colormap.js';

export const title = 'halo';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Circular interference patterns.\n\nhttps://en.wikipedia.org/wiki/Moire_pattern',
  year: 1993,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/halo.xml so the config box maps 1:1 to
  // the original (delay = the stock 100000 us, so the slider maps 1:1 to the xml
  // resource).
  const config = {
    delay: 100000,  // us between steps (--delay; xml/C stock 100000). No OVERHEAD:
                    // at 100000 us the nominal 10 fps already matches the live
                    // 8.7 fps within the -fps overlay's ~15% noise (slow hack,
                    // framework overhead negligible -- see framerate-calibration).
    count: 0,       // number of halos; 0 = auto from screen size (--count)
    ncolors: 100,   // size of the palette (--colors)
    mode: 'random', // colour scheme: random | seuss | ramp (--mode)
    animate: false, // random-walk the centres while breathing (--animate)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 200000, step: 1000, default: 100000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
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

  let W, H;             // canvas size, device px
  let scale;            // the C's st->scale: 1, or 3 on very large/retina canvases
  let palette;          // ncolors [r,g,b] (0..255) triplets, or null for mono
  let circles;          // the live halo family: array of { x, y, radius, increment, dx, dy }
  let fgIndex, bgIndex; // palette cursors (the C's fg_index/bg_index)

  // Per-step / per-cycle state (the C's scalars on struct state).
  let iterations;       // step counter; done may only fire on an odd value
  let clearTick;        // countdown to a full wipe after a done (0 = inactive)
  let doneOnce;         // the C's st->done_once (animate fast-forward + blit gate)

  // The effective colour mode (random_mode in the C resolves to ramp 1/4 of the
  // time, else seuss; ramp also disables animate).
  let seussMode;        // true: draw every breath into the XOR buffer; false (ramp)
  let animateNow;       // animate after ramp may have forced it off

  // The C's depth-1 pixmap (this step's disk union) and persistent depth-1 buffer
  // (the XOR accumulation), held as pixel-exact 0/255 typed arrays. Seuss only.
  let frameBits;              // this step's disk union (W*H, 0 or 255)
  let bufBits;               // persistent XOR plane (W*H, 0 or 255)
  let visImageData, visU32;   // reusable RGBA target for the colourised blit

  // halo_init's colormap step: make_uniform_colormap (a one-way hue ramp 0->359
  // at a random high S,V) most of the time, else make_smooth_colormap (the muted
  // 2-5 anchor HSV loop). Built ONCE per init, exactly as halo_init does; only
  // the fg/bg cursors move during a run. ncolors <= 2 -> mono (white/black).
  function buildPalette(n) {
    if (n <= 2) { palette = null; return; }
    // random() % (seuss ? 2 : 10) nonzero -> uniform (seuss 1/2, ramp 9/10).
    if (nrand(seussMode ? 2 : 10) !== 0) {
      const S = (nrand(34) + 66) / 100;   // 66%-100%
      const V = (nrand(34) + 66) / 100;   // 66%-100%
      palette = makeColorRampRGB(0, S, V, 359, S, V, n, false);
    } else {
      palette = makeSmoothColormapRGB(n);
    }
  }

  // The current ramp draw colour (palette[fgIndex]) as a CSS string.
  function colorCss(i) {
    if (!palette) return '#fff';
    const c = palette[((i % palette.length) + palette.length) % palette.length];
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  // init_circles_1: (re)seed the halo family. global_count==0 -> a random count
  // that scales with the smaller screen dimension. Each circle gets a centre, a
  // small-biased ring spacing (increment), a starting radius, and a slow drift.
  // The C counts in device px and does NOT scale dx/dy (only `increment`).
  function initCircles() {
    let count = config.count;
    if (count <= 0) {
      const span = max(1, Math.floor(min(W, H) / 50));
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
      const dx = (nrand(3) - 1) * (1 + nrand(5));
      const dy = (nrand(3) - 1) * (1 + nrand(5));
      circles[i] = { x, y, radius, increment: inc, dx, dy };
    }
  }

  // halo_init / halo_reshape: size state, choose colours, seed circles, clear.
  function init() {
    W = canvas.width;
    H = canvas.height;

    // halo_reshape: scale up the ring spacing on very large (retina) canvases.
    scale = (W > 2560 || H > 2560) ? 3 : 1;

    // Resolve the colour mode the way halo_init does (before the colormap step).
    const n = max(2, Math.round(config.ncolors));
    let mode = config.mode;
    if (n <= 2) mode = 'seuss';                   // mono -> seuss
    if (mode === 'random') mode = (nrand(4) === 1) ? 'ramp' : 'seuss';
    seussMode = (mode !== 'ramp');
    animateNow = config.animate && seussMode;     // ramp + animate "doesn't work right"

    buildPalette(n);

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
    doneOnce = false;

    initCircles();

    // The C's depth-1 pixmap + buffer (seuss only), as pixel-exact 0/255 planes
    // so the XOR cancels exactly; the buffer is colourised at blit time. bufBits
    // starts all-0 (the C's erase_gc-filled buffer).
    if (seussMode) {
      frameBits = new Uint8Array(W * H);
      bufBits = new Uint8Array(W * H);
      visImageData = ctx.createImageData(W, H);
      visU32 = new Uint32Array(visImageData.data.buffer);
    } else {
      frameBits = bufBits = null;
      visImageData = visU32 = null;
    }

    // Start from a clean black screen (XClearWindow + erase buffer).
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // Scan-convert a filled disk into a 0/255 plane using X11's exact fill rule:
  // a pixel (x,y) is set iff (x-cx)^2 + (y-cy)^2 <= r^2 (its sample point is
  // inside the circle). No antialiasing, integer spans -> consecutive frames'
  // edges line up exactly, so the XOR cancels with no residual outline.
  function fillDiskBits(bits, cx, cy, r) {
    let y0 = Math.ceil(cy - r);
    let y1 = Math.floor(cy + r);
    if (y0 < 0) y0 = 0;
    if (y1 > H - 1) y1 = H - 1;
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const span2 = r2 - dy * dy;
      if (span2 < 0) continue;
      const dxf = Math.sqrt(span2);
      let x0 = Math.ceil(cx - dxf);
      let x1 = Math.floor(cx + dxf);
      if (x0 < 0) x0 = 0;
      if (x1 > W - 1) x1 = W - 1;
      const row = y * W;
      for (let x = x0; x <= x1; x++) bits[row + x] = 255;
    }
  }

  // Colourise the depth-1 plane onto the visible canvas the way XCopyPlane with
  // copy_gc does: set bits -> colors[fgIndex], clear bits -> colors[bgIndex].
  // Reads the 0/255 plane directly; colour is NEVER mixed into the XOR plane
  // (that would break cancellation).
  function colorize() {
    const fg = palette ? palette[fgIndex] : [255, 255, 255];
    const bg = palette ? palette[bgIndex] : [0, 0, 0];
    const fgP = ((255 << 24) | (fg[2] << 16) | (fg[1] << 8) | fg[0]) >>> 0;
    const bgP = ((255 << 24) | (bg[2] << 16) | (bg[1] << 8) | bg[0]) >>> 0;
    const d32 = visU32;
    for (let i = 0; i < d32.length; i++) d32[i] = bufBits[i] ? fgP : bgP;
    ctx.putImageData(visImageData, 0, 0);
  }

  // halo_draw: one breath. For each circle test the done conditions, draw its
  // current FILLED disk, then grow its radius. After the loop run the done state
  // machine, composite (seuss: XOR pixmap into buffer; ramp: nothing extra), and
  // blit. Returns this step's delay in us (the C's this_delay).
  function step() {
    let done = false;
    let inhibitSleep = false;
    const oddIter = (iterations & 1) !== 0;

    if (seussMode) {
      // Erase the depth-1 pixmap, then scan-convert this step's disk union below.
      frameBits.fill(0);
    } else {
      // ramp: GXcopy over-paint straight onto the visible canvas in the cycling
      // colour (one foreground for the whole step, like merge_gc).
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = colorCss(fgIndex);
    }

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

      // Draw this disk when drawing every breath (seuss) or on the way back in.
      // seuss: pixel-exact scan-fill into the 1-bit plane (no AA, exact XOR);
      // ramp: opaque GXcopy disk straight onto the visible canvas.
      if (radius > 0 && (seussMode || circles[0].increment < 0)) {
        if (seussMode) {
          fillDiskBits(frameBits, c.x, c.y, radius);
        } else {
          ctx.beginPath();
          ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      c.radius += inc;
    }

    // animate: fast-forward (no sleep) until the first done (uses OLD doneOnce).
    if (animateNow && !doneOnce) inhibitSleep = !done;

    if (done) {
      if (animateNow) {
        // Random-walk the centres and wrap each radius (the C's anim branch),
        // bouncing centres off the edges.
        doneOnce = true;
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

    if (seussMode) {
      // XOR this step's disk union into the persistent plane (GXxor / merge_gc).
      // Both planes are exactly 0 or 255, so this is a true 1-bit XOR
      // (255^255=0, 255^0=255): overlaps cancel with no residual outline.
      for (let i = 0; i < bufBits.length; i++) bufBits[i] ^= frameBits[i];
    } else {
      // ramp: advance the foreground colour each step (the C's merge_gc shift);
      // inhibit the sleep on the out-breath (nothing is drawn then).
      if (palette) {
        fgIndex = (fgIndex + 1) % palette.length;
        bgIndex = (bgIndex + 1) % palette.length;
      }
      if (circles[0].increment >= 0) inhibitSleep = true;
    }

    // Blit the colourised buffer to the window (seuss only): on odd iterations,
    // or in animate mode on each done. Animate clears the buffer after each done.
    if (seussMode) {
      const blit = animateNow ? (done || (!doneOnce && oddIter)) : oddIter;
      if (blit) {
        colorize();
        if (animateNow && done) bufBits.fill(0);   // reset the plane for the next slide
      }
    }

    if (done) iterations = 0;
    else iterations++;

    // clear_tick countdown -> a full wipe a few breaths after it was armed
    // (the C wipes both the window and, in seuss, the buffer).
    if (done && clearTick > 0) {
      clearTick--;
      if (clearTick === 0) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        if (seussMode) bufBits.fill(0);
      }
    }

    // this_delay: inhibit -> 0; seuss+animate -> delay/100 (~100x faster); else
    // the plain delay.
    if (inhibitSleep) return 0;
    if (seussMode && animateNow) return Math.floor(config.delay / 100);
    return config.delay;
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

  // rAF lag-accumulator: bank real elapsed time and run steps until it is spent,
  // each step waiting the delay it returns (the C's mode-dependent this_delay; 0
  // = inhibit_sleep, run straight on). A per-frame step cap + a lag cap keep a
  // backgrounded tab (or a 0-delay fast path) from bursting on refocus.
  const MAX_STEPS_PER_FRAME = 64;
  const MAX_LAG_MS = 250;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;
  let nextDelayMs = config.delay / 1000;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;
    if (lag > MAX_LAG_MS) lag = MAX_LAG_MS;

    let steps = 0;
    while (lag >= nextDelayMs && steps < MAX_STEPS_PER_FRAME) {
      const dUs = step();
      lag -= nextDelayMs > 0 ? nextDelayMs : 0;
      nextDelayMs = dUs / 1000;
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
