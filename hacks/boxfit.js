// boxfit.js — boxfit packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's boxfit.c (Jamie Zawinski, 2005).
// https://www.jwz.org/xscreensaver/ — inspired by levitated.net's "Box Fitting".
//
// Packs the screen with growing squares (or circles): each box spawns at a
// random empty spot as a zero-size seed and grows outward every step until it
// touches a wall or a neighbour (leaving a spacing+border margin), then freezes.
// New seeds keep topping the live count up to `boxCount`, so the gaps between
// the big early boxes fill with progressively smaller ones — a gradient-coloured
// mosaic. When no new seed fits, the whole field shrinks back to nothing and a
// fresh round begins (maybe flipping squares<->circles and the gradient axis).
//
// Rendering: filled rects / circles + optional outline — canvas VECTOR ops
// (fillRect / arc + stroke), not blit. Each frame clears and redraws every box;
// the canvas is double-buffered, so this full repaint is flicker-free and
// replaces the C's incremental draw-only-CHANGED + erase-around bookkeeping.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'boxfit';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Packs the screen with growing squares or circles which grow until they touch, then stop.',
  year: 2005,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/boxfit.xml. (`colors` isn't in the stock
  // boxfit UI — it hardcodes 64 — but we expose it for parity with the others.)
  const config = {
    delay: 20000,     // \u00B5s between steps (--delay; xml/stock 20000)
    mode: 'random',   // 'random' | 'squares' | 'circles' (--mode)
    boxCount: 50,     // number of boxes growing at once (--count)
    growBy: 1,        // px each side grows per step (--growby)
    spacing: 1,       // gap left between boxes (--spacing)
    border: 1,        // outline thickness; 0 = none (--border)
    ncolors: 64,      // smooth-colormap size (--colors)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'mode', label: 'Shape', type: 'select', default: 'random', live: false, options: [
        { value: 'random', label: 'boxes or circles' },
        { value: 'squares', label: 'boxes only' },
        { value: 'circles', label: 'circles only' },
      ] },
    { key: 'boxCount', label: 'Boxes', type: 'range', min: 1, max: 1000, step: 1, default: 50, lowLabel: 'few', highLabel: 'many', live: true },
    { key: 'growBy', label: 'Grow by', type: 'range', min: 1, max: 10, step: 1, default: 1, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'spacing', label: 'Spacing', type: 'range', min: 1, max: 10, step: 1, default: 1, live: true },
    { key: 'border', label: 'Border', type: 'range', min: 0, max: 10, step: 1, default: 1, live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  // Phase pauses (the C's magic return values), in ms.
  const PAUSE_AFTER_FILL = 2000;    // hold the full field before it shrinks
  const PAUSE_AFTER_ROUND = 1000;   // blank gap before the next round grows
  const MAX_BOXES = 65535;          // the C's hard cap (then fade out)

  // Per-step pace: the live *delay (stock 20000 us) is a sleep FLOOR; each
  // grow/shrink step also costs O(n^2) collision compute, so the effective
  // pace is delay + overhead. The -fps overlay read ~35 fps at Load ~28%
  // (delay-bound) across several rounds => frame ~= 28400 us = 20000 floor +
  // ~8400 compute, so a faithful step waits (delay + OVERHEAD)/1000 ms. (The
  // phase pauses above are the C's own literal 2 s / 1 s returns, unchanged.)
  const OVERHEAD = 8400;
  const stepMs = () => (config.delay + OVERHEAD) / 1000;

  let S = 1;                 // devicePixelRatio
  let W, H;                  // canvas size, device px
  let boxes;                 // { x, y, w, h, ci, alive }
  let growing;               // true = packing, false = shrinking the field away
  let colorHoriz;            // gradient runs across (true) or down (false)
  let circles;               // this round draws circles vs squares
  let palette;               // ncolors smooth-colormap CSS strings (make_smooth_colormap)
  let dirty;                 // a step changed something; redraw this frame

  // inc / spacing / border scaled to device px so the look holds on retina.
  const inc = () => Math.max(1, Math.round(config.growBy * S));
  const spacing = () => Math.round(config.spacing * S);
  const border = () => Math.round(config.border * S);
  // Collision/placement padding: one grow-step plus the gap we want to keep.
  const pad = () => inc() + spacing() + border();

  // Palette: boxfit.c is a native screenhack that colours its boxes from
  // make_smooth_colormap (2-5 random HSV anchors interpolated into a loop —
  // muted/pastel, NOT a full-hue rainbow). Re-rolled each round, so plain
  // Math.random in makeSmoothColormapRGB reproduces the same distribution.
  function buildPalette() {
    const n = Math.max(1, Math.round(config.ncolors));
    const cm = makeSmoothColormapRGB(n);
    palette = cm.map(([r, g, b]) => `rgb(${r},${g},${b})`);
  }

  // Begin a fresh round: clear to black, pick this round's shape + gradient axis.
  function resetBoxes() {
    boxes = [];
    growing = true;
    colorHoriz = Math.random() < 0.5;
    circles = config.mode === 'circles' ? true
            : config.mode === 'squares' ? false
            : Math.random() < 0.5;
    buildPalette();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    dirty = true;
  }

  function boxesOverlap(a, b, p) {
    const maxleft  = Math.max(a.x - p, b.x);
    const maxtop   = Math.max(a.y - p, b.y);
    const minright = Math.min(a.x + a.w + p + p - 1, b.x + b.w);
    const minbot   = Math.min(a.y + a.h + p + p - 1, b.y + b.h);
    return maxtop < minbot && maxleft < minright;
  }

  function circlesOverlap(a, b, p) {
    const ar = a.w / 2, br = b.w / 2;
    const dx = (b.x + br) - (a.x + ar);
    const dy = (b.y + br) - (a.y + ar);
    const r = ar + br + p;
    return dx * dx + dy * dy < r * r;
  }

  // True if box `a` (padded by `p`) hits a wall or any other box.
  function collides(a, p) {
    if (a.x - p < 0 || a.y - p < 0 ||
        a.x + a.w + p + p >= W || a.y + a.h + p + p >= H) return true;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b !== a && (circles ? circlesOverlap(a, b, p) : boxesOverlap(a, b, p))) return true;
    }
    return false;
  }

  // One growth step: grow each live box, freeze any that would collide, then top
  // the live count back up to boxCount. Returns ms to wait before the next step.
  function grow() {
    const p = pad();
    const step = inc();
    let live = 0;

    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (!a.alive) continue;
      if (collides(a, p)) { a.alive = false; continue; }
      live++;
      a.x -= step; a.y -= step;
      a.w += step + step; a.h += step + step;
    }

    const target = Math.max(1, Math.round(config.boxCount));
    const rangeX = Math.max(1, W - p);
    const rangeY = Math.max(1, H - p);
    while (live < target) {
      const a = { x: 0, y: 0, w: 0, h: 0, ci: 0, alive: false };
      for (let tries = 0; tries < 100; tries++) {
        a.x = p + Math.floor(Math.random() * rangeX);
        a.y = p + Math.floor(Math.random() * rangeY);
        a.w = 0; a.h = 0;
        if (!collides(a, p)) { a.alive = true; live++; break; }
      }
      if (!a.alive || boxes.length >= MAX_BOXES) {   // no room left -> fade out
        growing = false;
        dirty = true;
        return PAUSE_AFTER_FILL;
      }
      const t = colorHoriz ? a.x / W : a.y / H;       // gradient by spawn position
      a.ci = Math.min(palette.length - 1, Math.floor(t * palette.length));
      boxes.push(a);
    }

    dirty = true;
    return stepMs();
  }

  // Shrink every box back toward nothing; start a fresh round once all are gone.
  function shrink() {
    const step = inc();
    let remaining = 0;
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.w <= 0 || a.h <= 0) continue;
      a.x += step; a.y += step;
      a.w -= step + step; a.h -= step + step;
      if (a.w < 0) a.w = 0;
      if (a.h < 0) a.h = 0;
      if (a.w > 0 && a.h > 0) remaining++;
    }
    dirty = true;
    if (remaining === 0) { resetBoxes(); return PAUSE_AFTER_ROUND; }
    return stepMs();
  }

  function step() {
    return growing ? grow() : shrink();
  }

  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const bw = border();
    ctx.lineWidth = bw;
    const n = palette.length;
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (a.w <= 0 || a.h <= 0) continue;
      ctx.fillStyle = palette[a.ci];
      if (circles) {
        const r = a.w / 2;
        ctx.beginPath();
        ctx.arc(a.x + r, a.y + r, r, 0, Math.PI * 2);
        ctx.fill();
        if (bw > 0) { ctx.strokeStyle = palette[(a.ci + (n >> 1)) % n]; ctx.stroke(); }
      } else {
        ctx.fillRect(a.x, a.y, a.w, a.h);
        if (bw > 0) {
          ctx.strokeStyle = palette[(a.ci + (n >> 1)) % n];
          ctx.strokeRect(a.x, a.y, a.w, a.h);
        }
      }
    }
    dirty = false;
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    nextDelay = 0;
    resetBoxes();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Variable-delay loop: step() returns the ms to wait before the next step
  // (the delay+OVERHEAD step pace normally, or a longer pause at a phase
  // change), matching the
  // C's "return microseconds until next call". Redraw once per frame if a step
  // changed anything; idle (no redraw) through the between-phase pauses.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let acc = 0;
  let nextDelay = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    acc += now - lastTime;
    lastTime = now;
    if (acc > PAUSE_AFTER_FILL + 1000) acc = PAUSE_AFTER_FILL + 1000;   // bound catch-up

    let steps = 0;
    while (acc >= nextDelay && steps < MAX_CATCHUP_STEPS) {
      acc -= nextDelay;
      nextDelay = step();
      steps++;
    }

    if (dirty) draw();
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
    reinit() { nextDelay = 0; resetBoxes(); },   // fresh round with the current config
    config,
    params,
  };
}
