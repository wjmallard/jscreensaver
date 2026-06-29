// cwaves.js — cwaves packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's cwaves.c (Jamie Zawinski, 2007).
// https://www.jwz.org/xscreensaver/
//
// "A field of sinusoidal colors languidly scrolls." Several vertical sine
// waves are summed across the screen width into a single per-column value in
// [-1, 1]; that value picks a colour out of a smooth closed colormap, and the
// whole vertical strip at that column is painted one flat colour. Each wave
// has its own frequency (scale), phase (offset) and a small per-frame phase
// drift (delta); advancing every offset each frame is what makes the colour
// bands slide and breathe — the "scrolling" is purely the waves drifting out
// of phase with one another. There is no geometry, just a 1-D colour field
// stretched into vertical bars.
//
// Rendering: each column maps to exactly one colour spanning the full height,
// so this is effectively a 1-D field. We compute the field once per frame into
// a 1-pixel-tall Uint32 ImageData (one packed colour per column), putImageData
// it onto a width x 1 offscreen canvas, then drawImage that single row up to
// the full backing store with smoothing off — the GPU stretches each column
// into its vertical strip, the canvas analogue of the C's per-column
// XFillRectangle(x, 0, scale, height). See [[interference]] / [[moire]] for the
// Uint32-over-ImageData blit idiom, [[imsmap]] for the smooth closed colormap,
// and the style reference [[squiral]].

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'cwaves';

