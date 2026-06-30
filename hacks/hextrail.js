// hextrail.js -- "HexTrail" as a self-contained, mountable three.js module.
// start(hostCanvas, opts) -> { stop, pause, resume, getStats, reinit, config, params }.
//
// Faithful port of xscreensaver's hextrail (Jamie Zawinski, 2022),
// hacks/glx/hextrail.c. A network of colorful lines grows along the spokes of a
// hexagonal grid: a cell sprouts "arms" toward empty neighbors, each arm grows
// from the cell center out to an edge, hands the baton to the neighbor (which
// grows edge -> center), and that neighbor sprouts its own arms -- a connected,
// branching trail. Cells carry a slowly-drifting color from an 8-entry smooth
// colormap; a thin hexagon-outline "border" fades in around active cells; little
// blobs cap the junctions and dead-ends. When the field can no longer find an
// empty cell to seed, the whole thing fades out and a fresh plane begins.
//
// Self-contained three.js (own overlay canvas + renderer + loop), like
// dangerball.js / morph3d.js. RNG is yarandom.js, the slow spin/wander is
// rotator.js, the palette is colormap.js. No assets.
//
// FAITHFUL TO hextrail.c -- "do not deviate from the algorithm":
//   * make_plane: grid_w = count*2 (square grid), pointy-top hexagons at
//     pos=((x-w/2)*size, (y-h/2)*size*sqrt(3)/2) with odd rows shifted +size/2;
//     the exact 6-neighbor even/odd-row offset table; ccolor = random()%8 per
//     cell; an 8-entry make_smooth_colormap regenerated each plane.
//   * the per-arm EMPTY/IN/WAIT/OUT/DONE state machine (tick_hexagons): OUT grows
//     center->edge then DONEs and flips the neighbor's WAIT arm to IN; IN grows
//     edge->center then DONEs, decrements live_count and add_arms()es outward.
//   * add_arms(): target 1+(rand%4) (minus one when out_p), a random-order arm
//     traversal, propagate ccolor (1/5 chance to advance one), speed
//     0.05*speed*(0.8+frand), set the neighbor border IN.
//   * the border state machine incl. the deliberate OUT -> WAIT switch
//     fall-through (1/50 chance/frame to (re)start fading out; EMPTY's random
//     IN-trigger is commented out in the .c, so a border, once EMPTY, stays).
//   * the FIRST/DRAW/FADE cycle: seed center first, then up to grid/3 random
//     re-seeds whenever growth stalls; when none take, FADE (0.01*speed/frame)
//     and re-make_plane.
//   * draw_hexagons exactly: length=sqrt(3)/3, size=length/count, the thick2 =
//     thickness*fade line width, the corners[] hexagon, the border ring quad
//     (size1/size2), the center<->edge gradient line quad (cell color <-> the
//     average of this+neighbor color), and the center cap triangle (x2 size when
//     a lone arm). Submission order preserved (border, arm, cap per edge).
//   * view: gluPerspective(30) eye (0,0,30); modelview T(wander 6,6,12) *
//     trackball-reset-tilt * Rz(spin*360) * Scale(18) * portrait-fit s=(W<H?W/H:1).
//
// UNLIT: hextrail.c never glEnable(GL_LIGHTING) (its glMaterialfv calls are
// no-ops), so this is flat glColor geometry -- MeshBasicMaterial + per-vertex
// colors, no lights/normals. GL had DEPTH_TEST + CULL_FACE off, so we render
// DoubleSide with depthTest/Write off: triangles paint in submission order, as GL
// did. glColor [0,1] values are written RAW to the framebuffer: three's color
// management is disabled at module scope (matching GL's fixed pipeline, which does no
// sRGB encoding), so the .c's color math (fade/border scaling, neighbor averaging) runs
// in glColor space and that value IS the output -- no conversion.
//
// PACING (as in dangerball.js): render every rAF; the simulation ticks at the
// original cadence effFps = 1e6/(delay+OVERHEAD), OVERHEAD = 37500 (family
// default). Each tick is one full tick_hexagons() frame (growth + all the per-
// frame random events), so the RNG-driven structure is bit-faithful; geometry is
// rebuilt when a tick (or a live thickness/count change) dirties it. The slow
// spin/wander rotator is ticked at effFps and INTERPOLATED between ticks for a
// smooth glide at any frame rate.

