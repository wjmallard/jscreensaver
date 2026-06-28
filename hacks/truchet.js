// truchet.js — truchet packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's truchet.c (Adrian Likins, 1998).
// https://www.jwz.org/xscreensaver/
//
// A Truchet tiling: the screen is cut into a grid of equal square cells and each
// cell randomly draws one of two tile orientations. Two flavours exist:
//   - curves: two quarter-circle arcs, each centred on an OPPOSITE pair of the
//     cell's corners with radius = half the cell, so the arcs meet the four edge
//     midpoints and chain across cell boundaries into flowing maze-like loops.
//   - angles: the same two orientations drawn as straight diagonal lines joining
//     adjacent edge midpoints.
// Every frame the whole field is regenerated with a fresh random cell size, line
// width, colour, and (when both flavours are on) a random pick of curves/angles,
// reproducing the original's restless full-screen redraw.
//
// Rendering: tiles are thin strokes, not per-pixel accumulation, so this uses
// canvas VECTOR ops. One frame is at most a few thousand short quarter-arcs /
// lines; they all share one colour, so the whole grid is accumulated into a
// single Path2D and stroked once per frame.

export const title = 'truchet';

export const info = {
  author: 'Adrian Likins',
  description: 'Line- and arc-based truchet patterns that tile the screen.\n\nhttps://en.wikipedia.org/wiki/Tessellation',
  year: 1998,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults transcribed from truchet.c's resource table (the modern
  // hacks/config/truchet.xml only exposes delay + fps, so the cell-size / line
  // / mode options are taken from the C's *minWidth ... *curves defaults).
  // `delay` is microseconds (xml units); everything else is logical CSS px.
  const config = {
    delay: 800000,      // microseconds between full redraws (--delay, xml 400000)
    curves: true,       // draw the quarter-arc tiles (--curves)
    angles: true,       // draw the diagonal-line tiles (--angles)
    minWidth: 40,       // smallest random cell size, CSS px (--min-width)
    maxWidth: 150,      // largest random cell size, CSS px (--max-width)
    minLineWidth: 2,    // smallest random stroke width, CSS px (--min-linewidth)
    maxLineWidth: 25,   // largest random stroke width, CSS px (--max-linewidth)
    erase: true,        // clear the canvas before every redraw (--erase)
    eraseCount: 25,     // when not erasing, redraws to stack before a clear (--erase-count)
  };

  // live: true  -> the loop reads config[key] every frame (applies instantly).
  // live: false -> the value sizes the grid / colours, so a change re-runs via
  //                reinit() (a clean black canvas + a fresh frame).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 1000000, step: 10000, default: 800000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'curves', label: 'Arc tiles', type: 'checkbox', default: true, live: true },
    { key: 'angles', label: 'Line tiles', type: 'checkbox', default: true, live: true },
    { key: 'minWidth', label: 'Min cell size', type: 'range', min: 8, max: 256, step: 1, default: 40, unit: ' px', lowLabel: 'small', highLabel: 'big', live: true },
    { key: 'maxWidth', label: 'Max cell size', type: 'range', min: 8, max: 512, step: 1, default: 150, unit: ' px', lowLabel: 'small', highLabel: 'big', live: true },
    { key: 'minLineWidth', label: 'Min line width', type: 'range', min: 1, max: 64, step: 1, default: 2, unit: ' px', live: true },
    { key: 'maxLineWidth', label: 'Max line width', type: 'range', min: 1, max: 96, step: 1, default: 25, unit: ' px', live: true },
    { key: 'erase', label: 'Erase each frame', type: 'checkbox', default: true, live: true },
    { key: 'eraseCount', label: 'Frames per clear (no-erase)', type: 'range', min: 1, max: 50, step: 1, default: 25, live: true },
  ];

  const TAU = Math.PI * 2, HALF_PI = Math.PI / 2;

  let S = 1;            // devicePixelRatio
  let cw, ch;           // canvas backing-store size (device px)
  let count;            // redraws accumulated since the last clear (no-erase path)

  // INTRAND[0, n) -> integer (matches the C's random() % n).
  const irand = (n) => Math.floor(Math.random() * n);

  // Draw the two quarter-circle arcs for one cell into `path`. The cell spans
  // [x0, x0+w] x [y0, y0+w]; each arc is centred on a cell CORNER, radius w/2,
  // so it passes through two edge midpoints and connects to the neighbouring
  // cells' arcs. orient 0 = corners TL+BR (arcs bulge into the cell's SE & NW),
  // orient 1 = corners TR+BL (arcs bulge into SW & NE). Faithful to draw_truchet.
  function arcTile(path, x0, y0, w, orient) {
    const r = w / 2;
    const xl = x0, xr = x0 + w;        // left / right cell edges
    const yt = y0, yb = y0 + w;        // top / bottom cell edges
    if (orient) {
      // TR corner: into-cell quarter from S (right-edge mid) to W (top-edge mid).
      path.moveTo(xr, yt + r);
      path.arc(xr, yt, r, HALF_PI, Math.PI);
      // BL corner: into-cell quarter from N (left-edge mid) to E (bottom-edge mid).
      path.moveTo(xl, yb - r);
      path.arc(xl, yb, r, 1.5 * Math.PI, TAU);
    } else {
      // TL corner: into-cell quarter from E (top-edge mid) to S (left-edge mid).
      path.moveTo(xl + r, yt);
      path.arc(xl, yt, r, 0, HALF_PI);
      // BR corner: into-cell quarter from W (bottom-edge mid) to N (right-edge mid).
      path.moveTo(xr - r, yb);
      path.arc(xr, yb, r, Math.PI, 1.5 * Math.PI);
    }
  }

  // Draw the two diagonal lines for one cell into `path` (draw_angles). The lines
  // join adjacent edge midpoints, so like the arcs they chain across boundaries.
  function lineTile(path, x0, y0, w, orient) {
    const h = w / 2;
    const xm = x0 + h, ym = y0 + h;    // edge midpoints
    const xl = x0, xr = x0 + w;
    const yt = y0, yb = y0 + w;
    if (orient) {
      // top-mid -> left-mid, and right-mid -> bottom-mid.
      path.moveTo(xm, yt); path.lineTo(xl, ym);
      path.moveTo(xr, ym); path.lineTo(xm, yb);
    } else {
      // top-mid -> right-mid, and left-mid -> bottom-mid.
      path.moveTo(xm, yt); path.lineTo(xr, ym);
      path.moveTo(xl, ym); path.lineTo(xm, yb);
    }
  }

  // Tile the whole canvas with `drawTile(path, x0, y0, cell, orient)`, picking a
  // fresh random orientation per cell. The grid starts at the origin and runs one
  // cell past each edge so partial edge tiles still draw (matches the C's
  // while(width > cx*w) bound with overlap 0).
  function tileGrid(path, cell, drawTile) {
    for (let y = 0; y < ch; y += cell) {
      for (let x = 0; x < cw; x += cell) {
        drawTile(path, x, y, cell, irand(2));
      }
    }
  }

  // One frame = regenerate the entire field, exactly as truchet_draw does:
  // roll a random colour, line width, and cell size, optionally clear, then tile.
  function step() {
    // --- random vivid colour (the C picks a fully random RGB each frame) ---
    ctx.strokeStyle = `hsl(${irand(360)}, 100%, ${50 + irand(20)}%)`;

    // --- random line width in [minLineWidth, maxLineWidth], bumped even ---
    const minLW = Math.min(config.minLineWidth, config.maxLineWidth);
    const maxLW = Math.max(config.minLineWidth, config.maxLineWidth);
    let lw = irand(maxLW + 1);
    if (lw < minLW) lw = minLW;
    if (lw & 1) lw++;                  // the C prefers even widths

    // --- random square cell size in [minWidth, maxWidth] ---
    const minW = Math.min(config.minWidth, config.maxWidth);
    const maxW = Math.max(config.minWidth, config.maxWidth);
    let w = irand(maxW + 1);
    if (w === 0) w = maxW;
    if (w < minW) w = minW;

    // keep the stroke from swamping the tile (the C caps line width at cell/5).
    if (lw >= w / 5) lw = Math.max(1, Math.floor(w / 5));

    const cell = Math.max(2, Math.round(w * S));
    ctx.lineWidth = Math.max(1, Math.round(lw * S));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // --- clear when erasing, or once the no-erase stack is full ---
    if (config.erase || count >= config.eraseCount) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);
      count = 0;
    }

    // --- choose the flavour and tile the grid ---
    const path = new Path2D();
    const curves = config.curves;
    const angles = config.angles;
    let useCurves;
    if (curves && angles) useCurves = irand(2) === 0;
    else useCurves = curves;           // one of them (or neither) is on

    if (curves || angles) {
      tileGrid(path, cell, useCurves ? arcTile : lineTile);
      ctx.stroke(path);
    }

    count++;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    S = dpr;
    canvas.width = cw = Math.round(window.innerWidth * dpr);
    canvas.height = ch = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    count = 0;
  }

  // Drive off requestAnimationFrame but keep the original pace: run one step()
  // per config.delay ms, banking leftover time so the speed is the same at any
  // refresh rate. Cap catch-up so a backgrounded tab (where rAF is paused)
  // doesn't fire a burst of redraws when it regains focus.
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
    // which would otherwise spin forever since lag never drops below 0.
    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Clear the canvas to black and draw one fresh frame (for non-live config
  // changes). Keeps the current config.
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    count = 0;
    step();
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
    reinit,   // fresh frame with the current config
    config,
    params,
  };
}
