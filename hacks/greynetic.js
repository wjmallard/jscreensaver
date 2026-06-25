// greynetic.js — greynetic packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's greynetic.c (Jamie Zawinski, 1992).
// https://www.jwz.org/xscreensaver/
//
// Stamps a new random rectangle onto the canvas every step, forever, never
// clearing — so the screen fills with a churning pile of overlapping rects.
// Each rect's size comes from the C's "minimize area, but don't try too hard"
// loop (10 tries to land a smallish box, then take whatever we have), placed at
// a random spot. Two looks, switchable: SOLID rects in a vivid random colour
// with a random alpha (the Mac/jwxyz path: translucent, so layers show through),
// or STIPPLED rects — a two-colour fill through one of 12 classic X11 bitmap
// patterns (the original X11 path). The "grey" toggle honours the ironic name
// by desaturating every colour to a grey level; left off, it's garish colour.
//
// Rendering: SOLID is a trivial per-step ctx.fillRect with an rgba() fill — no
// accumulation buffer, the canvas itself is the persistent pile. STIPPLED tiles
// a tiny offscreen 1-bpp bitmap (fg where the bit is set, bg elsewhere) into a
// CanvasPattern and fills the rect with it — the canvas analogue of X11's
// FillOpaqueStippled. Both are cheap vector fills; nothing is ever read back.

