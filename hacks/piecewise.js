// piecewise.js — piecewise packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's piecewise.c (Geoffrey Irving, 2003).
// https://www.jwz.org/xscreensaver/
//
// A set of circles drifts around the screen, bouncing off the edges. The
// original is a computational-geometry tour de force: a Bentley-Ottmann plane
// sweep over splay trees computes the exact arrangement of all circle
// boundaries, and at every intersection a circle's outline toggles between
// visible and invisible — so where circles overlap, their arcs invert. The net
// look is "lots of moving circles intersecting in interesting ways," with a
// single colour slowly cycling through a rainbow loop.
//
// Rendering: we render the *intent* (overlapping circles that read distinctly
// where they cross) with translucent FILLED discs alpha-composited onto a
// per-frame black clear, rather than reproducing the C's exact span sweep.
// Canvas alpha compositing does the blending the C did by hand: overlaps stack
// to a brighter, more saturated colour instead of inverting an outline. See the
// .md for this deviation. Cheap per-step vector fills (one filled arc each),
// nothing read back. Closest twins: [[braid]] (filled arcs) and [[greynetic]]
// (alpha compositing).

export const title = 'piecewise';

export const info = {
  author: 'Geoffrey Irving',
  description: 'Moving circles switch from visibility to invisibility at intersection points.',
  year: 2003,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/piecewise.xml (1:1 with the original).
  // `alpha` and `fade` are added for the web port: the C inverts outlines at
  // overlaps, we blend translucent discs, so opacity and an optional trail
  // replace that mechanism. `delay` left at the stock 10000 us.
  const config = {
    delay: 20000,     // microseconds between steps (--delay)
    count: 32,        // number of circles (--count)
    colorspeed: 10,   // how fast the shared hue advances, 0..100 (--colorspeed)
    minradius: 0.05,  // smallest radius as a fraction of height (--minradius)
    maxradius: 0.2,   // largest radius as a fraction of height (--maxradius)
    speed: 15,        // base drift speed; velocity = (1 + rand*0.5) * speed/10
    ncolors: 256,     // size of the hue cycle (--ncolors)
    alpha: 35,        // per-disc opacity %; lower = overlaps read as blends
    fade: 0,          // trail amount 0..100; 0 = hard clear each frame
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes circles/colours, so a change re-runs init()
  //                via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Count', type: 'range', min: 4, max: 100, step: 1, default: 32, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'colorspeed', label: 'Color shift', type: 'range', min: 0, max: 100, step: 1, default: 10, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'minradius', label: 'Minimum radius', type: 'range', min: 0.01, max: 0.5, step: 0.01, default: 0.05, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'maxradius', label: 'Maximum radius', type: 'range', min: 0.01, max: 0.5, step: 0.01, default: 0.2, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'speed', label: 'Speed', type: 'range', min: 1, max: 60, step: 1, default: 15, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'alpha', label: 'Opacity', type: 'range', min: 5, max: 100, step: 1, default: 35, unit: '%', lowLabel: 'sheer', highLabel: 'opaque', live: true },
    { key: 'fade', label: 'Trails', type: 'range', min: 0, max: 100, step: 1, default: 0, unit: '%', lowLabel: 'none', highLabel: 'long', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 256, step: 1, default: 256, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  const TAU = Math.PI * 2;

  // frand(x) -> float in [0, x), matching the C helper.
  const frand = (x) => Math.random() * x;

  let S = 1;                  // devicePixelRatio
  let W, H;                   // canvas size, device px
  let circles;               // array of { r, x, y, dx, dy, hue }
  let colorIndex;            // shared base position in the hue loop (the C's color_index)
  let colorIterations;       // steps between hue advances (the C's color_iterations)
  let iterations;            // step counter, for color cycling cadence

  // Seed the circle set. Radii are r0 + random(0..dr), as a band of the height;
  // each circle gets a random position fully inside the field, a random heading,
  // and a speed of (1 + rand*0.5) * speed/10 — straight from init_circles().
  // Each also carries a fixed hue offset around the wheel so overlaps blend
  // distinct colours (the web port's stand-in for the C's per-circle visibility).
  function initCircles() {
    const n = Math.max(1, Math.round(config.count));
    let minR = config.minradius;
    let maxR = config.maxradius;
    if (maxR < minR) maxR = minR;

    // Radii are in device px (logical fraction * device-px height); speed is
    // scaled by S so drift looks the same on retina.
    const r0 = Math.ceil(minR * H);
    const dr = Math.floor(maxR * H) - r0 + 1;

    circles = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = r0 + (dr > 0 ? Math.floor(Math.random() * dr) : 0);
      const a = frand(TAU);
      const v = (1 + frand(0.5)) * config.speed / 10.0 * S;
      circles[i] = {
        r,
        x: r + frand(W - 1 - 2 * r),
        y: r + frand(H - 1 - 2 * r),
        dx: v * Math.cos(a),
        dy: v * Math.sin(a),
        hue: Math.floor(Math.random() * config.ncolors),
      };
    }
  }

  // move_circle(): advance, and reflect off each wall, clamping back inside so a
  // circle never escapes the field (correct from the first frame).
  function moveCircle(c) {
    c.x += c.dx;
    if (c.x < c.r) {
      c.x = c.r;
      c.dx = -c.dx;
    } else if (c.x >= W - c.r) {
      c.x = W - 1 - c.r;
      c.dx = -c.dx;
    }
    c.y += c.dy;
    if (c.y < c.r) {
      c.y = c.r;
      c.dy = -c.dy;
    } else if (c.y >= H - c.r) {
      c.y = H - 1 - c.r;
      c.dy = -c.dy;
    }
  }

  // One step: clear (or fade for trails), draw every disc translucently so
  // overlaps blend, move every disc, then advance the shared hue on the C's
  // cadence (every color_iterations steps, color_index += 1, mod ncolors).
  function step() {
    if (config.fade > 0) {
      // Trails: lay a translucent black veil instead of a hard clear. fade=100
      // -> nearly no clear (long trails); small fade -> short trails.
      ctx.fillStyle = `rgba(0, 0, 0, ${(1 - config.fade / 100).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
    }

    // Additive-ish blend: 'lighter' makes overlaps sum toward white/bright,
    // which is the readable analogue of the C's "overlap inverts the outline"
    // — crossings pop instead of washing out.
    ctx.globalCompositeOperation = 'lighter';
    const a = config.alpha / 100;
    const n = Math.max(1, Math.round(config.ncolors));

    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      const hue = ((colorIndex + c.hue) % n) * 360 / n;
      ctx.fillStyle = `hsla(${hue.toFixed(1)}, 100%, 50%, ${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, TAU);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';

    for (let i = 0; i < circles.length; i++) moveCircle(circles[i]);

    if (colorIterations > 0 && ++iterations % colorIterations === 0) {
      colorIndex = (colorIndex + 1) % n;
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    // color_iterations = colorspeed ? 100/colorspeed : a huge number (so it
    // effectively never cycles); the C clamps it to at least 1.
    colorIterations = config.colorspeed ? Math.max(1, Math.floor(100 / config.colorspeed)) : 100000;
    colorIndex = Math.floor(Math.random() * Math.max(1, Math.round(config.ncolors)));
    iterations = 0;
    initCircles();
  }

  // reinit clears to black and re-seeds (count/radii/colours may have changed).
  function reinit() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    init();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // Drive off requestAnimationFrame but keep the original pace: one step() per
  // config.delay, banking leftover time so the speed is the same at any refresh
  // rate. Cap catch-up so a backgrounded tab doesn't fire a burst on refocus.
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
    reinit,   // re-seed circles + clear, keeping the current config
    config,
    params,
  };
}
