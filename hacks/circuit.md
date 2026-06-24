# circuit -- design notes

Web port of xscreensaver's `circuit` (Ben Buxton, 2001), `xscreensaver-6.15/hacks/glx/circuit.c`
(vendored here as `hacks/circuit.c` + `hacks/circuit.xml`). "Electronic components float
around": a stream of random electronic parts drifts in from the edges, tumbles across a
green grid, and exits, up to `parts` on screen at once. Self-contained three.js module:
`start(canvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }`.

## Algorithm (how the .c works)

- **The stream** (`display` / `NewComponent`): every frame there is a 5% chance to fill one
  free slot with a `NewComponent`. Each spawns at a random point on one of the four edges
  (top/bottom/left/right) with a matching inward drift `(dx,dy)` in `[0.5,2]`, a depth
  `z in [-9,-2]`, a random tumble axis `(rotx,roty,rotz)` + speed `drot = f_rand()*3`, an
  initial angle, and a type = `random()%11`. Each frame a part advances `x += dx*MOVE_MULT`,
  `y += dy*MOVE_MULT` (`MOVE_MULT = 0.02`) and, if `spin`, `rdeg += drot`; when it leaves the
  `XMAX x YMAX` box (`XMAX = 50`, `YMAX = XMAX*winH/winW`) it is freed.
- **The 11 component types**, each built from primitives (`createCylinder`, `circle`,
  `sphere`, `Rect`, `ICLeg`, `HoledRectangle`, `wire`) in a `Draw*`/`New*` pair:
  resistor (tan body + 4 colour-code bands + leads), diode (banded cylinder + white band),
  transistor (TO-220 / TO-92 / surface-mount, each with a printed part number), LED (dome +
  body + flange; one lucky LED becomes a coloured light source), capacitor (blue
  electrolytic can, or brown ceramic blob), IC (DIP body + two rows of pins + a printed
  label + pin-1 dimple), 7-segment display (body + lit red segments for a random digit +
  pins), fuse (metal caps + translucent glass), RCA plug, 3.5mm plug, slide switch.
- **The resistor colour-band code** (`NewResistor`): `v=RAND(9)`, `m=RAND(5)`,
  `t=(RAND(10)<5)?10:11`; bands `= values[v][0], values[v][1], m, t` indexing the
  `colorcodes[12][3]` table (black..white, gold, silver). `DrawResistor` lays the 4 bands
  0.35 apart along the 1.8-long body, each a short fat cylinder (`createCylinder(0.1,0.42,0,0)`).
- **View / motion** (`display` / `reshape`): `gluLookAt` at `(0,0,14)`; a slow whole-scene
  z-rotation (`0.01 * rotate-speed` deg/frame); `glFrustum(-1,1,-h,h,1.5,35)` with
  `h = winH/winW`; a portrait-fit `glScalef`. One positional light at `(7,7,15)`, diffuse +
  specular `0.8` gray, over GL's default `0.2` global ambient.
- **Grid** (`drawgrid`): green lines at `z=-10` spanning the box, plus an occasional roving
  bright-green spot that streaks across (its start chance is higher when the scene spins).

## Shared libraries used

`yarandom.js` only (RNG, bit-faithful; the `NewComponent` draw ORDER -- angle, side, drift,
z, tumble, type, then the per-type `New*` -- is reproduced). `circuit` uses NO colormap
(all colours are fixed material tables), so `colormap.js` is not imported, and it uses its
own per-component tumble rather than `rotator.js`.

## 3D text decals (inline; NOT the shared HUD helper)

The labels ride ON the parts (IC top face, transistor faces), so they are scene geometry,
not a screen-space caption -- `hud-label.js` is the wrong tool. Each label string is rendered
to a 2D `<canvas>` (bold monospace via a vendored `fonts/luximr.ttf` `FontFace`, the .c's
"componentFont: monospace bold 12"; light-gray glyphs `rgb(179,179,179)` = the .c's texfg
`{0.7,0.7,0.7}`, on a transparent background; multi-line strings split on `\n`; the widest
line auto-fit to the canvas) -> a `THREE.CanvasTexture` -> a transparent `MeshBasicMaterial`
plane. The plane is placed with the SAME transform the .c uses for `print_texture_string`:
the IC label sits on the top face (`z=+0.1`) rotated 90deg about Z so it reads along the
long axis (verified legible -- e.g. `ISD1416P` on a 24-pin DIP); the TO-220 label is
centered on the front face; TO-92 on the flat face after its `rotate(90,1,0,0)`; the SMC
label on its body (the .c leaves that quad's texture unset -- a latent bug -- so we draw the
`smctypes` string there, which is what it was meant to show). The decal tumbles with the part
(it is a child of the component group).

