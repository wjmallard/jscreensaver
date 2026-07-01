// celtic.js -- celtic packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's celtic.c (Max Froumentin, 2006).
// https://www.jwz.org/xscreensaver/
//
// Repeatedly draws random Celtic knot-work. The knot is built from a planar
// GRAPH (one of four kinds -- square grid, "Kennicott" diamonds, triangular
// lattice, or polar orbits). The interlaced band is the boundary of a tubular
// neighbourhood of the graph: the trace walks the graph's directed edge-sides,
// turning to the next edge around each node and flipping the turn direction
// each time it crosses an edge, so it weaves a closed loop whose strands cross
// at every edge midpoint. Each turn contributes one cubic Bezier segment that
// rounds the node, so the woven band is smooth.
//
// OVER/UNDER (the woven look): exactly as the C, this is an emergent property
// of the drawing ORDER, not an explicitly computed crossing assignment. All
// bands are revealed in lock-step along a shared parameter t in [0, 1]. While a
// band's coloured tip is drawn at t, a "shadow" segment (background colour,
// wider than the strand) is drawn a little AHEAD of the tip. At a crossing the
// band whose t is larger arrives later, so its shadow erases the earlier band
// and then its colour paints over -- the earlier band appears to dip UNDER.
// (See the .md for the honest caveat: the alternation is whatever the C's
// shadow trick yields, it is not enforced per crossing.)
//
// Rendering: SPARSE vector strokes (short coloured + shadow line segments with
// round caps), drawn progressively onto the persistent canvas. No per-pixel
// blit, no XOR. When the knot finishes it lingers, then the canvas clears and a
// fresh graph + palette are generated. See [[truchet]] / [[penrose]] for the
// grid-graph tiling idiom and [[squiral]] for the module skeleton.

import { makeSmoothColormapRGB } from './colormap.js';

export const title = 'celtic';

export const info = {
  author: 'Max Froumentin',
  description: 'Repeatedly draws random Celtic cross-stitch patterns.\n\nhttps://en.wikipedia.org/wiki/Celtic_knot\nhttps://en.wikipedia.org/wiki/Knots_and_graphs',
  year: 2006,
};

// ----- pure helpers (module scope so a headless harness can exercise them) ---

// random integer in [0, n) -- matches the C's random() % n.
const irand = (n) => Math.floor(Math.random() * n);

// fractional part, the analogue of the C's fmod(t, 1.0) for t >= 0.
const frac = (t) => t - Math.floor(t);

function newNode(x, y) {
  return {
    x,
    y,
    edges: [],
  };
}

// Edge angles are computed ONCE here, from the node coordinates at creation
// time. The graph is rotated afterwards (rigidly), which leaves these absolute
// angles stale -- but the trace only ever uses angle DIFFERENCES around a node
// (edge_angle_to / next_edge_around), which are rotation invariant, so this is
// faithful to the C (graph_rotate likewise never recomputes edge angles).
// NB: the C adds 6.28 (not 2*PI) here on purpose; kept for bit-fidelity.
function newEdge(n1, n2) {
  let a1 = Math.atan2(n2.y - n1.y, n2.x - n1.x);
  if (a1 < 0) a1 += 6.28;
  let a2 = Math.atan2(n1.y - n2.y, n1.x - n2.x);
  if (a2 < 0) a2 += 6.28;
  return {
    node1: n1,
    node2: n2,
    angle1: a1,
    angle2: a2,
    id: -1,
  };
}

function newGraph() {
  return {
    nodes: [],
    edges: [],
  };
}

function addNode(g, n) {
  g.nodes.push(n);
}

function addEdge(g, e) {
  e.id = g.edges.length;
  g.edges.push(e);
  e.node1.edges.push(e);
  e.node2.edges.push(e);
}

// the angle of edge e at node n.
function edgeAngle(e, n) {
  return (n === e.node1) ? e.angle1 : e.angle2;
}

// the node of e that is not n.
function edgeOtherNode(e, n) {
  return (n === e.node1) ? e.node2 : e.node1;
}

