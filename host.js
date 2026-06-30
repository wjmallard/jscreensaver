// host.js — the jscreensaver host controller.
// Owns the one shared <canvas> and mounts/unmounts hack modules onto it; drives
// the picker, the polymorphic config box, the about/help pop-overs, the
// frame-time meter, the keyboard command router, and hash routing. Loaded as a
// module by index.html (chrome markup there, chrome styles in host.css).

import { renderConfig } from './config-box.js';
import { CATEGORIES, DIMENSIONS } from './taxonomy.js';
// The hack catalog is the generated at-rest file (catalog.json, repo root): one
// metadata entry per active hack { title, module, dim, categories, heavy?, author,
// year, description }, already alphabetical. We FETCH it before building the
// picker -- a fetch is catchable, so a missing or broken catalog shows a message
// instead of the silent blank a failed static import would give (index.html
// preloads it, so the request is already in flight). Each hack's CODE is then
// import()ed lazily on first mount (loadModule), so the picker builds from this
// metadata alone with no hack module loaded -- a broken hack can't blank the site.
let HACKS;
try {
  const res = await fetch('./catalog.json');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  HACKS = (await res.json()).hacks;
  if (!Array.isArray(HACKS) || !HACKS.length) throw new Error('empty or malformed catalog');
} catch (err) {
  console.error('jscreensaver: could not load the hack catalog (catalog.json)', err);
  document.body.insertAdjacentHTML('beforeend',
    `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#5fdd83;background:#000;text-align:center;font:14px ui-monospace,Menlo,monospace">could not load the hack catalog<br>(catalog.json)</div>`);
  throw err;   // halt init; the message above is what the user sees
}

const byName = Object.fromEntries(HACKS.map((h) => [h.title, h]));

