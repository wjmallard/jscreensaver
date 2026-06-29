// kumppa.js — kumppa packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's kumppa.c (Teemu Suutari, 1998).
// https://www.jwz.org/xscreensaver/
//
// "Spiraling, spinning, and very, very fast splashes of color rush toward the
// screen." Each step the hack injects a little fresh color near the center,
// then spins the *entire framebuffer* slightly outward about the center.
// Repeated, that pulls every painted mark into a spiral streak racing off the
// edges, fed continuously by new color at the core.
//
// Framebuffer feedback — faithful integer block-copy (the load-bearing part):
//   The C's rotate()/make_rots()/palaRotate() copy the window onto ITSELF as
//   many small FIXED-SIZE blocks, each XCopyArea'd to a destination shifted by
//   an integer (du-dv, du+dv) shear about (midx,midy). The blocks keep their
//   size — it is a size-preserving translation per block, NOT a scale — so the
//   painted lines stay thin and the black gaps between the spiral arms survive.
//   We transcribe all three functions verbatim and replay each block as a
//   SAME-SIZE drawImage from a per-step `scratch` snapshot (the C's useDBE
//   double-buffer mode) -- NOT an in-place self-copy, which would force a GPU
//   sync on every drawImage (fine for X11's server-side XCopyArea, ruinous in a
//   browser at thousands/frame). imageSmoothingEnabled = false, no resample.
//   make_rots() builds the column/row dithering tables once per speed/size. The
//   previous port faked this with one uniform ctx.scale(z): that magnified the
//   WHOLE frame ~speed/2 every step, so every line thickened ~5%/frame and after
//   ~60 frames (center -> edge) ballooned ~19x, merging the lines and flooding
//   the gaps solid. A uniform scale can never be faithful here. See kumppa.md.
//
// Two looks, from the C's `random` resource:
//   - cosilines ON  (default): 4 smooth Lissajous lines whose endpoints are
//     driven by a fixed cosinus[] table, cycling through the hue ramp.
//   - cosilines OFF: 8 random small colored squares splatted near the center.
// Either way a small black square is stamped dead-center each step (the C does
// this so the very center never saturates), then the framebuffer is spun.

export const title = 'kumppa';