// absolute angle from e to e2 around node, following direction (0 = CLOCKWISE,
// 1 = ANTICLOCKWISE). Note 2*PI here (the C uses 2*M_PI in edge_angle_to even
// though edge_new used 6.28 -- both kept verbatim).
function edgeAngleTo(e, e2, node, direction) {
  let a;
  if (direction === 0) {
    a = edgeAngle(e, node) - edgeAngle(e2, node);
  } else {
    a = edgeAngle(e2, node) - edgeAngle(e, node);
  }
  return (a < 0) ? a + 2 * Math.PI : a;
}

// the next edge after e around node n, turning in `direction`.
function graphNextEdgeAround(n, e, direction) {
  let minangle = 20;
  let nextEdge = e;
  for (let i = 0; i < n.edges.length; i++) {
    const edge = n.edges[i];
    if (edge !== e) {
      const angle = edgeAngleTo(e, edge, n, direction);
      if (angle < minangle) {
        nextEdge = edge;
        minangle = angle;
      }
    }
  }
  return nextEdge;
}

// rotate every node of the graph rigidly around (cx, cy).
function graphRotate(g, angle, cx, cy) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let i = 0; i < g.nodes.length; i++) {
    const n = g.nodes[i];
    const x = n.x;
    const y = n.y;
    n.x = (x - cx) * c - (y - cy) * s + cx;
    n.y = (x - cx) * s + (y - cy) * c + cy;
  }
}

// ----- graph constructors (one per pattern type) ----------------------------
// xmin/ymin/width/height/step are all in device px; index math copied verbatim
// from the C (including the triangle graph's transposed create-vs-edge indices).

function makeGridGraph(xmin, ymin, width, height, step) {
  const size = (width < height) ? height : width;
  // empirically there are only 2 curves when both counts are even, so the
  // C rounds them to even; that even/odd choice changes how many bands form.
  const q = Math.floor(size / step);
  const nbcol = Math.floor((2 + q) / 2) * 2;
  const nbrow = Math.floor((2 + q) / 2) * 2;
  const grid = new Array(nbrow * nbcol);
  const g = newGraph();

  // centre the grid in the (possibly oversized) area.
  xmin += Math.trunc((width - (nbcol - 1) * step) / 2);
  ymin += Math.trunc((height - (nbrow - 1) * step) / 2);

  for (let row = 0; row < nbrow; row++) {
    for (let col = 0; col < nbcol; col++) {
      const x = col * step + xmin;
      const y = row * step + ymin;
      const n = newNode(x, y);
      grid[row + col * nbrow] = n;
      addNode(g, n);
    }
  }

  for (let row = 0; row < nbrow; row++) {
    for (let col = 0; col < nbcol; col++) {
      if (col !== nbcol - 1) {
        addEdge(g, newEdge(grid[row + col * nbrow], grid[row + (col + 1) * nbrow]));
      }
      if (row !== nbrow - 1) {
        addEdge(g, newEdge(grid[row + col * nbrow], grid[row + 1 + col * nbrow]));
      }
      if (col !== nbcol - 1 && row !== nbrow - 1) {
        addEdge(g, newEdge(grid[row + col * nbrow], grid[row + 1 + (col + 1) * nbrow]));
        addEdge(g, newEdge(grid[row + 1 + col * nbrow], grid[row + (col + 1) * nbrow]));
      }
    }
  }

  return g;
}

