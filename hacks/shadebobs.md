# shadebobs — port notes

Port of `shadebobs.c` (Shane Smit, 1999).

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/shadebobs.c` (~470 lines)

One-liner: oscillating oval patterns that look something like vapor trails or neon tubes.

## Algorithm
A few little **bobs** zip around the screen along smoothly-turning paths. Each bob carries a precomputed **shaded dome kernel** (`anDeltaMap`) — a small `diameter × diameter` blob that is `~9` at the centre and falls smoothly to `0` at the rim (`delta = 9 - (dist/radius)·8`, clamped at 0). Half the bobs are **light** (positive kernel = add intensity) and half are **dark** (negated kernel = subtract), alternating by index, so the picture stays in colour balance — "a light side, a dark side, and it keeps the world in balance".

The persistent accumulation buffer holds a **fractional intensity per pixel** (the palette index is its floor). Each frame, for every bob: move it, then for every kernel cell `buf[pixel] = clamp(buf[pixel] + f·kernel, 0, ncolors-1)`, where `f` is the fraction of a full C step this frame represents (see **Timing**; `f = 1` is the C exactly). `floor(buf[pixel])` is mapped through a palette that ramps **black → base colour → white** (index 0 = black), so dense overdrawn regions read bright and the dark bobs carve them back toward black. The bobs revisit their trails, so intensity blooms into glowing oval/figure-8 tubes.

Bob motion (the C's `MoveShadeBob`): an `angle` walks a sin/cos lookup table (`velocity` px/step along `(sin, cos)`), turning by `angleInc` each step; `angleDelta` drifts toward `angleInc` and, when it crosses, a fresh random delta/inc is rolled — so the path keeps morphing forever and never settles into a dead line. Positions wrap around the field.

Every `cycles · degreeCount` frames (the C's `draw_i >= cycles` branch) the buffer is cleared to black, the bobs are reset to fresh positions, and a new random palette base colour is rolled. This is the **"Duration"** knob and is exactly what keeps the field from ever saturating to a solid block.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `squiral.md`.

## Timing — time-based smooth motion
The live binary runs **~33.9 fps** (820×560, `-fps`: 33.9 fps at 66.1% load; sleep slice = 10000 µs = stock delay, a clean reading), i.e. ~0.56 of a 60 Hz refresh. A discrete one-step-per-tick loop at that pace advances the bright bob *head* only every **other** frame — which reads as **visibly jerky**, because shadebobs (unlike most hacks) has a fast bright leading edge the eye tracks. So instead of stepping a whole number of times per frame, the loop is **time-based**: each rAF advances by `f = elapsed / (delay + OVERHEAD)` of a C step (≈0.56 at 60 Hz, *constant* frame-to-frame → even, smooth head). To keep the accumulated density identical to the C (one full kernel per `velocity` of travel) each deposit is **scaled by `f`** — hence the fractional `Float32` buffer; depositing a full kernel every frame would over-stamp ~1.8× and bloom the tubes to white too fast. A bob whose per-frame advance would exceed the kernel radius (very low frame rates) is sub-stepped so its trail stays a continuous tube. `OVERHEAD = round(1e6/33.9) − 10000 = 19499` µs (delay is a sleep floor in the C; the live binary's heavy per-frame stamp is its other 66%, which our lighter port must add back to pace alike — see [[framerate-calibration]]).

## Rendering — Uint32 blit at LOGICAL resolution, accumulate (don't clear)
This is a dense per-pixel accumulation field, so it uses the **blit path** (a `Uint32` `ImageData`, `putImageData` once per frame) like `thornbird.js` / `binaryring.js`, not per-pixel canvas calls. The buffer is never cleared between frames except at the periodic reset — only the bob regions change each frame, and the mapped colour is written into the pixel buffer right where the index changes.

To keep retina affordable the field is computed at **LOGICAL** resolution (`canvas px / dpr`) into a small offscreen canvas, then `ctx.drawImage`-upscaled to the device-px main canvas — the same small-offscreen + upscale path as `metaballs.js` / `marbling.js`. The kernel diameter, radius and velocity are derived from the **logical** min dimension (`/25`, `/2`, `/150`), matching the C's "looks the same at any resolution, only smaller" rule.

## Deviations from the C
- **Intensity buffer instead of XGetPixel reverse-lookup.** The C stores colours in the XImage and, per pixel, *linear-searches* the palette to recover the current index, adds the kernel, clamps, and writes the colour back. We store the (fractional) intensity directly in a `Float32Array` and map `floor(intensity)` → palette (the `FIXME: Here is a loop I'd love to take out` loop). This is equivalent: the C clears the image to the black pixel = index 0 at every palette roll, so every stored colour is always a palette entry and the reverse-lookup always succeeds; storing the value skips the search. It is `Float32` (not `Uint8`) only so the time-based loop's `f`-scaled sub-step deposits accumulate without integer-rounding loss (see **Timing**).
- **devicePixelRatio / logical-res field + upscale** (above) — a deliberate retina-perf deviation; the C runs at full window resolution. Math is unchanged, just computed at logical px.
- **Palette base colour** is picked faithfully as three independent random bytes (`[randInt(256), randInt(256), randInt(256)]`), matching the C's `SetPalette` base of three independent `random() % 0xFFFF` channels (here at 8-bit-per-channel resolution); the black→base→white ramp (index 0 forced to black) is the C's `SetPalette` math verbatim, and the base re-rolls at each Duration reset exactly as the C re-runs `SetPalette`. Because the channels are independent and uniform, the base is frequently muted/dark/pastel, not only vivid. (Earlier this port used a fully-saturated `hsl(random, 100%, 50%)` base, which only ever produced vivid neon hues — the one colour deviation, since uniform-RGB random ≠ max-saturation HSL; corrected in the fidelity audit, same fix as `metaballs.js`.)
- **Tiny-field guards.** `radius >= 1` (avoids a divide-by-zero in the kernel build) and `velocity >= 1` (the C's integer `min/150` would be 0 below 150 px, freezing the bobs). Normal screens are unaffected (`diameter ~40`, `velocity ~7` at 1080p logical).
- **No erase transition.** The C's per-reset `XClearWindow` becomes an instant fill of the buffer to black. No wipes module.
- **`degrees` not exposed.** It's a defaults-only resource (`0` = automatic) in the C, not a UI slider; we hardcode the automatic value `(width/6)+400`, clamped `[90, 5400]`, as the C does.

## Correctness self-review
Verified by hand and with a headless node harness (200k steps, 4 bobs):
- **Clamp on every add.** `buf[pos] = clamp(buf[pos] + kernel, 0, ncolors-1)` matches the C's `if(iColorVal >= iColorCount) iColorVal = iColorCount-1; if(iColorVal < 0) iColorVal = 0;`. Harness: buffer values stayed in `0..63` for ncolors=64 — no LUT overflow / colour wrap. **Spot-check in the browser:** colours should ramp cleanly black→base→white with no garish wrap-around speckle.
- **No saturation to a solid block.** Light/dark balance plus the clamp keep the field from filling solid even *without* the reset (harness: 84% lit, never all-max after 200k steps); the real reset every `cycles·degreeCount` frames (≈5300 at defaults) clears it to black periodically. **Spot-check:** the picture should bloom, then visibly clear and recolour after the Duration interval (long at default — turn Duration down to see it sooner; `cycles=0` clears every frame).
- **Kernel stays in bounds.** Stamp wraps each pixel once around the field edge (matching the C), plus a defensive bounds skip. Harness: zero out-of-range writes; the odd-diameter last row/col stay 0 (a no-op pad), exactly as in the C's `diameter*diameter` array filled over `[-radius, radius)`.
- **Path never dies / index always valid.** `angleDelta` always eventually crosses `angleInc` and re-rolls (so no frozen "dead line"), and `(int)nAngle` is guarded into `[0, degreeCount)`. Harness: zero out-of-range angle indices, zero NaN/Inf positions over 800k bob-moves.
- **pause/resume** zeroes `lastTime`, so the first frame after resume advances `f = 0` (no jump); the per-frame `f` is capped (`MAX_STEP_F`) so a long-backgrounded tab can't lurch on refocus. **reinit** re-runs `init()` for a clean black screen. `count` / `ncolors` are `live:false` (they resize the bob list / palette / buffer-index range, so a live shrink could leave stale indices past the new max → reinit clears it); `delay` / `cycles` are `live:true`.

## Config
Ranges mirror `hacks/config/shadebobs.xml`: `delay` (Frame rate, µs, live, inverted, 0–20000), `cycles` (Duration, live, 0–100 — multiplied by `degreeCount` internally for the reset period), `count` (Count, reinit, 1–20), `ncolors` (Number of colors, reinit, 1–255; clamped to `[2,255]` internally as the C does).
