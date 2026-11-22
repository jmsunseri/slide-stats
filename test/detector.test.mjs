import test from "node:test";
import assert from "node:assert/strict";
import { createLiftDetector } from "../src/embeddedjs/lib/core.js";

const DT = 10000;

function sample(t, altitude, extra = {}) {
	return Object.assign({ t, altitude, altitudeAccuracy: 5, speed: 0 }, extra);
}

function feed(detector, samples) {
	const events = [];
	for (const item of samples)
		events.push(...detector.addSample(item));
	return events;
}

function climb(startTime, startAltitude, rate, seconds, extra = {}) {
	const result = [];
	for (let elapsed = 0; elapsed <= seconds; elapsed += DT / 1000) {
		result.push(sample(startTime + elapsed * 1000, startAltitude + rate * elapsed, extra));
	}
	return result;
}

function flat(startTime, altitude, seconds, extra = {}) {
	const result = [];
	for (let elapsed = 0; elapsed < seconds; elapsed += DT / 1000)
		result.push(sample(startTime + elapsed * 1000, altitude, extra));
	return result;
}

function descend(startTime, altitude, rate, seconds, extra = {}) {
	const result = [];
	for (let elapsed = 0; elapsed <= seconds; elapsed += DT / 1000) {
		result.push(sample(startTime + elapsed * 1000, altitude - rate * elapsed, extra));
	}
	return result;
}

function starts(events) {
	return events.filter(event => event.type === "start");
}

function ends(events) {
	return events.filter(event => event.type === "end");
}

test("fast chair is detected within one sample and ends on descent", () => {
	const detector = createLiftDetector();
	const samples = [
		...climb(0, 2000, 2, 300, { speed: 4 }),
		...flat(310000, 2600, 60, { speed: 0 }),
		...descend(380000, 2580, 2, 30, { speed: 8 }),
	];
	const events = feed(detector, samples);
	const start = starts(events)[0];
	const end = ends(events)[0];

	assert.ok(start, "expected a start event");
	assert.equal(start.lift.startTime, 0);
	assert.equal(start.lift.startAltitude, 2000);
	assert.equal(start.lift.gain, 20);

	assert.ok(end, "expected an end event");
	assert.equal(end.lift.peakAltitude, 2600);
	assert.equal(end.lift.gain, 600);
	assert.equal(end.lift.startTime, 0);
	assert.equal(end.lift.endTime, 300000);
	assert.equal(end.lift.durationMs, 300000);
});

test("slow bunny lift is caught by the 90 s tier", () => {
	const detector = createLiftDetector();
	const samples = [
		...climb(0, 2000, 0.2, 120, { speed: 0.5 }),
		...flat(130000, 2024, 30, { speed: 0 }),
		...descend(170000, 2022, 1, 20, { speed: 2 }),
	];
	const events = feed(detector, samples);
	const start = starts(events)[0];
	const end = ends(events)[0];

	assert.ok(start, "expected a start event");
	assert.equal(start.lift.startTime, 0);
	assert.equal(start.lift.startAltitude, 2000);
	assert.ok(end, "expected an end event");
	assert.equal(end.lift.gain, 24);
});

test("magic carpet at 0.15 m/s still confirms", () => {
	const detector = createLiftDetector();
	const samples = [
		...climb(0, 2000, 0.15, 120, { speed: 0.4 }),
		...descend(130000, 2018, 1, 20, { speed: 1.5 }),
	];
	const events = feed(detector, samples);
	const start = starts(events)[0];
	assert.ok(start, "expected a start event");
	assert.equal(start.lift.startTime, 0);
});

test("a long mid-lift stop stays one lift", () => {
	const detector = createLiftDetector();
	const samples = [
		...climb(0, 2000, 2, 50, { speed: 4 }),
		...flat(60000, 2100, 300, { speed: 0 }),
		...climb(370000, 2100, 2, 50, { speed: 4 }),
		...descend(430000, 2200, 2, 30, { speed: 8 }),
	];
	const events = feed(detector, samples);
	assert.equal(starts(events).length, 1);
	assert.equal(ends(events).length, 1);
	assert.equal(ends(events)[0].lift.gain, 200);
});

test("skiing down 5 m ends the lift and the next climb is a second lift", () => {
	const detector = createLiftDetector();
	const samples = [
		...climb(0, 2000, 2, 50, { speed: 4 }),
		...descend(60000, 2100, 2, 10, { speed: 6 }),
		...flat(80000, 2080, 120, { speed: 0 }),
		...climb(210000, 2080, 2, 50, { speed: 4 }),
		...descend(270000, 2180, 2, 10, { speed: 6 }),
		...flat(290000, 2160, 20, { speed: 0 }),
	];
	const events = feed(detector, samples);
	assert.equal(starts(events).length, 2);
	assert.equal(ends(events).length, 2);
	assert.equal(ends(events)[0].lift.gain, 100);
	assert.equal(ends(events)[1].lift.gain, 100);
});

