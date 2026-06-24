// scooter.js — scooter packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's scooter.c (Sven Thoennissen, 2001; ported to
// XScreenSaver by EoflaOE, 2019). Originally a blanker from the Nightshift
// screensaver on the Amiga (EGS / VIONA Development).
// https://www.jwz.org/xscreensaver/
//
// A journey down a curving space tunnel through a star field. The tunnel is a
// chain of "z-elements": points strung one behind another along a path that
// slowly bends (each element carries its own drifting 3D rotation, so the
// corridor snakes). A handful of rectangular "doors" ride that chain at fixed
// spacing and a cloud of tiny "stars" hangs off it far from the axis; both
// scroll toward the viewer and recycle at the far end. Everything is projected
// to 2D with a 1/z perspective (proj = projnorm / (degree * z)), clipped at the
// near plane (z <= 0), so doors and stars grow and rush past as they approach.
//
// Rendering: full repaint per frame onto a cleared black canvas (the C calls
// XClearWindow every frame — there are no accumulating trails). Doors are drawn
// as stroked rectangles (4 edges, colour-ramped), stars as small filled rects.
// Sparse vector ops (a few dozen doors + ≤200 star rects) — far cheaper than a
// per-pixel ImageData blit over a mostly-black field.

export const title = 'scooter';

