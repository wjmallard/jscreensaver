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

## Deviations from the C
- **In-place blur, split interior/border** — the kernel and in-place feedback match the C, but the C walks the whole buffer in one linear pass (border pixels in sequence) whereas this unrolls the interior fast-path then handles the 1-px border with clamped neighbours. The only difference is a one-row ordering nuance at the very top/edges; visually nil.
- **No SSE / colour-depth code** — the C has SSE2 `glow_blur`/`chromo_2x2_light` plus 8/15/16/24-bit `put_image` packers. The web is always 32-bit RGBA, so only the portable 24-bit path is ported; channel order is canvas-native RGBA (the C's `palaka` is BGRA on little-endian X).
- **No dpr/resolution scaling of spark speeds** — spark velocities/gravity use the **raw C constants** (no `*dpr`, no `/width` factor). This keeps the C's spark *density* (sparks per burst area in pixels), which is what determines the equilibrium brightness; the internal resolution is held near 1024 by the budget so bursts also cover the same frame fraction as the C. On small windows the internal frame is smaller, so bursts cover a larger fraction (busier, slightly brighter) — acceptable and what the C does too.
- **Flash dimmed to half (`FLASH_GAIN = 0.5`)** — calm-tuning. The C's full-strength `chromo` flash washes most of the frame to a bright colored fog (measured default avg ~150/255). Halving it keeps the dark sky between blooms while the burst cores still flare (avg ~85/255). `FLASH_GAIN = 1.0` would be the C's exact strength; the **Light flash** toggle removes it entirely (pure sparks + glow, avg ~68/255).
- **`delay` default 16000 µs** (stock 10000) — a touch calmer; the per-step work (12 sub-steps + a full per-pixel blur) is render-bound near display rate anyway, and `MAX_CATCHUP_STEPS = 3` keeps a backgrounded tab from firing a burst of blurs on refocus.
- **No mouse interaction** — the C lets a button-press launch a shell and defers recycles while the button is held (`button_down_p` / `deferred`). There is no pointer input here, so shells always recycle immediately on death; the deferral bookkeeping is dropped.
- **`SHELLCOUNT`/`PIXCOUNT` exposed as params** — the C fixes them (4 and 500, the 4 for SSE lane packing). Here they are the "Fireworks at once" and "Sparks per shell" sliders (defaults 4/500). High values are intentionally intense (denser → brighter).
- **HSV** — a standard `hsv_to_rgb` stand-in (saturation/value clamped to [0,1], since `rotate_hue` slowly lowers saturation over a shell's life). Vivid by construction (s 0.6–1.0).

## Correctness self-review (won't freeze / over-draw / leak)
- **Bounded pool, no leak** — sparks live in fixed per-shell typed arrays; there is no allocation in the hot loop and no array growth. Dead sparks (`burn == 0`) are skipped; the pool can't grow.
- **No dead-shell freeze** — a shell whose `life` hits 0 is recycled the same sub-step. `recycle` always sets `life >= maxShellLife/6 >= ~83` (even at `maxlife = 0`, `maxShellLife = 501`), so a shell can't recycle twice in one frame and activity never stalls. A 600-frame headless run stayed lit and bounded; `litFrames == all`.
- **Decay, not runaway** — verified the in-place blur reaches a calm equilibrium (vs the washout of a naive ping-pong); the display buffer is fully rewritten each frame (blur overwrites RGB, flash adds, alpha pinned to 255), so nothing accumulates without the decay.
- **Finite / in-range** — across window sizes, dpr 1 and 2, flash on/off, shoot on/off, and the `maxlife`/`shells`/`sparks` extremes, every pixel stayed finite with alpha 255 and channels in [0,255] (spark coords are bounds-checked before the buffer write; `(x|0)` floors keep the index valid).
- **pause/resume/reinit/stop** — `pause` nulls `rafId` (no steps run), `resume` resets `lastTime` (no catch-up burst), `reinit` clears the offscreen buffer to black and re-seeds, `stop` cancels rAF and removes the resize listener. All exercised headlessly without throwing.

## Config
Ranges/defaults/labels mirror `hacks/config/fireworkx.xml`:
- `delay` — **Frame rate** (µs/step, default 16000, `live`, inverted: drag right = faster).
- `maxlife` — **Activity** (0–100, default 32, `live`; the C's `maxlife` → `max_shell_life = pow(10, maxlife/50 + 2.7)`; higher = longer-lived shells = fewer fresh bursts, so the slider reads "dense → sparse").
- `shells` — **Fireworks at once** (1–8, default 4, `reinit` — sizes the shell array + light map).
- `sparks` — **Sparks per shell** (50–1500, default 500, `reinit` — sizes the spark pools).
- `flash` — **Light flash** (default on, `live`; gates `chromo_2x2_light`).
- `shoot` — **Shells upward** (default off, `live`; the mortar-trail launch).

The xml's `showfps` boolean is host chrome (frame-rate overlay), not a hack parameter, so it isn't ported.
