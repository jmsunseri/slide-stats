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
- The config page can only open while PKJS is running, i.e. while the watch app is
  running. **Open:** confirm this is acceptable for v1.
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
  default, can be hidden.
- **Sync:** watch owns today, phone owns history. Lift records sync after each completed
  lift; unacked records flush on launch. Phone dedupes by `dayKey + sequence`.
- **Dashboard:** local config page with Today / Trips / Season / Settings. No export in
  v1. Stats: vertical, runs, first/last lift, average per run, longest run, days, best
  day, trip counts, averages per day, daily bar chart.
- **Settings split:** quick items on the watch (pause, end day, undo last lift, units,
  vibration, sync now); season setup, detection presets/advanced values, trips toggle,
  and the dashboard on the phone.

## Main screen

Centred vertical stack, no decoration, same layout on both screens:

```
        10:42
       2,143 m
   3 RUNS · ▲1,240 m
        [icons]
```

- Time is the largest element (Roboto Bold 49, follows `watch.hour12`).
- Absolute GPS altitude below (Gothic Bold 28).
- Runs and day vertical on one line (Gothic 18), updated when a lift ends.
- No `READY` text. Small status icons only when something needs attention: on a lift,
  paused, no GPS. **Open:** exact icon set and drawing method.
- Time + altitude redraw on `minutechange`; totals only on lift end; status only on state
  change. No animations, no forced backlight.

## Lift detection

- Altitude is median-filtered. Samples with `altitudeAccuracy` worse than ~30 m are
  ignored.
- **Fast start:** net gain ≥ 10 m within 30 s.
- **Slow start:** net gain ≥ 10 m within 90 s (covers bunny lifts and magic carpets).
- Most samples in the window must be rising, not a single noise spike.
- Optional max-speed gate: ignore samples while horizontal speed > 8 m/s (cars).
- **End:** smoothed altitude ≥ 5 m below the lift peak for two samples.
- **Backstop:** if there is no net gain for 10 minutes, end the lift. This is only for the
  case where the skier got off and did not descend 5 m (stood at the top, or walked
  horizontally to another lift). Skiing down 5 m ends the lift immediately; normal lift
  stops are short enough to sit inside the 10-minute window.
- **Minimum counted lift:** 10 m, adjustable 5–50 m.
- Vibration: optional, default on. Pulse on lift start and lift end.
- **Undo last lift** in the More menu; the phone receives a correction.

## Screens and input

- **Main** — clock, altitude, runs, day vertical, status icons.
- **Today** — vertical, runs, first/last lift, average per run, longest run, lift list.
- **Season** — label, days, vertical, runs, average/day, best day, trip count. Summary
  cached on the watch; refreshed from the phone when connected.
- **Trips** — current trip summary; full list on the phone. **Open:** confirm on-watch.
- **More** (Select from Main) — Set Base, End Day, Pause/Resume, Undo Last Lift, Units,
  Vibration, Sync Now, About. No long presses.
- **Up/Down** cycle Main/Today/Season/Trips. **Back** exits; tracking pauses and state
  persists.
- No touch requirement.

## Testing

- The lift detector is a pure module with no Pebble APIs, tested headlessly with the
  bundled XS tools (`xsl` / `mcsim`).
- Fixtures: slow chair, fast gondola, bunny lift, magic carpet, mid-lift stop, car climb,
  hike, noisy GPS, missing altitude, day rollover.
- A debug screen shows live altitude, rate, and detector state; samples can be logged to
  a file.
- Field test: one gondola in town, plus at least one real ski-day GPS trace to replay.
- Unit tests before UI.

## Open questions

- Confirm config-page dashboard only being reachable while the watch app is running.
- Exact status icons.
- Whether Trips is an on-watch screen in v1.
- Lift record wire format and message packing.
