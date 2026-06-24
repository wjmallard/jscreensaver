// bestill.js — "bestill" packaged as a mountable WebGL module: a SIX-SCENE
// collection. start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Six calm, still landscape / cloud scenes by Matt Vianueva (diatribes), each a
// complete single-pass Shadertoy Image shader: "Be Still", "Everything is
// Temporary", "Night Cloud Dance", "Cloud Lights", "Desert Duo", and "Water".
// They are tiny raymarchers — an orb drifting over a noisy plane under a slow
// camera sway, tanh-tonemapped into dusk / night / desert / water moods.
// Originally Shadertoys, each relicensed MIT by permission (8-Mar-2026);
// xscreensaver 6.x ships them as hacks/glx/glsl/bestill{0..5}-0.glsl run by its
// xshadertoy.c harness. Here they run natively on WebGL2 / GLSL ES 3.00 via the
// shared ./shadertoy.js harness, and each scene body is verbatim from its
// original (kept alongside as bestill{0..5}-0.glsl). See bestill.md.
//
// Scene selection: one scene is chosen at random per mount (start). The harness's
// own reinit ('r') only jumps the clock, so it re-rolls the time offset within
// the already-chosen scene, not the scene itself — re-mount to draw a new scene.
//
// Rendering: one full-screen triangle, one fragment-shader pass per frame, no
// textures, no multi-pass buffers — the per-pixel raymarch is the whole cost,
// with no CPU-side simulation at all.

import { startShadertoy } from '../shadertoy.js';

export const title = 'bestill';

export const info = {
  heavy: true,
  author: 'Matt Vianueva (diatribes)',
  description: 'Various scenes of lights playing above the clouds.\n\nhttps://www.shadertoy.com/view/tfXcRn\nhttps://www.shadertoy.com/view/w32BDD\nhttps://www.shadertoy.com/view/3cjcWD\nhttps://www.shadertoy.com/view/wXXBRX\nhttps://www.shadertoy.com/view/3cXyzB\nhttps://www.shadertoy.com/view/tXjXDy',
  year: 2025,
};

