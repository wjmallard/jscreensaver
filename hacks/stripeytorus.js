// stripeytorus.js — "Saturday Torus" packaged as a mountable WebGL module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Saturday Torus by mrange, 2021 — an analytic ray-traced torus wrapped in
// scrolling black-and-white stripes, lit and self-shadowing, that twists as
// the bands flow around it. Originally a Shadertoy (https://www.shadertoy.com/
// view/fd33zn), CC0-licensed; xscreensaver 6.x ships it as
// hacks/glx/glsl/stripeytorus.glsl run by its xshadertoy.c harness. Here it
// runs natively on WebGL2 / GLSL ES 3.00 via the shared ./shadertoy.js harness,
// and the shader body is verbatim from the original (kept alongside as
// stripeytorus.glsl). See stripeytorus.md.
//
// Rendering: one full-screen triangle, one fragment-shader pass per frame, no
// textures, no multi-pass buffers. Each pixel solves a quartic for the
// ray/torus intersection (plus a second solve for the shadow ray) — that
// closed-form per-pixel work is what makes this a WebGL piece, with no
// CPU-side simulation at all.

import { startShadertoy } from './shadertoy.js';

export const title = 'stripeytorus';

export const info = {
  author: 'mrange',
  description: 'The stylish interior of a torus.\n\nhttps://www.shadertoy.com/view/fd33zn',
  year: 2021,
};

