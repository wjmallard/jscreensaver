# xanalogtv — port notes

Port of `xanalogtv.c` by Trevor Blackwell (2003) — a dusty old television flipping through the channels. Some carry colour bars with the station logo and light snow, some show test cards, some are dead channels of static, and a few pick up two stations at once. Changing the channel loses sync — a burst of static and a quick vertical roll — before it locks back on, like a real flaky set.

It is built entirely on the shared NTSC engine [[analogtv]] (`hacks/analogtv.glsl.js`): xanalogtv only supplies the **picture content** (`atv_source`) and a per-frame **reception model**; the engine does the signal simulation, CRT model, and all the timing/geometry faults.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/xanalogtv.c`. See [[squiral]] for the module skeleton and the memory note `analogtv-ntsc-shader-port`.

## Channels
`CHAN = [2,1,3,0,1,4,2,1,5,0,1,2]` cycled every `dwell` seconds. `uChanType`: **0/2** colour bars (always with the logo + station ID + clock, like the single colorbars station in the original), **1** dead/snow (black source — the snow is the decoder's composite noise), **3/4/5** the RCA / PM5544 / BBC-F test cards (bundled PNGs, `uImage1..3`). The flaming-monitor logo is `uImage0`; the live text overlay is `uImage4`.

Each channel also has a stable "personality" derived from a hash of its index: ~2/3 of channels carry an RF **ghost** (multipath strength), and ~1/8 (currently idx 3 and 6) share the channel with a fainter **second station**.

## Reception model (`reception()` → `frameKnobs`)
- **Channel-change re-lock**, faithful to `analogtv_sync`: the new station's signal offset is random, so vertical sync lands at a random error and then **walks back incrementally** (≤ ~32 of the 262 frame lines per frame). Most changes barely roll; some roll for a few frames before catching. A ~3-frame static burst (`channel_change_cycles`) and a brief (~0.4 s) colour-burst settle (with only a small horizontal nudge) ride along. Sync disruption is otherwise vertical — stock xanalogtv only loses sync on a channel change, and `flutter_horiz_desync` (the recurring horizontal tear) is never enabled, so there is no full-screen diagonal wobble mid-channel.
- **Colour lock after picture** (`colormode`/burst): chroma is gated off until just after the picture appears, so a channel snaps in black-and-white and the colour fades in.- **Snow & AGC**: the same faint snow (`barsnow`) is injected on every channel; the engine's AGC (`agc = 1/√(noise² + Σ level²)`) then boosts no-signal channels so their static is bright while stations sit near unity.

## The analogtv feature set (#1–#10)
Driven from here, implemented in the engine:
- **#1 bloom** (`crtload`) — brighter lines load the flyback and widen the scan, so the picture breathes; `squeezebottom` skews the bottom edge. *On.*
- **#2 right-edge squish + brighten** — the beam slows at the right; remapped to fill the edge (no black gap). *On (subtle, as in stock).*
- **#3 AGC** — luma normalised to signal strength (the dead-channel snow boost above). *On.*
- **#4 ghosting** (`ghostfir`) — RF multipath echo, ~2/3 of channels, faithful tap range. *On.*
- **#5 hfloss** — high-frequency loss: each composite sample mixes in a fraction of the sample 180° of subcarrier away (in phase for luma, antiphase for chroma), so it lifts luma and washes out colour on a weak signal. **The stock code gates its driver behind `if (0)`, so it never runs; revived here** — driven by a slow zero-mean random walk whose size tracks each channel's multipath, giving a subtle colour/brightness waver on the multipath channels that decays to nothing on the clean ones. *On (config `hfloss`); subtle by design.*
- **#6 two stations** — a fainter test-card second station summed in at a random, slowly drifting offset (its own carrier phase → the interference beat). ~1/8 of channels. *On.*
- **#7 power-on warm-up** (`puramp`) — black → bright centre line → vertical expand → full picture. Exposed as a **"Power-on warm-up" checkbox, default off** (re-arms / replays when ticked).
- **#8 station ID + clock** — "jscreensaver.net" + a live `Date()` clock in the original's `%y.%m.%d %H:%M:%S` format, drawn to a 2D canvas the engine re-uploads each frame (`uImage4`) and composited on the bars station, so it bleeds and scans through the real encode. *On.*
- **#9 tint/desync wander** — the static per-set top bar-bend (`horiz_desync = frand(10)−5`) is faithful and present; the continuous `flutter_horiz_desync` walk is never enabled in stock, so it isn't added. The **per-session tint/colour miscalibration** (`xanalogtv_init`) is now in too: 1/4 of sessions add `pow(frand(2)−1,7)·180°` to the tint (the `pow(.,7)` keeps it usually tiny, occasionally a big hue swing), and every session adds `frand(0.3)` to colour — like a set knocked slightly off at the factory. Mapped onto the engine's knobs: tint is additive degrees; the colour bump is `/0.70` (our `color = 1.0` ≡ the original's `color_control = TVColor/100 = 0.70`). *On.*
- **#10 teletext** — random black/white VBI dots, only ever glimpsed in the dark bar as the picture rolls. *On (minor, as in stock).*

## Deviations from the C
- **Bundled images instead of an image directory.** The original pulls broadcast pictures from your xscreensaver image folder, which a browser can't reach. This port uses the three bundled test cards + procedural bars/snow; the test cards and logo are copied from `xscreensaver-6.15/hacks/images/` and ship under xscreensaver's license (this being a port).
- **Station ID text.** Rendered in the original's own X11 6×10 "ugly" bitmap font — jwz's `6x10font.png` (256 glyphs of 7×10), blitted glyph-by-glyph (nearest-neighbour) and run through the NTSC encode, so it bleeds and scans like the C does. Only the *content* differs: "jscreensaver.net" + `Date()` (chosen for this site) rather than the host's `gethostname` + `localtime`.
- **Deterministic per-channel personalities.** Which channels ghost or carry a second station is a fixed hash of the channel index, where the C re-randomizes each run — so behaviour is stable across sessions rather than shuffled.
- **Revived dead code (#5 hfloss).** Stock ships it disabled (`if (0)`); this port enables it at the original coefficients (off via config `hfloss`). See above.

## Config
Exposed in the config box: `color` (B&W↔vivid), `tint` (°), `brightness`, `contrast`, `barsnow` (Snow: clear↔noisy), `dwell` (Channel hold, default **10 s**, range 2–20), and the `powerup` checkbox. Internal (not surfaced): `squeezebottom` (per-set bottom-bloom skew), `hfloss` (revived high-frequency loss, default on), `fps`. The colour/tint/brightness/contrast defaults (`1.0 / 0 / −0.05 / 1.4`) are the validated mapping onto the engine's clean-carrier knobs.

**Local dev:** ES-module imports need a server (`python3 -m http.server`, then <http://localhost:8000/#xanalogtv>); `file://` won't load. GitHub Pages serves over http, so production is unaffected.
