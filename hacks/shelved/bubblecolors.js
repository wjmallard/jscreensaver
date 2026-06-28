// bubblecolors.js — "Bubble Colors" packaged as a mountable WebGL module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Bubble Colors by Matt Vianueva, 2025 — a tight golfed fragment shader that
// ray-marches a rising column of soft, color-banded blobs, the field churning
// upward forever as cosine ripples sweep tints across it. Originally a
// Shadertoy (https://www.shadertoy.com/view/wcGXWR); xscreensaver 6.x ships it
// as hacks/glx/glsl/bubblecolors.glsl run by its xshadertoy.c harness. Here it
// runs natively on WebGL2 / GLSL ES 3.00 via the shared ./shadertoy.js harness,
// and the shader body is verbatim from the original (kept alongside as
// bubblecolors.glsl). See bubblecolors.md.
//
// Rendering: one full-screen triangle, one fragment-shader pass per frame, no
// textures, no multi-pass buffers. The per-pixel cost (90 march steps, each
// with an inner noise-summation loop) is exactly what makes this a WebGL piece
// and not a canvas2d one — there is no CPU-side simulation at all.

import { startShadertoy } from '../shadertoy.js';

export const title = 'bubblecolors';

export const info = {
  heavy: true,
  author: 'Matt Vianueva',
  description: 'Traveling through a field of bubbles with cartoony colors.\n\nhttps://www.shadertoy.com/view/wcGXWR',
  year: 2025,
};

// Verbatim from hacks/glx/glsl/bubblecolors.glsl (Shadertoy wcGXWR). The whole
// effect is one densely golfed loop; it is left exactly as written. The harness
// adds only a playback-speed multiplier and a render-resolution scale around it.
// iResolution / iTime / iMouse are supplied by the harness preamble.
const SHADER = `
// Title:  Bubble Colors
// Author: Matt Vianueva <diatribes@gmail.com>
// URL:    https://www.shadertoy.com/view/wcGXWR
// Date:   20-Jun-2025
// Desc:   Bubble Colors

void mainImage(out vec4 o, vec2 u)
{
    o = vec4(0,0,0,0);
    float i=0.,r=0.,s=0.,d=0.,n=0.,t=iTime;
    vec3  p = iResolution;
    u = (u-p.xy/2.)/p.y;
    for (o*=i;i++<9e1;
         d += s = .005 + abs(r)*.2,
         o += (1.+cos(.1*p.z+vec4(3,1,0,0))) / s)
        for(p = vec3(u * d, d + t*16.),
            r = 50.-abs(p.y)+ cos(t - dot(u,u) * 6.)*3.3,
            n = .08;
            n < .8;
            n *= 1.4)
            r -= abs(dot(sin(.3*t+.8*p*n), .7 +p-p )) / n;
    o = tanh(o / 2e3);
}
`;

export function start(canvas) {
  // Two harness-level knobs; the shader itself is left untouched.
  const config = {
    speed: 1.0,        // playback-rate multiplier on the churn
    resolution: 1.0,   // render scale vs devicePixelRatio (1 = crisp, lower = faster)
  };

  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'warp', live: true },
    { key: 'resolution', label: 'Resolution', type: 'range', min: 0.25, max: 1, step: 0.05, default: 1.0, lowLabel: 'fast', highLabel: 'crisp', live: true },
  ];

  return startShadertoy(canvas, { source: SHADER, config, params, name: 'bubblecolors' });
}
