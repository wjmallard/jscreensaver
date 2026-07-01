// kaleidescope.js — kaleidescope packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's kaleidescope.c (Ron Tapia, 1997).
// https://www.jwz.org/xscreensaver/   (note the canonical misspelling
// "kaleidescope" — kept in the filename and title to match the original).
//
// `nsegments` line segments live in a "natural" coordinate system centred on the
// origin. Each step every segment PROPAGATES: its midpoint orbits the centre by
// `global_rotation` while the segment spins about that midpoint by
// `local_rotation` (both in units of 2*pi/10000 rad). Endpoints are stored as
// `short int` in the C, so every assignment truncates toward zero — that integer
// roundoff is the ONLY source of the slow radial drift the hack is known for
// (the C's own header says so), which we reproduce with trunc16.
//
// Each segment keeps a ring of its last `ntrails` positions (the C's Ksegment
// ring) and is replicated across an N-fold rotational symmetry group (`symmetry`
// copies, each an extra 2*pi/symmetry rotation about the centre — the C's
// iterated NEWX/NEWY macros, truncated to short per copy). With the default
// color_mode "nice", every node of a segment shares ONE fixed muted random RGB
// colour (each channel random in [30000,50000) of the 16-bit space; the C's
// kcycle_color is a no-op outside "greedy" mode), so the trail is a solid-colour
// ribbon, NOT a fading rainbow. See kaleidescope.md.
//
// Rendering: the C draws the newest trail node and erases the oldest each frame
// with two X GCs. Canvas has no persistent-overdraw GC, and erasing anti-aliased
// strokes in place leaves residue, so the whole live ring is re-stroked each time
// on a cleared canvas -- one beginPath per segment (all its nodes * symmetry
// copies), stroked once in the segment's colour. Same pixels, no XOR / erase-GC.
//
// The stroking is the cost: ~nsegments * ntrails * symmetry anti-aliased lines
// (~7,700 at the defaults). But those lines are STATIC -- propagate() writes each
// node once; only the head grows and the tail drops each sim STEP, ~30x/s. So we
// re-stroke the figure onto an OFFSCREEN cache only when the sim advances, and
// cheaply blit that cache to the visible canvas every rAF frame. That decouples
// the expensive stroke (sim rate, ~30 Hz) from presentation (display rate), so
// the static figure is not re-rasterised on the frames where nothing changed.
//   (Why not a dirty-rect clip of just the head/tail? Because every node's
//   `symmetry` copies RING the centre -- its 11 copies sit at 11 angles around
//   the centre at the node's radius -- so a single node's damage already spans
//   ~the whole canvas; measured ~96% of it per step. There is no small region to
//   clip to, so a clip can't localise the re-stroke. Cache + blit is the win.)

export const title = 'kaleidescope';

export const info = {
  author: 'Ron Tapia',
  description: 'A simple kaleidoscope made of line segments.\n\nSee "GLeidescope" for a more sophisticated take.\n\nhttps://en.wikipedia.org/wiki/Kaleidoscope',
  year: 1997,
};

