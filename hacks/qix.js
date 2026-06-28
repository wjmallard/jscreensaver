// qix.js — qix packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's qix.c (Jamie Zawinski, 1992).
// https://www.jwz.org/xscreensaver/
//
// Bounces a polygonal "line" (a ring of `poly` vertices, default 2 = a plain
// segment) around the screen: each frame every vertex advances by its velocity
// and reflects off the walls, the new polygon is drawn, and the oldest of a
// fixed-length trailing queue is erased — the classic Qix ribbon. The hue shifts
// a little each frame, so the live trail is a smooth rainbow band. With `solid`
// (default) and a 2-vertex line, consecutive frames are joined into filled quads
// for the solid-ribbon look; `hollow` strokes the polygon outline instead.
//
// Rendering: sparse vector ops (one quad fill or one polyline per frame per qix),
// matching the C's draw-newest / erase-oldest scheme — far cheaper than clearing
// and redrawing the whole queue every frame, and it keeps the older trail intact.

export const title = 'qix';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Bounces a series of line segments around the screen with various presentations.\n\nhttps://en.wikipedia.org/wiki/Qix',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/qix.xml so the config box maps 1:1,
  // except `count` is dialled down (4 overlapping ribbons is busy on a bright
  // canvas) and `delay` is left at the stock 10 ms.
  const config = {
    delay: 10000,    // \u00B5s between steps (--delay)
    segments: 250,   // trail length: polygons kept on screen (--segments)
    spread: 8,       // max per-vertex velocity, logical px/step (--spread)
    colorShift: 3,   // hue degrees added per frame (--color-shift)
    size: 200,       // max extent between the 2 points; only for poly=2 (--size)
    poly: 2,         // vertices per polygon; 2 = a line segment (--poly)
    count: 2,        // number of independent qixes (--count)
    fill: 'solid',   // 'solid' = fill quads between frames (poly=2) vs. 'hollow' outline (--solid/--hollow)
    motion: 'linear', // 'linear' = clean bounces vs. 'random' velocity jitter (--linear/--random)
    gravity: false,  // pull every vertex downward each step (--gravity)
  };

  // live: true  -> the loop reads config every step (applies instantly).
  // live: false -> the value sizes the queue / vertex count / qix count, so a
  //                change re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'segments', label: 'Segments', type: 'range', min: 10, max: 500, step: 10, default: 250, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'spread', label: 'Density', type: 'range', min: 1, max: 50, step: 1, default: 8, invert: true, lowLabel: 'sparse', highLabel: 'dense', live: true },
    { key: 'colorShift', label: 'Color contrast', type: 'range', min: 0, max: 25, step: 1, default: 3, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Count', type: 'range', min: 1, max: 12, step: 1, default: 2, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'size', label: 'Max size', type: 'range', min: 50, max: 1000, step: 10, default: 200, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'poly', label: 'Poly corners', type: 'range', min: 2, max: 24, step: 1, default: 2, lowLabel: 'line', highLabel: 'many', live: false },
    { key: 'fill', label: 'Fill', type: 'select', options: [
        { value: 'solid', label: 'Solid objects' },
        { value: 'hollow', label: 'Line segments' },
      ], default: 'solid', live: false },
    { key: 'motion', label: 'Motion', type: 'select', options: [
        { value: 'linear', label: 'Linear motion' },
        { value: 'random', label: 'Random motion' },
      ], default: 'linear', live: true },
    { key: 'gravity', label: 'Gravity', type: 'checkbox', default: false, live: true },
  ];

  const MAXPOLY = 24;     // hard cap on vertices (the C's MAXPOLY is 16)
  const GRAVITY = 0.5;    // dy added per step under gravity (the C adds 3 in <<6 units ~= 0.05 px; bumped to read)

  let S = 1;              // devicePixelRatio
  let W, H;               // canvas size, device px
  let maxSpread;          // velocity clamp, device px (config.spread * S)
  let maxSize;            // extent clamp, device px (config.size * S); 0 = off
  let npoly;              // effective vertices per polygon (after constraints)
  let nlines;             // queue length (== config.segments)
  let solid;              // effective solid flag (forced off when npoly > 2)
  let qixes;              // array of independent qix states

  function nrand(n) {
    return Math.floor(Math.random() * n);
  }

  // hsl() string for an integer hue (degrees). Bright, saturated rainbow.
  function hueColor(h) {
    return `hsl(${((h % 360) + 360) % 360}, 100%, 55%)`;
  }

  // Seed one qix: a ring buffer of `nlines` frames, each frame holding `npoly`
  // vertices (x, y, dx, dy). Frame 0 is randomised; every other frame is a copy
  // of it (the C's init_one_qix), so the trail starts collapsed at one polygon
  // and unfurls as the simulation runs.
  function initOneQix() {
    const frames = new Array(nlines);
    for (let i = 0; i < nlines; i++) {
      frames[i] = {
        x: new Float64Array(npoly),
        y: new Float64Array(npoly),
        dx: new Float64Array(npoly),
        dy: new Float64Array(npoly),
        dead: true,
      };
    }

    const f0 = frames[0];
    if (maxSize === 0) {
      for (let i = 0; i < npoly; i++) {
        f0.x[i] = nrand(W);
        f0.y[i] = nrand(H);
      }
    } else {
      // poly == 2: anchor point 0 anywhere, point 1 a bounded offset away.
      f0.x[0] = nrand(W);
      f0.y[0] = nrand(H);
      f0.x[1] = Math.min(f0.x[0] + nrand(maxSize / 2), W);
      f0.y[1] = Math.min(f0.y[0] + nrand(maxSize / 2), H);
    }
    for (let i = 0; i < npoly; i++) {
      f0.dx[i] = nrand(maxSpread + 1) - maxSpread / 2;
      f0.dy[i] = nrand(maxSpread + 1) - maxSpread / 2;
    }

    // Copy frame 0 into all the others (vertices, velocities, dead flag).
    for (let i = 1; i < nlines; i++) {
      frames[i].x.set(f0.x);
      frames[i].y.set(f0.y);
      frames[i].dx.set(f0.dx);
      frames[i].dy.set(f0.dy);
    }

    return {
      frames,
      fp: 0,                                  // next write slot
      hue: nrand(360),                        // current frame hue (degrees)
    };
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    nlines = Math.max(2, Math.round(config.segments));
    maxSpread = Math.max(1, config.spread) * S;
    solid = config.fill === 'solid';

    // Constraint resolution, straight from qix_init():
    //   - solid forces a 2-vertex polygon (the quad fill needs exactly 2 points);
    //   - >2 vertices forces size off (the extent clamp is a 2-point notion).
    npoly = Math.max(2, Math.min(MAXPOLY, Math.round(config.poly)));
    if (solid) npoly = 2;
    maxSize = config.size > 0 ? config.size * S : 0;
    if (npoly > 2) maxSize = 0;

    const count = Math.max(1, Math.round(config.count));
    qixes = [];
    for (let i = 0; i < count; i++) qixes.push(initOneQix());

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // Advance one vertex coordinate by its velocity and reflect off [0, max].
  // Returns the post-bounce [point, delta]. Mirrors the C's `wiggle` macro:
  // optional velocity jitter (random motion), clamp the velocity to ±maxSpread,
  // step, then on a wall hit pin to the wall and reflect (point += 2*|delta|).
  function wiggle(point, delta, max) {
    if (config.motion === 'random') {
      delta += (Math.random() * (2 * S) - S);   // C: rand%(1<<(SCALE+1)) - (1<<SCALE)
    }
    if (delta > maxSpread) delta = maxSpread;
    else if (delta < -maxSpread) delta = -maxSpread;
    point += delta;
    if (point < 0) {
      delta = -delta;
      point = delta * 2;            // point was set to 0, then += delta<<1
    } else if (point > max) {
      delta = -delta;
      point = max + delta * 2;      // point was set to max, then += delta<<1
    }
    return [point, delta];
  }

  // Draw (or erase, when ctx.fillStyle/strokeStyle is black) one polygon frame.
  // Solid mode fills the quad between this frame and `prev` (the classic ribbon);
  // hollow mode strokes the closed polygon outline.
  function drawFrame(frame, prev, paint) {
    if (solid) {
      if (!prev || prev.dead) return;        // no quad without a partner frame
      ctx.fillStyle = paint;
      ctx.beginPath();
      ctx.moveTo(frame.x[0], frame.y[0]);
      ctx.lineTo(frame.x[1], frame.y[1]);
      ctx.lineTo(prev.x[1], prev.y[1]);
      ctx.lineTo(prev.x[0], prev.y[0]);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.strokeStyle = paint;
      ctx.lineWidth = Math.max(1, S);
      ctx.beginPath();
      ctx.moveTo(frame.x[0], frame.y[0]);
      for (let i = 1; i < npoly; i++) ctx.lineTo(frame.x[i], frame.y[i]);
      ctx.closePath();
      ctx.stroke();
    }
  }

  // One step for one qix (the C's qix1 + add_qline + free_qline, with redraw-
  // erase instead of X11 GCs): erase the polygon about to be overwritten, build
  // the new polygon from the previous frame's vertices (bounced + hue-shifted),
  // draw it, and advance the write pointer.
  function stepQix(q) {
    const frames = q.frames;
    const fp = q.fp;
    const ofp = (fp - 1 + nlines) % nlines;      // previous (source) frame
    const old = frames[fp];                      // oldest frame, being recycled
    const oldPrev = frames[(fp + 1) % nlines];   // its solid-quad partner

    // Erase the outgoing polygon in black (the C's free_qline). Skip while the
    // trail is still collapsed on its seed frame (dead), so we don't erase what
    // we haven't drawn yet.
    if (!old.dead) drawFrame(old, oldPrev, '#000');

    // Build the new frame from the previous one (the C's add_qline).
    const src = frames[ofp];
    const f = frames[fp];
    f.x.set(src.x);
    f.y.set(src.y);
    f.dx.set(src.dx);
    f.dy.set(src.dy);

    if (config.gravity) {
      for (let i = 0; i < npoly; i++) f.dy[i] += GRAVITY * S;
    }

    for (let i = 0; i < npoly; i++) {
      let r = wiggle(f.x[i], f.dx[i], W);
      f.x[i] = r[0];
      f.dx[i] = r[1];
      r = wiggle(f.y[i], f.dy[i], H);
      f.y[i] = r[0];
      f.dy[i] = r[1];
    }

    // Extent clamp for poly == 2 with a max size (the C's max_size block): keep
    // the two endpoints within `maxSize` on each axis.
    if (maxSize) {
      const jitter = () => (config.motion === 'random' ? nrand(maxSpread) : 0);
      if (f.x[0] - f.x[1] > maxSize) f.x[0] = f.x[1] + maxSize - jitter();
      else if (f.x[1] - f.x[0] > maxSize) f.x[1] = f.x[0] + maxSize - jitter();
      if (f.y[0] - f.y[1] > maxSize) f.y[0] = f.y[1] + maxSize - jitter();
      else if (f.y[1] - f.y[0] > maxSize) f.y[1] = f.y[0] + maxSize - jitter();
    }

    // Shift the hue and draw the new polygon (the C cycles the XColor by
    // colorShift degrees; here the frame just carries an integer hue).
    q.hue = (q.hue + config.colorShift) % 360;
    f.dead = false;
    drawFrame(f, frames[ofp], hueColor(q.hue));

    q.fp = (fp + 1) % nlines;
  }

  function step() {
    for (const q of qixes) stepQix(q);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced by config.delay (µs): run one step() per delay,
  // banking leftover time so the speed is identical at any refresh rate. Cap
  // catch-up so a backgrounded tab doesn't burst a run of steps on refocus.
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

  // Rebuild after a non-live config change (clears the canvas, re-seeds).
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
