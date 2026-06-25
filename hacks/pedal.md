# pedal — port notes

Port of `pedal.c` by Dale Moore (1994/1995) — "The even-odd winding rule." Each round computes one closed "pedal" figure (a spirograph / string-art polar curve) and fills it as a single self-intersecting polygon under the even-odd winding rule, holds it for a few seconds, clears, and draws a fresh one in a new hue.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/pedal.c` (338 lines). Based on an old PDP-11 graphics-display program at CMU; random per-figure colour added by Jamie Zawinski.

Same closed-figure curve family as [[helix]] and [[xspirograph]] (polar/parametric figure → screen → linger → clear → new figure on a variable-delay loop); this port reuses their state-machine + lag-accumulator skeleton. See [[squiral]] for the canonical port skeleton.

## Algorithm
`compute_pedal` rejection-samples an integer triple `(a, b, d)` — `d = rand[MINLINES, maxlines)`, `a = rand[1, d)`, `b = rand[1, d)` — until `numlines(a, b, d) > MINLINES` (fewer lines than that "must be ugly"). `numlines` returns `d / gcd(d, b)` (the LCM-based period of the curve), first halving `d` when `a` and `b` are both odd and `d` is even (the crossover at 180 degrees). It then evaluates the polar curve `r = sin(theta * a * 2pi/d)` on `theta = 0, b, 2b, ... (mod d)` for exactly `numpoints` steps, converting each `(r, theta)` to a screen point `(sin(theta)·r·hW + hW, cos(theta)·r·hH + hH)`. The whole point list is filled once as a polygon with the **even-odd winding rule** (`XFillPolygon(..., Complex, ...)`), which is what carves the rose-like hollow petals. The figure lingers `delay` seconds, then erases, then a new triple + hue is rolled.

## Rendering
The figure is a genuine filled polygon, not an incremental line sweep — the C issues exactly one `XFillPolygon` per round. So this port accumulates the flat point list into a `Path2D` and calls `ctx.fill(path, 'evenodd')` once per figure. Unlike helix/xspirograph the polygon appears all at once (there is no on-screen point-by-point DRAW phase); the state machine is therefore `NEW_FIGURE` (compute + fill) → `LINGER` (hold) → `CLEAR`.

## Deviations from the C
- **Even-odd fill** maps directly: Canvas `fill(path, 'evenodd')` == `XFillPolygon` with the `Complex` shape mode (even-odd winding). No deviation — this is the whole point of the hack.
- **Instant clear instead of the erase transition.** The C runs xscreensaver's `erase_window` wipe between figures; here `clearScreen()` blanks to black instantly, then the loop holds black ~1 s (the wipe's rough duration). Same as helix/xspirograph; a wipe is a later candidate.
- **Colour.** The C rolls a full random hue per figure (`hsv_to_rgb(random()%360, 1, 1)`); this port keeps the gallery's vivid `hsl()` rainbow palette (`ncolors` entries, full saturation, 60% lightness) and picks a random index — same vivid-rainbow convention as the rest of the gallery.
- **`maxlines` slider** is exposed as **Lines** (xml range 100..5000, default 1000). The xml's `delay` slider (labelled **Duration**, 1s..1min) is the linger. pedal has no per-step frame-rate slider in the original (the only delays are the multi-second linger and the post-erase pause), so this module exposes none — and therefore has no ` µs` string to worry about. Added an off-UI `ncolors` for gallery parity (not live).
- **DPR.** Backing store is sized in device pixels; the figure is centred at `W/2, H/2` and scaled by the half-extents `hWidth/hHeight`, so it fills the screen crisply on retina without any explicit `S` scaling of line widths (it's a fill, not a stroke). `S` is read for convention/parity only.

## Correctness self-review (no freeze / no dead-line)
This is the helix/xspirograph closed-figure family that froze earlier ports, so I traced and then **simulated** the termination/reset path (60k figures across maxlines = 100 / 1000 / 5000):

- **Sweep parameter resets every figure.** `theta` is a local set to `0` at the top of `computePedal()` — every new figure starts its sweep fresh; there is no carried-over angle that could start past the bound and draw nothing.
- **Integer step-count termination, not float equality.** The plot loop is `for (count = 0; count < numpoints; count++)` with `numpoints` an exact integer from `numlines()`. Closure is the loop bound, never a `point == firstPoint` float test (the bug that made past ports retrace forever). Simulation confirmed plot iterations == `numpoints` in every case.
- **Rejection sampling terminates.** The C's `for(;;)` retry is capped at `MAX_TRIES = 200`; the sim's worst observed was **5 tries**, and a guaranteed-non-degenerate fallback (`b = 1` so `numpoints == d > MINLINES`) backstops it — the fallback was never needed in 60k runs but exists so no config can hang.
- **`numpoints` always > MINLINES (min observed 8).** Figures are never empty — there is always a polygon to fill, so no blank "dead" frame from a zero-point list.
- **No divide-by-zero.** `theta %= d` is safe because `d >= MINLINES = 7 > 0`; `gcd(d, b)` has `b >= 1`.
- **Lag-cap >= linger.** The variable-delay loop banks `nextDelay` and caps the backlog at `nextDelay + 1000`, never below `nextDelay`, so the multi-second `LINGER` and the 1 s black `CLEAR` pauses always fully elapse — a backgrounded tab can't skip the hold or burst through figures. `pause()`/`resume()` reset `lastTime = 0` so resume doesn't fire a catch-up burst, and `reinit()` re-seeds from `NEW_FIGURE` on a cleared screen.
- **First frame is correct.** `reset()` clears to black and sets `NEW_FIGURE`, whose first `step()` computes + fills a full figure immediately — no off-screen or degenerate startup.
- **Faithful degenerate figures.** A small fraction (~0.5–2%) of triples yield a near-collapsed curve (tiny visual span); the C draws these too (it only rejects on `numpoints <= MINLINES`, not on span), so this port keeps them. They linger then clear via the normal cycle — an occasional unremarkable frame, never a freeze.
