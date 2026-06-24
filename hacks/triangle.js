// triangle.js -- triangle packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's triangle.c (Tobias Gloth, 1995; xscreensaver port
// 1997). https://www.jwz.org/xscreensaver/
//
// Builds a random fractal mountain on a triangular height field by midpoint
// displacement: three corner heights are seeded, then the terrain is repeatedly
// subdivided -- each triangle's three edge midpoints get the half-sum of their
// endpoints plus a random displacement that halves every level. The mesh is
// rendered as shaded triangle FACETS in an isometric projection (taller cells
// rise up the screen). Facets are drawn back-to-front (row j = depth, 0 = back),
// so nearer facets overlay farther ones. Each refinement pass redraws the whole
// terrain at finer resolution over the previous (only the sky is cleared between
// passes), so the range visibly sharpens from coarse to fine. When the finest
// pass finishes the terrain dwells a moment, then the screen wipes and a fresh
// height field is generated.
//
// Rendering: sparse vector ops -- one batch of facets per step (a filled polygon
// per facet, sealed with a same-colour hairline to hide canvas anti-alias seams;
// in the mono path, ncolors <= 2, facets are black with a white outline).

export const title = 'triangle';

export const info = {
  author: 'Tobias Gloth',
  description: 'Generates random mountain ranges using iterative subdivision of triangles.',
  year: 1997,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/triangle.xml so the config box maps 1:1.
  // `dwell` is new (see triangle.md): it restores the inter-scene pause the C had
  // in its xlockmore path (MI_PAUSE = 2s) but dropped in the standalone build,
  // measured here in steps rather than microseconds.
  const config = {
    delay: 25000,    // microseconds between steps / facet batches (--delay)
    ncolors: 128,    // size of the rainbow palette (--ncolors)
    dwell: 200,      // steps the finished range lingers before the wipe
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 25000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 128, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'dwell', label: 'Dwell', type: 'range', min: 0, max: 1000, step: 10, default: 200, lowLabel: 'none', highLabel: 'long', live: true },
  ];

  // Simulation constants, straight from triangle.c.
  const MAX_STEPS = 8;          // ceiling on subdivision steps
  const MAX_SIZE = 256;         // 1 << MAX_STEPS, the i-scan width in draw_mesh
  const HALF_PI = Math.PI / 2;  // M_PI_2 in the colour formula
  const SEA = 'hsl(210, 70%, 45%)';  // the C's BLUE (45): "Just the right shade of blue"

  let S = 1;            // devicePixelRatio
  let W = 0, H = 0;     // canvas size, device px
  let size, steps;      // triangular grid side (power of two) and step count
  let field;            // Int32Array height field, triangular (row-major, ragged)
  let rowOff;           // start index of each row i within `field`
  let xpos, ypos;       // precomputed screen positions (device px)
  let deltaArr, one;    // per-level displacement magnitudes; one = deltaArr[0]
  let lineW = 1;        // hairline width for seam sealing / mono outlines

  // The C's mountainstruct state machine and incremental-draw cursor.
  let stage;            // -1 = idle/just-finished, 0 = corners, 1..steps = subdivide
  let initNow;          // true => time to (re)subdivide; false => drawing a pass
  let di, dj, curD;     // draw cursor (tp->i, tp->j) and last subdivision size (tp->d)
  let dwelling;         // true while the finished range lingers before the wipe
  let dwellCount;       // steps elapsed in the dwell

  let palette, ncol, offset;  // rainbow CSS strings, palette length, per-scene rotation

  function nrand(n) {
    return Math.floor(Math.random() * Math.max(1, n));
  }

  // Triangular height-field accessors: row i holds (size + 1 - i) columns, so
  // valid j is [0, size - i]. Matches the C's h[i] pointer fan-out over H[].
  function getH(i, j) {
    return field[rowOff[i] + j];
  }
  function setH(i, j, v) {
    field[rowOff[i] + j] = v;
  }

  // DISPLACE(h,d) = h/2 + uniform[0, 2d+1) - d. h/2 is integer division (toward
  // zero); the random part lands in [-d, d+1). Caller truncates the result toward
  // zero on store, mirroring the C's (short int) cast.
  function displaceRaw(hsum, d) {
    return Math.trunc(hsum / 2) + Math.random() * (2 * d + 1) - d;
  }

  // Screen height-offset for a raw cell height, = the C's level[MAX(h,0)] table
  // entry (i*i)/one. Computed on the fly (the C's table is only 1000 long and a
  // tall peak can index past it -- undefined there; here it is always defined).
  function heightY(hv) {
    const h = hv > 0 ? hv : 0;
    return Math.trunc((h * h) / one);
  }

  function buildPalette() {
    ncol = Math.max(1, Math.round(config.ncolors));
    palette = new Array(ncol);
    for (let i = 0; i < ncol; i++) {
      palette[i] = `hsl(${Math.round(i * 360 / ncol)}, 80%, 55%)`;
    }
  }

  // Fill one facet, shaded by its height SPREAD (the C's draw_atriangle): flat
  // sea-level facets are blue water; otherwise the steeper the facet the lower
  // the palette index, via atan of the spread. `offset` rotates the gradient per
  // scene to emulate the C remaking a fresh smooth colormap each range.
  function paint(x0, y0, x1, y1, x2, y2, h0, h1, h2, dinv) {
    const mono = ncol <= 2;
    let style;
    if (!mono) {
      const dmin = Math.min(h0, h1, h2);
      const dmax = Math.max(h0, h1, h2);
      if (dmax === 0) {
        style = SEA;
      } else {
        let color = ncol - Math.trunc(ncol / HALF_PI * Math.atan(dinv * (dmax - dmin)));
        color = (color + offset) % ncol;
        if (color < 0) color += ncol;
        style = palette[color];
      }
    }

    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.closePath();

    if (mono) {
      // The C's mono path: black fill (backface removal) then white outline.
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = lineW;
      ctx.stroke();
    } else {
      ctx.fillStyle = style;
      ctx.fill();
      // The C leaves coloured facets un-outlined; a same-colour hairline seals
      // the anti-alias seams canvas leaves between abutting fills.
      ctx.strokeStyle = style;
      ctx.lineWidth = lineW;
      ctx.stroke();
    }
  }

  // The two facets of a grid cell (the C's calc_points1 / calc_points2). p[2]
  // sits on the next row down (j+d) -- subtracting heightY raises peaks up-screen.
  function paintFacet1(d, dinv) {
    const i = di, j = dj;
    const a = heightY(getH(i, j));
    const b = heightY(getH(i + d, j));
    const c = heightY(getH(i, j + d));
    paint(
      xpos[2 * i + j],         ypos[j] - a,
      xpos[2 * (i + d) + j],   ypos[j] - b,
      xpos[2 * i + (j + d)],   ypos[j + d] - c,
      a, b, c, dinv,
    );
  }
  function paintFacet2(d, dinv) {
    const i = di, j = dj;
    const a = heightY(getH(i + d, j));
    const b = heightY(getH(i + d, j + d));
    const c = heightY(getH(i, j + d));
    paint(
      xpos[2 * (i + d) + j],         ypos[j] - a,
      xpos[2 * (i + d) + (j + d)],   ypos[j + d] - b,
      xpos[2 * i + (j + d)],         ypos[j + d] - c,
      a, b, c, dinv,
    );
  }

  // Draw up to `count` cells of the mesh at resolution dDraw, resuming from the
  // (di, dj) cursor (the C's draw_mesh). Clears just the sky on a fresh pass; sets
  // initNow when the pass reaches the front row (dj === size).
  function drawMesh(dDraw, count) {
    const dinv = 0.2 / dDraw;
    let first = true;

    if (dj === 0 && di === 0) {
      // Wipe only the sky above the back baseline; the body is overdrawn finer.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, ypos[0]);
    }

    for (; dj < size && count > 0; dj += (count > 0 ? dDraw : 0)) {
      for (di = first ? di : 0, first = false;
           di < MAX_SIZE - dj && count > 0;
           di += dDraw, count--) {
        if (di + dj < size) paintFacet1(dDraw, dinv);
        if (di + dj + dDraw < size) paintFacet2(dDraw, dinv);
      }
    }

    if (dj === size) initNow = true;
  }

  // One animation step (the C's draw_triangle). Either advances the dwell, draws
  // a batch of facets, or subdivides one more level -- exactly one per tick.
  function step() {
    if (dwelling) {
      if (++dwellCount > config.dwell) {
        // Wipe and pick a fresh palette rotation (the C clears + remakes colors).
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        offset = ncol > 2 ? nrand(ncol) : 0;
        dwelling = false;
        // stage is -1 and initNow is true, so the next tick starts a new scene.
      }
      return;
    }

    if (!initNow) {
      drawMesh(curD >> 1, Math.floor(MAX_SIZE / curD));
      // The finest pass (drawn while stage === -1) finishing means the range is
      // complete: linger on it, then wipe.
      if (initNow && stage === -1) {
        dwelling = true;
        dwellCount = 0;
      }
      return;
    }

    // Subdivision tick.
    if (deltaArr[0] > 0) {
      stage++;
      if (stage === 0) {
        // Seed the three corner heights (clamped to >= 0).
        setH(0, 0,       Math.trunc(Math.max(0, displaceRaw(0, deltaArr[0]))));
        setH(size, 0,    Math.trunc(Math.max(0, displaceRaw(0, deltaArr[0]))));
        setH(0, size,    Math.trunc(Math.max(0, displaceRaw(0, deltaArr[0]))));
      } else {
        const d = 2 << (steps - stage);   // cell size at this level (256 down to 2)
        const d2 = d >> 1;
        const delta = deltaArr[stage - 1];
        for (let i = 0; i < size; i += d) {
          for (let j = 0; j < size - i; j += d) {
            setH(i + d2, j,      Math.trunc(displaceRaw(getH(i, j) + getH(i + d, j), delta)));
            setH(i, j + d2,      Math.trunc(displaceRaw(getH(i, j) + getH(i, j + d), delta)));
            setH(i + d2, j + d2, Math.trunc(displaceRaw(getH(i + d, j) + getH(i, j + d), delta)));
          }
        }
        initNow = false;
        di = 0;
        dj = 0;
        curD = d;
      }
    }

    // After the finest subdivision, drop to the idle stage; its drawing pass then
    // completes into the dwell.
    if (stage === steps) stage = -1;
  }

  // Generate a fresh scene sized to the canvas (the C's init_triangle): choose the
  // grid, precompute projection tables and displacement magnitudes, reset the
  // state machine, and clear to black.
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    lineW = Math.max(1, Math.round(S));

    // Largest power-of-two grid whose 5x footprint fits the width (the C's loop),
    // floored at size 2 so subdivision always has something to do.
    steps = MAX_STEPS;
    do {
      steps -= 1;
      size = 1 << steps;
    } while (size * 5 > W && steps > 1);

    const dim = Math.min(W, H);

    // Triangular field: row i has (size + 1 - i) columns.
    rowOff = new Int32Array(size + 1);
    let acc = 0;
    for (let i = 0; i <= size; i++) {
      rowOff[i] = acc;
      acc += size + 1 - i;
    }
    field = new Int32Array(acc);

    // Isometric x: i/(2*size) mapped to [LEFT, RIGHT] = [-0.25, 1.25] of dim,
    // centred. The 2i+j skew (applied at draw time) shears rows rightward.
    xpos = new Int32Array(2 * size + 1);
    for (let i = 0; i <= 2 * size; i++) {
      xpos[i] = Math.trunc((i / (2 * size) * 1.5 - 0.25) * dim) + Math.trunc((W - dim) / 2);
    }
    // Row baselines: j/size mapped to [TOP, BOTTOM] = [0.3, 1.0] of dim, centred.
    ypos = new Int32Array(size + 1);
    for (let i = 0; i <= size; i++) {
      ypos[i] = Math.trunc((i / size * 0.7 + 0.3) * dim) + Math.trunc((H - dim) / 2);
    }

    // Displacement magnitude halves each level; `one` scales the height->screen
    // quadratic. Guarded to >= 1 so heightY never divides by zero.
    const deltaBase = Math.trunc(0.4 * dim);
    deltaArr = new Int32Array(steps);
    for (let i = 0; i < steps; i++) deltaArr[i] = Math.floor(deltaBase / (1 << i));
    one = Math.max(1, deltaArr[0]);

    buildPalette();
    offset = ncol > 2 ? nrand(ncol) : 0;

    stage = -1;
    initNow = true;
    dwelling = false;
    dwellCount = 0;
    di = 0;
    dj = 0;
    curD = 2;   // never read before the first subdivision sets it; defensive only

    ctx.lineJoin = 'round';
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

  // rAF lag-accumulator paced by config.delay (microseconds): run one step() per
  // delay, banking leftover time so the build speed is identical at any refresh
  // rate. Cap catch-up so a backgrounded tab doesn't burst on refocus.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = config.delay / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps2 = 0;
    while (lag >= delayMs && steps2 < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps2++;
    }

    rafId = requestAnimationFrame(frame);
  }

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
