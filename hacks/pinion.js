// pinion.js -- "Pinion" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's pinion (Jamie Zawinski, 2004),
// hacks/glx/pinion.c. A self-building gear train marches across the screen: gears
// are laid out in an off-screen zone on the right, scroll left into view, mesh with
// their neighbors, and are deleted off the left edge. Trains hit dead ends and
// reset; bound "coaxial" pairs share an axle on different depth planes; gears too
// fast to draw cleanly motion-blur (strobe by a half-tooth per frame) and wobble.
//
// The gear bodies are the shared ./involute.js (faithful port of involute.c) -- the
// same shared library pinion.c uses via draw_involute_gear() (this is the hack that
// exercises involute.c's coaxial axle-tube path, which gears/moebiusgears don't).
// This module owns pinion.c's part: the scrolling-train generation + placement
// (the MESHING math), depth-darkening, motion-blur/wobble, the scene, the loop.
// Self-contained otherwise (own overlay canvas + renderer + loop). RNG is the shared
// yarandom.js.
//
// FAITHFUL TO pinion.c -- "do not deviate from the algorithm":
//   * new_gear: tooth size from 0.007/0.005 * (1+BELLRAND(4))*gear_size; nteeth 3-100
//     (small counts rare); the four interior shapes; coaxial gears pick a radius much
//     larger/smaller than parent and share the smaller axle hole; nubs/spokes; the
//     pixel-size -> mesh-detail bucket.
//   * place_gear: too-big rejection, velocity ratio, the half-tooth offset for odd
//     tooth counts, coaxial placement (same x/y, z +/- plane_displacement) vs adjacent
//     placement (angle mostly -120..120, the th mesh-alignment), the already-visible
//     and collision rejections, compute_rpm, depth-darkening, motion-blur + wobble.
//   * push_gear: try-coaxial (1/40) -> regular -> coaxial-fallback -> new-train, the
//     ludicrous-speed unhook (> max_rpm), the blurpocalypse bail, the growth-zone reset.
//   * scroll_gears (x -= scroll*0.002/frame; delete off-screen-left; push to fill the
//     layout zone) + spin_gears (th += ratio*spin/frame, sign preserved) + ffwd
//     (pre-fill so the screen isn't blank at start).
//   * draw: per-gear T(x,y,z) Rz(th) Rx(wobble); the scene scale 16*1.2, tilt -35 X /
//     8 Y, pan; one WHITE-specular light from (-3,1,1), ambient 0.
//
// OMITTED (interaction/debug chrome, not screensaver visuals; documented in pinion.md):
// the mouse-hover stats label (a corner HUD; there is no mouse in a screensaver, and
// it is absent from the ground-truth screenshot), the trackball, GL-select mouse
// picking, the -debug overlays, device rotation. Off-screen gears are simply not
// drawn (the .c draws a cheap line "schematic" for them; they are out of frame).
//
// COLOR / CULLING / PACING as in gears.js / dangerball: raw vertex-color diffuse
// (colour management off), DoubleSide (closed solids), effFps = 1e6/(delay+OVERHEAD) with continuous
// scroll/spin. See gears.md / involute.js.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import {
  buildGearGeometry,
  involuteBiggestRing,
  INVOLUTE_SMALL as SMALL,
  INVOLUTE_MEDIUM as MEDIUM,
  INVOLUTE_LARGE as LARGE,
  INVOLUTE_HUGE as HUGE,
} from './involute.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding). Disable three's color management so the
// port matches GL: set at MODULE SCOPE (before start() fills colors) so the
// setRGB(..., SRGBColorSpace) calls become no-ops and store RAW glColor, and the output
// is not sRGB-encoded. Without this, lit/shaded faces render up to ~2.5x too bright
// (measured vs the rubikblocks grayscale ground truth).
THREE.ColorManagement.enabled = false;

export const title = 'pinion';

export const info = {
  author: 'Jamie Zawinski',
  year: 2004,
  description: 'A gear system marches across the screen.\n\nSee also the "Gears" and "M\u00f6bius Gears" screen savers.\n\nhttps://en.wikipedia.org/wiki/Involute_gear',
};

