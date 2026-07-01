// marbling -- GPU (GLSL ES 3.00) port of xscreensaver's marbling.c
// (Jamie Zawinski & Dave Odell, 2021-2022).
//
// marbling.c's header says the algorithm "would ideally be written in Shader
// Language", but XScreenSaver still targets pre-GLSL OpenGL, so it runs the
// Perlin-Noise + Fractal-Brownian-Motion field on the CPU with SIMD + pthreads.
// Here we do what the author wished for: the whole field runs as a fragment
// shader, with no cell cap (a CPU affordance the canvas port needed on large
// viewports). The C's gridsize/"Magnification" block replication is KEPT: the C
// only evaluates the field at GRID resolution (window / gridsize) and writes each
// value to a gridsize x gridsize block (marbling.c:405-483), so sampling
// per-pixel over-renders the high-frequency domain warp into busy noise where the
// live binary shows bold, grid-scale swirls. This shader quantizes fragCoord to
// the same grid; gridsize is baked as MARB_GRID (device px) by marbling.js.
//
// This is a FAITHFUL, near-verbatim transcription of the C's SCALAR (VSIZE==1)
// fixed-point pipeline -- NOT a generic float marble shader. Every value is a
// 16-bit fixed-point integer emulated with `uint` + `& 0xFFFFu` masks (the
// uint16 wraparound is load-bearing, exactly as in the CPU port). So the marble
// field is bit-for-bit the CPU version's; only the render is different.
//
// Four things are injected by marbling.js before compile:
//   __ITER__      domain-warp passes           (config.iterations / "Complexity")
//   __SCALE__     noise cells across the screen (config.scale / "Scale")
//   __GRID__      block size in device px       (config.gridsize / "Magnification")
//   __PALETTE__   256 vec3 make_smooth_colormap entries (re-rolled per run)
// The harness preamble supplies iResolution / iTime; config.speed rides iTime
// (the harness scales it), config.resolution is the render scale.

// ---- injected constants -------------------------------------------------
const int   MARB_ITER  = __ITER__;   // st->iterations
const float MARB_SCALE = __SCALE__;  // st->scale
const float MARB_GRID  = __GRID__;   // st->grid_size in device px (Magnification)
const float MARB_ZRATE = 35.8;       // C: Z += 2/draw at the live binary's ~17.9 fps

// ---- fixed-point Perlin "improved noise" (marbling.c scalar path) --------
const int MARB_ONE = 8192;   // 1<<noise_work_bits ("1.0" in the 13-bit space)

// noise_rand: the C's 8-bit perfect hash, run on a 16-bit value (marbling.c:252).
uint marbRand(uint x) {
  x = (x ^ (x >> 3u)) & 0xFFFFu;
  x = (x ^ (x << 1u)) & 0xFFFFu;
  return ((x << 5u) - x) & 0xFFFFu;
}

// P(x) == noise_rand(x & 0xff) (marbling.c:265). Every hash lookup in noise()
// feeds an 8-bit value, so this is the C's P() macro exactly.
uint marbP(uint x) { return marbRand(x & 0xFFu); }

// fade: 6t^5-15t^4+10t^3 in fixed point; t in [0,255], result in [0, 1<<14].
// (marbling.c:180, non-ARM path.) MUL_HI(a,b) == (a*b)>>16 for a,b < 2^16.
uint marbFade(uint t) {
  uint t2    = (t * t) & 0xFFFFu;              // t*t (t <= 255, fits)
  uint inner = (3840u - 6u * t) & 0xFFFFu;     // (uint16)(15*256) - 6t
  uint m1    = ((t2 * inner) >> 16u) & 0xFFFFu; // MUL_HI(t2, inner)
  uint a     = (10u * t - m1) & 0xFFFFu;       // 10t - MUL_HI(...)
  uint m2    = (t2 * a) >> 16u;                 // MUL_HI(t2, a)
  return (m2 << 6u) & 0xFFFFu;                 // << (noise_work_bits-noise_in_bits+1)
}

// grad: low 4 bits pick one of 12 gradient directions; x,y,z are signed 13-bit
// relative coords. (marbling.c:232, scalar path.)
int marbGrad(uint hash, int x, int y, int z) {
  uint h = hash & 15u;
  int u = (h < 8u) ? x : y;
  int v = (h < 4u) ? y : (((h & ~2u) == 12u) ? x : z);
  return ((h & 1u) == 0u ? u : -u) + ((h & 2u) == 0u ? v : -v);
}

// LERP(t,a,b) = (a >> lerp_loss) + IMUL_HI(t, b-a); lerp_loss == 2.
// (marbling.c:224.) a,b signed; t unsigned (<= 1<<14), so int(t)*(b-a) fits int32.
int marbLerp(uint t, int a, int b) {
  return (a >> 2) + ((int(t) * (b - a)) >> 16);
}

