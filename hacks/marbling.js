// marbling.js -- marbling packaged as a mountable WebGL module.
// start(canvas) returns { stop, pause, resume, reinit, getStats, config, params }.
//
// GPU (GLSL ES 3.00) re-port of xscreensaver's marbling.c (Jamie Zawinski &
// Dave Odell, 2021-2022). https://www.jwz.org/xscreensaver/
//
// marbling.c's own header says the algorithm "would ideally be written in
// Shader Language", but XScreenSaver still targets pre-GLSL OpenGL, so it runs
// the Perlin-Noise + Fractal-Brownian-Motion field on the CPU with SIMD +
// pthreads. This module does what the author wished for: the whole field runs as
// a fragment shader through the shared ./shadertoy.js WebGL2 harness at 60fps,
// with no cell cap (a CPU affordance the earlier canvas port needed on large
// viewports). The C's gridsize/"Magnification" block replication is KEPT, though,
// because it is load-bearing for the LOOK: the C only ever evaluates the field at
// GRID resolution (window / gridsize) and writes each value to a gridsize x
// gridsize block (marbling.c:405-483), so sampling per-pixel over-renders the
// high-frequency domain warp into busy fine noise where the live binary shows
// bold, grid-scale swirls. The shader quantizes fragCoord to the same grid.
//
// FAITHFULNESS: the shader (kept alongside as marbling.glsl) is a near-verbatim
// transcription of the C's SCALAR fixed-point pipeline -- 16-bit integer noise
// emulated in GLSL `uint` with `& 0xFFFFu` wraps, exactly as the CPU port did in
// JS. So the marble FIELD is bit-for-bit the CPU version's; only the rendering
// moved to the GPU. make_smooth_colormap (colormap.js) is re-rolled per run and
// injected into the shader as a 256-entry const array; the domain warp iterates
// the FBM feedback `iterations` times and only the low byte of the result indexes
// the colormap, banding the field into the marble striations. See hexplasma.js
// for the harness module shape, marbling.md for the port notes.

import { makeSmoothColormapRGB } from './colormap.js';
import { startShadertoy } from './shadertoy.js';

export const title = 'marbling';

export const info = {
  author: 'Jamie Zawinski and Dave Odell',
  description: 'Marble-like or cloud-like patterns generated using Perlin Noise and Fractal Brownian Motion.',
  year: 2021,
};

