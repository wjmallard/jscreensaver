// lament.js -- "Lament" (Lemarchand's Box) as a self-contained three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's lament (Jamie Zawinski, 1998),
// hacks/glx/lament.c (+ lament_model.c geometry, lament512.png texture). A gold
// filigree puzzle box -- the Hellraiser "Lament Configuration" -- slowly tumbles,
// and every so often TRANSFORMS through one of a handful of configurations: a star
// unfolds, tetrahedra split off and rotate, the lid swings open, a "taser" arm
// slides out, a pillar rises and spins, or the box swells into a sphere. Then it
// folds back into a box and rests before the next transform.
//
// Self-contained on purpose (own overlay canvas + renderer + render loop), like
// glknots.js / engine.js -- it only follows the host's mountable-module contract.
//
// GEOMETRY: the 30 named model objects (OBJ_* / all_objs[]) come from
// lament-model.js, converted from lament_model.c's gllist structs (GL_N3F_V3F).
// Positions are baked with gl_init's Translate(-0.5)*Scale(1/3) (a unit cube at the
// origin); per-vertex UVs + a per-triangle material group were precomputed from
// lament.c's which_face()/texturize_vert() (the C bakes the same into display lists).
//
// TEXTURE: lament512.png is a 512x4096 atlas of 8 stacked 512x512 tiles: tiles 0-5
// are the six outer cube faces (gold filigree), tile 6 the interior, tile 7 the
// leviathan. Sliced into 8 THREE.Textures (NEAREST, REPEAT), applied per material
// group via the computed UVs when `tex` is on; a flat gold material otherwise.
//
// LIGHTING (gl_init): one positional light LIGHT0 at (-4,2,5) (LIGHT1 is disabled in
// the .c), ambient 0.7 gray over GL's default 0.2 global ambient, diffuse white. The
// four materials (exterior gold / interior / black / leviathan) keep the .c's exact
// GL_AMBIENT / GL_DIFFUSE / GL_SPECULAR / shininess. three has no separate material
// ambient, so GL's constant ambient term (matAmbient * 0.9) is injected as `emissive`
// (a constant floor, exactly what GL's ambient is). Per the sibling GL-port
// convention: THREE.ColorManagement.enabled=false (raw glColor), light intensity=PI
// (cancels three's 1/PI Lambert), specular /PI (so the highlight doesn't blow out).
//
// ANIMATION: the LAMENT_* state machine (animate()) is transcribed verbatim -- a
// shuffled weighted list of transforms (tetra/star/taser/pillar most common, lid +
// sphere rare, leviathan very rare), each a sequence of sub-states that step anim_r/
// anim_y/anim_z per frame and are drawn by draw()'s per-state modelview. The
// LEVIATHAN family (8 states: procedural cone fans + folding-wall quads + the six
// iso-piece "arms" choreography + a GL_CONSTANT_ALPHA additive arm fade) is implemented
// (see lament.md); it holds the faithful 1/82 "very rare" slot. PACING: render every
// rAF; effFps = 1e6/(delay+OVERHEAD); the rotator
// + the per-frame animate() step are ticked at effFps (catch-up capped) with the spin
// and anim values interpolated between ticks for smoothness (the engine.js pattern).

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';
import objects from './lament-model.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor/
// material values to the framebuffer (no sRGB encoding), and the screenshots capture
// those raw values. Disable three's color management to match; without it, lit faces
// render up to ~2.5x too bright.
THREE.ColorManagement.enabled = false;

export const title = 'lament';

export const info = {
  author: 'Jamie Zawinski',
  year: 1998,
  description:
    'Lemarchand\'s Box, the Lament Configuration.\n\n' +
    'Warning: occasionally opens doors.\n\n' +
    'https://en.wikipedia.org/wiki/Lemarchand%27s_box',
};

// ---- material colors (lament.c). NB: set_colors() maps color+0=AMBIENT, +4=DIFFUSE,
// +8=SPECULAR, +12=shininess -- the struct's inline comments are mislabeled; these
// follow set_colors(), the authoritative order. ----
const EXTERIOR = { amb: [0.33, 0.22, 0.03], dif: [0.78, 0.57, 0.11], spec: [0.99, 0.91, 0.81], shin: 27.8 };
const INTERIOR = { amb: [0.20, 0.20, 0.15], dif: [0.40, 0.40, 0.32], spec: [0.99, 0.99, 0.81], shin: 50.8 };
const BLACK = { amb: [0.05, 0.05, 0.05], dif: [0.05, 0.05, 0.05], spec: [0.05, 0.05, 0.05], shin: 80.0 };
// leviathan_color (the procedural cone fans): near-white, faint blue-tinted specular.
const LEVIATHAN = { amb: [0.30, 0.30, 0.30], dif: [0.85, 0.85, 0.95], spec: [0.99, 0.99, 0.99], shin: 50.8 };

// LAMENT_* state ids (same order as lament.c's enum).
const S = {
  BOX: 0,
  STAR_OUT: 1, STAR_ROT: 2, STAR_ROT_IN: 3, STAR_ROT_OUT: 4, STAR_UNROT: 5, STAR_IN: 6,
  TETRA_UNE: 7, TETRA_USW: 8, TETRA_DWN: 9, TETRA_DSE: 10,
  LID_OPEN: 11, LID_CLOSE: 12, LID_ZOOM: 13,
  TASER_OUT: 14, TASER_SLIDE: 15, TASER_SLIDE_IN: 16, TASER_IN: 17,
  PILLAR_OUT: 18, PILLAR_SPIN: 19, PILLAR_IN: 20,
  SPHERE_OUT: 21, SPHERE_IN: 22,
  LEVIATHAN_SPIN: 23, LEVIATHAN_FADE: 24, LEVIATHAN_TWIST: 25, LEVIATHAN_COLLAPSE: 26,
  LEVIATHAN_EXPAND: 27, LEVIATHAN_UNTWIST: 28, LEVIATHAN_UNFADE: 29, LEVIATHAN_UNSPIN: 30,
};

const DEG = Math.PI / 180;

