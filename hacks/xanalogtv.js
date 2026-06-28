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

import { startAnalogTV, ATV_NS, ATV_NL } from './analogtv.glsl.js';

export const title = 'xanalogtv';

export const info = {
  author: 'Trevor Blackwell',
  description:
    'An old TV set, including artifacts like snow, bloom, distortion, ghosting, and hash noise. It also simulates the TV warming up. It will cycle through 12 channels, some with images you give it, and some with color bars or nothing but static.',
  year: 2003,
};

// Channel content. uChanType: 0/2 colour bars (always with the logo + station ID
// + clock, like the single colorbars station in the original), 1 dead/snow, 3..5
// test cards (uImage1..3). uImage0 is the logo, uImage4 the live text overlay.
// Snow comes from the decoder's composite noise, so a dead channel's source is
// just black. uv is y-down, [0,1].
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
  // ~0.2 of the frame (analogtv draws it at height*0.2), centred between the
  // station name (y~0.11) and the timestamp (y~0.525) so it overlaps neither.
  vec2 c = vec2(0.5, 0.317), hsz = vec2(0.10, 0.10);
  vec2 luv = (uv - (c - hsz)) / (2.0 * hsz);
  if (luv.x >= 0.0 && luv.x <= 1.0 && luv.y >= 0.0 && luv.y <= 1.0) {
    vec4 lg = texture(uImage0, luv);
    col = mix(col, lg.rgb, lg.a);
  }
  return col;
}

// Station ID + running clock, drawn to a live canvas (uImage4) and composited on
// the colour-bars station, the way update_smpte_colorbars overlays the hostname
// and an strftime timestamp. It rides through the NTSC encode, so it bleeds and
// scans like the rest of the picture rather than sitting on top as crisp pixels.
vec3 with_text(vec3 col, vec2 uv){
  vec4 t = texture(uImage4, uv);
  return mix(col, t.rgb, t.a);
}

