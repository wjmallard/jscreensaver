// moire.js — moire packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's moire.c (Jamie Zawinski & Michael Bayne, 1997).
// https://www.jwz.org/xscreensaver/
//
// Concentric circular sine gratings: for each pixel the C computes the squared
// distance to a centre divided by a random "factor" (ring spacing), then maps
// that value through a colour ramp — i = ((x+xo)^2 + (y+yo)^2) / factor, colour
// = colors[floor(i) % ncolors]. The banded rings plus the colour wrap give the
// moire fringe look. The C draws ONE static pattern, scanned top-to-bottom in
// 20-row XShm chunks, then after `delay` seconds picks a fresh random centre and
// redraws from scratch.
//
// Here we keep the grating math verbatim and the C's behaviour: paint ONE
// static zone plate per still (the C's row-by-row XShm reveal is collapsed into
// a single repaint), HOLD it for `delay` seconds, then re-seed a fresh random
// centre + ring factor + a fresh random 2-hue colour ramp and repaint. Nothing
// drifts or cycles within a still. A single grating already gives the moire
// (its rings alias against the pixel grid toward the periphery), so `centers`
// defaults to 1 to match the C; 2+ sums gratings for crossing fringe systems.
// See Deviations in moire.md.
//
// Rendering: pure per-pixel field (distance -> palette index), so it uses the
// BLIT path — a Uint32 view over one ImageData, write every pixel, putImageData
// once per repaint. Cheap enough for the full backing store even on retina. See
// the closest twins [[greynetic]] (per-pixel canvas) and [[binaryring]]
// (Uint32 ImageData blit), and the style reference [[squiral]].

import { makeColorRampRGB } from './colormap.js';

export const title = 'moire';