## Faithful to the .c (do not deviate)

- Every geometry primitive ported vertex-for-vertex: `createCylinder` (window-dependent
  `nsegs`, the `374`-degree wrap for closure, the `half` arc + flat bottom, the end-cap fans),
  `circle`, `sphere` (X-axis pole; the integer-truncated stack/slice bounds preserved),
  `Rect` (six faces, the .c's exact normals), `ICLeg`, `HoledRectangle` (the `tan_table`
  hole), `wire`, and the banded-cylinder/band code.
- Every `Draw*`/`New*` routine and its colour/material constants: the `colorcodes`/`values`
  resistor tables, the diode body colours + white band, the three transistor packages and
  their `transistortypes[]`/`to92types[]`/`smctypes[]` tables, the IC pin counts +
  `ictypes[]` + `"VAL\nYYWW"` date code + pin dimple, the two capacitor styles, the LED
  colour set + "one lucky LED is the light" claim, the 7-seg segment tables + digit map +
  pins, the fuse/RCA/3.5mm/switch geometry.
- Lighting: one positional light at `(7,7,15)` (no distance attenuation -- the .c's
  `glLighti(LINEAR, 0.5)` truncates to int 0 -> decay 0), diffuse+specular 0.8; GL's default
  0.2 global ambient (materials are `GL_AMBIENT_AND_DIFFUSE` = colour, so the ambient floor is
  `0.2*colour`). Per the engine/glknots convention: `intensity = 0.8*PI` cancels three's
  `1/PI` Lambert; specular is divided by PI; `THREE.ColorManagement.enabled = false` for raw
  glColor. `DoubleSide` (the .c never enables face culling).
- The frustum (`glFrustum(-1,1,-h,h,1.5,35)` -> a symmetric `PerspectiveCamera` with
  `fov = 2*atan(h/1.5)`, aspect `winW/winH`), the viewer at `(0,0,14)`, the slow scene spin,
  the portrait-fit scale, and the per-frame drift + tumble.
- The green grid + roving spot (grid colours `{0,0.25,0.05}` / `{0,0.125,0.05}`, spot green
  `{0,0.8,0}`, the four-direction traversal, the spin-dependent start chance).

## Deviations / deliberate choices

- **Pre-populated start.** The .c starts EMPTY and drifts parts in from the edges; at the
  drift rate that takes ~a minute to fill the view. The web host is browsed by sampling
  hacks briefly, so an empty-for-a-minute start reads as broken. `initialFill()` seeds
  `count` parts at once, each advanced a random fraction of its own time-to-exit so they
  scatter ALONG their trajectories (the steady state the original reaches after running a
  while). Parts still drift, exit, and respawn on the normal 5%/frame path afterward. This
  is the one behavioural change from the .c.
  - **Bugfix (coordinator, 2026-06-30):** `initialFill()` created each seeded part via
    `makeComponent()` (which adds the mesh to the scene + returns it) but forgot to
    `components.push(c)` the way the spawn path does. Untracked parts were never visited by
    the move loop, so their group `position` stayed at the default `(0,0,0)` -- they rendered
    as a stationary pile at dead-center, and `reinit()` (which only disposes `components[]`)
    couldn't clear them, so every reset stacked more. Fixed by pushing each seeded part (and
    setting its `group.position` for frame 0). User-reported; verified parts now scatter + drift.
- **Render `flat` mode = unlit full colour.** The xml's `--no-light` / "Flat coloring"
  option. In circuit.c v1.4 `uselight==0` only sets `ci->light=1` (which blocks the LED
  light source) and does NOT actually disable directional shading -- an apparent vestige at
  odds with the xml label. We implement the xml's stated intent: flat mode switches the point
  light off and raises the ambient light to full (`PI`), so parts render at flat unlit colour,
  and it also blocks LED light claims (matching `uselight==0 -> ci->light=1`). Lit mode is the
  faithful directional-lighting default.
