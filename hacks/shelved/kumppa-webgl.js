// kumppa-webgl.js -- EXPLORATORY WebGL2 proof-of-concept port of kumppa.
// start(canvas) returns { stop, pause, resume, reinit, config, params, getStats }.
//
// THIS IS A PARALLEL STAB. It does NOT replace hacks/kumppa.js and is NOT
// registered in host.js / catalog.json. The faithful, shipped port is the
// canvas one (hacks/kumppa.js); this file exists only to PROVE that kumppa's
// framebuffer feedback can run at full device resolution on the GPU.
//
// WHY: hacks/kumppa.js reproduces kumppa.c's feedback faithfully by replaying
// every block of the sheared self-copy as its own ctx.drawImage from a frozen
// snapshot -- ~6,500 block-copies PER FRAME at the capped resolution, and
// ~30,000+ at full 4K. That count scales with W*H, which is why the canvas port
// caps the backing store on Retina. The block-copies are all the SAME operation
// (sample the previous frame at a sheared offset), so on a GPU they collapse
// into ONE batched draw of textured quads against a ping-pong feedback texture
// -> full device resolution, no cap. This file demonstrates exactly that.
//
// WHAT IS REUSED VERBATIM FROM hacks/kumppa.js (the load-bearing logic):
//   - make_rots() / rotate() / palaRotate(): the column/row void-and-cluster
//     dithering tables and the per-frame block grid + (du-dv, du+dv) shear and
//     screen-clip arithmetic. Transcribed integer-for-integer. The ONLY change
//     is palaRotate's body: instead of ctx.drawImage(scratch, src, dst) it emits
//     one textured quad (src rect -> dst rect) into a vertex buffer.
//   - the cosinus[8][6] oscillator table, the cosi-line endpoint walk, the
//     random-splat fallback, the central black stamp, buildColors()'s
//     hue-DECREASING ramp, and the defaults (delay 20000, speed 0.1, random
//     true, ncolors 32).
//
// WHAT IS NEW (the GL pipeline):
//   Two RGBA8 textures A/B + framebuffers at full DEVICE px (no cap), NEAREST
//   filtering (XCopyArea never interpolates). Per frame, with SOURCE = previous
//   frame and TARGET = this frame:
//     1. Draw this step's marks (cosi-lines / splats + central black stamp) INTO
//        SOURCE. This makes the marks part of the source that gets sheared THIS
//        frame -- faithful to kumppa.c, where rotate() copies win[0] (which
//        already holds the freshly drawn marks). No 1-frame lag.
//     2. Blit SOURCE -> TARGET 1:1 (so pixels NOT covered by any sheared block
//        keep the previous frame, exactly as the C's in-place self-copy leaves
//        untouched pixels alone -- avoids 2-frames-ago ping-pong bleed in the
//        thin edge strips the shear rotates in from off-screen).
//     3. Draw ALL block quads in ONE drawArrays into TARGET, sampling SOURCE.
//        <-- this single call replaces the canvas port's ~6,500 drawImage calls.
//     4. Blit TARGET -> the visible canvas (default framebuffer), flipped so the
//        y-down image space reads upright.
//     5. Swap SOURCE <-> TARGET.
//   NO blending anywhere (gl.disable(BLEND)): every draw OVERWRITES, matching
//   X11's GXcopy XCopyArea / XFillRectangle and the canvas port's opaque
//   drawImage. The black stamp must paint solid black, not blend.
//
//   Coordinate convention: all FBO work is in y-DOWN pixel space (texel row
//   index == pixel y), so the transcribed shear math (which is y-down, like the
//   C) is used UNCHANGED for both the dest position and the src texcoord. Only
//   the final blit-to-screen flips Y to display upright.
//
// Like the other GL hacks here (see hacks/shadertoy.js), we overlay our OWN
// canvas and take 'webgl2' on IT, never on the passed-in host canvas (which the
// host locks to a 2D context). For this standalone PoC the passed canvas is just
// the mount point / parent.

export const title = 'kumppa (WebGL PoC)';

