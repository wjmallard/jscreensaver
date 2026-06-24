// drift.js — drift packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's drift.c (Scott Draves, 1991-2000; xscreensaver glue by
// Jamie Zawinski, 1997), itself from xlockmore. https://www.jwz.org/xscreensaver/
//
// Drifting recursive fractal cosmic flames. This is Scott Draves' "flame" / IFS
// chaos game: a set of 2-5 affine transforms, each with a non-linear "variation"
// (sinusoidal, complex, bent, swirl, horseshoe, drape). A single point bounces
// through the system — each iteration picks a random transform, applies the
// affine map then the variation, and plots where it lands — and the cloud of
// landing points IS the fractal (a strange attractor of the IFS). The transform
// coefficients then DRIFT a tiny step every frame (each coefficient bounces
// inside [-1,1]), so the whole cloud slowly morphs and floats. A colour
// coordinate `c` rides along (halved toward 0 or 1 each step) and indexes the
// colormap. After `count`-scaled many points the field is full; a short pause,
// then a fresh random flame begins.
//
// Rendering: hundreds of thousands of points accumulate over the life of one
// flame (the C iterates 3000 points/frame for ~1000 frames without clearing),
// so this uses the BLIT path — a persistent Uint32 ImageData buffer we write
// pixels into and putImageData once per frame, like thornbird / hopalong, not
// per-point fillRect.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'drift';

