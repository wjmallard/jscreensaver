// topblock.js -- "Top Block" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's topblock (rednuht, 2006), hacks/glx/topblock.c
// (+ the shared hacks/glx/tube.c and hacks/glx/sphere.h primitives). An endless
// stream of colored toy building blocks (2x1 studded bricks) drops from high above
// onto a green studded carpet, where they collide and stack into a growing pile while
// the whole world slowly turns on a turntable and the camera rises to follow the top.
//
// Self-contained three.js (own overlay canvas + renderer + loop), like glknots.js /
// cubestorm.js. RNG = yarandom.js. No assets, no colormap (the block palette is 8 fixed
// RGB constants). All 150-ish bricks are ONE InstancedMesh (per-instance matrix + color),
// the carpet is one static Mesh -- two draw calls, exactly the .c's two display lists.
//
// Faithful to the .c:
//   * buildBlock(): the brick is a display list built under glRotatef(90,y). FIVE box
//     faces (the +z underside is intentionally OMITTED -- a real brick is hollow below,
//     and GL_CULL_FACE is disabled so both sides show) from the verbatim topBlockVertices/
//     topBlockNormals; then, under a second Ry(90), 8 stud "nipples" (capped tubes, radius
//     cylSize) on top and 3 "udder" tubes (radius uddSize) inside the hollow underside.
//     Every glTranslatef/glRotatef in the list is replayed on a Matrix4 stack and baked.
//   * buildCarpet(): a carpetWidth x carpetLength plane (top + 4 rim quads, green) tiled
//     with carpetWidth*carpetLength stud tubes; drawn centered at (-w/2,-l/2).
//   * tube.c's tube(): unit tube radius 1 along +y, `faces` sides, SMOOTH radial normals,
//     caps_p=True (topblock caps its tubes, unlike glknots), placed by tube_1's exact
//     Translate.Rz(-atan2(X,Y)).Rx(atan2(Z,hypot)).Scale(diameter,length,diameter). The
//     `diameter` arg is used as the RADIUS (unit tube already has radius 1).
//   * generateNewBlock(): the random()%spawn gate + the highestFalling < getHeight(...)
//     ceiling; the 4 orientations (0/90/180/270) with their start/end offsets; grid x,y;
//     color = random()%maxColors; spawn height = getHeight(plusheight+highest); and the
//     linked-list RECYCLE at numFallingBlocks>=maxFalling (drop the oldest node, reuse the
//     next) reproduced as blocks.shift()+shift()+push on an array.
//   * the per-frame fall + collision: every falling block descends by dropSpeed in lockstep;
//     within highest+1 it checks its 2-cell footprint against every settled block and, when
//     |height-(node.height+blockHeight)| <= TOLERANCE, snaps onto it (node.height+blockHeight)
//     and may raise `highest`. Bit-exact arithmetic (blockHeight 1.49, TOLERANCE 0.1).
//   * the camera: gluPerspective(60,1/h,1,1000); non-follow gluLookAt(1,20+eyeLine,25 ->
//     0,10+eyeLine,0, up +y) . Rx(90) . Rz(rotation) with eyeLine easing toward `highest`;
//     follow mode Rz(90) . gluLookAt(followBlock, up -x) . Rz(rotation); tunnel/override mode.
//     The WHOLE GL modelview (incl. gluLookAt) is baked into a worldRoot Matrix4 and the
//     three camera left at the origin/identity, so the mode math transcribes 1:1.
//   * lighting: ONE directional light, GL pos {10,10,1,0} -> eye-fixed (set under an identity
//     modelview in init, so it does NOT turn with the world); diffuse white, ambient {.1,.1,.1}
//     + GL's default global ambient .2 => 0.3*color floor; the material is GL_AMBIENT_AND_
//     DIFFUSE = the block color with NO material specular (matte). Light intensity = PI to
//     cancel three's 1/PI Lambert (the glknots/dangerball convention).
//
// PACING -- render every rAF; tick the block simulation (spawn + rotate + fall/collide) at
// effFps = 1e6/(delay+OVERHEAD). OVERHEAD is 6667 (~60fps), NOT the GL track's shared 37500:
// spawn/fall are frame-coupled here, so the slow default starved block drops (see below). The
// falling is continuous, so falling heights + the world
// rotation + the eyeLine/eye camera scalars are INTERPOLATED between ticks (1-tick-behind,
// catch-up capped at 8) for smooth motion (the dangerball.js pattern).

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor values
// to the framebuffer (no sRGB encoding), and the screenshots capture those raw values.
// Disable three's color management so the port matches GL: colors are used raw (setRGB
// becomes a straight store) and the output is not sRGB-encoded. Without this, lit faces
// render up to ~2.5x too bright.
THREE.ColorManagement.enabled = false;

export const title = 'topblock';

