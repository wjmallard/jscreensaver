// glsnake.js -- "GL Snake" (Rubik's Snake) as a self-contained three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's glsnake (Jamie Wilkinson, Andrew Bennetts,
// Peter Aylett, 2002), hacks/glx/glsnake.c. The "Rubik's Snake" puzzle: 24
// triangular prisms (NODE_COUNT) joined end-to-end by joints that rotate in
// 90-degree increments. The snake folds between named SHAPES from a big model
// table (each model = the 24 joint angles), holding each `statictime` ms then
// smoothly morphing (at `angvel`) to the next model, forever. The whole snake
// spins on Y and Z (yangvel/zangvel). Segments are translucent (DEF_TRANSPARENT)
// with a 2-colour alternating scheme; `explode` inserts a small inter-segment gap.
//
// Self-contained on purpose (own overlay canvas + renderer + render loop), like
// engine.js / glknots.js -- it only follows the host's mountable-module contract.
// Its on-screen shape-name label reuses the shared HUD overlay helper
// (hud-label.js), the web stand-in for the .c's print_texture_label.
//
// Faithful to the .c:
//   * The full 275-model shape table (name + 24 joint angles), transcribed
//     verbatim from model[] (the four #if 0 models excluded, exactly as the C
//     compiles; the two 23-entry stixpjr models zero-filled to NODE_COUNT as C
//     aggregate init does). Angles ZERO/LEFT/PIN/RIGHT = 0/90/180/270 deg.
//   * The triangular-prism node geometry (solid_prism_v / solid_prism_n) and its
//     display-list face winding, vertex-for-vertex (18 verts, 20 face normals,
//     6 corner tris + 9 edge quads + 2 face tris + 3 face quads).
//   * The per-node modelview chain Translate(.5,.5,.5) Rotate(90,-z)
//     Translate(1+explode,0,0) Rotate(180+ang,x) Translate(-.5,-.5,-.5), applied
//     cumulatively down the snake; the two-pass centre-of-mass recentring; the
//     yspin/zspin continuous rotation; the reshape gluPerspective(25) cam at z=20
//     + portrait-fit scale.
//   * The morph: node angles ease toward model[next] by 90*angvel*ms/1000 per
//     frame (shortest way round, fmod 360); statictime hold; start_morph +
//     calc_snake_metrics (is_cyclic/is_legal) picking the colour scheme; the
//     morph_percent-weighted colour interpolation (morph_colour).
//   * Fixed colour table + alternating colour[(i+1)%2]; translucent alpha 0.6,
//     blend on, depth writes on, culling off (DoubleSide). Two white lights + the
//     GL default 0.2 global ambient; dim specular {0.1} shininess 20.
//
// Motion is wall-clock-based in the .c (iter_msec), so it is here too; see the
// PACING note below and glsnake.md.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeHudLabel } from './hud-label.js';

// xscreensaver's GL fixed pipeline does NO colour management -- it writes raw
// glColor/material values to the framebuffer (no sRGB encoding), and the
// screenshots capture those raw values. Disable three's colour management so the
// port matches; without it, lit faces render up to ~2.5x too bright.
THREE.ColorManagement.enabled = false;

export const title = 'glsnake';

export const info = {
  author: 'Jamie Wilkinson',
  year: 2002,
  description:
    'The "Rubik\'s Snake" puzzle.\n\n' +
    'See also the "Rubik" and "Cube21" screen savers.\n\n' +
    'https://en.wikipedia.org/wiki/Rubik%27s_Snake',
};

// ---- joint-angle constants (glsnake.c: ZERO/LEFT/PIN/RIGHT) ----
const Z = 0.0, L = 90.0, P = 180.0, R = 270.0;
const NODE_COUNT = 24;
const START_MODEL = 2;   // "snow" -- the shape the .c always opens on

