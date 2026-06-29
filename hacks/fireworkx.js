// fireworkx.js -- fireworkx packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's fireworkx.c (Rony B Chandran, "Fireworkx 2.2",
// 1999-2013). https://www.jwz.org/xscreensaver/
//
// Pyrotechnic explosions. A small fixed number of "fireshells" each burst into
// hundreds of "firepix" sparks that drift outward, slow under air drag, droop
// under gravity, bounce/die at the floor, and slowly cycle hue/brightness. The
// signature look is a GLOWING AFTERIMAGE: the C keeps a per-pixel intensity
// buffer (`palaka1`) that is blurred-and-halved every frame, so each spark
// leaves a soft smoke/bloom trail that fades over a handful of frames. A
// brighter copy of that buffer is shown (`palaka2`), with an additive colored
// "light flash" (`chromo_2x2_light`) that lights up the scene when a shell
// detonates and fades away.
//
// Rendering: this is the DENSE per-pixel / accumulating-field path. One Uint8
// RGBA glow buffer persists across frames: sparks are written into it, then the
// C's 3x3 weighted blur runs IN PLACE (centre x8 + 8 neighbours, /16) -- reading
// the partially-written buffer so energy dissipates and the field stays calm
// (a pure double-buffered blur would conserve energy and wash out; this matches
// the C exactly). The same pass writes a 2x-brighter clamped copy to the display
// buffer, then an additive colored flash is composited at half-resolution (2x2
// blocks, like the C). To stay affordable on retina the whole simulation runs at
// a capped LOGICAL resolution in an offscreen canvas the main canvas upscales
// (see metaballs/strange).
//
// See [[pyro]] for the sparse-vector fireworks twin, [[metaballs]] for the
// offscreen-logical-resolution upscale idiom, and [[squiral]] for the module
// skeleton.

export const title = 'fireworkx';

