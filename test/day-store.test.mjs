import test from "node:test";
import assert from "node:assert/strict";
import { createDayStore, STATE_KEY, DEFAULT_SETTINGS, dayKey, createLiftDetector } from "../src/embeddedjs/lib/core.js";

function memoryStorage() {
	const map = new Map();
	return {
		map,
		getItem: key => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, value),
		removeItem: key => map.delete(key),
	};
}

function fakeClock(start) {
	let value = start;
	return {
		now: () => value,
		set: next => { value = next; },
		advance: ms => { value += ms; },
	};
}

function lift(gain, startTime, endTime) {
	return {
		startTime,
		endTime,
		startAltitude: 2000,
		peakAltitude: 2000 + gain,
		gain,
		durationMs: endTime - startTime,
		incomplete: false,
	};
}

test("a fresh store starts a day and auto-tracks", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();
	const today = store.getToday();
	assert.equal(today.date, "2026-03-14");
	assert.equal(store.isTracking(), true);
	assert.equal(store.todayStats().runs, 0);
});

test("adding lifts updates today, days, and the outbox without a base", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const storage = memoryStorage();
	const store = createDayStore({ storage, now: clock.now }).load();

	store.addLift(lift(400.2, 1000, 5000));
	store.addLift(lift(350.8, 6000, 9000));

	const stats = store.todayStats();
	assert.equal(stats.runs, 2);
	assert.equal(stats.vertical, 751);
	assert.equal(stats.first, 1000);
	assert.equal(stats.last, 9000);
	assert.equal(stats.longest, 400);
	assert.equal(stats.average, 376);

	const outbox = store.getOutbox();
	assert.equal(outbox.length, 2);
	assert.equal(outbox[0].id, outbox[0].uid);
	assert.equal(outbox[1].id, outbox[1].uid);
	assert.ok(outbox[0].uid.indexOf("2026-03-14:1:") === 0);
	assert.equal(outbox[0].kind, "lift");
	assert.equal(outbox[0].gain, 400);
});

test("lift coordinates go to the outbox but not the local day", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();

	store.addLift(Object.assign(lift(400, 1000, 5000), {
		startLat: 47.1,
		startLon: -121.2,
		peakLat: 47.2,
		peakLon: -121.1,
	}));

	const local = store.getToday().lifts[0];
	assert.equal(local.startLat, undefined);
	assert.equal(local.pts, undefined);
	assert.deepEqual(store.getOutbox()[0].pts, [47100000, -121200000, 47200000, -121100000]);
});

test("state round-trips through storage", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const storage = memoryStorage();
	const first = createDayStore({ storage, now: clock.now }).load();
	first.addLift(lift(500, 1000, 5000));
	first.setSettings({ units: "imperial" });

	const second = createDayStore({ storage, now: clock.now }).load();
	assert.equal(second.getToday().date, "2026-03-14");
	assert.equal(second.todayStats().vertical, 500);
	assert.equal(second.getSettings().units, "imperial");
	assert.equal(second.getOutbox().length, 1);
	assert.ok(storage.getItem(STATE_KEY));
});

test("undo removes the lift and queues a delete record", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();
	store.addLift(lift(400, 1000, 5000));
	store.addLift(lift(300, 6000, 9000));

	const removed = store.undoLastLift();
	assert.equal(removed.seq, 2);
	assert.equal(store.todayStats().runs, 1);
	assert.equal(store.todayStats().vertical, 400);
	assert.equal(store.getOutbox().at(-1).kind, "lift-delete");
	assert.equal(store.getOutbox().at(-1).seq, 2);
	assert.ok(store.getOutbox().at(-1).uid);

	store.undoLastLift();
	assert.equal(store.todayStats().runs, 0);
});

