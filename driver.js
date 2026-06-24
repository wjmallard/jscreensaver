// driver.js
// Shared runtime for jscreensaver hacks: the canvas sizing + fixed-timestep
// requestAnimationFrame loop that every hack used to carry its own copy of,
// plus the small math/colour helpers they share. A hack supplies init()/step()
// and how long a step should take; the driver owns the rest.
//
//   createDriver({ canvas, init, step, delayMs })
//     canvas    - the <canvas> to fit to the window (× devicePixelRatio)
//     init()    - (re)build all state for the current canvas size and paint the
//                 first frame. Called once at startup, on every resize, and by
//                 the config overlay after a structural change. Must be
//                 self-contained: allocate buffers, clear, seed.
//     step()    - advance the simulation one step and draw it
//     delayMs() - target milliseconds per step, read fresh each frame (so live
//                 delay edits take effect). A hack converts from its own config
//                 units here, e.g. () => config.delay / 1000 for microseconds.
//   returns { stop } - cancel the loop and detach the resize listener (for
//                      swapping hacks on a shared canvas later).

// Cap how many steps one frame may run, so a long pause (e.g. a backgrounded
// tab, where rAF is suspended) doesn't unleash a burst of catch-up steps on
// return. Also bounds the loop when delayMs() is 0 (max speed), which would
// otherwise never let lag fall below the threshold.
const MAX_CATCHUP_STEPS = 8;

export function createDriver({ canvas, init, step, delayMs }) {
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
  }

  function onResize() {
    sizeCanvas();
    init();
  }

  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const interval = delayMs();
    lag = Math.min(lag, interval * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= interval && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= interval;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  window.addEventListener('resize', onResize);
  sizeCanvas();
  init();
  rafId = requestAnimationFrame(frame);

  return {
    stop() {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
    },
  };
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Floored (Euclidean) modulo: keeps a coordinate in [0, size) even when it
// steps off the low edge, where JS's % would return a negative remainder.
export function wrap(coord, size) {
  return ((coord % size) + size) % size;
}

// HSL (h in degrees, s/l in [0,1]) packed into a little-endian RGBA uint
// (0xAABBGGRR), for writing straight into an ImageData's Uint32 view.
export function hslToUint(h, s, l) {
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
