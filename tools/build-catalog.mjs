#!/usr/bin/env node
// tools/build-catalog.mjs — generate catalog.json, the host's hack catalog,
// from the two sources of truth that already exist:
//
//   * taxonomy.js     — which hacks are active (every HACK_TAXONOMY entry that
//                       isn't `shelved: true`) plus each one's dimension + genres.
//   * hacks/<slug>.js — that hack's own `title` and `info` exports
//                       (author / year / description / heavy).
//
// It loads NO hack module: they import three / WebGL / DOM and run side effects
// at import time, so instead each file is read as text and the two metadata
// exports are lifted out statically. taxonomy.js is pure data, so it IS loaded —
// via a data: URL, which lets node treat the repo's .js as ESM without a
// package.json.
//
// Usage:
//   node tools/build-catalog.mjs          # write catalog.json
//   node tools/build-catalog.mjs --check  # verify it's fresh AND every module
//                                         # path is git-tracked; exit 1 if not.
//
// host.js fetches the .json at startup (before building the picker) and import()s
// each hack's code lazily on first mount. `--check` is the pre-push guard against
// a stale catalog or an imported-but-uncommitted module (the failure that once
// blanked the live site). DO NOT hand-edit catalog.json — edit a hack's `info`
// (or taxonomy.js) and regenerate.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = resolve(ROOT, 'catalog.json');
const YEAR_UNKNOWN = 'unknown';   // catalog fallback when a hack's info omits year (rare)

// --- string-aware literal slice ----------------------------------------------
// Return the {...} (or [...]) substring beginning at openIdx, tracking string
// state so braces inside 'a' / "b" / `c` don't miscount. Our object literals
// carry no comments, so none are stripped.
function sliceBalanced(src, openIdx) {
  const open = src[openIdx], close = open === '{' ? '}' : ']';
  let depth = 0, str = null, esc = false;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (str) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === str) str = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') str = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return src.slice(openIdx, i + 1);
  }
  throw new Error('unbalanced literal');
}

// Evaluate a self-contained object/array literal from our own trusted source.
const evalLiteral = (text) => new Function('return (' + text + ')')();

// Lift `export const title = '...'` and `export const info = { ... }` out of a
// hack module's source WITHOUT executing the module.
function readHackMeta(file) {
  const src = readFileSync(file, 'utf8');
  const tm = src.match(/export\s+const\s+title\s*=\s*(['"])(.*?)\1/);
  if (!tm) throw new Error(`${file}: no "export const title"`);
  const im = src.match(/export\s+const\s+info\s*=\s*\{/);
  if (!im) throw new Error(`${file}: no "export const info = {"`);
  const info = evalLiteral(sliceBalanced(src, im.index + im[0].length - 1));
  return { title: tm[2], info };
}

// --- load taxonomy (pure data) via a data: URL so node treats it as ESM -------
const taxSrc = readFileSync(resolve(ROOT, 'taxonomy.js'), 'utf8');
const { HACK_TAXONOMY } = await import('data:text/javascript,' + encodeURIComponent(taxSrc));

// --- build the entries --------------------------------------------------------
const problems = [];
const entries = [];
for (const [slug, t] of Object.entries(HACK_TAXONOMY)) {
  if (t.shelved) continue;                              // classified but parked
  // resolve the module file: hacks/<slug>.js, else hacks/shelved/<slug>.js
  let module = `./hacks/${slug}.js`;
  if (!existsSync(resolve(ROOT, module.slice(2)))) {
    const alt = `./hacks/shelved/${slug}.js`;
    if (existsSync(resolve(ROOT, alt.slice(2)))) module = alt;
    else { problems.push(`${slug}: no module file (hacks/${slug}.js or hacks/shelved/${slug}.js)`); continue; }
  }
  let meta;
  try { meta = readHackMeta(resolve(ROOT, module.slice(2))); }
  catch (e) { problems.push(String(e.message || e)); continue; }
  if (meta.title !== slug) problems.push(`${slug}: title export is "${meta.title}" (slug/filename mismatch)`);
  const { author, year, description, heavy } = meta.info;
  if (!author) problems.push(`${slug}: info.author missing`);
  if (!description) problems.push(`${slug}: info.description missing`);
  if (year == null) console.warn(`build-catalog: ${slug} has no info.year -> "${YEAR_UNKNOWN}"`);
  // Field order mirrors the .js source: identity, classification, then credits.
  // `heavy` is conditional (emitted only when set); author / description are
  // required (validated above). `year` is a number (e.g. 2004); it falls back to
  // YEAR_UNKNOWN if a hack omits it, so the field is always present and the credit
  // line needs no ternary.
  const entry = { title: slug, module, dim: t.dimension, categories: t.categories };
  if (heavy) entry.heavy = true;
  entry.author = author;
  entry.year = year ?? YEAR_UNKNOWN;
  entry.description = description;
  entries.push(entry);
}
entries.sort((a, b) => a.title.localeCompare(b.title));

if (problems.length) {
  console.error('build-catalog: problems:\n  ' + problems.join('\n  '));
  process.exit(1);
}

// --- serialize ----------------------------------------------------------------
// A leading "_generated" key is the at-rest stand-in for the DO-NOT-EDIT header
// comment a .json can't carry; host.js reads only `.hacks` and ignores it.
const json = JSON.stringify({
  _generated: 'GENERATED by tools/build-catalog.mjs -- DO NOT EDIT. Edit a hack\'s info export or taxonomy.js, then run: node tools/build-catalog.mjs',
  hacks: entries,
}, null, 2);
// Keep the catalog pure ASCII: rewrite any non-ASCII char as a JSON unicode
// escape (a couple of verbatim blurbs carry an accented letter, e.g. moire).
// JSON parses the escapes back to identical text; mirrors the ASCII-safe rule.
let asciiOut = '';
for (let i = 0; i < json.length; i++) {
  const code = json.charCodeAt(i);
  asciiOut += code > 0x7f ? '\\u' + code.toString(16).padStart(4, '0') : json[i];
}
const out = asciiOut + '\n';

// --- write, or check ----------------------------------------------------------
if (process.argv.includes('--check')) {
  let bad = false;
  const current = existsSync(CATALOG) ? readFileSync(CATALOG, 'utf8') : '';
  if (current !== out) {
    console.error('build-catalog --check: catalog.json is STALE — run `node tools/build-catalog.mjs`.');
    bad = true;
  }
  // Every module path must be git-tracked, or it 404s on the deployed site and
  // its failed lazy import shows the broken-hack message (and never the catalog).
  let tracked = null;
  try { tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')); }
  catch { /* not a git checkout — skip this leg */ }
  if (tracked) {
    for (const e of entries) {
      if (!tracked.has(e.module.slice(2))) {
        console.error(`build-catalog --check: ${e.module.slice(2)} is NOT git-tracked (would 404 when deployed).`);
        bad = true;
      }
    }
  }
  if (bad) process.exit(1);
  console.log(`build-catalog --check: OK — ${entries.length} hacks, catalog fresh, all modules tracked.`);
} else {
  writeFileSync(CATALOG, out);
  console.log(`build-catalog: wrote catalog.json — ${entries.length} hacks.`);
}
