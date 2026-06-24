// ccurve.js — ccurve packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's ccurve.c (Rick Campbell, 1998-1999).
// https://www.jwz.org/xscreensaver/
//
// Draws self-similar linear fractals, the Levy / "C Curve" family. A random
// generator of 2, 3, or 4 line segments is chosen and normalized to run from
// (0,0) to (1,0); the curve at depth N is built by recursively replacing every
// segment with a rotated/scaled copy of that generator. The fractal "grows" one
// depth per frame (depth 0 = a single line, depth 1 = the bare generator, ...),
// auto-fitting the view to its bounding box as it gains detail; once it reaches
// full depth the screen lingers, then a fresh generator starts from scratch.
//
// Rendering: the curve is genuinely line-shaped (one XDrawLine per leaf segment
// in the C), so this uses canvas VECTOR ops. The C colours each leaf line by its
// position along the curve (a rainbow gradient) and casts that to an integer
// palette index, so leaf segments are bucketed by colour index into one Path2D
// per colour (256, the C's MAXIMUM_COLOR_COUNT) and each bucket is stroked once —
// turning up to tens of thousands of XDrawLine calls into <=256 stroke()s/frame.

export const title = 'ccurve';

export const info = {
  author: 'Rick Campbell',
  description: 'Generates self-similar linear fractals, including the classic "C Curve".\n\nhttps://en.wikipedia.org/wiki/Levy_C_curve',
  year: 1999,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/ccurve.xml (1:1 with the original).
  // The C runs two timers: `pause` (short, between successive depth frames as the
  // fractal grows) and `delay` (long, the "linger" once a fractal is complete,
  // before the next one). `limit` sets the recursion depth (density). In ccurve
  // BOTH timers are in SECONDS (the C reads them as floats and multiplies by 1e6),
  // matching the xml's seconds-labelled sliders; we divide to ms in the loop. The
  // palette is fixed (256-entry rainbow, not user-configurable) -- see buildPalette.
  const config = {
    delay: 3,          // seconds to linger on a finished fractal (--delay)
    pause: 0.4,        // seconds between depth frames as it grows (--pause)
    limit: 200000,     // line budget; sets recursion depth (--limit)
  };

  const params = [
    { key: 'pause', label: 'Animation speed', type: 'range', min: 0, max: 5, step: 0.1, default: 0.4, unit: ' s', invert: true, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    { key: 'delay', label: 'Change image every', type: 'range', min: 0, max: 30, step: 1, default: 3, unit: ' s', lowLabel: '0 seconds', highLabel: '30 seconds', live: true },
    { key: 'limit', label: 'Density', type: 'range', min: 3, max: 300000, step: 1000, default: 200000, lowLabel: 'Low', highLabel: 'High', live: false },
  ];

  const EPSILON = 1e-5;
  const COLOR_COUNT = 256;   // the C's MAXIMUM_COLOR_COUNT (make_color_loop size)
  // The C weights segment counts so 4-segment generators dominate, then 3, then 2.
  const LENGTHS = [4, 4, 4, 4, 4, 3, 3, 3, 2];

  // Common angle constants the C reaches for via M_PI_4 / M_PI_2 / M_SQRT2.
  const PI = Math.PI;
  const PI_2 = Math.PI / 2;
  const PI_4 = Math.PI / 4;
  const SQRT2 = Math.SQRT2;

  let S = 1;                 // devicePixelRatio
  let W, H;                  // canvas size, device px
  let palette;               // 256 full-saturation rainbow CSS strings (make_color_loop)

  // Current-fractal state (mirrors the C's struct draw_* fields).
  let segments;              // the chosen generator: [{ angle, length }, ...]
  let segmentCount;          // 2, 3, or 4
  let points;                // generator normalized to (0,0)->(1,0)
  let iterations;            // max recursion depth for this generator
  let drawIndex;             // depth drawn this frame; grows 0..iterations-1
  let drawX1, drawY1, drawX2, drawY2;          // current plot-space endpoints
  let drawMaxX, drawMaxY, drawMinX, drawMinY;  // current view bounds (plot space)
  let plotMaxX, plotMaxY, plotMinX, plotMinY;  // extents traced this frame
  let lineCount, totalLines;                   // leaf line index / count -> colour
  let paths;                                   // Path2D per colour, this frame

  // random_double(base, limit): a uniform double in [base, limit). The C quantizes
  // by an epsilon step (random()%steps * eps); a continuous draw is equivalent for
  // our purposes and keeps the same ranges.
  function randomDouble(base, limit) {
    return base + Math.random() * (limit - base);
  }

  // INTRAND-style coin flips, matching the C's (random() % n).
  const flip = () => Math.random() < 0.5;
  const rand = (n) => Math.floor(Math.random() * n);

  function buildPalette() {
    // ccurve_init builds a fixed 256-entry HSV colour LOOP via make_color_loop
    // with anchors (0,1,1)/(120,1,1)/(240,1,1) -- a full-saturation, full-value
    // hue sweep red->green->blue->red, built ONCE and never cycled. With s=v=1 at
    // evenly spaced hues that loop is exactly hsl(h,100%,50%), so we emit the same
    // 256 entries. (hsl 100%/50% == hsv s=1/v=1; 50% lightness keeps the hues pure.)
    palette = new Array(COLOR_COUNT);
    for (let i = 0; i < COLOR_COUNT; i++) {
      palette[i] = `hsl(${i * 360 / COLOR_COUNT}, 100%, 50%)`;
    }
  }

  // --- generator selection (the C's select_2/3/4_pattern, transcribed) ---------

  function select2(seg) {
    if (flip()) {
      if (flip()) {
        seg[0] = { angle: -PI_4, length: SQRT2 };
        seg[1] = { angle: PI_4, length: SQRT2 };
      } else {
        seg[0] = { angle: PI_4, length: SQRT2 };
        seg[1] = { angle: -PI_4, length: SQRT2 };
      }
    } else {
      const a0 = randomDouble(PI / 6, PI / 3);
      const l0 = randomDouble(0.25, 0.67);
      seg[0] = { angle: a0, length: l0 };
      if (flip()) {
        seg[1] = { angle: -a0, length: l0 };
      } else {
        seg[1] = {
          angle: randomDouble(-PI / 3, -PI / 6),
          length: randomDouble(0.25, 0.67),
        };
      }
    }
  }

  function select3(seg) {
    switch (rand(5)) {
      case 0:
        if (flip()) {
          seg[0] = { angle: PI_4, length: SQRT2 / 4 };
          seg[1] = { angle: -PI_4, length: SQRT2 / 2 };
          seg[2] = { angle: PI_4, length: SQRT2 / 4 };
        } else {
          seg[0] = { angle: -PI_4, length: SQRT2 / 4 };
          seg[1] = { angle: PI_4, length: SQRT2 / 2 };
          seg[2] = { angle: -PI_4, length: SQRT2 / 4 };
        }
        break;
      case 1:
        if (flip()) {
          seg[0] = { angle: PI / 6, length: 1.0 };
          seg[1] = { angle: -PI_2, length: 1.0 };
          seg[2] = { angle: PI / 6, length: 1.0 };
        } else {
          seg[0] = { angle: -PI / 6, length: 1.0 };
          seg[1] = { angle: PI_2, length: 1.0 };
          seg[2] = { angle: -PI / 6, length: 1.0 };
        }
        break;
      default: {  // cases 2, 3, 4
        const a0 = randomDouble(PI / 6, PI / 3);
        const l0 = randomDouble(0.25, 0.67);
        seg[0] = { angle: a0, length: l0 };
        seg[1] = {
          angle: randomDouble(-PI / 3, -PI / 6),
          length: randomDouble(0.25, 0.67),
        };
        if (rand(3) === 0) {
          seg[2] = { angle: flip() ? a0 : -a0, length: l0 };
        } else {
          seg[2] = {
            angle: randomDouble(-PI / 3, -PI / 6),
            length: randomDouble(0.25, 0.67),
          };
        }
        break;
      }
    }
  }

  function select4(seg) {
    switch (rand(9)) {
      case 0: {
        const length = randomDouble(0.25, 0.50);
        if (flip()) {
          seg[0] = { angle: 0.0, length: 0.5 };
          seg[1] = { angle: PI_2, length: length };
          seg[2] = { angle: -PI_2, length: length };
          seg[3] = { angle: 0.0, length: 0.5 };
        } else {
          seg[0] = { angle: 0.0, length: 0.5 };
          seg[1] = { angle: -PI_2, length: length };
          seg[2] = { angle: PI_2, length: length };
          seg[3] = { angle: 0.0, length: 0.5 };
        }
        break;
      }
      case 1:
        if (flip()) {
          seg[0] = { angle: 0.0, length: 0.5 };
          seg[1] = { angle: PI_2, length: 0.45 };
          seg[2] = { angle: -PI_2, length: 0.45 };
          seg[3] = { angle: 0.0, length: 0.5 };
        } else {
          seg[0] = { angle: 0.0, length: 0.5 };
          seg[1] = { angle: -PI_2, length: 0.45 };
          seg[2] = { angle: PI_2, length: 0.45 };
          seg[3] = { angle: 0.0, length: 0.5 };
        }
        break;
      case 2:
        if (flip()) {
          seg[0] = { angle: 0.0, length: 1.0 };
          seg[1] = { angle: (5.0 * PI) / 12.0, length: 1.2 };
          seg[2] = { angle: (-5.0 * PI) / 12.0, length: 1.2 };
          seg[3] = { angle: 0.0, length: 1.0 };
        } else {
          seg[0] = { angle: 0.0, length: 1.0 };
          seg[1] = { angle: (-5.0 * PI) / 12.0, length: 1.2 };
          seg[2] = { angle: (5.0 * PI) / 12.0, length: 1.2 };
          seg[3] = { angle: 0.0, length: 1.0 };
        }
        break;
      case 3:
      case 4: {
        // Cases 3 and 4 are identical in the C.
        const angle = randomDouble(PI_4, PI_2);
        if (flip()) {
          seg[0] = { angle: 0.0, length: 1.0 };
          seg[1] = { angle: angle, length: 1.2 };
          seg[2] = { angle: -angle, length: 1.2 };
          seg[3] = { angle: 0.0, length: 1.0 };
        } else {
          seg[0] = { angle: 0.0, length: 1.0 };
          seg[1] = { angle: -angle, length: 1.2 };
          seg[2] = { angle: angle, length: 1.2 };
          seg[3] = { angle: 0.0, length: 1.0 };
        }
        break;
      }
      case 5: {
        const angle = randomDouble(PI_4, PI_2);
        const length = randomDouble(0.25, 0.50);
        if (flip()) {
          seg[0] = { angle: 0.0, length: 1.0 };
          seg[1] = { angle: angle, length: length };
          seg[2] = { angle: -angle, length: length };
          seg[3] = { angle: 0.0, length: 1.0 };
        } else {
          seg[0] = { angle: 0.0, length: 1.0 };
          seg[1] = { angle: -angle, length: length };
          seg[2] = { angle: angle, length: length };
          seg[3] = { angle: 0.0, length: 1.0 };
        }
        break;
      }
      default: {  // cases 6, 7, 8
        seg[0] = {
          angle: randomDouble(PI / 12.0, (11.0 * PI) / 12.0),
          length: randomDouble(0.25, 0.50),
        };
        seg[1] = {
          angle: randomDouble(PI / 12.0, (11.0 * PI) / 12.0),
          length: randomDouble(0.25, 0.50),
        };
        if (rand(3) === 0) {
          seg[2] = {
            angle: randomDouble(PI / 12.0, (11.0 * PI) / 12.0),
            length: randomDouble(0.25, 0.50),
          };
          seg[3] = {
            angle: randomDouble(PI / 12.0, (11.0 * PI) / 12.0),
            length: randomDouble(0.25, 0.50),
          };
        } else if (flip()) {
          seg[2] = { angle: -seg[1].angle, length: seg[1].length };
          seg[3] = { angle: -seg[0].angle, length: seg[0].length };
        } else {
          seg[2] = { angle: seg[1].angle, length: seg[1].length };
          seg[3] = { angle: seg[0].angle, length: seg[0].length };
        }
        break;
      }
    }
  }

  function selectPattern(count, seg) {
    if (count === 2) select2(seg);
    else if (count === 3) select3(seg);
    else select4(seg);
  }

  // --- geometry (the C's normalized_plot / realign) ----------------------------

  // Turn the generator's segments into cumulative points, then rotate+scale the
  // whole chain so it runs from (0,0) to (1,0). Writes into `points`.
  function normalizedPlot() {
    let x = 0.0;
    let y = 0.0;
    for (let i = 0; i < segmentCount; i++) {
      x += segments[i].length * Math.cos(segments[i].angle);
      y += segments[i].length * Math.sin(segments[i].angle);
      points[i].x = x;
      points[i].y = y;
    }
    const angle = -Math.atan2(y, x);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const length = Math.sqrt(x * x + y * y);
    for (let i = 0; i < segmentCount; i++) {
      const tx = points[i].x;
      const ty = points[i].y;
      points[i].x = (tx * cosine + ty * -sine) / length;
      points[i].y = (tx * sine + ty * cosine) / length;
    }
  }

  // Rotate, scale, then shift `src` (normalized points) so it spans (x1,y1)->
  // (x2,y2); writes into `dst`. (The C's realign, operating on a copy.)
  function realign(x1, y1, x2, y2, src, dst) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const angle = Math.atan2(dy, dx);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const length = Math.sqrt(dx * dx + dy * dy);
    for (let i = 0; i < segmentCount; i++) {
      const tx = src[i].x;
      const ty = src[i].y;
      dst[i].x = length * (tx * cosine + ty * -sine) + x1;
      dst[i].y = length * (tx * sine + ty * cosine) + y1;
    }
  }

  // --- recursion (the C's self_similar_normalized) -----------------------------
  // At depth 0 draw the leaf line (x1,y1)->(x2,y2), colouring by curve position
  // and tracking plot extents. Otherwise realign the generator onto the segment
  // and recurse on each sub-segment. Returns false to bail (a numerically broken
  // realign), matching the C's EPSILON guard. `scratch[]` is a per-depth point
  // buffer (the C malloc'd a fresh copy each level; we reuse one array per depth).
  function selfSimilar(depth, x1, y1, x2, y2, scratch) {
    if (depth === 0) {
      const deltaX = drawMaxX - drawMinX;
      const deltaY = drawMaxY - drawMinY;
      const colorIndex = Math.floor((lineCount * palette.length) / totalLines);
      lineCount++;
      if (plotMaxX < x1) plotMaxX = x1;
      if (plotMaxX < x2) plotMaxX = x2;
      if (plotMaxY < y1) plotMaxY = y1;
      if (plotMaxY < y2) plotMaxY = y2;
      if (plotMinX > x1) plotMinX = x1;
      if (plotMinX > x2) plotMinX = x2;
      if (plotMinY > y1) plotMinY = y1;
      if (plotMinY > y2) plotMinY = y2;
      // Map plot space to device pixels (y flips: the C uses maximum_y - y).
      const sx1 = ((x1 - drawMinX) / deltaX) * W;
      const sy1 = ((drawMaxY - y1) / deltaY) * H;
      const sx2 = ((x2 - drawMinX) / deltaX) * W;
      const sy2 = ((drawMaxY - y2) / deltaY) * H;
      let ci = colorIndex % palette.length;
      if (ci < 0) ci += palette.length;
      paths[ci].moveTo(sx1, sy1);
      paths[ci].lineTo(sx2, sy2);
      return true;
    }

    const next = scratch[depth];
    realign(x1, y1, x2, y2, points, next);
    // The C bails (instead of asserting) if the realigned chain doesn't land back
    // on (x2,y2) — a degenerate generator. Drop the whole fractal rather than
    // recurse forever / overshoot.
    if (
      Math.abs(x2 - next[segmentCount - 1].x) >= EPSILON ||
      Math.abs(y2 - next[segmentCount - 1].y) >= EPSILON
    ) {
      return false;
    }

    let x = x1;
    let y = y1;
    for (let i = 0; i < segmentCount; i++) {
      const nx = next[i].x;
      const ny = next[i].y;
      if (!selfSimilar(depth - 1, x, y, nx, ny, scratch)) return false;
      x = nx;
      y = ny;
    }
    return true;
  }

  // --- per-frame draw (one depth level), the C's ccurve_draw body --------------

  // Allocate the per-depth scratch point buffers once for the current generator.
  let scratch;
  function allocScratch() {
    scratch = new Array(iterations + 1);
    for (let d = 0; d <= iterations; d++) {
      scratch[d] = new Array(segmentCount);
      for (let i = 0; i < segmentCount; i++) scratch[d][i] = { x: 0, y: 0 };
    }
  }

  // Begin a brand-new fractal: pick a generator, normalize it, set the depth
  // budget, and (usually) jitter the endpoints. The C's draw_index==0 branch.
  function newFractal() {
    segmentCount = LENGTHS[rand(LENGTHS.length)];
    segments = new Array(segmentCount);
    selectPattern(segmentCount, segments);

    points = new Array(segmentCount);
    for (let i = 0; i < segmentCount; i++) points[i] = { x: 0, y: 0 };
    normalizedPlot();

    const limit = Math.max(3, Math.round(config.limit));
    iterations = Math.floor(Math.log(limit) / Math.log(segmentCount));
    if (iterations < 1) iterations = 1;
    allocScratch();

    // 2/3 of the time, nudge the base segment endpoints so successive fractals
    // drift around instead of all starting from the same line.
    if (rand(3) !== 0) {
      const factor = 0.45;
      drawX1 += randomDouble(-factor, factor);
      drawY1 += randomDouble(-factor, factor);
      drawX2 += randomDouble(-factor, factor);
      drawY2 += randomDouble(-factor, factor);
    }
  }

  // Render the current fractal at depth `drawIndex`, then re-fit the view bounds
  // for the next (deeper) frame. Returns ms to wait before the next step.
  function step() {
    if (drawIndex === 0) newFractal();

    // Fresh frame: clear, reset extents and colour buckets.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    lineCount = 0;
    totalLines = Math.pow(segmentCount, drawIndex);
    plotMaxX = -1000.0;
    plotMaxY = -1000.0;
    plotMinX = 1000.0;
    plotMinY = 1000.0;

    const n = palette.length;
    paths = new Array(n);
    for (let i = 0; i < n; i++) paths[i] = new Path2D();

    const ok = selfSimilar(drawIndex, drawX1, drawY1, drawX2, drawY2, scratch);

    if (ok) {
      for (let i = 0; i < n; i++) {
        ctx.strokeStyle = palette[i];
        ctx.stroke(paths[i]);
      }
    }

    // Re-fit the view to the plotted extents (+20% margin), then correct aspect
    // so the next frame stays framed in the window.
    let deltaX = plotMaxX - plotMinX;
    let deltaY = plotMaxY - plotMinY;
    // Guard a degenerate (zero-extent) curve, e.g. a perfectly axis-aligned
    // depth-0 line: a zero delta would collapse drawMin/Max and make the NEXT
    // frame's screen mapping divide by zero. The C divides by zero here and
    // relies on X clipping the garbage; we keep the mapping finite instead.
    if (deltaX < EPSILON) deltaX = EPSILON;
    if (deltaY < EPSILON) deltaY = EPSILON;
    drawMaxX = plotMaxX + deltaX * 0.2;
    drawMaxY = plotMaxY + deltaY * 0.2;
    drawMinX = plotMinX - deltaX * 0.2;
    drawMinY = plotMinY - deltaY * 0.2;
    deltaX = drawMaxX - drawMinX;
    deltaY = drawMaxY - drawMinY;
    if (deltaY / deltaX > H / W) {
      const newDeltaX = (deltaY * W) / H;
      drawMinX -= (newDeltaX - deltaX) / 2.0;
      drawMaxX += (newDeltaX - deltaX) / 2.0;
    } else {
      const newDeltaY = (deltaX * H) / W;
      drawMinY -= (newDeltaY - deltaY) / 2.0;
      drawMaxY += (newDeltaY - deltaY) / 2.0;
    }

    // If the fractal bailed mid-build, abandon it and start a new one next step.
    if (!ok) {
      drawIndex = 0;
      return 0;
    }

    drawIndex++;
    if (drawIndex >= iterations) {
      drawIndex = 0;
      return Math.max(0, config.delay * 1000);     // linger on the finished image
    }
    return Math.max(0, config.pause * 1000);        // brief hold between depths
  }

  // Begin a fresh sequence with the current config. Resets the C's persistent
  // view/endpoint state to its ccurve_init values so the first fractal frames up
  // the same way every time.
  function reset() {
    buildPalette();
    drawIndex = 0;
    drawX1 = 0.0;
    drawY1 = 0.0;
    drawX2 = 1.0;
    drawY2 = 0.0;
    drawMaxX = 1.20;
    drawMaxY = 0.525;
    drawMinX = -0.20;
    drawMinY = -0.525;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    // The C draws a 1-device-px hairline (XDrawLine, default GC line width 0).
    // max(1, dpr) keeps that 1px on standard displays and 1 CSS px on retina.
    ctx.lineWidth = Math.max(1, S);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    nextDelay = 0;
    reset();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Variable-delay loop (boxfit / xspirograph style): step() returns the ms to
  // wait before the next step — config.pause between depth frames, the longer
  // config.delay once a fractal completes — matching the C's "return microseconds
  // until next call". The canvas is repainted inside step(), once per depth.
  const MAX_CATCHUP_STEPS = 4;
  let lastTime = 0;
  let acc = 0;
  let nextDelay = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    acc += now - lastTime;
    lastTime = now;
    // Bound the backlog so a backgrounded tab doesn't burst on refocus — but
    // never below nextDelay, or a long linger pause would never elapse.
    acc = Math.min(acc, nextDelay + 1000);

    let steps = 0;
    while (acc >= nextDelay && steps < MAX_CATCHUP_STEPS) {
      acc -= nextDelay;
      nextDelay = step();
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
    reinit() { nextDelay = 0; reset(); },   // fresh sequence with the current config
    config,
    params,
  };
}
