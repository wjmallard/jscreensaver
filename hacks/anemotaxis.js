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
// Rendering: SPARSE vector drawing with a FULL REPAINT each frame. The C clears
// its back buffer on every draw, then redraws every source dot, every drifting
// particle, and each searcher's whole trajectory as a polyline — so there is no
// persistent canvas / ring buffer here. Trails live in each searcher's history
// list and are re-stroked from scratch each frame. Contrast [[grav]] and
// [[whirlwindwarp]], which use a persistent canvas + erase-old/draw-new instead.

export const title = 'anemotaxis';

export const info = {
  author: 'Eugene Balkovski',
  description: 'Searches for a source of odor in a turbulent atmosphere.',
  year: 2004,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/anemotaxis.xml so the tuning UI maps 1:1
  // to the original. `colors` is the stock hack's --colors option (default 20 in
  // anemotaxis_defaults, not shown in the xml UI); we expose it as a palette size
  // like grav/squiral do.
  const config = {
    delay: 50000,     // µs between steps (--delay)
    distance: 40,     // size of the lattice (--distance)
    sources: 25,      // number of odor sources (--sources)
    searchers: 25,    // number of searchers (--searchers)
    ncolors: 20,      // size of the rainbow palette (--colors)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 50000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'distance', label: 'Distance', type: 'range', min: 10, max: 250, step: 1, default: 40, lowLabel: 'near', highLabel: 'far', live: false },
    { key: 'sources', label: 'Sources', type: 'range', min: 1, max: 100, step: 1, default: 25, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'searchers', label: 'Searchers', type: 'range', min: 1, max: 100, step: 1, default: 25, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 20, lowLabel: 'two', highLabel: 'many', live: false },
  ];

  // Lattice / emission constants, verbatim from anemotaxis.c.
  const MAX_DIST = 250;
  const MIN_DIST = 10;
  const MAX_INV_RATE = 5;
  const TAU = Math.PI * 2;

  // Searcher state machine (the C's enum {UP_LEFT, UP_RIGHT, LEFT, RIGHT, DONE});
  // only the names matter, never the numeric values.
  const UP_LEFT = 0;
  const UP_RIGHT = 1;
  const LEFT = 2;
  const RIGHT = 3;
  const DONE = 4;

  let S = 1;            // devicePixelRatio
  let W, H;             // canvas size, device px

  let maxDist;          // lattice size (clamped distance)
  let maxSrc;           // number of source slots
  let maxSearcher;      // number of searcher slots
  let ncolors;          // palette length

  // Screen mapping (the C's X()/Y() macros, bx = by = 0): lattice -> device px.
  let ax, ay;           // scale factors
  let dx, dy;           // small x/y jitter spans (also drive line width)
  let lineWidth;        // trajectory stroke width (the C's dx/3 + 1)
  let dotSize, dotHalf; // particle / searcher marker size in device px

  let colors;           // rainbow palette of hsl() strings
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
      // Respawn into a free slot. The C uses 1 / (maxDist * maxSearcher), which
      // makes the *total* spawn rate independent of the slider -- equilibrium is
      // ~5 searchers no matter how many you ask for, so the field looks empty and
      // the Searchers control does almost nothing. We use 1 / (maxDist * 4) so
      // the slider genuinely scales the population and the fans stay lively. See md.
      if (searchers[i] === null && RND(maxDist * 4) === 0) {
        searchers[i] = newSearcher();
      }
      if (searchers[i] === null) continue;

      const m = searchers[i];
      m.c = 0;

      // Found a source, or walked off the left edge? (The C only tests the
      // off-edge case inside the per-source loop, so it is skipped when no
      // source is active; we hoist it out so a searcher that leaves the field is
      // always retired -- otherwise its history could grow without bound. See md.)
      if (m.rx < 0) {
        m.state = DONE;
      } else {
        for (let j = 0; j < maxSrc; j++) {
          const s = sources[j];
          if (s === null || s.inv_rate === 0) continue;
          if (s.y === m.ry && s.x === m.rx) {
            m.state = DONE;
            s.inv_rate = 0;          // source disappears (drains, then reaped)
            m.color = '#ffffff';     // flash white on success
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

    // Sources: a filled blob whose size grows with emission rate, then the
    // drifting particles as small jittered squares (the C nudges each particle
    // off-lattice by RND(dx)/RND(dy) every frame, so the plumes shimmer).
    for (let i = 0; i < maxSrc; i++) {
      const s = sources[i];
      if (s === null) continue;

      ctx.fillStyle = s.color;

      if (s.inv_rate > 0) {
        const sx = X(s.x);
        const sy = Y(s.y);
        let j = Math.floor(dx * (MAX_INV_RATE + 1 - s.inv_rate) / (2 * MAX_INV_RATE));
        if (j === 0) j = 1;
        ctx.beginPath();
        ctx.arc(sx, sy, j, 0, TAU);
        ctx.fill();
      }

      for (let k = 0; k < s.n; k++) {
        if (s.yvV[k] === 2) continue;
        const px = X(s.x + 1 + k) + RND(dx);
        const py = Y(s.y + s.yvY[k]) + RND(dy);
        ctx.fillRect(px - dotHalf, py - dotHalf, dotSize, dotSize);
      }
    }

    // Searchers: a marker at the head, then the whole trajectory as one polyline
    // (current position back through history, newest first, matching the C).
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
      ctx.fillRect(hx - dotHalf, hy - dotHalf, dotSize, dotSize);

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
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // Clamp distance exactly as the C does (< MIN_DIST -> MIN_DIST+1; cap at MAX).
    maxDist = Math.round(config.distance);
    if (maxDist < MIN_DIST) maxDist = MIN_DIST + 1;
    if (maxDist > MAX_DIST) maxDist = MAX_DIST;

    maxSrc = Math.max(1, Math.round(config.sources));
    maxSearcher = Math.max(1, Math.round(config.searchers));
    ncolors = Math.max(1, Math.round(config.ncolors));

    // Screen mapping in device px (dpr folds in through W/H).
    ax = W / maxDist;
    ay = H / (2 * maxDist);
    dx = Math.floor(W / (2 * maxDist)) || 1;
    dy = Math.floor(H / (4 * maxDist)) || 1;
    lineWidth = Math.floor(dx / 3) + 1;
    dotSize = Math.max(1, Math.round(4 * S));
    dotHalf = dotSize / 2;

    // Vivid rainbow palette (the C uses a random colormap; we prefer hues).
    colors = [];
    for (let i = 0; i < ncolors; i++) {
      colors.push(`hsl(${Math.round(i * 360 / ncolors)}, 100%, 55%)`);
    }

    // Seed a populated first frame. The C starts with a single source and no
    // searchers and lets them fill in over ~20 s; we instead seed several plumes
    // (pre-evolved so their particle streams already reach across the lattice)
    // and one searcher per slot, each advanced a random way in so the fans are
    // already spread between the right edge and the source. See md.
    sources = new Array(maxSrc).fill(null);
    const seedSources = Math.min(maxSrc, 5);
    for (let i = 0; i < seedSources; i++) {
      sources[i] = newSource();
      for (let e = 0; e < sources[i].n; e++) evolveSource(sources[i]);
    }

    searchers = new Array(maxSearcher).fill(null);
    for (let i = 0; i < maxSearcher; i++) {
      const m = newSearcher();
      const targetX = RND(maxDist);   // distribute heads across the lattice
      let guard = 0;
      while (m.rx > targetX && m.rx > 0 && guard < 20000) {
        m.c = 0;                      // pure cone walk during seeding (no plume)
        moveSearcher(m);
        guard++;
      }
      searchers[i] = m;
    }

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
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    // config.delay is microseconds (xml units); the rAF clock is milliseconds.
    const delayMs = config.delay / 1000;
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

  // Re-seed with the current config (distance/counts/colors may differ).
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
