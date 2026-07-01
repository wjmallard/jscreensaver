// shadebobs.js — shadebobs packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's shadebobs.c (Shane Smit, 1999).
// https://www.jwz.org/xscreensaver/
//
// A few little "bobs" zip around the screen along smoothly-turning Lissajous-ish
// paths. Each bob stamps a small SHADED dome kernel that ADDS (or, for the dark
// bobs, SUBTRACTS) intensity into a persistent accumulation buffer; that buffer
// holds a colour-ramp INDEX per pixel and is mapped through a black -> base ->
// white palette and blitted each frame. Half the bobs shade up toward white and
// half shade down toward black, so the picture stays in colour balance — "a
// light side, a dark side, and it keeps the world in balance". The result is
// oscillating oval patterns that look like vapor trails or neon tubes.
//
// Rendering: a dense per-pixel accumulation field, so this uses the BLIT path —
// a Uint32 ImageData written once and putImageData'd per frame — and to keep
// retina displays affordable the field is computed at LOGICAL (CSS-pixel)
// resolution and the canvas upscales it (see shadebobs.md, "Deviations"),
// exactly as metaballs.js does. See [[thornbird]] for the Uint32-over-ImageData
// accumulation idiom and [[metaballs]] for the small-offscreen + drawImage path.

export const title = 'shadebobs';

