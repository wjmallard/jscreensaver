// rorschach.js — rorschach packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }; the
// host renders the config box from `config`/`params`.
//
// Port of xscreensaver's rorschach.c (Jamie Zawinski, 1992-2014).
// https://www.jwz.org/xscreensaver/
//
// A reflected random walk: a single dot wanders from the centre, each step
// nudged by +/- `offset` in x and y, and every dot is stamped with optional
// X and/or Y mirror symmetry — so the random walk grows a symmetric inkblot.
// After `iterations` steps the blot lingers a few seconds, the screen clears,
// a fresh hue is chosen and a new blot begins.
//
// Rendering note: this is a SPARSE accumulating draw — at most four small
// rectangles per walk step, fillRect'd straight onto the persistent canvas
// (which holds the blot between steps), so no per-pixel buffer is needed. The
// canvas itself is the accumulator, like the C's window.

export const title = 'rorschach';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Inkblot patterns via a reflected random walk.\n\nhttps://en.wikipedia.org/wiki/Rorschach_inkblot_test\nhttps://en.wikipedia.org/wiki/Random_walk',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Configuration. Units and defaults match xscreensaver's
  // hacks/config/rorschach.xml so the tuning UI maps 1:1 to the original.
  const config = {
    iterations: 4000,   // walk steps per blot (--iterations)
    offset: 7,          // max +/- jump per axis per step (--offset)
    xsymmetry: true,    // mirror across the vertical centre line (--xsymmetry)
    ysymmetry: false,   // mirror across the horizontal centre line (--ysymmetry)
    linger: 5,          // seconds the finished blot lingers (xml "Linger", --delay)
    delay: 20000,       // microseconds between walk chunks (the C's hardcoded pace)
  };

  // Ranges/defaults/labels transcribed from hacks/config/rorschach.xml.
  // live: true  -> the loop reads config every step, so it applies instantly.
  // live: false -> the value seeds the walk/colors, so changing it re-runs
  //                init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'iterations', label: 'Iterations', type: 'range', min: 100, max: 10000, step: 100, default: 4000, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'offset', label: 'Offset', type: 'range', min: 1, max: 50, step: 1, default: 7, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'linger', label: 'Linger', type: 'range', min: 1, max: 60, step: 1, default: 5, unit: ' s', lowLabel: '1 second', highLabel: '1 minute', live: true },
    { key: 'xsymmetry', label: 'With X symmetry', type: 'checkbox', default: true, live: true },
    { key: 'ysymmetry', label: 'With Y symmetry', type: 'checkbox', default: false, live: true },
  ];

  // The C plots dots in chunks of 300 walk steps per draw call so a 4000-step
  // blot accretes visibly over a dozen-odd frames instead of in one flash.
  const ITER_CHUNK = 300;

  let W, H, S;                       // backing-store size + retina scale
  let scale;                         // dot size in device px (C's st->scale)
  let curX, curY;                    // current walk position
  let remaining;                     // walk steps left in this blot
  let lingering;                     // true while holding the finished blot

  // Pick a fresh fully-saturated hue and reset the walk to the centre, mirroring
  // the C's rorschach_draw_start(). Returns nothing; seeds curX/curY/remaining.
  function startBlot() {
    ctx.fillStyle = `hsl(${Math.floor(Math.random() * 360)}, 100%, 50%)`;
    curX = Math.floor(W / 2);
    curY = Math.floor(H / 2);
    remaining = Math.max(10, Math.round(config.iterations));
    lingering = false;
  }

  // Stamp one dot plus its mirror images. fillStyle is already the blot's hue.
  function plot(x, y) {
    ctx.fillRect(x, y, scale, scale);
    if (config.xsymmetry) ctx.fillRect(W - x, y, scale, scale);
    if (config.ysymmetry) ctx.fillRect(x, H - y, scale, scale);
    if (config.xsymmetry && config.ysymmetry) ctx.fillRect(W - x, H - y, scale, scale);
  }

  // One chunk of the random walk — the C's rorschach_draw_step(). offset and the
  // symmetry flags are read live; scale is the device-px dot size.
  function walkChunk() {
    const offset = Math.max(1, Math.round(config.offset)) * scale;
    const span = 1 + offset * 2;     // random() % span gives [0, 2*offset]
    let x = curX;
    let y = curY;

    let n = ITER_CHUNK;
    if (n > remaining) n = remaining;

    for (let i = 0; i < n; i++) {
      x += Math.floor(Math.random() * span) - offset;
      y += Math.floor(Math.random() * span) - offset;
      plot(x, y);
    }

    remaining -= n;
    if (remaining < 0) remaining = 0;
    curX = x;
    curY = y;
  }

  // One state-machine step — the C's rorschach_draw(). Returns the ms to wait
  // before the next step (the C returns microseconds-until-next-call).
  function step() {
    if (lingering) {
      // The C erases with a scrolling helix transition here; the web has no X11
      // GC eraser, so clear to black instantly (noted in the .md) and begin the
      // next blot. The black pause before the new walk matches the C's flow.
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, W, H);
      startBlot();
      return 0;
    }

    if (remaining > 0) {
      walkChunk();
      if (remaining === 0) {
        // Blot finished: hold it for `linger` seconds, then clear next step.
        lingering = true;
        return Math.max(1, config.linger) * 1000;
      }
      return Math.max(1, config.delay / 1000);
    }

    // Defensive: remaining already 0 and not lingering — start a blot.
    startBlot();
    return 0;
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    // The C bumps dot size to 3px on >2560px (retina) displays; fold dpr in the
    // same way so dots stay a consistent CSS size and crisp on hidpi.
    scale = (W > 2560 || H > 2560) ? Math.round(3 * S) : Math.max(1, Math.round(S));
    nextDelay = 0;
    startBlot();
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

  // Variable-delay loop (xspirograph-style): step() returns the ms to wait
  // before the next step — config.delay between walk chunks, or the longer
  // `linger` hold once a blot finishes — matching the C's "return microseconds
  // until next call". The canvas persists between steps (dots accumulate), so
  // drawing happens inside step(), not a per-frame repaint.
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
    // never below nextDelay, or a multi-second linger would never elapse.
    acc = Math.min(acc, nextDelay + 1000);

    let steps = 0;
    while (acc >= nextDelay && steps < MAX_CATCHUP_STEPS) {
      acc -= nextDelay;
      nextDelay = step();
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Rebuild after a non-live config change (clears the canvas because the dot
  // size / iteration count may have changed, then re-seeds via init()).
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
    pause() { cancelAnimationFrame(rafId); rafId = 0; },
    resume() { if (!rafId) { lastTime = 0; rafId = requestAnimationFrame(frame); } },
    reinit,   // fresh blot with the current config
    config,   // host renders the config box from these
    params,
  };
}
