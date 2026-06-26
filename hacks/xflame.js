// xflame.js — xflame packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's xflame.c (Carsten Haitzler <raster@redhat.com>, 1996;
// TrueColor + utility-routine + image-logo work by Rahul Jain, Daniel Zahn and
// jwz over 1996-2018). https://www.jwz.org/xscreensaver/
//
// A classic cellular fire effect. The flame lives in a small heat field at HALF
// the image resolution. Each frame: (1) the bottom "active" row is re-seeded with
// random hot values that drift over time (FlameActive); (2) heat propagates
// UPWARD — processing the field bottom-to-top, every lit cell pushes a fraction
// of its value into the three cells above it (vspread straight up, hspread to the
// two diagonals) and keeps a `residual` fraction itself (FlameAdvance). The stock
// constants are tuned so vspread + 2*hspread == 256 - residual (157 == 157): the
// flame is marginally stable, so heat neither dies nor explodes and the fire
// licks tall, with the random seed making the tips flicker. The half-res field is
// then 2x-upscaled with bilinear interpolation into the image (Flame2Image), and
// each cell value indexes a black->red->orange->yellow->white fire LUT.
//
// Rendering: dense per-pixel HEAT field -> the BLIT path. We compute the field at
// (capped) LOGICAL resolution into an offscreen canvas (Uint32 ImageData), then
// ctx.drawImage-upscale to the device-res canvas, so the per-frame cost doesn't
// scale with devicePixelRatio (the marbling/metaballs idiom). See [[eruption]]
// for the same Uint32 fire-palette blit and [[flame]] for the accumulation idiom.

export const title = 'xflame';

