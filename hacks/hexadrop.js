// hexadrop.js — hexadrop packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }; the
// host renders the config box from `config`/`params`. Loop/sizing/units stay
// inline per hack.
//
// Port of xscreensaver's hexadrop.c (Jamie Zawinski, 2013).
// https://www.jwz.org/xscreensaver/
//
// The screen is tiled with a grid of regular polygons -- hexagons, triangles,
// squares, or octagons (octagons interleaved with little squares). Every cell
// draws two concentric filled polygons each frame: an OUTER polygon at the cell
// radius in the cell's current colour, and an INNER polygon at a shrinking
// radius `i` in the cell's PREVIOUS colour. The inner disc shrinks `speed` px a
// frame; when it vanishes the cell "drops" -- its current colour becomes the
// inner (old) colour, and it inherits a new current colour from the master cell
// (cell 0). Because every reset pulls cell 0's colour, and cells reset at
// staggered phases, colour waves ripple across the whole tiling. Cell 0 itself
// rolls a fresh random colour each time it resets, driving the wave.
//
// Rendering: each cell is two convex filled polygons (a handful of vertices),
// redrawn every frame, so this uses canvas VECTOR fills (ctx.fill of a Path2D)
// rather than per-pixel accumulation. See [[truchet]] for the tile-geometry
// idiom and [[demon]] / [[cloudlife]] for grid-cell colour state.

import { makeSmoothColormapRGB, makeRandomColormapRGB } from './colormap.js';

export const title = 'hexadrop';

