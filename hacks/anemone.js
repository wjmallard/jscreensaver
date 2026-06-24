// anemone.js — anemone packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's anemone.c (Gabriel Finch, 2001).
// https://www.jwz.org/xscreensaver/
//
// A sea-anemone of `arms` tendrils, all rooted at one central base. Each arm is
// a multi-segment polyline traced by a doubly-integrated random walk: every new
// point's velocity is the previous point's velocity plus a small {-1,0,1} jolt,
// and the point's position is the previous position plus that running velocity.
// Each frame the whole thing is repainted: every drawn segment gets a small
// per-frame +/-2px jitter (the "wiggle"; not stored, so the skeleton is stable),
// and the arm's far tip is capped with a fat round dot. The arms grow point by
// point until a per-arm growth counter expires, then withdraw point by point,
// then grow again; periodically the whole anemone flinches and withdraws at
// once. The x/z coords are projected through a slowly turning angle so the whole
// anemone swirls about its vertical axis.
//
// Rendering: genuinely line-shaped (many thin segments + one tip dot per arm),
// so it uses canvas VECTOR ops. Exactly like braid.js / nerverot.js the segments
// are BUCKETED BY COLOUR into one Path2D per colour (<= ncolors strokes/frame),
// with a second per-colour Path2D of filled tip dots. The canvas is cleared to
// black each frame, then the buckets are stroked/filled. See [[squiral]] for the
// shared skeleton and [[nerverot]] for the wiggling-tendril vector idiom.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'anemone';

