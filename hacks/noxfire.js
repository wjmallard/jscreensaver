// noxfire.js -- "Nox Fire" packaged as a mountable WebGL module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Nox Fire by Matt Vianueva, 2025 -- a tight per-pixel ray-march down a
// pulsing, twisting tunnel of noise that reads as living flame rushing past.
// Originally a Shadertoy (https://www.shadertoy.com/view/wfG3Dz), relicensed
// MIT by permission; xscreensaver 6.x ships it as hacks/glx/glsl/noxfire.glsl
// run by its xshadertoy.c harness. Here it runs natively on WebGL2 / GLSL ES
// 3.00 via the shared ./shadertoy.js harness, and the shader body is verbatim
// from the original (kept alongside as noxfire.glsl). See noxfire.md.
//
// Rendering: one full-screen triangle, one fragment-shader pass per frame, no
// textures, no multi-pass buffers. The per-pixel cost (100 march steps, each
// with an inner noise loop) is exactly what makes this a WebGL piece and not a
// canvas2d one -- there is no CPU-side simulation at all.

import { startShadertoy } from './shadertoy.js';

export const title = 'noxfire';

export const info = {
  author: 'Matt Vianueva',
  description: 'I fell in to a burning ring of fire; I went down, down, down and the flames went higher.\n\nhttps://www.shadertoy.com/view/wfG3Dz',
  year: 2025,
};

// Verbatim from hacks/glx/glsl/noxfire.glsl (Shadertoy wfG3Dz, MIT). The
// shader body is left exactly as written; the harness adds only a playback-
// speed multiplier and a render-resolution scale around it. iResolution /
// iTime / iMouse are supplied by the harness preamble.
const SHADER = `
// Title:  Nox Fire
// Author: Matt Vianueva <diatribes@gmail.com>
// URL:    https://www.shadertoy.com/view/wfG3Dz
// Date:   24-May-2025
// Desc:   Nox Fire

// Relicensed as MIT License, by permission, 8-Mar-2026.

/*

    -4 from FabriceNeyret2
    
    Thanks :D !

*/

void mainImage(out vec4 o, vec2 u) {
    o = vec4(0,0,0,0);
    float i=0., d=0., s=0., n=0., t=iTime;
    vec3 p = iResolution;
    u = (u-p.xy/2.)/p.y;
    for(o*=i; i++<1e2; ) {
        // march, p = ro + rd * d, p.z += t*4;
        p = vec3(u * d, d + t*4.);
        // turbulence
        p += cos(p.z+t+p.yzx*.5)*.6;
        // modulate tunnel radius
        s = 4.+sin(t*.7)*4.-length(p.xy);
        // rotate
        p.xy *= mat2(cos(t+vec4(0,33,11,0)));
        // noise loop
        for (n = 1.6; n < 32.; n += n )
            // subtract noise from tunnel dist
            s -= abs(dot(sin( p.z + t + p*n ), vec3(1.12))) / n;
        // accumulate distance
        d += s = .01 + abs(s)*.1;
        // grayscale color
        o += 1. / s;
    }
    // o*o to increase saturation,
    // divide by d for depth
    // colorize
    o = tanh(vec4(5,2,1,1) * o * o / d / 2e6);
}


/* Original

void mainImage(out vec4 o, vec2 u) {
    float i, d, s, n, f, t=iTime;
    vec3 p = iResolution;
    u = (u-p.xy/2.)/p.y;
    for(o*=i; i++<1e2; ) {
        // march, p = ro + rd * d, p.z += t*4;
        p = vec3(u * d, d + t*4.);
        // turbulence
        p += cos(p.z+t+p.yzx*.5)*.6;
        // modulate tunnel radius
        s = 4.+sin(t*.7)*4.-length(p.xy);
        // rotate
        p.xy *= mat2(cos(t+vec4(0,33,11,0)));
        // noise loop
        for (n = .1; n < 2.;
            // subtract noise from tunnel dist
            s -= abs(dot(sin(p.z+t+p * n * 16.), vec3( .07))) / n,
            // grow noise
            n += n);
        // accumulate distance
        d += s = .01 + abs(s)*.1;
        // grayscale color
        o += 1. / s;
    }
    // o*o to increase saturation,
    // divide by d for depth
    // colorize
    o = tanh(vec4(5,2,1,1) * o * o / d / 2e6);
}

*/
`;

export function start(canvas) {
  // Two harness-level knobs; the shader body is left untouched.
  const config = {
    speed: 1.0,        // playback-rate multiplier on the fly-through
    resolution: 1.0,   // render scale vs devicePixelRatio (1 = crisp, lower = faster)
  };

  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'warp', live: true },
    { key: 'resolution', label: 'Resolution', type: 'range', min: 0.25, max: 1, step: 0.05, default: 1.0, lowLabel: 'fast', highLabel: 'crisp', live: true },
  ];

  return startShadertoy(canvas, { source: SHADER, config, params, name: 'noxfire' });
}
