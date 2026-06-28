// sphere.js — sphere packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's sphere.c (Tom Duff, original algorithm 1982 at
// Lucasfilm; turned into a standalone XScreenSaver hack by Jamie Zawinski,
// 1997; xlock version David Bagley, 1993; Copyright 1988 Sun Microsystems).
// https://www.jwz.org/xscreensaver/
//
// Draws a bunch of shaded spheres in random colours. Each sphere is painted
// onto the canvas column-by-column (or row-by-row) by a line that sweeps
// across it — you watch each ball get "wiped" into existence — and the balls
// accumulate over the black background until the screen is full, then it wipes
// to black and starts a fresh layout. A single, fixed off-axis light source
// (the C's NX,NY,NZ vector, length 100) shades every sphere from the same
// direction; a per-session sign flip (shadowx/shadowy) chooses which way.
//
// Rendering: the C dithers/stipples each sphere with a density that follows the
// Lambert term N.L over the surface (a random-threshold halftone). Canvas has
// no cheap per-pixel stipple, so — as the porter brief directs — each sphere is
// drawn as a single offset RADIAL GRADIENT: bright highlight toward the light,
// fading to a dark rim, which reads as a lit, round ball. The sweeping reveal
// is preserved by clipping each step's gradient fill to a thin strip of the
// circle (vector, sparse, cheap: one clipped arc-fill per step). See sphere.md
// for the full list of deviations. Closest twin: scooter.js (vector, sparse,
// periodic reposition).

export const title = 'sphere';

