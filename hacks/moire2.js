// moire2.js — moire2 packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's moire2.c (Jamie Zawinski, 1998).
// https://www.jwz.org/xscreensaver/
//
// Generates fields of concentric circles (zone plates) and combines the planes
// with additive interference. Two or three ring-fields, each centred at a point
// that drifts independently around the screen, are summed per pixel; where the
// rings beat against one another the level sets form moire fringes that "spray"
// as the centres slide past each other. The summed field indexes a smooth,
// continuously-cycling colour map, so the whole pattern shimmers through the
// spectrum. Every so often (the C's iteration countdown) the field count,
// centres, ring frequencies and combine mode are all re-rolled.
//
// Rendering: this is a dense per-pixel field rebuilt every frame (for each pixel
// sum each source's ring index, map the total + a cycling phase through the
// palette), so it uses the BLIT path — a Uint32 ImageData written once and
// putImageData'd per frame, rather than millions of per-pixel canvas calls. To
// keep retina affordable the field is computed at LOGICAL (CSS-pixel) resolution
// and the canvas upscales it (see moire2.md, "Deviations"); the C does the same
// in spirit via its ".lowrez: true" default.

export const title = 'moire2';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Generates fields of concentric circles or ovals, and combines the planes with various operations. The planes are moving independently of one another, causing the interference lines to spray.',
  year: 1998,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/moire2.xml so the config box maps 1:1
  // to the original. delay is microseconds (xml units). The stock hack exposes
  // delay + ncolors + thickness; `colorShift` (a C resource, not in the xml UI)
  // and `sources` (the C's 2-or-3 random choice, surfaced as a tunable) are
  // added for parity and control. A default delay a touch calmer than the C's
  // 50000 keeps the shimmer relaxed (see moire2.md).
  const config = {
    delay: 60000,      // \u00B5s between frames (--delay; C default 50000)
    ncolors: 150,      // size of the cycling colour map (--ncolors)
    thickness: 0,      // ring spacing; 0 = auto-random per reset (--thickness)
    colorShift: 5,     // frames per iteration-countdown tick (--colorShift)
    sources: 0,        // ring-fields to combine; 0 = the C's random 2-or-3
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 60000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'colorShift', label: 'Cycle speed', type: 'range', min: 1, max: 30, step: 1, default: 5, lowLabel: 'fast', highLabel: 'slow', invert: true, live: true },
    { key: 'thickness', label: 'Ring spacing (0 = auto)', type: 'range', min: 0, max: 40, step: 1, default: 0, lowLabel: 'fine', highLabel: 'coarse', live: false },
    { key: 'sources', label: 'Ring-fields (0 = auto)', type: 'range', min: 0, max: 3, step: 1, default: 0, lowLabel: 'auto', highLabel: 'three', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 150, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  const BLACK = 0xFF000000;

  let S;                 // devicePixelRatio
  let gw, gh;            // field grid size, LOGICAL px (== canvas px / S)
  let imageData, pixels; // Uint32 buffer at grid resolution
  let scratch, sctx;     // offscreen canvas holding the grid, upscaled to the main canvas

  let ncolors;           // captured colour count (2..255)
  let palette;           // Uint32Array(ncolors) packed ABGR: a smooth hue cycle

  let sources;           // [{ x, y, dx, dy, freq }, ...] drifting ring-field centres
  let nsources;          // 2 or 3 (the C's do_three) — captured for this reset
  let xorMode;           // combine by parity (XOR) vs additive sum (OR), per reset
  let phase;             // colour-cycle offset, advanced every frame (the C's pix)

  let iteration;         // frames since the last countdown tick (vs colorShift)
  let iterations;        // ticks remaining before a full re-roll (the C's reset)

  // frand(n) -> [0, n); randInt(n) -> 0..n-1 (the C's random() % n).
  const frand = (n) => Math.random() * n;
  const randInt = (n) => Math.floor(Math.random() * n);

  // hsl (h in [0,1)) -> [r,g,b] each 0-255, for a vivid full-spectrum colour
  // map (the C uses make_smooth_colormap; a saturated hue ramp is the analogue).
  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    const seg = Math.floor(h * 6) % 6;
    if (seg === 0) { r = c; g = x; }
    else if (seg === 1) { r = x; g = c; }
    else if (seg === 2) { g = c; b = x; }
    else if (seg === 3) { g = x; b = c; }
    else if (seg === 4) { r = x; b = c; }
    else { r = c; b = x; }
    return [
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255),
    ];
  }

  // Build the ncolors-entry palette as one full, smooth trip around the hue
  // wheel (saturated, mid lightness) — a wrap-around ramp so the cycling phase
  // can index it modulo ncolors with no seam. Packed little-endian ABGR.
  function buildPalette() {
    palette = new Uint32Array(ncolors);
    for (let i = 0; i < ncolors; i++) {
      const [r, g, b] = hslToRgb(i / ncolors, 1, 0.5);
      palette[i] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
  }

  // The C's reset FROB(N,DN,MAX): N starts at MAX/2 + random%MAX (so the centre
  // begins roughly on or just past the far edge, like the pixmap copy offset),
  // DN is a signed step of magnitude 1..7*thickness. We work in LOGICAL grid px.
  function frobInit(max, thick) {
    return {
      n: (max / 2) + randInt(max),
      dn: (1 + randInt(7 * thick)) * (randInt(2) ? 1 : -1),
    };
  }

  // The C's per-frame FROB(N,DN,MAX): advance N by DN, bounce off [0, MAX],
  // occasionally reverse DN, and occasionally nudge |DN| toward the middle of
  // its range. Mutates `o` in place (o.n, o.dn) against the bound `max`.
  function frobStep(o, max) {
    o.n += o.dn;
    if (o.n <= 0) { o.n = 0; o.dn = -o.dn; }
    else if (o.n >= max) { o.n = max; o.dn = -o.dn; }
    else if (randInt(100) === 0) { o.dn = -o.dn; }
    else if (randInt(50) === 0) {
      o.dn += (o.dn <= -20 ? 1 : (o.dn >= 20 ? -1 : (randInt(2) ? 1 : -1)));
    }
  }

  // Re-roll the whole scene (the C's reset_moire2 + the draw()'s reset block):
  // pick the field count, the per-field ring frequency, and a fresh drifting
  // centre + velocity for each field; choose XOR vs additive combine.
  function resetScene() {
    // do_three: 2 or 3 fields. config.sources overrides (0 = the C's random).
    nsources = config.sources > 0
      ? config.sources
      : (randInt(3) === 0 ? 3 : 2);

    // thickness drives ring spacing + drift speed. othickness>0 fixes it; else
    // the C picks 1 + random%4 per reset. Clamp to >=1 so frobInit stays sane.
    const othickness = config.thickness;
    const thick = othickness > 0 ? othickness : (1 + randInt(4));

    // xor: the C uses GXxor when do_three, thickness==1, or a coin flip.
    xorMode = (nsources >= 3) || (thick === 1) || (randInt(2) === 1);

    sources = new Array(nsources);
    for (let i = 0; i < nsources; i++) {
      const x = frobInit(gw, thick);
      const y = frobInit(gh, thick);
      // Ring spacing in grid px scales with thickness (the C steps arcs by
      // ~thickness px); freq = rings-per-pixel = 1 / spacing. A small random
      // stretch per field (the C's occasional maxx/maxy *= 1+frand(0.05))
      // detunes the fields so the moire beats instead of locking.
      const spacing = thick * (1 + frand(0.6)) + 1;
      sources[i] = {
        x: x.n,
        y: y.n,
        dx: x.dn,
        dy: y.dn,
        freq: 1 / spacing,
      };
    }
  }

  // One frame of the C's moire2_draw: drift every centre, rebuild the per-pixel
  // field (sum each source's ring index), map (field + phase) through the
  // cycling palette, blit + upscale. Then advance the colour phase and the
  // iteration countdown, re-rolling the scene when it expires.
  function step() {
    // Drift each centre (the C FROBs x/y against width/height every frame).
    for (let i = 0; i < nsources; i++) {
      const s = sources[i];
      const ox = { n: s.x, dn: s.dx };
      const oy = { n: s.y, dn: s.dy };
      frobStep(ox, gw);
      frobStep(oy, gh);
      s.x = ox.n; s.dx = ox.dn;
      s.y = oy.n; s.dy = oy.dn;
    }

    // Rebuild the field. For each pixel, ring index of source i is
    // floor(distance_i * freq_i); combine across sources by summing (additive
    // moire) or by parity (XOR mode), then add the cycling phase and index the
    // palette modulo ncolors. distSq*freq^2 under one sqrt keeps it to one
    // sqrt per pixel per source.
    const n = ncolors;
    const xor = xorMode;
    const ph = phase;
    let p = 0;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let acc = 0;
        for (let i = 0; i < nsources; i++) {
          const s = sources[i];
          const dxp = x - s.x;
          const dyp = y - s.y;
          const ring = (Math.sqrt(dxp * dxp + dyp * dyp) * s.freq) | 0;
          if (xor) acc ^= ring;
          else acc += ring;
        }
        let idx = (acc + ph) % n;
        if (idx < 0) idx += n;
        pixels[p++] = palette[idx];
      }
    }

    // Blit the grid, then upscale it onto the (device-px) main canvas.
    sctx.putImageData(imageData, 0, 0);
    if (S === 1) {
      ctx.drawImage(scratch, 0, 0);
    } else {
      ctx.drawImage(scratch, 0, 0, gw, gh, 0, 0, canvas.width, canvas.height);
    }

    // Cycle the colour map every frame (the C increments pix % ncolors).
    phase = (phase + 1) % n;

    // Iteration countdown: every colorShift frames drop one tick; at zero,
    // re-roll the whole scene (the C sets st->reset, which re-runs reset_moire2
    // and picks a fresh iterations = 30 + random%70 + random%70).
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
    // canvas upscales it, which keeps the per-frame pixel work independent of
    // dpr while staying crisp on retina (see moire2.md). The C's ".lowrez: true"
    // default does the morally equivalent thing on Retina.
    gw = Math.max(1, Math.round(canvas.width / S));
    gh = Math.max(1, Math.round(canvas.height / S));

    ncolors = Math.max(2, Math.min(255, Math.round(config.ncolors)));
    buildPalette();

    phase = 0;
    iteration = 0;
    iterations = 30 + randInt(70) + randInt(70);
    resetScene();

    // Pixel buffer + offscreen canvas at grid resolution.
    scratch = document.createElement('canvas');
    scratch.width = gw;
    scratch.height = gh;
    sctx = scratch.getContext('2d');
    imageData = sctx.createImageData(gw, gh);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    // Clear the visible canvas to black so frame zero starts clean.
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

  // rAF lag-accumulator paced by config.delay (µs): run one step() per delay,
  // banking leftover time so the pace is identical at any refresh rate. Cap
  // catch-up so a backgrounded tab doesn't fire a burst of steps on refocus.
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

  // Re-seed with the current config (rebuilds the palette, grid and sources
  // because ncolors/thickness/sources resize or re-roll them; also clears).
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
