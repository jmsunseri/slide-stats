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
   `altitudeAccuracy` are `undefined`. The detector needs altitude. A real-phone check is
   required before this redesign can be committed.

3. **Directly importing the watch ES module into PKJS fails.**
   `require("../embeddedjs/lib/core.js")` produces `SyntaxError: unsupported keyword: export`
   in PKJS. The watch uses ESM; the PKJS bundle does not transpile it.

4. **A generated CommonJS detector works.**
   `tools/generate-pkjs-detector.mjs` extracts the pure detector from
   `src/embeddedjs/lib/core.js` and writes `src/pkjs/lib/detector.js`. The generated module
   runs in PKJS and detected a synthetic `start,end` trace.

The probe is in `src/pkjs/probe.js` and is disabled by default. Set `PHONE_PROBE = true` in
`src/pkjs/index.js` to run it.

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

- Does a real phone report `coords.altitude` and `altitudeAccuracy` to PKJS?
- How fresh must the watch summary be while a lift is active?
- What should the watch do with commands while disconnected?
- Should the watch keep a small unacked command/state queue, or disable state-changing actions
  while disconnected?
- How much history navigation should be prefetched into the watch cache?
