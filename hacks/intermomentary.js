// intermomentary.js — intermomentary packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's intermomentary.c (Mike Kershaw / "dragorn", 2004;
// xscreensaver port machinery by Jamie Zawinski), itself a direct port of
// j.tarbell's "InterMomentary" (complexification.net, 2004) — a REAS
// collaboration with Robert Hodgin and William Ngan for the Whitney's ARTPORT.
// https://www.jwz.org/xscreensaver/
//
// Sister hack to interaggregate: same author family, same circle-intersection
// (radical-line) math. A field of ~85 slowly-drifting discs whose radii start
// near 1px and creep up to some random size. Two things are drawn each frame
// into a single-channel brightness buffer that is wiped every frame (so this is
// the INSTANTANEOUS view, not a lifelong aggregate):
//   1. the momentary crossing points where two disc outlines intersect, laid
//      down bright (alpha 0.75); and
//   2. a swarm of "pixel riders" — points that orbit each disc's perimeter at a
//      jittering angular speed, tracing the outline faintly. When a rider passes
//      over a spot that already holds an intersection's brightness, it flares
//      into a 5x5 glowing orb. So the orbs only light where a perimeter point
//      happens to ride across a live intersection — blinking dots interacting
//      circularly.
// The whole brightness buffer is then mapped through a black->yellow ramp.
//
// Rendering: the C keeps an off-screen unsigned-char alpha map and alpha-blends
// individual pixels into it (read-blend-write), then XCopyAreas it to the
// window — exactly the BLIT path. So we mirror it with a persistent Float32
// brightness buffer (blended per pixel), cleared each frame, and a Uint32
// ImageData we colour-map and putImageData once per frame. See [[interaggregate]]
// for the intersection math and [[binaryring]] for the per-pixel-blend BLIT
// idiom this follows.

import { makeColorRampRGB } from './colormap.js';

export const title = 'intermomentary';

