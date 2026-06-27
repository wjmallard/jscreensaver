// host.js — the jscreensaver host controller.
// Owns the one shared <canvas> and mounts/unmounts hack modules onto it; drives
// the picker, the polymorphic config box, the about/help pop-overs, the
// frame-time meter, the keyboard command router, and hash routing. Loaded as a
// module by index.html (chrome markup there, chrome styles in host.css).

import { renderConfig } from './config-box.js';
import { CATEGORIES, DIMENSIONS, classify } from './taxonomy.js';
import * as squiral from './hacks/squiral.js';
import * as coral from './hacks/coral.js';
import * as cloudlife from './hacks/cloudlife.js';
import * as demon from './hacks/demon.js';
import * as petri from './hacks/petri.js';
import * as ant from './hacks/ant.js';
import * as sierpinski from './hacks/sierpinski.js';
import * as binaryring from './hacks/binaryring.js';
import * as braid from './hacks/braid.js';
import * as boxfit from './hacks/boxfit.js';
import * as galaxy from './hacks/galaxy.js';
import * as grav from './hacks/grav.js';
import * as pyro from './hacks/pyro.js';
import * as thornbird from './hacks/thornbird.js';
import * as spiral from './hacks/spiral.js';
import * as xspirograph from './hacks/xspirograph.js';
import * as hopalong from './hacks/hopalong.js';
import * as greynetic from './hacks/greynetic.js';
import * as kumppa from './hacks/kumppa.js';
import * as halftone from './hacks/halftone.js';
import * as imsmap from './hacks/imsmap.js';
import * as interaggregate from './hacks/interaggregate.js';
import * as interference from './hacks/interference.js';
import * as metaballs from './hacks/metaballs.js';
import * as piecewise from './hacks/piecewise.js';
import * as halo from './hacks/halo.js';
import * as moire from './hacks/moire.js';
import * as qix from './hacks/qix.js';
import * as truchet from './hacks/truchet.js';
import * as helix from './hacks/helix.js';
import * as moire2 from './hacks/moire2.js';
import * as penrose from './hacks/penrose.js';
import * as scooter from './hacks/scooter.js';
import * as strange from './hacks/strange.js';
import * as loop from './hacks/loop.js';
import * as vermiculate from './hacks/vermiculate.js';
import * as binaryhorizon from './hacks/binaryhorizon.js';
import * as cynosure from './hacks/cynosure.js';
import * as deco from './hacks/deco.js';
import * as fadeplot from './hacks/fadeplot.js';
import * as popsquares from './hacks/popsquares.js';
import * as rorschach from './hacks/rorschach.js';
import * as bouboule from './hacks/bouboule.js';
import * as cwaves from './hacks/cwaves.js';
import * as fiberlamp from './hacks/fiberlamp.js';
import * as mountain from './hacks/mountain.js';
import * as munch from './hacks/munch.js';
import * as pedal from './hacks/pedal.js';
import * as wander from './hacks/wander.js';
import * as whirlwindwarp from './hacks/whirlwindwarp.js';
import * as fluidballs from './hacks/fluidballs.js';
import * as ifs from './hacks/ifs.js';
import * as attraction from './hacks/attraction.js';
import * as euler2d from './hacks/euler2d.js';
import * as eruption from './hacks/eruption.js';
import * as flame from './hacks/flame.js';
import * as hexadrop from './hacks/hexadrop.js';
import * as intermomentary from './hacks/intermomentary.js';
import * as apollonian from './hacks/apollonian.js';
import * as ccurve from './hacks/ccurve.js';
import * as drift from './hacks/drift.js';
import * as wormhole from './hacks/wormhole.js';
import * as nerverot from './hacks/nerverot.js';
import * as rocks from './hacks/rocks.js';
// 2D wave 3 (un-requested portable tail, batch 1) — curves/particles/growth/attractor.
import * as discrete from './hacks/discrete.js';
import * as epicycle from './hacks/epicycle.js';
import * as fireworkx from './hacks/fireworkx.js';
import * as forest from './hacks/forest.js';
import * as lissie from './hacks/lissie.js';
import * as rotor from './hacks/rotor.js';
import * as sphere from './hacks/sphere.js';
import * as triangle from './hacks/triangle.js';
import * as vines from './hacks/vines.js';
import * as xflame from './hacks/xflame.js';

// 2D wave 3 (un-requested portable tail, batch 2) — curve plotters, attractors,
// and the first per-pixel set (julia/swirl/shadebobs are retina-downscaled).
import * as compass from './hacks/compass.js';
import * as critical from './hacks/critical.js';
import * as flow from './hacks/flow.js';
// julia: SHELVED 2026-06-25 pending perf optimization (per-pixel escape-time field too slow); .js kept, re-add import + HACKS entry to restore.
import * as laser from './hacks/laser.js';
import * as lisa from './hacks/lisa.js';
import * as lmorph from './hacks/lmorph.js';
// shadebobs: SHELVED 2026-06-25 pending perf optimization (accumulation field clunky/jumpy); .js kept, re-add import + HACKS entry to restore.
import * as swirl from './hacks/swirl.js';
import * as worm from './hacks/worm.js';