export const info = {
  author: 'rednuht',
  year: 2006,
  description: 'Creates a 3D world with dropping blocks that build up and up.',
};

export function start(hostCanvas, opts = {}) {
  const DEG = Math.PI / 180;
  // topblock's spawn AND fall are FRAME-COUPLED (generateNewBlock rolls random()%spawn once
  // per sim-tick, blocks fall by dropSpeed per tick), so the sim rate IS the animation speed
  // and the block-drop cadence. The GL track's shared 37500 (-> ~21fps) is far below the .c's
  // true rate for this LIGHT hack (delay 10000 -> tens of fps) and starves spawns: ~0.4/s and
  // a many-second lag to the first block. Recalibrated to the .c's intended ~60fps (also what
  // the reference screenshot's dense pile implies): 1e6/(10000+6667) ~= 60. See topblock.md.
  const OVERHEAD = 6667;           // us; ~60fps at the xml delay of 10000 (NOT the 37500 default)
  const MAX_TICKS = 8;             // sim catch-up cap (avoids spiral after a stall)

  // ---- constants (topblock.h) ----
  const blockHeight = 1.49;        // #define blockHeight 1.49f
  const blockWidth = 2.0;          // #define blockWidth 2.0f
  const TOLERANCE = 0.1;           // #define TOLERANCE 0.1f
  const cylSize = 0.333334;        // nipple radius
  const uddSize = 0.4;             // udder radius
  const singleThick = 0.29;        // carpet edge thickness
  const DEF_MAX_FALLING = 75;      // DEF_MAX_FALLING "75" (carpet is off screen by then)
  const getHeight = (a) => a * blockHeight;   // #define getHeight(a) (a*blockHeight)

  // The 8 fixed block colors (draw_topBlock's color switch); maxColors default 7 uses 0..6
  // (no black). Used raw -- color management is off.
  const BLOCK_COLORS = [
    [1.0, 0.0, 0.0],        // 0 red
    [0.0, 1.0, 0.0],        // 1 green
    [0.0, 0.0, 1.0],        // 2 blue
    [0.95, 0.95, 0.95],     // 3 white
    [1.0, 0.5, 0.0],        // 4 orange
    [1.0, 1.0, 0.0],        // 5 yellow
    [0.5, 0.5, 0.5],        // 6 grey
    [0.05, 0.05, 0.05],     // 7 near-black
  ].map((c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace));

  // Knobs transcribed 1:1 from hacks/topblock.xml (host renders the box from `params` and
  // mutates `config` in place). `delay` and `spawn` invert the slider (high = fast/likely).
  const config = {
    delay: 10000,        // us (xml default; invert slider)
    dropSpeed: 4,        // 1..9 fall rate (xml --dropSpeed)
    size: 2,             // 1..10 carpet size = 8*size (xml --size)
    spawn: 50,           // 4..1000 spawn gate = random()%spawn==1 (xml --spawn, invert)
    resolution: 8,       // 4..20 tube/sphere polygon count (xml --resolution)
    maxColors: 7,        // 1..32 (clamped to 8 in code) block colors (xml --maxColors)
    rotateSpeed: 10,     // 1..1000 world turntable speed /100 (xml --rotateSpeed)
    rotate: true,        // spin the world (xml --rotate)
    follow: false,       // camera chases the newest block (xml --follow)
    blob: false,         // bricks become sphere pairs (xml --blob)
    override: false,     // "tunnel mode" interior camera (xml --override)
    carpet: true,        // draw the base carpet (xml --carpet)
    nipples: true,       // draw the studs (xml --nipples)
    wire: false,         // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'dropSpeed', label: 'Drop speed', type: 'range', min: 1, max: 9, step: 1, default: 4, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    { key: 'size', label: 'Carpet size', type: 'range', min: 1, max: 10, step: 1, default: 2, lowLabel: 'Small', highLabel: 'Large', live: true },
    { key: 'spawn', label: 'Spawn likelyhood', type: 'range', min: 4, max: 1000, step: 1, default: 50, invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'resolution', label: 'Polygon count', type: 'range', min: 4, max: 20, step: 1, default: 8, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'maxColors', label: 'Colors', type: 'range', min: 1, max: 32, step: 1, default: 7, lowLabel: 'Few', highLabel: 'Many', live: true },
    { key: 'rotateSpeed', label: 'Rotation', type: 'range', min: 1, max: 1000, step: 1, default: 10, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    { key: 'rotate', label: 'Rotate', type: 'checkbox', default: true, live: true },
    { key: 'follow', label: 'Follow', type: 'checkbox', default: false, live: true },
    { key: 'blob', label: 'Blob mode', type: 'checkbox', default: false, live: true },
    { key: 'override', label: 'Tunnel mode', type: 'checkbox', default: false, live: true },
    { key: 'carpet', label: 'Carpet', type: 'checkbox', default: true, live: true },
    { key: 'nipples', label: 'Nipples', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];
  const rng = makeYaRandom(opts.seed || 0);

  // clamped derived params (mirror init_topBlock's clamps)
  const effDropSpeed = () => { let d = config.dropSpeed; if (d < 1) d = 1; if (d > 9) d = 9; d = 80 / d; return blockHeight / d; };
  const effRotateSpeed = () => { let r = config.rotateSpeed; if (r < 1) r = 1; if (r > 1000) r = 1000; return r / 100; };
  const effSpawn = () => { let s = config.spawn; if (s < 4) s = 4; if (s > 1000) s = 1000; return s; };
  const effMaxColors = () => { let m = config.maxColors; if (m < 1) m = 1; if (m > 8) m = 8; return m; };
  const clampSize = () => { let s = config.size | 0; if (s > 10) s = 10; if (s < 1) s = 2; return s; };
  const effResolution = () => Math.max(4, Math.min(20, config.resolution | 0)) * 2;   // tb->resolution *= 2

  // ===================================================================
  //  geometry accumulator -- a GL matrix stack that bakes transformed
  //  triangle soup (positions + smooth normals) into flat arrays.
  // ===================================================================
  function makeAccumulator() {
    const pos = [];
    const nrm = [];
    let M = new THREE.Matrix4();
    const stack = [];
    const nmat = new THREE.Matrix3();
    const tmp = new THREE.Matrix4();
    const axis = new THREE.Vector3();

    // append soup {P:[[x,y,z]..], N:[[x,y,z]..]} (triangles) transformed by `full`.
    function emit(full, soup) {
      const e = full.elements;
      nmat.getNormalMatrix(full);          // inverse-transpose for correct normals under scale
      const n = nmat.elements;
      const P = soup.P, N = soup.N;
      for (let k = 0; k < P.length; k++) {
        const px = P[k][0], py = P[k][1], pz = P[k][2];
        pos.push(
          e[0] * px + e[4] * py + e[8] * pz + e[12],
          e[1] * px + e[5] * py + e[9] * pz + e[13],
          e[2] * px + e[6] * py + e[10] * pz + e[14],
        );
        const nx0 = N[k][0], ny0 = N[k][1], nz0 = N[k][2];
        let nx = n[0] * nx0 + n[3] * ny0 + n[6] * nz0;
        let ny = n[1] * nx0 + n[4] * ny0 + n[7] * nz0;
        let nz = n[2] * nx0 + n[5] * ny0 + n[8] * nz0;
        const L = Math.hypot(nx, ny, nz) || 1;
        nrm.push(nx / L, ny / L, nz / L);
      }
    }

    return {
      push() { stack.push(M.clone()); },
      pop() { M = stack.pop(); },
      translate(x, y, z) { M.multiply(tmp.makeTranslation(x, y, z)); },
      rotate(deg, x, y, z) { M.multiply(tmp.makeRotationAxis(axis.set(x, y, z).normalize(), deg * DEG)); },
      scale(x, y, z) { M.multiply(tmp.makeScale(x, y, z)); },
      appendSoup(soup) { emit(M, soup); },
      // a quad (4 verts, 1 flat normal) -> two triangles (winding irrelevant: DoubleSide).
      quad(v0, v1, v2, v3, nv) {
        emit(M, { P: [v0, v1, v2, v0, v2, v3], N: [nv, nv, nv, nv, nv, nv] });
      },
      // tube_1(): unit tube placed along (x1,y1,z1)->(x2,y2,z2), `diameter` = radius.
      tube(x1, y1, z1, x2, y2, z2, diameter, unitTube) {
        const X = x2 - x1, Y = y2 - y1, Z = z2 - z1;
        const len = Math.hypot(X, Y, Z);
        if (len === 0) return;
        const full = M.clone();
        full.multiply(tmp.makeTranslation(x1, y1, z1));
        full.multiply(tmp.makeRotationZ(-Math.atan2(X, Y)));
        full.multiply(tmp.makeRotationX(Math.atan2(Z, Math.hypot(X, Y))));
        full.multiply(tmp.makeScale(diameter, len, diameter));
        emit(full, unitTube);
      },
      build() {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
        return g;
      },
    };
  }

  // unit_tube(): radius 1, along +y from y=0..1, `faces` sides, smooth radial normals,
  // two flat end caps (topblock passes caps_p=True). Triangle soup.
  function makeUnitTube(faces) {
    const P = [], N = [];
    const step = (Math.PI * 2) / faces;
    for (let j = 0; j < faces; j++) {
      const a0 = j * step, a1 = (j + 1) * step;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const B0 = [c0, 0, s0], T0 = [c0, 1, s0], B1 = [c1, 0, s1], T1 = [c1, 1, s1];
      const n0 = [c0, 0, s0], n1 = [c1, 0, s1];
      P.push(B0, T0, B1); N.push(n0, n0, n1);
      P.push(B1, T0, T1); N.push(n1, n0, n1);
    }
    const cb = [0, 0, 0], nb = [0, -1, 0], ct = [0, 1, 0], nt = [0, 1, 0];   // bottom / top caps
    for (let j = 0; j < faces; j++) {
      const a0 = j * step, a1 = (j + 1) * step;
      P.push(cb, [Math.cos(a0), 0, Math.sin(a0)], [Math.cos(a1), 0, Math.sin(a1)]); N.push(nb, nb, nb);
    }
    for (let j = 0; j < faces; j++) {
      const a0 = j * step, a1 = (j + 1) * step;
      P.push(ct, [Math.cos(a1), 1, Math.sin(a1)], [Math.cos(a0), 1, Math.sin(a0)]); N.push(nt, nt, nt);
    }
    return { P, N };
  }

  // unit_sphere(): radius 1 UV sphere, `stacks` latitude x `slices` longitude, normals =
  // positions. (blob mode only; not the default path.)
  function makeUnitSphere(stacks, slices) {
    const P = [], N = [];
    const pt = (phi, th) => [Math.cos(phi) * Math.cos(th), Math.sin(phi), Math.cos(phi) * Math.sin(th)];
    for (let i = 0; i < stacks; i++) {
      const p1 = (i / stacks) * Math.PI - Math.PI / 2;
      const p2 = ((i + 1) / stacks) * Math.PI - Math.PI / 2;
      for (let j = 0; j < slices; j++) {
        const t1 = (j / slices) * Math.PI * 2, t2 = ((j + 1) / slices) * Math.PI * 2;
        const a = pt(p1, t1), b = pt(p2, t1), c = pt(p2, t2), d = pt(p1, t2);
        P.push(a, b, c); N.push(a, b, c);
        P.push(a, c, d); N.push(a, c, d);
      }
    }
    return { P, N };
  }

  // buildBlock(): the studded 2x1 brick. Faithful vertex/normal tables + tube placements.
  function buildBlockGeometry(faces, nipples) {
    const acc = makeAccumulator();
    const unitTube = makeUnitTube(faces);
    const V = [
      [-0.49, -2.97, -0.99], [0.99, -2.97, -0.99], [0.99, 0.99, -0.99], [-0.49, 0.99, -0.99],
      [-0.49, -2.97, 0.99], [0.99, -2.97, 0.99], [0.99, 0.99, 0.99], [-0.49, 0.99, 0.99],
    ];
    const NR = [[0, 0, -1], [0, 1, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0]];
    acc.push();
    acc.rotate(90, 0, 1, 0);                       // buildBlock's leading Ry(90)
    acc.quad(V[0], V[3], V[2], V[1], NR[0]);       // 5 faces (the +z underside is omitted)
    acc.quad(V[2], V[3], V[7], V[6], NR[1]);
    acc.quad(V[1], V[2], V[6], V[5], NR[2]);
    acc.quad(V[4], V[5], V[6], V[7], NR[3]);
    acc.quad(V[0], V[1], V[5], V[4], NR[4]);
    if (nipples) {
      acc.rotate(90, 0, 1, 0);                     // 'aim' the pointer (second Ry(90))
      acc.translate(0.5, 0.5, 0.99);
      for (let c = 0; c < 2; c++) {                // 8 top studs
        for (let i = 0; i < 4; i++) {
          acc.tube(0, 0, 0, 0, 0, 0.25, cylSize, unitTube);
          acc.translate(0, 0, 0.25); acc.translate(0, 0, -0.25);   // (net zero, as in the .c)
          if (c === 0) acc.translate(0, -1, 0); else acc.translate(0, 1, 0);
        }
        acc.translate(-1, 1, 0);
      }
      acc.translate(1.5, -2.5, -1.5);              // 3 udders on the underside
      for (let c = 0; c < 3; c++) {
        acc.tube(0, 0, 0.1, 0, 0, 1.4, uddSize, unitTube);
        acc.translate(0, -1, 0);
      }
    }
    acc.pop();
    return acc.build();
  }

  // buildBlobBlock(): two radius-1 spheres scaled 1.4, at 0 and (0,-2,0). (blob mode)
  function buildBlobGeometry(faces) {
    const acc = makeAccumulator();
    const sphere = makeUnitSphere(Math.floor(faces / 2), faces);   // unit_sphere(res/2, res)
    acc.push();
    acc.scale(1.4, 1.4, 1.4);
    acc.appendSoup(sphere);
    acc.pop();
    acc.translate(0, -2, 0);
    acc.scale(1.4, 1.4, 1.4);
    acc.appendSoup(sphere);
    return acc.build();
  }

  // buildCarpet(): the plane (top + 4 rims) + the stud grid, all one (green) display list.
  function buildCarpetGeometry(cw, faces, nipples) {
    const acc = makeAccumulator();
    const unitTube = makeUnitTube(faces);
    const x = cw, y = cw;                          // carpetWidth == carpetLength
    acc.push();
    acc.quad([0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, -1]);                        // top
    acc.quad([0, 0, 0], [x, 0, 0], [x, 0, singleThick], [0, 0, singleThick], [0, -1, 0]);    // rim 1
    acc.quad([0, 0, 0], [0, y, 0], [0, y, singleThick], [0, 0, singleThick], [-1, 0, 0]);    // rim 2
    acc.quad([x, 0, 0], [x, y, 0], [x, y, singleThick], [x, 0, singleThick], [1, 0, 0]);     // rim 3
    acc.quad([0, y, 0], [x, y, 0], [x, y, singleThick], [0, y, singleThick], [0, 1, 0]);     // rim 4
    if (nipples) {
      acc.translate(0.5, 0.5, -0.25);
      for (let c = 0; c < x; c++) {                // carpetWidth x carpetLength studs
        acc.push();
        for (let i = 0; i < y; i++) {
          acc.tube(0, 0, -0.1, 0, 0, 0.26, cylSize, unitTube);
          acc.rotate(180, 0, 1, 0); acc.rotate(180, 0, 1, 0);   // (net zero, as in the .c)
          acc.translate(0, 1, 0);
        }
        acc.pop();
        acc.translate(1, 0, 0);
      }
    }
    acc.pop();
    return acc.build();
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

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // The whole GL modelview (gluLookAt included) is baked into worldRoot.matrix each frame,
  // so the three camera stays at the origin/identity (view = identity). gluPerspective(60,
  // 1/h, 1, 1000) is the only thing the camera provides.
  const camera = new THREE.PerspectiveCamera(60, 1, 1, 1000);
  camera.position.set(0, 0, 0);
  camera.matrixAutoUpdate = true;

  // ONE directional light. GL pos {10,10,1,0} was set under an identity modelview in init,
  // so it lives in EYE coordinates -> fixed to the camera, it does NOT turn with the world.
  // Since our camera view is identity, world space == eye space: a scene-space light at
  // (10,10,1) is eye-fixed. Intensity PI cancels three's 1/PI Lambert (diffuse = color*NdotL).
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(10, 10, 1);
  scene.add(light);
  // Ambient floor: GL LIGHT0 ambient {.1,.1,.1} + GL default global ambient .2 = 0.3*color.
  scene.add(new THREE.AmbientLight(0xffffff, 0.3 * Math.PI));

  // Blocks: white base * per-instance color (= GL_AMBIENT_AND_DIFFUSE). NO material specular
  // (the .c never sets one -> matte). Carpet: its own green material. Both DoubleSide because
  // glDisable(GL_CULL_FACE) -- "all objects exhibit a reverse side".
  const blockMat = new THREE.MeshPhongMaterial({ color: 0xffffff, specular: 0x000000, shininess: 0, side: THREE.DoubleSide });
  const carpetMat = new THREE.MeshPhongMaterial({ color: new THREE.Color().setRGB(0, 1, 0, THREE.SRGBColorSpace), specular: 0x000000, shininess: 0, side: THREE.DoubleSide });

  const worldRoot = new THREE.Group();
  worldRoot.matrixAutoUpdate = false;             // we set .matrix (the baked modelview) directly
  scene.add(worldRoot);
  const blocksGroup = new THREE.Group();          // carries the drawCarpet z-shift (-0.55)
  worldRoot.add(blocksGroup);

  let inst = null, carpetMesh = null;
  let carpetWidth = 16, maxFalling = 150, resolutionFaces = 16, INST_CAP = 160;

  // ===================================================================
  //  simulation state (topBlockSTATE + the block linked list as an array)
  // ===================================================================
  const blocks = [];              // list order: [0] = oldest (root), [n-1] = newest (tail)
  let numFallingBlocks = 0;
  let highest = 0, highestFalling = 0;
  let eyeLine = 0, eyeX = 0, eyeY = 0, eyeZ = 0;
  let camX = 1, camY = 20, camZ = 25;
  let plusheight = 30;
  let worldRotation = 0;
  let followMode = 0, followRadius = 0, followAngle = 0, blockNodeFollow = null;
  // interpolation snapshots (previous tick's state)
  let pWorldRotation = 0, pEyeLine = 0, pEyeX = 0, pEyeY = 0, pEyeZ = 0;
  let simAccum = 0;

  const newBlockObj = () => ({ x: 0, y: 0, height: 0, pHeight: 0, rotation: 0, color: 0, falling: 0 });

  // init_topBlock: reset state, choose camera mode (non-follow / follow / override).
  function initSim() {
    blocks.length = 0;
    numFallingBlocks = 0;
    highest = 0; highestFalling = 0;
    eyeLine = 0; eyeX = 0; eyeY = 0; eyeZ = 0;
    followMode = 0; followRadius = 0; followAngle = 0; blockNodeFollow = null;
    camX = 1; camY = 20; camZ = 25;
    worldRotation = 0;
    if (config.follow) {
      plusheight = 100; camZ = camZ - 60;          // follow: camera pulled back, no initial spin
    } else {
      worldRotation = rng.random() % 360;          // non-follow: random start angle
      eyeY = 10; plusheight = 30;
    }
    if (config.override) {                          // tunnel mode overrides the camera + carpet
      plusheight = 100; camX = 0; camY = 1; camZ = 0; eyeX = -1; eyeY = 20; eyeZ = 0;
    }
    pWorldRotation = worldRotation; pEyeLine = eyeLine; pEyeX = eyeX; pEyeY = eyeY; pEyeZ = eyeZ;
    simAccum = 0;
  }

  // (re)build both display lists + the InstancedMesh capacity, then reset the sim. Called on
  // any STRUCTURAL knob change (size / resolution / nipples / blob / follow / override).
  function rebuild() {
    const s = clampSize();
    carpetWidth = 8 * s;                            // carpetWidth == carpetLength
    maxFalling = DEF_MAX_FALLING * s;
    resolutionFaces = effResolution();
    if (inst) { blocksGroup.remove(inst); inst.geometry.dispose(); inst.dispose(); inst = null; }
    if (carpetMesh) { worldRoot.remove(carpetMesh); carpetMesh.geometry.dispose(); carpetMesh = null; }
    const bg = config.blob ? buildBlobGeometry(resolutionFaces) : buildBlockGeometry(resolutionFaces, config.nipples);
    INST_CAP = maxFalling + 8;                      // list length stays <= maxFalling
    inst = new THREE.InstancedMesh(bg, blockMat, INST_CAP);
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    inst.frustumCulled = false;
    inst.count = 0;
    blocksGroup.add(inst);
    const cg = buildCarpetGeometry(carpetWidth, resolutionFaces, config.nipples);
    carpetMesh = new THREE.Mesh(cg, carpetMat);
    carpetMesh.frustumCulled = false;
    carpetMesh.position.set(-carpetWidth / 2, -carpetWidth / 2, 0);
    worldRoot.add(carpetMesh);
    initSim();
  }
  const structuralSig = () =>
    clampSize() + '|' + Math.max(4, Math.min(20, config.resolution | 0)) + '|' + config.nipples + '|' + config.blob + '|' + config.follow + '|' + config.override;
  let builtSig = structuralSig();
  rebuild();

  // generateNewBlock(): the random spawn gate + a fresh (or recycled) block at the top.
  function generateNewBlock() {
    const spawn = effSpawn();
    const half = carpetWidth / 2;                   // carpetLength/2, integer (8*size even)
    if ((rng.random() % spawn) === 1 &&
        highestFalling < getHeight((plusheight - blockHeight) + highest)) {
      numFallingBlocks++;
      let b;
      if (blocks.length === 0) {
        b = newBlockObj(); blocks.push(b);
      } else {
        if (numFallingBlocks >= maxFalling && blocks.length >= 2) {
          blocks.shift();                           // drop the oldest node (the .c leaks it)
          b = blocks.shift();                       // reuse the next node
        } else {
          b = newBlockObj();
        }
        blocks.push(b);                             // append at the tail
      }
      b.falling = 1;
      b.rotation = (rng.random() % 4) * 90;         // getOrientation(random()%4)
      let sox = 0, eox = 0, soy = 0, eoy = 0;
      if (b.rotation === 0) { sox = 1; eox = 0; soy = 3; eoy = -1; }
      else if (b.rotation === 90) { sox = 1; eox = -1; soy = 1; eoy = 0; }
      else if (b.rotation === 180) { sox = 1; eox = 0; soy = 3; eoy = -1; }
      else { sox = 5; eox = -1; soy = 1; eoy = 0; }
      b.x = (sox - half) + blockWidth * (rng.random() % (half + eox));
      b.y = (soy - half) + blockWidth * (rng.random() % (half + eoy));
      b.color = rng.random() % effMaxColors();
      b.height = getHeight(plusheight + highest);
      b.pHeight = b.height;                          // no interpolation on spawn
      if (numFallingBlocks >= maxFalling) { numFallingBlocks--; numFallingBlocks--; }
    }
  }

  // a block's 2nd footprint cell (it spans 2 grid cells; offset by blockWidth per orientation).
  let _c2x = 0, _c2y = 0;
  function footprint2(x, y, rot) {
    if (rot === 0) { _c2x = x; _c2y = y - 2; }
    else if (rot === 90) { _c2x = x + 2; _c2y = y; }
    else if (rot === 180) { _c2x = x; _c2y = y + 2; }
    else { _c2x = x - 2; _c2y = y; }
  }

  // the per-frame fall + collision pass (draw_topBlock's block loop).
  function updateBlocks() {
    const ds = effDropSpeed();
    highestFalling = 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.falling === 1) {
        if (b.height > highestFalling) highestFalling = b.height;
        b.height -= ds;                             // all blocks fall in lockstep
        if (b.height <= 0) {
          b.falling = 0;
          if (highest === 0) highest += blockHeight;
        }
        if (b.height <= highest + 1 && b.falling === 1) {
          footprint2(b.x, b.y, b.rotation);
          const c1x = b.x, c1y = b.y, c2x = _c2x, c2y = _c2y;
          for (let j = 0; j < blocks.length; j++) {
            const nd = blocks[j];
            if (nd.falling === 0 && b.falling === 1) {
              const n1x = nd.x, n1y = nd.y;
              footprint2(nd.x, nd.y, nd.rotation);
              const n2x = _c2x, n2y = _c2y;
              if ((c1x === n1x && c1y === n1y) || (c1x === n2x && c1y === n2y) ||
                  (c2x === n2x && c2y === n2y) || (c2x === n1x && c2y === n1y)) {
                if (Math.abs(b.height - (nd.height + blockHeight)) <= TOLERANCE) {
                  b.falling = 0;
                  b.height = nd.height + blockHeight;
                  if (Math.abs(b.height - highest) <= TOLERANCE + blockHeight) highest += blockHeight;
                }
              }
            }
          }
        }
      }
    }
    // pick the newest block as the follow target when the previous one has landed.
    if (followMode === 0 && blocks.length > 0) { blockNodeFollow = blocks[blocks.length - 1]; followMode = 1; }
  }

  // followBlock(): chase the target block; updates eyeX/eyeY/eyeZ/eyeLine (the gluLookAt is
  // built later in buildModelview, from the interpolated scalars).
  function quadrantCorrection(angle, cx, cy, x, y) {
    if (x >= cx && y >= cy) angle += (90 - (angle - 90) * 2);
    else if (x >= cx && y <= cy) angle += 90;
    else if (x <= cx && y <= cy) angle += 90;
    else if (x <= cx && y >= cy) angle += (90 - (angle - 90) * 2);
    return angle - 180;
  }
  function followBlock() {
    const cx = 0, cy = 0;
    if (blockNodeFollow !== null && followMode === 1) {
      if (highest > eyeLine) eyeLine += (highest - eyeLine) / 100;
      if (blockNodeFollow.height > eyeZ) eyeZ += (blockNodeFollow.height - eyeZ) / 100;
      if (blockNodeFollow.height < eyeZ) eyeZ -= (eyeZ - blockNodeFollow.height) / 100;
      if (followRadius === 0) {
        const xLen = blockNodeFollow.x - cx, yLen = blockNodeFollow.y - cy;
        followRadius = Math.sqrt(xLen * xLen + yLen * yLen);
        followAngle = followRadius !== 0 ? (180 / Math.PI) * Math.asin(xLen / followRadius) : 0;
        followAngle = quadrantCorrection(followAngle, cx, cy, Math.trunc(blockNodeFollow.x), Math.trunc(blockNodeFollow.y));
      }
      const rangle = (followAngle + worldRotation) * Math.PI / 180;
      const xTarget = Math.cos(rangle) * followRadius + cx;
      const yTarget = Math.sin(rangle) * followRadius + cy;
      if (followAngle > 360) followAngle -= 360;
      if (xTarget < eyeX) eyeX -= (eyeX - xTarget) / 100;
      if (xTarget > eyeX) eyeX += (xTarget - eyeX) / 100;
      if (yTarget < eyeY) eyeY -= (eyeY - yTarget) / 100;
      if (yTarget > eyeY) eyeY += (yTarget - eyeY) / 100;
      if (!blockNodeFollow.falling) { followMode = 0; followRadius = 0; }
    }
  }

  // one original-frame of simulation.
  function simStep() {
    for (let i = 0; i < blocks.length; i++) blocks[i].pHeight = blocks[i].height;   // interp snapshot
    pWorldRotation = worldRotation; pEyeLine = eyeLine; pEyeX = eyeX; pEyeY = eyeY; pEyeZ = eyeZ;

    generateNewBlock();
    if (config.rotate) worldRotation += effRotateSpeed();
    if (worldRotation >= 360) worldRotation -= 360;
    if (config.follow) followBlock();
    else if (highest > eyeLine) eyeLine += (highest - eyeLine) / 100;   // smooth camera rise
    updateBlocks();
  }

  // ===================================================================
  //  camera modelview (baked into worldRoot.matrix, interpolated per rAF)
  // ===================================================================
  const _e = new THREE.Vector3(), _f = new THREE.Vector3(), _up = new THREE.Vector3(), _sv = new THREE.Vector3(), _uv = new THREE.Vector3();
  function setLookAt(m, ex, ey, ez, cx, cy, cz, ux, uy, uz) {
    _e.set(ex, ey, ez);
    _f.set(cx - ex, cy - ey, cz - ez).normalize();
    _up.set(ux, uy, uz);
    _sv.copy(_f).cross(_up).normalize();            // s = normalize(f x up)
    _uv.copy(_sv).cross(_f);                         // u = s x f
    m.set(
      _sv.x, _sv.y, _sv.z, -_sv.dot(_e),
      _uv.x, _uv.y, _uv.z, -_uv.dot(_e),
      -_f.x, -_f.y, -_f.z, _f.dot(_e),
      0, 0, 0, 1,
    );
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpAngleDeg = (a, b, t) => { let d = b - a; if (d > 180) d -= 360; else if (d < -180) d += 360; return a + d * t; };
  const _M = new THREE.Matrix4(), _tmp = new THREE.Matrix4(), _look = new THREE.Matrix4();
  function buildModelview(frac) {
    const rot = lerpAngleDeg(pWorldRotation, worldRotation, frac);
    const el = lerp(pEyeLine, eyeLine, frac);
    const ex = lerp(pEyeX, eyeX, frac), ey = lerp(pEyeY, eyeY, frac), ez = lerp(pEyeZ, eyeZ, frac);
    if (!config.follow) {
      // gluLookAt(cam, eye+eyeLine, up +y) . Rx(90) . Rz(rotation)
      setLookAt(_M, camX, camY + el, camZ, ex, ey + el, ez, 0, 1, 0);
      _M.multiply(_tmp.makeRotationX(Math.PI / 2));
      _M.multiply(_tmp.makeRotationZ(rot * DEG));
    } else {
      // Rz(90) . gluLookAt(follow, up -x) . Rz(rotation)
      _M.makeRotationZ(Math.PI / 2);
      setLookAt(_look, camX, camY, camZ - el, ex, ey, -ez, -1, 0, 0);
      _M.multiply(_look);
      _M.multiply(_tmp.makeRotationZ(rot * DEG));
    }
    worldRoot.matrix.copy(_M);
    worldRoot.matrixWorldNeedsUpdate = true;
  }

  // ---- per-frame instance buffer (draw_topBlock's per-block translate+rotate) ----
  const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s1 = new THREE.Vector3(1, 1, 1);
  const _im = new THREE.Matrix4(), _zaxis = new THREE.Vector3(0, 0, 1);
  function updateInstances(frac) {
    const n = Math.min(blocks.length, INST_CAP);
    for (let i = 0; i < n; i++) {
      const b = blocks[i];
      const h = lerp(b.pHeight, b.height, frac);
      _p.set(b.x, b.y, -h);                          // glTranslatef(x, y, -height)
      _q.setFromAxisAngle(_zaxis, b.rotation * DEG); // glRotatef(rotation, z)
      _im.compose(_p, _q, _s1);
      inst.setMatrixAt(i, _im);
      inst.setColorAt(i, BLOCK_COLORS[b.color]);
    }
    inst.count = n;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  }

  // ---- sizing (reshape_topBlock: gluPerspective + the tiny-window middle-crop) ----
  function syncSize() {
    const w = window.innerWidth, h0 = window.innerHeight;
    let h = h0 / w, y = 0, vpH = h0;
    if (w > h0 * 5) { vpH = w * 1.5; y = -vpH * 0.2; h = vpH / w; }   // tiny window: show middle
    renderer.setSize(w, h0, false);
    renderer.setViewport(0, y, w, vpH);
    camera.aspect = 1 / h;                            // gluPerspective(60, 1/h, ...)
    camera.updateProjectionMatrix();
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop: render every rAF; tick the sim at effFps ----
  let raf = 0, last = 0, paused = false, ms = 16;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    const sig = structuralSig();
    if (sig !== builtSig) { builtSig = sig; rebuild(); }

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    simAccum += dt * effFps;
    let ticks = 0;
    while (simAccum >= 1 && ticks < MAX_TICKS) { simStep(); simAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) simAccum = 0;            // drop backlog after a stall
    const frac = simAccum;

    // drawCarpet: off in tunnel mode, and once the pile towers past 5*maxFalling.
    const drawCarpet = config.carpet && !config.override && highest <= 5 * maxFalling;
    carpetMesh.visible = drawCarpet;
    blocksGroup.position.z = drawCarpet ? -0.55 : 0; // the .c's post-carpet z shift for blocks

    buildModelview(frac);
    updateInstances(frac);
    blockMat.wireframe = config.wire;
    carpetMat.wireframe = config.wire;

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      if (inst) { inst.geometry.dispose(); inst.dispose(); }
      if (carpetMesh) carpetMesh.geometry.dispose();
      blockMat.dispose();
      carpetMat.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { initSim(); },      // fresh world (host 're-seed')
    config,
    params,
  };
}

export default { title, info, start };
