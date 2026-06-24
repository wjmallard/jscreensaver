// rigrekt.js — "Rig Rekt" packaged as a mountable WebGL module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Rig Rekt by Matt Vianueva (diatribes), 2026 — a single-pass distance-field
// ray-march down a folding tunnel of nested, recursively rotated boxes, lit by
// a glowing core and warped by layered sine turbulence. Originally a Shadertoy
// (https://www.shadertoy.com/view/3XKfDV), relicensed MIT by permission;
// xscreensaver 6.x ships it as hacks/glx/glsl/rigrekt.glsl run by its
// xshadertoy.c harness. Here it runs natively on WebGL2 / GLSL ES 3.00 via the
// shared ./shadertoy.js harness, and the shader body is verbatim from the
// original (kept alongside as rigrekt.glsl). See rigrekt.md.
//
// Rendering: one full-screen triangle, one fragment-shader pass per frame, no
// textures, no multi-pass buffers. The per-pixel cost (64 march steps, each
// folding a recursive box SDF and accumulating sine turbulence) is exactly what
// makes this a WebGL piece and not a canvas2d one — there is no CPU-side
// simulation at all.

import { startShadertoy } from '../shadertoy.js';

export const title = 'rigrekt';

export const info = {
  heavy: true,
  author: 'Matt Vianueva (diatribes)',
  description: 'Exploring a flooded mega-structure.\n\nhttps://www.shadertoy.com/view/3XKfDV',
  year: 2026,
};

// Verbatim from hacks/glx/glsl/rigrekt.glsl (Shadertoy 3XKfDV, relicensed MIT).
// The author's tuning is left exactly as written; the harness adds only a
// playback-speed multiplier and a render-resolution scale around it.
// iResolution / iTime / iMouse are supplied by the harness preamble.
const SHADER = `
// Title:  Rig Rekt
// Author: Matt Vianueva <diatribes@gmail.com>
// URL:    https://www.shadertoy.com/view/3XKfDV
// Date:   26-Feb-2026
// Desc:   Rig Rekt

// Relicensed as MIT License, by permission, 8-Mar-2026.

#define R(a) mat2(cos(a + vec4(0,33,11,0)))

float tunnel(vec3 p) {
    p = abs(p);
    return 4. - max(p.x, p.y/2.);
}

float box(vec3 p, float i) {
    p = abs(fract(p/i)*i - i/2.) - i*.08;
    return min(p.x, min(p.y, p.z));
}

float boxen(vec3 p) {
    float d = -9e9, i = 1e1;
    p.xy *= R(.5);
    for(; i > .2; i *= .2)
        p.xz *= R(i),
        d = max(d, box(p, i));
    return d;
}

float map(vec3 p) {
    return max(tunnel(p), boxen(p));
}

void mainImage(out vec4 o, vec2 u) {
    o = vec4(0,0,0,0);
    
    float i=0.,d=0.,s=0.,m=0.,k=0.,t = iTime;
    
    vec3 p = iResolution;
    u = (u+u-p.xy)/p.y;
    if (abs(u.y) > .75) { o *=i; return; };

    vec3 D = normalize(vec3(u, 1));
    vec2 v = (.1*sin(iTime))+u + (u.yx*.8+.2-vec2(-1.,.1));

    for(o*=i; i++<64.;) {
        p = D * d;
        p.z += iTime;
        m = map(p);
        
        for(s = .01; s < .4; s += s )
            p += abs(dot(sin(.3*p.z+t+.7*p / s ), vec3(s/4.)));
        
        d += s = min(m, k = .005+.3*abs(p.y+1.5)),
        o += 6e1*vec4(1,1.2,1,0)*s
          + .5*vec4(1,1.1,1,0)/k;
    }
    
    o = tanh(o/1.3e3/exp(d/6e1)/length(v));
}

`;

export function start(canvas) {
  // Two harness-level knobs; the shader's own constants are left untouched.
  const config = {
    speed: 1.0,        // playback-rate multiplier on the fly-through
    resolution: 1.0,   // render scale vs devicePixelRatio (1 = crisp, lower = faster)
  };

  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'warp', live: true },
    { key: 'resolution', label: 'Resolution', type: 'range', min: 0.25, max: 1, step: 0.05, default: 1.0, lowLabel: 'fast', highLabel: 'crisp', live: true },
  ];

  return startShadertoy(canvas, { source: SHADER, config, params, name: 'rigrekt' });
}
