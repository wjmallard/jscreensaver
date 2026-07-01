// fiberlamp.js — fiberlamp packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's fiberlamp.c (Tim Auckland, 2005).
// https://www.jwz.org/xscreensaver/
//
// A fiber-optic lamp: many flexible glass fibers fan up and out from a base at
// the bottom-centre of the screen, each one a hanging cantilever that sways with
// a little gravity/spring physics and ends in a bright coloured tip. Since the
// large-amplitude cantilever equation has no closed form, each fiber is modeled
// as a chain of NODES discrete nodes. Every node carries two angles — phi (tilt
// from vertical) and eta (azimuth) — plus their angular velocities; a 2nd-order
// damped diff equation relaxes each node toward its parent while the load of all
// the downstream nodes bends it, so the strand droops and oscillates like a real
// fiber. A slowly-turning colour wheel (psi) assigns each tip a hue from its base
// azimuth, and every `cycles` frames the lamp is "knocked" (the base shifts a
// little) so the whole bundle sways.
//
// Rendering: canvas VECTOR ops, full repaint each frame (the C double-buffers and
// XFillRectangle-clears every frame, so there are no trails to preserve). Each
// fiber is one polyline of NODES-1 points drawn in a muted glass colour (dim /
// medium / bright by depth, the original's back/middle/front cue), with the last
// few segments overdrawn in the fiber's tip colour (a per-run uniform hue ramp,
// the C's make_uniform_colormap). Fibers are bubble-sorted back-to-front (painter's
// order) by their tip depth, exactly as the C does. See [[grav]] for the
// per-object physics idiom and [[braid]] for the vector-stroke idiom.

import { makeUniformColormapRGB } from './colormap.js';

export const title = 'fiberlamp';

