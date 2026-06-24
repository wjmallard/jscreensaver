// squiral.js — squiral packaged as a mountable module.
// start(canvas) returns { stop, reinit, config, params }; the host renders the
// config box from `config`/`params`. Loop/sizing/units stay inline per hack.

export const title = 'squiral';

export function start(canvas) {
    // squiral - port of xscreensaver hack by Jeff Epler (1999)
    // https://www.jwz.org/xscreensaver/

    const ctx = canvas.getContext('2d');

    // Configuration. Units and defaults match xscreensaver's
    // hacks/config/squiral.xml so the tuning UI maps 1:1 to the original.
    const config = {
      fill: 75,          // percent of screen filled before clearing (--fill)
      count: 0,          // number of worms; 0 = auto (width / 32) (--count)
      ncolors: 100,      // size of the hue cycle (--ncolors)
      delay: 10000,      // microseconds between steps (--delay)
      disorder: 0.005,   // chance per step of re-rolling winding (--disorder)
      handedness: 0.5,   // 0 = all right-handed, 1 = all left-handed (--handedness)
      cycle: false,      // animate each worm's hue as it travels (--cycle)
      scale: 1,          // cell size / line thickness (--scale)
    };

    // Ranges/defaults/labels transcribed from hacks/config/squiral.xml.
    // live: true  -> the loop reads config every step, so it applies instantly.
    // live: false -> the value sizes the grid/colors/worms, so changing it
    //                re-runs init() via reinit().
    const params = [
      { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' µs', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
      { key: 'disorder', label: 'Randomness', type: 'range', min: 0, max: 0.5, step: 0.005, default: 0.005, lowLabel: 'low', highLabel: 'high', live: true },
      { key: 'count', label: 'Seeds (0 = auto)', type: 'range', min: 0, max: 200, step: 1, default: 0, live: false },
      { key: 'scale', label: 'Scale', type: 'range', min: 1, max: 10, step: 1, default: 1, lowLabel: 'small', highLabel: 'large', live: false },
      { key: 'handedness', label: 'Handedness', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5, lowLabel: 'left', highLabel: 'right', live: true },
      { key: 'fill', label: 'Density', type: 'range', min: 0, max: 100, step: 1, default: 75, unit: '%', lowLabel: 'sparse', highLabel: 'dense', live: false },
      { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 100, lowLabel: 'two', highLabel: 'many', live: false },
      { key: 'cycle', label: 'Color cycling', type: 'checkbox', default: false, live: false },
    ];

    // Map headings to their [dx, dy] step on the grid.
    const DIRS = [
      [0, -1],  // 0 = up
      [1, 0],   // 1 = right
      [0, 1],   // 2 = down
      [-1, 0],  // 3 = left
    ];

    let width, height, scale;
    let grid;
    let worms;
    let coverage;
    let clearThreshold;
    let inclear;
    let colors;

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function wrap(coord, size) {
      return ((coord % size) + size) % size;
    }

    function init() {
      scale = config.scale * (window.devicePixelRatio || 1);

      width = Math.floor(canvas.width / scale);
      height = Math.floor(canvas.height / scale);

      colors = [];
      for (let i = 0; i < config.ncolors; i++) {
        colors.push(`hsl(${(i * 360 / config.ncolors)}, 100%, 50%)`);
      }

      grid = new Uint8Array(width * height);

      let count = config.count || Math.floor(width / 32);
      count = clamp(count, 1, 1000);

      worms = [];
      for (let i = 0; i < count; i++) {
        worms.push({
          x: Math.floor(Math.random() * width),
          y: Math.floor(Math.random() * height),
          colorIndex: Math.floor(Math.random() * config.ncolors),
          colorStep: config.cycle ? Math.floor(Math.random() * 3) : 0,
          winding: Math.random() < config.handedness ? 1 : 0,
          heading: Math.floor(Math.random() * 4),
        });
      }

      coverage = 0;
      clearThreshold = clamp(config.fill / 100, 0.01, 0.99) * width * height;
      inclear = height;
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

    function isClear(x, y) {
      return grid[wrap(y, height) * width + wrap(x, width)] === 0;
    }

    function fill(x, y) {
      const cx = wrap(x, width);
      const cy = wrap(y, height);
      grid[cy * width + cx] = 1;
      ctx.fillRect(cx * scale, cy * scale, scale, scale);
      coverage++;
    }

    function canMove(x, y, dx, dy) {
      return isClear(x + dx, y + dy) && isClear(x + dx * 2, y + dy * 2);
    }

    function doMove(worm, heading) {
      const [dx, dy] = DIRS[heading];
      fill(worm.x + dx, worm.y + dy);
      fill(worm.x + dx * 2, worm.y + dy * 2);
      worm.x = wrap(worm.x + dx * 2, width);
      worm.y = wrap(worm.y + dy * 2, height);
      return heading;
    }

    function doWorm(worm) {
      let winding = worm.winding;  // 0 = left-winding (CCW), 1 = right-winding (CW)
      let heading = worm.heading;  // 0=up, 1=right, 2=down, 3=left

      worm.colorIndex = (worm.colorIndex + worm.colorStep) % config.ncolors;
      ctx.fillStyle = colors[worm.colorIndex];

      if (Math.random() < config.disorder) {
        winding = Math.random() < config.handedness ? 1 : 0;
      }

      const ccw = (heading + 3) % 4;
      const cw = (heading + 1) % 4;

      let moved = false;
      const tryOrder = winding === 0 ? [ccw, heading, cw] : [cw, heading, ccw];

      for (const d of tryOrder) {
        const [dx, dy] = DIRS[d];
        if (canMove(worm.x, worm.y, dx, dy)) {
          heading = doMove(worm, d);
          moved = true;
          break;
        }
      }

      if (!moved) {
        worm.x = Math.floor(Math.random() * width);
        worm.y = Math.floor(Math.random() * height);
        worm.colorIndex = Math.floor(Math.random() * config.ncolors);
        worm.colorStep = config.cycle ? Math.floor(Math.random() * 3) : 0;
        winding = Math.floor(Math.random() * 2);
        heading = Math.floor(Math.random() * 4);
      }

      worm.winding = winding;
      worm.heading = heading;
    }

    function clearRow(y) {
      if (y >= 0 && y < height) {
        ctx.fillRect(0, y * scale, width * scale, scale);
        for (let x = 0; x < width; x++) grid[y * width + x] = 0;
      }
    }

    function step() {
      if (inclear < height) {
        ctx.fillStyle = 'black';
        clearRow(inclear);
        clearRow(height - 1 - inclear);
        inclear++;
        clearRow(inclear);
        clearRow(height - 1 - inclear);
        inclear++;
        if (inclear > height / 2) inclear = height;
      } else if (coverage > clearThreshold) {
        inclear = 0;
        coverage = 0;
      }

      for (const worm of worms) doWorm(worm);
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

      // config.delay is microseconds (xml units); the rAF clock is milliseconds.
      const delayMs = config.delay / 1000;
      lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

      // The step counter bounds the loop even when delayMs is 0 (max frame
      // rate), which would otherwise spin forever since lag never drops below 0.
      let steps = 0;
      while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
        step();
        lag -= delayMs;
        steps++;
      }

      rafId = requestAnimationFrame(frame);
    }

    // Rebuild the simulation after a non-live config change (clears the canvas
    // because scale/colors may have changed, then re-seeds via init()).
    function reinit() {
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
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
      reinit,   // re-seed the pattern, keeping the current config
      config,   // host renders the config box from these
      params,
    };
}
