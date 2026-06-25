// sierpinski.js — sierpinski packaged as a mountable module.
// start(canvas) returns { stop, reinit, config, params }.
//
// Port of xscreensaver's sierpinski.c by Desmond Daignault (1996).
// https://www.jwz.org/xscreensaver/
//
// The "chaos game": from a random point, repeatedly jump halfway toward one of
// N randomly-placed vertices and plot where you land, colouring each dot by the
// vertex it jumped to. 3 vertices (Triangle, the default) draw the Sierpinski
// triangle; 4 (Square) are the original's "4 corners" — the same midpoint game,
// but a fourth attractor just fills a fuzzy square with no fractal structure
// (faithful to the C, and admittedly confusing). Points accumulate into a Uint32
// pixel buffer (one blit per frame — point plotting, so a blit, not fillRect);
// after `cycles` frames the dish clears and restarts with fresh vertices and
// colours. (The first dots land "wrong" then focus — as intended.)

export const title = 'sierpinski';

export const info = {
  author: 'Desmond Daignault',
  description: 'The 2D Sierpinski triangle fractal.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  const config = {
    corners: 3,    // 3 = triangle (default); 4 = the original 4-corner square
    count: 2000,   // points plotted per frame
    cycles: 150,   // frames before the dish clears and restarts
    delay: 100,    // ms per frame (orig 400; halved from 50 for calmer cycling)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 1, max: 400, step: 1, default: 100, unit: ' ms', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'corners', label: 'Shape', type: 'select', options: [{ label: 'Triangle', value: 3 }, { label: 'Square', value: 4 }], default: 3, live: false },
    { key: 'count', label: 'Points / frame', type: 'range', min: 200, max: 8000, step: 100, default: 2000, live: true },
    { key: 'cycles', label: 'Density', type: 'range', min: 20, max: 500, step: 10, default: 150, live: true },
  ];

  const BLACK = 0xFF000000;

  let W, H, dot;
  let imageData, pixels;
  let vx, vy, colorsU;
  let px, py, time;

  // HSL (h deg, s/l in [0,1]) packed little-endian 0xAABBGGRR for the buffer.
  function hslToUint(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs(hp % 2 - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1)      { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else             { r = c; b = x; }
    const m = l - c / 2;
    const R = Math.round((r + m) * 255);
    const G = Math.round((g + m) * 255);
    const B = Math.round((b + m) * 255);
    return ((255 << 24) | (B << 16) | (G << 8) | R) >>> 0;
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

  // New round: random vertices + spread vivid colours, random start point, wipe
  // the buffer. (The clear only shows on the next blit, so the finished fractal
  // is visible for one frame first, matching the original's same-frame clear.)
  function startover() {
    const n = config.corners;                  // 3 = triangle, 4 = the square game
    const base = Math.random() * 360;
    colorsU = [];
    for (let i = 0; i < n; i++) {
      const h = (base + i * 360 / n + (Math.random() * 30 - 15) + 360) % 360;
      colorsU[i] = hslToUint(h, 1, 0.55);
    }

    // N vertices inset from the edge, with a minimum pairwise spread so the set
    // isn't a degenerate sliver (a small deviation from the C's fully-random
    // vertices). 3 vertices draw the Sierpinski triangle; a 4th attractor turns
    // the same midpoint game into the original's confusing square fill.
    const margin = Math.min(W, H) * 0.06;
    const minDist2 = (Math.min(W, H) * 0.28) ** 2;
    for (let tries = 0; ; tries++) {
      vx = [];
      vy = [];
      for (let i = 0; i < n; i++) {
        vx[i] = margin + Math.random() * (W - 2 * margin) | 0;
        vy[i] = margin + Math.random() * (H - 2 * margin) | 0;
      }
      let ok = true;
      for (let i = 0; i < n && ok; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = vx[i] - vx[j], dy = vy[i] - vy[j];
          if (dx * dx + dy * dy < minDist2) { ok = false; break; }
        }
      }
      if (ok || tries >= 40) break;
    }
    px = Math.random() * W | 0;
    py = Math.random() * H | 0;
    time = 0;
    pixels.fill(BLACK);
  }

  function step() {
    const count = Math.max(1, Math.round(config.count));
    const n = config.corners;
    for (let i = 0; i < count; i++) {
      const v = Math.random() * n | 0;
      px = (px + vx[v]) >> 1;
      py = (py + vy[v]) >> 1;
      plotDot(px, py, colorsU[v]);
    }
    ctx.putImageData(imageData, 0, 0);
    if (++time >= Math.max(1, Math.round(config.cycles))) startover();
  }

  function init() {
    const dpr = window.devicePixelRatio || 1;
    dot = Math.max(1, Math.round(dpr));
    W = canvas.width;
    H = canvas.height;
    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    startover();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delay = Math.max(1, config.delay);
    lag = Math.min(lag, delay * MAX_CATCHUP_STEPS);
    let steps = 0;
    while (lag >= delay && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delay;
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
    reinit: init,   // new buffer + fresh round with the current config
    config,
    params,
  };
}
