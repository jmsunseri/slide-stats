# Slide Stats — design notes

Working record of the decisions made while designing the app. Anything marked **open**
still needs a decision.

## Constraints

- Alloy supports Emery (Pebble Time 2, 200×228 rect) and Gabbro (Pebble Round 2, 260×260
  round) only.
- Neither watch has a barometer. The BMP390 driver in PebbleOS ships only on `asterix`
  (a Pebble 2 Duo-class board) and has no read API. Altitude comes from the phone's GPS
  through PKJS `navigator.geolocation`; the watch no longer opens a `Location` sensor.
- A real phone reports `coords.altitude`. `altitudeAccuracy` may be undefined; the
  detector accepts that and relies on its median and descent filters. The emulator reports
  neither altitude nor `altitudeAccuracy`.
- Alloy apps only run while open. Wakeups relaunch the app but cannot track continuously.
  The app must stay open during a ski day.
- PKJS starts when the watch app starts and stops when it exits. On iOS the phone app is
  suspended in the background and timers do not fire. Detection and storage must happen
  during the day, not only on exit.
- PKJS `localStorage` is per-app, durable, and survives app restarts.
- The only phone UI available to a watchapp is the config-page WebView, opened from the
  gear icon in the Pebble app. PKJS can generate it as a `data:` URL, so the Clay page can
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
- **Ownership:** the phone owns detection, today, and history. It pushes a compact
  `State` (today, current season, display settings, GPS status) to the watch and answers
  history `Query` messages. The watch caches the last state and sends commands. The legacy
  `Sync`/`Ack` path remains in PKJS for older watch builds but the current watch never uses
  it.
- **Resuming a ride:** the phone persists the active lift (start and peak) in
  `ss.phoneActive` every 30 seconds and on every detector event. On launch it is restored
  into the phone detector, so returning mid-climb continues the same ride, and returning
  on the descent ends it. The state is discarded on a new day. A long GPS gap keeps the
  active lift and lets the next samples extend or end it. Coordinates, when available, are
  part of the saved state.
- **Lift coordinates:** the phone detector keeps each sampled latitude/longitude in its
  ascent window, so a finished lift carries the bottom (lowest sample) and peak (descent
  start) coordinates. `phone-store` writes a compact `pts` array (start lat, start lon,
  peak lat, peak lon, degrees × 1e6) into `ss.lifts`; records without it remain valid. The
  watch never receives coordinates.
- **History screens:** Today's and the current season's totals come from the phone's
  pushed `State`. Past days and other seasons use `Query`/`Data`. The watch caches only a
  handful of summaries and prefetches the selected summary's immediate neighbours.
- **Theme:** three settings on the phone — background, accent, and text — chosen with
  Clay's 64-colour picker (legacy hex values are snapped per channel to 0x00, 0x55, 0xAA,
  or 0xFF). Background fills the face and the snow cap; accent fills the right-hand action
  bar, its icon cut-outs, and the ActionMenu crumb column; text colours the clock, rows,
  status icons, and the mountain mark. Bar icons and crumb dots stay white. The default
  accent is Duke Blue (`#0000AA`), Pebble's second-darkest blue. The native menu body uses
  the system black/white style. The watch stores packed `0xRRGGBB` numbers.
- **Phone page:** a Clay configuration page with **Settings** and **Stats** tabs.
  Settings is the default and holds units, vibration, trips, hemisphere, theme,
  lift-detection thresholds, and the Save button. Stats cover today and a selected season
  (current or past), plus that season's trips. A Season dropdown at the top of the Stats
  tab lists every stored season. At the bottom of Stats, **Manage data** reveals a
  multi-select list of that season's days and a **Delete selected** action; days are
  removed from the phone and a fresh `State` is pushed to the watch; a `Purge` is still
  sent for compatibility with older watch builds. No tables, charts, or export in v1. The
  day list is built when the page opens; there is no live fetch from PKJS. Detection
  thresholds are edited in metric units; the units setting changes the stats. A
  top-of-page reminder tells people to start the watch app before heading uphill; starting
  at the top loses the ascent.
- **Settings split:** quick items on the watch (undo last lift, units, vibration) become
  `Command` messages; theme, hemisphere, altitude processing interval, detection
  thresholds, trips toggle, and the Clay page live on the phone. The phone pushes the
  display settings back inside `State`.

## Main screen

Centred vertical stack, no decoration, with the native action bar on the right:

```
┌────────────────────────┬─────┐
│      ▲ ▲ ▲ ▲           │  ↑  │  four-peak mark
│                        │     │
│        10:42           │  ⋮  │  time, true vertical centre
│                        │     │
│    3 RUNS  1,240 m    │  ↓  │  stats, 24 px
│                        │     │
│  reserved bottom zone  │     │  disconnected/no-GPS at bottom
└────────────────────────┴─────┘
```

- Emery reserves the 34 px bar, so the time/stats centre in a 166 px content area.
- Gabbro overlays the 40 px curved bar on the rim, so the time stays at the exact centre
  of the circle. Detail rows stop at x≈210 so they do not merge with the bar.
