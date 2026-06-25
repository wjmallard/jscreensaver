// wipes.js — screen-erase transitions packaged as a standalone module.
//
// Port of xscreensaver's utils/erase.c (Jamie Zawinski, 1997–2025; with
// portions by Johannes Keukelaar, Torbjörn Andersson, and Frederick Roeber).
// https://www.jwz.org/xscreensaver/
//
// These are the "goofy wipes" that clear the screen between patterns: venetian
// blinds, an expanding/contracting circle, a spiral sweep, a scatter of random
// squares, directional slides, a diagonal wedge sweep, a dissolve, and so on.
//
//   import { WIPE_NAMES, wipe } from './wipes.js';
//   const t = wipe(canvas, { style: 'spiral', durationMs: 600, color: '#000',
//                            onDone: () => regenerate() });
//   // t.cancel() stops the rAF and leaves the canvas wherever it got to.
//
// Each transition is a *stepper*: a function paint(t) that, given normalized
// progress t in [0,1], paints the CUMULATIVE covered region at time t. Driving
// t from 0 to 1 therefore yields a smooth wipe, and at t === 1 the whole canvas
// is a solid `color` fill (these are used to fully clear the screen, so there
// must be no leftover pixels). A stepper is produced by a factory that runs
// once at wipe-start, so any per-run randomness (direction, shuffle order) and
// any precomputed reveal order are fixed for the duration of that wipe.
//
// In erase.c each mode paints only the slice between prev_ratio and ratio (an
// incremental draw onto the live window). Here we repaint the cumulative region
// every frame instead — same end state, but it doesn't depend on a particular
// frame cadence and a dropped frame can never leave a gap.
//
// Rendering note: this works on the canvas's existing device-pixel backing
// store. It does NOT resize the canvas and does NOT read devicePixelRatio — it
// just uses canvas.width / canvas.height as-is, so it composites correctly over
// whatever a hack already drew at that resolution.

// One string id per transition, in roughly the erase.c order. 'random' is not
// listed here; it is the wipe() default and picks one of these uniformly.
export const WIPE_NAMES = [
  'venetianH',     // horizontal venetian blinds (interleaved rows)
  'venetianV',     // vertical venetian blinds (interleaved columns)
  'randomLines',   // rows (or columns) revealed in shuffled order
  'circleOut',     // a filled circle growing from the centre
  'circleIn',      // a ring closing inward to the centre
  'pie',           // a pie wedge sweeping around the centre
  'spiral',        // a 10-turn spiral fanning out from the centre
  'randomSquares', // a grid of cells filled in shuffled order
  'slideLeft',     // horizontal bands sliding off, alternating direction
  'slideUp',       // vertical bands sliding off, alternating direction
  'wedge',         // four triangles sweeping in from the edges (squaretate)
  'diagonal',      // a diagonal band sweeping corner to corner
  'dissolve',      // a pseudo-random pixel fizzle
  'boxOut',        // a rectangle growing from the centre
];

// Clamp v into [min, max].
function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

// A shuffled [0, 1, ..., n-1], Fisher–Yates (erase.c's shuffle, done right —
// the C shuffle has a slight bias; this one is uniform).
function shuffledIndices(n) {
  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}

// ---------------------------------------------------------------------------
// Stepper factories. Each returns paint(t) painting the cumulative covered
// region at progress t. ctx.fillStyle is set to `color` by the caller before
// every frame, so a factory only needs to set it again if it changes it.
// ---------------------------------------------------------------------------

// Venetian blinds: split the axis into `slats` bands and, within each band,
// grow a fill from one edge. All bands grow in lockstep, so the screen fills
// like interleaved blinds closing. erase.c interleaves line indices for the
// same effect; growing a sub-rect per slat is the idiomatic canvas version.
function makeVenetian(ctx, W, H, horiz) {
  const span = horiz ? H : W;
  const slats = clamp(Math.round(span / 24), 6, 64);
  const slat = span / slats;
  const flip = Math.random() < 0.5;   // grow from the far edge instead

  return (t) => {
    const grown = slat * t;
    for (let i = 0; i < slats; i++) {
      const base = i * slat;
      const off = flip ? base + (slat - grown) : base;
      if (horiz) ctx.fillRect(0, off, W, grown);
      else ctx.fillRect(off, 0, grown, H);
    }
  };
}

