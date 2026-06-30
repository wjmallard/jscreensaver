// discoball.js -- "Discoball" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's discoball (Jamie Zawinski, 2016),
// hacks/glx/discoball.c. A dusty, dented disco ball: a sphere tiled with small flat
// MIRROR facets (each a thin slab -- a square top face + four short side walls), lit
// by two below-the-ball directional lights so the facets glint as the ball turns,
// with a handful of additive pinkish light BEAMS glowing in front. Woop woop.
//
// Self-contained three.js (own overlay canvas + renderer + loop), like dangerball.js /
// morph3d.js. RNG = the shared yarandom.js; motion = the shared rotator.js. No assets
// (the beam glow texture is generated in build_texture()).
//
// FAITHFUL TO discoball.c -- "do not deviate from the algorithm":
//   * build_ball()'s TESSELLATION: rings from +PI/2 down to -PI/2 stepping by
//     tile_size = PI/rows; per ring, row_tiles = floor(min(circ_lo,circ_hi)/tile_size)
//     tiles evenly spaced; each tile sits on the unit sphere, size = tile_size*0.85
//     (the 15% gap = the grout). Each tile's facing NORMAL is skewed by a small random
//     (+0.06..+0.12 per axis) and the square is spun in-plane by tilt = 4-BELLRAND(8)
//     deg -- so neighbours catch the light at slightly different moments (the glitter).
//   * The DENTS: 0..4 random dent points push nearby tiles inward (position *= s),
//     bend their normals away, and DROP the tiles near each dent's apex (angle<dropsy)
//     plus a 1/150-per-dent random drop -- the "dusty, dented" missing-tile look.
//   * Each tile = the .c's flat slab: a top mirror QUAD (normal +Y) + 4 side-wall quads
//     down to y=-0.2, each with its own flat normal. All tiles are baked into ONE static
//     merged geometry (transformed to ball-local space) and the whole thing just spins.
//   * draw_ball modelview: wander T((p-0.5)*{6,6,2}) -> [spin] -> Rx(50) -> Scale(4) ->
//     Rz(th); th += +-speed/frame (constant-direction spin about the tilted axis), the
//     ball's only motion by default (do_spin defaults False, do_wander True).
//   * The light BEAMS (draw_rays): 5..14 additive textured quads, each oriented to a
//     random ray normal (cos t, sin t, 1), scaled (5,5,10). The billboard-mask code
//     zeroes the modelview's rotation/scale 3x3 IN PLACE, and the front rays reuse THAT
//     matrix -- so the beams ride a pure-translation, camera-facing, UNSCALED frame at
//     the ball centre, pushed 4.1 toward the camera and spun about the VIEW axis by -th
//     (they hang just in front of the ball, turning in the screen plane). GL_SRC_ALPHA/
//     GL_ONE + the cos(r^2*6.2) glow texture -> THREE.AdditiveBlending + a gen'd alpha map.
//   * The depth-only billboard "substrate mask": a big camera-facing quad at the ball
//     centre (z=-0.4) writing depth but not colour, to occlude the far-side tiles seen
//     through the gaps (the .c draws it because there is no solid ball body).
//
// LIGHTING (the systematic geometry-track rules): two white DirectionalLights at
// intensity PI (to cancel three's 1/PI Lambert) from the GL light directions (both
// below the ball); material is GL_AMBIENT_AND_DIFFUSE = a ~0.6 grey, so the ambient
// floor = (global 0.2) * grey -> AmbientLight(white, 0.2*PI). SPECULAR is divided by PI
// (the glossy-facet blowout fix from superquadrics/morph3d): material.specular =
// cspec/PI, shininess 10 -- a controlled glint, not a white disc. WINDING: the .c draws
// under glFrontFace(GL_CW) + GL_CULL_FACE; we bake flat per-face normals and WIND each
// triangle to agree with its normal, then render FrontSide -- so the far-facing facets
// cull exactly as in GL. Colours used RAW (colour management disabled -> GL framebuffer).
//
// PACING as in dangerball.js: render every rAF, motion is continuous; effFps =
// 1e6/(delay+OVERHEAD), OVERHEAD = 37500; one render frame advances frames = dt*effFps
// original-frames (th spin continuous; rotator wander ticked at effFps + interpolated).
//
// OMITTED (chrome): the mouse trackball, -wireframe's facet-outline-only mode (we just
// toggle material.wireframe), and the tiny-window reshape special-case.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding). Disable three's color management so the
// port matches GL: set at MODULE SCOPE (before start() fills colors) so the
// setRGB(..., SRGBColorSpace) calls become no-ops and store RAW glColor, and the output
// is not sRGB-encoded. Without this, lit/shaded faces render up to ~2.5x too bright
// (measured vs the rubikblocks grayscale ground truth).
THREE.ColorManagement.enabled = false;

