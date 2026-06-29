// helix.js — helix packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's helix.c (Jamie Zawinski, 1992; algorithm from a Mac
// program by Chris Tate, c.1988; ellipse code by Dan Stromberg).
// https://www.jwz.org/xscreensaver/
//
// "Spirally string-art-ish patterns." Each round draws ONE closed figure of one
// of two kinds, in one random colour (a fresh HSV roll per figure), then HOLDS
// it on screen and clears to start a fresh figure:
//   - HELIX: two parametric points (each x and y driven by its own integer
//     harmonic of a swept angle) joined by line segments — a Lissajous-ish
//     string-art weave.
//   - TRIG:  a chord between two parametric points on an ellipse, swept until it
//     has woven a dense star/rosette.
// The figure type, geometry (radii, angular increment, integer harmonics), and
// colour are re-rolled at random each round.
//
// Rendering: the figure is genuinely line-shaped (one XDrawLine per step in the
// C), so it uses canvas VECTOR ops — each step accumulates a batch of segments
// into a Path2D and strokes it once in the figure's colour, building up on the
// persistent (double-buffered) canvas exactly like the C drawing into the live
// window. There is no per-frame repaint; the screen is cleared only between
// figures. Closely follows hacks/xspirograph.js (same family: trig figure →
// polyline → stroke → linger → clear → new figure, on a variable-delay loop).

