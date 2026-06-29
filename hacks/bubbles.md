# bubbles — port notes

Port of `bubbles.c` + `bubbles-default.c` (James Macnicol, 1995-1996; default image set by Jamie Zawinski) — "the kind of bubble formation that happens when water boils: small bubbles appear and, as they get closer to each other, combine to form larger bubbles which eventually pop." Soft-drink / frying-pan fizz.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/bubbles.c` + `bubbles.h` + `bubbles-default.c`. Removed from the stock XScreenSaver distribution as of 5.08. Demo video: <https://www.youtube.com/watch?v=Mli1TjZY1YA>.

> **This port was structurally rebuilt during the fidelity audit and needs live verification.** Both the FANCY default (pre-rendered 3D sphere sprites) and the insert-driven motion were transcribed from the .c. The previous port had been flattened into a uniform rising field with invented rainbow hues and only drew circles (it dropped the sprite mode entirely); that has been corrected.

## Algorithm
Each bubble has a centre `(x, y)`, a radius `r`, and an **area** `area = 10·π·r²` (the C's `calc_bubble_area`, 2D path). Area — not radius — is the conserved quantity: merges add areas, and a bubble's radius/step follows from its area.

**Spawn.** Each frame `bubbles_draw` creates **exactly 5** new minimum bubbles at **random positions over the whole screen** (`random()%w`, `random()%h`) — the entry edge plays no part; "rise"/"float"/"drop" affect only *motion*. The screen **starts empty** (the C creates no bubbles at init) and fills in over the first second.

**Merge / motion is insert-driven** — the heart of the hack. The C has no "move every bubble" pass; all motion happens inside `insert_new_bubble`, run once per spawned bubble:
1. If the new bubble touches nothing, it just **sits there** (returns immediately — no move).
2. Otherwise it merges every touching neighbour (`get_closest_bubble` + `merge_bubbles` + `bubble_eat`), cascading: the bigger eats the smaller (ties broken at random), the survivor takes the **area-weighted mean** position, gains the food's area, and regrows.
3. Then, in **rise/drop** mode only, it **travels one droppage step** (`drop_bubble`) and re-checks — keeps travelling while it finds bubbles to eat; across *empty* space it continues only if near maximum size **and** a coin-flip (`random()%2`) wins. A bubble whose centre runs off the top/bottom edge **pops**.
4. In **float** mode (the xml default) there is **no directional travel** — bubbles only appear, merge, and pop. An over-ceiling merge **pops** the bubble in float; in rise/drop the area is instead **clamped** at the ceiling. This is `bubble_eat`'s `st->drop` branch exactly.

So most of the field is static, with the occasional large bubble making a run across the screen — *not* a uniform upward flow.

**Collision mesh.** A square mesh of side `2·(largest radius)+3` buckets every bubble; `get_closest_bubble` searches only its own cell + 8 neighbours for the closest other bubble within `r_a + r_b + 2`. The mesh is maintained **incrementally** (add / remove / re-cell on every move and merge), like the C.

## Render modes (both faithful to the C)
The C has two modes. This port reproduces **both**; the default is fancy, matching the .xml (which is non-simple by default).

### Fancy (default) — pre-rendered 3D sphere sprites
`bubbles-default.c` compiles in **four sprite sets** — `blood`, `blue`, `glass`, `jade` — and picks **one at random per run** (`random() % 4`). Each set is **11 PNGs** of fixed pixel sizes (diameters 10, 12, 14, 20, 24, 30, 36, 44, 50, 60, 72). All four sets are bundled under **`hacks/images/bubbles/`** (44 PNGs, ~256 KB) and loaded relative to the module (`new URL('./images/bubbles/<set><n>.png', import.meta.url)`, mirroring `xflame`).

- Each sprite's **radius = max(w,h)/2** (`make_pixmap_from_default`); its **area = 10·π·r²**. The sprites are sorted ascending by radius (`pixmap_sort`) into 11 **steps** (0..10).
- A 12th **extra step** is **extrapolated** beyond the largest (`r[10] + (r[10]−r[9])` = 42 px radius); it has **no sprite** and is used only as the **pop/clamp ceiling**, so the biggest bubble "hangs around and doesn't pop immediately" (`make_pixmap_array`).
- A bubble starts at step 0 and **grows** by stepping up while `area > stepArea[step+1]`, capped at step 10 (`bubble_eat`). Its **droppage** is per step: `MAX_DROPPAGE · step / 11` (`make_pixmap_array`). "Near max" (gating trails / keep-travelling) is `step ≥ 10`.
- Drawn with `ctx.drawImage(sprite, x−r, y−r, 2r, 2r)`; the PNG **alpha is the round mask** (all sprites have alpha), so no manual clip is needed — the canvas equivalent of the C's `XCopyArea` through `shape_mask`.

### Simple (`--simple`) — white circle outlines
Plain white (`foreground`) circle **outlines** (`XDrawArc`) on black, one shared path + stroke. Here the radius is a **screen fraction** (`min = 0.006·min(W,H)`, `max = 0.045·min(W,H)`), the area threshold/droppage are radius-based, and "near max" is `area ≥ areas[max−1]` — all exactly as the C's `-simple` path.

We **clear and redraw** every bubble each frame in both modes (the C draws/erases incrementally with X11 GCs); a full repaint on a double-buffered canvas is the equivalent and avoids erase "turds".

## Async loading
Fancy mode decodes its 11 sprites (`Promise.all(img.decode())`) before the sim starts; the canvas holds **black** until they are ready (typically well under a frame or two). If the assets fail to load, it **falls back to the simple outline mode**. Toggling `simple` (a non-live param) re-bootstraps; an already-decoded set is reused.

## Module shape
`start(canvas) -> { stop, pause, resume, reinit, config, params }` — see `swirl.md` / `xflame.md`. Fixed-timestep rAF lag-accumulator paced by `config.delay` (µs); one `step()` = the C's `bubbles_draw` (5 inserts), drawn at most once per frame. `delay`/`mode`/`trails` are live; `simple` rebuilds via `reinit()`.

## Deviations from the C
- **[C, deliberate, small] Default delay = stock + OVERHEAD calibration.** The default `delay` is the **stock 10000 µs** (the slider maps 1:1 to the xml resource); the loop adds a fixed `OVERHEAD = 8450 µs` so `(delay + OVERHEAD)` reproduces the live binary's *effective* rate rather than the nominal `1/delay`. Measured against the live `-fps` overlay bubbles runs **54.2 fps**, while the port at the stock delay ran ~100 steps/s (1.85× fast); `10000 + 8450 = 18450 µs → 54.2 steps/s`, matching the binary. Pace knob only; the slider still exposes the full `0–100000` range. (An earlier revision used a by-eye default of 20000 µs.)
- **[B, forced] `broken` toggle dropped.** The fancy-only `-broken` ("don't hide popped bubbles") leaves un-erased sprite turds by skipping `hide_bubble`; under a full repaint there is nothing persistent to leave behind, so it is meaningless and dropped. (The C forbids it in simple mode anyway.)
- **[B, forced] Fancy bubbles are a fixed PIXEL size (scaled by dpr).** The C's fancy radii come from the sprite PNG dimensions (10..72 px), independent of screen size; we keep that but multiply by `devicePixelRatio` so they render at the right CSS size and stay crisp on hi-dpi (at dpr 1 this is byte-identical to the C). They are therefore a smaller fraction of a large screen than the screen-fraction *simple* bubbles — which is faithful to the original.
- **[A, negligible] Float positions / no overflow guard.** The C uses integer `x, y` and `long_div_round`; the port keeps float positions (sub-pixel). It omits `adjust_areas` (a `long`-overflow guard) — irrelevant to JS doubles.
- **[A, negligible] Safety cap.** The C has no cap; the merge-and-pop dynamics are self-limiting (the field saturates at a few bubbles per mesh cell). A guard well above the natural peak bounds memory on a pathological screen but never binds in normal play (verified: fancy peaks ~750, simple ~1500 at 820×560).
- **Line width (simple).** The C draws a 1-pixel outline; the port uses `round(dpr)` device px so the stroke stays ~1 CSS px and visible on hi-dpi.

## What the audit fixed (real deviations in the prior port, now corrected)
- **Fancy sprite mode was dropped entirely** — the prior port only drew circles. Fancy (the real default) is now ported with the bundled sprite sets and the exact step/area/droppage/ceiling logic.
- **Invented rainbow palette removed.** The prior port gave each bubble a vivid HSV hue + radial-gradient disc. The C has **no colormap** (fancy = grey/coloured sphere sprites; simple = white outlines). Rainbow + `ncolors` slider gone.
- **Uniform "every bubble rises every frame" → insert-driven motion** (see *Algorithm*).
- **Default mode rise → float** (the xml default / demo-video look). All three modes remain available.
- **Edge spawning + invented initial seeding → random over the whole screen, starting empty.**
- **Droppage made exact** (`MAX_DROPPAGE = 20`, ramp from 0; removed the invented `MIN_RISE` floor / `MAX_RISE` cap).
- **Trail offset sign fixed** (C places the trail *behind* the traveller, `y − (r+10)·dir`; the prior port used `+`), with the correct near-max gate.
- Invented `spawnRate` / `sizeScale` sliders removed (the C hard-codes 5 spawns/frame and fixed sizes).

## Config
Mirrors `hacks/config/bubbles.xml`: `delay` (Frame rate, inverted slider, live), `mode` (Motion — the gravity select rise/float/fall, default **float**, live), `simple` (Draw circles instead of bubble images — the xml's `--simple`, default off, rebuilds on change), `trails` (Leave trails, live). The xml exposes nothing else animatable (`broken` dropped per above; `showfps` is a framework control).
