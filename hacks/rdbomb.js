// rdbomb.js — rdbomb (RD-Bomb) packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's rdbomb.c (Scott Draves, 1997; framework by Jamie
// Zawinski). https://www.jwz.org/xscreensaver/
//
// A reaction-diffusion texture (the Gray-Scott / John E. Pearson "Complex
// Patterns in a Simple System" model). Two chemical fields r1 (substrate) and
// r2 (activator) sit on a toroidal grid; every step each cell diffuses toward
// its 4-neighbours and the two chemicals react (r1 is fed back toward its max
// while being consumed by r2; r2 grows where the r1*r2*r2 reaction term is high
// and decays elsewhere). The result is growing square-ish blobs that collide
// and "react in unpredictable ways". r1 is mapped through a cycling colourmap.
// Periodically ("epoch") the field is re-seeded — reset to equilibrium, a small
// random square blob of activator dropped in the centre ("bombed"), and the
// reaction/diffusion variant + palette re-rolled.
//
// Rendering: this is a dense per-pixel field. Faithful to the C, the field is
// computed on a SMALL toroidal tile (the C's ~64..575 px, capped to MAX_CELLS
// for perf) into a Uint32 ImageData, then TILED 1:1 across the device-res canvas
// (ctx.drawImage at native size, imageSmoothingEnabled = false). The toroidal
// wrap makes the tile seamless, so the default look is a crisp REPEATING
// wallpaper of the RD motif — exactly the C's tiling loop, not one stretched
// blob. See [[squiral]] for the shared skeleton.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'rdbomb';

