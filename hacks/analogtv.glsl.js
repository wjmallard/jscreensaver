// analogtv.glsl.js — shared WebGL/GLSL port of xscreensaver's analogtv.c, the
// 2453-line CPU NTSC-television simulator that five hacks build on (vfeedback,
// xanalogtv, filmleader, m6502, pong). analogtv.c is NOT itself a hack (no
// XSCREENSAVER_MODULE); it's a shared library, so this is its shared module too.
//
// It exports GLSL *function* source (not whole shaders): a hack concatenates
// ATV_GLSL into each of its passes and supplies its own mainImage(). The genuine
// NTSC artifacts (dot crawl, chroma/luma crosstalk, color bleed, scanlines,
// bloom) come from running the real signal path — RGB -> YIQ -> band-limit ->
// QAM-modulate onto a 4x-colorburst subcarrier -> composite, then demodulate and
// low-pass back -> YIQ -> RGB + CRT model — not a cheap scanline overlay.
//
// The per-scanline Butterworth IIRs in analogtv.c can't run in a fragment shader
// (sequential along the line), so they're replaced by FIR convolutions whose taps
// are the IIRs' own impulse responses (see scratchpad/extract_kernels.mjs); DC
// gain ~= 1, so levels are preserved. Validated pixel-wise against analogtv-cli.
//
// SIGNAL SPACE: passes that work on the composite signal render at a fixed
// sample-accurate size (ATV_NS samples wide, where the subcarrier advances
// exactly 90 deg per texel, matching analogtv.c's 4x-fsc sampling) so the carrier
// is never undersampled. The final CRT pass upscales signal space to the canvas,
// applying scanlines/gamma/geometry at output resolution.
//
// See hacks/analogtv.md and the memory note analogtv-ntsc-shader-port.

// Samples across the visible picture (1 texel = one 90-degree carrier step).
// analogtv.c uses ANALOGTV_H=912/line; the active picture is ~755. 760 keeps the
// carrier ~190 cycles/line as on a real set while staying a clean buffer width.
export const ATV_NS = 760;
// NTSC visible scan lines (ANALOGTV_VISLINES), plus a little vertical overscan.
export const ATV_VISLINES = 200;
export const ATV_OVERSCAN = 6;
export const ATV_NL = ATV_VISLINES + 2 * ATV_OVERSCAN;

