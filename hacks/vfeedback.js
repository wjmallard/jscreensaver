// vfeedback.js — "VFeedback" packaged as a mountable WebGL module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// VFeedback by Jamie Zawinski (2018): video feedback — a camcorder pointed at the
// television it is plugged into, re-grabbing the screen it just drew (slightly
// panned, zoomed and rotated) ~30x a second, folding the image into endless
// tunnels and spirals. The grabbed frame is run back through the NTSC signal
// simulation each time, so the colour cycling, bloom and chroma artifacts are the
// real analogtv pipeline (hacks/analogtv.glsl.js, the port of analogtv.c) — not
// the blur+hue-rotate knock-off this replaces.
//
// Self-feedback maps cleanly to the harness's ping-pong: atv_source() resamples
// the PREVIOUS final frame (uPrev) through the camera rectangle (grab_rectangle's
// exact affine), then the harness re-encodes it to composite and re-decodes it.
// The camera state machine (POWERUP -> IDLE -> MOVE) and the periodic specular
// glint are ported from vfeedback.c in JS and fed in as uniforms each frame.
// See hacks/vfeedback.md and the memory note analogtv-ntsc-shader-port.

import { startAnalogTV } from './analogtv.glsl.js';

export const title = 'vfeedback';

export const info = {
  author: 'Jamie Zawinski',
  description:
    'Video feedback: a camcorder aimed at the television it is plugged into, folding the re-grabbed picture into endless rotating tunnels through a real NTSC signal simulation.',
  year: 2018,
};

// atv_source = the previous final frame resampled through the camera rectangle
// (grab_rectangle in vfeedback.c, exact transform), with the bundled test card
// continuously mixed in (uImage0) — the camera always sees "something on the TV",
// which fuels the loop (no collapse) and smears the card into the tunnels — plus
// the specular glint. uImage0/uPrev/uPrevRes are provided by the harness.
const SOURCE = `
uniform vec4 uRect;     // rect.x, rect.y, rect.w, rect.h
uniform float uTh;      // rect.th (radians)
uniform vec3 uSpec;     // spec x,y (0..1), normalized diameter (0 = inactive)
uniform float uInject;  // how much fresh test card to blend in this frame

vec3 atv_source(vec2 uv){
  // grab_rectangle: rotate the centred, pan/zoom-scaled output point and look it
  // up in the previous frame; off-frame samples read black (the camera edge).
  float C = cos(uTh), S = sin(uTh);
  float xcs = uRect.z * (uv.x - 0.5 + uRect.x);
  float ycs = uRect.w * uv.y + uRect.y - 0.5;
  vec2 p = vec2(C*xcs - S*ycs, S*xcs + C*ycs) + 0.5;
  vec3 fb = vec3(0.0);
  if (p.x >= 0.0 && p.x <= 1.0 && p.y >= 0.0 && p.y <= 1.0)
    fb = texture(uPrev, vec2(p.x, 1.0 - p.y)).rgb;   // final frame is y-up in GL

  vec3 card = texture(uImage0, uv).rgb;              // the bundled TV test card
  vec3 col = mix(fb, card, clamp(uInject, 0.0, 1.0));

  // Specular reflection (#CCCC44), a bright glint swept into the vortex.
  if (uSpec.z > 0.0) {
    vec2 d = uv - uSpec.xy;
    d.x *= uPrevRes.x / max(uPrevRes.y, 1.0);          // round on screen
    float m = 1.0 - smoothstep(uSpec.z*0.35, uSpec.z*0.5, length(d));
    col = mix(col, vec3(0.80, 0.80, 0.27), m);
  }
  return col;
}
`;

const POWERUP = 0, IDLE = 1, MOVE = 2;
const easeInOutSine = (t) => 0.5 * (1 - Math.cos(Math.PI * Math.min(Math.max(t, 0), 1)));
const sign = () => (Math.random() < 0.5 ? -1 : 1);
const chance = (n) => Math.floor(Math.random() * n) === 0;   // 1/n, like !(random()%n)