import * as THREE from 'three';
import { makeYaRandom } from './yarandom.js';
import { makeRotator } from './rotator.js';
import { makeSmoothColormap } from './colormap.js';

// xscreensaver's GL fixed pipeline does NO color management -- it writes raw glColor
// values to the framebuffer (no sRGB encoding). Disable three's color management so the
// port matches GL: set at MODULE SCOPE so the renderer's output is not sRGB-encoded.
// (hextrail colors its vertices through the srgbToLinear() helper below, NOT three's
// setRGB, so that helper is also neutralized to an identity pass-through to keep glColor
// raw.) Without this, the flat unlit faces render shifted vs the original.
THREE.ColorManagement.enabled = false;

export const title = 'hextrail';

export const info = {
  author: 'Jamie Zawinski',
  year: 2022,
  description: 'A network of colorful lines grows upon a hexagonal substrate.',
};

// arm / border states (state_t).
const EMPTY = 0, IN = 1, WAIT = 2, OUT = 3, DONE = 4;
// FIRST/DRAW/FADE plane states.
const FIRST = 0, DRAW = 1, FADE = 2;

const NCOLORS = 8;                       // bp->ncolors
const H = 0.8660254037844386;            // sqrt(3)/2
// pointy-top hexagon corners (draw_hexagons corners[]); all at z=0.
const CORNERS = [
  [0, -1], [H, -0.5], [H, 0.5], [0, 1], [-H, 0.5], [-H, -0.5],
];

