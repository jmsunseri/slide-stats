# Slide Stats — design notes

Working record of the decisions made while designing the app. Anything marked **open**
still needs a decision.

## Constraints

- Alloy supports Emery (Pebble Time 2, 200×228 rect) and Gabbro (Pebble Round 2, 260×260
  round) only.
- Neither watch has a barometer. The BMP390 driver in PebbleOS ships only on `asterix`
  (a Pebble 2 Duo-class board) and has no read API. Altitude comes from phone GPS via
  `embedded:sensor/Location`.
- The SDK's `Location` sample includes `altitude`, `altitudeAccuracy`, `speed`, `heading`,
  and `timestamp` (the public guide only documents lat/lon).
- Alloy apps only run while open. Wakeups relaunch the app but cannot track continuously.
  The app must stay open during a ski day.
- PKJS starts when the watch app starts and stops when it exits. On iOS the phone app is
  suspended in the background and timers do not fire. Sync must happen during the day,
  not only on exit.
- PKJS `localStorage` is per-app, durable, and survives app restarts.
- The only phone UI available to a watchapp is the config-page WebView, opened from the
  gear icon in the Pebble app. PKJS can generate it as a `data:` URL, so the dashboard can
  be fully local.
- The config page needs PKJS running. In practice the mobile app launches the watch app
  when the settings gear is tapped, so this is not a user-visible limitation.
- `pebble new-project --alloy` targets `emery` and `gabbro` by default.

## Product decisions

- **Vertical** is the sum of confirmed lift gains (ascent), not measured descent.
- A **run** is one completed lift ride. Carved turns are not counted.
- **Altitude display** is absolute GPS altitude. The base tap is a zero reference for
  gain math, not a calibration of absolute altitude.
- **Units:** metric by default, manual setting.
- **Day boundary:** local midnight. No 04:00 boundary. A 48-hour event rolls into a new
  day at midnight and continues with the same base.
- **Season:** a 12-month window starting on a fixed month/day, labelled by its start year.
  Northern = Sep 1, Southern = Mar 1, plus Custom and None. Northern default.
- **Trips:** ride days separated by ≤ 2 intervening rest days group into one trip. On by
  default, can be hidden. Trips are shown on the phone only.
- **Sync:** watch owns today, phone owns history. Lift records sync after each completed
  lift; unacked records flush on launch. Phone dedupes by `dayKey + sequence`.
- **Dashboard:** local config page with Today / Trips / Season / Settings. No export in
  v1. Stats: vertical, runs, first/last lift, average per run, longest run, days, best
  day, trip counts, averages per day, daily bar chart.
- **Settings split:** quick items on the watch (pause, end day, undo last lift, units,
  vibration, sync now); season setup, GPS sample interval, detection thresholds, trips
  toggle, and the dashboard on the phone.

## Main screen

Centred vertical stack, no decoration, same layout on both screens:

```
        10:42
       2,143 m
   3 RUNS  +1,240 m
         LIFT
```

- Time is the largest element (Bitham Bold 42, follows `watch.hour12`).
- Absolute GPS altitude below (Gothic Bold 28).
- Runs and day vertical on one line (Gothic 18), updated when a lift ends.
- No `READY` text and no always-on "tracking" dot. Exception-only status text at the
  bottom (`LIFT`, `PAUSED`, `NO GPS`); drawn icons are a later refinement.
- Time + altitude redraw on `minutechange`; totals only on lift end; status only on state
  change. No animations, no forced backlight.

## Lift detection

- Altitude is median-filtered. Samples with `altitudeAccuracy` worse than ~30 m are
  ignored.
- **Fast start:** net gain ≥ 10 m within 30 s.
- **Slow start:** net gain ≥ 10 m within 90 s (covers bunny lifts and magic carpets).
- Most samples in the window must be rising, not a single noise spike.
- Optional max-speed gate: ignore samples while horizontal speed > 8 m/s (cars).
- Detection runs on the median-filtered altitude. The lift's start and peak are recorded
  from raw altitudes so the filter does not shave metres off short lifts.
- **End:** raw altitude ≥ 5 m below the lift peak for two samples. There is deliberately
  no time-based backstop. Getting off and walking horizontally to another lift with no
  descent merges the two rides into one; this was accepted as an infrequent case.
- **Minimum counted lift:** 10 m, adjustable 5–50 m. A ride that ends below the minimum
  is discarded.
- Vibration: optional, default on. Two short pulses at lift start and two at lift end.
  A single pulse is avoided because it looks like a phone notification.
- **Undo last lift** in the More menu; the phone receives a correction.

## Screens and input

- **Main** — clock, altitude, runs, day vertical, exception-only status text.
- **Today** — vertical, runs, first/last lift, average per run, longest run.
- **Season** — label, days, vertical, runs, average/day, best day. Computed on the watch
  from its stored daily aggregates; no phone round-trip needed.
- **More** (Select from Main) — Set Base, End Day, Pause/Resume, Undo Last Lift, Units,
  Vibration, Sync Now, About. No long presses.
- **Up/Down** cycle Main/Today/Season. **Back** exits; tracking pauses and state
  persists.
- No touch requirement. Trips are phone-only.

## Testing

- Detection, season/trip maths, persistence, and formatting live in one pure watch module,
  `src/embeddedjs/lib/core.js`; phone-side aggregation lives in `src/pkjs/lib/stats.js`.
  Together they have 52 Node tests, including cross-checks that both season/trip
  implementations agree.
- Fixtures: slow chair, fast gondola, bunny lift, magic carpet, mid-lift stop, car climb,
  noisy GPS, missing altitude, long sample gap, day rollover.
- The More menu carries **Debug: Mock Lift** while `DEBUG` is true, feeding a synthetic
  climb through the real detector, store, UI, and sync path in the emulator.
- Field test: one gondola in town, plus at least one real ski-day GPS trace to replay.

## Implementation notes

- One core module holds the detector, season/trip maths, day store, and formatting. Alloy
  charges memory per module; four modules plus Piu exceeded the watch's engine heap.
- The UI is drawn with **Poco**, not Piu. It is a small, redraw-on-change interface, and
  Poco costs far less RAM on a 128 kB app heap.
- `src/c/mdbl.c` gives the engine a 72 kB pool (stack 6 kB, slot 40 kB, chunk 24 kB).
  Larger pools fail to map the app archive on Emery; smaller pools run out of memory.
- Sync protocol: the watch sends one JSON record at a time in `Sync` and waits for an
  `Ack` containing the record id. Kinds are `lift` and `lift-delete`. The phone dedupes
  by `date + seq` and stores records in PKJS `localStorage`.
- Settings travel both ways in the `Settings` key. The phone sends its stored settings on
  `ready`; the watch sends changes made on the wrist.
- The dashboard is generated by PKJS as a `data:` URL with all stats pre-rendered; the
  settings form closes with `pebblejs://close#`.

## Implementation status

- [x] Alloy project scaffolded for emery + gabbro
- [x] Watch core and phone stats with 52 Node tests
- [x] Poco screens and More menu on both form factors
- [x] Sync protocol, PKJS store, and ack/dedupe
- [x] Local dashboard with Today / Trips / Season / Settings
- [x] Debug mock lift
- [ ] Real-world threshold tuning
- [ ] Drawn status icons
- [ ] Accelerometer-gated GPS
- [ ] Backcountry mode (issue #1)

## Open questions

- Whether to persist an in-progress lift across an app restart (only completed lifts
  survive today).
- Whether a lift that spans midnight should count on its start day.
- How much of the season history to keep on the watch before rolling old seasons up.