- **LED light source = a coloured point light (not the .c's spotlight).** The "one lucky LED"
  is reproduced (claimed at creation when no light is active, released when it exits), and its
  dome renders emissive (glowing) while lit; the scene illumination is a coloured `PointLight`
  at the LED's position rather than the .c's `GL_LIGHT1` spotlight (cutoff 90, exponent 20).
  A point light conveys the same "one LED glows and lights nearby parts" read without the
  fiddly moving-spotlight target management. The mid-life random on/off toggle
  (`random()%50==25`) is not ported -- an LED keeps its lit state for its lifetime (a subtle
  flicker, dropped).
- **7-seg digit is fixed at spawn.** The .c re-rolls the displayed digit ~1/30 frames (a live
  counter flicker); we build the segments once with the initial value (rebuilding the mesh per
  flicker wasn't worth it). Minor.
- **One mesh per material bucket, geometry baked once.** Each `Draw*` is transcribed into a
  matrix-stack builder that reproduces the immediate-mode `glTranslatef/glRotatef/glPushMatrix`
  nesting and emits transformed vertices+normals; a `glMaterialfv` call flushes the current
  triangle bucket into its own `BufferGeometry`+material. The whole part is built once at spawn
  (not per frame) and animated via its group transform -- cheap, since only ~1 part spawns
  every few seconds.
- **Transparency:** the .c's `reorder()` (opaque-before-transparent) is replaced by three's
  built-in transparent-object depth sort (translucent LED/fuse-glass parts get `renderOrder`
  and `depthWrite:false`). Minor blend-order artifacts on overlapping translucent parts are
  possible but not distracting. The LED's inverted `glBlendFunc(GL_ONE_MINUS_SRC_ALPHA,
  GL_SRC_ALPHA)` is approximated by ordinary alpha at opacity 0.6.
- **`seven` debug flag omitted** (the `-seven` "all sevens" easter egg is a command-line
  debug mode with no xml UI).

## Pacing / OVERHEAD

`effFps = 1e6/(config.delay + OVERHEAD)`; render every rAF. Continuous motion (drift, tumble,
scene spin, roving-spot travel) advances by `frames = dt*effFps`; discrete per-frame events
(the 5% spawn roll, the roving-spot start roll) run in a catch-up loop ticked at `effFps`
(capped at 8, the engine.js pattern). **`OVERHEAD = 37500`** -- the GL family's shared default
(live GL is unmeasurable under this machine's XQuartz Apple-DRI block). xml default delay
20000 -> `effFps = 1e6/57500 ~= 17.4fps`. See framerate-calibration. (This is ~3x slower than
the original's ~50fps, so drift is slow -- another reason the `initialFill` seed matters.)

## Config (params transcribed 1:1 from hacks/circuit.xml)

`delay` (Frame rate, 0-100000, def 20000, invert) - `count` (Parts, 1-30, def 10) - `speed`
(Rotation speed, 0-100, def 1) - `spin` (checkbox, def true) - `render` (select: Flat coloring
/ Directional lighting, def light). `showfps` skipped (the host has its own readout).

## Omissions

- **Trackball / mouse** (`gltrackball_*`): the host overlay is `pointer-events:none`; the
  modelview omits the identity trackball term.
- **`do_fps` / `showfps`, `-seven`**: framework / debug, per above.
- **HAVE_MOBILE device-rotation scale branch**: desktop path only.

## Structural / correctness self-review

Verified headless (CDP `chrome-headless-shell`, `--use-angle=swiftshader`) against the bundled
`XScreenSaver_ Screenshots_files/circuit.jpg` and demo video (youtube tfqR1j1OQs8), mounting the
module on a throwaway harness (removed; not committed), across ~12 seeds:

- **Grid + background** match the reference (green grid on black, correct spacing/colour).
- **Component types confirmed rendering faithfully**: resistor (tan body + colour bands + long
  gray leads), IC (dark DIP + pins + a legible vertical top-face label, e.g. `ISD1416P`),
  electrolytic capacitor (shaded blue can + white/black end discs + leads), ceramic capacitor,
  LEDs (incl. the glowing red/yellow light-source LED with its dome), diode (dark body + band),
  7-segment display (dark body + bright-red segment digit + pins), 3.5mm plug (cream/gray
  segmented body + tip), TO-220 transistor (dark package + mounting tab + 3 legs).
- **3D label decal** legible and correctly oriented on the IC top face (reads along the long
  axis); transistor labels use the identical `makeDecalMesh` pipeline with per-package
  placement matrices.
- **Both render modes**: lit (directional shading, specular highlights) and flat (uniform unlit
  colour, point light off) both verified.
- Component apparent SIZE follows the faithful frustum (viewer z=14, `glFrustum` right=1, so
  horizontal FOV is fixed); the reference JPG is a closer framing, not a different scale.

See also `engine.md` (same author, 2001; the primitive-from-Rect/cylinder builder, the
firing/coloured-light pattern, and the pacing/interpolation convention are shared) and
`glknots.md` (the module contract, `OVERHEAD`, and colour/specular `/PI` convention).
