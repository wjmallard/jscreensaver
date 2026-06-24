// metaballs.js — metaballs packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's metaballs.c (W.P. van Paassen, 2002-2003), itself
// written for the Demo Effects Collection. https://www.jwz.org/xscreensaver/
//
// Several "balls" drift around the screen on a random walk. Each ball stamps a
// precomputed radial density blob (bright at the centre, fading to nothing at
// its rim) into a per-pixel accumulation grid; where blobs overlap their
// densities sum, so neighbouring balls bulge toward each other and merge into
// one gooey shape. The accumulated density at each pixel indexes a palette that
// ramps black -> base colour -> white, so the dense cores read bright and the
// soft fringes fade to black — the classic metaball "lava lamp" surface.
//
// Rendering: this is a dense per-pixel field rebuilt every frame (clear grid,
// re-stamp every blob, map the whole grid through the palette), so it uses the
// BLIT path — a Uint32 ImageData written once and putImageData'd per frame,
// rather than millions of per-pixel canvas calls. To keep retina displays
// affordable the field is computed at LOGICAL (CSS-pixel) resolution and the
// canvas upscales it (see metaballs.md, "Deviations").

export const title = 'metaballs';

export const info = {
  author: 'W.P. van Paassen',
  description: '2D meta-balls: overlapping and merging balls with fuzzy edges.\n\nhttps://en.wikipedia.org/wiki/Metaballs',
  year: 2003,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/metaballs.xml so the config box maps
  // 1:1 to the original. delay is microseconds (xml units).
  const config = {
    delay: 10000,    // \u00B5s between frames (--delay)
    cycles: 1000,    // frames before re-rolling palette + ball positions (--cycles)
    ncolors: 256,    // size of the black -> base -> white density ramp (--ncolors)
    count: 10,       // number of balls (--count)
    radius: 100,     // ball radius, percent of (screen height / 8) (--radius)
    delta: 3,        // per-frame random-walk step in pixels (--delta)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cycles', label: 'Duration', type: 'range', min: 100, max: 3000, step: 10, default: 1000, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'delta', label: 'Ball movement', type: 'range', min: 1, max: 20, step: 1, default: 3, lowLabel: 'small', highLabel: 'big', live: true },
    { key: 'count', label: 'Ball count', type: 'range', min: 2, max: 255, step: 1, default: 10, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'radius', label: 'Ball radius', type: 'range', min: 2, max: 100, step: 1, default: 100, lowLabel: 'small', highLabel: 'big', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 256, step: 1, default: 256, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  const BLACK = 0xFF000000;

  let S;                 // devicePixelRatio
  let gw, gh;            // field grid size, LOGICAL px (== canvas px / S)
  let imageData, pixels; // Uint32 buffer at grid resolution
  let scratch, sctx;     // offscreen canvas holding the grid, upscaled to the main canvas

  let blob;              // Uint8Array(dradius*dradius): one ball's radial density stamp
  let dradius;           // stamp side = radius * 2
  let radius;            // ball radius in grid (logical) px

  let blub;              // Uint8Array(gw*gh): per-pixel accumulated density (0..ncolors-1)
  let balls;             // [{ x, y }, ...] ball top-left positions (like C's blob xpos/ypos)

  let ncolors;           // captured colour count (2..256)
  let palette;           // Uint32Array(ncolors) packed ABGR: black -> base -> white
  let frameCount;        // steps since the last palette/position roll (drives "Duration")

  // frand(n) -> [0, n); the C's frand.
  function frand(n) {
    return Math.random() * n;
  }

  // The C's BELLRAND(n): average of three frand(n) -> a bell-ish curve peaking
  // at n/2, used to bias new balls toward the screen centre.
  function bellRand(n) {
    return (frand(n) + frand(n) + frand(n)) / 3;
  }

  // randInt(n) -> integer in [0, n). Used to pick the palette base colour as
  // three independent random channels, matching the C's random() % 0xFFFF per
  // channel (here at 8-bit-per-channel resolution).
  function randInt(n) {
    return Math.floor(Math.random() * n);
  }

  // Build the ncolors-entry palette exactly as the C's SetPalette: pick a random
  // base colour as three independent random bytes (the C picks each channel as
  // random() % 0xFFFF, an independent uniform-random channel — so the base is
  // often muted/dark/pastel, not always a fully-saturated vivid hue), then index
  // 0..ncolors/2 ramps black -> base and ncolors/2..ncolors ramps base -> white.
  // Index 0 is forced to black so the background (zero-density pixels) stays
  // unlit. The whole field reads as one hue per run (density = brightness); the
  // base is re-rolled every `cycles` frames, so the colour changes across
  // successive runs (faithful to the C — NOT multi-hue within a run). Packed
  // little-endian ABGR.
  function buildPalette() {
    const [br, bg, bb] = [randInt(256), randInt(256), randInt(256)];
    palette = new Uint32Array(ncolors);
    const half = ncolors / 2;
    for (let i = 0; i < ncolors; i++) {
      let r, g, b;
      if (i < ncolors / 2) {
        // Black -> base colour.
        r = (br / half) * i;
        g = (bg / half) * i;
        b = (bb / half) * i;
      } else {
        // Base colour -> white.
        r = ((0xff - br) / half) * (i - half) + br;
        g = ((0xff - bg) / half) * (i - half) + bg;
        b = ((0xff - bb) / half) * (i - half) + bb;
      }
      r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
      g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
      b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
      palette[i] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
    // Force index 0 to opaque black (the C maps density 0 to the window bg).
    palette[0] = BLACK;
  }

  // Place one ball at a fresh random position, biased toward the centre
  // (matches the C's init_blob: quarter-screen offset + a centred bell spread,
  // minus radius so the stamp's centre lands near the chosen point).
  function initBall(ball) {
    ball.x = (gw / 4 + bellRand(gw / 2) - radius) | 0;
    ball.y = (gh / 4 + bellRand(gh / 2) - radius) | 0;
  }

  // Build the radial density stamp ONCE: for each cell within `radius` of the
  // centre, density = (1 - frac^2)^4 * 255 where frac = dist^2 / radius^2, so
  // it is 255 at the centre and falls smoothly to 0 at the rim; 0 outside.
  function buildBlob() {
    dradius = radius * 2;
    const sradius = radius * radius;
    blob = new Uint8Array(dradius * dradius);
    for (let i = -radius; i < radius; i++) {
      for (let j = -radius; j < radius; j++) {
        const distSq = i * i + j * j;
        let v = 0;
        if (distSq <= sradius) {
          const frac = distSq / sradius;
          const t = 1 - frac * frac;
          v = (Math.pow(t, 4) * 255) | 0;
        }
        blob[(i + radius) * dradius + (j + radius)] = v;
      }
    }
  }

  // One frame of the C's Execute: clear the grid, random-walk every ball,
  // re-stamp each on-screen ball (saturating-add into the grid, clamped to
  // ncolors-1; off-screen balls respawn), then map the grid through the
  // palette into the pixel buffer and blit.
  function step() {
    // Roll a fresh palette + ball layout every `cycles` frames ("Duration").
    if (frameCount >= config.cycles) {
      buildPalette();
      for (let k = 0; k < balls.length; k++) initBall(balls[k]);
      frameCount = 0;
    }
    frameCount++;

    // Clear the accumulation grid.
    blub.fill(0);

    const maxIdx = ncolors - 1;
    const delta = config.delta;

    // Random-walk every ball: step ~ [-delta, +delta]. The C truncates only the
    // (always non-negative) product before subtracting the integer delta, so
    // floor the product here too (not the signed sum, which would round wrong).
    for (let k = 0; k < balls.length; k++) {
      balls[k].x += -delta + Math.floor((delta + 0.5) * frand(2.0));
      balls[k].y += -delta + Math.floor((delta + 0.5) * frand(2.0));
    }

    // Stamp each ball's blob into the grid (saturating add, clamp to maxIdx).
    for (let k = 0; k < balls.length; k++) {
      const bx = balls[k].x;
      const by = balls[k].y;
      // On-screen-ish test (matches the C's bounds before stamping).
      if (by > -dradius && bx > -dradius && by < gh && bx < gw) {
        for (let i = 0; i < dradius; i++) {
          const gy = by + i;
          if (gy < 0 || gy >= gh) continue;
          const rowBase = gy * gw;
          const blobRow = i * dradius;
          for (let j = 0; j < dradius; j++) {
            const gx = bx + j;
            if (gx < 0 || gx >= gw) continue;
            const idx = rowBase + gx;
            const cur = blub[idx];
            if (cur < maxIdx) {
              const sum = cur + blob[blobRow + j];
              blub[idx] = sum > maxIdx ? maxIdx : sum;
            }
          }
        }
      } else {
        initBall(balls[k]);
      }
    }

    // Map the density grid through the palette into the pixel buffer.
    const n = gw * gh;
    for (let p = 0; p < n; p++) {
      pixels[p] = palette[blub[p]];
    }

    // Blit the grid, then upscale it onto the (device-px) main canvas.
    sctx.putImageData(imageData, 0, 0);
    if (S === 1) {
      ctx.drawImage(scratch, 0, 0);
    } else {
      ctx.drawImage(scratch, 0, 0, gw, gh, 0, 0, canvas.width, canvas.height);
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;

    // Field grid is the canvas at LOGICAL resolution (canvas px / dpr); the
    // canvas upscales it, which keeps the per-frame pixel work independent of
    // dpr while staying crisp on retina (see metaballs.md).
    gw = Math.max(1, Math.round(canvas.width / S));
    gh = Math.max(1, Math.round(canvas.height / S));

    // Radius: percent of (grid height / 8), as the C does against the window
    // height; clamp like the C (<=127 so dradius fits a byte, >=20 for tiny).
    radius = ((config.radius / 100) * (gh >> 3)) | 0;
    if (radius >= 128) radius = 127;
    if (gw < 100 || gh < 100) {
      if (radius < 20) radius = 20;
    }
    if (radius < 2) radius = 2;

    ncolors = Math.max(2, Math.min(256, Math.round(config.ncolors)));

    buildBlob();
    buildPalette();

    blub = new Uint8Array(gw * gh);

    const count = Math.max(2, Math.min(255, Math.round(config.count)));
    balls = new Array(count);
    for (let k = 0; k < count; k++) {
      balls[k] = { x: 0, y: 0 };
      initBall(balls[k]);
    }

    // Pixel buffer + offscreen canvas at grid resolution.
    scratch = document.createElement('canvas');
    scratch.width = gw;
    scratch.height = gh;
    sctx = scratch.getContext('2d');
    imageData = sctx.createImageData(gw, gh);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    frameCount = 0;

    // Clear the visible canvas to black so frame zero starts clean.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced by config.delay (µs): run one step() per delay,
  // banking leftover time so the pace is identical at any refresh rate. Cap
  // catch-up so a backgrounded tab doesn't fire a burst of steps on refocus.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay metaballs runs 52.0 fps, while the
  // port at the stock 10000 us ran ~100 fps (1.9x fast). 10000 + 9231 = 19231
  // us -> 52 fps, matching the live binary. A calibration, not a tuning knob
  // (the delay slider still maps 1:1 to the xml resource).
  const OVERHEAD = 9231;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (rebuilds the stamp, palette, grid and
  // balls because radius/count/ncolors resize them; also clears the canvas).
  function reinit() {
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
    reinit,
    config,
    params,
  };
}