// Verbatim from marbling.glsl, with four injection tokens filled in by
// buildSource() before compile:
//   __ITER__      config.iterations  (domain-warp passes / "Complexity")
//   __SCALE__     config.scale       (noise cells across the screen / "Scale")
//   __GRID__      config.gridsize    (block size in device px / "Magnification")
//   __PALETTE__   256 comma-separated vec3(...) smooth-colormap entries
// iResolution / iTime come from the harness preamble; config.speed rides iTime
// (the harness scales it, i.e. the morph rate), config.resolution the render
// scale. The body is the C's scalar fixed-point pipeline transcribed into GLSL
// `uint` -- see marbling.glsl / marbling.md for the line-by-line provenance.
const SHADER = `
// ---- injected constants -------------------------------------------------
const int   MARB_ITER  = __ITER__;   // st->iterations
const float MARB_SCALE = __SCALE__;  // st->scale
const float MARB_GRID  = __GRID__;   // st->grid_size in device px (Magnification)
const float MARB_ZRATE = 35.8;       // C: Z += 2/draw at the live binary's ~17.9 fps

// ---- fixed-point Perlin "improved noise" (marbling.c scalar path) --------
const int MARB_ONE = 8192;   // 1<<noise_work_bits ("1.0" in the 13-bit space)

// noise_rand: the C's 8-bit perfect hash, run on a 16-bit value (marbling.c:252).
uint marbRand(uint x) {
  x = (x ^ (x >> 3u)) & 0xFFFFu;
  x = (x ^ (x << 1u)) & 0xFFFFu;
  return ((x << 5u) - x) & 0xFFFFu;
}

// P(x) == noise_rand(x & 0xff) (marbling.c:265). Every hash lookup in noise()
// feeds an 8-bit value, so this is the C's P() macro exactly.
uint marbP(uint x) { return marbRand(x & 0xFFu); }

// fade: 6t^5-15t^4+10t^3 in fixed point; t in [0,255], result in [0, 1<<14].
// (marbling.c:180, non-ARM path.) MUL_HI(a,b) == (a*b)>>16 for a,b < 2^16.
uint marbFade(uint t) {
  uint t2    = (t * t) & 0xFFFFu;              // t*t (t <= 255, fits)
  uint inner = (3840u - 6u * t) & 0xFFFFu;     // (uint16)(15*256) - 6t
  uint m1    = ((t2 * inner) >> 16u) & 0xFFFFu; // MUL_HI(t2, inner)
  uint a     = (10u * t - m1) & 0xFFFFu;       // 10t - MUL_HI(...)
  uint m2    = (t2 * a) >> 16u;                 // MUL_HI(t2, a)
  return (m2 << 6u) & 0xFFFFu;                 // << (noise_work_bits-noise_in_bits+1)
}

// grad: low 4 bits pick one of 12 gradient directions; x,y,z are signed 13-bit
// relative coords. (marbling.c:232, scalar path.)
int marbGrad(uint hash, int x, int y, int z) {
  uint h = hash & 15u;
  int u = (h < 8u) ? x : y;
  int v = (h < 4u) ? y : (((h & ~2u) == 12u) ? x : z);
  return ((h & 1u) == 0u ? u : -u) + ((h & 2u) == 0u ? v : -v);
}

// LERP(t,a,b) = (a >> lerp_loss) + IMUL_HI(t, b-a); lerp_loss == 2.
// (marbling.c:224.) a,b signed; t unsigned (<= 1<<14), so int(t)*(b-a) fits int32.
int marbLerp(uint t, int a, int b) {
  return (a >> 2) + ((int(t) * (b - a)) >> 16);
}

// noise: 3D improved Perlin noise, fixed point. x,y,z are uint16 with 8
// fractional bits; returns a uint16 read unsigned by fbm. (marbling.c:267.)
uint marbNoise(uint x, uint y, uint z) {
  uint X = x >> 8u, Y = y >> 8u, Z = z >> 8u;   // unit cube containing the point
  x &= 0xFFu; y &= 0xFFu; z &= 0xFFu;           // relative coords inside the cube
  uint u = marbFade(x), v = marbFade(y), w = marbFade(z);
  int xi = int(x << 5u), yi = int(y << 5u), zi = int(z << 5u);   // -> 13-bit coords
  uint A  = (marbP(X)      + Y) & 0xFFFFu;      // hash the 8 cube corners
  uint AA = (marbP(A)      + Z) & 0xFFFFu;
  uint AB = (marbP(A + 1u) + Z) & 0xFFFFu;
  uint B  = (marbP(X + 1u) + Y) & 0xFFFFu;
  uint BA = (marbP(B)      + Z) & 0xFFFFu;
  uint BB = (marbP(B + 1u) + Z) & 0xFFFFu;
  int c0 = marbGrad(marbP(AA),      xi,            yi,            zi);
  int c1 = marbGrad(marbP(BA),      xi - MARB_ONE, yi,            zi);
  int c2 = marbGrad(marbP(AB),      xi,            yi - MARB_ONE, zi);
  int c3 = marbGrad(marbP(BB),      xi - MARB_ONE, yi - MARB_ONE, zi);
  int c4 = marbGrad(marbP(AA + 1u), xi,            yi,            zi - MARB_ONE);
  int c5 = marbGrad(marbP(BA + 1u), xi - MARB_ONE, yi,            zi - MARB_ONE);
  int c6 = marbGrad(marbP(AB + 1u), xi,            yi - MARB_ONE, zi - MARB_ONE);
  int c7 = marbGrad(marbP(BB + 1u), xi - MARB_ONE, yi - MARB_ONE, zi - MARB_ONE);
  int r = marbLerp(w, marbLerp(v, marbLerp(u, c0, c1), marbLerp(u, c2, c3)),
                      marbLerp(v, marbLerp(u, c4, c5), marbLerp(u, c6, c7)));
  return uint(r) & 0xFFFFu;   // SCALE() is a no-op in the shipping binary
}

// fbm: 2 octaves; amplitude *G (G = 2^-0.5) each octave, frequency *2.
// (marbling.c:308.) iG = (uint16)(G*0x10000) == 46340.
uint marbFbm(uint x, uint y, uint z) {
  uint f = 1u, a = 0xFFFFu, t = 0u;
  for (int i = 0; i < 2; i++) {
    uint n = marbNoise((f * x) & 0xFFFFu, (f * y) & 0xFFFFu, (f * z) & 0xFFFFu);
    t = (t + ((n * a) >> 16u)) & 0xFFFFu;   // MUL_HI(noise, a)
    a = (a * 46340u) >> 16u;                // MUL_HI(a, iG)
    f = f << 1u;
  }
  return t;
}

// ---- injected smooth colormap (256 entries, make_smooth_colormap) --------
const vec3 MARB_PAL[256] = vec3[256](
  __PALETTE__
);

// The marble colour at one sample position (fragment coords): one full field
// evaluation -- coord -> domain warp -> palette.
vec3 marbColor(vec2 pos) {
  vec2 uv = pos / iResolution.xy;
  uv.y = 1.0 - uv.y;                             // flip y for the C's top-down scan
  float S = MARB_SCALE * 256.0;                  // scale << noise_in_bits
  uint X0 = uint(uv.x * S) & 0xFFFFu;            // (x/w) * S
  uint Y  = uint(uv.y * S) & 0xFFFFu;            // (y/h) * S
  uint Z  = uint(iTime * MARB_ZRATE) & 0xFFFFu;  // third axis = time = the morph
  uint p = 0u;                                   // domain warp: feed FBM back into every axis
  for (int i = 0; i < MARB_ITER; i++)
    p = marbFbm((p + X0) & 0xFFFFu, (p + Y) & 0xFFFFu, (p + Z) & 0xFFFFu);
  return MARB_PAL[int(p & 0xFFu)];               // only the LOW byte selects the colour
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // SUBSAMPLE: evaluate the field ONCE per gridsize cell (the C's block
  // replication, marbling.c:405-483) and replicate across the block -- cheap, and
  // the grid resolution is what gives the C's bold, grid-scale swirls. (A
  // supersampled/anti-aliased variant was tried for smoothness but was too slow:
  // the domain warp is heavy per sample, so NxN samples/pixel tanked the frame
  // rate and forced the harness to drop its render resolution. The busy-vs-bold
  // look turned out to be mostly palette CONTRAST anyway -- see marbling.md.)
  vec2 cell = floor(fragCoord / MARB_GRID);
  fragColor = vec4(marbColor(cell * MARB_GRID + 0.5 * MARB_GRID), 1.0);
}
`;