const canvas = document.getElementById('c');
const selector = document.getElementById('selector');
const configBox = document.getElementById('config');
const about = document.getElementById('about');
const help = document.getElementById('help');
const infoBox = document.getElementById('info');
const searchBox = document.getElementById('search');
const searchInput = document.getElementById('search-input');
const searchList = document.getElementById('search-list');
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
const barPause = document.getElementById('bar-pause');
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
let currentModule = null; // running hack's loaded code module (so restart needs no re-import)
let paused = false;       // 'p' toggles the running hack's loop on/off
let fadeTimer = 0;        // setTimeout id for the between-hack fade-out
let catIndex = 0;         // focused rail entry (0 = All)
let show2d = true;        // 2D filter checkbox (default on)
let show3d = false;       // 3D filter checkbox (default off)
let visible = [];         // hacks currently shown in the list (filtered)
let cursorIndex = 0;      // keyboard-highlighted row in the list
let focusPane = 'list';   // which pane the keyboard drives: 'rail' | 'list'
let cycleCat = 'All';     // genre that view-mode left/right cycling stays within
let searchResults = [];   // hacks matching the quick-find query (prefix matches first)
let searchCursor = 0;     // highlighted row in the quick-find results

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
// the touch control bar), and stays hidden while the picker or Info box is open.
// flashTitle is a no-op when nothing's running or either is up; closeSelector re-arms
// it on the way back to view.
const TITLE_HOLD_MS = 2000, TITLE_FADE_MS = 1000;
let titleTimer = 0;
function flashTitle() {
  if (titleTimer) { clearTimeout(titleTimer); titleTimer = 0; }
  if (!currentName || selector.classList.contains('open') || infoBox.classList.contains('open')) { hideTitle(); return; }
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

// Lazily import a hack's code module the first time it's mounted, caching the
// PROMISE so concurrent mounts share one fetch and re-mounts are instant; a
// rejected import is evicted so a later attempt can retry. Only mount() calls
// this -- the picker runs off manifest metadata -- so no hack code loads until a
// hack is actually shown.
const moduleCache = new Map();
function loadModule(entry) {
  let p = moduleCache.get(entry.title);
  if (!p) {
    p = import(entry.module).catch((e) => { moduleCache.delete(entry.title); throw e; });
    moduleCache.set(entry.title, p);
  }
  return p;
}

// Swap hacks. When leaving a 2D hack on screen, fade its (frozen) last frame
// to black via canvas opacity, then start the new hack on the freshly-cleared
// canvas at full opacity — no fade-IN, since the new hack builds up from black
// on its own (xscreensaver's symmetric gamma fade-in is wasted on that). The
// first mount from the black landing has nothing to fade, so it starts at once.
function mount(name) {
  if (!byName[name] || name === currentName) return;
  const entry = byName[name];
  const wasRunning = !!handle;
  const wasGL = !!(handle && handle.getStats);   // 3D renders to its own overlay (removed on stop), not #c
  cancelFade();
  if (handle) { handle.stop(); handle = null; currentModule = null; }
  currentName = name;
  paused = false;
  hackName.textContent = name;
  flashTitle();
  if (location.hash.slice(1) !== name) location.hash = name;
  render();

  // Kick the import off now so the network/parse overlaps the leaving-hack fade.
  const loading = loadModule(entry);

  const startHack = async () => {
    fadeTimer = 0;
    let mod;
    try { mod = await loading; }
    catch (e) { if (currentName === name) showLoadError(name, e); return; }
    if (currentName !== name) return;   // a newer mount superseded this one mid-load
    try {
      canvas.style.transition = 'none';   // snap back to full opacity, no fade-in
      canvas.style.opacity = '1';
      currentModule = mod;
      handle = mod.start(canvas);
    } catch (e) { showLoadError(name, e); return; }
    syncPauseBtn();
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

// Failure isolation: if a hack's module fails to import (e.g. a 404) or its
// start() throws, paint a quiet message on the host canvas instead of leaving a
// blank screen -- only that one hack is broken; the picker and the rest still work.
function showLoadError(name, err) {
  console.error(`jscreensaver: failed to load hack "${name}":`, err);
  cancelFade();
  handle = null; currentModule = null;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#5fdd83';
  ctx.font = '14px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`could not load "${name}"`, canvas.width / 2, canvas.height / 2);
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
  else if (currentModule) { handle.stop(); handle = currentModule.start(canvas); }   // module already loaded
  if (paused) { paused = false; handle.resume?.(); }   // 'r' always un-pauses
  syncPauseBtn();
}

// Freeze / resume the running hack's animation loop. Resets its pacing on
// resume so there's no catch-up burst. No-op for a hack without pause/resume.
function togglePause() {
  if (!handle) return;
  paused = !paused;
  if (paused) handle.pause?.(); else handle.resume?.();
  syncPauseBtn();
}
// Reflect the running hack's pause state on the touch bar's pause/play button, and
// dim it for hacks that expose no pause handler so it never looks like a dead
// control. A no-op on desktop, where the bar is hidden.
function syncPauseBtn() {
  const canPause = !!(handle && handle.pause);
  barPause.classList.toggle('disabled', !canPause);
  barPause.classList.toggle('is-paused', canPause && paused);
}

// Clear / home: stop the hack, drop the hash, clear to black, and hold the
// picker open (non-dismissable, since there's nothing to return to).
function goHome() {
  closeConfig(); closeAbout(); closeHelp(); closeInfo(); closeSearch();
  cancelFade();
  if (handle) { handle.stop(); handle = null; currentModule = null; }
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
    if (cat !== 'All' && !h.categories.includes(cat)) return false;
    if (h.dim === '2d' && !show2d) return false;
    if (h.dim === '3d' && !show3d) return false;
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
  const mixed = new Set(visible.map((h) => h.dim)).size > 1;
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
        badge.textContent = DIMENSIONS[h.dim].glyph;
        li.appendChild(badge);
      }
      const label = document.createElement('span');
      label.textContent = h.title;
      li.appendChild(label);
      if (h.heavy) {                               // GPU-intensive: trailing red dot
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

// The per-hack footer actions (info/config/restart) and clear are no-ops with
// nothing running; dim them (and drop their hover) so a dead click isn't invited.
// random stays live — it picks a hack from the landing too. The footer only shows
// via openSelector, and "clear" re-routes through it, so syncing here covers every
// visible transition.
function syncFooter() {
  const running = !!currentName;
  for (const id of ['sel-info', 'sel-config', 'sel-restart', 'sel-clear']) {
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
  closeAbout(); closeHelp(); closeInfo(); closeSearch();
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
function openAbout() { closeConfig(); closeHelp(); closeInfo(); closeSearch(); about.classList.add('open'); }
function closeAbout() { about.classList.remove('open'); }
function openHelp() { closeConfig(); closeAbout(); closeInfo(); closeSearch(); help.classList.add('open'); }
function closeHelp() { help.classList.remove('open'); }

// Append `text` to `el`, turning http(s) URLs into <a> links; the non-URL runs
// stay text nodes so the surrounding white-space: pre-wrap still renders their
// line breaks. URL is matched up to whitespace (so consecutive split URLs each
// link separately); trailing sentence punctuation is left out of the href.
function appendLinkified(el, text) {
  const re = /https?:\/\/[^\s]+/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    let url = m[0], trail = '';
    const punct = url.match(/[.,;:!?]+$/);
    if (punct) { trail = punct[0]; url = url.slice(0, -trail.length); }
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    el.appendChild(a);
    if (trail) el.appendChild(document.createTextNode(trail));
    last = m.index + m[0].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

// Info box: the running hack's blurb (jwz's verbatim xml <_description>, baked
// into the catalog) plus an em-dash author/year credit, read straight from its
// catalog entry (no module load), shown read-only. The blurb carries blank-line
// paragraph breaks plus, inside a paragraph, single newline breaks (preformatted
// listings, split URLs) that white-space: pre-wrap renders.
function openInfo() {
  closeConfig(); closeAbout(); closeHelp(); closeSearch();
  const ttl = document.getElementById('info-title');
  const body = document.getElementById('info-body');
  const meta = currentName ? byName[currentName] : null;
  ttl.textContent = currentName || 'info';
  body.textContent = '';
  if (meta) {
    for (const para of meta.description.split(/\n{2,}/)) {
      const p = document.createElement('p');
      p.className = 'info-desc';
      appendLinkified(p, para);
      body.appendChild(p);
    }
    const credit = document.createElement('div');
    credit.className = 'info-credit';
    credit.textContent = `\u2014 ${meta.author}, ${meta.year}`;
    body.appendChild(credit);
  } else {
    body.textContent = 'No info for this hack.';
  }
  infoBox.classList.add('open');
}
function closeInfo() { infoBox.classList.remove('open'); }

// Quick-find ('/'): a title search over the whole library, shown in its own
// top-anchored overlay. Matching is case-insensitive substring with prefix
// matches sorted ahead of mid-string ones; within each group HACKS' existing
// alphabetical order is preserved (the scan is stable). An empty query matches
// nothing (the results list collapses to just the input). Only view mode opens
// it, and while it's open the search input holds focus, so the global key router
// steps aside (its input-focus guard) and the input's own handlers below own
// ArrowUp/Down/Enter/Esc.
function searchMatches(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const prefix = [], mid = [];
  for (const h of HACKS) {
    const i = h.title.toLowerCase().indexOf(q);
    if (i === 0) prefix.push(h);
    else if (i > 0) mid.push(h);
  }
  return prefix.concat(mid);
}

function openSearch() {
  closeConfig(); closeAbout(); closeHelp(); closeInfo(); closeSelector();
  searchInput.value = '';
  searchResults = [];
  searchCursor = 0;
  renderSearch();
  searchBox.classList.add('open');
  searchInput.focus();
}
function closeSearch() {
  searchBox.classList.remove('open');
  searchInput.blur();
}

// Rebuild the results list from searchResults. The running hack's row is marked
// amber (as in the picker); a query with no matches shows a dim placeholder; an
// empty query shows nothing (the list collapses via the :empty CSS).
function renderSearch() {
  searchList.textContent = '';
  if (searchResults.length) {
    searchResults.forEach((h, i) => {
      const li = document.createElement('li');
      li.dataset.hack = h.title;
      if (h.title === currentName) li.classList.add('active');
      if (i === searchCursor) li.classList.add('cursor');
      const label = document.createElement('span');
      label.textContent = h.title;
      li.appendChild(label);
      if (h.heavy) {                               // GPU-intensive: trailing red dot
        const heavy = document.createElement('span');
        heavy.className = 'sel-heavy';
        heavy.textContent = '\u25CF';
        heavy.title = 'GPU-intensive';
        li.appendChild(heavy);
      }
      li.addEventListener('click', () => { searchCursor = i; commitSearch(); });
      searchList.appendChild(li);
    });
  } else if (searchInput.value.trim()) {
    const li = document.createElement('li');
    li.className = 'sel-empty';
    li.textContent = '\u2014 no match \u2014';
    searchList.appendChild(li);
  }
}

// Lighter update for arrow nav: move the cursor class and scroll it into view
// without rebuilding the rows.
function renderSearchCursor() {
  for (let i = 0; i < searchList.children.length; i++) {
    searchList.children[i].classList.toggle('cursor', i === searchCursor);
  }
  searchList.children[searchCursor]?.scrollIntoView({ block: 'nearest' });
}
function moveSearch(delta) {
  if (!searchResults.length) return;
  const n = searchResults.length;
  searchCursor = (searchCursor + delta + n) % n;
  renderSearchCursor();
}

// Mount the highlighted match and close. A name search spans the whole library,
// so subsequent left/right cycling uses the All pool (cycleCat = 'All'), matching
// deep-link / hashchange navigation. Close first so mount's title flash isn't
// briefly drawn under the still-open box.
function commitSearch() {
  const pick = searchResults[searchCursor];
  if (!pick) return;
  cycleCat = 'All';
  closeSearch();
  mount(pick.title);
}

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
const BAR_HIDE_MS = 5000;
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
  syncPauseBtn();
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
document.getElementById('sel-random').addEventListener('click', pickRandom);
document.getElementById('sel-clear').addEventListener('click', goHome);

// Touch control-bar buttons act on the running hack directly (view mode). prev /
// next step hacks (like the arrow keys) and keep the bar up; info / config open a
// box over the hack (so the bar hides); restart / pause keep the bar up and re-arm
// its auto-hide; browse hands off to the picker.
document.getElementById('bar-prev').addEventListener('click', () => { cycle(-1); armBarHide(); });
document.getElementById('bar-info').addEventListener('click', () => { hideBar(); openInfo(); });
document.getElementById('bar-config').addEventListener('click', () => { hideBar(); openConfig(); });
document.getElementById('bar-restart').addEventListener('click', () => { restart(); armBarHide(); });
document.getElementById('bar-pause').addEventListener('click', () => { togglePause(); armBarHide(); });
document.getElementById('bar-browse').addEventListener('click', () => { hideBar(); openSelector(); });
document.getElementById('bar-next').addEventListener('click', () => { cycle(1); armBarHide(); });

// Click the dimmed area (outside a box) to dismiss.
selector.addEventListener('click', (e) => { if (e.target === selector) closeSelector(); });
configBox.addEventListener('click', (e) => { if (e.target === configBox) closeConfig(); });
about.addEventListener('click', (e) => { if (e.target === about) closeAbout(); });
help.addEventListener('click', (e) => { if (e.target === help) closeHelp(); });
infoBox.addEventListener('click', (e) => { if (e.target === infoBox) closeInfo(); });
searchBox.addEventListener('click', (e) => { if (e.target === searchBox) closeSearch(); });

// Quick-find input: filter as you type; arrows move the highlight, Enter mounts
// the highlighted match, Esc closes. These live on the input (not the global key
// router, which steps aside while a text field has focus), so they own the keys
// only while the search box is up.
searchInput.addEventListener('input', () => {
  searchResults = searchMatches(searchInput.value);
  searchCursor = 0;
  renderSearch();
});
searchInput.addEventListener('keydown', (e) => {
  // Escape closes search; if no hack is running (search was opened from the picker),
  // fall back to the picker rather than stranding on a blank screen. With a hack up
  // it just reveals the running hack underneath.
  if (e.key === 'Escape') { e.preventDefault(); closeSearch(); if (!currentName) openSelector(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); moveSearch(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSearch(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); commitSearch(); }
});

// View-mode canvas tap (no overlay is up, so the canvas is the hit target). We act
// on pointerdown -- the FIRST event of the touch -- instead of waiting for a
// pointerup to classify: with swipe-to-cycle gone there's nothing to disambiguate,
// and reacting to the down means the tap still lands when a heavy 3D hack is pegging
// the main thread (a late pointerdown is harmless; a delayed or cancelled pointerup
// would silently drop the tap). A fine-pointer (mouse) tap opens the picker; a touch
// tap toggles the control bar, whose chevrons/buttons then drive everything.
canvas.addEventListener('pointerdown', (e) => {
  if (!e.isPrimary) return;
  if (e.pointerType === 'mouse') { openSelector(); return; }
  if (bar.classList.contains('show')) hideBar(); else showBar();
});

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.defaultPrevented) return;
  if (e.target.closest && e.target.closest('input, select, textarea')) return;

  // '/' (find by name) works from ANY context: openSearch tears down whichever
  // overlay is up (config / about / help / info / picker) and shows the search box.
  // Handled before the per-overlay blocks below, which would otherwise swallow it
  // via their early return. Typing '/' into the search field or a config control is
  // already excluded by the input guard above, so this never hijacks text entry.
  if (e.key === '/') { e.preventDefault(); openSearch(); return; }

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
    // Left/right still cycle hacks (same pool as view mode) with Info open,
    // refreshing the box to the newly-mounted hack so you can browse with it up.
    if (e.key === 'ArrowRight' || e.key === ']') { e.preventDefault(); cycle(1); openInfo(); }
    else if (e.key === 'ArrowLeft' || e.key === '[') { e.preventDefault(); cycle(-1); openInfo(); }
    else if (e.key === 'Escape' || e.key === 'i') { e.preventDefault(); closeInfo(); }
    else if (e.key === 'q') { e.preventDefault(); goHome(); }   // Clear: stop hack, drop to picker (goHome closes Info)
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