// 2D wave 3 (un-requested portable tail, batches 3+4) — 4D wireframes, particle
// swarms, spline blobs, grid tilings, and per-pixel fields (rdbomb/xlyap downscaled).
import * as abstractile from './hacks/abstractile.js';
import * as anemone from './hacks/anemone.js';
import * as anemotaxis from './hacks/anemotaxis.js';
import * as bubbles from './hacks/bubbles.js';
import * as celtic from './hacks/celtic.js';
import * as crystal from './hacks/crystal.js';
import * as deluxe from './hacks/deluxe.js';
import * as fuzzyflakes from './hacks/fuzzyflakes.js';
import * as goop from './hacks/goop.js';
import * as hyperball from './hacks/hyperball.js';
import * as hypercube from './hacks/hypercube.js';
import * as lightning from './hacks/lightning.js';
import * as polyominoes from './hacks/polyominoes.js';
import * as rdbomb from './hacks/rdbomb.js';
import * as starfish from './hacks/starfish.js';
import * as substrate from './hacks/substrate.js';
import * as whirlygig from './hacks/whirlygig.js';
import * as xlyap from './hacks/xlyap.js';
import * as xrayswarm from './hacks/xrayswarm.js';

// Un-shelved 2026-06-26 after a perf fix: vfeedback caps its backing-store
// resolution so the per-frame hue-rotate feedback pass is affordable (see .md).
import * as vfeedback from './hacks/vfeedback.js';

// --- 3D / WebGL shader hacks (run via the shared ./hacks/shadertoy.js harness;
//     each overlays its own webgl2 canvas over the host canvas, removed on stop) ---
import * as batteredplanet from './hacks/batteredplanet.js';
import * as darktransit from './hacks/darktransit.js';
import * as downfall from './hacks/downfall.js';
import * as driftclouds from './hacks/driftclouds.js';
import * as elementalring from './hacks/elementalring.js';
import * as gimbalharmonics from './hacks/gimbalharmonics.js';
import * as goldenapollian from './hacks/goldenapollian.js';
import * as hexplasma from './hacks/hexplasma.js';
import * as logarithmiccircles from './hacks/logarithmiccircles.js';
import * as neongravity from './hacks/neongravity.js';
import * as neontriangulator from './hacks/neontriangulator.js';
import * as noxfire from './hacks/noxfire.js';
import * as prococean from './hacks/prococean.js';
import * as protophore from './hacks/protophore.js';
import * as selfreflect from './hacks/selfreflect.js';
import * as skyline from './hacks/skyline.js';
import * as stardome from './hacks/stardome.js';
import * as starnest from './hacks/starnest.js';
import * as stripeytorus from './hacks/stripeytorus.js';
import * as synthwavecity from './hacks/synthwavecity.js';
import * as topologica from './hacks/topologica.js';
import * as trainmandala from './hacks/trainmandala.js';
import * as trizm from './hacks/trizm.js';
import * as truchetzoom from './hacks/truchetzoom.js';
// NTSC television simulation via the shared ./hacks/analogtv.glsl.js harness (a
// faithful WebGL port of xscreensaver's analogtv.c); overlays its own webgl2
// canvas like the shadertoy hacks above.
import * as xanalogtv from './hacks/xanalogtv.js';
// three.js geometry hacks (no-build, via the 'three' importmap in index.html);
// self-contained -- each overlays its own WebGLRenderer canvas like the GL hacks
// above, and exposes getStats() so the picker treats it as 3D.
import * as dangerball from './hacks/dangerball.js';
import * as cubicgrid from './hacks/cubicgrid.js';
// GPU-heavy tier (info.heavy → red dot in the picker); kept in hacks/shelved/,
// imported in place so each module's own '../shadertoy.js' import still resolves.
import * as alienbeacon from './hacks/shelved/alienbeacon.js';
import * as bestill from './hacks/shelved/bestill.js';
import * as bubblecolors from './hacks/shelved/bubblecolors.js';
import * as fluxcore from './hacks/shelved/fluxcore.js';
import * as rigrekt from './hacks/shelved/rigrekt.js';
import * as universeball from './hacks/shelved/universeball.js';

