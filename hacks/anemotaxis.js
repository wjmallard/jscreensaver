// anemotaxis.js — anemotaxis packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's anemotaxis.c (Eugene Balkovski, 2004).
// https://www.jwz.org/xscreensaver/
//
// An "optimal search" simulation. Odor particles drift in +x away from point
// SOURCES (placed on the left) while random-walking in y (turbulent wind).
// SEARCHERS enter from the right edge and crawl left toward a source. A searcher
// only knows whether a particle sits at its cell and, if so, which way the wind
// blew it; with that it climbs the plume. Lacking a particle it sweeps an
// expanding triangular "cone" (a zig-zag fan) until it senses one, then heads
// straight for the source. Reaching a source flashes the searcher white and
// makes the source vanish; running off the left edge also ends the search.
// Either way the searcher is reborn at the right edge. Models moths tracking
// pheromone plumes (odor-modulated anemotaxis).
//
// FIDELITY: a close transcription of anemotaxis.c. It boots exactly as
// anemotaxis_init does — a SINGLE source, NO searchers — and lets the field fill
// in over time via the C's own spawn probabilities, so it tracks the live binary
// at every point (warm-up included). The palette is the C's
// make_random_colormap(bright_p=True): random hues at S 30-100% / V 66-100%,
// built ONCE and never cycled (the X visual is non-writable). See anemotaxis.md.
//
// Rendering: SPARSE vector drawing with a FULL REPAINT each step. The C clears
// its back buffer every draw, then redraws every source blob, every drifting
// particle, and each searcher's whole trajectory as a polyline — so there is no
// persistent canvas / ring buffer here; trails live in each searcher's history
// list and are re-stroked from scratch. Contrast [[grav]] and [[whirlwindwarp]],
// which use a persistent canvas + erase-old/draw-new instead.

import { makeRandomColormapRGB } from './colormap.js';

export const title = 'anemotaxis';

