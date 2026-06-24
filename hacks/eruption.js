// eruption.js — eruption packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's eruption.c (W.P. van Paassen, 2002-2003; performance
// tweaks and click-for-explosion by Dave Odell, 2015; spherical-distribution
// burst borrowed from jwz's pyro). https://www.jwz.org/xscreensaver/
//
// A volcanic particle fountain. Every `cycles` frames a fresh eruption fires
// from a random point: a few hundred particles burst outward along a cached,
// slightly-whacked spherical velocity distribution, then fall under gravity and
// cool one heat-level per step until they go cold (index 0) and die. Particles
// bounce off the window edges (re-heating to full on each bounce). Each particle
// stamps a small plus-shape into a per-pixel HEAT buffer; that buffer is then run
// through a left-to-right / top-to-bottom convolution-blur with a cooling offset,
// which smears the heat down-and-right into the soft glowing fire that gives the
// hack its name. The heat value at each pixel indexes a black->blue->red->yellow
// ->white palette, so the fountain reads as molten sparks fading through embers.
//
// Rendering: dense per-pixel HEAT field (a Uint8Array at LOGICAL resolution,
// re-smeared and re-coloured every frame) -> the BLIT path. Heat indexes a packed
// Uint32 palette written into a persistent ImageData on an offscreen canvas, which
// is then drawImage-upscaled (smoothing OFF) to the device canvas -- honouring the
// C's ".lowrez: true" default (coarse fire on Retina, part of the look). This
// mirrors the C's XImage fast paths while avoiding hundreds of thousands of
// per-pixel canvas calls. See [[xflame]]/[[moire2]] for the same lowrez upscale
// idiom, [[thornbird]] for the Uint32-blit, and [[pyro]] for the cached
// spherical-burst velocity distribution.

export const title = 'eruption';

