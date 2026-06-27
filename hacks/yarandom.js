// yarandom.js — a faithful JS port of xscreensaver's utils/yarandom.c
// ("Yet Another Random number generator", jwz / Phil Karlton: Knuth Vol.2,
//  Algorithm A — an additive lagged-Fibonacci generator, n=55, k=24, m=2^32).
//
// WHY THIS EXISTS
//   To reproduce an original hack's RNG stream bit-for-bit, so a JS port can make
//   the SAME discrete, RNG-driven choices the C original makes — which mode, which
//   directions, how many of a thing, which colors, the initial layout. It does NOT
//   make rendered pixels match the original and cannot: C libm vs JS Math diverge
//   in the low bits and compound, and the GPU/OpenGL rasterizer differs from WebGL
//   (two GPUs don't even agree bit-for-bit). What it buys is structural/logic parity
//   plus a reproducible reference run for visual comparison.
//
// FAITHFUL TO THE .c
//   * the 55 seed constants are verbatim (CRC 18th ed. table, octal, as shipped);
//   * ya_random(): ret = a[i1] + a[i2]; a[i1] = ret; advance i1, i2 (mod 55);
//   * ya_rand_init(seed): the exact multiply (*999 / *1001 / *1003) + bit-rotate
//     seed expansion.
//   All arithmetic is unsigned 32-bit: Math.imul for 32x32 multiply, `>>> 0` to
//   wrap to uint32, `>>>` for the unsigned right shift inside ROT.
//
// SEEDING
//   xscreensaver runs ONE global stream, seeded by the framework as
//   ya_rand_init(0) — seed 0 means "use gettimeofday()+getpid()", i.e.
//   nondeterministic. There is no -seed flag; to pin an original you patch its
//   ya_rand_init(0) call to a fixed value and rebuild. Here, makeYaRandom(seed)
//   returns an INDEPENDENT, deterministic stream per call (one per hack instance).
//   Pass a fixed nonzero seed to match a patched original; pass 0 (or omit) for a
//   time-seeded stream that is random per run.
//
// Pure module: no DOM, no browser globals (Date.now only in the seed==0 path), so
// it runs the same in the browser and in Node (for offline structural checks).

const VECTOR_SIZE = 55;

// CRC 18th ed. table, verbatim from utils/yarandom.c (octal literals).
const SEED_TABLE = [
  0o35340171546, 0o10401501101, 0o22364657325, 0o24130436022, 0o02167303062,
  0o37570375137, 0o37210607110, 0o16272055420, 0o23011770546, 0o17143426366,
  0o14753657433, 0o21657231332, 0o23553406142, 0o04236526362, 0o10365611275,
  0o07117336710, 0o11051276551, 0o02362132524, 0o01011540233, 0o12162531646,
  0o07056762337, 0o06631245521, 0o14164542224, 0o32633236305, 0o23342700176,
  0o02433062234, 0o15257225043, 0o26762051606, 0o00742573230, 0o05366042132,
  0o12126416411, 0o00520471171, 0o00725646277, 0o20116577576, 0o25765742604,
  0o07633473735, 0o15674255275, 0o17555634041, 0o06503154145, 0o21576344247,
  0o14577627653, 0o02707523333, 0o34146376720, 0o30060227734, 0o13765414060,
  0o36072251540, 0o07255221037, 0o24364674123, 0o06200353166, 0o10126373326,
  0o15664104320, 0o16401041535, 0o16215305520, 0o33115351014, 0o17411670323,
];

// ROT(X,N) = (X<<N) | (X>>(32-N)), on a 32-bit unsigned.
function rot(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

// Make an independent, seeded yarandom stream. `seed` of 0 (the default) mirrors
// the .c's nondeterministic time path; pass a fixed nonzero seed for determinism.
export function makeYaRandom(seed = 0) {
  const a = SEED_TABLE.slice();   // fresh mutable copy (init & random both mutate it)
  let i1 = 0;
  let i2 = 0;

  function srandom(s) {
    s = s >>> 0;
    if (s === 0) {
      // seed 0 in the .c => gettimeofday()+getpid(), nondeterministic. We can't
      // get getpid in JS; mirror the SHAPE with a time mix so seed 0 stays
      // "random per run". Pass a fixed nonzero seed when you need determinism.
      const now = Date.now();
      const sec = Math.floor(now / 1000) >>> 0;
      const usec = ((now % 1000) * 1000) >>> 0;
      s = Math.imul(999, sec) >>> 0;
      s = rot(s, 11);
      s = (s + Math.imul(1001, usec)) >>> 0;
      s = rot(s, 7);
      s = (s + Math.imul(1003, now & 0x7fff)) >>> 0;   // no getpid; a time nibble
      s = rot(s, 13);
    }
    a[0] = (a[0] + s) >>> 0;
    for (let i = 1; i < VECTOR_SIZE; i++) {
      s = Math.imul(s, 999) >>> 0;
      s = rot(s, 9);
      s = (s + Math.imul(a[i - 1], 1001)) >>> 0;
      s = rot(s, 15);
      a[i] = (a[i] + s) >>> 0;
    }
    i1 = a[0] % VECTOR_SIZE;
    i2 = (i1 + 24) % VECTOR_SIZE;
  }

  // ya_random(): the additive generator. Returns a uint32 in [0, 2^32).
  function random() {
    const ret = (a[i1] + a[i2]) >>> 0;
    a[i1] = ret;
    if (++i1 >= VECTOR_SIZE) i1 = 0;
    if (++i2 >= VECTOR_SIZE) i2 = 0;
    return ret;
  }

  srandom(seed);

  // The helper macros the hacks reach for (from yarandom.h / the xlockmore API).
  // A given hack often #defines its own RAND(n); the common form is provided here.
  const RAND_MAX = 0xFFFFFFFF;
  return {
    random,
    srandom,
    // LRAND() = random() & 0x7fffffff  (a nonnegative 31-bit value)
    LRAND: () => random() & 0x7fffffff,
    // NRAND(n) = (uint64)random() * n / (RAND_MAX+1)  ->  integer in [0, n).
    // Exact for every n a hack actually uses (n well under 2^21); see header note.
    NRAND: (n) => Math.floor((random() * n) / 4294967296),
    // RAND(n) = (random() & 0x7fffffff) % n  — the per-hack macro in cubicgrid &c.
    RAND: (n) => (random() & 0x7fffffff) % n,
    // frand(f) = random() * f / (~0u)  ->  float in [0, f).
    frand: (f = 1) => (random() * f) / RAND_MAX,
    // SRAND in the .c is a no-op (already seeded); exposed for call-site parity.
    SRAND: () => {},
  };
}

export default makeYaRandom;
