// shadertoy.js — a small, modern WebGL2 harness that runs Shadertoy-style
// fragment shaders (the hacks/glx/glsl/*.glsl pool from xscreensaver 6.x).
//
//   startShadertoy(hostCanvas, { source | passes, config, params, name })
//     -> { stop, pause, resume, reinit, getStats, config, params }
//
// We deliberately do NOT port xscreensaver's xshadertoy.c. That file is a
// back-compat shim: it rewrites modern Shadertoy shaders down to GLSL ES 1.00
// (aliasing texture()->texture2D, faking texelFetch, writing gl_FragColor) so
// they run on 15-year-old GL and mobile GLES2. In a 2026 browser WebGL2 is
// universal, and it speaks GLSL ES 3.00 — the same dialect Shadertoy targets —
// so a shader's mainImage() body runs essentially verbatim with a far thinner
// wrapper than xscreensaver needs.
//
// The host owns one shared <canvas> that 2D hacks bind to a '2d' context, and a
// canvas is locked to the first context type it is ever given — so we can never
// get 'webgl2' on it (and must not try: that would break every later 2D hack).
// Instead each GL hack overlays its OWN canvas exactly covering the host canvas
// and removes it on stop(). pointer-events:none lets the click that summons the
// picker fall through to the host canvas underneath.
//
// Honored config keys (a hack may expose either, both, or neither as params):
//   config.speed       playback-rate multiplier on iTime (default 1)
//   config.resolution  render scale vs devicePixelRatio (default 1; lower = faster)
//
// SINGLE-PASS (most of the pool, and all of Star Nest): pass { source }, one
// fragment-shader pass straight to the screen, no textures.
//
// MULTIPASS (harness v2): pass { passes: [ { name, source, channels } ... ] } to
// run the Shadertoy BufferA-D / Image model. Each pass paints a full screen; its
// output can be sampled by another pass through iChannelN. We mirror
// xscreensaver's xshadertoy.c FBO model (all buffers share the render size) with
// two deliberate differences:
//
//   * Explicit wiring. xshadertoy.c hard-codes iChannelN == pass N's output and
//     packs files in name order, which silently mis-wires shaders whose Image
//     pass should read an earlier Buffer (e.g. neongravity, where it runs the
//     FXAA pass first against its own stale buffer and shows the renderer raw).
//     Here every pass names which buffer each channel samples — 'self' for its
//     own previous frame, or another pass's name — so we honor the original
//     Shadertoy graph, not the packing accident.
//   * LINEAR sampling (xshadertoy.c forces NEAREST), so FXAA / reflection passes
//     interpolate as their authors intended.
//
// A buffer ping-pongs (two textures) only when something samples its *previous*
// frame (self-feedback, the cube-map-reflection shaders); a buffer read only by
// a later pass in the same frame keeps a single texture. The final pass draws
// straight to the screen unless it feeds back on itself, in which case it renders
// to an FBO that is blitted to the screen. Built natively, again — not
// transcribed from xshadertoy.c.

// One full-screen triangle, generated from gl_VertexID — no vertex buffer
// needed (a WebGL2 convenience the old fixed-function harness couldn't use).
const VERTEX_SOURCE = `#version 300 es
void main() {
  vec2 v = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}
`;

// The Shadertoy uniform contract, declared once and prepended to every shader.
const FRAG_PREAMBLE = `#version 300 es
precision highp float;
precision highp int;
uniform vec3  iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform float iFrameRate;
uniform int   iFrame;
uniform vec4  iMouse;
uniform vec4  iDate;
out vec4 shadertoy_outColor;
`;

// Sampler inputs, prepended only for multipass hacks. Single-pass shaders never
// see these, so their compiled source stays byte-for-byte what it was before
// harness v2 (no behavior change, nothing new to re-verify for the 20 actives).
const CHANNEL_DECLS = `uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
uniform vec3 iChannelResolution[4];
`;