export const info = {
  author: 'Scott Draves',
  description: 'Drifting recursive fractal cosmic flames.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/drift.xml so the config box maps 1:1 to
  // the original. `count` scales how long one flame lives before the screen
  // clears and a new one begins (the xml labels it "Duration"). `grow` and
  // `liss` are the original's -grow / -liss command-line toggles (not in the
  // xml slider set, but documented options): grow = paint many short fractals
  // instead of drifting one; liss = drive the drift from Lissajous figures.
  const config = {
    delay: 10000,    // µs between frames (--delay)
    count: 30,       // flame lifetime scale (--count, "Duration")
    ncolors: 200,    // size of the smooth colormap (--ncolors)
    grow: false,     // grow many fractals vs. drift one (--grow)
    liss: false,     // use Lissajous figures for the drift (--liss)
  };

  // live: true  -> the loop reads config[key] every frame, applies instantly.
  // live: false -> sizes the palette / picks the flame mode, so a change re-runs
  //                init() via reinit() (and clears the canvas).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Duration', type: 'range', min: 1, max: 200, step: 1, default: 30, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'grow', label: 'Grow fractals', type: 'checkbox', default: false, live: false },
    { key: 'liss', label: 'Lissajous drift', type: 'checkbox', default: false, live: false },
  ];

  // Constants from the C (#defines).
  const FUSE = 10;          // discard this many initial iterations after a reset
  const NMAJORVARS = 7;     // number of variations (0..6); 7 == "mixed" sentinel
  const MAXLEV = 10;        // max transforms the C allocates for (we use <=5)
  const ITERS_PER_FRAME = 3000;  // dp->timer: points iterated per draw_drift call
  const BLACK = 0xFF000000;
  const PI = Math.PI;

  let W, H, S;              // canvas size (device px) and devicePixelRatio
  let imageData, pixels;    // persistent Uint32 accumulation buffer
  let palette;              // ncolors packed-ABGR smooth-colormap values
  let dot;                  // point size in device px (1, or 2/3 on retina)

  // Flame shape: nxforms affine transforms f[row][col][i] with drift df, plus a
  // per-transform non-linear variation. Stored as flat arrays of length
  // 2*3*MAXLEV (indexed row*3*MAXLEV + col*MAXLEV + i) to mirror f[2][3][MAXLEV].
  let nxforms;
  let f, df;                // Float64Array(2*3*MAXLEV)
  let variation;            // Int32Array(MAXLEV)
  let majorVariation;

  // Iterate state + high-level control.
  let x, y, c;              // current point and colour coordinate
  let fuse;                 // iterate this many before drawing
  let totalPoints;          // points drawn this flame
  let fractalLen;           // draw this many points, then the flame ends
  let nfractals;            // how many flames left to draw before the blank gap
  let rainbow;              // colour mode (ncolors > 2)
  let eraseCountdown;       // frames to wait (blank) before the next flame
  let pixcol;               // packed colour when not rainbow

  // Lissajous drift bookkeeping.
  let lissTime;

  const IDX = (j, k, i) => j * 3 * MAXLEV + k * MAXLEV + i;

  // The C's halfrandom(dp, mv): a [0, mv) integer. (Its bit-recycling RNG only
  // affects the random stream, not the distribution, so Math.random suffices.)
  function halfrandom(mv) {
    return Math.floor(Math.random() * mv);
  }
  // The C's frandom(dp, n): a [0, n) integer, but n==3 is rejection-sampled to a
  // flat [0, 3) (it draws 2 bits, rejecting the 4th value). Match that bias-free
  // behaviour — equivalent to a plain [0, n) integer.
  function frandom(n) {
    return Math.floor(Math.random() * n);
  }

  // The C builds its palette ONCE at startup with make_smooth_colormap (drift.c
  // defines SMOOTH_COLORS; xlockmore.c:485) -- a muted 2-5 anchor HSV loop, NOT a
  // vivid rainbow -- and never cycles it (writable_p is False). We reproduce that
  // exact palette via colormap.js, packed 0xFFBBGGRR for the blit path.
  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    const ramp = makeSmoothColormapRGB(n);
    palette = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const [r, g, b] = ramp[i];
      palette[i] = (0xff << 24 | b << 16 | g << 8 | r) >>> 0;
    }
  }

  // Paint a dot-sized block at integer (px, py) with packed colour `value`.
  function plot(px, py, value) {
    for (let dy = 0; dy < dot; dy++) {
      const yy = py + dy;
      if (yy < 0 || yy >= H) continue;
      const rowBase = yy * W;
      for (let dx = 0; dx < dot; dx++) {
        const xx = px + dx;
        if (xx >= 0 && xx < W) pixels[rowBase + xx] = value;
      }
    }
  }

  // Pick fresh drift velocities for every coefficient (C: pick_df_coefs). Each
  // transform's 6 coefficients get a random direction, normalised so the whole
  // transform drifts at a small fixed speed (3..7 hundredths per unit length).
  function pickDfCoefs() {
    for (let i = 0; i < nxforms; i++) {
      let r = 1e-6;
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 3; k++) {
          const v = halfrandom(1000) / 500.0 - 1.0;
          df[IDX(j, k, i)] = v;
          r += v * v;
        }
      }
      r = (3 + halfrandom(5)) * 0.01 / Math.sqrt(r);
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 3; k++) {
          df[IDX(j, k, i)] *= r;
        }
      }
    }
  }

  // C: initmode — choose the high-level flame mode (slow/single vs fast/many),
  // the global variation, and how long the flame(s) run. `mode` is 0 or 1.
  function initmode(mode) {
    const VARIATION_LEN = 14;

    let mv = halfrandom(VARIATION_LEN);
    // Re-weight to 0,0,1,1,2,2,3,4,4,5,5,6,6,6 (favours the cheaper variations).
    majorVariation = ((mv >= (VARIATION_LEN >> 1)) && (mv < VARIATION_LEN - 1))
      ? (mv + 1) >> 1
      : mv >> 1;

    if (config.grow) {
      rainbow = 0;
      if (mode) {
        if (!rainbow0() || halfrandom(8)) {
          nfractals = halfrandom(30) + 5;
          fractalLen = halfrandom(7000) + 9000;   // DISTRIB_A
        } else {
          nfractals = halfrandom(5) + 5;
          fractalLen = distribB();
        }
      } else {
        rainbow = rainbow0() ? 1 : 0;
        nfractals = 1;
        fractalLen = distribB();
      }
    } else {
      nfractals = 1;
      rainbow = rainbow0() ? 1 : 0;
      fractalLen = 2000000;
    }
    fractalLen = Math.floor((fractalLen * Math.max(1, Math.round(config.count))) / 20);

    clearBuffer();
  }

  // Whether colour is available (the C's dp->color = MI_NPIXELS > 2). We always
  // have colour, but honour ncolors==1/2 (mono) so the "Colors" knob still bites.
  function rainbow0() {
    return Math.max(1, Math.round(config.ncolors)) > 2;
  }
  // C: DISTRIB_B == (frandom(3)+1) * (frandom(3)+1) * 120000.
  function distribB() {
    return (frandom(3) + 1) * (frandom(3) + 1) * 120000;
  }

  // C: initfractal — start a new flame with the current mode. Picks nxforms, the
  // affine coefficients, the per-transform variations, the seed colour.
  function initfractal() {
    const XFORM_LEN = 9;

    fuse = FUSE;
    totalPoints = 0;

    nxforms = halfrandom(XFORM_LEN);
    // Re-weight to 2,2,2,3,3,3,4,4,5 transforms.
    nxforms = (nxforms >= XFORM_LEN - 1 ? 1 : 0) + ((nxforms / 3) | 0) + 2;

    c = x = y = 0.0;

    if (config.liss && !halfrandom(10)) {
      lissTime = 0;
    }
    if (!config.grow) {
      pickDfCoefs();
    }

    for (let i = 0; i < nxforms; i++) {
      variation[i] = (NMAJORVARS === majorVariation)
        ? halfrandom(NMAJORVARS)
        : majorVariation;
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 3; k++) {
          f[IDX(j, k, i)] = config.liss
            ? Math.sin(lissTime * df[IDX(j, k, i)])
            : (halfrandom(1000) / 500.0 - 1.0);
        }
      }
    }

    pixcol = rainbow0()
      ? palette[halfrandom(palette.length)]
      : 0xFFFFFFFF;
  }

  // C: iter — one chaos-game step. Pick a transform, advance the colour
  // coordinate, apply the affine map then the chosen non-linear variation, with
  // the C's divergence guard (reset the point + re-fuse if it blows up).
  function iter() {
    const i = frandom(nxforms);
    let nc = i ? (c + 1.0) / 2.0 : c / 2.0;

    let nx = f[IDX(0, 0, i)] * x + f[IDX(0, 1, i)] * y + f[IDX(0, 2, i)];
    let ny = f[IDX(1, 0, i)] * x + f[IDX(1, 1, i)] * y + f[IDX(1, 2, i)];

    switch (variation[i]) {
      case 1: {
        // sinusoidal
        nx = Math.sin(nx);
        ny = Math.sin(ny);
        break;
      }
      case 2: {
        // complex
        const r2 = nx * nx + ny * ny + 1e-6;
        nx = nx / r2;
        ny = ny / r2;
        break;
      }
      case 3: {
        // bent
        if (nx < 0.0) nx = nx * 2.0;
        if (ny < 0.0) ny = ny / 2.0;
        break;
      }
      case 4: {
        // swirl
        const r = nx * nx + ny * ny;
        const c1 = Math.sin(r);
        const c2 = Math.cos(r);
        const t = nx;
        if (nx > 1e4 || nx < -1e4 || ny > 1e4 || ny < -1e4) ny = 1e4;
        else ny = c2 * t + c1 * ny;
        nx = c1 * nx - c2 * ny;
        break;
      }
      case 5: {
        // horseshoe
        let r;
        if (nx === 0.0 && ny === 0.0) r = 0.0;
        else r = Math.atan2(nx, ny);
        const c1 = Math.sin(r);
        const c2 = Math.cos(r);
        const t = nx;
        nx = c1 * nx - c2 * ny;
        ny = c2 * t + c1 * ny;
        break;
      }
      case 6: {
        // drape
        let t;
        if (nx === 0.0 && ny === 0.0) t = 0.0;
        else t = Math.atan2(nx, ny) / PI;
        if (nx > 1e4 || nx < -1e4 || ny > 1e4 || ny < -1e4) ny = 1e4;
        else ny = Math.sqrt(nx * nx + ny * ny) - 1.0;
        nx = t;
        break;
      }
      // case 0: identity (affine only)
    }

    // Divergence guard (ny propagates from nx, so only nx is checked, per the C).
    if (nx > 1e4 || nx < -1e4) {
      nx = halfrandom(1000) / 500.0 - 1.0;
      ny = halfrandom(1000) / 500.0 - 1.0;
      fuse = FUSE;
    }
    x = nx;
    y = ny;
    c = nc;
  }

  // C: draw — plot the current point if it's settled (no fuse) and on screen.
  function draw() {
    if (fuse) {
      fuse--;
      return;
    }
    if (!(x > -1.0 && x < 1.0 && y > -1.0 && y < 1.0)) return;

    const fx = ((W / 2) * (x + 1.0)) | 0;
    const fy = ((H / 2) * (y + 1.0)) | 0;

    let value;
    if (rainbow) {
      const npix = palette.length;
      let ci = (c * npix) | 0;
      if (ci < 0) ci = 0;
      else if (ci >= npix) ci = npix - 1;
      value = palette[ci];
    } else {
      value = pixcol;
    }
    plot(fx, fy, value);
  }

  // C: draw_drift — one animation frame. Either wait out the post-flame blank
  // gap, or iterate ITERS_PER_FRAME points then drift the coefficients.
  function step() {
    if (eraseCountdown) {
      // Static blank gap after a flame ends; the screen already shows it, so we
      // only need to repaint on the frame that clears + re-seeds the next flame.
      if (!--eraseCountdown) {
        initmode(frandom(2));   // clearBuffer() blanks the canvas
        initfractal();
        ctx.putImageData(imageData, 0, 0);
      }
      return;
    }

    let timer = ITERS_PER_FRAME;
    while (timer) {
      iter();
      draw();
      if (totalPoints++ > fractalLen) {
        // This flame is full. When the last one of the batch ends, blank and
        // wait `eraseCountdown` frames before re-seeding; otherwise (grow mode,
        // nfractals > 1) start the next overlaid flame in the same buffer.
        if (0 === --nfractals) {
          // The C waits 4 seconds; at config.delay µs/frame that is:
          eraseCountdown = Math.max(1, Math.round(4000000 / Math.max(1, config.delay)));
          ctx.putImageData(imageData, 0, 0);
          return;
        }
        initfractal();
      }
      timer--;
    }

    if (!config.grow) {
      // Drift every coefficient one df-step. Non-liss: integrate and bounce off
      // [-1,1] by reversing the velocity. Liss: re-derive from Lissajous time.
      if (config.liss) lissTime++;
      for (let i = 0; i < nxforms; i++) {
        for (let j = 0; j < 2; j++) {
          for (let k = 0; k < 3; k++) {
            const idx = IDX(j, k, i);
            if (config.liss) {
              f[idx] = Math.sin(lissTime * df[idx]);
            } else {
              const t = (f[idx] += df[idx]);
              if (t < -1.0 || 1.0 < t) df[idx] *= -1.0;
            }
          }
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  function clearBuffer() {
    pixels.fill(BLACK);
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    // Port-side hidpi adaptation (NOT in the C, which draws one X pixel/point):
    // scale the dot with dpr so points stay ~1 CSS px and the per-frame screen-
    // fill fraction matches dpr 1; bump to 3 on very large backing stores.
    dot = (W > 2560 || H > 2560) ? 3 : Math.max(1, Math.round(S));

    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);

    f = new Float64Array(2 * 3 * MAXLEV);
    df = new Float64Array(2 * 3 * MAXLEV);
    variation = new Int32Array(MAXLEV);

    eraseCountdown = 0;
    lissTime = 0;
    nxforms = 2;

    buildPalette();
    initmode(1);
    initfractal();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag accumulator paced by config.delay (µs): run one step() per delay,
  // banking leftover time so the pace is identical at any refresh rate. Cap
  // catch-up so a backgrounded tab doesn't fire a burst of frames on refocus.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay drift runs 36.4 fps, while the
  // port at the stock 10000 us ran ~100 fps (2.7x fast -- each frame's 3000
  // iters + blit make the framework overhead large here). 10000 + 17473 =
  // 27473 us -> 36 fps, matching the live binary. The post-flame erase gap
  // still derives from the raw delay (4e6/delay frames, the C's erase_countdown)
  // and is left untouched. A calibration, not a tuning knob.
  const OVERHEAD = 17473;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;   // xml units are microseconds
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (clears the buffer because ncolors/mode
  // resize the palette and pick a different flame).
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
