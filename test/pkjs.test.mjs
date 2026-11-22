import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/*
 * Load index.js with the tiny Pebble runtime it expects. The proxy stub keeps
 * the Moddable control channel out of the way so the test exercises the plain
 * Sync/Query messages the watch actually sends.
 */
function loadPkjs() {
	const storage = new Map();
	const handlers = {};
	const sent = [];

	globalThis.localStorage = {
		getItem: key => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => storage.set(key, String(value)),
		removeItem: key => storage.delete(key),
	};
	globalThis.Pebble = {
		addEventListener: (name, callback) => {
			handlers[name] = callback;
		},
		sendAppMessage: (message, success) => {
			sent.push(message);
			if (success)
				success();
		},
		openURL: () => {},
	};

	const Module = require("node:module");
	const load = Module._load;
	Module._load = function (request) {
		if (request === "@moddable/pebbleproxy")
			return { readyReceived() {}, appMessageReceived() { return false; } };
		return load.apply(this, arguments);
	};
	const path = require.resolve("../src/pkjs/index.js");
	delete require.cache[path];
	require(path);
	Module._load = load;

	return { handlers, sent, storage };
}

function send(handlers, payload) {
	handlers.appmessage({ payload });
}

function lift(overrides) {
	return Object.assign({
		kind: "lift",
		id: "2026-03-14:1:abc",
		date: "2026-03-14",
		seq: 1,
		uid: "2026-03-14:1:abc",
		startTime: new Date(2026, 2, 14, 9, 0).getTime(),
		endTime: new Date(2026, 2, 14, 9, 5).getTime(),
		startAltitude: 2000,
		peakAltitude: 2400,
		gain: 400,
		durationMs: 300000,
		incomplete: false,
	}, overrides);
}

test("sync stores a lift, acks it, and dedupes by uid", () => {
	const { handlers, sent, storage } = loadPkjs();
	handlers.ready({});

	const record = lift({});
	send(handlers, { Sync: JSON.stringify(record) });
	assert.equal(sent.at(-1).Ack, JSON.stringify({ id: record.id }));

	// A retry with the same uid must replace the stored lift, not add a run.
	send(handlers, { Sync: JSON.stringify(lift({ gain: 450 })) });
	const stored = JSON.parse(storage.get("ss.lifts"));
	assert.equal(stored["2026-03-14"].length, 1);
	assert.equal(stored["2026-03-14"][0].gain, 450);
});

test("delete removes the matching uid", () => {
	const { handlers, storage } = loadPkjs();
	handlers.ready({});
	send(handlers, { Sync: JSON.stringify(lift({})) });
	send(handlers, {
		Sync: JSON.stringify({
			kind: "lift-delete",
			id: "2026-03-14:1:abc",
			date: "2026-03-14",
			uid: "2026-03-14:1:abc",
		}),
	});
	const stored = JSON.parse(storage.get("ss.lifts"));
	assert.equal(stored["2026-03-14"], undefined);
});

test("day query returns totals and adjacent keys", () => {
	const { handlers, sent } = loadPkjs();
	handlers.ready({});
	send(handlers, { Sync: JSON.stringify(lift({})) });
	send(handlers, {
		Sync: JSON.stringify(lift({
			id: "2026-03-12:1:def",
			date: "2026-03-12",
			seq: 1,
			uid: "2026-03-12:1:def",
			startTime: new Date(2026, 2, 12, 9, 0).getTime(),
			endTime: new Date(2026, 2, 12, 9, 5).getTime(),
			gain: 600,
		})),
	});

	send(handlers, { Query: JSON.stringify({ v: 1, kind: "day", key: "2026-03-14" }) });
	const newest = JSON.parse(sent.at(-1).Data);
	assert.equal(newest.kind, "day");
	assert.equal(newest.summary.vertical, 400);
	assert.equal(newest.summary.runs, 1);
	assert.equal(newest.summary.older, "2026-03-12");
	assert.equal(newest.summary.newer, null);

	send(handlers, { Query: JSON.stringify({ v: 1, kind: "day", key: "2026-03-12" }) });
	const older = JSON.parse(sent.at(-1).Data);
	assert.equal(older.summary.vertical, 600);
	assert.equal(older.summary.older, null);
	assert.equal(older.summary.newer, "2026-03-14");
});

test("settings round-trip through the phone", () => {
	const { handlers, sent, storage } = loadPkjs();
	handlers.ready({});
	send(handlers, { Settings: JSON.stringify({
		units: "imperial",
		seasonMode: "south",
		theme: { background: 0x0055aa, accent: 0xffaa00, text: 0xffffff },
	}) });
	assert.deepEqual(JSON.parse(storage.get("ss.settings")), {
		units: "imperial",
		seasonMode: "south",
		theme: { background: 0x0055aa, accent: 0xffaa00, text: 0xffffff },
	});

	// A later ready should push the stored settings back to the watch.
	handlers.ready({});
	const restored = sent
		.filter(message => message.Settings)
		.map(message => JSON.parse(message.Settings))
		.find(settings => settings.units === "imperial");
	assert.equal(restored.units, "imperial");
});
