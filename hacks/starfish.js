// starfish.js — starfish packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's starfish.c by Jamie Zawinski (1997).
// https://www.jwz.org/xscreensaver/
//
// One big undulating radial-spline blob: N control radii arranged evenly around
// a centre, every `skip`-th one a "valley" (radius 0) and the rest "peaks",
// joined into a single CLOSED smooth spline. Each frame the radii throb in and
// out (between min_r and max_r), the whole thing slowly spins with
// accelerating/reversing rotation, and the fill colour advances one step through
// a colourmap. Periodically the shape is re-rolled (new arm count / spin / size).
//
// RENDER MODEL (faithful to draw_starfish): each frame fills the EvenOddRule
// region BETWEEN this frame's outline and the PREVIOUS frame's outline — i.e.
// the thin band the shape just swept — in the next colourmap colour. In
// "zoom"/colour-gradients mode the canvas is NEVER cleared after the first frame,
// so successive bands ACCUMULATE into concentric colour rings (the signature
// look); in "blob" mode the canvas is cleared each frame, leaving one writhing
// shape. The C uses a plain GXcopy fill with EvenOddRule (NOT XOR). Sparse vector
// path (a couple of splines per frame), not per-pixel.

import { makeSmoothColormapRGB, makeColorRampRGB } from './colormap.js';

