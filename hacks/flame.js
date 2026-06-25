// flame.js — flame packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's flame.c (Scott Draves, 1993; from Patrick J. Naughton's
// 1991 xlock hack, ported to xscreensaver by jwz). https://www.jwz.org/xscreensaver/
//
// Recursive fractal "cosmic flames": an iterated nonlinear function system.
// Each frame builds a fresh set of 2..4 affine transforms with random
// coefficients, some of them wrapped in one of ten nonlinear "variations"
// (sinusoidal, swirl, horseshoe, spherical, ...). recurse() composes those
// transforms `iterations` deep and plots the leaf points that land inside the
// [-1,1] square, mapped to the screen — up to `points` plots before it bails.
// Successive frames overlay new fractals (the colour cycling through a palette)
// onto the same image, so the figure grows and shifts; every `iterations`
// frames the variation flips/changes, the image lingers (delay2), then clears
// and a new flame begins.
//
// Rendering: thousands of points per frame, heavily overlapping along the
// attractor, so the BLIT path with a twist — instead of single-colour plots we
// accumulate point hits ADDITIVELY into a persistent Uint32 ImageData buffer
// (each hit adds a fraction of the current frame's colour, clamped to white).
// Dense regions saturate to white-hot while the sparse filaments stay dim and
// hued, which is what gives the glowing "flame" look. putImageData once/frame.
// (See [[hopalong]] / [[thornbird]] for the plain single-colour blit idiom.)

export const title = 'flame';

