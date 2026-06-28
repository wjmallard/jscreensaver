// hypnowheel.js -- a DIRECT port of xscreensaver's hypnowheel.c
// (Jamie Zawinski, 2008), self-contained WebGL2. start(canvas) returns
// { stop, pause, resume, reinit, getStats, config, params }.
//
// "Overlapping, translucent spiral patterns. The tightness of their spirals
// fluctuates in and out" (jwz) -- a hypnotic moire. The .c draws `layers`
// spiral discs, each `count` arms wide (a 50%-duty radial grating wound by the
// disc's `twist`), ADDITIVELY blended (glBlendFunc GL_ONE, GL_ONE); each disc is
// a different colormap entry, spins in-plane, and (with -wander) its twist
// fluctuates; the WHOLE wheel wanders across the screen via a separate global
// rotator. Viewed in 30deg perspective from z=30, scaled 45x.
//
// This replaces an earlier shadertoy-harness version that APPROXIMATED the whole
// thing (iTime-driven motion, in-shader palette, baked params, and -- the bug
// the user caught -- no global wander). Like quasicrystal, a faithful port needs
// CPU state the iTime-only harness can't hold, so it is self-contained: the real
// rotator.js rotators + colormap.js colormap on the CPU, feeding one fragment
// shader that evaluates the same per-pixel additive sum the .c rasterizes.
// Because everything is coplanar at z=0 (the global rotation is 0; only the Z
// in-plane spin is used), the perspective collapses to a uniform scale, so a 2D
// per-pixel field reproduces it exactly. See hypnowheel.md.
//
// Faithful to hypnowheel.c: the global wander (translate (x-0.5)*8), per-disc
// in-plane spin (glRotatef 360*z), per-disc twist = pos.z * twistiness *
// ((i&1)?1:-1), the 50%-duty arm band (dth/2 of dth=2pi/n), additive blend with
// cscale = 65536*(layers>3?layers-2:1) (so overlaps bloom to white), colors
// evenly spaced (i*ncolors/layers) and cycling, and the symmetric pairing quirk.

import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';
import { makeSmoothColormap } from './colormap.js';

export const title = 'hypnowheel';

export const info = {
  author: 'Jamie Zawinski',
  description: 'Overlapping, translucent spiral patterns. The tightness of their spirals fluctuates in and out.\n\nhttps://en.wikipedia.org/wiki/Moire_pattern',
  year: 2008,
};

const MAXL = 50;          // .xml layers high (uniform-array bound)
const NCOLORS = 1024;     // the .c's colormap size
const OVERHEAD = 37500;   // frame-rate calibration (see framerate-calibration)
const DEF_DELAY = 20000;  // .xml delay default (us)
const HALF_H = 30.0 * 0.2679491924;   // 30 * tan(15deg): world half-height at z=0
const RR = 0.5;           // the .c's disc radius
const SCALE45 = 45.0;     // the .c's glScalef(45)

