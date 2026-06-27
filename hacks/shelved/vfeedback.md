# vfeedback — SHELVED (2026-06-27)

**Status: shelved, removed from the UI.** The rebuild below works and looks good — a clean, stable, evolving video-feedback spiral on the real NTSC engine — but getting it stable required a *stack of deviations the original doesn't have* (a per-frame deadband AGC, a per-pixel soft-clip, a rotation-only camera, a persistent orbiting glint, calibrated knobs). The result is a feedback-**inspired** hack rather than a faithful `vfeedback` port, and faithfulness is the bar for this project, so it was shelved. Files moved to `hacks/shelved/`; removed from `host.js` + `taxonomy.js`. The feedback machinery (ping-pong, `agcServo` deadband AGC, the mip-bug fix) was **sliced out of the shared engine** (`hacks/analogtv.glsl.js`) to keep it lean — none of the other analogtv clients (xanalogtv; pong/filmleader/m6502 if ported) use self-feedback — and the exact removed code is archived in the **appendix at the bottom of this file** for revival.

## The journey (everything tried, for a future attempt)

**Reference target:** the jwz demo video — <https://www.youtube.com/watch?v=I_MkW0CW4QM> (also the `<video>` in `vfeedback.xml`). The look to match: a soft, colourful, *fan/tunnel* of overlapping rotated-and-zoomed copies — not the tight grayscale spiral this build settles into. Ground truth used during the attempt: the live original run under XQuartz (`scratchpad/capture.sh`) and its frame captures (`scratchpad/rvf-*`).

