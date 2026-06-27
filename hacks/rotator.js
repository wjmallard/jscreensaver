// rotator.js -- a faithful, standalone ES-module port of xscreensaver's
// hacks/glx/rotator.c (Jamie Zawinski).
//
// Encapsulates the smooth, randomly-accelerating multi-axis spin and the
// sinusoidal "wander through space" used by many GLX hacks (dangerball &c).
//
//   makeRotator({ spinX, spinY, spinZ, spinAccel, wanderSpeed, randomize }, rng)
//     -> { getRotation(update = true) -> { x, y, z },   // each in [0, 1)
//          getPosition(update = true) -> { x, y, z } }   // each in [0, 1]
//
// `rng` is a makeYaRandom(...) handle (see yarandom.js). random()/frand() are
// consumed in the SAME ORDER as the C original, so a shared, identically-seeded
// stream reproduces the original's choices. This is a pure math module: no DOM,
// no browser globals -- it runs the same in the browser and in Node.
//
// Faithful to make_rotator / rotate_1 / get_rotation / get_position. The sign
// conventions are deliberately odd (sign of position = direction of travel; v is
// always >= 0); they are preserved verbatim from the .c, comments and all.

export function makeRotator(opts, rng) {
  const {
    spinX = 0,
    spinY = 0,
    spinZ = 0,
    spinAccel = 0,
    wanderSpeed = 0,
    randomize = false,
  } = opts || {};

  if (spinX < 0 || spinY < 0 || spinZ < 0 || wanderSpeed < 0)
    throw new Error('makeRotator: speeds must be >= 0');

  // BELLRAND(n): (frand(n) + frand(n) + frand(n)) / 3   -- a triangular ~bell.
  // RANDSIGN():  (random() & 1) ? 1 : -1
  const frand = (f) => rng.frand(f);
  const bellrand = (n) => (frand(n) + frand(n) + frand(n)) / 3;
  const randsign = () => ((rng.random() & 1) ? 1 : -1);

  const r = {
    spin_x_speed: spinX,
    spin_y_speed: spinY,
    spin_z_speed: spinZ,
    wander_speed: wanderSpeed,

    rotx: 0, roty: 0, rotz: 0,   // current rotation, -1..+1; sign = direction.
    dx: 0, dy: 0, dz: 0,         // current rotational velocity, >= 0.
    ddx: 0, ddy: 0, ddz: 0,      // current rotational acceleration, +/-.
    d_max: 0,                    // max rotational velocity, > 0.
    wander_frame: 0,             // position in the wander cycle, >= 0.
  };

  if (randomize) {
    // Sign on position is direction of travel. Stripped before returned.
    // NOTE: evaluated left-to-right (frand then randsign); the C leaves the
    // operand order of `frand(1.0) * RANDSIGN()` unspecified -- see report.
    r.rotx = frand(1.0) * randsign();
    r.roty = frand(1.0) * randsign();
    r.rotz = frand(1.0) * randsign();
    r.wander_frame = rng.random() % 0xFFFF;
  }

  const d = 0.006;
  const dd = 0.00006;

  r.dx = bellrand(d * r.spin_x_speed);
  r.dy = bellrand(d * r.spin_y_speed);
  r.dz = bellrand(d * r.spin_z_speed);

  r.d_max = r.dx * 2;

  r.ddx = (dd + frand(dd + dd)) * r.spin_x_speed * spinAccel;
  r.ddy = (dd + frand(dd + dd)) * r.spin_y_speed * spinAccel;
  r.ddz = (dd + frand(dd + dd)) * r.spin_z_speed * spinAccel;

  // rotate_1: tick one axis one frame. Returns [pos, v, dv]. Mirrors the C
  // exactly, including the always-evaluated random()%120 / random()%200 draws
  // (and the conditional ones) so the RNG stream stays in step.
  function rotate1(pos, v, dv, speed, maxV) {
    if (speed === 0) return [pos, v, dv];

    let ppos = pos;
    if (ppos < 0)
      // Ignore but preserve the sign on ppos (the .c's "stupid" convention).
      ppos = -(ppos + v);
    else
      ppos += v;

    // CLAMP(ppos): bring into [0, 1) by +/-1 steps.
    while (ppos < 0) ppos += 1;
    while (ppos >= 1) ppos -= 1;
    pos = (pos > 0 ? ppos : -ppos);   // preserve old sign bit on pos.

    v += dv;                          // accelerate

    if (v > maxV || v < -maxV) {      // clamp velocity
      dv = -dv;
    } else if (v < 0) {               // v is meant to be >= 0: it stopped.
      if (rng.random() % 4) {
        v = 0;                        // don't let velocity be negative
        if (rng.random() % 2)         // stay stopped, kill acceleration
          dv = 0;
        else if (dv < 0)              // was decelerating, accelerate instead
          dv = -dv;
      } else {
        v = -v;                       // tiny positive velocity, or zero
        dv = -dv;                     // toggle acceleration
        pos = -pos;                   // reverse direction of motion
      }
    }

    // Alter direction of rotational acceleration randomly.
    if (!(rng.random() % 120)) dv = -dv;

    // Change acceleration very occasionally.
    if (!(rng.random() % 200)) {
      if (dv === 0) dv = 0.00001;
      else if (rng.random() & 1) dv *= 1.2;
      else dv *= 0.8;
    }

    return [pos, v, dv];
  }

  function getRotation(update = true) {
    if (update) {
      [r.rotx, r.dx, r.ddx] = rotate1(r.rotx, r.dx, r.ddx, r.spin_x_speed, r.d_max);
      [r.roty, r.dy, r.ddy] = rotate1(r.roty, r.dy, r.ddy, r.spin_y_speed, r.d_max);
      [r.rotz, r.dz, r.ddz] = rotate1(r.rotz, r.dz, r.ddz, r.spin_z_speed, r.d_max);
    }
    let x = r.rotx, y = r.roty, z = r.rotz;
    if (x < 0) x = -x;
    if (y < 0) y = -y;
    if (z < 0) z = -z;
    return { x, y, z };
  }

  function getPosition(update = true) {
    let x = 0.5, y = 0.5, z = 0.5;
    if (r.wander_speed !== 0) {
      if (update) r.wander_frame++;
      const sinoid = (F) =>
        (1 + Math.sin((r.wander_frame * F) / 2 * Math.PI)) / 2.0;
      x = sinoid(0.71 * r.wander_speed);
      y = sinoid(0.53 * r.wander_speed);
      z = sinoid(0.37 * r.wander_speed);
    }
    return { x, y, z };
  }

  return { getRotation, getPosition, _state: r };
}

export default makeRotator;