const VERT = `#version 300 es
void main(){ vec2 v = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
#define MAXL ${MAXL}
uniform vec2  uRes;
uniform int   uLayers;
uniform float uArms;          // count
uniform vec2  uTGlobal;       // global wander translate, world units
uniform vec4  uDiscA[MAXL];   // per disc: (cos, sin, tDiscX, tDiscY)
uniform vec4  uDiscB[MAXL];   // per disc: (twist, colR, colG, colB)
out vec4 frag;
const float TAU = 6.28318530718;
const float HALF_H = ${HALF_H};
const float RR = ${RR.toFixed(3)};
const float SCALE45 = ${SCALE45.toFixed(1)};

void main() {
  // pixel -> world at z=0 (after gluLookAt; perspective is a uniform scale here
  // since everything is coplanar). gluPerspective(30, W/H): vertical fov 30,
  // horizontal widened by aspect.
  vec2 ndc = (2.0 * gl_FragCoord.xy - uRes) / uRes;     // [-1,1]
  float aspect = uRes.x / uRes.y;
  vec2 world = ndc * HALF_H * vec2(aspect, 1.0);

  vec3 acc = vec3(0.0);
  for (int i = 0; i < MAXL; i++) {
    if (i >= uLayers) break;
    vec4 A = uDiscA[i];
    vec4 B = uDiscB[i];
    // world = tGlobal + 45*(tDisc + R(angle)*local)  ->  invert for local.
    vec2 w = (world - uTGlobal) / SCALE45 - A.zw;
    vec2 local = vec2(A.x * w.x + A.y * w.y, -A.y * w.x + A.x * w.y);   // R(-angle)*w
    float r = length(local);
    if (r > RR) continue;
    float phi = atan(local.y, local.x);
    // the .c's arm band: angle in [base, base+dth/2] of dth=2pi/n, wound by
    // by twist turns over the radius (2pi*twist*(r/rr)). band = [0,0.5) duty.
    float theta = phi - TAU * B.x * (r / RR);
    float a = uArms * theta;
    // 1px-ish edge AA; clamp so fwidth's spike at the atan branch cut / r=0
    // singularity doesn't wash a seam (sin(a) itself is continuous: arms is integer).
    float W = min(fwidth(a), 0.7) + 1e-4;
    float band = smoothstep(-W, W, sin(a));      // sin(a) > 0  ==  fract(a/2pi) in [0,0.5)
    acc += band * B.yzw;                          // additive (GL_ONE, GL_ONE)
  }
  frag = vec4(min(acc, vec3(1.0)), 1.0);          // the framebuffer clamps at 1
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error('hypnowheel shader: ' + gl.getShaderInfoLog(s));
  return s;
}

export function start(canvas) {
  const config = {
    speed: 1.0,        // playback-rate multiplier (the .c scales all rotator rates by speed)
    resolution: 1.0,
    layers: 4,         // .xml "layers"
    count: 13,         // .xml "count" (Arms)
    twistiness: 4.0,   // .xml "twistiness"
    // wander OFF (the .c default, and what the demo video shows): all discs stay
    // CONCENTRIC -- ONE wheel -- and that single center wanders via the global
    // rotator, while the counter-rotating constant-twist (+/-2) spirals beat into
    // a shifting moire. Wander ON instead gives each disc its OWN drifting center
    // (several separate wheels) plus a slowly fluctuating twist.
    wander: false,     // .xml "wander"
    symmetric: false,  // .xml "symmetric" (Symmetric twisting)
  };

  const params = [
    { key: 'count', label: 'Arms', type: 'range', min: 2, max: 50, step: 1, default: 13, lowLabel: 'few', highLabel: 'many', live: true },
    { key: 'layers', label: 'Layers', type: 'range', min: 1, max: 50, step: 1, default: 4, lowLabel: '1', highLabel: '50', live: false },
    { key: 'twistiness', label: 'Twistiness', type: 'range', min: 0.2, max: 10, step: 0.1, default: 4.0, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.1, max: 20, step: 0.1, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: false, live: false },
    { key: 'symmetric', label: 'Symmetric twisting', type: 'checkbox', default: false, live: false },
    { key: 'resolution', label: 'Resolution', type: 'range', min: 0.25, max: 1, step: 0.05, default: 1.0, lowLabel: 'fast', highLabel: 'crisp', live: true },
  ];

  const cv = document.createElement('canvas');
  cv.style.cssText = 'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (canvas.parentNode || document.body).appendChild(cv);

  const gl = cv.getContext('webgl2', { alpha: false, antialias: false, depth: false, powerPreference: 'high-performance' });
  if (!gl) {
    console.error('hypnowheel: WebGL2 unavailable.');
    return { stop() { cv.remove(); }, config, params };
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error('hypnowheel link: ' + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  gl.bindVertexArray(gl.createVertexArray());

  const loc = (n) => gl.getUniformLocation(prog, n);
  const uRes = loc('uRes'), uLayers = loc('uLayers'), uArms = loc('uArms'),
        uTGlobal = loc('uTGlobal'), uDiscA = loc('uDiscA'), uDiscB = loc('uDiscB');

  // --- CPU simulation (rebuilt on reinit / non-live param change) ---
  let rng, globalRot, rots, colorIdx;
  let colors;
  const discA = new Float32Array(MAXL * 4);
  const discB = new Float32Array(MAXL * 4);

  function build() {
    rng = makeYaRandom((Math.random() * 0xffffffff) >>> 0);
    const sp = config.speed;
    const n = config.layers;
    // bp->rot = make_rotator(0,0,0,0, speed*0.0025, False) -- wander only, not randomized.
    globalRot = makeRotator({ wanderSpeed: sp * 0.0025, randomize: false }, rng);
    colors = makeSmoothColormap(rng, NCOLORS);
    rots = [];
    colorIdx = [];
    for (let i = 0; i < n; i++) {
      // spin_speed = speed*0.2 + frand(spin_speed/5); wander_speed = speed*0.0012 + frand(*3)
      let spin = sp * 0.2;     spin += rng.frand(spin / 5);
      let wspd = sp * 0.0012;  wspd += rng.frand(wspd * 3);
      rots.push(makeRotator({ spinX: spin, spinY: spin, spinZ: spin, spinAccel: 0.2, wanderSpeed: config.wander ? wspd : 0, randomize: true }, rng));
      colorIdx.push(Math.floor(i * NCOLORS / n));   // d->color = i*ncolors/nlayers
    }
  }
  build();

  // Tick the rotators one frame, in the .c's read pattern, and cycle colors.
  function advanceSim() {
    const n = config.layers;
    for (let i = 0; i < n; i++) {
      const rot = config.symmetric ? rots[i & ~0x1] : rots[i];
      const tick = (!config.symmetric || i === 0);
      colorIdx[i] = (colorIdx[i] + 1) % NCOLORS;     // d->color++
      if (tick) { rot.getPosition(true); rot.getRotation(true); }
    }
    globalRot.getPosition(true);
  }

  // Read current state into the GPU uniform buffers (no tick).
  let tgx = 0, tgy = 0;
  function readUniforms() {
    const n = config.layers;
    const gp = globalRot.getPosition(false);
    tgx = (gp.x - 0.5) * 8.0;
    tgy = (gp.y - 0.5) * 8.0;
    const cdiv = (n > 3) ? (n - 2) : 1;             // cscale = 65536*(layers-2) for layers>3
    for (let i = 0; i < n; i++) {
      const rot = config.symmetric ? rots[i & ~0x1] : rots[i];
      const pos = rot.getPosition(false);
      const rotz = rot.getRotation(false).z;
      const sign = (i & 1) ? 1 : -1;
      const twist = pos.z * config.twistiness * sign;
      const ang = rotz * 2 * Math.PI;               // glRotatef(360*z)
      discA[i * 4 + 0] = Math.cos(ang);
      discA[i * 4 + 1] = Math.sin(ang);
      discA[i * 4 + 2] = (pos.x - 0.5) * 0.1;        // per-disc translate
      discA[i * 4 + 3] = (pos.y - 0.5) * 0.1;
      const c = colors[colorIdx[i]];
      discB[i * 4 + 0] = twist;
      discB[i * 4 + 1] = c.r / cdiv;
      discB[i * 4 + 2] = c.g / cdiv;
      discB[i * 4 + 3] = c.b / cdiv;
    }
  }

  function syncSize() {
    const dpr = window.devicePixelRatio || 1;
    const scale = (config.resolution == null ? 1 : config.resolution);
    const w = Math.max(1, Math.round(window.innerWidth * dpr * scale));
    const h = Math.max(1, Math.round(window.innerHeight * dpr * scale));
    if (w !== cv.width || h !== cv.height) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); }
  }

  let raf = 0, lastNow = 0, simAcc = 0;
  const stats = { ms: 16 };

  function render(now) {
    syncSize();
    if (lastNow === 0) lastNow = now;
    let dt = now - lastNow;
    lastNow = now;
    if (dt < 0) dt = 0;
    if (dt > 100) dt = 100;
    stats.ms += (dt - stats.ms) * 0.1;

    const effFps = 1e6 / (DEF_DELAY + OVERHEAD);
    simAcc += (dt / 1000) * effFps * config.speed;
    let guard = 0;
    while (simAcc >= 1 && guard < 8) { advanceSim(); simAcc -= 1; guard++; }
    if (simAcc >= 1) simAcc = 0;

    readUniforms();
    gl.useProgram(prog);
    gl.uniform2f(uRes, cv.width, cv.height);
    gl.uniform1i(uLayers, config.layers);
    gl.uniform1f(uArms, config.count);
    gl.uniform2f(uTGlobal, tgx, tgy);
    gl.uniform4fv(uDiscA, discA);
    gl.uniform4fv(uDiscB, discB);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    raf = requestAnimationFrame(render);
  }

  function onResize() { syncSize(); }
  window.addEventListener('resize', onResize);
  syncSize();
  raf = requestAnimationFrame(render);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener('resize', onResize);
      gl.deleteProgram(prog);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      cv.remove();
    },
    pause() { if (raf) { cancelAnimationFrame(raf); raf = 0; } },
    resume() { if (!raf) { lastNow = 0; raf = requestAnimationFrame(render); } },
    reinit() { build(); },
    getStats() { return { ms: stats.ms, scale: config.resolution, w: cv.width, h: cv.height }; },
    config,
    params,
  };
}
