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
- **No base altitude and no current-altitude display.** Detection uses absolute altitude
  deltas, so a base value is not needed. The day starts when the app opens.
- **Units:** metric by default, manual setting. Detection thresholds are stored in metric
  and converted live in the settings page (m/ft, km/h/mph).
- **Day boundary:** local midnight. No 04:00 boundary. A 48-hour event rolls into a new
  day at midnight and keeps tracking.
- **Season:** a 12-month window starting on a fixed month/day. Northern = Sep 1, Southern =
  Mar 1. Northern default. Changing hemisphere re-buckets all stored days automatically.
- **Trips:** ride days separated by ≤ 2 intervening rest days group into one trip. On by
  default, can be hidden. Trips are shown on the phone only.
- **Sync:** watch owns today, phone owns history. Lift records sync after each completed
  lift; unacked records flush on launch. Phone dedupes by `dayKey + sequence`.
- **Dashboard:** local config page with Today / Trips / Season / Settings. No export in
  v1. Stats: vertical, runs, first/last lift, average per run, longest run, days, best
  day, trip counts, averages per day, daily bar chart.
- **Settings split:** quick items on the watch (pause, end day, undo last lift, units,
  vibration, sync now); hemisphere, altitude processing interval, detection thresholds,
  trips toggle, and the dashboard on the phone.

## Main screen

Centred vertical stack, no decoration, with the native action bar on the right:

```
┌────────────────────────┬─────┐
│  reserved top zone     │  ↑  │  future graphic; small AM/PM if 12h
│                        │     │
│        10:42           │  ⋮  │  time, true vertical centre
│                        │     │
│    3 RUNS  1,240 m    │  ↓  │  stats, 24 px
│                        │     │
│  reserved bottom zone  │     │  future graphic; status icons at bottom
└────────────────────────┴─────┘
```

- Emery reserves the 34 px bar, so the time/stats centre in a 166 px content area.
- Gabbro overlays the 40 px curved bar on the rim, so the time stays at the exact centre
  of the circle. Detail rows stop at x≈210 so they do not merge with the bar.

- Time is the largest element: Roboto-Bold 49 digits (system font), with a small AM/PM
  suffix to the right when the watch is set to 12-hour. The digits and suffix are
  vertically centred as one block.
- No current altitude and no base altitude anywhere.
- Runs and day vertical directly below the time (Gothic-Bold 24, falling back to 18 if a
  large imperial value would not fit).
- Only two exception icons: pause bars when paused, crossed circle when GPS/altitude is
  missing. No text status, no lift icon, no always-on indicator.
- Time redraws on `minutechange`; totals on lift end; icons only on state change. The
  detail screens do not redraw on every minute. No animations, no forced backlight.

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

- **Main** — clock, runs and day vertical, pause/no-GPS icons.
- **Today** — vertical, runs, first/last lift, average per run, longest run.
- **Season** — label, days, vertical, runs, average/day, best day. Computed on the watch
  from its stored daily aggregates; no phone round-trip needed.
- **More** (Select from any screen) — End/Resume Day, Pause/Resume, Undo Last Lift, Units,
  Vibration, Sync Now. Native-style scrolling menu with a black `MORE` header, inverted
  selection, chevrons, and fonts that follow the watch Text Size setting.
- **About screen removed.** Version/platform information lives in the README and appstore
  listing instead.
- **Action bar:** exact native geometry (34 px Emery / 40 px Gabbro, 45/80 px icon
  margins, 18 px icon boxes). White icons with black separator strokes on black. Emery is
  a straight bar; Gabbro is the firmware's `H × 19/9` circle clipped to the 40 px strip.
  Destination icons: Main = two peaks, Today = calendar, Season = stacked calendars,
  More = vertical ellipsis; in the menu, up/check/down. No press animation.
- **Up/Down** cycle Main/Today/Season. **Back** exits; the day starts automatically when
  the app opens, and state persists.
- No touch requirement. Trips are phone-only.

## Testing

- Detection, season/trip maths, persistence, and formatting live in one pure watch module,
  `src/embeddedjs/lib/core.js`; phone-side aggregation lives in `src/pkjs/lib/stats.js`.
  Together they have 50 Node tests, including cross-checks that both season/trip
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
- `src/c/mdbl.c` gives the engine an ~80 kB pool (stack 6 kB, slot 44 kB, chunk 28 kB).
  The action bar pushed the old 72 kB pool over; 88 kB failed to map the app archive.
- Sync protocol: the watch sends one JSON record at a time in `Sync` and waits for an
  `Ack` containing the record id. Kinds are `lift` and `lift-delete`. The phone dedupes
  by `date + seq` and stores records in PKJS `localStorage`.
- Settings travel both ways in the `Settings` key. The phone sends its stored settings on
  `ready`; the watch sends changes made on the wrist.
- The dashboard is generated by PKJS as a `data:` URL with all stats pre-rendered; the
  settings form closes with `pebblejs://close#`.
- The menu and detail screens scale from the watch's Text Size preference. A tiny FFI shim
  (`src/c/ffi.c`) exposes `preferred_content_size()` to JavaScript; the hero time stays
  fixed at maximum size.
- There is no base/started flag: the day is tracked whenever the app is open and not
  paused or ended. End Day is explicit and survives relaunch; a new date starts fresh.
- The app icon is a white rounded tile with two offset black peaks and a white snow cap on
  the taller left peak. The launcher icon is 25×25 (the Pebble tool's menu-icon cap); the
  80×80 and 144×144 store icons are generated by `tools/make-icons.py`.
- Bar and main-text colour presets are deferred to issue #2. The icon geometry already
  supports them; contrast handling is the open design question.

## Implementation status

- [x] Alloy project scaffolded for emery + gabbro
- [x] Watch core and phone stats with 50 Node tests
- [x] Poco screens, native action bar, native-style More menu, and icon-only status
- [x] Text Size/ContentSize FFI for the menu and detail fonts
- [x] Two-peak mountain app icon (launcher + store sizes)
- [x] Sync protocol, PKJS store, and ack/dedupe
- [x] Local dashboard with Today / Trips / Season / Settings
- [x] Debug mock lift
- [ ] Real-world threshold tuning
- [ ] Accelerometer-gated GPS
- [ ] Backcountry mode (issue #1)
- [ ] Bar/text colour presets (issue #2)

## Open questions

- Whether to persist an in-progress lift across an app restart (only completed lifts
  survive today).
- Whether a lift that spans midnight should count on its start day.
- How much of the season history to keep on the watch before rolling old seasons up.
