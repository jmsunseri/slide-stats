import test from "node:test";
import assert from "node:assert/strict";
import { createDayStore, STATE_KEY, DEFAULT_SETTINGS } from "../src/embeddedjs/lib/day-store.js";
import { dayKey } from "../src/embeddedjs/lib/season.js";

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

test("a fresh store starts a day with no base", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();
	const today = store.getToday();
	assert.equal(today.date, "2026-03-14");
	assert.equal(today.base, null);
	assert.equal(store.hasBase(), false);
	assert.equal(store.isTracking(), false);
});

test("setting a base and adding lifts updates today, days, and the outbox", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const storage = memoryStorage();
	const store = createDayStore({ storage, now: clock.now }).load();

	store.setBase(2143.7);
	assert.equal(store.hasBase(), true);
	assert.equal(store.isTracking(), true);
	assert.equal(store.getToday().base, 2144);

	store.addLift(lift(400.2, 1000, 5000));
	store.addLift(lift(350.8, 6000, 9000));

	const stats = store.todayStats();
	assert.equal(stats.runs, 2);
	assert.equal(stats.vertical, 751);
	assert.equal(stats.first, 1000);
	assert.equal(stats.last, 9000);
	assert.equal(stats.longest, 400);
	assert.equal(stats.average, 376);

	const day = store.getDays()["2026-03-14"];
	assert.equal(day.v, 751);
	assert.equal(day.r, 2);
	assert.equal(day.first, 1000);
	assert.equal(day.last, 9000);
	assert.equal(day.base, 2144);

	const outbox = store.getOutbox();
	assert.equal(outbox.length, 2);
	assert.equal(outbox[0].id, "2026-03-14:1");
	assert.equal(outbox[1].id, "2026-03-14:2");
	assert.equal(outbox[0].kind, "lift");
	assert.equal(outbox[0].gain, 400);
});

test("state round-trips through storage", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const storage = memoryStorage();
	const first = createDayStore({ storage, now: clock.now }).load();
	first.setBase(2100);
	first.addLift(lift(500, 1000, 5000));
	first.setSettings({ units: "imperial" });

	const second = createDayStore({ storage, now: clock.now }).load();
	assert.equal(second.getToday().base, 2100);
	assert.equal(second.todayStats().vertical, 500);
	assert.equal(second.getSettings().units, "imperial");
	assert.equal(second.getOutbox().length, 1);
	assert.ok(storage.getItem(STATE_KEY));
});

test("undo removes the lift and queues a delete record", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();
	store.setBase(2100);
	store.addLift(lift(400, 1000, 5000));
	store.addLift(lift(300, 6000, 9000));

	const removed = store.undoLastLift();
	assert.equal(removed.seq, 2);
	assert.equal(store.todayStats().runs, 1);
	assert.equal(store.todayStats().vertical, 400);
	assert.equal(store.getDays()["2026-03-14"].v, 400);
	assert.equal(store.getOutbox().at(-1).kind, "lift-delete");
	assert.equal(store.getOutbox().at(-1).seq, 2);

	store.undoLastLift();
	assert.equal(store.todayStats().runs, 0);
	assert.equal(store.getDays()["2026-03-14"], undefined);
});

test("midnight rollover can carry the base", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 23, 50).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();
	store.setBase(2000);
	store.addLift(lift(300, 1000, 5000));

	clock.set(new Date(2026, 2, 15, 0, 10).getTime());
	const result = store.ensureToday(true);
	assert.equal(result.changed, true);
	assert.equal(result.previousDate, "2026-03-14");
	assert.equal(store.getToday().date, "2026-03-15");
	assert.equal(store.getToday().base, 2000);
	assert.equal(store.todayStats().runs, 0);
	assert.equal(store.getDays()["2026-03-14"].v, 300);
});

test("launching on a new day does not carry the base", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 23, 50).getTime());
	const storage = memoryStorage();
	const store = createDayStore({ storage, now: clock.now }).load();
	store.setBase(2000);

	clock.set(new Date(2026, 2, 15, 8, 0).getTime());
	const reopened = createDayStore({ storage, now: clock.now }).load();
	assert.equal(reopened.getToday().date, "2026-03-15");
	assert.equal(reopened.getToday().base, null);
	assert.equal(reopened.hasBase(), false);
});

test("acks drain the outbox", () => {
	const clock = fakeClock(new Date(2026, 2, 14, 9, 0).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();
	store.setBase(2100);
	store.addLift(lift(400, 1000, 5000));
	store.addLift(lift(300, 6000, 9000));

	store.ack("2026-03-14:1");
	assert.equal(store.getOutbox().length, 1);
	assert.equal(store.getOutbox()[0].id, "2026-03-14:2");
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
	store.setBase(2100);
	assert.equal(store.isTracking(), true);
	store.endDay();
	assert.equal(store.isTracking(), false);
	assert.equal(store.getToday().closed, true);
	store.resumeDay();
	assert.equal(store.isTracking(), true);
});

test("season summary sees today's stored aggregate", () => {
	const clock = fakeClock(new Date(2026, 3, 1, 9, 0).getTime());
	const store = createDayStore({ storage: memoryStorage(), now: clock.now }).load();
	store.setBase(2100);
	store.addLift(lift(400, 1000, 5000));
	store.addLift(lift(350, 6000, 9000));

	const summary = store.seasonSummary();
	assert.equal(summary.label, "2025-26");
	assert.equal(summary.days, 1);
	assert.equal(summary.vertical, 750);
	assert.equal(summary.runs, 2);
	assert.equal(summary.bestDay.date, dayKey(new Date(2026, 3, 1)));
});
