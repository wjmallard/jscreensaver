// greynetic.js — greynetic packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's greynetic.c (Jamie Zawinski, 1992).
// https://www.jwz.org/xscreensaver/
//
// One of the oldest hacks: every step it stamps a single random rectangle and
// never clears, so the screen fills with a churning pile of overlapping rects.
// Each rect's size comes from the C's "minimize area, but don't try too hard"
// loop (up to 10 tries for a box whose w + h fits under both screen dimensions,
// each side >= 50px, then take whatever the last try produced), placed at a
// random spot.
//
// This ports the X11 / DO_STIPPLE build (the #ifndef HAVE_JWXYZ default, and the
// path the autoconf/XQuartz live binary runs): each rect is FillOpaqueStippled
// through one of 12 inlined X11 bitmaps, with random foreground + background
// colours, both OPAQUE (no alpha). Colours are pure uniform random RGB cached in
// a 512-entry pool (greynetic.c's pixels[512]); the `grey` toggle collapses
// every colour to a grey level — the joke behind the name. (The Mac/jwxyz build
// instead draws solid rects with a random alpha and no stipple; see greynetic.md.)
//
// Rendering: bake the tiny 1-bpp bitmap into an offscreen tile (fg where the bit
// is set, bg elsewhere) and ctx.createPattern(..., 'repeat') — the canvas
// analogue of FillOpaqueStippled — then fillRect the rect. The pattern is
// anchored at the canvas origin (not the rect), matching X11's window-origin
// stipple phase so overlapping weaves align. The canvas itself is the persistent
// pile; nothing is read back, nothing accumulates in a separate buffer.