// Shared GLSL: constants, color matrices, kernels, encode/decode/CRT helpers.
// Carrier convention: phase = (PI/2)*sampleIndex, so cos cycles [1,0,-1,0] and
// sin [0,1,0,-1] on integer samples — exact quadrature at the 4x-fsc rate.
export const ATV_GLSL = `
const float ATV_PI = 3.14159265358979;
const float ATV_NS = ${ATV_NS}.0;
const float ATV_NL = ${ATV_NL}.0;
const float ATV_VISLINES = ${ATV_VISLINES}.0;
const float ATV_OVERSCAN = ${ATV_OVERSCAN}.0;

// NTSC RGB<->YIQ (coefficients verbatim from analogtv.c).
vec3 atv_rgb2yiq(vec3 c){
  return vec3(
    0.30*c.r + 0.59*c.g + 0.11*c.b,
    0.60*c.r - 0.28*c.g - 0.32*c.b,
    0.21*c.r - 0.52*c.g + 0.31*c.b);
}
vec3 atv_yiq2rgb(vec3 yiq){
  return vec3(
    yiq.x + 0.948*yiq.y + 0.624*yiq.z,
    yiq.x - 0.276*yiq.y - 0.639*yiq.z,
    yiq.x - 1.105*yiq.y + 1.729*yiq.z);
}

// FIR kernels = impulse responses of analogtv.c's IIR Butterworth filters.
// (k, peak index used to centre the causal kernel on the output sample.)
// Encode kernels live in ATV_ENCODE_GLSL (encode-only shaders) so the decode/
// final shaders that include ATV_GLSL don't carry an unresolved atv_source.
const int ATV_DEC_Y_L = 13;  const int ATV_DEC_Y_PK = 2;
float atv_decY(int k){
  float t[13] = float[13](0.04699,0.18796,0.30609,0.28457,0.17933,0.04633,
    -0.04558,-0.02755,0.01898,0.01257,-0.00842,-0.00562,0.00376);
  return t[k];
}
const int ATV_DEC_IQ_L = 11; const int ATV_DEC_IQ_PK = 2;
float atv_decIQ(int k){
  float t[11] = float[11](0.08333,0.25000,0.30556,0.25000,0.14815,0.0,
    -0.04938,0.0,0.01646,0.0,-0.00549);
  return t[k];
}

// Subcarrier at integer sample s.
float atv_carI(float s){ return cos(0.5*ATV_PI*s); }
float atv_carQ(float s){ return sin(0.5*ATV_PI*s); }

// White noise in [-1,1] keyed on sample/line/seed — the TV "snow" injected into
// the composite signal (analogtv_init_signal). After the Y low-pass it reads as
// luma speckle; through the chroma demod it picks up colour, like a real set.
float atv_noise(float s, float line, float seed){
  return fract(sin(dot(vec3(s, line, seed), vec3(12.9898, 78.233, 37.719)))
               * 43758.5453) * 2.0 - 1.0;
}

// DECODE: composite signal (sig, sample-space) -> linear RGB for line 'line',
// integer sample 's'. knobs = vec4(color, tint_radians, brightness, contrast).
vec3 atv_decode(sampler2D sig, int s, int line, vec4 knobs, float noiselevel, float seed){
  // Noise is part of the composite signal (analogtv_init_signal), so it runs
  // through the same demod the picture does — faithful to the .c.
  float Y=0.0, Ir=0.0, Qr=0.0;
  for(int k=0;k<ATV_DEC_Y_L;k++){
    int ss=s-k+ATV_DEC_Y_PK;
    Y += atv_decY(k)*(texelFetch(sig, ivec2(ss, line), 0).r
                      + noiselevel*atv_noise(float(ss), float(line), seed));
  }
  for(int k=0;k<ATV_DEC_IQ_L;k++){
    int ss=s-k+ATV_DEC_IQ_PK;
    float c=texelFetch(sig, ivec2(ss, line), 0).r
            + noiselevel*atv_noise(float(ss), float(line), seed);
    Ir += atv_decIQ(k)*c*atv_carI(float(ss));
    Qr += atv_decIQ(k)*c*atv_carQ(float(ss));
  }
  // analogtv_ntsc_to_yiq only demodulates chroma when a colourburst is present
  // (colormode = cb_i^2+cb_q^2 > 2.8, else i=q=0): a dead/snow channel has no
  // burst, so its noise stays MONOCHROME. We don't simulate the burst region, so
  // the hack gates chroma by passing color=0 for no-signal channels (and ramps it
  // up as a station locks in — the colour-lock that follows the picture).
  // Quadrature demod recovers I/2,Q/2 -> 2x; then tint rotation + colour gain.
  float color=knobs.x, tint=knobs.y, bright=knobs.z, contrast=knobs.w;
  float ct=cos(tint), st=sin(tint);
  float I = 2.0*(Ir*ct - Qr*st)*color;
  float Q = 2.0*(Ir*st + Qr*ct)*color;
  vec3 rgb = atv_yiq2rgb(vec3(Y + bright, I, Q)) * contrast;
  return max(rgb, 0.0);
}

// SCANLINE + gamma at output. 'frac' = vertical position within one scan line
// [0,1). Darkens the top/bottom of each line (analogtv.c leveltable) then applies
// the pow(.,0.8) gamma LUT. 'rgb' is linear decoded colour (white ~= 1.0).
vec3 atv_crt(vec3 rgb, float frac){
  // analogtv.c leveltable dims the top/bottom sub-rows of each scan line
  // (levelfac/256 = edge 0.127 vs mid 0.252). 'd' is 0 at the seam between
  // lines, 1 at a line's centre; dip to ~0.62 keeps a visible-but-not-harsh
  // scanline that scales with output resolution (always ATV_VISLINES lines).
  float d = min(frac, 1.0-frac) * 2.0;
  float prof = mix(0.62, 1.0, smoothstep(0.0, 0.75, d));
  return pow(clamp(rgb*prof, 0.0, 1.0), vec3(0.8));
}
`;

