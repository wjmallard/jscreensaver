// cubenetic.js -- "Cubenetic" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's cubenetic (Jamie Zawinski, 2002),
// hacks/glx/cubenetic.c. "A cubist Lavalite, sort of." A small set (default 5)
// of unit boxes stacked at the origin, each independently PULSATING -- its
// position and its width/height/depth each oscillate on their own sine wave -- so
// the boxes swell, shrink and slide through one another. Over every surface runs
// an ever-changing blobby plasma TEXTURE: a few moving wave sources whose summed,
// distance-falloff heights index a looping hue palette (the interference.c
// algorithm). The whole cluster slowly spins on all three axes and wanders.
//
// THE LOOK is LIT (GL_LIGHTING + one white directional GL_LIGHT0) opaque boxes,
// each given a per-box material colour from a smooth colormap that MODULATES
// (multiplies) the shared plasma texture (GL_MODULATE). So a face shows the blob
// pattern tinted by that box's colour, shaded by the single light. The texture is
// the defining visual and is regenerated every frame from scratch.
//
// Self-contained three.js (own overlay canvas + renderer + loop), like
// dangerball.js / cubestack.js. RNG = yarandom.js, spin+wander = rotator.js,
// the per-box colormap = colormap.js (make_smooth_colormap). The texture's
// hue-loop palette (make_color_loop == make_color_path over 3 HSV points) and the
// hsv_to_rgb it needs are ported inline below (colormap.js does not export them),
// keeping the hack self-contained. No image assets.
//
// Faithful to the .c:
//   * unit_cube transcribed vertex-for-vertex (the same 6 faces, per-face normals
//     and texCoords) into one shared BufferGeometry; DoubleSide stands in for the
//     .c's GL_CULL_FACE on a closed solid (pixel-identical, no winding risk).
//   * the texture: init_wave's heights[] decay-cosine table + interference()'s
//     per-pixel "sum each wave's heights[dist], % ncolors, index texture_colors"
//     written into a DataTexture, GL_NEAREST + GL_REPEAT, rebuilt every frame.
//   * shuffle_cubes' SINOID throb on x,y,z (amp 0.5) and w,h,d (amp 0.9, +1.0),
//     each box with its own random dx..dd frequencies; cube->color cycles the
//     smooth colormap one step per frame.
//   * draw_cube modelview: S(portrait)*S(1.1)*T(wander*{8,6,15})*R(spin xyz)*
//     S(2.5)*[per box T(x,y,z)*S(w,h,d)]; camera gluPerspective(30,1/h,1,100) +
//     gluLookAt(0,0,30, 0,0,0, +y).
//   * GL_LIGHT0: directional pos {1,0.5,1}, diffuse white, ambient 0.2; plus GL's
//     0.2 global ambient -> total ambient 0.4 (see the lighting note below).
//
// PACING -- render every rAF. CONTINUOUS state (wave phase, each box's throb
// frame + colour) advances by `frames = dt*effFps` so the trajectory matches the
// original's per-frame step, sampled smoothly. The DISCRETE rotator random-walk is
// ticked once per original-frame (at effFps) and the spin/wander interpolated
// between samples (the geometry-track convention). effFps = 1e6/(delay+OVERHEAD),
// OVERHEAD = 37500 us as across the track.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';
import { makeSmoothColormap } from './colormap.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes the raw glColor
// values to the framebuffer (no sRGB encoding) and the screenshots capture them as-is.
// Disable three's color management so the ports match GL: input colors are used raw (the
// setRGB(..., SRGBColorSpace) calls below become no-ops) and the output is not sRGB-
// encoded. Without this, lit/shaded faces render up to ~2.5x too bright (measured against
// the rubikblocks grayscale ground truth) and additive blends wash to gray.
THREE.ColorManagement.enabled = false;

export const title = 'cubenetic';

export const info = {
  author: 'Jamie Zawinski',
  year: 2002,
  description:
    'A cubist Lavalite, sort of. A pulsating set of overlapping boxes with ever-changing blobby patterns undulating across their surfaces.',
};

// ===================================================================
//  hsv_to_rgb + make_color_path (utils/hsv.c + utils/colors.c), ported inline
//  for the texture's hue loop. Verbatim from the faithful colormap.js port; the
//  cube colormap itself is imported (makeSmoothColormap), but make_color_loop /
//  make_color_path / hsv_to_rgb are not exported, so reproduced here.
// ===================================================================

