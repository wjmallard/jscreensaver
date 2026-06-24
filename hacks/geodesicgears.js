// geodesicgears.js -- "Geodesic Gears" as a self-contained, mountable three.js
// module. start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit,
// config, params }.
//
// Faithful port of xscreensaver's geodesicgears (Jamie Zawinski, 2014),
// hacks/glx/geodesicgears.c. Involute gears arranged on the faces / vertices /
// edges of a geodesic polyhedron (a sphere): one interlinked, counter-rotating
// system. Every ~timeout seconds the whole sphere scales away and a new
// arrangement scales in. Inspired by bugman123.com/Gears and Kenneth Snelson's
// "Portrait of an Atom".
//
// The gear geometry is the shared ./involute.js (faithful port of involute.c) --
// the same shared library geodesicgears.c uses via draw_involute_gear(). This
// module owns geodesicgears.c's part: the per-shape gear parameters + the geodesic
// layouts (prism / octo / deca / 14 / 18 / 32 / 92), the touch-graph that turns the
// gears into a DAG (so each gear gets a parent, a rotation direction and a gear
// ratio), the tooth-meshing offset search, and the scene / lighting / camera /
// render loop. Self-contained otherwise (own overlay canvas + renderer + loop),
// like gears.js / moebiusgears.js / dangerball.js. Motion (rotator.js), palette
// (colormap.js) and RNG (yarandom.js) are the shared faithful util ports.
//
// FAITHFUL TO geodesicgears.c -- "do not deviate from the algorithm":
//   * add_gear_shape: tooth_h (with the < 0.06 stubbier-teeth halving), the
//     thickness = 0.05 + BELLRAND(0.15) slab, z = 1 - sqrt(1 - r^2) (so the disc
//     edge is tangent to the unit sphere) and the consequent tooth_slope (the gears
//     are slightly conical, leaning toward the sphere centre), the random interior
//     (ring / inset disc / raised lip / third disc, sometimes spokes), the nubs, the
//     mesh-detail bucket from approximate on-screen tooth size, and the two colours
//     (color = colormap[i], color2 = colormap[i + n/2]) -- all RNG draws in the .c's
//     order. The gear's baked pre-transform (move inward by thickness/2, un-slope
//     the radius, then Rz(90) Ry(180) Rz(-360/nteeth/4) to line tooth 0 up) is
//     applied to the BufferGeometry, exactly as the .c bakes it into the dlist.
//   * the seven make_*() layouts, vertex-for-vertex (incl. add_sphere_gear's
//     normalize + dedup-by-axis, and the per-template teeth-count RNG).
//   * sort_gears: gears_touch_p (two surface discs touch iff asin(r1)+asin(r2) >=
//     acos(axis1.axis2)), link_neighbors, the depth-first link_children DAG from
//     gears[0], orient_gears (alternating spin direction down the tree), and
//     align_gear_teeth (per gear, search 64 offsets in +-half-a-tooth for the one
//     that best meshes this gear's parent-pointing tooth with the parent's nearest
//     tooth -- via tooth_coords / parent_tooth, the verbatim glRotatef matrix).
//   * draw_geodesic: the per-gear modelview T(axis) R(angle,axis) Rx(-90) Rz(180)
//     Rz((th-off)*ratio*dir) (with the even-teeth half-tooth offset on dir>0 gears),
//     th += 0.7*speed/frame, the Scale(6) (x0.8 when < 14 gears), and the
//     scale-out / pick / scale-in transition state machine on the `timeout` clock.
//   * lighting: one white directional light from (1,1,1), light ambient 0 (so the
//     only ambient is the GL default global 0.2 * the AMBIENT_AND_DIFFUSE gear
//     colour), cyan {0,1,1} light-specular x white material-specular, shininess 128.
//
// OMITTED (need a font atlas, like pinion): the --labels gear description and the
// --numbers per-tooth labels (do_labels / do_numbers, both default False). `speed`
// is a .c resource with no .xml slider, so it stays the DEF_SPEED 1.0 here, matching
// the config box to geodesicgears.xml (delay / timeout / wander / spin / wireframe).
//
// PACING as in dangerball / moebiusgears: render every rAF, motion is continuous.
// effFps = 1e6/(delay+OVERHEAD) sets the original's effective frame rate; one render
// frame advances frames = dt*effFps original-frames. th + the transition advance by
// `frames`; the rotator's discrete random-walk is ticked once per original-frame and
// interpolated between ticks (smooth render, original per-frame cadence preserved).

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';
import { makeSmoothColormap } from './colormap.js';
import {
  buildGearGeometry,
  involuteBiggestRing,
  INVOLUTE_SMALL as SMALL,
  INVOLUTE_MEDIUM as MEDIUM,
  INVOLUTE_LARGE as LARGE,
  INVOLUTE_HUGE as HUGE,
} from './involute.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding). Disable three's color management so the
// port matches GL: set at MODULE SCOPE (before start() fills colors) so the
// setRGB(..., SRGBColorSpace) calls become no-ops and store RAW glColor, and the output
// is not sRGB-encoded. Without this, lit/shaded faces render up to ~2.5x too bright
// (measured vs the rubikblocks grayscale ground truth).
THREE.ColorManagement.enabled = false;

