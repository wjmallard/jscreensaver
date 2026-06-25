// wormhole.js — wormhole packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's wormhole.c (Jon Rafkind, 2004).
// https://www.jwz.org/xscreensaver/
//
// Flying through a coloured wormhole in space. Each "star" is a short line
// segment that lives at a depth Z and a fixed angle around a small circle of
// radius `diameter` centred on the wormhole's (drifting) centre. The segment is
// projected to screen with a 1/Z perspective: calc = (offset * 1024) / Z +
// centre. Every step Z is decremented by `zspeed`, so as a star approaches the
// viewer its projected offset (offset * 1024 / Z) grows without bound — the
// streak accelerates outward from the centre, lengthens and brightens, then
// recycles to the back of the tunnel (max_Z) once Z reaches 0. New stars are
// spawned every step, so the field is a steady stream rushing past the camera.
// The centre itself drifts around the screen (seeking random targets, with
// occasional spiral detours and edge bounces), which makes the tunnel bank and
// turn as you fly. Colour is a slowly-drifting rainbow, with each streak shaded
// by its depth so the near (fast) ends read brightest.
//
// Rendering: clear-to-black each frame, then stroke each star as one short line
// (sparse — a few dozen to a few hundred segments over a black field), so a
// per-line strokeStyle is cheap and a full per-pixel blit would be wasteful.
// Mirrors drawWormhole(): XFillRectangle(black) then one XDrawLine per star.

export const title = 'wormhole';

