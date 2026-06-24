// munch.js — munch ("munching squares") packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's munch.c (Tim Showalter 1997; with Jamie Zawinski and
// Steven Hazel; mismunch merged in 2008). https://www.jwz.org/xscreensaver/
//
// The classic PDP-1 "munching squares" of HAKMEM item 146/147: for a
// power-of-two grid of side W, plot the graph y = x XOR t for consecutive
// values of t (= time). Each "muncher" is one such square at a random spot,
// with random per-square shifts (kX, kT, kY), gravity (vertical flip), colour,
// and an optional near-overlapping shadow copy. A muncher advances one t per
// turn (one diagonal-ish band of points); when t passes its random "doom" it is
// done and replaced. In "mismunch" mode the y recurrence is creatively broken
// (it feeds y back into itself with sign flips) for blocky deformities. Several
// munchers run at once; after `clear` of them complete the screen wipes.
//
// Rendering: the C draws each point with an X11 XOR graphics context (GXxor),
// so a square laid over an earlier one CANCELS where they coincide — that XOR
// interleaving is the munching-squares look. Canvas has no XOR raster op and no
// XOR GC, so we compute the pattern DIRECTLY into a persistent Uint32 ImageData
// and XOR each point's packed RGB into the buffer pixel by hand (set/clear bits
// per the XOR math), then putImageData once per frame. See munch.md for the
// XOR-emulation note. Solid mode just overwrites the pixel instead.

export const title = 'munch';

