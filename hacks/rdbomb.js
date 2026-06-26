// rdbomb.js — rdbomb (RD-Bomb) packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's rdbomb.c (Scott Draves, 1997; framework by Jamie
// Zawinski). https://www.jwz.org/xscreensaver/
//
// A reaction-diffusion texture (the Gray-Scott / John E. Pearson "Complex
// Patterns in a Simple System" model). Two chemical fields r1 (substrate) and
// r2 (activator) sit on a toroidal grid; every step each cell diffuses toward
// its 4-neighbours and the two chemicals react (r1 is fed back toward its max
// while being consumed by r2; r2 grows where the r1*r2*r2 reaction term is high
// and decays elsewhere). The result is growing square-ish blobs that collide
// and "react in unpredictable ways". r1 is mapped through a cycling colourmap.
// Periodically ("epoch") the field is re-seeded — reset to equilibrium, a small
// random square blob of activator dropped in the centre ("bombed"), and the
// reaction/diffusion variant + palette re-rolled.
//
// Rendering: this is a dense per-pixel field, so it uses the BLIT path — the
// field is computed on a small offscreen canvas at a CAPPED logical resolution
// (NOT device pixels) into a Uint32 ImageData, then ctx.drawImage upscales it to
// the device-res canvas. The C itself computes a small grid (typ. 64..576 px)
// and tiles/scales it to fill the screen, so a capped grid is faithful as well
// as fast. See [[metaballs]] / [[marbling]] for the offscreen-field + upscale
// idiom and [[squiral]] for the shared skeleton.

export const title = 'rdbomb';

