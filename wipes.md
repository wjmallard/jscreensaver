# wipes — port notes

Port of `utils/erase.c` (Jamie Zawinski, 1997–2025; portions by Johannes Keukelaar, Torbjörn Andersson, Frederick Roeber) — the wipe transitions xscreensaver uses to clear the screen between patterns.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/utils/erase.c` (~798 lines)

Unlike the gallery hacks, this is **not** a `start(canvas)`-shaped hack — it's a standalone helper a hack (or the host) calls to clear the canvas. It exports `WIPE_NAMES` and `wipe()` and is self-driven by `requestAnimationFrame`.

## Public API
```js
import { WIPE_NAMES, wipe } from './wipes.js';

export const WIPE_NAMES;   // array of transition id strings (below)

// Progressively paint `color` over the canvas in the chosen transition over
// ~durationMs, then call onDone(). Returns { cancel }.
const handle = wipe(canvas, {
  style = 'random',   // a WIPE_NAMES id, or 'random' (picks one uniformly)
  durationMs = 600,
  color = '#000',
  onDone = () => {},
});
handle.cancel();       // stops the rAF, leaves the canvas as-is (no onDone)
```

- Operates on the canvas's **existing device-pixel backing store**: reads `canvas.width`/`canvas.height` as-is, never resizes the canvas, never reads `devicePixelRatio`. So it composites correctly over whatever a hack already drew at that resolution.
- By `t === 1` the canvas is a flawless solid `color` fill — these clear the screen, so there must be no leftover pixels. A final `fillRect(0,0,W,H)` at `t >= 1` guarantees that regardless of any sub-pixel seams a stepper leaves.
- `onDone` fires **once**, when `t` reaches 1. `cancel()` is idempotent and never fires `onDone`.

## Transitions ported (14)
| id | erase.c mode | notes |
|----|--------------|-------|
| `venetianH` / `venetianV` | `venetian` | interleaved blinds, as growing per-slat sub-rects (idiomatic canvas form of the C's interleaved line indices) |
| `randomLines` | `random_lines` | rows or columns revealed in a shuffled order |
| `circleOut` | `circle_wipe` | filled disc growing from the centre |
| `circleIn` | `circle_wipe` (flip) | annulus closing inward, drawn as an even-odd ring |
| `pie` | `circle_wipe` | a wedge sweeping a full turn |
| `spiral` | `spiral` | 10-turn spiral as a fan of thin triangles (the C's exact construction) |
| `randomSquares` | `random_squares` | grid cells filled in a shuffled order |
| `slideLeft` / `slideUp` | `slide_lines` | bands sliding off, direction alternating band-to-band |
| `wedge` | `squaretate` | four corner-hinged triangles sweeping in like a straight-bladed iris |
| `diagonal` | (after `triple/quad_wipe`) | a slanted front sweeping corner-to-corner |
| `dissolve` | `fizzle` | pseudo-random reveal, in small blocks rather than per-pixel |
| `boxOut` | (new) | a rectangle growing from the centre — square sibling of `circleOut` |

## How it works
Each transition is a **stepper**: a `paint(t)` that, given normalized progress `t` in `[0,1]`, paints the **cumulative** covered region at time `t`. A factory builds the stepper once at wipe-start, fixing any per-run randomness (direction, shuffle order) and precomputing reveal orders. `wipe()` runs a single rAF loop: `t = min(1, elapsed / durationMs)`, set `ctx.fillStyle = color`, call `paint(t)`, and at `t === 1` do the safety fill + `onDone()`.

## Deviations from the C
- **Cumulative repaint, not incremental.** erase.c paints only the slice between `prev_ratio` and `ratio` each frame (drawing straight onto the live X window). We repaint the whole covered region every frame instead — same end state, but it doesn't depend on a frame cadence, and a dropped frame can never leave a gap. (Trade-off: a few transitions overdraw earlier regions each frame; negligible for these short ~600 ms clears.)
- **No image-preserving slides.** `slide_lines`/`losira` use `XCopyArea` to shove the *existing* screen contents sideways. Canvas has no cheap equivalent that reads its own backing store per band per frame, and the point here is to *erase*, so the slide bands just paint `color` over the strip. `losira` (the Star-Trek "squeeze to a dot then starburst" multi-phase animation) was **dropped** — it's a bespoke set-piece, not a general wipe.
- **`fizzle` → `dissolve` in blocks.** The C does a per-pixel xorshift fizzle (one 2^16-period PRNG per 256×256 chunk). We tile the screen in small blocks and reveal them in a Fisher–Yates order — cheap, and reads unmistakably as a fizzle without per-pixel work.
- **`three_circle_wipe` dropped** as a near-duplicate of `circleOut`/`pie`; **`triple_wipe`/`quad_wipe`** are represented by the single `diagonal` slanted sweep rather than ported line-for-line (they're variations on the same slanted-line theme).
- **Added `boxOut`** (a square `circleOut`) for variety — a natural member of the family that isn't in the C.
- **Shuffle is unbiased** Fisher–Yates; the C's shuffle has a slight modulo bias. Cosmetic only.
- **`diagonal`** clips the rectangle to the swept half-plane with Sutherland–Hodgman (always a convex polygon → exact fill), rather than X11 line-by-line drawing.
- **Sizing**: the C draws in raw window pixels; we draw in the canvas's device pixels (`canvas.width`/`height`), so slat/band/cell counts are derived from those and look consistent on retina without reading `devicePixelRatio`.

## Integration
`wipe()` is meant to be called **right before a hack regenerates its pattern**, to clear the canvas with a transition instead of an instant `fillRect`. Typical use from inside a hack's loop (or the host), when coverage crosses the clear threshold:

```js
// pause the hack's own drawing, then wipe, then re-seed in onDone:
const handle = wipe(canvas, {
  style: 'random',
  durationMs: 700,
  color: 'black',           // match the hack's background
  onDone: () => { reinit(); },   // regenerate once the screen is solid
});
```

Notes for the caller:
- The wipe draws over the canvas **as it currently is** — call it while the old pattern is still on screen so there's something to wipe away. It does not clear first.
- Pass the hack's own **background colour** as `color` so the cleared screen matches (these fill *over*, they don't reset to transparent).
- The wipe and the hack's rAF loop are independent; to avoid the hack drawing *under* the wipe, pause the hack's loop while the wipe runs and resume/re-seed in `onDone`. Keep the returned `handle` and `cancel()` it if the hack is stopped or the canvas is resized mid-wipe (a resize changes `canvas.width`/`height`, which the in-flight wipe captured at start).

**Local dev:** like the rest of the gallery, the ES-module `import` needs a real server (`file://` double-click fails CORS). `python3 -m http.server`, then open <http://localhost:8000/>.