export function start(hostCanvas, opts = {}) {
  // us; the GL family's shared overhead default (live GL is unmeasurable under this
  // machine's XQuartz Apple-DRI block). xml delay 20000 -> effFps = 1e6/57500 ~= 17.4.
  const OVERHEAD = 37500;
  const MAX_TICKS = 8;

  // Knobs transcribed 1:1 from hacks/lament.xml. `delay` is the frame-rate knob.
  const config = {
    delay: 20000,   // us (xml default; invert slider)
    tex: true,      // Textured (xml `tex`; arg-unset --no-texture, def True)
    wire: false,    // Wireframe (xml `wire`; def False)
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'tex', label: 'Textured', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);
  const frand = (f) => rng.frand(f);
  const randsign = () => ((rng.random() & 1) ? 1 : -1);

  // ===================================================================
  //  scene / renderer
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
  scene.background = new THREE.Color(0x000000);

  // reshape_lament: glFrustum(-1,1,-h,h,5,60) with h=H/W, then Translate(0,0,-40).
  // A symmetric frustum == a standard perspective with fovy = 2*atan(h/5), aspect =
  // W/H; the -40 translate is baked into the camera position (z=40 looking at origin).
  const camera = new THREE.PerspectiveCamera(30, 1, 5, 60);
  camera.position.set(0, 0, 40);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // LIGHT0: positional at (-4,2,5), ambient 0.7, diffuse white. Set in gl_init with
  // modelview = Translate(0,0,-40), i.e. eye (-4,2,-35); with the -40 folded into the
  // camera, that world position is exactly (-4,2,5). Fixed in eye/world space (does
  // not tumble with the box). GL default = no distance attenuation -> decay 0.
  const light = new THREE.PointLight(0xffffff, Math.PI, 0, 0);
  light.position.set(-4, 2, 5);
  scene.add(light);
  // GL's ambient term is a per-material CONSTANT (matAmbient * (0.2 global + 0.7
  // light0)); injected via each material's `emissive`, so no ambient light here.

  // ===================================================================
  //  textures (lament512.png -> 8 stacked 512x512 tiles)
  // ===================================================================
  const TILE = 512, NTILES = 8;
  const tileTextures = new Array(NTILES).fill(null);
  let texReady = false;
  {
    const img = new Image();
    img.onload = () => {
      for (let i = 0; i < NTILES; i++) {
        const c = document.createElement('canvas');
        c.width = TILE; c.height = TILE;
        const g = c.getContext('2d');
        // tile i = source rows [TILE*i, TILE*i+TILE); GL uploads row 0 as t=0, so keep
        // the canvas top at v=0 (flipY off) to match the .c's raw glTexImage2D slice.
        g.drawImage(img, 0, TILE * i, TILE, TILE, 0, 0, TILE, TILE);
        const t = new THREE.CanvasTexture(c);
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
        t.flipY = false;
        t.colorSpace = THREE.SRGBColorSpace;
        t.needsUpdate = true;
        tileTextures[i] = t;
      }
      texReady = true;
      updateMaterials();
    };
    img.onerror = () => { /* leave flat-gold materials */ };
    img.src = new URL('./images/lament512.png', import.meta.url).href;
  }

  // ===================================================================
  //  materials (index = per-triangle group value from lament-model.js)
  //   0..5 = outer face S,U,N,D,W,E (exterior gold, tile 0..5)
  //   6    = interior (interior color, tile 6)
  //   7    = black interior (iso_base_a/b), no texture
  // ===================================================================
  const col = (rgb) => new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
  // specular /PI (sibling GL-port convention: cancels the PI light intensity so the
  // highlight doesn't blow out). emissive = matAmbient * 0.9 (GL's constant ambient).
  function makeMat(c, side = THREE.FrontSide) {
    return new THREE.MeshPhongMaterial({
      color: col(c.dif),
      specular: new THREE.Color().setRGB(c.spec[0] / Math.PI, c.spec[1] / Math.PI, c.spec[2] / Math.PI, THREE.SRGBColorSpace),
      emissive: new THREE.Color().setRGB(c.amb[0] * 0.9, c.amb[1] * 0.9, c.amb[2] * 0.9, THREE.SRGBColorSpace),
      shininess: c.shin,
      side,
    });
  }
  const matFace = [];                       // group 0..5
  for (let i = 0; i < 6; i++) matFace.push(makeMat(EXTERIOR));
  const matInterior = makeMat(INTERIOR);    // group 6
  const matBlack = makeMat(BLACK);          // group 7
  const materials = [...matFace, matInterior, matBlack];
  // ---- LEVIATHAN-only materials (procedural cones / folding walls / fade shields) ----
  // cones: leviathan color + leviathan texture (tile 7), opaque.
  const matLeviathan = makeMat(LEVIATHAN);
  // folding walls: exterior gold + a face tile each, alpha = 1-ratio (SRC_ALPHA blend).
  // The .c never touches the depth mask (GL_DEPTH_TEST stays on, writes on), so keep
  // three's default depthWrite=true and rely on the back-to-front transparent sort.
  const matWall = [];
  for (let i = 0; i < 6; i++) {
    const m = makeMat(EXTERIOR);
    m.transparent = true;   // fading gold panels
    matWall.push(m);
  }
  // black fade shield around the cone gap: alpha = 1-alpha_param (SRC_ALPHA blend).
  const matShield = makeMat(BLACK);
  matShield.transparent = true;
  // sphere reuses the exterior gold + face tiles but is convex; DoubleSide dodges the
  // .c's per-face glFrontFace winding without extra bookkeeping.
  const matSphere = [];
  for (let i = 0; i < 6; i++) matSphere.push(makeMat(EXTERIOR, THREE.DoubleSide));
  const allMats = [...materials, ...matSphere, matLeviathan, ...matWall, matShield];

  let builtTex = null, builtWire = null;
  function updateMaterials() {
    const useTex = config.tex && !config.wire;   // wire forces do_texture=false (.c)
    // GL's texture env is GL_MODULATE: the WHOLE lit color (ambient+diffuse+specular)
    // is multiplied by the texel. three multiplies only diffuse (map); the ambient
    // term lives in `emissive`, so an emissiveMap (same tile) is needed to darken the
    // recesses -- without it the un-textured ambient floods the dark filigree with gold.
    const set = (m, tile) => {
      m.map = useTex && texReady ? tile : null;
      m.emissiveMap = useTex && texReady ? tile : null;
    };
    for (let i = 0; i < 6; i++) { set(matFace[i], tileTextures[i]); set(matSphere[i], tileTextures[i]); }
    set(matInterior, tileTextures[6]);
    set(matLeviathan, tileTextures[7]);               // leviathan cones = the final tile
    for (let i = 0; i < 6; i++) set(matWall[i], tileTextures[i]);   // folding walls = face tiles
    for (const m of allMats) { m.wireframe = config.wire; m.needsUpdate = true; }
    builtTex = config.tex; builtWire = config.wire;
  }

  // ===================================================================
  //  build one Mesh per model object (grouped by material, static)
  // ===================================================================
  function buildObjectGeometry(rec) {
    // sort triangles by group so each material's tris are contiguous (one addGroup
    // per material index present).
    const { ntri, positions, normals, uvs, groups } = rec;
    const order = Array.from({ length: ntri }, (_, i) => i).sort((a, b) => groups[a] - groups[b]);
    const pos = new Float32Array(ntri * 9);
    const nor = new Float32Array(ntri * 9);
    const uv = new Float32Array(ntri * 6);
    const geom = new THREE.BufferGeometry();
    let vi = 0, ti = 0;
    let curGroup = -1, groupStart = 0;
    for (let k = 0; k < ntri; k++) {
      const t = order[k];
      if (groups[t] !== curGroup) {
        if (curGroup !== -1) geom.addGroup(groupStart, (k * 3) - groupStart, curGroup);
        curGroup = groups[t]; groupStart = k * 3;
      }
      for (let j = 0; j < 3; j++) {
        const src = (t * 3 + j) * 3, srcU = (t * 3 + j) * 2;
        pos[vi] = positions[src]; pos[vi + 1] = positions[src + 1]; pos[vi + 2] = positions[src + 2];
        nor[vi] = normals[src]; nor[vi + 1] = normals[src + 1]; nor[vi + 2] = normals[src + 2];
        uv[ti] = uvs[srcU]; uv[ti + 1] = uvs[srcU + 1];
        vi += 3; ti += 2;
      }
    }
    geom.addGroup(groupStart, (ntri * 3) - groupStart, curGroup);
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geom.computeBoundingSphere();
    return geom;
  }

  // modelview nesting (draw()): worldTilt(Rx-90) -> winScale(scale_for_window) ->
  // spin(rotator) -> half(scale 0.5) -> stateRoot (per-state meshes, explicit matrices).
  const worldTilt = new THREE.Group();
  worldTilt.rotation.x = -Math.PI / 2;      // glRotatef(-90,1,0,0)
  const winScale = new THREE.Group();
  const spin = new THREE.Group();
  const half = new THREE.Group();
  half.scale.setScalar(0.5);                 // glScalef(0.5,0.5,0.5)
  const stateRoot = new THREE.Group();
  scene.add(worldTilt); worldTilt.add(winScale); winScale.add(spin); spin.add(half); half.add(stateRoot);

  const meshes = {};                         // name -> THREE.Mesh (matrixAutoUpdate off)
  const geoms = [];
  for (const name of Object.keys(objects)) {
    const g = buildObjectGeometry(objects[name]);
    geoms.push(g);
    const m = new THREE.Mesh(g, materials);
    m.matrixAutoUpdate = false;
    m.visible = false;
    stateRoot.add(m);
    meshes[name] = m;
  }

  // reusable matrices
  const M = new THREE.Matrix4(), T = new THREE.Matrix4(), R = new THREE.Matrix4();
  const AX = new THREE.Vector3();
  const rotZ = (deg) => R.makeRotationZ(deg * DEG);
  const rotY = (deg) => R.makeRotationY(deg * DEG);
  const rotX = (deg) => R.makeRotationX(deg * DEG);
  const trans = (x, y, z) => T.makeTranslation(x, y, z);

  function show(name, mat) {
    const m = meshes[name];
    m.visible = true;
    m.matrix.copy(mat);
  }
  function hideAll() {
    for (const k in meshes) meshes[k].visible = false;
    sphereMesh.visible = false;
    for (const d of dynMeshes) d.mesh.visible = false;   // leviathan cones/shields/walls
  }

  // ===================================================================
  //  sphere (lament_sphere): cube -> sphere morph, rebuilt per frame
  // ===================================================================
  const SPH_FACETS = 16, SPH_SIZE = 3;
  const sphNorms = [[0, -1, 0], [0, 0, 1], [0, 1, 0], [0, 0, -1], [-1, 0, 0], [1, 0, 0]];
  const sphNquad = 6 * SPH_FACETS * SPH_FACETS;         // quads
  const sphPos = new Float32Array(sphNquad * 6 * 3);    // 2 tris * 3 verts
  const sphNor = new Float32Array(sphNquad * 6 * 3);
  const sphUv = new Float32Array(sphNquad * 6 * 2);
  const sphGeom = new THREE.BufferGeometry();
  sphGeom.setAttribute('position', new THREE.BufferAttribute(sphPos, 3).setUsage(THREE.DynamicDrawUsage));
  sphGeom.setAttribute('normal', new THREE.BufferAttribute(sphNor, 3).setUsage(THREE.DynamicDrawUsage));
  sphGeom.setAttribute('uv', new THREE.BufferAttribute(sphUv, 2).setUsage(THREE.DynamicDrawUsage));
  const sphereMesh = new THREE.Mesh(sphGeom, matSphere);
  sphereMesh.matrixAutoUpdate = false;
  sphereMesh.matrix.identity();
  sphereMesh.visible = false;
  stateRoot.add(sphereMesh);

  // texturize_vert(face 1..6, raw vertex) -> [u,v] (matches lament.c / the converter).
  function texUV(face, v0, v1, v2) {
    let s = 0, q = 0;
    switch (face) {
      case 1: s = v0; q = v2; break;
      case 2: s = v0; q = v1; break;
      case 3: s = v0; q = SPH_SIZE - v2; break;
      case 4: s = v0; q = SPH_SIZE - v1; break;
      case 5: s = v1; q = v2; break;
      default: s = v1; q = v2; break;
    }
    return [s / SPH_SIZE, q / SPH_SIZE];
  }

  function buildSphere(ratio) {
    const size = SPH_SIZE, facets = SPH_FACETS, s = 1.0 / facets;
    const ratio2 = 1 - Math.sin((1 - ratio) / 2 * Math.PI);
    const r1 = 1 - ratio2 / 2, r2 = ratio2 / 2;
    let vp = 0, np = 0, up = 0;
    // group starts per face (6 contiguous groups)
    sphGeom.clearGroups();
    for (let face = 0; face < 6; face++) {
      const gstart = vp / 3;
      for (let yy = 0; yy < facets; yy++) {
        for (let xx = 0; xx < facets; xx++) {
          const x0 = xx * s, y0 = yy * s, x1 = x0 + s, y1 = y0 + s;
          const pa = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
          let frontp;
          if (sphNorms[face][0]) {
            frontp = sphNorms[face][0] < 0;
            const c0 = frontp ? 0 : 1;
            pa[0][1] = x0; pa[0][2] = y0; pa[0][0] = c0;
            pa[1][1] = x1; pa[1][2] = y0; pa[1][0] = c0;
            pa[2][1] = x1; pa[2][2] = y1; pa[2][0] = c0;
            pa[3][1] = x0; pa[3][2] = y1; pa[3][0] = c0;
          } else if (sphNorms[face][1]) {
            frontp = sphNorms[face][1] > 0;
            const c1 = frontp ? 1 : 0;
            pa[0][0] = x0; pa[0][2] = y0; pa[0][1] = c1;
            pa[1][0] = x1; pa[1][2] = y0; pa[1][1] = c1;
            pa[2][0] = x1; pa[2][2] = y1; pa[2][1] = c1;
            pa[3][0] = x0; pa[3][2] = y1; pa[3][1] = c1;
          } else {
            frontp = sphNorms[face][2] < 0;
            const c2 = frontp ? 0 : 1;
            pa[0][0] = x0; pa[0][1] = y0; pa[0][2] = c2;
            pa[1][0] = x1; pa[1][1] = y0; pa[1][2] = c2;
            pa[2][0] = x1; pa[2][1] = y1; pa[2][2] = c2;
            pa[3][0] = x0; pa[3][1] = y1; pa[3][2] = c2;
          }
          for (let i = 0; i < 4; i++) { pa[i][0] *= size; pa[i][1] *= size; pa[i][2] *= size; }
          // square -> sphere (normalized vector), lerped by `ratio`
          const pb = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
          for (let i = 0; i < 4; i++) {
            const X = pa[i][0] / size - 0.5, Y = pa[i][1] / size - 0.5, Z = pa[i][2] / size - 0.5;
            const d = Math.sqrt(X * X + Y * Y + Z * Z) / 2 || 1e-9;
            const sx = X / d + size / 2, sy = Y / d + size / 2, sz = Z / d + size / 2;
            pb[i][0] = pa[i][0] + (sx - pa[i][0]) * ratio;
            pb[i][1] = pa[i][1] + (sy - pa[i][1]) * ratio;
            pb[i][2] = pa[i][2] + (sz - pa[i][2]) * ratio;
          }
          // flat cube normal (calc_normal of pa0,pa1,pa2), weighted with radial normals
          const ux = pa[1][0] - pa[0][0], uy = pa[1][1] - pa[0][1], uz = pa[1][2] - pa[0][2];
          const wx = pa[2][0] - pa[0][0], wy = pa[2][1] - pa[0][1], wz = pa[2][2] - pa[0][2];
          const nax = uy * wz - uz * wy, nay = uz * wx - ux * wz, naz = ux * wy - uy * wx;
          const nrm = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
          for (let i = 0; i < 4; i++) {
            const bl = Math.sqrt(pb[i][0] * pb[i][0] + pb[i][1] * pb[i][1] + pb[i][2] * pb[i][2]) || 1e-9;
            nrm[i][0] = nax * r1 + (pb[i][0] / bl) * r2;
            nrm[i][1] = nay * r1 + (pb[i][1] / bl) * r2;
            nrm[i][2] = naz * r1 + (pb[i][2] / bl) * r2;
          }
          // bake lament_sphere's outer Translate(-0.5)*Scale(1/size): pos/size - 0.5
          const uvv = [];
          for (let i = 0; i < 4; i++) uvv.push(texUV(face + 1, pa[i][0], pa[i][1], pa[i][2]));
          const emit = (i) => {
            sphPos[vp] = pb[i][0] / size - 0.5; sphPos[vp + 1] = pb[i][1] / size - 0.5; sphPos[vp + 2] = pb[i][2] / size - 0.5;
            sphNor[np] = nrm[i][0]; sphNor[np + 1] = nrm[i][1]; sphNor[np + 2] = nrm[i][2];
            sphUv[up] = uvv[i][0]; sphUv[up + 1] = uvv[i][1];
            vp += 3; np += 3; up += 2;
          };
          emit(0); emit(1); emit(2); emit(0); emit(2); emit(3);
        }
      }
      sphGeom.addGroup(gstart, (vp / 3) - gstart, face);
    }
    sphGeom.attributes.position.needsUpdate = true;
    sphGeom.attributes.normal.needsUpdate = true;
    sphGeom.attributes.uv.needsUpdate = true;
    sphGeom.computeBoundingSphere();
  }

  // ===================================================================
  //  LEVIATHAN: procedural cone fans (leviathan()) + fade shields +
  //  folding walls (folding_walls()). The six iso axis "arms" reuse the
  //  static iso_* meshes; only these procedural parts are rebuilt per frame.
  // ===================================================================
  const I4 = new THREE.Matrix4();                       // const identity (never mutated)
  // do_normal / calc_normal (normals.c): unnormalized (p1-p) x (p2-p); GL_NORMALIZE is
  // on, so we normalize at build time.
  function calcNormal(p, p1, p2, out) {
    const ax = p1.x - p.x, ay = p1.y - p.y, az = p1.z - p.z;
    const bx = p2.x - p.x, by = p2.y - p.y, bz = p2.z - p.z;
    return out.set(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
  }

  // a small dynamic non-indexed mesh (triCount triangles): position/normal/uv sized
  // triCount*3 verts -> *3 / *2 floats. (buffer-sizing: verts*3 floats for pos/normal.)
  function makeDynMesh(triCount, mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(triCount * 9), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(triCount * 9), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(triCount * 6), 2).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.Mesh(g, mat);
    m.matrixAutoUpdate = false; m.matrix.identity(); m.visible = false;
    stateRoot.add(m);
    return { mesh: m, geom: g };
  }
  const coneTop = makeDynMesh(3, matLeviathan);         // 3 cone facets
  const coneBottom = makeDynMesh(3, matLeviathan);
  const shieldTop = makeDynMesh(6, matShield);          // 3 quads = 6 tris
  const shieldBottom = makeDynMesh(6, matShield);
  const walls = [];                                     // 0..2 = bottom, 3..5 = top
  const WALL_TILE = [0, 5, 1, 4, 2, 3];                 // tex[] map (bottom i, then top i)
  for (let i = 0; i < 6; i++) walls.push(makeDynMesh(2, matWall[WALL_TILE[i]]));
  coneTop.mesh.renderOrder = 0; coneBottom.mesh.renderOrder = 0;
  shieldTop.mesh.renderOrder = 1; shieldBottom.mesh.renderOrder = 1;
  for (const w of walls) w.mesh.renderOrder = 2;        // walls after shields (C order)
  const dynMeshes = [coneTop, coneBottom, shieldTop, shieldBottom, ...walls];

  // leviathan() cone geometry. r=0.34; apex at (2*ratio,0,0); base triangle radius r in
  // the x=0 plane; oriented onto the cube diagonal by Rot(-45,Y) Rot(-th,Z) [+Rot(180,Z)
  // for the bottom], th = acos(2/sqrt6). Rlocal is baked into the verts; the mesh matrix
  // holds only the call-site transform.
  const CONE_R = 0.34;
  const CONE_TH = Math.acos(2 / Math.sqrt(6));          // radians (~35.26 deg)
  const CONE_P = [];                                    // 3 base points [x,y]
  for (let i = 0; i < 3; i++) { const a = i * Math.PI * 2 / 3; CONE_P.push([Math.cos(a) * CONE_R, Math.sin(a) * CONE_R]); }
  const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _n = new THREE.Vector3();
  function coneLocalMatrix(top_p) {
    const m = new THREE.Matrix4().makeRotationY(-45 * DEG);
    m.multiply(new THREE.Matrix4().makeRotationZ(-CONE_TH));
    if (!top_p) m.multiply(new THREE.Matrix4().makeRotationZ(Math.PI));
    return m;
  }
  function buildCone(target, ratio, top_p) {
    const z = 2 * ratio;
    const Rloc = coneLocalMatrix(top_p);
    const pos = target.geom.attributes.position.array;
    const nor = target.geom.attributes.normal.array;
    const uv = target.geom.attributes.uv.array;
    let vp = 0, up = 0;
    const emit = (v, n, s, q) => {
      v.applyMatrix4(Rloc);
      pos[vp] = v.x; pos[vp + 1] = v.y; pos[vp + 2] = v.z;
      nor[vp] = n.x; nor[vp + 1] = n.y; nor[vp + 2] = n.z;
      uv[up] = s; uv[up + 1] = q;
      vp += 3; up += 2;
    };
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      _v0.set(z, 0, 0);
      _v1.set(0, CONE_P[i][0], CONE_P[i][1]);
      _v2.set(0, CONE_P[j][0], CONE_P[j][1]);
      calcNormal(_v0, _v1, _v2, _n).normalize().transformDirection(Rloc);
      // apex uv (0.5,1), base verts uv (0,0) and (1,0) -- as leviathan()
      emit(_v0, _n, 0.5, 1); emit(_v1, _n, 0, 0); emit(_v2, _n, 1, 0);
    }
    const a = target.geom.attributes;
    a.position.needsUpdate = true; a.normal.needsUpdate = true; a.uv.needsUpdate = true;
    target.geom.computeBoundingSphere();
  }
  // the "shield" quads (drawn when alpha<0.9): black occluder around the cone gap.
  function buildShield(target, ratio, top_p) {
    const z = 2 * ratio, a = 0.35, b = 0.69;
    const Rloc = coneLocalMatrix(top_p);
    const pos = target.geom.attributes.position.array;
    const nor = target.geom.attributes.normal.array;
    const uv = target.geom.attributes.uv.array;
    let vp = 0, up = 0;
    const P = [_v0, _v1, _v2, new THREE.Vector3()];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      P[0].set(z * a, CONE_P[j][0] * b, CONE_P[j][1] * b);
      P[1].set(z * a, CONE_P[i][0] * b, CONE_P[i][1] * b);
      P[2].set(0, CONE_P[i][0] * 1.01, CONE_P[i][1] * 1.01);
      P[3].set(0, CONE_P[j][0] * 1.01, CONE_P[j][1] * 1.01);
      for (const p of P) p.applyMatrix4(Rloc);
      calcNormal(P[0], P[1], P[2], _n).normalize();      // dark; lighting ~irrelevant
      const order = [0, 1, 2, 0, 2, 3];
      for (const k of order) {
        pos[vp] = P[k].x; pos[vp + 1] = P[k].y; pos[vp + 2] = P[k].z;
        nor[vp] = _n.x; nor[vp + 1] = _n.y; nor[vp + 2] = _n.z;
        uv[up] = 0; uv[up + 1] = 0;
        vp += 3; up += 2;
      }
    }
    const at = target.geom.attributes;
    at.position.needsUpdate = true; at.normal.needsUpdate = true; at.uv.needsUpdate = true;
    target.geom.computeBoundingSphere();
  }
  // one leviathan() call: cone (+ shield if alpha<0.9), both under `parent`.
  function placeLeviathan(coneT, shieldT, parent, ratio, alpha, top_p) {
    buildCone(coneT, ratio, top_p);
    coneT.mesh.matrix.copy(parent); coneT.mesh.visible = true;
    if (alpha < 0.9) {
      buildShield(shieldT, ratio, top_p);
      shieldT.mesh.matrix.copy(parent); shieldT.mesh.visible = true;
      matShield.opacity = 1 - alpha;
    }
  }

  // folding_walls(): 3 fading gold panels per half that hinge up by ratio*30.85 deg.
  const WALL_PA = [[-0.5, -0.215833], [0, 0.5], [0.5, 0], [-0.215833, -0.5]];
  const WALL_TOP = 0.215833, WALL_END = 30.85, WALL_C = WALL_TOP / 2 + 0.25;
  function baseMat(top_p) {
    if (top_p) {
      return new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, -1, 1).normalize(), 60 * DEG)
        .multiply(new THREE.Matrix4().makeRotationY(180 * DEG))
        .multiply(new THREE.Matrix4().makeRotationX(90 * DEG));
    }
    return new THREE.Matrix4().makeRotationX(180 * DEG);
  }
  function perIMat(i) {
    if (i === 1) {
      return new THREE.Matrix4().makeRotationX(-90 * DEG)
        .multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 1, 0).normalize(), 180 * DEG));
    }
    if (i === 2) {
      return new THREE.Matrix4().makeRotationX(-90 * DEG)
        .multiply(new THREE.Matrix4().makeRotationY(270 * DEG));     // Rot(180,Y)*Rot(90,Y)
    }
    return new THREE.Matrix4();                                       // i==0: identity
  }
  function wallTexcoords(i, top_p) {
    const t = WALL_PA.map((pa) => [pa[1] + 0.5, pa[0] + 0.5]);
    if (i === 0 && !top_p) { for (const c of t) { c[0] = 1 - c[0]; c[1] = 1 - c[1]; } }
    else if (i === 0 && top_p) { for (const c of t) c[0] = 1 - c[0]; }
    else if (i === 1) { for (const c of t) { const f = c[0]; c[0] = c[1]; c[1] = -f; } }
    return t;
  }
  function buildFoldingWallSet(ratio, top_p) {
    const rr = Math.sin(ratio / 2 * Math.PI);
    const offa = 0.15 * rr, offb = 0.06 * rr;
    const P = [
      [WALL_PA[0][0], 0.5, WALL_PA[0][1]],
      [WALL_PA[1][0] - offb, 0.5, WALL_PA[1][1] - offa],
      [WALL_PA[2][0] - offa, 0.5, WALL_PA[2][1] - offb],
      [WALL_PA[3][0], 0.5, WALL_PA[3][1]],
    ];
    const base = baseMat(top_p);
    const fold = new THREE.Matrix4().makeRotationY(-90 * DEG)
      .multiply(new THREE.Matrix4().makeTranslation(-WALL_C, 0.5, -WALL_C))
      .multiply(new THREE.Matrix4().makeRotationY(-45 * DEG))
      .multiply(new THREE.Matrix4().makeRotationZ(-ratio * WALL_END * DEG))
      .multiply(new THREE.Matrix4().makeRotationY(45 * DEG))
      .multiply(new THREE.Matrix4().makeTranslation(WALL_C, -0.5, WALL_C));
    for (let i = 0; i < 3; i++) {
      const Mw = new THREE.Matrix4().copy(base).multiply(perIMat(i)).multiply(fold);
      const t = wallTexcoords(i, top_p);
      const w = walls[(top_p ? 3 : 0) + i];
      const pos = w.geom.attributes.position.array;
      const nor = w.geom.attributes.normal.array;
      const uv = w.geom.attributes.uv.array;
      _v0.set(P[0][0], P[0][1], P[0][2]); _v1.set(P[1][0], P[1][1], P[1][2]); _v2.set(P[2][0], P[2][1], P[2][2]);
      calcNormal(_v0, _v1, _v2, _n).normalize();
      const order = [0, 1, 2, 0, 2, 3];
      let vp = 0, up = 0;
      for (const k of order) {
        pos[vp] = P[k][0]; pos[vp + 1] = P[k][1]; pos[vp + 2] = P[k][2];
        nor[vp] = _n.x; nor[vp + 1] = _n.y; nor[vp + 2] = _n.z;
        uv[up] = t[k][0]; uv[up + 1] = t[k][1];
        vp += 3; up += 2;
      }
      const at = w.geom.attributes;
      at.position.needsUpdate = true; at.normal.needsUpdate = true; at.uv.needsUpdate = true;
      w.geom.computeBoundingSphere();
      w.mesh.material.opacity = 1 - ratio;
      w.mesh.matrix.copy(Mw);
      w.mesh.visible = true;
    }
  }

  // The six iso axis "arms" fade via GL_CONSTANT_ALPHA: glBlendFunc(GL_CONSTANT_ALPHA,
  // GL_SRC_ALPHA) glBlendColor(1,1,1,A) -> additive, source scaled by A (arm material
  // alpha is 1, so dst factor SRC_ALPHA = 1). Reproduced with CustomBlending on the
  // shared gold/interior materials (the arms' only groups); base_a/b are black (group 7),
  // untouched, so they stay opaque as in the .c (drawn before glEnable(GL_BLEND)).
  function setArmBlend(A) {
    const on = A !== null;
    for (const m of [...matFace, matInterior]) {
      if (on) {
        m.transparent = true;
        m.blending = THREE.CustomBlending;
        m.blendEquation = THREE.AddEquation;
        m.blendSrc = THREE.ConstantAlphaFactor;
        m.blendDst = THREE.SrcAlphaFactor;
        m.blendColor.setRGB(1, 1, 1);
        m.blendAlpha = A;
      } else if (m.blending !== THREE.NormalBlending) {
        m.transparent = false;
        m.blending = THREE.NormalBlending;
      }
    }
  }

  const LEV_AXES = [
    ['iso_une', 0.633994, 0.442836, 0.633994],
    ['iso_usw', 0.442836, 0.633994, -0.633994],
    ['iso_dse', -0.633994, 0.633994, 0.442836],
    ['iso_swd', -0.633994, -0.442836, -0.633994],
    ['iso_den', -0.442836, -0.633994, 0.633994],
    ['iso_unw', 0.633994, -0.633994, -0.442836],
  ];
  // draw() for SPIN/UNSPIN/FADE/UNFADE/TWIST/UNTWIST. Returns the arm blend alpha A
  // (null = opaque, i.e. SPIN/UNSPIN or wireframe). Mirrors lament.c lines 1014-1092.
  function drawLeviathanSpin(type, anim_r, anim_y, anim_z) {
    let s = 1 - anim_z;
    let s2 = Math.max(0, 360 - anim_r) / 360;
    let blendp = false;
    if (type === S.LEVIATHAN_SPIN) { /* s2 as-is */ }
    else if (type === S.LEVIATHAN_UNSPIN) { s2 = 1 - s2; }
    else { s2 = 0; blendp = true; }
    if (config.wire) blendp = false;
    s = s * 0.6 + 0.4;
    const ratio = 1 - s2;

    // leviathan(1-s2,1,True) + iso_base_a, both at the base frame (identity).
    placeLeviathan(coneTop, shieldTop, I4, ratio, 1, true);
    show('iso_base_a', I4);
    // iso_use scaled by s2 (skip the singular scale-0 matrix; invisible there anyway).
    if (s2 > 1e-4) show('iso_use', new THREE.Matrix4().makeScale(s2, s2, s2));
    // iso_base_b + leviathan(False) under Rot(anim_y, (1,-1,1)).
    const Ry = new THREE.Matrix4().makeRotationAxis(AX.set(1, -1, 1).normalize(), anim_y * DEG);
    show('iso_base_b', Ry);
    placeLeviathan(coneBottom, shieldBottom, Ry, ratio, 1, false);
    // the six arms: Rot(anim_r, axis) Scale(s). i<3 under identity; i>=3 under Ry (the
    // extra Rot(anim_y) after i==2 persists onto the later draws + iso_dwn).
    const A = blendp ? Math.max(0, 1 - anim_z * 3) : null;
    for (let i = 0; i < 6; i++) {
      const [name, ax, ay, az] = LEV_AXES[i];
      const parent = (i < 3) ? I4 : Ry;
      const m = new THREE.Matrix4().copy(parent)
        .multiply(new THREE.Matrix4().makeRotationAxis(AX.set(ax, ay, az).normalize(), anim_r * DEG))
        .multiply(new THREE.Matrix4().makeScale(s, s, s));
      show(name, m);
    }
    // iso_dwn scaled by s2, under Ry.
    if (s2 > 1e-4) show('iso_dwn', new THREE.Matrix4().copy(Ry).multiply(new THREE.Matrix4().makeScale(s2, s2, s2)));
    return A;
  }
  // draw() for COLLAPSE/EXPAND (lament.c lines 1094-1105): two full cones (+ fade shields)
  // and the two sets of folding walls, all keyed off anim_y.
  function drawLeviathanCollapse(anim_y) {
    placeLeviathan(coneTop, shieldTop, I4, 1, anim_y, true);
    const R180 = new THREE.Matrix4().makeRotationAxis(AX.set(1, -1, 1).normalize(), 180 * DEG);
    placeLeviathan(coneBottom, shieldBottom, R180, 1, anim_y, false);
    buildFoldingWallSet(anim_y, true);
    buildFoldingWallSet(anim_y, false);
  }

  // ===================================================================
  //  state machine (init_lament / animate / shuffle_states)
  // ===================================================================
  const lc = {
    type: S.BOX, anim_r: 0, anim_y: 0, anim_z: 0, anim_pause: 0,
    state: 0, facing_p: false,
  };
  let states = [];
  function buildStates() {
    states = [];
    const push = (n, w) => { for (let i = 0; i < n; i++) states.push(w); };
    push(4, S.TETRA_UNE); push(4, S.TETRA_USW); push(4, S.TETRA_DWN); push(4, S.TETRA_DSE);
    push(8, S.STAR_OUT); push(8, S.TASER_OUT); push(8, S.PILLAR_OUT);
    push(4, S.LID_OPEN); push(2, S.SPHERE_OUT); push(1, S.LEVIATHAN_SPIN);
    push(35, S.BOX);
  }
  function shuffleStates() {
    for (let i = 0; i < states.length; i++) {
      const a = rng.random() % states.length;
      const t = states[a]; states[a] = states[i]; states[i] = t;
    }
  }
  buildStates();
  shuffleStates();
  lc.anim_pause = 300 + (rng.random() % 100);
  // Test seam (the analog of lament.c's DEBUG_MODE): opts.debugState forces an initial
  // transform so a screenshot rig needn't wait out the ~300-frame first rest. Inert in
  // production -- the host calls start(canvas[, {seed}]) and never passes debugState.
  if (opts.debugState && S[opts.debugState] != null) { lc.type = S[opts.debugState]; lc.anim_pause = 0; }

  const PAUSE = 10, PAUSE2 = 120;
  const speed = 1;   // ffwdp (space/tab) not ported -> always 1

  function animate() {
    switch (lc.type) {
      case S.BOX: {
        lc.state++;
        if (lc.state >= states.length) { shuffleStates(); lc.state = 0; }
        lc.type = states[lc.state];
        if (lc.type === S.BOX) lc.anim_pause = PAUSE2;
        lc.anim_r = 0; lc.anim_y = 0; lc.anim_z = 0;
        break;
      }
      // -------- STAR --------
      case S.STAR_OUT:
        lc.anim_z += 0.01 * speed;
        if (lc.anim_z >= 1.0) { lc.anim_z = 1.0; lc.type = S.STAR_ROT; lc.anim_pause = PAUSE; }
        break;
      case S.STAR_ROT:
        lc.anim_r += 1.0 * speed;
        if (lc.anim_r >= 45.0) { lc.anim_r = 45.0; lc.type = S.STAR_ROT_IN; lc.anim_pause = PAUSE; }
        break;
      case S.STAR_ROT_IN:
        lc.anim_z -= 0.01 * speed;
        if (lc.anim_z <= 0.0) { lc.anim_z = 0.0; lc.type = S.STAR_ROT_OUT; lc.anim_pause = PAUSE2 * (1 + frand(2) + frand(2)); }
        break;
      case S.STAR_ROT_OUT:
        lc.anim_z += 0.01 * speed;
        if (lc.anim_z >= 1.0) { lc.anim_z = 1.0; lc.type = S.STAR_UNROT; lc.anim_pause = PAUSE; }
        break;
      case S.STAR_UNROT:
        lc.anim_r -= 1.0 * speed;
        if (lc.anim_r <= 0.0) { lc.anim_r = 0.0; lc.type = S.STAR_IN; lc.anim_pause = PAUSE; }
        break;
      case S.STAR_IN:
        lc.anim_z -= 0.01 * speed;
        if (lc.anim_z <= 0.0) { lc.anim_z = 0.0; lc.type = S.BOX; lc.anim_pause = PAUSE2; }
        break;
      // -------- TETRA --------
      case S.TETRA_UNE: case S.TETRA_USW: case S.TETRA_DWN: case S.TETRA_DSE:
        lc.anim_r += 1.0 * speed;
        if (lc.anim_r >= 360.0) { lc.anim_r = 0.0; lc.type = S.BOX; lc.anim_pause = PAUSE2; }
        else if (lc.anim_r > 119.0 && lc.anim_r <= 120.0) { lc.anim_r = 120.0; lc.anim_pause = PAUSE; }
        else if (lc.anim_r > 239.0 && lc.anim_r <= 240.0) { lc.anim_r = 240.0; lc.anim_pause = PAUSE; }
        break;
      // -------- LID --------
      case S.LID_OPEN:
        lc.anim_r += 1.0 * speed;
        if (lc.anim_r >= 112.0) {
          lc.anim_r = 112.0; lc.anim_z = 0.0; lc.anim_pause = PAUSE2;
          lc.type = lc.facing_p ? S.LID_ZOOM : S.LID_CLOSE;
        }
        break;
      case S.LID_CLOSE:
        lc.anim_r -= 1.0 * speed;
        if (lc.anim_r <= 0.0) { lc.anim_r = 0.0; lc.type = S.BOX; lc.anim_pause = PAUSE2; }
        break;
      case S.LID_ZOOM:
        lc.anim_z += 0.01 * speed;
        if (lc.anim_z > 1.0) { lc.anim_r = 0.0; lc.anim_z = 0.0; lc.type = S.BOX; }
        break;
      // -------- TASER --------
      case S.TASER_OUT:
        lc.anim_z += 0.005 * speed;
        if (lc.anim_z >= 0.5) { lc.anim_z = 0.5; lc.type = S.TASER_SLIDE; lc.anim_pause = PAUSE * (1 + frand(5) + frand(5)); }
        break;
      case S.TASER_SLIDE:
        lc.anim_y += 0.005 * speed;
        if (lc.anim_y >= 0.255) { lc.anim_y = 0.255; lc.type = S.TASER_SLIDE_IN; lc.anim_pause = PAUSE2 * (1 + frand(5) + frand(5)); }
        break;
      case S.TASER_SLIDE_IN:
        lc.anim_y -= 0.0025 * speed;
        if (lc.anim_y <= 0.0) { lc.anim_y = 0.0; lc.type = S.TASER_IN; lc.anim_pause = PAUSE; }
        break;
      case S.TASER_IN:
        lc.anim_z -= 0.0025 * speed;
        if (lc.anim_z <= 0.0) { lc.anim_z = 0.0; lc.type = S.BOX; lc.anim_pause = PAUSE2; }
        break;
      // -------- PILLAR --------
      case S.PILLAR_OUT:
        if (lc.anim_y === 0) lc.anim_y += 0.005 * ((rng.random() % 5) ? -1 : 1) * speed;
        else if (lc.anim_y > 0) lc.anim_y += 0.005 * speed;
        else lc.anim_y -= 0.001 * speed;
        if (lc.anim_z === 0) {
          const i = rng.random() % 7;
          if (i === 0) lc.anim_z = 3; else if (i < 5) lc.anim_z = 2; else lc.anim_z = 1;
          lc.anim_r = 90.0 * (1 + frand(6)) * randsign();
        }
        if (lc.anim_y > 0.4) { lc.anim_y = 0.4; lc.type = S.PILLAR_SPIN; lc.anim_pause = PAUSE; }
        else if (lc.anim_y < -0.03) { lc.anim_y = -0.03; lc.type = S.PILLAR_SPIN; lc.anim_pause = PAUSE; }
        break;
      case S.PILLAR_SPIN: {
        const negp = lc.anim_r < 0;
        lc.anim_r += (negp ? 1 : -1) * speed;
        if (negp ? lc.anim_r > 0 : lc.anim_r < 0) { lc.anim_r = 0; lc.type = S.PILLAR_IN; }
        break;
      }
      case S.PILLAR_IN: {
        const negp = lc.anim_y < 0;
        lc.anim_y += (negp ? 1 : -1) * 0.005 * speed;
        if (negp ? lc.anim_y > 0 : lc.anim_y < 0) { lc.anim_y = 0; lc.anim_z = 0; lc.type = S.BOX; lc.anim_pause = PAUSE; }
        break;
      }
      // -------- SPHERE --------
      case S.SPHERE_OUT:
        lc.anim_y += 0.01 * speed;
        if (lc.anim_y >= 1) { lc.anim_y = 1; lc.type = S.SPHERE_IN; lc.anim_pause = PAUSE2 * (1 + frand(1) + frand(1)); }
        break;
      case S.SPHERE_IN:
        lc.anim_y -= 0.01 * speed;
        if (lc.anim_y <= 0) { lc.anim_y = 0; lc.type = S.BOX; lc.anim_pause = PAUSE; }
        break;
      // -------- LEVIATHAN (palindrome: SPIN->FADE->TWIST->COLLAPSE->hold->EXPAND->
      //          UNTWIST->UNFADE->UNSPIN->BOX) --------
      case S.LEVIATHAN_SPIN:
        lc.anim_r += 3.5 * speed;
        if (lc.anim_r >= 360 * 3) { lc.anim_r = 0; lc.type = S.LEVIATHAN_FADE; lc.anim_pause = 0; }
        break;
      case S.LEVIATHAN_FADE:
        lc.anim_z += 0.01 * speed;
        if (lc.anim_z >= 1) { lc.anim_z = 1; lc.type = S.LEVIATHAN_TWIST; lc.anim_pause = 0; }
        break;
      case S.LEVIATHAN_TWIST:
        lc.anim_y += 2 * speed;
        lc.anim_z = 1;
        if (lc.anim_y >= 180) { lc.anim_y = 0; lc.type = S.LEVIATHAN_COLLAPSE; lc.anim_pause = 0; }
        break;
      case S.LEVIATHAN_COLLAPSE:
        lc.anim_y += 0.01 * speed;
        if (lc.anim_y >= 1) { lc.anim_y = 1.0; lc.type = S.LEVIATHAN_EXPAND; lc.anim_pause = PAUSE2 * 4; }
        break;
      case S.LEVIATHAN_EXPAND:
        lc.anim_y -= 0.005 * speed;
        if (lc.anim_y <= 0) { lc.anim_y = 180; lc.type = S.LEVIATHAN_UNTWIST; }
        break;
      case S.LEVIATHAN_UNTWIST:
        lc.anim_y -= 2 * speed;
        lc.anim_z = 1;
        if (lc.anim_y <= 0) { lc.anim_y = 0; lc.type = S.LEVIATHAN_UNFADE; lc.anim_pause = 0; }
        break;
      case S.LEVIATHAN_UNFADE:
        lc.anim_z -= 0.1 * speed;
        if (lc.anim_z <= 0) { lc.anim_z = 0; lc.type = S.LEVIATHAN_UNSPIN; lc.anim_pause = 0; }
        break;
      case S.LEVIATHAN_UNSPIN:
        lc.anim_r += 3.5 * speed;
        if (lc.anim_r >= 360 * 2) { lc.anim_r = 0; lc.type = S.BOX; lc.anim_pause = PAUSE2; }
        break;
      default:
        // defensive fallback (should be unreachable now every family is implemented).
        lc.type = S.BOX; lc.anim_r = 0; lc.anim_y = 0; lc.anim_z = 0; lc.anim_pause = PAUSE2;
        break;
    }
  }

  // ===================================================================
  //  per-state rendering (draw()'s switch): position/show the meshes
  // ===================================================================
  const TETRA = {
    [S.TETRA_UNE]: { magic: 'tetra_une', ax: [1, 1, 1] },
    [S.TETRA_USW]: { magic: 'tetra_usw', ax: [1, 1, -1] },
    [S.TETRA_DWN]: { magic: 'tetra_dwn', ax: [1, -1, 1] },
    [S.TETRA_DSE]: { magic: 'tetra_dse', ax: [-1, 1, 1] },
  };
  const LID_D = 0.21582;
  const LID_LISTS = ['lid_a', 'lid_b', 'lid_c', 'lid_d'];

  function updateStateTransforms(anim) {
    hideAll();
    const { anim_r, anim_y, anim_z, type } = anim;
    let armA = null;                 // leviathan arm fade alpha (null = opaque)
    switch (type) {
      case S.BOX:
        show('box', M.identity());
        break;
      case S.STAR_OUT: case S.STAR_ROT: case S.STAR_ROT_IN:
      case S.STAR_ROT_OUT: case S.STAR_UNROT: case S.STAR_IN: {
        // STAR_U: T(0,0,anim_z/2) Rz(anim_r/2)
        const mU = new THREE.Matrix4().multiply(trans(0, 0, anim_z / 2)).multiply(rotZ(anim_r / 2));
        show('star_u', mU);
        // STAR_D: mU * T(0,0,-anim_z) * Rz(-anim_r)
        const mD = mU.clone().multiply(trans(0, 0, -anim_z)).multiply(rotZ(-anim_r));
        show('star_d', mD);
        break;
      }
      case S.TETRA_UNE: case S.TETRA_USW: case S.TETRA_DWN: case S.TETRA_DSE: {
        show('tetra_base', M.identity());
        const info2 = TETRA[type];
        for (const name of ['tetra_une', 'tetra_usw', 'tetra_dwn', 'tetra_dse']) {
          if (name === info2.magic) {
            AX.set(info2.ax[0], info2.ax[1], info2.ax[2]).normalize();
            show(name, new THREE.Matrix4().makeRotationAxis(AX, anim_r * DEG));
          } else {
            show(name, new THREE.Matrix4().identity());
          }
        }
        break;
      }
      case S.LID_OPEN: case S.LID_CLOSE: case S.LID_ZOOM: {
        const outer = new THREE.Matrix4();
        if (anim_z < 0.5) outer.multiply(trans(0, -30 * anim_z, 0));
        else outer.multiply(trans(8 * (0.5 - (anim_z - 0.5)), 0, 0));
        show('lid_base', outer);
        for (let i = 0; i < 4; i++) {
          const m = outer.clone()
            .multiply(rotY(90 * i))
            .multiply(trans(-LID_D, -0.5, LID_D))
            .multiply(rotY(-45))
            .multiply(rotX(-anim_r))
            .multiply(rotY(45))
            .multiply(trans(LID_D, 0.5, -LID_D))
            .multiply(rotY(-90 * i));
          show(LID_LISTS[i], m);
        }
        break;
      }
      case S.TASER_OUT: case S.TASER_SLIDE: case S.TASER_SLIDE_IN: case S.TASER_IN: {
        show('taser_base', new THREE.Matrix4().multiply(trans(0, -anim_z / 2, 0)));
        show('taser_a', new THREE.Matrix4().multiply(trans(0, anim_z / 2, 0)));
        show('taser_b', new THREE.Matrix4().multiply(trans(anim_y, anim_z / 2, 0)));
        break;
      }
      case S.PILLAR_OUT: case S.PILLAR_SPIN: case S.PILLAR_IN: {
        show('pillar_base', M.identity());
        const ma = new THREE.Matrix4();
        if (anim_z === 1 || anim_z === 3) ma.multiply(rotZ(anim_r)).multiply(trans(0, 0, anim_y));
        show('pillar_a', ma);
        const mb = new THREE.Matrix4();
        if (anim_z === 2 || anim_z === 3) mb.multiply(rotZ(anim_r)).multiply(trans(0, 0, -anim_y));
        show('pillar_b', mb);
        break;
      }
      case S.SPHERE_OUT: case S.SPHERE_IN:
        buildSphere(anim_y);
        sphereMesh.visible = true;
        break;
      case S.LEVIATHAN_SPIN: case S.LEVIATHAN_UNSPIN:
      case S.LEVIATHAN_FADE: case S.LEVIATHAN_UNFADE:
      case S.LEVIATHAN_TWIST: case S.LEVIATHAN_UNTWIST:
        armA = drawLeviathanSpin(type, anim_r, anim_y, anim_z);
        break;
      case S.LEVIATHAN_COLLAPSE: case S.LEVIATHAN_EXPAND:
        drawLeviathanCollapse(anim_y);
        break;
      default:
        show('box', M.identity());       // safe fallback
        break;
    }
    // reconcile the arm fade-blend on the shared gold/interior materials: additive
    // GL_CONSTANT_ALPHA (A != null) during FADE/UNFADE/TWIST/UNTWIST, opaque otherwise.
    setArmBlend(armA);
  }

  // facing_screen_p(): project object point (0,-5,0) through the common-root modelview
  // (worldTilt*winScale*spin*half); "facing" if it lands near screen center & in front.
  const facingPt = new THREE.Vector3();
  function computeFacing() {
    stateRoot.updateWorldMatrix(true, false);
    facingPt.set(0, -5, 0).applyMatrix4(stateRoot.matrixWorld).project(camera);
    // window x/W-0.5 = ndc.x/2 (|.|<0.15 -> |ndc|<0.3); window z<0.9 -> ndc.z<0.8.
    return (facingPt.z < 0.8 &&
      facingPt.x > -0.3 && facingPt.x < 0.3 &&
      facingPt.y > -0.3 && facingPt.y < 0.3);
  }

  // ===================================================================
  //  rotator + interpolation (engine.js pattern)
  // ===================================================================
  // make_rotator(0.5,0.5,0.5, spin_accel 1, wander 0, randomize True).
  const rot = makeRotator(
    { spinX: 0.5, spinY: 0.5, spinZ: 0.5, spinAccel: 1, wanderSpeed: 0, randomize: true },
    rng,
  );
  let curR = rot.getRotation(false), prevR = { ...curR };
  let curAnim = { r: 0, y: 0, z: 0, type: S.BOX };
  let prevAnim = { ...curAnim };
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpAngle = (a, b, t) => { let d = b - a; if (d > 0.5) d -= 1; else if (d < -0.5) d += 1; return a + d * t; };

  function stepFrame() {
    // draw() calls get_rotation every frame EXCEPT during LID_ZOOM (rotation frozen).
    prevR = curR;
    curR = (lc.type !== S.LID_ZOOM) ? rot.getRotation(true) : curR;
    // draw_lament: if anim_pause, count down; else animate().
    prevAnim = curAnim;
    if (lc.anim_pause > 0) lc.anim_pause--;
    else animate();
    curAnim = { r: lc.anim_r, y: lc.anim_y, z: lc.anim_z, type: lc.type };
  }

  // ===================================================================
  //  sizing (reshape_lament + scale_for_window)
  // ===================================================================
  function computeWindowScale(W, H) {
    let scale = 20;
    if (W > H) scale /= W / H;
    if (scale < 8) scale = 8;
    let target = 1.4 * 512;               // texture width 512 (or 512 when untextured)
    let max = 500;
    if (W > 2560) { target *= 2.5; max *= 2.5; }
    if (target > max) target = max;
    const size = Math.min(W, H);
    if (size > target) scale *= target / size;
    return scale;
  }
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    const hh = h / w;                       // glFrustum -h..h
    camera.aspect = w / h;
    camera.fov = 2 * Math.atan(hh / 5) * 180 / Math.PI;   // fovy = 2*atan(h/5)
    camera.updateProjectionMatrix();
    winScale.scale.setScalar(computeWindowScale(w, h));
  }
  syncSize();
  window.addEventListener('resize', syncSize);
  updateMaterials();

  // ===================================================================
  //  render loop
  // ===================================================================
  let raf = 0, last = 0, paused = false, ms = 16;
  let animAccum = 0;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    if (config.tex !== builtTex || config.wire !== builtWire) updateMaterials();

    // facing_p from the matrices the last frame rendered (as the .c's draw() does,
    // one draw ahead of the animate() that reads it).
    if (lc.type === S.LID_OPEN || lc.type === S.LID_CLOSE || lc.type === S.LID_ZOOM)
      lc.facing_p = computeFacing();

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    let frames = dt * effFps;

    // discrete per-original-frame ticks (rotator + animate), catch-up capped.
    animAccum += frames;
    let ticks = 0;
    while (animAccum >= 1 && ticks < MAX_TICKS) { stepFrame(); animAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) animAccum = 0;
    const a = animAccum;

    // spin: interpolate rotator between the last two ticks.
    spin.rotation.set(
      lerpAngle(prevR.x, curR.x, a) * 2 * Math.PI,
      lerpAngle(prevR.y, curR.y, a) * 2 * Math.PI,
      lerpAngle(prevR.z, curR.z, a) * 2 * Math.PI,
      'XYZ',
    );

    // anim: interpolate only within one state (a transition snaps to current to avoid
    // interpolating across a reset -- safe, since resets coincide with BOX re-entry).
    let A;
    if (prevAnim.type === curAnim.type) {
      A = {
        anim_r: lerp(prevAnim.r, curAnim.r, a),
        anim_y: lerp(prevAnim.y, curAnim.y, a),
        anim_z: lerp(prevAnim.z, curAnim.z, a),
        type: curAnim.type,
      };
    } else {
      A = { anim_r: curAnim.r, anim_y: curAnim.y, anim_z: curAnim.z, type: curAnim.type };
    }
    updateStateTransforms(A);

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      for (const g of geoms) g.dispose();
      sphGeom.dispose();
      for (const d of dynMeshes) d.geom.dispose();
      for (const m of allMats) m.dispose();
      for (const t of tileTextures) if (t) t.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() {
      // host 're-seed': restart from a fresh box + reshuffled transform order.
      lc.type = S.BOX; lc.anim_r = 0; lc.anim_y = 0; lc.anim_z = 0; lc.state = 0;
      buildStates(); shuffleStates();
      lc.anim_pause = 20 + (rng.random() % 40);
      curAnim = { r: 0, y: 0, z: 0, type: S.BOX }; prevAnim = { ...curAnim };
    },
    config,
    params,
  };
}

export default { title, info, start };
