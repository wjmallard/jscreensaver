// host.js — the jscreensaver host controller.
// Owns the one shared <canvas> and mounts/unmounts hack modules onto it; drives
// the picker, the polymorphic config box, the about/help pop-overs, the
// frame-time meter, the keyboard command router, and hash routing. Loaded as a
// module by index.html (chrome markup there, chrome styles in host.css).

import { renderConfig } from './config-box.js';
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

// Alphabetical — the order shown in the picker and the ← → cycle order.
const HACKS = [squiral, coral, cloudlife, demon, petri, ant, sierpinski, binaryring, braid, boxfit, galaxy, grav, pyro, thornbird, spiral, xspirograph, hopalong, greynetic].sort((a, b) => a.title.localeCompare(b.title));
const byName = Object.fromEntries(HACKS.map((h) => [h.title, h]));

const canvas = document.getElementById('c');
const selector = document.getElementById('selector');
const configBox = document.getElementById('config');
const about = document.getElementById('about');
const help = document.getElementById('help');
const infoBox = document.getElementById('info');
const list = document.getElementById('sel-list');
const title = document.getElementById('sel-title');
const cfgLink = document.getElementById('cfg-link');
const fps = document.getElementById('fps');

let currentName = null;   // null = nothing running (black landing)
let handle = null;        // running hack's teardown handle
let paused = false;       // 'p' toggles the running hack's loop on/off
let fadeTimer = 0;        // setTimeout id for the between-hack fade-out
let savedScroll = 0;      // picker scroll position, preserved across opens
let cursorIndex = 0;      // keyboard-highlighted row in the picker

function render() {
  for (let i = 0; i < list.children.length; i++) {
    const li = list.children[i];
    li.classList.toggle('active', li.dataset.hack === currentName);
    li.classList.toggle('cursor', i === cursorIndex && selector.classList.contains('open'));
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

function cycle(dir) {
  if (!currentName) return;
  const i = HACKS.findIndex((h) => h.title === currentName);
  mount(HACKS[(i + dir + HACKS.length) % HACKS.length].title);
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
  history.replaceState(null, '', location.pathname + location.search);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  openSelector();
}

function openSelector() {
  const wasOpen = selector.classList.contains('open');
  selector.classList.add('open');
  if (!wasOpen) list.scrollTop = savedScroll;   // resume where they left off
  cursorIndex = currentName ? HACKS.findIndex((h) => h.title === currentName) : 0;
  render();
}

function closeSelector() {
  if (!currentName) return;                       // nothing running — keep it up
  if (!selector.classList.contains('open')) return;
  savedScroll = list.scrollTop;                   // remember it for next time
  selector.classList.remove('open');
}

function moveCursor(delta) {
  const n = HACKS.length;
  cursorIndex = (cursorIndex + delta + n) % n;
  render();
  list.children[cursorIndex].scrollIntoView({ block: 'nearest' });
}

function commitCursor() {
  mount(HACKS[cursorIndex].title);
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

for (const h of HACKS) {
  const li = document.createElement('li');
  li.textContent = h.title;
  li.dataset.hack = h.title;
  li.addEventListener('click', () => { mount(h.title); closeSelector(); });
  list.appendChild(li);
}

title.addEventListener('click', goHome);
document.getElementById('sel-help').addEventListener('click', openHelp);
document.getElementById('sel-about').addEventListener('click', openAbout);
document.getElementById('sel-exit').addEventListener('click', goHome);
cfgLink.addEventListener('click', openConfig);

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
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); moveCursor(1); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); moveCursor(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); commitCursor(); }
    else if (e.key === 'a') { e.preventDefault(); openAbout(); }
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
    mount(name);
    closeSelector();
    window.goatcounter?.count?.();   // log this hack view (count.js logged the initial load)
  }
});

// Deep-link (#demon) runs that hack straight away; otherwise land calm on
// the picker (non-dismissable until a hack is chosen).
if (byName[location.hash.slice(1)]) mount(location.hash.slice(1));
else openSelector();
