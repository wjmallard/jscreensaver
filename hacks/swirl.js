// swirl.js — swirl packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's swirl.c (M. Dobie & R. Taylor, 1994; standalone 1997).
// https://www.jwz.org/xscreensaver/
//
// Swirl scatters a handful of "knots" (spiral centres) across the screen, each
// with a random mass (+ or -) and a random spiral TYPE — orbit, wheel, ray, or
// hook. Every pixel's value is the signed sum of each knot's contribution at
// that point (an atan2/distance term per knot), wrapped modulo the colour count.
// That integer field is mapped through a closed-loop colourmap, and the WHOLE
// look is animated NOT by recomputing the field but by ROTATING the colourmap a
// few steps per frame (the classic palette-cycling "swirly colour-cycling"
// effect). After a while the swirl is regenerated: fresh knots + a fresh palette
// paint a brand-new pattern.
//
// Rendering: the per-pixel field is a dense, expensive thing (a sqrt + atan2 per
// knot per pixel), so this uses the BLIT path AND the retina-downscale idiom —
// the field is computed at LOGICAL (CSS-pixel) resolution into a small offscreen
// canvas and ctx.drawImage upscales it to the device-px canvas (see [[metaballs]]
// / [[marbling]]). The heavy recompute happens only when a new swirl is born,
// and even then it is spread across a few frames (a centre-out reveal); the
// per-frame cost is just the colourmap rotation + blit. See swirl.md.

export const title = 'swirl';

