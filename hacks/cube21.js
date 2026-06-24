// cube21.js -- "Cube 21" / "Square-1" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's cube21 (Vaclav "Vasek" Potocek, 2005),
// hacks/glx/cube21.c (derived from cage.c / gltext.c). The "Cube 21" (a.k.a.
// "Square-1") shape-shifting puzzle: a cube whose top and bottom layers are sliced
// into 30deg "narrow" (edge) and 60deg "wide" (corner) wedge pieces. A layer rotates,
// or the whole cube is cut through a vertical plane and one half flipped 180deg -- so
// the solid morphs between shapes while it spins and wanders. Moves are chosen at
// random (only rotations the puzzle geometry actually permits), separated by pauses.
//
// WHY A PER-FRAME IMMEDIATE-MODE REBUILD
//   The .c draws in OpenGL immediate mode: it walks the ring of pieces emitting
//   glVertex/glNormal/glColor/glTexCoord, advancing a glRotatef(30|60) between pieces,
//   and (during a move) wraps sub-parts in glRotatef(theta). We reproduce that exactly
//   by emulating the GL matrix stack (a single THREE.Matrix4 mutated by rotate/
//   translate/scale, manually undone like the .c) and an immediate-mode emitter
//   (glBegin/glVertex/... -> a non-indexed BufferGeometry, triangles every 3 verts,
//   quads every 4). The whole puzzle is only ~600 triangles, so we rebuild it every
//   frame -- baking ALL transforms (spin/wander/object placement AND the per-move
//   sub-rotations) into eye-space vertex positions + normals. The camera then carries
//   only the projection. This is the most direct transcription of the .c's pipeline
//   and sidesteps decomposing the intricate "half-flip" transform tree into groups.
//
// FAITHFUL TO THE .c:
//   * The puzzle model verbatim: pieces[2][13] (narrow/wide flags per side, indices
//     as-is including the [0]/[12] quirks), cind[5][12] (color indices: rows 0/1 top,
//     2/3 bottom, 4 middle band), colors[6][3]. find_matches / rot_face / rot_halves /
//     randomize(SHUFFLE=100) / finish() ported operation-for-operation, including
//     every index expression and the fall-through structure of the state machine.
//   * The five draw primitives (draw_narrow_piece, draw_wide_piece, draw_middle_piece,
//     draw_half_face, draw_middle) and draw_main's per-state glRotatef sequence,
//     transcribed vertex-for-vertex with the exact posc[] coords, texp/texq/TEX_GRAY
//     texcoords, and per-face normals.
//   * make_texture(): the 128x128 GL_LUMINANCE line-art (draw_horz/vert_line +
//     draw_slanted_horz/vert, the parabolic BORDER/BORDER2 soft edge, the 3x3 gray dot
//     at (0.7,0.7)) reproduced with the same integer arithmetic, uploaded as a
//     DataTexture (row 0 = v=0, matching glTexImage2D), CLAMP_TO_EDGE + LINEAR, no
//     mipmaps (the .c's MIPMAP path is #undef'd -- "It doesn't look good").
//   * All six color modes (parse_colmode + init_cp): white / one random / silver /
//     two random / classic (fixed ce_colors) / six random; default "six". rndcolor()
//     = frand(0.5)+0.3 (channels in [0.3,0.8), the muted palette of the screenshot).
//   * Lighting: two directional lights at eye-space (1,1,1) and (-1,-1,1), diffuse 1,
//     per-light ambient 0; global ambient 0.1; material specular 0.2, shininess 20;
//     GL_COLOR_MATERIAL so glColor drives ambient+diffuse (-> per-face vertex colors).
//     Light intensity = PI, specular /PI, ambient *PI (the repo's three-lighting
//     convention; see color notes in docs/porting-strategy.md).
//   * GL_FLAT: one normal per face -> we store that exact normal on every vertex of
//     the face (flatShading:false), which IS flat and is winding-independent.
//   * GL_MODULATE texture: three's `map` multiplies (ambient+diffuse) by the texture,
//     reproducing the black outlines. (Minor: three doesn't modulate specular; with
//     the weak 0.2 specular the outlines still read black -- see cube21.md.)
//
// Motion is per-frame in the .c; we render every rAF and scale each increment by
// frames = dt*effFps, effFps = 1e6/(delay+OVERHEAD). RNG (yarandom.js) is a faithful
// standalone port; the shuffle is random per run anyway (no deterministic reference).

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding) and the screenshots capture those raw
// values. Disable three's color management so lit/textured faces match GL exactly.
THREE.ColorManagement.enabled = false;

export const title = 'cube21';

export const info = {
  author: 'Vasek Potocek',
  year: 2005,
  description:
    'The "Cube 21" Rubik-like puzzle, also known as "Square-1". The rotations are chosen randomly.\n\n' +
    'See also the "Rubik", "RubikBlocks" and "GLSnake" screen savers.\n\n' +
    'https://en.wikipedia.org/wiki/Square_One_%28puzzle%29',
};

