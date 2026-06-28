// logarithmiccircles.js -- "B/W logarithmic circles II" as a mountable WebGL module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// B/W logarithmic circles II by mrange, 2023 -- a black-and-white field of
// circular rings laid out on a logarithmic (exp2) radial grid, eight-fold
// mirrored and slowly counter-rotated, the rings scaling outward so the pattern
// breathes self-similarly forever. Originally a Shadertoy (https://www.shadertoy
// .com/view/mljcWR), released CC0; xscreensaver 6.x ships it as
// hacks/glx/glsl/logarithmiccircles.glsl run by its xshadertoy.c harness. Here it
// runs natively on WebGL2 / GLSL ES 3.00 via the shared ./shadertoy.js harness,
// and the shader body is verbatim from the original (kept alongside as
// logarithmiccircles.glsl). See logarithmiccircles.md.
//
// Rendering: one full-screen triangle, one fragment-shader pass per frame, no
// textures, no multi-pass buffers. All the structure is computed per-pixel in
// the shader (log/exp radial remap + polar fold); there is no CPU-side
// simulation at all.

import { startShadertoy } from './shadertoy.js';

export const title = 'logarithmiccircles';

export const info = {
  author: 'mrange',
  description: 'Zooming black and white circles.\n\nhttps://www.shadertoy.com/view/mljcWR',
  year: 2023,
};

// Verbatim from hacks/glx/glsl/logarithmiccircles.glsl (Shadertoy mljcWR, CC0).
// The author's tuning constants are left exactly as written; the harness adds
// only a playback-speed multiplier and a render-resolution scale around it.
// iResolution / iTime / iMouse are supplied by the harness preamble.
const SHADER = `
// CC0: B/W logarithmic circles II
// Tweaking on an old shader on the bus.

#define TIME        iTime
#define RESOLUTION  iResolution
#define PI          3.141592654
#define TAU         (2.0*PI)
#define ROT(a)      mat2(cos(a), sin(a), -sin(a), cos(a))

// Carefully fine tuned. No thinking involved.
const float ExpBy   = log2(4.1);
const float Radius  = 0.3175;
  
float forward(float l) {
  return exp2(ExpBy*l);
}

float reverse(float l) {
  return log2(l)/ExpBy;
}

float modPolar(inout vec2 p, float repetitions) {
  float angle = TAU/repetitions;
  float a = atan(p.y, p.x) + angle/2.;
  float r = length(p);
  float c = floor(a/angle);
  a = mod(a,angle) - angle/2.;
  p = vec2(cos(a), sin(a))*r;
  // For an odd number of repetitions, fix cell index of the cell in -x direction
  // (cell index would be e.g. -5 and 5 in the two halves of the cell):
  if (abs(c) >= (repetitions/2.0)) c = abs(c);
  return c;
}

vec3 effect(vec2 p) {
  float aa = 4.0/RESOLUTION.y;
  vec3 col = vec3(0.1*smoothstep(-sqrt(0.5), sqrt(0.5), sin(0.5*TAU*p.y/aa)));
  
  float tm = 0.2*TIME;
  mat2 rot0 = ROT(-0.5*tm); 
  for (float i = 0.0; i < 2.0; ++i) {
    float ltm = tm+0.5*i;
    mat2 rot1 = ROT(i*0.5*TAU/8.0);
    float mtm = fract(ltm);
    float ntm = floor(ltm);
    float zz = forward(mtm);
  
    vec2 p0 = p;
    p0 *= rot0;
    p0 *= rot1;
    p0 /= zz;
  
    float l0 = length(p0);
    
    float n0 = ceil(reverse(l0));
    float r0 = forward(n0);
    float r1 = forward(n0-1.0);
    float r = (r0+r1)/2.0;
    float w = r0-r1;
    float nn = n0;
    n0 -= ntm;
    vec2 p1 = p0;
    float n1 = modPolar(p1, 8.0);
    p1.x -= r;
  
    float a = 0.5*ltm+n1/8.0;
    a = fract(a);
    float d1 = length(p1)-Radius*w;
    float d2 = length(p1)-Radius*w*smoothstep(0.0, 0.45, mod(a, 0.5));
    d1 *= zz;
    d2 *= zz;
    vec3 ccol = vec3(1.0)*smoothstep(0.0, -aa, d2);
    if (a >= 0.5) ccol = 1.0-ccol;
    col = mix(col, ccol, smoothstep(0.0, -aa, d1));
  }
  col = sqrt(col);
  return col;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
  vec2 q = fragCoord/iResolution.xy;
  vec2 p = -1. + 2. * q;
  p.x *= RESOLUTION.x/RESOLUTION.y;
  vec3 col = effect(p);
  
  fragColor = vec4(col, 1.0);
}


`;

export function start(canvas) {
  // Two harness-level knobs; the shader's own constants are left untouched.
  const config = {
    speed: 1.0,        // playback-rate multiplier on the animation
    resolution: 1.0,   // render scale vs devicePixelRatio (1 = crisp, lower = faster)
  };

  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'warp', live: true },
    { key: 'resolution', label: 'Resolution', type: 'range', min: 0.25, max: 1, step: 0.05, default: 1.0, lowLabel: 'fast', highLabel: 'crisp', live: true },
  ];

  return startShadertoy(canvas, { source: SHADER, config, params, name: 'logarithmiccircles' });
}