export const info = {
  author: 'Tim Auckland',
  description: 'A fiber-optic lamp. Groovy.',
  year: 2005,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/fiberlamp.xml so the config box maps 1:1.
  // ncolors is a real resource (fiberlamp.c DEFAULTS *ncolors:64) but fiberlamp.xml
  // exposes no colour slider, so it is a fixed internal value, not a param.
  const config = {
    delay: 10000,    // microseconds between steps (--delay; stock xml default)
    count: 500,      // number of fibers (--count; stock xml default)
    cycles: 10000,   // frames between "knocks" of the lamp (--cycles)
    ncolors: 64,     // size of the tip colour wheel (--ncolors; DEFAULTS, no slider)
  };

  // live: true  -> the loop reads config every step (applies instantly).
  // live: false -> the value sizes the fiber array / tip palette, so a change
  //                re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Fibers', type: 'range', min: 10, max: 500, step: 10, default: 500, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'cycles', label: 'Time between knocks', type: 'range', min: 100, max: 10000, step: 100, default: 10000, lowLabel: 'short', highLabel: 'long', live: true },
  ];

  // Physics constants, verbatim from fiberlamp.c. Tuned in the original to keep
  // realism and avoid instability; do NOT raise NODES without lowering DT.
  const SPREAD = 30.0;       // angular spread at the base, degrees
  const NODES = 20;          // nodes per fiber (10..30; high values need small DT)
  const DT = 0.5;            // time increment: low is slow, high is less stable
  const PY = 0.12;           // rigidity: low droops, high is stiff
  const DAMPING = 0.055;     // damping: low oscillates, high is boring

  // Node lengths: uniform 1/(NODES-2.5) except the last 3 nodes (shorter, for the
  // colour-highlight tips). The sum over 0..NODES-1 is exactly 1.0.
  function LEN(a) {
    return a < NODES - 3 ? 1.0 / (NODES - 2.5) : 0.25 / (NODES - 2.5);
  }

  // Muted glass body colours (the C allocates these named X colours). The tips are
  // a separate per-run uniform hue ramp; these three are the depth cue.
  const BRIGHT = '#E0E0C0';  // front fibers
  const MEDIUM = '#808070';  // middle fibers
  const DIM = '#404020';     // back fibers

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let fibers;         // [{ node:[{phi,phidash,eta,etadash,x,y,z}], draw:[{x,y}] }]
  let cxOffset;       // base horizontal "knock" offset, in fiber units (-0.125..0.125)
  let psi;            // colour-wheel phase
  let dpsi;           // colour-wheel speed
  let count;          // frames since the last knock
  let palette;        // ncolors-entry tip rainbow
  let lineWidth;      // stroke width in device px
  let needsBackground; // paint black once after reinit/resize

  function drand(v) {
    return Math.random() * v;   // uniform 0 .. v, matching the C's DRAND
  }

  // The screen "scale" the C calls SCALE = MI_WIDTH/2; the knock offset is
  // (DRAND(SCALE/4) - SCALE/8) / SCALE = uniform in [-1/8, 1/8] (fiber units).
  function knock() {
    cxOffset = drand(1 / 4) - 1 / 8;   // [-0.125, 0.125]
    count = 0;
  }

  function makeFiber() {
    const phi = (Math.PI / 180) * drand(SPREAD);   // 0 .. 30 deg from vertical
    const eta = drand(2 * Math.PI) - Math.PI;       // -PI .. PI azimuth
    const node = new Array(NODES);
    const draw = new Array(NODES);
    for (let i = 0; i < NODES; i++) {
      node[i] = { phi: phi, phidash: 0, eta: eta, etadash: 0, x: 0, y: 0, z: 0 };
      draw[i] = { x: 0, y: 0 };
    }
    node[0].etadash = 0.002 / DT;   // tiny azimuthal kick at the base
    return { node: node, draw: draw };
  }

  // One bubble pass sorting fibers back-to-front by tip depth (z of the last
  // node). The order changes slowly, so a single pass per frame suffices — the C
  // does exactly this.
  function sortFibers() {
    for (let i = 1; i < fibers.length; i++) {
      if (fibers[i - 1].node[NODES - 1].z > fibers[i].node[NODES - 1].z) {
        const tmp = fibers[i - 1];
        fibers[i - 1] = fibers[i];
        fibers[i] = tmp;
      }
    }
  }

  // Integrate one fiber's physics and fill its draw[] points. cx/cy are the base
  // pixel position, sc the fiber->pixel scale (all device px).
  function stepFiber(fs, cx, cy, sc) {
    const nodes = fs.node;
    const draw = fs.draw;

    nodes[0].eta += DT * nodes[0].etadash;   // base azimuth drifts
    nodes[0].x = cxOffset;                    // base horizontal "knock"
    // The C deflects node[NODES-2].x by the X11 window's motion:
    //   node[NODES-2].x *= 0.1*(ry-y);  node[NODES-2].x += 0.05*(rx-x);
    // A browser canvas never moves, so (ry-y) == (rx-x) == 0. The ADD term
    // vanishes, but the MULTIPLY ZEROES node[NODES-2].x, and that zero is read by
    // the load loops below (for i < NODES-2) BEFORE the i == NODES-2 pass
    // recomputes it. So zero it here too -- dropping it entirely is NOT the same.
    nodes[NODES - 2].x = 0;

    // 2nd-order damped diff equation, node by node down the strand.
    for (let i = 1; i < NODES; i++) {
      const n = nodes[i];
      const p = nodes[i - 1];
      const leni = LEN(i);
      const pstress = (n.phi - p.phi) * PY;
      const estress = (n.eta - p.eta) * PY;
      const dxi = n.x - p.x;
      const dzi = n.z - p.z;
      const li = Math.sqrt(dxi * dxi + dzi * dzi) / leni;
      const drag = DAMPING * leni * leni * NODES * NODES;

      let pload = 0;   // radial load from all downstream nodes
      let eload = 0;   // transverse load from all downstream nodes
      if (li > 0) {
        for (let j = i + 1; j < NODES; j++) {
          const nn = nodes[j];
          const dxj = nn.x - n.x;
          const dzj = nn.z - n.z;
          const lenj = LEN(j);
          pload += lenj * (dxi * dxj + dzi * dzj) / li;
          eload += lenj * (dxi * dzj - dzi * dxj) / li;
        }
      }

      n.phidash += DT * (pload - pstress - drag * n.phidash) / leni;
      n.phi += DT * n.phidash;

      n.etadash += DT * (eload - estress - drag * n.etadash) / leni;
      n.eta += DT * n.etadash;

      // Position this node off its parent's angles (elevation view: project x,y).
      const sp = Math.sin(p.phi);
      const cp = Math.cos(p.phi);
      const se = Math.sin(p.eta);
      const ce = Math.cos(p.eta);
      const lenp = LEN(i - 1);
      n.x = p.x + lenp * ce * sp;
      n.y = p.y - lenp * cp;
      n.z = p.z + lenp * se * sp;

      // draw[i-1] is node i's screen point; draw[0..NODES-2] get set (NODES-1
      // points), draw[NODES-1] is never drawn (matches the C's index math).
      draw[i - 1].x = cx + sc * n.x;
      draw[i - 1].y = cy + sc * n.y;
    }
  }

  // Stroke one fiber: a body polyline (muted, by depth) plus a few tip segments in
  // the fiber's tip colour. The C draws exactly these two polylines -- no tip dot.
  function drawFiber(fs) {
    const nodes = fs.node;
    const draw = fs.draw;

    // Tip hue: from the base azimuth (node[1]) plus the turning colour wheel.
    const tx = nodes[1].x - cxOffset + 0.025;
    const ty = nodes[1].z + 0.02;
    const angle = Math.atan2(ty, tx) + psi;
    const n = config.ncolors;
    let ci = Math.trunc(n * angle / (2 * Math.PI)) % n;
    if (ci < 0) ci += n;
    const tcolor = palette[ci];

    // Depth -> body colour + how many segments belong to the tip.
    let tiplen, bodyColor;
    if (nodes[1].z < 0.0) {            // back
      tiplen = 2;
      bodyColor = DIM;
    } else if (nodes[NODES - 1].z < 0.7) {   // middle
      tiplen = 3;
      bodyColor = MEDIUM;
    } else {                          // front
      tiplen = 3;
      bodyColor = BRIGHT;
    }

    // Body: draw[0 .. NODES-1-tiplen] (the C draws NODES-tiplen points starting
    // at draw[0]). The valid points are draw[0..NODES-2].
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.strokeStyle = bodyColor;
    ctx.beginPath();
    ctx.moveTo(draw[0].x, draw[0].y);
    for (let i = 1; i <= NODES - 1 - tiplen; i++) ctx.lineTo(draw[i].x, draw[i].y);
    ctx.stroke();

    // Tip: the last `tiplen` points, draw[NODES-1-tiplen .. NODES-2] (the C draws
    // `tiplen` points starting at draw+NODES-1-tiplen).
    ctx.strokeStyle = tcolor;
    ctx.beginPath();
    ctx.moveTo(draw[NODES - 1 - tiplen].x, draw[NODES - 1 - tiplen].y);
    for (let i = NODES - tiplen; i <= NODES - 2; i++) ctx.lineTo(draw[i].x, draw[i].y);
    ctx.stroke();
  }

  // Base pixel position + fiber->pixel scale, handling weird (>5:1) aspect ratios
  // the way the C does. Normal aspect: base at bottom-centre, scale = W/2.
  let baseX, baseY, fiberScale;
  function layout() {
    let ww = W, hh = H;
    baseX = W / 2;
    baseY = H;            // elevation view: base at the bottom
    if (ww > hh * 5 || hh > ww * 5) {
      if (ww > hh) {
        hh = ww;
        baseY = hh / 4;
      } else {
        ww = hh;
        baseX = 0;
        baseY = hh * 3 / 4;
      }
    }
    fiberScale = ww / 2;
  }

  function step() {
    psi += dpsi;          // turn the colour wheel (once per frame, as in the C)
    layout();
    for (let f = 0; f < fibers.length; f++) {
      stepFiber(fibers[f], baseX, baseY, fiberScale);
    }
    sortFibers();
    if (count++ > config.cycles) knock();
  }

  function draw() {
    // Full repaint each frame (no trails): clear to black, then stroke all fibers
    // back-to-front.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    for (let f = 0; f < fibers.length; f++) drawFiber(fibers[f]);
    needsBackground = false;
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    layout();

    // Retina line width, like the C (lw = 3 past 2560 px, else 1), scaled by dpr.
    lineWidth = Math.max(1, Math.round((W > 2560 || H > 2560 ? 3 : 1) * S));

    // Tip colour wheel: the C's make_uniform_colormap (UNIFORM_COLORS) -- a full
    // hue ramp at a single per-run saturation/value, NOT a max-vivid hsl rainbow.
    palette = makeUniformColormapRGB(config.ncolors).map(([r, g, b]) => `rgb(${r},${g},${b})`);

    const n = Math.max(1, Math.round(config.count));
    fibers = new Array(n);
    for (let f = 0; f < n; f++) fibers[f] = makeFiber();

    psi = drand(2 * Math.PI);
    dpsi = 0.01;
    knock();             // seed the base offset and reset the counter

    // The C's draw_fiberlamp integrates one physics step BEFORE its first paint,
    // so do exactly one step here to fill draw[] (frame 1 = near-straight rods in
    // a 30-degree cone, just starting to droop -- the authentic power-on bloom;
    // no multi-step warm-up, which would skip that startup transient).
    for (let f = 0; f < n; f++) stepFiber(fibers[f], baseX, baseY, fiberScale);
    sortFibers();

    needsBackground = true;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator loop paced by config.delay (see squiral.js). The canvas is
  // fully repainted each frame, so step() advances physics and draw() repaints.
  // OVERHEAD: config.delay is a sleep FLOOR (the stock 10000 us / 100 fps target);
  // the real per-frame cost of stepping + vector-drawing count=500 fibers is
  // much higher. Live-measured: 39.8fps (Load 60.2%, clean) at stock delay 10000 ->
  // OVERHEAD 15100 (see fiberlamp.md); config.delay still maps 1:1 to --delay.
  const OVERHEAD = 15100;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay (microseconds, xml units) + measured framework OVERHEAD,
    // converted to the rAF clock's milliseconds.
    const delayMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    let advanced = false;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
      advanced = true;
    }

    if (advanced || needsBackground) draw();
    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (count/colors may differ; clears the canvas).
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
