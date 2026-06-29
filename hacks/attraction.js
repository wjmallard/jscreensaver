// attraction.js — attraction packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's attraction.c (Jamie Zawinski & John Pezaris, 1992;
// viscosity by Philip Edward Cutone III; walls/maxspeed/graphs by Matt Strait).
// https://www.jwz.org/xscreensaver/
//
// A handful of balls move under a quasi-gravitational field: each ball attracts
// every other with a 1/r^2 force, but once two balls get closer than a repulsion
// `threshold` the force flips to -1/r^2 and shoves them apart, so nothing ever
// collides ("like the strong and weak nuclear forces"). Velocities are optionally
// bled by a global `viscosity` and by a thresholded terminal-speed damping
// (`maxspeed`), and the balls optionally bounce off the window walls. In "orbit"
// mode the balls are seeded with matched mass and a tangential speed so they
// swing around the centre. Several render modes draw the same physics: balls
// (filled discs), lines/polygons (the balls as the vertices of a moving outline),
// tails (a fading trail behind each ball), and splines/filled-splines (a smooth
// closed curve through the balls).
//
// Palettes are FAITHFUL ports of the C's colormaps (utils/colors.c) via
// colormap.js — NOT a vivid HSL rainbow (the original port's bug):
//   * ball mode, no glow  -> make_random_colormap(npoints, bright): one random
//     bright colour per ball, fixed for the run.
//   * ball mode, glow     -> make_color_ramp(H,0.25,V -> H,1.0,V): a single-hue
//     saturation ramp; each ball indexes it by its acceleration.
//   * line/poly/spline/tail -> make_smooth_colormap: a muted closed loop, cycled
//     one step every (colorShift+1) frames.
// The simulation runs in LOGICAL (CSS) pixels with the C's exact constants (so it
// matches the original on a 1:1 monitor); the canvas backing store is device-px
// and a ctx transform scales drawing up for crispness on retina. See attraction.md.

import {
  makeColorRampRGB,
  makeRandomColormapRGB,
  makeSmoothColormapRGB,
} from './colormap.js';

export const title = 'attraction';

