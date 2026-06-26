// xlyap.js — xlyap packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's xlyap.c by Ron Record (1991). The Lyapunov exponent
// of a periodically-forced 1-D map makes pretty fractal pictures: for each
// pixel (a, b) in a 2-D parameter window, iterate a nonlinear map of the unit
// interval (default the logistic map x -> r*x*(1-x)) where the parameter r
// alternates between a and b following a fixed binary forcing sequence (default
// "abbabaab"). Discard a "settle" phase, then average log2|f'(x)| over a
// "dwell" phase: that average is the Lyapunov exponent. Negative => the orbit is
// ordered/periodic; positive => chaotic. Colour by sign+magnitude and you get
// the Markus-Lyapunov ("Zircon Zity") fractal.
//
// Rendering: this is a PER-PIXEL field that is expensive to compute (settle +
// dwell map iterations per pixel), so it uses the small-offscreen BLIT path
// (see [[marbling]] / [[strange]] / [[metaballs]]): the exponent grid is
// computed at a reduced LOGICAL resolution into a Uint32 view over one
// ImageData on an offscreen canvas, then drawImage-upscaled to the device-res
// canvas. The image is built PROGRESSIVELY (a band of rows per frame, like the
// C computes scanline-by-scanline) so a frame never blocks for seconds; once
// complete it lingers, then re-seeds a new random preset (parameter window +
// forcing + map). See [[squiral]] for the shared skeleton, [[marbling]] for the
// reduced-grid blit + cap idiom, [[demon]] for hslToUint.

export const title = 'xlyap';

