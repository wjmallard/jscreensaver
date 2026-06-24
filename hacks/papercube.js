// papercube.js -- "Paper Cube" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's papercube (Ireneusz Szpilewski & Jamie
// Zawinski, 2023), hacks/glx/papercube.c. A flat "net" of paper squares (16
// unit tiles, each a textured quad with a black border) folds itself up into a
// cube along a fixed tree of creases, holds, spins, and fades away -- then a new
// random-coloured net fades in and does it again. The whole assembly tumbles and
// wanders via the shared rotator.
//
// THE NET (papercube.c's `map`): a 6x5 grid of fields ('o'/'^' at even text
// cells) joined by '+' creases (hinges). Field row 0 is the bottom text line,
// row 5 the top; column 0 is the left. 16 fields, 15 creases => a spanning tree
// rooted at the base field (1,1). Layout (row 5 top .. row 0 bottom):
//     row5:            (5,2)^         row2: (2,0)(2,1)(2,2)(2,3)
//     row4:            (4,2)          row1: (1,0)(1,1)(1,2)(1,3)(1,4)
//     row3:            (3,2)          row0: (0,0)(0,1)(0,2)(0,3)
// Each field is a 1x1 quad on the y=0 plane spanning x in [col,col+1],
// z in [-row,-(row+height)]. Folding is done by paint_field_and_neighbours()'s
// recursion: for each child crease it does glTranslate(axis)/glRotate(sign*angle,
// hinge-axis)/glTranslate(-axis) then recurses -- so a crease carries its whole
// sub-flap. We reproduce that with a persistent tree of nested groups
// (pivot: pos=hinge, rot=sign*angle ; inner: pos=-hinge) whose field meshes keep
// ABSOLUTE coordinates, so the nesting reproduces the exact matrix stack. The
// hinge `axis` is the shared-edge coordinate; sign = (axis <= 1) ? -1 : 1.
//
// THE FOLD SCHEDULE (initialize_moves): time-based moves (wall clock, so
// frame-rate independent). Stage Sunrise fades brightness 0->1 (glColor modulates
// the texture, GL_MODULATE); stage Fold plays 17 field moves (15 tiles fold 0->90
// deg in sequence, with a 1/3 and a 4/3 special, then two closing moves that take
// tile (4,2) 30->90 and the arrow tile (5,2) 120->90 while "inserting"); stage
// Spin_and_sunset spins about Y for 5 revolutions and fades brightness 1->0, then
// re-initialises (new random fg/bg, toggled grid, random eye angle & spin sign).
// speed scales every duration (base/speed) and the rotator (0.5*speed / 0.01*speed).
// We keep the schedule at speed=1 and advance the clock by dt*speed -- exactly
// equivalent, and it tracks the live speed knob without rebuilding.
//
// THE ARROW TILE (5,2, symbol '^'): drawn as a rectangle + a tapering arrow tip
// (paint_field's arrow branch), and when "inserting" its height =
// 2*cos(pi - pi*angle/180) shrinks 1->0 as it tucks into the cube (angle 120->90).
// Its geometry is rebuilt every frame; every other tile is a static unit square.
//
// RENDERING: NO lighting (reshape_cube does glDisable(GL_LIGHT0) and never enables
// GL_LIGHTING) -- flat unlit textured quads. One shared MeshBasicMaterial (map =
// the paper DataTexture, color = the (brightness,brightness,brightness) sun),
// DoubleSide (GL_CULL_FACE is off), opaque, depth-tested. The texture is a 128x128
// solid fg colour with a 2px black border (+ optional grid in bg on alternate
// cycles), sampled raw (NoColorSpace, LinearFilter) so GL_MODULATE matches.
//
// Motion (rotator.js) and RNG (yarandom.js) are faithful standalone ports.
// PACING: render every rAF; effFps = 1e6/(delay+OVERHEAD); the rotator's discrete
// random walk is ticked at effFps and INTERPOLATED for smoothness (the dangerball/
// glknots pattern); the fold clock runs off real wall-clock seconds * speed.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';