export const info = {
  author: 'Tim Showalter, Jamie Zawinski and Steven Hazel',
  description: 'DATAI 2\nADDB 1,2\nROTC 2,-22\nXOR 1,2\nJRST .-4\n\nAs reported by HAKMEM (MIT AI Memo 239, 1972), Jackson Wright wrote the above PDP-1 code in 1962. That code still lives on here, 60+ years later.\n\nIn "mismunch" mode, it displays a creatively broken misimplementation of the classic munching squares algorithm instead.\n\nhttps://en.wikipedia.org/wiki/HAKMEM\nhttps://en.wikipedia.org/wiki/Munching_square',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/munch.xml so the tuning UI maps 1:1 to
  // the original (delay in µs, counts as-is). `mismunch` is the xml's 3-way
  // select (random/munch/mismunch); `xor` is its XOR-vs-Solid mode select.
  const config = {
    delay: 10000,       // µs between draw turns (--delay; xml/C stock default)
    clear: 65,          // munchers completed before the screen wipes (--clear / "Duration")
    simul: 5,           // squares munching at once (--simul)
    mismunch: 'random', // 'random' | 'munch' | 'mismunch' (--classic / --mismunch / --random)
    xor: true,          // XOR compositing vs solid over-paint (--xor / --no-xor)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'clear', label: 'Duration', type: 'range', min: 1, max: 200, step: 1, default: 65, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'simul', label: 'Simultaneous squares', type: 'range', min: 1, max: 20, step: 1, default: 5, lowLabel: 'one', highLabel: 'many', live: false },
    { key: 'mismunch', label: 'Mode', type: 'select', default: 'random', live: false, options: [
        { value: 'random', label: 'Munch or mismunch' },
        { value: 'munch', label: 'Munch only' },
        { value: 'mismunch', label: 'Mismunch only' },
      ] },
    { key: 'xor', label: 'XOR', type: 'checkbox', default: true, live: false },
  ];

  // The C advances `simul` munchers but draws only a few per frame, regardless
  // of how many squares are configured: munch_draw() loops 5 times, each time
  // stepping one muncher and rotating to the next. Keep that pace.
  const TURNS_PER_FRAME = 5;

  const BLACK = 0xFF000000;

  // munch works in raw device pixels: square sizes come from calcLogWidths() on
  // the device-px backing store, so they scale with resolution automatically and
  // there's no separate logical-size factor (S) to fold in.
  let W, H;             // canvas size, device px
  let imageData, pixels;
  let munchers;         // active muncher objects
  let logMinWidth, logMaxWidth;
  let drawN;            // munchers completed since the last wipe
  let drawI;            // round-robin cursor over munchers
  let mismunch;         // resolved bool for this batch (random -> coin flip)

  const rnd = (n) => Math.floor(Math.random() * n);   // random() % n
  const coin = () => Math.random() < 0.5;             // random() & 1

  // floor(log2(x)) on an integer, matching utils/pow2.c i_log2: the C truncates
  // the double arg to size_t (so floor the dimension first), returns -1 for 0,
  // and otherwise takes the highest set bit (a clz-based integer op). We mirror
  // that with 31 - clz32 rather than Math.log2, which can round 2^k down to
  // k - epsilon and drop a whole size step (e.g. window*0.8 == 1024 exactly).
  // Window dims are well under 2^31, so clz32 is exact here.
  function ilog2(x) {
    x = Math.floor(x);
    if (x < 1) return -1;
    return 31 - Math.clz32(x);
  }

  // Resolve 'random' to a fresh coin flip; a fixed mode stays put. Matches the
  // C, where mismunch == "random" re-rolls random()&1 each batch.
  function resolveMismunch() {
    if (config.mismunch === 'munch') return false;
    if (config.mismunch === 'mismunch') return true;
    return coin();
  }

  // Choose a range of square sizes from the window size (calc_logwidths). We
  // want a power of 2 so the munch fills up, and a square mustn't exceed 80% of
  // the smaller window dimension or the (mis)munch reads as noise. Always three
  // sizes: [logMaxWidth-2 .. logMaxWidth].
  function calcLogWidths() {
    if (H < W && W < H * 5) {
      logMaxWidth = ilog2(H * 0.8);
    } else {
      logMaxWidth = ilog2(W * 0.8);
    }
    if (logMaxWidth < 2) logMaxWidth = 2;
    logMinWidth = logMaxWidth - 2;
    if (logMinWidth < 2) logMinWidth = 2;
  }

  // make_muncher: one square at a random spot, with random shifts, gravity,
  // colour, optional shadow, a random starting y, and a random "doom" t at
  // which it aborts (doom == width-1 draws the whole square).
  function makeMuncher() {
    const m = {};
    m.mismunch = mismunch;

    // size -- power of two
    const logWidth = logMinWidth + rnd(1 + logMaxWidth - logMinWidth);
    m.width = 1 << logWidth;

    // top-left of where to draw it (device px)
    m.atX = rnd(W <= m.width ? 1 : W - m.width);
    m.atY = rnd(H <= m.width ? 1 : H - m.width);

    // wrap-around offsets; the %width happens later in the recurrence
    m.kX = coin() ? rnd(m.width) : 0;
    m.kT = coin() ? rnd(m.width) : 0;
    m.kY = coin() ? rnd(m.width) : 0;

    // gravity: which way up we draw
    m.grav = rnd(2);

    // The C's hand-picked colour scheme (XColor 16-bit channels). We pack to
    // 8-bit RGB for the pixel buffer; the >> 8 keeps the same balance. The XOR
    // of two such packed colours is exactly what X11 pixel-XOR would produce.
    let r, g, b;
    switch (rnd(4)) {
      case 0:
        r = rnd(65536); b = rnd(32768); g = rnd(16384);
        break;
      case 1:
        r = 0; b = rnd(65536); g = rnd(16384);
        break;
      case 2:
        r = rnd(8192); b = rnd(8192); g = rnd(49152);
        break;
      default:   // case 3 -- a grey
        r = rnd(65536); g = r; b = r;
        break;
    }
    m.color = (((r >> 8) & 0xff)) | (((g >> 8) & 0xff) << 8) | (((b >> 8) & 0xff) << 16);

    // Sometimes a mostly-overlapping shadow copy (only in mismunch mode); this
    // makes the blocky XOR graphics. Otherwise no shadow.
    if (!m.mismunch || rnd(4)) {
      m.xshadow = 0;
      m.yshadow = 0;
    } else {
      m.xshadow = rnd(Math.floor(m.width / 3)) - Math.floor(m.width / 6);
      m.yshadow = rnd(Math.floor(m.width / 3)) - Math.floor(m.width / 6);
    }

    // random starting y controls the kind of deformities
    m.y = rnd(256);
    m.t = 0;
    m.doom = m.mismunch ? rnd(m.width) : (m.width - 1);
    m.done = false;
    return m;
  }

  // XOR one point's colour into the buffer (the GXxor path): toggle the RGB
  // bits, force alpha opaque. Out-of-bounds points are dropped (the C clips to
  // the window). Solid mode overwrites the pixel instead.
  function plot(x, y, color) {
    x |= 0; y |= 0;
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const idx = y * W + x;
    if (config.xor) {
      pixels[idx] = (pixels[idx] ^ (color & 0x00ffffff)) | 0xff000000;
    } else {
      pixels[idx] = color | 0xff000000;
    }
  }

  // munch: draw one pass (one value of t) of a muncher -- a band of width points
  // y = x XOR (t + kT), shifted/flipped per the muncher, plus its shadow. Then
  // advance t; when t passes doom the muncher is done.
  function munch(m) {
    if (m.done) return;

    const width = m.width;
    const kT = m.kT, kX = m.kX, kY = m.kY;
    const atX = m.atX, atY = m.atY;
    const grav = m.grav;
    const color = m.color;
    const hasShadow = (m.xshadow !== 0) || (m.yshadow !== 0);

    for (let x = 0; x < width; x++) {
      // The ordinary munching-squares step is
      //   y = ((x ^ ((t + kT) % width)) + kY) % width
      // mismunch feeds y back into itself with sign flips so parts of some
      // squares land in the wrong place. We replicate the C bit-for-bit and do
      // NOT renormalise: JS bitwise ops are 32-bit two's-complement (== C int)
      // and JS % truncates toward zero (== C %), so a negative y is preserved
      // exactly as the "creatively broken" original intends; plot() clips the
      // resulting off-grid points just as X11 clips to the window.
      if (m.mismunch) {
        m.y = (((-m.y ^ ((-m.t + kT) % width)) + kY) % width);
      } else {
        m.y = (((x ^ ((m.t + kT) % width)) + kY) % width);
      }

      const drawX = ((x + kX) % width) + atX;
      const drawY = grav ? m.y + atY : atY + width - 1 - m.y;

      plot(drawX, drawY, color);
      if (hasShadow) plot(drawX + m.xshadow, drawY + m.yshadow, color);
    }

    m.t++;
    if (m.t > m.doom) m.done = true;
  }

  // One frame = TURNS_PER_FRAME munch turns, round-robin over the munchers, with
  // completed munchers replaced and a screen wipe once `clear` have finished
  // (munch_draw). The C loops `for (i = 0; i < 5; i++)`, stepping st->draw_i and
  // wrapping it at simul; we do the same with drawI.
  function step() {
    for (let i = 0; i < TURNS_PER_FRAME; i++) {
      munch(munchers[drawI]);

      if (munchers[drawI].done) {
        drawN++;
        munchers[drawI] = makeMuncher();
      }

      drawI++;
      if (drawI >= munchers.length) {
        drawI = 0;
        if (config.clear && drawN >= config.clear) {
          mismunch = resolveMismunch();
          for (let j = 0; j < munchers.length; j++) munchers[j] = makeMuncher();
          pixels.fill(BLACK);
          drawN = 0;
        }
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }

  function init() {
    W = canvas.width;
    H = canvas.height;
    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    calcLogWidths();
    mismunch = resolveMismunch();

    const n = Math.max(1, Math.round(config.simul));
    munchers = new Array(n);
    for (let i = 0; i < n; i++) munchers[i] = makeMuncher();

    drawN = 0;
    drawI = 0;
    ctx.putImageData(imageData, 0, 0);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // reinit clears to black and re-seeds (simul/mode/xor may have changed).
  function reinit() {
    init();
  }

  // Drive off requestAnimationFrame but keep the original pace: one step() per
  // config.delay, banking leftover time so the speed is the same at any refresh
  // rate. Cap catch-up so a backgrounded tab doesn't fire a burst on refocus.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead — see the framerate-calibration note). The
  // live munch measures 60.0 fps, but the port at the stock 10000 µs ran 100
  // steps/sec (1.67x fast). 10000 + 6667 = 16667 µs -> 60.0 steps/sec, matching
  // the live binary. One step() == the C's munch_draw (5 turns). A calibration,
  // not a tuning knob (the slider still maps 1:1 to the xml delay).
  const OVERHEAD = 6667;
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
    reinit,   // re-seed + clear, keeping the current config
    config,
    params,
  };
}
