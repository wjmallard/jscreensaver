// whirlwindwarp.js — whirlwindwarp packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's whirlwindwarp.c (Paul "Joey" Clark, 2000-2005), itself
// ported from a 1997 QBasic program. https://www.jwz.org/xscreensaver/
//
// A cloud of "stars" (particles) lives in realspace [-1,+1] x [-1,+1] and is
// dragged around by a procedural flow field: a sum of 16 simple 2D force-field
// effects (warp, rotation, asymptotes, "squirge", whirlwind splitting, and two
// sinusoidal wave fields). Each field has a parameter that random-walks slowly
// about an optimum, and each field is independently switched on and off at
// random (>= 3 always on). Every step each star is pushed by the active fields,
// then respawned if it leaves the screen, hugs a central axis, or rarely at
// random. Each star leaves a short trail (a hard, fixed-length tail — not a fade).
//
// Rendering: this is SPARSE vector drawing (ps small squares per frame), so it
// uses canvas fillRect on a PERSISTENT canvas — exactly like grav.js. The C
// keeps a ring buffer tx[]/ty[] of the last ts pixel plots per star and erases
// the oldest plot (paints it background) just before drawing the newest, giving
// a trail of length ts. We port that ring-buffer erase-old/draw-new directly;
// no alpha-fade buffer is needed because the trail is a hard fixed-length tail.
// See [[grav]] (persistent canvas, erase-old + draw-new) and [[binaryring]]
// (the flow-field-of-particles idea).

export const title = 'whirlwindwarp';

