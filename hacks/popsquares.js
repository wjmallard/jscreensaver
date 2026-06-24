// popsquares.js — popsquares packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }; the
// host renders the config box from `config`/`params`. Loop/sizing/units stay
// inline per hack.
//
// Port of xscreensaver's popsquares.c (Levi Burton, 2003).
// https://www.jwz.org/xscreensaver/
//
// Tiles the screen with a grid of squares, each smoothly cycling through a
// colour gradient so the whole grid gently pulses ("a pop-art-ish grid of
// pulsing colours, inspired by cheesy MTV commercials"). The gradient is a
// CLOSED colour ramp: it runs fg -> bg over the first half of the palette and
// then mirrors back bg -> fg over the second half, so colour++ wrapping at the
// end of the ramp produces a seamless dark->light->dark pulse. Each square just
// holds an index into that ramp and advances one step per frame; when a square
// reaches the end of the ramp it either re-rolls (twitch: occasionally re-rolls
// the WHOLE grid) or jumps to a fresh random index, which keeps the field from
// ever settling into lockstep.
//
// Rendering: a per-frame fillRect over the grid, exactly like the C's
// XFillRectangle loop — sparse enough (gw*gh small rects) that direct vector
// fills are the right tool; nothing is read back. `border` shrinks each drawn
// square so the black background shows as a thin grid of gaps. See [[squiral]]
// and [[greynetic]] for the grid skeleton this follows.

import { makeColorRampRGB } from './colormap.js';

export const title = 'popsquares';

