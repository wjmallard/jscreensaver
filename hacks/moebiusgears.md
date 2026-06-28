# moebiusgears -- design notes

Web port of xscreensaver's `moebiusgears` (Jamie Zawinski, 2007),
`xscreensaver-6.15/hacks/glx/moebiusgears.c`. An odd number of identical involute
gears arranged around a ring and twisted a half-turn over the full loop, so the band
of gears traces a Möbius strip; adjacent gears are offset half a tooth and
counter-rotate, so the whole interlinked loop meshes and turns. The ring tumbles,
wanders, and optionally "rolls". Self-contained three.js module: `start(canvas,
opts) -> { stop, pause, resume, getStats, reinit, config, params }`. **Asset-free.**

## Shares the gear geometry with gears.js

The gear bodies are built by the shared **`hacks/involute.js`** (a faithful port of
xscreensaver's `hacks/glx/involute.c`). This mirrors upstream exactly: `involute.c`
is a shared library that `gears`, `moebiusgears`, `geodesicgears` and `pinion` all
`#include` and call `draw_involute_gear()` from. So `moebiusgears.js` and `gears.js`
both `import { buildGearGeometry } from './involute.js'` -- the same way the C hacks
share `involute.c` (and the same way the project shares `rotator.js`/`yarandom.js`).
The DoubleSide / vertex-color-diffuse / color-management choices live there and in
`gears.md`; this module adds only the Möbius layout + motion.

## Faithfulness (the rule: do NOT deviate from the algorithm)

Transcribed from `moebiusgears.c`:

- **`reset_mgears`:** `count` forced ODD and `>= 13` (even => gears intersect; fewer
  => the mesh angle is too steep); `teeth` forced ODD and `>= 7` (even => teeth don't
  mesh when the loop closes, and they must match count's parity); `ring_r = 3`,
  `gear_r = pi*ring_r / (count/2)`, `tooth_h = gear_r*2.5/teeth`; the `gear_r` ->
  mesh-detail bucket (+ knock-down for many teeth); nubs `(random()&3)?0:(random()%teeth)/2`;
  all gears identical with `inner_r/inner_r2/inner_r3 = r*{0.8,0.6,0.55}`, `thickness2 =
  thickness*0.1`.
- **The Möbius layout:** gear `i` is placed by `Rz(pos_th)` at `pos_th =
  (2pi/gpt)*i`, out to `ring_r`, then `Ry(pos_thz)` at `pos_thz = (pi/2/gpt)*i`. Over
  the whole loop `pos_thz` accumulates to **pi (a half-twist)** = the Möbius strip.
  Initial `th` offset half a tooth on odd-index gears, and counter-rotation per index
  (`dir = i&1 ? +1 : -1`), so neighbors mesh.
- **`draw_mgears` modelview:** `Scale(1.1)` -> position (rotator) -> rotation (with the
  fixed `x-=0.14, y-=0.06` tilt) -> `Scale(1.5)` -> per-gear. The optional **roll**
  spins every gear about its local Y by a shared accumulating angle
  (`roll_th += speed*0.0005`).
- **Spin:** `th += speed*(pi/100)*dir` per original-frame (th is in RADIANS here,
  unlike gears.c's degrees). Color `0.7+frand(0.3)` (lighter pastels than gears'
  `0.5+frand(0.5)`); `color2 = color*0.85`.
- **Rotator:** `make_rotator(0.5,0.5,0.5, accel 2.0, wander 0.01, randomize FALSE)` --
  note **no initial randomization**, so it starts at the fixed tilt and tumbles slowly
  from there (the ground-truth screenshot is one tumble phase; the port passes through
  it too).
- **Lighting:** one white directional light from `(1,1,1)`, ambient 0, material
  specular = the light's cyan `{0,1,1}`, shininess 128.

Verified by CDP capture against `XScreenSaver_ Screenshots_files/moebiusgears.jpg`:
the ring of meshing gears, the Möbius half-twist, the light pastels, the nested-ring
gear bodies, ambient-0 lighting + cyan rim specular all reproduce.

## Pacing / config

Pacing as in `gears.js` / `dangerball` (render every rAF; `effFps =
1e6/(delay+OVERHEAD)`, `OVERHEAD = 37500`; spin + roll continuous, rotator ticked
once per original-frame and interpolated). Config transcribed 1:1 from
`hacks/config/moebiusgears.xml`: `delay` (0-100000, def 30000, invert) - `speed`
(0.01-5.0, def 1.0) - `count` (13-99, def 17) - `teeth` (7-49, def 15) - `wander` -
`spin` - `roll` - `wire`. `count`/`teeth` rebuild the ring (not live); the rest live.

See also: `gears.md`, `involute.js`; the `glx-geometry-track-triage` +
`framerate-calibration` memories.