// Alphabetical — the order shown in the picker and the ← → cycle order.
const HACKS = [squiral, coral, cloudlife, demon, petri, ant, sierpinski, binaryring, braid, boxfit, galaxy, grav, pyro, thornbird, spiral, xspirograph, hopalong, greynetic, kumppa, halftone, imsmap, interaggregate, interference, metaballs, piecewise, halo, moire, qix, truchet, helix, moire2, penrose, scooter, strange, loop, vermiculate, binaryhorizon, cynosure, deco, fadeplot, popsquares, rorschach, bouboule, cwaves, fiberlamp, mountain, munch, pedal, wander, whirlwindwarp, fluidballs, ifs, attraction, euler2d, eruption, flame, hexadrop, intermomentary, apollonian, ccurve, drift, wormhole, nerverot, rocks, discrete, epicycle, fireworkx, forest, lissie, rotor, sphere, triangle, vines, xflame, compass, critical, flow, laser, lisa, lmorph, swirl, worm, abstractile, anemone, anemotaxis, bubbles, celtic, crystal, deluxe, fuzzyflakes, goop, hyperball, hypercube, lightning, polyominoes, rdbomb, starfish, substrate, whirlygig, xlyap, xrayswarm, vfeedback, batteredplanet, darktransit, downfall, driftclouds, elementalring, gimbalharmonics, goldenapollian, hexplasma, logarithmiccircles, neongravity, neontriangulator, noxfire, prococean, protophore, selfreflect, skyline, stardome, starnest, stripeytorus, synthwavecity, topologica, trainmandala, trizm, truchetzoom, xanalogtv, dangerball, cubicgrid, alienbeacon, bestill, bubblecolors, fluxcore, rigrekt, universeball].sort((a, b) => a.title.localeCompare(b.title));
const byName = Object.fromEntries(HACKS.map((h) => [h.title, h]));

const canvas = document.getElementById('c');
const selector = document.getElementById('selector');
const configBox = document.getElementById('config');
const about = document.getElementById('about');
const help = document.getElementById('help');
const infoBox = document.getElementById('info');
const list = document.getElementById('sel-list');
const cats = document.getElementById('sel-cats');
const selMain = document.getElementById('sel-main');
const catHead = document.getElementById('sel-cat-head');
const dim2d = document.getElementById('dim-2d');
const dim3d = document.getElementById('dim-3d');
const title = document.getElementById('sel-title');
const fps = document.getElementById('fps');
const hackName = document.getElementById('hackname');
const bar = document.getElementById('bar');
const hint = document.getElementById('hint');

// Picker taxonomy: a left rail of genres (plus "All") filters the hack list on
// the right; an optional 2D/3D dimension filter narrows it further. The rail
// shows each genre's brief label; the detail header shows its full name. The
// per-row dimension badge appears only when the visible list actually mixes 2D
// and 3D hacks (so an all-2D genre stays uncluttered); GPU-heavy GL hacks also
// carry a red "GPU-intensive" dot driven by their module's info.heavy flag.
const RAIL = ['All', ...CATEGORIES.map((c) => c.key)];
const CAT_BY_KEY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));
// Rail shows each key's brief label, the detail header its full name ("All" is
// literal in both).
const railBrief = (k) => (k === 'All' ? 'All' : CAT_BY_KEY[k].brief);
const railFull = (k) => (k === 'All' ? 'All' : CAT_BY_KEY[k].full);

let currentName = null;   // null = nothing running (black landing)
let handle = null;        // running hack's teardown handle
let paused = false;       // 'p' toggles the running hack's loop on/off
let fadeTimer = 0;        // setTimeout id for the between-hack fade-out
let catIndex = 0;         // focused rail entry (0 = All)
let show2d = true;        // 2D filter checkbox (default on)
let show3d = false;       // 3D filter checkbox (default off)
let visible = [];         // hacks currently shown in the list (filtered)
let cursorIndex = 0;      // keyboard-highlighted row in the list
let focusPane = 'list';   // which pane the keyboard drives: 'rail' | 'list'
let cycleCat = 'All';     // genre that view-mode left/right cycling stays within

function render() {
  const open = selector.classList.contains('open');
  for (let i = 0; i < list.children.length; i++) {
    const li = list.children[i];
    if (!li.dataset.hack) continue;            // skip the "none" placeholder
    li.classList.toggle('active', li.dataset.hack === currentName);
    li.classList.toggle('cursor', i === cursorIndex && open);
  }
  for (let i = 0; i < cats.children.length; i++) {
    cats.children[i].classList.toggle('cursor', i === catIndex);
  }
}

// Abort any in-progress between-hack fade and restore the canvas to full opacity.
const FADE_MS = 400;
function cancelFade() {
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = 0; }
  canvas.style.transition = 'none';
  canvas.style.opacity = '1';
}

