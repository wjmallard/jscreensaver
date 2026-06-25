// moire.js — moire packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's moire.c (Jamie Zawinski & Michael Bayne, 1997).
// https://www.jwz.org/xscreensaver/
//
// Concentric circular sine gratings: for each pixel the C computes the squared
// distance to a centre divided by a random "factor" (ring spacing), then maps
// that value through a colour ramp — i = ((x+xo)^2 + (y+yo)^2) / factor, colour
// = colors[floor(i) % ncolors]. The banded rings plus the colour wrap give the
// moire fringe look. The C draws ONE static pattern, scanned top-to-bottom in
// 20-row XShm chunks, then after `delay` seconds picks a fresh random centre and
// redraws from scratch.
//
// Here we keep the grating math verbatim but (1) render the whole frame at once
// — the row-chunking is an XShm artifact, not an aesthetic — (2) sum several
// gratings so overlapping ring systems produce true moire interference fringes
// (a single grating is just concentric rings; the moire effect needs >=2), and
// (3) drift each centre slowly every frame so the fringes crawl instead of
// snapping to a new still each `delay`. See Deviations in moire.md.
//
// Rendering: pure per-pixel field (distance -> palette index), so it uses the
// BLIT path — a Uint32 view over one ImageData, write every pixel, putImageData
// once per frame. Cheap enough for the full backing store even on retina. See
// the closest twins [[greynetic]] (per-pixel canvas) and [[binaryring]]
// (Uint32 ImageData blit), and the style reference [[squiral]].

export const title = 'moire';

