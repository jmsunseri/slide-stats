import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPhoneStore } = require("../src/pkjs/lib/phone-store.js");
const { createPhoneDetector } = require("../src/pkjs/lib/phone-detector.js");
const { DEFAULT_SETTINGS } = require("../src/pkjs/lib/settings.js");

function memoryStorage() {
	const map = new Map();
	return {
		map,
		getItem: key => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, value),
	};
}

function lift(startTime, gain = 400) {
	return {
		startTime,
		endTime: startTime + 300000,
		startAltitude: 2000,
		peakAltitude: 2000 + gain,
		gain,
		durationMs: 300000,
		startLat: 47.1,
		startLon: -121.2,
		peakLat: 47.2,
		peakLon: -121.1,
	};
}

test("phone store persists lifts and builds the compact watch state", () => {
	const storage = memoryStorage();
	const now = new Date(2026, 2, 14, 9, 0).getTime();
	const store = createPhoneStore({ storage, key: "test-lifts", now: () => now });
	const first = store.addLift(lift(now));
	store.addLift(lift(now + 600000, 300));

	assert.equal(first.seq, 1);
	assert.deepEqual(first.pts, [47100000, -121200000, 47200000, -121100000]);

	const state = store.state(DEFAULT_SETTINGS, new Date(now + 3600000));
	assert.equal(state.today.runs, 2);
	assert.equal(state.today.vertical, 700);
	assert.equal(state.season.runs, 2);
	assert.equal(state.season.vertical, 700);
	assert.equal(state.season.days, 1);

	const reloaded = createPhoneStore({ storage, key: "test-lifts", now: () => now });
	assert.equal(reloaded.getLifts()["2026-03-14"].length, 2);
});

test("phone store files a midnight-crossing lift under the day it ends", () => {
	const storage = memoryStorage();
	const now = new Date(2026, 2, 15, 0, 3).getTime();
	const store = createPhoneStore({ storage, key: "test-lifts", now: () => now });
	store.addLift(lift(new Date(2026, 2, 14, 23, 58).getTime()));
	assert.equal(store.getLifts()["2026-03-14"], undefined);
	assert.equal(store.getLifts()["2026-03-15"].length, 1);
});

test("phone store preserves a corrupt lift blob before starting over", () => {
	const storage = memoryStorage();
	storage.setItem("test-lifts", "{truncated");
	const store = createPhoneStore({ storage, key: "test-lifts" });
	assert.deepEqual(store.getLifts(), {});
	assert.equal(storage.getItem("test-lifts.corrupt"), "{truncated");
});

test("phone store undo removes the last lift for the day", () => {
	const storage = memoryStorage();
	const now = new Date(2026, 2, 14, 9, 0).getTime();
	const store = createPhoneStore({ storage, key: "test-lifts", now: () => now });
	store.addLift(lift(now));
	store.addLift(lift(now + 600000));

	const removed = store.undoLastLift("2026-03-14");
	assert.equal(removed.seq, 2);
	assert.equal(store.getLifts()["2026-03-14"].length, 1);
	assert.equal(store.state(DEFAULT_SETTINGS, new Date(now)).today.runs, 1);
});

test("phone detector records an end event and returns the updated state", () => {
	const storage = memoryStorage();
	const now = new Date(2026, 2, 14, 9, 0).getTime();
	const store = createPhoneStore({ storage, key: "test-lifts", now: () => now });
	const events = [];
	const detector = createPhoneDetector({
		store,
		getSettings: () => DEFAULT_SETTINGS,
		onEvent: event => events.push(event),
	});

	for (let second = 0; second <= 30; second++)
		detector.addSample({
			t: now + second * 1000,
			altitude: 2000 + second,
			altitudeAccuracy: 5,
			latitude: 47.1,
			longitude: -121.2,
		});
	for (let second = 0; second <= 6; second++)
		detector.addSample({
			t: now + (31 + second) * 1000,
			altitude: 2030 - second * 2,
			altitudeAccuracy: 5,
			latitude: 47.1,
			longitude: -121.2,
		});

	assert.deepEqual(events.map(event => event.type), ["start", "end"]);
	assert.ok(events[1].record);
	assert.equal(events[1].state.today.runs, 1);
	assert.equal(events[1].state.today.vertical, 30);
	assert.equal(store.getLifts()["2026-03-14"].length, 1);
});
