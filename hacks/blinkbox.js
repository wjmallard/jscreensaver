// blinkbox.js -- "Blink Box" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's blinkbox (Jeremy English, 2003; motion blur added
// 2005 by John Boero), hacks/glx/blinkbox.c. A glossy ball bounces around inside a
// large invisible box. The six walls are tiled, and the tiles are normally invisible:
// when the ball strikes a wall, ONE tile lights up at the impact point in that wall's
// color (left=red, right=green, top=blue, bottom=orange, front=yellow, back=purple),
// then fades out over 20 frames. The ball is drawn with a motion-blur trail (24 ghost
// copies smeared along its velocity, additive). The whole box slowly tumbles.
//
// THE LOOK is a LIT + ADDITIVE hybrid drawn over black. The .c keeps GL_LIGHTING on
// (one positional white light, LIGHT1) so the ball and tiles are SHADED, but with
// fade/blur on (the defaults) it also enables GL_BLEND with glBlendFunc(GL_SRC_ALPHA,
// GL_ONE) and DISABLES depth test -- so every shaded fragment is multiplied by its
// alpha and ADDED to the framebuffer. We reproduce both: MeshLambert materials (LIT,
// no specular -- LIGHT1's specular defaults to black) with AdditiveBlending,
// depthTest/depthWrite off. CRUCIAL color-management note: GL has no color management,
// it blends/writes the raw lit values in display space. three defaults to a linear
// blend + sRGB output gamma, which would re-curve the additive sums. We opt this
// renderer out (outputColorSpace = Linear, colors authored RAW via THREE.Color(r,g,b))
// so the lit values accumulate and display exactly as GL writes them -- the white ball
// trail glows to white in its overlapping core, and the tile colors stay saturated.
// (The N.L lighting math itself is color-space-independent; only the output gamma is.)
//
// Self-contained three.js (own overlay canvas + renderer + loop), like cubestack.js /
// dangerball.js. RNG = yarandom.js (the bounce re-randomization). No assets.
//
// Faithful to the .c:
//   * bounding box bbox = {top:(14,14,20), bottom:(-14,-14,-20)}; ball starts at the
//     origin with motion mo=(1,1,1), hold moh=(-1,-1.5,-1.5), collision radius d=1.
//   * collision: hit_top_bottom (y), hit_front_back (z), hit_side (x) in that order;
//     a wall is struck when ball +/- d crosses it. On a hit: mark that side, store the
//     impact ball position, counter=MAX_COUNT(20), alpha_count=0, des_count=1, and
//     swap_mov() the axis -- swap mo<->moh for that axis then re-roll the new mo
//     magnitude to 1 or 2 (1 + random()%2) keeping its sign (the bounce).
//   * each lit tile: a unit cube (boxList) drawn rotated to lie flat on its wall
//     (glRotatef 90 about the wall's axis), translated to the impact point (the exact
//     per-side pos swizzle + CheckBoxPos clamp), scaled (boxsize,boxsize,0.25). With
//     do_fade (default) its alpha = 1 - 0.05*alpha_count, fading over 20 frames; with
//     do_dissolve (default off) the wh-scale also shrinks to 0 (wh - (wh/20)*des_count).
//   * the ball: unit_sphere(16,12) scaled x2. With do_blur (default) 24 ghosts stepped
//     mo/24 along the velocity, alpha_i = sin(PI*i/24)/24 (a half-sine envelope: dim at
//     the ends, brightest mid-trail); else a single ball.
//   * one white positional light LIGHT1 at (20,100,20) (no attenuation), global ambient
//     0.2; GL_COLOR_MATERIAL so glColor = the ambient+diffuse albedo (white ball; the
//     per-side tile colors).
//   * camera gluPerspective(30, w/h, 1, 100) + gluLookAt((0,0,40),(0,0,0),up(0,2,10));
//     the scene tumbles 0.25deg about each of z,y,x every frame (accumulating modelview
//     rotations) and is scaled by s = (w<h ? w/h : 1) * 0.5.
//
// PACING -- the .c advances the ball by `mo` and steps the tile fade counters once per
// frame: a DISCRETE per-frame sim. We tick it at effFps = 1e6/(delay+OVERHEAD),
// OVERHEAD = 37500us (xml default delay 30000 -> ~15fps; the geometry-track family
// default), and interpolate the ball position (lerp) and the tumble (slerp) between
// ticks so the render is smooth at any rAF rate.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';

