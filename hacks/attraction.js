// attraction.js — attraction packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's attraction.c (Jamie Zawinski & John Pezaris, 1992;
// viscosity by Philip Edward Cutone III; walls/maxspeed/graph by Matt Strait).
// https://www.jwz.org/xscreensaver/
//
// A handful of balls move under a quasi-gravitational field: each ball attracts
// every other with a 1/r^2 force, but once two balls get closer than a repulsion
// `threshold` the force flips to -1/r^2 and shoves them apart, so nothing ever
// collides (the field is "like the strong and weak nuclear forces"). Velocities
// are optionally bled by a global `viscosity` and by a thresholded terminal-speed
// damping (`maxspeed`), and the balls optionally bounce off the window walls.
// In "orbit" mode the balls are seeded with matched mass and a tangential speed
// so they swing around the centre instead of clumping. Several render modes draw
// the same physics differently: balls (filled discs), lines/polygons (the balls
// as the vertices of a moving outline), tails (a fading trail behind each ball),
// and splines/filled-splines (a smooth closed curve through the balls).
//
// Rendering: ball mode plots filled discs with fillRect-style arc fills on a
// PERSISTENT canvas, with an added alpha-fade trail (galaxy's trick) so the
// default looks like a cloud chamber; trails:0 reproduces the C's hard clear.
// The line/polygon/tail/spline modes keep a rolling history of the last
// `segments` point-sets and FULL-REPAINT each frame (the C instead xor-free
// erases the oldest frame by over-drawing it in the background colour, which
// canvas can't do cleanly) — same rolling-ribbon look, no XOR. See attraction.md.

export const title = 'attraction';

