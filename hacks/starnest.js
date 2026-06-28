// starnest.js — "Star Nest" packaged as a mountable WebGL module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Star Nest by Pablo Roman Andrioli ("Kali"), 2013 — a volumetric ray-march
// through a folded 3D Kaliset fractal that reads as an endless drift through
// stars and nebulae. Originally a Shadertoy (https://www.shadertoy.com/view/
// XlfGRj), MIT-licensed; xscreensaver 6.x ships it as hacks/glx/glsl/starnest.glsl
// run by its xshadertoy.c harness. Here it runs natively on WebGL2 / GLSL ES
// 3.00 via the shared ./shadertoy.js harness, and the shader body is verbatim
// from the original (kept alongside as starnest.glsl). See starnest.md.
//
// Rendering: one full-screen triangle, one fragment-shader pass per frame, no
// textures, no multi-pass buffers. The per-pixel cost (20 volume steps x 17
// fractal iterations) is exactly what makes this a WebGL piece and not a
// canvas2d one — there is no CPU-side simulation at all.

import { startShadertoy } from './shadertoy.js';

export const title = 'starnest';

export const info = {
  author: 'Pablo Roman Andrioli (Kali)',
  description: 'A star field via 3D kaliset fractal and volumetric rendering.\n\nhttps://www.shadertoy.com/view/XlfGRj',
  year: 2013,
};

// Verbatim from hacks/glx/glsl/starnest.glsl (Shadertoy XlfGRj, MIT). The
// author's #define'd parameters are left exactly as tuned; the harness adds
// only a playback-speed multiplier and a render-resolution scale around it.
// iResolution / iTime / iMouse are supplied by the harness preamble.
const SHADER = `
// Star Nest by Pablo Roman Andrioli
// License: MIT

#define iterations 17
#define formuparam 0.53

#define volsteps 20
#define stepsize 0.1

#define zoom   0.800
#define tile   0.850
#define speed  0.010

#define brightness 0.0015
#define darkmatter 0.300
#define distfading 0.730
#define saturation 0.850

void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
	//get coords and direction
	vec2 uv=fragCoord.xy/iResolution.xy-.5;
	uv.y*=iResolution.y/iResolution.x;
	vec3 dir=vec3(uv*zoom,1.);
	float time=iTime*speed+.25;

	//mouse rotation
	float a1=.5+iMouse.x/iResolution.x*2.;
	float a2=.8+iMouse.y/iResolution.y*2.;
	mat2 rot1=mat2(cos(a1),sin(a1),-sin(a1),cos(a1));
	mat2 rot2=mat2(cos(a2),sin(a2),-sin(a2),cos(a2));
	dir.xz*=rot1;
	dir.xy*=rot2;
	vec3 from=vec3(1.,.5,0.5);
	from+=vec3(time*2.,time,-2.);
	from.xz*=rot1;
	from.xy*=rot2;

	//volumetric rendering
	float s=0.1,fade=1.;
	vec3 v=vec3(0.);
	for (int r=0; r<volsteps; r++) {
		vec3 p=from+s*dir*.5;
		p = abs(vec3(tile)-mod(p,vec3(tile*2.))); // tiling fold
		float pa,a=pa=0.;
		for (int i=0; i<iterations; i++) {
			p=abs(p)/dot(p,p)-formuparam; // the magic formula
			a+=abs(length(p)-pa); // absolute sum of average change
			pa=length(p);
		}
		float dm=max(0.,darkmatter-a*a*.001); //dark matter
		a*=a*a; // add contrast
		if (r>6) fade*=1.-dm; // dark matter, don't render near
		//v+=vec3(dm,dm*.5,0.);
		v+=fade;
		v+=vec3(s,s*s,s*s*s*s)*a*brightness*fade; // coloring based on distance
		fade*=distfading; // distance fading
		s+=stepsize;
	}
	v=mix(vec3(length(v)),v,saturation); //color adjust
	fragColor = vec4(v*.01,1.);
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

  return startShadertoy(canvas, { source: SHADER, config, params, name: 'starnest' });
}
