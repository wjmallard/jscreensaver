// sierpinski.js — sierpinski packaged as a mountable module.
// start(canvas) returns { stop, reinit, config, params }.
//
// Port of xscreensaver's sierpinski.c by Desmond Daignault (1996).
// https://www.jwz.org/xscreensaver/
//
// The "chaos game": from a random point, repeatedly jump halfway toward one of
// N randomly-placed vertices and plot where you land, colouring each dot by the
// vertex it jumped to — the Sierpinski triangle. (The original's "4 corners" is
// just a 4-point game; Square mode here is a real Sierpinski CARPET — an 8-map
// ratio-1/3 IFS, randomly sized/placed/rotated.) Points accumulate into a
// Uint32 pixel buffer (one blit per frame — point plotting, so a blit, not
// fillRect); after `cycles` frames the dish clears and restarts with fresh
// vertices and colours. (The first dots land "wrong" then focus — as intended.)

export const title = 'sierpinski';

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  const config = {
    corners: 3,    // 3 = triangle (default); 4 = Sierpinski carpet
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
  // Sierpinski carpet IFS: the 8 cells of a 3×3 grid minus the centre.
  const CARPET = [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]];

  let W, H, dot;
  let imageData, pixels;
  let vx, vy, colorsU;
  let px, py, time;
  let isCarpet, sq, cx, cy, ux, uy, focal;
  let ex0, ex1, ex2, ey0, ey1, ey2;   // Square mode = a 3D-tilted carpet's basis

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
    isCarpet = config.corners === 4;
    const ncol = isCarpet ? 8 : 3;
    const base = Math.random() * 360;
    colorsU = [];
    for (let i = 0; i < ncol; i++) {
      const h = (base + i * 360 / ncol + (Math.random() * 30 - 15) + 360) % 360;
      colorsU[i] = hslToUint(h, 1, 0.55);
    }

    if (isCarpet) {
      // A real Sierpinski carpet (8-map ratio-1/3 IFS), randomly sized, placed
      // and rotated each round (like the triangle's random vertices). The C's
      // "4 corners" is only a 4-point midpoint game — no carpet at all.
      const minDim = Math.min(W, H);
      sq = minDim * (0.4 + Math.random() * 0.25);   // 0.40–0.65 of the short side
      cx = W * (0.3 + Math.random() * 0.4);          // central-ish (tilt may clip a little)
      cy = H * (0.3 + Math.random() * 0.4);
      // Random orientation: in-plane spin (z) + tilt out of the screen plane
      // (x, y). The square lies in z=0, so we only need R = Rz·Ry·Rx's first two
      // columns (the rotated images of the unit x- and y-axes).
      const az = Math.random() * Math.PI * 2;
      const ax = (Math.random() - 0.5) * 2.0;        // ±~57° tilt
      const ay = (Math.random() - 0.5) * 2.0;
      const cz = Math.cos(az), sz = Math.sin(az);
      const cxr = Math.cos(ax), sxr = Math.sin(ax);
      const cyr = Math.cos(ay), syr = Math.sin(ay);
      ex0 = cyr * cz;                  ex1 = cyr * sz;                  ex2 = -syr;
      ey0 = cz * syr * sxr - sz * cxr; ey1 = sz * syr * sxr + cz * cxr; ey2 = cyr * sxr;
      focal = sq * 2.2;                              // perspective focal length (> max|Z|)
      ux = Math.random();
      uy = Math.random();
    } else {
      // Triangle: 3 vertices inset with a minimum pairwise spread, so it isn't a
      // degenerate sliver (deviation from the C's fully-random vertices).
      const margin = Math.min(W, H) * 0.06;
      const minDist2 = (Math.min(W, H) * 0.28) ** 2;
      for (let tries = 0; ; tries++) {
        vx = [];
        vy = [];
        for (let i = 0; i < 3; i++) {
          vx[i] = margin + Math.random() * (W - 2 * margin) | 0;
          vy[i] = margin + Math.random() * (H - 2 * margin) | 0;
        }
        let ok = true;
        for (let i = 0; i < 3 && ok; i++) {
          for (let j = i + 1; j < 3; j++) {
            const dx = vx[i] - vx[j], dy = vy[i] - vy[j];
            if (dx * dx + dy * dy < minDist2) { ok = false; break; }
          }
        }
        if (ok || tries >= 40) break;
      }
      px = Math.random() * W | 0;
      py = Math.random() * H | 0;
    }
    time = 0;
    pixels.fill(BLACK);
  }

  function step() {
    const n = Math.max(1, Math.round(config.count));
    if (isCarpet) {
      for (let i = 0; i < n; i++) {
        const k = Math.random() * 8 | 0;
        ux = (ux + CARPET[k][0]) / 3;
        uy = (uy + CARPET[k][1]) / 3;
        const sxp = (ux - 0.5) * sq;
        const syp = (uy - 0.5) * sq;
        const Z = sxp * ex2 + syp * ey2;
        const s = focal / (focal - Z);   // perspective divide
        plotDot((cx + (sxp * ex0 + syp * ey0) * s) | 0, (cy + (sxp * ex1 + syp * ey1) * s) | 0, colorsU[k]);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const v = Math.random() * 3 | 0;
        px = (px + vx[v]) >> 1;
        py = (py + vy[v]) >> 1;
        plotDot(px, py, colorsU[v]);
      }
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
