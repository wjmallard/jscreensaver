// rotor.js — rotor packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's rotor.c (Tom Lawrence, 1997; descends from xlockmore
// code by Patrick J. Naughton / Steve Zellers, 1990-1991).
// https://www.jwz.org/xscreensaver/  (removed from the distribution at 5.08)
//
// "Draws a line segment moving along a complex spiraling curve." A chain of
// `count` pivoting arms is summed tip-to-tip into a single endpoint: each arm
// contributes (cos, sin)(globalAngle * ratio) * radius. Every arm's `ratio`
// (its angular frequency) and `radius` (its length) drift slowly and
// independently between random targets over tens of thousands of frames, so the
// traced figure morphs forever. The global angle oscillates 0..MAXANGLE (drifts
// up slowly, snaps back faster), sweeping the endpoint out along the curve and
// back. A SHORT trail of the last `cycles` endpoints is kept in a ring buffer
// and drawn as a colour-cycling polyline; the oldest segment drops off each step
// (the C erased it; see Deviations).
//
// Rendering: genuinely line-shaped (one XDrawLine per segment in the C), so it
// uses canvas VECTOR ops. The trail is short (<= `cycles` points), so each step
// we clear and redraw the whole ring buffer — one stroke per segment, each in
// its own colour from the smooth colormap. This sidesteps the C's
// black-over-old-segment erase (canvas anti-aliasing would leave ghosts) while
// showing the identical pixels.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'rotor';

