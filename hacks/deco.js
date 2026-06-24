// deco.js — deco packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's deco.c (Jamie Zawinski + Michael D. Bayne, 1997;
// golden-ratio + Mondrian additions by Lars Huttar).
// https://www.jwz.org/xscreensaver/
//
// Recursively subdivides the whole screen into nested rectangles (a Mondrian /
// "tacky 70s rec-room panelling" look): at each node it either splits the box
// in two — side-by-side or top-to-bottom — and recurses on the halves, or, once
// it has gone deep enough (or the box is below the minimum size), it stops and
// paints that cell with a flat colour plus a contrasting border. A whole fresh
// subdivision is drawn at once; the screen then holds for `delay` seconds before
// being cleared and redrawn with a brand-new random layout.
//
// The leaf/split decision is the C's, verbatim: stop when a random draw in
// [0, maxDepth) is below the current depth, OR the box is narrower than minWidth,
// OR shorter than minHeight — so cells get likelier to terminate the deeper you
// go, giving the characteristic mix of big and small panels. Three colour modes
// (a random colormap / a smooth colormap / Mondrian's fixed red-yellow-blue-white)
// and optional golden-ratio splits all map straight across from the original.
//
// Rendering is plain vector ops: ctx.fillRect for each cell's flat fill, then
// ctx.strokeRect for its border (the canvas analogue of XFillRectangle +
// XDrawRectangle). Nothing is read back; the canvas is cleared and fully
// repainted each redraw. See [[squiral]] for the shared skeleton and
// [[greynetic]] for the rect-fill idiom.

import { makeRandomColormapRGB, makeSmoothColormapRGB } from './colormap.js';

export const title = 'deco';

