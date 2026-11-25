import test from "node:test";
import assert from "node:assert/strict";
import {
	createDayStore,
	STATE_KEY,
} from "../src/embeddedjs/lib/core.js";

function memoryStorage() {
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

function lift(index) {
	const start = index * 600000;
	return {
		startTime: start,
		endTime: start + 300000,
		startAltitude: 2000,
		peakAltitude: 2400,
		gain: 400,
		durationMs: 300000,
		startLat: 47.1 + index * 0.001,
		startLon: -121.2,
		peakLat: 47.2 + index * 0.001,
		peakLon: -121.1,
	};
}

test("narrow accessors avoid whole-day and whole-outbox clones", t => {
	const store = createDayStore({
		storage: memoryStorage(),
		now: () => new Date(2026, 2, 14, 9, 0).getTime(),
	}).load();

	for (let i = 0; i < 30; i++)
		store.addLift(lift(i));
	store.setActiveLift([0, 2000, 300000, 2600]);

	const dayBytes = JSON.stringify(store.getToday()).length;
	const activeBytes = JSON.stringify(store.getActiveLift()).length;
	const outboxBytes = JSON.stringify(store.getOutbox()).length;
	const headBytes = JSON.stringify(store.peekOutbox()).length;

	t.diagnostic(`day clone: ${dayBytes} B`);
	t.diagnostic(`active snapshot: ${activeBytes} B`);
	t.diagnostic(`outbox clone: ${outboxBytes} B`);
	t.diagnostic(`outbox head: ${headBytes} B`);

	assert.ok(activeBytes * 10 < dayBytes, "active snapshot should be much smaller than the day clone");
	assert.ok(headBytes * 5 < outboxBytes, "outbox head should be much smaller than the outbox clone");
});

test("active saves are throttled instead of rewriting state for every sample", t => {
	let now = new Date(2026, 2, 14, 9, 0).getTime();
	const storage = memoryStorage();
	const store = createDayStore({ storage, now: () => now }).load();

	for (let i = 0; i < 30; i++)
		store.addLift(lift(i));

	const lastStateWrite = storage.writes
		.filter(write => write.key === STATE_KEY)
		.at(-1);
	storage.writes.length = 0;

	store.setActiveLift([0, 2000, 300000, 2600]);
	const firstSaveBytes = storage.writes[0].bytes;

	now += 10000;
	store.setActiveLift([0, 2000, 360000, 2800]);
	const afterSuppressed = storage.writes.length;

	now += 20000;
	store.setActiveLift([0, 2000, 420000, 3000]);
	const afterInterval = storage.writes.length;

	t.diagnostic(`state write after completed lift: ${lastStateWrite.bytes} B`);
	t.diagnostic(`first active checkpoint: ${firstSaveBytes} B`);
	t.diagnostic(`writes at t0: 1, at t+10s: ${afterSuppressed}, at t+30s: ${afterInterval}`);

	assert.equal(afterSuppressed, 1, "a sample inside the 30s window should not write");
	assert.equal(afterInterval, 2, "the next checkpoint should write");
	assert.ok(firstSaveBytes > 1000, "the checkpoint is a full-state write, not a tiny record");
	assert.deepEqual(storage.writes.map(write => write.key), [STATE_KEY, STATE_KEY]);
});
