// bubbles.js — bubbles packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's bubbles.c (James Macnicol, 1995-1996).
// https://www.jwz.org/xscreensaver/
//
// Soft-drink / boiling-water fizz: small bubbles appear, rise with buoyancy,
// and when two touch they MERGE — their areas add, the survivor moves to the
// area-weighted mean of the two centres, and its radius grows to match the new
// area. A bubble pops when it rises off the top edge (rise mode), or — in float
// mode — when a merge would push it past the maximum size. The C divides the
// screen into a square mesh and only searches a bubble's own cell plus the eight
// neighbours for collisions; we keep that spatial mesh (rebuilt each step).
//
// We port ONLY the procedural "simple" / drawn-circle path. The default fancy
// mode blits a big embedded PNG sprite per bubble (the bulk of the 1467-line C
// file is that bitmap); a browser has no use for it, so it is dropped — see the
// .md. Each circle is drawn as a radial-gradient disc so the highlight reads as
// a rounded 3D bubble.
//
// Rendering: filled gradient circles via ctx.arc — canvas VECTOR ops, FULL
// REPAINT each frame (clear to black, draw every bubble). The C draws/erases
// each bubble incrementally with X11 GCs; a straight clear-and-redraw is the
// canvas equivalent and avoids erase "turds".

export const title = 'bubbles';

