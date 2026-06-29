// sierpinski.js -- sierpinski packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's sierpinski.c by Desmond Daignault (1996),
// jwz-compatible since 1997. https://www.jwz.org/xscreensaver/
//
// The "chaos game": pick N random vertices (3 = Sierpinski triangle, 4 = the
// original's "4 corners" square fill), start at a random point, then repeatedly
// jump HALFWAY toward a randomly-chosen vertex and plot where you land,
// colouring each dot by the vertex it jumped to. With 3 vertices the Sierpinski
// gasket emerges from the noise; with 4 the same midpoint game just fills a
// fuzzy quad. Dots ACCUMULATE across frames; after `cycles` frames the window is
// cleared and a fresh round begins with new vertices and colours. (Early dots
// land "wrong" then "focus" -- this is correct behavior, per the .c.)
//
// Colour: the C defines BRIGHT_COLORS, so the xlockmore framework builds an
// ncolors-entry (default 64) make_random_colormap in its BRIGHT variant --
// random hue, high saturation/value, NOT a smooth rainbow. Each round picks
// 3-or-4 colour INDICES spaced around that map with the exact NRAND offsets from
// sierpinski.c. The map is built ONCE per run; only the indices are re-picked
// each round. (MI_NPIXELS <= 2 falls back to white, the .c's mono path.)
//
// Rendering: points accumulate, so this uses the BLIT path -- a persistent
// Uint32 ImageData buffer we plot into and putImageData once per frame (per the
// perf playbook: points -> blit, not per-dot fillRect). Dots are round(dpr) px
// so a point stays ~1 CSS px on retina; startover wipes the buffer.

import { makeRandomColormapRGB } from './colormap.js';

export const title = 'sierpinski';