function makeKennicottGraph(xmin, ymin, width, height, step, clusterSize) {
  const size = (width < height) ? height : width;
  const q = Math.floor(size / step);
  const nbcol = Math.floor((1 + q) / 2) * 2;
  const nbrow = Math.floor((1 + q) / 2) * 2;
  const grid = new Array(5 * nbrow * nbcol);
  const g = newGraph();

  xmin += Math.trunc((width - (nbcol - 1) * step) / 2);
  ymin += Math.trunc((height - (nbrow - 1) * step) / 2);

  for (let row = 0; row < nbrow; row++) {
    for (let col = 0; col < nbcol; col++) {
      const ci = 5 * (row + col * nbrow);
      const x = col * step + xmin;
      const y = row * step + ymin;

      // a diamond cluster centred on (x, y):  /|\  --- \|/
      grid[ci] = newNode(x, y);
      grid[ci + 1] = newNode(x + clusterSize, y);
      grid[ci + 2] = newNode(x, y - clusterSize);
      grid[ci + 3] = newNode(x - clusterSize, y);
      grid[ci + 4] = newNode(x, y + clusterSize);

      addNode(g, grid[ci]);
      addNode(g, grid[ci + 1]);
      addNode(g, grid[ci + 2]);
      addNode(g, grid[ci + 3]);
      addNode(g, grid[ci + 4]);

      // internal edges
      addEdge(g, newEdge(grid[ci], grid[ci + 1]));
      addEdge(g, newEdge(grid[ci], grid[ci + 2]));
      addEdge(g, newEdge(grid[ci], grid[ci + 3]));
      addEdge(g, newEdge(grid[ci], grid[ci + 4]));
      addEdge(g, newEdge(grid[ci + 1], grid[ci + 2]));
      addEdge(g, newEdge(grid[ci + 2], grid[ci + 3]));
      addEdge(g, newEdge(grid[ci + 3], grid[ci + 4]));
      addEdge(g, newEdge(grid[ci + 4], grid[ci + 1]));
    }
  }

  // inter-cluster edges
  for (let row = 0; row < nbrow; row++) {
    for (let col = 0; col < nbcol; col++) {
      if (col !== nbcol - 1) {
        addEdge(g, newEdge(grid[5 * (row + col * nbrow) + 1], grid[5 * (row + (col + 1) * nbrow) + 3]));
      }
      if (row !== nbrow - 1) {
        addEdge(g, newEdge(grid[5 * (row + col * nbrow) + 4], grid[5 * (row + 1 + col * nbrow) + 2]));
      }
    }
  }

  return g;
}

function makeTriangleGraph(xmin, ymin, width, height, edgeSize) {
  const SQRT_3 = 1.73205080756887729352;
  const L = (width < height ? width : height) / 2.0;     // circumradius
  const cx = xmin + width / 2.0;
  const cy = ymin + height / 2.0;
  const p2x = cx - L * SQRT_3 / 2.0;                     // bottom-left vertex
  const p2y = cy + L / 2.0;
  let nsteps = Math.trunc(3 * L / (SQRT_3 * edgeSize));
  if (nsteps < 1) nsteps = 1;                            // guard div-by-zero

  const grid = new Array((nsteps + 1) * (nsteps + 1));
  const g = newGraph();

  // create node grid (NB: the C stores at col+row*(nsteps+1) ...)
  for (let row = 0; row <= nsteps; row++) {
    for (let col = 0; col <= nsteps; col++) {
      if (row + col <= nsteps) {
        const x = p2x + col * L * SQRT_3 / nsteps + row * L * SQRT_3 / (2 * nsteps);
        const y = p2y - row * 3 * L / (2 * nsteps);
        const n = newNode(x, y);
        grid[col + row * (nsteps + 1)] = n;
        addNode(g, n);
      }
    }
  }

  // ... but indexes edges as row+col*(nsteps+1); the valid triangle is
  // symmetric in (row, col) so every referenced node exists. Kept verbatim.
  for (let row = 0; row < nsteps; row++) {
    for (let col = 0; col < nsteps; col++) {
      if (row + col < nsteps) {
        addEdge(g, newEdge(grid[row + col * (nsteps + 1)], grid[row + (col + 1) * (nsteps + 1)]));
        addEdge(g, newEdge(grid[row + col * (nsteps + 1)], grid[row + 1 + col * (nsteps + 1)]));
        addEdge(g, newEdge(grid[row + 1 + col * (nsteps + 1)], grid[row + (col + 1) * (nsteps + 1)]));
      }
    }
  }

  return g;
}

function makePolarGraph(xmin, ymin, width, height, nbp, nbo) {
  const cx = Math.trunc(width / 2) + xmin;
  const cy = Math.trunc(height / 2) + ymin;
  const os = Math.trunc((width < height ? width : height) / (2 * nbo)); // orbit gap
  const grid = new Array(1 + nbp * nbo);
  const g = newGraph();

  grid[0] = newNode(cx, cy);
  addNode(g, grid[0]);

  for (let o = 0; o < nbo; o++) {
    for (let p = 0; p < nbp; p++) {
      const n = newNode(
        cx + (o + 1) * os * Math.sin(p * 2 * Math.PI / nbp),
        cy + (o + 1) * os * Math.cos(p * 2 * Math.PI / nbp),
      );
      grid[1 + o * nbp + p] = n;
      addNode(g, n);
    }
  }

  for (let o = 0; o < nbo; o++) {
    for (let p = 0; p < nbp; p++) {
      if (o === 0) {
        addEdge(g, newEdge(grid[1 + o * nbp + p], grid[0]));
      } else {
        addEdge(g, newEdge(grid[1 + o * nbp + p], grid[1 + (o - 1) * nbp + p]));
      }
      addEdge(g, newEdge(grid[1 + o * nbp + p], grid[1 + o * nbp + (p + 1) % nbp]));
    }
  }

  return g;
}