// The shape table, transcribed verbatim from glsnake.c's model[] (extracted by a
// parser, not by hand; the 4 #if-0'd models are excluded exactly as the C
// compiles, and "begging dog"/"swan" -- which list only 23 angles -- are
// zero-filled to 24 as C aggregate initialisation does). name + node[24].
const MODEL_ROWS = [
  ["straight", [Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z]],
  ["ball", [R,R,L,L,R,L,R,R,L,R,L,L,R,R,L,L,R,L,R,R,L,R,L,Z]],
  ["snow", [R,R,R,R,L,L,L,L,R,R,R,R,L,L,L,L,R,R,R,R,L,L,L,Z]],
  ["propellor", [Z,Z,Z,R,L,R,Z,L,Z,Z,Z,R,L,R,Z,L,Z,Z,Z,R,L,R,Z,L]],
  ["flamingo", [Z,P,Z,Z,Z,Z,Z,P,R,R,P,R,L,P,L,R,P,R,R,Z,Z,Z,P,Z]],
  ["cat", [Z,P,P,Z,P,P,Z,R,Z,P,P,Z,P,P,Z,P,P,Z,Z,Z,Z,Z,Z,Z]],
  ["rooster", [Z,Z,P,P,Z,L,Z,L,R,P,R,Z,P,P,Z,R,P,R,L,Z,L,Z,P,Z]],
  ["half balls", [L,L,R,L,R,R,L,R,L,L,L,L,L,L,R,L,R,R,L,R,L,L,L,Z]],
  ["zigzag1", [R,R,R,L,L,L,R,R,R,L,L,L,R,R,R,L,L,L,R,R,R,L,L,Z]],
  ["zigzag2", [P,Z,P,Z,P,Z,P,Z,P,Z,P,Z,P,Z,P,Z,P,Z,P,Z,P,Z,P,Z]],
  ["zigzag3", [P,L,P,L,P,L,P,L,P,L,P,L,P,L,P,L,P,L,P,L,P,L,P,Z]],
  ["caterpillar", [R,R,P,L,L,P,R,R,P,L,L,P,R,R,P,L,L,P,R,R,P,L,L,Z]],
  ["bow", [R,L,R,R,R,L,L,L,R,L,R,R,R,L,L,L,R,L,R,R,R,L,L,Z]],
  ["turtle", [Z,R,L,Z,Z,R,L,P,R,R,L,R,L,L,P,L,L,L,R,L,R,R,R,Z]],
  ["basket", [R,P,Z,Z,P,L,Z,L,L,Z,L,P,Z,Z,P,R,P,L,P,Z,Z,P,L,Z]],
  ["thing", [P,R,L,R,R,L,P,L,R,L,L,R,P,R,L,R,R,L,P,L,R,L,L,Z]],
  ["hexagon", [Z,Z,Z,Z,L,Z,Z,R,Z,Z,Z,Z,L,Z,Z,R,Z,Z,Z,Z,L,Z,Z,R]],
  ["tri1", [Z,Z,L,R,Z,L,Z,R,Z,Z,L,R,Z,L,Z,R,Z,Z,L,R,Z,L,Z,R]],
  ["triangle", [Z,Z,Z,Z,Z,Z,L,R,Z,Z,Z,Z,Z,Z,L,R,Z,Z,Z,Z,Z,Z,L,R]],
  ["flower", [Z,L,P,R,R,P,Z,L,P,R,R,P,Z,L,P,R,R,P,Z,L,P,R,R,P]],
  ["crucifix", [Z,P,P,Z,P,Z,P,P,Z,P,Z,P,P,Z,P,Z,Z,Z,P,P,Z,Z,Z,P]],
  ["kayak", [P,R,L,P,L,P,Z,Z,R,P,L,Z,Z,Z,Z,Z,Z,R,P,L,Z,Z,P,R]],
  ["bird", [Z,Z,Z,Z,R,R,Z,L,P,R,Z,R,Z,R,Z,R,P,L,Z,R,L,Z,P,Z]],
  ["seal", [R,L,L,P,R,L,Z,P,P,Z,L,Z,L,P,R,Z,L,L,L,P,R,R,L,Z]],
  ["dog", [Z,Z,Z,Z,P,P,Z,P,Z,Z,P,Z,P,P,Z,Z,Z,P,Z,P,P,Z,P,Z]],
  ["frog", [R,R,L,L,R,P,R,P,L,P,R,Z,L,Z,L,P,R,Z,L,L,R,L,L,Z]],
  ["quavers", [L,L,R,L,R,R,Z,Z,Z,R,Z,Z,L,R,Z,Z,Z,L,L,R,L,R,R,Z]],
  ["fly", [L,L,R,L,R,R,Z,P,Z,Z,L,P,R,Z,Z,P,Z,L,L,R,L,R,R,Z]],
  ["puppy", [Z,P,Z,P,P,Z,P,P,Z,Z,Z,R,R,P,R,L,P,L,R,P,R,L,Z,Z]],
  ["stars", [L,R,P,R,L,P,L,R,P,R,Z,Z,Z,R,P,R,L,P,L,R,P,R,L,Z]],
  ["mountains", [R,P,R,P,R,P,L,P,L,P,L,P,R,P,R,P,R,P,L,P,L,P,L,P]],
  ["quad1", [R,P,R,R,R,P,L,L,L,P,L,P,R,P,R,R,R,P,L,L,L,P,L,P]],
  ["quad2", [Z,P,R,R,R,P,L,L,L,P,Z,P,Z,P,R,R,R,P,L,L,L,P,Z,P]],
  ["glasses", [Z,P,Z,R,R,P,L,L,Z,P,Z,P,Z,P,Z,R,R,P,L,L,Z,P,Z,P]],
  ["em", [Z,P,Z,Z,R,P,L,Z,Z,P,Z,P,Z,P,Z,Z,R,P,L,Z,Z,P,Z,P]],
  ["quad3", [Z,R,Z,Z,R,P,L,Z,Z,L,Z,P,Z,R,Z,Z,R,P,L,Z,Z,L,Z,P]],
  ["vee", [Z,Z,Z,Z,R,P,L,Z,Z,Z,Z,P,Z,Z,Z,Z,R,P,L,Z,Z,Z,Z,P]],
  ["square", [Z,Z,Z,R,R,P,L,L,Z,Z,Z,P,Z,Z,Z,R,R,P,L,L,Z,Z,Z,P]],
  ["eagle", [R,Z,Z,R,R,P,L,L,Z,Z,L,P,R,Z,Z,R,R,P,L,L,Z,Z,L,P]],
  ["volcano", [R,Z,L,R,R,P,L,L,R,Z,L,P,R,Z,L,R,R,P,L,L,R,Z,L,P]],
  ["saddle", [R,Z,L,Z,R,P,L,Z,R,Z,L,P,R,Z,L,Z,R,P,L,Z,R,Z,L,P]],
  ["c3d", [Z,Z,R,Z,Z,P,Z,Z,L,Z,Z,P,Z,Z,R,Z,Z,P,Z,Z,L,Z,Z,P]],
  ["block", [Z,Z,P,P,Z,R,P,L,P,R,P,R,P,L,P,R,Z,Z,P,Z,Z,L,P,R]],
  ["duck", [L,P,L,P,Z,P,P,Z,P,Z,L,P,R,Z,P,Z,P,P,Z,Z,L,P,L,Z]],
  ["prayer", [R,R,R,L,R,L,L,Z,Z,Z,R,P,L,Z,Z,Z,R,R,L,R,L,L,L,P]],
  ["giraffe", [Z,Z,Z,R,P,L,Z,Z,Z,R,R,R,P,L,R,Z,P,Z,L,R,P,L,L,L]],
  ["tie fighter", [P,L,R,L,L,P,R,Z,R,L,Z,P,L,L,R,R,R,P,L,Z,L,R,Z,Z]],
  ["Strong Arms", [P,P,Z,Z,P,Z,Z,R,Z,R,R,P,R,R,Z,R,Z,Z,P,Z,Z,P,P,Z]],
  ["cool looking gegl", [P,P,Z,Z,R,Z,Z,P,P,Z,L,Z,Z,P,Z,P,P,Z,L,R,P,Z,Z,Z]],
  ["knuckledusters", [Z,Z,Z,Z,P,R,Z,P,P,Z,P,P,Z,R,R,Z,P,P,Z,P,P,Z,R,Z]],
  ["k's turd", [R,R,P,R,L,R,P,R,L,R,P,R,L,R,P,R,L,R,P,R,L,R,P,Z]],
  ["lightsabre", [Z,Z,Z,Z,Z,P,P,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z]],
  ["not a stairway", [L,Z,R,L,R,Z,L,R,L,Z,R,L,R,Z,L,R,L,Z,R,L,R,Z,L,Z]],
  ["not very good (but accurate) gegl", [Z,P,P,Z,Z,Z,P,P,Z,L,Z,P,P,Z,R,L,Z,P,Z,P,P,Z,P,Z]],
  ["box", [Z,Z,Z,Z,P,Z,Z,Z,Z,Z,Z,P,Z,Z,Z,Z,P,Z,Z,Z,Z,Z,Z,Z]],
  ["kissy box", [P,Z,Z,Z,P,Z,Z,Z,Z,Z,Z,P,Z,Z,Z,Z,P,Z,Z,Z,Z,Z,P,Z]],
  ["erect penis", [P,Z,P,P,Z,Z,P,Z,Z,Z,P,P,Z,Z,Z,R,Z,Z,Z,Z,Z,Z,Z,Z]],
  ["flaccid penis", [P,Z,P,P,Z,Z,P,Z,Z,Z,P,P,Z,Z,Z,R,P,Z,Z,Z,Z,Z,Z,Z]],
  ["vagina", [R,Z,Z,Z,R,Z,Z,P,Z,Z,L,Z,Z,Z,L,Z,L,P,L,P,R,P,R,Z]],
  ["mask", [Z,R,L,P,R,R,P,Z,Z,P,Z,Z,P,Z,P,Z,P,Z,Z,P,Z,Z,Z,Z]],
  ["poles or columns or something", [L,R,L,Z,Z,Z,P,P,Z,Z,Z,L,R,L,Z,Z,Z,P,P,Z,Z,Z,L,Z]],
  ["crooked v", [Z,L,Z,Z,Z,Z,P,P,Z,Z,Z,L,Z,L,Z,Z,Z,P,P,Z,Z,Z,Z,Z]],
  ["dog leg", [Z,L,Z,Z,Z,Z,P,P,Z,Z,Z,L,Z,R,Z,Z,Z,Z,P,P,Z,Z,Z,Z]],
  ["scrubby", [Z,Z,Z,Z,Z,L,Z,Z,Z,Z,L,R,Z,Z,Z,Z,L,R,Z,Z,L,P,Z,Z]],
  ["voltron's eyes", [Z,Z,P,R,Z,L,Z,Z,R,Z,L,P,Z,Z,P,Z,L,Z,R,L,Z,R,Z,Z]],
  ["flying toaster", [P,Z,Z,P,P,Z,R,Z,P,P,Z,R,Z,P,P,Z,R,Z,P,P,Z,Z,P,Z]],
  ["dubbya", [P,Z,Z,P,P,Z,R,Z,P,P,Z,Z,Z,P,P,Z,R,Z,P,P,Z,Z,P,Z]],
  ["tap handle", [P,Z,Z,P,P,Z,R,Z,P,P,Z,L,Z,P,P,Z,R,Z,P,P,Z,Z,P,Z]],
  ["wingnut", [P,Z,Z,P,P,Z,R,Z,P,P,Z,P,Z,P,P,Z,R,Z,P,P,Z,Z,P,Z]],
  ["tight twist", [R,Z,Z,L,Z,L,R,Z,R,L,R,P,R,L,R,Z,R,L,Z,L,Z,Z,R,Z]],
  ["double helix", [R,Z,R,Z,R,Z,R,Z,R,Z,R,Z,R,L,R,P,Z,R,Z,R,Z,R,Z,Z]],
  ["begging dog", [Z,R,R,R,P,L,R,Z,R,L,P,R,R,Z,L,P,L,R,P,R,L,P,L,Z]],
  ["swan", [Z,P,Z,Z,Z,L,Z,L,Z,Z,R,P,L,Z,Z,L,P,R,Z,Z,L,Z,L,Z]],
  ["toadstool", [L,R,Z,R,L,Z,Z,R,L,P,R,R,L,R,L,L,R,R,R,P,R,L,P,Z]],
  ["AlanH2", [L,R,Z,R,L,Z,Z,R,L,P,R,R,L,R,L,L,R,R,L,L,R,L,R,Z]],
  ["AlanH3", [L,R,Z,R,L,Z,Z,R,L,P,R,R,L,R,L,L,R,R,L,P,L,R,P,Z]],
  ["AlanH4", [Z,Z,P,L,R,L,Z,R,L,R,Z,P,Z,L,R,L,Z,R,L,R,P,Z,Z,Z]],
  ["Alien", [R,L,R,P,Z,Z,P,R,L,R,Z,P,P,Z,L,L,R,R,L,L,Z,P,P,Z]],
  ["Angel", [Z,R,L,P,R,R,R,L,L,R,L,R,R,L,L,L,P,R,L,Z,Z,R,L,Z]],
  ["AnotherFigure", [L,P,R,Z,Z,P,R,L,L,P,R,L,Z,P,Z,R,L,P,R,R,L,P,Z,Z]],
  ["Ball", [L,R,L,R,R,L,R,L,L,R,L,R,R,L,R,L,L,R,L,R,R,L,R,Z]],
  ["Basket", [Z,R,R,Z,R,R,Z,R,L,Z,L,L,P,R,L,Z,L,R,P,L,L,Z,L,Z]],
  ["Beetle", [P,L,R,Z,L,L,R,L,R,R,L,R,L,L,R,L,R,R,Z,L,R,P,R,Z]],
  ["bone", [P,P,L,Z,P,P,Z,L,Z,Z,Z,Z,Z,Z,Z,R,Z,P,P,Z,R,P,P,Z]],
  ["Bow", [L,L,L,R,L,R,R,R,L,L,L,R,L,R,R,R,L,L,L,R,L,R,R,Z]],
  ["bra", [R,R,L,L,R,L,R,R,L,L,L,R,R,R,L,L,R,L,R,R,L,L,L,Z]],
  ["bronchosaurus", [Z,P,Z,P,P,Z,P,Z,Z,P,Z,P,P,Z,Z,Z,Z,Z,Z,Z,Z,Z,P,Z]],
  ["Cactus", [P,L,Z,P,P,Z,R,P,L,Z,Z,P,R,P,L,Z,Z,R,P,L,P,Z,Z,Z]],
  ["Camel", [R,Z,P,R,P,R,Z,R,P,R,L,P,L,R,P,R,Z,R,P,R,Z,Z,L,Z]],
  ["Candlestick", [L,P,L,Z,R,P,L,Z,R,P,R,P,L,P,L,Z,R,P,L,Z,R,P,R,Z]],
  ["Cat", [Z,P,P,Z,P,P,Z,R,Z,P,P,Z,P,P,Z,P,P,Z,Z,Z,Z,Z,Z,Z]],
  ["Cave", [R,Z,Z,P,L,Z,P,P,Z,R,L,P,R,R,L,L,P,R,R,L,P,Z,Z,Z]],
  ["Chains", [P,Z,Z,P,L,L,P,R,R,P,Z,Z,P,Z,Z,P,L,L,P,R,R,P,Z,Z]],
  ["Chair", [R,L,R,R,R,L,R,Z,Z,P,P,Z,P,P,Z,P,P,Z,Z,L,R,L,L,Z]],
  ["Chick", [R,R,R,P,L,P,L,P,R,R,R,P,L,L,L,P,R,P,R,P,L,L,L,Z]],
  ["Clockwise", [R,R,R,R,R,R,R,R,R,R,R,R,R,R,R,R,R,R,R,R,R,R,R,Z]],
  ["cobra", [Z,R,L,L,R,L,R,R,L,R,L,L,L,L,Z,L,R,Z,Z,P,Z,Z,R,Z]],
  ["Cobra3", [Z,L,Z,P,P,Z,P,P,Z,R,Z,P,Z,Z,L,Z,Z,Z,P,Z,Z,Z,L,Z]],
  ["Compact1", [Z,Z,P,Z,Z,L,P,R,P,L,P,L,P,R,P,L,Z,P,P,Z,Z,L,P,Z]],
  ["Compact2", [L,P,R,Z,Z,P,P,Z,R,P,L,Z,Z,R,P,R,P,L,P,R,Z,Z,Z,Z]],
  ["Compact3", [Z,P,Z,P,P,Z,L,P,R,Z,P,P,Z,P,Z,P,P,Z,L,P,R,Z,P,Z]],
  ["Compact4", [P,R,Z,Z,P,Z,Z,P,P,Z,P,R,P,L,P,Z,P,P,Z,Z,P,Z,Z,Z]],
  ["Compact5", [L,Z,L,P,R,P,L,P,L,P,R,P,R,P,L,P,R,Z,R,P,R,P,L,Z]],
  ["Contact", [P,Z,Z,P,L,L,P,L,R,R,P,L,L,R,P,R,R,P,Z,Z,P,R,P,Z]],
  ["Contact2", [R,P,Z,L,L,P,R,R,Z,P,L,P,R,P,Z,L,L,P,R,R,Z,P,L,Z]],
  ["Cook", [Z,Z,P,P,Z,R,Z,R,L,P,L,Z,P,P,Z,L,P,L,R,Z,R,Z,P,Z]],
  ["Counterclockwise", [L,L,L,L,L,L,L,L,L,L,L,L,L,L,L,L,L,L,L,L,L,L,L,Z]],
  ["Cradle", [L,L,Z,P,L,R,L,L,R,L,R,R,L,R,P,Z,R,R,L,L,Z,Z,R,Z]],
  ["Crankshaft", [Z,P,P,Z,P,P,Z,P,L,L,P,R,L,Z,P,L,P,R,Z,Z,Z,P,R,Z]],
  ["Cross", [Z,P,Z,P,P,Z,P,Z,Z,Z,P,P,Z,Z,Z,P,Z,P,P,Z,P,Z,P,Z]],
  ["Cross2", [Z,Z,P,P,Z,L,Z,Z,P,P,Z,R,Z,Z,P,P,Z,L,Z,Z,P,P,Z,Z]],
  ["Cross3", [Z,Z,P,P,Z,L,Z,Z,P,P,Z,R,Z,Z,P,P,Z,L,Z,Z,P,P,Z,Z]],
  ["CrossVersion1", [P,Z,R,P,L,P,R,P,R,P,L,P,R,Z,P,R,P,R,L,P,L,R,P,Z]],
  ["CrossVersion2", [R,L,P,L,L,Z,R,L,P,R,R,P,L,L,P,R,L,Z,L,L,P,L,R,Z]],
  ["Crown", [L,Z,P,Z,R,Z,Z,L,Z,P,Z,R,L,Z,P,Z,R,Z,Z,L,Z,P,Z,Z]],
  ["DNAStrand", [R,P,R,P,R,P,R,P,R,P,R,P,R,P,R,P,R,P,R,P,R,P,R,Z]],
  ["Diamond", [Z,R,Z,Z,L,Z,Z,R,P,L,L,R,L,R,R,P,L,Z,Z,R,Z,Z,L,Z]],
  ["Dog", [R,R,L,R,L,L,L,R,R,L,R,L,L,R,R,R,L,R,L,L,Z,L,R,Z]],
  ["DogFace", [Z,Z,P,P,Z,L,L,R,P,Z,P,P,Z,P,L,R,R,Z,P,P,Z,Z,P,Z]],
  ["DoublePeak", [Z,Z,P,Z,Z,R,L,P,L,R,P,R,L,L,Z,P,Z,R,R,L,P,L,R,Z]],
  ["DoubleRoof", [Z,L,L,R,R,L,R,L,L,R,L,R,R,L,L,Z,L,R,P,L,L,P,R,Z]],
  ["txoboggan", [Z,Z,Z,R,P,L,Z,Z,Z,P,P,Z,Z,Z,Z,L,P,R,Z,Z,Z,Z,P,Z]],
  ["Doubled", [L,P,L,R,P,R,L,P,L,R,L,Z,L,P,L,P,L,R,P,R,L,P,L,Z]],
  ["Doubled1", [L,P,L,R,P,R,L,P,L,Z,R,Z,R,Z,L,P,L,R,P,R,L,P,L,Z]],
  ["Doubled2", [L,P,L,R,P,R,L,P,L,L,R,Z,R,L,L,P,L,R,P,R,L,P,L,Z]],
  ["DumblingSpoon", [P,P,Z,Z,Z,Z,Z,L,Z,Z,L,R,Z,Z,L,R,Z,Z,R,Z,Z,Z,Z,Z]],
  ["Embrace", [P,Z,Z,P,R,P,L,P,Z,R,P,R,P,L,P,L,Z,P,R,P,L,P,Z,Z]],
  ["EndlessBelt", [Z,R,L,Z,Z,Z,L,R,Z,P,R,L,Z,L,R,L,P,L,R,L,Z,L,R,Z]],
  ["Entrance", [L,L,R,R,R,L,L,R,L,R,R,R,L,L,L,R,L,R,R,L,L,L,R,Z]],
  ["Esthetic", [L,L,P,R,R,Z,L,P,R,P,L,P,L,P,R,P,L,Z,R,L,P,R,R,Z]],
  ["Explosion", [R,R,R,R,L,R,L,L,R,R,R,L,R,L,L,L,R,R,L,R,L,L,L,Z]],
  ["F-ZeroXCar", [R,R,L,R,L,L,P,R,L,Z,Z,R,L,Z,Z,L,R,P,R,L,P,L,R,Z]],
  ["Face", [Z,R,P,R,L,P,L,L,P,R,R,P,R,L,P,L,P,L,P,L,R,P,R,Z]],
  ["Fantasy", [L,L,R,P,Z,R,Z,L,P,L,P,R,P,R,Z,L,Z,P,L,R,R,R,P,Z]],
  ["Fantasy1", [P,Z,Z,P,P,Z,P,R,L,R,R,P,L,L,R,L,P,Z,P,P,Z,Z,P,Z]],
  ["FaserGun", [Z,Z,L,R,P,R,Z,R,P,R,L,P,L,R,P,R,Z,R,P,R,R,Z,P,Z]],
  ["FelixW", [Z,R,Z,P,L,Z,L,R,Z,Z,R,P,L,Z,Z,L,R,Z,R,P,Z,L,Z,Z]],
  ["Flamingo", [Z,P,Z,Z,Z,Z,Z,P,L,L,P,L,R,P,R,L,P,L,L,Z,Z,Z,P,Z]],
  ["FlatOnTheTop", [Z,P,P,Z,P,R,Z,R,L,P,R,R,P,L,R,Z,R,Z,Z,P,Z,Z,P,Z]],
  ["Fly", [Z,L,P,R,Z,P,L,P,L,R,P,R,P,R,P,L,P,L,P,L,R,P,R,Z]],
  ["Fountain", [L,R,L,R,R,P,L,P,L,R,R,P,L,L,R,R,P,L,L,R,P,R,P,Z]],
  ["Frog", [L,L,R,R,L,P,L,P,R,P,L,Z,R,Z,R,P,L,Z,R,R,L,R,R,Z]],
  ["Frog2", [L,Z,L,R,R,P,L,R,Z,Z,R,P,L,Z,Z,L,R,P,L,L,R,Z,R,Z]],
  ["Furby", [P,Z,L,P,R,Z,P,P,Z,P,P,Z,Z,P,Z,R,P,L,Z,P,Z,Z,P,Z]],
  ["Gate", [Z,Z,P,Z,Z,R,Z,P,P,Z,L,P,L,L,P,R,R,P,R,Z,P,P,Z,Z]],
  ["Ghost", [L,L,L,R,R,L,R,L,L,R,R,R,P,L,R,Z,Z,L,R,Z,Z,L,R,Z]],
  ["Globus", [R,L,Z,P,L,L,R,R,L,R,L,L,R,L,R,R,L,R,P,Z,R,L,Z,Z]],
  ["Grotto", [P,P,Z,L,R,L,Z,P,R,P,L,Z,Z,Z,Z,R,P,L,P,Z,R,L,R,Z]],
  ["H", [P,Z,P,P,Z,Z,Z,Z,P,P,Z,P,L,Z,P,P,Z,Z,Z,Z,P,P,Z,Z]],
  ["HeadOfDevil", [P,Z,R,Z,R,P,L,Z,R,P,R,L,P,L,L,P,R,R,P,R,L,Z,Z,Z]],
  ["Heart", [R,Z,Z,Z,P,L,P,L,R,R,Z,P,Z,L,L,R,P,R,P,Z,Z,Z,L,Z]],
  ["Heart2", [Z,P,Z,Z,L,Z,L,Z,Z,Z,Z,P,Z,Z,Z,Z,R,Z,R,Z,Z,P,Z,Z]],
  ["Hexagon", [Z,Z,Z,Z,L,Z,Z,R,Z,Z,Z,Z,L,Z,Z,R,Z,Z,Z,Z,L,Z,Z,Z]],
  ["HoleInTheMiddle1", [Z,L,R,P,L,L,P,R,L,Z,L,R,Z,R,L,P,R,R,P,L,R,Z,R,Z]],
  ["HoleInTheMiddle2", [Z,L,R,Z,R,R,P,L,R,Z,R,L,Z,L,R,Z,R,R,P,L,R,Z,R,Z]],
  ["HouseBoat", [R,R,P,L,L,L,P,R,R,R,P,L,R,Z,L,P,R,P,L,P,L,R,P,Z]],
  ["HouseByHouse", [L,P,L,P,L,P,R,P,R,P,R,P,L,P,L,P,L,P,R,P,R,P,R,Z]],
  ["Infinity", [L,L,L,R,R,L,L,R,R,L,L,L,L,L,L,R,R,L,L,R,R,L,L,Z]],
  ["Integral", [R,R,R,R,R,L,L,R,L,R,R,L,L,L,L,L,L,R,R,L,R,L,L,Z]],
  ["Iron", [Z,Z,Z,Z,P,R,Z,R,Z,Z,L,P,R,Z,Z,R,P,L,Z,Z,R,Z,R,Z]],
  ["just squares", [R,R,L,P,L,P,R,P,R,L,L,P,R,R,L,P,L,P,R,P,R,L,L,Z]],
  ["Kink", [Z,P,P,Z,P,Z,P,P,Z,Z,R,P,L,Z,Z,P,P,Z,P,Z,P,P,Z,Z]],
  ["Knot", [L,L,P,L,Z,L,R,L,P,L,L,R,R,P,R,L,R,Z,R,P,R,R,L,Z]],
  ["Leaf", [Z,P,P,Z,Z,L,Z,L,Z,Z,P,Z,Z,R,Z,R,P,L,Z,R,P,L,Z,Z]],
  ["LeftAsRight", [R,P,L,R,L,Z,R,L,P,R,R,P,L,L,P,R,L,Z,R,L,R,P,L,Z]],
  ["Long-necked", [P,Z,L,P,L,P,R,P,R,Z,P,Z,L,P,L,P,R,P,L,Z,P,P,Z,Z]],
  ["lunar module", [P,L,L,R,L,R,R,L,R,L,L,R,L,R,R,P,L,R,Z,R,L,Z,L,Z]],
  ["magnifying glass", [Z,Z,P,Z,L,Z,P,P,Z,Z,R,P,L,Z,Z,P,P,Z,R,Z,P,Z,Z,Z]],
  ["Mask", [Z,Z,Z,R,Z,R,L,Z,L,P,Z,P,Z,Z,P,Z,P,R,Z,R,L,Z,L,Z]],
  ["Microscope", [P,P,Z,Z,P,Z,R,P,Z,Z,R,P,L,Z,Z,P,L,Z,P,P,Z,P,P,Z]],
  ["Mirror", [P,R,L,Z,P,P,Z,Z,L,R,Z,Z,P,Z,Z,L,R,P,R,Z,P,P,Z,Z]],
  ["MissPiggy", [Z,L,L,P,R,Z,R,R,P,L,L,R,R,P,L,L,Z,L,P,R,R,Z,R,Z]],
  ["Mole", [Z,R,Z,R,L,R,P,Z,L,P,R,Z,P,L,R,L,Z,L,Z,R,R,P,L,Z]],
  ["Monk", [L,Z,P,P,Z,L,Z,P,P,Z,R,Z,P,P,Z,R,L,R,R,L,R,L,L,Z]],
  ["Mountain", [Z,R,L,P,R,R,P,L,R,Z,L,P,L,Z,R,L,P,R,R,P,L,R,Z,Z]],
  ["mountains", [Z,P,Z,L,P,L,R,P,R,P,R,P,L,P,L,P,L,R,P,R,Z,P,Z,Z]],
  ["MouseWithoutTail", [Z,P,P,Z,L,Z,P,P,Z,Z,R,P,L,Z,Z,P,P,Z,R,Z,P,P,Z,Z]],
  ["mushroom", [P,L,L,R,L,R,R,P,L,R,Z,Z,L,P,Z,R,Z,P,P,Z,L,Z,P,Z]],
  ["necklace", [Z,Z,L,Z,Z,Z,L,Z,Z,Z,Z,P,Z,Z,Z,Z,R,Z,Z,Z,R,Z,Z,Z]],
  ["NestledAgainst", [L,Z,P,L,L,R,R,P,Z,R,P,L,Z,R,L,P,R,R,L,R,L,L,L,Z]],
  ["NoClue", [Z,R,P,L,L,L,Z,L,P,R,R,P,L,L,P,R,Z,R,R,R,P,L,Z,Z]],
  ["Noname", [L,P,R,P,R,Z,P,Z,Z,P,P,Z,P,P,Z,R,P,L,P,R,P,R,L,Z]],
  ["Obelisk", [P,Z,Z,Z,P,R,P,L,P,L,P,L,R,P,R,P,R,P,L,P,Z,Z,Z,Z]],
  ["Ostrich", [Z,Z,P,P,Z,L,Z,P,P,Z,P,P,Z,R,Z,P,P,Z,Z,Z,Z,Z,P,Z]],
  ["Ostrich2", [P,P,Z,P,L,L,L,R,L,R,R,L,R,L,L,R,P,Z,P,Z,Z,P,Z,Z]],
  ["pair of glasses", [Z,P,Z,Z,P,Z,Z,P,Z,L,Z,P,Z,R,Z,P,Z,Z,P,Z,Z,P,Z,Z]],
  ["Parrot", [Z,Z,Z,Z,R,R,Z,L,P,R,Z,R,Z,R,Z,R,P,L,Z,R,L,Z,P,Z]],
  ["Penis", [P,P,R,Z,P,P,Z,P,Z,Z,R,P,L,Z,Z,P,Z,P,P,Z,L,P,P,Z]],
  ["PictureComingSoon", [L,L,Z,R,L,P,R,R,P,R,L,P,L,R,P,R,R,P,R,L,Z,R,R,Z]],
  ["Pitti", [L,P,Z,Z,P,Z,Z,P,Z,Z,R,P,L,Z,Z,P,Z,Z,P,Z,Z,P,R,Z]],
  ["Plait", [L,L,L,L,L,L,L,L,L,L,R,L,R,R,R,R,R,R,R,R,R,R,L,Z]],
  ["Platform", [R,P,Z,Z,Z,Z,P,Z,Z,P,P,Z,P,L,Z,R,L,P,R,R,P,L,R,Z]],
  ["PodRacer", [Z,P,Z,P,R,P,Z,R,P,L,L,P,R,L,Z,P,P,Z,Z,L,Z,P,L,Z]],
  ["Prawn", [R,P,Z,P,R,Z,P,P,Z,Z,L,P,R,Z,Z,P,P,Z,L,P,Z,P,L,Z]],
  ["Propeller", [Z,Z,Z,R,Z,L,R,L,Z,Z,Z,R,Z,L,R,L,Z,Z,Z,R,Z,L,R,Z]],
  ["Pyramid", [Z,L,P,R,Z,L,P,R,Z,L,P,R,Z,P,R,L,L,L,P,R,R,R,L,Z]],
  ["QuarterbackTiltedAndReadyToHut", [P,Z,R,R,L,R,P,R,L,R,Z,P,Z,L,R,L,P,L,R,L,L,Z,P,Z]],
  ["Ra", [P,L,L,L,R,L,R,R,L,R,L,L,Z,L,L,R,L,R,R,L,R,L,L,Z]],
  ["Rattlesnake", [L,Z,L,Z,L,Z,L,L,Z,L,Z,L,Z,L,R,Z,P,R,R,R,R,R,R,Z]],
  ["Revelation", [Z,Z,Z,P,Z,Z,P,R,L,L,L,R,R,L,L,R,R,R,L,P,Z,Z,P,Z]],
  ["Revolution1", [L,L,P,R,Z,P,Z,L,P,R,R,P,L,L,P,R,Z,P,Z,L,P,R,R,Z]],
  ["Ribbon", [R,R,L,R,L,L,P,Z,P,P,Z,P,Z,P,P,Z,P,R,R,L,R,L,L,Z]],
  ["Rocket", [R,Z,L,P,R,Z,R,Z,L,Z,R,P,L,Z,R,Z,L,Z,L,P,R,Z,L,Z]],
  ["Roofed", [Z,L,P,R,Z,P,L,Z,P,Z,R,P,Z,L,P,R,Z,P,L,Z,P,Z,R,Z]],
  ["Roofs", [P,P,R,Z,L,P,R,P,L,P,L,P,R,P,R,P,L,P,R,Z,L,P,P,Z]],
  ["RowHouses", [R,P,L,P,R,P,R,P,L,P,L,P,R,P,R,P,L,P,L,P,R,P,L,Z]],
  ["Sculpture", [R,L,P,Z,Z,Z,L,R,L,P,Z,Z,P,L,R,L,Z,Z,Z,P,L,R,L,Z]],
  ["Seal", [L,L,L,P,R,R,R,Z,L,P,R,Z,L,L,L,P,R,L,Z,P,P,Z,L,Z]],
  ["Seal2", [R,P,Z,L,L,L,R,L,R,R,R,P,R,R,P,L,R,Z,Z,L,R,Z,Z,Z]],
  ["Sheep", [R,L,L,R,R,L,L,R,L,R,R,R,R,R,L,R,L,L,L,L,L,R,L,Z]],
  ["Shelter", [L,R,L,R,R,L,R,L,L,R,Z,Z,Z,Z,P,Z,Z,P,Z,Z,Z,Z,R,Z]],
  ["Ship", [P,R,L,L,L,L,P,R,R,R,R,L,Z,L,Z,R,P,L,Z,L,Z,P,P,Z]],
  ["Shpongle", [L,R,Z,R,L,R,Z,R,L,R,Z,R,L,R,Z,R,L,R,Z,R,L,R,Z,Z]],
  ["Slide", [L,R,L,R,Z,L,R,L,P,Z,Z,P,Z,Z,P,R,L,Z,Z,R,L,R,L,Z]],
  ["SmallShip", [Z,L,R,Z,R,L,Z,L,R,Z,L,R,Z,L,R,Z,R,L,Z,L,R,Z,L,Z]],
  ["SnakeReadyToStrike", [L,Z,L,Z,L,Z,L,R,Z,R,Z,R,Z,L,Z,Z,Z,P,Z,Z,Z,Z,L,Z]],
  ["Snakes14", [R,R,P,Z,R,L,R,Z,Z,Z,R,P,L,P,Z,P,L,P,R,Z,Z,L,R,Z]],
  ["Snakes15", [Z,P,P,Z,P,P,Z,P,L,L,P,R,L,Z,P,L,P,R,Z,Z,Z,P,R,Z]],
  ["Snakes18", [P,P,L,P,L,P,R,Z,R,P,R,Z,R,P,L,P,R,Z,P,P,Z,Z,P,Z]],
  ["Snowflake", [L,L,L,R,R,R,R,L,L,L,L,R,R,R,R,L,L,L,L,R,R,R,R,Z]],
  ["Snowman", [Z,P,P,Z,P,P,Z,Z,Z,P,P,Z,P,P,Z,Z,Z,P,P,Z,P,P,Z,Z]],
  ["Source", [P,R,Z,P,Z,L,P,R,P,L,L,R,L,R,R,P,L,L,R,L,R,R,P,Z]],
  ["Spaceship", [P,P,R,R,P,R,L,P,L,P,R,P,R,L,P,L,R,P,R,P,R,P,P,Z]],
  ["Spaceship2", [P,P,L,P,L,P,R,Z,P,P,Z,L,P,R,Z,P,Z,L,P,L,L,P,P,Z]],
  ["Speedboat", [L,Z,Z,L,P,R,Z,Z,L,Z,Z,P,Z,Z,R,Z,Z,L,P,R,Z,Z,R,Z]],
  ["Speedboat2", [P,R,L,L,R,R,R,Z,L,P,R,Z,L,L,L,R,R,L,P,Z,R,P,L,Z]],
  ["Spider", [R,R,Z,Z,L,R,L,P,Z,L,Z,P,P,Z,R,Z,P,R,L,R,Z,Z,L,Z]],
  ["Spitzbergen", [P,L,Z,R,R,L,P,Z,L,P,R,R,P,L,L,P,R,Z,P,R,L,L,Z,Z]],
  ["Square", [Z,Z,L,L,P,R,R,Z,Z,L,L,P,R,R,Z,Z,L,L,P,R,R,Z,Z,Z]],
  ["SquareHole", [P,Z,P,Z,Z,P,P,Z,P,Z,Z,P,Z,Z,P,Z,P,P,Z,Z,P,Z,P,Z]],
  ["Stage", [R,Z,L,P,L,R,P,R,L,R,P,R,L,P,L,R,L,P,L,R,P,R,Z,Z]],
  ["Stairs", [Z,P,Z,P,Z,P,Z,P,Z,P,Z,P,Z,P,Z,P,Z,P,Z,P,Z,P,Z,Z]],
  ["Stairs2", [Z,P,Z,P,Z,P,P,Z,Z,P,Z,P,Z,P,Z,P,Z,P,P,Z,Z,P,Z,Z]],
  ["Straight", [Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z,Z]],
  ["Swan", [Z,P,Z,P,L,L,P,L,P,R,P,R,L,P,L,R,P,R,P,L,P,L,R,Z]],
  ["Swan2", [P,Z,P,R,R,R,L,R,L,L,R,L,R,R,R,P,Z,Z,Z,Z,Z,P,P,Z]],
  ["Swan3", [P,P,Z,Z,Z,R,Z,R,Z,Z,L,P,R,Z,Z,R,P,L,Z,Z,R,Z,R,Z]],
  ["Symbol", [R,R,P,Z,P,P,Z,P,L,L,R,L,R,R,P,Z,P,P,Z,P,L,L,R,Z]],
  ["Symmetry", [R,Z,L,R,L,Z,L,R,L,Z,R,P,L,Z,R,L,R,Z,R,L,R,Z,L,Z]],
  ["Symmetry2", [Z,P,L,L,P,Z,Z,L,P,R,P,L,L,P,R,R,P,L,L,P,R,P,L,Z]],
  ["TableFireworks", [Z,R,L,P,R,R,R,P,L,R,Z,R,L,P,R,R,R,P,R,L,Z,R,P,Z]],
  ["Tapering", [Z,Z,R,L,P,L,Z,P,P,Z,L,P,R,Z,P,P,Z,R,P,R,L,Z,Z,Z]],
  ["TaperingTurned", [Z,Z,R,L,P,L,Z,P,P,Z,L,Z,R,Z,P,P,Z,R,P,R,L,Z,Z,Z]],
  ["TeaLightStick", [R,Z,P,P,Z,L,R,P,L,L,R,R,P,L,L,R,R,P,L,L,R,R,P,Z]],
  ["thighmaster", [R,Z,Z,R,L,Z,Z,R,L,Z,Z,L,R,Z,Z,R,L,Z,Z,R,L,Z,Z,Z]],
  ["Terraces", [R,L,Z,R,L,P,L,L,P,L,R,R,R,L,L,L,R,P,R,R,P,R,L,Z]],
  ["Terrier", [P,Z,P,P,Z,P,Z,Z,Z,P,P,Z,P,Z,Z,P,Z,P,P,Z,Z,Z,Z,Z]],
  ["Three-Legged", [R,Z,L,R,Z,L,P,R,Z,R,Z,P,Z,L,Z,L,P,R,Z,L,R,Z,L,Z]],
  ["ThreePeaks", [R,Z,Z,R,P,L,P,R,P,R,R,P,L,L,P,L,P,R,P,L,Z,Z,L,Z]],
  ["ToTheFront", [Z,P,R,L,L,L,P,R,L,Z,P,P,Z,L,L,P,Z,L,R,Z,P,Z,L,Z]],
  ["Top", [P,L,L,P,L,Z,Z,R,L,P,R,R,L,R,L,L,P,R,P,R,R,P,Z,Z]],
  ["Transport", [P,Z,Z,P,P,Z,P,P,Z,P,P,Z,P,P,Z,P,P,Z,Z,P,Z,Z,Z,Z]],
  ["Triangle", [Z,Z,Z,Z,Z,Z,R,L,Z,Z,Z,Z,Z,Z,R,L,Z,Z,Z,Z,Z,Z,R,Z]],
  ["Tripple", [P,Z,P,L,P,R,P,R,P,Z,P,L,P,R,P,Z,P,L,P,L,P,R,P,Z]],
  ["Twins", [Z,P,Z,L,P,L,R,P,R,P,Z,Z,P,L,P,L,R,P,R,Z,P,Z,Z,Z]],
  ["TwoSlants", [Z,P,Z,Z,P,P,Z,P,Z,R,P,R,L,P,L,P,R,P,L,Z,Z,R,P,Z]],
  ["TwoWings", [P,L,Z,R,Z,P,P,Z,P,P,Z,P,P,Z,L,Z,R,P,L,Z,R,L,Z,Z]],
  ["UFO", [L,L,R,L,R,R,L,R,L,L,L,P,L,L,L,R,L,R,R,L,R,L,L,Z]],
  ["USS Enterprise", [L,P,R,P,R,L,Z,P,P,Z,R,L,Z,P,P,Z,R,L,P,L,P,R,Z,Z]],
  ["UpAndDown", [Z,P,Z,P,Z,P,L,P,R,P,Z,P,Z,P,Z,P,Z,P,L,P,R,P,Z,Z]],
  ["Upright", [Z,R,R,L,R,L,L,P,Z,Z,L,P,R,Z,Z,P,R,R,L,R,L,L,Z,Z]],
  ["Upside-down", [P,Z,Z,Z,P,P,Z,R,R,L,L,P,R,R,L,L,Z,P,P,Z,Z,Z,P,Z]],
  ["Valley", [Z,R,P,L,P,R,P,R,L,R,Z,P,Z,L,R,L,P,L,P,R,P,L,Z,Z]],
  ["Viaduct", [P,R,P,L,P,Z,Z,P,R,Z,R,R,Z,R,P,Z,Z,P,L,P,R,P,Z,Z]],
  ["View", [Z,R,P,L,P,R,Z,Z,R,P,L,L,R,R,P,L,Z,Z,L,P,R,P,L,Z]],
  ["Waterfall", [L,Z,R,P,L,Z,R,P,L,Z,R,P,L,Z,R,P,L,Z,R,P,L,Z,R,Z]],
  ["windwheel", [P,R,R,P,Z,L,P,R,R,P,Z,L,P,R,R,P,Z,L,P,R,R,P,Z,Z]],
  ["Window", [P,Z,P,P,Z,Z,P,Z,P,Z,P,Z,Z,P,Z,P,Z,P,P,Z,Z,Z,Z,Z]],
  ["WindowToTheWorld", [P,L,Z,P,Z,Z,P,Z,Z,P,Z,R,P,L,Z,P,Z,Z,P,Z,Z,P,Z,Z]],
  ["Windshield", [P,P,Z,R,P,L,L,P,R,Z,P,Z,L,P,R,R,P,L,Z,P,P,Z,P,Z]],
  ["WingNut", [Z,Z,Z,Z,P,R,R,R,P,R,L,P,L,R,P,R,R,R,P,Z,Z,Z,Z,Z]],
  ["Wings2", [R,Z,P,Z,L,P,R,P,R,L,R,R,L,L,R,L,P,L,P,R,Z,P,Z,Z]],
  ["WithoutName", [P,R,P,R,R,P,L,L,P,Z,P,R,P,L,P,Z,P,R,R,P,L,L,P,Z]],
  ["Wolf", [Z,Z,P,P,Z,P,Z,Z,P,Z,P,P,Z,P,Z,Z,Z,P,P,Z,Z,Z,P,Z]],
  ["X", [L,Z,Z,P,L,R,R,P,L,R,Z,P,P,Z,L,R,P,L,L,R,P,Z,Z,Z]],
];
const MODELS = MODEL_ROWS.map(([name, node]) => ({ name, node }));