export const title = 'greynetic';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Colored, stippled and transparent rectangles.',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Config mirrors hacks/config/greynetic.xml exactly: the only real resources
  // are `delay` (Frame rate, 0..250000 \u00B5s, default 10000, inverted slider) and
  // `grey` (Boolean, default false). No other knobs exist in the C.
  const config = {
    delay: 10000,   // \u00B5s between rects (--delay; xml default 10000)
    grey: false,    // collapse every colour to a grey level (--grey)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 250000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'grey', label: 'Grey', type: 'checkbox', default: false, live: false },
  ];

  // The 12 X11 stipple bitmaps inlined verbatim from greynetic.c, as
  // { w, h, bits } where `bits` is the raw XBM byte array (bit 0 = leftmost
  // pixel, rows padded to whole bytes). Order matches the C's BITS() calls.
  const STIPPLES = [
    { w: 16, h: 4,  bits: [0x55, 0x55, 0xee, 0xee, 0x55, 0x55, 0xba, 0xbb] },   // stipple
    { w: 16, h: 16, bits: [0x55, 0x55, 0x88, 0x88, 0x55, 0x55, 0x22, 0x22, 0x55, 0x55, 0x88, 0x88,
                           0x55, 0x55, 0x22, 0x22, 0x55, 0x55, 0x88, 0x88, 0x55, 0x55, 0x22, 0x22,
                           0x55, 0x55, 0x88, 0x88, 0x55, 0x55, 0x22, 0x22] },   // cross_weave
    { w: 16, h: 16, bits: [0x55, 0x55, 0x00, 0x00, 0x55, 0x55, 0x00, 0x00, 0x55, 0x55, 0x00, 0x00,
                           0x55, 0x55, 0x00, 0x00, 0x55, 0x55, 0x00, 0x00, 0x55, 0x55, 0x00, 0x00,
                           0x55, 0x55, 0x00, 0x00, 0x55, 0x55, 0x00, 0x00] },   // dimple1
    { w: 16, h: 16, bits: [0x11, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x11, 0x11, 0x00, 0x00,
                           0x00, 0x00, 0x00, 0x00, 0x11, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                           0x11, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },   // dimple3
    { w: 4,  h: 2,  bits: [0x07, 0x0d] },                 // flipped_gray
    { w: 2,  h: 2,  bits: [0x01, 0x02] },                 // gray1
    { w: 4,  h: 4,  bits: [0x01, 0x00, 0x04, 0x00] },     // gray3
    { w: 1,  h: 2,  bits: [0x01, 0x00] },                 // hlines2
    { w: 4,  h: 2,  bits: [0x08, 0x02] },                 // light_gray
    { w: 4,  h: 4,  bits: [0x07, 0x0d, 0x0b, 0x0e] },     // root_weave
    { w: 2,  h: 1,  bits: [0x01] },                       // vlines2
    { w: 3,  h: 1,  bits: [0x02] },                       // vlines3
  ];

  const POOL_CAP = 512;   // greynetic.c: pixels[512]

  let S = 1;            // devicePixelRatio
  let W, H;             // canvas size, device px
  let pixels = [];      // up-to-512 cache of allocated [r, g, b] colours
  let patternCanvas;    // scratch canvas used to bake stipple tiles

  function randByte() {
    return Math.floor(Math.random() * 256);
  }

  // One colour as [r, g, b], pure uniform random RGB (greynetic.c's
  // fgc.red/green/blue = random()). grey_p collapses the three channels to a
  // single grey level — the joke behind the name.
  function randomColor() {
    const r = randByte();
    if (config.grey) return [r, r, r];
    return [r, randByte(), randByte()];
  }

  // greynetic.c's colour logic: allocate a fresh random fg + bg into a 512-entry
  // pool until it fills, then REUSE two random entries. (On the original this was
  // X colormap recycling; on TrueColor/jwxyz allocation always succeeds, so the
  // pool simply caps at 512 and recycles.) Returns [fg, bg].
  function pickColors() {
    if (pixels.length >= POOL_CAP) {
      const fg = pixels[Math.floor(Math.random() * pixels.length)];
      const bg = pixels[Math.floor(Math.random() * pixels.length)];
      return [fg, bg];
    }
    const fg = randomColor();
    const bg = randomColor();
    pixels.push(fg, bg);
    return [fg, bg];
  }

  // Bake one stipple bitmap into a tiled CanvasPattern: fg pixels where the bit
  // is set, bg pixels elsewhere — matching X11's FillOpaqueStippled (both
  // opaque). The tile is drawn at the device-pixel scale so the weave stays
  // visible on retina.
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

  // greynetic.c's rectangle sizer: up to 10 tries for a box whose w + h stays
  // under both screen dimensions ("minimize area, but don't try too hard"), then
  // take whatever the last try produced. Each side is at least 50px. No scaling
  // — the C draws the box at full size.
  function pickRect() {
    const minW = 50 * S, minH = 50 * S;
    let w = minW, h = minH;
    for (let i = 0; i < 10; i++) {
      w = minW + Math.floor(Math.random() * Math.max(1, W - minW));
      h = minH + Math.floor(Math.random() * Math.max(1, H - minH));
      if (w + h < W && w + h < H) break;
    }
    const x = Math.floor(Math.random() * Math.max(1, W - w));
    const y = Math.floor(Math.random() * Math.max(1, H - h));
    return { x, y, w, h };
  }

  // One step: stamp a single FillOpaqueStippled rectangle — a random bitmap with
  // random fg/bg colours. The pattern tiles from the canvas origin (X11's
  // window-origin stipple phase), so overlapping weaves align. Never clears.
  function step() {
    const { x, y, w, h } = pickRect();
    const [fg, bg] = pickColors();
    const stipple = STIPPLES[Math.floor(Math.random() * STIPPLES.length)];
    ctx.fillStyle = makeStipplePattern(stipple, fg, bg);
    ctx.fillRect(x, y, w, h);
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    patternCanvas = document.createElement('canvas');
    pixels = [];
  }

  // reinit clears to black and empties the colour pool (e.g. the grey toggle
  // changed); the next rects repopulate it.
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    pixels = [];
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

  // Drive off requestAnimationFrame but keep the C's pace: one step() per
  // config.delay \u00B5s, banking leftover time so the speed is the same at any
  // refresh rate. Cap catch-up so a backgrounded tab doesn't burst on refocus.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay greynetic runs 51.5 fps, while the
  // port at the stock 10000 us ran ~100 fps (1.9x fast). 10000 + 9417 = 19417
  // us -> 52 fps, matching the live binary. A calibration, not a tuning knob
  // (the delay slider still maps 1:1 to the xml resource).
  const OVERHEAD = 9417;
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
    reinit,   // clear + empty the colour pool, keeping the current config
    config,
    params,
  };
}