// The corner hack-name (#hackname) is a transient label: it flashes on each
// mount / return-to-view, holds briefly, then fades out so the running hack is
// unobstructed. It's a pure label (not clickable — info lives in the footer and
// the touch control bar), and stays hidden while the picker is open. flashTitle
// is a no-op when nothing's running or the picker is up; closeSelector re-arms
// it on the way back to view.
const TITLE_HOLD_MS = 2000, TITLE_FADE_MS = 1000;
let titleTimer = 0;
function flashTitle() {
  if (titleTimer) { clearTimeout(titleTimer); titleTimer = 0; }
  if (!currentName || selector.classList.contains('open')) { hideTitle(); return; }
  hackName.hidden = false;
  hackName.style.transition = 'none';
  hackName.style.opacity = '1';
  void hackName.offsetWidth;                 // commit opacity:1 before arming the fade
  titleTimer = setTimeout(() => {
    titleTimer = 0;
    hackName.style.transition = `opacity ${TITLE_FADE_MS}ms linear`;
    hackName.style.opacity = '0';
  }, TITLE_HOLD_MS);
  maybeShowHint();
}
function hideTitle() {
  if (titleTimer) { clearTimeout(titleTimer); titleTimer = 0; }
  hackName.style.transition = 'none';
  hackName.style.opacity = '0';
  hackName.hidden = true;
}

// Swap hacks. When leaving a 2D hack on screen, fade its (frozen) last frame
// to black via canvas opacity, then start the new hack on the freshly-cleared
// canvas at full opacity — no fade-IN, since the new hack builds up from black
// on its own (xscreensaver's symmetric gamma fade-in is wasted on that). The
// first mount from the black landing has nothing to fade, so it starts at once.
function mount(name) {
  if (!byName[name] || name === currentName) return;
  const wasRunning = !!handle;
  const wasGL = !!(handle && handle.getStats);   // 3D renders to its own overlay (removed on stop), not #c
  cancelFade();
  if (handle) { handle.stop(); handle = null; }
  currentName = name;
  paused = false;
  hackName.textContent = name;
  flashTitle();
  if (location.hash.slice(1) !== name) location.hash = name;
  render();

  const startHack = () => {
    fadeTimer = 0;
    canvas.style.transition = 'none';   // snap back to full opacity, no fade-in
    canvas.style.opacity = '1';
    handle = byName[name].start(canvas);
  };

  // The fade animates the SHARED 2D host canvas (#c), where 2D hacks draw. A 3D
  // hack renders to its OWN overlay canvas that stop() just removed, so #c still
  // shows the LAST 2D frame underneath — fading when leaving a 3D hack only
  // flashes that stale frame (seen when cycling 3D->3D). So fade just when leaving
  // a 2D hack; otherwise (leaving a 3D hack, or first mount) clear #c and cut in.
  if (wasRunning && !wasGL) {
    canvas.style.transition = `opacity ${FADE_MS}ms linear`;
    void canvas.offsetWidth;             // force reflow so the fade starts from 1
    canvas.style.opacity = '0';
    fadeTimer = setTimeout(startHack, FADE_MS);
  } else {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    startHack();
  }
}

// View-mode left/right cycle within the genre the current hack was chosen from
// (cycleCat; "All" cycles everything), falling back to All (which always has it).
function cyclePool() {
  let pool = categoryPool(cycleCat);
  if (!pool.some((h) => h.title === currentName)) pool = categoryPool('All');
  return pool;
}
function cycle(dir) {
  if (!currentName) return;
  const pool = cyclePool();
  const i = pool.findIndex((h) => h.title === currentName);
  if (i < 0 || !pool.length) return;
  mount(pool[(i + dir + pool.length) % pool.length].title);
}

// Re-seed the current hack for a fresh pattern. Hacks that expose reinit
// (e.g. squiral) keep their settings; the rest are simply re-mounted.
function restart() {
  if (!currentName || !handle) return;
  if (handle.reinit) handle.reinit();
  else { handle.stop(); handle = byName[currentName].start(canvas); }
  if (paused) { paused = false; handle.resume?.(); }   // 'r' always un-pauses
}

// Freeze / resume the running hack's animation loop. Resets its pacing on
// resume so there's no catch-up burst. No-op for a hack without pause/resume.
function togglePause() {
  if (!handle) return;
  paused = !paused;
  if (paused) handle.pause?.(); else handle.resume?.();
}

// Clear / home: stop the hack, drop the hash, clear to black, and hold the
// picker open (non-dismissable, since there's nothing to return to).
function goHome() {
  closeConfig(); closeAbout(); closeHelp(); closeInfo();
  cancelFade();
  if (handle) { handle.stop(); handle = null; }
  currentName = null;
  hideTitle();
  history.replaceState(null, '', location.pathname + location.search);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  openSelector();
}

// Hacks in a genre ("All" = every genre), honoring the dimension filter. HACKS
// is pre-sorted alphabetically, so each slice stays alphabetical.
function categoryPool(cat) {
  return HACKS.filter((h) => {
    const t = classify(h.title);
    if (cat !== 'All' && !t.categories.includes(cat)) return false;
    if (t.dimension === '2d' && !show2d) return false;
    if (t.dimension === '3d' && !show3d) return false;
    return true;
  });
}

