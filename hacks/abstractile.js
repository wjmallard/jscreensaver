// abstractile.js -- abstractile packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's abstractile.c by Steve Sundstrom (2004-2009, ~1624 lines).
// https://www.jwz.org/xscreensaver/
//
// Mosaic patterns of interlocking tiles. The screen is a fine grid (each cell
// `lwid` px square). A maze of short horizontal/vertical "lines" is grown to
// fill the grid; each line picks a colour from a layered pattern/shape field and
// a draw-order key from one of ~40 "draw maps". The lines are sorted by that key
// and painted incrementally (so the mosaic grows in a pattern), held for a few
// seconds, then the previous screen is erased line-by-line and a fresh pattern +
// palette is built. Tiles can be flat, outlined, neon-glow, block-bevel, or the
// interlocking "tiled" style (the big _draw_tiled corner/T/X tile table).
//
// Rendering: SPARSE -- every tile is a fillRect (plus a few triangles/polygons
// for the tiled corners), drawn straight to the persistent canvas a batch per
// frame, like squiral.js. NOT per-pixel. See [[squiral]] for the skeleton and
// [[truchet]] for the grid-tile-mosaic technique twin.
//
// The big switch tables (_getdeo draw maps, _shape, _pattern, _draw_tiled tile
// geometry, the 30 base colours) are transcribed VERBATIM from the C -- a
// transcription slip there is a broken tile, so they are ported case-for-case.

export const title = 'abstractile';