export const info = {
  author: 'Rony B Chandran',
  description: 'Exploding fireworks.\n\nSee also the "Eruption", "XFlame" and "Pyro" screen savers.',
  year: 2004,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/fireworkx.xml so the config box maps
  // 1:1 to the original (delay/maxlife/flash/shoot). delay is microseconds (xml
  // units). The C's SHELLCOUNT(4)/PIXCOUNT(500) are FIXED compile-time constants
  // -- not xml resources -- so they stay constants here (below), not sliders.
  const config = {
    delay: 10000,    // µs between frames (--delay)
    maxlife: 32,     // shell life dial 0..100 -> "Activity" (--maxlife)
    flash: true,     // additive colored light flash (--no-flash)
    shoot: false,    // launch shells upward from the floor (--shoot)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'maxlife', label: 'Activity', type: 'range', min: 0, max: 100, step: 1, default: 32, lowLabel: 'dense', highLabel: 'sparse', live: true },
    { key: 'flash', label: 'Light flash', type: 'checkbox', default: true, live: true },
    { key: 'shoot', label: 'Shells upward', type: 'checkbox', default: false, live: true },
  ];

  // ---- constants (verbatim from the C) -----------------------------------
  const SHELLCOUNT = 4;              // fireshells (C: FIXED, for SSE lane packing)
  const PIXCOUNT = 500;              // sparks per shell (C: PIXCOUNT)
  const SHELL_LIFE_RATIO = 6;        // life += life/6 floor
  const POWDER = 5.0;                // initial spark speed scale
  const FTWEAK = 12;                 // sub-steps per displayed frame
  const FLASH_ZOOM = 0.8;            // light-map falloff numerator
  const G_ACCELERATION = 0.001;      // gravity (per sub-step)

  // chromo flash strength. 1.0 = the C's EXACT additive flash, no dimming: a
  // fresh detonation floods a wide radius with colour, then fades by flash_fade
  // -- the C's signature "colored light flash" (the 2012 rewrite's headline
  // feature). The "Light flash" toggle removes it entirely. Named only so the
  // strength stays discoverable; the faithful value is 1.0.
  const FLASH_GAIN = 1.0;

  // Cap the per-frame pixel work: run the whole sim at <= RES_BUDGET logical
  // pixels and let the canvas upscale (the glow is blurry, so this is invisible
  // beyond a touch of softness). The budget keeps the internal width near the
  // C's nominal 1024 on full-screen windows, which (with the raw C spark speeds)
  // reproduces the C's spark DENSITY -- and hence its overall brightness. The C
  // itself defaults to `.lowrez: true` ("Too slow on macOS Retina screens
  // otherwise"), so a reduced internal resolution is faithful to the original.
  const RES_BUDGET = 600000;

  let S = 1;                  // devicePixelRatio
  let iw, ih;                 // internal (logical, capped) resolution, even
  let bw, bh;                 // half-res block grid for the light flash

  // The C's single in-place glow accumulation buffer (`palaka1`) + the display
  // buffer (`palaka2` == the offscreen ImageData).
  let pcur;                  // Uint8 RGBA glow accumulation (persists, blurred in place)
  let p2;                    // Uint8ClampedArray, display (== imageData.data)
  let imageData, scratch, sctx;   // offscreen canvas at internal res
  let lightMap;              // Float32Array(bw*bh*SHELLCOUNT): per-shell falloff
  let fr, fg, fb;            // per-shell flash colours, gathered each chromo pass

  let shells;                // fireshell objects
  let maxShellLife;          // derived from config.maxlife each step (live)
  let flashFade;             // derived from maxShellLife each step

  // ---- random helpers (the C's rnd/frand) --------------------------------
  function rnd(x) { return Math.floor(Math.random() * x); }   // [0, x)
  function frand(x) { return Math.random() * x; }             // [0, x)
  function clampInt(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // hsv (h 0-359, s/v 0-1) -> r,g,b 0-255. Stand-in for the C's hsv_to_rgb.
  function fsRollRgb(fs) {
    let h = fs.h % 360; if (h < 0) h += 360;
    let s = fs.s < 0 ? 0 : fs.s > 1 ? 1 : fs.s;
    let v = fs.v < 0 ? 0 : fs.v > 1 ? 1 : fs.v;
    let r, g, b;
    if (s === 0) {
      r = g = b = v;
    } else {
      const hh = h / 60;
      const i = Math.floor(hh);
      const f = hh - i;
      const p = v * (1 - s);
      const q = v * (1 - s * f);
      const t = v * (1 - s * (1 - f));
      switch (i) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        default: r = v; g = p; b = q; break;
      }
    }
    // C: hsv_to_rgb returns 16-bit channels (trunc(C*65535)); fs_roll_rgb then
    // keeps the high byte (>> 8). Reproduce that exact quantization (not round).
    fs.r = ((r * 65535) | 0) >> 8;
    fs.g = ((g * 65535) | 0) >> 8;
    fs.b = ((b * 65535) | 0) >> 8;
  }

  // mix_colors: fresh random vivid hue + a bright flash charge.
  function mixColors(fs) {
    fs.h = rnd(360);
    fs.s = frand(0.4) + 0.6;
    fs.v = 1.0;
    fsRollRgb(fs);
    const flash = rnd(444) + 111;   // "Mega Jouls !"
    fs.flashR = fs.r * flash;
    fs.flashG = fs.g * flash;
    fs.flashB = fs.b * flash;
  }

  function rotateHue(fs, dh) {
    fs.h = fs.h + dh;
    fs.s = fs.s - 0.001;
    fsRollRgb(fs);
  }

  function waveValue(fs) {
    fs.vshiftPhase = fs.vshiftPhase + 0.008;
    fs.v = Math.abs(Math.sin(fs.vshiftPhase));
    fsRollRgb(fs);
  }

  // render_light_map: each shell's inverse-distance falloff, sampled at the
  // half-res block grid and interleaved by shell (stride SHELLCOUNT), so the
  // chromo pass can read all shells at one block index. Recomputed on recycle.
  function renderLightMap(fs) {
    let v = fs.seqNumber;
    const cx = fs.cx, cy = fs.cy;
    for (let by = 0; by < bh; by++) {
      const dy = cy - by * 2;
      const dy2 = dy * dy;
      for (let bx = 0; bx < bw; bx++) {
        const dx = cx - bx * 2;
        let f = Math.sqrt(dx * dx + dy2) + 4.0;
        f = FLASH_ZOOM / f;
        f += Math.pow(f, 0.1) * frand(0.0001);   // dither
        lightMap[v] = f;
        v += SHELLCOUNT;
      }
    }
  }

  // recycle: re-arm a shell at (x, y) with a fresh burst of sparks.
  function recycle(fs, x, y) {
    const shoot = config.shoot;
    fs.mortarFired = shoot ? 1 : 0;
    fs.explodeY = y;
    fs.cx = x;
    fs.cy = shoot ? ih : y;
    fs.life = rnd(maxShellLife) + Math.floor(maxShellLife / SHELL_LIFE_RATIO);
    if (rnd(25) === 0) fs.life += maxShellLife * 5;   // occasional long shell
    fs.airDrag = 1.0 - rnd(200) / (10000.0 + fs.life);
    fs.bicolor = rnd(5) === 0 ? 120 : 0;     // two-tone burst
    fs.flies = rnd(10) === 0 ? 1 : 0;        // jittery "flies" motion
    fs.hshift = rnd(5) === 0 ? 1 : 0;        // hue drift
    fs.vshift = rnd(10) === 0 ? 1 : 0;       // brightness pulse
    fs.vshiftPhase = Math.PI / 2.0;

    const pixlife = rnd(fs.life) + Math.floor(fs.life / 10) + 1;
    const px = fs.px, py = fs.py, pxv = fs.pxv, pyv = fs.pyv, pburn = fs.pburn;
    for (let n = 0; n < PIXCOUNT; n++) {
      pburn[n] = rnd(pixlife) + 32;
      // POWDER-scaled spherical-ish initial velocity (raw C constants, no dpr/res
      // scaling -- keeping the C's pixel speeds keeps the C's spark density).
      const xv0 = frand(2.0) * POWDER - POWDER;
      const yv0 = Math.sqrt(POWDER * POWDER - xv0 * xv0) * (frand(2.0) - 1.0);
      pxv[n] = xv0;
      pyv[n] = yv0;
      px[n] = x;
      py[n] = y;
    }
    mixColors(fs);
    renderLightMap(fs);
  }

  // explode: advance one shell one sub-step. Returns remaining life (0 = dead,
  // recycle it). Writes spark pixels into the current glow buffer (pcur).
  function explode(fs) {
    const w = iw, h = ih;

    if (fs.mortarFired) {
      fs.cy--;
      if (fs.cy === fs.explodeY) {
        fs.mortarFired = 0;
        mixColors(fs);
        renderLightMap(fs);
      } else {
        // Rising mortar trail: a bright grey streak climbing to the burst.
        fs.flashR = fs.flashG = fs.flashB = 50 + (fs.cy - fs.explodeY) * 10;
        let tx = fs.cx + rnd(5) - 2;
        if (tx < 0) tx = 0; else if (tx >= w) tx = w - 1;
        const ty = fs.cy;
        if (ty >= 0 && ty < h) {
          const idx = (ty * w + tx) * 4;
          pcur[idx] = rnd(32) + 128;
          pcur[idx + 1] = rnd(32) + 128;
          pcur[idx + 2] = rnd(32) + 128;
        }
        return 1;   // still climbing; sparks frozen
      }
    }

    if (((fs.bicolor + 1) % 50) === 0) rotateHue(fs, 180);
    if (fs.bicolor > 0) fs.bicolor--;
    if (fs.hshift) rotateHue(fs, rnd(8));
    if (fs.vshift) waveValue(fs);
    if (fs.flashR > 1.0) fs.flashR *= flashFade;
    if (fs.flashG > 1.0) fs.flashG *= flashFade;
    if (fs.flashB > 1.0) fs.flashB *= flashFade;

    const airDrag = fs.airDrag;
    const r = fs.r, g = fs.g, b = fs.b;
    const flies = fs.flies;
    const px = fs.px, py = fs.py, pxv = fs.pxv, pyv = fs.pyv, pburn = fs.pburn;

    for (let n = 0; n < PIXCOUNT; n++) {
      if (!pburn[n]) continue;
      pburn[n]--;
      if (flies) {
        pxv[n] = pxv[n] * airDrag + frand(0.1) - 0.05;
        px[n] += pxv[n];
        pyv[n] = pyv[n] * airDrag + frand(0.1) - 0.05 + G_ACCELERATION;
        py[n] += pyv[n];
      } else {
        pxv[n] = pxv[n] * airDrag + frand(0.01) - 0.005;
        px[n] += pxv[n];
        pyv[n] = pyv[n] * airDrag + frand(0.005) - 0.0025 + G_ACCELERATION;
        py[n] += pyv[n];
      }
      if (py[n] > h) {
        if (rnd(5) === 3) { pyv[n] *= -0.24; py[n] = h; }   // bounce
        else { pburn[n] = 0; }                              // muddy ground
      }
      const xx = px[n], yy = py[n];
      if (xx < w && xx > 0 && yy < h && yy > 0) {
        const idx = ((yy | 0) * w + (xx | 0)) * 4;
        pcur[idx] = r;
        pcur[idx + 1] = g;
        pcur[idx + 2] = b;
      }
    }
    fs.life -= 1;
    return fs.life;
  }

  // glow_blur: the C's 3x3 weighted blur (centre x8 + 8 neighbours, /16) applied
  // IN PLACE to the glow buffer pcur -- left/up neighbours are already-blurred
  // (smaller) values this pass, so energy dissipates and the field decays toward
  // black instead of conserving and washing out. The same pass writes a
  // 2x-brighter clamped copy into the display buffer p2. Interior is unrolled
  // per channel; the 1px border is sampled with clamped neighbours.
  function blurEdge(x, y) {
    const xm = x > 0 ? x - 1 : 0, xp = x < iw - 1 ? x + 1 : iw - 1;
    const ym = y > 0 ? y - 1 : 0, yp = y < ih - 1 ? y + 1 : ih - 1;
    const c = (y * iw + x) * 4;
    const l = (y * iw + xm) * 4, rr = (y * iw + xp) * 4;
    const u = (ym * iw + x) * 4, ul = (ym * iw + xm) * 4, ur = (ym * iw + xp) * 4;
    const d = (yp * iw + x) * 4, dl = (yp * iw + xm) * 4, dr = (yp * iw + xp) * 4;
    for (let ch = 0; ch < 3; ch++) {
      const q = 8 * pcur[c + ch] + pcur[l + ch] + pcur[rr + ch]
        + pcur[u + ch] + pcur[ul + ch] + pcur[ur + ch]
        + pcur[d + ch] + pcur[dl + ch] + pcur[dr + ch];
      pcur[c + ch] = q >> 4;
      p2[c + ch] = q > 2047 ? 255 : q >> 3;
    }
  }

  function glowBlur() {
    const rowBytes = iw * 4;
    for (let y = 1; y < ih - 1; y++) {
      let c = (y * iw + 1) * 4;
      for (let x = 1; x < iw - 1; x++, c += 4) {
        const u = c - rowBytes, d = c + rowBytes;
        let q = 8 * pcur[c] + pcur[c - 4] + pcur[c + 4]
          + pcur[u - 4] + pcur[u] + pcur[u + 4]
          + pcur[d - 4] + pcur[d] + pcur[d + 4];
        pcur[c] = q >> 4; p2[c] = q > 2047 ? 255 : q >> 3;
        q = 8 * pcur[c + 1] + pcur[c - 3] + pcur[c + 5]
          + pcur[u - 3] + pcur[u + 1] + pcur[u + 5]
          + pcur[d - 3] + pcur[d + 1] + pcur[d + 5];
        pcur[c + 1] = q >> 4; p2[c + 1] = q > 2047 ? 255 : q >> 3;
        q = 8 * pcur[c + 2] + pcur[c - 2] + pcur[c + 6]
          + pcur[u - 2] + pcur[u + 2] + pcur[u + 6]
          + pcur[d - 2] + pcur[d + 2] + pcur[d + 6];
        pcur[c + 2] = q >> 4; p2[c + 2] = q > 2047 ? 255 : q >> 3;
      }
    }
    for (let x = 0; x < iw; x++) { blurEdge(x, 0); blurEdge(x, ih - 1); }
    for (let y = 1; y < ih - 1; y++) { blurEdge(0, y); blurEdge(iw - 1, y); }
  }

  // chromo_2x2_light: additive colored ambient flash. Per half-res block, sum
  // each shell's (decaying) flash colour times its falloff, then saturating-add
  // to the 2x2 pixels of the display buffer (Uint8ClampedArray clamps for us).
  function chromo() {
    for (let s = 0; s < SHELLCOUNT; s++) {
      fr[s] = shells[s].flashR * FLASH_GAIN;
      fg[s] = shells[s].flashG * FLASH_GAIN;
      fb[s] = shells[s].flashB * FLASH_GAIN;
    }
    let lm = 0;
    for (let by = 0; by < bh; by++) {
      const rowTop = (2 * by) * iw * 4;
      const rowBot = rowTop + iw * 4;
      for (let bx = 0; bx < bw; bx++) {
        let r = 0, g = 0, b = 0;
        for (let s = 0; s < SHELLCOUNT; s++) {
          const v = lightMap[lm + s];
          r += fr[s] * v; g += fg[s] * v; b += fb[s] * v;
        }
        lm += SHELLCOUNT;
        const ri = r | 0, gi = g | 0, bi = b | 0;
        if (ri === 0 && gi === 0 && bi === 0) continue;
        const x0 = 2 * bx;
        let i = rowTop + x0 * 4;
        p2[i] = p2[i] + ri; p2[i + 1] = p2[i + 1] + gi; p2[i + 2] = p2[i + 2] + bi;
        i += 4;
        p2[i] = p2[i] + ri; p2[i + 1] = p2[i + 1] + gi; p2[i + 2] = p2[i + 2] + bi;
        i = rowBot + x0 * 4;
        p2[i] = p2[i] + ri; p2[i + 1] = p2[i + 1] + gi; p2[i + 2] = p2[i + 2] + bi;
        i += 4;
        p2[i] = p2[i] + ri; p2[i + 1] = p2[i + 1] + gi; p2[i + 2] = p2[i + 2] + bi;
      }
    }
  }

  // One displayed frame (fireworkx_draw): FTWEAK physics sub-steps over every
  // shell (recycling any that die), then blur + flash + blit.
  function step() {
    // Live "Activity": longer life -> sparser; matches the C's pow() mapping.
    // The C stores max_shell_life in an unsigned int, so truncate -- this keeps
    // every derived life (and the < 1000 flash_fade branch) integer, as in the C.
    const ml = Math.floor(Math.pow(10.0, (clampInt(Math.round(config.maxlife), 0, 100) / 50.0) + 2.7));
    maxShellLife = ml;
    flashFade = ml < 1000 ? 0.998 : 0.995;

    for (let q = 0; q < FTWEAK; q++) {
      for (let s = 0; s < SHELLCOUNT; s++) {
        const fs = shells[s];
        if (explode(fs) <= 0) recycle(fs, rnd(iw), rnd(ih));
      }
    }

    glowBlur();
    if (config.flash) chromo();

    sctx.putImageData(imageData, 0, 0);
    ctx.drawImage(scratch, 0, 0, iw, ih, 0, 0, canvas.width, canvas.height);
  }

  function makeShell(n) {
    return {
      seqNumber: n,
      cx: 0, cy: 0,
      life: 0, explodeY: 0, mortarFired: 0,
      bicolor: 0, flies: 0, hshift: 0, vshift: 0,
      airDrag: 1.0, vshiftPhase: 0,
      flashR: 0, flashG: 0, flashB: 0,
      h: 0, s: 1, v: 1, r: 0, g: 0, b: 0,
      px: new Float32Array(PIXCOUNT),
      py: new Float32Array(PIXCOUNT),
      pxv: new Float32Array(PIXCOUNT),
      pyv: new Float32Array(PIXCOUNT),
      pburn: new Uint32Array(PIXCOUNT),
    };
  }

  // Internal resolution = canvas at logical (CSS) px, capped to RES_BUDGET and
  // rounded even (the 2x2 flash blocks need even dims). The main canvas upscales.
  function computeInternalSize() {
    const lw = Math.max(4, Math.round(canvas.width / S));
    const lh = Math.max(2, Math.round(canvas.height / S));
    let scale = 1;
    if (lw * lh > RES_BUDGET) scale = Math.sqrt(RES_BUDGET / (lw * lh));
    let w = Math.max(4, Math.round(lw * scale));
    let h = Math.max(2, Math.round(lh * scale));
    w -= w % 2;
    h -= h % 2;
    return [w, h];
  }

  function init() {
    S = window.devicePixelRatio || 1;

    const dims = computeInternalSize();
    iw = dims[0];
    ih = dims[1];
    bw = iw >> 1;
    bh = ih >> 1;

    pcur = new Uint8Array(iw * ih * 4);

    scratch = document.createElement('canvas');
    scratch.width = iw;
    scratch.height = ih;
    sctx = scratch.getContext('2d');
    imageData = sctx.createImageData(iw, ih);
    p2 = imageData.data;
    for (let i = 3; i < p2.length; i += 4) p2[i] = 255;   // opaque alpha

    lightMap = new Float32Array(bw * bh * SHELLCOUNT);
    fr = new Float32Array(SHELLCOUNT);
    fg = new Float32Array(SHELLCOUNT);
    fb = new Float32Array(SHELLCOUNT);

    const ml = Math.floor(Math.pow(10.0, (clampInt(Math.round(config.maxlife), 0, 100) / 50.0) + 2.7));
    maxShellLife = ml;
    flashFade = ml < 1000 ? 0.998 : 0.995;

    shells = new Array(SHELLCOUNT);
    for (let n = 0; n < SHELLCOUNT; n++) {
      shells[n] = makeShell(n);
      recycle(shells[n], rnd(iw), rnd(ih));
    }

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

  // rAF lag-accumulator paced by config.delay (microseconds). The per-step work
  // is heavy (12 sub-steps + a full per-pixel blur), so a low catch-up cap keeps
  // a backgrounded tab from firing a burst of blurs on refocus.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay fireworkx runs 38.2 fps, while the
  // port at the stock 10000 us ran ~100 fps (2.6x fast -- the 12 sub-steps +
  // full-buffer blur per frame make the framework overhead large here). 10000 +
  // 16178 = 26178 us -> 38 fps, matching the live binary. Each frame still runs
  // FTWEAK sub-steps, so this paces displayed frames, not the sub-step count.
  // A calibration, not a tuning knob (delay slider still maps 1:1 to xml).
  const OVERHEAD = 16178;
  const MAX_CATCHUP_STEPS = 3;
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