export const info = {
  author: 'Scott Draves',
  description: 'Iterative fractals.',
  year: 1993,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/flame.xml so the config box maps 1:1 to
  // the original.
  //   delay   — \u00B5s between frames while a flame builds.
  //   delay2  — \u00B5s to LINGER on a finished flame before it clears ("Linger").
  //   iterations — recursion depth AND frames per flame before reset+clear
  //                (the xml labels it "Number of fractals").
  //   points  — max leaf points plotted per frame ("Complexity").
  //   ncolors — size of the hue palette the frame colour cycles through.
  const config = {
    delay: 40000,      // \u00B5s between frames (xml default 50000; calmer-by-feel 40000)
    delay2: 2000000,   // \u00B5s to linger on a finished flame (--delay2)
    iterations: 25,    // recursion depth / frames per flame (--iterations)
    points: 10000,     // max points plotted per frame (--points)
    ncolors: 96,       // hue-palette size (--colors; xml default 64, a touch more)
  };

  // live: true  -> the loop reads config[key] every frame, applies instantly.
  // live: false -> sizes the palette, so a change re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 40000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'delay2', label: 'Linger', type: 'range', min: 0, max: 10000000, step: 100000, default: 2000000, unit: ' \u00B5s', lowLabel: 'brief', highLabel: 'long', live: true },
    { key: 'iterations', label: 'Number of fractals', type: 'range', min: 1, max: 250, step: 1, default: 25, lowLabel: 'few', highLabel: 'many', live: true },
    { key: 'points', label: 'Complexity', type: 'range', min: 100, max: 80000, step: 100, default: 10000, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 96, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  const MAXLEV = 4;       // max functions per frame (C: MAXLEV)
  const MAXKINDS = 10;    // number of nonlinear variations (C: MAXKINDS)
  const BLACK = 0xFF000000;

  let W, H, S;            // canvas size (device px) and devicePixelRatio
  let imageData, pixels;  // persistent Uint32 accumulation buffer (additive)
  let palette;            // ncolors packed-ABGR rainbow values

  // f[2][3][MAXLEV]: three non-homogeneous transforms per function — [out][term].
  let f;
  let scale;             // point size in device px (1, or 2 on retina)
  let variation;         // which nonlinear variation (0..MAXKINDS-1)
  let snum;              // number of functions this frame (2..MAXLEV)
  let anum;             // how many of them use the nonlinear variation
  let curLevel;          // frame counter (drives reset + colour cycle)
  let flameAlt;          // toggles "alternate" (anum = 0) frames
  let doReset;           // clear the buffer at the top of the next frame
  let pixcol;            // current palette index (cycles down each frame)
  let totalPoints;       // leaf points emitted this frame (bounds the recursion)
  let maxTotal;          // == config.points for this frame
  let maxLevels;         // == config.iterations for this frame (recursion depth)

  // The C's halfrandom(): reuse the high 16 bits of a 31-bit random() as a cheap
  // second draw. Faithfully reproduced — it shifts anum's distribution slightly.
  let lasthalf = 0;
  function random31() {
    return (Math.random() * 0x80000000) | 0;   // 31-bit non-negative int
  }
  function halfrandom(mv) {
    let r;
    if (lasthalf) {
      r = lasthalf;
      lasthalf = 0;
    } else {
      r = random31();
      lasthalf = r >> 16;
    }
    return r % mv;
  }

  // hsl (h in [0,1)) -> packed little-endian 0xFFBBGGRR, matching ImageData.
  function hslToUint(h, s, l) {
    const c2 = (1 - Math.abs(2 * l - 1)) * s;
    const x = c2 * (1 - Math.abs(((h * 6) % 2) - 1));
    const m = l - c2 / 2;
    let r = 0, g = 0, b = 0;
    const seg = Math.floor(h * 6) % 6;
    if (seg === 0) { r = c2; g = x; }
    else if (seg === 1) { r = x; g = c2; }
    else if (seg === 2) { g = c2; b = x; }
    else if (seg === 3) { g = x; b = c2; }
    else if (seg === 4) { r = x; b = c2; }
    else { r = c2; b = x; }
    const R = Math.round((r + m) * 255);
    const G = Math.round((g + m) * 255);
    const B = Math.round((b + m) * 255);
    return ((0xff << 24) | (B << 16) | (G << 8) | R) >>> 0;
  }

  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    palette = new Uint32Array(n);
    // Mid-lightness so additive accumulation has room to brighten toward white.
    for (let p = 0; p < n; p++) palette[p] = hslToUint(p / n, 1, 0.55);
  }

  // Additive plot: add a fraction of the current frame's colour at (px,py),
  // clamping each channel at 255 so overlaps glow toward white-hot. `scale`-sized
  // block so points stay visible (and bigger on retina).
  let addR = 0, addG = 0, addB = 0;   // this frame's per-hit increment
  function plot(px, py) {
    for (let dy = 0; dy < scale; dy++) {
      const yy = py + dy;
      if (yy < 0 || yy >= H) continue;
      const rowBase = yy * W;
      for (let dx = 0; dx < scale; dx++) {
        const xx = px + dx;
        if (xx < 0 || xx >= W) continue;
        const idx = rowBase + xx;
        const c = pixels[idx];
        let r = (c & 0xff) + addR;
        let g = ((c >> 8) & 0xff) + addG;
        let b = ((c >> 16) & 0xff) + addB;
        if (r > 255) r = 255;
        if (g > 255) g = 255;
        if (b > 255) b = 255;
        pixels[idx] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
  }

  // recurse(x, y, l): compose the `snum` transforms `maxLevels` deep, plotting
  // the leaf points that fall in [-1,1]^2. Returns 0 once `maxTotal` points have
  // been emitted (which unwinds the whole recursion and ends the frame) — this
  // is the bound that guarantees termination even if the map diverges to NaN/Inf
  // (NaN comparisons are false, so divergent leaves simply don't plot, but they
  // still tick totalPoints, so we always reach maxTotal and stop).
  function recurse(x, y, l) {
    if (l === maxLevels) {
      totalPoints++;
      if (totalPoints > maxTotal) return 0;   // how long each fractal runs

      if (x > -1.0 && x < 1.0 && y > -1.0 && y < 1.0) {
        const px = ((W / 2) * (x + 1.0)) | 0;
        const py = ((H / 2) * (y + 1.0)) | 0;
        plot(px, py);
      }
      return 1;
    }

    for (let i = 0; i < snum; i++) {
      // Scale back when values get very large (C: "non-IEEE machines throw an
      // exception instead of a silent NaN"). Keeps the iteration finite.
      if (Math.abs(x) > 1.0e5 || Math.abs(y) > 1.0e5) x = x / y;

      let nx = f[0][0][i] * x + f[0][1][i] * y + f[0][2][i];
      let ny = f[1][0][i] * x + f[1][1][i] * y + f[1][2][i];

      if (i < anum) {
        switch (variation) {
          case 0:   // sinusoidal
            nx = Math.sin(nx);
            ny = Math.sin(ny);
            break;
          case 1: { // complex
            const r2 = nx * nx + ny * ny + 1e-6;
            nx = nx / r2;
            ny = ny / r2;
            break;
          }
          case 2:   // bent
            if (nx < 0.0) nx = nx * 2.0;
            if (ny < 0.0) ny = ny / 2.0;
            break;
          case 3: { // swirl
            const r = (nx * nx + ny * ny);   // times k here is fun
            const c1 = Math.sin(r);
            const c2 = Math.cos(r);
            const t = nx;
            if (nx > 1e4 || nx < -1e4 || ny > 1e4 || ny < -1e4) ny = 1e4;
            else ny = c2 * t + c1 * ny;
            nx = c1 * nx - c2 * ny;
            break;
          }
          case 4: { // horseshoe
            // Avoid atan2 DOMAIN error at the origin.
            const r = (nx === 0.0 && ny === 0.0) ? 0.0 : Math.atan2(nx, ny);
            const c1 = Math.sin(r);
            const c2 = Math.cos(r);
            const t = nx;
            nx = c1 * nx - c2 * ny;
            ny = c2 * t + c1 * ny;
            break;
          }
          case 5: { // drape
            const t = (nx === 0.0 && ny === 0.0) ? 0.0 : Math.atan2(nx, ny) / Math.PI;
            if (nx > 1e4 || nx < -1e4 || ny > 1e4 || ny < -1e4) ny = 1e4;
            else ny = Math.sqrt(nx * nx + ny * ny) - 1.0;
            nx = t;
            break;
          }
          case 6:   // broken
            if (nx > 1.0) nx = nx - 1.0;
            if (nx < -1.0) nx = nx + 1.0;
            if (ny > 1.0) ny = ny - 1.0;
            if (ny < -1.0) ny = ny + 1.0;
            break;
          case 7: { // spherical
            const r = 0.5 + Math.sqrt(nx * nx + ny * ny + 1e-6);
            nx = nx / r;
            ny = ny / r;
            break;
          }
          case 8:   // arctangent
            nx = Math.atan(nx) / Math.PI * 2;   // C: atan(nx) / M_PI_2
            ny = Math.atan(ny) / Math.PI * 2;
            break;
          case 9: { // complex sine
            const u = nx;
            const v = ny;
            const ev = Math.exp(v);
            const emv = Math.exp(-v);
            nx = (ev + emv) * Math.sin(u) / 2.0;
            ny = (ev - emv) * Math.cos(u) / 2.0;
            break;
          }
          default:
            nx = Math.sin(nx);
            ny = Math.sin(ny);
        }
      }

      if (!recurse(nx, ny, l + 1)) return 0;
    }
    return 1;
  }

  // One frame == one flame_draw: maybe clear (from last frame's reset), advance
  // the flame/colour state, randomize the transforms, recurse from (0,0). Returns
  // the ms to wait before the next step — config.delay normally, or config.delay2
  // (the linger) on a frame that finished a flame and is about to clear.
  function step() {
    if (doReset) {
      doReset = false;
      pixels.fill(BLACK);
    }

    maxLevels = Math.max(1, Math.round(config.iterations));
    maxTotal = Math.max(1, Math.round(config.points));

    let thisDelay = config.delay;

    // Every maxLevels frames: flip alt, pick a new variation, linger, then clear
    // next frame. (C: post-increment, so frame 0 is a reset frame.)
    if (curLevel % maxLevels === 0) {
      curLevel++;
      doReset = true;
      thisDelay = config.delay2;
      flameAlt = !flameAlt;
      variation = random31() % MAXKINDS;
    } else {
      curLevel++;
      if (palette.length > 2) {
        if (--pixcol < 0) pixcol = palette.length - 1;
      }
    }

    // This frame's additive colour increment, derived from the cycling palette.
    // ~1/6 of a mid-bright colour per hit: a handful of overlaps reach full.
    const col = palette[pixcol % palette.length];
    addR = Math.max(1, ((col & 0xff)) / 6) | 0;
    addG = Math.max(1, (((col >> 8) & 0xff)) / 6) | 0;
    addB = Math.max(1, (((col >> 16) & 0xff)) / 6) | 0;

    // Number of functions this frame (2..MAXLEV).
    snum = 2 + (curLevel % (MAXLEV - 1));

    // How many of them are the nonlinear (alternate) form.
    anum = flameAlt ? 0 : halfrandom(snum) + 2;

    // 6 coefficients per function, each in [-1, 1) (C: (random()&1023)/512 - 1).
    for (let k = 0; k < snum; k++) {
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 3; j++) {
          f[i][j][k] = (random31() & 1023) / 512.0 - 1.0;
        }
      }
    }

    totalPoints = 0;
    recurse(0.0, 0.0, 0);

    ctx.putImageData(imageData, 0, 0);
    return Math.max(0, thisDelay / 1000);   // \u00B5s -> ms until next step
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // C bumps the point size on very large (retina) displays.
    scale = (W > 2560 || H > 2560) ? 2 : 1;

    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    buildPalette();

    // f[2][3][MAXLEV], zero-initialised.
    f = [
      [new Float64Array(MAXLEV), new Float64Array(MAXLEV), new Float64Array(MAXLEV)],
      [new Float64Array(MAXLEV), new Float64Array(MAXLEV), new Float64Array(MAXLEV)],
    ];

    variation = random31() % MAXKINDS;
    pixcol = halfrandom(Math.max(1, palette.length));
    curLevel = 0;
    flameAlt = false;
    doReset = false;
    lasthalf = 0;
    totalPoints = 0;
    snum = 2;
    anum = 0;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Variable-delay loop (boxfit/xspirograph-style): step() returns the ms to wait
  // before the next step — config.delay normally, or config.delay2 (the linger)
  // on a frame that just finished a flame. The buffer persists between steps
  // (fractals accumulate), so drawing happens inside step().
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let acc = 0;
  let nextDelay = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    acc += now - lastTime;
    lastTime = now;
    // Bound the backlog so a backgrounded tab doesn't burst on refocus — but
    // never below nextDelay, or a long linger pause would never elapse.
    acc = Math.min(acc, nextDelay + 1000);

    let steps = 0;
    while (acc >= nextDelay && steps < MAX_CATCHUP_STEPS) {
      acc -= nextDelay;
      nextDelay = step();
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (clears the accumulation buffer because
  // ncolors resizes the palette).
  function reinit() {
    nextDelay = 0;
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