export const title = 'discoball';

export const info = {
  author: 'Jamie Zawinski',
  year: 2016,
  description: 'A dusty, dented disco ball. Woop woop.',
};

export function start(hostCanvas, opts = {}) {
  const DEG = Math.PI / 180;
  const OVERHEAD = 37500;     // us; calibrates xml default delay 30000 -> ~14.8fps
  const TILE_D = 0.2;         // draw_ball_1: side-wall depth `d`

  // Knobs transcribed 1:1 from hacks/config/discoball.xml ("Size" = the row count).
  const config = {
    delay: 30000,   // us, frame rate / overall speed (xml default; invert slider)
    speed: 1.0,     // th-spin degrees per original-frame (xml --speed)
    count: 30,      // rows of tiles -> "Size" (xml --count; .c clamps 10..200)
    wander: true,   // drift through space (do_wander, default True)
    spin: false,    // extra 3-axis tumble (do_spin, default False)
    wire: false,    // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.1, max: 5, step: 0.1, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'count', label: 'Size', type: 'range', min: 10, max: 100, step: 1, default: 30, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'spin', label: 'Spin', type: 'checkbox', default: false, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  // ---- RNG + the .c's helper macros ----
  const rng = makeYaRandom(opts.seed || 0);
  const frand = (f = 1) => rng.frand(f);
  const randsign = () => ((rng.random() & 1) ? 1 : -1);                 // RANDSIGN()
  const bellrand = (n) => (frand(n) + frand(n) + frand(n)) / 3;         // BELLRAND(n)

  // vector_angle(): angle (radians) between two vectors from the origin.
  function vectorAngle(ax, ay, az, bx, by, bz) {
    const La = Math.hypot(ax, ay, az), Lb = Math.hypot(bx, by, bz);
    if (La === 0 || Lb === 0) return 0;
    if (ax === bx && ay === by && az === bz) return 0;
    let cc = (ax * bx + ay * by + az * bz) / (La * Lb);
    if (cc > 1) cc = 1;
    return Math.acos(cc);
  }

  // ---- the beam glow texture (build_texture): luminance 1, alpha = cos(X^2*6.2)
  //      profile *0.4, brightest at the centre. We bake it as a white RGBA whose alpha
  //      is the glow (MeshBasicMaterial map * additive blend = colour * alpha added). ----
  function buildGlowTexture() {
    const size = 128;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let X = (x / (size - 1)) - 0.5;
        let Y = (y / (size - 1)) - 0.5;
        X = Math.cos(X * X * 6.2);
        Y = Math.cos(Y * Y * 6.2);
        X = X < Y ? X : Y;
        X *= 0.4;
        const a = Math.max(0, Math.min(255, Math.round(0xFF * X)));
        const i = (y * size + x) * 4;
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = a;
      }
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  }
  const glowTex = buildGlowTexture();

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

  // gluPerspective(30, w/h, 1, 100) + gluLookAt(0,0,30, 0,0,0, 0,1,0). LookAt here has
  // no rotation (straight down -z, up +y), so world == eye frame -- the lights below
  // are fixed in world space and the ball spins through them.
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // Two white directional lights (GL pos0 {0.5,-1,-0.5,0}, pos1 {-0.75,-1,0,0}; w=0 ->
  // direction = position). Both white diffuse + white specular, ambient 0; intensity PI
  // cancels three's 1/PI Lambert (two lights sum as in GL). Both below the ball.
  const l0 = new THREE.DirectionalLight(0xffffff, Math.PI); l0.position.set(0.5, -1, -0.5); scene.add(l0);
  const l1 = new THREE.DirectionalLight(0xffffff, Math.PI); l1.position.set(-0.75, -1, 0); scene.add(l1);
  // Ambient floor = (GL global 0.2 + light ambients 0) * material ambient (the grey
  // AMBIENT_AND_DIFFUSE colour); three's BRDF folds the material, so 0.2*PI.
  scene.add(new THREE.AmbientLight(0xffffff, 0.2 * Math.PI));

  // ---- materials ----
  // Facets: glossy grey (AMBIENT_AND_DIFFUSE). specular & colour set in setMaterial()
  // (random per run). shininess 10. FrontSide + agreeing winding == GL CULL_FACE.
  const tileMat = new THREE.MeshPhongMaterial({
    color: 0x999999,
    specular: 0x444444,
    shininess: 10,
    side: THREE.FrontSide,
  });
  // Beams: additive, textured, unlit, no depth (draw_rays disables LIGHTING + DEPTH_TEST
  // and blends GL_SRC_ALPHA/GL_ONE == THREE.AdditiveBlending). DoubleSide: a glow.
  const rayMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  // ---- modelview nesting (GL post-multiplies; innermost = last glRotatef) ----
  //   portraitFitG : Scale(s)             reshape portrait fit
  //   wanderG      : T((p-0.5)*{6,6,2})   + the depth mask (camera-facing, no rotation)
  //   spinG        : rotator 3-axis spin  (config.spin)
  //   tiltG        : Rx(50)               fixed lean
  //   scaleG       : Scale(4)             unit sphere -> radius 4; + the beams (z=4.1)
  //   thG          : Rz(th)               continuous spin -> the tiles
  const portraitFitG = new THREE.Group();
  const wanderG = new THREE.Group();
  const spinG = new THREE.Group();
  const tiltG = new THREE.Group(); tiltG.rotation.x = 50 * DEG;
  const scaleG = new THREE.Group(); scaleG.scale.setScalar(4);
  const thG = new THREE.Group();
  portraitFitG.add(wanderG); wanderG.add(spinG); spinG.add(tiltG); tiltG.add(scaleG);
  scaleG.add(thG);
  scene.add(portraitFitG);

  const tileMesh = new THREE.Mesh(new THREE.BufferGeometry(), tileMat);
  thG.add(tileMesh);

  // Beams: the billboard-mask code zeroes the modelview's 3x3 before the front rays
  // reuse it, so the beams ride a PURE-TRANSLATION (camera-facing, UNSCALED) frame at
  // the ball centre -- a sibling of spinG under wanderG, pushed 4.1 toward the camera,
  // then spun about the VIEW axis by -th.
  const beamsT = new THREE.Group(); beamsT.position.set(0, 0, 4.1);
  const beamsSpin = new THREE.Group();
  wanderG.add(beamsT); beamsT.add(beamsSpin);
  const raysMesh = new THREE.Mesh(new THREE.BufferGeometry(), rayMat);
  beamsSpin.add(raysMesh);

  // Substrate depth mask: 40x40 quad at the ball centre, slightly behind (z=-0.4),
  // camera-facing (wanderG has no rotation), depth-only, drawn first.
  const maskMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshBasicMaterial({ colorWrite: false }),
  );
  maskMesh.position.set(0, 0, -0.4);
  maskMesh.renderOrder = -1;
  wanderG.add(maskMesh);

  // ---- the 5 local tile faces (top mirror + 4 side walls), from draw_ball_1 ----
  const FACES = [
    { n: [0, 1, 0],  v: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]] },               // mirror top
    { n: [0, 0, -1], v: [[-1, 0, -1], [-1, -TILE_D, -1], [1, -TILE_D, -1], [1, 0, -1]] }, // wall -z
    { n: [0, 0, 1],  v: [[1, 0, 1], [1, -TILE_D, 1], [-1, -TILE_D, 1], [-1, 0, 1]] },     // wall +z
    { n: [1, 0, 0],  v: [[1, 0, -1], [1, -TILE_D, -1], [1, -TILE_D, 1], [1, 0, 1]] },     // wall +x
    { n: [-1, 0, 0], v: [[-1, 0, 1], [-1, -TILE_D, 1], [-1, -TILE_D, -1], [-1, 0, -1]] }, // wall -x
  ];

  // reusable scratch for the build (build runs once + on count change).
  const M = new THREE.Matrix4(), tmp = new THREE.Matrix4();
  const _wn = new THREE.Vector3();
  const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _g = new THREE.Vector3();
  const _c = new THREE.Color();

  // Emit one triangle, wound so its geometric normal agrees with the flat face normal n
  // (the .c's glFrontFace(GL_CW) intent; we render FrontSide so the far facets cull).
  function emitTri(a, b, c, n, pos, nor) {
    _e1.subVectors(b, a); _e2.subVectors(c, a); _g.crossVectors(_e1, _e2);
    let A = a, B = b, C = c;
    if (_g.dot(n) < 0) { B = c; C = b; }
    pos.push(A.x, A.y, A.z, B.x, B.y, B.z, C.x, C.y, C.z);
    for (let i = 0; i < 3; i++) nor.push(n.x, n.y, n.z);
  }

  // build_ball(): tessellate the dented sphere into tiles + pick the beams, then bake
  // both into the merged geometries. Re-runnable (count change / reinit).
  function buildBall() {
    let rows = config.count | 0;
    if (rows < 10) rows = 10;
    if (rows > 200) rows = 200;
    const tileSize = Math.PI / rows;

    // 0..4 dents.
    const dents = [];
    const dentCount = rng.random() % 5;   // countof(dents) == 5
    for (let i = 0; i < dentCount; i++) {
      const px = randsign() * (2 - bellrand(0.2));
      const py = randsign() * (2 - bellrand(0.2));
      const pz = randsign() * (2 - bellrand(0.2));
      const dist = Math.hypot(px, py, pz);
      let strength = dist - (1 - bellrand(0.3));
      strength = dist - (1 - bellrand(0.3));   // computed twice in the .c; preserved
      dents.push({ x: px, y: py, z: pz, strength });
    }

    const tilePos = [], tileNor = [];

    for (let th1 = Math.PI / 2; th1 > -(Math.PI / 2 + tileSize / 2); th1 -= tileSize) {
      const x = Math.cos(th1), y = Math.sin(th1);
      const x0 = Math.cos(th1 - tileSize / 2);
      const x1 = Math.cos(th1 + tileSize / 2);
      const circ0 = Math.PI * x0 * 2, circ1 = Math.PI * x1 * 2;
      const circ = circ0 < circ1 ? circ0 : circ1;
      let rowTiles = Math.floor((circ < 0 ? 0 : circ) / tileSize);
      const dropsy = 0.13 + frand(0.04);
      if (rowTiles <= 0) rowTiles = 1;
      const spacing = Math.PI * 2 / rowTiles;

      for (let th0 = 0; th0 < Math.PI * 2; th0 += spacing) {
        // position on the unit sphere; normal starts radial.
        let pX = Math.cos(th0) * x, pY = Math.sin(th0) * x, pZ = y;
        let nX = pX, nY = pY, nZ = pZ;
        let skip = false;

        for (let i = 0; i < dentCount; i++) {
          if (!(rng.random() % 150)) { skip = true; break; }   // 1/150 random drop
          const dx = pX - dents[i].x, dy = pY - dents[i].y, dz = pZ - dents[i].z;
          const dist = Math.hypot(dx, dy, dz);
          if (dist < dents[i].strength) {
            const s = 1 - (dents[i].strength - dist) * 0.66;
            const angle = vectorAngle(pX, pY, pZ, dents[i].x, dents[i].y, dents[i].z);
            if (angle < dropsy) { skip = true; break; }   // drop near the dent apex
            pX *= s; pY *= s; pZ *= s;
            // normalize(direction), then bend the normal away from the dent.
            let dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
            let ux = 0, uy = 0, uz = 0;
            if (dl >= 0.0000001) { ux = dx / dl; uy = dy / dl; uz = dz / dl; }
            const n2x = nX - ux, n2y = nY - uy, n2z = nZ - uz;
            nX = (nX + n2x) / 2; nY = (nY + n2y) / 2; nZ = (nZ + n2z) / 2;
          }
        }
        if (skip) continue;

        // skew the facing direction slightly + a random in-plane tilt.
        nX += 0.12 - frand(0.06);
        nY += 0.12 - frand(0.06);
        nZ += 0.12 - frand(0.06);
        const tilt = 4 - bellrand(8);

        // tile transform: T(pos) Rz(-atan2(nx,ny)) Rx(atan2(nz,r)) Ry(tilt) Scale(s),
        // mapping local +Y onto the (skewed) normal -- exactly draw_ball_1's stack.
        const s = (tileSize * 0.85) / 2;
        M.makeTranslation(pX, pY, pZ);
        M.multiply(tmp.makeRotationZ(-Math.atan2(nX, nY)));
        M.multiply(tmp.makeRotationX(Math.atan2(nZ, Math.hypot(nX, nY))));
        M.multiply(tmp.makeRotationY(tilt * DEG));
        M.multiply(tmp.makeScale(s, s, s));

        for (const f of FACES) {
          _wn.set(f.n[0], f.n[1], f.n[2]).transformDirection(M);   // flat world normal
          for (let k = 0; k < 4; k++) P[k].set(f.v[k][0], f.v[k][1], f.v[k][2]).applyMatrix4(M);
          emitTri(P[0], P[1], P[2], _wn, tilePos, tileNor);
          emitTri(P[0], P[2], P[3], _wn, tilePos, tileNor);
        }
      }
    }

    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(tilePos, 3));
    tg.setAttribute('normal', new THREE.Float32BufferAttribute(tileNor, 3));
    tileMesh.geometry.dispose();
    tileMesh.geometry = tg;

    // ---- the beams (rays) ----
    const nrays = (5 + bellrand(10)) | 0;   // 5..14
    const rPos = [], rUv = [], rCol = [];
    const QV = [[-0.5, 0, -1], [0.5, 0, -1], [0.5, 0, 1], [-0.5, 0, 1]];
    const QUV = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (let i = 0; i < nrays; i++) {
      const rth = frand(Math.PI * 2);
      let nx = Math.cos(rth), ny = Math.sin(rth), nz = 1;
      const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
      _c.setRGB(0.9 + frand(0.1), 0.6 + frand(0.4), 0.6 + frand(0.2), THREE.SRGBColorSpace);

      // orient(normal) Scale(5,5,10) T(0,0,1.1), as in draw_rays.
      M.makeRotationZ(-Math.atan2(nx, ny));
      M.multiply(tmp.makeRotationX(Math.atan2(nz, Math.hypot(nx, ny))));
      M.multiply(tmp.makeScale(5, 5, 10));
      M.multiply(tmp.makeTranslation(0, 0, 1.1));
      for (let k = 0; k < 4; k++) P[k].set(QV[k][0], QV[k][1], QV[k][2]).applyMatrix4(M);
      // two tris (DoubleSide -> winding irrelevant), with uv + ray colour per vertex.
      for (const [a, b, cc] of [[0, 1, 2], [0, 2, 3]]) {
        for (const k of [a, b, cc]) {
          rPos.push(P[k].x, P[k].y, P[k].z);
          rUv.push(QUV[k][0], QUV[k][1]);
          rCol.push(_c.r, _c.g, _c.b);
        }
      }
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(rPos, 3));
    rg.setAttribute('uv', new THREE.Float32BufferAttribute(rUv, 2));
    rg.setAttribute('color', new THREE.Float32BufferAttribute(rCol, 3));
    raysMesh.geometry.dispose();
    raysMesh.geometry = rg;
  }

  // Material randomization (init_ball, AFTER build_ball): grey AMBIENT_AND_DIFFUSE +
  // near-white specular, divided by PI so the glossy facets glint instead of blowing out.
  function setMaterial() {
    tileMat.color.setRGB(0.5 + frand(0.2), 0.5 + frand(0.2), 0.5 + frand(0.2), THREE.SRGBColorSpace);
    const sr = 1 - frand(0.2), sg = 1 - frand(0.2), sb = 1 - frand(0.2);
    tileMat.specular.setRGB(sr / Math.PI, sg / Math.PI, sb / Math.PI, THREE.SRGBColorSpace);
  }

  // ---- RNG-consuming init, in init_ball's order: th, rotator, build_ball, material ----
  let th = 180 - frand(360);   // bp->th
  // do_spin defaults False (spin speeds 0) but we build the rotator with 0.1 always:
  // make_rotator draws the same 12 RNG values regardless of the speed value, so the
  // build_ball stream stays aligned; config.spin gates the OUTPUT below.
  const rot = makeRotator(
    { spinX: 0.1, spinY: 0.1, spinZ: 0.1, spinAccel: 1, wanderSpeed: 0.003, randomize: false },
    rng,
  );
  buildBall();
  setMaterial();
  let lastCount = config.count | 0;

  // ---- rotator sampling + interpolation (dangerball.js pattern) ----
  const r0 = rot.getRotation(false), p0 = rot.getPosition(false);
  let prevR = { ...r0 }, curR = { ...r0 }, prevP = { ...p0 }, curP = { ...p0 }, rotAccum = 0;
  function tickRotator() {
    prevR = curR; curR = rot.getRotation(true);
    prevP = curP; curP = rot.getPosition(true);
  }
  function lerpAngle(a, b, t) { let d = b - a; if (d > 0.5) d -= 1; else if (d < -0.5) d += 1; return a + d * t; }
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---- sizing (reshape_ball: gluPerspective + the portrait fit scale) ----
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    portraitFitG.scale.setScalar(w < h ? w / h : 1);   // glScalef(s,s,s)
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop: continuous motion at effFps, rotator interpolated ----
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

    if ((config.count | 0) !== lastCount) { lastCount = config.count | 0; buildBall(); }

    // th spin: constant direction (sign fixed at init), wrap to (-360,360).
    th += (th > 0 ? config.speed : -config.speed) * frames;
    while (th > 360) th -= 360;
    while (th < -360) th += 360;
    thG.rotation.z = th * DEG;
    beamsSpin.rotation.z = -th * DEG;   // front rays counter-spin about the view axis

    // rotator: tick at the original cadence, interpolate between samples.
    rotAccum += frames;
    let ticks = 0;
    while (rotAccum >= 1 && ticks < MAX_TICKS) { tickRotator(); rotAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) rotAccum = 0;
    const a = rotAccum;

    if (config.spin) {
      spinG.rotation.set(
        lerpAngle(prevR.x, curR.x, a) * 2 * Math.PI,
        lerpAngle(prevR.y, curR.y, a) * 2 * Math.PI,
        lerpAngle(prevR.z, curR.z, a) * 2 * Math.PI,
        'XYZ',
      );
    } else spinG.rotation.set(0, 0, 0);

    if (config.wander) {
      wanderG.position.set(
        (lerp(prevP.x, curP.x, a) - 0.5) * 6,
        (lerp(prevP.y, curP.y, a) - 0.5) * 6,
        (lerp(prevP.z, curP.z, a) - 0.5) * 2,
      );
    } else wanderG.position.set(0, 0, 0);

    tileMat.wireframe = config.wire;
    raysMesh.visible = !config.wire;   // draw_rays is skipped in wireframe
    maskMesh.visible = !config.wire;   // let the wire ball show through

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      tileMesh.geometry.dispose();
      raysMesh.geometry.dispose();
      maskMesh.geometry.dispose();
      maskMesh.material.dispose();
      tileMat.dispose();
      rayMat.dispose();
      glowTex.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { th = 180 - frand(360); buildBall(); setMaterial(); lastCount = config.count | 0; },
    config,
    params,
  };
}

export default { title, info, start };
