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
// re-seeded at a new random shape/colour. The whole frame is cleared to black
// and redrawn each step, so the shapes never leave trails — the look comes from
// the translucent outlines overlapping where they cross within a single frame.
//
// NB: in the C every throbber is centred at (w/2, h/2) — they are NOT placed at
// random points (verified in make_throbber). The result is a symmetric pulsing
// mandala, which is what "deluxe" looks like; this port keeps that centring.
//
// Blend (faithful): the C's `transparent` resource (default TRUE) gives each
// shape a non-opaque alpha — 0xCC ≈ 0.8 — drawn over the black background with
// ordinary source-over compositing (the jwxyz path in make_throbber). This port
// reproduces that exactly: globalAlpha 0.8, 'source-over', NO additive glow, so
// crossings show the top colour at 80% rather than blowing out to white.
// `transparent` off draws opaque shapes (the C's -no-transparent path).
// Colours come from make_random_colormap with bright_p (random HSV, S 30-99%,
// V 66-99%), built once at init — not a fixed vivid rainbow. See the .md.
// Closest twins: [[piecewise]] and [[interaggregate]] (translucent overlapping
// shapes) and [[squiral]] (the shared skeleton).

export const title = 'deluxe';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Pulsing stars, circles, and lines.',
  year: 1999,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/deluxe.xml so the config box maps 1:1
  // to the original (delay, thickness, count, ncolors, transparent). `speed` is
  // a real resource the C reads (default 15) but does NOT expose in the xml, so
  // it is kept here as a fixed internal value rather than a slider.
  const config = {
    delay: 10000,       // microseconds between steps (--delay)
    thickness: 50,      // line width in logical px (--thickness)
    count: 5,           // number of throbbers in the pool (--count)
    ncolors: 20,        // size of the random colour table (--ncolors)
    transparent: true,  // alpha-blend the shapes (--transparent, default on)
    speed: 15,          // pulse-speed magnitude (C resource, not in the xml)
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes the pool/colours/geometry, so a change
  //                re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 50000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'thickness', label: 'Lines', type: 'range', min: 1, max: 150, step: 1, default: 50, lowLabel: 'thin', highLabel: 'thick', live: false },
    { key: 'count', label: 'Shapes', type: 'range', min: 1, max: 20, step: 1, default: 5, lowLabel: '1', highLabel: '20', live: false },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 20, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'transparent', label: 'Transparency', type: 'checkbox', default: true, live: true },
  ];

  const TAU = Math.PI * 2;

  // randInt(n) -> integer in [0, n), matching the C's `random() % n`.
  const randInt = (n) => Math.floor(Math.random() * n);

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let throbbers;      // fixed-size pool of throbber objects
  let colors;         // random colour table as rgb() strings

  // --- shape draws (one stroked path each) -------------------------------
  // All faithfully ported from deluxe.c's draw_* functions. Each throbber
  // carries its own line width (t.thickness) and colour, set by step() before
  // the draw call; here the path geometry is all that differs.

  // 10-point star outline: outer points at radius s = size * golden constant,
  // inner points at radius s2 = size, alternating. The C's points[10]==points[0]
  // (a coincident first/last vertex), and X11 applies the JOIN style there, not a
  // cap -- so we draw the 10 distinct vertices and ctx.closePath(), which likewise
  // joins (miter) the seam instead of capping it. (Without closePath the open
  // subpath gets two CapProjecting caps at the top vertex -- a spurious "crown".)
  function drawStar(t) {
    const s = t.size * 2.6180339887498985;
    const s2 = t.size;
    const o = -Math.PI / 2;
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const r = (k % 2 === 0) ? s : s2;
      const ang = o + (k * 0.1) * TAU;
      const px = t.x + r * Math.cos(ang);
      const py = t.y + r * Math.sin(ang);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  }

  // Circle outline, centred at (x,y), diameter = size. Guard radius -> 0. The C's
  // XDrawArc full circle is a closed curve (no caps); closePath() closes the canvas
  // subpath so the angle-0 seam joins instead of showing CapProjecting end-caps (a
  // spurious rectangular nub at 3 o'clock).
  function drawCircle(t) {
    const r = t.size / 2;
    if (r <= 0) return;
    ctx.beginPath();
    ctx.arc(t.x, t.y, r, 0, TAU);
    ctx.closePath();
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

  // hsv_to_rgb (utils/hsv.c) + the X server's 16-bit -> 8-bit downsample,
  // matching hacks/colormap.js exactly. h in degrees, s,v in [0,1] -> [r,g,b]
  // 0..255. Inlined here because make_random_colormap is not a ramp helper.
  function hsvToRgb255(h, s, v) {
    if (s < 0) s = 0; else if (s > 1) s = 1;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    const H = (Math.trunc(h) % 360) / 60.0;
    const i = Math.trunc(H);
    const f = H - i;
    const p1 = v * (1 - s);
    const p2 = v * (1 - s * f);
    const p3 = v * (1 - s * (1 - f));
    let R, G, B;
    if      (i === 0) { R = v;  G = p3; B = p1; }
    else if (i === 1) { R = p2; G = v;  B = p1; }
    else if (i === 2) { R = p1; G = v;  B = p3; }
    else if (i === 3) { R = p1; G = p2; B = v;  }
    else if (i === 4) { R = p3; G = p1; B = v;  }
    else              { R = v;  G = p1; B = p2; }
    const q = (c) => {
      const n = Math.floor((Math.trunc(c * 65535) / 65536) * 256);
      return n < 0 ? 0 : n > 255 ? 255 : n;
    };
    return [q(R), q(G), q(B)];
  }

  // make_random_colormap(..., bright_p=True): per-entry random HSV with hue
  // 0-359, saturation 30-99%, value 66-99% (utils/colors.c) — bright but often
  // pastel, NOT a fully-saturated rainbow. Built once at init; the C never
  // cycles or rebuilds it. ncolors < 2 falls back to mono white (the C's MONO).
  function buildColors() {
    const n = Math.max(1, Math.round(config.ncolors));
    if (n < 2) {
      colors = ['rgb(255, 255, 255)'];
      return;
    }
    colors = new Array(n);
    for (let i = 0; i < n; i++) {
      const Hh = randInt(360);                 // 0-359
      const Ss = (randInt(70) + 30) / 100.0;   // 0.30 - 0.99
      const Vv = (randInt(34) + 66) / 100.0;   // 0.66 - 0.99
      const [r, g, b] = hsvToRgb255(Hh, Ss, Vv);
      colors[i] = `rgb(${r}, ${g}, ${b})`;
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

  // One frame: clear to black, then throb+draw every throbber, re-seeding any
  // whose fuse just expired (the C's deluxe_draw). Newly seeded throbbers draw
  // on the NEXT frame, as in the C.
  function step() {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    // The C's transparent path: alpha 0xCC (~0.8) over black with plain
    // source-over; opaque mode draws at full alpha. No additive glow.
    ctx.globalAlpha = config.transparent ? 0.8 : 1;
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
  }

  // deluxe_init: build the colour table, then seed `count` throbbers, each at an
  // extreme (max_size or thickness) exactly as the C does — no artificial phase
  // spread. The pool desyncs on its own within a second or two as the per-shape
  // speeds differ and fuses expire at different times.
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    buildColors();

    const n = Math.max(1, Math.round(config.count));
    throbbers = new Array(n);
    for (let i = 0; i < n; i++) throbbers[i] = makeThrobber();
  }

  // reinit clears to black and re-seeds (count/thickness/colours may have
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
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay deluxe runs 55.3 fps, while the
  // port at the stock 10000 us ran ~100 fps (1.8x fast). 10000 + 8083 = 18083
  // us -> 55 fps, matching the live binary. A calibration, not a tuning knob
  // (the delay slider still maps 1:1 to the xml resource).
  const OVERHEAD = 8083;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
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