export const title = 'greynetic';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Colored, stippled and transparent rectangles.',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/greynetic.xml. The stock UI exposes only
  // delay + grey; `mode`, `ncolors`, and `alpha` are added for parity with the
  // other ports (the C hardcodes the equivalents: 512-colour cap, full-random
  // alpha on Mac, stipple-vs-solid chosen at compile time).
  const config = {
    delay: 250000,    // µs between stamps (--delay)
    mode: 'random',   // 'random' | 'solid' | 'stippled' — fill style per rect
    grey: false,      // desaturate every colour to a grey level (--grey)
    ncolors: 512,     // size of the recycled colour pool (C caps pixels[] at 512)
    alpha: 60,        // solid-rect opacity floor %; rest is random translucency
    scale: 0.5,       // rect-size multiplier (1 = the C's full size)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 250000, step: 1000, default: 250000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'mode', label: 'Fill', type: 'select', default: 'random', live: false, options: [
        { value: 'random', label: 'solid or stippled' },
        { value: 'solid', label: 'solid only' },
        { value: 'stippled', label: 'stippled only' },
      ] },
    { key: 'alpha', label: 'Opacity', type: 'range', min: 0, max: 100, step: 1, default: 60, unit: '%', lowLabel: 'sheer', highLabel: 'opaque', live: true },
    { key: 'scale', label: 'Rect size', type: 'range', min: 0.1, max: 1, step: 0.05, default: 0.5, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 512, step: 1, default: 512, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'grey', label: 'Grey', type: 'checkbox', default: false, live: false },
  ];

  // The 12 X11 stipple bitmaps inlined in greynetic.c, as { w, h, bits } where
  // `bits` is the raw little-endian-bit XBM byte array (bit 0 = leftmost pixel,
  // rows padded to whole bytes). Used to build tiled fg/bg patterns.
  const STIPPLES = [
    { w: 16, h: 4,  bits: [0x55, 0x55, 0xee, 0xee, 0x55, 0x55, 0xba, 0xbb] },
    { w: 16, h: 16, bits: [0x55, 0x55, 0x88, 0x88, 0x55, 0x55, 0x22, 0x22, 0x55, 0x55, 0x88, 0x88,
                           0x55, 0x55, 0x22, 0x22, 0x55, 0x55, 0x88, 0x88, 0x55, 0x55, 0x22, 0x22,
                           0x55, 0x55, 0x88, 0x88, 0x55, 0x55, 0x22, 0x22] },
    { w: 16, h: 16, bits: [0x55, 0x55, 0x00, 0x00, 0x55, 0x55, 0x00, 0x00, 0x55, 0x55, 0x00, 0x00,
                           0x55, 0x55, 0x00, 0x00, 0x55, 0x55, 0x00, 0x00, 0x55, 0x55, 0x00, 0x00,
                           0x55, 0x55, 0x00, 0x00, 0x55, 0x55, 0x00, 0x00] },
    { w: 16, h: 16, bits: [0x11, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x11, 0x11, 0x00, 0x00,
                           0x00, 0x00, 0x00, 0x00, 0x11, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                           0x11, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },
    { w: 4,  h: 2,  bits: [0x07, 0x0d] },                 // flipped_gray
    { w: 2,  h: 2,  bits: [0x01, 0x02] },                 // gray1
    { w: 4,  h: 4,  bits: [0x01, 0x00, 0x04, 0x00] },     // gray3
    { w: 1,  h: 2,  bits: [0x01, 0x00] },                 // hlines2
    { w: 4,  h: 2,  bits: [0x08, 0x02] },                 // light_gray
    { w: 4,  h: 4,  bits: [0x07, 0x0d, 0x0b, 0x0e] },     // root_weave
    { w: 2,  h: 1,  bits: [0x01] },                       // vlines2
    { w: 3,  h: 1,  bits: [0x02] },                       // vlines3
  ];

  let S = 1;            // devicePixelRatio
  let W, H;             // canvas size, device px
  let pool;             // recycled pool of vivid colours, [r, g, b] each
  let patternCanvas;    // scratch canvas used to bake stipple patterns

  function randByte() {
    return Math.floor(Math.random() * 256);
  }

  // A fresh random colour as [r, g, b]. Greynetic's name is ironic: the original
  // is garish full-spectrum, so by default we keep it vivid (push channels apart
  // a little); `grey` collapses the three channels to one grey level like the C.
  function randomColor() {
    let r = randByte(), g = randByte(), b = randByte();
    if (config.grey) {
      g = b = r;
    } else {
      // Nudge toward saturation: stretch the spread around the mid channel so
      // colours read as bright hues rather than muddy near-greys.
      const lo = Math.min(r, g, b), hi = Math.max(r, g, b);
      if (hi - lo < 64) { r = (r + 96) & 255; b = (b + 160) & 255; }
    }
    return [r, g, b];
  }

  function buildPool() {
    const n = Math.max(2, Math.round(config.ncolors));
    pool = new Array(n);
    for (let i = 0; i < n; i++) pool[i] = randomColor();
  }

  function pick() {
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Bake one stipple bitmap into a tiled CanvasPattern: fg pixels where the bit
  // is set, bg pixels elsewhere — matching X11's FillOpaqueStippled. The tile is
  // drawn at the device-pixel scale so the weave stays visible on retina.
  function makeStipplePattern(stipple, fg, bg) {
    const tile = Math.max(1, Math.round(S));   // device px per bitmap pixel
    const tw = stipple.w * tile, th = stipple.h * tile;
    patternCanvas.width = tw;
    patternCanvas.height = th;
    const pctx = patternCanvas.getContext('2d');
    const img = pctx.createImageData(tw, th);
    const data = img.data;
    const bytesPerRow = (stipple.w + 7) >> 3;   // XBM rows pad to whole bytes
    for (let by = 0; by < stipple.h; by++) {
      for (let bx = 0; bx < stipple.w; bx++) {
        const byte = stipple.bits[by * bytesPerRow + (bx >> 3)];
        const on = (byte >> (bx & 7)) & 1;       // XBM bit 0 = leftmost pixel
        const [cr, cg, cb] = on ? fg : bg;
        for (let dy = 0; dy < tile; dy++) {
          for (let dx = 0; dx < tile; dx++) {
            const px = ((by * tile + dy) * tw + (bx * tile + dx)) * 4;
            data[px] = cr; data[px + 1] = cg; data[px + 2] = cb; data[px + 3] = 255;
          }
        }
      }
    }
    pctx.putImageData(img, 0, 0);
    return ctx.createPattern(patternCanvas, 'repeat');
  }

  // The C's rectangle sizer: try up to 10 times for a box small enough that
  // w + h stays under both dimensions ("minimize area, but don't try too hard"),
  // then take whatever the last try produced. Each side is at least 50px.
  function pickRect() {
    const minW = 50 * S, minH = 50 * S;
    let w = minW, h = minH;
    for (let i = 0; i < 10; i++) {
      w = minW + Math.floor(Math.random() * Math.max(1, W - minW));
      h = minH + Math.floor(Math.random() * Math.max(1, H - minH));
      if (w + h < W && w + h < H) break;
    }
    // Scale the box down (config.scale; 1 = the C's full size) and clamp.
    w = Math.max(1, Math.min(W, Math.round(w * config.scale)));
    h = Math.max(1, Math.min(H, Math.round(h * config.scale)));
    const x = Math.floor(Math.random() * Math.max(1, W - w));
    const y = Math.floor(Math.random() * Math.max(1, H - h));
    return { x, y, w, h };
  }

  // One step: stamp a single rectangle. Solid = an rgba() fill at a random alpha
  // (floor = config.alpha, rest random, so stacked rects show through). Stippled
  // = a two-colour bitmap pattern. Never clears — the canvas is the pile.
  function step() {
    const { x, y, w, h } = pickRect();
    const stippled = config.mode === 'stippled' ? true
                   : config.mode === 'solid' ? false
                   : Math.random() < 0.5;

    if (stippled) {
      const fg = pick(), bg = pick();
      ctx.save();
      ctx.fillStyle = makeStipplePattern(STIPPLES[Math.floor(Math.random() * STIPPLES.length)], fg, bg);
      // The pattern tiles from the canvas origin; translate so it aligns to the
      // rect's top-left (cosmetic — keeps the weave from shifting between rects).
      ctx.translate(x, y);
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    } else {
      const [r, g, b] = pick();
      const floor = config.alpha / 100;
      const a = floor + Math.random() * (1 - floor);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
      ctx.fillRect(x, y, w, h);
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    patternCanvas = document.createElement('canvas');
    buildPool();
  }

  // reinit clears to black (the colour pool or grey toggle may have changed) and re-seeds.
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    buildPool();
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
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
    const delayMs = config.delay / 1000;
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
    reinit,   // re-seed colours + clear, keeping the current config
    config,
    params,
  };
}