// ---- colour schemes (glsnake.c colour[][2][4], RGBA) ----
const COLOUR_CYCLIC = 0, COLOUR_ACYCLIC = 1, COLOUR_INVALID = 2, COLOUR_AUTHENTIC = 3;
const COLOURS = [
  [[0.4, 0.8, 0.2, 0.6], [1.0, 1.0, 1.0, 0.6]],          // cyclic - green
  [[0.3, 0.1, 0.9, 0.6], [1.0, 1.0, 1.0, 0.6]],          // acyclic - blue
  [[0.3, 0.1, 0.9, 0.6], [1.0, 1.0, 1.0, 0.6]],          // invalid - grey (== blue)
  [[0.38, 0.0, 0.55, 0.7], [0.0, 0.5, 0.34, 0.7]],       // authentic - purple/green
  [[171 / 255, 0, 1.0, 1.0], [46 / 255, 205 / 255, 227 / 255, 1.0]],  // old logo
];
const ALTCOLOUR = false;   // DEF_ALTCOLOUR "False"; no xml UI, so fixed off.

// ---- the triangular prism (solid_prism_v / solid_prism_n), verbatim ----
const VOFFSET = 0.045;
const SQ = Math.SQRT1_2;   // M_SQRT1_2
const PRISM_V = [
  [VOFFSET, VOFFSET, 1.0],
  [VOFFSET, 0.0, 1.0 - VOFFSET],
  [0.0, VOFFSET, 1.0 - VOFFSET],
  [VOFFSET, VOFFSET, 0.0],
  [VOFFSET, 0.0, VOFFSET],
  [0.0, VOFFSET, VOFFSET],
  [1.0 - VOFFSET / SQ, VOFFSET, 1.0],
  [1.0 - VOFFSET / SQ, 0.0, 1.0 - VOFFSET],
  [1.0 - VOFFSET * SQ, VOFFSET, 1.0 - VOFFSET],
  [1.0 - VOFFSET / SQ, VOFFSET, 0.0],
  [1.0 - VOFFSET / SQ, 0.0, VOFFSET],
  [1.0 - VOFFSET * SQ, VOFFSET, VOFFSET],
  [VOFFSET, 1.0 - VOFFSET / SQ, 1.0],
  [VOFFSET / SQ, 1.0 - VOFFSET * SQ, 1.0 - VOFFSET],
  [0.0, 1.0 - VOFFSET / SQ, 1.0 - VOFFSET],
  [VOFFSET, 1.0 - VOFFSET / SQ, 0.0],
  [VOFFSET / SQ, 1.0 - VOFFSET * SQ, VOFFSET],
  [0.0, 1.0 - VOFFSET / SQ, VOFFSET],
];
const PRISM_N = [
  [-VOFFSET, -VOFFSET, VOFFSET],   // 0..5 corners
  [VOFFSET, -VOFFSET, VOFFSET],
  [-VOFFSET, VOFFSET, VOFFSET],
  [-VOFFSET, -VOFFSET, -VOFFSET],
  [VOFFSET, -VOFFSET, -VOFFSET],
  [-VOFFSET, VOFFSET, -VOFFSET],
  [-VOFFSET, 0.0, VOFFSET],        // 6..14 edges
  [0.0, -VOFFSET, VOFFSET],
  [VOFFSET, VOFFSET, VOFFSET],
  [-VOFFSET, 0.0, -VOFFSET],
  [0.0, -VOFFSET, -VOFFSET],
  [VOFFSET, VOFFSET, -VOFFSET],
  [-VOFFSET, -VOFFSET, 0.0],
  [VOFFSET, -VOFFSET, 0.0],
  [-VOFFSET, VOFFSET, 0.0],
  [0.0, 0.0, 1.0],                 // 15..19 faces
  [0.0, -1.0, 0.0],
  [SQ, SQ, 0.0],
  [-1.0, 0.0, 0.0],
  [0.0, 0.0, -1.0],
];
// display-list faces: [normalIndex, ...vertexIndices]. Triangles (3 verts) and
// quads (4 verts, split a,b,c / a,c,d), transcribed from glsnake_init.
const PRISM_TRIS = [
  [0, 0, 2, 1], [1, 6, 7, 8], [2, 12, 13, 14], [3, 3, 4, 5],
  [4, 9, 11, 10], [5, 16, 15, 17], [15, 0, 6, 12], [19, 3, 15, 9],
];
const PRISM_QUADS = [
  [6, 0, 12, 14, 2], [7, 0, 1, 7, 6], [8, 6, 8, 13, 12], [9, 3, 5, 17, 15],
  [10, 3, 9, 10, 4], [11, 15, 16, 11, 9], [12, 1, 2, 5, 4], [13, 8, 7, 10, 11],
  [14, 13, 16, 17, 14], [16, 1, 4, 10, 7], [17, 8, 11, 16, 13], [18, 2, 14, 17, 5],
];

