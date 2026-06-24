// vfeedback.js — "VFeedback" packaged as a mountable WebGL module.
// start(canvas) returns { stop, pause, resume, reinit, getStats, config, params }.
//
// VFeedback by Jamie Zawinski (2018): video feedback — a camcorder pointed at the
// television it is plugged into, re-grabbing the screen it just drew (slightly
// rotated) ~30x a second, folding the picture into an endless rotating spiral. The
// grabbed frame is run back through the NTSC signal simulation each time, so the
// colour cycling, snow and chroma artifacts are the real analogtv pipeline
// (hacks/analogtv.glsl.js, the port of analogtv.c) — not the blur+hue-rotate
// knock-off this replaces.
//
// Faithful to the shipped hack (vfeedback.c, #undef DEBUG): there is NO image —
// it is pure self-feedback seeded by a specular glint (#CCCC44), which the rotating
// loop sweeps into the spiral. (The test card the old port injected is a DEBUG-only
// transform test in the C, surfaced here as an opt-in mode.) Self-feedback maps to
// the harness ping-pong: atv_source() resamples the PREVIOUS final frame (uPrev)
// through grab_rectangle's exact affine. The camera, the decode knobs and the
// specular are ported from vfeedback.c in JS and fed in as uniforms. The loop is
// held at its coherent equilibrium by a per-frame deadband AGC (harness) plus a
// per-pixel soft-clip (below) — see hacks/vfeedback.md for the full story and the
// memory note analogtv-ntsc-shader-port.

// SHELVED 2026-06-27 — see hacks/shelved/vfeedback.md for why + the full journey.
// NOTE: this WON'T run as-is — the engine's self-feedback path (ping-pong + agcServo)
// was sliced out of ../analogtv.glsl.js; restore it from the appendix in vfeedback.md
// first. (Paths are ../ because this now lives under hacks/shelved/; restore to ./ if revived.)
import { startAnalogTV } from '../analogtv.glsl.js';

export const title = 'vfeedback';

export const info = {
  author: 'Jamie Zawinski',
  description:
    'Video feedback: a camcorder aimed at the television it is plugged into, folding the re-grabbed picture into an endless rotating spiral through a real NTSC signal simulation.',
  year: 2018,
};