test("no descent between lifts merges them, as accepted", () => {
	const detector = createLiftDetector();
	const samples = [
		...climb(0, 2000, 2, 50, { speed: 4 }),
		...flat(60000, 2100, 120, { speed: 0 }),
		...climb(190000, 2100, 2, 50, { speed: 4 }),
		...descend(250000, 2200, 2, 20, { speed: 6 }),
	];
	const events = feed(detector, samples);
	assert.equal(starts(events).length, 1);
	assert.equal(ends(events).length, 1);
	assert.equal(ends(events)[0].lift.gain, 200);
});

test("a car climbing a hill is ignored", () => {
	const detector = createLiftDetector();
	const samples = [
		...climb(0, 1000, 5, 120, { speed: 15 }),
		...flat(130000, 1600, 60, { speed: 0 }),
	];
	const events = feed(detector, samples);
	assert.equal(starts(events).length, 0);
});

test("noise around a fixed altitude does not start a lift", () => {
	const detector = createLiftDetector();
	const samples = [];
	const pattern = [0, 4, -4, 3, -3, 2, -2, 1, -1];
	for (let i = 0; i < 60; i++) {
		const t = i * DT;
		samples.push(sample(t, 2000 + pattern[i % pattern.length], { speed: 0 }));
	}
	const events = feed(detector, samples);
	assert.equal(starts(events).length, 0);
});

test("missing altitude is ignored", () => {
	const detector = createLiftDetector();
	const events = feed(detector, [
		{ t: 0, altitude: undefined },
		{ t: 10000, altitude: null },
		{ t: 20000 },
	]);
	assert.deepEqual(events, []);
});

test("poor altitude accuracy is ignored", () => {
	const detector = createLiftDetector();
	const events = feed(detector, [
		...climb(0, 2000, 2, 60, { altitudeAccuracy: 80, speed: 4 }),
	]);
	assert.equal(starts(events).length, 0);
});

test("the climb start is the local bottom, not the previous ridge", () => {
	const detector = createLiftDetector();
	const samples = [
		...flat(0, 2000, 60, { speed: 0 }),
		...descend(70000, 2000, 1, 30, { speed: 6 }),
		...flat(110000, 1970, 40, { speed: 0 }),
		...climb(150000, 1970, 2, 100, { speed: 4 }),
		...descend(260000, 2170, 2, 20, { speed: 6 }),
	];
	const events = feed(detector, samples);
	const start = starts(events)[0];
	const end = ends(events)[0];
	assert.ok(start);
	assert.equal(start.lift.startAltitude, 1970);
	assert.ok(end);
	assert.equal(end.lift.gain, 200);
});

test("a lift below the minimum gain is discarded", () => {
	const detector = createLiftDetector({ minLiftGainM: 30 });
	const samples = [
		...climb(0, 2000, 2, 10, { speed: 4 }),
		...descend(20000, 2020, 2, 10, { speed: 6 }),
		...flat(40000, 2000, 10, { speed: 0 }),
	];
	const events = feed(detector, samples);
	assert.equal(ends(events).length, 0);
	assert.equal(events.filter(event => event.type === "discard").length, 1);
});

test("a long sample gap finalises the ride at its last peak", () => {
	const detector = createLiftDetector();
	const samples = [
		...climb(0, 2000, 2, 50, { speed: 4 }),
		sample(400000, 2100, { speed: 0 }),
	];
	const events = feed(detector, samples);
	const end = ends(events)[0];
	assert.ok(end);
	assert.equal(end.lift.gain, 100);
	assert.equal(end.lift.incomplete, true);
});

test("a single altitude spike does not trigger through the median filter", () => {
	const detector = createLiftDetector();
	const samples = [
		...flat(0, 2000, 30, { speed: 0 }),
		sample(40000, 2030, { speed: 0 }),
		...flat(50000, 2000, 30, { speed: 0 }),
	];
	const events = feed(detector, samples);
	assert.equal(starts(events).length, 0);
});

test("reset clears an in-progress lift", () => {
	const detector = createLiftDetector();
	feed(detector, climb(0, 2000, 2, 60, { speed: 4 }));
	detector.reset();
	const events = feed(detector, climb(120000, 2000, 2, 60, { speed: 4 }));
	assert.equal(starts(events).length, 1);
});
test("out-of-order and duplicate samples are ignored", () => {
	const detector = createLiftDetector();
	const samples = climb(0, 2000, 2, 30, { speed: 4 });
	const events = feed(detector, samples);
	const count = starts(events).length;
	const duplicate = feed(detector, samples);
	assert.equal(duplicate.length, 0);
	assert.equal(starts(events).length, count);
});
