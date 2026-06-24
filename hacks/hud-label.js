// hud-label.js -- a small, reusable 2D HUD text-label overlay for the GL hacks.
//
// Shared infrastructure for the handful of xscreensaver GL ports that draw an
// on-screen text label via texfont.c's print_texture_label() (engine draws the
// engine name; glsnake and circuit draw similar corner captions). Rather than
// each port re-implementing a texture-font pipeline, they mount ONE of these: a
// transparent canvas-2D overlay stacked ABOVE the hack's WebGL canvas, onto
// which the label is drawn with fillText.
//
// WHY A SEPARATE 2D CANVAS
//   The hacks render into a WebGL canvas at z-index:1. This helper's canvas sits
//   at a higher z-index (default 2), is `position:fixed; inset:0;
//   pointer-events:none` so the host chrome stays clickable, and is fully
//   transparent except for the text. That keeps the label crisp (native 2D text,
//   dpr-aware) and completely decoupled from the GL scene -- exactly what
//   print_texture_label does in the original (it draws the string in a separate
//   orthographic pass over the finished 3D frame, not as scene geometry).
//
// FONT
//   xscreensaver's titleFont default is "sans-serif 18". No sans-serif is vendored
//   in hacks/fonts/, so we use luximr.ttf (Luxi Mono) -- the cleanest, most
//   neutral, legible face on hand (and itself an xscreensaver-bundled font). It is
//   loaded via the FontFace API, resolved relative to this module, and the label
//   redraws once the face is ready. Until then it falls back to the platform
//   monospace so nothing flickers to an empty frame.
//
// FAITHFUL DETAILS (matching print_texture_label / texfont.c)
//   * Corner semantics mirror print_texture_label's `position` codes: position 1
//     ("top") is the top-LEFT corner with a left/top margin of ~one font-ascent,
//     which is this helper's 'tl'. ('bl' ~ position 2 "bottom"; 'tr'/'br' round
//     out the set for the other ports.)
//   * The original draws the string five times (four dark offset copies + the
//     colored copy on top) to give it a contrasting outline. We do the same: a
//     1-ish px outline whose color is chosen by the SAME luminance test the .c
//     uses (Rec.709 luma > 0.4 -> dark outline, else light).
//   * Multi-line strings (engine's name is "Model\nV8" etc.) are honored: '\n'
//     starts a new line, laid out downward from the anchored corner.
//
// SIZE
//   The font size is proportional to the overlay height (~3%, clamped to a legible
//   12..40 px), so the label scales sensibly across window sizes. The original
//   uses a fixed 18 px in window pixels; at the usual 700-1080 px tall windows the
//   proportional size lands in the same ballpark while staying readable on small
//   or huge canvases.
//
// API
//   makeHudLabel(parentEl, opts?) -> {
//     setText(str)              // the label text; '' clears. '\n' = new line.
//     setColor(cssColor)        // e.g. 'yellow', '#ff0', 'rgb(255,255,0)'
//     setCorner('tl'|'tr'|'bl'|'br')   // which corner to anchor to
//     resize()                  // re-fit to the parent/window (also auto on resize)
//     clear()                   // erase without changing the stored text
//     dispose()                 // remove the canvas + listeners
//   }
//   opts (all optional): { text, color, corner, zIndex, family, fontUrl,
//                          sizeFactor, minSize, maxSize, outline }.
//   Generic on purpose: any string, any CSS color, any corner -- so glsnake and
//   circuit can reuse it unchanged.

let faceSeq = 0;   // unique-ish family suffix per distinct font url (dedup below)
const loadedFamilies = new Map();   // fontUrl -> { family, ready(Promise) }

// Load (once per url) a FontFace and register it on document.fonts. Returns a
// { family, ready } handle; `ready` resolves when the glyphs are usable.
function ensureFont(fontUrl, baseFamily) {
  const key = fontUrl;
  const hit = loadedFamilies.get(key);
  if (hit) return hit;
  const family = baseFamily + '_' + (++faceSeq);
  let ready;
  try {
    const face = new FontFace(family, 'url(' + fontUrl + ')');
    ready = face.load().then((f) => {
      document.fonts.add(f);
      return family;
    }).catch(() => null);
  } catch (e) {
    ready = Promise.resolve(null);
  }
  const rec = { family, ready };
  loadedFamilies.set(key, rec);
  return rec;
}

