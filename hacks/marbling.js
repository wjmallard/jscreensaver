// marbling.js — marbling packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's marbling.c (Jamie Zawinski & Dave Odell, 2021-2022).
// https://www.jwz.org/xscreensaver/
//
// Marble-/cloud-like patterns from Perlin Noise + Fractal Brownian Motion. It is
// NOT a stir/advection ("suminagashi") hack: there is no persistent ink buffer.
// Every frame it PROCEDURALLY recomputes a colour field from 3D Perlin noise,
// where the third axis (Z) is time — so advancing Z each frame morphs the whole
// pattern. The marble striations come from "domain warping": the field is FBM
// iterated `iterations` times, each pass feeding the previous output back into
// the noise input (p = fbm(p+X, p+Y, p+Z)), the classic FBM-of-FBM marble look.
//
// Rendering: this is a dense, every-pixel field, so it uses the BLIT path — one
// noise value per `g`-by-`g` block (g = Magnification, matching the C, which
// computes a reduced grid and replicates each value into a g*g cell), written
// into a Uint32 view over ImageData, then one putImageData per frame. The
// reduced internal grid is what keeps it affordable on the CPU; raising
// Magnification shrinks the grid (faster, blockier), lowering it sharpens
// (slower). See [[squiral]] for the shared skeleton, [[binaryring]] for the
// Uint32 blit idiom, [[demon]] for hslToUint.

export const title = 'marbling';

