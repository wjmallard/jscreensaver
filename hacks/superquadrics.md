# superquadrics -- design notes

Web port of xscreensaver's `superquadrics` (Ed Mackey, 1987/1997),
`xscreensaver-6.15/hacks/glx/superquadrics.c`. A superquadric -- a quadric surface
whose X and Y "roundness" is set by two fractional exponents (Alan Barr, 1981, after
Piet Hein's superellipse) -- drawn as a `res x res` grid of quads that smoothly MORPHS
between random shapes (the two exponents, a topology `Mode` 1..3, two checkerboard
colors, pitch + bank) while it spins on Y. Self-contained three.js:
`start(canvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }`.
**Asset-free.** This was the pilot for the simpler-geometry fan-out.

## Faithfulness (the rule: do NOT deviate from the algorithm)

Transcribed from `superquadrics.c`:

- **The tables (`inputs`):** signed-power `Sine`/`Cosine` via `XtoY` (= `sign(x)*|x|^e`,
  zero below 1e-20, clipped to `CLIP_NORMALS` 1e4); the three `Mode` bands -- `Mode<1`
  the closed ellipsoid, `1..3` a transition, `Mode 3` the **doubled-v torus** -- via the
  exact `mode3`/`cn3`/`inverter2`; the dual (`2 - exponent`) surface normals (with the
  `|cs| > 1e10` degenerate-pole branch); and the `se/ce` (+ `sn/cn` for Mode 3) seam
  fix-ups.
- **`DoneScale`'s mesh:** the `xx=cn*ce, yy=sn, zz=cn*se` vertices, per-vertex smooth
  normals, the quad grid, and the running **2x2 color toggle** (`toggle ^= 2` per row,
  `^= 1` per column -> `curmat[toggle]`), so the surface is a 2-colour checkerboard /
  stripe per the `pats[]` pattern.
- **`MakeUpStuff` (random targets):** exponent `floor(rand*250+0.5)/100 + 0.1` with the
  `>2.0` stretch to 3.0; `Mode` 1..3 (never repeating mid-run); the `(40..240)/255`
  colours with the `1-c` contrast pick and the `pats[pat]` checkerboard; pitch `+-180`,
  bank `+-80`; and the `dostuff` bit-mask gating (init = all). RNG = `yarandom.js`'s
  `LRAND()`, with `myrand(n) = floor(n*LRAND()/2^31)` and `myrandreal = LRAND()/2^31`
  (the .c's scaled-not-modulo form).
- **`NextSuperquadric` state machine:** morph `now -> later` over `maxcount` frames
  (`fnow = counter/maxcount` blend of exponents, colours, Mode, pitch, bank), commit,
  HOLD for `maxcount>>1` frames, pick a new target, repeat; plus the continuous Y spin
  `roty -= spinspeed`. Made continuous here (advanced by `frames` each render-frame) so
  the morph + spin are smooth while the *rate* stays faithful.
- **draw modelview:** `T(0,0,-(7 + 3*Mode))` (`= -(dist/16) - (Mode*3-1)`, `dist=128`)
  `Rx(rotx) Rz(rotz) Ry(roty) Scale(0.7)` * the portrait-fit `s=(W<H?W/H:1)`;
  `gluPerspective(15)`. Built as nested groups, camera at the origin looking -z.

## Lighting (and the specular /PI fix)

`LIGHT0` from `(10,1,1)` with ambient `0.4`; the GL default global ambient is `0.2`; the
material is `GL_AMBIENT_AND_DIFFUSE` = the vertex colour -- so the ambient floor is
`(0.2+0.4) * colour = 0.6 * colour` (`AmbientLight(white, 0.6*PI)`; the directional light
is `intensity = PI` to cancel three's `1/PI` Lambert, as across the geometry track).
`GL_LIGHT_MODEL_TWO_SIDE` is on and the per-`Mode` back/front cull is just an
optimization of that two-sided look, so we render `THREE.DoubleSide`.

- **Specular:** GL uses `0.8` gray @ shininess 50. The `PI` light intensity (needed for
  the diffuse) **over-drives the specular**, blowing the highlight into a white disc, so
  the material specular is `0.8 / PI` -- landing the highlight peak back at GL's ~0.8 (a
  bright glossy glint, not a blob); shininess stays the faithful 50. This is the same
  fix morph3d needed, now confirmed as a **systematic rule** for the track: with the
  `intensity = PI` convention, material specular must be divided by PI.
- **Winding:** the .c draws under `glFrontFace(GL_CW)` (three is CCW-front), and
  `inverter2` flips the normal sense between modes, so each triangle is wound to AGREE
  with its analytic vertex normals (cross-product . normal); otherwise `DoubleSide` flips
  the normal and the lit side loses its diffuse (the same trap as pipes' LWO models;
  here the strong 0.6 ambient would partly mask it, but the fix is applied regardless).

Verified by CDP capture vs `superquadrics.jpg` across the morph: the closed ellipsoid /
rounded cube (Mode 1), the pinched "bowtie" hyperboloid (Mode 2), and the square torus
(Mode 3), in solid / 2x2-checker / striped colourings (incl. the ground truth's pink-blue
stripes), smooth-shaded with a controlled glint -- all reproduce.

## Pacing / config

Pacing as in `dangerball.js` (`effFps = 1e6/(delay + OVERHEAD)`, `OVERHEAD = 37500`); xml
default delay 40000 -> ~13fps, spin `5 deg/frame` -> a full turn in ~5.5s, morph 40
frames -> ~3s. The geometry is rebuilt every render-frame from the blended shape
(preallocated `DynamicDraw` buffers sized for `MaxRes=50`). **OPEN:** `OVERHEAD` is the
family default, not a per-hack measurement -- the GL originals are runtime-blocked here,
so pin it against the demo video (youtube `Mjlc7iPA1N4`) if the morph/spin rate reads
off. Config transcribed 1:1 from `hacks/config/superquadrics.xml`: `delay`, `spinspeed`,
`count` ("Density" -> resolution, clamped 5..50), `cycles` ("Duration" -> morph frames),
`wire`.

See also: `dangerball.md`, `morph3d.md`; the `glx-geometry-track-triage` +
`framerate-calibration` memories.
