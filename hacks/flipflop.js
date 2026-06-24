// flipflop.js -- "Flip Flop" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's flipflop (Kevin Ogden & Sergio Gutierrez, 2003;
// later hacked on by Andrew Galante), hacks/glx/flipflop.c. A flat NxM board of
// square tiles laid out as a diagonal red/blue/yellow stripe pattern; a handful of
// cells are empty. Each frame the sim attempts many random single-cell moves: a tile
// FLIPS end-over-end about the shared edge into an adjacent empty cell, arcing up and
// over. The board slowly spins about its vertical axis under a fixed 22.5-degree tilt.
//
// Self-contained on purpose (own overlay canvas + renderer + render loop), like
// glknots.js / dangerball.js -- it only follows the host's mountable-module contract.
//
// Faithful to the .c:
//   * init_flipflop(): board_x = size-x, board_y = size-y, board_avg = (x+y)/2
//     (integer div). tiles mode: half_thick = 4/100, numsquares = x*y*95/100 (int);
//     sticks mode: half_thick = 54/100, numsquares = x*y*80/100 (int). Defaults 9x9
//     tiles -> 76 tiles on 81 cells (5 empty). flipspeed 0.03, reldist 1, energy 40.
//   * randsheet_initialize(): fill cells in (i outer, j inner) order with tiles 0..
//     numsquares-1; the rest empty (-1). Each tile's color is fixed at birth from
//     k=(i+j)%3: k==0 -> RED (1,0,0), k==1 -> BLUE (0,0,1), k==2 -> YELLOW (1,1,0).
//     Tiles carry their color forever, so the stripes scramble as tiles shuffle.
//   * randsheet_new_move(): pick num = random()%numsquares and dir = random()%4+1
//     (BOTH rolled before the moving-check, to match RNG consumption); if that tile
//     is at rest and the neighbor cell in `dir` is in-bounds and empty, reserve it
//     (occupied[target]=num, occupied[source]=-1) and set direction. Called `energy`
//     (40) times per frame -- most attempts fail (few free cells).
//   * randsheet_move(rot): every moving tile's angle += rot; at angle>=PI it snaps
//     (xpos/ypos step by +-1, direction=0, angle=0). rot = flipspeed*PI per frame.
//   * randsheet_draw(): per tile, glTranslatef + glRotatef about the pivot edge then
//     draw the box. dir 1(+x): T(i+1,0,j) Rz(PI-angle); dir 2(+y): T(i,0,j+1)
//     Rx(-(PI-angle)); dir 3(-x): T(i,0,j) Rz(angle); dir 4(-y): T(i,0,j) Rx(-angle);
//     dir 0: T(i,0,j). The box spans [ht,1-ht] in x,z and [-ht,ht] in y (a thin slab
//     with a half_thick gap to the cell border -> the black grid lines).
//   * display() modelview: T(0,0,-reldist*board_avg), Rx(22.5), Ry(theta*100),
//     T(-0.5*board_x, 0, -0.5*board_y); reproduced as a nested group hierarchy with
//     the camera left at the origin (so modelViewMatrix == the GL modelview stack).
//     theta += 0.01*spin per frame -> board spin about y.
//   * reshape_flipflop(): gluPerspective(45, w/h, 1, 300).
//   * lighting (setup_lights + display): a POSITIONAL light fixed in EYE space at
//     (0, board_avg*0.3, 0) (the .c sets GL_POSITION with modelview==identity at init,
//     so it never moves with the board). GL_CONSTANT_ATTENUATION 1.2, GL_LINEAR and
//     GL_QUADRATIC 0.15/board_avg. Light ambient 0.8, diffuse 1 (GL default); global
//     (light-model) ambient 0.2. Material tracks glColor for AMBIENT_AND_DIFFUSE
//     (glColorMaterial GL_FRONT), specular 0 (matte). Cull GL_BACK, depth test on.
//
// LIGHTING (deliberate, faithful, documented in flipflop.md): this is the ONE GL hack
// that sets NON-default distance attenuation, so the sibling ports' "PointLight,
// decay=0" idiom (which gives no falloff) can't reproduce it, and three's PointLight
// falloff is 1/d^2 (+optional window), not GL's 1/(kc+kl*d+kq*d^2). So the tiles use a
// small custom ShaderMaterial that transcribes the fixed-function equation exactly:
//     col = 0.2*C + att*(0.8 + max(N.L,0))*C,   att = 1/(1.2 + k*d + k*d*d)
// with C = tile color, d = eye-space distance to the eye-fixed light (0, avg*0.3, 0),
// k = 0.15/avg, then clamped to [0,1]. Specular is zero so there is no highlight term.
// This is why near tiles read near-saturated and far tiles darken, as in the JPEG. The
// shader writes gl_FragColor raw (no colorspace/tonemapping chunk) so, with color
// management disabled, the framebuffer gets the raw values the GL pipeline would --
// matching the screenshot (same convention as glknots.js's MeshPhongMaterial).
//
// TEXTURE OMITTED: flipflop's optional -textured mode (DEF_TEXTURED "False", off by
// default) grabs a DESKTOP SCREENSHOT and maps it across the tiles, scrambling it as
// they move. A browser has no desktop to grab, so the grab/texture path is omitted
// entirely (no substitute image). The default is the solid-colored board ported here.
// The xml's "Load image" checkbox is mirrored as an inert no-op (see flipflop.md).
//
// RNG (yarandom.js): the .c's random() is xscreensaver's ya_random(); moves use
// rng.random()%numsquares and rng.random()%4+1, matching the C consumption order.
// PACING: render every rAF; effFps = 1e6/(delay+OVERHEAD). Continuous motion (flip
// angle, board spin) advances by frames = dt*effFps; the discrete move attempts tick
// at effFps (40 per tick, catch-up capped at 8). The initial layout is deterministic
// (as in the .c); only the shuffle is random.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding), and the screenshots capture those raw
// values. Disable three's color management so our colors are used raw; the custom
// tile shader additionally omits the colorspace/tonemapping chunks, so its output is
// the raw lit value -- matching GL and the reference screenshot.
THREE.ColorManagement.enabled = false;

