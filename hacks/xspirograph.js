// xspirograph.js — xspirograph packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's xspirograph.c (Rohit Singh, 2000; later tweaked by
// Matthew Strait). https://www.jwz.org/xscreensaver/
//
// "The Spiral Generator" — the pen-in-nested-plastic-gears toy (a spirograph).
// Simulates a point at distance `d` from the centre of a small disc rolling
// inside a larger ring: as theta sweeps, the point traces an epitrochoid, drawn
// as a long polyline that eventually closes on itself. Each figure is drawn
// twice (the rolling radius flips sign, giving a mirror-petalled companion);
// `layers` such pairs stack in different hues, then the screen clears and a
// fresh set of figures begins.
//
// Rendering: the curve is genuinely line-shaped (one XDrawLine per theta step in
// the C), so it uses canvas VECTOR ops — segments are accumulated into a Path2D
// per step and stroked once in the layer's colour, building the figure up
// incrementally on the persistent (double-buffered) canvas. There is no full
// repaint: like the C, each new segment is drawn over what's already there, so
// the stacked layers accumulate until the clear.

export const title = 'xspirograph';

export const info = {
  author: 'Rohit Singh',
  description: 'Simulates that pen-in-nested-plastic-gears toy from your childhood.',
  year: 2000,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/xspirograph.xml (1:1 with the original).
  // The xml reuses id="delay" for two distinct sliders: `subdelay` is the
  // per-step frame rate (µs, inverted) and `linger` is the seconds-long hold
  // before the finished figures are erased.
  const config = {
    subdelay: 60000,   // µs between draw steps (--subdelay)
    linger: 5,         // seconds to hold the finished figures before erasing (--delay)
    layers: 2,         // number of stacked figure-pairs per screen (--layers)
    ncolors: 64,       // hue-cycle size (not in stock UI; for parity with the gallery)
  };

  const params = [
    { key: 'subdelay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'linger', label: 'Linger', type: 'range', min: 1, max: 60, step: 1, default: 5, unit: ' s', lowLabel: '1 second', highLabel: '1 minute', live: true },
    { key: 'layers', label: 'Layers', type: 'range', min: 1, max: 10, step: 1, default: 2, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // The C's go() draws up to 1000 segments per draw call; keep that batch size
  // so the figure fills in at the same visual rate.
  const SEGS_PER_STEP = 1000;
  // theta is bounded at 360*100 unless -alwaysfinish; we always let a figure
  // finish (it closes on itself first in practice), but keep the cap as a guard.
  const MAX_THETA = 360 * 100;
  // The C's hsv_to_rgb(random()%360, frand(1.0), frand(0.5)+0.5) — random hue,
  // random saturation, value in [0.5, 1.0]. delta is the algorithm's deliberate
  // imperfection that makes the figure interesting.
  const DELTA = 1;

  let S = 1;                 // devicePixelRatio
  let W, H;                  // canvas size, device px
  let xmid, ymid;            // figure centre
  let palette;               // ncolors smooth-rainbow CSS strings

  // Current figure-set state (mirrors the C's struct fields).
  let drawstate;             // 'NEW_LAYER' | 'DRAW' | 'ERASE1' | 'ERASE2'
  let counter;               // figures drawn so far this screen (1..2*layers)
  let theta;                 // sweep parameter for the current figure
  let radius1, radius2, distance, divisor;   // current figure geometry
  let firstX, firstY;        // first plotted point (used to detect closure)
  let prevX, prevY;          // previous plotted point (segment start)
  let strokeStyle;           // current layer's colour

  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    palette = new Array(n);
    // Vivid rainbow; white when ncolors <= 1 (the C's mono path).
    for (let i = 0; i < n; i++) palette[i] = n > 1 ? `hsl(${i * 360 / n}, 100%, 60%)` : '#fff';
  }

  // Pick a fresh colour for a layer — the C's new_colors(): random hue from the
  // palette (it uses a full HSV roll; we approximate with a rainbow index).
  function newColor() {
    const n = palette.length;
    strokeStyle = palette[Math.floor(Math.random() * n)];
  }

  // Choose the geometry of a new figure-pair — the C's pick_new().
  // divisor = (rand 1..4) * (random sign); radius2 = radius1/divisor + 5.
  function pickNew() {
    const radius = Math.min(W, H) / 2;
    divisor = (Math.random() * 3 + 1) * (((Math.floor(Math.random() * 2)) * 2) - 1);
    radius1 = radius;
    radius2 = radius / divisor + 5 * S;
    distance = (100 + Math.floor(Math.random() * 200)) * S;
    theta = 1;
  }

  // One plotted point of the epitrochoid at the current theta, given the signed
  // rolling radius. This is the C's go() inner equation, transcribed verbatim
  // (the rotation of a point at distance d from the centre of a disc of radius
  // |r2| rolling inside a ring of radius r1, with a delta-sized "error").
  function plot(r2) {
    const tRad = theta * Math.PI / 180;
    const x = xmid
            + (radius1 - r2) * Math.cos(tRad)
            + distance * Math.cos((((radius1 * theta) - DELTA) / r2) * Math.PI / 180);
    const y = ymid
            + (radius1 - r2) * Math.sin(tRad)
            + distance * Math.sin((((radius1 * theta) - DELTA) / r2) * Math.PI / 180);
    return [x, y];
  }

  // Advance the current figure by up to SEGS_PER_STEP segments, stroking them in
  // the layer colour. Returns true when the figure has finished (closed on
  // itself or hit the theta cap) — the C's go() return value, batched.
  function drawFigure(r2) {
    const path = new Path2D();
    let drew = false;
    let finished = false;

    for (let i = 0; i < SEGS_PER_STEP; i++) {
      // The C seeds (x1,y1) once at theta==1 from the closed-form start point.
      if (theta === 1) {
        prevX = xmid + radius1 - r2 + distance;
        prevY = ymid;
      }

      const [x2, y2] = plot(r2);

      // Closure is tested on INTEGER pixel coords: the C draws XPoints (ints), so
      // a figure "returns to its start" when the rounded point matches — not at
      // exact float equality, which a quasi-periodic curve never hits (so it would
      // run to MAX_THETA every time, retracing itself and looking stuck).
      const ix = x2 | 0, iy = y2 | 0;
      if (theta === 1) { firstX = ix; firstY = iy; }

      if (theta !== 1) {
        path.moveTo(prevX, prevY);
        path.lineTo(x2, y2);
        drew = true;
      }

      prevX = x2;
      prevY = y2;

      if (theta !== 1 && ix === firstX && iy === firstY) { finished = true; }
      else if (theta > MAX_THETA) { finished = true; }   // safety cap (the C's 360*100)

      theta++;
      if (finished) break;
    }

    if (drew) {
      ctx.strokeStyle = strokeStyle;
      ctx.stroke(path);
    }
    return finished;
  }

  // Instant clear to black. (The C runs xscreensaver's erase_window transition
  // here — a wipe candidate for later; for now we just blank the screen.)
  function clearScreen() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // One state-machine step — the C's xspirograph_draw(). Returns the ms to wait
  // before the next step.
  function step() {
    const flipP = (counter & 1) !== 0;   // computed before NEW_LAYER's increment

    switch (drawstate) {
      case 'ERASE1':
        // Hold the finished figures, then erase. The C waits 5 s here but uses
        // the configured `linger` (delay) value to mean "1s..1min"; honour that.
        drawstate = 'ERASE2';
        return config.linger * 1000;

      case 'ERASE2':
        clearScreen();
        drawstate = 'NEW_LAYER';
        // The C leaves the screen black for 1 s after erasing.
        return 1000;

      case 'DRAW': {
        const r2 = flipP ? radius2 : -radius2;
        if (drawFigure(r2)) drawstate = 'NEW_LAYER';
        return Math.max(0, config.subdelay / 1000);
      }

      case 'NEW_LAYER':
        counter++;
        if (counter > 2 * Math.max(1, Math.round(config.layers))) {
          counter = 0;
          drawstate = 'ERASE1';
        } else {
          // pick_new only on the first figure of each pair (even old counter);
          // the second figure reuses the geometry with flipped r2 — but it still
          // needs theta reset to 1, else it starts past MAX_THETA and draws nothing.
          if (!flipP) pickNew(); else theta = 1;
          newColor();
          drawstate = 'DRAW';
        }
        return 0;

      default:
        drawstate = 'NEW_LAYER';
        return 0;
    }
  }

  // Begin a fresh screen with the current config.
  function reset() {
    buildPalette();
    counter = 0;
    theta = 1;
    drawstate = 'NEW_LAYER';
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

  // Variable-delay loop (boxfit-style): step() returns the ms to wait before the
  // next step — config.subdelay normally, or the longer linger/black pauses at a
  // phase change — matching the C's "return microseconds until next call". The
  // canvas persists between steps (segments accumulate), so there is no per-frame
  // repaint; drawing happens inside step().
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
    // never below nextDelay, or a long linger/erase pause would never elapse.
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
    reinit() { nextDelay = 0; reset(); },   // fresh screen with the current config
    config,
    params,
  };
}
