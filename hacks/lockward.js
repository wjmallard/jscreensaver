// lockward.js -- "Lockward" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's lockward (Leo L. Schwab, 2007),
// hacks/glx/lockward.c. A translucent "light show": NSPINNERS=4 independent rings,
// each made of NBLADES=12 flat, pie-wedge "blades" of random inner/outer radii, all
// one (slowly colour-cycling) colour per ring, spinning to quantized stops then
// idling then re-spinning; plus periodic white "blink" flashes (radial / concentric /
// segment patterns) that BRIGHTEN whatever blades they overlap. A cross between the
// wards of a combination lock and an old backlit polarized-light display.
//
// This is a 2D/flat blade show drawn in 3D: it is UNLIT (the .c never enables
// GL_LIGHTING -- it draws glColor wedges), orthographic, depth-test OFF, blending ON.
// So: MeshBasicMaterial (no lights), THREE.DoubleSide (the .c's GL_CULL_FACE only ever
// hides nothing for this always-face-on flat figure), and explicit renderOrder to
// reproduce the .c's exact paint order (spinner 3,2,1,0 then blink) since every mesh
// sits at z=0 and three can't depth-sort coincident transparent meshes.
//
// FAITHFUL TO lockward.c:
//   * BLADE GEOMETRY (gen_blade_arcs / draw_blink_blade): a blade is a 30-degree
//     (2pi/NBLADES) annular wedge centred at 3 o'clock, drawn as a 14-vertex
//     TRIANGLE_FAN -- 7 outer-arc points at radius (outer+1) from +15..-15 deg, then 7
//     inner-arc points at radius (inner+1) from -15..+15 deg (SUBDIV=6 steps). Radii
//     indices 0..7 -> radii 1..8, so there is always a central hole of radius 1.
//   * SPINNERS (init_lockward / draw_lockward): each ring has 12 blades at slots
//     360*i/12 deg with per-blade random radii (outer!=inner, outer>inner), all sharing
//     the ring's current colour; the ring rotates by (rot - rotcount*rotinc).
//   * SPIN SCHEDULE (random_blade_rot): rotate an exact number of divisions (dist*30
//     deg, sign random) over rotcount frames (1..6 sec per division); then idle a
//     random rotateidle interval; then re-spin. Approaching the target by subtracting
//     rotcount*rotinc hits it exactly with no drift.
//   * COLOUR CYCLE: per-ring 128-entry make_smooth_colormap; ccolor is n.4 fixed point
//     (ncolors<<4 = 2048), advanced by colorinc in {-16..-1, 1..16} (never 0); shown
//     index = ccolor>>4.
//   * BLINKS (random_blink + the 6 drawfuncs, 10 BTYPEs): radial single/random/seq/
//     doubleseq, segment single/random/scatter, concentric single/random/seq -- the
//     blade-bitmask reuse, the ffs run-finding scatter noise, the dwell decay/sharp
//     alpha (set_alpha_by_dwell), all transcribed. Blink colour is white, blended
//     glBlendFunc(GL_DST_COLOR, GL_SRC_ALPHA) => dst*(1+alpha) (a brightening flash),
//     vs the spinners' default glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA) at
//     alpha 0.5.
//   * CAMERA (reshape_lockward): glOrtho with the figure's radius-8 fit to the SHORT
//     axis (landscape -8*aspect..8*aspect x -8..8; portrait mirrored).
//
// PACING as across the geometry track: render every rAF, CONTINUOUS motion; effFps =
// 1e6/(delay + OVERHEAD), OVERHEAD = 37500; each render-frame advances every rotation /
// timer / colour by `frames = dt*effFps`, and the discrete blink/spin EVENTS fire when
// their countdowns elapse. The .c hardcoded ctx->fps=60 for its ms->frame conversions
// (a known "WTF?" in the source) while rendering at the delay rate; here those
// conversions use effFps so the configured millisecond idle/dwell durations are honoured
// in real time (see .md).

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeSmoothColormap } from './colormap.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding). Disable three's color management so the
// port matches GL: set at MODULE SCOPE (before start() fills colors) so the
// setRGB(..., SRGBColorSpace) calls become no-ops and store RAW glColor, and the output
// is not sRGB-encoded. Without this, lit/shaded faces render up to ~2.5x too bright
// (measured vs the rubikblocks grayscale ground truth).
THREE.ColorManagement.enabled = false;

export const title = 'lockward';

