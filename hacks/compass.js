// compass.js — compass packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's compass.c (Jamie Zawinski, 1999).
// https://www.jwz.org/xscreensaver/
//
// "A compass, with all elements spinning about randomly, for that 'lost and
// nauseous' feeling." A single compass is drawn centred on screen as three
// concentric, independently-spinning discs:
//   - disc 0: the dial — 72 tick marks plus the cardinal letters (W N E S) and
//     bearing numbers (30 33 3 6 12 15 21 24), all in pale cyan.
//   - disc 1: a thick double-ended arrow needle (gold).
//   - disc 2: a thin arrow needle with a filled head (yellow).
// A static case "pointer" (a red triangle at top plus small bezel marks) is
// painted over the top and does NOT rotate. Each disc has its own angle that
// precesses under a randomly-drifting velocity/acceleration, so the three hands
// wander at different, ever-changing rates (the "spinning about randomly").
//
// Rendering: genuinely line/arc-shaped (XDrawLines / XDrawSegments / XFillPolygon
// in the C), so it uses canvas VECTOR ops. The dial's ~72 ticks plus every glyph
// are one colour, so they're batched into a single Path2D and stroked once; the
// arrows and the static pointer are likewise a handful of stroke/fill calls.

export const title = 'compass';

export const info = {
  author: 'Jamie Zawinski',
  description: 'A compass, with all elements spinning about randomly, for that "lost and nauseous" feeling.',
  year: 1999,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // The xml exposes only `delay`; `speed` and `size` are host conveniences
  // (speed scales the existing precession, size scales the auto-computed radius)
  // — see compass.md. Units match hacks/config/compass.xml (delay in \u00B5s).
  const config = {
    delay: 20000,   // microseconds between steps (--delay; xml default 20000)
    speed: 1,       // precession multiplier (added knob; 1 == stock motion)
    size: 1,        // compass radius scale (added knob; 1 == auto-computed)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Spin speed', type: 'range', min: 0.1, max: 4, step: 0.1, default: 1, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'size', label: 'Size', type: 'range', min: 0.3, max: 2, step: 0.1, default: 1, lowLabel: 'small', highLabel: 'large', live: false },
  ];

  // Colours from compass_defaults[] in the C.
  const COL_DIAL = '#DDFFFF';     // .foreground (ticks, letters, bezel marks)
  const COL_THICK = '#F7D64A';    // *arrow2Foreground (thick needle)
  const COL_THIN = '#FFF66A';     // *arrow1Foreground (thin needle)
  const COL_POINTER = '#FF0000';  // *pointerForeground (top triangle)

  const TAU = Math.PI * 2;
  const FULL = 360 * 64;          // theta units: a full turn (the C's 360*64)

  // RAND(n) -> integer in [0, n); RANDSIGN() -> +1/-1 (the C's macros).
  const RAND = (n) => Math.floor(Math.random() * n);
  const RANDSIGN = () => (Math.random() < 0.5 ? 1 : -1);

  // All geometry is in DEVICE pixels: the canvas backing store is sized in
  // device px (innerWidth*dpr), and the C's size cap is in real pixels, so the
  // 2560-px retina check below doubles the cap exactly as the C does — the
  // compass ends up the same physical size on screen at any dpr.
  let W, H, cx, cy;
  let size;                       // disc base radius, device px
  let lwDial, lwArrow;            // stroke widths, device px
  let discs;                      // three spin states
  let dirty = true;

  // --- disc spin (init_spin / roll_disc) -----------------------------------

  function initSpin() {
    return {
      theta: RAND(FULL),                 // 0 .. 360*64
      velocity: RAND(16) * RANDSIGN(),
      acceleration: RAND(16) * RANDSIGN(),
      limit: 5 * 64,
    };
  }

  // Advance one disc's angle (the C's roll_disc). `speed` scales the per-step
  // increment only; the velocity/acceleration dynamics are untouched, so the
  // drift behaviour is identical and just paces faster/slower. theta wraps into
  // one turn; the C's sign juggling is preserved (it occasionally flips theta
  // into the negative domain and keeps spinning — bounded in [-FULL, FULL]).
  function roll(d) {
    const inc = d.velocity * config.speed;
    let th = d.theta;
    if (th < 0) th = -(th + inc);
    else th = th + inc;

    if (th > FULL) th -= FULL;
    else if (th < 0) th += FULL;

    d.theta = (d.theta > 0 ? th : -th);

    d.velocity += d.acceleration;

    if (d.velocity > d.limit || d.velocity < -d.limit) d.acceleration = -d.acceleration;

    // Alter direction of rotational acceleration randomly.
    if (RAND(120) === 0) d.acceleration = -d.acceleration;

    // Change acceleration very occasionally (int-truncated like the C, so it can
    // decay to 0 and leave a disc coasting at constant velocity — harmless).
    if (RAND(200) === 0) d.acceleration = Math.trunc(d.acceleration * (Math.random() < 0.5 ? 1.2 : 0.8));
  }

  // --- drawing -------------------------------------------------------------

  // Add an OPEN polyline (XDrawLines) to a Path2D. `pts` is a list of
  // [radiusFrac, angle] pairs measured from the centre; R is the base radius the
  // fractions multiply. Negative fractions land on the opposite side (the C's
  // `x + -radius*cos(th)` idiom). A repeated first point closes a glyph.
  function addPoly(path, R, pts) {
    for (let i = 0; i < pts.length; i++) {
      const f = pts[i][0];
      const a = pts[i][1];
      const px = cx + R * f * Math.cos(a);
      const py = cy + R * f * Math.sin(a);
      if (i === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    }
  }

  // disc 0: 72 tick marks (every 6th longer) + the lettered compass card.
  function buildDial(path, th2) {
    const tickAng = TAU / 72;
    for (let i = 0; i < 72; i++) {
      const a = i * tickAng + th2;
      const f2 = (i % 6) ? (1 - 1 / 16) : (1 - 1 / 8);   // minor / major tick
      path.moveTo(cx + size * Math.cos(a), cy + size * Math.sin(a));
      path.lineTo(cx + size * f2 * Math.cos(a), cy + size * f2 * Math.sin(a));
    }

    // Glyphs, one polyline each, at twelve evenly-spaced bearings (the C's
    // draw_letters; each th = th2 + 2*pi * (i/12)).
    let th;
    th = th2;                                                            // W
    addPoly(path, size, [[0.8, th - 0.07], [0.7, th - 0.05], [0.78, th], [0.7, th + 0.05], [0.8, th + 0.07]]);
    th = th2 + TAU * 0.08333;                                           // 30
    addPoly(path, size, [[0.78, th - 0.13], [0.8, th - 0.08], [0.78, th - 0.03], [0.76, th - 0.03], [0.75, th - 0.08], [0.74, th - 0.03], [0.72, th - 0.03], [0.7, th - 0.08], [0.72, th - 0.13]]);
    addPoly(path, size, [[0.78, th + 0.03], [0.8, th + 0.08], [0.78, th + 0.13], [0.72, th + 0.13], [0.7, th + 0.08], [0.72, th + 0.03], [0.78, th + 0.03]]);
    th = th2 + TAU * 0.16666;                                           // 33
    addPoly(path, size, [[0.78, th - 0.13], [0.8, th - 0.08], [0.78, th - 0.03], [0.76, th - 0.03], [0.75, th - 0.08], [0.74, th - 0.03], [0.72, th - 0.03], [0.7, th - 0.08], [0.72, th - 0.13]]);
    addPoly(path, size, [[0.78, th + 0.03], [0.8, th + 0.08], [0.78, th + 0.13], [0.76, th + 0.13], [0.75, th + 0.08], [0.74, th + 0.13], [0.72, th + 0.13], [0.7, th + 0.08], [0.72, th + 0.03]]);
    th = th2 + TAU * 0.25;                                              // N
    addPoly(path, size, [[0.7, th - 0.05], [0.8, th - 0.05], [0.7, th + 0.05], [0.8, th + 0.05]]);
    th = th2 + TAU * 0.33333;                                           // 3
    addPoly(path, size, [[0.78, th - 0.05], [0.8, th], [0.78, th + 0.05], [0.76, th + 0.05], [0.75, th], [0.74, th + 0.05], [0.72, th + 0.05], [0.7, th], [0.72, th - 0.05]]);
    th = th2 + TAU * 0.41666;                                           // 6
    addPoly(path, size, [[0.78, th + 0.05], [0.8, th], [0.78, th - 0.05], [0.72, th - 0.05], [0.7, th], [0.72, th + 0.05], [0.74, th + 0.05], [0.76, th], [0.74, th - 0.05]]);
    th = th2 + TAU * 0.5;                                               // E
    addPoly(path, size, [[0.8, th + 0.05], [0.8, th - 0.05], [0.75, th - 0.05], [0.75, th + 0.025], [0.75, th - 0.05], [0.7, th - 0.05], [0.7, th + 0.05]]);
    th = th2 + TAU * 0.58333;                                           // 12
    addPoly(path, size, [[0.77, th - 0.06], [0.8, th - 0.03], [0.7, th - 0.03]]);
    addPoly(path, size, [[0.78, th + 0.02], [0.8, th + 0.07], [0.78, th + 0.11], [0.76, th + 0.11], [0.74, th + 0.02], [0.71, th + 0.03], [0.7, th + 0.03], [0.7, th + 0.13]]);
    th = th2 + TAU * 0.66666;                                           // 15
    addPoly(path, size, [[0.77, th - 0.06], [0.8, th - 0.03], [0.7, th - 0.03]]);
    addPoly(path, size, [[0.8, th + 0.11], [0.8, th + 0.02], [0.76, th + 0.02], [0.77, th + 0.06], [0.76, th + 0.10], [0.73, th + 0.11], [0.72, th + 0.10], [0.7, th + 0.06], [0.72, th + 0.02]]);
    th = th2 + TAU * 0.75;                                              // S
    addPoly(path, size, [[0.78, th + 0.05], [0.8, th], [0.78, th - 0.05], [0.76, th - 0.05], [0.74, th + 0.05], [0.72, th + 0.05], [0.7, th], [0.72, th - 0.05]]);
    th = th2 + TAU * 0.83333;                                           // 21
    addPoly(path, size, [[0.78, th - 0.13], [0.8, th - 0.08], [0.78, th - 0.03], [0.76, th - 0.03], [0.74, th - 0.12], [0.71, th - 0.13], [0.7, th - 0.13], [0.7, th - 0.02]]);
    addPoly(path, size, [[0.77, th + 0.03], [0.8, th + 0.06], [0.7, th + 0.06]]);
    th = th2 + TAU * 0.91666;                                           // 24
    addPoly(path, size, [[0.78, th - 0.13], [0.8, th - 0.08], [0.78, th - 0.03], [0.76, th - 0.03], [0.74, th - 0.12], [0.71, th - 0.13], [0.7, th - 0.13], [0.7, th - 0.02]]);
    addPoly(path, size, [[0.69, th + 0.09], [0.8, th + 0.09], [0.72, th + 0.01], [0.72, th + 0.13]]);
  }

  // disc 1: thick double-ended arrow (all strokes — the C's draw_thick_arrow).
  function buildThickArrow(path, th) {
    const Ra = size * 0.9;
    const tick = (TAU / 72) * 2;
    // arrowhead outline (tip, tip-left, tip-right, back to tip)
    addPoly(path, Ra, [[1, th], [0.625, th - tick], [0.625, th + tick], [1, th]]);
    // tail: top-left, bottom-left, bottom, bottom-spike, bottom (return),
    // bottom-right, top-right.
    addPoly(path, Ra, [[0.625, th - tick / 2], [-0.625, th + tick / 2], [-0.75, th], [-1, th], [-0.75, th], [-0.625, th - tick / 2], [0.625, th + tick / 2]]);
  }

  // disc 2: thin arrow — a shaft line plus a filled head (draw_thin_arrow).
  function drawThinArrow(th) {
    const Ra = size * 0.9;
    const tick = (TAU / 72) * 2;
    ctx.strokeStyle = COL_THIN;
    ctx.fillStyle = COL_THIN;
    ctx.lineWidth = lwArrow;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // shaft: from base (0.625) through centre to the opposite spike (-1)
    ctx.beginPath();
    ctx.moveTo(cx + Ra * 0.625 * Math.cos(th), cy + Ra * 0.625 * Math.sin(th));
    ctx.lineTo(cx - Ra * Math.cos(th), cy - Ra * Math.sin(th));
    ctx.stroke();

    // filled arrowhead triangle
    ctx.beginPath();
    ctx.moveTo(cx + Ra * Math.cos(th), cy + Ra * Math.sin(th));
    ctx.lineTo(cx + Ra * 0.625 * Math.cos(th - tick), cy + Ra * 0.625 * Math.sin(th - tick));
    ctx.lineTo(cx + Ra * 0.625 * Math.cos(th + tick), cy + Ra * 0.625 * Math.sin(th + tick));
    ctx.closePath();
    ctx.fill();
  }

  // Static case decoration (the C's draw_pointer): a red top triangle + a red
  // accent, then six pale bezel marks. Does NOT rotate.
  function fillTri(color, ax, ay, bx, by, dx, dy) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(dx, dy);
    ctx.closePath();
    ctx.fill();
  }

  function drawPointer() {
    const r = size;
    const s = r * 0.1;
    fillTri(COL_POINTER, cx - s, cy - r - s, cx + s, cy - r - s, cx, cy - r);                                    // top
    fillTri(COL_POINTER, cx - r * 0.85, cy - r * 0.8, cx - r * 1.1, cy - r * 0.55, cx - r * 0.6, cy - r * 0.65); // top accent
    fillTri(COL_DIAL, cx - r * 1.05, cy, cx - r * 1.1, cy - r * 0.025, cx - r * 1.1, cy + r * 0.025);            // left
    fillTri(COL_DIAL, cx + r * 1.05, cy, cx + r * 1.1, cy - r * 0.025, cx + r * 1.1, cy + r * 0.025);            // right
    fillTri(COL_DIAL, cx, cy + r * 1.05, cx - r * 0.025, cy + r * 1.1, cx + r * 0.025, cy + r * 1.1);            // bottom
    fillTri(COL_DIAL, cx + r * 0.74, cy + r * 0.74, cx + r * 0.78, cy + r * 0.75, cx + r * 0.75, cy + r * 0.78); // SE mark
    fillTri(COL_DIAL, cx + r * 0.74, cy - r * 0.74, cx + r * 0.78, cy - r * 0.75, cx + r * 0.75, cy - r * 0.78); // NE mark
    fillTri(COL_DIAL, cx - r * 0.74, cy + r * 0.74, cx - r * 0.78, cy + r * 0.75, cx - r * 0.75, cy + r * 0.78); // SW mark
  }

  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    // disc 0: dial (ticks + letters) — one batched stroke.
    const dialPath = new Path2D();
    buildDial(dialPath, TAU * (discs[0].theta / FULL));
    ctx.strokeStyle = COL_DIAL;
    ctx.lineWidth = lwDial;
    ctx.lineJoin = 'bevel';   // the C's JoinBevel
    ctx.lineCap = 'butt';
    ctx.stroke(dialPath);

    // disc 1: thick arrow — one batched stroke.
    const thickPath = new Path2D();
    buildThickArrow(thickPath, TAU * (discs[1].theta / FULL));
    ctx.strokeStyle = COL_THICK;
    ctx.lineWidth = lwArrow;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(thickPath);

    // disc 2: thin arrow (shaft stroke + filled head).
    drawThinArrow(TAU * (discs[2].theta / FULL));

    // static case decoration on top.
    drawPointer();

    dirty = false;
  }

  // One step: advance every disc's angle. (The C draws then rolls; we roll then
  // draw — a one-frame phase offset, invisible. The first painted frame uses the
  // seeded random angles, so it already shows a complete compass.)
  function step() {
    for (const d of discs) roll(d);
    dirty = true;
  }

  // --- sizing / lifecycle --------------------------------------------------

  // Mirror compass_init's size math (in device px). size2 = min(W,H), widened
  // for goofy aspect ratios, capped at 600 (1200 past 2560 px ~ retina), then
  // radius = (size2/2)*0.8, scaled by the user `size` knob.
  function layout() {
    W = canvas.width;
    H = canvas.height;
    cx = W / 2;
    cy = H / 2;

    let size2 = Math.min(W, H);
    if (W > H * 5 || H > W * 5) size2 = Math.max(W, H);
    let max = 600;
    if (W > 2560 || H > 2560) max *= 2;
    if (size2 > max) size2 = max;

    size = (size2 / 2) * 0.8 * config.size;
    lwDial = Math.max(2, size / 60);    // the C's MAX(2, size/60), JoinBevel
    lwArrow = Math.max(4, size / 30);   // the C's MAX(4, size/30)
  }

  function init() {
    layout();
    discs = [initSpin(), initSpin(), initSpin()];
    dirty = true;
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

  // Rebuild after a non-live config change (size re-derives radii/line widths);
  // clears the screen and re-seeds via init().
  function reinit() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    init();
  }

  // Fixed-timestep lag accumulator (squiral/rotor style): one step() per
  // (config.delay + OVERHEAD) microseconds, banked so the pace is the same at any
  // refresh rate, with a catch-up cap so a backgrounded tab can't burst. Redraw
  // once per frame, only when a step actually advanced the discs.
  //
  // OVERHEAD = the live binary's per-frame compute slice. The xml *delay is a
  // sleep FLOOR, so the effective fps is 1e6/(delay+overhead), NOT 1e6/delay.
  // Measured off the live -fps overlay. A clean SOLO re-measure (no concurrent
  // load) reads a tight ~35 fps cluster (34.4/34.6/35.9) at Load ~30%, sleep
  // floor holding at 20000 us, so OVERHEAD = round(1e6/35.0) - 20000 = 8571.
  // (An earlier batch reading of 38.9 fps was a contended/EMA over-pick; the
  // clean rate is lower, i.e. a touch more per-frame compute.) Without it the
  // discs precessed at ~50/s instead of the live binary's ~35/s. See compass.md.
  const OVERHEAD = 8571;          // microseconds (measured off -fps, not by-eye)
  const MAX_CATCHUP_STEPS = 8;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;

  function frame(now) {
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
    reinit,   // fresh spin with the current config
    config,
    params,
  };
}