export const title = 'starfish';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Undulating, throbbing, star-like patterns pulsate, rotate, and turn inside out.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');
  const TAU = Math.PI * 2;

  // Defaults/ranges mirror hacks/config/starfish.xml 1:1 (delay/mode/duration/
  // thickness/ncolors). `delay` is the usleep interval in microseconds; blob mode
  // runs it (and the throb/spin) 3x, exactly as the C. (showfps is a framework
  // control and is not exposed, matching the sibling ports.)
  const config = {
    delay: 10000,      // microseconds between steps (--delay; xml default 10000)
    mode: 'random',    // 'random' | 'zoom' (color gradients) | 'blob' (--mode)
    duration: 30,      // seconds before the shape is re-rolled (--duration)
    thickness: 0,      // elasticity / radial velocity in px; 0 = random (--thickness)
    ncolors: 200,      // size of the colourmap (--colors)
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes the shape / palette, so a change re-runs
  //                init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'mode', label: 'Mode', type: 'select', default: 'random', live: false, options: [
        { value: 'random', label: 'Random' },
        { value: 'zoom', label: 'Color gradients' },
        { value: 'blob', label: 'Pulsating blob' },
      ] },
    { key: 'duration', label: 'Duration', type: 'range', min: 1, max: 60, step: 1, default: 30, unit: ' s', lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'thickness', label: 'Thickness', type: 'range', min: 0, max: 150, step: 1, default: 0, lowLabel: 'thin', highLabel: 'thick', live: false },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 2, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // C helpers: frand(x) -> [0,x); irand(n) -> integer [0,n); RANDSIGN() -> +-1.
  const frand = (x) => Math.random() * x;
  const irand = (n) => Math.floor(Math.random() * n);
  const randsign = () => (Math.random() < 0.5 ? 1 : -1);

  let S = 1;          // devicePixelRatio
  let W = 0, H = 0;   // canvas size, device px
  let blobP = false;  // render mode, fixed per init() (the C's st->blob_p)
  let fish = null;    // the current starfish (see makeStarfish)
  let prev = null;    // previous frame's outline {cx,cy,n} (the C's s->prev)
  let palette = null; // Array of fillStyle strings (the C's st->colors)
  let ncolors = 200;  // captured colour count, 2..255 (the C's st->ncolors)
  let fgIndex = 0;    // index into palette, +1/frame (the C's fg_index)
  let elapsedMs = 0;  // sim time since the shape was last re-rolled

  // make_starfish(): roll a fresh shape. Geometry is in device px. `blobP` is
  // read from the outer state (set once per init(), like the C). The deformation
  // mode (valleys pinned vs throbbing) is re-rolled here every time, per the C.
  function makeStarfish() {
    let size = Math.min(W, H);
    if (blobP) size /= 2;
    else size *= 1.3;

    // elasticity = radial velocity (px/frame). thickness 0 -> bell curve 0..15,
    // avg 7.5 (the C's RAND(5)+RAND(5)+RAND(5)); else fixed. Scaled by S so the
    // throb looks the same on retina.
    let elasticity = config.thickness * S;
    if (elasticity === 0) {
      elasticity = (frand(5) + frand(5) + frand(5)) * S;
    }

    // rotation resource is -1 (random): bell curve 0..12 degrees, avg 6, then
    // converted from degrees to a per-frame ratio.
    let rotv = (frand(4) + frand(4) + frand(4)) / 360;

    // blob mode deforms and spins 3x faster per frame (paired with delay*3, see
    // effDelayMs); rot_max is taken AFTER the *3, exactly as the C orders it.
    if (blobP) {
      elasticity *= 3;
      rotv *= 3;
    }

    const rotMax = rotv * 2;
    let rota = 0.0004 + frand(0.0002);

    // Occasionally make it smaller (bell curve 0.3..1.0, avg 0.65).
    if (irand(20) === 0) {
      size *= frand(0.35) + frand(0.35) + 0.3;
    }

    // skip = control points per arm group; mostly 2 or 3.
    const skips = [
      2, 2, 2, 2,
      3, 3, 3,
      6, 6,
      12,
    ];
    const skip = skips[irand(skips.length)];

    // Deformation mode: in "zoom" the valleys (every skip-th point) stay pinned
    // at the centre (sharp arms); in "pulse" everything throbs. (This is the C's
    // per-shape s->mode — distinct from blobP, which is the render mode.)
    const defZoom = irand(skip === 2 ? 3 : 12) === 0;

    let maxR = size;
    let minR = 5 * S;
    if (maxR <= minR) maxR = minR + 1;  // guard a tiny field

    const x = W / 2;
    const y = H / 2;
    const th = frand(TAU) * randsign();

    // npoints = skip * a size multiplier (= the number of arms). skip > 3 drops
    // the four largest multipliers so big-skip stars don't get absurdly dense.
    const sizes = [
      3, 3, 3, 3, 3,
      4, 4, 4, 4,
      5, 5, 5, 5, 5, 5,
      8, 8, 8,
      10,
      35,
    ];
    let nsizes = sizes.length;
    if (skip > 3) nsizes -= 4;
    const npoints = skip * sizes[irand(nsizes)];

    // r[i] is the signed radius (sign encodes grow/shrink direction). Peaks
    // start at full size, valleys at 0 -> frame 1 already shows a full starfish.
    const r = new Array(npoints);
    for (let i = 0; i < npoints; i++) {
      r[i] = (i % skip === 0) ? 0 : size;
    }

    return {
      skip,
      defZoom,
      x,
      y,
      th,
      rotv,
      rota,
      rotMax,
      elasticity,
      minR,
      maxR,
      npoints,
      r,
      cx: new Array(npoints),  // control-point x, filled by throb()
      cy: new Array(npoints),  // control-point y, filled by throb()
    };
  }

  // throb_starfish(): place each control point at its current radius/angle, then
  // step its radius toward the opposite extreme. Easing slows the motion near
  // min_r/max_r so it's fastest in the middle. Verbatim from the C.
  function throb(s) {
    const frac = TAU / s.npoints;
    const th = Math.abs(s.th);
    const range = s.maxR - s.minR;

    for (let i = 0; i < s.npoints; i++) {
      let r = s.r[i];
      let ra = r > 0 ? r : -r;

      // Place control points evenly around the perimeter, shifted by theta.
      s.cx[i] = s.x + ra * Math.cos(i * frac + th);
      s.cy[i] = s.y + ra * Math.sin(i * frac + th);

      // In zoom-deformation mode the valleys stay pinned at the centre.
      if (s.defZoom && (i % s.skip) === 0) continue;

      // Slow down near the end points: move fastest in the middle.
      let elasticity = s.elasticity;
      let ratio = ra / range;
      if (ratio > 0.5) ratio = 1 - ratio;  // flip
      ratio *= 2;                           // normalize
      ratio = ratio * 0.9 + 0.1;            // fudge
      elasticity *= ratio;

      // Increase/decrease radius by elasticity.
      ra += (r >= 0 ? elasticity : -elasticity);
      if ((i % s.skip) === 0) ra += elasticity / 2;

      r = ra * (r >= 0 ? 1 : -1);

      // If we've reached the end (too long or too short) reverse direction.
      if ((ra > s.maxR && r >= 0) ||
          (ra < s.minR && r < 0)) {
        r = -r;
      }

      s.r[i] = r;
    }
  }

  // spin_starfish(): advance theta by rotv, accelerate rotv by rota, bounce rota
  // at +-rot_max, occasionally stop/reverse, and rarely perturb the
  // acceleration. Verbatim from the C (sign-of-theta bookkeeping and all).
  function spin(s) {
    let th = s.th;
    if (th < 0) th = -(th + s.rotv);
    else th += s.rotv;

    if (th > TAU) th -= TAU;
    else if (th < 0) th += TAU;

    s.th = (s.th > 0 ? th : -th);

    s.rotv += s.rota;

    if (s.rotv > s.rotMax || s.rotv < -s.rotMax) {
      s.rota = -s.rota;
    } else if (s.rotv < 0) {
      // If it stops, start it going in the other direction.
      if (Math.random() < 0.5) {
        // keep going in the same direction
        s.rotv = 0;
        if (s.rota < 0) s.rota = -s.rota;
      } else {
        // reverse gears
        s.rotv = -s.rotv;
        s.rota = -s.rota;
        s.th = -s.th;
      }
    }

    // Alter direction of rotational acceleration randomly.
    if (irand(120) === 0) s.rota = -s.rota;

    // Change acceleration very occasionally.
    if (irand(200) === 0) {
      if (Math.random() < 0.5) s.rota *= 1.2;
      else s.rota *= 0.8;
    }
  }

  // compute_closed_spline + draw: append one closed outline (the smooth spline
  // through control points cx/cy) to `path` as native Bezier sections. Each
  // section i (control i -> i+1) has Bezier points
  //   p0 = (c[i-1] + 4 c[i] + c[i+1]) / 6   p1 = (2 c[i] + c[i+1]) / 3
  //   p2 = (c[i] + 2 c[i+1]) / 3            p3 = (c[i] + 4 c[i+1] + c[i+2]) / 6
  // (calc_section reduced), and p3 of section i == p0 of section i+1, so the curve
  // is C2-continuous and closes seamlessly. The C flattens each Bezier to a
  // polyline (add_bezier_arc); canvas renders the true Bezier, identical to
  // sub-pixel at any DPI. Every index wraps (i +- k + n) % n -> no seam kink.
  function appendOutline(path, cx, cy, n) {
    const m = (n - 1) % n;
    const p = 1 % n;
    path.moveTo(
      (cx[m] + 4 * cx[0] + cx[p]) / 6,
      (cy[m] + 4 * cy[0] + cy[p]) / 6,
    );
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      const i2 = (i + 2) % n;
      path.bezierCurveTo(
        (2 * cx[i] + cx[i1]) / 3,
        (2 * cy[i] + cy[i1]) / 3,
        (cx[i] + 2 * cx[i1]) / 3,
        (cy[i] + 2 * cy[i1]) / 3,
        (cx[i] + 4 * cx[i1] + cx[i2]) / 6,
        (cy[i] + 4 * cy[i1] + cy[i2]) / 6,
      );
    }
    path.closePath();
  }

  // draw_starfish(): fill the EvenOddRule region between THIS frame's outline and
  // the PREVIOUS frame's outline (their symmetric difference — the band the shape
  // just swept) in palette[fgIndex]. The C concatenates both polygons into one
  // even-odd XFillPolygon; two closed sub-paths give the identical region (bar a
  // measure-zero connector sliver). zoom mode never clears, so bands accumulate
  // into concentric colour rings; blob mode clears each frame, leaving a single
  // writhing shape. The colour advances one colourmap entry per frame. The first
  // frame after a (re)seed has no prev, so it only records the outline — matching
  // the C's `if (s->prev)` guard. fg_index advances unconditionally.
  function drawFish(s) {
    const n = s.npoints;
    if (prev) {
      const band = new Path2D();
      appendOutline(band, s.cx, s.cy, n);
      appendOutline(band, prev.cx, prev.cy, prev.n);
      if (blobP) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
      }
      ctx.fillStyle = palette[fgIndex];
      ctx.fill(band, 'evenodd');
    }
    prev = { cx: s.cx.slice(0, n), cy: s.cy.slice(0, n), n };
    fgIndex = (fgIndex + 1) % ncolors;
  }

  // reset_starfish()'s colourmap: 2/3 of the time make_smooth_colormap (2-5
  // random HSV anchors, often muted/pastel), 1/3 make_uniform_colormap (a full
  // hue sweep 0..359 at one random saturation/value in 66..99%). Both via the
  // faithful colormap.js helpers; stored as fillStyle strings. Rebuilt only at
  // init and on the 1/10 duration re-rolls, exactly like the C.
  function buildPalette() {
    let map;
    if (irand(3) !== 0) {               // random() % 3 nonzero -> 2/3 smooth
      map = makeSmoothColormapRGB(ncolors);
    } else {                            // 1/3 uniform (a make_color_ramp)
      const sat = (irand(34) + 66) / 100;   // the C's (random()%34 + 66)/100
      const val = (irand(34) + 66) / 100;
      map = makeColorRampRGB(0, sat, val, 359, sat, val, ncolors, false);
    }
    palette = map.map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);
  }

  // reset_starfish(): fresh colourmap + fresh shape, fg_index back to 0. `clear`
  // mirrors the C's done_once gate — the window is cleared exactly once (at init /
  // on a resize-reinit), to colourmap[0] in zoom mode or black in blob mode — so
  // zoom-mode bands keep accumulating across every later re-roll.
  function reset(clear) {
    buildPalette();
    fgIndex = 0;
    prev = null;
    fish = makeStarfish();
    if (clear) {
      ctx.fillStyle = blobP ? '#000' : palette[0];
      ctx.fillRect(0, 0, W, H);
    }
  }

  // make_window_starfish(): a fresh shape only — same colourmap, fg_index keeps
  // cycling, no clear. prev resets so the new shape's first frame just records.
  function rerollShape() {
    prev = null;
    fish = makeStarfish();
  }

  // blob mode runs delay*3 in the C (with elasticity/rotv also *3, applied in
  // makeStarfish): chunkier, bigger per-frame steps. OVERHEAD encodes the per-frame
  // framework cost (sparse-vector draw + vsync/event handling) the C pays ON TOP of
  // its usleep(delay): the live binary measures 55.6fps in zoom mode at the xml
  // default delay 10000 (== 1e6/(10000+8000)), not the 100fps a bare 10ms sleep
  // implies. Without it the port lays bands ~1.8x too fast, so zoom-mode rings wash
  // out in half the wall-clock time (the live washes too, just half as fast). Added
  // ONCE per frame (after the blob *3), matching the C's real frame period
  // delay*[3] + overhead. See framerate-calibration; siblings dangerball/cubicgrid
  // carry the same constant (theirs is larger: GL frames cost more than 2D vectors).
  const OVERHEAD = 8000;   // us; calibrates xml delay 10000 -> measured ~55.6fps
  function effDelayMs() {
    return (config.delay * (blobP ? 3 : 1) + OVERHEAD) / 1000;
  }

  // One step: throb, spin, draw the swept band, then re-roll the shape after
  // `duration` seconds of sim time (1-in-10 of those re-rolls the colourmap too).
  function step() {
    throb(fish);
    spin(fish);
    drawFish(fish);

    elapsedMs += effDelayMs();
    if (config.duration > 0 && elapsedMs >= config.duration * 1000) {
      elapsedMs = 0;
      // Every now and then pick new colours; otherwise keep the current map.
      if (irand(10) === 0) reset(false);  // new colourmap, NO clear (zoom keeps accumulating)
      else rerollShape();
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // st->blob_p is decided once: 'blob'/'zoom' force it, 'random' is 1/3 blob.
    blobP = config.mode === 'blob' ? true
          : config.mode === 'zoom' ? false
          : irand(3) === 0;

    // The C forces ncolors >= 2 (and treats <= 2 as mono b/w; we just build a
    // 2-colour map there). xml allows 1; we clamp to 2.
    ncolors = Math.max(2, Math.min(255, Math.round(config.ncolors)));
    elapsedMs = 0;
    reset(true);   // build colourmap + shape, clear once (the done_once gate)
  }

  // reinit re-seeds (mode/thickness/ncolors may have changed); init()'s reset
  // clears appropriately.
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

  // Drive off requestAnimationFrame but keep the original pace: one step() per
  // effective delay, banking leftover time so the speed is the same at any refresh
  // rate. Cap catch-up so a backgrounded tab doesn't fire a burst on refocus.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // effDelayMs() is in ms (config.delay is microseconds, *3 in blob mode); the
    // rAF clock is milliseconds.
    const delayMs = effDelayMs();
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
    reinit,   // re-seed the starfish + clear, keeping the current config
    config,
    params,
  };
}
