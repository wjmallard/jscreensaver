# geodesicgears -- design notes

Web port of xscreensaver's `geodesicgears` (Jamie Zawinski, 2014),
`xscreensaver-6.15/hacks/glx/geodesicgears.c`. Involute gears arranged on the faces /
vertices / edges of a geodesic polyhedron -- one interlinked, counter-rotating system
on the surface of a sphere; every `timeout` seconds the whole sphere scales away and a
new arrangement scales in. Inspired by bugman123.com/Gears and Kenneth Snelson's
"Portrait of an Atom". Self-contained three.js:
`start(canvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }`.
**Asset-free.** This was the last of the involute/gear family.

The gear shape is the shared `involute.js` (faithful port of `involute.c`) -- the same
shared library `geodesicgears.c` uses via `draw_involute_gear()`, exactly as
`gears.js` / `moebiusgears.js` / `pinion.js` do. Motion (`rotator.js`), palette
(`colormap.js`) and RNG (`yarandom.js`) are the shared faithful util ports.

## Faithfulness (the rule: do NOT deviate from the algorithm)

Transcribed from `geodesicgears.c`:

- **`add_gear_shape`** -- one involute gear per shape: `tooth_h = r/(teeth*0.4)` (halved
  when `> 0.06`); the `thickness = 0.05 + BELLRAND(0.15)` slab; `z = 1 - sqrt(1-r^2)`
  (so the disc edge is tangent to the unit sphere) and the resulting
  `tooth_slope = 1 + 2z/r` (the gears are slightly conical, leaning toward the sphere
  centre); the random interior (1/10 a ring-only gear, else an inset disc, sometimes a
  raised lip / third disc, sometimes spokes); the nubs (gated by
  `involute_biggest_ring`); the SMALL/MEDIUM/LARGE/HUGE mesh-detail bucket from
  approximate on-screen tooth size; and the two colours `color = colormap[i]`,
  `color2 = colormap[i + n/2]`. All RNG draws are in the .c's order. The shape's baked
  **pre-transform** -- move inward by `thickness/2`, reverse involute's slope-radius
  adjustment (`r /= 1 + thickness*tooth_slope/2`), then `Rz(90) Ry(180)
  Rz(-360/nteeth/4)` to line tooth 0 up with "up" -- is applied to the BufferGeometry,
  exactly as the .c bakes it into the gear's display list.
- **The seven layouts** (`make_prism` 5, `make_octo` 8, `make_deca` 10, `make_14`,
  `make_18`, `make_32` = truncated icosahedron 20 faces + 12 vertices, `make_92` =
  3v geodesic 20+12+60), vertex-for-vertex -- including `add_sphere_gear`'s normalize
  + dedup-by-axis, the per-template teeth-count RNG (`4*(4+BELLRAND(20))` etc.), the
  per-shape colour re-roll, and `G32`/`G92`'s gear ratios `gear2.ratio = 1/ratio`. The
  empirical magic latitudes (`0.136π`, `0.197π`, ...) are copied verbatim. (`make_182`
  `abort()`s in the .c and is not in the template table; not ported.)
