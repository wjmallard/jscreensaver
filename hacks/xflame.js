// xflame.js -- xflame packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's xflame.c (Carsten Haitzler <raster@redhat.com>, 1996;
// TrueColor + utility-routine + image-source work by Rahul Jain, Daniel Zahn and
// jwz over 1996-2018). https://www.jwz.org/xscreensaver/
//
// A classic cellular fire effect. The flame lives in a small heat field at HALF
// the image resolution. Each frame (xflame_draw): (1) the bottom "active" row is
// re-seeded with random hot values that drift over time (FlameActive); (2) the
// built-in fire SOURCE image ("Bob", bob.png) is pasted in -- its dark pixels add
// random heat so the picture appears to burn (FlamePasteData); (3) heat propagates
// UPWARD -- processing the field bottom-to-top, every lit cell pushes a fraction
// of its value into the three cells above it (vspread straight up, hspread to the
// two diagonals) and keeps a `residual` fraction itself (FlameAdvance). The stock
// constants make vspread + 2*hspread + residual == 256 (97 + 60 + 99): heat is
// conserved as it rises, so the fire neither dies nor saturates and licks tall,
// with the random seed flickering the tips. The half-res field is then 2x-upscaled
// with bilinear-ish interpolation into the image (Flame2Image), each cell value
// indexing a black->red->orange->yellow->white fire LUT built analytically from
// the foreground colour (InitColors -- NOT a make_*_colormap palette).
//
// Rendering: dense per-pixel HEAT field -> the BLIT path. The field runs at half the
// LOGICAL resolution (the C's window/2; the flame dynamics are tuned to that cell
// size, so it is NOT scaled by devicePixelRatio), 2x-upscaled into an offscreen
// Uint32 ImageData (Flame2Image), then drawImage-upscaled to the device canvas. See
// [[eruption]]
// for the same Uint32 fire-palette blit.

export const title = 'xflame';

export const info = {
  author: 'Carsten Haitzler',
  description: 'Pulsing fire. It can also take an arbitrary image and set it on fire too.',
  year: 1996,
};

