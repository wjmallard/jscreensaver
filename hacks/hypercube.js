// hypercube.js — hypercube packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's hypercube.c (Joe Keane, Fritz Mueller, Jamie
// Zawinski; 1992). https://www.jwz.org/xscreensaver/
//
// A wireframe tesseract (4D hypercube): 16 vertices, 32 edges. The shape is
// held as four 4D basis vectors (a, b, c, d); each vertex is one of the 16
// signed sums (+-a +-b +-c +-d), i.e. a corner at (+-1, +-1, +-1, +-1) in 4D.
// Every step the basis is rotated a little in up to six independent 4D planes
// (xy, xz, yz, xw, yw, zw), then each vertex is projected 4D -> 2D: the w
// coordinate is dropped (orthographic) and the remaining (x, y, z) get a 1/z
// perspective divide. The 32 edges connect the vertex pairs that differ in
// exactly one of the four binary coordinates; they are coloured in 8 groups
// (one per face/cube), exactly as the C's line_table does. As the basis turns,
// the w dimension sweeps into view and the cube-within-a-cube structure appears.
//
// Rendering: full repaint per frame onto a cleared black canvas — see the
// XOR->repaint deviation in hypercube.md. The 32 edges are bucketed by colour
// (8 Path2D-style strokes/frame) like braid. Sparse vector ops (32 short
// lines) — far cheaper than any per-pixel blit. See [[scooter]] (rotating
// projected geometry) and [[braid]] (colour-bucketed stroking).

export const title = 'hypercube';