export const info = {
  author: 'Desmond Daignault',
  description: 'The 2D Sierpinski triangle fractal.\n\nSee also the "Sierpinski3D" screen saver.\n\nhttps://en.wikipedia.org/wiki/Sierpinski_triangle',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/sierpinski.xml 1:1 (delay/count/cycles/
  // ncolors). `corners` maps to the stock --size resource (3 or 4): the .c reads
  // it via MI_SIZE, but it is NOT a slider in the xml GUI, so it is exposed here
  // as a Shape select whose default (Random) reproduces the stock fallback
  // (size unset -> (LRAND() & 1) + 3, picked once at init).
  const config = {
    delay: 400000,   // us between frames (--delay; xml default 400000)
    corners: 0,      // 0 = Random 3-or-4 at init; 3 = Triangle; 4 = Square (--size)
    count: 2000,     // points plotted per frame (--count, "Points")
    cycles: 100,     // frames before the window clears and restarts (--cycles)
    ncolors: 64,     // colormap size (--ncolors); <= 2 draws white (mono)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 1000000, step: 10000, default: 400000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'corners', label: 'Shape', type: 'select', options: [{ label: 'Random', value: 0 }, { label: 'Triangle', value: 3 }, { label: 'Square', value: 4 }], default: 0, live: false },
    { key: 'count', label: 'Points', type: 'range', min: 10, max: 10000, step: 10, default: 2000, lowLabel: 'few', highLabel: 'many', live: true },
    { key: 'cycles', label: 'Timeout', type: 'range', min: 0, max: 1000, step: 10, default: 100, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  const BLACK = 0xFF000000;
  const WHITE = 0xFFFFFFFF;

  let W, H, dot;
  let imageData, pixels;
  let palette;                 // Uint32 bright colormap (null when mono)
  let vx, vy, colorsU;         // vertices + per-vertex packed plot colour
  let px, py, time, activeCorners;

  // NRAND(n): integer in [0, n).
  function nrand(n) {
    return Math.floor(Math.random() * n);
  }

  // Pack an [r,g,b] 0..255 triple into 0xAABBGGRR (little-endian ImageData).
  function pack(rgb) {
    return (0xff << 24 | rgb[2] << 16 | rgb[1] << 8 | rgb[0]) >>> 0;
  }

  // make_random_colormap(bright_p = True) via colormap.js -- ncolors INDEPENDENT
  // bright colours (random hue, sat 30-100%, value 66-100%), NOT a rainbow ramp.
  // Built once per run (the C builds the colormap at startup; startover only
  // re-picks indices). Re-rolled each run, so Math.random's order is fine -- only
  // the distribution must match the C.
  function buildPalette(ncolors) {
    const rgb = makeRandomColormapRGB(ncolors, true);
    palette = new Uint32Array(ncolors);
    for (let i = 0; i < ncolors; i++) palette[i] = pack(rgb[i]);
  }

  function plotDot(x, y, color) {
    for (let j = 0; j < dot; j++) {
      const yy = y + j;
      if (yy >= H) break;
      const row = yy * W;
      for (let i = 0; i < dot; i++) {
        const xx = x + i;
        if (xx < W) pixels[row + xx] = color;
      }
    }
  }

  // startover() (sierpinski.c): re-pick the 3/4 plot-colour indices spaced around
  // the colormap, scatter the vertices fully at random across the window, pick a
  // random start point, reset the frame counter, and clear the buffer.
  function startover() {
    const n = activeCorners;
    const np = palette ? palette.length : 2;   // MI_NPIXELS

    colorsU = new Array(n);
    if (np > 2) {
      // Exact NRAND colour-index spacing from sierpinski.c (3- and 4-corner
      // variants); idx[] are indices into the bright colormap. Integer division
      // matches C's `np / 7`, `2 * np / 7`, etc. via `| 0`.
      const idx = new Array(n);
      if (n === 3) {
        idx[0] = nrand(np);
        idx[1] = (idx[0] + ((np / 7) | 0) + nrand(((2 * np / 7) | 0) + 1)) % np;
        idx[2] = (idx[0] + ((4 * np / 7) | 0) + nrand(((2 * np / 7) | 0) + 1)) % np;
      } else {
        idx[0] = nrand(np);
        idx[1] = (idx[0] + ((np / 7) | 0) + nrand(((np / 7) | 0) + 1)) % np;
        idx[2] = (idx[0] + ((3 * np / 7) | 0) + nrand(((np / 7) | 0) + 1)) % np;
        idx[3] = (idx[0] + ((5 * np / 7) | 0) + nrand(((np / 7) | 0) + 1)) % np;
      }
      for (let i = 0; i < n; i++) colorsU[i] = palette[idx[i]];
    } else {
      // MI_NPIXELS <= 2: draw every point white (the .c's mono path).
      for (let i = 0; i < n; i++) colorsU[i] = WHITE;
    }

    // Fully-random vertices across the whole window, exactly as the .c
    // (NRAND(width)/NRAND(height)) -- no margin inset, no min-distance retry.
    vx = new Array(n);
    vy = new Array(n);
    for (let i = 0; i < n; i++) {
      vx[i] = nrand(W);
      vy[i] = nrand(H);
    }
    px = nrand(W);
    py = nrand(H);
    time = 0;
    pixels.fill(BLACK);
  }

  function step() {
    const count = Math.max(1, Math.round(config.count));
    const cycles = Math.max(1, Math.round(config.cycles));
    const n = activeCorners;
    for (let i = 0; i < count; i++) {
      const v = nrand(n);
      px = (px + vx[v]) >> 1;
      py = (py + vy[v]) >> 1;
      plotDot(px, py, colorsU[v]);
    }
    // ++time >= cycles -> clear + new round (sierpinski.c). The clear lands in
    // THIS frame's single blit, so the reset frame shows black -- matching the
    // .c's MI_CLEARWINDOW, which blanks the window at the end of the reset frame.
    if (++time >= cycles) startover();
    ctx.putImageData(imageData, 0, 0);
  }

  function init() {
    const dpr = window.devicePixelRatio || 1;
    dot = Math.max(1, Math.round(dpr));
    W = canvas.width;
    H = canvas.height;
    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);

    // corners resolved ONCE here: the .c sets sp->corners in init_sierpinski and
    // never changes it (startover keeps the same shape). Random (0, or anything
    // not 3/4) -> a fresh 3-or-4 per init, like the stock size-unset fallback.
    activeCorners = (config.corners === 3 || config.corners === 4)
      ? config.corners
      : (nrand(2) + 3);

    // Colormap built once per init from ncolors; <= 2 -> mono (white, palette null).
    const nc = Math.max(1, Math.min(255, Math.round(config.ncolors)));
    if (nc > 2) buildPalette(nc);
    else palette = null;

    startover();
    ctx.putImageData(imageData, 0, 0);   // show the cleared (black) window at once
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced by config.delay (us): run one step() per delay,
  // banking leftover time so the pace is identical at any refresh rate. (The
  // stock delay is 400000 us, ~2.5 fps -- already calm, so no overhead fudge.)
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = Math.max(1, config.delay / 1000);
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);
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
    reinit: init,   // new buffer + colormap + fresh round with the current config
    config,
    params,
  };
}
