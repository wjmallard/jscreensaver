# marbling — port notes

GPU (GLSL ES 3.00) re-port of `marbling.c` by Jamie Zawinski & Dave Odell (2021-2022) — marble-/cloud-like patterns generated **procedurally** from Perlin Noise + Fractal Brownian Motion, not by stirring ink. The pattern slowly morphs because the noise is sampled in 3D and the third axis is time.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/marbling.c` (~634 lines, heavily SIMD/pthreads) · config: `xscreensaver-6.15/hacks/config/marbling.xml` · demo video: youtube D20sPMLwS1c. Runs through the shared `./shadertoy.js` WebGL2 harness; see [[hexplasma]] for the harness module shape, [[colormap]] for `makeSmoothColormapRGB`.

## Why this is a GPU port
`marbling.c`'s own header says it out loud: *"These algorithms lend themselves well to SIMD supercomputers, which is to say GPUs. Ideally, this program would be written in Shader Language, but XScreenSaver still targets OpenGL systems that don't support GLSL, so we are doing the crazy thing here of trying to run this highly parallelizable algorithm on the CPU instead of the GPU."* So the C runs the per-pixel Perlin/FBM field on the CPU with GCC/Clang vector SIMD + a pthread pool + a reduced grid, and even then the live binary manages only **~17.9 fps** at the xml defaults.

The earlier canvas port (single JS thread, no SIMD) was compute-bound and used a `g`-by-`g` **block grid** plus a **cell cap** that coarsened the grid on large viewports. The cell cap was a genuine CPU affordance and is **gone** here — the fragment shader runs at 60 fps with no cap. But the `g`-by-`g` block grid (the xml's `gridsize`/**Magnification** knob) is **not** a CPU affordance: it is the C's actual render resolution and is **load-bearing for the look**, so it is **kept** (see [Magnification](#magnification-gridsize--kept-because-the-c-renders-at-grid-resolution) below). One shader invocation still runs per pixel, but each `gridsize × gridsize` block resolves to a single field sample, exactly as the C.

## Faithful integer noise, transcribed into GLSL
The shader (kept alongside as `marbling.glsl`, injected + compiled by `marbling.js`) is a **near-verbatim transcription of the C's SCALAR (`VSIZE==1`) fixed-point pipeline** — not a generic float marble shader. It is the same algorithm the CPU port transcribed, moved from JS `& 0xFFFF` / `Math.imul` into GLSL `uint` / `& 0xFFFFu`:

- WebGL2 speaks GLSL ES 3.00, which has real `uint`/`int` + bitwise ops, so the C's 16-bit fixed point ports directly. Every value is a `uint` masked to 16 bits; the **uint16 wraparound is load-bearing** (a "negative" noise value wraps high and is consumed unsigned by `fbm`), exactly as in the C and the JS port.
- Constants preserved: `noise_work_bits = 13`, `noise_in_bits = 8` (a unit cube = 256), `lerp_loss = 2`, `MARB_ONE = 1<<13 = 8192`.
- `marbRand` = the C's `noise_rand` 8-bit perfect hash; `marbP(x) = marbRand(x & 0xff)` = the C's `P()`. Computed inline (cheap on the GPU) rather than the JS port's `PERM`/`FADE` memo-tables.
- `marbFade` = `6t^5-15t^4+10t^3` in fixed point (`MUL_HI(a,b) = (a*b)>>16`); `marbGrad` = the same 12-direction gradient (`(h & ~2) == 12` etc.); `marbLerp(t,a,b) = (a>>2) + IMUL_HI(t, b-a)`; `marbNoise` = the 8-corner trilinear blend. `SCALE()` is a no-op in the shipping binary (`(uint16)(1<<20) == 0`) and is faithfully omitted.
- `marbFbm` = **2 octaves**, amplitude `*G` (`G = 2^-0.5`, `iG = 46340`), frequency `*2`.
- **Domain warp** — `p = fbm(p+X0, p+Y, p+Z)` iterated `iterations` times, the same scalar `p` fed back into all three input axes. This FBM-of-FBM feedback makes the marble veining.
- **Colour** — only the **low byte** of the warped `p` indexes the colormap (`colors[p & 0xff]`; the C's `ncolors = 256` makes the general `((p & 0xff) * ncolors) >> 8` reduce to exactly this), so the field bands into the marble striations.

Because the field is a bit-for-bit transcription, it is the **same field the CPU port produced** (which itself is a faithful transcription of the C) — only the render differs (crisp per-pixel instead of a block grid).

> One spec footnote: GLSL ES 3.00 leaves right-shift of a *negative* signed `int` implementation-defined. `marbLerp`/`marbNoise` rely on it being an arithmetic (sign-preserving) shift — which every real desktop/mobile GPU does, and which matches JS `>>`. The ±1-in-the-low-bits difference a truncating shift would make is imperceptible in the marble anyway.

## Palette
`make_smooth_colormap` via `colormap.js` `makeSmoothColormapRGB(256)` — the C's exact scheme (2-5 random HSV anchors interpolated into a closed loop). Because the harness supplies no custom uniforms and no data texture for a single-pass hack, the 256 entries are **baked into the shader source as a `const vec3 MARB_PAL[256]`** (string-substituted for the `__PALETTE__` token before compile) and looked up by `MARB_PAL[p & 0xff]`. Re-rolled on every build, exactly as the C re-rolls on each launch/reset — so each run is a different smooth gradient: sometimes muted, sometimes vivid, always **smooth**, never a harsh max-saturation rainbow. sRGB-faithful, **no saturation boost** (our WebGL canvas is true sRGB = demo-video-faithful; the values are written straight to the framebuffer, same as the old canvas `putImageData` path).

## Magnification (`gridsize`) — kept, because the C renders at grid resolution
The single most important correction over the first cut of this GPU port. `marbling.c`'s draw loop (`marbling.c:405-483`) iterates over `st->w × st->h` = the **grid** (window ÷ `gridsize`), evaluates the noise/FBM/warp field **once per grid cell**, then writes that one value to a `gridsize × gridsize` **block** of output pixels (`out += g`, and the `for (j…) out[0] = out[-1]` / `memcpy` block fill). So the C **only ever renders the field at grid resolution** — at the default `gridsize = 2`, that is screen ÷ 2.

The domain-warp field is high-frequency (the FBM-of-FBM feedback varies fast between grid points), but the C never *shows* that variation, because it samples once per cell. The first cut of this port sampled **per pixel**, so it rendered all of that fine variation — which a high-contrast smooth colormap turns into **busy, noisy bands** where the live binary shows **bold, grid-scale swirls**. `gridsize` is load-bearing for the *look*, not just a CPU affordance, so dropping it was a mistake.

The fix: **quantize `fragCoord` to a `gridsize`-pixel grid before computing the field coordinates**, so every pixel in a `gridsize × gridsize` block samples the *same* field point — the C's block replication:
```glsl
vec2 cell = floor(fragCoord / MARB_GRID);
vec2 uv   = (cell * MARB_GRID + 0.5 * MARB_GRID) / iResolution.xy;
uv.y = 1.0 - uv.y;   // then the existing X0/Y/warp/palette code, unchanged
```
One field evaluation per cell, replicated across the block. `MARB_GRID` is baked into the source (like `__SCALE__` / `__ITER__`) since the harness exposes no custom uniform; a change to Magnification rebuilds the shader on `reinit()`, the same debounced path as Scale/Complexity.

**DPR.** `gridsize` in the xml is a **window-pixel** size, and the non-retina demo video is the frequency target. The harness renders at *device* resolution and `fragCoord` is in device px, so `MARB_GRID = gridsize × devicePixelRatio` device px — i.e. `gridsize` *CSS* px per block on any display (2 CSS-px blocks at the default, matching the demo; on a retina Mac that is 4 device px, not the 2 device px = twice-too-fine a plain `gridsize` would give). Baked at the current DPR; a rebuild re-bakes if the DPR changes. *Limitation:* lowering the live **Resolution** slider (or the harness's adaptive throttle) shrinks the canvas below device resolution while `MARB_GRID` stays a baked device-px constant, so the blocks grow in CSS terms at reduced resolution — acceptable, since Resolution defaults to 1 and this shader rarely trips the throttle.

## Morph
The third noise axis `Z` is driven from `iTime`: `Z = uint(iTime * 35.8) & 0xFFFFu`. The C does `Z += 2` per draw at the live binary's ~17.9 fps ⇒ **~35.8 Z-units/sec**, so `MARB_ZRATE = 35.8` matches the live morph speed (just smoother — continuous integer `Z` steps at 60 fps instead of jumps of 2 at ~18 fps). `config.speed` rides `iTime` (the harness scales it), so Speed is the morph-rate multiplier; default `speed = 1` = the C's pace. `config.resolution` (a harness knob, default 1 = crisp) is the "make it cheaper" render-scale lever.

## Config
Mirrors `hacks/config/marbling.xml` where the harness allows:
- **Speed** — morph-rate multiplier (harness scales `iTime`; the C has no such knob, added for the harness idiom). `live`.
- **Scale** — `st->scale`, noise cells across the screen (1-20; floored to 1, the C's clamp). Baked (see below).
- **Complexity** — `st->iterations`, domain-warp passes (1-10; floored to 1). Baked.
- **Magnification** — `st->grid_size`, the block-replication grid (1-20, default 2; floored to 1). The field is rendered at window ÷ Magnification, so larger = **bolder, blockier** swirls, smaller = **finer, busier** detail (1 = per-pixel). Baked. See [Magnification](#magnification-gridsize--kept-because-the-c-renders-at-grid-resolution) above.
- **Resolution** — harness render scale. `live`.

**Harness limitation & how Scale/Complexity/Magnification stay adjustable.** `shadertoy.js` (shared by 30 hacks, unmodified here) exposes only `iResolution`/`iTime`/… and no way to set a custom uniform, so `scale`/`iterations`/`gridsize` **cannot be live uniforms**. They are instead **baked into the shader source** at build time (the `__SCALE__` / `__ITER__` / `__GRID__` tokens → `const float MARB_SCALE` / `const int MARB_ITER` / `const float MARB_GRID`, which also lets the domain-warp loop unroll). They are declared `live: false`, so the host calls `reinit()` on a change; `marbling.js` wraps the harness instance and, on `reinit()`, **rebuilds** — tears down the old shadertoy instance and starts a fresh one with a newly baked source (and a freshly re-rolled palette, matching the CPU port's `init()` and the C's reset). The rebuild is **debounced (~120 ms)** so dragging a slider coalesces into one rebuild instead of thrashing the WebGL context. `speed`/`resolution` stay fully live (the harness reads them from the shared `config` object each frame).

The C's keyboard `+`/`-`/`<`/`>` nudge Scale/Complexity; the host owns keys, so those map to the sliders.

## Deviations from the C
- **Float coords, integer field.** Pixel coordinates enter as floats (`uint(uv * scale * 256)`) instead of the C's integer accumulator, but the noise/fbm/warp/low-byte-banding pipeline is the C's fixed-point math bit-for-bit. Pixel values won't be byte-identical to any one C launch only because the colormap is a fresh random roll (as it is on every C launch).
- **Continuous morph.** `Z` advances continuously from `iTime` at the C's ~35.8 units/sec (finer, smoother steps than the C's `Z += 2` at ~18 fps), not per-draw. Same average morph speed.
- **Grid kept; no cap/threads.** The C's `g`-block grid (`gridsize`/Magnification) is reproduced by quantizing `fragCoord` to a `gridsize`-pixel grid, so each block resolves to one field sample exactly as the C. Only the SIMD vectors, pthreads and the canvas port's `MAX_CELLS` cell cap are gone. (One shader invocation still runs per pixel — no perf win from the grid — but the *look* is the C's grid resolution, not over-rendered per-pixel noise.)
- **Scale/Complexity/Magnification baked, not live** (harness has no custom uniforms) — a change rebuilds the shader (see Config). `Speed` is an added harness knob; the C hardcodes the morph rate.

## Verification
Headless, dev server at <http://localhost:8000/#marbling> (`scratchpad/` puppeteer rig):
- **Marble character matches** — side-by-side vs the CPU `marbling.js` capture: same domain-warp veining, the same swirl-"eye" structures, the same scale/density at the default `scale 10` / `iter 5`.
- **Magnification renders at grid resolution (the re-added fix)** — a fixed-palette A/B (a seeded RNG holds the colormap + morph phase constant, isolating the block size) across `gridsize ∈ {1,2,4,8}` at 820×560 dpr 1: `gridsize 1` is busy per-pixel filaments (the first cut's over-rendered look), `gridsize 2` (the default) coarsens the high-frequency speckle to the C's subtle 2px blocks, and `gridsize 4`/`8` are progressively bolder, blockier blobs. Monotonic and load-bearing — the block replication works. Confirmed on a high-contrast full-rainbow roll, the worst case for over-rendered noise.
- **Animates** — 99.3% of pixels change over a 5 s window within one run (`compare -metric AE`), confirming the `Z`-driven morph.
- **Palette varies per run and is smooth** — three runs gave pink/magenta, green/olive, and plum/teal smooth gradients (no harsh rainbow).
- **Shader compiles at the parameter edges** — `iter ∈ {1,10}`, `scale ∈ {1,20}` all compile in a real WebGL2 context; `gridsize` bakes to a plain `const float` (no loop dependency) and rendered at `{1,2,4,8}`, so the rebuild path is safe.
- **Lifecycle clean** — start creates one overlay canvas; `reinit()` (with a changed scale) swaps it 1-for-1 with no context leak; `pause`/`resume`/`stop` are clean; `getStats` works across the rebuild.
- `node --check hacks/marbling.js` passes; source is ASCII-safe.

**Not yet live-A/B'd** against the XQuartz binary at the time of writing (the field is a faithful transcription of the already-live-verified CPU port, so the character should match; a final live A/B is worthwhile).

**Local dev:** ES-module `import`s need a real server — `python3 -m http.server`, then <http://localhost:8000/#marbling>.