const DEG = Math.PI / 180;
const X_MASK = 1, Y_MASK = 2, Z_MASK = 4;

export function start(hostCanvas, opts = {}) {
  // us; the GL family's shared overhead default (see glsnake.md -- glsnake's motion
  // is wall-clock-based like the .c, so this cancels out; kept for family
  // consistency + the host framerate readout).
  const OVERHEAD = 37500;

  // Knobs transcribed 1:1 from hacks/glsnake.xml. `duration` is statictime (ms),
  // `packing` is explode. `angvel`/`yangvel`/`zangvel` are per-second turn rates.
  const config = {
    delay: 30000,      // us (xml default; invert slider)
    duration: 5000,    // statictime, ms (xml --statictime)
    packing: 0.03,     // explode (xml --explode)
    angvel: 1.0,       // morph angular velocity (xml --angvel)
    yangvel: 0.10,     // spin about Y (xml --yangvel)
    zangvel: 0.14,     // spin about Z (xml --zangvel)
    labels: false,     // show the shape name (xml --titles; def False)
    wire: false,       // wireframe (xml --wireframe)
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'duration', label: 'Duration', type: 'range', min: 1000, max: 30000, step: 500, default: 5000, unit: ' ms', lowLabel: '1', highLabel: '30 seconds', live: true },
    { key: 'packing', label: 'Packing', type: 'range', min: 0.0, max: 0.5, step: 0.01, default: 0.03, lowLabel: 'Tight', highLabel: 'Loose', live: true },
    { key: 'angvel', label: 'Angular velocity', type: 'range', min: 0.05, max: 5.0, step: 0.05, default: 1.0, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    { key: 'yangvel', label: 'Y angular velocity', type: 'range', min: 0.0, max: 1.0, step: 0.01, default: 0.10, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    { key: 'zangvel', label: 'Z angular velocity', type: 'range', min: 0.0, max: 1.0, step: 0.01, default: 0.14, lowLabel: 'Slow', highLabel: 'Fast', live: true },
    { key: 'labels', label: 'Show titles', type: 'checkbox', default: false, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);

  // ================= snake state (glsnake_cfg) =================
  const node = new Array(NODE_COUNT).fill(0);   // current joint angles (deg)
  let prevModel = 0, nextModel = 0;
  let prevColour = COLOUR_ACYCLIC, nextColour = COLOUR_ACYCLIC;
  let morphing = 0;
  const colour = [[0, 0, 0, 0], [0, 0, 0, 0]];  // interpolated bp->colour[2][4]
  let yspin = 60.0, zspin = -45.0;              // continuous rotation (deg)
  let lastMorphMs = 0;

  // ---- snake metrics (calc_snake_metrics) -> is_cyclic / is_legal for colour ----
  const grid = new Int8Array(25 * 25 * 25);
  const getScalar = (vec, mask) => (vec === mask ? 1 : vec === -mask ? -1 : 0);
  function crossProduct(s, d) {
    return X_MASK * (getScalar(s, Y_MASK) * getScalar(d, Z_MASK) - getScalar(s, Z_MASK) * getScalar(d, Y_MASK))
      + Y_MASK * (getScalar(s, Z_MASK) * getScalar(d, X_MASK) - getScalar(s, X_MASK) * getScalar(d, Z_MASK))
      + Z_MASK * (getScalar(s, X_MASK) * getScalar(d, Y_MASK) - getScalar(s, Y_MASK) * getScalar(d, X_MASK));
  }
  function calcSnakeMetrics(modelIndex) {
    grid.fill(0);
    let isLegal = 1;
    let prevSrcDir = -Y_MASK, prevDstDir = Z_MASK;
    let x = 12, y = 12, z = 12, srcDir, dstDir = 0;
    const nodes = MODELS[modelIndex].node;
    for (let i = 0; i < NODE_COUNT - 1; i++) {
      srcDir = -prevDstDir;
      x += getScalar(prevDstDir, X_MASK);
      y += getScalar(prevDstDir, Y_MASK);
      z += getScalar(prevDstDir, Z_MASK);
      const a = nodes[i] | 0;
      if (a === 0) dstDir = -prevSrcDir;                 // ZERO
      else if (a === 180) dstDir = prevSrcDir;           // PIN
      else if (a === 270 || a === 90) {                  // RIGHT | LEFT
        dstDir = crossProduct(prevSrcDir, prevDstDir);
        if (a === 270) dstDir = -dstDir;                 // RIGHT
      } else dstDir = 0;
      const gi = x * 625 + y * 25 + z;
      if (grid[gi] === 0) grid[gi] = srcDir + dstDir;
      else if (grid[gi] + srcDir + dstDir === 0) grid[gi] = 8;
      else isLegal = 0;
      prevSrcDir = srcDir; prevDstDir = dstDir;
    }
    const isCyclic = (dstDir === Y_MASK && x === 12 && y === 11 && z === 12) ? 1 : 0;
    return { isLegal, isCyclic };
  }

  // morph_percent(): how far node[] has travelled from prev_model to next_model.
  function morphPercent() {
    let rotMax = 0, angDiffMax = 0;
    const pn = MODELS[prevModel].node, nn = MODELS[nextModel].node;
    for (let i = 0; i < NODE_COUNT - 1; i++) {
      let rot = Math.abs(pn[i] - nn[i]);
      if (rot > 180.0) rot = 180.0 - rot;               // verbatim (yes, can go < 0)
      let angDiff = Math.abs(node[i] - nn[i]);
      if (angDiff > 180.0) angDiff = 180.0 - angDiff;
      if (rot > rotMax) rotMax = rot;
      if (angDiff > angDiffMax) angDiffMax = angDiff;
    }
    let retval = 1.0 - angDiffMax / rotMax;
    if (!Number.isFinite(retval)) retval = 1.0;          // isnan/isinf guard (rotMax==0)
    return retval;
  }

  function morphColour() {
    const pct = morphPercent();
    const comp = 1.0 - pct;
    const pc = COLOURS[prevColour], nc = COLOURS[nextColour];
    for (let k = 0; k < 2; k++)
      for (let c = 0; c < 4; c++)
        colour[k][c] = pc[k][c] * comp + nc[k][c] * pct;
  }

  function startMorph(modelIndex, immediate) {
    if (immediate) {
      for (let i = 0; i < NODE_COUNT; i++) node[i] = MODELS[modelIndex].node[i];
    }
    prevModel = nextModel;
    nextModel = modelIndex;
    prevColour = nextColour;
    const m = calcSnakeMetrics(nextModel);
    if (!m.isLegal) nextColour = COLOUR_INVALID;
    else if (ALTCOLOUR) nextColour = COLOUR_AUTHENTIC;
    else if (m.isCyclic) nextColour = COLOUR_CYCLIC;
    else nextColour = COLOUR_ACYCLIC;
    if (immediate) {
      for (let k = 0; k < 2; k++)
        for (let c = 0; c < 4; c++) colour[k][c] = COLOURS[nextColour][k][c];
    }
    morphing = 1;
    morphColour();
  }

  // ================= three.js scene =================
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  const parent = hostCanvas.parentNode || document.body;
  parent.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 1);
  // The .c blends the 24 translucent prisms in node order with depth writes ON and
  // NO back-to-front sort (glEnable(GL_BLEND) + GL_DEPTH_TEST, no depth sort). Turn
  // off three's transparency sort so nodes draw in insertion order 0..23, exactly
  // reproducing the original's order-dependent blend + self-occlusion.
  renderer.sortObjects = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // reshape_glsnake: gluPerspective(zoom=25, w/h, 1, 100); gluLookAt eye z=20.
  const camera = new THREE.PerspectiveCamera(25, 1, 1.0, 100.0);
  camera.position.set(0, 0, 20);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // Two white lights (light_pos[0]={0,10,20}, light_pos[1]={0,20,-1}; w=0 =>
  // directional) + GL's default global ambient 0.2. Intensity PI cancels three's
  // 1/PI Lambert (the sibling-port convention).
  const light0 = new THREE.DirectionalLight(0xffffff, Math.PI);
  light0.position.set(0, 10, 20);
  const light1 = new THREE.DirectionalLight(0xffffff, Math.PI);
  light1.position.set(0, 20, -1);
  scene.add(light0, light1);
  scene.add(new THREE.AmbientLight(0xffffff, 0.2 * Math.PI));

  // ---- prism geometry (shared by all 24 nodes) ----
  const pos = [], nor = [];
  const pushVert = (vi, n) => {
    const v = PRISM_V[vi];
    pos.push(v[0], v[1], v[2]);
    nor.push(n[0], n[1], n[2]);
  };
  for (const [ni, a, b, c] of PRISM_TRIS) {
    const raw = PRISM_N[ni];
    const len = Math.hypot(raw[0], raw[1], raw[2]) || 1;
    const n = [raw[0] / len, raw[1] / len, raw[2] / len];   // GL_NORMALIZE
    pushVert(a, n); pushVert(b, n); pushVert(c, n);
  }
  for (const [ni, a, b, c, d] of PRISM_QUADS) {
    const raw = PRISM_N[ni];
    const len = Math.hypot(raw[0], raw[1], raw[2]) || 1;
    const n = [raw[0] / len, raw[1] / len, raw[2] / len];
    pushVert(a, n); pushVert(b, n); pushVert(c, n);         // a,b,c
    pushVert(a, n); pushVert(c, n); pushVert(d, n);         // a,c,d
  }
  const prismGeom = new THREE.BufferGeometry();
  prismGeom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  prismGeom.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  prismGeom.computeBoundingSphere();

  // ---- materials: the two alternating snake colours (updated per frame) ----
  const mkMat = () => new THREE.MeshPhongMaterial({
    color: 0xffffff,
    specular: new THREE.Color().setRGB(0.1 / Math.PI, 0.1 / Math.PI, 0.1 / Math.PI, THREE.SRGBColorSpace),
    shininess: 20,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide,       // the .c leaves GL_CULL_FACE off
    depthWrite: true,             // ...but depth writes ON (faithful self-occlusion)
  });
  const matC0 = mkMat();   // colour[0]  (odd nodes)
  const matC1 = mkMat();   // colour[1]  (even nodes)

  // ---- modelview nesting (draw_glsnake pass 2):
  //   comGroup  : Translate(-com)          (recentre on the centre of mass)
  //   yGroup    : Rotate(yspin, Y)
  //   zGroup    : Rotate(zspin, Z)
  //   scaleGroup: Scale(portraitFit)
  //     node meshes (local matrix = the cumulative joint transform up to node i)
  const comGroup = new THREE.Group();
  const yGroup = new THREE.Group();
  const zGroup = new THREE.Group();
  const scaleGroup = new THREE.Group();
  comGroup.add(yGroup); yGroup.add(zGroup); zGroup.add(scaleGroup);
  scene.add(comGroup);

  const meshes = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    // node i uses colour[(i+1)%2]: even -> colour[1] (matC1), odd -> colour[0] (matC0)
    const mesh = new THREE.Mesh(prismGeom, (i % 2 === 0) ? matC1 : matC0);
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = i;         // insurance: keep node draw order under sortObjects=false
    scaleGroup.add(mesh);
    meshes.push(mesh);
  }

  // ---- HUD shape-name label (print_texture_label, position 1 = top-left, white).
  // labelfont = "sans-serif 18": use the browser's generic sans-serif (no fontUrl,
  // nothing bundled) -- the apollonian precedent.
  const hud = makeHudLabel(parent, { family: 'sans-serif', color: 'rgb(255,255,255)', corner: 'tl' });
  let builtLabels = false;
  function updateLabel() {
    hud.setText(config.labels ? MODELS[nextModel].name : '');
    builtLabels = config.labels;
  }

  // ---- per-node cumulative transforms + centre of mass ----
  const nodeLocal = [];
  for (let i = 0; i < NODE_COUNT; i++) nodeLocal.push(new THREE.Matrix4());
  const _X = new THREE.Matrix4();
  const _t = new THREE.Matrix4();
  const _acc = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _sum = new THREE.Vector3();
  const _baseMat = new THREE.Matrix4();
  const _comVec = new THREE.Vector3();

  // X(ang): the per-joint chain
  //   T(.5,.5,.5) . Rz(-90) . T(1+explode,0,0) . Rx(180+ang) . T(-.5,-.5,-.5)
  // (glRotatef(90,0,0,-1) == Rz(-90deg); glRotatef(180+ang,1,0,0) == Rx(180+ang)).
  function nodeX(ang, explode, out) {
    out.makeTranslation(0.5, 0.5, 0.5);
    out.multiply(_t.makeRotationZ(-Math.PI / 2));
    out.multiply(_t.makeTranslation(1.0 + explode, 0, 0));
    out.multiply(_t.makeRotationX((180.0 + ang) * DEG));
    out.multiply(_t.makeTranslation(-0.5, -0.5, -0.5));
    return out;
  }

  function computeTransforms() {
    const explode = config.packing;
    _acc.identity();
    _sum.set(0, 0, 0);
    for (let i = 0; i < NODE_COUNT; i++) {
      nodeLocal[i].copy(_acc);            // draw matrix for node i = product up to i-1
      nodeX(node[i], explode, _X);
      _acc.multiply(_X);                  // now _acc = product up to i
      _p.set(0.5, 0.5, 0.5).applyMatrix4(_acc);   // centre point after joint i (pass-1 grab)
      _sum.add(_p);
      meshes[i].matrix.copy(nodeLocal[i]);
      meshes[i].matrixWorldNeedsUpdate = true;
    }
    _sum.multiplyScalar(1 / NODE_COUNT);
    // com = (Ry(yspin) . Rz(zspin)) . mean(points)  (pass 1 has no com/scale term)
    _baseMat.makeRotationY(yspin * DEG);
    _baseMat.multiply(_t.makeRotationZ(zspin * DEG));
    _comVec.copy(_sum).applyMatrix4(_baseMat);
  }

  // ================= init (init_glsnake) =================
  prevColour = nextColour = COLOUR_ACYCLIC;
  nextModel = rng.RAND(MODELS.length);          // first RNG draw (becomes prev_model)
  prevModel = START_MODEL;
  startMorph(prevModel, 1);                      // immediate: open on START_MODEL ("snow")
  updateLabel();

  // ---- sizing (reshape + the portrait-fit scale) ----
  let portraitFit = 1;
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    portraitFit = w < h ? w / h : 1;            // draw_glsnake's glScalef(s,s,s)
    hud.resize();
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ================= render loop =================
  const fmod360 = (x) => ((x % 360) + 360) % 360;   // fmod for the (positive) morph args
  let raf = 0, lastT = 0, paused = false, ms = 16;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!lastT) { lastT = now; lastMorphMs = now; return; }
    const frame = now - lastT;
    lastT = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;
    // PACING. glsnake's motion is wall-clock-based in the .c (yspin/zspin/morph all
    // scale with iter_msec, the real ms since the last iteration), so effFps cancels:
    // advancing `frames = dt*effFps` original-frames by the per-frame turn
    // 360*ang/effFps yields 360*ang*dt -- the .c's exact wall-clock rate, independent
    // of `delay` (delay is only frame cadence, as in the .c). statictime runs off `now`.
    const dt = Math.min(frame / 1000, 0.25);     // seconds, clamped for tab-switches
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;

    // live label toggle
    if (config.labels !== builtLabels) updateLabel();

    // ---- glsnake_idle ----
    // model switch: after statictime with no morph in progress, morph to a random model.
    if (!morphing && (now - lastMorphMs) > config.duration) {
      lastMorphMs = now;
      startMorph(rng.RAND(MODELS.length), 0);
      updateLabel();
    }
    // continuous rotation (the .c: yspin += 360 * yangvel * iter_msec / 1000)
    yspin += frames * 360 * config.yangvel / effFps;
    zspin += frames * 360 * config.zangvel / effFps;
    // morph the joints toward next_model (max turn this rAF; == 90*angvel*iter_msec/1000)
    const iterAngleMax = frames * 90 * config.angvel / effFps;
    let stillMorphing = 0;
    const dest = MODELS[nextModel].node;
    for (let i = 0; i < NODE_COUNT; i++) {
      const cur = node[i], d = dest[i];
      if (cur !== d) {
        stillMorphing = 1;
        if (Math.abs(cur - d) <= iterAngleMax) node[i] = d;
        else if (fmod360(cur - d + 360) > 180) node[i] = fmod360(cur + iterAngleMax);
        else node[i] = fmod360(cur + 360 - iterAngleMax);
      }
    }
    if (!stillMorphing) morphing = 0;
    morphColour();

    // ---- draw ----
    matC0.color.setRGB(colour[0][0], colour[0][1], colour[0][2], THREE.SRGBColorSpace);
    matC0.opacity = colour[0][3];
    matC1.color.setRGB(colour[1][0], colour[1][1], colour[1][2], THREE.SRGBColorSpace);
    matC1.opacity = colour[1][3];
    matC0.wireframe = matC1.wireframe = config.wire;

    computeTransforms();
    comGroup.position.set(-_comVec.x, -_comVec.y, -_comVec.z);
    yGroup.rotation.y = yspin * DEG;
    zGroup.rotation.z = zspin * DEG;
    scaleGroup.scale.setScalar(portraitFit);

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      prismGeom.dispose();
      matC0.dispose();
      matC1.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
      hud.dispose();
    },
    pause() { paused = true; },
    resume() { lastT = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() {                                   // host 're-seed': jump to a fresh shape
      startMorph(rng.RAND(MODELS.length), 1);
      lastMorphMs = lastT;
      updateLabel();
    },
    config,
    params,
  };
}

export default { title, info, start };
