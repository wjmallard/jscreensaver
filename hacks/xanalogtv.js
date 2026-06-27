// xanalogtv.js — "XAnalogTV" packaged as a mountable WebGL module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// XAnalogTV by Trevor Blackwell (2003): an old television flipping through
// channels — color bars (with the station logo and light snow), test cards, and
// dead channels of static — all run through the genuine NTSC signal simulation in
// hacks/analogtv.glsl.js (the shared port of analogtv.c): real RGB->composite
// encode, demodulate, scanlines, chroma artifacts. When you change the channel it
// briefly loses sync — rolling vertically and tearing horizontally — before it
// locks on, and occasionally glitches mid-channel, like a real flaky set.
//
// The real hack also pulls pictures from your image directory, which the browser
// can't reach; this faithful adaptation uses the bundled TV test cards and the
// procedural bars/static channels instead.
// See hacks/xanalogtv.md and the memory note analogtv-ntsc-shader-port.

import { startAnalogTV } from './analogtv.glsl.js';

export const title = 'xanalogtv';

export const info = {
  author: 'Trevor Blackwell',
  description:
    'A dusty old television flips through the channels: SMPTE color bars with the station logo, test cards, and snow, losing sync and rolling when it changes channel, all through a real NTSC signal simulation.',
  year: 2003,
};

// Channel content. uChanType: 0 bars, 1 dead/snow, 2 bars+logo, 3..5 test cards
// (uImage1..3). uImage0 is the logo. Snow comes from the decoder's composite
// noise, so a dead channel's source is just black. uv is y-down, [0,1].
const SOURCE = `
uniform int uChanType;

vec3 smpte_bars(vec2 uv){
  float x = uv.x, y = uv.y;
  int col = int(clamp(floor(x*7.0), 0.0, 6.0));
  if (y < 0.68) {                      // 7 bars at 75% amplitude
    vec3 b[7] = vec3[7](vec3(0.75), vec3(0.75,0.75,0.0), vec3(0.0,0.75,0.75),
      vec3(0.0,0.75,0.0), vec3(0.75,0.0,0.75), vec3(0.75,0.0,0.0), vec3(0.0,0.0,0.75));
    return b[col];
  } else if (y < 0.75) {               // reverse mini band
    vec3 m[7] = vec3[7](vec3(0.0,0.0,0.75), vec3(0.0), vec3(0.75,0.0,0.75),
      vec3(0.0), vec3(0.0,0.75,0.75), vec3(0.0), vec3(0.75));
    return m[col];
  } else {                             // bottom: -I, white, +Q, black, PLUGE
    if (x < 1.0/6.0)      return vec3(0.0, 0.27, 0.49);
    else if (x < 2.0/6.0) return vec3(1.0);
    else if (x < 3.0/6.0) return vec3(0.24, 0.0, 0.46);
    else if (x < 4.0/6.0) return vec3(0.0);
    else if (x < 13.0/18.0) return vec3(0.015);
    else if (x < 14.0/18.0) return vec3(0.06);
    else return vec3(0.0);
  }
}

// Composite the logo (uImage0, with alpha) where the real hack draws it:
// centred horizontally, upper third, ~20% of the screen.
vec3 with_logo(vec3 col, vec2 uv){
  vec2 c = vec2(0.5, 0.40), hsz = vec2(0.105, 0.135);
  vec2 luv = (uv - (c - hsz)) / (2.0 * hsz);
  if (luv.x >= 0.0 && luv.x <= 1.0 && luv.y >= 0.0 && luv.y <= 1.0) {
    vec4 lg = texture(uImage0, luv);
    col = mix(col, lg.rgb, lg.a);
  }
  return col;
}

vec3 atv_source(vec2 uv){
  if (uChanType == 1) return vec3(0.0);                 // dead channel: snow only
  if (uChanType == 3) return texture(uImage1, uv).rgb;  // test card: RCA
  if (uChanType == 4) return texture(uImage2, uv).rgb;  // test card: PM5544
  if (uChanType == 5) return texture(uImage3, uv).rgb;  // test card: BBC F
  vec3 col = smpte_bars(uv);
  if (uChanType == 2) col = with_logo(col, uv);
  return col;
}
`;

const round = Math.round;
const rnd = Math.random;