export function start(canvas) {
  // Visible context: only ever blits the offscreen cache (a cheap image copy).
  const ctx = canvas.getContext('2d');

  // Offscreen cache: the full mandala is stroked here, and only when the sim
  // advances (see the render note up top). Same backing-store size as the visible
  // canvas, so the blit is a 1:1 copy with no scaling.
  const off = document.createElement('canvas');
  const offctx = off.getContext('2d');

  // Defaults/ranges mirror hacks/config/kaleidescope.xml and the kaleidescope.c
  // DEFAULTS (1:1 with the original).
  const config = {
    delay: 20000,          // us between steps (--delay); stock xml / .c value
    nsegments: 7,          // independent drifting segments (--nsegments)
    symmetry: 11,          // N-fold rotational symmetry: copies per segment (--symmetry)
    ntrails: 100,          // trail length: ring nodes per segment (--ntrails)
    // The next two are real -X options but NOT in the xml's slider set, so they
    // stay fixed at the .c defaults (no GUI knob), matching the UI the author
    // shipped. local/global rotation are in units of 2*pi/10000 rad per step.
    local_rotation: -59,   // segment spin per step (--local_rotation)
    global_rotation: 1,    // midpoint orbit per step (--global_rotation)
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes the segment set / trail buffers, so a change
  //                re-runs init() via reinit(). Mirrors the xml's slider set
  //                exactly (delay / nsegments / symmetry / ntrails).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'nsegments', label: 'Segments', type: 'range', min: 1, max: 100, step: 1, default: 7, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'symmetry', label: 'Symmetry', type: 'range', min: 3, max: 32, step: 1, default: 11, lowLabel: '3', highLabel: '32', live: false },
    { key: 'ntrails', label: 'Trails', type: 'range', min: 1, max: 1000, step: 1, default: 100, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  // The C works in a "natural" coordinate system centred on the origin, then
  // adds (xoff, yoff) = (width/2, height/2) at draw time. We keep that.
  const TAU = 2 * Math.PI;

  // Each trail node is a STATIC rotated copy: propagate() writes it once and the
  // spiral just extends at the head, so draw() re-strokes the SAME nodes and the
  // body sits perfectly still (only the head grows / tail drops per step). That
  // staticness is why the offscreen cache pays off: the figure only needs
  // re-stroking when the sim advances, not on every presentation frame.
  // OVERHEAD paces the step rate to the live binary's ~30.2 fps (measured: 30.2
  // fps / 39.6% load, sleep slice = stock delay).
  //   An earlier experiment set SUBK>1: sub-step the sim finer for a smoother head,
  //   then DRAW a decimated (every SUBK-th) subset. But that re-picked different
  //   integer-truncated nodes each frame, which made the OLD lines JITTER instead
  //   of sitting still -- so it's disabled. SUBK = 1 == one node per live step, the
  //   C's exact cadence; the inert SUBK/ringLen scaffolding is kept minimal.
  const SUBK = 1;
  const OVERHEAD = 13113;   // (delay 20000 + 13113) us per LIVE step => 30.2 fps

  // The C's krandom_color builds each segment's colour from six resources; these
  // are their .c defaults. Each channel is an independent random 16-bit value in
  // [min, min+range). Not exposed in the xml GUI, so kept as fixed constants.
  const REDMIN = 30000, REDRANGE = 20000;
  const GREENMIN = 30000, GREENRANGE = 20000;
  const BLUEMIN = 30000, BLUERANGE = 20000;

  let xoff, yoff;         // screen centre, device px
  let nseg, nsym, ntr;    // resolved counts (from config, clamped)
  let ringLen;            // trail ring size = ntr * SUBK (arc unchanged, sampled finer)
  let costheta, sintheta; // one symmetry-step rotation (the C's NEWX/NEWY)
  let lineWidth;
  let segs;               // the drifting segments (see makeSeg)
  let started;            // the C's done_once: first step draws the root in place

  // INTRAND-style helper: integer in [0, n).
  function nrand(n) {
    return Math.floor(Math.random() * n);
  }

  // Truncate to a signed 16-bit integer, matching the C's `short int` storage
  // (round toward zero AND wrap on overflow). This per-step integer roundoff is
  // load-bearing: it slowly shrinks segments until they collapse and re-seed --
  // the organic churn/variety that fills the center. (A float-identity version was
  // tried for smoothness but lost the churn -> hollow center, too clean; reverted.)
  function trunc16(v) {
    return (v | 0) << 16 >> 16;
  }

  // One muted random RGB per segment (the C's krandom_color in "nice" mode):
  // each channel random in [min, min+range) of the 16-bit space, then the X
  // server's >>8 downsample to 8-bit. Channels land in ~[117,195) — mid-tones,
  // never the vivid full-saturation rainbow. The colour is fixed for the run.
  function segColor() {
    const r = (nrand(REDRANGE) + REDMIN) >> 8;
    const g = (nrand(GREENRANGE) + GREENMIN) >> 8;
    const b = (nrand(BLUERANGE) + BLUEMIN) >> 8;
    return `rgb(${r}, ${g}, ${b})`;
  }

  // Random endpoints for one ring node, in the positive quadrant up to half the
  // screen (the C's init_ksegment: random() % xoff, etc.).
  function initNode(seg, idx) {
    const b = idx * 4;
    seg.trail[b + 0] = xoff ? nrand(xoff) : 0;
    seg.trail[b + 1] = yoff ? nrand(yoff) : 0;
    seg.trail[b + 2] = xoff ? nrand(xoff) : 0;
    seg.trail[b + 3] = yoff ? nrand(yoff) : 0;
  }

  // Build one drifting segment: a ring of `ringLen` (= ntr * SUBK) endpoint nodes
  // (the C's Ksegment ring, sampled SUBK x finer), the index of the live (newest)
  // node, a grow-in counter, and one fixed colour. Only the root node is seeded;
  // the rest fill in as `cur` advances (grows over the first ringLen sub-steps).
  function makeSeg() {
    const seg = {
      trail: new Float64Array(ringLen * 4),  // [x1,y1,x2,y2] per node, natural coords
      cur: 0,                            // index of the live (newest) node
      nlive: 0,                          // nodes visited so far (grows to ringLen)
      color: segColor(),                 // one muted colour for the whole ribbon
    };
    initNode(seg, 0);                    // seed the root (the C's init_objects)
    return seg;
  }

  // Advance one segment by a step (the C's propigate_ksegment): the live node's
  // midpoint orbits the centre by global_rotation, the segment spins about that
  // (pre-orbit) midpoint by local_rotation, and the result is written into the
  // NEXT ring node, which becomes the new live node. short-int truncation
  // throughout is the roundoff that drives the slow radial drift.
  function propagate(seg, lcos, lsin, gcos, gsin) {
    const c = seg.cur * 4;
    let x1 = seg.trail[c + 0], y1 = seg.trail[c + 1];
    let x2 = seg.trail[c + 2], y2 = seg.trail[c + 3];

    const midx = trunc16((x1 + x2) / 2);
    const midy = trunc16((y1 + y2) / 2);

    const nmidx = trunc16(midx * gcos + midy * gsin);
    const nmidy = trunc16(midy * gcos - midx * gsin);

    x1 -= midx; x2 -= midx;
    y1 -= midy; y2 -= midy;

    seg.cur = (seg.cur + 1) % ringLen;
    const n = seg.cur * 4;
    seg.trail[n + 0] = trunc16((x1 * lcos) + (y1 * lsin) + nmidx);
    seg.trail[n + 1] = trunc16((y1 * lcos) - (x1 * lsin) + nmidy);
    seg.trail[n + 2] = trunc16((x2 * lcos) + (y2 * lsin) + nmidx);
    seg.trail[n + 3] = trunc16((y2 * lcos) - (x2 * lsin) + nmidy);
  }

  // If the live node's endpoints have collapsed (squared length < 100, i.e.
  // within 10 px), re-seed JUST that node with fresh random endpoints (the C's
  // draw_ksegment length check -> init_ksegment). The rest of the trail is left
  // alone, so the ribbon morphs into its new path over the next ntrails steps
  // rather than teleporting all at once.
  function maybeReset(seg) {
    const c = seg.cur * 4;
    const dx = seg.trail[c + 2] - seg.trail[c + 0];
    const dy = seg.trail[c + 3] - seg.trail[c + 1];
    if (dx * dx + dy * dy < 100) initNode(seg, seg.cur);
  }

  // One simulation step: propagate every segment (skipping the very first step,
  // the C's done_once), reset any that collapsed, and grow the trails in. This is
  // the SIM only -- no drawing; the caller re-strokes the offscreen cache after a
  // step (or steps) have advanced the figure.
  function step() {
    // One SUB-step: 1/SUBK of a live step's local/global rotation, so SUBK of them
    // equal one C step (the C recomputes these every propigate; fixed here).
    const lsin = Math.sin((TAU / 10000) * config.local_rotation / SUBK);
    const lcos = Math.cos((TAU / 10000) * config.local_rotation / SUBK);
    const gsin = Math.sin((TAU / 10000) * config.global_rotation / SUBK);
    const gcos = Math.cos((TAU / 10000) * config.global_rotation / SUBK);

    for (const seg of segs) {
      if (started) propagate(seg, lcos, lsin, gcos, gsin);
      maybeReset(seg);
      if (seg.nlive < ringLen) seg.nlive++;
    }
    started = true;
  }

  // Re-stroke every segment's live ring onto the OFFSCREEN cache, cleared to
  // black. Each node is one line segment replicated across the symmetry group via
  // the C's iterated NEWX/NEWY rotation (truncated to short per copy), then offset
  // to the screen centre. One beginPath per segment, stroked once in its colour.
  // Called only when the sim has advanced (not every presentation frame).
  function draw() {
    offctx.fillStyle = '#000';
    offctx.fillRect(0, 0, off.width, off.height);
    offctx.lineWidth = lineWidth;
    offctx.lineCap = 'round';     // the C's CapRound
    offctx.lineJoin = 'round';

    // Stroke straight into the context's own (reused) path -- NOT a per-frame
    // `new Path2D()` per segment. Those allocations were steady garbage (7/frame,
    // each ~700 segments) whose periodic GC hitched the WHOLE image; beginPath()
    // reuses one internal buffer, so draw() is now allocation-free.
    for (const seg of segs) {
      offctx.beginPath();
      const live = Math.min(Math.ceil(seg.nlive / SUBK), ntr);
      for (let a = 0; a < live; a++) {
        // newest (a = 0) .. oldest, one LIVE step (SUBK sub-nodes) apart: the sim
        // runs SUBK x finer for smooth motion, but we DRAW only every SUBK-th node
        // so the ribbon keeps the C's line density (not SUBK x too dense). As cur
        // advances one sub-step per frame the whole decimated ribbon shifts by
        // 1/SUBK of a step -> smooth spin at the faithful density.
        let idx = seg.cur - a * SUBK;
        idx = ((idx % ringLen) + ringLen) % ringLen;
        const b = idx * 4;
        let x1 = seg.trail[b + 0], y1 = seg.trail[b + 1];
        let x2 = seg.trail[b + 2], y2 = seg.trail[b + 3];
        for (let k = 0; k < nsym; k++) {
          // Rotate by one more theta (the C's NEWX/NEWY), truncate to short, then
          // offset to screen. The truncated copy feeds the next iteration, so
          // copy k is rotated by (k+1) steps — iterated, exactly as the C does.
          const a1 = trunc16(x1 * costheta + y1 * sintheta);   // NEWX
          const b1 = trunc16(y1 * costheta - x1 * sintheta);   // NEWY
          const a2 = trunc16(x2 * costheta + y2 * sintheta);
          const b2 = trunc16(y2 * costheta - x2 * sintheta);
          x1 = a1; y1 = b1; x2 = a2; y2 = b2;
          offctx.moveTo(x1 + xoff, y1 + yoff);
          offctx.lineTo(x2 + xoff, y2 + yoff);
        }
      }
      offctx.strokeStyle = seg.color;
      offctx.stroke();
    }
  }

  // Blit the offscreen cache to the visible canvas (1:1, no scaling). Cheap image
  // copy; run every presentation frame so the compositor keeps presenting a live
  // layer (which avoids the per-present stall that sparse canvas updates incur).
  function present() {
    ctx.drawImage(off, 0, 0);
  }

  // Seed everything from the current canvas size (the C's init_g + create/init
  // objects). Sizes + clears the offscreen cache, strokes the (empty) figure into
  // it, and shows it.
  function init() {
    xoff = Math.floor(canvas.width / 2);
    yoff = Math.floor(canvas.height / 2);

    nseg = Math.max(1, Math.round(config.nsegments));
    nsym = Math.max(1, Math.round(config.symmetry));
    ntr = Math.max(1, Math.round(config.ntrails));
    ringLen = ntr * SUBK;   // same angular arc, sampled SUBK x finer (see SUBK note)

    costheta = Math.cos(TAU / nsym);
    sintheta = Math.sin(TAU / nsym);

    // The C: line width 1 device px, 3 on Retina (>2560 px). canvas.width/height
    // are device px here, so the threshold maps directly (kaleidescope_reshape).
    lineWidth = (canvas.width > 2560 || canvas.height > 2560) ? 3 : 1;

    // Offscreen cache tracks the visible backing-store size (setting width clears).
    off.width = canvas.width;
    off.height = canvas.height;

    started = false;
    segs = [];
    for (let i = 0; i < nseg; i++) segs.push(makeSeg());

    draw();       // stroke the initial (empty) figure into the cache
    present();    // and show it
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

  // rAF lag-accumulator paced by (delay + OVERHEAD)/SUBK: one SUB-step per that
  // interval, i.e. SUBK sub-steps per live step at the live 30.2 fps. When any
  // step ran this frame the figure changed, so re-stroke the offscreen cache once
  // (regardless of how many steps); every frame then blits the cache to screen.
  // That keeps the expensive stroke at the sim rate (~30 Hz) while presentation
  // stays at the display rate. Catch-up capped so a backgrounded tab can't burst.
  const MAX_CATCHUP_STEPS = 16;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const subStepMs = (config.delay + OVERHEAD) / SUBK / 1000;
    lag = Math.min(lag, subStepMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= subStepMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= subStepMs;
      steps++;
    }

    if (steps > 0) draw();   // re-stroke the cache only when the sim advanced
    present();               // blit the cache to screen every frame
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