// Random lines: reveal whole rows (or columns) one at a time in a fixed
// shuffled order — floor(t * count) of them are filled by progress t.
function makeRandomLines(ctx, W, H) {
  const horiz = Math.random() < 0.5;
  const count = horiz ? H : W;
  const order = shuffledIndices(count);

  return (t) => {
    const n = Math.floor(t * count);
    for (let i = 0; i < n; i++) {
      const line = order[i];
      if (horiz) ctx.fillRect(0, line, W, 1);
      else ctx.fillRect(line, 0, 1, H);
    }
  };
}

// Circle out / in: a filled disc centred on the screen whose radius tracks t.
// `radius` covers the corners (half the diagonal) so the fill reaches every
// pixel by t === 1. circleIn paints the complement — an annulus closing in —
// by filling the whole screen and punching a shrinking hole, which we emulate
// by drawing the outside ring as a fat stroke that thickens to full coverage.
function makeCircle(ctx, W, H, inward) {
  const cx = W / 2;
  const cy = H / 2;
  const maxR = Math.hypot(W, H) / 2;

  if (!inward) {
    return (t) => {
      ctx.beginPath();
      ctx.arc(cx, cy, maxR * t, 0, Math.PI * 2);
      ctx.fill();
    };
  }

  // Closing ring: fill the band between the shrinking inner radius and maxR.
  // An even-odd path (outer circle minus inner circle) gives a clean annulus.
  return (t) => {
    const inner = maxR * (1 - t);
    ctx.beginPath();
    ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
    ctx.arc(cx, cy, inner, 0, Math.PI * 2, true);   // reverse winding = hole
    ctx.fill('evenodd');
  };
}

// Pie: a single wedge sweeping around the centre from a random start angle,
// its swept angle growing to a full turn. erase.c's circle_wipe fills an arc
// whose extent tracks ratio; this is that, drawn as a pie slice.
function makePie(ctx, W, H) {
  const cx = W / 2;
  const cy = H / 2;
  const maxR = Math.hypot(W, H) / 2;
  const start = Math.random() * Math.PI * 2;
  const dir = Math.random() < 0.5 ? 1 : -1;

  return (t) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, maxR, start, start + dir * Math.PI * 2 * t, dir < 0);
    ctx.closePath();
    ctx.fill();
  };
}

// Spiral: a 10-turn spiral fanning out from the centre, drawn as a fan of thin
// triangles from the centre to consecutive points along the spiral, exactly as
// erase.c's spiral mode. Painting the first floor(t * steps) triangles each
// frame sweeps the fill outward; by t === 1 the overlapping wedges cover all.
function makeSpiral(ctx, W, H) {
  const cx = W / 2;
  const cy = H / 2;
  const loops = 10;
  const steps = Math.max(64, Math.round((90 * loops)));   // 360*loops/4
  const maxTh = Math.PI * 2 * loops;
  const maxR = Math.max(W, H) * 0.75;   // overshoot so the arms reach corners
  const off = Math.random() * Math.PI * 2;
  const flip = Math.random() < 0.5;

  return (t) => {
    const n = Math.floor(t * steps);
    for (let i = 0; i < n; i++) {
      let th1 = (i * maxTh) / steps;
      let th2 = ((i + 1) * maxTh) / steps;
      if (flip) {
        th1 = maxTh - th1;
        th2 = maxTh - th2;
      }
      const r1 = (i * maxR) / steps;
      const r2 = ((i + 1) * maxR) / steps;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + r1 * Math.cos(off + th1), cy + r1 * Math.sin(off + th1));
      ctx.lineTo(cx + r2 * Math.cos(off + th2), cy + r2 * Math.sin(off + th2));
      ctx.closePath();
      ctx.fill();
    }
  };
}

// Random squares: split the screen into a grid and fill the cells in a fixed
// shuffled order, floor(t * total) of them by progress t. Cells overlap by a
// pixel (cellW/cellH rounded up) so no seams survive at t === 1.
function makeRandomSquares(ctx, W, H) {
  const cols = 10 + Math.floor(Math.random() * 30);
  const cell = W / cols;
  const rows = (cell ? Math.floor(H / cell) : 0) + 1;
  const total = cols * rows;
  const order = shuffledIndices(total);
  const cw = Math.ceil(W / cols) + 1;
  const ch = Math.ceil(H / rows) + 1;

  return (t) => {
    const n = Math.floor(t * total);
    for (let i = 0; i < n; i++) {
      const cellIdx = order[i];
      const cxCell = cellIdx % cols;
      const cyCell = Math.floor(cellIdx / cols);
      ctx.fillRect(
        Math.floor((W * cxCell) / cols),
        Math.floor((H * cyCell) / rows),
        cw,
        ch,
      );
    }
  };
}

