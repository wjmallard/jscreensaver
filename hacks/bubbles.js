// bubbles.js — bubbles packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's bubbles.c + bubbles-default.c (James Macnicol,
// 1995-1996; default image set by Jamie Zawinski). https://www.jwz.org/xscreensaver/
//
// Frying-pan / soft-drink fizz: tiny bubbles appear all over the screen and,
// where they touch, MERGE into bigger ones (areas add); big bubbles eventually
// pop. Area — not radius — is the conserved quantity: calc_bubble_area(r) =
// 10*PI*r^2 (the 2D path), so a bubble's radius follows from its area.
//
// TWO RENDER MODES, faithful to the C:
//  - FANCY (default): each bubble is a pre-rendered 3D-shaded sphere PNG, sized
//    to one of 11 fixed steps. bubbles-default.c picks ONE of four sprite sets
//    (blood / blue / glass / jade) at random per run (random() % 4); each set is
//    11 sprites of fixed pixel sizes (10..72 px). The sprite's own size sets the
//    bubble radius (radius = max(w,h)/2), and a 12th EXTRA step is extrapolated
//    beyond the largest sprite as the pop ceiling so the biggest bubble "hangs
//    around and doesn't pop immediately". We bundle all four sets under
//    hacks/images/bubbles/ and blit the step-appropriate sprite (its alpha is the
//    round mask). This is the demo-video look.
//  - SIMPLE (-simple): plain white (foreground) circle OUTLINES (XDrawArc) on
//    black, with the radius a screen fraction (0.006 .. 0.045 of min(W,H)).
//
// MOTION IS INSERT-DRIVEN, exactly as in the C. There is no "move every bubble"
// pass: motion happens only inside insert_new_bubble(), run once per spawned
// bubble (bubbles_draw spawns 5 per frame). A new bubble touching nothing sits
// still; one that touches merges (cascading) and then — in rise/drop mode only —
// travels one droppage step, re-checks, and keeps going while it finds bubbles to
// eat, or (when near maximum size) while a coin-flip lets it. In FLOAT mode (the
// xml default) there is no directional travel: bubbles only appear, merge, and
// pop when a merge would exceed the maximum area. So most of the field is static,
// with the occasional large bubble making a run across the screen.
//
// Collision search uses the C's square mesh: a bubble is bucketed into a cell of
// side (2*largest_radius + 3), and get_closest_bubble only scans the bubble's own
// cell plus the eight neighbours; the mesh is maintained incrementally.
//
// We CLEAR AND REDRAW every bubble each frame (the C draws/erases incrementally
// with X11 GCs); a full repaint on a double-buffered canvas is the equivalent.

export const title = 'bubbles';

export const info = {
  author: 'James Macnicol',
  description: 'This screen saver was removed from the XScreenSaver distribution as of version 5.08.\n\nThis simulates the kind of bubble formation that happens when water boils: small bubbles appear, and as they get closer to each other, they combine to form larger bubbles, which eventually pop.',
  year: 1996,
};

