// boxed.js -- "Boxed" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's boxed (Sander van Grieken, 2002),
// hacks/glx/boxed.c (+ the embedded floor texture hacks/glx/boxed.h). A box full
// of 3D bouncing balls that fall under gravity, bounce on a green textured floor
// and off four wireframe walls, collide with each other, and -- when one drifts up
// and over a wall ("offside") and then lands -- EXPLODE into hundreds of little
// triangle shards that scatter, bounce, flash white and vanish, after which a fresh
// ball drops in. A slow camera orbits the whole scene.
//
// Self-contained on purpose (own overlay canvas + renderer + render loop), like
// glknots.js / dangerball.js -- it only follows the host's mountable-module
// contract (start(canvas) -> a handle with stop/pause/resume/getStats/reinit).
//
// Faithful to the .c (the PHYSICS is transcribed verbatim, not tuned):
//   * BALLS -- createball(): loc = (5-10r, 35+20r, 5-10r), dir = ((.5-r)*speed, 0,
//     (.5-r)*speed), radius = ballsize; color rolled until r+g+b >= 1.8 (bright).
//     updateballs() per tick: dir.y -= 0.30*speed (gravity); loc += dir; floor is
//     y=0, ball bounces when loc.y < radius (reflect + dir.y negate); walls at
//     +/-20 in x,z reflect the ball UNLESS it is above the wall top (y > 41+radius),
//     in which case it goes "offside" (escapes, no more wall collisions). An offside
//     ball that lands sets bounced=TRUE (it explodes) and its dir is damped *0.80
//     each floor hit until it is slow enough to respawn (createball). O(n^2)
//     ball-ball collision exchanges velocity along the centre line then pushes the
//     pair apart, exactly as the .c (squaredist = rb^2 + rj^2, a loose test).
//   * EXPLOSION -- createtrisfromball(): the ball's 400-triangle sphere becomes 400
//     shards. Per shard: centroid c = (v0+v1+v2)/3; the shard's 3 verts are recentred
//     on c and scaled by 2*radius; its start loc = ball.loc + c; its velocity =
//     c*explosion + jitter + ball horizontal momentum, where explosion = 1 +
//     (floor(cfg.explosion)/15)*2*r and momentum = cfg.momentum. Shard normal = c
//     (flat, unnormalized in the .c -- three normalizes it). updatetris() per tick:
//     dir.y -= 0.1*speed (weaker gravity); loc += dir; bounce on floor (*0.80 damp)
//     while inside +/-95, else "far" (freefall out of frame); shards inside the box
//     footprint (+/-21) are pushed back OUT against the nearest wall. Each tick, with
//     probability `decay`, a live shard starts vanishing: it is drawn WHITE for 3
//     ticks (diffuse white, emission 0.8) then removed. cfg.decay is remapped as the
//     .c's pinit does: d<=0.8182 ? d/3 : (d-0.75)*4.
//   * LOOK -- ball material: diffuse = color/radius (boxed leaves GL_NORMALIZE OFF, so its
//     glScalef(radius) shrinks the normals and attenuates diffuse by 1/radius -- balls are
//     emission-dominated), emission = 0.5*color, specular black, ambient black, shininess 5
//     (so no highlight; the dark side glows at 0.5*color, the lit side reaches ~1.0*color).
//     Shard material: diffuse = color, emission = 0.3*color (white flash = diffuse 1,
//     emission 0.8). Two lights: a white POINT light at the box floor centre (0,0,0)
//     and a half-grey DIRECTIONAL light from above (0,1,0). No ambient term at all.
//     (Light intensity = PI to cancel three's 1/PI Lambert; specular is black so it
//     never blows out.) Floor plate + walls + ground grid are drawn UNLIT with raw
//     glColor: green radial-gradient floor texture (MODULATE with white), (0.2,0.5,
//     0.2) wireframe walls, (0.1,0.1,0.6) blue ground grid tessellation (5x5 tiles).
//   * CAMERA -- draw()'s orbit: r = 150 + 115*cos, eye = (r*sin, 80*sin+81.6, r*cos),
//     centre = (30*sin, (80*sin+81.6)/10, 30*sin). Yes: the .c passes v2.x for BOTH
//     the x AND z of the lookat centre (v2.z is computed but never used) -- that
//     quirk is replicated. gluPerspective(50, w/h, 2, 1000) + the reshape portrait
//     squish (glScalef s = w<h ? w/h : 1, premultiplied onto the projection).
//
// FLOOR TEXTURE (deliberate, documented in boxed.md): the .c bakes a 256x256 green
// noise texture into boxed.h (a 262 KB GIMP HEADER_PIXEL blob). Rather than inline
// that blob, we regenerate its VISUAL procedurally: the decoded texture is a clean
// linear radial green gradient (G ~= 251 - 0.9*r from a bright ~250 centre to ~90 at
// the corners) plus fine grain and a faint warm tint (mean RGB 14.6/162.9/2.1) --
// all measured off the real blob, not chosen by eye. A deterministic hash supplies
// the grain so the port's yarandom stream stays aligned with the .c's.
//
// PACING: render every rAF; effFps = 1e6/(delay+OVERHEAD). The camera orbit advances
// continuously (smooth); the discrete ball/shard physics ticks at effFps with a
// catch-up accumulator; ball positions are interpolated between ticks for smoothness
// (a teleport guard snaps on respawn/collision jumps). Shards render at tick cadence.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding). Disable three's color management so
// the port matches GL: colors are used raw and the output is not sRGB-encoded.
THREE.ColorManagement.enabled = false;

export const title = 'boxed';

export const info = {
  author: 'Sander van Grieken',
  year: 2002,
  description:
    'A box full of 3D bouncing balls that explode.',
};