// make_smooth_colormap (colormap.js) as 256 GLSL vec3 literals in 0..1, sRGB-
// faithful (no saturation boost). Re-rolled each call, exactly as the C re-rolls
// on every launch/reset -- so each run is a different smooth gradient (sometimes
// muted, sometimes vivid, always smooth, never a harsh max-saturation rainbow).
function paletteGLSL() {
  const rgb = makeSmoothColormapRGB(256);
  return rgb
    .map((c) => `vec3(${(c[0] / 255).toFixed(4)},${(c[1] / 255).toFixed(4)},${(c[2] / 255).toFixed(4)})`)
    .join(',\n  ');
}

// Bake config.scale / config.iterations / config.gridsize (which cannot be live
// GLSL uniforms through the shared harness -- it exposes only iResolution/iTime/
// ... and no way to set custom uniforms) and a fresh palette into the shader
// source. scale, iterations and gridsize are floored to 1, the C's clamps
// (marbling.c:510-512). gridsize is a WINDOW-pixel size in the xml; the harness
// renders at device resolution and fragCoord is in device px, so a window-px
// grid is gridsize * devicePixelRatio device px (baked at the current dpr; a
// rebuild re-bakes if the dpr changes). The non-retina demo video is the
// frequency target, so at dpr 1 a gridsize of 2 is ~2px blocks, matching it.
function buildSource(config) {
  const scale = Math.max(1, config.scale | 0);
  const iters = Math.max(1, config.iterations | 0);
  const grid  = Math.max(1, config.gridsize | 0);
  const gridPx = grid * (window.devicePixelRatio || 1);
  return SHADER
    .replaceAll('__ITER__', String(iters))
    .replaceAll('__SCALE__', scale.toFixed(1))
    .replaceAll('__GRID__', gridPx.toFixed(4))
    .replaceAll('__PALETTE__', paletteGLSL());
}

