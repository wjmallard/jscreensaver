// rocks.js — rocks packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's rocks.c (Jamie Zawinski, 1992; colour added by
// Johannes Keukelaar, 1997). Based on TI Explorer Lisp code by John Nguyen.
// https://www.jwz.org/xscreensaver/
//
// Flying through an asteroid field. The viewer rushes forward through a 3D
// field of tumbling rocks. Each rock is a software-projected polygon: it owns a
// radial offset r from the flight axis, an angle theta around that axis, and a
// depth (its z-distance). A perspective factor depths[depth] = atan(0.5 /
// (depth/100)) maps depth -> apparent angular size, so as a rock's depth ticks
// down toward the viewer it grows AND swings out from the centre (x = midx +
// cos(theta)*r*factor). When a rock crosses the near plane (depth < MIN_DEPTH)
// it dies (depth = 0) and is later respawned at MAX_DEPTH — the recycle. The
// whole field can slowly rotate (theta drift, "rotation") and steer (a drifting
// screen-space displacement that shifts far rocks more than near ones,
// "steering"), and there is an optional red/blue anaglyph 3D mode.
//
// Rendering: full repaint per frame onto a cleared black canvas. The C draws
// incrementally onto a persistent window (erase old rock, draw new) with no
// screen clear; we clear+redraw every frame instead — see rocks.md. Rocks are
// drawn as filled polygons (the C's 7-point asteroid shape, scaled to size),
// small ones as filled rects, sub-pixel ones as points. Sparse vector ops (~100
// filled polys over a mostly-black field) — far cheaper than a per-pixel blit.

export const title = 'rocks';