export const info = {
  author: 'Casey Reas, William Ngan, Robert Hodgin, and Jamie Zawinski',
  description: 'Blinking dots interact with each other circularly.\n\nA surface is filled with a hundred medium to small sized circles. Each circle has a different size and direction, but moves at the same slow rate. Displays the instantaneous intersections of the circles as well as the aggregate intersections of the circles.\n\nThe circles begin with a radius of 1 pixel and slowly increase to some arbitrary size. Circles are drawn with small moving points along the perimeter. The intersections are rendered as glowing orbs. Glowing orbs are rendered only when a perimeter point moves past the intersection point.',
  year: 2004,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/intermomentary.xml so the config box
  // maps 1:1 to the original. The xml only exposes draw-delay and num-discs as
  // sliders; maxRiders/maxRadius come from the C defaults (*maxRiders 40,
  // *maxRadius 100) and are surfaced here for parity with the other ports.
  const config = {
    delay: 30000,     // microseconds between frames (--draw-delay)
    numDiscs: 85,     // number of drifting discs (--num-discs)
    maxRadius: 100,   // ceiling on a disc's destination radius (--max-radius)
    maxRiders: 40,    // ceiling on perimeter riders per disc (--max-riders)
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes the disc field / rider arrays, so a change
  //                re-seeds the field via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'numDiscs', label: 'Number of discs', type: 'range', min: 11, max: 400, step: 1, default: 85, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'maxRadius', label: 'Disc radius (max)', type: 'range', min: 31, max: 300, step: 1, default: 100, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'maxRiders', label: 'Perimeter dots (max)', type: 'range', min: 11, max: 120, step: 1, default: 40, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  const TAU = Math.PI * 2;

  // frand(m) -> uniform double in [0, m), matching the C's frand().
  const frand = (m) => Math.random() * m;

  let S = 1;              // devicePixelRatio (the C's pscale lives in here)
  let W, H;              // canvas size, device px
  let discs;             // array of Disc objects
  let alpha;             // Float32 brightness buffer, W*H, single channel 0..255
  let imageData, pixels; // Uint32 ImageData we colour-map into once per frame
  let ramp;              // 256 packed-ABGR values: brightness -> black..yellow

  // Build the black -> yellow brightness ramp via the exact C call in
  // intermomentary_init: make_color_ramp(bg -> fg, closed_p=False) with bg=black
  // (h0=0 s0=0 v0=0) and fg=yellow (h1=60 s1=1 v1=1). HSV-interpolated, so the
  // midtones are amber/gold (index 128 -> [127,95,63]), NOT a flat rgb(v,v,0)
  // lemon ramp. Deterministic (no RNG); built once per init like the C, and
  // identical on every rebuild. index = brightness 0..255.
  function buildRamp() {
    ramp = new Uint32Array(256);
    const cmap = makeColorRampRGB(0, 0, 0, 60, 1, 1, 256, false);
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = cmap[i];
      // 0xAABBGGRR (little-endian ImageData layout): a=255.
      ramp[i] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
  }

  // Synthesis of the C's make_disc + PxRider::PxRider. `r` is the destination
  // radius, already S-scaled (devicePixelRatio); the disc starts at frand(r)/3
  // and creeps up to it. numr riders are allocated (capped at maxRiders), each
  // at a random perimeter angle. The C derives numr from the UNSCALED radius
  // (its r is unscaled), so divide S back out here -- otherwise retina (S>1)
  // roughly doubles the perimeter-dot count. Radius/velocity stay S-scaled; only
  // the COUNT must not.
  function makeDisc(id, x, y, vx, vy, r) {
    const maxrider = Math.max(1, Math.round(config.maxRiders));
    let numr = Math.floor(frand(r / S) / 2.62);
    if (numr > maxrider) numr = maxrider;

    const riders = new Array(numr);
    for (let ix = 0; ix < numr; ix++) {
      riders[ix] = {
        t: frand(TAU),    // angle around the perimeter
        vt: 0.0,          // angular velocity
        mycharge: 0,      // decaying brightness when not over an intersection
      };
    }

    return {
      id,
      x,
      y,
      vx,
      vy,
      dr: r,              // destination radius
      r: frand(r) / 3,    // current radius (grows toward dr)
      riders,
    };
  }

  // Alpha-blend value `myc` (0..255) into the brightness buffer at (x,y) with
  // weight a, and return the resulting brightness (the C's trans_point). Out of
  // bounds is a no-op returning 0. We keep the buffer in float (the C truncates
  // to unsigned char each blend, which all but zeroes the faint rider points;
  // float preserves the subtle outline glow while the bright/threshold paths
  // behave identically). Noted in the .md.
  function transPoint(x1, y1, myc, a) {
    if (x1 >= 0 && x1 < W && y1 >= 0 && y1 < H) {
      const idx = y1 * W + x1;
      if (a >= 1.0) {
        alpha[idx] = myc;
        return myc;
      }
      const c = alpha[idx];
      const nc = c + (myc - c) * a;
      alpha[idx] = nc;
      return nc;
    }
    return 0;
  }

  // Add velocity to position and wrap the disc around the torus, accounting for
  // its radius so it slides fully off before reappearing (the C's move_disc).
  // The radius also creeps toward its destination by 0.1 logical px/frame.
  function moveDisc(d) {
    d.x += d.vx;
    d.y += d.vy;

    if (d.x + d.r < 0) d.x += W + d.r + d.r;
    if (d.x - d.r > W) d.x -= W + d.r + d.r;
    if (d.y + d.r < 0) d.y += H + d.r + d.r;
    if (d.y - d.r > H) d.y -= H + d.r + d.r;

    if (d.r < d.dr) d.r += 0.1 * S;
  }

  // A 5x5 cluster of blended points around (px,py), brightest at the centre
  // (the C's draw_glowpoint). px,py are integer device-pixel coords.
  function drawGlowpoint(px, py) {
    for (let i = -2; i < 3; i++) {
      for (let j = -2; j < 3; j++) {
        const a = 0.8 - i * i * 0.1 - j * j * 0.1;
        transPoint(px + i, py + j, 255, a);
      }
    }
  }

  // Move one perimeter rider and render it (the C's moverender_rider). The angle
  // drifts with a jittering, friction-braked angular velocity. At the resulting
  // perimeter point: if the buffer is already lit beyond a small threshold (a
  // live intersection sits here), flare into a glowing orb and recharge; else
  // decay the rider's own charge and lay a faint point.
  function moverenderRider(rid, x, y, r) {
    // add velocity to theta, wrapped to (-PI, PI]
    rid.t = ((rid.t + rid.vt + Math.PI) % TAU) - Math.PI;
    if (rid.t < -Math.PI) rid.t += TAU;   // JS % keeps the dividend's sign

    rid.vt += frand(0.002) - 0.001;

    // friction brakes
    if (Math.abs(rid.vt) > 0.02) rid.vt *= 0.9;

    const px = (x + r * Math.cos(rid.t)) | 0;
    const py = (y + r * Math.sin(rid.t)) | 0;

    if (px < 0 || px >= W || py < 0 || py >= H) return;

    const c = alpha[py * W + px];
    const cv = c / 255.0;

    // 40 is ~18% of 255; this threshold (~0.176 brightness) means "a bright
    // intersection point is already here this frame".
    if (cv > 0.0006921) {
      drawGlowpoint(px, py);
      rid.mycharge = 0.003845;          // max brightness seen in the original
    } else {
      rid.mycharge *= 0.98;
      transPoint(px, py, 255 * rid.mycharge, 0.5);
    }
  }

  // For one disc, draw the momentary intersection points with every higher-id
  // disc, then move+render its perimeter riders (the C's render_disc). The two
  // crossing points come from the standard radical-line construction (identical
  // to interaggregate.js); each is laid down bright (alpha 0.75).
  function renderDisc(di) {
    const num = discs.length;
    for (let n = di.id + 1; n < num; n++) {
      const dj = discs[n];
      const dx = dj.x - di.x;
      const dy = dj.y - di.y;
      const d = Math.sqrt(dx * dx + dy * dy);

      // intersection test
      if (d < dj.r + di.r) {
        // complete-containment test (one disc inside the other => no crossing)
        if (d > Math.abs(dj.r - di.r)) {
          const a = (di.r * di.r - dj.r * dj.r + d * d) / (2 * d);
          const p2x = di.x + a * (dj.x - di.x) / d;
          const p2y = di.y + a * (dj.y - di.y) / d;

          const h = Math.sqrt(Math.max(0, di.r * di.r - a * a));

          const p3ax = (p2x + h * (dj.y - di.y) / d) | 0;
          const p3ay = (p2y - h * (dj.x - di.x) / d) | 0;
          const p3bx = (p2x - h * (dj.y - di.y) / d) | 0;
          const p3by = (p2y + h * (dj.x - di.x) / d) | 0;

          // bounds check (both points must be on-screen, else skip the pair)
          if (p3ax < 0 || p3ax >= W || p3ay < 0 || p3ay >= H ||
              p3bx < 0 || p3bx >= W || p3by < 0 || p3by >= H) {
            continue;
          }

          transPoint(p3ax, p3ay, 255, 0.75);
          transPoint(p3bx, p3by, 255, 0.75);
        }
      }
    }

    for (let m = 0; m < di.riders.length; m++) {
      moverenderRider(di.riders[m], di.x, di.y, di.r);
    }
  }

  // Seed the disc field (the C's init loop). Discs are arranged on an
  // anti-collapsing ring so the field stays spread out; each gets a velocity
  // proportional to its ring offset, in a random direction.
  function buildField() {
    const n = Math.max(11, Math.round(config.numDiscs));
    const maxradius = Math.max(31, Math.round(config.maxRadius));

    discs = new Array(n);
    for (let i = 0; i < n; i++) {
      // Arrange on an anti-collapsing circle (offsets in device px via W/H).
      const fx = 0.4 * W * Math.cos(TAU * i / n);
      const fy = 0.4 * H * Math.sin(TAU * i / n);
      const x = frand(W / 2) + fx;
      const y = frand(H / 2) + fy;
      const r = (5 + frand(maxradius)) * S;
      const bt = (Math.floor(Math.random() * 100) < 50) ? -1 : 1;

      discs[i] = makeDisc(i, x, y, bt * fx / 1000.0, bt * fy / 1000.0, r);
    }
  }

  // Map the whole brightness buffer through the ramp into the ImageData. The C
  // draws each touched pixel to the screen via get_pixel as it blends; since the
  // off-map is XCopyArea'd whole each frame, the screen == ramp[buffer], so we
  // bake the colour map once at frame end (cheaper than per-blend writes).
  function blit() {
    for (let i = 0; i < pixels.length; i++) {
      let v = alpha[i];
      if (v <= 0) { pixels[i] = ramp[0]; continue; }
      if (v > 255) v = 255;
      pixels[i] = ramp[v | 0];
    }
    ctx.putImageData(imageData, 0, 0);
  }

  // One frame (the C's intermomentary_draw): wipe the brightness buffer, then
  // for each disc in order move it and render its intersections + riders, then
  // colour-map the buffer to the screen. Processing in id order matters: a
  // disc's riders can flare on the intersections drawn earlier this same frame.
  function step() {
    alpha.fill(0);
    for (let i = 0; i < discs.length; i++) {
      moveDisc(discs[i]);
      renderDisc(discs[i]);
    }
    blit();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    alpha = new Float32Array(W * H);
    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);

    buildRamp();
    pixels.fill(ramp[0]);

    buildField();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Re-seed the field with the current config (clears the buffer because the
  // disc count / radius / rider count resize the field).
  function reinit() {
    init();
  }

  // rAF lag-accumulator paced by config.delay (µs): run one step() per delay,
  // banking leftover time so the pace is identical at any refresh rate. Cap
  // catch-up so a backgrounded tab doesn't fire a burst of steps on refocus.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay intermomentary runs 27.1 fps,
  // while the port at the stock 30000 us ran ~33 fps (1.2x fast). 30000 + 6900
  // = 36900 us -> 27 fps, matching the live binary. A calibration, not a tuning
  // knob (the delay slider still maps 1:1 to the xml resource).
  const OVERHEAD = 6900;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
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
    reinit,   // re-seed the disc field, keeping the current config
    config,
    params,
  };
}