// Verbatim from hacks/glx/glsl/stripeytorus.glsl (Shadertoy fd33zn, CC0). The
// author's #define'd parameters are left exactly as tuned; the harness adds
// only a playback-speed multiplier and a render-resolution scale around it.
// iResolution / iTime / iMouse are supplied by the harness preamble.
const SHADER = `// Title:  Saturday Torus
// Author: mrange
// URL:    https://www.shadertoy.com/view/fd33zn
// Date:   14-Aug-2021
// Desc:   License CC0: Saturday Torus
// Inspired by: https://www.istockphoto.com/photo/black-and-white-stripes-projection-on-torus-gm488221403-39181884

// License CC0: Saturday Torus
//  Inspired by: https://www.istockphoto.com/photo/black-and-white-stripes-projection-on-torus-gm488221403-39181884

#define PI          3.141592654
#define TAU         (2.0*PI)
#define TIME        iTime
#define TTIME       (TAU*TIME)
#define RESOLUTION  iResolution
#define ROT(a)      mat2(cos(a), sin(a), -sin(a), cos(a))
#define PCOS(x)     (0.5+0.5*cos(x))

// License: MIT, author: Inigo Quilez, found: https://iquilezles.org/articles/intersectors
float rayTorus(vec3 ro, vec3 rd, vec2 tor) {
  float po = 1.0;

  float Ra2 = tor.x*tor.x;
  float ra2 = tor.y*tor.y;

  float m = dot(ro,ro);
  float n = dot(ro,rd);

  // bounding sphere
  {
    float h = n*n - m + (tor.x+tor.y)*(tor.x+tor.y);
    if(h<0.0) return -1.0;
    //float t = -n-sqrt(h); // could use this to compute intersections from ro+t*rd
  }

  // find quartic equation
  float k = (m - ra2 - Ra2)/2.0;
  float k3 = n;
  float k2 = n*n + Ra2*rd.z*rd.z + k;
  float k1 = k*n + Ra2*ro.z*rd.z;
  float k0 = k*k + Ra2*ro.z*ro.z - Ra2*ra2;

  #ifndef TORUS_REDUCE_PRECISION
  // prevent |c1| from being too close to zero
  if(abs(k3*(k3*k3 - k2) + k1) < 0.01)
  {
    po = -1.0;
    float tmp=k1; k1=k3; k3=tmp;
    k0 = 1.0/k0;
    k1 = k1*k0;
    k2 = k2*k0;
    k3 = k3*k0;
  }
  #endif

  float c2 = 2.0*k2 - 3.0*k3*k3;
  float c1 = k3*(k3*k3 - k2) + k1;
  float c0 = k3*(k3*(-3.0*k3*k3 + 4.0*k2) - 8.0*k1) + 4.0*k0;


  c2 /= 3.0;
  c1 *= 2.0;
  c0 /= 3.0;

  float Q = c2*c2 + c0;
  float R = 3.0*c0*c2 - c2*c2*c2 - c1*c1;

  float h = R*R - Q*Q*Q;
  float z = 0.0;
  if(h < 0.0) {
    // 4 intersections
    float sQ = sqrt(Q);
    z = 2.0*sQ*cos(acos(R/(sQ*Q)) / 3.0);
  } else {
    // 2 intersections
    float sQ = pow(sqrt(h) + abs(R), 1.0/3.0);
    z = sign(R)*abs(sQ + Q/sQ);
  }
  z = c2 - z;

  float d1 = z   - 3.0*c2;
  float d2 = z*z - 3.0*c0;
  if(abs(d1) < 1.0e-4) {
    if(d2 < 0.0) return -1.0;
    d2 = sqrt(d2);
  } else {
    if(d1 < 0.0) return -1.0;
    d1 = sqrt(d1/2.0);
    d2 = c1/d1;
  }

  //----------------------------------

  float result = 1e20;

  h = d1*d1 - z + d2;
  if(h > 0.0) {
    h = sqrt(h);
    float t1 = -d1 - h - k3; t1 = (po<0.0)?2.0/t1:t1;
    float t2 = -d1 + h - k3; t2 = (po<0.0)?2.0/t2:t2;
    if(t1 > 0.0) result=t1;
    if(t2 > 0.0) result=min(result,t2);
  }

  h = d1*d1 - z - d2;
  if(h > 0.0) {
    h = sqrt(h);
    float t1 = d1 - h - k3;  t1 = (po<0.0)?2.0/t1:t1;
    float t2 = d1 + h - k3;  t2 = (po<0.0)?2.0/t2:t2;
    if(t1 > 0.0) result=min(result,t1);
    if(t2 > 0.0) result=min(result,t2);
  }

  return result;
}

// License: MIT, author: Inigo Quilez, found: https://iquilezles.org/articles/intersectors
vec3 torusNormal(vec3 pos, vec2 tor) {
  return normalize(pos*(dot(pos,pos)- tor.y*tor.y - tor.x*tor.x*vec3(1.0,1.0,-1.0)));
}

// License: Unknown, author: Unknown, found: don't remember
float tanh_approx(float x) {
  //  Found this somewhere on the interwebs
  //  return tanh(x);
  float x2 = x*x;
  return clamp(x*(27.0 + x2)/(27.0+9.0*x2), -1.0, 1.0);
}

vec3 color(vec2 p, vec2 q) {
  const float rdd = 2.0;
  vec3 ro  = 1.*vec3(0., 0.75, -0.2);
  vec3 la  = vec3(0.0, 0.0, 0.2);
  vec3 up  = vec3(0.3, 0.0, 1.0);
  vec3 lp1 = ro;
  lp1.xy  *= ROT(0.85);
  lp1.xz  *= ROT(-0.5);

  vec3 ww = normalize(la - ro);
  vec3 uu = normalize(cross(up, ww));
  vec3 vv = normalize(cross(ww,uu));
  vec3 rd = normalize(p.x*uu + p.y*vv + rdd*ww);

  const vec2 tor = 0.55*vec2(1.0, 0.75);
  float td    = rayTorus(ro, rd, tor);
  vec3  tpos  = ro + rd*td;
  vec3  tnor  = -torusNormal(tpos, tor);
  vec3  tref  = reflect(rd, tnor);

  vec3  ldif1 = lp1 - tpos;
  float ldd1  = dot(ldif1, ldif1);
  float ldl1  = sqrt(ldd1);
  vec3  ld1   = ldif1/ldl1;
  vec3  sro   = tpos+0.05*tnor;
  float sd    = rayTorus(sro, ld1, tor);
  vec3  spos  = sro+ld1*sd;
  vec3  snor  = -torusNormal(spos, tor);

  float dif1  = max(dot(tnor, ld1), 0.0);
  float spe1  = pow(max(dot(tref, ld1), 0.0), 10.0);
  float r     = length(tpos.xy);
  float a     = atan(tpos.y, tpos.x)-PI*tpos.z/(r+0.5*abs(tpos.z))-TTIME/45.0;
  float s     = mix(0.05, 0.5, tanh_approx(2.0*abs(td-0.75)));
  vec3  bcol0 = vec3(0.3);  
  vec3  bcol1 = vec3(0.025);  
  vec3  tcol  = mix(bcol0, bcol1, smoothstep(-s, s, sin(9.0*a)));

  vec3 col = vec3(0.0);

  if (td > -1.0) {
    col += tcol*mix(0.2, 1.0, dif1/ldd1)+0.25*spe1;
    col *= sqrt(abs(dot(rd, tnor)));
  }
  
  if (sd < ldl1) {
    col *= mix(1.0, 0.0, pow(abs(dot(ld1, snor)), 3.0*tanh_approx(sd)));
  }

  return col;
}

// License: MIT, author: Inigo Quilez, found: https://iquilezles.org/www/index.htm
vec3 postProcess(vec3 col, vec2 q) {
  col = clamp(col, 0.0, 1.0);
  col = pow(col, 1.0/vec3(2.2));
  col = col*0.6+0.4*col*col*(3.0-2.0*col);
  col = mix(col, vec3(dot(col, vec3(0.33))), -0.4);
  col *=0.5+0.5*pow(19.0*q.x*q.y*(1.0-q.x)*(1.0-q.y),0.7);
  return col;
}

void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
  vec2 q = fragCoord/iResolution.xy;
  vec2 p = -1. + 2. * q;
  p.x *= RESOLUTION.x/RESOLUTION.y;
  vec3 col = color(p, q);
  col = postProcess(col, q);
  fragColor = vec4(col, 1.0);
}

`;

export function start(canvas) {
  // Two harness-level knobs; the shader's own #defines are left untouched.
  const config = {
    speed: 1.0,        // playback-rate multiplier on the stripe flow
    resolution: 1.0,   // render scale vs devicePixelRatio (1 = crisp, lower = faster)
  };

  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'warp', live: true },
    { key: 'resolution', label: 'Resolution', type: 'range', min: 0.25, max: 1, step: 0.05, default: 1.0, lowLabel: 'fast', highLabel: 'crisp', live: true },
  ];

  return startShadertoy(canvas, { source: SHADER, config, params, name: 'stripeytorus' });
}
