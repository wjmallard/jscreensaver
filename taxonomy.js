// taxonomy.js — host-owned genre classification for the picker.
//
// Every hack carries two cross-cutting facets:
//   dimension  : a hack's xscreensaver PROVENANCE -- not how we render it:
//                  '2d' = ported from a 2D X11 hack (hacks/*.c)
//                  '3d' = ported from a GLX/OpenGL hack (hacks/glx/*.c)
//                A 2D-origin hack stays '2d' even when we render it in WebGL for
//                speed (e.g. xanalogtv). The harness used to draw it (canvas /
//                shadertoy / self-contained WebGL) is an INDEPENDENT choice.
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
// The 3D / WebGL shader hacks are now wired into host.js alongside the 2D set;
// their categories below come from each shader's own info.description. The
// GPU-demanding ones are NOT marked here — "heavy" is a per-module flag
// (info.heavy) the picker reads directly, so it stays with the hack, not here.

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
  { key: 'worlds',     brief: 'Worlds',     full: 'Worlds & Scenes' },
];

// Dimension badge: glyph + short label. Glyphs are \u-escaped (DOM-bound).
export const DIMENSIONS = {
  '2d': { label: '2D', glyph: '\u25A2' },  // white square
  '3d': { label: '3D', glyph: '\u25C6' },  // black diamond
};

