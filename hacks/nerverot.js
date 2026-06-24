// nerverot.js — nerverot packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's nerverot.c (Dan Bornstein, 2000-2001).
// https://www.jwz.org/xscreensaver/
//
// A writhing "nervous" blob: a set of 3D vertices ("blots") sampled on a random
// shape (sphere / cube / cylinder / squiggle / cube-corners / tetrahedron /
// sheet / swirly-cone / a duo of two of those). Each blot draws as a small 2D
// outline traced through a 3x3 grid of per-vertex display offsets, and every
// frame those offsets get a violent random jitter (reflected back inside the
// unit square at the edges) while the whole blob slowly drifts: its x/y/z
// rotation, scale, and a light position each ease toward a target, and random
// "events" jump those targets. The vertex colour is the squared distance from
// the moving light. Every (random) maxIters frames a fresh shape is generated.
// The window is fully repainted each frame (the C's double-buffered path).
//
// Rendering: this is genuinely line-shaped (8 thin segments per blot, hundreds
// of blots), so it uses canvas VECTOR ops — but, exactly like braid.js, the
// many tiny segments are BUCKETED BY COLOUR INDEX into one Path2D per colour
// (<= ncolors buckets) and each bucket is stroked once. The canvas is cleared
// to black at the top of every frame, then the buckets are stroked.

import { makeColorRampRGB } from './colormap.js';

export const title = 'nerverot';