export const title = 'blinkbox';

export const info = {
  author: 'Jeremy English',
  year: 2003,
  description:
    'A motion-blurred ball bounces inside a box whose tiles only become visible upon impact.',
};

export function start(hostCanvas, opts = {}) {
  const DEG = Math.PI / 180;
  const OVERHEAD = 37500;     // us; calibrates xml default delay 30000 -> ~15fps (track default)
  const MAX_COUNT = 20;       // tile lifetime in frames (the .c's MAX_COUNT)
  const ALPHA_AMT = 0.05;     // tile fade-out step per frame (1/MAX_COUNT)
  const BLUR_DETAIL = 24;     // ghost copies in the motion-blur trail
  const BALL_D = 1;           // ball collision radius (the .c's ball.d)
  const BOX_DEPTH = 0.25;     // tile slab half-depth (the .c's bscale.d)

  // bbox = {{14,14,20},{-14,-14,-20}} -- the invisible bounding box.
  const bbox = { top: { x: 14, y: 14, z: 20 }, bottom: { x: -14, y: -14, z: -20 } };

  // Knobs transcribed 1:1 from hacks/config/blinkbox.xml.
  const config = {
    delay: 30000,      // us (xml default; invert slider)
    boxsize: 2,        // tile width/height (xml --boxsize, 1..8)
    fade: true,        // tiles fade out after impact (do_fade)
    blur: true,        // motion-blur the ball (do_blur)
    dissolve: false,   // tiles also shrink as they fade (do_dissolve)
    wire: false,       // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'boxsize', label: 'Box size', type: 'range', min: 1, max: 8, step: 1, default: 2, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'fade', label: 'Fade', type: 'checkbox', default: true, live: true },
    { key: 'blur', label: 'Motion blur', type: 'checkbox', default: true, live: true },
    { key: 'dissolve', label: 'Dissolve', type: 'checkbox', default: false, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);

  // ===================================================================
  //  three.js scene -- LIT (one point light + ambient) but ADDITIVE
  // ===================================================================
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);
  // GL blends/writes the raw lit values in display space (no color management). For the
  // ADDITIVE sums here (ball ghosts, tile fades), opt this renderer out of three's
  // linear-blend + sRGB-output: feed RAW colors (THREE.Color(r,g,b) stores them as-is)
  // and skip the output gamma, so accumulation matches GL exactly (the lighting N.L math
  // is unaffected -- only the output curve is). Scoped + disposed on stop().
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // gluPerspective(30, w/h, 1, 100) + gluLookAt((0,0,40),(0,0,0), up(0,2,10)).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 40);
  camera.up.set(0, 2, 10);
  camera.lookAt(0, 0, 0);

  // LIGHT1: white, positional at (20,100,20,1), no attenuation. Specified under the view
  // matrix in init (fixed in eye space) while the box tumbles -> equivalently a
  // world-fixed light at (20,100,20) added to the scene (NOT the tumbling group). decay=0
  // = no falloff (GL default attenuation), intensity PI cancels three's 1/PI Lambert so
  // diffuse = albedo * N.L like GL. LIGHT1's specular defaults BLACK -> no highlight.
  const light = new THREE.PointLight(0xffffff, Math.PI, 0, 0);
  light.position.set(20, 100, 20);
  scene.add(light);
  // GL global ambient 0.2, with GL_COLOR_MATERIAL the material ambient = albedo, so the
  // ambient term is 0.2 * albedo; intensity 0.2*PI cancels the BRDF 1/PI.
  scene.add(new THREE.AmbientLight(0xffffff, 0.2 * Math.PI));

  // The box group: tumbles + scales; holds the ball ghosts and the six tiles.
  const boxGroup = new THREE.Group();
  scene.add(boxGroup);

  // ---- ball ghosts: unit_sphere(16,12) -> SphereGeometry(1, slices=12, stacks=16),
  // scaled x2. Low-poly on purpose (the GL original's visible banding). FrontSide gives
  // the shaded front hemisphere (the gradient you see in the screenshot). Additive,
  // depth off; each ghost a fixed half-sine alpha.
  const ballGeo = new THREE.SphereGeometry(1, 12, 16);
  const sinAlpha = [];               // alpha_i = sin(PI*i/BLUR_DETAIL)/BLUR_DETAIL
  const ghosts = [];
  for (let i = 0; i < BLUR_DETAIL; i++) {
    sinAlpha[i] = Math.sin((Math.PI / BLUR_DETAIL) * i) / BLUR_DETAIL;
    const m = new THREE.MeshLambertMaterial({
      color: new THREE.Color(1, 1, 1),   // raw white albedo (glColor 1,1,1)
      transparent: true,
      opacity: sinAlpha[i],
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(ballGeo, m);
    mesh.scale.setScalar(2);           // glScalef(2,2,2)
    mesh.frustumCulled = false;
    boxGroup.add(mesh);
    ghosts.push(mesh);
  }

  // ---- six wall tiles: unit cube (-1..1) = BoxGeometry(2,2,2). DoubleSide because the
  // .c does NOT cull (every face of the thin slab is drawn, both windings, additive).
  const tileGeo = new THREE.BoxGeometry(2, 2, 2);
  // Per side (draw-loop order lside,rside,tside,bside,fside,aside): raw color, the wall's
  // rotation axis (glRotatef 90 about it), the bpos swizzle from the stored impact pos,
  // and the CheckBoxPos clamp bounds [botX,topX,botY,topY] (the wall's in-plane axes).
  const B = bbox;
  const sideDefs = [
    { name: 'lside', color: [1, 0, 0],   axis: 'y',  // Red,    left  wall x-
      bpos: (p) => ({ x: -p.z, y: p.y, z: B.bottom.x - BOX_DEPTH }),
      clamp: [B.bottom.z, B.top.z, B.bottom.y, B.top.y] },
    { name: 'rside', color: [0, 1, 0],   axis: 'y',  // Green,  right wall x+
      bpos: (p) => ({ x: -p.z, y: p.y, z: B.top.x + BOX_DEPTH }),
      clamp: [B.bottom.z, B.top.z, B.bottom.y, B.top.y] },
    { name: 'tside', color: [0, 0, 1],   axis: 'x',  // Blue,   top   wall y+
      bpos: (p) => ({ x: p.x, y: p.z, z: B.bottom.y - BOX_DEPTH }),
      clamp: [B.bottom.x, B.top.x, B.bottom.z, B.top.z] },
    { name: 'bside', color: [1, 0.5, 0], axis: 'x',  // Orange, bottom wall y-
      bpos: (p) => ({ x: p.x, y: p.z, z: B.top.y + BOX_DEPTH }),
      clamp: [B.bottom.x, B.top.x, B.bottom.z, B.top.z] },
    { name: 'fside', color: [1, 1, 0],   axis: 'z',  // Yellow, front wall z+
      bpos: (p) => ({ x: p.y, y: -p.x, z: B.top.z + BOX_DEPTH }),
      clamp: [B.bottom.y, B.top.y, B.bottom.x, B.top.x] },
    { name: 'aside', color: [0.5, 0, 1], axis: 'z',  // Purple, back  wall z-
      bpos: (p) => ({ x: p.y, y: -p.x, z: B.bottom.z + BOX_DEPTH }),
      clamp: [B.bottom.y, B.top.y, B.bottom.x, B.top.x] },
  ];
  const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
  const sides = sideDefs.map((d) => {
    const mat = new THREE.MeshLambertMaterial({
      color: new THREE.Color(d.color[0], d.color[1], d.color[2]),   // raw glColor
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(tileGeo, mat);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.visible = false;
    boxGroup.add(mesh);
    const rot = new THREE.Matrix4().makeRotationAxis(AX[d.axis], Math.PI / 2);  // glRotatef(90, axis)
    return {
      def: d, mat, mesh, rot,
      hit: 0, counter: MAX_COUNT, des_count: 1, alpha_count: 0,
      pos: { x: 0, y: 0, z: 0 },
    };
  });
  // Side indices into `sides` (draw-loop order).
  const LSIDE = 0, RSIDE = 1, TSIDE = 2, BSIDE = 3, FSIDE = 4, ASIDE = 5;

  // ===================================================================
  //  simulation state (ticked at effFps; rendered with interpolation)
  // ===================================================================
  const ball = { x: 0, y: 0, z: 0 };                 // calloc'd to origin in the .c
  const mo = { x: 1, y: 1, z: 1 };                   // motion
  const moh = { x: -1, y: -1.5, z: -1.5 };           // hold motion
  let ballPrev = { x: 0, y: 0, z: 0 };
  let ballCur = { x: 0, y: 0, z: 0 };

  const tumblePrev = new THREE.Quaternion();
  const tumbleCur = new THREE.Quaternion();
  // step = Rz(.25) * Ry(.25) * Rx(.25), post-multiplied onto the modelview each frame.
  const d025 = 0.25 * DEG;
  const stepQ = new THREE.Quaternion().setFromAxisAngle(AX.z, d025)
    .multiply(new THREE.Quaternion().setFromAxisAngle(AX.y, d025))
    .multiply(new THREE.Quaternion().setFromAxisAngle(AX.x, d025));

  function hitSide(s) {
    s.hit = 1;
    s.counter = MAX_COUNT;
    s.des_count = 1;
    s.alpha_count = 0;
    s.pos = { x: ball.x, y: ball.y, z: ball.z };      // cp_b_pos: impact = current ball
  }
  // swap_mov: swap mo<->moh on this axis, then re-roll new mo magnitude to 1 or 2,
  // keeping its (post-swap) sign. get_rand() = 1 + random()%2.
  function swapMov(ax) {
    const t = mo[ax]; mo[ax] = moh[ax]; moh[ax] = t;
    const j = 1 + (rng.random() % 2);
    mo[ax] = (mo[ax] < 0) ? -j : j;
  }
  function collide() {
    // hit_top_bottom (y)
    if (ball.y - BALL_D <= B.bottom.y) { hitSide(sides[BSIDE]); swapMov('y'); }
    else if (ball.y + BALL_D >= B.top.y) { hitSide(sides[TSIDE]); swapMov('y'); }
    // hit_front_back (z)
    if (ball.z - BALL_D <= B.bottom.z) { hitSide(sides[ASIDE]); swapMov('z'); }
    else if (ball.z + BALL_D >= B.top.z) { hitSide(sides[FSIDE]); swapMov('z'); }
    // hit_side (x)
    if (ball.x - BALL_D <= B.bottom.x) { hitSide(sides[LSIDE]); swapMov('x'); }
    else if (ball.x + BALL_D >= B.top.x) { hitSide(sides[RSIDE]); swapMov('x'); }
  }
  // The fade/dissolve counters step once per frame (in the .c's draw loop, just AFTER a
  // tile is drawn). We run this at the START of a tick so a freshly-hit tile renders one
  // full-bright frame (alpha_count 0) before it begins to dim -- matching the .c order
  // draw(alpha_count) then alpha_count++.
  function stepTiles() {
    for (const s of sides) {
      if (!s.hit) continue;
      s.counter--;
      s.des_count++;
      s.alpha_count++;
      if (s.counter <= 0) s.hit = 0;
    }
  }
  function tick() {
    stepTiles();
    collide();
    ballPrev = { x: ball.x, y: ball.y, z: ball.z };
    ball.x += mo.x; ball.y += mo.y; ball.z += mo.z;
    ballCur = { x: ball.x, y: ball.y, z: ball.z };
    tumblePrev.copy(tumbleCur);
    tumbleCur.multiply(stepQ);     // modelview *= step (local/post-multiply)
  }

  function initSim() {
    ball.x = 0; ball.y = 0; ball.z = 0;
    mo.x = 1; mo.y = 1; mo.z = 1;
    moh.x = -1; moh.y = -1.5; moh.z = -1.5;
    ballPrev = { x: 0, y: 0, z: 0 };
    ballCur = { x: 0, y: 0, z: 0 };
    tumblePrev.identity();
    tumbleCur.identity();
    for (const s of sides) { s.hit = 0; s.counter = MAX_COUNT; s.des_count = 1; s.alpha_count = 0; s.pos = { x: 0, y: 0, z: 0 }; }
  }

  // ===================================================================
  //  per-frame build (interpolated render)
  // ===================================================================
  let portraitScale = 0.5;
  const _tmpT = new THREE.Matrix4();
  const _tmpS = new THREE.Matrix4();
  const lerp = (a, b, t) => a + (b - a) * t;

  function clampBox() {
    let wh = config.boxsize;
    if (wh < 1) wh = 1;
    if (wh > 8) wh = 8;
    return wh;
  }

  function buildFrame(f) {
    // box group transform: tumble (slerp prev->cur) + the s = portrait * 0.5 scale.
    boxGroup.quaternion.copy(tumblePrev).slerp(tumbleCur, f);
    boxGroup.scale.setScalar(portraitScale);

    const wire = config.wire;
    const wh = clampBox();
    const desAmt = config.dissolve ? wh / MAX_COUNT : 1;

    // --- ball trail: base = lerp(prev,cur,f); ghost i at base + (i+1)/24 * moTrail.
    const bx = lerp(ballPrev.x, ballCur.x, f);
    const by = lerp(ballPrev.y, ballCur.y, f);
    const bz = lerp(ballPrev.z, ballCur.z, f);
    const mtx = ballCur.x - ballPrev.x, mty = ballCur.y - ballPrev.y, mtz = ballCur.z - ballPrev.z;
    if (config.blur && !wire) {
      for (let i = 0; i < BLUR_DETAIL; i++) {
        const k = (i + 1) / BLUR_DETAIL;
        const g = ghosts[i];
        g.visible = true;
        g.position.set(bx + mtx * k, by + mty * k, bz + mtz * k);
        g.material.opacity = sinAlpha[i];
        g.material.wireframe = wire;
      }
    } else {
      // single ball (no blur): show ghost 0 at the ball position, fully opaque.
      ghosts[0].visible = true;
      ghosts[0].position.set(bx, by, bz);
      ghosts[0].material.opacity = 1;
      ghosts[0].material.wireframe = wire;
      for (let i = 1; i < BLUR_DETAIL; i++) ghosts[i].visible = false;
    }

    // --- tiles: rotate to the wall, translate to the (clamped) impact point, scale.
    for (const s of sides) {
      if (!s.hit) { s.mesh.visible = false; continue; }
      const p = s.def.bpos(s.pos);
      // CheckBoxPos: clamp the two in-plane axes (x,y of bpos) to keep the tile on-wall.
      const [bx0, tx0, by0, ty0] = s.def.clamp;
      if (p.x - wh < bx0) p.x = bx0 + wh;
      if (p.x + wh > tx0) p.x = tx0 - wh;
      if (p.y - wh < by0) p.y = by0 + wh;
      if (p.y + wh > ty0) p.y = ty0 - wh;

      let sx = wh;
      if (config.dissolve) { sx = wh - desAmt * s.des_count; if (sx < 0) sx = 0; }
      _tmpT.makeTranslation(p.x, p.y, p.z);
      _tmpS.makeScale(sx, sx, BOX_DEPTH);
      s.mesh.matrix.multiplyMatrices(s.rot, _tmpT).multiply(_tmpS);
      s.mesh.matrixWorldNeedsUpdate = true;
      s.mesh.visible = true;
      s.mat.opacity = config.fade ? (1 - ALPHA_AMT * s.alpha_count) : 1;
      s.mat.wireframe = wire;
    }
  }

  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    portraitScale = (w < h ? w / h : 1) * 0.5;        // s = (w<h ? w/h : 1) * 0.5
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  initSim();

  // ---- render loop ----
  const MAX_TICKS = 8;
  let raf = 0, last = 0, paused = false, ms = 16, accum = 0;
  function tickLoop(now) {
    raf = requestAnimationFrame(tickLoop);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    accum += dt * effFps;
    let n = 0;
    while (accum >= 1 && n < MAX_TICKS) { tick(); accum -= 1; n++; }
    if (n === MAX_TICKS) accum = 0;

    buildFrame(accum);     // fractional position within the current tick (0..1)
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tickLoop);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      ballGeo.dispose();
      tileGeo.dispose();
      ghosts.forEach((g) => g.material.dispose());
      sides.forEach((s) => s.mat.dispose());
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { initSim(); accum = 0; },
    config,
    params,
  };
}

export default { title, info, start };
