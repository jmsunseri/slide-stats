import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPhoneRuntime } = require("../src/pkjs/lib/phone-runtime.js");
const { DEFAULT_SETTINGS } = require("../src/pkjs/lib/settings.js");

function memoryStorage() {
	const map = new Map();
	return {
		map,
		getItem: key => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, value),
		removeItem: key => map.delete(key),
	};
}

function feed(runtime, clock, altitude) {
	runtime.handlePosition({
		coords: {
			latitude: 47.1,
			longitude: -121.2,
			altitude,
			altitudeAccuracy: undefined,
			accuracy: 10,
		},
	});
	clock.value += 1000;
}

test("phone runtime records a synthetic lift and emits watch state", () => {
	const storage = memoryStorage();
	const clock = { value: new Date(2026, 2, 14, 9, 0).getTime() };
	const states = [];
	const events = [];
	const runtime = createPhoneRuntime({
		storage,
		loadSettings: () => Object.assign({}, DEFAULT_SETTINGS, { sampleIntervalMs: 1000 }),
		onState: state => states.push(state),
		onEvent: event => events.push(event),
		geolocation: null,
		now: () => clock.value,
	});

	for (let second = 0; second <= 30; second++)
		feed(runtime, clock, 2000 + second);
	clock.value += 1000;
	for (let second = 0; second <= 6; second++)
		feed(runtime, clock, 2030 - second * 2);

	assert.deepEqual(events.map(event => event.type), ["start", "end"]);
	const state = states[states.length - 1];
	assert.equal(state.today.runs, 1);
	assert.equal(state.today.vertical, 30);
	assert.equal(state.season.runs, 1);
	assert.equal(state.status.gps, true);
	assert.equal(runtime.getStore().getLifts()["2026-03-14"].length, 1);
});

test("phone runtime applies settings commands and pushes updated state", () => {
	const storage = memoryStorage();
	const clock = { value: new Date(2026, 2, 14, 9, 0).getTime() };
	const states = [];
	let saved = null;
	const runtime = createPhoneRuntime({
		storage,
		loadSettings: () => DEFAULT_SETTINGS,
		saveSettings: settings => { saved = settings; },
		onState: state => states.push(state),
		onEvent: () => {},
		geolocation: null,
		now: () => clock.value,
	});

	runtime.handleCommand({ type: "units", value: "imperial" });
	assert.equal(states.at(-1).settings.units, "imperial");
	assert.equal(saved.units, "imperial");

	runtime.handleCommand({ type: "vibration", value: false });
	assert.equal(states.at(-1).settings.vibration, false);
	assert.equal(saved.vibration, false);

	runtime.handleCommand({ type: "refresh" });
	assert.ok(states.length >= 3);
});

test("phone runtime sends an initial state and rolls the day over", () => {
	const storage = memoryStorage();
	const clock = { value: new Date(2026, 2, 14, 9, 0).getTime() };
	const states = [];
	const runtime = createPhoneRuntime({
		storage,
		loadSettings: () => DEFAULT_SETTINGS,
		onState: state => states.push(state),
		onEvent: () => {},
		geolocation: null,
		now: () => clock.value,
	});

	runtime.start();
	assert.equal(states.length, 1);
	assert.equal(states[0].today.date, "2026-03-14");
	assert.equal(states[0].status.gps, false);

	clock.value = new Date(2026, 2, 15, 9, 0).getTime();
	runtime.sendState();
	assert.equal(states.at(-1).today.date, "2026-03-15");
	assert.equal(states.at(-1).today.runs, 0);
});

test("a day rollover clears an in-progress lift", () => {
	const storage = memoryStorage();
	const clock = { value: new Date(2026, 2, 14, 23, 58).getTime() };
	const states = [];
	const runtime = createPhoneRuntime({
		storage,
		loadSettings: () => Object.assign({}, DEFAULT_SETTINGS, { sampleIntervalMs: 1000 }),
		onState: state => states.push(state),
		onEvent: () => {},
		geolocation: null,
		now: () => clock.value,
	});

	for (let second = 0; second < 20; second++)
		feed(runtime, clock, 2000 + second);
	assert.ok(states.length > 0);

	clock.value = new Date(2026, 2, 15, 0, 1).getTime();
	runtime.sendState();
	assert.equal(states.at(-1).today.date, "2026-03-15");
	assert.equal(states.at(-1).today.runs, 0);
	assert.equal(runtime.getStore().getLifts()["2026-03-14"], undefined);
});

test("phone runtime undo removes the newest lift for today", () => {
	const storage = memoryStorage();
	const clock = { value: new Date(2026, 2, 14, 9, 0).getTime() };
	const states = [];
	const runtime = createPhoneRuntime({
		storage,
		loadSettings: () => Object.assign({}, DEFAULT_SETTINGS, { sampleIntervalMs: 1000 }),
		onState: state => states.push(state),
		onEvent: () => {},
		geolocation: null,
		now: () => clock.value,
	});

	for (let second = 0; second <= 30; second++)
		feed(runtime, clock, 2000 + second);
	clock.value += 1000;
	for (let second = 0; second <= 6; second++)
		feed(runtime, clock, 2030 - second * 2);
	assert.equal(states.at(-1).today.runs, 1);

	runtime.handleCommand({ type: "undo" });
	assert.equal(states.at(-1).today.runs, 0);
	assert.equal(runtime.getStore().getLifts()["2026-03-14"], undefined);
});