- The upper zone carries a four-peak mark: a big snow-capped back peak on the right, the
  original tall snow-capped peak, and two smaller non-snow-capped front peaks. The small
  left front peak is 75% of the small right front peak's height. White separator lines mark
  where the front peaks overlap the back peaks. It is drawn in Poco, only on Main, and stays
  above the clock without competing with it.

- Time is the largest element: Roboto-Bold 49 digits (system font), with a small AM/PM
  suffix to the right when the watch is set to 12-hour. The digits and suffix are
  vertically centred as one block.
- No current altitude and no base altitude anywhere.
- Runs and day vertical directly below the time (Gothic-Bold 24, falling back to 18 if a
  large imperial value would not fit).
- Two exception icons: a disconnected watch when the phone link drops, and a crossed circle
  when GPS/altitude is missing. No text status, no lift icon, no always-on indicator.
- Time redraws on `minutechange`; totals on lift end; icons only on state change. The
  detail screens do not redraw on every minute. No animations, no forced backlight.

## Lift detection

- Altitude is median-filtered. Samples with `altitudeAccuracy` worse than ~30 m are
  ignored.
- **Fast start:** net gain ≥ 10 m within 30 s.
- **Slow start:** net gain ≥ 10 m within 90 s (covers bunny lifts and magic carpets).
- Most samples in the window must be rising, not a single noise spike.
- Any steady climb is treated as a lift, including a snowcat, car, or helicopter climb.
  Undo Last Lift corrects accidental detections.
- Detection runs on the median-filtered altitude. The lift's start and peak are recorded
  from raw altitudes so the filter does not shave metres off short lifts.
- **End:** raw altitude ≥ 5 m below the lift peak for two samples. There is deliberately
  no time-based backstop. Getting off and walking horizontally to another lift with no
  descent merges the two rides into one; this was accepted as an infrequent case.
- **Minimum counted lift:** 10 m, adjustable 5–50 m. A ride that ends below the minimum
  is discarded.
- Vibration: optional, default on. Mirrored custom rhythms so start and end are
  distinguishable and neither looks like a phone notification: an accelerating triple
  pulse at lift start (100/80/160/80/240 ms) and the same rhythm decelerating at lift end
  (240/80/160/80/100 ms).
- **Undo last lift** in the More menu; the phone receives a correction.

## Screens and input

- **Main** — clock, runs and day vertical, disconnected/no-GPS icon.
- **Today** — vertical, runs, first/last lift, average per run, longest run. Today's values
  come from the phone's `State`; past days are summaries fetched from the phone.
- **Season** — label, days, vertical, runs, average/day, best day, fetched from the phone
  so all watches share one combined history.
- **Titles:** `TODAY`, `YESTERDAY`, or `MMM DD` for a day; the season label for a season.
  Vertical values are unsigned; there is no leading `+`.
- **More** (Select from Main only) — Units, Vibration, and Undo Last Lift at the bottom.
  Uses Pebble's native ActionMenu with Units and Vibration submenus. The destructive Undo
  sits last. The left crumb column follows the theme accent; the body uses the system
  black/white style. The watch polls the FFI result and redraws after the menu closes.
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

- The canonical detector is `src/embeddedjs/lib/detector.js`; PKJS uses a generated
  CommonJS copy. Watch date/season/format helpers are in `src/embeddedjs/lib/format.js`;
  `core.js` is a compatibility barrel for the tests. Phone aggregation lives in
  `src/pkjs/lib/stats.js`. Together with the phone detector/store/runtime, sync/query
  handlers, Clay config/settings mapping, lift-resume, and coordinate tests, they have 95
  Node tests.
- Fixtures: slow chair, fast gondola, bunny lift, magic carpet, mid-lift stop, vehicle climb,
  noisy GPS, missing altitude, long sample gap, day rollover, lift coordinates.
- The emulator's fake GPS has no altitude, so detection cannot be exercised there.
  Detection needs a real phone outdoors; the PKJS probe can log live positions and events.
- Field test: one gondola in town, plus at least one real ski-day GPS trace to replay.

## Implementation notes

- The watch imports a single `format` module (date/season/format helpers). The detector
  and day store are no longer in the watch archive. Alloy charges memory per module, so
  keep the watch-side module count small.
- The UI is drawn with **Poco**, not Piu. It is a small, redraw-on-change interface, and
  Poco costs far less RAM on a ~122 kB app heap.
- The manifest deliberately includes only `manifest_mod.json`. Including Moddable's
  `manifest_typings.json` bundled the TypeScript `tsconfig` and `package` modules into
  the watch archive as dead runtime modules, costing 2.7 kB.
- `src/c/mdbl.c` gives the engine an ~80 kB pool (stack 5 kB, slot 48,640 B, chunk
  26,624 B). The precompiled archive is loaded into RAM, so these pools, the archive, and
  `fxMapArchive`'s temporary symbol/map tables all share the app heap. The phone
  redesign removed the detector and day store, which allowed the original slot pool to be
  restored. Remeasure with `npm run check-memory` before growing the bundle again.
