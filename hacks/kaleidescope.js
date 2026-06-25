// kaleidescope.js — kaleidescope packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's kaleidescope.c (Ron Tapia, 1997).
// https://www.jwz.org/xscreensaver/   (note the canonical misspelling
// "kaleidescope" — kept in the filename and title to match the original).
//
// A set of `nsegments` line segments drift around the screen centre and each is
// replicated across an N-fold rotational symmetry group (`symmetry` copies,
// rotated by 2*pi/symmetry about the centre), giving the classic kaleidoscope
// pattern. Every segment carries a fading trail of its last `ntrails` positions
// (a per-object circular buffer, like qix), so the whole thing draws a glowing
// kaleidoscopic ribbon that slowly cycles through the rainbow. Each segment's
// motion is its midpoint orbiting the centre (global rotation) while the segment
// spins about its own midpoint (local rotation) — the C's only "radial" drift
// comes from integer roundoff, which we reproduce (see notes).
//
// Rendering: redraw the whole trail queue each frame on a cleared canvas,
// bucketed by trail age (one strokeStyle per age, so ~ntrails stroke() calls a
// frame). This replaces the C's X11 draw-newest / erase-oldest GC scheme — no
// X11 XOR or erase-GC is needed, and the trails stay clean (no anti-alias
// residue). See kaleidescope.md for the deviation notes.

export const title = 'kaleidescope';