export const info = {
  author: 'Tom Duff and Jamie Zawinski',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nDraws shaded spheres in multiple colors.',
  year: 1982,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/sphere.xml so the config box maps 1:1.
  // sphere.xml exposes only delay (--delay) and ncolors (--ncolors); the C's
  // DEFAULTS cycles/size are dead knobs the hack never reads, so we drop them.
  const config = {
    delay: 20000,   // µs between sweep steps (--delay)
    ncolors: 64,    // colour-ramp richness; <=2 renders grey spheres (--ncolors)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // Light source vector (NX, NY, NZ), length NR == 100, verbatim from sphere.c.
  // Screen y is down, so NY = -36 puts the highlight up-and-to-the-right.
  const NX = 48;
  const NY = -36;
  const NZ = 80;
  const NR = 100;

  const TWO_PI = Math.PI * 2;
  const nrand = (n) => Math.floor(Math.random() * n);

  let S = 1;              // devicePixelRatio
  let W, H;               // canvas size, device px
  let shadowx, shadowy;   // light sign flip, fixed per session (as the C does)
  let palette;            // array of hues (degrees)
  let sphere;             // the sphere currently being swept onto the canvas
  let coverage;           // accumulated sphere area since the last wipe
  let clearThreshold;     // wipe to black once coverage passes this

  // Pick a fresh sphere: position anywhere (often clipped at the screen edge,
  // exactly as the C's NRAND(width)/NRAND(height) does), a pleasant random
  // radius, a sweep axis+direction, and a colour. The sweep range [pLo,pHi] is
  // the on-screen chord of the circle along the sweep axis (center-relative),
  // matching the C's window clamping of its line sweep.
  function newSphere() {
    const minDim = Math.min(W, H);
    // C allows radius 1..minDim/2; we keep a visibly-round range (see .md).
    const r = (0.05 + 0.30 * Math.random()) * minDim;
    const cx = nrand(W);
    const cy = nrand(H);
    const axis = (nrand(2) === 0) ? 'x' : 'y';
    const dir = (nrand(2) === 0) ? 1 : -1;

    const gray = config.ncolors <= 2;
    const hue = gray ? 0 : palette[nrand(palette.length)];
    const grad = makeGradient(cx, cy, r, hue, gray);

    let pLo, pHi;
    if (axis === 'x') {
      pLo = Math.max(-r, -cx);
      pHi = Math.min(r, W - 1 - cx);
    } else {
      pLo = Math.max(-r, -cy);
      pHi = Math.min(r, H - 1 - cy);
    }

    // Sweep reveal a touch faster for bigger balls so reveal time stays calm
    // (~1-2 s/ball) regardless of radius or display resolution.
    const speed = Math.max(2 * S, r / 40);

    sphere = {
      cx,
      cy,
      r,
      axis,
      dir,
      grad,
      speed,
      p: dir > 0 ? pLo : pHi,   // current sweep edge (center-relative)
      pEnd: dir > 0 ? pHi : pLo,
    };
  }

  // Offset radial gradient: inner circle a small hotspot at the highlight
  // point (center + light direction * radius), outer circle the sphere itself,
  // so the rim is dark — a lit, round ball lit from a single direction.
  function makeGradient(cx, cy, r, hue, gray) {
    const hlx = cx + (NX * shadowx / NR) * r;
    const hly = cy + (NY * shadowy / NR) * r;
    const g = ctx.createRadialGradient(hlx, hly, r * 0.04, cx, cy, r);
    if (gray) {
      g.addColorStop(0.00, '#ffffff');
      g.addColorStop(0.12, '#d8d8d8');
      g.addColorStop(0.50, '#8a8a8a');
      g.addColorStop(1.00, '#0a0a0a');
    } else {
      g.addColorStop(0.00, `hsl(${hue}, 70%, 96%)`);
      g.addColorStop(0.10, `hsl(${hue}, 90%, 78%)`);
      g.addColorStop(0.45, `hsl(${hue}, 100%, 50%)`);
      g.addColorStop(0.80, `hsl(${hue}, 100%, 30%)`);
      g.addColorStop(1.00, `hsl(${hue}, 100%, 6%)`);
    }
    return g;
  }

  // Paint the strip of `s` between center-relative coords a..b (a <= b): clip to
  // that strip AND to the circle, then fill the sphere's gradient. Opaque, so
  // overlapping an earlier ball overwrites it within the circle (as the C's
  // per-column black line + stipple does) without touching anything outside.
  function reveal(s, a, b) {
    if (b <= a) b = a + 1;   // always paint at least one column/row
    ctx.save();
    ctx.beginPath();
    if (s.axis === 'x') {
      ctx.rect(s.cx + a, s.cy - s.r - 1, b - a, 2 * s.r + 2);
    } else {
      ctx.rect(s.cx - s.r - 1, s.cy + a, 2 * s.r + 2, b - a);
    }
    ctx.clip();
    ctx.fillStyle = s.grad;
    ctx.beginPath();
    ctx.arc(s.cx, s.cy, s.r, 0, TWO_PI);
    ctx.fill();
    ctx.restore();
  }

  // A sphere finished sweeping: bank its area, wipe to black if the screen is
  // full, then start the next one. Pure bookkeeping — always advances, so the
  // loop can never stall on a degenerate (off-screen / zero-width) sweep.
  function finishSphere() {
    coverage += Math.PI * sphere.r * sphere.r;
    if (coverage >= clearThreshold) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      coverage = 0;
    }
    newSphere();
  }

  // One step: extend the current sphere's reveal by `speed` along its axis.
  function step() {
    const s = sphere;
    if (s.dir > 0) {
      const from = s.p;
      const to = Math.min(s.p + s.speed, s.pEnd);
      reveal(s, from, to);
      s.p = to;
      if (s.p >= s.pEnd - 1e-6) finishSphere();
    } else {
      const to = s.p;
      const from = Math.max(s.p - s.speed, s.pEnd);
      reveal(s, from, to);
      s.p = from;
      if (s.p <= s.pEnd + 1e-6) finishSphere();
    }
  }

  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    palette = [];
    for (let i = 0; i < n; i++) palette.push(i * 360 / n);
  }

  // Reveal a whole sphere at once (for pre-filling the first frame so it isn't
  // a near-empty screen while the first ball sweeps in).
  function drawFullSphere() {
    newSphere();
    const lo = Math.min(sphere.p, sphere.pEnd);
    const hi = Math.max(sphere.p, sphere.pEnd);
    reveal(sphere, lo, hi);
    coverage += Math.PI * sphere.r * sphere.r;
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // One fixed light direction for the whole session, like init_sphere().
    shadowx = (nrand(2) === 0) ? 1 : -1;
    shadowy = (nrand(2) === 0) ? 1 : -1;

    buildPalette();
    coverage = 0;
    clearThreshold = W * H * 1.8;   // wipe after ~1.8 screens of balls

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    // Pre-fill a few complete spheres so frame 1 already looks populated, then
    // start sweeping a fresh one in.
    for (let i = 0; i < 3; i++) drawFullSphere();
    newSphere();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator loop paced by config.delay (µs in the xml, divided
  // by 1000 for the ms rAF clock), with the same catch-up cap as squiral so a
  // backgrounded tab doesn't burst on refocus. Each step is one cheap clipped
  // arc-fill (plus an occasional full-screen wipe).
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = config.delay / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (clears the canvas; the palette and grey/
  // colour mode may have changed).
  function reinit() {
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
    pause() { cancelAnimationFrame(rafId); rafId = 0; },
    resume() { if (!rafId) { lastTime = 0; rafId = requestAnimationFrame(frame); } },
    reinit,
    config,
    params,
  };
}