export const info = {
  author: 'Jon Rafkind',
  description: 'Flying through a colored wormhole in space.',
  year: 2004,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/wormhole.xml so the config box maps 1:1.
  // `ncolors` is not in the stock UI (the C blends an X11 colormap); we add it
  // to size the rainbow palette. Stock delay is 10000 µs; kept (it already feels
  // calm). See wormhole.md.
  const config = {
    delay: 50000,    // µs between steps (--delay)
    zspeed: 10,      // how fast stars rush toward the viewer (--zspeed)
    stars: 20,       // new stars spawned per step (--stars)
    ncolors: 128,    // size of the rainbow palette window (added)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 50000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'zspeed', label: 'Star speed', type: 'range', min: 1, max: 30, step: 1, default: 10, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'stars', label: 'Stars created', type: 'range', min: 1, max: 100, step: 1, default: 20, lowLabel: 'few', highLabel: 'lots', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 8, max: 255, step: 1, default: 128, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // Constants, verbatim from wormhole.c.
  const MAX_Z = 600;          // depth a star spawns at (back of the tunnel)
  const SHIFT = 1024;         // the C's "<< 10" perspective fixed-point scale
  const MIN_DIST = 100;       // edge margin the centre bounces inside of
  const SHADE_USE = 128;      // width of the colour window walked by depth

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let stars;          // array of { ang, x, y, cx, cy, bZ, eZ } (recycled in place)
  let centre;         // drifting wormhole centre + steering state
  let diameter;       // current circle radius (pulses); device px
  let diameterWant;   // target radius the diameter eases toward
  let speed;          // centre drift speed, device px/step
  let palette;        // ncolors smoothly-varying rainbow CSS strings
  let shadeMin;       // current offset into the palette window (drifts)
  let shadeMinWant;   // target offset shadeMin eases toward
  let minDist;        // MIN_DIST scaled by dpr
  let needsDraw;      // paint the pre-seeded tunnel once before the first step

  function rnd(q) {
    if (q < 1) q = 1;
    return Math.floor(Math.random() * q);
  }

  // gang(): angle (degrees) from (x1,y1) to (x2,y2), matching the C's gang().
  // atan2's y is negated because screen y grows downward (as in the original).
  function gang(x1, y1, x2, y2) {
    let tang;
    if (x1 === x2) {
      tang = y1 < y2 ? 90 : 270;
    } else if (y1 === y2) {
      tang = x1 < x2 ? 0 : 180;
    } else {
      tang = Math.round(Math.atan2(-(y2 - y1), x2 - x1) * 180.0 / Math.PI);
    }
    while (tang < 0) tang += 360;
    return tang % 360;
  }

  function dist(x1, y1, x2, y2) {
    const xs = x1 - x2;
    const ys = y1 - y2;
    return Math.sqrt(xs * xs + ys * ys) | 0;
  }

  // Build a smoothly-varying rainbow of `ncolors` entries. The C blends random
  // XColors into a 2048-slot palette and walks a 128-wide window through it; we
  // collapse that to a single hue ramp the depth-shade and the drift index walk.
  function buildPalette() {
    const n = Math.max(8, Math.round(config.ncolors));
    palette = new Array(n);
    for (let i = 0; i < n; i++) {
      // Full hue wheel across the palette; depth supplies the lightness later.
      palette[i] = (i * 360 / n);
    }
  }

  // Perspective-project one endpoint: offset (x,y) about the centre at depth Z.
  // calcStar() in the C: Z>0 -> (off<<10)/Z + centre; Z<=0 -> (off<<10)/centre
  // (a degenerate fallback we never draw, since such stars are recycled).
  function calcX(off, Z, c) {
    if (Z <= 0) return c ? ((off * SHIFT) / c) | 0 : 0;
    return (((off * SHIFT) / Z) | 0) + c;
  }

  // Spawn (or recycle) a star: a random angle on the circle, begin at the back
  // of the tunnel and end a few units deeper, so the segment streaks along Z.
  // The C's Cos/Sine are a no-op-scrambled degree->point map; since `ang` is
  // already uniform-random, proper radian trig gives an identical distribution
  // (a uniform random point on the circle). See wormhole.md.
  function spawnInto(s) {
    const ang = rnd(360);
    const rad = ang * Math.PI / 180;
    s.ang = ang;
    s.x = Math.cos(rad) * diameter;   // begin/end share the same offset...
    s.y = Math.sin(rad) * diameter;   // ...so the streak is purely radial
    s.cx = centre.actualx;            // centre is frozen into the star at birth
    s.cy = centre.actualy;
    s.bZ = MAX_Z;                     // begin depth
    s.eZ = MAX_Z + rnd(6) + 4;        // end slightly deeper -> a short streak
    s.alive = true;
  }

  function addStar() {
    // Reuse a dead slot if one exists (mirrors the C's NULL-slot scan), else grow.
    for (let q = 0; q < stars.length; q++) {
      if (!stars[q].alive) {
        spawnInto(stars[q]);
        return;
      }
    }
    const s = { ang: 0, x: 0, y: 0, cx: 0, cy: 0, bZ: 0, eZ: 0, alive: false };
    spawnInto(s);
    stars.push(s);
  }

  // Advance the centre one step: drift along `ang` at `speed`, then either keep
  // spiralling, or seek the current target / bounce off the edges and pick a new
  // target. Mirrors moveWormhole()'s steering block.
  function moveCentre() {
    const rad = centre.ang * Math.PI / 180;
    centre.virtualx += Math.cos(rad) * speed;
    centre.virtualy += Math.sin(rad) * speed;
    centre.actualx = centre.virtualx | 0;
    centre.actualy = centre.virtualy | 0;

    let find = false;

    if (centre.spiral) {
      if (centre.spiral % 5 === 0) centre.ang = (centre.ang + 1) % 360;
      centre.spiral--;
      if (centre.spiral <= 0) find = true;
    } else {
      if (dist(centre.actualx, centre.actualy, centre.wantX, centre.wantY) < 20 * S) {
        find = true;
      }
      if (rnd(20) === rnd(20)) find = true;

      if (centre.actualx < minDist) {
        centre.actualx = minDist; centre.virtualx = centre.actualx; find = true;
      }
      if (centre.actualy < minDist) {
        centre.actualy = minDist; centre.virtualy = centre.actualy; find = true;
      }
      if (centre.actualx > W - minDist) {
        centre.actualx = W - minDist; centre.virtualx = centre.actualx; find = true;
      }
      if (centre.actualy > H - minDist) {
        centre.actualy = H - minDist; centre.virtualy = centre.actualy; find = true;
      }

      if (rnd(500) === rnd(500)) centre.spiral = rnd(30) + 50;
    }

    if (find) {
      centre.wantX = rnd(W - minDist * 2) + minDist;
      centre.wantY = rnd(H - minDist * 2) + minDist;
      centre.ang = gang(centre.actualx, centre.actualy, centre.wantX, centre.wantY);
    }
  }

  // Drift the palette window (moveColorChanger): ease shadeMin toward a random
  // target, re-rolling the target on arrival, so the overall hue cycles slowly.
  function moveColorWindow() {
    const span = Math.max(1, palette.length - 1);
    if (shadeMin < shadeMinWant) shadeMin++;
    else if (shadeMin > shadeMinWant) shadeMin--;
    else shadeMinWant = rnd(span);
  }

  // One simulation step: drift the centre, push every star toward the viewer
  // (recycling those that reach the camera), pulse the diameter, drift colour,
  // then spawn `stars` new streaks. Mirrors moveWormhole().
  function step() {
    moveCentre();

    const zspeed = Math.max(1, Math.round(config.zspeed)) * S;
    for (let q = 0; q < stars.length; q++) {
      const s = stars[q];
      if (!s.alive) continue;
      s.bZ -= zspeed;
      s.eZ -= zspeed;
      if (s.bZ <= 0 || s.eZ <= 0) s.alive = false;   // recycle at the core
    }

    moveColorWindow();

    // Diameter eases toward a target, which is re-rolled occasionally (pulses).
    if (diameter < diameterWant) diameter++;
    if (diameter > diameterWant) diameter--;
    if (rnd(30) === rnd(30)) diameterWant = (rnd(35) + 5) * S;

    const make = Math.max(1, Math.round(config.stars));
    for (let q = 0; q < make; q++) addStar();
  }

  // Draw every live star as one short line, shaded by depth: near (low Z) ends
  // are brightest. drawWormhole(): black fill, then one XDrawLine per star.
  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    ctx.lineWidth = W > 2560 || H > 2560 ? 3 : Math.max(1, Math.round(S));
    ctx.lineCap = 'round';

    const n = palette.length;
    for (let q = 0; q < stars.length; q++) {
      const s = stars[q];
      if (!s.alive) continue;

      const bx = calcX(s.x, s.bZ, s.cx);
      const by = calcX(s.y, s.bZ, s.cy);
      const ex = calcX(s.x, s.eZ, s.cx);
      const ey = calcX(s.y, s.eZ, s.cy);

      // Depth -> colour: hue from the drifting window, lightness brightening as
      // the star nears the camera (Z: MAX_Z..0 -> lightness ~25%..70%).
      const depth = s.bZ / MAX_Z;                       // 1 = far, 0 = near
      const hueIdx = (shadeMin + ((depth * SHADE_USE) | 0)) % n;
      const light = 25 + (1 - depth) * 45;
      ctx.strokeStyle = `hsl(${palette[hueIdx] | 0}, 100%, ${light | 0}%)`;

      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    minDist = Math.round(MIN_DIST * S);

    diameter = (rnd(10) + 15) * S;
    diameterWant = (rnd(10) + 15) * S;
    speed = W / 180.0;            // the C's SCREEN_X / 180.0 (already device px)

    centre = {
      actualx: (W / 2) | 0,
      actualy: (H / 2) | 0,
      virtualx: W / 2,
      virtualy: H / 2,
      ang: 0,
      wantX: rnd(W - minDist * 2) + minDist,
      wantY: rnd(H - minDist * 2) + minDist,
      spiral: 0,
    };
    centre.ang = gang(centre.actualx, centre.actualy, centre.wantX, centre.wantY);

    buildPalette();
    shadeMin = 0;
    shadeMinWant = rnd(Math.max(1, palette.length - 1));

    // Pre-seed a tunnel's worth of stars at varied depths so frame 1 already
    // shows a full wormhole instead of an empty centre filling in.
    stars = [];
    for (let i = 0; i < 64; i++) {
      const s = { ang: 0, x: 0, y: 0, cx: 0, cy: 0, bZ: 0, eZ: 0, alive: false };
      spawnInto(s);
      const back = rnd(MAX_Z);          // scatter starting depths across the tunnel
      s.bZ -= back;
      s.eZ -= back;
      if (s.bZ <= 0 || s.eZ <= 0) s.alive = false;
      stars.push(s);
    }

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    needsDraw = true;   // frame 1 paints the seeded tunnel even before stepping
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator loop paced by config.delay (µs); see squiral.js. The
  // canvas is cleared and fully redrawn each step, so we draw once per frame
  // (when a step ran, or once up front to show the pre-seeded tunnel before the
  // first step / after a resize|reinit), like galaxy.js + grav.js's needsBackground.
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

    let steps = 0;
    let stepped = false;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
      stepped = true;
    }

    if (stepped || needsDraw) {
      draw();
      needsDraw = false;
    }
    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (clears the canvas; ncolors may differ).
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
