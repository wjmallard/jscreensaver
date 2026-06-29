// bouboule.js — bouboule packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's bouboule.c — from xlockmore, code (c) 1996 Jeremie
// Petit; 3D support by Henrik Theiling (1996); standalone by jwz (1997).
// https://www.jwz.org/xscreensaver/
//
// A breathing, rotating star-ball. A field of `count` stars is scattered as
// unit vectors on a sphere, then on every frame the whole cloud is rotated
// (three independent slowly-oscillating Euler angles), squashed onto an
// ellipsoid whose half-width / half-height pulse, and projected to 2D — the
// centre of the ball also wanders. Each star is drawn as a small filled disk of
// FIXED size (the C never resizes a dot per frame — only the per-star stereo
// offset moves); the cloud reads as a deforming balloon with spots painted on
// its invisible surface. Every motion (rotation, centre, ellipsoid size) is
// driven by a "SinVariable": a value that oscillates min..max via sin(alpha),
// with alpha advancing each frame — optionally with a randomized acceleration so
// the breathing never settles into a perfect loop.
//
// Colour: bouboule.c is built with SMOOTH_COLORS, so the framework allocates one
// make_smooth_colormap (random 2-5 HSV anchor loop, often muted) of `ncolors`
// entries. In flat (non-3D) mode the whole ball is a single colormap entry at a
// time, stepping one entry every COLOR_CHANGES frames. We build that palette via
// the shared faithful helper in colormap.js — NOT a vivid full-saturation HSL
// rainbow (the earlier port's deviation; see bouboule.md).
//
// 3D mode (--3d; the STOCK DEFAULT, *use3d:True): a red copy and a blue copy of
// every star are offset by a per-star stereo diff for red/blue glasses. The
// colormap is unused in this mode — only red / blue / (overlap) magenta.
//
// Rendering: filled-disk dots over a full black repaint each frame (matches the
// C's HAVE_JWXYZ path, which XClearWindows every frame under Quartz double-
// buffering rather than erasing the old arc list). At most 2*count small disks
// per frame, trivially cheap.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'bouboule';

