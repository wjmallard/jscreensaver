// deluxe.js — deluxe packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's deluxe.c (Jamie Zawinski, 1999).
// https://www.jwz.org/xscreensaver/
//
// A small fixed pool of "throbbers" pulses concentrically from the centre of
// the screen: stars, circle outlines, paired horizontal/vertical lines, and
// bracket corners. Each throbber grows and shrinks between thickness/2 and the
// screen's max dimension, bouncing at each extreme; every outer bounce burns a
// "fuse" (started at 1..4), and when the fuse runs out the throbber is freed and
// re-seeded at a new random shape/colour. The whole frame is cleared and
// redrawn each step, so the shapes never leave trails — the look comes from the
// translucent outlines overlapping where they cross within a single frame.
//
// NB: in the C every throbber is centred at (w/2, h/2) — they are NOT placed at
// random points (verified in make_throbber). The result is a symmetric pulsing
// mandala, which is what "deluxe" looks like; this port keeps that centring.
//
// Rendering: sparse vector. Each throbber is one stroked Path2D-free path
// (ctx.beginPath/stroke) with a thick line, drawn translucently. The C's
// X11 plane-mask "transparent" path is real alpha on jwxyz (macOS), alpha
// 0xCC ~= 0.8 with normal source-over; here the default uses additive
// ('lighter') blending so crossings glow (vivid house style) with an "Additive
// glow" toggle to fall back to faithful source-over. See the .md for the blend
// rationale. Closest twins: [[piecewise]] and [[interaggregate]] (translucent
// overlapping shapes) and [[squiral]] (the shared skeleton).

