// shadertoy.js — a small, modern WebGL2 harness that runs Shadertoy-style
// fragment shaders (the hacks/glx/glsl/*.glsl pool from xscreensaver 6.x).
//
//   startShadertoy(hostCanvas, { source, config, params, name })
//     -> { stop, pause, resume, reinit, config, params }
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
// Scope: single-pass, no-texture shaders (which is most of the pool, and all of
// Star Nest). Multi-pass iChannel/BufferA-D shaders would need FBO ping-pong
// added here later — built natively, again, not transcribed from xshadertoy.c.

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

function buildProgram(gl, fragmentSource, name) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE, `${name} vertex`);
  const fs = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    FRAG_PREAMBLE + fragmentSource + FRAG_ENTRY,
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

export function startShadertoy(hostCanvas, { source, config, params, name = 'shader' }) {
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

  const program = buildProgram(gl, source, name);
  gl.useProgram(program);

  const uniforms = {
    iResolution: gl.getUniformLocation(program, 'iResolution'),
    iTime: gl.getUniformLocation(program, 'iTime'),
    iTimeDelta: gl.getUniformLocation(program, 'iTimeDelta'),
    iFrameRate: gl.getUniformLocation(program, 'iFrameRate'),
    iFrame: gl.getUniformLocation(program, 'iFrame'),
    iMouse: gl.getUniformLocation(program, 'iMouse'),
    iDate: gl.getUniformLocation(program, 'iDate'),
  };

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

  function setDateUniform() {
    const d = new Date();
    gl.uniform4f(
      uniforms.iDate,
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000,
    );
  }

  function render(now) {
    syncSize();

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

    gl.uniform3f(uniforms.iResolution, canvas.width, canvas.height, 1.0);
    gl.uniform1f(uniforms.iTime, clockMs / 1000);
    gl.uniform1f(uniforms.iTimeDelta, dt / 1000);
    gl.uniform1f(uniforms.iFrameRate, dt > 0 ? 1000 / dt : 60);
    gl.uniform1i(uniforms.iFrame, frame);
    gl.uniform4f(uniforms.iMouse, mouse.x, mouse.y, mouse.z, mouse.w);
    setDateUniform();

    // The triangle covers every pixel and the shader is opaque, so there is
    // nothing to clear first.
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
