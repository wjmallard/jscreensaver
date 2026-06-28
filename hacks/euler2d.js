// euler2d.js — euler2d packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's euler2d.c (Stephen Montgomery-Smith, 2000), itself
// adapted from flow.c / swarm.c. https://www.jwz.org/xscreensaver/
//
// Simulates 2D incompressible inviscid (Euler) fluid flow as a handful of point
// vortices that advect a cloud of massless tracer particles. The velocity at any
// point is the Biot-Savart sum over the vortices; to keep the flow inside a unit
// disk, each vortex contributes a mirror-image term (its reflection about the
// unit circle), so the normal velocity vanishes on the boundary. The unit disk
// is then mapped through a random degree-6 polynomial p(z) = z + c2 z^2 + ... to
// give an interesting, non-circular domain, and that map is rotated/scaled to
// fill the screen. Each particle leaves a streaky trail as it is carried by the
// flow; after `cycles` steps a fresh flow (new vortices, new boundary) is rolled.
//
// Rendering note: like [[binaryring]] this is per-pixel compositing of thousands
// of tiny segments per frame, so it uses the BLIT path — a persistent Uint32
// buffer that we (a) fade toward black each frame to age the trails (the canvas
// analogue of the C's ring-buffer of old segments it erases in black), and (b)
// stamp the new segments into with a Bresenham alpha-blend. See [[interference]]
// for the Uint32-over-ImageData idiom and [[squiral]] for the canvas conventions.

export const title = 'euler2d';