export const title = 'deluxe';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Pulsing stars, circles, and lines.',
  year: 1999,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/deluxe.xml so the config box maps 1:1
  // to the original. `speed` is a hidden resource in the C (default 15, not in
  // the xml); `opacity`, `glow`, and `fade` are web-port additions standing in
  // for the C's transparency/XOR plane-mask path (see .md).
  const config = {
    delay: 15000,    // microseconds between steps (--delay)
    count: 5,        // number of throbbers in the pool (--count)
    thickness: 50,   // line width in logical px (--thickness)
    speed: 15,       // pulse speed magnitude (--speed, hidden in xml)
    ncolors: 20,     // size of the random colour table (--ncolors)
    opacity: 80,     // per-shape opacity % (jwxyz transparent alpha ~= 80%)
    fade: 0,         // trail amount 0..100; 0 = hard clear each frame
    glow: true,      // additive 'lighter' blend so overlaps glow
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes the pool/colours/geometry, so a change
  //                re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 15000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Shapes', type: 'range', min: 1, max: 20, step: 1, default: 5, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'thickness', label: 'Line thickness', type: 'range', min: 1, max: 150, step: 1, default: 50, lowLabel: 'thin', highLabel: 'thick', live: false },
    { key: 'speed', label: 'Pulse speed', type: 'range', min: 1, max: 50, step: 1, default: 15, lowLabel: 'slow', highLabel: 'fast', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 20, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'opacity', label: 'Opacity', type: 'range', min: 10, max: 100, step: 1, default: 80, unit: '%', lowLabel: 'sheer', highLabel: 'solid', live: true },
    { key: 'fade', label: 'Trails', type: 'range', min: 0, max: 100, step: 1, default: 0, unit: '%', lowLabel: 'none', highLabel: 'long', live: true },
    { key: 'glow', label: 'Additive glow', type: 'checkbox', default: true, live: true },
  ];

  const TAU = Math.PI * 2;

  // randInt(n) -> integer in [0, n), matching the C's `random() % n`.
  const randInt = (n) => Math.floor(Math.random() * n);

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let throbbers;      // fixed-size pool of throbber objects
  let colors;         // random colour table as hsl() strings

  // --- shape draws (one stroked path each) -------------------------------
  // All faithfully ported from deluxe.c's draw_* functions. Each throbber
  // carries its own line width (t.thickness) and colour, set by step() before
  // the draw call; here the path geometry is all that differs.

  // 10-point star outline: outer points at radius s = size * golden constant,
  // inner points at radius s2 = size, alternating; closes back to point 0.
  function drawStar(t) {
    const s = t.size * 2.6180339887498985;
    const s2 = t.size;
    const o = -Math.PI / 2;
    ctx.beginPath();
    for (let k = 0; k <= 10; k++) {
      const r = (k % 2 === 0) ? s : s2;
      const ang = o + (k * 0.1) * TAU;
      const px = t.x + r * Math.cos(ang);
      const py = t.y + r * Math.sin(ang);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // Circle outline, centred at (x,y), diameter = size. Guard radius -> 0.
  function drawCircle(t) {
    const r = t.size / 2;
    if (r <= 0) return;
    ctx.beginPath();
    ctx.arc(t.x, t.y, r, 0, TAU);
    ctx.stroke();
  }

  // Two horizontal lines spreading apart from the centre line as size grows,
  // each spanning x in [0, max_size].
  function drawHlines(t) {
    ctx.beginPath();
    ctx.moveTo(0, t.y - t.size);
    ctx.lineTo(t.maxSize, t.y - t.size);
    ctx.moveTo(0, t.y + t.size);
    ctx.lineTo(t.maxSize, t.y + t.size);
    ctx.stroke();
  }

  // Two vertical lines spreading apart, each spanning y in [0, max_size].
  function drawVlines(t) {
    ctx.beginPath();
    ctx.moveTo(t.x - t.size, 0);
    ctx.lineTo(t.x - t.size, t.maxSize);
    ctx.moveTo(t.x + t.size, 0);
    ctx.lineTo(t.x + t.size, t.maxSize);
    ctx.stroke();
  }

  // Four open L-shaped brackets forming a growing rectangle frame. Each bracket
  // is its own polyline (separate begin/stroke) so they stay open, not joined.
  function drawCorners(t) {
    const s = Math.floor((t.size + t.thickness) / 2);
    if (t.y > s) {
      ctx.beginPath();
      ctx.moveTo(0, t.y - s);
      ctx.lineTo(t.x - s, t.y - s);
      ctx.lineTo(t.x - s, 0);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(t.x + s, 0);
      ctx.lineTo(t.x + s, t.y - s);
      ctx.lineTo(t.maxSize, t.y - s);
      ctx.stroke();
    }
    if (t.x > s) {
      ctx.beginPath();
      ctx.moveTo(0, t.y + s);
      ctx.lineTo(t.x - s, t.y + s);
      ctx.lineTo(t.x - s, t.maxSize);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(t.x + s, t.maxSize);
      ctx.lineTo(t.x + s, t.y + s);
      ctx.lineTo(t.maxSize, t.y + s);
      ctx.stroke();
    }
  }

  // Build the random colour table (the C's make_random_colormap): ncolors
  // random vivid hues; throbbers pick a random entry. House style = saturated.
  function buildColors() {
    const n = Math.max(1, Math.round(config.ncolors));
    colors = new Array(n);
    for (let i = 0; i < n; i++) {
      colors[i] = `hsl(${randInt(360)}, 100%, 55%)`;
    }
  }

  // make_throbber(): centre at (W/2, H/2), pick a random shape, a jittered
  // (always-negative) speed, a fuse of 1..4, and either start at max_size
  // (3/4 of the time, shrinking inward) or at thickness (1/4, growing outward
  // with the speed flipped positive). All sizes are device px (scaled by S).
  function makeThrobber() {
    const t = {};
    t.x = Math.floor(W / 2);
    t.y = Math.floor(H / 2);
    t.maxSize = Math.max(W, H);
    t.thickness = Math.max(1, config.thickness) * S;

    // speed jitter, verbatim from the C (guard config.speed >= 1 to avoid the
    // C's latent `random() % speed` divide-by-zero when speed is 0):
    let speed = Math.max(1, Math.round(config.speed));
    speed += Math.floor(randInt(speed) / 2) - Math.floor(speed / 2);
    if (speed > 0) speed = -speed;
    t.speed = speed * S;

    const choice = randInt(11);
    if (choice <= 3) t.draw = drawStar;        // cases 0..3
    else if (choice <= 7) t.draw = drawCircle; // cases 4..7
    else if (choice === 8) t.draw = drawHlines;
    else if (choice === 9) t.draw = drawVlines;
    else t.draw = drawCorners;                 // case 10

    if (t.draw === drawCircle) t.maxSize *= 1.5;

    if (randInt(4)) {            // 3/4 chance (1,2,3): start big, shrink in
      t.size = t.maxSize;
    } else {                     // 1/4 chance (0): start small, grow out
      t.size = t.thickness;
      t.speed = -t.speed;
    }

    t.fuse = 1 + randInt(4);
    t.color = colors[randInt(colors.length)];
    return t;
  }

  // throb(): advance one step. Bounce at thickness/2 (low) and max_size (high);
  // each high bounce burns a fuse. Returns -1 when the fuse is spent (caller
  // re-seeds the slot), else draws at the new size and returns 0. Faithful to
  // the C's throb(), including the post-bounce `size += speed*2` overshoot fix.
  function throb(t) {
    t.size += t.speed;
    if (t.size <= t.thickness / 2) {
      t.speed = -t.speed;
      t.size += t.speed * 2;
    } else if (t.size > t.maxSize) {
      t.speed = -t.speed;
      t.size += t.speed * 2;
      t.fuse--;
    }
    if (t.fuse <= 0) return -1;
    t.draw(t);
    return 0;
  }

  // One frame: clear (or lay a translucent veil for trails), then throb+draw
  // every throbber, re-seeding any whose fuse just expired (the C's
  // deluxe_draw). Newly seeded throbbers draw on the NEXT frame, as in the C.
  function step() {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (config.fade > 0) {
      ctx.fillStyle = `rgba(0, 0, 0, ${(1 - config.fade / 100).toFixed(3)})`;
    } else {
      ctx.fillStyle = '#000';
    }
    ctx.fillRect(0, 0, W, H);

    // Additive glow on overlaps (default) or faithful flat alpha.
    ctx.globalCompositeOperation = config.glow ? 'lighter' : 'source-over';
    ctx.globalAlpha = config.opacity / 100;
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'square';   // X11 CapProjecting

    for (let i = 0; i < throbbers.length; i++) {
      const t = throbbers[i];
      ctx.lineWidth = t.thickness;
      ctx.strokeStyle = t.color;
      if (throb(t) < 0) {
        throbbers[i] = makeThrobber();
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    buildColors();

    const n = Math.max(1, Math.round(config.count));
    throbbers = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = makeThrobber();
      // Desync the opening: spread initial sizes across the pulse range so the
      // first frame shows several shapes mid-expansion rather than all stacked
      // at the extremes. (Re-seeds keep the C's extreme-start; the pool desyncs
      // naturally thereafter as fuses expire at different times.)
      t.size = t.thickness / 2 + Math.random() * (t.maxSize - t.thickness / 2);
      throbbers[i] = t;
    }
  }

  // reinit clears to black and re-seeds (count/thickness/speed/colours may have
  // changed), keeping the current config.
  function reinit() {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.globalAlpha = 1;
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
    reinit,   // re-seed the pool + clear, keeping the current config
    config,
    params,
  };
}
