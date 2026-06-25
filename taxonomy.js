// taxonomy.js — host-owned genre classification for the picker.
//
// Every hack carries two cross-cutting facets:
//   dimension  : '2d' (canvas/'2d' context) | '3d' (WebGL fragment shader)
//   categories : ONE OR TWO genre keys from CATEGORIES below (the visual family)
//
// Membership is many-to-many: a hack can legitimately be two things at once
// (ccurve is a fractal AND a curve; grav is particles AND cosmic), so it lists
// up to two category keys and shows up under each. There is NO "primary" genre —
// "All" is every hack's home, and the picker always opens/arrives there; the
// genre rails are just cross-cutting filters over that one list. Because of the
// overlap the per-genre counts sum to MORE than the hack total, while "All"
// stays the exact de-duplicated set (each hack listed once).
//
// Hacks are keyed by slug, which for every module equals its `title` export — so
// this file never touches a hack module (2D or 3D); it is pure host metadata.
//
// Category KEYS are short ASCII tokens (safe object keys, no \u escapes). Each
// carries a `brief` (rail label) and a `full` (detail header); only `full` is a
// display string, so the one accented label (Moire) is escaped there.
//
// The 3D / WebGL entries are TENTATIVE: that track is owned by a separate effort
// and is not yet wired into host.js, so none of them currently show in the
// picker. They are kept here so the scheme stays complete — confirm before
// registering any GL hack in host.js.

// Picker sections, in display order: { key, brief (rail), full (header) }.
export const CATEGORIES = [
  { key: 'automata',   brief: 'Automata',   full: 'Cellular Automata' },
  { key: 'biota',      brief: 'Biota',      full: 'Biota' },
  { key: 'fractals',   brief: 'Fractals',   full: 'Fractals' },
  { key: 'attractors', brief: 'Attractors', full: 'Strange Attractors' },
  { key: 'curves',     brief: 'Curves',     full: 'Curves' },
  { key: 'geometry',   brief: 'Geometry',   full: 'Geometry & Tilings' },
  { key: 'surfaces',   brief: 'Surfaces',   full: 'Surfaces' },
  { key: 'optical',    brief: 'Optical',    full: 'Optical & Moir\u00e9' },
  { key: 'particles',  brief: 'Particles',  full: 'Particle Systems' },
  { key: 'fluids',     brief: 'Fluids',     full: 'Fluid Flow' },
  { key: 'plasma',     brief: 'Plasma',     full: 'Plasma & Color Fields' },
  { key: 'cosmic',     brief: 'Cosmic',     full: 'Cosmic & Space' },
];

// Dimension badge: glyph + short label. Glyphs are \u-escaped (DOM-bound).
export const DIMENSIONS = {
  '2d': { label: '2D', glyph: '\u25A2' },  // white square
  '3d': { label: '3D', glyph: '\u25C6' },  // black diamond
};