export const info = {
  author: 'Shane Smit',
  description: 'Oscillating oval patterns that look something like vapor trails or neon tubes.',
  year: 1999,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/shadebobs.xml so the config box maps
  // 1:1 to the original. delay is microseconds (xml units).
  const config = {
    delay: 10000,   // µs between frames (--delay)
    ncolors: 64,    // size of the black -> base -> white ramp (--ncolors)
    count: 4,       // number of bobs; alternating light/dark (--count)
    cycles: 10,     // duration: re-roll palette + reset every cycles*degrees frames (--cycles)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 20000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cycles', label: 'Duration', type: 'range', min: 0, max: 100, step: 1, default: 10, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'count', label: 'Count', type: 'range', min: 1, max: 20, step: 1, default: 4, lowLabel: 'one', highLabel: 'many', live: false },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  const BLACK = 0xFF000000;

  // delay is a sleep FLOOR in the C; the effective frame time also carries the
  // (heavy) per-frame stamp compute. OVERHEAD (us) is added to delay so our much
  // lighter port paces like the live binary. Live shadebobs (820x560, -fps) ran
  // 33.9 fps at Load 66.1% (sleep slice 10000us == stock delay, a clean reading):
  // OVERHEAD = round(1e6/33.9) - 10000 = 19499. See shadebobs.md "Timing" and
  // [[framerate-calibration]].
  const OVERHEAD = 19499;

  let S;                 // devicePixelRatio
  let gw, gh;            // accumulation field size, LOGICAL px (== canvas px / S)
  let imageData, pixels; // Uint32 buffer at field resolution
  let scratch, sctx;     // offscreen canvas holding the field, upscaled to main canvas

  let buf;               // Float32Array(gw*gh): per-pixel FRACTIONAL intensity (the accumulator; index = floor)
  let bobs;              // [{ posX, posY, angle, angleDelta, angleInc, map, dark }, ...]

  let sinTable, cosTable; // Float64Array(degreeCount): a unit circle over degreeCount steps
  let degreeCount;        // number of steps around the circle (the C's iDegreeCount)
  let diameter, radius;   // bob kernel side / radius, in field (logical) px
  let velocity;           // per-step travel distance, in field px

  let ncolors;            // captured colour count (2..255)
  let palette;            // Uint32Array(ncolors) packed ABGR: black -> base -> white
  let stepAccum;          // C-steps elapsed since the last reset (float; drives "Duration")

  // randInt(n) -> integer in [0, n). Used to pick the palette base colour as
  // three independent random channels, matching the C's random() % 0xFFFF per
  // channel (here at 8-bit-per-channel resolution).
  function randInt(n) {
    return Math.floor(Math.random() * n);
  }

  // Build the ncolors-entry palette exactly as the C's SetPalette: pick a random
  // base colour as three independent random channels (the C picks each channel
  // as random() % 0xFFFF, an independent uniform-random channel -- so the base is
  // often muted/dark/pastel, not a fully-saturated vivid hue), then index
  // 0..ncolors/2 ramps black -> base and ncolors/2..ncolors ramps base -> white.
  // Index 0 is forced to black so the background (zero-intensity pixels) stays
  // unlit. The base is re-rolled at every Duration reset, so the hue changes
  // across runs (faithful to the C -- NOT a vivid rainbow). Packed ABGR.
  function buildPalette() {
    const [br, bg, bb] = [randInt(256), randInt(256), randInt(256)];
    palette = new Uint32Array(ncolors);
    const half = ncolors / 2;
    for (let i = 0; i < ncolors; i++) {
      let r, g, b;
      if (i < ncolors / 2) {
        // Black -> base colour.
        r = (br / half) * i;
        g = (bg / half) * i;
        b = (bb / half) * i;
      } else {
        // Base colour -> white.
        r = ((0xff - br) / half) * (i - half) + br;
        g = ((0xff - bg) / half) * (i - half) + bg;
        b = ((0xff - bb) / half) * (i - half) + bb;
      }
      r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
      g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
      b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
      palette[i] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
    // Force index 0 to opaque black (the C clears the image to the black pixel).
    palette[0] = BLACK;
  }

  // Sin/cos lookup over a full circle of `degreeCount` steps (the C's
  // CreateTables): nRadian = (2*i/degreeCount) * PI.
  function createTables() {
    sinTable = new Float64Array(degreeCount);
    cosTable = new Float64Array(degreeCount);
    for (let i = 0; i < degreeCount; i++) {
      const rad = ((2 * i) / degreeCount) * Math.PI;
      sinTable[i] = Math.sin(rad);
      cosTable[i] = Math.cos(rad);
    }
  }

  // The precomputed shaded dome (the C's anDeltaMap): a small kernel that is
  // ~9 at the centre and falls smoothly to 0 at the rim. Light bobs (dark=false)
  // get positive values (add intensity); dark bobs get the negation (subtract).
  // Built over [-radius, radius) into a diameter*diameter array; when diameter
  // is odd the last row/col stay 0 (a no-op pad), exactly like the C.
  function buildDeltaMap(dark) {
    const map = new Int8Array(diameter * diameter);
    for (let h = -radius; h < radius; h++) {
      for (let w = -radius; w < radius; w++) {
        let d = 9 - ((Math.sqrt((w + 0.5) ** 2 + (h + 0.5) ** 2) / radius) * 8);
        if (d < 0) d = 0;
        if (dark) d = -d;
        map[(w + radius) * diameter + (h + radius)] = d;
      }
    }
    return map;
  }

  // Re-seed one bob's position + turning state (the C's ResetShadeBob). The
  // angle walks the sin/cos table; angleDelta drifts toward angleInc and, when
  // it crosses, a fresh delta/inc is rolled so the path keeps morphing forever.
  function resetBob(bob) {
    bob.posX = Math.floor(Math.random() * gw);
    bob.posY = Math.floor(Math.random() * gh);
    bob.angle = Math.floor(Math.random() * degreeCount);
    bob.angleDelta = Math.floor(Math.random() * degreeCount) - degreeCount / 2;
    bob.angleInc = bob.angleDelta / 50;
    if (bob.angleInc === 0) bob.angleInc = bob.angleDelta > 0 ? 0.0001 : -0.0001;
  }

  function initBob(bob, dark) {
    bob.map = buildDeltaMap(dark);
    resetBob(bob);
  }

  // Advance a bob along its path (the C's MoveShadeBob) by a fraction `f` of one
  // full step: turn by angleInc*f, re-roll the delta/inc when angleDelta crosses
  // angleInc, then move velocity*f along (sin, cos) of the current angle, wrapping
  // around the field. f == 1 reproduces the C exactly; fractional f is how the
  // time-based loop advances smoothly (see the frame loop / shadebobs.md).
  function moveBob(bob, f) {
    bob.angle += bob.angleInc * f;
    bob.angleDelta -= bob.angleInc * f;

    // Marginal 0.5 so the float wrap matches the C's integer table index.
    if (bob.angle + 0.5 >= degreeCount) bob.angle -= degreeCount;
    else if (bob.angle < -0.5) bob.angle += degreeCount;

    if ((bob.angleInc > 0 && bob.angleDelta < bob.angleInc) ||
        (bob.angleInc <= 0 && bob.angleDelta > bob.angleInc)) {
      bob.angleDelta = Math.floor(Math.random() * degreeCount) - degreeCount / 2;
      bob.angleInc = bob.angleDelta / 50;
      if (bob.angleInc === 0) bob.angleInc = bob.angleDelta > 0 ? 0.0001 : -0.0001;
    }

    // (int)nAngle truncates toward zero; guard the index into [0, degreeCount).
    let ai = bob.angle | 0;
    if (ai < 0) ai = 0;
    else if (ai >= degreeCount) ai = degreeCount - 1;

    bob.posX += sinTable[ai] * velocity * f;
    bob.posY += cosTable[ai] * velocity * f;

    // Wrap around the field (one subtract/add suffices, as in the C).
    if (bob.posX >= gw) bob.posX -= gw;
    else if (bob.posX < 0) bob.posX += gw;
    if (bob.posY >= gh) bob.posY -= gh;
    else if (bob.posY < 0) bob.posY += gh;
  }

  // Deposit one bob's shaded kernel into the accumulation buffer (the C's Execute
  // stamp), scaled by `f` -- the fraction of a full C step this sub-step covers.
  // For every kernel cell add f * the kernel value to that pixel's (fractional)
  // intensity, CLAMP to [0, ncolors-1], and write the mapped colour (floor of the
  // intensity -> palette index). Because we deposit every frame but each deposit
  // is scaled by f, the accumulated intensity per unit length matches the C's
  // (one full kernel per velocity of travel) -- so tubes don't over-saturate to
  // white. Wraps the stamp around the field edges like the C.
  function stamp(bob, f) {
    const px0 = bob.posX | 0;  // floor (posX >= 0): matches (int)(nPosX + iWidth)
    const py0 = bob.posY | 0;
    const maxIdx = ncolors - 1;
    const map = bob.map;

    for (let h = 0; h < diameter; h++) {
      let py = py0 + h;
      if (py >= gh) py -= gh;
      if (py < 0 || py >= gh) continue;  // safety (tiny fields where diameter ~ gh)
      const rowBase = py * gw;
      for (let w = 0; w < diameter; w++) {
        let px = px0 + w;
        if (px >= gw) px -= gw;
        if (px < 0 || px >= gw) continue;
        const pos = rowBase + px;
        let v = buf[pos] + map[w * diameter + h] * f;
        if (v >= ncolors) v = maxIdx;  // clamp on every add (no LUT overflow/wrap)
        else if (v < 0) v = 0;
        buf[pos] = v;
        pixels[pos] = palette[v | 0];
      }
    }
  }

  // Blit the field, then upscale it onto the (device-px) main canvas.
  function blit() {
    sctx.putImageData(imageData, 0, 0);
    if (S === 1) {
      ctx.drawImage(scratch, 0, 0);
    } else {
      ctx.drawImage(scratch, 0, 0, gw, gh, 0, 0, canvas.width, canvas.height);
    }
  }

  // Advance the simulation by `f` C-steps-worth of time, then blit. Every
  // cycles*degreeCount steps clear the buffer to black, reset the bobs, and roll
  // a fresh palette base colour (the C's draw_i >= cycles branch — what keeps the
  // field from saturating to a solid block). Each bob is advanced in sub-steps no
  // longer than the kernel radius so its trail stays a continuous tube and its
  // head lands on the exact (smooth) sub-frame position every frame.
  function step(f) {
    const resetPeriod = Math.max(0, Math.floor(config.cycles) * degreeCount);
    stepAccum += f;
    if (stepAccum >= resetPeriod) {
      stepAccum = 0;
      buf.fill(0);
      pixels.fill(BLACK);
      for (const bob of bobs) resetBob(bob);
      buildPalette();
    }

    const subs = Math.max(1, Math.ceil((velocity * f) / radius));
    const sf = f / subs;
    for (const bob of bobs) {
      for (let s = 0; s < subs; s++) { moveBob(bob, sf); stamp(bob, sf); }
    }
    blit();
  }

  function init() {
    S = window.devicePixelRatio || 1;

    // Field is the canvas at LOGICAL resolution (canvas px / dpr); the canvas
    // upscales it, keeping per-frame pixel work independent of dpr (see the .md).
    gw = Math.max(1, Math.round(canvas.width / S));
    gh = Math.max(1, Math.round(canvas.height / S));

    // Kernel + speed scale with the window, as in the C (min dimension based),
    // so it looks the same at any resolution, only smaller. Guard the tiny-field
    // corners (radius>=1 avoids a divide-by-zero; velocity>=1 keeps bobs moving).
    const minDim = Math.min(gw, gh);
    diameter = Math.max(2, Math.floor(minDim / 25));
    radius = Math.max(1, Math.floor(diameter / 2));
    velocity = Math.max(1, Math.floor(minDim / 150));

    // Automatic degree count (the C's degrees=0 default), clamped [90, 5400].
    degreeCount = Math.floor(gw / 6) + 400;
    if (degreeCount < 90) degreeCount = 90;
    else if (degreeCount > 5400) degreeCount = 5400;
    createTables();

    ncolors = Math.max(2, Math.min(255, Math.round(config.ncolors)));
    buildPalette();

    buf = new Float32Array(gw * gh);

    const count = Math.max(1, Math.min(64, Math.round(config.count)));
    bobs = new Array(count);
    for (let k = 0; k < count; k++) {
      // Alternate light (even) and dark (odd) bobs, exactly as the C does
      // (InitShadeBob with bDark = iShadeBob % 2) for colour balance.
      const dark = (k % 2) === 1;
      bobs[k] = { posX: 0, posY: 0, angle: 0, angleDelta: 0, angleInc: 0, map: null, dark };
      initBob(bobs[k], dark);
    }

    // Pixel buffer + offscreen canvas at field resolution.
    scratch = document.createElement('canvas');
    scratch.width = gw;
    scratch.height = gh;
    sctx = scratch.getContext('2d');
    imageData = sctx.createImageData(gw, gh);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    stepAccum = 0;

    // Clear the visible canvas to black so frame zero starts clean.
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

  // TIME-BASED motion (not a discrete one-step-per-tick loop). Each rAF frame
  // advances the simulation by `f` = elapsed / (delay + OVERHEAD) C-steps -- the
  // fraction of a step the wall-time represents -- so the bobs move a smooth EVEN
  // amount every displayed frame. The live binary runs ~33.9 fps, well under a
  // 60 Hz refresh, so a discrete loop would step the bob head only every other
  // frame and read as jerky; fractional stepping (with each deposit's intensity
  // scaled by f, see stamp) keeps the head gliding while matching the C's density.
  // f is capped so a backgrounded tab doesn't lurch a long way on refocus.
  const MAX_STEP_F = 4;
  let lastTime = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    let f = (now - lastTime) / ((config.delay + OVERHEAD) / 1000);
    lastTime = now;
    if (f > MAX_STEP_F) f = MAX_STEP_F;
    if (f > 0) step(f);

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (rebuilds the field, palette, kernels and
  // bobs because count/ncolors resize them; also clears the canvas).
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