export const info = {
  author: 'Jamie Zawinski and John Pezaris',
  description: 'Points attract each other and then repel, similar to the strong and weak nuclear forces.',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Exposed config mirrors hacks/config/attraction.xml 1:1. The C has a few
  // CLI-only resources the xml never surfaces (glow/maxspeed/cbounce/colorShift,
  // plus graphmode/vx/vy/mouse-drag) — those are kept INTERNAL at their C
  // defaults so the default behaviour is faithful, but they are not shown as
  // sliders (the xml UI doesn't show them either). See attraction.md.
  const config = {
    delay: 10000,     // µs between steps (--delay; xml default 10000)
    mode: 'balls',    // balls/lines/tails/polygons/splines/filled-splines (--mode)
    walls: true,      // bounce off the window edges (--walls / --nowalls)
    points: 0,        // ball count; 0 = random 3..7 (--points)
    viscosity: 1.0,   // per-step velocity multiplier; 1 = frictionless (--viscosity)
    segments: 500,    // history length for non-ball modes (--segments)
    ncolors: 200,     // palette size (--colors)
    size: 0,          // ball mass/size; 0 = random per ball (--size)
    threshold: 200,   // distance below which attraction flips to repulsion (--threshold)
    orbit: false,     // seed matched masses + tangential speed to orbit (--orbit)
    radius: 0,        // seed-ring radius; 0 = auto (min(W,H)/2 - 50) (--radius)
    vMult: 0.9,       // orbital speed multiplier (>0 inward, <0 outward) (--vmult)

    // CLI-only (not in attraction.xml); fixed at the C's defaults.
    glow: false,      // --glow:    saturation-by-acceleration ramp (ball mode)
    maxspeed: true,   // --maxspeed: thresholded terminal-velocity damping
    cbounce: true,    // --correct-bounce: exact reflective wall bounce
    colorShift: 3,    // --color-shift: frames between palette steps (non-ball modes)
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes the balls/palette/history, so a change re-runs
  //                init() via reinit() (which also clears the canvas).
  const params = [
    { key: 'delay', label: 'Speed', type: 'range', min: 0, max: 40000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'mode', label: 'Mode', type: 'select', options: [
        { value: 'balls', label: 'Balls' },
        { value: 'lines', label: 'Lines' },
        { value: 'tails', label: 'Tails' },
        { value: 'polygons', label: 'Polygons' },
        { value: 'splines', label: 'Splines' },
        { value: 'filled-splines', label: 'Filled splines' },
      ], default: 'balls', live: false },
    { key: 'walls', label: 'Bounce off walls', type: 'checkbox', default: true, live: true },
    { key: 'points', label: 'Ball count', type: 'range', min: 0, max: 200, step: 1, default: 0, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'viscosity', label: 'Environmental viscosity', type: 'range', min: 0, max: 1.0, step: 0.01, default: 1.0, invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'segments', label: 'Trail length', type: 'range', min: 2, max: 1000, step: 1, default: 500, lowLabel: 'short', highLabel: 'long', live: false },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 2, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'size', label: 'Ball mass', type: 'range', min: 0, max: 100, step: 1, default: 0, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'threshold', label: 'Repulsion threshold', type: 'range', min: 0, max: 600, step: 10, default: 200, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'orbit', label: 'Orbital mode', type: 'checkbox', default: false, live: false },
    { key: 'radius', label: 'Radius', type: 'range', min: 0, max: 1000, step: 10, default: 0, lowLabel: 'auto', highLabel: 'wide', live: false },
    { key: 'vMult', label: 'Orbit speed', type: 'range', min: -5.0, max: 5.0, step: 0.1, default: 0.9, lowLabel: 'outward', highLabel: 'inward', live: false },
  ];

  // Constants from attraction.c.
  const MAX_SIZE = 16;            // base disc/line scale; also the no-size radius base
  const MAX_BOUNCE = 4;           // cap on bounces resolved per ball per step (cbounce)

  let S = 1;          // devicePixelRatio (drawing transform only; physics is CSS px)
  let W, H;           // canvas size, LOGICAL (CSS) px — the simulation space
  let balls;          // [{ x,y, vx,vy, dx,dy, mass, size, pixelIndex }]
  let nballs;         // resolved ball count
  let mono;           // ncolors <= 2: draw in white, no palette
  let palette;        // CSS strings: smooth map (non-ball) or glow ramp (ball+glow)
  let ballPalette;    // CSS strings: random colormap, one per ball (ball, no glow)
  let radius;         // tail/centre offset: global_size/2, or MAX_SIZE/3 when unset
  let tailWidth;      // tail line width: global_size, or MAX_SIZE*2/3 when unset
  let history;        // ring of { pts:Float64Array, color } for non-ball modes
  let historyCap;     // == segments (frames kept)
  let historyFp;      // write cursor (ring buffer)
  let fgIndex;        // current palette index for non-ball cycling
  let colorTick;      // counts up to colorShift, then advances fgIndex
  let totalTicks;     // frames since init
  let orbiting;       // resolved orbit flag (may fall back if window too small)
  let needsBackground;// paint the one-time black background on the next frame

  function frand(max) { return Math.random() * max; }
  function randInt(n) { return Math.floor(Math.random() * n); }
  const toCss = ([r, g, b]) => `rgb(${r},${g},${b})`;

  // rand_size() from the C: size_scale * (8 + rand%7). size_scale is 3, or 0.75
  // for tiny windows. CSS px (no dpr scaling). mass = size*size*10.
  function randSize() {
    const sizeScale = (W < 100 || H < 100) ? 0.75 : 3;
    return Math.round(sizeScale * (8 + randInt(7)));
  }

  // Build the palette(s) for the current mode, exactly as attraction_init does:
  //   ball + glow  -> make_color_ramp (single hue, 0.25..1.0 saturation), indexed
  //                   per-ball by acceleration.
  //   ball + !glow -> make_random_colormap of `npoints` bright colours; each ball
  //                   gets a fixed random index.
  //   other modes  -> make_smooth_colormap of `ncolors`, cycled by fg_index.
  // ncolors <= 2 => mono (white), no palette (the C drops to mono_p there).
  function buildPalette() {
    const nc = Math.max(2, Math.round(config.ncolors));
    mono = Math.round(config.ncolors) <= 2;
    palette = null;
    ballPalette = null;
    if (mono) return;
    if (config.mode === 'balls') {
      if (config.glow) {
        const h = randInt(360);
        const v = frand(0.25) + 0.75;
        palette = makeColorRampRGB(h, 0.25, v, h, 1.0, v, nc, false).map(toCss);
      } else {
        // ncolors := npoints; one random bright colour per ball.
        ballPalette = makeRandomColormapRGB(nballs, true).map(toCss);
      }
    } else {
      palette = makeSmoothColormapRGB(nc).map(toCss);
    }
  }

  // Seed the balls in a ring of radius r about the centre, exactly as the C does
  // (with the orbit retry: if the orbital force solves negative, fall back to a
  // plain random-velocity seed). Mirrors attraction_init()'s body.
  function seedBalls() {
    const midx = W / 2, midy = H / 2;

    // radius r: clamp to the window unless walls are off; 0 => auto (margin of 50).
    let r = Math.round(config.radius) > 0 ? Math.round(config.radius) : 0;
    if (r <= 0 || (r > Math.min(W / 2, H / 2) && config.walls)) {
      r = Math.min(W / 2, H / 2) - 50;
    }
    if (r < 1) r = Math.min(W / 2, H / 2) * 0.5;   // tiny-window safety (not in C)

    // global_size: 0 means per-ball random; orbit forces a single shared size.
    let globalSize = Math.round(config.size) > 0 ? Math.round(config.size) : 0;
    orbiting = !!config.orbit;
    if (orbiting && !globalSize) globalSize = randSize();

    // The C retries the whole seed (RETRY_NO_ORBIT) if the orbit force is < 0;
    // bound the loop and just drop orbit on the last try.
    for (let attempt = 0; attempt < 2; attempt++) {
      const th = frand(Math.PI + Math.PI);
      balls = new Array(nballs);
      for (let i = 0; i < nballs; i++) {
        const newSize = globalSize ? globalSize : randSize();
        const b = {
          x: midx + r * Math.cos(i * ((Math.PI + Math.PI) / nballs) + th),
          y: midy + r * Math.sin(i * ((Math.PI + Math.PI) / nballs) + th),
          vx: 0,
          vy: 0,
          dx: 0,
          dy: 0,
          size: newSize,
          mass: newSize * newSize * 10,
          pixelIndex: 0,
        };
        if (!orbiting) {
          b.vx = (6 - randInt(11)) / 8;   // C: (6 - rand%11)/8  -> -0.5 .. 0.625
          b.vy = (6 - randInt(11)) / 8;
        }
        balls[i] = b;
      }

      // Non-ball, non-tail modes give every ball after the first a size of 0 so
      // the outline can use the whole window (mass unchanged: same physics).
      if (config.mode !== 'balls' && config.mode !== 'tails') {
        for (let i = 1; i < nballs; i++) balls[i].size = 0;
      }

      if (!orbiting) break;

      // Orbital seeding: net radial force on a ball at angle 0 -> circular-orbit
      // tangential speed v = sqrt(a*r)*v_mult.
      let a = 0;
      const vMult = config.vMult === 0 ? 1.0 : config.vMult;
      for (let i = 1; i < nballs; i++) {
        const _2ipi_n = (2 * i * Math.PI / nballs);
        const x = r * Math.cos(_2ipi_n);
        const y = r * Math.sin(_2ipi_n);
        const distx = r - x;
        const dist2 = (distx * distx) + (y * y);
        const dist = Math.sqrt(dist2);
        a += ((balls[i].mass / dist2) *
              ((dist < config.threshold) ? -1.0 : 1.0) *
              (distx / dist));
      }
      if (a < 0.0) {           // "window too small for these orbit settings"
        orbiting = false;
        continue;
      }
      const v = Math.sqrt(a * r) * vMult;
      for (let i = 0; i < nballs; i++) {
        const k = ((2 * i * Math.PI / nballs) + th);
        balls[i].vx = -v * Math.sin(k);
        balls[i].vy = v * Math.cos(k);
      }
      break;
    }

    // Ball mode, no glow: each ball gets a fixed random index into the random
    // colormap of npoints entries (C: pixel_index = random() % ncolors).
    for (let i = 0; i < nballs; i++) balls[i].pixelIndex = randInt(nballs);

    // tail geometry derives from global_size (the resource), not per-ball size:
    radius = globalSize ? Math.round(globalSize / 2) : Math.round(MAX_SIZE / 3);
    tailWidth = globalSize ? globalSize : Math.round(MAX_SIZE * 2 / 3);
  }

  // compute_force(): sum the attraction/repulsion on ball i from every other ball.
  // 1/r^2 attraction, flipped to repulsion below the threshold; a tiny random kick
  // when two balls overlap (dist <= 0.1).
  function computeForce(i) {
    let dx = 0, dy = 0;
    const bi = balls[i];
    const thr = config.threshold;
    for (let j = 0; j < nballs; j++) {
      if (i === j) continue;
      const bj = balls[j];
      const xDist = bj.x - bi.x;
      const yDist = bj.y - bi.y;
      const dist2 = (xDist * xDist) + (yDist * yDist);
      const dist = Math.sqrt(dist2);
      if (dist > 0.1) {
        const newAcc = ((bj.mass / dist2) * ((dist < thr) ? -1.0 : 1.0));
        const newAccDist = newAcc / dist;
        dx += newAccDist * xDist;
        dy += newAccDist * yDist;
      } else {
        dx += (frand(10.0) - 5.0);
        dy += (frand(10.0) - 5.0);
      }
    }
    bi.dx = dx;
    bi.dy = dy;
  }

  // Advance the physics one frame: forces, then integrate velocity/position with
  // optional terminal-velocity damping + viscosity, then bounce off the walls.
  // Mirrors the move loop in attraction_draw(); drawing is split into draw().
  function step() {
    totalTicks++;

    for (let i = 0; i < nballs; i++) computeForce(i);

    const visc = config.viscosity;
    const maxspeed = config.maxspeed;
    const walls = config.walls;
    const cbounce = config.cbounce;

    for (let i = 0; i < nballs; i++) {
      const b = balls[i];
      b.vx += b.dx;
      b.vy += b.dy;

      // Terminal-velocity damping (optional): balls over the speed limit get a
      // one-shot 0.9 viscosity and their pending force zeroed.
      if (Math.abs(b.vx) > 10 && maxspeed) { b.vx *= 0.9; b.dx = 0; }
      if (visc !== 1) b.vx *= visc;
      if (Math.abs(b.vy) > 10 && maxspeed) { b.vy *= 0.9; b.dy = 0; }
      if (visc !== 1) b.vy *= visc;

      b.x += b.vx;
      b.y += b.vy;

      // Bounce off the walls; a ball's anchor is its top-left corner, so the
      // right/bottom walls are at W-size / H-size.
      if (walls) {
        if (cbounce) {
          // correct-bounce: reflect position + velocity, up to MAX_BOUNCE/step.
          let bounce = MAX_BOUNCE;
          while (bounce && (
            (b.x >= (W - b.size)) ||
            (b.y >= (H - b.size)) ||
            (b.x <= 0) ||
            (b.y <= 0))) {
            bounce--;
            if (b.x >= (W - b.size)) { b.x = (2 * (W - b.size) - b.x); b.vx = -b.vx; }
            if (b.y >= (H - b.size)) { b.y = (2 * (H - b.size) - b.y); b.vy = -b.vy; }
            if (b.x <= 0) { b.x = -b.x; b.vx = -b.vx; }
            if (b.y <= 0) { b.y = -b.y; b.vy = -b.vy; }
          }
        } else {
          // old-bounce: clamp to the edge, flip velocity only if heading out.
          if (b.x >= (W - b.size)) { b.x = (W - b.size - 1); if (b.vx > 0) b.vx = -b.vx; }
          if (b.y >= (H - b.size)) { b.y = (H - b.size - 1); if (b.vy > 0) b.vy = -b.vy; }
          if (b.x <= 0) { b.x = 0; if (b.vx < 0) b.vx = -b.vx; }
          if (b.y <= 0) { b.y = 0; if (b.vy < 0) b.vy = -b.vy; }
        }
      }
    }

    // For non-ball modes, push this frame's point-set into the rolling history,
    // then advance the cycling colour: C does `if (color_tick++ == color_shift)`.
    if (config.mode !== 'balls') {
      pushHistory();
      if (!mono && colorTick++ === config.colorShift) {
        colorTick = 0;
        fgIndex = (fgIndex + 1) % palette.length;
      }
    }
  }

  // Snapshot the current ball positions (plus a closing copy of ball 0, as the C
  // does to close the polygon/spline) into the history ring, tagged with the
  // current cycling colour (white in mono).
  function pushHistory() {
    const pts = new Float64Array((nballs + 1) * 2);
    for (let i = 0; i < nballs; i++) {
      pts[i * 2] = balls[i].x;
      pts[i * 2 + 1] = balls[i].y;
    }
    pts[nballs * 2] = balls[0].x;       // close the loop
    pts[nballs * 2 + 1] = balls[0].y;
    const color = mono ? '#fff' : palette[fgIndex];
    history[historyFp] = { pts, color };
    historyFp = (historyFp + 1) % historyCap;
  }

  // ---- spline helpers (port of utils/spline.c calc_section) ----------------
  // calc_section turns four successive control points into a cubic Bezier whose
  // control polygon is (p0,p1,p2,p3); the C then line-approximates that Bezier,
  // we hand it straight to canvas bezierCurveTo. Same curve, fewer ops.
  function thirdPoint(x0, y0, x1, y1) {
    return [(2 * x0 + x1) / 3.0, (2 * y0 + y1) / 3.0];
  }
  function midPoint(x0, y0, x1, y1) {
    return [(x0 + x1) / 2.0, (y0 + y1) / 2.0];
  }
  // Append the Bezier for one section to a Path2D (moveTo first section only).
  function sectionBezier(path, first, cm1x, cm1y, cx, cy, cp1x, cp1y, cp2x, cp2y) {
    const p1 = thirdPoint(cx, cy, cp1x, cp1y);
    const p2 = thirdPoint(cp1x, cp1y, cx, cy);
    const t0 = thirdPoint(cx, cy, cm1x, cm1y);
    const p0 = midPoint(t0[0], t0[1], p1[0], p1[1]);
    const t3 = thirdPoint(cp1x, cp1y, cp2x, cp2y);
    const p3 = midPoint(t3[0], t3[1], p2[0], p2[1]);
    if (first) path.moveTo(p0[0], p0[1]);
    path.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  }
  // Build a closed-spline Path2D through n control points (pts is the +1-padded
  // array; we use the first n). Mirrors compute_closed_spline()'s section order.
  function closedSplinePath(pts, n) {
    const path = new Path2D();
    const cx = (k) => pts[((k % n + n) % n) * 2];
    const cy = (k) => pts[((k % n + n) % n) * 2 + 1];
    sectionBezier(path, true, cx(n - 1), cy(n - 1), cx(0), cy(0), cx(1), cy(1), cx(2), cy(2));
    let i;
    for (i = 1; i < n - 2; i++) {
      sectionBezier(path, false, cx(i - 1), cy(i - 1), cx(i), cy(i), cx(i + 1), cy(i + 1), cx(i + 2), cy(i + 2));
    }
    sectionBezier(path, false, cx(i - 1), cy(i - 1), cx(i), cy(i), cx(i + 1), cy(i + 1), cx(0), cy(0));
    sectionBezier(path, false, cx(i), cy(i), cx(i + 1), cy(i + 1), cx(0), cy(0), cx(1), cy(1));
    return path;
  }

  // ---- drawing -------------------------------------------------------------
  // A filled disc anchored at top-left (x,y) with diameter d, matching the C's
  // XFillArc (top-left corner + width/height). Coordinates are CSS px.
  function disc(x, y, d, fill) {
    if (d < 1) d = 1;
    const r = d / 2;
    const cx = x + r, cy = y + r;
    if (cx < -r || cy < -r || cx > W + r || cy > H + r) return;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Ball mode: hard-clear to black (the C erases each ball's old disc, which on a
  // black field is identical to a full clear), then draw each ball as a filled
  // disc. With glow, the index tracks acceleration along the saturation ramp.
  function drawBalls() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < nballs; i++) {
      const b = balls[i];
      let fill;
      if (mono) {
        fill = '#fff';
      } else if (config.glow) {
        // C: fraction = |dx|+|dy| (acceleration); s = 1 - fraction/limit;
        //    pixel_index = ncolors * s  (slow balls vivid, fast balls washed out).
        const limit = 0.5;
        const ax = b.dx < 0 ? -b.dx : b.dx;
        const ay = b.dy < 0 ? -b.dy : b.dy;
        let fraction = ax + ay;
        if (fraction > limit) fraction = limit;
        const s = 1 - (fraction / limit);
        const idx = Math.min(palette.length - 1, Math.floor(palette.length * s));
        fill = palette[idx];
      } else {
        fill = ballPalette[b.pixelIndex];
      }
      disc(b.x, b.y, b.size, fill);
    }
  }

  // Stroke (or fill) one history frame's outline/spline as a single path.
  function drawFrame(frame, fillMode) {
    const pts = frame.pts;
    const n = nballs;
    let path;
    if (config.mode === 'splines' || config.mode === 'filled-splines') {
      if (n < 3) return;   // compute_closed_spline draws nothing for < 3 controls
      path = closedSplinePath(pts, n);
    } else {
      // lines / polygons: straight segments through the (closed) point set.
      path = new Path2D();
      path.moveTo(pts[0], pts[1]);
      for (let i = 1; i <= n; i++) path.lineTo(pts[i * 2], pts[i * 2 + 1]);
    }
    if (fillMode) {
      ctx.fillStyle = frame.color;
      ctx.fill(path);
    } else {
      ctx.strokeStyle = frame.color;
      ctx.stroke(path);
    }
  }

  // tail mode: one round-capped worm per ball through its last `segments`
  // positions (offset by `radius` to centre on the ball, as the C does), width
  // `tailWidth`. Each segment keeps the cycling colour it was drawn in, so the
  // worm carries a colour gradient — we group equal-colour runs into sub-paths.
  function drawTails() {
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, tailWidth);
    const have = Math.min(totalTicks, historyCap);
    if (have < 2) return;
    for (let i = 0; i < nballs; i++) {
      let path = null, runColor = null, px = 0, py = 0, havePrev = false;
      for (let s = 0; s < have; s++) {
        const idx = ((historyFp - have + s) % historyCap + historyCap) % historyCap;
        const fr = history[idx];
        if (!fr) { havePrev = false; continue; }
        const x = fr.pts[i * 2] + radius;
        const y = fr.pts[i * 2 + 1] + radius;
        if (havePrev) {
          const segColor = fr.color;   // segment drawn at this frame used this fg
          if (segColor !== runColor) {
            if (path) { ctx.strokeStyle = runColor; ctx.stroke(path); }
            path = new Path2D();
            path.moveTo(px, py);
            runColor = segColor;
          }
          path.lineTo(x, y);
        }
        px = x; py = y; havePrev = true;
      }
      if (path) { ctx.strokeStyle = runColor; ctx.stroke(path); }
    }
  }

  // Repaint a non-ball mode from the rolling history. Full repaint each frame:
  // clear, then draw every stored frame (oldest first) as a stroke/fill. This
  // replaces the C's "erase the oldest frame by re-drawing it in the background
  // colour" trick, which canvas can't do without clobbering crossing outlines;
  // the visible result (the last `segments` outlines, each in its own colour) is
  // the same. line_width is 1 for these modes (the C's gcv.line_width).
  function drawHistory() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';

    if (config.mode === 'tails') {
      drawTails();
      return;
    }

    const fillMode = (config.mode === 'polygons' || config.mode === 'filled-splines');
    const have = Math.min(totalTicks, historyCap);
    for (let s = 0; s < have; s++) {
      const idx = ((historyFp - have + s) % historyCap + historyCap) % historyCap;
      const fr = history[idx];
      if (fr) drawFrame(fr, fillMode);
    }
  }

  function draw() {
    if (config.mode === 'balls') drawBalls();
    else drawHistory();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width / S;        // LOGICAL (CSS) px — the simulation space
    H = canvas.height / S;
    ctx.setTransform(S, 0, 0, S, 0, 0);   // draw in CSS coords, crisp on retina

    // points: 0 means random 3 + rand%5 (so 3..7), as in the C.
    nballs = Math.round(config.points);
    if (nballs < 1) nballs = 3 + randInt(5);

    // polygons need >= 3 vertices; fall back to lines like the C.
    if (config.mode === 'polygons' && nballs < 3) config.mode = 'lines';

    buildPalette();
    seedBalls();

    // History ring for non-ball modes. `segments` frames kept (>= 2).
    historyCap = Math.max(2, Math.round(config.segments));
    history = new Array(historyCap).fill(null);
    historyFp = 0;
    fgIndex = 0;
    colorTick = 0;
    totalTicks = 0;

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

  // rAF lag-accumulator paced by config.delay (µs); run one step() per delay,
  // banking leftover time so the speed is identical at any refresh rate, with a
  // catch-up cap so a backgrounded tab doesn't burst on refocus. The physics
  // (step) is the expensive part for many balls, so draw() runs at most once per
  // frame, only when at least one step happened.
  //
  // OVERHEAD: the stock --delay is only a sleep floor; the live binary's real
  // rate is lower (delay + framework overhead -- see the framerate-calibration
  // note). The live attraction measures 59.9 fps, but the port at the stock 10000
  // us ran ~100 steps/sec (1.7x fast). 10000 + 6694 = 16694 us -> 59.9 steps/sec,
  // matching the live binary. A calibration, not a tuning knob (the delay
  // slider still maps 1:1 to the xml resource).
  const OVERHEAD = 6694;
  const MAX_CATCHUP_STEPS = 6;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    if (needsBackground) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      needsBackground = false;
      draw();   // frame 1 already shows the seeded balls/outline
    }

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

  // Re-seed with the current config (clears the canvas; counts/colors/mode may
  // differ). init() rebuilds the balls, palette and history.
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
