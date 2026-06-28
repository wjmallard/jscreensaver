// downfall.js -- "Downfall" packaged as a mountable WebGL module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Downfall by Matt Vianueva (diatribes@gmail.com), 2025 -- a tiny ray-march
// down a churning, tunnel-like cascade: sine-warped space folds into bright
// falling sheets that streak past the camera. Originally a Shadertoy
// (https://www.shadertoy.com/view/w3sBWl), relicensed MIT by permission;
// xscreensaver 6.x ships it as hacks/glx/glsl/downfall.glsl run by its
// xshadertoy.c harness. Here it runs natively on WebGL2 / GLSL ES 3.00 via the
// shared ./shadertoy.js harness, and the shader body is verbatim from the
// original (kept alongside as downfall.glsl). See downfall.md.
//
// Rendering: one full-screen triangle, one fragment-shader pass per frame, no
// textures, no multi-pass buffers. The per-pixel cost (100 march steps, each
// folding space with an inner sine loop) is exactly what makes this a WebGL
// piece and not a canvas2d one -- there is no CPU-side simulation at all.

import { startShadertoy } from './shadertoy.js';

export const title = 'downfall';

export const info = {
  author: 'Matt Vianueva',
  description: 'A close-up view of a grayscale waterfall.\n\nhttps://www.shadertoy.com/view/w3sBWl',
  year: 2025,
};

// Verbatim from hacks/glx/glsl/downfall.glsl (Shadertoy w3sBWl, MIT). The
// author's golfed body is left exactly as written; the harness adds only a
// playback-speed multiplier and a render-resolution scale around it.
// iResolution / iTime / iMouse are supplied by the harness preamble.
const SHADER = `
// Title:  Downfall
// Author: Matt Vianueva <diatribes@gmail.com>
// URL:    https://www.shadertoy.com/view/w3sBWl
// Date:   01-Nov-2025
// Desc:   Downfall

// Relicensed as MIT License, by permission, 8-Mar-2026.

void mainImage(out vec4 o, vec2 u) {
    
    o = vec4(0,0,0,0);
    float i=0.,d=0.,s=0.,t = iTime;
    
    vec3 p = iResolution;
    mat2 r = mat2(cos(1.2+vec4(0,33,11,0)));
    
    u = (u+u-p.xy)/p.y;
    
    for(o=vec4(0); i++<1e2;) {
        p = vec3(u * d, d-24.),
        p.yz *= r;
        p.z += t*3e1;
        
        for(s = .03; s < 4.; s += s )
            p.yz -= abs(dot(sin(t+t+.32*p / s ), vec3(s)));
        
        p *= vec3(.2, .6, 1),
        d += s = .3+.3*abs(2. - length(p.xy)),
        o += 1./s;
    }
    
    o = tanh(o*o/1e4);

}

`;

export function start(canvas) {
  // Two harness-level knobs; the shader's own constants are left untouched.
  const config = {
    speed: 1.0,        // playback-rate multiplier on the fall-through
    resolution: 1.0,   // render scale vs devicePixelRatio (1 = crisp, lower = faster)
  };

  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'warp', live: true },
    { key: 'resolution', label: 'Resolution', type: 'range', min: 0.25, max: 1, step: 0.05, default: 1.0, lowLabel: 'fast', highLabel: 'crisp', live: true },
  ];

  return startShadertoy(canvas, { source: SHADER, config, params, name: 'downfall' });
}