export const title = 'geodesicgears';

export const info = {
  author: 'Jamie Zawinski',
  year: 2014,
  description: 'A set of meshed gears arranged on the surface of a sphere.\n\nhttps://en.wikipedia.org/wiki/Geodesic_dome\nhttps://en.wikipedia.org/wiki/Involute_gear\nhttps://en.wikipedia.org/wiki/Buckminster_Fuller',
};

// The gear_templates table (geodesicgears.c), verbatim minus the commented-out
// rows. G32 args = [teeth1, teeth2, r1]; G92 args = [teeth1, teeth2, teeth3, r1,
// pitch3]. PRISM/OCTO/DECA/G14/G18 take no args (their counts come from RNG).
const GEAR_TEMPLATES = [
  { type: 'PRISM' },
  { type: 'OCTO' },
  { type: 'DECA' },
  { type: 'G14' },
  { type: 'G18' },
  { type: 'G32', args: [15, 6, 0.4535] },
  { type: 'G32', args: [15, 12, 0.3560] },
  { type: 'G32', args: [20, 6, 0.4850] },
  { type: 'G32', args: [20, 12, 0.3995] },   // double of 10:6
  { type: 'G32', args: [20, 18, 0.3375] },
  { type: 'G32', args: [25, 6, 0.5065] },
  { type: 'G32', args: [25, 12, 0.4300] },
  { type: 'G32', args: [25, 18, 0.3725] },
  { type: 'G32', args: [25, 24, 0.3270] },
  { type: 'G32', args: [30, 12, 0.4535] },   // double of 15:6
  { type: 'G32', args: [30, 18, 0.3995] },
  { type: 'G32', args: [30, 24, 0.3560] },   // double of 15:12
  { type: 'G32', args: [30, 30, 0.3205] },
  { type: 'G32', args: [35, 12, 0.4710] },
  { type: 'G32', args: [35, 18, 0.4208] },
  { type: 'G32', args: [35, 24, 0.3800] },
  { type: 'G32', args: [35, 30, 0.3450] },
  { type: 'G32', args: [35, 36, 0.3160] },
  { type: 'G32', args: [40, 12, 0.4850] },   // double of 20:6
  { type: 'G32', args: [40, 24, 0.3995] },   // double of 10:6, 20:12
  { type: 'G32', args: [50, 12, 0.5065] },   // double of 25:6
  { type: 'G32', args: [50, 24, 0.4300] },   // double of 25:12
  { type: 'G92', args: [35, 36, 16, 0.2660, 0.366] },
  { type: 'G92', args: [25, 36, 11, 0.2270, 0.315] },
  { type: 'G92', args: [25, 27, 16, 0.2320, 0.359] },
  { type: 'G92', args: [20, 36, 11, 0.1875, 0.283] },
  { type: 'G92', args: [30, 30, 16, 0.2585, 0.374] },   // double of 15:15:8
  { type: 'G92', args: [20, 33, 11, 0.1970, 0.293] },
  { type: 'G92', args: [30, 33, 16, 0.2455, 0.354] },
  { type: 'G92', args: [20, 24, 16, 0.2030, 0.346] },
];

