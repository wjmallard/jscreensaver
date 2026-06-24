# cubicgrid -- design notes

Web port of xscreensaver's `cubicgrid` (Vasek Potocek, 2007),
`xscreensaver-6.15/hacks/glx/cubicgrid.c`. A finite 30^3 lattice of points colored by
position in the RGB cube, seen from within as it tumbles -- rows align and
"view-throughs" (moire-like gaps) open and evolve. Self-contained three.js module.

## Faithfulness

- 30^3 = 27,000 points; color `(x,y,z)/30` (the RGB cube; the (0,0,0) corner is black and
  so invisible on black); **constant pixel point size** (`sizeAttenuation:false`, like
  fixed-function `glPointSize` -- this is what makes the view-throughs read); **no depth
  test** (the .c never enables one); 30-degree perspective viewed from within.
  Transcribed from the .c.
- **Scale + speed tuned to jwz's demo video** (youtube `nOTi7gy9l-I`): `DOT_PX` and the
  spin rate were set by frame analysis. The net spin (`SPIN` ~0.12 rad/s) ended up tuned
  calmer than the measured rate by user preference ("close enough").
- **This was the MAKE-OR-BREAK test** for the whole non-shadertoy geometry track: it
  PASSED, validating the self-contained three.js approach for the fixed-function
  geometry hacks. See the `glx-geometry-track-triage` memory.

## Key design decisions

- **Rotation is already continuous (dt-scaled)** -- smooth at any speed. `speed` and
  `delay` both multiply it (as in the original), `delay` via
  `1e6/(delay + OVERHEAD)` with `OVERHEAD = 37500` so the factor is 1 at the xml
  default delay 20000.
- **`zoom`** -> live `points.scale` (dot spacing / lattice extent). **`bigdots`** -> dot
  size (on = the calibrated `DOT_PX` look, off = half) -- mapped to the video-calibrated
  size, not the .c's exact pixel value.
- **Hexagonal symmetry NOT ported** (the .c offers cubic / hexagonal; only cubic is
  done), so the xml `symmetry` select is not exposed.

## Config (params transcribed 1:1 from hacks/config/cubicgrid.xml)

`delay` (Frame rate, 0-100000, def 20000, invert) - `speed` (0.2-10, def 1.0) - `zoom`
(Dot spacing, 15-100, def 20) - `bigdots` (Big dots, def on). `symmetry` skipped (not
ported); `showfps` skipped (framework).

See also: `dangerball.md` (same self-contained pattern + the continuous-velocity pacing
write-up); `framerate-calibration` + `glx-geometry-track-triage` memories.