export const title = 'flipflop';

export const info = {
  author: 'Kevin Ogden and Sergio Gutierrez',
  year: 2003,
  description: 'Colored tiles swap with each other.',
};

export function start(hostCanvas, opts = {}) {
  // ---- constants (flipflop.c DEFAULTS / #defines) ----
  const OVERHEAD = 37500;     // us; the GL family's shared measured overhead (see
                              // glknots.js / framerate-calibration). xml delay 20000
                              // -> effFps = 1e6/57500 ~= 17.4 fps.
  const ENERGY = 40;          // c->energy: move ATTEMPTS per frame
  const FLIPSPEED = 0.03;     // c->flipspeed: rot per frame = FLIPSPEED*PI
  const RELDIST = 1;          // c->reldist: camera distance = reldist*board_avg
  const TILT = 22.5;          // glRotatef(22.5, 1,0,0): fixed board tilt (degrees)
  const TILE_THICK = 4, TILE_RATIO = 95;    // DEF_TILE_THICK / DEF_TILE_RATIO (/100)
  const STICK_THICK = 54, STICK_RATIO = 80; // DEF_STICK_THICK / DEF_STICK_RATIO (/100)
  const MAX_TICKS = 8;        // move-attempt catch-up cap (avoids a burst after a stall)

  // Knobs transcribed 1:1 from hacks/flipflop.xml (host renders `params`, mutates
  // `config` in place). Init from `config`, not param.default.
  const config = {
    delay: 20000,       // us (xml default; invert slider)
    spin: 0.1,          // board angular velocity (xml --spin)
    mode: 'tiles',      // 'tiles' | 'sticks' (xml <select>)
    sizeX: 9,           // board width  (xml --size-x)
    sizeY: 9,           // board depth  (xml --size-y)
    texture: false,     // "Load image" -- INERT no-op (no desktop to grab); see header
    wire: false,        // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'spin', label: 'Spin', type: 'range', min: 0, max: 3.0, step: 0.01, default: 0.1, lowLabel: 'Stopped', highLabel: 'Whirlwind', live: true },
    {
      key: 'mode', label: 'Mode', type: 'select', default: 'tiles', live: true,
      options: [
        { value: 'tiles', label: 'Draw Tiles' },
        { value: 'sticks', label: 'Draw Sticks' },
      ],
    },
    { key: 'sizeX', label: 'Width', type: 'range', min: 3, max: 20, step: 1, default: 9, live: true },
    { key: 'sizeY', label: 'Depth', type: 'range', min: 3, max: 20, step: 1, default: 9, live: true },
    { key: 'texture', label: 'Load image', type: 'checkbox', default: false, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);

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
  renderer.setClearColor(0x000000, 1);   // GL default clear color; clearbits COLOR|DEPTH

  const scene = new THREE.Scene();

  // Camera left at the ORIGIN with default orientation (looking down -z). This makes
  // three's view matrix the identity, so modelViewMatrix == the GL modelview stack we
  // build as groups, and the eye-fixed light constant below is correct in eye space.
  // gluPerspective(45, w/h, 1, 300).
  const camera = new THREE.PerspectiveCamera(45, 1, 1.0, 300.0);

  // ---- custom tile material: the GL fixed-function lighting equation ----
  // Eye-space per-fragment: col = 0.2*C + att*(0.8 + max(N.L,0))*C, clamped to [0,1],
  // att = 1/(1.2 + k*d + k*d*d). uWire>0.5 => flat unlit color (wireframe mode, in
  // which the .c disables lighting). Raw gl_FragColor (no colorspace/tonemapping).
  const baseMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Vector3(1, 1, 1) },   // tile RGB (raw)
      uLightPos: { value: new THREE.Vector3(0, 0, 0) }, // eye-space light (0, avg*0.3, 0)
      uAtt: { value: 0 },                               // linear=quadratic coeff 0.15/avg
      uWire: { value: 0 },
    },
    vertexShader: [
      'varying vec3 vView;',
      'varying vec3 vNormal;',
      'void main() {',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  vView = mv.xyz;',
      '  vNormal = normalMatrix * normal;',
      '  gl_Position = projectionMatrix * mv;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uColor;',
      'uniform vec3 uLightPos;',
      'uniform float uAtt;',
      'uniform float uWire;',
      'varying vec3 vView;',
      'varying vec3 vNormal;',
      'void main() {',
      '  if (uWire > 0.5) { gl_FragColor = vec4(uColor, 1.0); return; }',
      '  vec3 N = normalize(vNormal);',
      '  vec3 d = uLightPos - vView;',
      '  float dist = length(d);',
      '  vec3 L = d / dist;',
      '  float att = 1.0 / (1.2 + uAtt * dist + uAtt * dist * dist);',
      '  float ndotl = max(dot(N, L), 0.0);',
      '  vec3 col = 0.2 * uColor + att * (0.8 + ndotl) * uColor;',
      '  gl_FragColor = vec4(min(col, vec3(1.0)), 1.0);',
      '}',
    ].join('\n'),
    side: THREE.FrontSide,   // glEnable(GL_CULL_FACE); glCullFace(GL_BACK)
  });

  // modelview nesting (outer->inner), mirroring display()'s glTranslatef/glRotatef:
  //   boardRoot : Translate(0,0,-reldist*board_avg)
  //   tiltGroup : Rotate(22.5, x)
  //   spinGroup : Rotate(theta*100, y)
  //   center    : Translate(-0.5*board_x, 0, -0.5*board_y)   -> tile meshes
  const boardRoot = new THREE.Group();
  const tiltGroup = new THREE.Group();
  const spinGroup = new THREE.Group();
  const centerGroup = new THREE.Group();
  tiltGroup.rotation.x = THREE.MathUtils.degToRad(TILT);
  boardRoot.add(tiltGroup); tiltGroup.add(spinGroup); spinGroup.add(centerGroup);
  scene.add(boardRoot);

  // ---- board state (allocated per build) ----
  let boardX = 9, boardY = 9, boardAvg = 9, numsquares = 76, halfThick = 0.04;
  let occupied = null;   // Int32Array(boardX*boardY): tile index or -1
  let xpos = null, ypos = null, direction = null, angle = null;  // per-tile state
  let tiles = [];        // { mesh, material } per tile index
  let boxGeom = null;    // shared tile box
  let theta = 0;         // board spin accumulator (as in the .c)
  let builtMode = null, builtSizeX = -1, builtSizeY = -1, builtWire = null;

  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

  // init_flipflop + randsheet_create + randsheet_initialize, as one (re)build.
  function buildBoard() {
    // tear down any previous board
    for (const t of tiles) { centerGroup.remove(t.mesh); t.material.dispose(); }
    tiles = [];
    if (boxGeom) { boxGeom.dispose(); boxGeom = null; }

    boardX = clampInt(config.sizeX, 2, 100);
    boardY = clampInt(config.sizeY, 2, 100);
    boardAvg = Math.floor((boardX + boardY) / 2);
    const sticks = config.mode === 'sticks';
    halfThick = (sticks ? STICK_THICK : TILE_THICK) / 100;
    const ratio = sticks ? STICK_RATIO : TILE_RATIO;
    numsquares = Math.floor((boardX * boardY * ratio) / 100);
    if (numsquares < 1) numsquares = 1;
    if (numsquares >= boardX * boardY) numsquares = boardX * boardY - 1; // keep >=1 free

    // camera distance + centering (display() translates)
    boardRoot.position.set(0, 0, -RELDIST * boardAvg);
    centerGroup.position.set(-0.5 * boardX, 0, -0.5 * boardY);

    // eye-fixed light + its attenuation (setup_lights + display())
    const lightY = boardAvg * 0.3;
    const attK = 0.15 / boardAvg;

    // tile box: spans [ht,1-ht] in x,z and [-ht,ht] in y; centered at (0.5,0,0.5). abs()
    // keeps sticks (ht=0.54 -> a thin tall stick) a valid, outward-normalled box.
    const w = Math.abs(1 - 2 * halfThick);
    boxGeom = new THREE.BoxGeometry(w, 2 * halfThick, w);
    boxGeom.translate(0.5, 0, 0.5);

    occupied = new Int32Array(boardX * boardY);
    xpos = new Int32Array(numsquares);
    ypos = new Int32Array(numsquares);
    direction = new Int32Array(numsquares);   // 0 at rest; 1..4 moving
    angle = new Float32Array(numsquares);

    let index = 0;
    for (let i = 0; i < boardX; i++) {
      for (let j = 0; j < boardY; j++) {
        if (index < numsquares) {
          occupied[i * boardY + j] = index;
          xpos[index] = i; ypos[index] = j;
          // color pattern: k=(i+j)%3 -> red / blue / yellow (see header)
          const k = (i + j) % 3;
          const r = (k === 0 || k === 2) ? 1 : 0;
          const g = (k === 2) ? 1 : 0;
          const b = (k === 1) ? 1 : 0;
          const mat = baseMaterial.clone();
          mat.uniforms.uColor.value = new THREE.Vector3(r, g, b);
          mat.uniforms.uLightPos.value = new THREE.Vector3(0, lightY, 0);
          mat.uniforms.uAtt.value = attK;
          mat.uniforms.uWire.value = config.wire ? 1 : 0;
          mat.wireframe = config.wire;
          const mesh = new THREE.Mesh(boxGeom, mat);
          mesh.matrixAutoUpdate = true;
          centerGroup.add(mesh);
          tiles.push({ mesh, material: mat });
          index++;
        } else {
          occupied[i * boardY + j] = -1;
        }
      }
    }
    builtMode = config.mode; builtSizeX = config.sizeX; builtSizeY = config.sizeY;
    builtWire = config.wire;
  }

  // randsheet_new_move(): one random move ATTEMPT. Rolls num and dir unconditionally
  // (matching the .c's RNG order), then moves only if the tile is at rest and the
  // target neighbor is in-bounds and empty. Reserves the target and frees the source
  // immediately; xpos/ypos update only when the flip finishes (in stepFlips).
  function newMove() {
    const num = rng.random() % numsquares;
    const i = xpos[num], j = ypos[num];
    const dir = (rng.random() % 4) + 1;
    if (direction[num] !== 0) return;
    if (dir === 1) {                 // +x
      if (i + 1 < boardX && occupied[(i + 1) * boardY + j] === -1) {
        direction[num] = dir; occupied[(i + 1) * boardY + j] = num; occupied[i * boardY + j] = -1;
      }
    } else if (dir === 2) {          // +y
      if (j + 1 < boardY && occupied[i * boardY + (j + 1)] === -1) {
        direction[num] = dir; occupied[i * boardY + (j + 1)] = num; occupied[i * boardY + j] = -1;
      }
    } else if (dir === 3) {          // -x
      if (i - 1 >= 0 && occupied[(i - 1) * boardY + j] === -1) {
        direction[num] = dir; occupied[(i - 1) * boardY + j] = num; occupied[i * boardY + j] = -1;
      }
    } else if (dir === 4) {          // -y
      if (j - 1 >= 0 && occupied[i * boardY + (j - 1)] === -1) {
        direction[num] = dir; occupied[i * boardY + (j - 1)] = num; occupied[i * boardY + j] = -1;
      }
    }
  }

  // randsheet_move(rot): advance every moving tile; snap position at angle>=PI.
  function stepFlips(rot) {
    for (let index = 0; index < numsquares; index++) {
      const d = direction[index];
      if (d === 0) continue;
      angle[index] += rot;
      if (angle[index] >= Math.PI) {
        if (d === 1) xpos[index] += 1;
        else if (d === 2) ypos[index] += 1;
        else if (d === 3) xpos[index] -= 1;
        else if (d === 4) ypos[index] -= 1;
        direction[index] = 0;
        angle[index] = 0;
      }
    }
  }

  // randsheet_draw(): place each tile mesh at its pivot with the flip rotation.
  function updateTiles() {
    for (let index = 0; index < numsquares; index++) {
      const mesh = tiles[index].mesh;
      const i = xpos[index], j = ypos[index], a = angle[index];
      switch (direction[index]) {
        case 1: mesh.position.set(i + 1, 0, j); mesh.rotation.set(0, 0, Math.PI - a); break;
        case 2: mesh.position.set(i, 0, j + 1); mesh.rotation.set(-(Math.PI - a), 0, 0); break;
        case 3: mesh.position.set(i, 0, j); mesh.rotation.set(0, 0, a); break;
        case 4: mesh.position.set(i, 0, j); mesh.rotation.set(-a, 0, 0); break;
        default: mesh.position.set(i, 0, j); mesh.rotation.set(0, 0, 0); break;
      }
    }
  }

  function applyWire() {
    for (const t of tiles) { t.material.uniforms.uWire.value = config.wire ? 1 : 0; t.material.wireframe = config.wire; }
    builtWire = config.wire;
  }

  buildBoard();

  // ---- sizing (reshape_flipflop: gluPerspective; the ultra-wide clamp is omitted) ----
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;   // gluPerspective(45, 1/h) with h=height/width => aspect w/h
    camera.updateProjectionMatrix();
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop ----
  let raf = 0, last = 0, paused = false, ms = 16;
  let moveAccum = 0;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    // live structural changes
    if (config.mode !== builtMode || config.sizeX !== builtSizeX || config.sizeY !== builtSizeY) buildBoard();
    else if (config.wire !== builtWire) applyWire();

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;

    // drawBoard() order: new_move x energy, then move, then (in display) theta.
    moveAccum += frames;
    let ticks = 0;
    while (moveAccum >= 1 && ticks < MAX_TICKS) {
      for (let k = 0; k < ENERGY; k++) newMove();
      moveAccum -= 1; ticks++;
    }
    if (ticks === MAX_TICKS) moveAccum = 0;

    stepFlips(FLIPSPEED * Math.PI * frames);   // continuous flip advance
    theta += 0.01 * config.spin * frames;      // continuous board spin
    spinGroup.rotation.y = THREE.MathUtils.degToRad(theta * 100);

    updateTiles();
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      for (const t of tiles) t.material.dispose();
      if (boxGeom) boxGeom.dispose();
      baseMaterial.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { buildBoard(); theta = 0; },   // reset to the starting layout (host 're-seed')
    config,
    params,
  };
}

export default { title, info, start };
