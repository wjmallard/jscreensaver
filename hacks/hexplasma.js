// hexplasma.js -- "Hexagon Plasma" packaged as a mountable WebGL module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Hexagon Plasma by Nemerix, 2025 -- a flowing plasma whose domain is warped
// through a hexagonal signed-distance field and then folded by four turns of a
// sin/rotate feedback loop, glowing in teal-to-white where the field thins to
// zero. Originally a Shadertoy (https://www.shadertoy.com/view/3fy3z3),
// MIT-licensed; xscreensaver 6.x ships it as hacks/glx/glsl/hexplasma.glsl run
// by its xshadertoy.c harness. Here it runs natively on WebGL2 / GLSL ES 3.00
// via the shared ./shadertoy.js harness, and the shader body is verbatim from
// the original (kept alongside as hexplasma.glsl). See hexplasma.md.
//
// Rendering: one full-screen triangle, one fragment-shader pass per frame, no
// textures, no multi-pass buffers. The whole image is evaluated per pixel from
// iResolution / iTime alone -- there is no CPU-side simulation at all.

import { startShadertoy } from './shadertoy.js';

export const title = 'hexplasma';

export const info = {
  author: 'Nemerix',
  description: 'A hexagon in a plasma field.\n\nhttps://www.shadertoy.com/view/WfS3Dd',
  year: 2025,
};

// Verbatim from hacks/glx/glsl/hexplasma.glsl (Shadertoy 3fy3z3, MIT). The
// author's constants are left exactly as tuned; the harness adds only a
// playback-speed multiplier and a render-resolution scale around it.
// iResolution / iTime / iMouse are supplied by the harness preamble.
const SHADER = `
// Title:  Hexagon Plasma
// Author: Nemerix
// URL:    https://www.shadertoy.com/view/3fy3z3
// Date:   26-May-2025
// Desc:   Heavily inspired by https://www.shadertoy.com/view/WfS3Dd
// 
// I put this together after poking at it for a few hours, to make sure I actually learned something from it. :D

// Shader by Nemerix, 2025-05-26.
// Code made available under the MIT license.

float sqr(float x) { return x*x; }

float hexSdf(in vec2 pos)
{
    return max(max(abs(dot(pos, vec2(0,2))), abs(dot(pos, vec2(1.732,1)))), abs(dot(pos, vec2(1.732,-1))));
}

float smoothSdf(in vec2 pos)
{
    return mix(sqr(hexSdf(pos)), dot(pos, pos), smoothstep(0.8, 1.5, dot(pos, pos)));
}

float sfield(in vec2 s)
{
    return s.x * s.y;
}

vec3 cmap(in vec2 pos)
{
    return mix(vec3(0.1,0.6,0.8), vec3(0.5), 0.7 * tanh(dot(pos, pos)));
}

const mat2 R = mat2(0.6, 0.8, -0.8, 0.6);

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
    
    float d = smoothSdf(uv) - 1.0;
    d = sqrt(abs(d));
    
    vec2 samp = uv * d;
    float y = 0.0;
    float scale = 1.0;
    
    for (int i = 0; i < 4; ++i)
    {
        samp = sin(R * samp * hexSdf(samp) + vec2(iTime));
        y += scale * sfield(samp);
        scale *= 0.75;
    }
    
    vec3 col = cmap(uv) / abs(y);
    col = tanh(0.1 * col);
    fragColor = vec4(col, 1);
}
`;

export function start(canvas) {
  // Two harness-level knobs; the shader's own constants are left untouched.
  const config = {
    speed: 1.0,        // playback-rate multiplier on the plasma's evolution
    resolution: 1.0,   // render scale vs devicePixelRatio (1 = crisp, lower = faster)
  };

  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'warp', live: true },
    { key: 'resolution', label: 'Resolution', type: 'range', min: 0.25, max: 1, step: 0.05, default: 1.0, lowLabel: 'fast', highLabel: 'crisp', live: true },
  ];

  return startShadertoy(canvas, { source: SHADER, config, params, name: 'hexplasma' });
}
