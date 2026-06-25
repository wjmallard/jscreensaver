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

export const title = 'popsquares';

export const info = {
  author: 'Levi Burton',
  description: 'A pop-art-ish grid of pulsing colors. Inspired by cheesy MTV commercials.',
  year: 2003,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/popsquares.xml. The stock hack lets you
  // pick fg/bg colour-pair endpoints for the ramp; here that becomes a `palette`
  // select (the faithful blue default, the other XML colour pairs, plus a vivid
  // full-spectrum rainbow that the brief invites). `delay` is a touch calmer
  // than the stock 25000 us so the pulse reads as a gentle breathe.
  const config = {
    delay: 50000,          // us between frames (--delay); stock is 25000
    subdivision: 5,        // grid fineness: screen split into ~this many cells (--subdivision)
    border: 1,             // px shaved off each square so a black grid shows (--border)
    ncolors: 128,          // length of the closed colour ramp (--ncolors)
    palette: 'blue',       // ramp endpoints; 'rainbow' = full-spectrum hue sweep
    twitch: false,         // on ramp wrap, sometimes re-roll the whole grid (--twitch)
  };

  // live: true  -> the loop reads config every frame, so it applies instantly.
  // live: false -> the value sizes the grid / colour ramp, so changing it
  //                re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 50000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'subdivision', label: 'Subdivision', type: 'range', min: 1, max: 64, step: 1, default: 5, lowLabel: 'coarse', highLabel: 'fine', live: false },
    { key: 'border', label: 'Border', type: 'range', min: 0, max: 5, step: 1, default: 1, lowLabel: 'none', highLabel: 'thick', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 512, step: 1, default: 128, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'palette', label: 'Palette', type: 'select', default: 'blue', live: false, options: [
        { value: 'blue', label: 'blue (default)' },
        { value: 'red', label: 'red' },
        { value: 'yellow', label: 'yellow' },
        { value: 'green', label: 'green' },
        { value: 'cyan', label: 'cyan' },
        { value: 'magenta', label: 'magenta' },
        { value: 'rainbow', label: 'rainbow' },
      ] },
    { key: 'twitch', label: 'Twitch', type: 'checkbox', default: false, live: true },
  ];

  // The XML's fg (dark, ramp start) / bg (light, ramp end) colour pairs, as
  // [fgHex, bgHex]. The ramp pulses from the dark end up to the light end and
  // back; the default is xscreensaver's dark-blue -> light-blue.
  const PAIRS = {
    blue:    ['#00008B', '#0000FF'],
    red:     ['#8C0000', '#FF0000'],
    yellow:  ['#8C8C00', '#FFFF00'],
    green:   ['#008C00', '#00FF00'],
    cyan:    ['#008C8C', '#00FFFF'],
    magenta: ['#8C008C', '#FF00FF'],
  };

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

  // HSV -> "rgb(r,g,b)" CSS string. h in [0,360) (wrapped), s/v in [0,1].
  function hsvToCss(h, s, v) {
    h = ((h % 360) + 360) % 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return `rgb(${Math.round((r + m) * 255)}, ${Math.round((g + m) * 255)}, ${Math.round((b + m) * 255)})`;
  }

  // Build the closed colour ramp exactly like make_color_ramp(..., closed_p).
  // First half ramps HSV1 -> HSV2 across `half = floor(n/2)+1` steps (the deltas
  // divide by `half`, matching the C), then the second half mirrors it back:
  // colors[i] = colors[n - i]. The result is a seamless fg->bg->fg loop, so a
  // square stepping its index past the end wraps with no colour jump.
  function buildColors() {
    const n = Math.max(2, Math.round(config.ncolors));
    colors = new Array(n);

    let h1, s1, v1, h2, s2, v2;
    if (config.palette === 'rainbow') {
      // A full-spectrum closed loop: hue 0 -> 360 (mirrored) at full sat/value.
      h1 = 0; s1 = 1; v1 = 1;
      h2 = 360; s2 = 1; v2 = 1;
    } else {
      const [fgHex, bgHex] = PAIRS[config.palette] || PAIRS.blue;
      [h1, s1, v1] = rgbToHsv(...hexToRgb(fgHex));  // dark end = ramp start
      [h2, s2, v2] = rgbToHsv(...hexToRgb(bgHex));  // light end = ramp peak
      // hexToRgb on a pure-blue endpoint yields h=240 for both ends, so the ramp
      // is a pure value pulse; rgbToHsv keeps h stable when s collapses anyway.
    }

    const half = ((n / 2) | 0) + 1;
    const dh = (h2 - h1) / half;
    const ds = (s2 - s1) / half;
    const dv = (v2 - v1) / half;
    for (let i = 0; i < half; i++) {
      colors[i] = hsvToCss(h1 + i * dh, s1 + i * ds, v1 + i * dv);
    }
    for (let i = half; i < n; i++) {
      colors[i] = colors[n - i];   // mirror the back half (closed loop)
    }
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
      if (r > 1) { suby = s; subx = Math.round(s * r); }
      else { subx = s; suby = Math.round(s / r); }
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

  // One frame: draw every square at its current ramp colour, then advance its
  // index. A square that runs off the end of the ramp re-rolls — and with
  // twitch on, a 1-in-4 wrap re-rolls the entire grid at once for a glitchy
  // strobe. `border` shaves the drawn rect so the black grid lines show.
  function step() {
    const n = colors.length;
    const b = Math.round(config.border * S);
    const dw = b ? Math.max(1, sw - b) : sw;
    const dh = b ? Math.max(1, sh - b) : sh;

    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const idx = gw * y + x;
        let c = squares[idx];
        ctx.fillStyle = colors[c];
        ctx.fillRect(x * sw, y * sh, dw, dh);
        c++;
        if (c >= n) {
          if (config.twitch && ((Math.random() * 4) | 0) === 0) {
            randomizeSquareColors();
            return;   // the whole grid was just re-rolled; next frame draws it
          }
          c = (Math.random() * n) | 0;
        }
        squares[idx] = c;
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
    reinit,   // re-seed the ramp + grid + clear, keeping the current config
    config,
    params,
  };
}
