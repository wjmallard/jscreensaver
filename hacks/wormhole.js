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
// streak accelerates outward from the centre and lengthens, then is freed once
// Z reaches 0. New stars are spawned every step, so the field is a steady
// stream rushing past the camera.
//
// The centre drifts around the screen aiming at random targets — but the C
// feeds its integer "degrees" through Cos()/Sine() helpers that multiply by
// 180/PI instead of PI/180, so the travel direction is a scrambled function of
// the aim: straight runs in effectively random directions, retargeted on edge
// clamps, near-arrivals and random whims, plus occasional "spiral" fits
// (direction re-scrambled every 5th step for 50-80 steps, edge clamping off,
// so the centre can wander off-screen and back). That bug IS the hack's
// characteristic wander, so it is transcribed verbatim, not fixed.
//
// Colour (initColorChanger): a 2048-slot palette of chained 128-wide linear
// RGB blends between random mid-brightness endpoints (channels rnd(50000)+
// 10000 of 65535), built once per session. A 128-wide window drifts through it
// one slot per step; each streak indexes the window by its depth
// (color = z * 128 / 600), so near ends read the window start, far ends the
// window end, and the whole field slowly cycles through the blend chain.
//
// Rendering: clear-to-black each frame, then stroke each star as one short line
// (sparse — up to ~1200 segments over a black field at the defaults), so a
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
  const config = {
    delay: 10000,    // µs between steps (--delay)
    zspeed: 10,      // how fast stars rush toward the viewer (--zspeed)
    stars: 20,       // new stars spawned per step (--stars)
  };

  // Per-frame framework+draw cost added to config.delay so the paced rate
  // matches the live binary rather than the raw delay. Live -fps: 52.7 fps at
  // Load 47.3% (clean: sleep slice = stock 10000) => 18975 us/frame.
  const OVERHEAD = 9000;

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'zspeed', label: 'Star speed', type: 'range', min: 1, max: 30, step: 1, default: 10, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'stars', label: 'Stars created', type: 'range', min: 1, max: 100, step: 1, default: 20, lowLabel: 'few', highLabel: 'lots', live: true },
  ];

  // Constants, verbatim from wormhole.c.
  const MAX_Z = 600;          // depth a star spawns at (back of the tunnel)
  const SHIFT = 1024;         // the C's "<< 10" perspective fixed-point scale
  const MIN_DIST = 100;       // edge margin the centre bounces inside of
  const SHADE_MAX = 2048;     // total palette slots (initColorChanger)
  const SHADE_USE = 128;      // width of the colour window walked by depth

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let stars;          // array of { x, y, cx, cy, bZ, eZ, alive } (recycled in place)
  let centre;         // drifting wormhole centre + steering state
  let diameter;       // current circle radius (pulses); logical px, scaled at spawn
  let diameterWant;   // target radius the diameter eases toward
  let speed;          // centre drift speed, device px/step
  let shade;          // SHADE_MAX CSS colours (the blended palette), per session
  let shadeMin;       // window offset into the palette (color_changer.min; drifts)
  let shadeMinWant;   // target offset shadeMin eases toward (min_want)
  let minDist;        // MIN_DIST scaled by dpr

  function rnd(q) {
    if (q < 1) q = 1;
    return Math.floor(Math.random() * q);
  }

  // Cos()/Sine(), verbatim from the C: the angle is multiplied by 180/PI (not
  // PI/180), so consecutive integer "degrees" land at scrambled points around
  // the circle. Harmless for star spawns (a uniform random angle in is a
  // uniform-ish random direction out) but load-bearing for the centre's
  // wander — do not "fix" to real trig.
  function Cos(a) {
    return Math.cos(a * 180.0 / Math.PI);
  }

  function Sine(a) {
    return Math.sin(a * 180.0 / Math.PI);
  }

  // gang(): angle (degrees) from (x1,y1) to (x2,y2), matching the C's gang()
  // including the (int)(0.5 + atan2) cast (truncation toward zero, so negative
  // angles round differently than Math.round). atan2's y is negated because
  // screen y grows downward (as in the original).
  function gang(x1, y1, x2, y2) {
    let tang;
    if (x1 === x2) {
      tang = y1 < y2 ? 90 : 270;
    } else if (y1 === y2) {
      tang = x1 < x2 ? 0 : 180;
    } else {
      tang = Math.trunc(0.5 + Math.atan2(-(y2 - y1), x2 - x1) * 180.0 / Math.PI);
    }
    while (tang < 0) tang += 360;
    return tang % 360;
  }

  function dist(x1, y1, x2, y2) {
    const xs = x1 - x2;
    const ys = y1 - y2;
    return Math.sqrt(xs * xs + ys * ys) | 0;
  }

  // initXColor(): a random palette endpoint; each 16-bit channel is
  // rnd(50000)+10000 — mid-brightness, never black and never fully saturated.
  function initXColor() {
    return {
      r: rnd(50000) + 10000,
      g: rnd(50000) + 10000,
      b: rnd(50000) + 10000,
    };
  }

  // blend_palette(): fill `max` slots from `base` with a linear RGB blend from
  // sc to ec (j = q/max never reaches 1, so the next segment starting exactly
  // at ec keeps the chain continuous). 16-bit channels -> CSS 8-bit via >> 8.
  function blendPalette(base, max, sc, ec) {
    for (let q = 0; q < max; q++) {
      const j = q / max;
      const r = Math.trunc(0.5 + sc.r + (ec.r - sc.r) * j);
      const g = Math.trunc(0.5 + sc.g + (ec.g - sc.g) * j);
      const b = Math.trunc(0.5 + sc.b + (ec.b - sc.b) * j);
      shade[base + q] = 'rgb(' + (r >> 8) + ',' + (g >> 8) + ',' + (b >> 8) + ')';
    }
  }

  // initColorChanger(): the 2048-slot palette — 16 chained 128-wide blends
  // between random endpoints — plus the drifting 128-wide window state.
  function initColorChanger() {
    shade = new Array(SHADE_MAX);
    shadeMin = 0;
    shadeMinWant = rnd(SHADE_MAX - SHADE_USE);
    let oldColor = initXColor();
    let newColor = initXColor();
    for (let q = 0; q < SHADE_MAX; q += SHADE_USE) {
      blendPalette(q, SHADE_USE, oldColor, newColor);
      oldColor = newColor;
      newColor = initXColor();
    }
  }

  // moveColorChanger(): drift the window offset one slot per step toward a
  // random target, re-rolling the target on arrival (successive ifs, as in C:
  // the re-roll fires the same step the offset arrives).
  function moveColorChanger() {
    if (shadeMin < shadeMinWant) shadeMin++;
    if (shadeMin > shadeMinWant) shadeMin--;
    if (shadeMin === shadeMinWant) shadeMinWant = rnd(SHADE_MAX - SHADE_USE);
  }

  // Perspective-project one endpoint: offset (x,y) about the centre at depth Z.
  // calcStar() in the C: Z>0 -> (off<<10)/Z + centre; Z<=0 -> (off<<10)/centre
  // (a degenerate fallback we never draw, since such stars are already freed).
  function calcX(off, Z, c) {
    if (Z <= 0) return c ? ((off * SHIFT) / c) | 0 : 0;
    return (((off * SHIFT) / Z) | 0) + c;
  }

  // Spawn (or recycle) a star: a random angle on the circle (through the C's
  // scrambled Cos/Sine, truncated to ints as the C stores them), begin at the
  // back of the tunnel and end a few units deeper, so the segment streaks
  // along Z. The centre is frozen into the star at birth. calcStar()'s
  // center==0 degenerate case (reachable when a spiral carries the centre
  // across an axis) zeroes Z, i.e. the star dies without ever flying.
  function spawnInto(s) {
    const ang = rnd(360);
    s.x = (Cos(ang) * diameter * S) | 0;
    s.y = (Sine(ang) * diameter * S) | 0;
    s.cx = centre.actualx;
    s.cy = centre.actualy;
    s.bZ = MAX_Z;                     // begin depth
    s.eZ = MAX_Z + rnd(6) + 4;        // end slightly deeper -> a short streak
    s.alive = s.cx !== 0 && s.cy !== 0;
  }

  function addStar() {
    // Reuse a dead slot if one exists (mirrors the C's NULL-slot scan), else grow.
    for (let q = 0; q < stars.length; q++) {
      if (!stars[q].alive) {
        spawnInto(stars[q]);
        return;
      }
    }
    const s = { x: 0, y: 0, cx: 0, cy: 0, bZ: 0, eZ: 0, alive: false };
    spawnInto(s);
    stars.push(s);
  }

  // Advance the centre one step: drift along `ang` at `speed` — through the
  // scrambled Cos/Sine, so the travel direction is a pseudo-random function of
  // the integer angle, not the aim — then steer: keep spiralling, or retarget
  // on near-arrival / random whim / edge clamp. During a spiral the edge
  // clamps are skipped, so the centre can leave the screen and wander back.
  // Mirrors moveWormhole()'s steering block.
  function moveCentre() {
    centre.virtualx += Cos(centre.ang) * speed;
    centre.virtualy += Sine(centre.ang) * speed;
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

  // One simulation step: drift the centre, push every star toward the viewer
  // (freeing those that reach the camera), drift the colour window, pulse the
  // diameter, then spawn `stars` new streaks. Mirrors moveWormhole().
  function step() {
    moveCentre();

    // zspeed is a unitless depth decrement (NOT scaled by dpr): a star's
    // lifetime is MAX_Z/zspeed steps at any resolution, exactly as in the C.
    const zspeed = Math.max(1, Math.round(config.zspeed));
    for (let q = 0; q < stars.length; q++) {
      const s = stars[q];
      if (!s.alive) continue;
      s.bZ -= zspeed;
      s.eZ -= zspeed;
      if (s.bZ <= 0 || s.eZ <= 0) s.alive = false;   // freed at the camera
    }

    moveColorChanger();

    // Diameter eases toward a target, which is re-rolled occasionally (pulses).
    if (diameter < diameterWant) diameter++;
    if (diameter > diameterWant) diameter--;
    if (rnd(30) === rnd(30)) diameterWant = rnd(35) + 5;

    const make = Math.max(1, Math.round(config.stars));
    for (let q = 0; q < make; q++) addStar();
  }

  // Draw every live star as one short line, coloured by depth through the
  // drifting palette window: color = z * shade_use / max_Z indexed from
  // shadeMin (a fresh spawn at z=600 reads one slot past the window, as the C
  // does). drawWormhole(): black fill, then one XDrawLine per star.
  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    ctx.lineWidth = W > 2560 || H > 2560 ? 3 : Math.max(1, Math.round(S));
    ctx.lineCap = 'round';

    for (let q = 0; q < stars.length; q++) {
      const s = stars[q];
      if (!s.alive) continue;

      const bx = calcX(s.x, s.bZ, s.cx);
      const by = calcX(s.y, s.bZ, s.cy);
      const ex = calcX(s.x, s.eZ, s.cx);
      const ey = calcX(s.y, s.eZ, s.cy);

      ctx.strokeStyle = shade[shadeMin + ((s.bZ * SHADE_USE / MAX_Z) | 0)];

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

    diameter = rnd(10) + 15;      // logical px; scaled by S at star spawn
    diameterWant = rnd(10) + 15;
    speed = W / 180.0;            // the C's SCREEN_X / 180.0 (already device px)

    // initWormhole() aims the first target inside a 25px margin (not min_dist).
    const m = Math.round(25 * S);
    centre = {
      actualx: (W / 2) | 0,
      actualy: (H / 2) | 0,
      virtualx: (W / 2) | 0,
      virtualy: (H / 2) | 0,
      ang: 0,
      wantX: rnd(W - m * 2) + m,
      wantY: rnd(H - m * 2) + m,
      spiral: 0,
    };
    centre.ang = gang(centre.actualx, centre.actualy, centre.wantX, centre.wantY);

    // The palette is built once per session, as in the C (its reshape keeps
    // the colormap too); reinit() re-rolls it explicitly, like a restart.
    if (!shade) initColorChanger();

    // The C starts with an empty star array: the tunnel pours out of the
    // centre over the first ~MAX_Z/zspeed steps.
    stars = [];

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator loop paced at (config.delay + OVERHEAD) µs per step
  // (delay is a floor: the port must never run faster than the author's spec);
  // see squiral.js / mountain.js. The canvas is cleared and fully redrawn each
  // step, so we draw once per frame when a step ran.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
    const delayMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    let stepped = false;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
      stepped = true;
    }

    if (stepped) draw();
    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (fresh palette + empty tunnel, like a
  // restart of the C).
  function reinit() {
    shade = null;
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