export function start(canvas) {
  // Ranges/labels mirror hacks/config/marbling.xml. speed + resolution are
  // honored by the harness (speed scales iTime = the morph rate; resolution is
  // the render scale). scale + iterations + gridsize are baked into the shader,
  // so they take effect on reinit() -- a rebuild -- rather than live (see
  // buildSource). gridsize ("Magnification") is the C's block-replication grid:
  // the field is rendered at window/gridsize resolution, so larger = bolder,
  // blockier swirls; smaller = finer, busier detail. Default 2 (the xml default).
  const config = {
    speed: 1.0,        // morph-rate multiplier (harness scales iTime)
    scale: 10,         // Scale: noise cells across the screen (xml default)
    iterations: 5,     // Complexity: domain-warp passes (xml default)
    gridsize: 2,       // Magnification: field rendered at window/gridsize res (xml default)
    resolution: 1.0,   // render scale vs devicePixelRatio (1 = crisp, lower = faster)
  };

  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'fast', live: true },
    { key: 'scale', label: 'Scale', type: 'range', min: 1, max: 20, step: 1, default: 10, lowLabel: 'sparse', highLabel: 'dense', live: false },
    { key: 'iterations', label: 'Complexity', type: 'range', min: 1, max: 10, step: 1, default: 5, lowLabel: 'low', highLabel: 'high', live: false },
    { key: 'gridsize', label: 'Magnification', type: 'range', min: 1, max: 20, step: 1, default: 2, lowLabel: 'fine', highLabel: 'bold', live: false },
    { key: 'resolution', label: 'Resolution', type: 'range', min: 0.25, max: 1, step: 0.05, default: 1.0, lowLabel: 'fast', highLabel: 'crisp', live: true },
  ];

  // scale/iterations can't be live uniforms through the unmodified harness, so a
  // change to either (a non-live param -> the host calls reinit()) rebuilds the
  // shadertoy instance with a freshly baked source. Rebuilding also re-rolls the
  // palette -- matching the CPU port, whose init() re-rolled make_smooth_colormap
  // (and the C, which re-rolls on reset). reinit() is debounced so dragging a
  // slider doesn't thrash the WebGL context.
  let inst = startShadertoy(canvas, { source: buildSource(config), config, params, name: 'marbling' });
  let rebuildTimer = 0;
  let paused = false;
  let stopped = false;

  function rebuild() {
    rebuildTimer = 0;
    if (stopped) return;
    inst.stop();
    inst = startShadertoy(canvas, { source: buildSource(config), config, params, name: 'marbling' });
    if (paused) inst.pause();
  }

  return {
    stop() {
      stopped = true;
      if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = 0; }
      inst.stop();
    },
    pause() { paused = true; inst.pause(); },
    resume() { paused = false; inst.resume(); },
    reinit() {
      // Coalesce rapid changes (slider drags, Reset, re-seed) into one rebuild.
      if (rebuildTimer) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(rebuild, 120);
    },
    getStats() { return inst.getStats ? inst.getStats() : undefined; },
    config,
    params,
  };
}
