// interaggregate.js — interaggregate packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's interaggregate.c (David Goldfarb / dagraz, 2004;
// xscreensaver port machinery by Jamie Zawinski), itself based on j.tarbell's
// "Intersection Aggregate" (complexification.net, 2004) and the substrate port.
// https://www.jwz.org/xscreensaver/
//
// A field of ~100 medium-to-small circles drifts slowly across the screen.
// Every frame, for each PAIR of circles that currently overlap, the two points
// where their outlines cross are computed and a trio of "sand painters" lay a
// soft, grainy stroke between those two intersection points. Despite the name
// nothing draws the circles themselves — only the instantaneous intersections —
// but because the strokes are faint and never erased, the aggregate of every
// past intersection builds up into pale pencil-like interference webs. Every so
// many cycles (or on resize) the buffer is wiped and a fresh field is seeded.
//
// Rendering: the buildup IS the effect, so the persistent canvas is the
// accumulation buffer — each sand-painter point is a single low-alpha device
// pixel splatted with ctx.fillRect (the C alpha-blends into an off_img; here
// 'source-over' alpha onto the canvas does the same compositing). A sand
// painter emits ~22 such points clustered near a point along the segment, so a
// frame is a few thousand cheap fills; nothing is ever read back.

export const title = 'interaggregate';

