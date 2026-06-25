# marbling — port notes

Port of `marbling.c` by Jamie Zawinski & Dave Odell (2021-2022) — marble-/cloud-like patterns generated **procedurally** from Perlin Noise + Fractal Brownian Motion, not by stirring ink. The pattern slowly morphs because the noise is sampled in 3D and the third axis is time.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/marbling.c` (~634 lines, heavily SIMD/pthreads). See [[squiral]] for the shared skeleton, [[binaryring]] for the Uint32-blit idiom, [[demon]] for `hslToUint`.

## What it actually is (the prompt's "stir/displacement" hint was wrong)
The spawning hint described a suminagashi "drop ink, then stir with tines that advect a colour field." **The real `marbling.c` does none of that** — there is no persistent ink buffer and nothing is advected. It is a pure procedural noise field:

1. **Perlin "improved noise"** (Ken Perlin, SIGGRAPH 2002) in 3D — the canonical fade/grad/lerp lattice noise. (The C does it in 16-bit fixed point with SIMD vectors and an 8-bit perfect-hash; we do the textbook float version with the standard 256-entry permutation table.)
2. **Fractal Brownian Motion** — sum of `octaves = 2` octaves of that noise, amplitude scaled by `G = 2^-0.5 ≈ 0.707` and frequency doubled each octave (matches the C's `fbm()`).
3. **Domain warping** — for each pixel, iterate `p = fbm(p + X, p + Y, p + Z)` `iterations` times, feeding the previous output back into the input. This FBM-of-FBM feedback is what creates the swirling marble striations (the classic Inigo Quilez / "Book of Shaders 13" pattern, which the C header cites).
4. **Colour** — the C maps the low byte of `p` onto a 256-entry smooth colormap: `(p & 0xff) * ncolors >> 8`. So only the *fractional* part of `p` selects a colour and the map **cycles**, banding the warped field into stripes. We do the float equivalent: `floor(fract(p) * ncolors)`.
5. **Animation** — `marbling_draw()` does `st->Z += 0.01` every frame (in fixed point `0.01 * 256`), walking the noise's time axis so the whole field flows.
6. **Magnification** (`gridsize`) — the C computes a *reduced* grid (one noise value per `g`-by-`g` block) and replicates each value into the block. We do exactly this: `gw*gh` noise samples per frame, each splatted into its `g*g` cell of the full-resolution buffer.

## Shared skeleton (inherited)
Standalone ES module exporting `title`/`info`/`start(canvas) → { stop, pause, resume, reinit, config, params }`; rAF **lag-accumulator** loop (fixed timestep paced by `config.delay` µs) instead of the C's `usleep`; `devicePixelRatio` folded in (backing store sized in device px, noise coords derived from the canvas size so the look is dpr-independent); shared config box via `params`.

## Rendering
Dense, every-pixel field recomputed each frame → the **blit path**: a `Uint32Array` view over one `ImageData`, written cell-by-cell, then a single `ctx.putImageData` per frame (per [[hack-rendering-perf]]; same idiom as [[binaryring]]/[[demon]]). Colours are packed little-endian `0xAABBGGRR` via the shared `hslToUint`.

**Cost / default delay:** the per-pixel domain-warped FBM is genuinely heavy (each cell does `iterations * octaves` noise evaluations). The reduced internal grid (`gridsize`, default 2 → a quarter of the pixels) is the main affordance — raise **Magnification** for a big speedup (blockier), lower it to sharpen (slower). The catch-up cap is set low (`MAX_CATCHUP_STEPS = 4`) precisely because `step()` is expensive: a slow frame should fall behind, never stack a burst. Default `delay` is **16000 µs** (~one step/refresh on a 60 Hz display), a touch calmer than the xml's 10000; the morph is intentionally slow regardless (`zspeed` 0.01/frame, as in the C).

## Deviations from the C
- **Fixed point → float.** The C is 16-bit fixed-point Perlin with GCC/Clang SIMD vectors, an 8-bit perfect-hash gradient table, and pthreads. None of that ports to a browser, so the noise/FBM are reimplemented in plain doubles with the canonical permutation table. The *structure* (improved-noise fade/grad/lerp, 2-octave FBM with `G = 2^-0.5`, the `iterations`-deep domain warp, the `Z += 0.01` time walk, the `gridsize` block replication, the cyclic low-fraction colormap index) is faithful; exact byte-for-byte pixel values are not (and can't be — different RNG/hash, different rounding).
- **FBM biased to [0,1].** Perlin noise is ~[-1,1]; the C's fixed-point pipeline keeps the warp feedback in a positive 16-bit range. We bias each octave with `*0.5 + 0.5` so the iterated `p = fbm(p+…)` feedback stays positive and bounded (otherwise the warp can walk off into a flat region). Only the fractional part of `p` is used for colour, exactly as in the C, so this bias doesn't change the banding behaviour.
- **Vivid rainbow palette** instead of the C's `make_smooth_colormap` (muted random gradient) — per the porter brief's preference for vivid `hsl()` palettes. Exposed as `ncolors` (map size) + `hue` (starting colour) knobs; the C hardcodes 256 entries and a random gradient.
- **No threads.** The C splits scanlines across `hardware_concurrency()` worker threads; we run the single rAF loop (the reduced grid keeps it affordable).
- **Keyboard +/-/</> (live scale/iterations nudges) are not wired** — those map to the **Scale** and **Complexity** sliders in the config box instead (the host owns keys).

## Correctness self-review
This hack has no state machine, no figure to close, and no clear-sweep, so the classic failure modes (dead lines / never-resetting sweep params / exact-float-equality closures) don't apply. What I verified instead, with a headless node harness driving the rAF queue:
- **Field is bounded and fully opaque** — every frame's R/G/B span 0..255 and alpha is always 255 (no transparency leak, no NaN/overflow blowing out a channel). `fract(p)` keeps the colour index in `[0, ncolors)` regardless of how large `p` grows under domain warping, and the index is re-clamped defensively.
- **First frame already looks right** — 89 distinct colours sampled across one frame (the field is structured from the start, not a degenerate flat/off-screen seed); Z starts at 0 and the noise is non-zero immediately.
- **It animates** — the buffer checksum changes frame-to-frame, confirming the `z += zspeed` time-walk actually morphs the field (no frozen output).
- **Lifecycle** — `pause()`/`resume()` (resets `lastTime = 0` so there's no catch-up burst on resume), `reinit()` (rebuilds grid+palette via `init()`), and `stop()` (cancels rAF + removes the resize listener) all run clean.
- **Live vs. non-live params** — `gridsize`/`ncolors`/`hue` resize the grid or rebuild the palette → `live: false` (re-run `init()` via `reinit()`); `delay`/`scale`/`iterations`/`zspeed` are read every step → `live: true`.

**Worth a browser spot-check (new hack to the gallery):** the *aesthetics* — whether the default `scale` 10 / `iterations` 5 give a convincingly marble-like look (vs. cloudy or noisy), and whether the morph speed reads as pleasant rather than busy. The math is verified correct and bounded; the tuning is by feel. If it looks too "noisy" rather than "marbled," nudging `iterations` up or `scale` down deepens the striations.

## Config
Units/defaults/labels mirror `hacks/config/marbling.xml`: `delay` (µs/frame, xml 10000 → eased to 16000), `gridsize` → **Magnification** (1-20, default 2), `scale` → **Scale** (1-20, default 10, sparse..dense), `iterations` → **Complexity** (1-10, default 5). Added for parity with the other ports: `ncolors` (palette size, 256), `hue` (palette start, deg), `zspeed` (morph speed, the C's hardcoded 0.01). The `delay` slider uses `invert: true` (the xml's `convert="invert"` "Frame rate" slider — drag right = faster, shows raw µs).

**Local dev:** ES-module `import`s need a real server — `python3 -m http.server` in the repo, then <http://localhost:8000/#marbling>. `file://` double-click fails (CORS on the `null` origin); GitHub Pages serves over http, so production is fine.
