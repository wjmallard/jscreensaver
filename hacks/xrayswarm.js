// xrayswarm.js -- xrayswarm packaged as a mountable module.
// start(canvas) returns { stop, pause, resume, reinit, config, params }.
//
// Port of xscreensaver's xrayswarm.c (Chris Leger, 2000), a ripoff of SGI's
// "swarm". https://www.jwz.org/xscreensaver/
//
// A handful of slow-drifting "targets" wander the screen (each bouncing off the
// walls with a small random acceleration). A larger cloud of "bugs" chases its
// currently-closest target, accelerating toward it (with a little directional
// noise) under a speed clamp, so the bugs orbit and overshoot in worm-like
// swarms. Every bug and target keeps a short ring buffer of its recent pixel
// positions (head/tail indices shared by all entities); each frame the trail is
// redrawn as a chain of line segments that fade from bright (at the head) to
// dark (at the tail), giving the "vapor trail" / x-ray look. Periodically the
// physics parameters mutate, bugs convert to/from targets, the colour scheme
// changes, and occasionally the whole swarm reseeds.
//
// Rendering: SPARSE vector drawing. Each frame clears to black and redraws all
// trail segments (the C redraws them all every frame too), batched into one
// Path2D per colour-map index so we stroke <= ncolors times per frame rather
// than once per segment. See [[whirlwindwarp]] and [[galaxy]] (swarming
// particles with fading trails); skeleton follows [[squiral]].

export const title = 'xrayswarm';

export const info = {
  author: 'Chris Leger',
  description: 'Worm-like swarms of particles with vapor trails.',
  year: 2000,
};

