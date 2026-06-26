// starfish.js — starfish packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's starfish.c by Jamie Zawinski (1997).
// https://www.jwz.org/xscreensaver/
//
// One big undulating radial-spline blob: N control radii arranged evenly
// around a centre, every `skip`-th one a "valley" (radius 0) and the rest
// "peaks", joined into a single CLOSED smooth spline. Each frame the radii
// throb in and out (sin-like oscillation between min_r and max_r), the whole
// thing slowly spins with accelerating/reversing rotation, and a single colour
// cycles smoothly through a rainbow. Periodically the shape is re-rolled with a
// new arm count / spin / size. Sparse vector path (one filled spline/frame),
// not per-pixel. Closest twin: [[piecewise]] (filled vector blobs + a single
// slowly-cycling hue); shares the closed-spline morph idea other blob hacks use.

export const title = 'starfish';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Undulating, throbbing, star-like patterns pulsate, rotate, and turn inside out.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');
  const TAU = Math.PI * 2;

  // Defaults/ranges mirror hacks/config/starfish.xml (1:1 with the original),
  // except `delay` is nudged from the stock 10000 to ~one display frame for
  // smooth motion. The C tripled both elasticity/rotation AND delay for blob
  // mode (which cancels in real time) — we keep a single delay and don't
  // triple, so blob and "color gradients" throb at the same calm real-time
  // pace the original netted out to. See the .md.
  const config = {
    delay: 16000,      // microseconds between steps (--delay; stock 10000)
    mode: 'random',    // 'random' | 'zoom' (color gradients) | 'blob' (--mode)
    duration: 30,      // seconds before the shape is re-rolled (--duration)
    thickness: 0,      // throb speed in px/frame; 0 = random (--thickness)
    ncolors: 200,      // size of the hue cycle (--colors)
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes the shape / render mode, so a change
  //                re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 16000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'mode', label: 'Mode', type: 'select', default: 'random', live: false, options: [
        { value: 'random', label: 'Random' },
        { value: 'zoom', label: 'Color gradients' },
        { value: 'blob', label: 'Pulsating blob' },
      ] },
    { key: 'duration', label: 'Duration', type: 'range', min: 1, max: 60, step: 1, default: 30, unit: ' s', lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'thickness', label: 'Throb speed', type: 'range', min: 0, max: 150, step: 1, default: 0, lowLabel: 'auto', highLabel: 'fast', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: true },
  ];

  // C helpers: frand(x) -> [0,x); irand(n) -> integer [0,n); RANDSIGN() -> +-1.
  const frand = (x) => Math.random() * x;
  const irand = (n) => Math.floor(Math.random() * n);
  const randsign = () => (Math.random() < 0.5 ? 1 : -1);

  let S = 1;          // devicePixelRatio
  let W = 0, H = 0;   // canvas size, device px
  let blobP = false;  // render/size mode, fixed per init() (the C's st->blob_p)
  let fish = null;    // the current starfish (see makeStarfish)
  let hue = 0;        // current cycling hue in degrees (the C's fg_index)
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
    // at the centre (sharp arms); in "pulse" everything throbs.
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

  // Build the closed spline as a Path2D. compute_closed_spline() in the C is the
  // standard uniform cubic B-spline -> Bezier conversion wrapped around the
  // control array; each section i (control[i] -> control[i+1]) has Bezier points
  //   p0 = (c[i-1] + 4 c[i] + c[i+1]) / 6
  //   p1 = (2 c[i] + c[i+1]) / 3
  //   p2 = (c[i] + 2 c[i+1]) / 3
  //   p3 = (c[i] + 4 c[i+1] + c[i+2]) / 6
  // and p3 of section i == p0 of section i+1, so the curve is C2-continuous and
  // closes seamlessly (canvas draws the Beziers natively — no subdivision, no
  // integer-pixel polygon, so it stays smooth at any DPI). The wrap uses
  // (i +- k + n) % n on every index, so there is no off-by-one kink at the seam.
  function buildPath(s) {
    const n = s.npoints;
    const cx = s.cx;
    const cy = s.cy;
    const path = new Path2D();

    // Start at p0 of section 0.
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
    return path;
  }

  // Draw the shape. The C cycles a colourmap (the colour shifts one step per
  // frame) and fills with the EvenOddRule (so self-crossings, when the star
  // turns inside out, read as holes). We keep even-odd, and emulate the colour
  // cycle with a smoothly advancing hue. "Pulsating blob" = one solid hue;
  // "color gradients" = a radial rainbow that also rotates — the full-repaint
  // stand-in for the C's accumulated concentric colour bands. See the .md.
  function drawFish(s) {
    const path = buildPath(s);

    if (blobP) {
      ctx.fillStyle = `hsl(${hue.toFixed(1)}, 100%, 55%)`;
    } else {
      const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.maxR);
      const stops = 6;
      for (let k = 0; k <= stops; k++) {
        const h = (hue + k * 360 / stops) % 360;
        grad.addColorStop(k / stops, `hsl(${h.toFixed(1)}, 100%, 55%)`);
      }
      ctx.fillStyle = grad;
    }

    ctx.fill(path, 'evenodd');
  }

  // One step: throb, spin, repaint (clear + fill), advance the hue, and re-roll
  // the shape after `duration` seconds of sim time.
  function step() {
    throb(fish);
    spin(fish);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    drawFish(fish);

    // Smooth colour cycle: one colourmap step per frame == 360/ncolors degrees.
    hue = (hue + 360 / Math.max(2, config.ncolors)) % 360;

    elapsedMs += config.delay / 1000;
    if (config.duration > 0 && elapsedMs >= config.duration * 1000) {
      elapsedMs = 0;
      fish = makeStarfish();
      // Every now and then, jump to fresh colours (the C re-rolls its colourmap).
      if (irand(10) === 0) hue = frand(360);
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

    hue = frand(360);
    elapsedMs = 0;
    fish = makeStarfish();
  }

  // reinit clears to black and re-seeds (mode/throb-speed may have changed).
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    init();
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
    const delayMs = config.delay / 1000;
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