function computeVisible() {
  visible = categoryPool(RAIL[catIndex]);
}

function renderRailCounts() {
  for (const li of cats.children) {
    li.querySelector('.cat-count').textContent = categoryPool(li.dataset.cat).length;
  }
}

// One rail row per genre (short label + live count). Built once.
function buildRail() {
  cats.textContent = '';
  RAIL.forEach((name, i) => {
    const li = document.createElement('li');
    li.dataset.cat = name;
    const label = document.createElement('span');
    label.className = 'cat-name';
    label.textContent = railBrief(name);
    const count = document.createElement('span');
    count.className = 'cat-count';
    li.append(label, count);
    li.addEventListener('click', () => { setCategory(i); setFocus('rail'); });
    cats.appendChild(li);
  });
  renderRailCounts();
}

// Rebuild the right-hand hack list for the focused genre + filter.
function buildList() {
  computeVisible();
  catHead.textContent = railFull(RAIL[catIndex]);
  const mixed = new Set(visible.map((h) => classify(h.title).dimension)).size > 1;
  list.textContent = '';
  if (!visible.length) {
    const li = document.createElement('li');
    li.className = 'sel-empty';
    li.textContent = '\u2014 none \u2014';
    list.appendChild(li);
  } else {
    for (const h of visible) {
      const li = document.createElement('li');
      li.dataset.hack = h.title;
      if (mixed) {
        const badge = document.createElement('span');
        badge.className = 'sel-badge';
        badge.textContent = DIMENSIONS[classify(h.title).dimension].glyph;
        li.appendChild(badge);
      }
      const label = document.createElement('span');
      label.textContent = h.title;
      li.appendChild(label);
      if (byName[h.title].info?.heavy) {           // GPU-intensive: trailing red dot
        const heavy = document.createElement('span');
        heavy.className = 'sel-heavy';
        heavy.textContent = '\u25CF';            // black circle
        heavy.title = 'GPU-intensive';
        li.appendChild(heavy);
      }
      li.addEventListener('click', () => { cycleCat = RAIL[catIndex]; mount(h.title); closeSelector(); });
      list.appendChild(li);
    }
  }
  cursorIndex = Math.max(0, Math.min(cursorIndex, visible.length - 1));
  render();
}

function setCategory(i) {
  catIndex = (i + RAIL.length) % RAIL.length;
  cursorIndex = 0;
  buildList();
  list.scrollTop = 0;
}

// 2D/3D checkboxes: refilter the rail counts and the list to the checked
// dimensions, then hand keyboard control back to the picker.
function applyDimFilter(e) {
  show2d = dim2d.checked;
  show3d = dim3d.checked;
  cursorIndex = 0;
  renderRailCounts();
  buildList();
  list.scrollTop = 0;
  e?.target?.blur();
}

// Left/right arrows move keyboard focus between the genre rail and the hack
// list; the focused pane shows a strong cursor, the other a muted one.
function setFocus(pane) {
  focusPane = pane;
  selMain.classList.toggle('focus-rail', pane === 'rail');
  selMain.classList.toggle('focus-list', pane === 'list');
  if (pane === 'list') list.children[cursorIndex]?.scrollIntoView({ block: 'nearest' });
}

// The per-hack footer actions (info/config/restart/fps) and clear are no-ops with
// nothing running; dim them (and drop their hover) so a dead click isn't invited.
// random stays live — it picks a hack from the landing too. The footer only shows
// via openSelector, and "clear" re-routes through it, so syncing here covers every
// visible transition.
function syncFooter() {
  const running = !!currentName;
  for (const id of ['sel-info', 'sel-config', 'sel-restart', 'sel-fps', 'sel-clear']) {
    document.getElementById(id).classList.toggle('disabled', !running);
  }
}

function openSelector() {
  selector.classList.add('open');
  hideTitle();                       // the title stays hidden while the picker is up
  hideBar();                         // ...and so is the touch control bar
  // Keep the rail on the last-browsed genre — catIndex persists across opens, so
  // e.g. "random" from All keeps landing in All instead of being dragged into
  // whatever genre the last pick happened to belong to. Just drop the cursor on
  // the running hack when it falls in that genre's list, else the top.
  buildList();
  const idx = currentName ? visible.findIndex((h) => h.title === currentName) : -1;
  cursorIndex = idx >= 0 ? idx : 0;
  render();
  setFocus('list');
  syncFooter();
}

function closeSelector() {
  if (!currentName) return;                       // nothing running — keep it up
  if (!selector.classList.contains('open')) return;
  selector.classList.remove('open');
  flashTitle();                      // back to view: re-announce the running hack, then fade
}