export const info = {
  author: 'Casey Reas, William Ngan, Robert Hodgin, and Jamie Zawinski',
  description: "Pale pencil-like scribbles slowly fill the screen.\n\nA surface is filled with a hundred medium to small sized circles. Each circle has a different size and direction, but moves at the same slow rate. Displays the instantaneous intersections of the circles as well as the aggregate intersections of the circles.\n\nThough actually it doesn't look like circles at all!",
  year: 2004,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/interaggregate.xml so the config box
  // maps 1:1 to the original. The two xml sliders are `growthDelay` (the "Frame
  // rate" slider, µs/frame) and `numCircles` ("Number of discs"). The rest map
  // to real command-line resources the C exposes but the stock xml UI omits
  // (`-max-cycles`, `-percent-orbits`, `-base-orbits`, `-base-on-center`). There
  // is NO palette or gain knob: the C has no palette resource (it uses one fixed
  // muted Pollock colormap on white paper) and hardcodes max_gain 0.22.
  const config = {
    delay: 18000,        // µs between frames (--growth-delay)
    count: 100,          // number of drifting discs (--num-circles)
    percentOrbits: 0,    // % of discs on orbital (vs linear) paths (--percent-orbits)
    baseOrbits: 75,      // % of orbiters that orbit a base disc (--base-orbits)
    maxCycles: 100000,   // frames before the buffer is wiped + reseeded (--max-cycles)
    baseOnCenter: false, // orbiters orbit the screen centre (--base-on-center)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 18000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Number of discs', type: 'range', min: 50, max: 400, step: 1, default: 100, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'percentOrbits', label: 'Orbiting discs', type: 'range', min: 0, max: 100, step: 1, default: 0, unit: '%', lowLabel: 'drift', highLabel: 'orbit', live: false },
    { key: 'baseOrbits', label: 'Anchored orbits', type: 'range', min: 0, max: 100, step: 1, default: 75, unit: '%', live: false },
    { key: 'maxCycles', label: 'Frames before reset', type: 'range', min: 1000, max: 200000, step: 1000, default: 100000, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'baseOnCenter', label: 'Orbit screen centre', type: 'checkbox', default: false, live: false },
  ];

  // The C's path kinds (interaggregate.c: typedef enum { LINEAR, ORBIT }).
  const LINEAR = 0, ORBIT = 1;
  const TAU = Math.PI * 2;
  // The C hardcodes the sand-painter gain bound (init_field: f->max_gain = 0.22).
  const MAX_GAIN = 0.22;
  // Per-frame framework+draw cost added to the stock delay so the rAF loop paces
  // at (delay + OVERHEAD), matching the live binary's fps. This hack scans every
  // disc PAIR each frame (O(n^2), ~4950 pairs at the default 100 discs), so its
  // per-frame cost sits well above the sparse-vector norm. Live-measured: 31.4fps
  // (Load 43.4%, clean) at stock delay 18000 -> OVERHEAD 13850.
  const OVERHEAD = 13850;

  // The C's only colour source: the muted colormap extracted from pollockEFF.gif
  // (interaggregate.c rgb_colormap[]) — white, two blacks, olive, camel, tan,
  // light tan. A fixed 7-entry table, ported verbatim. Stored as [r,g,b].
  const POLLOCK = [
    [0xff, 0xff, 0xff],
    [0x00, 0x00, 0x00],
    [0x00, 0x00, 0x00],
    [0x4e, 0x3e, 0x2e],
    [0x69, 0x4d, 0x35],
    [0xb0, 0xa0, 0x85],
    [0xe6, 0xd3, 0xae],
  ];

  // frand(m) -> uniform double in [0, m), matching the C's frand().
  const frand = (m) => Math.random() * m;

  let S = 1;             // devicePixelRatio
  let W, H;              // canvas size, device px
  let circles;           // array of disc objects
  let centerOfUniverse;  // pseudo-circle at screen centre (orbit anchor)
  let colors;            // active palette as ['r,g,b', ...] strings for rgba()
  let cycles;            // frames since the last wipe

  // Build the palette. The C has exactly one colour source — the fixed Pollock
  // table (build_colors parses rgb_colormap[] once) — so this just stringifies
  // it for rgba(). Each painter later picks one entry at random for its life.
  function buildColors() {
    colors = POLLOCK.map(([r, g, b]) => `${r}, ${g}, ${b}`);
  }

  // Allocate three sand painters for a disc (the C's circle->num_painters = 3).
  // Each painter keeps a drifting gain and phase `p`, plus a fixed colour index.
  function makePainters() {
    const painters = new Array(3);
    for (let j = 0; j < 3; j++) {
      painters[j] = {
        gain: frand(0.09) + 0.01,
        p: frand(1.0),
        color: colors[Math.floor(frand(0.999) * colors.length)],
      };
    }
    return painters;
  }

  // Seed the whole field (the C's build_field). Discs split into a LINEAR block
  // [0, orbitStart) that drifts in a straight line, and an ORBIT block that
  // circles an anchor disc (or, for the first `baseOrbits` of them, a randomly
  // chosen earlier disc / the screen centre). percentOrbits 0 => all linear.
  function buildField() {
    const n = Math.max(2, Math.round(config.count));

    centerOfUniverse = {
      x: W / 2,
      y: H / 2,
      r: Math.max(W, H) / 2,
    };

    const numOrbits = Math.floor((config.percentOrbits * n) / 100);
    const orbitStart = n - numOrbits;
    const baseOrbits = orbitStart + Math.floor((numOrbits * config.baseOrbits) / 100);
    // percentOrbits 100 forces base-on-center (the C does this in _init).
    const baseOnCenter = config.percentOrbits === 100 ? true : config.baseOnCenter;

    const minDim = Math.min(W, H);

    circles = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = {
        pathType: i >= orbitStart ? ORBIT : LINEAR,
        radius: 0,
        x: 0,
        y: 0,
        dx: 0,
        dy: 0,
        theta: 0,
        r: 0,
        dtheta: 0,
        center: null,
        painters: null,
      };

      if (c.pathType === LINEAR) {
        c.x = frand(W);
        c.y = frand(H);
        // Slow drift: each component in [-0.25, 0.25) logical px/frame, * S.
        c.dx = (frand(0.5) - 0.25) * S;
        c.dy = (frand(0.5) - 0.25) * S;
        c.radius = (5 + frand(55)) * S;
        c.r = minDim / 2;          // in case orbits anchor on a line disc
        c.center = null;
      } else {
        // ORBIT.
        if (i < baseOrbits) {
          c.center = baseOnCenter
            ? centerOfUniverse
            : circles[Math.floor(frand(orbitStart - 0.1))];
          // 1px logical -> S device; frand's range is already device px (minDim
          // is device), so it must NOT be multiplied by S again.
          c.r = S + frand(minDim / 2);
        } else {
          // Prefer earlier discs as anchors, and orbit at ~half the anchor's r.
          const p = frand(0.9);
          c.center = circles[Math.floor(p * i)];
          c.r = S + 0.5 * c.center.r + 0.5 * frand(c.center.r);
        }
        c.radius = (5 + frand(Math.min(55, c.r / S))) * S;
        c.dtheta = (frand(0.5) - 0.25) / (c.r / S);   // angular speed ~ inverse radius
        c.theta = frand(TAU);
        c.x = c.r * Math.cos(c.theta) + c.center.x;
        c.y = c.r * Math.sin(c.theta) + c.center.y;
      }

      c.painters = makePainters();
      circles[i] = c;
    }
  }

  // Advance every disc one frame (the C's moveCircles). Linear discs translate
  // and wrap at the edges; orbiters step their angle and recompute x,y. The C
  // wraps the resulting x,y to [0,W)/[0,H) for both kinds (the #else branches).
  function moveCircles() {
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      if (c.pathType === LINEAR) {
        c.x += c.dx;
        c.y += c.dy;
      } else {
        c.theta += c.dtheta;
        if (c.theta < 0) c.theta += TAU;
        else if (c.theta > TAU) c.theta -= TAU;
        c.x = c.r * Math.cos(c.theta) + c.center.x;
        c.y = c.r * Math.sin(c.theta) + c.center.y;
      }
      if (c.x < 0) c.x += W;
      else if (c.x >= W) c.x -= W;
      if (c.y < 0) c.y += H;
      else if (c.y >= H) c.y -= H;
    }
  }

  // Splat one sand-painter point: a single device pixel of `color` at `alpha`,
  // wrapped onto the torus (the C's drawPoint wraps x,y then alpha-blends into
  // off_img). source-over with a low alpha accumulates exactly like the blend.
  function drawPoint(x, y, color, alpha) {
    x = Math.round(x);
    y = Math.round(y);
    while (x >= W) x -= W;
    while (x < 0) x += W;
    while (y >= H) y -= H;
    while (y < 0) y += H;
    ctx.fillStyle = `rgba(${color}, ${alpha})`;
    ctx.fillRect(x, y, 1, 1);
  }

  // The sand painter (the C's paint): given the two intersection points a->b,
  // jitter the painter's gain/phase, then lay 11 mirrored pairs of points whose
  // position along the segment is sin(p +/- sandp); sandp fans out by gain*0.1
  // each step and the per-point intensity tapers from 0.1 down. The cluster
  // sits near the fraction sin(p) of the way from a to b — a soft grainy dab.
  function paint(painter, ax, ay, bx, by) {
    painter.gain += frand(0.05) - 0.025;
    if (painter.gain > MAX_GAIN) painter.gain = -MAX_GAIN;
    else if (painter.gain < -MAX_GAIN) painter.gain = MAX_GAIN;

    painter.p += frand(0.1) - 0.05;
    // NOTE: this clamp is verbatim from the C (`if (0 < p) p = 0`), which pins
    // p to 0 whenever it goes positive — so p rides at 0 and the cluster sits at
    // the segment's a-endpoint. Faithful to the original's behaviour.
    if (0 < painter.p) painter.p = 0;
    else if (painter.p > 1.0) painter.p = 1.0;

    const inc = painter.gain * 0.1;
    let sandp = 0;
    for (let i = 0; i <= 10; i++) {
      const intensity = 0.1 - 0.009 * i;
      const sp = Math.sin(painter.p + sandp);
      drawPoint(ax + (bx - ax) * sp, ay + (by - ay) * sp, painter.color, intensity);
      const sm = Math.sin(painter.p - sandp);
      drawPoint(ax + (bx - ax) * sm, ay + (by - ay) * sm, painter.color, intensity);
      sandp += inc;
    }
  }

  // Paint the intersections of every overlapping pair (the C's drawIntersections
  // default branch). Two circles intersect when their centre distance d is
  // between |r1-r2| and r1+r2; the two crossing points are found by the standard
  // radical-line construction, and all three of c1's painters dab between them.
  function drawIntersections() {
    const n = circles.length;
    for (let i = 0; i < n; i++) {
      const c1 = circles[i];
      const r1 = c1.radius;
      const r1sqr = r1 * r1;
      for (let j = i + 1; j < n; j++) {
        const c2 = circles[j];
        const dx = c2.x - c1.x;
        const dy = c2.y - c1.y;
        const rsum = r1 + c2.radius;
        if (Math.abs(dx) >= rsum || Math.abs(dy) >= rsum) continue;
        const dsqr = dx * dx + dy * dy;
        const d = Math.sqrt(dsqr);
        if (d >= rsum || d <= Math.abs(r1 - c2.radius)) continue;

        // Unit vector c1->c2.
        const bx = dx / d;
        const by = dy / d;
        // Distance from c1's centre to the radical-line midpoint.
        const d1 = 0.5 * (r1sqr - c2.radius * c2.radius + dsqr) / d;
        const midpx = c1.x + d1 * bx;
        const midpy = c1.y + d1 * by;
        // Half-chord (guard the sqrt against tiny negative round-off).
        const d2 = Math.sqrt(Math.max(0, r1sqr - d1 * d1));

        const int1x = midpx + d2 * by;
        const int1y = midpy - d2 * bx;
        const int2x = midpx - d2 * by;
        const int2y = midpy + d2 * bx;

        for (let s = 0; s < c1.painters.length; s++) {
          paint(c1.painters[s], int1x, int1y, int2x, int2y);
        }
      }
    }
  }

  // Wipe the canvas to white paper and re-seed the field (the C clears to
  // bgcolor and calls build_field on reset / maxCycles / resize). The C's
  // ".background" is white; the muted strokes accumulate as pale pencil on it.
  function wipe() {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
  }

  // One frame: drift the discs, paint the current intersections, and wipe +
  // reseed once `maxCycles` frames have elapsed (the C's interaggregate_draw).
  function step() {
    moveCircles();
    drawIntersections();
    cycles++;
    if (cycles >= config.maxCycles && config.maxCycles !== 0) {
      buildField();
      wipe();
      cycles = 0;
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    cycles = 0;
    buildColors();
    buildField();
  }

  // reinit wipes to white paper (count / orbit mix may have changed) and
  // re-seeds the field, keeping the current config.
  function reinit() {
    wipe();
    init();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.fillStyle = '#fff';
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
    // Pace at (delay + OVERHEAD) so the port runs at the live binary's fps.
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
    reinit,   // wipe + reseed the field, keeping the current config
    config,
    params,
  };
}