test("midnight rollover starts a fresh day and keeps tracking", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 23, 50).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();
	store.addLift(lift(300, 1000, 5000));

	clock.set(new Date(2026, 2, 15, 0, 10).getTime());
	const result = store.ensureToday();
	assert.equal(result.changed, true);
	assert.equal(result.previousDate, "2026-03-14");
	assert.equal(store.getToday().date, "2026-03-15");
	assert.equal(store.isTracking(), true);
	assert.equal(store.todayStats().runs, 0);
});

test("launching on a new day starts a fresh day", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 23, 50).getTime());
	const storage = memoryStorage();
	const store = createDayStore({ storage, now: clock.now }).load();
	store.addLift(lift(300, 1000, 5000));

	clock.set(new Date(2026, 2, 15, 8, 0).getTime());
	const reopened = createDayStore({ storage, now: clock.now }).load();
	assert.equal(reopened.getToday().date, "2026-03-15");
	assert.equal(reopened.isTracking(), true);
	assert.equal(reopened.todayStats().runs, 0);
});

test("acks drain the outbox", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();
	store.addLift(lift(400, 1000, 5000));
	store.addLift(lift(300, 6000, 9000));

	const firstId = store.getOutbox()[0].id;
	store.ack(firstId);
	assert.equal(store.getOutbox().length, 1);
	assert.equal(store.getOutbox()[0].seq, 2);
	store.ack("missing");
	assert.equal(store.getOutbox().length, 1);
});

test("settings merge deeply and preserve unrelated detection values", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();
	store.setSettings({ units: "imperial", detection: { minLiftGainM: 25 } });
	const settings = store.getSettings();
	assert.equal(settings.units, "imperial");
	assert.equal(settings.detection.minLiftGainM, 25);
	assert.equal(settings.detection.fastGainM, DEFAULT_SETTINGS.detection.fastGainM);
	assert.equal(settings.seasonMode, "north");
});

test("end day stops tracking and resume restores it", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();
	assert.equal(store.isTracking(), true);
	store.endDay();
	assert.equal(store.isTracking(), false);
	assert.equal(store.getToday().closed, true);
	store.resumeDay();
	assert.equal(store.isTracking(), true);
});

test("pause stops tracking independently of the day state", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();
	store.setPaused(true);
	assert.equal(store.isTracking(), false);
	store.setPaused(false);
	assert.equal(store.isTracking(), true);
});

test("a climb alone does not increment runs; an end event does", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();
	const detector = createLiftDetector();

	const sample = (t, altitude) => ({ t, altitude, altitudeAccuracy: 5, speed: 4 });
	const events = [];
	for (let i = 0; i <= 6; i++)
		events.push(...detector.addSample(sample(i * 10000, 2000 + i * 20)));

	assert.ok(events.some(event => event.type === "start"), "climb should start a lift");
	for (const event of events) {
		if (event.type === "end")
			store.addLift(event.lift);
	}
	assert.equal(store.todayStats().runs, 0, "start alone must not count a run");
	assert.equal(store.todayStats().vertical, 0);

	for (let i = 7; i <= 10; i++)
		events.push(...detector.addSample(sample(i * 10000, 2120 - (i - 6) * 10)));
	for (const event of events) {
		if (event.type === "end")
			store.addLift(event.lift);
	}
	assert.equal(store.todayStats().runs, 1);
	assert.ok(store.todayStats().vertical > 0);
});

test("purging today clears lifts, active state, closed state, and outbox", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();
	store.addLift(lift(400, 1000, 5000));
	store.setActiveLift([0, 2000, 300000, 2600]);

	assert.equal(store.purgeDay("1999-01-01"), false);
	assert.equal(store.purgeDay(store.todayDate()), true);
	assert.equal(store.getToday().lifts.length, 0);
	assert.equal(store.getToday().active, null);
	assert.equal(store.getOutbox().length, 0);

	store.endDay();
	assert.equal(store.isClosed(), true);
	assert.equal(store.purgeDay(store.todayDate()), true);
	assert.equal(store.isClosed(), false);
});