export const info = {
  author: 'Leo L. Schwab',
  year: 2007,
  description: 'A translucent spinning, blinking thing. Sort of a cross between the wards in an old combination lock and those old backlit information displays that animated and changed color via polarized light.',
};

// ---- constants (lockward.c #defines) ----
const NBLADES = 12;     // g_blades / NBLADES: blades per ring, divisions of the circle
const NSPINNERS = 4;    // NSPINNERS: independent rings
const NRADII = 8;       // NRADII: distinct radii (indices 0..7 -> radii 1..8)
const COLORIDX_SHF = 4; // ccolor is n.4 fixed point
const SUBDIV = 6;       // arc subdivisions per blade
const MAX_BTYPE = 10;   // number of blink types

// blink type ids (enum blinktype), used to branch the draw + step logic.
const BTYPE_RADIAL_SINGLE = 0;
const BTYPE_RADIAL_RANDOM = 1;
const BTYPE_RADIAL_SEQ = 2;
const BTYPE_RADIAL_DOUBLESEQ = 3;
const BTYPE_SEGMENT_SINGLE = 4;
const BTYPE_SEGMENT_RANDOM = 5;
const BTYPE_CONCENTRIC_SINGLE = 6;
const BTYPE_CONCENTRIC_RANDOM = 7;
const BTYPE_CONCENTRIC_SEQ = 8;
const BTYPE_SEGMENT_SCATTER = 9;

