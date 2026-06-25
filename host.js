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

// Alphabetical — the order shown in the picker and the ← → cycle order.
const HACKS = [squiral, coral, cloudlife, demon, petri, ant, sierpinski, binaryring, braid, boxfit, galaxy, grav, pyro, thornbird, spiral, xspirograph, hopalong, greynetic, kumppa, halftone, imsmap, interaggregate, interference, metaballs, piecewise, halo, moire, qix, truchet, helix, moire2, penrose, scooter, strange, loop, vermiculate, binaryhorizon, cynosure, deco, fadeplot, popsquares, rorschach, bouboule, cwaves, fiberlamp, mountain, munch, pedal, wander, whirlwindwarp, fluidballs, ifs, attraction, euler2d, eruption, flame, hexadrop, intermomentary, apollonian, ccurve, drift, wormhole, nerverot, rocks].sort((a, b) => a.title.localeCompare(b.title));
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
const cfgLink = document.getElementById('cfg-link');
const fps = document.getElementById('fps');
const hackName = document.getElementById('hackname');

// Picker taxonomy: a left rail of genres (plus "All") filters the hack list on
// the right; an optional 2D/3D dimension filter narrows it further. The rail
// shows short labels (first word of each genre); the detail header shows the
// full name. Badges + the dimension filter only appear once the registered set
// actually mixes 2D and 3D hacks (today it is all 2D) so the menu stays clean
// until the GL track is wired in.
const RAIL = ['All', ...CATEGORIES];
const shortLabel = (c) => (c === 'All' ? 'All' : c.split(' & ')[0]);

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

// Swap hacks. When one hack is already on screen, fade its (frozen) last frame
// to black via canvas opacity, then start the new hack on the freshly-cleared
// canvas at full opacity — no fade-IN, since the new hack builds up from black
// on its own (xscreensaver's symmetric gamma fade-in is wasted on that). The
// first mount from the black landing has nothing to fade, so it starts at once.
// Reveal the config affordance only when the new hack exposes a config.
function mount(name) {
  if (!byName[name] || name === currentName) return;
  const wasRunning = !!handle;
  cancelFade();
  if (handle) { handle.stop(); handle = null; }
  currentName = name;
  paused = false;
  cfgLink.hidden = true;
  hackName.textContent = name;
  hackName.hidden = false;
  if (location.hash.slice(1) !== name) location.hash = name;
  render();

  const startHack = () => {
    fadeTimer = 0;
    canvas.style.transition = 'none';   // snap back to full opacity, no fade-in
    canvas.style.opacity = '1';
    handle = byName[name].start(canvas);
    cfgLink.hidden = !(handle && handle.params);
  };

  if (wasRunning) {
    canvas.style.transition = `opacity ${FADE_MS}ms linear`;
    void canvas.offsetWidth;             // force reflow so the fade starts from 1
    canvas.style.opacity = '0';
    fadeTimer = setTimeout(startHack, FADE_MS);
  } else {
    startHack();
  }
}

