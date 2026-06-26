# swirl — port notes

Port of `swirl.c` by M. Dobie & R. Taylor (1994; turned standalone by jwz, 1997) — flowing, **palette-cycling** swirly patterns. A handful of spiral "knots" define a static per-pixel field; the animation comes from rotating the colourmap, with a fresh field painted every so often.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/swirl.c` (~1446 lines, mostly X11 colormap plumbing). See [[squiral]] for the shared skeleton, [[metaballs]]/[[marbling]] for the offscreen-field + `drawImage`-upscale (retina-downscale) idiom.

## What it is
1. **Knots.** Each swirl scatters `n_knots = rand(count/2) + count + 1` knots (default `count = 5` → 6-8 knots). Each knot has a random position, a random mass `m ∈ [1, 5]` that is negated ~50% of the time, and a random spiral **type**: `ORBIT`, `WHEEL`, `RAY`, or `HOOK`. (The C's `ALL` mode pointedly omits `PICASSO`; we mirror that — `PICASSO` exists in the code but is never seeded.)
2. **Field.** Every pixel's value is the signed sum over all knots of that knot's contribution at the pixel (`do_point`): a `1/(1+dist)` falloff for orbit, an `atan2`-based angle term for wheel/ray/hook, etc. `+ve` masses add, `-ve` masses subtract. The integer total is folded into `[0, ncolors)` (the C's asymmetric `%dcolours+2` / `dcolours-(|v|%(dcolours-1))` wrap, kept verbatim). That index field is computed **once** per swirl.
3. **Animation = colourmap rotation.** The field never changes during a swirl; the C animates by rotating its writable X colormap a few entries per frame (`rotate_colors` / `install_map`). We do the same in user space: store the per-pixel **index**, keep a `palette[ncolors]`, and each frame add `cyclespeed` to a running `offset` and map `palette[(idx+offset) % ncolors]` into the pixel buffer.
4. **Regeneration.** After the field finishes drawing the C idles `RESTART = 2500` cycles, then re-seeds everything (new knots, new colormap) — a brand-new pattern. We do the same after `duration` frames.

## Shared skeleton (inherited)
Standalone ES module exporting `title`/`info`/`start(canvas) → { stop, pause, resume, reinit, config, params }`; rAF **lag-accumulator** loop (fixed timestep paced by `config.delay` µs); `devicePixelRatio` folded in (backing store in device px, field at logical px); shared config box via `params`.

## Rendering (per-pixel field, retina downscale MANDATORY)
The field is a dense per-pixel thing with a `sqrt` + `atan2` **per knot per pixel**, so it uses the **blit path** + the **retina-downscale** idiom: the field is computed at **logical** resolution (`canvas px / dpr`) into a `Uint32` `ImageData` on a small offscreen canvas, then `ctx.drawImage` upscales it (bilinear) to the device-px canvas. Computing at device resolution on retina would be seconds per frame.

- **Cell cap.** The logical grid is capped at `MAX_CELLS = 360000` (~758×474). On a hi-DPI laptop (dpr 2) the cap engages and the field upscales ~3-4× — swirl's fine structure (ray lobes, wheel spokes) softens a little, but the flowing look and the colour cycling read fine. On a 1× display at/under the cap it is pixel-exact.
- **Heavy work is occasional and spread out.** The full field is recomputed only when a new swirl is born; even then it is computed **centre-out over `BUILD_FRAMES = 24` frames** (a vertical iris reveal), so generating a swirl never causes a single multi-hundred-ms hitch. The **per-frame** cost is just the palette remap (one `Uint32` write per cell) + one `drawImage`.

## Deviations from the C
- **Palette cycling is emulated in user space.** Browsers have no writable/indexed colormap, so instead of `XStoreColors`/`rotate_colors` we keep the per-pixel index field + a JS `palette` and rotate an integer `offset`, re-mapping the field through the palette each frame. Visually identical (a rotating closed-loop colourmap); mechanically different.
- **Vivid HSL triangle palette** instead of the C's muted 13-entry `basic_colours` table. Faithful to `basic_map`'s *structure* — three distinct base colours interpolated around a triangle into a **closed loop** (which is what makes the rotation seamless), with leg lengths proportional to RGB distance — but the three base colours are drawn from a saturated HSL wheel ~120° apart (porter-brief preference for vivid palettes). Fresh hues every swirl, so successive swirls differ in colour.
- **Clean linear interpolation** around the loop, instead of the C's odd `interpolate()` ramp (which brightens *through the sum* `c1 → c1+c2 → c2` and was tuned to its specific muted table; with vivid colours it would blow out to white at the midpoints).
- **No multi-resolution spiral refinement.** The C draws the field as a spiral from the centre, redrawn at progressively finer block sizes (chunky → fine) to spread the per-pixel cost over time on 1990s hardware. We compute the field at final (logical) resolution directly, spread as the centre-out reveal described above. The "spirals outwards from the centre" reveal is preserved in spirit (centre-out), but as horizontal bands, not a literal pixel spiral, and without the chunky→fine passes.
- **two-plane mode.** Used ~30% of swirls (`TWO_PLANE_PCNT`), where each knot has two types and two interleaved patterns are drawn. The C interleaves at half-block granularity by toggling `first_plane` on every `do_point` call; we interleave **per pixel on a `(x+y)` checkerboard**. The C's two-plane `max_resolution = 2` (chunkier) is N/A — we have no resolution passes.
- **`ncolors` clamped to ≥ 2** (the xml allows `low = 1`). The field-fold divides by `(ncolors - 1)`, and a 1-colour map can't cycle. At the extreme minimum (`ncolors = 2`) the field tends to collapse to a near-uniform parity and the screen strobes between two colours — degenerate, but as it would be in the original; the default 200 uses the full palette.
- **Added params:** `cyclespeed` (palette rotation/frame — the C derives `shift` from `ncolors`, default ~3) and `duration` (frames between swirls — the C's hardcoded `RESTART = 2500`, eased to 1200). Cycle speed is constant; the C cycles faster while drawing (`dshift = 2·shift`) than while idle (`shift`).
- **`delay`** default eased 10000 → 25000 µs (calmer than stock; cycling stays smooth).

## Correctness self-review
Verified with a headless node harness that mocks a minimal DOM and drives the **real** module's rAF loop, capturing the offscreen `ImageData` it blits (default + `ncolors=2` + `count=20,ncolors=255` + `cyclespeed=0`), at dpr = 2:
- **Finite & in range.** Every rendered pixel is finite and fully opaque (`alpha == 0xFF`); zero "bad-alpha" pixels, which would flag an out-of-range palette index (`palette[undef] → 0 → alpha 0`). The `dist > 0.1` guard keeps every per-knot term finite (no `atan2(0,0)`, no division blow-up), and the field-fold keeps the index in `[0, ncolors)` (re-clamped defensively). Field magnitudes are tiny (≈ knots × ncolors), so there's no int32-overflow risk in the `%`/`<<` math.
- **Reveal terminates & fills.** After the build frames the final buffer has **zero** black (un-revealed) pixels — the centre-out reveal completes; `building` flips to false when `loRow ≤ 0 && hiRow ≥ gh`, so it can't get stuck half-drawn.
- **Full palette used.** Default and `ncolors=255` show the entire palette (200 / 255 distinct colours) — the field genuinely spans the index range, not a degenerate constant.
- **It animates, and freezes on request.** Buffer checksum changes frame-to-frame with cycling on, and is **identical** with `cyclespeed = 0` — the rotation is the only motion (faithful: the field is static within a swirl).
- **Regeneration re-seeds.** `newSwirl()` reallocates knot arrays (positions/masses/types), re-decides two-plane, and rebuilds the palette from fresh random hues, then restarts the reveal — successive swirls differ in geometry *and* colour. The cap engaged exactly (359292 cells ≈ `MAX_CELLS`).
- **Lifecycle.** `pause()`/`resume()` (resets `lastTime` so no catch-up burst), `reinit()` (rebuilds grid/knots/palette via `init()`), `stop()` (cancels rAF + removes the resize listener) all run clean.
- **Live vs non-live.** `delay`/`cyclespeed`/`duration` are read every step → `live: true`; `count`/`ncolors` resize the knot arrays / palette → `live: false` (re-run `init()` via `reinit()`).

**Worth a browser spot-check (new hack):** the *aesthetics* on a real retina display — whether the `MAX_CELLS` cap leaves enough crispness in the ray/wheel detail (vs. too soft), and whether the centre-out reveal + cycling cadence reads as pleasant. The math is verified bounded and correct; the tuning is by feel. If it looks too soft, raise `MAX_CELLS`; if a swirl lingers too long, lower `duration`.

## Config
Units/defaults/labels mirror `hacks/config/swirl.xml`: `delay` (µs/frame, xml 10000 → eased 25000, `invert: true` "Frame rate" slider), `count` → **Count** (knots, 0-20, default 5), `ncolors` → **Number of colors** (clamped 2-255, default 200). Added: `cyclespeed` → **Cycle speed** (0-12, default 3), `duration` → **Duration** (frames/swirl, 200-5000, default 1200).

**Local dev:** ES-module `import`s need a real server — `python3 -m http.server` in the repo, then <http://localhost:8000/#swirl>. `file://` double-click fails (CORS on the `null` origin); GitHub Pages serves over http, so production is fine.