export const info = {
  author: 'Jamie Zawinski and Dave Odell',
  description: 'Marble-like or cloud-like patterns generated using Perlin Noise and Fractal Brownian Motion.',
  year: 2021,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/marbling.xml so the tuning UI maps 1:1
  // to the original. gridsize = "Magnification" (block size of the reduced
  // grid), scale = "Scale" (how many noise cells span the screen — sparse..dense),
  // iterations = "Complexity" (domain-warp depth). ncolors/hue/zspeed are added
  // for parity with the other ports (the C hardcodes a 256-entry smooth colormap
  // and a fixed Z step of 0.01/frame).
  const config = {
    delay: 16000,     // \u00B5s between frames (--delay; xml default 10000, eased a touch)
    gridsize: 3,      // internal-grid coarseness: small = sharper + slower (--gridsize)
    scale: 10,        // noise cells across the screen: low = sparse, high = dense (--scale)
    iterations: 3,    // domain-warp passes: marble complexity (heaviest cost knob)
    ncolors: 256,     // size of the smooth rainbow colormap
    hue: 200,         // base hue (degrees) the rainbow palette starts from
    zspeed: 0.01,     // Z (time) advance per frame — morph speed (C hardcodes 0.01)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 16000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'gridsize', label: 'Magnification', type: 'range', min: 1, max: 20, step: 1, default: 3, lowLabel: 'sharp', highLabel: 'blocky', live: false },
    { key: 'scale', label: 'Scale', type: 'range', min: 1, max: 20, step: 1, default: 10, lowLabel: 'sparse', highLabel: 'dense', live: true },
    { key: 'iterations', label: 'Complexity', type: 'range', min: 1, max: 10, step: 1, default: 3, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 256, step: 1, default: 256, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'hue', label: 'Base hue', type: 'range', min: 0, max: 360, step: 1, default: 200, lowLabel: 'red', highLabel: 'red', live: false },
    { key: 'zspeed', label: 'Morph speed', type: 'range', min: 0, max: 0.05, step: 0.001, default: 0.01, lowLabel: 'still', highLabel: 'fast', live: true },
  ];

  const BLACK = 0xFF000000;            // opaque black, little-endian 0xAABBGGRR

  let S = 1;                           // devicePixelRatio
  let W, H;                            // canvas size, device px
  let gw, gh;                          // internal-grid dimensions (logical/g, clamped)
  let imageData, pixels;              // Uint32 view over ImageData (grid-sized)
  let scratch, sctx;                  // offscreen grid canvas, upscaled to main
  let palette;                         // Uint32 colormap, ncolors entries
  let z;                               // current Z (time) coordinate

  // --- Perlin "improved noise" permutation table (Ken Perlin, SIGGRAPH 2002) ---
  // The C uses an 8-bit perfect-hash in fixed point; in floats we use the
  // canonical 256-entry permutation, doubled to avoid an index wrap. The pattern
  // is identical in spirit (a fixed pseudo-random gradient hash per lattice cell).
  const PERM = new Uint8Array(512);
  (function buildPerm() {
    const p = [
      151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225,
      140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148,
      247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32,
      57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175,
      74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122,
      60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54,
      65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169,
      200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64,
      52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212,
      207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213,
      119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9,
      129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104,
      218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241,
      81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157,
      184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93,
      222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180,
    ];
    for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
  })();

  function fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  function lerp(t, a, b) {
    return a + t * (b - a);
  }

  // Perlin's gradient hash: lowest 4 bits of the hash select one of 12 gradient
  // directions (matches the C's grad()).
  function grad(hash, x, y, zz) {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : (h === 12 || h === 14 ? x : zz);
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  // Classic 3D improved Perlin noise, output ~[-1, 1].
  function noise(x, y, zz) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(zz) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    zz -= Math.floor(zz);
    const u = fade(x);
    const v = fade(y);
    const w = fade(zz);
    const A = PERM[X] + Y, AA = PERM[A] + Z, AB = PERM[A + 1] + Z;
    const B = PERM[X + 1] + Y, BA = PERM[B] + Z, BB = PERM[B + 1] + Z;
    return lerp(w,
      lerp(v,
        lerp(u, grad(PERM[AA], x, y, zz), grad(PERM[BA], x - 1, y, zz)),
        lerp(u, grad(PERM[AB], x, y - 1, zz), grad(PERM[BB], x - 1, y - 1, zz))),
      lerp(v,
        lerp(u, grad(PERM[AA + 1], x, y, zz - 1), grad(PERM[BA + 1], x - 1, y, zz - 1)),
        lerp(u, grad(PERM[AB + 1], x, y - 1, zz - 1), grad(PERM[BB + 1], x - 1, y - 1, zz - 1))));
  }

  // Fractal Brownian Motion: the C sums octaves=2 octaves, amplitude scaled by
  // G = 2^-0.5 each octave and frequency doubled. Perlin noise is ~[-1, 1]; we
  // bias to ~[0, 1] so the iterated feedback below stays positive and bounded.
  const G = Math.pow(2, -0.5);
  const OCTAVES = 2;
  function fbm(x, y, zz) {
    let t = 0;
    let a = 1;
    let f = 1;
    for (let i = 0; i < OCTAVES; i++) {
      t += a * (noise(f * x, f * y, f * zz) * 0.5 + 0.5);
      a *= G;
      f *= 2;
    }
    return t;
  }

  // Build a smooth, vivid rainbow colormap (the brief prefers this over the C's
  // muted make_smooth_colormap). `hue` rotates the starting colour.
  function buildPalette() {
    const n = Math.max(2, Math.round(config.ncolors));
    palette = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      palette[i] = hslToUint(config.hue + (i * 360 / n), 1, 0.5);
    }
  }

  // HSL (h in degrees, s/l in [0,1]) packed into a little-endian RGBA uint.
  function hslToUint(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs(hp % 2 - 1));
    let rr = 0, gg = 0, bb = 0;
    if (hp < 1)      { rr = c; gg = x; }
    else if (hp < 2) { rr = x; gg = c; }
    else if (hp < 3) { gg = c; bb = x; }
    else if (hp < 4) { gg = x; bb = c; }
    else if (hp < 5) { rr = x; bb = c; }
    else             { rr = c; bb = x; }
    const m = l - c / 2;
    const R = Math.round((rr + m) * 255);
    const G = Math.round((gg + m) * 255);
    const B = Math.round((bb + m) * 255);
    return ((255 << 24) | (B << 16) | (G << 8) | R) >>> 0;
  }

  // Compute one frame of the field into the Uint32 buffer. For each cell of the
  // reduced grid we sample the domain-warped FBM at the current Z, map it onto
  // the colormap, then replicate that colour into the cell's g*g block (so the
  // backing store stays full-resolution while we only do gw*gh noise samples).
  function step() {
    const scale = config.scale;
    const iters = Math.max(1, Math.round(config.iterations));
    const n = palette.length;

    // One noise sample per grid cell, written straight into the grid-sized
    // buffer; the GPU upscale (drawImage below) replaces the old g*g block loop
    // and folds in dpr, so the per-frame noise cost no longer scales with the
    // device resolution (this was a multi-second/frame bug on hi-DPI screens).
    let p = 0;
    for (let gy = 0; gy < gh; gy++) {
      const Y = (gy / gh) * scale;   // noise Y in [0, scale] down the screen
      for (let gx = 0; gx < gw; gx++) {
        const X = (gx / gw) * scale; // noise X in [0, scale] across the screen

        // Domain warp: feed the previous FBM output back into the input. q grows
        // beyond [0,1]; only its fractional part selects a colour, which is what
        // produces the repeated marble striations (mirrors the C's loop and its
        // low-byte palette index `(p & 0xff) * ncolors >> 8`).
        let q = 0;
        for (let i = 0; i < iters; i++) {
          q = fbm(q + X, q + Y, q + z);
        }

        let idx = Math.floor((q - Math.floor(q)) * n);
        if (idx < 0) idx += n;
        if (idx >= n) idx -= n;
        pixels[p++] = palette[idx];
      }
    }

    // Blit the small grid, then upscale (bilinear) to the full backing store.
    sctx.putImageData(imageData, 0, 0);
    ctx.drawImage(scratch, 0, 0, gw, gh, 0, 0, W, H);

    // Advance time. The C does st->Z += 0.01 (0.01 * 256 in 8-bit fixed point).
    z += config.zspeed;
  }

  // Cap the internal grid so per-frame noise work is bounded on ANY display
  // (this domain-warped FBM is the heaviest hack in the gallery; without a cap a
  // 5K screen ran multiple seconds per frame). The grid upscales with bilinear
  // smoothing, which suits the soft marble look.
  const MAX_CELLS = 60000;

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    const g = Math.max(1, Math.round(config.gridsize));
    // Internal field at LOGICAL resolution / gridsize (NOT device px), so retina
    // doesn't multiply the noise cost; the canvas upscales it (metaballs idiom).
    gw = Math.max(1, Math.ceil((W / S) / g));
    gh = Math.max(1, Math.ceil((H / S) / g));
    // Hard cap on total cells -> a predictable frame budget on huge displays.
    if (gw * gh > MAX_CELLS) {
      const f = Math.sqrt((gw * gh) / MAX_CELLS);
      gw = Math.max(1, Math.floor(gw / f));
      gh = Math.max(1, Math.floor(gh / f));
    }
    scratch = document.createElement('canvas');
    scratch.width = gw;
    scratch.height = gh;
    sctx = scratch.getContext('2d');
    imageData = sctx.createImageData(gw, gh);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);
    z = 0;
    buildPalette();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Drive off requestAnimationFrame but keep the original pace: one step() per
  // config.delay, banking leftover time so the speed is the same at any refresh
  // rate. Cap catch-up so a backgrounded tab doesn't fire a burst on refocus.
  const MAX_CATCHUP_STEPS = 4;
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
    // which would otherwise spin forever since lag never drops below 0. step()
    // is heavy, so the cap is low — a slow frame should fall behind, not stack.
    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Rebuild after a non-live config change (gridsize/colors/hue resize the grid
  // or palette). Clears to black and re-seeds via init(), keeping config.
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
    reinit,   // fresh field + palette with the current config
    config,
    params,
  };
}