export function start(hostCanvas, opts = {}) {
  const DEG = Math.PI / 180;
  const OVERHEAD = 37500;   // us; pacing (xml default delay 20000 -> ~17fps effective)

  // Knobs transcribed 1:1 from hacks/config/lockward.xml. The host renders the box
  // from `params` and mutates `config` in place; `delay` is the frame-rate knob
  // (inverted slider), the rest are the millisecond idle/dwell bounds + blink toggle.
  const config = {
    delay: 20000,          // us (xml default; invert slider)
    rotateidleMin: 1000,   // ms (xml --rotateidle-min)
    rotateidleMax: 6000,   // ms (xml --rotateidle-max)
    blinkidleMin: 1000,    // ms (xml --blinkidle-min)
    blinkidleMax: 9000,    // ms (xml --blinkidle-max)
    blinkdwellMin: 100,    // ms (xml --blinkdwell-min)
    blinkdwellMax: 600,    // ms (xml --blinkdwell-max)
    blink: true,           // xml --blink / DEF_BLINK
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'rotateidleMin', label: 'Minimum rotator idle time', type: 'range', min: 500, max: 10000, step: 100, default: 1000, unit: ' ms', lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'rotateidleMax', label: 'Maximum rotator idle time', type: 'range', min: 500, max: 10000, step: 100, default: 6000, unit: ' ms', lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'blinkidleMin', label: 'Minimum blink idle time', type: 'range', min: 500, max: 20000, step: 100, default: 1000, unit: ' ms', lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'blinkidleMax', label: 'Maximum blink idle time', type: 'range', min: 500, max: 20000, step: 100, default: 9000, unit: ' ms', lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'blinkdwellMin', label: 'Minimum blink dwell time', type: 'range', min: 50, max: 1500, step: 50, default: 100, unit: ' ms', lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'blinkdwellMax', label: 'Maximum blink dwell time', type: 'range', min: 50, max: 1500, step: 50, default: 600, unit: ' ms', lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'blink', label: 'Blinking effects', type: 'checkbox', default: true, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);

  // effFps drives both pacing AND the ms->frame conversions (so the configured idle/
  // dwell durations land in real time). Recomputed live so the delay slider is instant.
  const fps = () => 1e6 / (config.delay + OVERHEAD);

  // calc_interval_frames: a random interval in [min,max) ms, returned in frames.
  function calcIntervalFrames(min, max) {
    let i = min;
    if (max > min) i += rng.random() % (max - min);
    return (i * fps()) / 1000;
  }

  // ===================================================================
  //  Blade / ring geometry (gen_blade_arcs, gen_rings, draw_blink_blade)
  // ===================================================================
  // here = -SUBDIV*step/2 = -15deg; step = (2pi/NBLADES)/SUBDIV = 5deg. The fan's
  // 7 outer-arc angles run +15..-15, the 7 inner-arc angles run -15..+15.
  const STEP = (Math.PI * 2.0 / NBLADES) / SUBDIV;
  const HERE = -SUBDIV * STEP / 2.0;
  const OUTER_ANG = [];   // i = SUBDIV..0
  const INNER_ANG = [];   // i = 0..SUBDIV
  for (let i = SUBDIV; i >= 0; i--) OUTER_ANG.push(HERE + STEP * i);
  for (let i = 0; i <= SUBDIV; i++) INNER_ANG.push(HERE + STEP * i);

  const _vx = new Float64Array(SUBDIV * 2 + 2);   // 14 fan-vertex scratch buffers
  const _vy = new Float64Array(SUBDIV * 2 + 2);

  // Emit one blade (a 14-vertex TRIANGLE_FAN -> 12 triangles) into `sink(x,y)`,
  // rotated by `base` radians about the origin. innerIdx/outerIdx are radius indices.
  function emitBlade(innerIdx, outerIdx, base, sink) {
    const ro = outerIdx + 1.0, ri = innerIdx + 1.0;
    for (let j = 0; j <= SUBDIV; j++) {
      const a = base + OUTER_ANG[j];
      _vx[j] = Math.cos(a) * ro; _vy[j] = Math.sin(a) * ro;
    }
    for (let j = 0; j <= SUBDIV; j++) {
      const a = base + INNER_ANG[j];
      _vx[SUBDIV + 1 + j] = Math.cos(a) * ri; _vy[SUBDIV + 1 + j] = Math.sin(a) * ri;
    }
    for (let k = 1; k <= SUBDIV * 2; k++) {     // fan: (v0, vk, vk+1)
      sink(_vx[0], _vy[0]); sink(_vx[k], _vy[k]); sink(_vx[k + 1], _vy[k + 1]);
    }
  }

  // Emit a full annular ring n: radius (n+1)..(n+2), NBLADES*SUBDIV segments (gen_rings).
  function emitRing(n, sink) {
    const r1 = n + 1.0, r2 = n + 2.0, N = NBLADES * SUBDIV;
    const step = (Math.PI * 2.0) / N;
    for (let i = 0; i < N; i++) {
      const a0 = step * i, a1 = step * (i + 1);
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      sink(c0 * r1, s0 * r1); sink(c0 * r2, s0 * r2); sink(c1 * r1, s1 * r1);
      sink(c1 * r1, s1 * r1); sink(c0 * r2, s0 * r2); sink(c1 * r2, s1 * r2);
    }
  }

  // ===================================================================
  //  three.js scene
  // ===================================================================
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x000000, 1);     // glClear(GL_COLOR_BUFFER_BIT) -> black

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // Orthographic, figure radius 8 fit to the short axis (reshape_lockward's glOrtho).
  // Camera on +Z looking at the origin so +Z faces the viewer and a CCW glRotatef about
  // Z reads CCW on screen, as in GL.
  const camera = new THREE.OrthographicCamera(-8, 8, 8, -8, 0.01, 10);
  camera.position.set(0, 0, 5);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // ---- spinners: one mesh per ring (12 blades baked into local geometry) ----
  const _col = new THREE.Color();
  const spinners = [];
  for (let i = 0; i < NSPINNERS; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,                          // scolor[3] = 0.5
      blending: THREE.NormalBlending,        // GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = (NSPINNERS - 1) - i;  // draw order n=3,2,1,0 (n=3 at the back)
    scene.add(mesh);
    spinners.push({
      rot: 0, rotcount: -1, rotinc: 0,
      colors: [], ncolors: 0, ccolor: 0, colorinc: 0,
      nblades: NBLADES, bladeidx: [],
      mesh, mat, geom: mesh.geometry,
    });
  }

  // ---- blink: one mesh, dynamic geometry, brightening blend ----
  const BLINK_MAX_VERTS = 4096;
  const blinkPos = new Float32Array(BLINK_MAX_VERTS * 3);
  const blinkAttr = new THREE.BufferAttribute(blinkPos, 3);
  blinkAttr.setUsage(THREE.DynamicDrawUsage);
  const blinkGeom = new THREE.BufferGeometry();
  blinkGeom.setAttribute('position', blinkAttr);
  const blinkMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,                         // bs->color = white
    transparent: true,
    opacity: 1.0,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  blinkMat.blending = THREE.CustomBlending;  // GL_DST_COLOR, GL_SRC_ALPHA
  blinkMat.blendEquation = THREE.AddEquation;
  blinkMat.blendSrc = THREE.DstColorFactor;
  blinkMat.blendDst = THREE.SrcAlphaFactor;
  const blinkMesh = new THREE.Mesh(blinkGeom, blinkMat);
  blinkMesh.frustumCulled = false;
  blinkMesh.renderOrder = NSPINNERS;         // after every spinner
  scene.add(blinkMesh);

  const blink = {
    active: false, type: 0,
    color: [1, 1, 1, 1],
    val: 0, dwell: 0, dwellcnt: -1,
    counter: 0, direction: 0, radius: -1,
    noise: new Uint32Array(NBLADES),
  };
  let nextblink = 0;

  // ===================================================================
  //  Spinner state machine (random_blade_rot + the draw_lockward advance)
  // ===================================================================
  function randomBladeRot(ss) {
    let dist = (rng.random() % NBLADES) + 1;            // 1..NBLADES
    const f = fps();
    const mod = Math.max(1, Math.floor(6 * dist * f - f));
    ss.rotcount = (rng.random() % mod) + f;             // [f, 6*dist*f) frames
    if (rng.random() & 4) dist = -dist;
    const d = dist * 360.0 / NBLADES;                   // a whole number of divisions
    ss.rot += d;
    ss.rotinc = d / ss.rotcount;
  }

  // Advance one ring by `frames`: continuous rotation + the spin/idle/re-spin
  // transitions (rotcount counts down; at 0, rotinc!=0 -> idle, rotinc==0 -> new spin),
  // then the colour cycle. The displayed rotation (rot - rotcount*rotinc) stays
  // continuous across every transition.
  function advanceSpinner(ss, frames) {
    let f = frames, guard = 0;
    while (f > 1e-9 && guard++ < 1000) {
      if (ss.rotcount > 0) {
        const step = Math.min(f, ss.rotcount);
        ss.rotcount -= step; f -= step;
        if (ss.rotcount <= 1e-9) {
          ss.rotcount = 0;
          if (ss.rotinc !== 0) {              // was spinning -> idle
            ss.rotinc = 0;
            ss.rotcount = calcIntervalFrames(config.rotateidleMin, config.rotateidleMax);
          } else {                            // was idling -> new spin
            randomBladeRot(ss);
          }
        }
      } else {                                // rotcount == 0 leftover (guard path)
        if (ss.rotinc !== 0) {
          ss.rotinc = 0;
          ss.rotcount = calcIntervalFrames(config.rotateidleMin, config.rotateidleMax);
        } else {
          randomBladeRot(ss);
        }
      }
    }
    // colour cycle: ccolor += colorinc (n.4 fixed point), wrap mod ncolors.
    ss.ccolor += ss.colorinc * frames;
    ss.ccolor = ((ss.ccolor % ss.ncolors) + ss.ncolors) % ss.ncolors;
  }

  // ===================================================================
  //  Blink state machine (random_blink + the drawfunc step logic)
  // ===================================================================
  function randomBlink() {
    blink.color[0] = blink.color[1] = blink.color[2] = blink.color[3] = 1.0;
    blink.dwellcnt = -1;
    blink.radius = -1;
    blink.dwell = calcIntervalFrames(config.blinkdwellMin, config.blinkdwellMax);
    if (rng.random() & 2) blink.dwell = -blink.dwell;   // <0 = sharp, >0 = decay
    blink.type = rng.random() % MAX_BTYPE;
    blink.val = 0;
    switch (blink.type) {
      case BTYPE_RADIAL_SINGLE:
      case BTYPE_SEGMENT_SINGLE:
        blink.counter = 1; break;
      case BTYPE_RADIAL_RANDOM:
      case BTYPE_SEGMENT_RANDOM:
        blink.counter = NBLADES; break;
      case BTYPE_RADIAL_SEQ:
        blink.val = rng.random() % NBLADES;              // initial offset
        blink.direction = (rng.random() & 8) ? 1 : -1;
        blink.counter = NBLADES; break;
      case BTYPE_RADIAL_DOUBLESEQ:
        blink.val = rng.random() % NBLADES;
        blink.counter = (NBLADES / 2) + 1; break;
      case BTYPE_CONCENTRIC_SINGLE:
        blink.counter = 1; break;
      case BTYPE_CONCENTRIC_RANDOM:
        blink.counter = NRADII - 1; break;
      case BTYPE_CONCENTRIC_SEQ:
        blink.direction = (rng.random() & 8) ? 1 : -1;
        blink.counter = NRADII - 1; break;
      case BTYPE_SEGMENT_SCATTER:
        blink.counter = (rng.random() % (NBLADES / 2)) + (NBLADES / 2) + 1; break;
    }
    blink.active = true;
  }

  // The "dwellcnt < 0" transition shared by the drawfuncs: pick the next blade/ring/
  // noise (or end the blink), reset dwellcnt = |dwell|, decrement counter.
  function stepBlink() {
    const t = blink.type;
    if (blink.counter <= 0) { blink.active = false; return; }

    if (t === BTYPE_RADIAL_SINGLE || t === BTYPE_RADIAL_RANDOM ||
        t === BTYPE_SEGMENT_SINGLE || t === BTYPE_SEGMENT_RANDOM) {
      let i;                                  // find an unused blade
      do { i = rng.random() % NBLADES; } while (blink.val & (1 << i));
      blink.val |= (1 << i);
      blink.direction = i;
      if (t === BTYPE_SEGMENT_SINGLE || t === BTYPE_SEGMENT_RANDOM)
        blink.radius = rng.random() % (NRADII - 1);
    } else if (t === BTYPE_CONCENTRIC_SINGLE || t === BTYPE_CONCENTRIC_RANDOM) {
      let i;                                  // find an unused ring
      do { i = rng.random() % (NRADII - 1); } while (blink.val & (1 << i));
      blink.val |= (1 << i);
      blink.direction = i;
    } else if (t === BTYPE_SEGMENT_SCATTER) {
      const m = (1 << (NRADII - 1)) - 1;      // 7-bit mask
      for (let i = 0; i < NBLADES; i++)
        blink.noise[i] = (rng.random() & rng.random() & m) >>> 0;
    }
    // (RADIAL_SEQ / RADIAL_DOUBLESEQ / CONCENTRIC_SEQ: no per-step pick.)

    blink.dwellcnt = Math.abs(blink.dwell);
    blink.counter--;
  }

  // set_alpha_by_dwell: decay (dwell>0) fades dwellcnt/dwell; sharp (dwell<0) is full
  // until the last quarter, then 0.
  function alphaByDwell() {
    let a;
    if (blink.dwell > 0) a = blink.dwellcnt / blink.dwell;
    else a = (blink.dwellcnt > (-blink.dwell) / 4) ? 1.0 : 0.0;
    return a < 0 ? 0 : a > 1 ? 1 : a;
  }

  function ffs(x) {                           // 1-based index of the lowest set bit
    x = x >>> 0;
    if (!x) return 0;
    let n = 1;
    while (!(x & 1)) { x >>>= 1; n++; }
    return n;
  }

  // Rebuild the blink geometry for the current state (mirrors the active drawfunc).
  let blinkVcount = 0;
  function buildBlink() {
    let bi = 0;
    const sink = (x, y) => {
      if (bi + 3 <= blinkPos.length) { blinkPos[bi++] = x; blinkPos[bi++] = y; blinkPos[bi++] = 0; }
    };
    if (config.blink && blink.active) {
      const t = blink.type;
      if (t === BTYPE_RADIAL_SINGLE || t === BTYPE_RADIAL_RANDOM ||
          t === BTYPE_SEGMENT_SINGLE || t === BTYPE_SEGMENT_RANDOM) {
        const base = blink.direction * 360.0 / NBLADES * DEG;
        if (blink.radius >= 0) emitBlade(blink.radius, blink.radius + 1, base, sink);
        else emitBlade(0, NRADII - 1, base, sink);
      } else if (t === BTYPE_RADIAL_SEQ) {
        const base = (blink.counter * blink.direction + blink.val) * 360.0 / NBLADES * DEG;
        emitBlade(0, NRADII - 1, base, sink);
      } else if (t === BTYPE_RADIAL_DOUBLESEQ) {
        emitBlade(0, NRADII - 1, (blink.val + blink.counter) * 360.0 / NBLADES * DEG, sink);
        if (blink.counter && blink.counter < NBLADES / 2)
          emitBlade(0, NRADII - 1, (blink.val - blink.counter) * 360.0 / NBLADES * DEG, sink);
      } else if (t === BTYPE_CONCENTRIC_SINGLE || t === BTYPE_CONCENTRIC_RANDOM) {
        emitRing(blink.direction, sink);
      } else if (t === BTYPE_CONCENTRIC_SEQ) {
        const n = blink.direction > 0 ? (NRADII - 2) - blink.counter : blink.counter;
        emitRing(n, sink);
      } else if (t === BTYPE_SEGMENT_SCATTER) {
        for (let i = 0; i < NBLADES; i++) {
          let bits = blink.noise[i] >>> 0, guard = 0;
          const base = i * 360.0 / NBLADES * DEG;
          while (bits && guard++ < 32) {
            const inner = ffs(bits) - 1;
            bits = ((~bits) & (~(((1 << inner) >>> 0) - 1))) >>> 0;
            const outer = ffs(bits) - 1;
            bits = ((~bits) & (~(((1 << outer) >>> 0) - 1))) >>> 0;
            emitBlade(inner, outer, base, sink);
          }
        }
      }
    }
    blinkVcount = bi / 3;
    blinkAttr.needsUpdate = true;
    blinkGeom.setDrawRange(0, blinkVcount);
    blinkMat.opacity = blink.active ? alphaByDwell() : 0;
  }

  // ===================================================================
  //  Initialization (init_lockward), and reinit
  // ===================================================================
  function initSpinner(ss) {
    ss.rot = 0; ss.rotcount = -1; ss.rotinc = 0;
    randomBladeRot(ss);

    // colour cycling path + rate (rate avoids zero).
    const base = 128;
    let colorinc = (rng.random() & ((2 << COLORIDX_SHF) - 1)) - (1 << COLORIDX_SHF);
    if (colorinc >= 0) colorinc++;
    ss.colorinc = colorinc;
    const cm = makeSmoothColormap(rng, base);
    ss.colors = cm.map((c) => new THREE.Color().setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace));
    ss.ncolors = base << COLORIDX_SHF;        // n.4 fixed point (2048)
    ss.ccolor = 0;

    // per-blade radii: outer != inner, ensure outer > inner.
    ss.nblades = NBLADES;
    ss.bladeidx = new Array(NBLADES);
    for (let n = NBLADES - 1; n >= 0; n--) {
      let outer, inner;
      do { outer = rng.random() & 7; inner = rng.random() & 7; } while (outer === inner);
      if (outer < inner) { const tmp = outer; outer = inner; inner = tmp; }
      ss.bladeidx[n] = { outer, inner };
    }

    // bake the 12 blades into the ring's local geometry (slots 360*i/12).
    const pos = [];
    const sink = (x, y) => { pos.push(x, y, 0); };
    for (let i = 0; i < ss.nblades; i++)
      emitBlade(ss.bladeidx[i].inner, ss.bladeidx[i].outer, 360.0 * i / ss.nblades * DEG, sink);
    ss.geom.dispose();
    ss.geom = new THREE.BufferGeometry();
    ss.geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    ss.mesh.geometry = ss.geom;
  }

  function initAll() {
    for (let i = NSPINNERS - 1; i >= 0; i--) initSpinner(spinners[i]);   // .c order: i=3..0
    blink.active = false;
    blink.dwellcnt = -1;
    nextblink = calcIntervalFrames(config.blinkidleMin, config.blinkidleMax);
  }
  initAll();

  // ---- sizing (reshape_lockward's glOrtho) ----
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    if (w >= h) { camera.left = -8 * aspect; camera.right = 8 * aspect; camera.top = 8; camera.bottom = -8; }
    else { camera.left = -8; camera.right = 8; camera.top = 8 / aspect; camera.bottom = -8 / aspect; }
    camera.updateProjectionMatrix();
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop: continuous spin/colour/blink at effFps ----
  let raf = 0, last = 0, paused = false, ms = 16;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    const dt = Math.min(frame / 1000, 0.25);
    const frames = dt * fps();

    // advance + display each ring.
    for (let i = 0; i < NSPINNERS; i++) {
      const ss = spinners[i];
      advanceSpinner(ss, frames);
      ss.mesh.rotation.z = (ss.rot - ss.rotcount * ss.rotinc) * DEG;
      const idx = ((Math.floor(ss.ccolor / (1 << COLORIDX_SHF)) % 128) + 128) % 128;
      ss.mat.color.copy(ss.colors[idx]);
    }

    // advance the blink (pick-next-if-elapsed, or idle countdown), build, then decay.
    if (config.blink) {
      if (blink.active) {
        if (blink.dwellcnt < 0) stepBlink();
      } else {
        nextblink -= frames;
        if (nextblink <= 0) {
          nextblink = calcIntervalFrames(config.blinkidleMin, config.blinkidleMax);
          randomBlink();
        }
      }
    }
    buildBlink();
    if (config.blink && blink.active) blink.dwellcnt -= frames;   // mirrors --dwellcnt after draw

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      for (const ss of spinners) { ss.geom.dispose(); ss.mat.dispose(); }
      blinkGeom.dispose();
      blinkMat.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { initAll(); },   // fresh palettes / blades / rotations (host 're-seed')
    config,
    params,
  };
}

export default { title, info, start };
