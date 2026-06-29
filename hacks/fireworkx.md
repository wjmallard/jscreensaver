# fireworkx — port notes

Port of `fireworkx.c` ("Fireworkx 2.2", Rony B Chandran, 1999-2013) — pyrotechnic explosions: colorful firework super-blasts with a glowing, smoky afterimage.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/fireworkx.c` (~881 lines). The `.xml` credits "Rony B Chandran; 2004" (year used in `info`); the C header copyright is 1999-2013.

## Algorithm
A small fixed set of **fireshells** (the C's `SHELLCOUNT = 4`) each own a pool of **firepix** sparks (`PIXCOUNT = 500`). Per displayed frame the C runs `FTWEAK = 12` physics sub-steps; each sub-step advances every shell one `explode()` and recycles any whose `life` has run out.

- **recycle** re-arms a shell at a random point: random `life` (from the `maxlife` dial), a random air-drag, optional two-tone / hue-drift / brightness-pulse / "flies" flags, and `PIXCOUNT` sparks given a POWDER-scaled spherical-ish velocity (`xv = frand(2)*POWDER - POWDER`, `yv = sqrt(POWDER^2 - xv^2)*(frand(2)-1)`) and a per-spark `burn` countdown. It then `mix_colors` (fresh vivid HSV hue + a bright flash charge) and rebuilds the shell's light map.
- **explode** advances each spark: velocity `*= air_drag` plus a little jitter, `+ gravity`; sparks that fall past the floor bounce (20% chance, `yv *= -0.24`) or die; live sparks stamp the shell's RGB into the glow buffer. Shells also drift hue (`hshift`), flip 180° twice (`bicolor`), pulse brightness (`vshift`), and fade their flash charge each step.

The **glowing afterimage** is the heart of the hack: the glow buffer (`palaka1`) is **not** cleared between frames; instead `glow_blur()` runs a 3×3 weighted blur (centre ×8 + 8 neighbours, ÷16) **in place** every frame, so isolated sparks spread and fade over a handful of frames (smoke/bloom). A 2×-brighter clamped copy goes to the display buffer (`palaka2`), then `chromo_2x2_light()` additively composites a colored ambient **light flash** per shell (a `1/distance` falloff times the shell's decaying flash charge) so detonations light up the sky.

When **Shells upward** (`--shoot`) is on, a shell first rises as a grey mortar trail from the floor to its random burst height, then detonates.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Rendering — dense per-pixel accumulation field, logical-res + upscale
This is the **dense / accumulating-field** path (like `metaballs`/`strange`), not sparse vector ops. One persistent `Uint8` RGBA glow buffer is stamped with sparks, blurred-and-decayed in place, copied (brightened) into an offscreen `ImageData`, flashed, and `putImageData`'d; the main canvas then `drawImage`-upscales it. To stay affordable on retina the whole simulation runs at a **capped logical resolution** (`RES_BUDGET = 600000` px, kept even for the 2×2 flash blocks) — on full-screen windows this lands the internal width near the C's nominal 1024, and the canvas upscales (the glow is blurry, so the softening is invisible). See `metaballs.md` for the same offscreen-upscale idiom.

The blur is the **in-place** version of the C's `glow_blur` (the non-SSE branch). This is load-bearing: a clean double-buffered (ping-pong) blur conserves energy on flat regions and **washes the screen white**; the C's in-place pass reads already-blurred left/up neighbours, so energy dissipates and the field decays toward black. I verified this against a faithful standalone sim — in-place holds a calm equilibrium (avg display brightness ~80/255), ping-pong climbs and saturates.

## Faithfulness audit (2026-06-27)
Re-checked the whole pipeline against the .c. The generative core (recycle / explode physics, the in-place 3×3 glow blur with its `q>>4` decay + `q>2047?255:q>>3` brightened copy, and the `chromo_2x2_light` 1/distance flash) was already an exact transcription. Fixes applied:
- **Restored the flash to the C's exact strength** (`FLASH_GAIN` 0.5 → 1.0). The previous 0.5 was an eye-tuned dimming with no counterpart in the .c; the C adds the full `flash_r·light_map` (a fresh detonation floods a wide radius with colour, then decays by `flash_fade`). The dimming flattened the hack's headline "colored light flash" feature, so it is removed. The **Light flash** checkbox still turns it off entirely. (Worth a glance against the demo video / live binary — the C's flash is genuinely strong.)
- **Removed the invented `shells` / `sparks` sliders.** `SHELLCOUNT` (4) and `PIXCOUNT` (500) are FIXED compile-time constants in the .c (the 4 for SSE lane packing), not xml resources; they are constants here now, so config mirrors the xml exactly.
- **`max_shell_life` truncated to int** (the C's `unsigned int`), so every derived `life`/`pixlife` and the `< 1000` flash-fade branch are integer, matching the C bit-for-bit at the boundary (maxlife 14 → 0.998, 15 → 0.995).
- **HSV quantized like the C** — `((c*65535)|0) >> 8` (16-bit channel, high byte) instead of `round(c*255)`.

## Deviations from the C
- **In-place blur, split interior/border** — the kernel and in-place feedback match the C, but the C walks the whole buffer in one linear pass (border pixels in sequence) whereas this unrolls the interior fast-path then handles the 1-px border with clamped neighbours. The only difference is a one-row ordering nuance at the very top/edges; visually nil.
- **No SSE / colour-depth code** — the C has SSE2 `glow_blur`/`chromo_2x2_light` plus 8/15/16/24-bit `put_image` packers. The web is always 32-bit RGBA, so only the portable (non-SSE, 24-bit) path is ported; channel order is canvas-native RGBA (the C's `palaka` is BGRA on little-endian X, so r/b are swapped at the write site to land the same displayed colour).
- **No dpr/resolution scaling of spark speeds** — spark velocities/gravity use the **raw C constants** (no `*dpr`, no `/width` factor). This keeps the C's spark *density* (sparks per burst area in pixels); the internal resolution is held near the C's 1024 by `RES_BUDGET` so bursts also cover the same frame fraction as the C. On small windows the internal frame is smaller, so bursts cover a larger fraction (busier) — acceptable, and what the C does too. The reduced internal resolution is itself faithful: the C ships `.lowrez: true` ("Too slow on macOS Retina screens otherwise").
- **`delay` default is the stock 10000 µs** (the slider maps 1:1 to the xml resource). The rAF loop adds `OVERHEAD = 16178 µs` so `(delay + OVERHEAD)` reproduces the live binary's effective rate: measured against the live `-fps` overlay fireworkx runs **38.2 fps**, while the port at the stock delay ran ~100 fps (2.6× fast — the 12 sub-steps + full-buffer blur per frame make the framework overhead large here); `10000 + 16178 = 26178 µs → 38 fps`. Each displayed frame still runs `FTWEAK = 12` physics sub-steps, so OVERHEAD paces displayed frames, not the sub-step count. A calibration, not a tuning knob — see the framerate-calibration note. `MAX_CATCHUP_STEPS = 3` keeps a backgrounded tab from firing a burst of blurs on refocus.
- **No mouse interaction** — the C lets a button-press launch a shell and defers recycles while the button is held (`button_down_p` / `deferred` / `recycle_oldest`). There is no pointer input here, so shells always recycle immediately on death; that bookkeeping is dropped (it only ever runs under mouse input, so this is faithful for the unattended case).
- **HSV stand-in** — a standard `hsv_to_rgb` (saturation/value clamped to [0,1], since `rotate_hue` slowly lowers saturation over a shell's life), quantized exactly as the C (`trunc(C*65535) >> 8`). Vivid by construction (s 0.6–1.0). The spark colours come from this **per-shell HSV** (`mix_colors`: `h = rnd(360)`, `s = frand(0.4)+0.6`, `v = 1.0`), **not** from `make_smooth_colormap` — the C only builds a smooth colormap for 8-bit pseudocolor visuals, which is never the path here.

## Correctness self-review (won't freeze / over-draw / leak)
- **Bounded pool, no leak** — sparks live in fixed per-shell typed arrays; there is no allocation in the hot loop and no array growth. Dead sparks (`burn == 0`) are skipped; the pool can't grow.
- **No dead-shell freeze** — a shell whose `life` hits 0 is recycled the same sub-step. `recycle` always sets `life >= maxShellLife/6 >= ~83` (even at `maxlife = 0`, `maxShellLife = 501`), so a shell can't recycle twice in one frame and activity never stalls. A 600-frame headless run stayed lit and bounded; `litFrames == all`.
- **Decay, not runaway** — verified the in-place blur reaches a calm equilibrium (vs the washout of a naive ping-pong); the display buffer is fully rewritten each frame (blur overwrites RGB, flash adds, alpha pinned to 255), so nothing accumulates without the decay.
- **Finite / in-range** — across window sizes, dpr 1 and 2, flash on/off, shoot on/off, and the `maxlife` extremes, every pixel stayed finite with alpha 255 and channels in [0,255] (spark coords are bounds-checked before the buffer write; `(x|0)` floors keep the index valid).
- **pause/resume/reinit/stop** — `pause` nulls `rafId` (no steps run), `resume` resets `lastTime` (no catch-up burst), `reinit` clears the offscreen buffer to black and re-seeds, `stop` cancels rAF and removes the resize listener. All exercised headlessly without throwing.

## Config
Mirrors `hacks/config/fireworkx.xml` exactly (its four real resources):
- `delay` — **Frame rate** (µs/step, default 10000, `live`, inverted: drag right = faster). See the calibration note above.
- `maxlife` — **Activity** (0–100, default 32, `live`; the C's `maxlife` → `max_shell_life = trunc(pow(10, maxlife/50 + 2.7))`; higher = longer-lived shells = fewer fresh bursts, so the slider reads "dense → sparse").
- `flash` — **Light flash** (default on, `live`; gates `chromo_2x2_light`).
- `shoot` — **Shells upward** (default off, `live`; the mortar-trail launch).

`SHELLCOUNT` (4) and `PIXCOUNT` (500) are **fixed compile-time constants** in the C (the 4 for SSE lane packing), not xml resources, so they are constants here too — the earlier "Fireworks at once" / "Sparks per shell" sliders were invented and have been removed.

The xml's `showfps` boolean is host chrome (frame-rate overlay), not a hack parameter, so it isn't ported.
