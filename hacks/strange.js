// strange.js — strange packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's strange.c (Massimino Pascal, 1997; point size / zoom /
// brightness / motion blur and the dense "accumulator" renderer added by
// dmo2118, 2017). https://www.jwz.org/xscreensaver/
//
// A 2-D strange attractor: iterate one of two non-linear polynomial maps with
// random Gaussian-ish coefficients, plotting many points per frame. The
// coefficients drift from one random set toward the next (Prm1 -> Prm2 over
// `Count`) and snap to a fresh target when the drift completes, so the figure
// reconfigures through an endless sequence of attractors.
//
// strange.c has TWO renderers, chosen AT RUNTIME by the point count:
//   * useAccumulator == (points > 6000). With the DEFAULT points = 5500 this is
//     FALSE, so the default is the SIMPLE renderer: each frame clears the screen
//     and plots the whole orbit as a swarm of dots in a SINGLE colour, that
//     colour cycling one step per frame through the palette (A->Col++). No
//     accumulation, no trails — the "swarm of dots [that] swoops and twists".
//   * For points > 6000 (e.g. the C's own hint, -points 500000) it switches to
//     the ACCUMULATOR: a per-pixel hit-count field, a box-blur bloom of radius
//     point-size, an optional IIR motion-blur feedback, then a fixed `colorScale`
//     maps accumulated density into a 150-entry logarithmic brightness ramp
//     tinted by the cycling base colour, so dense parts glow.
//
// This module mirrors both: it runs the simple swarm at the default, and the
// accumulator only once Number-of-points crosses 6000 (which is also why the
// default is cheap). Palette is make_smooth_colormap (colormap.js), matching the
// C's SMOOTH_COLORS framework map; the accumulator's brightness ramp is the C's
// exact ramp_color. See [[hopalong]] / [[thornbird]] for the swarm twins and
// strange.md for the full fidelity notes.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'strange';