// bob.png -- the built-in fire SOURCE image (xflame.c's *bitmap: (default)), the
// iconic 64x64 "Bob" face. Copied verbatim from xscreensaver-6.15/hacks/images/
// bob.png into hacks/images/, loaded relative to this module (the xanalogtv.js
// asset idiom) so the default look (a picture on fire) stays faithful.
const BOB_PNG = new URL('./images/bob.png', import.meta.url).href;

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Config mirrors hacks/config/xflame.xml 1:1 -- the only resources the original
  // surfaces are `delay` (frame interval) and `bloom`. xflame.c ALSO has
  // command-line-only knobs (hspread/vspread/residual/variance/vartrend); those
  // are NOT in the xml, so this port fixes them at the stock defaults (the I*
  // constants below) rather than exposing them as sliders.
  //   delay -- microseconds between frames (--delay; xml "Frame rate", inverted).
  //   bloom -- occasional random surges of the spread/residual values (--bloom).
  const config = {
    delay: 10000,      // µs between frames (xml default 10000)
    bloom: true,       // random blooming surges (xml default True)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'bloom', label: 'Enable blooming', type: 'checkbox', default: true, live: true },
  ];

  // xflame.c's stock resource defaults (xflame_defaults). These are the immutable
  // BASE values; residual/hspread/vspread additionally have eased CURRENT values
  // (residualCur etc.) that bloom perturbs and that relax 10%/frame back toward
  // the base. variance/vartrend are used directly (the C never eases them).
  const IHSPREAD = 30;     // --hspread: heat to each diagonal-up cell, /256
  const IVSPREAD = 97;     // --vspread: heat straight UP, /256
  const IRESIDUAL = 99;    // --residual: fraction of own heat a cell keeps, /256
  const VARIANCE = 50;     // --variance: width of the active-row random seed
  const VARTREND = 20;     // --vartrend: bias subtracted from the seed (cooling)
  const BASELINE = 20;     // --baseline: fire-source offset above the bottom
  const MAX_VAL = 255;     // C: heat clamp ceiling

  const BLACK = 0xFF000000;

  // Cap the internal heat-field cell count so per-frame work is bounded on ANY
  // display. The field runs at LOGICAL/2 resolution (the live binary's cell size --
  // see init), so cost does not scale with devicePixelRatio. 540000 keeps a 1080p
  // logical window native; larger windows shrink the field a touch then upscale.
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
  let residualCur, hspreadCur, vspreadCur;   // eased current values (C: residual/hspread/vspread)

  // The built-in fire source ("Bob"), decoded once then re-fit per field size.
  const bobImg = new Image();
  let bobReady = false;
  let theim = null;        // Uint8Array grayscale heat-source (C: st->theim)
  let theimx = 0, theimy = 0;
  let pasteWarned = false;

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
  // (This is a hand-rolled analytic ramp, NOT make_smooth_colormap/make_color_ramp,
  // so colormap.js does not apply.)
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
  // (optionally) bloom and ease the spread/residual values toward their base.
  function flameActive() {
    const base = (fheight + 1) * stride;   // bottom padded row, col 0 (incl. gutters)
    for (let x = 0; x < fwidth + 2; x++) {
      let v1 = flame[base + x];
      v1 += randInt(VARIANCE) - VARTREND;
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

    // Relax toward the base: 10% base + 90% current, integer division (matches C).
    residualCur = Math.floor((IRESIDUAL * 10 + residualCur * 90) / 100);
    hspreadCur = Math.floor((IHSPREAD * 10 + hspreadCur * 90) / 100);
    vspreadCur = Math.floor((IVSPREAD * 10 + vspreadCur * 90) / 100);
  }

  // FlamePasteData(): inject the fire source's heat into the field each frame.
  // For every source pixel with value >= 24, add random()%(val/24) to the matching
  // field cell, so the picture's bright (post-inversion: dark) regions keep burning.
  function flamePasteData(d, dw, dh, xx, yy) {
    if (xx < 0) xx = 0;
    if (yy < 0) yy = 0;
    if (xx >= 0 && yy >= 0 && xx + dw <= fwidth && yy + dh <= fheight) {
      let p = 0;
      for (let y = 0; y < dh; y++) {
        let i1 = 1 + xx + ((yy + y) * stride);
        for (let x = 0; x < dw; x++) {
          const q = (d[p] / 24) | 0;       // C: *ptr2 / 24 (integer division)
          if (q) flame[i1] += randInt(q);  // Uint8Array store wraps like the uchar
          i1++;
          p++;
        }
      }
    } else if (!pasteWarned) {
      pasteWarned = true;
      console.warn('xflame: window too small for the fire source; not pasted.');
    }
  }

  // FlameAdvance(): propagate heat UPWARD. Processing bottom-to-top means a hot
  // seed cascades up many rows in one pass; each lit cell pushes vspread/256 into
  // the cell above and hspread/256 into the two cells above-left/right, then keeps
  // residual/256 of itself. `top` tracks the highest non-empty row (a perf bound).
  function flameAdvance() {
    const vs = vspreadCur;
    const hs = hspreadCur;
    const rs = residualCur;

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

  // gaussian_blur (xflame.c), line-for-line. Softens the fire source after it has
  // been pixel-doubled up to screen scale. r == blur_steps * 1.7.
  function gaussianBlur(inp, w, h, r) {
    const out = new Uint8Array(w * h);
    const rs = Math.trunc(r * 2.57 + 0.5);
    const twoRR = 2 * r * r;
    const denom = Math.PI * twoRR;
    for (let i = 0; i < h; i++) {
      for (let j = 0; j < w; j++) {
        let val = 0, wsum = 0;
        for (let iy = i - rs; iy < i + rs + 1; iy++) {
          for (let ix = j - rs; ix < j + rs + 1; ix++) {
            const x = Math.min(w - 1, Math.max(0, ix));
            const y = Math.min(h - 1, Math.max(0, iy));
            const dsq = (ix - j) * (ix - j) + (iy - i) * (iy - i);
            const wght = Math.exp(-dsq / twoRR) / denom;
            val += inp[y * w + x] * wght;
            wsum += wght;
          }
        }
        out[i * w + j] = val / wsum;   // Uint8Array store truncates like the C uchar
      }
    }
    return out;
  }

  // loadBitmap() + double_ximage(): build the grayscale heat-source from the
  // decoded "Bob" image, fitted to the current field. Pixel-double (nearest, like
  // double_ximage) until the image reaches ~1/10 of the field, convert to grayscale
  // with a vertical flip + contrast bump + inversion (dark image pixels -> hot),
  // then gaussian-blur if it was enlarged.
  function buildTheim() {
    if (!bobReady || !imgW) { theim = null; return; }

    let bw = bobImg.naturalWidth;
    let bh = bobImg.naturalHeight;
    let blur = 0;
    const w10 = Math.trunc(imgW / 10);   // C: st->width / 10 (integer division)
    const h10 = Math.trunc(imgH / 10);
    while (bw < w10 && bh < h10) {        // C: image < st->width/10 && st->height/10
      bw *= 2;
      bh *= 2;
      blur++;
    }

    const c = document.createElement('canvas');
    c.width = bw;
    c.height = bh;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;   // nearest-neighbour == repeated double_ximage
    cx.drawImage(bobImg, 0, 0, bw, bh);
    const src = cx.getImageData(0, 0, bw, bh).data;

    let t = new Uint8Array(bw * bh);
    let o = 0;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const p = (y * bw + x) * 4;   // top-down: canvas getImageData is already row-0-top
        const a = src[p + 3];
        let gray = (a === 0) ? 255 : ((src[p] + src[p + 1] + src[p + 2]) / 3) | 0;
        if (gray < 96) gray = (gray / 2) | 0;    // a little more contrast
        t[o++] = 255 - gray;                     // invert: dark image -> hot heat
      }
    }
    if (blur > 0) t = gaussianBlur(t, bw, bh, blur * 1.7);

    theim = t;
    theimx = bw;
    theimy = bh;
  }

  // One frame == one xflame_draw: seed, paste the fire source, advance, render.
  function step() {
    flameActive();
    if (theim)
      flamePasteData(theim, theimx, theimy,
                     Math.trunc((fwidth - theimx) / 2),
                     fheight - theimy - BASELINE);
    flameAdvance();
    flame2Image();
    offCtx.putImageData(imageData, 0, 0);
    ctx.drawImage(off, 0, 0, W, H);   // upscale offscreen (logical-res) -> device canvas
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // The C runs the heat field at HALF the window's pixel resolution, then
    // Flame2Image 2x-upscales it back. The flame DYNAMICS (bloom amplification,
    // flame height, startup ramp) are tuned to that cell size, so the field must run
    // at the LOGICAL resolution the live binary uses (innerWidth/innerHeight), NOT
    // device px -- computing at device res on a retina screen puts ~2x more rows in
    // each column, which over-amplifies the bloom into a white-hot flare. The
    // CSS-res image is then drawImage-upscaled to the device canvas (the same
    // softness the live binary has when the OS scales its window to a hidpi display).
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

    // InitFlame() seeds the eased spread values from the base defaults.
    residualCur = IRESIDUAL;
    hspreadCur = IHSPREAD;
    vspreadCur = IVSPREAD;

    buildTheim();   // (re)fit the fire source to the new field size
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
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead — see the framerate-calibration note). The
  // live xflame fps was UNMEASURABLE (the full-frame fire obscured the -fps
  // overlay), so this OVERHEAD is an ESTIMATE (~9000 µs, by analogy to the other
  // dense per-pixel/ImageData hacks; the fire blit is a touch heavier) — FLAGGED
  // for a visual check vs the live binary. 10000 + 9000 = 19000 µs -> ~52.6
  // steps/sec. The slider still maps 1:1 to the xml delay.
  const OVERHEAD = 9000;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;   // xml units are µs; rAF is ms
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

  bobImg.onload = () => { bobReady = true; buildTheim(); };
  bobImg.src = BOB_PNG;

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
