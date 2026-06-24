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
// Rendering (faithful to the C): a persistent Uint32 framebuffer IS the X window.
// The C draws, per object per step, the NEWEST trail node with draw_gc and erases
// the OLDEST (cur->next) with erase_gc (foreground = background = black),
// overdrawing IN PLACE with antialiasing OFF (jwxyz_XSetAntiAliasing False),
// line_width = lw, round caps. We do exactly that: a Uint32Array over an ImageData
// is the persistent buffer (opaque black, never cleared except on init/resize/
// reset — the C clears the window only at start); each node caches its `symmetry`
// integer screen segments (the C's xsegments[]); per step we rasterise the newest
// node's segments in the segment's colour with a non-AA line rasteriser (hard-set
// pixels, no blending — an X GC with AA off) and, if the oldest node was drawn,
// rasterise its CACHED segments in black. That is TWO line-sets per segment per
// step (~154 lines total at the defaults), NOT a full-figure re-stroke: the ~98
// middle nodes persist untouched in the buffer. The black erase punching gaps
// where it crosses live lines is the correct erosion character, not a bug.
//
// Presentation: putImageData the buffer into an offscreen canvas only when the sim
// advances (~30 Hz), then drawImage that 1:1 onto the visible canvas EVERY frame
// (a cheap GPU blit that keeps the compositor presenting a live layer — sparse
// canvas updates otherwise stall the present). See kaleidescope.md.

export const title = 'kaleidescope';

export const info = {
  author: 'Ron Tapia',
  description: 'A simple kaleidoscope made of line segments.\n\nSee "GLeidescope" for a more sophisticated take.\n\nhttps://en.wikipedia.org/wiki/Kaleidoscope',
  year: 1997,
};

