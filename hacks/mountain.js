// mountain.js — mountain packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's mountain.c (Pascal Pensa, 1995; xscreensaver port
// 1997). https://www.jwz.org/xscreensaver/
//
// Builds a random "mountain range" on a 50x50 height field, then draws it as an
// isometric grid of quads. The field starts flat; `count` tall Gaussian-ish
// peaks are dropped at random cells, one diffusion pass (spread) smooths every
// cell toward its neighbours, then a little noise is added and low cells are
// flattened to ground. The grid is then walked one quad at a time (left to
// right, bottom to top) and each quad is drawn in an isometric projection —
// taller cells project higher up the screen, so the accumulated peaks read as a
// 3D-ish landscape. Each quad's colour comes from the average height of its four
// corners, cycling through a rainbow palette. Once the whole range is drawn it
// dwells for `cycles` steps, then a fresh range is generated and the build
// restarts.
//
// Rendering: vector ops, sparse — one quad per step (a filled polygon plus a
// black outline, or just the outline in wireframe mode). Matches the C, which
// draws exactly one quad per draw_mountain() tick and never clears mid-build, so
// the range grows in place. The C's expose-driven `refresh` repaint path is
// dropped — a canvas needs no manual expose repair.

export const title = 'mountain';

export const info = {
  author: 'Pascal Pensa',
  description: '3D plots that are vaguely mountainous.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/mountain.xml so the config box maps 1:1,
  // except `delay` is tuned a touch calmer than the stock 20 ms feel and `cycles`
  // is scaled down (see mountain.md — the C's 4000 is a draw-tick count).
  const config = {
    delay: 30000,    // µs between steps / quads (--delay)
    count: 30,       // number of random peaks dropped into the field (--count)
    cycles: 600,     // steps the finished range dwells before regenerating (--cycles)
    ncolors: 64,     // size of the rainbow palette (--ncolors)
    wireframe: false, // draw quads as outlines only (the C's --wireframe mode)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Peaks', type: 'range', min: 1, max: 100, step: 1, default: 30, lowLabel: 'one', highLabel: 'lots', live: false },
    { key: 'cycles', label: 'Dwell', type: 'range', min: 50, max: 4000, step: 50, default: 600, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'wireframe', label: 'Wireframe', type: 'checkbox', default: false, live: false },
  ];

  // Simulation constants, straight from mountain.c.
  const WORLDWIDTH = 50;   // height-field is WORLDWIDTH x WORLDWIDTH cells

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let maxHeight;      // MAXHEIGHT = 3*(width+height), peak ceiling (device px)
  let palette;        // ncolors rainbow CSS strings
  let ncol;           // palette length (>2 => coloured, else mono white)

  // The height field and the incremental-draw cursor (the C's mountainstruct).
  let h;              // Int32Array[WORLDWIDTH*WORLDWIDTH], row-major h[y*W+x]
  let curX, curY;     // current quad cell being drawn
  let stage;          // 0 = building, 1 = dwelling, 2 = regenerate
  let dwell;          // steps elapsed in the dwell stage (the C's mp->time)
  let offset;         // random palette rotation for this range

  function nrand(n) {
    return Math.floor(Math.random() * Math.max(1, n));
  }

  // RANGE_RAND(min,max) -> min + NRAND(max-min), i.e. integer in [min, max).
  function rangeRand(min, max) {
    return min + nrand(max - min);
  }

  // Height-field accessors (row-major; the C is h[x][y] but layout is symmetric).
  function getH(x, y) {
    return h[y * WORLDWIDTH + x];
  }
  function setH(x, y, v) {
    h[y * WORLDWIDTH + x] = v;
  }

  function buildPalette() {
    ncol = Math.max(1, Math.round(config.ncolors));
    palette = new Array(ncol);
    for (let i = 0; i < ncol; i++) palette[i] = `hsl(${i * 360 / ncol}, 100%, 55%)`;
  }

  // One diffusion pass over cell (x,y): read its height once, then average that
  // height into each of the 9 cells in its 3x3 neighbourhood (the C's spread()).
  // In-place mutation during the sweep is intentional and matches the original.
  function spread(x, y) {
    const v = getH(x, y);
    for (let y2 = y - 1; y2 <= y + 1; y2++) {
      for (let x2 = x - 1; x2 <= x + 1; x2++) {
        if (x2 >= 0 && y2 >= 0 && x2 < WORLDWIDTH && y2 < WORLDWIDTH) {
          // Integer division, truncating toward zero, like C's int /.
          setH(x2, y2, Math.trunc((getH(x2, y2) + v) / 2));
        }
      }
    }
  }

  // Project grid cell corner (cellX, cellY, height) to a device-pixel point.
  // Faithful to the C: an isometric skew (x sheared by -cellY/2) with the height
  // subtracted from screen-y so taller cells rise up the screen.
  function projX(cellX, cellY) {
    const x2 = Math.trunc(cellX * (2 * W) / (3 * WORLDWIDTH));
    const y2 = Math.trunc(cellY * (2 * H) / (3 * WORLDWIDTH));
    return (x2 - (y2 >> 1)) + Math.trunc(W / 4);
  }
  function projY(cellY, height) {
    const y2 = Math.trunc(cellY * (2 * H) / (3 * WORLDWIDTH));
    return (y2 - height) + Math.trunc(H / 4);
  }

  // Draw the quad whose lower-left corner is the current cell (curX, curY),
  // spanning cells (x,y),(x+1,y),(x+1,y+1),(x,y+1) — the C's drawamountain().
  function drawQuad() {
    const x = curX, y = curY;

    // Colour from the average height of the four corners (the C's `c`).
    let style;
    if (ncol > 2) {
      let c = (getH(x, y) + getH(x + 1, y) + getH(x, y + 1) + getH(x + 1, y + 1)) >> 2;
      c = (Math.trunc(c / 10) + offset) % ncol;
      if (c < 0) c += ncol;
      style = palette[c];
    } else {
      style = '#fff';
    }

    // The four corner points (+ a 5th == the 1st, to close the outline).
    const px0 = projX(x, y),         py0 = projY(y, getH(x, y));
    const px1 = projX(x + 1, y),     py1 = projY(y, getH(x + 1, y));
    const px2 = projX(x + 1, y + 1), py2 = projY(y + 1, getH(x + 1, y + 1));
    const px3 = projX(x, y + 1),     py3 = projY(y + 1, getH(x, y + 1));

    if (config.wireframe) {
      ctx.strokeStyle = style;
      ctx.lineWidth = Math.max(1, Math.round(S));
      ctx.beginPath();
      ctx.moveTo(px0, py0);
      ctx.lineTo(px1, py1);
      ctx.lineTo(px2, py2);
      ctx.lineTo(px3, py3);
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.fillStyle = style;
      ctx.beginPath();
      ctx.moveTo(px0, py0);
      ctx.lineTo(px1, py1);
      ctx.lineTo(px2, py2);
      ctx.lineTo(px3, py3);
      ctx.closePath();
      ctx.fill();
      // The C outlines filled quads in black unless in tiny "pixelmode".
      ctx.strokeStyle = '#000';
      ctx.lineWidth = Math.max(1, Math.round(S));
      ctx.stroke();
    }

    // Advance the draw cursor; finishing the field moves us to the dwell stage.
    curX++;
    if (curX === WORLDWIDTH - 1) {
      curY++;
      curX = 0;
    }
    if (curY === WORLDWIDTH - 1) stage = 1;
  }

  // Generate a fresh range (the C's init_mountain): flatten, drop peaks, diffuse,
  // roughen, then clear the screen and reset the build cursor.
  function generate() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    maxHeight = 3 * (W + H);

    buildPalette();

    h = new Int32Array(WORLDWIDTH * WORLDWIDTH);   // all zero == flat ground

    // Drop `count` tall random peaks at random interior cells.
    let j = Math.max(1, Math.round(config.count));
    for (let i = 0; i < j; i++) {
      setH(rangeRand(1, WORLDWIDTH - 1), rangeRand(1, WORLDWIDTH - 1), nrand(maxHeight));
    }

    // One diffusion pass over every cell (smooths the spikes into hills).
    for (let y = 0; y < WORLDWIDTH; y++) {
      for (let x = 0; x < WORLDWIDTH; x++) spread(x, y);
    }

    // Roughen: a little noise per cell, and flatten anything near ground to 0.
    for (let y = 0; y < WORLDWIDTH; y++) {
      for (let x = 0; x < WORLDWIDTH; x++) {
        let v = getH(x, y) + nrand(10) - 5;
        if (v < 10) v = 0;
        setH(x, y, v);
      }
    }

    offset = ncol > 2 ? nrand(ncol) : 0;

    curX = 0;
    curY = 0;
    stage = 0;
    dwell = 0;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // One animation step (the C's draw_mountain switch on stage): draw a quad while
  // building, count down the dwell, then regenerate.
  function step() {
    switch (stage) {
      case 0:
        drawQuad();
        break;
      case 1:
        if (++dwell > config.cycles) stage = 2;
        break;
      case 2:
        generate();
        break;
    }
  }

  function reinit() {
    generate();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    generate();
  }

  // rAF lag-accumulator paced by config.delay (µs): run one step() per delay,
  // banking leftover time so the build speed is identical at any refresh rate.
  // Cap catch-up so a backgrounded tab doesn't burst a run of steps on refocus.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = config.delay / 1000;
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
    reinit,
    config,
    params,
  };
}