// ----- spline (knot band) construction --------------------------------------

// one cubic Bezier segment rounding `node`, joining the midpoint of edge1 to
// the midpoint of edge2. Faithful to pattern_draw_spline_direction.
function patternDrawSplineDirection(s, node, edge1, edge2, direction, shape1, shape2) {
  const x1 = (edge1.node1.x + edge1.node2.x) / 2.0;
  const y1 = (edge1.node1.y + edge1.node2.y) / 2.0;
  const x4 = (edge2.node1.x + edge2.node2.x) / 2.0;
  const y4 = (edge2.node1.y + edge2.node2.y) / 2.0;

  const alpha = edgeAngleTo(edge1, edge2, node, direction) * shape1;
  const beta = shape2;

  let i1x;
  let i1y;
  let i2x;
  let i2y;
  let x2;
  let y2;
  let x3;
  let y3;

  if (direction === 1) {
    // ANTICLOCKWISE: I1 sticks out left of NP1, I2 right of NP4.
    i1x = alpha * (node.y - y1) + x1;
    i1y = -alpha * (node.x - x1) + y1;
    i2x = -alpha * (node.y - y4) + x4;
    i2y = alpha * (node.x - x4) + y4;
    x2 = beta * (y1 - i1y) + i1x;
    y2 = -beta * (x1 - i1x) + i1y;
    x3 = -beta * (y4 - i2y) + i2x;
    y3 = beta * (x4 - i2x) + i2y;
  } else {
    // CLOCKWISE
    i1x = -alpha * (node.y - y1) + x1;
    i1y = alpha * (node.x - x1) + y1;
    i2x = alpha * (node.y - y4) + x4;
    i2y = -alpha * (node.x - x4) + y4;
    x2 = -beta * (y1 - i1y) + i1x;
    y2 = beta * (x1 - i1x) + i1y;
    x3 = beta * (y4 - i2y) + i2x;
    y3 = -beta * (x4 - i2x) + i2y;
  }

  s.segments.push({
    x1,
    y1,
    x2,
    y2,
    x3,
    y3,
    x4,
    y4,
  });
}

// Walk the graph's directed edge-sides into closed knot bands (pattern_make_
// curves). ec[edgeId] = [clockwiseUsed, anticlockwiseUsed]; every (edge,
// direction) couple is consumed exactly once across all bands.
function traceSplines(g, shape1, shape2, ncolors) {
  const edges = g.edges;
  const nb = edges.length;
  const ec = [];
  for (let i = 0; i < nb; i++) ec.push([0, 0]);

  const splines = [];

  // first unfilled (edge, direction) couple, scanning edges in order.
  function nextUnfilled() {
    for (let i = 0; i < nb; i++) {
      if (ec[i][0] === 0) return { edge: edges[i], dir: 0 };
      if (ec[i][1] === 0) return { edge: edges[i], dir: 1 };
    }
    return null;
  }

  let nu;
  while ((nu = nextUnfilled())) {
    const s = {
      segments: [],
      color: irand(ncolors - 2) + 2,
    };
    splines.push(s);

    let currentEdge = nu.edge;
    let currentDirection = nu.dir;
    const firstEdge = currentEdge;
    const firstDirection = currentDirection;
    const firstNode = currentEdge.node1;
    let currentNode = firstNode;

    // the walk is a cycle in a finite permutation, so it must return to its
    // start; the cap is a defensive guard only (never expected to fire).
    const cap = 2 * nb + 10;
    let guard = 0;
    do {
      ec[currentEdge.id][currentDirection] = 1;
      const nextEdge = graphNextEdgeAround(currentNode, currentEdge, currentDirection);
      patternDrawSplineDirection(s, currentNode, currentEdge, nextEdge, currentDirection, shape1, shape2);

      // cross the edge
      currentEdge = nextEdge;
      currentNode = edgeOtherNode(nextEdge, currentNode);
      currentDirection = 1 - currentDirection;

      guard++;
      if (guard > cap) break;
    } while (currentNode !== firstNode || currentEdge !== firstEdge || currentDirection !== firstDirection);

    // a 2-segment spline is degenerate ("just one point"): drop it.
    if (s.segments.length === 2) {
      splines[splines.length - 1] = null;
    }
  }

  return splines;
}