// slug -> { dimension, categories: [key, key?] }.  slug === each module's
// `title` export.  Categories chosen by reading each hack's own xscreensaver
// description (see hacks/<slug>.xml); alphabetical by slug.
export const HACK_TAXONOMY = {
  // --- 2D (registered in host.js) ---
  ant: { dimension: '2d', categories: ['automata'] },
  apollonian: { dimension: '2d', categories: ['fractals', 'geometry'] },
  attraction: { dimension: '2d', categories: ['particles'] },
  binaryhorizon: { dimension: '2d', categories: ['particles', 'curves'] },
  binaryring: { dimension: '2d', categories: ['curves', 'particles'] },
  bouboule: { dimension: '2d', categories: ['particles'] },
  boxfit: { dimension: '2d', categories: ['geometry'] },
  braid: { dimension: '2d', categories: ['curves', 'geometry'] },
  ccurve: { dimension: '2d', categories: ['fractals', 'curves'] },
  cloudlife: { dimension: '2d', categories: ['automata'] },
  coral: { dimension: '2d', categories: ['biota'] },
  cwaves: { dimension: '2d', categories: ['plasma'] },
  cynosure: { dimension: '2d', categories: ['geometry'] },
  deco: { dimension: '2d', categories: ['geometry'] },
  demon: { dimension: '2d', categories: ['automata'] },
  drift: { dimension: '2d', categories: ['fractals', 'attractors'] },
  eruption: { dimension: '2d', categories: ['particles'] },
  euler2d: { dimension: '2d', categories: ['fluids'] },
  fadeplot: { dimension: '2d', categories: ['curves'] },
  fiberlamp: { dimension: '2d', categories: ['curves'] },
  flame: { dimension: '2d', categories: ['fractals', 'attractors'] },
  fluidballs: { dimension: '2d', categories: ['particles', 'fluids'] },
  galaxy: { dimension: '2d', categories: ['cosmic', 'particles'] },
  grav: { dimension: '2d', categories: ['particles', 'cosmic'] },
  greynetic: { dimension: '2d', categories: ['geometry', 'plasma'] },
  halftone: { dimension: '2d', categories: ['optical'] },
  halo: { dimension: '2d', categories: ['optical'] },
  helix: { dimension: '2d', categories: ['curves', 'geometry'] },
  hexadrop: { dimension: '2d', categories: ['geometry'] },
  hopalong: { dimension: '2d', categories: ['attractors', 'fractals'] },
  ifs: { dimension: '2d', categories: ['fractals'] },
  imsmap: { dimension: '2d', categories: ['plasma', 'fractals'] },
  interaggregate: { dimension: '2d', categories: ['curves', 'optical'] },
  interference: { dimension: '2d', categories: ['optical', 'plasma'] },
  intermomentary: { dimension: '2d', categories: ['optical'] },
  kumppa: { dimension: '2d', categories: ['plasma'] },
  loop: { dimension: '2d', categories: ['automata'] },
  metaballs: { dimension: '2d', categories: ['particles', 'plasma'] },
  moire: { dimension: '2d', categories: ['optical'] },
  moire2: { dimension: '2d', categories: ['optical'] },
  mountain: { dimension: '2d', categories: ['surfaces'] },
  munch: { dimension: '2d', categories: ['geometry', 'optical'] },
  nerverot: { dimension: '2d', categories: ['curves'] },
  pedal: { dimension: '2d', categories: ['geometry'] },
  penrose: { dimension: '2d', categories: ['geometry'] },
  petri: { dimension: '2d', categories: ['biota'] },
  piecewise: { dimension: '2d', categories: ['optical', 'geometry'] },
  popsquares: { dimension: '2d', categories: ['geometry', 'plasma'] },
  pyro: { dimension: '2d', categories: ['particles'] },
  qix: { dimension: '2d', categories: ['geometry'] },
  rocks: { dimension: '2d', categories: ['cosmic'] },
  rorschach: { dimension: '2d', categories: ['optical'] },
  scooter: { dimension: '2d', categories: ['cosmic'] },
  sierpinski: { dimension: '2d', categories: ['fractals'] },
  spiral: { dimension: '2d', categories: ['curves'] },
  squiral: { dimension: '2d', categories: ['automata'] },
  strange: { dimension: '2d', categories: ['attractors'] },
  thornbird: { dimension: '2d', categories: ['attractors'] },
  truchet: { dimension: '2d', categories: ['geometry'] },
  vermiculate: { dimension: '2d', categories: ['curves', 'biota'] },
  wander: { dimension: '2d', categories: ['plasma', 'curves'] },
  whirlwindwarp: { dimension: '2d', categories: ['particles', 'fluids'] },
  wormhole: { dimension: '2d', categories: ['cosmic'] },
  xspirograph: { dimension: '2d', categories: ['curves'] },

  // --- 3D / WebGL (tentative; not yet registered in host.js) ---
  bubblecolors: { dimension: '3d', categories: ['plasma'] },
  driftclouds: { dimension: '3d', categories: ['fluids'] },
  elementalring: { dimension: '3d', categories: ['geometry'] },
  goldenapollian: { dimension: '3d', categories: ['fractals'] },
  hexplasma: { dimension: '3d', categories: ['plasma'] },
  logarithmiccircles: { dimension: '3d', categories: ['geometry'] },
  neontriangulator: { dimension: '3d', categories: ['geometry'] },
  prococean: { dimension: '3d', categories: ['fluids'] },
  rigrekt: { dimension: '3d', categories: ['plasma'] },
  stardome: { dimension: '3d', categories: ['cosmic'] },
  starnest: { dimension: '3d', categories: ['cosmic'] },
  stripeytorus: { dimension: '3d', categories: ['surfaces'] },
  synthwavecity: { dimension: '3d', categories: ['cosmic'] },
  topologica: { dimension: '3d', categories: ['surfaces'] },
  trainmandala: { dimension: '3d', categories: ['cosmic'] },
  trizm: { dimension: '3d', categories: ['geometry'] },
};

// Look up a hack's facets by slug. An unknown slug falls back to no genre (it
// then shows only under "All"), so a new module never breaks the picker.
export function classify(slug) {
  return HACK_TAXONOMY[slug] || { dimension: '2d', categories: [] };
}
