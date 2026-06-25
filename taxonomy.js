// taxonomy.js — host-owned genre classification for the picker.
//
// Every hack carries two cross-cutting facets:
//   dimension : '2d' (canvas/'2d' context) | '3d' (WebGL fragment shader via shadertoy.js)
//   category  : one genre from CATEGORIES below (the visual family)
//
// The picker groups by `category` (in CATEGORIES order) and shows a small
// dimension badge per item, with an optional 2D/3D filter. Hacks are keyed by
// slug, which for every module equals its `title` export — so this file never
// touches a hack module (2D or 3D); it is pure host-side metadata.
//
// Category labels are kept ASCII (e.g. "Optical & Moire", no accent) so they
// are safe as object keys with no \u escapes; a presentational label map can
// prettify them in the UI later if we want the typography.
//
// The 3D / WebGL entries are a TENTATIVE first pass: that track is owned by a
// separate effort and is not yet wired into host.js. They are included so the
// scheme is complete — confirm before registering any GL hack in host.js.

// Picker sections, in display order.
export const CATEGORIES = [
  'Life & Growth',
  'Fractals & Attractors',
  'Geometry & Tilings',
  'Optical & Moire',
  'Swarms & Bodies',
  'Fluids & Flow',
  'Plasma & Color Fields',
  'Cosmic & Worlds',
];

// Dimension badge: glyph + short label. Glyphs are \u-escaped (DOM-bound).
export const DIMENSIONS = {
  '2d': { label: '2D', glyph: '\u25A2' },  // white square
  '3d': { label: '3D', glyph: '\u25C6' },  // black diamond
};

// Fallback for any hack not yet classified (keeps the picker from breaking if a
// new module lands before it is tagged here).
export const UNCATEGORIZED = 'Unsorted';