export const info = {
  author: 'Jamie Zawinski, Michael D. Bayne, Lars Huttar',
  description: 'Subdivides and colors rectangles randomly, for a Mondrian-esque effect.\n\nhttps://en.wikipedia.org/wiki/Piet_Mondrian#Paris_1919.E2.80.931938',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/deco.xml. Note `delay` here is the C's
  // "Duration" in SECONDS (how long a finished layout holds before the screen is
  // cleared and a new one is drawn), NOT the usual per-step microsecond interval
  // — deco.c's deco_draw() returns 1000000 * delay µs and does no inter-frame
  // animation, so one step() == one complete redraw.
  const config = {
    delay: 5,          // seconds a finished layout holds before redrawing (--delay)
    ncolors: 64,       // size of the colour palette (--ncolors)
    minWidth: 20,      // smallest cell width, screen px (--min-width)
    minHeight: 20,     // smallest cell height, screen px (--min-height)
    maxDepth: 12,      // how deep to subdivide (--max-depth)
    lineWidth: 1,      // border line width, DEVICE px (1 = crisp hairline); 0 = minimal (--line-width)
    colorMode: 'random',  // 'random' | 'smooth' | 'mondrian' (--smooth-colors / --mondrian)
    goldenRatio: false,   // split with the golden ratio instead of in half (--golden-ratio)
  };

  // Ranges/defaults/labels transcribed from hacks/config/deco.xml.
  // live: true  -> the loop reads config every step, so it applies instantly.
  // live: false -> the value sizes cells / palette / borders, so changing it
  //                re-runs init() via reinit() (which also clears + redraws).
  const params = [
    { key: 'delay', label: 'Duration', type: 'range', min: 1, max: 60, step: 1, default: 5, unit: ' s', lowLabel: '1 second', highLabel: '1 minute', live: true },
    { key: 'colorMode', label: 'Colors', type: 'select', default: 'random', live: false, options: [
        { value: 'random', label: 'random' },
        { value: 'smooth', label: 'smooth' },
        { value: 'mondrian', label: 'Mondrian' },
      ] },
    { key: 'ncolors', label: 'Color count', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'minWidth', label: 'Minimum width', type: 'range', min: 1, max: 100, step: 1, default: 20, lowLabel: 'fine', highLabel: 'coarse', live: false },
    { key: 'minHeight', label: 'Minimum height', type: 'range', min: 1, max: 100, step: 1, default: 20, lowLabel: 'fine', highLabel: 'coarse', live: false },
    { key: 'maxDepth', label: 'Maximum depth', type: 'range', min: 1, max: 40, step: 1, default: 12, lowLabel: 'shallow', highLabel: 'deep', live: false },
    { key: 'lineWidth', label: 'Line width', type: 'range', min: 0, max: 20, step: 1, default: 1, lowLabel: 'thin', highLabel: 'thick', live: false },
    { key: 'goldenRatio', label: 'Golden ratio', type: 'checkbox', default: false, live: false },
  ];

  // Golden ratio: dividing a length A+B so A:B == (A+B):A gives phi. PHI1 + PHI2
  // sum to 1, so a split is either the short-then-long or long-then-short cut.
  const PHI = 1.61803;
  const PHI1 = 1.0 / PHI;
  const PHI2 = 1.0 - PHI1;

  // Mondrian's fixed 8-colour map, from make_mondrian_colormap() in deco.c:
  // mostly white, with one red, one blue, one yellow cell. Values are the C's
  // 16-bit channels scaled down to 8-bit.
  const MONDRIAN = [
    'rgb(232, 232, 232)',  // white
    'rgb(232, 232, 232)',  // white
    'rgb(232, 232, 232)',  // white
    'rgb(232, 232, 232)',  // white
    'rgb(207, 0, 0)',      // red
    'rgb(32, 0, 207)',     // blue
    'rgb(223, 207, 0)',    // yellow
    'rgb(232, 232, 232)',  // white
  ];

  let S = 1;            // devicePixelRatio
  let W, H;             // canvas size, device px
  let colors;           // active palette (CSS colour strings)
  let currentColor;     // index into `colors`, advanced at each leaf cell
  let maxDepth;         // clamped config.maxDepth (>= 1)
  let minWidth, minHeight;  // smallest cell, device px
  let lineWidth;        // border width, device px
  let mondrian;         // colorMode === 'mondrian'
  let mono;             // ncolors <= 2 -> the C's mono_p (black cells, white borders)

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  // Build the active palette ONCE per run. deco.c builds its colormap in
  // deco_init and reuses it for every redraw — recomputing per frame is an
  // explicitly UNimplemented idea in the C — so a fixed set of colours recurs
  // across layouts. All three paths are faithful ports of deco.c's colour setup,
  // via the shared colors.c ports in colormap.js:
  //   mondrian       -> make_mondrian_colormap (the fixed 8-colour set above)
  //   smoothColors   -> make_smooth_colormap              -> makeSmoothColormapRGB(n)
  //   else (default) -> make_random_colormap(bright_p=False) -> makeRandomColormapRGB(n, false)
  // The default scheme is fully-random RGB channels (a muted/dark/bright scatter,
  // NOT a vivid spectrum); smooth interpolates 2-5 random HSV anchors into a
  // gentle loop. ncolors <= 2 trips the C's mono_p: no palette, black cells
  // bordered in white.
  function buildColors() {
    if (mondrian) {
      colors = MONDRIAN.slice();
      mono = false;
      return;
    }
    const n = clamp(Math.round(config.ncolors), 1, 255);
    mono = n <= 2;                                // deco.c: if (ncolors <= 2) mono_p = True
    if (mono) {
      colors = null;
      return;
    }
    const cm = config.colorMode === 'smooth'
      ? makeSmoothColormapRGB(n)                  // make_smooth_colormap
      : makeRandomColormapRGB(n, false);          // make_random_colormap, bright_p = False
    colors = cm.map(([r, g, b]) => `rgb(${r},${g},${b})`);
  }

  // Mondrian overrides line width and minimum cell size from the screen dims:
  // line_width = long_side/50, min cell = long_side/8 (deco.c mondrian_set_sizes).
  function applySizes() {
    mondrian = config.colorMode === 'mondrian';

    maxDepth = clamp(Math.round(config.maxDepth), 1, 1000);

    if (mondrian) {
      const big = Math.max(W, H);
      lineWidth = Math.max(1, Math.round(big / 50));
      minWidth = minHeight = Math.round(big / 8);
    } else {
      // The C clamps the minima to >= 2 px and scales them by dpr so a cell's
      // apparent size is consistent with the CSS-pixel value from the xml.
      minWidth = Math.max(2, Math.round(config.minWidth * S));
      minHeight = Math.max(2, Math.round(config.minHeight * S));

      // The C's default (non-Mondrian) border is XDrawRectangle through a "thin"
      // (line_width 0) GC -- ALWAYS 1 physical pixel, regardless of resolution.
      // So draw 1 DEVICE px: a crisp hairline matching the live binary on any
      // dpr. The slider thickens in device px. (Dropped the *dpr scale and the
      // >2560 "Retina" tripling -- both made the border read too thick in a
      // hi-dpi browser, which is exactly what looked wrong.)
      lineWidth = config.lineWidth > 0 ? Math.max(1, Math.round(config.lineWidth)) : 1;
    }
  }

  // Faithful port of deco.c's recursive deco(): either terminate this box and
  // paint it, or split it in two and recurse. Stop when a random draw in
  // [0, maxDepth) falls below the current depth, OR the box is below the minimum
  // size — so deeper boxes terminate ever more readily.
  function subdivide(x, y, w, h, depth) {
    if (Math.floor(Math.random() * maxDepth) < depth || w < minWidth || h < minHeight) {
      // Leaf: fill the cell, then border it. In colour mode advance the cycling
      // palette index (deco.c's per-cell bgc foreground); in mono_p (ncolors<=2)
      // the C never recolours — the cell stays the black background, bordered white.
      if (mono) {
        ctx.fillStyle = '#000';
      } else {
        if (++currentColor >= colors.length) currentColor = 0;
        ctx.fillStyle = colors[currentColor];
      }
      ctx.fillRect(x, y, w, h);

      // XDrawRectangle outlines [x, y, w, h] with the GC line width CENTRED on
      // the path, so each cell's border straddles its edge and OVERLAPS the
      // neighbour's -- the shared border is ONE line-width wide, not two. (An
      // earlier inset-by-half version sat the two borders side by side = 2x too
      // thick, and its bevel corners left fill-coloured triangles; both fixed.)
      ctx.lineWidth = lineWidth;
      ctx.strokeRect(x, y, w, h);
      return;
    }

    // Branch. In golden-ratio (or Mondrian) mode always cut the LONGER side, so
    // panels stay reasonably square; otherwise pick the axis at random. The cut
    // position is half-and-half, or one of the two golden offsets.
    const splitVertical = (config.goldenRatio || mondrian) ? (w > h) : (Math.random() < 0.5);
    if (splitVertical) {
      // Side-by-side: split the width into [0, wnew) and [wnew, w).
      const wnew = config.goldenRatio
        ? Math.floor(w * (Math.random() < 0.5 ? PHI1 : PHI2))
        : Math.floor(w / 2);
      subdivide(x, y, wnew, h, depth + 1);
      subdivide(x + wnew, y, w - wnew, h, depth + 1);
    } else {
      // Top-to-bottom: split the height into [0, hnew) and [hnew, h).
      const hnew = config.goldenRatio
        ? Math.floor(h * (Math.random() < 0.5 ? PHI1 : PHI2))
        : Math.floor(h / 2);
      subdivide(x, y, w, hnew, depth + 1);
      subdivide(x, y + hnew, w, h - hnew, depth + 1);
    }
  }

  // One step == one complete redraw (deco.c's deco_draw): clear to black,
  // recompute Mondrian-derived sizes (cheap; the screen may have resized), then
  // recurse over the whole canvas from depth 0. The palette is NOT rebuilt here
  // — it is fixed for the run (built once in init), exactly as the C reuses its
  // one colormap for every frame; the colour-cycle index likewise carries over.
  function step() {
    applySizes();

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    ctx.lineJoin = 'miter';
    // Border colour = the C's fgc: black in colour mode (fg/bg are swapped), white
    // in mono_p (no swap, so the foreground stays the default white).
    ctx.strokeStyle = mono ? '#fff' : '#000';

    subdivide(0, 0, W, H, 0);
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    applySizes();
    buildColors();
    currentColor = 0;
    step();   // draw the first full layout immediately
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Drive off requestAnimationFrame but keep the original pace: redraw once per
  // `delay` SECONDS, banking leftover time. Unlike the per-step ports, catch-up
  // is capped at one redraw per frame — a full subdivision carries no state from
  // the previous one, so replaying a backlog would just thrash the same picture.
  const MAX_CATCHUP_STEPS = 1;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is in seconds (the xml "Duration"); the rAF clock is ms.
    const delayMs = config.delay * 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    // The step counter bounds the loop even if delayMs were 0, which would
    // otherwise spin forever since lag never drops below 0.
    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Rebuild after a non-live config change: clear + draw a fresh layout with the
  // new sizes/palette, and reset the timer so the new picture gets its full hold.
  function reinit() {
    lag = 0;
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
    reinit,   // fresh layout + palette, keeping the current config
    config,
    params,
  };
}