export function makeHudLabel(parentEl, opts = {}) {
  const parent = parentEl || document.body;

  const state = {
    text: opts.text || '',
    color: opts.color || '#ffffff',
    corner: opts.corner || 'tl',
    sizeFactor: opts.sizeFactor || 0.030,   // fraction of overlay height
    minSize: opts.minSize || 12,
    maxSize: opts.maxSize || 40,
    outline: opts.outline !== false,        // draw the contrasting border (default on)
    fontSize: 18,
  };

  // ---- overlay canvas: transparent, above the GL canvas, non-interactive ----
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:' +
    (opts.zIndex != null ? opts.zIndex : 2) +
    '; pointer-events:none; background:transparent;';
  parent.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // ---- font resolution ----
  //   opts.fontUrl        -> load that FontFace and use it (+ monospace fallback).
  //   opts.family (no url) -> use that CSS family directly (e.g. 'sans-serif'); a
  //                           system/generic family needs no FontFace load.
  //   neither             -> the bundled Luxi Mono default (engine's title font).
  let cssFamily;
  let fontReady = false;
  if (opts.fontUrl) {
    const font = ensureFont(opts.fontUrl, opts.family || 'JScreenSaverHUD');
    cssFamily = "'" + font.family + "', monospace";
    font.ready.then((fam) => { if (fam) { fontReady = true; draw(); } });
  } else if (opts.family) {
    cssFamily = opts.family;                 // system/generic family; nothing to load
    fontReady = true;
  } else {
    const font = ensureFont(new URL('./fonts/luximr.ttf', import.meta.url).href, 'JScreenSaverHUD');
    cssFamily = "'" + font.family + "', monospace";
    font.ready.then((fam) => { if (fam) { fontReady = true; draw(); } });
  }

  // Rec.709 luminance of a css color, via a 1x1 probe. Used to pick the outline
  // shade the way print_texture_label does (luma > 0.4 -> dark border, else light).
  function outlineColorFor(cssColor) {
    let r = 255, g = 255, b = 255;
    try {
      ctx.save();
      ctx.fillStyle = cssColor;
      const resolved = ctx.fillStyle;   // normalized to #rrggbb or rgba(...)
      ctx.restore();
      if (resolved[0] === '#') {
        r = parseInt(resolved.slice(1, 3), 16);
        g = parseInt(resolved.slice(3, 5), 16);
        b = parseInt(resolved.slice(5, 7), 16);
      } else {
        const m = resolved.match(/[\d.]+/g);
        if (m) { r = +m[0]; g = +m[1]; b = +m[2]; }
      }
    } catch (e) { /* keep defaults */ }
    const luma = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
    return luma > 0.4 ? '#000000' : '#ffffff';
  }

  let dpr = 1, cssW = 0, cssH = 0;

  function fontString() {
    return state.fontSize + 'px ' + cssFamily;
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = parent.clientWidth || window.innerWidth;
    cssH = parent.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    state.fontSize = Math.max(
      state.minSize,
      Math.min(state.maxSize, Math.round(cssH * state.sizeFactor)),
    );
    draw();
  }

  function clear() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function draw() {
    clear();
    if (!state.text) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // work in CSS px
    ctx.font = fontString();
    ctx.textBaseline = 'top';

    const size = state.fontSize;
    const margin = Math.round(size * 0.8);     // ~ one ascent, like position 1's x=ascent
    const lineH = Math.round(size * 1.2);
    const lines = String(state.text).split('\n');
    const totalH = lineH * lines.length;

    const right = state.corner === 'tr' || state.corner === 'br';
    const bottom = state.corner === 'bl' || state.corner === 'br';
    ctx.textAlign = right ? 'right' : 'left';
    const x = right ? cssW - margin : margin;
    const y0 = bottom ? cssH - margin - totalH : margin;

    const off = Math.max(1, Math.round(size / 18));   // outline thickness, proportional
    const outlineColor = outlineColorFor(state.color);

    for (let i = 0; i < lines.length; i++) {
      const ly = y0 + i * lineH;
      if (state.outline) {
        ctx.fillStyle = outlineColor;
        ctx.fillText(lines[i], x - off, ly - off);
        ctx.fillText(lines[i], x - off, ly + off);
        ctx.fillText(lines[i], x + off, ly + off);
        ctx.fillText(lines[i], x + off, ly - off);
      }
      ctx.fillStyle = state.color;
      ctx.fillText(lines[i], x, ly);
    }
  }

  window.addEventListener('resize', resize);
  resize();

  return {
    setText(str) {
      const s = str == null ? '' : String(str);
      if (s === state.text) return;
      state.text = s;
      draw();
    },
    setColor(cssColor) {
      state.color = cssColor;
      draw();
    },
    setCorner(corner) {
      state.corner = corner;
      draw();
    },
    resize,
    clear,
    dispose() {
      window.removeEventListener('resize', resize);
      canvas.remove();
    },
    // Exposed for callers/tests that want to know the loaded state.
    get fontReady() { return fontReady; },
  };
}

export default makeHudLabel;
