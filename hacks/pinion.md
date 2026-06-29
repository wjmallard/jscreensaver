# pinion -- design notes

Web port of xscreensaver's `pinion` (Jamie Zawinski, 2004),
`xscreensaver-6.15/hacks/glx/pinion.c`. A self-building gear train marches across the
screen: gears are laid out in an off-screen zone on the right, scroll left into view,
mesh with their neighbors, and are deleted off the left edge. Trains hit dead ends and
reset; bound "coaxial" pairs share an axle on different depth planes; gears too fast to
draw cleanly motion-blur and wobble; deeper gears are darker. Self-contained three.js:
`start(canvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }`.
**Asset-free** (see "Omitted" below re: fonts).

## Shares the gear geometry with gears.js / moebiusgears.js

Gear bodies are the shared **`hacks/involute.js`** (faithful port of involute.c) -- the
same shared library pinion.c uses via `draw_involute_gear()`. Pinion is the hack that
exercises involute.c's **coaxial axle-tube** path (`coax_p == 1`), which was added to
`involute.js` for it (inert for gears/moebiusgears, which never set `coax_p`). `wobble`
is applied at the mesh level (`draw_involute_gear` wraps the gear in `glRotatef(wobble,
1,0,0)` -- equivalent to an Rx on the mesh).

## Faithfulness (the rule: do NOT deviate from the algorithm)

Transcribed from `pinion.c`:

- **new_gear:** tooth size `0.007/0.005 * (1+BELLRAND(4))*gear_size`; nteeth 3-100 (small
  counts rare); the four interior shapes; coaxial gears pick a radius much larger/smaller
  than parent and share the smaller axle hole (modifying parent); spokes/nubs; the
  pixel-size -> mesh-detail bucket.
- **place_gear:** the too-big rejection, the velocity ratio (coaxial gears inherit
  parent's ratio/th/rpm/wobble), the half-tooth offset for odd tooth counts, coaxial
  placement (same x/y, z +/- plane_displacement, top/bottom marking) vs adjacent
  (angle mostly -120..120, the th mesh-alignment), the already-visible + collision
  rejections, compute_rpm, depth-darkening (`brightness = 1 + z/disp/6`, clamped), and
  motion-blur + wobble for too-fast gears.
- **push_gear:** try-coaxial (1/40) -> regular -> coaxial-fallback -> new-train; the
  ludicrous-speed unhook (parent rpm > max_rpm), the blurpocalypse bail (10 blurred in a
  row), the growth-zone reset.
- **scroll_gears** (`x -= scroll*0.002`/frame; delete off-screen-left; push to fill the
  layout zone) + **spin_gears** (`th += ratio*spin`/frame, sign preserved) + **ffwd**
  (pre-fill so the screen isn't blank at start).
- **draw:** per-gear `T(x,y,z) Rz(th) Rx(wobble)`; the scene `Scale(16*1.2)`, tilt
  `-35 X / 8 Y`, pan; projection `gluPerspective(30)`; ONE **white**-specular light
  from `(-3,1,1)`, plus a `0.2*color` ambient floor (GL's DEFAULT light-model ambient
  0.2 x involute.c's `AMBIENT_AND_DIFFUSE`=color), as `THREE.AmbientLight(white,
  0.2*PI)`. [Added 2026-06-28: I'd used ambient 0, which with pinion's grazing light
  left the gears too dark.]

Verified by CDP capture (incl. a 4x zoom to confirm tooth geometry) -- the meandering
meshing train, coax pairs, depth-darkening, the up-to-99-tooth range (many-tooth gears
read as fine/smooth-rimmed at full-screen scale, few-tooth gears chunky, tiny gears as
zigzag crowns under the tilt), and motion-blur all reproduce. RNG = the shared
yarandom.js.

## Omitted (interaction/debug chrome -- not screensaver visuals)

- **The mouse-hover stats label** (a corner HUD showing the moused-over gear's
  teeth/RPM). It is the only `texfont` use, hence the only reason pinion lists fonts.
  There is no mouse in a screensaver (the .c falls back to gears[1]'s stats), and it is
  absent from the ground-truth screenshot, so no `hacks/fonts` were needed.
- The trackball, GL-select mouse picking, the `-debug` overlays, device rotation.
- Off-screen gears: the .c draws a cheap line "schematic"; we simply don't draw them
  (they're out of frame). Wireframe uses three's `material.wireframe`.

## Pacing / config

Pacing model as in gears.js / dangerball (`effFps = 1e6/(delay+OVERHEAD)`, `OVERHEAD =
37500`, continuous scroll/spin). Motion-blur advances the strobe counter by `frames`
continuously (the half-tooth-per-frame strobe is somewhat smoothed at high render rates).
Config transcribed 1:1 from `hacks/config/pinion.xml`: `delay` (0-100000, def **15000**),
`spin` (0.1-7, def 1.0), `scroll` (0.1-8, def 1.0), `size` (0.1-3, def 1.0; rebuilds),
`maxRpm` (100-2000, def 900), `wire`.

OPEN: the train fills the screen slowly (~40s to cross at the default scroll + the shared
pacing). Faithful to `scroll*0.002`/frame, but if the demo video (youtube `rHY8dR1urQk`)
reads faster, bump the default scroll or lower OVERHEAD for pinion.

See also: `gears.md`, `moebiusgears.md`, `involute.js`.
