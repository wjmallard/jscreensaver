// trizm.js — "Trizm" packaged as a mountable WebGL module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Trizm by Matt Vianueva, 2025 — a triangle-wave raymarcher: a forward fly
// through a neon corridor where arcsin(sin(x)) triangle waves fold space into
// glowing trizm lattices lit by plasma highlights. Originally a Shadertoy
// (https://www.shadertoy.com/view/3fcBD8), relicensed MIT by permission;
// xscreensaver 6.x ships it as hacks/glx/glsl/trizm.glsl run by its
// xshadertoy.c harness. Here it runs natively on WebGL2 / GLSL ES 3.00 via the
// shared ./shadertoy.js harness, and the shader body is verbatim from the
// original (kept alongside as trizm.glsl). See trizm.md.
//
// Rendering: one full-screen triangle, one fragment-shader pass per frame, no
// textures, no multi-pass buffers. The per-pixel cost (20 raymarch steps, each
// with a 3-iteration triangle-wave fold) is exactly what makes this a WebGL
// piece and not a canvas2d one — there is no CPU-side simulation at all.

import { startShadertoy } from './shadertoy.js';

export const title = 'trizm';

export const info = {
  author: 'Matt Vianueva',
  description: 'Neon cyber circuit-board-like triangle waves.\n\nhttps://www.shadertoy.com/view/3fcBD8',
  year: 2025,
};

// Verbatim from hacks/glx/glsl/trizm.glsl (Shadertoy 3fcBD8, MIT by permission).
// The author's tuning is left exactly as-is; the harness adds only a
// playback-speed multiplier and a render-resolution scale around it.
// iResolution / iTime / iMouse are supplied by the harness preamble.
const SHADER = `
// Title:  Trizm
// Author: Matt Vianueva <diatribes@gmail.com>
// URL:    https://www.shadertoy.com/view/3fcBD8
// Date:   14-Dec-2025
// Desc:   Trizm

// Relicensed as MIT License, by permission, 8-Mar-2026.

/*
    I thought @OldEclipse's "Cyber Conduits"
    was so cool I had to play with triangle
    waves more.
    
    @OldEclipse - "Cyber Conduits"
        https://www.shadertoy.com/view/tf3fR7

    Can also use them to create cool surfaces:
        https://www.shadertoy.com/view/tXX3RX

    Which was learned from @Shane's "Abstract Corridor":
        https://www.shadertoy.com/view/MlXSWX

    See also forked shader here for similar thing to this shader:
        https://www.shadertoy.com/view/3ftBWr

*/

void mainImage(out vec4 o, vec2 u) {

    o = vec4(0,0,0,0);
    float i=0., // raymarch iterator
          s=0., // sample distance
          t = iTime * .5,
          d = .05*dot(fract(sin(u)), sin(u))
            + (9.+2.*sin(t)); // total distance, modulate starting point
          
    vec3  p,r = iResolution;
    
    // 20 iterations
    for (o *= i; i++ < 2e1; ) {
        // get position
        p = vec3((u+u-r.xy)/r.y * d, d );
        
        // spin by time, twist by dist
        p.xy *= mat2(cos(.1*p.z+.1*t+vec4(0,33,11,0)));

        // triangle wave distortion loop
        // arcsin(sin(x)) makes a triangle wave
        for(s=0.; s++<3.;)
            p.xy -= asin(sin(.6*t+p.yx*s))/s;

        // accumulate distance to a triangle wave
        // based on p, which has been distorted by tri waves above,
        // this triangle wave is done using fract
        d += s =  dot(abs(fract(p)-.5), vec3(.08));

        // accumulate color
        o += 14./s + (1e1*(1.+cos(p.y*.1+p.z+vec4(3,1,0,0)))/s)
            // plasma'ish lights
          * abs(1. / dot(cos(t+t+p*.35),vec3(1)));
    }
    // tanh tonemap, brightness
    o = tanh(o/3e4);
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

  return startShadertoy(canvas, { source: SHADER, config, params, name: 'trizm' });
}