export const info = {
  author: 'Stephen Montgomery-Smith',
  description: 'Simulates two dimensional incompressible inviscid fluid flow.\n\nhttps://en.wikipedia.org/wiki/Euler_equations_%28fluid_dynamics%29\nhttps://en.wikipedia.org/wiki/Inviscid_flow',
  year: 2000,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges/labels mirror hacks/config/euler2d.xml so the config box
  // maps 1:1 to the original. delay is in microseconds (xml units). `count`
  // is reduced from the stock 1024 because every particle is advected against
  // every vortex each frame (O(count * Nvortex)); see the .md perf note.
  const config = {
    delay: 16000,    // \u00B5s between frames (--delay; stock 10000, calmed a touch)
    count: 700,      // number of tracer particles (--count; stock 1024)
    eulertail: 16,   // trail length in frames (--eulertail; stock 10)
    cycles: 3000,    // steps before a brand-new flow is rolled (--cycles)
    ncolors: 96,     // size of the rainbow hue loop (--ncolors; stock 64)
    power: 1,        // interaction-law power; 1 = classic Euler (--eulerpower)
  };

  // live: true  -> the loop reads config[key] every step (applies instantly).
  // live: false -> the value sizes particle arrays / colours / the flow, so a
  //                change re-runs init() via reinit().
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 16000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Particles', type: 'range', min: 2, max: 3000, step: 1, default: 700, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'eulertail', label: 'Trail length', type: 'range', min: 2, max: 200, step: 1, default: 16, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'cycles', label: 'Duration', type: 'range', min: 100, max: 5000, step: 10, default: 3000, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'ncolors', label: 'Number of colors', type: 'range', min: 2, max: 255, step: 1, default: 96, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'power', label: 'Interaction power', type: 'range', min: 0.5, max: 3, step: 0.1, default: 1, lowLabel: 'soft', highLabel: 'sharp', live: false },
  ];

  // --- constants from the C ---------------------------------------------------
  const NUMBER_OF_VORTEX_POINTS = 20;   // number_of_vortex_points
  const N_BOUND_P = 500;                // n_bound_p (boundary polyline resolution)
  const DEG_P = 6;                      // deg_p (polynomial degree)
  const NR_ROTATES = 18;               // nr_rotates (must be even)
  const BLACK = 0xFF000000;

  // --- rng helpers (the C's balance_rand / positive_rand) ---------------------
  const positiveRand = (v) => Math.random() * v;             // [0, v)
  const balanceRand = (v) => Math.random() * v - v / 2;      // [-v/2, v/2)
  const TWO_PI = 2 * Math.PI;

  let S = 1;                 // devicePixelRatio
  let W, H;                  // backing-store size, device px

  let imageData, pixels;     // persistent trail buffer (Uint32 over ImageData)

  // Simulation state (flat double arrays, x[2i]=x, x[2i+1]=y per the C).
  let N, Nvortex;            // total points, vortex points
  let x, w;                  // positions; vorticities (Nvortex)
  let diffx, olddiffx;       // velocity field + previous (for Adams-Bashforth)
  let tempx, tempdiffx;      // scratch for the ODE step
  let xs, xIsZero;           // vortex reflections about the unit circle
  let p, modDp2;             // polynomial image of each point; |p'(z)|^2
  let dead;                  // a point that overflowed / left the disk
  let lastx;                 // last screen position of each point (segment start)

  let variableBoundary;      // 1 = polynomial boundary, 0 = plain circle
  let deltaT;                // ODE time step
  let pCoef;                 // 2*(DEG_P-1) reals: complex c2..c6
  let scale, xshift, yshift; // domain -> screen transform (polynomial case)
  let radius;                // domain -> screen radius (circle case)
  let boundarySegs;          // [{x1,y1,x2,y2}] screen-space boundary polyline
  let hideVortex;            // hide the vortex points themselves
  let boundaryRGB;           // boundary colour [r,g,b]
  let colorsRGB;             // ncolors rainbow buckets [[r,g,b], ...]
  let count;                 // step counter (the C's sp->count)
  let nNonVortexSegs;        // tracer segments drawn this frame (for colouring)
  let segments;              // reusable segment list: {x1,y1,x2,y2,r,g,b}

  // --- complex helpers (mirror the C's add / mult macros) ---------------------
  // Evaluate p(z) = z + c2 z^2 + ... + c_n z^n via Horner, complex arithmetic.
  function calcP(z1, z2) {
    let p1 = 0, p2 = 0;
    for (let i = DEG_P; i >= 2; i--) {
      p1 += pCoef[(i - 2) * 2 + 0];
      p2 += pCoef[(i - 2) * 2 + 1];
      const t = p1 * z1 - p2 * z2;
      p2 = p1 * z2 + p2 * z1;
      p1 = t;
    }
    p1 += 1;                       // add (1,0)
    const t = p1 * z1 - p2 * z2;   // mult by z
    p2 = p1 * z2 + p2 * z1;
    p1 = t;
    return [p1, p2];
  }

  // |p'(z)|^2 where p'(z) = 1 + 2 c2 z + ... + n c_n z^{n-1}.
  function calcModDp2(z1, z2) {
    let mp1 = 0, mp2 = 0;
    for (let i = DEG_P; i >= 2; i--) {
      mp1 += i * pCoef[(i - 2) * 2 + 0];
      mp2 += i * pCoef[(i - 2) * 2 + 1];
      const t = mp1 * z1 - mp2 * z2;
      mp2 = mp1 * z2 + mp2 * z1;
      mp1 = t;
    }
    mp1 += 1;
    return mp1 * mp1 + mp2 * mp2;
  }

  // Polynomial image of every (live) point, into p[] — only when variable.
  function calcAllP() {
    for (let j = (hideVortex ? Nvortex : 0); j < N; j++) {
      if (dead[j]) continue;
      const r = calcP(x[2 * j + 0], x[2 * j + 1]);
      p[2 * j + 0] = r[0];
      p[2 * j + 1] = r[1];
    }
  }

  // |p'(z)|^2 at every (live) point of array xx, into modDp2[].
  function calcAllModDp2(xx) {
    for (let j = 0; j < N; j++) {
      if (dead[j]) continue;
      modDp2[j] = calcModDp2(xx[2 * j + 0], xx[2 * j + 1]);
    }
  }

  // --- the velocity field (Biot-Savart with the disk-reflection term) ---------
  // Fills diffx[] = dx/dt for every live point given positions xx.
  function derivs(xx) {
    const power = config.power;
    if (variableBoundary) calcAllModDp2(xx);

    // Reflection of each vortex about the unit circle: xs = a / |a|^2.
    for (let j = 0; j < Nvortex; j++) {
      if (dead[j]) continue;
      const nx = xx[2 * j + 0] * xx[2 * j + 0] + xx[2 * j + 1] * xx[2 * j + 1];
      if (nx < 1e-10) {
        xIsZero[j] = 1;
      } else {
        xIsZero[j] = 0;
        xs[2 * j + 0] = xx[2 * j + 0] / nx;
        xs[2 * j + 1] = xx[2 * j + 1] / nx;
      }
    }

    diffx.fill(0);

    for (let i = 0; i < N; i++) {
      if (dead[i]) continue;
      const x1 = xx[2 * i + 0];
      const x2 = xx[2 * i + 1];
      for (let j = 0; j < Nvortex; j++) {
        if (dead[j]) continue;

        // Direct vortex term: u = (x-a) rotated 90deg, / |x-a|^(power+1).
        let xij1 = x1 - xx[2 * j + 0];
        let xij2 = x2 - xx[2 * j + 1];
        let nxij = (power === 1.0)
          ? xij1 * xij1 + xij2 * xij2
          : Math.pow(xij1 * xij1 + xij2 * xij2, (power + 1) / 2.0);

        let u1, u2;
        if (nxij >= 1e-4) {   // guard: ignore the singular core (velocity blow-up)
          u1 = xij2 / nxij;
          u2 = -xij1 / nxij;
        } else {
          u1 = u2 = 0.0;
        }

        // Reflection term enforces the unit-circle boundary.
        if (!xIsZero[j]) {
          xij1 = x1 - xs[2 * j + 0];
          xij2 = x2 - xs[2 * j + 1];
          nxij = (power === 1.0)
            ? xij1 * xij1 + xij2 * xij2
            : Math.pow(xij1 * xij1 + xij2 * xij2, (power + 1) / 2.0);

          if (nxij < 1e-5) {   // too close to a reflected vortex -> kill the point
            dead[i] = 1;
            u1 = u2 = 0.0;
          } else {
            u1 -= xij2 / nxij;
            u2 += xij1 / nxij;
          }
        }

        if (!dead[i]) {
          diffx[2 * i + 0] += u1 * w[j];
          diffx[2 * i + 1] += u2 * w[j];
        }
      }

      // Conformal-map correction: divide the velocity by |p'(z)|^2.
      if (!dead[i] && variableBoundary) {
        if (modDp2[i] < 1e-5) {
          dead[i] = 1;
        } else {
          diffx[2 * i + 0] /= modDp2[i];
          diffx[2 * i + 1] /= modDp2[i];
        }
      }
    }
  }

  // ret = x + k, unless the step is too large or the point left the disk -> dead.
  // (SUBTLE_PERTURB is off in the C, so this is the plain branch.)
  function perturb(ret, xx, k) {
    for (let i = 0; i < N; i++) {
      if (dead[i]) continue;
      const x1 = xx[2 * i + 0];
      const x2 = xx[2 * i + 1];
      const k1 = k[2 * i + 0];
      const k2 = k[2 * i + 1];
      if (k1 * k1 + k2 * k2 > 0.1 || x1 * x1 + x2 * x2 > 1 - 1e-5) {
        dead[i] = 1;
      } else {
        ret[2 * i + 0] = x1 + k1;
        ret[2 * i + 1] = x2 + k2;
      }
    }
  }

  // Advance the positions one delta_t: midpoint method on the very first step,
  // then Adams-Bashforth order 2 (uses the previous derivative).
  function odeSolve() {
    if (count < 1) {
      // midpoint method (bootstraps olddiffx)
      derivs(x);
      olddiffx.set(diffx);
      for (let i = 0; i < N; i++) {
        if (dead[i]) continue;
        tempdiffx[2 * i + 0] = 0.5 * deltaT * diffx[2 * i + 0];
        tempdiffx[2 * i + 1] = 0.5 * deltaT * diffx[2 * i + 1];
      }
      perturb(tempx, x, tempdiffx);
      derivs(tempx);
      for (let i = 0; i < N; i++) {
        if (dead[i]) continue;
        tempdiffx[2 * i + 0] = deltaT * diffx[2 * i + 0];
        tempdiffx[2 * i + 1] = deltaT * diffx[2 * i + 1];
      }
      perturb(x, x, tempdiffx);
    } else {
      // Adams-Bashforth: x += dt (1.5 f_n - 0.5 f_{n-1})
      derivs(x);
      for (let i = 0; i < N; i++) {
        if (dead[i]) continue;
        tempdiffx[2 * i + 0] = deltaT * (1.5 * diffx[2 * i + 0] - 0.5 * olddiffx[2 * i + 0]);
        tempdiffx[2 * i + 1] = deltaT * (1.5 * diffx[2 * i + 1] - 0.5 * olddiffx[2 * i + 1]);
      }
      perturb(x, x, tempdiffx);
      const t = olddiffx;       // swap olddiffx <-> diffx (C swaps the pointers)
      olddiffx = diffx;
      diffx = t;
    }
  }

  // --- trail buffer: stamp segments with alpha blend, fade each frame ---------
  function blend(px, py, r, g, b, a) {
    px |= 0; py |= 0;
    if (px < 0 || px >= W || py < 0 || py >= H) return;
    const idx = py * W + px;
    const c = pixels[idx];
    const or = c & 0xff, og = (c >> 8) & 0xff, ob = (c >> 16) & 0xff;
    const nr = (or + (r - or) * a) | 0;
    const ng = (og + (g - og) * a) | 0;
    const nb = (ob + (b - ob) * a) | 0;
    pixels[idx] = ((0xff << 24) | (nb << 16) | (ng << 8) | nr) >>> 0;
  }

  // Bresenham line, alpha-blending each pixel (the C's non-antialiased path).
  function drawLine(x0, y0, x1, y1, r, g, b, a) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
    if (steep) { let t = x0; x0 = y0; y0 = t; t = x1; x1 = y1; y1 = t; }
    if (x0 > x1) { let t = x0; x0 = x1; x1 = t; t = y0; y0 = y1; y1 = t; }
    const dx = x1 - x0, dy = Math.abs(y1 - y0);
    let err = 0, y = y0;
    const ystep = y0 < y1 ? 1 : -1;
    for (let xp = x0; xp <= x1; xp++) {
      if (steep) blend(y, xp, r, g, b, a); else blend(xp, y, r, g, b, a);
      err += dy;
      if ((err << 1) > dx) { y += ystep; err -= dx; }
    }
  }

  // Fade the whole buffer toward black. fade in (0,1]; smaller = trails die
  // faster. Chosen so a pixel decays to ~black over ~eulertail frames, matching
  // the C's ring-buffer trail length.
  function fadeBuffer(fade) {
    if (fade >= 1) return;
    const f = Math.max(0, Math.min(255, Math.round(fade * 256)));
    for (let i = 0; i < pixels.length; i++) {
      const c = pixels[i];
      const r = (((c & 0xff) * f) >> 8);
      const g = ((((c >> 8) & 0xff) * f) >> 8);
      const b = ((((c >> 16) & 0xff) * f) >> 8);
      pixels[i] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
  }

  // --- flow initialisation (the C's init_euler2d) -----------------------------
  function initFlow() {
    // Clamp power and derive delta_t (smaller for steeper interaction laws).
    if (config.power < 0.5) config.power = 0.5;
    if (config.power > 3.0) config.power = 3.0;
    variableBoundary = (config.power === 1.0) ? 1 : 0;
    deltaT = 0.001;
    if (config.power > 1.0) deltaT *= Math.pow(0.1, config.power - 1);

    hideVortex = (Math.floor(Math.random() * 4) !== 0);   // NRAND(4) != 0
    count = 0;

    // Boundary colour is a random rainbow bucket; trail colours follow.
    boundaryRGB = colorsRGB[Math.floor(Math.random() * colorsRGB.length)];

    pCoef = new Float64Array(2 * (DEG_P - 1));
    boundarySegs = null;

    if (variableBoundary) {
      buildPolynomialBoundary();
    } else {
      radius = (W > H ? H / 2.0 : W / 2.0) - 5.0 * S;
    }

    // Reset per-point state.
    dead.fill(0);
    diffx.fill(0);
    olddiffx.fill(0);
    // Seed lastx so the FIRST drawn segment starts at the point's own position
    // (no stray line from a stale/zero last position).
    for (let i = 0; i < N; i++) {
      lastx[2 * i + 0] = 0;
      lastx[2 * i + 1] = 0;
    }

    // Tracer particles: uniform over the disk (rejection-sampled in the mapped
    // domain so the visible cloud is uniform, exactly like the C).
    for (let i = Nvortex; i < N; i++) {
      let r, theta;
      do {
        r = Math.sqrt(positiveRand(1.0));
        theta = balanceRand(TWO_PI);
        x[2 * i + 0] = r * Math.cos(theta);
        x[2 * i + 1] = r * Math.sin(theta);
      } while (variableBoundary &&
               calcModDp2(x[2 * i + 0], x[2 * i + 1]) < positiveRand(4));
    }

    // Vortex points: n clusters (2..5), some with negative vorticity.
    const n = Math.floor(Math.random() * 4) + 2;   // NRAND(4)+2
    let np;
    if (n % 2) {
      np = Math.floor(Math.random() * (n + 1));     // NRAND(n+1)
    } else {
      np = Math.floor(Math.random() * (n + 2));     // NRAND(n+2)
      if (np === n + 1) np = n / 2;                 // bias toward balanced
    }
    for (let k = 0; k < n; k++) {
      let r = Math.sqrt(positiveRand(0.77));
      let theta = balanceRand(TWO_PI);
      const cxv = r * Math.cos(theta);
      const cyv = r * Math.sin(theta);
      r = 0.02 + positiveRand(0.1);
      const wv = (2 * (k < np ? 1 : 0) - 1) * 2.0 / Nvortex;   // +/- vorticity
      const lo = Math.floor(Nvortex * k / n);
      const hi = Math.floor(Nvortex * (k + 1) / n);
      for (let i = lo; i < hi; i++) {
        theta = balanceRand(TWO_PI);
        x[2 * i + 0] = cxv + r * Math.cos(theta);
        x[2 * i + 1] = cyv + r * Math.sin(theta);
        w[i] = wv;
      }
    }
  }

  // Build a random degree-6 polynomial map of the unit disk, pick the rotation
  // that best fills the screen, compute the domain->screen transform, and
  // tessellate the boundary curve. Faithful to the C's init_euler2d.
  function buildPolynomialBoundary() {
    // Random coefficients c2..c6 normalised so sum_k k|c_k| = 1 (keeps p a
    // bijection of the disk while giving interesting, pointy shapes).
    let mag = 0;
    for (let k = 2; k <= DEG_P; k++) {
      const r = positiveRand(1.0 / k);
      const theta = balanceRand(TWO_PI);
      pCoef[2 * (k - 2) + 0] = r * Math.cos(theta);
      pCoef[2 * (k - 2) + 1] = r * Math.sin(theta);
      mag += k * r;
    }
    if (mag > 0.0001) {
      for (let k = 2; k <= DEG_P; k++) {
        pCoef[2 * (k - 2) + 0] /= mag;
        pCoef[2 * (k - 2) + 1] /= mag;
      }
    }

    // For each candidate rotation (every 180/NR_ROTATES degrees) find the
    // extent of the mapped boundary, so we can scale to fit the window.
    const low = new Array(NR_ROTATES).fill(1e5);
    const high = new Array(NR_ROTATES).fill(-1e5);

    for (let k = 0; k < N_BOUND_P; k++) {
      const a = k / N_BOUND_P * TWO_PI;
      const am = (k - 1) / N_BOUND_P * TWO_PI;
      const ap = (k + 1) / N_BOUND_P * TWO_PI;
      const P = calcP(Math.cos(a), Math.sin(a));
      const Pp = calcP(Math.cos(am), Math.sin(am));
      const Pn = calcP(Math.cos(ap), Math.sin(ap));
      const p1 = P[0], p2 = P[1];
      let angle1 = NR_ROTATES / Math.PI * Math.atan2(p2 - Pp[1], p1 - Pp[0]) - NR_ROTATES / 2;
      let angle2 = NR_ROTATES / Math.PI * Math.atan2(Pn[1] - p2, Pn[0] - p1) - NR_ROTATES / 2;
      while (angle1 < 0) angle1 += NR_ROTATES * 2;
      while (angle2 < 0) angle2 += NR_ROTATES * 2;
      if (angle1 > NR_ROTATES * 1.75 && angle2 < NR_ROTATES * 0.25) angle2 += NR_ROTATES * 2;
      if (angle1 < NR_ROTATES * 0.25 && angle2 > NR_ROTATES * 1.75) angle1 += NR_ROTATES * 2;
      if (angle2 < angle1) { const t = angle1; angle1 = angle2; angle2 = t; }
      for (let i = Math.floor(angle1); i < Math.ceil(angle2); i++) {
        const dist = Math.cos(i * Math.PI / NR_ROTATES) * p1 + Math.sin(i * Math.PI / NR_ROTATES) * p2;
        const m = ((i % NR_ROTATES) + NR_ROTATES) % NR_ROTATES;
        if (((i % (NR_ROTATES * 2)) + NR_ROTATES * 2) % (NR_ROTATES * 2) < NR_ROTATES) {
          if (dist > high[m]) high[m] = dist;
          if (dist < low[m]) low[m] = dist;
        } else {
          if (-dist > high[m]) high[m] = -dist;
          if (-dist < low[m]) low[m] = -dist;
        }
      }
    }

    // Pick the rotation giving the largest fitting scale.
    let bestscale = 0, besti = 0;
    for (let i = 0; i < NR_ROTATES; i++) {
      const xscale = (W - 5.0 * S) / (high[i] - low[i]);
      const j = (i + NR_ROTATES / 2) % NR_ROTATES;
      const yscale = (H - 5.0 * S) / (high[j] - low[j]);
      const sc = (xscale > yscale) ? yscale : xscale;
      if (sc > bestscale) { bestscale = sc; besti = i; }
    }

    // Rotate the polynomial: replace p(z) by a^{-1} p(a z), a = exp(i*best_angle).
    let r1 = 1, r2 = 0;
    const ca = Math.cos(besti * Math.PI / NR_ROTATES);
    const sa = Math.sin(besti * Math.PI / NR_ROTATES);
    for (let k = 2; k <= DEG_P; k++) {
      const t1 = r1 * ca - r2 * sa;   // r *= a
      r2 = r1 * sa + r2 * ca;
      r1 = t1;
      const c1 = pCoef[2 * (k - 2) + 0];
      const c2 = pCoef[2 * (k - 2) + 1];
      pCoef[2 * (k - 2) + 0] = c1 * r1 - c2 * r2;   // c_k *= r
      pCoef[2 * (k - 2) + 1] = c1 * r2 + c2 * r1;
    }

    scale = bestscale;
    xshift = -(low[besti] + high[besti]) / 2.0 * scale + W / 2;
    const bj = (besti + NR_ROTATES / 2) % NR_ROTATES;
    if (besti < NR_ROTATES / 2) {
      yshift = -(low[bj] + high[bj]) / 2.0 * scale + H / 2;
    } else {
      yshift = (low[bj] + high[bj]) / 2.0 * scale + H / 2;
    }

    // Tessellate the boundary into screen-space segments.
    const pts = new Array(N_BOUND_P);
    for (let k = 0; k < N_BOUND_P; k++) {
      const a = k / N_BOUND_P * TWO_PI;
      const P = calcP(Math.cos(a), Math.sin(a));
      pts[k] = [P[0] * scale + xshift, P[1] * scale + yshift];
    }
    boundarySegs = new Array(N_BOUND_P);
    for (let k = 0; k < N_BOUND_P; k++) {
      const a = pts[k];
      const b = pts[(k - 1 + N_BOUND_P) % N_BOUND_P];
      boundarySegs[k] = { x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
    }
  }

  // --- per-frame step (the C's draw_euler2d) ----------------------------------
  function step() {
    odeSolve();
    if (variableBoundary) calcAllP();

    // Build this frame's tracer segments (lastx -> new screen position), then
    // the vortex segments after them (drawn white). Colour buckets are assigned
    // by splitting the tracer segments evenly across ncolors, like the C.
    let ns = 0;

    // Tracers first (indices Nvortex..N-1).
    for (let b = Nvortex; b < N; b++) {
      if (dead[b]) continue;
      let sx, sy;
      if (variableBoundary) {
        sx = p[2 * b + 0] * scale + xshift;
        sy = p[2 * b + 1] * scale + yshift;
      } else {
        sx = x[2 * b + 0] * radius + W / 2;
        sy = x[2 * b + 1] * radius + H / 2;
      }
      const seg = segments[ns++];
      seg.x1 = lastx[2 * b + 0];
      seg.y1 = lastx[2 * b + 1];
      seg.x2 = sx | 0;
      seg.y2 = sy | 0;
      seg.idx = b;
      lastx[2 * b + 0] = seg.x2;
      lastx[2 * b + 1] = seg.y2;
    }
    nNonVortexSegs = ns;

    // Vortex points after the tracers (drawn white when visible).
    if (!hideVortex) {
      for (let b = 0; b < Nvortex; b++) {
        if (dead[b]) continue;
        let sx, sy;
        if (variableBoundary) {
          sx = p[2 * b + 0] * scale + xshift;
          sy = p[2 * b + 1] * scale + yshift;
        } else {
          sx = x[2 * b + 0] * radius + W / 2;
          sy = x[2 * b + 1] * radius + H / 2;
        }
        const seg = segments[ns++];
        seg.x1 = lastx[2 * b + 0];
        seg.y1 = lastx[2 * b + 1];
        seg.x2 = sx | 0;
        seg.y2 = sy | 0;
        seg.idx = b;
        lastx[2 * b + 0] = seg.x2;
        lastx[2 * b + 1] = seg.y2;
      }
    }
    const cnsegs = ns;

    // Only draw once we have a previous position to draw FROM (count>0), exactly
    // like the C (it guards segment drawing on sp->count).
    if (count) {
      // Age existing trails. fade is set so a trail lasts ~eulertail frames:
      // after t frames a stamp is at fade^t; solve fade^eulertail = ~1/255.
      const tail = Math.max(2, Math.round(config.eulertail));
      const fade = Math.pow(1 / 255, 1 / tail);
      fadeBuffer(fade);

      // Tracer segments, coloured by even split across the rainbow buckets.
      const nc = colorsRGB.length;
      for (let s = 0; s < nNonVortexSegs; s++) {
        const seg = segments[s];
        // Same start..finish bucketing the C uses (col*ns/ncolors).
        const col = Math.floor(s * nc / Math.max(1, nNonVortexSegs));
        const c = colorsRGB[col >= nc ? nc - 1 : col];
        drawLine(seg.x1, seg.y1, seg.x2, seg.y2, c[0], c[1], c[2], 0.85);
      }

      // Vortex segments in white.
      for (let s = nNonVortexSegs; s < cnsegs; s++) {
        const seg = segments[s];
        drawLine(seg.x1, seg.y1, seg.x2, seg.y2, 255, 255, 255, 0.95);
      }

      // Boundary, re-stamped each frame so it stays crisp against the fade.
      if (variableBoundary && boundarySegs) {
        for (let k = 0; k < boundarySegs.length; k++) {
          const s = boundarySegs[k];
          drawLine(s.x1, s.y1, s.x2, s.y2, boundaryRGB[0], boundaryRGB[1], boundaryRGB[2], 1.0);
        }
      } else if (!variableBoundary) {
        drawCircle(W / 2, H / 2, radius, boundaryRGB);
      }

      ctx.putImageData(imageData, 0, 0);
    }

    // After `cycles` steps, roll a brand-new flow (new vortices + boundary).
    if (++count > Math.max(100, Math.round(config.cycles))) {
      pixels.fill(BLACK);   // the C does MI_CLEARWINDOW on re-init
      initFlow();
    }
  }

  // Midpoint-circle outline, alpha-blended (the circle-boundary case).
  function drawCircle(cx, cy, rad, rgb) {
    const r = Math.round(rad);
    if (r < 1) return;
    let xp = r, yp = 0, err = 1 - r;
    const put = (a, b) => blend(cx + a, cy + b, rgb[0], rgb[1], rgb[2], 1.0);
    while (xp >= yp) {
      put(xp, yp); put(yp, xp); put(-yp, xp); put(-xp, yp);
      put(-xp, -yp); put(-yp, -xp); put(yp, -xp); put(xp, -yp);
      yp++;
      if (err < 0) { err += 2 * yp + 1; }
      else { xp--; err += 2 * (yp - xp) + 1; }
    }
  }

  // --- sizing / lifecycle -----------------------------------------------------
  function buildPalette() {
    const nc = Math.max(2, Math.round(config.ncolors));
    colorsRGB = new Array(nc);
    for (let i = 0; i < nc; i++) {
      colorsRGB[i] = hslToRgb(i * 360 / nc, 1, 0.5);
    }
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (pp, qq, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return pp + (qq - pp) * 6 * t;
        if (t < 1 / 2) return qq;
        if (t < 2 / 3) return pp + (qq - pp) * (2 / 3 - t) * 6;
        return pp;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const pp = 2 * l - q;
      r = hue2rgb(pp, q, h + 1 / 3);
      g = hue2rgb(pp, q, h);
      b = hue2rgb(pp, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  // Allocate the simulation arrays from the current count, then roll a flow.
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    imageData = ctx.createImageData(W, H);
    pixels = new Uint32Array(imageData.data.buffer);
    pixels.fill(BLACK);

    Nvortex = NUMBER_OF_VORTEX_POINTS;
    N = Math.max(2, Math.round(config.count)) + Nvortex;

    x = new Float64Array(N * 2);
    diffx = new Float64Array(N * 2);
    olddiffx = new Float64Array(N * 2);
    tempx = new Float64Array(N * 2);
    tempdiffx = new Float64Array(N * 2);
    w = new Float64Array(Nvortex);
    xs = new Float64Array(Nvortex * 2);
    xIsZero = new Uint8Array(Nvortex);
    p = new Float64Array(N * 2);
    modDp2 = new Float64Array(N);
    dead = new Uint8Array(N);
    lastx = new Int32Array(N * 2);

    // One reusable segment record per point (tracers + vortices).
    segments = new Array(N);
    for (let i = 0; i < N; i++) {
      segments[i] = { x1: 0, y1: 0, x2: 0, y2: 0, idx: 0 };
    }

    buildPalette();
    initFlow();
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
  }

  // Drive off requestAnimationFrame but keep the original pace: one step() per
  // config.delay, banking leftover time. Each step is an O(count*Nvortex)
  // physics pass plus a full-buffer fade, so keep the catch-up cap low.
  const MAX_CATCHUP_STEPS = 3;
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

    rafId = requestAnimationFrame(frame);
  }

  // reinit clears to black and rebuilds arrays/flow with the current config.
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
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
    reinit,   // rebuild arrays + roll a fresh flow, keeping the current config
    config,
    params,
  };
}