export const info = {
  author: 'Jamie Zawinski',
  description: "A field of sinusoidal colors languidly scrolls. It's relaxing.",
  year: 2007,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges/labels mirror hacks/config/cwaves.xml so the config box maps
  // 1:1 to the original. delay is in microseconds (xml units). The xml exposes
  // "waves" (Complexity) and "ncolors" (Color transitions) but not the C's
  // waveScale; we surface it too (strip width, default 2) because it controls
  // band crispness and is the C's --scale option.
  const config = {
    delay: 20000,     // µs between frames (--delay)
    nwaves: 15,       // number of summed sine waves; xml "Complexity" (--waves)
    ncolors: 600,     // size of the smooth colormap; xml "Color transitions" (--colors)
    scale: 2,         // column step / strip width in px; bigger = chunkier (--scale)
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes the waves/colormap/strip buffer, so a change
  //                re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'nwaves', label: 'Complexity', type: 'range', min: 1, max: 100, step: 1, default: 15, lowLabel: 'low', highLabel: 'high', live: false },
    { key: 'ncolors', label: 'Color transitions', type: 'range', min: 2, max: 1000, step: 1, default: 600, lowLabel: 'rough', highLabel: 'smooth', live: false },
    { key: 'scale', label: 'Band width', type: 'range', min: 1, max: 16, step: 1, default: 2, lowLabel: 'fine', highLabel: 'coarse', live: false },
  ];

  let S = 1;                  // devicePixelRatio
  let W, H;                   // backing-store size, device px
  let strip;                  // column step / strip width in device px (scale * dpr)
  let cols;                   // number of columns (== number of strips)
  let palette;                // Uint32Array smooth closed colormap, ncolors entries
  let ncolors;               // palette length actually in use
  let waves;                  // [{ scale, offset, delta }, ...]
  let field;                  // width x 1 offscreen canvas at column resolution
  let fctx;                   // its 2d context
  let fImage, fPixels;        // ImageData + Uint32 view, one packed colour per column

  // Pack r,g,b (0-255) as 0xFFBBGGRR for ImageData's little-endian layout.
  function packRGB(r, g, b) {
    return (0xff << 24 | b << 16 | g << 8 | r) >>> 0;
  }

  // Build the smooth, CLOSED colormap of `ncolors` entries with the faithful
  // make_smooth_colormap port (colormap.js): a random 2-5 anchor HSV loop that
  // is frequently muted/pastel and wraps back to its start, so the continuous
  // colour field has no seam. The C calls make_smooth_colormap(..., True, 0,
  // False) exactly ONCE in cwaves_init; we likewise build it once per init().
  // makeSmoothColormapRGB returns [r,g,b] 0..255 triplets; pack each into the
  // Uint32 view render() blits.
  function buildPalette() {
    ncolors = Math.max(2, Math.round(config.ncolors));
    palette = new Uint32Array(ncolors);
    const map = makeSmoothColormapRGB(ncolors);
    for (let i = 0; i < ncolors; i++) {
      const [r, g, b] = map[i];
      palette[i] = packRGB(r, g, b);
    }
  }

  // frand(n): uniform in [0, n). bellrand(n): sum of three -> a bell curve in
  // [0, n) (the C's BELLRAND). Used to seed each wave's drift so most waves
  // drift slowly and only a few fast, the way the original feels.
  function frand(n) {
    return Math.random() * n;
  }
  function bellrand(n) {
    return (frand(n) + frand(n) + frand(n)) / 3;
  }

  // Seed the waves: each gets a low spatial frequency (scale), a random initial
  // phase (offset in [0, PI)), and a small signed per-frame phase drift (delta).
  // Transcribed straight from cwaves_init.
  function seedWaves() {
    const n = Math.max(1, Math.round(config.nwaves));
    waves = new Array(n);
    for (let i = 0; i < n; i++) {
      waves[i] = {
        scale: frand(0.03) + 0.005,        // spatial frequency
        offset: frand(Math.PI),            // initial phase
        delta: (bellrand(2) - 1) / 15.0,   // per-frame phase drift, signed
      };
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // Strip width folds in dpr so bands stay a consistent CSS size on retina.
    strip = Math.max(1, Math.round(config.scale * S));
    cols = Math.max(1, Math.ceil(W / strip));

    buildPalette();
    seedWaves();

    // One-row offscreen + its Uint32 view: one packed colour per column. The
    // GPU stretches this row vertically when we drawImage it up to full size.
    field = document.createElement('canvas');
    field.width = cols;
    field.height = 1;
    fctx = field.getContext('2d');
    fImage = fctx.createImageData(cols, 1);
    fPixels = new Uint32Array(fImage.data.buffer);

    render();   // draw frame 0 immediately (no blank flash before rAF)
  }

  // One frame's colour field: for each column sum every wave's cosine at that
  // column's x (in CSS px), average to [-1, 1], remap to [0, 1) and index the
  // colormap. The C indexes with j = ncolors * (v/2 + 0.5) and abort()s if j is
  // out of range; v can only reach +/-1 if every cosine aligns, so we clamp the
  // index instead of aborting (keeps a degenerate frame safe). The waves'
  // offsets are advanced by step() before this runs.
  function render() {
    const n = waves.length;
    const nc = ncolors;
    const pal = palette;
    const px = fPixels;
    // The cosine FREQUENCY must use CSS-px x (config.scale step), not device px,
    // so band density is dpr-independent and matches the 1x C. The strip drawing
    // width (device px) is unchanged; only the frequency the cosine sees is.
    const xStep = config.scale;

    // Snapshot per-wave scale/offset so the inner loop reads locals.
    const sc = new Float64Array(n);
    const off = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      sc[i] = waves[i].scale;
      off[i] = waves[i].offset;
    }

    for (let c = 0; c < cols; c++) {
      const x = c * xStep;   // CSS-px x at this strip's left edge (dpr-independent)
      let v = 0;
      for (let i = 0; i < n; i++) {
        v += Math.cos(x * sc[i] - off[i]);
      }
      v /= n;                // now in [-1, 1]

      let j = Math.floor(nc * (v / 2 + 0.5));
      if (j < 0) j = 0;
      else if (j >= nc) j = nc - 1;
      px[c] = pal[j];
    }

    fctx.putImageData(fImage, 0, 0);
    // Stretch the single row up to the full backing store: each column becomes
    // its vertical strip, with no smoothing so the band edges stay crisp (the
    // canvas analogue of the C's per-column XFillRectangle(x, 0, scale, h)).
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(field, 0, 0, cols, 1, 0, 0, W, H);
  }

  // One step: drift every wave's phase (offset += delta), then repaint. The
  // drift is frame-rate independent because the lag accumulator runs step()
  // a fixed number of times per config.delay, exactly like the C's one
  // advance-per-draw at usleep(delay).
  function step() {
    for (let i = 0; i < waves.length; i++) {
      waves[i].offset += waves[i].delta;
    }
    render();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // Drive off requestAnimationFrame but keep the original pace: one step() per
  // config.delay, banking leftover time so the speed is the same at any refresh
  // rate. Cap catch-up so a backgrounded tab doesn't fire a burst on refocus.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // The live cwaves measures 35.6 fps, but the port at the stock 20000 us ran
  // 50 steps/sec (1.4x fast). 20000 + 8090 = 28090 us -> 35.6 steps/sec,
  // matching the live binary. A calibration, not a tuning knob (the delay
  // slider still maps 1:1 to the xml resource).
  const OVERHEAD = 8090;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
    const delayMs = (config.delay + OVERHEAD) / 1000;
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

  // reinit clears to black and rebuilds the colormap/waves/strip buffer with the
  // current config (nwaves, ncolors, scale may all have changed).
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
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
    reinit,   // rebuild colormap/waves + clear, keeping the current config
    config,
    params,
  };
}