export const info = {
  author: 'Teemu Suutari',
  description: 'Spiraling splashes of color -- WebGL2 feedback proof-of-concept (batched).',
  year: 1998,
};

export function start(hostCanvas) {
  // Our own GL canvas, laid exactly over the host canvas (mirrors shadertoy.js).
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed; inset:0; width:100%; height:100%; z-index:1; pointer-events:none; background:#000;';
  (hostCanvas.parentNode || document.body).appendChild(canvas);

  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });

  if (!gl) {
    console.error('kumppa-webgl: WebGL2 is required but unavailable.');
    return { stop() { canvas.remove(); }, pause() {}, resume() {}, reinit() {}, config: {}, params: [] };
  }

  // ---- config / params: identical to hacks/kumppa.js -------------------------
  const config = {
    delay: 20000,      // micro-seconds between steps
    speed: 0.10,       // per-step spin rate, 0.0001..0.2 ("Density")
    random: true,      // true = smooth cosi-lines, false = random splats
    ncolors: 32,       // size of the hue ramp the marks cycle through
  };

  const params = [
    { key: 'delay', label: 'Frame rate', type: 'range', min: 0, max: 100000, step: 1000, default: 20000, unit: ' \u00B5s', invert: true, lowLabel: 'low', highLabel: 'high', live: true },
    { key: 'speed', label: 'Density', type: 'range', min: 0.0001, max: 0.2, step: 0.0001, default: 0.10, lowLabel: 'slow', highLabel: 'fast', live: true },
    { key: 'random', label: 'Smooth lines', type: 'checkbox', default: true, live: false },
    { key: 'ncolors', label: 'Colors', type: 'range', min: 2, max: 255, step: 1, default: 32, lowLabel: 'few', highLabel: 'many', live: false },
  ];

  // cosinus[8][6] -- verbatim from kumppa.js / kumppa.c.
  const COSINUS = [
    [-0.07, 0.12, -0.06, 32, 25, 37],
    [0.08, -0.03, 0.05, 51, 46, 32],
    [0.12, 0.07, -0.13, 27, 45, 36],
    [0.05, -0.04, -0.07, 36, 27, 39],
    [-0.02, -0.07, 0.1, 21, 43, 42],
    [-0.11, 0.06, 0.02, 51, 25, 34],
    [0.04, -0.15, 0.02, 42, 32, 25],
    [-0.02, -0.04, -0.13, 34, 20, 15],
  ];

  let S = 1;               // effective backing px per CSS px (== dpr; no cap)
  let W, H;                // canvas size, device px (FULL resolution)
  let cx, cy;              // center, device px
  let colors;              // ncolors entries, each [r,g,b] in 0..1
  let pscale;              // mark line width / box size

  // Feedback state -- C names kept (midx,midy == cx,cy; sizx,sizy == W,H).
  let sizx, sizy, midx, midy;
  let Xrotations, Yrotations;
  let Xrottable, Yrottable;
  let rotateX, rotateY;
  let rotsizeX, rotsizeY;
  let stateX, stateY;
  let rx, ry;
  let builtSpeed = -1;

  // cosi-line oscillator state.
  let acos, coords, ocoords, drawCount;

  // ---- color ramp (hue-DECREASING from blue), as RGB floats ------------------
  function hslToRgb(h, s, l) {
    // h in [0,360), s,l in [0,1]. Returns [r,g,b] in 0..1.
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    const m = l - c / 2;
    return [r + m, g + m, b + m];
  }

  function buildColors() {
    const n = Math.max(2, Math.round(config.ncolors));
    colors = new Array(n);
    for (let i = 0; i < n; i++) {
      const hue = ((240 - i * 360 / n) % 360 + 360) % 360;   // sweep DOWN from blue
      colors[i] = hslToRgb(hue, 1, 0.5);
    }
  }

  // ---- GL helpers ------------------------------------------------------------
  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('kumppa-webgl shader compile failed:\n' + log);
    }
    return sh;
  }

  function link(vsSrc, fsSrc) {
    const p = gl.createProgram();
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('kumppa-webgl link failed:\n' + log);
    }
    return p;
  }

  // Feedback: textured quads (dest pixels sampling src texcoords), y-down.
  const fbProg = link(
    `#version 300 es
     precision highp float;
     layout(location=0) in vec2 aPos;   // dest pixel coords (y-down)
     layout(location=1) in vec2 aUV;    // src texcoord [0,1]
     uniform vec2 uRes;
     out vec2 vUV;
     void main(){
       gl_Position = vec4((aPos / uRes) * 2.0 - 1.0, 0.0, 1.0);
       vUV = aUV;
     }`,
    `#version 300 es
     precision highp float;
     uniform sampler2D uSrc;
     in vec2 vUV;
     out vec4 o;
     void main(){ o = vec4(texture(uSrc, vUV).rgb, 1.0); }`,
  );
  const fbU = { res: gl.getUniformLocation(fbProg, 'uRes'), src: gl.getUniformLocation(fbProg, 'uSrc') };

  // Marks: solid colored quads, y-down pixel coords.
  const mkProg = link(
    `#version 300 es
     precision highp float;
     layout(location=0) in vec2 aPos;
     layout(location=1) in vec4 aColor;
     uniform vec2 uRes;
     out vec4 vColor;
     void main(){
       gl_Position = vec4((aPos / uRes) * 2.0 - 1.0, 0.0, 1.0);
       vColor = aColor;
     }`,
    `#version 300 es
     precision highp float;
     in vec4 vColor;
     out vec4 o;
     void main(){ o = vColor; }`,
  );
  const mkU = { res: gl.getUniformLocation(mkProg, 'uRes') };

  // Blit: full-screen triangle from gl_VertexID, optional Y flip.
  const blitProg = link(
    `#version 300 es
     precision highp float;
     out vec2 vUV;
     void main(){
       vec2 v = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);  // (0,0)(2,0)(0,2)
       gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
       vUV = v;
     }`,
    `#version 300 es
     precision highp float;
     uniform sampler2D uTex;
     uniform bool uFlipY;
     in vec2 vUV;
     out vec4 o;
     void main(){
       vec2 uv = vUV;
       if (uFlipY) uv.y = 1.0 - uv.y;
       o = vec4(texture(uTex, uv).rgb, 1.0);
     }`,
  );
  const blitU = { tex: gl.getUniformLocation(blitProg, 'uTex'), flip: gl.getUniformLocation(blitProg, 'uFlipY') };

  // Dynamic vertex buffers + VAOs.
  const fbVbo = gl.createBuffer();
  const fbVao = gl.createVertexArray();
  gl.bindVertexArray(fbVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, fbVbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);   // aPos
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);   // aUV

  const mkVbo = gl.createBuffer();
  const mkVao = gl.createVertexArray();
  gl.bindVertexArray(mkVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, mkVbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);   // aPos
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);   // aColor

  const emptyVao = gl.createVertexArray();   // for the attribute-less blit
  gl.bindVertexArray(null);

  // Ping-pong color targets.
  let texA, texB, fboA, fboB;
  function makeTarget() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f };
  }
  function clearFbo(f) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // SOURCE = previous frame, TARGET = this frame. Swapped each step.
  let src, tgt;

  // ---- make_rots / rotate / palaRotate -- transcribed from kumppa.js ---------
  // (palaRotate emits a quad instead of drawImage; rotate() no longer snapshots.)

  function makeRots(xspeed, yspeed) {
    let a, b, c, f, g, j, k = 0, l;
    let m, om, ok;
    let d, ix, iy;
    let maxi;

    rotsizeX = Math.trunc(2 / xspeed + 1);
    ix = (midx + 1) / rotsizeX;
    rotsizeY = Math.trunc(2 / yspeed + 1);
    iy = (midy + 1) / rotsizeY;

    Xrotations = new Int32Array(midx + 2);
    Xrottable = new Int32Array(rotsizeX + 1);
    Yrotations = new Int32Array(midy + 2);
    Yrottable = new Int32Array(rotsizeY + 1);
    const chks = new Uint8Array((midx > midy) ? midx : midy);

    maxi = 0; c = 0; d = 0; g = 0;
    for (a = 0; a < midx; a++) chks[a] = 1;
    for (a = 0; a < rotsizeX; a++) {
      Xrottable[a] = c;
      f = Math.trunc(d + ix) - g;
      g += f;
      if (g > midx) { f -= g - midx; g = midx; }
      for (b = 0; b < f; b++) {
        m = 0;
        for (j = 0; j < midx; j++) {
          if (chks[j]) {
            om = 0; ok = 1; l = 0;
            while (j + l < midx && om + 12 * ok > m) {
              if (j - l >= 0) { if (chks[j - l]) om += ok; }
              else { if (chks[l - j]) om += ok; }
              if (chks[j + l]) om += ok;
              ok /= 1.5;
              l++;
            }
            if (om >= m) { k = j; m = om; }
          }
        }
        chks[k] = 0;
        l = c;
        while (l >= Xrottable[a]) {
          if (l != Xrottable[a]) Xrotations[l] = Xrotations[l - 1];
          if (k > Xrotations[l] || l == Xrottable[a]) {
            Xrotations[l] = k;
            c++;
            l = Xrottable[a];
          }
          l--;
        }
      }
      d += ix;
      if (maxi < c - Xrottable[a]) maxi = c - Xrottable[a];
    }
    Xrottable[a] = c;
    rotateX = new Int32Array((maxi + 2) << 1);

    maxi = 0; c = 0; d = 0; g = 0;
    for (a = 0; a < midy; a++) chks[a] = 1;
    for (a = 0; a < rotsizeY; a++) {
      Yrottable[a] = c;
      f = Math.trunc(d + iy) - g;
      g += f;
      if (g > midy) { f -= g - midy; g = midy; }
      for (b = 0; b < f; b++) {
        m = 0;
        for (j = 0; j < midy; j++) {
          if (chks[j]) {
            om = 0; ok = 1; l = 0;
            while (j + l < midy && om + 12 * ok > m) {
              if (j - l >= 0) { if (chks[j - l]) om += ok; }
              else { if (chks[l - j]) om += ok; }
              if (chks[j + l]) om += ok;
              ok /= 1.5;
              l++;
            }
            if (om >= m) { k = j; m = om; }
          }
        }
        chks[k] = 0;
        l = c;
        while (l >= Yrottable[a]) {
          if (l != Yrottable[a]) Yrotations[l] = Yrotations[l - 1];
          if (k > Yrotations[l] || l == Yrottable[a]) {
            Yrotations[l] = k;
            c++;
            l = Yrottable[a];
          }
          l--;
        }
      }
      d += iy;
      if (maxi < c - Yrottable[a]) maxi = c - Yrottable[a];
    }
    Yrottable[a] = c;
    rotateY = new Int32Array((maxi + 2) << 1);
  }

  function ensureRots() {
    const speed = Math.min(0.2, Math.max(0.0001, config.speed));
    if (speed !== builtSpeed) {
      makeRots(speed, speed);
      builtSpeed = speed;
      stateX = 0;
      stateY = 0;
    }
  }

  // The single per-frame feedback vertex buffer (grows as needed). 6 verts/quad,
  // 4 floats/vert (x,y,u,v) -> 24 floats/quad.
  let vbuf = new Float32Array(4096 * 24);
  let vcount = 0;   // floats used

  function pushQuad(dcx, dcy, w, h, ax, ay) {
    if (vcount + 24 > vbuf.length) {
      const grown = new Float32Array(vbuf.length * 2);
      grown.set(vbuf);
      vbuf = grown;
    }
    const u0 = ax / W, u1 = (ax + w) / W;
    const v0 = ay / H, v1 = (ay + h) / H;
    const x0 = dcx, x1 = dcx + w, y0 = dcy, y1 = dcy + h;
    const b = vbuf;
    let i = vcount;
    b[i++] = x0; b[i++] = y0; b[i++] = u0; b[i++] = v0;
    b[i++] = x1; b[i++] = y0; b[i++] = u1; b[i++] = v0;
    b[i++] = x0; b[i++] = y1; b[i++] = u0; b[i++] = v1;
    b[i++] = x1; b[i++] = y0; b[i++] = u1; b[i++] = v0;
    b[i++] = x1; b[i++] = y1; b[i++] = u1; b[i++] = v1;
    b[i++] = x0; b[i++] = y1; b[i++] = u0; b[i++] = v1;
    vcount = i;
  }

  // palaRotate: same clip arithmetic as kumppa.js; emits a quad (src->dst).
  function palaRotate(x, y) {
    let ax = rotateX[x];
    let ay = rotateY[y];
    let bx = rotateX[x + 1] + 2;
    let by = rotateY[y + 1] + 2;
    let dcx = rotateX[x] - (y - ry) + x - rx;
    let dcy = rotateY[y] + (x - rx) + y - ry;
    if (dcx < 0) { ax -= dcx; dcx = 0; }
    if (dcy < 0) { ay -= dcy; dcy = 0; }
    if (dcx + bx - ax > sizx) bx = ax - dcx + sizx;
    if (dcy + by - ay > sizy) by = ay - dcy + sizy;
    if (ax < bx && ay < by) {
      pushQuad(dcx, dcy, bx - ax, by - ay, ax, ay);
    }
  }

  // rotate: build this frame's block quads (verbatim grid math), advance state.
  function buildRotateQuads() {
    let x, y, dx, dy;
    vcount = 0;

    rx = Xrottable[stateX + 1] - Xrottable[stateX];
    ry = Yrottable[stateY + 1] - Yrottable[stateY];

    for (x = 0; x <= rx; x++)
      rotateX[x] = x ? midx - 1 - Xrotations[Xrottable[stateX + 1] - x] : 0;
    for (x = 0; x <= rx; x++)
      rotateX[x + rx + 1] = (x == rx) ? sizx - 1 : midx + Xrotations[Xrottable[stateX] + x];
    for (y = 0; y <= ry; y++)
      rotateY[y] = y ? midy - 1 - Yrotations[Yrottable[stateY + 1] - y] : 0;
    for (y = 0; y <= ry; y++)
      rotateY[y + ry + 1] = (y == ry) ? sizy - 1 : midy + Yrotations[Yrottable[stateY] + y];

    x = (rx > ry) ? rx : ry;
    for (dy = 0; dy < ((x + 1) << 1); dy++)
      for (dx = 0; dx < ((x + 1) << 1); dx++) {
        y = (rx > ry) ? ry - rx : 0;
        if (dy + y >= 0 && dy < ((ry + 1) << 1) && dx < ((rx + 1) << 1))
          if (dy + y + dx <= ry + rx && dy + y - dx <= ry - rx) {
            palaRotate((rx << 1) + 1 - dx, dy + y);
            palaRotate(dx, (ry << 1) + 1 - dy - y);
          }
        y = (ry > rx) ? rx - ry : 0;
        if (dy + y >= 0 && dx < ((ry + 1) << 1) && dy < ((rx + 1) << 1))
          if (dy + y + dx <= ry + rx && dx - dy - y >= ry - rx) {
            palaRotate(dy + y, dx);
            palaRotate((rx << 1) + 1 - dy - y, (ry << 1) + 1 - dx);
          }
      }
    stateX++;
    if (stateX == rotsizeX) stateX = 0;
    stateY++;
    if (stateY == rotsizeY) stateY = 0;
  }

  // ---- marks (drawn INTO the source fbo, sheared this same frame) ------------
  let mbuf = new Float32Array(64 * 24);   // 6 verts * 6 floats * up to ~16 quads
  let mcount = 0;

  function pushColoredRect(px, py, w, h, r, g, b, a) {
    if (mcount + 36 > mbuf.length) {
      const grown = new Float32Array(mbuf.length * 2);
      grown.set(mbuf);
      mbuf = grown;
    }
    const x0 = px, x1 = px + w, y0 = py, y1 = py + h;
    const m = mbuf;
    let i = mcount;
    const v = (vx, vy) => { m[i++] = vx; m[i++] = vy; m[i++] = r; m[i++] = g; m[i++] = b; m[i++] = a; };
    v(x0, y0); v(x1, y0); v(x0, y1);
    v(x1, y0); v(x1, y1); v(x0, y1);
    mcount = i;
  }

  // A thick line as an oriented quad (square caps extended by half-width); the
  // round caps of the canvas ctx.stroke are visually negligible at these widths.
  function pushColoredLine(x0, y0, x1, y1, width, r, g, b, a) {
    let dxv = x1 - x0, dyv = y1 - y0;
    const len = Math.hypot(dxv, dyv) || 1;
    dxv /= len; dyv /= len;
    const hw = width * 0.5 + 0.5;          // +0.5 px so 1-px lines stay solid
    const nx = -dyv * hw, ny = dxv * hw;   // normal
    const ex = dxv * hw, ey = dyv * hw;    // cap extension
    const ax = x0 - ex, ay = y0 - ey;
    const bx = x1 + ex, by = y1 + ey;
    if (mcount + 36 > mbuf.length) {
      const grown = new Float32Array(mbuf.length * 2);
      grown.set(mbuf);
      mbuf = grown;
    }
    const m = mbuf;
    let i = mcount;
    const v = (vx, vy) => { m[i++] = vx; m[i++] = vy; m[i++] = r; m[i++] = g; m[i++] = b; m[i++] = a; };
    v(ax + nx, ay + ny); v(bx + nx, by + ny); v(ax - nx, ay - ny);
    v(bx + nx, by + ny); v(bx - nx, by - ny); v(ax - nx, ay - ny);
    mcount = i;
  }

  function buildCosiLines() {
    drawCount++;
    for (let a = 0; a < 8; a++) {
      let f = 0;
      for (let b = 0; b < 3; b++) {
        acos[a * 3 + b] += COSINUS[a][b];
        f += COSINUS[a][b + 3] * Math.sin(acos[a * 3 + b]);
      }
      coords[a] = f * S;
    }
    const lw = Math.max(1, pscale);
    for (let a = 0; a < 4; a++) {
      const idx = (((a << 2) + drawCount) % colors.length + colors.length) % colors.length;
      const [r, g, b] = colors[idx];
      pushColoredLine(
        cx + ocoords[a << 1], cy + ocoords[(a << 1) + 1],
        cx + coords[a << 1], cy + coords[(a << 1) + 1],
        lw, r, g, b, 1,
      );
      ocoords[a << 1] = coords[a << 1];
      ocoords[(a << 1) + 1] = coords[(a << 1) + 1];
    }
  }

  function buildSplats() {
    const box = 2 * pscale;
    const reach = 16 * S;
    for (let e = 0; e < 8; e++) {
      const a = Math.floor(Math.random() * 50);
      const bx = cx - reach + Math.floor(Math.random() * (32 * S));
      const by = cy - reach + Math.floor(Math.random() * (32 * S));
      if (a >= 32) {
        pushColoredRect(bx, by, box, box, 0, 0, 0, 1);   // fgc[32] == black
      } else {
        const [r, g, b] = colors[a % colors.length];
        pushColoredRect(bx, by, box, box, r, g, b, 1);
      }
    }
  }

  function buildMarks() {
    mcount = 0;
    if (config.random) buildCosiLines();
    else buildSplats();
    // central black stamp (4*pscale square, so the core never bakes solid).
    const k = 4 * pscale;
    pushColoredRect(cx - 2 * pscale, cy - 2 * pscale, k, k, 0, 0, 0, 1);
  }

  // ---- one step --------------------------------------------------------------
  let drawCalls = 0;        // GL draw calls in the last step (for getStats)
  let feedbackQuads = 0;    // block quads in the last step

  function step() {
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    // 1. marks -> SOURCE (so they shear THIS frame, faithful to kumppa.c).
    buildMarks();
    gl.bindFramebuffer(gl.FRAMEBUFFER, src.f);
    gl.viewport(0, 0, W, H);
    gl.useProgram(mkProg);
    gl.uniform2f(mkU.res, W, H);
    gl.bindVertexArray(mkVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, mkVbo);
    gl.bufferData(gl.ARRAY_BUFFER, mbuf.subarray(0, mcount), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, mcount / 6);
    let calls = 1;

    // 2 + 3. shear SOURCE -> TARGET: pre-blit (untouched pixels) then all blocks.
    ensureRots();
    buildRotateQuads();
    feedbackQuads = vcount / 24;

    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.f);
    gl.viewport(0, 0, W, H);

    // pre-blit SOURCE -> TARGET 1:1 (no flip) so non-covered pixels persist.
    gl.useProgram(blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.t);
    gl.uniform1i(blitU.tex, 0);
    gl.uniform1i(blitU.flip, 0);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    calls++;

    // THE feedback: every block as ONE batched draw, sampling SOURCE.
    gl.useProgram(fbProg);
    gl.uniform2f(fbU.res, W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.t);
    gl.uniform1i(fbU.src, 0);
    gl.bindVertexArray(fbVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, fbVbo);
    gl.bufferData(gl.ARRAY_BUFFER, vbuf.subarray(0, vcount), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vcount / 4);
    calls++;

    // 4. TARGET -> visible canvas (flip Y to display upright).
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tgt.t);
    gl.uniform1i(blitU.tex, 0);
    gl.uniform1i(blitU.flip, 1);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    calls++;

    // 5. swap.
    const t = src; src = tgt; tgt = t;
    drawCalls = calls;
  }

  // ---- lifecycle -------------------------------------------------------------
  function allocTargets() {
    if (texA) { gl.deleteTexture(texA); gl.deleteFramebuffer(fboA); }
    if (texB) { gl.deleteTexture(texB); gl.deleteFramebuffer(fboB); }
    const A = makeTarget(); texA = A.t; fboA = A.f;
    const B = makeTarget(); texB = B.t; fboB = B.f;
    src = { t: texA, f: fboA };
    tgt = { t: texB, f: fboB };
    clearFbo(fboA);
    clearFbo(fboB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function init() {
    W = canvas.width;
    H = canvas.height;
    S = W / Math.max(1, window.innerWidth);
    cx = W >> 1;
    cy = H >> 1;

    pscale = Math.max(1, Math.round(S));
    if (W > 2560 || H > 2560) pscale = Math.round(pscale * 1.5);

    sizx = W; sizy = H; midx = cx; midy = cy;
    stateX = 0; stateY = 0;
    builtSpeed = -1;
    ensureRots();

    acos = new Float32Array(24);
    coords = new Int32Array(8);
    ocoords = new Int32Array(8);
    drawCount = 0;

    buildColors();
    allocTargets();
  }

  function reinit() {
    init();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = window.innerWidth, cssH = window.innerHeight;
    // FULL device resolution -- no MAX_EDGE cap (that's the whole point).
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    init();
  }

  // rAF loop banking config.delay, matching kumppa.js's pacing.
  const MAX_CATCHUP_STEPS = 2;
  let lastTime = 0;
  let lag = 0;
  let rafId = 0;
  let fps = 0, fpsAcc = 0, fpsN = 0, fpsLast = 0;

  function frame(now) {
    if (lastTime === 0) lastTime = now;
    lag += now - lastTime;
    if (fpsLast) { fpsAcc += now - fpsLast; fpsN++; if (fpsAcc >= 500) { fps = 1000 * fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; } }
    fpsLast = now;
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

  window.addEventListener('resize', resize);
  resize();
  rafId = requestAnimationFrame(frame);

  return {
    stop() {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      canvas.remove();
    },
    pause() { cancelAnimationFrame(rafId); rafId = 0; },
    resume() { if (!rafId) { lastTime = 0; rafId = requestAnimationFrame(frame); } },
    reinit,
    config,
    params,
    getStats() {
      return { fps: Math.round(fps), drawCalls, feedbackQuads, w: W, h: H };
    },
  };
}
