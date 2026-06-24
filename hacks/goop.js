// goop.js — goop packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's goop.c (Jamie Zawinski, 1997). Several big amoeba-like
// blobs drift around the screen and slowly throb. Each blob is a closed spline
// through N control points that orbit a moving centre; every control point has
// its own radius that grows and shrinks (the throb) and the whole blob rotates,
// so the outline morphs organically. Blobs bounce off the screen edges and
// overlap translucently — the classic lava-lamp "goop".
//
// Rendering: SPARSE vector. A handful of large translucent shapes redrawn in
// full every frame (clear to black, then fill every blob). Each blob outline is
// a closed uniform cubic B-spline; the C flattens it to a polygon with X11's
// recursive bezier subdivision, but canvas can draw the same curve directly with
// bezierCurveTo (one cubic per control-point section), which is smoother and
// cheaper. The translucent-overlap look is the whole point — see goop.md for the
// blend choice (canvas has no XOR raster op; the C's default mode is not XOR).

export const title = 'goop';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Translucent amoeba-like blobs wander the screen.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/goop.xml so the config box maps 1:1 to
  // the original. delay is microseconds (xml units). The xml's "count" slider
  // actually drives --planes (number of colour layers); with the unexposed
  // per-layer count fixed at 1, each plane is one blob, so `count` here == the
  // number of distinctly-coloured blobs (xml default 12).
  const config = {
    delay: 12000,          // µs between frames (--delay)
    torque: 0.0075,        // rotational speed (--torque, "Speed")
    count: 12,             // number of blobs / colour planes (--planes, "Blobs")
    elasticity: 0.9,       // how fast control radii deform (--elasticity)
    maxv: 0.5,             // per-blob speed limit, px/frame (--max-velocity)
    mode: 'transparent',   // blend: translucent / additive / xor / opaque (--mode)
  };

  // Ranges/defaults/labels transcribed from hacks/config/goop.xml.
  // live: true  -> the loop reads config every step, so it applies instantly.
  // live: false -> the value sizes the blob array, so a change re-runs init()
  //                via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 12000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'torque', label: 'Speed', type: 'range', min: 0.0002, max: 0.05, step: 0.0002, default: 0.0075, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'count', label: 'Blobs', type: 'range', min: 1, max: 50, step: 1, default: 12, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'elasticity', label: 'Elasticity', type: 'range', min: 0.1, max: 5.0, step: 0.1, default: 0.9, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'maxv', label: 'Speed limit', type: 'range', min: 0.1, max: 3.0, step: 0.1, default: 0.5, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'mode', label: 'Blend', type: 'select', default: 'transparent', live: true, options: [
        { value: 'transparent', label: 'Translucent blobs' },
        { value: 'additive', label: 'Additive (transmitted light)' },
        { value: 'xor', label: 'XOR blobs' },
        { value: 'opaque', label: 'Opaque blobs' },
      ] },
  ];

  const TAU = Math.PI * 2;

  let S = 1;       // devicePixelRatio
  let W, H;        // canvas size, device px (the C's maxx/maxy)
  let blobs;       // array of blob objects
  let colors;      // ['rgb(r,g,b)', ...] one per blob

  // frand(n) -> uniform double in [0, n); the C's frand()/RAND() (RAND is
  // integer in the C, but at these sub-pixel magnitudes float is equivalent).
  const frand = (n) => Math.random() * n;
  const randSign = () => (Math.random() < 0.5 ? 1 : -1);

  // hsv_to_rgb (utils/hsv.c): h in degrees, s,v in [0,1] -> [r,g,b] 0-255.
  // The C emits 16-bit channels (trunc(C * 65535)); an 8-bit display takes the
  // high byte (>> 8). We fold both, matching colormap.js's quantization, so the
  // blob colours line up with the X server's downsample of the original.
  function hsvToRgb(h, s, v) {
    if (s < 0) s = 0; else if (s > 1) s = 1;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    const H = (h % 360) / 60;
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
    const q = (c) => Math.min(255, Math.trunc(c * 65535) >> 8);
    return [q(R), q(G), q(B)];
  }

  // One colour per blob, exactly as goop.c's make_goop layer loop: H random
  // 0-359, S random 30-99%, V random 66-99% (hsv_to_rgb). These are bright but
  // NOT full-saturation rainbow -- the C deliberately floors S at 30% and V at
  // 66%, so the palette is somewhat muted. (On jwxyz/macOS this same loop colours
  // every mode incl. transparent; transparent then drops the alpha to 0xBB.)
  function buildColors(n) {
    colors = new Array(n);
    for (let i = 0; i < n; i++) {
      const H = Math.floor(Math.random() * 360);
      const S = (Math.floor(Math.random() * 70) + 30) / 100;
      const V = (Math.floor(Math.random() * 34) + 66) / 100;
      const [r, g, b] = hsvToRgb(H, S, V);
      colors[i] = `rgb(${r}, ${g}, ${b})`;
    }
  }

  // make_blob: a blob of the given diameter `size` (device px) at a random spot.
  // npoints control points (5..9), each with a signed radius r[i] whose
  // magnitude rides between min_r and max_r and whose sign is its throb
  // direction. Velocities/elasticity scale by S so motion feels the same at any
  // devicePixelRatio (sizes already come from the device-px canvas dims).
  function makeBlob(maxx, maxy, size) {
    const b = {};
    b.max_r = size / 2;
    b.min_r = size / 10;
    if (b.min_r < 5 * S) b.min_r = 5 * S;
    const mid = (b.min_r + b.max_r) / 2;

    b.x = frand(maxx);
    b.y = frand(maxy);

    const maxVel = config.maxv * S;
    b.dx = frand(maxVel) * randSign();
    b.dy = frand(maxVel) * randSign();
    b.th = frand(TAU) * randSign();
    b.npoints = (Math.random() * 5 | 0) + 5;

    b.r = new Float64Array(b.npoints);   // signed control radii
    b.cx = new Float64Array(b.npoints);  // control point x (set by throbBlob)
    b.cy = new Float64Array(b.npoints);  // control point y
    for (let i = 0; i < b.npoints; i++) {
      b.r[i] = (frand(mid) + mid / 2) * randSign();
    }
    return b;
  }

  // throb_blob: place the control points evenly around the perimeter (angle
  // i*frac + |th|, radius |r[i]|) from the blob's current centre, then advance
  // each radius by up to `elasticity` px in its current direction, reversing at
  // the min/max limits (and randomly 1/50 of the time) so each point oscillates.
  function throbBlob(b) {
    const n = b.npoints;
    const frac = TAU / n;
    const elasticity = config.elasticity * S;
    const maxR = b.max_r;
    const minR = b.min_r;
    const thAbs = b.th > 0 ? b.th : -b.th;

    for (let i = 0; i < n; i++) {
      let r = b.r[i];
      let ra = r > 0 ? r : -r;

      // Control point for the spline (uses last frame's radius + this centre).
      b.cx[i] = b.x + ra * Math.cos(i * frac + thAbs);
      b.cy[i] = b.y + ra * Math.sin(i * frac + thAbs);

      // Grow/shrink in the current direction (sign of the stored radius).
      ra += frand(elasticity) * (r > 0 ? 1 : -1);
      r = ra * (r >= 0 ? 1 : -1);

      // Reverse at the radius limits, or randomly 1/50 of the time.
      if ((ra > maxR && r >= 0) || (ra < minR && r < 0)) {
        r = -r;
      } else if ((Math.random() * 50 | 0) === 0) {
        r = -r;
      }
      b.r[i] = r;
    }
  }

  // move_blob: drift by (dx,dy), bounce off the edges (reverse velocity only
  // when crossing a boundary heading outward, so blobs can't escape), randomly
  // perturb + throttle the velocity, and advance/occasionally flip the rotation.
  function moveBlob(b) {
    const maxx = W;
    const maxy = H;
    const maxVel = config.maxv * S;

    b.x += b.dx;
    b.y += b.dy;

    if ((b.x > maxx && b.dx >= 0) || (b.x < 0 && b.dx < 0)) b.dx = -b.dx;
    if ((b.y > maxy && b.dy >= 0) || (b.y < 0 && b.dy < 0)) b.dy = -b.dy;

    // Alter velocity randomly 1/10 of the time, then throttle to the limit.
    if ((Math.random() * 10 | 0) === 0) {
      b.dx += frand(maxVel / 2) * randSign();
      b.dy += frand(maxVel / 2) * randSign();
      if (b.dx > maxVel || b.dx < -maxVel) b.dx /= 2;
      if (b.dy > maxVel || b.dy < -maxVel) b.dy /= 2;
    }

    // Advance rotation by frand(torque), preserving th's sign convention.
    let th = b.th;
    const d = config.torque === 0 ? 0 : frand(config.torque);
    if (th < 0) th = -(th + d);
    else th += d;
    if (th > TAU) th -= TAU;
    else if (th < 0) th += TAU;
    b.th = b.th > 0 ? th : -th;

    // Reverse rotation direction randomly 1/100 of the time.
    if ((Math.random() * 100 | 0) === 0) b.th *= -1;
  }

  // Build the closed-spline outline for a blob as a Path2D. The C computes a
  // closed uniform cubic B-spline through the control points (compute_closed_
  // spline -> calc_section) and flattens it to a polygon; the per-section bezier
  // control points it derives are the standard B-spline->bezier conversion, so
  // we feed them straight to bezierCurveTo (each section's end point equals the
  // next section's start, so the curve is C1-continuous and closes cleanly).
  function buildPath(b) {
    const n = b.npoints;
    const cx = b.cx;
    const cy = b.cy;
    const path = new Path2D();

    // Section 0 start: the B-spline knot point (4*c0 + c[n-1] + c1) / 6.
    path.moveTo(
      (4 * cx[0] + cx[n - 1] + cx[1]) / 6,
      (4 * cy[0] + cy[n - 1] + cy[1]) / 6,
    );

    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      const k2 = (k + 2) % n;
      path.bezierCurveTo(
        (2 * cx[k] + cx[k1]) / 3,             // p1
        (2 * cy[k] + cy[k1]) / 3,
        (2 * cx[k1] + cx[k]) / 3,             // p2
        (2 * cy[k1] + cy[k]) / 3,
        (4 * cx[k1] + cx[k] + cx[k2]) / 6,    // p3 (== next section's start)
        (4 * cy[k1] + cy[k] + cy[k2]) / 6,
      );
    }
    path.closePath();
    return path;
  }

  // Full-frame redraw: clear to black, then fill every blob with the blend the
  // current mode selects. Canvas has no XOR raster op, so 'xor' uses 'difference'
  // (|bg - src|); see goop.md for the full rationale.
  function drawAll() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    let comp = 'source-over';
    let alpha = 1;
    if (config.mode === 'transparent') {
      comp = 'source-over';
      alpha = 0xBB / 0xFF;     // jwxyz/macOS renders transparent goop at alpha 0xBB
    } else if (config.mode === 'additive') {
      comp = 'lighter';        // transmitted light: overlaps brighten toward white
    } else if (config.mode === 'xor') {
      comp = 'difference';     // closest canvas analog to X11 GXxor (overlaps invert)
    } // else 'opaque': source-over, alpha 1

    // XOR is a single-plane (1-bit) mode in the C: every blob is the foreground
    // colour and overlaps toggle. 'difference' with ONE constant colour on black
    // reproduces that exactly (|0-fg|=fg, then |fg-fg|=0); per-blob colours would
    // not. The C's foreground default is yellow.
    const xorFill = 'rgb(255, 255, 0)';
    const useXorFill = config.mode === 'xor';

    ctx.globalCompositeOperation = comp;
    ctx.globalAlpha = alpha;
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      ctx.fillStyle = useXorFill ? xorFill : b.color;
      ctx.fill(buildPath(b));
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // One frame: move + throb every blob (which also sets its control points),
  // then redraw the whole scene.
  function step() {
    for (let i = 0; i < blobs.length; i++) {
      moveBlob(blobs[i]);
      throbBlob(blobs[i]);
    }
    drawAll();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    const n = Math.max(1, Math.round(config.count));
    buildColors(n);

    // Blob diameter range (the C's make_layer): up to min(W,H)/2, at least 2/3
    // of that; bumped 10x for a tiny window so blobs stay visible.
    let blobMax = Math.min(W, H) / 2;
    if (W < 100 || H < 100) blobMax *= 10;
    const blobMin = Math.floor((blobMax * 2) / 3);

    blobs = new Array(n);
    for (let i = 0; i < n; i++) {
      const j = blobMax - blobMin;
      const size = (j > 0 ? Math.floor(Math.random() * j) : 0) + blobMin;
      const b = makeBlob(W, H, size);
      b.color = colors[i];
      // Seed the control points so the first drawn frame is a proper blob.
      throbBlob(b);
      blobs[i] = b;
    }

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

  // Drive off requestAnimationFrame but keep the original pace: one step() per
  // config.delay, banking leftover time so the speed is the same at any refresh
  // rate. Cap catch-up so a backgrounded tab doesn't fire a burst on refocus.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay goop runs 45.4 fps, while the port
  // at the stock 12000 us ran ~83 fps (1.8x fast). 12000 + 10026 = 22026 us ->
  // 45 fps, matching the live binary. A calibration, not a tuning knob (the
  // delay slider still maps 1:1 to the xml resource).
  const OVERHEAD = 10026;
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

  // Rebuild the blobs after a non-live config change (count) and clear the
  // canvas, then re-seed via init().
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
    reinit,   // rebuild the blobs, keeping the current config
    config,   // host renders the config box from these
    params,
  };
}