// slug -> { dimension, category }.  slug === each module's `title` export.
// Grouped by category for review; alphabetical within each dimension.
export const HACK_TAXONOMY = {
  // --- Life & Growth ---
  ant: { dimension: '2d', category: 'Life & Growth' },
  cloudlife: { dimension: '2d', category: 'Life & Growth' },
  coral: { dimension: '2d', category: 'Life & Growth' },
  demon: { dimension: '2d', category: 'Life & Growth' },
  loop: { dimension: '2d', category: 'Life & Growth' },
  petri: { dimension: '2d', category: 'Life & Growth' },
  squiral: { dimension: '2d', category: 'Life & Growth' },
  vermiculate: { dimension: '2d', category: 'Life & Growth' },
  bubblecolors: { dimension: '3d', category: 'Life & Growth' },

  // --- Fractals & Attractors ---
  apollonian: { dimension: '2d', category: 'Fractals & Attractors' },
  ccurve: { dimension: '2d', category: 'Fractals & Attractors' },
  drift: { dimension: '2d', category: 'Fractals & Attractors' },
  flame: { dimension: '2d', category: 'Fractals & Attractors' },
  hopalong: { dimension: '2d', category: 'Fractals & Attractors' },
  ifs: { dimension: '2d', category: 'Fractals & Attractors' },
  sierpinski: { dimension: '2d', category: 'Fractals & Attractors' },
  strange: { dimension: '2d', category: 'Fractals & Attractors' },
  thornbird: { dimension: '2d', category: 'Fractals & Attractors' },
  goldenapollian: { dimension: '3d', category: 'Fractals & Attractors' },

  // --- Geometry & Tilings ---
  binaryhorizon: { dimension: '2d', category: 'Geometry & Tilings' },
  binaryring: { dimension: '2d', category: 'Geometry & Tilings' },
  braid: { dimension: '2d', category: 'Geometry & Tilings' },
  cynosure: { dimension: '2d', category: 'Geometry & Tilings' },
  deco: { dimension: '2d', category: 'Geometry & Tilings' },
  helix: { dimension: '2d', category: 'Geometry & Tilings' },
  hexadrop: { dimension: '2d', category: 'Geometry & Tilings' },
  pedal: { dimension: '2d', category: 'Geometry & Tilings' },
  penrose: { dimension: '2d', category: 'Geometry & Tilings' },
  piecewise: { dimension: '2d', category: 'Geometry & Tilings' },
  popsquares: { dimension: '2d', category: 'Geometry & Tilings' },
  scooter: { dimension: '2d', category: 'Geometry & Tilings' },
  spiral: { dimension: '2d', category: 'Geometry & Tilings' },
  truchet: { dimension: '2d', category: 'Geometry & Tilings' },
  xspirograph: { dimension: '2d', category: 'Geometry & Tilings' },
  elementalring: { dimension: '3d', category: 'Geometry & Tilings' },
  logarithmiccircles: { dimension: '3d', category: 'Geometry & Tilings' },
  neontriangulator: { dimension: '3d', category: 'Geometry & Tilings' },
  stripeytorus: { dimension: '3d', category: 'Geometry & Tilings' },
  topologica: { dimension: '3d', category: 'Geometry & Tilings' },
  trizm: { dimension: '3d', category: 'Geometry & Tilings' },

  // --- Optical & Moire ---
  halftone: { dimension: '2d', category: 'Optical & Moire' },
  halo: { dimension: '2d', category: 'Optical & Moire' },
  interference: { dimension: '2d', category: 'Optical & Moire' },
  moire: { dimension: '2d', category: 'Optical & Moire' },
  moire2: { dimension: '2d', category: 'Optical & Moire' },
  munch: { dimension: '2d', category: 'Optical & Moire' },

  // --- Swarms & Bodies ---
  attraction: { dimension: '2d', category: 'Swarms & Bodies' },
  bouboule: { dimension: '2d', category: 'Swarms & Bodies' },
  boxfit: { dimension: '2d', category: 'Swarms & Bodies' },
  eruption: { dimension: '2d', category: 'Swarms & Bodies' },
  fadeplot: { dimension: '2d', category: 'Swarms & Bodies' },
  fiberlamp: { dimension: '2d', category: 'Swarms & Bodies' },
  fluidballs: { dimension: '2d', category: 'Swarms & Bodies' },
  grav: { dimension: '2d', category: 'Swarms & Bodies' },
  interaggregate: { dimension: '2d', category: 'Swarms & Bodies' },
  intermomentary: { dimension: '2d', category: 'Swarms & Bodies' },
  nerverot: { dimension: '2d', category: 'Swarms & Bodies' },
  pyro: { dimension: '2d', category: 'Swarms & Bodies' },
  qix: { dimension: '2d', category: 'Swarms & Bodies' },

  // --- Fluids & Flow ---
  euler2d: { dimension: '2d', category: 'Fluids & Flow' },
  wander: { dimension: '2d', category: 'Fluids & Flow' },
  whirlwindwarp: { dimension: '2d', category: 'Fluids & Flow' },
  driftclouds: { dimension: '3d', category: 'Fluids & Flow' },
  prococean: { dimension: '3d', category: 'Fluids & Flow' },

  // --- Plasma & Color Fields ---
  cwaves: { dimension: '2d', category: 'Plasma & Color Fields' },
  greynetic: { dimension: '2d', category: 'Plasma & Color Fields' },
  imsmap: { dimension: '2d', category: 'Plasma & Color Fields' },
  kaleidescope: { dimension: '2d', category: 'Plasma & Color Fields' },
  kumppa: { dimension: '2d', category: 'Plasma & Color Fields' },
  marbling: { dimension: '2d', category: 'Plasma & Color Fields' },
  metaballs: { dimension: '2d', category: 'Plasma & Color Fields' },
  rorschach: { dimension: '2d', category: 'Plasma & Color Fields' },
  vfeedback: { dimension: '2d', category: 'Plasma & Color Fields' },
  hexplasma: { dimension: '3d', category: 'Plasma & Color Fields' },
  rigrekt: { dimension: '3d', category: 'Plasma & Color Fields' },

  // --- Cosmic & Worlds ---
  galaxy: { dimension: '2d', category: 'Cosmic & Worlds' },
  mountain: { dimension: '2d', category: 'Cosmic & Worlds' },
  rocks: { dimension: '2d', category: 'Cosmic & Worlds' },
  wormhole: { dimension: '2d', category: 'Cosmic & Worlds' },
  stardome: { dimension: '3d', category: 'Cosmic & Worlds' },
  starnest: { dimension: '3d', category: 'Cosmic & Worlds' },
  synthwavecity: { dimension: '3d', category: 'Cosmic & Worlds' },
  trainmandala: { dimension: '3d', category: 'Cosmic & Worlds' },
};

// Parked in hacks/shelved/ as of 2026-06-24 (GPU-heavy; the 3D set is actively
// changing): batteredplanet, bestill, bubblecolors, rigrekt, topologica,
// universeball. bubblecolors/rigrekt/topologica keep their genre tags above when
// revived; batteredplanet/bestill/universeball are untagged pending review.

// Look up a hack's facets by slug, with a safe fallback.
export function classify(slug) {
  return HACK_TAXONOMY[slug] || { dimension: '2d', category: UNCATEGORIZED };
}
