// interference.js — interference packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's interference.c (Hannu Mallat, 1998; later tuned by
// David Slimp and Dave Odell). https://www.jwz.org/xscreensaver/
//
// Several decaying sinusoidal "wave" sources drift around the plane; their
// heights are summed per pixel into an intensity field, and that field indexes
// a cycling HSV colour loop — the classic plasma-interference shimmer. Each
// source is a radial ripple: a cosine that fades to zero at `radius`. The C
// precomputes that ripple ONCE as a 1-D table indexed by (compressed) squared
// distance, then every frame accumulates each source's table lookup into an int
// grid and maps the grid through the palette.
//
// Rendering: this is the dense per-pixel path. We compute at GRID resolution
// (each cell is a gridsize block, exactly like the C), write the mapped colours
// into a small Uint32 ImageData, putImageData onto a grid-sized offscreen
// canvas, then drawImage it up to the full backing store with smoothing off —
// the GPU does the block expansion the C did by hand. See [[binaryring]] for the
// Uint32-over-ImageData idiom and [[greynetic]] for the canvas conventions.

export const title = 'interference';

export const info = {
  author: 'Hannu Mallat',
  description: 'Decaying sinusoidal waves make colors.',
  year: 1998,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges/labels mirror hacks/config/interference.xml so the config
  // box maps 1:1 to the original. delay is in microseconds (xml units).
  const config = {
    delay: 30000,    // µs between frames (--delay)
    speed: 30,       // how fast the wave origins orbit (--speed)
    radius: 800,     // wave extent in px; bigger = broader ripples (--radius)
    count: 3,        // number of wave sources (--count)
    gridsize: 2,     // block size in px; bigger = chunkier/faster (--gridsize)
    ncolors: 192,    // size of the colour loop (--ncolors)
    shift: 60,       // hue gap between the 3 palette anchors (--color-shift)
    hue: 0,          // base hue 0-360; 0 = pick at random (--hue)
    gray: false,     // grayscale instead of colour (--gray)
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes the grid/table/palette, so a change re-runs
  //                init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Wave speed', type: 'range', min: 1, max: 100, step: 1, default: 30, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'radius', label: 'Wave size', type: 'range', min: 50, max: 1500, step: 10, default: 800, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'count', label: 'Number of waves', type: 'range', min: 1, max: 20, step: 1, default: 3, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'gridsize', label: 'Magnification', type: 'range', min: 1, max: 20, step: 1, default: 2, lowLabel: 'fine', highLabel: 'coarse', live: false },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 2, max: 255, step: 1, default: 192, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'shift', label: 'Color contrast', type: 'range', min: 0, max: 100, step: 1, default: 60, lowLabel: 'low', highLabel: 'high', live: false },
    { key: 'hue', label: 'Hue (0 = random)', type: 'range', min: 0, max: 360, step: 1, default: 0, lowLabel: '0', highLabel: '360', live: false },
    { key: 'gray', label: 'Grayscale', type: 'checkbox', default: false, live: false },
  ];

  // --- fast inverse-sqrt table (USE_FAST_SQRT_BIGTABLE2 in the C) -------------
  // The wave ripple is tabulated against a COMPRESSED squared distance: small
  // distances keep more resolution (>>4), large ones less (>>9 past a cutoff).
  // FAST_TABLE maps squared distance -> table index; fastInvTable is its inverse
  // (index -> representative squared distance), used to build the table.
  const SQRT_DISCARD1 = 4;
  const SQRT_DISCARD2 = 9;
  const SQRT_CUTOFF = 128 * 128;

  function fastTable(x) {
    return x < SQRT_CUTOFF
      ? (x >> SQRT_DISCARD1)
      : ((x + ((SQRT_CUTOFF << (SQRT_DISCARD2 - SQRT_DISCARD1)) - SQRT_CUTOFF)) >> SQRT_DISCARD2);
  }

  function fastInvTable(x) {
    return x < (SQRT_CUTOFF >> SQRT_DISCARD1)
      ? (x << SQRT_DISCARD1)
      : ((x - (SQRT_CUTOFF >> SQRT_DISCARD1)) << SQRT_DISCARD2) + SQRT_CUTOFF;
  }

  // --- HSV -> packed 0xAABBGGRR (matches ImageData's little-endian layout) ----
  function hsvPixel(h, s, v) {
    h = ((h % 360) + 360) % 360;
    const H = h / 60;
    const i = Math.floor(H);
    const f = H - i;
    const p1 = v * (1 - s);
    const p2 = v * (1 - s * f);
    const p3 = v * (1 - s * (1 - f));
    let r, g, b;
    if (i === 0) { r = v; g = p3; b = p1; }
    else if (i === 1) { r = p2; g = v; b = p1; }
    else if (i === 2) { r = p1; g = v; b = p3; }
    else if (i === 3) { r = p1; g = p2; b = v; }
    else if (i === 4) { r = p3; g = p1; b = v; }
    else { r = v; g = p1; b = p2; }
    const R = Math.round(r * 255), G = Math.round(g * 255), B = Math.round(b * 255);
    return ((0xff << 24) | (B << 16) | (G << 8) | R) >>> 0;
  }

  // Build the cycling palette: a CLOSED 3-anchor HSV loop, faithfully matching
  // the C's make_color_loop. Colour mode walks hue through (hue, hue+shift,
  // hue+2*shift) at full saturation/value; gray mode walks value 1.0 -> 0.5 ->
  // 0.0 at zero saturation. Because saturation and value are flat in colour
  // mode, the edge lengths reduce to the hue gaps, so the three segments get
  // equal shares of ncolors — and the closing segment runs the SHORT way round
  // the wheel (e.g. shift=60: up 60, up 60, then back down 120), giving the
  // original's back-and-forth hue sweep rather than a plain wheel rotation.
  function buildPalette() {
    const n = Math.max(2, Math.round(config.ncolors));

    // Three anchor points (h in 0-360, s/v in 0-1).
    let H, S, V;
    if (!config.gray) {
      const h0 = baseHue;
      const wrap = (x) => (x < 360 ? x : x - 360);
      const h1 = wrap(h0 + config.shift);
      const h2 = wrap(h1 + config.shift);
      H = [h0, h1, h2];
      S = [1, 1, 1];
      V = [1, 1, 1];
    } else {
      H = [0, 0, 0];
      S = [0, 0, 0];
      V = [1, 0.5, 0];
    }

    // Per-edge shortest hue distance around the circle (0-0.5 of the wheel).
    const DH = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      let d = (H[i] - H[j]) / 360;
      if (d < 0) d = -d;
      if (d > 0.5) d = 0.5 - (d - 0.5);
      DH[i] = d;
    }

    // Edge lengths in unit HSV space, then each edge's share of ncolors.
    const edge = [0, 0, 0];
    let circum = 0;
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      edge[i] = Math.sqrt(
        DH[i] * DH[j] +
        (S[j] - S[i]) * (S[j] - S[i]) +
        (V[j] - V[i]) * (V[j] - V[i]),
      );
      circum += edge[i];
    }

    const pal = new Uint32Array(n);
    if (circum < 0.0001) { pal.fill(hsvPixel(H[0], S[0], V[0])); palette = pal; return; }

    const counts = [0, 0, 0];
    const dh = [0, 0, 0], ds = [0, 0, 0], dv = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      counts[i] = Math.floor(n * (edge[i] / circum));
      const j = (i + 1) % 3;
      if (counts[i] > 0) {
        dh[i] = 360 * (DH[i] / counts[i]);
        ds[i] = (S[j] - S[i]) / counts[i];
        dv[i] = (V[j] - V[i]) / counts[i];
      }
    }

    let k = 0;
    for (let i = 0; i < 3; i++) {
      // Direction around the wheel for this edge (shortest path), per the C.
      const distance = H[(i + 1) % 3] - H[i];
      let direction = distance >= 0 ? -1 : 1;
      if (distance <= 180 && distance >= -180) direction = -direction;
      for (let j = 0; j < counts[i] && k < n; j++, k++) {
        let hh = H[i] + j * dh[i] * direction;
        if (hh < 0) hh += 360;
        pal[k] = hsvPixel(hh, S[i] + j * ds[i], V[i] + j * dv[i]);
      }
    }
    // Round-off can leave a few slots unfilled; duplicate the last (the C does).
    for (let i = k; i < n; i++) pal[i] = pal[i > 0 ? i - 1 : 0];

    palette = pal;
  }

  let S = 1;                 // devicePixelRatio
  let W, H;                  // backing-store size, device px
  let g;                     // block size in device px (gridsize folded with dpr)
  let gridW, gridH;          // grid dimensions (cells across / down)
  let radiusPx;              // wave radius in device px
  let tableLen;              // length of waveHeight (the C's c->radius)
  let waveHeight;            // Int32Array ripple table, indexed by fastTable(d^2)
  let accum;                 // Int32Array gridW*gridH intensity accumulator
  let palette;               // Uint32Array colour loop
  let ncolors;              // palette length actually in use
  let baseHue;               // resolved base hue (random when config.hue == 0)
  let sources;               // [{ x, y, xt, yt }]
  let grid;                  // small offscreen canvas at grid resolution
  let gctx;                  // its 2d context
  let gImage, gPixels;       // ImageData + Uint32 view at grid resolution
  let lastFrame;             // ms timestamp of the previous step (animation pace)

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // gridsize is the block size; fold dpr in so blocks stay a consistent CSS
    // size and the field is computed at a sane internal resolution on retina.
    g = Math.max(1, Math.round(config.gridsize * S));
    gridW = Math.max(1, Math.ceil(W / g));
    gridH = Math.max(1, Math.ceil(H / g));

    // Retina scale-up of the radius, mirroring the C's xgwa>2560 branch.
    const scale = (W > 2560 || H > 2560) ? 3.5 : 1;
    radiusPx = Math.max(1, Math.round(config.radius * scale));

    ncolors = Math.max(2, Math.round(config.ncolors));

    // Resolve the base hue once (config.hue == 0 -> random, per the C's "while
    // hue<0 || hue>=360" reroll). Held in state so reinit keeps it stable.
    baseHue = config.hue;
    while (baseHue < 0 || baseHue >= 360) baseHue = Math.random() * 360;

    buildPalette();

    // Build the ripple table ONCE. Index space is the compressed squared
    // distance; tableLen = fastTable(radiusPx^2). Each entry is a decaying
    // cosine: amplitude falls linearly to 0 at radiusPx, modulated by cos.
    tableLen = fastTable(radiusPx * radiusPx);
    if (tableLen < 1) tableLen = 1;
    waveHeight = new Int32Array(tableLen);
    for (let i = 0; i < tableLen; i++) {
      const fi = Math.sqrt(fastInvTable(i));            // distance for this slot
      const max = ncolors * (radiusPx - fi) / radiusPx; // linear decay envelope
      waveHeight[i] = Math.floor((max + max * Math.cos(fi / (50.0 * scale))) / 2.0);
    }

    accum = new Int32Array(gridW * gridH);

    // Grid-resolution offscreen + its Uint32 pixel view (the field, pre-upscale).
    grid = document.createElement('canvas');
    grid.width = gridW;
    grid.height = gridH;
    gctx = grid.getContext('2d');
    gImage = gctx.createImageData(gridW, gridH);
    gPixels = new Uint32Array(gImage.data.buffer);

    // Seed the sources with random orbital phases (the C's frand(2)*PI).
    const n = Math.max(1, Math.round(config.count));
    sources = new Array(n);
    for (let i = 0; i < n; i++) {
      sources[i] = {
        x: 0,
        y: 0,
        xt: Math.random() * 2 * Math.PI,
        yt: Math.random() * 2 * Math.PI,
      };
    }
    placeSources();   // so the FIRST frame already has valid positions

    lastFrame = 0;
    render();         // draw frame 0 immediately (no blank flash before rAF)
  }

  // Source position from its orbital phases: it sweeps a Lissajous-ish path that
  // spans the whole window (cos in [-1,1] -> [0,W] / [0,H]). Distances below use
  // these device-px coordinates, which is why radiusPx is in device px too.
  function placeSources() {
    const hw = W / 2, hh = H / 2;
    for (let k = 0; k < sources.length; k++) {
      const simp = sources[k];
      sip(simp, hw, hh);
    }
  }
  function sip(simp, hw, hh) {
    simp.x = (hw + Math.cos(simp.xt) * hw) | 0;
    simp.y = (hh + Math.cos(simp.yt) * hh) | 0;
  }

  // Accumulate every source's ripple into the grid, map through the palette, and
  // blit. This is the O(cells * sources) inner loop; it walks the squared
  // distance incrementally (dist0 += step) exactly like the C to avoid a
  // multiply per pixel.
  function render() {
    const acc = accum;
    acc.fill(0);

    const g2 = 2 * g * g;
    for (let k = 0; k < sources.length; k++) {
      const sx = sources[k].x, sy = sources[k].y;
      let row = 0;
      for (let j = 0; j < gridH; j++) {
        const py = j * g + (g >> 1);
        const dy = py - sy;
        const px0 = g >> 1;
        let dx = px0 - sx;
        let dist0 = dx * dx + dy * dy;       // squared distance at column 0
        const ddist = -2 * g * sx;           // C's per-step bias term
        let px2g = g2;                        // C's px2g = g2, then += g2 each col
        for (let i = 0; i < gridW; i++) {
          const idx = fastTable(dist0);
          if (idx < tableLen) acc[row + i] += waveHeight[idx];
          dist0 += px2g + ddist;
          px2g += g2;
        }
        row += gridW;
      }
    }

    // Map intensity -> palette index (mod ncolors) -> packed pixel.
    const pal = palette, nc = ncolors, px = gPixels;
    for (let p = 0; p < acc.length; p++) {
      let r = acc[p];
      // Trim before the modulus (the C does the same) — accum is non-negative.
      if (r >= nc) {
        r -= nc;
        if (r >= nc) r %= nc;
      }
      px[p] = pal[r];
    }

    gctx.putImageData(gImage, 0, 0);
    // Hard block-scale up to the full backing store (no smoothing = crisp
    // blocks, the canvas analogue of the C's g*g pixel fills).
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(grid, 0, 0, gridW, gridH, 0, 0, W, H);
  }

  // One step: advance each source's phase by the elapsed-scaled speed, reposition,
  // and redraw. `elapsed` reproduces the C's FPS-independent advance
  // (elapsed = dt_seconds * 10; theta += elapsed * speed / 1000).
  function step(now) {
    if (lastFrame === 0) lastFrame = now;
    const elapsed = (now - lastFrame) * 0.001 * 10.0;   // ms -> the C's units
    lastFrame = now;

    const adv = elapsed * config.speed / 1000.0;
    const hw = W / 2, hh = H / 2;
    const TWO_PI = 2 * Math.PI;
    for (let k = 0; k < sources.length; k++) {
      const simp = sources[k];
      simp.xt += adv;
      if (simp.xt > TWO_PI) simp.xt -= TWO_PI;
      simp.yt += adv;
      if (simp.yt > TWO_PI) simp.yt -= TWO_PI;
      sip(simp, hw, hh);
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
  // rate. step() reads the real wall-clock elapsed for the source advance, so a
  // longer-than-delay frame still moves the waves the right amount.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay interference runs 27.9 fps, while
  // the port at the stock 30000 us ran ~33 fps (1.2x fast). 30000 + 5842 =
  // 35842 us -> 28 fps, matching the live binary. (Source motion reads the real
  // wall-clock elapsed, so this only paces the render cadence, not wave speed.)
  // A calibration, not a tuning knob (the delay slider still maps 1:1 to xml).
  const OVERHEAD = 5842;
  const MAX_CATCHUP_STEPS = 4;   // each step is a full per-pixel pass; keep low
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

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step(now);
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // reinit clears to black and rebuilds the table/palette/sources with the
  // current config (radius, gridsize, colours, etc. may all have changed).
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
    resume() { if (!rafId) { lastTime = 0; lastFrame = 0; rafId = requestAnimationFrame(frame); } },
    reinit,   // rebuild table/palette/sources + clear, keeping the current config
    config,
    params,
  };
}
