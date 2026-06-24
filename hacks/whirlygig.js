// whirlygig.js — whirlygig packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's whirlygig.c (Ashton Trey Belew, 2001). It was removed
// from the XScreenSaver distribution as of 5.08. https://www.jwz.org/xscreensaver/
//
// A global integer clock `currentTime` ticks up by `speed` every step. Each step
// draws `whirlies` filled circles ("spots") whose centre is a sin/cos function
// of an offset clock (so the spots string out into a chain), and `nlines` copies
// of each spot fanned out by an oscillating per-line offset. Several "modes"
// (spin/funky/circle/linear/test/fun/innie/lissajous) choose the x and y curve;
// the default "change" mode re-rolls the x/y modes every 4000 ticks. Spot size
// pulses, and the hue cycles through a rainbow as the chain crawls and zooms.
//
// Rendering: SPARSE vector drawing — at most whirlies*nlines small filled
// arcs per step, so it uses ctx.arc/fill directly (no per-pixel buffer). With
// "trail" off the frame is cleared each step (the chain glides, leaving no
// trail); with "trail" on the canvas is never cleared, so the spots accumulate.
// See [[spiral]] (drifting sinusoid + sparse fillRect) and [[whirlwindwarp]]
// (sparse particle plotting on a persistent canvas).

import { makeUniformColormapRGB } from './colormap.js';

export const title = 'whirlygig';