export const info = {
  author: 'Eugene Balkovski',
  description: 'Searches for a source of odor in a turbulent atmosphere. The searcher is able to sense the odor and determine local instantaneous wind direction. The goal is to find the source in the shortest mean time.\n\nhttps://en.wikipedia.org/wiki/Anemotaxis',
  year: 2004,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/anemotaxis.xml: delay (Frame rate,
  // inverted), distance (lattice size), sources, searchers. The xml exposes no
  // colour control, so neither do we. delay defaults to the stock 20000 µs (the
  // slider maps 1:1 to the xml resource); the rAF loop adds a fixed OVERHEAD so
  // the effective step rate matches the live binary (see anemotaxis.md and the
  // framerate-calibration note).
  const config = {
    delay: 20000,     // µs between steps (--delay; the xml stock value)
    distance: 40,     // size of the lattice (--distance)
    sources: 25,      // number of odor sources (--sources)
    searchers: 25,    // number of searchers (--searchers)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'distance', label: 'Distance', type: 'range', min: 10, max: 250, step: 1, default: 40, lowLabel: 'near', highLabel: 'far', live: false },
    { key: 'sources', label: 'Sources', type: 'range', min: 1, max: 100, step: 1, default: 25, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'searchers', label: 'Searchers', type: 'range', min: 1, max: 100, step: 1, default: 25, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  // Lattice / emission constants, verbatim from anemotaxis.c.
  const MAX_DIST = 250;
  const MIN_DIST = 10;
  const MAX_INV_RATE = 5;
  const TAU = Math.PI * 2;

  // Palette size: the C reads --colors (default 20) then does ncolors++ (a spare
  // cell), so make_random_colormap actually fills 21 entries. anemotaxis.xml has
  // no colour slider, so this is a fixed internal constant.
  const ncolors = 20 + 1;

  // Searcher state machine (the C's enum {UP_LEFT, UP_RIGHT, LEFT, RIGHT, DONE});
  // only the names matter, never the numeric values.
  const UP_LEFT = 0;
  const UP_RIGHT = 1;
  const LEFT = 2;
  const RIGHT = 3;
  const DONE = 4;

  let W, H;             // canvas size, device px

  let maxDist;          // lattice size (clamped distance)
  let maxSrc;           // number of source slots
  let maxSearcher;      // number of searcher slots

  // Screen mapping (the C's X()/Y() macros, bx = by = 0) and draw metrics, all
  // in device px (dpr folds in through W/H — counts/rates stay in absolute px).
  let ax, ay;           // lattice -> px scale factors
  let dx, dy;           // small x/y jitter spans (RND(dx)/RND(dy)); dx drives line width
  let lineWidth;        // trajectory stroke width (the C's dx/3 + 1)
  let partSize;         // particle disc diameter (the C's 4, or 8 on a >2560 px store)

  let colors;           // bright random colormap as rgb() strings
  let sources;          // array of Source | null
  let searchers;        // array of Searcher | null
  let needRender;       // force one repaint after init/reseed even with no step

  // random() % n
  function RND(n) {
    return Math.floor(Math.random() * n);
  }

  // Lattice -> device px. Math.trunc matches the C's (int) cast (a searcher's x
  // can reach -1, and (int) truncates toward zero).
  function X(x) {
    return Math.trunc(ax * x);
  }

  function Y(y) {
    return Math.trunc(ay * y);
  }

  // ----- sources -------------------------------------------------------------

  // A source sits on the left; yvV[i]/yvY[i] hold the velocity (-1,0,1; 2 = no
  // particle) and relative-y of the particle at lattice (x + i + 1, y + yvY[i]).
  function newSource() {
    const s = {
      x: RND(Math.max(1, Math.floor(maxDist / 3))),
      y: 0,
      n: 0,
      yvV: null,
      yvY: null,
      inv_rate: 0,
      color: '',
    };
    do {
      s.y = RND(2 * maxDist);
    } while (s.y < MIN_DIST || s.y > 2 * maxDist - MIN_DIST);

    s.n = maxDist - s.x;
    s.yvV = new Int8Array(s.n).fill(2);   // all cells empty
    s.yvY = new Int16Array(s.n);          // zeros

    s.inv_rate = RND(MAX_INV_RATE);       // inverse emission rate, 1..4
    if (s.inv_rate === 0) s.inv_rate = 1;

    s.color = colors[RND(ncolors)];
    return s;
  }

  // Drift every particle one cell outward (toward +x), random-walking y by
  // {-1,0,1}; then maybe emit a fresh particle at cell 0. inv_rate 0 = silent.
  function evolveSource(s) {
    for (let i = s.n - 1; i > 0; i--) {
      if (s.yvV[i - 1] === 2) {
        s.yvV[i] = 2;
      } else {
        s.yvV[i] = RND(3) - 1;
        s.yvY[i] = s.yvY[i - 1] + s.yvV[i];
      }
    }
    if (s.inv_rate > 0 && RND(s.inv_rate) === 0) {
      const r = RND(3) - 1;             // the C sets yv[0].y = yv[0].v = RND(3)-1
      s.yvV[0] = r;
      s.yvY[0] = r;
    } else {
      s.yvV[0] = 2;
    }
  }

  // True once a silenced source (inv_rate 0) has no particles left to draw.
  function sourceDead(s) {
    if (s.inv_rate !== 0) return false;
    for (let i = 0; i < s.n; i++) {
      if (s.yvV[i] !== 2) return false;
    }
    return true;
  }

  // Set the searcher's sensed concentration/velocity/color from this source's
  // particle field at the searcher's cell (the C's get_v).
  function getV(s, m) {
    const x = m.rx - s.x - 1;
    m.c = 0;
    if (x < 0 || x >= s.n) return;
    if (s.yvV[x] === 2 || s.yvY[x] !== m.ry - s.y) return;
    m.c = 1;
    m.vel = s.yvV[x];
    m.color = s.color;
  }

  // ----- searchers -----------------------------------------------------------

  function newSearcher() {
    const m = {
      rx: maxDist,        // start at the right edge
      ry: 0,
      vtx: maxDist,       // cone vertex (region believed to hold the source)
      vty: 0,
      state: UP_LEFT,
      c: 0,               // concentration at current cell
      vel: 0,             // wind velocity at current cell (valid when c == 1)
      rs: RND(dx),        // constant x jitter so trails don't overprint
      color: colors[RND(ncolors)],
      hist: [],           // trajectory, oldest first (newest pushed last)
    };
    do {
      m.ry = RND(2 * maxDist);
    } while (m.ry < MIN_DIST || m.ry > 2 * maxDist - MIN_DIST);
    m.vty = m.ry;
    m.state = (RND(2) === 0 ? UP_RIGHT : UP_LEFT);
    return m;
  }

  function writeHist(m) {
    m.hist.push({ x: m.rx, y: m.ry });
  }

  // Advance one searcher (the C's move_searcher). If it senses a particle it
  // steps straight up the plume and re-anchors its cone; otherwise it walks the
  // expanding zig-zag cone. x strictly decreases on every UP_* / sense move and
  // the LEFT/RIGHT sweeps close on integer-lattice equalities, so x always
  // reaches < 0 in bounded time -> the search always terminates (no freeze).
  function moveSearcher(m) {
    if (m.c === 1) {
      writeHist(m);
      m.rx -= 1;
      m.ry -= m.vel;
      writeHist(m);
      m.state = (RND(2) === 0 ? UP_LEFT : UP_RIGHT);
      m.vtx = m.rx;
      m.vty = m.ry;
      return;
    }

    switch (m.state) {
      case UP_LEFT:
        m.rx -= 1;
        m.ry += 1;
        m.state = RIGHT;
        writeHist(m);
        return;

      case RIGHT:
        m.ry -= 1;
        if (m.vtx - m.rx === m.vty - m.ry) {
          writeHist(m);
          m.state = UP_RIGHT;
        }
        return;

      case UP_RIGHT:
        m.rx -= 1;
        m.ry -= 1;
        m.state = LEFT;
        writeHist(m);
        return;

      case LEFT:
        m.ry += 1;
        if (m.vtx - m.rx === m.ry - m.vty) {
          writeHist(m);
          m.state = UP_LEFT;
        }
        return;

      default:   // DONE: no movement
        return;
    }
  }

  // ----- simulation step -----------------------------------------------------

  function step() {
    // Evolve sources, reap silenced/empty ones, then maybe spawn into a free
    // slot (the C's spawn probability is 1 / (maxDist * maxSrc) per slot).
    for (let i = 0; i < maxSrc; i++) {
      if (sources[i] === null) continue;
      evolveSource(sources[i]);
      if (sourceDead(sources[i])) sources[i] = null;
    }
    for (let i = 0; i < maxSrc; i++) {
      if (sources[i] === null && RND(maxDist * maxSrc) === 0) {
        sources[i] = newSource();
      }
    }

    // Searchers. Order matches the C: reap DONE, maybe respawn, test for a found
    // source / off-edge, sense, then move.
    for (let i = 0; i < maxSearcher; i++) {
      if (searchers[i] !== null && searchers[i].state === DONE) {
        searchers[i] = null;
      }
      // Respawn into a free slot at the C's rate, 1 / (maxDist * maxSearcher).
      // This makes the total spawn rate near-independent of the slider, so the
      // slider's effect on the steady-state count is sublinear/saturating — the
      // stock behaviour. The drifting plumes (sources fill toward maxSrc) carry
      // the visual density, so the field never looks empty once warmed up.
      if (searchers[i] === null && RND(maxDist * maxSearcher) === 0) {
        searchers[i] = newSearcher();
      }
      if (searchers[i] === null) continue;

      const m = searchers[i];
      m.c = 0;

      // Found a source, or walked off the left edge? (The C only tests the
      // off-edge case inside the per-source loop, so it is skipped when no
      // source is active; we hoist it out so a searcher that leaves the field is
      // always retired -- otherwise its history could grow without bound. When
      // >=1 source is active this matches the C exactly. See md.)
      if (m.rx < 0) {
        m.state = DONE;
      } else {
        for (let j = 0; j < maxSrc; j++) {
          const s = sources[j];
          if (s === null || s.inv_rate === 0) continue;
          if (s.y === m.ry && s.x === m.rx) {
            m.state = DONE;
            s.inv_rate = 0;          // source disappears (drains, then reaped)
            m.color = '#ffffff';     // flash white on success (WhitePixel)
            break;
          }
        }
      }

      // Sense the plume at the current cell.
      if (m.state !== DONE) {
        for (let j = 0; j < maxSrc; j++) {
          if (sources[j] === null) continue;
          getV(sources[j], m);
          if (m.c === 1) break;
        }
      }

      moveSearcher(m);
    }
  }

  // ----- rendering (full repaint) --------------------------------------------

  function render() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    // Sources: a filled disc whose size grows with emission rate, then the
    // drifting particles as small jittered discs (the C nudges each particle
    // off-lattice by RND(dx)/RND(dy) every draw, so the plumes shimmer). Both
    // the blob and the particles are the source colour, so they batch into one
    // path + fill per source. The C draws them with XFillArc (circles).
    const pr = partSize / 2;
    for (let i = 0; i < maxSrc; i++) {
      const s = sources[i];
      if (s === null) continue;

      ctx.fillStyle = s.color;
      ctx.beginPath();

      if (s.inv_rate > 0) {
        const sx = X(s.x);
        const sy = Y(s.y);
        let j = Math.floor(dx * (MAX_INV_RATE + 1 - s.inv_rate) / (2 * MAX_INV_RATE));
        if (j === 0) j = 1;
        ctx.moveTo(sx + j, sy);
        ctx.arc(sx, sy, j, 0, TAU);
      }

      for (let k = 0; k < s.n; k++) {
        if (s.yvV[k] === 2) continue;
        const px = X(s.x + 1 + k) + RND(dx);
        const py = Y(s.y + s.yvY[k]) + RND(dy);
        ctx.moveTo(px + pr, py);
        ctx.arc(px, py, pr, 0, TAU);
      }

      ctx.fill();
    }

    // Searchers: a 4x4 square marker at the head (the C's XFillRectangle), then
    // the whole trajectory as one polyline (current position back through
    // history, newest first, matching the C's draw_searcher).
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = lineWidth;

    for (let i = 0; i < maxSearcher; i++) {
      const m = searchers[i];
      if (m === null) continue;

      ctx.fillStyle = m.color;
      ctx.strokeStyle = m.color;

      const hx = X(m.rx) + m.rs;
      const hy = Y(m.ry);
      ctx.fillRect(hx - 2, hy - 2, 4, 4);

      if (m.hist.length > 0) {
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        for (let k = m.hist.length - 1; k >= 0; k--) {
          ctx.lineTo(X(m.hist[k].x) + m.rs, Y(m.hist[k].y));
        }
        ctx.stroke();
      }
    }
  }

  // ----- init / seeding ------------------------------------------------------

  function init() {
    W = canvas.width;
    H = canvas.height;

    // Clamp distance exactly as the C does (< MIN_DIST -> MIN_DIST+1; cap at MAX).
    maxDist = Math.round(config.distance);
    if (maxDist < MIN_DIST) maxDist = MIN_DIST + 1;
    if (maxDist > MAX_DIST) maxDist = MAX_DIST;

    maxSrc = Math.max(1, Math.round(config.sources));
    maxSearcher = Math.max(1, Math.round(config.searchers));

    // Screen mapping + draw metrics in device px (the C's anemotaxis_init).
    ax = W / maxDist;
    ay = H / (2 * maxDist);
    dx = Math.floor(W / (2 * maxDist)) || 1;
    dy = Math.floor(H / (4 * maxDist)) || 1;
    lineWidth = Math.floor(dx / 3) + 1;
    partSize = (W > 2560 || H > 2560) ? 8 : 4;   // the C's Retina bump

    // The C's palette: make_random_colormap(bright_p=True) — random hues at
    // S 30-100% / V 66-100%, built ONCE and never cycled. Sources/searchers
    // later pick colors[RND(ncolors)]; the white success-flash uses WhitePixel.
    colors = makeRandomColormapRGB(ncolors, true).map(([r, g, b]) => `rgb(${r},${g},${b})`);

    // Boot exactly like anemotaxis_init: ONE source, NO searchers. The field
    // fills in over time via step()'s spawn probabilities, so the port tracks
    // the live binary at every point (warm-up included). No ad-hoc pre-seeding.
    sources = new Array(maxSrc).fill(null);
    sources[0] = newSource();
    searchers = new Array(maxSearcher).fill(null);

    needRender = true;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator loop paced by config.delay (see squiral.js). Drawing is
  // a full repaint, so render() runs once per displayed frame -- but only when a
  // step actually ran (or right after init), to avoid re-jittering the plumes at
  // the display rate when the step rate is slower (this matches the C's one
  // draw per step).
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay anemotaxis runs 36.7 fps, while the
  // port at the stock 20000 us ran ~50 steps/sec (1.36x fast). 20000 + 7248 =
  // 27248 us -> 36.7 steps/sec, matching the live binary. A calibration, not a
  // tuning knob (the delay slider still maps 1:1 to the xml resource).
  const OVERHEAD = 7248;
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
    const delayMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
    }

    if (steps > 0 || needRender) {
      render();
      needRender = false;
    }

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (distance/counts may differ).
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