// slug -> { dimension, categories: [key, key?], shelved? }.  slug === each
// module's `title` export.  Categories chosen by reading each hack's own
// xscreensaver description (see hacks/<slug>.xml); alphabetical by slug.
// `shelved: true` marks a classified-but-inactive hack (kept here, ready to
// revive); tools/build-catalog.mjs skips it when generating catalog.json.
export const HACK_TAXONOMY = {
  // --- 2D (registered in host.js) ---
  abstractile: { dimension: '2d', categories: ['geometry'] },
  anemone: { dimension: '2d', categories: ['biota', 'curves'] },
  anemotaxis: { dimension: '2d', categories: ['particles', 'biota'] },
  ant: { dimension: '2d', categories: ['automata'] },
  apollonian: { dimension: '2d', categories: ['fractals', 'geometry'] },
  attraction: { dimension: '2d', categories: ['particles'] },
  binaryhorizon: { dimension: '2d', categories: ['particles', 'curves'] },
  binaryring: { dimension: '2d', categories: ['curves', 'particles'] },
  bouboule: { dimension: '2d', categories: ['particles'] },
  boxfit: { dimension: '2d', categories: ['geometry'] },
  braid: { dimension: '2d', categories: ['curves', 'geometry'] },
  bubbles: { dimension: '2d', categories: ['particles', 'fluids'] },
  ccurve: { dimension: '2d', categories: ['fractals', 'curves'] },
  celtic: { dimension: '2d', categories: ['geometry', 'curves'] },
  cloudlife: { dimension: '2d', categories: ['automata'] },
  compass: { dimension: '2d', categories: ['geometry'] },
  coral: { dimension: '2d', categories: ['biota'] },
  critical: { dimension: '2d', categories: ['curves'] },
  crystal: { dimension: '2d', categories: ['geometry'] },
  cwaves: { dimension: '2d', categories: ['plasma'] },
  cynosure: { dimension: '2d', categories: ['geometry'] },
  deco: { dimension: '2d', categories: ['geometry'] },
  deluxe: { dimension: '2d', categories: ['plasma', 'optical'] },
  demon: { dimension: '2d', categories: ['automata'] },
  discrete: { dimension: '2d', categories: ['attractors', 'fractals'] },
  drift: { dimension: '2d', categories: ['fractals', 'attractors'] },
  epicycle: { dimension: '2d', categories: ['curves'] },
  eruption: { dimension: '2d', categories: ['particles'] },
  euler2d: { dimension: '2d', categories: ['fluids'] },
  fadeplot: { dimension: '2d', categories: ['curves'] },
  fiberlamp: { dimension: '2d', categories: ['curves'] },
  fireworkx: { dimension: '2d', categories: ['particles', 'plasma'] },
  flame: { dimension: '2d', categories: ['fractals', 'attractors'] },
  flow: { dimension: '2d', categories: ['attractors', 'particles'] },
  fluidballs: { dimension: '2d', categories: ['particles', 'fluids'] },
  forest: { dimension: '2d', categories: ['fractals', 'biota'] },
  fuzzyflakes: { dimension: '2d', categories: ['geometry'] },
  galaxy: { dimension: '2d', categories: ['cosmic', 'particles'] },
  goop: { dimension: '2d', categories: ['fluids', 'plasma'] },
  grav: { dimension: '2d', categories: ['particles', 'cosmic'] },
  greynetic: { dimension: '2d', categories: ['geometry', 'plasma'] },
  halftone: { dimension: '2d', categories: ['optical'] },
  halo: { dimension: '2d', categories: ['optical'] },
  helix: { dimension: '2d', categories: ['curves', 'geometry'] },
  hexadrop: { dimension: '2d', categories: ['geometry'] },
  hopalong: { dimension: '2d', categories: ['attractors', 'fractals'] },
  hyperball: { dimension: '2d', categories: ['geometry'] },
  hypercube: { dimension: '2d', categories: ['geometry'] },
  ifs: { dimension: '2d', categories: ['fractals'] },
  imsmap: { dimension: '2d', categories: ['plasma', 'fractals'] },
  interaggregate: { dimension: '2d', categories: ['curves', 'optical'] },
  interference: { dimension: '2d', categories: ['optical', 'plasma'] },
  intermomentary: { dimension: '2d', categories: ['optical'] },
  julia: { dimension: '2d', categories: ['fractals'] },
  kaleidescope: { dimension: '2d', categories: ['optical', 'curves'] },
  kumppa: { dimension: '2d', categories: ['plasma'] },
  laser: { dimension: '2d', categories: ['geometry'] },
  lightning: { dimension: '2d', categories: ['fractals', 'curves'] },
  lisa: { dimension: '2d', categories: ['curves'] },
  lissie: { dimension: '2d', categories: ['curves'] },
  lmorph: { dimension: '2d', categories: ['curves'] },
  loop: { dimension: '2d', categories: ['automata'] },
  marbling: { dimension: '2d', categories: ['plasma', 'fractals'] },
  metaballs: { dimension: '2d', categories: ['particles', 'plasma'] },
  moire: { dimension: '2d', categories: ['optical'] },
  moire2: { dimension: '2d', categories: ['optical'] },
  mountain: { dimension: '2d', categories: ['surfaces', 'worlds'] },
  munch: { dimension: '2d', categories: ['geometry', 'optical'] },
  nerverot: { dimension: '2d', categories: ['curves'] },
  pedal: { dimension: '2d', categories: ['geometry'] },
  penrose: { dimension: '2d', categories: ['geometry'] },
  petri: { dimension: '2d', categories: ['biota'] },
  piecewise: { dimension: '2d', categories: ['optical', 'geometry'] },
  polyominoes: { dimension: '2d', categories: ['geometry'] },
  popsquares: { dimension: '2d', categories: ['geometry', 'plasma'] },
  pyro: { dimension: '2d', categories: ['particles'] },
  qix: { dimension: '2d', categories: ['geometry'] },
  rdbomb: { dimension: '2d', categories: ['plasma', 'biota'] },
  rocks: { dimension: '2d', categories: ['cosmic'] },
  rorschach: { dimension: '2d', categories: ['optical'] },
  rotor: { dimension: '2d', categories: ['curves'] },
  scooter: { dimension: '2d', categories: ['cosmic'] },
  shadebobs: { dimension: '2d', categories: ['plasma', 'particles'] },
  sierpinski: { dimension: '2d', categories: ['fractals'] },
  sphere: { dimension: '2d', categories: ['surfaces', 'geometry'] },
  spiral: { dimension: '2d', categories: ['curves'] },
  squiral: { dimension: '2d', categories: ['automata'] },
  starfish: { dimension: '2d', categories: ['biota', 'plasma'] },
  strange: { dimension: '2d', categories: ['attractors'] },
  substrate: { dimension: '2d', categories: ['curves', 'geometry'] },
  swirl: { dimension: '2d', categories: ['plasma', 'curves'] },
  thornbird: { dimension: '2d', categories: ['attractors'] },
  triangle: { dimension: '2d', categories: ['surfaces', 'worlds'] },
  truchet: { dimension: '2d', categories: ['geometry'] },
  vermiculate: { dimension: '2d', categories: ['curves', 'biota'] },
  vines: { dimension: '2d', categories: ['curves', 'fractals'] },
  wander: { dimension: '2d', categories: ['plasma', 'curves'] },
  whirlwindwarp: { dimension: '2d', categories: ['particles', 'fluids'] },
  whirlygig: { dimension: '2d', categories: ['curves'] },
  worm: { dimension: '2d', categories: ['biota', 'curves'] },
  wormhole: { dimension: '2d', categories: ['cosmic'] },
  xanalogtv: { dimension: '2d', categories: ['optical'] },
  xflame: { dimension: '2d', categories: ['plasma'] },
  xlyap: { dimension: '2d', categories: ['fractals'] },
  xrayswarm: { dimension: '2d', categories: ['particles'] },
  xspirograph: { dimension: '2d', categories: ['curves'] },

  // --- 3D / WebGL shader hacks (registered in host.js; the heavy tier lives in
  //     hacks/shelved/). Categories read from each shader's info.description. ---
  alienbeacon: { dimension: '3d', categories: ['worlds', 'surfaces'] },
  batteredplanet: { dimension: '3d', categories: ['worlds', 'surfaces'] },
  bestill: { dimension: '3d', categories: ['worlds', 'surfaces'] },
  blinkbox: { dimension: '3d', categories: ['geometry'] },
  blocktube: { dimension: '3d', categories: ['geometry'] },
  boxed: { dimension: '3d', categories: ['geometry'] },
  bubblecolors: { dimension: '3d', categories: ['plasma'] },
  circuit: { dimension: '3d', categories: ['geometry'] },
  cube21: { dimension: '3d', categories: ['geometry'] },
  cubenetic: { dimension: '3d', categories: ['geometry', 'plasma'] },
  cubestack: { dimension: '3d', categories: ['geometry'] },
  cubestorm: { dimension: '3d', categories: ['geometry'] },
  cubetwist: { dimension: '3d', categories: ['geometry'] },
  cubicgrid: { dimension: '3d', categories: ['geometry'] },
  dangerball: { dimension: '3d', categories: ['geometry'] },
  darktransit: { dimension: '3d', categories: ['cosmic'] },
  discoball: { dimension: '3d', categories: ['geometry', 'optical'] },
  downfall: { dimension: '3d', categories: ['plasma'] },
  driftclouds: { dimension: '3d', categories: ['fluids'] },
  elementalring: { dimension: '3d', categories: ['geometry'] },
  engine: { dimension: '3d', categories: ['geometry'] },
  extrusion: { dimension: '3d', categories: ['geometry'] },
  flipflop: { dimension: '3d', categories: ['geometry'] },
  fluxcore: { dimension: '3d', categories: ['worlds'] },
  gears: { dimension: '3d', categories: ['geometry'] },
  geodesicgears: { dimension: '3d', categories: ['geometry'] },
  gimbalharmonics: { dimension: '3d', categories: ['geometry'] },
  glknots: { dimension: '3d', categories: ['geometry'] },
  glsnake: { dimension: '3d', categories: ['geometry'] },
  goldenapollian: { dimension: '3d', categories: ['fractals', 'geometry'] },
  hexplasma: { dimension: '3d', categories: ['plasma'] },
  hexstrut: { dimension: '3d', categories: ['geometry'] },
  hextrail: { dimension: '3d', categories: ['geometry'] },
  hypnowheel: { dimension: '3d', categories: ['optical', 'geometry'] },
  lament: { dimension: '3d', categories: ['geometry'] },
  lockward: { dimension: '3d', categories: ['optical', 'geometry'] },
  logarithmiccircles: { dimension: '3d', categories: ['optical', 'geometry'] },
  moebiusgears: { dimension: '3d', categories: ['geometry'] },
  morph3d: { dimension: '3d', categories: ['geometry'] },
  neongravity: { dimension: '3d', categories: ['plasma'] },
  neontriangulator: { dimension: '3d', categories: ['geometry'] },
  noxfire: { dimension: '3d', categories: ['plasma'] },
  papercube: { dimension: '3d', categories: ['geometry'] },
  pinion: { dimension: '3d', categories: ['geometry'] },
  pipes: { dimension: '3d', categories: ['geometry'] },
  prococean: { dimension: '3d', categories: ['worlds', 'fluids'] },
  protophore: { dimension: '3d', categories: ['fractals'] },
  quasicrystal: { dimension: '3d', categories: ['optical', 'geometry'] },
  rigrekt: { dimension: '3d', categories: ['worlds', 'geometry'] },
  rubik: { dimension: '3d', categories: ['geometry'] },
  rubikblocks: { dimension: '3d', categories: ['geometry'] },
  selfreflect: { dimension: '3d', categories: ['geometry', 'optical'] },
  skyline: { dimension: '3d', categories: ['worlds'] },
  stardome: { dimension: '3d', categories: ['cosmic'] },
  starnest: { dimension: '3d', categories: ['cosmic'] },
  stripeytorus: { dimension: '3d', categories: ['surfaces'] },
  superquadrics: { dimension: '3d', categories: ['geometry', 'surfaces'] },
  synthwavecity: { dimension: '3d', categories: ['worlds'] },
  topblock: { dimension: '3d', categories: ['geometry'] },
  topologica: { dimension: '3d', categories: ['plasma'] },
  trainmandala: { dimension: '3d', categories: ['optical', 'geometry'] },
  trizm: { dimension: '3d', categories: ['geometry'] },
  truchetzoom: { dimension: '3d', categories: ['geometry'] },
  universeball: { dimension: '3d', categories: ['cosmic'] },
};

// Look up a hack's facets by slug. An unknown slug falls back to no genre (it
// then shows only under "All"), so a new module never breaks the picker.
export function classify(slug) {
  return HACK_TAXONOMY[slug] || { dimension: '2d', categories: [] };
}