export const info = {
  author: 'Scott Draves',
  description: 'Reaction-diffusion: draws a grid of growing square-like shapes that, once they overtake each other, react in unpredictable ways.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/rdbomb.xml so the config box maps to the
  // original. delay is microseconds (xml units). `epoch` is counted in reaction
  // sub-steps, exactly like the C's frame counter (eased from the xml's 40000 to
  // a livelier 10000 so a re-bomb is seen in a minute or two — see rdbomb.md).
  // `reaction`/`diffusion`/`radius` use -1 = "Auto" (re-rolled each epoch), as
  // the C does. The xml's explicit tile-size / wander knobs (width, height,
  // size, speed) are omitted — the tile size is rolled like the C and repeated
  // across the screen (size=1.0 / speed=0.0 defaults: full screen, no wander;
  // see rdbomb.md).
  const config = {
    delay: 30000,     // µs between frames (--delay)
    epoch: 10000,     // reaction sub-steps before re-seeding the field (--epoch)
    radius: -1,       // seed-blob radius in grid cells; -1 = random (--radius)
    reaction: -1,     // reaction variant 0..2; -1 = random each epoch (--reaction)
    diffusion: -1,    // diffusion variant 0..2; -1 = random each epoch (--diffusion)
    ncolors: 255,     // size of the cycling colourmap (--ncolors)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 250000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'epoch', label: 'Epoch', type: 'range', min: 1000, max: 300000, step: 1000, default: 10000, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'radius', label: 'Seed radius', type: 'range', min: -1, max: 60, step: 1, default: -1, lowLabel: 'auto', highLabel: 'big', live: true },
    {
      key: 'reaction',
      label: 'Reaction',
      type: 'select',
      options: [
        { value: -1, label: 'Auto' },
        { value: 0, label: '0' },
        { value: 1, label: '1' },
        { value: 2, label: '2' },
      ],
      default: -1,
      live: false,
    },
    {
      key: 'diffusion',
      label: 'Diffusion',
      type: 'select',
      options: [
        { value: -1, label: 'Auto' },
        { value: 0, label: '0' },
        { value: 1, label: '1' },
        { value: 2, label: '2' },
      ],
      default: -1,
      live: false,
    },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 255, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  const BLACK = 0xFF000000;       // opaque black, little-endian 0xAABBGGRR
  const MX = (1 << 16) - 1;       // 65535 — the C's `mx`, the field's max value

  // Cap the RD tile so the per-frame field work is bounded on ANY display (3
  // reaction sub-steps over this many cells). The C's own tile is small
  // (~64..575 px) and repeated across the screen; we do the same, capping the
  // upper end of its size distribution for perf. This is <= the old single-grid
  // compute, so the tiling change is free.
  const MAX_CELLS = 65000;
  const SUBSTEPS = 3;             // reaction sub-steps per displayed frame (C: chunk=3)

  let gw, gh;                     // RD tile size (device px, capped) — tiled across the screen
  let w2;                         // padded row stride (gw + 2)
  let a1, a2;                     // current (read) chemical fields, padded, Uint16
  let b1, b2;                     // next (write) chemical fields, padded, Uint16
  let frame;                      // reaction-step counter (drives the epoch re-bomb)
  let reaction, diffusion;        // active variants (re-rolled each epoch when Auto)

  let scratch, sctx;              // offscreen tile canvas, tiled across the main canvas
  let imageData, pixels;          // Uint32 view over the tile-sized ImageData
  let ncolors;                    // captured colour count (2..255)
  let palette;                    // Uint32Array(ncolors) cycling colourmap
  let mc;                         // dither LUT: 16-bit field value -> 8-bit colour index

  // The C's `R` macro: a 30-bit non-negative random int.
  function R() {
    return (Math.random() * 0x40000000) | 0;
  }

  // The C's BELLRAND(x): average of three uniform draws -> a bell curve in [0,x).
  function bellrand(x) {
    return (((R() % x) + (R() % x) + (R() % x)) / 3) | 0;
  }

  // Pack r,g,b (0-255) as 0xFFBBGGRR for ImageData's little-endian RGBA layout.
  function packRGB(r, g, b) {
    return (0xff << 24 | b << 16 | g << 8 | r) >>> 0;
  }

  // The C calls make_smooth_colormap (a random, frequently muted/pastel HSV loop)
  // via random_colors() inside the epoch branch — i.e. RE-ROLLED on every re-bomb.
  // We match that cadence (buildPalette is called from rebomb()) using the
  // faithful makeSmoothColormapRGB port (colormap.js). It returns [r,g,b] 0..255
  // triplets; pack each into the Uint32 view update() blits.
  function buildPalette() {
    palette = new Uint32Array(ncolors);
    const map = makeSmoothColormapRGB(ncolors);
    for (let i = 0; i < ncolors; i++) {
      const [r, g, b] = map[i];
      palette[i] = packRGB(r, g, b);
    }
  }

  // Re-seed the field (the C's epoch branch in pixack_frame): reset both fields
  // to equilibrium, re-roll the palette, choose the reaction/diffusion variants
  // and seed radius (-1 => random, like the C), then drop a small random square
  // blob of activator (r2) in the centre.
  function rebomb() {
    a1.fill(65500);   // r1 substrate equilibrium
    a2.fill(11);      // r2 activator equilibrium

    buildPalette();

    reaction = config.reaction;
    if (reaction < 0 || reaction > 2) reaction = R() & 1;          // auto: 0 or 1 only

    diffusion = config.diffusion;
    if (diffusion < 0 || diffusion > 2) {
      diffusion = (R() % 5) ? ((R() % 3) ? 0 : 1) : 2;            // auto: ~0/1, sometimes 2
    }
    if (reaction === 2 && diffusion === 2) reaction = diffusion = 0;

    const maxr = Math.max(1, Math.min((gw >> 1) - 2, (gh >> 1) - 2));
    let radius = config.radius;
    if (radius < 0) radius = 1 + ((R() % 10) ? (R() % 5) : (R() % maxr));
    if (radius > maxr) radius = maxr;
    if (radius < 0) radius = 0;

    const s = w2 * (gh >> 1) + (gw >> 1);   // centre cell index in the padded buffer
    for (let i = -radius; i <= radius; i++) {
      for (let j = -radius; j <= radius; j++) {
        a2[s + i + j * w2] = MX - (R() & 63);
      }
    }
  }

  // Toroidal wrap: copy the interior edges into the 1-cell border so the
  // Laplacian reads neighbours that wrap around (the C does this every step).
  function edgeWrap() {
    for (let i = 0; i <= gw + 1; i++) {
      a1[i] = a1[i + w2 * gh];                 // top border  <- last interior row
      a2[i] = a2[i + w2 * gh];
      a1[i + w2 * (gh + 1)] = a1[i + w2];      // bottom border <- first interior row
      a2[i + w2 * (gh + 1)] = a2[i + w2];
    }
    for (let i = 0; i <= gh + 1; i++) {
      a1[w2 * i] = a1[gw + w2 * i];            // left border  <- last interior col
      a2[w2 * i] = a2[gw + w2 * i];
      a1[w2 * i + gw + 1] = a1[w2 * i + 1];    // right border <- first interior col
      a2[w2 * i + gw + 1] = a2[w2 * i + 1];
    }
  }

  // One reaction-diffusion sub-step (the C's pixack_frame inner loops): read the
  // previous field from a1/a2, write the new field into b1/b2 (double buffering
  // so the Laplacian reads a coherent previous state), then swap. The arithmetic
  // is the C's verbatim — every intermediate stays under 2^31, so the bit-shifts
  // match the C exactly (see rdbomb.md, "Correctness self-review"). On the final
  // sub-step of a frame, also map r1 through the dither LUT + palette into the
  // pixel buffer (the C's default truecolor path: colors[mc[r1] % ncolors]).
  function update(writePixels) {
    for (let i = 0; i < gh; i++) {
      const base = w2 * (i + 1) + 1;          // index of (interior row i, col 0)
      const prow = i * gw;
      for (let j = 0; j < gw; j++) {
        const idx = base + j;
        const c1 = a1[idx], r1r = a1[idx + 1], l1 = a1[idx - 1], d1 = a1[idx + w2], u1 = a1[idx - w2];
        const c2 = a2[idx], r2r = a2[idx + 1], l2 = a2[idx - 1], d2 = a2[idx + w2], u2 = a2[idx - w2];

        let r1 = 0, r2 = 0;
        switch (diffusion) {
          case 0:
            r1 = ((c1 + r1r + l1 + d1 + u1) / 5) | 0;
            r2 = (((c2 << 3) + r2r + l2 + d2 + u2) / 12) | 0;
            break;
          case 1:
            r1 = (r1r + l1 + d1 + u1) >> 2;
            r2 = ((c2 << 2) + r2r + l2 + d2 + u2) >> 3;
            break;
          case 2:
            r1 = ((c1 << 1) + (r1r << 1) + (l1 << 1) + d1 + u1) >> 3;
            r2 = ((c2 << 2) + r2r + l2 + d2 + u2) >> 3;
            break;
        }

        // Pearson reaction term ~ r1*r2*r2; the C shifts r1 right by 1 first to
        // keep the products inside signed 32-bit, so we do the same.
        const uvv = ((((r1 >> 1) * r2) >> 16) * r2) >> 15;
        switch (reaction) {
          case 0:
            r1 += 4 * (((28 * (MX - r1)) >> 10) - uvv);
            r2 += 4 * (uvv - ((80 * r2) >> 10));
            break;
          case 1:
            r1 += 3 * (((27 * (MX - r1)) >> 10) - uvv);
            r2 += 3 * (uvv - ((80 * r2) >> 10));
            break;
          case 2:
            r1 += 2 * (((28 * (MX - r1)) >> 10) - uvv);
            r2 += 3 * (uvv - ((80 * r2) >> 10));
            break;
        }

        if (r1 > MX) r1 = MX; else if (r1 < 0) r1 = 0;
        if (r2 > MX) r2 = MX; else if (r2 < 0) r2 = 0;
        b1[idx] = r1;
        b2[idx] = r2;

        if (writePixels) pixels[prow + j] = palette[mc[r1] % ncolors];
      }
    }

    let t = a1; a1 = b1; b1 = t;
    t = a2; a2 = b2; b2 = t;
  }

  // One displayed frame: SUBSTEPS reaction sub-steps (re-bombing at each epoch
  // boundary, exactly as the C tests frame % epoch == 0 at the top of each
  // sub-step), then tile the small field across the device-res canvas.
  function step() {
    const epoch = Math.max(1, Math.round(config.epoch));
    for (let sub = 0; sub < SUBSTEPS; sub++) {
      if (frame % epoch === 0) rebomb();
      edgeWrap();
      update(sub === SUBSTEPS - 1);
      frame++;
    }
    sctx.putImageData(imageData, 0, 0);
    // Tile the small RD field across the screen at 1:1 native pixels — the C's
    // tiling loop (for i += width, for j += height). The toroidal field is
    // seamless, so this is a crisp repeating wallpaper, never a stretched blob.
    for (let ty = 0; ty < canvas.height; ty += gh) {
      for (let tx = 0; tx < canvas.width; tx += gw) {
        ctx.drawImage(scratch, tx, ty);
      }
    }
  }

  function init() {
    // RD tile size, exactly the C's pixack_init: the width/height resources
    // default to 0, so with 50% probability the tile is square
    // (gw = gh = 64 + BELLRAND(512)), else each side is rolled independently —
    // range ~64..575 px. Clamp to the screen, then cap to MAX_CELLS for perf.
    // Worked in DEVICE pixels because we tile 1:1 native pixels. Rolled once per
    // init (the C rolls it once in rd_init); the toroidal field makes the tile
    // seamless when repeated.
    const screenW = canvas.width;
    const screenH = canvas.height;
    let tw = 0, th = 0;
    if (tw <= 0 && th <= 0 && (R() & 1)) tw = th = 64 + bellrand(512);
    if (tw <= 0) tw = 64 + bellrand(512);
    if (th <= 0) th = 64 + bellrand(512);
    if (tw > screenW) tw = screenW;
    if (th > screenH) th = screenH;
    if (tw < 10) tw = 10;
    if (th < 10) th = 10;
    if (tw * th > MAX_CELLS) {
      const f = Math.sqrt((tw * th) / MAX_CELLS);
      tw = Math.max(10, Math.floor(tw / f));
      th = Math.max(10, Math.floor(th / f));
    }
    gw = tw;
    gh = th;
    w2 = gw + 2;

    const npix = w2 * (gh + 2);
    a1 = new Uint16Array(npix);
    a2 = new Uint16Array(npix);
    b1 = new Uint16Array(npix);
    b2 = new Uint16Array(npix);

    ncolors = Math.max(2, Math.min(255, Math.round(config.ncolors)));

    // The C's dither LUT (mc), built once in rd_init: maps a 16-bit field value
    // to an 8-bit colour index with a per-value random offset, so colour-band
    // boundaries are dithered rather than hard-stepped. The default truecolor
    // path indexes through this (dither_when_mapped = 1 in the C), so we do too.
    mc = new Uint8Array(1 << 16);
    for (let i = 0; i < (1 << 16); i++) {
      let di = (i + (R() & 255)) >> 8;
      if (di > 255) di = 255;
      mc[i] = di;
    }

    scratch = document.createElement('canvas');
    scratch.width = gw;
    scratch.height = gh;
    sctx = scratch.getContext('2d');
    imageData = sctx.createImageData(gw, gh);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    // 1:1 native-pixel tiling: in step() the tile is drawn at its native size
    // (source size == dest size), so there is no interpolation; disable smoothing
    // defensively too (setting canvas.width in resize() resets it to true).
    ctx.imageSmoothingEnabled = false;

    // frame 0 -> the first sub-step of the first step() re-bombs (which fills the
    // fields + builds the palette), so the screen seeds itself on frame one.
    frame = 0;

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

  // Drive off requestAnimationFrame but keep the original pace: one step() per
  // config.delay, banking leftover time so the speed is the same at any refresh
  // rate. step() is heavy (3 sub-steps over the whole grid), so the catch-up cap
  // is low — a slow frame should fall behind, not stack up a burst.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // The live rdbomb measures 22.2 fps, but the port at the stock 30000 us ran
  // 33 steps/sec (1.5x fast). 30000 + 15045 = 45045 us -> 22.2 steps/sec,
  // matching the live binary. A calibration, not a tuning knob (the delay
  // slider still maps 1:1 to the xml resource).
  const OVERHEAD = 15045;
  const MAX_CATCHUP_STEPS = 4;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frameLoop(now) {
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

    rafId = requestAnimationFrame(frameLoop);
  }

  // Rebuild after a non-live config change (reaction/diffusion/ncolors resize or
  // re-roll the field/palette). Clears to black and re-seeds via init(); frame=0
  // makes the next step() re-bomb with the new settings.
  function reinit() {
    init();
  }

  window.addEventListener('resize', resize);
  resize();
  rafId = requestAnimationFrame(frameLoop);

  return {
    stop() {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
    },
    pause() { cancelAnimationFrame(rafId); rafId = 0; },
    resume() { if (!rafId) { lastTime = 0; rafId = requestAnimationFrame(frameLoop); } },
    reinit,   // fresh field + palette with the current config
    config,
    params,
  };
}
