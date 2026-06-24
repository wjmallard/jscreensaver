// universeball.js - "Universe Ball 2" packaged as a mountable WebGL module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Universe Ball 2 by Matt Vianueva, 2025 - a ray-marched, palette-cycled glass
// orb suspended in a star-flecked void, inspired by Jaenam's gem shaders.
// Originally a Shadertoy (https://www.shadertoy.com/view/WcGcWV), relicensed
// MIT; xscreensaver 6.x ships it as hacks/glx/glsl/universeball.glsl run by its
// xshadertoy.c harness. Here it runs natively on WebGL2 / GLSL ES 3.00 via the
// shared ./shadertoy.js harness, and the shader body is verbatim from the
// original (kept alongside as universeball.glsl). See universeball.md.
//
// Rendering: one full-screen triangle, one fragment-shader pass per frame, no
// textures, no multi-pass buffers. The per-pixel cost (a 50-step ray-march with
// a nested folding loop) is exactly what makes this a WebGL piece and not a
// canvas2d one - there is no CPU-side simulation at all.

import { startShadertoy } from '../shadertoy.js';

export const title = 'universeball';

export const info = {
  heavy: true,
  author: 'Matt Vianueva',
  description: 'A mysterious orb is surrounded by clouds.\n\nhttps://www.shadertoy.com/view/WcGcWV',
  year: 2025,
};

// Verbatim from hacks/glx/glsl/universeball.glsl (Shadertoy WcGcWV, MIT). The
// author's single #define palette is left exactly as tuned; the harness adds
// only a playback-speed multiplier and a render-resolution scale around it.
// iResolution / iTime / iMouse are supplied by the harness preamble.
const SHADER = `
// Title:  Universe Ball 2
// Author: Matt Vianueva <diatribes@gmail.com>
// URL:    https://www.shadertoy.com/view/WcGcWV
// Date:   08-Dec-2025
// Desc:   Universe Ball 2

// Relicensed as MIT License, by permission, 8-Mar-2026.

// inspired by @Jaenam's gem shaders
// e.g., https://www.shadertoy.com/view/t3SyzV

// can play with color here
#define PALETTE vec3(6,4,2)

void mainImage(out vec4 o, vec2 u) {
    float n,i,s,t=iTime*.2, d,v;
    vec3  q,p = iResolution, c;
    u = (u+u-p.xy)/p.y;
    vec2 l = u - (u.yx*.9+.3-vec2(-.35,.15));    

    c = vec3(0);  // jwz
    d = 0.;
    i = 0.;

    for(; i++ < 5e1 && d < 5e1;
        d += s = min(q.y=.01+.6*abs(24. - length(q.xy)),
                     v = max(s, dot(abs(fract(p)-.5), vec3(.04)))),
        c +=(1.+cos(p.z+PALETTE))/v
          +  d*vec3(5,2,1)/q.y/1e1
          +  7.*vec3(3,4,1)/length(l)
    )
        for(q = p = vec3(u * d, d - 16.),
            s = length(p)-8.,
            p.xy *= mat2(cos(t+p.z*.6+vec4(0,33,11,0))),
            p += cos(t+p.zxy)+cos(t+p.yzx*s)/s/4.,
            p += .5*cos(t+dot(cos(t+p), p) *  p),
            n = .02; n < 2.; n *= 1.6
        )
            q.y -= abs(dot(sin(4.*t+.3*q / n ), q-q+n));

    c = mix(c, c.yzx, smoothstep(2., .1, length(u)*1.));
    o.rgb = tanh(c*c/6e7/length(u-.3)+.1*length(u));
}
`;

export function start(canvas) {
  // Two harness-level knobs; the shader's own #defines are left untouched.
  const config = {
    speed: 1.0,        // playback-rate multiplier on the fly-through
    resolution: 1.0,   // render scale vs devicePixelRatio (1 = crisp, lower = faster)
  };

  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'warp', live: true },
    { key: 'resolution', label: 'Resolution', type: 'range', min: 0.25, max: 1, step: 0.05, default: 1.0, lowLabel: 'fast', highLabel: 'crisp', live: true },
  ];

  return startShadertoy(canvas, { source: SHADER, config, params, name: 'universeball' });
}