export const info = {
  author: 'Jamie Zawinski and Michael Bayne',
  description: 'When the lines on the screen make more lines in between, that\u2019s a moir\u00E9!',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/moire.xml so the config box maps 1:1 to
  // the original: `delay` is the redraw cadence (the xml calls it "Duration",
  // 1-60 s); `ncolors` the colour-ramp size; `offset` the upper bound of the
  // random ring-spacing factor (xml "Offset", small = tight rings). `centers`
  // and `cycle` are added for the moire enhancement (the C's single static
  // grating can't actually interfere) — see moire.md.
  const config = {
    delay: 33000,     // \u00B5s between frames (drives the drift speed; calmer than stock)
    ncolors: 64,      // size of the colour ramp (--ncolors)
    offset: 50,       // upper bound of the per-centre ring-spacing factor (--offset)
    centers: 2,       // number of overlapping gratings (2+ = true moire fringes)
    cycle: true,      // slowly rotate the palette so a near-still frame still shimmers
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 33000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'centers', label: 'Gratings', type: 'range', min: 1, max: 5, step: 1, default: 2, lowLabel: 'rings', highLabel: 'moire', live: false },
    { key: 'offset', label: 'Offset', type: 'range', min: 1, max: 200, step: 1, default: 50, lowLabel: 'tight', highLabel: 'loose', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'cycle', label: 'Color cycling', type: 'checkbox', default: true, live: true },
  ];

  let W, H, S;                // canvas size (device px) and devicePixelRatio
  let imageData, pixels;      // the frame buffer: Uint32 view over ImageData
  let palette;                // ncolors packed-ABGR ring colours
  let centers;                // [{ x, y, vx, vy, factor }, ...] in device px
  let phase;                  // palette-cycle offset, advanced each frame

  // hsl (h in [0,1)) -> [r,g,b] each 0-255 (matches thornbird.js / the gallery).
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

  // A vivid rainbow ramp packed as 0xFFBBGGRR (little-endian ImageData layout),
  // standing in for the C's foreground->background make_color_ramp (which by
  // default ramps random hue to random hue). Index wraps mod ncolors, so the
  // ring banding reads as a smooth repeating spectrum.
  function buildPalette() {
    const n = Math.max(2, Math.round(config.ncolors));
    palette = new Uint32Array(n);
    for (let p = 0; p < n; p++) {
      const [r, g, b] = hslToRgb(p / n, 1, 0.5);
      palette[p] = (0xff << 24 | b << 16 | g << 8 | r) >>> 0;
    }
  }

  // Seed the grating centres. The C picks ONE centre offset uniformly in
  // [-w/2, w/2) x [-h/2, h/2) (so the actual ring centre lands on/near screen)
  // and a factor of random()%offset + 1. We do the same per centre, and give
  // each a slow random drift velocity so the rings crawl frame to frame.
  function seedCenters() {
    const n = Math.max(1, Math.round(config.centers));
    const off = Math.max(2, Math.round(config.offset));
    centers = new Array(n);
    for (let i = 0; i < n; i++) {
      centers[i] = {
        // ring centre on/near the visible area (device px)
        x: Math.random() * W,
        y: Math.random() * H,
        // slow drift: a fraction of a logical pixel per frame, scaled for retina
        vx: (Math.random() * 2 - 1) * 0.6 * S,
        vy: (Math.random() * 2 - 1) * 0.6 * S,
        // ring spacing: bigger factor = wider-spaced rings (the C's draw_factor).
        // Scale by S^2 because the distance term is squared device px on retina,
        // so the visible ring spacing stays the same as at dpr 1.
        factor: ((Math.random() * off) + 1) * S * S,
      };
    }
  }

  // Drift the centres, bouncing off the edges so they never wander far off the
  // visible area (the C keeps its single centre on/near screen by construction).
  function moveCenters() {
    for (const c of centers) {
      c.x += c.vx;
      c.y += c.vy;
      if (c.x < 0) { c.x = 0; c.vx = -c.vx; }
      else if (c.x > W) { c.x = W; c.vx = -c.vx; }
      if (c.y < 0) { c.y = 0; c.vy = -c.vy; }
      else if (c.y > H) { c.y = H; c.vy = -c.vy; }
    }
  }

  // One frame: for every pixel sum each grating's ring value
  // (dx^2 + dy^2) / factor, take that sum mod ncolors as the palette index, and
  // write the packed colour. Summing quadratics from >=2 centres is what yields
  // the moire interference fringes; `phase` rotates the palette for a slow
  // shimmer. yy and dy^2 are hoisted per row so the inner loop is tight.
  function render() {
    const n = centers.length;
    const ncolors = palette.length;
    // Snapshot centre x/y and 1/factor (turn the per-pixel divide into a mul).
    const cx = new Float64Array(n);
    const cy = new Float64Array(n);
    const inv = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      cx[k] = centers[k].x;
      cy[k] = centers[k].y;
      inv[k] = 1 / centers[k].factor;
    }

    let idx = 0;
    for (let y = 0; y < H; y++) {
      // Per-row: dy and dy^2 for each centre (independent of x).
      const dy2 = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const dy = y - cy[k];
        dy2[k] = dy * dy;
      }
      for (let x = 0; x < W; x++) {
        let sum = 0;
        for (let k = 0; k < n; k++) {
          const dx = x - cx[k];
          sum += (dx * dx + dy2[k]) * inv[k];
        }
        // floor(sum) mod ncolors, made positive, plus the cycling phase.
        let ci = (Math.floor(sum) + phase) % ncolors;
        if (ci < 0) ci += ncolors;
        pixels[idx++] = palette[ci];
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }

  // One step == drift the centres, advance the palette phase (if cycling), and
  // repaint the whole field.
  function step() {
    moveCenters();
    if (config.cycle) phase = (phase + 1) % palette.length;
    render();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    phase = 0;
    buildPalette();
    seedCenters();
    render();   // paint the first frame immediately so it looks right at t=0
  }

  // reinit: fresh palette + fresh random centres, then a clean first frame.
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

  // Drive off requestAnimationFrame but keep the original pace: one step() per
  // config.delay, banking leftover time so the speed is the same at any refresh
  // rate. Cap catch-up so a backgrounded tab doesn't fire a burst on refocus.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
    const delayMs = config.delay / 1000;
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
    reinit,   // fresh palette + centres, keeping the current config
    config,
    params,
  };
}