// atv_source = the previous final frame resampled through the camera rectangle
// (grab_rectangle in vfeedback.c, exact transform), off-frame samples reading
// black (the dark border past the edge of the screen the camcorder sees). The
// specular glint is drawn onto the screen BEFORE the grab, so it lives at the
// screen point p and the camera rotation sweeps it into the spiral. uPrev/uPrevRes
// are provided by the harness (feedback:true).
const SOURCE = `
uniform vec4 uRect;     // rect.x, rect.y, rect.w, rect.h
uniform float uTh;      // rect.th (radians)
uniform vec3 uSpec;     // spec.x, spec.y (screen [0,1]); z = disc diameter (0 = off)
uniform float uKnee;    // per-pixel soft-AGC knee (bright pixels ease back above this)
uniform float uInject;  // test-card mode: how much fresh card to blend (0 = pure feedback)
uniform float uCard;    // which bundled test card (0/1/2)

// Per-pixel AGC, the way a real set's automatic gain behaves on the camera signal:
// pixels that are too bright are eased back toward white, while pixels that are not
// too bright pass through untouched. That is what keeps the loop from blowing out
// WHILE preserving the spiral's fade gradient -- a single global gain would scale
// the dim arms too and flatten the whole thing to a blob. A soft knee on luma
// (colour preserved): linear up to uKnee, asymptoting to 1 above it.
vec3 softAGC(vec3 c){
  float y = dot(c, vec3(0.30, 0.59, 0.11));
  if (y <= uKnee) return c;
  float ys = uKnee + (1.0 - uKnee) * (1.0 - exp(-(y - uKnee) / max(1.0 - uKnee, 1e-3)));
  return c * (ys / max(y, 1e-4));
}

vec3 atv_source(vec2 uv){
  // grab_rectangle: map this output point back into the previous frame through
  // the camera's rotate/zoom/pan. (Derived from vfeedback.c's per-row affine:
  // recentre on the frame middle, scale by rect.w/h, rotate th, offset rect.x/y.)
  float C = cos(uTh), S = sin(uTh);
  float xcs = uRect.z * (uv.x - 0.5 + uRect.x);
  float ycs = uRect.w * uv.y + uRect.y - 0.5;
  vec2 p = vec2(C*xcs - S*ycs, S*xcs + C*ycs) + 0.5;   // point on the screen
  vec3 col = vec3(0.0);                                // off-screen reads black
  if (p.x >= 0.0 && p.x <= 1.0 && p.y >= 0.0 && p.y <= 1.0) {
    col = softAGC(texture(uPrev, vec2(p.x, 1.0 - p.y)).rgb);   // final frame is y-up in GL
    // Specular reflection (#CCCC44): an opaque disc XFillArc'd onto the screen
    // before the grab, so it sits at the screen point p (not the output point uv)
    // and the camera rotation sweeps it into the fan -- the look's whole engine.
    if (uSpec.z > 0.0) {
      vec2 d = p - uSpec.xy;
      d.x *= uPrevRes.x / max(uPrevRes.y, 1.0);        // round on screen
      float m = 1.0 - smoothstep(uSpec.z*0.45, uSpec.z*0.5, length(d));
      col = mix(col, vec3(0.80, 0.80, 0.27), m);       // sweeps into the spiral
    }
  }
  // Optional test-card mode: a real picture "on the TV" that the loop folds into the
  // recursive camera-on-a-monitor tunnel. The real vfeedback is self-feedback (it
  // re-grabs its own window, not the desktop), so the spiral needs no input; this is
  // its #ifdef DEBUG transform-test path, and since a browser can't grab the desktop
  // a bundled test card is the only image input. Flooded in, then a trickle that keeps
  // re-seeding (see setUniforms). uInject = 0 in the default pure-feedback spiral.
  if (uInject > 0.0) {
    vec2 cuv = vec2(uv.x, 1.0 - uv.y);
    vec3 card = uCard < 0.5 ? texture(uImage0, cuv).rgb
              : uCard < 1.5 ? texture(uImage1, cuv).rgb
              :               texture(uImage2, cuv).rgb;
    col = mix(col, card, uInject);
  }
  return col;
}
`;

const POWERUP = 0, IDLE = 1, MOVE = 2;
// easeInOutSine, verbatim from easing.c (no clamp): used both for the camera
// move (input 0..1) and for the specular disc (input 0..2 -> the double blink).
const eios = (x) => 0.5 * (1 - Math.cos(Math.PI * x));
const sign = () => (Math.random() < 0.5 ? -1 : 1);         // RANDSIGN()
const chance = (n) => Math.floor(Math.random() * n) === 0; // 1/n, like !(random()%n)