export const info = {
  author: 'Joe Keane, Fritz Mueller, Jamie Zawinski',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.10. It has been replaced by the more general "Polytopes" screen saver, which can display this object as well as others.\n\nThis displays 2D projections of the sequence of 3D objects which are the projections of the 4D analog to the cube: as a square is composed of four lines, each touching two others; and a cube is composed of six squares, each touching four others; a hypercube is composed of eight cubes, each touching six others. To make it easier to visualize the rotation, it uses a different color for the edges of each face. Don\'t think about it too long, or your brain will melt.\n\nhttps://en.wikipedia.org/wiki/Hypercube\nhttps://en.wikipedia.org/wiki/Tesseract\nhttps://en.wikipedia.org/wiki/Regular_polytope',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/hypercube.xml so the config box maps
  // 1:1 with the original. Rotation speeds are in the C's units (0.001 rad per
  // step, applied via ANGLE_SCALE below); observer-z is the viewer distance.
  const config = {
    delay: 10000,     // \u00B5s between steps (--delay, xml/stock 10000)
    z: 3.0,           // observer-z: viewer distance; bigger = flatter (--observer-z)
    xy: 3,            // rotation speed in the xy plane (--xy)
    xz: 5,            // rotation speed in the xz plane (--xz)
    yz: 0,            // rotation speed in the yz plane (--yz)
    xw: 0,            // rotation speed in the xw plane (--xw)
    yw: 10,           // rotation speed in the yw plane (--yw)
    zw: 0,            // rotation speed in the zw plane (--zw)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'z', label: 'Zoom', type: 'range', min: 1.125, max: 10.0, step: 0.125, default: 3.0, lowLabel: 'near', highLabel: 'far', live: true },
    { key: 'xy', label: 'XY rotation', type: 'range', min: 0, max: 20, step: 1, default: 3, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'xz', label: 'XZ rotation', type: 'range', min: 0, max: 20, step: 1, default: 5, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'yz', label: 'YZ rotation', type: 'range', min: 0, max: 20, step: 1, default: 0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'xw', label: 'XW rotation', type: 'range', min: 0, max: 20, step: 1, default: 0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'yw', label: 'YW rotation', type: 'range', min: 0, max: 20, step: 1, default: 10, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'zw', label: 'ZW rotation', type: 'range', min: 0, max: 20, step: 1, default: 0, lowLabel: 'slow', highLabel: 'fast', live: true },
  ];

  // Per-step angle = slider value * ANGLE_SCALE radians (verbatim from the C).
  const ANGLE_SCALE = 0.001;

  // The 8 face/cube colours, color0..color7 from hypercube_defaults[] in the C.
  // Each of the 32 edges belongs to exactly one of these 8 groups (the edges of
  // one square face), so the colour encodes the tesseract's structure.
  const COLORS = [
    '#FF00FF',   // 0 magenta
    '#FFFF00',   // 1 yellow
    '#FF9300',   // 2 orange
    '#FF0093',   // 3 pink
    '#00FF00',   // 4 green
    '#8080FF',   // 5 periwinkle
    '#00D0FF',   // 6 cyan-blue
    '#00FFD0',   // 7 cyan-green
  ];

  // The 32 edges, copied verbatim from line_table[] in hypercube.c:
  // { vertex p, vertex q, colour }. Each pair differs in exactly one of the
  // four binary coordinate bits, so this is precisely the tesseract's 32 edges.
  const EDGES = [
    [0, 1, 0],
    [0, 2, 0],
    [1, 3, 0],
    [2, 3, 0],
    [4, 5, 1],
    [4, 6, 1],
    [5, 7, 1],
    [6, 7, 1],
    [0, 4, 4],
    [0, 8, 4],
    [4, 12, 4],
    [8, 12, 4],
    [1, 5, 5],
    [1, 9, 5],
    [5, 13, 5],
    [9, 13, 5],
    [2, 6, 6],
    [2, 10, 6],
    [6, 14, 6],
    [10, 14, 6],
    [3, 7, 7],
    [3, 11, 7],
    [7, 15, 7],
    [11, 15, 7],
    [8, 9, 2],
    [8, 10, 2],
    [9, 11, 2],
    [10, 11, 2],
    [12, 13, 3],
    [12, 14, 3],
    [13, 15, 3],
    [14, 15, 3],
  ];

  // Edge indices grouped by colour, so each frame strokes once per colour
  // bucket (8 strokes) instead of once per edge (braid's idiom).
  const colorBuckets = COLORS.map(() => []);
  for (let i = 0; i < EDGES.length; i++) {
    colorBuckets[EDGES[i][2]].push(i);
  }

  // Per-vertex signs for the four 4D axes (a, b, c, d). Vertex i's sign on axis
  // k is +1 if bit (3 - k) of i is set, else -1 — matching the compute() macro
  // expansion in the C (compute(-,-,-,-,0) .. compute(+,+,+,+,15)).
  const SIGNS = [];
  for (let i = 0; i < 16; i++) {
    SIGNS.push([
      (i & 8) ? 1 : -1,   // a  (bit 3)
      (i & 4) ? 1 : -1,   // b  (bit 2)
      (i & 2) ? 1 : -1,   // c  (bit 1)
      (i & 1) ? 1 : -1,   // d  (bit 0)
    ]);
  }

  let S = 1;            // devicePixelRatio
  let W, H;             // canvas size, device px

  // Projection constants (recomputed each step so Zoom is live), the C's
  // set_sizes(): offsets centre the figure, unitScale folds in the observer
  // distance, twoObserverZ is the perspective denominator's far point.
  let offsetX, offsetY, unitScale, twoObserverZ;

  // The four 4D basis vectors a, b, c, d, each (x, y, z, w). Rotating these is
  // what spins the cube; vertices are signed sums of them.
  const ref = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];

  // Projected screen coords of the 16 vertices, filled by computePoints().
  const px = new Float64Array(16);
  const py = new Float64Array(16);

  // Rotate all four basis vectors in the (dim0, dim1) plane by a fixed angle.
  // Mirrors the C's rotates()/rotate() macros: new_u = u*cos + v*sin,
  // new_v = v*cos - u*sin. No-op when the angle is 0 (sin == 0), as in the C.
  function rotatePlane(dim0, dim1, angle) {
    if (angle === 0) return;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    for (let k = 0; k < 4; k++) {
      const v = ref[k];
      const u0 = v[dim0];
      const u1 = v[dim1];
      v[dim0] = u0 * cosA + u1 * sinA;
      v[dim1] = u1 * cosA - u0 * sinA;
    }
  }

  // set_sizes(): bigger observer-z -> flatter (more orthographic) projection;
  // unitScale keeps the figure's on-screen size roughly constant either way.
  function updateProjection() {
    const observerZ = config.z < 1.125 ? 1.125 : config.z;
    const minDim = W < H ? W : H;
    const variance = Math.sqrt(observerZ * observerZ - 1.0);
    offsetX = 0.5 * (W - 1);
    offsetY = 0.5 * (H - 1);
    unitScale = 0.4 * minDim * variance;
    twoObserverZ = 2.0 * observerZ;
  }

  // Project the 16 vertices to the screen. Each vertex is the signed sum of the
  // four (rotated) basis vectors; the w component is dropped (orthographic 4D
  // -> 3D), then (x, y) get a 1/z perspective divide. twoObserverZ - sumZ is
  // always > 0 (sumZ in [-2, 2], twoObserverZ >= 2.25), so no divide-by-zero.
  function computePoints() {
    const ax = ref[0][0], ay = ref[0][1], az = ref[0][2];
    const bx = ref[1][0], by = ref[1][1], bz = ref[1][2];
    const cx = ref[2][0], cy = ref[2][1], cz = ref[2][2];
    const dx = ref[3][0], dy = ref[3][1], dz = ref[3][2];
    for (let i = 0; i < 16; i++) {
      const sa = SIGNS[i][0], sb = SIGNS[i][1], sc = SIGNS[i][2], sd = SIGNS[i][3];
      const sumX = sa * ax + sb * bx + sc * cx + sd * dx;
      const sumY = sa * ay + sb * by + sc * cy + sd * dy;
      const sumZ = sa * az + sb * bz + sc * cz + sd * dz;
      const mul = unitScale / (twoObserverZ - sumZ);
      px[i] = sumX * mul + offsetX;
      py[i] = sumY * mul + offsetY;
    }
  }

  // One simulation+draw step: rotate the basis in the six planes (live speeds),
  // recompute the projection (live Zoom) and vertices, then full-repaint the
  // wireframe, one stroke per colour bucket.
  function step() {
    rotatePlane(0, 1, config.xy * ANGLE_SCALE);
    rotatePlane(0, 2, config.xz * ANGLE_SCALE);
    rotatePlane(1, 2, config.yz * ANGLE_SCALE);
    rotatePlane(0, 3, config.xw * ANGLE_SCALE);
    rotatePlane(1, 3, config.yw * ANGLE_SCALE);
    rotatePlane(2, 3, config.zw * ANGLE_SCALE);

    updateProjection();
    computePoints();

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    ctx.lineWidth = Math.max(1, 1.5 * S);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let c = 0; c < COLORS.length; c++) {
      const bucket = colorBuckets[c];
      ctx.strokeStyle = COLORS[c];
      ctx.beginPath();
      for (let j = 0; j < bucket.length; j++) {
        const e = EDGES[bucket[j]];
        const p = e[0], q = e[1];
        ctx.moveTo(px[p], py[p]);
        ctx.lineTo(px[q], py[q]);
      }
      ctx.stroke();
    }
  }

  // Seed the basis at the IDENTITY orientation, exactly as the C does (its
  // ref_a..ref_d start as the four unit axes -- hypercube.c ~197-200 -- with all
  // rotation angles 0). So frame 1 is the face-on tesseract (the iconic nested
  // cube-within-a-cube under the w-perspective) and it opens up from there as
  // the speed sliders rotate it, matching the original's start rather than a
  // pre-tilted pose.
  function seedOrientation() {
    ref[0][0] = 1; ref[0][1] = 0; ref[0][2] = 0; ref[0][3] = 0;
    ref[1][0] = 0; ref[1][1] = 1; ref[1][2] = 0; ref[1][3] = 0;
    ref[2][0] = 0; ref[2][1] = 0; ref[2][2] = 1; ref[2][3] = 0;
    ref[3][0] = 0; ref[3][1] = 0; ref[3][2] = 0; ref[3][3] = 1;
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    seedOrientation();
    updateProjection();
    computePoints();

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

  // rAF lag-accumulator loop: one step() per config.delay (µs in the xml),
  // banking leftover time so the pace is the same at any refresh rate; cap
  // catch-up so a backgrounded tab can't burst. Each step() does a full
  // clear+repaint, so we never draw more than we step.
  // OVERHEAD: the live binary's *delay is a sleep FLOOR; its real frame is
  // delay + per-step compute. The -fps overlay read 56.7 / 60.4 fps at Load
  // 43.3 / 39.6 % (delay-bound) = ~17097 µs/frame = 10000 floor + 7097 compute,
  // so the faithful per-step pace is (delay + 7097)/1000 ms (matches live ~58/s).
  const OVERHEAD = 7097;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, Math.max(delayMs, 1) * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (clears the canvas and resets the figure to
  // its seed orientation).
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