// h in degrees (any int), s,v in [0,1] -> { r, g, b } in [0,1), 16-bit-quantized
// then /65536 exactly as the hacks consume hsv_to_rgb (trunc(C*65535)/65536).
function hsvToRgb(h, s, v) {
  if (s < 0) s = 0;
  if (v < 0) v = 0;
  if (s > 1) s = 1;
  if (v > 1) v = 1;
  const S = s, V = v;
  const hi = Math.trunc(h);
  const H = (hi % 360) / 60.0;
  const i = Math.trunc(H);
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

// make_color_path: space `total` colors evenly around the polygon of `npoints`
// HSV anchors (here always 3, S=V=1). Fills colors[] in place with { r, g, b }.
// Consumes no RNG. Ported verbatim from colors.c (the odd DH[i]*DH[j] edge term
// is in the original). The npoints 0/2 special-cases are unreachable for us.
function makeColorPath(npoints, h, s, v, colors, total) {
  const DH = new Array(npoints);
  const edge = new Array(npoints);
  const ratio = new Array(npoints);
  const nc = new Array(npoints);
  const dh = new Array(npoints);
  const ds = new Array(npoints);
  const dv = new Array(npoints);
  let circum = 0;

  for (let i = 0; i < npoints; i++) {
    const j = (i + 1) % npoints;
    let dd = (h[i] - h[j]) / 360;
    if (dd < 0) dd = -dd;
    if (dd > 0.5) dd = 0.5 - (dd - 0.5);
    DH[i] = dd;
  }
  for (let i = 0; i < npoints; i++) {
    const j = (i + 1) % npoints;
    edge[i] = Math.sqrt((DH[i] * DH[j]) +
                        ((s[j] - s[i]) * (s[j] - s[i])) +
                        ((v[j] - v[i]) * (v[j] - v[i])));
    circum += edge[i];
  }
  if (circum < 0.0001) return;
  for (let i = 0; i < npoints; i++) ratio[i] = edge[i] / circum;
  for (let i = 0; i < npoints; i++) nc[i] = Math.trunc(total * ratio[i]);
  for (let i = 0; i < npoints; i++) {
    const j = (i + 1) % npoints;
    if (nc[i] > 0) {
      dh[i] = 360 * (DH[i] / nc[i]);
      ds[i] = (s[j] - s[i]) / nc[i];
      dv[i] = (v[j] - v[i]) / nc[i];
    }
  }

  for (let i = 0; i < total; i++) colors[i] = { r: 0, g: 0, b: 0 };

  let k = 0;
  for (let i = 0; i < npoints; i++) {
    const distance = h[(i + 1) % npoints] - h[i];
    let direction = (distance >= 0 ? -1 : 1);
    if (distance <= 180 && distance >= -180) direction = -direction;
    for (let j = 0; j < nc[i]; j++, k++) {
      let hh = h[i] + (j * dh[i] * direction);
      if (hh < 0) hh += 360;
      colors[k] = hsvToRgb(Math.trunc(hh), s[i] + (j * ds[i]), v[i] + (j * dv[i]));
    }
  }
  // Float round-off can leave k < total: pad by duplicating the last color.
  if (k < total && k > 0)
    for (let i = k; i < total; i++) colors[i] = { ...colors[i - 1] };
}

export function start(hostCanvas, opts = {}) {
  const TWO_PI = Math.PI * 2;
  const OVERHEAD = 37500;     // us; the geometry-track family default (not measured)
  const NCOLORS = 256;        // cc->ncolors (both palettes)
  const TS = 256;             // texture_size (texture_width == texture_height)
  const MAX_CUBES = 20;       // xml "Boxes" high
  const MAX_WAVES = 20;       // xml "Surface pattern complexity" high

  // Knobs transcribed 1:1 from hacks/config/cubenetic.xml.
  const config = {
    delay: 20000,        // us (xml default; invert slider). NB cubenetic default is 20000.
    count: 5,            // MI_COUNT -- number of boxes (xml "Boxes")
    wander: true,        // do_wander
    spin: 'XYZ',         // do_spin axes (xml "rotation" select); default all three
    waveSpeed: 80,       // wave_speed   (xml "Surface pattern speed")
    waveRadius: 512,     // wave_radius  (xml "Surface pattern overlap")
    waves: 3,            // wave_count   (xml "Surface pattern complexity")
    texture: true,       // do_texture   (xml "Textured")
    wire: false,         // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'count', label: 'Boxes', type: 'range', min: 1, max: 20, step: 1, default: 5, lowLabel: 'Few', highLabel: 'Many', live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'spin', label: 'Rotation', type: 'select', default: 'XYZ', live: true, options: [
        { value: '0',   label: "Don't rotate" },
        { value: 'X',   label: 'Around X axis' },
        { value: 'Y',   label: 'Around Y axis' },
        { value: 'Z',   label: 'Around Z axis' },
        { value: 'XY',  label: 'Around X and Y axes' },
        { value: 'XZ',  label: 'Around X and Z axes' },
        { value: 'YZ',  label: 'Around Y and Z axes' },
        { value: 'XYZ', label: 'Around all three axes' },
      ] },
    { key: 'waveSpeed', label: 'Surface pattern speed', type: 'range', min: 5, max: 150, step: 1, default: 80, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    { key: 'waveRadius', label: 'Surface pattern overlap', type: 'range', min: 5, max: 600, step: 1, default: 512, lowLabel: 'Small', highLabel: 'Large', live: true },
    { key: 'waves', label: 'Surface pattern complexity', type: 'range', min: 1, max: 20, step: 1, default: 3, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'texture', label: 'Textured', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);

  // ===================================================================
  //  three.js scene -- lit, opaque, textured boxes
  // ===================================================================
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);
  // LIT path. Colour management is disabled (see the module-scope flag), so the cube
  // colours and the plasma texture are used RAW and the output is not sRGB-encoded.

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // gluPerspective(30, w/h, 1, 100) + gluLookAt(0,0,30, 0,0,0, 0,1,0).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // GL_LIGHT0: directional (pos w=0) from {1,0.5,1}, diffuse white. intensity PI
  // makes three's Lambert diffuse = albedo*NdotL like the GL fixed pipeline.
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(1, 0.5, 1);
  scene.add(light);
  // Ambient = GL's global model ambient (0.2) + LIGHT0's own ambient (0.2) = 0.4.
  // three's indirect diffuse is ambientColor/PI * albedo, so intensity 0.4*PI ->
  // 0.4*albedo. (Material specular defaults to black in GL here -> no highlight.)
  const ambient = new THREE.AmbientLight(0xffffff, 0.4 * Math.PI);
  scene.add(ambient);

  // ---- unit_cube: the 6 faces transcribed vertex-for-vertex (pos, per-face
  // normal, texCoord). DoubleSide == the .c's GL_CULL_FACE on a closed solid. ----
  const FACES = [
    { n: [0, 0, 1],  c: [[ .5, -.5,  .5, 1, 0], [ .5,  .5,  .5, 0, 0], [-.5,  .5,  .5, 0, 1], [-.5, -.5,  .5, 1, 1]] }, // front
    { n: [0, 0, -1], c: [[-.5, -.5, -.5, 0, 0], [-.5,  .5, -.5, 0, 1], [ .5,  .5, -.5, 1, 1], [ .5, -.5, -.5, 1, 0]] }, // back
    { n: [-1, 0, 0], c: [[-.5,  .5,  .5, 1, 1], [-.5,  .5, -.5, 1, 0], [-.5, -.5, -.5, 0, 0], [-.5, -.5,  .5, 0, 1]] }, // left
    { n: [1, 0, 0],  c: [[ .5, -.5, -.5, 1, 1], [ .5,  .5, -.5, 1, 0], [ .5,  .5,  .5, 0, 0], [ .5, -.5,  .5, 0, 1]] }, // right
    { n: [0, 1, 0],  c: [[ .5,  .5,  .5, 0, 0], [ .5,  .5, -.5, 0, 1], [-.5,  .5, -.5, 1, 1], [-.5,  .5,  .5, 1, 0]] }, // top
    { n: [0, -1, 0], c: [[-.5, -.5,  .5, 1, 0], [-.5, -.5, -.5, 0, 0], [ .5, -.5, -.5, 0, 1], [ .5, -.5,  .5, 1, 1]] }, // bottom
  ];
  const cubePos = [], cubeNor = [], cubeUv = [];
  for (const f of FACES)
    for (const i of [0, 1, 2, 0, 2, 3]) {     // quad -> two triangles
      const c = f.c[i];
      cubePos.push(c[0], c[1], c[2]);
      cubeNor.push(f.n[0], f.n[1], f.n[2]);
      cubeUv.push(c[3], c[4]);
    }
  const cubeGeo = new THREE.BufferGeometry();
  cubeGeo.setAttribute('position', new THREE.Float32BufferAttribute(cubePos, 3));
  cubeGeo.setAttribute('normal', new THREE.Float32BufferAttribute(cubeNor, 3));
  cubeGeo.setAttribute('uv', new THREE.Float32BufferAttribute(cubeUv, 2));

  // ---- the plasma texture (a DataTexture rebuilt each frame) ----
  const texData = new Uint8Array(TS * TS * 4).fill(0xFF);   // memset 0xFF (alpha stays 255)
  const tex = new THREE.DataTexture(texData, TS, TS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;     // built from glColor-space colour values
  tex.magFilter = THREE.NearestFilter;       // GL_NEAREST
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;          // GL_REPEAT
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;

  // One material per box (shared geometry + shared texture; per-box .color is the
  // GL_MODULATE tint). Material specular black -> matte, like the GL default.
  const cubeMats = [];
  const cubeMeshes = [];
  for (let i = 0; i < MAX_CUBES; i++) {
    const m = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      specular: 0x000000,
      shininess: 0,
      side: THREE.DoubleSide,
      map: tex,
    });
    cubeMats.push(m);
    const mesh = new THREE.Mesh(cubeGeo, m);
    mesh.frustumCulled = false;
    cubeMeshes.push(mesh);
  }

  // Nested groups mirroring draw_cube's modelview:
  //   outer (S portrait*1.1) > trans (wander) > spinG (R) > inner (S 2.5) > boxes
  const outer = new THREE.Group();
  const trans = new THREE.Group();
  const spinG = new THREE.Group();
  const inner = new THREE.Group();
  inner.scale.setScalar(2.5);
  for (const mesh of cubeMeshes) inner.add(mesh);
  spinG.add(inner);
  trans.add(spinG);
  outer.add(trans);
  scene.add(outer);

  // ===================================================================
  //  simulation state
  // ===================================================================
  let cubeColors = [];        // NCOLORS THREE.Color (smooth colormap, used raw -- CM off)
  let texPal = new Uint8Array(NCOLORS * 3);   // texture_colors as 8-bit RGB
  let heights = new Int32Array(1);            // init_wave heights[] (size waveRadius+1)
  let curRadius = -1;                         // last radius heights[] was built for

  const cubes = [];           // per-box throb frequencies + phase + colour
  const waveXth = new Float64Array(MAX_WAVES);
  const waveYth = new Float64Array(MAX_WAVES);
  const srcX = new Int32Array(MAX_WAVES);
  const srcY = new Int32Array(MAX_WAVES);

  // reset_colors: texture hue-loop + cube smooth colormap (space bar re-rolls).
  function rollColors() {
    // texture_colors = make_color_loop over 3 HSV points, hue {h0, h0+60, h0+120}
    // (mod 360), S=V=1 (h0 = (int)frand(360), the double truncated to make_color_loop's
    // int arg). The full-saturation loop is the vivid red/yellow/green plasma palette.
    const h0 = Math.trunc(rng.frand(360.0));
    const h1 = (h0 + 60 < 360) ? (h0 + 60) : (h0 + 60 - 360);
    const h2 = (h1 + 60 < 360) ? (h1 + 60) : (h1 + 60 - 360);
    const loop = new Array(NCOLORS);
    makeColorPath(3, [h0, h1, h2], [1, 1, 1], [1, 1, 1], loop, NCOLORS);
    for (let i = 0; i < NCOLORS; i++) {
      const c = loop[i] || { r: 0, g: 0, b: 0 };
      texPal[i * 3]     = to255(c.r);     // texture_colors[i].red  >> 8
      texPal[i * 3 + 1] = to255(c.g);
      texPal[i * 3 + 2] = to255(c.b);
    }
    // cube_colors = make_smooth_colormap; used raw (colour management disabled).
    cubeColors = makeSmoothColormap(rng, NCOLORS).map(
      (c) => new THREE.Color().setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace));
  }
  // 16-bit-quantized [0,1) channel -> 8-bit, matching the X server's red>>8.
  function to255(c) { return c <= 0 ? 0 : c >= 1 ? 255 : Math.floor(c * 256); }

  // init_wave's height table: heights[i] = (max + max*cos(i/50))/2 truncated,
  // max = ncolors*(radius-i)/radius (a decaying cosine ramp). Slot [radius] kept 0
  // so interference()'s `dist > radius ? 0 : heights[dist]` is in-bounds at dist==radius.
  function rebuildHeights() {
    const radius = config.waveRadius;
    heights = new Int32Array(radius + 1);
    for (let i = 0; i < radius; i++) {
      const max = NCOLORS * (radius - i) / radius;
      heights[i] = (max + max * Math.cos(i / 50.0)) / 2.0 | 0;
    }
    curRadius = radius;
  }

  function initSim() {
    rollColors();
    // init_cube's per-box randoms: color, then dx,dy,dz,dw,dh,dd = frand(0.1).
    // All MAX_CUBES preallocated (the first config.count are shown); each box's
    // throb `frame` and colour advance continuously below.
    cubes.length = 0;
    for (let i = 0; i < MAX_CUBES; i++) {
      cubes.push({
        colorf: rng.random() % NCOLORS,   // cube->color start; advances 1/frame
        dx: rng.frand(0.1), dy: rng.frand(0.1), dz: rng.frand(0.1),
        dw: rng.frand(0.1), dh: rng.frand(0.1), dd: rng.frand(0.1),
        frame: 0,
      });
    }
    // init_wave: each source's xth/yth phase = frand(2.0)*PI.
    for (let i = 0; i < MAX_WAVES; i++) {
      waveXth[i] = rng.frand(2.0) * Math.PI;
      waveYth[i] = rng.frand(2.0) * Math.PI;
    }
  }
  initSim();

  // ===================================================================
  //  interference(): regenerate the plasma texture for this frame
  // ===================================================================
  // SINOID(scale, frame, size): the box-throb macro from shuffle_cubes.
  function sinoid(scale, frame, size) {
    return ((1 + Math.sin((frame * scale) / 2 * Math.PI)) / 2.0) * size - size / 2;
  }

  function regenTexture(frames) {
    if (config.waveRadius !== curRadius) rebuildHeights();
    const nw = config.waves;
    const radius = config.waveRadius;
    const step = config.waveSpeed / 1000.0;

    // Move the wave origins (xth/yth advance by speed/1000 per original-frame).
    for (let i = 0; i < nw; i++) {
      waveXth[i] += step * frames;
      while (waveXth[i] > TWO_PI) waveXth[i] -= TWO_PI;
      waveYth[i] += step * frames;
      while (waveYth[i] > TWO_PI) waveYth[i] -= TWO_PI;
      srcX[i] = (TS / 2 + Math.cos(waveXth[i]) * TS / 2) | 0;   // int (struct field)
      srcY[i] = (TS / 2 + Math.cos(waveYth[i]) * TS / 2) | 0;
    }

    // Per-pixel: sum each wave's heights[dist], % ncolors, index the hue palette.
    const data = texData, hgt = heights, pal = texPal;
    let o = 0;
    for (let y = 0; y < TS; y++) {
      for (let x = 0; x < TS; x++) {
        let result = 0;
        for (let i = 0; i < nw; i++) {
          const dx = x - srcX[i];
          const dy = y - srcY[i];
          const dist = Math.sqrt(dx * dx + dy * dy) | 0;
          result += dist > radius ? 0 : hgt[dist];
        }
        result %= NCOLORS;
        const p = result * 3;
        data[o] = pal[p]; data[o + 1] = pal[p + 1]; data[o + 2] = pal[p + 2];
        o += 4;   // data[o+3] left at 0xFF
      }
    }
    tex.needsUpdate = true;
  }

  // ===================================================================
  //  rotator sampling + interpolation (the discrete random-walk)
  // ===================================================================
  // make_rotator(spinx?1:0, spiny?1:0, spinz?1:0, 1.0, wander?0.05:0,
  //              spinx&&spiny&&spinz). Built ONCE at full speed for all three axes
  //  + randomize (the XYZ default), then the OUTPUT is gated live by config.spin /
  // config.wander -- the dangerball pattern (no rebuild on toggle).
  const rot = makeRotator(
    { spinX: 1, spinY: 1, spinZ: 1, spinAccel: 1.0, wanderSpeed: 0.05, randomize: true },
    rng,
  );
  const r0 = rot.getRotation(false);
  const p0 = rot.getPosition(false);
  let prevR = { ...r0 }, curR = { ...r0 };
  let prevP = { ...p0 }, curP = { ...p0 };
  let rotAccum = 0;
  function tickRotator() {
    prevR = curR; curR = rot.getRotation(true);
    prevP = curP; curP = rot.getPosition(true);
  }
  // shortest-path lerp on the [0,1) rotation circle (rotx etc. are abs, wrap at 1).
  function lerpAngle(a, b, t) {
    let d = b - a;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    return a + d * t;
  }
  const lerp = (a, b, t) => a + (b - a) * t;

  function spinAxes() {
    const s = (config.spin || '').toUpperCase();
    return { x: s.includes('X'), y: s.includes('Y'), z: s.includes('Z') };
  }

  // ===================================================================
  //  sizing (reshape_cube: gluPerspective + the portrait-fit scale * 1.1)
  // ===================================================================
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const s = (w < h ? w / h : 1);     // reshape glScalef(s,s,s)
    outer.scale.setScalar(s * 1.1);    // folded with draw_cube's glScalef(1.1)
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // Build the first texture so frame 0 isn't blank (the .c shuffle_textures once).
  regenTexture(0);
  let mapApplied = true;   // whether the texture map is currently attached

  // ===================================================================
  //  render loop
  // ===================================================================
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

    // Discrete random-walk: tick at the original cadence, interpolate for render.
    rotAccum += frames;
    let ticks = 0;
    while (rotAccum >= 1 && ticks < MAX_TICKS) { tickRotator(); rotAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) rotAccum = 0;
    const a = rotAccum;

    // Spin (gated per axis) -- glRotatef x,y,z (deg) == three Euler 'XYZ'.
    const ax = spinAxes();
    spinG.rotation.set(
      ax.x ? lerpAngle(prevR.x, curR.x, a) * TWO_PI : 0,
      ax.y ? lerpAngle(prevR.y, curR.y, a) * TWO_PI : 0,
      ax.z ? lerpAngle(prevR.z, curR.z, a) * TWO_PI : 0,
      'XYZ',
    );
    // Wander -- glTranslatef((x-.5)*8, (y-.5)*6, (z-.5)*15).
    if (config.wander) {
      trans.position.set(
        (lerp(prevP.x, curP.x, a) - 0.5) * 8,
        (lerp(prevP.y, curP.y, a) - 0.5) * 6,
        (lerp(prevP.z, curP.z, a) - 0.5) * 15,
      );
    } else trans.position.set(0, 0, 0);

    // GL_MODULATE texture is on unless texturing is off or wireframe (the .c forces
    // do_texture=False under wireframe). Attaching/detaching map recompiles the
    // material, so flip all of them only on an actual change.
    const useTexture = config.texture && !config.wire;
    if (useTexture !== mapApplied) {
      for (const m of cubeMats) { m.map = useTexture ? tex : null; m.needsUpdate = true; }
      mapApplied = useTexture;
    }

    // Boxes: throb + colour cycle (continuous), then show the first config.count.
    const n = config.count;
    for (let i = 0; i < MAX_CUBES; i++) {
      const mesh = cubeMeshes[i];
      const vis = i < n;
      mesh.visible = vis;
      if (!vis) continue;
      const cu = cubes[i];
      const f = cu.frame;
      mesh.position.set(sinoid(cu.dx, f, 0.5), sinoid(cu.dy, f, 0.5), sinoid(cu.dz, f, 0.5));
      mesh.scale.set(
        sinoid(cu.dw, f, 0.9) + 1.0,
        sinoid(cu.dh, f, 0.9) + 1.0,
        sinoid(cu.dd, f, 0.9) + 1.0,
      );
      cu.frame += frames;
      cu.colorf += frames;
      if (cu.colorf >= NCOLORS) cu.colorf -= NCOLORS;
      cubeMats[i].color.copy(cubeColors[Math.floor(cu.colorf) % NCOLORS]);
      cubeMats[i].wireframe = config.wire;
    }

    // Regenerate the plasma (only when actually textured).
    if (useTexture) regenTexture(frames);

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      cubeGeo.dispose();
      for (const m of cubeMats) m.dispose();
      tex.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { rollColors(); },   // space-bar reset_colors: re-roll both palettes
    config,
    params,
  };
}

export default { title, info, start };
