// piecewise.js — piecewise packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's piecewise.c (Geoffrey Irving, 2003).
// https://www.jwz.org/xscreensaver/
//
// A set of circles drifts around the screen, bouncing off the walls. Each
// frame the original computes the exact arrangement of all circle boundaries
// (a Bentley-Ottmann plane sweep over splay trees) to find every point where
// two outlines cross. Each circle's outline is cut at its crossing points
// into arcs that alternate visible/invisible — so outlines invert wherever
// circles overlap — and a per-circle parity bit carried between frames (the
// alternating-sum test in adjust_circle_visibility) keeps each arc's
// visibility continuous as the crossings slide around the boundary. All arcs
// are stroked in ONE shared colour that slowly walks a 256-entry
// red->green->blue->red hue loop (make_color_loop), advancing one entry
// every 100/colorspeed frames.
//
// The port keeps the sweep's output contract but computes it directly: at
// count <= 100 circles an O(n^2) pairwise pass (the same closed form as
// fringe_intersect, ~500 pairs at the default 32) is far below a frame
// budget, so the splay trees, event queue, and the degeneracy tweaks they
// require are unnecessary — the per-circle sorted crossing-angle lists and
// the parity logic are transcribed exactly. Angles stay float radians rather
// than the C's integer 64ths-of-a-degree (a quantization the X11 arc API
// forced); canvas arcs share atan2's y-down clockwise convention, so the
// angles feed straight in without the sign flip XDrawArcs needed. The C
// double-buffers via DBE; a rAF canvas already swaps tear-free, so the
// erase+redraw goes straight to the canvas.

import { makeColorRampRGB } from './colormap.js';

export const title = 'piecewise';

