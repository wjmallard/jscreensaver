// flow.js — flow packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's flow.c (Tim Auckland, 1996-2004), "flow of strange
// bees". https://www.jwz.org/xscreensaver/
//
// A swarm of "bees" flows through the phase space of a 3D strange attractor
// (Lorentz, Rossler, Birkhoff, Duffing, ...). Each bee integrates the chosen
// attractor's ODE with 2nd-order Runge-Kutta, leaving a short trail; the whole
// cloud is viewed through a camera that either orbits the attractor or rides
// along on one of the bees, so the structure slowly tumbles into view. A
// background "discover" search continuously tries random polynomial flows and
// promotes any genuinely strange one it finds; failing that, the mode times out
// and re-seeds with a fresh standard attractor.
//
// Rendering: SPARSE vector path. Each step projects every bee's trail to 2D,
// accumulates the line segments into a per-colour bucket, and (like flow.c's
// double-buffered path) clears the canvas and re-strokes all buckets each frame.
// A handful of strokes (<= ncolors) cover hundreds/thousands of short segments.

import { makeRandomColormapRGB } from './colormap.js';

export const title = 'flow';

export const info = {
  author: 'Tim Auckland',
  description: 'Strange attractors formed of flows in a 3D differential equation phase space. Features the popular attractors described by Lorentz, Roessler, Birkhoff and Duffing, and can discover entirely new attractors by itself.\n\nhttps://en.wikipedia.org/wiki/Attractor#Strange_attractor',
  year: 1996,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/flow.xml so the config box maps 1:1 to
  // the original, at the stock defaults. (`delay` is the xml resource in
  // microseconds; the rAF loop adds OVERHEAD to reproduce the live binary's
  // effective rate -- see flow.md and the framerate-calibration note.)
  const config = {
    delay: 10000,     // \u00B5s between steps (--delay; xml default 10000)
    count: 3000,      // number of bees (--count)
    cycles: 10000,    // steps before a flow times out and re-seeds (--cycles)
    ncolors: 200,     // size of the colour palette (--ncolors)
    size: -10,        // trail-length seed (--size; negative => random taillen)
    rotate: true,     // orbit the attractor (--no-rotate)
    ride: true,       // ride along a bee (--no-ride)
    box: true,        // draw the bounding box (--no-box)
    periodic: true,   // allow periodic attractors (Birkhoff/Duffing) (--no-periodic)
    search: true,     // hunt for brand-new attractors in the background (--no-search)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Count', type: 'range', min: 10, max: 5000, step: 10, default: 3000, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'cycles', label: 'Timeout', type: 'range', min: 0, max: 800000, step: 1000, default: 10000, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'size', label: 'Length of trails', type: 'range', min: -20, max: -2, step: 1, default: -10, lowLabel: 'short', highLabel: 'long', invert: true, live: false },
    { key: 'rotate', label: 'Rotating around attractor', type: 'checkbox', default: true, live: false },
    { key: 'ride', label: 'Ride in the flow', type: 'checkbox', default: true, live: false },
    { key: 'box', label: 'Draw bounding box', type: 'checkbox', default: true, live: true },
    { key: 'periodic', label: 'Periodic attractors', type: 'checkbox', default: true, live: false },
    { key: 'search', label: 'Search for new attractors', type: 'checkbox', default: true, live: true },
  ];

  // --- Constants (verbatim from flow.c) -------------------------------------
  const LOST_IN_SPACE = 2000.0;   // a bee past this on any axis is disabled
  const INITIALSTEP = 0.04;       // RK2 step size before discover() tunes it
  const EYEHEIGHT = 0.005;        // small vertical camera offset (* size)
  const MINTRAIL = 2;             // shortest tail
  const BOX_L = 36;               // number of bounding-box edges
  const N_PARS = 20;              // ODE parameter slots (full cubic / periodic)
  const ORBIT = 0, BEE = 1;       // camera targets

  // Parameter slot names (index into a Par array). SINY overlaps XY (the C does
  // the same -- periodic flows never use XY as an x*y term).
  const C = 0, X = 1, XX = 2, XXX = 3, XXY = 4, XXZ = 5, XY = 6, XYY = 7,
    XYZ = 8, XZ = 9, XZZ = 10, Y = 11, YY = 12, YYY = 13, YYZ = 14, YZ = 15,
    YZZ = 16, Z = 17, ZZ = 18, ZZZ = 19;
  const SINY = XY;

  // Box corners (normalised) and the edges joining them, verbatim from flow.c.
  const BOX = [
    [1, 1, 1], [1, 1, -1], [1, -1, -1], [1, -1, 1],
    [-1, 1, 1], [-1, 1, -1], [-1, -1, -1], [-1, -1, 1],
    [1, 0.8, 0.8], [1, 0.8, -0.8], [1, -0.8, -0.8], [1, -0.8, 0.8],
    [0.8, 1, 0.8], [0.8, 1, -0.8], [-0.8, 1, -0.8], [-0.8, 1, 0.8],
    [0.8, 0.8, 1], [0.8, -0.8, 1], [-0.8, -0.8, 1], [-0.8, 0.8, 1],
    [-1, 0.8, 0.8], [-1, 0.8, -0.8], [-1, -0.8, -0.8], [-1, -0.8, 0.8],
    [0.8, -1, 0.8], [0.8, -1, -0.8], [-0.8, -1, -0.8], [-0.8, -1, 0.8],
    [0.8, 0.8, -1], [0.8, -0.8, -1], [-0.8, -0.8, -1], [-0.8, 0.8, -1],
  ];
  const LINES = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
    [8, 9], [9, 10], [10, 11], [11, 8],
    [12, 13], [13, 14], [14, 15], [15, 12],
    [16, 17], [17, 18], [18, 19], [19, 16],
    [20, 21], [21, 22], [22, 23], [23, 20],
    [24, 25], [25, 26], [26, 27], [27, 24],
    [28, 29], [29, 30], [30, 31], [31, 28],
  ];

  // --- State ----------------------------------------------------------------
  let W, H, S;            // canvas size (device px) and devicePixelRatio
  let lineWidth;          // stroke width (1, or 3 on retina) -- matches flow.c

  let bees;               // [{ tail: [{x,y,z} * taillen] }]; tail[0] is the head
  let beecount;           // bees actually flown each step
  let taillen;            // trail length (random from config.size)

  let odeFn;              // active ODE (cubic | periodic)
  let yperiod;            // > 0 for periodic flows (y is a wrapping time axis)
  const range = { x: 0, y: 0, z: 0 };   // initial-condition spread

  const par = makeVecArray(N_PARS);     // active ODE parameters
  let size, stepSize, lyap;             // bounding-box extent, RK2 step, Lyapunov
  const mid = { x: 0, y: 0, z: 0 };     // bounding-box centre

  // Parallel "discover" search state (alternate variable set).
  const par2 = makeVecArray(N_PARS);
  const p2 = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  let count2, searchStepSize, size2, lyap2;
  const mid2 = { x: 0, y: 0, z: 0 };

  // Camera.
  const cam = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  const circle = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  const centre = { x: 0, y: 0, z: 0 };
  let chaseto, chasetime;
  let rotatep, ridep;     // effective flags captured at init (>=1 viewpoint)

  let count;              // step counter (drives camera path + timeout)

  // Rendering buckets: segBuckets[col] is a flat [x1,y1,x2,y2, ...] list.
  let segBuckets, nbuckets, bucketColors;
  let palette = null, paletteN = 0;     // faithful make_random_colormap, cached by ncolors

  // Orientation matrix and ODE scratch (reused to avoid per-step allocation).
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const k1 = { x: 0, y: 0, z: 0 }, k2 = { x: 0, y: 0, z: 0 };
  const A1 = { x: 0, y: 0, z: 0 }, A2 = { x: 0, y: 0, z: 0 };

  // --- Helpers --------------------------------------------------------------
  function makeVecArray(n) {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = { x: 0, y: 0, z: 0 };
    return a;
  }

  function zeroPar(p) {
    for (let i = 0; i < p.length; i++) { p[i].x = 0; p[i].y = 0; p[i].z = 0; }
  }

  function copyPar(dst, src) {
    for (let i = 0; i < dst.length; i++) {
      dst[i].x = src[i].x; dst[i].y = src[i].y; dst[i].z = src[i].z;
    }
  }

  function nrand(n) { return n > 0 ? (Math.random() * n) | 0 : 0; }

  // Uniform random in [-v/2, +v/2), the C's balance_rand().
  function balanceRand(v) { return Math.random() * v - v / 2; }

  // Gaussian, mean 0, amplitude A (= 3 sigma). Returns a pair, saving one for
  // the next call -- a faithful port of the C's static-buffered Gauss_Rand.
  let gaussReady = false, gaussSaved = 0;
  function gaussRand(A) {
    if (gaussReady) { gaussReady = false; return A / 3 * gaussSaved; }
    let x, y, w;
    do {
      x = 2 * Math.random() - 1;
      y = 2 * Math.random() - 1;
      w = x * x + y * y;
    } while (w >= 1.0 || w === 0);   // w === 0 guards log(0) (C omits this)
    w = Math.sqrt(-2 * Math.log(w) / w);
    gaussReady = true;
    gaussSaved = x * w;
    return A / 3 * y * w;
  }

  // A coordinate is "bad" if non-finite or past the escape radius. The C tests
  // only fabs() > LOST_IN_SPACE; we also reject NaN/Inf so a single diverging
  // bee can never poison the field (NaN > x is false in both C and JS).
  function bad(v) { return !Number.isFinite(v) || Math.abs(v) > LOST_IN_SPACE; }

  // --- ODEs -----------------------------------------------------------------
  // Generic 3D cubic polynomial (covers Lorentz, Rossler, ...). Writes into out.
  function cubic(a, x, y, z, out) {
    out.x = a[C].x + a[X].x * x + a[XX].x * x * x + a[XXX].x * x * x * x + a[XXY].x * x * x * y +
      a[XXZ].x * x * x * z + a[XY].x * x * y + a[XYY].x * x * y * y + a[XYZ].x * x * y * z +
      a[XZ].x * x * z + a[XZZ].x * x * z * z + a[Y].x * y + a[YY].x * y * y +
      a[YYY].x * y * y * y + a[YYZ].x * y * y * z + a[YZ].x * y * z + a[YZZ].x * y * z * z +
      a[Z].x * z + a[ZZ].x * z * z + a[ZZZ].x * z * z * z;
    out.y = a[C].y + a[X].y * x + a[XX].y * x * x + a[XXX].y * x * x * x + a[XXY].y * x * x * y +
      a[XXZ].y * x * x * z + a[XY].y * x * y + a[XYY].y * x * y * y + a[XYZ].y * x * y * z +
      a[XZ].y * x * z + a[XZZ].y * x * z * z + a[Y].y * y + a[YY].y * y * y +
      a[YYY].y * y * y * y + a[YYZ].y * y * y * z + a[YZ].y * y * z + a[YZZ].y * y * z * z +
      a[Z].y * z + a[ZZ].y * z * z + a[ZZZ].y * z * z * z;
    out.z = a[C].z + a[X].z * x + a[XX].z * x * x + a[XXX].z * x * x * x + a[XXY].z * x * x * y +
      a[XXZ].z * x * x * z + a[XY].z * x * y + a[XYY].z * x * y * y + a[XYZ].z * x * y * z +
      a[XZ].z * x * z + a[XZZ].z * x * z * z + a[Y].z * y + a[YY].z * y * y +
      a[YYY].z * y * y * y + a[YYZ].z * y * y * z + a[YZ].z * y * z + a[YZZ].z * y * z * z +
      a[Z].z * z + a[ZZ].z * z * z + a[ZZZ].z * z * z * z;
  }

  // Cubic in (x,z) with a sinusoidal forcing term; y is the periodic time axis
  // (Birkhoff's Bagel, Duffing's oscillator). Writes into out.
  function periodic(a, x, y, z, out) {
    out.x = a[C].x + a[X].x * x + a[XX].x * x * x + a[XXX].x * x * x * x +
      a[XXZ].x * x * x * z + a[XZ].x * x * z + a[XZZ].x * x * z * z + a[Z].x * z +
      a[ZZ].x * z * z + a[ZZZ].x * z * z * z + a[SINY].x * Math.sin(y);
    out.y = a[C].y;
    out.z = a[C].z + a[X].z * x + a[XX].z * x * x + a[XXX].z * x * x * x +
      a[XXZ].z * x * x * z + a[XZ].z * x * z + a[XZZ].z * x * z * z + a[Z].z * z +
      a[ZZ].z * z * z + a[ZZZ].z * z * z * z;
  }

  // 2nd-order Runge-Kutta. Advances p in place; returns the squared step length
  // (so discover() can tell when the flow is too fast and halve the step).
  function iterate(p, a, h) {
    odeFn(a, p.x, p.y, p.z, k1);
    k1.x *= h; k1.y *= h; k1.z *= h;
    odeFn(a, p.x + k1.x, p.y + k1.y, p.z + k1.z, k2);
    k2.x *= h; k2.y *= h; k2.z *= h;
    const dx = (k1.x + k2.x) * 0.5, dy = (k1.y + k2.y) * 0.5, dz = (k1.z + k2.z) * 0.5;
    p.x += dx; p.y += dy; p.z += dz;
    return dx * dx + dy * dy + dz * dz;
  }

  // --- Discover -------------------------------------------------------------
  // Fly a pair of bees through par2's flow; if they stay bounded, record the
  // bounding box (mid2/size2) and Lyapunov exponent (lyap2). Returns false if
  // the flow explodes. Continues/refines across calls (reset count2 to restart).
  function discover() {
    let l = 0;

    if (count2 === 0) {
      p2[0].x = gaussRand(range.x);
      p2[0].y = (yperiod > 0) ? balanceRand(range.y) : gaussRand(range.y);
      p2[0].z = gaussRand(range.z);

      // 1000 steps to settle onto an attractor (most random flows explode here).
      for (let n = 0; n < 1000; n++) {
        iterate(p2[0], par2, searchStepSize);
        if (yperiod > 0 && p2[0].y > yperiod) p2[0].y -= yperiod;
        if (bad(p2[0].x) || bad(p2[0].y) || bad(p2[0].z)) return false;
        count2++;
      }
      // Seed the second bee a hair away from the first.
      p2[1].x = p2[0].x + 0.000001;
      p2[1].y = p2[0].y;
      p2[1].z = p2[0].z;
    }

    let maxx = p2[0].x, minx = p2[0].x;
    let maxy = p2[0].y, miny = p2[0].y;
    let maxz = p2[0].z, minz = p2[0].z;
    let maxv2 = 0, lsum = 0, nl = 0;

    for (let n = 0; n < 5000; n++) {
      for (let i = 0; i < 2; i++) {
        const v2 = iterate(p2[i], par2, searchStepSize);
        if (yperiod > 0 && p2[i].y > yperiod) p2[i].y -= yperiod;
        if (bad(p2[i].x) || bad(p2[i].y) || bad(p2[i].z)) return false;
        if (v2 > maxv2) maxv2 = v2;
      }

      if (p2[0].x < minx) minx = p2[0].x; else if (p2[0].x > maxx) maxx = p2[0].x;
      if (p2[0].y < miny) miny = p2[0].y; else if (p2[0].y > maxy) maxy = p2[0].y;
      if (p2[0].z < minz) minz = p2[0].z; else if (p2[0].z > maxz) maxz = p2[0].z;

      // Renormalise the bee separation; sum log(growth) for the Lyapunov est.
      const dlx = p2[1].x - p2[0].x, dly = p2[1].y - p2[0].y, dlz = p2[1].z - p2[0].z;
      const dl2 = dlx * dlx + dly * dly + dlz * dlz;
      if (dl2 > 0) {
        const df = 1e12 * dl2;
        const rs = 1 / Math.sqrt(df);
        p2[1].x = p2[0].x + rs * dlx;
        p2[1].y = p2[0].y + rs * dly;
        p2[1].z = p2[0].z + rs * dlz;
        lsum += Math.log(df);
        nl++;
        l = Math.LOG2E / 2 * lsum / nl / searchStepSize;
      }
      count2++;
    }

    lyap2 = l;
    size2 = maxx - minx;
    let s = maxy - miny; if (s > size2) size2 = s;
    s = maxz - minz; if (s > size2) size2 = s;
    mid2.x = (maxx + minx) / 2;
    mid2.y = (maxy + miny) / 2;
    mid2.z = (maxz + minz) / 2;

    // Flowing too fast for the step size -> halve it (kills high-speed cycles).
    if (Math.sqrt(maxv2) > size2 * 0.2) searchStepSize /= 2;
    return true;
  }

  // Returns true if the segment s->e is fully behind the clip plane, else clips
  // it to the plane (nx,ny,nz, distance d) in place. Used only for the box.
  function clip(nx, ny, nz, d, s, e) {
    const front1 = (nx * s.x + ny * s.y + nz * s.z >= -d);
    const front2 = (nx * e.x + ny * e.y + nz * e.z >= -d);
    if (!front1 && !front2) return true;
    if (front1 && front2) return false;
    const wx = e.x - s.x, wy = e.y - s.y, wz = e.z - s.z;
    const t = (-d - nx * s.x - ny * s.y - nz * s.z) / (nx * wx + ny * wy + nz * wz);
    const px = s.x + wx * t, py = s.y + wy * t, pz = s.z + wz * t;
    if (front2) { s.x = px; s.y = py; s.z = pz; }
    else { e.x = px; e.y = py; e.z = pz; }
    return false;
  }

  // --- Setup ----------------------------------------------------------------
  // Re-seed every bee's head onto the attractor (the C's restart_flow). Also
  // collapses each tail onto its head so no stale trail flickers in (see flow.md).
  function restartFlow() {
    count = 0;
    for (let b = 0; b < bees.length; b++) {
      const tail = bees[b].tail;
      const h = tail[0];
      h.x = gaussRand(range.x);
      h.y = (yperiod > 0) ? balanceRand(range.y) : gaussRand(range.y);
      h.z = gaussRand(range.z);
      for (let t = 1; t < tail.length; t++) {
        tail[t].x = h.x; tail[t].y = h.y; tail[t].z = h.z;
      }
    }
  }

  // Pick a standard attractor, run discover() once to frame it, allocate bees.
  // Mirrors init_flow(); does NOT touch the canvas (render() repaints), so a
  // mid-run re-seed shows the old frame once before the new flow takes over.
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    lineWidth = (W > 2560 || H > 2560) ? 3 : 1;   // flow.c's retina rule

    count2 = 0;

    // Trail length from config.size (negative => random, like the C's MI_SIZE).
    const sz = Math.round(config.size);
    if (sz < -MINTRAIL) {
      const n = nrand(Math.floor(Math.sqrt(-sz - MINTRAIL + 1)));
      taillen = n * n + MINTRAIL;
    } else if (sz < MINTRAIL) {
      taillen = MINTRAIL;
    } else {
      taillen = sz;
    }

    // Need at least one viewpoint.
    rotatep = config.rotate;
    ridep = config.ride;
    if (!rotatep && !ridep) rotatep = true;
    chaseto = rotatep ? ORBIT : BEE;
    chasetime = 1;

    lyap = 0;
    yperiod = 0;
    searchStepSize = INITIALSTEP;
    zeroPar(par2);

    // Standard examples. The C zeroes the randomness on several Lorentz/Rossler
    // params (balance_rand(... * 0)); those are written as plain constants here.
    switch (nrand(config.periodic ? 5 : 3)) {
      case 0:   // Lorentz: x'=a(y-x), y'=x(b-z)-y, z'=xy-cz
        par2[Y].x = 10;             // a
        par2[X].x = -par2[Y].x;     // -a
        par2[X].y = 28;             // b
        par2[XZ].y = -1;
        par2[Y].y = -1;
        par2[XY].z = 1;
        par2[Z].z = -2;             // -c
        break;
      case 1:   // Rossler: x'=-(y+az), y'=x+by, z'=c+z(x-5.7)
        par2[Y].x = -1;
        par2[Z].x = -2 + balanceRand(1);      // a
        par2[X].y = 1;
        par2[Y].y = 0.2 + balanceRand(0.1);   // b
        par2[C].z = 0.2 + balanceRand(0.1);   // c
        par2[XZ].z = 1;
        par2[Z].z = -5.7;
        break;
      case 2:   // RosslerCone: x'=-(y+az), y'=x+by-cz^2, z'=0.2+z(x-5.7)
        par2[Y].x = -1;
        par2[Z].x = -2;             // a
        par2[X].y = 1;
        par2[Y].y = 0.2;            // b
        par2[ZZ].y = -0.331 + balanceRand(0.01);  // c
        par2[C].z = 0.2;
        par2[XZ].z = 1;
        par2[Z].z = -5.7;
        break;
      case 3:   // Birkhoff: x'=-z+b sin(y), y'=c, z'=0.7x+az(0.1-x^2)
        par2[Z].x = -1;
        par2[SINY].x = 0.35 + balanceRand(0.25);  // b
        par2[C].y = 1.57;          // c
        par2[X].z = 0.7;
        par2[Z].z = 1 + balanceRand(0.5);         // a/10
        par2[XXZ].z = -10 * par2[Z].z;            // -a
        yperiod = 2 * Math.PI;
        break;
      default:  // Duffing: x'=-ax-z/2-z^3/8+b sin(y), y'=c, z'=2x
        par2[X].x = -0.2 + balanceRand(0.1);      // a
        par2[Z].x = -0.5;
        par2[ZZZ].x = -0.125;
        par2[SINY].x = 27.0 + balanceRand(3.0);   // b
        par2[C].y = 1.33;          // c
        par2[X].z = 2;
        yperiod = 2 * Math.PI;
        break;
    }

    range.x = 5;
    range.z = 5;
    if (yperiod > 0) {
      odeFn = periodic;
      // Either a uniform slice or a snapshot on the time axis.
      range.y = nrand(2) ? yperiod : 0;
    } else {
      range.y = 5;
      odeFn = cubic;
    }

    // Frame the attractor (bounding box + step size), then install par2 -> par.
    discover();
    lyap = lyap2;
    size = size2;
    mid.x = mid2.x; mid.y = mid2.y; mid.z = mid2.z;
    stepSize = searchStepSize;
    copyPar(par, par2);
    count2 = 0;   // reset the background search

    // The camera reads bees[0] and bees[1]; keep at least two slots present.
    beecount = Math.max(1, Math.round(config.count));
    const nslots = Math.max(2, beecount);
    bees = new Array(nslots);
    for (let b = 0; b < nslots; b++) {
      const tail = new Array(taillen);
      for (let t = 0; t < taillen; t++) tail[t] = { x: 0, y: 0, z: 0 };
      bees[b] = { tail };
    }

    // Palette: flow.c defines no *_COLORS, so xlockmore gives it the DEFAULT
    // colour scheme -- make_random_colormap with bright_p = FALSE: `ncolors`
    // fully-random RGB entries (NOT a smooth/ordered rainbow ramp). xlockmore
    // allocates the colormap ONCE at screen init; init_flow never rebuilds it, so
    // we cache by ncolors and only re-roll when ncolors changes (an internal
    // re-seed keeps the same palette, as the C does). Bucket col uses palette
    // entry col+1, like the C's MI_PIXEL(col+1) over MI_NPIXELS-1 buckets.
    // <= 2 colours -> mono white, as the C's render() falls back to MI_WHITE_PIXEL.
    const np = Math.max(1, Math.round(config.ncolors));
    nbuckets = Math.max(1, np - 1);
    if (np > 2) {
      if (!palette || paletteN !== np) {
        palette = makeRandomColormapRGB(np, false);   // make_random_colormap, bright_p=False
        paletteN = np;
      }
    } else {
      palette = null;
      paletteN = np;
    }
    bucketColors = new Array(nbuckets);
    for (let col = 0; col < nbuckets; col++) {
      if (np > 2) {
        const c = palette[col + 1];
        bucketColors[col] = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
      } else {
        bucketColors[col] = 'white';
      }
    }
    // Preserve existing buckets across an internal re-seed (so the last frame of
    // the old flow stays on screen); only rebuild when the count changed.
    if (!segBuckets || segBuckets.length !== nbuckets) {
      segBuckets = new Array(nbuckets);
      for (let col = 0; col < nbuckets; col++) segBuckets[col] = [];
    }

    restartFlow();

    // Seed the camera tail at the origin (the C's X(1,0) = cam[1] = 0).
    for (let i = 0; i < 3; i++) { cam[i].x = 0; cam[i].y = 0; cam[i].z = 0; }
    circle[0].x = circle[0].y = circle[0].z = 0;
    circle[1].x = circle[1].y = circle[1].z = 0;
    if (bees[0].tail.length > 1) { bees[0].tail[1].x = 0; bees[0].tail[1].y = 0; bees[0].tail[1].z = 0; }
  }

  // --- One step (== draw_flow) ----------------------------------------------
  function step() {
    // Clear this frame's segment buckets.
    for (let col = 0; col < nbuckets; col++) segBuckets[col].length = 0;

    // Background hunt for a new attractor.
    if (config.search) {
      if (count2 === 0) {
        searchStepSize = INITIALSTEP;
        for (let i = 0; i < N_PARS; i++) {
          par2[i].x = gaussRand(1.0);
          par2[i].y = gaussRand(1.0);
          par2[i].z = gaussRand(1.0);
        }
      }
      if (!discover()) {
        count2 = 0;   // exploded -> start over
      } else if (lyap2 < 0) {
        count2 = 0;   // bounded but not strange (fixed point / limit cycle)
      } else if (count2 > 1000000) {
        // A keeper. Install it and re-seed the bees onto it.
        count2 = 0;
        lyap = lyap2;
        size = size2;
        mid.x = mid2.x; mid.y = mid2.y; mid.z = mid2.z;
        stepSize = searchStepSize;
        copyPar(par, par2);
        if (chaseto === BEE && rotatep) { chaseto = ORBIT; chasetime = 100; }
        restartFlow();
      }
    }

    // Circling point-of-view.
    circle[1].x = circle[0].x; circle[1].y = circle[0].y; circle[1].z = circle[0].z;
    circle[0].x = size * 2 * Math.sin(count / 100.0) * (-0.6 + 0.4 * Math.cos(count / 500.0)) + mid.x;
    circle[0].y = size * 2 * Math.cos(count / 100.0) * (0.6 + 0.4 * Math.cos(count / 500.0)) + mid.y;
    circle[0].z = size * 2 * Math.sin(count / 421.0) + mid.z;

    // Occasionally switch the camera between orbiting and bee-riding.
    if (rotatep && ridep) {
      if (chaseto === BEE && nrand(1000) === 0) { chaseto = ORBIT; chasetime = 100; }
      else if (nrand(4000) === 0) { chaseto = BEE; chasetime = 100; }
    }

    // --- Orientation matrix ---
    if (chasetime > 1) chasetime--;
    if (chaseto === BEE) {
      const b0h = bees[0].tail[0], b0t = bees[0].tail.length > 1 ? bees[0].tail[1] : bees[0].tail[0], b1h = bees[1].tail[0];
      cam[0].x += (b0h.x - cam[0].x) / chasetime; cam[0].y += (b0h.y - cam[0].y) / chasetime; cam[0].z += (b0h.z - cam[0].z) / chasetime;
      cam[1].x += (b0t.x - cam[1].x) / chasetime; cam[1].y += (b0t.y - cam[1].y) / chasetime; cam[1].z += (b0t.z - cam[1].z) / chasetime;
      cam[2].x += (b1h.x - cam[2].x) / chasetime; cam[2].y += (b1h.y - cam[2].y) / chasetime; cam[2].z += (b1h.z - cam[2].z) / chasetime;
    } else {
      cam[0].x += (circle[0].x - cam[0].x) / chasetime; cam[0].y += (circle[0].y - cam[0].y) / chasetime; cam[0].z += (circle[0].z - cam[0].z) / chasetime;
      cam[1].x += (2 * circle[0].x - mid.x - cam[1].x) / chasetime; cam[1].y += (2 * circle[0].y - mid.y - cam[1].y) / chasetime; cam[1].z += (2 * circle[0].z - mid.z - cam[1].z) / chasetime;
      cam[2].x += (circle[1].x - cam[2].x) / chasetime; cam[2].y += (circle[1].y - cam[2].y) / chasetime; cam[2].z += (circle[1].z - cam[2].z) / chasetime;
    }

    centre.x = cam[1].x; centre.y = cam[1].y; centre.z = cam[1].z;

    const fx = cam[0].x - cam[1].x, fy = cam[0].y - cam[1].y, fz = cam[0].z - cam[1].z;  // forward
    const px = cam[2].x - cam[1].x, py = cam[2].y - cam[1].y, pz = cam[2].z - cam[1].z;  // side
    const x2 = fx * fx + fy * fy + fz * fz;   // X . X
    const xp = fx * px + fy * py + fz * pz;   // X . P
    M[0][0] = fx; M[0][1] = fy; M[0][2] = fz;                              // forward
    M[1][0] = x2 * px - xp * fx; M[1][1] = x2 * py - xp * fy; M[1][2] = x2 * pz - xp * fz;  // (XxP)xX
    M[2][0] = fy * pz - fz * py; M[2][1] = -fx * pz + fz * px; M[2][2] = fx * py - fy * px; // XxP
    for (let r = 0; r < 3; r++) {
      let a = Math.sqrt(M[r][0] * M[r][0] + M[r][1] * M[r][1] + M[r][2] * M[r][2]);
      if (a > 0) { M[r][0] /= a; M[r][1] /= a; M[r][2] /= a; }
    }
    // Pin the wingbee (bee 1) just off bee 0 along the camera "up" axis.
    if (chaseto === BEE) {
      const b0h = bees[0].tail[0], b1h = bees[1].tail[0];
      b1h.x = b0h.x + M[1][0] * stepSize;
      b1h.y = b0h.y + M[1][1] * stepSize;
      b1h.z = b0h.z + M[1][2] * stepSize;
    }

    const m00 = M[0][0], m01 = M[0][1], m02 = M[0][2];
    const m10 = M[1][0], m11 = M[1][1], m12 = M[1][2];
    const m20 = M[2][0], m21 = M[2][1], m22 = M[2][2];
    const eh = EYEHEIGHT * size;
    const cxv = centre.x, cyv = centre.y, czv = centre.z;
    const halfW = W / 2, halfH = H / 2;

    // --- Bounding box ---
    if (config.box) {
      for (let bl = 0; bl < BOX_L; bl++) {
        const i1 = LINES[bl][0], i2 = LINES[bl][1];
        const x1 = BOX[i1][0] * size / 2 + mid.x - cxv;
        const y1 = BOX[i1][1] * size / 2 + mid.y - cyv;
        const z1 = BOX[i1][2] * size / 2 + mid.z - czv;
        const x2b = BOX[i2][0] * size / 2 + mid.x - cxv;
        const y2b = BOX[i2][1] * size / 2 + mid.y - cyv;
        const z2b = BOX[i2][2] * size / 2 + mid.z - czv;
        A1.x = m00 * x1 + m01 * y1 + m02 * z1;
        A1.y = m10 * x1 + m11 * y1 + m12 * z1;
        A1.z = m20 * x1 + m21 * y1 + m22 * z1 + eh;
        A2.x = m00 * x2b + m01 * y2b + m02 * z2b;
        A2.y = m10 * x2b + m11 * y2b + m12 * z2b;
        A2.z = m20 * x2b + m21 * y2b + m22 * z2b + eh;
        // Clip in 3D against the view frustum before the perspective divide.
        if (clip(1, 0, 0, -1, A1, A2) ||
          clip(1, 2, 0, 0, A1, A2) ||
          clip(1, -2, 0, 0, A1, A2) ||
          clip(1, 0, 2.0 * W / H, 0, A1, A2) ||
          clip(1, 0, -2.0 * W / H, 0, A1, A2)) continue;
        const col = bl % nbuckets;
        segBuckets[col].push(
          halfW + W * A1.y / A1.x, halfH + W * A1.z / A1.x,
          halfW + W * A2.y / A2.x, halfH + W * A2.z / A2.x,
        );
      }
    }

    // --- Bees ---
    let swarm = 0;
    for (let b = 0; b < beecount; b++) {
      const tail = bees[b].tail;
      const head = tail[0];

      // Lost bee: disable it. If it's the camera bee, hop it onto another bee
      // so we don't lose the attractor (rather than a full reinit).
      if (bad(head.x) || bad(head.y) || bad(head.z)) {
        if (chaseto === BEE && b === 0) {
          if (beecount > 1) {
            const nh = bees[1 + nrand(beecount - 1)].tail[0];
            head.x = nh.x + 0.001; head.y = nh.y; head.z = nh.z;
          } else {
            head.x = gaussRand(range.x);
            head.y = (yperiod > 0) ? balanceRand(range.y) : gaussRand(range.y);
            head.z = gaussRand(range.z);
          }
        }
        continue;
      }

      // Age the tail, then advance the head.
      for (let t = taillen - 1; t >= 1; t--) {
        const dst = tail[t], src = tail[t - 1];
        dst.x = src.x; dst.y = src.y; dst.z = src.z;
      }
      iterate(head, par, stepSize);

      // The wingbee isn't quite in the flow -- don't draw it.
      if (chaseto === BEE && b === 1) continue;

      const col = b % nbuckets;
      const bucket = segBuckets[col];
      const end = Math.min(taillen, count);
      let prevX = 0, prevY = 0, prevValid = false;

      for (let i = 0; i < end; i++) {
        const pt = tail[i];
        const x = pt.x - cxv;
        const y = pt.y - cyv;     // yperiod is never < 0 in the standard set
        const z = pt.z - czv;
        const XM = m00 * x + m01 * y + m02 * z;
        const YM = m10 * x + m11 * y + m12 * z;
        const ZM = m20 * x + m21 * y + m22 * z + eh;
        swarm++;

        // Wrap the periodic (time) axis; hide the rest of the tail so the
        // Poincare slice doesn't streak in Y.
        if (yperiod > 0 && pt.y > yperiod) {
          pt.y -= yperiod;
          for (let j = i; j < end; j++) tail[j].y = pt.y;
          break;
        }
        if (XM <= 0) { prevValid = false; continue; }   // behind the camera
        const absx = halfW + W * YM / XM;
        const absy = halfH + W * ZM / XM;
        if (absx <= 0 || absx >= W || absy <= 0 || absy >= H) { prevValid = false; continue; }
        if (prevValid) bucket.push(prevX, prevY, absx, absy);
        prevX = absx; prevY = absy; prevValid = true;
      }
    }

    // All bees lost -> restart with a fresh attractor.
    if (count > 1 && swarm === 0) init();
    // Flow timed out -> pick a new standard attractor.
    if (count++ > config.cycles) init();
  }

  // Clear and re-stroke every bucket (the double-buffered repaint of flow.c).
  function render() {
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = lineWidth;
    for (let col = 0; col < nbuckets; col++) {
      const seg = segBuckets[col];
      if (seg.length === 0) continue;
      ctx.strokeStyle = bucketColors[col];
      ctx.beginPath();
      for (let k = 0; k < seg.length; k += 4) {
        ctx.moveTo(seg[k], seg[k + 1]);
        ctx.lineTo(seg[k + 2], seg[k + 3]);
      }
      ctx.stroke();
    }
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // rAF lag-accumulator paced by config.delay (us). Simulation runs in step();
  // render() repaints once per frame so the image stays stable even when we step
  // less than once per display frame (large delay). See squiral.js.
  //
  // OVERHEAD: the stock --delay is only a sleep floor; the live binary's real
  // rate is lower (delay + framework overhead -- see the framerate-calibration
  // note). The live flow measures 43.9 fps, but the port at the stock 10000 us
  // ran ~100 steps/sec (2.3x fast). 10000 + 12779 = 22779 us -> 43.9 steps/sec,
  // matching the live binary. A calibration, not a tuning knob (the delay
  // slider still maps 1:1 to the xml resource).
  const OVERHEAD = 12779;
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

    render();
    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config and clear the screen.
  function reinit() {
    init();
    for (let col = 0; col < nbuckets; col++) segBuckets[col].length = 0;
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, W, H);
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