function moveCursor(delta) {
  if (!visible.length) return;
  const n = visible.length;
  cursorIndex = (cursorIndex + delta + n) % n;
  render();
  list.children[cursorIndex]?.scrollIntoView({ block: 'nearest' });
}

function moveCategory(delta) {
  setCategory(catIndex + delta);
}

function commitCursor() {
  if (!visible.length) return;
  cycleCat = RAIL[catIndex];                       // remember the browsed genre
  mount(visible[cursorIndex].title);
  closeSelector();
}

// "random" footer action: jump to a random hack in the focused genre ("All" =
// the whole library), excluding the current one. Mirrors a commit (mounts the
// pick and closes the picker).
function pickRandom() {
  let pool = categoryPool(RAIL[catIndex]).filter((h) => h.title !== currentName);
  if (!pool.length) pool = categoryPool(RAIL[catIndex]);
  if (!pool.length) return;
  cycleCat = RAIL[catIndex];
  mount(pool[Math.floor(Math.random() * pool.length)].title);
  closeSelector();
}

// Config / About / Help / Info are mutually exclusive pop-overs; the config and
// info boxes are populated polymorphically from whatever hack is running.
function openConfig() {
  closeAbout(); closeHelp(); closeInfo();
  const ttl = document.getElementById('config-title');
  const body = document.getElementById('config-body');
  if (handle && handle.params) {
    ttl.textContent = currentName;
    renderConfig(body, { config: handle.config, params: handle.params, onReinit: handle.reinit });
  } else {
    ttl.textContent = currentName || 'configure';
    body.innerHTML = '<div class="config-empty">nothing to configure</div>';
  }
  configBox.classList.add('open');
}
function closeConfig() { configBox.classList.remove('open'); }
function openAbout() { closeConfig(); closeHelp(); closeInfo(); about.classList.add('open'); }
function closeAbout() { about.classList.remove('open'); }
function openHelp() { closeConfig(); closeAbout(); closeInfo(); help.classList.add('open'); }
function closeHelp() { help.classList.remove('open'); }

// Info box: the running hack's author / year / description (its module's `info`
// export), shown read-only.
function openInfo() {
  closeConfig(); closeAbout(); closeHelp();
  const ttl = document.getElementById('info-title');
  const body = document.getElementById('info-body');
  const meta = currentName ? byName[currentName].info : null;
  ttl.textContent = currentName || 'info';
  body.textContent = '';
  if (meta) {
    const desc = document.createElement('p');
    desc.textContent = meta.description;
    const credit = document.createElement('div');
    credit.className = 'info-credit';
    credit.textContent = `\u2014 ${meta.author}, ${meta.year}`;
    body.appendChild(desc);
    body.appendChild(credit);
  } else {
    body.textContent = 'No info for this hack.';
  }
  infoBox.classList.add('open');
}
function closeInfo() { infoBox.classList.remove('open'); }

// Frame readout (toggled by 'f'), bottom-right. For a 3D / WebGL hack it shows
// the shadertoy harness's own telemetry — "res Sx  M ms  WxH" (adaptive render
// scale, EMA-smoothed frame time, device-pixel buffer size), refreshed every
// frame from getStats() so you watch the adaptive scaler settle; a shader's GPU
// work is async, so the 2D work-time meter below would read ~0 for it. For a 2D
// hack: how long the running hack spends on
// the main thread per animation frame (step + draw) — NOT the display rate.
// Our rAF fires right after the hack's (registered earlier), so the time
// elapsed since the frame's timestamp ≈ the work the hack just did. We report
// the MEDIAN over a 0.5s window: it shrugs off spikes (GC pauses) and the
// occasional slightly-negative sample (timer coarsening quantises the rAF
// timestamp and performance.now() differently, so a near-zero delta can read
// < 0) that a mean can't. Each sample is also clamped to ≥0. Rises with heavier
// settings or a faster frame rate (more steps/frame); reads ~0 when idle.
let fpsRaf = 0, fpsSamples = [], fpsLast = 0;
function fpsLoop(now) {
  if (handle && handle.getStats) {            // 3D: shadertoy harness telemetry
    const s = handle.getStats();
    fps.textContent = `res ${s.scale.toFixed(2)}\u00D7   ${s.ms.toFixed(1)} ms   ${s.w}\u00D7${s.h}`;
    fpsRaf = requestAnimationFrame(fpsLoop);
    return;
  }
  fpsSamples.push(Math.max(0, performance.now() - now));   // ms of work; never < 0
  if (!fpsLast) fpsLast = now;
  if (now - fpsLast >= 500) {                              // 0.5s window
    if (fpsSamples.length) {
      const sorted = fpsSamples.slice().sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      const med = sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      fps.textContent = med < 1 ? Math.round(med * 1000) + ' \u00B5s' : med.toFixed(2) + ' ms';
    }
    fpsSamples.length = 0; fpsLast = now;
  }
  fpsRaf = requestAnimationFrame(fpsLoop);
}
function toggleFps() {
  if (fps.hidden) {
    fps.hidden = false;
    fpsSamples.length = 0; fpsLast = 0;
    fpsRaf = requestAnimationFrame(fpsLoop);
  } else {
    fps.hidden = true;
    cancelAnimationFrame(fpsRaf);
  }
}