export const info = {
  author: 'Jamie Zawinski and Michael Bayne',
  description: "When the lines on the screen\nMake more lines in between,\nThat's a moir\u00e9!\n\nhttps://en.wikipedia.org/wiki/Moire_pattern",
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/moire.xml so the config box maps 1:1 to
  // the original: `delay` is the HOLD duration in seconds (the xml's "Duration",
  // 1-60 s, default 5) each still is shown before snapping to a fresh one;
  // `ncolors` the colour-ramp size; `offset` the upper bound of the random
  // ring-spacing factor (xml "Offset", small = tight rings). `centers` is the
  // one port extra: 1 = the C's single static zone plate, 2+ sums gratings for
  // crossing fringe systems — see moire.md.
  const config = {
    delay: 5,         // seconds to HOLD each still before re-seeding (--delay, xml "Duration")
    ncolors: 64,      // size of the colour ramp (--ncolors)
    offset: 50,       // upper bound of the per-centre ring-spacing factor (--offset)
    centers: 1,       // zone plates summed (1 = the C's single static grating; 2+ = fringes)
  };

  const params = [
    { key: 'delay', label: 'Duration', type: 'range', min: 1, max: 60, step: 1, default: 5, unit: ' s', lowLabel: '1 second', highLabel: '1 minute', live: true },
    { key: 'centers', label: 'Gratings', type: 'range', min: 1, max: 5, step: 1, default: 1, lowLabel: 'one', highLabel: 'many', live: false },
    { key: 'offset', label: 'Offset', type: 'range', min: 1, max: 200, step: 1, default: 50, lowLabel: 'tight', highLabel: 'loose', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  let W, H, S;                // canvas size (device px) and devicePixelRatio
  let imageData, pixels;      // the frame buffer: Uint32 view over ImageData
  let palette;                // ncolors packed-ABGR ring colours (a 2-hue ramp)
  let centers;                // [{ x, y, factor }, ...] in device px (static per still)
  let heldMs = 0;             // wall-clock ms the current still has been shown
  let lastTime = 0;           // last rAF timestamp (0 = (re)start the hold clock)
  let rafId = 0;              // requestAnimationFrame handle

  // rgb_to_hsv (utils/hsv.c), line-for-line; r,g,b already normalized to [0,1].
  // Returns h in degrees (truncated to int, like the C's `int *h`), s,v in [0,1].
  function rgbToHsv(r, g, b) {
    let cmax = r, cmin = g, imax = 1;
    if (cmax < g) { cmax = g; cmin = r; imax = 2; }
    if (cmax < b) { cmax = b; imax = 3; }
    if (cmin > b) { cmin = b; }
    const cmm = cmax - cmin;
    const v = cmax;
    let s = 0, h = 0;
    if (cmm !== 0) {
      s = cmm / cmax;
      if      (imax === 1) h =       (g - b) / cmm;
      else if (imax === 2) h = 2.0 + (b - r) / cmm;
      else                 h = 4.0 + (r - g) / cmm;
      if (h < 0) h += 6.0;
    }
    return { h: Math.trunc(h * 60.0), s, v };
  }

  // The C's colour ramp (moire_init_1, default `random:true`): rgb_to_hsv a
  // random foreground RGB and a random background RGB, then make_color_ramp
  // between them as a CLOSED HSV loop (closed_p=True, writable_p=False — static,
  // no cycling). This is a limited 2-hue ramp — frequently muted, different
  // every still — NOT a fixed rainbow. Re-randomized on each re-seed (see snap).
  // Packed 0xFFBBGGRR for the blit path.
  function buildPalette() {
    const n = Math.max(2, Math.round(config.ncolors));
    const fg = rgbToHsv(Math.random(), Math.random(), Math.random());
    const bg = rgbToHsv(Math.random(), Math.random(), Math.random());
    const ramp = makeColorRampRGB(fg.h, fg.s, fg.v, bg.h, bg.s, bg.v, n, true);
    palette = new Uint32Array(n);
    for (let p = 0; p < n; p++) {
      const [r, g, b] = ramp[p];
      palette[p] = (0xff << 24 | b << 16 | g << 8 | r) >>> 0;
    }
  }

  // Seed the zone-plate centre(s) for a new still. The C picks ONE centre offset
  // draw_xo = random()%w - w/2 (so the ring centre, at -draw_xo, is uniform in
  // (-w/2, w/2] — often near or just off the left/top edge) and a ring factor
  // = random()%offset + 1. We do the same per centre, in device px; the factor
  // is scaled by S^2 because the distance term is squared device px on retina,
  // so the visible ring spacing matches dpr 1. No velocity: a still is static
  // until the next re-seed.
  function seedCenters() {
    const n = Math.max(1, Math.round(config.centers));
    const off = Math.max(2, Math.round(config.offset));
    centers = new Array(n);
    for (let i = 0; i < n; i++) {
      centers[i] = {
        x: W / 2 - Math.floor(Math.random() * W),
        y: H / 2 - Math.floor(Math.random() * H),
        factor: (Math.floor(Math.random() * off) + 1) * S * S,
      };
    }
  }

  // Paint the whole still: for every pixel sum each grating's ring value
  // (dx^2 + dy^2) / factor, take floor(sum) mod ncolors as the palette index,
  // and write the packed colour. For the default single grating this is exactly
  // the C's colors[((long)i) % ncolors]; summing >=2 centres adds crossing moire
  // fringes. yy and dy^2 are hoisted per row so the inner loop is tight.
  function render() {
    const n = centers.length;
    const ncolors = palette.length;
    // Snapshot centre x/y and 1/factor (turn the per-pixel divide into a mul).
    const cx = new Float64Array(n);
    const cy = new Float64Array(n);
    const inv = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      cx[k] = centers[k].x;
      cy[k] = centers[k].y;
      inv[k] = 1 / centers[k].factor;
    }

    let idx = 0;
    for (let y = 0; y < H; y++) {
      // Per-row: dy and dy^2 for each centre (independent of x).
      const dy2 = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const dy = y - cy[k];
        dy2[k] = dy * dy;
      }
      for (let x = 0; x < W; x++) {
        let sum = 0;
        for (let k = 0; k < n; k++) {
          const dx = x - cx[k];
          sum += (dx * dx + dy2[k]) * inv[k];
        }
        // floor(sum) mod ncolors, made positive (matches colors[((long)i) % n]).
        let ci = Math.floor(sum) % ncolors;
        if (ci < 0) ci += ncolors;
        pixels[idx++] = palette[ci];
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }

  // A new still: fresh random colour ramp + fresh random centre(s)/factor, then
  // one repaint. Mirrors moire_draw's draw_y==0 path (moire_init_1 rebuilds the
  // ramp, then fresh draw_xo/yo/factor are chosen) — re-randomized every still.
  function snap() {
    buildPalette();
    seedCenters();
    render();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    heldMs = 0;
    lastTime = 0;
    snap();   // build + paint the first still immediately so t=0 looks right
  }

  // reinit: fresh palette + fresh random centres + a clean still, hold clock reset.
  function reinit() {
    init();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Drive off requestAnimationFrame, but the pattern is STATIC: hold the current
  // still for `delay` seconds (the xml's "Duration"), then snap to a fresh one.
  // Accumulate real elapsed time so the hold is wall-clock accurate at any
  // refresh rate; pause/resume resets the clock (lastTime = 0) so it never jumps.
  function frame(now) {
    if (lastTime === 0) lastTime = now;
    heldMs += now - lastTime;
    lastTime = now;

    if (heldMs >= Math.max(1, config.delay) * 1000) {
      snap();
      heldMs = 0;
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
    reinit,   // fresh palette + centres, keeping the current config
    config,
    params,
  };
}
