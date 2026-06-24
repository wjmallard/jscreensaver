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

// Alphabetical — the order shown in the picker and the ← → cycle order.
const HACKS = [squiral, coral, cloudlife, demon, petri, ant, sierpinski, binaryring, braid].sort((a, b) => a.title.localeCompare(b.title));
const byName = Object.fromEntries(HACKS.map((h) => [h.title, h]));

const canvas = document.getElementById('c');
const selector = document.getElementById('selector');
const configBox = document.getElementById('config');
const about = document.getElementById('about');
const help = document.getElementById('help');
const list = document.getElementById('sel-list');
const title = document.getElementById('sel-title');
const cfgLink = document.getElementById('cfg-link');
const fps = document.getElementById('fps');

let currentName = null;   // null = nothing running (black landing)
let handle = null;        // running hack's teardown handle
let savedScroll = 0;      // picker scroll position, preserved across opens
let cursorIndex = 0;      // keyboard-highlighted row in the picker

function render() {
  for (let i = 0; i < list.children.length; i++) {
    const li = list.children[i];
    li.classList.toggle('active', li.dataset.hack === currentName);
    li.classList.toggle('cursor', i === cursorIndex && selector.classList.contains('open'));
  }
}

// Swap hacks: stop the old one (cancels its loop + resize listener) before
// starting the new one on the shared canvas. Reveal the config affordance
// only when the new hack exposes a config.
function mount(name) {
  if (!byName[name] || name === currentName) return;
  if (handle) handle.stop();
  currentName = name;
  handle = byName[name].start(canvas);
  if (location.hash.slice(1) !== name) location.hash = name;
  cfgLink.hidden = !(handle && handle.params);
  render();
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
}

// Clear / home: stop the hack, drop the hash, clear to black, and hold the
// picker open (non-dismissable, since there's nothing to return to).
function goHome() {
  closeConfig(); closeAbout(); closeHelp();
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

// Config / About / Help are mutually exclusive pop-overs; the config box is
// populated polymorphically from whatever hack is running.
function openConfig() {
  closeAbout(); closeHelp();
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
function openAbout() { closeConfig(); closeHelp(); about.classList.add('open'); }
function closeAbout() { about.classList.remove('open'); }
function openHelp() { closeConfig(); closeAbout(); help.classList.add('open'); }
function closeHelp() { help.classList.remove('open'); }

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
      fps.textContent = med < 1 ? Math.round(med * 1000) + ' µs/f' : med.toFixed(2) + ' ms/f';
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

  if (selector.classList.contains('open')) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); moveCursor(1); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); moveCursor(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); commitCursor(); }
    else if (e.key === 'a') { e.preventDefault(); openAbout(); }
    else if (e.key === 'h') { e.preventDefault(); openHelp(); }
    else if (e.key === 's' || e.key === 'Escape') { e.preventDefault(); closeSelector(); }
    return;
  }

  // View mode: arrows cycle; r/c/a/f/h are commands; anything else
  // (incl. 's') summons the picker.
  if (e.key === 'ArrowRight' || e.key === ']') { e.preventDefault(); cycle(1); }
  else if (e.key === 'ArrowLeft' || e.key === '[') { e.preventDefault(); cycle(-1); }
  else if (e.key === 'c') { e.preventDefault(); openConfig(); }
  else if (e.key === 'r') { e.preventDefault(); restart(); }
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