// xscreensaver's GL fixed pipeline does NO colour management -- raw glColor / raw
// texels to the framebuffer (no sRGB encoding), and the screenshots capture those
// raw values. Disable three's colour management so the port matches GL.
THREE.ColorManagement.enabled = false;

export const title = 'papercube';

export const info = {
  author: 'Ireneusz Szpilewski and Jamie Zawinski',
  year: 2023,
  description: 'How to make a glueless paper cube.',
};

export function start(hostCanvas, opts = {}) {
  // ---- constants (papercube.c #defines) ----
  const BOTTOM_FIELD_ROW = 1;
  const BOTTOM_FIELD_COLUMN = 1;
  const SUN_DURATION = 2.0;
  const FOLD_DURATION = 1.0;
  const PAUSE_DURATION = 1.0;
  const SPIN_DURATION = 3.0;
  const SPIN_RPS = 1.0;
  const PRESERVED_HEIGHT_TO_WIDTH = 1.0;
  const ARROW_HEIGHT = 5.0 / 8.0;
  const ARROW_WIDTH = 1.0 / 8.0;

  // picture (texture) constants
  const PIC_SIZE = 128;                 // square_count(8) * square_size(16)
  const PIC_SQUARE = 16;
  const PIC_SQUARES = 8;
  const PIC_LINE = 2;
  const PIC_BORDER = 2;

  const MAX_TICKS = 8;                   // rotator catch-up cap
  const DEG2RAD = Math.PI / 180;
  const TWO_PI = Math.PI * 2;

  // us; the GL family's shared measured overhead (gears/pipes/glknots/...). Live GL
  // hacks can't be timed under this machine's XQuartz Apple-DRI block, so every
  // three.js port adopts 37500. xml delay 30000 -> effFps = 1e6/67500 ~= 14.8fps.
  const OVERHEAD = 37500;

  // Knobs transcribed 1:1 from hacks/papercube.xml. `rotation` mirrors the xml
  // <select> (DEF_SPIN "Y" => default Rotate around Y). `speed` scales both the
  // fold timeline and the rotator (papercube.c bakes 0.5*speed / 0.01*speed).
  const config = {
    delay: 30000,        // us (xml default; slider inverted)
    speed: 1.0,          // fold + tumble speed
    wander: true,        // drift through space (do_wander)
    rotation: 'Y',       // spin axes (DEF_SPIN "Y")
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.02, max: 5.0, step: 0.01, default: 1.0, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    {
      key: 'rotation', label: 'Rotation', type: 'select', default: 'Y', live: true,
      options: [
        { value: '0', label: 'Don\'t rotate' },
        { value: 'X', label: 'Rotate around X axis' },
        { value: 'Y', label: 'Rotate around Y axis' },
        { value: 'Z', label: 'Rotate around Z axis' },
        { value: 'XY', label: 'Rotate around X and Y axes' },
        { value: 'XZ', label: 'Rotate around X and Z axes' },
        { value: 'YZ', label: 'Rotate around Y and Z axes' },
        { value: 'XYZ', label: 'Rotate around all three axes' },
      ],
    },
  ];

  const rng = makeYaRandom(opts.seed || 0);

  // ===================================================================
  //  the fold tree (papercube.c's `map`, resolved to the spanning tree
  //  rooted at the base field (1,1)). Per non-root node: o = hinge
  //  orientation ('H' rotate about Z at x=axis, 'V' rotate about X at
  //  z=-axis), axis = shared-edge coord, sign = (axis <= 1) ? -1 : 1.
  // ===================================================================
  const TREE = {
    row: 1, col: 1, arrow: false, children: [
      { row: 1, col: 0, o: 'H', axis: 1, sign: -1, arrow: false, children: [
        { row: 2, col: 0, o: 'V', axis: 2, sign: 1, arrow: false, children: [] },
        { row: 0, col: 0, o: 'V', axis: 1, sign: -1, arrow: false, children: [] },
      ] },
      { row: 1, col: 2, o: 'H', axis: 2, sign: 1, arrow: false, children: [
        { row: 2, col: 2, o: 'V', axis: 2, sign: 1, arrow: false, children: [
          { row: 3, col: 2, o: 'V', axis: 3, sign: 1, arrow: false, children: [
            { row: 4, col: 2, o: 'V', axis: 4, sign: 1, arrow: false, children: [
              { row: 5, col: 2, o: 'V', axis: 5, sign: 1, arrow: true, children: [] },
            ] },
          ] },
        ] },
        { row: 1, col: 3, o: 'H', axis: 3, sign: 1, arrow: false, children: [
          { row: 2, col: 3, o: 'V', axis: 2, sign: 1, arrow: false, children: [] },
          { row: 0, col: 3, o: 'V', axis: 1, sign: -1, arrow: false, children: [] },
          { row: 1, col: 4, o: 'H', axis: 4, sign: 1, arrow: false, children: [] },
        ] },
      ] },
      { row: 0, col: 1, o: 'V', axis: 1, sign: -1, arrow: false, children: [
        { row: 0, col: 2, o: 'H', axis: 2, sign: 1, arrow: false, children: [] },
      ] },
      { row: 2, col: 1, o: 'V', axis: 2, sign: 1, arrow: false, children: [] },
    ],
  };

  // per-field fold angle (degrees) + inserting flag: angles[row][col].
  const angles = [];
  for (let r = 0; r < 6; r++) {
    angles[r] = [];
    for (let c = 0; c < 5; c++) angles[r][c] = { angle: 0, inserting: false };
  }
  function resetAngles() {
    for (let r = 0; r < 6; r++)
      for (let c = 0; c < 5; c++) { angles[r][c].angle = 0; angles[r][c].inserting = false; }
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
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();

  // reshape_cube: gluPerspective(30, w/h, 1, 100) + gluLookAt(0,10,10, 0,0,0, 0,1,0).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 10, 10);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // ---- the paper texture (128x128 DataTexture: fg fill + black border + grid) ----
  const texData = new Uint8Array(PIC_SIZE * PIC_SIZE * 4);
  const tex = new THREE.DataTexture(texData, PIC_SIZE, PIC_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;   // GL_LINEAR
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.ClampToEdgeWrapping; // texcoords stay in [0,1]
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;   // raw sampling for GL_MODULATE

  function paintRect(x, y, w, h, c) {
    for (let i = 0; i < h; i++) {
      const rowBase = ((y + i) * PIC_SIZE + x) * 4;
      for (let j = 0; j < w; j++) {
        const o = rowBase + j * 4;
        texData[o] = c.r; texData[o + 1] = c.g; texData[o + 2] = c.b; texData[o + 3] = c.a;
      }
    }
  }
  // paint_picture: fill fg, optional grid (bg), black border.
  function paintTexture(fg, bg, showGrid) {
    paintRect(0, 0, PIC_SIZE, PIC_SIZE, fg);
    if (showGrid) {
      const half = PIC_LINE >> 1;                        // line_width/2
      for (let x = 1; x < PIC_SQUARES; x++) paintRect(x * PIC_SQUARE - half, 0, PIC_LINE, PIC_SIZE, bg);
      for (let y = 1; y < PIC_SQUARES; y++) paintRect(0, y * PIC_SQUARE - half, PIC_SIZE, PIC_LINE, bg);
    }
    const black = { r: 0, g: 0, b: 0, a: 255 };
    paintRect(0, 0, PIC_SIZE, PIC_BORDER, black);
    paintRect(0, 0, PIC_BORDER, PIC_SIZE, black);
    paintRect(0, PIC_SIZE - PIC_BORDER, PIC_SIZE, PIC_BORDER, black);
    paintRect(PIC_SIZE - PIC_BORDER, 0, PIC_BORDER, PIC_SIZE, black);
    tex.needsUpdate = true;
  }

  // GL_MODULATE: final = texel * glColor. MeshBasicMaterial multiplies map by
  // color; color carries the sun brightness. Unlit (no GL_LIGHTING), DoubleSide
  // (no GL_CULL_FACE), opaque, depth-tested. One material shared by all tiles.
  const material = new THREE.MeshBasicMaterial({
    map: tex,
    color: 0x000000,          // (brightness,brightness,brightness), set per frame
    side: THREE.DoubleSide,
  });

  // ---- arrow tile (5,2) dynamic geometry: rectangle + tapering tip (<=4 tris) ----
  const arrowPos = new Float32Array(12 * 3);
  const arrowUv = new Float32Array(12 * 2);
  const arrowGeom = new THREE.BufferGeometry();
  const arrowPosAttr = new THREE.BufferAttribute(arrowPos, 3); arrowPosAttr.setUsage(THREE.DynamicDrawUsage);
  const arrowUvAttr = new THREE.BufferAttribute(arrowUv, 2); arrowUvAttr.setUsage(THREE.DynamicDrawUsage);
  arrowGeom.setAttribute('position', arrowPosAttr);
  arrowGeom.setAttribute('uv', arrowUvAttr);

  // paint_field for the arrow tile: rebuild geometry from its current height.
  function updateArrow() {
    const a = angles[5][2];
    // height: NULL/not-inserting => 1; inserting => 2*cos(pi - pi*angle/180).
    let height = a.inserting ? 2.0 * Math.cos(Math.PI - Math.PI * a.angle / 180) : 1.0;
    let drawArrow, rectH;
    if (height > ARROW_HEIGHT) { drawArrow = true; rectH = ARROW_HEIGHT; }
    else { drawArrow = false; rectH = height; }

    const col = 2, row = 5;
    let n = 0;
    const push = (x, z, u, v) => {
      arrowPos[n * 3] = x; arrowPos[n * 3 + 1] = 0; arrowPos[n * 3 + 2] = z;
      arrowUv[n * 2] = u; arrowUv[n * 2 + 1] = v; n++;
    };
    // rectangle part (two triangles), texcoord v goes 0..rectH.
    push(col, -row, 0, 0);
    push(col, -(row + rectH), 0, rectH);
    push(col + 1, -row, 1, 0);
    push(col, -(row + rectH), 0, rectH);
    push(col + 1, -row, 1, 0);
    push(col + 1, -(row + rectH), 1, rectH);
    if (drawArrow) {
      const aw = ARROW_WIDTH * (height - ARROW_HEIGHT) / (1 - ARROW_HEIGHT);
      push(col, -(row + ARROW_HEIGHT), 0, ARROW_HEIGHT);
      push(col + aw, -(row + height), aw, height);
      push(col + 1, -(row + ARROW_HEIGHT), 1, ARROW_HEIGHT);
      push(col + 1, -(row + ARROW_HEIGHT), 1, ARROW_HEIGHT);
      push(col + 1 - aw, -(row + height), 1 - aw, height);
      push(col + aw, -(row + height), aw, height);
    }
    arrowGeom.setDrawRange(0, n);
    arrowPosAttr.needsUpdate = true;
    arrowUvAttr.needsUpdate = true;
  }

  // a plain 1x1 field quad at absolute (col,row), on the y=0 plane.
  function plainFieldGeometry(row, col) {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array([
      col, 0, -row,
      col, 0, -(row + 1),
      col + 1, 0, -row,
      col, 0, -(row + 1),
      col + 1, 0, -row,
      col + 1, 0, -(row + 1),
    ]);
    const uv = new Float32Array([
      0, 0, 0, 1, 1, 0,
      0, 1, 1, 0, 1, 1,
    ]);
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  }

  // modelview nesting (outer->inner), mirroring reshape + paint_papercube with the
  // reshape center-translate cancelling paint's leading center-translate:
  //   scale  : reshape portrait fit
  //   wander : get_position offset (x-.5)*3
  //   tumble : get_rotation glRotatef x,y,z * 360   (Euler XYZ)
  //   eyeSpin: glRotated(eye_rotation + spin_sign*spin_rotation, Y)
  //   center : translate(-(col+.5), -.5, row+.5) = (-1.5,-0.5,1.5)
  //   <fold tree>
  const scaleGroup = new THREE.Group();
  const wanderGroup = new THREE.Group();
  const tumbleGroup = new THREE.Group();
  const eyeSpinGroup = new THREE.Group();
  const centerGroup = new THREE.Group();
  centerGroup.position.set(-(BOTTOM_FIELD_COLUMN + 0.5), -0.5, BOTTOM_FIELD_ROW + 0.5);
  scene.add(scaleGroup);
  scaleGroup.add(wanderGroup);
  wanderGroup.add(tumbleGroup);
  tumbleGroup.add(eyeSpinGroup);
  eyeSpinGroup.add(centerGroup);

  // build the fold tree: pivot(pos=hinge, rot=sign*angle) > inner(pos=-hinge) >
  // {field mesh (absolute coords) + child pivots}, reproducing the C's nested
  // glTranslate(axis)/glRotate/glTranslate(-axis) matrix stack.
  const pivots = [];   // { row, col, o, sign, pivot } -- rotation set per frame
  function buildNode(node, parent, isRoot) {
    const geom = node.arrow ? arrowGeom : plainFieldGeometry(node.row, node.col);
    const mesh = new THREE.Mesh(geom, material);
    mesh.frustumCulled = false;
    let container;
    if (isRoot) {
      parent.add(mesh);
      container = parent;
    } else {
      const pivot = new THREE.Group();
      const inner = new THREE.Group();
      if (node.o === 'H') { pivot.position.set(node.axis, 0, 0); inner.position.set(-node.axis, 0, 0); }
      else { pivot.position.set(0, 0, -node.axis); inner.position.set(0, 0, node.axis); }
      pivot.add(inner);
      inner.add(mesh);
      parent.add(pivot);
      pivots.push({ row: node.row, col: node.col, o: node.o, sign: node.sign, pivot });
      container = inner;
    }
    for (const c of node.children) buildNode(c, container, false);
  }
  buildNode(TREE, centerGroup, true);

  // ===================================================================
  //  the fold schedule (initialize_moves), at speed=1; the clock is scaled
  //  by speed at advance time (moveTime += dt*speed), which is equivalent.
  // ===================================================================
  const mkMove = (start, stop, sv, ev) => ({ start, stop, startValue: sv, stopValue: ev, stage: 'Before_start' });
  const mkFieldMove = (start, stop, sv, ev, field, inserting) =>
    ({ start, stop, startValue: sv, stopValue: ev, field, inserting, stage: 'Before_start' });

  // fold sequence (initialize_moves fields[]) -- {row,col} order of the 15 folds.
  const FOLD_FIELDS = [
    { row: 0, col: 0 }, { row: 2, col: 0 }, { row: 1, col: 0 }, { row: 0, col: 2 }, { row: 0, col: 1 },
    { row: 2, col: 1 }, { row: 1, col: 2 }, { row: 1, col: 3 }, { row: 2, col: 3 }, { row: 0, col: 3 },
    { row: 1, col: 4 }, { row: 2, col: 2 }, { row: 3, col: 2 }, { row: 4, col: 2 }, { row: 5, col: 2 },
  ];

  let sunrise, spinMove, sunset;
  const fieldMoves = new Array(17);
  function buildSchedule() {
    const fold = FOLD_DURATION, pause = PAUSE_DURATION, sun_d = SUN_DURATION;
    const spin = SPIN_DURATION, spin_rps = SPIN_RPS;
    const ANGLE = 90.0, brightness = 1.0;
    let time = 0;

    sunrise = mkMove(time, sun_d, 0.0, brightness);
    time = sunrise.stop + pause;

    for (let i = 0; i < FOLD_FIELDS.length; i++) {
      const multi = (i === 13) ? (1.0 / 3.0) : (i === 14) ? (4.0 / 3.0) : 1.0;
      fieldMoves[i] = mkFieldMove(time, time + fold * multi, 0.0, ANGLE * multi, FOLD_FIELDS[i], false);
      time = fieldMoves[i].stop + pause;
    }
    fieldMoves[15] = mkFieldMove(time, time + fold * 2.0 / 3.0, 30.0, ANGLE, FOLD_FIELDS[13], false);
    fieldMoves[16] = mkFieldMove(time, time + fold * 2.0 / 3.0, 120.0, ANGLE, FOLD_FIELDS[14], true);
    time = fieldMoves[16].stop + pause;

    spinMove = mkMove(time, time + spin + sun_d, 0.0, (spin + sun_d) * spin_rps * 360);
    time += spin;
    sunset = mkMove(time, time + sun_d, brightness, 0.0);
  }
  function resetSchedule() {
    sunrise.stage = 'Before_start';
    for (let i = 0; i < 17; i++) fieldMoves[i].stage = 'Before_start';
    spinMove.stage = 'Before_start';
    sunset.stage = 'Before_start';
  }
  buildSchedule();

  // get_move_value: latches to After_stop; returns Stopping exactly once.
  function getMoveValue(m, time) {
    if (m.stage === 'After_stop') return { ms: 'After_stop' };
    if (m.stop <= time) { m.stage = 'After_stop'; return { ms: 'Stopping', value: m.stopValue }; }
    if (m.start <= time) {
      const value = m.startValue + (m.stopValue - m.startValue) * (time - m.start) / (m.stop - m.start);
      if (m.stage === 'Before_start') { m.stage = 'During_move'; return { ms: 'Starting', value }; }
      return { ms: 'During_move', value };
    }
    return { ms: 'Before_start' };
  }
  const isActive = (ms) => ms === 'Starting' || ms === 'During_move' || ms === 'Stopping';

  // move_fields: run all 17 moves; on Starting set inserting (then fall through to
  // set angle); on During/Stopping set angle. Returns whether move[16] (last) stopped.
  function moveFields() {
    let last = 'Before_start';
    for (let i = 0; i < 17; i++) {
      const fm = fieldMoves[i];
      const r = getMoveValue(fm, moveTime);
      last = r.ms;
      if (r.ms === 'Starting') {
        if (fm.inserting) angles[fm.field.row][fm.field.col].inserting = true;
        angles[fm.field.row][fm.field.col].angle = r.value;
      } else if (r.ms === 'During_move' || r.ms === 'Stopping') {
        angles[fm.field.row][fm.field.col].angle = r.value;
      }
    }
    return last === 'Stopping';
  }

  // move_papercube: advance the stage machine; returns true when it's time to
  // re-initialise (Spin_and_sunset's sunset stops).
  function movePapercube() {
    if (phase === 'Sunrise') {
      const r = getMoveValue(sunrise, moveTime);
      if (isActive(r.ms)) brightness = r.value;      // move_sun -> glColor(v,v,v)
      if (r.ms === 'Stopping') phase = 'Fold';
      return false;
    }
    if (phase === 'Fold') {
      if (moveFields()) phase = 'Spin_and_sunset';
      return false;
    }
    // Spin_and_sunset
    const rs = getMoveValue(spinMove, moveTime);
    if (isActive(rs.ms)) spinRotation = rs.value;    // move_spin
    const r = getMoveValue(sunset, moveTime);
    if (isActive(r.ms)) brightness = r.value;        // move_sun (fade out)
    return r.ms === 'Stopping';
  }

  // ---- lifecycle state ----
  let phase = 'Sunrise';
  let moveTime = 0;
  let brightness = 0;
  let eyeRotation = 45;
  let spinRotation = 0;
  let spinSign = 1;
  let showGrid = false;

  // initialize_papercube: new random paper colours (+ complementary bg), reset the
  // net + schedule, rebuild the texture. first_time keeps eye=45 / grid off.
  function reinitialize(firstTime) {
    if (firstTime) { eyeRotation = 45; showGrid = false; }
    else { eyeRotation = rng.random() % 360; showGrid = !showGrid; }

    spinSign = (rng.random() % 2) ? -1 : 1;
    spinRotation = 0;

    const fg = { r: 0, g: 0, b: 0, a: 255 };
    fg.r = Math.floor(255 * (0.5 + rng.frand(0.5)));
    fg.g = Math.floor(255 * (0.5 + rng.frand(0.5)));
    fg.b = Math.floor(255 * (0.5 + rng.frand(0.5)));
    const bg = {
      r: Math.floor(0.7 * (255 - fg.r)),
      g: Math.floor(0.7 * (255 - fg.g)),
      b: Math.floor(0.7 * (255 - fg.b)),
      a: 255,
    };

    resetAngles();
    resetSchedule();
    moveTime = 0;
    phase = 'Sunrise';
    brightness = 0;
    paintTexture(fg, bg, showGrid);
  }

  // ---- rotator (init_cube: make_rotator, spin_speed=0.5*speed, wander=0.01*speed,
  //  accel 0.3, randomize=False). Rebuilt on a rotation/speed change. ----
  let rot, builtSpin, builtSpeed;
  let prevR, curR, prevP, curP, rotAccum = 0;
  function rebuildRotator() {
    const sp = config.rotation;
    const sx = /x/i.test(sp), sy = /y/i.test(sp), sz = /z/i.test(sp);
    const spd = Math.max(0.001, config.speed);
    const spinSpeed = 0.5 * spd, wanderSpeed = 0.01 * spd;
    rot = makeRotator(
      {
        spinX: sx ? spinSpeed : 0,
        spinY: sy ? spinSpeed : 0,
        spinZ: sz ? spinSpeed : 0,
        spinAccel: 0.3,
        wanderSpeed: wanderSpeed,   // gated by config.wander in draw
        randomize: false,
      },
      rng,
    );
    builtSpin = sp; builtSpeed = config.speed;
    const r0 = rot.getRotation(false), p0 = rot.getPosition(false);
    prevR = { ...r0 }; curR = { ...r0 }; prevP = { ...p0 }; curP = { ...p0 }; rotAccum = 0;
  }
  rebuildRotator();       // init_cube: make_rotator first ...
  reinitialize(true);     // ... then initialize_papercube(first_time)

  function tickRotator() {
    prevP = curP; curP = rot.getPosition(true);
    prevR = curR; curR = rot.getRotation(true);
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpAngle = (a, b, t) => {   // shortest path on the [0,1) rotation circle
    let d = b - a;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    return a + d * t;
  };

  // ---- sizing (reshape_cube: aspect + portrait fit) ----
  let portraitScale = 1;
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    portraitScale = (h / w > PRESERVED_HEIGHT_TO_WIDTH) ? (w / h) : 1;
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

    // live structural changes (rotation axes / speed both feed the rotator)
    if (config.rotation !== builtSpin || config.speed !== builtSpeed) rebuildRotator();

    const dt = Math.min(frame / 1000, 0.25);
    const spd = Math.max(0.001, config.speed);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;

    // fold clock (wall-clock seconds * speed) + the stage machine
    moveTime += dt * spd;
    if (movePapercube()) reinitialize(false);

    // rotator: tick at the original cadence, interpolate for smoothness
    rotAccum += frames;
    let ticks = 0;
    while (rotAccum >= 1 && ticks < MAX_TICKS) { tickRotator(); rotAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) rotAccum = 0;
    const a = rotAccum;

    // transforms (reshape + paint_papercube)
    scaleGroup.scale.setScalar(portraitScale);
    if (config.wander) {
      wanderGroup.position.set(
        (lerp(prevP.x, curP.x, a) - 0.5) * 3,
        (lerp(prevP.y, curP.y, a) - 0.5) * 3,
        (lerp(prevP.z, curP.z, a) - 0.5) * 3,
      );
    } else wanderGroup.position.set(0, 0, 0);
    tumbleGroup.rotation.set(
      lerpAngle(prevR.x, curR.x, a) * TWO_PI,   // glRotatef(x*360) about X
      lerpAngle(prevR.y, curR.y, a) * TWO_PI,   // then Y
      lerpAngle(prevR.z, curR.z, a) * TWO_PI,   // then Z  == three Euler 'XYZ'
      'XYZ',
    );
    eyeSpinGroup.rotation.y = (eyeRotation + spinSign * spinRotation) * DEG2RAD;

    // fold rotations (each pivot = its child field's crease angle)
    for (const pv of pivots) {
      const ang = angles[pv.row][pv.col].angle * DEG2RAD * pv.sign;
      if (pv.o === 'H') pv.pivot.rotation.z = ang; else pv.pivot.rotation.x = ang;
    }
    updateArrow();

    material.color.setRGB(brightness, brightness, brightness);
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      arrowGeom.dispose();
      tex.dispose();
      material.dispose();
      scene.traverse((o) => { if (o.geometry && o.geometry !== arrowGeom) o.geometry.dispose(); });
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { reinitialize(false); },   // fresh random cube (host 're-seed')
    config,
    params,
  };
}

export default { title, info, start };