export const info = {
  author: 'Jamie Zawinski',
  description: 'A grid of hexagons or other shapes, with tiles dropping out.\n\nhttps://en.wikipedia.org/wiki/Tiling_by_regular_polygons',
  year: 2013,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults / ranges / labels transcribed from hacks/config/hexadrop.xml so the
  // tuning UI maps 1:1 to the original. `delay` is microseconds (xml units);
  // everything else matches the C's resource defaults.
  const config = {
    delay: 30000,      // microseconds between frames -- STOCK *delay (--delay, xml 30000)
    speed: 1.0,        // drop speed multiplier, px/frame baseline (--speed)
    size: 15,          // grid_size: bigger = more, smaller tiles (--size)
    sides: 0,          // 0 = random shape; 3/4/6/8 = tri/square/hex/octagon (--sides)
    uniform: 0,        // speed: 0 = random per-shape, 1 = uniform, 2 = non-uniform (--uniform-speed)
    lockstep: 0,       // phase: 0 = random, 1 = synchronized, 2 = staggered (--lockstep)
    ncolors: 128,      // size of the smooth colour cycle (--ncolors)
  };

  // live: true  -> the loop reads config[key] every frame (applies instantly).
  // live: false -> the value sizes the grid / colours / phases, so a change
  //                re-runs init() via reinit() (a clean black canvas + reseed).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 50000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.1, max: 4.0, step: 0.1, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'size', label: 'Tile size', type: 'range', min: 5, max: 50, step: 1, default: 15, invert: true, lowLabel: 'large', highLabel: 'small', live: false },
    { key: 'sides', label: 'Shape', type: 'select', options: [
        { value: 0, label: 'Random shape' },
        { value: 3, label: 'Triangles' },
        { value: 4, label: 'Squares' },
        { value: 6, label: 'Hexagons' },
        { value: 8, label: 'Octagons' },
      ], default: 0, live: false },
    { key: 'uniform', label: 'Speed mix', type: 'select', options: [
        { value: 0, label: 'Random speed' },
        { value: 1, label: 'Uniform speed' },
        { value: 2, label: 'Non-uniform speed' },
      ], default: 0, live: false },
    { key: 'lockstep', label: 'Sync', type: 'select', options: [
        { value: 0, label: 'Random sync' },
        { value: 1, label: 'Synchronized' },
        { value: 2, label: 'Staggered' },
      ], default: 0, live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 128, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  const TAU = Math.PI * 2;

  // The C works on a fixed-point grid (SCALE=10) only to keep X11's integer
  // XFillPolygon from making pointy corners; canvas fills floats exactly, so we
  // drop it from the vertex math. We keep it solely to reproduce the inner-disc
  // dynamics frame-for-frame: the drop decrements `i` by `speed` px/frame and
  // the initial phase is `random(r) / SCALE` (i.e. up to r/10 px).
  const SCALE = 10;

  // INTRAND[0, n) -> integer (the C's random() % n).
  const irand = (n) => Math.floor(Math.random() * n);

  let cw, ch;                // canvas backing-store size (device px; folds in DPR)
  let gw, gh, ncells;        // grid columns / rows / total cells
  let cells;                 // array of cell objects
  let colors;                // ncolors HSL strings
  let sides;                 // resolved shape (3/4/6/8)
  let uniformP, lockstepP;   // resolved speed / phase flags for this run
  let path;                  // reused Path2D for one polygon fill

  // Resolve a tri-state select (0 = random, 1 = on, 2 = off) to a boolean,
  // matching the C's "Maybe" handling: when BOTH speed and phase are random it
  // turns on at most one of them, so they never both randomise together.
  function resolveFlags() {
    const su = config.uniform;
    const sl = config.lockstep;
    if (su === 0 && sl === 0) {
      uniformP = irand(2) === 1;
      lockstepP = uniformP ? false : irand(2) === 1;
    } else {
      uniformP = su === 0 ? irand(2) === 1 : su === 1;
      lockstepP = sl === 0 ? irand(2) === 1 : sl === 1;
    }
  }

  // Build the grid of cells. Mirrors make_cells(): pick a base `size` from the
  // long screen edge, derive per-shape radius / rotation / spacing, then place
  // each cell. Geometry is in device px (no SCALE). Per the C we leave a few
  // extra rows/cols running off-screen so partial edge tiles still fill.
  function makeCells() {
    let gridSize = config.size;
    if (gridSize < 5) gridSize = 5;

    let size = Math.floor((cw > ch ? cw : ch) / gridSize);
    if (size < 1) size = 1;
    gw = Math.floor(cw / size);
    gh = Math.floor(ch / size);

    let r, th = 0;
    switch (sides) {
      case 8:
        r = size * 0.75;
        th = Math.PI / sides;
        gw = Math.floor(gw * 1.25);
        gh = Math.floor(gh * 1.25);
        break;
      case 6:
        r = size / Math.sqrt(3);
        th = Math.PI / sides;
        gh = Math.floor(gh * 1.2);
        break;
      case 3:
        size *= 2;
        r = size / Math.sqrt(3);
        th = Math.PI / sides / 2;
        break;
      case 4:
        size = Math.floor(size / 2);
        if (size < 1) size = 1;
        r = size * Math.sqrt(2);
        th = Math.PI / sides;
        break;
      default:
        r = size;
        break;
    }

    gw += 3;    // leave a few extra columns off screen just in case
    gh += 3;

    ncells = gw * gh;
    cells = new Array(ncells);

    let i = 0;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const c = {
          sides: sides,
          radius: r,
          th: th,
          cx: 0,
          cy: 0,
          i: 0,
          speed: 0,
          colors: [0, 0],
        };

        switch (sides) {
          case 8:
            if (x & 1) {
              // odd columns: little rotated squares between the octagons
              c.cx = x * size;
              c.radius = (r / 2) * 1.1;
              c.th = Math.PI / 4;
              c.sides = 4;
            } else {
              c.cx = x * size;
              c.radius = r * 1.02 - 1;
            }
            if (y & 1) c.cx -= size;
            c.cy = y * size;
            break;
          case 6:
            c.cx = x * size;
            c.cy = y * size * Math.sqrt(3) / 2;
            if (y & 1) c.cx -= size * 0.5;
            break;
          case 4:
            c.cx = x * size * 2;
            c.cy = y * size * 2;
            break;
          case 3:
            c.cx = x * size * 0.5;
            c.cy = y * size * Math.sqrt(3) / 2;
            if ((x & 1) ^ (y & 1)) {
              c.th = th + Math.PI;
              c.cy -= r * 0.5;
            }
            break;
        }

        // Seed the drop phase / colours (every cell is fresh on (re)build).
        // `speed` here is the per-shape FACTOR only (uniform -> 1, else
        // 0.1..1.0); the loop multiplies it by config.speed so the Speed slider
        // stays live. The C bakes config.speed in at build, but the factor is
        // what varies per cell.
        c.speed = uniformP ? 1 : (0.1 + Math.random() * 0.9);
        c.i = lockstepP ? 0 : irand(r) / SCALE;   // inner radius, px (see SCALE note)
        c.colors[0] = lockstepP ? 0 : irand(config.ncolors);
        c.colors[1] = 0;

        c.radius += 1;   // the C's "+= SCALE" px bump (avoids erase seams)

        if (c.i > c.radius) c.i = c.radius;
        if (c.colors[0] >= config.ncolors) c.colors[0] = config.ncolors - 1;
        if (c.colors[1] >= config.ncolors) c.colors[1] = config.ncolors - 1;

        cells[i] = c;
        i++;
      }
    }
  }

  // Draw one filled, convex polygon of `n` sides at radius `r`, centred on
  // (cx, cy) and rotated by `th0`, in the given fill style. Matches draw_cell's
  // vertex loop (th = i*2PI/n + th0).
  function fillPolygon(cx, cy, r, n, th0, fillStyle) {
    path = new Path2D();
    for (let k = 0; k < n; k++) {
      const th = k * TAU / n + th0;
      const px = cx + r * Math.cos(th);
      const py = cy + r * Math.sin(th);
      if (k === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    }
    path.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill(path);
  }

  // One frame = drop every cell. Drawing cell 0 first means the cells that pull
  // its colour on this same frame see the colour it just rolled, which is how
  // the wave stays coherent (the C iterates cells[0..ncells) in order too).
  function step() {
    for (let i = 0; i < ncells; i++) {
      const c = cells[i];

      // outer (current colour) then inner (previous colour)
      fillPolygon(c.cx, c.cy, c.radius, c.sides, c.th, colors[c.colors[0]]);
      if (c.i > 0) fillPolygon(c.cx, c.cy, c.i, c.sides, c.th, colors[c.colors[1]]);

      // advance the drop: shrink the inner disc by (config.speed * per-shape
      // factor) px per frame -- the C's `i -= SCALE * speed`, in px.
      c.i -= config.speed * c.speed;
      if (c.i < 0) {
        c.i = c.radius;
        c.colors[1] = c.colors[0];
        if (i !== 0) {
          c.colors[0] = cells[0].colors[0];   // inherit the master cell's colour
        } else {
          c.colors[0] = irand(config.ncolors); // cell 0 rolls a fresh colour
        }
      }
    }
  }

  function buildColors() {
    // Faithful to hexadrop_init_1's colour setup: it clamps ncolors >= 2, then
    //   ncolors < 10 -> make_random_colormap(bright_p=False)  (fully-random RGB
    //                   channels -- the muted/dark/bright scatter, NOT a ramp)
    //   else          -> make_smooth_colormap                 (2-5 HSV anchors
    //                   interpolated into a closed loop -- usually a limited,
    //                   harmonious, often-muted hue arc)
    // The default ncolors is 128, so the usual palette is the smooth colormap.
    // (Was a fixed vivid hsl(h,100%,55%) rainbow -- the systemic palette bug.)
    const n = Math.max(2, config.ncolors);
    const rgb = (n < 10)
      ? makeRandomColormapRGB(n, false)
      : makeSmoothColormapRGB(n);
    colors = rgb.map(([r, g, b]) => `rgb(${r},${g},${b})`);
  }

  function init() {
    // Resolve random shape from the C's weighted default table.
    if (config.sides === 0) {
      const defs = [3, 3, 3, 4, 6, 6, 6, 6, 8, 8, 8];
      sides = defs[irand(defs.length)];
    } else {
      sides = config.sides;
    }

    resolveFlags();
    buildColors();
    makeCells();

    // First frame: paint the background to cell 0's colour (the C sets the
    // window background to colors[0]) and draw every cell once so nothing
    // flashes black before the first step.
    ctx.fillStyle = colors[0];
    ctx.fillRect(0, 0, cw, ch);
    for (let i = 0; i < ncells; i++) {
      const c = cells[i];
      fillPolygon(c.cx, c.cy, c.radius, c.sides, c.th, colors[c.colors[0]]);
      if (c.i > 0) fillPolygon(c.cx, c.cy, c.i, c.sides, c.th, colors[c.colors[1]]);
    }
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cw = Math.round(window.innerWidth * dpr);
    canvas.height = ch = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // The live *delay is a sleep FLOOR; each real frame also pays a compute/
  // framework cost, so the effective fps is lower than 1e6/delay. Measured on
  // the XQuartz build with the -fps overlay (delay-bound, Load ~17-29%): a
  // self-consistent median of ~26.3 fps across squares + hexagons. So
  // OVERHEAD = round(1e6 / 26.3) - 30000 ~= 8000 us (>= 0, never faster than spec).
  const OVERHEAD = 8000;   // microseconds added to config.delay to match live pace

  // Drive off requestAnimationFrame but keep the original pace: run one step()
  // per (config.delay + OVERHEAD) ms, banking leftover time so the speed is the
  // same at any refresh rate. Cap catch-up so a backgrounded tab (where rAF is
  // paused) doesn't fire a burst of frames when it regains focus.
  const MAX_CATCHUP_STEPS = 4;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
    // Add OVERHEAD so the per-step gate equals the live frame PERIOD, not just
    // the sleep floor (see the OVERHEAD note above).
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

    rafId = requestAnimationFrame(frame);
  }

  // Rebuild the tiling after a non-live config change (clears the canvas because
  // shape / size / colours may have changed, then re-seeds via init()).
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
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
    reinit,   // rebuild the tiling, keeping the current config
    config,
    params,
  };
}
