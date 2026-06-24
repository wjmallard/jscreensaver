// coral.js — coral packaged as a mountable module.
// start(canvas) runs the hack on the given canvas and returns { stop } to tear
// it down (cancel the rAF loop, drop the resize listener), so a host page can
// cycle hacks on one shared canvas. Loop/sizing stay inline per hack for now.

export const title = 'coral';

export function start(canvas) {
    // coral - port of xscreensaver hack by Frederick G.M. Roeber (1997)
    // https://www.jwz.org/xscreensaver/
    //
    // Diffusion-limited aggregation: scatter a few sticky "seeds", then set
    // thousands of random walkers loose. A walker that lands on a sticky cell
    // sticks there and makes its neighbours sticky too, so the coral grows
    // outward branch by branch until every walker has been absorbed.

    const ctx = canvas.getContext('2d');

    // Configuration (matching original defaults)
    const config = {
      density: 25,      // percent of cells that start as random walkers
      seeds: 20,        // initial sticky nuclei
      ncolors: 200,
      delay: 20,        // ms per simulation step
      holdTime: 5000,   // ms to hold the finished coral before regrowing
      scale: 1,
    };

    // Tunable params for the host config box (current units).
    const params = [
      { key: 'delay', label: 'Frame rate', type: 'range', min: 1, max: 200, step: 1, default: 20, unit: ' ms', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
      { key: 'density', label: 'Density', type: 'range', min: 1, max: 90, step: 1, default: 25, unit: '%', lowLabel: 'sparse', highLabel: 'dense', live: false },
      { key: 'seeds', label: 'Seeds', type: 'range', min: 1, max: 100, step: 1, default: 20, lowLabel: 'few', highLabel: 'many', live: false },
      { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 200, live: false },
      { key: 'holdTime', label: 'Linger', type: 'range', min: 0, max: 20000, step: 500, default: 5000, unit: ' ms', live: true },
      { key: 'scale', label: 'Scale', type: 'range', min: 1, max: 8, step: 1, default: 1, lowLabel: 'fine', highLabel: 'coarse', live: false },
    ];

    let width, height, scale;
    let board;
    let walkerX, walkerY, liveWalkers;
    let colors, colorIndex, colorInterval;
    let done, holdRemaining;

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    // Stamp a 3x3 sticky block centred on (x, y). Walkers can only ever sit
    // one cell inside the grid border, so the neighbours are always in bounds.
    function markSticky(x, y) {
      for (let dy = -1; dy <= 1; dy++) {
        const row = (y + dy) * width;
        for (let dx = -1; dx <= 1; dx++) {
          board[row + x + dx] = 1;
        }
      }
    }

    function drawCell(x, y) {
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }

    function init() {
      scale = config.scale * (window.devicePixelRatio || 1);

      width = Math.floor(canvas.width / scale);
      height = Math.floor(canvas.height / scale);

      colors = [];
      for (let i = 0; i < config.ncolors; i++) {
        colors.push(`hsl(${i * 360 / config.ncolors}, 100%, 50%)`);
      }
      colorIndex = Math.floor(Math.random() * config.ncolors);

      board = new Uint8Array(Math.max(0, width * height));
      walkerX = new Int32Array(0);
      walkerY = new Int32Array(0);
      liveWalkers = 0;
      done = false;
      holdRemaining = 0;

      if (width <= 2 || height <= 2) {
        done = true;
        return;
      }

      const density = clamp(config.density, 1, 100);
      const seeds = clamp(config.seeds, 1, 1000);
      const nwalkers = Math.floor(width * height * density / 100);
      colorInterval = Math.floor(nwalkers * 2 / config.ncolors);

      // Scatter the sticky nuclei: each is one drawn dot wrapped in an
      // invisible 3x3 sticky halo for walkers to accrete onto.
      ctx.fillStyle = colors[colorIndex];
      for (let i = 0; i < seeds; i++) {
        let x, y, tries = 10;
        do {
          x = 1 + Math.floor(Math.random() * (width - 2));
          y = 1 + Math.floor(Math.random() * (height - 2));
        } while (board[y * width + x] && tries--);
        markSticky(x, y);
        drawCell(x, y);
      }

      // Random walkers that diffuse until they touch the coral.
      walkerX = new Int32Array(nwalkers);
      walkerY = new Int32Array(nwalkers);
      for (let i = 0; i < nwalkers; i++) {
        walkerX[i] = 1 + Math.floor(Math.random() * (width - 2));
        walkerY[i] = 1 + Math.floor(Math.random() * (height - 2));
      }
      liveWalkers = nwalkers;
    }

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      init();
    }

    function restart() {
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      init();
    }

    function step() {
      if (done) {
        holdRemaining -= config.delay;
        if (holdRemaining <= 0) restart();
        return;
      }

      // One diffusion sweep: every live walker either sticks or takes a step.
      for (let i = 0; i < liveWalkers; i++) {
        const x = walkerX[i];
        const y = walkerY[i];

        if (board[y * width + x]) {
          // Touched the coral: draw this cell, spread stickiness to its
          // neighbours, then retire the walker (swap in the last live one).
          drawCell(x, y);
          markSticky(x, y);
          liveWalkers--;
          walkerX[i] = walkerX[liveWalkers];
          walkerY[i] = walkerY[liveWalkers];

          // Advance the colour every `colorInterval` walkers absorbed, so the
          // coral grows through a slow sweep across the spectrum.
          if (colorInterval === 0 || liveWalkers % colorInterval === 0) {
            colorIndex = (colorIndex + 1) % config.ncolors;
            ctx.fillStyle = colors[colorIndex];
          }
        } else {
          // Step one cell in a random cardinal direction, staying inside the
          // border so the sticky stamp never runs off the grid.
          switch (Math.floor(Math.random() * 4)) {
            case 0: if (x > 1)          walkerX[i] = x - 1; break;
            case 1: if (x < width - 2)  walkerX[i] = x + 1; break;
            case 2: if (y > 1)          walkerY[i] = y - 1; break;
            case 3: if (y < height - 2) walkerY[i] = y + 1; break;
          }
        }
      }

      if (liveWalkers === 0) {
        done = true;
        holdRemaining = config.holdTime;
      }
    }

    // Drive off requestAnimationFrame but keep the original pace: run one
    // step() per config.delay ms, banking leftover time so the speed is the
    // same at any refresh rate. Cap catch-up so a backgrounded tab (where rAF
    // is paused) doesn't fire a burst of steps when it regains focus.
    const MAX_CATCHUP_STEPS = 8;
    let lastTime = 0;
    let lag = 0;
    let rafId = 0;

    function frame(now) {
      if (lastTime === 0) lastTime = now;
      lag += now - lastTime;
      lastTime = now;

      lag = Math.min(lag, config.delay * MAX_CATCHUP_STEPS);
      while (lag >= config.delay) {
        step();
        lag -= config.delay;
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
      reinit: restart,   // clear + regrow with the current config
      config,
      params,
    };
}