export const info = {
  author: 'Levi Burton',
  description: 'A pop-art-ish looking grid of pulsing colors.',
  year: 2003,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/popsquares.xml. The stock hack picks the
  // ramp's two endpoints via the `bg` (light) and `fg` (dark) colour selects;
  // both are exposed here verbatim (six colours each, blue by default). `delay`
  // defaults to the stock 25000 us (the slider maps 1:1 to the xml resource);
  // the rAF loop adds a measured OVERHEAD so the effective rate matches the live
  // binary (see the OVERHEAD note by the loop, and framerate-calibration).
  const config = {
    delay: 25000,          // us between frames (--delay)
    subdivision: 5,        // grid fineness: screen split into ~this many cells (--subdivision)
    border: 1,             // px shaved off each square so a black grid shows (--border)
    ncolors: 128,          // length of the closed colour ramp (--ncolors)
    bg: '#0000FF',         // light endpoint = ramp peak (--bg); XML default "Light blue"
    fg: '#00008B',         // dark endpoint = ramp base (--fg); XML default "Dark blue"
    twitch: false,         // on ramp wrap, sometimes re-roll the whole grid (--twitch)
  };

  // live: true  -> the loop reads config every frame, so it applies instantly.
  // live: false -> the value sizes the grid / colour ramp, so changing it
  //                re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 25000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'subdivision', label: 'Subdivision', type: 'range', min: 1, max: 64, step: 1, default: 5, lowLabel: 'coarse', highLabel: 'fine', live: false },
    { key: 'border', label: 'Border', type: 'range', min: 0, max: 5, step: 1, default: 1, lowLabel: 'none', highLabel: 'thick', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 512, step: 1, default: 128, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'bg', label: 'Background', type: 'select', default: '#0000FF', live: false, options: [
        { value: '#FF0000', label: 'Light red' },
        { value: '#FFFF00', label: 'Light yellow' },
        { value: '#00FF00', label: 'Light green' },
        { value: '#00FFFF', label: 'Light cyan' },
        { value: '#0000FF', label: 'Light blue' },
        { value: '#FF00FF', label: 'Light magenta' },
      ] },
    { key: 'fg', label: 'Foreground', type: 'select', default: '#00008B', live: false, options: [
        { value: '#8C0000', label: 'Dark red' },
        { value: '#8C8C00', label: 'Dark yellow' },
        { value: '#008C00', label: 'Dark green' },
        { value: '#008C8C', label: 'Dark cyan' },
        { value: '#00008B', label: 'Dark blue' },
        { value: '#8C008C', label: 'Dark magenta' },
      ] },
    { key: 'twitch', label: 'Twitch', type: 'checkbox', default: false, live: true },
  ];

  let S = 1;            // devicePixelRatio
  let W, H;             // canvas size, device px
  let gw, gh;           // grid dimensions (squares across / down)
  let sw, sh;           // square dimensions, device px
  let squares;          // Int32Array of per-square ramp indices, length gw*gh
  let colors;           // closed colour ramp, ncolors CSS strings

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // RGB (0-255) -> HSV with h in [0,360), s/v in [0,1]. Mirrors the C's
  // rgb_to_hsv so the ramp endpoints land where popsquares.c puts them.
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    return [h, s, max];
  }

  // Build the closed colour ramp exactly like popsquares_init's make_color_ramp:
  // rgb_to_hsv the dark `fg` / light `bg` endpoints, then makeColorRampRGB with
  // closedP=true ramps HSV fg -> bg over the first floor(n/2)+1 entries (hue
  // truncated to int, channels 16-bit-quantized -- both handled by colormap.js)
  // and mirrors them back, giving a seamless fg -> bg -> fg loop. A square
  // stepping its index past the end wraps with no colour jump.
  function buildColors() {
    const n = Math.max(2, Math.round(config.ncolors));
    const [h1, s1, v1] = rgbToHsv(...hexToRgb(config.fg));  // dark end = ramp start
    const [h2, s2, v2] = rgbToHsv(...hexToRgb(config.bg));  // light end = ramp peak
    colors = makeColorRampRGB(h1, s1, v1, h2, s2, v2, n, true)
      .map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);
  }

  // Lay out the grid. Faithful to popsquares_reshape: clamp the subdivision for
  // tiny canvases, stretch it for extreme aspect ratios, then derive square
  // size sw/sh and grid count gw/gh from it. Each square starts on a random
  // ramp index (randomize_square_colors) so the very first frame is varied.
  function layout() {
    let s = Math.max(1, Math.round(config.subdivision));

    if (W < 100 * S || H < 100 * S) {           // tiny canvas
      const ss = Math.floor((W < H ? W : H) / (15 * S));
      s = ss < 1 ? 1 : ss;
    }

    let subx, suby;
    if (W > H * 5 || H > W * 5) {                // weird aspect ratio
      const r = W / H;
      // C assigns s*r / s/r to int subdivisionx/y -> truncates toward zero.
      if (r > 1) { suby = s; subx = Math.trunc(s * r); }
      else { subx = s; suby = Math.trunc(s / r); }
    } else {
      subx = suby = s;
    }

    sw = Math.floor(W / subx);
    sh = Math.floor(H / suby);
    gw = sw ? Math.floor(W / sw) : 0;
    gh = sh ? Math.floor(H / sh) : 0;
    let nsquares = gw * gh;
    if (nsquares < 1) { nsquares = 1; gw = gw || 1; gh = gh || 1; }

    squares = new Int32Array(nsquares);
    randomizeSquareColors();
  }

  function randomizeSquareColors() {
    const n = colors.length;
    for (let i = 0; i < squares.length; i++) {
      squares[i] = (Math.random() * n) | 0;
    }
  }

  // One frame, transcribed from popsquares_draw: draw every square at its current
  // ramp colour, then advance its index. When a square's index reaches the end it
  // re-rolls to a random index -- and with twitch on, a 1-in-4 wrap re-randomises
  // the ENTIRE grid mid-frame, so the not-yet-drawn squares in this same frame
  // already show their new colours (exactly like the C), a glitchy strobe. We
  // mutate squares[] in place (the C steps s->color through a pointer) so a
  // twitch re-roll sticks for the rest of the loop. `border` shaves the drawn
  // rect so the black background shows as a thin grid of gutters.
  function step() {
    const n = colors.length;
    const b = Math.round(config.border * S);
    const dw = b ? Math.max(1, sw - b) : sw;
    const dh = b ? Math.max(1, sh - b) : sh;

    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const idx = gw * y + x;
        ctx.fillStyle = colors[squares[idx]];
        ctx.fillRect(x * sw, y * sh, dw, dh);
        squares[idx]++;
        if (squares[idx] === n) {
          if (config.twitch && ((Math.random() * 4) | 0) === 0)
            randomizeSquareColors();
          else
            squares[idx] = (Math.random() * n) | 0;
        }
      }
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    buildColors();
    layout();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // reinit clears to black (the ramp or grid size may have changed) and re-seeds.
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    buildColors();
    layout();
  }

  // Drive off requestAnimationFrame but keep the original pace: one step() per
  // config.delay, banking leftover time so the speed is the same at any refresh
  // rate. Cap catch-up so a backgrounded tab doesn't fire a burst on refocus.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay popsquares runs 31.4 fps, while
  // the port at the stock 25000 us ran ~40 fps (1.3x fast). 25000 + 6847 =
  // 31847 us -> 31 fps, matching the live binary. A calibration, not a tuning
  // knob (the delay slider still maps 1:1 to the xml resource).
  const OVERHEAD = 6847;
  const MAX_CATCHUP_STEPS = 8;
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
    reinit,   // re-seed the ramp + grid + clear, keeping the current config
    config,
    params,
  };
}