export const info = {
  author: 'Geoffrey Irving',
  description: 'Moving circles switch from visibility to invisibility at intersection points.',
  year: 2003,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/piecewise.xml 1:1 (its only knobs).
  const config = {
    delay: 10000,     // microseconds between frames (--delay), stock
    count: 32,        // number of circles (--count)
    colorspeed: 10,   // hue-loop advance rate, 0..100 (--colorspeed)
    minradius: 0.05,  // smallest radius as a fraction of height (--minradius)
    maxradius: 0.2,   // largest radius as a fraction of height (--maxradius)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Count', type: 'range', min: 4, max: 100, step: 1, default: 32, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'colorspeed', label: 'Color shift', type: 'range', min: 0, max: 100, step: 1, default: 10, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'minradius', label: 'Minimum radius', type: 'range', min: 0.01, max: 0.5, step: 0.01, default: 0.05, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'maxradius', label: 'Maximum radius', type: 'range', min: 0.01, max: 0.5, step: 0.01, default: 0.2, lowLabel: 'small', highLabel: 'large', live: false },
  ];

  // Resources with no xml knob, from piecewise_defaults: *speed:15 scales
  // every circle's velocity; *ncolors:256 sizes the hue loop.
  const SPEED = 15;
  const NCOLORS = 256;

  const TAU = Math.PI * 2;

  // frand(x) -> float in [0, x), matching the C helper.
  const frand = (x) => Math.random() * x;
  const ascending = (u, v) => u - v;

  let S = 1;             // devicePixelRatio
  let W, H;              // canvas size, device px
  let circles;           // array of { r, x, y, dx, dy, visible, i, newI }
  let palette;           // 256 CSS colours (built once; deterministic)
  let colorIndex;        // current position in the hue loop (color_index)
  let iterations;        // frame counter driving the hue cadence

  // make_color_loop(0,1,1, 120,1,1, 240,1,1, ncolors=256): make_color_path
  // over three equally-spaced full-S/V anchors splits the count into three
  // equal edges of trunc(256/3) = 85 colours — each an open hue ramp
  // stepping 120/85 degrees — then pads the float-round-off remainder by
  // repeating the last colour (colors.c). Net: a uniform full-saturation
  // full-value HSV rainbow loop. No RNG involved, so building it once per
  // session matches piecewise_init exactly.
  function makeColorLoop() {
    const third = Math.trunc(NCOLORS / 3);
    const colors = [
      ...makeColorRampRGB(0, 1, 1, 120, 1, 1, third, false),
      ...makeColorRampRGB(120, 1, 1, 240, 1, 1, third, false),
      ...makeColorRampRGB(240, 1, 1, 360, 1, 1, third, false),
    ];
    while (colors.length < NCOLORS) colors.push(colors[colors.length - 1]);
    return colors.map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);
  }

  // color_iterations = colorspeed ? 100/colorspeed : 100000, clamped to >= 1
  // (integer division, so colorspeed > 100 also lands on 1). Recomputed from
  // config so the slider applies live; at any fixed value it matches the C's
  // init-time constant.
  function colorIterations() {
    const cs = Math.round(config.colorspeed);
    const ci = cs ? Math.trunc(100 / cs) : 100000;
    return ci > 0 ? ci : 1;
  }

  // init_circles: integer radii in the band ceil(minradius*h) ..
  // floor(maxradius*h); centres seeded fully inside the field; velocity
  // (1 + frand(.5)) * speed/10 at a random heading (scaled by dpr so drift
  // covers the same logical distance on retina); default visibility is the
  // C's random() & 1 coin flip. `i` is the previous frame's sorted
  // crossing-angle list (empty at birth, like the calloc'd struct).
  function initCircles() {
    const n = Math.max(1, Math.round(config.count));
    const minR = config.minradius;
    const maxR = Math.max(config.maxradius, minR);

    const r0 = Math.ceil(minR * H);
    const dr = Math.floor(maxR * H) - r0 + 1;

    circles = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = r0 + (dr > 0 ? Math.floor(Math.random() * dr) : 0);
      const a = frand(TAU);
      const v = (1 + frand(0.5)) * SPEED / 10.0 * S;
      circles[i] = {
        r,
        x: r + frand(W - 1 - 2 * r),
        y: r + frand(H - 1 - 2 * r),
        dx: v * Math.cos(a),
        dy: v * Math.sin(a),
        visible: Math.random() < 0.5 ? 1 : 0,
        i: [],        // last frame's sorted crossing angles
        newI: null,   // this frame's, rebuilt by the sweep
      };
    }
  }

  // move_circle: advance, and reflect off each wall, clamping back inside so
  // a circle never escapes the field.
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

  // fringe_intersect's closed form: the two points where the boundaries of
  // circles A and B cross. d <= 0 rejects every no-crossing case (separate,
  // tangent, one inside the other); sd == 0 rejects concentric centres.
  // Each crossing records its angle on BOTH circles, like the sweep adding
  // the CROSS event to both fringes.
  function intersect(A, B) {
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const sd = dx * dx + dy * dy;
    if (sd === 0) return;
    const rs = B.r + A.r;
    const rd = B.r - A.r;
    const d = (rd * rd - sd) * (sd - rs * rs);
    if (d <= 0) return;
    const k = 0.5 / sd;
    const rp = rs * rd;
    const sqd = Math.sqrt(d);
    const sx = (A.x + B.x) / 2;
    const sy = (A.y + B.y) / 2;
    let px = sx + k * (dy * sqd - dx * rp);
    let py = sy - k * (dx * sqd + dy * rp);
    addAngle(A, px, py);
    addAngle(B, px, py);
    px = sx - k * (dy * sqd + dx * rp);
    py = sy + k * (dx * sqd - dy * rp);
    addAngle(A, px, py);
    addAngle(B, px, py);
  }

  // fringe_add_intersection + the lo-branch remap in
  // adjust_circle_visibility: right-branch points (px >= centre) keep their
  // atan2 in [-pi/2, pi/2]; left-branch points are lifted into
  // (pi/2, 3pi/2] — so the sorted list runs continuously around the
  // boundary, wrapping at the circle's topmost point.
  function addAngle(c, px, py) {
    let th = Math.atan2(py - c.y, px - c.x);
    if (px < c.x && th <= 0) th += TAU;
    c.newI.push(th);
  }

  // adjust_circle_visibility: merge last frame's sorted angle list with this
  // frame's and form the alternating sum a = m - a (largest term positive).
  // Crossings move only slightly between frames, so paired old/new angles
  // nearly cancel; the sum exceeds pi exactly when the arrangement shifted
  // parity at the list's wrap point (e.g. a crossing slid past the circle's
  // top), which is when the anchor bit must flip to keep every arc's
  // visibility continuous.
  function adjustVisibility(c) {
    const oldI = c.i;
    const newI = c.newI;
    let i = 0;
    let j = 0;
    let a = 0;
    while (i < newI.length && j < oldI.length) a = (newI[i] < oldI[j] ? newI[i++] : oldI[j++]) - a;
    while (i < newI.length) a = newI[i++] - a;
    while (j < oldI.length) a = oldI[j++] - a;
    if (a > Math.PI) c.visible ^= 1;
    c.i = newI;
    c.newI = null;
  }

  // One boundary arc appended to the frame's batched path (the C batches
  // XArcs the same way and flushes one XDrawArcs). Canvas measures arc
  // angles exactly like our atan2 (y-down, clockwise-positive), so a1..a2
  // covers the same pixels the C's negated XDrawArcs angles did.
  function arcSeg(c, a1, a2) {
    ctx.moveTo(c.x + c.r * Math.cos(a1), c.y + c.r * Math.sin(a1));
    ctx.arc(c.x, c.y, c.r, a1, a2, false);
  }

  // draw_circle: cut the outline at its sorted crossing angles; segments
  // alternate drawn/undrawn, with the visibility bit anchoring the parity on
  // the wrap segment (last angle around the top to the first). No crossings
  // means the whole outline is drawn or hidden outright.
  function drawCircle(c) {
    adjustVisibility(c);
    const li = c.i;
    const n = li.length;
    if (!n) {
      if (c.visible) arcSeg(c, 0, TAU);
      return;
    }
    if (c.visible) arcSeg(c, li[n - 1], li[0] + TAU);
    for (let p = 1; p < n; p++) {
      if ((p & 1) ^ c.visible) arcSeg(c, li[p - 1], li[p]);
    }
  }

  // One frame of piecewise_draw: erase, sweep, then per circle draw its
  // visible arcs (all in the one shared colour) and move it; finally advance
  // the hue loop on its cadence.
  function step() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    // sweep(): every pair's boundary crossings -> per-circle sorted angles.
    const n = circles.length;
    for (let i = 0; i < n; i++) circles[i].newI = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) intersect(circles[i], circles[j]);
    }
    for (let i = 0; i < n; i++) circles[i].newI.sort(ascending);

    ctx.strokeStyle = palette[colorIndex];
    ctx.lineWidth = W > 2560 || H > 2560 ? 3 : 1;   // the C's Retina rule
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      drawCircle(circles[i]);
      moveCircle(circles[i]);
    }
    ctx.stroke();

    if (++iterations % colorIterations() === 0) {
      colorIndex = (colorIndex + 1) % palette.length;
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    if (!palette) palette = makeColorLoop();
    colorIndex = Math.floor(Math.random() * palette.length);   // random() % ncolors
    iterations = 0;
    initCircles();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced at (delay + OVERHEAD) us per frame: the C's
  // delay is a sleep on top of the per-frame sweep+draw cost, so the port
  // adds the live-measured overhead to reproduce the binary's real cadence
  // (never running faster than the author's floor). Cap catch-up so a
  // backgrounded tab doesn't fire a burst of frames on refocus.
  const OVERHEAD = 9900;  // us; live -fps: 50.3 fps at Load 49.7% (clean: sleep slice = stock 10000)
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const stepMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, stepMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= stepMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= stepMs;
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
    reinit: init,   // re-seed circles + clear, keeping the current config
    config,
    params,
  };
}
