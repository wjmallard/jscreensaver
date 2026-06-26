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
// 'round' gives the fuzzy rounded arm tips and central disc. See [[truchet]] for
// the Path2D bucketing idiom and [[squiral]] for the shared module skeleton.

export const title = 'fuzzyflakes';

export const info = {
  author: 'Barry Dmytro',
  description: 'Falling colored snowflake/flower shapes.',
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

  // Base colour presets, transcribed from the xml's <select id="color"> options.
  // The C's colour helper takes the chosen background colour's (hue, sat, lig)
  // and builds the two flake colours at the same sat/lig but +120 deg and +240
  // deg hue (an equidistant triad). "Pink" is the C default #efbea5 -> a soft
  // peach (high lightness => the muted pastel look); the explicit hues are pure
  // primaries (sat 100, lig 50 => vivid). h/s/l drive the triad below.
  const COLOR_PRESETS = {
    red: { h: 0, s: 100, l: 50 },
    pink: { h: 20, s: 70, l: 79 },
    yellow: { h: 60, s: 100, l: 50 },
    green: { h: 120, s: 100, l: 50 },
    cyan: { h: 180, s: 100, l: 50 },
    blue: { h: 240, s: 100, l: 50 },
    magenta: { h: 300, s: 100, l: 50 },
  };

  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;

  let S = 1;            // devicePixelRatio
  let cw, ch;           // canvas backing-store size (device px)
  let layers;           // array of layers; each is an array of flake objects
  let bgColor;          // background fill (the chosen base colour)
  let foreColor;        // arm core colour (base hue + 120 deg)
  let bordColor;        // arm outline colour (base hue + 240 deg)

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  const irand = (n) => Math.floor(Math.random() * n);

  // Build the background + two flake colours from the chosen base hue (or a
  // random one). All three share saturation/lightness; the flakes sit +120 deg
  // and +240 deg around the wheel, matching FuzzyFlakesColorHelper's triad.
  function buildColors() {
    let base;
    if (config.randomColors) {
      // A pleasant random base (vivid but not too dark, so the triad stays
      // visible) — the C rolls a fully random RGB, which we keep in a calm band.
      base = { h: irand(360), s: 55 + irand(35), l: 50 + irand(25) };
    } else {
      base = COLOR_PRESETS[config.color] || COLOR_PRESETS.pink;
    }
    bgColor = `hsl(${base.h}, ${base.s}%, ${base.l}%)`;
    foreColor = `hsl(${(base.h + 120) % 360}, ${base.s}%, ${base.l}%)`;
    bordColor = `hsl(${(base.h + 240) % 360}, ${base.s}%, ${base.l}%)`;
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

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

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