export function start(hostCanvas, opts = {}) {
  const DEG = Math.PI / 180;
  const OVERHEAD = 37500;     // us; pacing model (see frame-rate-calibration)
  const SIDE = THREE.DoubleSide;

  // Live config -- transcribed 1:1 from hacks/config/pinion.xml + DEFAULTS.
  const config = {
    delay: 15000,    // us (xml default; invert slider)
    spin: 1.0,       // rotation speed (xml --spin)
    scroll: 1.0,     // scrolling speed (xml --scroll)
    size: 1.0,       // gear size (xml --size)
    maxRpm: 900,     // unhook the train above this (xml --max-rpm)
    wire: false,
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 15000, unit: ' µs', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'spin', label: 'Rotation speed', type: 'range', min: 0.1, max: 7.0, step: 0.1, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'scroll', label: 'Scrolling speed', type: 'range', min: 0.1, max: 8.0, step: 0.1, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'size', label: 'Gear size', type: 'range', min: 0.1, max: 3.0, step: 0.1, default: 1.0, lowLabel: 'tiny', highLabel: 'huge', live: false },
    { key: 'maxRpm', label: 'Max RPM', type: 'range', min: 100, max: 2000, step: 50, default: 900, lowLabel: '100', highLabel: '2000', live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);
  const frand = (f = 1) => rng.frand(f);
  const BELLRAND = (n) => (frand(n) + frand(n) + frand(n)) / 3;
  const RND = (n) => rng.random() % n;
  const RANDSIGN = () => ((rng.random() & 1) ? 1 : -1);

  const _c = new THREE.Color();
  const toLin = (r, g, b) => { _c.setRGB(r, g, b, THREE.SRGBColorSpace); return [_c.r, _c.g, _c.b]; };

  // ===================================================================
  //  three.js scene + canvas
  // ===================================================================
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(dpr);
  const canvasH = () => Math.round(window.innerHeight * dpr);   // MI_HEIGHT for the mesh-detail bucket

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // reshape_pinion: gluPerspective(30, aspect, 1, 100) + gluLookAt(0,0,30, 0,0,0, 0,1,0).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // ONE white directional light from (-3,1,1), WHITE specular (not cyan). Plus the GL
  // DEFAULT light-model ambient (0.2) * the material's AMBIENT_AND_DIFFUSE (= the gear
  // color, set by involute.c's draw_gear_teeth) = a 0.2*color ambient floor -> an
  // AmbientLight at 0.2*PI (the PI matches the directional light's 1/PI cancellation).
  // Without it, pinion's grazing light left the gear side walls black -> too dark.
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(-3, 1, 1);
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, 0.2 * Math.PI));

  const material = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    vertexColors: true,
    specular: 0xffffff,
    shininess: 128,
    side: SIDE,
  });

  // draw_pinion scene transform: glScalef(16) glScalef(1.2) Rx(-35) Ry(8) T(0.02,0.1,0).
  const scaleG = new THREE.Group(); scaleG.scale.setScalar(16 * 1.2);
  const rotXG = new THREE.Group(); rotXG.rotation.x = -35 * DEG;
  const rotYG = new THREE.Group(); rotYG.rotation.y = 8 * DEG;
  const gearsGroup = new THREE.Group(); gearsGroup.position.set(0.02, 0.1, 0);
  scaleG.add(rotXG); rotXG.add(rotYG); rotYG.add(gearsGroup); scene.add(scaleG);

  // ===================================================================
  //  viewport / layout zones (reshape_pinion)
  // ===================================================================
  const pp = {
    vp_width: 1.78, vp_height: 1,
    vp_left: 0, vp_right: 0, vp_top: 0, vp_bottom: 0,
    render_left: 0, render_right: 0, layout_left: 0, layout_right: 0,
    plane_displacement: config.size * 0.1,
    gears: [],
    current_length: 0, current_blur_length: 0,
  };

  function reshapeZones() {
    const w = window.innerWidth, h = window.innerHeight;
    const hh = h / w;
    pp.vp_height = 1.0;
    pp.vp_width = 1 / hh;        // = w/h (aspect)
    pp.vp_left = -pp.vp_width / 2; pp.vp_right = pp.vp_width / 2;
    pp.vp_top = pp.vp_height / 2; pp.vp_bottom = -pp.vp_height / 2;
    const render_width = pp.vp_width * 2;
    const layout_width = pp.vp_width * 0.8 * config.size;
    pp.render_left = -render_width / 2; pp.render_right = render_width / 2;
    pp.layout_left = pp.render_right;
    pp.layout_right = pp.layout_left + layout_width;
  }

  // ===================================================================
  //  pinion.c -- gear generation, placement, the scrolling train
  // ===================================================================
  let idCounter = 0;

  // compute_rpm: heuristic RPM from the configured frame rate (drives max_rpm gating).
  function computeRpm(g) {
    let fps = (config.delay === 0 ? 999999 : 1e6 / config.delay);
    if (fps > 150) fps = 150;
    if (fps < 10) fps = 10;
    const rpf = (g.ratio * config.spin) / 360.0;
    g.rpm = rpf * fps * 60;
  }

  function farthestGear(leftP) {
    let rg = null;
    let x = leftP ? 999999 : -999999;
    for (const g of pp.gears) {
      const gx = g.x + ((g.r + g.tooth_h) * (leftP ? -1 : 1));
      if (leftP ? (x > gx) : (x < gx)) { rg = g; x = gx; }
    }
    return rg;
  }

  function newGear(parent, coaxialP) {
    const g = {
      id: ++idCounter, coax_displacement: pp.plane_displacement,
      x: 0, y: 0, z: 0, r: 0, th: 0, rpm: 0, ratio: 0, tooth_slope: 0,
      nteeth: 0, tooth_w: 0, tooth_h: 0, thickness: 0, thickness2: 0, thickness3: 0,
      inner_r: 0, inner_r2: 0, inner_r3: 0, spokes: 0, spoke_thickness: 0, nubs: 0,
      coax_p: 0, coax_thickness: 0, wobble: 0, motion_blur_p: 0, base_p: false,
      size: LARGE, polygons: 0, mesh: null,
    };
    let loop = 0;
    while (true) {
      if (++loop > 1000) break;   // (only loops for coaxial radius pick)

      if (parent && !coaxialP) {   // adjacent gears need matching teeth
        g.tooth_w = parent.tooth_w; g.tooth_h = parent.tooth_h;
        g.thickness = parent.thickness; g.thickness2 = parent.thickness2; g.thickness3 = parent.thickness3;
      } else {
        const scale = (1.0 + BELLRAND(4.0)) * config.size;
        g.tooth_w = 0.007 * scale;
        g.tooth_h = 0.005 * scale;
        g.thickness = g.tooth_h * (0.1 + BELLRAND(1.5));
        g.thickness2 = g.thickness / 4;
        g.thickness3 = g.thickness;
      }

      // nteeth (3-100, small counts rare) -> radius.
      while (true) {
        g.nteeth = 3 + RND(97);
        if (g.nteeth < 7 && RND(5) !== 0) continue;   // make tiny counts rarer
        break;
      }
      const c = g.nteeth * g.tooth_w * 2;
      g.r = c / (Math.PI * 2);

      if (!coaxialP) break;
      if (g.nteeth === parent.nteeth) continue;     // ugly
      if (g.r < parent.r * 0.6) break;              // much smaller than parent
      if (parent.r < g.r * 0.6) break;              // much larger than parent
    }

    g.color = [0.5 + frand(0.5), 0.5 + frand(0.5), 0.5 + frand(0.5)];
    g.color2 = [g.color[0] * 0.85, g.color[1] * 0.85, g.color[2] * 0.85];

    // Interior shape.
    if (RND(10) === 0) {
      g.inner_r = (g.r * 0.1) + frand((g.r - g.tooth_h / 2) * 0.8);
      g.inner_r2 = 0; g.inner_r3 = 0;
    } else {
      g.inner_r = (g.r * 0.5) + frand((g.r - g.tooth_h) * 0.4);
      g.inner_r2 = (g.r * 0.1) + frand(g.inner_r * 0.5);
      g.inner_r3 = 0;
      if (g.inner_r2 > (g.r * 0.2)) {
        const nn = RND(10);
        if (nn <= 2) g.inner_r3 = (g.r * 0.1) + frand(g.inner_r2 * 0.2);
        else if (nn <= 7 && g.inner_r2 >= 0.1) g.inner_r3 = g.inner_r2 - 0.01;
      }
    }

    // Coaxial gears share the smaller axle hole (modifies parent).
    if (coaxialP) {
      const hole1 = (g.inner_r3 ? g.inner_r3 : g.inner_r2 ? g.inner_r2 : g.inner_r);
      const hole2 = (parent.inner_r3 ? parent.inner_r3 : parent.inner_r2 ? parent.inner_r2 : parent.inner_r);
      const hole = Math.min(hole1, hole2);
      if (g.inner_r3) g.inner_r3 = hole; else if (g.inner_r2) g.inner_r2 = hole; else g.inner_r = hole;
      if (parent.inner_r3) parent.inner_r3 = hole; else if (parent.inner_r2) parent.inner_r2 = hole; else parent.inner_r = hole;
    }

    if (g.inner_r3 && RND(5) === 0) {
      g.spokes = Math.trunc(2 + BELLRAND(5));
      g.spoke_thickness = 1 + frand(7.0);
      if (g.spokes === 2 && g.spoke_thickness < 2) g.spoke_thickness += 1;
    }

    if (g.nteeth > 5) {
      const br = involuteBiggestRing(g);
      if (br.size > g.r * 0.2 && RND(5) === 0) {
        g.nubs = 1 + RND(16);
        if (g.nubs > 8) g.nubs = 1;
      }
    }

    const pix = g.tooth_h * canvasH();
    if (pix <= 2.5) g.size = SMALL;
    else if (pix <= 3.5) g.size = MEDIUM;
    else if (pix <= 25) g.size = LARGE;
    else g.size = HUGE;

    g.base_p = !parent;
    return g;
  }

  function placeGear(g, parent, coaxialP) {
    // Too big? (more than ~1/3 of the screen)
    if (((g.r + g.tooth_h) * (6 / config.size)) >= pp.vp_width ||
        ((g.r + g.tooth_h) * (6 / config.size)) >= pp.vp_height) return false;

    // Velocity.
    if (!parent) {
      g.ratio = 0.8 + BELLRAND(0.4);
      g.th = frand(90) * RANDSIGN();
    } else if (coaxialP) {
      g.ratio = parent.ratio; g.th = parent.th; g.rpm = parent.rpm; g.wobble = parent.wobble;
    } else {
      g.ratio = parent.nteeth / g.nteeth;
      g.th = -(parent.th * g.ratio);
      if (g.nteeth & 1) {
        const off = 180.0 / g.nteeth;
        if (g.th > 0) g.th += off; else g.th -= off;
      }
      g.ratio *= parent.ratio;
    }

    // Position.
    if (!parent) {
      const rg = farthestGear(false);
      let right = (rg ? rg.x + rg.r + rg.tooth_h : 0);
      if (right < pp.layout_left) right = pp.layout_left;   // place off screen
      g.x = right + g.r + g.tooth_h + (0.01 / config.size);
      g.y = 0; g.z = 0;
    } else if (coaxialP) {
      const off = pp.plane_displacement;
      g.x = parent.x; g.y = parent.y;
      g.z = parent.z + (g.r > parent.r ? -off : off);   // small gear on top
      if (parent.r > g.r) { parent.coax_p = 1; g.coax_p = 2; parent.wobble = 0; }
      else { parent.coax_p = 2; g.coax_p = 1; g.wobble = 0; }
      g.coax_thickness = parent.thickness; parent.coax_thickness = g.thickness;
      if (g.z >= off * 4 || g.z <= -off * 4) return false;   // too close to/far from screen
    } else {
      const r_off = parent.r + g.r;
      const angle = (RND(3) !== 0) ? (RND(240) - 120) : (RND(360) - 180);
      g.x = parent.x + Math.cos(angle * DEG) * r_off;
      g.y = parent.y + Math.sin(angle * DEG) * r_off;
      g.z = parent.z;
      if (g.y > pp.vp_top || g.y < pp.vp_bottom) return false;   // off screen top/bottom
      g.th += (g.th > 0 ? 360 : -360);
      // line teeth up with parent
      const p_t = (2 * Math.PI * parent.r) * (angle / 360.0);
      const g_th = 360.0 * (p_t / (2 * Math.PI * g.r));
      g.th += angle + g_th;
    }

    // Don't let gears flash into existence on-screen (train growing backwards).
    if (g.x - g.r - g.tooth_h < pp.render_right) return false;

    // Collision with any earlier gear on the same layer.
    for (let i = pp.gears.length - 1; i >= 0; i--) {
      const og = pp.gears[i];
      if (og === g || og === parent) continue;
      if (g.z !== og.z) continue;
      const sum = g.r + g.tooth_h + og.r + og.tooth_h;
      if (((g.x - og.x) ** 2 + (g.y - og.y) ** 2) < sum * sum) return false;
    }

    computeRpm(g);

    // Deeper gears are darker.
    {
      const depth = g.z / pp.plane_displacement;
      let brightness = 1 + (depth / 6);
      const limit = 0.4;
      if (brightness < limit) brightness = limit;
      if (brightness > 1 / limit) brightness = 1 / limit;
      for (let k = 0; k < 3; k++) { g.color[k] *= brightness; g.color2[k] *= brightness; }
    }

    // Too-fast gears motion-blur (strobe) and wobble ("ride until the wheels fall off").
    {
      const ratio = g.ratio * config.spin;
      const blur_limit = 180.0 / g.nteeth;
      if (ratio > blur_limit) g.motion_blur_p = 1;
      if (!coaxialP) {
        if (ratio > blur_limit * 0.7) g.wobble += RND(2);
        if (ratio > blur_limit * 0.9) g.wobble += RND(2);
        if (ratio > blur_limit * 1.1) g.wobble += RND(2);
        if (ratio > blur_limit * 1.3) g.wobble += RND(2);
        if (ratio > blur_limit * 1.5) g.wobble += RND(2);
        if (ratio > blur_limit * 1.7) g.wobble += RND(2);
      }
    }
    return true;
  }

  function buildMesh(g) {
    g.colLin = toLin(g.color[0], g.color[1], g.color[2]);
    g.col2Lin = toLin(g.color2[0], g.color2[1], g.color2[2]);
    g.mesh = new THREE.Mesh(buildGearGeometry(g), material);
    g.mesh.matrixAutoUpdate = false;
    g.mesh.visible = false;
    gearsGroup.add(g.mesh);
  }

  function placeNewGear(parent, coaxialP) {
    let g = null;
    for (let loop = 0; loop < 100; loop++) {
      g = newGear(parent, coaxialP);
      if (placeGear(g, parent, coaxialP)) { pp.gears.push(g); buildMesh(g); return g; }
    }
    return null;
  }

  function deleteGear(g) {
    const i = pp.gears.indexOf(g);
    if (i < 0) return;
    pp.gears.splice(i, 1);
    if (g.mesh) { gearsGroup.remove(g.mesh); g.mesh.geometry.dispose(); g.mesh = null; }
  }

  function pushGear() {
    let parent = pp.gears.length <= 0 ? null : pp.gears[pp.gears.length - 1];
    let guard = 0;
    while (true) {   // labeled AGAIN loop (growth-zone reset)
      if (++guard > 100) return;   // doomed
      let g = null;
      let triedCoax = false, coaxialP = false;

      if (parent && parent.rpm > config.maxRpm) parent = null;   // ludicrous speed -> unhook
      if (pp.current_blur_length >= 10) parent = null;           // blurpocalypse -> bail

      if (parent && !parent.coax_p && RND(40) === 0) {   // sometimes try coaxial
        triedCoax = true; coaxialP = true;
        g = placeNewGear(parent, true);
      }
      if (!g) { coaxialP = false; g = placeNewGear(parent, false); }   // regular
      if (!g && !triedCoax && parent && !parent.coax_p) {              // coaxial fallback
        triedCoax = true; coaxialP = true;
        g = placeNewGear(parent, true);
      }
      if (!g) { coaxialP = false; parent = null; g = placeNewGear(null, false); }   // dead end -> new train

      if (!g) {
        // Backed into a corner: wipe gears still in the growth zone, retry.
        for (let i = pp.gears.length - 1; i >= 0; i--) {
          const gg = pp.gears[i];
          if (gg.x - gg.r - gg.tooth_h < pp.render_left) deleteGear(gg);
        }
        parent = pp.gears.length <= 0 ? null : pp.gears[pp.gears.length - 1];
        continue;
      }

      if (g.base_p) pp.current_length = 1; else pp.current_length++;
      if (g.motion_blur_p) pp.current_blur_length++; else pp.current_blur_length = 0;
      return;
    }
  }

  function scrollGears(dxFrames) {
    for (const g of pp.gears) g.x -= config.scroll * 0.002 * dxFrames;
    // delete gears off-screen to the left
    for (let i = pp.gears.length - 1; i >= 0; i--) {
      const g = pp.gears[i];
      if (g.x + g.r + g.tooth_h < pp.render_left) deleteGear(g);
    }
    // add gears until the layout zone is full
    let guard = 0;
    while (true) {
      const g = pp.gears.length <= 0 ? null : pp.gears[pp.gears.length - 1];
      if (!g || g.x + g.r + g.tooth_h < pp.layout_right) pushGear();
      else break;
      if (++guard > 200) break;
    }
  }

  function spinGears(dFrames) {
    for (const g of pp.gears) {
      const off = g.ratio * config.spin * dFrames;
      if (g.th > 0) g.th += off; else g.th -= off;
    }
  }

  // ffwd: pre-fill the train so the screen isn't blank at start.
  function ffwd() {
    let guard = 0;
    while (guard++ < 8000) {
      const g = farthestGear(true);
      if (g && g.x - g.r - g.tooth_h / 2 <= pp.vp_right * 0.88) break;
      scrollGears(1);
    }
  }

  reshapeZones();
  ffwd();

  // ---- per-gear matrix + visibility (draw_gear) ----
  const _m = new THREE.Matrix4(), _t = new THREE.Matrix4();
  function updateGearMesh(g, dFrames) {
    const visible = (g.x + g.r + g.tooth_h >= pp.render_left &&
                     g.x - g.r - g.tooth_h <= pp.render_right);
    g.mesh.visible = visible;
    if (!visible) return;
    let th;
    if (g.motion_blur_p) {   // strobe: jump ~half a tooth per original-frame
      th = g.motion_blur_p * 180.0 / g.nteeth * (g.th > 0 ? 1 : -1);
      g.motion_blur_p += dFrames;
    } else th = g.th;
    _m.makeTranslation(g.x, g.y, g.z);
    _m.multiply(_t.makeRotationZ(th * DEG));
    if (g.wobble) _m.multiply(_t.makeRotationX(g.wobble * DEG));
    g.mesh.matrix.copy(_m);
    g.mesh.matrixWorldNeedsUpdate = true;
  }

  // ---- sizing ----
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    reshapeZones();
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop ----
  let raf = 0, last = 0, paused = false, ms = 16;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;

    scrollGears(frames);
    spinGears(frames);
    material.wireframe = config.wire;
    for (const g of pp.gears) updateGearMesh(g, frames);

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  function reset() {
    for (const g of [...pp.gears]) deleteGear(g);
    pp.gears.length = 0;
    pp.current_length = 0; pp.current_blur_length = 0;
    idCounter = 0;
    reshapeZones();
    ffwd();
  }

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      for (const g of pp.gears) if (g.mesh) g.mesh.geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { reset(); },
    config,
    params,
  };
}

export default { title, info, start };