export const info = {
  author: 'Paul "Joey" Clark',
  description: 'Floating stars are acted upon by a mixture of simple 2D force fields. The strength of each force field changes continuously, and it is also switched on and off at random.',
  year: 2001,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Config mirrors hacks/config/whirlwindwarp.xml, which exposes ONLY points and
  // tails (plus a --fps diagnostic we omit). There is NO delay resource: the C
  // self-caps at 200 fps internally, so frame pacing is an internal constant
  // (DELAY_US below), not a user slider.
  const config = {
    points: 400,     // number of stars (--points)
    tails: 8,        // trail length per star, in plots (--tails)
  };

  const params = [
    { key: 'points', label: 'Particles', type: 'range', min: 10, max: 1000, step: 10, default: 400, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'tails', label: 'Trail size', type: 'range', min: 1, max: 50, step: 1, default: 8, lowLabel: 'short', highLabel: 'long', live: false },
  ];

  // Hard-coded counts from the C (#define maxps 1000, maxts 50, fs 16).
  const MAX_PS = 1000;
  const MAX_TS = 50;
  const FS = 16;

  // The C has no delay resource; it self-caps at 200 fps (5000 us/frame) via
  // gettimeofday. We pace the rAF lag-accumulator with this internal interval.
  // 100 fps (half the stock cap, per the project's effective-fps calibration)
  // reads calmer in a browser. This only sets wall-clock speed, NOT the spatial
  // look of the trails (that is fixed by `tails` and the per-step drift). Tunable
  // pace knob, not a fidelity item.
  const DELAY_US = 10000;

  let S = 1;            // devicePixelRatio
  let W, H;             // canvas size, device px
  let starsize;         // square side in device px (scrhei/480, min 1)

  let cx, cy;           // Float32 realspace position of each star [-1,+1]
  let tx, ty;           // ring buffer of past pixel plots (ps*ts long)
  let nt;               // ring buffer write cursor

  // Force fields: parallel arrays indexed 0..15.
  let fon;              // on/off
  let varr;             // current parameter value
  let op;               // optimum (central/mean) value
  let acc;              // acceleration of the random walk
  let vel;              // velocity of the random walk

  let colors;           // per-star rgb() colour string (faithful hsv_to_rgb)
  let hue;              // drifting hue used to recolour stars
  let ps;               // active star count (config.points, clamped)
  let ts;               // active trail length (config.tails, clamped)

  let needsBackground;  // clear to black on the next frame (after reinit/resize)

  // between -1.0 (inclusive) and +1.0 (exclusive), matching the C's myrnd().
  function myrnd() {
    return 2.0 * (Math.random() - 0.5);
  }

  // op + damp*(var-op) + force*myrnd()/4 — the C's stars_perturb macro.
  function perturb(value, optimum, damp, force) {
    return optimum + damp * (value - optimum) + force * myrnd() / 4.0;
  }

  // 0..1 channel -> 0..255, the way the X server consumes hsv_to_rgb's 16-bit
  // output (it stores C*65535 then the visual downsamples >>8 == floor(C*256)).
  function ch(c) {
    if (c <= 0) return 0;
    if (c >= 1) return 255;
    return Math.min(255, Math.floor(c * 256.0));
  }

  // hsv_to_rgb (utils/hsv.c), verbatim: h in degrees, s,v in [0,1]. The C calls
  // this directly per star (NOT make_*_colormap), so there is no shared colormap
  // helper to use here. Returns an "rgb(r,g,b)" string for canvas fillStyle.
  function hsvToRgb(h, s, v) {
    if (s < 0) s = 0; else if (s > 1) s = 1;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    const H = (Math.trunc(h) % 360) / 60.0;
    const i = Math.trunc(H);
    const f = H - i;
    const p1 = v * (1 - s);
    const p2 = v * (1 - (s * f));
    const p3 = v * (1 - (s * (1 - f)));
    let R, G, B;
    if      (i === 0) { R = v;  G = p3; B = p1; }
    else if (i === 1) { R = p2; G = v;  B = p1; }
    else if (i === 2) { R = p1; G = v;  B = p3; }
    else if (i === 3) { R = p1; G = p2; B = v;  }
    else if (i === 4) { R = p3; G = p1; B = v;  }
    else              { R = v;  G = p1; B = p2; }
    return `rgb(${ch(R)}, ${ch(G)}, ${ch(B)})`;
  }

  // Respawn a star at a random realspace point.
  function newp(pp) {
    cx[pp] = myrnd();
    cy[pp] = myrnd();
  }

  // Realspace [-1,+1] -> integer pixel coords (the C's stars_scrpos_*).
  function scrposX(pp) {
    return (W * (cx[pp] + 1.0) / 2.0) | 0;
  }

  function scrposY(pp) {
    return (H * (cy[pp] + 1.0) / 2.0) | 0;
  }

  // Turn a field on, seeding its walk; the two wave fields drag their phase and
  // frequency partners on with them (10 -> 11,12 and 13 -> 14,15).
  function turnOnField(ff) {
    if (!fon[ff]) {
      acc[ff] = 0.02 * myrnd();
      vel[ff] = 0.0;
      varr[ff] = op[ff];
    }
    fon[ff] = 1;
    if (ff === 10) {
      turnOnField(11);
      turnOnField(12);
    }
    if (ff === 13) {
      turnOnField(14);
      turnOnField(15);
    }
  }

  // Move one star according to the active force fields (the C's stars_move).
  // Field indices and formulae are verbatim; the order matters (squirge first,
  // so x+1.0 stays >= 0 for the pow()).
  function move(pp) {
    let x = cx[pp];
    let y = cy[pp];
    let nx, ny;

    // Squirge towards edges (must go first to avoid x+1.0 < 0).
    if (fon[6]) {
      x = -1.0 + 2.0 * Math.pow((x + 1.0) / 2.0, varr[6]);
    }
    if (fon[7]) {
      y = -1.0 + 2.0 * Math.pow((y + 1.0) / 2.0, varr[7]);
    }

    // Warping in/out.
    if (fon[1]) {
      x = x * varr[1];
      y = y * varr[1];
    }

    // Rotation.
    if (fon[2]) {
      nx = x * Math.cos(1.1 * varr[2]) + y * Math.sin(1.1 * varr[2]);
      ny = -x * Math.sin(1.1 * varr[2]) + y * Math.cos(1.1 * varr[2]);
      x = nx;
      y = ny;
    }

    // Asymptotes (looks like a plane with a horizon; equivalent to 1D warp).
    if (fon[3]) {              // horizontal asymptote
      y = y * varr[3];
    }
    if (fon[4]) {              // vertical asymptote
      x = x + varr[4] * x;
    }
    if (fon[5]) {              // vertical asymptote at right of screen
      x = (x - 1.0) * varr[5] + 1.0;
    }

    // Splitting (whirlwind effect): num_splits depends on var[0]; thru maps the
    // star's index across the cloud to a value in [0,1] (when num_splits > 1).
    const num_splits = 2 + ((Math.abs(varr[0]) * 1000) | 0);
    const thru = ((num_splits * pp / ps) | 0) / (num_splits - 1);
    if (fon[8]) {
      x = x + 0.5 * varr[8] * (-1.0 + 2.0 * thru);
    }
    if (fon[9]) {
      y = y + 0.5 * varr[9] * (-1.0 + 2.0 * thru);
    }

    // Waves.
    if (fon[10]) {
      y = y + 0.4 * varr[10] * Math.sin(300.0 * varr[12] * x + 600.0 * varr[11]);
    }
    if (fon[13]) {
      x = x + 0.4 * varr[13] * Math.sin(300.0 * varr[15] * y + 600.0 * varr[14]);
    }

    cx[pp] = x;
    cy[pp] = y;
  }

  // Fill a starsize square at integer pixel (x, y) — the C's XFillRectangle.
  function plot(x, y, fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, starsize, starsize);
  }

  function step() {
    // Occasionally recolour one star toward the current hue, then drift the hue.
    // (The C reallocates an X colour; we just rewrite the colour string.) pp ranges
    // over the allocated colours [0, colsavailable); on a browser every colour is
    // available so colsavailable == ps-1. hue is an int in the C (so the drift is
    // an integer random walk; truncate each step).
    if (myrnd() > 0.75 && ps > 0) {
      const pp = (((ps - 1) * (0.5 + myrnd() / 2)) | 0);
      colors[Math.min(pp, ps - 1)] = hsvToRgb(hue, 0.6 + 0.4 * myrnd(), 0.6 + 0.4 * myrnd());
      hue = Math.trunc(hue + 0.5 + myrnd() * 9.0);
      if (hue < 0) hue += 360;
      if (hue >= 360) hue -= 360;
    }

    // Move every star: erase its oldest trail plot, integrate the flow field,
    // respawn if it left the field / hugged an axis / rarely at random, then
    // draw the new plot and remember it in the ring buffer.
    for (let p = 0; p < ps; p++) {
      // Erase the plot that is about to be overwritten (background = black).
      plot(tx[nt], ty[nt], '#000');

      move(p);

      // If moved off screen (or onto a central axis), create a new one.
      if (cx[p] <= -0.9999 || cx[p] >= 0.9999 ||
          cy[p] <= -0.9999 || cy[p] >= 0.9999 ||
          Math.abs(cx[p]) < 0.0001 || Math.abs(cy[p]) < 0.0001) {
        newp(p);
      } else if (myrnd() > 0.99) {   // reset at random
        newp(p);
      }

      // Draw the star at its new position in its own colour.
      const sx = scrposX(p);
      const sy = scrposY(p);
      plot(sx, sy, colors[p]);

      // Remember it for removal later.
      tx[nt] = sx;
      ty[nt] = sy;
      nt = (nt + 1) % (ps * ts);
    }

    // Adjust the force fields: random-walk each active field's parameter, and
    // probabilistically switch fields on/off (keeping >= 3 on).
    let cnt = 0;
    for (let f = 0; f < FS; f++) {
      if (fon[f]) {
        // This configuration keeps var[f] usually below 0.01.
        acc[f] = perturb(acc[f], 0, 0.98, 0.005);
        vel[f] = perturb(vel[f] + 0.03 * acc[f], 0, 0.995, 0.0);
        varr[f] = op[f] + (varr[f] - op[f]) * 0.9995 + 0.001 * vel[f];
      }

      // prob_on makes the "splitting" effects (8,9) rarer than the rest.
      const prob_on = (f === 8 || f === 9) ? 0.999975 : 0.9999;
      if (fon[f] === 0 && myrnd() > prob_on) {
        turnOnField(f);
      } else if (fon[f] !== 0 && myrnd() > 0.99 &&
                 Math.abs(varr[f] - op[f]) < 0.0005 && Math.abs(vel[f]) < 0.005) {
        // Only turn off once it has gently returned to its optimum (rather than
        // rapidly passing through it), so the change is smooth.
        fon[f] = 0;
      }

      if (fon[f]) cnt++;
    }

    // Ensure at least three force fields are on.
    if (cnt < 3) {
      turnOnField((Math.random() * FS) | 0);
    }
  }

  // After a reinit/resize, paint the background black (the C's XClearWindow). We
  // do NOT pre-plot the stars here: the C never draws untracked points, and the
  // first step() already paints the whole cloud (after one move), so frame 1 is
  // non-blank without leaving permanent, never-erased specks at the t=0 positions.
  function draw() {
    if (needsBackground) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      needsBackground = false;
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    starsize = (H / 480) | 0;
    if (starsize <= 0) starsize = 1;

    ps = Math.min(Math.max(Math.round(config.points), 1), MAX_PS);
    ts = Math.min(Math.max(Math.round(config.tails), 1), MAX_TS);

    cx = new Float32Array(ps);
    cy = new Float32Array(ps);

    // Ring buffer of past plots; seed off-screen so the first erases are no-ops.
    const tlen = ps * ts;
    tx = new Int32Array(tlen);
    ty = new Int32Array(tlen);
    tx.fill(-starsize - 1);
    ty.fill(-starsize - 1);
    nt = 0;

    // Per-star colours, exactly as the C:
    //   hsv_to_rgb(random()%360, .6+.4*myrnd(), .6+.4*myrnd())
    // random hue, with saturation AND value each in [0.2, 1.0) (myrnd is [-1,1)).
    colors = new Array(ps);
    for (let p = 0; p < ps; p++) {
      const h = (Math.random() * 360) | 0;
      colors[p] = hsvToRgb(h, 0.6 + 0.4 * myrnd(), 0.6 + 0.4 * myrnd());
    }

    // Force-field optima (the C's op[] table). Phases get a random start; the
    // "inactive" comments are the C's — those fields do nothing on their own but
    // feed the wave fields (11,12 -> 10 and 14,15 -> 13).
    op = new Float32Array(FS);
    op[0] = 0;                   // split number (inactive)
    op[1] = 1;                   // warp
    op[2] = 0;                   // rotation
    op[3] = 1;                   // horizontal asymptote
    op[4] = 0;                   // vertical asymptote
    op[5] = 1;                   // vertical asymptote right
    op[6] = 1;                   // squirge x
    op[7] = 1;                   // squirge y
    op[8] = 0;                   // split velocity x
    op[9] = 0;                   // split velocity y
    op[10] = 0;                  // horizontal wave amplitude
    op[11] = myrnd() * 3.141;    // horizontal wave phase (inactive)
    op[12] = 0.01;               // horizontal wave frequency (inactive)
    op[13] = 0;                  // vertical wave amplitude
    op[14] = myrnd() * 3.141;    // vertical wave phase (inactive)
    op[15] = 0.01;               // vertical wave frequency (inactive)

    // Initialise each field to its optimum, randomly on/off, walk seeded.
    fon = new Uint8Array(FS);
    varr = new Float32Array(FS);
    acc = new Float32Array(FS);
    vel = new Float32Array(FS);
    for (let f = 0; f < FS; f++) {
      varr[f] = op[f];
      fon[f] = myrnd() > 0.5 ? 1 : 0;
      acc[f] = 0.02 * myrnd();
      vel[f] = 0;
    }

    // Initialise stars.
    for (let p = 0; p < ps; p++) newp(p);

    hue = Math.trunc(180 + 180 * myrnd());   // the C's hue is an int

    needsBackground = true;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator loop paced by DELAY_US (see squiral.js). The canvas
  // is persistent (trails are a ring buffer), so step() draws incrementally and
  // draw() only paints the one-time background after a reinit/resize.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // DELAY_US is microseconds (the internal pace); the rAF clock is milliseconds.
    const delayMs = DELAY_US / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    draw();   // one-time background after reinit/resize

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (clears the canvas; points/tails may differ).
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
