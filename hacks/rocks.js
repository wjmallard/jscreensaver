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
// Rendering: the C's exact incremental model on a persistent canvas — no
// per-frame clear. Each tick every rock erases its old position and draws its
// new one. A rock above MIN_SIZE is stamped the way XCopyPlane stamps its
// 1-bit pixmap: the whole size x size bounding box is painted — polygon bits
// in the rock's colour, the rest in background black — so overlapping rocks
// bite black box edges out of each other. The erase pass is that same box in
// plain black (the C's `|| !draw_p` square path). Every op is an opaque canvas
// fill at integer coords, so erases cover draws exactly; no framebuffer.

import { makeRandomColormapRGB } from './colormap.js';

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
    count: 100,      // number of rocks (--count; the C clamps to >= 1)
    speed: 100,      // depth ticks travelled per step, 1..100 (--speed)
    ncolors: 5,      // colour slots, INCLUDING the background slot 0 (--colors)
    rotate: true,    // slowly rotate the whole field (--rotate)
    move: true,      // steer: drift the field sideways (--move)
    threed: false,   // red/blue anaglyph 3D separation (--3d)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 50000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Rocks', type: 'range', min: 0, max: 200, step: 1, default: 100, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'speed', label: 'Velocity', type: 'range', min: 1, max: 100, step: 1, default: 100, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 5, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'rotate', label: 'Rotation', type: 'checkbox', default: true, live: true },
    { key: 'move', label: 'Steering', type: 'checkbox', default: true, live: false },
    { key: 'threed', label: 'Red/blue 3D', type: 'checkbox', default: false, live: false },
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

  // Anaglyph GCs (rocks.c defaults): left eye Blue drawn at x - diff, right
  // eye Red drawn at x + diff. diff goes NEGATIVE for rocks nearer than depth
  // 10 (GETZDIFF's zero crossing), so near rocks get crossed disparity.
  const LEFT3D = '#0000FF';    // *left3d:  Blue
  const RIGHT3D = '#FF0000';   // *right3d: Red
  const BG = '#000000';        // .background: Black

  // 3D eye-offset for a rock at depth z (GETZDIFF macro). Bigger near, ~0 far.
  function getZDiff(z) {
    return (
      THREED_DELTA *
      40.0 *
      (1.0 - ((MAX_DEPTH * DEPTH_SCALE / 2) / (z + 20.0 * DEPTH_SCALE)))
    );
  }

  // The C's 7-point asteroid outline, normalized to a unit box (0..1). A rock
  // of apparent `size` px is this polygon scaled by `size` with each vertex
  // truncated to an integer (init_pixmaps stores XPoint shorts), anchored at
  // its top-left (x - size/2, y - size/2) — exactly the C's pixmap placement.
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

  let W, H;             // canvas size, device px
  let midX, midY;       // screen centre, device px

  // Precomputed tables (built once per init).
  let sins, coss;       // SIN_RESOLUTION-entry sin/cos over theta units
  let depths;           // (MAX_DEPTH+1)*DEPTH_SCALE perspective factors
  let palette;          // ncolors CSS strings (slot 0 = background!)

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

  // Colour allocation, transcribed from rocks_init (rocks.c:399-447). ncolors
  // (stock 5) slots; slot 0 holds the BACKGROUND colour (black) because the C
  // reserves colors[0] for bg and then builds draw_gcs[i] over the whole
  // array. The remaining slots come from make_random_colormap with
  // bright_p=True (independent random hues, S 30-100%, V 66-100%). A rock
  // picks color = random % ncolors, so ~1/ncolors of the rocks are painted
  // background-on-background — invisible "stealth" rocks whose stamped boxes
  // still knock black bites out of rocks behind them, exactly like the
  // original. ncolors < 2 means mono: draw_gcs[0] == draw_gcs[1] == the
  // foreground GC, so every rock is #E9967A ("darksalmon") — the pre-1997
  // behaviour.
  function buildPalette() {
    const n = Math.round(config.ncolors);
    if (n < 2) {
      palette = ['#E9967A', '#E9967A'];
      return;
    }
    palette = new Array(n);
    palette[0] = BG;
    const rand = makeRandomColormapRGB(n - 1, true);
    for (let i = 1; i < n; i++) {
      const c = rand[i - 1];
      palette[i] = `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }

  // Drop a fresh rock at the far plane with a random radius/angle/colour and
  // draw it immediately (rock_reset). real_size is always MAX_SIZE; the
  // perspective factor shrinks it.
  function rockReset(rock) {
    rock.realSize = MAX_SIZE;
    rock.r = (SIN_RESOLUTION * 0.7) + nrand(30 * SIN_RESOLUTION);
    rock.theta = nrand(SIN_RESOLUTION);
    rock.depth = MAX_DEPTH * DEPTH_SCALE;
    rock.color = nrand(palette.length);
    rockCompute(rock);
    rockDraw(rock, true);
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

  // Advance one rock by `d` theta-units of field rotation (rock_tick): erase
  // it at its old position, tick depth toward the viewer, rotate, then either
  // kill it past the near plane (it was just erased — gone) or recompute and
  // draw at the new position. A dead rock has a 1/40 chance per tick to
  // respawn at the far plane.
  function rockTick(rock, d) {
    if (rock.depth > 0) {
      rockDraw(rock, false);
      rock.depth -= config.speed;
      if (config.rotate) {
        rock.theta = (rock.theta + d) % SIN_RESOLUTION;
      }
      while (rock.theta < 0) rock.theta += SIN_RESOLUTION;
      if (rock.depth < (MIN_DEPTH * DEPTH_SCALE)) {
        rock.depth = 0;                 // crossed the near plane: kill it
      } else {
        rockCompute(rock);
        rockDraw(rock, true);
      }
    } else if (nrand(40) === 0) {
      rockReset(rock);                  // 1/40 chance/tick to respawn far away
    }
  }

  // One XCopyPlane stamp (rock_draw's pixmap path + init_pixmaps): the 1-bit
  // pixmap's whole size x size box is copied — 1-bits in `fill`, 0-bits in
  // background black — so the stamp paints its full bounding square and a
  // later-drawn rock's box clips black edges into an earlier one. Vertex
  // coords truncate to ints (the pixmap's XPoint shorts).
  function stampRock(ox, oy, size, fill) {
    ctx.fillStyle = BG;
    ctx.fillRect(ox, oy, size, size);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(ox + ((ROCK_SHAPE[0][0] * size) | 0), oy + ((ROCK_SHAPE[0][1] * size) | 0));
    for (let k = 1; k < ROCK_SHAPE.length; k++) {
      ctx.lineTo(ox + ((ROCK_SHAPE[k][0] * size) | 0), oy + ((ROCK_SHAPE[k][1] * size) | 0));
    }
    ctx.closePath();
    ctx.fill();
  }

  // Transcription of rock_draw. drawP false = erase: the C paints with
  // erase_gc (background), and any rock bigger than a point erases via the
  // filled-square path (the `|| !draw_p` size test). The off-screen check runs
  // on BOTH the erase and draw calls and kills the rock when steering is off
  // (the C's "won't come back once the observer rotates" rule). In 3D mode the
  // rock's colour is ignored: both eyes always draw in the fixed left/right
  // colours, and erases cover both eye positions.
  function rockDraw(rock, drawP) {
    const size = rock.size;
    if (rock.x <= 0 || rock.y <= 0 || rock.x >= W || rock.y >= H) {
      if (!config.move) rock.depth = 0;
      return;
    }
    if (size <= 1) {
      if (config.threed) {
        ctx.fillStyle = drawP ? LEFT3D : BG;
        ctx.fillRect(rock.x - rock.diff, rock.y, 1, 1);
        ctx.fillStyle = drawP ? RIGHT3D : BG;
        ctx.fillRect(rock.x + rock.diff, rock.y, 1, 1);
      } else {
        ctx.fillStyle = drawP ? palette[rock.color] : BG;
        ctx.fillRect(rock.x, rock.y, 1, 1);
      }
    } else if (size <= MIN_SIZE || !drawP) {
      const half = (size / 2) | 0;         // C integer division
      if (config.threed) {
        ctx.fillStyle = drawP ? LEFT3D : BG;
        ctx.fillRect(rock.x - half - rock.diff, rock.y - half, size, size);
        ctx.fillStyle = drawP ? RIGHT3D : BG;
        ctx.fillRect(rock.x - half + rock.diff, rock.y - half, size, size);
      } else {
        ctx.fillStyle = drawP ? palette[rock.color] : BG;
        ctx.fillRect(rock.x - half, rock.y - half, size, size);
      }
    } else if (size < MAX_SIZE) {
      const half = (size / 2) | 0;
      if (config.threed) {
        stampRock(rock.x - half - rock.diff, rock.y - half, size, LEFT3D);
        stampRock(rock.x - half + rock.diff, rock.y - half, size, RIGHT3D);
      } else {
        stampRock(rock.x - half, rock.y - half, size, palette[rock.color]);
      }
    }
  }

  // One steering-axis update (compute_move): accelerate the displacement, bounce
  // off the +/- midX*max_dep limits, randomly flip direction. axe 0 = x, 1 = y.
  function computeMove(axe) {
    moveLimit[0] = midX;
    moveLimit[1] = midY;

    moveCurrentDep[axe] += moveSpeed[axe];

    if (moveCurrentDep[axe] > Math.trunc(moveLimit[axe] * maxDep)) {
      if (moveCurrentDep[axe] > moveLimit[axe]) {
        moveCurrentDep[axe] = moveLimit[axe];
      }
      moveDirection[axe] = -1;
    }
    if (moveCurrentDep[axe] < Math.trunc(-moveLimit[axe] * maxDep)) {
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
  // delta, update steering, then tick every rock — each rock erases its old
  // position and draws its new one (no full-screen clear, as in the C).
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

    // Steering displacement (only computed when move is on, like tick_rocks).
    if (config.move) {
      depX = computeMove(0);
      depY = computeMove(1);
    }

    // Tick every rock by the current field rotation.
    for (let i = 0; i < nrocks; i++) {
      rockTick(rocks[i], currentDelta);
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

    // XClearWindow at the end of rocks_init.
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
  }

  // rocks_reshape only updates the geometry — the field keeps flying with all
  // its state (the C does not reset the rocks on resize). The canvas resize
  // clears the backing store (like an expose), so repaint the black window;
  // every live rock re-stamps itself on its next tick. The backing store is in
  // device px and the C's pixel constants are used as-is in that space — see
  // rocks.md.
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    W = canvas.width;
    H = canvas.height;
    midX = (W / 2) | 0;
    midY = (H / 2) | 0;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
  }

  // rAF lag-accumulator paced at (delay + OVERHEAD) µs per step: the C's delay
  // is a sleep on top of its per-tick draw cost, so the port adds the live-
  // measured overhead to reproduce the binary's real cadence (never faster
  // than the author's floor). Cap catch-up so a backgrounded tab doesn't fire
  // a burst of steps on refocus.
  const OVERHEAD = 7800;  // µs; live -fps: 17.3 fps at Load 13.4% (clean: sleep slice = 50057 ≈ stock 50000)
  const MAX_CATCHUP_STEPS = 4;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const stepMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, stepMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= stepMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= stepMs;
      steps++;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (clears the canvas; rock count, palette,
  // steering, and the 3D flag may have changed).
  function reinit() {
    init();
  }

  window.addEventListener('resize', resize);
  resize();
  init();
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
