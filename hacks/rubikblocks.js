// rubikblocks.js -- "Rubik Blocks" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's rubikblocks (Vasek Potocek, 2009),
// hacks/glx/rubikblocks.c. A "Rubik's Mirror Blocks" puzzle: a 3x3x3 of 27 cubies whose
// slabs are DIFFERENT widths along x and y (the eccentricity fx/fy/fz), so the solved
// state is a tidy box but every scrambled state is a jagged cluster of overhanging
// blocks. The puzzle shuffles ITSELF -- it lingers, picks a face layer + axis, animates a
// 90 or 180 degree turn of that layer, settles, lingers, repeats -- while the whole thing
// slowly spins and wanders through space. Each facelet is a white face with a soft black
// border (a procedural luminance texture, GL_MODULATE).
//
// Self-contained three.js (own overlay canvas + renderer + loop), like cubestorm.js /
// dangerball.js. RNG = yarandom.js, spin/wander = rotator.js. No assets, no colormap (the
// puzzle is white + lit grays + black facelet borders, not colored).
//
// Faithful to the .c:
//   * 27 pieces (init_cp's i/j/k triple loop, pos in {-1,0,1}^3), each a closed box whose
//     8 corners pass through fx/fy/fz -- the "mirror blocks" eccentricity (A=0.5, B=0.25,
//     C=0; x-slabs 1.5/1.0/0.5 wide, y-slabs 1.25/1.0/0.75, z regular) -- built once into
//     one BufferGeometry per piece (init_lists' QUAD_STRIP + QUADS, 6 flat faces with
//     per-face normals and (0,0)-(1,1) texcoords).
//   * the puzzle state: each piece carries a rotation QUATERNION qr (the .c's qr[4],
//     [w,x,y,z]); a piece is drawn rotated by qr about the cube centre (glRotatef before
//     glCallList). mult_quat / flag_pieces / settle_value / randomize / finish transcribed
//     verbatim. flag_pieces computes qr*pos*qr^-1 to find a piece's CURRENT layer and flags
//     the 9 on the chosen +/-1 face; finish() is the linger<->turn state machine (the
//     static `axis` walk, side/angle = rnd01, qfram = a tspeed-degree step about the axis
//     with a random sign), settling each qr to {0,+-1/2,+-1/sqrt2,+-1} after a turn.
//   * draw_main modelview: T((x-.5)*6,(y-.5)*6,-20) * Rspin(get_rotation*360) *
//     S(cubesize) * S(portrait fit) * [per-piece Rqr]; gluPerspective(30, ratio, 1, 100).
//   * lighting: two white directional lights (GL pos {1,1,1,0} and {-1,-1,1,0}, both w=0 =>
//     parallel), global ambient {0.1}, material AMBIENT_AND_DIFFUSE = white (GL_COLOR_
//     MATERIAL tracks the default white glColor), specular {0.2}, shininess 20, flat shade.
//
// COLOR MANAGEMENT (the cubestack opt-out, justified by measurement): the .c is the GL
// fixed pipeline with NO output gamma -- it writes the raw lit value straight to the 8-bit
// buffer. The ground-truth screenshot is that raw buffer: its gray faces measure 169 =
// 0.677*255 = exactly one-light diffuse (cos~55deg, 0.577) + the 0.1 global ambient, with
// NO sRGB encode. So we render in the SAME space: renderer.outputColorSpace =
// LinearSRGBColorSpace, white material + linear specular + PI lights (the PI cancels three's
// 1/PI Lambert so diffuse = albedo*NdotL like GL) + a 0.1*PI ambient. Under linear output
// the GL_MODULATE border texture is byte-exact too (texel * lit == (texel*albedo)*light,
// multiplication commutes), applied as map + specularMap so the borders kill diffuse AND
// specular. (The sRGB-output LIT convention would lift those grays to ~214 -- wrong here,
// because this hack's content IS the gray levels, not hue.)
//
// PACING -- render every rAF. effFps = 1e6/(delay+OVERHEAD); one render frame is `frames =
// dt*effFps` original-frames. The layer turn is CONTINUOUS: we apply qfram^frames (a
// fractional tspeed-degree step about the fixed turn axis -- exactly equivalent to the .c
// applying qfram `frames` times, since same-axis rotations compose additively) and advance
// the clock t by frames*tspeed; settle_value snaps the tiny overshoot. The spin/wander
// rotator is ticked once per original-frame and INTERPOLATED between ticks (the dangerball
// pattern), gated live by the spin/wander checkboxes. OVERHEAD = 37500 (the geometry-track
// family default; the GL original is runtime-blocked here -- see the framerate-calibration
// note). xml default delay 20000 -> ~17fps.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';