export const info = {
  author: 'Scott Draves',
  description: 'Reaction-diffusion: draws a grid of growing square-like shapes that, once they overtake each other, react in unpredictable ways.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/rdbomb.xml so the config box maps to the
  // original. delay is microseconds (xml units). `epoch` is counted in reaction
  // sub-steps, exactly like the C's frame counter (eased from the xml's 40000 to
  // a livelier 10000 so a re-bomb is seen in a minute or two — see rdbomb.md).
  // `reaction`/`diffusion`/`radius` use -1 = "Auto" (re-rolled each epoch), as
  // the C does. The xml's tile-size / wander knobs (width, height, size, speed)
  // are omitted — the field always fills the screen (see rdbomb.md).
  const config = {
    delay: 30000,     // µs between frames (--delay)
    epoch: 10000,     // reaction sub-steps before re-seeding the field (--epoch)
    radius: -1,       // seed-blob radius in grid cells; -1 = random (--radius)
    reaction: -1,     // reaction variant 0..2; -1 = random each epoch (--reaction)
    diffusion: -1,    // diffusion variant 0..2; -1 = random each epoch (--diffusion)
    ncolors: 255,     // size of the cycling colourmap (--ncolors)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 250000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'epoch', label: 'Epoch', type: 'range', min: 1000, max: 300000, step: 1000, default: 10000, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'radius', label: 'Seed radius', type: 'range', min: -1, max: 60, step: 1, default: -1, lowLabel: 'auto', highLabel: 'big', live: true },
    {
      key: 'reaction',
      label: 'Reaction',
      type: 'select',
      options: [
        { value: -1, label: 'Auto' },
        { value: 0, label: '0' },
        { value: 1, label: '1' },
        { value: 2, label: '2' },
      ],
      default: -1,
      live: false,
    },
    {
      key: 'diffusion',
      label: 'Diffusion',
      type: 'select',
      options: [
        { value: -1, label: 'Auto' },
        { value: 0, label: '0' },
        { value: 1, label: '1' },
        { value: 2, label: '2' },
      ],
      default: -1,
      live: false,
    },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 255, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  const BLACK = 0xFF000000;       // opaque black, little-endian 0xAABBGGRR
  const MX = (1 << 16) - 1;       // 65535 — the C's `mx`, the field's max value

  // Cap the internal grid so the per-frame field work is bounded on ANY display
  // (3 reaction sub-steps over this many cells per frame). The grid upscales to
  // the device-res canvas, so retina never multiplies the compute cost. The C's
  // own grid is small (typ. 64..576 px) and tiled, so this is faithful too.
  const MAX_CELLS = 65000;
  const SUBSTEPS = 3;             // reaction sub-steps per displayed frame (C: chunk=3)

  let S;                          // devicePixelRatio
  let gw, gh;                     // interior grid size (logical px, capped)
  let w2;                         // padded row stride (gw + 2)
  let a1, a2;                     // current (read) chemical fields, padded, Uint16
  let b1, b2;                     // next (write) chemical fields, padded, Uint16
  let frame;                      // reaction-step counter (drives the epoch re-bomb)
  let reaction, diffusion;        // active variants (re-rolled each epoch when Auto)

  let scratch, sctx;              // offscreen grid canvas, upscaled to the main canvas
  let imageData, pixels;          // Uint32 view over the grid-sized ImageData
  let ncolors;                    // captured colour count (2..255)
  let palette;                    // Uint32Array(ncolors) cycling colourmap

  // The C's `R` macro: a 30-bit non-negative random int.
  function R() {
    return (Math.random() * 0x40000000) | 0;
  }

  // HSL (h in degrees, s/l in [0,1]) packed into a little-endian RGBA uint.
  function hslToUint(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs(hp % 2 - 1));
    let rr = 0, gg = 0, bb = 0;
    if (hp < 1)      { rr = c; gg = x; }
    else if (hp < 2) { rr = x; gg = c; }
    else if (hp < 3) { gg = c; bb = x; }
    else if (hp < 4) { gg = x; bb = c; }
    else if (hp < 5) { rr = x; bb = c; }
    else             { rr = c; bb = x; }
    const m = l - c / 2;
    const r = Math.round((rr + m) * 255);
    const g = Math.round((gg + m) * 255);
    const b = Math.round((bb + m) * 255);
    return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }

  // The C calls make_smooth_colormap each epoch (a muted random gradient). Per
  // the project's house style we use a vivid smooth rainbow instead, re-rolled
  // with a random hue offset and direction each epoch so the texture changes
  // colour every time it re-bombs.
  function buildPalette() {
    palette = new Uint32Array(ncolors);
    const off = Math.random() * 360;
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (let i = 0; i < ncolors; i++) {
      palette[i] = hslToUint(off + dir * (i * 360 / ncolors), 1, 0.5);
    }
  }

  // Re-seed the field (the C's epoch branch in pixack_frame): reset both fields
  // to equilibrium, re-roll the palette, choose the reaction/diffusion variants
  // and seed radius (-1 => random, like the C), then drop a small random square
  // blob of activator (r2) in the centre.
  function rebomb() {
    a1.fill(65500);   // r1 substrate equilibrium
    a2.fill(11);      // r2 activator equilibrium

    buildPalette();

    reaction = config.reaction;
    if (reaction < 0 || reaction > 2) reaction = R() & 1;          // auto: 0 or 1 only

    diffusion = config.diffusion;
    if (diffusion < 0 || diffusion > 2) {
      diffusion = (R() % 5) ? ((R() % 3) ? 0 : 1) : 2;            // auto: ~0/1, sometimes 2
    }
    if (reaction === 2 && diffusion === 2) reaction = diffusion = 0;

    const maxr = Math.max(1, Math.min((gw >> 1) - 2, (gh >> 1) - 2));
    let radius = config.radius;
    if (radius < 0) radius = 1 + ((R() % 10) ? (R() % 5) : (R() % maxr));
    if (radius > maxr) radius = maxr;
    if (radius < 0) radius = 0;

    const s = w2 * (gh >> 1) + (gw >> 1);   // centre cell index in the padded buffer
    for (let i = -radius; i <= radius; i++) {
      for (let j = -radius; j <= radius; j++) {
        a2[s + i + j * w2] = MX - (R() & 63);
      }
    }
  }

  // Toroidal wrap: copy the interior edges into the 1-cell border so the
  // Laplacian reads neighbours that wrap around (the C does this every step).
  function edgeWrap() {
    for (let i = 0; i <= gw + 1; i++) {
      a1[i] = a1[i + w2 * gh];                 // top border  <- last interior row
      a2[i] = a2[i + w2 * gh];
      a1[i + w2 * (gh + 1)] = a1[i + w2];      // bottom border <- first interior row
      a2[i + w2 * (gh + 1)] = a2[i + w2];
    }
    for (let i = 0; i <= gh + 1; i++) {
      a1[w2 * i] = a1[gw + w2 * i];            // left border  <- last interior col
      a2[w2 * i] = a2[gw + w2 * i];
      a1[w2 * i + gw + 1] = a1[w2 * i + 1];    // right border <- first interior col
      a2[w2 * i + gw + 1] = a2[w2 * i + 1];
    }
  }

  // One reaction-diffusion sub-step (the C's pixack_frame inner loops): read the
  // previous field from a1/a2, write the new field into b1/b2 (double buffering
  // so the Laplacian reads a coherent previous state), then swap. The arithmetic
  // is the C's verbatim — every intermediate stays under 2^31, so the bit-shifts
  // match the C exactly (see rdbomb.md, "Correctness self-review"). On the final
  // sub-step of a frame, also map r1 through the palette into the pixel buffer.
  function update(writePixels) {
    for (let i = 0; i < gh; i++) {
      const base = w2 * (i + 1) + 1;          // index of (interior row i, col 0)
      const prow = i * gw;
      for (let j = 0; j < gw; j++) {
        const idx = base + j;
        const c1 = a1[idx], r1r = a1[idx + 1], l1 = a1[idx - 1], d1 = a1[idx + w2], u1 = a1[idx - w2];
        const c2 = a2[idx], r2r = a2[idx + 1], l2 = a2[idx - 1], d2 = a2[idx + w2], u2 = a2[idx - w2];

        let r1 = 0, r2 = 0;
        switch (diffusion) {
          case 0:
            r1 = ((c1 + r1r + l1 + d1 + u1) / 5) | 0;
            r2 = (((c2 << 3) + r2r + l2 + d2 + u2) / 12) | 0;
            break;
          case 1:
            r1 = (r1r + l1 + d1 + u1) >> 2;
            r2 = ((c2 << 2) + r2r + l2 + d2 + u2) >> 3;
            break;
          case 2:
            r1 = ((c1 << 1) + (r1r << 1) + (l1 << 1) + d1 + u1) >> 3;
            r2 = ((c2 << 2) + r2r + l2 + d2 + u2) >> 3;
            break;
        }

        // Pearson reaction term ~ r1*r2*r2; the C shifts r1 right by 1 first to
        // keep the products inside signed 32-bit, so we do the same.
        const uvv = ((((r1 >> 1) * r2) >> 16) * r2) >> 15;
        switch (reaction) {
          case 0:
            r1 += 4 * (((28 * (MX - r1)) >> 10) - uvv);
            r2 += 4 * (uvv - ((80 * r2) >> 10));
            break;
          case 1:
            r1 += 3 * (((27 * (MX - r1)) >> 10) - uvv);
            r2 += 3 * (uvv - ((80 * r2) >> 10));
            break;
          case 2:
            r1 += 2 * (((28 * (MX - r1)) >> 10) - uvv);
            r2 += 3 * (uvv - ((80 * r2) >> 10));
            break;
        }

        if (r1 > MX) r1 = MX; else if (r1 < 0) r1 = 0;
        if (r2 > MX) r2 = MX; else if (r2 < 0) r2 = 0;
        b1[idx] = r1;
        b2[idx] = r2;

        if (writePixels) pixels[prow + j] = palette[(r1 >> 8) % ncolors];
      }
    }

    let t = a1; a1 = b1; b1 = t;
    t = a2; a2 = b2; b2 = t;
  }

  // One displayed frame: SUBSTEPS reaction sub-steps (re-bombing at each epoch
  // boundary, exactly as the C tests frame % epoch == 0 at the top of each
  // sub-step), then blit the small field upscaled onto the device-res canvas.
  function step() {
    const epoch = Math.max(1, Math.round(config.epoch));
    for (let sub = 0; sub < SUBSTEPS; sub++) {
      if (frame % epoch === 0) rebomb();
      edgeWrap();
      update(sub === SUBSTEPS - 1);
      frame++;
    }
    sctx.putImageData(imageData, 0, 0);
    ctx.drawImage(scratch, 0, 0, gw, gh, 0, 0, canvas.width, canvas.height);
  }

  function init() {
    S = window.devicePixelRatio || 1;

    // Field grid at LOGICAL resolution (canvas px / dpr), then capped to
    // MAX_CELLS preserving aspect, so the per-frame work is bounded everywhere.
    let lw = Math.max(10, Math.round(canvas.width / S));
    let lh = Math.max(10, Math.round(canvas.height / S));
    if (lw * lh > MAX_CELLS) {
      const f = Math.sqrt((lw * lh) / MAX_CELLS);
      lw = Math.max(10, Math.floor(lw / f));
      lh = Math.max(10, Math.floor(lh / f));
    }
    gw = lw;
    gh = lh;
    w2 = gw + 2;

    const npix = w2 * (gh + 2);
    a1 = new Uint16Array(npix);
    a2 = new Uint16Array(npix);
    b1 = new Uint16Array(npix);
    b2 = new Uint16Array(npix);

    ncolors = Math.max(2, Math.min(255, Math.round(config.ncolors)));

    scratch = document.createElement('canvas');
    scratch.width = gw;
    scratch.height = gh;
    sctx = scratch.getContext('2d');
    imageData = sctx.createImageData(gw, gh);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    // frame 0 -> the first sub-step of the first step() re-bombs (which fills the
    // fields + builds the palette), so the screen seeds itself on frame one.
    frame = 0;

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

  // Drive off requestAnimationFrame but keep the original pace: one step() per
  // config.delay, banking leftover time so the speed is the same at any refresh
  // rate. step() is heavy (3 sub-steps over the whole grid), so the catch-up cap
  // is low — a slow frame should fall behind, not stack up a burst.
  const MAX_CATCHUP_STEPS = 4;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frameLoop(now) {
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

    rafId = requestAnimationFrame(frameLoop);
  }

  // Rebuild after a non-live config change (reaction/diffusion/ncolors resize or
  // re-roll the field/palette). Clears to black and re-seeds via init(); frame=0
  // makes the next step() re-bomb with the new settings.
  function reinit() {
    init();
  }

  window.addEventListener('resize', resize);
  resize();
  rafId = requestAnimationFrame(frameLoop);

  return {
    stop() {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
    },
    pause() { cancelAnimationFrame(rafId); rafId = 0; },
    resume() { if (!rafId) { lastTime = 0; rafId = requestAnimationFrame(frameLoop); } },
    reinit,   // fresh field + palette with the current config
    config,
    params,
  };
}
