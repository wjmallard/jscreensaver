// halftone.js — halftone packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's halftone.c (Peter Jaric, 2002).
// https://www.jwz.org/xscreensaver/
//
// A halftone dot pattern in motion. A regular grid of dots is laid over the
// screen; each dot's size is driven by the magnitude of the summed gravitational
// field of several moving point-masses. As the masses drift across the field
// (bouncing off the 0..1 edges), the field ripples and the dot sizes pulse, so
// the grid reads as a halftone print of a slowly churning gravity well. View it
// from a distance for best effect. Each frame: clear to the background colour,
// then recompute the field at every grid node and redraw the whole grid as
// filled discs whose diameter is field*maxDotSize.
//
// Rendering: per-dot filled arc on a cleared canvas — sparse (a grid node count
// of width/spacing * height/spacing, each a single arc), so plotting discs over
// a clear each frame is the natural fit, matching the C's XFillRectangle (clear)
// + XFillArc-per-dot. The C's off-screen Pixmap double-buffer is unneeded: the
// browser composites the canvas, so we draw straight to it.

export const title = 'halftone';

export const info = {
  author: 'Peter Jaric',
  description: 'A halftone dot pattern in motion.\n\nDraws the gravity force in each point on the screen seen through a halftone dot pattern. The gravity force is calculated from a set of moving mass points. View it from a distance for best effect.\n\nhttps://en.wikipedia.org/wiki/Halftone',
  year: 2002,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/halftone.xml so the config box maps 1:1.
  // (delay nudged a touch calmer than the stock 10000 µs for a gentler pulse.)
  const config = {
    delay: 40000,      // µs between steps (--delay)
    count: 10,         // number of moving gravity point-masses (--count)
    spacing: 14,       // grid pitch in px between dots (--spacing, "Dot size")
    sizeFactor: 1.5,   // max dot diameter = sizeFactor * spacing (--sizefactor)
    minSpeed: 0.001,   // slowest mass speed per axis, fraction/step (--minspeed)
    maxSpeed: 0.02,    // fastest mass speed per axis, fraction/step (--maxspeed)
    minMass: 0.001,    // smallest mass (--minmass)
    maxMass: 0.02,     // largest mass (--maxmass)
    ncolors: 200,      // size of the rainbow palette (--colors)
    cycleSpeed: 10,    // ticks between colour advances (--cycle-speed)
  };

  // live: true  -> the loop reads config every step, so the change applies now.
  // live: false -> the value sizes the grid / masses / palette, so a change
  //                re-runs init() via reinit() (which also clears the canvas).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 40000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Gravity points', type: 'range', min: 1, max: 50, step: 1, default: 10, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'spacing', label: 'Dot size', type: 'range', min: 2, max: 50, step: 1, default: 14, lowLabel: 'small', highLabel: 'big', live: false },
    { key: 'sizeFactor', label: 'Dot fill factor', type: 'range', min: 0.1, max: 3, step: 0.1, default: 1.5, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'minSpeed', label: 'Minimum speed', type: 'range', min: 0.001, max: 0.09, step: 0.001, default: 0.001, lowLabel: 'low', highLabel: 'high', live: false },
    { key: 'maxSpeed', label: 'Maximum speed', type: 'range', min: 0.001, max: 0.09, step: 0.001, default: 0.02, lowLabel: 'low', highLabel: 'high', live: false },
    { key: 'minMass', label: 'Minimum mass', type: 'range', min: 0.001, max: 0.09, step: 0.001, default: 0.001, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'maxMass', label: 'Maximum mass', type: 'range', min: 0.001, max: 0.09, step: 0.001, default: 0.02, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 4, max: 255, step: 1, default: 200, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'cycleSpeed', label: 'Color cycle speed', type: 'range', min: 0, max: 50, step: 1, default: 10, lowLabel: 'fast', highLabel: 'slow', live: true },
  ];

  let S = 1;            // devicePixelRatio
  let W, H;             // canvas size, device px
  let spacing;          // grid pitch, device px
  let maxDotSize;       // max dot diameter, device px (sizeFactor * spacing)
  let dotsW, dotsH;     // grid dimensions (nodes across / down)
  let dots;             // Float32Array(dotsW * dotsH): per-node field, clamped 0..1

  // Moving gravity point-masses (parallel arrays, like the C's struct of arrays).
  let gx, gy;           // position in 0..1 normalized space
  let gMass;            // mass
  let gxInc, gyInc;     // per-axis velocity (fraction of the 0..1 box per step)

  // Smooth rainbow palette + the two cycling indices (the C's color0/color1).
  let palette;          // ncolors CSS strings
  let color0, color1;   // background index / dot index into the palette
  let colorTick;        // counts up to config.cycleSpeed, then advances the colours

  function floatRand(min, max) {
    return min + Math.random() * (max - min);
  }

  function buildPalette() {
    const n = Math.max(4, Math.round(config.ncolors));
    palette = new Array(n);
    for (let i = 0; i < n; i++) palette[i] = `hsl(${(i * 360 / n) | 0}, 85%, 55%)`;
  }

  // Magnitude of the summed gravitational field at grid node (x, y), matching the
  // C's calculate_gravity. Distances are taken in GRID space: a mass at fraction
  // (gx,gy) sits at grid coords (gx*dotsW, gy*dotsH). For each mass the field is
  //   gravity = mass / (dist^2 / (dotsW*dotsH))  =  mass * dotsW * dotsH / dist^2
  // added as a vector (gxSum,gySum) along the unit direction to the mass; the dot
  // value is the length of that summed vector. The dist==0 guard skips a mass
  // sitting exactly on a node (avoids the divide-by-zero / blow-up there).
  function calculateGravity(x, y) {
    let gxSum = 0;
    let gySum = 0;
    const n = gx.length;
    for (let i = 0; i < n; i++) {
      const dx = x - gx[i] * dotsW;
      const dy = y - gy[i] * dotsH;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist !== 0) {
        const gravity = gMass[i] / (dist * dist / (dotsW * dotsH));
        gxSum += (dx / dist) * gravity;
        gySum += (dy / dist) * gravity;
      }
    }
    return Math.sqrt(gxSum * gxSum + gySum * gySum);
  }

  // Recompute every node's clamped field value (the C's update loop body).
  function updateField() {
    for (let x = 0; x < dotsW; x++) {
      for (let y = 0; y < dotsH; y++) {
        const g = calculateGravity(x, y);
        dots[x + y * dotsW] = g > 1 ? 1 : (g < 0 ? 0 : g);
      }
    }
  }

  // Advance the masses one step (the C's update_halftone mass loop). The bounce
  // test runs BEFORE the move, off the CURRENT position, exactly as in the C: a
  // mass at/over an edge flips that axis's increment, then the increment is added.
  function moveMasses() {
    const n = gx.length;
    for (let i = 0; i < n; i++) {
      if (gx[i] >= 1 || gx[i] <= 0) gxInc[i] = -gxInc[i];
      if (gy[i] >= 1 || gy[i] <= 0) gyInc[i] = -gyInc[i];
      gx[i] += gxInc[i];
      gy[i] += gyInc[i];
    }
  }

  // Fill a disc of diameter d centred on (cx, cy), matching the C's fill_circle,
  // which starts the bounding box at (cx - d/2, cy - d/2) with width/height d.
  function disc(cx, cy, d) {
    if (d <= 0) return;
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Paint one frame (the C's repaint_halftone): fill the background in color0,
  // advance the cycling colours every cycleSpeed ticks, then stamp each grid node
  // as a disc of diameter maxDotSize*field in color1.
  function paint() {
    ctx.fillStyle = palette[color0];
    ctx.fillRect(0, 0, W, H);

    if (colorTick++ >= config.cycleSpeed) {
      colorTick = 0;
      color0 = (color0 + 1) % palette.length;
      color1 = (color1 + 1) % palette.length;
    }

    ctx.fillStyle = palette[color1];
    for (let x = 0; x < dotsW; x++) {
      for (let y = 0; y < dotsH; y++) {
        disc(x * spacing, y * spacing, maxDotSize * dots[x + y * dotsW]);
      }
    }
  }

  // One animation step: paint the current field, then move the masses and
  // recompute the field for the next paint (the C's repaint then update order).
  function step() {
    paint();
    moveMasses();
    updateField();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // Grid pitch in device px. The C triples spacing past 2560 px for retina; we
    // fold devicePixelRatio in instead (S already tracks the retina scale), and
    // keep at least 2 px so a dot is always visible.
    spacing = Math.max(2, Math.round(config.spacing * S));
    maxDotSize = config.sizeFactor * spacing;

    // dots_width = width/spacing + 1 (one extra node to cover the far edge).
    dotsW = Math.floor(W / spacing) + 1;
    dotsH = Math.floor(H / spacing) + 1;
    dots = new Float32Array(dotsW * dotsH);   // zero-filled

    buildPalette();
    color0 = 0;
    color1 = (palette.length / 2) | 0;
    colorTick = 0;

    // Sanitize the speed/mass ranges the way the C does (clamp negatives, and
    // raise max to min if a max slider was dragged below its min).
    let minSpeed = config.minSpeed < 0 ? 0 : config.minSpeed;
    let maxSpeed = config.maxSpeed < 0 ? 0 : config.maxSpeed;
    if (maxSpeed < minSpeed) maxSpeed = minSpeed;
    let minMass = config.minMass < 0 ? 0 : config.minMass;
    let maxMass = config.maxMass < 0 ? 0 : config.maxMass;
    if (maxMass < minMass) maxMass = minMass;

    // Seed the moving point-masses (the C's halftone_init mass loop). Positions
    // are uniform in 0..1; mass and per-axis speed are uniform in their ranges.
    const n = Math.max(1, Math.round(config.count));
    gx = new Float64Array(n);
    gy = new Float64Array(n);
    gMass = new Float64Array(n);
    gxInc = new Float64Array(n);
    gyInc = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      gx[i] = Math.random();
      gy[i] = Math.random();
      gMass[i] = floatRand(minMass, maxMass);
      gxInc[i] = floatRand(minSpeed, maxSpeed);
      gyInc[i] = floatRand(minSpeed, maxSpeed);
    }

    // Compute the field once now so the FIRST painted frame already shows the
    // halftone pattern (the C paints an all-zero/blank first frame; we don't).
    updateField();

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

  // rAF lag-accumulator paced by config.delay (µs): run one step() per delay,
  // banking leftover time so the speed is identical at any refresh rate. Cap
  // catch-up so a backgrounded tab doesn't burst a run of steps on refocus.
  const MAX_CATCHUP_STEPS = 8;
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
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (clears the canvas; grid/masses/palette may
  // differ after a non-live config change).
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