export const info = {
  author: 'Gabriel Finch',
  description: 'Wiggling tentacles.',
  year: 2001,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/anemone.xml so the tuning UI maps 1:1.
  // `colors` is not surfaced by the xml (it is a plain resource, default 20); we
  // expose it anyway per the gallery convention. The C adds 3 to it internally.
  const config = {
    delay: 40000,      // microseconds between frames (--delay; stock xml default)
    arms: 128,         // number of tendrils (--arms)
    finpoints: 64,     // max points (tentacle length) per arm (--finpoints)
    width: 2,          // line thickness, logical px (--width)
    withdraw: 1200,    // bigger = the whole anemone withdraws less often (--withdraw)
    turnspeed: 50,     // swirl speed about the vertical axis (--turnspeed)
    colors: 20,        // base colour-ramp size; +3 internally (--colors)
  };

  // live: true  -> the loop reads config[key] every frame (applies instantly).
  // live: false -> the value sizes arrays/palette, so a change re-runs init()
  //                via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 80000, step: 1000, default: 40000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'arms', label: 'Arms', type: 'range', min: 2, max: 500, step: 1, default: 128, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'finpoints', label: 'Tentacles', type: 'range', min: 3, max: 200, step: 1, default: 64, lowLabel: 'short', highLabel: 'long', live: false },
    { key: 'width', label: 'Thickness', type: 'range', min: 1, max: 10, step: 1, default: 2, lowLabel: 'thin', highLabel: 'thick', live: true },
    { key: 'withdraw', label: 'Withdraw frequency', type: 'range', min: 12, max: 10000, step: 1, default: 1200, lowLabel: 'often', highLabel: 'rarely', live: true },
    { key: 'turnspeed', label: 'Turn speed', type: 'range', min: 0, max: 1000, step: 1, default: 50, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'colors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 20, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  const TWO_PI = Math.PI * 2;

  // uniform integer in [0, n), matching the C's RND(n) == random() % n.
  const RND = (n) => Math.floor(Math.random() * n);

  let S = 1;              // devicePixelRatio
  let W, H;               // canvas size, device px
  let centerX, centerY;   // window centre, device px

  let finpoints;          // cached config.finpoints (sizes arms)
  let armCount;           // cached config.arms
  let ncolors;            // config.colors + 3
  let palette;            // ncolors hsl() strings

  let armsArr;            // array of arm objects
  let turn;               // current swirl angle
  let turnSign;           // +1 / -1, flipped on a full-withdraw event

  // ---- arm geometry -----------------------------------------------------

  // Append one point to an arm (the C's "add a piece"): the new point's velocity
  // is the last velocity plus a {-1,0,1} jolt per axis, and its position is the
  // last position advanced by the last velocity. Capped at finpoints-1 points.
  function addPoint(arm) {
    const pts = arm.points;
    if (pts.length >= finpoints - 1) return false;
    const last = pts[pts.length - 1];
    pts.push({
      x: last.x + last.vx,
      y: last.y + last.vy,
      z: last.z + last.vz,
      vx: last.vx + (RND(3) - 1),
      vy: last.vy + (RND(3) - 1),
      vz: last.vz + (RND(3) - 1),
    });
    return true;
  }

  // Build one arm: rooted at the origin with zero velocity (the C's init loop
  // collapses x/y/z to 0 via integer division, so every arm starts dead-centre),
  // then pre-grown to a random length so frame 1 shows a full, varied anemone.
  function makeArm() {
    const arm = {
      colorIndex: RND(ncolors),
      growth: Math.floor(finpoints / 2) + RND(Math.max(1, Math.floor(finpoints / 2))),
      rate: RND(11) * RND(11),
      points: [
        { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
      ],
    };
    const target = 2 + RND(Math.max(1, finpoints - 2));
    while (arm.points.length < target && addPoint(arm)) { /* grow */ }
    return arm;
  }

  // ---- colour ramp ------------------------------------------------------

  // The C builds an ncolors-entry make_smooth_colormap (utils/colors.c) ONCE at
  // init: 2-5 HSV anchor hues interpolated into a smooth closed loop - a
  // harmonious few-hue ramp, NOT a full-saturation rainbow. colormap.js is the
  // faithful port. Each arm picks a random index (aCurr->col = colors[RND(ncolors)]).
  function buildPalette() {
    palette = makeSmoothColormapRGB(ncolors).map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);
  }

  // ---- simulation -------------------------------------------------------

  // One model update: per-arm withdraw step, then per-arm grow / withdraw
  // triggers, then advance the swirl. Mirrors animateAnemone + createPoints.
  function update() {
    const turndelta = turnSign * (config.turnspeed / 100000);

    // withdraw pass (the C's animateAnemone): a shrinking arm drops its tip; when
    // its growth counter climbs back to 0 it flips to growing again.
    for (const arm of armsArr) {
      if (RND(25) < arm.rate && arm.growth < 0) {
        if (arm.points.length > 1) arm.points.pop();
        if (++arm.growth === 0) {
          arm.growth = RND(Math.max(1, finpoints - arm.points.length)) + 1;
        }
      }
      turn += turndelta;   // C advances turn once per arm (sin/cos fixed per frame)
    }

    // grow / withdraw triggers (the C's createPoints). withdrawall is rolled once
    // per frame: 0 -> the whole anemone fully withdraws (and the swirl reverses,
    // faithfully flipped per-arm -> only a net reversal when arms is odd);
    // <11 -> a partial synchronised withdraw; else -> normal per-arm growth.
    const withdrawall = RND(config.withdraw);
    for (const arm of armsArr) {
      if (withdrawall === 0) {
        arm.growth = -finpoints;
        turnSign = -turnSign;
      } else if (withdrawall < 11) {
        arm.growth = -arm.points.length;
      } else if (RND(100) < arm.rate && arm.growth > 0) {
        if (--arm.growth === 0) arm.growth = -RND(finpoints) - 1;
        if (arm.points.length < finpoints - 1) addPoint(arm);
      }
    }

    if (turn >= TWO_PI) turn -= TWO_PI;
    else if (turn < 0) turn += TWO_PI;
  }

  // Repaint: clear to black, then for every arm trace its (jittered) segments
  // into its colour's body bucket and a fat round tip dot into its tip bucket,
  // then stroke/fill each colour once. Mirrors drawImage, collapsed to a full
  // repaint (the C double-buffers and clears the whole frame).
  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const sint = Math.sin(turn);
    const cost = Math.cos(turn);
    const lineW = Math.max(1, config.width * S);
    const tipR = Math.max(1, config.width * 1.5 * S);   // width*3 round cap -> r = 1.5*width

    const bodies = new Array(ncolors);
    const tips = new Array(ncolors);
    for (let c = 0; c < ncolors; c++) {
      bodies[c] = new Path2D();
      tips[c] = new Path2D();
    }

    for (const arm of armsArr) {
      const pts = arm.points;
      const n = pts.length;
      if (n === 1) continue;   // numpt==1 draws nothing
      const body = bodies[arm.colorIndex];

      // base point P[0] (origin), unjittered
      let px = centerX + (pts[0].x * cost - pts[0].z * sint) * S;
      let py = centerY + pts[0].y * S;
      let qx = px;
      let qy = py;

      for (let q = 1; q < n; q++) {
        const p = pts[q];
        const jx = p.x + (2 - RND(5));   // per-frame +/-2px wiggle (not stored)
        const jy = p.y + (2 - RND(5));
        const jz = p.z + (2 - RND(5));
        qx = centerX + (jx * cost - jz * sint) * S;
        qy = centerY + jy * S;
        body.moveTo(px, py);
        body.lineTo(qx, qy);
        px = qx;
        py = qy;
      }

      // the fat round tip dot (the C's degenerate width*3 round-capped segment)
      const tip = tips[arm.colorIndex];
      tip.moveTo(qx + tipR, qy);
      tip.arc(qx, qy, tipR, 0, TWO_PI);
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';   // C uses JoinBevel; round reads the same on thin lines
    ctx.lineWidth = lineW;
    for (let c = 0; c < ncolors; c++) {
      ctx.strokeStyle = palette[c];
      ctx.stroke(bodies[c]);
      ctx.fillStyle = palette[c];
      ctx.fill(tips[c]);
    }
  }

  function step() {
    update();
    draw();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    centerX = W / 2;
    centerY = H / 2;

    finpoints = Math.max(3, Math.round(config.finpoints));
    armCount = Math.max(1, Math.round(config.arms));
    ncolors = Math.max(1, Math.round(config.colors)) + 3;

    buildPalette();

    turn = 0;
    turnSign = 1;

    armsArr = new Array(armCount);
    for (let i = 0; i < armCount; i++) armsArr[i] = makeArm();
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
    draw();   // paint frame 1 so a fresh mount/resize isn't blank
  }

  // rAF lag-accumulator loop paced by (config.delay + OVERHEAD) us (/1000 for the
  // ms rAF clock), with the same catch-up cap as squiral so a backgrounded tab
  // doesn't burst on refocus. Each step() fully repaints.
  //
  // OVERHEAD: config.delay is the author's inter-frame SLEEP (stock 40000 us); the
  // live binary's real rate is lower because every frame also clears and redraws
  // all arms, so a fixed per-frame cost is added to reproduce the live -fps rate.
  const OVERHEAD = 9000;   // us; the main-session -fps pass sets the precise value.
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

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (clears the canvas; arms/finpoints/colors
  // may differ).
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
    draw();
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