export const info = {
  author: 'Ron Tapia',
  description: 'A simple kaleidoscope made of line segments.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/kaleidescope.xml (1:1 with the
  // original). `delay` is a touch calmer than the stock 20000 us by feel.
  const config = {
    delay: 16000,         // us between steps; ~1 sim step per 60Hz frame (was 30000
                          // = 33Hz, which read as chunky motion at 60fps display)
    nsegments: 7,         // number of independent drifting segments (--nsegments)
    symmetry: 11,         // N-fold rotational symmetry: copies per segment (--symmetry)
    ntrails: 100,         // trail length: positions kept per segment (--ntrails)
    local_rotation: -33,  // segment spin per step, in units of 2*pi/10000 rad
                          // (was -59 at 33Hz; -33 at ~60Hz keeps the same deg/sec)
    global_rotation: 1,   // midpoint orbit per step, in units of 2*pi/10000 rad
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes the segment set / trail buffers, so a change
  //                re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 16000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'nsegments', label: 'Segments', type: 'range', min: 1, max: 100, step: 1, default: 7, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'symmetry', label: 'Symmetry', type: 'range', min: 3, max: 32, step: 1, default: 11, lowLabel: '3', highLabel: '32', live: false },
    { key: 'ntrails', label: 'Trails', type: 'range', min: 1, max: 1000, step: 1, default: 100, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'local_rotation', label: 'Spin', type: 'range', min: -200, max: 200, step: 1, default: -33, lowLabel: 'ccw', highLabel: 'cw', live: true },
    { key: 'global_rotation', label: 'Orbit', type: 'range', min: -50, max: 50, step: 1, default: 1, lowLabel: 'ccw', highLabel: 'cw', live: true },
  ];

  // The C works in a "natural" coordinate system centred on the origin, then
  // adds (xoff, yoff) = (width/2, height/2) at draw time. We keep that: state
  // is centred on 0, screen mapping adds the centre offset.
  const TAU = 2 * Math.PI;

  let S = 1;              // devicePixelRatio
  let xoff, yoff;         // screen centre, device px
  let nseg, nsym, ntr;    // resolved counts (from config, clamped)
  let costheta, sintheta; // one symmetry-step rotation (the C's NEWX/NEWY)
  let lineWidth;
  let segs;               // the drifting segments (see makeSeg)
  let baseHue;            // global hue cursor (degrees), cycles over time

  // INTRAND-style helper: integer in [0, n).
  function nrand(n) {
    return Math.floor(Math.random() * n);
  }

  // Build one drifting segment: a circular buffer of `ntr` endpoint records
  // (the C's ring of Ksegment trail nodes) plus the live endpoints and a hue.
  // The buffer is seeded full of the initial endpoints so the kaleidoscope is
  // symmetric and complete from the very first frame (the C fills the ring in
  // over the first `ntrails` frames, starting from zeros — a cluster of
  // centre-dots; we avoid that, see kaleidescope.md).
  function makeSeg(i) {
    const seg = {
      x1: 0, y1: 0, x2: 0, y2: 0,   // live endpoints, natural coords
      time: 0,
      hue: (i * 360 / Math.max(1, nseg)) % 360,  // per-segment hue offset
      trail: new Float64Array(ntr * 4),          // [x1,y1,x2,y2] per node
      head: 0,                                    // next write slot
    };
    initSeg(seg);
    for (let k = 0; k < ntr; k++) {
      seg.trail[k * 4 + 0] = seg.x1;
      seg.trail[k * 4 + 1] = seg.y1;
      seg.trail[k * 4 + 2] = seg.x2;
      seg.trail[k * 4 + 3] = seg.y2;
    }
    return seg;
  }

  // Give a segment fresh random endpoints (the C's init_ksegment). The C draws
  // them from [0, xoff) x [0, yoff) — the positive quadrant, magnitude up to
  // half the screen. Scaled by the centre offset so it tracks window size.
  function initSeg(seg) {
    seg.x1 = xoff ? nrand(xoff) : 0;
    seg.y1 = yoff ? nrand(yoff) : 0;
    seg.x2 = xoff ? nrand(xoff) : 0;
    seg.y2 = yoff ? nrand(yoff) : 0;
  }

  // Advance one segment's motion by one step (the C's propigate_ksegment):
  // the midpoint orbits the centre by global_rotation, and the segment spins
  // about its (pre-orbit) midpoint by local_rotation. The C stores endpoints in
  // `short int`, so every assignment truncates toward zero — that integer
  // roundoff is the *only* source of the slow radial drift the hack is known
  // for, so we reproduce it with Math.trunc (see kaleidescope.md).
  function propagate(seg) {
    const lsin = Math.sin((TAU / 10000) * config.local_rotation);
    const lcos = Math.cos((TAU / 10000) * config.local_rotation);
    const gsin = Math.sin((TAU / 10000) * config.global_rotation);
    const gcos = Math.cos((TAU / 10000) * config.global_rotation);

    seg.time++;

    let x1 = seg.x1, y1 = seg.y1, x2 = seg.x2, y2 = seg.y2;

    const midx = trunc16((x1 + x2) / 2);
    const midy = trunc16((y1 + y2) / 2);

    const nmidx = trunc16(midx * gcos + midy * gsin);
    const nmidy = trunc16(midy * gcos - midx * gsin);

    x1 -= midx; x2 -= midx;
    y1 -= midy; y2 -= midy;

    seg.x1 = trunc16((x1 * lcos) + (y1 * lsin) + nmidx);
    seg.y1 = trunc16((y1 * lcos) - (x1 * lsin) + nmidy);
    seg.x2 = trunc16((x2 * lcos) + (y2 * lsin) + nmidx);
    seg.y2 = trunc16((y2 * lcos) - (x2 * lsin) + nmidy);

    // Record the new endpoints into the trail ring (after the C's draw step
    // would have moved cur to this node).
    const h = seg.head * 4;
    seg.trail[h + 0] = seg.x1;
    seg.trail[h + 1] = seg.y1;
    seg.trail[h + 2] = seg.x2;
    seg.trail[h + 3] = seg.y2;
    seg.head++;
    if (seg.head >= ntr) seg.head = 0;
  }

  // Truncate to a signed 16-bit-ish integer, matching the C's `short int`
  // storage (which both rounds toward zero AND can wrap on overflow). The
  // wrap keeps wildly off-screen excursions from running away, exactly as the
  // original's `short` did; in normal use the values stay well inside range.
  function trunc16(v) {
    return (v | 0) << 16 >> 16;
  }

  // Reset a segment whose live endpoints have collapsed too close together
  // (the C's draw_ksegment: if the squared length < 100, re-init). Checked once
  // per step against the live endpoints; on reset we refill the whole trail so
  // there is no degenerate frame.
  function maybeReset(seg) {
    const dx = seg.x2 - seg.x1;
    const dy = seg.y2 - seg.y1;
    if (dx * dx + dy * dy < 100) {
      initSeg(seg);
      for (let k = 0; k < ntr; k++) {
        seg.trail[k * 4 + 0] = seg.x1;
        seg.trail[k * 4 + 1] = seg.y1;
        seg.trail[k * 4 + 2] = seg.x2;
        seg.trail[k * 4 + 3] = seg.y2;
      }
    }
  }

  // Seed everything from the current canvas size (the C's init_g + create/init
  // objects). Clears to black.
  function init() {
    S = window.devicePixelRatio || 1;
    xoff = Math.floor(canvas.width / 2);
    yoff = Math.floor(canvas.height / 2);

    nseg = Math.max(1, Math.round(config.nsegments));
    nsym = Math.max(1, Math.round(config.symmetry));
    ntr = Math.max(1, Math.round(config.ntrails));

    costheta = Math.cos(TAU / nsym);
    sintheta = Math.sin(TAU / nsym);

    lineWidth = (canvas.width > 2560 || canvas.height > 2560) ? 3 : Math.max(1, Math.round(S));

    baseHue = nrand(360);

    segs = [];
    for (let i = 0; i < nseg; i++) segs.push(makeSeg(i));

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // One simulation step: advance every segment, resetting any that collapsed,
  // and drift the global hue.
  function step() {
    for (const seg of segs) {
      maybeReset(seg);
      propagate(seg);
    }
    // Cycle the whole palette slowly (the C keeps a fixed per-object colour in
    // "nice" mode; we make it a gentle rainbow drift instead — see notes).
    baseHue = (baseHue + 0.6) % 360;
  }

  // Map a natural-coordinate point through symmetry copy `k` (rotate by k*theta
  // about the origin, the C's repeated NEWX/NEWY) and add the screen centre.
  // Returns [sx, sy] in device px. We precompute cos/sin per copy in draw().
  // (declared inline in draw for speed)

  // Redraw the full trail of every segment, replicated across the symmetry
  // group. Buckets segments by trail age so each age is one strokeStyle (older
  // = dimmer), giving ~ntr stroke() calls per frame. The newest trail entry is
  // the one just before head; we walk backwards from there so age 0 = brightest.
  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Precompute the symmetry rotations (k * theta), as running products of the
    // single-step rotation — matches the C's iterated NEWX/NEWY exactly.
    const cosK = new Float64Array(nsym);
    const sinK = new Float64Array(nsym);
    let ck = 1, sk = 0;
    for (let k = 0; k < nsym; k++) {
      // rotate (ck,sk) by one more theta: the C applies NEWX/NEWY repeatedly,
      // so copy k is rotated by (k+1) steps; the exact starting offset is
      // invisible for a full rotational set, but we match it anyway.
      const nck = ck * costheta + sk * sintheta;
      const nsk = sk * costheta - ck * sintheta;
      ck = nck; sk = nsk;
      cosK[k] = ck;
      sinK[k] = sk;
    }

    // One Path2D per trail age; stroke each once with an age-faded colour.
    const paths = new Array(ntr);
    for (let a = 0; a < ntr; a++) paths[a] = new Path2D();

    for (const seg of segs) {
      // age 0 = most recent (the slot just written, head-1); increasing age =
      // older. Walk the ring backwards from head-1.
      for (let a = 0; a < ntr; a++) {
        let idx = seg.head - 1 - a;
        idx = ((idx % ntr) + ntr) % ntr;
        const base = idx * 4;
        const x1 = seg.trail[base + 0];
        const y1 = seg.trail[base + 1];
        const x2 = seg.trail[base + 2];
        const y2 = seg.trail[base + 3];
        const p = paths[a];
        for (let k = 0; k < nsym; k++) {
          const c = cosK[k], s = sinK[k];
          p.moveTo(x1 * c + y1 * s + xoff, y1 * c - x1 * s + yoff);
          p.lineTo(x2 * c + y2 * s + xoff, y2 * c - x2 * s + yoff);
        }
      }
    }

    // Stroke oldest first so the bright newest segments paint on top. Lightness
    // fades from full at age 0 to near-black at the tail; hue drifts with
    // baseHue (the whole ribbon shares the cycling hue here).
    const hue = baseHue;
    for (let a = ntr - 1; a >= 0; a--) {
      const t = a / ntr;                 // 0 = newest .. ~1 = oldest
      const light = Math.round(60 * (1 - t) + 6);   // 60% -> 6%
      ctx.strokeStyle = `hsl(${hue}, 100%, ${light}%)`;
      ctx.stroke(paths[a]);
    }
  }

  function reinit() {
    init();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced by config.delay (us): run one step() per delay,
  // banking leftover time so the speed is identical at any refresh rate. Cap
  // catch-up so a backgrounded tab doesn't burst a run of steps on refocus.
  // We always redraw the queue once per animation frame.
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

    draw();
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
    reinit,
    config,
    params,
  };
}