export function start(canvas) {
  // Visible context: only ever blits the offscreen canvas (a cheap 1:1 GPU copy).
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;   // 1:1 blit, no resampling

  // Offscreen present canvas: the framebuffer (see the render note up top) is
  // putImageData'd here on each sim step, then drawImage'd to the visible canvas
  // every frame. Same backing-store size, so the blit is 1:1 with no scaling.
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

  // Each trail node is written ONCE by propagate() and rasterised ONCE into the
  // persistent framebuffer (then erased once, ntrails steps later) — the body
  // never moves, so there is nothing to re-draw between steps. That is why the
  // raster is per-step (draw newest / erase oldest), not a per-frame re-stroke.
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

  // Opaque black, packed little-endian RGBA (A=0xFF, B=G=R=0). Background /
  // erase_gc colour, and the value the buffer is cleared to.
  const BLACK = 0xFF000000;

  let xoff, yoff;         // screen centre, device px
  let nseg, nsym, ntr;    // resolved counts (from config, clamped)
  let ringLen;            // trail ring size = ntr * SUBK (arc unchanged, sampled finer)
  let costheta, sintheta; // one symmetry-step rotation (the C's NEWX/NEWY)
  let lineWidth;
  let segs;               // the drifting segments (see makeSeg)
  let started;            // the C's done_once: first step draws the root in place

  let W, H;               // framebuffer dimensions (device px)
  let imageData, buf;     // the persistent framebuffer: Uint32 words over ImageData
  let rasterLine;         // non-AA line rasteriser, chosen by lineWidth (init)
  let discDX = null, discDY = null;  // round-cap disc offsets for lineWidth > 1

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
  // Returned PACKED into the framebuffer's native little-endian RGBA Uint32 word
  // (A=0xFF); the three (nrand(range)+min)>>8 channel draws, in R,G,B order, are
  // byte-identical to the C — only the return type is packed instead of a string.
  function segColor() {
    const r = (nrand(REDRANGE) + REDMIN) >> 8;
    const g = (nrand(GREENRANGE) + GREENMIN) >> 8;
    const b = (nrand(BLUERANGE) + BLUEMIN) >> 8;
    return (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
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
  // Two RENDER-only per-node buffers mirror the C's Ksegment: a `drawn` flag and
  // `xseg`, the cached integer screen segments (the C's xsegments[]).
  function makeSeg() {
    const seg = {
      trail: new Float64Array(ringLen * 4),  // [x1,y1,x2,y2] per node, natural coords
      cur: 0,                            // index of the live (newest) node
      nlive: 0,                          // SIM bookkeeping (render grows in via drawn[])
      color: segColor(),                 // one muted colour for the whole ribbon (packed RGBA)
      drawn: new Uint8Array(ringLen),    // the C's per-node `drawn` flag (0 / 1)
      xseg: new Int32Array(ringLen * nsym * 4),  // cached screen segments (the C's xsegments[])
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
  // the SIM only -- no drawing; the caller renders each step's delta afterward.
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

  // ---- Non-AA line rasteriser (an X GC with antialiasing OFF) -----------------

  // Hard-set one framebuffer pixel to a packed RGBA word (no blending), bounds-
  // checked. This IS the pixel op of a non-AA X GC.
  function setPixel(x, y, color) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    buf[y * W + x] = color;
  }

  // Integer Bresenham line, one hard-set pixel per step. For a 1px GC this is an
  // exact XDrawSegments with AA off (a width-1 CapRound line is a bare Bresenham).
  function drawLine1(x0, y0, x1, y1, color) {
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      setPixel(x0, y0, color);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  // Round-cap disc offsets for lineWidth > 1 (the C's CapRound wide line == the
  // Minkowski sum of the centre line with a disc of radius lw/2). Built in init().
  function buildDisc(r) {
    const dxs = [], dys = [];
    const ri = Math.ceil(r), r2 = r * r;
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        if (dx * dx + dy * dy <= r2) { dxs.push(dx); dys.push(dy); }
      }
    }
    discDX = Int32Array.from(dxs);
    discDY = Int32Array.from(dys);
  }

  // Thick Bresenham line: stamp the round-cap disc at every centre pixel — a
  // faithful width-lw CapRound line, still hard-set (no AA).
  function drawLineThick(x0, y0, x1, y1, color) {
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    const n = discDX.length;
    for (;;) {
      for (let i = 0; i < n; i++) setPixel(x0 + discDX[i], y0 + discDY[i], color);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  // Compute node k's `symmetry` screen segments from its natural endpoints and
  // cache them on the node (the C's xsegments[]): the iterated NEWX/NEWY rotation
  // (truncated to short per copy, exactly as the C), then offset to the centre.
  // Copy k is rotated (k+1) times because each iteration feeds its truncated
  // result forward — the small per-step rounding of the original is reproduced.
  function cacheSegments(seg, k) {
    const b = k * 4;
    let x1 = seg.trail[b + 0], y1 = seg.trail[b + 1];
    let x2 = seg.trail[b + 2], y2 = seg.trail[b + 3];
    const base = k * nsym * 4;
    const xs = seg.xseg;
    for (let i = 0; i < nsym; i++) {
      const a1 = trunc16(x1 * costheta + y1 * sintheta);   // NEWX
      const c1 = trunc16(y1 * costheta - x1 * sintheta);   // NEWY
      const a2 = trunc16(x2 * costheta + y2 * sintheta);
      const c2 = trunc16(y2 * costheta - x2 * sintheta);
      x1 = a1; y1 = c1; x2 = a2; y2 = c2;
      const o = base + i * 4;
      xs[o + 0] = x1 + xoff;
      xs[o + 1] = y1 + yoff;
      xs[o + 2] = x2 + xoff;
      xs[o + 3] = y2 + yoff;
    }
  }

  // Rasterise node k's cached symmetry segments in `color` (the C's XDrawSegments
  // of one node's xsegments[] with a single GC).
  function rasterNode(seg, k, color) {
    const base = k * nsym * 4;
    const xs = seg.xseg;
    for (let i = 0; i < nsym; i++) {
      const o = base + i * 4;
      rasterLine(xs[o + 0], xs[o + 1], xs[o + 2], xs[o + 3], color);
    }
  }

  // One render pass == the C's draw_objects, in object order across the segments.
  // For each segment: cache + draw the NEWEST node (cur) in its colour and flag it
  // drawn; then, if the OLDEST live node (cur->next) was ever drawn, erase it in
  // black using its CACHED segments. That is the C's draw_gc-then-erase_gc pair,
  // in the same order — so the black erase correctly erodes any live line it
  // crosses. Called once per sim step (after step()), NOT per presentation frame.
  function render() {
    for (const seg of segs) {
      const cur = seg.cur;
      cacheSegments(seg, cur);
      rasterNode(seg, cur, seg.color);          // draw_gc: newest node, its colour
      seg.drawn[cur] = 1;
      const nxt = (cur + 1) % ringLen;          // cur->next == the oldest ring node
      if (seg.drawn[nxt]) rasterNode(seg, nxt, BLACK);   // erase_gc: black
    }
  }

  // Push the framebuffer word array into the offscreen canvas (a full upload, run
  // only when the sim advanced, ~30 Hz).
  function blitBuffer() {
    offctx.putImageData(imageData, 0, 0);
  }

  // Show the offscreen canvas on the visible canvas: a 1:1 GPU blit, run every
  // presentation frame so the compositor keeps presenting a live layer (sparse
  // canvas updates otherwise stall the present — the prior finding).
  function present() {
    ctx.drawImage(off, 0, 0);
  }

  // Seed everything from the current canvas size (the C's init_g + create/init
  // objects). Allocates the persistent framebuffer, clears it to black, and shows
  // it. No nodes are drawn yet — the first draw is the first sim step (as in the C,
  // where the first kaleidescope_draw draws the root in place).
  function init() {
    xoff = Math.floor(canvas.width / 2);
    yoff = Math.floor(canvas.height / 2);

    nseg = Math.max(1, Math.round(config.nsegments));
    nsym = Math.max(1, Math.round(config.symmetry));
    ntr = Math.max(1, Math.round(config.ntrails));
    ringLen = ntr * SUBK;   // same angular arc, sampled SUBK x finer (see SUBK note)

    costheta = Math.cos(TAU / nsym);
    sintheta = Math.sin(TAU / nsym);

    // The C's kaleidescope_reshape: line width 1 device px, 3 above 2560 px
    // (Retina). canvas.width/height are device px, so the threshold maps directly.
    lineWidth = (canvas.width > 2560 || canvas.height > 2560) ? 3 : 1;
    if (lineWidth > 1) { buildDisc(lineWidth / 2); rasterLine = drawLineThick; }
    else rasterLine = drawLine1;

    // The persistent framebuffer == the X window: one Uint32 word per device pixel
    // over an ImageData, background opaque black, never cleared except here.
    W = canvas.width;
    H = canvas.height;
    off.width = W;
    off.height = H;
    imageData = offctx.createImageData(W, H);
    buf = new Uint32Array(imageData.data.buffer);
    buf.fill(BLACK);

    started = false;
    segs = [];
    for (let i = 0; i < nseg; i++) segs.push(makeSeg());

    blitBuffer();   // push the (black) buffer to the offscreen canvas
    present();      // and show it
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
  // interval, i.e. SUBK sub-steps per live step at the live 30.2 fps. Each step
  // rasterises its own delta (draw newest / erase oldest) into the persistent
  // framebuffer; when any step ran we upload the buffer to the offscreen canvas
  // ONCE (blitBuffer), and every frame blit that offscreen to screen (present). So
  // the raster stays at the sim rate (~30 Hz) while presentation is the display
  // rate. Catch-up capped so a backgrounded tab can't burst.
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
      step();      // advance the sim one step (propagate + reset, all segments)
      render();    // rasterise THIS step's delta (draw newest, erase oldest)
      lag -= subStepMs;
      steps++;
    }

    if (steps > 0) blitBuffer();   // upload the changed framebuffer once
    present();                     // 1:1 blit to screen every frame
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
