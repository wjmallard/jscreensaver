// vfeedback.js — vfeedback packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's vfeedback.c (Jamie Zawinski, 2018-2025).
// https://www.jwz.org/xscreensaver/
//
// "Simulates video feedback: pointing a video camera at an NTSC television."
// A camcorder aimed at the monitor it is plugged into: every frame, the camera
// re-grabs the screen it just drew, slightly rotated / zoomed / panned, and
// feeds it back. Repeated 30x a second that recursion folds the image into
// endless tunnels and spirals, kept alive by stray bright reflections and a
// slow colour (tint) drift — the classic video-feedback look.
//
// Canvas self-feedback (the load-bearing deviation):
//   The C's grab_rectangle() XGetImage's the whole window, then resamples it
//   through the camera rectangle `rect` (offset x,y + zoom w,h + rotation th)
//   into a fresh image that analogtv then re-renders as an NTSC frame. That is
//   exactly canvas self-feedback: we keep a scratch canvas, copy the current
//   frame into it, then redraw it back onto the main canvas through
//   ctx.translate/rotate/scale/translate + drawImage — the same trick as
//   kumppa.js. drawImage's bilinear sampling is the smear; a slight darkening
//   of the fed-back image plus the bright source injection keep the loop
//   bounded (never collapsing to black, never blowing out to white).
//
// Two energy sources keep the recursion alive (matching the C):
//   - a moving bright "specular" reflection (the C's XFillArc on st->specular)
//     that fades in and out — the bright camera glare the tunnels chase, and
//   - a slow hue drift (the C's analogtv tint_control wandering) applied to the
//     fed-back image each frame, so the tunnel rings cycle through colour.
//
// See vfeedback.md for the analogtv ↔ canvas equivalence and the stability
// proof; see [[kumppa]] for the scratch-canvas self-feedback idiom this shares
// and [[squiral]] for the module skeleton.