export function start(canvas) {
  const config = {
    speed: 1.0,        // evolution rate (vfeedback.c --speed)
    color: 0.6,        // chroma: the spiral takes the #CCCC44 glint's hue; tint cycles it
    noise: 0.02,       // snow injected into the composite (--noise)
    // Loop stabiliser (deviation, documented in vfeedback.md). A real TV runs its
    // AGC every frame, re-normalising the camera's signal on each pass -- that, plus
    // the CRT gamma, is what keeps a real video-feedback loop bounded and coherent
    // instead of crawling to black or blowing out. analogtv.c models AGC as a static
    // knob, so a literal port never self-regulates; and our FIR/resampled round-trip
    // (faithful single-pass, validated on xanalogtv) compounds a small transfer error
    // in the loop, leaving it bistable. So we add the missing piece: a GENTLE
    // per-frame AGC (harness agcServo) as a wide DEADBAND -- it leaves the loop's own
    // CRT-gamma equilibrium (the coherent spiral, ~0.3 mean) alone in the normal band
    // and only eases it back at the extremes as the camera morphs. Faithful in result
    // (cf. the IIR->FIR conversion), and closer to real hardware than the static C.
    agcServo: true,
    agcLo: 0.22,       // deadband: only boost gain below this mean luma...
    agcHi: 0.42,       // ...and only cut above it; the natural equilibrium sits inside
    knee: 0.5,         // per-pixel soft-AGC knee (bright fed-back pixels ease back)
    testcard: false,   // optional: fold a real test card (camera-on-a-monitor) vs the pure spiral
    fps: 30,
  };

  // Loop-gain calibration (deviation): the literal TV-knob values leave our
  // round-trip just shy of self-sustaining, so we hold a fixed loop contrast and a
  // gentle black floor (the literal -0.094 hard-clips and eats the spiral's fade).
  // Together with the gamma these sit the loop at the equilibrium that forms the
  // coherent spiral; the deadband AGC above only catches strays.
  const LOOP_BRIGHT = -0.02;
  const LOOP_CONTRAST = 0.85;

  // Camera rectangle + the decode knobs (vfeedback.c twiddle_knobs/_camera).
  const rect = {}, orect = {};
  const knobs = { brightness: LOOP_BRIGHT, contrast: LOOP_CONTRAST, level: 1.0 };
  let state, value, svalue, dx, dy, ds, dth;
  let tintDeg = Math.random() * 360;        // slowly-drifting hue (the colour cycle)
  let specPhase = Math.random() * 6.283;    // phase of the hub's slow smooth orbit
  let cardIndex = 0, floodFrame = 0, testcardWas = false;   // test-card mode state
  const spec = { x: 0.5, y: 0.5, s: 0.08 }; // persistent specular hub; s = disc diameter

  // twiddle_knobs: the C re-randomises colour/contrast/tint/level. We hold contrast
  // and brightness at the calibration above, drift the tint slowly for a colour cycle
  // (in step), and keep level only as the snow-to-signal ratio -- analogtv's AGC
  // (1/level) cancels level's effect on brightness and we encode at unit amplitude,
  // so nothing is left for level to brighten.
  function twiddleKnobs() {
    knobs.level = 0.8 + Math.random();      // rec.level = 0.8 + frand(1) -> snow ratio
  }
  // twiddle_camera: a small rotation rate only -- NO pan, NO zoom. The C pans and
  // zooms too (w in 0.6..1.4) and spins as fast as 1.2 rad/frame, but on our pipeline
  // any pan or zoom-out spills the picture off-edge faster than the loop gain refills
  // it (the loop collapses), and a fast spin smears the fan into chaos. Pure gentle
  // rotation about the centre keeps every pixel on-screen, which is the one regime
  // that holds the coherent spiral (deviation, documented).
  function twiddleCamera() {
    rect.x = 0; rect.y = 0;
    rect.w = rect.h = 1;
    rect.th = (0.10 + Math.random() * 0.05) * sign();   // |th| in [0.10, 0.15] rad/frame
  }
  // The persistent specular hub orbits the centre on a slow, SMOOTH Lissajous path
  // (set in step). Unlike the C's intermittent glint that jumps to a new spot, ours
  // stays lit and moves continuously: an intermittent/jumping source can't sustain a
  // coherent spiral on our pipeline (it scrambles into discrete blobs), so the glint
  // is the continuous "stray light" the camera always folds, gliding so the spiral
  // it anchors drifts coherently (deviation, documented).
  // A CIRCLE at constant radius -- the hub must stay off the rotation centre (0.5,0.5),
  // or it lands on the fixed point, stops being swept, and just piles up to a white-out.
  function orbitSpecular() {
    spec.x = 0.5 + 0.12 * Math.cos(specPhase);
    spec.y = 0.5 + 0.12 * Math.sin(specPhase);
  }

  function reroll() {
    twiddleCamera();
    twiddleKnobs();
    Object.assign(orect, rect);
    state = POWERUP; value = 0; svalue = 0; dx = dy = ds = dth = 0;
    cardIndex = Math.floor(Math.random() * 3) % 3;   // which test card this run (if enabled)
    orbitSpecular();
  }
  reroll();

  function step() {
    const speed = config.speed || 1;
    if (state === MOVE) {
      rect.th = orect.th + dth * eios(value);        // rotation only
    }
    rect.x = 0; rect.y = 0; rect.w = 1; rect.h = 1;  // pure rotation about the centre
    if (rect.th > 0.20) rect.th = 0.20;              // keep the spin in the fan regime
    if (rect.th < -0.20) rect.th = -0.20;

    // Persistent specular hub: always lit; pulses gently; revolves slowly.
    svalue += 0.012 * speed;
    if (svalue > 1) svalue = 0;
    specPhase += 0.0009 * speed;                     // ~110 s per revolution (quasi-static)
    orbitSpecular();

    tintDeg = (tintDeg + 0.15 * speed) % 360;        // slow colour cycle

    // Advance the camera ease; on completion pick the next gentle pose (vfeedback.c).
    value += 0.02 * speed;
    if (value > 1 || state === POWERUP) {
      Object.assign(orect, rect);
      value = 0; dx = dy = ds = dth = 0;
      if (state === POWERUP) state = IDLE;
      else if (state === IDLE) {
        state = MOVE;
        if (chance(3)) dth = Math.random() * 0.05 * sign();   // gentle rotation-rate change
        if (chance(2000)) twiddleKnobs();
      } else { state = IDLE; value = 0.3; }          // MOVE -> brief IDLE pause
    }
  }

  // Persistent specular disc diameter this frame: a gentle pulse, never fully off --
  // the continuous hub the loop folds into the spiral.
  function specDiameter() {
    return spec.s * (0.8 + 0.2 * Math.sin(2 * Math.PI * svalue));
  }

  const params = [
    { key: 'speed', label: 'Speed', min: 0.1, max: 3, step: 0.1, live: true },
    { key: 'color', label: 'Color', min: 0, max: 2, step: 0.05, live: true },
    { key: 'noise', label: 'Noise', min: 0, max: 0.2, step: 0.01, live: true },
    { key: 'testcard', label: 'Test card', type: 'checkbox', default: false, live: true },
  ];

  // Bundled test cards for the optional camera-on-a-monitor mode (uImage0..2). The
  // spiral itself uses none of them -- it is pure self-feedback.
  const TESTCARDS = ['pm5544', 'rca', 'bbcf'].map(
    (n) => new URL(`../images/testcard_${n}.png`, import.meta.url).href);

  const tv = startAnalogTV(canvas, {
    source: SOURCE,
    feedback: true,
    images: TESTCARDS,
    frameKnobs: () => {
      step();
      return {
        color: config.color == null ? 0.6 : config.color,
        tint: tintDeg,                       // slow colour cycle (drifts in step)
        brightness: knobs.brightness,
        contrast: knobs.contrast,            // scaled by the deadband AGC (agcGain)
        noise: config.noise / knobs.level,   // weaker signal -> more visible snow
      };
    },
    setUniforms: (gl, prog, ctx) => {
      gl.uniform4f(gl.getUniformLocation(prog, 'uRect'), rect.x, rect.y, rect.w, rect.h);
      gl.uniform1f(gl.getUniformLocation(prog, 'uTh'), rect.th);
      gl.uniform3f(gl.getUniformLocation(prog, 'uSpec'), spec.x, spec.y, specDiameter());
      gl.uniform1f(gl.getUniformLocation(prog, 'uKnee'), config.knee == null ? 0.5 : config.knee);
      // Test-card mode: flood the card in for ~0.8 s when first enabled, then trickle.
      const tc = config.testcard ? 1 : 0;
      if (tc && !testcardWas) floodFrame = ctx ? ctx.frame : 0;
      testcardWas = !!tc;
      const f = ctx ? ctx.frame : 0;
      const inject = tc ? Math.max(0.12, 1.0 - (f - floodFrame) / 24.0) : 0.0;
      gl.uniform1f(gl.getUniformLocation(prog, 'uInject'), inject);
      gl.uniform1f(gl.getUniformLocation(prog, 'uCard'), cardIndex);
    },
    config,
    params,
    name: 'vfeedback',
  });

  // reinit re-rolls the camera framing + TV knobs as well as jumping the clock.
  const baseReinit = tv.reinit;
  tv.reinit = () => { reroll(); baseReinit(); };
  return tv;
}
