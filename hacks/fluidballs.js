// fluidballs.js — fluidballs packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's fluidballs.c (Peter Birtles 2000; ported to X11 by
// jwz 2002, physics tweaks by Steven Barker).
// https://www.jwz.org/xscreensaver/
//
// A box full of balls bouncing under gravity. Each frame: every pair of balls is
// tested for overlap (the O(n^2) check is fine at the default counts) and, where
// two balls intersect, they are pushed apart by half the overlap each and given a
// 1D elastic-collision impulse along the line between their centres, scaled by an
// elasticity coefficient so a little energy is lost on every bounce. The walls of
// the box clamp each ball back inside and reflect its velocity (also damped by
// elasticity). Then gravity (and optional "wind") accelerates every ball and the
// positions integrate forward. Balls can be a single size or a random spread up to
// a maximum, sized so heavier (bigger) balls shove lighter ones aside; they pile
// up and jostle in the corners like a coarse fluid. With "shake" on, once the pile
// settles the direction of gravity is randomly permuted (and the colour re-rolled),
// tipping the box over so the balls avalanche to a new corner.
//
// Rendering: filled circles via ctx.arc, FULL REPAINT each frame (clear to black,
// then draw every ball). The C double-buffers and erases each ball's old disc; a
// straight clear-and-redraw is the canvas equivalent and avoids erase "turds".

export const title = 'fluidballs';

