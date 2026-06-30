// qix.js — qix packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's qix.c (Jamie Zawinski, 1992).
// https://www.jwz.org/xscreensaver/
//
// Bounces a polygonal "line" (a ring of `poly` vertices, default 2 = a plain
// segment) around the screen: each frame every vertex advances by its velocity
// and reflects off the walls, the new polygon is drawn, and the oldest of a
// fixed-length trailing queue is erased — the classic Qix ribbon. With `solid`
// (default) and a 2-vertex line, consecutive frames are joined into filled quads
// for the solid-ribbon look; `hollow` strokes the polygon outline instead.
//
// Two colour models, matching qix.c's defaults:
//   - TRANSPARENT (the stock default, `*transparent: true`, `*count: 4`): each
//     qix is one FIXED random colour and the `count` ribbons OVERLAP and MIX.
//     On the live X11/XQuartz binary's TrueColor visual this is done with random
//     RGB-bit plane masks (alpha.c, the `!cmap` branch): drawing ORs the qix's
//     colour bits into the framebuffer, erasing ANDs them out, so overlaps are a
//     per-channel bitwise OR and an erasing ribbon reveals whatever lies under
//     it. Canvas 2D can't bitwise-OR, so the port keeps a software RGBA buffer
//     and rasterises into it (OR to draw, AND-NOT to erase), blitting the dirty
//     rect each step — the quasicrystal/crystal-class software-raster approach.
//   - HUE-CYCLE (`transparent` off): each qix is one opaque colour whose hue
//     shifts by `colorShift` each frame, drawn with sparse canvas vector ops.
//     This is the C's non-transparent path.
//
// The bounce/trail geometry (ring buffer, wiggle, draw-newest / erase-oldest) is
// shared by both models — far cheaper than clearing and redrawing the whole
// queue every frame, and it keeps the older trail intact.