export const info = {
  author: 'Ron Record',
  description: 'The Lyapunov exponent makes pretty fractal pictures.',
  year: 1991,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/xlyap.xml where they exist: delay
  // ("Frame rate") and linger ("Linger", in seconds the finished image holds).
  // The rest are port-added knobs. settle/dwell (and the parameter window, map,
  // and forcing sequence) are NOT user knobs in the C either: they come from one
  // of 23 builtin presets picked at random per image, so we keep that behaviour
  // and expose a "Detail" (grid coarseness) and "Quality" (iteration scale)
  // instead. ncolors/contrast recolour the finished field live (the C's 'e'
  // recalc key); the C uses a muted random colormap which we replace with a
  // vivid rainbow per the porter brief.
  const config = {
    delay: 32000,       // µs between compute batches (--delay; xml 10000, nudged faster)
    linger: 5,         // seconds the finished image lingers before reseeding (--linger)
    detail: 2,         // grid cell size: 1 = finest + slowest, larger = coarser + faster
    quality: 1,        // multiplier on the preset settle/dwell (iteration accuracy)
    ncolors: 256,      // size of the vivid rainbow colormap
    contrast: 1,       // colour-band density (higher = more contour bands)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 32000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'linger', label: 'Linger', type: 'range', min: 0, max: 10, step: 1, default: 5, unit: ' s', lowLabel: 'brief', highLabel: 'long', live: true },
    { key: 'detail', label: 'Detail', type: 'range', min: 1, max: 6, step: 1, default: 2, lowLabel: 'fine', highLabel: 'coarse', live: false },
    { key: 'quality', label: 'Quality', type: 'range', min: 0.5, max: 2, step: 0.1, default: 1, lowLabel: 'fast', highLabel: 'sharp', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 256, step: 1, default: 256, lowLabel: 'few', highLabel: 'many', live: true },
    { key: 'contrast', label: 'Contrast', type: 'range', min: 0.3, max: 3, step: 0.1, default: 1, lowLabel: 'soft', highLabel: 'banded', live: true },
  ];

  const BLACK = 0xFF000000;            // opaque black, little-endian 0xAABBGGRR
  const LOG2E = Math.LOG2E;            // 1.4426950408889634 (the C's M_LOG2E)

  // The 5 nonlinear maps of the unit interval and their derivatives, verbatim
  // from xlyap.c. mapIndex selects one per image; the parameter window for each
  // (its valid r range) is MAP_AMIN..MAP_AMIN+MAP_ARANGE.
  const MAPS = [
    (x, r) => r * x * (1 - x),                          // 0 logistic
    (x, r) => r * Math.sin(Math.PI * x),                // 1 circle (sin hump)
    (x, r) => { const d = 1 - x; return r * x * d * d; },     // 2 leftlog
    (x, r) => r * x * x * (1 - x),                      // 3 rightlog
    (x, r) => { const d = 1 - x; return r * x * x * d * d; }, // 4 doublelog
  ];
  const DERIVS = [
    (x, r) => r - 2 * r * x,                            // 0
    (x, r) => r * Math.PI * Math.cos(Math.PI * x),      // 1
    (x, r) => r * (1 - 4 * x + 3 * x * x),              // 2
    (x, r) => r * (2 * x - 3 * x * x),                  // 3
    (x, r) => { const d = x * x; return r * (2 * x - 6 * d + 4 * x * d); }, // 4
  ];

  // The 23 builtin presets from xlyap.c's do_preset(), each fully resolved.
  // NOTE: the C has a latent bug — do_preset() sets mapindex but never updates
  // the st->map/st->deriv function pointers (that code lives only in the
  // unreached mapIndex-resource branch), so the compiled screensaver actually
  // runs the LOGISTIC map for every preset, with the parameter window left at
  // the logistic [2,4]^2 default. We honour the author's clear intent instead:
  // presets that set mapindex use that map AND its proper parameter window
  // (amins/aranges), so the circle and leftlog maps render as designed. See the
  // .md "Deviations" section.
  const MAP_AMIN = [2.0, 0.0, 0.0, 0.0, 0.0];
  const MAP_ARANGE = [2.0, 1.0, 6.75, 6.75, 16.0];
  function mapWindow(map, settle, dwell, scale, forcing) {
    return {
      minA: MAP_AMIN[map],
      aRange: MAP_ARANGE[map],
      minB: MAP_AMIN[map],
      bRange: MAP_ARANGE[map],
      settle, dwell, map, scale, forcing,
    };
  }
  const PRESETS = [
    { minA: 3.75, aRange: 0.05, minB: 3.299999, bRange: 0.05, settle: 100, dwell: 200, map: 0, scale: 1.0, forcing: 'abaabbaaabbb' },
    { minA: 3.8, aRange: 0.05, minB: 3.2, bRange: 0.05, settle: 50, dwell: 50, map: 0, scale: 1.0, forcing: 'bbbbbaaaaa' },
    { minA: 3.4, aRange: 0.5, minB: 3.04, bRange: 0.5, settle: 500, dwell: 1000, map: 0, scale: 1.0, forcing: 'abbbbbbbbb' },
    { minA: 3.5, aRange: 0.2, minB: 3.0, bRange: 0.2, settle: 300, dwell: 600, map: 0, scale: 1.0, forcing: 'aaabbbab' },
    { minA: 3.55667, aRange: 0.05, minB: 3.2, bRange: 0.05, settle: 50, dwell: 50, map: 0, scale: 1.0, forcing: 'bbbbbaaaaa' },
    { minA: 3.79, aRange: 0.02999, minB: 3.22, bRange: 0.02999, settle: 50, dwell: 50, map: 0, scale: 1.0, forcing: 'bbbbbaaaaa' },
    { minA: 3.7999, aRange: 0.2, minB: 3.299999, bRange: 0.2, settle: 150, dwell: 300, map: 0, scale: 1.0, forcing: 'abaabbaaabbb' },
    { minA: 3.89, aRange: 0.02999, minB: 3.22, bRange: 0.028, settle: 600, dwell: 1000, map: 0, scale: 1.0, forcing: 'bbbbbaaaaa' },
    { minA: 3.2, aRange: 0.05, minB: 3.7, bRange: 0.005, settle: 50, dwell: 50, map: 0, scale: 1.0, forcing: 'abbbbaa' },
    mapWindow(1, 200, 400, 0.85, 'aaaaaabbbbbb'),   // 9  circle
    mapWindow(1, 200, 400, 0.85, 'aaaaaabbbbbb'),   // 10 circle
    mapWindow(1, 200, 400, 0.85, 'abbabaab'),       // 11 circle
    mapWindow(1, 200, 400, 0.85, 'abbb'),           // 12 circle
    mapWindow(1, 200, 400, 0.85, 'abbabaab'),       // 13 circle
    { minA: 3.91, aRange: 0.0899999999, minB: 3.28, bRange: 0.35, settle: 200, dwell: 800, map: 0, scale: 0.85, forcing: 'abbabaab' }, // 14
    { minA: 2, aRange: 2, minB: 2, bRange: 2, settle: 200, dwell: 400, map: 0, scale: 0.85, forcing: 'aaaaaabbbbbb' }, // 15
    { minA: 2, aRange: 2, minB: 2, bRange: 2, settle: 200, dwell: 400, map: 0, scale: 0.85, forcing: 'abbabaab' },     // 16
    { minA: 2, aRange: 2, minB: 2, bRange: 2, settle: 200, dwell: 400, map: 0, scale: 0.85, forcing: 'abbb' },         // 17
    { minA: 2, aRange: 2, minB: 2, bRange: 2, settle: 200, dwell: 400, map: 0, scale: 0.85, forcing: 'abbabaab' },     // 18
    mapWindow(2, 200, 400, 0.85, 'aaaaaabbbbbb'),   // 19 leftlog
    mapWindow(2, 200, 400, 0.85, 'abbabaab'),       // 20 leftlog
    mapWindow(2, 200, 400, 0.85, 'abbb'),           // 21 leftlog
    mapWindow(2, 200, 400, 0.85, 'abbabaab'),       // 22 leftlog
  ];

  // Caps (the porter brief mandates capping BOTH grid size and iteration count
  // so a full image finishes in a few seconds of progressive frames and a frame
  // never freezes). MAX_CELLS bounds the reduced grid; SETTLE/DWELL_CEIL bound
  // the per-pixel iteration count; CHUNK_ITERS sizes one compute chunk and
  // FRAME_BUDGET_MS hard-caps per-frame work regardless of anything else.
  const MAX_CELLS = 110000;
  const SETTLE_CEIL = 600;
  const DWELL_CEIL = 1000;
  const CHUNK_ITERS = 100000;
  const FRAME_BUDGET_MS = 14;
  const START_X = 0.65;                 // the C's startX resource

  let S = 1;                            // devicePixelRatio
  let W, H;                             // canvas size, device px
  let gw, gh;                           // reduced-grid dimensions
  let imageData, pixels;               // Uint32 view over ImageData (grid-sized)
  let expGrid;                          // Float32 store of every cell's exponent
  let scratch, sctx;                   // offscreen grid canvas, upscaled to main
  let palette;                          // Uint32 rainbow colormap, ncolors entries

  let preset;                           // the active preset object
  let map, deriv;                       // active map + derivative
  let forcing;                          // active forcing sequence as 0/1 array
  let maxindex;                         // forcing.length
  let settle, dwell;                    // effective iteration counts (capped)
  let aMin, bMin, aInc, bInc;           // parameter window mapped onto the grid
  let chunkRows;                        // grid rows computed per chunk
  let curRow;                           // next grid row to compute (progressive)

  let state = 'compute';                // 'compute' (building) | 'hold' (linger)
  let holdUntil = 0;                    // rAF timestamp the linger ends
  let lastNcolors = -1, lastContrast = -1;

  // HSL (h in degrees, s/l in [0,1]) packed into a little-endian RGBA uint
  // (same helper as marbling/demon).
  function hslToUint(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs(hp % 2 - 1));
    let rr = 0, gg = 0, bb = 0;
    if (hp < 1)      { rr = c; gg = x; }
    else if (hp < 2) { rr = x; gg = c; }
    else if (hp < 3) { gg = c; bb = x; }
    else if (hp < 4) { gg = x; bb = c; }
    else if (hp < 5) { rr = x; bb = c; }
    else             { rr = c; bb = x; }
    const m = l - c / 2;
    const R = Math.round((rr + m) * 255);
    const G = Math.round((gg + m) * 255);
    const B = Math.round((bb + m) * 255);
    return ((255 << 24) | (B << 16) | (G << 8) | R) >>> 0;
  }

  function buildPalette() {
    const n = Math.max(2, Math.round(config.ncolors));
    palette = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      palette[i] = hslToUint(i * 360 / n, 1, 0.5);
    }
  }

  // Map a Lyapunov exponent (in bits) onto a palette index. The order/chaos
  // boundary L=0 lands at the palette midpoint; deeper order/chaos walks toward
  // the two ends, wrapping (modulo) for |L| beyond the scale so very-negative
  // superstable regions get contour bands — mirroring the C's two %-wrapped
  // colour sub-ranges (just unified into one vivid diverging rainbow).
  function colorIndex(L) {
    const n = palette.length;
    const effScale = preset.scale / Math.max(0.01, config.contrast);
    let u = 0.5 - 0.5 * (L / effScale);
    u -= Math.floor(u);                 // wrap to [0, 1)
    let idx = (u * n) | 0;
    if (idx >= n) idx = n - 1;
    else if (idx < 0) idx = 0;
    return idx;
  }

  // The Lyapunov exponent at parameter point (a, b) — a faithful port of the C's
  // complyap() with useprod=1 (the default): a settle phase to shed transients,
  // then average log2|f'(x)| over the dwell phase using the log(a*b)=log(a)+
  // log(b) product optimisation (far fewer log() calls). x is clamped to [0,1]
  // and log arguments are guarded so the result can never go NaN/Inf.
  function lyapunov(a, b) {
    let x = START_X;
    let bindex = 0;
    let r = forcing[bindex] ? b : a;
    for (let i = 0; i < settle; i++) {
      x = map(x, r);
      if (x < 0) x = 0; else if (x > 1) x = 1;
      if (++bindex >= maxindex) bindex = 0;
      r = forcing[bindex] ? b : a;
    }
    let prod = 1, total = 0, i;
    for (i = 0; i < dwell; i++) {
      x = map(x, r);
      if (x < 0) x = 0; else if (x > 1) x = 1;
      let dx = deriv(x, r);
      if (dx < 0) dx = -dx;
      if (dx === 0) { i++; break; }     // log(0) is nasty: bail (matches the C)
      prod *= dx;
      if (prod > 1e12 || prod < 1e-12) { total += Math.log(prod); prod = 1; }
      if (++bindex >= maxindex) bindex = 0;
      r = forcing[bindex] ? b : a;
    }
    total += Math.log(prod);
    if (i < 1) i = 1;
    const L = (total * LOG2E) / i;
    return Number.isFinite(L) ? L : 0;
  }

  // Compute the next chunkRows grid rows, writing both the stored exponent and
  // its colour. Sets state to 'hold' when the last row is done.
  function computeChunk() {
    let row = curRow;
    const end = Math.min(gh, row + chunkRows);
    for (; row < end; row++) {
      const b = bMin + row * bInc;
      let p = row * gw;
      for (let gx = 0; gx < gw; gx++) {
        const a = aMin + gx * aInc;
        const L = lyapunov(a, b);
        expGrid[p] = L;
        pixels[p] = palette[colorIndex(L)];
        p++;
      }
    }
    curRow = row;
    if (curRow >= gh) state = 'hold';
  }

  // Re-colour already-computed rows from the stored exponents (no recompute).
  // Used when ncolors/contrast change live, like the C's 'e' recalc key.
  function recolor() {
    const rows = Math.min(curRow, gh);
    const limit = rows * gw;
    for (let p = 0; p < limit; p++) {
      pixels[p] = palette[colorIndex(expGrid[p])];
    }
  }

  function blit() {
    sctx.putImageData(imageData, 0, 0);
    ctx.drawImage(scratch, 0, 0, gw, gh, 0, 0, W, H);
  }

  // Adopt a preset: resolve the active map/forcing/iteration counts and map the
  // parameter window onto the grid, then reset the progressive build to row 0.
  function applyPreset(p) {
    preset = p;
    map = MAPS[p.map];
    deriv = DERIVS[p.map];
    forcing = [...p.forcing].map((c) => (c === 'b' ? 1 : 0));
    maxindex = forcing.length;
    const q = config.quality;
    settle = Math.max(10, Math.min(SETTLE_CEIL, Math.round(p.settle * q)));
    dwell = Math.max(10, Math.min(DWELL_CEIL, Math.round(p.dwell * q)));
    aMin = p.minA;
    bMin = p.minB;
    aInc = p.aRange / gw;
    bInc = p.bRange / gh;
    chunkRows = Math.max(1, Math.floor(CHUNK_ITERS / (gw * (settle + dwell))));
    curRow = 0;
    state = 'compute';
    pixels.fill(BLACK);
    blit();
  }

  function newImage() {
    applyPreset(PRESETS[Math.floor(Math.random() * PRESETS.length)]);
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    // Reduced grid at LOGICAL resolution / detail (NOT device px) so retina
    // doesn't multiply the per-pixel cost; the canvas upscales it (marbling
    // idiom). Then a hard cap on total cells for a predictable frame budget.
    const cell = Math.max(1, Math.round(config.detail));
    gw = Math.max(2, Math.ceil((W / S) / cell));
    gh = Math.max(2, Math.ceil((H / S) / cell));
    if (gw * gh > MAX_CELLS) {
      const f = Math.sqrt((gw * gh) / MAX_CELLS);
      gw = Math.max(2, Math.floor(gw / f));
      gh = Math.max(2, Math.floor(gh / f));
    }
    scratch = document.createElement('canvas');
    scratch.width = gw;
    scratch.height = gh;
    sctx = scratch.getContext('2d');
    imageData = sctx.createImageData(gw, gh);
    pixels = new Uint32Array(imageData.data.buffer);
    expGrid = new Float32Array(gw * gh);
    buildPalette();
    lastNcolors = config.ncolors;
    lastContrast = config.contrast;
    newImage();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // Progressive driver. Unlike the steady per-step hacks this builds an image
  // over many frames then holds, so it uses a delay-throttled, time-budgeted
  // batch loop rather than the squiral lag-accumulator: each eligible frame
  // computes chunks for up to FRAME_BUDGET_MS (never blocking), then blits.
  // config.delay throttles how often a batch runs (drag the slider right to
  // build faster / use less CPU); config.linger holds the finished image.
  let rafId = 0;
  let nextBatch = 0;

  function frame(now) {
    // Live recolour when the colour knobs change (no recompute needed).
    if (config.ncolors !== lastNcolors) {
      buildPalette();
      lastNcolors = config.ncolors;
      recolor();
      blit();
    } else if (config.contrast !== lastContrast) {
      lastContrast = config.contrast;
      recolor();
      blit();
    }

    if (state === 'hold') {
      if (now >= holdUntil) newImage();
      rafId = requestAnimationFrame(frame);
      return;
    }

    if (now >= nextBatch) {
      const t0 = performance.now();
      do {
        computeChunk();
      } while (state === 'compute' && performance.now() - t0 < FRAME_BUDGET_MS);
      blit();
      nextBatch = now + config.delay / 1000;
      if (state === 'hold') holdUntil = now + Math.max(0, config.linger) * 1000;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Rebuild after a non-live config change (detail resizes the grid, quality
  // re-scales the iteration counts). Clears to black and re-seeds via init().
  function reinit() {
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
    resume() { if (!rafId) { nextBatch = 0; rafId = requestAnimationFrame(frame); } },
    reinit,   // fresh random preset + grid with the current config
    config,
    params,
  };
}