// The four pre-rendered sprite sets (bubbles-default.c), each 11 numbered PNGs.
const BUBBLE_SETS = ['blood', 'blue', 'glass', 'jade'];
const SPRITES_PER_SET = 11;
function bubbleSpriteURL(set, i) {
  return new URL('./images/bubbles/' + set + i + '.png', import.meta.url).href;
}

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/bubbles.xml so the config box maps 1:1
  // to the original: simple (--simple, default off = fancy sprites), delay
  // (frame rate, inverted slider), mode (the xml's "gravity" select, default
  // float), trails. The fancy-only "broken" toggle ("don't hide popped bubbles")
  // is dropped — it is meaningless under a full repaint — and "showfps" is a
  // framework control. The C HARD-CODES 5 new bubbles per frame, so there is
  // deliberately no spawn-rate / size / colour slider.
  //
  // delay: the xml stock is 10000us (nominal ~100fps). xscreensaver's effective
  // frame rate is lower because of per-frame overhead (the project's frame-rate
  // calibration), so the loop adds a fixed OVERHEAD and (delay + OVERHEAD)
  // reproduces the C's effective 5-bubbles-per-frame cadence. It is a pace knob,
  // not a fidelity item — the slider exposes the full xml range. See bubbles.md.
  const config = {
    simple: false,     // --simple: draw circles instead of bubble images
    delay: 10000,      // µs between steps (--delay; the xml stock value)
    mode: 'float',     // 'rise' | 'float' | 'drop' (--mode; xml default 'float')
    trails: false,     // big bubbles shed a small one behind them (--trails)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'Low', highLabel: 'High', live: true },
    { key: 'mode', label: 'Motion', type: 'select', default: 'float', live: true, options: [
        { value: 'rise', label: 'Bubbles rise' },
        { value: 'float', label: 'Bubbles float' },
        { value: 'drop', label: 'Bubbles fall' },
      ] },
    { key: 'simple', label: 'Draw circles instead of bubble images', type: 'checkbox', default: false, live: false },
    { key: 'trails', label: 'Leave trails', type: 'checkbox', default: false, live: true },
  ];

  // Constants from bubbles.c / bubbles.h.
  const AREA_K = 10 * Math.PI;     // calc_bubble_area(r) = 10*PI*r^2
  const MAX_DROPPAGE = 20;         // bubbles.h
  const TOUCH_LEEWAY = 2;          // the C's "+2" so circles never quite overlap

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px

  // Simple-mode sizing (screen-fraction radii).
  let minR, maxR, minArea, maxArea, nearMaxArea;

  // Fancy-mode sizing (fixed sprite steps). stepImages[i] is the sprite for
  // step i (0..10); stepRadii / stepAreas include an extra index 11 (the
  // extrapolated ceiling, no sprite); stepDroppage is per draw step (0..10).
  let loadedImages = null;   // Image[] for the chosen set (unsorted, as loaded)
  let stepImages, stepRadii, stepAreas, stepDroppage, maxStep, ceilingArea;

  let meshLength, meshW, meshH, meshCells, mesh, count, cap;
  let drop, dropDir;         // st->drop / st->drop_dir (float = no movement)
  let ready = false;         // sim runnable? (simple = at once; fancy = once decoded)
  let booting = false;

  // frand(x) = uniform float in [0, x), like the C's random() % x.
  function frand(x) {
    return Math.random() * x;
  }

  // Invert calc_bubble_area, clamped to the simple-mode radius range.
  function radiusFromArea(a) {
    const r = Math.sqrt(a / AREA_K);
    return r < minR ? minR : r > maxR ? maxR : r;
  }

  // st->drop / st->drop_dir, derived from the mode (live). float: no movement.
  function applyMode() {
    if (config.mode === 'rise') { drop = true; dropDir = -1; }
    else if (config.mode === 'drop') { drop = true; dropDir = 1; }
    else { drop = false; dropDir = -1; }   // float
  }

  // --- per-mode bubble behaviour -------------------------------------------
  // Is the bubble at (near) maximum size? simple: area >= areas[max-1];
  // fancy: step >= the largest draw step. Gates trails and the keep-travelling
  // coin-flip, exactly as the C does per mode.
  function nearMax(b) {
    return config.simple ? (b.area >= nearMaxArea) : (b.step >= maxStep);
  }

  // bubble_droppages[r] (simple, ramped 0..MAX_DROPPAGE by radius) /
  // step_pixmaps[step]->droppage (fancy, MAX_DROPPAGE*step/11). Device px (S).
  function droppageOf(b) {
    if (config.simple) return MAX_DROPPAGE * ((b.radius - minR) / (maxR - minR)) * S;
    return stepDroppage[b.step];
  }

  // Recompute radius (and, fancy, step) after an area change. Steps/radii only
  // grow (the C never shrinks a bubble).
  function growToArea(b) {
    if (config.simple) {
      b.radius = radiusFromArea(b.area);
    } else {
      while (b.step < maxStep && b.area > stepAreas[b.step + 1]) b.step++;
      b.radius = stepRadii[b.step];
    }
  }

  // --- mesh (spatial hash) --------------------------------------------------
  function meshIndex(x, y) {
    let cx = Math.floor(x / meshLength);
    let cy = Math.floor(y / meshLength);
    if (cx < 0) cx = 0; else if (cx >= meshW) cx = meshW - 1;
    if (cy < 0) cy = 0; else if (cy >= meshH) cy = meshH - 1;
    return cy * meshW + cx;
  }

  function meshAdd(b) {
    b.cellIndex = meshIndex(b.x, b.y);
    mesh[b.cellIndex].push(b);
  }

  function meshRemove(b) {
    const cellArr = mesh[b.cellIndex];
    const i = cellArr.indexOf(b);
    if (i >= 0) cellArr.splice(i, 1);
  }

  // Re-bucket a bubble after it has moved (delete_bubble_in_mesh KEEP + add).
  function reindex(b) {
    const mi = meshIndex(b.x, b.y);
    if (mi !== b.cellIndex) {
      meshRemove(b);
      b.cellIndex = mi;
      mesh[mi].push(b);
    }
  }

  // new_bubble: smallest step at a RANDOM position over the WHOLE screen (this
  // is the C — the entry edge plays no part; "rise"/"float"/"drop" only affect
  // motion, never where bubbles appear). Adds to the mesh and bumps the count.
  function spawnAt(x, y) {
    const b = config.simple
      ? { x, y, radius: minR, area: minArea, step: 0, cellIndex: -1 }
      : { x, y, radius: stepRadii[0], area: stepAreas[0], step: 0, cellIndex: -1 };
    meshAdd(b);
    count++;
    return b;
  }

  function killBubble(b) {
    meshRemove(b);
    count--;
  }

  // get_closest_bubble: nearest OTHER bubble touching b, searching b's cell + 8
  // neighbours; touchdist = r_a + r_b + 2 (the C's leeway). Squared throughout.
  function getClosestBubble(b) {
    let cx = Math.floor(b.x / meshLength);
    let cy = Math.floor(b.y / meshLength);
    if (cx < 0) cx = 0; else if (cx >= meshW) cx = meshW - 1;
    if (cy < 0) cy = 0; else if (cy >= meshH) cy = meshH - 1;
    let rv = null;
    let closest2 = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = cy + dy;
      if (ny < 0 || ny >= meshH) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        if (nx < 0 || nx >= meshW) continue;
        const cellArr = mesh[ny * meshW + nx];
        for (let k = 0; k < cellArr.length; k++) {
          const o = cellArr[k];
          if (o === b) continue;
          const ex = o.x - b.x;
          const ey = o.y - b.y;
          const sep2 = ex * ex + ey * ey;
          const td = o.radius + b.radius + TOUCH_LEEWAY * S;
          if (sep2 <= td * td && sep2 < closest2) {
            rv = o;
            closest2 = sep2;
          }
        }
      }
    }
    return rv;
  }

  // bubble_eat: the diner moves to the area-weighted mean of the two centres,
  // gains the food's area, and the food is deleted. In rise/drop mode an over-max
  // area is CLAMPED at the ceiling (the bubble keeps going until it leaves the
  // screen); in float mode an over-ceiling merge POPS the diner. Returns true if
  // the diner survives.
  function bubbleEat(diner, food) {
    const total = diner.area + food.area;
    diner.x = (diner.x * diner.area + food.x * food.area) / total;
    diner.y = (diner.y * diner.area + food.y * food.area) / total;
    diner.area = total;
    killBubble(food);

    const ceiling = config.simple ? maxArea : ceilingArea;
    if (drop) {
      if (diner.area > ceiling) diner.area = ceiling;
    } else {
      if (diner.area > ceiling) {
        killBubble(diner);
        return false;
      }
    }
    growToArea(diner);
    reindex(diner);
    return true;
  }

  // merge_bubbles: the bigger eats the smaller (a tie is broken at random).
  // Returns 1 (b1 ate and survived), 2 (b2 ate and survived), or 0 (popped).
  function mergeBubbles(b1, b2) {
    const s1 = b1.area;
    const s2 = b2.area;
    if (s1 > s2) return bubbleEat(b1, b2) ? 1 : 0;
    if (s1 < s2) return bubbleEat(b2, b1) ? 2 : 0;
    if (Math.random() < 0.5) return bubbleEat(b1, b2) ? 1 : 0;
    return bubbleEat(b2, b1) ? 2 : 0;
  }

  // leave_trail: a near-max travelling bubble drops a fresh smallest bubble
  // BEHIND it (y - (r + 10)*dir), then runs the full insert cascade on it.
  function leaveTrail(b) {
    if (count >= cap) return;
    const t = spawnAt(b.x, b.y - (b.radius + 10 * S) * dropDir);
    insertNewBubble(t);
  }

  // drop_bubble: shift one droppage step; pop (delete, return -1) if the centre
  // runs off the top/bottom edge; otherwise re-cell and maybe leave a trail.
  function dropBubble(b) {
    b.y += droppageOf(b) * dropDir;
    if (b.y < 0 || b.y > H) {
      killBubble(b);
      return -1;
    }
    reindex(b);
    if (config.trails && nearMax(b) && Math.random() < 0.5) {
      leaveTrail(b);
    }
    return 0;
  }

  // insert_new_bubble: resolve a freshly added bubble. If it touches nothing it
  // stays put. Otherwise: merge every touching neighbour (cascading); then, in
  // rise/drop mode, travel one step and repeat while there is something to eat,
  // continuing across empty space only if near-max-size and a coin-flip wins.
  function insertNewBubble(nb) {
    let nextbub = nb;
    let touch = getClosestBubble(nextbub);
    if (!touch) return;

    for (;;) {
      // Merge all bubbles currently touching nextbub.
      while (touch) {
        const r = mergeBubbles(nextbub, touch);
        if (r === 2) nextbub = touch;       // touch ate nextbub and survived
        else if (r === 0) nextbub = null;   // somebody exploded
        // r === 1: nextbub ate touch and survived (unchanged)
        if (!nextbub) break;
        touch = getClosestBubble(nextbub);
      }
      if (!nextbub) break;

      // Shift down/up one step (rise/drop only). Stop if it runs off-screen.
      if (drop) {
        if (dropBubble(nextbub) === -1) break;
      }

      touch = getClosestBubble(nextbub);
      if (!touch) {
        // Big bubbles keep travelling across empty space ~half the time.
        if (drop && nearMax(nextbub) && Math.random() < 0.5) continue;
        break;
      }
    }
  }

  // One frame of bubbles_draw: spawn 5 new smallest bubbles at random positions
  // and run each through the insert cascade.
  function step() {
    applyMode();
    for (let i = 0; i < 5 && count < cap; i++) {
      insertNewBubble(spawnAt(frand(W), frand(H)));
    }
  }

  // Full repaint. Fancy: blit the step-appropriate sprite centred on each
  // bubble (its alpha is the round mask). Simple: stroke white circle outlines
  // (the C's XDrawArc), all in one shared path + stroke.
  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (config.simple) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1, Math.round(S));
      ctx.beginPath();
      for (let c = 0; c < meshCells; c++) {
        const cellArr = mesh[c];
        for (let k = 0; k < cellArr.length; k++) {
          const b = cellArr[k];
          ctx.moveTo(b.x + b.radius, b.y);
          ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
        }
      }
      ctx.stroke();
    } else {
      for (let c = 0; c < meshCells; c++) {
        const cellArr = mesh[c];
        for (let k = 0; k < cellArr.length; k++) {
          const b = cellArr[k];
          const r = b.radius;
          ctx.drawImage(stepImages[b.step], b.x - r, b.y - r, 2 * r, 2 * r);
        }
      }
    }
  }

  // make_pixmap_array: sort the loaded sprites by radius (radius = max(w,h)/2),
  // build the area/droppage tables, and extrapolate the extra ceiling step.
  // Radii are scaled to device px by S. Returns the largest draw radius (for the
  // mesh cell size).
  function buildStepTable() {
    const steps = loadedImages.map((img) => ({
      img,
      nativeR: Math.max(img.naturalWidth, img.naturalHeight) / 2,
    }));
    steps.sort((a, b) => a.nativeR - b.nativeR);
    const n = steps.length;                       // 11
    stepImages = steps.map((s) => s.img);
    stepRadii = steps.map((s) => s.nativeR * S);
    stepAreas = stepRadii.map((r) => AREA_K * r * r);
    stepDroppage = [];
    for (let i = 0; i < n; i++) stepDroppage.push(MAX_DROPPAGE * i / n * S);
    maxStep = n - 1;                              // 10
    // Extra ceiling step (index n): extrapolate the radius past the largest.
    const extraR = (steps[n - 1].nativeR + (steps[n - 1].nativeR - steps[n - 2].nativeR)) * S;
    stepRadii.push(extraR);
    stepAreas.push(AREA_K * extraR * extraR);
    ceilingArea = stepAreas[n];
    return stepRadii[maxStep];
  }

  // Size everything off the device-px canvas, then set up an EMPTY mesh: the C
  // creates no bubbles at init — the field fills in over the first second from
  // bubbles_draw. Simple radii are screen fractions (so they scale with dpr);
  // fancy radii are fixed sprite pixels, scaled to device px by S.
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    let cellHalf;   // largest bubble radius, device px (drives mesh_length)
    if (config.simple) {
      const md = Math.min(W, H);
      minR = Math.max(1, Math.floor(0.006 * md));
      maxR = Math.max(minR + 1, Math.floor(0.045 * md));
      minArea = AREA_K * minR * minR;
      maxArea = AREA_K * maxR * maxR;
      nearMaxArea = AREA_K * (maxR - 1) * (maxR - 1);
      cellHalf = maxR;
    } else {
      cellHalf = buildStepTable();
    }

    meshLength = 2 * cellHalf + 3;
    meshW = Math.floor(W / meshLength) + 1;
    meshH = Math.floor(H / meshLength) + 1;
    meshCells = meshW * meshH;

    mesh = new Array(meshCells);
    for (let i = 0; i < meshCells; i++) mesh[i] = [];
    count = 0;

    // The C has no cap. The merge-and-pop dynamics are self-limiting (the field
    // saturates at roughly 9 bubbles per mesh cell), so this guard sits well
    // above the natural peak and never binds in normal play -- it only bounds
    // memory on a pathological screen.
    cap = Math.min(20000, Math.max(2000, meshCells * 16));

    applyMode();
  }

  // Pick a random sprite set (random() % 4) and decode its 11 PNGs.
  function loadSprites() {
    const set = BUBBLE_SETS[Math.floor(Math.random() * BUBBLE_SETS.length)];
    const imgs = [];
    for (let i = 1; i <= SPRITES_PER_SET; i++) {
      const img = new Image();
      img.src = bubbleSpriteURL(set, i);
      imgs.push(img);
    }
    return Promise.all(imgs.map((img) => img.decode())).then(() => imgs);
  }

  // Get the sim ready: simple mode at once; fancy mode once the sprites decode
  // (reusing an already-loaded set). On load failure, fall back to simple.
  function bootstrap() {
    ready = false;
    if (config.simple) {
      init();
      ready = true;
      return;
    }
    if (loadedImages) {
      init();
      ready = true;
      return;
    }
    if (booting) return;
    booting = true;
    loadSprites().then((imgs) => {
      booting = false;
      loadedImages = imgs;
      if (!config.simple) { init(); ready = true; }
    }).catch(() => {
      booting = false;
      config.simple = true;
      init();
      ready = true;
    });
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    if (ready) init();
  }

  // rAF lag-accumulator paced by config.delay (us): run one step() per delay,
  // banking leftover time so the rate is identical at any refresh rate, and cap
  // catch-up so a backgrounded tab can't burst on refocus.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay bubbles runs 54.2 fps, while the
  // port at the stock 10000 us ran ~100 steps/sec (1.85x fast). 10000 + 8450 =
  // 18450 us -> 54.2 steps/sec, matching the live binary. A calibration, not a
  // tuning knob (the delay slider still maps 1:1 to the xml resource).
  const OVERHEAD = 8450;
  const MAX_CATCHUP_STEPS = 4;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (!ready) {
      // Hold black until the sprites have decoded (fancy mode).
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      rafId = requestAnimationFrame(frame);
      return;
    }

    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;
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

  // Clear and re-seed (empty). Used for the non-live `simple` toggle and manual
  // restarts; init() does not paint, so clear first.
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    lastTime = 0;
    lag = 0;
    bootstrap();
  }

  window.addEventListener('resize', resize);
  resize();
  bootstrap();
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