// Slide: divide the axis into bands; each band fills from one end, with the
// direction alternating band-to-band (the original "slide_lines" Tetris-ish
// look, minus the X11 pixel-copy of the underlying image — we just paint the
// covered strip). A small overshoot (1.05) guarantees full coverage at t === 1.
function makeSlide(ctx, W, H, horiz) {
  const along = horiz ? W : H;
  const across = horiz ? H : W;
  const bands = clamp(Math.round(across / Math.max(10, across / 40)), 4, 64);
  const band = across / bands;
  const reach = along * 1.05;

  return (t) => {
    const covered = reach * t;
    for (let i = 0; i < bands; i++) {
      const base = i * band;
      const fromFar = i & 1;   // odd bands slide in from the far end
      if (horiz) {
        const x = fromFar ? Math.max(0, along - covered) : 0;
        ctx.fillRect(x, base, covered, band);
      } else {
        const y = fromFar ? Math.max(0, along - covered) : 0;
        ctx.fillRect(base, y, band, covered);
      }
    }
  };
}

// Wedge (erase.c's "squaretate"): four right triangles, one hinged at each
// corner, each sweeping a growing edge across the screen. Together they close
// in like an iris of straight blades. Optionally mirrored horizontally.
function makeWedge(ctx, W, H) {
  const flip = Math.random() < 0.5;

  const tri = (ax, ay, bx, by, cx, cy) => {
    ctx.beginPath();
    if (flip) {
      ctx.moveTo(W - ax, ay);
      ctx.lineTo(W - bx, by);
      ctx.lineTo(W - cx, cy);
    } else {
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineTo(cx, cy);
    }
    ctx.closePath();
    ctx.fill();
  };

  return (t) => {
    tri(0, 0, W, 0, 0, H * t);                  // top edge growing down
    tri(0, 0, 0, H, W * t, H);                  // left edge growing right
    tri(W, H, 0, H, W, H - H * t);              // bottom edge growing up
    tri(W, H, W, 0, W - W * t, 0);              // right edge growing left
  };
}

// Diagonal: a band perpendicular to a corner-to-corner axis sweeps across, so
// the fill advances as a slanted edge. The sweep distance spans the projection
// of the whole rectangle onto the axis, so coverage is complete at t === 1.
// (A canvas-idiomatic relative of triple_wipe / quad_wipe's slanted sweeps.)
function makeDiagonal(ctx, W, H) {
  // Pick one of the four diagonal directions.
  const sx = Math.random() < 0.5 ? 1 : -1;
  const sy = Math.random() < 0.5 ? 1 : -1;
  // Sum of |projections| of the rectangle's extent onto the sweep direction —
  // the total distance the slanted front travels to cover the whole rectangle.
  const span = Math.abs(W) + Math.abs(H);
  // The corner the sweep starts from (where (p - start)·dir is smallest).
  const x0 = sx > 0 ? 0 : W;
  const y0 = sy > 0 ? 0 : H;
  // The rectangle as a polygon, clockwise; we clip this to the covered half.
  const rect = [[0, 0], [W, 0], [W, H], [0, H]];
  // Signed depth of a point past the start corner along the sweep direction.
  const depth = (x, y) => sx * (x - x0) + sy * (y - y0);

  return (t) => {
    const front = span * t;   // how far the slanted edge has advanced
    // Clip `rect` to the half-plane depth(p) <= front (Sutherland–Hodgman):
    // keep covered vertices, and add the crossing point on each edge that
    // straddles the front. Always a convex polygon, so the fill is exact.
    const out = [];
    for (let i = 0; i < rect.length; i++) {
      const a = rect[i];
      const b = rect[(i + 1) % rect.length];
      const da = depth(a[0], a[1]) - front;
      const db = depth(b[0], b[1]) - front;
      if (da <= 0) out.push(a);
      if ((da < 0) !== (db < 0)) {
        const k = da / (da - db);   // fraction from a to b where depth == front
        out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
      }
    }
    if (out.length < 3) return;
    ctx.beginPath();
    ctx.moveTo(out[0][0], out[0][1]);
    for (let i = 1; i < out.length; i++) ctx.lineTo(out[i][0], out[i][1]);
    ctx.closePath();
    ctx.fill();
  };
}

