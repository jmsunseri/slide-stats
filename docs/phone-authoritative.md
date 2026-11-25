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
   Horizontal `accuracy` is deliberately **not** used as a vertical-accuracy proxy; 18–30 m
   horizontal accuracy can coexist with usable altitude deltas, and a strict proxy would
   reject usable samples. The detector's median filter and descent confirmation remain the
   quality gate.

4. **Directly importing the watch ES module into PKJS fails.**
   `require("../embeddedjs/lib/core.js")` produces `SyntaxError: unsupported keyword: export`
   in PKJS. The watch uses ESM; the PKJS bundle does not transpile it.

5. **A generated CommonJS detector works.**
   `tools/generate-pkjs-detector.mjs` copies `src/embeddedjs/lib/detector.js` into
   `src/pkjs/lib/detector.js` as CommonJS. The generated module runs in PKJS and detects a
   synthetic start/end trace.

The temporary probe is in `src/pkjs/probe.js`. It is controlled by `PHONE_PROBE` in
`src/pkjs/index.js`; it is disabled in the production path and remains available for device
testing.

## Implemented architecture

### Phone

`src/pkjs/lib/phone-runtime.js` owns the whole pipeline:

1. `navigator.geolocation.watchPosition()` supplies positions.
2. Samples are throttled to `settings.sampleIntervalMs`.
3. `src/pkjs/lib/phone-detector.js` feeds them to the shared detector.
4. On lift end, `src/pkjs/lib/phone-store.js` appends the lift to `ss.lifts`.
5. The store builds the compact watch state with `src/pkjs/lib/stats.js`.
6. The runtime sends `State` (and `Event` for start/end vibration).
7. Commands from the watch update units/vibration or undo the last lift.

The in-progress lift is saved to `ss.phoneActive` every 30 seconds and on every detector
event, so a phone restart does not lose a ride. The phone clears it when the day rolls over
or the lift ends.

`phone-store` reads `ss.lifts` on each operation, so the old watch sync path and the phone
runtime can share the same records. If the stored JSON is corrupt, the store preserves the
raw value under `ss.lifts.corrupt` before starting from an empty map.

### Watch

`src/embeddedjs/main.js` now:

- keeps the last `State` in `ss.phone`;
- draws Today/Season from that cache without touching the phone;
- opens history screens from cached summaries and requests older/newer days with the existing
  `Query`/`Data` messages;
- sends `Command` messages for menu actions;
- vibrates on `Event`;
- shows the disconnected and no-GPS indicators.

It no longer imports `Location`, the detector, the day store, or the outbox. The old
`ss.state` blob is left untouched on flash so a rollback can still read it; the new watch
ignores it.

## Message protocol

Keys are declared in `package.json` and in the watch's `MESSAGE_KEYS` array, in the same order:

```text
Sync, Ack, Settings, Query, Data, Purge, State, Command, Event
```

`Sync`/`Ack` are legacy and unused by the new watch. `Settings`/`Purge` are kept for
compatibility with the Clay page.

### Phone → watch `State`

```json
{
  "v": 1,
  "seq": 12,
  "generatedAt": 1773460800000,
  "today": {
    "date": "2026-03-14",
    "vertical": 16000,
    "runs": 40,
    "first": 1773450000000,
    "last": 1773473700000,
    "longest": 400,
    "average": 400,
    "older": null,
    "newer": null
  },
  "season": {
    "key": "2025",
    "label": "2025-26",
    "days": 1,
    "vertical": 16000,
    "runs": 40,
    "averageVertical": 16000,
    "bestDay": { "date": "2026-03-14", "v": 16000, "r": 40 },
    "older": null,
    "newer": null
  },
  "settings": {
    "units": "metric",
    "vibration": true,
    "seasonMode": "north",
    "theme": { "background": 16777215, "accent": 170, "text": 0 }
  },
  "status": { "gps": true }
}
```

A 40-run day is about **516 bytes** of JSON. The watch's AppMessage buffer is 1,024 bytes, so
run count no longer affects message size.

### Phone → watch `Event`

```json
{ "type": "start" }
{ "type": "end", "gain": 412 }
```

The watch uses this only for vibration. The following `State` carries the new totals.

### Watch → phone `Command`

```json
{ "type": "undo" }
{ "type": "units", "value": "imperial" }
{ "type": "vibration", "value": false }
{ "type": "refresh" }
```