// noise: 3D improved Perlin noise, fixed point. x,y,z are uint16 with 8
// fractional bits; returns a uint16 read unsigned by fbm. (marbling.c:267.)
uint marbNoise(uint x, uint y, uint z) {
  uint X = x >> 8u, Y = y >> 8u, Z = z >> 8u;   // unit cube containing the point
  x &= 0xFFu; y &= 0xFFu; z &= 0xFFu;           // relative coords inside the cube
  uint u = marbFade(x), v = marbFade(y), w = marbFade(z);
  int xi = int(x << 5u), yi = int(y << 5u), zi = int(z << 5u);   // -> 13-bit coords
  uint A  = (marbP(X)      + Y) & 0xFFFFu;      // hash the 8 cube corners
  uint AA = (marbP(A)      + Z) & 0xFFFFu;
  uint AB = (marbP(A + 1u) + Z) & 0xFFFFu;
  uint B  = (marbP(X + 1u) + Y) & 0xFFFFu;
  uint BA = (marbP(B)      + Z) & 0xFFFFu;
  uint BB = (marbP(B + 1u) + Z) & 0xFFFFu;
  int c0 = marbGrad(marbP(AA),      xi,            yi,            zi);
  int c1 = marbGrad(marbP(BA),      xi - MARB_ONE, yi,            zi);
  int c2 = marbGrad(marbP(AB),      xi,            yi - MARB_ONE, zi);
  int c3 = marbGrad(marbP(BB),      xi - MARB_ONE, yi - MARB_ONE, zi);
  int c4 = marbGrad(marbP(AA + 1u), xi,            yi,            zi - MARB_ONE);
  int c5 = marbGrad(marbP(BA + 1u), xi - MARB_ONE, yi,            zi - MARB_ONE);
  int c6 = marbGrad(marbP(AB + 1u), xi,            yi - MARB_ONE, zi - MARB_ONE);
  int c7 = marbGrad(marbP(BB + 1u), xi - MARB_ONE, yi - MARB_ONE, zi - MARB_ONE);
  int r = marbLerp(w, marbLerp(v, marbLerp(u, c0, c1), marbLerp(u, c2, c3)),
                      marbLerp(v, marbLerp(u, c4, c5), marbLerp(u, c6, c7)));
  return uint(r) & 0xFFFFu;   // SCALE() is a no-op in the shipping binary
}

// fbm: 2 octaves; amplitude *G (G = 2^-0.5) each octave, frequency *2.
// (marbling.c:308.) iG = (uint16)(G*0x10000) == 46340.
uint marbFbm(uint x, uint y, uint z) {
  uint f = 1u, a = 0xFFFFu, t = 0u;
  for (int i = 0; i < 2; i++) {
    uint n = marbNoise((f * x) & 0xFFFFu, (f * y) & 0xFFFFu, (f * z) & 0xFFFFu);
    t = (t + ((n * a) >> 16u)) & 0xFFFFu;   // MUL_HI(noise, a)
    a = (a * 46340u) >> 16u;                // MUL_HI(a, iG)
    f = f << 1u;
  }
  return t;
}

// ---- injected smooth colormap (256 entries, make_smooth_colormap) --------
const vec3 MARB_PAL[256] = vec3[256](
  __PALETTE__
);

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  // The C renders the field ONLY at grid resolution (window / gridsize): one
  // evaluation per grid cell, replicated across a gridsize x gridsize block
  // (marbling.c:405-483). Quantize fragCoord to that grid so every pixel in a
  // block samples the SAME field point -- the block replication is load-bearing,
  // because sampling per-pixel over-renders the high-frequency domain warp into
  // busy noise where the C shows bold, grid-scale swirls.
  vec2 cell = floor(fragCoord / MARB_GRID);
  vec2 uv = (cell * MARB_GRID + 0.5 * MARB_GRID) / iResolution.xy;
  uv.y = 1.0 - uv.y;                             // flip y for the C's top-down scan

  float S = MARB_SCALE * 256.0;                  // scale << noise_in_bits
  uint X0 = uint(uv.x * S) & 0xFFFFu;            // (x/w) * S
  uint Y  = uint(uv.y * S) & 0xFFFFu;            // (y/h) * S
  uint Z  = uint(iTime * MARB_ZRATE) & 0xFFFFu;  // third axis = time = the morph

  // Domain warp: feed the previous FBM output back into every input axis.
  uint p = 0u;
  for (int i = 0; i < MARB_ITER; i++)
    p = marbFbm((p + X0) & 0xFFFFu, (p + Y) & 0xFFFFu, (p + Z) & 0xFFFFu);

  // Only the LOW byte selects a colour, so the warped field bands into stripes.
  fragColor = vec4(MARB_PAL[int(p & 0xFFu)], 1.0);
}