// Control bar (touch only): a canvas tap reveals it over the running hack and it
// auto-hides after BAR_HIDE_MS; a swipe, the picker, or another tap dismisses it.
// It's per-hack, so with nothing running a tap opens the picker instead. Each
// button mirrors a footer/keyboard action; "browse" opens the full picker.
const BAR_HIDE_MS = 3200;
let barTimer = 0;
function armBarHide() {
  if (barTimer) clearTimeout(barTimer);
  barTimer = setTimeout(hideBar, BAR_HIDE_MS);
}
function showBar() {
  if (!currentName) { openSelector(); return; }
  bar.hidden = false;
  void bar.offsetWidth;            // render at opacity 0 before the fade-in
  bar.classList.add('show');
  armBarHide();
}
function hideBar() {
  if (barTimer) { clearTimeout(barTimer); barTimer = 0; }
  bar.classList.remove('show');
}

// First-visit hint (touch only): a one-time, dim nudge that the canvas takes swipe
// + tap, shown the first time a hack appears in view mode, then never again
// (persisted in localStorage; a session flag guards repeat flashTitle calls too).
const HINT_HOLD_MS = 4000;
let hintShown = false;
function maybeShowHint() {
  if (hintShown) return;
  hintShown = true;
  if (!matchMedia('(pointer: coarse)').matches) return;     // touch devices only
  try {
    if (localStorage.getItem('jscr-hinted')) return;
    localStorage.setItem('jscr-hinted', '1');
  } catch (e) { return; }                                   // private mode: just skip it
  hint.hidden = false;
  void hint.offsetWidth;
  hint.classList.add('show');
  setTimeout(() => hint.classList.remove('show'), HINT_HOLD_MS);
}

// Build the genre rail once and wire the 2D/3D filter checkboxes.
buildRail();
dim2d.addEventListener('change', applyDimFilter);
dim3d.addEventListener('change', applyDimFilter);
buildList();

title.addEventListener('click', goHome);
document.getElementById('sel-help').addEventListener('click', openHelp);
document.getElementById('sel-about').addEventListener('click', openAbout);
document.getElementById('sel-info').addEventListener('click', () => { if (currentName) openInfo(); });
document.getElementById('sel-config').addEventListener('click', () => { if (currentName) openConfig(); });
document.getElementById('sel-restart').addEventListener('click', () => { if (currentName) { restart(); closeSelector(); } });
document.getElementById('sel-fps').addEventListener('click', () => { if (currentName) { toggleFps(); closeSelector(); } });
document.getElementById('sel-random').addEventListener('click', pickRandom);
document.getElementById('sel-clear').addEventListener('click', goHome);

// Touch control-bar buttons act on the running hack directly (view mode). info /
// config open a box over the hack (so the bar hides); restart / fps keep the bar
// up and re-arm its auto-hide; browse hands off to the picker.
document.getElementById('bar-info').addEventListener('click', () => { hideBar(); openInfo(); });
document.getElementById('bar-config').addEventListener('click', () => { hideBar(); openConfig(); });
document.getElementById('bar-restart').addEventListener('click', () => { restart(); armBarHide(); });
document.getElementById('bar-fps').addEventListener('click', () => { toggleFps(); armBarHide(); });
document.getElementById('bar-browse').addEventListener('click', () => { hideBar(); openSelector(); });

// Click the dimmed area (outside a box) to dismiss.
selector.addEventListener('click', (e) => { if (e.target === selector) closeSelector(); });
configBox.addEventListener('click', (e) => { if (e.target === configBox) closeConfig(); });
about.addEventListener('click', (e) => { if (e.target === about) closeAbout(); });
help.addEventListener('click', (e) => { if (e.target === help) closeHelp(); });
infoBox.addEventListener('click', (e) => { if (e.target === infoBox) closeInfo(); });