export const info = {
  author: 'Ashton Trey Belew',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nZooming chains of sinusoidal spots.',
  year: 2001,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/whirlygig.xml so the config box maps
  // 1:1 to the original. whirlygig.c has no *delay resource -- its draw callback
  // returns a fixed 10000 us floor; the slider maps 1:1 to that stock value and
  // the rAF loop adds a measured framework OVERHEAD (see frame()).
  const config = {
    delay: 10000,        // \u00B5s sleep floor (whirlygig_draw returns 10000)
    whirlies: 0,         // spots per line; 0 = random 1..15 (xml --whirlies -1)
    nlines: 0,           // lines of spots; 0 = random 1..5 (xml --nlines -1)
    xspeed: 1.0,         // frequency factor for the x curve (xml --xspeed)
    yspeed: 1.0,         // frequency factor for the y curve (xml --yspeed)
    xamplitude: 1.0,     // amplitude factor for the x curve (xml --xamplitude)
    yamplitude: 1.0,     // amplitude factor for the y curve (xml --yamplitude)
    xmode: 'change',     // x curve mode, or 'change' to auto-switch (xml --xmode)
    ymode: 'change',     // y curve mode, or 'change' to auto-switch (xml --ymode)
    trail: false,        // leave a trail: never clear (xml --trail)
    wrap: false,         // wrap spots that leave the screen (xml --wrap)
    speed: 1,            // currentTime increment per step (xml --speed)
    color_modifier: -1,  // hue gap between successive spots; -1 = random 1..25
    offset_period: 1.0,  // period of the per-line offset oscillation
    xoffset: 1.0,        // per-line x offset factor
    yoffset: 1.0,        // per-line y offset factor
    ncolors: 100,        // palette size (xml NCOLORS)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 60000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'xmode', label: 'X mode', type: 'select', options: [
        { value: 'change', label: 'Change' },
        { value: 'spin', label: 'Spin' },
        { value: 'funky', label: 'Funky' },
        { value: 'circle', label: 'Circle' },
        { value: 'linear', label: 'Linear' },
        { value: 'test', label: 'Test' },
        { value: 'fun', label: 'Fun' },
        { value: 'innie', label: 'Innie' },
        { value: 'lissajous', label: 'Lissajous' },
      ], default: 'change', live: true },
    { key: 'ymode', label: 'Y mode', type: 'select', options: [
        { value: 'change', label: 'Change' },
        { value: 'spin', label: 'Spin' },
        { value: 'funky', label: 'Funky' },
        { value: 'circle', label: 'Circle' },
        { value: 'linear', label: 'Linear' },
        { value: 'test', label: 'Test' },
        { value: 'fun', label: 'Fun' },
        { value: 'innie', label: 'Innie' },
        { value: 'lissajous', label: 'Lissajous' },
      ], default: 'change', live: true },
    { key: 'whirlies', label: 'Whirlies (0 = random)', type: 'range', min: 0, max: 50, step: 1, default: 0, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'nlines', label: 'Lines (0 = random)', type: 'range', min: 0, max: 50, step: 1, default: 0, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'xspeed', label: 'X speed', type: 'range', min: 0.1, max: 10, step: 0.1, default: 1, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'yspeed', label: 'Y speed', type: 'range', min: 0.1, max: 10, step: 0.1, default: 1, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'xamplitude', label: 'X amplitude', type: 'range', min: 0, max: 10, step: 0.1, default: 1, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'yamplitude', label: 'Y amplitude', type: 'range', min: 0, max: 10, step: 0.1, default: 1, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'trail', label: 'Leave a trail', type: 'checkbox', default: false, live: true },
    { key: 'wrap', label: 'Wrap the screen', type: 'checkbox', default: false, live: true },
  ];

  // Simulation constants, from whirlygig.c.
  const TWOPI = 2.0 * Math.PI;
  const FULL_CYCLE = 429496729;   // the C's clock wrap point
  const CHANGE_TIME = 4000;       // ticks between "change" mode re-rolls
  // enum object_mode: spin=0, funky=1, circle=2, linear=3, test=4, fun=5,
  // innie=6, lissajous=7. "change" picks among funky..test (1..4).
  const MODE_INDEX = {
    circle: 2,
    fun: 5,
    funky: 1,
    innie: 6,
    linear: 3,
    lissajous: 7,
    spin: 0,
    test: 4,
  };

  let S = 1;            // devicePixelRatio
  let W, H;             // canvas size, device px
  let hw, hh;           // half width / height, LOGICAL px (the C's half_width/height)
  let palette;          // ncolors rainbow CSS strings

  // Runtime clock + state (the C's struct state scalars).
  let currentTime;      // global tick, drives every curve
  let startTime;        // timestamp of the last "change" mode re-roll
  let currentColor;     // base palette index, advanced each step
  let colorModifier;    // hue gap between successive whirlies (resolved random)
  let modifier;         // innie-mode frequency wobble (3000 + frand(1500))
  let whirlies;         // resolved spot count
  let nlines;           // resolved line count
  let xmode, ymode;     // current numeric modes (re-rolled in "change")

  function nrand(n) {
    return Math.floor(Math.random() * n);
  }

  function resolveMode(str) {
    const m = MODE_INDEX[str];
    return m === undefined ? 0 : m;
  }

  // The C's preen(): a single-step wrap into [0, max] (not a full modulo).
  function preen(current, max) {
    if (current > max) current -= max;
    if (current < 0) current += max;
    return current;
  }

  // whirlygig.c is a NATIVE screenhack that builds its palette with
  // make_uniform_colormap (= make_color_ramp(0,S,V -> 359,S,V), with S and V each
  // a single per-run random in 66%-100%). So it is a full hue ramp, but on any
  // given run somewhat desaturated/dimmed -- not the fixed max-vivid hsl() rainbow
  // the first port used. makeUniformColormapRGB is the faithful port; it re-rolls
  // S,V per call (i.e. per init), matching the C re-rolling per whirlygig_init.
  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    palette = makeUniformColormapRGB(n).map(([r, g, b]) => `rgb(${r},${g},${b})`);
  }

  // One axis of one whirly: returns the LOGICAL-pixel position. isX picks the
  // x family (cos / half_width / xspeed / xamplitude); !isX the y family (sin /
  // half_height / yspeed / yamplitude). Formulae transcribed verbatim from the
  // per-mode functions in whirlygig.c. Result is truncated to an int like the
  // C's int pos[] array.
  function computeAxis(mode, t, isX) {
    const half = isX ? hw : hh;
    const speed = isX ? config.xspeed : config.yspeed;
    const amp = isX ? config.xamplitude : config.yamplitude;
    let v;
    switch (mode) {
      case 0: {   // spin
        const phase = ((t % 360) / 180.0) * Math.PI;
        if (isX) {
          const c = Math.cos(t / (180.0 * speed));
          const d = Math.cos(phase) * (half - 50);
          v = amp * (c * d) + half;
        } else {
          const s = Math.sin(t / (180.0 * speed));
          const d = Math.sin(phase) * (half - 50);
          v = amp * (s * d) + half;
        }
        break;
      }
      case 1: {   // funky
        const nt = ((t % 360) / 180.0) * Math.PI;
        if (isX) {
          const tm = Math.cos(nt / 180.0);
          const c = Math.cos(nt * speed + tm * 80.0);
          const d = Math.cos(nt) * (half - 50);
          v = amp * (c * d) + half;
        } else {
          const tm = Math.sin(nt / 180.0);
          const s = Math.sin(nt * speed + tm * 80.0);
          const d = Math.sin(nt) * (half - 50);
          v = amp * (s * d) + half;
        }
        break;
      }
      case 2:     // circle
      case 4: {   // test (identical formula to circle in the C)
        const trig = isX ? Math.cos(t / 100.0 * speed) : Math.sin(t / 100.0 * speed);
        v = amp * (trig * Math.floor(half / 2)) + half;
        break;
      }
      case 3: {   // linear
        v = Math.floor(t / 2) % (half * 2);
        break;
      }
      case 5: {   // fun
        const max = hw;   // the C uses half_width for the triangle on both axes
        const tt = t % (max * 2);
        let amplitude = (tt < max) ? (max - (tt - max)) : tt;
        amplitude = amplitude - max;
        const trig = isX ? Math.cos(t / 100.0 * speed) : Math.sin(t / 100.0 * speed);
        v = amplitude * trig + half;
        break;
      }
      case 6: {   // innie
        const frequency = 2000000.0 + modifier * Math.cos(t / 100.0);
        const arg = t / frequency;
        const amplitude = 200.0 * Math.cos(arg);
        const funv = 150.0 * Math.cos(t / 2000.0);
        if (isX) {
          const horiz = Math.trunc(funv * Math.cos(t / 100.0)) + half;
          v = amplitude * Math.cos(t / 100.0 * speed) + horiz;
        } else {
          const vert = Math.trunc(funv * Math.sin(t / 100.0)) + half;
          v = amplitude * Math.sin(t / 100.0 * speed) + vert;
        }
        break;
      }
      case 7: {   // lissajous
        const time = t / 100.0;
        const funv = 15.0 * Math.cos(t / 800.0);
        const weird = Math.cos((time / 1100000.0) / 1000.0);
        v = isX
          ? amp * 200.0 * Math.sin(weird * time + funv) + half
          : amp * 200.0 * Math.sin(time) + half;
        break;
      }
      default:    // spin
        return computeAxis(0, t, isX);
    }
    return Math.trunc(v);
  }

  // Draw one filled spot. xpos/ypos/size are LOGICAL px; the C's XFillArc draws
  // a full circle whose bounding box top-left is (xpos,ypos) with side `size`,
  // i.e. centre (xpos+size/2, ypos+size/2), radius size/2. Scaled by S for retina.
  function drawCircle(xpos, ypos, size) {
    const r = (size / 2) * S;
    const cxp = (xpos + size / 2) * S;
    const cyp = (ypos + size / 2) * S;
    ctx.beginPath();
    ctx.arc(cxp, cyp, r, 0, TWOPI);
    ctx.fill();
  }

  // One animation step (the C's whirlygig_draw): resolve modes, advance the
  // colour, optionally clear, then plot every whirly*line spot, then tick.
  function step() {
    // "change" mode: re-roll the x/y curve every CHANGE_TIME ticks. The C's
    // y-only branch uses %3 (modes 1..3) where the others use %4 (1..4).
    const xchange = (config.xmode === 'change');
    const ychange = (config.ymode === 'change');
    if (xchange && ychange) {
      if (currentTime - startTime > CHANGE_TIME) {
        startTime = currentTime;
        xmode = 1 + nrand(4);
        ymode = 1 + nrand(4);
      }
    } else if (xchange) {
      if (currentTime - startTime > CHANGE_TIME) {
        startTime = currentTime;
        xmode = 1 + nrand(4);
      }
    } else if (ychange) {
      if (currentTime - startTime > CHANGE_TIME) {
        startTime = currentTime;
        ymode = 1 + nrand(3);
      }
    }
    if (!xchange) xmode = resolveMode(config.xmode);
    if (!ychange) ymode = resolveMode(config.ymode);

    // Advance the base colour (the C increments then wraps at NCOLORS).
    if (++currentColor >= palette.length) currentColor = 0;

    // With no trail the C clears the (double-buffered) frame each step.
    if (!config.trail) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
    }

    for (let wcount = 0; wcount < whirlies; wcount++) {
      const colorOffset = (currentColor + colorModifier * wcount) % palette.length;
      // Each successive whirly is further along the clock, so they string out.
      let internalTime = 0;
      if (currentTime !== 0) {
        internalTime = currentTime + 10 * wcount + wcount * wcount;
      }

      const px = computeAxis(xmode, internalTime, true);
      const py = computeAxis(ymode, internalTime, false);

      ctx.fillStyle = palette[colorOffset];

      for (let lcount = 0; lcount < nlines; lcount++) {
        const arg = (internalTime * config.offset_period) / 90.0;
        const lineOffset = 20.0 * lcount * Math.sin(arg);
        const size = Math.trunc(15.0 + 5.0 * Math.sin(internalTime / 180.0));

        let xpos = Math.trunc(config.xoffset * lineOffset) + px;
        let ypos = Math.trunc(config.yoffset * lineOffset) + py;
        if (config.wrap) {
          xpos = preen(xpos, hw * 2);
          ypos = preen(ypos, hh * 2);
        }
        drawCircle(xpos, ypos, size);
      }
    }

    // Advance the global clock (the C wraps exactly at FULL_CYCLE).
    if (currentTime === FULL_CYCLE) currentTime = 1;
    else currentTime += config.speed;
  }

  // Seed all state (the C's whirlygig_init) and clear to black.
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // half_width/height in LOGICAL px (the C used window pixels; we scale by S
    // at draw time so the whole pattern fills the device-px canvas on retina).
    hw = Math.max(1, Math.floor(window.innerWidth / 2));
    hh = Math.max(1, Math.floor(window.innerHeight / 2));

    buildPalette();

    // Resolve the random "auto" counts (xml -1 -> our 0 = random).
    whirlies = config.whirlies > 0 ? Math.round(config.whirlies) : 1 + nrand(15);
    nlines = config.nlines > 0 ? Math.round(config.nlines) : 1 + nrand(5);
    whirlies = Math.max(1, whirlies);
    nlines = Math.max(1, nlines);

    colorModifier = config.color_modifier > 0 ? Math.round(config.color_modifier) : 1 + nrand(25);
    modifier = 3000.0 + Math.random() * 1500.0;

    // Random start so frame 1 already shows a developed chain (the C seeds
    // current_time from random() when start_time is -1).
    currentTime = nrand(FULL_CYCLE);
    startTime = 0;   // so the first "change" check fires immediately, like the C
    currentColor = 1 + nrand(palette.length);

    // Initial modes (the C's random()%lissajous_mode fallback); overridden each
    // step by either the fixed config mode or the "change" re-roll.
    xmode = nrand(7);
    ymode = nrand(7);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
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

  // rAF lag-accumulator paced by config.delay (us): one step() per delay,
  // banking leftover time so the speed is identical at any refresh rate, with a
  // catch-up cap so a backgrounded tab doesn't burst on refocus. See squiral.js.
  //
  // OVERHEAD: whirlygig_draw returns a 10000 us sleep floor, but the framework's
  // real per-frame cost is higher. Live whirlygig measured ~58 fps (Load ~42%,
  // delay-bound) across developed scenes, i.e. a ~17240 us period, so
  // OVERHEAD = 1e6/58 - 10000 = 7241 us. Adding it to the step delay makes the
  // chain crawl/zoom and the mode re-rolls fire at the original's pace while
  // config.delay still maps 1:1 to the stock 10000 floor. See framerate-calibration.
  const OVERHEAD = 7241;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is the stock 10000 us floor; add the measured framework
    // OVERHEAD, then convert to the rAF clock's milliseconds.
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