export const title = 'vfeedback';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Simulates video feedback: pointing a video camera at an NTSC television.',
  year: 2018,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/vfeedback.xml plus the C's
  // vfeedback_defaults[]. The C exposes noise + speed and the analogtv TV
  // knobs (colour / tint / brightness / contrast). We keep the user-facing
  // knobs that have a visible canvas analogue: noise (a faint static overlay),
  // speed (how fast the camera drifts), tint (hue-drift rate / "Tint Knob"),
  // and add a feedback "gain" (how bright the recursion is kept — the analogtv
  // contrast/level the C randomises) plus a Frame-rate slider. The full NTSC
  // colour pipeline is not reproduced; see vfeedback.md.
  const config = {
    delay: 33367,      // microseconds/step ~ 29.97 fps, the C's (1/29.97)s budget
    speed: 1.0,        // camera drift rate (--speed); scales the per-step easing
    noise: 0.02,       // faint static strength (--noise / "Noise")
    tint: 5,           // hue-drift in degrees/step (the analogtv tint drift)
    gain: 0.94,        // per-pass feedback brightness (<1 = bounded recursion)
    seed: 0,           // unused live value; reinit re-rolls the camera geometry
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 33367, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.1, max: 3, step: 0.1, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'tint', label: 'Tint Knob', type: 'range', min: 0, max: 30, step: 0.5, default: 5, unit: '\u00B0/step', lowLabel: 'steady', highLabel: 'cycling', live: true },
    { key: 'gain', label: 'Feedback', type: 'range', min: 0.85, max: 0.985, step: 0.005, default: 0.94, lowLabel: 'short', highLabel: 'deep', live: true },
    { key: 'noise', label: 'Noise', type: 'range', min: 0, max: 0.2, step: 0.005, default: 0.02, lowLabel: 'low', highLabel: 'high', live: true },
  ];

  // Cap the canvas backing store so the per-frame feedback pass (a full-canvas
  // ctx.filter hue-rotate + drawImage, the GPU-bound step) operates on far
  // fewer pixels. Video feedback is intrinsically blurry and the C's source is
  // NTSC-resolution (about 720 px), so the GPU upscale back to the display is
  // invisible. The longer backing-store edge is held at or below MAX_EDGE.
  const MAX_EDGE = 1280;

  let S = 1;               // effective backing-store px per CSS px (see init)
  let W, H;                // canvas size, device px
  let cx, cy;              // center, device px
  let scratch, sctx;       // scratch canvas for the self-feedback copy
  let noiseCanvas, nctx;   // small tiled static buffer (regenerated each frame)
  let hue;                 // accumulated hue drift, degrees

  // The C's camera rectangle: a normalised sub-rectangle of the previous frame
  // the camcorder is aimed at. x,y = pan (fraction of frame, 0 = centred),
  // w,h = zoom (1 = full frame), th = rotation in radians. `rect` is the live
  // target, `orect` the value at the start of the current MOVE, and the four
  // d* are the per-MOVE deltas eased in over `value` 0->1. (struct state.rect /
  // orect / dx,dy,ds,dth / value in the C.)
  let rect, orect;
  let dx, dy, ds, dth;
  let value;               // 0..1 ease parameter for the current MOVE
  let stateName;           // 'POWERUP' | 'IDLE' | 'MOVE'

  // The bright specular reflection the tunnels chase (the C's st->specular +
  // svalue): position, current radius, and its own 0..1 fade parameter.
  let spec;                // { x, y, s } in device px, s = 0 means inactive
  let svalue;

  function rsign() {
    return Math.random() < 0.5 ? -1 : 1;
  }

  function frand(n) {
    return Math.random() * n;
  }

  // Ease-in-out-sine, matching the C's ease(EASE_IN_OUT_SINE, t): smooth start
  // and stop so the camera glides between poses instead of jerking.
  function easeInOutSine(t) {
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
  }

  // Pick a fresh random camera framing (the C's twiddle_camera): a small pan,
  // a zoom a little either side of 1, and a noticeable rotation. This is what
  // gives the spiral its pitch; re-rolled occasionally and on reinit.
  function twiddleCamera() {
    rect = {
      x: frand(0.1) * rsign(),
      y: frand(0.1) * rsign(),
      w: 1 + frand(0.4) * rsign(),
      h: 0,                                 // kept square with w just below
      th: 0.2 + frand(1.0) * rsign(),
    };
    rect.h = rect.w;
    orect = { ...rect };
  }

  // Advance the camera one frame. Mirrors vfeedback_draw()'s state machine:
  // MOVE eases rect from orect toward orect + the d* deltas; when value passes
  // 1 we pick the next pose (IDLE -> MOVE rolls new random pan/zoom/rotate
  // deltas, MOVE -> IDLE pauses briefly). POWERUP just settles into IDLE so the
  // first visible frame already has a live camera.
  function advanceCamera() {
    if (stateName === 'MOVE') {
      const v = easeInOutSine(value);
      rect.x = orect.x + dx * v;
      rect.y = orect.y + dy * v;
      rect.th = orect.th + dth * v;
      rect.w = orect.w * (1 + ds * v);
      rect.h = orect.h * (1 + ds * v);
    }

    value += 0.03 * config.speed;
    if (value > 1 || stateName === 'POWERUP') {
      orect = { ...rect };
      value = 0;
      dx = dy = ds = dth = 0;

      if (stateName === 'POWERUP') {
        stateName = 'IDLE';
      } else if (stateName === 'IDLE') {
        stateName = 'MOVE';
        if (!(Math.floor(Math.random() * 5))) ds = frand(0.2) * rsign();   // zoom
        if (!(Math.floor(Math.random() * 3))) dth = frand(0.2) * rsign();  // rotate
        if (!(Math.floor(Math.random() * 8))) {                            // pan
          dx = frand(0.05) * rsign();
          dy = frand(0.05) * rsign();
        }
        if (!(Math.floor(Math.random() * 2000))) {
          // The C re-twiddles the TV knobs here; our visible analogue is a
          // small kick to the hue so the colour occasionally jumps.
          hue += frand(60) * rsign();
          if (!(Math.floor(Math.random() * 10))) twiddleCamera();
        }
      } else {            // MOVE -> IDLE: brief pause (the C sets value 0.3)
        stateName = 'IDLE';
        value = 0.3;
      }
    }

    // The specular reflection: fade the active one out, or occasionally spawn a
    // new bright glare near the centre (the C's random()%300 with svalue fade).
    if (spec.s) {
      svalue += 0.01 * config.speed;
      if (svalue > 1) {
        svalue = 0;
        spec.s = 0;
      }
    } else if (!(Math.floor(Math.random() * 300))) {
      const ww = 4 * S + (rect.h * H) / 12;
      spec.x = cx + Math.floor(frand(ww)) * rsign();
      spec.y = cy + Math.floor(frand(ww)) * rsign();
      spec.s = ww * (0.8 + frand(0.4));
      svalue = 0;
    }
  }

  // Map the normalised camera rect to the affine transform that resamples the
  // previous frame. The C's grab_rectangle samples input pixel
  //   ix = (rect.w*(ox/W - 0.5 + rect.x))*cos - (rect.h*(oy/H - 0.5) + rect.y)*sin + 0.5
  // (and similar for iy): i.e. recentre on the frame middle, scale by rect.w/h,
  // rotate by rect.th, offset by rect.x/y. We do the inverse as a canvas
  // transform on the *output* (translate to centre, rotate, scale by 1/w, shift
  // by the pan) so drawImage lays the previous frame back down framed that way.
  function feedback() {
    // Copy the current frame into the scratch buffer (drawImage can't safely
    // read + write the same canvas through a transform).
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(canvas, 0, 0);

    // Clear the main canvas to black, then paint the prior frame back through
    // the camera transform. Pixels sampled outside the source stay black (the
    // C's `black` fill for out-of-range ix/iy), so the borders feed in fresh
    // black rather than smearing a frozen edge inward.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const w = rect.w || 1;
    const h = rect.h || 1;

    ctx.save();
    // gain < 1 darkens the recursion a touch each pass so it can never blow out
    // to flat white; the bright source re-injects energy so it never fades to
    // black either. globalAlpha is the cheap, stable way to scale brightness.
    ctx.globalAlpha = Math.min(0.985, Math.max(0.5, config.gain));
    // hue drift: rotate the fed-back image's colour, emulating the analogtv
    // tint_control wander. ctx.filter is supported in all modern browsers; if a
    // browser lacked it the feedback would simply not cycle colour (no crash).
    if (ctx.filter !== undefined) {
      ctx.filter = `hue-rotate(${(hue % 360).toFixed(1)}deg)`;
    }
    // Output transform: centre, rotate by the camera angle, zoom by 1/w (so a
    // rect wider than 1 zooms the image *out* = tunnel inward, like the C), and
    // pan by rect.x/y scaled to pixels.
    ctx.translate(cx + rect.x * W, cy + rect.y * H);
    ctx.rotate(rect.th);
    ctx.scale(1 / w, 1 / h);
    ctx.translate(-cx, -cy);
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }

  // Paint the bright specular glare on top of the fed-back frame, sized by its
  // own ease so it swells then shrinks (the C's grab_rectangle XFillArc, eased
  // by EASE_IN_OUT_SINE over a 0.2 ramp at each end of svalue).
  function drawSpecular() {
    if (!spec.s) return;
    const p = 0.2;
    const r = (svalue < p ? svalue / p :
               svalue >= 1 - p ? (1 - svalue) / p :
               1);
    const s = spec.s * easeInOutSine(r * 2);
    if (s <= 0) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // A soft warm glare (the C fills with the #CCCC44 foreground); a radial
    // gradient reads more like a real reflection than a hard disc.
    const g = ctx.createRadialGradient(spec.x, spec.y, 0, spec.x, spec.y, s / 2);
    g.addColorStop(0, 'rgba(255, 250, 210, 0.95)');
    g.addColorStop(0.6, 'rgba(220, 200, 90, 0.55)');
    g.addColorStop(1, 'rgba(160, 140, 40, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(spec.x, spec.y, s / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // A faint static overlay standing in for the analogtv noise (st->noise). We
  // regenerate a small monochrome-ish noise tile and stamp it at low alpha so
  // it shimmers without dominating; cheap and stable.
  function drawNoise() {
    const n = Math.min(0.2, Math.max(0, config.noise));
    if (n <= 0) return;
    const img = nctx.createImageData(noiseCanvas.width, noiseCanvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = 255;
    }
    nctx.putImageData(img, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = n * 0.6;
    ctx.globalCompositeOperation = 'screen';   // additive-ish: brightens, never darkens to black
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(noiseCanvas, 0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // One frame: drift the camera, feed the previous frame back through it, then
  // inject the bright source + static. (The hue drift is applied inside
  // feedback() via ctx.filter.)
  function step() {
    hue += config.tint;
    advanceCamera();
    feedback();
    drawSpecular();
    drawNoise();
  }

  function init() {
    W = canvas.width;
    H = canvas.height;
    // S is the backing-store px per CSS px (NOT the raw dpr): with the MAX_EDGE
    // cap the backing store can be smaller than device pixels, and every sim
    // size derives from S/W/H, so using the effective scale keeps on-screen
    // sizes identical to a full-res render. Only the internal resolution (and
    // thus the per-frame filter cost) drops.
    S = W / Math.max(1, window.innerWidth);
    cx = W >> 1;
    cy = H >> 1;

    scratch = document.createElement('canvas');
    scratch.width = W;
    scratch.height = H;
    sctx = scratch.getContext('2d');

    // Noise tile is a fraction of the canvas (stretched up when stamped) so the
    // per-frame regeneration stays cheap on big/Retina displays.
    noiseCanvas = document.createElement('canvas');
    noiseCanvas.width = Math.max(64, Math.round(W / 4));
    noiseCanvas.height = Math.max(48, Math.round(H / 4));
    nctx = noiseCanvas.getContext('2d');

    hue = 0;
    value = 0;
    stateName = 'POWERUP';
    dx = dy = ds = dth = 0;
    spec = { x: cx, y: cy, s: 0 };
    svalue = 0;
    twiddleCamera();

    // Seed the screen with a bright central blob so the very first feedback
    // pass has something to fold (an all-black start would stay black until a
    // specular happened to spawn). This is the "camera just powered on" flash.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const r = Math.min(W, H) * 0.18;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255, 250, 210, 1)');
    g.addColorStop(0.5, 'rgba(210, 120, 60, 0.9)');
    g.addColorStop(1, 'rgba(20, 10, 40, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // reinit clears to black and re-seeds (palette / camera may have changed).
  function reinit() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    init();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    // Effective backing scale: the true dpr, but clamped so the longer edge
    // never exceeds MAX_EDGE device px. On a small window this is just dpr; on a
    // big/Retina one it drops below dpr and the browser GPU-upscales the smaller
    // backing store to the full CSS size (smoothly, image-rendering is auto).
    const eff = Math.min(dpr, MAX_EDGE / Math.max(cssW, cssH));
    canvas.width = Math.max(1, Math.round(cssW * eff));
    canvas.height = Math.max(1, Math.round(cssH * eff));
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // Drive off requestAnimationFrame but keep the original ~30fps pace: one
  // step() per config.delay, banking leftover time so the speed is the same at
  // any refresh rate. Cap catch-up so a backgrounded tab doesn't fire a burst.
  const MAX_CATCHUP_STEPS = 4;
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
    reinit,   // re-seed + clear, keeping the current config
    config,
    params,
  };
}