export function start(hostCanvas, opts = {}) {
  // ---- constants (cube21.c #defines) ----
  const SHUFFLE = 100;
  const COS15 = 0.9659258263, SIN15 = 0.2588190451, COS30 = 0.8660254038, SIN30 = 0.5;
  const TEX_WIDTH = 128, TEX_HEIGHT = 128;
  const TG = 0.7;               // TEX_GRAY texcoord (the 3x3 gray-dot block)
  const BORDER = 3, BORDER2 = 9;
  const ZPOS = -18.0;
  const DEG = Math.PI / 180;
  const PI = Math.PI;
  // The GL family's shared overhead default (live GL hacks can't be timed under this
  // machine's XQuartz Apple-DRI block, so every three.js port adopts the measured
  // 37500). xml delay 20000 -> effFps = 1e6/57500 ~= 17.4fps.
  const OVERHEAD = 37500;

  // color modes (cube21_cmode) and states (cube21_state)
  const COLOR_WHITE = 0, COLOR_RANDOM = 1, COLOR_SILVER = 2, COLOR_TWORND = 3, COLOR_CLASSIC = 4, COLOR_SIXRND = 5;
  const ST_PAUSE1 = 0, ST_ROT_TOP = 1, ST_ROT_BOTTOM = 2, ST_PAUSE2 = 3, ST_HALF1 = 4, ST_HALF2 = 5;

  // Knobs transcribed 1:1 from hacks/cube21.xml (host renders the box from `params`
  // and mutates `config` in place). `delay` is the frame-rate knob (xml id "speed",
  // arg --delay). showfps is host-level, not a hack knob (omitted, as glknots does).
  const config = {
    delay: 20000,        // us (xml default; invert slider)
    size: 0.7,           // --cubesize (object scale)
    rotspeed: 3.0,       // --rotspeed (tspeed; move + pause clock rate)
    start: 'shuffle',    // 'shuffle' (randomize) | 'cube' (--no-randomize)
    colors: 'six',       // --colormode: white|rnd|se|two|ce|six
    spinspeed: 1.0,      // --spinspeed (deg/frame added to xrot & yrot)
    wanderspeed: 0.02,   // --wanderspeed (wspeed; drift rate)
    wait: 40.0,          // --wait (twait; pause length in clock units)
    spin: true,          // --no-spin unsets
    wander: true,        // --no-wander unsets
    tex: true,           // "Outlines" texture; --no-texture unsets
    wire: false,         // --wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'size', label: 'Cube size', type: 'range', min: 0.4, max: 1.0, step: 0.05, default: 0.7, lowLabel: 'Small', highLabel: 'Large', live: true },
    { key: 'rotspeed', label: 'Rotation', type: 'range', min: 1.0, max: 10.0, step: 0.1, default: 3.0, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    {
      key: 'start', label: 'Start', type: 'select', default: 'shuffle', live: true,
      options: [
        { value: 'cube', label: 'Start as cube' },
        { value: 'shuffle', label: 'Start as random shape' },
      ],
    },
    {
      key: 'colors', label: 'Colors', type: 'select', default: 'six', live: true,
      options: [
        { value: 'white', label: 'White' },
        { value: 'rnd', label: 'Random color' },
        { value: 'se', label: 'Silver edition' },
        { value: 'two', label: 'Two random colors' },
        { value: 'ce', label: 'Classic edition' },
        { value: 'six', label: 'Six random colors' },
      ],
    },
    { key: 'spinspeed', label: 'Spin', type: 'range', min: 0.01, max: 4.0, step: 0.01, default: 1.0, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    { key: 'wanderspeed', label: 'Wander', type: 'range', min: 0.001, max: 0.1, step: 0.001, default: 0.02, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    { key: 'wait', label: 'Linger', type: 'range', min: 10.0, max: 100.0, step: 1.0, default: 40.0, lowLabel: 'Short', highLabel: 'Long', live: true },
    { key: 'spin', label: 'Spin', type: 'checkbox', default: true, live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'tex', label: 'Outlines', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);
  const rnd01 = () => rng.random() % 2;
  const rndcolor = () => rng.frand(0.5) + 0.3;

  // ---- puzzle state (cube21_conf) ----
  const cp = {
    state: ST_PAUSE1,
    xrot: -65.0, yrot: 185.0,
    posarg: 0.0,
    t: 0.0, tmax: 40.0,
    hf: [0, 0], fr: [0, 0],
    rface: 0, ramount: 0,
    pieces: [new Array(13).fill(0), new Array(13).fill(0)],
    cind: [0, 1, 2, 3, 4].map(() => new Array(12).fill(0)),
    colors: [0, 1, 2, 3, 4, 5].map(() => [0, 0, 0]),
  };
  let colmode = COLOR_SIXRND;
  let cmat = true;                 // per-face color material active?
  let colorInner = [1, 1, 1];      // color of the "inner" (between-piece) faces

  // "Some significant non-trivial coordinates of the object" (init_posc).
  const texp = (1.0 - Math.tan(PI / 12.0)) / 2.0;
  const texq = 1.0 - texp;
  const posc = [
    Math.tan(PI / 12),                 // 0.268
    1.0 / Math.cos(PI / 12),           // 1.035
    Math.cos(PI / 6) / Math.cos(PI / 12), // 0.897
    Math.sin(PI / 6) / Math.cos(PI / 12), // 0.518
    Math.SQRT2 * Math.cos(PI / 6),     // 1.225
    Math.SQRT2 * Math.sin(PI / 6),     // 0.707
  ];

  // =====================================================================
  //  texture (make_texture): 128x128 luminance line art
  // =====================================================================
  const tex = new Uint8Array(TEX_WIDTH * TEX_HEIGHT);
  const trunc = Math.trunc;
  const setLumMin = (x, y, w) => {           // texture[y][x] = min(current, w)
    if (x < 0 || x >= TEX_WIDTH || y < 0 || y >= TEX_HEIGHT) return;
    const i = y * TEX_WIDTH + x;
    if (tex[i] > w) tex[i] = w;
  };
  function drawHorzLine(x1, x2, y) {
    const y0 = y;
    let yy = (y < BORDER) ? -y : -BORDER;
    for (; yy < BORDER; yy++) {
      if (y0 + yy >= TEX_HEIGHT) break;
      const w = trunc(yy * yy * 255 / BORDER2);
      for (let x = x1; x <= x2; x++) setLumMin(x, y0 + yy, w);
    }
  }
  function drawVertLine(x, y1, y2) {
    const x0 = x;
    let xx = (x < BORDER) ? -x : -BORDER;
    for (; xx < BORDER; xx++) {
      if (x0 + xx >= TEX_WIDTH) break;
      const w = trunc(xx * xx * 255 / BORDER2);
      for (let y = y1; y <= y2; y++) setLumMin(x0 + xx, y, w);
    }
  }
  function drawSlantedHorz(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    for (let x = x1; x <= x2; x++) {
      const y0 = y1 + trunc((y2 - y1) * (x - x1) / (x2 - x1));
      for (let yy = -1 - BORDER; yy < 2 + BORDER; yy++) {
        let w = dx * (y0 + yy - y1) - dy * (x - x1);
        w = trunc(w * w / (dx * dx + dy * dy));
        w = trunc(w * 255 / BORDER2);
        setLumMin(x, y0 + yy, w);
      }
    }
  }
  function drawSlantedVert(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    for (let y = y1; y <= y2; y++) {
      const x0 = x1 + trunc((x2 - x1) * (y - y1) / (y2 - y1));
      for (let xx = -1 - BORDER; xx < 2 + BORDER; xx++) {
        let w = dy * (x0 + xx - x1) - dx * (y - y1);
        w = trunc(w * w / (dy * dy + dx * dx));
        w = trunc(w * 255 / BORDER2);
        setLumMin(x0 + xx, y, w);
      }
    }
  }
  function makeTexture() {
    tex.fill(255);
    drawHorzLine(0, TEX_WIDTH - 1, 0);
    drawHorzLine(trunc(texq * TEX_WIDTH), TEX_WIDTH - 1, trunc(texp * TEX_HEIGHT));
    drawHorzLine(trunc(texq * TEX_WIDTH), TEX_WIDTH - 1, trunc(texq * TEX_HEIGHT));
    drawHorzLine(0, trunc(texq * TEX_WIDTH), TEX_HEIGHT / 2);
    drawHorzLine(0, TEX_WIDTH - 1, trunc(TEX_HEIGHT * 3 / 4));
    drawHorzLine(0, TEX_WIDTH - 1, TEX_HEIGHT - 1);
    drawVertLine(0, 0, TEX_HEIGHT - 1);
    drawVertLine(trunc(texq * TEX_WIDTH), 0, trunc(TEX_HEIGHT * 3 / 4));
    drawVertLine(TEX_WIDTH - 1, 0, TEX_HEIGHT - 1);
    drawSlantedHorz(0, trunc(texp * TEX_HEIGHT), TEX_WIDTH / 2, TEX_HEIGHT / 2);
    drawSlantedVert(trunc(texp * TEX_WIDTH), 0, TEX_WIDTH / 2, TEX_HEIGHT / 2);
    drawSlantedVert(trunc(texq * TEX_WIDTH), 0, TEX_WIDTH / 2, TEX_HEIGHT / 2);
    const x0 = trunc(0.7 * TEX_WIDTH), y0 = trunc(0.7 * TEX_HEIGHT);
    for (let y = -1; y <= 1; y++)
      for (let x = -1; x <= 1; x++) tex[(y0 + y) * TEX_WIDTH + (x0 + x)] = 100;
  }
  makeTexture();

  // GL_LUMINANCE L -> RGBA (R=G=B=L, A=255). DataTexture uploads row 0 as v=0, exactly
  // like glTexImage2D, so no flip is needed.
  const texData = new Uint8Array(TEX_WIDTH * TEX_HEIGHT * 4);
  for (let i = 0; i < TEX_WIDTH * TEX_HEIGHT; i++) {
    const L = tex[i];
    texData[i * 4] = L; texData[i * 4 + 1] = L; texData[i * 4 + 2] = L; texData[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(texData, TEX_WIDTH, TEX_HEIGHT, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;   // raw luminance multiplier, not sRGB
  texture.needsUpdate = true;

  // =====================================================================
  //  puzzle logic (find_matches / rot_face / rot_halves / randomize / finish)
  // =====================================================================
  const _matches = new Array(13).fill(0);
  function findMatches(pieces, matches, s) {
    let j = 1;
    for (let i = 1; i < 6; i++) {
      if (pieces[s][i] && pieces[s][i + 6]) matches[j++] = i;
    }
    matches[0] = j;
    for (let i = 1; i < matches[0]; i++) matches[j++] = matches[i] - 6;
    matches[j++] = 6;
    matches[0] = j;
  }
  function rotFace(pieces, cind, s, o) {
    const tmp = new Array(12), tmpc0 = new Array(12), tmpc1 = new Array(12);
    const c0 = 2 * s, c1 = c0 + 1;
    for (let i = 0; i < 12; i++) { tmp[i] = pieces[s][i]; tmpc0[i] = cind[c0][i]; tmpc1[i] = cind[c1][i]; }
    if (o < 0) o += 12;
    for (let i = 0; i < 12; i++, o++) {
      if (o === 12) o = 0;
      pieces[s][i] = tmp[o];
      cind[c0][i] = tmpc0[o];
      cind[c1][i] = tmpc1[o];
    }
  }
  function rotHalves(pieces, cind, hf, s) {
    const ss = 6 * s;
    for (let i = 0; i < 6; i++) {
      let j = ss + i, k = ss + 6 - i, t;
      t = pieces[0][j]; pieces[0][j] = pieces[1][k]; pieces[1][k] = t;
      k--;
      t = cind[0][j]; cind[0][j] = cind[2][k]; cind[2][k] = t;
      t = cind[1][j]; cind[1][j] = cind[3][k]; cind[3][k] = t;
    }
    hf[s] ^= 1;
  }
  function randomize() {
    for (let i = 0; i < SHUFFLE; i++) {
      let s = rnd01();
      findMatches(cp.pieces, _matches, s);
      let j = _matches[0] - 1;
      j = rng.random() % j;
      j = _matches[j + 1];
      rotFace(cp.pieces, cp.cind, s, j);
      s = rnd01();
      rotHalves(cp.pieces, cp.cind, cp.hf, s);
    }
  }
  function finish() {
    let j, s;
    switch (cp.state) {
      case ST_PAUSE1:
        s = rnd01();
        findMatches(cp.pieces, _matches, s);
        j = _matches[0] - 1;
        j = rng.random() % j;
        j = _matches[j + 1];
        if (j === 6 && rnd01()) j = -6;
        cp.state = ST_ROT_TOP + s;
        cp.tmax = 30.0 * Math.abs(j);
        cp.fr[0] = cp.fr[1] = 0;
        cp.rface = s;
        cp.ramount = j;
        break;
      case ST_ROT_TOP:
      case ST_ROT_BOTTOM:
        s = cp.rface;
        rotFace(cp.pieces, cp.cind, s, cp.ramount);
        cp.fr[s] = 1;
        s ^= 1;
        if (!cp.fr[s] && rnd01()) {
          findMatches(cp.pieces, _matches, s);
          j = _matches[0] - 1;
          j = rng.random() % j;
          j = _matches[j + 1];
          if (j === 6 && rnd01()) j = -6;
          cp.state = ST_ROT_TOP + s;
          cp.tmax = 30.0 * Math.abs(j);
          cp.rface = s;
          cp.ramount = j;
        } else {
          cp.state = ST_PAUSE2;
          cp.tmax = config.wait;
        }
        break;
      case ST_PAUSE2:
        s = rnd01();
        cp.ramount = -rnd01();          // 0 or -1: only the sign matters here
        cp.state = ST_HALF1 + s;
        cp.tmax = 180.0;
        cp.rface = s;
        break;
      case ST_HALF1:
      case ST_HALF2:
        rotHalves(cp.pieces, cp.cind, cp.hf, cp.rface);
        cp.state = ST_PAUSE1;
        cp.tmax = config.wait;
        break;
    }
    cp.t = 0;
  }

  function parseColmode(sIn) {
    const s = sIn || '';
    if (s.includes('se') || s.includes('sil')) return COLOR_SILVER;
    if (s.includes('ce') || s.includes('cla')) return COLOR_CLASSIC;
    if (s.includes('2') || s.includes('two')) return COLOR_TWORND;
    if (s.includes('6') || s.includes('six')) return COLOR_SIXRND;
    if (s.includes('1') || s.includes('ran') || s.includes('rnd')) return COLOR_RANDOM;
    return COLOR_WHITE;
  }

  function initCp() {
    colmode = parseColmode(config.colors);
    const rndstart = config.start === 'shuffle';
    const ce_colors = [
      [1.0, 1.0, 1.0],
      [1.0, 0.5, 0.0],
      [0.0, 0.9, 0.0],
      [0.8, 0.0, 0.0],
      [0.1, 0.1, 1.0],
      [0.9, 0.9, 0.0],
    ];
    cp.state = ST_PAUSE1;
    cp.xrot = -65.0; cp.yrot = 185.0;
    cp.posarg = config.wanderspeed ? (rng.random() % 360) : 0.0;
    cp.t = 0.0; cp.tmax = config.wait;
    cp.hf[0] = cp.hf[1] = 0;
    cp.fr[0] = cp.fr[1] = 0;
    cp.rface = 0; cp.ramount = 0;
    for (let i = 0; i < 13; i++) cp.pieces[0][i] = cp.pieces[1][i] = (i % 3 === 1 ? 0 : 1);
    switch (colmode) {
      case COLOR_RANDOM:
      case COLOR_TWORND:
      case COLOR_SIXRND:
        for (let i = 0; i < 6; i++) for (let jj = 0; jj < 3; jj++) cp.colors[i][jj] = rndcolor();
        break;
      case COLOR_SILVER:
        cp.colors[0][0] = 1.0; cp.colors[0][1] = 1.0; cp.colors[0][2] = 1.0;
        cp.colors[1][0] = rndcolor(); cp.colors[1][1] = rndcolor(); cp.colors[1][2] = rndcolor();
        break;
      case COLOR_CLASSIC:
        for (let i = 0; i < 6; i++) for (let jj = 0; jj < 3; jj++) cp.colors[i][jj] = 0.2 + 0.7 * ce_colors[i][jj];
        break;
    }
    switch (colmode) {
      case COLOR_SILVER:
      case COLOR_TWORND:
        for (let i = 0; i < 5; i++) for (let jj = 0; jj < 12; jj++)
          cp.cind[i][jj] = (i === 0) ? 0 : (i === 2) ? 1 : (((jj + 5) % 12) >= 6 ? 1 : 0);
        break;
      case COLOR_CLASSIC:
      case COLOR_SIXRND:
        for (let i = 0; i < 5; i++) for (let jj = 0; jj < 12; jj++)
          cp.cind[i][jj] = (i === 0) ? 4 : (i === 2) ? 5 : trunc(((jj + 5) % 12) / 3);
        break;
      case COLOR_RANDOM:
        for (let i = 0; i < 5; i++) for (let jj = 0; jj < 12; jj++) cp.cind[i][jj] = 0;
        break;
    }
    if (rndstart) randomize();
  }

  // =====================================================================
  //  GL matrix stack + immediate-mode emitter -> non-indexed BufferGeometry
  // =====================================================================
  const MAXV = 4096;                        // >> worst case (~700 verts)
  const posArr = new Float32Array(MAXV * 3);
  const nrmArr = new Float32Array(MAXV * 3);
  const colArr = new Float32Array(MAXV * 3);
  const uvArr = new Float32Array(MAXV * 2);
  let outN = 0;

  const curMat = new THREE.Matrix4();
  const _m = new THREE.Matrix4();
  const _axis = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _n = new THREE.Vector3();
  function loadIdentity() { curMat.identity(); }
  function rotate(deg, x, y, z) { _axis.set(x, y, z).normalize(); _m.makeRotationAxis(_axis, deg * DEG); curMat.multiply(_m); }
  function translate(x, y, z) { _m.makeTranslation(x, y, z); curMat.multiply(_m); }
  function scale(x, y, z) { _m.makeScale(x, y, z); curMat.multiply(_m); }

  // current immediate-mode state
  let curNx = 0, curNy = 0, curNz = 1;
  let curR = 1, curG = 1, curB = 1;
  let curU = 0, curV = 0;
  let primMode = 3, pcount = 0;
  const pP = new Float64Array(6 * 3), pN = new Float64Array(6 * 3), pC = new Float64Array(6 * 3), pU = new Float64Array(6 * 2);

  function glNormal(x, y, z) { _n.set(x, y, z).transformDirection(curMat); curNx = _n.x; curNy = _n.y; curNz = _n.z; }
  function setColorIf(rgb) { if (cmat) { curR = rgb[0]; curG = rgb[1]; curB = rgb[2]; } }
  function glTex(u, v) { curU = u; curV = v; }
  function glBegin(m) { primMode = m; pcount = 0; }
  function glEnd() { pcount = 0; }
  function emit3(a, b, c) {
    const ks = a, kb = b, kc = c;
    for (const k of [ks, kb, kc]) {
      const o3 = outN * 3, o2 = outN * 2;
      posArr[o3] = pP[k * 3]; posArr[o3 + 1] = pP[k * 3 + 1]; posArr[o3 + 2] = pP[k * 3 + 2];
      nrmArr[o3] = pN[k * 3]; nrmArr[o3 + 1] = pN[k * 3 + 1]; nrmArr[o3 + 2] = pN[k * 3 + 2];
      colArr[o3] = pC[k * 3]; colArr[o3 + 1] = pC[k * 3 + 1]; colArr[o3 + 2] = pC[k * 3 + 2];
      uvArr[o2] = pU[k * 2]; uvArr[o2 + 1] = pU[k * 2 + 1];
      outN++;
    }
  }
  function glVert(x, y, z) {
    _v.set(x, y, z).applyMatrix4(curMat);
    const k = pcount;
    pP[k * 3] = _v.x; pP[k * 3 + 1] = _v.y; pP[k * 3 + 2] = _v.z;
    pN[k * 3] = curNx; pN[k * 3 + 1] = curNy; pN[k * 3 + 2] = curNz;
    pC[k * 3] = curR; pC[k * 3 + 1] = curG; pC[k * 3 + 2] = curB;
    pU[k * 2] = curU; pU[k * 2 + 1] = curV;
    pcount++;
    if (primMode === 3 && pcount === 3) { emit3(0, 1, 2); pcount = 0; }
    else if (primMode === 4 && pcount === 4) { emit3(0, 1, 2); emit3(0, 2, 3); pcount = 0; }
  }

  // =====================================================================
  //  draw primitives (transcribed from draw_narrow_piece / draw_wide_piece /
  //  draw_middle_piece, vertex-for-vertex). `s`(zs) is the layer z-sign (+1 top,
  //  -1 bottom); s1 is the inner-face z. c* are indices into cp.colors.
  // =====================================================================
  const col = (c) => cp.colors[c];

  function drawNarrow(zs, c1, c2) {
    const s1 = posc[0] * zs;
    glBegin(3);
    glNormal(0.0, 0.0, zs); setColorIf(col(c1));
    glTex(0.5, 0.5); glVert(0.0, 0.0, zs);
    glTex(texq, 0.0); glVert(posc[1], 0.0, zs);
    glTex(texp, 0.0); glVert(posc[2], posc[3], zs);
    glNormal(0.0, 0.0, -zs); setColorIf(colorInner);
    glTex(TG, TG); glVert(0.0, 0.0, s1);
    glVert(posc[1], 0.0, s1);
    glVert(posc[2], posc[3], s1);
    glEnd();
    glBegin(4);
    glNormal(0.0, -1.0, 0.0); setColorIf(colorInner);
    glTex(TG, TG); glVert(0.0, 0.0, zs);
    glVert(posc[1], 0.0, zs);
    glVert(posc[1], 0.0, s1);
    glVert(0.0, 0.0, s1);
    glNormal(COS15, SIN15, 0.0); setColorIf(col(c2));
    glTex(texq, texq); glVert(posc[1], 0.0, zs);
    glTex(texq, texp); glVert(posc[2], posc[3], zs);
    glTex(1.0, texp); glVert(posc[2], posc[3], s1);
    glTex(1.0, texq); glVert(posc[1], 0.0, s1);
    glNormal(-SIN30, COS30, 0.0); setColorIf(colorInner);
    glTex(TG, TG); glVert(0.0, 0.0, zs);
    glVert(posc[2], posc[3], zs);
    glVert(posc[2], posc[3], s1);
    glVert(0.0, 0.0, s1);
    glEnd();
    rotate(30.0, 0.0, 0.0, 1.0);
  }

  function drawWide(zs, c1, c2, c3) {
    const s1 = posc[0] * zs;
    glBegin(3);
    glNormal(0.0, 0.0, zs); setColorIf(col(c1));
    glTex(0.5, 0.5); glVert(0.0, 0.0, zs);
    glTex(texp, 0.0); glVert(posc[1], 0.0, zs);
    glTex(0.0, 0.0); glVert(posc[4], posc[5], zs);
    glTex(0.0, 0.0); glVert(posc[4], posc[5], zs);
    glTex(0.0, texp); glVert(posc[3], posc[2], zs);
    glTex(0.5, 0.5); glVert(0.0, 0.0, zs);
    glNormal(0.0, 0.0, -zs); setColorIf(colorInner);
    glTex(TG, TG); glVert(0.0, 0.0, s1);
    glVert(posc[1], 0.0, s1);
    glVert(posc[4], posc[5], s1);
    glVert(posc[4], posc[5], s1);
    glVert(posc[3], posc[2], s1);
    glVert(0.0, 0.0, s1);
    glEnd();
    glBegin(4);
    glNormal(0.0, -1.0, 0.0); setColorIf(colorInner);
    glTex(TG, TG); glVert(0.0, 0.0, zs);
    glVert(posc[1], 0.0, zs);
    glVert(posc[1], 0.0, s1);
    glVert(0.0, 0.0, s1);
    glNormal(COS15, -SIN15, 0.0); setColorIf(col(c2));
    glTex(texq, texp); glVert(posc[1], 0.0, zs);
    glTex(texq, 0.0); glVert(posc[4], posc[5], zs);
    glTex(1.0, 0.0); glVert(posc[4], posc[5], s1);
    glTex(1.0, texp); glVert(posc[1], 0.0, s1);
    glNormal(SIN15, COS15, 0.0); setColorIf(col(c3));
    glTex(texq, texp); glVert(posc[4], posc[5], zs);
    glTex(texq, 0.0); glVert(posc[3], posc[2], zs);
    glTex(1.0, 0.0); glVert(posc[3], posc[2], s1);
    glTex(1.0, texp); glVert(posc[4], posc[5], s1);
    glNormal(-COS30, SIN30, 0.0); setColorIf(colorInner);
    glTex(TG, TG); glVert(0.0, 0.0, zs);
    glVert(posc[3], posc[2], zs);
    glVert(posc[3], posc[2], s1);
    glVert(0.0, 0.0, s1);
    glEnd();
    rotate(60.0, 0.0, 0.0, 1.0);
  }

  function drawMiddlePiece(sHalf) {
    const s6 = sHalf * 6;
    glBegin(4);
    setColorIf(colorInner);
    glNormal(0.0, 0.0, 1.0);
    glTex(TG, TG); glVert(posc[1], 0.0, posc[0]);
    glVert(posc[4], posc[5], posc[0]);
    glVert(-posc[5], posc[4], posc[0]);
    glVert(-posc[1], 0.0, posc[0]);
    glNormal(0.0, 0.0, -1.0);
    glTex(TG, TG); glVert(posc[1], 0.0, -posc[0]);
    glVert(posc[4], posc[5], -posc[0]);
    glVert(-posc[5], posc[4], -posc[0]);
    glVert(-posc[1], 0.0, -posc[0]);
    glNormal(0.0, -1.0, 0.0);
    glTex(TG, TG); glVert(-posc[1], 0.0, posc[0]);
    glVert(posc[1], 0.0, posc[0]);
    glVert(posc[1], 0.0, -posc[0]);
    glVert(-posc[1], 0.0, -posc[0]);
    glNormal(COS15, -SIN15, 0.0); setColorIf(col(cp.cind[4][s6]));
    glTex(texq, texp); glVert(posc[1], 0.0, posc[0]);
    glTex(1.0, texp); glVert(posc[4], posc[5], posc[0]);
    glTex(1.0, texq); glVert(posc[4], posc[5], -posc[0]);
    glTex(texq, texq); glVert(posc[1], 0.0, -posc[0]);
    glNormal(SIN15, COS15, 0.0); setColorIf(col(cp.cind[4][s6 + 1]));
    glTex(0.0, 0.5); glVert(posc[4], posc[5], posc[0]);
    glTex(texq, 0.5); glVert(-posc[5], posc[4], posc[0]);
    glTex(texq, 0.75); glVert(-posc[5], posc[4], -posc[0]);
    glTex(0.0, 0.75); glVert(posc[4], posc[5], -posc[0]);
    glNormal(-COS15, SIN15, 0.0); setColorIf(col(cp.cind[4][s6 + 4]));
    glTex(0.0, 0.75); glVert(-posc[5], posc[4], posc[0]);
    glTex(1.0, 0.75); glVert(-posc[1], 0.0, posc[0]);
    glTex(1.0, 1.0); glVert(-posc[1], 0.0, -posc[0]);
    glTex(0.0, 1.0); glVert(-posc[5], posc[4], -posc[0]);
    glEnd();
  }

  function drawMiddle() {
    if (cp.hf[0]) rotate(180.0, 0.0, 1.0, 0.0);
    drawMiddlePiece(0);
    if (cp.hf[0]) rotate(180.0, 0.0, 1.0, 0.0);
    rotate(180.0, 0.0, 0.0, 1.0);
    if (cp.hf[1]) rotate(180.0, 0.0, 1.0, 0.0);
    drawMiddlePiece(1);
    if (cp.hf[1]) rotate(180.0, 0.0, 1.0, 0.0);
  }

  function drawHalfFace(s, o) {
    const s1 = 1 - s * 2, s2 = s * 2;
    for (let i = o; i < o + 6; i++) {
      if (cp.pieces[s][i + 1]) {
        drawNarrow(s1, cp.cind[s2][i], cp.cind[s2 + 1][i]);
      } else {
        drawWide(s1, cp.cind[s2][i], cp.cind[s2 + 1][i], cp.cind[s2 + 1][i + 1]);
        i++;
      }
    }
  }
  function drawTopFace() { drawHalfFace(0, 0); drawHalfFace(0, 6); }
  function drawBottomFace() { drawHalfFace(1, 0); drawHalfFace(1, 6); }

  // draw_main: build the whole puzzle for this frame into eye space.
  let vw = 1, vh = 1;
  function buildFrame() {
    outN = 0;
    const theta = cp.ramount < 0 ? cp.t : -cp.t;
    loadIdentity();
    if (config.wander)
      translate(3.0 * (vw / vh) * Math.sin(13.0 * cp.posarg), 3.0 * Math.sin(17.0 * cp.posarg), ZPOS);
    else
      translate(0.0, 0.0, ZPOS);
    scale(config.size, config.size, config.size);
    const fit = (vw < vh) ? (vw / vh) : 1.0;   // reshape/draw_main portrait fit
    scale(fit, fit, fit);
    rotate(cp.xrot, 1.0, 0.0, 0.0);
    rotate(cp.yrot, 0.0, 1.0, 0.0);
    // (gltrackball_rotate omitted -- no interactive mouse drag)

    // frame-start glColor: wire => 0.7 gray, else (1,1,1) (only used if cmat is false;
    // when cmat, every face sets its own color, matching GL_COLOR_MATERIAL).
    curR = curG = curB = config.wire ? 0.7 : 1.0;

    switch (cp.state) {
      case ST_PAUSE1:
      case ST_PAUSE2:
        drawTopFace(); drawBottomFace(); drawMiddle();
        break;
      case ST_ROT_TOP:
        rotate(theta, 0.0, 0.0, 1.0); drawTopFace(); rotate(-theta, 0.0, 0.0, 1.0);
        drawBottomFace(); drawMiddle();
        break;
      case ST_ROT_BOTTOM:
        drawTopFace();
        rotate(theta, 0.0, 0.0, 1.0); drawBottomFace(); rotate(-theta, 0.0, 0.0, 1.0);
        drawMiddle();
        break;
      case ST_HALF1:
      case ST_HALF2:
        if (cp.state === ST_HALF1) rotate(theta, 0.0, 1.0, 0.0);
        drawHalfFace(0, 0); rotate(-180.0, 0.0, 0.0, 1.0); drawHalfFace(1, 0); rotate(-180.0, 0.0, 0.0, 1.0);
        if (cp.hf[0]) rotate(180.0, 0.0, 1.0, 0.0);
        drawMiddlePiece(0);
        if (cp.hf[0]) rotate(180.0, 0.0, 1.0, 0.0);
        if (cp.state === ST_HALF1) rotate(-theta, 0.0, 1.0, 0.0); else rotate(theta, 0.0, 1.0, 0.0);
        rotate(180.0, 0.0, 0.0, 1.0); drawHalfFace(0, 6); rotate(-180.0, 0.0, 0.0, 1.0); drawHalfFace(1, 6); rotate(-180.0, 0.0, 0.0, 1.0);
        if (cp.hf[1]) rotate(180.0, 0.0, 1.0, 0.0);
        drawMiddlePiece(1);
        break;
    }
  }

  // =====================================================================
  //  three.js scene
  // =====================================================================
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();

  // gluPerspective(30, ratio, 1, 100), eye at origin looking down -z. Geometry is
  // baked into eye space, so the camera is at the origin with identity orientation
  // (world space == eye space) and carries only the projection.
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 0);

  // Two directional lights in eye space (the .c sets LIGHT positions under an identity
  // modelview, so they are fixed to the camera, not the object): (1,1,1) and
  // (-1,-1,1), diffuse white, per-light ambient 0. Intensity PI cancels three's 1/PI
  // Lambert. Global ambient 0.1 (*PI for the same reason).
  const light0 = new THREE.DirectionalLight(0xffffff, PI); light0.position.set(1, 1, 1);
  const light1 = new THREE.DirectionalLight(0xffffff, PI); light1.position.set(-1, -1, 1);
  scene.add(light0, light1, new THREE.AmbientLight(0xffffff, 0.1 * PI));

  // Material: GL_COLOR_MATERIAL -> per-face vertex colors drive ambient+diffuse;
  // specular 0.2 (/PI so the PI-intensity lights don't blow it out), shininess 20.
  // GL_FLAT -> we already store one exact normal per face on all its verts, so
  // flatShading:false renders flat and is winding-independent. No GL_CULL_FACE in the
  // .c -> DoubleSide.
  const phongMat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    vertexColors: true,
    specular: new THREE.Color(0.2 / PI, 0.2 / PI, 0.2 / PI),
    shininess: 20,
    side: THREE.DoubleSide,
    flatShading: false,
    map: texture,
  });
  // Wireframe: the .c returns from init_gl before enabling lighting/texture and draws
  // flat 0.7-gray lines -> an unlit basic material.
  const wireMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.7, 0.7, 0.7), wireframe: true });

  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(posArr, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
  const nrmAttr = new THREE.BufferAttribute(nrmArr, 3); nrmAttr.setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(colArr, 3); colAttr.setUsage(THREE.DynamicDrawUsage);
  const uvAttr = new THREE.BufferAttribute(uvArr, 2); uvAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('position', posAttr);
  geom.setAttribute('normal', nrmAttr);
  geom.setAttribute('color', colAttr);
  geom.setAttribute('uv', uvAttr);
  const mesh = new THREE.Mesh(geom, phongMat);
  mesh.frustumCulled = false;
  scene.add(mesh);

  // ---- init puzzle (init_posc + make_texture already done; now init_cp) ----
  initCp();
  let prevColors = config.colors, prevStart = config.start;

  // ---- sizing (reshape: gluPerspective + portrait fit) ----
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    vw = w; vh = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop ----
  let raf = 0, last = 0, paused = false, ms = 16;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    // live structural changes: colormode / start -> reinit the puzzle (mirrors the
    // .c's init path; a fundamental option effectively restarts).
    if (config.colors !== prevColors || config.start !== prevStart) {
      initCp();
      prevColors = config.colors; prevStart = config.start;
    }

    // derived render state (init_gl): cmat, inner-face color, texture on/off, material.
    colmode = parseColmode(config.colors);
    cmat = !config.wire && (colmode !== COLOR_WHITE);
    colorInner = config.tex ? [1, 1, 1] : [0.4, 0.4, 0.4];
    const wantMap = (config.tex && !config.wire) ? texture : null;
    if (phongMat.map !== wantMap) { phongMat.map = wantMap; phongMat.needsUpdate = true; }
    if (mesh.material !== (config.wire ? wireMat : phongMat)) mesh.material = config.wire ? wireMat : phongMat;

    // draw with the CURRENT state (theta from cp.t), THEN advance (draw_main order).
    buildFrame();
    posAttr.needsUpdate = true; nrmAttr.needsUpdate = true; colAttr.needsUpdate = true; uvAttr.needsUpdate = true;
    geom.setDrawRange(0, outN);
    renderer.render(scene, camera);

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;
    if (config.spin) {
      cp.xrot = (cp.xrot + config.spinspeed * frames) % 360;
      cp.yrot = (cp.yrot + config.spinspeed * frames) % 360;
    }
    if (config.wander) cp.posarg = (cp.posarg + (config.wanderspeed / 1000.0) * frames) % 360;
    cp.t += config.rotspeed * frames;
    if (cp.t > cp.tmax) finish();
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      geom.dispose();
      phongMat.dispose();
      wireMat.dispose();
      texture.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { initCp(); prevColors = config.colors; prevStart = config.start; },
    config,
    params,
  };
}

export default { title, info, start };