// evaluate spline at parameter t in [0, 1) -> { x, y, segment }.
function splineValueAt(s, t) {
  const n = s.segments.length;
  const f = t * n;
  let si = Math.floor(f);
  let tt = f - si;
  if (si >= n) {
    si = n - 1;
    tt = 1;
  }
  if (si < 0) {
    si = 0;
    tt = 0;
  }
  const ss = s.segments[si];
  const u = 1 - tt;
  const x = ss.x1 * u * u * u + 3 * ss.x2 * tt * u * u + 3 * ss.x3 * tt * tt * u + ss.x4 * tt * tt * tt;
  const y = ss.y1 * u * u * u + 3 * ss.y2 * tt * u * u + 3 * ss.y3 * tt * tt * u + ss.y4 * tt * tt * tt;
  return {
    x,
    y,
    segment: si,
  };
}

// Roll a fresh set of random parameters, faithfully to celtic_draw's switch.
// forcedType: null = random; 0 grid, 1 kennicott, 2 triangle, 3 polar.
function rollParams(forcedType) {
  const p = {
    curveWidth: irand(5) + 4,
  };
  p.shadowWidth = p.curveWidth + 4;
  p.shape1 = (15 + irand(15)) / 10.0 - 1.0;
  p.shape2 = (15 + irand(15)) / 10.0 - 1.0;
  p.edgeSize = 10 * irand(5) + 20;
  p.angle = irand(360) * 2 * Math.PI / 360;
  p.margin = irand(8) * 100 - 600;

  const type = (forcedType == null) ? irand(4) : forcedType;
  switch (type) {
    case 0:
      p.type = 'grid';
      // NB: irand(1) is ALWAYS 0, so this reduces to -1.0 * (3..12)/10
      // (a quirk of the original; kept for fidelity).
      p.shape1 = (irand(1) * 2 - 1.0) * (irand(10) + 3) / 10.0;
      p.shape2 = (irand(1) * 2 - 1.0) * (irand(10) + 3) / 10.0;
      p.edgeSize = 10 * irand(5) + 50;
      break;
    case 1:
      p.type = 'kennicott';
      p.shape1 = irand(20) / 10.0 - 1.0;
      p.shape2 = irand(20) / 10.0 - 1.0;
      p.edgeSize = 10 * irand(3) + 70;
      p.clusterSize = Math.trunc(p.edgeSize / (3.0 + irand(10)) - 1);
      break;
    case 2:
      p.type = 'triangle';
      p.edgeSize = 10 * irand(5) + 60;
      p.margin = irand(10) * 100 - 900;
      break;
    case 3:
      p.type = 'polar';
      p.nbOrbits = 2 + irand(10);
      p.nbNodesPerOrbit = 4 + irand(10);
      break;
    default:
      p.type = 'grid';
      break;
  }
  return p;
}

// Build the graph for a rolled param set, scaled into device px and rotated.
function buildGraph(p, W, H, S) {
  const margin = Math.round(p.margin * S);
  const gw = W - 2 * margin;
  const gh = H - 2 * margin;
  const edgeSize = Math.max(2, Math.round(p.edgeSize * S));
  let g;
  switch (p.type) {
    case 'kennicott':
      g = makeKennicottGraph(margin, margin, gw, gh, edgeSize, Math.max(1, Math.round((p.clusterSize || 1) * S)));
      break;
    case 'triangle':
      g = makeTriangleGraph(margin, margin, gw, gh, edgeSize);
      break;
    case 'polar':
      g = makePolarGraph(margin, margin, gw, gh, p.nbNodesPerOrbit, p.nbOrbits);
      break;
    case 'grid':
    default:
      g = makeGridGraph(margin, margin, gw, gh, edgeSize);
      break;
  }
  graphRotate(g, p.angle, W / 2, H / 2);
  return g;
}

// test hook (ignored by the host, used by the headless harness).
export const __test = {
  makeGridGraph,
  makeKennicottGraph,
  makeTriangleGraph,
  makePolarGraph,
  rollParams,
  buildGraph,
  traceSplines,
  splineValueAt,
};