export const info = {
  author: 'M. Dobie and R. Taylor',
  description: 'Flowing, swirly patterns.',
  year: 1994,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/swirl.xml so the config box maps 1:1 to
  // the original. delay is microseconds (xml units). cyclespeed/duration are
  // added for parity with the other ports (the C derives the cycle shift from
  // ncolors and hardcodes RESTART = 2500 frames between swirls).
  const config = {
    delay: 25000,       // µs between frames (--delay; xml 10000, eased a touch)
    count: 5,           // base knot count (--count); n_knots = rand(count/2)+count+1
    ncolors: 200,       // size of the cycling closed-loop colourmap (--ncolors)
    cyclespeed: 3,      // palette rotation per frame (the C's `shift`)
    duration: 1200,     // frames of cycling before a new swirl (the C's RESTART)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 25000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cyclespeed', label: 'Cycle speed', type: 'range', min: 0, max: 12, step: 1, default: 3, lowLabel: 'still', highLabel: 'fast', live: true },
    { key: 'duration', label: 'Duration', type: 'range', min: 200, max: 5000, step: 50, default: 1200, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'count', label: 'Count', type: 'range', min: 0, max: 20, step: 1, default: 5, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 2, max: 255, step: 1, default: 200, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  const BLACK = 0xFF000000;       // opaque black, little-endian 0xAABBGGRR

  // Knot types. The C's ALL mode enables ORBIT/WHEEL/RAY/HOOK but NOT PICASSO
  // (its switch never sets picasso under ALL), so we mirror that: PICASSO exists
  // for completeness but is never seeded. Values are small ints (switch keys).
  const ORBIT = 0;
  const WHEEL = 1;
  const RAY = 2;
  const HOOK = 3;
  const PICASSO = 4;
  const TYPES_ALL = [ORBIT, WHEEL, RAY, HOOK];

  const MASS = 4;                 // maximum |mass| of a knot (C's MASS)
  const TWO_PLANE_PCNT = 30;      // probability (%) of two-plane interleave mode

  // Cap the internal field so the per-pixel recompute (and the per-frame remap)
  // stay bounded on huge / retina displays; the grid upscales with bilinear
  // smoothing, which suits swirl's soft flowing look. See swirl.md.
  const MAX_CELLS = 360000;
  // Spread a new swirl's heavy compute over this many frames (a centre-out
  // reveal), so generating one never causes a single multi-hundred-ms hitch.
  const BUILD_FRAMES = 24;

  let S = 1;                      // devicePixelRatio
  let W, H;                       // canvas size, device px
  let gw, gh;                     // field grid size, LOGICAL px (capped)
  let imageData, pixels;          // Uint32 view over ImageData (grid-sized)
  let scratch, sctx;              // offscreen grid canvas, upscaled to main

  let idx;                        // Uint8Array(gw*gh): per-pixel colour INDEX
  let palette;                    // Uint32Array(ncolors): the closed-loop map
  let ncolors;                    // captured colour count (2..255)
  let qcolours;                   // ncolors / 4 (the C's qcolours)
  let radsConst;                  // ncolors / (2*PI) (the C's rads)

  // Knot arrays (one entry per knot), refreshed every swirl.
  let nKnots;
  let kx, ky;                     // knot position, grid coords (Float64)
  let km;                         // knot mass, signed (Float64)
  let kt, kT;                     // knot type in plane 1 / plane 2 (Uint8)
  let twoPlane;                   // interleave two type-sets this swirl?

  // Reveal/lifecycle state.
  let building;                   // computing the field (centre-out)?
  let loRow, hiRow;              // computed rows are [loRow, hiRow) (half-open)
  let rowsPerFrame;              // rows to compute per build frame
  let offset;                    // current colourmap rotation
  let dwell;                     // frames spent cycling since the field finished

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // The C's random_no(n): a random integer in [0, n] inclusive.
  function randNo(n) {
    return Math.floor((n + 1) * Math.random());
  }

  // hsl (h in [0,1)) -> [r,g,b] each 0-255. Used to pick vivid base colours.
  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    const seg = Math.floor(h * 6) % 6;
    if (seg === 0) { r = c; g = x; }
    else if (seg === 1) { r = x; g = c; }
    else if (seg === 2) { g = c; b = x; }
    else if (seg === 3) { g = x; b = c; }
    else if (seg === 4) { r = x; b = c; }
    else { r = c; b = x; }
    return [
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255),
    ];
  }

  function rgbDist(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  // Write `count` colours from a -> b (excluding b, so the next leg starts at b
  // and the loop is seamless) into palette starting at p; returns the next p.
  function fillLeg(p, a, b, count) {
    for (let i = 0; i < count; i++) {
      const t = i / count;
      const r = Math.round(a[0] + (b[0] - a[0]) * t);
      const g = Math.round(a[1] + (b[1] - a[1]) * t);
      const bl = Math.round(a[2] + (b[2] - a[2]) * t);
      palette[p++] = ((0xff << 24) | (bl << 16) | (g << 8) | r) >>> 0;
    }
    return p;
  }

  // Build a CLOSED-LOOP colourmap from 3 distinct vivid colours (mirrors the C's
  // basic_map: three random base colours interpolated round a triangle so the
  // map wraps, which is what makes the rotation seamless). We draw the three
  // base colours from a saturated HSL wheel instead of the C's muted fixed
  // table (the porter brief prefers vivid palettes); fresh hues each swirl mean
  // successive swirls differ in colour. Leg lengths are proportional to RGB
  // distance, as in the C.
  function buildPalette() {
    const n = ncolors;
    palette = new Uint32Array(n);
    // Three hues spread ~120 degrees apart (a colour triangle, as in the C),
    // with a little jitter; the wide spread keeps them distinct even when a leg
    // gets very few entries at tiny ncolors.
    const h0 = Math.random();
    const h1 = (h0 + 1 / 3 + (Math.random() - 0.5) * 0.15 + 1) % 1;
    const h2 = (h0 + 2 / 3 + (Math.random() - 0.5) * 0.15 + 1) % 1;
    const c0 = hslToRgb(h0, 1, 0.5);
    const c1 = hslToRgb(h1, 1, 0.5);
    const c2 = hslToRgb(h2, 1, 0.5);
    const l1 = rgbDist(c0, c1);
    const l2 = rgbDist(c1, c2);
    const l3 = rgbDist(c2, c0);
    const l = l1 + l2 + l3 || 1;
    const n0 = Math.floor((n * l1) / l);
    const n1 = Math.floor((n * l2) / l);
    const n2 = n - n0 - n1;        // remainder -> always sums to exactly n
    let p = 0;
    p = fillLeg(p, c0, c1, n0);
    p = fillLeg(p, c1, c2, n1);
    p = fillLeg(p, c2, c0, n2);
  }

  // Seed a fresh set of knots (positions, masses, spiral types) and decide
  // whether this swirl runs in two-plane interleave mode. Faithful to the C's
  // init_swirl + create_knots.
  function seedKnots() {
    const count = clamp(Math.round(config.count), 0, 64);
    nKnots = randNo(Math.floor(count / 2)) + count + 1;
    twoPlane = randNo(100) <= TWO_PLANE_PCNT;

    kx = new Float64Array(nKnots);
    ky = new Float64Array(nKnots);
    km = new Float64Array(nKnots);
    kt = new Uint8Array(nKnots);
    kT = new Uint8Array(nKnots);

    for (let k = 0; k < nKnots; k++) {
      kx[k] = randNo(gw);
      ky[k] = randNo(gh);

      // Mass 1..MASS+1, sometimes negated (a -ve knot subtracts its field).
      let m = randNo(MASS) + 1;
      if (randNo(100) > 50) m = -m;
      km[k] = m;

      // A random type from the ALL set (orbit/wheel/ray/hook).
      kt[k] = TYPES_ALL[randNo(TYPES_ALL.length - 1)];

      // In two-plane mode each knot also has a DIFFERENT second-plane type.
      if (twoPlane) {
        let t2 = TYPES_ALL[randNo(TYPES_ALL.length - 1)];
        while (t2 === kt[k]) {
          t2 = TYPES_ALL[randNo(TYPES_ALL.length - 1)];
        }
        kT[k] = t2;
      } else {
        kT[k] = kt[k];
      }
    }
  }

  // Compute the colour INDEX for one grid pixel (the C's do_point): sum each
  // knot's spiral contribution, then fold the signed total into [0, ncolors).
  // `plane` selects which type-set to use in two-plane mode (a per-pixel
  // checkerboard, vs. the C's block interleave — see swirl.md).
  function computeRow(gy) {
    const n = ncolors;
    const qn = qcolours;
    const rads = radsConst;
    const tp = twoPlane;
    const rowBase = gy * gw;
    for (let gx = 0; gx < gw; gx++) {
      const plane = tp ? ((gx + gy) & 1) : 0;
      let value = 0;
      for (let k = 0; k < nKnots; k++) {
        const dx = gx - kx[k];
        const dy = gy - ky[k];
        const m = km[k];
        const type = plane ? kT[k] : kt[k];
        const dist = Math.sqrt(dx * dx + dy * dy);
        let add = 0;
        // Skip the singular cell (dist <= 0.1): keeps every term finite and
        // dodges atan2(0,0). Matches the C's `if (dist > 0.1)` guard.
        if (dist > 0.1) {
          switch (type) {
            case ORBIT:
              add = n / (1.0 + 0.01 * Math.abs(m) * dist);
              break;
            case WHEEL: {
              const theta = (Math.atan2(dy, dx) + Math.PI) / Math.PI;
              const s = Math.sin(0.1 * m * dist) * qn * Math.exp(-0.01 * dist);
              add = (theta < 1.0)
                ? (n * theta + s)
                : (n * (theta - 1.0) + s);
              break;
            }
            case PICASSO:
              add = n * Math.abs(Math.cos(0.002 * m * dist));
              break;
            case RAY:
              add = n * Math.abs(Math.sin(2.0 * Math.atan2(dy, dx)));
              break;
            case HOOK:
              add = rads * Math.atan2(dy, dx) + 0.05 * (Math.abs(m) - 1) * dist;
              break;
          }
          add = Math.trunc(add);     // the C casts (int): truncate toward zero
        }
        value += m > 0 ? add : -add;
      }

      // Fold into range exactly as the C does (the asymmetric +2 / mod-(n-1)
      // handling of negatives shapes the banding; with palette cycling the
      // absolute offset is cosmetic but we keep it faithful). n >= 2 so the
      // `% (n - 1)` divisor is never zero.
      let v;
      if (value >= 0) v = (value % n) + 2;
      else v = n - (Math.abs(value) % (n - 1));
      v = ((v % n) + n) % n;
      idx[rowBase + gx] = v;
    }
  }

  // Compute the next centre-out band of rows for the in-progress swirl. The
  // revealed region is the contiguous band [loRow, hiRow); each call grows it
  // by ~rowsPerFrame rows, alternating down/up from the centre.
  function computeBand() {
    let budget = rowsPerFrame;
    while (budget > 0 && (loRow > 0 || hiRow < gh)) {
      if (hiRow < gh) {
        computeRow(hiRow);
        hiRow++;
        budget--;
      }
      if (budget > 0 && loRow > 0) {
        loRow--;
        computeRow(loRow);
        budget--;
      }
    }
    if (loRow <= 0 && hiRow >= gh) building = false;
  }

  // Map the computed band of the index field through the (rotated) palette into
  // the pixel buffer, then blit + upscale. Rows outside [loRow, hiRow) stay
  // black (pre-filled), giving the centre-out reveal.
  function render() {
    const n = ncolors;
    const off = offset;
    const start = loRow * gw;
    const end = hiRow * gw;
    for (let p = start; p < end; p++) {
      let i = idx[p] + off;        // off < n, idx < n -> sum < 2n
      if (i >= n) i -= n;
      pixels[p] = palette[i];
    }
    sctx.putImageData(imageData, 0, 0);
    ctx.drawImage(scratch, 0, 0, gw, gh, 0, 0, W, H);
  }

  // Begin a brand-new swirl: fresh knots, fresh palette, a clean canvas, and the
  // centre-out reveal restarted. The colour offset keeps running so cycling is
  // continuous across swirls.
  function newSwirl() {
    seedKnots();
    buildPalette();
    pixels.fill(BLACK);
    const center = gh >> 1;
    loRow = center;
    hiRow = center;
    building = true;
    dwell = 0;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  // One frame: build (if still revealing) or count down to the next swirl, then
  // rotate the colourmap and paint.
  function step() {
    if (building) {
      computeBand();
    } else {
      dwell++;
      if (dwell >= config.duration) {
        newSwirl();
      }
    }
    const cs = clamp(Math.round(config.cyclespeed), 0, 64);
    offset = (offset + cs) % ncolors;
    render();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // Field grid at LOGICAL resolution (device px / dpr) so retina doesn't
    // multiply the per-pixel cost; capped so huge displays stay affordable.
    let lw = Math.max(1, Math.round(W / S));
    let lh = Math.max(1, Math.round(H / S));
    if (lw * lh > MAX_CELLS) {
      const f = Math.sqrt((lw * lh) / MAX_CELLS);
      lw = Math.max(1, Math.floor(lw / f));
      lh = Math.max(1, Math.floor(lh / f));
    }
    gw = lw;
    gh = lh;

    // Clamp ncolors to >= 2: the field-folding step divides by (ncolors - 1),
    // and a 1-colour map can't cycle. (xml allows low = 1.)
    ncolors = clamp(Math.round(config.ncolors), 2, 255);
    qcolours = Math.floor(ncolors / 4);
    radsConst = ncolors / (2.0 * Math.PI);

    idx = new Uint8Array(gw * gh);

    scratch = document.createElement('canvas');
    scratch.width = gw;
    scratch.height = gh;
    sctx = scratch.getContext('2d');
    imageData = sctx.createImageData(gw, gh);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    rowsPerFrame = Math.max(1, Math.ceil(gh / BUILD_FRAMES));
    offset = 0;

    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    newSwirl();
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
  // banking leftover time so the pace is identical at any refresh rate. The cap
  // is low because a build frame can be heavy; a slow frame should fall behind,
  // not stack a burst.
  const MAX_CATCHUP_STEPS = 4;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = config.delay / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Rebuild after a non-live config change (count/ncolors resize knots/palette).
  // init() clears to black and starts a fresh swirl, keeping config.
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
    reinit,   // fresh swirl with the current config
    config,
    params,
  };
}
