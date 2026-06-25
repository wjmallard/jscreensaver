// kumppa.js — kumppa packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's kumppa.c (Teemu Suutari, 1998).
// https://www.jwz.org/xscreensaver/
//
// "Spiraling, spinning, and very, very fast splashes of color rush toward the
// screen." Each step the hack injects a little fresh color near the center,
// then spins + zooms the *entire framebuffer* slightly outward about the
// center. Repeated, that pulls every painted mark into a spiral streak racing
// off the edges, fed continuously by new color at the core.
//
// Canvas self-feedback (the load-bearing deviation):
//   The C builds a feedback graphics context and, via rotate()/make_rots(), an
//   integer pixel-shuffle that copies the window onto itself through a small
//   rotation + outward scale about (midx,midy) — an X11 trick canvas has no
//   equivalent for. We emulate it directly: keep a scratch canvas, copy the
//   current frame into it, then redraw it back onto the main canvas through
//   ctx.translate(cx,cy)/rotate(theta)/scale(z)/translate(-cx,-cy)+drawImage.
//   z > 1 zooms outward, theta rotates — the bilinear sampling of drawImage is
//   the smear. New blobs are then splatted on top. See kumppa.md.
//
// Two looks, from the C's `random` resource:
//   - cosilines ON  (default): 4 smooth Lissajous lines whose endpoints are
//     driven by a fixed cosinus[] table, cycling through the hue ramp.
//   - cosilines OFF: 8 random small colored squares splatted near the center.
// Either way a small black square is stamped dead-center each step (the C does
// this so the very center never saturates), then the framebuffer is spun.

export const title = 'kumppa';