// Encode-only GLSL: include AFTER ATV_GLSL in an encode pass, and define
//   vec3 atv_source(vec2 uv);   (procedural pattern, or a sampled texture)
// then call atv_encode(sampleIndex, sourceV) to get the composite sample.
export const ATV_ENCODE_GLSL = `
vec3 atv_source(vec2 uv);   // provided by the including shader
const int ATV_ENC_Y_L = 13;  const int ATV_ENC_Y_PK = 3;
float atv_encY(int k){
  float t[13] = float[13](0.02895,0.13194,0.25936,0.30281,0.23632,0.10250,
    -0.01508,-0.03978,-0.00124,0.02046,0.00726,-0.00797,-0.00616);
  return t[k];
}
const int ATV_ENC_I_L = 13;  const int ATV_ENC_I_PK = 3;
float atv_encI(int k){
  float t[13] = float[13](0.02156,0.10077,0.20964,0.26714,0.24221,0.16482,
    0.07721,0.00932,-0.02759,-0.03690,-0.02910,-0.01512,-0.00266);
  return t[k];
}
const int ATV_ENC_Q_L = 21;  const int ATV_ENC_Q_PK = 9;
float atv_encQ(int k){
  float t[21] = float[21](0.00114,0.00635,0.01713,0.03162,0.04708,0.06154,
    0.07368,0.08273,0.08836,0.09055,0.08954,0.08574,0.07966,0.07184,0.06284,
    0.05321,0.04340,0.03384,0.02484,0.01667,0.00949);
  return t[k];
}
// One composite sample at integer sample 's' of the line at source-v 'v'.
// Band-limits Y/I/Q (separate chroma bandwidths) then QAM-modulates.
float atv_encode(float s, float v){
  float Y=0.0, I=0.0, Q=0.0;
  for(int k=0;k<ATV_ENC_Y_L;k++){
    float ss=s-float(k)+float(ATV_ENC_Y_PK);
    Y += atv_encY(k)*atv_rgb2yiq(atv_source(vec2((ss+0.5)/ATV_NS, v))).x;
  }
  for(int k=0;k<ATV_ENC_I_L;k++){
    float ss=s-float(k)+float(ATV_ENC_I_PK);
    I += atv_encI(k)*atv_rgb2yiq(atv_source(vec2((ss+0.5)/ATV_NS, v))).y;
  }
  for(int k=0;k<ATV_ENC_Q_L;k++){
    float ss=s-float(k)+float(ATV_ENC_Q_PK);
    Q += atv_encQ(k)*atv_rgb2yiq(atv_source(vec2((ss+0.5)/ATV_NS, v))).z;
  }
  return Y + I*atv_carI(s) + Q*atv_carQ(s);
}
`;

// ===========================================================================
// startAnalogTV(hostCanvas, opts) — shared harness that runs the NTSC pipeline.
//
// opts:
//   source      GLSL defining `vec3 atv_source(vec2 uv)` (the picture content;
//               uv in [0,1], y-down). May use uTime/uFrame/uPrev + custom uniforms.
//   decl        extra `uniform ...;` lines for the encode (source) pass.
//   feedback    true if atv_source samples uPrev (the previous final frame).
//   setUniforms (gl, encProgram, ctx) => void — set custom encode uniforms/frame.
//   frameKnobs  (ctx) => {color,tint,brightness,contrast,noise,seed} (all optional;
//               merged over config) — lets a hack vary knobs/snow per channel.
//   config, params, name
//   config.fps  pipeline update rate (default 30, TV-authentic; also makes the
//               feedback fold rate independent of display refresh).
//
// Returns { stop, pause, resume, reinit, getStats, config, params }.
// ===========================================================================
// (ATV_GLSL/ATV_ENCODE_GLSL/ATV_NS/ATV_NL are defined above in this module.)

const ATV_VS = `#version 300 es
void main(){ vec2 v=vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position=vec4(v*2.0-1.0,0.0,1.0); }`;
const ATV_HEAD = `#version 300 es
precision highp float; precision highp int;
out vec4 o;
`;

// Decode pass: composite (sample space) -> linear RGB (sample space).
const ATV_DEC_MAIN = `
uniform sampler2D uSig;
uniform vec4 uKnobs;     // color, tint(rad), brightness, contrast
uniform float uNoise;
uniform float uSeed;
void main(){
  int s = int(floor(gl_FragCoord.x));
  int line = int(floor(gl_FragCoord.y));
  o = vec4(atv_decode(uSig, s, line, uKnobs, uNoise, uSeed), 1.0);
}`;

