# xanalogtv — port notes

Port of `xanalogtv.c` by Trevor Blackwell (2003) — a dusty old television flipping through the channels. Some carry colour bars with the station logo and light snow, some show test cards, some are dead channels of static, and a few pick up two stations at once. Changing the channel loses sync — a burst of static, a quick roll/tear — before it locks back on, with the odd glitch mid-channel, like a real flaky set.

It is built entirely on the shared NTSC engine [[analogtv]] (`hacks/analogtv.glsl.js`): xanalogtv only supplies the **picture content** (`atv_source`) and a per-frame **reception model**; the engine does the signal simulation, CRT model, and all the timing/geometry faults.

Original: <https://www.jwz.org/xscreensaver/> · source: `xscreensaver-6.15/hacks/xanalogtv.c`. See [[squiral]] for the module skeleton and the memory note `analogtv-ntsc-shader-port`.

## Channels
`CHAN = [2,1,3,0,1,4,2,1,5,0,1,2]` cycled every `dwell` seconds. `uChanType`: **0/2** colour bars (always with the logo + station ID + clock, like the single colorbars station in the original), **1** dead/snow (black source — the snow is the decoder's composite noise), **3/4/5** the RCA / PM5544 / BBC-F test cards (bundled PNGs, `uImage1..3`). The flaming-monitor logo is `uImage0`; the live text overlay is `uImage4`.

Each channel also has a stable "personality" derived from a hash of its index: ~2/3 of channels carry an RF **ghost** (multipath strength), and ~1/8 (currently idx 3 and 6) share the channel with a fainter **second station**.

## Reception model (`reception()` → `frameKnobs`)
- **Channel-change re-lock**, faithful to `analogtv_sync`: the new station's signal offset is random, so vertical sync lands at a random error and then **walks back incrementally** (≤ ~32 of the 262 frame lines per frame). Most changes barely roll; some roll for a few frames before catching. A ~3-frame static burst (`channel_change_cycles`) and a brief (~0.4 s) horizontal/colour settle ride along. This deliberately replaces an earlier version that did the same big roll+tear on *every* change (too repetitive).
- **Colour lock after picture** (`colormode`/burst): chroma is gated off until just after the picture appears, so a channel snaps in black-and-white and the colour fades in.
- **Persistent mid-image sync loss**: occasionally (mean `config.syncloss` ≈ 22 s) the vertical/horizontal hold drifts on its own for 3–8 s (free roll and/or tear) before catching — the deliberate rare drama.
- **Snow & AGC**: the same faint snow (`barsnow`) is injected on every channel; the engine's AGC (`agc = 1/√(noise² + Σ level²)`) then boosts no-signal channels so their static is bright while stations sit near unity.

## The analogtv feature set (#1–#10)
Driven from here, implemented in the engine:
- **#1 bloom** (`crtload`) — brighter lines load the flyback and widen the scan, so the picture breathes; `squeezebottom` skews the bottom edge. *On.*
- **#2 right-edge squish + brighten** — the beam slows at the right; remapped to fill the edge (no black gap). *On (subtle, as in stock).*
- **#3 AGC** — luma normalised to signal strength (the dead-channel snow boost above). *On.*
- **#4 ghosting** (`ghostfir`) — RF multipath echo, ~2/3 of channels, faithful tap range. *On.*
- **#5 hfloss** — **skipped**: dead code in stock (`rec->hfloss` is only set inside an `if (0)`, so it is always 0; a faithful port is a no-op).
- **#6 two stations** — a fainter test-card second station summed in at a random, slowly drifting offset (its own carrier phase → the interference beat). ~1/8 of channels. *On.*
- **#7 power-on warm-up** (`puramp`) — black → bright centre line → vertical expand → full picture. Exposed as a **"Power-on warm-up" checkbox, default off** (re-arms / replays when ticked).
- **#8 station ID + clock** — "jscreensaver.net" + a live `Date()` clock in the original's `%y.%m.%d %H:%M:%S` format, drawn to a 2D canvas the engine re-uploads each frame (`uImage4`) and composited on the bars station, so it bleeds and scans through the real encode. *On.*
- **#9 tint/desync wander** — the static per-set top bar-bend (`horiz_desync = frand(10)−5`) is faithful and present; the continuous `flutter_horiz_desync` walk is never enabled in stock, so it isn't added. The remaining piece — a per-session `tint_control` randomization — is **held** because it fights the deliberate `tint = 0` calibration (pending a decision).
- **#10 teletext** — random black/white VBI dots, only ever glimpsed in the dark bar as the picture rolls. *On (minor, as in stock).*

## Deviations from the C
- **Bundled images instead of an image directory.** The original pulls broadcast pictures from your xscreensaver image folder, which a browser can't reach. This port uses the three bundled test cards + procedural bars/snow; the test cards and logo are copied from `xscreensaver-6.15/hacks/images/` and ship under xscreensaver's license (this being a port).
- **Station ID text.** Content is "jscreensaver.net" + `Date()` (chosen for this site) rather than the host's `gethostname` + `localtime`; it's drawn with a monospace canvas font rather than the C's 6×10 "ugly" bitmap font (an acceptable adaptation — it still rides the NTSC encode).
- **Deterministic per-channel personalities.** Which channels ghost or carry a second station is a fixed hash of the channel index, where the C re-randomizes each run — so behaviour is stable across sessions rather than shuffled.
- **#5 / #9** as noted above.

## Config
Exposed in the config box: `color` (B&W↔vivid), `tint` (°), `brightness`, `contrast`, `barsnow` (Snow: clear↔noisy), `dwell` (Channel hold, default **10 s**, range 2–20), and the `powerup` checkbox. Internal (not surfaced): `syncloss` (mean seconds between persistent sync-loss events), `squeezebottom` (per-set bottom-bloom skew), `fps`. The colour/tint/brightness/contrast defaults (`1.0 / 0 / −0.05 / 1.4`) are the validated mapping onto the engine's clean-carrier knobs.

**Local dev:** ES-module imports need a server (`python3 -m http.server`, then <http://localhost:8000/#xanalogtv>); `file://` won't load. GitHub Pages serves over http, so production is unaffected.