export const info = {
  author: 'Teemu Suutari',
  description: 'Spiraling, spinning, and very, very fast splashes of color rush toward the screen.',
  year: 1998,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/kumppa.xml. The C exposes delay, speed
  // (labelled "Density" in the xml — it sets the per-step spin/zoom rate), and
  // random (the cosilines toggle). `ncolors` is added for parity with the other
  // ports; the C hardcodes a 32-entry blue->green->red->violet ramp.
  const config = {
    delay: 80000,      // µs between steps (calm, slow spin). NB: ~12 steps/sec, so the
                       // feedback motion is intentionally steppy at this default; for
                       // slow-BUT-smooth, lower `speed` instead and keep delay ~16000.
    speed: 0.16,       // per-step spin/zoom rate, 0.0001..0.2 (--speed / "Density")
                       // (bumped from 0.1 so the slower step rate keeps the same spin/sec)
    random: true,      // true = smooth cosi-lines, false = random splats (--random)
    ncolors: 32,       // size of the hue ramp the marks cycle through
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 80000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Density', type: 'range', min: 0.0001, max: 0.2, step: 0.0001, default: 0.16, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'random', label: 'Smooth lines', type: 'checkbox', default: true, live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 32, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  // The C's cosinus[8][6] table: per oscillator, three phase increments then
  // three amplitudes. Four (x,y) endpoint pairs are built from these eight
  // oscillators (a<<1 / (a<<1)+1), giving the smooth wandering Lissajous lines.
  const COSINUS = [
    [-0.07, 0.12, -0.06, 32, 25, 37],
    [0.08, -0.03, 0.05, 51, 46, 32],
    [0.12, 0.07, -0.13, 27, 45, 36],
    [0.05, -0.04, -0.07, 36, 27, 39],
    [-0.02, -0.07, 0.1, 21, 43, 42],
    [-0.11, 0.06, 0.02, 51, 25, 34],
    [0.04, -0.15, 0.02, 42, 32, 25],
    [-0.02, -0.04, -0.13, 34, 20, 15],
  ];

  let S = 1;               // devicePixelRatio
  let W, H;                // canvas size, device px
  let cx, cy;              // center, device px
  let colors;              // hue ramp, ncolors entries
  let scratch, sctx;       // scratch canvas for the self-feedback copy
  let pscale;              // mark line width / box size in device px (Retina-aware)

  // Per-oscillator accumulated phase (acosinus[8][3]) and the resulting line
  // endpoints (coords / ocoords hold this and last frame's, 8 ints = 4 points).
  let acos;                // Float32, 8*3
  let coords, ocoords;     // Int, 8 each
  let drawCount;           // color index walk, like st->draw_count

  // The C ramp is a 32-step blue->cyan->green->yellow->red->magenta->violet
  // loop. We rebuild it as a vivid HSL wheel of config.ncolors entries (the
  // same spectral order, just smoother and resizable). hue 240->...->300.
  function buildColors() {
    const n = Math.max(2, Math.round(config.ncolors));
    colors = new Array(n);
    for (let i = 0; i < n; i++) {
      // Start at blue (240) and sweep a full turn so the ramp wraps cleanly.
      const hue = (240 + (i * 360 / n)) % 360;
      colors[i] = `hsl(${hue.toFixed(1)}, 100%, 50%)`;
    }
  }

  // The feedback transform per step. The C parameterizes spin/zoom by `speed`
  // (rotsizeX = 2/speed+1: how many steps to sweep the rotation across the half
  // width). We map speed -> a small rotation `theta` and an outward zoom `z`
  // about the center. z is kept just above 1 so content marches outward and off
  // the edges (never collapsing inward to a black hole), but small enough that
  // a pixel is resampled from a nearby source region, so nothing blows out to
  // a flat white — the fresh center color is what keeps the core alive.
  function feedback() {
    const speed = Math.min(0.2, Math.max(0.0001, config.speed));
    // theta ~ speed radians/step (at speed 0.1 -> ~5.7 deg/step, a lively spin
    // that still reads as a spiral rather than a blur). z grows with speed so
    // faster = streaks rush out faster; +1 keeps it strictly expanding.
    const theta = speed * 0.6;
    const z = 1 + speed * 0.16;

    // Copy the current frame to the scratch buffer, then paint it back through
    // the rotate+scale-about-center transform. (drawImage can't read+write the
    // same canvas through a transform safely, hence the scratch copy.)
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(canvas, 0, 0);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(theta);
    ctx.scale(z, z);
    ctx.translate(-cx, -cy);
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }

  // cosilines ON: advance the eight oscillators, rebuild the four line
  // endpoints, and draw each line from its previous endpoint to the new one in
  // the next ramp color (matching the C's fgc[((a<<2)+draw_count)&31] walk).
  function drawCosiLines() {
    drawCount++;
    for (let a = 0; a < 8; a++) {
      let f = 0;
      for (let b = 0; b < 3; b++) {
        acos[a * 3 + b] += COSINUS[a][b];
        f += COSINUS[a][b + 3] * Math.sin(acos[a * 3 + b]);
      }
      coords[a] = f * S;   // scale the C's pixel amplitudes for device px
    }
    ctx.lineWidth = pscale;
    ctx.lineCap = 'round';
    for (let a = 0; a < 4; a++) {
      const idx = (((a << 2) + drawCount) % colors.length + colors.length) % colors.length;
      ctx.strokeStyle = colors[idx];
      ctx.beginPath();
      ctx.moveTo(cx + ocoords[a << 1], cy + ocoords[(a << 1) + 1]);
      ctx.lineTo(cx + coords[a << 1], cy + coords[(a << 1) + 1]);
      ctx.stroke();
      ocoords[a << 1] = coords[a << 1];
      ocoords[(a << 1) + 1] = coords[(a << 1) + 1];
    }
  }

  // cosilines OFF: splat 8 random small colored squares within +/-16px of the
  // center, mirroring the C's Satnum(32)-16+mid placement and fgc[Satnum(50)]
  // color pick (indices >=32 clamp to the background = black, so some splats
  // punch holes — we keep that by mapping the top of the range to black).
  function drawSplats() {
    const box = 2 * pscale;
    const reach = 16 * S;
    for (let e = 0; e < 8; e++) {
      const a = Math.floor(Math.random() * 50);
      const bx = cx - reach + Math.floor(Math.random() * (32 * S));
      const by = cy - reach + Math.floor(Math.random() * (32 * S));
      if (a >= 32) {
        ctx.fillStyle = '#000';   // the C's fgc[32] (background) when a clamps high
      } else {
        ctx.fillStyle = colors[a % colors.length];
      }
      ctx.fillRect(bx, by, box, box);
    }
  }

  // One step: paint fresh color at the center, stamp the central black square
  // (so the very core never bakes solid), then spin the whole framebuffer.
  function step() {
    if (config.random) {
      drawCosiLines();
    } else {
      drawSplats();
    }
    // The C stamps fgc[32] (background/black) as a 4*pscale square at center.
    const k = 4 * pscale;
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - 2 * pscale, cy - 2 * pscale, k, k);

    feedback();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    cx = W >> 1;
    cy = H >> 1;

    // The C bumps line width / box size on >2560px "Retina" displays; fold that
    // into the dpr scale so marks stay visible without dominating.
    pscale = Math.max(1, Math.round(S));
    if (W > 2560 || H > 2560) pscale *= 1.5;
    pscale = Math.round(pscale);

    scratch = document.createElement('canvas');
    scratch.width = W;
    scratch.height = H;
    sctx = scratch.getContext('2d');

    acos = new Float32Array(24);
    coords = new Int32Array(8);
    ocoords = new Int32Array(8);
    drawCount = 0;

    buildColors();
  }

  // reinit clears to black (palette / look may have changed) and re-seeds.
  function reinit() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    init();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
    reinit,   // re-seed + clear, keeping the current config
    config,
    params,
  };
}
