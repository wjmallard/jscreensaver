# cubenetic -- design notes

Web port of xscreensaver's `cubenetic` (Jamie Zawinski, 2002),
`xscreensaver-6.15/hacks/glx/cubenetic.c`. "A cubist Lavalite, sort of." A small set
(default 5) of unit boxes stacked at the origin, each independently PULSATING -- its
position and its width/height/depth each ride their own sine wave -- so the boxes swell,
shrink and slide through one another. Over every surface runs an ever-changing blobby
plasma TEXTURE (the `interference.c` wave algorithm). The whole cluster slowly spins on
all three axes and wanders. Self-contained three.js:
`start(canvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }`.
**Asset-free** (the texture is generated procedurally each frame; no images).

## Faithfulness (the rule: do NOT deviate from the algorithm)

- **`unit_cube`** is transcribed vertex-for-vertex into one shared `BufferGeometry`: the
  same 6 faces, each with its single face normal and the .c's exact texCoords. The .c's
  `GL_CULL_FACE` on a closed solid is replaced by `side: THREE.DoubleSide` (pixel-identical,
  removes winding risk; under lighting three flips the normal for back faces). `glShadeModel
  (GL_FLAT)` is moot here -- each face already has one constant normal.
- **The texture** is the defining visual, ported from `init_wave` + `interference`:
  - `init_wave` precomputes `heights[i] = (max + max*cos(i/50))/2` (truncated to int),
    `max = ncolors*(radius-i)/radius` -- a decaying-cosine falloff table indexed by integer
    distance. Rebuilt whenever `waveRadius` changes. Slot `[radius]` is kept 0 so the .c's
    `dist > radius ? 0 : heights[dist]` stays in-bounds at `dist == radius` (the original
    reads one past its `calloc`, a latent C bug; guarded, never hit at the default radius).
  - `interference` (per frame): advance each wave source's `xth/yth` by `speed/1000`, place
    it on a circle across the 256x256 field (`x = 128 + cos(xth)*128`, stored as int); for
    every pixel sum `heights[dist]` over the sources, `% ncolors`, and index the hue palette.
    Written into a `THREE.DataTexture` (`RGBAFormat`, alpha left 0xFF), `GL_NEAREST` +
    `GL_REPEAT`, no mipmaps, `needsUpdate` each frame -- exactly the .c's per-frame
    `shuffle_texture`.
- **`shuffle_cubes`'s `SINOID` throb** verbatim: `x,y,z = SINOID(d*, frame, 0.5)` (amp +-0.25)
  and `w,h,d = SINOID(d*, frame, 0.9) + 1.0` (range 0.55..1.45), each box with its own random
  `dx..dd` frequencies (`frand(0.1)`). `cube->color` cycles the smooth colormap one step per
  frame (here a continuous `colorf`, floored to index).
- **`draw_cube`'s modelview**, as nested groups:
  `S(portrait) * S(1.1) * T(wander*{8,6,15}) * R(spin xyz) * S(2.5) * [per box T(x,y,z) *
  S(w,h,d)]`; camera `gluPerspective(30, 1/h, 1, 100)` + `gluLookAt(0,0,30, 0,0,0, +y)`. The
  reshape portrait-fit `glScalef(s,s,s)` (`s = w<h ? w/h : 1`) is folded with the constant
  1.1 onto the outer group.

## The look: LIT + GL_MODULATE, and the colour pipeline

The .c enables `GL_LIGHTING` with one light, `GL_LIGHT0`: directional (`pos {1,0.5,1,0}`),
diffuse white, **ambient 0.2**. Reproduced as a `DirectionalLight(white, PI)` from
`(1,0.5,1)` (the `PI` makes three's Lambert diffuse = `albedo*NdotL`, the GL fixed-pipeline
result) plus an `AmbientLight`. The ambient intensity is **`0.4*PI`, not the track's usual
`0.2*PI`**: GL adds the global model ambient (0.2) AND `GL_LIGHT0`'s own ambient (0.2), so the
total ambient term is `0.4*colour`; three's indirect diffuse is `ambientColor/PI * albedo`,
so `0.4*PI` reproduces it. Material specular is **black** (the GL material specular default;
`glMaterialfv` only sets `AMBIENT_AND_DIFFUSE`), so there is no highlight -- matte boxes.

Each box gets a per-box colour from `make_smooth_colormap` (`cube_colors`), and the texture
is applied with `GL_MODULATE` (texture x colour). In three this is `material.map` x
`material.color`, which feed the same diffuse term; since the lighting here is purely
multiplicative on colour (no specular/emission), `tex * (0.4 + NdotL) * colour` is identical
whether the texture multiplies before or after lighting. So a face shows the blob pattern
tinted by that box's (cycling) colour and shaded by the one light.

