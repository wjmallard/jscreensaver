// colormap.js -- a faithful, standalone ES-module port of make_smooth_colormap
// (and the make_color_path / make_color_ramp / hsv_to_rgb it relies on) from
// xscreensaver's utils/colors.c + utils/hsv.c (Jamie Zawinski).
//
//   makeSmoothColormap(rng, ncolors = 128) -> Array of { r, g, b }
//
// The returned r,g,b are the EXACT 0..1 values the original feeds to glColor:
// hsv_to_rgb produces 16-bit channels (value = trunc(C * 65535)), which the
// hacks then divide by 65536.0. We fold both steps in, so colors[i] matches
// dangerball.c's bcolor/scolor channels bit-for-bit. To display them as the
// original's direct glColor3f values under a modern sRGB renderer, author them
// with THREE.SRGBColorSpace at the call site (see dangerball.js / cubicgrid.js).
//
// `rng` is a makeYaRandom(...) handle (yarandom.js); random()/frand() are drawn
// in the SAME ORDER as the C so a shared, identically-seeded stream reproduces
// the original's palette. Pure math module: no DOM, no THREE dependency.
//
// The smooth colormap picks 2-5 HSV anchor points (2: 30%, 3: 50%, 4: 15%,
// 5: 5%) with a minimum-separation retry and minimum average saturation/value,
// then interpolates them into a closed loop of `ncolors` entries.

const MAXPOINTS = 50;   // colors.c: "yeah, so I'm lazy"

// hsv_to_rgb (utils/hsv.c). h in degrees (any int), s,v in [0,1].
// Returns { r, g, b } in [0,1], 16-bit-quantized then /65536 exactly as the
// hacks consume it (trunc(C*65535) / 65536).
function hsvToRgb(h, s, v) {
  if (s < 0) s = 0;
  if (v < 0) v = 0;
  if (s > 1) s = 1;
  if (v > 1) v = 1;

  const S = s;
  const V = v;
  const hi = Math.trunc(h);               // (int) h
  const H = (hi % 360) / 60.0;
  const i = Math.trunc(H);                // (int) H, truncates toward zero
  const f = H - i;
  const p1 = V * (1 - S);
  const p2 = V * (1 - (S * f));
  const p3 = V * (1 - (S * (1 - f)));

  let R, G, B;
  if      (i === 0) { R = V;  G = p3; B = p1; }
  else if (i === 1) { R = p2; G = V;  B = p1; }
  else if (i === 2) { R = p1; G = V;  B = p3; }
  else if (i === 3) { R = p1; G = p2; B = V;  }
  else if (i === 4) { R = p3; G = p1; B = V;  }
  else              { R = V;  G = p1; B = p2; }

  return {
    r: Math.trunc(R * 65535) / 65536,
    g: Math.trunc(G * 65535) / 65536,
    b: Math.trunc(B * 65535) / 65536,
  };
}

// The FAIL-path color-count reduction (colors.c). Unreachable for our inputs
// (allocate_p is false and anchors are distinct), but ported for completeness.
function reduceNcolors(n) {
  return (n > 170 ? n - 20 :
          n > 100 ? n - 10 :
          n >  75 ? n -  5 :
          n >  25 ? n -  3 :
          n >  10 ? n -  2 :
          n >   2 ? n -  1 :
          0);
}

// make_color_ramp with closed_p = true: a smooth ramp h1,s1,v1 -> h2,s2,v2,
// then mirrored back to form a closed loop. Fills colors[0 .. total-1] in place.
function makeColorRamp(h1, s1, v1, h2, s2, v2, colors, total, closedP = true) {
  let ncolors = total;
  for (let i = 0; i < total; i++) colors[i] = { r: 0, g: 0, b: 0 };  // memset 0
  if (closedP) ncolors = Math.trunc(ncolors / 2) + 1;   // closed_p

  const dh = (h2 - h1) / ncolors;
  const ds = (s2 - s1) / ncolors;
  const dv = (v2 - v1) / ncolors;

  for (let i = 0; i < ncolors; i++)
    colors[i] = hsvToRgb(Math.trunc(h1 + (i * dh)), s1 + (i * ds), v1 + (i * dv));

  // closed_p: mirror the ramp back around the loop.
  if (closedP)
    for (let i = ncolors; i < total; i++)
      colors[i] = { ...colors[total - i] };
}

