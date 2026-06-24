// blocktube.js -- "Block Tube" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's blocktube (Lars R. Damerow, 2003),
// hacks/glx/blocktube.c. The camera sits on the axis of an endless tunnel whose
// walls are made of ~1000 long thin reflective slabs. The slabs fall toward the
// camera, each spinning slowly around the tube at its own rate ("swirling"), and
// the whole thing slowly fades from one hue to the next. Distance fades to black
// through linear fog, so the tunnel recedes to a dark hole in the middle.
//
// Self-contained on purpose (own overlay canvas + renderer + render loop), like
// glknots.js / dangerball.js -- it only follows the host's mountable-module
// contract (start(canvas) -> a handle with stop/pause/resume/getStats/reinit).
//
// Faithful to the .c:
//   * 1000 entities (MAX_ENTITIES). randomize_entity(): tVal = 1-frand()/1.5
//     (per-slab brightness in (1/3, 1]); angle = random()%360 (deg around the
//     tube); angularVelocity = 0.5-frand() ((-1/2,1/2] deg/tick); position =
//     ( frand()+tunnelWidth (radius 5..6), frand()*2 (0..2 lift), -frand()*
//     tunnelLength (depth -200..0) ). id/age/lifetime are vestigial (age is int,
//     age+=0.1 truncates to 0 -> no lifetime logic; the tunnel's gaps/"holes" are
//     purely the random layout, not a code path). Only posZ is reset on recycle;
//     tVal/angle/angularVelocity persist for the life of the run.
//   * entityTick(): angle += angularVelocity; posZ += 0.1 (forward); if posZ >
//     zoom (30) recycle to the far end posZ = -tunnelLength + frand()*20
//     (-200..-180).
//   * per-slab modelview (draw_blocktube): Identity, Translate(0,0,zoom=30),
//     Rotate(tilt=4.5deg, X), Rotate(angle, Z), Translate(position). The camera is
//     at the eye origin looking down -Z (no gluLookAt). reshape's glScalef is dead
//     code -- draw_blocktube glLoadIdentity()s it away every frame -- so it is not
//     reproduced. gluPerspective(45, w/h, 1, 100).
//   * the block: cube_vertices(0.15, 1.2, 5.25) -> a slab 0.15 thick (radial),
//     1.2 wide (tangential), 5.25 long (along the tunnel axis).
//   * color cycle (tick()/newTargetColor()): hold the current color for `holdtime`
//     ticks, then over `changetime` ticks step currentColor += (target-current)/
//     changetime toward a fresh random target (rerolled until luminance
//     0.3R+0.59G+0.11B > 150, so hues stay bright), then hold, repeat. Per slab the
//     drawn color is glColor4ub(currentR*tVal, currentG*tVal, currentB*tVal).
//   * fog: GL_LINEAR black fog, start 0, end tunnelLength/1.8 = 111.11 (off in
//     wireframe). depth test + back-face cull on.
//
// TEXTURE / GL_MODULATE (do_texture defaults True; lighting is OFF when textured):
//   blocktube.png is a 256x256 grayscale swirl, uploaded LINEAR/no-mipmap and used
//   as a GL_SPHERE_MAP environment map (glTexGen S/T = SPHERE_MAP) under GL_MODULATE
//   -- i.e. each slab reflects the swirl according to its orientation, tinted by the
//   flat glColor. three's MeshMatcapMaterial is exactly a view-space sphere/normal
//   map, and its shader computes outgoingLight = diffuse * vColor * matcap, then fog
//   -- which is GL_MODULATE(glColor4ub, sphereMapTexture) with:
//     material.color = currentColor/255   (the cycling tint, per frame)
//     instanceColor  = (tVal,tVal,tVal)   (per-slab brightness, set once)
//     matcap         = the swirl texture
//   (InstancedMesh.setColorAt forces USE_COLOR in the fragment prefix, so the
//   per-instance tVal multiplies without material.vertexColors -- which must stay
//   off, else the shader references a missing per-vertex `color` attribute.)
//   matcap's normal-based uv differs slightly from GL_SPHERE_MAP's reflection-vector
//   uv, but for a soft radial swirl the reflective look is indistinguishable; see
//   blocktube.md.
//
// Non-default modes (faithful, secondary):
//   * Wireframe: the .c forces texture+fog off and draws colored line loops ->
//     MeshBasicMaterial({wireframe}) tinted by currentColor*tVal, no fog. (three's
//     wireframe shows triangulated edges/all 6 faces; the .c draws 4 quad outlines.)
//   * Textured OFF, not wire: the .c enables lighting but NOT GL_COLOR_MATERIAL, so
//     glColor is ignored and every block is the default-material gray (the author's
//     own "I don't understand why all the blocks come out gray" comment) -> a lit
//     gray MeshPhongMaterial, no per-slab tint, no visible color cycle. Faithful.
//
// PACING: render every rAF; effFps = 1e6/(delay+OVERHEAD). Slab motion (posZ, angle)
// is continuous (advance by frames = dt*effFps) for smoothness; the discrete color
// counter is ticked at effFps with a catch-up cap. RNG is the shared yarandom port.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding), and the screenshots capture those
// raw values. Disable three's color management so the port matches GL exactly.
THREE.ColorManagement.enabled = false;