export const info = {
  author: 'Massimino Pascal',
  description: 'Strange attractors: a swarm of dots swoops and twists around.\n\nhttps://en.wikipedia.org/wiki/Attractor#Strange_attractor',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/strange.xml so the config box maps 1:1
  // to the original.
  //   curve      — the "curve factor" feeding the Gaussian coefficient draw
  //                (z = curve/10); higher = wilder coefficients. <10 also forces
  //                the projective Iterate_X3 map (the C avoids "boring" X2).
  //   points     — points/iterations plotted per frame; >6000 switches to the
  //                accumulator renderer (the C's `useAccumulator`).
  //   pointSize  — point size in px (a box-blur bloom in accumulator mode).
  //   zoom       — view scale (the C default 0.9 ~= 1/1.1).
  //   brightness — accumulator intensity->colour multiplier (no effect simple).
  //   motionBlur — accumulator IIR trail feedback, 1 = none (no effect simple).
  //   ncolors    — size of the make_smooth_colormap base palette (MI_NPIXELS),
  //                cycled one step per frame. (The accumulator's ramp is a
  //                separate fixed 150 entries, the C's DEF_NUM_COLS.)
  const config = {
    delay: 10000,      // microseconds between frames (--delay)
    curve: 10,         // coefficient "curviness" (--curve)
    points: 5500,      // points plotted per frame (--points)
    pointSize: 1,      // point size / bloom radius in px (--point-size)
    zoom: 0.9,         // view scale (--zoom)
    brightness: 1.0,   // accumulator intensity->colour multiplier (--brightness)
    motionBlur: 3.0,   // accumulator IIR trail feedback, 1 = none (--motion-blur)
    ncolors: 100,      // base palette size, cycled per frame (--ncolors)
  };

  // live: true  -> the loop reads config[key] every frame, applies instantly.
  // live: false -> the value sizes buffers / the ramp / picks the map / switches
  //                renderer, so a change re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'curve', label: 'Curviness', type: 'range', min: 1, max: 50, step: 1, default: 10, lowLabel: 'low', highLabel: 'high', live: false },
    { key: 'points', label: 'Number of points', type: 'range', min: 1000, max: 500000, step: 1000, default: 5500, lowLabel: '1k', highLabel: '500k', live: false },
    { key: 'pointSize', label: 'Point size', type: 'range', min: 1, max: 8, step: 1, default: 1, lowLabel: '1', highLabel: '8', live: false },
    { key: 'zoom', label: 'Zoom', type: 'range', min: 0.1, max: 4.0, step: 0.1, default: 0.9, lowLabel: '10%', highLabel: '400%', live: true },
    { key: 'brightness', label: 'Brightness', type: 'range', min: 0.1, max: 4.0, step: 0.1, default: 1.0, lowLabel: '10%', highLabel: '400%', live: true },
    { key: 'motionBlur', label: 'Motion blur', type: 'range', min: 1.0, max: 10.0, step: 0.5, default: 3.0, lowLabel: '1', highLabel: '10', live: true },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 100, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // ---- fixed-point constants (verbatim from the C) -----------------------
  const UNIT_BITS = 12;
  const UNIT = 1 << UNIT_BITS;       // 4096; world [-1,1] -> [-UNIT, UNIT]
  const UNIT2 = 1 << 14;             // 16384; size of the Fold (sine) table
  const COLOR_BITS = 16;             // accumulator colorScale fixed-point shift
  const SKIP_FIRST = 100;            // settle iterations before plotting
  const MAX_PRM = 3 * 5;             // 15 coefficients
  const ACC_GAMMA = 10.0;            // ramp log gamma
  const DEF_NUM_COLS = 150;          // accumulator brightness-ramp size
  const ACC_THRESHOLD = 6000;        // useAccumulator == (points > 6000)

  const BLACK = 0xFF000000;
  const WHITE = 0xFFFFFFFF >>> 0;

  // Gaussian "amplitude" (3*sigma) and mean for each of the 15 coefficients.
  const AMP_PRM = [
    1.0, 3.5, 3.5, 2.5, 4.7,
    1.0, 3.5, 3.6, 2.5, 4.7,
    1.0, 1.5, 2.2, 2.1, 3.5,
  ];
  const MID_PRM = [
    0.0, 1.5, 0.0, 0.5, 1.5,
    0.0, 1.5, 0.0, 0.5, 1.5,
    0.0, 1.5, -1.0, -0.5, 2.5,
  ];

  let W, H, S;                 // canvas size (device px) and devicePixelRatio
  let imageData, pixels;       // output Uint32 ImageData buffer (both renderers)
  let accMap;                  // Uint32 intensity field (accumulator only)
  let motionBuf;               // Float32 bloom/IIR feedback field (accumulator only)
  let fold;                    // Int32 sine-fold table, length UNIT2+1
  let baseCols;                // make_smooth_colormap base palette: [r,g,b][] (or null when mono)
  let cols;                    // Uint32 packed-ABGR brightness ramp (accumulator)
  let numCols;                 // ramp size: DEF_NUM_COLS, or 2 when mono
  let ncolorsEff;             // base palette size (MI_NPIXELS); col cycles mod this
  let mono;                    // ncolors <= 2: white swarm / black-white ramp
  let useAcc;                  // points > 6000 -> accumulator renderer
  let maxPt;                   // points plotted per frame

  let prm1, prm2, prm;         // coefficient sets: from, to, current (Float64)
  let iprm;                    // current coefficients in fixed-point (Int32)
  let iterate;                 // 0 = Iterate_X2, 1 = Iterate_X3 (projective)
  let pointSize;               // point size / bloom radius in device px
  let count, speed, col;       // drift position, drift speed, colour phase

  // ---- random helpers ----------------------------------------------------
  // The C uses three PRNGs (NRAND/GOODRND/CHEAPRND) for thread-safety and speed;
  // the only randomness that reaches the picture is the ±4 settle/iteration
  // jitter and the coefficient draws, so a plain uniform stream is faithful.
  const rnd = Math.random;            // uniform [0,1)
  const nrand = (n) => (rnd() * n) | 0;

  // Old_Gauss_Rand(c, A, S): the C's coefficient draw. y is uniform [0,1);
  // z = curve/10; the result is c +/- A*(z - exp(-y*y*S))/(z - exp(-S)).
  function oldGaussRand(c, A, Sg) {
    const z = Math.max(1, Math.round(config.curve)) / 10;
    let y = rnd();
    y = A * (z - Math.exp(-y * y * Sg)) / (z - Math.exp(-Sg));
    return nrand(2) ? (c + y) : (c - y);
  }

  function randomPrm(out) {
    for (let i = 0; i < MAX_PRM; i++) {
      out[i] = oldGaussRand(MID_PRM[i], AMP_PRM[i], 4.0);
    }
  }

  // ---- the sine-fold ("DO_FOLD") -----------------------------------------
  // Odd-extended sine lookup: fold[i] = sin(i/UNIT) scaled to fixed-point,
  // indexed by (a & (UNIT2-1)) and negated for a < 0. Callers pass an int32
  // (|0) so the bitwise & is exact.
  function doFold(a) {
    return a < 0 ? -fold[(-a) & (UNIT2 - 1)] : fold[a & (UNIT2 - 1)];
  }

  // ---- the two non-linear maps (fixed-point, verbatim) -------------------
  // x, y, and the outputs are PRM (fixed-point ints, world [-1,1] = [-UNIT,UNIT]).
  // JS numbers are doubles, so x*x can exceed 2^31; we keep the math in double
  // and apply >>UNIT_BITS via Math.floor(/UNIT) to stay exact past 32 bits.
  const SH = 1 / UNIT;        // == >> UNIT_BITS as a divide (for big products)
  function shr(v) { return Math.floor(v * SH); }   // arithmetic >>UNIT_BITS

  // Returns [xo, yo].
  const out = [0, 0];
  function iterX2(x, y) {
    const P = iprm;
    const xx = shr(x * x);
    const x2y = shr(xx * y);
    const yy = shr(y * y);
    const y2x = shr(yy * x);
    const xy = shr(x * y);

    let t = P[1] * xx + P[2] * xy + P[3] * yy + P[4] * x2y;
    t = P[0] - y + shr(t);
    out[0] = doFold(t | 0);
    t = P[6] * xx + P[7] * xy + P[8] * yy + P[9] * y2x;
    t = P[5] + x + shr(t);
    out[1] = doFold(t | 0);
    return out;
  }

  function iterX3(x, y) {
    const P = iprm;
    const xx = shr(x * x);
    const x2y = shr(xx * y);
    const yy = shr(y * y);
    const y2x = shr(yy * x);
    const xy = shr(x * y);

    let tx = P[1] * xx + P[2] * xy + P[3] * yy + P[4] * x2y;
    tx = P[0] - y + shr(tx);
    tx = doFold(tx | 0);

    let ty = P[6] * xx + P[7] * xy + P[8] * yy + P[9] * y2x;
    ty = P[5] + x + shr(ty);
    ty = doFold(ty | 0);

    let tz = P[11] * xx + P[12] * xy + P[13] * yy + P[14] * y2x;
    tz = P[10] + x + shr(tz);
    let tz0 = UNIT + shr(tz * tz);
    if (tz0 === 0) tz0 = 1;   // can happen with -curve 9

    out[0] = Math.floor((tx * UNIT) / tz0);
    out[1] = Math.floor((ty * UNIT) / tz0);
    return out;
  }

  function step1(x, y) { return iterate === 0 ? iterX2(x, y) : iterX3(x, y); }

  // ---- colour ------------------------------------------------------------
  function packRGB(r, g, b) {
    r = r < 0 ? 0 : r > 255 ? 255 : r;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    b = b < 0 ? 0 : b > 255 ? 255 : b;
    return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }

  // ramp_color (verbatim from the C): a base colour ramped logarithmically from
  // near-black to bright across the n ramp entries. Used by the accumulator to
  // turn accumulated density into brightness.
  function rampColor(baseR, baseG, baseB, i, n) {
    const MINBLUE = 1;
    const FULLBLUE = 128;
    const li = MINBLUE
      + (255.0 - MINBLUE) * Math.log(1.0 + ACC_GAMMA * i / n) / Math.log(1.0 + ACC_GAMMA);
    let r, g, b;
    if (li < FULLBLUE) {
      r = baseR * li / FULLBLUE;
      g = baseG * li / FULLBLUE;
      b = baseB * li / FULLBLUE;
    } else {
      r = (255 - baseR) * (li - FULLBLUE) / (256 - FULLBLUE) + baseR;
      g = (255 - baseG) * (li - FULLBLUE) / (256 - FULLBLUE) + baseG;
      b = (255 - baseB) * (li - FULLBLUE) / (256 - FULLBLUE) + baseB;
    }
    return [r | 0, g | 0, b | 0];
  }

  // Rebuild the accumulator brightness ramp for this frame. The C does this every
  // frame in TrueColor: src_color = palette[Col % MI_NPIXELS] (the cycling base
  // colour), then ramp_color tints the whole near-black -> bright ramp by it.
  function buildRamp() {
    if (mono) { cols[0] = BLACK; cols[1] = WHITE; return; }
    const src = baseCols[col % ncolorsEff];
    for (let i = 0; i < numCols; i++) {
      const [r, g, b] = rampColor(src[0], src[1], src[2], i, numCols);
      cols[i] = packRGB(r, g, b);
    }
  }

  // ---- drift / reroll (shared by both renderers) -------------------------
  // Commit the drift target and roll a fresh one (the C's Count>=1000 branch).
  function commit() {
    for (let i = MAX_PRM - 1; i >= 0; i--) prm1[i] = prm2[i];
    randomPrm(prm2);
    count = 0;
  }
  function addCount(n) {
    count += n;
    if (count >= 1000) commit();
  }

  // Interpolate the current coefficients between prm1 and prm2 (u = count/40000,
  // verbatim — a small drift, then the commit() snap) into the fixed-point iprm.
  function interpCoeffs() {
    const u = count / 40000.0;
    for (let j = MAX_PRM - 1; j >= 0; j--) {
      prm[j] = (1.0 - u) * prm1[j] + u * prm2[j];
      iprm[j] = (UNIT * prm[j]) | 0;   // DBL_To_PRM
    }
  }

  // ---- the SIMPLE renderer (default; points <= 6000) ---------------------
  // Each frame: clear, plot the whole orbit as a swarm of dots in ONE colour
  // (the cycling base colour), no accumulation / no trails. brightness and
  // motionBlur have no effect here (the C ignores them in this path).
  function stepSimple() {
    interpCoeffs();

    // recalc_scale with AUTO_ZOOM off: world box fixed to [-UNIT, UNIT].
    const zoom = config.zoom;
    const Lx = zoom * W / (2 * UNIT);
    const Ly = -zoom * H / (2 * UNIT);
    const cx = (W / 2) | 0;
    const cy = (H / 2) | 0;

    // init_draw: settle from the origin with ±4 jitter (no plotting).
    let x = 0, y = 0;
    for (let n = SKIP_FIRST; n; n--) {
      const o = step1(x, y);
      x = o[0] + (nrand(8) - 4);
      y = o[1] + (nrand(8) - 4);
    }

    pixels.fill(BLACK);
    // The whole swarm is one colour: palette[Col % ncolors], cycling per frame.
    let c = WHITE;
    if (!mono) { const bc = baseCols[col % ncolorsEff]; c = packRGB(bc[0], bc[1], bc[2]); }
    const ps = pointSize;

    // Plot the INPUT (x, y) of each iteration (matching the C's x1 = Lx*x + cx),
    // then advance. (int) truncates toward zero, which |0 reproduces in range.
    for (let n = maxPt; n; n--) {
      const x1 = ((Lx * x) | 0) + cx;
      const y1 = ((Ly * y) | 0) + cy;
      if (ps === 1) {
        if (x1 >= 0 && x1 < W && y1 >= 0 && y1 < H) pixels[y1 * W + x1] = c;
      } else {
        // Rectangle at (x1 - ps + 1, y1): matches the bloom position the C uses.
        const bx = x1 - ps + 1;
        const xs = bx < 0 ? 0 : bx;
        const xe = bx + ps > W ? W : bx + ps;
        const ys = y1 < 0 ? 0 : y1;
        const ye = y1 + ps > H ? H : y1 + ps;
        for (let yy = ys; yy < ye; yy++) {
          const rb = yy * W;
          for (let xx = xs; xx < xe; xx++) pixels[rb + xx] = c;
        }
      }
      const o = step1(x, y);
      x = o[0] + (nrand(8) - 4);
      y = o[1] + (nrand(8) - 4);
    }

    ctx.putImageData(imageData, 0, 0);

    // Drift: the simple path leaves Speed at 4 (the VARY_SPEED block lives in the
    // accumulator branch), and the bbox "boring" test is dead here because Ly < 0
    // makes (ymax-ymin < Ly*0.2) always false. So Count advances by a steady 4.
    addCount(speed);
    col++;
  }

  // ---- the ACCUMULATOR renderer (points > 6000) --------------------------
  // Re-accumulate the whole attractor into a hit-count field, box-blur bloom it,
  // run an optional IIR motion blur, then map density -> the brightness ramp via
  // the C's exact fixed `colorScale`. STRUCTURAL — verify against the live binary.
  function stepAccumulator() {
    interpCoeffs();

    const zoom = config.zoom;
    const Lx = zoom * W / (2 * UNIT);
    const Ly = -zoom * H / (2 * UNIT);
    const cx = (W / 2) | 0;
    const cy = (H / 2) | 0;

    accMap.fill(0);

    let x = 0, y = 0;
    for (let n = SKIP_FIRST; n; n--) {
      const o = step1(x, y);
      x = o[0] + (nrand(8) - 4);
      y = o[1] + (nrand(8) - 4);
    }

    // Plot the INPUT (x, y) of each iteration into the hit-count field.
    for (let n = maxPt; n; n--) {
      const mx = ((Lx * x) | 0) + cx;
      const my = ((Ly * y) | 0) + cy;
      if (mx >= 0 && mx < W && my >= 0 && my < H) accMap[my * W + mx]++;
      const o = step1(x, y);
      x = o[0] + (nrand(8) - 4);
      y = o[1] + (nrand(8) - 4);
    }

    buildRamp();

    // IIR motion blur (recomputed live from config.motionBlur):
    //   blurFac = (mb-1)/(mb+1) in [0,1);  colorFac = 2/(mb+1) compensates the
    //   feedback's energy gain in colorScale.
    const mb = config.motionBlur;
    const blurFac = (mb - 1) / (mb + 1);
    const colorFac = 2 / (mb + 1);
    const useBlur = blurFac > 0;

    // colorScale: the C's fixed density->ramp-index factor (verbatim). Calibrated
    // for high point counts, which is exactly when the accumulator runs. Truncated
    // to an integer to match the C's `unsigned long`.
    const brightness = config.brightness;
    let colorScale = Math.floor(
      W * H
      * (1 << COLOR_BITS) * brightness
      * colorFac
      * (zoom * zoom) / (0.9 * 0.9)
      / 640.0 / 480.0
      / (pointSize * pointSize)
      * 800000.0
      / maxPt
      * numCols / 256
    );
    if (mono) colorScale *= 4;   // brighter for monochrome

    const lastCol = numCols - 1;
    const ps = pointSize;
    let pixelCount = 0;

    for (let j = 0; j < H; j++) {
      const rowBase = j * W;
      for (let i = 0; i < W; i++) {
        // Bloom: sum the ps x ps block whose top-left is (i, j), expanding
        // right/down to match the C's in-place box blur. ps 1 is a single read.
        let bloom = accMap[rowBase + i];
        if (ps > 1) {
          bloom = 0;
          const xend = i + ps < W ? i + ps : W;
          const yend = j + ps < H ? j + ps : H;
          for (let yy = j; yy < yend; yy++) {
            const rb = yy * W;
            for (let xx = i; xx < xend; xx++) bloom += accMap[rb + xx];
          }
        }
        const idx = rowBase + i;
        const v = useBlur ? motionBuf[idx] * blurFac + bloom : bloom;
        motionBuf[idx] = v;

        let c = (v * colorScale / 65536) | 0;   // (v * colorScale) >> COLOR_BITS
        if (c > lastCol) c = lastCol;
        if (c > 0 && c < lastCol) pixelCount++;  // VARY_SPEED: skip maxed-out
        pixels[idx] = cols[c];
      }
    }

    ctx.putImageData(imageData, 0, 0);

    // VARY_SPEED_TO_AVOID_BOREDOM (accumulator block): the bbox branch is dead
    // (Ly < 0), so only the pixelCount branch fires — accelerate the drift while
    // the attractor has collapsed to a few lit pixels, else reset Speed to 4.
    if (pixelCount > 0 && pixelCount < (W * H) / 1000) {
      speed = Math.min(32, (speed * 1.25) | 0);   // C's Speed is int (truncates)
    } else {
      speed = 4;
    }
    addCount(speed);
    // The C then runs the shared bottom drift block too (a second increment, its
    // bbox branch likewise dead): so the accumulator advances Count by 2*Speed.
    addCount(speed);
    col++;
  }

  function step() { return useAcc ? stepAccumulator() : stepSimple(); }

  // ---- setup -------------------------------------------------------------
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // The C triples pointSize on retina (>2560px). We scale it by dpr instead so
    // a logical point-size of 1 stays ~1 CSS px crisp. (A SIZE, so dpr-scaling is
    // correct — and colorScale's W*H/pointSize^2 keeps the look dpr-invariant.)
    pointSize = Math.max(1, Math.round(config.pointSize * S));

    maxPt = Math.max(1, Math.round(config.points));
    useAcc = maxPt > ACC_THRESHOLD;

    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    // Build the sine-fold table: fold[i] = round(sin(i/UNIT) * UNIT).
    fold = new Int32Array(UNIT2 + 1);
    for (let i = 0; i <= UNIT2; i++) {
      fold[i] = (UNIT * Math.sin(i / UNIT)) | 0;
    }

    // Base palette: make_smooth_colormap of `ncolors` entries (the C's framework
    // map, MI_NPIXELS), cycled one entry per frame. Built ONCE per init — the C
    // does not rebuild it on a reroll. ncolors<=2 is the C's monochrome case.
    ncolorsEff = Math.max(1, Math.min(255, Math.round(config.ncolors)));
    mono = ncolorsEff <= 2;
    baseCols = mono ? null : makeSmoothColormapRGB(ncolorsEff);

    // Accumulator brightness ramp: DEF_NUM_COLS = 150 (or 2 mono). Independent of
    // ncolors. Filled per frame by buildRamp() (mono is constant).
    numCols = mono ? 2 : DEF_NUM_COLS;
    cols = new Uint32Array(numCols);

    // Pick the map. curve < 10 forces the projective Iterate_X3 (the C avoids
    // "boring" Iterate_X2 there); otherwise pick at random.
    const curve = Math.max(1, Math.round(config.curve));
    iterate = curve < 10 ? 1 : nrand(2);

    // Coefficient sets.
    prm1 = new Float64Array(MAX_PRM);
    prm2 = new Float64Array(MAX_PRM);
    prm = new Float64Array(MAX_PRM);
    iprm = new Int32Array(MAX_PRM);
    randomPrm(prm1);
    randomPrm(prm2);

    // Accumulator buffers (only when the accumulator renderer is active).
    if (useAcc) {
      accMap = new Uint32Array(W * H);
      motionBuf = new Float32Array(W * H);
    } else {
      accMap = null;
      motionBuf = null;
    }

    count = 0;
    speed = 4;
    col = nrand(ncolorsEff);   // A->Col = NRAND(MI_NPIXELS)
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag accumulator paced by config.delay (µs), with a catch-up cap so a
  // backgrounded tab doesn't fire a burst of frames on refocus. The simple
  // default renderer is light; the accumulator does a full W*H pass, so the low
  // cap keeps refocus snappy in either mode.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead — see the framerate-calibration note). The
  // live strange measures 55.3 fps (the default simple swarm), but the port at
  // the stock 10000 µs ran 100 steps/sec (1.81x fast). 10000 + 8083 = 18083 µs
  // -> 55.3 steps/sec, matching the live binary. A calibration, not a tuning knob
  // (the slider still maps 1:1 to the xml delay).
  const OVERHEAD = 8083;
  const MAX_CATCHUP_STEPS = 4;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;   // xml units are microseconds
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
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
    reinit: init,   // fresh buffers + new attractor with the current config
    config,
    params,
  };
}