// make_color_path (colors.c). Spaces `total` colors evenly around the polygon
// of HSV anchor points. Consumes no RNG. Fills colors[] in place.
function makeColorPath(npoints, h, s, v, colors, total) {
  if (npoints === 0) return;
  if (npoints === 2) {
    makeColorRamp(h[0], s[0], v[0], h[1], s[1], v[1], colors, total);
    return;
  }
  if (npoints >= MAXPOINTS) npoints = MAXPOINTS - 1;

  let totalNcolors = total;

  for (;;) {   // AGAIN:
    const DH = new Array(npoints);
    const edge = new Array(npoints);
    const ratio = new Array(npoints);
    const nc = new Array(npoints);     // ncolors[] : pixels per edge
    const dh = new Array(npoints);
    const ds = new Array(npoints);
    const dv = new Array(npoints);
    let circum = 0;

    // Shortest hue distance around the circle (range 0 - 0.5), per edge.
    for (let i = 0; i < npoints; i++) {
      const j = (i + 1) % npoints;
      let dd = (h[i] - h[j]) / 360;
      if (dd < 0) dd = -dd;
      if (dd > 0.5) dd = 0.5 - (dd - 0.5);
      DH[i] = dd;
    }

    // Edge lengths in unit HSV space; circumference.
    for (let i = 0; i < npoints; i++) {
      const j = (i + 1) % npoints;
      edge[i] = Math.sqrt((DH[i] * DH[j]) +
                          ((s[j] - s[i]) * (s[j] - s[i])) +
                          ((v[j] - v[i]) * (v[j] - v[i])));
      circum += edge[i];
    }

    if (circum < 0.0001) {   // FAIL:
      totalNcolors = reduceNcolors(totalNcolors);
      if (totalNcolors > 0) continue;
      return;
    }

    for (let i = 0; i < npoints; i++) ratio[i] = edge[i] / circum;

    // Pixels per edge proportional to edge length.
    for (let i = 0; i < npoints; i++) nc[i] = Math.trunc(totalNcolors * ratio[i]);

    for (let i = 0; i < npoints; i++) {
      const j = (i + 1) % npoints;
      if (nc[i] > 0) {
        dh[i] = 360 * (DH[i] / nc[i]);
        ds[i] = (s[j] - s[i]) / nc[i];
        dv[i] = (v[j] - v[i]) / nc[i];
      }
    }

    for (let i = 0; i < total; i++) colors[i] = { r: 0, g: 0, b: 0 };  // memset 0

    let k = 0;
    for (let i = 0; i < npoints; i++) {
      const distance = h[(i + 1) % npoints] - h[i];
      let direction = (distance >= 0 ? -1 : 1);
      if (distance <= 180 && distance >= -180) direction = -direction;

      for (let j = 0; j < nc[i]; j++, k++) {
        let hh = h[i] + (j * dh[i] * direction);
        if (hh < 0) hh += 360;
        else if (hh > 360) hh -= 0;   // a no-op in the .c; preserved.
        colors[k] = hsvToRgb(Math.trunc(hh),
                             s[i] + (j * ds[i]),
                             v[i] + (j * dv[i]));
      }
    }

    // Float round-off can leave k < total: pad by duplicating the last color.
    if (k < total) {
      if (k <= 0) return;
      for (let i = k; i < total; i++) colors[i] = { ...colors[i - 1] };
    }
    return;
  }
}

// make_smooth_colormap (colors.c). Returns an Array of `ncolors` { r, g, b }.
export function makeSmoothColormap(rng, ncolors = 128) {
  if (ncolors <= 0) return [];

  let npoints;
  {
    const n = rng.random() % 20;
    if      (n <= 5)  npoints = 2;   // 30%
    else if (n <= 15) npoints = 3;   // 50%
    else if (n <= 18) npoints = 4;   // 15%
    else              npoints = 5;   //  5%
  }

  const h = new Array(MAXPOINTS);
  const s = new Array(MAXPOINTS);
  const v = new Array(MAXPOINTS);
  // NOTE: total_s / total_v are declared once and are NOT reset across the
  // REPICK_ALL_COLORS loop -- this matches the .c (where the goto jumps past
  // their initialization). Faithfully preserved so the RNG draws line up.
  let total_s = 0;
  let total_v = 0;
  let loop = 0;

  for (;;) {   // REPICK_ALL_COLORS:
    for (let i = 0; i < npoints; i++) {
      for (;;) {   // REPICK_THIS_COLOR:
        if (++loop > 10000) throw new Error('make_smooth_colormap: looped');
        h[i] = rng.random() % 360;
        s[i] = rng.frand(1.0);
        v[i] = rng.frand(0.8) + 0.2;

        // No two adjacent colors too close together; if so, repick this one.
        if (i > 0) {
          const j = (i + 1 === npoints) ? 0 : (i - 1);
          const hi = h[i] / 360;
          const hj = h[j] / 360;
          let dh = hj - hi;
          if (dh < 0) dh = -dh;
          if (dh > 0.5) dh = 0.5 - (dh - 0.5);
          const distance = Math.sqrt((dh * dh) +
                                     ((s[j] - s[i]) * (s[j] - s[i])) +
                                     ((v[j] - v[i]) * (v[j] - v[i])));
          if (distance < 0.2) continue;   // goto REPICK_THIS_COLOR
        }
        total_s += s[i];
        total_v += v[i];
        break;
      }
    }
    // Avoid a black-and-white or too-dark map: repick if too desaturated/dark.
    if (total_s / npoints < 0.2) continue;
    if (total_v / npoints < 0.3) continue;
    break;
  }

  const colors = new Array(ncolors);
  for (let i = 0; i < ncolors; i++) colors[i] = { r: 0, g: 0, b: 0 };
  makeColorPath(npoints, h, s, v, colors, ncolors);
  return colors;
}

