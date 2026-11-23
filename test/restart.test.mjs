import test from "node:test";
import assert from "node:assert/strict";
import { createLiftDetector, createDayStore } from "../src/embeddedjs/lib/core.js";

const DT = 10000;
const NOW = new Date(2026, 10, 22, 12, 0).getTime();

function memoryStorage() {
	const map = new Map();
	return {
		getItem: key => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, value),
		removeItem: key => map.delete(key),
	};
}

function sample(t, altitude, extra = {}) {
	return Object.assign({ t, altitude, altitudeAccuracy: 5, speed: 0 }, extra);
}
function climb(startTime, startAltitude, rate, seconds, extra = {}) {
	const out = [];
	for (let s = 0; s <= seconds; s += DT / 1000)
		out.push(sample(startTime + s * 1000, startAltitude + rate * s, extra));
	return out;
}
function flat(startTime, altitude, seconds, extra = {}) {
	const out = [];
	for (let s = 0; s < seconds; s += DT / 1000)
		out.push(sample(startTime + s * 1000, altitude, extra));
	return out;
}
function descend(startTime, altitude, rate, seconds, extra = {}) {
	const out = [];
	for (let s = 0; s <= seconds; s += DT / 1000)
		out.push(sample(startTime + s * 1000, altitude - rate * s, extra));
	return out;
}
function feed(detector, samples) {
	const events = [];
	for (const item of samples)
		events.push(...detector.addSample(item));
	return events;
}
function save(store, events) {
	for (const event of events)
		if (event.type === "end") {
			store.addLift(event.lift);
			store.setActiveLift(null);
		}
}
function ends(events) {
	return events.filter(event => event.type === "end");
}
function starts(events) {
	return events.filter(event => event.type === "start");
}

test("relaunching at the top counts the descent with the original climb", () => {
	const storage = memoryStorage();
	const store = createDayStore({ storage, now: () => NOW }).load();
	const detector = createLiftDetector();

	const ascent = feed(detector, [
		...climb(0, 2000, 2, 300, { speed: 4 }),
		...flat(310000, 2600, 60, { speed: 0 }),
	]);
	assert.equal(starts(ascent).length, 1);
	assert.equal(ends(ascent).length, 0);
	assert.equal(store.todayStats().runs, 0);

	// The app closes with the lift still active. Only its state is persisted.
	store.setActiveLift(detector.snapshot());
	const relaunched = createDayStore({ storage, now: () => NOW }).load();
	const restored = relaunched.getToday().active;
	assert.deepEqual(restored, [0, 2000, 300000, 2600]);

	const detector2 = createLiftDetector();
	detector2.restore(restored);
	assert.ok(detector2.snapshot());
	const descent = feed(detector2, descend(400000, 2600, 2, 60, { speed: 8 }));
	save(relaunched, descent);

	assert.equal(ends(descent).length, 1);
	assert.equal(descent[0].lift.startTime, 0);
	assert.equal(descent[0].lift.peakAltitude, 2600);
	assert.equal(descent[0].lift.gain, 600);
	assert.equal(relaunched.todayStats().runs, 1);
	assert.equal(relaunched.todayStats().vertical, 600);
	assert.equal(relaunched.getToday().active, null);
});

test("relaunching mid-climb continues the same lift without a second start", () => {
	const storage = memoryStorage();
	const store = createDayStore({ storage, now: () => NOW }).load();
	const detector = createLiftDetector();

	const first = feed(detector, climb(0, 2000, 2, 50, { speed: 4 }));
	assert.equal(starts(first).length, 1);
	store.setActiveLift(detector.snapshot());

	const relaunched = createDayStore({ storage, now: () => NOW }).load();
	const detector2 = createLiftDetector();
	detector2.restore(relaunched.getToday().active);
	assert.ok(detector2.snapshot());

	const second = feed(detector2, climb(120000, 2100, 2, 50, { speed: 4 }));
	assert.equal(starts(second).length, 0);
	const descent = feed(detector2, descend(180000, 2200, 2, 20, { speed: 8 }));
	save(relaunched, descent);

	assert.equal(ends(descent).length, 1);
	assert.equal(descent[0].lift.startTime, 0);
	assert.equal(descent[0].lift.gain, 200);
	assert.equal(relaunched.todayStats().runs, 1);
	assert.equal(relaunched.todayStats().vertical, 200);
});

test("relaunching mid-climb preserves the lift coordinates", () => {
	const storage = memoryStorage();
	const store = createDayStore({ storage, now: () => NOW }).load();
	const detector = createLiftDetector();
	const extra = { speed: 4, latitude: 47.1, longitude: -121.2 };

	const first = feed(detector, climb(0, 2000, 2, 50, extra));
	assert.equal(starts(first).length, 1);
	store.setActiveLift(detector.snapshot());

	const relaunched = createDayStore({ storage, now: () => NOW }).load();
	const restored = relaunched.getToday().active;
	assert.equal(restored.length, 8);

	const detector2 = createLiftDetector();
	detector2.restore(restored);
	const descent = feed(detector2, descend(120000, 2100, 2, 20, { speed: 8 }));
	save(relaunched, descent);

	const end = ends(descent)[0];
	assert.ok(end);
	assert.equal(end.lift.startLat, 47.1);
	assert.equal(end.lift.peakLat, 47.1);
	assert.deepEqual(relaunched.getOutbox()[0].pts, [47100000, -121200000, 47100000, -121200000]);
	assert.equal(relaunched.getToday().lifts[0].pts, undefined);
});

test("active lift state survives a reload but not pause, end day, or a new day", () => {
	const storage = memoryStorage();
	let clock = new Date(2026, 10, 22, 12, 0).getTime();
	const store = createDayStore({ storage, now: () => clock }).load();

	store.setActiveLift([0, 2000, 300000, 2600]);
	assert.deepEqual(store.getToday().active, [0, 2000, 300000, 2600]);
	store.setPaused(true);
	assert.equal(store.getToday().active, null);
	store.setPaused(false);

	store.setActiveLift([0, 2000, 300000, 2600]);
	store.endDay();
	assert.equal(store.getToday().active, null);

	store.resumeDay();
	store.setActiveLift([0, 2000, 300000, 2600]);
	clock = new Date(2026, 10, 23, 8, 0).getTime();
	const nextDay = createDayStore({ storage, now: () => clock }).load();
	assert.equal(nextDay.getToday().active, null);
});
