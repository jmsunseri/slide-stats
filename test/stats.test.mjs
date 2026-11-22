import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as Core from "../src/embeddedjs/lib/core.js";

const require = createRequire(import.meta.url);
const stats = require("../src/pkjs/lib/stats.js");

const SETTINGS = {
	units: "metric",
	seasonMode: "north",
	trips: true,
	detection: {},
};

function at(month, day, hour = 9, minute = 0) {
	return new Date(2026, month - 1, day, hour, minute).getTime();
}

function lift(seq, month, day, hour, gain, durationMinutes = 5) {
	const start = at(month, day, hour);
	const end = start + durationMinutes * 60000;
	return { seq, startTime: start, endTime: end, gain };
}

const LIFTS = {
	"2026-03-14": [lift(1, 3, 14, 9, 400), lift(2, 3, 14, 10, 520)],
	"2026-03-12": [lift(1, 3, 12, 9, 600)],
	"2026-03-10": [lift(1, 3, 10, 9, 300)],
	"2026-03-01": [lift(1, 3, 1, 9, 200)],
};

test("aggregateLifts builds day totals and ignores empty or bad lifts", () => {
	const days = stats.aggregateLifts({
		"2026-03-14": [lift(1, 3, 14, 9, 400), lift(2, 3, 14, 10, 520), { seq: 3, gain: 0 }],
		"2026-03-13": [],
		"2026-03-12": [{ seq: 1, startTime: at(3, 12, 9), endTime: at(3, 12, 9, 5), gain: -5 }],
	});
	assert.equal(days["2026-03-14"].v, 920);
	assert.equal(days["2026-03-14"].r, 2);
	assert.equal(days["2026-03-14"].longest, 520);
	assert.equal(days["2026-03-14"].first, at(3, 14, 9));
	assert.equal(days["2026-03-14"].last, at(3, 14, 10, 5));
	assert.equal(days["2026-03-13"], undefined);
	assert.equal(days["2026-03-12"], undefined);
});

test("aggregateLifts dedupes by uid but keeps watches with the same seq", () => {
	const days = stats.aggregateLifts({
		"2026-03-14": [
			{ seq: 1, uid: "2026-03-14:1:a", gain: 400, startTime: at(3, 14, 9), endTime: at(3, 14, 9, 5) },
			{ seq: 1, uid: "2026-03-14:1:b", gain: 500, startTime: at(3, 14, 10), endTime: at(3, 14, 10, 5) },
			{ seq: 1, uid: "2026-03-14:1:a", gain: 400, startTime: at(3, 14, 9), endTime: at(3, 14, 9, 5) },
		],
	});
	assert.equal(days["2026-03-14"].v, 900);
	assert.equal(days["2026-03-14"].r, 2);
});

test("aggregateLifts dedupes legacy records with the same seq", () => {
	const days = stats.aggregateLifts({
		"2026-03-14": [
			{ seq: 2, gain: 400, startTime: at(3, 14, 9), endTime: at(3, 14, 9, 5) },
			{ seq: 2, gain: 400, startTime: at(3, 14, 9), endTime: at(3, 14, 9, 5) },
		],
	});
	assert.equal(days["2026-03-14"].r, 1);
});

test("summarize reports today, the season, trips, days, and all time", () => {
	const summary = stats.summarize(LIFTS, SETTINGS, new Date(2026, 2, 14, 12, 0));
	assert.equal(summary.today.v, 920);
	assert.equal(summary.today.r, 2);
	assert.equal(summary.today.average, 460);
	assert.equal(summary.today.longest, 520);

	assert.equal(summary.season.label, "2025-26");
	assert.equal(summary.season.daysCount, 4);
	assert.equal(summary.season.vertical, 2020);
	assert.equal(summary.season.runs, 5);
	assert.equal(summary.season.averageVertical, 505);
	assert.equal(summary.season.bestDay.date, "2026-03-14");
	assert.equal(summary.season.trips.length, 2);
	assert.deepEqual(summary.days.map(day => day.date),
		["2026-03-14", "2026-03-12", "2026-03-10", "2026-03-01"]);

	assert.equal(summary.allTime.vertical, 2020);
	assert.equal(summary.allTime.daysCount, 4);
});

test("season keys match the watch for northern and southern", () => {
	const settingsList = [
		{ seasonMode: "north" },
		{ seasonMode: "south" },
	];
	const dates = ["2025-08-31", "2025-09-01", "2026-02-28", "2026-03-01", "2026-06-30", "2026-07-01"];
	for (const settings of settingsList) {
		for (const date of dates)
			assert.equal(stats.seasonKey(date, settings), Core.seasonKey(date, settings),
				JSON.stringify(settings) + " " + date);
	}
});

test("day summary includes adjacent keys and unsigned totals", () => {
	const day = stats.daySummary(LIFTS, "2026-03-14");
	assert.equal(day.vertical, 920);
	assert.equal(day.runs, 2);
	assert.equal(day.longest, 520);
	assert.equal(day.average, 460);
	assert.equal(day.older, "2026-03-12");
	assert.equal(day.newer, null);

	const middle = stats.daySummary(LIFTS, "2026-03-11");
	assert.equal(middle.vertical, 0);
	assert.equal(middle.runs, 0);
	assert.equal(middle.older, "2026-03-10");
	assert.equal(middle.newer, "2026-03-12");
});

test("seasonKeysFor includes every stored season, newest first", () => {
	const lifts = Object.assign({}, LIFTS, {
		"2025-08-01": [lift(1, 8, 1, 9, 900)],
	});
	assert.deepEqual(
		stats.seasonKeysFor(lifts, SETTINGS, new Date(2026, 2, 14)),
		["2025", "2024"]
	);
	// The current season is included even before it has a lift.
	assert.deepEqual(
		stats.seasonKeysFor({}, SETTINGS, new Date(2026, 2, 14)),
		["2025"]
	);
});

test("season summary returns adjacent season keys", () => {
	const lifts = Object.assign({}, LIFTS, {
		"2025-08-01": [lift(1, 8, 1, 9, 900)],
	});
	const current = stats.seasonSummary(lifts, SETTINGS, "2025", new Date(2026, 2, 14));
	assert.equal(current.vertical, 2020);
	assert.equal(current.older, "2024");
	assert.equal(current.newer, null);

	const previous = stats.seasonSummary(lifts, SETTINGS, "2024", new Date(2026, 2, 14));
	assert.equal(previous.vertical, 900);
	assert.equal(previous.older, null);
	assert.equal(previous.newer, "2025");
});

test("a day with no lifts does not appear in the season", () => {
	const summary = stats.summarize({}, SETTINGS, new Date(2026, 2, 14));
	assert.equal(summary.season.daysCount, 0);
	assert.equal(summary.season.vertical, 0);
	assert.equal(summary.today.r, 0);
	assert.equal(summary.days.length, 0);
});