The goal was a faithful `vfeedback` on the shared [[analogtv]] engine: pure self-feedback (the C's `#undef DEBUG`), no image. The picture content (`atv_source`) and camera were transcribed faithfully from `grab_rectangle` + the `POWERUP→IDLE→MOVE` state machine + the `#CCCC44` specular. That part is faithful and works. **The wall was the loop dynamics:**

- **The core problem — the loop is bistable on our pipeline.** The real `analogtv` is a CPU sim whose feedback self-stabilises near unity gain (one specular seeds a figure the rotation sweeps and the set's response caps). Our engine is faithful for a **single pass** (validated pixel-wise on [[xanalogtv]]/SMPTE bars), but its FIR/resampled round-trip carries a tiny transfer error that, **compounded every frame**, makes the loop collapse to black or saturate to white instead of holding a figure.
- **Things tried, in order:**
  1. *Faithful static AGC* (`agc = 1/level`). Discovered `level` cancels in the real AGC, so for our unit-amplitude encode the faithful value is `agc = 1`; and the literal `brightness = −0.094` is a hard black-clip that eats the figure's fade. Loop collapses or saturates by random knob roll.
  2. *Open-loop gamma equilibrium.* A genuinely beautiful, stable spiral — **but only with a frozen camera** (fixed hub, constant rotation, no zoom/pan). Any camera motion breaks it: zoom-out shrinks the picture to a point (collapse), pan spills it off-edge (collapse), fast rotation smears it to chaos.
  3. *Brightness-target servo.* Blobbed — to hit a target from a small source it cranks the gain and saturates everything to flat white (no gradient).
  4. **The decisive bug.** The servo's brightness probe called `generateMipmap` while the *input* texture (`finTex`) was still bound, so the copy's 1×1 mip was never generated → the readback always returned 0 → the servo thought every frame was black → it always boosted → white-out. This had silently sabotaged **every** servo attempt (and was latent in the original servo too). Fixed by binding the copy texture before `generateMipmap`.
  5. **What finally held the figure** (the deviations that got it shelved): a **per-frame deadband AGC** (a real set re-normalises its camera signal each pass; kept loose so it only catches collapse/white-out extremes and leaves the gamma equilibrium alone in the band — a tight servo flattens the figure) + a **per-pixel soft-clip** (bright pixels eased back, dim ones pass, so the fade gradient survives where a global gain would wash it to a blob) + the CRT gamma. Plus a **rotation-only camera** (pan/zoom collapse the loop) with a slow rotation-rate drift, a **persistent orbiting glint hub** (the C's intermittent jumping glint scrambles into discrete blobs on our pipeline), and a slow tint cycle. Result: a coherent spiral, mean luma drifting ~0.22 (dark) ↔ ~0.42 (bright) like the measured original. Optional "Test card" mode (= the C's `#ifdef DEBUG` fold) was added and works.
- **Why a *spiral* and not the reference's looser *fan*:** the fan needs stable zoom (a tunnel), which collapses on our pipeline. With zoom out, rotation-only gives a spiral.
- **If revisited, the right fix is upstream:** make the **open-loop round-trip gain match the real CPU sim's** so the faithful knobs + full camera (incl. zoom) self-stabilise *without* the deviation stack. Suspects for the lost gain: the scanline-profile dimming compounding each pass, the canvas↔signal-space up/down resampling, and the encode/decode FIR DC gain. Get that right and the AGC/soft-clip/rotation-only crutches fall away and the fan/tunnel become reachable.
- **Measurement gotcha that cost hours:** ImageMagick's `-colorspace Gray -format '%[fx:mean]'` applies a linear-light transform that ~**doubles** a dark frame's reported mean — it made the real set's dark phase read as a phantom "stable 0.53 bright" target and sent tuning the wrong way. Use a plain `-format '%[fx:mean]'` (perceptual). The real `vfeedback` *varies* (dark green ~0.28 ↔ cream fan ~0.4–0.77), it is not pinned.
- **Test rig (in the session scratchpad):** `vf_*.js` variants document each approach; `timelapse.mjs` (wall-clock frames), `probe.mjs`/`probe2.mjs` (read `getStats().agcGain`), and the live original captured under XQuartz via `capture.sh`.

---

The design notes below describe the shelved build as it stands.

# vfeedback — port notes

Port of `vfeedback.c` by Jamie Zawinski (2018) — "Simulates video feedback: pointing a video camera at an NTSC television." A camcorder aimed at the monitor it is plugged into re-grabs the screen it just drew — slightly rotated, zoomed and panned — and feeds it back ~30× a second, folding the picture into endless rotating spirals and tunnels. Crucially, the grabbed frame is run back through the **NTSC signal simulation** each pass, so the colour cycling, snow and chroma artifacts are the real thing — this is the second hack built on the shared engine [[analogtv]] (`hacks/analogtv.glsl.js`), not the blur + hue-rotate knock-off it replaces.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/vfeedback.c`. See [[xanalogtv]] for the first hack on the engine and the memory note `analogtv-ntsc-shader-port`.

## Self-feedback, no screen grab
The real vfeedback grabs **its own window** (`XCopyArea st->window` → its previous frame), *not* the desktop or an external monitor — it is pure self-feedback, bootstrapped from the analogtv power-on warm-up plus periodic specular glints. That maps cleanly onto the harness's ping-pong: `atv_source()` resamples the **previous final frame** (`uPrev`) through the camera rectangle, the harness re-encodes it to composite and re-decodes it, and the result becomes the next `uPrev`. So the hack needs **no input image at all** — which is also why it ports to the browser at all (a browser can't grab the desktop, but it doesn't need to).

## The camera (`grab_rectangle`)
The C keeps a normalised camera rectangle `rect = {x, y, w, h, th}` (pan, zoom, rotation) and, for every output pixel, samples the previous frame at a recentred / scaled / rotated / offset coordinate; off-frame samples read black (the dark border past the screen's edge). `atv_source` transcribes that affine exactly (derived in the shader comments) and samples `uPrev` at `(p.x, 1−p.y)` for the GL y-flip. A `POWERUP → IDLE → MOVE` state machine eases the rectangle between poses; a `#CCCC44` **specular glint** is the only injected light (the stray room-light the tunnels chase).

## The hard part: stabilising the loop (the load-bearing deviations)
A feedback loop is only as good as its dynamics, and this is where the port earns its keep. The real `analogtv` is a CPU sim whose loop **self-stabilises** into a smooth rotating figure: it runs near unity gain, so one specular seeds a spiral that the rotation sweeps and the set's response curve caps. Our engine is faithful for a **single pass** (validated pixel-wise on [[xanalogtv]]/SMPTE bars) but its FIR/resampled round-trip carries a small transfer error that, **compounded every frame in feedback**, makes the loop *bistable*: it collapses to black or saturates to a white blob rather than holding the figure. Three things, working together, restore the real dynamics:

1. **Per-frame AGC, as a real set does it (gentle deadband).** A real TV runs its automatic gain control on the camera signal *every* frame — re-normalising it on each pass — which is a big part of why real video feedback stays bounded. (`analogtv.c` models AGC as a *static* knob, so a literal port never self-regulates.) The harness `agcServo` measures the mean brightness of the frame just produced and nudges the decode gain, but **only at the extremes** (a wide deadband, `agcLo`…`agcHi`): inside the band the loop's own equilibrium stands; outside it (straying toward collapse or white-out) it is eased back. A *tight* servo to a fixed level instead fights the equilibrium and flattens the figure.
2. **Per-pixel soft-clip on the fed-back signal.** Bright pixels are eased back toward white while dim pixels pass through untouched (a soft knee on luma, colour preserved — `softAGC` in the source). This bounds the white-out **while preserving the spiral's fade gradient**: a single global gain would scale the dim arms too and wash the whole thing into a blob. This is also what lets the global AGC *boost* (to fight collapse) without blobbing.
3. **The CRT gamma** (in the engine's final pass) supplies a self-limiting equilibrium between the two.

With these, the loop sits where the real one does — measured off the live original, mean luma drifts between a **dark phase (~0.22, mostly black with a bright figure)** and a **brighter phase (~0.4)**, never collapsing or blowing out.

## Camera & specular tuning (further deviations, for coherence)
- **Rotation only — no pan, no zoom.** The C pans and zooms (w ∈ 0.6…1.4) and spins as fast as 1.2 rad/frame, but on our pipeline *any* pan or zoom-out spills the picture off-edge faster than the loop gain refills it (collapse), and a fast spin smears the figure into chaos. Pure gentle rotation about the centre keeps every pixel on-screen — the one regime that holds the coherent spiral. A slow drift of the **rotation rate** (|th| ≈ 0.10…0.20 rad/frame) is the main visible evolution (the spiral winds and unwinds).
- **A persistent specular hub on a slow circular orbit.** The C's glint is intermittent and jumps to a new spot; an intermittent/jumping source can't sustain a coherent figure on our pipeline (it scrambles into discrete blobs). So the glint stays lit and glides on a slow constant-radius circle — it must stay **off the rotation centre**, or it lands on the fixed point, stops being swept, and piles up to a white-out. The hue cycles slowly (the analogtv `tint_control` wander), so the glint and the figure it anchors drift through colour.

## Optional test-card mode (the C's `#ifdef DEBUG` path)
The original has a debug path that feeds a bundled test card instead of self-feedback — a transform test that produces the classic *camera-pointed-at-a-monitor* recursive tunnel. Since a browser can't grab the desktop, a bundled card is the only image input, so this is surfaced as a **"Test card" checkbox** (default off). On, a PM5544/RCA/BBC-F card (one per run) is flooded in then trickled, and the loop folds it into the nested tunnel — useful both as a look and as a live confirmation that the `grab_rectangle` transform + NTSC pipeline are correct. The cards ship under xscreensaver's licence (this being a port).

## Deviations from the C (summary)
- **The three stabilisers above** (per-frame deadband AGC, per-pixel soft-clip, gamma equilibrium) — faithful *in result*, the same spirit as the engine's IIR→FIR conversion; they reproduce the real loop's bounded, self-sustaining behaviour that our compounded FIR round-trip otherwise loses.
- **Rotation-only camera** and a **persistent orbiting hub** (vs the C's pan/zoom + intermittent jumping glint) — for loop coherence on our pipeline, as above.
- **No image by default** (self-feedback only), with the test card as an opt-in mode — matching the shipped C (`#undef DEBUG`), not the debug path.
- **Knobs:** contrast/brightness are held at a loop-gain calibration (the literal TVBrightness −0.094 hard-clips and eats the figure's fade; the gentle −0.02 floor does not), the reception `level` survives only as the snow-to-signal ratio (the AGC cancels its brightness effect), and the colour wander is a slow continuous tint cycle rather than the C's rare random jumps. Mouse/keyboard camera control is dropped (the host owns input); the knobs are config-box sliders.

## Config
Exposed: `speed` (evolution rate), `color` (chroma master over the cycling tint), `noise` (snow), and the `testcard` checkbox. Internal: `agcServo`/`agcLo`/`agcHi` (the deadband AGC), `knee` (the per-pixel soft-clip), `fps`.

## Validation
Checked against the live original under XQuartz (`scratchpad/capture.sh` → the real `vfeedback` window) and head-less browser captures (`scratchpad/timelapse.mjs`). **Measurement gotcha:** ImageMagick's `-colorspace Gray` applies a linear-light transform that roughly *doubles* a dark frame's reported mean — measure perceptual brightness with a plain `-format '%[fx:mean]'` instead, or the real set's dark phase reads as a phantom mid-grey. See the memory note `analogtv-ntsc-shader-port` for the full rig and the debugging history (the decisive bug was the AGC probe mip-mapping the wrong texture, so it always read black and always boosted → white-out).

**Local dev:** ES-module imports need a server (`python3 -m http.server`, then <http://localhost:8000/#vfeedback>); `file://` won't load. GitHub Pages serves over http, so production is unaffected.

---

## Appendix — feedback machinery sliced out of `analogtv.glsl.js` (2026-06-27)

This is the *exact* removed code (none of the other analogtv clients need self-feedback, so it was pulled to keep the shared engine lean). To revive feedback, re-add each block to `startAnalogTV`. The shelved `vfeedback.js` in this directory is the consumer.

**1. opts destructure** — add `feedback = false`:
```js
const { source, decl = '', feedback = false, ghost = false, bloom = false, twoStation = false, images = [], ... } = opts;
```

**2. servo flag** (right after the destructure):
```js
const servo = feedback && !!config.agcServo;
```

**3. encode shader uniforms** (`encSrc` header) — add the prev-frame samplers:
```js
`uniform float uTime; uniform int uFrame; uniform sampler2D uPrev; uniform vec2 uPrevRes;\n`
// (lean version is: `uniform float uTime; uniform int uFrame;\n`)
```

**4. brightness-probe copy program** (after `pAddB`):
```js
const pCopy = servo
  ? program(ATV_HEAD + `uniform sampler2D uTex; uniform vec2 uOut;
void main(){ o = texture(uTex, gl_FragCoord.xy/uOut); }`)
  : null;
```

**5. ping-pong + AGC-probe buffers + `ensureFinal()`** (after the bloom/two-station buffers):
```js
// Canvas-res final ping-pong (only needed for self-feedback hacks).
let finTex = [null, null], finFbo = [null, null], finW = 0, finH = 0, cur = 0;
// AGC probe targets: an RGBA8 mip chain + a framebuffer onto its 1x1 top level.
let mfTex = null, mfFbo = null, readFbo = null, maxLevel = 0;
const readPx = new Uint8Array(4);
function ensureFinal(w, h) {
  if (!feedback) return;
  if (w === finW && h === finH && finTex[0]) return;
  for (const t of finTex) if (t) gl.deleteTexture(t);
  for (const f of finFbo) if (f) gl.deleteFramebuffer(f);
  if (mfTex) gl.deleteTexture(mfTex);
  if (mfFbo) gl.deleteFramebuffer(mfFbo);
  if (readFbo) gl.deleteFramebuffer(readFbo);
  finTex = [makeTex(w, h), makeTex(w, h)];
  finFbo = [mkFbo(finTex[0]), mkFbo(finTex[1])];
  if (servo) {
    mfTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, mfTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    mfFbo = mkFbo(mfTex);
    maxLevel = Math.floor(Math.log2(Math.max(w, h)));
    readFbo = gl.createFramebuffer();
  }
  finW = w; finH = h; cur = 0;
}
```

**6. agcGain state** (with the other loop vars, by `let frame = 0, ...`):
```js
let agcGain = 1.0;   // auto-gain (analogtv agclevel); servoed each frame
```

**7. encode — bind the previous frame** (in `runPipeline`, after uTime/uFrame, before the image loop):
```js
if (feedback) {
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, finTex[1 - cur] || finTex[0]);
  gl.uniform1i(loc(pEnc, 'uPrev'), 1);
  gl.uniform2f(loc(pEnc, 'uPrevRes'), finW, finH);
}
```

**8. decode — route the gain through the servo** (the contrast + uAgc lines):
```js
  knob('contrast', 1.4) * (servo ? agcGain : 1.0));    // lean: knob('contrast', 1.4));
...
gl.uniform1f(loc(pDec, 'uAgc'), servo ? 1.0 : knob('agc', 1.0));  // lean: knob('agc', 1.0)
```

**9. final — render to the ping-pong FBO** (the target line):
```js
const target = feedback ? finFbo[cur] : null;   // lean: render straight to null (screen)
gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.viewport(0, 0, w, h);
```

**10. after the final draw — blit to screen + deadband AGC + page-flip** (whole block, removed entirely):
```js
if (feedback) {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, finFbo[cur]);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  if (servo) {
    // Per-frame AGC (real-set behaviour): measure mean brightness, nudge decode gain,
    // GENTLY and only at the EXTREMES (a wide deadband) so the loop's own CRT-gamma
    // equilibrium stands inside the band. NOTE: generateMipmap on mfTex, NOT finTex --
    // the decisive bug was mip-mapping the still-bound input (so the readback read 0).
    gl.useProgram(pCopy);
    gl.bindFramebuffer(gl.FRAMEBUFFER, mfFbo); gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, finTex[cur]);
    gl.uniform1i(loc(pCopy, 'uTex'), 0);
    gl.uniform2f(loc(pCopy, 'uOut'), w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, mfTex);   // mip the COPY, not pCopy's input (finTex)
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, mfTex, maxLevel);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, readPx);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const luma = (0.30 * readPx[0] + 0.59 * readPx[1] + 0.11 * readPx[2]) / 255;
    const lo = config.agcLo == null ? 0.12 : config.agcLo;
    const hi = config.agcHi == null ? 0.45 : config.agcHi;
    const rate = config.agcRate == null ? 0.03 : config.agcRate;
    let adj = 1.0;                                  // deadband: no nudge inside [lo,hi]
    if (luma < lo) adj = 1.0 + rate * Math.min(1.0, (lo - luma) / lo);
    else if (luma > hi) adj = 1.0 - rate * Math.min(1.0, (luma - hi) / hi);
    agcGain = Math.min(8.0, Math.max(0.04, agcGain * adj));
  }

  cur ^= 1;
}
```

**11. `render()` — allocate per-resize + show the last field between TV frames:**
```js
ensureFinal(w, h);   // right after syncSize()
...
// the acc < stepMs else-branch:
} else if (feedback && finTex[1 - cur]) {
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, finFbo[1 - cur]);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
```

**12. `stop()` — free the feedback resources** (and add `pCopy` to the program-delete list — it was previously leaked):
```js
for (const t of finTex) if (t) gl.deleteTexture(t);
for (const f of finFbo) if (f) gl.deleteFramebuffer(f);
if (mfTex) gl.deleteTexture(mfTex);
if (mfFbo) gl.deleteFramebuffer(mfFbo);
if (readFbo) gl.deleteFramebuffer(readFbo);
```

**13. `getStats()`** — returned `agcGain` (`{ ms, w, h, agcGain }`); the doc comment also listed `feedback` and the `uPrev` mention.

Config knobs the consumer sets: `agcServo` (on), `agcLo`/`agcHi`/`agcRate` (deadband), plus the per-pixel `softAGC`/`uKnee` which live in the **hack's** `atv_source` (already in this dir's `vfeedback.js`), not the engine.
