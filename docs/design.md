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
  lift; unacked records flush on launch. Every record carries a unique `uid`; the phone
  dedupes by `uid` (with `seq` as the legacy fallback), so a reinstall, a seq reset, or a
  second watch cannot double-count. There are no per-watch totals.
- **History screens:** Today and Season are backed by the phone. The watch asks for one
  summary at a time with `Query` and the phone answers with `Data`. The watch keeps today's
  totals live from local data and uses the phone only for past days and neighbour keys.
  Only the selected summary's immediate neighbours are prefetched.
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
│        ▲ ▲             │  ↑  │  app-icon two-peak mark
│                        │     │
│        10:42           │  ⋮  │  time, true vertical centre
│                        │     │
│    3 RUNS  1,240 m    │  ↓  │  stats, 24 px
│                        │     │
│  reserved bottom zone  │     │  status icons at bottom
└────────────────────────┴─────┘
```

- Emery reserves the 34 px bar, so the time/stats centre in a 166 px content area.
- Gabbro overlays the 40 px curved bar on the rim, so the time stays at the exact centre
  of the circle. Detail rows stop at x≈210 so they do not merge with the bar.
- The upper zone carries the app icon's two-peak mark (taller left peak, white snow cap,
  shorter right peak). It is drawn in Poco from the icon's proportions, only on Main, and
  stays above the clock without competing with it.

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
- **Today** — vertical, runs, first/last lift, average per run, longest run. Today's values
  come from the live watch store; past days are summaries fetched from the phone.
- **Season** — label, days, vertical, runs, average/day, best day, fetched from the phone
  so all watches share one combined history.
- **Titles:** `TODAY`, `YESTERDAY`, or `MMM DD` for a day; the season label for a season.
  Vertical values are unsigned; there is no leading `+`.
- **More** (Select from Main only) — End/Resume Day, Pause/Resume, Undo Last Lift, Units,
  Vibration, Sync Now. Scrollable native-style menu with no header. The selected row uses a
  black vertical bar at the left plus bold text, not an inverted row. Chevrons show when
  more rows exist; the menu font is capped at 18 px.
- **About screen removed.** Version/platform information lives in the README and appstore
  listing instead.
- **Action bar:** exact native geometry (34 px Emery / 40 px Gabbro, 45/80 px icon
  margins, 18 px icon boxes). White icons with black separator strokes on black. Emery is
  a straight bar; Gabbro is the firmware's `H × 19/9` circle clipped to the 40 px strip.
  Destination icons: Main = two peaks, Today = calendar, Season = stacked calendars,
  More = vertical ellipsis; in the menu, up/check/down. No press animation.
- **Main:** Up opens Season, Down opens Today, Select opens More, Back exits; the day
  starts automatically when the app opens, and state persists.
- **Today / Season:** Up and Down step to older and newer summaries, with plain chevrons
  only where a neighbour exists. Select is a no-op and its action-bar slot is blank; Back
  returns to Main. More is reachable only from Main.
- No touch requirement. Trips are phone-only.

## Testing

- Detection, season maths, persistence, and formatting live in one pure watch module,
  `src/embeddedjs/lib/core.js`; phone-side aggregation lives in `src/pkjs/lib/stats.js`.
  Together with the PKJS sync/query handler tests, they have 49 Node tests.
- Fixtures: slow chair, fast gondola, bunny lift, magic carpet, mid-lift stop, car climb,
  noisy GPS, missing altitude, long sample gap, day rollover.
- The emulator's fake GPS has no altitude, so the old debug mock was removed to keep the
  bundle inside the archive mapping limit. Detection needs a real watch and phone.
- Field test: one gondola in town, plus at least one real ski-day GPS trace to replay.

## Implementation notes

- One core module holds the detector, season keys, day store, and formatting. Alloy
  charges memory per module; four modules plus Piu exceeded the watch's engine heap.
- The UI is drawn with **Poco**, not Piu. It is a small, redraw-on-change interface, and
  Poco costs far less RAM on a 128 kB app heap.
- `src/c/mdbl.c` gives the engine an ~80 kB pool (stack 6 kB, slot 44 kB, chunk 28 kB).
  The action bar pushed the old 72 kB pool over; 88 kB failed to map the app archive.
- Sync protocol: the watch sends one JSON record at a time in `Sync` and waits for an
  `Ack` containing the record id. Kinds are `lift` and `lift-delete`. The phone dedupes by
  `uid` and stores records in PKJS `localStorage`.
- History protocol: `Query` carries `{ kind, key }`; `Data` returns the same key plus the
  day or season summary and its `older`/`newer` neighbours. The watch caps its summary
  cache, prefetches one level, and drops the queue on suspend.
- Settings travel both ways in the `Settings` key. The phone sends its stored settings on
  `ready`; the watch sends changes made on the wrist.
- The dashboard is generated by PKJS as a `data:` URL with all stats pre-rendered; the
  settings form closes with `pebblejs://close#`.
- The menu and detail screens scale from the watch's Text Size preference. A tiny FFI shim
  (`src/c/ffi.c`) exposes `preferred_content_size()` to JavaScript; the hero time stays
  fixed at maximum size, and the menu font stops at 18 px.
- There is no base/started flag: the day is tracked whenever the app is open and not
  paused or ended. End Day is explicit and survives relaunch; a new date starts fresh.
- The app icon is a white rounded tile with two offset black peaks and a white snow cap on
  the taller left peak. The launcher icon is 25×25 (the Pebble tool's menu-icon cap); the
  80×80 and 144×144 store icons are generated by `tools/make-icons.py`. The main-screen
  mark redraws the same geometry in Poco; keep the two in sync if the peaks change.
- Bar and main-text colour presets are deferred to issue #2. The icon geometry already
  supports them; contrast handling is the open design question.

## Implementation status

- [x] Alloy project scaffolded for emery + gabbro
- [x] Watch core and phone stats with 49 Node tests
- [x] Poco screens, native action bar, native-style More menu, and icon-only status
- [x] Text Size/ContentSize FFI for the menu and detail fonts
- [x] Two-peak mountain app icon (launcher + store sizes)
- [x] Sync protocol, PKJS store, and ack/dedupe
- [x] Phone-backed Today and Season history with prefetch
- [x] Local dashboard with Today / Trips / Season / Settings
- [ ] Real-world threshold tuning
- [ ] Accelerometer-gated GPS
- [ ] Backcountry mode (issue #1)
- [ ] Bar/text colour presets (issue #2)

## Open questions

- Whether to persist an in-progress lift across an app restart (only completed lifts
  survive today).
- Whether a lift that spans midnight should count on its start day.
- How much of the season history to keep on the watch before rolling old seasons up
  (currently none: every past day and season is fetched from the phone).