// make_random_colormap (colors.c). `ncolors` INDEPENDENT random colours (no
// ramp). bright_p: random hue 0-360, saturation 30%-100%, value 66%-100% (vivid
// but not full-saturation) via hsv_to_rgb. Otherwise each channel is an
// independent random 16-bit value, with a value-contrast retry so the first two
// of a tiny (<= 4) map differ. Returns `ncolors` { r, g, b } in [0,1]
// (16-bit-quantized as the X server consumes it). Draws RNG in the same order as
// the C (random() % N).
export function makeRandomColormap(rng, ncolors = 64, brightP = true) {
  if (ncolors <= 0) return [];
  const colors = new Array(ncolors);
  for (;;) {   // RETRY_ALL:
    for (let i = 0; i < ncolors; i++) {
      if (brightP) {
        const H = rng.random() % 360;                  // range 0-360
        const S = ((rng.random() % 70) + 30) / 100.0;  // range 30%-100%
        const V = ((rng.random() % 34) + 66) / 100.0;  // range 66%-100%
        colors[i] = hsvToRgb(H, S, V);
      } else {
        colors[i] = {
          r: (rng.random() % 0xFFFF) / 65536,
          g: (rng.random() % 0xFFFF) / 65536,
          b: (rng.random() % 0xFFFF) / 65536,
        };
      }
    }
    // Small non-bright maps: make sure the first two contrast in value (V = the
    // max channel, per rgb_to_hsv); otherwise repick the whole map.
    if (!brightP && ncolors <= 4) {
      const v0 = Math.max(colors[0].r, colors[0].g, colors[0].b);
      const v1 = Math.max(colors[1].r, colors[1].g, colors[1].b);
      if (Math.abs(v1 - v0) < 0.5) continue;   // goto RETRY_ALL
    }
    return colors;
  }
}

// ---------------------------------------------------------------------------
// Canvas-friendly helpers (0..255), for the 2D hacks.
//
// These let a plain Math.random()-based hack get the SAME palette structure the
// C produces. make_smooth_colormap is re-rolled every run, so Math.random's
// sequence is fine here -- only the DISTRIBUTION (npoints weights, HSV ranges,
// min-separation / min-avg-s/v retries) must match, which makeSmoothColormap
// already enforces.

// Drop-in rng matching the surface makeSmoothColormap uses (random() -> a large
// non-negative int like C's random(); frand(x) -> [0, x)).
const mathRng = {
  random: () => Math.floor(Math.random() * 0x100000000),
  frand: (x) => x * Math.random(),
};

// 16-bit-quantized [0,1) channel -> 8-bit, matching the X server's red>>8
// downsample of hsv_to_rgb's trunc(C*65535) (i.e. floor(c * 256), capped).
function to255(c) {
  return c <= 0 ? 0 : c >= 1 ? 255 : Math.floor(c * 256);
}

// make_smooth_colormap as `ncolors` [r,g,b] triplets in 0..255.
export function makeSmoothColormapRGB(ncolors = 128, rng = mathRng) {
  return makeSmoothColormap(rng, ncolors).map((c) => [to255(c.r), to255(c.g), to255(c.b)]);
}

// make_random_colormap as `ncolors` [r,g,b] in 0..255. bright (default) = vivid
// random HSV (the C's BRIGHT_COLORS — e.g. thornbird); bright=false = fully
// random channels. Re-rolled per run, so Math.random's order is fine (only the
// distribution must match the C).
export function makeRandomColormapRGB(ncolors = 64, bright = true, rng = mathRng) {
  return makeRandomColormap(rng, ncolors, bright).map((c) => [to255(c.r), to255(c.g), to255(c.b)]);
}

// make_color_ramp (h1,s1,v1 -> h2,s2,v2) as `ncolors` [r,g,b] in 0..255.
// closedP mirrors the ramp into a loop (the C's closed_p); pass false for a
// plain one-way ramp (e.g. intermomentary's black->yellow heat ramp).
export function makeColorRampRGB(h1, s1, v1, h2, s2, v2, ncolors, closedP = false) {
  const tmp = new Array(ncolors);
  makeColorRamp(h1, s1, v1, h2, s2, v2, tmp, ncolors, closedP);
  return tmp.map((c) => [to255(c.r), to255(c.g), to255(c.b)]);
}

// make_uniform_colormap as `ncolors` [r,g,b] in 0..255 -- a full hue ramp
// (0 -> 359) at a SINGLE per-run saturation and value, each random in
// [66%,100%] (the C's UNIFORM_COLORS scheme, e.g. lisa). So it is a rainbow,
// but on any given run somewhat desaturated/dimmed -- not the fixed max-vivid
// hsl() ramp the early ports used. Re-rolled per run, so mathRng's order is
// fine; only the S/V distribution and the full 0->359 hue sweep must match.
export function makeUniformColormapRGB(ncolors = 64, rng = mathRng) {
  const S = ((rng.random() % 34) + 66) / 100.0;   // range 66%-100%
  const V = ((rng.random() % 34) + 66) / 100.0;   // range 66%-100%
  return makeColorRampRGB(0, S, V, 359, S, V, ncolors, false);
}

export default makeSmoothColormap;
