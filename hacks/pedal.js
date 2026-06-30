// pedal.js — pedal packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's pedal.c (Dale Moore, 1994/1995; based on an old
// PDP-11 graphics-display program at CMU; colour added by Jamie Zawinski).
// https://www.jwz.org/xscreensaver/
//
// "The even-odd winding rule." Each round computes ONE closed "pedal" figure —
// a combination spirograph / string-art polar curve r = sin(theta * a) sampled
// only on multiples of b (mod d) — and fills it as a single self-intersecting
// polygon using the even-odd winding rule (XFillPolygon Complex in the C). The
// rose-like figure is held on screen for a few seconds, the screen clears, and
// a fresh figure (new a, b, d, hue) is drawn. The integer triple (a, b, d) and
// the random hue are re-rolled each round.
//
// Rendering: the figure is a genuine filled polygon (the C calls one
// XFillPolygon per round, not incremental line draws), so it uses canvas VECTOR
// ops — the whole point list is accumulated into a Path2D and filled once with
// fill(path, 'evenodd') in the figure's colour. Unlike helix/xspirograph (same
// closed-figure curve family) the curve is NOT swept point-by-point on screen;
// the polygon appears at once, then lingers. We keep the helix/xspirograph
// state-machine + variable-delay loop (NEW_FIGURE -> LINGER -> CLEAR) so the
// hold and the (here instant) erase are paced exactly like the C.

export const title = 'pedal';