export const info = {
  author: 'Jamie Zawinski',
  description: 'An asteroid field zooms by.',
  year: 1992,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/rocks.xml so the config box maps 1:1.
  const config = {
    delay: 50000,    // µs between steps (--delay)
    count: 100,      // number of rocks (--count, min 1)
    speed: 100,      // depth ticks travelled per step, 1..100 (--speed)
    ncolors: 16,     // size of the rainbow palette (--colors)
    rotate: true,    // slowly rotate the whole field (--rotate)
    move: true,      // steer: drift the field sideways (--move)
    threed: false,   // red/blue anaglyph 3D separation (--3d)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 50000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Rocks', type: 'range', min: 1, max: 200, step: 1, default: 100, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'speed', label: 'Velocity', type: 'range', min: 1, max: 100, step: 1, default: 100, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 16, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'rotate', label: 'Rotation', type: 'checkbox', default: true, live: true },
    { key: 'move', label: 'Steering', type: 'checkbox', default: true, live: false },
    { key: 'threed', label: 'Red/blue 3D', type: 'checkbox', default: false, live: true },
  ];

  // Geometry constants, verbatim from rocks.c.
  const MIN_ROCKS = 1;
  const MIN_DEPTH = 2;              // rocks disappear when they get this close
  const MAX_DEPTH = 60;            // this is where rocks appear
  const MIN_SIZE = 3;             // below this, pixmaps are not used (we rect)
  const MAX_SIZE = 400;          // how big (px) a rock is at depth 1
  const DEPTH_SCALE = 100;      // ticks between integer depths
  const SIN_RESOLUTION = 1000; // angle table size (theta units)
  const MAX_DEP = 0.3;        // how far the steering displacement can go (%)
  const DIRECTION_CHANGE_RATE = 60;
  const MAX_DEP_SPEED = 5;   // maximum speed for the steering drift
  const MOVE_STYLE = 0;     // 0 = these are the rocks that move (vs the source)
  const THREED_DELTA = 1.5; // anaglyph eye separation (--delta3d)

  // 3D eye-offset for a rock at depth z (GETZDIFF macro). Bigger near, ~0 far.
  function getZDiff(z) {
    return (
      THREED_DELTA *
      40.0 *
      (1.0 - ((MAX_DEPTH * DEPTH_SCALE / 2) / (z + 20.0 * DEPTH_SCALE)))
    );
  }

  // The C's 7-point asteroid outline, normalized to a unit box (0..1). A rock of
  // apparent `size` px is this polygon scaled by `size`, anchored at its
  // top-left (x - size/2, y - size/2) — exactly the C's pixmap placement.
  const ROCK_SHAPE = [
    [0.15, 0.85],
    [0.00, 0.20],
    [0.30, 0.00],
    [0.40, 0.10],
    [0.90, 0.10],
    [1.00, 0.55],
    [0.45, 1.00],
  ];

  // NRAND(n) -> integer in [0, n); matches the C's random()%n.
  const nrand = (n) => Math.floor(Math.random() * n);

  let S = 1;            // devicePixelRatio
  let W, H;             // canvas size, device px
  let midX, midY;       // screen centre, device px

  // Precomputed tables (built once per init).
  let sins, coss;       // SIN_RESOLUTION-entry sin/cos over theta units
  let depths;           // (MAX_DEPTH+1)*DEPTH_SCALE perspective factors
  let palette;          // ncolors rainbow CSS strings

  // Field state (mirrors struct state).
  let rocks;            // array of rock objects
  let nrocks;
  let maxDep;           // == MAX_DEP when steering, else 0

  // Steering drift (compute_move state), per axis [x, y].
  let depX, depY;                 // current screen displacement
  let moveCurrentDep;             // [x, y]
  let moveSpeed;                  // [x, y]
  let moveDirection;              // [x, y]
  let moveLimit;                  // [x, y] (== [midX, midY])

  // Field rotation steering (the `d` fed to every rock each frame).
  let currentDelta, newDelta, dchangeTick;

  // Build a vivid full-saturation rainbow palette (house style over the C's
  // handful of random colours). ncolors <= 2 collapses to a single warm tone
  // (the C's mono path drew the foreground colour, default #E9967A "darksalmon").
  function buildPalette() {
    const n = Math.max(2, Math.round(config.ncolors));
    palette = new Array(n);
    if (n <= 2) {
      palette[0] = '#E9967A';
      palette[1] = '#E9967A';
      return;
    }
    for (let i = 0; i < n; i++) {
      palette[i] = `hsl(${i * 360 / n}, 90%, 62%)`;
    }
  }

  // Drop a fresh rock at the far plane with a random radius/angle/colour
  // (rock_reset). real_size is always MAX_SIZE; the perspective factor shrinks it.
  function rockReset(rock) {
    rock.realSize = MAX_SIZE;
    rock.r = (SIN_RESOLUTION * 0.7) + nrand(30 * SIN_RESOLUTION);
    rock.theta = nrand(SIN_RESOLUTION);
    rock.depth = MAX_DEPTH * DEPTH_SCALE;
    rock.color = nrand(palette.length);
    rockCompute(rock);
  }

  // Project a rock to screen (rock_compute): factor = depths[depth] is the
  // perspective angular size; size grows and the rock swings out from centre as
  // depth shrinks. Steering adds a depth-weighted screen displacement.
  function rockCompute(rock) {
    const factor = depths[rock.depth];
    const rsize = rock.realSize * factor;

    rock.size = (rsize + 0.5) | 0;
    rock.diff = getZDiff(rock.depth) | 0;
    rock.x = (midX + (coss[rock.theta] * rock.r * factor)) | 0;
    rock.y = (midY + (sins[rock.theta] * rock.r * factor)) | 0;

    if (config.move) {
      // move_factor: 0 when the rock is close, ~-1 when far (MOVE_STYLE = 0), so
      // distant rocks are displaced more — the parallax that sells the steering.
      const moveFactor =
        MOVE_STYLE - (rock.depth / ((MAX_DEPTH + 1) * DEPTH_SCALE));
      rock.x = (rock.x + (depX * moveFactor)) | 0;
      rock.y = (rock.y + (depY * moveFactor)) | 0;
    }
  }

  // Advance one rock by `d` theta-units of field rotation (rock_tick). The C
  // erases the old position here; we redraw the whole field per frame, so this
  // is pure state: tick depth toward the viewer, recycle past the near plane.
  function rockTick(rock, d) {
    if (rock.depth > 0) {
      rock.depth -= config.speed;
      if (config.rotate) {
        rock.theta = (rock.theta + d) % SIN_RESOLUTION;
      }
      while (rock.theta < 0) rock.theta += SIN_RESOLUTION;
      if (rock.depth < (MIN_DEPTH * DEPTH_SCALE)) {
        rock.depth = 0;                 // crossed the near plane: kill it
      } else {
        rockCompute(rock);
      }
    } else if (nrand(40) === 0) {
      rockReset(rock);                  // 1/40 chance/tick to respawn at far plane
    }
  }

  // Draw one rock as the asteroid polygon (or a rect / point when small), at a
  // given x offset and fill colour. Mirrors rock_draw's size buckets; the off-
  // screen kill (when not steering) lives in step() so it runs once per rock.
  function drawRockShape(rock, xoff, fill) {
    const x = rock.x + xoff;
    const y = rock.y;
    const size = rock.size;

    ctx.fillStyle = fill;
    if (size <= 1) {
      ctx.fillRect(x, y, 1, 1);
    } else if (size <= MIN_SIZE) {
      const s = (size / 2) | 0;
      ctx.fillRect(x - s, y - s, size, size);
    } else {
      // The asteroid polygon, scaled to `size`, anchored at its top-left.
      const ox = x - (size / 2) | 0;
      const oy = y - (size / 2) | 0;
      ctx.beginPath();
      ctx.moveTo(ox + ROCK_SHAPE[0][0] * size, oy + ROCK_SHAPE[0][1] * size);
      for (let k = 1; k < ROCK_SHAPE.length; k++) {
        ctx.lineTo(ox + ROCK_SHAPE[k][0] * size, oy + ROCK_SHAPE[k][1] * size);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  // Draw one rock (handles 2D vs red/blue 3D). In 3D the rock is drawn twice,
  // offset by -diff in red and +diff in blue, composited additively ('lighter')
  // so the overlap reads white — the anaglyph look without an XOR raster op.
  function drawRock(rock) {
    if (config.threed) {
      const prev = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighter';
      drawRockShape(rock, -rock.diff, 'rgb(255,0,0)');   // left eye
      drawRockShape(rock, rock.diff, 'rgb(0,160,255)');  // right eye
      ctx.globalCompositeOperation = prev;
    } else {
      drawRockShape(rock, 0, palette[rock.color]);
    }
  }

  // One steering-axis update (compute_move): accelerate the displacement, bounce
  // off the +/- midX*max_dep limits, randomly flip direction. axe 0 = x, 1 = y.
  function computeMove(axe) {
    moveLimit[0] = midX;
    moveLimit[1] = midY;

    moveCurrentDep[axe] += moveSpeed[axe];

    if (moveCurrentDep[axe] > (moveLimit[axe] * maxDep) | 0) {
      if (moveCurrentDep[axe] > moveLimit[axe]) {
        moveCurrentDep[axe] = moveLimit[axe];
      }
      moveDirection[axe] = -1;
    }
    if (moveCurrentDep[axe] < (-moveLimit[axe] * maxDep) | 0) {
      if (moveCurrentDep[axe] < -moveLimit[axe]) {
        moveCurrentDep[axe] = -moveLimit[axe];
      }
      moveDirection[axe] = 1;
    }
    if (moveDirection[axe] === 1) {
      moveSpeed[axe] += 1;
    } else if (moveDirection[axe] === -1) {
      moveSpeed[axe] -= 1;
    }

    if (moveSpeed[axe] > MAX_DEP_SPEED) {
      moveSpeed[axe] = MAX_DEP_SPEED;
    } else if (moveSpeed[axe] < -MAX_DEP_SPEED) {
      moveSpeed[axe] = -MAX_DEP_SPEED;
    }

    if (config.move && nrand(DIRECTION_CHANGE_RATE) === 0) {
      const change = nrand(2) & 1;        // random() & 1
      if (change !== 1) {
        if (moveDirection[axe] === 0) {
          moveDirection[axe] = change - 1;   // 0 -> -1
        } else {
          moveDirection[axe] = 0;            // -1 or 1 -> 0
        }
      }
    }
    return moveCurrentDep[axe];
  }

  // One simulation+draw step (rocks_draw + tick_rocks): ease the field-rotation
  // delta, update steering, tick every rock, then clear and repaint the field.
  function step() {
    // Field-rotation steering: ease current_delta toward new_delta over 5-tick
    // strides; when settled, occasionally pick a new target (and rarely x5 it).
    if (currentDelta !== newDelta) {
      if (dchangeTick++ === 5) {
        dchangeTick = 0;
        if (currentDelta < newDelta) currentDelta++;
        else currentDelta--;
      }
    } else if (nrand(50) === 0) {
      newDelta = nrand(11) - 5;
      if (nrand(10) === 0) newDelta *= 5;
    }

    // Steering displacement (only meaningful when move is on; maxDep is 0 else).
    if (config.move) {
      depX = computeMove(0);
      depY = computeMove(1);
    }

    // Tick every rock by the current field rotation.
    for (let i = 0; i < nrocks; i++) {
      rockTick(rocks[i], currentDelta);
    }

    // Full repaint: clear to black, then draw every live, on-screen rock. The
    // C's off-screen rule (kill a wandered-off rock when NOT steering, so the
    // slot recycles) is applied here, once per rock, before drawing.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < nrocks; i++) {
      const rock = rocks[i];
      if (rock.depth <= 0) continue;
      if (rock.x <= 0 || rock.y <= 0 || rock.x >= W || rock.y >= H) {
        if (!config.move) rock.depth = 0;
        continue;
      }
      drawRock(rock);
    }
  }

  // Build the sin/cos and perspective tables (rocks_init's loops).
  function buildTables() {
    sins = new Float64Array(SIN_RESOLUTION);
    coss = new Float64Array(SIN_RESOLUTION);
    for (let i = 0; i < SIN_RESOLUTION; i++) {
      sins[i] = Math.sin((i / (SIN_RESOLUTION / 2)) * Math.PI);
      coss[i] = Math.cos((i / (SIN_RESOLUTION / 2)) * Math.PI);
    }
    const ndepths = (MAX_DEPTH + 1) * DEPTH_SCALE;
    depths = new Float64Array(ndepths);
    for (let i = 1; i < ndepths; i++) {
      depths[i] = Math.atan(0.5 / (i / DEPTH_SCALE));
    }
    depths[0] = Math.PI / 2;   // avoid division by 0
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    midX = (W / 2) | 0;
    midY = (H / 2) | 0;

    buildTables();
    buildPalette();

    maxDep = config.move ? MAX_DEP : 0;

    // Steering drift state.
    depX = 0;
    depY = 0;
    moveCurrentDep = [0, 0];
    moveSpeed = [0, 0];
    moveDirection = [0, 0];
    moveLimit = [midX, midY];

    // Field-rotation steering state.
    currentDelta = 0;
    newDelta = 0;
    dchangeTick = 0;

    // Allocate rocks. The C calloc()s them all to depth 0 (dead), so each is
    // born via the 1/40-per-tick respawn — the field fills in over the first
    // second or two, exactly like the original. We do the same (no pre-seed).
    nrocks = Math.max(MIN_ROCKS, Math.round(config.count));
    rocks = new Array(nrocks);
    for (let i = 0; i < nrocks; i++) {
      rocks[i] = {
        realSize: 0,
        r: 0,
        theta: 0,
        depth: 0,
        size: 0,
        x: 0,
        y: 0,
        diff: 0,
        color: 0,
      };
    }

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator loop paced by config.delay (µs in the xml; divided by
  // 1000 for the ms rAF clock), with the same catch-up cap as squiral so a
  // backgrounded tab doesn't fire a burst of steps on refocus. Each step() does
  // a full clear+repaint, so we never draw more than we step.
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

  // Re-seed with the current config (clears the canvas; rock count, palette, and
  // the steering-on flag may have changed).
  function reinit() {
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
