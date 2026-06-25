// ifs.js — ifs packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's ifs.c (Chris Le Sueur & Robby Griffin, 2005-2006,
// after Massimino Pascal's original; multi-colour mode by Jack Grahl, 2007).
// https://www.jwz.org/xscreensaver/
//
// Clouds of Iterated Function Systems spin and collide. A handful of affine
// "lenses" (rotate + scale + translate) define the IFS; the chaos game picks
// lenses at random and folds a moving point through them, plotting one dot per
// iteration. Number of points drawn is functions^detail, so "Detail" is
// exponential. Each frame the lenses MORPH a little — rotation and scale ease
// sinusoidally toward fresh random targets, translation drifts on a wandering
// velocity — so the fractal writhes and the clouds tumble through each other.
//
// Rendering: tens of thousands of points accumulate per frame, so this uses the
// BLIT path (like thornbird / hopalong) — a persistent Uint32 ImageData buffer
// that we plot/erase individual pixels into and putImageData once per frame,
// rather than tens of thousands of per-point fillRect calls. A per-frame bit
// board dedupes repeated hits (matching the C's getdot/setdot), and the buffer
// is cleared each frame, so the figure is redrawn fresh every step (the C only
// erases its dirty bbox, but a full clear of a Uint32 buffer is just as cheap
// and avoids tracking the box).

export const title = 'ifs';