export const info = {
  author: 'Tom Lawrence',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nDraws a line segment moving along a complex spiraling curve.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror rotor.c's DEFAULTS / rotor.man (1:1 with the original).
  const config = {
    delay: 10000,   // microseconds between steps (--delay); stock rotor.c value
    cycles: 20,     // trail length: points kept in the ring buffer (--cycles)
    ncolors: 200,   // size of the hue cycle (--ncolors)
    count: 4,       // number of pivoting arms summed into the endpoint (--count)
    size: -6,       // line thickness; < 0 = random 1..|size| (--size)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cycles', label: 'Length', type: 'range', min: 2, max: 100, step: 1, default: 20, lowLabel: 'short', highLabel: 'long', live: false },
    { key: 'count', label: 'Arms', type: 'range', min: 1, max: 20, step: 1, default: 4, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'size', label: 'Line thickness (<0 = random)', type: 'range', min: -50, max: 50, step: 1, default: -6, live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // The angle oscillates in [0, MAXANGLE]; the C notes it was once 10000.
  const MAXANGLE = 3000.0;

  let S = 1;                 // devicePixelRatio
  let W, H;                  // canvas size, device px
  let cx, cy;                // figure centre

  let num;                   // arm count
  let nsave;                 // ring buffer length (trail length)
  let linewidth;             // stroke width, device px
  let palette;               // ncolors smooth-colormap CSS strings

  let elements;              // per-arm drift state (mirrors the C's elem[])
  let gAngle;                // global sweep angle
  let forward;              // sweep direction (true = winding up)
  let pix;                   // current palette index (cycles each step)

  // Ring buffer of the last nsave endpoints + the colour of the segment that
  // ENDS at each one. `rotor` is the next write slot = the oldest point.
  let sx, sy, scol, rotor;

  let dirty = true;          // redraw only after the trail advances

  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    // rotor.c is xlockmore SMOOTH_COLORS -> make_smooth_colormap: a per-run
    // random 2-5 anchor HSV loop, usually muted, re-rolled each run. NPIXELS <= 2
    // (ncolors <= 2) is the C's mono path -> white. The segment colour advances
    // one index per step and slides through this loop, so the short trail shows a
    // moving slice of it (sometimes a narrow band, sometimes spanning the loop).
    if (n <= 2) { palette = ['#fff']; return; }
    palette = makeSmoothColormapRGB(n).map(([r, g, b]) => `rgb(${r},${g},${b})`);
  }

  // One simulation step: the C's draw_rotor inner loop. Accumulate the arm chain
  // into a fresh endpoint, push it (with its colour) into the ring buffer, then
  // advance the colour and the oscillating global angle.
  function step() {
    let thisx = cx;
    let thisy = cy;

    for (const e of elements) {
      // Each drift counter counts up to its (random) max, then re-targets — the
      // figure never stops morphing. Re-seeds everything the next frame reads.
      if (e.radius_drift_max <= e.radius_drift_now) {
        e.start_radius = e.end_radius;
        e.end_radius = Math.random() * 400 - 200;          // NRAND(40000)/100 - 200
        e.radius_drift_max = Math.random() * 100000 + 10000;
        e.radius_drift_now = 0;
      }
      if (e.ratio_drift_max <= e.ratio_drift_now) {
        e.start_ratio = e.end_ratio;
        e.end_ratio = Math.random() * 20 - 10;             // NRAND(2000)/100 - 10
        e.ratio_drift_max = Math.random() * 100000 + 10000;
        e.ratio_drift_now = 0;
      }

      const ratio = e.start_ratio +
        (e.end_ratio - e.start_ratio) / e.ratio_drift_max * e.ratio_drift_now;
      const radius = e.start_radius +
        (e.end_radius - e.start_radius) / e.radius_drift_max * e.radius_drift_now;
      const a = gAngle * ratio;

      // Logical radii scaled by S so the figure keeps its size on retina.
      thisx += Math.cos(a) * radius * S;
      thisy += Math.sin(a) * radius * S;

      e.ratio_drift_now += 1;
      e.radius_drift_now += 1;
    }

    sx[rotor] = thisx;
    sy[rotor] = thisy;
    scol[rotor] = pix;
    pix = (pix + 1) % palette.length;
    rotor = (rotor + 1) % nsave;

    // Wind the global angle up slowly, snap it back faster (the C's 0.01 / 0.1).
    if (forward) {
      gAngle += 0.01;
      if (gAngle >= MAXANGLE) { gAngle = MAXANGLE; forward = false; }
    } else {
      gAngle -= 0.1;
      if (gAngle <= 0) { gAngle = 0; forward = true; }
    }

    dirty = true;
  }

  // Clear and redraw the whole short trail: nsave-1 segments connecting the ring
  // buffer's points in chronological order (oldest at `rotor`), each stroked in
  // the hue stored for the segment's far endpoint.
  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = linewidth;
    ctx.lineCap = linewidth <= 3 * S ? 'butt' : 'round';   // butt like the C; round avoids gaps when thick
    ctx.lineJoin = 'miter';

    for (let k = 1; k < nsave; k++) {
      const i = (rotor + k) % nsave;       // segment's far (newer) endpoint
      const j = (rotor + k - 1) % nsave;   // segment's near (older) endpoint
      ctx.strokeStyle = palette[scol[i]];
      ctx.beginPath();
      ctx.moveTo(sx[j], sy[j]);
      ctx.lineTo(sx[i], sy[i]);
      ctx.stroke();
    }

    dirty = false;
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    cx = W / 2;
    cy = H / 2;

    buildPalette();

    num = Math.max(1, Math.round(config.count));   // count=0 would draw nothing
    nsave = Math.max(2, Math.round(config.cycles)); // the C's nsave floor

    // Line thickness: 0 -> 1, negative -> random 1..|size| (the C's MI_SIZE).
    let lw = Math.round(config.size);
    if (lw === 0) lw = 1;
    else if (lw < 0) lw = Math.floor(Math.random() * (-lw)) + 1;
    linewidth = Math.max(1, lw) * S;

    // Per-arm drift state — seeded exactly as the C's init_rotor so the first
    // step triggers a re-target (drift_max <= drift_now) and starts from
    // radius 100 / ratio 10 like the original.
    elements = [];
    for (let i = 0; i < num; i++) {
      elements.push({
        start_radius: 0,
        end_radius: 100.0,
        radius_drift_max: 1.0,
        radius_drift_now: 1.0,
        start_ratio: 0,
        end_ratio: 10.0,
        ratio_drift_max: 1.0,
        ratio_drift_now: 1.0,
      });
    }

    pix = palette.length > 2 ? Math.floor(Math.random() * palette.length) : 0;
    gAngle = Math.random() * MAXANGLE / 3;   // NRAND(MAXANGLE) / 3.0
    forward = true;

    sx = new Float64Array(nsave);
    sy = new Float64Array(nsave);
    scol = new Int32Array(nsave);
    sx.fill(cx);
    sy.fill(cy);
    rotor = 0;

    // Pre-roll one full buffer so the first painted frame already shows a
    // complete short trail (the C builds it up over the first nsave frames).
    for (let i = 0; i < nsave; i++) step();

    dirty = true;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // Rebuild after a non-live config change (size/count/cycles/ncolors resize
  // buffers or the palette), clearing the screen and re-seeding via init().
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // Per-step pacing = stock delay + a measured framework OVERHEAD. The live
  // binary's *delay (10000 us) is a sleep FLOOR; each frame also pays a fixed
  // framework cost, so its effective rate is below 1e6/delay. Measured against
  // rotor's -fps overlay in the delay-bound regime (Load ~42%, small/medium
  // figures): ~57.5 fps -> OVERHEAD = round(1e6/57.5) - 10000 = 7391 us, for a
  // ~17.4 ms/step pace. (Large screen-spanning figures drop the live binary to
  // 11-26 fps, but that is XQuartz software-rendering of long lines stalling the
  // process at LOW CPU load -- not the intended pace; the original X11 and this
  // GPU-accelerated canvas both draw the lines cheaply.)
  const OVERHEAD = 7391;

  // Fixed-timestep lag accumulator (squiral-style): one step() per
  // (config.delay + OVERHEAD) us, banked so the pace is the same at any refresh
  // rate, with a catch-up cap so a backgrounded tab can't burst. Redraw once per
  // frame, only when the trail actually advanced.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    if (dirty) draw();
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
    reinit,   // fresh figure with the current config
    config,
    params,
  };
}