export function start(canvas) {
  const ctx = canvas.getContext('2d');

  // The stock xrayswarm UI (hacks/config/xrayswarm.xml) exposes only `delay`
  // (plus a debug --fps toggle we omit). Bug/target/trail counts, the colour
  // scheme, and the mutation rate are all auto-managed by the C and never were
  // user resources, so we do NOT surface them as sliders. See xrayswarm.md.
  const config = {
    delay: 20000,      // microseconds between sim steps (--delay; the xml stock value)
  };

  // Mirrors the only stock resource: `delay`, the usleep interval in
  // microseconds (the xml's "Frame rate", inverted so high = faster).
  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
  ];

  // Hard-coded counts from the C (#define).
  const MAX_TRAIL_LEN = 60;
  const MAX_BUGS = 100;
  const MAX_TARGETS = 10;
  const DESIRED_DT = 0.2;
  const CHANGE_PROB = 0.08;   // the C's hardcoded st->changeProb (never a resource)

  // Colour schemes (the C's #defines). NUM_SCHEMES=6 but the trailing two are
  // "too many schizos" and the C uses them less often. colorScheme starts at
  // COLOR_TRAILS (the C's xrayswarm_init default of 2) and auto-cycles via
  // randomSmallChange case 9 -- the port follows the C, with no scheme selector.
  const GRAY_TRAILS = 0;
  const GRAY_SCHIZO = 1;
  const COLOR_TRAILS = 2;
  const RANDOM_TRAILS = 3;
  const RANDOM_SCHIZO = 4;
  const COLOR_SCHIZO = 5;
  const NUM_SCHEMES = 6;

  // Preallocated entity pools (the C uses fixed-size arrays). Each entity holds
  // realspace pos/vel and a ring buffer of past pixel positions; `closest` is an
  // index into targets[] (the C stores a pointer).
  const bugs = new Array(MAX_BUGS);
  const targets = new Array(MAX_TARGETS);
  for (let i = 0; i < MAX_BUGS; i++) {
    bugs[i] = { pos: new Float64Array(2), vel: new Float64Array(2), hist: new Int32Array(MAX_TRAIL_LEN * 2), closest: 0 };
  }
  for (let i = 0; i < MAX_TARGETS; i++) {
    targets[i] = { pos: new Float64Array(2), vel: new Float64Array(2), hist: new Int32Array(MAX_TRAIL_LEN * 2), closest: 0 };
  }

  // Per-trail-position colour-map index tables (the C's *Index[] arrays).
  const grayIndex = new Int32Array(MAX_TRAIL_LEN);
  const redIndex = new Int32Array(MAX_TRAIL_LEN);
  const blueIndex = new Int32Array(MAX_TRAIL_LEN);
  const graySIndex = new Int32Array(MAX_TRAIL_LEN);
  const redSIndex = new Int32Array(MAX_TRAIL_LEN);
  const blueSIndex = new Int32Array(MAX_TRAIL_LEN);
  const randomIndex = new Int32Array(MAX_TRAIL_LEN);

  let S = 1;            // devicePixelRatio
  let W, H;             // canvas size, device px
  let lw;               // line width, device px
  let maxx, maxy;       // realspace extent (maxx=1, maxy=H/W)

  let cssColors;        // colour map as CSS strings (the C's colors[768])
  let numRandomColors;
  let numColors;

  // Mutable physics parameters (the C's struct state fields).
  let dt, targetVel, targetAcc, maxVel, maxAcc, noise, minVelMultiplier;
  let halfDtSq, dtInv, targetVelSq, maxVelSq, minVel, minVelSq;

  let nbugs, ntargets, trailLen;
  let head, tail, checkIndex;
  let colorScheme;      // active scheme (starts COLOR_TRAILS, auto-cycles like the C)
  let rscDepth, rbcDepth;

  function frand(x) {
    return Math.random() * x;
  }

  function irand(n) {
    return (Math.random() * n) | 0;
  }

  // ---- colour map (the C's initCMap) -------------------------------------
  function initCMap() {
    const colors = new Uint8Array(768);  // truncates-mod-256 like unsigned char
    let n = 0;

    // 0 black, 1/2/3 nominally red/green/blue (all red in the original).
    colors[n++] = 0; colors[n++] = 0; colors[n++] = 0;
    colors[n++] = 255; colors[n++] = 0; colors[n++] = 0;
    colors[n++] = 255; colors[n++] = 0; colors[n++] = 0;
    colors[n++] = 255; colors[n++] = 0; colors[n++] = 0;

    // grayscale fade, 16 levels (indices 4..19).
    for (let i = 0; i < 16; i++) {
      let t = i * 16; if (t > 255) t = 255;
      colors[n++] = 255 - t; colors[n++] = 255 - t; colors[n++] = 255 - t;
    }
    // red fade, 16 levels (indices 20..35).
    for (let i = 0; i < 16; i++) {
      let t = i * 16; if (t > 255) t = 255;
      colors[n++] = 255 - t;
      colors[n++] = 255 - Math.pow(i / 16.0 + 0.001, 0.3) * 255;
      colors[n++] = 65 - t / 4;
    }
    // blue fade, 16 levels (indices 36..51).
    for (let i = 0; i < 16; i++) {
      let t = i * 16; if (t > 255) t = 255;
      colors[n++] = 32 - t / 8;
      colors[n++] = 180 - Math.pow(i / 16.0 + 0.001, 0.3) * 180;
      colors[n++] = 255 - t;
    }

    // random colours start at 52 (the C's chained pseudo-random ramp).
    numRandomColors = MAX_TRAIL_LEN;
    colors[n] = irand(256); n++;
    colors[n] = irand(256); n++;
    colors[n] = (colors[n - 2] >> 1) + (colors[n - 3] >> 1); n++;
    for (let i = 0; i < numRandomColors; i++) {
      colors[n] = (colors[n - 3] + irand(32) - 16) & 255; n++;
      colors[n] = (colors[n - 3] + irand(32) - 16) & 255; n++;
      colors[n] = colors[n - 2] / (i + 2) + colors[n - 3] / (i + 2); n++;
    }

    numColors = ((n / 3) | 0) + 1;
    cssColors = new Array(numColors);
    for (let i = 0; i < numColors; i++) {
      cssColors[i] = `rgb(${colors[i * 3]},${colors[i * 3 + 1]},${colors[i * 3 + 2]})`;
    }
  }

  // ---- derived constants (the C's computeConstants) -----------------------
  function computeConstants() {
    halfDtSq = dt * dt * 0.5;
    dtInv = 1.0 / dt;
    targetVelSq = targetVel * targetVel;
    maxVelSq = maxVel * maxVel;
    minVel = maxVel * minVelMultiplier;
    minVelSq = minVel * minVel;
  }

  // ---- per-position colour tables (the C's computeColorIndices) -----------
  function computeColorIndices() {
    for (let i = 0; i < trailLen; i++) {
      grayIndex[trailLen - 1 - i] = Math.min(19, Math.floor(4 + i * 16.0 / trailLen + 0.5));
    }
    for (let i = 0; i < trailLen; i++) {
      redIndex[trailLen - 1 - i] = Math.min(35, Math.floor(20 + i * 16.0 / trailLen + 0.5));
    }
    for (let i = 0; i < trailLen; i++) {
      blueIndex[trailLen - 1 - i] = Math.min(51, Math.floor(36 + i * 16.0 / trailLen + 0.5));
    }
    for (let i = 0; i < trailLen; i++) {
      graySIndex[trailLen - 1 - i] = Math.min(19, Math.floor(4 + i * 16.0 / trailLen + 0.5));
    }
    for (let i = 0; i < trailLen; i++) {
      redSIndex[trailLen - 1 - i] = Math.min(35, Math.floor(20 + i * 16.0 / trailLen + 0.5));
    }
    let schizoLength = Math.floor(trailLen / 2);
    if (schizoLength < 3) schizoLength = 3;
    for (let i = 0; i < trailLen; i++) {
      blueSIndex[trailLen - 1 - i] = Math.min(51, Math.floor(36 + 16.0 * (i % schizoLength) / (schizoLength - 1.0) + 0.5));
    }
    for (let i = 0; i < trailLen; i++) {
      randomIndex[i] = 52 + irand(numRandomColors);
    }
  }

  // Collapse an entity's whole trail ring onto its current position (device px),
  // so a freshly spawned or reseeded entity draws no segment back to a stale (or
  // zero) history slot. Deviation from the C, which seeds only the head slot and
  // therefore flashes a long straight line from the old/last position for
  // ~trailLen frames after a spawn or a bug<->target mutation (most visible in
  // the first rounds, when the init shake converts bugs whose history is still
  // empty). See xrayswarm.md.
  function seedHist(b) {
    const px = b.pos[0] * W;
    const py = b.pos[1] * W;
    for (let k = 0; k < MAX_TRAIL_LEN; k++) {
      b.hist[k * 2] = px;
      b.hist[k * 2 + 1] = py;
    }
  }

  // ---- seed the swarm (the C's initBugs) ---------------------------------
  function initBugs() {
    head = 0;
    tail = 0;

    // Zero every pooled entity (the C's memset), so stale mutate copies can't
    // leave NaN/garbage behind.
    for (let i = 0; i < MAX_BUGS; i++) {
      const b = bugs[i];
      b.pos[0] = 0; b.pos[1] = 0; b.vel[0] = 0; b.vel[1] = 0; b.closest = 0;
      b.hist.fill(0);
    }
    for (let i = 0; i < MAX_TARGETS; i++) {
      const b = targets[i];
      b.pos[0] = 0; b.pos[1] = 0; b.vel[0] = 0; b.vel[1] = 0; b.closest = 0;
      b.hist.fill(0);
    }

    if (ntargets < 0) ntargets = Math.floor((0.25 + frand(0.75) * frand(1)) * MAX_TARGETS);
    if (ntargets < 1) ntargets = 1;

    if (nbugs < 0) nbugs = Math.floor((0.25 + frand(0.75) * frand(1)) * MAX_BUGS);
    if (nbugs <= ntargets) nbugs = ntargets + 1;

    if (trailLen < 0) {
      trailLen = Math.floor((1.0 - frand(0.6) * frand(1)) * MAX_TRAIL_LEN);
    }

    if (nbugs > MAX_BUGS) nbugs = MAX_BUGS;
    if (ntargets > MAX_TARGETS) ntargets = MAX_TARGETS;
    if (trailLen > MAX_TRAIL_LEN) trailLen = MAX_TRAIL_LEN;
    if (trailLen < 2) trailLen = 2;

    for (let i = 0; i < nbugs; i++) {
      const b = bugs[i];
      b.pos[0] = frand(maxx);
      b.pos[1] = frand(maxy);
      b.vel[0] = frand(maxVel / 2);
      b.vel[1] = frand(maxVel / 2);
      b.closest = irand(ntargets);
      seedHist(b);
    }

    for (let i = 0; i < ntargets; i++) {
      const b = targets[i];
      b.pos[0] = frand(maxx);
      b.pos[1] = frand(maxy);
      b.vel[0] = frand(targetVel / 2);
      b.vel[1] = frand(targetVel / 2);
      seedHist(b);
    }
  }

  function pickNewTargets() {
    for (let i = 0; i < nbugs; i++) bugs[i].closest = irand(ntargets);
  }

  function copyEntity(dst, src) {
    dst.pos[0] = src.pos[0]; dst.pos[1] = src.pos[1];
    dst.vel[0] = src.vel[0]; dst.vel[1] = src.vel[1];
    dst.closest = src.closest;
    dst.hist.set(src.hist);
  }

  // Convert a bug to a target (which=0) or a target to a bug (which=1).
  // `closest` is index-based here; the C used pointers (see xrayswarm.md).
  function mutateBug(which) {
    if (which === 0) {
      if (ntargets < MAX_TARGETS - 1 && nbugs > 1) {
        const i = irand(nbugs);
        copyEntity(targets[ntargets], bugs[i]);
        copyEntity(bugs[i], bugs[nbugs - 1]);
        targets[ntargets].pos[0] = frand(maxx);
        targets[ntargets].pos[1] = frand(maxy);
        seedHist(targets[ntargets]);   // reseed trail to the new pos (no jump line)
        nbugs--;
        ntargets++;
        for (let k = 0; k < nbugs; k += ntargets) bugs[k].closest = ntargets - 1;
      }
    } else {
      if (ntargets > 1 && nbugs < MAX_BUGS - 1) {
        const i = irand(ntargets);
        copyEntity(bugs[nbugs], targets[i]);
        ntargets--;
        bugs[nbugs].closest = irand(ntargets);
        for (let j = 0; j < nbugs; j++) {
          if (bugs[j].closest === ntargets) bugs[j].closest = i;
          else if (bugs[j].closest === i) bugs[j].closest = irand(ntargets);
        }
        nbugs++;
        copyEntity(targets[i], targets[ntargets]);
      }
    }
  }

  function mutateParam(v) {
    return v * (0.75 + frand(0.5));
  }

  // ---- parameter wander (the C's randomSmallChange) ----------------------
  function randomSmallChange() {
    const whichCase = irand(11);
    if (++rscDepth > 10) { rscDepth--; return; }

    switch (whichCase) {
      case 0: maxAcc = mutateParam(maxAcc); break;
      case 1: targetAcc = mutateParam(targetAcc); break;
      case 2: maxVel = mutateParam(maxVel); break;
      case 3: targetVel = mutateParam(targetVel); break;
      case 4: noise = mutateParam(noise); break;
      case 5: minVelMultiplier = mutateParam(minVelMultiplier); break;
      case 6:
      case 7:
        if (ntargets < 2) break;
        mutateBug(1);
        break;
      case 8:
        if (nbugs < 2) break;
        mutateBug(0);
        if (nbugs < 2) break;
        mutateBug(0);
        break;
      case 9:
        colorScheme = irand(NUM_SCHEMES);
        if (colorScheme === RANDOM_SCHIZO || colorScheme === COLOR_SCHIZO) {
          colorScheme = irand(NUM_SCHEMES);
        }
        break;
      default:
        randomSmallChange();
        randomSmallChange();
        randomSmallChange();
        randomSmallChange();
    }

    if (minVelMultiplier < 0.3) minVelMultiplier = 0.3;
    else if (minVelMultiplier > 0.9) minVelMultiplier = 0.9;
    if (noise < 0.01) noise = 0.01;
    if (maxVel < 0.02) maxVel = 0.02;
    if (targetVel < 0.02) targetVel = 0.02;
    if (targetAcc > targetVel * 0.7) targetAcc = targetVel * 0.7;
    if (maxAcc > maxVel * 0.7) maxAcc = maxVel * 0.7;
    if (targetAcc > targetVel * 0.7) targetAcc = targetVel * 0.7;
    if (maxAcc < 0.01) maxAcc = 0.01;
    if (targetAcc < 0.005) targetAcc = 0.005;

    computeConstants();
    rscDepth--;
  }

  // ---- bigger shake-ups (the C's randomBigChange) ------------------------
  function randomBigChange() {
    const whichCase = irand(4);
    if (++rbcDepth > 3) { rbcDepth--; return; }

    switch (whichCase) {
      case 0:
        // New trail length, then reseed (the C clears first; we redraw fresh).
        trailLen = irand(MAX_TRAIL_LEN - 25) + 25;
        computeColorIndices();
        initBugs();
        break;
      case 1:
        randomSmallChange();
        randomSmallChange();
        randomSmallChange();
        randomSmallChange();
        randomSmallChange();
        randomSmallChange();
        randomSmallChange();
        randomSmallChange();
        break;
      case 2:
        initBugs();
        break;
      case 3:
        pickNewTargets();
        break;
    }

    rbcDepth--;
  }

  // Reflect a position back into [0,maxx) x [0,maxy), reversing the velocity.
  function bounce(b) {
    if (b.pos[0] < 0) { b.pos[0] = -b.pos[0]; b.vel[0] = -b.vel[0]; }
    else if (b.pos[0] >= maxx) { b.pos[0] = 2 * maxx - b.pos[0]; b.vel[0] = -b.vel[0]; }
    if (b.pos[1] < 0) { b.pos[1] = -b.pos[1]; b.vel[1] = -b.vel[1]; }
    else if (b.pos[1] >= maxy) { b.pos[1] = 2 * maxy - b.pos[1]; b.vel[1] = -b.vel[1]; }
  }

  // ---- one simulation step (the C's updateState) -------------------------
  function step() {
    head = (head + 1) % trailLen;
    // Drop the oldest stored point once the ring buffer is full (the C does this
    // tail advance inside drawBugs; doing it here keeps head/tail in lockstep
    // even when the rAF loop runs several steps between draws).
    if (((head + 1) % trailLen) === tail) tail = (tail + 1) % trailLen;

    // Re-evaluate the closest target for 5 bugs per step (round-robin). The
    // hysteresis (theta < temp*2) makes bugs fickle, which keeps the swarm
    // churning rather than collapsing onto one target.
    for (let j = 0; j < 5; j++) {
      checkIndex = (checkIndex + 1) % nbugs;
      const b = bugs[checkIndex];
      let c = targets[b.closest];
      let ax = c.pos[0] - b.pos[0];
      let ay = c.pos[1] - b.pos[1];
      let temp = ax * ax + ay * ay;
      for (let i = 0; i < ntargets; i++) {
        if (i === b.closest) continue;
        const b2 = targets[i];
        ax = b2.pos[0] - b.pos[0];
        ay = b2.pos[1] - b.pos[1];
        const theta = ax * ax + ay * ay;
        if (theta < temp * 2) {
          b.closest = i;
          temp = theta;
        }
      }
    }

    // Targets: random-walk acceleration, speed clamp, integrate, bounce.
    for (let i = 0; i < ntargets; i++) {
      const b = targets[i];
      const theta = frand(6.28);
      let ax = targetAcc * Math.cos(theta);
      let ay = targetAcc * Math.sin(theta);
      b.vel[0] += ax * dt;
      b.vel[1] += ay * dt;

      let temp = b.vel[0] * b.vel[0] + b.vel[1] * b.vel[1];
      if (temp > targetVelSq) {
        temp = targetVel / Math.sqrt(temp);
        ax = b.vel[0]; ay = b.vel[1];
        b.vel[0] *= temp; b.vel[1] *= temp;
        ax = (b.vel[0] - ax) * dtInv;
        ay = (b.vel[1] - ay) * dtInv;
      }

      b.pos[0] += b.vel[0] * dt + ax * halfDtSq;
      b.pos[1] += b.vel[1] * dt + ay * halfDtSq;
      bounce(b);

      b.hist[head * 2] = b.pos[0] * W;
      b.hist[head * 2 + 1] = b.pos[1] * W;
    }

    // Bugs: accelerate toward closest target (with noise), clamp speed both
    // high and low, integrate, bounce.
    for (let i = 0; i < nbugs; i++) {
      const b = bugs[i];
      const c = targets[b.closest];
      const theta = Math.atan2(
        c.pos[1] - b.pos[1] + frand(noise),
        c.pos[0] - b.pos[0] + frand(noise),
      );
      let ax = maxAcc * Math.cos(theta);
      let ay = maxAcc * Math.sin(theta);
      b.vel[0] += ax * dt;
      b.vel[1] += ay * dt;

      let temp = b.vel[0] * b.vel[0] + b.vel[1] * b.vel[1];
      if (temp > maxVelSq) {
        temp = maxVel / Math.sqrt(temp);
        ax = b.vel[0]; ay = b.vel[1];
        b.vel[0] *= temp; b.vel[1] *= temp;
        ax = (b.vel[0] - ax) * dtInv;
        ay = (b.vel[1] - ay) * dtInv;
      } else if (temp < minVelSq && temp > 1e-12) {
        // Boost too-slow bugs up to minVel. Guard temp>0 so we never divide by
        // zero into NaN (the C relies on floats rarely being exactly 0).
        temp = minVel / Math.sqrt(temp);
        ax = b.vel[0]; ay = b.vel[1];
        b.vel[0] *= temp; b.vel[1] *= temp;
        ax = (b.vel[0] - ax) * dtInv;
        ay = (b.vel[1] - ay) * dtInv;
      }

      b.pos[0] += b.vel[0] * dt + ax * halfDtSq;
      b.pos[1] += b.vel[1] * dt + ay * halfDtSq;
      bounce(b);

      b.hist[head * 2] = b.pos[0] * W;
      b.hist[head * 2 + 1] = b.pos[1] * W;
    }
  }

  // Resolve the active colour scheme into the index tables / start offsets the
  // C's updateColorIndex picks (targets and bugs can differ).
  function getScheme() {
    const s = colorScheme;   // the C switches on st->colorScheme (auto-cycled)
    switch (s) {
      case GRAY_TRAILS:
        return { tIdx: grayIndex, tci0: 0, tnc: trailLen, cIdx: grayIndex, ci0: 0, nc: trailLen };
      case GRAY_SCHIZO:
        return { tIdx: graySIndex, tci0: head, tnc: trailLen, cIdx: graySIndex, ci0: head, nc: trailLen };
      case RANDOM_TRAILS:
        return { tIdx: redIndex, tci0: 0, tnc: trailLen, cIdx: randomIndex, ci0: 0, nc: trailLen };
      case RANDOM_SCHIZO:
        return { tIdx: redIndex, tci0: head, tnc: trailLen, cIdx: randomIndex, ci0: head, nc: trailLen };
      case COLOR_SCHIZO:
        return { tIdx: redSIndex, tci0: head, tnc: trailLen, cIdx: blueSIndex, ci0: head, nc: trailLen };
      case COLOR_TRAILS:
      default:
        return { tIdx: redIndex, tci0: 0, tnc: trailLen, cIdx: blueIndex, ci0: 0, nc: trailLen };
    }
  }

  // ---- render the current trails (the C's drawBugs, redrawn fresh) -------
  function draw() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (head === tail) return;  // ring buffer empty: nothing to connect yet

    const sc = getScheme();
    const paths = [];   // Path2D per colour-map index
    const used = [];

    function pathFor(idx) {
      let p = paths[idx];
      if (!p) { p = new Path2D(); paths[idx] = p; used.push(idx); }
      return p;
    }

    // Bug trails. ci0 walks the colour table from tail to head so each segment
    // fades from dark (tail) to bright (head).
    let ci = sc.ci0;
    for (let j = tail; j !== head; j = (j + 1) % trailLen) {
      const jn = (j + 1) % trailLen;
      const p = pathFor(sc.cIdx[ci]);
      const a = j * 2;
      const c = jn * 2;
      for (let i = 0; i < nbugs; i++) {
        const h = bugs[i].hist;
        p.moveTo(h[a], h[a + 1]);
        p.lineTo(h[c], h[c + 1]);
      }
      ci = (ci + 1) % sc.nc;
    }

    // Target trails.
    let tci = sc.tci0;
    for (let j = tail; j !== head; j = (j + 1) % trailLen) {
      const jn = (j + 1) % trailLen;
      const p = pathFor(sc.tIdx[tci]);
      const a = j * 2;
      const c = jn * 2;
      for (let i = 0; i < ntargets; i++) {
        const h = targets[i].hist;
        p.moveTo(h[a], h[a + 1]);
        p.lineTo(h[c], h[c + 1]);
      }
      tci = (tci + 1) % sc.tnc;
    }

    ctx.lineWidth = lw;
    for (let k = 0; k < used.length; k++) {
      const idx = used[k];
      ctx.strokeStyle = cssColors[idx];
      ctx.stroke(paths[idx]);
    }
  }

  function init() {
    S = window.devicePixelRatio || 1;
    W = canvas.width;
    H = canvas.height;
    maxx = 1.0;
    maxy = H / W;
    // The C uses a 1px line, or 3px on Retina (> 2560px); hist coords are
    // already in device px (scaled by W), so no extra dpr multiply is needed.
    lw = (W > 2560 || H > 2560) ? 3 : 1;

    // Base physics (the C's xrayswarm_init). The C runs at dt=0.1 in steady
    // state (DESIRED_DT/2 with delay>0); we use that consistently from the
    // start. See xrayswarm.md.
    dt = DESIRED_DT / 2;
    targetVel = 0.03;
    targetAcc = 0.02;
    maxVel = 0.05;
    maxAcc = 0.03;
    noise = 0.01;
    minVelMultiplier = 0.5;
    colorScheme = COLOR_TRAILS;   // the C's xrayswarm_init default (2); then auto-cycles
    rscDepth = 0;
    rbcDepth = 0;
    checkIndex = 0;

    // -1 sentinels: initBugs() auto-randomizes counts/trail exactly like the C
    // (the C never exposed these as resources).
    nbugs = -1;
    ntargets = -1;
    trailLen = -1;

    initCMap();
    computeConstants();
    initBugs();
    computeColorIndices();

    // Initial parameter shake (the C's init loop of random%5+5 small changes;
    // the C gates this on changeProb > 0, which is always true at 0.08).
    for (let i = irand(5) + 5; i >= 0; i--) randomSmallChange();

    // Pre-run a few steps so the very first drawn frame already shows short
    // trails (a single stored point draws nothing), then paint that frame.
    const warm = Math.min(10, trailLen - 1);
    for (let i = 0; i < warm; i++) step();
    draw();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    init();
  }

  // rAF lag-accumulator paced by config.delay (microseconds); see squiral.js.
  // Heavy work is in step()/draw(), so we step up to the cap then draw once.
  //
  // OVERHEAD: the stock delay is a sleep floor; the live binary's real rate is
  // lower (delay + framework overhead -- see the framerate-calibration note).
  // Measured against the live `-fps` overlay xrayswarm runs 33.4 fps, while the
  // port at the stock 20000 us ran ~50 steps/sec (1.5x fast). 20000 + 9940 =
  // 29940 us -> 33.4 steps/sec, matching the live binary. A calibration, not a
  // tuning knob (the delay slider still maps 1:1 to the xml resource).
  const OVERHEAD = 9940;
  const MAX_CATCHUP_STEPS = 4;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;
  let changeTimer = 0;  // real-time anchor for the ~0.5s mutation cadence

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    lastTime = now;

    const delayMs = (config.delay + OVERHEAD) / 1000;
    lag = Math.min(lag, delayMs * MAX_CATCHUP_STEPS);

    let steps = 0;
    let stepped = false;
    while (lag >= delayMs && steps < MAX_CATCHUP_STEPS) {
      step();
      lag -= delayMs;
      steps++;
      stepped = true;
    }

    // Parameter mutations on a ~0.5s real-time cadence (the C's gettimeofday
    // path), so they don't depend on the frame rate.
    if (changeTimer === 0) changeTimer = now;
    if (now - changeTimer >= 500) {
      changeTimer = now;
      if (frand(1) < CHANGE_PROB) randomSmallChange();
      if (frand(1) < CHANGE_PROB * 0.3) randomBigChange();
    }

    if (stepped) draw();
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
    resume() { if (!rafId) { lastTime = 0; changeTimer = 0; rafId = requestAnimationFrame(frame); } },
    reinit,
    config,
    params,
  };
}