// Shadertoy shaders define mainImage(out vec4, in vec2); we drive it from main().
const FRAG_ENTRY = `
void main() {
  vec4 color = vec4(0.0, 0.0, 0.0, 1.0);
  mainImage(color, gl_FragCoord.xy);
  shadertoy_outColor = color;
}
`;

function compileShader(gl, type, source, label) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`${label} shader failed to compile:\n${log}`);
  }
  return shader;
}

function buildProgram(gl, fragmentSource, name, withChannels) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE, `${name} vertex`);
  const fs = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    FRAG_PREAMBLE + (withChannels ? CHANNEL_DECLS : '') + fragmentSource + FRAG_ENTRY,
    `${name} fragment`,
  );
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);   // flagged for deletion; freed once the program is gone
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`${name} program failed to link:\n${log}`);
  }
  return program;
}

// The full uniform set for one pass. Locations are null when a name is unused;
// gl.uniform*(null, ...) is a documented no-op, so callers never branch on it.
function getUniforms(gl, program) {
  return {
    iResolution: gl.getUniformLocation(program, 'iResolution'),
    iTime: gl.getUniformLocation(program, 'iTime'),
    iTimeDelta: gl.getUniformLocation(program, 'iTimeDelta'),
    iFrameRate: gl.getUniformLocation(program, 'iFrameRate'),
    iFrame: gl.getUniformLocation(program, 'iFrame'),
    iMouse: gl.getUniformLocation(program, 'iMouse'),
    iDate: gl.getUniformLocation(program, 'iDate'),
    iChannel: [0, 1, 2, 3].map((i) => gl.getUniformLocation(program, `iChannel${i}`)),
    iChannelResolution: [0, 1, 2, 3].map(
      (i) => gl.getUniformLocation(program, `iChannelResolution[${i}]`),
    ),
  };
}