export const info = {
  author: 'Jamie Zawinski and John Pezaris',
  description: 'Points attract each other and then repel, similar to the strong and weak nuclear forces.',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/attraction.xml + attraction_defaults[]
  // so the tuning UI maps 1:1 to the original. `delay` is a touch calmer than
  // the stock 10000 \u00B5s for a more relaxed pace (see attraction.md).
  const config = {
    mode: 'balls',     // render mode: balls/lines/tails/polygons/splines/filled-splines (--mode)
    points: 0,         // ball count; 0 = random 3..7 (--points)
    size: 0,           // ball mass/size; 0 = random per ball (--size)
    ncolors: 200,      // size of the rainbow palette (--colors)
    threshold: 200,    // distance below which attraction flips to repulsion (--threshold)
    delay: 14000,      // \u00B5s between steps (--delay)
    segments: 500,     // history length for line/tail/spline modes (--segments)
    viscosity: 1.0,    // per-step velocity multiplier; 1 = frictionless (--viscosity)
    glow: false,       // tie ball colour saturation to acceleration (--glow)
    walls: true,       // bounce off the window edges (--walls / --nowalls)
    maxspeed: true,    // thresholded terminal-velocity damping (--maxspeed)
    orbit: false,      // seed matched masses + tangential speed to orbit (--orbit)
    vMult: 0.9,        // orbital speed multiplier (>1 inward, <1 outward) (--vmult)
    colorShift: 3,     // frames between palette steps in non-ball modes (--color-shift)
    trails: 0.20,      // ball-mode motion-trail persistence, 0 = clear each frame (added)
  };

  // live: true  -> the loop reads config[key] every step, so it applies instantly.
  // live: false -> the value sizes the balls/palette/history, so a change re-runs
  //                init() via reinit() (which also clears the canvas).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 40000, step: 1000, default: 14000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'mode', label: 'Mode', type: 'select', options: [
        { value: 'balls', label: 'Balls' },
        { value: 'lines', label: 'Lines' },
        { value: 'tails', label: 'Tails' },
        { value: 'polygons', label: 'Polygons' },
        { value: 'splines', label: 'Splines' },
        { value: 'filled-splines', label: 'Filled splines' },
      ], default: 'balls', live: false },
    { key: 'points', label: 'Ball count (0 = random)', type: 'range', min: 0, max: 200, step: 1, default: 0, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'size', label: 'Ball mass (0 = random)', type: 'range', min: 0, max: 100, step: 1, default: 0, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'threshold', label: 'Repulsion threshold', type: 'range', min: 0, max: 600, step: 10, default: 200, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'viscosity', label: 'Viscosity', type: 'range', min: 0.5, max: 1.0, step: 0.01, default: 1.0, lowLabel: 'thick', highLabel: 'thin', live: true },
    { key: 'segments', label: 'Trail length', type: 'range', min: 2, max: 1000, step: 1, default: 500, lowLabel: 'short', highLabel: 'long', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'colorShift', label: 'Color speed', type: 'range', min: 1, max: 20, step: 1, default: 3, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'trails', label: 'Trails (balls)', type: 'range', min: 0, max: 0.9, step: 0.05, default: 0.20, lowLabel: 'none', highLabel: 'long', live: true },
    { key: 'orbit', label: 'Orbital mode', type: 'checkbox', default: false, live: false },
    { key: 'vMult', label: 'Orbit speed (< 0 outward)', type: 'range', min: -5.0, max: 5.0, step: 0.1, default: 0.9, live: false },
    { key: 'glow', label: 'Glow (balls)', type: 'checkbox', default: false, live: false },
    { key: 'walls', label: 'Bounce off walls', type: 'checkbox', default: true, live: true },
    { key: 'maxspeed', label: 'Terminal velocity', type: 'checkbox', default: true, live: true },
  ];

  // Constants from attraction.c.
  const MAX_SIZE = 16;            // graph-bar cap; also the no-size disc radius base
  const MAX_BOUNCE = 4;           // cap on bounces resolved per ball per step (cbounce)

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let balls;          // [{ x,y, vx,vy, dx,dy, mass, size, hue, pixelIndex }]
  let palette;        // ncolors CSS strings
  let ballColors;     // per-ball CSS strings (ball mode, non-glow): one hue each
  let nballs;         // resolved ball count
  let radius;         // disc draw radius for line/tail modes (global_size/2 or MAX_SIZE/3)
  let history;        // rolling buffer of { pts:Float64Array, color } for non-ball modes
  let historyCap;     // == segments (number of frames kept)
  let historyFp;      // write cursor into history (ring buffer)
  let fgIndex;        // current palette index for non-ball modes
  let colorTick;      // counts up to colorShift, then advances fgIndex
  let totalTicks;     // frames since init (tail-mode warmup)
  let orbiting;       // resolved orbit flag (may fall back to false if window too small)
  let needsBackground; // paint the one-time black background on the next frame

  function frand(max) {
    return Math.random() * max;
  }

  // Vivid rainbow palette (gallery house style); white when ncolors <= 2 (the C
  // drops to mono there). Used for non-ball modes and for the glow ramp.
  function buildPalette() {
    const n = Math.max(2, Math.round(config.ncolors));
    palette = new Array(n);
    for (let i = 0; i < n; i++) {
      palette[i] = n > 2 ? `hsl(${(i * 360 / n) | 0}, 100%, 55%)` : '#fff';
    }
  }

  // rand_size() from the C: size_scale * (8 + rand%7). size_scale is 3, or 0.75
  // for tiny windows. Sizes are in device px (mass = size*size*10 either way).
  function randSize() {
    const sizeScale = (W < 100 * S || H < 100 * S) ? 0.75 : 3;
    return Math.round(sizeScale * (8 + (frand(7) | 0)) * S);
  }

  // Seed the balls in a ring of radius r about the centre, exactly as the C does
  // (with the orbit retry: if the orbital force solves negative, fall back to a
  // plain random-velocity seed). Mirrors attraction_init()'s body.
  function seedBalls() {
    const midx = W / 2, midy = H / 2;

    // radius r: clamp to the window unless walls are off; default leaves a margin.
    let r = 0;
    if (r <= 0 || (r > Math.min(W / 2, H / 2) && config.walls)) {
      r = Math.min(W / 2, H / 2) - 50 * S;
    }
    if (r < 1) r = Math.min(W / 2, H / 2) * 0.5;

    // global_size: 0 means per-ball random; orbit forces a single shared size.
    let globalSize = Math.round(config.size) > 0 ? Math.round(config.size * S) : 0;
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
          hue: 0,
          pixelIndex: 0,
        };
        if (!orbiting) {
          // C: vx = (6 - rand%11)/8 (so -0.5..0.625), scaled by dpr for screen px.
          b.vx = ((6 - (frand(11) | 0)) / 8) * S;
          b.vy = ((6 - (frand(11) | 0)) / 8) * S;
        }
        balls[i] = b;
      }

      // Non-ball modes give every ball after the first a size of 0 so the outline
      // can use the whole window (mass is unchanged, so the physics is the same).
      if (config.mode !== 'balls' && config.mode !== 'tails') {
        for (let i = 1; i < nballs; i++) balls[i].size = 0;
      }

      if (!orbiting) break;

      // Orbital seeding: compute the net radial force on a ball at angle 0 and
      // derive the circular-orbit tangential speed v = sqrt(a*r)*v_mult.
      let a = 0;
      const vMult = config.vMult === 0 ? 1.0 : config.vMult;
      for (let i = 1; i < nballs; i++) {
        const _2ipi_n = (2 * i * Math.PI / nballs);
        const x = r * Math.cos(_2ipi_n);
        const y = r * Math.sin(_2ipi_n);
        const distx = r - x;
        const dist2 = (distx * distx) + (y * y);
        const dist = Math.sqrt(dist2);
        const a1 = ((balls[i].mass / dist2) *
                    ((dist < config.threshold * S) ? -1.0 : 1.0) *
                    (distx / dist));
        a += a1;
      }
      if (a < 0.0) {
        // "window too small for these orbit settings" — drop orbit and retry.
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

    // Per-ball colours: the C makes a random colormap of npoints entries in ball
    // mode (one hue per ball). We pick evenly-spaced rainbow hues, shuffled.
    ballColors = new Array(nballs);
    for (let i = 0; i < nballs; i++) {
      balls[i].pixelIndex = (frand(palette.length) | 0);
      ballColors[i] = `hsl(${((i / nballs) * 360 + frand(40)) | 0}, 100%, 55%)`;
    }

    // line/tail draw radius: global_size/2, or MAX_SIZE/3 when size is unset.
    radius = globalSize ? Math.round(globalSize / 2) : Math.round(MAX_SIZE / 3 * S);
  }

  // Sum the attraction/repulsion force on ball i from every other ball.
  // 1/r^2 attraction, flipped to repulsion when closer than the threshold; a tiny
  // random kick when two balls overlap (dist <= 0.1). Mirrors compute_force().
  function computeForce(i) {
    let dx = 0, dy = 0;
    const bi = balls[i];
    const thr = config.threshold * S;
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

    for (let i = 0; i < nballs; i++) {
      const b = balls[i];
      b.vx += b.dx;
      b.vy += b.dy;

      // Terminal-velocity damping (optional): balls over the speed limit get a
      // one-shot 0.9 viscosity and their pending force zeroed.
      if (Math.abs(b.vx) > 10 * S && maxspeed) {
        b.vx *= 0.9;
        b.dx = 0;
      }
      if (visc !== 1) b.vx *= visc;

      if (Math.abs(b.vy) > 10 * S && maxspeed) {
        b.vy *= 0.9;
        b.dy = 0;
      }
      if (visc !== 1) b.vy *= visc;

      b.x += b.vx;
      b.y += b.vy;

      // Bounce off the walls (correct-bounce: reflect both position and velocity,
      // up to MAX_BOUNCE resolutions per step). A ball's anchor is its top-left.
      if (walls) {
        let bounce = MAX_BOUNCE;
        while (bounce && (
          (b.x >= (W - b.size)) ||
          (b.y >= (H - b.size)) ||
          (b.x <= 0) ||
          (b.y <= 0))) {
          bounce--;
          if (b.x >= (W - b.size)) {
            b.x = (2 * (W - b.size) - b.x);
            b.vx = -b.vx;
          }
          if (b.y >= (H - b.size)) {
            b.y = (2 * (H - b.size) - b.y);
            b.vy = -b.vy;
          }
          if (b.x <= 0) {
            b.x = -b.x;
            b.vx = -b.vx;
          }
          if (b.y <= 0) {
            b.y = -b.y;
            b.vy = -b.vy;
          }
        }
      }
    }

    // For non-ball modes, push this frame's point-set into the rolling history.
    if (config.mode !== 'balls') {
      pushHistory();
      // Advance the cycling foreground colour every colorShift frames.
      if (colorTick++ >= Math.max(1, Math.round(config.colorShift))) {
        colorTick = 0;
        fgIndex = (fgIndex + 1) % palette.length;
      }
    }
  }

  // Snapshot the current ball positions (plus a closing copy of ball 0, as the C
  // does to close the polygon/spline) into the history ring, tagged with the
  // current cycling colour.
  function pushHistory() {
    const pts = new Float64Array((nballs + 1) * 2);
    for (let i = 0; i < nballs; i++) {
      pts[i * 2] = balls[i].x;
      pts[i * 2 + 1] = balls[i].y;
    }
    pts[nballs * 2] = balls[0].x;       // close the loop
    pts[nballs * 2 + 1] = balls[0].y;
    history[historyFp] = { pts, color: palette[fgIndex] };
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
    if (n < 3) {
      path.moveTo(pts[0], pts[1]);
      for (let i = 1; i < n; i++) path.lineTo(pts[i * 2], pts[i * 2 + 1]);
      return path;
    }
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
  // XFillArc (top-left corner + width/height). d is in device px.
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

  // Ball mode: alpha-fade the previous frame (trails) or hard-clear, then draw
  // each ball as a filled disc. With glow, saturation tracks acceleration.
  function drawBalls() {
    const t = config.trails;
    if (t > 0) {
      ctx.fillStyle = `rgba(0,0,0,${1 - t})`;
    } else {
      ctx.fillStyle = '#000';
    }
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < nballs; i++) {
      const b = balls[i];
      let fill;
      if (config.glow) {
        // Saturation related to acceleration (the C's glow ramp), mapped onto a
        // single random base hue per run via lightness instead of a colour ramp.
        const limit = 0.5;
        let vx = b.dx < 0 ? -b.dx : b.dx;
        let vy = b.dy < 0 ? -b.dy : b.dy;
        let fraction = (vx + vy) / S;
        if (fraction > limit) fraction = limit;
        const s = 1 - (fraction / limit);            // 1 = slow, 0 = fast
        const idx = Math.min(palette.length - 1, (palette.length * s) | 0);
        fill = palette[idx];
      } else {
        fill = ballColors[i];
      }
      disc(b.x, b.y, b.size || (2 * radius), fill);
    }
  }

  // Stroke (or fill) one history frame's outline/spline as a single path.
  function drawFrame(frame, fillMode) {
    const pts = frame.pts;
    const n = nballs;
    if (config.mode === 'splines' || config.mode === 'filled-splines') {
      const path = closedSplinePath(pts, n);
      if (fillMode) {
        ctx.fillStyle = frame.color;
        ctx.fill(path);
      } else {
        ctx.strokeStyle = frame.color;
        ctx.stroke(path);
      }
      return;
    }
    // lines / polygons: straight segments through the (closed) point set.
    const path = new Path2D();
    path.moveTo(pts[0], pts[1]);
    for (let i = 1; i <= n; i++) path.lineTo(pts[i * 2], pts[i * 2 + 1]);
    if (fillMode) {
      ctx.fillStyle = frame.color;
      ctx.fill(path);
    } else {
      ctx.strokeStyle = frame.color;
      ctx.stroke(path);
    }
  }

  // tail mode: one polyline per ball through its last `segments` positions,
  // oldest -> newest. Read straight down the history ring per ball.
  function drawTails() {
    ctx.lineWidth = Math.max(1, radius);
    ctx.lineCap = 'round';
    const have = Math.min(totalTicks, historyCap);
    for (let i = 0; i < nballs; i++) {
      const path = new Path2D();
      let started = false;
      let lastColor = palette[fgIndex];
      for (let s = 0; s < have; s++) {
        // Walk from the oldest stored frame to the newest.
        const idx = ((historyFp - have + s) % historyCap + historyCap) % historyCap;
        const fr = history[idx];
        if (!fr) continue;
        const x = fr.pts[i * 2] + radius;
        const y = fr.pts[i * 2 + 1] + radius;
        if (!started) {
          path.moveTo(x, y);
          started = true;
        } else {
          path.lineTo(x, y);
        }
        lastColor = fr.color;
      }
      if (started) {
        ctx.strokeStyle = lastColor;
        ctx.stroke(path);
      }
    }
  }

  // Repaint a non-ball mode from the rolling history. Full repaint each frame:
  // clear, then draw every stored frame (oldest first) as a stroke/fill. This
  // replaces the C's xor-free "erase the oldest frame by over-drawing it in the
  // background colour" trick, which canvas can't do without clobbering overlaps.
  function drawHistory() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = Math.max(1, Math.round(S));
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
    W = canvas.width;
    H = canvas.height;

    // points: 0 means random 3 + rand%5 (so 3..7), as in the C.
    nballs = Math.round(config.points);
    if (nballs < 1) nballs = 3 + (frand(5) | 0);

    // polygons need >= 3 vertices; fall back to lines like the C.
    if (config.mode === 'polygons' && nballs < 3) config.mode = 'lines';

    buildPalette();
    seedBalls();

    // History ring for non-ball modes. `segments` frames kept (>= 1).
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
  const MAX_CATCHUP_STEPS = 6;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = config.delay / 1000;
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