// Final per-vertex glColor mapping. three's color management is disabled at module scope
// (GL writes raw glColor, no sRGB encoding), so this is an IDENTITY pass-through, clamped
// to [0,1] as GL clamps glColor. (It was a real sRGB->linear conversion before the
// GL-fidelity color fix; kept as a function so the draw_hexagons call sites read unchanged.)
function srgbToLinear(c) {
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

// ---- the trackball-reset initial tilt (gltrackball_reset -> trackball(0,0,x,y)).
// The interactive trackball is screensaver chrome and omitted, but the .c bakes in
// a small random initial tilt of the whole field; we reproduce just that fixed
// rotation (computed once, never changes) so the perspective matches the original.
const TBSIZE = 0.8, M_SQRT1_2 = 0.7071067811865476, M_SQRT2 = 1.4142135623730951;
function tbProject(r, x, y) {
  const d = Math.sqrt(x * x + y * y);
  if (d < r * M_SQRT1_2) return Math.sqrt(r * r - d * d);   // inside sphere
  const t = r / M_SQRT2;                                    // on hyperbola
  return (t * t) / d;
}
function trackballQuat(p1x, p1y, p2x, p2y) {
  if (p1x === p2x && p1y === p2y) return new THREE.Quaternion(0, 0, 0, 1);
  const p1 = new THREE.Vector3(p1x, p1y, tbProject(TBSIZE, p1x, p1y));
  const p2 = new THREE.Vector3(p2x, p2y, tbProject(TBSIZE, p2x, p2y));
  const axis = new THREE.Vector3().crossVectors(p2, p1);    // a = p2 x p1
  const d = new THREE.Vector3().subVectors(p1, p2);
  let t = d.length() / (2.0 * TBSIZE);
  if (t > 1) t = 1; else if (t < -1) t = -1;
  const phi = 2.0 * Math.asin(t);
  if (axis.lengthSq() < 1e-20) return new THREE.Quaternion(0, 0, 0, 1);
  axis.normalize();
  return new THREE.Quaternion().setFromAxisAngle(axis, phi);
}

export function start(hostCanvas, opts = {}) {
  const OVERHEAD = 37500;     // us; xml default delay 30000 -> ~14.8fps (family default)
  const MAX_TICKS = 8;        // sim catch-up cap (avoids spiral after a stall)

  // Knobs transcribed 1:1 from hacks/config/hextrail.xml.
  const config = {
    delay: 30000,       // us, frame rate (xml default; invert slider)
    speed: 1.0,         // growth-rate multiplier (xml --speed)
    count: 20,          // grid_w = count*2; "Hexagon Size" (inverted slider)
    thickness: 0.15,    // line thickness (xml --thickness; clamped 0.05..0.5)
    wander: true,       // drift through space (do_wander)
    spin: true,         // slow in-plane spin (do_spin)
    wire: false,        // wireframe
  };
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.1, max: 20, step: 0.1, default: 1.0, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'count', label: 'Hexagon size', type: 'range', min: 2, max: 80, step: 1, default: 20, invert: true, lowLabel: 'small', highLabel: 'large', live: true },
    { key: 'thickness', label: 'Line thickness', type: 'range', min: 0.01, max: 0.5, step: 0.01, default: 0.15, lowLabel: 'thin', highLabel: 'thick', live: true },
    { key: 'wander', label: 'Wander', type: 'checkbox', default: true, live: true },
    { key: 'spin', label: 'Spin', type: 'checkbox', default: true, live: true },
    { key: 'wire', label: 'Wireframe', type: 'checkbox', default: false, live: true },
  ];

  const rng = makeYaRandom(opts.seed || 0);

  // make_rotator(spin .002 xyz, accel 1, wander .003, randomize=False). do_spin /
  // do_wander are gated at render time (live checkboxes), as in dangerball.js.
  const rot = makeRotator(
    { spinX: 0.002, spinY: 0.002, spinZ: 0.002, spinAccel: 1.0, wanderSpeed: 0.003, randomize: false },
    rng,
  );

  // init_hextrail's deliberate scene tilt: gltrackball_reset(-0.4+frand(0.8), ...).
  const tiltX = -0.4 + rng.frand(0.8);
  const tiltY = -0.4 + rng.frand(0.8);
  const tiltQ = trackballQuat(0, 0, tiltX, tiltY);

  // ===================================================================
  //  hex grid state
  // ===================================================================
  let gridW = 0, gridH = 0, ncells = 0;
  let hexagons = null;
  let cmap = null;            // 8 { r, g, b } in [0,1] (glColor space)
  let liveCount = 0;
  let state = FIRST;
  let fadeRatio = 1;

  const mkArm = () => ({ state: EMPTY, ratio: 0, speed: 0 });

  function emptyHexagonP(h) {
    for (let i = 0; i < 6; i++) if (h.arms[i].state !== EMPTY) return false;
    return true;
  }

  // make_plane: (re)allocate + clear the grid, a fresh colormap, positions,
  // per-cell ccolor, and the neighbor table. Does NOT touch state/fadeRatio (the
  // .c sets those in the caller).
  function makePlane() {
    gridW = (config.count | 0) * 2;
    gridH = gridW;
    ncells = gridW * gridH;

    if (!hexagons || hexagons.length !== ncells) {
      hexagons = new Array(ncells);
      for (let i = 0; i < ncells; i++)
        hexagons[i] = {
          x: 0, y: 0,
          neighbors: [null, null, null, null, null, null],
          arms: [mkArm(), mkArm(), mkArm(), mkArm(), mkArm(), mkArm()],
          ccolor: 0, border_state: EMPTY, border_ratio: 0,
        };
    } else {
      for (let i = 0; i < ncells; i++) {
        const h = hexagons[i];
        for (let j = 0; j < 6; j++) { const a = h.arms[j]; a.state = EMPTY; a.ratio = 0; a.speed = 0; h.neighbors[j] = null; }
        h.border_state = EMPTY; h.border_ratio = 0; h.ccolor = 0;
      }
    }
    liveCount = 0;

    cmap = makeSmoothColormap(rng, NCOLORS);   // make_smooth_colormap, 8 colors

    const size = 2.0 / gridW;
    const w = size, hh = size * Math.sqrt(3) / 2;
    for (let y = 0; y < gridH; y++)
      for (let x = 0; x < gridW; x++) {
        const h0 = hexagons[y * gridW + x];
        h0.x = (x - gridW / 2) * w;
        h0.y = (y - gridH / 2) * hh;
        h0.border_state = EMPTY;
        h0.border_ratio = 0;
        if (y & 1) h0.x += w / 2;
        h0.ccolor = rng.random() % NCOLORS;
      }

    // NEIGHBOR(I, even-x-offset, odd-x-offset, y-offset).
    for (let y = 0; y < gridH; y++)
      for (let x = 0; x < gridW; x++) {
        const h0 = hexagons[y * gridW + x];
        const setN = (I, xe, xo, dy) => {
          const x1 = x + ((y & 1) ? xo : xe);
          const y1 = y + dy;
          h0.neighbors[I] = (x1 >= 0 && x1 < gridW && y1 >= 0 && y1 < gridH)
            ? hexagons[y1 * gridW + x1] : null;
        };
        setN(0, 0, 1, -1);
        setN(1, 1, 1, 0);
        setN(2, 0, 1, 1);
        setN(3, -1, 0, 1);
        setN(4, -1, -1, 0);
        setN(5, -1, 0, -1);
      }

    ensureCapacity(ncells * 90);   // max 90 verts/cell (6 edges * (6 border + 6 line + 3 cap))
  }

  // add_arms: sprout up to `target` arms from h0 toward empty neighbors.
  function addArms(h0, outP) {
    let added = 0;
    let target = 1 + (rng.random() % 4);   // "Aim for 1-5" but actually 1-4

    const idx = [0, 1, 2, 3, 4, 5];        // traverse in random order
    for (let i = 0; i < 6; i++) {
      const j = rng.random() % 6;
      const sw = idx[j]; idx[j] = idx[i]; idx[i] = sw;
    }
    if (outP) target--;

    for (let i = 0; i < 6; i++) {
      const j = idx[i];
      const h1 = h0.neighbors[j];
      const a0 = h0.arms[j];
      if (!h1) continue;                    // no neighboring cell
      if (!emptyHexagonP(h1)) continue;     // occupado
      if (a0.state !== EMPTY) continue;     // arm already exists

      const a1 = h1.arms[(j + 3) % 6];      // opposite arm
      a0.state = outP ? OUT : IN;
      a1.state = WAIT;
      a0.ratio = 0; a1.ratio = 0;
      a0.speed = 0.05 * config.speed * (0.8 + rng.frand(1.0));
      a1.speed = a0.speed;

      if (h1.border_state === EMPTY) {
        h1.border_state = IN;
        h1.ccolor = h0.ccolor;              // mostly keep the same color
        if (!(rng.random() % 5)) h1.ccolor = (h0.ccolor + 1) % NCOLORS;
      }

      liveCount++;
      added++;
      if (added >= target) break;
    }
    return added;
  }

  // tick_hexagons: one original-frame of growth + the per-frame random events.
  function tickHexagons() {
    const sp = config.speed;

    for (let i = 0; i < ncells; i++) {
      const h0 = hexagons[i];

      // Enlarge any still-growing arms.
      for (let j = 0; j < 6; j++) {
        const a0 = h0.arms[j];
        if (a0.state === OUT) {
          a0.ratio += a0.speed;
          if (a0.ratio > 1) {
            // Finished center->edge; pass the baton to the waiting neighbor.
            const h1 = h0.neighbors[j];
            const a1 = h1.arms[(j + 3) % 6];
            a0.state = DONE; a0.ratio = 1;
            a1.state = IN; a1.ratio = 0; a1.speed = a0.speed;
          }
        } else if (a0.state === IN) {
          a0.ratio += a0.speed;
          if (a0.ratio > 1) {
            // Finished edge->center; look for exits.
            a0.state = DONE; a0.ratio = 1;
            liveCount--;
            addArms(h0, true);
          }
        }
        // EMPTY / WAIT / DONE: nothing.
      }

      // Border state machine. NOTE the OUT -> WAIT switch fall-through in the .c.
      const bs = h0.border_state;
      if (bs === IN) {
        h0.border_ratio += 0.05 * sp;
        if (h0.border_ratio >= 1) { h0.border_ratio = 1; h0.border_state = WAIT; }
      } else if (bs === OUT) {
        h0.border_ratio -= 0.05 * sp;
        if (h0.border_ratio <= 0) { h0.border_ratio = 0; h0.border_state = EMPTY; }
        if (!(rng.random() % 50)) h0.border_state = OUT;   // fall-through to WAIT
      } else if (bs === WAIT) {
        if (!(rng.random() % 50)) h0.border_state = OUT;
      }
      // EMPTY: the .c's random IN-trigger is commented out, so nothing.
    }

    // Start a new cell growing.
    if (liveCount <= 0) {
      const tries = Math.floor(ncells / 3);
      for (let i = 0; i < tries; i++) {
        let x, y;
        if (state === FIRST) {
          x = (gridW / 2) | 0; y = (gridH / 2) | 0;
          state = DRAW; fadeRatio = 1;
        } else {
          x = rng.random() % gridW; y = rng.random() % gridH;
        }
        const h0 = hexagons[y * gridW + x];
        if (emptyHexagonP(h0) && addArms(h0, true)) break;
      }
    }

    if (liveCount <= 0 && state !== FADE) {
      state = FADE; fadeRatio = 1;
      for (let i = 0; i < ncells; i++) {
        const h = hexagons[i];
        if (h.border_state === IN || h.border_state === WAIT) h.border_state = OUT;
      }
    } else if (state === FADE) {
      fadeRatio -= 0.01 * sp;
      if (fadeRatio <= 0) {
        makePlane();
        state = FIRST; fadeRatio = 1;
      }
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

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  // gluPerspective(30, aspect, 1, 100) + gluLookAt(0,0,30, 0,0,0, 0,1,0).
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 100);
  camera.position.set(0, 0, 30);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);

  // Unlit, flat glColor geometry. CULL_FACE + DEPTH_TEST were off in GL, so render
  // both sides with depth off -> painter order = submission order.
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });

  // modelview nesting (outer->inner): portrait-fit > wander > tilt > spinZ > scale18.
  const portraitG = new THREE.Group();
  const wanderG = new THREE.Group();
  const tiltG = new THREE.Group();
  const spinG = new THREE.Group();
  const scaleG = new THREE.Group();
  scaleG.scale.setScalar(18);
  tiltG.quaternion.copy(tiltQ);
  portraitG.add(wanderG); wanderG.add(tiltG); tiltG.add(spinG); spinG.add(scaleG);
  scene.add(portraitG);

  const geom = new THREE.BufferGeometry();
  let posArr = null, colArr = null, posAttr = null, colAttr = null;
  let vCount = 0;

  function ensureCapacity(maxVerts) {
    if (posArr && posArr.length >= maxVerts * 3) return;
    posArr = new Float32Array(maxVerts * 3);
    colArr = new Float32Array(maxVerts * 3);
    posAttr = new THREE.BufferAttribute(posArr, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
    colAttr = new THREE.BufferAttribute(colArr, 3); colAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', posAttr);
    geom.setAttribute('color', colAttr);
  }

  const mesh = new THREE.Mesh(geom, material);
  mesh.frustumCulled = false;
  scaleG.add(mesh);

  function vtx(vi, x, y, r, g, b) {
    const o = vi * 3;
    posArr[o] = x; posArr[o + 1] = y; posArr[o + 2] = 0;
    colArr[o] = r; colArr[o + 1] = g; colArr[o + 2] = b;
    return vi + 1;
  }
  function tri(vi, ax, ay, bx, by, cx, cy, r, g, b) {
    vi = vtx(vi, ax, ay, r, g, b);
    vi = vtx(vi, bx, by, r, g, b);
    vi = vtx(vi, cx, cy, r, g, b);
    return vi;
  }

  // draw_hexagons, transcribed. Color math done in glColor space and the per-vertex
  // color used RAW (colour management disabled -> GL-faithful framebuffer).
  function buildGeometry() {
    let vi = 0;
    const cnt = config.count | 0;
    const thickness = Math.max(0.05, Math.min(0.5, config.thickness));   // init clamp
    const drawSize = (Math.sqrt(3) / 3) / cnt;
    const thick2 = thickness * fadeRatio;
    const margin = thickness * 0.4;
    const size1 = drawSize * (1 - margin * 2);
    const size2 = drawSize * (1 - margin * 3);

    for (let ci = 0; ci < ncells; ci++) {
      const h = hexagons[ci];
      let totalArms = 0;
      for (let j = 0; j < 6; j++) { const s = h.arms[j].state; if (s === OUT || s === DONE) totalArms++; }

      const cc = cmap[h.ccolor];
      const cr = cc.r * fadeRatio, cg = cc.g * fadeRatio, cb = cc.b * fadeRatio;   // faded cell color
      const lr = srgbToLinear(cr), lg = srgbToLinear(cg), lb = srgbToLinear(cb);

      for (let j = 0; j < 6; j++) {
        const k = (j + 1) % 6;
        const a = h.arms[j];
        const cjx = CORNERS[j][0], cjy = CORNERS[j][1];
        const ckx = CORNERS[k][0], cky = CORNERS[k][1];

        // (A) Hexagon border ring segment.
        if (h.border_state !== EMPTY) {
          const br = h.border_ratio;
          const r = srgbToLinear(cr * br), g = srgbToLinear(cg * br), b = srgbToLinear(cb * br);
          const p0x = h.x + cjx * size1, p0y = h.y + cjy * size1;
          const p1x = h.x + ckx * size1, p1y = h.y + cky * size1;
          const p2x = h.x + ckx * size2, p2y = h.y + cky * size2;
          const p3x = h.x + cjx * size2, p3y = h.y + cjy * size2;
          vi = tri(vi, p0x, p0y, p1x, p1y, p2x, p2y, r, g, b);
          vi = tri(vi, p2x, p2y, p3x, p3y, p0x, p0y, r, g, b);
        }

        // (B) Line from center to edge, or edge to center.
        if (a.state === IN || a.state === OUT || a.state === DONE) {
          const x = (cjx + ckx) / 2, y = (cjy + cky) / 2;       // radial direction
          const xoff = ckx - cjx, yoff = cky - cjy;             // tangential (thickness)
          const ll = a.ratio;
          // outer point color = average of this and the neighbor cell color.
          const nb = h.neighbors[j];
          const ncc = cmap[nb.ccolor];
          const ncr = (ncc.r * fadeRatio + cr) / 2;
          const ncg = (ncc.g * fadeRatio + cg) / 2;
          const ncb = (ncc.b * fadeRatio + cb) / 2;
          let start, end, c1r, c1g, c1b, c2r, c2g, c2b;
          if (a.state === OUT) {
            start = 0; end = drawSize * ll;
            c1r = cr; c1g = cg; c1b = cb; c2r = ncr; c2g = ncg; c2b = ncb;
          } else {
            start = drawSize; end = drawSize * (1 - ll);
            c1r = ncr; c1g = ncg; c1b = ncb; c2r = cr; c2g = cg; c2b = cb;
          }
          const off = size2 * thick2;
          const p0x = h.x + xoff * off + x * start, p0y = h.y + yoff * off + y * start;
          const p1x = h.x - xoff * off + x * start, p1y = h.y - yoff * off + y * start;
          const p2x = h.x - xoff * off + x * end, p2y = h.y - yoff * off + y * end;
          const p3x = h.x + xoff * off + x * end, p3y = h.y + yoff * off + y * end;
          const l1r = srgbToLinear(c1r), l1g = srgbToLinear(c1g), l1b = srgbToLinear(c1b);
          const l2r = srgbToLinear(c2r), l2g = srgbToLinear(c2g), l2b = srgbToLinear(c2b);
          // tri1: p3(c2) p0(c1) p1(c1); tri2: p1(c1) p2(c2) p3(c2).
          vi = vtx(vi, p3x, p3y, l2r, l2g, l2b);
          vi = vtx(vi, p0x, p0y, l1r, l1g, l1b);
          vi = vtx(vi, p1x, p1y, l1r, l1g, l1b);
          vi = vtx(vi, p1x, p1y, l1r, l1g, l1b);
          vi = vtx(vi, p2x, p2y, l2r, l2g, l2b);
          vi = vtx(vi, p3x, p3y, l2r, l2g, l2b);
        }

        // (C) Center cap triangle (hides line miters; bigger for a lone arm).
        if (totalArms) {
          let size3 = drawSize * thick2 * 0.8;
          if (totalArms === 1) size3 *= 2;
          const p1x = h.x + cjx * size3, p1y = h.y + cjy * size3;
          const p2x = h.x + ckx * size3, p2y = h.y + cky * size3;
          vi = tri(vi, h.x, h.y, p1x, p1y, p2x, p2y, lr, lg, lb);
        }
      }
    }

    vCount = vi;
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    geom.setDrawRange(0, vCount);
  }

  // ---- rotator sampling + interpolation (slow spin/wander random-walk) ----
  let prevZ = rot.getRotation(false).z, curZ = prevZ;
  let prevP = rot.getPosition(false), curP = { ...prevP };
  function tickRotator() {
    prevZ = curZ; curZ = rot.getRotation(true).z;
    prevP = curP; curP = rot.getPosition(true);
  }
  function lerpAngle(aa, bb, t) {       // shortest path on the [0,1) rotation circle
    let d = bb - aa;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    return aa + d * t;
  }
  const lerp = (aa, bb, t) => aa + (bb - aa) * t;

  // ---- init (init_hextrail order: rotator, tilt, then make_plane) ----
  let curCount = config.count | 0;
  makePlane();
  state = FIRST; fadeRatio = 1;

  // ---- sizing (reshape_hextrail: gluPerspective + portrait-fit scale) ----
  function syncSize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    portraitG.scale.setScalar(w < h ? w / h : 1);   // glScalef(s,s,s)
  }
  syncSize();
  window.addEventListener('resize', syncSize);

  // ---- render loop ----
  let raf = 0, last = 0, paused = false, ms = 16;
  let tickAccum = 0, geomDirty = true, lastThickness = config.thickness;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!last) { last = now; return; }
    const frame = now - last;
    last = now;
    ms += (frame - ms) * 0.1;
    if (paused) return;

    // Live "Hexagon Size" change -> rebuild the plane and restart (handle_event RESET).
    const wantCount = Math.max(2, Math.min(80, Math.round(config.count)));
    if (wantCount !== curCount) {
      config.count = wantCount; curCount = wantCount;
      makePlane(); state = FIRST; fadeRatio = 1;
      geomDirty = true;
    }

    const dt = Math.min(frame / 1000, 0.25);
    const effFps = 1e6 / (config.delay + OVERHEAD);
    const frames = dt * effFps;

    // Tick the simulation + rotator at the original cadence.
    tickAccum += frames;
    let ticks = 0;
    while (tickAccum >= 1 && ticks < MAX_TICKS) {
      tickHexagons();
      tickRotator();
      tickAccum -= 1; ticks++;
      geomDirty = true;
    }
    if (ticks === MAX_TICKS) tickAccum = 0;
    const a = tickAccum;   // [0,1) interpolation fraction

    if (config.thickness !== lastThickness) { lastThickness = config.thickness; geomDirty = true; }
    if (geomDirty) { buildGeometry(); geomDirty = false; }

    // Camera (interpolated rotator): only the Z (in-plane) rotation is used.
    spinG.rotation.z = config.spin ? lerpAngle(prevZ, curZ, a) * 2 * Math.PI : 0;
    if (config.wander) {
      wanderG.position.set(
        (lerp(prevP.x, curP.x, a) - 0.5) * 6,
        (lerp(prevP.y, curP.y, a) - 0.5) * 6,
        (lerp(prevP.z, curP.z, a) - 0.5) * 12,
      );
    } else wanderG.position.set(0, 0, 0);
    material.wireframe = config.wire;

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(tick);

  return {
    stop() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', syncSize);
      geom.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
    pause() { paused = true; },
    resume() { last = 0; paused = false; },
    getStats() { return { ms, scale: 1, w: canvas.width, h: canvas.height }; },
    reinit() { makePlane(); state = FIRST; fadeRatio = 1; geomDirty = true; },   // fresh plane (host 're-seed')
    config,
    params,
  };
}

export default { title, info, start };
