// forest.js -- forest packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's forest.c (aka xtree.c), Peter Baumung 1999, built on
// code by Jamie Zawinski. https://www.jwz.org/xscreensaver/
//
// Grows a fractal forest one tree per frame. Each tree is a recursive fractal:
// draw_tree_rec draws a tapered branch, then (while the branch is still thick
// enough) recurses into a slightly-straightened continuation plus two side
// branches with jittered angle/length; once a branch is thin enough it sprouts
// a cluster of round leaves. Trees are placed back-to-front -- their roots sweep
// from above the top edge down past the bottom (toDo counts down), so nearer
// trees overpaint farther ones. When ~24 trees have been planted the screen
// lingers briefly, then clears and a new forest grows in a fresh seasonal hue.
//
// Rendering: the C draws each branch as `widths` adjacent 1px XDrawLines shaded
// across its width in 4 trunk colours, plus XFillArc leaves. This port draws a
// branch as 4 filled cross-section bands (a solid tapered quad per trunk colour)
// and leaves as filled circles, bucketing both into one Path2D per colour so a
// whole tree paints in ~8 fill() calls. See [[ccurve]] for the recursive twin.

export const title = 'forest';

export const info = {
  author: 'Peter Baumung',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nFractal trees.',
  year: 1999,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/forest.xml. `delay` is microseconds
  // between trees (one tree per step), xml default 500000; `ncolors` is the
  // palette size (4 trunk shades + up to 16 seasonal leaf hues). Both xml
  // sliders are kept; `delay` is live, so the grow can be sped up at will.
  const config = {
    delay: 500000,     // microseconds between trees (--delay; xml default 500000)
    ncolors: 20,       // palette size, max 20 (--ncolors)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 3000000, step: 10000, default: 500000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 1, max: 20, step: 1, default: 20, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // The C's seasonal palette: colorM is a 12-hue rainbow, colorV a matching
  // per-hue darkening step. A forest's leaves use 4 consecutive hues starting at
  // a random `season`, each in 4 shades (colorM - 2*colorV*k, k=0..3).
  const colorM = [
    0xff0000, 0xff8000, 0xffff00, 0x80ff00,
    0x00ff00, 0x00ff80, 0x00ffff, 0x0080ff,
    0x0000ff, 0x8000ff, 0xff00ff, 0xff0080,
  ];
  const colorV = [
    0x0a0000, 0x0a0500, 0x0a0a00, 0x050a00,
    0x000a00, 0x000a05, 0x000a0a, 0x00050a,
    0x00000a, 0x05000a, 0x0a000a, 0x0a0005,
  ];

  const PI_2 = Math.PI / 2;
  const WHITE = 'rgb(255,255,255)';

  let W, H;              // canvas size, device px (treeSize scales with H, so retina is automatic)
  let ncolors;           // effective colour count (the C's `color`), 1..20
  let season;            // 0..11, picks the leaf hue band
  let palette;           // ncolors CSS colour strings

  // Driver state (the C's tree-> fields for the single screen).
  let todo;              // trees left to plant this forest (counts down from 25)
  let pauseCount;        // linger countdown between forests
  let treeX, treeY;      // current tree root, device px
  let treeThick;         // current tree's base thickness (int 7..11)
  let treeSize;          // current tree's scale (H/480)
  let treeColor;         // leaf-colour group base index for the current tree

  // NRAND(n): integer in [0, n). rRand(a, b): double in [a, b).
  const rand = (n) => Math.floor(Math.random() * n);
  const rRand = (a, b) => a + (b - a) * Math.random();

  const rgb = (r, g, b) => `rgb(${r},${g},${b})`;

  // Build the palette for the current `ncolors`/`season`, transcribing the C's
  // init_trees colour setup: trunk shades in 0..3, seasonal leaf hues in 4..n-1.
  function buildPalette() {
    const n = ncolors;
    palette = new Array(n);
    if (n < 4) {
      // Mono fallback: black/white (the C's grayscale ramp).
      for (let i = 0; i < n; i++) {
        const v = 255 * (i & 1);
        palette[i] = rgb(v, v, v);
      }
    } else if (n < 8) {
      // Few colours: 4 light grays for the trunk.
      for (let i = 0; i < 4 && i < n; i++) {
        const v = 128 + 16 * (i % 4);
        palette[i] = rgb(v, v, v);
      }
    } else {
      // Full colour: 4 brown trunk shades.
      for (let i = 0; i < 4; i++) {
        palette[i] = rgb(96 + 16 * (i % 4), 40 + 8 * (i % 4), 0);
      }
    }
    // Seasonal leaf hues: 4 hue groups of 4 shades each (only when n >= 8 does a
    // tree actually pick from these; for n in 4..7 they exist but go unused).
    for (let i = 4; i < n; i++) {
      const s = (season + Math.floor((i - 4) / 4)) % 12;
      const c = colorM[s] - 2 * colorV[s] * (i % 4);   // < 2^24, so the shifts below are safe
      palette[i] = rgb((c >> 16) & 255, (c >> 8) & 255, c & 255);
    }
  }

  // Per-step colour -> Path2D buckets (built fresh each tree, drawn at the end).
  let branchBuckets, leafBuckets;
  function bucket(map, color) {
    let p = map.get(color);
    if (!p) {
      p = new Path2D();
      map.set(color, p);
    }
    return p;
  }

  // draw_line: a branch as a tapered band, `widths` device px at the start
  // narrowing to `widthe` at the end, shaded across its width in 4 trunk colours
  // (colours 0..3). The C draws `widths` adjacent strands; we fill 4 equal
  // cross-section bands instead -- identical solid band, far fewer ops. The
  // `widths < 1` early-out matches the C, whose strand loop draws nothing then.
  function drawBranch(x1, y1, x2, y2, angle, widths, widthe) {
    if (widths < 1) return;
    const sn = Math.sin(angle + PI_2);
    const cs = Math.cos(angle + PI_2);
    // Start/end cross-section edges (fraction 0 .. 1 across the band).
    const sx1 = x1 - 0.5 * widths * sn, sy1 = y1 - 0.5 * widths * cs;
    const sx2 = x1 + 0.5 * widths * sn, sy2 = y1 + 0.5 * widths * cs;
    const ex1 = x2 - 0.5 * widthe * sn, ey1 = y2 - 0.5 * widthe * cs;
    const ex2 = x2 + 0.5 * widthe * sn, ey2 = y2 + 0.5 * widthe * cs;
    for (let k = 0; k < 4; k++) {
      const f0 = k / 4;
      const f1 = (k + 1) / 4;
      const color = ncolors >= 4 ? palette[k] : WHITE;
      const path = bucket(branchBuckets, color);
      path.moveTo(sx1 + (sx2 - sx1) * f0, sy1 + (sy2 - sy1) * f0);
      path.lineTo(sx1 + (sx2 - sx1) * f1, sy1 + (sy2 - sy1) * f1);
      path.lineTo(ex1 + (ex2 - ex1) * f1, ey1 + (ey2 - ey1) * f1);
      path.lineTo(ex1 + (ex2 - ex1) * f0, ey1 + (ey2 - ey1) * f0);
      path.closePath();
    }
  }

  // draw_tree_rec: branch from (x,y) at `angle` (0 = straight up), then recurse.
  function drawTreeRec(thick, x, y, angle) {
    const length = (24 + rand(12)) * treeSize;
    const a = x - length * Math.sin(angle);
    const b = y - length * Math.cos(angle);

    drawBranch(x, y, a, b, angle, thick * treeSize, 0.68 * thick * treeSize);

    if (thick > 2) {
      // Main continuation, straightening toward vertical (0.8 * angle).
      drawTreeRec(0.68 * thick, a, b, 0.8 * angle + rRand(-0.2, 0.2));
      // Two side branches, but not on the very first (trunk) segment.
      if (thick < treeThick - 1) {
        drawTreeRec(0.68 * thick, a, b, angle + rRand(0.2, 0.9));
        drawTreeRec(0.68 * thick, (a + x) / 2, (b + y) / 2, angle - rRand(0.2, 0.9));
      }
    }

    // Thin twigs sprout a cluster of round leaves around the branch tip.
    if (thick < 0.5 * treeThick) {
      const nleaf = 12 + rand(4);
      const color = ncolors >= 4 ? palette[treeColor + rand(4)] : WHITE;
      const path = bucket(leafBuckets, color);
      for (let i = 0; i < nleaf; i++) {
        const lx = a + treeSize * rRand(-12, 12);
        const ly = b + treeSize * rRand(-12, 12);
        const r = treeSize * rRand(2, 6) / 2;     // XFillArc width is the diameter
        const cx = lx + r;
        const cy = ly + r;
        path.moveTo(cx + r, cy);
        path.arc(cx, cy, r, 0, 2 * Math.PI);
      }
    }
  }

  // draw_trees: one frame == one tree (or a step of the linger state machine).
  function step() {
    // draw_trees' state machine, transcribed exactly: pause==1 reseeds AND falls
    // through to draw this frame's tree (the C does NOT return there); pause>1
    // holds the finished forest; otherwise --todo, and when it hits 0 arm a
    // 6-frame linger. After a reseed the first tree drawn has todo==25, whose
    // root sits above the top edge (y<0) and grows upward -- off-screen, exactly
    // as in the C (only todo 24..1 are ever visible).
    if (pauseCount === 1) {
      pauseCount--;     // -> 0
      seedForest();     // init_trees: clear, new season + palette, todo=25
      // fall through and draw this frame's tree (todo stays 25)
    } else if (pauseCount > 1) {
      pauseCount--;
      return;
    } else if (--todo === 0) {
      pauseCount = 6;   // forest complete; linger before reseeding
      return;
    }

    treeX = rand(W);
    treeY = 1.25 * H * (1 - todo / 23.0);
    treeThick = Math.floor(rRand(7, 12));
    treeSize = H / 480.0;
    if (ncolors < 8) {
      treeColor = 0;
    } else {
      treeColor = 4 * (1 + rand(Math.floor(ncolors / 4) - 1));
    }

    branchBuckets = new Map();
    leafBuckets = new Map();
    drawTreeRec(treeThick, treeX, treeY, rRand(-0.1, 0.1));

    // Branches first, then leaves, so foliage crowns the twigs (the C interleaves
    // them per node; a slight z-order shift, but the per-tree paint order holds).
    for (const [color, path] of branchBuckets) {
      ctx.fillStyle = color;
      ctx.fill(path);
    }
    for (const [color, path] of leafBuckets) {
      ctx.fillStyle = color;
      ctx.fill(path);
    }
  }

  // init_trees: clear, pick a new season + palette, arm the tree counter.
  function seedForest() {
    season = rand(12);
    buildPalette();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    todo = 25;
  }

  function init() {
    W = canvas.width;
    H = canvas.height;
    ncolors = Math.min(20, Math.max(1, Math.round(config.ncolors)));
    pauseCount = 0;
    seedForest();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // Fixed-timestep loop (squiral style): one step() per config.delay, banking
  // leftover time so the pace is the same at any refresh rate. Catch-up is capped
  // small since each step paints a whole tree.
  const MAX_CATCHUP_STEPS = 4;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = config.delay / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  resize();
  rafId = requestAnimationFrame(frame);

  return {
    stop() {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
    },
    pause() { cancelAnimationFrame(rafId); rafId = 0; },
    resume() { if (!rafId) { lastTime = 0; rafId = requestAnimationFrame(frame); } },
    reinit() { init(); },   // fresh forest with the current config
    config,
    params,
  };
}