export const title = 'rubikblocks';

export const info = {
  author: 'Vasek Potocek',
  year: 2009,
  description: 'The "Rubik\'s Mirror Blocks" puzzle.\n\nSee also the "Rubik", "Cube21", and "GLSnake" screen savers.\n\nhttps://en.wikipedia.org/wiki/Combination_puzzles#Irregular_cuboids',
};

export function start(hostCanvas, opts = {}) {
  const TWO_PI = Math.PI * 2;
  const OVERHEAD = 37500;        // us; geometry-track family default (xml delay 20000 -> ~17fps)
  const SHUFFLE = 100;           // randomize(): instant 90-degree turns to scramble the start
  const SQRT1_2 = Math.SQRT1_2;  // M_SQRT1_2 = 1/sqrt(2) = sin/cos of 45deg
  // procedural texture (make_texture): a 64x64 luminance facelet with soft black borders.
  const TEX = 64, BORDER = 5, BORDER2 = BORDER * BORDER;

  // Knobs transcribed 1:1 from hacks/config/rubikblocks.xml (labels verbatim; note the xml
  // itself uses "Spin"/"Wander" for BOTH the speed sliders and the on/off checkboxes).
  const config = {
    delay: 20000,         // us (xml default; invert slider) -- "Frame rate"
    cubesize: 1.0,        // overall scale (xml --cubesize) -- "Cube size"
    rotspeed: 3.0,        // layer-turn speed, degrees/original-frame (xml --rotspeed) -- "Rotation"
    randomize: false,     // start scrambled vs solved (xml --randomize / "Start as random shape")
    spinspeed: 0.1,       // rotator spin speed (xml --spinspeed) -- "Spin"
    wanderspeed: 0.005,   // rotator wander speed (xml --wanderspeed) -- "Wander"
    wait: 40.0,           // linger time between turns (xml --wait) -- "Linger"
    spin: true,           // tumble (do_spin)
    wander: true,         // drift through space (do_wander)
    tex: true,            // facelet outline texture (do_texture) -- "Outlines"
    wire: false,          // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cubesize', label: 'Cube size', type: 'range', min: 0.4, max: 2.0, step: 0.1, default: 1.0, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'rotspeed', label: 'Rotation', type: 'range', min: 1.0, max: 10.0, step: 0.1, default: 3.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'randomize', label: 'Start scrambled', type: 'checkbox', default: false, live: true },
    { key: 'spinspeed', label: 'Spin', type: 'range', min: 0.01, max: 4.0, step: 0.01, default: 0.1, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'wanderspeed', label: 'Wander', type: 'range', min: 0.001, max: 0.1, step: 0.001, default: 0.005, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'wait', label: 'Linger', type: 'range', min: 10.0, max: 100.0, step: 1.0, default: 40.0, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'spin', label: 'Spin', type: 'checkbox', default: true, live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'tex', label: 'Outlines', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);
  const rnd01 = () => rng.random() % 2;   // the .c's rnd01(): 0 or 1

  // ===================================================================
  //  quaternion math (mult_quat) -- qr[4] = [w, x, y, z], the .c's layout
  // ===================================================================
  // Multiplies src*dest, storing the result in dest (in place), verbatim from the .c.
  function multQuat(src, dest) {
    const r = src[0] * dest[0] - src[1] * dest[1] - src[2] * dest[2] - src[3] * dest[3];
    const i = src[0] * dest[1] + src[1] * dest[0] + src[2] * dest[3] - src[3] * dest[2];
    const j = src[0] * dest[2] + src[2] * dest[0] + src[3] * dest[1] - src[1] * dest[3];
    const k = src[0] * dest[3] + src[3] * dest[0] + src[1] * dest[2] - src[2] * dest[1];
    dest[0] = r; dest[1] = i; dest[2] = j; dest[3] = k;
  }

  // "Rounds" v to the nearest of {0, +-1/2, +-1/sqrt2, +-1} -- snaps a settled qr to a
  // clean 90-degree orientation, killing the float drift accumulated during a turn.
  function settleValue(v) {
    if (v > 0.9) return 1;
    else if (v < -0.9) return -1;
    else if (v > 0.6) return SQRT1_2;
    else if (v < -0.6) return -SQRT1_2;
    else if (v > 0.4) return 0.5;
    else if (v < -0.4) return -0.5;
    else return 0;
  }

  // ===================================================================
  //  piece geometry -- the "mirror blocks" eccentricity + init_lists
  // ===================================================================
  // fx/fy/fz: clamp the outer corners inward by A/B/C so the slabs get different widths.
  const fx = (x) => { const A = 0.5; return x > 1.4 ? 1.5 - A : x < -1.4 ? -1.5 - A : x; };
  const fy = (y) => { const B = 0.25; return y > 1.4 ? 1.5 - B : y < -1.4 ? -1.5 - B : y; };
  const fz = (z) => { const C = 0.0; return z > 1.4 ? 1.5 - C : z < -1.4 ? -1.5 - C : z; };

  // One piece at original grid position (px,py,pz): a closed box, 6 flat faces. Vertex
  // order + texcoords transcribed from init_lists (QUAD_STRIP = the 4 sides, QUADS = top/
  // bottom); each face is one quad -> two CCW triangles (outward winding, verified), with
  // the face's single GL normal on every vertex (flat shading).
  function buildPieceGeometry(px, py, pz) {
    const Xp = fx(px + 0.5), Xm = fx(px - 0.5);
    const Yp = fy(py + 0.5), Ym = fy(py - 0.5);
    const Zp = fz(pz + 0.5), Zm = fz(pz - 0.5);
    const faces = [
      { n: [1, 0, 0], v: [[Xp, Ym, Zm], [Xp, Yp, Zm], [Xp, Yp, Zp], [Xp, Ym, Zp]], t: [[0, 0], [0, 1], [1, 1], [1, 0]] },   // +x
      { n: [0, 0, 1], v: [[Xp, Ym, Zp], [Xp, Yp, Zp], [Xm, Yp, Zp], [Xm, Ym, Zp]], t: [[1, 0], [1, 1], [0, 1], [0, 0]] },   // +z
      { n: [-1, 0, 0], v: [[Xm, Ym, Zp], [Xm, Yp, Zp], [Xm, Yp, Zm], [Xm, Ym, Zm]], t: [[0, 0], [0, 1], [1, 1], [1, 0]] },  // -x
      { n: [0, 0, -1], v: [[Xm, Ym, Zm], [Xm, Yp, Zm], [Xp, Yp, Zm], [Xp, Ym, Zm]], t: [[1, 0], [1, 1], [0, 1], [0, 0]] },  // -z
      { n: [0, 1, 0], v: [[Xp, Yp, Zp], [Xp, Yp, Zm], [Xm, Yp, Zm], [Xm, Yp, Zp]], t: [[0, 0], [0, 1], [1, 1], [1, 0]] },   // +y
      { n: [0, -1, 0], v: [[Xp, Ym, Zm], [Xp, Ym, Zp], [Xm, Ym, Zp], [Xm, Ym, Zm]], t: [[0, 0], [0, 1], [1, 1], [1, 0]] },  // -y
    ];
    const pos = [], nrm = [], uv = [];
    for (const f of faces)
      for (const idx of [0, 1, 2, 0, 2, 3]) {
        pos.push(f.v[idx][0], f.v[idx][1], f.v[idx][2]);
        nrm.push(f.n[0], f.n[1], f.n[2]);
        uv.push(f.t[idx][0], f.t[idx][1]);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return g;
  }

  // ===================================================================
  //  procedural facelet texture (make_texture / draw_*_line)
  // ===================================================================
  // 64x64 luminance, all white, then a soft black line drawn along each of the 4 edges:
  // w = offset^2 * 255 / 25 (0 = black at the edge, 255 = white 5px in); takes the min so
  // overlaps stay dark. GL_LUMINANCE -> R=G=B; uploaded as the diffuse + specular map.
  function makeFaceletTexture() {
    const lum = new Uint8Array(TEX * TEX).fill(255);
    const at = (x, y) => y * TEX + x;
    const drawHorz = (x1, x2, Y) => {
      let off = (Y < BORDER) ? -Y : -BORDER;
      for (; off < BORDER; off++) {
        if (Y + off >= TEX) break;
        const w = Math.floor((off * off * 255) / BORDER2);
        for (let x = x1; x <= x2; x++) { const p = at(x, Y + off); if (lum[p] > w) lum[p] = w; }
      }
    };
    const drawVert = (X, y1, y2) => {
      let off = (X < BORDER) ? -X : -BORDER;
      for (; off < BORDER; off++) {
        if (X + off >= TEX) break;
        const w = Math.floor((off * off * 255) / BORDER2);
        for (let y = y1; y <= y2; y++) { const p = at(X + off, y); if (lum[p] > w) lum[p] = w; }
      }
    };
    drawHorz(0, TEX - 1, 0);
    drawHorz(0, TEX - 1, TEX - 1);
    drawVert(0, 0, TEX - 1);
    drawVert(TEX - 1, 0, TEX - 1);

    const data = new Uint8Array(TEX * TEX * 4);
    for (let i = 0; i < TEX * TEX; i++) {
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = lum[i];
      data[i * 4 + 3] = 255;
    }
    const t = new THREE.DataTexture(data, TEX, TEX, THREE.RGBAFormat);
    t.colorSpace = THREE.NoColorSpace;          // a luminance mask, used as a raw multiplier
    t.minFilter = THREE.LinearFilter;           // GL_LINEAR (MIPMAP is #undef'd in the .c)
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  // ===================================================================
  //  three.js scene
  // ===================================================================
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);
  // Match GL's no-output-gamma pipeline so the grayscale ground truth lands byte-for-byte
  // (gray faces = raw lit values, e.g. 0.677 -> 173, NOT the sRGB-lifted 214). See header.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // gluPerspective(30, ratio, 1, 100), camera at origin looking down -z (the modelview's
  // T(...,-20) pushes the puzzle to z=-20, applied as the root group's position below).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);

  // Two white parallel lights (GL pos {1,1,1,0} and {-1,-1,1,0}); intensity PI cancels
  // three's 1/PI Lambert so diffuse = albedo*NdotL as in GL. GL global ambient = 0.1 (the
  // .c overrides the 0.2 default); per-light ambient is {0,0,0}.
  const light0 = new THREE.DirectionalLight(0xffffff, Math.PI);
  light0.position.set(1, 1, 1);
  const light1 = new THREE.DirectionalLight(0xffffff, Math.PI);
  light1.position.set(-1, -1, 1);
  scene.add(light0, light1, new THREE.AmbientLight(0xffffff, 0.1 * Math.PI));

  const tex = makeFaceletTexture();
  // Material AMBIENT_AND_DIFFUSE tracks the default white glColor (GL_COLOR_MATERIAL);
  // specular {0.2} (linear, /PI so the PI light doesn't over-drive the broad shininess-20
  // glint), shininess 20. map AND specularMap = the facelet texture: GL_MODULATE scales the
  // whole lit color, so the black border must kill diffuse AND specular.
  const mat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    specular: new THREE.Color(0.2 / Math.PI, 0.2 / Math.PI, 0.2 / Math.PI),
    shininess: 20,
    map: tex,
    specularMap: tex,
    side: THREE.FrontSide,   // closed opaque boxes; FrontSide == GL's visible (depth-sorted) faces
  });

  // root carries draw_main's modelview T(wander,-20) * Rspin * S(cubesize*portrait); the 27
  // piece meshes (its children) carry the per-piece Rqr.
  const root = new THREE.Group();
  scene.add(root);

  const pieces = [];   // { pos:[x,y,z], qr:[w,x,y,z], act, mesh, geo }
  // init_cp's i/j/k loop: pos = (k, j, i) with i=z, j=y, k=x. Geometry depends only on the
  // (fixed) position, so build it once here; initPuzzle() only resets the rotations.
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++)
      for (let k = -1; k <= 1; k++) {
        const geo = buildPieceGeometry(k, j, i);
        const mesh = new THREE.Mesh(geo, mat);
        root.add(mesh);
        pieces.push({ pos: [k, j, i], qr: [1, 0, 0, 0], act: false, mesh, geo });
      }

  // ===================================================================
  //  puzzle state machine (flag_pieces / randomize / finish)
  // ===================================================================
  let pause = true;        // lingering between turns vs mid-turn
  let t = 0;               // turn/linger clock (degrees, advanced by tspeed)
  let tmax = config.wait;  // clock target (90/180 for a turn, `wait` for a linger)
  let turnAxis = 1;        // 1/2/3 = x/y/z: the axis the current turn rotates about
  let turnSign = 1;        // +-1: the current turn's direction
  let finishAxis = 1;      // the .c's `static int axis` -- the next-axis chooser's memory

  const qv = [0, 0, 0, 0]; // scratch for flag_pieces

  // Sets `act` on the 9 pieces currently on the `side` (+-1) face of `axis`. Computes each
  // piece's CURRENT position qr*pos*qr^-1 (the conj-imag / mult_quat dance) and tests it.
  function flagPieces(axis, side) {
    for (const p of pieces) {
      qv[0] = 0; qv[1] = p.pos[0]; qv[2] = p.pos[1]; qv[3] = p.pos[2];
      multQuat(p.qr, qv);
      qv[1] = -qv[1]; qv[2] = -qv[2]; qv[3] = -qv[3];
      multQuat(p.qr, qv);
      qv[1] = -qv[1]; qv[2] = -qv[2]; qv[3] = -qv[3];
      p.act = Math.abs(qv[axis] - side) < 0.1;
    }
  }

  // randomize(): SHUFFLE instant 90-degree turns -- the "Start as random shape" scramble.
  function randomize() {
    const qfram = [0, 0, 0, 0];
    for (let s = 0; s < SHUFFLE; s++) {
      const axis = (rng.random() % 3) + 1;
      const side = rnd01() * 2 - 1;
      flagPieces(axis, side);
      qfram[1] = qfram[2] = qfram[3] = 0;
      qfram[0] = SQRT1_2;
      qfram[axis] = SQRT1_2;
      for (const p of pieces) if (p.act) multQuat(qfram, p.qr);
    }
  }

  // finish(): the linger<->turn transition. pause -> start a turn (pick axis via the static
  // walk, side/angle/sign via rnd01, flag the layer, set tmax = 90*angle); !pause -> settle
  // every qr to a clean orientation and start a linger (tmax = wait).
  function finish() {
    if (pause) {
      switch (finishAxis) {
        case 1: finishAxis = rnd01() + 2; break;      // -> 2 or 3
        case 2: finishAxis = 2 * rnd01() + 1; break;  // -> 1 or 3
        default: finishAxis = rnd01() + 1;            // (3) -> 1 or 2
      }
      const side = rnd01() * 2 - 1;
      const angle = rnd01() + 1;                      // 1 or 2 quarter-turns
      flagPieces(finishAxis, side);
      pause = false;
      tmax = 90.0 * angle;
      turnAxis = finishAxis;
      turnSign = rnd01() * 2 - 1;                     // qfram[axis] sign
    } else {
      for (const p of pieces)
        for (let j = 0; j < 4; j++) p.qr[j] = settleValue(p.qr[j]);
      pause = true;
      tmax = config.wait;
    }
    t = 0;
  }

  function initPuzzle() {
    let m = 0;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++) {
          const p = pieces[m++];
          p.pos[0] = k; p.pos[1] = j; p.pos[2] = i;
          p.qr[0] = 1; p.qr[1] = 0; p.qr[2] = 0; p.qr[3] = 0;
          p.act = false;
        }
    pause = true; t = 0; tmax = config.wait; finishAxis = 1;
    if (config.randomize) randomize();
  }

  // ===================================================================
  //  spin/wander rotator (rotator.js) -- built at full speed, gated live
  // ===================================================================
  // make_rotator(spinspeed x3, 0.1, wanderspeed, True). The spin/wander CHECKBOXES gate the
  // output live (dangerball pattern); the spinspeed/wanderspeed SLIDERS rebuild the rotator
  // (they are the rotator's internal speeds, not a post-scale). randomize=True always.
  let rot, prevR, curR, prevP, curP, rotAccum = 0;
  function rebuildRotator() {
    rot = makeRotator(
      {
        spinX: config.spinspeed, spinY: config.spinspeed, spinZ: config.spinspeed,
        spinAccel: 0.1,
        wanderSpeed: config.wanderspeed,
        randomize: true,
      },
      rng,
    );
    const r0 = rot.getRotation(false), p0 = rot.getPosition(false);
    prevR = { ...r0 }; curR = { ...r0 };
    prevP = { ...p0 }; curP = { ...p0 };
    rotAccum = 0;
  }
  // init order mirrors init_cp: make_rotator, THEN randomize.
  rebuildRotator();
  initPuzzle();

  function tickRotator() {
    prevP = curP; curP = rot.getPosition(true);   // the .c calls get_position then get_rotation
    prevR = curR; curR = rot.getRotation(true);
  }
  const lerp = (a, b, t2) => a + (b - a) * t2;
  // shortest-path lerp on the [0,1) rotation circle (rotx/y/z are abs values, wrap at 1).
  function lerpAngle(a, b, t2) {
    let d = b - a;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    return a + d * t2;
  }

  // ===================================================================
  //  live-config reaction (the .c bakes these at init; here some are live)
  // ===================================================================
  let lastSpin = config.spinspeed, lastWander = config.wanderspeed;
  let lastRnd = config.randomize, lastTex = config.tex;
  function checkConfig() {
    if (config.spinspeed !== lastSpin || config.wanderspeed !== lastWander) {
      lastSpin = config.spinspeed; lastWander = config.wanderspeed;
      rebuildRotator();
    }
    if (config.randomize !== lastRnd) { lastRnd = config.randomize; initPuzzle(); }
    if (config.tex !== lastTex) {
      lastTex = config.tex;
      mat.map = config.tex ? tex : null;
      mat.specularMap = config.tex ? tex : null;
      mat.needsUpdate = true;
    }
  }

  // ===================================================================
  //  sizing (reshape_rubikblocks: gluPerspective + the portrait-fit scale)
  // ===================================================================
  let portraitS = 1;
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    portraitS = (w < h ? w / h : 1);
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ===================================================================
  //  render loop
  // ===================================================================
  const MAX_TICKS = 8;
  const qstep = [1, 0, 0, 0];     // per-render fractional qfram (qfram^frames)
  const _euler = new THREE.Euler();
  const _q = new THREE.Quaternion();
  let raf = 0, last = 0, paused = false, ms = 16;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    checkConfig();

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;
    const tspeed = config.rotspeed;

    // --- layer turn: continuous qfram^frames about the fixed turn axis ---
    if (!pause) {
      const half = frames * tspeed * Math.PI / 360;   // half-angle for frames*tspeed degrees
      qstep[0] = Math.cos(half); qstep[1] = qstep[2] = qstep[3] = 0;
      qstep[turnAxis] = turnSign * Math.sin(half);
      for (const p of pieces) if (p.act) multQuat(qstep, p.qr);
    }
    t += frames * tspeed;
    if (t > tmax) finish();   // once per frame, as the .c does (frames never spans a phase)

    // --- spin/wander rotator: tick at effFps, interpolate between ticks ---
    rotAccum += frames;
    let ticks = 0;
    while (rotAccum >= 1 && ticks < MAX_TICKS) { tickRotator(); rotAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) rotAccum = 0;
    const a = rotAccum;

    if (config.spin) {
      _euler.set(
        lerpAngle(prevR.x, curR.x, a) * TWO_PI,
        lerpAngle(prevR.y, curR.y, a) * TWO_PI,
        lerpAngle(prevR.z, curR.z, a) * TWO_PI,
        'XYZ',   // glRotatef x,y,z == three Euler XYZ (Rx*Ry*Rz)
      );
      root.quaternion.setFromEuler(_euler);
    } else {
      root.quaternion.identity();
    }
    if (config.wander) {
      root.position.set((lerp(prevP.x, curP.x, a) - 0.5) * 6, (lerp(prevP.y, curP.y, a) - 0.5) * 6, -20);
    } else {
      root.position.set(0, 0, -20);
    }
    root.scale.setScalar(config.cubesize * portraitS);

    // --- per-piece orientation: qr ([w,x,y,z]) -> three Quaternion (x,y,z,w) ---
    for (const p of pieces) {
      _q.set(p.qr[1], p.qr[2], p.qr[3], p.qr[0]).normalize();
      p.mesh.quaternion.copy(_q);
    }

    mat.wireframe = config.wire;
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      for (const p of pieces) p.geo.dispose();
      mat.dispose();
      tex.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { rebuildRotator(); initPuzzle(); },   // host 're-seed': fresh tumble + puzzle
    config,
    params,
  };
}

export default { title, info, start };