export const info = {
  author: 'Sven Thoennissen',
  description: 'Zooming down a tunnel in a star field. Originally an Amiga hack.',
  year: 2001,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // Defaults/ranges mirror hacks/config/scooter.xml so the config box maps 1:1.
  // The xml's "Boat Speed" maps to the C's `cycles` (clamped 1..10 internally).
  const config = {
    delay: 30000,   // \u00B5s between steps (--delay)
    cycles: 5,      // tunnel speed; z-elements shifted per step, 1..10 (--cycles)
    count: 24,      // number of doors (--count, min 4)
    size: 100,      // number of stars (--size)
    ncolors: 200,   // colour-ramp richness for the doors (--ncolors)
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 30000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'cycles', label: 'Speed', type: 'range', min: 1, max: 10, step: 1, default: 5, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'count', label: 'Doors', type: 'range', min: 4, max: 40, step: 1, default: 24, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'size', label: 'Stars', type: 'range', min: 1, max: 200, step: 1, default: 100, lowLabel: 'few', highLabel: 'many', live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 200, lowLabel: 'plain', highLabel: 'rich', live: false },
  ];

  // Geometry constants, verbatim from scooter.c.
  const MIN_DOORS = 4;
  const MIN_SPEED = 1;
  const MAX_SPEED = 10;
  const SPACE_XY_FACTOR = 10;
  const DOOR_WIDTH = 600 * SPACE_XY_FACTOR;     // 6000 space units
  const DOOR_HEIGHT = 400 * SPACE_XY_FACTOR;    // 4000 space units
  const STAR_MIN_X = 1000 * SPACE_XY_FACTOR;
  const STAR_MIN_Y = 750 * SPACE_XY_FACTOR;
  const STAR_MAX_X = 10000 * SPACE_XY_FACTOR;
  const STAR_MAX_Y = 7500 * SPACE_XY_FACTOR;
  const STAR_SIZE_MIN = 2 * SPACE_XY_FACTOR;
  const STAR_SIZE_MAX = 64 * SPACE_XY_FACTOR;
  const DOOR_CURVEDNESS = 14;                   // larger = harder corridor curves
  const PROJECTION_DEGREE = 2.4;                // larger = more fish-eye
  const ASPECT_SCREENWIDTH = 1152;              // reference 4:3 resolution
  const ASPECT_SCREENHEIGHT = 864;
  const ZELEMENTS_PER_DOOR = 60;
  const ZELEMENT_DISTANCE = 300;
  const PROJNORM_Z = 50 * 240;                  // 12000

  // The C builds its own fast sin/cos lookup over a 0x8000-entry table indexed
  // by an integer angle masked to 0x7fff. We keep the same integer-angle units
  // (so the rotation deltas and accumulation match the original exactly) but go
  // straight to Math.sin/cos with a conversion factor — no table needed.
  const SINUSTABLE_SIZE = 0x8000;
  const SINUSTABLE_MASK = 0x7fff;
  const ANGLE_TO_RAD = (Math.PI * 2) / SINUSTABLE_SIZE;
  const sinAngle = (a) => Math.sin((a & SINUSTABLE_MASK) * ANGLE_TO_RAD);
  const cosAngle = (a) => Math.sin(((a + (SINUSTABLE_SIZE / 4)) & SINUSTABLE_MASK) * ANGLE_TO_RAD);

  // NRAND(n) -> integer in [0, n); LRAND-style helpers as in the C.
  const nrand = (n) => Math.floor(Math.random() * n);
  const sgn = (a) => (a < 0 ? -1 : 1);

  let S = 1;            // devicePixelRatio
  let W, H;             // canvas size, device px
  let midX, midY;       // screen centre, device px
  let aspectScale;      // world->screen scale for this window (folds in dpr)

  // Tunnel state (mirrors scooterstruct).
  let doorcount, ztotal, starcount;
  let spectator;        // index of the viewer's z-element
  let zPos;             // Int32Array ztotal*3: position (x,y,z) of each z-element
  let zAng;             // Int32Array ztotal*3: rotation angle (x,y,z) of each z-element
  let doors;            // [{ zelement, r, g, b }]
  let stars;            // [{ zelement, xpos, ypos, width, height, draw }]

  // Rotation drift state for the leading z-element.
  let curRotX, curRotY, curRotZ;
  let deltaX, deltaY, deltaZ;
  let rotationDuration, rotationStep;

  // Door colour-ramp cycling state.
  let beginColor, endColor;     // each { r, g, b } in 0..0xffff
  let colorCount, colorSteps;

  // 1/z perspective: nearer (smaller z) -> larger projection factor.
  function projection(z) {
    return PROJNORM_Z / (PROJECTION_DEGREE * z);
  }

  // Random 24-bit colour spread into 16-bit r/g/b channels (the C's randomcolor).
  function randomColor() {
    const n = nrand(0x1000000);
    return {
      r: (n >> 16) << 8,
      g: ((n >> 8) & 0xff) << 8,
      b: (n & 0xff) << 8,
    };
  }

  // Next colour along the door ramp: interpolate begin->end, start a fresh ramp
  // (random length 8..39) whenever the current one runs out. Mirrors
  // nextdoorcolor(); the result is stored as r/g/b bytes on the door.
  function nextDoorColor(door) {
    if (config.ncolors <= 2) {
      door.r = door.g = door.b = 255;
      return;
    }
    if (colorCount >= colorSteps) {
      colorCount = 0;
      colorSteps = 8 + nrand(32);
      beginColor = endColor;
      endColor = randomColor();
    }
    const r = beginColor.r + ((endColor.r - beginColor.r) * colorCount / colorSteps);
    const g = beginColor.g + ((endColor.g - beginColor.g) * colorCount / colorSteps);
    const b = beginColor.b + ((endColor.b - beginColor.b) * colorCount / colorSteps);
    colorCount++;
    door.r = (r / 256) & 0xff;   // 16-bit channel -> 8-bit
    door.g = (g / 256) & 0xff;
    door.b = (b / 256) & 0xff;
  }

  // Rotate src (x,y,z) by an integer Euler angle (ax,ay,az) into out[0..2],
  // matching rotate_3d(): X-axis, then Y-axis, then Z-axis. Truncates to int
  // like the C's (int) casts so the curving corridor accumulates identically.
  const rotTmp = [0, 0, 0];
  function rotate3d(sx, sy, sz, ax, ay, az, out) {
    const cosa = cosAngle(ax), cosb = cosAngle(ay), cosc = cosAngle(az);
    const sina = sinAngle(ax), sinb = sinAngle(ay), sinc = sinAngle(az);

    // X axis
    let tz = sz, ty = sy;
    let dz = (tz * cosa - ty * sina) | 0;
    let dy = (tz * sina + ty * cosa) | 0;

    // Y axis
    tz = dz;
    const tx0 = sx;
    dz = (tz * cosb - tx0 * sinb) | 0;
    let dx = (tz * sinb + tx0 * cosb) | 0;

    // Z axis
    const tx1 = dx, ty1 = dy;
    dx = (tx1 * cosc - ty1 * sinc) | 0;
    dy = (tx1 * sinc + ty1 * cosc) | 0;

    out[0] = dx;
    out[1] = dy;
    out[2] = dz;
    rotTmp[0] = dx; rotTmp[1] = dy; rotTmp[2] = dz;
  }

  // Advance the leading z-element's drift rotation by one step (calc_new_element):
  // a smooth sine-eased nudge of the current angle by a random per-interval delta,
  // re-rolling the delta and interval length (10..30 s at speed 1) when it elapses.
  function calcNewElement() {
    const rot = sinAngle(((SINUSTABLE_SIZE / 2) * rotationStep / rotationDuration) | 0);

    if (rotationStep++ >= rotationDuration) {
      const fps = Math.max(1, Math.floor(1000000 / config.delay));   // frames per second
      rotationDuration = 10 * fps + nrand(20 * fps);
      deltaX = nrand(DOOR_CURVEDNESS * 2 + 1) - DOOR_CURVEDNESS;
      deltaY = nrand(DOOR_CURVEDNESS * 2 + 1) - DOOR_CURVEDNESS;
      deltaZ = nrand(DOOR_CURVEDNESS * 2 + 1) - DOOR_CURVEDNESS;
      rotationStep = 0;
    }

    curRotX = (curRotX + ((rot * deltaX) | 0)) & SINUSTABLE_MASK;
    curRotY = (curRotY + ((rot * deltaY) | 0)) & SINUSTABLE_MASK;
    curRotZ = (curRotZ + ((rot * deltaZ) | 0)) & SINUSTABLE_MASK;
  }

  // One frame of motion (shift_elements): scroll the angle chain forward by
  // `speed`, append fresh angles at the far end, rebuild every z-element's 3D
  // position by walking the chain out from the spectator, then scroll the doors
  // and stars and recycle any that have passed the viewer.
  function shiftElements(speed) {
    // Shift angles toward the viewer.
    for (let i = speed; i < ztotal; i++) {
      const dst = (i - speed) * 3, src = i * 3;
      zAng[dst] = zAng[src];
      zAng[dst + 1] = zAng[src + 1];
      zAng[dst + 2] = zAng[src + 2];
    }
    for (let i = ztotal - speed; i < ztotal; i++) {
      calcNewElement();
      const o = i * 3;
      zAng[o] = curRotX;
      zAng[o + 1] = curRotY;
      zAng[o + 2] = curRotZ;
    }

    // Spectator's position is fixed on the z-axis.
    const so = spectator * 3;
    const sAngX = zAng[so], sAngY = zAng[so + 1], sAngZ = zAng[so + 2];
    zPos[so] = 0;
    zPos[so + 1] = 0;
    zPos[so + 2] = ZELEMENT_DISTANCE * spectator;

    // Walk toward the viewer (each element one ZELEMENT_DISTANCE *behind* in z,
    // rotated by its angle relative to the spectator, accumulated from the next).
    for (let i = spectator - 1; i >= 0; i--) {
      const o = i * 3, prev = (i + 1) * 3;
      rotate3d(0, 0, -ZELEMENT_DISTANCE,
        zAng[o] - sAngX, zAng[o + 1] - sAngY, zAng[o + 2] - sAngZ, rotTmp);
      zPos[o] = rotTmp[0] + zPos[prev];
      zPos[o + 1] = rotTmp[1] + zPos[prev + 1];
      zPos[o + 2] = rotTmp[2] + zPos[prev + 2];
    }
    // Walk away from the viewer (each one ZELEMENT_DISTANCE *ahead* in z).
    for (let i = spectator + 1; i < ztotal; i++) {
      const o = i * 3, prev = (i - 1) * 3;
      rotate3d(0, 0, ZELEMENT_DISTANCE,
        zAng[o] - sAngX, zAng[o + 1] - sAngY, zAng[o + 2] - sAngZ, rotTmp);
      zPos[o] = rotTmp[0] + zPos[prev];
      zPos[o + 1] = rotTmp[1] + zPos[prev + 1];
      zPos[o + 2] = rotTmp[2] + zPos[prev + 2];
    }

    // Scroll doors; wrap + recolour any that pass the near plane.
    for (let i = 0; i < doorcount; i++) {
      const d = doors[i];
      d.zelement -= speed;
      if (d.zelement < 0) {
        d.zelement += ztotal;
        nextDoorColor(d);
      }
    }

    // Scroll stars; wrap + respawn position/size for any that pass.
    for (let i = 0; i < starcount; i++) {
      const s = stars[i];
      s.zelement -= speed;
      if (s.zelement < 0) {
        s.zelement += ztotal;
        s.draw = 1;
        let rnd = nrand(2 * (STAR_MAX_X - STAR_MIN_X)) - (STAR_MAX_X - STAR_MIN_X);
        s.xpos = rnd + (STAR_MIN_X * sgn(rnd));
        rnd = nrand(2 * (STAR_MAX_Y - STAR_MIN_Y)) - (STAR_MAX_Y - STAR_MIN_Y);
        s.ypos = rnd + (STAR_MIN_Y * sgn(rnd));
        rnd = nrand(STAR_SIZE_MAX - STAR_SIZE_MIN) + STAR_SIZE_MIN;
        s.width = rnd;
        s.height = (rnd * 3 / 4) | 0;
      }
    }
  }

  // Project a single door's 4 corners (door_3d): each corner of the
  // DOOR_WIDTH x DOOR_HEIGHT rectangle is rotated by the door z-element's
  // spectator-relative angle and offset by its position. Returns null if any
  // corner is at/behind the near plane (the C skips the whole door then).
  const doorCorners = [0, 0, 0, 0, 0, 0, 0, 0];   // x0,y0,x1,y1,x2,y2,x3,y3 (screen)
  const corner = [0, 0, 0];
  function projectDoor(door) {
    const ze = door.zelement * 3;
    const so = spectator * 3;
    const ax = zAng[ze] - zAng[so];
    const ay = zAng[ze + 1] - zAng[so + 1];
    const az = zAng[ze + 2] - zAng[so + 2];
    const px = zPos[ze], py = zPos[ze + 1], pz = zPos[ze + 2];

    // lefttop, righttop, rightbottom, leftbottom
    const src = [
      [-DOOR_WIDTH / 2, DOOR_HEIGHT / 2],
      [DOOR_WIDTH / 2, DOOR_HEIGHT / 2],
      [DOOR_WIDTH / 2, -DOOR_HEIGHT / 2],
      [-DOOR_WIDTH / 2, -DOOR_HEIGHT / 2],
    ];

    for (let j = 0; j < 4; j++) {
      rotate3d(src[j][0], src[j][1], 0, ax, ay, az, corner);
      const z = corner[2] + pz;
      if (z <= 0) return null;   // near-plane clip: drop the whole door
      const proj = projection(z) * aspectScale;
      const x = corner[0] + px;
      const y = corner[1] + py;
      doorCorners[j * 2] = midX + ((x * proj / SPACE_XY_FACTOR) | 0);
      doorCorners[j * 2 + 1] = midY - ((y * proj / SPACE_XY_FACTOR) | 0);
    }
    return doorCorners;
  }

  // Draw all doors as stroked rectangles (4 edges each). Canvas clips strokes to
  // the surface for free, so the C's per-edge clipline() is unnecessary; the
  // door-level near-plane skip is kept (projectDoor returns null).
  function drawDoors() {
    ctx.lineWidth = 2 * S;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    for (let i = 0; i < doorcount; i++) {
      const d = doors[i];
      const c = projectDoor(d);
      if (!c) continue;
      ctx.strokeStyle = `rgb(${d.r},${d.g},${d.b})`;
      ctx.beginPath();
      ctx.moveTo(c[0], c[1]);
      ctx.lineTo(c[2], c[3]);
      ctx.lineTo(c[4], c[5]);
      ctx.lineTo(c[6], c[7]);
      ctx.closePath();
      ctx.stroke();
    }
  }

  // Draw all live stars as small filled white rects (drawstars). Each star is an
  // offset point rotated around its z-element, projected, then clipped to the
  // screen as a rectangle. The C currently fills an ellipse here; we render the
  // original rectangle form (also what the prompt asks for) — see scooter.md.
  const starVec = [0, 0, 0];
  function drawStars() {
    ctx.fillStyle = '#fff';
    for (let i = 0; i < starcount; i++) {
      const s = stars[i];
      if (!s.draw) continue;

      const ze = s.zelement * 3;
      const so = spectator * 3;
      const ax = zAng[ze] - zAng[so];
      const ay = zAng[ze + 1] - zAng[so + 1];
      const az = zAng[ze + 2] - zAng[so + 2];

      rotate3d(s.xpos, s.ypos, 0, ax, ay, az, starVec);
      const cx = starVec[0] + zPos[ze];
      const cy = starVec[1] + zPos[ze + 1];
      const cz = starVec[2] + zPos[ze + 2];
      if (cz <= 0) continue;

      const proj = projection(cz) * aspectScale;

      let ltx = midX + (((cx - s.width / 2) * proj / SPACE_XY_FACTOR) | 0);
      let lty = midY - (((cy + s.height / 2) * proj / SPACE_XY_FACTOR) | 0);
      if (ltx < 0) ltx = 0; else if (ltx >= W) continue;
      if (lty < 0) lty = 0; else if (lty >= H) continue;

      let rbx = midX + (((cx + s.width / 2) * proj / SPACE_XY_FACTOR) | 0);
      let rby = midY - (((cy - s.height / 2) * proj / SPACE_XY_FACTOR) | 0);
      if (rbx < 0) continue; else if (rbx >= W) rbx = W - 1;
      if (rby < 0) continue; else if (rby >= H) rby = H - 1;

      ctx.fillRect(ltx, lty, Math.max(1, rbx - ltx), Math.max(1, rby - lty));
    }
  }

  // One simulation+draw step: clear, advance the tunnel, draw stars then doors
  // (the C's draw order). aspectScale is recomputed here in case of resize.
  function step() {
    let speed = Math.round(config.cycles);
    if (speed < MIN_SPEED) speed = MIN_SPEED;
    if (speed > MAX_SPEED) speed = MAX_SPEED;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    shiftElements(speed);

    // Scale doors/stars for this window vs the reference 4:3 (use the smaller
    // dimension when the aspect differs). W/H are device px, so this folds in
    // devicePixelRatio for free (the projected coords land in device px).
    if (W / H >= ASPECT_SCREENWIDTH / ASPECT_SCREENHEIGHT) {
      aspectScale = H / ASPECT_SCREENHEIGHT;
    } else {
      aspectScale = W / ASPECT_SCREENWIDTH;
    }

    drawStars();
    drawDoors();
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    midX = (W / 2) | 0;
    midY = (H / 2) | 0;

    doorcount = Math.max(Math.round(config.count), MIN_DOORS);
    starcount = Math.max(1, Math.round(config.size));
    ztotal = doorcount * ZELEMENTS_PER_DOOR;
    if (starcount > ztotal) starcount = ztotal;
    spectator = ZELEMENTS_PER_DOOR;

    // Door colour ramp: prime endcolor so the first ramp starts cleanly.
    endColor = randomColor();
    beginColor = endColor;
    colorCount = 0;
    colorSteps = 0;

    zPos = new Int32Array(ztotal * 3);
    zAng = new Int32Array(ztotal * 3);   // all angles start at 0

    doors = [];
    for (let i = 0; i < doorcount; i++) {
      const d = {
        zelement: (ZELEMENTS_PER_DOOR * (i + 1)) - 1,
        r: 255,
        g: 255,
        b: 255,
      };
      nextDoorColor(d);
      doors.push(d);
    }

    stars = [];
    for (let i = 0; i < starcount; i++) {
      stars.push({
        zelement: ((ztotal * i / starcount) | 0),
        xpos: 0,
        ypos: 0,
        width: 0,
        height: 0,
        draw: 0,
      });
    }

    curRotX = 0;
    curRotY = 0;
    curRotZ = 0;
    deltaX = 0;
    deltaY = 0;
    deltaZ = 0;
    rotationDuration = 1;
    rotationStep = 0;

    aspectScale = H / ASPECT_SCREENHEIGHT;   // placeholder; step() recomputes it

    // Clear to black. step() runs shiftElements() before the first draw (as the
    // C does), so frame 1 already shows the corridor of doors.
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

  // rAF lag-accumulator loop paced by config.delay (µs in the xml; divided by
  // 1000 for the ms rAF clock), with the same catch-up cap as squiral so a
  // backgrounded tab doesn't fire a burst of steps on refocus. Each step() does
  // a full clear+repaint, so we never draw more than we step.
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

    rafId = requestAnimationFrame(frame);
  }

  // Re-seed with the current config (clears the canvas; door/star counts and the
  // colour ramp may have changed).
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
