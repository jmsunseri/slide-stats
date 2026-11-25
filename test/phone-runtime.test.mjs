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
	let saved = null;
	const runtime = createPhoneRuntime({
		storage,
		loadSettings: () => Object.assign({}, DEFAULT_SETTINGS, { sampleIntervalMs: 1000 }),
		saveSettings: settings => { saved = settings; },
		onState: state => states.push(state),
		onEvent: event => events.push(event),
		geolocation: null,
		now: () => clock.value,
		setInterval: () => 1,
		clearInterval: () => {},
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

test("phone runtime applies commands and pushes updated state", () => {
	const storage = memoryStorage();
	let now = new Date(2026, 2, 14, 9, 0).getTime();
	const states = [];
	let saved = null;
	const runtime = createPhoneRuntime({
		storage,
		loadSettings: () => DEFAULT_SETTINGS,
		saveSettings: settings => { saved = settings; },
		onState: state => states.push(state),
		onEvent: () => {},
		geolocation: null,
		now: () => now,
		setInterval: () => 1,
		clearInterval: () => {},
	});

	runtime.handleCommand({ type: "units", value: "imperial" });
	assert.equal(states[states.length - 1].settings.units, "imperial");
	assert.equal(saved.units, "imperial");

	runtime.handleCommand({ type: "pause", value: true });
	assert.equal(states[states.length - 1].settings.paused, true);
	assert.equal(saved.paused, true);

	runtime.handleCommand({ type: "pause", value: false });
	runtime.handleCommand({ type: "day", value: true });
	assert.equal(states[states.length - 1].settings.closed, true);
	runtime.handleCommand({ type: "day", value: false });
	assert.equal(states[states.length - 1].settings.closed, false);

	runtime.handleCommand({ type: "refresh" });
	assert.ok(states.length >= 5);
});

test("phone runtime sends an initial state and rolls the day over", () => {
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

	runtime.start();
	assert.equal(states.length, 1);
	assert.equal(states[0].today.date, "2026-03-14");
	assert.equal(states[0].status.gps, false);

	runtime.handleCommand({ type: "day", value: true });
	assert.equal(states.at(-1).settings.closed, true);
	assert.equal(saved.closedDate, "2026-03-14");

	clock.value = new Date(2026, 2, 15, 9, 0).getTime();
	runtime.sendState();
	assert.equal(states.at(-1).today.date, "2026-03-15");
	assert.equal(states.at(-1).settings.closed, false);
	assert.equal(saved.closed, false);
});

test("a new day resumes tracking after an ended day", () => {
	const storage = memoryStorage();
	const clock = { value: new Date(2026, 2, 14, 9, 0).getTime() };
	let watches = 0;
	let cleared = 0;
	const geolocation = {
		watchPosition: () => ++watches,
		clearWatch: () => { cleared++; },
	};
	const runtime = createPhoneRuntime({
		storage,
		loadSettings: () => DEFAULT_SETTINGS,
		onState: () => {},
		onEvent: () => {},
		geolocation,
		now: () => clock.value,
	});

	runtime.start();
	assert.equal(watches, 1);
	runtime.handleCommand({ type: "day", value: true });
	assert.equal(cleared, 1);

	clock.value = new Date(2026, 2, 15, 9, 0).getTime();
	runtime.sendState();
	assert.equal(watches, 2);
});

test("a settings update does not reopen a closed day", () => {
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
	runtime.handleCommand({ type: "day", value: true });
	assert.equal(states.at(-1).settings.closed, true);

	runtime.applySettings({ units: "imperial" });
	assert.equal(states.at(-1).settings.units, "imperial");
	assert.equal(states.at(-1).settings.closed, true);
});

test("phone runtime clears a stale closed day when it starts", () => {
	const storage = memoryStorage();
	const clock = { value: new Date(2026, 2, 15, 9, 0).getTime() };
	const states = [];
	let saved = null;
	const runtime = createPhoneRuntime({
		storage,
		loadSettings: () => Object.assign({}, DEFAULT_SETTINGS, {
			closed: true,
			closedDate: "2026-03-14",
		}),
		saveSettings: settings => { saved = settings; },
		onState: state => states.push(state),
		onEvent: () => {},
		geolocation: null,
		now: () => clock.value,
	});

	runtime.start();
	assert.equal(saved.closed, false);
	assert.equal(saved.closedDate, null);
	assert.equal(states.at(-1).settings.closed, false);
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
