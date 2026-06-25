// braid.js — braid packaged as a mountable module.
// start(canvas) returns { stop, reinit, config, params }.
//
// Port of xscreensaver's braid.c (John Neil, 1995; xscreensaver port by
// Jamie Zawinski). https://www.jwz.org/xscreensaver/
//
// Inter-braided concentric rings. A random "braid word" (a sequence of adjacent
// strand crossings, like a knot diagram) is laid out around a circle: each
// letter spans one angular sector, and within it one pair of neighbouring rings
// swaps radius — over or under, per the letter's sign — while the rest run as
// plain arcs. The strands are partitioned into knot components, each component
// gets its own hue, and the whole palette spins over time (a barber-pole around
// the rings). Every `cycles` frames a fresh braid is generated.
//
// Rendering note: this is genuinely line/arc-shaped (thin strokes, not per-pixel
// accumulation), so it uses canvas VECTOR ops — but the ~thousands of tiny
// segments per frame are bucketed by colour index (one Path2D per colour) and
// each bucket is stroked once, turning thousands of XDrawLine calls into
// ~ncolors stroke() calls per frame.

export const title = 'braid';

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/braid.xml (1:1 with the original),
  // except `delay` and `cycles` are tuned calmer than the stock 1 ms / 100.
  const config = {
    delay: 20,      // ms per redraw (xml µs default 1000 ≈ unbounded; calmer here)
    cycles: 200,    // frames a braid lives before regenerating (--cycles, xml 100)
    ncolors: 64,    // hue-cycle size (--ncolors)
    count: 15,      // max number of rings; the actual count is random ≤ this (--count)
    size: -7,       // line thickness; < 0 = random 1..|size| (--size)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 1, max: 100, step: 1, default: 20, unit: ' ms', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cycles', label: 'Duration', type: 'range', min: 10, max: 500, step: 10, default: 200, lowLabel: 'short', highLabel: 'long', live: true },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 1, max: 255, step: 1, default: 64, lowLabel: 'two', highLabel: 'many', live: false },
    { key: 'count', label: 'Rings (max)', type: 'range', min: 3, max: 15, step: 1, default: 15, live: false },
    { key: 'size', label: 'Line thickness (<0 = random)', type: 'range', min: -20, max: 20, step: 1, default: -7, live: false },
  ];

  // Braid-word constants (from the C).
  const MINLENGTH = 8, MAXLENGTH = 50;
  const MINSTRANDS = 3, MAXSTRANDS = 15;
  const SPINRATE = 12.0;
  const NUM_POINTS = 500;            // angular samples around the full circle

  const TAU = Math.PI * 2, HALF_PI = Math.PI / 2;

  // INTRAND(min,max) -> integer in [min, max] inclusive.
  const intrand = (min, max) => min + Math.floor(Math.random() * (max + 1 - min));

  let S = 1;                         // devicePixelRatio
  let cx, cy, minRadius, maxRadius;
  let nstrands, braidlength, braidword, components, linewidth, palette;
  let startcolor, colorDir, age;
  let dirty = true;                  // redraw only after the colour advances

  // The braid-word permutation: where strand `c` lands after the whole word.
  // Each letter w transposes adjacent strands w-1 and w.
  function applyword(c) {
    for (let i = 0; i < braidlength; i++) {
      const w = Math.abs(braidword[i]);
      if (c === w) c--; else if (c === w - 1) c++;
    }
    return c;
  }

  // Trace strand `c` back through letters [0, position) in reverse — gives the
  // start strand whose knot-component colours this segment.
  function applywordbackto(c, position) {
    for (let i = position - 1; i >= 0; i--) {
      const w = Math.abs(braidword[i]);
      if (c === w) c--; else if (c === w - 1) c++;
    }
    return c;
  }

  // Circle geometry from the current canvas size.
  function layout() {
    cx = canvas.width / 2;
    cy = canvas.height / 2;
    const minLen = Math.min(cx, cy);
    minRadius = minLen * 0.30;
    maxRadius = minLen * 0.90;
  }

  // Build a fresh random braid (the C's init_braid, minus the window clear —
  // draw() repaints the whole frame anyway).
  function generate() {
    age = 0;
    colorDir = (Math.random() < 0.5) ? 1 : -1;

    // Strand count: random, bounded by --count, the hard max, and radial room
    // (~5 logical px per ring).
    const room = Math.floor((maxRadius - minRadius) / (5 * S));
    const cap = Math.max(Math.min(MAXSTRANDS, config.count, room), MINSTRANDS);
    nstrands = (config.count < MINSTRANDS) ? MINSTRANDS : intrand(MINSTRANDS, cap);
    braidlength = intrand(MINLENGTH, Math.min(MAXLENGTH - 1, nstrands * 6));

    // Random braid word: each letter is ±(1..nstrands-1); no letter may cancel
    // its neighbour (incl. wrap-around), else the braid visually unravels.
    braidword = new Array(MAXLENGTH).fill(0);
    const letter = () => intrand(1, nstrands - 1) * (intrand(1, 2) * 2 - 3);
    for (let i = 0; i < braidlength; i++) {
      braidword[i] = letter();
      if (i > 0) while (braidword[i] === -braidword[i - 1]) braidword[i] = letter();
    }
    while (braidword[0] === -braidword[braidlength - 1])
      braidword[braidlength - 1] = letter();

    // Ensure enough distinct crossing positions appear (append letters until
    // ≥ nstrands-1 of them are used, or we hit MAXLENGTH).
    let count;
    do {
      const used = new Array(MAXSTRANDS).fill(0);
      for (let i = 0; i < braidlength; i++) used[Math.abs(braidword[i])]++;
      count = 0;
      for (let i = 0; i < nstrands; i++) count += used[i] > 0 ? 1 : 0;
      if (count < nstrands - 1) {
        braidword[braidlength] = letter();
        while (braidword[braidlength] === -braidword[braidlength - 1] &&
               braidword[0] === -braidword[braidlength])
          braidword[braidlength] = letter();
        braidlength++;
      }
    } while (count < nstrands - 1 && braidlength < MAXLENGTH);

    // Knot-component decomposition: label each cycle of the permutation with a
    // distinct component number (1, 2, 3, …).
    components = new Array(MAXSTRANDS).fill(0);
    let c = 1, comp = 0;
    components[0] = 1;
    do {
      let i = comp;
      do {
        i = applyword(i);
        components[i] = components[comp];
      } while (i !== comp);
      count = 0;
      for (let k = 0; k < nstrands; k++) if (components[k] === 0) count++;
      if (count > 0) {
        for (comp = 0; components[comp] !== 0; comp++);
        components[comp] = ++c;
      }
    } while (count > 0);
    // Push even components to the opposite colour phase (the C's trick for
    // telling neighbouring components apart).
    for (let i = 0; i < nstrands; i++) if (!(components[i] & 1)) components[i] *= -1;

    // Line thickness: negative size = random 1..|size|.
    let lw = config.size < 0 ? intrand(1, -config.size) : Math.max(1, config.size);
    const minDim = Math.min(canvas.width, canvas.height) / S;   // logical px
    if (lw * lw * 8 > minDim) lw = Math.max(1, Math.floor(Math.sqrt(minDim / 8)));
    linewidth = lw * S;

    startcolor = config.ncolors > 2 ? Math.floor(Math.random() * config.ncolors) : 0;

    // Vivid rainbow palette; white when ncolors ≤ 2 (the C's mono path).
    const n = config.ncolors;
    palette = new Array(n);
    for (let i = 0; i < n; i++) palette[i] = n > 2 ? `hsl(${i * 360 / n}, 100%, 50%)` : '#fff';

    dirty = true;
  }

  // Add a tiny segment to the Path2D bucket for its (truncated, wrapped) colour
  // index — matching the C's MI_PIXEL(mi, (int) color_use).
  function addSeg(paths, n, colorUse, x1, y1, x2, y2) {
    let ci = Math.trunc(colorUse) % n;
    if (ci < 0) ci += n;
    paths[ci].moveTo(x1, y1);
    paths[ci].lineTo(x2, y2);
  }

  function draw() {
    const n = config.ncolors;
    const theta = TAU / braidlength;     // angular span of one letter
    const tInc = TAU / NUM_POINTS;       // angular step within a letter
    const rDiff = (maxRadius - minRadius) / nstrands;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = linewidth;
    ctx.lineCap = linewidth <= 3 * S ? 'butt' : 'round';
    ctx.lineJoin = 'miter';

    const paths = new Array(n);
    for (let i = 0; i < n; i++) paths[i] = new Path2D();

    const rad = (s) => minRadius + rDiff * s;   // radius of plain strand s

    let psi = 0;
    for (let i = 0; i < braidlength; i++) {
      psi += theta;
      const w = Math.abs(braidword[i]);
      const over = braidword[i] > 0;

      // Per-letter colour offset for each strand (hoisted out of the t loop):
      // SPINRATE × component of the strand traced back to this letter.
      const compOff = new Array(nstrands);
      for (let s = 0; s < nstrands; s++)
        compOff[s] = SPINRATE * components[applywordbackto(s, i)];

      for (let t = 0; t < theta; t += tInc) {
        const t2 = t + tInc;
        const ang1 = t + psi, ang2 = t2 + psi;
        const cos1 = Math.cos(ang1), sin1 = Math.sin(ang1);
        const cos2 = Math.cos(ang2), sin2 = Math.sin(ang2);
        // Smoothstep weights interpolating the crossing radius across the arc.
        const a1 = 0.5 * (1 + Math.sin(t / theta * Math.PI - HALF_PI));
        const b1 = 0.5 * (1 + Math.sin((theta - t) / theta * Math.PI - HALF_PI));
        const a2 = 0.5 * (1 + Math.sin(t2 / theta * Math.PI - HALF_PI));
        const b2 = 0.5 * (1 + Math.sin((theta - t2) / theta * Math.PI - HALF_PI));
        const angTerm = (psi + t) / TAU * n;   // hue rotates around the circle
        const inMiddle = Math.abs(t - theta / 2) <= theta / 7;   // over/under gap

        for (let s = 0; s < nstrands; s++) {
          if (w === s) continue;               // drawn as the crossing partner below
          if (w - 1 === s) {
            const r1 = rad(s), r2 = rad(s + 1);
            // Strand A: inner→outer (drawn fully when `over`, else gapped mid-arc).
            if (over || !inMiddle) {
              const rA1 = a1 * r2 + b1 * r1, rA2 = a2 * r2 + b2 * r1;
              addSeg(paths, n, startcolor + compOff[s] + angTerm,
                     cx + rA1 * cos1, cy + rA1 * sin1, cx + rA2 * cos2, cy + rA2 * sin2);
            }
            // Strand B: outer→inner (drawn fully when under, else gapped mid-arc).
            if (!over || !inMiddle) {
              const rB1 = a1 * r1 + b1 * r2, rB2 = a2 * r1 + b2 * r2;
              addSeg(paths, n, startcolor + compOff[s + 1] + angTerm,
                     cx + rB1 * cos1, cy + rB1 * sin1, cx + rB2 * cos2, cy + rB2 * sin2);
            }
          } else {
            const r = rad(s);                  // plain circular arc
            addSeg(paths, n, startcolor + compOff[s] + angTerm,
                   cx + r * cos1, cy + r * sin1, cx + r * cos2, cy + r * sin2);
          }
        }
      }
    }

    for (let i = 0; i < n; i++) { ctx.strokeStyle = palette[i]; ctx.stroke(paths[i]); }
    dirty = false;
  }

  // One step = advance the spinning colour; regenerate when the braid ages out.
  function step() {
    const colorInc = config.ncolors * colorDir / NUM_POINTS;
    startcolor += SPINRATE * colorInc;
    startcolor = ((startcolor % config.ncolors) + config.ncolors) % config.ncolors;
    if (++age > config.cycles) generate();
    dirty = true;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    S = dpr;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    layout();
    generate();
  }

  // Drive off requestAnimationFrame, banking leftover time so the colour spins
  // at config.delay pace regardless of refresh rate; redraw once per frame only
  // if the colour actually advanced.
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delay = Math.max(1, config.delay);
    lag = Math.min(lag, delay * MAX_CATCHUP_STEPS);
    let steps = 0;
    while (lag >= delay && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delay;
      steps++;
    }

    if (dirty) draw();
    rafId = requestAnimationFrame(frame);
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
    reinit: generate,   // fresh braid with the current config
    config,
    params,
  };
}
