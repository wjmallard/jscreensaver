// strange.js — strange packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's strange.c (Massimino Pascal, 1997; accumulator mode
// and many enhancements by dmo2118, 2017). https://www.jwz.org/xscreensaver/
//
// A 2-D strange attractor: iterate one of two non-linear polynomial maps with
// random Gaussian-ish coefficients, plotting many points (the "Points" knob,
// default 5500) per frame. Every frame re-accumulates the WHOLE attractor into
// an intensity field (a hit-count per pixel), then maps accumulated intensity to
// a logarithmic colour ramp — so dense parts of the orbit glow brighter. The
// coefficients drift slowly from one random set to the next (Prm1 -> Prm2 over
// `Count`), so the figure continuously swoops and twists; when the drift reaches
// the end it commits and rolls a fresh target, giving an endless sequence of
// attractors. Optional motion blur (IIR feedback) leaves trails as it morphs.
//
// Rendering: this is the dense per-pixel ACCUMULATOR path (like thornbird /
// binaryring) — a Uint32 intensity buffer we add into per point hit, then a
// second Uint32 ImageData buffer we colour-map and putImageData once per frame.
// Unlike thornbird/hopalong the intensity field is rebuilt every frame (the C
// memsets accMap each frame); the animation is the coefficient drift + the IIR
// motion-blur feedback, not a progressively-accumulating canvas.
//
// See [[thornbird]] and [[hopalong]] for the strange-attractor point-plot twins,
// and [[squiral]] for the shared module skeleton.

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
  //   points     — points/iterations plotted per frame (the swarm density).
  //   pointSize  — point size in px; in accumulator mode this is a box-blur bloom.
  //   zoom       — view scale (the C default 0.9 ~= 1/1.1).
  //   brightness — multiplies the intensity->colour mapping.
  //   motionBlur — IIR feedback amount for trails (1 = none).
  //   ncolors    — size of the logarithmic colour ramp.
  const config = {
    delay: 10000,      // microseconds between frames (--delay)
    curve: 10,         // coefficient "curviness" (--curve)
    points: 5500,      // points plotted per frame (--points)
    pointSize: 1,      // point size / bloom radius in px (--point-size)
    zoom: 0.9,         // view scale (--zoom)
    brightness: 1.0,   // intensity->colour multiplier (--brightness)
    motionBlur: 3.0,   // IIR trail feedback, 1 = none (--motion-blur)
    ncolors: 100,      // size of the colour ramp (--ncolors)
  };

  // live: true  -> the loop reads config[key] every frame, applies instantly.
  // live: false -> the value sizes buffers / the ramp / picks the map, so a
  //                change re-runs init() via reinit() (clearing the canvas).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'curve', label: 'Curviness', type: 'range', min: 1, max: 50, step: 1, default: 10, lowLabel: 'low', highLabel: 'high', live: false },
    { key: 'points', label: 'Number of points', type: 'range', min: 1000, max: 500000, step: 1000, default: 5500, lowLabel: '1k', highLabel: '500k', live: false },
    { key: 'pointSize', label: 'Point size', type: 'range', min: 1, max: 8, step: 1, default: 1, lowLabel: '1', highLabel: '8', live: false },
    { key: 'zoom', label: 'Zoom', type: 'range', min: 0.1, max: 4.0, step: 0.1, default: 0.9, lowLabel: '10%', highLabel: '400%', live: true },
    { key: 'brightness', label: 'Brightness', type: 'range', min: 0.1, max: 4.0, step: 0.1, default: 1.0, lowLabel: '10%', highLabel: '400%', live: true },
    { key: 'motionBlur', label: 'Motion blur', type: 'range', min: 1.0, max: 10.0, step: 0.5, default: 3.0, lowLabel: '1', highLabel: '10', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 100, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // ---- fixed-point constants (verbatim from the C) -----------------------
  const UNIT_BITS = 12;
  const UNIT = 1 << UNIT_BITS;       // 4096; world [-1,1] -> [-UNIT, UNIT]
  const UNIT2 = 1 << 14;             // 16384; size of the Fold (sine) table
  const SKIP_FIRST = 100;            // settle iterations before plotting
  const MAX_PRM = 3 * 5;             // 15 coefficients
  const ACC_GAMMA = 10.0;            // ramp log gamma

  const BLACK = 0xFF000000;

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
  let imageData, pixels;       // output Uint32 ImageData buffer
  let accMap;                  // Uint32 intensity field (hit count per pixel)
  let motionBuf;               // Float32 colour-map working field + IIR feedback
  let fold;                    // Int32 sine-fold table, length UNIT2+1
  let cols;                    // Uint32 packed-ABGR colour ramp (length numCols)
  let numCols;

  let prm1, prm2, prm;         // coefficient sets: from, to, current (Float64)
  let iprm;                    // current coefficients in fixed-point (Int32)
  let iterate;                 // 0 = Iterate_X2, 1 = Iterate_X3 (projective)
  let pointSize;               // bloom radius in device px
  let count, speed, col;       // drift position, drift speed, colour phase
  let blurFac;                 // IIR feedback factor in [0,1)
  let colorFac;                // motion-blur colour compensation

  // ---- random helpers ----------------------------------------------------
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
  // indexed by (a & (UNIT2-1)) and negated for a < 0. Bitwise & on a possibly-
  // 32-bit-overflowing product needs |0 first, which the callers ensure.
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

  // ---- colour ramp (ramp_color, faithful) --------------------------------
  // The C ramps a base hue logarithmically from near-black to bright. We pick a
  // fresh base hue from the rainbow each ramp build so the whole image tints
  // toward one colour, slowly cycling (col++ each frame, used to shift the hue).
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

  // hsl (h in [0,1)) -> [r,g,b] each 0-255 (vivid rainbow base hues).
  function hslToRgb(h, s, l) {
    const c2 = (1 - Math.abs(2 * l - 1)) * s;
    const x = c2 * (1 - Math.abs(((h * 6) % 2) - 1));
    const m = l - c2 / 2;
    let r = 0, g = 0, b = 0;
    const seg = Math.floor(h * 6) % 6;
    if (seg === 0) { r = c2; g = x; }
    else if (seg === 1) { r = x; g = c2; }
    else if (seg === 2) { g = c2; b = x; }
    else if (seg === 3) { g = x; b = c2; }
    else if (seg === 4) { r = x; b = c2; }
    else { r = c2; b = x; }
    return [
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255),
    ];
  }

  // Rebuild the colour ramp around the base hue for this frame's `col` phase.
  function buildCols() {
    const n = numCols;
    cols = new Uint32Array(n);
    // Base hue drifts with col (slow colour cycle, like the C's A->Col).
    const [br, bg, bb] = hslToRgb(((col % 256) / 256), 1, 0.6);
    for (let i = 0; i < n; i++) {
      const [r, g, b] = rampColor(br, bg, bb, i, n);
      cols[i] = (0xff << 24 | b << 16 | g << 8 | r) >>> 0;
    }
  }

  // ---- one frame ---------------------------------------------------------
  // Re-accumulate the whole attractor into accMap, colour-map (with optional
  // IIR motion blur), drift the coefficients, advance the colour phase.
  function step() {
    // Interpolate current coefficients between prm1 and prm2 (slow morph).
    const u = count / 40000.0;
    for (let j = MAX_PRM - 1; j >= 0; j--) {
      prm[j] = (1.0 - u) * prm1[j] + u * prm2[j];
      iprm[j] = (UNIT * prm[j]) | 0;   // DBL_To_PRM
    }

    // Scale: with AUTO_ZOOM off the C clamps the world box to [-UNIT, UNIT].
    // Lx = zoom*W/(2*UNIT), Ly = -zoom*H/(2*UNIT); centre at (W/2, H/2).
    const zoom = config.zoom;
    const Lx = zoom * W / (2 * UNIT);
    const Ly = -zoom * H / (2 * UNIT);
    const cx = W / 2;
    const cy = H / 2;

    // Clear the intensity field (the C memsets accMap every frame).
    accMap.fill(0);

    // init_draw: settle from the origin with a little jitter (no plotting).
    let x = 0, y = 0;
    for (let n = SKIP_FIRST; n; n--) {
      const o = step1(x, y);
      x = o[0] + (nrand(8) - 4);
      y = o[1] + (nrand(8) - 4);
    }

    // Plot Max_Pt points, accumulating intensity (hit count) per pixel.
    const maxPt = Math.max(1, Math.round(config.points));
    for (let n = maxPt; n; n--) {
      const o = step1(x, y);
      const xo = o[0], yo = o[1];
      const mx = (Lx * xo + cx) | 0;
      const my = (Ly * yo + cy) | 0;
      if (mx >= 0 && mx < W && my >= 0 && my < H) {
        accMap[my * W + mx]++;
      }
      x = xo + (nrand(8) - 4);
      y = yo + (nrand(8) - 4);
    }

    buildCols();
    const lastCol = numCols - 1;
    const useBlur = blurFac > 0;
    const brightness = config.brightness;

    // Pass 1: build the field we actually colour-map. Bloom each hit into a
    // pointSize x pointSize block (the C's box-blur "point size"/bloom), feed it
    // through the IIR motion-blur (motionBuf = motionBuf*blurFac + bloomed), and
    // track the running max so the ramp is used end-to-end.
    //
    // We reuse motionBuf as the working field even when blur is off (blurFac 0
    // makes the IIR a pass-through), so the colour-map reads one buffer either way.
    let maxV = 0;
    for (let j = 0; j < H; j++) {
      const rowBase = j * W;
      for (let i = 0; i < W; i++) {
        // Bloom: sum the pointSize x pointSize block whose top-left is (i, j),
        // clamped to the canvas. pointSize 1 is just accMap[i].
        let bloom = accMap[rowBase + i];
        if (pointSize > 1) {
          bloom = 0;
          const xend = i + pointSize < W ? i + pointSize : W;
          const yend = j + pointSize < H ? j + pointSize : H;
          for (let yy = j; yy < yend; yy++) {
            const rb = yy * W;
            for (let xx = i; xx < xend; xx++) bloom += accMap[rb + xx];
          }
        }
        const mi = rowBase + i;
        const v = useBlur ? motionBuf[mi] * blurFac + bloom : bloom;
        motionBuf[mi] = v;
        if (v > maxV) maxV = v;
      }
    }

    // Pass 2: log-map the field to the full ramp. The C uses a fixed colorScale
    // (calibrated so dense spots saturate); on the web that flattens to a near-
    // uniform bright curve. Instead we normalise per frame on a log curve so the
    // density gradient (bright core -> dim filament edges) is always visible and
    // the whole ramp is used. `brightness` scales the log's knee (`colorFac`
    // compensates for the motion-blur energy gain). DEVIATION — see strange.md.
    const k = brightness * colorFac * 8;            // log knee; >0
    const denom = Math.log(1 + k * (maxV > 0 ? maxV : 1));
    const norm = denom > 0 ? lastCol / denom : 0;
    let lit = 0;
    for (let p = 0, n = W * H; p < n; p++) {
      const v = motionBuf[p];
      let cIdx = 0;
      if (v > 0) {
        cIdx = (Math.log(1 + k * v) * norm) | 0;
        if (cIdx > lastCol) cIdx = lastCol;
        lit++;
      }
      pixels[p] = cols[cIdx];
    }

    ctx.putImageData(imageData, 0, 0);

    // Drift the coefficients toward prm2. The C's VARY_SPEED_TO_AVOID_BOREDOM:
    // accelerate the drift while the attractor is visually boring (collapsed to
    // a tiny cluster), else hold a steady speed — this is what keeps a degenerate
    // projective (X3) attractor from lingering as a dead dot. `lit` is the count
    // of pixels that actually lit this frame.
    const boring = lit > 0 && lit < (W * H) / 1000;
    speed = boring ? Math.min(32, speed * 1.25) : 4;
    count += speed;
    if (count >= 1000) {
      for (let i = MAX_PRM - 1; i >= 0; i--) prm1[i] = prm2[i];
      randomPrm(prm2);
      count = 0;
    }
    col++;
  }

  // ---- setup -------------------------------------------------------------
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // The C triples pointSize on retina (>2560px). We scale by dpr instead so a
    // logical point-size of 1 stays ~1 CSS px crisp.
    pointSize = Math.max(1, Math.round(config.pointSize * S));

    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    accMap = new Uint32Array(W * H);

    // Build the sine-fold table: fold[i] = round(sin(i/UNIT) * UNIT).
    fold = new Int32Array(UNIT2 + 1);
    for (let i = 0; i <= UNIT2; i++) {
      fold[i] = (UNIT * Math.sin(i / UNIT)) | 0;
    }

    numCols = Math.max(2, Math.round(config.ncolors));

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

    // Motion-blur IIR: blurFac = (motionBlur-1)/(motionBlur+1) in [0,1);
    // colorFac = 2/(motionBlur+1) compensates the colour-map for the feedback.
    // motionBuf doubles as the colour-map's working field (pass-through when
    // blurFac is 0), so it is always allocated.
    const mb = config.motionBlur;
    blurFac = (mb - 1) / (mb + 1);
    colorFac = 2 / (mb + 1);
    motionBuf = new Float32Array(W * H);

    count = 0;
    speed = 4;
    col = nrand(256);
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
  // backgrounded tab doesn't fire a burst of frames on refocus. strange does a
  // lot of work per frame (full re-accumulate + colour-map), so a low cap keeps
  // refocus snappy.
  const MAX_CATCHUP_STEPS = 4;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = config.delay / 1000;   // xml units are microseconds
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