export const info = {
  author: 'Steve Sundstrom',
  description: 'Mosaic patterns of interlocking tiles.',
  year: 2004,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Units/defaults mirror hacks/config/abstractile.xml: speed (the C's --speed,
  // 0..5), sleep (--sleep, linger seconds), tile (--tile). abstractile has NO
  // *delay resource -- the C paces itself entirely from speed/sleep and the
  // per-screen `lpu` (lines-per-update), so there is no host "Frame rate" knob.
  const config = {
    speed: 3,           // 0..5, the C's --speed (5 = ~instant build, 0 = ~10 s)
    sleep: 3,           // seconds to linger on a finished screen (--sleep)
    tile: 'random',     // tile style (--tile): random/flat/thin/outline/block/neon/tiled
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value changes the build, so a change re-runs init() via
  //                reinit() (a clean black canvas + a fresh mosaic).
  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 5, step: 1, default: 3, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'sleep', label: 'Linger', type: 'range', min: 0, max: 60, step: 1, default: 3, unit: ' s', lowLabel: '0s', highLabel: '60s', live: true },
    { key: 'tile', label: 'Tile style', type: 'select', default: 'random', live: false, options: [
        { value: 'random', label: 'Random tile layout' },
        { value: 'flat', label: 'Flat tiles' },
        { value: 'thin', label: 'Thin tiles' },
        { value: 'outline', label: 'Outline tiles' },
        { value: 'block', label: 'Block tiles' },
        { value: 'neon', label: 'Neon tiles' },
        { value: 'tiled', label: 'Tiled tiles' },
      ] },
  ];

  // ---- constants (verbatim from the C #defines) ----
  const MODE_CREATE = 0, MODE_ERASE = 1, MODE_DRAW = 2;
  const DIR_NONE = 0, DIR_UP = 1, DIR_DOWN = 2, DIR_LEFT = 3, DIR_RIGHT = 4;
  const LINE_FORCE = 1, LINE_NEW = 2, LINE_BRIN = 3, LINE_BROUT = 4;
  const D3D_NONE = 0, D3D_BLOCK = 1, D3D_NEON = 2, D3D_TILED = 3;
  const TILE_RANDOM = 0, TILE_FLAT = 1, TILE_THIN = 2, TILE_OUTLINE = 3,
        TILE_BLOCK = 4, TILE_NEON = 5, TILE_TILED = 6;
  const BASECOLORS = 30, MAXCOLORS = 40, LAYERS = 4, PATTERNS = 40,
        SHAPES = 18, DRAWORDERS = 40, COLORMAPS = 20, WAVES = 6, STRETCHES = 8;

  // The 30 base colours (16-bit per channel), transcribed verbatim from basecol[].
  const basecol = [
    [0x3333, 0x3333, 0x3333],  // 0  dgray
    [0x6666, 0x3333, 0x0000],  // 1  dbrown
    [0x9999, 0x0000, 0x0000],  // 2  dred
    [0xFFFF, 0x6666, 0x0000],  // 3  orange
    [0xFFFF, 0xCCCC, 0x0000],  // 4  gold
    [0x6666, 0x6666, 0x0000],  // 5  olive
    [0x0000, 0x6666, 0x0000],  // 6  ivy
    [0x0000, 0x9999, 0x0000],  // 7  dgreen
    [0x3333, 0x6666, 0x6666],  // 8  bluegray
    [0x0000, 0x0000, 0x9999],  // 9  dblue
    [0x3333, 0x3333, 0xFFFF],  // 10 blue
    [0x6666, 0x0000, 0xCCCC],  // 11 dpurple
    [0x6666, 0x3333, 0xFFFF],  // 12 purple
    [0x9999, 0x3333, 0x9999],  // 13 violet
    [0xCCCC, 0x3333, 0xCCCC],  // 14 magenta
    [0x3333, 0x3333, 0x3333],  // 15 gray
    [0x9999, 0x6666, 0x3333],  // 16 brown
    [0xCCCC, 0x9999, 0x3333],  // 17 tan
    [0xFFFF, 0x0000, 0x0000],  // 18 red
    [0xFFFF, 0x9999, 0x0000],  // 19 lorange
    [0xFFFF, 0xFFFF, 0x0000],  // 20 yellow
    [0x9999, 0x9999, 0x0000],  // 21 lolive
    [0x3333, 0xCCCC, 0x0000],  // 22 green
    [0x3333, 0xFFFF, 0x3333],  // 23 lgreen
    [0x0000, 0xCCCC, 0xCCCC],  // 24 cyan
    [0x3333, 0xFFFF, 0xFFFF],  // 25 sky
    [0x3333, 0x6666, 0xFFFF],  // 26 marine
    [0x3333, 0xCCCC, 0xFFFF],  // 27 lblue
    [0x9999, 0x9999, 0xFFFF],  // 28 lpurple
    [0xFFFF, 0x9999, 0xFFFF],  // 29 pink
  ];

  const T = Math.trunc;                                   // C integer division/cast
  const irand = (n) => (n <= 0 ? 0 : Math.floor(Math.random() * n));  // random()%n
  const _min = (a, b) => (a <= b ? a : b);
  const _max = (a, b) => (a >= b ? a : b);

  // ---- jscreensaver-side deviation: the C reused one X colormap for the whole
  // run (jwz disabled the per-screen colormap because it thrashed X). Canvas has
  // no such cost, so we regenerate the palette every screen (newcols = true),
  // matching the author's original Linux/Mac intent and giving varied screens. ----
  const newcols = true;

  // ---- state ----
  let S = 1;                                              // devicePixelRatio
  let cw = 0, ch = 0;                                     // canvas size, device px
  let dialog = 0;                                         // 1 on small windows
  let ii = 0, mode = MODE_CREATE, bi = 1;
  let li = 0, eli = 0, oi = 0, zi = 0, fi = 0, di = 0;
  let grid_full = false;
  let lwid = 3, elwid = 3, egridx = 0, egridy = 0;
  let gridx = 0, gridy = 0, gridn = 0;
  let maxlen = 0, bnratio = 4, forcemax = 0, olen = 0, bln = 0;
  let ncolors = 1, shades = 1;
  let colors = ['#000'];
  let cmap = 0, emap = 0, dmap = 0, dvar = 0, evar = 0, ddir = 1, edir = 1, layers = 2;
  let rco = new Int32Array(MAXCOLORS);
  let d3d = D3D_NONE, round = 0, outline = 0;

  // per-layer arrays (several persist across screens via += rotation, as in the C)
  const pattern = new Array(LAYERS).fill(0);
  const shape = new Array(LAYERS).fill(0);
  const mix = new Array(LAYERS).fill(0);
  const csw = new Array(LAYERS).fill(0);
  const wsx = new Array(LAYERS).fill(0);
  const wsy = new Array(LAYERS).fill(0);
  const sec = new Array(LAYERS).fill(0);
  const cs1 = new Array(LAYERS).fill(1);
  const cs2 = new Array(LAYERS).fill(1);
  const cs3 = new Array(LAYERS).fill(1);
  const cs4 = new Array(LAYERS).fill(1);
  const wave = new Array(LAYERS).fill(0);
  const waveh = new Array(LAYERS).fill(0);
  const wavel = new Array(LAYERS).fill(0);
  const rx1 = new Array(LAYERS).fill(0);
  const rx2 = new Array(LAYERS).fill(0);
  const rx3 = new Array(LAYERS).fill(0);
  const ry1 = new Array(LAYERS).fill(0);
  const ry2 = new Array(LAYERS).fill(0);
  const ry3 = new Array(LAYERS).fill(0);

  // lines: dline = the screen being built/drawn, eline = the previous screen
  // being erased. Index 0 is a sentinel (sorts first so the draw index is never
  // null). Lines push during build; sorting moves whole objects (= the C qsort).
  const makeSentinel = () => ({ x: 0, y: 0, len: 0, obj: 0, color: 0, ndol: 0, deo: -999999999, hv: false });
  let dline = [makeSentinel()];
  let eline = [makeSentinel()];

  // grid cell fields. line/hl/hr/vu/vd are used only while BUILDING (pre-sort
  // indices, consistent within the build); dhl/dhr/dvu/dvd are used only while
  // DRAWING (sorted indices, set fresh). All cleared each screen in initZlist.
  let gLine, gHl, gHr, gVu, gVd, gDhl, gDhr, gDvu, gDvd, zlist;
  let gridCap = 0;

  const clampIdx = (i) => (i < 0 ? 0 : i >= colors.length ? colors.length - 1 : i);

  // ===================================================================
  //  Colour utilities (ports of utils/hsv.c + utils/colors.c)
  // ===================================================================

  function hsvToRgb(h, s, v) {
    if (s < 0) s = 0; if (v < 0) v = 0; if (s > 1) s = 1; if (v > 1) v = 1;
    const H = ((((h % 360) + 360) % 360)) / 60.0;
    const i = Math.floor(H), f = H - i;
    const p1 = v * (1 - s), p2 = v * (1 - s * f), p3 = v * (1 - s * (1 - f));
    let R, G, B;
    if (i === 0) { R = v; G = p3; B = p1; }
    else if (i === 1) { R = p2; G = v; B = p1; }
    else if (i === 2) { R = p1; G = v; B = p3; }
    else if (i === 3) { R = p1; G = p2; B = v; }
    else if (i === 4) { R = p3; G = p1; B = v; }
    else { R = v; G = p1; B = p2; }
    return { r: Math.round(R * 65535), g: Math.round(G * 65535), b: Math.round(B * 65535) };
  }

  function rgbToHsv(r, g, b) {
    const R = r / 65535.0, G = g / 65535.0, B = b / 65535.0;
    let cmax = R, cmin = G, imax = 1;
    if (cmax < G) { cmax = G; cmin = R; imax = 2; }
    if (cmax < B) { cmax = B; imax = 3; }
    if (cmin > B) cmin = B;
    const cmm = cmax - cmin, V = cmax;
    let S = 0, H = 0;
    if (cmm !== 0) {
      S = cmm / cmax;
      if (imax === 1) H = (G - B) / cmm;
      else if (imax === 2) H = 2.0 + (B - R) / cmm;
      else H = 4.0 + (R - G) / cmm;
      if (H < 0) H += 6.0;
    }
    return { h: H * 60.0, s: S, v: V };
  }

  // make_color_ramp: `total` colours by linear HSV interpolation h1..h2.
  function makeColorRamp(out, base, h1, s1, v1, h2, s2, v2, total, closed) {
    let nc = total;
    if (closed) nc = T(total / 2) + 1;
    const dh = (h2 - h1) / nc, ds = (s2 - s1) / nc, dv = (v2 - v1) / nc;
    for (let i = 0; i < nc; i++)
      out[base + i] = hsvToRgb(T(h1 + i * dh), s1 + i * ds, v1 + i * dv);
    if (closed)
      for (let i = nc; i < total; i++) out[base + i] = out[base + (total - i)];
  }

  function makeColorRampRGB(out, base, r1, g1, b1, r2, g2, b2, total) {
    const a = rgbToHsv(r1, g1, b1), c = rgbToHsv(r2, g2, b2);
    // make_color_ramp_rgb ignores its own closed_p arg in the C (always False).
    makeColorRamp(out, base, a.h, a.s, a.v, c.h, c.s, c.v, total, false);
  }

  // make_color_path: spread `total` colours around the loop of npoints HSV nodes,
  // ncolours-per-edge proportional to edge length. Ported verbatim (incl. the
  // DH[i]*DH[j] edge term and the quirky `direction` rule).
  function makeColorPath(out, npoints, h, s, v, total) {
    if (npoints === 0) return;
    if (npoints === 2) { makeColorRamp(out, 0, h[0], s[0], v[0], h[1], s[1], v[1], total, true); return; }
    if (npoints >= 50) npoints = 49;
    const DH = [], edge = [], ratio = [], nc = [], dh = [], ds = [], dv = [];
    for (let i = 0; i < npoints; i++) {
      const j = (i + 1) % npoints;
      let d = (h[i] - h[j]) / 360;
      if (d < 0) d = -d;
      if (d > 0.5) d = 0.5 - (d - 0.5);
      DH[i] = d;
    }
    let circum = 0;
    for (let i = 0; i < npoints; i++) {
      const j = (i + 1) % npoints;
      edge[i] = Math.sqrt(DH[i] * DH[j] + (s[j] - s[i]) * (s[j] - s[i]) + (v[j] - v[i]) * (v[j] - v[i]));
      circum += edge[i];
    }
    if (circum < 0.0001) { for (let i = 0; i < total; i++) out[i] = hsvToRgb(h[0], s[0], v[0]); return; }
    for (let i = 0; i < npoints; i++) ratio[i] = edge[i] / circum;
    for (let i = 0; i < npoints; i++) nc[i] = T(total * ratio[i]);
    for (let i = 0; i < npoints; i++) {
      const j = (i + 1) % npoints;
      if (nc[i] > 0) { dh[i] = 360 * (DH[i] / nc[i]); ds[i] = (s[j] - s[i]) / nc[i]; dv[i] = (v[j] - v[i]) / nc[i]; }
      else { dh[i] = 0; ds[i] = 0; dv[i] = 0; }
    }
    let k = 0;
    for (let i = 0; i < npoints; i++) {
      const dist = h[(i + 1) % npoints] - h[i];
      let direction = (dist >= 0 ? -1 : 1);
      if (dist <= 180 && dist >= -180) direction = -direction;
      for (let j = 0; j < nc[i]; j++, k++) {
        let hh = h[i] + j * dh[i] * direction;
        if (hh < 0) hh += 360;
        out[k] = hsvToRgb(T(hh), s[i] + j * ds[i], v[i] + j * dv[i]);
      }
    }
    if (k < total) { if (k <= 0) return; for (let i = k; i < total; i++) out[i] = out[i - 1]; }
  }

  function makeColorLoop(out, h0, s0, v0, h1, s1, v1, h2, s2, v2, total) {
    makeColorPath(out, 3, [h0, h1, h2], [s0, s1, s2], [v0, v1, v2], total);
  }

  function makeSmoothColormap(out, total) {
    let npoints;
    const n = irand(20);
    if (n <= 5) npoints = 2; else if (n <= 15) npoints = 3; else if (n <= 18) npoints = 4; else npoints = 5;
    const h = [], s = [], v = [];
    let loop = 0;
    for (;;) {
      let total_s = 0, total_v = 0;
      let restart = false;
      for (let i = 0; i < npoints; i++) {
        for (;;) {
          if (++loop > 10000) break;
          h[i] = irand(360); s[i] = Math.random(); v[i] = Math.random() * 0.8 + 0.2;
          if (i > 0) {
            const j = (i + 1 === npoints) ? 0 : (i - 1);
            const hi = h[i] / 360, hj = h[j] / 360;
            let dh = hj - hi; if (dh < 0) dh = -dh; if (dh > 0.5) dh = 0.5 - (dh - 0.5);
            const distance = Math.sqrt(dh * dh + (s[j] - s[i]) * (s[j] - s[i]) + (v[j] - v[i]) * (v[j] - v[i]));
            if (distance < 0.2) continue;
          }
          break;
        }
        total_s += s[i]; total_v += v[i];
      }
      if (total_s / npoints < 0.2) restart = true;
      if (total_v / npoints < 0.3) restart = true;
      if (!restart || loop > 10000) break;
    }
    makeColorPath(out, npoints, h, s, v, total);
  }

  function makeUniformColormap(out, total) {
    const Sv = (irand(34) + 66) / 100.0, Vv = (irand(34) + 66) / 100.0;
    makeColorRamp(out, 0, 0, Sv, Vv, 359, Sv, Vv, total, false);
  }

  function makeRandomColormap(out, total) {
    // abstractile calls make_random_colormap with bright_p = False (random rgb).
    for (;;) {
      for (let i = 0; i < total; i++)
        out[i] = { r: irand(0xFFFF), g: irand(0xFFFF), b: irand(0xFFFF) };
      if (total <= 4) {
        const a = rgbToHsv(out[0].r, out[0].g, out[0].b);
        const b = rgbToHsv(out[1].r, out[1].g, out[1].b);
        if (Math.abs(b.v - a.v) < 0.5) continue;
      }
      break;
    }
  }

  const css = (c) => 'rgb(' + (c.r >> 8) + ',' + (c.g >> 8) + ',' + (c.b >> 8) + ')';

  // ===================================================================
  //  _init_colors -- pick this screen's palette (ncolors bases x shades)
  // ===================================================================
  function initColors() {
    const crgb = [];
    if (d3d) {
      shades = (d3d === D3D_TILED) ? 5 : T(lwid / 2) + 1;
      ncolors = 4 + irand(4);
      const bc = basecol.map((row) => row.slice());     // local copy; tinting mutates it
      if (cmap > 0) {
        for (let c1 = 0; c1 < BASECOLORS; c1++)
          for (let c2 = 0; c2 < 2; c2++) {              // only r,g channels (c2<2), as in the C
            if (!bc[c1][c2]) bc[c1][c2] += irand(16000);
            else if (bc[c1][c2] === 0xFFFF) bc[c1][c2] -= irand(16000);
            else { bc[c1][c2] -= 8000; bc[c1][c2] += irand(16000); }
          }
      }
      const col = [];
      switch (cmap % 4) {
        case 0: for (let c1 = 0; c1 < ncolors; c1++) col[c1] = irand(BASECOLORS); break;
        case 1: for (let c1 = 0; c1 < ncolors; c1++) col[c1] = irand(15); break;
        case 2:
          col[0] = irand(15);
          for (let c1 = 1; c1 < ncolors; c1++) col[c1] = (col[c1 - 1] + 1 + irand(2)) % 15;
          break;
        case 3:
          col[0] = irand(15 - ncolors);
          for (let c1 = 1; c1 < ncolors; c1++) col[c1] = col[c1 - 1] + 1;
          break;
      }
      const tmp = [];
      for (let b = 0; b < ncolors; b++) {               // band b = ramp basecolour -> white
        makeColorRampRGB(tmp, 0, bc[col[b]][0], bc[col[b]][1], bc[col[b]][2], 0xFFFF, 0xFFFF, 0xFFFF, shades);
        for (let s = 0; s < shades; s++) crgb[b * shades + s] = tmp[s];
      }
    } else {
      // not 3d -- one shade per base colour
      shades = 1;
      let r1, g1, b1, r2, g2, b2, r3, g3, b3;
      if (cmap % 2) {                                    // base colours
        let c1, c2, c3;
        if (irand(3)) {
          c1 = irand(15); c2 = (c1 + 3 + irand(5)) % 15; c3 = (c2 + 3 + irand(5)) % 15;
        } else {
          c1 = irand(BASECOLORS); c2 = (c1 + 5 + irand(10)) % BASECOLORS; c3 = (c2 + 5 + irand(10)) % BASECOLORS;
        }
        r1 = basecol[c1][0]; g1 = basecol[c1][1]; b1 = basecol[c1][2];
        r2 = basecol[c2][0]; g2 = basecol[c2][1]; b2 = basecol[c2][2];
        r3 = basecol[c3][0]; g3 = basecol[c3][1]; b3 = basecol[c3][2];
      } else {                                           // random rgb's
        r1 = irand(65535); g1 = irand(65535); b1 = irand(65535);
        r2 = (r1 + 16384 + irand(32768)) % 65535; g2 = (g1 + 16384 + irand(32768)) % 65535; b2 = (b1 + 16384 + irand(32768)) % 65535;
        r3 = (r2 + 16384 + irand(32768)) % 65535; g3 = (g2 + 16384 + irand(32768)) % 65535; b3 = (b2 + 16384 + irand(32768)) % 65535;
      }
      switch (cmap) {
        case 0: case 1: case 2: case 3:                  // make_color_ramp color->color / color->white
          ncolors = 5 + irand(5);
          if (cmap > 1) { r2 = 0xFFFF; g2 = 0xFFFF; b2 = 0xFFFF; }
          makeColorRampRGB(crgb, 0, r1, g1, b1, r2, g2, b2, ncolors);
          break;
        case 4: case 5: case 6: case 7: {                // 3 colour make_color_loop
          ncolors = 8 + irand(12);
          const a = rgbToHsv(r1, g1, b1), b = rgbToHsv(r2, g2, b2), c = rgbToHsv(r3, g3, b3);
          makeColorLoop(crgb, a.h, a.s, a.v, b.h, b.s, b.v, c.h, c.s, c.v, ncolors);
          break;
        }
        case 8: case 9:                                  // random smooth
          ncolors = irand(4) * 6 + 12;
          makeSmoothColormap(crgb, ncolors);
          break;
        case 10:                                         // rainbow
          ncolors = irand(4) * 6 + 12;
          makeUniformColormap(crgb, ncolors);
          break;
        case 11: case 12: case 13: case 14: {            // dark to light blend
          const t1 = [], t2 = [], t3 = [];
          makeColorRampRGB(t1, 0, r1, g1, b1, 0xFFFF, 0xFFFF, 0xFFFF, 7);
          makeColorRampRGB(t2, 0, r2, g2, b2, 0xFFFF, 0xFFFF, 0xFFFF, 7);
          if (cmap < 13) {
            for (let c1 = 0; c1 <= 4; c1++) { crgb[c1 * 2] = t1[c1]; crgb[c1 * 2 + 1] = t2[c1]; }
            ncolors = 10;
          } else {
            makeColorRampRGB(t3, 0, r3, g3, b3, 0xFFFF, 0xFFFF, 0xFFFF, 7);
            for (let c1 = 0; c1 <= 4; c1++) { crgb[c1 * 3] = t1[c1]; crgb[c1 * 3 + 1] = t2[c1]; crgb[c1 * 3 + 2] = t3[c1]; }
            ncolors = 15;
          }
          break;
        }
        default:                                         // random
          ncolors = irand(4) * 6 + 12;
          makeRandomColormap(crgb, ncolors);
          break;
      }
    }

    // random colour order for the "by color" draw maps. (The C skips this for d3d
    // screens; we always set it so the draw order never collapses -- harmless.)
    for (let c1 = 0; c1 < MAXCOLORS; c1++) rco[c1] = c1;
    for (let c1 = 0; c1 < MAXCOLORS; c1++) {
      const c3 = irand(MAXCOLORS), c2 = rco[c1];
      rco[c1] = rco[c3]; rco[c3] = c2;
    }

    const count = d3d ? ncolors * shades : ncolors;
    colors = new Array(count);
    for (let i = 0; i < count; i++) colors[i] = css(crgb[i] || { r: 0, g: 0, b: 0 });
  }

  // ===================================================================
  //  math helpers used by the pattern/shape/draw-map tables (verbatim)
  // ===================================================================

  function dist_(x1, x2, y1, y2, s) {
    const xd = x1 - x2, yd = y1 - y2;
    switch (s) {
      case 0: return T(Math.sqrt(xd * xd + yd * yd));
      case 1: return T(Math.sqrt(xd * xd * cs1[0] * 2 + yd * yd));
      case 2: return T(Math.sqrt(xd * xd + yd * yd * cs2[0] * 2));
      default: return T(Math.sqrt(xd * xd * cs1[0] / cs2[0] + yd * yd * cs3[0] / cs4[0]));
    }
  }

  function wave_(x, h, l, w) {
    l += 1;
    switch (w) {
      case 0: return T(Math.cos(x * Math.PI / l) * h);
      case 1: case 2: return T(Math.cos(x * Math.PI / l) * h) + T(Math.sin(x * Math.PI / l / cs1[1]) * h);
      case 3: return T(Math.abs((x % (l * 2)) - l) * h / l);
      case 4: return T(Math.abs((x % (l * 4)) - l * 2) * h * 3 / l);
      case 5: return T((x % l) * h / l);
      default: return 0;
    }
  }

  function triangle_(x, y, rx, ry, t) {
    switch (t) {
      case 1: return _min(_min(x + y + rx - T(gridx / 2), gridx - x + y), T((gridy - y + T(ry / 2)) * 3 / 2));
      case 2: return _min(_min(x - rx, y - ry), T((rx + ry - x - y) * 2 / 3));
      case 3: return _min(_min(gridx - x - rx, y - ry), T((rx + ry - gridx + x - y) * 2 / 3));
      case 4: return _min(_min(x - rx, gridy - y - ry), T((rx + ry - x - gridy + y) * 2 / 3));
    }
    return _min(_min(gridx - x - rx, gridy - y - ry), T((rx + ry - gridx + x - gridy + y) * 2 / 3));
  }

  // ===================================================================
  //  _getdeo -- draw/erase order key for one cell (40 maps, verbatim)
  //  `de` is 1 for draw (uses dmap, layer index 1), 0 for erase (emap, layer 0).
  // ===================================================================
  function hv_(x, y, d1, d2, pn, de, line) {
    let v1, v2;
    switch (d1) {
      case 0: v1 = de ? egridx - x : gridx - x; break;
      case 1: v1 = y; break;
      case 2: v1 = x; break;
      default: v1 = de ? egridy - y : gridy - y; break;
    }
    switch (d2) {
      case 0: v2 = de ? egridx - x : gridx - x; break;
      case 1: v2 = y; break;
      case 2: v2 = x; break;
      default: v2 = de ? egridy - y : gridy - y; break;
    }
    return line.hv ? (v1 + 10000) * pn : (v2 + 10000) * -pn;
  }

  function getdeo(x, y, map, de, line) {
    switch (map) {
      case 0: return x;
      case 1: return y;
      case 2: return _min(x, gridx - x) + 1;
      case 3: return _min(y, gridy - y) + 1;
      case 4: return _max(Math.abs(x - rx3[de]), Math.abs(y - ry3[de])) + 1;
      case 5: return _min(_max(Math.abs(x - T(rx3[de] / 2)), Math.abs(y - ry3[de])), _max(Math.abs(x - (gridx - T(rx2[de] / 2))), Math.abs(y - ry2[de]))) + 1;
      case 6: return _max(Math.abs(x - rx3[de]), Math.abs(y - ry3[de]) * cs1[de]) + 1;
      case 7: return _max(Math.abs(x - rx3[de]) * cs1[de], Math.abs(y - ry3[de])) + 1;
      case 8: return _min(Math.abs(x - rx3[de]), Math.abs(y - ry3[de])) + 1;
      case 9: return (T(x * 3 / 4) + y) + 1;
      case 10: return (T(x * 3 / 4) + gridy - y) + 1;
      case 11: return T((Math.abs(x - rx3[de]) + Math.abs(y - ry3[de])) / 2) + 1;
      case 12: return T(_min(Math.abs(x - T(rx3[de] / 2)) + Math.abs(y - ry3[de]), Math.abs(x - (gridx - T(rx2[de] / 2))) + Math.abs(y - ry2[de])) / 2) + 1;
      case 13: return dist_(x, rx3[de], y, ry3[de], 0) + 1;
      case 14: return dist_(x, rx3[de], y, ry3[de], 1) + 1;
      case 15: return dist_(x, rx3[de], y, ry3[de], 2) + 1;
      case 16: return _min(dist_(x, T(rx3[de] / 2), y, ry3[de], 0), dist_(x, gridx - T(rx2[de] / 2), y, ry2[de], 0)) + 1;
      case 17: return x + wave_(gridy + y, csw[0] * cs1[0], csw[0] * cs2[0], wave[de]);
      case 18: return y + wave_(gridx + x, csw[0] * cs1[0], csw[0] * cs2[0], wave[de]);
      case 19: return x + wave_(gridy + y + (T(x / 5) * edir), csw[de] * cs1[de], csw[de] * cs2[de], wave[de]) + 1;
      case 20: return y + wave_(gridx + x + (T(y / 5) * edir), csw[de] * cs1[de], csw[de] * cs2[de], wave[de]) + 1;
      case 21: return hv_(x, y, cs1[0] % 2, cs2[0] % 2, 1, de, line);
      case 22: return hv_(x, y, cs1[0] % 2, cs2[0] % 2, -1, de, line);
      case 23: return line.len * 1000 + irand(5000);
      case 24: case 25: case 26: case 27: return line.obj * 100;
      default: {                                         // by color
        let cr = line.color;
        if (map < 34) cr = rco[cr];
        if ((map % 6 < 4) || de) { cr = cr * 1000 + irand(1000); }
        else if (map % 6 === 4) { cr = cr * gridx + (x + irand(T(gridx / 2))); }
        else { cr = cr * gridy + (y + irand(T(gridy / 2))); }
        return cr;
      }
    }
  }

  // ===================================================================
  //  _shape (18 shapes) and _pattern (40 patterns), verbatim
  // ===================================================================
  function shape_(x, y, rx, ry, n) {
    switch (shape[n]) {
      case 0: case 1: case 2:
        return 1 + _max(T(Math.abs(x - rx) * cs1[n] / cs2[n]), T(Math.abs(y - ry) * cs3[n] / cs4[n]));
      case 3: case 4:
        return 1 + (T(Math.abs(x - rx) * cs1[n] / cs2[n]) + T(Math.abs(y - ry) * cs3[n] / cs4[n]));
      case 5:
        return 1 + _min(T(_max(Math.abs(x - rx), Math.abs(y - ry)) * 3 / 2), Math.abs(x - rx) + Math.abs(y - ry));
      case 6: case 7: case 8:
        return 1 + dist_(x, rx, y, ry, cs1[n]);
      case 9:
        return 1 + T(gridx * gridy / (1 + dist_(x, rx, y, ry, cs2[n])));
      case 10:
        return 1 + _min(T(Math.abs(x - rx) * gridx / (Math.abs(y - ry) + 1)), T(Math.abs(y - ry) * gridx / (Math.abs(x - rx) + 1)));
      case 11:
        return 1 + T(dist_(x, rx, y, ry, cs1[n]) * dist_(x, (rx * 3) % gridx, y, (ry * 5) % gridy, cs1[n]) / (1 + dist_(x, (rx * 4) % gridx, y, (ry * 7) % gridy, cs1[n])));
      case 12:
        return 1 + T(Math.sqrt(Math.abs((x - rx) * (y - ry))));
      case 13:
        return 1 + dist_(x, rx, y, ry, 0) + dist_(x, gridx - rx, y, gridy - ry, 0);
      default:
        return 1 + triangle_(x, y, rx, ry, cs4[n]);
    }
  }

  function pattern_(x, y, n) {
    let v = 0; const ox = x;
    switch (wsx[n]) {
      case 0: x += T(y / (1 + cs4[n])); break;
      case 1: x += T((gridy - y) / (1 + cs4[n])); break;
      case 2: x += wave_(y, T(gridx / (1 + cs1[n])), gridy, 0); break;
      case 3: x += wave_(gridy - y, T(gridx / (1 + cs1[n])), gridy, 0); break;
      case 4: x += wave_(y, T(cs1[n] * csw[n] / 2), T(gridy * 2 / Math.PI), 0); break;
      case 5: x -= wave_(y, T(cs1[n] * csw[n] / 2), T(gridy * 2 / Math.PI), 0); break;
    }
    switch (wsy[0]) {
      case 0: y += T(ox / (1 + cs1[n])); break;
      case 1: y += T((gridx - ox) / (1 + cs1[n])); break;
      case 2: y += wave_(ox, T(gridx / (1 + cs1[n])), gridx, 0); break;
      case 3: y += wave_(gridx - ox, T(gridx / (1 + cs1[n])), gridx, 0); break;
      case 4: y += wave_(ox, T(cs1[n] * csw[n] / 2), T(gridy * 2 / Math.PI), 0); break;
      case 5: y -= wave_(ox, T(cs1[n] * csw[n] / 2), T(gridy * 2 / Math.PI), 0); break;
    }
    const csw2 = T(csw[n] / 2), csw3 = T(csw[n] / 3);
    switch (pattern[n]) {
      case 0: v = y; break;                                              // horizontal stripes
      case 1: v = x; break;                                              // vertical stripes
      case 2: v = x + T(y * cs1[n] / cs2[n]); break;                     // diagonal stripes
      case 3: v = x - T(y * cs1[n] / cs2[n]); break;                     // reverse diagonal stripes
      case 4: v = (T(y / csw[n]) * 3 + T(x / csw[n])) * csw[n]; break;   // checkerboard
      case 5: v = (T(T((x + y) / 2) / csw[n]) + T(T((x + gridy - y) / 2) / csw[n]) * 3) * csw[n]; break;  // diagonal checkerboard
      case 6: v = gridx + (_min(Math.abs(x - rx3[n]), Math.abs(y - ry3[n])) * 2); break;                  // + cross
      case 7: v = _min(_min(Math.abs(x - rx2[n]), Math.abs(y - ry2[n])), _min(Math.abs(x - rx1[n]), Math.abs(y - ry1[n]))) * 2; break;  // double + cross
      case 8: v = gridx + (_min(T(Math.abs(x - rx3[n]) * cs1[n] / cs2[n]) + T(Math.abs(y - ry2[n]) * cs3[n] / cs4[n]), T(Math.abs(x - rx3[n]) * cs1[n] / cs2[n]) - T(Math.abs(y - ry3[n]) * cs3[n] / cs4[n])) * 2); break;  // X cross
      case 9: v = _min(_min(Math.abs(x - rx2[n]) + Math.abs(y - ry2[n]), Math.abs(x - rx2[n]) - Math.abs(y - ry2[n])), _min(Math.abs(x - rx1[n]) + Math.abs(y - ry1[n]), Math.abs(x - rx1[n]) - Math.abs(y - ry1[n]))) * 2; break;  // double X cross
      case 10: v = gridy + (y + wave_(x, waveh[n], wavel[n], wave[n])); break;            // horizontal stripes/waves
      case 11: v = gridx + (x + wave_(y, waveh[n], wavel[n], wave[n])); break;            // vertical stripes/waves
      case 12: v = gridx + (x + T(y * cs1[n] / cs2[n]) + wave_(x, waveh[n], wavel[n], wave[n])); break;   // diagonal stripes/waves
      case 13: v = gridx + (x - T(y * cs1[n] / cs2[n]) + wave_(y, waveh[n], wavel[n], wave[n])); break;   // diagonal stripes/waves
      case 14: v = y + T(csw[n] * cs4[n] / cs3[n]) + wave_(x + (T(y / cs3[n]) * edir), T(csw2 * cs1[n] / cs2[n]), T(csw2 * cs2[n] / cs1[n]), wave[n]); break;  // horizontal spikey waves
      case 15: v = x + T(csw[n] * cs1[n] / cs2[n]) + wave_(y + (T(x / cs3[n]) * edir), T(csw2 * cs1[n] / cs2[n]), T(csw2 * cs3[n] / cs4[n]), wave[n]); break;  // vertical spikey waves
      case 16: v = gridy - y - T(x * cs1[n] / cs3[n]) + (csw[n] * cs1[n] * cs2[n]) + wave_(x, csw3 * cs1[n] * cs2[n], csw3 * cs3[n] * cs2[n], wave[n]); break;  // big slanted hwaves
      case 17: v = x - T(y * cs1[n] / cs3[n]) + (csw[n] * cs1[n] * cs2[n]) + wave_(y, csw3 * cs1[n] * cs2[n], csw3 * cs3[n] * cs2[n], wave[n]); break;          // big slanted vwaves
      case 18: v = y + (y + csw[n] * cs3[n]) + wave_(x, csw3 * cs3[n], csw3 * cs2[n], wave[n]) + wave_(x, csw3 * cs4[n], T(csw3 * cs1[n] * 3 / 2), wave[n]); break;  // double hwave
      case 19: v = x + (x + csw[n] * cs1[n]) + wave_(y, csw3 * cs1[n], csw3 * cs3[n], wave[n]) + wave_(y, csw3 * cs2[n], T(csw3 * cs4[n] * 3 / 2), wave[n]); break;  // double vwave
      case 20: case 21: case 22:                                         // one shape
        v = shape_(x, y, rx3[n], ry3[n], n); break;
      case 23: case 24: case 25:                                         // two shapes
        v = _min(shape_(x, y, rx1[n], ry1[n], n), shape_(x, y, rx2[n], ry2[n], n)); break;
      case 26: case 27:                                                  // two shapes opposites
        v = _min(shape_(x, y, rx2[n], ry2[n], n), shape_(x, y, gridx - rx2[n], gridy - rx2[n], n)); break;
      case 28: case 29:                                                  // two shape checkerboard
        v = (T(shape_(x, y, rx1[n], ry1[n], n) / csw[n]) + T(shape_(x, y, rx2[n], ry2[n], n) / csw[n])) * csw[n]; break;
      case 30: case 31:                                                  // two shape blob
        v = T((shape_(x, y, rx1[n], ry1[n], n) + shape_(x, y, rx2[n], ry2[n], n)) / 2); break;
      case 32: case 33:                                                  // inverted two shape blob
        v = T((shape_(x, y, rx1[n], ry1[n], n) + shape_(gridx - x, gridy - y, rx1[n], ry1[n], n)) / 2); break;
      case 34: case 35:                                                  // three shapes
        v = _min(shape_(x, y, rx3[n], ry3[n], n), _min(shape_(x, y, rx1[n], ry1[n], n), shape_(x, y, rx2[n], ry2[n], n))); break;
      case 36: case 37:                                                  // three shape blob
        v = T((shape_(x, y, rx1[n], ry1[n], n) + shape_(x, y, rx2[n], ry2[n], n) + shape_(x, y, rx3[n], ry3[n], n)) / 3); break;
      case 38:                                                           // 4 shapes (C comma op -> second _min only)
        v = _min(shape_(x, y, gridx - rx2[n], ry2[n], n), shape_(x, y, rx2[n], gridy - ry2[n], n)); break;
      case 39:                                                           // four rainbows (C comma op -> second _min only)
        v = _min(shape_(x, y, T(rx2[n] / 2), gridy - csw[n], n), shape_(x, y, gridx - csw[n], gridy - T(ry2[n] / 2), n)); break;
    }
    switch (sec[n]) {                                    // stretch or contract stripe
      case 0: v = T(Math.sqrt(T(Math.sqrt(Math.abs(v) * gridx)) * gridx)); break;
      case 1: v = T(Math.pow(v, 2) / gridx); break;
    }
    return Math.abs(v);
  }

  // _getcolor -- mix the layers into one colour index
  function getcolor(x, y) {
    const cv = new Array(LAYERS);
    cv[0] = 0;
    for (let n = 0; n < layers; n++) {
      cv[n] = pattern_(x, y, n);
      cv[0] = (!n) ? T(cv[0] / csw[0]) :
        (mix[n] < 5) ? T((cv[0] * csw[0] + cv[n]) / csw[n]) :
        (mix[n] < 12) ? cv[0] + T(T(cv[n] / csw[n]) * ncolors / 2) :
        (mix[n] < 16) ? cv[0] + T(cv[n] / csw[n]) :
        (mix[n] < 18) ? cv[0] - T(cv[n] / csw[n]) :
        (mix[n] === 18) ? T((cv[0] * x + T(cv[n] * (gridx - x) / csw[n])) / gridx) :
        T((cv[0] * y + T(cv[n] * (gridy - y) / csw[n])) / gridy);
    }
    return cv[0];
  }

  // ===================================================================
  //  grid build (zlist, findopen, fillgrid, newline, create)
  // ===================================================================
  function ensureGrid(n) {
    if (gridCap >= n) return;
    gridCap = n;
    gLine = new Int32Array(n); gHl = new Int32Array(n); gHr = new Int32Array(n);
    gVu = new Int32Array(n); gVd = new Int32Array(n);
    gDhl = new Int32Array(n); gDhr = new Int32Array(n);
    gDvu = new Int32Array(n); gDvd = new Int32Array(n);
    zlist = new Int32Array(n);
  }

  function initZlist() {
    gridx = T(cw / lwid);
    gridy = T(ch / lwid);
    if (gridx <= 0) gridx = 1;
    if (gridy <= 0) gridy = 1;
    gridn = gridx * gridy;
    ensureGrid(gridn);
    gLine.fill(0, 0, gridn); gHl.fill(0, 0, gridn); gHr.fill(0, 0, gridn);
    gVu.fill(0, 0, gridn); gVd.fill(0, 0, gridn);
    gDhl.fill(0, 0, gridn); gDhr.fill(0, 0, gridn);
    gDvu.fill(0, 0, gridn); gDvd.fill(0, 0, gridn);
    for (let z = 0; z < gridn; z++) zlist[z] = z;
    for (let z = 0; z < gridn; z++) {                    // shuffle so empty cells get hit last
      const y = irand(gridn), tmp = zlist[y];
      zlist[y] = zlist[z]; zlist[z] = tmp;
    }
  }

  // return value = line direction; sets olen (open space to blocker) and
  // bln (blocking line number, or -1 = edge).
  function findopen(x, y, z) {
    const od = []; let no = 0;
    if ((gHl[z] || gHr[z]) && (gVu[z] || gVd[z])) return DIR_NONE;
    if (z > gridx && !gHl[z] && !gHr[z] && !gLine[z - gridx]) od[no++] = DIR_UP;
    if (z < gridn - gridx && !gHl[z] && !gHr[z] && !gLine[z + gridx]) od[no++] = DIR_DOWN;
    if (x && !gHl[z] && !gHr[z] && !gLine[z - 1]) od[no++] = DIR_LEFT;
    if ((z + 1) % gridx && !gHl[z] && !gHr[z] && !gLine[z + 1]) od[no++] = DIR_RIGHT;
    if (!no) return DIR_NONE;
    const dir = od[irand(no)];
    olen = 0; bln = 0;
    while (olen <= maxlen && !bln) {
      olen++;
      if (dir === DIR_UP) bln = (y - olen < 0) ? -1 : gLine[z - olen * gridx];
      if (dir === DIR_DOWN) bln = (y + olen >= gridy) ? -1 : gLine[z + olen * gridx];
      if (dir === DIR_LEFT) bln = (x - olen < 0) ? -1 : gLine[z - olen];
      if (dir === DIR_RIGHT) bln = (x + olen >= gridx) ? -1 : gLine[z + olen];
    }
    olen--;
    return dir;
  }

  function fillgrid() {
    const L = dline[li];
    let gridc = gridx * L.y + L.x;
    const add = L.hv ? 1 : gridx;
    for (let n = 0; n <= L.len; n++) {
      if (n) gridc += add;
      if (gridc < 0 || gridc >= gridn) continue;
      if (!gLine[gridc]) { fi++; gLine[gridc] = li; }
      if (L.hv) { if (n) gHr[gridc] = li; if (n < L.len) gHl[gridc] = li; }
      else { if (n) gVd[gridc] = li; if (n < L.len) gVu[gridc] = li; }
      if (fi >= gridn) { grid_full = true; return; }
    }
  }

  function newline() {
    let bl = 0, bz, dir, lt, x, y, z;
    z = zlist[zi]; x = z % gridx; y = T(z / gridx); zi++;
    dir = findopen(x, y, z);

    if (!gLine[z]) {
      if (dir === DIR_NONE) {
        lt = LINE_FORCE;
        let guard = 0;
        while ((dir === DIR_NONE) ||
               (dir === DIR_UP && !y) ||
               (dir === DIR_DOWN && y + 1 === gridy) ||
               (dir === DIR_LEFT && !x) ||
               (dir === DIR_RIGHT && x + 1 === gridx)) {
          dir = irand(4);                                // C: random()%4 (0..3, never DIR_RIGHT) -- faithful quirk
          if (++guard > 64) return;                      // safety: surrounded 1xN grid -> skip cell
        }
        bz = (dir === DIR_UP) ? z - gridx : (dir === DIR_DOWN) ? z + gridx : (dir === DIR_LEFT) ? z - 1 : z + 1;
        bl = gLine[bz];
      } else if (bnratio > 1 && bln > 0 && olen < maxlen && irand(bnratio)) {
        lt = LINE_BRIN; bl = bln;                         // branch into blocking line
      } else {
        lt = LINE_NEW; oi++;                              // new line + new object
      }
    } else {
      if (dir === DIR_NONE) return;                       // filled, nothing open -> skip
      lt = LINE_BROUT; bl = gLine[z];                     // branch out of this line
    }

    const L = makeSentinel();
    L.deo = 0;
    dline.push(L); li = dline.length - 1;
    L.len = (lt === LINE_FORCE) ? 1 : (lt === LINE_BRIN) ? olen + 1 : (!forcemax) ? olen : 1 + irand(olen);
    L.x = x; if (dir === DIR_LEFT) L.x -= L.len;
    L.y = y; if (dir === DIR_UP) L.y -= L.len;
    L.hv = (dir === DIR_LEFT || dir === DIR_RIGHT);
    L.obj = (lt === LINE_NEW) ? oi : dline[bl].obj;
    if (lt === LINE_NEW) {
      let color = getcolor(x, y) % ncolors;
      if (color < 0) color += ncolors;
      L.color = color;
    } else {
      L.color = dline[bl].color;
    }
    L.deo = (getdeo(x, y, dmap, 1, L) + irand(dvar) + irand(dvar)) * ddir;
    L.ndol = 0;
    fillgrid();
  }

  function createScreen() {
    while (!grid_full && zi < gridn) newline();
    dline.sort((a, b) => a.deo - b.deo);                 // qsort by draw order; sentinel stays first
    li = dline.length - 1;
    lpu = dialog ? T(li / 50) : T(li / 200);
    if (!lpu) lpu = 1;
    bi = 1;
    mode = MODE_ERASE;
  }

  // ===================================================================
  //  per-screen init (random screen variables), = _init_screen
  // ===================================================================
  function tileInt() {
    switch (config.tile) {
      case 'flat': return TILE_FLAT;
      case 'thin': return TILE_THIN;
      case 'outline': return TILE_OUTLINE;
      case 'block': return TILE_BLOCK;
      case 'neon': return TILE_NEON;
      case 'tiled': return TILE_TILED;
      default: return TILE_RANDOM;
    }
  }

  function initScreen() {
    if (ii) {
      // swap: the just-finished screen becomes the erase set
      eline = dline;
      eli = li; elwid = lwid; elpu = lpu; egridx = gridx; egridy = gridy;
      // build the erase order using the PREVIOUS emap/evar/edir/grid (still current here)
      for (let k = 1; k <= eli; k++)
        eline[k].deo = (getdeo(eline[k].x, eline[k].y, emap, 0, eline[k]) + irand(evar) + irand(evar)) * edir;
      eline.sort((a, b) => a.deo - b.deo);
    }
    ii++;

    di = fi = li = oi = zi = 0;
    grid_full = false;
    dline = [makeSentinel()];

    const tile = tileInt();
    lwid = (ii === 1) ? 3 : 2 + (irand(6) % 4);
    d3d = (tile === TILE_FLAT || tile === TILE_THIN || tile === TILE_OUTLINE) ? D3D_NONE :
      (tile === TILE_BLOCK) ? D3D_BLOCK :
      (tile === TILE_NEON) ? D3D_NEON :
      (tile === TILE_TILED) ? D3D_TILED :
      ((ii === 1) && (!newcols)) ? D3D_TILED : (irand(5) % 4);
    outline = (tile === TILE_OUTLINE) ? 1 :
      ((tile !== TILE_RANDOM) || irand(5)) ? 0 : 1;
    round = (d3d === D3D_NEON) ? 1 :
      ((d3d === D3D_BLOCK) || outline || irand(6)) ? 0 : 1;
    if (d3d || outline || round) lwid += 2;
    if (!d3d && !round && !outline && lwid > 3) lwid -= 2;
    if (d3d === D3D_TILED) lwid++;
    if (tile === TILE_THIN) lwid = 2;
    if (cw > 2560 || ch > 2560) lwid *= 3;                // Retina displays
    if (lwid < 2) lwid = 2;

    initZlist();

    maxlen = (lwid > 6) ? 2 + irand(4) :
      (lwid > 4) ? 2 + (irand(8) % 6) :
      (lwid > 2) ? 2 + (irand(12) % 8) : 2 + (irand(15) % 10);
    bnratio = 4 + irand(4) + irand(4);
    forcemax = irand(6) ? 0 : 1;

    if ((ii === 1) || newcols) initColors();

    dmap = (emap + 5 + irand(5)) % DRAWORDERS;            // (dead -- overwritten next line, as in the C)
    dmap = 20 + irand(20);
    dvar = (dmap > 22) ? 100 : 10 + (csw[0] * irand(5));
    ddir = irand(2) ? 1 : -1;

    emap = (dmap + 10 + irand(10)) % 20;
    evar = (emap > 22) ? 100 : 10 + (csw[0] * irand(5));
    edir = irand(2) ? 1 : -1;

    layers = irand(2) ? 2 : irand(2) ? 1 : irand(2) ? 3 : 4;
    cmap = (cmap + 5 + irand(10)) % COLORMAPS;            // rotate for the NEXT screen

    for (let xl = 0; xl < LAYERS; xl++) {
      pattern[xl] = irand(PATTERNS);
      shape[xl] = irand(SHAPES);
      mix[xl] = irand(20);
      const nstr = (lwid === 2) ? 20 + irand(12) :
        (lwid === 3) ? 16 + irand(8) :
        (lwid === 4) ? 12 + irand(6) :
        (lwid === 5) ? 10 + irand(5) :
        (lwid === 6) ? 8 + irand(4) : 5 + irand(5);
      csw[xl] = _max(5, T(gridy / nstr));
      wsx[xl] = (wsx[xl] + 3 + irand(3)) % STRETCHES;
      wsy[xl] = (wsy[xl] + 3 + irand(3)) % STRETCHES;
      sec[xl] = irand(5);
      if (!dialog && sec[xl] < 2) csw[xl] = T(csw[xl] / 2);
      cs1[xl] = dialog ? 1 + irand(3) : 2 + irand(5);
      cs2[xl] = dialog ? 1 + irand(3) : 2 + irand(5);
      cs3[xl] = dialog ? 1 + irand(3) : 2 + irand(5);
      cs4[xl] = dialog ? 1 + irand(3) : 2 + irand(5);
      wave[xl] = irand(WAVES);
      wavel[xl] = csw[xl] * (2 + irand(6));
      waveh[xl] = csw[xl] * (1 + irand(3));
      rx1[xl] = T(gridx / 10) + irand(T(gridx * 8 / 10));
      ry1[xl] = T(gridy / 10) + irand(T(gridy * 8 / 10));
      rx2[xl] = T(gridx * 2 / 10) + irand(T(gridx * 6 / 10));
      ry2[xl] = T(gridy * 2 / 10) + irand(T(gridy * 6 / 10));
      rx3[xl] = T(gridx * 3 / 10) + irand(T(gridx * 4 / 10));
      ry3[xl] = T(gridy * 3 / 10) + irand(T(gridy * 4 / 10));
    }
  }

  // ===================================================================
  //  drawing (tile fills), = _XFillRectangle / _fill_outline / _draw_tiled
  // ===================================================================
  let lpu = 1, elpu = 1;

  function fillRectSafe(x, y, w, h) {
    if (w > 0 && h > 0) ctx.fillRect(x, y, w, h);
  }

  function fillTri(color, x1, y1, x2, y2, x3, y3) {
    ctx.fillStyle = colors[clampIdx(color)];
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.closePath();
    ctx.fill();
  }

  function fillPoly4(color, x1, y1, x2, y2, x3, y3, x4, y4) {
    ctx.fillStyle = colors[clampIdx(color)];
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.lineTo(x4, y4); ctx.closePath();
    ctx.fill();
  }

  // _XFillRectangle: draw line `di`'s body (fillStyle set by caller). adj shrinks
  // the rect for neon/block shades; round draws stacked rects for rounded ends.
  function fillLineRect(diIdx, adj) {
    const L = dline[diIdx];
    let x = L.x * lwid, y = L.y * lwid, w, h;
    if (L.hv) { w = (L.len + 1) * lwid - 1; h = lwid - 1; }
    else { w = lwid - 1; h = (L.len + 1) * lwid - 1; }
    if (d3d === D3D_NEON) { x += adj; y += adj; w -= adj * 2; h -= adj * 2; }
    else if (d3d === D3D_BLOCK) { x += adj; y += adj; w -= T(lwid / 2) - 1; h -= T(lwid / 2) - 1; }
    if (!round) { fillRectSafe(x, y, w, h); return; }
    if (h < lwid) {                                       // horizontal
      const a = T((h - 1) / 2);
      for (let b = 0; b <= a; b++) fillRectSafe(x + b, y + a - b, w - b * 2, h - (a - b) * 2);
    } else {                                              // vertical
      const a = T((w - 1) / 2);
      for (let b = 0; b <= a; b++) fillRectSafe(x + a - b, y + b, w - (a - b) * 2, h - b * 2);
    }
  }

  function fillOutline(diIdx) {
    if (!diIdx) return;
    const L = dline[diIdx];
    const x = L.x * lwid + 1, y = L.y * lwid + 1;
    let w, h;
    if (L.hv) { w = (L.len + 1) * lwid - 3; h = lwid - 3; }
    else { w = lwid - 3; h = (L.len + 1) * lwid - 3; }
    ctx.fillStyle = '#000';
    fillRectSafe(x, y, w, h);
  }

  // _draw_tiled: the interlocking-tile geometry. d is a bitmask of which of the
  // four half-segments (dhl/dhr/dvu/dvd) meet at the cell; the base rects + angle
  // triangles/polygons per d-case are transcribed VERBATIM from the C table.
  function drawTiled(color) {
    const L = dline[di];
    const a = L.hv ? 1 : gridx;
    let z = L.y * gridx + L.x;
    const m1 = T((lwid - 1) / 2), m2 = T(lwid / 2), lr = lwid - 1, nl = lwid;

    for (let c = 0; c <= L.len; c++) {
      let x, y;
      if (z < 0 || z >= gridn) { z += a; continue; }
      if (L.hv) {
        x = (L.x + c) * lwid; y = L.y * lwid;
        if (c) gDhr[z] = di;
        if (c < L.len) gDhl[z] = di;
      } else {
        x = L.x * lwid; y = (L.y + c) * lwid;
        if (c) gDvd[z] = di;
        if (c < L.len) gDvu[z] = di;
      }
      let d = 0;
      if (gDhl[z]) d += 8;
      if (gDhr[z]) d += 4;
      if (gDvu[z]) d += 2;
      if (gDvd[z]) d += 1;

      // draw line base
      switch (d) {
        case 1: case 2: case 3: case 5: case 6: case 7: case 11: case 15: {
          const hh = (d === 1 || d === 5) ? lr : nl;      // vertical
          ctx.fillStyle = colors[clampIdx(color)]; fillRectSafe(x, y, m2, hh);
          ctx.fillStyle = colors[clampIdx(color + 3)]; fillRectSafe(x + m2, y, m1, hh);
          break;
        }
        case 4: case 8: case 9: case 10: case 12: case 13: case 14: {
          const ww = (d === 4) ? lr : nl;                 // horizontal
          ctx.fillStyle = colors[clampIdx(color + 1)]; fillRectSafe(x, y, ww, m2);
          ctx.fillStyle = colors[clampIdx(color + 2)]; fillRectSafe(x, y + m2, ww, m1);
          break;
        }
      }
      // draw angles
      switch (d) {
        case 1: fillTri(color + 2, x, y + lr, x + lr, y + lr, x + m2, y + m2); break;                 // bottom end ^
        case 2: fillTri(color + 1, x, y, x + lr, y, x + m2, y + m2); break;                            // top end \/
        case 4: fillTri(color + 3, x + lr, y, x + lr, y + lr, x + m2, y + m2); break;                  // right end <
        case 5:                                                                                       // LR corner
          fillTri(color + 1, x, y + m2, x + m2, y + m2, x, y);
          fillPoly4(color + 2, x, y + m2, x + m2, y + m2, x + lr, y + lr, x, y + lr);
          break;
        case 6:                                                                                       // UR corner
          fillPoly4(color + 1, x, y + m2, x + m2, y + m2, x + lr, y, x, y);
          fillTri(color + 2, x, y + m2, x + m2, y + m2, x, y + lr);
          break;
        case 7:                                                                                       // T > into line
          fillTri(color + 1, x, y + m2, x + m2, y + m2, x, y);
          fillTri(color + 2, x, y + m2, x + m2, y + m2, x, y + lr);
          break;
        case 8: fillTri(color, x, y, x, y + lr, x + m2, y + m2); break;                                // left end >
        case 9:                                                                                       // LL corner
          fillPoly4(color, x + m2, y, x + m2, y + m2, x, y + lr, x, y);
          fillTri(color + 3, x + m2, y, x + m2, y + m2, x + lr, y);
          break;
        case 10:                                                                                      // UL corner
          fillPoly4(color, x + m2, y + nl, x + m2, y + m2, x, y, x, y + nl);
          fillPoly4(color + 3, x + m2, y + nl, x + m2, y + m2, x + lr, y + lr, x + lr, y + nl);
          break;
        case 11:                                                                                      // T < into line
          fillPoly4(color + 1, x + nl, y + m2, x + m2, y + m2, x + lr, y, x + nl, y);
          fillPoly4(color + 2, x + nl, y + m2, x + m2, y + m2, x + lr, y + lr, x + nl, y + lr);
          break;
        case 13:                                                                                      // T \/ into line
          fillTri(color, x + m2, y, x + m2, y + m2, x, y);
          fillTri(color + 3, x + m2, y, x + m2, y + m2, x + lr, y);
          break;
        case 14:                                                                                      // T ^ into line
          fillPoly4(color, x + m2, y + nl, x + m2, y + m2, x, y + lr, x, y + nl);
          fillPoly4(color + 3, x + m2, y + nl, x + m2, y + m2, x + lr, y + lr, x + lr, y + nl);
          break;
        case 15:                                                                                      // X intersection
          fillTri(color + 1, x, y + m2, x + m2, y + m2, x, y);
          fillTri(color + 2, x, y + m2, x + m2, y + m2, x, y + lr);
          fillPoly4(color + 1, x + nl, y + m2, x + m2, y + m2, x + lr, y, x + nl, y);
          fillPoly4(color + 2, x + nl, y + m2, x + m2, y + m2, x + lr, y + lr, x + nl, y + lr);
          break;
      }
      z += a;
    }
  }

  function drawLines() {
    const top = _min(li + 1, bi + lpu);
    for (di = bi; di < top; di++) {
      const band = ((dline[di].color % ncolors) + ncolors) % ncolors;
      const color = band * shades;
      switch (d3d) {
        case D3D_NEON:
          // DEVIATION: the C re-draws every prior line of this object on each
          // shade for seamless junction glow (O(object^2)); we draw each line's
          // shades once (O(lines)) to guarantee no freeze. Minor seam at T/X joints.
          for (let sh = 0; sh < T(lwid / 2); sh++) {
            ctx.fillStyle = colors[clampIdx(color + sh)];
            fillLineRect(di, sh);
          }
          break;
        case D3D_BLOCK:
          for (let sh = 0; sh < T(lwid / 2); sh++) {
            ctx.fillStyle = colors[clampIdx(color + T(lwid / 2) - sh - 1)];
            fillLineRect(di, sh);
          }
          break;
        case D3D_TILED:
          drawTiled(color);
          break;
        default: {                                        // D3D_NONE
          ctx.fillStyle = colors[clampIdx(color)];
          fillLineRect(di, 0);
          if (outline) {
            fillOutline(di);
            let z = dline[di].y * gridx + dline[di].x;
            const a = dline[di].hv ? 1 : gridx;
            for (let n = 0; n <= dline[di].len; n++) {
              if (z >= 0 && z < gridn) {
                fillOutline(gDhl[z]); fillOutline(gDhr[z]); fillOutline(gDvu[z]); fillOutline(gDvd[z]);
                if (dline[di].hv) { if (n) gDhr[z] = di; if (n < dline[di].len) gDhl[z] = di; }
                else { if (n) gDvd[z] = di; if (n < dline[di].len) gDvu[z] = di; }
              }
              z += a;
            }
          }
          break;
        }
      }
    }
    if (di > li) { bi = 1; mode = MODE_CREATE; }
    else bi += lpu;
  }

  function eraseLines() {
    if (!ii) return;
    const top = _min(eli + 1, bi + elpu);
    ctx.fillStyle = '#000';
    for (di = bi; di < top; di++) {
      const E = eline[di];
      if (E.hv) fillRectSafe(E.x * elwid, E.y * elwid, (E.len + 1) * elwid, elwid);
      else fillRectSafe(E.x * elwid, E.y * elwid, elwid, (E.len + 1) * elwid);
      if (di === eli) ctx.fillRect(0, 0, cw, ch);         // clear just in case
    }
    if (di > eli) { bi = 1; mode = MODE_DRAW; }
    else bi += Math.max(1, elpu);
  }

  // ===================================================================
  //  state machine + timing (the C's abstractile_draw, returning a delay)
  // ===================================================================
  function buildScreen() { initScreen(); createScreen(); }

  // Per-batch delay (ms), transcribed verbatim from abstractile_draw's usleep:
  //   batch  = (5-speed)*(2-dialog)*100000 / lpu  microseconds  (draw & erase)
  //   linger = sleep*1000000                      microseconds  (after a full draw)
  // The C subtracts the work time (mse) before sleeping; the rAF accumulator loop
  // (below) already absorbs work time by tracking wall-clock, so we return the
  // target PERIOD itself. The /lpu term is what makes dense screens (small lwid ->
  // big lpu) build fast and sparse screens build slow, exactly like the live
  // binary (e.g. -tile thin races, -tile tiled is leisurely). speed 5 -> 0 ms
  // (as fast as the accumulator cap allows), matching the C's "0 second" goal.
  function batchDelayMs() {
    const sp = Math.min(5, Math.max(0, config.speed));
    const lp = lpu > 0 ? lpu : 1;
    return ((5 - sp) * (2 - dialog) * 100000 / lp) / 1000;
  }

  function step() {
    if (cw <= 20 || ch <= 20) return 100;                 // too small -- do nothing
    switch (mode) {
      case MODE_CREATE: buildScreen(); return batchDelayMs();
      case MODE_ERASE: eraseLines(); return batchDelayMs();
      case MODE_DRAW:
        drawLines();
        // after the final draw batch, drawLines() flips mode to CREATE -> linger
        return (mode === MODE_CREATE) ? Math.max(0, config.sleep * 1000) : batchDelayMs();
    }
    return batchDelayMs();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    cw = canvas.width;
    ch = canvas.height;
    dialog = (cw < 500) ? 1 : 0;
    ii = 0; mode = MODE_CREATE; bi = 1;
    li = 0; eli = 0; oi = 0; zi = 0; fi = 0; di = 0; grid_full = false;
    lwid = 3; elwid = 3; egridx = 0; egridy = 0; gridx = 0; gridy = 0; gridn = 0;
    lpu = 1; elpu = 1;
    cmap = 0; emap = 0; dmap = 0; dvar = 0; evar = 0; ddir = 1; edir = 1; layers = 2;
    d3d = D3D_NONE; round = 0; outline = 0;
    ncolors = 1; shades = 1; colors = ['#000'];
    for (let i = 0; i < LAYERS; i++) {
      pattern[i] = 0; shape[i] = 0; mix[i] = 0; csw[i] = 0; wsx[i] = 0; wsy[i] = 0; sec[i] = 0;
      cs1[i] = 1; cs2[i] = 1; cs3[i] = 1; cs4[i] = 1; wave[i] = 0; waveh[i] = 0; wavel[i] = 0;
      rx1[i] = 0; rx2[i] = 0; rx3[i] = 0; ry1[i] = 0; ry2[i] = 0; ry3[i] = 0;
    }
    for (let i = 0; i < MAXCOLORS; i++) rco[i] = i;
    dline = [makeSentinel()]; eline = [makeSentinel()];
    nextDelay = 0; acc = 0; lastTime = 0;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // Variable-delay loop: step() returns ms until the next step (the C returns
  // microseconds-until-next-call). Bound catch-up so a backgrounded tab can't
  // burst, while still letting a long linger elapse (cap = max(CATCHUP, delay)).
  const MAX_CATCHUP_STEPS = 8;
  const CATCHUP_MS = 250;
  let lastTime = 0, acc = 0, nextDelay = 0, rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    acc += now - lastTime;
    lastTime = now;
    const cap = Math.max(CATCHUP_MS, nextDelay);
    if (acc > cap) acc = cap;

    let steps = 0;
    while (acc >= nextDelay && steps < MAX_CATCHUP_STEPS) {
      acc -= nextDelay;
      nextDelay = step();
      steps++;
    }
    rafId = requestAnimationFrame(frame);
  }

  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
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