export const info = {
  author: 'Jeremie Petit',
  description: 'A deforming balloon with varying-sized spots painted on its invisible surface.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/bouboule.xml so the config box maps 1:1:
  // delay (µs/frame, "Frame rate", inverted), count, ncolors, and the 3d toggle.
  // The .xml exposes NO size slider, so `size` stays a fixed resource here (the
  // stock *size:15). mode3d defaults ON, matching the stock *use3d:True.
  const config = {
    delay: 20000,    // µs between frames (--delay; the .xml stock value — the loop adds a fixed OVERHEAD so the effective rate matches the live binary, see bouboule.md)
    count: 100,      // number of stars on the ball (--count)
    ncolors: 64,     // size of the make_smooth_colormap (--ncolors)
    size: 15,        // max star radius in px (--size; the .xml exposes no slider for it, so it stays fixed)
    mode3d: true,    // red/blue stereo separation (--3d / --no-3d); stock default is on
  };

  // live: true  -> the loop reads config[key] every frame (applies instantly).
  // live: false -> the value sizes the star list / palette, so changing it
  //                re-runs init() via reinit().
  // Labels mirror the .xml _label / _low-label / _high-label resources.
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'count', label: 'Number of spots', type: 'range', min: 1, max: 400, step: 1, default: 100, lowLabel: 'Few', highLabel: 'Many', live: false },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'Two', highLabel: 'Many', live: false },
    { key: 'mode3d', label: 'Do Red/Blue 3D separation', type: 'checkbox', default: true, live: true },
  ];

  // Simulation constants, straight from bouboule.c.
  const TWOPI = 2.0 * Math.PI;
  const MINSIZE = 1;
  const COLOR_CHANGES = 50;     // frames between colormap steps (1 = every frame)
  const MAX_SIZEX_SIZEY = 2.0;  // caps how flat / how tall the ellipsoid can get
  // Percentages (0..100) that a SinVariable re-rolls its acceleration each frame.
  const THETACANRAND = 80;      // for the three rotation angles
  const SIZECANRAND = 80;       // for sizex / sizey
  const POSCANRAND = 80;        // for centre x / y / z
  // Depth model for the stereo offset (z in world units, screen plane at SCREENZ).
  const MINZVAL = 100;          // nearest a star may approach
  const SCREENZ = 2000;         // where the screen sits
  const MAXZVAL = 10000;        // farthest a star may recede
  const DELTA3D = 1.5;          // stereo strength (--delta3d; .xml exposes no slider)

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let maxStarSize;    // maximum dot radius, device px
  let stars;          // unit-vector cloud + per-star size
  let palette;        // ncolors smooth-colormap CSS strings
  let colorp;         // index into palette (the whole ball is one colour)
  let colorChange;    // frames since the last colormap step
  // The eight SinVariables that drive every motion.
  let sx, sy, sz;       // centre of the ball on screen (z drives stereo depth)
  let sizex, sizey;     // ellipsoid half-width / half-height (the pulse)
  let thetax, thetay, thetaz;   // rotation angles about the local x / y / z axes

  // NRAND-style helper: integer in [0, n).
  const nrand = (n) => Math.floor(Math.random() * n);
  const min = (a, b) => (a < b ? a : b);
  const max = (a, b) => (a > b ? a : b);
  const dtor = (deg) => (deg * Math.PI) / 180.0;

  // GETZDIFF(z): horizontal stereo offset for a star at world depth z.
  function getZDiff(z) {
    return DELTA3D * 20.0 * (1.0 - SCREENZ / (z + 1000));
  }

  // ---- SinVariable: a value oscillating minimum..maximum via sin(alpha) ----
  // alpha advances by `step` each frame; if mayrand != 0 the step is itself
  // modulated by a nested SinVariable (varrand) that occasionally re-rolls, so
  // the motion never settles into a perfect periodic loop. Faithful to the C's
  // sinvary()/sininit() (the recursion bottoms out: varrand has mayrand == 0).
  function makeSinVar() {
    return {
      alpha: 0.0,
      step: 0.0,
      minimum: 0.0,
      maximum: 0.0,
      value: 0.0,
      mayrand: 0,
      varrand: null,
    };
  }

  function sinvary(v) {
    v.value = v.minimum + (v.maximum - v.minimum) * (Math.sin(v.alpha) + 1.0) / 2.0;
    if (v.mayrand === 0) {
      v.alpha += v.step;
    } else {
      if (nrand(100) <= v.mayrand) sinvary(v.varrand);
      v.alpha += (100.0 + v.varrand.value) * v.step / 100.0;
    }
    if (v.alpha > TWOPI) v.alpha -= TWOPI;
  }

  function sininit(v, alpha, step, minimum, maximum, mayrand) {
    v.alpha = alpha;
    v.step = step;
    v.minimum = minimum;
    v.maximum = maximum;
    v.mayrand = mayrand;
    if (mayrand !== 0) {
      if (v.varrand === null) v.varrand = makeSinVar();
      sininit(
        v.varrand,
        nrand(Math.floor(Math.PI * 1000.0)) / 1000.0,   // VARRANDALPHA
        Math.PI / (nrand(100) + 100.0),                 // VARRANDSTEP
        -70.0,                                          // VARRANDMIN
        70.0,                                           // VARRANDMAX
        0,
      );
      sinvary(v.varrand);
    }
    // Calculate the value at least once for initialization.
    sinvary(v);
  }

  // make_smooth_colormap (utils/colors.c) via the shared faithful helper: random
  // 2-5 HSV anchor points interpolated into a closed loop, often muted/pastel.
  // The C builds the colormap once per hack start; we rebuild it per init().
  function buildPalette() {
    const n = max(1, Math.round(config.ncolors));
    palette = makeSmoothColormapRGB(n).map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);
  }

  // Seed the whole star-ball (the C's init_bouboule). Sizes are in device px.
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // Maximum dot radius (the C's max_star_size = MI_SIZE), in device px. The C
    // doubles size on Retina (width/height > 2560); we scale by devicePixelRatio
    // for the same effect.
    const size = max(MINSIZE, Math.round(config.size)) * S;
    maxStarSize = max(MINSIZE, Math.round(size));

    buildPalette();

    // ---- SinVariables for centre, ellipsoid half-extents, rotation angles ----
    // Ranges transcribed from init_bouboule(); the bouboule lives in the middle
    // half of the screen and its half-extents are bounded by the centre so it
    // can never run off an edge. NRAND(3142)/1000 seeds alpha in [0, PI).
    sx = makeSinVar();
    sy = makeSinVar();
    sz = makeSinVar();
    sizex = makeSinVar();
    sizey = makeSinVar();
    thetax = makeSinVar();
    thetay = makeSinVar();
    thetaz = makeSinVar();

    sininit(
      sx,
      nrand(3142) / 1000.0,
      Math.PI / (nrand(100) + 100.0),
      W / 4.0,
      3.0 * W / 4.0,
      POSCANRAND,
    );
    sininit(
      sy,
      nrand(3142) / 1000.0,
      Math.PI / (nrand(100) + 100.0),
      H / 4.0,
      3.0 * H / 4.0,
      POSCANRAND,
    );
    // z keeps the ball in front of the viewer (eyes at 0); it reuses the x
    // radius for depth, so the bounds are built from the screen width.
    sininit(
      sz,
      nrand(3142) / 1000.0,
      Math.PI / (nrand(100) + 100.0),
      W / 2.0 + MINZVAL,
      W / 2.0 + MAXZVAL,
      POSCANRAND,
    );
    sininit(
      sizex,
      nrand(3142) / 1000.0,
      Math.PI / (nrand(100) + 100.0),
      min(W - sx.value, sx.value) / 5.0,
      min(W - sx.value, sx.value),
      SIZECANRAND,
    );
    sininit(
      sizey,
      nrand(3142) / 1000.0,
      Math.PI / (nrand(100) + 100.0),
      max(sizex.value / MAX_SIZEX_SIZEY, sizey.maximum / 5.0),
      min(sizex.value * MAX_SIZEX_SIZEY, min(H - sy.value, sy.value)),
      SIZECANRAND,
    );
    sininit(
      thetax,
      nrand(3142) / 1000.0,
      Math.PI / (nrand(200) + 200.0),
      -Math.PI,
      Math.PI,
      THETACANRAND,
    );
    sininit(
      thetay,
      nrand(3142) / 1000.0,
      Math.PI / (nrand(200) + 200.0),
      -Math.PI,
      Math.PI,
      THETACANRAND,
    );
    sininit(
      thetaz,
      nrand(3142) / 1000.0,
      Math.PI / (nrand(400) + 400.0),
      -Math.PI,
      Math.PI,
      THETACANRAND,
    );

    // ---- The stars: unit vectors on a sphere, plus a per-star fixed size ----
    const nstars = max(1, Math.round(config.count));
    stars = new Array(nstars);
    for (let i = 0; i < nstars; i++) {
      // Elevation (theta) and bearing (omega) of the star, in radians.
      const theta = dtor(nrand(1800) / 10.0 - 90.0);
      const omega = dtor(nrand(3600) / 10.0 - 180.0);

      // Star coordinates in 3D space (a point on the unit sphere).
      const x = Math.cos(theta) * Math.sin(omega);
      const y = Math.sin(omega) * Math.sin(theta);
      const z = Math.cos(omega);

      // Star size: NRAND(2*max); below max -> 0, else shifted down by max. So
      // roughly half the stars are minimal (size 0 -> 2px disk) and the rest
      // spread 0..max. FIXED per star — never re-rolled. Kept verbatim from the C.
      let starSize = nrand(2 * maxStarSize);
      if (starSize < maxStarSize) starSize = 0;
      else starSize -= maxStarSize;

      stars[i] = { x, y, z, size: starSize };
    }

    // The whole ball is one colour, cycled slowly (the C's non-3D path).
    colorp = palette.length > 2 ? nrand(palette.length) : 0;
    colorChange = 0;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // Advance every SinVariable, recompute the rotation matrix, and project each
  // star to screen. Mirrors draw_bouboule()'s math. Stamps per-star screen
  // coords (sxp/syp, truncated like the C's (short)) and the stereo offset diff.
  function simulate() {
    // Vary the rotation angles and the wandering centre.
    sinvary(thetax);
    sinvary(thetay);
    sinvary(thetaz);
    sinvary(sx);
    sinvary(sy);
    sinvary(sz);

    // Re-bound the half-extents each frame so the ball never overruns an edge,
    // then vary them. (The C rewrites sizex/sizey min&max before each sinvary.)
    sizex.maximum = min(W - sx.value, sx.value);
    sizex.minimum = sizex.maximum / 3.0;
    sizey.minimum = max(sizex.value / MAX_SIZEX_SIZEY, sizey.maximum / 3.0);
    sizey.maximum = min(sizex.value * MAX_SIZEX_SIZEY, min(H - sy.value, sy.value));
    sinvary(sizex);
    sinvary(sizey);

    // Rotation matrix terms (rotation done on the fly, no matrix object).
    const CX = Math.cos(thetax.value), SX = Math.sin(thetax.value);
    const CY = Math.cos(thetay.value), SY = Math.sin(thetay.value);
    const CZ = Math.cos(thetaz.value), SZ = Math.sin(thetaz.value);

    const ex = sizex.value, ey = sizey.value;   // ellipsoid half-extents
    const ox = sx.value, oy = sy.value;          // screen-centre offset
    const use3d = config.mode3d;

    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];

      // Rotated, ellipsoid-scaled, centre-offset screen position (the C's
      // arc->x / arc->y, the full 3x3-rotation rows inlined, cast to short).
      s.sxp = (ex * ((CY * CZ - SX * SY * SZ) * s.x + (-CX * SZ) * s.y + (SY * CZ + SZ * SX * CY) * s.z) + ox) | 0;
      s.syp = (ey * ((CY * SZ + SX * SY * CZ) * s.x + (CX * CZ) * s.y + (SY * SZ - SX * CY * CZ) * s.z) + oy) | 0;

      // Stereo offset for 3D mode: GETZDIFF of the rotated depth (the field is
      // as deep as it is wide, so the x-radius scales z), offset by the centre's
      // world z. Truncated to int as the C does. Zero in flat mode.
      if (use3d) {
        const zworld = ex * ((SY * CX) * s.x + SX * s.y + (CX * CY) * s.z) + sz.value;
        s.diff = getZDiff(zworld) | 0;
      } else {
        s.diff = 0;
      }
    }

    // Slowly step the ball's single colour (the C's COLOR_CHANGES gate). Only in
    // flat mode, and only when the smooth colormap has > 2 entries (matching the
    // C's `!use3d && MI_NPIXELS > 2` guard).
    if (!use3d && palette.length > 2 && ++colorChange >= COLOR_CHANGES) {
      colorChange = 0;
      if (++colorp >= palette.length) colorp = 0;
    }
  }

  // Paint one star as a filled disk, exactly as the C's XFillArc(0..360): the
  // bounding box is [x, y, 2+size, 2+size] (diameter = 2 + star size), and when
  // the star has nonzero size the top-left is shifted back by the FULL size (the
  // C's `arc->x -= star->size`). `dxp` is the horizontal stereo shift (0 flat).
  function paintStar(s, dxp) {
    const d = 2 + s.size;
    let px = s.sxp + dxp;
    let py = s.syp;
    if (s.size !== 0) { px -= s.size; py -= s.size; }
    const r = d / 2;
    ctx.beginPath();
    ctx.arc(px + r, py + r, r, 0, TWOPI);
    ctx.fill();
  }

  // Full repaint each frame: clear to black, then stamp every star. In 3D mode
  // we draw a red copy offset +diff and a blue copy offset -diff. Canvas has no
  // GXor raster op, so the two copies are composited with 'lighter' so the
  // overlap sums to magenta — the both3d=magenta the C's anaglyph is designed
  // around (see bouboule.md). In flat mode the whole ball is one smooth-colormap
  // entry (white when <= 2 colours, matching the C's MI_NPIXELS > 2 gate).
  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    if (config.mode3d) {
      const prevOp = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = '#f00';
      for (let i = 0; i < stars.length; i++) paintStar(stars[i], stars[i].diff);
      ctx.fillStyle = '#00f';
      for (let i = 0; i < stars.length; i++) paintStar(stars[i], -stars[i].diff);
      ctx.globalCompositeOperation = prevOp;
    } else {
      ctx.fillStyle = palette.length > 2 ? palette[colorp] : '#fff';
      for (let i = 0; i < stars.length; i++) paintStar(stars[i], 0);
    }
  }

  function reinit() {
    init();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced by config.delay (µs): run one simulate() per
  // delay, banking leftover time so the speed is identical at any refresh rate.
  // Cap catch-up so a backgrounded tab doesn't burst a run of frames on refocus.
  // Draw once per frame (the heavy work is simulate(), so we never over-draw).
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay bouboule runs 37.4 fps, while the
  // port at the stock 20000 us ran ~50 frames/sec (1.34x fast). 20000 + 6738 =
  // 26738 us -> 37.4 frames/sec, matching the live binary. A calibration, not a
  // tuning knob (the delay slider still maps 1:1 to the xml resource).
  const OVERHEAD = 6738;
  const MAX_CATCHUP_STEPS = 4;
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
    let stepped = false;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      simulate();
      lag -= delayMs;
      steps++;
      stepped = true;
    }

    if (stepped) draw();
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
    reinit,
    config,
    params,
  };
}