// Each entry is verbatim from hacks/glx/glsl/bestill{0..5}-0.glsl (Shadertoy,
// MIT). The harness prepends #version / precision / the Shadertoy uniform block
// and appends the main() that calls mainImage(), so each string is ONLY the
// shader's own #defines / helpers / mainImage. iResolution / iTime are supplied
// by the harness preamble.
const SCENES = [
// --- bestill0-0.glsl : "Be Still" ----------------------------------------
`// Title:  Be Still
// Author: Matt Vianueva <diatribes@gmail.com>
// URL:    https://www.shadertoy.com/view/tfXcRn
// Date:   14-Aug-2025
// Desc:   Be Still

// Relicensed as MIT License, by permission, 8-Mar-2026.

void mainImage(out vec4 o, vec2 u) {
    o = vec4(0,0,0,0);
    float d=0.,a=0.,e=0.,i=0.,s=0.,t = iTime*.5;
    vec3  p = iResolution;    
    
    // scale coords
    u = (u+u-p.xy)/p.y;
    
    // cinema bars
    if (abs(u.y) > .8) { o = vec4(0); return; }
    
    // camera movement
    u += vec2(cos(t*.4)*.3, cos(t*.8)*.1);
    
    for(o*=i; i++<1e2;
    
        // entity (orb)
        e = length(p - vec3(
            sin(sin(t*.2)+t*.4) * 2.,
            1.+sin(sin(t*1.3)+t*.2) *1.23,
            12.+t+cos(t*.5)*8.))-.1,
        
        // accumulate distance
        d += s = min(.01+.4*abs(s),e=max(.8*e, .01)),
        
        // grayscale color
        o += 1./(s+e*4.))
        
        // noise loop start, march
        for (p = vec3(u*d,d+t), // p = ro + rd *d, p.z + t;
            
            // diagonal plane
            s =4.+p.y+p.x*.3,
            
            // noise starts at .42 up to 16.,
            // grow by a+=a
            a = .42; a < 16.; a += a)
            
            // apply noise
            s -= abs(dot(sin(.6*t+p * a ), .18+p-p)) / a;
    
    // tanh tonemap, brightness, light off-screen
    u += (u.yx*.7+.2-vec2(-1.,.1));
    o = tanh(vec4(4,2,1,0)*o/1e1/dot(u,u));
}
`,
// --- bestill1-0.glsl : "Everything is Temporary" -------------------------
`// Title:  Everything is Temporary
// Author: Matt Vianueva <diatribes@gmail.com>
// URL:    https://www.shadertoy.com/view/w32BDD
// Date:   06-Nov-2025
// Desc:   Everything is Temporary

// Relicensed as MIT License, by permission, 8-Mar-2026.

/*

    -24 chars by @FabriceNeyret2
    
    ty!!   :D

*/

void mainImage(out vec4 o, vec2 u) {
    o = vec4(0,0,0,0);
    float d=0.,a=0.,e=0.,i=0.,s=0.,t = iTime*.5;
    vec3  p = iResolution;    
    
    // scale coords
    u = (u+u-p.xy)/p.y;
    
    // cinema bars
    if (abs(u.y) > .8) { o *= 0.; return; }
 
    vec2 v = u.yx*.7 + vec2(1.2,.1);
    float l1 = 2./length(u + v),
          l2 = 2./length(u - v);
 
    // camera movement
    u += cos(t*vec2(.4,.8)) * vec2(.3,.1);
    for(o*=0.; i++<1e2;
    
        // entity (orb)
        e = length(p - vec3(
            sin(sin(t*.2)+t*.4) * 2.,
            1.+sin(sin(t*1.3)+t*.2) *1.23,
            12.+t+cos(t*.5)*8.))-.1,
        
        // accumulate distance
        d += s = min(.01+.4*abs(s),e=max(.8*e, .01)),
        
        // grayscale color
        o += 1e2/(s+e*4.)+ l1 + l2)
        
        // noise loop start, march
        for (p = vec3(u*d,d+t), // p = ro + rd *d, p.z + t;
            
            // plane
            s =5.+p.y+cos(p.x*.1)*4.,
            
            // noise starts at .01 up to 3.,
            // grow by a+=a
            a = .01; a < 3.; a += a)
            
            // apply noise
            s -= abs(dot(sin(.2*p.z+.6*t+p / a ), .4+p-p)) * a;
    
    // tanh tonemap, brightness
    o = tanh(vec4(5,2,1,0)*o*o*o/1e9);
}

























/*
void mainImage(out vec4 o, vec2 u) {
    float d,a,e,i,s,t = iTime*.5;
    vec3  p = iResolution;    
    
    // scale coords
    u = (u+u-p.xy)/p.y;
    
    // cinema bars
    if (abs(u.y) > .8) { o = vec4(0); return; }
 
 
    float l1 = 2./length(u + (u.yx*.7+.2-vec2(-1.,.1))),
          l2 = 2./length(u - (u.yx*.7+.2-vec2(-1.,.1)));
 
 
    // camera movement
    u += vec2(cos(t*.4)*.3, cos(t*.8)*.1);
    
    for(o*=i; i++<1e2;
    
        // entity (orb)
        e = length(p - vec3(
            sin(sin(t*.2)+t*.4) * 2.,
            1.+sin(sin(t*1.3)+t*.2) *1.23,
            12.+t+cos(t*.5)*8.))-.1,
        
        // accumulate distance
        d += s = min(.01+.4*abs(s),e=max(.8*e, .01)),
        
        // grayscale color
        o += 1e2/(s+e*4.)+ l1 + l2)
        
        // noise loop start, march
        for (p = vec3(u*d,d+t), // p = ro + rd *d, p.z + t;
            
            // diagonal plane
            s =5.+p.y+cos(p.x*.1)*4.,
            
            // noise starts at .42 up to 16.,
            // grow by a+=a
            a = .01; a < 3.; a += a)
            
            // apply noise
            s -= abs(dot(sin(.2*p.z+.6*t+p / a ), .4+p-p)) * a;
    
    // tanh tonemap, brightness, light off-screen
    o = tanh(vec4(5,2,1,0)*o*o*o/1e9);
}
*/
`,
// --- bestill2-0.glsl : "Night Cloud Dance" -------------------------------
`// Title:  Night Cloud Dance
// Author: Matt Vianueva <diatribes@gmail.com>
// URL:    https://www.shadertoy.com/view/3cjcWD
// Date:   31-Aug-2025
// Desc:   Night Cloud Dance

// Relicensed as MIT License, by permission, 8-Mar-2026.

void mainImage(out vec4 o, vec2 u) {
    o = vec4(0,0,0,0);
    float d=0.,a=0.,e=0.,i=0.,s=0.,t = iTime*.5;
    vec3  ep, p = iResolution;    
    
    // scale coords
    u = (u+u-p.xy)/p.y;
    
    u += vec2(cos(t*.4)*.3, cos(t*.8)*.1);
    
    for(o*=i; i++<1e2;

        // accumulate distance
        d += s = min(.02+.6*abs(s),e=max(.8*e, .01)),
        
        // grayscale color
        o += 1./(s+e*2.))
        
        // noise loop start, march
        for (p = vec3(u*d,d+t), // p = ro + rd *d, p.z + t;
    
            // entity (orb) position
            ep = p - vec3(
                sin(sin(t)+t*.4) * 8.,
                sin(sin(t)+t*.2) *2.,
                16.+t+cos(t)*8.),
                
            // orb sphere
            e = length(ep) - .1,
                    
            // plane, mix with entity/orb
            s = mix(e*.02,4.+p.y, smoothstep(0., 12., length(ep))),
            
            // noise params
            a = .4; a < 8.; a *= 1.4)
            
            // apply noise
            s -= abs(dot(cos(t+.2*p.z+p * a ), .11+p-p)) / a;
    
    // tanh tonemap, blue tint, brightness, moon
    o = tanh(vec4(1,2,6,0)*o/1e1/length(u-.65));
}
`,
// --- bestill3-0.glsl : "Cloud Lights" ------------------------------------
`// Title:  Cloud LIghts
// Author: Matt Vianueva <diatribes@gmail.com>
// URL:    https://www.shadertoy.com/view/wXXBRX
// Date:   29-Oct-2025
// Desc:   Cloud LIghts

// Relicensed as MIT License, by permission, 8-Mar-2026.

#define O(Z,c) ( length(                 /* orb */   \\
          p - vec3( sin( t*c*24. ) * 16.,        \\
                    sin( t*c*18. ) * 12. + 12.,  \\
                    Z+t+t+cos(t*.5)*32. )  ) - c )

void mainImage(out vec4 o, vec2 u) {
    o = vec4(0,0,0,0);
    float i=0.,e=0.,a=0.,d=0.,s=0.,t=iTime;
    vec3  p = iResolution;    
    u = (u-p.xy/2.)/p.y;
    if (abs(u.y) > .4) { o = vec4(0); return; }
    u += vec2(cos(t*.4)*.3, cos(t*.8)*.1);
    
    vec2 v = u - (u.yx*.8+.2-vec2(-.2,.1));;
    float light = dot(v,v);
    
    for(o*=i; i++<80.;
        d += s = min(e, .06 + abs(s)*.3),
        o += 1./s + 1e2/e + 1. / light) 
        for (p = vec3(u*d,d+t+t),
        
            e = max( .8* min( O( 3e1, .03),
                         min( O( 4e1, .06),
                         min( O( 5e1, .09),
                         min( O( 6e1, .12),
                              O( 7e1, .15) )))), .001 ),
        
            s = 6. + p.y,
            a = .05; a < 2.; a += a)
            s -= abs(dot(sin(t+.3*p / a), .6+p-p)) * a;
    
    o = tanh(vec4(1,2,5,0)*o*o /4e6);
}

`,
// --- bestill4-0.glsl : "Desert Duo" --------------------------------------
`// Title:  Desert Duo
// Author: Matt Vianueva <diatribes@gmail.com>
// URL:    https://www.shadertoy.com/view/3cXyzB
// Date:   20-Aug-2025
// Desc:   Desert Duo

// Relicensed as MIT License, by permission, 8-Mar-2026.

void mainImage(out vec4 o, vec2 u) {

    o = vec4(0,0,0,0);
    float
          // raymarch iterator
          i=0.,
          // total distance
          d=0.,
          // signed distance
          s=0.,
          // entity (orb) distance
          e=0.,
          // time (orb movement, camera sway, etc.)
          t=iTime,
          // flight time, z and x coord speed for flight
          zt = t * 12.,
          xt = t * 13.;
          
    vec3 p = iResolution;
    
    // scale coords and move the camera around a bit
    u = (u+u-p.xy)/p.y+cos(t*.3)*vec2(.4,.2);
    
    // clear o, march up to 128
    for(o*=i; i++<128.;
        
        // accumulate distance of orb, plane or clouds
        d += s = min(e, min(1.+ p.y*.6, 5.-p.y*.05)),
        
        // accumulate brightness
        o += s + 3./e)
        
        // noise start
        for(p = vec3(u*d,d+zt), // p = ro + rd * d, p.z += zt;

            // entity (orb), a sphere
            e = length(p - vec3(
                sin(sin(t*.2)+t*.4)*4.,
                sin(sin(t*1.3)+t*.2)*2.,
                14.+zt+cos(t*.5)*8.))-.1,

            // move to the side
            p.x -= xt,

            // start noise at .02, until 2, grow by s += s
            s = .02;
            s < 2.;
            s += s)
                 // apply noise
                 p += abs(dot(sin(p * s), p-p+.12)) / s;
    
    // make our angled sun beam light thing
    u += (u.yx*.7+.2-vec2(-1.,.1));
    
    // tanh tonemap, color, brightness, light
    o = tanh(vec4(5,2,1,0)*o*o/d/1e3/length(u));
}

`,
// --- bestill5-0.glsl : "Water" -------------------------------------------
`// Title:  Water [237]
// Author: Matt Vianueva <diatribes@gmail.com>
// URL:    https://www.shadertoy.com/view/tXjXDy
// Date:   03-Nov-2025
// Desc:   Water [248]

// Relicensed as MIT License, by permission, 8-Mar-2026.

/*
    -3 by @FabriceNeyret2
   
    -11 by @bug (very very slight visual change)
    
    thanks!!  :D

*/

void mainImage( out vec4 o, vec2 u ) {
    o = vec4(0,0,0,0);
    float s=.3,i=0.,n=0.;
    vec3 r = iResolution,p=vec3(0,0,0);
    for(u = (u-r.xy/2.)/r.y-s; i++ < 32. && ++s>.001;)
        for (p += vec3(u*s,s),s = p.y,
            n =.01; n < 1.;n+=n)
            s += abs(dot(sin(p.z + iTime + p/n),  r/r)) * n*.1;
    o = tanh(i*vec4(5,2,1,0)/length(u-.1)/5e2);
}
`,
];

export function start(canvas) {
  // Each mount draws a random one of the six scenes; the chosen body is fixed
  // for the life of this mount (reinit only re-rolls the time offset within it).
  const source = SCENES[Math.floor(Math.random() * SCENES.length)];

  // Two harness-level knobs; each scene's own constants are left untouched.
  const config = {
    speed: 1.0,        // playback-rate multiplier on the scene's slow motion
    resolution: 1.0,   // render scale vs devicePixelRatio (1 = crisp, lower = faster)
  };

  const params = [
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 4, step: 0.05, default: 1.0, lowLabel: 'still', highLabel: 'warp', live: true },
    { key: 'resolution', label: 'Resolution', type: 'range', min: 0.25, max: 1, step: 0.05, default: 1.0, lowLabel: 'fast', highLabel: 'crisp', live: true },
  ];

  return startShadertoy(canvas, { source, config, params, name: 'bestill' });
}