`refresh` is sent automatically on connect, on a stale cache, and on app focus. The phone
replies with a fresh `State`.

The watch updates units/vibration locally for an immediate response and then sends the
command. The next `State` is authoritative. Commands are held in a small in-memory queue
while the AppMessage channel is busy and are not persisted across app exit; an undo is never
replayed after a restart.

### `Query` / `Data`

History navigation still uses:

```json
{ "v": 1, "kind": "day", "key": "2026-03-12" }
{ "v": 1, "kind": "season", "key": "2024" }
```

and the phone replies with:

```json
{ "v": 1, "kind": "day", "key": "2026-03-12", "summary": { ... } }
```

The watch remembers at most six summaries per kind and prefetches the adjacent keys.

## Shared code

- `src/embeddedjs/lib/detector.js` — canonical pure detector, ES module.
- `src/pkjs/lib/detector.js` — generated CommonJS copy used by PKJS.
- `src/embeddedjs/lib/format.js` — watch date/season/format helpers.
- `src/pkjs/lib/stats.js` — phone history/season aggregation. Its tests verify that its season
  keys match the watch's.

Regenerate the detector after changing it:

```bash
npm run generate:phone-detector
node --test test/pkjs-detector.test.mjs
```

## Memory

The redesign removes the detector, day store, outbox, coordinate packing, and GPS sensor from
the watch archive. The native ActionMenu is included in the final measurement:

| Metric | Before | After |
| --- | ---: | ---: |
| App virtual size | 628 B | **2,096 B** |
| Archive | 35,935 B | **27,429 B** |
| XS pools | 78,336 B | 80,384 B (slot restored to 48,640) |
| Hardware startup margin | +1,057 B | **+8,287 B** |

The 40-run limit no longer applies to the watch: a 40-run day lives on the phone and pushes the
same ~516-byte summary as a 1-run day. The 40-run stress harness was a watch-store test and is
obsolete for this design.

## Native ActionMenu

The More menu now uses Pebble's native `ActionMenu` through the existing FFI shim:

- `src/c/ffi.c` builds six root rows and two submenus (Units and Vibration), writes the
  selected action to a static result, and destroys the hierarchy when the menu closes.
- `src/embeddedjs/main.js` opens the menu on Select release so the launching click is not
  delivered to the new menu, then polls `slide_action_menu_result()` every 150 ms.
- The crumb column uses the theme accent; the menu body follows the system black/white style.
- The app window is set as the ActionMenu result window, so a Back cancel returns to the app
  instead of popping the app window.
- Back cancel on Gabbro also left the display destination bitmap offset. `src/c/mdbl.c`
  installs an empty root-layer update proc, and the watch marks that layer dirty and redraws
  after the menu closes. This restores the bitmap before the delayed redraw.

The custom Poco menu was removed, including its menu drawing, scrolling, and input branches.

## Verification

- `node --test test/*.test.mjs` → **93/93 pass**.
- `npm run check-memory` → **OK** on emery and gabbro.
- Emulator smoke test:
  - app launches and draws the main screen;
  - phone `State` shows runs/vertical; the crossed circle appears when connected without
    altitude, and the disconnected-watch icon appears when the phone link drops;
  - Today and Season detail screens show the pushed state;
  - Units and Vibration reach PKJS and persist in `ss.settings`;
  - yesterday navigation issues `Query` and receives `Data`;
  - the native ActionMenu opens, scrolls, enters both submenus, cancels with Back, and
    restores the app on Emery and Gabbro.

## Migration and rollback

- Upgrading keeps the existing phone `ss.lifts` and `ss.settings`.
- The watch's old `ss.state` is not deleted, but unsynced lifts that were still in the old
  watch outbox at upgrade time are not migrated. A normal connected upgrade has already
  synced them.
- Reverting the implementation commit restores the watch store, outbox, and detector, and the
  old `ss.state` is still present.

## Remaining questions

- Commands have no acknowledgement. A lost command is corrected by the next `State`, but undo
  is best-effort.
- Live detection still needs a real lift test. The synthetic traces and the PKJS probe cover
  the mechanics, not the detector's field behavior.
- The native ActionMenu uses the firmware font and the crumb column only follows the theme;
  the body does not use the three-colour theme.
