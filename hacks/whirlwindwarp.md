# whirlwindwarp

A cloud of floating "stars" dragged around by a procedural 2D flow field, each
star leaving a short fading trail. Port of xscreensaver's `whirlwindwarp.c`.

## Source

- `xscreensaver-6.15/hacks/whirlwindwarp.c` (Paul "Joey" Clark, 2000-2005;
  originally a 1997 QBasic program). 509 lines.
- Config: `xscreensaver-6.15/hacks/config/whirlwindwarp.xml` (params: points,
  tails; defaults 400 / 8).
- See [[grav]] (persistent canvas, erase-old + draw-new) and [[binaryring]]
  (the "flow field of particles" idea). Skeleton follows [[squiral]].

## The algorithm

Stars live in realspace `[-1,+1] x [-1,+1]` (`cx[]`, `cy[]`) and map to pixels
with `x_px = W*(cx+1)/2`. The flow field is a sum of **16 independent
force-field effects** (`fs=16`), applied per star each step in `stars_move`:

- warp (scale), rotation, three asymptote variants, two "squirge" power-curves
  (applied first so `x+1 >= 0` for the `pow`), a two-axis "whirlwind splitting"
  that spreads stars by their index across the cloud (`thru`), and two
  sinusoidal wave fields (amplitude/phase/frequency triples).

Each field `f` has a parameter `var[f]` that **random-walks** about an optimum
`op[f]` via an acc/vel/var chain (`stars_perturb`), and is **switched on/off at
random** each step — turned on with small probability, turned off only once it
has *gently* returned to its optimum (so transitions are smooth). At least 3
fields are forced on at all times. After moving, a star is **respawned** to a
random point if it leaves the field (`|c| >= 0.9999`), hugs a central axis
(`|c| < 0.0001`), or rarely at random (`myrnd() > 0.99`).

Each star has a fixed hsv colour; periodically one star is recoloured toward a
slowly-drifting `hue`, giving the palette a gentle evolving spread.

**Trails.** The C keeps a ring buffer `tx[]/ty[]` of the last `ps*ts` pixel
plots. Each step, before drawing a star's new plot, it erases the plot that the
write cursor is about to overwrite (paints it the background colour). Because
the cursor laps the buffer every `ps*ts` plots and there are `ps` stars, each
star's last `ts` plots stay on screen — a hard, fixed-length tail of `ts`
squares. Ported directly.

## Rendering approach

SPARSE vector drawing: `ps` small squares per frame via `ctx.fillRect` on a
**persistent** canvas (never cleared per frame), exactly like [[grav]]. The
ring-buffer erase-old/draw-new from the C maps straight onto fillRect — no
alpha-fade ImageData buffer is needed, since the trail is a fixed-length tail
rather than an exponential fade. Star square side is `starsize = H/480` (min 1);
`H` is already in device pixels, so HiDPI screens get proportionally larger
squares, matching the C on a high-res display (no extra dpr multiply).

## Deviations from the C

- **Colours.** The C allocates X11 colours and, on failure, cycles through
  already-allocated ones; the recolour step picks `pp = colsavailable * rand`
  where `colsavailable` is the count of successfully allocated colours. In a
  browser every colour is always available, so we use `ps` directly (clamped to
  `ps-1`) and emit `hsl()` strings. Saturation/lightness map the C's
  `.6+.4*myrnd()` hsv to roughly `60-100% / 30-55%` — a slightly more vivid
  rainbow than the muted original, per the project's tuning guidance.
- **Frame pacing.** The C self-caps at 200 fps (5000 us/frame) via
  `gettimeofday`. We instead expose an adjustable Frame rate (the standard rAF
  lag-accumulator) and default it a touch calmer at **8000 us** for a more
  relaxed drift. Drag the slider right for the stock-ish speed.
- **Meters / showfps dropped.** The `--meters` debug overlay (force-field
  parameter bars + reset counts) and the `--fps` toggle are diagnostics, not
  part of the look, and are omitted. The XML's `showfps` boolean is therefore
  not exposed.
- No XOR / feedback tricks are used by this hack, so none are emulated.

## Correctness self-review

- **No termination / freeze.** This hack has no closure or end state — it runs
  forever by design. The `frame` loop is the standard capped lag-accumulator
  (`MAX_CATCHUP_STEPS = 8`), so a backgrounded tab can't burst; `pause()`/
  `resume()` reset `lastTime` to avoid a catch-up jump.
- **No stuck particles.** Every respawn path (`newp`) reassigns *both* `cx` and
  `cy` to fresh `myrnd()` values, so a star can never get wedged. The force
  fields always have >= 3 active and walk continuously, so the cloud always
  moves.
- **`thru` division is safe.** `num_splits = 2 + (int)(|var[0]|*1000) >= 2`, so
  `num_splits - 1 >= 1` — never divides by zero (matches the C, where `var[0]`
  is the "split number" field, op 0).
- **Ring buffer never goes out of bounds.** `tx/ty` are sized `ps*ts` and `nt`
  is taken `% (ps*ts)`; `points`/`tails` are `live: false`, so they can only
  change via `reinit()` -> `init()`, which rebuilds the buffers. `ps`/`ts` are
  therefore constant between reinits. The buffer is seeded off-screen
  (`-starsize-1`) so the first `ps*ts` erases are no-ops on a black background.
- **First frame is non-degenerate.** `draw()` paints black and plots all stars
  once (after `init`/`resize`/`reinit`) so frame 1 already shows the cloud; the
  force fields are seeded random-on at init, so motion starts immediately.
- **Respawn-then-draw ordering matches the C.** A star that respawns this step
  is still drawn at (and its plot stored from) its *new* position, exactly as in
  `whirlwindwarp_draw`.

## Spot-check in the browser (suggested)

- Trails should read as short comet tails of a few squares, lengthening with the
  Trail size slider (1 = bare dots, 50 = long streaks).
- The whole cloud should slowly warp/rotate/swirl and occasionally "split" into
  bands; nothing should pile up at the screen edges or freeze.
- Changing Particles or Trail size should cleanly clear and re-seed (reinit).
