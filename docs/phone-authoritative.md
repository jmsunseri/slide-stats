# Phone-authoritative redesign

Branch: `feature/phone-authoritative-watch`

## Goal

Move lift detection and the authoritative day/history state to PKJS on the phone. The watch
becomes a display, input, and cache client:

- phone: geolocation, detector, today's lifts, history, season stats, settings, summary pushes;
- watch: cached today/season summaries, settings/theme, command handling, history navigation,
  connection/no-GPS status.

The phone is already required for GPS. Without it there are no new samples, so the watch does
not need a local detector or a local outbox.

## Spike results

1. **PKJS geolocation is available.**
   `navigator.geolocation.watchPosition()` works in the PKJS environment.

2. **The emulator does not provide altitude.**
   `pebble emu-set-location` returns latitude, longitude, and accuracy, but `altitude` and
   `altitudeAccuracy` are `undefined`.

3. **A real phone does provide altitude.**
   Device logs showed:
   `altitude=30.34`, `accuracy=18.17`, `altitudeAccuracy=undefined`.
   The redesign is therefore viable. `altitudeAccuracy` is missing, but the detector accepts
   undefined accuracy today (it only rejects finite values above the configured maximum).
   The later protocol should decide whether to accept that, use horizontal `accuracy` as a
   fallback, or rely on the median/descent filters.

4. **Live positions are now fed into the detector.**
   The probe logs `phone-probe: live start/end` alongside the position fields. The
   `synthetic detector events=start,end` line is only the self-test.

5. **Directly importing the watch ES module into PKJS fails.**
   `require("../embeddedjs/lib/core.js")` produces `SyntaxError: unsupported keyword: export`
   in PKJS. The watch uses ESM; the PKJS bundle does not transpile it.

6. **A generated CommonJS detector works.**
   `tools/generate-pkjs-detector.mjs` extracts the pure detector from
   `src/embeddedjs/lib/core.js` and writes `src/pkjs/lib/detector.js`. The generated module
   runs in PKJS and detected a synthetic `start,end` trace.

The probe is in `src/pkjs/probe.js`. It is controlled by `PHONE_PROBE` in
`src/pkjs/index.js`; it is currently enabled on this test branch and should be disabled before
merging the redesign.

## Proposed protocol

Phone → watch `State`:

- sequence number and date;
- today: runs, vertical, first, last, longest, average;
- season: key, label, days, vertical, runs, average/day, best day;
- settings: units, paused, closed, vibration, theme;
- connection state.

Watch → phone `Command`:

- pause/resume, end/resume day, undo last lift;
- units, vibration;
- refresh state.

The watch caches the last `State` locally so Today/Season open instantly. Older/newer
navigation keeps the existing `Query`/`Data` path, but only on demand.

## What the watch keeps

- today and season summary caches;
- theme and display settings;
- current screen/menu/selection;
- connection/no-GPS status;
- a small command/state cache if disconnected.

It no longer keeps the detector, day store, active lift, lift list, outbox, sync/ack protocol,
or coordinate packing.

## Code sharing

The detector is the main shared module. The watch uses the source in
`src/embeddedjs/lib/core.js`; PKJS uses the generated CommonJS copy. Regenerate after changing
the detector:

```bash
npm run generate:phone-detector
node --test test/pkjs-detector.test.mjs
```

Formatting/season helpers can be shared the same way if the phone needs them for summaries.
The existing `src/pkjs/lib/stats.js` already computes history summaries.

## Open questions

- How should the phone compensate for `altitudeAccuracy=undefined`? Accept it, use horizontal
  `accuracy` as a fallback, or rely on the detector's median/descent filters?
- How fresh must the watch summary be while a lift is active?
- What should the watch do with commands while disconnected?
- Should the watch keep a small unacked command/state queue, or disable state-changing actions
  while disconnected?
- How much history navigation should be prefetched into the watch cache?