export function start(canvas) {
  const config = {
    speed: 1.0,        // camera drift rate
    color: 0.85,       // slightly desaturated — the real loop reads near-white
    tint: 0,
    brightness: -0.05,
    contrast: 1.3,     // AGC servoes the real loop gain; this is just the base
    seed: 0.12,        // how much fresh test card to feed in each frame (the fuel)
    noise: 0.03,       // a little snow texture on top
    agcTarget: 0.5,    // hold the loop bright/high-key like the real vfeedback
    fps: 30,
  };

  // The TV is always showing the bundled test card; the camera feeds it back.
  const TESTCARD = new URL('./images/testcard_bbcf.png', import.meta.url).href;

  // Camera rectangle + state machine (vfeedback.c).
  let rect, orect, state, value, svalue, dx, dy, ds, dth, spec, frames;
  function reroll() {
    frames = 0;
    rect = {
      x: Math.random() * 0.1 * sign(),
      y: Math.random() * 0.1 * sign(),
      w: 1 + Math.random() * 0.4 * sign(),
      h: 0,
      th: 0.2 + Math.random() * 1.0 * sign(),
    };
    rect.h = rect.w;
    orect = { ...rect };
    state = POWERUP; value = 0; svalue = 0; dx = dy = ds = dth = 0;
    // Seed a glint immediately, OFF-centre so it orbits the camera's fixed point
    // and spreads into the rotating fan instead of sitting still at the middle.
    spec = { x: 0.62, y: 0.43, s: 0.12 };
  }
  reroll();

  function step() {
    frames++;
    const speed = config.speed || 1;
    if (state === MOVE) {
      const v = easeInOutSine(value);
      rect.x = orect.x + dx * v;
      rect.y = orect.y + dy * v;
      rect.th = orect.th + dth * v;
      rect.w = orect.w * (1 + ds * v);
      rect.h = rect.w;
    }
    // Keep the zoom near 1 so the camera can't drift to a pose that throws the
    // whole frame off-edge (which would starve the loop to black).
    rect.w = Math.min(1.25, Math.max(0.80, rect.w));
    rect.h = rect.w;
    if (spec.s) {
      svalue += 0.01 * speed;
      if (svalue > 1) { svalue = 0; spec.s = 0; }
    } else if (chance(300)) {
      const ww = 0.012 + rect.h / 12;            // normalized (4px + rect.h*H/12)/H
      spec = {
        x: 0.5 + Math.random() * ww * sign(),
        y: 0.5 + Math.random() * ww * sign(),
        s: ww * (0.8 + Math.random() * 0.4),
      };
      svalue = 0;
    }
    value += 0.03 * speed;
    if (value > 1 || state === POWERUP) {
      orect = { ...rect };
      value = 0; dx = dy = ds = dth = 0;
      if (state === POWERUP) state = IDLE;
      else if (state === IDLE) {
        state = MOVE;
        if (chance(5)) ds = Math.random() * 0.2 * sign();    // zoom
        if (chance(3)) dth = Math.random() * 0.2 * sign();   // rotate
        if (chance(8)) { dx = Math.random() * 0.05 * sign(); dy = Math.random() * 0.05 * sign(); }  // pan
      } else { state = IDLE; value = 0.3; }
    }
  }

  const params = [
    { key: 'speed', label: 'Speed', min: 0.1, max: 3, step: 0.1, live: true },
    { key: 'color', label: 'Color', min: 0, max: 2, step: 0.05, live: true },
    { key: 'tint', label: 'Tint', min: -90, max: 90, step: 1, unit: '°', live: true },
    { key: 'contrast', label: 'Feedback', min: 0.9, max: 1.6, step: 0.05, live: true },
    { key: 'seed', label: 'Test card', min: 0, max: 0.6, step: 0.02, live: true },
    { key: 'noise', label: 'Noise', min: 0, max: 0.2, step: 0.01, live: true },
  ];

  const tv = startAnalogTV(canvas, {
    source: SOURCE,
    feedback: true,
    images: [TESTCARD],
    frameKnobs: () => {
      step();
      return {
        color: config.color, tint: config.tint,
        brightness: config.brightness, contrast: config.contrast,
        noise: config.noise,
      };
    },
    setUniforms: (gl, prog) => {
      gl.uniform4f(gl.getUniformLocation(prog, 'uRect'), rect.x, rect.y, rect.w, rect.h);
      gl.uniform1f(gl.getUniformLocation(prog, 'uTh'), rect.th);
      const pulse = spec.s ? Math.sin(Math.PI * svalue) : 0;     // grow then shrink
      gl.uniform3f(gl.getUniformLocation(prog, 'uSpec'), spec.x, spec.y, spec.s * pulse);
      // Flood the screen with the test card for the first ~0.8s so the loop boots
      // from a full picture, then settle to a steady trickle that keeps it fed.
      const inject = Math.max(config.seed, 1.0 - frames / 24);
      gl.uniform1f(gl.getUniformLocation(prog, 'uInject'), inject);
    },
    config,
    params,
    name: 'vfeedback',
  });

  // reinit re-rolls the camera framing as well as jumping the clock.
  const baseReinit = tv.reinit;
  tv.reinit = () => { reroll(); baseReinit(); };
  return tv;
}
