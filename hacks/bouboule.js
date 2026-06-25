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
// centre of the ball also wanders. Each star is drawn as a small filled dot;
// the cloud reads as a deforming balloon with spots painted on its invisible
// surface. Every motion (rotation, centre, ellipsoid size) is driven by a
// "SinVariable": a value that oscillates min..max via sin(alpha), with alpha
// advancing each frame — optionally with a randomized acceleration so the
// breathing never settles into a perfect loop.
//
// size-by-depth: the original only varies a star's size for the red/blue
// stereo offset; here we additionally scale each dot by the rotated z of its
// star (near side of the ball bigger, far side smaller) so the sphere reads as
// solid even in flat (non-3D) mode. See bouboule.md "Deviations".
//
// Rendering: sparse fillRect dots over a full black repaint each frame (matches
// the C's HAVE_JWXYZ path, which XClearWindows every frame under Quartz double-
// buffering rather than erasing the old arc list). At most `count` dots per
// frame, so plotting the live points is far cheaper than any per-pixel blit.

export const title = 'bouboule';

export const info = {
  author: 'Jeremie Petit',
  description: 'A deforming balloon with varying-sized spots painted on its invisible surface.',
  year: 1997,
};

export function start(canvas) {
  // 'lighter' (3D stereo overlap -> magenta/white) needs source-over off; we
  // set the op explicitly per draw, so the default getContext state is fine.
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/bouboule.xml so the config box maps 1:1.
  // 3d defaults OFF here (the stock default is on): the vivid single-hue ball is
  // the signature look; red/blue separation is offered as a toggle. See the .md.
  const config = {
    delay: 30000,    // µs between frames (--delay; xml default 20000, calmer here)
    count: 100,      // number of stars on the ball (--count)
    size: 15,        // maximum star radius in px (--size)
    ncolors: 64,     // size of the rainbow hue cycle (--ncolors)
    mode3d: false,   // red/blue stereo separation (--3d / --no-3d)
  };

  // live: true  -> the loop reads config[key] every frame (applies instantly).
  // live: false -> the value sizes the star list / palette, so changing it
  //                re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Number of spots', type: 'range', min: 1, max: 400, step: 1, default: 100, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'size', label: 'Spot size', type: 'range', min: 1, max: 60, step: 1, default: 15, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'mode3d', label: 'Red/blue 3D separation', type: 'checkbox', default: false, live: true },
  ];

  // Simulation constants, straight from bouboule.c.
  const TWOPI = 2.0 * Math.PI;
  const MINSIZE = 1;
  const COLOR_CHANGES = 50;     // frames between hue steps (1 = every frame)
  const MAX_SIZEX_SIZEY = 2.0;  // caps how flat / how tall the ellipsoid can get
  // Percentages (0..100) that a SinVariable re-rolls its acceleration each frame.
  const THETACANRAND = 80;      // for the three rotation angles
  const SIZECANRAND = 80;       // for sizex / sizey
  const POSCANRAND = 80;        // for centre x / y / z
  // Depth model for the stereo offset (z in world units, screen plane at SCREENZ).
  const MINZVAL = 100;          // nearest a star may approach
  const SCREENZ = 2000;         // where the screen sits
  const MAXZVAL = 10000;        // farthest a star may recede
  const DELTA3D = 1.5;          // stereo strength (--delta3d)

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let maxStarSize;    // maximum dot radius, device px
  let stars;          // unit-vector cloud + per-star size
  let palette;        // ncolors rainbow CSS strings
  let colorp;         // index into palette (the whole ball is one colour)
  let colorChange;    // frames since the last hue step
  // The eight SinVariables that drive every motion.
  let sx, sy, sz;       // centre of the ball on screen (z drives stereo depth)
  let sizex, sizey;     // ellipsoid half-width / half-height (the pulse)
  let thetax, thetay, thetaz;   // rotation angles about the local x / y / z axes

  // INTRAND-style helper: integer in [0, n).
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

  function buildPalette() {
    const n = max(1, Math.round(config.ncolors));
    palette = new Array(n);
    for (let i = 0; i < n; i++) palette[i] = `hsl(${i * 360 / n}, 100%, 55%)`;
  }

  // Seed the whole star-ball (the C's init_bouboule). Sizes are in device px.
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // Maximum dot radius (the C's max_star_size = MI_SIZE), in device px.
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

    // ---- The stars: unit vectors on a sphere, plus a per-star size ----
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
      // roughly half the stars are minimal (size 0 -> 1px) and the rest spread
      // 0..max. Kept verbatim from the C.
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
  // star to screen. Mirrors draw_bouboule()'s math. Returns nothing; draw()
  // paints from the per-star screen coords stamped here.
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

      // Rotated screen position (the C's arc->x / arc->y), ellipsoid-scaled and
      // centre-offset. These are the full 3x3-rotation rows the C inlines.
      s.sxp = ex * ((CY * CZ - SX * SY * SZ) * s.x + (-CX * SZ) * s.y + (SY * CZ + SZ * SX * CY) * s.z) + ox;
      s.syp = ey * ((CY * SZ + SX * SY * CZ) * s.x + (CX * CZ) * s.y + (SY * SZ - SX * CY * CZ) * s.z) + oy;

      // Rotated depth (the C's GETZDIFF argument): the z-component of the same
      // rotation, scaled by the x-radius (the field is as deep as it is wide),
      // offset by the centre's world z. Drives both stereo offset and our
      // depth-based dot scaling.
      const zworld = ex * ((SY * CX) * s.x + SX * s.y + (CX * CY) * s.z) + sz.value;

      // Depth in [-1, 1]: +1 on the near face of the ball, -1 on the far face.
      // (ex is the x-radius, so the rotated-z span is +/- ex around sz.value.)
      s.depth = ex > 0 ? (zworld - sz.value) / ex : 0;

      // Horizontal stereo offset for 3D mode.
      s.diff = use3d ? getZDiff(zworld) : 0;
    }

    // Slowly cycle the ball's single colour (the C's COLOR_CHANGES gate).
    if (palette.length > 2 && ++colorChange >= COLOR_CHANGES) {
      colorChange = 0;
      if (++colorp >= palette.length) colorp = 0;
    }
  }

  // Paint a star as a filled square (the C draws a filled disk; the brief calls
  // for fillRect dots). Radius scales with the star's base size AND its depth:
  // near-face stars (depth ~ +1) render up to ~1.6x, far-face (~ -1) down to
  // ~0.5x, so the sphere reads as solid. `dxp` is the horizontal stereo shift.
  function paintStar(s, dxp) {
    const base = s.size + 1;                       // >= 1 px even for size-0 stars
    const r = max(1, Math.round(base * (1.0 + 0.55 * s.depth)));
    const d = 2 * r;
    // Centre the dot (the C subtracts star->size to place the arc's top-left).
    const px = (s.sxp + dxp - r) | 0;
    const py = (s.syp - r) | 0;
    ctx.fillRect(px, py, d, d);
  }

  // Full repaint each frame: clear to black, then stamp every star. In 3D mode
  // we draw a red copy offset +diff and a blue copy offset -diff, composited
  // with 'lighter' so the overlap sums to magenta/white — the closest faithful
  // stand-in for the C's GXor stereo blend (canvas has no XOR raster op). In
  // flat mode the whole ball is one slowly-cycling rainbow hue.
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
  const MAX_CATCHUP_STEPS = 4;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = config.delay / 1000;
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