export const info = {
  author: 'Peter Birtles and Jamie Zawinski',
  description: 'A particle system of bouncing balls. Gravity moves around to shake the box.',
  year: 2002,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/fluidballs.xml so the config box maps
  // 1:1 to the original. `delay` is a touch calmer than the stock 10000 us by
  // feel; everything else matches the xml defaults.
  const config = {
    delay: 16000,        // \u00B5s between steps (--delay; stock 10000)
    count: 300,          // number of balls (--count)
    size: 25,            // ball diameter; max_radius = size/2 (--size)
    gravity: 0.01,       // downward acceleration (--gravity)
    wind: 0.00,          // horizontal acceleration (--wind)
    elasticity: 0.97,    // coefficient of restitution, 0.2..1 (--elasticity)
    random: true,        // various ball sizes up to max (--no-random)
    shake: true,         // permute gravity once the pile settles (--no-shake)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 16000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'count', label: 'Number of balls', type: 'range', min: 1, max: 3000, step: 1, default: 300, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'size', label: 'Ball size', type: 'range', min: 3, max: 200, step: 1, default: 25, lowLabel: 'small', highLabel: 'large', live: false },
    { key: 'gravity', label: 'Gravity', type: 'range', min: 0, max: 0.1, step: 0.001, default: 0.01, lowLabel: 'freefall', highLabel: 'Jupiter', live: true },
    { key: 'wind', label: 'Wind', type: 'range', min: 0, max: 0.1, step: 0.001, default: 0.00, lowLabel: 'still', highLabel: 'hurricane', live: true },
    { key: 'elasticity', label: 'Friction', type: 'range', min: 0.2, max: 1, step: 0.01, default: 0.97, lowLabel: 'clay', highLabel: 'rubber', live: true },
    { key: 'random', label: 'Various ball sizes', type: 'checkbox', default: true, live: false },
    { key: 'shake', label: 'Shake box', type: 'checkbox', default: true, live: true },
  ];

  // Physics constants, from fluidballs.c.
  const TC = 1.0;                  // time constant (timeScale); the C clamps to 0..10
  const SHAKE_THRESHOLD = 0.015;   // max per-frame motion below which we "shake"

  let S = 1;          // devicePixelRatio
  let W, H;           // canvas size, device px (the box is [0,W] x [0,H])
  let count;          // actual ball count (may be trimmed to fit the box)
  let maxRadius;      // largest ball radius, device px
  let px, py;         // ball positions (Float64, index 0 unused to match the C)
  let vx, vy;         // ball velocities
  let opx, opy;       // previous positions (only used to measure motion for shake)
  let r;              // ball radii
  let m;              // ball masses, precomputed
  let color, color2;  // current ball colour, and the "special" colour (1 ball)
  let specialBall;    // index drawn in color2 (the C's mouse_ball; here just decor)
  let timeSinceShake; // seconds (real wall-clock) since the last shake
  let lastShakeClock; // performance.now() at the last shake bookkeeping tick

  // Gravity orientation. shake() permutes the C's running (accx, accy); we keep
  // that permutation symbolically as coefficients on the *base* (wind, gravity)
  // so the live sliders still feed through: accx = axW*wind + axG*gravity, etc.
  // (Each coefficient is one of -1/0/1.) Start: accx = wind, accy = gravity.
  let axW, axG, ayW, ayG;
  function accX() { return axW * config.wind + axG * config.gravity; }
  function accY() { return ayW * config.wind + ayG * config.gravity; }

  // frand(x) in the C is a uniform float in [0, x).
  function frand(x) {
    return Math.random() * x;
  }

  // Bright, saturated ball colours: the C rolls each channel in [0x88, 0xff],
  // i.e. always at least half-bright. We do the same to a CSS rgb() string.
  function randomColor() {
    const ch = () => 0x88 + ((Math.random() * 0x78) | 0);
    return `rgb(${ch()},${ch()},${ch()})`;
  }

  function recolor() {
    color = randomColor();
    color2 = randomColor();
  }

  // Initialise ball arrays and the box. Mirrors fluidballs_init().
  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;

    // Identity orientation: accx = wind, accy = gravity (the C's starting state;
    // it clamps each to [-1, 1], which our slider ranges already respect).
    axW = 1; axG = 0;
    ayW = 0; ayG = 1;
    timeSinceShake = 0;
    lastShakeClock = 0;

    recolor();

    count = Math.max(1, Math.round(config.count));

    // max_radius = size/2, scaled to device px; retina bump and tiny-window cap
    // match the C (which keys the retina test on a 2560 px window).
    maxRadius = (config.size / 2) * S;
    if (maxRadius < 1) maxRadius = 1;
    if (W > 2560 || H > 2560) maxRadius *= 3;
    if ((W < 100 || H < 100) && maxRadius > 5) maxRadius = 5;

    // If the balls won't fit in 75% of the box, make fewer of them (verbatim
    // from the C: a random-sized run reserves area as if every ball were 0.7r).
    {
      const rr = config.random ? maxRadius * 0.7 : maxRadius;
      const ballArea = Math.PI * rr * rr;
      const windowArea = W * H * 0.75;
      if (count * ballArea > windowArea) {
        count = Math.max(1, Math.floor(windowArea / ballArea));
      }
    }

    // Index 0 is unused so the loops read 1..count exactly like the C.
    const n = count + 1;
    px = new Float64Array(n);
    py = new Float64Array(n);
    vx = new Float64Array(n);
    vy = new Float64Array(n);
    opx = new Float64Array(n);
    opy = new Float64Array(n);
    r = new Float64Array(n);
    m = new Float64Array(n);

    for (let i = 1; i <= count; i++) {
      px[i] = frand(W);
      py[i] = frand(H);
      vx[i] = frand(0.2) - 0.1;
      vy[i] = frand(0.2) - 0.1;
      r[i] = config.random
        ? (0.2 + frand(0.8)) * maxRadius
        : maxRadius;
      // The C uses a sphere-like mass m = r^3 * pi * 4/3 so big balls dominate.
      m[i] = Math.pow(r[i], 3) * Math.PI * 1.3333;
    }

    opx.set(px);
    opy.set(py);

    // One ball gets the "special" colour, purely for a little visual variety
    // (the C reserves this colour for the mouse-dragged ball, which we omit).
    specialBall = 1 + ((Math.random() * count) | 0);
  }

  // Messes with gravity: permute "down" to a random one of four directions, then
  // re-roll the colours. Mirrors shake() in C, which maps the current (accx, accy)
  // by case. We apply the same linear map to the orientation coefficients (so the
  // permutation composes across shakes and still tracks the live wind/gravity):
  //   0: (a,b)->(a,b)   1: ->(-a,-b)   2: ->(b,a)   3: ->(-b,-a)
  function shake() {
    const xw = axW, xg = axG, yw = ayW, yg = ayG;  // current (accx, accy) coeffs
    switch ((Math.random() * 4) | 0) {
      case 0:
        // identity
        break;
      case 1:
        axW = -xw; axG = -xg; ayW = -yw; ayG = -yg;
        break;
      case 2:
        axW = yw; axG = yg; ayW = xw; ayG = xg;
        break;
      default:
        axW = -yw; axG = -yg; ayW = -xw; ayG = -xg;
        break;
    }
    timeSinceShake = 0;
    recolor();
    specialBall = 1 + ((Math.random() * count) | 0);
  }

  // One physics step: pairwise collisions, wall clamps, then gravity. Mirrors
  // update_balls(). e is read live from config so the Friction slider applies
  // instantly. tc folds into the integration like the C's time constant.
  function step() {
    const e = config.elasticity;

    // For each ball, the influence of every other ball (O(n^2), upper triangle).
    for (let a = 1; a <= count - 1; a++) {
      for (let b = a + 1; b <= count; b++) {
        const dx = px[a] - px[b];
        const dy = py[a] - py[b];
        let d = dx * dx + dy * dy;
        const sumr = r[a] + r[b];
        const dee2 = sumr * sumr;
        if (d < dee2) {
          d = Math.sqrt(d);
          if (d === 0) d = 0.0001;        // guard the divide if perfectly stacked
          const dd = sumr - d;            // overlap depth
          const cdx = (px[b] - px[a]) / d;
          const cdy = (py[b] - py[a]) / d;

          // Push each ball out by half the overlap along the collision axis.
          px[a] -= 0.5 * dd * cdx;
          py[a] -= 0.5 * dd * cdy;
          px[b] += 0.5 * dd * cdx;
          py[b] += 0.5 * dd * cdy;

          const ma = m[a];
          const mb = m[b];

          const vxa = vx[a];
          const vya = vy[a];
          const vxb = vx[b];
          const vyb = vy[b];

          // Components of each velocity along the collision axis.
          const vca = vxa * cdx + vya * cdy;
          const vcb = vxb * cdx + vyb * cdy;

          // 1D elastic collision along that axis; e bleeds off some energy.
          let dva = (vca * (ma - mb) + vcb * 2 * mb) / (ma + mb) - vca;
          let dvb = (vcb * (mb - ma) + vca * 2 * ma) / (ma + mb) - vcb;
          dva *= e;
          dvb *= e;

          vx[a] = vxa + dva * cdx;
          vy[a] = vya + dva * cdy;
          vx[b] = vxb + dvb * cdx;
          vy[b] = vyb + dvb * cdy;
        }
      }
    }

    // Force every ball to stay inside the box, reflecting (and damping) velocity.
    for (let a = 1; a <= count; a++) {
      if (px[a] <= r[a]) {
        px[a] = r[a];
        vx[a] = -vx[a] * e;
      }
      if (px[a] >= W - r[a]) {
        px[a] = W - r[a];
        vx[a] = -vx[a] * e;
      }
      if (py[a] <= r[a]) {
        py[a] = r[a];
        vy[a] = -vy[a] * e;
      }
      if (py[a] >= H - r[a]) {
        py[a] = H - r[a];
        vy[a] = -vy[a] * e;
      }
    }

    // Apply gravity/wind and integrate position (the mouse ball is omitted here).
    // accX()/accY() read the live sliders through the current shake orientation.
    const ax = accX();
    const ay = accY();
    for (let a = 1; a <= count; a++) {
      vx[a] += ax * TC;
      vy[a] += ay * TC;
      px[a] += vx[a] * TC;
      py[a] += vy[a] * TC;
    }
  }

  // Full repaint: clear, draw each ball, and (if shaking) measure how far the
  // balls moved so we know when the pile has settled. Wall-clock bookkeeping for
  // the shake timer uses performance.now() in place of the C's gettimeofday.
  function draw(now) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    let maxD = 0;
    for (let a = 1; a <= count; a++) {
      ctx.fillStyle = a === specialBall ? color2 : color;
      ctx.beginPath();
      ctx.arc(px[a], py[a], r[a], 0, Math.PI * 2);
      ctx.fill();

      if (config.shake) {
        const dx = px[a] - opx[a];
        const dy = py[a] - opy[a];
        const d = dx * dx + dy * dy;
        if (d > maxD) maxD = d;
      }
      opx[a] = px[a];
      opy[a] = py[a];
    }

    // Advance the real-time shake clock and decide whether to tip the box.
    if (lastShakeClock === 0) lastShakeClock = now;
    timeSinceShake += (now - lastShakeClock) / 1000;
    lastShakeClock = now;

    if (config.shake && timeSinceShake > 5) {
      maxD /= maxRadius;
      // Shake once the pile is stable, or after 30 s no matter what.
      if (maxD < SHAKE_THRESHOLD || timeSinceShake > 30) {
        shake();
      }
    }
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced by config.delay (us); run one step() per delay,
  // banking leftover time so the speed is identical at any refresh rate. Cap
  // catch-up so a backgrounded tab doesn't burst on refocus. The collision pass
  // is the heavy work, so we draw at most once per frame (not once per step).
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

    draw(now);
    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (count/size/random change the ball set, so
  // a non-live edit rebuilds everything). init() does not paint, so clear first.
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
    resume() { if (!rafId) { lastTime = 0; lastShakeClock = 0; rafId = requestAnimationFrame(frame); } },
    reinit,
    config,
    params,
  };
}