// ----- the mountable hack ---------------------------------------------------

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults map onto hacks/config/celtic.xml. `delay` is microseconds (the
  // animation step pace); `delay2` is the linger in seconds after a knot
  // finishes. The C re-rolls curve/shadow widths, shape, edge size, margin,
  // angle and TYPE on every knot; only delay/delay2/graph/ncolors are knobs.
  const config = {
    delay: 10000,    // microseconds between animation steps (--delay; xml stock)
    delay2: 5,       // seconds to linger on a finished knot (--delay2; xml stock)
    ncolors: 20,     // palette size (--ncolors)
    graph: false,    // overlay the underlying graph (--graph)
  };

  // live: true  -> read by the loop every step (applies instantly).
  // live: false -> sizes the graph / palette, so a change re-runs init() via
  //                reinit() (a clean black canvas + a fresh knot).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 10000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'delay2', label: 'Linger', type: 'range', min: 0, max: 10, step: 1, default: 5, unit: ' s', lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 4, max: 40, step: 1, default: 20, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'graph', label: 'Draw graph', type: 'checkbox', default: false, live: false },
  ];

  // parameter advance per tick. Kept at the C's 0.0001: bands can hold up to
  // ~10000 cubic segments (measured), so a coarser step would draw chords
  // spanning several segments and look polygonal on the big knots.
  const STEP = 0.0001;

  let S = 1;                   // devicePixelRatio
  let W = 0;
  let H = 0;

  let splines = [];           // array of bands ({ segments, color } | null)
  let activeCount = 0;        // non-null splines
  let palette = [];
  let ncolors = 20;
  let curveWidth = 4;
  let shadowWidth = 8;

  let t = 0;                  // shared reveal parameter in [0, 1]
  let state = 'draw';        // 'draw' | 'linger'
  let lingerEnd = 0;

  // The C rolls a random graph type on every knot (NRAND(4)); celtic.xml has no
  // type resource, so the port always rolls random too (faithful, no invented knob).
  function forcedType() {
    return null;
  }

  // The C fills the palette with make_smooth_colormap (celtic_init, and again in
  // the per-knot recolor block of celtic_draw) and reserves indices 0/1 for
  // fg/bg. The bands only ever index 2..ncolors-1 (random()%(ncolors-2)+2, and
  // segment%(ncolors-3)+2 for the single-band case), so a faithful smooth
  // colormap of `ncolors` entries reproduces the band colours exactly. Re-rolled
  // every knot, matching the C's per-reset recolor.
  function buildPalette() {
    palette = makeSmoothColormapRGB(ncolors).map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);
  }

  function drawGraphOverlay(g) {
    ctx.strokeStyle = 'rgba(130, 130, 130, 0.55)';
    ctx.lineWidth = Math.max(1, Math.round(S));
    ctx.beginPath();
    for (let i = 0; i < g.edges.length; i++) {
      const e = g.edges[i];
      ctx.moveTo(e.node1.x, e.node1.y);
      ctx.lineTo(e.node2.x, e.node2.y);
    }
    ctx.stroke();
    const r = 5 * S;
    ctx.beginPath();
    for (let i = 0; i < g.nodes.length; i++) {
      const n = g.nodes[i];
      ctx.moveTo(n.x + r, n.y);
      ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
    }
    ctx.stroke();
  }

  // clear, roll params, build graph + palette, trace the bands. Leaves the
  // hack in the 'draw' state at t = 0, ready for the first step.
  function generate() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const p = rollParams(forcedType());
    curveWidth = Math.max(1, Math.round(p.curveWidth * S));
    shadowWidth = Math.max(curveWidth + 1, Math.round(p.shadowWidth * S));
    ncolors = Math.max(4, Math.round(config.ncolors));
    buildPalette();

    const g = buildGraph(p, W, H, S);
    if (config.graph) drawGraphOverlay(g);

    splines = traceSplines(g, p.shape1, p.shape2, ncolors);
    activeCount = 0;
    for (let i = 0; i < splines.length; i++) if (splines[i]) activeCount++;

    t = 0;
    state = 'draw';
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    generate();
  }

  function strokeSeg(ax, ay, bx, by, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  // pick a colour for the band's tip (single band -> rainbow per segment,
  // exactly as the C's nb_elements == 1 special case).
  function tipColor(spline, segment) {
    if (activeCount === 1) return palette[(segment % (ncolors - 3)) + 2];
    return palette[spline.color];
  }

  // One animation step: advance the shared parameter t by STEP a few times,
  // drawing each band's coloured tip plus a shadow segment a little ahead (the
  // over/under mechanism). When t reaches 1, run the back-redraw that covers
  // shadow spillage at the seam, then enter the linger state.
  function step() {
    if (state !== 'draw') return;
    ctx.lineCap = 'round';

    // The C does 100 ticks per draw-call regardless of band count. We keep that
    // pace for simple knots but shrink it for many-band knots so the per-step
    // stroke count (nticks * activeCount * 2) stays bounded and the frame rate
    // holds; the reveal just takes a little longer on the busy ones.
    const nticks = Math.max(4, Math.min(100, Math.floor(1200 / Math.max(1, activeCount))));
    const sw2 = shadowWidth * shadowWidth;

    for (let tick = 0; tick < nticks && t < 1; tick++) {
      for (let i = 0; i < splines.length; i++) {
        const s = splines[i];
        if (!s) continue;

        const p1 = splineValueAt(s, frac(t));
        const p2 = splineValueAt(s, frac(t + STEP));

        // shadow: step ahead until at least shadow_width from the tip, then
        // draw that short segment in the background colour (the gap-maker).
        let t2 = t + STEP;
        if (t2 <= 1) {
          let p3 = splineValueAt(s, frac(t2));
          let guard = 0;
          while (t2 + STEP < 1
            && (p3.x - p2.x) * (p3.x - p2.x) + (p3.y - p2.y) * (p3.y - p2.y) < sw2
            && guard < 1000) {
            t2 += STEP;
            p3 = splineValueAt(s, frac(t2));
            guard++;
          }
          const p4 = splineValueAt(s, frac(t2 + STEP));
          strokeSeg(p3.x, p3.y, p4.x, p4.y, '#000', shadowWidth);
        }

        // coloured tip segment
        strokeSeg(p1.x, p1.y, p2.x, p2.y, tipColor(s, p1.segment), curveWidth);
      }
      t += STEP;
    }

    if (t >= 1) {
      // redraw the loop seam in colour to remove the shadow that spilled past
      // the end of each (closed) band.
      for (let i = 0; i < splines.length; i++) {
        const s = splines[i];
        if (!s) continue;
        const a = splineValueAt(s, frac(t));
        let offset = STEP;
        let b = splineValueAt(s, frac(t - offset));
        let guard = 0;
        while ((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y) < sw2 && guard < 1000) {
          offset += STEP;
          b = splineValueAt(s, frac(t - offset));
          guard++;
        }
        strokeSeg(a.x, a.y, b.x, b.y, tipColor(s, a.segment), curveWidth);
      }

      state = 'linger';
      lingerEnd = performance.now() + Math.max(0, config.delay2) * 1000;
    }
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
    lastTime = 0;
    lag = 0;
  }

  // rAF lag-accumulator. Each knot is heavy (it repaints many short strokes),
  // so the catch-up cap is small. The linger is handled by wall-clock here so
  // it is independent of the step pace.
  //
  // OVERHEAD: the C returns the stock --delay (10000 us) between celtic_draw
  // calls, but each call also spends real time drawing (up to 100 ticks of short
  // line segments per band), so the live binary's true frame period is
  // delay + per-frame draw cost. We pace at (delay + OVERHEAD) so the reveal runs
  // at the live cadence, never faster than the author's floor. Live-measured (mid-
  // reveal): 56.1fps (Load 43.9%, clean) at stock delay 10000 -> OVERHEAD 7800.
  // See celtic.md.
  const OVERHEAD = 7800;       // microseconds (live-measured)
  const MAX_CATCHUP_STEPS = 2;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;

    if (state === 'linger') {
      if (now >= lingerEnd) {
        generate();
      }
      lastTime = now;
      lag = 0;
      rafId = requestAnimationFrame(frame);
      return;
    }

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

    rafId = requestAnimationFrame(frame);
  }

  // Clear to black and re-seed a fresh knot (for non-live config changes).
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
    lastTime = 0;
    lag = 0;
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