export function start(hostCanvas, opts = {}) {
  const OVERHEAD = 37500;          // us; calibrates xml default delay 30000 -> ~15fps (see frame-rate-calibration)
  const SPEED = 1.0;               // DEF_SPEED (no .xml slider; kept internal)
  const NCOLORS = 1024;            // bp->ncolors
  const DEG = Math.PI / 180;
  const SIDE = THREE.DoubleSide;   // closed solids: pixel-identical to GL_CULL_FACE (see involute.js)
  const AXIS_EPS = 1e-6;           // add_sphere_gear dedup tolerance

  // Live config -- transcribed 1:1 from hacks/config/geodesicgears.xml.
  const config = {
    delay: 30000,    // us, frame rate / overall speed (xml default; invert slider)
    timeout: 20,     // seconds each arrangement is shown before it changes
    wander: true,
    spin: true,
    wire: false,
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' µs', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'timeout', label: 'Duration', type: 'range', min: 5, max: 120, step: 1, default: 20, unit: ' s', lowLabel: '5 seconds', highLabel: '2 minutes', live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'spin', label: 'Spin', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const seed = opts.seed || 0;
  const rng = makeYaRandom(seed);
  const frand = (f = 1) => rng.frand(f);
  const bellrand = (n) => (frand(n) + frand(n) + frand(n)) / 3;   // BELLRAND

  const _c = new THREE.Color();
  const toLin = (r, g, b) => { _c.setRGB(r, g, b, THREE.SRGBColorSpace); return [_c.r, _c.g, _c.b]; };

  // ---- small vector helpers (cross_product / dot_product / normalize) ----
  const cross = (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  });
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  function normalize(v) {
    const d = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (d === 0) return { x: 0, y: 0, z: 0 };
    return { x: v.x / d, y: v.y / d, z: v.z / d };
  }
  const polarToCartesian = (a, o) => ({
    x: Math.cos(a) * Math.cos(o),
    y: Math.cos(a) * Math.sin(o),
    z: Math.sin(a),
  });
  const clamp1 = (x) => (x < -1 ? -1 : x > 1 ? 1 : x);   // keep asin/acos in domain

  // ===================================================================
  //  three.js scene + overlay canvas
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

  // reshape_geodesic: gluPerspective(30, aspect, 1, 100) + gluLookAt(0,0,30, ...).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // One white directional light from (1,1,1). intensity PI cancels three's 1/PI
  // diffuse (lit face = (0.2 + N.L) * colour). The light's ambient is 0; the only
  // ambient lift is the GL default global ambient 0.2 * the AMBIENT_AND_DIFFUSE gear
  // colour (involute.c sets the colour via glColor), modeled as AmbientLight(0.2*PI).
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(1, 1, 1);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.2 * Math.PI));

  // Shared material: vertex colours = the gear colours. The GL highlight is
  // light-specular {0,1,1} (cyan) x material-specular {1,1,1} (white) = cyan at
  // shininess 128; the PI light intensity over-drives specular, so divide by PI (the
  // systematic /PI rule -- see superquadrics / morph3d). A tiny, cyan-tinted glint.
  const material = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    vertexColors: true,
    specular: new THREE.Color().setRGB(0, 1 / Math.PI, 1 / Math.PI, THREE.SRGBColorSpace),
    shininess: 128,
    side: SIDE,
  });

  // Nested groups mirroring draw_geodesic's modelview: portrait-fit -> position
  // (wander) -> rotation (spin) -> Scale(6, x0.8 if few gears, x transition).
  const viewRoot = new THREE.Group();
  const posGroup = new THREE.Group();
  const rotGroup = new THREE.Group();
  const scaleGroup = new THREE.Group();
  viewRoot.add(posGroup); posGroup.add(rotGroup); rotGroup.add(scaleGroup);
  scene.add(viewRoot);

  // ===================================================================
  //  shapes (gear *) + sphere gears (sphere_gear *)
  // ===================================================================
  // shape: { r, nteeth, ratio, ...involute params, colLin, col2Lin, geom, polygons }
  // gear:  { id, axis, direction, offset, parent, children[], neighbors[], g(shape) }
  let shapes = [];
  let gears = [];
  let gearMeshes = [];   // { mesh, base(Matrix4), off, ratio, dir }
  let cmap = null;
  let which = 0;
  let meshHeight = 720;  // px, for the on-screen-tooth-size mesh-detail heuristic
  let baseScale = 6;     // glScalef(6) (x0.8 when < 14 gears)
  let th = 0;            // root rotation, degrees (never mod'd -- the .c warns it glitches)

  // add_gear_shape: build one involute gear shape (geometry + colours), baking the
  // geodesic pre-transform into its BufferGeometry. Returns the shape object.
  function addGearShape(radius, teeth) {
    const wire = config.wire;
    const g = {
      r: radius, nteeth: teeth, ratio: 1,
      tooth_h: 0, tooth_w: 0, tooth_slope: 0,
      thickness: 0, thickness2: 0, thickness3: 0,
      size: wire ? SMALL : LARGE, z: 0,
      inner_r: 0, inner_r2: 0, inner_r3: 0,
      spokes: 0, spoke_thickness: 0, nubs: 0, inverted_p: false, coax_p: 0,
      colLin: null, col2Lin: null, geom: null, polygons: 0,
    };

    g.tooth_h = g.r / (teeth * 0.4);
    if (g.tooth_h > 0.06) g.tooth_h *= 0.6;   // stubbier teeth when small tooth count

    g.thickness = 0.05 + bellrand(0.15);
    g.thickness2 = g.thickness / 4;
    g.thickness3 = g.thickness;

    // Move the disc origin inward so the disc edge is tangent to the unit sphere.
    g.z = 1 - Math.sqrt(1 - g.r * g.r);
    g.tooth_slope = 1 + ((g.z * 2) / g.r);   // (#### "isn't quite right" per the .c)

    // Interior: ring-only, or an inset disc (+ raised lip / third disc).
    if (wire) {
      /* just a ring with teeth */
    } else if ((rng.random() % 10) === 0) {
      g.inner_r = (g.r * 0.3) + frand((g.r - g.tooth_h / 2) * 0.6);
      g.inner_r2 = 0;
      g.inner_r3 = 0;
    } else {
      g.inner_r = (g.r * 0.5) + frand((g.r - g.tooth_h) * 0.4);
      g.inner_r2 = (g.r * 0.1) + frand(g.inner_r * 0.5);
      g.inner_r3 = 0;
      if (g.inner_r2 > (g.r * 0.2)) {
        const nn = rng.random() % 10;
        if (nn <= 2) g.inner_r3 = (g.r * 0.1) + frand(g.inner_r2 * 0.2);
        else if (nn <= 7 && g.inner_r2 >= 0.1) g.inner_r3 = g.inner_r2 - 0.01;
      }
    }

    // Sometimes spokes in the middle disc.
    if (g.inner_r3 && ((rng.random() % 5) === 0)) {
      g.spokes = Math.trunc(2 + bellrand(5));
      g.spoke_thickness = 1 + frand(7.0);
      if (g.spokes === 2 && g.spoke_thickness < 2) g.spoke_thickness += 1;
    }

    // Sometimes little nubbly bits, if there is room.
    if (!wire && g.nteeth > 5) {
      const size = involuteBiggestRing(g).size;
      if (size > g.r * 0.2 && (rng.random() % 5) === 0) {
        g.nubs = 1 + (rng.random() % 16);
        if (g.nubs > 8) g.nubs = 1;
      }
    }

    // Mesh complexity from approximate on-screen tooth size (pixels).
    {
      const pix = g.tooth_h * meshHeight;
      g.size = (pix <= 4) ? SMALL : (pix <= 8) ? MEDIUM : (pix <= 30) ? LARGE : HUGE;
    }

    // Two colours: colormap[i] and its complement colormap[i + n/2].
    let i = rng.random() % NCOLORS;
    const c1 = cmap[i];
    i = (i + Math.trunc(NCOLORS / 2)) % NCOLORS;
    const c2 = cmap[i];
    g.colLin = toLin(c1.r, c1.g, c1.b);
    g.col2Lin = toLin(c2.r, c2.g, c2.b);

    // Build the geometry ("the dlist"): move inward by thickness/2, reverse the
    // involute slope-radius adjustment, then orient tooth 0 toward "up".
    const g2 = { ...g };
    g2.z = g.z + g.thickness / 2;
    g2.r = g.r / (1 + (g.thickness * g.tooth_slope / 2));
    const geom = buildGearGeometry(g2);
    g.polygons = g2.polygons;
    const M = new THREE.Matrix4().makeTranslation(0, 0, -g2.z);
    const t = new THREE.Matrix4();
    M.multiply(t.makeRotationZ(90 * DEG));
    M.multiply(t.makeRotationY(180 * DEG));
    M.multiply(t.makeRotationZ(-(360 / g.nteeth / 4) * DEG));
    geom.applyMatrix4(M);
    g.geom = geom;

    shapes.push(g);
    return g;
  }

  // add_sphere_gear: place a shape on an axis (deduping coincident axes).
  function addSphereGear(shape, axisRaw) {
    const axis = normalize(axisRaw);
    for (const o of gears) {
      if (Math.abs(o.axis.x - axis.x) < AXIS_EPS &&
          Math.abs(o.axis.y - axis.y) < AXIS_EPS &&
          Math.abs(o.axis.z - axis.z) < AXIS_EPS) return;
    }
    gears.push({
      id: gears.length, axis, direction: 0, offset: 0,
      parent: null, children: [], neighbors: [], g: shape,
    });
  }

  // ---- the seven geodesic layouts (make_* in the .c) ----
  function makePrism() {
    const teeth = 4 * (4 + Math.trunc(bellrand(20)));
    const g = addGearShape(0.7075, teeth);
    addSphereGear(g, { x: 0, y: 0, z: 1 });
    addSphereGear(g, { x: 0, y: 0, z: -1 });
    for (let i = 0; i < 3; i++) {
      const t = i * Math.PI * 2 / 3;
      addSphereGear(g, { x: Math.cos(t), y: Math.sin(t), z: 0 });
    }
  }

  function makeOcto() {
    const verts = [
      [-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1],
      [1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1],
    ];
    const teeth = 4 * (4 + Math.trunc(bellrand(20)));
    const g = addGearShape(0.578, teeth);
    for (const v of verts) addSphereGear(g, { x: v[0], y: v[1], z: v[2] });
  }

  function makeDeca() {
    const teeth = 4 * (4 + Math.trunc(bellrand(15)));
    const g = addGearShape(0.5415, teeth);
    addSphereGear(g, { x: 0, y: 0, z: 1 });
    addSphereGear(g, { x: 0, y: 0, z: -1 });
    for (let j = -1; j <= 1; j += 2) {
      const off = (j < 0 ? 0 : Math.PI / 4);
      const a = j * Math.PI * 0.136;   // #### empirical
      for (let i = 0; i < 4; i++) addSphereGear(g, polarToCartesian(a, i * Math.PI / 2 + off));
    }
  }

  function make14() {
    const r = 0.4610;
    const teeth = 6 * (2 + Math.trunc(bellrand(4)));
    let g = addGearShape(r, teeth);   // north, south, equator
    addSphereGear(g, { x: 0, y: 0, z: 1 });
    addSphereGear(g, { x: 0, y: 0, z: -1 });
    for (let i = 0; i < 4; i++) {
      const t = i * Math.PI * 2 / 4 + (Math.PI / 4);
      addSphereGear(g, { x: Math.cos(t), y: Math.sin(t), z: 0 });
    }
    g = addGearShape(r, teeth);   // the other 8
    for (let i = 0; i < 4; i++) {
      const o = i * Math.PI * 2 / 4;
      addSphereGear(g, polarToCartesian(Math.PI * 0.197, o));   // #### empirical
      addSphereGear(g, polarToCartesian(-Math.PI * 0.197, o));
    }
  }

  function make18() {
    const r = 0.3830;
    const sizes = [8, 12, 16, 20];
    const teeth = sizes[rng.random() % sizes.length] * (1 + (rng.random() % 4));
    let g = addGearShape(r, teeth);   // north, south
    addSphereGear(g, { x: 0, y: 0, z: 1 });
    addSphereGear(g, { x: 0, y: 0, z: -1 });
    const g2 = addGearShape(r, teeth);   // equator (alternating g / g2)
    for (let i = 0; i < 8; i++) {
      const t = i * Math.PI * 2 / 8 + (Math.PI / 4);
      addSphereGear((i & 1) ? g : g2, { x: Math.cos(t), y: Math.sin(t), z: 0 });
    }
    g = addGearShape(r, teeth);   // the other 16
    for (let i = 0; i < 4; i++) {
      const o = i * Math.PI * 2 / 4;
      addSphereGear(g, polarToCartesian(Math.PI * 0.25, o));
      addSphereGear(g, polarToCartesian(-Math.PI * 0.25, o));
    }
  }

  // truncated icosahedron: a gear on each of 20 faces + each of 12 vertices.
  function make32(args) {
    const th0 = Math.atan(0.5);   // lat division 26.57 deg
    const s = Math.PI / 5;        // lon division 72 deg
    const teeth1 = args[0], teeth2 = args[1], r1 = args[2];
    const ratio = teeth2 / teeth1;
    const r2 = r1 * ratio;
    const gear1 = addGearShape(r1, teeth1);
    const gear2 = addGearShape(r2, teeth2);
    gear2.ratio = 1 / ratio;
    addSphereGear(gear1, { x: 0, y: 0, z: 1 });
    addSphereGear(gear1, { x: 0, y: 0, z: -1 });
    for (let i = 0; i < 10; i++) {
      const th1 = s * i, th2 = s * (i + 1), th3 = s * (i + 2);
      let v1a = th0, v2a = th0, v3a = -th0, vca = Math.PI / 2;
      if (!(i & 1)) { v1a = -v1a; v2a = -v2a; v3a = -v3a; vca = -vca; }   // southern hemisphere
      const p1 = polarToCartesian(v1a, th1);
      const p2 = polarToCartesian(v2a, th3);
      const p3 = polarToCartesian(v3a, th2);
      const pc = polarToCartesian(vca, th2);
      addSphereGear(gear1, p1);   // left shared point of 2 triangles
      addSphereGear(gear2, { x: (p1.x + p2.x + p3.x) / 3, y: (p1.y + p2.y + p3.y) / 3, z: (p1.z + p2.z + p3.z) / 3 });
      addSphereGear(gear2, { x: (p1.x + p2.x + pc.x) / 3, y: (p1.y + p2.y + pc.y) / 3, z: (p1.z + p2.z + pc.z) / 3 });
    }
  }

  // geodesic sphere, 20 + 12 + 60 (3v class-I tessellation of an icosahedron).
  function make92(args) {
    const th0 = Math.atan(0.5);
    const s = Math.PI / 5;
    const tscale = 2;   // these don't mesh exactly; more teeth hides it
    const teeth1 = args[0] * tscale, teeth2 = args[1] * tscale, teeth3 = args[2] * tscale;
    const r1 = args[3];
    const ratio2 = teeth2 / teeth1, ratio3 = teeth3 / teeth2;
    const r2 = r1 * ratio2, r3 = r2 * ratio3;
    const r4 = args[4], r5 = 1 - r4;   // #### empirical edge fractions
    const gear1 = addGearShape(r1, teeth1);
    const gear2 = addGearShape(r2, teeth2);
    const gear3 = addGearShape(r3, teeth3);
    gear2.ratio = 1 / ratio2;
    gear3.ratio = 1 / ratio3;
    const edge = (A, B, t) => ({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, z: A.z + (B.z - A.z) * t });
    addSphereGear(gear1, { x: 0, y: 0, z: 1 });
    addSphereGear(gear1, { x: 0, y: 0, z: -1 });
    for (let i = 0; i < 10; i++) {
      const th1 = s * i, th2 = s * (i + 1), th3 = s * (i + 2);
      let v1a = th0, v2a = th0, v3a = -th0, vca = Math.PI / 2;
      if (!(i & 1)) { v1a = -v1a; v2a = -v2a; v3a = -v3a; vca = -vca; }
      const p1 = polarToCartesian(v1a, th1);
      const p2 = polarToCartesian(v2a, th3);
      const p3 = polarToCartesian(v3a, th2);
      const pc = polarToCartesian(vca, th2);
      addSphereGear(gear1, p1);
      addSphereGear(gear2, { x: (p1.x + p2.x + p3.x) / 3, y: (p1.y + p2.y + p3.y) / 3, z: (p1.z + p2.z + p3.z) / 3 });
      addSphereGear(gear2, { x: (p1.x + p2.x + pc.x) / 3, y: (p1.y + p2.y + pc.y) / 3, z: (p1.z + p2.z + pc.z) / 3 });
      addSphereGear(gear3, edge(p1, p3, r4));   // bottom triangle left edge, 1/3 + 2/3
      addSphereGear(gear3, edge(p1, p3, r5));
      addSphereGear(gear3, edge(p1, pc, r4));   // top triangle left edge, 1/3 + 2/3
      addSphereGear(gear3, edge(p1, pc, r5));
      addSphereGear(gear3, edge(p1, p2, r4));   // shared edge, 1/3 + 2/3
      addSphereGear(gear3, edge(p1, p2, r5));
    }
  }

  // ===================================================================
  //  sort_gears: touch-graph -> DAG -> directions -> tooth alignment
  // ===================================================================

  // The glRotatef matrix that maps (0,1,0) -> s.axis, applied to the position of
  // tooth `tooth` on the gear rim, normalized onto the unit sphere (tooth_coords).
  function toothCoords(s, tooth) {
    const g = s.g;
    const off = s.offset * (Math.PI / 180) * g.ratio * s.direction;
    const tt = (tooth * Math.PI * 2 / g.nteeth) - off;
    const from = { x: 0, y: 1, z: 0 };
    const to = s.axis;
    const ax = normalize(cross(from, to));
    const angle = Math.acos(clamp1(dot(from, to)));
    const x = ax.x, y = ax.y, z = ax.z;
    const C = Math.cos(angle), S = Math.sin(angle);
    // m[a][b], exactly as glRotatef builds it in the .c.
    const m = [
      [x * x * (1 - C) + C, y * x * (1 - C) + z * S, x * z * (1 - C) - y * S, 0],
      [x * y * (1 - C) - z * S, y * y * (1 - C) + C, y * z * (1 - C) + x * S, 0],
      [x * z * (1 - C) + y * S, y * z * (1 - C) - x * S, z * z * (1 - C) + C, 0],
      [0, 0, 0, 1],
    ];
    let p1 = { x: g.r * Math.sin(tt), y: 1 - g.z, z: g.r * Math.cos(tt) };
    p1 = normalize(p1);
    return {
      x: p1.x * m[0][0] + p1.y * m[1][0] + p1.z * m[2][0] + m[3][0],
      y: p1.x * m[0][1] + p1.y * m[1][1] + p1.z * m[2][1] + m[3][1],
      z: p1.x * m[0][2] + p1.y * m[1][2] + p1.z * m[2][2] + m[3][2],
    };
  }

  // The tooth of s closest to any tooth of its parent (+ the parent tooth's pos).
  function parentTooth(s) {
    const s2 = s.parent;
    let minDist = 99999, minTooth = 0, minParent = { x: 0, y: 0, z: 0 };
    if (s2) {
      for (let i = 0; i < s.g.nteeth; i++) {
        const p1 = toothCoords(s, i);
        for (let j = 0; j < s2.g.nteeth; j++) {
          const p2 = toothCoords(s2, j);
          const dx = p1.x - p2.x, dy = p1.y - p2.y, dz = p1.z - p2.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist < minDist) { minDist = dist; minParent = p2; minTooth = i; }
        }
      }
    }
    return { tooth: minTooth, parent: minParent };
  }

  // Iterate this gear's offset to best mesh its parent-pointing tooth, then recurse
  // children (parent-first: the parent's offset affects everyone downstream).
  function alignGearTeeth(s) {
    if (s.parent) {
      const pt = parentTooth(s);
      const range = 360 / s.g.nteeth;
      const steps = 64;
      let minDist = 999999, minOff = 0;
      for (let off = -range / 2; off < range / 2; off += range / steps) {
        s.offset = off;
        const tc = toothCoords(s, pt.tooth);
        const dx = pt.parent.x - tc.x, dy = pt.parent.y - tc.y, dz = pt.parent.z - tc.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < minDist) { minDist = dist; minOff = off; }
      }
      s.offset = minOff;
    }
    for (const c of s.children) alignGearTeeth(c);
  }

  function orientGears(g) {
    if (g.parent) g.direction = -g.parent.direction;
    for (const c of g.children) orientGears(c);
  }

  // Two surface discs touch iff asin(r1) + asin(r2) >= acos(axis1 . axis2).
  function gearsTouchP(a, b) {
    const t1 = Math.asin(clamp1(a.g.r));
    const t2 = Math.asin(clamp1(b.g.r));
    const t = Math.acos(clamp1(dot(a.axis, b.axis)));
    return (t1 + t2) >= t;
  }

  function linkNeighbors(p, c) {
    if (c === p) return;
    if (!p.neighbors.includes(c)) p.neighbors.push(c);
    if (!c.neighbors.includes(p)) c.neighbors.push(p);
  }
  function linkChild(p, c) {
    if (c === p || c.parent) return;
    p.children.push(c);
    c.parent = p;
  }
  function linkChildren(p) {   // depth-first
    for (const c of p.neighbors) {
      if (!c.parent) { linkChild(p, c); linkChildren(c); }
    }
  }

  function sortGears() {
    for (let i = 0; i < gears.length; i++) {
      const a = gears[i];
      for (let j = 0; j < gears.length; j++) {
        const b = gears[j];
        if (a === b) continue;
        if (gearsTouchP(a, b)) linkNeighbors(a, b);
      }
    }
    gears[0].parent = gears[0];   // sentinel: don't give the root a parent
    linkChildren(gears[0]);
    gears[0].parent = null;

    let root = null;
    for (const g of gears) if (!g.parent) root = g;
    if (!root) root = gears[0];

    root.direction = 1;
    orientGears(root);
    alignGearTeeth(root);
  }

  // ===================================================================
  //  build meshes for the current arrangement
  // ===================================================================
  const _tmp = new THREE.Matrix4();
  const _rzTmp = new THREE.Matrix4();

  // base = T(axis) R(angle,axis) Rx(-90) Rz(180); the per-frame spin Rz is appended.
  function axisRotation(angle, ax) {
    const len = Math.sqrt(ax.x * ax.x + ax.y * ax.y + ax.z * ax.z);
    const m = new THREE.Matrix4();
    if (len < 1e-8) {
      if (angle < 1e-6) return m;                // (0,1,0): no rotation needed
      return m.makeRotationX(Math.PI);           // (0,-1,0): any flip works
    }
    return m.makeRotationAxis(new THREE.Vector3(ax.x / len, ax.y / len, ax.z / len), angle);
  }

  function buildMeshes() {
    const from = { x: 0, y: 1, z: 0 };
    for (const s of gears) {
      const mesh = new THREE.Mesh(s.g.geom, material);
      mesh.matrixAutoUpdate = false;
      const to = s.axis;
      const ax = cross(from, to);
      const angle = Math.acos(clamp1(dot(from, to)));
      const base = new THREE.Matrix4().makeTranslation(to.x, to.y, to.z);
      base.multiply(axisRotation(angle, ax));
      base.multiply(_tmp.makeRotationX(-90 * DEG));
      base.multiply(_tmp.makeRotationZ(180 * DEG));
      // If an even number of teeth, dir>0 gears offset by half a tooth width.
      let off = s.offset;
      if (s.direction > 0 && !(s.g.nteeth & 1)) off += 360 / s.g.nteeth / 2;
      scaleGroup.add(mesh);
      gearMeshes.push({ mesh, base, off, ratio: s.g.ratio, dir: s.direction });
    }
    baseScale = (gears.length < 14) ? 6 * 0.8 : 6;
  }

  function disposeArrangement() {
    for (const e of gearMeshes) scaleGroup.remove(e.mesh);
    for (const sh of shapes) if (sh.geom) sh.geom.dispose();
    shapes = [];
    gears = [];
    gearMeshes = [];
  }

  // pick_shape: fresh colormap, a new (random, or random-but-different) template,
  // build it, sort it, build meshes. `first` true => the very first arrangement.
  function pickShape(first) {
    cmap = makeSmoothColormap(rng, NCOLORS);
    disposeArrangement();
    meshHeight = window.innerHeight || 720;

    const count = GEAR_TEMPLATES.length;
    if (first) {
      which = rng.random() % count;
    } else {
      let n = which;
      while (n === which) n = rng.random() % count;
      which = n;
    }

    const tpl = GEAR_TEMPLATES[which];
    switch (tpl.type) {
      case 'PRISM': makePrism(); break;
      case 'OCTO': makeOcto(); break;
      case 'DECA': makeDeca(); break;
      case 'G14': make14(); break;
      case 'G18': make18(); break;
      case 'G32': make32(tpl.args); break;
      case 'G92': make92(tpl.args); break;
      default: makeOcto(); break;
    }
    sortGears();
    buildMeshes();
  }

  // ---- per-frame gear spin matrices ----
  function updateGearMatrices() {
    for (const e of gearMeshes) {
      const spinDeg = (th - e.off) * e.ratio * e.dir;
      e.mesh.matrix.multiplyMatrices(e.base, _rzTmp.makeRotationZ(spinDeg * DEG));
      e.mesh.matrixWorldNeedsUpdate = true;
    }
  }

  // ===================================================================
  //  rotator (whole-sphere tumble + wander), built once, output gated live
  // ===================================================================
  // make_rotator(0.25*speed x3, accel 0.2, wander 0.01*speed, randomize True).
  const rot = makeRotator(
    {
      spinX: 0.25 * SPEED, spinY: 0.25 * SPEED, spinZ: 0.25 * SPEED,
      spinAccel: 0.2, wanderSpeed: 0.01 * SPEED, randomize: true,
    },
    rng,
  );

  // First arrangement (init_geodesic's pick_shape; rotator is built before it).
  pickShape(true);

  // ---- rotator sampling + interpolation (dangerball machinery) ----
  const r0 = rot.getRotation(false), p0 = rot.getPosition(false);
  let prevR = { ...r0 }, curR = { ...r0 };
  let prevP = { ...p0 }, curP = { ...p0 };
  let rotAccum = 0;
  function tickRotator() {
    prevR = curR; curR = rot.getRotation(true);
    prevP = curP; curP = rot.getPosition(true);
  }
  function lerpAngle(a, b, t) { let d = b - a; if (d > 0.5) d -= 1; else if (d < -0.5) d += 1; return a + d * t; }
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---- transition state machine (mode 0 normal / 1 out / 2 in) ----
  let mode = 0;
  let modeTick = 0;        // original-frames remaining in the current scale
  let shapeElapsed = 0;    // seconds the current arrangement has been shown
  const modeDuration = () => 10 / SPEED;

  // ---- sizing (reshape_geodesic: perspective + portrait-fit scale) ----
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    viewRoot.scale.setScalar(w < h ? w / h : 1);
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop ----
  const MAX_TICKS = 8;
  let raf = 0, last = 0, paused = false, ms = 16;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;

    // transition clock + scale.
    let transScale = 1;
    if (mode === 0) {
      shapeElapsed += dt;
      if (shapeElapsed >= config.timeout) { mode = 1; modeTick = modeDuration(); }
    } else if (mode === 1) {            // scaling out
      modeTick -= frames;
      transScale = Math.max(0, modeTick / modeDuration());
      if (modeTick <= 0) { pickShape(false); mode = 2; modeTick = modeDuration(); shapeElapsed = 0; transScale = 0; }
    } else if (mode === 2) {            // scaling in
      modeTick -= frames;
      transScale = Math.min(1, (modeDuration() - modeTick) / modeDuration());
      if (modeTick <= 0) { mode = 0; shapeElapsed = 0; transScale = 1; }
    }

    // root spin.
    th += 0.7 * SPEED * frames;
    updateGearMatrices();

    // whole-sphere tumble: tick rotator at the original cadence, interpolate.
    rotAccum += frames;
    let ticks = 0;
    while (rotAccum >= 1 && ticks < MAX_TICKS) { tickRotator(); rotAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) rotAccum = 0;
    const a = rotAccum;

    if (config.spin) {
      rotGroup.rotation.set(
        lerpAngle(prevR.x, curR.x, a) * 2 * Math.PI,
        lerpAngle(prevR.y, curR.y, a) * 2 * Math.PI,
        lerpAngle(prevR.z, curR.z, a) * 2 * Math.PI,
        'XYZ',
      );
    } else rotGroup.rotation.set(0, 0, 0);

    if (config.wander) {
      posGroup.position.set(
        (lerp(prevP.x, curP.x, a) - 0.5) * 8,
        (lerp(prevP.y, curP.y, a) - 0.5) * 8,
        (lerp(prevP.z, curP.z, a) - 0.5) * 17,
      );
    } else posGroup.position.set(0, 0, 0);

    scaleGroup.scale.setScalar(baseScale * transScale);
    material.wireframe = config.wire;
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      disposeArrangement();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { pickShape(false); mode = 0; modeTick = 0; shapeElapsed = 0; },
    config,
    params,
  };
}

export default { title, info, start };