export function start(hostCanvas, opts = {}) {
  // ---- constants (boxed.c #defines) ----
  const CAM_HEIGHT = 80.0;
  const CAMDISTANCE_MIN = 35.0;
  const CAMDISTANCE_MAX = 150.0;
  const CAMDISTANCE_SPEED = 1.5;
  const LOOKAT_R = 30.0;
  const MESH_SIZE = 10;
  const SPHERE_VERTICES = 2 + MESH_SIZE * MESH_SIZE * 2;                  // 202
  const SPHERE_INDICES = (MESH_SIZE * 4 + MESH_SIZE * 4 * (MESH_SIZE - 1)) * 3; // 1200
  const NUM_TRI = SPHERE_INDICES / 3;                                    // 400
  const CAMSPEED = 35.0;          // boxed_config.camspeed (hardcoded in setdefaultconfig)
  const MAX_TICKS = 8;            // physics catch-up cap (avoid a spiral after a stall)
  // us; the GL family's shared overhead default. Live GL hacks can't be timed under
  // this machine's XQuartz Apple-DRI block, so every three.js port adopts the same
  // measured 37500. xml delay 15000 -> effFps = 1e6/52500 ~= 19fps. framerate-calibration.
  const OVERHEAD = 37500;

  // Knobs transcribed 1:1 from hacks/boxed.xml (the host renders the box from
  // `params` and mutates `config` in place). `delay` is the frame-rate knob.
  const config = {
    delay: 15000,      // us (xml default; invert slider)
    speed: 0.5,        // overall speed factor (xml --speed)
    balls: 20,         // number of balls (xml --balls)
    ballsize: 3.0,     // ball radius (xml --ballsize)
    explosion: 15.0,   // explosion force (xml --explosion)
    decay: 0.07,       // explosion decay (xml --decay)
    momentum: 0.6,     // explosion momentum (xml --momentum)
    wire: false,       // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 15000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.001, max: 4.0, step: 0.001, default: 0.5, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    { key: 'balls', label: 'Number of balls', type: 'range', min: 3, max: 40, step: 1, default: 20, lowLabel: 'Few', highLabel: 'Lots', live: true },
    { key: 'ballsize', label: 'Ball size', type: 'range', min: 1.0, max: 5.0, step: 0.1, default: 3.0, lowLabel: 'Tiny', highLabel: 'Huge', live: true },
    { key: 'explosion', label: 'Explosion force', type: 'range', min: 1.0, max: 50.0, step: 0.5, default: 15.0, lowLabel: 'Popcorn', highLabel: 'Nuke', live: true },
    { key: 'decay', label: 'Explosion decay', type: 'range', min: 0.0, max: 1.0, step: 0.01, default: 0.07, lowLabel: 'Linger', highLabel: 'Pop!', live: true },
    { key: 'momentum', label: 'Explosion momentum', type: 'range', min: 0.0, max: 1.0, step: 0.01, default: 0.6, lowLabel: 'None', highLabel: 'Full', live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);
  const rnd = () => rng.frand(1);          // boxed.c: #define rnd() (frand(1.0))

  // clamps from setdefaultconfig() + the decay remap from pinit()
  const clampBalls = () => Math.max(3, Math.min(40, Math.round(config.balls)));
  const clampBallsize = () => Math.max(1.0, Math.min(5.0, config.ballsize));
  const clampExplosion = () => Math.max(0.0, Math.min(50.0, config.explosion));
  const clampDecay = () => Math.max(0.02, Math.min(0.90, config.decay));
  const clampMomentum = () => Math.max(0.0, Math.min(1.0, config.momentum));
  const remapDecay = (d) => (d <= 0.8182 ? d / 3 : (d - 0.75) * 4);

  // ===================================================================
  //  sphere data (generatesphere) -- shared by the balls and the shards
  // ===================================================================
  const spherev = new Array(SPHERE_VERTICES);   // [{x,y,z}]  (unit sphere)
  const spherei = new Int32Array(SPHERE_INDICES);
  (function generatesphere() {
    const dj = Math.PI / (MESH_SIZE + 1.0);
    const di = Math.PI / MESH_SIZE;
    spherev[0] = { x: 0, y: 1, z: 0 };
    spherev[1] = { x: 0, y: -1, z: 0 };
    for (let j = 0; j < MESH_SIZE; j++) {
      const ry = Math.sin((j + 1) * dj);
      const hy = Math.cos((j + 1) * dj);
      for (let i = 0; i < MESH_SIZE * 2; i++) {
        const si = 2 + i + j * MESH_SIZE * 2;
        spherev[si] = { x: Math.sin(i * di) * ry, y: hy, z: Math.cos(i * di) * ry };
      }
    }
    // top cap
    for (let i = 0; i < MESH_SIZE * 2; i++) {
      spherei[3 * i] = 0;
      spherei[3 * i + 1] = i + 2;
      spherei[3 * i + 2] = i + 3;
      if (i === MESH_SIZE * 2 - 1) spherei[3 * i + 2] = 2;
    }
    // middle strips
    for (let j = 0; j < MESH_SIZE - 1; j++) {
      const v = 2 + j * MESH_SIZE * 2;
      const ind = 3 * MESH_SIZE * 2 + j * 6 * MESH_SIZE * 2;
      for (let i = 0; i < MESH_SIZE * 2; i++) {
        spherei[6 * i + ind] = v + i;
        spherei[6 * i + 2 + ind] = v + i + 1;
        spherei[6 * i + 1 + ind] = v + i + MESH_SIZE * 2;
        spherei[6 * i + ind + 3] = v + i + MESH_SIZE * 2;
        spherei[6 * i + 2 + ind + 3] = v + i + 1;
        spherei[6 * i + 1 + ind + 3] = v + i + MESH_SIZE * 2 + 1;
        if (i === MESH_SIZE * 2 - 1) {
          spherei[6 * i + 2 + ind] = v + i + 1 - 2 * MESH_SIZE;
          spherei[6 * i + 2 + ind + 3] = v + i + 1 - 2 * MESH_SIZE;
          spherei[6 * i + 1 + ind + 3] = v + i + MESH_SIZE * 2 + 1 - 2 * MESH_SIZE;
        }
      }
    }
    // bottom cap
    const vb = SPHERE_VERTICES - MESH_SIZE * 2;
    const indb = SPHERE_INDICES - 3 * MESH_SIZE * 2;
    for (let i = 0; i < MESH_SIZE * 2; i++) {
      spherei[3 * i + indb] = 1;
      spherei[3 * i + 1 + indb] = vb + i + 1;
      spherei[3 * i + 2 + indb] = vb + i;
      if (i === MESH_SIZE * 2 - 1) spherei[3 * i + 1 + indb] = vb;
    }
  })();

  // indexed ball geometry: normal == unit vertex position (as the .c's glNormal3f)
  const ballGeom = new THREE.BufferGeometry();
  {
    const p = new Float32Array(SPHERE_VERTICES * 3);
    for (let k = 0; k < SPHERE_VERTICES; k++) {
      p[k * 3] = spherev[k].x; p[k * 3 + 1] = spherev[k].y; p[k * 3 + 2] = spherev[k].z;
    }
    ballGeom.setAttribute('position', new THREE.BufferAttribute(p, 3));
    ballGeom.setAttribute('normal', new THREE.BufferAttribute(p.slice(), 3));
    ballGeom.setIndex(Array.from(spherei));
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

  // gluPerspective(50, w/h, 2, 1000). Portrait squish applied in syncSize().
  const camera = new THREE.PerspectiveCamera(50, 1, 2.0, 1000.0);
  camera.up.set(0, 1, 0);

  // Two lights, world-anchored (the .c sets glLightfv POSITION right after gluLookAt,
  // so the values are world coords): LIGHT0 = white positional at the box floor centre
  // (0,0,0); LIGHT1 = half-grey directional from above (dir (0,1,0)). No ambient term.
  const light0 = new THREE.PointLight(0xffffff, Math.PI, 0, 0);   // distance 0, decay 0: no falloff
  light0.position.set(0, 0, 0);
  scene.add(light0);
  const light1 = new THREE.DirectionalLight(0xffffff, 0.5 * Math.PI);
  light1.position.set(0, 1, 0);   // shines from +y toward the origin
  light1.target.position.set(0, 0, 0);
  scene.add(light1);
  scene.add(light1.target);

  // ---- floor texture: procedural rebuild of boxed.h's 256x256 green noise plate ----
  function makeFloorTexture() {
    const S = 256;
    const data = new Uint8Array(S * S * 4);
    const hash = (x, y) => {           // deterministic grain (no yarandom consumption)
      const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      return s - Math.floor(s);        // [0,1)
    };
    const cx = 127.5, cy = 127.5;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const r = Math.hypot(x - cx, y - cy);
        const g = Math.max(0, Math.min(255, Math.round(251 - 0.9 * r + (hash(x, y) - 0.5) * 9)));
        const red = Math.max(0, Math.min(255, Math.round(g * 0.09 + (hash(x + 71, y) - 0.5) * 10)));
        const blu = Math.max(0, Math.min(255, Math.round(g * 0.013 + (hash(x, y + 53) - 0.5) * 3)));
        const o = (y * S + x) * 4;
        data[o] = red; data[o + 1] = g; data[o + 2] = blu; data[o + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;   // GL_NEAREST
    tex.minFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;       // GL_REPEAT
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  }
  const floorTex = makeFloorTexture();

  // ---- static scenery: floor plate (drawfilledbox), walls (drawbox), grid (drawpattern) ----
  const sceneryMats = [];
  function addStatics() {
    // Floor plate: unit box (-1..1) scaled (20,0.25,20) then translated (0,2,0)
    // [glScalef*glTranslatef], textured (MODULATE with white), only the TOP face uses
    // the full texture; every other face samples the texture's bottom edge (v=1).
    const bx = (v) => 20 * v;
    const by = (v) => 0.25 * (v + 2);
    const bz = (v) => 20 * v;
    // each face: 4 corners [x,y,z,u,v] (order as drawfilledbox), CCW quad -> 2 tris
    const faces = [
      // front (z=1)
      [[-1, 1, 1, 0, 1], [1, 1, 1, 1, 1], [1, -1, 1, 1, 1], [-1, -1, 1, 0, 1]],
      // rear (z=-1)
      [[1, 1, -1, 0, 1], [-1, 1, -1, 1, 1], [-1, -1, -1, 1, 1], [1, -1, -1, 0, 1]],
      // left (x=-1)
      [[-1, 1, 1, 1, 1], [-1, -1, 1, 1, 1], [-1, -1, -1, 0, 1], [-1, 1, -1, 0, 1]],
      // right (x=1)
      [[1, 1, 1, 0, 1], [1, 1, -1, 1, 1], [1, -1, -1, 1, 1], [1, -1, 1, 0, 1]],
      // top (y=1) -- the visible green floor: full texture
      [[-1, 1, 1, 0, 0], [-1, 1, -1, 0, 1], [1, 1, -1, 1, 1], [1, 1, 1, 1, 0]],
      // bottom (y=-1)
      [[-1, -1, 1, 0, 0], [-1, -1, -1, 0, 1], [1, -1, -1, 1, 1], [1, -1, 1, 1, 0]],
    ];
    const fp = [], fuv = [];
    for (const f of faces) {
      const q = f.map((c) => [bx(c[0]), by(c[1]), bz(c[2]), c[3], c[4]]);
      for (const [a, b] of [[1, 2], [2, 3]]) {      // tris (0,1,2) and (0,2,3)
        for (const k of [0, a, b]) {
          fp.push(q[k][0], q[k][1], q[k][2]);
          fuv.push(q[k][3], q[k][4]);
        }
      }
    }
    const floorGeom = new THREE.BufferGeometry();
    floorGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fp), 3));
    floorGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(fuv), 2));
    const floorMat = new THREE.MeshBasicMaterial({ map: floorTex, side: THREE.DoubleSide });
    sceneryMats.push(floorMat);
    scene.add(new THREE.Mesh(floorGeom, floorMat));

    // Walls: 12 edges of a unit box, 4 copies with drawbox's transforms.
    const E = [   // unit-box edges (drawbox: top loop, bottom loop, 4 verticals)
      [-1, 1, 1, -1, 1, -1], [-1, 1, -1, 1, 1, -1], [1, 1, -1, 1, 1, 1], [1, 1, 1, -1, 1, 1],
      [-1, -1, 1, 1, -1, 1], [1, -1, 1, 1, -1, -1], [1, -1, -1, -1, -1, -1], [-1, -1, -1, -1, -1, 1],
      [-1, 1, 1, -1, -1, 1], [1, 1, 1, 1, -1, 1], [1, 1, -1, 1, -1, -1], [-1, 1, -1, -1, -1, -1],
    ];
    const wallXforms = [
      (v) => [20 * v[0], 20 * (v[1] + 1), 0.25 * (v[2] + 81)],   // +z wall
      (v) => [20 * v[0], 20 * (v[1] + 1), 0.25 * (v[2] - 81)],   // -z wall
      (v) => [0.25 * (v[0] - 81), 20 * (v[1] + 1), 20 * v[2]],   // -x wall
      (v) => [0.25 * (v[0] + 81), 20 * (v[1] + 1), 20 * v[2]],   // +x wall
    ];
    const wp = [];
    for (const xf of wallXforms) {
      for (const e of E) {
        const a = xf([e[0], e[1], e[2]]), b = xf([e[3], e[4], e[5]]);
        wp.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
    }
    const wallGeom = new THREE.BufferGeometry();
    wallGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wp), 3));
    const wallMat = new THREE.LineBasicMaterial({ color: new THREE.Color().setRGB(0.2, 0.5, 0.2) });
    scene.add(new THREE.LineSegments(wallGeom, wallMat));

    // Ground grid: drawpattern's two line strips, 5x5 tiles translated by 30.
    const strip1 = [
      [-25, 35], [-15, 35], [-5, 25], [5, 25], [15, 35], [25, 35], [35, 25], [35, 15],
      [25, 5], [25, -5], [35, -15], [35, -25], [25, -35], [15, -35], [5, -25], [-5, -25],
      [-15, -35], [-25, -35], [-35, -25], [-35, -15], [-25, -5], [-25, 5], [-35, 15], [-35, 25], [-25, 35],
    ];
    const strip2 = [
      [-5, 15], [5, 15], [15, 5], [15, -5], [5, -15], [-5, -15], [-15, -5], [-15, 5], [-5, 15],
    ];
    const seg = [];   // one tile's segments (y=0), as line-segment endpoint pairs
    const emitStrip = (s) => {
      for (let i = 0; i < s.length - 1; i++) {
        seg.push(s[i][0], 0, s[i][1], s[i + 1][0], 0, s[i + 1][1]);
      }
    };
    emitStrip(strip1); emitStrip(strip2);
    const gp = [];
    for (let dx = -2; dx < 3; dx++) {
      for (let dz = -2; dz < 3; dz++) {
        for (let i = 0; i < seg.length; i += 3) {
          gp.push(seg[i] + dx * 30, seg[i + 1], seg[i + 2] + dz * 30);
        }
      }
    }
    const gridGeom = new THREE.BufferGeometry();
    gridGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gp), 3));
    const gridMat = new THREE.LineBasicMaterial({ color: new THREE.Color().setRGB(0.1, 0.1, 0.6) });
    scene.add(new THREE.LineSegments(gridGeom, gridMat));
  }
  addStatics();

  // shared white-flash material for vanishing shards (drawtriman: diffuse 1, emission 0.8)
  const whiteMat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    emissive: new THREE.Color().setRGB(0.8, 0.8, 0.8),
    specular: 0x000000, shininess: 5, side: THREE.DoubleSide,
  });

  // ===================================================================
  //  simulation state (balls + per-ball triangle managers)
  // ===================================================================
  let balls = [];        // physics
  let ballMeshes = [];   // one Mesh per ball (own material)
  let tman = [];         // one triangle-manager per ball

  function newBall() {
    return {
      loc: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 0 },
      color: { x: 1, y: 1, z: 1 }, radius: 3,
      bounced: false, offside: 0, justcreated: true,
      prevLoc: { x: 0, y: 0, z: 0 },
    };
  }

  // Ball material. boxed does NOT glEnable(GL_NORMALIZE), so its glScalef(radius) shrinks
  // the unit vertex normals to length 1/radius and GL uses them un-normalized -> the
  // DIFFUSE term is attenuated by 1/radius (bigger balls are emission-dominated). We bake
  // that 1/radius into the diffuse albedo (three re-normalizes normals, so we can't get it
  // from the normals). emission stays at the full 0.5*color. No specular, no ambient.
  function setBallMaterial(mat, B) {
    const inv = 1 / B.radius;
    mat.color.setRGB(B.color.x * inv, B.color.y * inv, B.color.z * inv);
    mat.emissive.setRGB(B.color.x * 0.5, B.color.y * 0.5, B.color.z * 0.5);
  }

  // createball(): fresh ball, dropped high with a small random horizontal drift and a
  // bright colour (rolled until r+g+b >= 1.8).
  function createball(b) {
    const speed = config.speed;
    b.loc.x = 5 - 10 * rnd();
    b.loc.y = 35 + 20 * rnd();
    b.loc.z = 5 - 10 * rnd();
    b.dir.x = (0.5 - rnd()) * speed;
    b.dir.y = 0.0;
    b.dir.z = (0.5 - rnd()) * speed;
    b.offside = 0;
    b.bounced = false;
    b.radius = clampBallsize();
    let r, g, bl;
    do { r = rnd(); g = rnd(); bl = rnd(); } while (r + g + bl < 1.8);
    b.color.x = r; b.color.y = g; b.color.z = bl;
    b.justcreated = true;
  }

  function makeTriman() {
    const cPos = new Float32Array(NUM_TRI * 9), cNor = new Float32Array(NUM_TRI * 9);
    const wPos = new Float32Array(NUM_TRI * 9), wNor = new Float32Array(NUM_TRI * 9);
    const cGeom = new THREE.BufferGeometry(), wGeom = new THREE.BufferGeometry();
    const cPa = new THREE.BufferAttribute(cPos, 3); cPa.setUsage(THREE.DynamicDrawUsage);
    const cNa = new THREE.BufferAttribute(cNor, 3); cNa.setUsage(THREE.DynamicDrawUsage);
    const wPa = new THREE.BufferAttribute(wPos, 3); wPa.setUsage(THREE.DynamicDrawUsage);
    const wNa = new THREE.BufferAttribute(wNor, 3); wNa.setUsage(THREE.DynamicDrawUsage);
    cGeom.setAttribute('position', cPa); cGeom.setAttribute('normal', cNa);
    wGeom.setAttribute('position', wPa); wGeom.setAttribute('normal', wNa);
    const colorMat = new THREE.MeshPhongMaterial({
      color: 0xffffff, emissive: 0x000000,
      specular: 0x000000, shininess: 5, side: THREE.DoubleSide,
    });
    const cMesh = new THREE.Mesh(cGeom, colorMat);
    const wMesh = new THREE.Mesh(wGeom, whiteMat);
    cMesh.visible = false; wMesh.visible = false;
    cMesh.frustumCulled = false; wMesh.frustumCulled = false;
    scene.add(cMesh); scene.add(wMesh);
    return {
      active: false, tris: null, vertices: null, normals: null,
      color: { x: 1, y: 1, z: 1 }, explosion: 1, decay: 0.023, momentum: 0.6,
      cPos, cNor, wPos, wNor, cGeom, wGeom, colorMat, cMesh, wMesh,
    };
  }

  // freetris(): forget the current explosion (the ball is respawning).
  function freetris(t) {
    t.active = false; t.tris = null; t.vertices = null; t.normals = null;
    t.cMesh.visible = false; t.wMesh.visible = false;
  }

  // createtrisfromball(): shatter a ball's sphere into NUM_TRI shards.
  function createtrisfromball(t, b) {
    copyDerived(t);                         // pull explosion/decay/momentum live from config
    t.color.x = b.color.x; t.color.y = b.color.y; t.color.z = b.color.z;
    const explosion = 1.0 + t.explosion * 2.0 * rnd();
    const momentum = t.momentum;
    t.tris = new Array(NUM_TRI);
    t.vertices = new Array(SPHERE_INDICES);
    t.normals = new Array(NUM_TRI);
    const scale = b.radius * 2;
    for (let i = 0; i < NUM_TRI; i++) {
      const pos = i * 3;
      const v0 = spherev[spherei[pos]], v1 = spherev[spherei[pos + 1]], v2 = spherev[spherei[pos + 2]];
      const V0 = { x: v0.x, y: v0.y, z: v0.z };
      const V1 = { x: v1.x, y: v1.y, z: v1.z };
      const V2 = { x: v2.x, y: v2.y, z: v2.z };
      // centroid of the triangle -> shard "direction" seed
      const avg = {
        x: (V0.x + V1.x + V2.x) * 0.33333,
        y: (V0.y + V1.y + V2.y) * 0.33333,
        z: (V0.z + V1.z + V2.z) * 0.33333,
      };
      t.normals[i] = { x: avg.x, y: avg.y, z: avg.z };   // flat normal (the .c leaves it unnormalized)
      const loc = { x: b.loc.x + avg.x, y: b.loc.y + avg.y, z: b.loc.z + avg.z };
      // recentre the 3 verts on the centroid, scale by 2*radius, move back
      for (const V of [V0, V1, V2]) {
        V.x = (V.x - avg.x) * scale + avg.x;
        V.y = (V.y - avg.y) * scale + avg.y;
        V.z = (V.z - avg.z) * scale + avg.z;
      }
      t.vertices[pos] = V0; t.vertices[pos + 1] = V1; t.vertices[pos + 2] = V2;
      // velocity = centroid*explosion + jitter + ball horizontal momentum
      const dir = {
        x: avg.x * explosion + (0.1 - 0.2 * rnd()) + b.dir.x * momentum,
        y: avg.y * explosion + (0.15 - 0.3 * rnd()),
        z: avg.z * explosion + (0.1 - 0.2 * rnd()) + b.dir.z * momentum,
      };
      t.tris[i] = { loc, dir, far: false, gone: 0, render: 0 };
    }
    t.active = true;
    t.colorMat.color.setRGB(b.color.x, b.color.y, b.color.z);
    t.colorMat.emissive.setRGB(b.color.x * 0.3, b.color.y * 0.3, b.color.z * 0.3);
  }

  function copyDerived(t) {
    t.explosion = Math.floor(clampExplosion()) / 15.0;   // note the (int) cast in the .c
    t.decay = remapDecay(clampDecay());
    t.momentum = clampMomentum();
  }

  // updatetris(): one physics tick for a ball's shards.
  function updatetris(t) {
    const speed = config.speed;
    const grav = 0.1 * speed;
    for (let b = 0; b < NUM_TRI; b++) {
      const tr = t.tris[b];
      if (rnd() < t.decay) { if (tr.gone === 0) tr.gone = 1; }
      tr.dir.y -= grav;
      tr.loc.x += tr.dir.x; tr.loc.y += tr.dir.y; tr.loc.z += tr.dir.z;
      if (tr.far) continue;
      if (tr.loc.y < 0) {   // under the floor
        if (tr.loc.x > -95.0 && tr.loc.x < 95.0 && tr.loc.z > -95.0 && tr.loc.z < 95.0) {
          tr.dir.y = -tr.dir.y;
          tr.loc.y = -tr.loc.y;
          tr.dir.x *= 0.80; tr.dir.y *= 0.80; tr.dir.z *= 0.80;   // dampening
        } else {
          tr.far = true;
          continue;
        }
      }
      if (tr.loc.x > -21.0 && tr.loc.x < 21.0 && tr.loc.z > -21.0 && tr.loc.z < 21.0) {
        // inside the box footprint: bounce back OUT against the nearest wall
        let xd = 999.0, zd = 999.0;
        if (tr.loc.x > -21.0 && tr.loc.x < 0) xd = tr.loc.x + 21.0;
        if (tr.loc.x < 21.0 && tr.loc.x > 0) xd = 21.0 - tr.loc.x;
        if (tr.loc.z > -21.0 && tr.loc.z < 0) zd = tr.loc.z + 21.0;
        if (tr.loc.z < 21.0 && tr.loc.z > 0) zd = 21.0 - tr.loc.z;
        if (xd < zd) {
          tr.loc.x += (tr.dir.x < 0 ? 21.0 - tr.loc.x : -21.0 - tr.loc.x);
          tr.dir.x = -tr.dir.x;
        } else {
          tr.loc.z += (tr.dir.z < 0 ? 21.0 - tr.loc.z : -21.0 - tr.loc.z);
          tr.dir.z = -tr.dir.z;
        }
      }
    }
  }

  // The gone lifecycle + colour decision from drawtriman, run once per physics tick:
  // gone 0 -> coloured; 1..3 -> white (then gone++); >3 -> skip.
  function advanceTrisRender(t) {
    for (let i = 0; i < NUM_TRI; i++) {
      const tr = t.tris[i];
      if (tr.gone > 3) { tr.render = 2; continue; }
      if (tr.gone > 0) { tr.render = 1; tr.gone++; continue; }
      tr.render = 0;
    }
  }

  // updateballs(): one physics tick for every ball (gravity, floor, walls, collisions).
  function updateballs() {
    const speed = config.speed;
    const gravity = 0.30 * speed;
    const n = balls.length;
    for (let b = 0; b < n; b++) {
      const B = balls[b];
      B.dir.y -= gravity;
      B.loc.x += B.dir.x; B.loc.y += B.dir.y; B.loc.z += B.dir.z;
      // floor (y=0): bounce when the ball dips below its radius
      if (B.loc.y < B.radius) {
        if (B.loc.x < -95.0 || B.loc.x > 95.0 || B.loc.z < -95.0 || B.loc.z > 95.0) {
          if (B.loc.y < -2000.0) createball(B);
        } else {
          B.loc.y = B.radius + (B.radius - B.loc.y);
          B.dir.y = -B.dir.y;
          if (B.offside) {
            B.bounced = true;   // this ball explodes; stop drawing it as a ball
            B.dir.x *= 0.80; B.dir.y *= 0.80; B.dir.z *= 0.80;
            if (B.dir.x * B.dir.x + B.dir.y * B.dir.y + B.dir.z * B.dir.z < 0.08) createball(B);
            if (B.dir.x * B.dir.x + B.dir.z * B.dir.z < 0.005) createball(B);
          }
        }
      }
      if (!B.offside) {
        if (B.loc.x - B.radius < -20.0) {
          if (B.loc.y > 41 + B.radius) B.offside = 1;
          else { B.dir.x = -B.dir.x; B.loc.x = -20.0 + B.radius; }
        }
        if (B.loc.x + B.radius > 20.0) {
          if (B.loc.y > 41 + B.radius) B.offside = 1;
          else { B.dir.x = -B.dir.x; B.loc.x = 20.0 - B.radius; }
        }
        if (B.loc.z - B.radius < -20.0) {
          if (B.loc.y > 41 + B.radius) B.offside = 1;
          else { B.dir.z = -B.dir.z; B.loc.z = -20.0 + B.radius; }
        }
        if (B.loc.z + B.radius > 20.0) {
          if (B.loc.y > 41 + B.radius) B.offside = 1;
          else { B.dir.z = -B.dir.z; B.loc.z = 20.0 - B.radius; }
        }
      }
      // ball-ball collisions (O(n^2), b vs j>b) -- verbatim from the .c
      for (let j = b + 1; j < n; j++) {
        const J = balls[j];
        const squaredist = B.radius * B.radius + J.radius * J.radius;
        let dx = B.loc.x - J.loc.x, dy = B.loc.y - J.loc.y, dz = B.loc.z - J.loc.z;
        if (dx * dx + dy * dy + dz * dz < squaredist) {
          const rx = J.loc.x - B.loc.x, ry = J.loc.y - B.loc.y, rz = J.loc.z - B.loc.z;   // richting b->j
          const sx = B.dir.x - J.dir.x, sy = B.dir.y - J.dir.y, sz = B.dir.z - J.dir.z;    // relspeed
          const rmag = rx * rx + ry * ry + rz * rz;
          const f = (rx * sx + ry * sy + rz * sz) / rmag;      // dot(richting,relspeed)/|richting|^2
          const ix = rx * f, iy = ry * f, iz = rz * f;          // influence
          B.dir.x -= ix; B.dir.y -= iy; B.dir.z -= iz;
          J.dir.x += ix; J.dir.y += iy; J.dir.z += iz;
          B.loc.x += B.dir.x; B.loc.y += B.dir.y; B.loc.z += B.dir.z;
          J.loc.x += J.dir.x; J.loc.y += J.dir.y; J.loc.z += J.dir.z;
          dx = B.loc.x - J.loc.x; dy = B.loc.y - J.loc.y; dz = B.loc.z - J.loc.z;
          let guard = 0;
          while (dx * dx + dy * dy + dz * dz < squaredist && guard++ < 1000) {
            B.loc.x += B.dir.x; B.loc.y += B.dir.y; B.loc.z += B.dir.z;
            J.loc.x += J.dir.x; J.loc.y += J.dir.y; J.loc.z += J.dir.z;
            dx = B.loc.x - J.loc.x; dy = B.loc.y - J.loc.y; dz = B.loc.z - J.loc.z;
          }
        }
      }
    }
  }

  // One physics frame == draw()'s per-frame block: updateballs, then per ball manage
  // its explosion (create/update shards) exactly as the .c's ball loop.
  function physicsTick() {
    for (const B of balls) { B.prevLoc.x = B.loc.x; B.prevLoc.y = B.loc.y; B.prevLoc.z = B.loc.z; }
    updateballs();
    for (let i = 0; i < balls.length; i++) {
      const B = balls[i];
      if (B.justcreated) { B.justcreated = false; freetris(tman[i]); }
      if (B.bounced) {
        if (!tman[i].active) createtrisfromball(tman[i], B);
        else updatetris(tman[i]);
        advanceTrisRender(tman[i]);
      }
    }
  }

  // ---- (re)build the ball/triman arrays + meshes ----
  function initSim() {
    // dispose any prior meshes
    for (const m of ballMeshes) { scene.remove(m); m.material.dispose(); }
    for (const t of tman) {
      scene.remove(t.cMesh); scene.remove(t.wMesh);
      t.cGeom.dispose(); t.wGeom.dispose(); t.colorMat.dispose();
    }
    balls = []; ballMeshes = []; tman = [];
    const n = clampBalls();
    for (let i = 0; i < n; i++) {
      const B = newBall();
      createball(B);
      B.loc.y *= rnd();          // pinit: scatter the initial drop heights
      balls.push(B);
      const mat = new THREE.MeshPhongMaterial({
        color: 0xffffff, emissive: 0x000000,
        specular: 0x000000, shininess: 5, side: THREE.FrontSide,
      });
      setBallMaterial(mat, B);
      const mesh = new THREE.Mesh(ballGeom, mat);
      mesh.frustumCulled = false;
      scene.add(mesh);
      ballMeshes.push(mesh);
      tman.push(makeTriman());
    }
    // camera path (pinit) -- consume RNG in the same order as the .c (after the balls)
    camXSpeed = 1.0 / (CAMSPEED / 50.0 + rnd() * (CAMSPEED / 50.0));
    camZSpeed = 1.0 / (CAMSPEED / 50.0 + rnd() * (CAMSPEED / 50.0));   // computed, unused (as the .c)
    camYSpeed = 1.0 / (CAMSPEED / 250.0 + rnd() * (CAMSPEED / 250.0));
    if (rnd() < 0.5) camXSpeed = -camXSpeed;
    if (rnd() < 0.5) camZSpeed = -camZSpeed;
    tic = camtic = rnd() * 100.0;
    builtBalls = n;
  }

  // ---- camera orbit (draw()) ----
  let camXSpeed = 1, camYSpeed = 1, camZSpeed = 1;
  let tic = 0, camtic = 0;
  function applyCamera() {
    const speed = config.speed;
    const r = CAMDISTANCE_MIN + (CAMDISTANCE_MAX - CAMDISTANCE_MIN)
      + (CAMDISTANCE_MAX - CAMDISTANCE_MIN) * Math.cos((camtic / CAMDISTANCE_SPEED) * speed);
    const v1x = r * Math.sin((camtic / camXSpeed) * speed);
    const v1z = r * Math.cos((camtic / camXSpeed) * speed);
    const v1y = CAM_HEIGHT * Math.sin((camtic / camYSpeed) * speed) + 1.02 * CAM_HEIGHT;
    const v2x = LOOKAT_R * Math.sin((camtic / (camXSpeed * 5.0)) * speed);
    const v2y = (CAM_HEIGHT * Math.sin((camtic / camYSpeed) * speed) + 1.02 * CAM_HEIGHT) / 10.0;
    camera.position.set(v1x, v1y, v1z);
    camera.up.set(0, 1, 0);
    camera.lookAt(v2x, v2y, v2x);   // NOTE: the .c passes v2.x for BOTH x and z of the centre
  }

  // ---- sizing (reshape_boxed: gluPerspective + the portrait squish) ----
  const scaleM = new THREE.Matrix4();
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;                 // gluPerspective(50, w/h, 2, 1000)
    camera.updateProjectionMatrix();
    const s = w < h ? w / h : 1;           // draw()'s glScalef(s,s,s), premultiplied onto P
    if (s !== 1) {
      scaleM.makeScale(s, s, s);
      camera.projectionMatrix.multiply(scaleM);
    }
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  let builtBalls = 0;
  initSim();

  // ===================================================================
  //  render
  // ===================================================================
  // rebuild a triman's colored/white shard geometry from the current tick state
  function buildTrimanGeom(t) {
    let ci = 0, wi = 0;
    for (let i = 0; i < NUM_TRI; i++) {
      const tr = t.tris[i];
      if (tr.render === 2) continue;
      const loc = tr.loc, n = t.normals[i], base = i * 3;
      const v0 = t.vertices[base], v1 = t.vertices[base + 1], v2 = t.vertices[base + 2];
      if (tr.render === 0) {
        t.cPos[ci] = v0.x + loc.x; t.cPos[ci + 1] = v0.y + loc.y; t.cPos[ci + 2] = v0.z + loc.z;
        t.cPos[ci + 3] = v1.x + loc.x; t.cPos[ci + 4] = v1.y + loc.y; t.cPos[ci + 5] = v1.z + loc.z;
        t.cPos[ci + 6] = v2.x + loc.x; t.cPos[ci + 7] = v2.y + loc.y; t.cPos[ci + 8] = v2.z + loc.z;
        t.cNor[ci] = n.x; t.cNor[ci + 1] = n.y; t.cNor[ci + 2] = n.z;
        t.cNor[ci + 3] = n.x; t.cNor[ci + 4] = n.y; t.cNor[ci + 5] = n.z;
        t.cNor[ci + 6] = n.x; t.cNor[ci + 7] = n.y; t.cNor[ci + 8] = n.z;
        ci += 9;
      } else {
        t.wPos[wi] = v0.x + loc.x; t.wPos[wi + 1] = v0.y + loc.y; t.wPos[wi + 2] = v0.z + loc.z;
        t.wPos[wi + 3] = v1.x + loc.x; t.wPos[wi + 4] = v1.y + loc.y; t.wPos[wi + 5] = v1.z + loc.z;
        t.wPos[wi + 6] = v2.x + loc.x; t.wPos[wi + 7] = v2.y + loc.y; t.wPos[wi + 8] = v2.z + loc.z;
        t.wNor[wi] = n.x; t.wNor[wi + 1] = n.y; t.wNor[wi + 2] = n.z;
        t.wNor[wi + 3] = n.x; t.wNor[wi + 4] = n.y; t.wNor[wi + 5] = n.z;
        t.wNor[wi + 6] = n.x; t.wNor[wi + 7] = n.y; t.wNor[wi + 8] = n.z;
        wi += 9;
      }
    }
    t.cGeom.attributes.position.needsUpdate = true; t.cGeom.attributes.normal.needsUpdate = true;
    t.wGeom.attributes.position.needsUpdate = true; t.wGeom.attributes.normal.needsUpdate = true;
    t.cGeom.setDrawRange(0, ci / 3); t.wGeom.setDrawRange(0, wi / 3);
    t.cMesh.visible = ci > 0; t.wMesh.visible = wi > 0;
  }

  let raf = 0, last = 0, paused = false, ms = 16, accum = 0, dirtyShards = true;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    if (clampBalls() !== builtBalls) initSim();

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);

    // camera advances continuously (draw() does tic += 0.01 per frame; the camera is
    // a smooth function of tic/camtic and does not touch the discrete ball physics).
    const df = effFps * dt;
    tic += 0.01 * df;
    camtic += (0.01 + 0.01 * Math.sin(tic * config.speed)) * df;

    // discrete physics at effFps (catch-up accumulator)
    accum += df;
    let steps = 0;
    while (accum >= 1 && steps < MAX_TICKS) { physicsTick(); accum -= 1; steps++; dirtyShards = true; }
    if (steps === MAX_TICKS) accum = 0;
    const alpha = accum;

    applyCamera();

    // balls: interpolate loc between ticks (teleport guard snaps respawns/collisions)
    for (let i = 0; i < balls.length; i++) {
      const B = balls[i], mesh = ballMeshes[i];
      if (B.bounced) { mesh.visible = false; continue; }
      mesh.visible = true;
      const p = B.prevLoc, c = B.loc;
      const jump = (c.x - p.x) ** 2 + (c.y - p.y) ** 2 + (c.z - p.z) ** 2;
      const a = jump > 36 ? 1 : alpha;    // > 6 units => snap
      mesh.position.set(p.x + (c.x - p.x) * a, p.y + (c.y - p.y) * a, p.z + (c.z - p.z) * a);
      mesh.scale.setScalar(B.radius);
      setBallMaterial(mesh.material, B);   // refresh (respawn changes colour; live ballsize)
      mesh.material.wireframe = config.wire;
    }
    // shards: rebuilt only on a tick (they don't interpolate)
    for (let i = 0; i < balls.length; i++) {
      const t = tman[i];
      if (balls[i].bounced && t.active) {
        if (dirtyShards) buildTrimanGeom(t);
        t.colorMat.wireframe = config.wire;
      } else { t.cMesh.visible = false; t.wMesh.visible = false; }
    }
    whiteMat.wireframe = config.wire;
    for (const m of sceneryMats) m.wireframe = config.wire;
    dirtyShards = false;

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      for (const m of ballMeshes) m.material.dispose();
      for (const t of tman) { t.cGeom.dispose(); t.wGeom.dispose(); t.colorMat.dispose(); }
      ballGeom.dispose(); whiteMat.dispose(); floorTex.dispose();
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { initSim(); },     // fresh balls (host 're-seed')
    config,
    params,
  };
}

export default { title, info, start };