export const title = 'blocktube';

export const info = {
  author: 'Lars R. Damerow',
  year: 2003,
  description:
    'A swirling, falling tunnel of reflective slabs. They fade from hue to hue.',
};

export function start(hostCanvas, opts = {}) {
  // ---- constants (blocktube.c #defines / init_blocktube) ----
  const MAX_ENTITIES = 1000;
  const ZOOM = 30;                 // lp->zoom (camera pushes the tube +30 in Z)
  const TILT = 4.5;                // lp->tilt (deg about X)
  const TUNNEL_LENGTH = 200;       // lp->tunnelLength
  const TUNNEL_WIDTH = 5;          // lp->tunnelWidth (tube radius base)
  const FOG_END = TUNNEL_LENGTH / 1.8;   // 111.11 (GL_FOG_END)
  const BLOCK = { x: 0.15, y: 1.2, z: 5.25 };   // cube_vertices(0.15, 1.2, 5.25)
  const MAX_TICKS = 8;             // color catch-up cap (avoids a burst after a stall)
  const DEG2RAD = Math.PI / 180;
  // us; the GL family's shared overhead default. Live GL hacks can't be timed under
  // this machine's XQuartz Apple-DRI block, so every three.js port adopts the same
  // measured 37500 (gears/pipes/dangerball/glknots/...). xml delay 40000 ->
  // effFps = 1e6/77500 ~= 12.9fps. See framerate-calibration.
  const OVERHEAD = 37500;

  // Knobs transcribed 1:1 from hacks/blocktube.xml (the host renders the box from
  // `params` and mutates `config` in place). Fog has no xml knob (always on except
  // wireframe) and showFPS is the host's own readout -- neither is exposed here.
  const config = {
    delay: 40000,          // us (xml default; invert slider)
    holdtime: 1000,        // ticks to hold a color (xml --holdtime)
    changetime: 200,       // ticks to fade to a new color (xml --changetime)
    texture: true,         // do_texture (xml "Textured", default True)
    wire: false,           // wireframe (xml "Wireframe")
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 40000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'holdtime', label: 'Color hold time', type: 'range', min: 10, max: 2000, step: 10, default: 1000, lowLabel: 'Short', highLabel: 'Long', live: true },
    { key: 'changetime', label: 'Color change time', type: 'range', min: 10, max: 1000, step: 10, default: 200, lowLabel: 'Short', highLabel: 'Long', live: true },
    { key: 'texture', label: 'Textured', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);

  // ===================================================================
  //  entities (the falling slabs)
  // ===================================================================
  const entities = new Array(MAX_ENTITIES);

  // randomize_entity(): full re-roll. Called once per slab at init. tVal, angle and
  // angularVelocity then persist -- entityTick's recycle only resets posZ.
  function randomizeEntity(e) {
    e.tVal = 1 - rng.frand() / 1.5;                 // (1/3, 1]
    e.angle = rng.random() % 360;                   // deg
    e.angularVelocity = 0.5 - rng.frand();          // (-1/2, 1/2]
    e.posX = rng.frand() + TUNNEL_WIDTH;            // [5, 6)
    e.posY = rng.frand() * 2;                       // [0, 2)
    e.posZ = -rng.frand() * TUNNEL_LENGTH;          // (-200, 0]
  }

  function initEntities() {
    for (let i = 0; i < MAX_ENTITIES; i++) {
      entities[i] = entities[i] || {};
      randomizeEntity(entities[i]);
    }
  }

  // ===================================================================
  //  color cycle (newTargetColor / tick)
  // ===================================================================
  let curR = 0, curG = 0, curB = 0;
  let tgtR = 0, tgtG = 0, tgtB = 0;
  let dR = 0, dG = 0, dB = 0;
  let counter = 0;
  let changing = false;

  // newTargetColor(): pick a fresh target (rerolled until it's bright enough) and
  // the per-tick deltas that carry currentColor to it over `changetime` ticks.
  function newTargetColor() {
    let luminance = 0;
    const ct = config.changetime;
    while (luminance <= 150) {
      tgtR = rng.random() % 256;
      tgtG = rng.random() % 256;
      tgtB = rng.random() % 256;
      dR = (tgtR - curR) / ct;
      dG = (tgtG - curG) / ct;
      dB = (tgtB - curB) / ct;
      luminance = 0.3 * tgtR + 0.59 * tgtG + 0.11 * tgtB;
    }
  }

  // tick(): the C's discrete color state machine, one call per tick.
  function colorTick() {
    counter--;
    if (counter === 0) {
      if (!changing) { newTargetColor(); counter = config.changetime; }
      else { counter = config.holdtime; }
      changing = !changing;
    } else if (changing) {
      curR += dR; curG += dG; curB += dB;
    }
  }

  function initColor() {
    curR = rng.random() % 256;      // unconstrained initial current color
    curG = rng.random() % 256;
    curB = rng.random() % 256;
    newTargetColor();               // first target (re-picked before it's ever used,
    counter = config.holdtime;      // exactly as the .c -- the initial hold is on the
    changing = false;               // random current color)
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
  renderer.setClearColor(0x000000, 1);      // glClearColor default black; glClear each frame

  const scene = new THREE.Scene();
  // GL_LINEAR black fog, start 0, end tunnelLength/1.8. three's Fog(near,far) is
  // linear in view-space depth -- start=0 -> near=0, end -> far. Active materials
  // set .fog = !wireframe (the .c disables fog in wireframe mode).
  scene.fog = new THREE.Fog(0x000000, 0, FOG_END);

  // gluPerspective(45, w/h, 1, 100) + eye at origin looking down -Z (three default).
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 100);
  camera.position.set(0, 0, 0);

  // Lights (only MeshPhongMaterial reads them; matcap/basic ignore them). GL LIGHT0:
  // directional from (0,1,1), diffuse white, ambient 0.2. Intensity PI cancels
  // three's 1/PI Lambert. Used only in the non-textured "gray" mode.
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(0, 1, 1);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.2 * Math.PI));

  // ---- swirl texture (blocktube.png), as a sphere-map / matcap ----
  // LINEAR min/mag, no mipmaps (the .c). Sphere-map s,t stay in [0,1] so wrapping
  // never happens -> ClampToEdge. Sampled raw (NoColorSpace) to match GL_MODULATE's
  // untouched luminance bytes (color management is disabled).
  const swirlTex = new THREE.TextureLoader().load(
    new URL('./images/blocktube.png', import.meta.url).href,
  );
  swirlTex.minFilter = THREE.LinearFilter;
  swirlTex.magFilter = THREE.LinearFilter;
  swirlTex.generateMipmaps = false;
  swirlTex.wrapS = THREE.ClampToEdgeWrapping;
  swirlTex.wrapT = THREE.ClampToEdgeWrapping;
  swirlTex.colorSpace = THREE.NoColorSpace;

  // ---- block geometry + instanced mesh ----
  const geom = new THREE.BoxGeometry(BLOCK.x, BLOCK.y, BLOCK.z);
  let material = null, mesh = null, isPhong = false;
  let builtTexture = null, builtWire = null;

  const grayColor = new THREE.Color();
  const whiteColor = new THREE.Color(1, 1, 1);
  function setInstanceColors(useTVal) {
    for (let i = 0; i < MAX_ENTITIES; i++) {
      if (useTVal) {
        const t = entities[i].tVal;
        grayColor.setRGB(t, t, t, THREE.SRGBColorSpace);
        mesh.setColorAt(i, grayColor);
      } else {
        mesh.setColorAt(i, whiteColor);   // gray mode: no per-slab tint
      }
    }
    mesh.instanceColor.needsUpdate = true;
  }

  // Build the material for the current texture/wire config. Textured (default) =
  // matcap; wireframe = colored basic wire (no fog); non-textured = lit gray phong.
  function rebuildMaterial() {
    const wire = config.wire;
    const textured = config.texture && !wire;
    if (material) material.dispose();
    if (wire) {
      material = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true });
      material.fog = false;
      isPhong = false;
    } else if (textured) {
      material = new THREE.MeshMatcapMaterial({ matcap: swirlTex, color: 0xffffff });
      material.fog = true;
      isPhong = false;
    } else {
      // GL default material under lighting, no GL_COLOR_MATERIAL: uniform gray.
      material = new THREE.MeshPhongMaterial({ color: 0xcccccc, specular: 0x000000, shininess: 0 });
      material.fog = true;
      isPhong = true;
    }
    if (mesh) {
      mesh.material = material;
      setInstanceColors(!isPhong);
    }
    builtTexture = config.texture;
    builtWire = config.wire;
  }
  rebuildMaterial();

  mesh = new THREE.InstancedMesh(geom, material, MAX_ENTITIES);
  mesh.frustumCulled = false;     // instances span the whole tube; never cull the batch
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);

  // init AFTER the mesh exists (setInstanceColors needs mesh)
  initEntities();
  initColor();
  setInstanceColors(!isPhong);

  // ---- per-slab modelview: base = Translate(0,0,zoom) * Rotate(tilt, X) ----
  const baseMat = new THREE.Matrix4().makeTranslation(0, 0, ZOOM);
  baseMat.multiply(new THREE.Matrix4().makeRotationX(TILT * DEG2RAD));
  const mRot = new THREE.Matrix4();
  const mTrans = new THREE.Matrix4();
  const mInst = new THREE.Matrix4();

  // ---- sizing (reshape_blocktube: gluPerspective; the glScalef is dead code) ----
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop ----
  let raf = 0, last = 0, paused = false, ms = 16;
  let colorAccum = 0;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    // live texture/wireframe toggle
    if (config.texture !== builtTexture || config.wire !== builtWire) rebuildMaterial();

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;

    // advance slabs (continuous): forward fall + per-slab spin, recycle past camera
    const dz = 0.1 * frames;
    for (let i = 0; i < MAX_ENTITIES; i++) {
      const e = entities[i];
      e.angle += e.angularVelocity * frames;
      e.posZ += dz;
      if (e.posZ > ZOOM) e.posZ = -TUNNEL_LENGTH + rng.frand() * 20;   // (-200, -180]
    }

    // color cycle: discrete counter ticked at effFps (catch-up capped)
    colorAccum += frames;
    let ticks = 0;
    while (colorAccum >= 1 && ticks < MAX_TICKS) { colorTick(); colorAccum -= 1; ticks++; }
    if (ticks === MAX_TICKS) colorAccum = 0;

    // write instance matrices: base * Rz(angle) * T(position)
    for (let i = 0; i < MAX_ENTITIES; i++) {
      const e = entities[i];
      mRot.makeRotationZ(e.angle * DEG2RAD);
      mTrans.makeTranslation(e.posX, e.posY, e.posZ);
      mInst.multiplyMatrices(baseMat, mRot).multiply(mTrans);
      mesh.setMatrixAt(i, mInst);
    }
    mesh.instanceMatrix.needsUpdate = true;

    // global cycling tint (textured + wireframe modes only; phong stays gray)
    if (!isPhong) material.color.setRGB(curR / 255, curG / 255, curB / 255, THREE.SRGBColorSpace);

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      geom.dispose();
      material.dispose();
      swirlTex.dispose();
      mesh.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() {                       // host 're-seed': fresh layout + fresh color
      initEntities();
      initColor();
      setInstanceColors(!isPhong);
    },
    config,
    params,
  };
}

export default { title, info, start };