- State protocol: the phone detects lifts, stores them in `ss.lifts`, and pushes a compact
  `State` on launch, lift end, reconnect, refresh, and command. The watch caches it in
  `ss.phone`. Lift start/end also sends an `Event` for vibration. The legacy `Sync`/`Ack`
  path remains for older watch builds. Deleting a selected day removes it from `ss.lifts`,
  pushes a fresh `State`, and sends a compatibility `Purge`.
- History protocol: `Query` carries `{ kind, key }`; `Data` returns the same key plus the
  day or season summary and its `older`/`newer` neighbours. The watch caps its summary
  cache, prefetches one level, and drops the queue on suspend.
- Command protocol: the watch sends `{ type, value }` for undo, units, vibration, and
  refresh. It updates display state optimistically; the next `State` is authoritative.
  Commands have no acknowledgement and are not persisted across app exit.
- Display settings travel inside `State`. The legacy `Settings` key is still accepted from
  older watch builds. The watch's quick settings changes use `Command` instead.
- The Clay page is generated by PKJS as a self-contained `data:` URL. Clay's automatic
  `showConfiguration`/`webviewclosed` handling is disabled because the page uses the
  nested settings model: the phone seeds Clay's `clay-settings` from `ss.settings`,
  unwraps the response, maps it back into the nested settings object, saves it, and
  pushes a fresh `State`. The active watch info is populated so Clay chooses the
  64-colour picker.
- The Settings/Stats tabs use a small custom Clay `tabs` component and a custom function.
  Items are tagged `group: "settings"`, `"stats"`, `"season:<key>"`, or `"data:<key>"`; the
  function shows/hides groups, applies the `season-picker`, enforces the `manage-data`
  toggle, clears hidden purge selections, and collapses empty sections. The tabs bar is
  sticky; Settings is the default and holds the Save button.
- The data tools are a Clay `checkboxgroup` per season, keyed `purge:<season>`, with a
  per-season Delete submit. The phone maps checked days back to `ss.lifts`, pushes a fresh
  `State`, and sends a compatibility `Purge` for today.
- The page closes with `pebblejs://close#` on a phone; the emulator needs the usual
  config-page helper to open Clay's pypkjs URL.
- The detail screens scale from the watch's Text Size preference. A tiny FFI shim
  (`src/c/ffi.c`) exposes `preferred_content_size()` to JavaScript; the hero time stays
  fixed at maximum size. The native ActionMenu uses the firmware's own font.
- There is no base/started flag: the day is tracked whenever the app is open. Exit the app
  to stop; reopening on the same day resumes the active lift. A new date starts fresh.
- The app icon is a white rounded tile with two offset black peaks and a white snow cap on
  the taller left peak. The peaks run into the lower border and are clipped to the rounded
  badge, so there is no white strip between the mountains and the border. The launcher icon
  is 25×25 (the Pebble tool's menu-icon cap); the 80×80 and 144×144 store icons are
  generated by `tools/make-icons.py`. The main-screen mark is now a separate four-peak
  composition; the launcher/store badge remains the two-peak icon until those assets are
  redrawn.
- Theme colours travel as packed numbers, and the phone snaps picks to the watch palette
  before sending them. The watch reuses its existing white/black colours for the default
  theme to avoid allocating duplicates.
- Memory budget: `npm run check-memory` (or `node tools/memory-budget.mjs --check`) models the
  hardware startup allocation: XS pools, resident archive, and mapper tables. The emulator
  maps the archive in place, so a successful emulator boot does not prove the hardware margin.
  See `docs/memory-plan.md` for the calibration and current headroom.

## Implementation status

- [x] Alloy project scaffolded for emery + gabbro
- [x] Phone detector/store/runtime and watch state cache with 93 Node tests
- [x] Poco screens, native action bar, native ActionMenu, and icon-only status
- [x] Text Size/ContentSize FFI for the detail fonts
- [x] Two-peak app icon (launcher + store) and four-peak main-face mark
- [x] Phone-authoritative State/Command/Event protocol and PKJS store
- [x] Phone-backed Today and Season history with prefetch
- [x] Resume an in-progress lift across watch and phone restarts
- [x] Three-colour theme from the phone settings
- [x] Clay configuration page with settings and current-season stats
- [ ] Real-world threshold tuning
- [ ] Accelerometer-gated GPS
- [ ] Backcountry mode (issue #1)

## Open questions

- Whether to finalise a stale resumed lift at the peak when the app is never opened again
  that day, and how long a same-day resume should remain valid.

## Decisions since the redesign

- A lift that spans midnight counts on the day it **ends**, matching the previous watch
  behavior. `phone-store` keys records by `endTime`.
- The watch keeps the live `State` plus a small `Query`/`Data` cache. Past days and other
  seasons are fetched on demand; no season history is stored on the watch.
- The watch distinguishes a dropped phone link (disconnected-watch icon from Pebble
  iconography) from a connected phone without altitude (crossed circle).
- Command delivery is best-effort. The next `State` corrects units/vibration; Undo is not
  replayed after a restart.