export function start(canvas) {
  const config = {
    color: 1.0, tint: 0, brightness: -0.05, contrast: 1.4,
    barsnow: 0.11,     // light snow over the picture channels
    dwell: 7.0,        // seconds per channel
    syncloss: 22,      // mean seconds between sustained mid-image sync-loss events
    fps: 30,
  };

  // 12 VHF channels: bars (some with logo), the three test cards, and dead/snow.
  const CHAN = [2, 1, 3, 0, 1, 4, 2, 1, 5, 0, 1, 2];

  // Resolve bundled images relative to this module (logo + 3 test cards).
  const img = (f) => new URL(`./images/${f}`, import.meta.url).href;
  const IMAGES = [img('logo-180.png'), img('testcard_rca.png'),
                  img('testcard_pm5544.png'), img('testcard_bbcf.png')];

  // Reception state: mostly locked, with a roll/tear "lock-on" after each channel
  // change and the odd mid-channel glitch.
  let chanType = 1;
  let rollPos = 0, rollVel = 0, acquire = 0, tear = 0, lastIdx = -1;
  let syncLoss = 0, lossRoll = false, lossTear = false;   // sustained mid-image sync loss
  const bend = (rnd() * 2 - 1) * 0.012;   // per-set top bar-bend, like horiz_desync

  function reception(time) {
    const dwell = config.dwell || 7;
    const idx = Math.floor(time / dwell) % CHAN.length;
    const into = time - Math.floor(time / dwell) * dwell;

    const fps = config.fps || 30;
    if (idx !== lastIdx) {                 // just turned the dial
      lastIdx = idx;
      rollVel = (rnd() * 0.06 + 0.05) * (rnd() < 0.5 ? -1 : 1);
      acquire = 1.0;                        // 1 -> 0 as it locks on
      syncLoss = 0;
    }
    const switching = into < 0.5;          // static burst while tuning
    chanType = switching ? 1 : CHAN[idx];
    const settled = !switching && acquire < 0.05 && chanType !== 1;

    // Occasional PERSISTENT mid-image loss of sync: the vertical/horizontal hold
    // drifts on its own for a few seconds (rolling and/or tearing), then catches.
    // config.syncloss = mean seconds between events.
    if (settled && syncLoss <= 0 && Math.floor(rnd() * ((config.syncloss || 22) * fps)) === 0) {
      syncLoss = (3 + rnd() * 5) * fps;     // 3-8 s adrift
      lossRoll = rnd() < 0.7;               // usually vertical roll
      lossTear = rnd() < 0.55;              // often also/instead a horizontal tear
      if (!lossRoll && !lossTear) lossRoll = true;
      rollVel = (rnd() * 0.04 + 0.02) * (rnd() < 0.5 ? -1 : 1);
    }

    let roll, rolling, slant, hdrift;
    if (syncLoss > 0) {                     // free drift, not re-locking yet
      syncLoss -= 1;
      if (lossRoll) { rollVel += (rnd() - 0.5) * 0.003; rollPos += rollVel; }  // wander
      roll = lossRoll ? (rollPos - round(rollPos)) : 0;
      rolling = lossRoll ? 1 : 0;
      slant = lossTear ? (0.16 + 0.08 * Math.sin(time * 2.7)) * Math.sin(time * 10.0) : 0;
      hdrift = lossTear ? 0.06 * Math.sin(time * 1.7) : 0;
      if (syncLoss <= 0) acquire = 1.0;     // duration up -> engage the re-lock
    } else {                                // locked / damped re-lock (also post-change)
      rollPos += rollVel;
      rollVel = rollVel * 0.96 - (rollPos - round(rollPos)) * 0.05;
      acquire = Math.max(0, acquire - 1 / (1.6 * fps));   // ~1.6s lock-on
      if (settled && Math.floor(rnd() * 240) === 0) tear = 1.0;   // brief tic
      tear = Math.max(0, tear - 0.06);
      const aq = acquire * acquire;
      roll = aq * (rollPos - round(rollPos));
      rolling = aq > 0.04 ? 1 : 0;
      slant = aq * 0.25 * Math.sin(time * 14.0) + tear * 0.5;
      hdrift = aq * 0.10 * Math.sin(time * 4.0) + tear * 0.2 * Math.sin(time * 30.0);
    }

    const snow = switching ? 0.5 : (chanType === 1 ? 0.5 : config.barsnow);
    // Colourburst gate (analogtv colormode): no chroma on a dead channel; on a
    // station the colour locks in just after the picture (burst 0 -> 1).
    const burst = chanType === 1 ? 0 : 1 - acquire;
    return { chanType, snow, burst, roll, rolling, slant, hdrift, bend };
  }
  let rx = { chanType: 1, snow: 0.5, burst: 0, roll: 0, rolling: 0, slant: 0, hdrift: 0, bend };

  const params = [
    { key: 'color', label: 'Color', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0, lowLabel: 'B&W', highLabel: 'vivid', live: true },
    { key: 'tint', label: 'Tint', type: 'range', min: -90, max: 90, step: 1, default: 0, unit: '\u00B0', live: true },
    { key: 'brightness', label: 'Brightness', type: 'range', min: -0.3, max: 0.3, step: 0.01, default: -0.05, live: true },
    { key: 'contrast', label: 'Contrast', type: 'range', min: 0.5, max: 2.5, step: 0.05, default: 1.4, live: true },
    { key: 'barsnow', label: 'Snow', type: 'range', min: 0, max: 0.3, step: 0.01, default: 0.11, lowLabel: 'clear', highLabel: 'noisy', live: true },
    { key: 'dwell', label: 'Channel hold', type: 'range', min: 2, max: 20, step: 1, default: 7, unit: 's', live: true },
  ];

  return startAnalogTV(canvas, {
    source: SOURCE,
    images: IMAGES,
    frameKnobs: (ctx) => {
      rx = reception(ctx.time);
      return {
        color: config.color * rx.burst, tint: config.tint,
        brightness: config.brightness, contrast: config.contrast,
        noise: rx.snow,
        bend: rx.bend, roll: rx.roll, rolling: rx.rolling, slant: rx.slant, hdrift: rx.hdrift,
      };
    },
    setUniforms: (gl, prog) => {
      gl.uniform1i(gl.getUniformLocation(prog, 'uChanType'), rx.chanType);
    },
    config,
    params,
    name: 'xanalogtv',
  });
}