// Final pass: decoded RGB (sample space) -> screen with the CRT geometry model
// (vertical roll / horizontal tear / bar-bend from analogtv.c's sync handling),
// scanlines, and gamma. Vertical flip (WebGL y-up) puts the picture top up.
// All distortion uniforms default to 0 -> a clean, locked picture (unchanged).
const ATV_FIN_MAIN = `
uniform sampler2D uDec;
uniform vec2 uOut;
uniform float uBend;     // top-of-frame horizontal bar-bend (shiftthisrow)
uniform float uRoll;     // vertical roll offset [0,1) — loss of vertical sync
uniform float uRolling;  // 1 = draw the dark blanking bar at the roll seam
uniform float uSlant;    // loss of horizontal sync: per-line diagonal tear
uniform float uHdrift;   // loss of horizontal sync: whole-picture horizontal slide
void main(){
  vec2 uv = gl_FragCoord.xy/uOut;
  float ntscY = (1.0-uv.y)*ATV_VISLINES;            // 0..200, 0 = top
  // Vertical roll: scroll the field; a dark blanking bar rides the wrap seam.
  float rolled = fract(ntscY/ATV_VISLINES + uRoll);
  float bar = mix(1.0,
                  smoothstep(0.0,0.05,rolled) * (1.0 - smoothstep(0.93,1.0,rolled)),
                  clamp(uRolling,0.0,1.0));
  float sl = rolled * ATV_VISLINES;
  // Horizontal: top bar-bend (decays down the screen) + hsync tear + drift.
  float bend = uBend * exp(-0.17*sl) * (0.7 + cos(sl*0.6));
  float u = uv.x + bend + uSlant*(rolled - 0.5) + uHdrift;
  vec3 dec = (u < 0.0 || u > 1.0) ? vec3(0.0)
             : texture(uDec, vec2(u, (ATV_OVERSCAN + sl)/ATV_NL)).rgb;
  o = vec4(atv_crt(dec * bar, fract(sl)), 1.0);
}`;

export function startAnalogTV(hostCanvas, opts) {
  const {
    source, decl = '', feedback = false, images = [],
    setUniforms, frameKnobs,
    config = {}, params = [], name = 'analogtv',
  } = opts;

  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    powerPreference: 'high-performance', preserveDrawingBuffer: false,
  });
  if (!gl) {
    console.error(`${name}: WebGL2 required but unavailable.`);
    return { stop() { canvas.remove(); }, pause() {}, resume() {}, reinit() {}, getStats: () => ({}), config, params };
  }
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');

  // External images (bundled TV test cards): the picture content for xanalogtv's
  // image channels and the feedback seed for vfeedback. Bound to texture units
  // >= 2 (0 = signal/decoded, 1 = uPrev). Each starts as a 1x1 black placeholder
  // and is replaced when the PNG finishes loading; uImagesReady flags when all
  // are in, so a hack can hold a "no signal" state until then.
  const imgTex = images.map(() => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  });
  let imagesReady = 0;
  images.forEach((url, i) => {
    const im = new Image();
    im.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, imgTex[i]);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
      imagesReady++;
    };
    im.onerror = () => console.error(`${name}: image failed to load: ${url}`);
    im.src = url;
  });

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      throw new Error(`${name} shader:\n${log}\n` +
        src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
    }
    return s;
  }
  function program(fsrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, ATV_VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name} link:\n${gl.getProgramInfoLog(p)}`);
    return p;
  }

  const imgDecl = images.map((_, i) => `uniform sampler2D uImage${i};`).join('\n') +
    (images.length ? '\nuniform float uImagesReady;' : '');
  const encSrc = ATV_HEAD +
    `uniform float uTime; uniform int uFrame; uniform sampler2D uPrev; uniform vec2 uPrevRes;\n` +
    imgDecl + '\n' + decl + '\n' + ATV_GLSL + ATV_ENCODE_GLSL + '\n' + source + `
void main(){
  float s = floor(gl_FragCoord.x);
  float v = floor(gl_FragCoord.y)/ATV_NL;
  o = vec4(atv_encode(s, v), 0.0, 0.0, 1.0);
}`;
  const pEnc = program(encSrc);
  const pDec = program(ATV_HEAD + ATV_GLSL + ATV_DEC_MAIN);
  const pFin = program(ATV_HEAD + ATV_GLSL + ATV_FIN_MAIN);
  // AGC probe: copy the final frame into an RGBA8 mip chain so its 1x1 top level
  // is the mean colour (feedback hacks only — see the auto-gain servo below).
  const pCopy = feedback
    ? program(ATV_HEAD + `uniform sampler2D uTex; uniform vec2 uOut;