// View-mode pointer gestures on the canvas (no overlay is up, so the canvas is the
// hit target): a tap summons the picker, a horizontal swipe cycles prev/next like
// the arrow keys. We classify a pointer down->up by total movement: within TAP_SLOP
// px = a tap; a dominant-horizontal drag past SWIPE_MIN = a swipe (left -> next,
// right -> previous). Swipes that begin at the very screen edge are left to the OS
// so they don't fight iOS's back/forward edge-swipe. touch-action:none (host.css)
// hands us the raw gesture instead of the browser scrolling.
const TAP_SLOP = 10, SWIPE_MIN = 45, EDGE_GUARD = 20;
let gesture = null;
canvas.addEventListener('pointerdown', (e) => {
  gesture = { x: e.clientX, y: e.clientY, type: e.pointerType };
  canvas.setPointerCapture?.(e.pointerId);
});
canvas.addEventListener('pointerup', (e) => {
  const g = gesture; gesture = null;
  if (!g) return;
  const dx = e.clientX - g.x, dy = e.clientY - g.y;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (adx < TAP_SLOP && ady < TAP_SLOP) { onTap(g); return; }
  if (adx > SWIPE_MIN && adx > ady) {
    if (g.x <= EDGE_GUARD || g.x >= window.innerWidth - EDGE_GUARD) return;  // edge-swipe: leave to the OS
    hideBar();
    cycle(dx < 0 ? 1 : -1);   // swipe left -> next, swipe right -> previous
  }
});
canvas.addEventListener('pointercancel', () => { gesture = null; });

// A canvas tap on a fine pointer (mouse) opens the picker directly; on a touch
// pointer it toggles the control bar (the touch fast-path — its "browse" button
// opens the full picker).
function onTap(g) {
  if (g.type === 'mouse') { openSelector(); return; }
  if (bar.classList.contains('show')) hideBar(); else showBar();
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.defaultPrevented) return;
  if (e.target.closest && e.target.closest('input, select, textarea')) return;

  if (configBox.classList.contains('open')) {
    if (e.key === 'Escape' || e.key === 'c') { e.preventDefault(); closeConfig(); }
    return;
  }
  if (help.classList.contains('open')) {
    if (e.key === 'Escape' || e.key === 'h') { e.preventDefault(); closeHelp(); }
    return;
  }
  if (about.classList.contains('open')) {
    if (e.key === 'Escape' || e.key === 'a') { e.preventDefault(); closeAbout(); }
    return;
  }
  if (infoBox.classList.contains('open')) {
    if (e.key === 'Escape' || e.key === 'i') { e.preventDefault(); closeInfo(); }
    return;
  }

  if (selector.classList.contains('open')) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setFocus('rail'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setFocus('list'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (focusPane === 'rail') moveCategory(-1); else moveCursor(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (focusPane === 'rail') moveCategory(1); else moveCursor(1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (focusPane === 'rail') setFocus('list'); else commitCursor(); }
    else if (e.key === 'a') { e.preventDefault(); openAbout(); }
    else if (e.key === 'c') { e.preventDefault(); if (currentName) openConfig(); }
    else if (e.key === 'i') { e.preventDefault(); if (currentName) openInfo(); }
    else if (e.key === 'r') { e.preventDefault(); if (currentName) { restart(); closeSelector(); } }
    else if (e.key === 'f') { e.preventDefault(); if (currentName) { toggleFps(); closeSelector(); } }
    else if (e.key === 'h') { e.preventDefault(); openHelp(); }
    else if (e.key === 'q') { e.preventDefault(); goHome(); }  // 'q' = the Clear button
    else if (e.key === 's' || e.key === 'Escape') { e.preventDefault(); closeSelector(); }
    return;
  }

  // View mode: arrows cycle; r/p/i/c/a/f/h are commands; anything else
  // (incl. 's') summons the picker.
  if (e.key === 'ArrowRight' || e.key === ']') { e.preventDefault(); cycle(1); }
  else if (e.key === 'ArrowLeft' || e.key === '[') { e.preventDefault(); cycle(-1); }
  else if (e.key === 'c') { e.preventDefault(); openConfig(); }
  else if (e.key === 'r') { e.preventDefault(); restart(); }
  else if (e.key === 'p' || e.key === ' ') { e.preventDefault(); togglePause(); }
  else if (e.key === 'i') { e.preventDefault(); openInfo(); }
  else if (e.key === 'Escape' || e.key === 'q') { e.preventDefault(); goHome(); }
  else if (e.key === 'a') { e.preventDefault(); openAbout(); }
  else if (e.key === 'f') { e.preventDefault(); toggleFps(); }
  else if (e.key === 'h') { e.preventDefault(); openHelp(); }
  else { e.preventDefault(); openSelector(); }
});

window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (byName[name]) {
    if (name !== currentName) cycleCat = 'All';   // external nav lands in All
    mount(name);
    closeSelector();
    window.goatcounter?.count?.();   // log this hack view (count.js logged the initial load)
  }
});

// Deep-link (#demon) runs that hack straight away; otherwise land calm on
// the picker (non-dismissable until a hack is chosen).
const initName = location.hash.slice(1);
if (byName[initName]) { cycleCat = 'All'; mount(initName); }
else openSelector();
