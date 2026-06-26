# xflame — port notes

Port of `xflame.c` by Carsten Haitzler (1996; TrueColor/utility/image work by Rahul Jain, Daniel Zahn and jwz, 1996-2018) — a classic cellular "licking fire" effect. Pulsing flames rise from the bottom of the screen.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/xflame.c` (~826 lines). Follows the shared skeleton documented in `See [[squiral]]`; rendering style mirrors `See [[eruption]]` (Uint32 fire-palette blit) and `See [[marbling]]` / `See [[metaballs]]` (offscreen field + `drawImage` upscale).

## Algorithm
A heat field lives at HALF the image resolution (`fwidth x fheight`, 1-cell padded). Each frame (`xflame_draw`):
1. **FlameActive** — the bottom "active" row (one buffer row below the visible area) is re-seeded: each cell drifts by `random()%variance - vartrend` and is stored mod 255. The drift has a small positive bias, so seed cells random-walk around the 0-254 ring. Optional `bloom` occasionally surges `residual`/`hspread`/`vspread`, which then ease back 10%/frame toward their base values.
2. **FlameAdvance** — heat propagates UPWARD. The field is swept bottom-to-top; every lit cell pushes `vspread/256` of its value into the cell directly above and `hspread/256` into the two diagonal-up cells (clamped at 255), then keeps `residual/256` of itself. Because the sweep goes bottom-up, a hot seed cascades up many rows in a single pass. `top` tracks the highest non-empty row as a work bound.
3. **Flame2Image** — the half-res field is 2x-upscaled into the image (each cell -> a 2x2 block with bilinear-ish interpolation of its right/below/below-right neighbours), and each value indexes a `ctab` fire LUT (black -> red -> orange -> yellow -> white).

The stock constants are deliberately tuned for **marginal stability**: `vspread + 2*hspread == 256 - residual` (97 + 60 == 256 - 99, i.e. 157 == 157). Total heat per row is conserved as it rises, so the fire neither dies out nor saturates the screen — it licks tall and the random seed makes the tips flicker.

## Rendering / retina
The field is computed at **logical** resolution (`innerWidth/innerHeight`, even dims as the C forces), written into an offscreen Uint32 `ImageData`, then `ctx.drawImage`-upscaled (bilinear) to the device-res canvas. So the per-frame cost does NOT scale with `devicePixelRatio`. A `MAX_CELLS = 540000` cap shrinks the field on very large displays (1080p runs native; 1440p/4K shrink a touch then upscale — the soft bilinear suits fire). The C already worked at half-res-then-2x-double; this is the same structure with the device-res blit replaced by a GPU upscale.

## Deviations from the C
- **Dropped the optional bitmap "logo" feature** (`loadBitmap` / `FlamePasteData` / the built-in `bob_png`, and the `--bitmap`/`--baseline` options). The C can inject a grayscale image into the flame so a logo appears to burn; this port renders the **plain flame only**, per the brief. (`info.description` is "Pulsing fire.", the first sentence of the xml's "Pulsing fire. It can also take an arbitrary image and set it on fire too.")
- **Fixed fire LUT.** The C derives `ctab` from a configurable `foreground` color (default `#FFAF5F`); we bake in that default (`InitColors`'s `(2j - (255-fg))*3` ramp, clamped), so there's no runtime foreground/color picker. The flame colors match stock xflame.
- **Full-frame blit.** The C's `DisplayImage` only blits the sub-rectangle from `top` downward (a perf optimization that relies on rows above `top` already being black). We render every visible row each frame; since rows above `top` are always 0 -> `ctab[0]` (black), the output is identical, just simpler and stale-row-proof. `top` is still maintained as the FlameAdvance work bound (faithful).
- **Stability renormalization (not in the C).** The heat automaton's per-step energy multiplier is `(vspread + 2*hspread + residual)/256`, and the stock constants sum to exactly 256 (marginal stability). The C exposes these as raw resources, so dragging "Flame height" (`vspread`) past the balance pushes the sum over 256 and the field runs away to a solid white-hot block. `FlameAdvance` now renormalizes the three coefficients down to the 256 budget whenever they exceed it, so any slider combo stays a live flame — the *ratio* (hence the look: higher vspread reads as a taller flame) is preserved, and it is a no-op at the defaults.
- **No XOR / feedback tricks needed** — the C uses a plain XImage, directly emulated by the Uint32 ImageData.
- `showfps` (xml boolean) is host chrome, not ported.
- Loop uses the shared fixed-timestep rAF lag-accumulator instead of `usleep(delay)`; default `delay` 10000 µs (the xml default).

## Config
Mirrors the C's `xflame_defaults`/`xflame_options`. The xml only surfaces `delay` + `bloom`, but the spread/residual/variance knobs are real C command-line resources, so they're exposed as sliders too:
`delay` (µs/frame, 10000, "Frame rate", inverted), `vspread` ("Flame height", 97), `hspread` ("Flame spread", 30), `residual` ("Persistence", 99), `variance` ("Turbulence", 50), `vartrend` ("Cooling", 20), `bloom` ("Blooming", on). All are **live** (read every frame; the spread/residual knobs ease toward the new value over ~20 frames, matching the C's relaxation). None resize a buffer, so `reinit()` is just a manual clear + reseed. Note: the spread/residual defaults are tuned for the marginal-stability balance above. Dialing them low makes the flame die down (faithful, shorter fire); dialing them high no longer saturates the screen — the renormalization deviation above clamps the high side, so extra "Flame height" just biases the fire taller instead of running away.

## Correctness self-review
- **Won't go all-black or all-white.** A headless numeric harness ran the core `FlameActive`+`FlameAdvance` for 600 steps on a 200x120 field: values stayed finite and in 0-76, ~56% of cells nonzero, with a clean hot-at-base/fading-up gradient reaching ~58% of the field height. The 157==157 balance held. So the fire is lively and bounded with the stock constants.
- **No overflow.** `(v1 * spread) >> 8` operates on products <= 255*4096 (`spread` is clamped to 0..4096), well under 2^31 — no `>>` int32 overflow. Heat is `Uint8Array`, so spread writes clamp at 255 (matching C's `MAX_VAL`) and self-decay truncates mod 256 exactly like the C's `unsigned char` cast.
- **Seed wrap is exact.** `flame[i] = v1 % 255` reproduces the C's `(unsigned char)(v1 % 255)`: JS `%` truncates toward zero like C, and the `Uint8Array` store reproduces the unsigned-char wrap for negative results (e.g. -5 -> 251).
- **No freeze / no frozen rows.** `top` is always set at least one row above the topmost lit row (`newtop = y-1` whenever a row had any content), so every row with heat is always re-processed (and re-decayed); rows above `top` are guaranteed 0. Rendering the full frame means no stale content can persist.
- **pause/resume/reinit** are the standard skeleton; `resume` resets `lastTime` so there's no catch-up burst, and `reinit`/`resize` rebuild the field and offscreen cleanly.