void main(){ o = texture(uTex, gl_FragCoord.xy/uOut); }`)
    : null;

  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);

  function makeTex(w, h) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  const mkFbo = (t) => { const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return f; };

  // Fixed sample-accurate signal buffers (decoupled from canvas size).
  const sigTex = makeTex(ATV_NS, ATV_NL), sigFbo = mkFbo(sigTex);
  const decTex = makeTex(ATV_NS, ATV_NL), decFbo = mkFbo(decTex);

  // Canvas-res final ping-pong (only needed for self-feedback hacks).
  let finTex = [null, null], finFbo = [null, null], finW = 0, finH = 0, cur = 0;
  // AGC probe targets: an RGBA8 mip chain + a framebuffer onto its 1x1 top level.
  let mfTex = null, mfFbo = null, readFbo = null, maxLevel = 0;
  const readPx = new Uint8Array(4);
  function ensureFinal(w, h) {
    if (!feedback) return;
    if (w === finW && h === finH && finTex[0]) return;
    for (const t of finTex) if (t) gl.deleteTexture(t);
    for (const f of finFbo) if (f) gl.deleteFramebuffer(f);
    if (mfTex) gl.deleteTexture(mfTex);
    if (mfFbo) gl.deleteFramebuffer(mfFbo);
    if (readFbo) gl.deleteFramebuffer(readFbo);
    finTex = [makeTex(w, h), makeTex(w, h)];
    finFbo = [mkFbo(finTex[0]), mkFbo(finTex[1])];
    // Mipmapped RGBA8 copy target for the brightness measurement.
    mfTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, mfTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    mfFbo = mkFbo(mfTex);
    maxLevel = Math.floor(Math.log2(Math.max(w, h)));
    readFbo = gl.createFramebuffer();
    finW = w; finH = h; cur = 0;
  }

  const loc = (p, n) => gl.getUniformLocation(p, n);
  function syncSize() {
    const dpr = window.devicePixelRatio || 1;
    const scale = config.resolution == null ? 1 : config.resolution;
    const w = Math.max(1, Math.round(window.innerWidth * dpr * scale));
    const h = Math.max(1, Math.round(window.innerHeight * dpr * scale));
    if (w !== canvas.width || h !== canvas.height) { canvas.width = w; canvas.height = h; }
    return [w, h];
  }

  let clockMs = config.startClock != null ? config.startClock : Math.random() * 60000;
  let frame = 0, rafId = 0, lastNow = 0, acc = 0;
  let agcGain = 1.0;            // auto-gain (analogtv agclevel); servoed each frame
  const stats = { ms: 16 };

  function knob(k, d) { const v = (frameState && frameState[k] != null) ? frameState[k] : config[k]; return v == null ? d : v; }
  let frameState = null;

  function runPipeline(w, h, tSec) {
    const ctx = { time: tSec, frame, w, h };
    frameState = frameKnobs ? (frameKnobs(ctx) || {}) : {};

    // --- Encode: source -> composite (sample space) ---
    gl.useProgram(pEnc);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sigFbo); gl.viewport(0, 0, ATV_NS, ATV_NL);
    gl.uniform1f(loc(pEnc, 'uTime'), tSec);
    gl.uniform1i(loc(pEnc, 'uFrame'), frame);
    if (feedback) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, finTex[1 - cur] || finTex[0]);
      gl.uniform1i(loc(pEnc, 'uPrev'), 1);
      gl.uniform2f(loc(pEnc, 'uPrevRes'), finW, finH);
    }
    for (let i = 0; i < imgTex.length; i++) {
      gl.activeTexture(gl.TEXTURE2 + i);
      gl.bindTexture(gl.TEXTURE_2D, imgTex[i]);
      gl.uniform1i(loc(pEnc, `uImage${i}`), 2 + i);
    }
    if (imgTex.length) gl.uniform1f(loc(pEnc, 'uImagesReady'), imagesReady >= imgTex.length ? 1.0 : 0.0);
    if (setUniforms) setUniforms(gl, pEnc, ctx);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // --- Decode: composite -> linear RGB (sample space) ---
    gl.useProgram(pDec);
    gl.bindFramebuffer(gl.FRAMEBUFFER, decFbo); gl.viewport(0, 0, ATV_NS, ATV_NL);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sigTex);
    gl.uniform1i(loc(pDec, 'uSig'), 0);
    gl.uniform4f(loc(pDec, 'uKnobs'),
      knob('color', 1.0), knob('tint', 0.0) * Math.PI / 180, knob('brightness', -0.05),
      knob('contrast', 1.4) * (feedback ? agcGain : 1.0));
    gl.uniform1f(loc(pDec, 'uNoise'), knob('noise', 0.0));
    gl.uniform1f(loc(pDec, 'uSeed'), (frame % 1024) + 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // --- Final: decoded -> screen (or ping-pong FBO for feedback) ---
    gl.useProgram(pFin);
    const target = feedback ? finFbo[cur] : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, decTex);
    gl.uniform1i(loc(pFin, 'uDec'), 0);
    gl.uniform2f(loc(pFin, 'uOut'), w, h);
    gl.uniform1f(loc(pFin, 'uBend'), knob('bend', 0));
    gl.uniform1f(loc(pFin, 'uRoll'), knob('roll', 0));
    gl.uniform1f(loc(pFin, 'uRolling'), knob('rolling', 0));
    gl.uniform1f(loc(pFin, 'uSlant'), knob('slant', 0));
    gl.uniform1f(loc(pFin, 'uHdrift'), knob('hdrift', 0));
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (feedback) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, finFbo[cur]);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // --- AGC (analogtv agclevel = 1/signal_level): measure the mean frame
      // brightness and servo the decode gain toward a target so the feedback
      // loop self-stabilizes (no collapse-to-black, no runaway white-out). ---
      gl.useProgram(pCopy);
      gl.bindFramebuffer(gl.FRAMEBUFFER, mfFbo); gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, finTex[cur]);
      gl.uniform1i(loc(pCopy, 'uTex'), 0);
      gl.uniform2f(loc(pCopy, 'uOut'), w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, mfTex, maxLevel);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, readPx);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const luma = (0.30 * readPx[0] + 0.59 * readPx[1] + 0.11 * readPx[2]) / 255;
      const target = (config.agcTarget == null ? 0.45 : config.agcTarget);
      // Rate-limited multiplicative servo; clamp the absolute gain for safety.
      const adj = Math.min(1.12, Math.max(0.90, target / Math.max(luma, 0.01)));
      agcGain = Math.min(8.0, Math.max(0.2, agcGain * adj));

      cur ^= 1;
    }
    frame++;
  }

  const stepMs = 1000 / (config.fps || 30);
  function render(now) {
    const [w, h] = syncSize();
    ensureFinal(w, h);
    if (lastNow === 0) lastNow = now;
    let dt = now - lastNow; lastNow = now;
    if (dt < 0) dt = 0; if (dt > 250) dt = 250;
    stats.ms += (dt - stats.ms) * 0.1;
    const speed = config.speed == null ? 1 : config.speed;
    acc += dt;
    if (acc >= stepMs) {
      // Advance at most a couple of steps to avoid bursts after a stall.
      let steps = 0;
      while (acc >= stepMs && steps < 2) { clockMs += stepMs * speed; runPipeline(w, h, clockMs / 1000); acc -= stepMs; steps++; }
      if (acc > stepMs) acc = 0;
    } else if (feedback && finTex[1 - cur]) {
      // Between TV frames, re-show the last field so the canvas isn't black.
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, finFbo[1 - cur]);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    rafId = requestAnimationFrame(render);
  }

  const onResize = () => { syncSize(); };
  window.addEventListener('resize', onResize);
  rafId = requestAnimationFrame(render);

  return {
    stop() {
      if (rafId) cancelAnimationFrame(rafId); rafId = 0;
      window.removeEventListener('resize', onResize);
      for (const p of [pEnc, pDec, pFin]) gl.deleteProgram(p);
      gl.deleteTexture(sigTex); gl.deleteTexture(decTex);
      gl.deleteFramebuffer(sigFbo); gl.deleteFramebuffer(decFbo);
      for (const t of finTex) if (t) gl.deleteTexture(t);
      for (const f of finFbo) if (f) gl.deleteFramebuffer(f);
      for (const t of imgTex) gl.deleteTexture(t);
      if (mfTex) gl.deleteTexture(mfTex);
      if (mfFbo) gl.deleteFramebuffer(mfFbo);
      if (readFbo) gl.deleteFramebuffer(readFbo);
      const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      canvas.remove();
    },
    pause() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } },
    resume() { if (!rafId) { lastNow = 0; acc = 0; rafId = requestAnimationFrame(render); } },
    reinit() { clockMs = Math.random() * 600000; },
    getStats() { return { ms: stats.ms, w: canvas.width, h: canvas.height }; },
    config, params,
  };
}
