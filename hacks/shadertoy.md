# shadertoy.js — runtime stats & the framerate HUD

**Scope:** the perf readout in the WebGL preview gallery (bottom-right corner,
e.g. `res 0.61x   18.3 ms   2049x1281`) and the harness method behind it.

The gallery lives in a scratchpad the host session can't see, so the *display*
isn't shared — but it's only a thin renderer over **`getStats()`**, which every
GL hack exposes from the shipped `shadertoy.js`. That method is the real
integration surface; the HUD recipe at the bottom is just one way to draw it.

## The handle

`start(canvas)` (re-exported by every shadertoy hack) returns:

```js
{ stop, pause, resume, reinit, getStats, config, params }
```

`getStats()` is the read-only telemetry hook — no args, returns a fresh object
each call:

```js
handle.getStats()
// -> { ms: 16.4, scale: 1, w: 3360, h: 2100 }
```

| field  | meaning | notes |
|--------|---------|-------|
| `ms`   | smoothed frame time, milliseconds | EMA (smoothing 0.1), seeded at 16. **Not** instantaneous, **not** fps. ~16.7 ms ≈ 60 fps. |
| `scale`| effective render scale | `(config.resolution ?? 1) * adaptiveScale`. `1.00` = full res; `< 1.00` = harness trimmed under GPU load; hard floor `0.34`. |
| `w`,`h`| drawing-buffer size, **device** pixels | `canvas.width` / `canvas.height` = `round(innerWidth * dpr * scale)` and the same for height. Already folds in `devicePixelRatio` **and** `scale`. |

There's no `fps` field — compute `1000 / ms` if you want one. (The harness keeps
an internal `fps` for its own use but doesn't surface it.)

## What `scale` reflects: adaptive resolution

The harness auto-trims render scale to hold the frame rate, so heavy
ray-marchers stay smooth without per-shader tuning while cheap shaders stay
full-res. Logic (in `render()`), driven by the smoothed `frameMs`, re-checked
every 20 frames:

- `frameMs > 21 ms` and `scale > 0.34` → `scale *= 0.85` (trim down; floor 0.34)
- `frameMs < 13 ms` and `scale < 1` → `scale *= 1.07` (restore up; capped at the ceiling)
- Hysteresis dead-band **[13, 21] ms** prevents oscillation around 60 fps.
- `config.resolution` is the **ceiling** (default 1); adaptive only ever scales *down* from it.
- `config.adaptive = false` pins a fixed scale (disables trimming).

So a readout of `scale < 1.00x` is the machine-visible twin of `info.heavy`: it
means "this hack is GPU-bound and the harness backed off." The shelved heavy
tier settles around `0.61x`.

## The bottom-right readout (gallery recipe)

One DOM node updated by a standalone `requestAnimationFrame` loop — deliberately
**not** coupled to the hack's own loop, so it keeps working across mount/unmount:

```html
<div id="stat"></div>
```
```css
#stat { position: fixed; right: 14px; bottom: 12px; color: #fff;
        font-variant-numeric: tabular-nums; pointer-events: none;
        text-shadow: 0 0 4px #000, 0 0 4px #000; }
```
```js
const statEl = document.getElementById('stat');
(function poll() {
  if (handle && handle.getStats) {
    const s = handle.getStats();
    statEl.textContent = `res ${s.scale.toFixed(2)}x   ${s.ms.toFixed(1)} ms   ${s.w}x${s.h}`;
  }
  requestAnimationFrame(poll);
})();
```

Notes for wiring it into the host:

- **`getStats` is GL-harness-only.** 2D driver hacks (`createDriver`) don't
  expose it, so guard with `handle.getStats?.()` — the readout then sits blank
  for 2D hacks (or wire a separate 2D equivalent).
- `tabular-nums` stops the digits jittering horizontally as the numbers change.
- The poll reads *whatever `handle` is current* — re-point `handle` on hack
  switch and the readout follows automatically; no teardown needed.
- `w x h` is the **backing-store** size (post-DPR, post-scale), not CSS pixels —
  handy for spotting when a hack is rendering well above/below the display.

## Reading it at a glance

| readout | meaning |
|---------|---------|
| `1.00x · ~16 ms` | full res, comfortable 60 fps |
| `1.00x · <13 ms` | headroom to spare |
| `<1.00x · 13-21 ms` | steady state after the harness trimmed a heavy hack to fit |
| `0.34x · climbing ms` | at the floor — heavier than 60 fps allows here; a candidate for the shelved tier / `info.heavy` |
