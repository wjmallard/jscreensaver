# rdbomb — port notes

Port of `rdbomb.c` (a.k.a. RD-Bomb) by Scott Draves (1997), in the xscreensaver framework by Jamie Zawinski. A **reaction-diffusion** texture: growing square-ish blobs that collide and "react in unpredictable ways", periodically re-seeded ("re-bombed") with a fresh blob and palette.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/rdbomb.c` (~570 lines). Technique twins: see [[metaballs]] / [[marbling]] for the offscreen-field + `drawImage`-upscale blit path, and [[squiral]] for the shared skeleton.

## Algorithm
Two `unsigned short` chemical fields, `r1` (substrate) and `r2` (activator), sit on a **toroidal** grid (the C pads each field with a 1-cell wrap border). Each reaction sub-step:
1. **Diffusion** — each cell is averaged with its 4 neighbours (three weighted variants, `diffusion` 0/1/2; variant 0 keeps a strong self-weight, 1/2 use power-of-two weights).
2. **Reaction** (John E. Pearson, *Science*, July 1993) — compute `uvv ~ r1*r2*r2`, then feed `r1` back toward its max while `uvv` consumes it, and grow `r2` where `uvv` is high while it decays elsewhere (three rate variants, `reaction` 0/1/2).
3. **Clamp** both fields to `[0, 65535]` and **double-buffer** (read `a`, write `b`, swap), so the Laplacian always reads a coherent previous state.

`r1` is mapped through a cycling colourmap (`(r1>>8) % ncolors`). Every `epoch` sub-steps the field is **re-bombed**: reset to equilibrium (`r1=65500`, `r2=11`), a small random square blob of `r2` dropped in the centre, and `reaction`/`diffusion`/`radius`/palette re-rolled. The C runs **3 sub-steps per displayed frame** (`chunk=3`); this port keeps that.

## Rendering / retina
Per-pixel dense field, so the **BLIT path**: the field is computed on a small offscreen canvas into a `Uint32` `ImageData`, then `ctx.drawImage` **upscales** it to the device-resolution canvas. The field grid is sized at **logical** resolution (`canvas.width / dpr`) and then **capped to `MAX_CELLS = 65000`** preserving aspect — so retina never multiplies the compute cost. This is also faithful: the C's own RD grid is small (typ. 64..576 px) and tiled/scaled to fill the window. **Grid cap: 65000 cells** (≈ 312×208 on a 16:10 screen); ×3 sub-steps ≈ 195k cell updates per frame.

## Deviations from the C
- **Retina downscale + grid cap** (above): compute at capped logical resolution, GPU-upscale. The C computed a small grid and X11-tiled it; we compute one capped grid and bilinear-upscale it. Mandatory for per-pixel perf on hi-DPI.
- **Tile / wander omitted** — the xml's `size` ("Fill screen"), `speed` ("Wander speed") and explicit `width`/`height` ("X/Y tile size") make the RD tile smaller than the screen and let it drift/bounce/tile. The defaults are `size=1.0`, `speed=0.0` (full screen, no wander), so the **default behaviour is unchanged**; the smaller-tile/wander feature is not ported (those four knobs are dropped from the config box).
- **Palette** — the C calls `make_smooth_colormap` (a muted random gradient) each epoch. Per the project's house style we build a **vivid smooth rainbow**, re-rolled with a random hue offset + direction each epoch, so the texture changes colour on every re-bomb. Index mapping (`(r1>>8) % ncolors`) is unchanged; the dithered-colormap path (`mc[]`) is not needed.
- **`epoch` eased** — default lowered from the xml's **40000** to **10000** sub-steps so a re-bomb is visible in a minute or two (at the default ~33 fps × 3 sub-steps). Range still the xml's 1000..300000; raise it for the stock cadence.
- **`reaction`/`diffusion` as Auto/0/1/2 radio group** (the xml spinbuttons' `-1` = "Auto"); `-1` re-rolls per epoch exactly as the C does. The C's rule "if reaction==2 && diffusion==2 then both=0" is preserved.

## Correctness self-review
- **No explosion / NaN** — the arithmetic is the C's verbatim. I verified by hand that every intermediate stays under 2³¹, so the bit-shifts (`>>16`, `>>15`, `>>10`, `>>2`, `>>3`, `<<1..3`) behave identically to C int math: the worst product is `(r1>>1)*r2` ≤ `32767*65535 = 2,147,385,345 < 2³¹`, which is exactly why the C shifts `r1` right by 1 first. Both fields are clamped to `[0, 65535]` every cell before storing into `Uint16Array`, so values can never wrap or drift out of range.
- **Headless harness** (`scratchpad/rdbomb_harness.mjs`) runs all 9 `(reaction, diffusion)` combos for 3000 sub-steps on a 64×48 grid: **all stay finite and in `[0, 65535]` (no NaN, no out-of-range)**; all **auto-reachable** combos (reaction 0/1 × diffusion 0/1/2) form patterns (non-zero span). `(reaction=2, diffusion=1)` decays to a uniform field — a genuine "stable uniform" regime of these Gray-Scott rates (it dies even with a large seed), faithful to the C; it is only reachable by **explicitly** picking reaction=2, since auto-selection never picks 2. `(reaction=2, diffusion=2)` is forced to `(0,0)` by the C rule and never runs as (2,2).
- **Re-bomb branch verified** — `frame=0` at `init()`, and the epoch test (`frame % epoch == 0`) runs at the top of each sub-step, so the very first sub-step re-bombs: it fills both buffers, builds the palette, and picks the variants/radius **before** any pixel is mapped. So the screen seeds itself on frame one (no black/blank start), and `reinit()` (config change / "Reset to defaults") gives a clean fresh re-bomb.
- **Edge handling** = toroidal wrap, copied into the padded border every sub-step before the update — matches the C, so no seams.
- **pause/resume / stop** — standard skeleton; `resume()` resets `lastTime` so a long pause doesn't fire a catch-up burst, and the catch-up cap is low (4) because `step()` is heavy.
- **Termination** — there is none to get stuck on: the loop runs forever, re-bombing every epoch; no closure/float-equality condition that could fail to fire.

## Config
Tunable in-browser via the shared `config-box.js`. `delay` (Frame rate, µs, `invert`), `epoch` (re-bomb interval, sub-steps) and `radius` (seed radius, -1=auto) are **live**; `reaction`, `diffusion` (Auto/0/1/2) and `ncolors` are **not live** (they re-roll the field/palette, so a change re-runs `init()` via `reinit()`, which `frame=0` makes re-bomb with the new settings).