export const info = {
  author: 'Teemu Suutari',
  description: 'Spiraling, spinning, and very, very fast splashes of color rush toward the screen.',
  year: 1998,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/kumppa.xml. The C exposes delay, speed
  // (labelled "Density" in the xml — it sets the per-step spin rate), and random
  // (the cosilines toggle). `ncolors` is added for parity with the other ports;
  // the C hardcodes a 32-entry blue->green->red->violet ramp.
  const config = {
    delay: 10000,      // µs between steps (--delay; xml/C stock 10000). The rAF loop
                       // adds OVERHEAD so (delay + OVERHEAD) hits the live -fps rate.
    speed: 0.10,       // per-step spin rate, 0.0001..0.2 (--speed / "Density"); the
                       // C/xml stock default. Sets rotsizeX = (int)(2/speed+1) groups.
    random: true,      // true = smooth cosi-lines, false = random splats (--random)
    ncolors: 32,       // size of the hue ramp the marks cycle through
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Density', type: 'range', min: 0.0001, max: 0.2, step: 0.0001, default: 0.10, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'random', label: 'Smooth lines', type: 'checkbox', default: true, live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 32, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  // The C's cosinus[8][6] table: per oscillator, three phase increments then
  // three amplitudes. Four (x,y) endpoint pairs are built from these eight
  // oscillators (a<<1 / (a<<1)+1), giving the smooth wandering Lissajous lines.
  const COSINUS = [
    [-0.07, 0.12, -0.06, 32, 25, 37],
    [0.08, -0.03, 0.05, 51, 46, 32],
    [0.12, 0.07, -0.13, 27, 45, 36],
    [0.05, -0.04, -0.07, 36, 27, 39],
    [-0.02, -0.07, 0.1, 21, 43, 42],
    [-0.11, 0.06, 0.02, 51, 25, 34],
    [0.04, -0.15, 0.02, 42, 32, 25],
    [-0.02, -0.04, -0.13, 34, 20, 15],
  ];

  // Backing-store cap (longer edge, px) for the block-copy feedback. Its cost is
  // ~one drawImage per grid cell per frame, which scales with W*H, so at full
  // Retina resolution a single step is thousands of block-copies (~12ms on an M4
  // at native res -- slower than the 10000us default interval, which then
  // death-spirals the lag-accumulator). Capping the longer backing edge cuts the
  // count quadratically; the canvas CSS-upscales to fill (the C ships a
  // commented-out ".lowrez: true" for kumppa). Tunable: raise for sharpness if
  // the GPU keeps up, lower if still laggy. Infinity = full device resolution.
  const MAX_EDGE = 2048;

  let S = 1;               // effective backing px per CSS px (W / innerWidth)
  let W, H;                // canvas size, backing px
  let cx, cy;              // center, backing px
  let colors;              // hue ramp, ncolors entries
  let pscale;              // mark line width / box size (Retina-aware)
  let scratch, sctx;       // double-buffer source for the block-copy feedback

  // Faithful port of the C's feedback (make_rots / rotate / palaRotate). These
  // mirror struct state: midx,midy === cx,cy (the center) and sizx,sizy === W,H
  // (the C's names, kept so the transcription matches kumppa.c line-for-line).
  let sizx, sizy, midx, midy;
  let Xrotations, Yrotations;   // permutation of columns/rows into displacement order
  let Xrottable, Yrottable;     // group boundaries within X/Yrotations
  let rotateX, rotateY;         // per-frame strip breakpoints (the block grid)
  let rotsizeX, rotsizeY;       // # groups == frames per full cycle ((int)(2/speed+1))
  let stateX, stateY;           // which group this frame uses (cycles 0..rotsize-1)
  let rx, ry;                   // current group sizes (half-grid radius this frame)
  let builtSpeed = -1;          // speed make_rots() last built for (rebuild on change)

  // Per-oscillator accumulated phase (acosinus[8][3]) and the resulting line
  // endpoints (coords / ocoords hold this and last frame's, 8 ints = 4 points).
  let acos;                // Float32, 8*3
  let coords, ocoords;     // Int, 8 each
  let drawCount;           // color index walk, like st->draw_count

  // The C ramp (colors[96], kumppa.c:72-79) is a 32-step loop whose hue
  // DECREASES from blue: 240->180->120->60->0->300->270->240
  // (blue->cyan->green->yellow->red->magenta->violet->blue). We rebuild it as a
  // resizable vivid HSL wheel of config.ncolors entries, sweeping hue downward
  // from blue in that same direction. (kumppa builds its own RGB ramp, not
  // make_smooth_colormap, so colormap.js is intentionally not used here.)
  function buildColors() {
    const n = Math.max(2, Math.round(config.ncolors));
    colors = new Array(n);
    for (let i = 0; i < n; i++) {
      // Start at blue (240) and sweep a full turn DOWNWARD (matching the C).
      const hue = ((240 - i * 360 / n) % 360 + 360) % 360;
      colors[i] = `hsl(${hue.toFixed(1)}, 100%, 50%)`;
    }
  }

  // ---- Faithful feedback: make_rots / rotate / palaRotate (kumppa.c) ----------

  // make_rots (kumppa.c:202-349): build the column/row dithering tables ONCE per
  // speed+size. The midx columns are distributed into rotsizeX = (int)(2/speed+1)
  // groups; within each group a void-and-cluster heuristic (the `om += ok` /
  // `ok /= 1.5` / `om + 12*ok > m` neighbour score) repeatedly picks the most
  // clustered free column, then inserts it into Xrotations keeping each group
  // sorted ascending. Transcribed verbatim, integer arithmetic intact.
  function makeRots(xspeed, yspeed) {
    let a, b, c, f, g, j, k = 0, l;
    let m, om, ok;
    let d, ix, iy;
    let maxi;

    rotsizeX = Math.trunc(2 / xspeed + 1);
    ix = (midx + 1) / rotsizeX;
    rotsizeY = Math.trunc(2 / yspeed + 1);
    iy = (midy + 1) / rotsizeY;

    Xrotations = new Int32Array(midx + 2);
    Xrottable = new Int32Array(rotsizeX + 1);
    Yrotations = new Int32Array(midy + 2);
    Yrottable = new Int32Array(rotsizeY + 1);
    const chks = new Uint8Array((midx > midy) ? midx : midy);

    maxi = 0;
    c = 0;
    d = 0;
    g = 0;
    for (a = 0; a < midx; a++) chks[a] = 1;
    for (a = 0; a < rotsizeX; a++) {
      Xrottable[a] = c;
      f = Math.trunc(d + ix) - g;            // viivojen lkm. (number of lines)
      g += f;
      if (g > midx) {
        f -= g - midx;
        g = midx;
      }
      for (b = 0; b < f; b++) {
        m = 0;
        for (j = 0; j < midx; j++) {         // testi
          if (chks[j]) {
            om = 0;
            ok = 1;
            l = 0;
            while (j + l < midx && om + 12 * ok > m) {
              if (j - l >= 0) {
                if (chks[j - l]) om += ok;
              } else {
                if (chks[l - j]) om += ok;
              }
              if (chks[j + l]) om += ok;
              ok /= 1.5;
              l++;
            }
            if (om >= m) {
              k = j;
              m = om;
            }
          }
        }
        chks[k] = 0;
        l = c;
        while (l >= Xrottable[a]) {
          if (l != Xrottable[a]) Xrotations[l] = Xrotations[l - 1];
          if (k > Xrotations[l] || l == Xrottable[a]) {
            Xrotations[l] = k;
            c++;
            l = Xrottable[a];
          }
          l--;
        }
      }
      d += ix;
      if (maxi < c - Xrottable[a]) maxi = c - Xrottable[a];
    }
    Xrottable[a] = c;
    rotateX = new Int32Array((maxi + 2) << 1);

    maxi = 0;
    c = 0;
    d = 0;
    g = 0;
    for (a = 0; a < midy; a++) chks[a] = 1;
    for (a = 0; a < rotsizeY; a++) {
      Yrottable[a] = c;
      f = Math.trunc(d + iy) - g;
      g += f;
      if (g > midy) {
        f -= g - midy;
        g = midy;
      }
      for (b = 0; b < f; b++) {
        m = 0;
        for (j = 0; j < midy; j++) {
          if (chks[j]) {
            om = 0;
            ok = 1;
            l = 0;
            while (j + l < midy && om + 12 * ok > m) {
              if (j - l >= 0) {
                if (chks[j - l]) om += ok;
              } else {
                if (chks[l - j]) om += ok;
              }
              if (chks[j + l]) om += ok;
              ok /= 1.5;
              l++;
            }
            if (om >= m) {
              k = j;
              m = om;
            }
          }
        }
        chks[k] = 0;
        l = c;
        while (l >= Yrottable[a]) {
          if (l != Yrottable[a]) Yrotations[l] = Yrotations[l - 1];
          if (k > Yrotations[l] || l == Yrottable[a]) {
            Yrotations[l] = k;
            c++;
            l = Yrottable[a];
          }
          l--;
        }
      }
      d += iy;
      if (maxi < c - Yrottable[a]) maxi = c - Yrottable[a];
    }
    Yrottable[a] = c;
    rotateY = new Int32Array((maxi + 2) << 1);
  }

  // The C builds make_rots once (speed is fixed at init). Here speed is a live
  // slider, so rebuild only when it actually changes (clamped to the C's valid
  // 0.0001..0.2 range) and reset the cycle phase. The on-screen image is left
  // intact -- only the spin rate changes.
  function ensureRots() {
    const speed = Math.min(0.2, Math.max(0.0001, config.speed));
    if (speed !== builtSpeed) {
      makeRots(speed, speed);
      builtSpeed = speed;
      stateX = 0;
      stateY = 0;
    }
  }

  // palaRotate (kumppa.c:130-154): copy ONE fixed-size block from the current
  // frame to a destination sheared by (du-dv, du+dv) about the center, clipped to
  // the screen. The C's XCopyArea is reproduced by copying from the per-step
  // `scratch` snapshot (the C's useDBE double-buffer mode) with EQUAL src/dst
  // size -- no scaling, so the block keeps its size and the lines stay thin, and
  // no read+write of the same canvas (which would force a GPU sync per call).
  // dcx/dcy are palaRotate's local cx/cy (the destination), renamed vs the center.
  function palaRotate(x, y) {
    let ax = rotateX[x];
    let ay = rotateY[y];
    let bx = rotateX[x + 1] + 2;
    let by = rotateY[y + 1] + 2;
    let dcx = rotateX[x] - (y - ry) + x - rx;
    let dcy = rotateY[y] + (x - rx) + y - ry;
    if (dcx < 0) { ax -= dcx; dcx = 0; }
    if (dcy < 0) { ay -= dcy; dcy = 0; }
    if (dcx + bx - ax > sizx) bx = ax - dcx + sizx;
    if (dcy + by - ay > sizy) by = ay - dcy + sizy;
    if (ax < bx && ay < by) {
      const w = bx - ax;
      const h = by - ay;
      ctx.drawImage(scratch, ax, ay, w, h, dcx, dcy, w, h);
    }
  }

  // rotate (kumppa.c:157-198): one feedback step. Using the current group
  // (stateX/stateY) compute rx/ry and the rotateX[]/rotateY[] strip breakpoints,
  // then palaRotate every block of the diamond-tiled grid. Verbatim.
  function rotate() {
    let x, y, dx, dy;

    ctx.imageSmoothingEnabled = false;   // XCopyArea never interpolates

    // Snapshot the frame (this step's marks + the prior spiral) into `scratch` so
    // every block copies from a FROZEN source -- the C's useDBE double-buffer
    // mode. Avoids the in-place self-copy that forces a GPU sync per drawImage.
    sctx.drawImage(canvas, 0, 0);

    rx = Xrottable[stateX + 1] - Xrottable[stateX];
    ry = Yrottable[stateY + 1] - Yrottable[stateY];

    for (x = 0; x <= rx; x++)
      rotateX[x] = x ? midx - 1 - Xrotations[Xrottable[stateX + 1] - x] : 0;
    for (x = 0; x <= rx; x++)
      rotateX[x + rx + 1] = (x == rx) ? sizx - 1 : midx + Xrotations[Xrottable[stateX] + x];
    for (y = 0; y <= ry; y++)
      rotateY[y] = y ? midy - 1 - Yrotations[Yrottable[stateY + 1] - y] : 0;
    for (y = 0; y <= ry; y++)
      rotateY[y + ry + 1] = (y == ry) ? sizy - 1 : midy + Yrotations[Yrottable[stateY] + y];

    x = (rx > ry) ? rx : ry;
    for (dy = 0; dy < ((x + 1) << 1); dy++)
      for (dx = 0; dx < ((x + 1) << 1); dx++) {
        y = (rx > ry) ? ry - rx : 0;
        if (dy + y >= 0 && dy < ((ry + 1) << 1) && dx < ((rx + 1) << 1))
          if (dy + y + dx <= ry + rx && dy + y - dx <= ry - rx) {
            palaRotate((rx << 1) + 1 - dx, dy + y);
            palaRotate(dx, (ry << 1) + 1 - dy - y);
          }
        y = (ry > rx) ? rx - ry : 0;
        if (dy + y >= 0 && dx < ((ry + 1) << 1) && dy < ((rx + 1) << 1))
          if (dy + y + dx <= ry + rx && dx - dy - y >= ry - rx) {
            palaRotate(dy + y, dx);
            palaRotate((rx << 1) + 1 - dy - y, (ry << 1) + 1 - dx);
          }
      }
    stateX++;
    if (stateX == rotsizeX) stateX = 0;
    stateY++;
    if (stateY == rotsizeY) stateY = 0;
  }

  // cosilines ON: advance the eight oscillators, rebuild the four line
  // endpoints, and draw each line from its previous endpoint to the new one in
  // the next ramp color (matching the C's fgc[((a<<2)+draw_count)&31] walk).
  function drawCosiLines() {
    drawCount++;
    for (let a = 0; a < 8; a++) {
      let f = 0;
      for (let b = 0; b < 3; b++) {
        acos[a * 3 + b] += COSINUS[a][b];
        f += COSINUS[a][b + 3] * Math.sin(acos[a * 3 + b]);
      }
      coords[a] = f * S;   // scale the C's pixel amplitudes for device px
    }
    ctx.lineWidth = pscale;
    ctx.lineCap = 'round';
    for (let a = 0; a < 4; a++) {
      const idx = (((a << 2) + drawCount) % colors.length + colors.length) % colors.length;
      ctx.strokeStyle = colors[idx];
      ctx.beginPath();
      ctx.moveTo(cx + ocoords[a << 1], cy + ocoords[(a << 1) + 1]);
      ctx.lineTo(cx + coords[a << 1], cy + coords[(a << 1) + 1]);
      ctx.stroke();
      ocoords[a << 1] = coords[a << 1];
      ocoords[(a << 1) + 1] = coords[(a << 1) + 1];
    }
  }

  // cosilines OFF: splat 8 random small colored squares within +/-16px of the
  // center, mirroring the C's Satnum(32)-16+mid placement and fgc[Satnum(50)]
  // color pick (indices >=32 clamp to the background = black, so some splats
  // punch holes — we keep that by mapping the top of the range to black).
  function drawSplats() {
    const box = 2 * pscale;
    const reach = 16 * S;
    for (let e = 0; e < 8; e++) {
      const a = Math.floor(Math.random() * 50);
      const bx = cx - reach + Math.floor(Math.random() * (32 * S));
      const by = cy - reach + Math.floor(Math.random() * (32 * S));
      if (a >= 32) {
        ctx.fillStyle = '#000';   // the C's fgc[32] (background) when a clamps high
      } else {
        ctx.fillStyle = colors[a % colors.length];
      }
      ctx.fillRect(bx, by, box, box);
    }
  }

  // One step: paint fresh color at the center, stamp the central black square
  // (so the very core never bakes solid), then spin the whole framebuffer.
  function step() {
    if (config.random) {
      drawCosiLines();
    } else {
      drawSplats();
    }
    // The C stamps fgc[32] (background/black) as a 4*pscale square at center.
    const k = 4 * pscale;
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - 2 * pscale, cy - 2 * pscale, k, k);

    // Feedback: copy the framebuffer onto itself as fixed-size sheared blocks
    // (kumppa_draw calls rotate() last). Rebuild the tables first if speed moved.
    ensureRots();
    rotate();
  }

  function init() {
    W = canvas.width;
    H = canvas.height;
    S = W / Math.max(1, window.innerWidth);   // effective backing px per CSS px
    cx = W >> 1;
    cy = H >> 1;

    // Double-buffer source for the feedback: snapshot the frame each step and
    // copy FROM it, so block-copies never read+write the same canvas (an
    // in-place self-drawImage forces a GPU sync per call -- the slow path).
    if (!scratch) scratch = document.createElement('canvas');
    scratch.width = W;
    scratch.height = H;
    sctx = scratch.getContext('2d');

    // The C bumps line width / box size on >2560px "Retina" displays; fold that
    // into the dpr scale so marks stay visible without dominating.
    pscale = Math.max(1, Math.round(S));
    if (W > 2560 || H > 2560) pscale *= 1.5;
    pscale = Math.round(pscale);

    // C names: screen == (sizx,sizy), center == (midx,midy). Build the feedback
    // tables for the current speed (make_rots runs once per speed/size, like
    // InitializeAll). ensureRots() does the build and zeroes stateX/stateY.
    sizx = W;
    sizy = H;
    midx = cx;
    midy = cy;
    stateX = 0;
    stateY = 0;
    builtSpeed = -1;
    ensureRots();

    acos = new Float32Array(24);
    coords = new Int32Array(8);
    ocoords = new Int32Array(8);
    drawCount = 0;

    buildColors();
  }

  // reinit clears to black (palette / look may have changed) and re-seeds.
  function reinit() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    init();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = window.innerWidth, cssH = window.innerHeight;
    // eff = dpr, unless MAX_EDGE caps the longer edge (MAX_EDGE=Infinity -> dpr,
    // i.e. full device resolution).
    const eff = Math.min(dpr, MAX_EDGE / Math.max(cssW, cssH));
    canvas.width = Math.max(1, Math.round(cssW * eff));
    canvas.height = Math.max(1, Math.round(cssH * eff));
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // Drive off requestAnimationFrame but keep the original pace: one step() per
  // config.delay, banking leftover time so the speed is the same at any refresh
  // rate. Catch-up is capped LOW (kumppa's step is heavy): if a step ever costs
  // more than the interval, a high cap would death-spiral into multi-step frames,
  // so allow at most a couple of catch-up steps and just let the spin run a hair
  // slow instead of locking up.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // The live kumppa measures 54.1 fps, but the port at the stock 10000 us ran
  // 100 steps/sec (1.85x fast). 10000 + 8484 = 18484 us -> 54.1 steps/sec,
  // matching the live binary. A calibration, not a tuning knob (the delay
  // slider still maps 1:1 to the xml resource).
  const OVERHEAD = 8484;
  const MAX_CATCHUP_STEPS = 2;
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
    reinit,   // re-seed + clear, keeping the current config
    config,
    params,
  };
}
