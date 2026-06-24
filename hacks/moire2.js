// moire2.js -- moire2 packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's moire2.c (Jamie Zawinski, 1998).
// https://www.jwz.org/xscreensaver/
//
// FAITHFUL pipeline (rebuilt 2026-06-27 after a fidelity audit; the previous
// port flattened all three stages into a per-pixel rainbow -- see moire2.md):
//
//   * Each "plane" is a stack of THIN concentric rings: line width = thickness,
//     ring-to-ring spacing ii = thickness + 1 + (xor?0:1) + random%(4*thickness),
//     centred at a point that drifts (and bounces) around the screen. 1/5 of
//     planes are inverted (the C's whole-plane GXxor fill); 1/5 get a slight
//     elliptical stretch on one axis (the maxx/maxy *= 1+frand(.05)).
//   * 2 or 3 planes are combined into ONE BIT per pixel by a bitwise op: GXor
//     (OR) or GXxor (XOR). xor is chosen when there are 3 planes, thickness==1,
//     or a coin flip -- exactly the C.
//   * The 1-bit field is shown 2-TONE: "on" bits one colour, "off" bits the
//     other. One of the two is a single colour slowly CYCLING through a smooth
//     colormap (pix++ % ncolors each frame); the other is a fixed black/white.
//     flip_a chooses which bit cycles; flip_b chooses the fixed tone.
//
// Colour comes from make_smooth_colormap (hacks/colormap.js) -- a random 2-5
// anchor HSV loop, built once per launch like the C (it builds the map once in
// moire2_init_1 and only the cycling index moves).
//
// Rendering: the 1-bit field is rebuilt every frame into a Uint32 ImageData at
// LOGICAL (CSS-pixel) resolution and the canvas upscales it with smoothing OFF
// (crisp rings, like the 1-bit pixmap); the C does the morally equivalent thing
// via its ".lowrez: true" default on Retina.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'moire2';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Generates fields of concentric circles or ovals, and combines the planes with various operations. The planes are moving independently of one another, causing the interference lines to spray.\n\nhttps://en.wikipedia.org/wiki/Moire_pattern',
  year: 1998,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/moire2.xml so the config box maps 1:1 to the
  // original. delay is microseconds (xml units; C default 50000). The stock
  // hack exposes delay + ncolors + thickness; colorShift (a C resource) and
  // sources (the C's 2-or-3 random choice) are surfaced for control.
  const config = {
    delay: 50000,      // microseconds between frames (--delay; C default 50000)
    ncolors: 150,      // size of the cycling colour map (--ncolors)
    thickness: 0,      // ring spacing/width; 0 = auto-random per reset
    colorShift: 5,     // frames per re-roll countdown tick (--colorShift)
    sources: 0,        // ring-fields to combine; 0 = the C's random 2-or-3
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 50000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'colorShift', label: 'Re-roll rate', type: 'range', min: 1, max: 30, step: 1, default: 5, lowLabel: 'fast', highLabel: 'slow', invert: true, live: true },
    { key: 'thickness', label: 'Ring spacing (0 = auto)', type: 'range', min: 0, max: 40, step: 1, default: 0, lowLabel: 'fine', highLabel: 'coarse', live: false },
    { key: 'sources', label: 'Ring-fields (0 = auto)', type: 'range', min: 0, max: 3, step: 1, default: 0, lowLabel: 'auto', highLabel: 'three', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 150, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  const WHITE = 0xFFFFFFFF;
  const BLACK = 0xFF000000;

  let S;                 // devicePixelRatio
  let gw, gh, size;      // field grid size (LOGICAL px == canvas px / S); size = max(gw,gh)
  let imageData, pixels; // Uint32 buffer at grid resolution
  let scratch, sctx;     // offscreen canvas holding the grid, upscaled to the main canvas

  let ncolors;           // captured colour count (2..255)
  let palette;           // Uint32Array(ncolors) packed ABGR (make_smooth_colormap)
  let mono;              // ncolors <= 2: plain white-on-black, no cycle (the C's mono_p)

  let planes;            // [{ xo, yo, ii, lw, invert, ax, ay }, ...] drifting ring-fields
  let nplanes;           // 2 or 3 (the C's do_three)
  let xorMode;           // combine by GXxor (parity) vs GXor (union), per reset
  let flipA, flipB;      // the C's per-reset colour flips
  let pix;               // colour-cycle index, advanced every frame (the C's pix)

  let iteration;         // frames since the last countdown tick (vs colorShift)
  let iterations;        // ticks remaining before a full re-roll (the C's reset)

  // frand(n) -> [0, n); randInt(n) -> 0..n-1 (the C's random() % n).
  const frand = (n) => Math.random() * n;
  const randInt = (n) => Math.floor(Math.random() * n);

  // Build the ncolors-entry palette from make_smooth_colormap (random 2-5 HSV
  // anchors, often muted, built once per launch like the C). Packed ABGR.
  function buildPalette() {
    palette = new Uint32Array(ncolors);
    const map = makeSmoothColormapRGB(ncolors);
    for (let i = 0; i < ncolors; i++) {
      const [r, g, b] = map[i];
      palette[i] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
  }

  // The C's reset FROB(N,DN,MAX): N starts at MAX/2 + random%MAX, DN is a signed
  // step of magnitude 1..7*thickness. These are the plane's copy offsets; the
  // ring centre on screen is (size - N) (the plane is 2x oversized, centred).
  function frobInit(max, thick) {
    return {
      n: (max / 2) + randInt(max),
      dn: (1 + randInt(7 * thick)) * (randInt(2) ? 1 : -1),
    };
  }

  // The C's per-frame FROB(N,DN,MAX): advance N by DN, bounce off [0, MAX],
  // occasionally reverse DN, occasionally nudge |DN| toward its mid-range.
  function frobStep(o, max) {
    o.n += o.dn;
    if (o.n <= 0) { o.n = 0; o.dn = -o.dn; }
    else if (o.n >= max) { o.n = max; o.dn = -o.dn; }
    else if (randInt(100) === 0) { o.dn = -o.dn; }
    else if (randInt(50) === 0) {
      o.dn += (o.dn <= -20 ? 1 : (o.dn >= 20 ? -1 : (randInt(2) ? 1 : -1)));
    }
  }

  // Re-roll the whole scene (the C's reset_moire2 + the draw() reset block):
  // pick the plane count, each plane's ring spacing/width/invert/ellipse and a
  // fresh drifting centre, choose the combine op (xor vs or) and the colour flips.
  function resetScene() {
    // do_three: 2 or 3 planes. config.sources overrides (0 = the C's random).
    nplanes = config.sources > 0
      ? config.sources
      : (randInt(3) === 0 ? 3 : 2);

    // thickness drives ring spacing/width + drift speed. othickness>0 fixes it;
    // else the C picks 1 + random%4 per reset.
    const othickness = config.thickness;
    const thick = othickness > 0 ? othickness : (1 + randInt(4));

    // xor: the C uses GXxor when do_three, thickness==1, or a coin flip.
    xorMode = (nplanes >= 3) || (thick === 1) || (randInt(2) === 1);

    planes = new Array(nplanes);
    for (let i = 0; i < nplanes; i++) {
      // Ring spacing ii = thick + 1 + (xor?0:1) + random%(4*thick) -- verbatim.
      const ii = thick + 1 + (xorMode ? 0 : 1) + randInt(4 * thick);
      // line_width = (thickness==1 ? 0 : thickness); width 0 = 1px thin line.
      const lw = Math.max(1, thick);
      // 1/5 chance the whole plane is inverted (the C's GXxor full-plane fill).
      const invert = randInt(5) === 0 ? 1 : 0;
      // 1/5 chance one axis stretches ~5% (the C's maxx/maxy *= 1+frand(.05)).
      let ax = 1, ay = 1;
      if (randInt(5) === 0) {
        if (randInt(2)) ax = 1 / (1 + frand(0.05));
        else ay = 1 / (1 + frand(0.05));
      }
      planes[i] = {
        xo: frobInit(gw, thick),
        yo: frobInit(gh, thick),
        ii, lw, invert, ax, ay,
      };
    }

    // Per-reset colour flips (the C's flip_a/flip_b; both False when mono).
    flipA = mono ? false : (randInt(2) === 1);
    flipB = mono ? false : (randInt(2) === 1);
  }

  // One frame of moire2_draw: drift every centre, rebuild the 1-bit field
  // (OR/XOR of each plane's ring membership), paint it 2-tone with one tone
  // cycling, blit + upscale, then advance the cycle + re-roll countdown.
  function step() {
    // Drift each plane's copy offset (the C FROBs x/y every frame).
    for (let i = 0; i < nplanes; i++) {
      const pl = planes[i];
      frobStep(pl.xo, gw);
      frobStep(pl.yo, gh);
    }

    // Two display tones. resetFg/resetBg are the fixed black/white pair (swapped
    // by flip_b); cyc is the cycling colour. flip_a picks which bit cycles.
    const cyc = mono ? WHITE : palette[pix];
    const resetFg = flipB ? BLACK : WHITE;
    const resetBg = flipB ? WHITE : BLACK;
    const onColor = mono ? WHITE : (flipA ? resetFg : cyc);
    const offColor = mono ? BLACK : (flipA ? cyc : resetBg);

    // Precompute per-plane screen centre + constants for the inner loop.
    const np = nplanes;
    const cx = new Float64Array(np), cy = new Float64Array(np);
    const ii = new Float64Array(np), lw = new Float64Array(np);
    const ax = new Float64Array(np), ay = new Float64Array(np);
    const inv = new Int32Array(np);
    for (let i = 0; i < np; i++) {
      const pl = planes[i];
      cx[i] = size - pl.xo.n;
      cy[i] = size - pl.yo.n;
      ii[i] = pl.ii; lw[i] = pl.lw; ax[i] = pl.ax; ay[i] = pl.ay; inv[i] = pl.invert;
    }
    const xor = xorMode;

    let p = 0;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let bit = 0;
        for (let i = 0; i < np; i++) {
          const dx = (x - cx[i]) * ax[i];
          const dy = (y - cy[i]) * ay[i];
          const d = Math.sqrt(dx * dx + dy * dy);
          // Thin ring membership: on iff within line-width of a ring radius.
          let on = (d - Math.floor(d / ii[i]) * ii[i]) < lw[i] ? 1 : 0;
          on ^= inv[i];
          if (xor) bit ^= on;
          else bit |= on;
        }
        pixels[p++] = bit ? onColor : offColor;
      }
    }

    sctx.putImageData(imageData, 0, 0);
    ctx.imageSmoothingEnabled = false;     // crisp 1-bit rings, like .lowrez
    if (S === 1) ctx.drawImage(scratch, 0, 0);
    else ctx.drawImage(scratch, 0, 0, gw, gh, 0, 0, canvas.width, canvas.height);

    // Cycle the colour map every frame (the C: pix++ % ncolors).
    if (!mono) pix = (pix + 1) % ncolors;

    // Re-roll countdown: every colorShift frames drop one tick; at zero re-roll
    // (the C sets reset, re-running reset_moire2 with a fresh iterations count).
    iteration++;
    if (iteration >= Math.max(1, config.colorShift)) {
      iteration = 0;
      iterations--;
      if (iterations <= 0) {
        iterations = 30 + randInt(70) + randInt(70);
        resetScene();
      }
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;

    // Field grid is the canvas at LOGICAL resolution (canvas px / dpr); the
    // canvas upscales it (smoothing off). The C's ".lowrez: true" default does
    // the morally equivalent thing on Retina.
    gw = Math.max(1, Math.round(canvas.width / S));
    gh = Math.max(1, Math.round(canvas.height / S));
    size = Math.max(gw, gh);

    ncolors = Math.max(2, Math.min(255, Math.round(config.ncolors)));
    mono = ncolors <= 2;
    buildPalette();          // built once per launch, like the C

    pix = 0;
    iteration = 0;
    iterations = 30 + randInt(70) + randInt(70);
    resetScene();

    scratch = document.createElement('canvas');
    scratch.width = gw;
    scratch.height = gh;
    sctx = scratch.getContext('2d');
    imageData = sctx.createImageData(gw, gh);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced by config.delay (microseconds): one step() per
  // delay, banking leftover time so the pace is refresh-rate independent.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // The live moire2 measures 15.8 fps, but the port at the stock 50000 us ran
  // 20 steps/sec (1.27x fast). 50000 + 13291 = 63291 us -> 15.8 steps/sec,
  // matching the live binary. A calibration, not a tuning knob (the delay
  // slider still maps 1:1 to the xml resource).
  const OVERHEAD = 13291;
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