- **`sort_gears`** -- the touch-graph -> DAG: `gears_touch_p` (two surface discs touch
  iff `asin(r1) + asin(r2) >= acos(axis1 . axis2)`); `link_neighbors`; the depth-first
  `link_children` from `gears[0]` (with the sentinel `gears[0].parent = gears[0]` trick
  so the root isn't reparented); `orient_gears` (alternating spin direction down the
  tree, root = +1); and **`align_gear_teeth`** -- per gear (parent-first), `parent_tooth`
  finds this gear's tooth closest to any parent tooth, then 64 candidate `offset` values
  across +-half-a-tooth are searched for the one that best meshes that tooth pair, via
  `tooth_coords` (the verbatim `glRotatef` rotation matrix mapping `(0,1,0)` to the
  gear's axis, applied to a rim point and normalized onto the sphere). This is what
  makes adjacent gears actually interlock; the float `acos`/`asin` inputs are clamped to
  `[-1,1]` (numerical safety, not an algorithm change).
- **`draw_geodesic`** -- per gear: `T(axis) R(angle,axis) Rx(-90) Rz(180)
  Rz((th-off)*ratio*dir)`, with the even-teeth half-tooth offset added on `dir>0`
  gears; `th += 0.7*speed` per frame; `Scale(6)` (`x0.8` when `< 14` gears); and the
  scale-out / re-pick / scale-in transition state machine driven by the `timeout`
  clock (here a real-seconds accumulator + a frames-paced `mode_tick`). The camera is
  `gluPerspective(30)` at `(0,0,30)`, portrait-fit scaled, with the rotator's wander
  `((p-0.5)*{8,8,17})` and tumble.

## Lighting (and the specular /PI fix)

One white directional light from `(1,1,1)`; the light's ambient is `0`, so the only
ambient lift is the **GL default global ambient `0.2`** times the gear's
`AMBIENT_AND_DIFFUSE` colour (`involute.c` sets the colour via `glColor`) -- modeled as
`AmbientLight(white, 0.2*PI)`, with the directional light at `intensity = PI` to cancel
three's `1/PI` Lambert (lit face = `(0.2 + N.L) * colour`), the same convention as the
rest of the geometry track. `GL_CULL_FACE` is on, but the gears are closed solids so
`THREE.DoubleSide` is pixel-identical (see `involute.js`); the baked `Ry(180)`
pre-transform is a pure rotation (det +1), so winding is preserved.

- **Specular:** GL light-specular is **cyan** `{0,1,1}` x white material-specular =
  cyan at shininess 128. The `PI` light intensity over-drives it, so the material
  specular is `{0, 1, 1} / PI` (the systematic /PI rule -- see `superquadrics.md` /
  `morph3d.md`): a small cyan-tinted glint, not a white blob.

## Pacing / config

Pacing as in `dangerball.js` / `moebiusgears.js` (`effFps = 1e6/(delay + OVERHEAD)`,
`OVERHEAD = 37500`); xml default delay 30000 -> ~15fps, gear spin `0.7 deg/frame`,
whole-sphere tumble via `rotator.js` (`spin 0.25`, `wander 0.01`, accel 0.2). The
rotator is built once (both spin + wander enabled) and its output is gated live by the
`spin` / `wander` checkboxes (the dangerball pattern); the rotator's discrete
random-walk is ticked at `effFps` and interpolated for smooth render. **OPEN:**
`OVERHEAD` is the family default, not a per-hack measurement -- the GL originals are
runtime-blocked here, so pin it against the demo video (youtube `gd_nTnJQ4Ps`) if the
spin/transition rate reads off.

Config transcribed from `hacks/config/geodesicgears.xml`: `delay`, `timeout` (5-120 s
per arrangement), `wander`, `spin`, `wire`. **OMITTED** (need a font atlas, like
`pinion`): `--labels` (the gear-count description) and `--numbers` (per-tooth labels),
both default off. `speed` is a .c resource with no .xml slider, so it stays `DEF_SPEED
1.0`. `wire` is a live `material.wireframe` toggle (the .c's wire path also drops the
interior discs / uses SMALL meshes; the live toggle is a close approximation of a rare
debug view).

Verified by CDP capture vs `geodesicgears.jpg` across several auto-transitions: the
32-gear truncated icosahedron (large vertex gears + small face gears, meshing), a
small-count arrangement (big through-hole ring gears + nubbed gears), and the full
92-gear geodesic sphere (three gear scales, fine edge gears meshing between the larger
ones) -- all reproduce, with the muted smooth-colormap palettes, soft diffuse + faint
cyan glint, tumble/wander, per-gear counter-rotation, and the scale-away/scale-in shape
changes.

See also: `gears.md`, `moebiusgears.md`, `pinion.md`, `involute.js`; the
`glx-geometry-track-triage` + `framerate-calibration` memories.
