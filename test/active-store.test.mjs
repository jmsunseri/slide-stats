import test from "node:test";
import assert from "node:assert/strict";
import {
	createDayStore,
	STATE_KEY,
} from "../src/embeddedjs/lib/core.js";

function recordingStorage() {
	const map = new Map();
	const writes = [];
	return {
		map,
		writes,
		getItem: key => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => {
			writes.push({ key, value });
			map.set(key, value);
		},
		removeItem: key => map.delete(key),
	};
}

function clockAt(date) {
	let value = date.getTime();
	return {
		now: () => value,
		advance: ms => { value += ms; },
	};
}

const ACTIVE = [0, 2000, 300000, 2600];
const ACTIVE_2 = [0, 2000, 360000, 2800];
const ACTIVE_3 = [0, 2000, 420000, 3000];

test("active saves are throttled to the configured interval", () => {
	const storage = recordingStorage();
	const clock = clockAt(new Date(2026, 2, 14, 9, 0));
	const store = createDayStore({ storage, now: clock.now }).load();
	storage.writes.length = 0;

	store.setActiveLift(ACTIVE);
	assert.equal(storage.writes.length, 1);

	clock.advance(10000);
	store.setActiveLift(ACTIVE_2);
	assert.equal(storage.writes.length, 1, "a sample inside the interval should not rewrite state");

	clock.advance(20000);
	store.setActiveLift(ACTIVE_3);
	assert.equal(storage.writes.length, 2, "the next sample after the interval should persist");

	assert.deepEqual(JSON.parse(storage.map.get(STATE_KEY)).today.active, ACTIVE_3);
});

test("an explicit save flushes the latest throttled active snapshot", () => {
	const storage = recordingStorage();
	const clock = clockAt(new Date(2026, 2, 14, 9, 0));
	const store = createDayStore({ storage, now: clock.now }).load();

	store.setActiveLift(ACTIVE);
	clock.advance(10000);
	store.setActiveLift(ACTIVE_2);
	store.save();

	assert.deepEqual(JSON.parse(storage.map.get(STATE_KEY)).today.active, ACTIVE_2);
});

test("active lift survives reload from the state blob", () => {
	const storage = recordingStorage();
	const clock = clockAt(new Date(2026, 2, 14, 9, 0));
	const store = createDayStore({ storage, now: clock.now }).load();
	store.setActiveLift(ACTIVE);

	const reloaded = createDayStore({ storage, now: clock.now }).load();
	assert.deepEqual(reloaded.getActiveLift(), ACTIVE);
});

test("clearing the active lift writes state immediately", () => {
	const storage = recordingStorage();
	const clock = clockAt(new Date(2026, 2, 14, 9, 0));
	const store = createDayStore({ storage, now: clock.now }).load();
	store.setActiveLift(ACTIVE);

	storage.writes.length = 0;
	store.setActiveLift(null);
	assert.equal(storage.writes.length, 1);
	assert.equal(JSON.parse(storage.map.get(STATE_KEY)).today.active, null);
});

test("pause, end day, purge, and a new day clear the active lift", () => {
	const storage = recordingStorage();
	const clock = clockAt(new Date(2026, 2, 14, 9, 0));
	const store = createDayStore({ storage, now: clock.now }).load();

	store.setActiveLift(ACTIVE);
	store.setPaused(true);
	assert.equal(store.getActiveLift(), null);

	store.setPaused(false);
	store.setActiveLift(ACTIVE);
	store.endDay();
	assert.equal(store.getActiveLift(), null);

	store.resumeDay();
	store.setActiveLift(ACTIVE);
	store.purgeDay(store.todayDate());
	assert.equal(store.getActiveLift(), null);

	store.setActiveLift(ACTIVE);
	clock.advance(24 * 60 * 60 * 1000);
	const nextDay = createDayStore({ storage, now: clock.now }).load();
	assert.equal(nextDay.getActiveLift(), null);
});

test("a new active lift saves immediately after the previous one was cleared", () => {
	const storage = recordingStorage();
	const clock = clockAt(new Date(2026, 2, 14, 9, 0));
	const store = createDayStore({ storage, now: clock.now }).load();

	store.setActiveLift(ACTIVE);
	clock.advance(10000);
	store.setActiveLift(null);
	storage.writes.length = 0;

	store.setActiveLift(ACTIVE_2);
	assert.equal(storage.writes.length, 1);
});