export const info = {
  author: 'Chris Le Sueur and Robby Griffin',
  description: 'Clouds of iterated function systems spin and collide.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/ifs.xml so the config box maps 1:1 to
  // the original. (`mode`, `recurse` and `multi` aren't surfaced in the stock
  // UI; the C defaults are recurse=False / multi=True, which we follow.)
  const config = {
    delay: 30000,     // µs between frames (--delay)
    functions: 3,     // number of affine lenses (--functions)
    detail: 9,        // exponent: points drawn = functions^detail (--detail)
    ncolors: 200,     // size of the rainbow palette (--colors)
    translate: true,  // morph: let lenses wander (--no-translate to disable)
    scale: true,      // morph: let lenses breathe (--no-scale to disable)
    rotate: true,     // morph: let lenses spin (--no-rotate to disable)
  };

  // live: true  -> the loop reads config[key] every frame, applies instantly.
  // live: false -> the value sizes the lens set / palette / point budget, so a
  //                change re-runs init() via reinit() (and clears the canvas).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'functions', label: 'Number of functions', type: 'range', min: 2, max: 6, step: 1, default: 3, lowLabel: '2', highLabel: '6', live: false },
    { key: 'detail', label: 'Detail (exponential)', type: 'range', min: 4, max: 14, step: 1, default: 9, lowLabel: 'low', highLabel: 'high', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'translate', label: 'Translate', type: 'checkbox', default: true, live: true },
    { key: 'scale', label: 'Scale', type: 'checkbox', default: true, live: true },
    { key: 'rotate', label: 'Rotate', type: 'checkbox', default: true, live: true },
  ];

  const BLACK = 0xFF000000;
  const HALF_PI = Math.PI / 2;

  let W, H, S;                 // canvas size (device px) and devicePixelRatio
  let imageData, pixels;       // persistent Uint32 accumulation buffer
  let board;                   // Uint8 per-pixel "drawn this frame?" dedupe map
  let palette;                 // ncolors packed-ABGR rainbow values
  let lenses;                  // array of Lens objects (the IFS)
  let lensnum;                 // == functions (captured at init)
  let length;                  // == detail (captured at init)
  let ccolour;                 // rotating base palette index
  let pscale;                  // dot size in device px (1, or 3 on retina)
  let px, py;                  // chaos-game point, in 256ths of a pixel
  let width8, height8;         // W<<8, H<<8 — the 256ths-of-a-pixel bounds

  // random in [0, up), matching the C's myrandom().
  function myrandom(up) {
    return Math.random() * up;
  }

  // hsl (h deg, s/l in [0,1]) -> little-endian 0xAABBGGRR, matching ImageData.
  function hslToUint(h, s, l) {
    const k = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = k * (1 - Math.abs(hp % 2 - 1));
    let r = 0, g = 0, bl = 0;
    if (hp < 1)      { r = k; g = x; }
    else if (hp < 2) { r = x; g = k; }
    else if (hp < 3) { g = k; bl = x; }
    else if (hp < 4) { g = x; bl = k; }
    else if (hp < 5) { r = x; bl = k; }
    else             { r = k; bl = x; }
    const m = l - k / 2;
    const R = Math.round((r + m) * 255);
    const G = Math.round((g + m) * 255);
    const B = Math.round((bl + m) * 255);
    return ((255 << 24) | (B << 16) | (G << 8) | R) >>> 0;
  }

  function buildPalette() {
    // The C makes >= lensnum colours; mirror that floor.
    let n = Math.max(2, Math.round(config.ncolors));
    if (n < lensnum) n = lensnum;
    palette = new Uint32Array(n);
    for (let i = 0; i < n; i++) palette[i] = hslToUint((i * 360 / n) % 360, 1, 0.55);
  }

  // Precompute the fixed-point matrix/vector for a lens (lensmatrix()).
  // The matrix carries an extra factor of 2^10 and coordinates an extra 2^8,
  // so STEP() shifts the products back down by 10. We keep these as plain JS
  // numbers (float64) instead of the C's int, because the intermediate
  // products can exceed 2^31 on large canvases and JS bit-ops would truncate
  // to int32; float64 holds them exactly and Math.floor(.../1024) reproduces
  // the C's arithmetic >>10 (floor division) for both signs.
  function lensmatrix(l) {
    const cr = Math.cos(l.r);
    const sr = Math.sin(l.r);
    l.ua = 1024.0 * l.s * cr;
    l.ub = -1024.0 * l.s * sr;
    l.uc = -l.ub;
    l.ud = l.ua;
    l.utx = 131072.0 * W * (l.s * (sr - cr) + l.tx / 16 + 1);
    l.uty = -131072.0 * H * (l.s * (sr + cr) + l.ty / 16 - 1);
  }

  // Build one fresh lens (CreateLens()). nr/ns/nx/ny are the seed rotation,
  // scale and translation; the morph state (old/target/counter, velocities)
  // starts so the first mutate() begins easing toward a new target immediately.
  function createLens(nr, ns, nx, ny) {
    const l = {
      r: 0, s: 0.5, tx: 0, ty: 0,
      ro: 0, rt: 0, rc: 1,
      so: 0, st: 0, sc: 1,
      sa: 0, txa: 0, tya: 0,
      ua: 0, ub: 0, uc: 0, ud: 0, utx: 0, uty: 0,
    };
    if (config.rotate) {
      l.r = l.ro = l.rt = nr;
      l.rc = 1;
    } else {
      l.r = 0;
    }
    if (config.scale) {
      l.s = l.so = l.st = ns;
      l.sc = 1;
    } else {
      l.s = 0.5;
    }
    l.tx = nx;
    l.ty = ny;
    lensmatrix(l);
    return l;
  }

  // Slowly morph a lens toward fresh random targets (mutate()): rotation and
  // scale ease sinusoidally (counter += 0.01, re-roll a new target on wrap),
  // translation drifts on a wandering velocity that's nudged back when it
  // strays too far. Reads the live rotate/scale/translate toggles each frame.
  function mutate(l) {
    if (config.rotate) {
      if (l.rc >= 1) {
        l.rc = 0;
        l.ro = l.rt;
        l.rt = myrandom(4) - 2;
      }
      const factor = (Math.sin(-HALF_PI + Math.PI * l.rc) + 1.0) / 2.0;
      l.r = l.ro + (l.rt - l.ro) * factor;
      l.rc += 0.01;
    }
    if (config.scale) {
      if (l.sc >= 1) {
        l.sc = 0;
        l.so = l.st;
        l.st = myrandom(2) - 1;
      }
      const factor = (Math.sin(-HALF_PI + Math.PI * l.sc) + 1.0) / 2.0;
      l.s = l.so + (l.st - l.so) * factor;
      l.sc += 0.01;
    }
    if (config.translate) {
      l.txa += myrandom(0.004) - 0.002;
      l.tya += myrandom(0.004) - 0.002;
      l.tx += l.txa;
      l.ty += l.tya;
      if (l.tx > 6) l.txa -= 0.004;
      if (l.ty > 6) l.tya -= 0.004;
      if (l.tx < -6) l.txa += 0.004;
      if (l.ty < -6) l.tya += 0.004;
      if (l.txa > 0.05 || l.txa < -0.05) l.txa /= 1.7;
      if (l.tya > 0.05 || l.tya < -0.05) l.tya /= 1.7;
    }
    if (config.rotate || config.scale || config.translate) {
      lensmatrix(l);
    }
  }

  // The two fixed-point affine steps (STEPX/STEPY macros). floor(.../1024)
  // matches the C's >>10 arithmetic shift for both positive and negative x2.
  function stepx(l, x, y) {
    return Math.floor((l.ua * x + l.ub * y + l.utx) / 1024);
  }
  function stepy(l, x, y) {
    return Math.floor((l.uc * x + l.ud * y + l.uty) / 1024);
  }

  // Plot a point given in 256ths of a pixel (sp()). Out-of-range points are
  // dropped (this is also the divergence guard); each pixel is drawn at most
  // once per frame via the bit board, then painted as a pscale-sized dot.
  function sp(x, y, color) {
    if (x < 0 || x >= width8 || y < 0 || y >= height8) return;
    x = x >> 8;
    y = y >> 8;
    const idx = y * W + x;
    if (board[idx]) return;
    board[idx] = 1;
    // paint a pscale x pscale dot (clamped to the canvas).
    for (let dy = 0; dy < pscale; dy++) {
      const yy = y + dy;
      if (yy >= H) break;
      const row = yy * W;
      for (let dx = 0; dx < pscale; dx++) {
        const xx = x + dx;
        if (xx >= W) break;
        pixels[row + xx] = color;
      }
    }
  }

  // Run the chaos game (iterate()): from the centre point, pick a random lens
  // `count` times, dropping the first 10 (burn-in), plotting each later point.
  // When p > 0 (multi mode) one extra fixed lens transform is applied before
  // plotting, which fans the per-lens passes out into distinct sub-clouds.
  function iterate(count, p) {
    let x = px;
    let y = py;
    let i;
    for (i = 0; i < 10; i++) {
      const l = lenses[(Math.random() * lensnum) | 0];
      const tx = stepx(l, x, y);
      y = stepy(l, x, y);
      x = tx;
    }
    const color = palette[p === 0 ? ccolour : ((ccolour * (p + 1)) % palette.length)];
    for (; i < count; i++) {
      const l = lenses[(Math.random() * lensnum) | 0];
      const tx = stepx(l, x, y);
      y = stepy(l, x, y);
      x = tx;
      if (p === 0) {
        sp(x, y, color);
      } else {
        const lp = lenses[p];
        sp(stepx(lp, x, y), stepy(lp, x, y), color);
      }
    }
    px = x;
    py = y;
  }

  // One frame of ifs_draw(): clear, advance the colour, iterate per lens (multi
  // mode), then morph every lens for next frame. `multi` is on by default in
  // the C, so we always run the per-lens (multi) loop; each lens i gets its own
  // colour and the extra p=i transform.
  function step() {
    // erase the whole accumulation buffer + dedupe board for this frame.
    pixels.fill(BLACK);
    board.fill(0);

    ccolour = (ccolour + 1) % palette.length;

    // chaos game starts from the centre, in 256ths of a pixel (width<<7).
    px = (W * 128) | 0;
    py = (H * 128) | 0;

    // points per pass = functions^(detail-1); guard the budget so a high
    // "Detail" on a small machine can't lock the tab (the C trusts the user).
    let count = Math.pow(lensnum, length - 1);
    if (!isFinite(count) || count < 1) count = 1;
    count = Math.min(count, 4000000);

    for (let i = 0; i < lensnum; i++) {
      iterate(count, i);
    }

    ctx.putImageData(imageData, 0, 0);

    for (let i = 0; i < lensnum; i++) {
      mutate(lenses[i]);
    }
  }

  function seedLenses() {
    lenses = [];
    for (let i = 0; i < lensnum; i++) {
      lenses.push(createLens(
        myrandom(1) - 0.5,
        myrandom(1),
        myrandom(4) - 2,
        myrandom(4) + 2,
      ));
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    width8 = W << 8;
    height8 = H << 8;

    // C bumps the dot size on very large (retina) displays (spacing unchanged).
    pscale = (W > 2560 || H > 2560) ? 3 : 1;

    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);
    board = new Uint8Array(W * H);

    lensnum = Math.max(2, Math.round(config.functions));
    length = Math.max(0, Math.round(config.detail));

    buildPalette();
    ccolour = 0;
    seedLenses();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag accumulator paced by config.delay (µs), with a catch-up cap so a
  // backgrounded tab doesn't fire a burst of frames on refocus.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = config.delay / 1000;   // xml units are microseconds
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (clears the buffer because functions/detail/
  // colors resize the lens set, point budget and palette).
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
