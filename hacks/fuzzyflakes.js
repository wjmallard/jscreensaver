// fuzzyflakes.js — fuzzyflakes packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's fuzzyflakes.c (Barry Dmytro, 2004).
// https://www.jwz.org/xscreensaver/
//
// Falling pastel snowflake / flower shapes (inspired by the Azumanga Daioh
// credits). A field of soft, slowly-rotating n-armed flakes drifts downward over
// a flat coloured background, in several parallax LAYERS: near layers fall fast
// and are large/thick, far layers fall slow and are small/thin. Each arm is a
// thick line drawn from the flake centre outward, painted twice — a wider
// "border" colour underneath and a narrower "fore" colour on top — so every arm
// reads as a coloured core with a contrasting outline; the arms all share the
// centre, so their round caps overlap into a central disc. The whole field is
// repainted every frame (background fill + every flake), so there is no smear and
// no XOR trickery.
//
// Rendering: SPARSE vector strokes, not per-pixel accumulation. Within a layer
// every flake shares the same line width and the two colours, so all of a
// layer's arms are accumulated into two Path2Ds (border pass, then fore pass) and
// stroked once each — 2 strokes per layer instead of one per arm. lineCap
// 'square' matches the C's CapProjecting (square arm tips); since every arm
// shares the flake centre, the overlapping inner projections fill a central
// core. See [[truchet]] for the Path2D bucketing idiom and [[squiral]] for the
// shared module skeleton.

export const title = 'fuzzyflakes';