export const info = {
  author: 'Dan Bornstein',
  description: 'Nervously vibrating squiggles.',
  year: 2000,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/nerverot.xml so the tuning UI maps 1:1.
  // `delay` is the stock 10000 us; the loop paces at (delay + OVERHEAD) so the
  // real per-frame period matches the original binary. The C's hidden defaults
  // (minScale/maxScale/minRadius/maxRadius/iterAmt) are kept as constants below
  // rather than exposed (the xml doesn't surface them).
  const config = {
    delay: 10000,        // microseconds between iterations (--delay); stock xml
    maxIters: 1200,      // max iterations before a new shape is picked (--max-iters)
    count: 250,          // requested number of blots/vertices (--count)
    ncolors: 4,          // size of the light-distance colour ramp (--colors)
    eventChance: 0.2,    // chance per iteration of a drift "event" (--event-chance)
    nervousness: 0.3,    // per-iteration jitter magnitude, 0..1 (--nervousness)
    maxNerveRadius: 0.7, // how far the jitter throws each point, 0..1 (--max-nerve-radius)
    lineWidth: 0,        // stroke width; 0 = 1px (--line-width)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'maxIters', label: 'Duration', type: 'range', min: 100, max: 8000, step: 100, default: 1200, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'count', label: 'Blot count', type: 'range', min: 1, max: 1000, step: 1, default: 250, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 4, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'eventChance', label: 'Changes', type: 'range', min: 0, max: 1, step: 0.01, default: 0.2, lowLabel: 'seldom', highLabel: 'frequent', live: true },
    { key: 'nervousness', label: 'Nervousness', type: 'range', min: 0, max: 1, step: 0.01, default: 0.3, lowLabel: 'calm', highLabel: 'spastic', live: true },
    { key: 'maxNerveRadius', label: 'Crunchiness', type: 'range', min: 0, max: 1, step: 0.01, default: 0.7, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'lineWidth', label: 'Line thickness', type: 'range', min: 0, max: 100, step: 1, default: 0, live: false },
  ];

  // Hidden C defaults (nerverot_defaults[]) that the xml doesn't expose; kept as
  // constants so the drift/scale/radius feel matches the original exactly.
  const ITER_AMT = 0.01;   // fraction toward each target moved per iteration
  const MIN_SCALE = 0.6;   // min/max drawing scale, fraction of baseScale
  const MAX_SCALE = 1.75;
  const MIN_RADIUS = 3;    // min/max blot radius, logical px (scaled by S)
  const MAX_RADIUS = 25;

  // Live-measured framework+draw overhead added to the stock delay: the loop
  // paces at (delay + OVERHEAD) us so the real per-frame period matches the
  // original (the C's delay is ON TOP of draw time). Live-measured: 54.5fps
  // (Load 45.5%, clean) at stock delay 10000 -> OVERHEAD 8350 (see nerverot.md).
  const OVERHEAD = 8350;

  // Each blot draws as this 2D outline; coords are in {-1,0,1} and index the 3x3
  // grid of jittered points as grid[x+1][y+1]. 9 points => 8 segments per blot.
  const blotShape = [
    [ 0,  0],
    [ 1,  0],
    [ 1,  1],
    [ 0,  1],
    [-1,  1],
    [-1,  0],
    [-1, -1],
    [ 0, -1],
    [ 1, -1],
  ];
  const blotShapeCount = blotShape.length;

  // random float in (-1..1) and (0..1)
  const randPM1 = () => Math.random() * 2 - 1;
  const rand01 = () => Math.random();

  let S = 1;              // devicePixelRatio
  let W, H;               // canvas size, device px
  let centerX, centerY;   // window centre, device px
  let baseScale;          // min(W, H) — base drawing scale, device px
  let minRadius, maxRadius;  // blot radii, device px (logical * S)

  let blots;             // array of { x, y, z, xoff[3][3], yoff[3][3] }
  let blotCount;
  let palette;           // ncolors hsl() strings (index 0..ncolors-1)

  // current vs. target drift state (rotation per axis, scale, light position)
  let xRot, yRot, zRot, curScale, lightX, lightY, lightZ;
  let xRotTarget, yRotTarget, zRotTarget, scaleTarget;
  let lightXTarget, lightYTarget, lightZTarget;
  let centerXOff, centerYOff;   // current absolute offsets from the centre, device px
  let itersTillNext;            // iterations until the next shape change

  // ---- generic blot setup + manipulation (initBlot etc.) ----------------

  // initialize a blot at (x,y,z) with random display offsets (initBlot).
  function makeBlot(x, y, z) {
    const xoff = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const yoff = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        xoff[i][j] = randPM1();
        yoff[i][j] = randPM1();
      }
    }
    return { x, y, z, xoff, yoff };
  }

  // scale the blots to have a max distance of 1 from the centre.
  function scaleBlotsToRadius1() {
    let max = 0.0;
    for (let n = 0; n < blotCount; n++) {
      const b = blots[n];
      const d = b.x * b.x + b.y * b.y + b.z * b.z;
      if (d > max) max = d;
    }
    if (max === 0.0) return;
    max = Math.sqrt(max);
    for (let n = 0; n < blotCount; n++) {
      blots[n].x /= max;
      blots[n].y /= max;
      blots[n].z /= max;
    }
  }

  // randomly reorder the blots (Fisher-Yates, matching the C's loop).
  function randomlyReorderBlots() {
    for (let n = 0; n < blotCount; n++) {
      const m = Math.floor(rand01() * (blotCount - n)) + n;
      const tmp = blots[n];
      blots[n] = blots[m];
      blots[m] = tmp;
    }
  }

  // randomly rotate all blots about the origin by a random amount per axis.
  function randomlyRotateBlots() {
    const rx = randPM1() * Math.PI;
    const ry = randPM1() * Math.PI;
    const rz = randPM1() * Math.PI;
    const sinX = Math.sin(rx), cosX = Math.cos(rx);
    const sinY = Math.sin(ry), cosY = Math.cos(ry);
    const sinZ = Math.sin(rz), cosZ = Math.cos(rz);

    for (let n = 0; n < blotCount; n++) {
      let x1 = blots[n].x, y1 = blots[n].y, z1 = blots[n].z;
      let x2, y2, z2;

      // rotate on z axis
      x2 = x1 * cosZ - y1 * sinZ;
      y2 = x1 * sinZ + y1 * cosZ;
      z2 = z1;

      // rotate on x axis
      y1 = y2 * cosX - z2 * sinX;
      z1 = y2 * sinX + z2 * cosX;
      x1 = x2;

      // rotate on y axis
      z2 = z1 * cosY - x1 * sinY;
      x2 = z1 * sinY + x1 * cosY;
      y2 = y1;

      blots[n].x = x2;
      blots[n].y = y2;
      blots[n].z = z2;
    }
  }

  // ---- blot configurations (the nine shapes) ----------------------------

  function setupBlotsSphere(req) {
    blotCount = req;
    blots = new Array(blotCount);
    for (let n = 0; n < blotCount; n++) {
      // pick a spot, reject radius < 0.2 or > 1 to avoid scaling problems.
      let x, y, z, radius;
      for (;;) {
        x = randPM1();
        y = randPM1();
        z = randPM1();
        radius = Math.sqrt(x * x + y * y + z * z);
        if (radius >= 0.2 && radius <= 1.0) break;
      }
      x /= radius;
      y /= radius;
      z /= radius;
      blots[n] = makeBlot(x, y, z);
    }
  }

  function setupBlotsCube(req) {
    // derive blotsPerEdge from the request, then recompute count (roundoff).
    let blotsPerEdge = Math.floor((req - 8) / 12) + 2;
    if (blotsPerEdge < 2) blotsPerEdge = 2;
    const distBetween = 2.0 / (blotsPerEdge - 1.0);

    blotCount = 8 + (blotsPerEdge - 2) * 12;
    blots = new Array(blotCount);
    let n = 0;

    // the corners
    for (let i = -1; i < 2; i += 2) {
      for (let j = -1; j < 2; j += 2) {
        for (let k = -1; k < 2; k += 2) {
          blots[n++] = makeBlot(i, j, k);
        }
      }
    }

    // the edges
    for (let i = 1; i < blotsPerEdge - 1; i++) {
      const v = distBetween * i - 1;
      blots[n++] = makeBlot(v, -1, -1);
      blots[n++] = makeBlot(v,  1, -1);
      blots[n++] = makeBlot(v, -1,  1);
      blots[n++] = makeBlot(v,  1,  1);
      blots[n++] = makeBlot(-1, v, -1);
      blots[n++] = makeBlot( 1, v, -1);
      blots[n++] = makeBlot(-1, v,  1);
      blots[n++] = makeBlot( 1, v,  1);
      blots[n++] = makeBlot(-1, -1, v);
      blots[n++] = makeBlot( 1, -1, v);
      blots[n++] = makeBlot(-1,  1, v);
      blots[n++] = makeBlot( 1,  1, v);
    }

    scaleBlotsToRadius1();
    randomlyReorderBlots();
    randomlyRotateBlots();
  }

  function setupBlotsCylinder(req) {
    const reqRoot = Math.sqrt(req);
    // (int) cast of ceil(...)/2 + reqRoot, matching the C's integer truncation.
    let blotsPerRing = Math.trunc(Math.ceil(randPM1() * reqRoot) / 2 + reqRoot);
    if (blotsPerRing < 2) blotsPerRing = 2;
    let blotsPerEdge = Math.trunc(req / blotsPerRing);
    if (blotsPerEdge < 2) blotsPerEdge = 2;

    const distBetween = 2.0 / (blotsPerEdge - 1);

    blotCount = blotsPerEdge * blotsPerRing;
    blots = new Array(blotCount);
    let n = 0;

    for (let i = 0; i < blotsPerRing; i++) {
      const x = Math.sin(2 * Math.PI / blotsPerRing * i);
      const y = Math.cos(2 * Math.PI / blotsPerRing * i);
      for (let j = 0; j < blotsPerEdge; j++) {
        blots[n++] = makeBlot(x, y, j * distBetween - 1);
      }
    }

    scaleBlotsToRadius1();
    randomlyReorderBlots();
    randomlyRotateBlots();
  }

  function setupBlotsSquiggle(req) {
    blotCount = req;
    blots = new Array(blotCount);

    const maxCoor = Math.trunc(rand01() * 5) + 1;
    const minCoor = -maxCoor;

    let x = randPM1(), y = randPM1(), z = randPM1();
    let xv = randPM1(), yv = randPM1(), zv = randPM1();
    let len = Math.sqrt(xv * xv + yv * yv + zv * zv);
    xv /= len; yv /= len; zv /= len;

    for (let n = 0; n < blotCount; n++) {
      blots[n] = makeBlot(x, y, z);

      let newx, newy, newz;
      for (;;) {
        xv += randPM1() * 0.1;
        yv += randPM1() * 0.1;
        zv += randPM1() * 0.1;
        len = Math.sqrt(xv * xv + yv * yv + zv * zv);
        xv /= len; yv /= len; zv /= len;

        newx = x + xv * 0.1;
        newy = y + yv * 0.1;
        newz = z + zv * 0.1;

        if (newx >= minCoor && newx <= maxCoor &&
            newy >= minCoor && newy <= maxCoor &&
            newz >= minCoor && newz <= maxCoor) {
          break;
        }
      }

      x = newx; y = newy; z = newz;
    }

    scaleBlotsToRadius1();
    randomlyReorderBlots();
  }

  function setupBlotsCubeCorners(req) {
    blotCount = req;
    blots = new Array(blotCount);
    for (let n = 0; n < blotCount; n++) {
      // rint(rand01()) is 0 or 1 -> -1 or 1, then a small random spread.
      let x = Math.round(rand01()) * 2 - 1;
      let y = Math.round(rand01()) * 2 - 1;
      let z = Math.round(rand01()) * 2 - 1;
      x += randPM1() * 0.3;
      y += randPM1() * 0.3;
      z += randPM1() * 0.3;
      blots[n] = makeBlot(x, y, z);
    }
    scaleBlotsToRadius1();
    randomlyRotateBlots();
  }

  function setupBlotsTetrahedron(req) {
    const cor = [
      [ 0.0,   1.0,  0.0],
      [-0.75, -0.5, -0.433013],
      [ 0.0,  -0.5,  0.866025],
      [ 0.75, -0.5, -0.433013],
    ];

    const blotsPerSurface = Math.trunc(req / 4);
    blotCount = blotsPerSurface * 4;
    blots = new Array(blotCount);

    for (let n = 0; n < blotCount; n += 4) {
      // pick a random point on a unit right triangle.
      let rawx = rand01();
      let rawy = rand01();
      if (rawx + rawy > 1) {
        const t = 1.0 - rawx;
        rawx = 1.0 - rawy;
        rawy = t;
      }

      // translate the point onto each of the four surfaces.
      for (let c = 0; c < 4; c++) {
        const c1 = (c + 1) % 4;
        const c2 = (c + 2) % 4;
        const x = (cor[c1][0] - cor[c][0]) * rawx + (cor[c2][0] - cor[c][0]) * rawy + cor[c][0];
        const y = (cor[c1][1] - cor[c][1]) * rawx + (cor[c2][1] - cor[c][1]) * rawy + cor[c][1];
        const z = (cor[c1][2] - cor[c][2]) * rawx + (cor[c2][2] - cor[c][2]) * rawy + cor[c][2];
        blots[n + c] = makeBlot(x, y, z);
      }
    }

    randomlyRotateBlots();
  }

  function setupBlotsSheet(req) {
    let perDim = Math.floor(Math.sqrt(req));
    if (perDim < 2) perDim = 2;
    const spaceBetween = 2.0 / (perDim - 1);

    blotCount = perDim * perDim;
    blots = new Array(blotCount);

    for (let x = 0; x < perDim; x++) {
      for (let y = 0; y < perDim; y++) {
        let x1 = x * spaceBetween - 1.0;
        let y1 = y * spaceBetween - 1.0;
        let z1 = 0.0;
        x1 += randPM1() * spaceBetween / 3;
        y1 += randPM1() * spaceBetween / 3;
        z1 += randPM1() * spaceBetween / 2;
        blots[x + y * perDim] = makeBlot(x1, y1, z1);
      }
    }

    scaleBlotsToRadius1();
    randomlyReorderBlots();
    randomlyRotateBlots();
  }

  function setupBlotsSwirlyCone(req) {
    const radSpace = 1.0 / (req - 1);
    const zSpace = radSpace * 2;
    const rotAmt = randPM1() * Math.PI / 10;

    blotCount = req;
    blots = new Array(blotCount);
    let rot = 0.0;

    for (let n = 0; n < blotCount; n++) {
      const radius = n * radSpace;
      const x = Math.cos(rot) * radius;
      const y = Math.sin(rot) * radius;
      const z = n * zSpace - 1.0;
      rot += rotAmt;
      blots[n] = makeBlot(x, y, z);
    }

    scaleBlotsToRadius1();
    randomlyReorderBlots();
    randomlyRotateBlots();
  }

  // two of the other shapes placed next to each other.
  function setupBlotsDuo(req) {
    if (req < 15) {
      // special-case bottom-out.
      setupBlotsSphere(req);
      return;
    }

    let tx = randPM1(), ty = randPM1(), tz = randPM1();
    const radius = Math.sqrt(tx * tx + ty * ty + tz * tz);
    tx /= radius; ty /= radius; tz /= radius;

    // set 1 (recursive, half the request). The recursion bottoms out because
    // req halves each level and duo special-cases req < 15 to a sphere, so the
    // depth is bounded (250 -> 125 -> 62 -> 31 -> 15 -> sphere).
    setupBlots(Math.trunc(req / 2));
    if (blotCount >= req) return;   // already satisfies the request

    const blots1 = blots;
    const count1 = blotCount;

    // translate set 1 to its new position.
    for (let n = 0; n < count1; n++) {
      blots1[n].x += tx;
      blots1[n].y += ty;
      blots1[n].z += tz;
    }

    // set 2 (recursive, the remainder).
    setupBlots(req - count1);
    const blots2 = blots;
    const count2 = blotCount;

    // translate set 2 the other way.
    for (let n = 0; n < count2; n++) {
      blots2[n].x -= tx;
      blots2[n].y -= ty;
      blots2[n].z -= tz;
    }

    // combine.
    blotCount = count1 + count2;
    blots = blots1.concat(blots2);

    scaleBlotsToRadius1();
    randomlyReorderBlots();
  }

  // ---- main blot setup --------------------------------------------------

  // Set up the blots for a fresh shape (the C's setupBlots): an 11-way roll,
  // cases 8/9/10 all -> duo. `req` defaults to config.count; duo recurses here
  // with a halved req (see setupBlotsDuo), so this is also the recursion target.
  function setupBlots(req) {
    if (req === undefined) req = Math.max(1, Math.round(config.count));
    const which = Math.trunc(rand01() * 11);   // 0..10
    switch (which) {
      case 0: setupBlotsCube(req); break;
      case 1: setupBlotsSphere(req); break;
      case 2: setupBlotsCylinder(req); break;
      case 3: setupBlotsSquiggle(req); break;
      case 4: setupBlotsCubeCorners(req); break;
      case 5: setupBlotsTetrahedron(req); break;
      case 6: setupBlotsSheet(req); break;
      case 7: setupBlotsSwirlyCone(req); break;
      case 8:
      case 9:
      case 10:
        setupBlotsDuo(req); break;
    }
    // guard: every shape must leave a non-empty set (e.g. a degenerate req).
    if (!blots || blotCount < 1) setupBlotsSphere(Math.max(1, req));
  }

  // ---- colour ramp ------------------------------------------------------

  // The C's setupColormap picks two random RGB colours, converts each to HSV and
  // keeps ONLY the hue, then forces endpoint 1 to (h1, s=1, v=1) — vivid — and
  // endpoint 2 to (h2, s=0.7, v=0.7) — dimmer/less saturated — and fills an OPEN
  // (non-closed) make_color_ramp of `ncolors` entries between them. Built ONCE at
  // init (the C never rebuilds the colormap on a shape change). Index 0..n-1 maps
  // the C's gcs[1..colorCount]: colour 1 (nearest the light) = the vivid h1 end,
  // colour n (farthest from it) = the dim h2 end.
  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    const h1 = Math.trunc(rand01() * 360);
    const h2 = Math.trunc(rand01() * 360);
    palette = makeColorRampRGB(h1, 1.0, 1.0, h2, 0.7, 0.7, n, false)
      .map(([r, g, b]) => `rgb(${r},${g},${b})`);
  }

  // ---- simulation -------------------------------------------------------

  // Render the blots into per-colour Path2D buckets with the current rotation,
  // scale, light, and jitter (the C's renderSegs, but emitting straight into
  // colour buckets instead of a flat LineSegment array).
  function renderSegs(paths) {
    const sinX = Math.sin(xRot), cosX = Math.cos(xRot);
    const sinY = Math.sin(yRot), cosY = Math.cos(yRot);
    const sinZ = Math.sin(zRot), cosZ = Math.cos(zRot);
    const n = palette.length;
    const mnr = config.maxNerveRadius;

    // reusable 3x3 grids of projected screen coords.
    const gx = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const gy = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];

    for (let b = 0; b < blotCount; b++) {
      const blot = blots[b];
      let x1 = blot.x, y1 = blot.y, z1 = blot.z;
      let x2, y2, z2;

      // rotate on z axis
      x2 = x1 * cosZ - y1 * sinZ;
      y2 = x1 * sinZ + y1 * cosZ;
      z2 = z1;

      // rotate on x axis
      y1 = y2 * cosX - z2 * sinX;
      z1 = y2 * sinX + z2 * cosX;
      x1 = x2;

      // rotate on y axis
      z2 = z1 * cosY - x1 * sinY;
      x2 = z1 * sinY + x1 * cosY;
      y2 = y1;

      // colour from squared distance of the post-rotation blot to the light.
      const lx = x2 - lightX, ly = y2 - lightY, lz = z2 - lightZ;
      let color = 1 + ((lx * lx + ly * ly + lz * lz) / 4) * n;
      if (color > n) color = n;
      let ci = Math.trunc(color) - 1;   // gcs[color] -> palette[color-1]
      if (ci < 0) ci = 0;
      else if (ci >= n) ci = n - 1;

      // base screen coords (+ drift offsets), then the per-blot radius.
      const baseX = x2 / 2 * baseScale * curScale + centerX + centerXOff;
      const baseY = y2 / 2 * baseScale * curScale + centerY + centerYOff;
      const radius = (z2 + 1) / 2 * (maxRadius - minRadius) + minRadius;

      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          gx[i][j] = baseX + ((i - 1) + (blot.xoff[i][j] * mnr)) * radius;
          gy[i][j] = baseY + ((j - 1) + (blot.yoff[i][j] * mnr)) * radius;
        }
      }

      const path = paths[ci];
      // the outline: blotShape[i-1] -> blotShape[i], indexing grid[x+1][y+1].
      for (let i = 1; i < blotShapeCount; i++) {
        const ax = blotShape[i - 1][0] + 1, ay = blotShape[i - 1][1] + 1;
        const bx = blotShape[i][0] + 1,     by = blotShape[i][1] + 1;
        path.moveTo(gx[ax][ay], gy[ax][ay]);
        path.lineTo(gx[bx][by], gy[bx][by]);
      }
    }
  }

  // Reflect a jittered offset back into [-1, 1] exactly as the C does.
  function reflect(v) {
    if (v < -1) return -(v + 1) - 1;
    if (v > 1) return -(v - 1) + 1;
    return v;
  }

  // Update the model: maybe pick a new shape, ease drift toward targets, jitter
  // every offset, and on a random event jump one or more targets (updateWithFeeling).
  function updateWithFeeling() {
    // pick a new model if the time is right.
    itersTillNext--;
    if (itersTillNext < 0) {
      itersTillNext = rand01() * Math.max(1, config.maxIters);
      setupBlots();
    }

    // ease the rotation factors toward their targets.
    xRot += (xRotTarget - xRot) * ITER_AMT;
    yRot += (yRotTarget - yRot) * ITER_AMT;
    zRot += (zRotTarget - zRot) * ITER_AMT;

    // and the scale, and the light position.
    curScale += (scaleTarget - curScale) * ITER_AMT;
    lightX += (lightXTarget - lightX) * ITER_AMT;
    lightY += (lightYTarget - lightY) * ITER_AMT;
    lightZ += (lightZTarget - lightZ) * ITER_AMT;

    // jitter every blot's offsets, reflecting at the unit-square edges.
    const nrv = config.nervousness;
    for (let b = 0; b < blotCount; b++) {
      const blot = blots[b];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          blot.xoff[i][j] = reflect(blot.xoff[i][j] + randPM1() * nrv);
          blot.yoff[i][j] = reflect(blot.yoff[i][j] + randPM1() * nrv);
        }
      }
    }

    // on a random event, jump one or more drift targets.
    if (rand01() <= config.eventChance) {
      const which = Math.trunc(rand01() * 14);   // 0..13
      const twoPi = Math.PI * 2;
      switch (which) {
        case 0:
          xRotTarget = randPM1() * twoPi;
          break;
        case 1:
          yRotTarget = randPM1() * twoPi;
          break;
        case 2:
          zRotTarget = randPM1() * twoPi;
          break;
        case 3:
          xRotTarget = randPM1() * twoPi;
          yRotTarget = randPM1() * twoPi;
          break;
        case 4:
          xRotTarget = randPM1() * twoPi;
          zRotTarget = randPM1() * twoPi;
          break;
        case 5:
          yRotTarget = randPM1() * twoPi;
          zRotTarget = randPM1() * twoPi;
          break;
        case 6:
          xRotTarget = randPM1() * twoPi;
          yRotTarget = randPM1() * twoPi;
          zRotTarget = randPM1() * twoPi;
          break;
        case 7:
          centerXOff = randPM1() * maxRadius;
          break;
        case 8:
          centerYOff = randPM1() * maxRadius;
          break;
        case 9:
          centerXOff = randPM1() * maxRadius;
          centerYOff = randPM1() * maxRadius;
          break;
        case 10:
          scaleTarget = rand01() * (MAX_SCALE - MIN_SCALE) + MIN_SCALE;
          break;
        case 11:
          curScale = rand01() * (MAX_SCALE - MIN_SCALE) + MIN_SCALE;
          break;
        case 12:
          lightX = randPM1();
          lightY = randPM1();
          lightZ = randPM1();
          break;
        case 13:
          lightXTarget = randPM1();
          lightYTarget = randPM1();
          lightZTarget = randPM1();
          break;
      }
    }
  }

  // One iteration: update the model, render to colour buckets, repaint.
  function step() {
    updateWithFeeling();
    draw();
  }

  // Clear to black and stroke each colour bucket once (the C's eraseAndDraw,
  // collapsed: full repaint instead of erase-old + draw-new line by line).
  function draw() {
    const n = palette.length;
    const paths = new Array(n);
    for (let i = 0; i < n; i++) paths[i] = new Path2D();

    renderSegs(paths);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = Math.max(1, Math.round(config.lineWidth * S)) || 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < n; i++) {
      ctx.strokeStyle = palette[i];
      ctx.stroke(paths[i]);
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    centerX = W / 2;
    centerY = H / 2;
    baseScale = Math.min(W, H);
    minRadius = MIN_RADIUS * S;
    maxRadius = MAX_RADIUS * S;
    centerXOff = 0;
    centerYOff = 0;

    buildPalette();
    setupBlots();

    // initial rotation/scale/light random, with targets equal to the start.
    xRot = xRotTarget = rand01() * Math.PI;
    yRot = yRotTarget = rand01() * Math.PI;
    zRot = zRotTarget = rand01() * Math.PI;
    curScale = scaleTarget = rand01() * (MAX_SCALE - MIN_SCALE) + MIN_SCALE;
    lightX = lightXTarget = randPM1();
    lightY = lightYTarget = randPM1();
    lightZ = lightZTarget = randPM1();

    itersTillNext = rand01() * Math.max(1, config.maxIters);
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

  // rAF lag-accumulator loop paced at (config.delay + OVERHEAD) us (/1000 for the
  // ms rAF clock), with the same catch-up cap as squiral so a backgrounded tab
  // doesn't burst on refocus. Each step() fully repaints, so there is no
  // separate background pass.
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

  // Re-seed with the current config (clears the canvas; count/colors may differ).
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