// View-mode left/right cycle within the genre the current hack was chosen from
// (cycleCat; "All" cycles everything), falling back to the hack's own genre.
function cyclePool() {
  let pool = categoryPool(cycleCat);
  if (!pool.some((h) => h.title === currentName)) pool = categoryPool(classify(currentName).category);
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
  cfgLink.hidden = true;
  hackName.hidden = true;
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
    if (cat !== 'All' && t.category !== cat) return false;
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
    label.textContent = shortLabel(name);
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
  catHead.textContent = RAIL[catIndex];
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

// config + clear are no-ops with nothing running; dim them (and drop their hover)
// so a dead click isn't invited. The footer only shows via openSelector, and
// "clear" re-routes through it, so syncing here covers every visible transition.
function syncFooter() {
  const running = !!currentName;
  document.getElementById('sel-config').classList.toggle('disabled', !running);
  document.getElementById('sel-clear').classList.toggle('disabled', !running);
}

function openSelector() {
  selector.classList.add('open');
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

// Frame render time (toggled by 'f'): how long the running hack spends on
// the main thread per animation frame (step + draw) — NOT the display rate.
// Our rAF fires right after the hack's (registered earlier), so the time
// elapsed since the frame's timestamp ≈ the work the hack just did. We report
// the MEDIAN over a 1s window: it shrugs off spikes (GC pauses) and the
// occasional slightly-negative sample (timer coarsening quantises the rAF
// timestamp and performance.now() differently, so a near-zero delta can read
// < 0) that a mean can't. Each sample is also clamped to ≥0. Rises with heavier
// settings or a faster frame rate (more steps/frame); reads ~0 when idle.
let fpsRaf = 0, fpsSamples = [], fpsLast = 0;
function fpsLoop(now) {
  fpsSamples.push(Math.max(0, performance.now() - now));   // ms of work; never < 0
  if (!fpsLast) fpsLast = now;
  if (now - fpsLast >= 1000) {                             // 1s window
    if (fpsSamples.length) {
      const sorted = fpsSamples.slice().sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      const med = sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      fps.textContent = med < 1 ? Math.round(med * 1000) + ' \u00B5s/f' : med.toFixed(2) + ' ms/f';
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

// Build the genre rail once and wire the 2D/3D filter checkboxes.
buildRail();
dim2d.addEventListener('change', applyDimFilter);
dim3d.addEventListener('change', applyDimFilter);
buildList();

title.addEventListener('click', goHome);
document.getElementById('sel-help').addEventListener('click', openHelp);
document.getElementById('sel-about').addEventListener('click', openAbout);
document.getElementById('sel-config').addEventListener('click', () => { if (currentName) openConfig(); });
document.getElementById('sel-random').addEventListener('click', pickRandom);
document.getElementById('sel-clear').addEventListener('click', goHome);
cfgLink.addEventListener('click', openConfig);
hackName.addEventListener('click', openInfo);   // the corner name opens its info box

// Click the dimmed area (outside a box) to dismiss.
selector.addEventListener('click', (e) => { if (e.target === selector) closeSelector(); });
configBox.addEventListener('click', (e) => { if (e.target === configBox) closeConfig(); });
about.addEventListener('click', (e) => { if (e.target === about) closeAbout(); });
help.addEventListener('click', (e) => { if (e.target === help) closeHelp(); });
infoBox.addEventListener('click', (e) => { if (e.target === infoBox) closeInfo(); });

// In view mode, clicking the running hack brings the picker back.
canvas.addEventListener('click', openSelector);

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
    else if (e.key === 'h') { e.preventDefault(); openHelp(); }
    else if (e.key === 's' || e.key === 'Escape') { e.preventDefault(); closeSelector(); }
    return;
  }

  // View mode: arrows cycle; r/p/i/c/a/f/h are commands; anything else
  // (incl. 's') summons the picker.
  if (e.key === 'ArrowRight' || e.key === ']') { e.preventDefault(); cycle(1); }
  else if (e.key === 'ArrowLeft' || e.key === '[') { e.preventDefault(); cycle(-1); }
  else if (e.key === 'c') { e.preventDefault(); openConfig(); }
  else if (e.key === 'r') { e.preventDefault(); restart(); }
  else if (e.key === 'p') { e.preventDefault(); togglePause(); }
  else if (e.key === 'i') { e.preventDefault(); openInfo(); }
  else if (e.key === 'Escape') { e.preventDefault(); goHome(); }
  else if (e.key === 'a') { e.preventDefault(); openAbout(); }
  else if (e.key === 'f') { e.preventDefault(); toggleFps(); }
  else if (e.key === 'h') { e.preventDefault(); openHelp(); }
  else { e.preventDefault(); openSelector(); }
});

window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (byName[name]) {
    if (name !== currentName) cycleCat = classify(name).category;   // external nav: scope to its genre
    mount(name);
    closeSelector();
    window.goatcounter?.count?.();   // log this hack view (count.js logged the initial load)
  }
});

// Deep-link (#demon) runs that hack straight away; otherwise land calm on
// the picker (non-dismissable until a hack is chosen).
const initName = location.hash.slice(1);
if (byName[initName]) { cycleCat = classify(initName).category; mount(initName); }
else openSelector();