vec3 atv_source(vec2 uv){
  if (uChanType == 1) return vec3(0.0);                 // dead channel: snow only
  if (uChanType == 3) return texture(uImage1, uv).rgb;  // test card: RCA
  if (uChanType == 4) return texture(uImage2, uv).rgb;  // test card: PM5544
  if (uChanType == 5) return texture(uImage3, uv).rgb;  // test card: BBC F
  vec3 col = smpte_bars(uv);
  col = with_logo(col, uv);                             // the bars station always carries the logo
  col = with_text(col, uv);                             // station ID + clock
  return col;
}
`;

const rnd = Math.random;

// Deterministic per-channel pseudo-random in [0,1) (stable ghost per channel).
const hash01 = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

// Per-channel multipath strength (analogtv reception->multipath): ~2/3 of
// channels pick up a multipath echo of strength 0.3..1; the rest are clean. Drives
// both the ghost FIR and the high-frequency loss, so they share one source.
function channelMultipath(idx) {
  return hash01(idx * 3 + 1) < 0.667 ? (0.3 + 0.7 * hash01(idx * 3 + 2)) : 0;
}

// Per-channel multipath ghost FIR (analogtv reception_update): the multipath
// channels carry an echo; the rest get the weak default ghost. Four taps at lags
// 4/8/12/16 samples, applied by the harness ghost pass.
function channelGhost(idx) {
  // Taps ~+/-0.05*m, in the analogtv reception_update range.
  const m = channelMultipath(idx);
  if (m <= 0) return [0, 0, -0.02, 0.01];     // default (multipath == 0) ghostfir
  return [
    (hash01(idx * 7 + 1) * 2 - 1) * 0.05 * m,
    (hash01(idx * 7 + 2) * 2 - 1) * 0.05 * m,
    (hash01(idx * 7 + 3) * 2 - 1) * 0.05 * m,
    (hash01(idx * 7 + 4) * 2 - 1) * 0.05 * m,
  ];
}

export function start(canvas) {
  const config = {
    color: 1.0, tint: 0, brightness: -0.05, contrast: 1.4,
    barsnow: 0.11,     // light snow over the picture channels
    dwell: 10.0,       // seconds per channel
    powerup: false,    // CRT power-on warm-up animation (off by default)
    hfloss: true,      // high-frequency loss: colour-washing softness on weak/multipath channels (analogtv `if(0)`, revived)
    squeezebottom: rnd() * 5 - 1,   // per-set bottom-edge bloom skew (analogtv squeezebottom)
    fps: 30,
  };

  // 12 VHF channels: bars (some with logo), the three test cards, and dead/snow.
  const CHAN = [2, 1, 3, 0, 1, 4, 2, 1, 5, 0, 1, 2];

  // Resolve bundled images relative to this module (logo + 3 test cards).
  const img = (f) => new URL(`./images/${f}`, import.meta.url).href;
  const IMAGES = [img('logo-180.png'), img('testcard_rca.png'),
                  img('testcard_pm5544.png'), img('testcard_bbcf.png')];

  // Live station-ID + clock overlay (analogtv update_smpte_colorbars): drawn to a
  // 2D canvas the harness re-uploads each frame and exposes as uImage4. Station
  // name is "jscreensaver.net"; the clock is JS Date() in the original's
  // strftime "%y.%m.%d %H:%M:%S" format. Redrawn only when the second ticks.
  const textCanvas = document.createElement('canvas');
  textCanvas.width = 512;
  textCanvas.height = 384;
  const tctx = textCanvas.getContext('2d');
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
  let lastStamp = '';

  // The real X11 "6x10" bitmap font (analogtv ugly_font), which jwz dumped to a
  // PNG: 256 ASCII-indexed glyphs of 7x10 in a 1792x10 strip (glyph c at sx=c*7).
  // The PNG stores each glyph in its ALPHA channel (ink = opaque, ground = clear;
  // colour is black throughout), so we just recolour the ink to white once, then
  // blit glyphs nearest-neighbour -- the station ID + clock render as the genuine
  // chunky font and bleed through the NTSC encode, not as a smooth system mono.
  const FONT_CW = 7, FONT_CH = 10;
  let fontCv = null;                     // white-on-alpha glyph atlas (null until loaded)
  const fontImg = new Image();
  fontImg.onload = () => {
    const fc = document.createElement('canvas');
    fc.width = fontImg.width; fc.height = fontImg.height;
    const fx = fc.getContext('2d');
    fx.drawImage(fontImg, 0, 0);
    const id = fx.getImageData(0, 0, fc.width, fc.height), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = 255;  // ink -> white; keep the PNG's alpha as the glyph mask
    }
    fx.putImageData(id, 0, 0);
    fontCv = fc;
    lastStamp = '';                      // force a redraw now that the glyphs exist
    drawStationText();
  };
  fontImg.src = img('6x10font.png');

  // Blit one string centred at (cxFrac, cyFrac) of the text canvas, scaled by s.
  function drawText(str, cxFrac, cyFrac, s) {
    const W = textCanvas.width, H = textCanvas.height;
    const gw = FONT_CW * s, gh = FONT_CH * s;
    let x = Math.round(W * cxFrac - (str.length * gw) / 2);
    const y = Math.round(H * cyFrac - gh / 2);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i) & 0xff;
      tctx.drawImage(fontCv, c * FONT_CW, 0, FONT_CW, FONT_CH, x, y, gw, gh);
      x += gw;
    }
  }

  function drawStationText() {
    const d = new Date();
    const stamp = pad2(d.getFullYear() % 100) + '.' + pad2(d.getMonth() + 1) + '.' +
      pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' +
      pad2(d.getSeconds());
    if (stamp === lastStamp) return;
    lastStamp = stamp;
    const W = textCanvas.width, H = textCanvas.height;
    tctx.clearRect(0, 0, W, H);
    if (!fontCv) return;                 // font still loading; harness re-uploads next frame
    tctx.imageSmoothingEnabled = false;
    const s = Math.max(1, Math.round(H * 0.05 / FONT_CH));   // ~2x: chunky but legible
    drawText('jscreensaver.net', 0.5, 0.11, s);
    drawText(stamp, 0.5, 0.525, s);
  }
  drawStationText();
  IMAGES.push({ canvas: textCanvas });

  // Reception state: locked, with a brief vertical-roll "lock-on" after each
  // channel change. Stock xanalogtv only loses sync on a channel change (and
  // re-locks vertically); it has NO recurring mid-channel tearing -- horiz_desync
  // is the static top bar-bend below, and flutter_horiz_desync is never enabled in
  // xanalogtv (only apple2 turns it on).
  // analogtv_sync re-locks vertical sync incrementally, walking at most ~32 of
  // the V=262 frame lines per frame toward the new signal. In my roll units (a
  // fraction of the visible field) that cap is ~32/200.
  const VSTEP = 32 / 200;

  let chanType = 1;
  let vsyncErr = 0;          // current vertical-sync error; 0 = locked (analogtv cur_vsync)
  let acquire = 0;           // brief post-change hsync/colour re-lock window (1 -> 0)
  let lastIdx = -1, sinceChange = 1e9;
  const bend = (rnd() * 2 - 1) * 0.012;   // per-set top bar-bend (horiz_desync, frand(10)-5)
  // #9 per-session miscalibration (xanalogtv_init), like a set knocked slightly off
  // at the factory: 1/4 of sessions get a tint kick -- pow(.,7) keeps it usually
  // tiny but occasionally a big hue swing -- and the colour always creeps up a
  // little. analogtv adds frand(0.3) to color_control (default TVColor/100 = 0.70);
  // our color=1.0 maps to that 0.70, so the same bump is /0.70 in our units.
  const tintBias = (rnd() < 0.25) ? Math.pow(rnd() * 2 - 1, 7) * 180 : 0;   // degrees
  const colorBias = rnd() * 0.3 / 0.70;                                     // up to ~+0.43
  let hfloss = 0, hfloss2 = 0;            // high-frequency loss random walk (analogtv reception_update)

  function reception(time) {
    const dwell = config.dwell || 10;
    const fps = config.fps || 30;
    const idx = Math.floor(time / dwell) % CHAN.length;

    if (idx !== lastIdx) {                 // just turned the dial
      lastIdx = idx;
      sinceChange = 0;
      // The new station's signal offset is random (analogtv rec->ofs), so vsync
      // lands at a random error: often near-locked (barely a roll), sometimes far
      // enough to roll for a few frames before it catches. Not the same every time.
      vsyncErr += rnd() - 0.5;
      vsyncErr -= Math.round(vsyncErr);    // wrap to the nearest lock, in [-0.5, 0.5]
      acquire = 1.0;
    } else {
      sinceChange++;
    }

    // High-frequency loss (analogtv reception_update, normally `if (0)`): a slow
    // zero-mean random walk whose magnitude tracks this channel's multipath, so it
    // wavers the colour/luma on weak channels and decays back to 0 (~16-frame time
    // constant) on a clean one. config.hfloss turns it off.
    const mp = config.hfloss ? channelMultipath(idx) : 0;
    hfloss2 += -(hfloss2 / 16) + mp * (rnd() * 0.08 - 0.04);
    hfloss = 0.5 * hfloss + 0.5 * hfloss2;

    // Heavy static is essentially one frame in the original (channel_change_cycles,
    // reset right after the draw); keep it to a brief flash, not a long burst.
    const switching = sinceChange < 3;
    chanType = switching ? 1 : CHAN[idx];

    // Re-lock vertical sync by walking toward lock at the analogtv_sync cap: a
    // quick, monotone catch (a few frames), proportional to how far the new
    // channel's random signal offset landed.
    if (vsyncErr > VSTEP) vsyncErr -= VSTEP;
    else if (vsyncErr < -VSTEP) vsyncErr += VSTEP;
    else vsyncErr = 0;
    const roll = vsyncErr;
    const rolling = vsyncErr !== 0 ? 1 : 0;
    // A small, brief horizontal re-lock wobble + colour-burst settle (~0.4 s) as it
    // catches -- mostly vertical; no full-screen diagonal tear (stock xanalogtv has
    // no mid-channel horizontal flutter).
    acquire = Math.max(0, acquire - 1 / (0.4 * fps));
    const aq = acquire * acquire;
    const slant = aq * 0.05 * Math.sin(time * 30.0);
    const hdrift = aq * 0.025 * Math.sin(time * 47.0);

    // Same injected snow on every channel (analogtv noise_level); AGC does the
    // rest. nl is the composite noise amplitude used both as the snow level and
    // in the signal-strength calc below.
    const nl = Math.max(config.barsnow || 0.06, 0.02);
    const snow = nl;
    const stationLevel = (chanType === 1 || switching) ? 0.0 : 1.0;

    // Two-station co-channel ghost (analogtv MAX_MULTICHAN=2): only ~1/8 of live
    // stations share the channel with a fainter second station (a test card) at a
    // random, slowly drifting (x,y) signal offset -- its own carrier phase gives
    // the interference beat. (In analogtv a 2nd reception needs a weak 1st station
    // AND a 1-in-4 roll ~= 1/8.) Suppressed while tuning / on dead channels.
    let chanType2 = 0, mixB = 0, ofsX = 0, ofsY = 0;
    if (stationLevel > 0 && hash01(idx * 5 + 2) < 0.13) {
      const T2 = [3, 4, 5];
      chanType2 = T2[Math.floor(hash01(idx * 5 + 3) * 3) % 3];
      mixB = 0.22 + 0.18 * hash01(idx * 5 + 6);
      ofsX = hash01(idx * 5 + 4) * ATV_NS + (hash01(idx * 5 + 7) - 0.5) * 6.0 * time;
      ofsY = hash01(idx * 5 + 5) * ATV_NL + (hash01(idx * 5 + 8) - 0.5) * 0.6 * time;
    }

    // AGC (analogtv rx_signal_level = sqrt(noise^2 + sum level^2)): a channel with
    // a station sits near unity gain; a dead/tuning channel has no station, so
    // agc = 1/noise boosts the snow to near full brightness. The second station
    // adds a little signal energy, lowering the gain slightly.
    const agc = 1.0 / Math.sqrt(nl * nl + stationLevel * stationLevel + mixB * mixB);

    // Colourburst gate (analogtv colormode): no chroma on a dead channel; on a
    // station the colour locks in just after the picture (burst 0 -> 1).
    const burst = chanType === 1 ? 0 : 1 - acquire;
    return {
      chanType, chanType2, mixB, ofsX, ofsY,
      snow, burst, agc, ghostfir: channelGhost(idx), hfloss,
      roll, rolling, slant, hdrift, bend,
    };
  }
  let rx = { chanType: 1, chanType2: 0, mixB: 0, ofsX: 0, ofsY: 0, snow: 0.5, burst: 0, agc: 1, ghostfir: [0, 0, 0, 0], hfloss: 0, roll: 0, rolling: 0, slant: 0, hdrift: 0, bend };

  const params = [
    { key: 'color', label: 'Color', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0, lowLabel: 'B&W', highLabel: 'vivid', live: true },
    { key: 'tint', label: 'Tint', type: 'range', min: -90, max: 90, step: 1, default: 0, unit: '\u00B0', live: true },
    { key: 'brightness', label: 'Brightness', type: 'range', min: -0.3, max: 0.3, step: 0.01, default: -0.05, live: true },
    { key: 'contrast', label: 'Contrast', type: 'range', min: 0.5, max: 2.5, step: 0.05, default: 1.4, live: true },
    { key: 'barsnow', label: 'Snow', type: 'range', min: 0, max: 0.3, step: 0.01, default: 0.11, lowLabel: 'clear', highLabel: 'noisy', live: true },
    { key: 'dwell', label: 'Channel hold', type: 'range', min: 2, max: 20, step: 1, default: 10, unit: 's', live: true },
    { key: 'powerup', label: 'Power-on warm-up', type: 'checkbox', default: false, live: true },
  ];

  return startAnalogTV(canvas, {
    source: SOURCE,
    images: IMAGES,
    ghost: true,
    bloom: true,
    twoStation: true,
    frameKnobs: (ctx) => {
      drawStationText();
      rx = reception(ctx.time);
      return {
        color: (config.color + colorBias) * rx.burst, tint: config.tint + tintBias,
        brightness: config.brightness, contrast: config.contrast,
        noise: rx.snow, agc: rx.agc, ghostfir: rx.ghostfir, hfloss: rx.hfloss,
        mixB: rx.mixB, ofsX: rx.ofsX, ofsY: rx.ofsY,
        bend: rx.bend, roll: rx.roll, rolling: rx.rolling, slant: rx.slant, hdrift: rx.hdrift,
      };
    },
    setUniforms: (gl, prog, ctx) => {
      // pass 0 = main station, pass 1 = the fainter co-channel second station.
      const ct = (ctx && ctx.pass === 1) ? rx.chanType2 : rx.chanType;
      gl.uniform1i(gl.getUniformLocation(prog, 'uChanType'), ct);
    },
    config,
    params,
    name: 'xanalogtv',
  });
}