export const info = {
  author: 'Barry Dmytro',
  description: 'Falling colored snowflake/flower shapes.\n\nhttps://en.wikipedia.org/wiki/Snowflake',
  year: 2004,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/fuzzyflakes.xml (and the C resource
  // table for `density`, which the modern xml doesn't expose). `delay` is in
  // microseconds (xml units); every size below is logical CSS px, scaled by the
  // devicePixelRatio (S) at draw time so flakes look the same on retina.
  const config = {
    delay: 10000,         // microseconds between steps (--delay)
    speed: 10,            // falling speed; also drives sway + rotation (--speed)
    layers: 3,            // parallax depth layers, near..far (--layers)
    density: 5,           // flakes per layer per ~200px of width (--density)
    arms: 5,              // arms per flake (--arms)
    thickness: 10,        // arm core line width, CSS px (--thickness)
    bthickness: 3,        // extra outline width per side, CSS px (--bthickness)
    radius: 20,           // flake radius, CSS px (--radius)
    color: 'pink',        // base colour scheme (--color); flakes are +120/+240 deg
    randomColors: false,  // roll a random base hue instead (--random-colors)
  };

  // live: true  -> the loop reads config[key] every step (applies instantly):
  //                rate, falling speed, and the per-flake render knobs (which
  //                don't resize anything, just change how each flake is drawn).
  // live: false -> the value sizes the flake arrays / palette, so a change
  //                re-runs init() via reinit() (re-seeds a fresh field).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 1, max: 50, step: 1, default: 10, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'layers', label: 'Layers', type: 'range', min: 1, max: 10, step: 1, default: 3, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'density', label: 'Density', type: 'range', min: 1, max: 20, step: 1, default: 5, lowLabel: 'sparse', highLabel: 'dense', live: false },
    { key: 'arms', label: 'Arms', type: 'range', min: 1, max: 10, step: 1, default: 5, lowLabel: 'few', highLabel: 'many', live: true },
    { key: 'thickness', label: 'Thickness', type: 'range', min: 1, max: 50, step: 1, default: 10, lowLabel: 'thin', highLabel: 'thick', live: true },
    { key: 'bthickness', label: 'Border thickness', type: 'range', min: 0, max: 50, step: 1, default: 3, lowLabel: 'thin', highLabel: 'thick', live: true },
    { key: 'radius', label: 'Radius', type: 'range', min: 1, max: 100, step: 1, default: 20, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'color', label: 'Colors', type: 'select', default: 'pink', live: false, options: [
        { value: 'red', label: 'Red' },
        { value: 'pink', label: 'Pink' },
        { value: 'yellow', label: 'Yellow' },
        { value: 'green', label: 'Green' },
        { value: 'cyan', label: 'Cyan' },
        { value: 'blue', label: 'Blue' },
        { value: 'magenta', label: 'Magenta' },
      ] },
    { key: 'randomColors', label: 'Random colors', type: 'checkbox', default: false, live: false },
  ];

  // Base colour presets, the exact base colours from the xml's <select
  // id="color"> options (Pink = the C default #efbea5; the rest are the
  // arg-set hexes). The background is painted in the base colour verbatim and
  // the two flake colours are derived from it by flakeColors() below — NOT a
  // tidy hue rotation; see that function.
  const COLOR_PRESETS = {
    red: 0xff0000,
    pink: 0xefbea5,
    yellow: 0xffff00,
    green: 0x00ff00,
    cyan: 0x00ffff,
    blue: 0x0000ff,
    magenta: 0xff00ff,
  };

  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;

  // Per-step compute overhead beyond the *delay sleep floor, measured off the
  // live binary's -fps overlay. A clean SOLO re-measure (no concurrent load)
  // reads ~48-49 fps at ~50% Load (sleep floor holding at 10000 us), below the
  // earlier contended/vsync-influenced 54.1, so OVERHEAD = round(1e6/49) - 10000
  // ~= 10400. The loop paces on (config.delay + OVERHEAD) so the field falls at
  // the author's rate, not the display refresh rate.
  const OVERHEAD = 10400;  // microseconds

  let S = 1;            // devicePixelRatio
  let cw, ch;           // canvas backing-store size (device px)
  let layers;           // array of layers; each is an array of flake objects
  let bgColor;          // background fill (the chosen base colour, verbatim)
  let foreColor;        // arm core colour (FuzzyFlakesColorHelper "fore")
  let bordColor;        // arm outline colour (FuzzyFlakesColorHelper "bord")

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  const irand = (n) => Math.floor(Math.random() * n);

  // Exact port of fuzzyflakes.c's FuzzyFlakesColorHelper. Decompose the base
  // RGB to HSL, then rebuild the two flake colours with the C's OWN (peculiar,
  // non-standard) reconstruction: tempR=(H+1)/3, tempG=H, tempB=(H-1)/3 fed
  // through the usual HSL piecewise. This is NOT a clean +120/+240 hue rotation
  // — e.g. base #efbea5 yields a pale-yellow "fore" and a dusty-rose "bord",
  // matching the live binary (verified to within +/-1 per channel). Returns
  // null when the base is too desaturated (Sat < 0.03), the C's failure case.
  function flakeColors(r, g, b) {
    const fR = r / 255, fG = g / 255, fB = b / 255;
    let Max = 0, Min = 0;
    if (fR >= fG && fR >= fB) Max = fR;
    if (fG >= fR && fG >= fB) Max = fG;
    if (fB >= fR && fB >= fG) Max = fB;
    if (fR <= fG && fR <= fB) Min = fR;
    if (fG <= fR && fG <= fB) Min = fG;
    if (fB <= fR && fB <= fG) Min = fB;
    const Lig = (Max + Min) / 2;
    let Sat;
    if (Max === Min) Sat = 0;
    else if (Lig < 0.5) Sat = (Max - Min) / (Max + Min);
    else Sat = (Max - Min) / (2 - Max - Min);
    if (Sat < 0.03) return null;
    let Hue;
    if (fR === Max) Hue = (fG - fB) / (Max - Min);
    else if (fG === Max) Hue = 2 + (fB - fR) / (Max - Min);
    else Hue = 4 + (fR - fG) / (Max - Min);
    Hue /= 6;
    let Hue0 = Hue + 1 / 3; if (Hue0 > 1) Hue0 -= 1;
    let Hue1 = Hue0 + 1 / 3; if (Hue1 > 1) Hue1 -= 1;
    const f2 = Lig < 0.5 ? Lig * (1 + Sat) : (Lig + Sat) - (Lig * Sat);
    const f1 = (2 * Lig) - f2;
    // One HSL channel from a wrapped temp (matches the C's per-channel block).
    const chan = (t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (6 * t < 1) return f1 + (f2 - f1) * 6 * t;
      if (2 * t < 1) return f2;
      if (3 * t < 2) return f1 + (f2 - f1) * (2 / 3 - t) * 6;
      return f1;
    };
    // The C truncates (float -> unsigned int) before the hex round-trip.
    const toRGB = (h) => {
      const cr = Math.floor(chan((h + 1) / 3) * 255);
      const cg = Math.floor(chan(h) * 255);
      const cb = Math.floor(chan((h - 1) / 3) * 255);
      return `rgb(${cr}, ${cg}, ${cb})`;
    };
    return { fore: toRGB(Hue0), bord: toRGB(Hue1) };
  }

  // Pick the base colour (a preset hex, or a fully random RGB like the C) and
  // derive the flake colours from it. The C rolls a random RGB and retries the
  // helper when it returns failure (Sat < 0.03); we do the same.
  function buildColors() {
    let r, g, b, fb;
    if (config.randomColors) {
      do {
        r = irand(256); g = irand(256); b = irand(256);
        fb = flakeColors(r, g, b);
      } while (!fb);
    } else {
      const hex = COLOR_PRESETS[config.color] != null ? COLOR_PRESETS[config.color] : COLOR_PRESETS.pink;
      r = (hex >> 16) & 255; g = (hex >> 8) & 255; b = hex & 255;
      fb = flakeColors(r, g, b);
      if (!fb) {   // a too-grey base -> the C reverts to a random colour
        do {
          r = irand(256); g = irand(256); b = irand(256);
          fb = flakeColors(r, g, b);
        } while (!fb);
      }
    }
    bgColor = `rgb(${r}, ${g}, ${b})`;
    foreColor = fb.fore;
    bordColor = fb.bord;
  }

  // Seed a full, evenly-spread field so frame 1 already looks right. Per-layer
  // count follows the C's Density = (width / 200) * density, but measured in
  // LOGICAL px (innerWidth) so the flake count is the same at any dpr. Positions
  // are in device px; phases (Angle, Ticks, XOffset) are random so no two flakes
  // sway or spin in lockstep.
  function init() {
    S = window.devicePixelRatio || 1;
    cw = canvas.width;
    ch = canvas.height;

    buildColors();

    const layerCount = clamp(Math.round(config.layers), 1, 10);
    const density = clamp(Math.round(config.density), 1, 20);
    let per = Math.floor(window.innerWidth / 200) * density;
    per = clamp(per, 1, 500);

    layers = [];
    for (let L = 1; L <= layerCount; L++) {
      const arr = [];
      for (let j = 0; j < per; j++) {
        const xpos = Math.random() * cw;
        arr.push({
          XPos: xpos,                       // fixed column centre (device px)
          YPos: Math.random() * ch,         // falling position (device px)
          TrueX: xpos,                       // XPos + horizontal sway (device px)
          Angle: Math.random() * TAU,        // rotation (radians)
          Ticks: irand(360),                 // sway phase counter (degrees, ++/step)
          XOffset: Math.random() * TAU,      // per-flake sway phase offset
        });
      }
      layers.push(arr);
    }

    draw();   // paint the seeded field immediately so there's no blank first frame
  }

  // Advance every flake one tick: fall (slower the farther the layer), sway
  // horizontally on a sine, and rotate slowly. A flake fully past the bottom
  // respawns at the top of its column. Faithful to FuzzyFlakesMove; the wrap test
  // uses the BASE radius (config.radius), as the C does, not the layer radius.
  function move() {
    const sf = config.speed / 10;
    const radiusBasePx = config.radius * S;
    for (let li = 0; li < layers.length; li++) {
      const L = li + 1;                 // 1-based depth: 1 = nearest/fastest
      const arr = layers[li];
      const fall = (sf / L) * S;
      for (let k = 0; k < arr.length; k++) {
        const f = arr[k];
        f.Ticks++;
        f.YPos += fall;
        f.TrueX = Math.sin(f.XOffset + f.Ticks * DEG * sf) * 10 * S + f.XPos;
        f.Angle += 0.005 * sf;
        if (f.YPos - radiusBasePx > ch) {
          f.Ticks = 0;
          f.YPos = -radiusBasePx;
        }
      }
    }
  }

  // Repaint the whole field: flat background, then every flake from the farthest
  // layer to the nearest (so near flakes land on top). Each layer is drawn in two
  // passes — all border arms (wider, outline colour) then all fore arms
  // (narrower, core colour) — bucketed into one Path2D per pass so the layer
  // costs 2 strokes regardless of flake count.
  function draw() {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, cw, ch);

    ctx.lineCap = 'square';   // C's CapProjecting (square arm tips)
    ctx.lineJoin = 'miter';   // C's JoinMiter (no joins occur on 2-point arms)

    const arms = clamp(Math.round(config.arms), 1, 100);
    const thickness = config.thickness;
    const bthickness = config.bthickness;
    const radius = config.radius;

    for (let li = layers.length - 1; li >= 0; li--) {
      const L = li + 1;
      const arr = layers[li];

      // Farther layers shrink (radius - L*5) and thin out (widths / L). Clamp the
      // radius to >= 1px so deep layers stay tiny dots instead of going negative.
      let rCss = radius - L * 5;
      if (rCss < 1) rCss = 1;
      const r = rCss * S;
      const borderW = Math.max(0.5, ((bthickness * 2 + thickness) / L) * S);
      const foreW = Math.max(0.5, (thickness / L) * S);

      const bPath = new Path2D();
      const fPath = new Path2D();
      for (let k = 0; k < arr.length; k++) {
        const f = arr[k];
        const cx = f.TrueX, cy = f.YPos;
        for (let a = 1; a <= arms; a++) {
          const ang = (TAU / arms) * a + f.Angle;
          const x = cx + Math.cos(ang) * r;
          const y = cy + Math.sin(ang) * r;
          bPath.moveTo(cx, cy);
          bPath.lineTo(x, y);
          fPath.moveTo(cx, cy);
          fPath.lineTo(x, y);
        }
      }

      ctx.lineWidth = borderW;
      ctx.strokeStyle = bordColor;
      ctx.stroke(bPath);

      ctx.lineWidth = foreW;
      ctx.strokeStyle = foreColor;
      ctx.stroke(fPath);
    }
  }

  // One step == advance the field one tick and repaint it (the C's per-frame
  // FuzzyFlakesMove + full redraw).
  function step() {
    move();
    draw();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Drive off requestAnimationFrame but keep the original pace: run one step()
  // per config.delay ms, banking leftover time so the speed is the same at any
  // refresh rate. Cap catch-up so a backgrounded tab (where rAF is paused)
  // doesn't fire a burst of steps when it regains focus.
  const MAX_CATCHUP_STEPS = 4;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
    // Add OVERHEAD so the step rate matches the live binary's effective fps
    // (delay is a sleep floor, not the whole frame cost).
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

  // Rebuild after a non-live config change: re-seed a fresh field (init() also
  // repaints), and reset the lag so the new field doesn't jump.
  function reinit() {
    lag = 0;
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
    reinit,   // re-seed a fresh field, keeping the current config
    config,
    params,
  };
}
