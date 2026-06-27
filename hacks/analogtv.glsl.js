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
vec3 atv_decode(sampler2D sig, int s, int line, vec4 knobs, float noiselevel, float seed, float agc){
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
  // AGC (analogtv agclevel = 1/rx_signal_level) scales the luma path only -- the
  // chroma demod (multiq2) carries no agclevel in analogtv_ntsc_to_yiq -- so a
  // weak/dead channel boosts its snow toward full brightness without tinting it.
  vec3 rgb = atv_yiq2rgb(vec3(Y * agc + bright, I, Q)) * contrast;
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
//               uv in [0,1], y-down). May use uTime/uFrame + custom uniforms.
//   decl        extra `uniform ...;` lines for the encode (source) pass.
//   setUniforms (gl, encProgram, ctx) => void — set custom encode uniforms/frame.
//   frameKnobs  (ctx) => {color,tint,brightness,contrast,noise,seed} (all optional;
//               merged over config) — lets a hack vary knobs/snow per channel.
//   config, params, name
//   config.fps  pipeline update rate (default 30, TV-authentic; keeps the cadence
//               independent of display refresh).
//   (Self-feedback support — atv_source reading the previous final frame — was
//    sliced out 2026-06-27; the full machinery is archived in hacks/shelved/vfeedback.md.)
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
uniform float uAgc;      // agclevel = 1/rx_signal_level (luma gain)
void main(){
  int s = int(floor(gl_FragCoord.x));
  int line = int(floor(gl_FragCoord.y));
  o = vec4(atv_decode(uSig, s, line, uKnobs, uNoise, uSeed, uAgc), 1.0);
}`;

// Ghost pass: RF multipath echo (analogtv_add_signal's ghostfir). Adds, to each
// composite sample, a weighted sum of four box-summed groups of 4 samples at
// lags 4/8/12/16 (= 1..4 colour-subcarrier cycles) -- a faint, slightly delayed
// copy of the picture to the right, like a long monitor cable. uGhostFir holds
// the four tap weights (analogtv reception_update). Runs between encode/decode.
//
// uHfloss is analogtv's high-frequency loss: each sample mixes in uHfloss * the
// sample 2 away (180 deg of subcarrier) within its 4-sample group. That neighbour
// is in phase for luma and antiphase for chroma, so a positive value lifts luma
// and washes out colour (a negative one does the reverse) -- a wavering softness
// on a weak/multipath signal. analogtv gates this behind `if (0)`; revived here,
// driven per channel from the multipath strength.
const ATV_GHOST_MAIN = `
uniform sampler2D uSig;
uniform vec4 uGhostFir;
uniform float uHfloss;
void main(){
  int s = int(floor(gl_FragCoord.x));
  int line = int(floor(gl_FragCoord.y));
  float v = texelFetch(uSig, ivec2(s, line), 0).r;
  float ghost = 0.0;
  for (int k=0;k<4;k++){
    int lag = 4*(k+1);
    float bs = 0.0;
    for (int j=0;j<4;j++) bs += texelFetch(uSig, ivec2(s-lag+j, line), 0).r;
    ghost += uGhostFir[k]*bs;
  }
  // hfloss: mix in the sample 2 away within the 4-aligned subcarrier group (+2 in
  // the first half of the group, -2 in the second), as analogtv_add_signal's
  // p[i] += sig[(i+2)&3] * hfloss.
  int partner = ((s & 3) < 2) ? s + 2 : s - 2;
  float hf = texelFetch(uSig, ivec2(partner, line), 0).r;
  o = vec4(v + ghost + uHfloss*hf, 0.0, 0.0, 1.0);
}`;

// Bloom precompute, part 1 (reduce): mean luma of each decoded scan line -> a
// 1 x ATV_NL column. Feeds the crtload IIR below.
const ATV_REDUCE_MAIN = `
uniform sampler2D uDec;
void main(){
  int line = int(floor(gl_FragCoord.y));
  float sum = 0.0; int n = 0;
  for (int x=0; x<int(ATV_NS); x+=4){
    sum += dot(texelFetch(uDec, ivec2(x, line), 0).rgb, vec3(0.30,0.59,0.11));
    n++;
  }
  o = vec4(sum/float(n), 0.0, 0.0, 1.0);
}`;

// Bloom precompute, part 2 (crtload): the flyback-load IIR from analogtv_draw,
//   crtload[l] = 0.95*crtload[l-1] + 0.05*(baseload + (totsignal-30000)/1e5 + squeeze)
// run as the equivalent 0.95^j FIR over the line-luma column. Unit bridge: with
// PIC_LEN=755, BLACK=10, WHITE=100, the IRE totsignal maps to mean displayed luma
// as (totsignal-30000)/1e5 = 0.6795*meanY - 0.2245, and baseload=0.5; lines above
// the picture sit at baseload (the crtload[TOP-1] boundary). squeezebottom adds
// extra load at the bottom rows.
const ATV_CRTLOAD_MAIN = `
uniform sampler2D uLuma;
uniform float uSqueezeBottom;
void main(){
  int l = int(floor(gl_FragCoord.y));
  float crt = 0.0, w = 0.05;
  for (int j=0; j<90; j++){
    int m = l - j;
    float cin;
    if (m < int(ATV_OVERSCAN) || m >= int(ATV_NL)) {
      cin = 0.5;                                  // baseload boundary above/below
    } else {
      float meanY = texelFetch(uLuma, ivec2(0, m), 0).r;
      float slsrc = float(m) - ATV_OVERSCAN;
      float sq = slsrc > 184.0 ? (slsrc-184.0)*(slsrc-184.0)*0.001*uSqueezeBottom : 0.0;
      cin = 0.2755 + 0.6795*meanY + sq;
    }
    crt += w * cin;
    w *= 0.95;
  }
  o = vec4(crt, 0.0, 0.0, 1.0);
}`;

// Two-station overlay: a second station's composite (in uSigB), added to the main
// signal at a wrapped (x,y) sample offset and a fainter level (analogtv's second
// reception with its own rec->ofs). Drawn with additive blending onto the main
// signal. Because it carries its own carrier phase via the shift, it demodulates
// to slightly off colours -- the classic co-channel ghost / interference beat.
const ATV_ADDB_MAIN = `
uniform sampler2D uSigB;
uniform float uMixB;
uniform vec2 uOfs;
void main(){
  int NS = ${ATV_NS}, NL = ${ATV_NL};
  int s = int(floor(gl_FragCoord.x));
  int line = int(floor(gl_FragCoord.y));
  int bs = ((s - int(uOfs.x)) % NS + NS) % NS;
  int bl = ((line - int(uOfs.y)) % NL + NL) % NL;
  o = vec4(uMixB * texelFetch(uSigB, ivec2(bs, bl), 0).r, 0.0, 0.0, 1.0);
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
uniform float uPuheight; // power-on vertical fill: 0 = collapsed to a centre line, 1 = full
uniform float uPuwidth;  // power-on horizontal fill (scanwidth ramp)
uniform float uPubright;  // power-on brightness ramp (the bright thin line while warming up)
uniform float uTtxSeed;  // per-frame randomiser for the teletext VBI dots
uniform sampler2D uCrtload; // per-line flyback load (bloom), 1 x ATV_NL
uniform float uBloom;    // 1 = apply bloom horizontal breathing
void main(){
  vec2 uv = gl_FragCoord.xy/uOut;
  // Power-on warm-up (analogtv.c puramp/puheight): the picture grows out of a
  // bright horizontal line at screen centre. Squeeze screen space into the centre
  // band (overall_top..overall_bot) and blank the surround; un-squish to sample.
  float yc = (uv.y - 0.5) / max(uPuheight, 1e-4) + 0.5;
  float xc = (uv.x - 0.5) / max(uPuwidth, 1e-4) + 0.5;
  if (yc < 0.0 || yc > 1.0 || xc < 0.0 || xc > 1.0) { o = vec4(0.0,0.0,0.0,1.0); return; }
  float ntscY = (1.0-yc)*ATV_VISLINES;              // 0..200, 0 = top
  // Vertical roll: scroll the field; a dark blanking bar rides the wrap seam.
  float rolled = fract(ntscY/ATV_VISLINES + uRoll);
  float bar = mix(1.0,
                  smoothstep(0.0,0.05,rolled) * (1.0 - smoothstep(0.93,1.0,rolled)),
                  clamp(uRolling,0.0,1.0));
  float sl = rolled * ATV_VISLINES;
  // Bloom (analogtv crtload): brighter lines load the flyback and widen the scan,
  // so the picture breathes slightly smaller when bright. hscale<=1 keeps it
  // filling the screen (a small overscan rides the breathing, so no black bars).
  float hscale = 1.0;
  if (uBloom > 0.5) {
    float crt = texelFetch(uCrtload, ivec2(0, int(ATV_OVERSCAN + sl)), 0).r;
    float bloomthisrow = clamp(-10.0*crt, -10.0, 2.0);
    hscale = min(1.0, (0.79 - 0.006623*bloomthisrow) / 0.853);
  }
  // Horizontal: top bar-bend (decays down the screen) + hsync tear + drift.
  float bend = uBend * exp(-0.17*sl) * (0.7 + cos(sl*0.6));
  float u = 0.5 + (xc - 0.5)*hscale + bend + uSlant*(rolled - 0.5) + uHdrift;
  // Right-edge squish + brighten (analogtv squishright_i / squishdiv): the beam
  // slows toward the right, compressing and brightening the last sliver of each
  // line. Mostly overscanned off a real set, so keep it subtle; remap WITHIN the
  // zone so content squeezes toward the edge but still fills it (no black gap).
  float sqBright = 1.0;
  if (u > 0.92) {
    float t = (u - 0.92) / 0.08;       // 0..1 across the right-edge zone
    u = 0.92 + 0.08 * t * t;           // squeeze content rightward, reaching u=1.0
    sqBright = 1.0 + t * 0.30;
  }
  vec3 dec = (u < 0.0 || u > 1.0) ? vec3(0.0)
             : texture(uDec, vec2(u, (ATV_OVERSCAN + sl)/ATV_NL)).rgb;
  vec3 col = atv_crt(dec * bar * uPubright * sqBright, fract(sl));
  // Teletext: random black/white dots in the vertical-blank lines, only ever
  // glimpsed in the dark bar as the picture rolls (analogtv_setup_teletext).
  if (uRolling > 0.5) {
    float band = 1.0 - smoothstep(0.015, 0.05, rolled);   // thin band at the field top
    if (band > 0.0) {
      float cell = floor(u * ATV_NS / 6.0);
      float dr = fract(sin(dot(vec3(cell, floor(sl), uTtxSeed), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      col = mix(col, vec3(step(0.5, dr)), band * 0.85);
    }
  }
  o = vec4(col, 1.0);
}`;

// Power-on ramp, verbatim from analogtv.c puramp(): a squared (1-e^-t) curve
// that stays 0 until 'start' seconds after power-on, then eases to 1 (the 'over'
// factor overshoots so it reaches 1 a touch sooner, still clamped). Drives the
// vertical fill, scan width, and brightness as the set warms up.
function puramp(powerup, tc, start, over) {
  const pt = powerup - start;
  if (pt < 0.0) return 0.0;
  if (pt > 900.0 || pt / tc > 8.0) return 1.0;
  const r = (1.0 - Math.exp(-pt / tc)) * over;
  return r > 1.0 ? 1.0 : r * r;
}

export function startAnalogTV(hostCanvas, opts) {
  const {
    source, decl = '', ghost = false, bloom = false, twoStation = false, images = [],
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
  // image channels (logo, test cards, the live station-ID canvas). Bound to texture
  // units >= 2 (0 = signal/decoded, 1 = reserved). Each starts as a 1x1 black
  // placeholder and is replaced when the PNG finishes loading; uImagesReady flags
  // when all are in, so a hack can hold a "no signal" state until then.
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
  // An images[] entry is either a URL string (a PNG, loaded once) or { canvas }
  // for a hack-drawn live texture that the harness re-uploads every frame (e.g.
  // xanalogtv's station ID + running clock). uImagesReady waits only on the URLs.
  const imgCanvas = images.map((x) => (x && x.canvas) ? x.canvas : null);
  let imagesReady = 0, staticImages = 0;
  images.forEach((url, i) => {
    if (imgCanvas[i]) return;
    staticImages++;
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
    `uniform float uTime; uniform int uFrame;\n` +
    imgDecl + '\n' + decl + '\n' + ATV_GLSL + ATV_ENCODE_GLSL + '\n' + source + `
void main(){
  float s = floor(gl_FragCoord.x);
  float v = floor(gl_FragCoord.y)/ATV_NL;
  o = vec4(atv_encode(s, v), 0.0, 0.0, 1.0);
}`;
  const pEnc = program(encSrc);
  const pDec = program(ATV_HEAD + ATV_GLSL + ATV_DEC_MAIN);
  const pFin = program(ATV_HEAD + ATV_GLSL + ATV_FIN_MAIN);
  const pGhost = ghost ? program(ATV_HEAD + ATV_GHOST_MAIN) : null;
  const pReduce = bloom ? program(ATV_HEAD + ATV_GLSL + ATV_REDUCE_MAIN) : null;
  const pCrtload = bloom ? program(ATV_HEAD + ATV_GLSL + ATV_CRTLOAD_MAIN) : null;
  const pAddB = twoStation ? program(ATV_HEAD + ATV_ADDB_MAIN) : null;

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
  // Optional post-encode ghost (multipath) buffer; decode reads it when enabled.
  const sig2Tex = ghost ? makeTex(ATV_NS, ATV_NL) : null;
  const sig2Fbo = ghost ? mkFbo(sig2Tex) : null;
  // Optional bloom precompute buffers: per-line mean luma -> crtload (both 1 x NL).
  const lumaTex = bloom ? makeTex(1, ATV_NL) : null;
  const lumaFbo = bloom ? mkFbo(lumaTex) : null;
  const crtloadTex = bloom ? makeTex(1, ATV_NL) : null;
  const crtloadFbo = bloom ? mkFbo(crtloadTex) : null;
  // Optional second-station composite buffer (two-station overlay).
  const sigBTex = twoStation ? makeTex(ATV_NS, ATV_NL) : null;
  const sigBFbo = twoStation ? mkFbo(sigBTex) : null;

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
  let powerupSec = 0;           // seconds since power-on (analogtv.c it->powerup)
  let powerupWas = false;       // previous config.powerup, to re-arm on toggle
  let frame = 0, rafId = 0, lastNow = 0, acc = 0;
  const stats = { ms: 16 };

  function knob(k, d) { const v = (frameState && frameState[k] != null) ? frameState[k] : config[k]; return v == null ? d : v; }
  let frameState = null;

  function runPipeline(w, h, tSec) {
    const ctx = { time: tSec, frame, w, h, pass: 0 };
    frameState = frameKnobs ? (frameKnobs(ctx) || {}) : {};

    // Power-on warm-up (analogtv.c): puheight squeezes the picture into a centre
    // band that grows to full; pubright keeps the early thin line bright. Opt-in
    // via config.powerup; re-armed on each off->on so toggling it replays.
    if (config.powerup && !powerupWas) powerupSec = 0;
    powerupWas = !!config.powerup;
    powerupSec += 1 / (config.fps || 30);
    const pu = config.powerup ? powerupSec : 999;
    const puheight = puramp(pu, 2.0, 1.0, 1.3) * (1.125 - 0.125 * puramp(pu, 2.0, 2.0, 1.1));
    const puwidth = puramp(pu, 0.5, 0.3, 1.0);
    const pubright = puramp(pu, 1.0, 0.0, 1.0) / (0.5 + 0.5 * puheight);

    // --- Encode: source -> composite (sample space) ---
    gl.useProgram(pEnc);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sigFbo); gl.viewport(0, 0, ATV_NS, ATV_NL);
    gl.uniform1f(loc(pEnc, 'uTime'), tSec);
    gl.uniform1i(loc(pEnc, 'uFrame'), frame);
    for (let i = 0; i < imgTex.length; i++) {
      gl.activeTexture(gl.TEXTURE2 + i);
      gl.bindTexture(gl.TEXTURE_2D, imgTex[i]);
      if (imgCanvas[i] && imgCanvas[i].width > 0) {     // live canvas: re-upload
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imgCanvas[i]);
      }
      gl.uniform1i(loc(pEnc, `uImage${i}`), 2 + i);
    }
    if (imgTex.length) gl.uniform1f(loc(pEnc, 'uImagesReady'), imagesReady >= staticImages ? 1.0 : 0.0);
    if (setUniforms) setUniforms(gl, pEnc, ctx);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // --- Two stations: encode a second station (pass 1) and add it into the
    // composite at a wrapped, drifting offset and fainter level (co-channel ghost).
    if (twoStation && frameState && frameState.mixB > 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, sigBFbo); gl.viewport(0, 0, ATV_NS, ATV_NL);
      ctx.pass = 1;
      if (setUniforms) setUniforms(gl, pEnc, ctx);   // hack sets the 2nd station's uniforms
      ctx.pass = 0;
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.useProgram(pAddB);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sigFbo); gl.viewport(0, 0, ATV_NS, ATV_NL);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sigBTex);
      gl.uniform1i(loc(pAddB, 'uSigB'), 0);
      gl.uniform1f(loc(pAddB, 'uMixB'), frameState.mixB);
      gl.uniform2f(loc(pAddB, 'uOfs'), frameState.ofsX || 0, frameState.ofsY || 0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);
      gl.useProgram(pEnc);   // restore for any following frame symmetry
    }

    // --- Ghost: add RF multipath echo to the composite (optional) ---
    let decSrcTex = sigTex;
    if (ghost) {
      gl.useProgram(pGhost);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sig2Fbo); gl.viewport(0, 0, ATV_NS, ATV_NL);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sigTex);
      gl.uniform1i(loc(pGhost, 'uSig'), 0);
      const gf = (frameState && frameState.ghostfir) || [0, 0, 0, 0];
      gl.uniform4f(loc(pGhost, 'uGhostFir'), gf[0], gf[1], gf[2], gf[3]);
      gl.uniform1f(loc(pGhost, 'uHfloss'), (frameState && frameState.hfloss) || 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      decSrcTex = sig2Tex;
    }

    // --- Decode: composite -> linear RGB (sample space) ---
    gl.useProgram(pDec);
    gl.bindFramebuffer(gl.FRAMEBUFFER, decFbo); gl.viewport(0, 0, ATV_NS, ATV_NL);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, decSrcTex);
    gl.uniform1i(loc(pDec, 'uSig'), 0);
    gl.uniform4f(loc(pDec, 'uKnobs'),
      knob('color', 1.0), knob('tint', 0.0) * Math.PI / 180, knob('brightness', -0.05),
      knob('contrast', 1.4));
    gl.uniform1f(loc(pDec, 'uNoise'), knob('noise', 0.0));
    gl.uniform1f(loc(pDec, 'uSeed'), (frame % 1024) + 1);
    // Signal-level AGC (agclevel = 1/level), the faithful per-frame scalar from the
    // reception strength, applied to the luma path only.
    gl.uniform1f(loc(pDec, 'uAgc'), knob('agc', 1.0));
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // --- Bloom precompute: line-luma reduce -> crtload IIR (optional) ---
    if (bloom) {
      gl.useProgram(pReduce);
      gl.bindFramebuffer(gl.FRAMEBUFFER, lumaFbo); gl.viewport(0, 0, 1, ATV_NL);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, decTex);
      gl.uniform1i(loc(pReduce, 'uDec'), 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.useProgram(pCrtload);
      gl.bindFramebuffer(gl.FRAMEBUFFER, crtloadFbo); gl.viewport(0, 0, 1, ATV_NL);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, lumaTex);
      gl.uniform1i(loc(pCrtload, 'uLuma'), 0);
      gl.uniform1f(loc(pCrtload, 'uSqueezeBottom'), knob('squeezebottom', 0));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // --- Final: decoded -> screen ---
    gl.useProgram(pFin);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, decTex);
    gl.uniform1i(loc(pFin, 'uDec'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, crtloadTex || decTex);
    gl.uniform1i(loc(pFin, 'uCrtload'), 1);
    gl.uniform1f(loc(pFin, 'uBloom'), bloom ? 1.0 : 0.0);
    gl.uniform2f(loc(pFin, 'uOut'), w, h);
    gl.uniform1f(loc(pFin, 'uBend'), knob('bend', 0));
    gl.uniform1f(loc(pFin, 'uRoll'), knob('roll', 0));
    gl.uniform1f(loc(pFin, 'uRolling'), knob('rolling', 0));
    gl.uniform1f(loc(pFin, 'uSlant'), knob('slant', 0));
    gl.uniform1f(loc(pFin, 'uHdrift'), knob('hdrift', 0));
    gl.uniform1f(loc(pFin, 'uPuheight'), puheight);
    gl.uniform1f(loc(pFin, 'uPuwidth'), puwidth);
    gl.uniform1f(loc(pFin, 'uPubright'), pubright);
    gl.uniform1f(loc(pFin, 'uTtxSeed'), frame % 1009);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    frame++;
  }

  const stepMs = 1000 / (config.fps || 30);
  function render(now) {
    const [w, h] = syncSize();
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
      for (const p of [pEnc, pDec, pFin, pGhost, pReduce, pCrtload, pAddB]) if (p) gl.deleteProgram(p);
      gl.deleteTexture(sigTex); gl.deleteTexture(decTex);
      gl.deleteFramebuffer(sigFbo); gl.deleteFramebuffer(decFbo);
      if (sig2Tex) gl.deleteTexture(sig2Tex);
      if (sig2Fbo) gl.deleteFramebuffer(sig2Fbo);
      for (const t of [lumaTex, crtloadTex, sigBTex]) if (t) gl.deleteTexture(t);
      for (const f of [lumaFbo, crtloadFbo, sigBFbo]) if (f) gl.deleteFramebuffer(f);
      for (const t of imgTex) gl.deleteTexture(t);
      const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      canvas.remove();
    },
    pause() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } },
    resume() { if (!rafId) { lastNow = 0; acc = 0; rafId = requestAnimationFrame(render); } },
    reinit() { clockMs = Math.random() * 600000; powerupSec = 0; },
    getStats() { return { ms: stats.ms, w: canvas.width, h: canvas.height }; },
    config, params,
  };
}