export function startShadertoy(hostCanvas, { source, passes, config, params, name = 'shader' }) {
  // Our own canvas, laid exactly over the host canvas — see header for why we
  // never reuse the host canvas's context. z-index:1 keeps it above the host
  // canvas (auto) but below the host chrome (>= 99998); pointer-events:none
  // lets clicks reach the host canvas's "open picker" handler underneath.
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
    // No WebGL2 (very unlikely in 2026): fail soft so the host doesn't throw.
    console.error(`${name}: WebGL2 is required but unavailable in this browser.`);
    return {
      stop() { canvas.remove(); },
      config,
      params,
    };
  }

  // Normalize to a pass list. A bare { source } is one pass straight to screen;
  // this keeps the single-pass path (and its compiled source) identical to v1.
  const passList = (passes && passes.length) ? passes : [{ name, source }];
  const multipass =
    passList.length > 1 ||
    passList.some((p) => p.channels && Object.keys(p.channels).length > 0);

  const indexOf = {};
  passList.forEach((p, i) => { indexOf[p.name] = i; });

  // The buffer a pass's channel samples: 'self' is the pass itself, otherwise a
  // pass name. (Index >= the reader means "previous frame"; see needsPrev.)
  const srcIndex = (readerIdx, src) => (src === 'self' ? readerIdx : indexOf[src]);
  const channelEntries = (p) =>
    p.channels ? Object.entries(p.channels).map(([c, src]) => [Number(c), src]) : [];

  // A pass needs an offscreen buffer if it isn't the last pass (a later pass will
  // sample it) or if it samples its own / a later buffer's previous frame.
  const referencesGE = (p, i) => channelEntries(p).some(([, src]) => srcIndex(i, src) >= i);
  const needsFbo = passList.map((p, i) => i < passList.length - 1 || referencesGE(p, i));

  // A buffer needs a second texture (ping-pong) only if some pass samples it as a
  // previous frame, i.e. a reader whose index is <= the buffer's own index.
  const needsPrev = passList.map(() => false);
  passList.forEach((p, x) => {
    for (const [, src] of channelEntries(p)) {
      const b = srcIndex(x, src);
      if (b >= x) needsPrev[b] = true;
    }
  });

  const programs = passList.map((p) => buildProgram(gl, p.source, p.name, multipass));
  const uniforms = programs.map((pr) => getUniforms(gl, pr));

  // RGBA16F render targets (HDR intermediates, like xshadertoy.c's GLES3 path)
  // when the float-render extension is present; RGBA8 otherwise. Half-float is
  // core-filterable in WebGL2, so LINEAR works either way.
  const floatExt = gl.getExtension('EXT_color_buffer_float');
  const internalFormat = floatExt ? gl.RGBA16F : gl.RGBA8;
  const texType = floatExt ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

  const buffers = passList.map((p, i) =>
    needsFbo[i]
      ? { fbo: gl.createFramebuffer(), textures: [], needsPrev: needsPrev[i], cur: 0 }
      : null,
  );

  function makeTex(w, h) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, gl.RGBA, texType, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  let fboW = 0;
  let fboH = 0;
  function resizeBuffers(w, h) {
    for (const b of buffers) {
      if (!b) continue;
      for (const t of b.textures) gl.deleteTexture(t);
      const n = b.needsPrev ? 2 : 1;
      b.textures = [];
      for (let k = 0; k < n; k++) b.textures.push(makeTex(w, h));
      b.cur = 0;
    }
    fboW = w;
    fboH = h;
  }

  const program = programs[0];   // bound by default; per-pass useProgram in render
  gl.useProgram(program);

  // WebGL2 core requires a bound VAO to draw, even with no vertex attributes.
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  // iMouse stays at the origin: Star Nest (and friends) treat (0,0) as their
  // canonical default orientation, and a screensaver has no pointer anyway. A
  // pointer-driven "explore" mode could be added without blocking picker clicks
  // by listening on window for mousemove (mousemove doesn't consume the click).
  const mouse = { x: 0, y: 0, z: 0, w: 0 };

  // Match the drawing-buffer to the viewport * devicePixelRatio * resolution.
  // Called every frame so window resizes, DPR changes, and a live resolution
  // slider are all picked up by the same code path.
  function syncSize() {
    const dpr = window.devicePixelRatio || 1;
    const scale = (config.resolution == null ? 1 : config.resolution) * adaptiveScale;
    const w = Math.max(1, Math.round(window.innerWidth * dpr * scale));
    const h = Math.max(1, Math.round(window.innerHeight * dpr * scale));
    if (w !== canvas.width || h !== canvas.height) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  // Shader playback clock, in ms. We accumulate (dt * speed) rather than scaling
  // a wall clock, so changing speed never makes time jump and pausing is exact.
  // Start at a random offset so each mount opens on a different region.
  let clockMs = Math.random() * 60000;
  let frame = 0;
  let lastNow = 0;
  let rafId = 0;

  // Adaptive resolution: trim render scale when the GPU can't sustain the frame
  // rate, restore it when there's headroom. dt is the real inter-frame time, so
  // it climbs under GPU load; config.resolution stays the ceiling (we only ever
  // scale DOWN from it). Keeps heavy ray-marchers smooth without per-shader
  // tuning, while cheap shaders stay at full resolution. Floor at 1/3 so it
  // never degrades to mush. Set config.adaptive = false to pin a fixed scale.
  let adaptiveScale = 1;
  let frameMs = 16;       // smoothed frame time (EMA), ms
  let sinceAdjust = 0;
  const stats = { ms: 16, scale: 1 };

  function setDateUniform(loc) {
    const d = new Date();
    gl.uniform4f(
      loc,
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000,
    );
  }

  function render(now) {
    syncSize();
    const w = canvas.width;
    const h = canvas.height;
    if (multipass && (w !== fboW || h !== fboH)) resizeBuffers(w, h);

    if (lastNow === 0) lastNow = now;
    let dt = now - lastNow;
    lastNow = now;
    if (dt < 0) dt = 0;
    if (dt > 100) dt = 100;   // clamp big gaps (backgrounded tab) so time is smooth

    const speed = config.speed == null ? 1 : config.speed;
    clockMs += dt * speed;

    // Drive adaptive resolution from the smoothed frame time (skip the first
    // frame and any backgrounded-tab gap, both of which read as dt >= 100).
    // Hysteresis band [13, 21] ms avoids oscillation around a steady 60fps.
    if (dt > 0 && dt < 100) frameMs += (dt - frameMs) * 0.1;
    if (config.adaptive !== false && ++sinceAdjust >= 20) {
      sinceAdjust = 0;
      if (frameMs > 21 && adaptiveScale > 0.34) adaptiveScale = Math.max(0.34, adaptiveScale * 0.85);
      else if (frameMs < 13 && adaptiveScale < 1) adaptiveScale = Math.min(1, adaptiveScale * 1.07);
    }
    stats.ms = frameMs;
    stats.scale = (config.resolution == null ? 1 : config.resolution) * adaptiveScale;

    const tSec = clockMs / 1000;
    const dSec = dt / 1000;
    const fps = dt > 0 ? 1000 / dt : 60;

    for (let i = 0; i < passList.length; i++) {
      const p = passList[i];
      const u = uniforms[i];
      gl.useProgram(programs[i]);

      // Bind this pass's input channels: a buffer from earlier in the same frame
      // (its fresh output) or a previous frame (its ping-pong "prev" texture).
      for (const [chan, src] of channelEntries(p)) {
        const b = srcIndex(i, src);
        const sb = buffers[b];
        if (!sb) continue;
        const tex = b < i
          ? sb.textures[sb.cur]
          : sb.textures[sb.needsPrev ? 1 - sb.cur : sb.cur];
        gl.activeTexture(gl.TEXTURE0 + chan);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(u.iChannel[chan], chan);
        gl.uniform3f(u.iChannelResolution[chan], w, h, 1);
      }

      gl.uniform3f(u.iResolution, w, h, 1.0);
      gl.uniform1f(u.iTime, tSec);
      gl.uniform1f(u.iTimeDelta, dSec);
      gl.uniform1f(u.iFrameRate, fps);
      gl.uniform1i(u.iFrame, frame);
      gl.uniform4f(u.iMouse, mouse.x, mouse.y, mouse.z, mouse.w);
      setDateUniform(u.iDate);

      const buf = buffers[i];
      if (buf) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, buf.fbo);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, buf.textures[buf.cur], 0,
        );
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      // The triangle covers every pixel and the shader is opaque, so there is
      // nothing to clear first.
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // If the final pass rendered to an FBO (because it feeds back on itself),
    // copy that buffer to the screen — same move as xshadertoy.c's blit.
    const last = buffers[passList.length - 1];
    if (last) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, last.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // This frame's writes become next frame's "prev".
    for (const b of buffers) if (b && b.needsPrev) b.cur ^= 1;

    frame++;
    rafId = requestAnimationFrame(render);
  }

  function onResize() {
    syncSize();   // keep the buffer correct even while paused (no rAF running)
  }

  // Allow the browser to recover a lost context instead of killing the page;
  // the loop keeps running and resumes drawing once the context is restored.
  function onContextLost(event) {
    event.preventDefault();
  }

  canvas.addEventListener('webglcontextlost', onContextLost, false);
  window.addEventListener('resize', onResize);

  syncSize();
  rafId = requestAnimationFrame(render);

  return {
    stop() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('webglcontextlost', onContextLost, false);
      for (const pr of programs) gl.deleteProgram(pr);
      for (const b of buffers) {
        if (!b) continue;
        gl.deleteFramebuffer(b.fbo);
        for (const t of b.textures) gl.deleteTexture(t);
      }
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      canvas.remove();
    },
    pause() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    },
    resume() {
      if (!rafId) { lastNow = 0; rafId = requestAnimationFrame(render); }
    },
    reinit() {
      clockMs = Math.random() * 600000;   // jump to a fresh region of the field
    },
    getStats() {
      return { ms: stats.ms, scale: stats.scale, w: canvas.width, h: canvas.height };
    },
    config,
    params,
  };
}