export const info = {
  author: 'Dale Moore',
  description: 'The even-odd winding rule.\n\nhttps://en.wikipedia.org/wiki/Even-odd_rule\nhttps://en.wikipedia.org/wiki/Nonzero-rule',
  year: 1994,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/pedal.xml (1:1 with the original).
  // The xml's `delay` slider is the seconds-long hold (labelled "Duration",
  // 1s..1min); `maxlines` (labelled "Lines") caps the integer parameter d and
  // hence how dense/petally a figure can get. The original exposes NO colour
  // knob -- it rolls ONE fully-saturated random hue per figure (see newColor) --
  // so neither do we.
  const config = {
    linger: 5,         // seconds to hold the finished figure before erasing (--delay)
    maxlines: 1000,    // upper bound on d, the figure's period (--maxlines)
  };

  const params = [
    { key: 'linger', label: 'Duration', type: 'range', min: 1, max: 60, step: 1, default: 5, unit: ' s', lowLabel: '1 second', highLabel: '1 minute', live: true },
    { key: 'maxlines', label: 'Lines', type: 'range', min: 100, max: 5000, step: 100, default: 1000, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  // The C's MINLINES: a figure with fewer lines than this "must be ugly and we
  // dont want to see it" — both the lower bound on d and the acceptance floor on
  // numpoints. MAXLINES is the X 16-bit point-count guard (we keep it as a cap).
  const MINLINES = 7;
  const MAXLINES = 16 * 1024;
  // Safety bound on the rejection-sampling loop that hunts for an interesting
  // figure (numpoints > MINLINES). The C loops forever; in practice it finds one
  // in a handful of tries, but cap it so a pathological config can never hang.
  const MAX_TRIES = 200;

  let S = 1;                 // devicePixelRatio
  let W, H;                  // canvas size, device px
  let hWidth, hHeight;       // half extents (figure centre + radius)

  // Current figure state (mirrors the C's struct fields).
  let drawstate;             // 'NEW_FIGURE' | 'LINGER' | 'CLEAR'
  let fillStyle;             // current figure's colour
  let pts;                   // flat [x0,y0, x1,y1, ...] point list for the polygon

  // hsv_to_rgb (utils/hsv.c) -> a CSS "rgb(r,g,b)" string, with the X server's
  // 16-bit -> 8-bit downsample folded in (matches colormap.js's quantization).
  // Same helper as helix.js/xspirograph.js (the curve-family colour path).
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

  // The C's per-figure colour (added by jwz): hsv_to_rgb(random()%360, 1.0, 1.0)
  // -- ONE fresh, fully-saturated, fully-bright random hue per figure. NOT a
  // fixed palette and NOT washed: s = v = 1 means each figure is a pure vivid hue
  // (HSL lightness 50%, min RGB channel 0), matching the live binary's measured
  // figure colour (e.g. (0,55,255): s=1, v=1). The C only skips this under X's
  // mono visual (`if (! mono_p)`), which the gallery never has.
  function newColor() {
    fillStyle = hsvToRgb255(Math.floor(Math.random() * 360), 1, 1);   // random() % 360
  }

  // Euclid's GCD on positive ints — the C's gcd() (its inputs d, b are always
  // >= 1, so the recursion terminates; guarded anyway).
  function gcd(m, n) {
    while (n !== 0) {
      const r = m % n;
      m = n;
      n = r;
    }
    return m < 0 ? -m : m;
  }

  // Random integer in [a, b) — the C's rand_range(a, b) macro.
  function randRange(a, b) {
    return a + Math.floor(Math.random() * (b - a));
  }

  // How many lines (== points) the figure (a, b, d) will draw before it repeats
  // — the C's numlines(): LCM(b,d)/b = d/gcd(d,b), halved first when a, b are
  // both odd and d is even (the crossover at 180 that the C author wasn't sure
  // how to prove). This is an INTEGER count: it bounds the plot loop exactly, so
  // there is no float-equality closure test that could fail to fire.
  function numlines(a, b, d) {
    if ((a & 1) && (b & 1) && !(d & 1)) d = Math.floor(d / 2);
    return Math.floor(d / gcd(d, b));
  }

  // Compute one fresh pedal figure — the C's compute_pedal(). Rejection-samples
  // an integer triple (a, b, d) until the figure has more than MINLINES points
  // (else it's ugly), then evaluates the polar curve r = sin(theta*a*2pi/d) on
  // theta = 0, b, 2b, ... (mod d), converting each (r, theta) to a screen point.
  // Fills `pts` with the flat point list. theta is RESET to 0 every call and the
  // loop runs an exact integer `numpoints` times — the freeze-proof core.
  function computePedal() {
    // Mirror the C's clamp of maxlines into [MINLINES, MAXLINES]; rand_range
    // needs an upper bound strictly above MINLINES, which the xml floor (100)
    // guarantees, but clamp for safety against odd live edits.
    let maxlines = Math.round(config.maxlines);
    if (maxlines < MINLINES + 1) maxlines = MINLINES + 1;
    else if (maxlines > MAXLINES) maxlines = MAXLINES;

    let a = 1, b = 1, d = MINLINES + 1, numpoints = 0;
    for (let tries = 0; tries < MAX_TRIES; tries++) {
      d = randRange(MINLINES, maxlines);
      a = randRange(1, d);
      b = randRange(1, d);
      numpoints = numlines(a, b, d);
      if (numpoints > MINLINES) break;
    }
    // Fallback if rejection sampling never found a pretty figure: a guaranteed
    // non-degenerate triple (b=1 makes numpoints == d > MINLINES). Belt-and-
    // braces — the loop above effectively always succeeds.
    if (numpoints <= MINLINES) {
      d = Math.max(MINLINES + 2, Math.min(maxlines - 1, 360));
      a = randRange(1, d);
      b = 1;
      numpoints = numlines(a, b, d);
    }
    // Cap the polygon size at the X 16-bit limit, exactly as the buffer (and the
    // 2-byte length field) bounded it in the C. numpoints rarely approaches this.
    if (numpoints > MAXLINES) numpoints = MAXLINES;

    pts = new Array(numpoints * 2);
    const twoPiOverD = 2 * Math.PI / d;
    let theta = 0;
    for (let count = 0, idx = 0; count < numpoints; count++) {
      const r = Math.sin(theta * a * twoPiOverD);
      pts[idx++] = Math.sin(theta * twoPiOverD) * r * hWidth + hWidth;
      pts[idx++] = Math.cos(theta * twoPiOverD) * r * hHeight + hHeight;
      theta += b;
      theta %= d;   // d >= MINLINES > 0, so this never divides by zero
    }
  }

  // Build the Path2D from the computed point list and fill it once with the
  // even-odd winding rule — the C's single XFillPolygon(..., Complex, ...). The
  // even-odd rule is exactly what gives the figure its hollowed, rose-like petals
  // (the whole point of the hack, per the .xml description).
  function drawFigure() {
    const path = new Path2D();
    path.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i], pts[i + 1]);
    path.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill(path, 'evenodd');
  }

  // Instant clear to black. (The C runs xscreensaver's erase_window transition
  // here — a wipe candidate for later; for now we just blank the screen.)
  function clearScreen() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // One state-machine step — the C's pedal_draw(). Returns the ms to wait before
  // the next step.
  function step() {
    switch (drawstate) {
      case 'NEW_FIGURE':
        // The C computes a fresh pedal, picks a new hue, fills it, then sets
        // erase_p and waits `delay` seconds before erasing.
        computePedal();
        newColor();
        clearScreen();
        drawFigure();
        drawstate = 'LINGER';
        return config.linger * 1000;

      case 'LINGER':
        // Hold elapsed; erase next. (Kept as its own state so resume after a
        // long pause re-banks the linger cleanly, like helix/xspirograph.)
        drawstate = 'CLEAR';
        return 0;

      case 'CLEAR':
        clearScreen();
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
    drawstate = 'NEW_FIGURE';
    clearScreen();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    hWidth = W / 2;
    hHeight = H / 2;
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
  // wait before the next step — a few-second linger after each figure, a 1 s
  // black pause after the erase — matching the C's "return microseconds until
  // next call". The canvas persists between steps, so there is no per-frame
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