export const info = {
  author: 'James Macnicol',
  description: 'A simulation of the bubble formation that happens when water boils: small bubbles appear and, as they get closer to each other, combine to form larger bubbles which eventually pop.',
  year: 1996,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/bubbles.xml. `delay` is a touch calmer
  // than the stock 10000 us by feel. `mode` is the xml's "gravity" select; we
  // default to "rise" (the xml defaults to "float") because rising fizz is the
  // nicer look and matches this hack's classic soft-drink description. The
  // stock UI's "simple" toggle is gone (we only draw circles), and "broken"
  // (don't erase popped bubbles) is meaningless under a full repaint — both are
  // dropped; `spacing`-free `spawnRate`, `sizeScale`, and `ncolors` are added.
  const config = {
    delay: 32000,      // \u00B5s between steps (--delay; stock 10000)
    mode: 'rise',      // 'rise' | 'float' | 'drop' (--mode)
    spawnRate: 3,      // new bubbles per step (the C adds 5/frame)
    sizeScale: 1,      // multiplies the screen-derived min/max radius
    ncolors: 64,       // size of the rainbow hue cycle
    trails: false,     // big rising bubbles shed a small one behind (--trails)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 32000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'mode', label: 'Motion', type: 'select', default: 'rise', live: true, options: [
        { value: 'rise', label: 'Bubbles rise' },
        { value: 'float', label: 'Bubbles float' },
        { value: 'drop', label: 'Bubbles fall' },
      ] },
    { key: 'spawnRate', label: 'Bubble rate', type: 'range', min: 1, max: 20, step: 1, default: 3, lowLabel: 'few', highLabel: 'many', live: true },
    { key: 'sizeScale', label: 'Bubble size', type: 'range', min: 0.4, max: 3, step: 0.1, default: 1, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'trails', label: 'Leave trails', type: 'checkbox', default: false, live: true },
  ];

  // Constants from bubbles.c / bubbles.h.
  // calc_bubble_area(r) = 10*PI*r^2 (the 2D path); area is monotonic in r so the
  // C's radius lookup table is exactly r = sqrt(area / AREA_K). MAX_DROPPAGE is
  // the largest rise step (px) the C gives the biggest bubble; we tune the rise
  // range a little calmer (MIN_RISE..MAX_RISE) and add a small floor so the
  // smallest bubbles still drift instead of freezing (the C gives radius==min a
  // droppage of 0). TOUCH_LEEWAY is the C's "+2" so circles never quite overlap.
  const AREA_K = 10 * Math.PI;
  const MIN_RISE = 1.5;
  const MAX_RISE = 12;       // stock MAX_DROPPAGE is 20; calmer here
  const TOUCH_LEEWAY = 2;
  const MERGE_GUARD = 100000; // belt-and-braces cap on a single merge cascade

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px
  let minR, maxR;     // bubble radius range, device px (screen-fraction sized)
  let minArea, maxArea;
  let meshLength;     // cell side, device px
  let meshW, meshH;   // mesh dimensions in cells
  let meshCells;      // meshW * meshH
  let mesh;           // per-cell array of bubble indices (rebuilt each step)
  let maxBubbles;     // hard cap so the pool can never overflow
  let bubbles;        // { x, y, r, area, hue, dead }

  // frand(x) = uniform float in [0, x), like the C.
  function frand(x) {
    return Math.random() * x;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // Invert calc_bubble_area, clamped to the radius range.
  function radiusFromArea(a) {
    return clamp(Math.sqrt(a / AREA_K), minR, maxR);
  }

  // How far a bubble of radius r rises per step (device px), bigger = faster.
  function risePixels(r) {
    const t = clamp((r - minR) / (maxR - minR), 0, 1);
    return (MIN_RISE + (MAX_RISE - MIN_RISE) * t) * S;
  }

  function randomHue() {
    const nc = Math.max(1, Math.round(config.ncolors));
    return Math.floor(Math.random() * nc) * 360 / nc;
  }

  // The mesh cell holding (x, y); clamped so it can never index out of bounds
  // even if a bubble is sitting exactly on an edge.
  function cellOf(x, y) {
    const cx = clamp(Math.floor(x / meshLength), 0, meshW - 1);
    const cy = clamp(Math.floor(y / meshLength), 0, meshH - 1);
    return cy * meshW + cx;
  }

  // Add one bubble. `initial` seeds the opening field (spread over the whole
  // screen, varied sizes) so frame 1 already looks mid-rise; ongoing spawns
  // start at min radius near the entry edge (bottom for rise, top for drop,
  // anywhere for float).
  function spawnBubble(initial) {
    let x, y, r;
    if (initial) {
      x = frand(W);
      y = frand(H);
      r = minR + frand(maxR - minR);
    } else {
      r = minR;
      x = frand(W);
      if (config.mode === 'rise') {
        y = H - 1 - frand(maxR * 2);
      } else if (config.mode === 'drop') {
        y = frand(maxR * 2);
      } else {
        y = frand(H);
      }
    }
    bubbles.push({
      x: clamp(x, 0, W - 1),
      y: clamp(y, 0, H - 1),
      r,
      area: AREA_K * r * r,
      hue: randomHue(),
      dead: false,
    });
  }

  // A big rising bubble occasionally sheds a small one behind it (leave_trail).
  function leaveTrail(b, dir, out) {
    const y = clamp(b.y + (b.r + 10 * S) * dir, 0, H - 1);
    out.push({
      x: b.x,
      y,
      r: minR,
      area: minArea,
      hue: b.hue,
      dead: false,
    });
  }

  // Bucket every live bubble into its mesh cell. Rebuilt from scratch each step
  // (O(n)), which sidesteps the C's incremental list bookkeeping on every move.
  function buildMesh() {
    mesh = new Array(meshCells);
    for (let i = 0; i < meshCells; i++) mesh[i] = [];
    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      if (b.dead) continue;
      mesh[cellOf(b.x, b.y)].push(i);
    }
  }

  // Closest bubble touching `b`, searching only its cell + 8 neighbours
  // (get_closest_bubble). touchdist = rA + rB + leeway, like the C's "+2".
  function findClosestTouching(b) {
    const cx = clamp(Math.floor(b.x / meshLength), 0, meshW - 1);
    const cy = clamp(Math.floor(b.y / meshLength), 0, meshH - 1);
    let best = null;
    let bestD2 = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = cy + dy;
      if (ny < 0 || ny >= meshH) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        if (nx < 0 || nx >= meshW) continue;
        const cell = mesh[ny * meshW + nx];
        for (let k = 0; k < cell.length; k++) {
          const o = bubbles[cell[k]];
          if (o === b || o.dead) continue;
          const ex = o.x - b.x;
          const ey = o.y - b.y;
          const sep2 = ex * ex + ey * ey;
          const td = o.r + b.r + TOUCH_LEEWAY * S;
          if (sep2 <= td * td && sep2 < bestD2) {
            best = o;
            bestD2 = sep2;
          }
        }
      }
    }
    return best;
  }

  // Two touching bubbles merge (merge_bubbles + bubble_eat): the bigger eats the
  // smaller (a tie is broken at random). The survivor takes the area-weighted
  // mean position, its area gains the food's area, and its radius is recomputed.
  // In rise/drop mode the area is clamped at the maximum (the bubble keeps going
  // until it leaves the screen); in float mode an over-max merge pops it.
  // Returns the surviving bubble, or null if it popped.
  function mergePair(a, o) {
    let diner, food;
    if (a.area > o.area) {
      diner = a;
      food = o;
    } else if (a.area < o.area) {
      diner = o;
      food = a;
    } else if (Math.random() < 0.5) {
      diner = a;
      food = o;
    } else {
      diner = o;
      food = a;
    }

    const total = diner.area + food.area;
    diner.x = (diner.x * diner.area + food.x * food.area) / total;
    diner.y = (diner.y * diner.area + food.y * food.area) / total;
    diner.area = total;
    food.dead = true;

    if (config.mode === 'float') {
      if (diner.area > maxArea) {
        diner.dead = true;
        return null;
      }
    } else if (diner.area > maxArea) {
      diner.area = maxArea;
    }
    diner.r = radiusFromArea(diner.area);
    return diner;
  }

  // One simulation step: spawn, move (+ off-screen pop), then merge.
  function step() {
    // 1. Spawn, never past the cap (so the pool can never overflow).
    const rate = Math.max(1, Math.round(config.spawnRate));
    for (let i = 0; i < rate && bubbles.length < maxBubbles; i++) {
      spawnBubble(false);
    }

    // 2. Rise/drop and pop anything that has left the screen. (float = no move.)
    const dir = config.mode === 'rise' ? -1 : config.mode === 'drop' ? 1 : 0;
    if (dir !== 0) {
      const trails = [];
      const n = bubbles.length;
      for (let i = 0; i < n; i++) {
        const b = bubbles[i];
        if (b.dead) continue;
        b.y += risePixels(b.r) * dir;
        if (b.y < -b.r || b.y > H + b.r) {
          b.dead = true;
          continue;
        }
        if (config.trails && b.r >= maxR * 0.95 && Math.random() < 0.5 &&
            bubbles.length + trails.length < maxBubbles) {
          leaveTrail(b, dir, trails);
        }
      }
      for (let i = 0; i < trails.length; i++) bubbles.push(trails[i]);
    }

    // 3. Merge every touching pair, cascading like insert_new_bubble: each merge
    //    kills one bubble, so a cascade is finite (the guard is pure paranoia).
    buildMesh();
    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      if (b.dead) continue;
      let cur = b;
      let closest = findClosestTouching(cur);
      let guard = 0;
      while (closest && guard++ < MERGE_GUARD) {
        const survivor = mergePair(cur, closest);
        if (survivor === null) break;
        cur = survivor;
        closest = findClosestTouching(cur);
      }
    }

    // 4. Drop the dead in one pass.
    bubbles = bubbles.filter((b) => !b.dead);
  }

  // Full repaint: clear, then draw each bubble as a radial-gradient disc with an
  // offset highlight (upper-left) so it reads as a rounded 3D bubble, plus a
  // thin rim. The canvas is double-buffered, so this is flicker-free.
  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const rim = Math.max(1, 1.2 * S);
    ctx.lineWidth = rim;
    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      const h = b.hue;
      const hx = b.x - b.r * 0.35;
      const hy = b.y - b.r * 0.35;
      const grad = ctx.createRadialGradient(hx, hy, b.r * 0.05, b.x, b.y, b.r);
      grad.addColorStop(0, `hsla(${h}, 100%, 92%, 0.95)`);
      grad.addColorStop(0.25, `hsla(${h}, 95%, 70%, 0.5)`);
      grad.addColorStop(0.85, `hsla(${h}, 90%, 50%, 0.18)`);
      grad.addColorStop(1, `hsla(${h}, 85%, 45%, 0.06)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `hsla(${h}, 80%, 80%, 0.55)`;
      ctx.stroke();
    }
  }

  // Size everything off the device-px canvas. Radii are screen fractions (the
  // C's 0.006 / 0.045 of the smaller dimension), so they already scale with dpr;
  // sizeScale is an extra user multiplier.
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    const md = Math.min(W, H);
    minR = Math.max(1, Math.floor(0.006 * md * config.sizeScale));
    maxR = Math.max(minR + 1, Math.floor(0.045 * md * config.sizeScale));
    minArea = AREA_K * minR * minR;
    maxArea = AREA_K * maxR * maxR;

    meshLength = 2 * maxR + 3;
    meshW = Math.floor(W / meshLength) + 1;
    meshH = Math.floor(H / meshLength) + 1;
    meshCells = meshW * meshH;

    // Generous cap that the merging/popping cycle never actually approaches, but
    // which guarantees the spawn loop can never overflow memory.
    maxBubbles = clamp(meshCells * 6 + 50, 200, 4000);

    bubbles = [];
    const seed = clamp(meshCells, 12, 400);
    for (let i = 0; i < seed; i++) spawnBubble(true);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced by config.delay (us): run one step() per delay,
  // banking leftover time so the speed is identical at any refresh rate, and cap
  // catch-up so a backgrounded tab can't burst on refocus. step() is the heavy
  // work (merge pass), so we draw at most once per frame.
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

    draw();
    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (size/colors change the field, so a non-live
  // edit rebuilds everything). init() does not paint, so clear first.
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
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
    reinit,
    config,
    params,
  };
}
