# Slide Stats — memory and runtime reliability plan

Working plan for the memory/layout issues identified in the architecture review, plus the
ActionMenu experiment. See the implementation log for what has actually shipped. It is
intended to be the reference we work from, so each change can be justified against a measured
budget instead of being discovered by a failed launch.

Plan written against `60c9238`. The Phase 0, L1–L5, option-2, and slot-pool work was later
committed to `main`; the phone-authoritative redesign is implemented on a feature branch
pending review.

## Contents

1. [Purpose](#1-purpose)
2. [Constraints and the actual memory model](#2-constraints-and-the-actual-memory-model)
3. [Risk definitions](#3-risk-definitions)
4. [Phase 0 — baseline and guardrails](#4-phase-0--baseline-and-guardrails)
5. [Low-risk items](#5-low-risk-items)
6. [Medium-risk items](#6-medium-risk-items)
7. [High-risk items](#7-high-risk-items)
8. [Test and verification strategy](#8-test-and-verification-strategy)
9. [Recommended implementation order](#9-recommended-implementation-order)
10. [Open questions / decisions](#10-open-questions--decisions)
11. [Appendix — baseline worksheet](#11-appendix--baseline-worksheet)
12. [Implementation log](#12-implementation-log)

---

## 1. Purpose

The watch app is close to a hard memory cliff:

- The Moddable XS pools and the archive already consume almost all of the app heap.
- A relatively small amount of new C code can prevent the app from launching, before any
  JavaScript runs, with `fxMapArchive failed`.
- Several runtime paths allocate much more than they need: full-day clones, whole-state JSON
  serialization on every GPS sample, and whole-outbox clones.
- The current Node tests cannot detect any of the watch-side memory failures.

This plan separates the work into:

1. **Measurement and guardrails** — make the budget visible and prevent blind regressions.
2. **Low-risk runtime fixes** — localized, behavior-preserving, easy to test.
3. **Medium-risk fixes** — storage format or messaging changes that need migration and
   emulator verification.
4. **High-risk changes** — state-model, protocol, native-UI, or lifecycle changes.
5. **Documentation and rollout** — what to update, how to sequence commits, when to stop.

The plan deliberately does **not** mix the native ActionMenu decision into the low-risk work.
The review’s startup analysis shows that runtime allocation fixes do not solve a startup
archive-mapping failure.

---

## 2. Constraints and the actual memory model

### 2.1 Fixed allocations

From `src/c/mdbl.c`:

| Consumer | Bytes |
| --- | ---: |
| XS stack | 5,120 |
| XS slot pool | 48,640 |
| XS chunk pool | 26,624 |
| **Total XS pools** | **80,384** |

The archive is built into `build/mods/emery/mc.xsa`. At `60c9238` its XSA atom is about
**35,643 bytes**. The app image at `60c9238` is **620 bytes** (`build/emery/pebble-app.bin`).

### 2.2 Why the app image matters

The original architecture review lists pools, archive, and mapper temporaries. It does not list
the app image/BSS, but those reduce the available heap one-for-one.

A calibration from the ActionMenu experiment:

```text
app heap base (measured/calibrated, SDK 4.44 emulator)   122,852
original app image + BSS                                     628
free heap before moddable_createMachine                   122,224
```

During archive mapping, the runtime also needs:

| Allocation | Bytes |
| --- | ---: |
| XS pools | 80,384 |
| Resident archive | 35,643 |
| Mapper scratch + read buffer | 1,280 |
| Mapper identifier table | ~988 |
| Mapper maps table | 3,610 |
| **Known startup total** | **121,905** |

That leaves on the order of **a few hundred bytes**, not several kilobytes, before allocator
metadata and other native/VM allocations. Treat the exact number as approximate; the point is
that the margin is effectively zero.

The ActionMenu experiment confirmed the app-image effect directly:

- Same archive, same JavaScript, same pools.
- A minimal ActionMenu C shim loaded.
- A full menu C shim failed in `fxMapArchive` before application logs.
- GDB showed the archive header was valid and `fxMapArchive()` returned `NULL`.

Adding roughly 1 KB of C code reduced the available heap by roughly 1 KB, which was enough to
turn a few hundred bytes of margin into a negative one. This is the single most important
constraint for any native-menu work.

### 2.3 What fails when

The failure mode tells us which budget matters:

| Failure point | Budget |
| --- | --- |
| `fxMapArchive` before app logs | Startup: pools, archive, mapper metadata, app image/BSS |
| JS `memory full` during load | Slot/chunk heap after mapping |
| Failure while sampling or syncing | Slot/chunk heap, JSON strings, outbox/day duplication |
| Failure after repeated GPS stop/start | Possible native object leak; needs reproduction |

Startup fixes are not the same as runtime fixes. In particular, reducing AppMessage buffers,
Poco display lists, or runtime clones does **not** make archive mapping succeed.

---

## 3. Risk definitions

- **Low risk**
  - Behavior-preserving, localized change.
  - No persisted-state format change.
  - Covered by existing or straightforward Node tests.
  - No emulator-only behavior required to validate.

- **Medium risk**
  - Changes persisted state, message buffer sizes, or cross-module behavior.
  - Needs migration/compatibility handling and an emulator sync/restart check.
  - May change peak memory in more than one pool.

- **High risk**
  - Changes the state model, sync protocol, native UI/startup budget, or object lifecycle.
  - Needs a design decision, staged rollout, and explicit rollback.
  - Cannot be validated by Node tests alone.

---

## 4. Phase 0 — baseline and guardrails

Do this first. It adds no runtime behavior and gives every later change a visible budget.

### 4.1 Build-time memory budget script

Add `tools/memory-budget.mjs`.

**Inputs**

- `build/<platform>/pebble-app.bin` — app image size, or parse the process-info header.
- `build/<platform>/pebble-app.elf` — optional, for `arm-none-eabi-size` and BSS.
- `build/mods/<platform>/mc.xsa` — the XSA archive. Parse the top-level atoms:
  `VERS`, `SIGN`, `NAME`, `SYMB`, `IDEN`, `MAPS`, `MODS`, `RSRC`.
- `src/c/mdbl.c` — parse `.stack`, `.slot`, `.chunk`.
- A calibrated `APP_HEAP_BASE` constant (see below), clearly marked as an emulator/SDK
  measurement that must be re-checked on hardware and after SDK changes.

**Calculations**

```text
freeHeap       = APP_HEAP_BASE - appImageAndBss
symbols        = uint16le(SYMB.payload[0..1])
mapperIds      = symbols * sizeof(txID)        // txID is 2 bytes in XS
mapperMaps     = MAPS.size - 8
mapperScratch  = 1024 + 256
startupPeak    = pools + archiveSize + mapperScratch + mapperIds + mapperMaps
margin         = freeHeap - startupPeak
```

Print a table with:

- app image and virtual/BSS size,
- archive size,
- `SYMB`, `IDEN`, `MAPS` sizes,
- pools,
- mapper estimate,
- free heap,
- startup peak,
- margin.

**Exit behavior**

- `--check` exits non-zero when `margin < 0`.
- Warn when `margin < 1024`.
- Keep a documented baseline so a change that consumes margin is visible in review.
- Allow an explicit `--update-baseline` after a deliberate change.

**Caveats**

- `APP_HEAP_BASE` is calibrated from the SDK 4.44 emulator. Record the exact SDK and build
  configuration next to the constant.
- Do not claim byte-exact hardware accuracy. The script’s job is to catch direction and
  magnitude, not to replace on-watch measurement.
- The mapper tables are temporary. Do not add them to runtime peaks after startup.

**Integration**

- Add an npm script, for example `"check-memory": "node tools/memory-budget.mjs --check"`.
- Add a short section to `docs/design.md` pointing to this plan and the script.
- Optional CI: a separate build job that installs the Pebble SDK and runs
  `pebble build && node tools/memory-budget.mjs --check`. The current CI only runs Node tests,
  so this can be a follow-up if SDK setup in CI is too heavy.

### 4.2 Node memory/size tests

Add `test/memory.test.mjs` (or `test/persistence-size.test.mjs`).

Use a storage double that records every write:

```js
function recordingStorage() {
  const map = new Map();
  const writes = [];
  return {
    map,
    writes,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      writes.push({ key, bytes: Buffer.byteLength(value, "utf8"), value });
      map.set(key, value);
    },
    removeItem: key => map.delete(key),
  };
}
```

Tests to add:

1. **State size at representative lift counts**
   - Create a store with a fake clock.
   - Add 0, 20, 30, and 50 lifts with coordinates.
   - Record the size of the last `ss.state` write.
   - Assert against generous caps (for example, 30 lifts must stay below 16 KB) and print
     the measured values in the test output.
   - Purpose: catch accidental growth in the persisted shape.

2. **Active-sample write size**
   - With 30 lifts, call `setActiveLift(detector.snapshot())`.
   - Before the active-persistence change (M1), assert the written value is the same order as
     the full state; after M1, assert the `ss.active` write is small (for example < 256 bytes)
     and that `ss.state` was not written.
   - This test will be introduced in Phase 0 as a measurement and updated in Phase 2.

3. **Outbox head**
   - Assert `peekOutbox()` equals the first `getOutbox()` record and returns `null` when empty.

4. **Settings clone count / identity**
   - Where practical, assert that actions update the local `settings` object without
     repeatedly cloning. This is easier to verify by code review than by identity tests; at
     minimum, test that returned settings are isolated from store mutation.

5. **Queue policy**
   - If the queue policy is extracted to `core.js`, test capacity, deduplication, clearing,
     and suspend behavior directly.

### 4.3 Measurement discipline

- Do **not** add release-build logging to save bytes unless the budget script says there is
  room. Use `PBL_DEBUG` instrumentation and the build-time script for release.
- Record before/after values for every memory-related change in the commit message.
- Build both `emery` and `gabbro` for every phase.
- Smoke-test on the emulator after every phase; the budget script cannot catch every layout
  problem.

---

## 5. Low-risk items

### L1. Stop retaining a full cloned day at startup

**Files:** `src/embeddedjs/main.js:26-30`, `src/embeddedjs/lib/core.js:671-674`.

**Current code**

```js
const savedToday = store.getToday();
if (savedToday && savedToday.active)
  detector.restore(savedToday.active);
```

`store.getToday()` clones the entire day with `JSON.parse(JSON.stringify(...))`, including every
lift. The clone is module-level, so it stays reachable for the whole app lifetime.

**Change**

Preferred:

- Add `getActiveLift()` to the store:

  ```js
  getActiveLift: () => (today && today.active ? clone(today.active) : null),
  ```

- Replace `savedToday` with:

  ```js
  const savedActive = store.getActiveLift();
  if (savedActive)
    detector.restore(savedActive);
  ```

Minimum fallback if we do not want a new API:

- Put the existing clone in a block so it becomes collectible immediately:

  ```js
  {
    const savedToday = store.getToday();
    if (savedToday && savedToday.active)
      detector.restore(savedToday.active);
  }
  ```

The block still creates the transient clone at startup. The narrow accessor avoids the clone
entirely and is preferred.

**Tests**

- Active lift survives a store reload (`test/day-store.test.mjs`, `test/restart.test.mjs`).
- `getActiveLift()` returns `null` when no lift is active.
- Mutating the returned object does not affect the store.
- Existing restart behavior is unchanged.

**Acceptance**

- No module-level full-day clone remains.
- Resuming an in-progress lift still works.
- All tests pass; both targets build.

**Rollback**

- Revert the accessor and restore `getToday()` usage. No persisted-state change.

---

### L2. Stop cloning the whole outbox to send one record

**Files:** `src/embeddedjs/main.js:723-732`, `src/embeddedjs/lib/core.js:673`.

**Current code**

```js
const queue = store.getOutbox();
if (!queue.length) return;
const record = queue[0];
```

`getOutbox()` clones every pending record, including every lift payload and coordinate array,
just to send the first one.

**Change**

- Add a head accessor:

  ```js
  peekOutbox: () => (outbox.length ? clone(outbox[0]) : null),
  ```

- Use it in `flushOutbox()`:

  ```js
  const record = store.peekOutbox();
  if (!record) return;
  ```

Keep `getOutbox()` for tests and any full-view callers.

**Tests**

- `peekOutbox()` equals `getOutbox()[0]`.
- `peekOutbox()` is `null` when empty.
- Mutating the returned record does not affect the store.
- Existing sync/ack/dedupe tests pass.

**Acceptance**

- No full-outbox clone on the send path.
- Outbox behavior is unchanged.

**Rollback**

- Revert to `getOutbox()`; no state change.

---

### L3. Remove redundant settings clones

**Files:** `src/embeddedjs/main.js:521-524`, `895-945`, `861-889`, `src/embeddedjs/lib/core.js:595-603`.

**Current pattern**

Several actions do:

```js
store.setSettings(patch);
settings = store.getSettings();
...
updateAll();
```

and `updateAll()` immediately does `settings = store.getSettings()` again. Each call clones the
whole settings object, including the detection object.

**Change**

- Make `setSettings()` and `setPaused()` return the new settings value. To avoid exposing the
  live internal object, return a clone (the same clone the caller currently obtains):

  ```js
  function setSettings(patch) {
    settings = mergeSettings(settings, patch || {});
    save();
    return clone(settings);
  }
  ```

- Split the current `updateAll()`:

  ```js
  function updateAll(nextSettings) {
    settings = nextSettings || store.getSettings();
    draw();
  }
  ```

- Actions pass the value returned by the store:

  ```js
  settings = store.setSettings({ units: nextUnits });
  sendSettings();
  updateAll(settings);
  ```

This changes two clones per action into one. It also makes the data flow explicit.

**Alternative**

If returning a clone from `setSettings` is too subtle, keep the current return behavior and add
`getSettingsSnapshot()` caching only inside `updateAll` for a single draw. That saves less, so
prefer the explicit return value.

**Tests**

- Settings updates persist and round-trip.
- Toggles still apply exactly once.
- Returned settings are isolated from subsequent store mutation.
- Existing settings/clay/pkjs tests pass.

**Acceptance**

- No action calls `getSettings()` twice for the same change.
- No behavior change in units, vibration, pause, or phone-applied settings.

**Rollback**

- Restore the old `setSettings` signature and `updateAll()` body. No state change.

---

### L4. Bound and clear the summary request queue

**Files:** `src/embeddedjs/main.js:49`, `686-696`, `745-755`, `781-803`, `docs/design.md:200`.

**Current behavior**

- `queueSummary()` appends every distinct uncached key.
- The completed-summary cache is capped at six entries, but the request queue is not.
- `onSuspend()` requeues the active request and leaves the rest of the queue intact.
- Changing screens does not clear stale requests.

This contradicts the design note that the queue is dropped on suspend, and it can grow
unboundedly while offline or while browsing quickly.

**Change**

Define an explicit policy:

- Capacity: six entries, matching the summary cache. (Alternative: eight; decide before
  implementation.)
- Deduplicate: keep the existing duplicate check.
- Overflow: drop the **newest** queued prefetch rather than the oldest, so the selected
  screen’s immediate neighbours are not displaced by speculative prefetches. Document the
  choice.
- Screen change: clear queued-but-not-started requests; let an in-flight request finish.
- Suspend: clear the queue. Do not requeue the active request on suspend. On resume, the
  current screen will queue what it needs again.
- Active request timer: clear it on suspend as today.

**Implementation shape**

Implemented as a small pure `summaryQueuePush(queue, kind, key, limit = 6)` in `core.js`.
`main.js` keeps the plain array and handles `shift`, `unshift`, and `length = 0`. This is
smaller than a queue object while keeping the cap and duplicate rule unit-testable. The
archive cost was measured: the helper and its tests added about 32 bytes of archive compared
with inlining the loop directly in `main.js`.

**Tests**

- Capacity is never exceeded.
- Duplicate requests are ignored.
- Screen change clears queued work.
- Suspend clears queued work and does not requeue the active request.
- Resume re-queues the selected screen’s summary.

**Acceptance**

- `queryQueue` length is bounded.
- Behavior matches `docs/design.md` or the design doc is updated deliberately.
- Offline navigation cannot accumulate an arbitrary queue.

**Rollback**

- Restore the old queue functions. No persisted-state change.

---

### L5. Delete dead code

**Files:** `src/embeddedjs/lib/core.js:87`, `97`, `296`, `346-347`, `674`.

Candidates:

- `lastAltitude` — assigned but not read.
- `NORTH` / `SOUTH` — unused constants.
- `getNextSeq` — exported but unused by the app or tests.

Before removing each:

- `grep -R` the whole repository, including tests and PKJS.
- Confirm no external consumer in the app bundle.

**Why it matters**

The direct runtime saving is small. In a mod archive, unused exports can still contribute
symbol/identifier/map bytes, and the startup budget is tight enough that small savings are
worth taking — but this will not solve the startup problem alone.

**Tests**

- Existing suite. No behavior change expected.

**Acceptance**

- All references are gone; both targets build; tests pass.

**Rollback**

- Trivial to restore individual symbols if a hidden consumer appears.

---

## 6. Medium-risk items

### M1. Persist the active lift separately from the full day state

**Files:** `src/embeddedjs/lib/core.js:466-476`, `483-509`, `517-545`, `613-618`; `src/embeddedjs/main.js:621`.

**Problem**

Every accepted GPS sample calls:

```js
store.setActiveLift(detector.snapshot());
```

`setActiveLift()` calls `save()`, which stringifies the entire state: settings, all of today’s
lifts, the complete outbox, and the sequence. The active snapshot itself is only 4 or 8
numbers. At 30 unacknowledged lifts, one full-state string is already around 13.8 KB, over half
of the 26 KiB chunk pool, before storage copies and parsing.

**Proposed storage shape**

Keep the day state’s shape and version compatibility, but move the active snapshot to its own
key:

```text
ss.state:
  { v: 2, settings, today: { date, closed, lifts }, outbox, nextSeq }

ss.active:
  { v: 1, date, lift: [ ... 4 or 8 numbers ... ] }
```

In memory, `today.active` can remain so existing `getToday()` callers and tests keep working.
`save()` must serialize a copy of the day without `active` (for example
`{ ...today, active: undefined }`) so the in-memory object stays useful to `getToday()` and
the restart tests.

**Write paths**

- `setActiveLift(lift)`:
  - `null`: clear `today.active`; remove/write-empty `ss.active`; do not write `ss.state`.
  - non-null: set `today.active`; write only `ss.active`.
- `addLift()`: set `today.active = null`; save `ss.state` (the day now includes the completed
  lift); then clear `ss.active`.
- `undoLastLift()`: save `ss.state`; clear `ss.active` if the removed lift was active? The
  current code does not clear active on undo; review and decide. At minimum, do not restore a
  stale active snapshot after an undo.
- `purgeDay()`: clear active and remove `ss.active`.
- `endDay()` / `setPaused(true)`: clear active and remove `ss.active`.
- `ensureToday()` on a new date: clear active.
- Main app: `applySettings` when paused/closed, and `handlePurge`, already call
  `setActiveLift(null)`; ensure they go through the same clear path.

**Load path**

1. Parse `ss.state` into `settings`, `today`, `outbox`, `nextSeq`.
2. Migrate a legacy `stored.today.active` if present:
   - use it as a fallback active snapshot,
   - write it to `ss.active`,
   - omit `active` from the next `ss.state` write.
3. Read `ss.active`:
   - if it is valid and `date === today.date`, set `today.active` and let the app restore it;
   - if invalid or from another date, remove it.

**Crash consistency**

Splitting one atomic write into two creates a window between “lift completed” and “active key
cleared.” Handle it explicitly:

- Include enough information in the active record to detect a completed lift (for example,
  `date`, `startTime`, or `uid`).
- On load, if the active record’s start is not after the last completed lift’s end (or if the
  day state marks that lift as completed), ignore and remove the active key.
- Document the chosen guard and test the two crash windows:
  - crash after `ss.state` writes the lift but before `ss.active` is cleared;
  - crash after `ss.active` is cleared but before the day state writes the lift.

The second window should not lose an active lift if the active key is cleared only after the
day save. Choose an order and test it.

**Tests**

Add `test/active-persistence.test.mjs` or extend `test/restart.test.mjs`:

- Active survives reload and is restored.
- Active is cleared by pause, end day, purge, and date rollover.
- `setActiveLift()` writes only `ss.active` and does not write `ss.state`.
- A stale `ss.active` from a previous day is ignored and removed.
- A completed lift followed by a crash before clearing active does not double-count on reload.
- Legacy v1 state with `today.active` migrates and resumes.

Update the recording-storage test to assert active-sample bytes are small.

**Acceptance**

- Sampling an active lift no longer serializes settings, all lifts, or the outbox.
- Restart/resume behavior is preserved.
- No double-count after the crash windows above.
- Both targets build and pass the emulator restart check.

**Rollback**

- Bump the state version/migration and keep the old key readable. Reverting the code should
  still load v2 by ignoring `ss.active`; document the compatibility path before shipping.

---

### M2. Reduce AppMessage buffers after proving payload bounds

**Files:** `src/embeddedjs/main.js:660-665`; PKJS payload builders in `src/pkjs/index.js` and
`src/pkjs/lib/stats.js`.

**Current**

```js
input: 1024,
output: 1024,
```

**Payload inventory**

| Message | Direction | Current shape | Notes |
| --- | --- | --- | --- |
| `Sync` | watch → phone | one lift record, optional `pts` | Review measured ~278 bytes |
| `Ack` | phone → watch | `{ id }` | small |
| `Settings` | both | full nested settings JSON | phone sends on ready/save; watch sends on changes |
| `Query` | watch → phone | `{ v, kind, key }` | small |
| `Data` | phone → watch | summary plus neighbours | day/season summary |
| `Purge` | phone → watch | `{ date }` | small |

**Change**

1. Add a payload-bound test that constructs the **largest representative** values for each
   message and asserts UTF-8 JSON length ≤ 500 bytes (leaving headroom for AppMessage
   overhead).
2. Add a small guard before `message.write()` in the watch app and PKJS senders:
   log/skip or fail loudly if a payload exceeds the agreed limit.
3. Reduce buffers in stages:
   - First try `input: 512`, `output: 512`.
   - If any real payload is close to the limit, use `768` instead and document why.
4. Test:
   - settings sync in both directions,
   - lift sync with coordinates,
   - day and season summaries,
   - purge and ack,
   - reconnect/suspend behavior.

**Why this is medium risk**

AppMessage failures can be silent or truncate data. A payload that grows later (for example,
more detection settings) could break sync without a compile-time error. The bound test is the
guardrail.

**Acceptance**

- All representative payloads measured and under the chosen limit.
- Emulator sync/ack works with the reduced buffers.
- A payload that exceeds the limit produces a clear log, not a silent failure.

**Rollback**

- Restore 1024/1024. This is a one-line change and does not affect persisted state.

---

## 7. High-risk items

### H1. Remove duplicate current-day/outbox representation

**Files:** `src/embeddedjs/lib/core.js:517-545`, `551-568`, `606-618`; `src/embeddedjs/main.js:723-743`.

**Problem**

A completed lift is stored twice:

- compactly in `today.lifts`, for the watch’s day totals and resume logic;
- as a full outbox record, including `id`, `kind`, `date`, `seq`, `uid`, and optional `pts`.

Until the phone acks it, both copies are live and both are serialized on every full save. A
disconnected phone therefore increases both live heap usage and JSON/serialization peaks.

**Options**

A key constraint limits all of these options: the outbox must survive day rollover, but
`today.lifts` does not. After midnight, the previous day’s unacked lifts exist only in the
outbox. Any de-duplication must preserve that durability.

**Option A — reference current-day lifts; materialize full records at rollover**

- Store `{ id, kind, date, uid, seq }` in the outbox for a lift.
- For `kind: "lift"`, resolve the lift by `uid` in `today.lifts` and build the sync payload
  when sending.
- For `kind: "lift-delete"`, the identity is enough.
- Before `ensureToday()` replaces the day, convert any unacked lift references into full
  outbox records so they survive midnight.
- Tradeoffs:
  - Removes duplicate payloads and coordinate arrays for the common current-day case.
  - Adds a rollover step that must be written and tested atomically with the new day.
  - `flushOutbox()` needs a lookup by uid; a linear scan is fine for a day.
  - If a lift is removed before ack, the delete record only needs identity.

**Option B — one canonical lift list with an `acked` flag**

- Keep `today.lifts` as the only in-memory lift list; each lift carries `acked`.
- Derive pending sends from lifts where `acked === false`.
- Ack marks the lift acked.
- At day rollover, move unacked lifts into durable outbox payloads and discard acked lifts
  (the phone owns history).
- Tradeoffs:
  - Cleanest in-memory model.
  - Larger state-model and migration change.
  - Still needs the rollover materialization step.

**Option C — keep the full-record outbox**

- Keep the current durable outbox shape.
- Accept the current-day duplication as the price of simple, crash-safe sync.
- Focus instead on M1 (do not reserialize full state per sample) and L2 (do not clone the whole
  outbox to send one record).

**Recommendation**

Do M1 and L2 first and re-measure. If the outbox is still a large fraction of the
serialization peak, pursue Option A with an explicit rollover materialization step. Do not ship
a reference-only outbox without handling the midnight case: it would lose unacked previous-day
lifts. Option C is the safe fallback if the measurements show the duplication is not the
dominant cost.

**Tests**

- Outbox record built from a reference matches the current payload exactly.
- Ack removes the reference and does not remove the lift.
- Undo queues a delete record without a full lift payload.
- Reload with pending records still syncs.
- **Rollover:** add a lift, do not ack it, advance the clock to the next day, call
  `ensureToday()`, and verify the outbox still has a full, usable record.
- **Rollover + ack:** ack after rollover and verify the record is removed.
- Migration from the current full-record outbox.

**Acceptance**

- No full lift payload duplicated between `today.lifts` and the outbox for the common
  current-day case.
- Unacked previous-day records always remain sendable.
- Sync/ack/undo behavior is unchanged.
- Both targets build; emulator sync works.

**Rollback**

- Keep the old record shape readable on load; normalize on save. Reverting the code should
  still load the reference shape or migrate it back.

---

### H2. Native ActionMenu and the startup budget

**Status:** implemented after the phone-authoritative redesign freed the startup budget.
The menu uses a small FFI shim, six root rows, and Units/Vibration submenus. See 12.10 for
the measured result.

**Files:** `src/c/ffi.c`, `src/c/mdbl.c`, `src/embeddedjs/main.js`, `src/embeddedjs/manifest.json`.

**What we learned**

- The ActionMenu API is reachable via FFI and works for a minimal shim.
- The full menu shim (10 actions, two submenus, callbacks, config) pushes the app image over
  the startup budget and causes `fxMapArchive` before JS runs.
- Runtime allocation fixes do not help a startup mapping failure.
- The native ActionMenu body is always black/white; only the crumb column is themeable, so it
  does not match the app’s three-colour theme.

**Decision criteria**

Do not start a native ActionMenu implementation unless the budget script shows a startup
margin of at least roughly 2 KB. The full menu needs roughly 1 KB of additional app image
alone, and the mapper metadata can grow with new symbols.

**Options**

1. **Poco submenus (recommended for now)**
   - Implement Units and Vibration submenus in the existing Poco menu.
   - No startup budget change; keeps theme/font control.
   - Does not use the native ActionMenu.

2. **Minimal native ActionMenu**
   - One combined “Settings” submenu instead of two separate ones, or a reduced root set.
   - Verify with a spike before building the full interaction.
   - Still always black/white.

3. **Reclaim startup budget for the full native menu**
   - Trim archive symbols/exports/modules.
   - Re-evaluate pool sizes, one change at a time, with high-water measurements.
   - Keep the C shim as small as possible; avoid libc, avoid copying labels into `.rodata`,
     use static state and loops where they actually reduce code.
   - Only after a measured margin exists.

**Acceptance**

- No `fxMapArchive` failure on both targets.
- The full menu fits with a documented margin.
- Emulator screenshots confirm selection, submenu navigation, and Back behavior.

**Rollback**

- Keep the custom Poco menu as the default until the native version passes the budget and
  emulator tests.

---

### H3. Investigate the possible `Location.close()` leak

**Files:** `src/embeddedjs/main.js:579-589`.

**Observation**

`stopGps()` catches a `Location.close()` failure, logs it, and then sets `location = null`
regardless. If the runtime’s close path writes to AppMessage and that write throws before the
internal Message is closed/unrooted, repeated pause/resume or end/resume-day cycles while
disconnected could accumulate native `Location`/`Message` objects.

**Reproduction plan**

1. Add debug-only heap instrumentation around `startGps`/`stopGps` (do not ship release
   logging).
2. On the emulator, disconnect the phone, then repeat pause/resume or end/resume-day 20–50
   times.
3. Record `heap_bytes_free()` and, if possible, the runtime object counts after each cycle.
4. Check whether the trend is flat or monotonic.

**Possible fixes**

- If confirmed, retain the `Location` object until close succeeds, or add a close retry/backoff.
- Add a guard so `startGps()` does not create a second `Location` while the previous one is
  still closing.
- If the leak is in the runtime, document it as an SDK issue and avoid the pattern.

**Risk**

High until reproduced. Do not change lifecycle behavior speculatively; a wrong fix can leave
the app unable to restart GPS.

---

### H4. Pool rebalancing (only after measurement)

**Files:** `src/c/mdbl.c`.

The history already shows how tight this is: adding coordinates required moving 1 KiB from the
stack and 2 KiB from chunks into slots. Do not rebalance pools as part of a feature patch.

**Process**

1. Measure high-water marks with the debug instrumentation for:
   - startup/mapping,
   - a populated day,
   - active sampling,
   - sync/ack with a full outbox,
   - history/season browsing,
   - settings changes.
2. Change one pool at a time.
3. Rebuild both targets and re-run the budget script.
4. Record the before/after and the failure mode observed, if any.

**Acceptance**

- No `fxAbort memory full`, no JS stack overflow, no archive mapping failure.
- High-water marks stay below the pool limits with margin.

---

## 8. Test and verification strategy

### 8.1 Per-item test map

| Item | Unit tests | Persistence/restart | Emulator | Budget script |
| --- | --- | --- | --- | --- |
| L1 savedToday | active accessor, isolation | resume | yes | optional |
| L2 outbox head | head/empty/isolation | pending sync | yes | optional |
| L3 settings clones | settings round-trip | settings apply | yes | optional |
| L4 query queue | capacity/dedupe/clear | suspend/resume | yes | optional |
| L5 dead code | existing suite | — | build | yes |
| M1 active persistence | write keys, clear paths | resume, crash windows | yes | yes |
| M2 AppMessage | payload bounds | sync/ack | yes | yes |
| H1 outbox refs | record shapes | pending sync/undo | yes | yes |
| H2 ActionMenu | — | — | yes | yes (gate) |
| H3 Location leak | — | — | repeat cycles | yes |
| H4 pools | — | — | high-water | yes |

### 8.2 Commands

```bash
node --test test/*.test.mjs
pebble build
node tools/memory-budget.mjs --check
pebble install --emulator emery build/slide-stats.pbw
pebble screenshot --emulator emery --no-open /tmp/slide.png
```

Also build `gabbro` and, for menu/layout work, capture screenshots on both targets.

### 8.3 Definition of done for any phase

- The budget script reports no negative margin and no unexplained regression.
- All Node tests pass.
- Both watch targets build.
- Emulator smoke test covers the changed path.
- The commit message includes before/after memory numbers.
- Docs are updated if behavior or the budget model changed.

---

## 9. Recommended implementation order

### Phase 0 — Guardrails (no behavior change)

1. Add `tools/memory-budget.mjs`.
2. Add the memory/size tests and the recording storage helper.
3. Document the baseline and the `APP_HEAP_BASE` calibration.
4. Confirm the original app’s numbers and the ActionMenu failure numbers in the script output.

### Phase 1 — Low-risk runtime wins

1. L1 savedToday/narrow active accessor.
2. L2 outbox head.
3. L3 settings clone reduction.
4. L4 query queue policy.
5. L5 dead code.

Keep these as separate commits or one small commit per item if the diff stays clear.

### Phase 2 — Medium-risk

1. M1 active-lift persistence, with migration and crash-window tests.
2. M2 AppMessage buffer reduction after payload-bound tests.

Re-measure after M1 before starting M2; M1 changes the runtime peak significantly.

### Phase 3 — High-risk, only if still needed

1. H1 outbox/today de-duplication, if the outbox is still a large fraction.
2. H2 native ActionMenu decision. Do not start until the startup margin is at least ~2 KB.
3. H3 Location leak reproduction and fix.
4. H4 pool rebalancing, one variable at a time.

### Phase 4 — Documentation

- Update `docs/design.md` with the memory model and a link to this plan.
- Record the final baseline and any deliberate budget changes.
- Update the README only if user-visible behavior changes.

---

## 10. Open questions / decisions

1. **Query queue capacity and overflow policy:** six entries like the cache, or eight? Drop
   oldest or newest?
2. **AppMessage buffers:** 512/512 or 768/768? Decide from measured payloads, not estimates.
3. **Active-key consistency:** which crash window is acceptable, and what guard prevents a
   completed lift from being restored as active?
4. **`getToday().active`:** keep it for compatibility/tests, or remove it and use
   `getActiveLift()` everywhere?
5. **Outbox representation:** keep full records (Option C), reference current-day lifts and
   materialize at rollover (Option A), or use acked flags plus rollover materialization
   (Option B)?
6. **Native ActionMenu:** Poco submenus, minimal native menu, or invest in startup-budget
   reclamation?
7. **CI:** is a full Pebble SDK build job acceptable, or should the budget script remain a
   local/pre-release check?

---

## 11. Appendix — baseline worksheet

Fill this in with the Phase 0 script and keep it updated.

| Metric | Baseline (`60c9238`) | Notes |
| --- | ---: | --- |
| App image `pebble-app.bin` | 620 | emery |
| App image + BSS footprint | 628 | `arm-none-eabi-size` |
| Archive `mc.xsa` | 35,643 | original XSA |
| XS stack | 5,120 | `mdbl.c` |
| XS slot | 48,640 | `mdbl.c` |
| XS chunk | 26,624 | `mdbl.c` |
| Mapper scratch | 1,280 | 1024 + 256 |
| Mapper identifiers | ~988 | review measurement |
| Mapper maps | 3,610 | review measurement |
| Estimated free heap before machine | ~122,224 | calibration; verify |
| Estimated startup peak | ~121,905 | pools + archive + mapper |
| Estimated startup margin | ~319 | effectively zero |
| ActionMenu full-shim app footprint | ~1,500 | experiment |
| ActionMenu full-shim result | `fxMapArchive` | before JS |

The last two rows are the evidence that the app-image size is part of the startup budget, not
just pool/archive size.

---

## 12. Implementation log

Status: Phase 0, L1–L5, the option-2 throttled active save, and the slot-pool experiment are
implemented and committed to `main`. Source changes:

- `src/c/mdbl.c`
- `src/embeddedjs/lib/core.js`
- `src/embeddedjs/main.js`
- `test/day-store.test.mjs`
- `test/memory.test.mjs` (new)
- `test/active-store.test.mjs` (new)
- `tools/memory-budget.mjs` (new)
- `package.json`
- `docs/design.md`
- `docs/memory-plan.md` (this document)

### 12.1 What changed

| Item | Implementation |
| --- | --- |
| L1 | Added `getActiveLift()`; startup now restores only the active snapshot, not a retained full-day clone. |
| L2 | Added `peekOutbox()`; `flushOutbox()` no longer clones the whole queue. |
| L3 | `setSettings()`/`setPaused()` return the updated settings; `updateAll(next)` and `sendSettings(next)` accept that value, removing the duplicate clones. |
| L4 | Queue is capped at six, cleared on screen change/suspend, and re-established via `ensureScreenSummary()` on focus/writable. The policy is inlined in `main.js`; a helper was dropped to save 32 B of archive. |
| L5 | Removed `lastAltitude`, `NORTH`/`SOUTH`, and `getNextSeq`. |

### 12.2 Measurements

Archive (`build/mods/emery/mc.xsa`):

| Atom | Baseline `60c9238` | After low-risk | Delta |
| --- | ---: | ---: | ---: |
| XSA total | 35,643 | 35,828 | +185 |
| `SYMB` | 4,239 | 4,280 | +41 |
| `IDEN` | 996 | 998 | +2 |
| `MAPS` | 3,618 | 3,618 | 0 |
| `MODS` | 26,709 | 26,851 | +142 |

The queue helper was later inlined to save 32 B, making the final low-risk archive roughly
35,796 B. The table above is the measurement taken before that inline change.

App image/BSS is unchanged at 628 bytes. The archive growth costs roughly 185 bytes plus a
small identifier-table increase at startup. **Startup headroom got slightly worse, not better.**
The app still launches in the emulator.

Runtime clone sizes from `test/memory.test.mjs` with a 30-lift day:

| Access | Bytes |
| --- | ---: |
| `getToday()` full clone | 4,815 |
| `getActiveLift()` snapshot | 20 |
| `getOutbox()` full clone | 8,271 |
| `peekOutbox()` head | 265 |
| `getSettings()` clone | 229 |

The low-risk phase therefore creates meaningful **runtime** headroom:

- L1 avoids retaining roughly 4.8 KB of cloned day state for the lifetime of a populated day.
- L2 avoids an ~8.3 KB outbox clone per send, replacing it with a ~265 B record.
- L3 removes one ~229 B settings clone per action/update.
- L4 prevents an unbounded request queue and clears stale work on suspend/screen change.

It does **not** create startup headroom for the native ActionMenu. The archive grew by 185
bytes, and the mapper metadata grows with it. A full native ActionMenu still needs a separate
startup-budget effort (or the Poco submenu path).

### 12.3 Follow-ups unlocked or still open

- Run the full emulator smoke test after the next change: main, More, Units/Vibration toggles,
  Today/Season, suspend/resume.
- Phase 0 is now implemented; use `npm run check-memory` before every memory-sensitive change.
- The remaining startup budget is the main constraint. The slot experiment leaves about
  +1,057 B of modeled hardware margin, still below the 2 KiB gate.

### 12.4 M1 experiment — reverted

The first M1 implementation moved the active snapshot to its own `ss.active` key
(`{ d, a }`) and removed `active` from `ss.state`. It worked in the emulator and reduced the
per-sample write from about 13.3 KB to 83 B, but it grew the archive from 35,828 to 36,821 B.
Phase 0 measured the hardware margin at **-999 B**, so it was reverted.

That experiment confirmed the key lesson: the runtime win was real, but the archive cost was
not affordable at the current startup budget.

### 12.5 Option 2 — throttled active save (current)

Status: implemented and committed to `main`.

The active snapshot stays in the normal `ss.state` blob. The change is a time-based
checkpoint:

- `ACTIVE_SAVE_INTERVAL_MS = 30000`.
- `setActiveLift(lift)` updates the in-memory snapshot immediately.
- A non-null snapshot is written to `ss.state` only when at least 30 seconds have passed since
  the last active checkpoint.
- Clearing the active lift writes immediately.
- `exitApp()` calls `store.save()` so the latest snapshot is persisted before the app exits.
- The full state write still occurs at a checkpoint; the peak size is unchanged. The change
  reduces how often that peak occurs, rather than shrinking the peak.

With a 30-lift day, `test/memory.test.mjs` now reports:

| Event | Bytes / behavior |
| --- | ---: |
| State write after a completed lift | 13,350 B |
| First active checkpoint | 13,366 B |
| Sample at t+10s | suppressed |
| Sample at t+30s | full-state checkpoint |

This is a deliberately cheaper compromise than the separate key. It saves archive space and
startup margin, but a crash can lose up to 30 seconds of active-lift progress.

### 12.6 Phase 0 — build-time budget check

Status: implemented. `tools/memory-budget.mjs` parses:

- `.stack` / `.slot` / `.chunk` from `src/c/mdbl.c`;
- the app `virtual_size` from `build/<platform>/pebble-app.bin`;
- the XSA atom sizes from `build/mods/<platform>/mc.xsa`;
- the symbol count from `SYMB` and the maps allocation from `MAPS`.

Calibration:

```text
measured heap_bytes_free() before moddable_createMachine   122,144
logging-build virtual_size                                      712
APP_HEAP_BASE                                               122,856
clean app free heap (122,856 - 628)                          122,228
```

Run:

```bash
pebble build
npm run check-memory
```

The gate now fails below **2,048 B** and warns below a **4,096 B** target. This is the
requirement for native ActionMenu work, not a threshold adjusted to make the old +33 B pass.

### 12.7 Slot-pool reclamation experiment

Status: implemented and committed to `main`.

Only `.slot` changed. Stack and chunk were left untouched.

| `.slot` | Modeled hardware margin | Emulator result |
| ---: | ---: | --- |
| 48,640 | +33 B | boots |
| 47,616 | +1,057 B | boots (**current**) |
| 47,104 | +1,569 B | boots |
| 46,848 | +1,825 B | `Alloy: Fatal Error memory full` |
| 46,592 | +2,081 B | `Alloy: Fatal Error memory full` |

The modeled startup margin is not the only constraint. The slot pool also has to hold the
loaded modules and live JS objects, so a negative runtime slot high-water can fail before the
archive-mapping model runs out. The observed startup floor is between 46,848 and 47,104.
47,616 was chosen as the tested value with roughly 768 B of buffer above that floor; 47,104
works but is only about 256 B above the failure point.

The debug build intended for slot instrumentation could not be used: `pebble build --debug`
produces a much larger archive and the 47,616 B slot build fails with `memory full` before it
can log high-water marks. A meaningful slot high-water measurement needs an
instrumentation-only build or hardware profiling.

Current result at `.slot = 47,616`:

| Metric | Value |
| --- | ---: |
| Free heap | 122,228 B |
| XS pools | 78,336 B |
| Archive | 35,935 B |
| Mapper scratch + IDs + maps | 5,876 B |
| **Hardware startup margin** | **+1,057 B** |
| Emulator margin | +36,992 B |

`npm run check-memory` now exits **1** because +1,057 B is below the 2,048 B requirement. The
app still boots and the main/menu/Today screens work in the emulator.

**Conclusion:** slot reclamation recovers about 1 KiB of modeled startup margin, but cannot
reach the 2 KiB target. A 2 KiB slot value (46,592) fails at startup. The runtime savings from
L1–L3 do not reduce the startup slot high-water enough to free that much. Reaching 2 KiB
requires reclaiming archive/module space, a deeper pool redesign, or accepting a 1 KiB target
with the current slot.

Tests: **81/81 pass**. Both targets build. Emulator smoke-tested: main, More, Units toggle,
Today, Back.

### 12.8 40-run stress test

A temporary 40-run harness was set up and removed after testing. It seeded 40
lifts with coordinates, 40 unacknowledged outbox records, and an active lift. No mock
code remains in the working tree.

Result: **the worst-case 40-run state does not fit at the current 47,616 B slot.**

- A prebuilt 40-run state injected directly into the watch storage failed during
  `createDayStore().load()` with `Alloy: Fatal Error memory full` at `.slot = 47,616`.
- The phone-to-watch mock handler could not be made to fit at the same startup budget.
  At `.slot = 48,640` the handler pushed machine creation over the edge; reducing the
  stack to 4,096 produced `JavaScript stack overflow`; reducing chunks still failed.
- The emulator's AppMessage channel also produced `output_begin failed` during repeated
  installs, so the live phone-driven playback was not a clean signal. The direct state-load
  result is the reliable part.

Caveat: this was a worst case: 40 runs **plus 40 unacknowledged outbox records** plus an
active lift. A connected phone that acks each lift keeps the outbox small. The test does not
prove that a normal 40-run day with a small outbox fails, but it does show that the current
watch state cannot hold the fully offline 40-run case.

If 40 offline runs are a requirement, the next lever is the duplicate current-day/outbox
representation (H1), not more slot trimming. The app was restored to the pre-mock production
state after the test.

### 12.9 Run-count threshold (minimal harness)

A smaller harness was used to find the approximate run-count ceiling at `.slot = 47,616`.
It injected a minimal persisted state and logged whether `createDayStore().load()` completed.
The harness code itself consumes some startup/slot headroom, so these are approximations, not
exact production limits.

| Case | Loads | Crashes with `memory full` |
| --- | ---: | ---: |
| Each run also has an unacknowledged outbox record | 10 runs | **11 runs** |
| Outbox drained; only today's compact lifts | 20 runs | **21 runs** |
| 40 runs with an unacked outbox | — | crashes |
| 40 runs with a drained outbox | — | crashes |

The outbox duplication roughly halves the usable run count. The real outbox records are larger
than the minimal harness records, so the real offline threshold is likely lower than 11. The
real `today.lifts` records are also larger than the minimal harness records, so the no-outbox
threshold is likely somewhat lower than 20.

The working tree was restored to the production build and the emulator flash was cleared after
the test. No harness code remains.

This makes H1 (removing the duplicate current-day/outbox representation) the highest-value
runtime fix if the app needs to survive a fully offline day. A connected phone that drains the
outbox is the normal case and keeps the state much smaller.

### 12.10 Phone-authoritative redesign

The phone-authoritative work moved lift detection, today's lifts, the outbox, and the day
store off the watch. The watch now caches the phone's `State` and sends commands. See
`docs/phone-authoritative.md` for the protocol.

Measured after the redesign and the native ActionMenu (slot restored to 48,640):

| Metric | Before (slot 47,616) | Phone redesign | + native menu |
| --- | ---: | ---: | ---: |
| App virtual size | 628 B | 628 B | **2,096 B** |
| Archive | 35,935 B | 25,621 B | **28,654 B** |
| XS pools | 78,336 B | 80,384 B | 80,384 B |
| Mapper scratch + IDs + maps | 5,876 B | 4,346 B | 4,742 B |
| **Hardware startup margin** | **+1,057 B** | **+11,877 B** | **+6,980 B** |

`npm run check-memory` exits **0** and is above the 4 KiB target. The native ActionMenu
and the icon redraw cost about 4.8 KiB net: the app image grew by about 1.5 KiB, the
archive grew by about 3.0 KiB, and the mapper tables grew with the new symbols.

The watch no longer stores lift records, so the 40-run and outbox stress limits in 12.8 and
12.9 no longer describe the product: a 40-run day lives on the phone and the pushed watch
state stays around **516 B**. The remaining runtime risk is the phone's geolocation lifecycle
and AppMessage delivery, not watch storage.

Recovered margin at `.slot = 48,640`: about **6.8 KiB** after the native ActionMenu and
icon redraw. The ActionMenu experiment in H2 needed roughly 1–2 KiB of extra app image, which
now fits with a large margin.

The ActionMenu is a fixed FFI shim: six root rows, Units and Vibration submenus, and the
theme accent in the crumb column. It opens on Select release so the launching click is not
delivered to the menu. The C callback writes the selected action to a static result and JS
polls it. The app window is the ActionMenu result window so Back cancel returns to the app.
After a Back cancel on Gabbro the display destination bitmap needed a firmware repaint;
`mdbl.c` installs an empty root-layer update proc and the JS marks the layer dirty and redraws
after close.

Tests: **93/93 pass**. Both targets build. Emulator checks covered launch, state push, Today,
Season, history Query/Data, units, vibration, native menu navigation and submenus, Back
cancel, and both watch shapes.