export const title = 'helix';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Spirally string-art-ish patterns.',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror the stock resources (helix.c DEFAULTS / helix.xml).
  // Stock --subdelay is 20000 µs between draw steps; --delay (here `linger`) is
  // the hold in SECONDS (the C's sleep_time * 1e6), default 5 s. Colour is NOT a
  // resource: the C rolls a fresh random HSV per figure (no colour-count knob).
  const config = {
    subdelay: 20000,   // stock --subdelay: \u00B5s between draw steps
    linger: 5,         // stock --delay: seconds to hold the finished figure
  };

  // Live (XQuartz) draw-phase frame rate measured ~36 fps with Load 24-46% (so
  // delay-bound, not compute-bound). The port has no per-step compute cost, so
  // pace the draw at stock subdelay + OVERHEAD = round(1e6/36) - 20000 = 7778 \u00B5s.
  const OVERHEAD = 7800;

  const params = [
    { key: 'subdelay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'linger', label: 'Linger', type: 'range', min: 1, max: 60, step: 1, default: 5, unit: ' s', lowLabel: '1 second', highLabel: '1 minute', live: true },
  ];

  // The C's DRAW_HELIX runs helix() up to 10× per draw call, DRAW_TRIG runs
  // trig() up to 5× — keep those batch sizes so the figure fills in at the same
  // visual rate. (Both break early once the figure finishes.)
  const HELIX_BATCH = 10;
  const TRIG_BATCH = 5;

  // 360-entry sin/cos tables indexed in DEGREES, exactly like the C
  // (sins[i] = sin(i/180·π)). All angle arithmetic stays integer-degrees and is
  // wrapped into [0,360) by pmod() before lookup.
  const sins = new Array(360);
  const coss = new Array(360);
  for (let i = 0; i < 360; i++) {
    sins[i] = Math.sin((i / 180) * Math.PI);
    coss[i] = Math.cos((i / 180) * Math.PI);
  }

  // Positive modulo — the C's pmod(): a degree index that's always in [0, y).
  function pmod(x, y) {
    const t = x % y;
    return t >= 0 ? t : t + y;
  }

  // Euclid's GCD (always non-negative) — the C's gcd().
  function gcd(a, b) {
    while (b > 0) {
      const tmp = a % b;
      a = b;
      b = tmp;
    }
    return a < 0 ? -a : a;
  }

  // The C's random_factor(): mostly ±1 or ±2, occasionally ±3.
  function randomFactor() {
    const mag = (Math.floor(Math.random() * 7) ? (Math.floor(Math.random() * 2) + 1) : 3);
    return mag * (Math.floor(Math.random() * 2) * 2 - 1);
  }

  let S = 1;                 // devicePixelRatio
  let W, H;                  // canvas size, device px
  let xmid, ymid;            // figure centre

  // Current figure state (mirrors the C's struct fields).
  let drawstate;             // 'NEW_FIGURE' | 'DRAW' | 'LINGER' | 'CLEAR'
  let figtype;               // 'HELIX' | 'TRIG'
  let strokeStyle;           // current figure's colour
  let x1, y1, x2, y2;        // current segment endpoints
  let angle, i, limit;       // HELIX sweep state
  let dAngle, dAngleOffset, offset, dir, density;            // TRIG sweep state
  let radius1, radius2, factor1, factor2, factor3, factor4;  // figure harmonics/radii

  // hsv_to_rgb (utils/hsv.c) -> a CSS "rgb(r,g,b)" string, with the X server's
  // 16-bit -> 8-bit downsample folded in (matches colormap.js's quantization).
  // h in degrees; s, v in [0,1].
  function hsvToRgb255(h, s, v) {
    if (s < 0) s = 0; else if (s > 1) s = 1;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    const H = (Math.trunc(h) % 360) / 60;
    const i = Math.trunc(H);
    const f = H - i;
    const p1 = v * (1 - s);
    const p2 = v * (1 - s * f);
    const p3 = v * (1 - s * (1 - f));
    let r, g, b;
    if      (i === 0) { r = v;  g = p3; b = p1; }
    else if (i === 1) { r = p2; g = v;  b = p1; }
    else if (i === 2) { r = p1; g = v;  b = p3; }
    else if (i === 3) { r = p1; g = p2; b = v;  }
    else if (i === 4) { r = p3; g = p1; b = v;  }
    else              { r = v;  g = p1; b = p2; }
    const q = (c) => {
      const t = Math.trunc(c * 65535) / 65536;
      return t <= 0 ? 0 : t >= 1 ? 255 : Math.floor(t * 256);
    };
    return 'rgb(' + q(r) + ',' + q(g) + ',' + q(b) + ')';
  }

  // The C's per-figure colour: hsv_to_rgb(random()%360, frand(1.0), frand(0.5)+0.5)
  // -- one fresh HSV roll per figure. Hue uniform 0-359, SATURATION uniform 0-1
  // (so many figures come out pastel or near-white), value 0.5-1.0 (always at
  // least half-bright). NOT a fixed vivid rainbow.
  function newColor() {
    const h = Math.floor(Math.random() * 360);   // random() % 360
    const s = Math.random();                      // frand(1.0)
    const v = Math.random() * 0.5 + 0.5;          // frand(0.5) + 0.5
    strokeStyle = hsvToRgb255(h, s, v);
  }

  // Choose the geometry of a new HELIX figure — the C's random_helix().
  // Resets the sweep (i=0, angle set lazily on the first helixStep) and the four
  // harmonics, picks signed radii, then re-rolls d_angle until it's coprime to
  // 360 (so limit = 1 + 360/gcd(360,d_angle) = 361 stays bounded) and the four
  // factors until their overall gcd is 1.
  function randomHelix() {
    const radius = Math.min(W, H) / 2;
    i = 0;
    dAngle = 0;
    factor1 = 2;
    factor2 = 2;
    factor3 = 2;
    factor4 = 2;

    const divisor = (Math.random() * 3 + 1) * (Math.floor(Math.random() * 2) * 2 - 1);
    if (Math.floor(Math.random() * 2) === 0) {
      radius1 = radius;
      radius2 = radius / divisor;
    } else {
      radius2 = radius;
      radius1 = radius / divisor;
    }

    while (gcd(360, dAngle) >= 2) dAngle = Math.floor(Math.random() * 360);

    while (gcd(gcd(gcd(factor1, factor2), factor3), factor4) !== 1) {
      factor1 = randomFactor();
      factor2 = randomFactor();
      factor3 = randomFactor();
      factor4 = randomFactor();
    }

    limit = 1 + (360 / gcd(360, dAngle));
  }

  // One HELIX step — the C's helix(): seed the trailing point on the first step,
  // then plot a fresh leading point, draw two segments to the trailing point,
  // advance the swept angle, and finish once `limit` steps are done.
  function helixStep(path) {
    if (i === 0) {
      x1 = xmid;
      y1 = ymid + radius2;
      x2 = xmid;
      y2 = ymid + radius1;
      angle = 0;
    }

    x1 = xmid + radius1 * sins[pmod(angle * factor1, 360)];
    y1 = ymid + radius2 * coss[pmod(angle * factor2, 360)];
    path.moveTo(x2, y2);
    path.lineTo(x1, y1);
    x2 = xmid + radius2 * sins[pmod(angle * factor3, 360)];
    y2 = ymid + radius1 * coss[pmod(angle * factor4, 360)];
    path.moveTo(x1, y1);
    path.lineTo(x2, y2);
    angle += dAngle;

    i++;
    return i >= limit;   // true once the figure has closed
  }

  // Choose the geometry of a new TRIG figure — the C's random_trig().
  // Resets the sweep (d_angle = 0), picks two distinct integer harmonics, a
  // sweep direction, a phase offset, a chord offset, and a density that sets the
  // angular step (and hence how many chords weave the rosette).
  function randomTrig() {
    dAngle = 0;
    factor1 = Math.floor(Math.random() * 8) + 1;
    do {
      factor2 = Math.floor(Math.random() * 8) + 1;
    } while (factor1 === factor2);

    dir = Math.floor(Math.random() * 2) ? 1 : -1;
    dAngleOffset = Math.floor(Math.random() * 360);
    offset = Math.floor((Math.floor(Math.random() * ((360 / 4) - 1)) + 1) / 4);
    density = 1 << ((Math.floor(Math.random() * 4)) + 4);   // 16,32,64,128
  }

  // One TRIG step — the C's trig(): draw a chord between two parametric points on
  // the screen-filling ellipse, then advance d_angle by ±(360/(2·density·f1·f2))
  // (clamped to at least 1 so it can't stall), finishing once |d_angle| > 360.
  function trigStep(path) {
    const a = dAngle + dAngleOffset;
    x1 = sins[pmod(a * factor1, 360)] * xmid + xmid;
    y1 = coss[pmod(a * factor1, 360)] * ymid + ymid;
    x2 = sins[pmod(a * factor2 + offset, 360)] * xmid + xmid;
    y2 = coss[pmod(a * factor2 + offset, 360)] * ymid + ymid;
    path.moveTo(x1, y1);
    path.lineTo(x2, y2);

    let tmp = Math.trunc(360 / (2 * density * factor1 * factor2));
    if (tmp === 0) tmp = 1;   // do not want it getting stuck
    dAngle += dir * tmp;

    return dAngle < -360 || dAngle > 360;   // true once the figure has closed
  }

  // Advance the current figure by one draw call's worth of segments, stroking
  // them in the figure's colour. Returns true when the figure has finished — the
  // C's DRAW_HELIX/DRAW_TRIG batched loops (which break early on completion).
  function drawFigure() {
    const path = new Path2D();
    let finished = false;
    if (figtype === 'HELIX') {
      for (let k = 0; k < HELIX_BATCH; k++) {
        if (helixStep(path)) { finished = true; break; }
      }
    } else {
      for (let k = 0; k < TRIG_BATCH; k++) {
        if (trigStep(path)) { finished = true; break; }
      }
    }
    ctx.strokeStyle = strokeStyle;
    ctx.stroke(path);
    return finished;
  }

  // Instant clear to black. (The C runs xscreensaver's erase_window transition
  // here — a wipe candidate for later; for now we just blank the screen.)
  function clearScreen() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // One state-machine step — the C's helix_draw(). Returns the ms to wait before
  // the next step.
  function step() {
    switch (drawstate) {
      case 'NEW_FIGURE':
        // The C's HELIX/TRIG cases: roll fresh geometry + colour, clear, draw.
        // (random_helix/random_trig each XClearWindow; we clear here so the new
        // figure starts on a fresh screen.)
        if (figtype === 'HELIX') randomHelix(); else randomTrig();
        newColor();
        clearScreen();
        drawstate = 'DRAW';
        return 0;

      case 'DRAW':
        if (drawFigure()) drawstate = 'LINGER';
        // stock subdelay + measured OVERHEAD (live draw ~36 fps); see top.
        return Math.max(0, (config.subdelay + OVERHEAD) / 1000);

      case 'LINGER':
        // The C holds the finished figure for `sleep_time` seconds, then erases.
        drawstate = 'CLEAR';
        return config.linger * 1000;

      case 'CLEAR':
        clearScreen();
        // The C re-rolls the figure type after the erase (random()&1).
        figtype = Math.floor(Math.random() * 2) ? 'HELIX' : 'TRIG';
        drawstate = 'NEW_FIGURE';
        // The C's erase transition takes ~1 s; keep the screen black that long.
        return 1000;

      default:
        drawstate = 'NEW_FIGURE';
        return 0;
    }
  }

  // Begin a fresh sequence with the current config.
  function reset() {
    figtype = Math.floor(Math.random() * 2) ? 'HELIX' : 'TRIG';   // the C's init
    drawstate = 'NEW_FIGURE';
    clearScreen();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    xmid = W / 2;
    ymid = H / 2;
    // Retina line width, mirroring the C's 1px (3px past 2560).
    ctx.lineWidth = (W > 2560 || H > 2560) ? 3 : Math.max(1, S);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    nextDelay = 0;
    reset();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Variable-delay loop (boxfit/xspirograph-style): step() returns the ms to
  // wait before the next step — config.subdelay while drawing, the longer linger
  // / black pauses at a phase change — matching the C's "return microseconds
  // until next call". The canvas persists between steps (segments accumulate),
  // so there is no per-frame repaint; drawing happens inside step().
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let acc = 0;
  let nextDelay = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    acc += now - lastTime;
    lastTime = now;
    // Bound the backlog so a backgrounded tab doesn't burst on refocus — but
    // never below nextDelay, or a long linger/clear pause would never elapse.
    acc = Math.min(acc, nextDelay + 1000);

    let steps = 0;
    while (acc >= nextDelay && steps < MAX_CATCHUP_STEPS) {
      acc -= nextDelay;
      nextDelay = step();
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
    reinit() { nextDelay = 0; reset(); },   // fresh sequence with the current config
    config,
    params,
  };
}