Colour space: three's colour management is DISABLED (`THREE.ColorManagement.enabled =
false`, module scope) so the renderer matches GL's fixed pipeline -- raw glColor written to
the framebuffer with no sRGB encoding. The `setRGB(..., SRGBColorSpace)` cube colours and
the `SRGBColorSpace` texture tag become no-ops at fill time (raw glColor), and the output is
not sRGB-encoded -- so the shaded box faces are not over-brightened. (The track-wide fix
from the 2026 colour-management audit; the additive UNLIT hacks like `cubestack` reach the
same raw output the same way.)

`hsv_to_rgb` and `make_color_path` (== `make_color_loop` over 3 HSV points) are **ported
inline** -- `colormap.js` exports `makeSmoothColormap` (used for the cube colours) but not
those, so reproducing them keeps the hack self-contained. The texture palette is the .c's
`reset_colors`: a closed hue loop through `{h0, h0+60, h0+120}` (mod 360, `h0 =
(int)frand(360)`) at full saturation/value -- the vivid blob palette. (`make_color_loop`
passes the `double` hues to an `int` argument, truncating them; matched.)

## Pacing / config

Render every rAF. CONTINUOUS state (each wave's phase, each box's throb `frame` and colour)
advances by `frames = dt*effFps`, so the trajectory matches the .c's per-frame step sampled
smoothly. The DISCRETE rotator random-walk is ticked once per original-frame (at `effFps`)
and the spin/wander interpolated between samples (shortest-path lerp on the rotation circle).
`effFps = 1e6/(delay + OVERHEAD)`, `OVERHEAD = 37500`; cubenetic's xml `delay` default is
**20000** (not the track's 30000) -> ~17 fps. The rotator
(`make_rotator(1,1,1, 1.0, 0.05, True)` -- all axes, the `XYZ` default) is built once at full
speed; `config.spin` (a select: none / X / Y / Z / XY / XZ / YZ / XYZ) gates which axes' spin
is applied, and `config.wander` gates the translate -- the dangerball pattern (no rebuild on
toggle). **OPEN:** `OVERHEAD` is the family default, not a per-hack measurement; pin against
the demo video (youtube `aElbM0rZZNg`) if pacing reads off.

Config transcribed 1:1 from `hacks/config/cubenetic.xml`: `delay` (Frame rate, invert),
`count` (Boxes 1..20), `wander`, `spin` (Rotation), `waveSpeed`/`waveRadius`/`waves` (Surface
pattern speed / overlap / complexity), `texture` (Textured), `wire` (Wireframe). All live:
`count` and `waves` show/use the first N of preallocated boxes/sources; `waveRadius` rebuilds
the `heights` table on change; `texture`/`wire` attach or detach the texture map (the .c
forces `do_texture=False` under wireframe) and stop the per-frame texture regen when off.
`reinit()` is the .c's space-bar `reset_colors`: re-roll both palettes.

## Deviations / omissions

- **Trackball** (mouse drag to rotate) is not ported -- there is no pointer input in the
  screensaver host (the .c's `!button_down_p` path, i.e. auto-rotate, is always taken).
- The texture is regenerated every rAF (so it is as smooth as the boxes), ~4x the .c's
  ~17 fps update cadence; the wave phase still advances by `frames`, so the speed matches.
- **Palette is random per run** (`h0` and the smooth colormap), so an exact colour match to
  the screenshot is not expected -- only the character (full-saturation hue-loop blobs,
  per-box smooth-colormap tint) matches.
- `count`/`waves` are made live (the .c fixes them at init); preallocated so increasing them
  needs no reallocation. Drawing all 20 boxes' randoms at init shifts the RNG stream vs the
  C, which is immaterial (random per run, and there is no shared/pinned stream here).

## Verification

CDP capture (headless Chrome, port 9224) at several times vs `cubenetic.jpg`: the blobby
concentric plasma (wave interference), the overlapping pulsating boxes, and the directional
shading all match. The in-frame size varies strongly with the throb -- a contracted moment
looks small, an expanded one fills the frame at the GT's scale (the GT caught a large-throb
frame). This run drew a green->blue->cyan loop (the boxes' colours cycling), the screenshot a
red/yellow/green loop -- both valid random draws.

See also: `cubestack.md`, `dangerball.md`, `colormap.js`, `rotator.js`; the
`glx-geometry-track-triage` + `framerate-calibration` memories.