export const info = {
  author: 'Carsten Haitzler',
  description: 'Pulsing fire.',
  year: 1996,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults from xflame.c's xflame_defaults / xflame_options. The xml only
  // surfaces delay + bloom; the spread/residual/variance knobs are the C's
  // command-line resources, exposed here so the fire stays tunable.
  //   delay     — µs between frames (--delay).
  //   vspread   — heat pushed straight UP per cell, /256 (--vspread).
  //   hspread   — heat pushed to each diagonal-up cell, /256 (--hspread).
  //   residual  — fraction of its own heat a cell keeps each frame, /256 (--residual).
  //   variance  — width of the random seed jitter on the active row (--variance).
  //   vartrend  — bias subtracted from that jitter; higher = cooler (--vartrend).
  //   bloom     — occasional random surges of the spread/residual values (--bloom).
  const config = {
    delay: 10000,      // µs between frames (xml default 10000)
    vspread: 97,       // vertical spread (--vspread)
    hspread: 30,       // horizontal spread (--hspread)
    residual: 99,      // self-retention (--residual)
    variance: 50,      // seed jitter width (--variance)
    vartrend: 20,      // seed jitter bias / cooling (--vartrend)
    bloom: true,       // enable random blooming surges (--bloom)
  };

  // live: true  -> the loop reads config[key] every frame, applies (near-)instantly.
  //               (the spread/residual knobs are eased toward their config value a
  //                little each frame, matching the C's relaxation, so they're live.)
  // None of these resize a buffer, so reinit() is only ever a manual clear+reseed.
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'vspread', label: 'Flame height', type: 'range', min: 0, max: 255, step: 1, default: 97, lowLabel: 'short', highLabel: 'tall', live: true },
    { key: 'hspread', label: 'Flame spread', type: 'range', min: 0, max: 255, step: 1, default: 30, lowLabel: 'narrow', highLabel: 'wide', live: true },
    { key: 'residual', label: 'Persistence', type: 'range', min: 0, max: 255, step: 1, default: 99, lowLabel: 'brief', highLabel: 'lasting', live: true },
    { key: 'variance', label: 'Turbulence', type: 'range', min: 1, max: 255, step: 1, default: 50, lowLabel: 'calm', highLabel: 'wild', live: true },
    { key: 'vartrend', label: 'Cooling', type: 'range', min: 0, max: 255, step: 1, default: 20, lowLabel: 'hot', highLabel: 'cool', live: true },
    { key: 'bloom', label: 'Blooming', type: 'checkbox', default: true, live: true },
  ];

  const MAX_VAL = 255;   // C: heat clamp ceiling
  const BLACK = 0xFF000000;

  // Cap the internal heat-field cell count so per-frame work is bounded on ANY
  // display (a full 4K field would be millions of cells/frame). At/below this the
  // field runs at native logical resolution; above it we shrink + bilinear-upscale.
  // 540000 keeps a 1080p screen at native size and only shrinks 1440p/4K.
  const MAX_CELLS = 540000;

  let S = 1;               // devicePixelRatio
  let W, H;                // canvas size, device px
  let off, offCtx;         // offscreen image canvas (imgW x imgH), upscaled to device
  let imageData, pixels;   // persistent Uint32 blit buffer over the offscreen
  let imgW, imgH;          // offscreen size = fwidth*2 x fheight*2
  let flame;               // Uint8Array heat field, (fwidth+2) x (fheight+2), padded
  let fwidth, fheight;     // heat field size (half the image)
  let stride;              // fwidth + 2 (padded row length)
  let top;                 // topmost row with content (C's perf bound for advance)
  let ctab;                // Uint32Array(256) packed-ABGR fire LUT
  let residualCur, hspreadCur, vspreadCur;   // eased current spread values (C: residual/hspread/vspread)

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function clamp255(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }
  // C's random()%n, non-negative.
  function randInt(n) {
    return (Math.random() * n) | 0;
  }

  // InitColors(): the C builds ctab[j] from (2j - (255 - fg))*3 per channel,
  // clamped 0..255, where fg is the foreground (#FFAF5F by default), giving a
  // black->red->orange->yellow->white fire ramp. We bake in the default fg.
  function buildCtab() {
    ctab = new Uint32Array(256);
    const red = 0;       // 255 - 0xFF
    const green = 80;    // 255 - 0xAF
    const blue = 160;    // 255 - 0x5F
    for (let j = 0; j < 256; j++) {
      const i = j * 2;
      const r = clamp255((i - red) * 3);
      const g = clamp255((i - green) * 3);
      const b = clamp255((i - blue) * 3);
      // Pack little-endian 0xAABBGGRR to match ImageData byte order.
      ctab[j] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
  }

  // FlameActive(): re-seed the bottom (active) row with drifting random heat, then
  // (optionally) bloom and ease the spread/residual values toward their config base.
  function flameActive() {
    const variance = clamp(Math.round(config.variance), 1, 255);
    const vartrend = clamp(Math.round(config.vartrend), 0, 255);

    let base = (fheight + 1) * stride;   // bottom padded row, col 0 (incl. gutters)
    for (let x = 0; x < fwidth + 2; x++) {
      let v1 = flame[base + x];
      v1 += randInt(variance) - vartrend;
      // C: *ptr1 = (unsigned char)(v1 % 255). JS % matches C's truncation, and the
      // Uint8Array store reproduces the unsigned-char wrap for negative results.
      flame[base + x] = v1 % 255;
    }

    if (config.bloom) {
      const v = randInt(100);
      if (v === 10) residualCur += randInt(10);
      else if (v === 20) hspreadCur += randInt(15);
      else if (v === 30) vspreadCur += randInt(20);
    }

    // Relax toward the (live) config base: 10% new base + 90% current, int division.
    residualCur = Math.floor((config.residual * 10 + residualCur * 90) / 100);
    hspreadCur = Math.floor((config.hspread * 10 + hspreadCur * 90) / 100);
    vspreadCur = Math.floor((config.vspread * 10 + vspreadCur * 90) / 100);
  }

  // FlameAdvance(): propagate heat UPWARD. Processing bottom-to-top means a hot
  // seed cascades up many rows in one pass; each lit cell pushes vspread/256 into
  // the cell above and hspread/256 into the two cells above-left/right, then keeps
  // residual/256 of itself. `top` tracks the highest non-empty row (a perf bound).
  function flameAdvance() {
    let vs = clamp(vspreadCur, 0, 4096);   // guard the >>8 (products stay < 2^31)
    let hs = clamp(hspreadCur, 0, 4096);
    let rs = clamp(residualCur, 0, 4096);

    // Keep the automaton at/below marginal stability. The per-step heat
    // multiplier is (vs + 2*hs + rs)/256: a sum above 256 AMPLIFIES heat every
    // frame, so the field runs away to a solid white-hot block (what raising
    // "Flame height"/vspread past the default balance did). Renormalize down to
    // the 256 budget so any slider combo stays a live flame; the ratio (hence
    // the look) is preserved, and the stock 97 + 2*30 + 99 == 256 is a no-op.
    const heatSum = vs + 2 * hs + rs;
    if (heatSum > 256) {
      vs = Math.floor(vs * 256 / heatSum);
      hs = Math.floor(hs * 256 / heatSum);
      rs = Math.floor(rs * 256 / heatSum);
    }

    let newtop = top;
    for (let y = fheight + 1; y >= top; y--) {
      let used = 0;
      const rowBase = 1 + y * stride;   // padded col 1 == visible cell x=0
      for (let x = 0; x < fwidth; x++) {
        const i1 = rowBase + x;
        const v1 = flame[i1];
        if (v1 > 0) {
          used = 1;
          const i2 = i1 - stride;        // cell directly above
          let v3 = (v1 * vs) >> 8;
          let v2 = flame[i2] + v3;
          if (v2 > MAX_VAL) v2 = MAX_VAL;
          flame[i2] = v2;

          v3 = (v1 * hs) >> 8;
          v2 = flame[i2 + 1] + v3;
          if (v2 > MAX_VAL) v2 = MAX_VAL;
          flame[i2 + 1] = v2;

          v2 = flame[i2 - 1] + v3;
          if (v2 > MAX_VAL) v2 = MAX_VAL;
          flame[i2 - 1] = v2;

          // The active (bottom) row is not self-decayed, so the seed persists.
          if (y < fheight + 1) flame[i1] = (v1 * rs) >> 8;   // Uint8Array truncates like the C uchar
        }
        if (used) newtop = y - 1;
      }
      // Clean up the right gutter cell (decay only).
      const ig = rowBase + fwidth;
      flame[ig] = (flame[ig] * rs) >> 8;
    }

    top = newtop - 1;
    if (top < 1) top = 1;
  }

  // Flame2Image(): 2x-upscale the heat field into the offscreen image with simple
  // bilinear interpolation (each cell -> a 2x2 block), mapping heat through ctab.
  // We render every visible row (not just from `top`) so no stale rows survive.
  function flame2Image() {
    for (let y = 0; y < fheight; y++) {
      const rowBase = 1 + y * stride;
      const out0 = (y * 2) * imgW;       // image row 2y
      const out1 = out0 + imgW;          // image row 2y+1
      for (let x = 0; x < fwidth; x++) {
        const i1 = rowBase + x;
        const v1 = flame[i1];
        const v2 = flame[i1 + 1];
        const v3 = flame[i1 + stride];
        const v4 = flame[i1 + stride + 1];
        const ox = x * 2;
        pixels[out0 + ox] = ctab[v1];
        pixels[out0 + ox + 1] = ctab[(v1 + v2) >> 1];
        pixels[out1 + ox] = ctab[(v1 + v3) >> 1];
        pixels[out1 + ox + 1] = ctab[(v1 + v4) >> 1];
      }
    }
  }

  // One frame == one xflame_draw (minus the optional bitmap "logo" paste, dropped).
  function step() {
    flameActive();
    flameAdvance();
    flame2Image();
    offCtx.putImageData(imageData, 0, 0);
    ctx.drawImage(off, 0, 0, W, H);   // bilinear upscale offscreen -> device res
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // Image at LOGICAL resolution (even dims, as the C forces), capped by cells.
    let lw = Math.max(2, Math.round(W / S));
    let lh = Math.max(2, Math.round(H / S));
    let fw = lw >> 1;
    let fh = lh >> 1;
    if (fw * fh > MAX_CELLS) {
      const f = Math.sqrt((fw * fh) / MAX_CELLS);
      fw = Math.max(2, Math.floor(fw / f));
      fh = Math.max(2, Math.floor(fh / f));
    }
    fwidth = fw;
    fheight = fh;
    stride = fwidth + 2;
    imgW = fwidth * 2;
    imgH = fheight * 2;

    flame = new Uint8Array(stride * (fheight + 2));   // FlameFill(0) == zeroed
    top = 1;

    off = document.createElement('canvas');
    off.width = imgW;
    off.height = imgH;
    offCtx = off.getContext('2d');
    imageData = offCtx.createImageData(imgW, imgH);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    buildCtab();

    // InitFlame() seeds the eased spread values from the config bases.
    residualCur = config.residual;
    hspreadCur = config.hspread;
    vspreadCur = config.vspread;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.imageSmoothingEnabled = true;   // soft bilinear upscale (suits the flame)
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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

    const delayMs = config.delay / 1000;   // xml units are µs; rAF is ms
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Clear the canvas + re-seed the field (config is kept).
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
    resume() { if (!rafId) { lastTime = 0; rafId = requestAnimationFrame(frame); } },
    reinit,   // re-seed the field, keeping the current config
    config,   // host renders the config box from these
    params,
  };
}