export const title = 'qix';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Bounces a series of line segments around the screen with various presentations.\n\nhttps://en.wikipedia.org/wiki/Qix',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/qix.xml so the config box maps 1:1
  // (incl. the stock count:4 and transparent:true); `delay` is the stock 10 ms.
  const config = {
    delay: 10000,    // \u00B5s between steps (--delay)
    segments: 250,   // trail length: polygons kept on screen (--segments)
    spread: 8,       // max per-vertex velocity, logical px/step (--spread)
    colorShift: 3,   // hue degrees added per frame, hue-cycle mode only (--color-shift)
    size: 200,       // max extent between the 2 points; only for poly=2 (--size)
    poly: 2,         // vertices per polygon; 2 = a line segment (--poly)
    count: 4,        // number of independent qixes (--count)
    fill: 'solid',   // 'solid' = fill quads between frames (poly=2) vs. 'hollow' outline (--solid/--hollow)
    motion: 'linear', // 'linear' = clean bounces vs. 'random' velocity jitter (--linear/--random)
    gravity: false,  // pull every vertex downward each step (--gravity)
    transparent: true, // true = fixed-colour ribbons that overlap/mix (stock default); false = hue-cycle (--transparent/--non-transparent)
  };

  // live: true  -> the loop reads config every step (applies instantly).
  // live: false -> the value sizes the queue / vertex count / qix count, so a
  //                change re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'segments', label: 'Segments', type: 'range', min: 10, max: 500, step: 10, default: 250, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'spread', label: 'Density', type: 'range', min: 1, max: 50, step: 1, default: 8, invert: true, lowLabel: 'sparse', highLabel: 'dense', live: true },
    { key: 'colorShift', label: 'Color contrast', type: 'range', min: 0, max: 25, step: 1, default: 3, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Count', type: 'range', min: 1, max: 12, step: 1, default: 4, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'size', label: 'Max size', type: 'range', min: 50, max: 1000, step: 10, default: 200, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'poly', label: 'Poly corners', type: 'range', min: 2, max: 24, step: 1, default: 2, lowLabel: 'line', highLabel: 'many', live: false },
    { key: 'fill', label: 'Fill', type: 'select', options: [
        { value: 'solid', label: 'Solid objects' },
        { value: 'hollow', label: 'Line segments' },
      ], default: 'solid', live: false },
    { key: 'motion', label: 'Motion', type: 'select', options: [
        { value: 'linear', label: 'Linear motion' },
        { value: 'random', label: 'Random motion' },
      ], default: 'linear', live: true },
    { key: 'gravity', label: 'Gravity', type: 'checkbox', default: false, live: true },
    { key: 'transparent', label: 'Transparent', type: 'checkbox', default: true, live: false },
  ];

  const MAXPOLY = 24;     // hard cap on vertices (the C's MAXPOLY is 16)
  const GRAVITY = 0.5;    // dy added per step under gravity (the C adds 3 in <<6 units ~= 0.05 px; bumped to read)
  // Per-step pacing overhead (microseconds) added to the stock delay floor,
  // measured off the live binary's -fps overlay (Batch 1G, retained here): the
  // live runs ~50-54 fps at Load ~50% (delay-bound). The TRANSPARENT mode -- now
  // the default -- reads 50.5 fps (sleep slice 10000 = the stock delay), so
  // OVERHEAD = round(1e6/50.5) - 10000 = 9802, calibrated to the DEFAULT mode.
  // (The non-transparent hue-cycle alt runs ~54 fps, so it ends up a hair slow
  // with this value -- negligible.) delay is only a floor, so without OVERHEAD
  // the ribbon swept ~1.8x too fast. See qix.md.
  const OVERHEAD = 9802;

  let S = 1;              // devicePixelRatio
  let W, H;               // canvas size, device px
  let maxSpread;          // velocity clamp, device px (config.spread * S)
  let maxSize;            // extent clamp, device px (config.size * S); 0 = off
  let npoly;              // effective vertices per polygon (after constraints)
  let nlines;             // queue length (== config.segments)
  let solid;              // effective solid flag (forced off when npoly > 2)
  let transparent;        // effective transparent flag (fixed-colour OR-mix vs hue-cycle)
  let qixes;              // array of independent qix states
  let img = null;         // ImageData over the whole canvas (transparent mode only)
  let buf = null;         // img.data — the software RGBA framebuffer we OR/AND-NOT into

  function nrand(n) {
    return Math.floor(Math.random() * n);
  }

  // hsv_to_rgb (utils/hsv.c) -> an 'rgb(r,g,b)' string. h in degrees, s,v in
  // [0,1]. The C runs every qix colour through hsv_to_rgb (NOT hsl), so the
  // port must too: the two spaces only coincide at s=v=1. The X server keeps
  // 16-bit channels (trunc(C*65535)) and displays the top 8 bits, so the >>8
  // downsample matches the live binary's colours exactly.
  function hsvColor(h, s, v) {
    if (s < 0) s = 0; else if (s > 1) s = 1;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    const H = (((h % 360) + 360) % 360) / 60;
    const i = Math.trunc(H);
    const f = H - i;
    const p1 = v * (1 - s);
    const p2 = v * (1 - s * f);
    const p3 = v * (1 - s * (1 - f));
    let R, G, B;
    if      (i === 0) { R = v;  G = p3; B = p1; }
    else if (i === 1) { R = p2; G = v;  B = p1; }
    else if (i === 2) { R = p1; G = v;  B = p3; }
    else if (i === 3) { R = p1; G = p2; B = v;  }
    else if (i === 4) { R = p3; G = p1; B = v;  }
    else              { R = v;  G = p1; B = p2; }
    const c8 = (x) => (Math.trunc(x * 65535) >> 8);
    return `rgb(${c8(R)}, ${c8(G)}, ${c8(B)})`;
  }

  // Seed one qix: a ring buffer of `nlines` frames, each frame holding `npoly`
  // vertices (x, y, dx, dy). Frame 0 is randomised; every other frame is a copy
  // of it (the C's init_one_qix), so the trail starts collapsed at one polygon
  // and unfurls as the simulation runs.
  function initOneQix() {
    const frames = new Array(nlines);
    for (let i = 0; i < nlines; i++) {
      frames[i] = {
        x: new Float64Array(npoly),
        y: new Float64Array(npoly),
        dx: new Float64Array(npoly),
        dy: new Float64Array(npoly),
        dead: true,
      };
    }

    const f0 = frames[0];
    if (maxSize === 0) {
      for (let i = 0; i < npoly; i++) {
        f0.x[i] = nrand(W);
        f0.y[i] = nrand(H);
      }
    } else {
      // poly == 2: anchor point 0 anywhere, point 1 a bounded offset away.
      f0.x[0] = nrand(W);
      f0.y[0] = nrand(H);
      f0.x[1] = Math.min(f0.x[0] + nrand(maxSize / 2), W);
      f0.y[1] = Math.min(f0.y[0] + nrand(maxSize / 2), H);
    }
    for (let i = 0; i < npoly; i++) {
      f0.dx[i] = nrand(maxSpread + 1) - maxSpread / 2;
      f0.dy[i] = nrand(maxSpread + 1) - maxSpread / 2;
    }

    // Copy frame 0 into all the others (vertices, velocities, dead flag).
    for (let i = 1; i < nlines; i++) {
      frames[i].x.set(f0.x);
      frames[i].y.set(f0.y);
      frames[i].dx.set(f0.dx);
      frames[i].dy.set(f0.dy);
    }

    return {
      frames,
      fp: 0,                                  // next write slot
      // Per-qix colour, held for the qix's lifetime; only the hue cycles. The C's
      // init_one_qix seeds each qix with hsv_to_rgb(rand%360, frand(1.0),
      // frand(0.5)+0.5) and add_qline cycles only the hue by colorShift, so the
      // saturation/value stay fixed -- hence the live screen's MIX of vivid,
      // pastel and near-grey ribbons (a low-saturation roll = a grey ribbon),
      // not the uniform full-vivid rainbow the old hsl() gave.
      hue: nrand(360),                        // current frame hue (degrees) -- hue-cycle mode
      sat: Math.random(),                     // frand(1.0)      -> [0,1)
      val: 0.5 + Math.random() * 0.5,         // frand(0.5)+0.5  -> [0.5,1)
      // Transparent mode: one FIXED colour, used both as the colour and as the
      // X11 plane mask. On the live TrueColor visual alpha.c sets each qix's
      // plane_mask = random() & (R|G|B bits) = a uniformly random 24-bit RGB
      // value (alpha.c:178); drawing ORs these bits in, erasing ANDs them out.
      r: nrand(256),
      g: nrand(256),
      b: nrand(256),
    };
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    nlines = Math.max(2, Math.round(config.segments));
    maxSpread = Math.max(1, config.spread) * S;
    solid = config.fill === 'solid';
    transparent = !!config.transparent;

    // Constraint resolution, straight from qix_init():
    //   - solid forces a 2-vertex polygon (the quad fill needs exactly 2 points);
    //   - >2 vertices forces size off (the extent clamp is a 2-point notion).
    npoly = Math.max(2, Math.min(MAXPOLY, Math.round(config.poly)));
    if (solid) npoly = 2;
    maxSize = config.size > 0 ? config.size * S : 0;
    if (npoly > 2) maxSize = 0;

    const count = Math.max(1, Math.round(config.count));
    qixes = [];
    for (let i = 0; i < count; i++) qixes.push(initOneQix());

    if (transparent) {
      // Software framebuffer for the OR/AND-NOT plane-mask compositing.
      img = ctx.createImageData(W, H);
      buf = img.data;
      clearBuffer();
    } else {
      img = null;
      buf = null;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ---- transparent (plane-mask) software rasteriser -------------------------
  // The framebuffer holds the X11 pixel bits directly: draw = OR the qix's
  // colour bits in (so overlaps mix as a per-channel bitwise OR), erase = AND
  // the bits out (revealing any other qix underneath, never forcing black).

  function clearBuffer() {
    buf.fill(0);
    for (let i = 3; i < buf.length; i += 4) buf[i] = 255; // opaque
    ctx.putImageData(img, 0, 0);
  }

  // Even-odd scanline fill of an n-point polygon into buf, OR (draw) or AND-NOT
  // (erase). Same routine + convention for both, so an erase exactly clears the
  // pixels its earlier draw set (see Correctness in qix.md).
  function fillPolyOp(pts, n, r, g, b, erase) {
    const nr = ~r & 255, ng = ~g & 255, nb = ~b & 255;
    let ymin = Infinity, ymax = -Infinity;
    for (let k = 0; k < n; k++) { const y = pts[k].y; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
    let y0 = Math.ceil(ymin - 0.5); if (y0 < 0) y0 = 0;
    let y1 = Math.floor(ymax - 0.5); if (y1 > H - 1) y1 = H - 1;
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      const yc = y + 0.5;
      xs.length = 0;
      for (let k = 0; k < n; k++) {
        const a = pts[k], c = pts[(k + 1) % n];
        const ay = a.y, cy = c.y;
        if ((ay <= yc && cy > yc) || (cy <= yc && ay > yc))
          xs.push(a.x + ((yc - ay) / (cy - ay)) * (c.x - a.x));
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      const rowBase = y * W * 4;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let xa = Math.ceil(xs[k] - 0.5), xb = Math.ceil(xs[k + 1] - 0.5) - 1;
        if (xa < 0) xa = 0;
        if (xb > W - 1) xb = W - 1;
        for (let x = xa; x <= xb; x++) {
          const idx = rowBase + x * 4;
          if (erase) { buf[idx] &= nr; buf[idx + 1] &= ng; buf[idx + 2] &= nb; }
          else { buf[idx] |= r; buf[idx + 1] |= g; buf[idx + 2] |= b; }
        }
      }
    }
  }

  // Thick (S-px) Bresenham line into buf, OR/AND-NOT — for hollow + transparent.
  function drawLineOp(x0, y0, x1, y1, r, g, b, erase) {
    const nr = ~r & 255, ng = ~g & 255, nb = ~b & 255;
    const t = Math.max(1, Math.round(S));
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      for (let oy = 0; oy < t; oy++) {
        const yy = y0 + oy;
        if (yy < 0 || yy >= H) continue;
        const rowBase = yy * W * 4;
        for (let ox = 0; ox < t; ox++) {
          const xx = x0 + ox;
          if (xx < 0 || xx >= W) continue;
          const idx = rowBase + xx * 4;
          if (erase) { buf[idx] &= nr; buf[idx + 1] &= ng; buf[idx + 2] &= nb; }
          else { buf[idx] |= r; buf[idx + 1] |= g; buf[idx + 2] |= b; }
        }
      }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function polyBBox(pts, n) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const p = pts[k];
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    return { x0, y0, x1, y1 };
  }

  function unionBB(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
      x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
    };
  }

  // Blit only the changed rectangle (padded 1px for the line width / rounding).
  function blitBB(bb) {
    if (!bb) return;
    let x0 = Math.floor(bb.x0) - 1, y0 = Math.floor(bb.y0) - 1;
    let x1 = Math.ceil(bb.x1) + 1, y1 = Math.ceil(bb.y1) + 1;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > W - 1) x1 = W - 1;
    if (y1 > H - 1) y1 = H - 1;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w <= 0 || h <= 0) return;
    ctx.putImageData(img, 0, 0, x0, y0, w, h);
  }

  // Draw/erase one polygon frame into the software buffer with qix q's fixed
  // colour; returns the affected bbox (or null if nothing was drawn).
  function drawFrameBuffer(frame, prev, q, erase) {
    if (solid) {
      if (!prev || prev.dead) return null;
      const pts = [
        { x: frame.x[0], y: frame.y[0] },
        { x: frame.x[1], y: frame.y[1] },
        { x: prev.x[1], y: prev.y[1] },
        { x: prev.x[0], y: prev.y[0] },
      ];
      fillPolyOp(pts, 4, q.r, q.g, q.b, erase);
      return polyBBox(pts, 4);
    }
    const pts = [];
    for (let i = 0; i < npoly; i++) pts.push({ x: frame.x[i], y: frame.y[i] });
    for (let i = 0; i < npoly; i++) {
      const a = pts[i], c = pts[(i + 1) % npoly];
      drawLineOp(a.x, a.y, c.x, c.y, q.r, q.g, q.b, erase);
    }
    return polyBBox(pts, npoly);
  }

  // Advance one vertex coordinate by its velocity and reflect off [0, max].
  // Returns the post-bounce [point, delta]. Mirrors the C's `wiggle` macro:
  // optional velocity jitter (random motion), clamp the velocity to ±maxSpread,
  // step, then on a wall hit pin to the wall and reflect (point += 2*|delta|).
  function wiggle(point, delta, max) {
    if (config.motion === 'random') {
      delta += (Math.random() * (2 * S) - S);   // C: rand%(1<<(SCALE+1)) - (1<<SCALE)
    }
    if (delta > maxSpread) delta = maxSpread;
    else if (delta < -maxSpread) delta = -maxSpread;
    point += delta;
    if (point < 0) {
      delta = -delta;
      point = delta * 2;            // point was set to 0, then += delta<<1
    } else if (point > max) {
      delta = -delta;
      point = max + delta * 2;      // point was set to max, then += delta<<1
    }
    return [point, delta];
  }

  // Draw (or erase, when ctx.fillStyle/strokeStyle is black) one polygon frame.
  // Solid mode fills the quad between this frame and `prev` (the classic ribbon);
  // hollow mode strokes the closed polygon outline.
  function drawFrame(frame, prev, paint) {
    if (solid) {
      if (!prev || prev.dead) return;        // no quad without a partner frame
      ctx.fillStyle = paint;
      ctx.beginPath();
      ctx.moveTo(frame.x[0], frame.y[0]);
      ctx.lineTo(frame.x[1], frame.y[1]);
      ctx.lineTo(prev.x[1], prev.y[1]);
      ctx.lineTo(prev.x[0], prev.y[0]);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.strokeStyle = paint;
      ctx.lineWidth = Math.max(1, S);
      ctx.beginPath();
      ctx.moveTo(frame.x[0], frame.y[0]);
      for (let i = 1; i < npoly; i++) ctx.lineTo(frame.x[i], frame.y[i]);
      ctx.closePath();
      ctx.stroke();
    }
  }

  // One step for one qix (the C's qix1 + add_qline + free_qline): erase the
  // polygon about to be overwritten, build the new polygon from the previous
  // frame's vertices (bounced, then coloured per the active model — fixed
  // OR-mask in transparent mode, cycling hue otherwise), draw it, advance fp.
  function stepQix(q) {
    const frames = q.frames;
    const fp = q.fp;
    const ofp = (fp - 1 + nlines) % nlines;      // previous (source) frame
    const old = frames[fp];                      // oldest frame, being recycled
    const oldPrev = frames[(fp + 1) % nlines];   // its solid-quad partner
    let bb = null;                               // transparent-mode dirty rect

    // Erase the outgoing polygon (the C's free_qline). Skip while the trail is
    // still collapsed on its seed frame (dead), so we don't erase what we
    // haven't drawn yet. Transparent: AND the qix's bits out of the buffer
    // (revealing any qix underneath); hue-cycle: repaint it black.
    if (!old.dead) {
      if (transparent) bb = unionBB(bb, drawFrameBuffer(old, oldPrev, q, true));
      else drawFrame(old, oldPrev, '#000');
    }

    // Build the new frame from the previous one (the C's add_qline).
    const src = frames[ofp];
    const f = frames[fp];
    f.x.set(src.x);
    f.y.set(src.y);
    f.dx.set(src.dx);
    f.dy.set(src.dy);

    if (config.gravity) {
      for (let i = 0; i < npoly; i++) f.dy[i] += GRAVITY * S;
    }

    for (let i = 0; i < npoly; i++) {
      let r = wiggle(f.x[i], f.dx[i], W);
      f.x[i] = r[0];
      f.dx[i] = r[1];
      r = wiggle(f.y[i], f.dy[i], H);
      f.y[i] = r[0];
      f.dy[i] = r[1];
    }

    // Extent clamp for poly == 2 with a max size (the C's max_size block): keep
    // the two endpoints within `maxSize` on each axis.
    if (maxSize) {
      const jitter = () => (config.motion === 'random' ? nrand(maxSpread) : 0);
      if (f.x[0] - f.x[1] > maxSize) f.x[0] = f.x[1] + maxSize - jitter();
      else if (f.x[1] - f.x[0] > maxSize) f.x[1] = f.x[0] + maxSize - jitter();
      if (f.y[0] - f.y[1] > maxSize) f.y[0] = f.y[1] + maxSize - jitter();
      else if (f.y[1] - f.y[0] > maxSize) f.y[1] = f.y[0] + maxSize - jitter();
    }

    // Draw the new polygon. Transparent: OR the qix's fixed colour bits into the
    // buffer, then blit the changed rect. Hue-cycle: cycle the hue by colorShift
    // (the C advances the XColor each frame, holding saturation/value) and paint.
    f.dead = false;
    if (transparent) {
      bb = unionBB(bb, drawFrameBuffer(f, frames[ofp], q, false));
      blitBB(bb);
    } else {
      q.hue = (q.hue + config.colorShift) % 360;
      drawFrame(f, frames[ofp], hsvColor(q.hue, q.sat, q.val));
    }

    q.fp = (fp + 1) % nlines;
  }

  function step() {
    for (const q of qixes) stepQix(q);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced by config.delay + OVERHEAD (µs): run one step()
  // per period, banking leftover time so the speed is identical at any refresh
  // rate. Cap catch-up so a backgrounded tab doesn't burst a run of steps on
  // refocus.
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

  // Rebuild after a non-live config change (clears the canvas, re-seeds).
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
