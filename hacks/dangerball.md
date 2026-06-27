# dangerball -- design notes

Web port of xscreensaver's `dangerball` (Jamie Zawinski, 2001),
`xscreensaver-6.15/hacks/glx/dangerball.c`. A glossy sphere bristling with matte cone
spikes that pulse out / retract / re-aim, tumbling and drifting while colors cycle.
Self-contained three.js module: `start(canvas, opts) -> { stop, pause, resume,
getStats, reinit, config, params }`.

## Faithfulness (measured, not eyeballed)

- **Pace measured from jwz's demo video** (youtube `QU0aPwWwHbg`): the pulse is 40 fixed
  steps/cycle; the tracked period is ~2.7s, so the original runs **~15fps EFFECTIVE** --
  NOT the nominal 33fps that `delay 30000` implies. Per-frame draw/vsync/event overhead
  roughly doubles the frame period. Method (autocorrelation FUNDAMENTAL, not naive
  peak-count / FFT / frame-doubling, which all misled; CDP screencast to measure the
  port itself) is in the `framerate-calibration` memory. Re-verified after the
  continuous-velocity rewrite: port pulse 2.7s = **1.0x faithful**.
- Spike placement (azimuth/elevation, 22-degree truncation-quantize), the `asin()` pulse
  easing, and the `Scale(1.1)*Translate(wander)*Rotate(spin)*Scale(2.0)` modelview
  nesting are transcribed from the `.c`. Motion/palette/RNG are faithful standalone ports
  (`rotator.js` / `colormap.js` / `yarandom.js`, the last bit-exact vs the C).

## Key design decisions (the non-obvious ones)

- **Pacing = continuous VELOCITY, not a sim-step rate.** Render every rAF; motion =
  velocity * dt, so it stays smooth at *any* speed (a step-rate knob jitters at the low
  end). `delay` (us) -> `effFps = 1e6/(delay + OVERHEAD)`, with `OVERHEAD = 37500`
  calibrating the xml default 30000 to the measured ~15fps. Each render frame advances
  `frames = dt * effFps` original-frames of motion.
- **The rotator is a DISCRETE random-walk**, so it is ticked once per original-frame at
  effFps and **interpolated** between ticks (shortest-path lerp on the [0,1) rotation
  circle). That keeps the render smooth AND preserves the original's per-frame event
  cadence (ticking it faster instead makes the tumble subtly "busier"). Pulse, color, and
  wander are continuous, so they need no interpolation.
- **Custom `unit_cone`, not three's `ConeGeometry`:** `tube.c`'s cone is base-RADIUS-1
  (so the `diam=0.2` scale gives the right thickness; `ConeGeometry(0.5)` would halve
  it), with cylinder-like radial normals (the original shades a spike like a cylinder).
- **Cyan highlight:** the `.c`'s highlight color = light_specular (cyan {0,1,1}) x
  material_specular. three has no separate light-specular color, so the cyan is folded
  onto `ballMat.specular` (dimmed to `0x004040`, shininess 200, so the `intensity = PI`
  light doesn't blow the spot out to a big white core).
- **`count` is live:** we build `MAX_SPIKES = 100` cone meshes and show `config.count`
  of them (the slider is instant, no rebuild).

## Config (params transcribed 1:1 from hacks/config/dangerball.xml)

`delay` (Frame rate, 0-100000, def 30000, invert) - `spikespeed` (Spike growth,
0.001-0.25, def 0.05) - `count` (Number of spikes, 1-100, def 30) - `wander` - `spin` -
`wire` (Wireframe). `showfps` skipped (framework, the host has its own readout).

Note: the "Frame rate" label is from the xml, but on the web it is effectively a smooth
*speed* control (we always render every frame). Faithful-to-xml labeling; mild semantic
quirk -- could be relabeled "Speed".

See also: `framerate-calibration` + `geometry-hacks-need-config` memories (the pacing
pattern is the template for future geometry hacks); `cubicgrid.md`.