export const info = {
  author: 'W.P. van Paassen',
  description: 'Exploding fireworks.\n\nSee also the "Fireworkx", "XFlame" and "Pyro" screen savers.',
  year: 2003,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/eruption.xml so the config box maps 1:1
  // to the original. (The xml's "showfps" boolean is host chrome, not ported.)
  // delay defaults to the stock value; the loop adds a fixed OVERHEAD (see below).
  const config = {
    delay: 10000,      // µs/step (--delay; the xml stock value)
    ncolors: 256,      // size of the heat palette (--ncolors)
    nparticles: 300,   // particles per eruption (--particles)
    cooloff: 2,        // convolution cooling offset, pre-shift (--cooloff)
    heat: 256,         // caps the usable heat levels (--heat)
    gravity: 1,        // downward pull added to ydir each step (--gravity)
    cycles: 80,        // frames a single eruption lasts (--cycles), "Duration"
  };

  // Ranges/defaults/labels transcribed from hacks/config/eruption.xml.
  // live: true  -> the loop reads config every step, so it applies instantly.
  // live: false -> the value sizes the palette/particle pool/heat buffer, so a
  //                change re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 16, max: 256, step: 1, default: 256, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'nparticles', label: 'Number of particles', type: 'range', min: 100, max: 2000, step: 10, default: 300, lowLabel: 'little', highLabel: 'many', live: false },
    { key: 'cooloff', label: 'Cooling factor', type: 'range', min: 0, max: 10, step: 1, default: 2, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'heat', label: 'Heat', type: 'range', min: 64, max: 256, step: 1, default: 256, lowLabel: 'pleasant', highLabel: 'inferno', live: false },
    { key: 'gravity', label: 'Gravity', type: 'range', min: -5, max: 5, step: 1, default: 1, lowLabel: 'negative', highLabel: 'positive', live: true },
    { key: 'cycles', label: 'Duration', type: 'range', min: 10, max: 3000, step: 1, default: 80, lowLabel: 'short', highLabel: 'long', live: true },
  ];

  // Mirror the C's "slightly whacked" explosion constants.
  const PI_2000 = 6284;   // size of the sin/cos velocity caches (~2000*PI)
  const SPREAD = 15;      // half-width of the spawn box, in *logical* px
  const X_PAD = 1;        // heat-buffer padding (lets the stamp run off-edge)
  const Y_PAD = 1;

  const BLACK = 0xFF000000;

  let S = 1;              // devicePixelRatio
  let W, H;               // heat-field size, LOGICAL px (the C's lowrez window)
  let off, offCtx;        // offscreen canvas at WxH, upscaled to the device canvas
  let imageData, pixels;  // persistent Uint32 blit buffer over `off` (ABGR)
  let fire;               // Uint8Array heat field, (W + 2*X_PAD) x (H + 2*Y_PAD)
  let firePitch;          // W + 2*X_PAD (row stride of `fire`)
  let palette;            // Uint32Array(iColorCount) packed-ABGR heat gradient
  let iColorCount;        // usable heat levels (>= a particle's start index + 1)

  let particles;          // flat pool of PARTICLE-like objects (size nparticles)
  let nParticleCount;     // == particles.length, captured at init
  let sinCache, cosCache; // Int32Array(PI_2000) whacked spherical velocities
  let xdelta, ydelta;     // velocity scale derived from the window size
  let decay;              // cooloff << 3 (the convolution offset)
  let drawI;              // eruption frame counter; < 0 forces a fresh eruption

  // A particle stores integer position + velocity (the C uses `short`) and a
  // heat colour index that counts down to 0 (cold/dead).
  function makeParticle() {
    return {
      xpos: 0, ypos: 0,    // position, logical px
      xdir: 0, ydir: 0,    // velocity, logical px/step
      colorindex: 0,       // current heat (0 = dead), counts down each step
      dead: 1,
    };
  }

  // cache() in the C: build the whacked spherical burst velocities once per run.
  // Each index holds a velocity vector along angle i/1000 rad, scaled by a
  // randomised radius dA (a sin of a random angle plus a small asin term that
  // fattens the distribution toward a sphere). cos is forced negative (upward),
  // sin is horizontal. Scaled by ydelta/xdelta (and dpr via xdelta/ydelta).
  function buildCaches() {
    sinCache = new Int32Array(PI_2000);
    cosCache = new Int32Array(PI_2000);
    for (let i = 0; i < PI_2000; i++) {
      let dA = Math.sin((Math.floor(Math.random() * (PI_2000 / 2))) / 1000.0);
      dA += Math.asin(Math.random()) / (Math.PI / 2) * 0.1;
      cosCache[i] = -Math.abs(Math.trunc(Math.cos(i / 1000.0) * dA * ydelta));
      sinCache[i] = Math.trunc(Math.sin(i / 1000.0) * dA * xdelta);
    }
  }

  // init_particle(): spawn at (xcenter,ycenter) +/- SPREAD with a cached burst
  // velocity, fully heated (colorindex = iColorCount - 1).
  function initParticle(p, xcenter, ycenter) {
    const v = Math.floor(Math.random() * PI_2000);
    p.xpos = xcenter - SPREAD + Math.floor(Math.random() * (SPREAD * 2));
    p.ypos = ycenter - SPREAD + Math.floor(Math.random() * (SPREAD * 2));
    p.xdir = sinCache[v];
    p.ydir = cosCache[v];
    p.colorindex = iColorCount - 1;
    p.dead = 0;
  }

  // Fire every particle from a new centre (new_eruption), resetting drawI so the
  // main loop counts a fresh `cycles` window before the next eruption.
  function newEruption(xcenter, ycenter) {
    for (let i = 0; i < nParticleCount; i++) {
      initParticle(particles[i], xcenter, ycenter);
    }
    drawI = 0;
  }

  function randomEruption() {
    newEruption(
      Math.floor(Math.random() * W),
      Math.floor(Math.random() * H),
    );
  }

  // Build the heat palette (SetPalette): index 0 = black (dead), ramping
  // black->blue->red->yellow->white as heat rises. The base channel step is
  // 65535/iColorCount; we pack straight into ABGR (no X colormap allocation).
  function buildPalette() {
    let n = Math.max(16, Math.min(256, Math.round(config.ncolors)));
    iColorCount = n;
    palette = new Uint32Array(n);

    const base = Math.floor(65535 / n);   // Color.red/green/blue in the C
    for (let i = 0; i < n; i++) {
      let r, g, b;
      if (i < n >> 3) {
        // black to blue
        r = 0;
        g = 0;
        b = base * (i << 1);
      } else if (i < n >> 2) {
        // blue to red
        const t = i - (n >> 3);
        r = base * (t << 3);
        g = 0;
        b = 16383 - base * (t << 1);
      } else if (i < (n >> 2) + (n >> 3)) {
        // red to yellow
        const t = (i - (n >> 2)) << 3;
        r = 65535;
        g = base * t;
        b = 0;
      } else if (i < n >> 1) {
        // yellow to white
        const t = (i - ((n >> 2) + (n >> 3))) << 3;
        r = 65535;
        g = 65535;
        b = base * t;
      } else {
        // white
        r = g = b = 65535;
      }
      // 16-bit channels (clamped) -> 8-bit, packed little-endian 0xAABBGGRR.
      const r8 = clamp8(r >> 8);
      const g8 = clamp8(g >> 8);
      const b8 = clamp8(b >> 8);
      palette[i] = ((0xff << 24) | (b8 << 16) | (g8 << 8) | r8) >>> 0;
    }

    // The "heat" knob caps how many palette levels a particle can use: a lower
    // heat starts particles cooler, so the fountain never reaches white.
    const heat = Math.max(64, Math.min(256, Math.round(config.heat)));
    if (heat < iColorCount) iColorCount = heat;
  }

  function clamp8(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  // One simulation + render step == one frame of the C's Execute().
  function step() {
    const gravity = clampGravity(config.gravity);

    // --- move particles ---------------------------------------------------
    for (let i = 0; i < nParticleCount; i++) {
      const p = particles[i];
      if (p.dead) continue;

      p.xpos += p.xdir;
      p.ypos += p.ydir;

      // cold particle dies (skip the rest, like the C's `continue`).
      if (p.colorindex === 0) {
        p.dead = 1;
        continue;
      }

      // Bounce off the side walls, re-heating to full on impact.
      if (p.xpos < 1) {
        p.xpos = 1;
        p.xdir = -p.xdir - 4;
        p.colorindex = iColorCount;
      } else if (p.xpos >= W - 2) {
        p.xpos = W - 2;
        if (p.xpos < 1) p.xpos = 1;
        p.xdir = -p.xdir + 4;
        p.colorindex = iColorCount;
      }

      // Bounce off the top/bottom; the floor bounce is damped (>>2) + jitter.
      if (p.ypos < 1) {
        p.ypos = 1;
        p.ydir = -p.ydir;
        p.colorindex = iColorCount;
      } else if (p.ypos >= H - 3) {
        p.ypos = H - 3;
        if (p.ypos < 1) p.ypos = 1;
        p.ydir = (-p.ydir >> 2) - (Math.random() < 0.5 ? 0 : 1);
        p.colorindex = iColorCount;
      }

      // gravity, then cool off one heat level.
      p.ydir += gravity;
      p.colorindex--;
    }

    // --- stamp particles into the heat buffer -----------------------------
    // Each live particle paints a 5-pixel plus (centre + up/down/left/right).
    for (let i = 0; i < nParticleCount; i++) {
      const p = particles[i];
      if (p.dead || p.ypos < -Y_PAD + 1 || p.ypos >= H + Y_PAD - 1) continue;

      const center = (p.ypos - -Y_PAD) * firePitch + (p.xpos + X_PAD);
      const color = p.colorindex;
      fire[center] = color;
      fire[center - 1] = color;
      if (p.ypos < H + Y_PAD - 2) fire[center + firePitch] = color;
      if (p.ypos >= -Y_PAD + 2) fire[center - firePitch] = color;
      fire[center + 1] = color;
    }

    // --- create the fire effect: convolution-blur smear -------------------
    // Per-pixel 8-neighbour box (no centre) minus `decay`, applied in place
    // left-to-right then top-to-bottom, which smears heat down-and-right. The
    // running t0/t1/t2 hold the column sums of the three rows being convolved.
    decay = clampCooloff(config.cooloff) << 3;

    let line0 = X_PAD;                 // index of fire[ -Y_PAD+1 ][ -X_PAD+? ]
    let line1 = line0 + firePitch;
    let line2 = line1 + firePitch;

    const j0 = -X_PAD + 1;
    const j1 = W + X_PAD;

    for (let i = -Y_PAD + 1; i < H + Y_PAD - 1; i++) {
      let t0 = fire[line0 + (j0 - 1)] + fire[line1 + (j0 - 1)] + fire[line2 + (j0 - 1)];
      let t1 = fire[line0 + j0] + fire[line1 + j0] + fire[line2 + j0];

      for (let j = j0 + 1; j !== j1; j++) {
        const t2 = fire[line0 + j] + fire[line1 + j] + fire[line2 + j];
        const pxIdx = line1 + j - 1;
        t1 -= fire[pxIdx];
        let temp = t0 + t1 + t2 - decay;
        temp = temp >= 0 ? temp >> 3 : 0;
        fire[pxIdx] = temp;
        t0 = t1 + temp;
        t1 = t2;
      }

      // Blit this row (when it maps onto the visible screen) via the palette.
      if (i >= 0 && i < H) {
        const out = i * W;
        const src = line1;              // fire[ i ][ X_PAD + j ] for j in 0..W
        for (let j = 0; j < W; j++) {
          pixels[out + j] = palette[fire[src + j]];
        }
      }

      line0 += firePitch;
      line1 += firePitch;
      line2 += firePitch;
    }

    // Blit the logical-resolution fire onto the offscreen canvas, then upscale it
    // to the device canvas with smoothing OFF (nearest-neighbour) -- the crisp,
    // coarse look the C gets from ".lowrez: true" on Retina.
    offCtx.putImageData(imageData, 0, 0);
    ctx.imageSmoothingEnabled = false;
    if (S === 1) ctx.drawImage(off, 0, 0);
    else ctx.drawImage(off, 0, 0, W, H, 0, 0, canvas.width, canvas.height);
  }

  // Clamp helpers matching the C's resource ranges (live params, re-read/step).
  function clampGravity(g) {
    g = Math.round(g);
    return g < -5 ? -5 : g > 5 ? 5 : g;
  }
  function clampCooloff(c) {
    c = Math.round(c);
    return c < 0 ? 0 : c > 10 ? 10 : c;
  }

  function init() {
    S = window.devicePixelRatio || 1;

    // The heat field runs at LOGICAL resolution (device px / dpr); the offscreen
    // canvas is then upscaled to the device canvas (smoothing off). This honours
    // the C's ".lowrez: true" default -- the original renders the fire coarse on
    // Retina, and the chunky pixels are part of the look. Particle count and the
    // burst velocity scale are therefore in logical px, matching the live binary.
    W = Math.max(1, Math.round(canvas.width / S));
    H = Math.max(1, Math.round(canvas.height / S));

    off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    offCtx = off.getContext('2d');
    imageData = offCtx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    firePitch = W + X_PAD * 2;
    fire = new Uint8Array((H + Y_PAD * 2) * firePitch);

    const n = Math.max(100, Math.min(2000, Math.round(config.nparticles)));
    nParticleCount = n;
    particles = new Array(n);
    for (let i = 0; i < n; i++) particles[i] = makeParticle();

    // Derive the burst velocity scale from the window size (triangular-number
    // summation in the C). ydelta grows until the running triangular sum clears
    // half the screen height; xdelta until it clears an eighth of the width.
    // These run in LOGICAL px (the field resolution), exactly as the C computes
    // them from its lowrez window, so a burst rises to the same apparent height
    // and covers the same screen fraction as the live binary.
    ydelta = 0;
    let sum = 0;
    while (sum < (H >> 1) - SPREAD) {
      ydelta++;
      sum += ydelta;
    }
    xdelta = 0;
    sum = 0;
    while (sum < (W >> 3)) {
      xdelta++;
      sum += xdelta;
    }

    decay = clampCooloff(config.cooloff) << 3;

    buildPalette();    // sets iColorCount (needed by buildCaches/initParticle)
    buildCaches();     // ydelta/xdelta are set, so burst velocities scale right

    drawI = -1;        // force a fresh eruption on the first frame
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
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // eruption's live `-fps` overlay was UNMEASURABLE (the full-frame fire obscured
  // it), so this is set to ~10000 us by analogy with the other dense ImageData
  // fire hacks; 10000 + 10000 = 20000 us -> ~50 steps/sec. NEEDS A VISUAL CHECK
  // against the live binary. A calibration, not a tuning knob (the delay slider
  // still maps 1:1 to the xml resource).
  const OVERHEAD = 10000;   // FLAG: unmeasured (fire hid the -fps overlay) -- verify visually
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;   // xml units are µs; rAF is ms
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      // eruption_draw: every `cycles` frames, kick off a new random eruption.
      if (drawI < 0 || drawI++ >= clampCycles(config.cycles)) {
        randomEruption();
      }
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  function clampCycles(c) {
    c = Math.round(c);
    return c < 1 ? 1 : c;
  }

  // Re-seed with the current config (resizes the palette/pool/heat buffer).
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
    reinit,   // re-seed with the current config
    config,   // host renders the config box from these
    params,
  };
}