// Dissolve: erase.c's "fizzle" — pseudo-random pixels turn on until the screen
// is full. We tile the screen with small blocks (so it's cheap, not per-pixel)
// and reveal the blocks in a fixed shuffled order; a tiny overshoot makes sure
// the last block lands by t === 1. Reads chunky but unmistakably a fizzle.
function makeDissolve(ctx, W, H) {
  const block = 6;
  const cols = Math.ceil(W / block);
  const rows = Math.ceil(H / block);
  const total = cols * rows;
  const order = shuffledIndices(total);

  return (t) => {
    const n = Math.min(total, Math.floor(t * total * 1.04));
    for (let i = 0; i < n; i++) {
      const idx = order[i];
      const bx = (idx % cols) * block;
      const by = Math.floor(idx / cols) * block;
      ctx.fillRect(bx, by, block, block);
    }
  };
}

// Box out: a rectangle growing from the centre to the edges (the simplest of
// the family — like circleOut, but square). Scales both half-extents by t.
function makeBoxOut(ctx, W, H) {
  const cx = W / 2;
  const cy = H / 2;

  return (t) => {
    const hw = (W / 2) * t;
    const hh = (H / 2) * t;
    ctx.fillRect(cx - hw, cy - hh, hw * 2, hh * 2);
  };
}

// id -> factory(ctx, W, H) -> paint(t). Kept in WIPE_NAMES order.
const FACTORIES = {
  boxOut: (ctx, W, H) => makeBoxOut(ctx, W, H),
  circleIn: (ctx, W, H) => makeCircle(ctx, W, H, true),
  circleOut: (ctx, W, H) => makeCircle(ctx, W, H, false),
  diagonal: (ctx, W, H) => makeDiagonal(ctx, W, H),
  dissolve: (ctx, W, H) => makeDissolve(ctx, W, H),
  pie: (ctx, W, H) => makePie(ctx, W, H),
  randomLines: (ctx, W, H) => makeRandomLines(ctx, W, H),
  randomSquares: (ctx, W, H) => makeRandomSquares(ctx, W, H),
  slideLeft: (ctx, W, H) => makeSlide(ctx, W, H, true),
  slideUp: (ctx, W, H) => makeSlide(ctx, W, H, false),
  spiral: (ctx, W, H) => makeSpiral(ctx, W, H),
  venetianH: (ctx, W, H) => makeVenetian(ctx, W, H, true),
  venetianV: (ctx, W, H) => makeVenetian(ctx, W, H, false),
  wedge: (ctx, W, H) => makeWedge(ctx, W, H),
};

// Progressively paint `color` over the canvas in the chosen transition, over
// ~durationMs, then call onDone(). Self-driven via requestAnimationFrame.
//
// Operates on the canvas's existing device-pixel backing store: it reads
// canvas.width / canvas.height as-is and never resizes the canvas or touches
// devicePixelRatio, so it layers correctly over whatever the canvas held.
//
// Returns { cancel }; cancel() stops the rAF and leaves the canvas as-is
// (whatever fraction had been painted when cancelled stays on screen).
export function wipe(canvas, {
  style = 'random',
  durationMs = 600,
  color = '#000',
  onDone = () => {},
} = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  // Resolve 'random' (or any unknown id) to a concrete transition once.
  let id = style;
  if (id === 'random' || !FACTORIES[id]) {
    id = WIPE_NAMES[Math.floor(Math.random() * WIPE_NAMES.length)];
  }
  const paint = FACTORIES[id](ctx, W, H);

  // A zero/negative duration means "snap to fully cleared on the next frame".
  const duration = Math.max(1, durationMs);

  let rafId = 0;
  let start = 0;
  let done = false;

  function frame(now) {
    if (start === 0) start = now;
    const t = Math.min(1, (now - start) / duration);

    ctx.fillStyle = color;
    paint(t);

    if (t >= 1) {
      // Guarantee a flawless solid fill at the end regardless of any rounding
      // or sub-pixel seams a stepper might have left.
      ctx.fillRect(0, 0, W, H);
      done = true;
      onDone();
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  rafId = requestAnimationFrame(frame);

  return {
    cancel() {
      if (done) return;
      done = true;
      cancelAnimationFrame(rafId);
    },
  };
}
